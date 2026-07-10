// ============================================================================
// ai.js - GTO-inspired 六人桌策略
// 使用公开信息、位置、有效筹码、底池赔率、SPR 与混合频率决策；不读取对手暗牌。
// 这不是离线 CFR 求解表，而是为本游戏动作抽象设计的均衡近似层。
// ============================================================================

import * as Config from './config.js';
import * as WinRate from './winrate.js';

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

function styleOf(player) {
  return player.style || Config.AI_STYLES.find((style) => style.key === 'tag') || {
    looseness: 0, aggression: 0, bluffFactor: 1,
  };
}

/** 0~1 的起手牌质量，用于多人桌开池/跟注/再加注范围。 */
export function preflopStrength(hole) {
  if (!hole || hole.length < 2) return 0;
  const [first, second] = hole;
  const high = Math.max(first.rank, second.rank);
  const low = Math.min(first.rank, second.rank);
  if (high === low) return clamp(0.48 + ((high - 2) / 12) * 0.50);

  const suited = first.suit === second.suit;
  const gap = high - low - 1;
  let score = 0.05 + (high / 14) * 0.34 + (low / 14) * 0.22;
  if (suited) score += 0.08;
  if (gap <= 0) score += 0.07;
  else if (gap === 1) score += 0.05;
  else if (gap === 2) score += 0.02;
  else if (gap >= 4) score -= 0.04;
  if (high >= 11 && low >= 10) score += 0.08;
  if (high === 14) score += 0.04;
  return clamp(score);
}

/** 按按钮、盲位、前位到后位给开池范围做小幅修正。 */
export function positionAdjustment(engine, player) {
  const alive = engine.players.slice(1).filter((candidate) => candidate.alive);
  if (alive.length <= 2) return player.idx === engine.dealerIdx ? 0.08 : 0;
  const dealerPos = alive.findIndex((candidate) => candidate.idx === engine.dealerIdx);
  const playerPos = alive.findIndex((candidate) => candidate.idx === player.idx);
  if (dealerPos < 0 || playerPos < 0) return 0;
  const distance = (playerPos - dealerPos + alive.length) % alive.length;
  if (distance === 0) return 0.08; // BTN
  if (distance === 1) return 0.02; // SB
  if (distance === 2) return 0; // BB
  if (distance === alive.length - 1) return 0.045; // CO
  if (distance === alive.length - 2) return -0.005; // HJ / MP
  return -0.05; // UTG / EP
}

export function effectiveStack(engine, player) {
  const opponents = engine.activePlayers().filter((candidate) => candidate.idx !== player.idx);
  const largestOpponent = Math.max(0, ...opponents.map((candidate) => candidate.hp + candidate.betStreet));
  return Math.min(player.hp + player.betStreet, largestOpponent || player.hp + player.betStreet);
}

export function drawProfile(hole, board) {
  if (!board.length) {
    return {
      potential: 0, blocker: false, wetness: 0,
      flushDraw: false, straightDraw: false, overcards: 0,
    };
  }
  const cards = [...hole, ...board];
  const suitCounts = [0, 0, 0, 0, 0];
  for (const card of cards) suitCounts[card.suit]++;
  const flushDraw = board.length < 5 && suitCounts.some((count, suit) =>
    count === 4 && hole.some((card) => card.suit === suit));

  const ranks = new Set(cards.map((card) => card.rank));
  if (ranks.has(14)) ranks.add(1);
  let straightDraw = false;
  for (let low = 1; low <= 10; low++) {
    let present = 0;
    for (let rank = low; rank < low + 5; rank++) if (ranks.has(rank)) present++;
    if (present === 4 && board.length < 5) straightDraw = true;
  }

  const maxBoard = Math.max(...board.map((card) => card.rank));
  const overcards = hole.filter((card) => card.rank > maxBoard).length;
  const boardSuitMax = Math.max(...[1, 2, 3, 4].map((suit) =>
    board.filter((card) => card.suit === suit).length));
  const sortedBoard = [...new Set(board.map((card) => card.rank))].sort((a, b) => a - b);
  let closeRanks = 0;
  for (let i = 1; i < sortedBoard.length; i++) {
    if (sortedBoard[i] - sortedBoard[i - 1] <= 2) closeRanks++;
  }
  const blocker = hole.some((card) => card.rank === 14 && suitCounts[card.suit] >= 3)
    || hole.some((card) => card.rank >= 13 && card.suit === board[0]?.suit);
  return {
    potential: (flushDraw ? 1 : 0) + (straightDraw ? 0.75 : 0) + overcards * 0.15,
    blocker,
    wetness: clamp((boardSuitMax - 1) * 0.22 + closeRanks * 0.16),
    flushDraw,
    straightDraw,
    overcards,
  };
}

