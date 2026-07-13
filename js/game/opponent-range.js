// ============================================================================
// opponent-range.js - Card-aware Bayesian opponent ranges for 2-9 player tables.
//
// This module deliberately depends only on the pure poker evaluator. It is safe
// in browsers, workers and Node-based tests: no DOM and no Node APIs are used.
// ============================================================================

import { evalBest } from './handeval.js';

export const MAX_TABLE_PLAYERS = 9;
export const MAX_OPPONENTS = MAX_TABLE_PLAYERS - 1;
export const COMBINATION_COUNT = 1326;

const EPSILON = 1e-9;
const MIN_LIKELIHOOD = 1e-6;
const NEGATIVE_INFINITY = Number.NEGATIVE_INFINITY;

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

function assertCard(card, label = 'card') {
  if (!card || !Number.isInteger(card.rank) || card.rank < 2 || card.rank > 14
    || !Number.isInteger(card.suit) || card.suit < 1 || card.suit > 4) {
    throw new TypeError(`${label} must be { rank: 2..14, suit: 1..4 }`);
  }
}

/** Stable zero-based physical-card id (0..51). */
export function cardId(card) {
  assertCard(card);
  return (card.suit - 1) * 13 + (card.rank - 2);
}

function cardFromId(id) {
  return HOLE_DECK[id];
}

function cardKey(card) {
  return `${card.rank}-${card.suit}`;
}

function idsKey(firstId, secondId) {
  return firstId < secondId ? `${firstId}:${secondId}` : `${secondId}:${firstId}`;
}

const HOLE_DECK = Object.freeze(Array.from({ length: 52 }, (_, id) => Object.freeze({
  rank: (id % 13) + 2,
  suit: Math.floor(id / 13) + 1,
})));

const COMBO_INDEX = new Map();
const combos = [];
for (let firstId = 0; firstId < 51; firstId++) {
  for (let secondId = firstId + 1; secondId < 52; secondId++) {
    const cards = Object.freeze([cardFromId(firstId), cardFromId(secondId)]);
    const combo = Object.freeze({
      index: combos.length,
      key: idsKey(firstId, secondId),
      cards,
      cardIds: Object.freeze([firstId, secondId]),
    });
    COMBO_INDEX.set(combo.key, combo.index);
    combos.push(combo);
  }
}

/** Canonical, immutable enumeration of all C(52,2) physical hole-card combos. */
export const HOLE_COMBINATIONS = Object.freeze(combos);

if (HOLE_COMBINATIONS.length !== COMBINATION_COUNT) {
  throw new Error(`Expected ${COMBINATION_COUNT} hole-card combinations`);
}

/** Returns the shared immutable 1326-combo table. */
export function enumerateHoleCombinations() {
  return HOLE_COMBINATIONS;
}

function comboIndexOf(cardsOrCombo) {
  if (cardsOrCombo && Number.isInteger(cardsOrCombo.index)
    && HOLE_COMBINATIONS[cardsOrCombo.index] === cardsOrCombo) {
    return cardsOrCombo.index;
  }
  const cards = Array.isArray(cardsOrCombo) ? cardsOrCombo : cardsOrCombo?.cards;
  if (!cards || cards.length !== 2) return -1;
  const first = cardId(cards[0]);
  const second = cardId(cards[1]);
  if (first === second) return -1;
  return COMBO_INDEX.get(idsKey(first, second)) ?? -1;
}

function excludedIdSet(cards, label = 'excludedCards') {
  const ids = new Set();
  for (const card of cards || []) {
    assertCard(card, label);
    ids.add(cardId(card));
  }
  return ids;
}

function comboIsExcluded(combo, ids) {
  return ids.has(combo.cardIds[0]) || ids.has(combo.cardIds[1]);
}

/** Approximate 0..1 preflop ordering used by the observation model. */
export function preflopComboStrength(cards) {
  if (!cards || cards.length !== 2) return 0;
  const [first, second] = cards;
  const high = Math.max(first.rank, second.rank);
  const low = Math.min(first.rank, second.rank);
  if (high === low) return clamp(0.50 + ((high - 2) / 12) * 0.48);

  const suited = first.suit === second.suit;
  const gap = high - low - 1;
  let value = 0.055 + (high / 14) * 0.34 + (low / 14) * 0.21;
  if (suited) value += 0.075;
  if (gap <= 0) value += 0.075;
  else if (gap === 1) value += 0.052;
  else if (gap === 2) value += 0.024;
  else if (gap >= 4) value -= 0.045;
  if (high >= 11 && low >= 10) value += 0.085;
  if (high === 14) value += 0.045;
  return clamp(value);
}

function straightDrawFeature(hole, board) {
  if (board.length >= 5) return 0;
  const allRanks = new Set([...hole, ...board].map((card) => card.rank));
  if (allRanks.has(14)) allRanks.add(1);
  const holeRanks = new Set(hole.flatMap((card) => card.rank === 14 ? [14, 1] : [card.rank]));
  let best = 0;
  for (let low = 1; low <= 10; low++) {
    let present = 0;
    let holePresent = false;
    for (let rank = low; rank < low + 5; rank++) {
      if (allRanks.has(rank)) present++;
      if (holeRanks.has(rank)) holePresent = true;
    }
    if (holePresent && present === 4) best = 1;
    else if (holePresent && present === 3) best = Math.max(best, 0.28);
  }
  return best;
}

/** Public-board texture, independent of any private hand. */
export function boardTexture(board = []) {
  if (!board.length) return { wetness: 0, paired: false, monotone: false };
  const suitCounts = [0, 0, 0, 0, 0];
  const rankCounts = new Map();
  for (const card of board) {
    assertCard(card, 'board card');
    suitCounts[card.suit]++;
    rankCounts.set(card.rank, (rankCounts.get(card.rank) || 0) + 1);
  }
  const maxSuit = Math.max(...suitCounts);
  const ranks = [...rankCounts.keys()].sort((a, b) => a - b);
  let connected = 0;
  for (let index = 1; index < ranks.length; index++) {
    const gap = ranks[index] - ranks[index - 1];
    if (gap <= 2) connected += gap === 1 ? 1 : 0.55;
  }
  const paired = [...rankCounts.values()].some((count) => count >= 2);
  return {
    wetness: clamp((maxSuit - 1) * 0.23 + connected * 0.16 - (paired ? 0.08 : 0)),
    paired,
    monotone: board.length >= 3 && maxSuit === board.length,
  };
}

