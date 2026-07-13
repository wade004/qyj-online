// ============================================================================
// ai-policy.js - 2~9 人桌的纯策略计算
//
// 该模块不读取 Engine，也不持有任何隐藏状态。调用方必须传入脱敏观察、
// 范围权益和合法动作。输出是一个混合策略及采样后的动作。
// ============================================================================

import { describe, evalBest } from './handeval.js';

export const MAX_SUPPORTED_PLAYERS = 9;

// Frozen exact-root calibration binds to this token. Any material change to
// the range/equity policy must bump it so stale evidence fails closed.
export const QYJ_BASE_POLICY_CONTRACT = 'qyj-range-ev-v1';

export const clamp = (value, min = 0, max = 1) =>
  Math.max(min, Math.min(max, Number(value) || 0));

const RANK_LABELS = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T' };

function cardId(card) {
  return card ? (card.suit - 1) * 13 + (card.rank - 2) : -1;
}

/** 稳定的翻前牌力排序分；只用于范围百分位，不冒充精确 all-in equity。 */
export function preflopStrength(hole) {
  if (!hole || hole.length < 2) return 0;
  const [first, second] = hole;
  const high = Math.max(first.rank, second.rank);
  const low = Math.min(first.rank, second.rank);
  if (high === low) {
    const normalized = (high - 2) / 12;
    return clamp(0.50 + 0.50 * Math.pow(normalized, 0.72));
  }

  const suited = first.suit === second.suit;
  const gap = high - low - 1;
  let score = 0.035 + (high / 14) * 0.36 + (low / 14) * 0.235;
  if (suited) score += 0.075;
  if (gap <= 0) score += 0.075;
  else if (gap === 1) score += 0.052;
  else if (gap === 2) score += 0.022;
  else if (gap === 3) score -= 0.012;
  else score -= 0.052;
  if (high >= 11 && low >= 10) score += 0.105;
  if (high === 14) score += low >= 10 ? 0.085 : 0.035;
  if (low <= 5 && high <= 8 && gap <= 1) score += suited ? 0.025 : -0.015;
  return clamp(score);
}

let preflopScoreDistribution;

function allPreflopScores() {
  if (preflopScoreDistribution) return preflopScoreDistribution;
  const deck = [];
  for (let suit = 1; suit <= 4; suit++) {
    for (let rank = 2; rank <= 14; rank++) deck.push({ rank, suit });
  }
  const scores = [];
  for (let i = 0; i < deck.length - 1; i++) {
    for (let j = i + 1; j < deck.length; j++) {
      scores.push(preflopStrength([deck[i], deck[j]]));
    }
  }
  scores.sort((a, b) => a - b);
  preflopScoreDistribution = scores;
  return scores;
}

/** 0~1；1 表示最顶端组合，0.84 大致表示前 16% 组合。 */
export function preflopPercentile(hole) {
  const score = preflopStrength(hole);
  const scores = allPreflopScores();
  let lo = 0;
  let hi = scores.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (scores[mid] <= score) lo = mid + 1;
    else hi = mid;
  }
  return lo / scores.length;
}

export function preflopHandLabel(hole) {
  if (!hole || hole.length < 2) return '--';
  const sorted = [...hole].sort((a, b) => b.rank - a.rank);
  const high = RANK_LABELS[sorted[0].rank] || String(sorted[0].rank);
  const low = RANK_LABELS[sorted[1].rank] || String(sorted[1].rank);
  if (sorted[0].rank === sorted[1].rank) return `${high}${low}`;
  return `${high}${low}${sorted[0].suit === sorted[1].suit ? 's' : 'o'}`;
}

/**
 * 根据仍存活座位和庄位返回标准位置名。座位编号不要求连续，支持 2~9 人。
 */