function tierAt(opts, index) {
  if (!opts.tiers.length) return null;
  return opts.tiers[Math.max(0, Math.min(index, opts.tiers.length - 1))];
}

function raiseAction(opts, size = 'medium') {
  const index = size === 'small' ? 0 : size === 'large' ? opts.tiers.length - 1 : 1;
  const tier = tierAt(opts, index);
  return tier ? { type: 'raise', tier } : null;
}

function decidePreflop(engine, player, opts, style) {
  const strength = preflopStrength(player.hole);
  const position = positionAdjustment(engine, player);
  const adjusted = clamp(strength + position + style.looseness);
  const blinds = Config.getBlinds(engine.round);
  const stackBb = effectiveStack(engine, player) / Math.max(1, blinds.bb);
  const potOdds = opts.toCall / Math.max(1, engine.totalPot() + opts.toCall);
  const raised = (engine.streetRaiseCount || 0) > 0 || engine.currentBet > blinds.bb;

  if (!raised) {
    const openThreshold = 0.68;
    const shoveThreshold = stackBb <= 8 ? 0.55 : stackBb <= 12 ? 0.64 : stackBb <= 18 ? 0.74 : 0.91;
    if (adjusted >= shoveThreshold && opts.canAllIn && stackBb <= 18) return { type: 'allin' };
    if (adjusted >= openThreshold && opts.tiers.length) {
      const raiseFrequency = clamp(0.66 + (adjusted - openThreshold) * 1.5 + style.aggression, 0.55, 0.96);
      if (Math.random() < raiseFrequency) return raiseAction(opts, adjusted > 0.88 ? 'medium' : 'small');
    }
    if (opts.toCall <= 0) return { type: 'check' };
    if (adjusted >= openThreshold - 0.08 && potOdds <= 0.34) return { type: 'call' };
    return { type: 'fold' };
  }

  const pressure = Math.max(0, (engine.streetRaiseCount || 1) - 1) * 0.04;
  const threeBetThreshold = 0.82 + pressure;
  const callThreshold = 0.64 + pressure;
  const reshoveThreshold = stackBb <= 10 ? 0.68 : stackBb <= 18 ? 0.78 : 0.93;
  if (adjusted >= reshoveThreshold && opts.canAllIn && stackBb <= 32) return { type: 'allin' };
  if (adjusted >= threeBetThreshold && opts.tiers.length) {
    const size = stackBb < 28 || engine.streetRaiseCount > 1 ? 'large' : 'medium';
    return raiseAction(opts, size);
  }

  const pair = player.hole[0].rank === player.hole[1].rank;
  const setMine = pair && opts.toCall <= effectiveStack(engine, player) * 0.055;
  const suitedAce = player.hole[0].suit === player.hole[1].suit
    && (player.hole[0].rank === 14 || player.hole[1].rank === 14);
  const bluffThreeBet = suitedAce && adjusted >= 0.58 && opts.tiers.length
    && Math.random() < 0.055 * style.bluffFactor;
  if (bluffThreeBet) return raiseAction(opts, 'large');
  if ((adjusted >= callThreshold || setMine) && potOdds <= 0.38) return { type: 'call' };
  if (opts.toCall >= player.hp && adjusted >= Math.max(0.82, potOdds + 0.18)) return { type: 'call' };
  return { type: 'fold' };
}