function postflopComboFeatures(cards, board) {
  const allCards = [...cards, ...board];
  const result = evalBest(allCards);
  const categoryBase = [0, 0.13, 0.35, 0.52, 0.67, 0.76, 0.82, 0.90, 0.96, 0.985, 0.995];
  let made = categoryBase[result.cat] || 0.1;

  const high = Math.max(cards[0].rank, cards[1].rank);
  const boardHigh = Math.max(...board.map((card) => card.rank));
  const holeMatches = cards.filter((card) => board.some((shown) => shown.rank === card.rank)).length;
  if (result.cat === 1) made += (high / 14) * 0.08;
  if (result.cat === 2 && holeMatches) made += 0.055;
  if (result.cat >= 2 && result.best5.some((best) => cards.some((card) => card === best))) made += 0.02;

  const suitCounts = [0, 0, 0, 0, 0];
  for (const card of allCards) suitCounts[card.suit]++;
  let flushDraw = 0;
  if (board.length < 5) {
    for (let suit = 1; suit <= 4; suit++) {
      if (suitCounts[suit] === 4 && cards.some((card) => card.suit === suit)) flushDraw = 1;
      else if (suitCounts[suit] === 3 && cards.every((card) => card.suit === suit)) {
        flushDraw = Math.max(flushDraw, 0.3);
      }
    }
  }
  const straightDraw = straightDrawFeature(cards, board);
  const overcards = board.length < 5
    ? cards.filter((card) => card.rank > boardHigh).length / 2
    : 0;
  const draw = clamp(flushDraw * 0.68 + straightDraw * 0.55 + overcards * 0.16);

  const dominantBoardSuit = [1, 2, 3, 4]
    .sort((a, b) => board.filter((card) => card.suit === b).length
      - board.filter((card) => card.suit === a).length)[0];
  const blocker = cards.some((card) => card.rank === 14 && card.suit === dominantBoardSuit
      && board.filter((shown) => shown.suit === dominantBoardSuit).length >= 2)
    || cards.some((card) => card.rank >= 13 && card.rank > boardHigh);

  return { made: clamp(made), draw, blocker, category: result.cat };
}

/** Hand/action features consumed by the likelihood model. */
export function comboFeatures(cardsOrCombo, board = []) {
  const cards = Array.isArray(cardsOrCombo) ? cardsOrCombo : cardsOrCombo?.cards;
  if (!cards || cards.length !== 2) throw new TypeError('comboFeatures expects two hole cards');
  if (!board.length) {
    const high = Math.max(cards[0].rank, cards[1].rank);
    const low = Math.min(cards[0].rank, cards[1].rank);
    const suited = cards[0].suit === cards[1].suit;
    const connected = high - low <= 2;
    return {
      made: preflopComboStrength(cards),
      draw: clamp((suited ? 0.42 : 0) + (connected ? 0.38 : 0)),
      blocker: high === 14 || (high === 13 && low >= 10),
      category: cards[0].rank === cards[1].rank ? 2 : 1,
    };
  }
  for (const card of board) assertCard(card, 'board card');
  if (board.length < 3 || board.length > 5) {
    throw new RangeError('Postflop board must contain 3..5 cards');
  }
  return postflopComboFeatures(cards, board);
}

function percentStat(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return clamp(number > 1 ? number / 100 : number);
}

/** Shrinks noisy online HUD statistics toward population baselines. */
export function normalizeOpponentStats(stats = {}) {
  const hands = Math.max(0, Number(stats.hands) || 0);
  const priorHands = clamp(Number.isFinite(Number(stats.priorHands))
    ? Number(stats.priorHands) : 60, 12, 200);
  const reliability = hands / (hands + priorHands);
  const evidenceWeighted = stats.evidenceWeighted === true;
  const threeBetEvidenceWeighted = evidenceWeighted
    || stats.threeBetEvidenceWeighted === true;
  const facedPostflopBet = Math.max(0, Number(stats.facedPostflopBet) || 0);
  const postflopActions = Math.max(0, Number(stats.postflopActions) || 0);
  const threeBetOpportunities = Math.max(0, Number(stats.threeBetOpportunities) || 0);
  const threeBetCount = Math.max(0, Number(stats.threeBetCount) || 0);
  const foldReliability = evidenceWeighted
    ? facedPostflopBet / (facedPostflopBet + Math.max(4, priorHands * 0.3)) : reliability;
  const aggressionReliability = evidenceWeighted
    ? postflopActions / (postflopActions + Math.max(6, priorHands * 0.5)) : reliability;
  const threeBetReliability = threeBetEvidenceWeighted
    ? threeBetOpportunities
      / (threeBetOpportunities + Math.max(4, priorHands * 0.3)) : reliability;
  const blend = (observed, baseline, weight = reliability) => (
    baseline + (observed - baseline) * weight
  );
  const vpip = blend(percentStat(stats.vpip, 0.28), 0.28);
  const pfr = blend(percentStat(stats.pfr, 0.19), 0.19);
  const observedThreeBet = threeBetEvidenceWeighted && threeBetOpportunities > 0
    ? clamp(threeBetCount / threeBetOpportunities)
    : percentStat(stats.threeBet ?? stats.three_bet, 0.08);
  const threeBet = blend(observedThreeBet, 0.08, threeBetReliability);
  const cbet = blend(percentStat(stats.cbet, 0.58), 0.58);
  const foldToCbet = blend(
    percentStat(stats.foldToCbet ?? stats.fold_to_cbet, 0.45), 0.45, foldReliability,
  );
  const rawAf = Number(stats.af);
  const af = blend(
    Number.isFinite(rawAf) ? clamp(rawAf, 0, 8) / 8 : 0.25,
    0.25,
    aggressionReliability,
  ) * 8;
  const looseness = clamp((vpip - 0.28) / 0.22, -1, 1);
  const raiseShare = pfr / Math.max(vpip, 0.08);
  const aggression = clamp(
    (raiseShare - 0.66) * 1.25 + (threeBet - 0.08) * 2.5
      + (af / 8 - 0.25) * 0.9 + (cbet - 0.58) * 0.65,
    -1,
    1,
  );
  const bluffiness = clamp(0.5 + aggression * 0.3 + looseness * 0.16
    - Math.max(0, foldToCbet - 0.45) * 0.25);
  return Object.freeze({
    hands, priorHands, reliability, foldReliability, aggressionReliability,
    threeBetCount, threeBetOpportunities, threeBetReliability, threeBetEvidenceWeighted,
    vpip, pfr, threeBet, af, cbet, foldToCbet,
    looseness, aggression, bluffiness,
  });
}

function freshPublicActionProfile() {
  return {
    rounds: new Set(),
    vpipRounds: new Set(),
    pfrRounds: new Set(),
    threeBetRounds: new Set(),
    threeBetOpportunityRounds: new Set(),
    postflopAggressive: 0,
    postflopCalls: 0,
    facedPostflopBet: 0,
    foldedToPostflopBet: 0,
  };
}

