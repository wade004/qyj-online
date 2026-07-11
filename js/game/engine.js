// ============================================================================
// engine.js - 群英决 规则引擎（德州扑克内核 · 世界观包装）
// 与 Maker 版 Engine.lua 一一对应：
// 回合流程：发令 → 血祭 → 四轮灌注（暗令/天时/地利/人和）→ 亮招 → 结算
// 通过 listeners 回调驱动 UI，内部用延时队列编排演出节奏（由 update(dt) 驱动）
// ============================================================================

import * as Config from './config.js';
import { newShuffledDeck, draw, shuffle } from './deck.js';
import { describe, evalBest } from './handeval.js';
import { getHero, HEROES } from './heroes.js';
import {
  dispatchSkillEvent,
  executeActiveSkill,
  getSkillAvailability,
  getSkillInput,
  resetRoundSkillState,
} from './skills.js';
import * as AI from './ai.js';

export function cardText(card) {
  return Config.SUITS[card.suit].char + Config.RANK_NAMES[card.rank];
}

export class Engine {
  /**
   * @param {string[]} heroIds 6个英雄id
   * @param {object} listeners 回调表
   * @param {Set<number>|null} humanSeats 真人座位集合（1-based）；缺省 {1}
   * @param {object} names 各座位显示名 { [idx]: name }
   * @param {object} rules 模式专属终局规则
   */
  constructor(heroIds, listeners, humanSeats = null, names = {}, rules = {}) {
    this.listeners = listeners || {};
    humanSeats = humanSeats || new Set([1]);
    this.players = [null]; // 1-based
    for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
      const hero = getHero(heroIds[i - 1] || 'zhugeliang') || HEROES[0];
      this.players.push({
        idx: i,
        hero,
        isHuman: humanSeats.has(i),
        playerName: names[i] || null,
        style: null,
        hp: Config.INIT_HP,
        energy: Config.INIT_ENERGY,
        alive: true,
        hole: [],
        folded: false,
        allIn: false,
        betStreet: 0,
        betRound: 0,
        acted: false,
        lastActionBet: 0,
        lastAction: null,
        skillUsed: false,
        skillStatuses: [],
        passiveUsed: Object.create(null),
        skillData: {
          flags: Object.create(null), copiedPassiveIds: [],
          revealedCard: null, raisedThisRound: false,
        },
        lastHandCategory: 1,
        roundStartHp: Config.INIT_HP,
        deathRound: null,
        deathOrder: null,
        showdownInfo: null,
      });
    }
    // AI 座位随机分配互不相同的性格
    const styles = shuffle([...Config.AI_STYLES]);
    let si = 0;
    for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
      if (!this.players[i].isHuman) {
        this.players[i].style = styles[si % styles.length];
        si++;
      }
    }

    this.round = 0;
    this.dealerIdx = 1 + Math.floor(Math.random() * Config.PLAYER_COUNT);
    this.street = 'idle';
    this.deck = [];
    this.board = [];
    this.revealed = 0;
    this.currentBet = 0;
    this.minRaiseInc = 0;
    this.streetRaiseCount = 0;
    this.actingIdx = 0;
    this.actionCursorIdx = 0;
    this.waitingIdx = null;
    this.streetHadRaise = false;
    this.allInHandsRevealed = false;
    this.lastAggressiveWager = null;
    this.deathCounter = 0;
    this.gameOver = false;
    this.endWhenHumanEliminated = !!rules.endWhenHumanEliminated;

    this.time = 0;
    this.queue = [];
  }

  // ---------------- 延时调度 ----------------

  delay(sec, fn) {
    this.queue.push({ due: this.time + sec, fn });
  }

  update(dt) {
    this.time += dt;
    if (this.queue.length === 0) return;
    const due = [];
    const rest = [];
    for (const item of this.queue) {
      (item.due <= this.time ? due : rest).push(item);
    }
    this.queue = rest;
    due.sort((a, b) => a.due - b.due);
    for (const item of due) item.fn();
  }

  // ---------------- 事件与工具 ----------------

  emit(name, ...args) {
    const fn = this.listeners[name];
    if (fn) fn(...args);
  }

  log(text, kind = 'info') {
    this.emit('onLog', text, kind);
  }

  totalPot() {
    let pot = 0;
    for (let i = 1; i <= Config.PLAYER_COUNT; i++) pot += this.players[i].betRound;
    return pot;
  }

  getPotDisplay(includeReference = true) {
    const last = this.lastAggressiveWager;
    const breakdown = this.getPotBreakdown().map((pot) => ({ ...pot }));
    const pendingAmount = breakdown
      .filter((pot) => pot.kind === 'pending')
      .reduce((sum, pot) => sum + pot.amount, 0);
    const current = breakdown.filter((pot) => pot.kind !== 'pending');
    if (!current.length) current.push({ label: '当前血池', amount: 0, kind: 'main' });
    if (pendingAmount > 0) current[current.length - 1].amount += pendingAmount;
    if (current.length === 1) current[0].label = '当前血池';

    if (includeReference && last) {
      current.push({
        label: '上次下注前', amount: last?.potBefore || 0, kind: 'reference',
        actorIdx: last?.actorIdx || null,
        wagerAmount: last?.amount || 0,
        ratio: last?.ratio || 0,
      });
    }
    return current;
  }

  getPotBreakdown() {
    const total = this.totalPot();
    const entrants = this.activePlayers();
    if (!entrants.some((player) => player.allIn)) {
      return [{ label: '主池', amount: total, kind: 'main' }];
    }

    const contribs = {};
    for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
      contribs[i] = this.players[i].betRound;
    }
    const rankedContributions = Object.entries(contribs)
      .filter(([, amount]) => amount > 0)
      .sort((a, b) => b[1] - a[1]);
    let pending = null;
    if (rankedContributions.length) {
      const [topIdx, topAmount] = rankedContributions[0];
      const matchedCeiling = rankedContributions[1]?.[1] || 0;
      if (topAmount > matchedCeiling) {
        pending = { label: '待跟注', amount: topAmount - matchedCeiling, kind: 'pending' };
        contribs[topIdx] = matchedCeiling;
      }
    }

    const matchedCeiling = Math.max(0, ...Object.values(contribs));
    const levels = [...new Set([
      ...entrants.filter((player) => player.allIn).map((player) => contribs[player.idx]),
      matchedCeiling,
    ].filter((amount) => amount > 0))].sort((a, b) => a - b);

    let contestedIndex = 0;
    const visible = this.buildPots(entrants, { contribs, levels }).map((pot) => {
      if (pot.uncalledTo) {
        return { label: '待跟注', amount: pot.amount, kind: 'pending' };
      }
      const label = contestedIndex === 0 ? '主池' : `边池 ${contestedIndex}`;
      const kind = contestedIndex === 0 ? 'main' : 'side';
      contestedIndex++;
      return { label, amount: pot.amount, kind };
    });
    if (!visible.some((pot) => pot.kind === 'main')) {
      visible.unshift({ label: '主池', amount: 0, kind: 'main' });
    }
    if (pending) visible.push(pending);
    return visible;
  }

  revealedBoard() {
    return this.board.slice(0, this.revealed);
  }

  aliveCount() {
    let n = 0;
    for (let i = 1; i <= Config.PLAYER_COUNT; i++) if (this.players[i].alive) n++;
    return n;
  }

  activePlayers() {
    const t = [];
    for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
      const p = this.players[i];
      if (p.alive && !p.folded) t.push(p);
    }
    return t;
  }

  nextIdx(fromIdx, filter) {
    for (let step = 1; step <= Config.PLAYER_COUNT; step++) {
      const i = ((fromIdx - 1 + step) % Config.PLAYER_COUNT) + 1;
      const p = this.players[i];
      if (p.alive && (!filter || filter(p))) return i;
    }
    return null;
  }

  // ---------------- 对局/回合开始 ----------------

  startGame() {
    this.log('═ 群雄穿越时空，齐聚决斗阵盘 ═', 'sys');
    this.delay(0.35, () => {
      for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
        this.emit('onQuote', i, this.players[i].hero.lines.enter);
      }
    });
    this.delay(2.4, () => this.startRound());
  }

  startRound() {
    if (this.gameOver) return;
    this.round++;
    const blinds = Config.getBlinds(this.round);

    this.actingIdx = 0;
    this.actionCursorIdx = 0;
    this.waitingIdx = null;

    this.deck = newShuffledDeck();
    this.board = [];
    for (let i = 0; i < 5; i++) this.board.push(draw(this.deck));
    this.revealed = 0;
    this.street = 'preflop';
    this.streetHadRaise = false;
    this.allInHandsRevealed = false;
    this.lastAggressiveWager = null;

    for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
      const p = this.players[i];
      p.roundStartHp = p.hp;
      p.hole = [];
      p.folded = !p.alive;
      p.allIn = false;
      p.betStreet = 0;
      p.betRound = 0;
      p.acted = false;
      p.lastActionBet = 0;
      p.lastAction = null;
      resetRoundSkillState(p);
      p.showdownInfo = null;
    }

    const nextDealer = this.nextIdx(this.dealerIdx);
    if (nextDealer) this.dealerIdx = nextDealer;

    this.emit('onRoundStart', this.round, blinds, this.dealerIdx);
    this.log(`── 第 ${this.round}/${Config.MAX_ROUNDS} 回合 · 血祭 ${blinds.sb}/${blinds.bb} ──`, 'sys');

    // 发令
    for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
      const p = this.players[i];
      if (p.alive) {
        p.hole = [draw(this.deck), draw(this.deck)];
        p.lastHandCategory = describe(p.hole).cat;
      }
    }
    dispatchSkillEvent(this, 'DEAL');
    this.emit('onDeal');

    // 血祭
    const headsUp = this.aliveCount() === 2;
    const sbIdx = headsUp ? this.dealerIdx : this.nextIdx(this.dealerIdx);
    const bbIdx = sbIdx ? this.nextIdx(sbIdx) : null;
    if (!sbIdx || !bbIdx) return;
    const sbPaid = this.commit(this.players[sbIdx], Math.min(blinds.sb, this.players[sbIdx].hp));
    const bbPaid = this.commit(this.players[bbIdx], Math.min(blinds.bb, this.players[bbIdx].hp));
    this.players[sbIdx].lastAction = {
      key: 'smallBlind', amount: sbPaid, street: this.street, round: this.round,
    };
    this.players[bbIdx].lastAction = {
      key: 'bigBlind', amount: bbPaid, street: this.street, round: this.round,
    };
    this.currentBet = blinds.bb;
    this.minRaiseInc = blinds.bb;
    this.streetRaiseCount = 0;
    this.emit('onBlindsPosted', sbIdx, blinds.sb, bbIdx, blinds.bb);
    this.log(`${this.players[sbIdx].hero.name} 献祭 ${blinds.sb}，${this.players[bbIdx].hero.name} 献祭 ${blinds.bb}`, 'info');

    this.actionCursorIdx = bbIdx;
    this.delay(1.4, () => this.proceedAction());
  }

  // ---------------- 灌注（下注）流程 ----------------

  commit(p, amount) {
    amount = Math.min(amount, p.hp);
    p.hp -= amount;
    p.betStreet += amount;
    p.betRound += amount;
    if (p.hp <= 0) {
      p.hp = 0;
      p.allIn = true;
    }
    this.emit('onHpChange', p.idx);
    return amount;
  }

  proceedAction() {
    if (this.gameOver) return;
    const active = this.activePlayers();
    if (active.length <= 1) {
      if (active.length === 1) this.awardUncontested(active[0]);
      return;
    }
    const needsAct = (p) =>
      !p.folded && !p.allIn && (!p.acted || p.betStreet < this.currentBet);
    if (!active.some(needsAct)) {
      this.advanceStreet();
      return;
    }
    const nextActor = this.nextIdx(this.actionCursorIdx, needsAct);
    if (!nextActor) {
      this.advanceStreet();
      return;
    }
    this.actionCursorIdx = nextActor;
    this.requestAction(this.players[nextActor]);
  }

  getOptions(p) {
    const toCall = Math.max(0, this.currentBet - p.betStreet);
    const callAmt = Math.min(toCall, p.hp);
    const pot = this.totalPot();
    const opts = {
      toCall,
      canCheck: toCall === 0,
      callAmt,
      allinAmt: p.hp,
      canRaise: !p.acted || this.currentBet - p.lastActionBet >= this.minRaiseInc,
      canAllIn: false,
      tiers: [],
    };
    opts.canAllIn = p.hp <= toCall || opts.canRaise;
    const seen = new Set();
    for (const tier of opts.canRaise ? Config.ATTACK_TIERS : []) {
      let inc = Config.roundAmount(pot * tier.ratio);
      if (inc < this.minRaiseInc) inc = Config.roundAmount(this.minRaiseInc);
      const cost = toCall + inc;
      if (cost < p.hp && !seen.has(cost)) {
        seen.add(cost);
        opts.tiers.push({ key: tier.key, name: tier.name, inc, cost });
      }
    }
    return opts;
  }

  requestAction(p) {
    this.actingIdx = p.idx;
    this.emit('onTurnStart', p.idx);
    if (p.isHuman) {
      this.waitingIdx = p.idx;
      this.emit('onAwaitAction', p.idx, this.getOptions(p));
    } else {
      this.delay(0.9 + Math.random() * 1.1, () => {
        if (this.gameOver || p.folded || !p.alive) {
          this.actingIdx = 0;
          this.proceedAction();
          return;
        }
        AI.maybeUseSkill(this, p);
        const act = AI.decide(this, p);
        this.applyAction(p, act);
      });
    }
  }

  /** 人类玩家行动入口（UI 调用） */
  playerAct(act) {
    if (!this.waitingIdx) return;
    const p = this.players[this.waitingIdx];
    this.waitingIdx = null;
    this.applyAction(p, act);
  }

  applyAction(p, act) {
    if (this.gameOver) return;
    this.actionCursorIdx = p.idx;
    const name = p.hero.name;
    const potBeforeAction = this.totalPot();
    const publicActionContext = {
      round: this.round,
      street: this.street,
      type: act.type,
      currentBetBefore: this.currentBet,
      betStreetBefore: p.betStreet,
      toCallBefore: Math.max(0, this.currentBet - p.betStreet),
      streetRaiseCountBefore: this.streetRaiseCount,
      potBefore: potBeforeAction,
    };
    const emitAction = (key, amount, isAggressive = false) => {
      p.lastAction = {
        key,
        amount: Number(amount) || 0,
        street: this.street,
        round: this.round,
      };
      // The action event snapshot represents a completed action. Keep the
      // private rotation cursor separately so reconnects never report the
      // previous player as still acting.
      this.actingIdx = 0;
      this.emit(
        'onAction',
        p.idx,
        key,
        amount,
        { ...publicActionContext, isAggressive },
      );
    };
    let actionGroup = 'defend';
    if (act.type === 'fold') {
      actionGroup = 'fold';
      p.folded = true;
      p.acted = true;
      p.lastActionBet = this.currentBet;
      emitAction('fold', 0);
      this.log(`${name} 退避`, 'fold');
    } else if (act.type === 'check') {
      p.acted = true;
      p.lastActionBet = this.currentBet;
      emitAction('check', 0);
      this.log(`${name} 静观`, 'info');
    } else if (act.type === 'call') {
      const pay = this.commit(p, Math.max(0, this.currentBet - p.betStreet));
      p.acted = true;
      p.lastActionBet = this.currentBet;
      emitAction('call', pay);
      this.log(`${name} 应战 ${pay}`, 'info');
    } else if (act.type === 'raise') {
      actionGroup = 'attack';
      this.streetHadRaise = true;
      p.skillData.raisedThisRound = true;
      const tier = act.tier;
      const toCall = Math.max(0, this.currentBet - p.betStreet);
      const pay = this.commit(p, toCall + tier.inc);
      this.currentBet = p.betStreet;
      this.minRaiseInc = tier.inc;
      this.streetRaiseCount++;
      p.acted = true;
      p.lastActionBet = this.currentBet;
      for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
        if (i !== p.idx) this.players[i].acted = false;
      }
      this.lastAggressiveWager = {
        actorIdx: p.idx,
        amount: pay,
        potBefore: potBeforeAction,
        ratio: potBeforeAction > 0 ? pay / potBeforeAction : 0,
      };
      emitAction(tier.key, pay, true);
      this.log(`${name} ${tier.name}！灌注 ${pay}`, 'raise');
    } else if (act.type === 'allin') {
      const raisesCurrentBet = p.betStreet + p.hp > this.currentBet;
      actionGroup = raisesCurrentBet ? 'attack' : 'defend';
      if (raisesCurrentBet) {
        this.streetHadRaise = true;
        p.skillData.raisedThisRound = true;
      }
      const pay = this.commit(p, p.hp);
      if (p.betStreet > this.currentBet) {
        const raiseAmt = p.betStreet - this.currentBet;
        const fullRaise = raiseAmt >= this.minRaiseInc;
        if (fullRaise) this.minRaiseInc = raiseAmt;
        this.currentBet = p.betStreet;
        this.streetRaiseCount++;
        if (fullRaise) {
          for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
            if (i !== p.idx) this.players[i].acted = false;
          }
        }
      }
      p.acted = true;
      p.lastActionBet = this.currentBet;
      if (raisesCurrentBet) {
        this.lastAggressiveWager = {
          actorIdx: p.idx,
          amount: pay,
          potBefore: potBeforeAction,
          ratio: potBeforeAction > 0 ? pay / potBeforeAction : 0,
        };
      }
      emitAction('allin', pay, raisesCurrentBet);
      this.emit('onQuote', p.idx, p.hero.lines.allin);
      this.log(`${name} 决死！押上全部 ${pay} 气血！`, 'allin');
    }
    dispatchSkillEvent(this, 'ACTION', {
      actor: p, type: act.type, group: actionGroup, activeCount: this.activePlayers().length,
    });
    this.delay(0.55, () => this.proceedAction());
  }

  // ---------------- 揭示天机 / 推进灌注轮 ----------------

  revealAllInHandsIfClosed() {
    if (this.allInHandsRevealed) return false;
    const entrants = this.activePlayers();
    if (entrants.length < 2 || !entrants.some((p) => p.allIn)) return false;
    const playersWithChips = entrants.filter((p) => !p.allIn);
    if (playersWithChips.length > 1) return false;
    this.allInHandsRevealed = true;
    this.emit('onAllInReveal', entrants);
    this.log(`决死行动封闭，${entrants.map((p) => p.hero.name).join('、')}公开暗令`, 'show');
    return true;
  }

  advanceStreet() {
    this.actingIdx = 0;
    this.actionCursorIdx = 0;
    this.waitingIdx = null;
    this.revealAllInHandsIfClosed();
    if (this.street !== 'river') {
      dispatchSkillEvent(this, 'STREET_ADVANCE', {
        from: this.street, hadRaise: this.streetHadRaise,
      });
    }
    for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
      const player = this.players[i];
      player.betStreet = 0;
      player.acted = false;
      player.lastActionBet = 0;
      if (!player.folded && !player.allIn) player.lastAction = null;
    }
    this.currentBet = 0;
    this.minRaiseInc = Config.getBlinds(this.round).bb;
    this.streetRaiseCount = 0;
    this.streetHadRaise = false;
    this.lastAggressiveWager = null;

    let nextStreet, revealTo;
    if (this.street === 'preflop') { nextStreet = 'flop'; revealTo = 3; }
    else if (this.street === 'flop') { nextStreet = 'turn'; revealTo = 4; }
    else if (this.street === 'turn') { nextStreet = 'river'; revealTo = 5; }
    else { this.showdown(); return; }

    const oldRevealed = this.revealed;
    this.street = nextStreet;
    this.revealed = revealTo;
    this.emit('onStreet', nextStreet, revealTo);
    const slotName = nextStreet === 'flop' ? '天时' : Config.BOARD_SLOT_NAMES[revealTo];
    this.log(`揭示【${slotName}】${this.boardTextNew(nextStreet)}`, 'sys');

    const changedIds = new Set();
    for (const p of this.activePlayers()) {
      const category = describe([p.hole[0], p.hole[1], ...this.revealedBoard()]).cat;
      if (category !== p.lastHandCategory) changedIds.add(p.idx);
      p.lastHandCategory = category;
    }
    const cards = this.board.slice(oldRevealed, revealTo);
    dispatchSkillEvent(this, 'BOARD_REVEALED', {
      street: nextStreet, cards, firstCard: cards[0], changedIds,
    });

    let canAct = 0;
    for (const p of this.activePlayers()) if (!p.allIn) canAct++;
    if (canAct <= 1) {
      this.delay(1.6, () => this.advanceStreet());
      return;
    }
    this.actionCursorIdx = this.dealerIdx;
    this.delay(1.5, () => this.proceedAction());
  }

  boardTextNew(street) {
    let s, e;
    if (street === 'flop') { s = 0; e = 2; }
    else if (street === 'turn') { s = 3; e = 3; }
    else { s = 4; e = 4; }
    const parts = [];
    for (let i = s; i <= e; i++) parts.push(cardText(this.board[i]));
    return parts.join(' ');
  }

  // ---------------- 夺池 / 亮招结算 ----------------

  awardUncontested(p) {
    this.actingIdx = 0;
    this.actionCursorIdx = 0;
    this.waitingIdx = null;
    const pot = this.totalPot();
    const netWinnings = {};
    for (const player of this.players.slice(1)) {
      const contribution = Math.max(0, Number(player.betRound) || 0);
      if (contribution > 0 || player.idx === p.idx) {
        netWinnings[player.idx] = (player.idx === p.idx ? pot : 0) - contribution;
      }
    }
    p.hp += pot;
    this.emit('onHpChange', p.idx);
    dispatchSkillEvent(this, 'UNCONTESTED_WIN', { winner: p });
    dispatchSkillEvent(this, 'ROUND_RESOLVED', { mode: 'uncontested', winner: p });
    this.emit('onPotAwarded', [p.idx], pot, true, 0, netWinnings);
    this.log(`${p.hero.name} 兵不血刃，净赢 ${netWinnings[p.idx]}`, 'win');
    this.delay(2.2, () => this.endRound());
  }

  showdown() {
    this.actingIdx = 0;
    this.actionCursorIdx = 0;
    this.waitingIdx = null;
    if (this.revealed < 5) {
      this.revealed = 5;
      this.emit('onStreet', 'river', 5);
    }

    const entrants = this.activePlayers();
    for (const p of entrants) {
      const seven = [p.hole[0], p.hole[1], ...this.board];
      const r = evalBest(seven);
      const info = Config.HAND_NAMES[r.cat];
      p.showdownInfo = { score: r.score, cat: r.cat, best5: r.best5, name: info.name };
      this.log(`${p.hero.name} 亮招：${info.name}（${info.poker}）`, 'show');
      p.energy++; // 参与亮招 +1⚡
      this.emit('onEnergyChange', p.idx);
    }

    const potLayers = this.buildPots(entrants);
    const pots = [];
    for (const layer of potLayers) {
      if (!layer.uncalledTo) {
        pots.push(layer);
        continue;
      }
      const owner = this.players[layer.uncalledTo];
      owner.hp += layer.amount;
      owner.betRound = Math.max(0, owner.betRound - layer.amount);
      owner.betStreet = Math.max(0, owner.betStreet - layer.amount);
      this.emit('onHpChange', owner.idx);
      this.log(`${owner.hero.name} 未被跟注的 ${layer.amount} 气血退回`, 'info');
    }

    const winnersAll = new Set();
    const wonAmount = {};
    const potResults = [];
    for (let potIdx = 0; potIdx < pots.length; potIdx++) {
      const pot = pots[potIdx];
      let best = -1;
      for (const p of pot.eligible) if (p.showdownInfo.score > best) best = p.showdownInfo.score;
      const winners = pot.eligible.filter((p) => p.showdownInfo.score === best);
      const share = Math.floor(pot.amount / winners.length);
      const remainder = pot.amount - share * winners.length;
      const awards = {};
      const oddChipOrder = [...winners].sort((a, b) => {
        const distanceA = (a.idx - this.dealerIdx + Config.PLAYER_COUNT) % Config.PLAYER_COUNT
          || Config.PLAYER_COUNT;
        const distanceB = (b.idx - this.dealerIdx + Config.PLAYER_COUNT) % Config.PLAYER_COUNT
          || Config.PLAYER_COUNT;
        return distanceA - distanceB;
      });
      oddChipOrder.forEach((p, wi) => {
        const award = share + (wi < remainder ? 1 : 0);
        awards[p.idx] = award;
        wonAmount[p.idx] = (wonAmount[p.idx] || 0) + award;
        winnersAll.add(p.idx);
      });
      const label = potIdx === 0 ? '主池' : `边池 ${potIdx}`;
      const netWinnings = {};
      for (const winner of winners) {
        netWinnings[winner.idx] = awards[winner.idx] - (pot.contributionById[winner.idx] || 0);
      }
      const winnerNames = winners.map((p) =>
        `${p.hero.name}（净赢 ${netWinnings[p.idx]}）`).join('、');
      this.log(`${label} ${pot.amount} → ${winnerNames}`, 'win');
      potResults.push({
        label, amount: pot.amount,
        eligibleIds: pot.eligible.map((p) => p.idx),
        winnerIds: winners.map((p) => p.idx),
        awards, netWinnings,
      });
    }

    // 血池严格按德州扑克主池/边池结果入账，技能不得修改分配。
    for (const p of entrants) {
      const amt = wonAmount[p.idx];
      if (amt && amt > 0) {
        p.hp += amt;
        this.emit('onHpChange', p.idx);
      }
    }

    const entrantIds = new Set(entrants.map((p) => p.idx));
    dispatchSkillEvent(this, 'SHOWDOWN_RESULT', {
      entrants, entrantIds, winnerIds: winnersAll, wonAmount,
    });
    dispatchSkillEvent(this, 'ROUND_RESOLVED', { mode: 'showdown', winnerIds: winnersAll });

    const netResult = {};
    for (const p of this.players.slice(1)) {
      const contribution = Math.max(0, Number(p.betRound) || 0);
      const award = Math.max(0, Number(wonAmount[p.idx]) || 0);
      if (contribution > 0 || award > 0) netResult[p.idx] = award - contribution;
    }

    this.emit('onShowdown', {
      entrants,
      wonAmount,
      netResult,
      totalPot: pots.reduce((sum, pot) => sum + pot.amount, 0),
      pots: potResults,
    });
    for (const [idx, net] of Object.entries(netResult)) {
      if (net > 0) this.log(`${this.players[Number(idx)].hero.name} 本回合净赢 ${net}`, 'win');
    }

    this.delay(3.6, () => this.endRound());
  }

  /** 按投入逐层剥离，并合并可争夺资格相同的相邻层。 */
  buildPots(entrants, options = {}) {
    const contribs = options.contribs || Object.fromEntries(
      this.players.slice(1).map((player) => [player.idx, player.betRound]),
    );
    const levels = options.levels || [...new Set(
      Object.values(contribs).filter((v) => v > 0),
    )].sort((a, b) => a - b);

    const pots = [];
    const appendLayer = (layer) => {
      const previous = pots[pots.length - 1];
      const sameUncalledOwner = layer.uncalledTo
        && previous?.uncalledTo === layer.uncalledTo;
      const eligibleKey = layer.eligible.map((player) => player.idx).sort((a, b) => a - b).join(',');
      const previousEligibleKey = previous && !previous.uncalledTo
        ? previous.eligible.map((player) => player.idx).sort((a, b) => a - b).join(',')
        : null;
      const sameContenders = !layer.uncalledTo && previous && !previous.uncalledTo
        && eligibleKey === previousEligibleKey;
      if (!sameUncalledOwner && !sameContenders) {
        pots.push(layer);
        return;
      }

      previous.amount += layer.amount;
      previous.contributorIds = [...new Set([
        ...previous.contributorIds, ...layer.contributorIds,
      ])].sort((a, b) => a - b);
      for (const [idx, amount] of Object.entries(layer.contributionById)) {
        previous.contributionById[idx] = (previous.contributionById[idx] || 0) + amount;
      }
    };

    let prev = 0;
    for (const level of levels) {
      const contributionById = {};
      for (const [idx, contribution] of Object.entries(contribs)) {
        const amount = Math.max(0, Math.min(contribution, level) - prev);
        if (amount > 0) contributionById[idx] = amount;
      }
      const contributorIds = Object.keys(contributionById).map(Number);
      const amt = Object.values(contributionById).reduce((sum, amount) => sum + amount, 0);
      const eligible = entrants.filter((p) => p.betRound >= level);
      if (amt > 0 && contributorIds.length === 1) {
        appendLayer({
          amount: amt, eligible: [], contributorIds, contributionById,
          uncalledTo: contributorIds[0],
        });
      } else if (amt > 0 && eligible.length > 0) {
        appendLayer({ amount: amt, eligible, contributorIds, contributionById, uncalledTo: null });
      }
      prev = level;
    }
    return pots;
  }

  // ---------------- 回合结束 / 终局 ----------------

  endRound() {
    if (this.gameOver) return;
    this.actingIdx = 0;
    this.actionCursorIdx = 0;
    this.waitingIdx = null;
    dispatchSkillEvent(this, 'ROUND_END', { round: this.round });
    for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
      const p = this.players[i];
      if (p.alive && p.hp <= 0) {
        p.alive = false;
        p.deathRound = this.round;
        p.deathOrder = ++this.deathCounter;
        this.emit('onDeath', i);
        this.emit('onQuote', i, p.hero.lines.die);
        this.log(`☠ ${p.hero.name} 气血耗尽，阵亡！`, 'death');
      }
    }
    this.emit('onRoundEnd', this.round);

    const humanEliminated = this.endWhenHumanEliminated
      && this.players.slice(1).some((p) => p.isHuman && !p.alive);
    if (humanEliminated || this.round >= Config.MAX_ROUNDS || this.aliveCount() < 2) {
      this.delay(1.6, () => this.doGameOver());
    } else {
      this.delay(1.6, () => this.startRound());
    }
  }

  doGameOver() {
    if (this.gameOver) return;
    this.gameOver = true;
    this.actingIdx = 0;
    this.actionCursorIdx = 0;
    this.waitingIdx = null;
    const ranking = this.players.slice(1);
    ranking.sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (a.alive) return b.hp - a.hp;
      return (b.deathOrder || 0) - (a.deathOrder || 0);
    });
    this.emit('onGameOver', ranking);
    this.log(`═ 决斗落幕 · ${ranking[0].hero.name} 傲视群雄 ═`, 'sys');
  }

  // ---------------- 延时购买 ----------------

  extendTime(idx) {
    const p = this.players[idx];
    if (p.energy >= Config.EXTEND_COST) {
      p.energy -= Config.EXTEND_COST;
      this.emit('onEnergyChange', idx);
      this.log(`${p.hero.name} 消耗1⚡延长思考时间`, 'info');
      return true;
    }
    return false;
  }

  // ---------------- 技能系统 ----------------

  canUseSkill(idx) {
    const p = this.players[idx];
    return getSkillAvailability(this, p).ok;
  }

  skillAvailability(idx) {
    return getSkillAvailability(this, this.players[idx]);
  }

  getSkillPrompt(idx) {
    return getSkillInput(this, this.players[idx]);
  }

  useSkill(idx, selection = null) {
    return executeActiveSkill(this, this.players[idx], selection);
  }
}
