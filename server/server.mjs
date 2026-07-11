// ============================================================================
// server.mjs - 群英决 Node WebSocket 权威对战服务
// 移植自 Maker 版 server_main.lua（经端到端模拟验证的同一套状态机）：
// 队伍大厅 / 随机赐名与改名 / 选将裁决（英雄不重复）/ AI 补位 /
// 权威对局（复用 js/game 逻辑层，多队伍并行）/ 行动计时与断线托管
// 暗令只私发给本人客户端，从协议层杜绝透视。
// 启动：node server.mjs [port=8790]
// ============================================================================

import { WebSocketServer } from 'ws';
import { randomBytes, randomUUID } from 'node:crypto';
import { Engine } from '../js/game/engine.js';
import { HEROES, getHero } from '../js/game/heroes.js';
import { shuffle } from '../js/game/deck.js';
import * as Config from '../js/game/config.js';
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  ERROR_CODES,
  decodeClientMessage,
  errorEvent,
} from './protocol.mjs';
import { detachRoomMember } from './room.mjs';
import {
  DEFAULT_DATABASE_PATH,
  PlayerValidationError,
  createPlayerStore,
  guestFingerprint,
  normalizeNickname,
} from './player-store.mjs';

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
const SESSION_HANDSHAKE_MS = 25;

const emptyPokerHand = (round, playerId) => ({
  round,
  playerId,
  vpip: 0,
  pfr: 0,
  threeBet: 0,
  threeBetOpportunity: 0,
  postflopAggressiveActions: 0,
  postflopCallActions: 0,
  postflopFoldActions: 0,
  sawFlop: 0,
  showdown: 0,
  showdownWin: 0,
  cbet: 0,
  cbetOpportunity: 0,
  foldToCbet: 0,
  foldToCbetOpportunity: 0,
});

/**
 * Accumulates HUD counters from public betting events only. It intentionally
 * never receives hole cards or hand strength.
 */
export function createPokerHandTracker(seatToPlayerId) {
  const playerIds = new Map(seatToPlayerId || []);
  const hands = [];
  let current = null;

  const rowForSeat = (seat) => current?.rowsBySeat.get(seat) || null;

  return {
    onRoundStart(round, participantSeats) {
      const rowsBySeat = new Map();
      const seenPlayers = new Set();
      for (const seat of participantSeats || []) {
        const playerId = playerIds.get(seat);
        if (!playerId || seenPlayers.has(playerId)) continue;
        seenPlayers.add(playerId);
        const row = emptyPokerHand(round, playerId);
        rowsBySeat.set(seat, row);
        hands.push(row);
      }
      current = {
        round,
        rowsBySeat,
        preflopAggressorSeat: null,
        cbet: null,
      };
    },

    onAction(seat, key, amount, meta = {}) {
      if (!current || Number(meta.round) !== current.round) return;
      const street = meta.street;
      const type = meta.type || key;
      const aggressive = meta.isAggressive === true;
      const passiveCall = type === 'call' || (type === 'allin' && !aggressive);
      const row = rowForSeat(seat);

      if (street === 'preflop') {
        if (row) {
          if (aggressive) {
            row.vpip = 1;
            row.pfr = 1;
          } else if (passiveCall && Number(amount) > 0) {
            row.vpip = 1;
          }
          if (Number(meta.streetRaiseCountBefore) === 1) {
            row.threeBetOpportunity = 1;
            if (aggressive) row.threeBet = 1;
          }
        }
        if (aggressive) current.preflopAggressorSeat = seat;
        return;
      }

      if (!['flop', 'turn', 'river'].includes(street)) return;
      if (row) {
        if (aggressive) row.postflopAggressiveActions++;
        else if (passiveCall) row.postflopCallActions++;
        else if (type === 'fold') row.postflopFoldActions++;
      }
      if (street !== 'flop' || !current.cbet) return;

      const cbet = current.cbet;
      if (cbet.active && cbet.responseOpen && seat !== cbet.candidateSeat
        && !cbet.respondedSeats.has(seat)) {
        cbet.respondedSeats.add(seat);
        if (row) {
          row.foldToCbetOpportunity = 1;
          if (type === 'fold') row.foldToCbet = 1;
        }
        // Once the continuation bet is raised, later players are facing that
        // raise rather than a direct c-bet; do not inflate the denominator.
        if (aggressive) cbet.responseOpen = false;
      }

      if (cbet.resolved) return;
      if (seat === cbet.candidateSeat) {
        if (!cbet.facedAggression) {
          if (row) {
            row.cbetOpportunity = 1;
            if (aggressive) row.cbet = 1;
          }
          cbet.active = aggressive;
          cbet.responseOpen = aggressive;
        }
        cbet.resolved = true;
      } else if (aggressive) {
        // A donk bet before the preflop aggressor acts removes a clean flop
        // continuation-bet opportunity.
        cbet.facedAggression = true;
        cbet.resolved = true;
      }
    },

    onFlop(activeSeats) {
      if (!current) return;
      const active = new Set(activeSeats || []);
      for (const seat of active) {
        const row = rowForSeat(seat);
        if (row) row.sawFlop = 1;
      }
      const candidateSeat = active.has(current.preflopAggressorSeat)
        ? current.preflopAggressorSeat
        : null;
      current.cbet = {
        candidateSeat,
        resolved: candidateSeat == null,
        facedAggression: false,
        active: false,
        responseOpen: false,
        respondedSeats: new Set(),
      };
    },

    onShowdown(entrantSeats, winnerSeats) {
      if (!current) return;
      const winners = new Set(winnerSeats || []);
      for (const seat of entrantSeats || []) {
        const row = rowForSeat(seat);
        if (!row) continue;
        row.showdown = 1;
        if (winners.has(seat)) row.showdownWin = 1;
      }
    },

    getHands() {
      return hands.map((hand) => ({ ...hand }));
    },
  };
}