function rawPublicProfileStats(profile) {
  const hands = Math.max(1, profile.rounds.size);
  const faced = profile.facedPostflopBet;
  const threeBetOpportunities = profile.threeBetOpportunityRounds.size;
  return Object.freeze({
    hands,
    vpip: profile.vpipRounds.size / hands,
    pfr: profile.pfrRounds.size / hands,
    threeBet: profile.threeBetRounds.size / hands,
    threeBetCount: profile.threeBetRounds.size,
    threeBetOpportunities,
    af: profile.postflopAggressive / Math.max(1, profile.postflopCalls),
    foldToCbet: faced ? profile.foldedToPostflopBet / faced : 0.45,
  });
}

/**
 * Derive the same low-sample public HUD inputs used by the runtime range
 * model, without consulting player identity, private cards or skill results.
 * The returned values are raw observations; OpponentRange performs the usual
 * shrinkage toward population baselines when it consumes them.
 */
export function derivePublicOpponentStats({
  actionHistory = [],
  handSeats = [],
  observerIdx = null,
  round = null,
} = {}) {
  const seats = [...new Set((Array.isArray(handSeats) ? handSeats : [])
    .map(Number).filter((seat) => Number.isInteger(seat) && seat > 0))];
  const observer = Number(observerIdx);
  const seatSet = new Set(seats);
  const profiles = new Map(seats
    .filter((seat) => seat !== observer)
    .map((seat) => [seat, freshPublicActionProfile()]));
  const ensure = (seat) => {
    if (!profiles.has(seat)) profiles.set(seat, freshPublicActionProfile());
    return profiles.get(seat);
  };
  const currentRound = Number(round);
  if (Number.isInteger(currentRound) && currentRound > 0) {
    for (const seat of seats) {
      if (seat !== observer) ensure(seat).rounds.add(currentRound);
    }
  }
  const aggressions = new Map();
  const events = (Array.isArray(actionHistory) ? actionHistory : [])
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const leftId = Number(left.event?.id);
      const rightId = Number(right.event?.id);
      const leftOrdered = Number.isFinite(leftId);
      const rightOrdered = Number.isFinite(rightId);
      if (leftOrdered && rightOrdered && leftId !== rightId) return leftId - rightId;
      return left.index - right.index;
    });
  for (const { event } of events) {
    if (!event || typeof event !== 'object') continue;
    const eventRound = Number(event.round);
    const eventSeats = Array.isArray(event.handSeats) ? event.handSeats.map(Number) : [];
    for (const seat of eventSeats) {
      if (seatSet.has(seat) && seat !== observer && Number.isInteger(eventRound)) {
        ensure(seat).rounds.add(eventRound);
      }
    }
    const key = `${eventRound}:${String(event.street || 'preflop')}`;
    const aggressiveBefore = aggressions.get(key) || 0;
    const actor = Number(event.actorIdx);
    if (actor !== observer && seatSet.has(actor) && Number.isInteger(eventRound)) {
      const profile = ensure(actor);
      profile.rounds.add(eventRound);
      if (event.forced !== true) {
        if (event.street === 'preflop') {
          if (aggressiveBefore > 0) profile.threeBetOpportunityRounds.add(eventRound);
          if (event.isAggressive === true || event.type === 'call' || event.key === 'call') {
            profile.vpipRounds.add(eventRound);
          }
          if (event.isAggressive === true) {
            profile.pfrRounds.add(eventRound);
            if (aggressiveBefore > 0) profile.threeBetRounds.add(eventRound);
          }
        } else {
          if (Number(event.callAmount) > 0) {
            profile.facedPostflopBet++;
            if (event.type === 'fold' || event.key === 'fold') profile.foldedToPostflopBet++;
          }
          if (event.isAggressive === true) profile.postflopAggressive++;
          if (event.type === 'call' || event.key === 'call') profile.postflopCalls++;
        }
      }
    }
    if (event.forced !== true && event.isAggressive === true) {
      aggressions.set(key, aggressiveBefore + 1);
    }
  }
  return new Map([...profiles.entries()]
    .filter(([seat]) => seatSet.has(seat) && seat !== observer)
    .sort(([left], [right]) => left - right)
    .map(([seat, profile]) => [seat, rawPublicProfileStats(profile)]));
}

