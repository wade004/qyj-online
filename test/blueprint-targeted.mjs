import assert from 'node:assert/strict';

import { cardId, preflopComboStrength } from '../js/game/opponent-range.js';
import { abstractObservation, QyjAbstractHoldemGame } from '../training/blueprint/qyj-abstract-game.js';
import { SerializableRng } from '../training/blueprint/rng.js';
import { buildExactInfosetTrainingSnapshot } from '../training/blueprint/target-profile.js';
import {
  QyjTargetedHoldemGame,
  buildTargetKeyFromSnapshot,
  normalizeTargetDefinition,
  trainTargetedBlueprint,
} from '../training/blueprint/targeted.js';

function remapEvent(event, seatMap) {
  const remapSeats = (seats) => (Array.isArray(seats)
    ? seats.map((seat) => seatMap.get(seat)) : seats);
  return {
    ...event,
    actorIdx: seatMap.get(event.actorIdx),
    dealerIdx: seatMap.get(event.dealerIdx),
    handSeats: remapSeats(event.handSeats),
    activeSeatsBefore: remapSeats(event.activeSeatsBefore),
    activeSeats: remapSeats(event.activeSeats),
    board: event.board?.map((card) => ({ ...card })) || [],
  };
}

function targetFromState(game, state, sparseSeatIds) {
  const actor = state.actingSeat;
  const observation = abstractObservation(state, actor);
  assert.equal(sparseSeatIds.length, game.playerCount);
  const seatMap = new Map(observation.handSeats.map((seat, index) => [seat, sparseSeatIds[index]]));
  const actorIdx = seatMap.get(observation.observerIdx);
  const snapshot = {
    round: observation.round,
    street: observation.street,
    dealerIdx: seatMap.get(observation.dealerIdx),
    blinds: { ...observation.blinds },
    board: observation.board.map((card) => ({ ...card })),
    handSeats: observation.handSeats.map((seat) => seatMap.get(seat)),
    activeSeats: observation.activeSeats.map((seat) => seatMap.get(seat)),
    players: observation.handSeats.map((seat) => {
      const player = observation.players[seat];
      return {
        idx: seatMap.get(seat),
        hp: player.hp,
        folded: player.folded,
        allIn: player.allIn,
        betStreet: player.betStreet,
        betRound: player.betRound,
        acted: player.acted,
        position: player.position,
      };
    }),
    selfHole: observation.self.hole.map((card) => ({ ...card })),
    betting: { ...observation.betting },
    legalActions: {
      ...observation.legalActions,
      tiers: observation.legalActions.tiers.map((tier) => ({ ...tier })),
    },
    actionHistory: observation.actionHistory.map((event) => remapEvent(event, seatMap)),
  };
  const targetKey = buildTargetKeyFromSnapshot(snapshot, actorIdx, {
    maxRaisesPerStreet: game.config.maxRaisesPerStreet,
  });
  return { targetKey, actorIdx, snapshot };
}

function profiledTargetFromState(game, state, sparseSeatIds) {
  const direct = targetFromState(game, state, sparseSeatIds);
  const profiled = buildExactInfosetTrainingSnapshot({
    ...direct.snapshot,
    observerIdx: direct.actorIdx,
  });
  const { observerIdx: actorIdx, ...snapshot } = profiled;
  const targetKey = buildTargetKeyFromSnapshot(snapshot, actorIdx, {
    maxRaisesPerStreet: game.config.maxRaisesPerStreet,
  });
  return { targetKey, actorIdx, snapshot };
}

function initialTarget({ tableSize, round, sparseSeatIds, maxRaisesPerStreet = 1, seed }) {
  const game = new QyjAbstractHoldemGame({
    tableSize,
    round,
    stackBb: 20,
    maxRaisesPerStreet,
  });
  const state = game.createInitialState(new SerializableRng(seed));
  return targetFromState(game, state, sparseSeatIds);
}

function assertPhysicalDeal(state, message) {
  const cards = [...state.hole.flat(), ...state.board];
  const ids = cards.map(cardId);
  assert.equal(new Set(ids).size, ids.length, message);
}