/** 条件满足时按费用、阶段和剩余能量决定是否发动技能。 */
export function maybeUseSkill(engine, player) {
  const availability = engine.skillAvailability(player.idx);
  if (!availability.ok) return;
  const reservePenalty = player.energy - availability.cost <= 0 ? 0.18 : 0;
  const lateBonus = engine.street === 'turn' || engine.street === 'river' ? 0.12 : 0;
  const probability = clamp(Config.AI_SKILL_RATE + lateBonus - reservePenalty, 0.25, 0.86);
  if (Math.random() < probability) engine.useSkill(player.idx);
}

/** 决策主入口 → { type, tier? } */
export function decide(engine, player) {
  const style = styleOf(player);
  const opts = engine.getOptions(player);
  if (engine.street === 'preflop') return decidePreflop(engine, player, opts, style);

  const activeCount = engine.activePlayers().length;
  const numOpp = Math.max(1, activeCount - 1);
  const equity = WinRate.estimate(
    player.hole, engine.revealedBoard(), numOpp, Config.AI_SIMS,
  );
  const pot = Math.max(1, engine.totalPot());
  const potOdds = opts.toCall / Math.max(1, pot + opts.toCall);
  const spr = effectiveStack(engine, player) / pot;
  const position = positionAdjustment(engine, player);
  const draws = drawProfile(player.hole, engine.revealedBoard());
  const river = engine.street === 'river';
  const riskPremium = (numOpp - 1) * 0.018 - style.looseness * 0.25;
  const realizedEquity = clamp(equity + (!river ? draws.potential * 0.018 : 0) + position * 0.08);
  const valueThreshold = clamp(0.64 - (numOpp - 1) * 0.035 - style.looseness * 0.35, 0.45, 0.66);
  const strongThreshold = clamp(0.80 - (numOpp - 1) * 0.03, 0.64, 0.82);

  if (opts.toCall > 0) {
    if (realizedEquity >= strongThreshold && opts.tiers.length) {
      if (opts.canAllIn && (spr <= 1.05 || (river && equity >= 0.90))) return { type: 'allin' };
      if (Math.random() < clamp(0.68 + style.aggression, 0.5, 0.9)) {
        return raiseAction(opts, equity >= strongThreshold + 0.10 ? 'large' : 'medium');
      }
    }

    const semiBluffFrequency = (0.16 + style.aggression) * style.bluffFactor / Math.sqrt(numOpp);
    if (!river && draws.potential >= 0.75 && opts.tiers.length
      && realizedEquity >= potOdds - 0.04 && Math.random() < semiBluffFrequency) {
      return raiseAction(opts, draws.wetness > 0.55 ? 'large' : 'medium');
    }
    if (river && draws.blocker && numOpp === 1 && opts.tiers.length
      && equity < potOdds && Math.random() < 0.055 * style.bluffFactor) {
      return raiseAction(opts, 'large');
    }

    if (realizedEquity >= potOdds + riskPremium) return { type: 'call' };
    if (opts.toCall >= player.hp && realizedEquity >= potOdds + riskPremium - 0.02) {
      return { type: 'call' };
    }
    return { type: 'fold' };
  }

  if (realizedEquity >= valueThreshold && opts.tiers.length) {
    const betFrequency = clamp(0.64 + (realizedEquity - valueThreshold) + style.aggression, 0.52, 0.92);
    if (Math.random() < betFrequency) {
      if (opts.canAllIn && spr <= 0.72 && realizedEquity >= strongThreshold) return { type: 'allin' };
      const size = realizedEquity >= strongThreshold + 0.08
        ? 'large' : draws.wetness > 0.55 ? 'medium' : 'small';
      return raiseAction(opts, size);
    }
  }

  const semiBluffFrequency = (0.20 + style.aggression) * style.bluffFactor / Math.sqrt(numOpp);
  if (!river && draws.potential >= 0.75 && opts.tiers.length
    && Math.random() < semiBluffFrequency) {
    return raiseAction(opts, draws.wetness > 0.55 ? 'medium' : 'small');
  }
  const stabFrequency = 0.055 * style.bluffFactor * (position > 0 ? 1.3 : 1) / numOpp;
  if (opts.tiers.length && Math.random() < stabFrequency) return raiseAction(opts, 'small');
  return { type: 'check' };
}