function normalizedPosition(value, playerCount) {
  if (typeof value === 'string') {
    const key = value.toLowerCase().replace(/[^a-z0-9]/gu, '');
    const positions = {
      utg: -1, early: -1, ep: -1, utg1: -0.85,
      middle: -0.45, mp: -0.45, lj: -0.35, hj: -0.1,
      cutoff: 0.55, co: 0.55, button: 1, btn: 1,
      btnsb: 1,
      smallblind: -0.2, sb: -0.2, bigblind: -0.1, bb: -0.1,
    };
    return positions[key] ?? 0;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  if (number >= -1 && number <= 1 && !Number.isInteger(number)) return number;
  if (playerCount > 1 && number >= 0 && number < playerCount) {
    return (number / (playerCount - 1)) * 2 - 1;
  }
  return clamp(number, -1, 1);
}

function actionClass(merged) {
  const rawType = String(merged.type ?? merged.key ?? merged.action ?? '').toLowerCase();
  const aggressive = merged.isAggressive === true
    || ['raise', 'bet', 'feint', 'strike', 'fierce', 'probe', 'small', 'medium', 'large']
      .includes(rawType);
  if (rawType === 'fold') return 'fold';
  if (rawType === 'check') return 'check';
  if (rawType === 'call' || (rawType === 'allin' && !aggressive)) return 'call';
  if (rawType === 'allin') return 'allin';

  const ratio = merged.betRatio;
  if (['feint', 'probe', 'small'].includes(rawType) || ratio <= 0.40) return 'smallRaise';
  if (['fierce', 'large'].includes(rawType) || ratio > 0.60) return 'largeRaise';
  return 'mediumRaise';
}

/** Normalizes Engine onAction metadata or a flattened ActionEvent. */
export function normalizeActionEvent(actionEvent = {}, context = {}) {
  if (actionEvent?.normalizedActionEvent === true && Object.keys(context || {}).length === 0) {
    return actionEvent;
  }
  const event = actionEvent || {};
  const merged = {
    ...context,
    ...(event.context || {}),
    ...(event.meta || {}),
    ...event,
  };
  const street = String(merged.street || 'preflop').toLowerCase();
  const board = Array.isArray(merged.board) ? merged.board.slice() : [];
  const potBefore = Math.max(0, Number(merged.potBefore ?? merged.pot) || 0);
  const amount = Math.max(0, Number(merged.amount ?? merged.wagerAmount) || 0);
  const toCall = Math.max(0, Number(merged.toCallBefore ?? merged.toCall) || 0);
  const explicitRatio = Number(merged.betRatio ?? merged.wagerRatio ?? merged.ratio);
  const betRatio = clamp(Number.isFinite(explicitRatio)
    ? explicitRatio
    : amount / Math.max(1, potBefore), 0, 8);
  const playerCount = Math.round(clamp(
    Number(merged.activeCount ?? merged.playersInHand ?? merged.playerCount ?? merged.tableSize) || 2,
    2,
    MAX_TABLE_PLAYERS,
  ));
  const position = normalizedPosition(
    merged.position ?? merged.positionName ?? merged.positionIndex,
    playerCount,
  );
  const effectiveStack = Math.max(0, Number(merged.effectiveStack ?? merged.stack) || 0);
  const spr = Number.isFinite(Number(merged.spr))
    ? Math.max(0, Number(merged.spr))
    : effectiveStack > 0 ? effectiveStack / Math.max(1, potBefore) : 4;
  const currentBet = Math.max(0, Number(merged.currentBetBefore ?? merged.currentBet) || 0);
  const betStreet = Math.max(0, Number(merged.betStreetBefore ?? merged.betStreet) || 0);
  const facingBet = merged.facingBet != null
    ? Boolean(merged.facingBet)
    : toCall > 0 || currentBet > betStreet;
  const normalized = {
    normalizedActionEvent: true,
    type: merged.type ?? merged.key ?? merged.action,
    key: merged.key,
    street,
    board,
    amount,
    potBefore,
    toCall,
    potOdds: toCall / Math.max(1, potBefore + toCall),
    currentBetBefore: currentBet,
    betStreetBefore: betStreet,
    streetRaiseCountBefore: Math.max(0, Number(merged.streetRaiseCountBefore) || 0),
    isAggressive: merged.isAggressive === true,
    betRatio,
    playerCount,
    position,
    spr,
    facingBet,
  };
  normalized.actionClass = actionClass(normalized);
  return Object.freeze(normalized);
}

function softmaxProbability(logits, selected) {
  const values = Object.values(logits);
  const max = Math.max(...values);
  let total = 0;
  for (const value of values) total += Math.exp(value - max);
  return clamp(Math.exp(logits[selected] - max) / Math.max(EPSILON, total), MIN_LIKELIHOOD, 1);
}

/**
 * P(action | combo, public context, observed player style).
 *
 * This is intentionally a calibrated heuristic observation model, not a claim
 * that a player's exact cards are known. Its output is always non-zero so a
 * surprising bluff cannot permanently delete a combo from the posterior.
 */
export function actionLikelihood(cardsOrCombo, actionEvent, context = {}, stats = {}) {
  const event = normalizeActionEvent(actionEvent, context);
  const style = stats?.looseness == null ? normalizeOpponentStats(stats) : stats;
  const features = comboFeatures(cardsOrCombo, event.street === 'preflop' ? [] : event.board);
  const texture = boardTexture(event.board);

  let strength = features.made;
  if (event.street === 'preflop') {
    // Early position and large fields require a stronger range for the same action.
    strength = clamp(strength + event.position * 0.075 - (event.playerCount - 2) * 0.012);
  }
  const draw = features.draw;
  const blocker = features.blocker ? 1 : 0;
  const weak = 1 - strength;
  const aggressiveStyle = style.aggression || 0;
  const looseStyle = style.looseness || 0;
  const bluffStyle = style.bluffiness ?? 0.5;
  const pressure = event.potOdds * 2.2 + Math.min(1.2, event.betRatio) * 0.35;
  const commitment = 1 / (1 + event.spr);
  const polarization = Math.max(0, event.betRatio - 0.55);
  const bluffSupport = draw * 0.75 + blocker * 0.32 + weak * bluffStyle * 0.28;

  const logits = event.facingBet ? {
    fold: 1.35 + (0.48 - strength) * 4.5 - draw * 1.75 + pressure
      - looseStyle * (0.7 + weak * 0.5),
    check: -10,
    call: 0.15 + strength * 2.25 + draw * 1.25 - pressure * 0.45
      + looseStyle * (0.55 + weak * 0.35) - aggressiveStyle * 0.18,
    smallRaise: -1.05 + strength * 3.5 + draw * 1.15 + aggressiveStyle * (0.7 + weak * 0.45)
      + bluffSupport * 0.35,
    mediumRaise: -1.40 + strength * 4.15 + draw * 1.35 + aggressiveStyle * (0.85 + weak * 0.55)
      + bluffSupport * 0.48,
    largeRaise: -1.85 + strength * 4.8 + draw * 1.55 + blocker * 0.35
      + aggressiveStyle * (0.9 + weak * 0.7) + bluffSupport * (0.6 + polarization),
    allin: -2.45 + strength * 5.7 + draw * 1.15 + blocker * 0.25
      + aggressiveStyle * (0.75 + weak * 0.55) + commitment * 1.8,
  } : {
    fold: -10,
    check: 0.95 + (0.52 - strength) * 2.0 - draw * 0.65
      - aggressiveStyle * (0.7 + weak * 0.25),
    call: -10,
    smallRaise: -0.35 + strength * 2.75 + draw * 1.1 + aggressiveStyle * (0.6 + weak * 0.5)
      + looseStyle * 0.16,
    mediumRaise: -0.70 + strength * 3.55 + draw * 1.3 + aggressiveStyle * (0.75 + weak * 0.6)
      + bluffSupport * 0.35 + texture.wetness * strength * 0.3,
    largeRaise: -1.25 + strength * 4.25 + draw * 1.5 + blocker * 0.32
      + aggressiveStyle * (0.8 + weak * 0.7) + bluffSupport * (0.5 + polarization),
    allin: -2.10 + strength * 5.25 + draw + aggressiveStyle * (0.65 + weak * 0.45)
      + commitment * 1.9,
  };

  return softmaxProbability(logits, event.actionClass);
}

function priorLogWeights(prior) {
  const result = new Float64Array(COMBINATION_COUNT);
  let finite = 0;
  for (const combo of HOLE_COMBINATIONS) {
    let weight = 1;
    if (typeof prior === 'function') weight = Number(prior(combo));
    else if (prior instanceof Map) weight = Number(prior.get(combo.key) ?? 0);
    else if (prior && typeof prior.length === 'number') weight = Number(prior[combo.index]);
    if (Number.isFinite(weight) && weight > 0) {
      result[combo.index] = Math.log(weight);
      finite++;
    } else {
      result[combo.index] = NEGATIVE_INFINITY;
    }
  }
  if (!finite) throw new RangeError('prior must assign positive mass to at least one combo');
  return result;
}

function normalizedWeights(logWeights, blockedIds) {
  const result = new Float64Array(COMBINATION_COUNT);
  let max = NEGATIVE_INFINITY;
  for (const combo of HOLE_COMBINATIONS) {
    const value = logWeights[combo.index];
    if (Number.isFinite(value) && !comboIsExcluded(combo, blockedIds) && value > max) max = value;
  }
  if (!Number.isFinite(max)) return result;

  let total = 0;
  for (const combo of HOLE_COMBINATIONS) {
    const value = logWeights[combo.index];
    if (!Number.isFinite(value) || comboIsExcluded(combo, blockedIds)) continue;
    const weight = Math.exp(value - max);
    result[combo.index] = weight;
    total += weight;
  }
  if (total > 0) {
    for (let index = 0; index < result.length; index++) result[index] /= total;
  }
  return result;
}

function constraintPredicate(reveal) {
  if (typeof reveal === 'function') return reveal;
  if (typeof reveal?.predicate === 'function') return reveal.predicate;
  if (!reveal || typeof reveal !== 'object') throw new TypeError('constraint must be an object or predicate');

  const type = String(reveal.type ?? reveal.kind ?? '').toUpperCase().replace(/[- ]/gu, '_');
  const exactCard = reveal.card ?? reveal.revealedCard ?? reveal.oneCard;
  if (['EXCLUDE_CARD', 'NOT_CONTAINS_CARD'].includes(type)) {
    assertCard(reveal.card, 'excluded card');
    const blocked = cardId(reveal.card);
    return (combo) => !combo.cardIds.includes(blocked);
  }
  if (['CARD', 'EXACT_CARD', 'CONTAINS_CARD', 'HOLE_CARD', 'PEEK_HOLE', 'REVEAL_SELF'].includes(type)
    || (!type && exactCard)) {
    assertCard(exactCard, 'revealed card');
    const wanted = cardId(exactCard);
    return (combo) => combo.cardIds.includes(wanted);
  }
  if (['SUIT', 'CONTAINS_SUIT', 'HOLE_SUIT_CONTAINS'].includes(type)) {
    const suit = Number(reveal.suit);
    if (!Number.isInteger(suit) || suit < 1 || suit > 4) throw new TypeError('constraint suit must be 1..4');
    return (combo) => combo.cards.some((card) => card.suit === suit);
  }
  if (['HOLE_SAME_SUIT', 'SAME_SUIT', 'SUITED'].includes(type)) {
    return (combo) => combo.cards[0].suit === combo.cards[1].suit;
  }
  if (['HOLE_DIFFERENT_SUIT', 'DIFFERENT_SUIT', 'OFFSUIT'].includes(type)) {
    return (combo) => combo.cards[0].suit !== combo.cards[1].suit;
  }
  if (['HOLE_UNPAIRED', 'UNPAIRED'].includes(type)) {
    return (combo) => combo.cards[0].rank !== combo.cards[1].rank;
  }
  if (['RANK', 'CONTAINS_RANK'].includes(type)) {
    const rank = Number(reveal.rank);
    return (combo) => combo.cards.some((card) => card.rank === rank);
  }
  if (['HOLE_RANK_AT_LEAST', 'RANK_AT_LEAST'].includes(type)) {
    const rank = Number(reveal.rank ?? reveal.min);
    return (combo) => combo.cards.some((card) => card.rank >= rank);
  }
  if (['HOLE_RANK_RANGE_CONTAINS', 'RANK_RANGE_CONTAINS'].includes(type)) {
    const min = Number(reveal.min);
    const max = Number(reveal.max);
    return (combo) => combo.cards.some((card) => card.rank >= min && card.rank <= max);
  }
  if (['HOLE_RANK_SUM_MIN', 'RANK_SUM_MIN'].includes(type)) {
    const value = Number(reveal.value ?? reveal.min);
    return (combo) => combo.cards[0].rank + combo.cards[1].rank >= value;
  }
  if (type === 'HOLE_ONE_RED_ONE_BLACK') {
    return (combo) => isRed(combo.cards[0]) !== isRed(combo.cards[1]);
  }
  if (type === 'HOLE_SAME_COLOR') {
    return (combo) => isRed(combo.cards[0]) === isRed(combo.cards[1]);
  }
  if (['HOLE_RANK_DIFF_MAX', 'RANK_DIFF_MAX'].includes(type)) {
    const value = Number(reveal.value ?? reveal.max);
    return (combo) => Math.abs(combo.cards[0].rank - combo.cards[1].rank) <= value;
  }
  if (['HOLE_RANK_SUM_PARITY', 'RANK_SUM_PARITY'].includes(type)) {
    const value = String(reveal.value).toLowerCase();
    return (combo) => ((combo.cards[0].rank + combo.cards[1].rank) % 2 ? 'odd' : 'even') === value;
  }
  throw new RangeError(`Unsupported range constraint: ${type || '(missing type)'}`);
}

function isRed(card) {
  return card.suit === 2 || card.suit === 3;
}

function revealedExactCards(reveal) {
  if (Array.isArray(reveal)) return reveal.flatMap(revealedExactCards);
  if (!reveal || typeof reveal !== 'object') return [];
  const type = String(reveal.type ?? reveal.kind ?? '').toUpperCase().replace(/[- ]/gu, '_');
  const card = reveal.card ?? reveal.revealedCard ?? reveal.oneCard;
  if (card && ['CARD', 'EXACT_CARD', 'CONTAINS_CARD', 'HOLE_CARD', 'PEEK_HOLE', 'REVEAL_SELF', ''].includes(type)) {
    assertCard(card, 'revealed card');
    return [card];
  }
  return [];
}

export class OpponentRange {
  constructor(playerId, { stats = {}, prior, knownCards = [] } = {}) {
    if (playerId == null || playerId === '') throw new TypeError('playerId is required');
    this.playerId = playerId;
    this._initialLogWeights = priorLogWeights(prior);
    this._logWeights = this._initialLogWeights.slice();
    this._knownCards = [];
    this._knownIds = new Set();
    this._stats = normalizeOpponentStats(stats);
    this._history = [];
    this._revision = 0;
    this._cachedRevision = -1;
    this._cachedWeights = null;
    this.setKnownCards(knownCards);
  }

  get stats() { return this._stats; }

  get revision() { return this._revision; }

  get history() { return this._history.slice(); }

  get knownCards() { return this._knownCards.slice(); }

  setStats(stats = {}) {
    this._stats = normalizeOpponentStats(stats);
    return this;
  }

  setKnownCards(cards = []) {
    const ids = excludedIdSet(cards, 'known card');
    this._knownCards = [...ids].map(cardFromId);
    this._knownIds = ids;
    this._touch();
    return this;
  }

  reset({ keepConstraints = false } = {}) {
    if (!keepConstraints) this._logWeights = this._initialLogWeights.slice();
    this._history = [];
    this._touch();
    return this;
  }

  update(actionEvent, context = {}) {
    const event = normalizeActionEvent(actionEvent, context);
    const boardIds = excludedIdSet(event.board, 'board card');
    const nextKnownIds = new Set(this._knownIds);
    for (const id of boardIds) nextKnownIds.add(id);
    const nextLogWeights = this._logWeights.slice();

    let finite = 0;
    for (const combo of HOLE_COMBINATIONS) {
      const index = combo.index;
      if (!Number.isFinite(nextLogWeights[index]) || comboIsExcluded(combo, nextKnownIds)) continue;
      const likelihood = actionLikelihood(combo, event, {}, this._stats);
      nextLogWeights[index] += Math.log(Math.max(MIN_LIKELIHOOD, likelihood));
      finite++;
    }
    if (!finite) throw new RangeError(`Range for ${this.playerId} has no possible combos`);
    this._knownIds = nextKnownIds;
    this._knownCards = [...nextKnownIds].map(cardFromId);
    this._logWeights = nextLogWeights;
    this._history.push(event);
    this._touch();
    return this;
  }

  updateMany(events = [], sharedContext = {}) {
    for (const item of events) {
      if (item && item.event) this.update(item.event, { ...sharedContext, ...(item.context || {}) });
      else this.update(item, sharedContext);
    }
    return this;
  }

  applyConstraint(reveal) {
    const constraints = Array.isArray(reveal) ? reveal : [reveal];
    const predicates = constraints.map(constraintPredicate);
    const keep = new Uint8Array(COMBINATION_COUNT);
    let possible = 0;
    for (const combo of HOLE_COMBINATIONS) {
      if (!Number.isFinite(this._logWeights[combo.index])) continue;
      if (comboIsExcluded(combo, this._knownIds)) continue;
      if (predicates.every((predicate) => predicate(combo, combo.cards))) {
        keep[combo.index] = 1;
        possible++;
      }
    }
    if (!possible) throw new RangeError(`Constraint removes every combo for ${this.playerId}`);
    const nextLogWeights = this._logWeights.slice();
    for (let index = 0; index < nextLogWeights.length; index++) {
      if (!keep[index]) nextLogWeights[index] = NEGATIVE_INFINITY;
    }
    this._logWeights = nextLogWeights;
    this._touch();
    return this;
  }

  /** Multiply the posterior by a non-zero evidence likelihood. */
  applyLikelihood(likelihood, { floor = MIN_LIKELIHOOD, label = 'evidence' } = {}) {
    if (typeof likelihood !== 'function') throw new TypeError('likelihood must be a function');
    const minimum = Math.max(EPSILON, Number(floor) || MIN_LIKELIHOOD);
    const nextLogWeights = this._logWeights.slice();
    let finite = 0;
    for (const combo of HOLE_COMBINATIONS) {
      const index = combo.index;
      if (!Number.isFinite(nextLogWeights[index]) || comboIsExcluded(combo, this._knownIds)) continue;
      const value = Number(likelihood(combo, combo.cards));
      if (!Number.isFinite(value) || value < 0) {
        throw new TypeError('evidence likelihood must return a finite non-negative number');
      }
      nextLogWeights[index] += Math.log(Math.max(minimum, value));
      finite++;
    }
    if (!finite) throw new RangeError(`Range for ${this.playerId} has no possible combos`);
    this._logWeights = nextLogWeights;
    this._history.push(Object.freeze({ kind: 'evidence', label: String(label) }));
    this._touch();
    return this;
  }

  weights({ excludedCards = [] } = {}) {
    if ((!excludedCards || excludedCards.length === 0) && this._cachedRevision === this._revision) {
      return this._cachedWeights.slice();
    }
    const excluded = new Set(this._knownIds);
    for (const id of excludedIdSet(excludedCards)) excluded.add(id);
    const result = normalizedWeights(this._logWeights, excluded);
    if (!excludedCards || excludedCards.length === 0) {
      this._cachedWeights = result;
      this._cachedRevision = this._revision;
    }
    return result.slice();
  }

  probabilityOf(cardsOrCombo, options = {}) {
    const index = comboIndexOf(cardsOrCombo);
    return index < 0 ? 0 : this.weights(options)[index];
  }

  supportCount(options = {}) {
    const weights = this.weights(options);
    let count = 0;
    for (const value of weights) if (value > 0) count++;
    return count;
  }

  top(limit = 10, options = {}) {
    const count = Math.max(0, Math.floor(Number(limit) || 0));
    const weights = this.weights(options);
    return HOLE_COMBINATIONS
      .filter((combo) => weights[combo.index] > 0)
      .map((combo) => ({ combo, cards: combo.cards, probability: weights[combo.index] }))
      .sort((a, b) => b.probability - a.probability || a.combo.index - b.combo.index)
      .slice(0, count);
  }

  sample({ excludedCards = [], rng = Math.random } = {}) {
    return sampleWeightVector(this.weights({ excludedCards }), new Set(), rng);
  }

  _touch() {
    this._revision++;
    this._cachedRevision = -1;
    this._cachedWeights = null;
  }
}

export class RangeSamplingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RangeSamplingError';
  }
}