// Exact round-trip for heads-up, sparse six-max, and all nine seats.
const fixtures = [
  { tableSize: 2, round: 2, sparseSeatIds: [2, 9], seed: 'target-2' },
  { tableSize: 6, round: 6, sparseSeatIds: [1, 2, 4, 6, 8, 9], seed: 'target-6' },
  { tableSize: 9, round: 11, sparseSeatIds: [1, 2, 3, 4, 5, 6, 7, 8, 9], seed: 'target-9' },
];

for (const fixture of fixtures) {
  const target = initialTarget(fixture);
  const game = new QyjTargetedHoldemGame(target, { maxRaisesPerStreet: 1 });
  const rootA = game.createInitialState(new SerializableRng(`${fixture.seed}-hydrate`), {
    iteration: 0,
    traverser: 0,
  });
  const rootB = game.createInitialState(new SerializableRng(`${fixture.seed}-hydrate`), {
    iteration: 0,
    traverser: 0,
  });
  assert.equal(game.infoSetKey(rootA, rootA.targetActor), target.targetKey);
  assert.deepEqual(rootB, rootA, 'same target/deal RNG must reproduce the hydrated hidden state');
  assert.deepEqual(rootA.seatIds, [...fixture.sparseSeatIds].sort((a, b) => a - b));
  assert(game.trainingPlayers({ iteration: 0 }).includes(rootA.targetActor));
  assertPhysicalDeal(rootA,
    `${fixture.tableSize}-player targeted roots must be one mutually exclusive physical deal`);

  const walkRng = new SerializableRng(`${fixture.seed}-walk`);
  let state = rootA;
  let steps = 0;
  while (!game.isTerminal(state)) {
    game.assertState(state);
    const legal = game.legalActions(state);
    assert(legal.length > 0, 'every nonterminal targeted state must expose a legal action');
    state = game.nextState(state, legal[walkRng.int(legal.length)]);
    if (++steps > 160) throw new Error('targeted public-subgame rollout did not terminate');
  }
  assert(game.assertState(state));
}

// Exercise a non-empty public history and a postflop target root.
const historySource = new QyjAbstractHoldemGame({
  tableSize: 6,
  round: 7,
  stackBb: 20,
  maxRaisesPerStreet: 1,
});
let historyState = historySource.createInitialState(new SerializableRng('target-history'));
while (!historySource.isTerminal(historyState) && historyState.street === 'preflop') {
  const legal = historySource.legalActions(historyState);
  const passive = legal.includes('call') ? 'call' : legal.includes('check') ? 'check' : legal[0];
  historyState = historySource.nextState(historyState, passive);
}
assert.equal(historyState.street, 'flop');
const historyTarget = targetFromState(
  historySource,
  historyState,
  [1, 2, 4, 6, 8, 9],
);
const historyGame = new QyjTargetedHoldemGame(historyTarget, { maxRaisesPerStreet: 1 });
const historyRoot = historyGame.createInitialState(new SerializableRng('target-history-hydrate'));
assert.equal(historyGame.infoSetKey(historyRoot, historyRoot.targetActor), historyTarget.targetKey);
assert(historyRoot.actionHistory.length >= 6, 'postflop target preserves its public action prefix');

// Public actions must condition hidden-card sampling.  This is deliberately a
// black-box distribution test over hydrated training roots: it cannot pass if
// targeted MCCFR merely shuffles a uniform remainder deck.  Six-handed UTG's
// real preflop raise is especially informative (early position + a large
// field), so the posterior samples must be materially stronger than the same
// public root with no observed voluntary action.
const beliefSource = new QyjAbstractHoldemGame({
  tableSize: 6,
  round: 4,
  stackBb: 20,
  maxRaisesPerStreet: 3,
});
let beliefState = beliefSource.createInitialState(new SerializableRng('belief-source'));
const beliefRaiser = beliefState.actingSeat;
assert(beliefSource.legalActions(beliefState).includes('raise:feint'));
beliefState = beliefSource.nextState(beliefState, 'raise:feint');
const beliefTarget = profiledTargetFromState(
  beliefSource,
  beliefState,
  [1, 2, 3, 4, 5, 6],
);
const beliefRaise = beliefTarget.snapshot.actionHistory.find((event) => (
  event.actorIdx === beliefRaiser + 1 && event.isAggressive === true
));
assert(beliefRaise && beliefRaise.position === 'UTG',
  'belief fixture must contain the intended strong public UTG action');

