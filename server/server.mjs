// ============================================================================
// server.mjs - 群英决 Node WebSocket 权威对战服务
// 移植自 Maker 版 server_main.lua（经端到端模拟验证的同一套状态机）：
// 队伍大厅 / 随机赐名与改名 / 选将裁决（英雄不重复）/ AI 补位 /
// 权威对局（复用 js/game 逻辑层，多队伍并行）/ 行动计时与断线托管
// 暗令只私发给本人客户端，从协议层杜绝透视。
// 启动：node server.mjs [port=8790]
// ============================================================================

import { WebSocketServer } from 'ws';
import { Engine } from '../js/game/engine.js';
import { HEROES, getHero } from '../js/game/heroes.js';
import { shuffle } from '../js/game/deck.js';
import * as Config from '../js/game/config.js';

const NAME_POOL = [
  '燕云骑', '白毦卫', '陷阵者', '虎贲郎', '玄甲卫', '锐士',
  '青州客', '丹阳侠', '飞军校尉', '大戟士', '越甲勇', '羽林郎',
  '赤霄剑客', '墨者', '纵横家', '游侠儿', '斥候', '轻车都尉',
];
const TEAM_NAME_POOL = ['虎贲营', '玄甲营', '飞羽营', '锐士营', '陷阵营', '青龙寨', '白虎堂', '朱雀坛'];
const MAX_TEAMS = 20;
const MAX_TEAM_MEMBERS = 3;
const PICK_TIME = 60;
const TICK_MS = 50;