function randomUnit(rng) {
  if (typeof rng !== 'function') throw new TypeError('rng must be a function');
  const value = Number(rng());
  if (!Number.isFinite(value)) throw new TypeError('rng must return a finite number');
  return clamp(value, 0, 1 - Number.EPSILON);
}

function sampleWeightVector(weights, usedIds, rng) {
  let total = 0;
  for (const combo of HOLE_COMBINATIONS) {
    if (usedIds.has(combo.cardIds[0]) || usedIds.has(combo.cardIds[1])) continue;
    total += weights[combo.index];
  }
  if (!(total > 0)) return null;
  let target = randomUnit(rng) * total;
  let fallback = null;
  for (const combo of HOLE_COMBINATIONS) {
    if (usedIds.has(combo.cardIds[0]) || usedIds.has(combo.cardIds[1])) continue;
    const weight = weights[combo.index];
    if (!(weight > 0)) continue;
    fallback = combo.cards;
    target -= weight;
    if (target < 0) return combo.cards;
  }
  return fallback;
}

function weightedCandidateOrder(weights, usedIds, rng) {
  const candidates = [];
  for (const combo of HOLE_COMBINATIONS) {
    const weight = weights[combo.index];
    if (!(weight > 0) || usedIds.has(combo.cardIds[0]) || usedIds.has(combo.cardIds[1])) continue;
    const unit = Math.max(EPSILON, randomUnit(rng));
    candidates.push({ combo, priority: -Math.log(unit) / weight });
  }
  candidates.sort((a, b) => a.priority - b.priority || a.combo.index - b.combo.index);
  return candidates.map((candidate) => candidate.combo);
}