export function startServer(port = 8790, {
  speed = 1,
  maxPayload = DEFAULT_MAX_PAYLOAD_BYTES,
  heartbeatMs = 30_000,
  shutdownGraceMs = 1_000,
  resumeGraceMs = 90_000,
  databasePath = DEFAULT_DATABASE_PATH,
} = {}) {
  const payloadLimit = Number.isSafeInteger(maxPayload) && maxPayload > 0
    ? maxPayload
    : DEFAULT_MAX_PAYLOAD_BYTES;
  const heartbeatInterval = Number.isFinite(heartbeatMs) && heartbeatMs >= 0
    ? heartbeatMs
    : 30_000;
  const shutdownGrace = Number.isFinite(shutdownGraceMs) && shutdownGraceMs >= 0
    ? shutdownGraceMs
    : 1_000;
  const resumeGrace = Number.isFinite(resumeGraceMs) && resumeGraceMs >= 0
    ? resumeGraceMs
    : 90_000;
  const playerStore = createPlayerStore({ databasePath });
  let wss;
  try {
    wss = new WebSocketServer({ port, maxPayload: payloadLimit });
  } catch (error) {
    playerStore.close();
    throw error;
  }
  let closing = false;
  let tickTimer = null;
  let heartbeatTimer = null;
  let playerStoreClosed = false;

  const closePlayerStore = () => {
    if (playerStoreClosed) return;
    playerStoreClosed = true;
    playerStore.close();
  };

  const ready = new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  // Keep legacy callers safe when they do not await readiness; the original
  // promise still rejects for callers that do await it.
  ready.catch(() => {});

  /** @type {Map<number, object>} clientId -> client */
  const clients = new Map();
  /** @type {Map<string, object>} current resumeToken -> client */
  const sessions = new Map();
  /** @type {Map<number, object>} teamId -> team */
  const teams = new Map();
  let nextClientId = 1;
  let nextTeamId = 1;
  let nameCounter = 0;

  // ---------------- 发送工具 ----------------

  const sendSocket = (ws, obj) => {
    if (ws?.readyState === 1) {
      try {
        ws.send(JSON.stringify(obj));
      } catch (err) {
        console.error('[Server] 发送失败', err);
      }
    }
  };
  const send = (client, obj) => {
    if (client?.connected) sendSocket(client.ws, obj);
  };
  const broadcastTeam = (team, obj) => {
    for (const id of team.members) send(clients.get(id), obj);
  };
  const fail = (client, code, message) => send(client, errorEvent(code, message));

  const emptyStats = () => ({
    matches: 0, wins: 0, top3: 0, winRate: 0, bestRank: null,
  });

  const playerSummary = (profile) => ({
    playerId: profile?.playerId ?? null,
    shortId: profile?.shortId ?? null,
    emblem: profile?.emblem ?? '侠',
    stats: profile?.stats ? { ...profile.stats } : emptyStats(),
    pokerStats: profile?.pokerStats ? { ...profile.pokerStats } : null,
  });

  function sendPlayerProfile(client, profile = client.playerProfile, saved) {
    if (!profile) return;
    const a = { profile };
    if (saved !== undefined) a.saved = Boolean(saved);
    send(client, { ev: 'playerProfile', a });
  }

  function applyPlayerProfile(profile, { notify = false, saved } = {}) {
    const affectedTeamIds = new Set();
    for (const bound of clients.values()) {
      if (bound.playerId !== profile.playerId) continue;
      bound.playerProfile = profile;
      bound.name = profile.nickname;
      if (bound.teamId) affectedTeamIds.add(bound.teamId);
      if (notify) sendPlayerProfile(bound, profile, saved);
    }
    return affectedTeamIds;
  }

  function publishProfileState(profile, options) {
    const affectedTeamIds = applyPlayerProfile(profile, options);
    for (const teamId of affectedTeamIds) {
      const team = teams.get(teamId);
      if (team) sendTeamState(team);
    }
    broadcastLobby();
  }

  function sendLobbyTo(client) {
    const list = [...teams.values()]
      .map((t) => ({
        id: t.id,
        name: t.name,
        count: t.members.length,
        onlineCount: t.members.filter((id) => clients.get(id)?.connected).length,
        phase: t.phase,
      }))
      .sort((a, b) => a.id - b.id);
    send(client, {
      ev: 'lobby',
      a: { teams: list, yourName: client.name, player: client.playerProfile || null },
    });
  }
  function broadcastLobby() {
    for (const c of clients.values()) {
      if (!c.teamId) sendLobbyTo(c);
    }
  }

  const issueResumeToken = () => randomBytes(32).toString('base64url');

  function clearResumeTimer(client) {
    if (client.resumeTimer) clearTimeout(client.resumeTimer);
    client.resumeTimer = null;
    client.resumeExpiresAt = null;
  }

  function sendSession(client, resumed) {
    send(client, {
      ev: 'session',
      a: { resumeToken: client.resumeToken, resumed, resumeGraceMs: resumeGrace },
    });
  }

  function createClient(ws) {
    const client = {
      ws,
      id: nextClientId++,
      name: NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)] + '·' + (++nameCounter),
      teamId: null,
      seat: null,
      connected: true,
      isAlive: true,
      resumeToken: issueResumeToken(),
      resumeTimer: null,
      resumeExpiresAt: null,
      pendingResult: null,
      playerId: null,
      guestHash: null,
      playerProfile: null,
    };
    clients.set(client.id, client);
    sessions.set(client.resumeToken, client);
    console.log(`[Server] 客户端接入 #${client.id} 赐名 ${client.name}`);
    sendSession(client, false);
    sendLobbyTo(client);
    return client;
  }

  function expireClient(client) {
    if (client.connected) return;
    clearResumeTimer(client);
    if (sessions.get(client.resumeToken) === client) sessions.delete(client.resumeToken);
    clients.delete(client.id);
    console.log(`[Server] 会话过期 #${client.id}`);
    removeFromTeam(client);
  }

  function markDisconnected(client) {
    if (!client.connected) return;
    client.connected = false;
    client.ws = null;
    client.isAlive = false;

    const team = client.teamId ? teams.get(client.teamId) : null;
    if (team?.phase === 'playing' && team.game?.awaitSeat === client.seat) {
      team.game.awaitLeft = Math.min(team.game.awaitLeft, 1.0);
      if (team.game.actionClock?.idx === client.seat) {
        team.game.actionClock.remaining = Math.min(team.game.actionClock.remaining, 1.0);
        publishActionClock(team);
      }
    }

    if (resumeGrace === 0) {
      expireClient(client);
      return;
    }

    client.resumeExpiresAt = Date.now() + resumeGrace;
    client.resumeTimer = setTimeout(() => expireClient(client), resumeGrace);
    client.resumeTimer.unref?.();
    if (team) sendTeamState(team);
    broadcastLobby();
  }

  function resumeClient(ws, resumeToken) {
    const client = sessions.get(resumeToken);
    if (!client) return null;
    if (!client.connected && client.resumeExpiresAt != null
      && client.resumeExpiresAt <= Date.now()) {
      expireClient(client);
      return null;
    }

    const previousWs = client.ws;
    clearResumeTimer(client);
    sessions.delete(client.resumeToken);
    client.resumeToken = issueResumeToken();
    client.ws = ws;
    client.connected = true;
    client.isAlive = true;
    sessions.set(client.resumeToken, client);
    if (previousWs && previousWs !== ws && previousWs.readyState < 2) {
      try { previousWs.close(4000, 'SESSION_REPLACED'); } catch { previousWs.terminate(); }
    }

    console.log(`[Server] 会话恢复 #${client.id}`);
    const hadPendingResult = Boolean(client.pendingResult);
    const team = client.teamId ? teams.get(client.teamId) : null;
    sendSession(client, true);
    sendResumeState(client);
    if (team && (team.phase === 'playing' || hadPendingResult)) sendTeamState(team);
    if (team) broadcastLobby();
    return client;
  }

  const hasOfflineMember = (team) => team.members.some((id) => !clients.get(id)?.connected);

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
          connected: c2.connected,
          connection: c2.connected ? 'online' : 'offline',
          ...playerSummary(c2.playerProfile),
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

  function skillResultJ(result) {
    const out = { ...result };
    if (out.card) out.card = cardJ(out.card);
    return out;
  }

  function actionClockPayload(game) {
    const clock = game?.actionClock;
    if (!clock || !Number.isInteger(clock.idx)) return null;
    const remainingMs = Math.max(0, Math.ceil((Number(clock.remaining) || 0) * 1000));
    const totalMs = Math.max(1000, Math.ceil((Number(clock.total) || Config.ACTION_TIME) * 1000));
    const serverNow = Date.now();
    return {
      turnId: clock.turnId,
      idx: clock.idx,
      remainingMs,
      totalMs,
      serverNow,
      deadlineAt: serverNow + remainingMs,
    };
  }

  function startActionClock(game, idx) {
    game.actionClockSeq = (Number(game.actionClockSeq) || 0) + 1;
    game.actionClock = {
      turnId: game.actionClockSeq,
      idx: Number(idx),
      remaining: Config.ACTION_TIME,
      total: Config.ACTION_TIME,
    };
    return game.actionClock;
  }

  function clearActionClock(game) {
    if (!game) return;
    game.actionClock = null;
    game.awaitTotal = 0;
  }

  function publishActionClock(team) {
    const game = team?.game;
    if (!game) return;
    broadcastTeam(team, {
      ev: 'onActionClock',
      a: { clock: actionClockPayload(game) },
      s: snapshot(game),
    });
  }

  function snapshot(game) {
    const e = game.engine;
    const players = [];
    for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
      const p = e.players[i];
      players.push({
        seat: i, hp: p.hp, energy: p.energy,
        alive: p.alive, folded: p.folded, allIn: p.allIn,
        betStreet: p.betStreet, betRound: p.betRound, acted: !!p.acted,
        lastAction: p.lastAction ? { ...p.lastAction } : null,
        skillUsed: p.skillUsed,
        skillModifiers: p.skillStatuses
          .filter((status) => status.modifier)
          .map((status) => ({ modifier: status.modifier, amount: status.amount || 0 })),
      });
    }
    const board = [];
    for (let i = 0; i < e.revealed; i++) board.push(cardJ(e.board[i]));
    return {
      round: e.round, street: e.street, pot: e.totalPot(), potDisplay: e.getPotDisplay(true),
      actingIdx: e.actingIdx || 0,
      waitingIdx: e.waitingIdx,
      actionClock: actionClockPayload(game),
      revealed: e.revealed, board, players,
    };
  }

  function sendToSeat(game, seat, obj) {
    const m = game.seatToClient.get(seat);
    if (m?.connected && clients.get(m.id) === m) send(m, obj);
  }

  function wireGame(team) {
    const game = team.game;
    const L = game.listeners;
    const e = game.engine;
    const fwd = (ev, a) => broadcastTeam(team, { ev, a, s: snapshot(game) });

    L.onLog = (text, kind) => fwd('onLog', { text, kind });
    L.onRoundStart = (round, blinds, dealerIdx) => {
      clearActionClock(game);
      game.allInReveal = null;
      game.pokerTracker.onRoundStart(
        round,
        [...game.seatToClient.keys()].filter((seat) => e.players[seat]?.alive),
      );
      fwd('onRoundStart', { round, blinds, dealerIdx });
    };
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
    L.onTurnStart = (idx) => {
      startActionClock(game, idx);
      fwd('onTurnStart', { idx, clock: actionClockPayload(game) });
    };
    L.onAwaitAction = (idx, opts) => {
      game.awaitSeat = idx;
      game.lastOpts = opts;
      game.awaitTotal = Config.ACTION_TIME;
      const m = game.seatToClient.get(idx);
      if (m?.connected && clients.get(m.id) === m) {
        game.awaitLeft = Config.ACTION_TIME;
        if (game.actionClock?.idx === idx) {
          game.actionClock.remaining = game.awaitLeft;
          game.actionClock.total = game.awaitTotal;
        }
        publishActionClock(team);
        sendToSeat(game, idx, {
          ev: 'onAwaitAction',
          a: {
            idx,
            opts,
            remain: Math.ceil(game.awaitLeft),
            clock: actionClockPayload(game),
          },
          s: snapshot(game),
        });
      } else {
        game.awaitLeft = 1.0; // 断线托管：短暂延迟后自动行动
        if (game.actionClock?.idx === idx) {
          game.actionClock.remaining = game.awaitLeft;
          game.actionClock.total = game.awaitTotal;
        }
        publishActionClock(team);
      }
    };
    L.onAction = (idx, key, amount, meta) => {
      game.awaitSeat = null;
      game.awaitLeft = 0;
      clearActionClock(game);
      game.pokerTracker.onAction(idx, key, amount, meta);
      fwd('onAction', { idx, key, amount });
    };
    L.onStreet = (street, revealTo) => {
      if (street === 'flop') {
        game.pokerTracker.onFlop(e.activePlayers().map((player) => player.idx));
      }
      fwd('onStreet', { street, revealTo });
    };
    L.onHoleChange = (idx) => {
      const hole = e.players[idx].hole;
      sendToSeat(game, idx, { ev: 'hole', a: { hole: [cardJ(hole[0]), cardJ(hole[1])] } });
    };
    L.onSkill = (idx, skillId, skillName, presentation) =>
      fwd('onSkill', { idx, skillId, skillName, presentation });
    L.onPassive = (idx, skillId, skillName, presentation) =>
      fwd('onPassive', { idx, skillId, skillName, presentation });
    L.onSkillEffect = (idx, skillId, skillName, presentation) =>
      fwd('onSkillEffect', { idx, skillId, skillName, presentation });
    L.onQuote = (idx, text) => fwd('onQuote', { idx, text });
    L.onSkillResult = (idx, result) =>
      sendToSeat(game, idx, { ev: 'onSkillResult', a: { idx, result: skillResultJ(result) } });
    L.onSkillPublicResult = (idx, result) =>
      fwd('onSkillPublicResult', { idx, result: skillResultJ(result) });
    L.onPotAwarded = (winners, amount, uncontested, bonus, netWinnings) => {
      clearActionClock(game);
      fwd('onPotAwarded', { winners, amount, uncontested, bonus, netWinnings });
    };
    L.onAllInReveal = (entrants) => {
      const payload = {
        entrants: entrants.map((p) => ({
          seat: p.idx, hole: [cardJ(p.hole[0]), cardJ(p.hole[1])],
        })),
      };
      game.allInReveal = payload;
      fwd('onAllInReveal', payload);
    };
    L.onShowdown = (data) => {
      clearActionClock(game);
      game.pokerTracker.onShowdown(
        data.entrants.map((player) => player.idx),
        Object.entries(data.wonAmount)
          .filter(([, amount]) => Number(amount) > 0)
          .map(([seat]) => Number(seat)),
      );
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
        a: {
          entrants, won: data.wonAmount, net: data.netResult,
          totalPot: data.totalPot, pots: data.pots || [],
        },
        s: snapshot(game),
      });
    };
    L.onDeath = (idx) => fwd('onDeath', { idx });
    L.onRoundEnd = (round) => {
      clearActionClock(game);
      fwd('onRoundEnd', { round });
    };
    L.onGameOver = (ranking) => {
      clearActionClock(game);
      const placements = new Map(ranking.map((player, index) => [player.idx, {
        placement: index + 1,
        player,
      }]));
      const persistentResults = [];
      const recordedPlayerIds = new Set();
      for (const [seat, member] of game.seatToClient) {
        if (!member.playerId || recordedPlayerIds.has(member.playerId)) continue;
        const ranked = placements.get(seat);
        if (!ranked) continue;
        recordedPlayerIds.add(member.playerId);
        persistentResults.push({
          playerId: member.playerId,
          placement: ranked.placement,
          heroId: ranked.player.hero.id,
          survived: Boolean(ranked.player.alive),
        });
      }

      let storedProfiles = [];
      if (persistentResults.length > 0) {
        try {
          storedProfiles = playerStore.recordGame({
            matchId: game.matchId,
            results: persistentResults,
            hands: game.pokerTracker.getHands(),
          }).profiles;
        } catch (error) {
          console.error(`[Server] 对局战绩写入失败 match=${game.matchId}`, error);
        }
      }

      for (const [seat, m] of game.seatToClient) {
        const arr = ranking.map((p) => ({
          heroId: p.hero.id,
          name: p.playerName || p.hero.name,
          hp: p.hp, alive: p.alive, deathRound: p.deathRound ?? null,
          seat: p.idx, isMe: p.idx === seat,
        }));
        m.pendingResult = { ranking: arr, mySeat: seat };
        send(m, { ev: 'onGameOver', a: { ranking: arr } });
      }
      team.phase = 'lobby';
      team.picks = {};
      team.game = null;
      const affectedTeamIds = new Set([team.id]);
      for (const profile of storedProfiles) {
        for (const teamId of applyPlayerProfile(profile, { notify: true })) {
          affectedTeamIds.add(teamId);
        }
      }
      for (const teamId of affectedTeamIds) {
        const affectedTeam = teams.get(teamId);
        if (affectedTeam) sendTeamState(affectedTeam);
      }
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
      c.pendingResult = null;
      seatToClient.set(seat, c);
    });
    const pool = shuffle(HEROES.filter((hh) => !usedHero.has(hh.id)).map((hh) => hh.id));
    for (let i = team.members.length; i < Config.PLAYER_COUNT; i++) {
      heroIds[i] = pool.pop();
      names[i + 1] = 'AI·' + (getHero(heroIds[i])?.name || '无名');
    }

    const listeners = {};
    const engine = new Engine(heroIds, listeners, humanSeats, names);
    const ps = [];
    for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
      const isHuman = humanSeats.has(i);
      const member = isHuman ? seatToClient.get(i) : null;
      ps.push({
        seat: i,
        heroId: heroIds[i - 1],
        name: names[i],
        isHuman,
        ...(member ? {
          playerId: member.playerId,
          shortId: member.playerProfile?.shortId ?? null,
          emblem: member.playerProfile?.emblem ?? '侠',
          pokerStats: member.playerProfile?.pokerStats ?? null,
        } : {}),
      });
    }
    const pokerTracker = createPokerHandTracker(
      [...seatToClient].map(([seat, member]) => [seat, member.playerId]),
    );
    team.game = {
      engine, listeners, seatToClient, players: ps, matchId: randomUUID(), pokerTracker,
      awaitSeat: null, awaitLeft: 0, awaitTotal: 0, lastOpts: null, allInReveal: null,
      actionClockSeq: 0, actionClock: null,
    };
    team.phase = 'playing';
    wireGame(team);

    for (const [seat, m] of seatToClient) {
      send(m, { ev: 'gameStart', a: { mySeat: seat, players: ps } });
    }
    console.log(`[Server] 队伍 ${team.name} 开局：${team.members.length} 真人 + ${Config.PLAYER_COUNT - team.members.length} AI`);
    engine.startGame();
    broadcastLobby();
  }

  function sendResumeState(client) {
    if (client.pendingResult) {
      send(client, { ev: 'resumeResult', a: client.pendingResult });
      return;
    }

    const team = client.teamId ? teams.get(client.teamId) : null;
    if (!team) {
      sendLobbyTo(client);
      return;
    }
    if (team.phase === 'playing' && team.game && client.seat) {
      const game = team.game;
      send(client, {
        ev: 'gameStart',
        a: { mySeat: client.seat, players: game.players },
      });
      send(client, { ev: 'sync', a: {}, s: snapshot(game) });
      const hole = game.engine.players[client.seat]?.hole || [];
      if (hole.length >= 2) {
        send(client, { ev: 'hole', a: { hole: [cardJ(hole[0]), cardJ(hole[1])] } });
      }
      if (game.allInReveal) {
        send(client, { ev: 'onAllInReveal', a: game.allInReveal, s: snapshot(game) });
      }
      if (game.awaitSeat === client.seat && game.lastOpts) {
        send(client, {
          ev: 'onAwaitAction',
          a: {
            idx: client.seat,
            opts: game.lastOpts,
            remain: Math.max(0, Math.ceil(game.awaitLeft)),
            clock: actionClockPayload(game),
          },
          s: snapshot(game),
        });
      }
      return;
    }
    sendTeamState(team);
    if (team.phase === 'picking') sendPickState(team);
  }

  function autoAct(game) {
    const e = game.engine;
    const seat = game.awaitSeat;
    if (!seat || e.waitingIdx !== seat) {
      game.awaitSeat = null;
      clearActionClock(game);
      return;
    }
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
    const { empty } = detachRoomMember(team, client.id);
    if (empty) {
      teams.delete(team.id);
    } else {
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

    if (cmd === 'resume') {
      return fail(client, ERROR_CODES.SESSION_ALREADY_INITIALIZED, '当前连接已建立会话');

    } else if (cmd === 'identify') {
      const guestHash = guestFingerprint(msg.guestId);
      if (client.guestHash && client.guestHash !== guestHash) {
        return fail(client, ERROR_CODES.PLAYER_ALREADY_IDENTIFIED, '当前连接已绑定其他玩家身份');
      }
      const identity = playerStore.identify({
        guestId: msg.guestId,
        nickname: msg.nickname,
        emblem: msg.emblem,
        fallbackNickname: [...client.name].slice(0, 8).join(''),
      });
      if (client.playerId && client.playerId !== identity.profile.playerId) {
        return fail(client, ERROR_CODES.PLAYER_ALREADY_IDENTIFIED, '当前连接已绑定其他玩家身份');
      }
      client.playerId = identity.profile.playerId;
      client.guestHash = identity.guestHash;
      client.playerProfile = identity.profile;
      client.name = identity.profile.nickname;
      const affectedTeamIds = applyPlayerProfile(identity.profile);
      sendPlayerProfile(client, identity.profile);
      for (const teamId of affectedTeamIds) {
        const team = teams.get(teamId);
        if (team) sendTeamState(team);
      }
      broadcastLobby();

    } else if (cmd === 'updateProfile') {
      if (!client.playerId) {
        return fail(client, ERROR_CODES.PLAYER_NOT_IDENTIFIED, '请先绑定玩家身份');
      }
      const profile = playerStore.updateProfile(client.playerId, {
        ...(msg.nickname != null ? { nickname: msg.nickname } : {}),
        ...(msg.emblem != null ? { emblem: msg.emblem } : {}),
      });
      publishProfileState(profile, { notify: true, saved: true });

    } else if (cmd === 'create') {
      if (client.teamId) return fail(client, ERROR_CODES.ALREADY_IN_ROOM, '你已经在队伍中');
      if (teams.size >= MAX_TEAMS) {
        return fail(client, ERROR_CODES.ROOM_LIMIT_REACHED,
          '队伍数量已达上限，请加入现有队伍');
      }
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
      if (client.teamId) return fail(client, ERROR_CODES.ALREADY_IN_ROOM, '你已经在队伍中');
      const team = teams.get(msg.teamId);
      if (!team) return fail(client, ERROR_CODES.ROOM_NOT_FOUND, '队伍不存在');
      if (team.phase !== 'lobby') {
        return fail(client, ERROR_CODES.ROOM_NOT_JOINABLE, '该队伍已开局');
      }
      if (team.members.length >= MAX_TEAM_MEMBERS) {
        return fail(client, ERROR_CODES.ROOM_FULL, '该队伍已满员');
      }
      team.members.push(client.id);
      client.teamId = team.id;
      sendTeamState(team);
      broadcastLobby();

    } else if (cmd === 'leave') {
      const team = client.teamId ? teams.get(client.teamId) : null;
      if (team?.phase === 'playing') {
        return fail(client, ERROR_CODES.INVALID_ROOM_PHASE, '对局中不能直接离开房间');
      }
      removeFromTeam(client);
      sendLobbyTo(client);

    } else if (cmd === 'rename') {
      const name = normalizeNickname(msg.name);
      if (client.playerId) {
        const profile = playerStore.updateProfile(client.playerId, { nickname: name });
        publishProfileState(profile, { notify: true, saved: true });
      } else {
        client.name = name;
        const team = client.teamId ? teams.get(client.teamId) : null;
        if (team) {
          sendTeamState(team);
          if (team.phase === 'picking') sendPickState(team);
        }
      }

    } else if (cmd === 'startPick') {
      const team = client.teamId ? teams.get(client.teamId) : null;
      if (!team) return fail(client, ERROR_CODES.NOT_IN_ROOM, '当前不在队伍中');
      if (team.ownerId !== client.id) return fail(client, ERROR_CODES.NOT_ROOM_OWNER, '只有房主可以开始选将');
      if (team.phase !== 'lobby') return fail(client, ERROR_CODES.INVALID_ROOM_PHASE, '当前阶段不能开始选将');
      if (hasOfflineMember(team)) {
        return fail(client, ERROR_CODES.ROOM_MEMBER_OFFLINE, '有队员离线，暂时不能开始选将');
      }
      team.phase = 'picking';
      team.picks = {};
      team.pickLeft = PICK_TIME;
      sendTeamState(team);
      sendPickState(team);
      broadcastLobby();

    } else if (cmd === 'pick') {
      const team = client.teamId ? teams.get(client.teamId) : null;
      if (!team) return fail(client, ERROR_CODES.NOT_IN_ROOM, '当前不在队伍中');
      if (team.phase !== 'picking') return fail(client, ERROR_CODES.INVALID_ROOM_PHASE, '当前不在选将阶段');
      if (!getHero(msg.heroId)) return fail(client, ERROR_CODES.HERO_NOT_FOUND, '英雄不存在');
      for (const id2 of team.members) {
        if (id2 !== client.id && team.picks[id2] === msg.heroId) {
          return fail(client, ERROR_CODES.HERO_TAKEN, '该英雄已被占用');
        }
      }
      team.picks[client.id] = msg.heroId;
      sendPickState(team);

    } else if (cmd === 'startGame') {
      const team = client.teamId ? teams.get(client.teamId) : null;
      if (!team) return fail(client, ERROR_CODES.NOT_IN_ROOM, '当前不在队伍中');
      if (team.ownerId !== client.id) return fail(client, ERROR_CODES.NOT_ROOM_OWNER, '只有房主可以开始对局');
      if (team.phase !== 'picking') return fail(client, ERROR_CODES.INVALID_ROOM_PHASE, '当前阶段不能开始对局');
      if (hasOfflineMember(team)) {
        return fail(client, ERROR_CODES.ROOM_MEMBER_OFFLINE, '有队员离线，暂时不能开始对局');
      }
      for (const id of team.members) {
        if (!team.picks[id]) {
          return fail(client, ERROR_CODES.PICKS_INCOMPLETE,
            '还有队友未选定英雄');
        }
      }
      startGame(team);

    } else if (cmd === 'act') {
      const team = client.teamId ? teams.get(client.teamId) : null;
      if (!team || !team.game) return fail(client, ERROR_CODES.GAME_NOT_FOUND, '当前没有进行中的对局');
      const e = team.game.engine;
      if (e.waitingIdx !== client.seat) return fail(client, ERROR_CODES.NOT_YOUR_TURN, '当前不是你的行动回合');
      const opts = team.game.lastOpts || e.getOptions(e.players[client.seat]);
      const act = { type: msg.type };
      if (act.type === 'raise') {
        act.tier = opts.tiers.find((t) => t.key === msg.tierKey);
        if (!act.tier) return fail(client, ERROR_CODES.INVALID_RAISE_TIER, '加注档位无效');
      } else if (act.type === 'check') {
        if (!opts.canCheck) return fail(client, ERROR_CODES.INVALID_ACTION, '当前不能静观');
      } else if (act.type === 'allin') {
        if (opts.canAllIn === false) return fail(client, ERROR_CODES.INVALID_ACTION, '当前不能决死');
      }
      team.game.awaitSeat = null;
      e.playerAct(act);

    } else if (cmd === 'skill') {
      const team = client.teamId ? teams.get(client.teamId) : null;
      if (!team || !team.game || !client.seat) {
        return fail(client, ERROR_CODES.GAME_NOT_FOUND, '当前没有进行中的对局');
      }
      const game = team.game;
      if (game.awaitSeat !== client.seat
        || game.engine.waitingIdx !== client.seat
        || game.engine.actingIdx !== client.seat) {
        return fail(client, ERROR_CODES.NOT_YOUR_TURN, '当前不是你的行动回合');
      }
      const raw = msg.selection && typeof msg.selection === 'object' ? msg.selection : {};
      const selection = {};
      if (typeof raw.choice === 'string' || Number.isInteger(raw.choice)) selection.choice = raw.choice;
      if (Number.isInteger(raw.targetIdx)) {
        if (raw.targetIdx < 1 || raw.targetIdx > Config.PLAYER_COUNT) {
          return fail(client, ERROR_CODES.INVALID_FIELD, '技能目标座位无效');
        }
        selection.targetIdx = raw.targetIdx;
      }
      if (!game.engine.useSkill(client.seat, selection)) {
        return fail(client, ERROR_CODES.SKILL_REJECTED, '当前不能发动该技能');
      }

    } else if (cmd === 'extend') {
      const team = client.teamId ? teams.get(client.teamId) : null;
      if (!team || !team.game || !client.seat) {
        return fail(client, ERROR_CODES.GAME_NOT_FOUND, '当前没有进行中的对局');
      }
      const game = team.game;
      if (game.awaitSeat !== client.seat) {
        return fail(client, ERROR_CODES.NOT_YOUR_TURN, '当前不是你的行动回合');
      }
      if (game.engine.extendTime(client.seat)) {
        game.awaitLeft += Config.EXTEND_TIME;
        game.awaitTotal = Math.max(Config.ACTION_TIME, game.awaitTotal) + Config.EXTEND_TIME;
        if (game.actionClock?.idx === client.seat) {
          game.actionClock.remaining = game.awaitLeft;
          game.actionClock.total = game.awaitTotal;
        }
        publishActionClock(team);
        sendToSeat(game, client.seat, {
          ev: 'onAwaitAction',
          a: {
            idx: client.seat,
            opts: game.lastOpts,
            remain: Math.ceil(game.awaitLeft),
            clock: actionClockPayload(game),
          },
          s: snapshot(game),
        });
      } else {
        return fail(client, ERROR_CODES.EXTEND_REJECTED, '本回合不能再次延时');
      }

    } else if (cmd === 'backToRoom') {
      client.pendingResult = null;
      const team = client.teamId ? teams.get(client.teamId) : null;
      if (team) sendTeamState(team);
      else sendLobbyTo(client);

    } else if (cmd === 'lobby') {
      sendLobbyTo(client);
    }
  }

  // ---------------- 连接生命周期 ----------------

  wss.on('connection', (ws) => {
    if (closing) {
      ws.close(1012, ERROR_CODES.SERVER_SHUTTING_DOWN);
      return;
    }
    let client = null;
    let initialized = false;
    const finishNewSession = () => {
      if (initialized || ws.readyState !== 1) return client;
      initialized = true;
      client = createClient(ws);
      return client;
    };
    const handshakeTimer = setTimeout(finishNewSession, SESSION_HANDSHAKE_MS);
    handshakeTimer.unref?.();

    ws.on('pong', () => {
      if (client?.ws === ws) client.isAlive = true;
    });

    ws.on('message', (data, isBinary) => {
      if (closing) {
        sendSocket(ws, errorEvent(ERROR_CODES.SERVER_SHUTTING_DOWN, '服务器正在关闭'));
        return;
      }
      if (initialized && client?.ws !== ws) return;
      const decoded = decodeClientMessage(data, { isBinary, maxBytes: payloadLimit });
      if (!decoded.ok) {
        sendSocket(ws, errorEvent(decoded.error.code, decoded.error.message));
        return;
      }
      const msg = decoded.value;
      if (!initialized) {
        clearTimeout(handshakeTimer);
        initialized = true;
        if (msg.cmd === 'resume') client = resumeClient(ws, msg.resumeToken) || createClient(ws);
        else client = createClient(ws);
        if (msg.cmd === 'resume') return;
      }
      try {
        handleCmd(client, msg);
      } catch (err) {
        if (err instanceof PlayerValidationError) {
          const code = Object.hasOwn(ERROR_CODES, err.code)
            ? ERROR_CODES[err.code]
            : ERROR_CODES.INVALID_PROFILE;
          fail(client, code, err.message);
          return;
        }
        console.error(`[Server] 命令处理出错 cmd=${msg.cmd}`, err);
        fail(client, ERROR_CODES.INTERNAL_ERROR, '命令处理失败');
      }
    });

    ws.on('error', (err) => {
      if (err?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') return;
      if (!closing) console.error(`[Server] 客户端连接错误 #${client?.id || 'pending'}`, err);
    });

    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      if (!client || client.ws !== ws) return;
      console.log(`[Server] 客户端断开 #${client.id}`);
      if (closing) {
        client.connected = false;
        client.ws = null;
        return;
      }
      markDisconnected(client);
    });
  });

  // ---------------- 主循环 ----------------

  tickTimer = setInterval(() => {
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
        if (game.actionClock && game.engine.actingIdx === game.actionClock.idx) {
          game.actionClock.remaining = Math.max(0, game.actionClock.remaining - dt);
        }
        game.engine.update(dt);
        if (team.game === game && game.awaitSeat) {
          game.awaitLeft -= dt;
          if (game.awaitLeft <= 0) autoAct(game);
        }
      }
    }
  }, TICK_MS);

  if (heartbeatInterval > 0) {
    heartbeatTimer = setInterval(() => {
      for (const client of clients.values()) {
        if (!client.connected || !client.ws) continue;
        if (!client.isAlive) {
          client.ws.terminate();
          continue;
        }
        client.isAlive = false;
        try {
          client.ws.ping();
        } catch {
          client.ws.terminate();
        }
      }
    }, heartbeatInterval);
    heartbeatTimer.unref?.();
  }

  const stopTimers = () => {
    if (tickTimer) clearInterval(tickTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    for (const client of clients.values()) clearResumeTimer(client);
    tickTimer = null;
    heartbeatTimer = null;
  };

  wss.on('listening', () => {
    const address = wss.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    console.log(`[Server] 群英决对战服务已启动 ws://0.0.0.0:${boundPort}`);
  });
  wss.on('error', (err) => {
    stopTimers();
    closePlayerStore();
    console.error('[Server] WebSocket 服务错误', err);
  });

  let closePromise = null;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    stopTimers();
    let forceTimer = null;
    closePromise = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        closePlayerStore();
        resolve();
      };
      try {
        wss.close(finish);
      } catch {
        finish();
      }
      for (const ws of wss.clients) {
        try { ws.close(1001, 'SERVER_SHUTDOWN'); } catch { ws.terminate(); }
      }
      forceTimer = setTimeout(() => {
        for (const ws of wss.clients) ws.terminate();
        finish();
      }, shutdownGrace);
      forceTimer.unref?.();
    });
    closePromise.finally(() => {
      if (forceTimer) clearTimeout(forceTimer);
    });
    return closePromise;
  };

  return {
    wss,
    ready,
    close,
    playerStore,
  };
}

// 直接运行时启动
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const port = Number(process.argv[2]) || 8790;
  const server = startServer(port);
  server.ready.catch(() => { process.exitCode = 1; });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await server.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