export function startServer(port = 8790, { speed = 1 } = {}) {
  const wss = new WebSocketServer({ port });

  /** @type {Map<number, object>} clientId -> client */
  const clients = new Map();
  /** @type {Map<number, object>} teamId -> team */
  const teams = new Map();
  let nextClientId = 1;
  let nextTeamId = 1;
  let nameCounter = 0;

  // ---------------- 发送工具 ----------------

  const send = (client, obj) => {
    if (client && client.ws.readyState === 1) {
      client.ws.send(JSON.stringify(obj));
    }
  };
  const broadcastTeam = (team, obj) => {
    for (const id of team.members) send(clients.get(id), obj);
  };
  const toast = (client, msg) => send(client, { ev: 'toast', a: { msg } });

  function sendLobbyTo(client) {
    const list = [...teams.values()]
      .map((t) => ({ id: t.id, name: t.name, count: t.members.length, phase: t.phase }))
      .sort((a, b) => a.id - b.id);
    send(client, { ev: 'lobby', a: { teams: list, yourName: client.name } });
  }
  function broadcastLobby() {
    for (const c of clients.values()) {
      if (!c.teamId) sendLobbyTo(c);
    }
  }

  function sendTeamState(team) {
    for (const id of team.members) {
      const c = clients.get(id);
      if (!c) continue;
      const members = team.members
        .map((id2) => clients.get(id2))
        .filter(Boolean)
        .map((c2) => ({
          name: c2.name,
          isOwner: c2.id === team.ownerId,
          isYou: c2.id === id,
        }));
      send(c, {
        ev: 'team',
        a: {
          id: team.id, name: team.name, phase: team.phase,
          members, isOwner: id === team.ownerId,
          yourName: c.name, maxMembers: MAX_TEAM_MEMBERS,
        },
      });
    }
  }

  function sendPickState(team) {
    const allPicked = team.members.every((id) => team.picks[id]);
    for (const id of team.members) {
      const c = clients.get(id);
      if (!c) continue;
      const heroes = HEROES.map((hh) => {
        let takenBy = null;
        for (const id2 of team.members) {
          if (team.picks[id2] === hh.id) {
            const c2 = clients.get(id2);
            takenBy = c2 ? c2.name : '?';
          }
        }
        return { id: hh.id, takenBy, mine: team.picks[id] === hh.id };
      });
      send(c, {
        ev: 'pick',
        a: {
          heroes, allPicked,
          isOwner: id === team.ownerId,
          deadline: Math.max(0, Math.ceil(team.pickLeft || 0)),
        },
      });
    }
  }

  // ---------------- 对局：快照与事件转发 ----------------

  const cardJ = (c) => ({ r: c.rank, s: c.suit });

  function snapshot(game) {
    const e = game.engine;
    const players = [];
    for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
      const p = e.players[i];
      players.push({
        seat: i, hp: p.hp, energy: p.energy,
        alive: p.alive, folded: p.folded, allIn: p.allIn,
        betStreet: p.betStreet, betRound: p.betRound, skillUsed: p.skillUsed,
      });
    }
    const board = [];
    for (let i = 0; i < e.revealed; i++) board.push(cardJ(e.board[i]));
    return {
      round: e.round, pot: e.totalPot(), waitingIdx: e.waitingIdx,
      revealed: e.revealed, board, players,
    };
  }

  function sendToSeat(game, seat, obj) {
    const m = game.seatToClient.get(seat);
    if (m && clients.get(m.id) === m) send(m, obj);
  }

  function wireGame(team) {
    const game = team.game;
    const L = game.listeners;
    const e = game.engine;
    const fwd = (ev, a) => broadcastTeam(team, { ev, a, s: snapshot(game) });

    L.onLog = (text, kind) => fwd('onLog', { text, kind });
    L.onRoundStart = (round, blinds, dealerIdx) =>
      fwd('onRoundStart', { round, blinds, dealerIdx });
    L.onDeal = () => {
      for (const [seat] of game.seatToClient) {
        const hole = e.players[seat].hole;
        if (hole.length >= 2) {
          sendToSeat(game, seat, { ev: 'hole', a: { hole: [cardJ(hole[0]), cardJ(hole[1])] } });
        }
      }
      fwd('onDeal', {});
    };
    L.onBlindsPosted = (sbIdx, sbAmt, bbIdx, bbAmt) =>
      fwd('onBlindsPosted', { sbIdx, sbAmt, bbIdx, bbAmt });
    L.onTurnStart = (idx) => fwd('onTurnStart', { idx });
    L.onAwaitAction = (idx, opts) => {
      game.awaitSeat = idx;
      game.lastOpts = opts;
      const m = game.seatToClient.get(idx);
      if (m && clients.get(m.id) === m) {
        game.awaitLeft = Config.ACTION_TIME;
        sendToSeat(game, idx, {
          ev: 'onAwaitAction',
          a: { idx, opts, remain: Math.ceil(game.awaitLeft) },
          s: snapshot(game),
        });
      } else {
        game.awaitLeft = 1.0; // 断线托管：短暂延迟后自动行动
      }
    };
    L.onAction = (idx, key, amount) => {
      game.awaitSeat = null;
      fwd('onAction', { idx, key, amount });
    };
    L.onStreet = (street, revealTo) => fwd('onStreet', { street, revealTo });
    L.onHoleChange = (idx) => {
      const hole = e.players[idx].hole;
      sendToSeat(game, idx, { ev: 'hole', a: { hole: [cardJ(hole[0]), cardJ(hole[1])] } });
    };
    L.onSkill = (idx, skillName) => fwd('onSkill', { idx, skillName });
    L.onQuote = (idx, text) => fwd('onQuote', { idx, text });
    L.onPeek = (idx, card, slot) =>
      sendToSeat(game, idx, { ev: 'onPeek', a: { idx, card: cardJ(card), slot } });
    L.onSpy = (idx, targetIdx, cardIdx, card) =>
      sendToSeat(game, idx, { ev: 'onSpy', a: { idx, targetIdx, cardIdx, card: cardJ(card) } });
    L.onPotAwarded = (winners, amount, uncontested, bonus) =>
      fwd('onPotAwarded', { winners, amount, uncontested, bonus });
    L.onShowdown = (data) => {
      const entrants = data.entrants.map((p) => ({
        seat: p.idx,
        hole: [cardJ(p.hole[0]), cardJ(p.hole[1])],
        handName: p.showdownInfo.name,
        cat: p.showdownInfo.cat,
        score: p.showdownInfo.score,
        betRound: p.betRound,
      }));
      broadcastTeam(team, {
        ev: 'onShowdown',
        a: { entrants, won: data.wonAmount, totalPot: data.totalPot },
        s: snapshot(game),
      });
    };
    L.onDeath = (idx) => fwd('onDeath', { idx });
    L.onRoundEnd = (round) => fwd('onRoundEnd', { round });
    L.onGameOver = (ranking) => {
      for (const [seat, m] of game.seatToClient) {
        const arr = ranking.map((p) => ({
          heroId: p.hero.id,
          name: p.playerName || p.hero.name,
          hp: p.hp, alive: p.alive, deathRound: p.deathRound,
          seat: p.idx, isMe: p.idx === seat,
        }));
        send(m, { ev: 'onGameOver', a: { ranking: arr } });
      }
      team.phase = 'lobby';
      team.picks = {};
      team.game = null;
      sendTeamState(team);
      broadcastLobby();
    };
  }

  function startGame(team) {
    const humanSeats = new Set();
    const names = {};
    const heroIds = [];
    const seatToClient = new Map();
    const usedHero = new Set();

    team.members.forEach((id, i) => {
      const c = clients.get(id);
      const seat = i + 1;
      humanSeats.add(seat);
      names[seat] = c.name;
      heroIds[i] = team.picks[id];
      usedHero.add(heroIds[i]);
      c.seat = seat;
      seatToClient.set(seat, c);
    });
    const pool = shuffle(HEROES.filter((hh) => !usedHero.has(hh.id)).map((hh) => hh.id));
    for (let i = team.members.length; i < Config.PLAYER_COUNT; i++) {
      heroIds[i] = pool.pop();
      names[i + 1] = 'AI·' + (getHero(heroIds[i])?.name || '无名');
    }

    const listeners = {};
    const engine = new Engine(heroIds, listeners, humanSeats, names);
    team.game = { engine, listeners, seatToClient, awaitSeat: null, awaitLeft: 0, lastOpts: null };
    team.phase = 'playing';
    wireGame(team);

    const ps = [];
    for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
      ps.push({ seat: i, heroId: heroIds[i - 1], name: names[i], isHuman: humanSeats.has(i) });
    }
    for (const [seat, m] of seatToClient) {
      send(m, { ev: 'gameStart', a: { mySeat: seat, players: ps } });
    }
    console.log(`[Server] 队伍 ${team.name} 开局：${team.members.length} 真人 + ${Config.PLAYER_COUNT - team.members.length} AI`);
    engine.startGame();
    broadcastLobby();
  }

  function autoAct(game) {
    const e = game.engine;
    const seat = game.awaitSeat;
    if (!seat || e.waitingIdx !== seat) { game.awaitSeat = null; return; }
    game.awaitSeat = null;
    const opts = game.lastOpts || e.getOptions(e.players[seat]);
    e.playerAct(opts.canCheck ? { type: 'check' } : { type: 'fold' });
  }

  // ---------------- 队伍操作 ----------------

  function removeFromTeam(client, silent = false) {
    const team = client.teamId ? teams.get(client.teamId) : null;
    client.teamId = null;
    client.seat = null;
    if (!team) return;
    team.members = team.members.filter((id) => id !== client.id);
    delete team.picks[client.id];
    if (team.members.length === 0) {
      teams.delete(team.id);
    } else {
      if (team.ownerId === client.id) team.ownerId = team.members[0];
      if (!silent) {
        sendTeamState(team);
        if (team.phase === 'picking') sendPickState(team);
      }
    }
    broadcastLobby();
  }

  // ---------------- 客户端命令 ----------------

  function handleCmd(client, msg) {
    const cmd = msg.cmd;

    if (cmd === 'create') {
      if (client.teamId) return;
      if (teams.size >= MAX_TEAMS) return toast(client, '队伍数量已达上限，请加入现有队伍');
      const team = {
        id: nextTeamId,
        name: TEAM_NAME_POOL[Math.floor(Math.random() * TEAM_NAME_POOL.length)] + '·' + nextTeamId,
        ownerId: client.id,
        members: [client.id],
        phase: 'lobby',
        picks: {},
        game: null,
      };
      nextTeamId++;
      teams.set(team.id, team);
      client.teamId = team.id;
      sendTeamState(team);
      broadcastLobby();

    } else if (cmd === 'join') {
      if (client.teamId) return;
      const team = teams.get(msg.teamId);
      if (!team) return toast(client, '队伍不存在');
      if (team.phase !== 'lobby') return toast(client, '该队伍已开局');
      if (team.members.length >= MAX_TEAM_MEMBERS) return toast(client, '该队伍已满员');
      team.members.push(client.id);
      client.teamId = team.id;
      sendTeamState(team);
      broadcastLobby();

    } else if (cmd === 'leave') {
      removeFromTeam(client);
      sendLobbyTo(client);

    } else if (cmd === 'rename') {
      const name = String(msg.name || '').trim();
      const n = [...name].length;
      if (n < 1 || n > 8) return toast(client, '名字需为 1~8 个字符');
      client.name = name;
      const team = client.teamId ? teams.get(client.teamId) : null;
      if (team) {
        sendTeamState(team);
        if (team.phase === 'picking') sendPickState(team);
      }

    } else if (cmd === 'startPick') {
      const team = client.teamId ? teams.get(client.teamId) : null;
      if (!team || team.ownerId !== client.id || team.phase !== 'lobby') return;
      team.phase = 'picking';
      team.picks = {};
      team.pickLeft = PICK_TIME;
      sendTeamState(team);
      sendPickState(team);
      broadcastLobby();

    } else if (cmd === 'pick') {
      const team = client.teamId ? teams.get(client.teamId) : null;
      if (!team || team.phase !== 'picking') return;
      if (!getHero(msg.heroId)) return;
      for (const id2 of team.members) {
        if (id2 !== client.id && team.picks[id2] === msg.heroId) {
          return toast(client, '该英雄已被占用');
        }
      }
      team.picks[client.id] = msg.heroId;
      sendPickState(team);

    } else if (cmd === 'startGame') {
      const team = client.teamId ? teams.get(client.teamId) : null;
      if (!team || team.ownerId !== client.id || team.phase !== 'picking') return;
      for (const id of team.members) {
        if (!team.picks[id]) return toast(client, '还有队友未选定英雄');
      }
      startGame(team);

    } else if (cmd === 'act') {
      const team = client.teamId ? teams.get(client.teamId) : null;
      if (!team || !team.game) return;
      const e = team.game.engine;
      if (e.waitingIdx !== client.seat) return;
      const opts = team.game.lastOpts || e.getOptions(e.players[client.seat]);
      const act = { type: msg.type };
      if (act.type === 'raise') {
        act.tier = opts.tiers.find((t) => t.key === msg.tierKey);
        if (!act.tier) return;
      } else if (act.type === 'check') {
        if (!opts.canCheck) return;
      } else if (!['fold', 'call', 'allin'].includes(act.type)) {
        return;
      }
      team.game.awaitSeat = null;
      e.playerAct(act);

    } else if (cmd === 'skill') {
      const team = client.teamId ? teams.get(client.teamId) : null;
      if (!team || !team.game || !client.seat) return;
      const extra = (msg.cardIdx === 1 || msg.cardIdx === 2) ? { cardIdx: msg.cardIdx } : null;
      team.game.engine.useSkill(client.seat, extra);

    } else if (cmd === 'extend') {
      const team = client.teamId ? teams.get(client.teamId) : null;
      if (!team || !team.game || !client.seat) return;
      const game = team.game;
      if (game.awaitSeat !== client.seat) return;
      if (game.engine.extendTime(client.seat)) {
        game.awaitLeft += Config.EXTEND_TIME;
        sendToSeat(game, client.seat, {
          ev: 'onAwaitAction',
          a: { idx: client.seat, opts: game.lastOpts, remain: Math.ceil(game.awaitLeft) },
          s: snapshot(game),
        });
      }

    } else if (cmd === 'backToRoom') {
      const team = client.teamId ? teams.get(client.teamId) : null;
      if (team) sendTeamState(team);
      else sendLobbyTo(client);

    } else if (cmd === 'lobby') {
      sendLobbyTo(client);
    }
  }

  // ---------------- 连接生命周期 ----------------

  wss.on('connection', (ws) => {
    const client = {
      ws,
      id: nextClientId++,
      name: NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)] + '·' + (++nameCounter),
      teamId: null,
      seat: null,
    };
    clients.set(client.id, client);
    console.log(`[Server] 客户端接入 #${client.id} 赐名 ${client.name}`);
    sendLobbyTo(client);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || !msg.cmd) return;
      try {
        handleCmd(client, msg);
      } catch (err) {
        console.error(`[Server] 命令处理出错 cmd=${msg.cmd}`, err);
      }
    });

    ws.on('close', () => {
      console.log(`[Server] 客户端断开 #${client.id}`);
      const team = client.teamId ? teams.get(client.teamId) : null;
      if (team && team.phase === 'playing' && team.game) {
        // 对局中断线：座位保留并托管
        clients.delete(client.id);
        if (team.game.awaitSeat === client.seat) team.game.awaitLeft = 1.0;
        const anyOnline = team.members.some((id) => id !== client.id && clients.has(id));
        if (!anyOnline) {
          teams.delete(team.id);
          broadcastLobby();
        }
      } else {
        clients.delete(client.id);
        removeFromTeam(client);
      }
    });
  });

  // ---------------- 主循环 ----------------

  const timer = setInterval(() => {
    const dt = (TICK_MS / 1000) * speed; // speed>1 仅供测试加速
    for (const team of teams.values()) {
      // 选将倒计时：超时给未选者随机分配剩余英雄
      if (team.phase === 'picking' && team.pickLeft != null) {
        team.pickLeft -= dt;
        if (team.pickLeft <= 0) {
          team.pickLeft = null;
          const used = new Set(Object.values(team.picks));
          const pool = shuffle(HEROES.filter((hh) => !used.has(hh.id)).map((hh) => hh.id));
          for (const id of team.members) {
            if (!team.picks[id]) team.picks[id] = pool.pop();
          }
          sendPickState(team);
        }
      }
      // 对局推进与行动计时（engine.update 可能触发终局置空 team.game）
      const game = team.game;
      if (game) {
        game.engine.update(dt);
        if (team.game === game && game.awaitSeat) {
          game.awaitLeft -= dt;
          if (game.awaitLeft <= 0) autoAct(game);
        }
      }
    }
  }, TICK_MS);

  console.log(`[Server] 群英决对战服务已启动 ws://0.0.0.0:${port}`);
  return {
    wss,
    close() {
      clearInterval(timer);
      wss.close();
      for (const c of clients.values()) c.ws.close();
    },
  };
}

// 直接运行时启动
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const port = Number(process.argv[2]) || 8790;
  startServer(port);
}
