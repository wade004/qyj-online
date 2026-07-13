import assert from 'node:assert/strict';

import {
  COMBINATION_COUNT,
  HOLE_COMBINATIONS,
  MAX_OPPONENTS,
  OpponentRange,
  OpponentRangeModel,
  RangeSamplingError,
  actionLikelihood,
  cardId,
  comboFeatures,
  derivePublicOpponentStats,
  enumerateHoleCombinations,
  normalizeOpponentStats,
  sampleRangesWithoutReplacement,
} from '../js/game/opponent-range.js';

const C = (rank, suit) => ({ rank, suit });
const sum = (values) => values.reduce((total, value) => total + value, 0);
const support = (weights) => [...weights].filter((value) => value > 0).length;
const approx = (actual, expected, tolerance, message) => {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, received ${actual}`);
};

function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// Every physical pair appears exactly once.
assert.equal(enumerateHoleCombinations(), HOLE_COMBINATIONS,
  'enumeration should return the immutable shared combo table');
assert.equal(HOLE_COMBINATIONS.length, COMBINATION_COUNT);
assert.equal(COMBINATION_COUNT, 1326);
const comboKeys = new Set();
for (const combo of HOLE_COMBINATIONS) {
  assert.equal(combo.cards.length, 2);
  assert.notEqual(cardId(combo.cards[0]), cardId(combo.cards[1]));
  comboKeys.add(combo.key);
}
assert.equal(comboKeys.size, 1326, 'all physical combinations must be unique');

// Public/private known cards block impossible combos and renormalize exactly.
const blockers = [C(14, 1), C(13, 2)];
const blockedRange = new OpponentRange('blocked', { knownCards: blockers });
const blockedWeights = blockedRange.weights();
assert.equal(support(blockedWeights), 1225, 'C(50,2) combos remain after two known cards');
approx(sum(blockedWeights), 1, 1e-12, 'blocked range must remain normalized');
for (const combo of HOLE_COMBINATIONS) {
  if (combo.cards.some((card) => blockers.some((known) => cardId(card) === cardId(known)))) {
    assert.equal(blockedWeights[combo.index], 0, 'known cards must have zero posterior mass');
  }
}
assert.equal(blockedRange.supportCount({ excludedCards: [C(12, 3)] }), 1176,
  'per-sample exclusions additionally leave C(49,2) combos');

// A full ActionEvent performs a continuous Bayesian update rather than replacing the range.
const raiseEvent = {
  type: 'raise',
  key: 'fierce',
  street: 'preflop',
  amount: 100,
  potBefore: 120,
  toCallBefore: 20,
  currentBetBefore: 40,
  betStreetBefore: 20,
  streetRaiseCountBefore: 1,
  isAggressive: true,
  activeCount: 9,
  position: 'utg',
};
const aces = [C(14, 1), C(14, 2)];
const sevenDeuce = [C(7, 1), C(2, 2)];
const bayesRange = new OpponentRange('bayes');
const firstLikelihoodRatio = actionLikelihood(aces, raiseEvent)
  / actionLikelihood(sevenDeuce, raiseEvent);
bayesRange.update(raiseEvent);
const posteriorRatio1 = bayesRange.probabilityOf(aces) / bayesRange.probabilityOf(sevenDeuce);
approx(posteriorRatio1, firstLikelihoodRatio, firstLikelihoodRatio * 1e-10,
  'first posterior odds should equal prior odds times likelihood ratio');
bayesRange.update(raiseEvent);
const posteriorRatio2 = bayesRange.probabilityOf(aces) / bayesRange.probabilityOf(sevenDeuce);
approx(posteriorRatio2, firstLikelihoodRatio ** 2, firstLikelihoodRatio ** 2 * 1e-10,
  'second action must multiply the existing posterior again');
assert.equal(bayesRange.history.length, 2, 'the complete ordered action history is retained');
assert.equal(bayesRange.history[0].streetRaiseCountBefore, 1);

// Board blockers must be excluded before postflop feature evaluation. The
// update is transactional: impossible duplicate-card holdings are never sent
// to the evaluator and a failed likelihood cannot leave a half-mutated range.
const pairedRiver = [C(3, 1), C(6, 2), C(3, 3), C(4, 3), C(11, 3)];
const riverRange = new OpponentRange('river-blockers');
riverRange.update({
  type: 'raise', street: 'river', board: pairedRiver, amount: 265,
  potBefore: 800, isAggressive: true, playersInHand: 2, position: 'SB',
});
assert.equal(riverRange.history.length, 1);
assert.equal(riverRange.supportCount(), 1081, 'five board cards leave C(47,2) legal combos');
riverRange.applyLikelihood((combo) => comboFeatures(combo, pairedRiver).made + 0.01, {
  label: 'river-strength',
});
assert.equal(riverRange.supportCount(), 1081,
  'soft river evidence must preserve every legal physical holding');

const transactionalRange = new OpponentRange('transactional', { knownCards: pairedRiver });
const beforeBadEvidence = transactionalRange.weights();
assert.throws(() => transactionalRange.applyLikelihood((combo) => {
  if (combo.index === 101) return Number.NaN;
  return 1 + combo.index / COMBINATION_COUNT;
}), TypeError);
assert.deepEqual(transactionalRange.weights(), beforeBadEvidence,
  'invalid evidence must not partially mutate posterior log weights');
assert.equal(transactionalRange.history.length, 0);

// Position/player count and reliable loose-aggressive HUD data affect action likelihoods.
const headsUpButtonRaise = actionLikelihood(sevenDeuce, {
  ...raiseEvent, activeCount: 2, position: 'button', toCallBefore: 0,
  currentBetBefore: 0, betStreetBefore: 0,
});
const nineHandedUtgRaise = actionLikelihood(sevenDeuce, {
  ...raiseEvent, activeCount: 9, position: 'utg', toCallBefore: 0,
  currentBetBefore: 0, betStreetBefore: 0,
});
assert.ok(headsUpButtonRaise > nineHandedUtgRaise,
  'late-position heads-up weak raises should be more plausible than nine-handed UTG raises');

const looseAggressive = normalizeOpponentStats({
  hands: 500, vpip: 48, pfr: 38, threeBet: 18, af: 5, cbet: 78,
});
const tightPassive = normalizeOpponentStats({
  hands: 500, vpip: 16, pfr: 11, threeBet: 3, af: 1, cbet: 38,
});
assert.ok(actionLikelihood(sevenDeuce, raiseEvent, {}, looseAggressive)
  > actionLikelihood(sevenDeuce, raiseEvent, {}, tightPassive) * 2,
  'weak aggression should be materially likelier for an observed loose-aggressive player');

const derivedStats = derivePublicOpponentStats({
  observerIdx: 1,
  handSeats: [1, 2, 3],
  round: 2,
  actionHistory: [
    {
      id: 1, actorIdx: 2, round: 1, street: 'preflop', type: 'raise',
      key: 'feint', isAggressive: true, forced: false, handSeats: [1, 2, 3],
    },
    {
      id: 2, actorIdx: 3, round: 1, street: 'preflop', type: 'raise',
      key: 'strike', isAggressive: true, forced: false, handSeats: [1, 2, 3],
    },
  ],
});
assert.equal(derivedStats.get(2).hands, 2);
assert.equal(derivedStats.get(2).vpip, 0.5);
assert.equal(derivedStats.get(2).pfr, 0.5);
assert.equal(derivedStats.get(2).threeBet, 0);
assert.equal(derivedStats.get(2).threeBetOpportunities, 0);
assert.equal(derivedStats.get(3).threeBet, 0.5,
  'public aggression order must distinguish a later preflop re-raise');
assert.equal(derivedStats.get(3).threeBetCount, 1);
assert.equal(derivedStats.get(3).threeBetOpportunities, 1);
const noOpportunityStats = normalizeOpponentStats({
  ...derivedStats.get(2), evidenceWeighted: true,
});
const facedRaiseStats = normalizeOpponentStats({
  ...derivedStats.get(3), evidenceWeighted: true,
});
assert.equal(noOpportunityStats.threeBet, 0.08,
  'no three-bet opportunity must retain the population prior');
assert(facedRaiseStats.threeBet > noOpportunityStats.threeBet,
  'a real re-raise must update the opportunity-weighted posterior');

// Skill information is applied as a true zero/one constraint.
const revealed = C(11, 3);
const exactRange = new OpponentRange('peeked');
exactRange.applyConstraint({ kind: 'peek_hole', card: revealed });
const exactWeights = exactRange.weights();
assert.equal(support(exactWeights), 51, 'one exact revealed card leaves 51 possible partners');
for (const combo of HOLE_COMBINATIONS) {
  if (exactWeights[combo.index] > 0) {
    assert.ok(combo.cardIds.includes(cardId(revealed)), 'every surviving combo must contain revealed card');
  }
}

const suitRange = new OpponentRange('suit');
suitRange.applyConstraint({ type: 'HOLE_SUIT_CONTAINS', suit: 4 });
assert.equal(suitRange.supportCount(), 585,
  'at-least-one-suit constraint leaves 1326-C(39,2) combos');
suitRange.applyConstraint({ type: 'HOLE_SAME_SUIT' });
assert.equal(suitRange.supportCount(), 78, 'same-suit intersection leaves C(13,2) combos');

const conditionRange = new OpponentRange('skill-condition');
conditionRange.applyConstraint([
  { type: 'HOLE_RANK_AT_LEAST', rank: 12 },
  { type: 'HOLE_DIFFERENT_SUIT' },
  { type: 'HOLE_RANK_SUM_MIN', value: 20 },
]);
for (const { cards } of conditionRange.top(2000)) {
  assert.ok(cards.some((card) => card.rank >= 12));
  assert.notEqual(cards[0].suit, cards[1].suit);
  assert.ok(cards[0].rank + cards[1].rank >= 20);
}

// Joint sampling supports a full nine-player table and never reuses a card.
const playerIds = Array.from({ length: MAX_OPPONENTS }, (_, index) => `p${index + 2}`);
const model = new OpponentRangeModel(playerIds, {
  tableSize: 9,
  knownCards: [C(14, 4), C(13, 4), C(2, 1), C(8, 2), C(9, 3)],
});
model.constrain('p2', { kind: 'peek_hole', card: C(12, 1) });
model.constrain('p3', { type: 'HOLE_SUIT_CONTAINS', suit: 2 });
assert.equal(model.get('p2').supportCount(), 46,
  'revealed owner range contains its card while respecting five common blockers');
assert.equal(model.get('p3').probabilityOf([C(12, 1), C(7, 2)]), 0,
  'an exact card owned by one opponent is hard-blocked from every other range');

const sampled = model.sampleAll(playerIds, { rng: seededRng(0xC0FFEE) });
assert.equal(sampled.size, 8);
const dealtIds = new Set([C(14, 4), C(13, 4), C(2, 1), C(8, 2), C(9, 3)].map(cardId));
for (const [playerId, cards] of sampled) {
  assert.equal(cards.length, 2, `${playerId} must receive two cards`);
  for (const card of cards) {
    const id = cardId(card);
    assert.ok(!dealtIds.has(id), `physical card ${id} was reused`);
    dealtIds.add(id);
  }
}
assert.ok(sampled.get('p2').some((card) => cardId(card) === cardId(C(12, 1))),
  'sample for peeked player must contain the revealed card');
assert.ok(sampled.get('p3').some((card) => card.suit === 2),
  'sample must obey the suit constraint');

// Standalone sampler has deterministic RNG injection and rejects impossible joint deals.
const deterministicA = sampleRangesWithoutReplacement(
  [new OpponentRange('a'), new OpponentRange('b')],
  { excludedCards: [C(14, 1)], rng: seededRng(1234) },
);
const deterministicB = sampleRangesWithoutReplacement(
  [new OpponentRange('a'), new OpponentRange('b')],
  { excludedCards: [C(14, 1)], rng: seededRng(1234) },
);
assert.deepEqual(deterministicA, deterministicB, 'same RNG seed must reproduce the same sampled deal');

// Conditioning on physical-card exclusivity must sample the product of range
// weights, not whichever opponent happens to be processed first.
const A1 = [C(2, 1), C(3, 1)];
const A2 = [C(4, 1), C(5, 1)];
const B1 = [C(2, 1), C(6, 1)];
const B2 = [C(7, 1), C(8, 1)];
const pairKey = (cards) => cards.map(cardId).sort((a, b) => a - b).join(':');
const weightedRange = (id, entries) => {
  const weights = new Map(entries.map(([cards, weight]) => [pairKey(cards), weight]));
  return new OpponentRange(id, { prior: (combo) => weights.get(pairKey(combo.cards)) || 0 });
};
const sampleAFirst = (reverse) => {
  const rangeA = weightedRange('order-a', [[A1, 0.5], [A2, 0.5]]);
  const rangeB = weightedRange('order-b', [[B1, 0.9], [B2, 0.1]]);
  const rng = seededRng(1);
  let a1Count = 0;
  const samples = 6000;
  for (let index = 0; index < samples; index++) {
    const holes = sampleRangesWithoutReplacement(
      reverse ? [rangeB, rangeA] : [rangeA, rangeB],
      { rng, maxRestarts: 32 },
    );
    const aCards = holes[reverse ? 1 : 0];
    if (pairKey(aCards) === pairKey(A1)) a1Count++;
  }
  return a1Count / samples;
};
const forwardA1 = sampleAFirst(false);
const reverseA1 = sampleAFirst(true);
approx(forwardA1, 1 / 11, 0.025, 'joint sampler must match conditional product mass');
approx(reverseA1, 1 / 11, 0.025, 'reversing players must preserve conditional product mass');
approx(forwardA1, reverseA1, 0.025, 'joint sampler must not depend on input order');

const disconnectedShare = (reverse) => {
  const first = weightedRange('disconnected-a', [[A1, 0.999], [A2, 0.001]]);
  const second = weightedRange('disconnected-b', [[A1, 0.999], [A2, 0.001]]);
  const rng = seededRng(77);
  let firstHasA1 = 0;
  const samples = 1000;
  for (let index = 0; index < samples; index++) {
    const holes = sampleRangesWithoutReplacement(
      reverse ? [second, first] : [first, second],
      { rng, maxRestarts: 1, maxBacktrackNodes: 100 },
    );
    if (pairKey(holes[reverse ? 1 : 0]) === pairKey(A1)) firstHasA1++;
  }
  return firstHasA1 / samples;
};
const disconnectedForward = disconnectedShare(false);
const disconnectedReverse = disconnectedShare(true);
approx(disconnectedForward, 0.5, 0.06,
  'small disconnected assignment trees must be sampled by exact product mass');
approx(disconnectedReverse, 0.5, 0.06,
  'disconnected exact fallback must remain invariant to player order');

const impossibleA = new OpponentRange('impossible-a');
const impossibleB = new OpponentRange('impossible-b');
impossibleA.applyConstraint({ type: 'EXACT_CARD', card: C(10, 1) });
impossibleB.applyConstraint({ type: 'EXACT_CARD', card: C(10, 1) });
assert.throws(
  () => sampleRangesWithoutReplacement([impossibleA, impossibleB], {
    rng: seededRng(9), maxRestarts: 2, maxBacktrackNodes: 5000,
  }),
  RangeSamplingError,
  'two players cannot both own the same revealed physical card',
);

console.log('Opponent range tests passed: 1326 combos, Bayesian updates, skill constraints, 9-player sampling.');