const uniformPriorTarget = structuredClone(beliefTarget);
uniformPriorTarget.snapshot.actionHistory = [];
uniformPriorTarget.targetKey = buildTargetKeyFromSnapshot(
  uniformPriorTarget.snapshot,
  uniformPriorTarget.actorIdx,
  { maxRaisesPerStreet: 3 },
);
const beliefGame = new QyjTargetedHoldemGame(beliefTarget, {
  maxRaisesPerStreet: 3,
});
const uniformPriorGame = new QyjTargetedHoldemGame(uniformPriorTarget, {
  maxRaisesPerStreet: 3,
});
const deterministicBeliefA = beliefGame.createInitialState(
  new SerializableRng('belief-deterministic'),
);
const deterministicBeliefB = beliefGame.createInitialState(
  new SerializableRng('belief-deterministic'),
);
assert.deepEqual(deterministicBeliefB, deterministicBeliefA,
  'public-belief sampling must be exactly reproducible for the same seed');
const changedBelief = beliefGame.createInitialState(new SerializableRng('belief-different'));
assert.notDeepEqual(changedBelief.hole, deterministicBeliefA.hole,
  'different seeds must be able to explore different hidden belief states');

let posteriorStrength = 0;
let priorStrength = 0;
const beliefSamples = 128;
for (let sample = 0; sample < beliefSamples; sample++) {
  const seed = `belief-tightening-${sample}`;
  const posteriorRoot = beliefGame.createInitialState(new SerializableRng(seed));
  const priorRoot = uniformPriorGame.createInitialState(new SerializableRng(seed));
  const posteriorRaiser = posteriorRoot.seatIds.indexOf(beliefRaise.actorIdx);
  const priorRaiser = priorRoot.seatIds.indexOf(beliefRaise.actorIdx);
  assert(posteriorRaiser >= 0 && priorRaiser >= 0);
  posteriorStrength += preflopComboStrength(posteriorRoot.hole[posteriorRaiser]);
  priorStrength += preflopComboStrength(priorRoot.hole[priorRaiser]);
  assertPhysicalDeal(posteriorRoot, 'posterior joint samples must never reuse a physical card');
}
posteriorStrength /= beliefSamples;
priorStrength /= beliefSamples;
assert.ok(posteriorStrength > priorStrength + 0.07,
  `strong public action must tighten the sampled range: prior=${priorStrength.toFixed(4)}, posterior=${posteriorStrength.toFixed(4)}`);

// Folded opponents no longer have showdown eligibility, but their unknown
// physical cards remain dead blockers for every live range and the runout.
const foldedSource = new QyjAbstractHoldemGame({
  tableSize: 6,
  round: 5,
  stackBb: 20,
  maxRaisesPerStreet: 1,
});
let foldedState = foldedSource.createInitialState(new SerializableRng('folded-belief-source'));
const foldedSeat = foldedState.actingSeat;
foldedState = foldedSource.nextState(foldedState, 'fold');
const foldedTarget = profiledTargetFromState(
  foldedSource,
  foldedState,
  [1, 2, 3, 4, 5, 6],
);
const foldedGame = new QyjTargetedHoldemGame(foldedTarget, { maxRaisesPerStreet: 1 });
for (let sample = 0; sample < 12; sample++) {
  const root = foldedGame.createInitialState(new SerializableRng(`folded-blocker-${sample}`));
  assert.equal(root.folded[foldedSeat], true);
  assert.equal(root.hole[foldedSeat].length, 2,
    'a folded opponent must still receive its hidden blocker cards');
  const foldedIds = new Set(root.hole[foldedSeat].map(cardId));
  const otherIds = [
    ...root.hole.flatMap((cards, seat) => (seat === foldedSeat ? [] : cards)),
    ...root.board,
  ].map(cardId);
  assert(otherIds.every((id) => !foldedIds.has(id)),
    'folded hidden cards must block live opponents and every future board card');
  assertPhysicalDeal(root, 'folded-player belief roots must remain jointly physical');
}

