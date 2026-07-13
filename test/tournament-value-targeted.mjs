import assert from 'node:assert/strict';

import { getBlinds } from '../js/game/config.js';
import { abstractObservation, QyjAbstractHoldemGame } from '../training/blueprint/qyj-abstract-game.js';
import { SerializableRng } from '../training/blueprint/rng.js';
import { buildExactInfosetTrainingSnapshot } from '../training/blueprint/target-profile.js';
import {
  buildTargetKeyFromSnapshot,
  trainTargetedBlueprint,
} from '../training/blueprint/targeted.js';
import {
  normalizedFinalRankValue,
  trainTournamentValueModel,
} from '../training/tournament-value/model.js';
import { TargetedTournamentUtility } from '../training/tournament-value/targeted-utility.js';

const TABLE_SIZE = 6;
const BASE_RING = Object.freeze([1_800, 1_600, 1_500, 1_400, 1_300, 1_400]);

function rotate(values, offset) {
  return values.slice(offset).concat(values.slice(0, offset));
}

function modelState(ring, focalPosition, round) {
  const focalStack = ring[focalPosition];
  return {
    tableSize: TABLE_SIZE,
    round,
    maxRounds: 12,
    bigBlind: getBlinds(Math.min(12, round + 1)).bb,
    focalStack,
    opponentStacks: ring
      .filter((_, index) => index !== focalPosition)
      .sort((left, right) => right - left),
    liveStacksFromButton: [...ring],
    focalPosition,
  };
}

function rankValue(state) {
  const rank = 1 + state.opponentStacks.filter((stack) => stack > state.focalStack).length;
  return normalizedFinalRankValue(rank, state.tableSize);
}

const rows = [];
const clusterIds = [];
for (let variant = 0; variant < 18; variant++) {
  const delta = (variant % 5) * 20;
  const varied = BASE_RING.map((stack, index) => (
    index === 0 ? stack + delta : index === 1 ? stack - delta : stack
  ));
  for (const round of [2, 3, 4, 5]) {
    const ring = rotate(varied, round % TABLE_SIZE);
    for (let focal = 0; focal < TABLE_SIZE; focal++) {
      const state = modelState(ring, focal, round);
      rows.push({ state, value: rankValue(state) });
      clusterIds.push(`cluster-${variant}`);
    }
  }
}
// Exact roots used below must be categorical/in-range support, including the
// equal 1,500-stack root produced by QyjAbstractHoldemGame.
for (const [round, ring] of [[3, BASE_RING], [4, rotate(BASE_RING, 1)], [3, Array(6).fill(1_500)]]) {
  for (let focal = 0; focal < TABLE_SIZE; focal++) {
    for (const transfer of [0, 20]) {
      const probed = [...ring];
      if (transfer) {
        probed[focal] += transfer;
        probed[(focal + 1) % TABLE_SIZE] -= transfer;
      }
      const state = modelState(probed, focal, round);
      rows.push({ state, value: rankValue(state) });
      clusterIds.push(`exact-${round}-${ring[0]}-${focal}-${transfer}`);
    }
  }
}

const valueModel = trainTournamentValueModel(rows, {
  clusterIds,
  ensembleSize: 9,
  ridge: 0.02,
  monotonePriorWeight: 0.99,
  seed: 'targeted-tournament-utility-test',
});

function publicSnapshot({
  round = 4,
  ring = BASE_RING,
  tournament = true,
} = {}) {
  const snapshot = {
    round,
    dealerIdx: 1,
    handSeats: [1, 2, 3, 4, 5, 6],
    blinds: { ...getBlinds(round) },
  };
  if (tournament) {
    snapshot.tournament = {
      tableSize: TABLE_SIZE,
      maxRounds: 12,
      players: ring.map((hp, index) => ({ idx: index + 1, hp, alive: true })),
    };
  }
  return snapshot;
}

function abstractState({ initial = BASE_RING, terminal = BASE_RING } = {}) {
  return {
    terminal: true,
    seatIds: [1, 2, 3, 4, 5, 6],
    initialStacks: [...initial],
    terminalStacks: [...terminal],
  };
}

