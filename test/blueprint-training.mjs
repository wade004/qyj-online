import assert from 'node:assert/strict';
import {
  BLUEPRINT_ABSTRACTION,
  buildBlueprintInfoSetKey,
  compileBlueprintCheckpoint,
  lookupBlueprintDistribution,
} from '../js/game/blueprint-policy.js';
import { ExternalSamplingMccfr, regretMatching } from '../training/blueprint/mccfr.js';
import {
  QyjAbstractHoldemGame,
  abstractObservation,
} from '../training/blueprint/qyj-abstract-game.js';
import { SerializableRng } from '../training/blueprint/rng.js';

// Serializable seed/state contract.
const rng = new SerializableRng('resume-seed');
const prefix = Array.from({ length: 8 }, () => rng.next());
const savedRng = rng.snapshot();
const suffix = Array.from({ length: 8 }, () => rng.next());
const restoredRng = SerializableRng.restore(savedRng);
assert.deepEqual(Array.from({ length: 8 }, () => restoredRng.next()), suffix);
assert.equal(new Set(prefix).size, prefix.length);

// Regret matching: positive regrets normalize, all non-positive regrets fall
// back to a legal uniform policy.
assert.deepEqual({ ...regretMatching({ regretSum: { a: 2, b: -5 } }, ['a', 'b']) },
  { a: 1, b: 0 });
assert.deepEqual({ ...regretMatching({ regretSum: { a: 0, b: 0 } }, ['a', 'b']) },
  { a: 0.5, b: 0.5 });

// Exercise every supported seat count through random complete trajectories.
for (const tableSize of [2, 3, 6, 9]) {
  const game = new QyjAbstractHoldemGame({ tableSize, stackBb: 7, maxRaisesPerStreet: 1 });
  const walkRng = new SerializableRng(`walk-${tableSize}`);
  for (let hand = 0; hand < 30; hand++) {
    let state = game.createInitialState(walkRng);
    game.assertState(state);
    let decisions = 0;
    while (!state.terminal && decisions++ < 120) {
      const actions = game.legalActions(state);
      assert(actions.length > 0);
      state = game.nextState(state, actions[walkRng.int(actions.length)]);
      game.assertState(state);
    }
    assert.equal(state.terminal, true, `${tableSize}-seat hand must terminate`);
    const utilitySum = Array.from({ length: tableSize }, (_, player) => game.utility(state, player))
      .reduce((sum, value) => sum + value, 0);
    assert(Math.abs(utilitySum) < 1e-8, `${tableSize}-seat terminal utilities must be zero-sum`);
  }
}

// Split pots use the production Engine's integer-chip rule independently for
// every layer.  The odd chip starts after the public dealer even when the
// surviving hand occupies non-contiguous seats of a larger physical ring.
const oddChipGame = new QyjAbstractHoldemGame({
  tableSize: 4, stackBb: 10, maxRaisesPerStreet: 0,
});
let oddChipState = oddChipGame.createInitialState(new SerializableRng('sparse-odd-chip'));
oddChipState.seatIds = [1, 3, 6, 9];
oddChipState.publicSeatCapacity = 9;
oddChipState.dealer = 2; // public seat 6; clockwise winners are 1, 3, then 6.
oddChipState.board = [
  { rank: 10, suit: 1 }, { rank: 11, suit: 1 }, { rank: 12, suit: 1 },
  { rank: 13, suit: 1 }, { rank: 14, suit: 1 },
];
oddChipState.hole = [
  [{ rank: 2, suit: 2 }, { rank: 3, suit: 3 }],
  [{ rank: 4, suit: 2 }, { rank: 5, suit: 3 }],
  [{ rank: 6, suit: 2 }, { rank: 7, suit: 3 }],
  [{ rank: 8, suit: 2 }, { rank: 9, suit: 3 }],
];
oddChipState.initialStacks = [3, 3, 2, 2];
oddChipState.hp = [1, 1, 1, 1];
oddChipState.folded = [false, false, false, true];
oddChipState.allIn = [false, false, false, false];
oddChipState.betStreet = [0, 0, 0, 0];
oddChipState.betRound = [2, 2, 1, 1];
oddChipState.acted = [false, false, false, false];
oddChipState.lastActionBet = [0, 0, 0, 0];
oddChipState.pending = [true, true, true, false];
oddChipState.streetIndex = 3;
oddChipState.street = 'river';
oddChipState.revealed = 5;
oddChipState.currentBet = 0;
oddChipState.minRaiseIncrement = 10;
oddChipState.raiseCount = 0;
oddChipState.actingSeat = 0;
oddChipState.terminal = false;
oddChipState.terminalStacks = null;
oddChipState.actionHistory = [];
oddChipGame.assertState(oddChipState);
while (!oddChipState.terminal) {
  assert.deepEqual(oddChipGame.legalActions(oddChipState), ['check']);
  oddChipState = oddChipGame.nextState(oddChipState, 'check');
}
assert.deepEqual(
  oddChipState.terminalStacks,
  [4, 3, 2, 1],
  'main/side pots must floor each split and award the main-pot odd chip to public seat 1',
);
oddChipGame.assertState(oddChipState);