// Exercise the posterior path at the maximum supported table size, not only
// the uniform-prior fixture above.
const nineBeliefSource = new QyjAbstractHoldemGame({
  tableSize: 9,
  round: 6,
  stackBb: 20,
  maxRaisesPerStreet: 1,
});
let nineBeliefState = nineBeliefSource.createInitialState(
  new SerializableRng('nine-belief-source'),
);
nineBeliefState = nineBeliefSource.nextState(nineBeliefState, 'raise:feint');
const nineBeliefTarget = profiledTargetFromState(
  nineBeliefSource,
  nineBeliefState,
  [1, 2, 3, 4, 5, 6, 7, 8, 9],
);
const nineBeliefGame = new QyjTargetedHoldemGame(nineBeliefTarget, {
  maxRaisesPerStreet: 1,
});
const nineBeliefRoot = nineBeliefGame.createInitialState(
  new SerializableRng('nine-belief-hydrate'),
);
assert.equal(nineBeliefRoot.hole.length, 9);
assert.equal(nineBeliefRoot.actionHistory.some((event) => event.isAggressive), true);
assertPhysicalDeal(nineBeliefRoot,
  'nine-player posterior sampling must jointly block all eight opponents and the runout');
assert.equal(nineBeliefGame.infoSetKey(nineBeliefRoot, nineBeliefRoot.targetActor),
  nineBeliefTarget.targetKey,
  'sampled opponent holes must never leak into or change the public information-set key');
assert(beliefTarget.snapshot.players.every((player) => !Object.hasOwn(player, 'hole')),
  'belief construction input must contain public player state only');
assert(!JSON.stringify(beliefTarget).includes(JSON.stringify(
  beliefState.hole[beliefRaiser],
)), 'the target definition must not retain the source opponent physical hole cards');

// K iterations produce K real traverser updates on the exact target root.
const cheapTargetA = initialTarget({
  tableSize: 2,
  round: 2,
  sparseSeatIds: [2, 9],
  maxRaisesPerStreet: 0,
  seed: 'target-cheap-a',
});
const cheapTargetB = initialTarget({
  tableSize: 2,
  round: 8,
  sparseSeatIds: [1, 7],
  maxRaisesPerStreet: 0,
  seed: 'target-cheap-b',
});
const trainingOptions = {
  visitsPerTarget: 5,
  maxRaisesPerStreet: 0,
  seed: 'targeted-determinism',
  blendWeight: 0.2,
};
const trainedA = trainTargetedBlueprint([cheapTargetA, cheapTargetB], trainingOptions);
const trainedB = trainTargetedBlueprint([cheapTargetB, cheapTargetA], trainingOptions);
assert.deepEqual(trainedB, trainedA,
  'target order and worker-style completion order must not affect the deterministic artifact');
