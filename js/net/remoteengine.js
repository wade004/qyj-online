// ============================================================================
// remoteengine.js - 联机对局代理（对应 Maker 版 RemoteEngine.lua）
// 镜像服务器广播的公开状态，接口与本地 Engine 对齐，供 battle.js 直接驱动；
// 行动/技能/延时通过 WebSocket 转发给权威服务器裁决。
// ============================================================================

import * as Config from '../game/config.js';
import { getHero, HEROES, checkCondition } from '../game/heroes.js';

const card = (c) => ({ rank: c.r, suit: c.s });

export class RemoteEngine {
  /**
   * @param {object} startData 服务器 gameStart 数据 { mySeat, players }
   * @param {object} listeners battle.js 填充的监听表
   * @param {function} sendFn 发送函数 sendFn(cmdObj)
   */
  constructor(startData, listeners, sendFn) {
    this.listeners = listeners;
    this.send = sendFn;
    this.myIdx = startData.mySeat;
    this.players = [null];
    for (const p of startData.players) {
      this.players[p.seat] = {
        idx: p.seat,
        hero: getHero(p.heroId) || HEROES[0],
        playerName: p.name,
        isHuman: p.isHuman,
        hp: Config.INIT_HP,
        energy: Config.INIT_ENERGY,
        alive: true,
        hole: [],
        folded: false,
        allIn: false,
        betStreet: 0,
        betRound: 0,
        skillUsed: false,
        showdownInfo: null,
      };
    }
    this.board = [];
    this.revealed = 0;
    this.round = 0;
    this.pot = 0;
    this.waitingIdx = null;
    this.gameOver = false;
    this.time = 0;
    this.queue = [];
  }

  // ---- 与本地 Engine 对齐的查询接口 ----

  totalPot() { return this.pot; }
  revealedBoard() { return this.board.slice(0, this.revealed); }
  activePlayers() {
    return this.players.slice(1).filter((p) => p.alive && !p.folded);
  }
  canUseSkill(idx) {
    const p = this.players[idx];
    if (!p || this.gameOver || !p.alive || p.folded || p.skillUsed) return false;
    if (this.round <= 0) return false;
    if (p.energy < p.hero.skillCost) return false;
    if (p.hole.length < 2) return false;
    return checkCondition(p.hero.id, p.hole);
  }

  // ---- 行动转发 ----

  playerAct(act) {
    this.send({ cmd: 'act', type: act.type, tierKey: act.tier ? act.tier.key : undefined });
  }
  useSkill(idx, extra = null) {
    this.send({ cmd: 'skill', cardIdx: extra ? extra.cardIdx : undefined });
    return true;
  }
  extendTime() {
    this.send({ cmd: 'extend' });
    return false; // 剩余时间由服务器重播 await 刷新
  }

  // ---- 延时队列（演出用） ----

  delay(sec, fn) { this.queue.push({ due: this.time + sec, fn }); }
  update(dt) {
    this.time += dt;
    if (!this.queue.length) return;
    const due = this.queue.filter((i) => i.due <= this.time);
    this.queue = this.queue.filter((i) => i.due > this.time);
    for (const i of due) i.fn();
  }

  // ---- 服务器消息应用 ----

  applySnapshot(s) {
    if (!s) return;
    this.round = s.round ?? this.round;
    this.pot = s.pot ?? this.pot;
    this.waitingIdx = s.waitingIdx ?? null;
    this.revealed = s.revealed ?? this.revealed;
    if (s.board) this.board = s.board.map(card);
    if (s.players) {
      for (const sp of s.players) {
        const p = this.players[sp.seat];
        if (!p) continue;
        p.hp = sp.hp; p.energy = sp.energy; p.alive = sp.alive;
        p.folded = sp.folded; p.allIn = sp.allIn;
        p.betStreet = sp.betStreet; p.betRound = sp.betRound;
        p.skillUsed = sp.skillUsed;
      }
    }
  }

  onMessage(msg) {
    this.applySnapshot(msg.s);
    const a = msg.a || {};
    const ev = msg.ev;
    const L = this.listeners;

    if (ev === 'hole') {
      const p = this.players[this.myIdx];
      p.hole = (a.hole || []).map(card);
      if (L.onHoleChange) L.onHoleChange(this.myIdx);
      return;
    }
    if (ev === 'onGameOver') {
      this.gameOver = true;
      const ranking = (a.ranking || []).map((r) => ({
        idx: r.seat,
        hero: getHero(r.heroId) || HEROES[0],
        playerName: r.name,
        hp: r.hp, alive: r.alive, deathRound: r.deathRound,
      }));
      if (L.onGameOver) L.onGameOver(ranking);
      return;
    }
    if (ev === 'onShowdown') {
      const entrants = [];
      for (const e of a.entrants || []) {
        const p = this.players[e.seat];
        if (!p) continue;
        p.hole = e.hole.map(card);
        p.showdownInfo = { name: e.handName, cat: e.cat, score: e.score || 0 };
        p.betRound = e.betRound ?? p.betRound;
        entrants.push(p);
      }
      const wonAmount = {};
      for (const [k, v] of Object.entries(a.won || {})) wonAmount[Number(k)] = v;
      if (L.onShowdown) L.onShowdown({ entrants, wonAmount, totalPot: a.totalPot || 0 });
      return;
    }

    const handler = L[ev];
    if (handler) {
      switch (ev) {
        case 'onLog': handler(a.text, a.kind); break;
        case 'onRoundStart': handler(a.round, a.blinds, a.dealerIdx); break;
        case 'onBlindsPosted': handler(a.sbIdx, a.sbAmt, a.bbIdx, a.bbAmt); break;
        case 'onTurnStart': handler(a.idx); break;
        case 'onAwaitAction': handler(a.idx, a.opts, a.remain); break;
        case 'onAction': handler(a.idx, a.key, a.amount); break;
        case 'onStreet': handler(a.street, a.revealTo); break;
        case 'onSkill': handler(a.idx, a.skillName); break;
        case 'onQuote': handler(a.idx, a.text); break;
        case 'onPeek': handler(a.idx, card(a.card), a.slot); break;
        case 'onSpy': handler(a.idx, a.targetIdx, a.cardIdx, card(a.card)); break;
        case 'onPotAwarded': handler(a.winners, a.amount, a.uncontested, a.bonus); break;
        case 'onDeath': handler(a.idx); break;
        case 'onRoundEnd': handler(a.round); break;
        case 'onDeal': handler(); break;
        default: break;
      }
    }
    if (L.onSync) L.onSync();
  }
}