function prepareSamplingRecords(ranges, excludedCards) {
  if (!Array.isArray(ranges)) throw new TypeError('ranges must be an array');
  if (ranges.length > MAX_OPPONENTS) {
    throw new RangeError(`A ${MAX_TABLE_PLAYERS}-player table has at most ${MAX_OPPONENTS} opponents`);
  }
  return ranges.map((range, index) => {
    if (!range || typeof range.weights !== 'function') {
      throw new TypeError('Each range must expose weights({ excludedCards })');
    }
    const weights = range.weights({ excludedCards });
    let support = 0;
    let total = 0;
    const comboIndexes = [];
    const cumulative = [];
    for (const combo of HOLE_COMBINATIONS) {
      const value = weights[combo.index];
      if (!(value > 0)) continue;
      support++;
      total += value;
      comboIndexes.push(combo.index);
      cumulative.push(total);
    }
    if (!support) throw new RangeSamplingError(`Range at index ${index} has no available combos`);
    return { index, weights, support, total, comboIndexes, cumulative };
  });
}

function sampleIndependentRecord(record, rng) {
  const target = randomUnit(rng) * record.total;
  let low = 0;
  let high = record.cumulative.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (target < record.cumulative[middle]) high = middle;
    else low = middle + 1;
  }
  return HOLE_COMBINATIONS[record.comboIndexes[low]].cards;
}

