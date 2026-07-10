// ============================================================================
// remoteengine.js - 联机对局代理（对应 Maker 版 RemoteEngine.lua）
// 镜像服务器广播的公开状态，接口与本地 Engine 对齐，供 battle.js 直接驱动；
// 行动/技能/延时通过 WebSocket 转发给权威服务器裁决。
// ============================================================================

import * as Config from '../game/config.js';
import { getHero, HEROES } from '../game/heroes.js';
import { getSkillAvailability, getSkillInput } from '../game/skills.js';

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
        skillStatuses: [],
        passiveUsed: Object.create(null),
        skillData: { flags: Object.create(null), copiedPassiveIds: [], revealedCard: null, raisedThisRound: false },
        showdownInfo: null,
      };
    }
    this.board = [];
    this.revealed = 0;
    this.round = 0;
    this.street = 'idle';
    this.pot = 0;
    this.potLayers = [{ label: '主池', amount: 0, kind: 'main' }];
    this.potDisplay = [{ label: '当前血池', amount: 0, kind: 'main' }];
    this.waitingIdx = null;
    this.gameOver = false;
    this.time = 0;
    this.queue = [];
  }

  // ---- 与本地 Engine 对齐的查询接口 ----

  totalPot() { return this.pot; }
  getPotBreakdown() { return this.potLayers; }
  getPotDisplay(includeReference = true) {
    return includeReference
      ? this.potDisplay
      : this.potDisplay.filter((item) => item.kind !== 'reference');
  }
  revealedBoard() { return this.board.slice(0, this.revealed); }
  activePlayers() {
    return this.players.slice(1).filter((p) => p.alive && !p.folded);
  }
  canUseSkill(idx) {
    return getSkillAvailability(this, this.players[idx]).ok;
  }
  skillAvailability(idx) {
    return getSkillAvailability(this, this.players[idx]);
  }
  getSkillPrompt(idx) {
    return getSkillInput(this, this.players[idx]);
  }

  // ---- 行动转发 ----

  playerAct(act) {
    this.send({ cmd: 'act', type: act.type, tierKey: act.tier ? act.tier.key : undefined });
  }
  useSkill(idx, selection = null) {
    this.send({ cmd: 'skill', selection: selection || undefined });
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
    this.street = s.street ?? this.street;
    this.pot = s.pot ?? this.pot;
    if (s.potLayers) this.potLayers = s.potLayers.map((layer) => ({ ...layer }));
    if (s.potDisplay) this.potDisplay = s.potDisplay.map((item) => ({ ...item }));
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
        p.skillStatuses = (sp.skillModifiers || []).map((status) => ({ ...status }));
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
    if (ev === 'onAllInReveal') {
      const entrants = [];
      for (const item of a.entrants || []) {
        const p = this.players[item.seat];
        if (!p) continue;
        p.hole = (item.hole || []).map(card);
        entrants.push(p);
      }
      if (L.onAllInReveal) L.onAllInReveal(entrants);
      if (L.onSync) L.onSync();
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
      const netResult = {};
      for (const [k, v] of Object.entries(a.net || {})) netResult[Number(k)] = v;
      if (L.onShowdown) L.onShowdown({
        entrants, wonAmount, netResult, totalPot: a.totalPot || 0, pots: a.pots || [],
      });
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
        case 'onSkill': handler(a.idx, a.skillId, a.skillName, a.presentation); break;
        case 'onPassive': handler(a.idx, a.skillId, a.skillName, a.presentation); break;
        case 'onSkillEffect': handler(a.idx, a.skillId, a.skillName, a.presentation); break;
        case 'onQuote': handler(a.idx, a.text); break;
        case 'onSkillResult': {
          const result = { ...a.result };
          if (result.card) result.card = card(result.card);
          handler(a.idx, result);
          break;
        }
        case 'onSkillPublicResult': {
          const result = { ...a.result };
          if (result.card) result.card = card(result.card);
          handler(a.idx, result);
          break;
        }
        case 'onPotAwarded':
          handler(a.winners, a.amount, a.uncontested, a.bonus, a.netWinnings); break;
        case 'onDeath': handler(a.idx); break;
        case 'onRoundEnd': handler(a.round); break;
        case 'onDeal': handler(); break;
        default: break;
      }
    }
    if (L.onSync) L.onSync();
  }
}