export function tablePosition(playerIdx, dealerIdx, activeSeats) {
  const seats = [...new Set((activeSeats || []).map(Number).filter(Number.isFinite))]
    .sort((a, b) => a - b);
  const count = seats.length;
  if (!count || !seats.includes(Number(playerIdx))) {
    return { name: 'UNKNOWN', distance: -1, count, inPosition: false, playersBehind: 0 };
  }
  const dealerAt = seats.indexOf(Number(dealerIdx));
  const playerAt = seats.indexOf(Number(playerIdx));
  const distance = dealerAt < 0 ? -1 : (playerAt - dealerAt + count) % count;
  if (count === 2) {
    const name = distance === 0 ? 'BTN/SB' : 'BB';
    return { name, distance, count, inPosition: distance === 0, playersBehind: distance === 0 ? 1 : 0 };
  }

  const earlyToLate = {
    4: ['CO'],
    5: ['UTG', 'CO'],
    6: ['UTG', 'HJ', 'CO'],
    7: ['UTG', 'LJ', 'HJ', 'CO'],
    8: ['UTG', 'UTG+1', 'LJ', 'HJ', 'CO'],
    9: ['UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO'],
  };
  const name = distance === 0 ? 'BTN'
    : distance === 1 ? 'SB'
      : distance === 2 ? 'BB'
        : earlyToLate[count]?.[distance - 3] || 'UNKNOWN';
  const inPosition = name === 'BTN' || name === 'BTN/SB';
  const playersBehind = distance === 0 ? 2
    : distance === 1 ? 1
      : distance === 2 ? 0
        : Math.max(0, count - distance + 2);
  return { name, distance, count, inPosition, playersBehind };
}

const OPEN_FRACTIONS = {
  UTG: 0.16,
  'UTG+1': 0.18,
  MP: 0.21,
  LJ: 0.24,
  HJ: 0.29,
  CO: 0.36,
  BTN: 0.50,
  'BTN/SB': 0.56,
  SB: 0.43,
  BB: 0.18,
  UNKNOWN: 0.20,
};

export function openingFraction(position, tableSize = 6) {
  let value = OPEN_FRACTIONS[position] ?? OPEN_FRACTIONS.UNKNOWN;
  if (tableSize <= 3 && ['BTN', 'BTN/SB', 'SB'].includes(position)) value += 0.05;
  if (tableSize >= 8 && ['UTG', 'UTG+1', 'MP'].includes(position)) value -= 0.01;
  return clamp(value, 0.10, 0.62);
}

/** 手牌结构、听牌、坚果潜力和牌面湿度。 */
export function drawProfile(hole, board) {
  if (!board || board.length === 0) {
    return {
      potential: 0,
      nutPotential: 0,
      blocker: false,
      wetness: 0,
      flushDraw: false,
      nutFlushDraw: false,
      straightDraw: false,
      openEnded: false,
      gutshot: false,
      overcards: 0,
      outs: 0,
    };
  }
  const cards = [...hole, ...board];
  const currentCategory = describe(cards).cat;
  const known = new Set(cards.map(cardId));
  const flushOutCards = new Set();
  const straightOutCards = new Set();
  const straightOutRanks = new Set();
  if (board.length < 5) {
    for (let suit = 1; suit <= 4; suit++) {
      for (let rank = 2; rank <= 14; rank++) {
        const candidate = { rank, suit };
        const id = cardId(candidate);
        if (known.has(id)) continue;
        const result = evalBest([...cards, candidate]);
        const heroContributes = hole.some((heroCard) => result.best5.includes(heroCard));
        if (!heroContributes) continue;
        if (currentCategory < 5 && (result.cat === 5 || result.cat >= 9)) {
          straightOutCards.add(id);
          straightOutRanks.add(rank);
        }
        if (currentCategory < 6 && (result.cat === 6 || result.cat >= 9)) flushOutCards.add(id);
      }
    }
  }
  const flushDraw = flushOutCards.size > 0;
  const straightDraw = straightOutCards.size > 0;
  const openEnded = straightOutRanks.size >= 2;
  const gutshot = straightDraw && !openEnded;
  const drawingSuit = flushDraw
    ? [1, 2, 3, 4].find((suit) => [...flushOutCards]
      .some((id) => Math.floor(id / 13) + 1 === suit))
    : null;
  const suitedHoleRanks = hole.filter((card) => card.suit === drawingSuit).map((card) => card.rank);
  const knownSuitedRanks = new Set(cards.filter((card) => card.suit === drawingSuit)
    .map((card) => card.rank));
  let highestUnseen = 14;
  while (highestUnseen >= 2 && knownSuitedRanks.has(highestUnseen)) highestUnseen--;
  const nutFlushDraw = flushDraw && suitedHoleRanks.some((rank) => rank >= highestUnseen);

  const maxBoard = Math.max(...board.map((card) => card.rank));
  const overcards = hole.filter((card) => card.rank > maxBoard).length;
  const boardSuitMax = Math.max(...[1, 2, 3, 4].map((suit) =>
    board.filter((card) => card.suit === suit).length));
  const sortedBoard = [...new Set(board.map((card) => card.rank))].sort((a, b) => a - b);
  let closeRanks = 0;
  for (let i = 1; i < sortedBoard.length; i++) {
    if (sortedBoard[i] - sortedBoard[i - 1] <= 2) closeRanks++;
  }
  const flushBlocker = hole.some((card) => card.rank === 14
    && board.filter((item) => item.suit === card.suit).length >= 3);
  const pairedBoard = new Set(board.map((card) => card.rank)).size < board.length;
  const highBlocker = hole.some((card) => card.rank >= 13
    && board.filter((item) => item.suit === card.suit).length >= 2);
  const blocker = flushBlocker || (boardSuitMax >= 3 && highBlocker);
  const outs = Math.min(15, new Set([...flushOutCards, ...straightOutCards]).size);
  const potential = clamp(outs / 12 + overcards * 0.08);
  const nutPotential = clamp((nutFlushDraw ? 0.72 : flushDraw ? 0.36 : 0)
    + (openEnded ? 0.34 : gutshot ? 0.16 : 0)
    + (blocker ? 0.12 : 0));
  const wetness = clamp((boardSuitMax - 1) * 0.21 + closeRanks * 0.15
    + (pairedBoard ? 0.08 : 0));
  return {
    potential,
    nutPotential,
    blocker,
    wetness,
    flushDraw,
    nutFlushDraw,
    straightDraw,
    openEnded,
    gutshot,
    overcards,
    outs,
  };
}

