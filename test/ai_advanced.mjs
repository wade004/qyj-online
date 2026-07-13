import assert from 'node:assert/strict';

import { Engine } from '../js/game/engine.js';
import { HEROES } from '../js/game/heroes.js';
import * as AI from '../js/game/ai.js';
import { buildObservation } from '../js/game/observation.js';
import {
  BLUEPRINT_ABSTRACTION,
  BLUEPRINT_SCHEMA,
  BLUEPRINT_VERSION,
  buildBlueprintInfoSetKey,
} from '../js/game/blueprint-policy.js';
import {
  drawProfile,
  mixedPolicy,
  normalizePolicyOptions,
  postflopPolicy,
  preflopWagerEv,
  preflopPolicy,
  tablePosition,
  tournamentRiskAdjustment,
} from '../js/game/ai-policy.js';
import {
  OpponentRange,
  cardId,
  sampleRangesWithoutReplacement,
} from '../js/game/opponent-range.js';
import { estimateAgainstRanges } from '../js/game/winrate.js';

const C = (rank, suit) => ({ rank, suit });

assert.equal(tournamentRiskAdjustment({
  round: 4, maxRounds: 12, hp: 2000, allHps: [2000, 1500, 1000], continuous: true,
}), 0, 'continuous tournament risk must stay neutral early');
const leaderRisk = tournamentRiskAdjustment({
  round: 12, maxRounds: 12, hp: 2000, allHps: [2000, 1500, 1000], continuous: true,
});
const shortRisk = tournamentRiskAdjustment({
  round: 12, maxRounds: 12, hp: 1000, allHps: [2000, 1500, 1000], continuous: true,
});
assert(leaderRisk > 0 && shortRisk < 0 && leaderRisk > Math.abs(shortRisk),
  'continuous risk must protect leaders while allowing bounded short-stack urgency');

const headsUpWagerEv = preflopWagerEv({
  pot: 150, cost: 300, equity: 0.55, numOpponents: 1, foldTendency: 0.5,
});
const headsUpAdjustedWagerEv = preflopWagerEv({
  pot: 150, cost: 300, equity: 0.55, numOpponents: 1, foldTendency: 0.5,
  adjustForCallers: true,
});
approx(headsUpAdjustedWagerEv, headsUpWagerEv, 1e-9,
  'caller projection must be neutral heads-up');
const multiwayLegacyWagerEv = preflopWagerEv({
  pot: 150, cost: 300, equity: 0.16, numOpponents: 8, foldTendency: 0.6,
});
const multiwayAdjustedWagerEv = preflopWagerEv({
  pot: 150, cost: 300, equity: 0.16, numOpponents: 8, foldTendency: 0.6,
  adjustForCallers: true,
});
assert(multiwayAdjustedWagerEv > multiwayLegacyWagerEv,
  'caller projection must restore equity when a multiway field folds down');
const multiwayShrunkWagerEv = preflopWagerEv({
  pot: 150, cost: 300, equity: 0.16, numOpponents: 8, foldTendency: 0.6,
  adjustForCallers: true, callerProjectionWeight: 0.55,
});
assert(multiwayShrunkWagerEv > multiwayLegacyWagerEv
  && multiwayShrunkWagerEv < multiwayAdjustedWagerEv,
  'caller projection shrinkage must interpolate between legacy and full projection');
const directCallerWagerEv = preflopWagerEv({
  pot: 150, cost: 300, equity: 0.16, numOpponents: 3,
  foldTendencies: [0.45, 0.6, 0.75],
  opponentEquities: [0.48, 0.62, 0.72], directCallerEquity: true,
});
const strongerCallerWagerEv = preflopWagerEv({
  pot: 150, cost: 300, equity: 0.16, numOpponents: 3,
  foldTendencies: [0.45, 0.6, 0.75],
  opponentEquities: [0.38, 0.52, 0.62], directCallerEquity: true,
});
assert(directCallerWagerEv > strongerCallerWagerEv,
  'direct caller EV must decrease against stronger caller ranges');