const utility = new TargetedTournamentUtility(valueModel, {
  maxUncertainty: 10,
});
const snapshot = publicSnapshot();
const root = abstractState();
const preflight = utility.preflight([{
  snapshot,
  abstractState: root,
  players: [0, 1, 2, 3, 4, 5],
}]);
assert.equal(preflight.enabled, true, JSON.stringify(preflight));
assert.equal(preflight.preflightPassed, 6);

const unchangedValues = Array.from({ length: TABLE_SIZE }, (_, player) => (
  utility.evaluate(snapshot, root, player, 0)
));
assert(Math.abs(unchangedValues.reduce((sum, value) => sum + value, 0)) <= 1e-9,
  'all live values must project to the exact zero-sum rank total');
assert(unchangedValues.every((value) => value >= -1 && value <= 1));

// A focal bust has an exact locked placement and never calls continuation V.
const busted = abstractState({ terminal: [0, 2_000, 1_800, 1_700, 1_600, 1_900] });
assert.equal(utility.evaluate(snapshot, busted, 0, -90), -1);
assert(utility.diagnostics().exactRankValues >= 1);

// Extreme but chip-conserving leaves leave the learned continuous envelope.
// Every surviving seat still receives one same-scale projected fallback.
const extreme = abstractState({ terminal: [7_500, 300, 300, 300, 300, 300] });
const extremeValues = Array.from({ length: TABLE_SIZE }, (_, player) => (
  utility.evaluate(snapshot, extreme, player, 0)
));
assert(Math.abs(extremeValues.reduce((sum, value) => sum + value, 0)) <= 1e-9);
assert(utility.diagnostics().scaledChipFallbacks > 0,
  'OOD leaves must use normalized same-scale chip fallback');
assert(utility.diagnostics().maxRawSumError >= 0);

// A legacy public root disables the complete utility adapter before training;
// exact leaves must then remain raw BB chip EV as well.
const legacy = new TargetedTournamentUtility(valueModel, { maxUncertainty: 10 });
assert.equal(legacy.preflight([{
  snapshot: publicSnapshot({ tournament: false }),
  abstractState: root,
  players: [0, 1, 2, 3, 4, 5],
}]).enabled, false);
assert.equal(legacy.evaluate(publicSnapshot({ tournament: false }), busted, 0, -90), -90);

function realTarget() {
  const game = new QyjAbstractHoldemGame({
    tableSize: 6,
    round: 4,
    bb: 40,
    sb: 20,
    stackBb: 37.5,
    maxRaisesPerStreet: 0,
  });
  const state = game.createInitialState(new SerializableRng('tv-target-root'));
  const actor = state.actingSeat;
  const trainingSnapshot = buildExactInfosetTrainingSnapshot(
    abstractObservation(state, actor),
  );
  const { observerIdx: actorIdx, ...targetSnapshot } = trainingSnapshot;
  const targetKey = buildTargetKeyFromSnapshot(targetSnapshot, actorIdx, {
    maxRaisesPerStreet: 0,
  });
  return { targetKey, actorIdx, snapshot: targetSnapshot };
}

const target = realTarget();
const trainOptions = {
  visitsPerTarget: 2,
  seed: 'tv-targeted-determinism',
  maxRaisesPerStreet: 0,
  maxDepth: 100,
  tournamentValueModel: valueModel,
  tournamentValueMaxUncertainty: 10,
};
const checkpointA = trainTargetedBlueprint(target, trainOptions);
const checkpointB = trainTargetedBlueprint(structuredClone(target), trainOptions);
assert.deepEqual(checkpointA, checkpointB,
  'tournament-value targeted training must remain byte/object deterministic');
assert.equal(checkpointA.metadata.terminalUtility.requested, true);
assert.equal(checkpointA.metadata.terminalUtility.enabled, true);
assert.equal(
  checkpointA.metadata.terminalUtility.objective,
  'normalized-final-rank-continuation-value',
);
assert(checkpointA.metadata.terminalUtility.jointProjections > 0);

console.log('targeted tournament value tests passed: root gate, exact rank, OOD fallback, joint projection and deterministic MCCFR');