export function tournamentRiskAdjustment({
  round = 1, maxRounds = 12, hp = 0, allHps = [], continuous = false,
} = {}) {
  const stacks = allHps.filter((value) => Number(value) >= 0).sort((a, b) => a - b);
  if (!stacks.length) return 0;
  const below = stacks.filter((value) => value < hp).length;
  const equals = Math.max(0, stacks.filter((value) => value === hp).length - 1);
  const percentile = (below + equals * 0.5) / Math.max(1, stacks.length - 1);
  const progress = clamp(round / Math.max(1, maxRounds));
  if (continuous) {
    if (progress < 0.40) return 0;
    const leverage = (progress - 0.40) / 0.60;
    const centered = clamp((percentile - 0.5) * 2, -1, 1);
    const shaped = Math.sign(centered) * Math.pow(Math.abs(centered), 1.25);
    return shaped >= 0 ? 0.075 * shaped * leverage : 0.05 * shaped * leverage;
  }
  if (progress < 0.55) return 0;
  const leverage = (progress - 0.55) / 0.45;
  if (percentile >= 0.75) return 0.045 * leverage;
  if (percentile <= 0.25) return -0.035 * leverage;
  return 0;
}

/** Normalize Engine- and Observation-shaped legal action objects at one boundary. */
export function normalizePolicyOptions(raw = {}) {
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const toCall = Math.max(0, finite(raw.toCall));
  const callAmt = Math.max(0, finite(raw.callAmt ?? raw.callAmount, toCall));
  const allinAmt = Math.max(0, finite(raw.allinAmt ?? raw.allInAmount));
  const tiers = (Array.isArray(raw.tiers) ? raw.tiers : []).map((tier) => ({
    key: String(tier.key || ''),
    name: String(tier.name || tier.key || ''),
    inc: finite(tier.inc ?? tier.increment, Number.NaN),
    cost: finite(tier.cost, Number.NaN),
  })).filter((tier) => tier.key && Number.isFinite(tier.inc) && tier.inc > 0
    && Number.isFinite(tier.cost) && tier.cost > 0);
  return Object.freeze({
    toCall,
    canCheck: raw.canCheck === true || toCall === 0,
    callAmt,
    allinAmt,
    canRaise: raw.canRaise === true && tiers.length > 0,
    canAllIn: raw.canAllIn === true && allinAmt > 0,
    allInRaises: raw.canAllIn === true && allinAmt > callAmt,
    tiers: Object.freeze(tiers),
  });
}

function tierAction(opts, preference = 'medium') {
  const tiers = opts?.tiers || [];
  if (!tiers.length) return null;
  const index = preference === 'small' ? 0
    : preference === 'large' ? tiers.length - 1
      : Math.min(1, tiers.length - 1);
  return { type: 'raise', tier: tiers[index] };
}