// A short all-in below the minimum raise makes every unmatched player act
// again, but it must not reopen raising for a player who already acted. Match
// the production Engine's acted/lastActionBet rule exactly.
const underRaiseGame = new QyjAbstractHoldemGame({
  tableSize: 3, stackBb: 100, maxRaisesPerStreet: 3,
});
let underRaise = underRaiseGame.createInitialState(new SerializableRng('under-raise'));
underRaise.initialStacks = [1000, 130, 1000];
underRaise.hp = [900, 130, 1000];
underRaise.betStreet = [100, 0, 0];
underRaise.betRound = [100, 0, 0];
underRaise.currentBet = 100;
underRaise.minRaiseIncrement = 100;
underRaise.raiseCount = 0;
underRaise.acted = [true, false, false];
underRaise.lastActionBet = [100, 0, 0];
underRaise.pending = [false, true, true];
underRaise.actingSeat = 1;
assert(underRaiseGame.legalActions(underRaise).includes('allin'));
underRaise = underRaiseGame.nextState(underRaise, 'allin');
assert.equal(underRaise.currentBet, 130);
assert.equal(underRaise.minRaiseIncrement, 100,
  'an incomplete all-in must not reduce the minimum full-raise increment');
assert.equal(underRaise.actingSeat, 2);
underRaise = underRaiseGame.nextState(underRaise, 'call');
assert.equal(underRaise.actingSeat, 0);
assert.deepEqual(underRaiseGame.legalActions(underRaise).sort(), ['call', 'fold'],
  'a previously acted player may call/fold but may not reraise an incomplete all-in');

// The trainer and browser call exactly the same public-information encoder.
const privacyGame = new QyjAbstractHoldemGame({ tableSize: 3, stackBb: 10 });
const privacyState = privacyGame.createInitialState(new SerializableRng('privacy'));
const actor = privacyState.actingSeat;
const observation = abstractObservation(privacyState, actor);
assert.equal(privacyGame.infoSetKey(privacyState, actor), buildBlueprintInfoSetKey(observation, {
  position: observation.self.position,
  opts: observation.legalActions,
  tableSize: 3,
}));
const privateMutation = structuredClone(privacyState);
const opponent = (actor + 1) % 3;
privateMutation.hole[opponent] = privateMutation.hole[opponent].slice().reverse();
privateMutation.board[4] = { rank: privateMutation.board[4].rank === 14 ? 2 : 14, suit: 4 };
assert.equal(privacyGame.infoSetKey(privateMutation, actor), privacyGame.infoSetKey(privacyState, actor),
  'opponent cards and unrevealed board cards must not affect a preflop information key');
const ownMutation = structuredClone(privacyState);
ownMutation.hole[actor] = [{ rank: 14, suit: 1 }, { rank: 14, suit: 2 }];
const originalOwn = privacyState.hole[actor];
if (!(originalOwn[0].rank === 14 && originalOwn[1].rank === 14)) {
  assert.notEqual(privacyGame.infoSetKey(ownMutation, actor), privacyGame.infoSetKey(privacyState, actor));
}