function approx(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, received ${actual}`);
}

function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function expectedPositions(count) {
  const byCount = {
    2: ['BTN/SB', 'BB'],
    3: ['BTN', 'SB', 'BB'],
    4: ['BTN', 'SB', 'BB', 'CO'],
    5: ['BTN', 'SB', 'BB', 'UTG', 'CO'],
    6: ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'],
    7: ['BTN', 'SB', 'BB', 'UTG', 'LJ', 'HJ', 'CO'],
    8: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'LJ', 'HJ', 'CO'],
    9: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO'],
  };
  return byCount[count];
}

function assertPositionMap(seats, dealer, label) {
  const sorted = [...new Set(seats)].sort((a, b) => a - b);
  const dealerAt = sorted.indexOf(dealer);
  const order = sorted.slice(dealerAt).concat(sorted.slice(0, dealerAt));
  const expected = expectedPositions(sorted.length);
  for (let distance = 0; distance < order.length; distance++) {
    const result = tablePosition(order[distance], dealer, [...seats].reverse());
    assert.equal(result.name, expected[distance],
      `${label}: seat ${order[distance]} at distance ${distance}`);
    assert.equal(result.distance, distance, `${label}: distance should be canonical`);
    assert.equal(result.count, sorted.length, `${label}: player count should be retained`);
  }
}

// Canonical and sparse seat maps must agree for every supported table size.
const sparseSeats = {
  2: { seats: [2, 9], dealer: 9 },
  3: { seats: [1, 5, 8], dealer: 5 },
  4: { seats: [1, 3, 6, 9], dealer: 6 },
  5: { seats: [1, 2, 4, 7, 9], dealer: 7 },
  6: { seats: [1, 2, 4, 5, 7, 9], dealer: 5 },
  7: { seats: [1, 2, 3, 5, 6, 8, 9], dealer: 6 },
  8: { seats: [1, 2, 3, 4, 6, 7, 8, 9], dealer: 7 },
  9: { seats: [1, 2, 3, 4, 5, 6, 7, 8, 9], dealer: 7 },
};
for (let count = 2; count <= 9; count++) {
  const canonical = Array.from({ length: count }, (_, index) => index + 1);
  assertPositionMap(canonical, 1, `${count}-handed canonical`);
  assertPositionMap(sparseSeats[count].seats, sparseSeats[count].dealer,
    `${count}-handed sparse`);
}

// Straight outs count only improvements that use a hero hole card. A straight
// already present on the board is not a hero draw.
const boardStraightOnly = drawProfile([C(14, 1), C(2, 2)], [
  C(5, 1), C(6, 2), C(7, 3), C(8, 4),
]);
assert.equal(boardStraightOnly.straightDraw, false,
  '5678 board with A2 must not be reported as a hero straight draw');
assert.equal(boardStraightOnly.outs, 0,
  'board-only 4/9 straight completions must not count as hero outs');

const wheelGutshot = drawProfile([C(14, 1), C(2, 2)], [C(3, 3), C(4, 4), C(9, 1)]);
assert.equal(wheelGutshot.outs, 4, 'A234 has four five outs');
assert.equal(wheelGutshot.gutshot, true, 'A234 is a gutshot boundary draw');

const broadwayGutshot = drawProfile([C(14, 1), C(13, 2)], [C(12, 3), C(11, 4), C(2, 1)]);
assert.equal(broadwayGutshot.outs, 4, 'JQKA has four ten outs');
assert.equal(broadwayGutshot.gutshot, true, 'JQKA is a gutshot boundary draw');

const kingOpenEnded = drawProfile([C(10, 1), C(11, 2)], [C(12, 3), C(13, 4), C(2, 1)]);
assert.equal(kingOpenEnded.outs, 8, 'TJQK has four nines and four aces as outs');
assert.equal(kingOpenEnded.openEnded, true, 'TJQK is open-ended');

const wheelOpenEnded = drawProfile([C(2, 1), C(3, 2)], [C(4, 3), C(5, 4), C(9, 1)]);
assert.equal(wheelOpenEnded.outs, 8, '2345 has four aces and four sixes as outs');
assert.equal(wheelOpenEnded.openEnded, true, '2345 is open-ended');

// Observation-shaped legal options are normalized once at the policy boundary.
const observationOptions = {
  toCall: 30,
  canCheck: false,
  callAmount: 30,
  allInAmount: 500,
  canRaise: true,
  canAllIn: true,
  tiers: [{ key: 'strike', name: 'Strike', increment: 80, cost: 110 }],
};
const normalizedOptions = normalizePolicyOptions(observationOptions);
assert.equal(normalizedOptions.callAmt, 30);
assert.equal(normalizedOptions.allinAmt, 500);
assert.equal(normalizedOptions.allInRaises, true);
assert.deepEqual(normalizedOptions.tiers[0], {
  key: 'strike', name: 'Strike', inc: 80, cost: 110,
});
const normalizedTierPolicy = preflopPolicy({
  quality: 0.999,
  rangeEquity: 0.86,
  position: 'BTN',
  tableSize: 6,
  stackBb: 50,
  potOdds: 0.1,
  raiseCount: 0,
  limpers: 0,
  opts: observationOptions,
  pot: 100,
  rng: () => 0,
});
assert.equal(normalizedTierPolicy.action.type, 'raise',
  'premium hand should expose a normalized raise candidate');
assert.equal(normalizedTierPolicy.action.tier.inc, 80);
assert.equal(normalizedTierPolicy.action.tier.cost, 110);

// draws and tournamentRisk are optional; the policy derives safe defaults.
assert.doesNotThrow(() => postflopPolicy({
  hole: [C(14, 2), C(13, 2)],
  board: [C(12, 2), C(11, 2), C(3, 1)],
  equity: 0.55,
  numOpponents: 2,
  opts: {
    toCall: 0,
    canCheck: true,
    callAmount: 0,
    allInAmount: 400,
    canRaise: true,
    canAllIn: true,
    tiers: [{ key: 'feint', name: 'Feint', increment: 35, cost: 35 }],
  },
  pot: 100,
  stack: 400,
  rng: () => 0.5,
}), 'postflop policy should derive missing draw and risk inputs');

// An opponent already all-in can never fold. Every wager EV candidate must
// therefore have zero fold-all probability and retain those forced callers.
const allInAwarePolicy = postflopPolicy({
  hole: [C(14, 1), C(14, 2)],
  board: [C(14, 3), C(13, 1), C(7, 2)],
  equity: 0.96,
  numOpponents: 3,
  allInOpponents: 2,
  opts: {
    toCall: 0,
    canCheck: true,
    callAmount: 0,
    allInAmount: 60,
    canRaise: true,
    canAllIn: true,
    tiers: [{ key: 'fierce', name: 'Fierce', increment: 45, cost: 45 }],
  },
  pot: 200,
  stack: 60,
  rng: () => 0.4,
});
const allInWagers = allInAwarePolicy.distribution.filter(
  (candidate) => candidate.action.type === 'raise' || candidate.action.type === 'allin',
);
assert.ok(allInWagers.length >= 1, 'strong value hand should produce a wager candidate');
for (const candidate of allInWagers) {
  assert.equal(candidate.foldAll, 0, 'an existing all-in opponent makes fold-all impossible');
  assert.ok(candidate.estimatedCallers >= 2,
    'estimated callers must include every already all-in opponent');
}

// Multiway fold equity must preserve opponent heterogeneity. With the same
// arithmetic-mean tendency, multiplying individual fold probabilities is
// lower than raising the mean probability to N unless every opponent matches.
const foldModelContext = {
  hole: [C(14, 1), C(14, 2)],
  board: [C(14, 3), C(13, 1), C(7, 2)],
  equity: 0.92,
  numOpponents: 4,
  opts: {
    toCall: 0, canCheck: true, callAmount: 0, allInAmount: 200,
    canRaise: true, canAllIn: true,
    tiers: [{ key: 'fierce', name: 'Fierce', increment: 80, cost: 80 }],
  },
  pot: 200,
  stack: 200,
  rng: () => 0.4,
};
const homogeneousFold = postflopPolicy({ ...foldModelContext, foldTendency: 0.5 });
const heterogeneousFold = postflopPolicy({
  ...foldModelContext,
  foldTendency: 0.5,
  foldTendencies: [0, 0.25, 0.75, 1],
});
const wagerOf = (policy) => policy.distribution.find(
  (candidate) => candidate.action.type === 'raise',
);
assert.ok(wagerOf(homogeneousFold) && wagerOf(heterogeneousFold));
assert.ok(wagerOf(heterogeneousFold).foldActionables < wagerOf(homogeneousFold).foldActionables,
  'heterogeneous multiway opponents must not inherit mean-tendency fold equity');

// Calling for the rest of the stack is represented as call, not a duplicate
// aggressive all-in action that illegally reopens betting.
const callAllInOptions = {
  toCall: 80,
  canCheck: false,
  callAmount: 80,
  allInAmount: 80,
  canRaise: false,
  canAllIn: true,
  tiers: [],
};
assert.equal(normalizePolicyOptions(callAllInOptions).allInRaises, false);
const callAllInPolicy = postflopPolicy({
  hole: [C(14, 1), C(14, 2)],
  board: [C(14, 3), C(8, 1), C(3, 2), C(2, 4)],
  equity: 0.94,
  numOpponents: 1,
  opts: callAllInOptions,
  pot: 200,
  stack: 80,
  rng: () => 0.5,
});
assert.ok(callAllInPolicy.distribution.some((candidate) => candidate.action.type === 'call'));
assert.equal(callAllInPolicy.distribution.some((candidate) => candidate.action.type === 'allin'), false,
  'call-all-in must not create a second aggressive all-in candidate');

// Fixed RNG produces a reproducible mixed action and a finite probability simplex.
const mixedCandidates = [
  { action: { type: 'fold' }, ev: 0, frequencyBias: 0.8 },
  { action: { type: 'call' }, ev: 1.5, frequencyBias: 1.1 },
  { action: { type: 'raise', tier: { key: 'feint', inc: 30, cost: 50 } }, ev: 1.1 },
];
const firstMixed = mixedPolicy(mixedCandidates, { rng: () => 0.417, temperature: 8 });
const secondMixed = mixedPolicy(mixedCandidates, { rng: () => 0.417, temperature: 8 });
assert.deepEqual(firstMixed.action, secondMixed.action, 'fixed RNG should reproduce the action');
assert.deepEqual(
  firstMixed.distribution.map((candidate) => candidate.probability),
  secondMixed.distribution.map((candidate) => candidate.probability),
  'fixed inputs should reproduce the full distribution',
);
for (const candidate of firstMixed.distribution) {
  assert.ok(Number.isFinite(candidate.probability), 'probabilities must be finite');
  assert.ok(candidate.probability >= 0 && candidate.probability <= 1,
    'probabilities must lie in [0,1]');
}
approx(firstMixed.distribution.reduce((sum, candidate) => sum + candidate.probability, 0),
  1, 1e-12, 'mixed-strategy probabilities must sum to one');

// Full-ring range samples are joint physical deals: no opponent can receive a
// hero/board blocker or a card already assigned to another opponent.
const hero = [C(14, 1), C(14, 2)];
const river = [C(2, 1), C(7, 2), C(9, 3), C(11, 1), C(12, 2)];
const known = [...hero, ...river];
const fullRingRanges = Array.from({ length: 8 }, (_, index) =>
  new OpponentRange(`full-ring-${index}`, { knownCards: known }));
for (let sample = 0; sample < 20; sample++) {
  const holes = sampleRangesWithoutReplacement(fullRingRanges, {
    excludedCards: known,
    rng: seededRng(1000 + sample),
  });
  assert.equal(holes.length, 8);
  const ids = [...known, ...holes.flat()].map(cardId);
  assert.equal(new Set(ids).size, ids.length,
    'joint nine-player sample must never duplicate a physical card');
}

function exactRange(id, exactCards) {
  const exactIds = new Set(exactCards.map(cardId));
  return new OpponentRange(id, { knownCards: known }).applyConstraint(
    (combo) => combo.cardIds.every((value) => exactIds.has(value)),
  );
}

const kingsRange = exactRange('exact-kings', [C(13, 1), C(13, 2)]);
const queensRange = exactRange('exact-queens', [C(12, 3), C(12, 4)]);
const versusKings = estimateAgainstRanges(hero, river, [kingsRange], 12, {
  rng: seededRng(7),
});
const versusQueens = estimateAgainstRanges(hero, river, [queensRange], 12, {
  rng: seededRng(7),
});
assert.equal(versusKings.equity, 1, 'aces should always beat exact kings on this river');
assert.equal(versusQueens.equity, 0, 'exact queens should make a set and beat aces on this river');
assert.ok(versusKings.equity - versusQueens.equity >= 0.9,
  'exact opponent ranges must materially change range-aware equity');

const suitHero = [C(14, 2), C(14, 3)];
const suitFlop = [C(7, 2), C(8, 3), C(9, 4)];
const suitPeekRange = new OpponentRange('known-spade', {
  knownCards: [...suitHero, ...suitFlop],
}).applyConstraint({ type: 'EXACT_CARD', card: C(2, 1) });
const conditionedSuit = estimateAgainstRanges(suitHero, suitFlop, [suitPeekRange], 8, {
  rng: () => 0,
  runoutConstraints: [{ slot: 4, suit: 1 }],
});
assert.ok(Number.isFinite(conditionedSuit.equity),
  'known future suit must be jointly conditioned with a revealed opponent card');

const sideHero = [C(14, 1), C(14, 2)];
const sideRiver = [C(12, 1), C(7, 2), C(9, 3), C(11, 4), C(3, 1)];
const sideKnown = [...sideHero, ...sideRiver];
const sideExact = (id, cards) => {
  const ids = new Set(cards.map(cardId));
  return new OpponentRange(id, { knownCards: sideKnown }).applyConstraint(
    (combo) => combo.cardIds.every((value) => ids.has(value)),
  );
};
const shortNuts = sideExact('short-nuts', [C(12, 2), C(12, 3)]);
const deepWorse = sideExact('deep-worse', [C(13, 1), C(13, 2)]);
const layered = estimateAgainstRanges(sideHero, sideRiver, [shortNuts, deepWorse], 4, {
  rng: seededRng(19),
  potModel: {
    heroId: 1,
    opponentIds: [2, 3],
    contributions: { 1: 200, 2: 50, 3: 200 },
    actionableOpponentIds: [3],
    allFoldEligibleOpponentIds: [2],
  },
});
assert.equal(layered.equity, 0,
  'hero loses the main pot to the short-stack nuts');
assert.equal(layered.expectedPayout, 300,
  'hero must still receive the full deep-stack side pot');
assert.equal(layered.allFoldExpectedPayout, 300,
  'a folded deep opponent leaves dead side-pot chips that hero still wins');
assert.equal(layered.actionableEquity, 1,
  'new raise layers must be valued against the deep actionable opponent, not short-stack nuts');
const sidePotCall = postflopPolicy({
  hole: sideHero,
  board: sideRiver,
  equity: layered.equity,
  callExpectedPayout: layered.expectedPayout,
  numOpponents: 2,
  opts: {
    toCall: 150, callAmount: 150, allInAmount: 150,
    canCheck: false, canRaise: false, canAllIn: true, tiers: [],
  },
  pot: 300,
  stack: 150,
  rng: () => 0.5,
});
assert.equal(sidePotCall.action.type, 'call',
  'profitable side-pot recovery must not be folded merely because joint equity is zero');

const sidePotRaise = postflopPolicy({
  hole: sideHero,
  board: sideRiver,
  equity: layered.equity,
  callExpectedPayout: layered.expectedPayout,
  allFoldExpectedPayout: layered.allFoldExpectedPayout,
  actionableEquity: layered.actionableEquity,
  numOpponents: 2,
  allInOpponents: 1,
  opts: {
    toCall: 150, callAmount: 150, allInAmount: 300,
    canCheck: false, canRaise: true, canAllIn: true,
    tiers: [{ key: 'feint', name: 'Feint', increment: 50, cost: 200 }],
  },
  pot: 300,
  stack: 300,
  rng: () => 0.5,
});
const sideCallCandidate = sidePotRaise.distribution.find(
  (candidate) => candidate.action.type === 'call',
);
const sideRaiseCandidate = sidePotRaise.distribution.find(
  (candidate) => candidate.action.type === 'raise',
);
assert.ok(sideRaiseCandidate,
  'hero must be allowed to value-raise a deep side pot despite losing the short main pot');
assert.ok(sideRaiseCandidate.ev > sideCallCandidate.ev,
  'a matched raise layer won against the actionable range must add EV over calling');

// Real Engine adapter: action must be legal for the current public state, and
// diagnostics must be available without exposing Engine internals.
const heroIds = HEROES.slice(0, 6).map((item) => item.id);
const engine = new Engine(heroIds, {}, new Set([1, 2, 3, 4, 5, 6]));
engine.startRound();
const actor = engine.players[1];
engine.actingIdx = actor.idx;
const engineOptions = engine.getOptions(actor);
assert.deepEqual(AI.getBlueprintStatus(), {
  installed: false, schema: null, weight: 0, iterations: null, size: 0,
}, 'blueprint runtime must default to disabled');
const engineInfoSetKey = buildBlueprintInfoSetKey(buildObservation(engine, actor));
const engineBlueprintAction = engineOptions.canCheck ? 'check'
  : engineOptions.callAmt > 0 ? 'call' : 'fold';
const engineCheckpoint = {
  schema: BLUEPRINT_SCHEMA,
  version: BLUEPRINT_VERSION,
  metadata: { abstraction: BLUEPRINT_ABSTRACTION, iterations: 9001 },
  blendWeight: 1,
  infosets: {
    [engineInfoSetKey]: {
      strategy: { [engineBlueprintAction]: 1 },
      visits: 1000,
    },
  },
};
assert.deepEqual(AI.installBlueprintCheckpoint(engineCheckpoint), {
  installed: true,
  schema: BLUEPRINT_SCHEMA,
  weight: 0.35,
  iterations: 9001,
  size: 1,
}, 'installed checkpoint weight must obey the hard runtime cap');
const engineAction = AI.decide(engine, actor);
const actionIsLegal = (() => {
  if (engineAction.type === 'fold') return engineOptions.toCall > 0;
  if (engineAction.type === 'check') return engineOptions.canCheck;
  if (engineAction.type === 'call') return engineOptions.callAmt > 0;
  if (engineAction.type === 'allin') return engineOptions.canAllIn;
  if (engineAction.type === 'raise') {
    return engineOptions.canRaise && engineOptions.tiers.some((tier) =>
      tier.key === engineAction.tier?.key
      && tier.inc === engineAction.tier?.inc
      && tier.cost === engineAction.tier?.cost);
  }
  return false;
})();
assert.equal(actionIsLegal, true, `AI returned illegal Engine action: ${JSON.stringify(engineAction)}`);

const diagnostics = AI.getLastDecisionDiagnostics(engine, actor);
assert.ok(diagnostics, 'real Engine decision should persist diagnostics');
assert.equal(diagnostics.observerIdx, actor.idx);
assert.equal(diagnostics.round, engine.round);
assert.equal(diagnostics.street, engine.street);
assert.ok(Number.isFinite(diagnostics.equity) && diagnostics.equity >= 0 && diagnostics.equity <= 1,
  'diagnostic equity should be finite and bounded');
assert.ok(Number.isInteger(diagnostics.simulations) && diagnostics.simulations > 0,
  'diagnostics should record the Monte Carlo budget');
assert.deepEqual(diagnostics.selected, {
  type: engineAction.type,
  tier: engineAction.tier?.key || null,
});
assert.equal(diagnostics.blueprint.schema, BLUEPRINT_SCHEMA);
assert.equal(diagnostics.blueprint.hit, true);
assert.equal(diagnostics.blueprint.keyHit, true);
assert.equal(diagnostics.blueprint.eligible, true);
assert.equal(diagnostics.blueprint.nodeVisits, 1000);
assert.ok(diagnostics.blueprint.confidence > 0.95 && diagnostics.blueprint.confidence < 0.96);
assert.ok(diagnostics.blueprint.effectiveWeight > 0
  && diagnostics.blueprint.effectiveWeight <= 0.35);
assert.ok(diagnostics.blueprint.policyTV >= 0 && diagnostics.blueprint.policyTV <= 1);
assert.ok(diagnostics.blueprint.influence >= 0 && diagnostics.blueprint.influence <= 0.35);
assert.equal(typeof diagnostics.blueprint.intervened, 'boolean');
assert.equal(typeof diagnostics.blueprint.actionChanged, 'boolean');
assert.equal(diagnostics.blueprint.iterations, 9001);
assert.equal(diagnostics.blueprint.size, 1,
  'decision diagnostics expose only safe blueprint aggregate fields');
assert.equal(JSON.stringify(diagnostics).includes(engineInfoSetKey), false,
  'diagnostics must never leak the information-set key containing the own-hand bucket');
for (const candidate of diagnostics.distribution) {
  assert.ok(Number.isFinite(candidate.probability),
    'diagnostic mixed-policy probabilities should stay finite');
}
assert.equal(AI.clearBlueprintCheckpoint().installed, false);
assert.equal(AI.getBlueprintStatus().size, 0);

const loadedStatus = await AI.loadBlueprintCheckpoint(engineCheckpoint);
assert.equal(loadedStatus.installed, true, 'load API accepts parsed static checkpoints');
await assert.rejects(AI.loadBlueprintCheckpoint('/missing-blueprint.json', {
  fetchImpl: async () => ({ ok: false, status: 404 }),
}), /Unable to load blueprint checkpoint/);
assert.equal(AI.getBlueprintStatus().installed, true,
  'failed loads must leave the previously installed checkpoint intact');

let resolveOlder;
let resolveNewer;
const olderCheckpoint = {
  ...engineCheckpoint,
  metadata: { ...engineCheckpoint.metadata, iterations: 101 },
};
const newerCheckpoint = {
  ...engineCheckpoint,
  metadata: { ...engineCheckpoint.metadata, iterations: 202 },
};
const olderLoad = AI.loadBlueprintCheckpoint('/older-blueprint.json', {
  fetchImpl: () => new Promise((resolve) => { resolveOlder = resolve; }),
});
const newerLoad = AI.loadBlueprintCheckpoint('/newer-blueprint.json', {
  fetchImpl: () => new Promise((resolve) => { resolveNewer = resolve; }),
});
resolveNewer({ ok: true, json: async () => newerCheckpoint });
await newerLoad;
resolveOlder({ ok: true, json: async () => olderCheckpoint });
await olderLoad;
assert.equal(AI.getBlueprintStatus().iterations, 202,
  'an older asynchronous load must never overwrite a newer checkpoint request');
AI.clearBlueprintCheckpoint();

const locallyOverriddenAction = AI.decideWithBlueprint(engine, actor, engineCheckpoint);
assert.ok(['fold', 'check', 'call', 'raise', 'allin'].includes(locallyOverriddenAction.type));
assert.equal(AI.getBlueprintStatus().installed, false,
  'per-seat league checkpoint must not mutate the global blueprint status');
assert.equal(AI.getLastDecisionDiagnostics(engine, actor).blueprint?.schema, BLUEPRINT_SCHEMA,
  'local checkpoint decisions still expose safe aggregate diagnostics');

const nineHeroIds = HEROES.slice(0, 9).map((item) => item.id);
const nineEngine = new Engine(
  nineHeroIds, {}, new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]), {}, { tableSize: 9 },
);
nineEngine.startRound();
const nineActor = nineEngine.players[1];
nineEngine.actingIdx = nineActor.idx;
const nineAction = AI.decide(nineEngine, nineActor);
const nineDiagnostics = AI.getLastDecisionDiagnostics(nineEngine, nineActor);
assert.ok(['fold', 'check', 'call', 'raise', 'allin'].includes(nineAction.type));
assert.equal(nineDiagnostics.tableSize, 9, 'real nine-seat Engine must reach the bot policy');
assert.equal(nineDiagnostics.activeOpponents, 8,
  'nine-seat decision must jointly model all eight active opponents');
assert.equal(nineDiagnostics.modeledOpponents, 8,
  'nine-seat diagnostics must retain one physical-combo range per opponent');

const replayA = new Engine(
  nineHeroIds, {}, new Set(), {}, { tableSize: 9, rng: seededRng(424242) },
);
const replayB = new Engine(
  nineHeroIds, {}, new Set(), {}, { tableSize: 9, rng: seededRng(424242) },
);
replayA.startRound();
replayB.startRound();
const replayCards = (instance) => [
  ...instance.players.slice(1).flatMap((item) => item.hole),
  ...instance.board,
].map(cardId);
assert.equal(replayA.dealerIdx, replayB.dealerIdx,
  'identical Engine seeds must reproduce the dealer');
assert.deepEqual(replayCards(replayA), replayCards(replayB),
  'identical Engine seeds must reproduce the full physical deal');
assert.deepEqual(replayA.players.slice(1).map((item) => item.style?.key),
  replayB.players.slice(1).map((item) => item.style?.key),
  'identical Engine seeds must reproduce bot style assignment');
replayA.actingIdx = 1;
replayB.actingIdx = 1;
assert.deepEqual(AI.decide(replayA, replayA.players[1]),
  AI.decideWithBlueprint(replayB, replayB.players[1], null),
  'an explicit null local checkpoint must exactly match the default disabled runtime');

console.log('Advanced AI tests passed: 2-9 seats, draws, legal options, all-ins, ranges, diagnostics.');