function actionKey(action) {
  return action ? `${action.type}:${action.tier?.key || ''}` : '';
}

function normalizeCandidates(candidates) {
  const unique = [];
  for (const candidate of candidates) {
    if (!candidate?.action || !Number.isFinite(candidate.ev)) continue;
    const key = actionKey(candidate.action);
    const existing = unique.find((item) => actionKey(item.action) === key);
    if (!existing || candidate.ev > existing.ev) {
      if (existing) unique.splice(unique.indexOf(existing), 1);
      unique.push(candidate);
    }
  }
  return unique;
}

/** 将近似 EV 转换成只在近似无差异动作之间混合的概率。 */
export function mixedPolicy(
  candidates,
  { rng = Math.random, temperature = 1, fallbackAction = { type: 'check' } } = {},
) {
  const choices = normalizeCandidates(candidates);
  if (!choices.length) return { action: fallbackAction, distribution: [] };
  const best = Math.max(...choices.map((item) => item.ev));
  const scale = Math.max(0.001, temperature);
  let total = 0;
  const distribution = choices.map((item) => {
    const relative = Math.max(-18, (item.ev - best) / scale);
    const weight = Math.exp(relative) * Math.max(0.02, item.frequencyBias ?? 1);
    total += weight;
    return { ...item, probability: weight };
  });
  for (const item of distribution) item.probability /= total;
  let roll = clamp(rng(), 0, 0.999999999999);
  let selected = distribution[distribution.length - 1];
  for (const item of distribution) {
    roll -= item.probability;
    if (roll < 0) { selected = item; break; }
  }
  return { action: selected.action, distribution, selected };
}

function shoveFraction(position, tableSize) {
  return clamp(openingFraction(position, tableSize)
    + (['BTN', 'BTN/SB', 'SB'].includes(position) ? 0.06 : 0));
}

export function preflopWagerEv({
  pot, cost, equity, numOpponents, foldTendency = 0.72, raiseCount = 0,
  adjustForCallers = false, callerProjectionWeight = 1,
  directCallerEquity = false, foldTendencies = null, opponentEquities = null,
}) {
  if (!(cost > 0) || !(numOpponents > 0)) return -Infinity;
  const sizeRatio = cost / Math.max(1, pot);
  const foldProbability = (tendency) => clamp(0.48 + (tendency - 0.5) * 0.45
    + sizeRatio * 0.06 - Math.max(0, raiseCount) * 0.10, 0.18, 0.78);
  const individualFolds = Array.isArray(foldTendencies) && foldTendencies.length === numOpponents
    ? foldTendencies.map(foldProbability)
    : Array.from({ length: numOpponents }, () => foldProbability(foldTendency));
  const foldAll = individualFolds.reduce((product, probability) => product * probability, 1);
  const continueProbability = 1 - foldAll;
  const conditionalCallers = continueProbability > 1e-6
    ? individualFolds.reduce((sum, probability) => sum + 1 - probability, 0)
      / continueProbability : 0;
  const finalPot = pot + cost + cost * conditionalCallers;
  // `equity` is joint equity against every currently active range.  Once a
  // wager folds part of that field, re-project it to the expected caller count
  // instead of treating folded players as if they still reached showdown.
  const legacyEquity = clamp(equity - Math.max(0, conditionalCallers - 1) * 0.008);
  const hasDirectEquities = directCallerEquity && Array.isArray(opponentEquities)
    && opponentEquities.length === numOpponents
    && opponentEquities.every((value) => Number.isFinite(value));
  const continueMass = individualFolds.reduce((sum, probability) => sum + 1 - probability, 0);
  const headsUpEquity = hasDirectEquities && continueMass > 1e-6
    ? opponentEquities.reduce((sum, value, index) =>
      sum + clamp(value) * (1 - individualFolds[index]), 0) / continueMass
    : Math.pow(clamp(equity), 1 / numOpponents);
  const projectedEquity = Math.pow(clamp(headsUpEquity), conditionalCallers);
  const projectionWeight = hasDirectEquities ? 1
    : adjustForCallers ? clamp(callerProjectionWeight) : 0;
  const showdownEquity = legacyEquity + (projectedEquity - legacyEquity) * projectionWeight;
  const showdownEv = showdownEquity * finalPot - cost;
  return foldAll * pot + continueProbability * showdownEv;
}