// Small two-player zero-sum perfect-recall game: both average strategies in
// matching pennies should approach 50/50. This validates the generic MCCFR
// traversal independently from Hold'em abstractions.
class MatchingPennies {
  playerCount = 2;
  createInitialState() { return { phase: 0, first: null, second: null }; }
  isTerminal(state) { return state.phase === 2; }
  currentPlayer(state) { return state.phase; }
  legalActions() { return ['H', 'T']; }
  infoSetKey(_state, player) { return `matching-pennies:p${player}`; }
  nextState(state, action) {
    return state.phase === 0
      ? { phase: 1, first: action, second: null }
      : { phase: 2, first: state.first, second: action };
  }
  utility(state, player) {
    const firstWins = state.first === state.second;
    return player === 0 ? (firstWins ? 1 : -1) : (firstWins ? -1 : 1);
  }
}
const equilibriumTrainer = new ExternalSamplingMccfr(new MatchingPennies(), { seed: 'equilibrium' });
equilibriumTrainer.train(3000);
const equilibrium = equilibriumTrainer.toCheckpoint();
for (const player of [0, 1]) {
  const probability = equilibrium.infosets[`matching-pennies:p${player}`].strategy.H;
  assert(probability > 0.42 && probability < 0.58,
    `matching-pennies player ${player} average must be near 50/50, got ${probability}`);
}

// Traverser action utilities use Welford moments. The adapter emits a stable
// alternating sequence so mean and unnormalised second moment are exact.
class AlternatingActionValues {
  playerCount = 2;
  roots = 0;
  createInitialState() {
    const scenario = Math.floor(this.roots++ / this.playerCount) % 2;
    return { terminal: false, scenario, action: null };
  }
  isTerminal(state) { return state.terminal; }
  currentPlayer(state) { return state.terminal ? null : 0; }
  legalActions() { return ['a', 'b']; }
  infoSetKey() { return 'alternating-action-values:p0'; }
  nextState(state, action) { return { ...state, terminal: true, action }; }
  utility(state, player) {
    const playerZero = state.action === 'a'
      ? [1, 3][state.scenario]
      : [-2, 2][state.scenario];
    return player === 0 ? playerZero : -playerZero;
  }
}
const valueTrainer = new ExternalSamplingMccfr(
  new AlternatingActionValues(),
  { seed: 'action-value-moments' },
);
valueTrainer.train(4);
const valueCheckpoint = valueTrainer.toCheckpoint();
assert.deepEqual(valueCheckpoint.infosets['alternating-action-values:p0'].actionValues, {
  a: { samples: 4, mean: 2, m2: 4 },
  b: { samples: 4, mean: 0, m2: 16 },
});
assert.deepEqual(
  valueCheckpoint.trainerState.nodes['alternating-action-values:p0'].actionValues,
  valueCheckpoint.infosets['alternating-action-values:p0'].actionValues,
  'runtime and resumable checkpoints must publish the same action-value moments',
);

// Determinism and exact resume: 5 + 7 iterations must equal uninterrupted 12.
const options = { tableSize: 2, stackBb: 6, maxRaisesPerStreet: 1 };
const full = new ExternalSamplingMccfr(new QyjAbstractHoldemGame(options), { seed: 'exact-resume' });
full.train(12);
const split = new ExternalSamplingMccfr(new QyjAbstractHoldemGame(options), { seed: 'exact-resume' });
split.train(5);
const splitCheckpoint = split.toCheckpoint({ metadata: { gameConfig: options } });
const resumed = ExternalSamplingMccfr.fromCheckpoint(
  new QyjAbstractHoldemGame(options),
  splitCheckpoint,
);
resumed.train(7);
const fullCheckpoint = full.toCheckpoint({ metadata: { gameConfig: options } });
const resumedCheckpoint = resumed.toCheckpoint({ metadata: { gameConfig: options } });
assert.deepEqual(resumedCheckpoint, fullCheckpoint);