function samplePreparedRanges(
  records,
  initialUsed,
  { rng, maxRestarts, maxBacktrackNodes },
) {

  // Exact conditional sampler for the overwhelmingly common case: draw every
  // range independently, then reject the entire joint proposal if any physical
  // card collides. Accepted proposals have density proportional to the product
  // of all range weights and are therefore independent of input order.
  const attempts = Math.max(1, Math.floor(Number(maxRestarts) || 1));
  for (let attempt = 0; attempt < attempts; attempt++) {
    const used = new Set(initialUsed);
    const result = new Array(records.length);
    let complete = true;
    for (const record of records) {
      const cards = sampleIndependentRecord(record, rng);
      const firstId = cardId(cards[0]);
      const secondId = cardId(cards[1]);
      if (used.has(firstId) || used.has(secondId)) { complete = false; break; }
      result[record.index] = cards;
      used.add(firstId);
      used.add(secondId);
    }
    if (complete) return result;
  }

  // Very narrow overlapping ranges can make whole-proposal rejection slow.
  // Enumerate all legal assignments when the constrained tree is small, then
  // draw exactly by product mass. This also handles disconnected modes that a
  // single-site Gibbs chain cannot move between (for example X/Y vs Y/X).
  const constrainedRecords = [...records]
    .sort((a, b) => a.support - b.support || a.index - b.index);
  const enumerationUsed = new Set(initialUsed);
  const assignment = new Array(records.length);
  const solutions = [];
  let enumerationNodes = 0;
  let enumerationAborted = false;
  const enumerate = (depth, logMass) => {
    if (++enumerationNodes > maxBacktrackNodes) {
      enumerationAborted = true;
      return;
    }
    if (depth === constrainedRecords.length) {
      solutions.push({ cards: assignment.map((cards) => cards), logMass });
      return;
    }
    const record = constrainedRecords[depth];
    for (const combo of HOLE_COMBINATIONS) {
      const weight = record.weights[combo.index];
      if (!(weight > 0)
        || enumerationUsed.has(combo.cardIds[0]) || enumerationUsed.has(combo.cardIds[1])) continue;
      enumerationUsed.add(combo.cardIds[0]);
      enumerationUsed.add(combo.cardIds[1]);
      assignment[record.index] = combo.cards;
      enumerate(depth + 1, logMass + Math.log(weight));
      assignment[record.index] = undefined;
      enumerationUsed.delete(combo.cardIds[0]);
      enumerationUsed.delete(combo.cardIds[1]);
      if (enumerationAborted) return;
    }
  };
  enumerate(0, 0);
  if (!enumerationAborted) {
    if (!solutions.length) {
      throw new RangeSamplingError('No non-overlapping assignment exists for the supplied ranges');
    }
    const maxLogMass = Math.max(...solutions.map((solution) => solution.logMass));
    let totalMass = 0;
    const masses = solutions.map((solution) => {
      const mass = Math.exp(solution.logMass - maxLogMass);
      totalMass += mass;
      return mass;
    });
    let target = randomUnit(rng) * totalMass;
    for (let index = 0; index < solutions.length; index++) {
      target -= masses[index];
      if (target < 0) return solutions[index].cards;
    }
    return solutions[solutions.length - 1].cards;
  }

  // A rare broad-range rejection failure can exceed the exact enumeration
  // cap. Find a legal seed and mix it with Gibbs updates plus pair-swap MH.
  const result = new Array(records.length);
  const used = new Set(initialUsed);
  let visited = 0;
  const search = (depth) => {
    if (depth === constrainedRecords.length) return true;
    if (++visited > maxBacktrackNodes) return false;
    const record = constrainedRecords[depth];
    const candidates = weightedCandidateOrder(record.weights, used, rng);
    for (const combo of candidates) {
      const [firstId, secondId] = combo.cardIds;
      used.add(firstId);
      used.add(secondId);
      result[record.index] = combo.cards;
      if (search(depth + 1)) return true;
      result[record.index] = undefined;
      used.delete(firstId);
      used.delete(secondId);
    }
    return false;
  };
  if (!search(0)) {
    throw new RangeSamplingError('No non-overlapping assignment exists for the supplied ranges');
  }

  const sweeps = Math.max(24, records.length * 6);
  for (let sweep = 0; sweep < sweeps; sweep++) {
    const order = [...records];
    for (let index = order.length - 1; index > 0; index--) {
      const swap = Math.floor(randomUnit(rng) * (index + 1));
      [order[index], order[swap]] = [order[swap], order[index]];
    }
    for (const record of order) {
      const previous = result[record.index];
      if (previous) {
        used.delete(cardId(previous[0]));
        used.delete(cardId(previous[1]));
      }
      const replacement = sampleWeightVector(record.weights, used, rng);
      if (replacement) result[record.index] = replacement;
      const selected = result[record.index];
      used.add(cardId(selected[0]));
      used.add(cardId(selected[1]));
    }
    if (records.length >= 2) {
      const firstAt = Math.floor(randomUnit(rng) * records.length);
      let secondAt = Math.floor(randomUnit(rng) * (records.length - 1));
      if (secondAt >= firstAt) secondAt++;
      const firstRecord = records[firstAt];
      const secondRecord = records[secondAt];
      const firstCards = result[firstRecord.index];
      const secondCards = result[secondRecord.index];
      const firstComboIndex = comboIndexOf(firstCards);
      const secondComboIndex = comboIndexOf(secondCards);
      const currentMass = firstRecord.weights[firstComboIndex]
        * secondRecord.weights[secondComboIndex];
      const swappedMass = firstRecord.weights[secondComboIndex]
        * secondRecord.weights[firstComboIndex];
      if (swappedMass > 0 && randomUnit(rng) < Math.min(1, swappedMass / currentMass)) {
        result[firstRecord.index] = secondCards;
        result[secondRecord.index] = firstCards;
      }
    }
  }
  return result;
}