/** 纯翻前策略。quality 必须是按1326组合标定的百分位。 */
export function preflopPolicy(context) {
  const {
    quality,
    position,
    tableSize,
    stackBb,
    potOdds,
    raiseCount = 0,
    limpers = 0,
    opts: rawOpts,
    style = {},
    tournamentRisk = 0,
    consistentPreflopEv = false,
    callerAdjustedPreflopEv = false,
    callerProjectionWeight = 1,
    directCallerPreflopEv = false,
    foldTendencies = null,
    opponentEquities = null,
    foldTendency = 0.72,
    numOpponents = Math.max(1, tableSize - 1),
    rng = Math.random,
  } = context;
  if (!Number.isFinite(quality) || !Number.isFinite(stackBb) || !Number.isFinite(potOdds)
    || !Number.isInteger(tableSize) || tableSize < 2 || tableSize > MAX_SUPPORTED_PLAYERS) {
    throw new TypeError('preflopPolicy requires finite quality/stackBb/potOdds and tableSize 2..9');
  }
  const opts = normalizePolicyOptions(rawOpts);
  const looseness = clamp(style.looseness || 0, -0.08, 0.08);
  const aggression = clamp(style.aggression || 0, -0.08, 0.12);
  const open = clamp(openingFraction(position, tableSize) + looseness - tournamentRisk
    - Math.max(0, limpers) * 0.015, 0.08, 0.65);
  const unopened = raiseCount <= 0;
  const candidates = [];
  const potScale = Math.max(1, context.pot || 1);
  const rangeEquity = Number.isFinite(context.rangeEquity)
    ? clamp(context.rangeEquity)
    : clamp(0.04 + quality * 0.56);
  const callEv = Number.isFinite(context.callExpectedPayout)
    ? context.callExpectedPayout * 0.86 - opts.callAmt
    : rangeEquity * 0.86 * (potScale + opts.callAmt) - opts.callAmt;

  if (unopened) {
    const short = stackBb <= 10.5;
    const shove = clamp(shoveFraction(position, tableSize) + looseness - tournamentRisk, 0.10, 0.62);
    if (short && opts.allInRaises && quality >= 1 - shove) {
      const cost = opts.allinAmt;
      const shoveEv = consistentPreflopEv ? preflopWagerEv({
        pot: potScale, cost, equity: rangeEquity, numOpponents, foldTendency, raiseCount,
        adjustForCallers: callerAdjustedPreflopEv,
        callerProjectionWeight,
        directCallerEquity: directCallerPreflopEv,
        foldTendencies,
        opponentEquities,
      }) : rangeEquity * (potScale + cost * 2) - cost;
      candidates.push({ action: { type: 'allin' }, ev: shoveEv, frequencyBias: 1.25 });
    }
    const openMargin = quality - (1 - open);
    if (openMargin >= 0 && opts.canRaise) {
      const premium = quality >= 0.965;
      const preference = premium && stackBb > 20 ? 'medium' : limpers > 0 ? 'medium' : 'small';
      const action = tierAction(opts, preference);
      candidates.push({
        action,
        ev: consistentPreflopEv ? preflopWagerEv({
          pot: potScale, cost: action.tier.cost, equity: rangeEquity,
          numOpponents, foldTendency, raiseCount,
          adjustForCallers: callerAdjustedPreflopEv,
          callerProjectionWeight,
          directCallerEquity: directCallerPreflopEv,
          foldTendencies,
          opponentEquities,
        }) : potScale * (0.42 + openMargin * 4.5 + aggression - limpers * 0.015),
        frequencyBias: openMargin < 0.018 ? 0.72 : 1.25,
      });
    }
    if (opts.canCheck) {
      candidates.push({ action: { type: 'check' }, ev: rangeEquity * potScale * 0.84 });
    } else if (position === 'SB' && quality >= 1 - clamp(open + 0.045, 0, 0.68)
      && callEv >= -potScale * 0.015) {
      candidates.push({ action: { type: 'call' }, ev: callEv, frequencyBias: 0.65 });
    }
    if (!opts.canCheck) candidates.push({ action: { type: 'fold' }, ev: 0 });
  } else {
    const pressure = Math.max(0, raiseCount - 1) * 0.035
      + Math.max(0, tableSize - 2) * 0.004 + tournamentRisk;
    const callFraction = clamp(open * 0.50 + 0.08 - pressure + looseness * 0.5, 0.08, 0.30);
    const threeBetFraction = clamp(0.085 + aggression * 0.5 - pressure * 0.4, 0.045, 0.14);
    const shortReshoveFraction = clamp(callFraction + 0.035, 0.10, 0.30);
    if (opts.allInRaises && stackBb <= 12 && quality >= 1 - shortReshoveFraction) {
      const cost = opts.allinAmt;
      const shoveEv = consistentPreflopEv ? preflopWagerEv({
        pot: potScale, cost, equity: rangeEquity, numOpponents, foldTendency, raiseCount,
        adjustForCallers: callerAdjustedPreflopEv,
        callerProjectionWeight,
        directCallerEquity: directCallerPreflopEv,
        foldTendencies,
        opponentEquities,
      }) : rangeEquity * (potScale + cost * 2) - cost;
      candidates.push({ action: { type: 'allin' }, ev: shoveEv, frequencyBias: 1.1 });
    }
    if (opts.canRaise && quality >= 1 - threeBetFraction) {
      const action = tierAction(opts,
        ['SB', 'BB', 'UTG', 'UTG+1'].includes(position) ? 'large' : 'medium');
      candidates.push({
        action,
        ev: consistentPreflopEv ? preflopWagerEv({
          pot: potScale, cost: action.tier.cost, equity: rangeEquity,
          numOpponents, foldTendency, raiseCount,
          adjustForCallers: callerAdjustedPreflopEv,
          callerProjectionWeight,
          directCallerEquity: directCallerPreflopEv,
          foldTendencies,
          opponentEquities,
        }) : potScale * (quality - (1 - threeBetFraction) + 0.20 + aggression),
        frequencyBias: 1.15,
      });
    }
    if (quality >= 1 - callFraction && rangeEquity >= potOdds + pressure * 0.20
      && callEv >= -potScale * 0.02) {
      candidates.push({ action: { type: 'call' }, ev: callEv });
    }
    candidates.push({ action: { type: 'fold' }, ev: 0, frequencyBias: quality < 1 - callFraction ? 1.3 : 0.4 });
  }

  const result = mixedPolicy(candidates, {
    rng,
    temperature: Math.max(0.025, potScale * (quality > 0.94 ? 0.035 : 0.055)),
    fallbackAction: opts.canCheck ? { type: 'check' } : { type: 'fold' },
  });
  return { ...result, quality, rangeEquity, openFraction: open, opts };
}