// A second fresh run is deterministic, the browser validator accepts the
// artifact, and per-infoset visits survive compilation for confidence caps.
const repeat = new ExternalSamplingMccfr(new QyjAbstractHoldemGame(options), { seed: 'exact-resume' });
repeat.train(12);
assert.deepEqual(repeat.toCheckpoint({ metadata: { gameConfig: options } }), fullCheckpoint);
assert.equal(fullCheckpoint.metadata.abstraction, BLUEPRINT_ABSTRACTION);
const compiled = compileBlueprintCheckpoint(fullCheckpoint);
const firstKey = Object.keys(fullCheckpoint.infosets)[0];
const compiledEntry = lookupBlueprintDistribution(compiled, firstKey);
assert(compiledEntry && compiledEntry.strategy.length > 0);
assert(Number.isInteger(compiledEntry.visits) && compiledEntry.visits > 0);
const firstActionValues = fullCheckpoint.infosets[firstKey].actionValues;
assert.deepEqual(Object.keys(firstActionValues).sort(),
  Object.keys(fullCheckpoint.infosets[firstKey].strategy).sort());
for (const value of Object.values(firstActionValues)) {
  assert(Number.isSafeInteger(value.samples) && value.samples >= 0);
  assert(Number.isFinite(value.mean));
  assert(Number.isFinite(value.m2) && value.m2 >= 0);
  assert(value.samples <= fullCheckpoint.infosets[firstKey].visits);
}

const runtimeOnly = full.toCheckpoint({ includeTrainerState: false });
assert(runtimeOnly.infosets[firstKey].actionValues,
  'runtime-only checkpoints must retain per-action utility moments');
assert.throws(() => ExternalSamplingMccfr.fromCheckpoint(new QyjAbstractHoldemGame(options), runtimeOnly),
  /trainerState/);

// Checkpoints created before action-value statistics existed remain resumable.
// Missing moments start at zero and do not alter CFR/RNG evolution.
const withoutActionValues = (source) => {
  const checkpoint = structuredClone(source);
  for (const infoSet of Object.values(checkpoint.infosets || {})) delete infoSet.actionValues;
  for (const node of Object.values(checkpoint.trainerState?.nodes || {})) {
    delete node.actionValues;
  }
  return checkpoint;
};
const legacyCheckpoint = withoutActionValues(splitCheckpoint);
const legacyResume = ExternalSamplingMccfr.fromCheckpoint(
  new QyjAbstractHoldemGame(options),
  legacyCheckpoint,
);
const legacyBeforeTraining = legacyResume.toCheckpoint({ metadata: { gameConfig: options } });
const legacyFirstKey = Object.keys(legacyBeforeTraining.infosets)[0];
assert(Object.values(legacyBeforeTraining.infosets[legacyFirstKey].actionValues)
  .every((value) => value.samples === 0 && value.mean === 0 && value.m2 === 0),
'an old checkpoint must initialise missing action-value moments without inventing samples');
const modernControl = ExternalSamplingMccfr.fromCheckpoint(
  new QyjAbstractHoldemGame(options),
  splitCheckpoint,
);
legacyResume.train(1);
modernControl.train(1);
assert.deepEqual(
  withoutActionValues(legacyResume.toCheckpoint({ metadata: { gameConfig: options } })),
  withoutActionValues(modernControl.toCheckpoint({ metadata: { gameConfig: options } })),
  'action-value history must not affect regrets, strategies, RNG or deterministic resume',
);