/**
 * Compile fixed range posteriors/blockers once, then draw many exact joint
 * conditional samples without rebuilding 1,326-entry distributions.
 */
export function prepareRangeSampler(
  ranges,
  { excludedCards = [], maxRestarts = 128, maxBacktrackNodes = 20000 } = {},
) {
  const initialUsed = excludedIdSet(excludedCards);
  const records = prepareSamplingRecords(ranges, excludedCards);
  const options = Object.freeze({
    maxRestarts: Math.max(1, Math.floor(Number(maxRestarts) || 1)),
    maxBacktrackNodes: Math.max(1, Math.floor(Number(maxBacktrackNodes) || 1)),
  });
  return Object.freeze({
    size: records.length,
    sample({ rng = Math.random } = {}) {
      return samplePreparedRanges(records, initialUsed, { ...options, rng });
    },
  });
}

/**
 * Samples multiple posterior ranges jointly without reusing physical cards.
 * Accepted proposals follow the product of range weights conditioned on all
 * cards being distinct; input and output arrays have matching order.
 */
export function sampleRangesWithoutReplacement(
  ranges,
  { excludedCards = [], rng = Math.random, maxRestarts = 128, maxBacktrackNodes = 20000 } = {},
) {
  return prepareRangeSampler(ranges, {
    excludedCards,
    maxRestarts,
    maxBacktrackNodes,
  }).sample({ rng });
}

export class OpponentRangeModel {
  constructor(
    playerIds = [],
    { knownCards = [], statsByPlayer = {}, priorByPlayer = {}, tableSize = MAX_TABLE_PLAYERS } = {},
  ) {
    this.tableSize = Math.round(Number(tableSize));
    if (!Number.isInteger(this.tableSize) || this.tableSize < 2 || this.tableSize > MAX_TABLE_PLAYERS) {
      throw new RangeError(`tableSize must be 2..${MAX_TABLE_PLAYERS}`);
    }
    if (!Array.isArray(playerIds) || playerIds.length > this.tableSize - 1) {
      throw new RangeError(`tableSize ${this.tableSize} permits at most ${this.tableSize - 1} opponents`);
    }
    this._knownCards = [...knownCards];
    this._ranges = new Map();
    this._revealedOwners = new Map();
    for (const playerId of playerIds) {
      this.addPlayer(playerId, {
        stats: valueForPlayer(statsByPlayer, playerId) || {},
        prior: valueForPlayer(priorByPlayer, playerId),
      });
    }
  }

  get size() { return this._ranges.size; }

  get(playerId) { return this._ranges.get(playerId); }

  getRange(playerId) { return this.get(playerId); }

  ranges() { return new Map(this._ranges); }

  addPlayer(playerId, { stats = {}, prior } = {}) {
    if (this._ranges.has(playerId)) return this._ranges.get(playerId);
    if (this._ranges.size >= this.tableSize - 1) {
      throw new RangeError(`tableSize ${this.tableSize} permits at most ${this.tableSize - 1} opponents`);
    }
    const range = new OpponentRange(playerId, { stats, prior, knownCards: this._knownCards });
    for (const [id, owner] of this._revealedOwners) {
      if (owner !== playerId) range.applyConstraint({ type: 'EXCLUDE_CARD', card: cardFromId(id) });
    }
    this._ranges.set(playerId, range);
    return range;
  }

  removePlayer(playerId) {
    return this._ranges.delete(playerId);
  }

  setKnownCards(cards = []) {
    this._knownCards = [...cards];
    for (const range of this._ranges.values()) range.setKnownCards(cards);
    return this;
  }

  setStats(playerId, stats = {}) {
    return this._required(playerId).setStats(stats);
  }

  update(playerId, event, context = {}) {
    return this._required(playerId).update(event, context);
  }

  updateMany(events = [], sharedContext = {}) {
    for (const item of events) {
      const playerId = item.playerId ?? item.idx ?? item.seat;
      if (playerId == null) throw new TypeError('Each ActionEvent must identify playerId, idx or seat');
      this.update(playerId, item.event || item, { ...sharedContext, ...(item.context || {}) });
    }
    return this;
  }

  constrain(playerId, reveal) {
    const range = this._required(playerId);
    range.applyConstraint(reveal);
    for (const card of revealedExactCards(reveal)) {
      const id = cardId(card);
      const owner = this._revealedOwners.get(id);
      if (owner != null && owner !== playerId) {
        throw new RangeError(`${cardKey(card)} is already revealed for another player`);
      }
      this._revealedOwners.set(id, playerId);
      for (const [otherId, otherRange] of this._ranges) {
        if (otherId !== playerId) otherRange.applyConstraint({ type: 'EXCLUDE_CARD', card });
      }
    }
    return range;
  }

  sampleAll(
    playerIds = [...this._ranges.keys()],
    { excludedCards = [], rng = Math.random, maxRestarts = 128, maxBacktrackNodes = 20000 } = {},
  ) {
    const ids = Array.isArray(playerIds) ? playerIds : [...playerIds];
    const selected = ids.map((playerId) => this._required(playerId));
    const cards = sampleRangesWithoutReplacement(selected, {
      excludedCards: [...this._knownCards, ...excludedCards],
      rng,
      maxRestarts,
      maxBacktrackNodes,
    });
    return new Map(ids.map((playerId, index) => [playerId, cards[index]]));
  }

  _required(playerId) {
    const range = this._ranges.get(playerId);
    if (!range) throw new RangeError(`Unknown opponent: ${String(playerId)}`);
    return range;
  }
}

function valueForPlayer(source, playerId) {
  if (source instanceof Map) return source.get(playerId);
  if (source && Object.prototype.hasOwnProperty.call(source, playerId)) return source[playerId];
  return undefined;
}