function individualFoldProbability({ sizeRatio, foldTendency = 0.5 }) {
  return clamp(0.25 + sizeRatio * 0.30 + (foldTendency - 0.5) * 0.30, 0.12, 0.72);
}

function foldProbabilities({
  numOpponents,
  sizeRatio,
  foldTendency = 0.5,
  foldTendencies = null,
  allInOpponents = 0,
}) {
  const canFold = Math.max(0, numOpponents - allInOpponents);
  const tendencies = Array.isArray(foldTendencies) && foldTendencies.length === canFold
    ? foldTendencies : Array(canFold).fill(foldTendency);
  return tendencies.map((tendency) => individualFoldProbability({
    sizeRatio,
    foldTendency: tendency,
  }));
}

function wagerCandidate(context, action, preference) {
  if (!action) return null;
  const {
    pot,
    equity,
    numOpponents,
    foldTendency = 0.5,
    foldTendencies = null,
    allInOpponents = 0,
    draws = { nutPotential: 0, potential: 0, blocker: false },
    tournamentRisk = 0,
  } = context;
  const cost = action.type === 'allin' ? context.opts.allinAmt : action.tier.cost;
  if (!Number.isFinite(cost) || cost <= 0) return null;
  const callPart = Math.min(context.opts.callAmt || 0, cost);
  const aggressivePart = Math.max(0, cost - callPart);
  const sizeRatio = aggressivePart / Math.max(1, pot + callPart);
  const foldable = Math.max(0, numOpponents - allInOpponents);
  const folds = foldProbabilities({
    numOpponents, sizeRatio, foldTendency, foldTendencies, allInOpponents,
  });
  const foldActionables = folds.reduce((product, probability) => product * probability, 1);
  const foldAll = allInOpponents > 0 ? 0 : foldActionables;
  const actionableContinue = 1 - foldActionables;
  const conditionalNewCallers = actionableContinue > 1e-6
    ? folds.reduce((sum, probability) => sum + (1 - probability), 0) / actionableContinue : 0;
  const estimatedCallers = allInOpponents + conditionalNewCallers;
  const actionableEquity = Number.isFinite(context.actionableEquity) && foldable > 0
    ? clamp(context.actionableEquity) : equity;
  const continueEquity = clamp(actionableEquity
    - Math.max(0, conditionalNewCallers - 1) * 0.006
    - sizeRatio * 0.01 - tournamentRisk);
  // Players already all-in are included in showdown equity but cannot add
  // chips to a new wager. Only still-actionable callers fund the extra pot.
  const newCallers = conditionalNewCallers;
  const opponentAdds = aggressivePart * newCallers;
  let ev;
  if (Number.isFinite(context.callExpectedPayout)
    && Number.isFinite(context.allFoldExpectedPayout)) {
    const realization = Number.isFinite(context.realization) ? context.realization : 1;
    const allContinueBaseEv = context.callExpectedPayout * realization - callPart;
    const allFoldBaseEv = context.allFoldExpectedPayout * realization - callPart;
    const extraLayerEv = continueEquity * (aggressivePart + opponentAdds) - aggressivePart;
    // Existing main/side pots are evaluated exactly by contribution layer.
    // Only the newly matched raise layer needs the response approximation.
    ev = foldActionables * allFoldBaseEv
      + actionableContinue * (allContinueBaseEv + extraLayerEv);
  } else {
    const finalPot = pot + cost + opponentAdds;
    const showdownEv = continueEquity * finalPot - cost;
    ev = foldAll * pot + (1 - foldAll) * showdownEv;
  }
  const bluffQuality = clamp(draws.nutPotential * 0.7 + draws.potential * 0.45
    + (draws.blocker ? 0.18 : 0));
  return {
    action,
    ev,
    foldAll,
    foldActionables,
    estimatedCallers,
    sizeRatio,
    continueEquity,
    frequencyBias: preference === 'bluff' ? Math.max(0.04, bluffQuality / Math.sqrt(numOpponents)) : 1,
  };
}