// Resume rejects corrupted provenance/counters instead of silently changing
// the linear-averaging weights or republishing a foreign abstraction.
const resumable = full.toCheckpoint({
  metadata: { gameConfig: options, seed: 'exact-resume' },
});
assert.doesNotThrow(() => ExternalSamplingMccfr.fromCheckpoint(
  new QyjAbstractHoldemGame(options), resumable,
));
const corruptedCheckpoint = (mutate) => {
  const checkpoint = structuredClone(resumable);
  mutate(checkpoint);
  return checkpoint;
};
for (const [label, checkpoint, pattern] of [
  ['foreign abstraction', corruptedCheckpoint((value) => {
    value.metadata.abstraction = 'foreign-abstraction';
  }), /abstraction/],
  ['foreign algorithm', corruptedCheckpoint((value) => {
    value.metadata.algorithm = 'foreign-algorithm';
  }), /external-sampling-mccfr/],
  ['negative iterations', corruptedCheckpoint((value) => {
    value.trainerState.iterations = -1;
  }), /trainerState\.iterations/],
  ['fractional utility samples', corruptedCheckpoint((value) => {
    value.trainerState.utilitySamples = 1.5;
  }), /trainerState\.utilitySamples/],
  ['metadata iteration mismatch', corruptedCheckpoint((value) => {
    value.metadata.iterations++;
  }), /metadata\.iterations does not match/],
  ['seed mismatch', corruptedCheckpoint((value) => {
    value.metadata.seed = 'different-seed';
  }), /metadata\.seed does not match/],
  ['infinite node visits', corruptedCheckpoint((value) => {
    const key = Object.keys(value.trainerState.nodes)[0];
    value.trainerState.nodes[key].visits = Number.POSITIVE_INFINITY;
  }), /checkpoint visits/],
  ['negative traverser visits', corruptedCheckpoint((value) => {
    const key = Object.keys(value.trainerState.nodes)[0];
    value.trainerState.nodes[key].traverserVisits = -1;
  }), /checkpoint traverserVisits/],
  ['negative action-value samples', corruptedCheckpoint((value) => {
    const key = Object.keys(value.trainerState.nodes)[0];
    const action = value.trainerState.nodes[key].actions[0];
    value.trainerState.nodes[key].actionValues[action].samples = -1;
  }), /action value.*samples/],
  ['unsafe action-value samples', corruptedCheckpoint((value) => {
    const key = Object.keys(value.trainerState.nodes)[0];
    const action = value.trainerState.nodes[key].actions[0];
    value.trainerState.nodes[key].actionValues[action].samples = Number.MAX_SAFE_INTEGER + 1;
  }), /non-negative safe integer/],
  ['malformed action-value table', corruptedCheckpoint((value) => {
    const key = Object.keys(value.trainerState.nodes)[0];
    value.trainerState.nodes[key].actionValues = [];
  }), /action values.*must be an object/],
  ['non-finite action-value mean', corruptedCheckpoint((value) => {
    const key = Object.keys(value.trainerState.nodes)[0];
    const action = value.trainerState.nodes[key].actions[0];
    value.trainerState.nodes[key].actionValues[action].mean = Number.NaN;
  }), /action value.*mean/],
  ['negative action-value m2', corruptedCheckpoint((value) => {
    const key = Object.keys(value.trainerState.nodes)[0];
    const action = value.trainerState.nodes[key].actions[0];
    value.trainerState.nodes[key].actionValues[action].m2 = -1;
  }), /action value.*m2 must be non-negative/],
  ['zero-sample action-value with invented mean', corruptedCheckpoint((value) => {
    const key = Object.keys(value.trainerState.nodes)[0];
    const action = value.trainerState.nodes[key].actions[0];
    value.trainerState.nodes[key].actionValues[action] = {
      samples: 0,
      mean: 1,
      m2: 0,
    };
  }), /zero samples must have zero mean and m2/],
  ['action-value samples exceed traverser visits', corruptedCheckpoint((value) => {
    const key = Object.keys(value.trainerState.nodes)[0];
    const node = value.trainerState.nodes[key];
    const action = node.actions[0];
    node.actionValues[action] = {
      samples: node.traverserVisits + 1,
      mean: 0,
      m2: 0,
    };
  }), /exceed traverser visits/],
]) {
  assert.throws(
    () => ExternalSamplingMccfr.fromCheckpoint(new QyjAbstractHoldemGame(options), checkpoint),
    pattern,
    `${label} must not be resumable`,
  );
}

console.log('blueprint training tests passed');