assert.deepEqual(
  Object.keys(trainedA.infosets).sort(),
  [cheapTargetA.targetKey, cheapTargetB.targetKey].sort(),
  'runtime targeted artifacts publish only the explicitly requested exact roots',
);
assert.equal(trainedA.infosets[cheapTargetA.targetKey].visits, 5);
assert.equal(trainedA.infosets[cheapTargetB.targetKey].visits, 5);
for (const targetKey of [cheapTargetA.targetKey, cheapTargetB.targetKey]) {
  const root = trainedA.infosets[targetKey];
  assert(Object.keys(root.actionValues || {}).length > 0,
    'target root retains empirical action-value Welford moments');
  for (const moments of Object.values(root.actionValues)) {
    assert.equal(moments.samples, 5,
      'each root action value must contain one genuine sample per root visit');
    assert(Number.isFinite(moments.mean));
    assert(Number.isFinite(moments.m2) && moments.m2 >= 0);
  }
}
assert.equal(trainedA.metadata.targetCount, 2);
assert.deepEqual(trainedA.metadata.playerCounts, [2]);
assert.deepEqual(
  {
    enabled: trainedA.metadata.advantageGuard.enabled,
    minSamples: trainedA.metadata.advantageGuard.minSamples,
    confidenceZ: trainedA.metadata.advantageGuard.confidenceZ,
    minLowerBound: trainedA.metadata.advantageGuard.minLowerBound,
  },
  { enabled: true, minSamples: 5, confidenceZ: 1.96, minLowerBound: 0 },
);
assert.deepEqual(trainedA.metadata.rootBelief, {
  model: 'public-action-bayesian-range-v1',
  likelihoodTemperature: 0.5,
  jointSampler: 'product-posterior-conditioned-on-physical-card-exclusivity',
  foldedPlayersBlockCards: true,
  futureRunout: 'uniform-after-all-known-and-sampled-hole-card-blockers',
});
assert(!JSON.stringify(trainedA.metadata).includes('selfHole'),
  'runtime metadata must not retain target snapshots or private cards');

assert.throws(
  () => trainTargetedBlueprint(cheapTargetA, { ...trainingOptions, visitsPerTarget: 1 }),
  /visitsPerTarget must be a safe integer >= 2/,
  'the confidence guard requires at least two genuine root samples',
);
assert.throws(
  () => trainTargetedBlueprint(cheapTargetA, {
    ...trainingOptions,
    beliefTemperature: 1.01,
  }),
  /beliefTemperature must be in 0\.\.1/,
  'public-action evidence temperature must stay bounded',
);

const withoutTierNames = structuredClone(cheapTargetA);
for (const tier of withoutTierNames.snapshot.legalActions.tiers) delete tier.name;
assert.equal(
  normalizeTargetDefinition(withoutTierNames, { maxRaisesPerStreet: 0 }).targetKey,
  cheapTargetA.targetKey,
  'real target-profile tiers may omit their presentation-only name',
);

const futureStreetHistory = structuredClone(cheapTargetA);
futureStreetHistory.snapshot.actionHistory.push({
  id: 999,
  actorIdx: futureStreetHistory.actorIdx,
  round: futureStreetHistory.snapshot.round,
  street: 'flop',
  type: 'check',
  key: 'check',
  amount: 0,
  callAmount: 0,
  raiseIncrement: 0,
  raiseTo: null,
  potBefore: futureStreetHistory.snapshot.betting.pot,
  currentBetBefore: 0,
  currentBetAfter: 0,
  position: futureStreetHistory.snapshot.players
    .find((player) => player.idx === futureStreetHistory.actorIdx).position,
  playersInHand: futureStreetHistory.snapshot.activeSeats.length,
  board: [],
  isAggressive: false,
  forced: false,
});
assert.throws(
  () => normalizeTargetDefinition(futureStreetHistory, { maxRaisesPerStreet: 0 }),
  /actionHistory must be ordered within the target round and root street/,
  'a target must reject public actions from a future street',
);

const forgedStreetBoard = structuredClone(historyTarget);
const forgedActor = forgedStreetBoard.snapshot.activeSeats[0];
const forgedBoard = forgedStreetBoard.snapshot.board.map((card) => ({ ...card }));
[forgedBoard[0], forgedBoard[1]] = [forgedBoard[1], forgedBoard[0]];
forgedStreetBoard.snapshot.actionHistory.push({
  id: 1000,
  actorIdx: forgedActor,
  round: forgedStreetBoard.snapshot.round,
  street: 'flop',
  type: 'check',
  key: 'check',
  amount: 0,
  callAmount: 0,
  raiseIncrement: 0,
  raiseTo: null,
  potBefore: forgedStreetBoard.snapshot.betting.pot,
  currentBetBefore: 0,
  currentBetAfter: 0,
  position: forgedStreetBoard.snapshot.players
    .find((player) => player.idx === forgedActor).position,
  playersInHand: forgedStreetBoard.snapshot.activeSeats.length,
  board: forgedBoard,
  isAggressive: false,
  forced: false,
});
assert.throws(
  () => normalizeTargetDefinition(forgedStreetBoard, { maxRaisesPerStreet: 1 }),
  /strict public street prefix/,
  'an action event cannot reorder or import future public cards',
);