/** 范围权益驱动的翻后行动 EV 与混合策略。 */
export function postflopPolicy(context) {
  const {
    hole,
    board,
    equity,
    numOpponents,
    opts: rawOpts,
    pot,
    stack,
    inPosition = false,
    closesAction = true,
    tournamentRisk = 0,
    rng = Math.random,
  } = context;
  if (!Number.isFinite(equity) || equity < 0 || equity > 1
    || !Number.isFinite(pot) || pot < 0 || !Number.isFinite(stack) || stack < 0
    || !Number.isInteger(numOpponents) || numOpponents < 1 || numOpponents > 8
    || !Number.isFinite(tournamentRisk)) {
    throw new TypeError('postflopPolicy requires finite equity/pot/stack/risk and 1..8 opponents');
  }
  const opts = normalizePolicyOptions(rawOpts);
  const draws = context.draws || drawProfile(hole, board);
  const hand = describe([...hole, ...board]);
  const spr = stack / Math.max(1, pot);
  const potOdds = opts.callAmt / Math.max(1, pot + opts.callAmt);
  // Equity is already joint equity against every active range. Only add a
  // small realization/risk buffer here; do not punish the same opponents twice.
  const extraOpponents = Math.max(0, numOpponents - 1);
  const multiwayPremium = Math.min(0.028, extraOpponents * 0.006);
  const actionOpenPremium = closesAction ? 0 : 0.025;
  const requiredEquity = clamp(potOdds + multiwayPremium + actionOpenPremium + tournamentRisk);
  const realization = board.length === 5 ? 1 : clamp(0.93 + (inPosition ? 0.035 : -0.03)
    - extraOpponents * 0.012 + draws.potential * 0.02, 0.76, 0.99);
  const candidates = [];
  const actionableOpponents = Math.max(0, numOpponents - Math.max(0, context.allInOpponents || 0));
  const actionableEquity = actionableOpponents > 0 && Number.isFinite(context.actionableEquity)
    ? clamp(context.actionableEquity) : equity;
  const valueEquity = Math.max(equity, actionableEquity);
  const nutSafety = numOpponents >= 3 && draws.nutPotential < 0.28 ? 0.015 : 0;
  const valueThreshold = clamp(0.54 - extraOpponents * 0.022
    + tournamentRisk + nutSafety, 0.36, 0.58);
  const stackOffThreshold = clamp(0.74 - extraOpponents * 0.018
    + tournamentRisk + nutSafety, 0.58, 0.82);
  const nutted = valueEquity >= Math.max(stackOffThreshold, numOpponents >= 3 ? 0.70 : 0.82)
    && (hand.cat >= 5 || valueEquity >= 0.90);
  const strongDraw = board.length < 5 && draws.outs >= 8
    && (numOpponents <= 2 || draws.nutPotential >= 0.55 || draws.nutFlushDraw);
  const normalizedContext = {
    ...context,
    opts,
    equity,
    pot,
    numOpponents,
    draws,
    tournamentRisk,
    realization,
  };

  if (opts.toCall > 0) {
    candidates.push({ action: { type: 'fold' }, ev: 0,
      frequencyBias: equity + 0.02 < requiredEquity ? 1.25 : 0.25 });
    const callEv = Number.isFinite(context.callExpectedPayout)
      ? context.callExpectedPayout * realization - opts.callAmt
      : equity * realization * (pot + opts.callAmt) - opts.callAmt;
    candidates.push({ action: { type: 'call' }, ev: callEv,
      frequencyBias: equity >= requiredEquity || strongDraw ? 1 : 0.18 });

    if (opts.canRaise && (valueEquity >= valueThreshold || strongDraw)) {
      const valuePreference = draws.wetness >= 0.55 || numOpponents >= 3 ? 'large' : 'medium';
      const aggressive = wagerCandidate(normalizedContext, tierAction(opts, valuePreference),
        valueEquity >= valueThreshold ? 'value' : 'bluff');
      if (aggressive) candidates.push(aggressive);
    }
    if (opts.allInRaises && (nutted || (spr <= 1.05 && valueEquity >= stackOffThreshold)
      || (strongDraw && spr <= 0.75 && numOpponents <= 2))) {
      const shove = wagerCandidate(normalizedContext, { type: 'allin' }, nutted ? 'value' : 'bluff');
      if (shove) candidates.push(shove);
    }
  } else {
    const checkEv = Number.isFinite(context.callExpectedPayout)
      ? context.callExpectedPayout * realization
      : equity * realization * pot;
    candidates.push({ action: { type: 'check' }, ev: checkEv,
      frequencyBias: equity < valueThreshold || numOpponents >= 3 ? 1.15 : 0.65 });
    if (opts.canRaise && valueEquity >= valueThreshold) {
      const preference = draws.wetness >= 0.55 || numOpponents >= 3 ? 'large'
        : valueEquity >= stackOffThreshold ? 'medium' : 'small';
      const valueBet = wagerCandidate(normalizedContext, tierAction(opts, preference), 'value');
      if (valueBet) candidates.push(valueBet);
    }
    const bluffAllowed = numOpponents <= 2 && strongDraw
      || (numOpponents === 1 && board.length === 5 && draws.blocker);
    if (opts.canRaise && bluffAllowed && equity < valueThreshold) {
      const bluff = wagerCandidate(normalizedContext,
        tierAction(opts, draws.nutPotential >= 0.7 ? 'medium' : 'small'), 'bluff');
      if (bluff) candidates.push(bluff);
    }
    if (opts.allInRaises && nutted && spr <= 0.72) {
      const shove = wagerCandidate(normalizedContext, { type: 'allin' }, 'value');
      if (shove) candidates.push(shove);
    }
  }

  const result = mixedPolicy(candidates, {
    rng,
    temperature: Math.max(1, pot * (numOpponents >= 3 ? 0.035 : 0.055)),
    fallbackAction: opts.canCheck ? { type: 'check' } : { type: 'fold' },
  });
  return {
    ...result,
    equity,
    requiredEquity,
    valueThreshold,
    valueEquity,
    actionableEquity,
    stackOffThreshold,
    spr,
    potOdds,
    hand,
    draws,
    opts,
  };
}

/** 对外诊断时用于确认一组已知牌是否发生冲突。 */
export function uniqueCards(cards) {
  const ids = cards.filter(Boolean).map(cardId);
  return new Set(ids).size === ids.length;
}
