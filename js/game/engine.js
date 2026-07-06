// ============================================================================
// engine.js - 群英决 规则引擎（德州扑克内核 · 世界观包装）
// 与 Maker 版 Engine.lua 一一对应：
// 回合流程：发令 → 血祭 → 四轮灌注（暗令/天时/地利/人和）→ 亮招 → 结算
// 通过 listeners 回调驱动 UI，内部用延时队列编排演出节奏（由 update(dt) 驱动）
// ============================================================================

import * as Config from './config.js';
import { newShuffledDeck, draw, shuffle } from './deck.js';
import { evalBest } from './handeval.js';
import { getHero, HEROES, checkCondition, dealPassiveEnergy } from './heroes.js';
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
   */
  constructor(heroIds, listeners, humanSeats = null, names = {}) {
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
        skillUsed: false,
        qihuo: false,
        jianbi: false,
        deathRound: null,
        deathOrder: null,
        peekCard: null,
        spied: null,
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
    this.actingIdx = 0;
    this.waitingIdx = null;
    this.raiseBan = false;
    this.raiseBanSource = 0;
    this.deathCounter = 0;
    this.gameOver = false;

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

    this.deck = newShuffledDeck();
    this.board = [];
    for (let i = 0; i < 5; i++) this.board.push(draw(this.deck));
    this.revealed = 0;
    this.street = 'preflop';
    this.raiseBan = false;
    this.raiseBanSource = 0;

    for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
      const p = this.players[i];
      p.hole = [];
      p.folded = !p.alive;
      p.allIn = false;
      p.betStreet = 0;
      p.betRound = 0;
      p.acted = false;
      p.skillUsed = false;
      p.qihuo = false;
      p.jianbi = false;
      p.peekCard = null;
      p.spied = null;
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
        const gain = dealPassiveEnergy(p.hero.id, p.hole);
        if (gain > 0) {
          p.energy += gain;
          this.emit('onEnergyChange', i);
          this.log(`${p.hero.name} 被动触发 +${gain}⚡`, 'skill');
        }
      }
    }
    this.emit('onDeal');

    // 血祭
    const sbIdx = this.nextIdx(this.dealerIdx);
    const bbIdx = sbIdx ? this.nextIdx(sbIdx) : null;
    if (!sbIdx || !bbIdx) return;
    this.commit(this.players[sbIdx], Math.min(blinds.sb, this.players[sbIdx].hp));
    this.commit(this.players[bbIdx], Math.min(blinds.bb, this.players[bbIdx].hp));
    this.currentBet = blinds.bb;
    this.minRaiseInc = blinds.bb;
    this.emit('onBlindsPosted', sbIdx, blinds.sb, bbIdx, blinds.bb);
    this.log(`${this.players[sbIdx].hero.name} 献祭 ${blinds.sb}，${this.players[bbIdx].hero.name} 献祭 ${blinds.bb}`, 'info');

    this.actingIdx = bbIdx;
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
    const nextActor = this.nextIdx(this.actingIdx, needsAct);
    if (!nextActor) {
      this.advanceStreet();
      return;
    }
    this.actingIdx = nextActor;
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
      tiers: [],
    };
    const banned = this.raiseBan && p.idx !== this.raiseBanSource;
    if (!banned) {
      const seen = new Set();
      for (const tier of Config.ATTACK_TIERS) {
        let inc = Config.roundAmount(pot * tier.ratio);
        if (inc < this.minRaiseInc) inc = Config.roundAmount(this.minRaiseInc);
        const cost = toCall + inc;
        if (cost < p.hp && !seen.has(cost)) {
          seen.add(cost);
          opts.tiers.push({ key: tier.key, name: tier.name, inc, cost });
        }
      }
    }
    return opts;
  }

  requestAction(p) {
    this.emit('onTurnStart', p.idx);
    if (p.isHuman) {
      this.waitingIdx = p.idx;
      this.emit('onAwaitAction', p.idx, this.getOptions(p));
    } else {
      this.delay(0.9 + Math.random() * 1.1, () => {
        if (this.gameOver || p.folded || !p.alive) {
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
    const name = p.hero.name;
    if (act.type === 'fold') {
      p.folded = true;
      p.acted = true;
      this.emit('onAction', p.idx, 'fold', 0);
      this.log(`${name} 退避`, 'fold');
    } else if (act.type === 'check') {
      p.acted = true;
      this.emit('onAction', p.idx, 'check', 0);
      this.log(`${name} 静观`, 'info');
    } else if (act.type === 'call') {
      const pay = this.commit(p, Math.max(0, this.currentBet - p.betStreet));
      p.acted = true;
      this.emit('onAction', p.idx, 'call', pay);
      this.log(`${name} 应战 ${pay}`, 'info');
    } else if (act.type === 'raise') {
      const tier = act.tier;
      const toCall = Math.max(0, this.currentBet - p.betStreet);
      const pay = this.commit(p, toCall + tier.inc);
      this.currentBet = p.betStreet;
      this.minRaiseInc = tier.inc;
      p.acted = true;
      for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
        if (i !== p.idx) this.players[i].acted = false;
      }
      this.emit('onAction', p.idx, tier.key, pay);
      this.log(`${name} ${tier.name}！灌注 ${pay}`, 'raise');
    } else if (act.type === 'allin') {
      const pay = this.commit(p, p.hp);
      if (p.betStreet > this.currentBet) {
        const raiseAmt = p.betStreet - this.currentBet;
        if (raiseAmt >= this.minRaiseInc) this.minRaiseInc = raiseAmt;
        this.currentBet = p.betStreet;
        for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
          if (i !== p.idx) this.players[i].acted = false;
        }
      }
      p.acted = true;
      this.emit('onAction', p.idx, 'allin', pay);
      this.emit('onQuote', p.idx, p.hero.lines.allin);
      this.log(`${name} 决死！押上全部 ${pay} 气血！`, 'allin');
    }
    this.delay(0.55, () => this.proceedAction());
  }

  // ---------------- 揭示天机 / 推进灌注轮 ----------------

  advanceStreet() {
    for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
      this.players[i].betStreet = 0;
      this.players[i].acted = false;
    }
    this.currentBet = 0;
    this.minRaiseInc = Config.getBlinds(this.round).bb;
    this.raiseBan = false;
    this.raiseBanSource = 0;

    let nextStreet, revealTo;
    if (this.street === 'preflop') { nextStreet = 'flop'; revealTo = 3; }
    else if (this.street === 'flop') { nextStreet = 'turn'; revealTo = 4; }
    else if (this.street === 'turn') { nextStreet = 'river'; revealTo = 5; }
    else { this.showdown(); return; }

    this.street = nextStreet;
    this.revealed = revealTo;
    this.emit('onStreet', nextStreet, revealTo);
    const slotName = nextStreet === 'flop' ? '天时' : Config.BOARD_SLOT_NAMES[revealTo];
    this.log(`揭示【${slotName}】${this.boardTextNew(nextStreet)}`, 'sys');

    let canAct = 0;
    for (const p of this.activePlayers()) if (!p.allIn) canAct++;
    if (canAct <= 1) {
      this.delay(1.6, () => this.advanceStreet());
      return;
    }
    this.actingIdx = this.dealerIdx;
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
    const pot = this.totalPot();
    let bonus = 0;
    if (p.hero.id === 'lvbuwei') {
      const ratio = Config.LBW_PASSIVE_BONUS + (p.qihuo ? Config.LBW_ACTIVE_BONUS : 0);
      bonus = Config.roundAmount(pot * ratio);
    }
    if (p.hero.id === 'xiangyu') {
      p.energy++;
      this.emit('onEnergyChange', p.idx);
      this.log('项羽 被动【不亮招夺池】+1⚡', 'skill');
    }
    p.hp += pot + bonus;
    this.emit('onHpChange', p.idx);
    this.emit('onPotAwarded', [p.idx], pot, true, bonus);
    this.log(`${p.hero.name} 兵不血刃，夺池 ${pot}${bonus > 0 ? `（+${bonus} 经营加成）` : ''}`, 'win');
    this.delay(2.2, () => this.endRound());
  }

  showdown() {
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

    const pots = this.buildPots(entrants);

    const winnersAll = new Set();
    const wonAmount = {};
    for (const pot of pots) {
      let best = -1;
      for (const p of pot.eligible) if (p.showdownInfo.score > best) best = p.showdownInfo.score;
      const winners = pot.eligible.filter((p) => p.showdownInfo.score === best);
      const share = Math.floor(pot.amount / winners.length);
      const remainder = pot.amount - share * winners.length;
      winners.forEach((p, wi) => {
        wonAmount[p.idx] = (wonAmount[p.idx] || 0) + share + (wi === 0 ? remainder : 0);
        winnersAll.add(p.idx);
      });
    }

    // 系统注入加成（吕不韦）与入账
    for (const p of entrants) {
      const amt = wonAmount[p.idx];
      if (amt && amt > 0) {
        let bonus = 0;
        if (p.hero.id === 'lvbuwei') {
          const ratio = Config.LBW_PASSIVE_BONUS + (p.qihuo ? Config.LBW_ACTIVE_BONUS : 0);
          bonus = Config.roundAmount(amt * ratio);
          if (bonus > 0) this.log(`吕不韦 经营有道，额外+${bonus} 气血`, 'skill');
        }
        p.hp += amt + bonus;
        wonAmount[p.idx] = amt + bonus;
        this.emit('onHpChange', p.idx);
      }
    }

    // 败者被动与坚壁返还
    for (const p of entrants) {
      if (!winnersAll.has(p.idx)) {
        if (p.hero.id === 'lianpo') {
          p.energy++;
          this.emit('onEnergyChange', p.idx);
          this.log('廉颇 被动【亮招落败】+1⚡', 'skill');
        }
        if (p.jianbi) {
          const refund = Config.roundAmount(p.betRound * Config.LP_REFUND_RATIO);
          if (refund > 0) {
            p.hp += refund;
            this.emit('onHpChange', p.idx);
            this.log(`${p.hero.name}【坚壁】生效，返还 ${refund} 气血`, 'skill');
          }
        }
      } else if (p.hero.id === 'diaochan') {
        p.energy++;
        this.emit('onEnergyChange', p.idx);
        this.log('貂蝉 被动【亮招获胜】+1⚡', 'skill');
      }
    }

    this.emit('onShowdown', {
      entrants,
      wonAmount,
      totalPot: this.totalPot(),
    });
    for (const [idx, amt] of Object.entries(wonAmount)) {
      this.log(`${this.players[Number(idx)].hero.name} 夺得血池 ${amt}`, 'win');
    }

    this.delay(3.6, () => this.endRound());
  }

  /** 构建主池与边池（按参战者投入分层，支持决死边池） */
  buildPots(entrants) {
    const contribs = {};
    for (let i = 1; i <= Config.PLAYER_COUNT; i++) {
      contribs[i] = this.players[i].betRound;
    }
    const levels = [...new Set(entrants.map((p) => p.betRound).filter((v) => v > 0))].sort((a, b) => a - b);

    const pots = [];
    let prev = 0;
    for (const level of levels) {
      let amt = 0;
      for (const c of Object.values(contribs)) {
        const seg = Math.min(c, level) - Math.min(c, prev);
        if (seg > 0) amt += seg;
      }
      const eligible = entrants.filter((p) => p.betRound >= level);
      if (amt > 0 && eligible.length > 0) pots.push({ amount: amt, eligible });
      prev = level;
    }
    return pots;
  }

  // ---------------- 回合结束 / 终局 ----------------

  endRound() {
    if (this.gameOver) return;
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

    if (this.round >= Config.MAX_ROUNDS || this.aliveCount() < 2) {
      this.delay(1.6, () => this.doGameOver());
    } else {
      this.delay(1.6, () => this.startRound());
    }
  }

  doGameOver() {
    if (this.gameOver) return;
    this.gameOver = true;
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
    if (this.gameOver || !p.alive || p.folded || p.skillUsed) return false;
    if (this.street === 'idle') return false;
    if (p.energy < p.hero.skillCost) return false;
    return checkCondition(p.hero.id, p.hole);
  }

  useSkill(idx, extra = null) {
    if (!this.canUseSkill(idx)) return false;
    const p = this.players[idx];
    const heroId = p.hero.id;
    p.energy -= p.hero.skillCost;
    p.skillUsed = true;
    this.emit('onEnergyChange', idx);
    this.emit('onSkill', idx, p.hero.skillName);
    this.emit('onQuote', idx, p.hero.lines.skill);
    this.log(`${p.hero.name} 发动【${p.hero.skillName}】！`, 'skill');

    if (heroId === 'zhugeliang') {
      if (this.revealed < 5) {
        const nextCard = this.board[this.revealed];
        p.peekCard = nextCard;
        if (p.isHuman) this.emit('onPeek', idx, nextCard, this.revealed + 1);
      }
    } else if (heroId === 'diaochan') {
      const targets = this.activePlayers().filter((q) => q.idx !== idx);
      if (targets.length > 0) {
        const target = targets[Math.floor(Math.random() * targets.length)];
        const cardIdx = 1 + Math.floor(Math.random() * 2);
        p.spied = { targetIdx: target.idx, cardIdx, card: target.hole[cardIdx - 1] };
        if (p.isHuman) this.emit('onSpy', idx, target.idx, cardIdx, target.hole[cardIdx - 1]);
      }
    } else if (heroId === 'hanxin') {
      let cardIdx = extra && extra.cardIdx;
      if (!cardIdx) cardIdx = p.hole[0].rank <= p.hole[1].rank ? 1 : 2;
      p.hole[cardIdx - 1] = draw(this.deck);
      this.emit('onHoleChange', idx);
    } else if (heroId === 'xiangyu') {
      this.raiseBan = true;
      this.raiseBanSource = idx;
      if (this.waitingIdx) {
        const hp2 = this.players[this.waitingIdx];
        this.emit('onAwaitAction', hp2.idx, this.getOptions(hp2));
      }
    } else if (heroId === 'lvbuwei') {
      p.qihuo = true;
    } else if (heroId === 'lianpo') {
      p.jianbi = true;
    }
    return true;
  }
}