const actorStatsLeak = structuredClone(cheapTargetA);
actorStatsLeak.snapshot.rangeStats = [{
  idx: actorStatsLeak.actorIdx,
  hands: 1,
  vpip: 0,
  pfr: 0,
  threeBet: 0,
  af: 0,
  foldToCbet: 0.45,
}];
assert.throws(
  () => normalizeTargetDefinition(actorStatsLeak, { maxRaisesPerStreet: 0 }),
  /rangeStats must uniquely identify opponent hand seats/,
  'rangeStats are public opponent aggregates, never an extra hero channel',
);

// Engine preserves the nominal preflop currentBet when the big blind is a
// short all-in. This is not an unmatched-pot inconsistency: later callers
// still have to complete to the configured BB amount.
const shortBigBlindTarget = structuredClone(cheapTargetA);
const shortBigBlind = shortBigBlindTarget.snapshot.players
  .find((player) => player.position === 'BB');
assert(shortBigBlind && shortBigBlind.idx !== shortBigBlindTarget.actorIdx);
const previousBlind = shortBigBlind.betStreet;
const shortBlindAmount = Math.max(1, Math.floor(shortBigBlindTarget.snapshot.blinds.bb / 4));
shortBigBlind.hp = 0;
shortBigBlind.allIn = true;
shortBigBlind.betStreet = shortBlindAmount;
shortBigBlind.betRound = shortBlindAmount;
shortBigBlindTarget.snapshot.betting.pot -= previousBlind - shortBlindAmount;
const blindEvent = shortBigBlindTarget.snapshot.actionHistory.find((event) => (
  event.actorIdx === shortBigBlind.idx && event.key === 'bigBlind'
));
if (blindEvent) blindEvent.amount = shortBlindAmount;
shortBigBlindTarget.targetKey = buildTargetKeyFromSnapshot(
  shortBigBlindTarget.snapshot,
  shortBigBlindTarget.actorIdx,
  { maxRaisesPerStreet: 0 },
);
const normalizedShortBlind = normalizeTargetDefinition(shortBigBlindTarget, {
  maxRaisesPerStreet: 0,
});
const shortBlindGame = new QyjTargetedHoldemGame(normalizedShortBlind, {
  maxRaisesPerStreet: 0,
});
const shortBlindRoot = shortBlindGame.createInitialState(
  new SerializableRng('target-short-big-blind'),
);
assert.equal(shortBlindGame.infoSetKey(shortBlindRoot, shortBlindRoot.targetActor),
  shortBigBlindTarget.targetKey,
  'short-all-in nominal big blind roots must hydrate without weakening pot validation');

// Exercise the actual reach-profiler contract: occupied eliminated seats stay
// public but are outside this hand and consequently have a null position.
const profileObservation = structuredClone(cheapTargetB.snapshot);
profileObservation.observerIdx = cheapTargetB.actorIdx;
profileObservation.players.push({
  idx: 9,
  hp: 0,
  folded: true,
  allIn: false,
  betStreet: 0,
  betRound: 0,
  acted: false,
  position: null,
});
const profiledWithObserver = buildExactInfosetTrainingSnapshot(profileObservation);
const { observerIdx: profiledActor, ...profiledSnapshot } = profiledWithObserver;
const profiledTarget = {
  actorIdx: profiledActor,
  snapshot: profiledSnapshot,
  targetKey: buildTargetKeyFromSnapshot(profiledSnapshot, profiledActor, {
    maxRaisesPerStreet: 0,
  }),
};
const profiledGame = new QyjTargetedHoldemGame(profiledTarget, {
  maxRaisesPerStreet: 0,
});
const profiledRoot = profiledGame.createInitialState(new SerializableRng('profile-contract'));
assert.equal(profiledRoot.publicSeatCapacity, 9);
assert.deepEqual(profiledRoot.seatIds, [1, 7]);
assert.equal(profiledGame.infoSetKey(profiledRoot, profiledRoot.targetActor), profiledTarget.targetKey);
assert.equal(
  trainTargetedBlueprint(profiledTarget, {
    ...trainingOptions,
    visitsPerTarget: 2,
  }).infosets[profiledTarget.targetKey].visits,
  2,
  'a real profiler snapshot must train end-to-end with genuine visits',
);

