// ============================================================================
// remoteengine.js - 联机对局代理（对应 Maker 版 RemoteEngine.lua）
// 镜像服务器广播的公开状态，接口与本地 Engine 对齐，供 battle.js 直接驱动；
// 行动/技能/延时通过 WebSocket 转发给权威服务器裁决。
// ============================================================================

import * as Config from '../game/config.js';
import { getHero, HEROES } from '../game/heroes.js';
import { getSkillAvailability, getSkillInput } from '../game/skills.js';

const card = (c) => ({ rank: c.r, suit: c.s });
const ATTACK_KEYS = new Set(Config.ATTACK_TIERS.map((tier) => tier.key));

function normalizeActionClock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const idx = Number(raw.idx);
  const remainingMs = Number(raw.remainingMs);
  const totalMs = Number(raw.totalMs);
  if (!Number.isInteger(idx) || idx < 1 || !Number.isFinite(remainingMs)) return null;
  return {
    turnId: raw.turnId ?? null,
    idx,
    remainingMs: Math.max(0, remainingMs),
    totalMs: Math.max(1000, Number.isFinite(totalMs) ? totalMs : Config.ACTION_TIME * 1000),
    serverNow: Number(raw.serverNow) || null,
    deadlineAt: Number(raw.deadlineAt) || null,
  };
}

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
        playerId: p.playerId || null,
        shortId: p.shortId || null,
        emblem: p.emblem || '侠',
        pokerStats: p.pokerStats && typeof p.pokerStats === 'object'
          ? { ...p.pokerStats }
          : null,
        hp: Config.INIT_HP,
        energy: Config.INIT_ENERGY,
        alive: true,
        hole: [],
        folded: false,
        allIn: false,
        betStreet: 0,
        betRound: 0,
        acted: false,
        lastAction: null,
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
    this.dealerIdx = 0;
    this.currentBet = 0;
    this.streetRaiseCount = 0;
    this.actingIdx = 0;
    this.lastAggressiveWager = null;
    this.pot = 0;
    this.potLayers = [{ label: '主池', amount: 0, kind: 'main' }];
    this.potDisplay = [{ label: '当前血池', amount: 0, kind: 'main' }];
    this.waitingIdx = null;
    this.actionClock = null;
    this.gameOver = false;
    this.lastRanking = null;
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
    if (this.waitingIdx !== this.myIdx) return false;
    return this.send({ cmd: 'act', type: act.type, tierKey: act.tier ? act.tier.key : undefined }) !== false;
  }
  useSkill(idx, selection = null) {
    if (Number(idx) !== Number(this.myIdx)
      || Number(this.actingIdx) !== Number(this.myIdx)
      || Number(this.waitingIdx) !== Number(this.myIdx)
      || !this.canUseSkill(idx)) return false;
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
    const previousStreet = this.street;
    this.round = s.round ?? this.round;
    this.street = s.street ?? this.street;
    this.dealerIdx = s.dealerIdx ?? this.dealerIdx;
    this.streetRaiseCount = s.streetRaiseCount ?? this.streetRaiseCount;
    if (Object.prototype.hasOwnProperty.call(s, 'actingIdx')) {
      this.actingIdx = Number.isInteger(s.actingIdx) ? s.actingIdx : 0;
    } else if (s.waitingIdx != null) {
      // Legacy snapshots only exposed the human seat waiting for input.
      this.actingIdx = s.waitingIdx;
    }
    this.pot = s.pot ?? this.pot;
    if (s.potLayers) this.potLayers = s.potLayers.map((layer) => ({ ...layer }));
    if (s.potDisplay) {
      this.potDisplay = s.potDisplay.map((item) => ({ ...item }));
      if (!s.potLayers) {
        this.potLayers = this.potDisplay
          .filter((item) => item.kind !== 'reference')
          .map((item) => ({ ...item }));
      }
    }
    this.waitingIdx = s.waitingIdx ?? null;
    if (Object.prototype.hasOwnProperty.call(s, 'actionClock')) {
      this.actionClock = normalizeActionClock(s.actionClock);
    }
    this.revealed = s.revealed ?? this.revealed;
    if (s.board) this.board = s.board.map(card);
    if (s.players) {
      for (const sp of s.players) {
        const p = this.players[sp.seat];
        if (!p) continue;
        p.hp = sp.hp; p.energy = sp.energy; p.alive = sp.alive;
        p.folded = sp.folded; p.allIn = sp.allIn;
        p.betStreet = sp.betStreet; p.betRound = sp.betRound;
        if (Object.prototype.hasOwnProperty.call(sp, 'acted')) p.acted = !!sp.acted;
        if (Object.prototype.hasOwnProperty.call(sp, 'lastAction')) {
          p.lastAction = sp.lastAction && typeof sp.lastAction === 'object'
            ? { ...sp.lastAction }
            : null;
        }
        p.skillUsed = sp.skillUsed;
        p.skillStatuses = (sp.skillModifiers || []).map((status) => ({ ...status }));
      }
    }
    this.currentBet = s.currentBet ?? Math.max(
      0,
      ...this.players.slice(1).map((player) => player?.betStreet || 0),
    );
    const reference = this.potDisplay.find((item) => item.kind === 'reference');
    if (Object.prototype.hasOwnProperty.call(s, 'lastAggressiveWager')) {
      this.lastAggressiveWager = s.lastAggressiveWager ? { ...s.lastAggressiveWager } : null;
    } else if (reference) {
      this.lastAggressiveWager = {
        actorIdx: reference.actorIdx || null,
        amount: reference.wagerAmount || 0,
        potBefore: reference.amount || 0,
        ratio: reference.ratio || 0,
      };
    } else if (previousStreet !== this.street) {
      this.lastAggressiveWager = null;
      if (s.streetRaiseCount == null) this.streetRaiseCount = 0;
    }
  }

  onMessage(msg) {
    const previousCurrentBet = this.currentBet;
    this.applySnapshot(msg.s);
    const a = msg.a || {};
    const ev = msg.ev;
    const L = this.listeners;
    const snapshotHasPlayerActions = Array.isArray(msg.s?.players)
      && msg.s.players.some((player) => Object.prototype.hasOwnProperty.call(player, 'acted')
        || Object.prototype.hasOwnProperty.call(player, 'lastAction'));

    if (ev === 'onRoundStart') {
      this.actingIdx = 0;
      this.actionClock = null;
      if (!snapshotHasPlayerActions) {
        for (const player of this.players.slice(1)) {
          player.acted = false;
          player.lastAction = null;
        }
      }
    } else if (ev === 'onBlindsPosted' && !snapshotHasPlayerActions) {
      const sb = this.players[a.sbIdx];
      const bb = this.players[a.bbIdx];
      if (sb) sb.lastAction = {
        key: 'smallBlind', amount: Number(a.sbAmt) || 0,
        street: this.street, round: this.round,
      };
      if (bb) bb.lastAction = {
        key: 'bigBlind', amount: Number(a.bbAmt) || 0,
        street: this.street, round: this.round,
      };
    } else if (ev === 'onTurnStart' || ev === 'onAwaitAction') {
      this.actingIdx = Number.isInteger(a.idx) ? a.idx : 0;
      if (a.clock) this.actionClock = normalizeActionClock(a.clock);
    } else if (ev === 'onActionClock') {
      this.actionClock = normalizeActionClock(a.clock);
      if (this.actionClock) this.actingIdx = this.actionClock.idx;
    } else if (ev === 'onAction') {
      this.actingIdx = 0;
      this.actionClock = null;
      const player = this.players[a.idx];
      if (player && !snapshotHasPlayerActions) {
        player.acted = true;
        player.lastAction = {
          key: a.key,
          amount: Number(a.amount) || 0,
          street: this.street,
          round: this.round,
        };
        if (ATTACK_KEYS.has(a.key)) {
          for (const other of this.players.slice(1)) {
            if (other.idx !== a.idx) other.acted = false;
          }
        }
      }
    } else if (ev === 'onStreet') {
      this.actingIdx = 0;
      this.actionClock = null;
      if (!snapshotHasPlayerActions) {
        for (const player of this.players.slice(1)) {
          player.acted = false;
          if (!player.folded && !player.allIn) player.lastAction = null;
        }
      }
    } else if (['onAllInReveal', 'onPotAwarded', 'onShowdown', 'onRoundEnd', 'onGameOver']
      .includes(ev)) {
      this.actingIdx = 0;
      this.actionClock = null;
    }

    if (ev === 'onRoundStart') {
      this.dealerIdx = a.dealerIdx ?? this.dealerIdx;
      if (msg.s?.streetRaiseCount == null) this.streetRaiseCount = 0;
      if (!msg.s?.lastAggressiveWager) this.lastAggressiveWager = null;
    } else if (ev === 'onStreet') {
      if (msg.s?.streetRaiseCount == null) this.streetRaiseCount = 0;
      if (!msg.s?.lastAggressiveWager) this.lastAggressiveWager = null;
    } else if (ev === 'onAction' && msg.s?.streetRaiseCount == null) {
      if (ATTACK_KEYS.has(a.key) || (a.key === 'allin' && this.currentBet > previousCurrentBet)) {
        this.streetRaiseCount++;
      }
    }

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
      this.lastRanking = ranking;
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
        case 'onTurnStart': handler(a.idx, a.clock || this.actionClock); break;
        case 'onAwaitAction': handler(a.idx, a.opts, a.remain, a.clock || this.actionClock); break;
        case 'onActionClock': handler(a.clock || this.actionClock); break;
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