// Engine keeps formal raise/jam rights when all remaining opponents are
// already all-in. The trainer must reproduce that exact legal-action mask;
// settlement returns the unmatched one-contributor side pot.
const allInSourceTarget = initialTarget({
  tableSize: 2,
  round: 3,
  sparseSeatIds: [2, 9],
  maxRaisesPerStreet: 1,
  seed: 'all-in-profile-source',
});
const allInProfileObservation = structuredClone(allInSourceTarget.snapshot);
allInProfileObservation.observerIdx = allInSourceTarget.actorIdx;
const allInOpponent = allInProfileObservation.players.find(
  (player) => player.idx !== allInProfileObservation.observerIdx,
);
allInOpponent.hp = 0;
allInOpponent.allIn = true;
allInOpponent.position = null;
const allInProfileWithObserver = buildExactInfosetTrainingSnapshot(allInProfileObservation);
const { observerIdx: allInActor, ...allInSnapshot } = allInProfileWithObserver;
const allInTarget = {
  actorIdx: allInActor,
  snapshot: allInSnapshot,
  targetKey: buildTargetKeyFromSnapshot(allInSnapshot, allInActor, {
    maxRaisesPerStreet: 1,
  }),
};
const allInTargetGame = new QyjTargetedHoldemGame(allInTarget, {
  maxRaisesPerStreet: 1,
});
const allInRoot = allInTargetGame.createInitialState(new SerializableRng('all-in-profile'));
assert(allInTargetGame.legalActions(allInRoot).includes('allin'));
assert(allInTargetGame.legalActions(allInRoot).some((action) => action.startsWith('raise:')),
  'trainer action mask must match Engine when only all-in opponents remain');
const jammedAllInRoot = allInTargetGame.nextState(allInRoot, 'allin');
assert(jammedAllInRoot.terminal);
assert(allInTargetGame.assertState(jammedAllInRoot),
  'unmatched excess must be refunded while conserving all chips');

// Strict allow-list: private opponent cards, deck/runout and wrapper extras are rejected.
const withDeck = structuredClone(cheapTargetA);
withDeck.snapshot.deck = [];
assert.throws(() => normalizeTargetDefinition(withDeck, { maxRaisesPerStreet: 0 }),
  /unsupported field deck/);

const withOpponentHole = structuredClone(cheapTargetA);
withOpponentHole.snapshot.players[1].hole = [{ rank: 14, suit: 1 }, { rank: 13, suit: 1 }];
assert.throws(() => normalizeTargetDefinition(withOpponentHole, { maxRaisesPerStreet: 0 }),
  /unsupported field hole/);

const withFutureBoard = structuredClone(historyTarget);
withFutureBoard.snapshot.actionHistory[0].futureBoard = [{ rank: 14, suit: 4 }];
assert.throws(() => normalizeTargetDefinition(withFutureBoard, { maxRaisesPerStreet: 1 }),
  /unsupported field futureBoard/);

const withWrapperLeak = { ...cheapTargetA, engine: { secret: true } };
assert.throws(() => normalizeTargetDefinition(withWrapperLeak, { maxRaisesPerStreet: 0 }),
  /unsupported field engine/);

console.log('targeted blueprint tests passed: exact public roots, real visits, determinism, legality, privacy');
