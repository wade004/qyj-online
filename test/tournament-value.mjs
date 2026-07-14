import assert from 'node:assert/strict';

import {
  TOURNAMENT_VALUE_FEATURES,
  TOURNAMENT_VALUE_SCHEMA,
  TOURNAMENT_VALUE_VERSION,
  compileTournamentValueModel,
  encodeTournamentPublicState,
  normalizedFinalRankValue,
  parseTournamentValueModel,
  predictTournamentValue,
  projectTournamentValueTrainingSamples,
  serializeTournamentValueModel,
  trainTournamentValueModel,
} from '../training/tournament-value/model.js';

function publicState(tableSize, index) {
  const bigBlind = 20 * (2 ** (index % 4));
  const focalStack = 180 + ((index * 137 + tableSize * 53) % 2_700);
  const opponentStacks = Array.from({ length: tableSize - 1 }, (_, opponent) => {
    if ((index + opponent * 3 + tableSize) % 23 === 0) return 0;
    return 120 + ((index * 97 + opponent * 431 + tableSize * 31) % 3_100);
  });
  if (opponentStacks.every((stack) => stack === 0)) opponentStacks[0] = 120;
  const liveOpponents = opponentStacks.filter((stack) => stack > 0);
  const aliveCount = liveOpponents.length + 1;
  const focalPosition = index % aliveCount;
  let opponentIndex = 0;
  const liveStacksFromButton = Array.from({ length: aliveCount }, (_, position) => (
    position === focalPosition ? focalStack : liveOpponents[opponentIndex++]
  ));
  return {
    tableSize,
    round: index % 12,
    maxRounds: 12,
    bigBlind,
    focalStack,
    opponentStacks,
    liveStacksFromButton,
    focalPosition,
  };
}

function rankLabel(state) {
  const rank = 1 + state.opponentStacks.filter((stack) => stack > state.focalStack).length;
  return normalizedFinalRankValue(rank, state.tableSize);
}

function meanForTest(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const samples = [2, 6, 9].flatMap((tableSize) => (
  Array.from({ length: 90 }, (_, index) => {
    const state = publicState(tableSize, index);
    return { state, value: rankLabel(state) };
  })
));

function collectorSample(state, index) {
  const rank = 1 + state.opponentStacks.filter((stack) => stack > state.focalStack).length;
  return {
    schema: 'qyj-tournament-value-sample-v2',
    sampleId: `sample-${index}`,
    group: { seedGroup: `seed-${index % 3}`, matchId: `match-${index}` },
    state,
    target: {
      rank,
      rankUtility: normalizedFinalRankValue(rank, state.tableSize),
      firstPlace: rank === 1,
    },
  };
}

assert.equal(normalizedFinalRankValue(1, 9), 1);
assert.equal(normalizedFinalRankValue(5, 9), 0);
assert.equal(normalizedFinalRankValue(9, 9), -1);
assert.equal(normalizedFinalRankValue(2, 2), -1);

const collectorRows = samples.slice(0, 24).map((sample, index) => (
  collectorSample(sample.state, index)
));
collectorRows.push(collectorSample({
  ...publicState(6, 42),
  round: 12,
}, 24));
collectorRows.push(collectorSample({
  ...publicState(6, 43),
  focalStack: 0,
  liveStacksFromButton: publicState(6, 43).liveStacksFromButton.filter(
    (_, position) => position !== publicState(6, 43).focalPosition,
  ),
  focalPosition: null,
}, 25));
collectorRows.push(collectorSample({
  ...publicState(6, 44),
  opponentStacks: [0, 0, 0, 0, 0],
  liveStacksFromButton: [publicState(6, 44).focalStack],
  focalPosition: 0,
}, 26));
const projected = projectTournamentValueTrainingSamples(collectorRows);
assert.equal(projected.inputCount, 27);
assert.equal(projected.continuationCount, 24);
assert.equal(projected.droppedTerminal, 1,
  'exact terminal rows must be reported and excluded from continuation training');
assert.equal(projected.droppedEliminated, 1);
assert.equal(projected.droppedEarlyFinish, 1);
assert.equal(projected.droppedExact, 3);
assert.deepEqual(projected.rows[0], samples[0]);
assert.equal(projected.clusterIds.length, projected.rows.length);
assert(projected.rows.every((row) => row.state.focalStack > 0
  && row.state.liveStacksFromButton.length >= 2));
const metadataChanged = structuredClone(collectorRows);
metadataChanged.forEach((sample, index) => {
  sample.sampleId = `unrelated-id-${index}`;
  sample.group = {
    seedGroup: `replacement-cluster-${index % 4}`,
    anything: 'metadata is never a feature',
  };
});
assert.deepEqual(
  projectTournamentValueTrainingSamples(metadataChanged).rows,
  projected.rows,
  'group/sample IDs must not enter model rows or features',
);
assert.notDeepEqual(
  projectTournamentValueTrainingSamples(metadataChanged).clusterIds,
  projected.clusterIds,
  'seed groups must remain available only as aligned bootstrap clusters',
);

for (const tableSize of [2, 6, 9]) {
  const state = publicState(tableSize, tableSize + 7);
  const features = encodeTournamentPublicState(state);
  assert.equal(features.length, TOURNAMENT_VALUE_FEATURES.length);
  assert(features.every(Number.isFinite));
  const reversed = { ...state, opponentStacks: [...state.opponentStacks].reverse() };
  assert.deepEqual(
    encodeTournamentPublicState(reversed),
    features,
    `${tableSize}-player features must not depend on opponent seat order`,
  );
  const positionalOneHot = [
    'focalIsButton',
    'focalIsSmallBlind',
    'focalIsBigBlind',
    'focalIsOtherPosition',
  ].map((name) => features[TOURNAMENT_VALUE_FEATURES.indexOf(name)]);
  assert.equal(positionalOneHot.reduce((sum, value) => sum + value, 0), 1);
}

const extremePermutation = {
  tableSize: 3,
  round: 1,
  maxRounds: 12,
  bigBlind: 20,
  focalStack: 1,
  opponentStacks: [1e16, 1],
  liveStacksFromButton: [1e16, 1, 1],
  focalPosition: 1,
};
assert.deepEqual(
  encodeTournamentPublicState(extremePermutation),
  encodeTournamentPublicState({
    ...extremePermutation,
    opponentStacks: [...extremePermutation.opponentStacks].reverse(),
  }),
  'canonical compensated totals must preserve exact permutation invariance',
);

const options = {
  ensembleSize: 7,
  ridge: 0.02,
  seed: 'public-tournament-value-test',
  clusterIds: samples.map((_, index) => `training-cluster-${Math.floor(index / 3)}`),
};
const first = trainTournamentValueModel(samples, options);
const second = trainTournamentValueModel(structuredClone(samples), options);
assert.equal(first.schema, TOURNAMENT_VALUE_SCHEMA);
assert.equal(first.version, TOURNAMENT_VALUE_VERSION);
assert.equal(first.training.sampleCount, samples.length);
assert.equal(first.training.clusterCount, samples.length / 3);
assert.equal(first.training.bootstrapUnit, 'seed-group-cluster');
assert(first.training.oobSampleCount > 0);
assert(Number.isFinite(first.training.residualStd));
assert.equal(first.members.length, options.ensembleSize);
assert.equal(
  serializeTournamentValueModel(first),
  serializeTournamentValueModel(second),
  'same rows/options/seed must produce byte-identical artifacts',
);
assert.notEqual(
  serializeTournamentValueModel(first),
  serializeTournamentValueModel(trainTournamentValueModel(samples, {
    ...options, seed: 'public-tournament-value-other-seed',
  })),
  'bootstrap seed must affect the learned ensemble',
);

const clusterBaseRows = samples.slice(0, 60);
const clusterBaseIds = clusterBaseRows.map(
  (_, index) => `independent-${Math.floor(index / 3)}`,
);
const duplicateFactor = 20;
const duplicatedRows = clusterBaseRows.flatMap((row) => (
  Array.from({ length: duplicateFactor }, () => structuredClone(row))
));
const duplicatedClusterIds = clusterBaseIds.flatMap((clusterId) => (
  Array(duplicateFactor).fill(clusterId)
));
const clusterModel = compileTournamentValueModel(trainTournamentValueModel(
  clusterBaseRows,
  { ...options, ensembleSize: 11, clusterIds: clusterBaseIds, seed: 'cluster-audit' },
));
const duplicatedClusterModel = compileTournamentValueModel(trainTournamentValueModel(
  duplicatedRows,
  {
    ...options,
    ensembleSize: 11,
    clusterIds: duplicatedClusterIds,
    seed: 'cluster-audit',
  },
));
const averageEpistemic = (model) => meanForTest(clusterBaseRows.map((row) => (
  model.predict(row.state).epistemicStd
)));
const baseEpistemic = averageEpistemic(clusterModel);
const duplicatedEpistemic = averageEpistemic(duplicatedClusterModel);
assert(baseEpistemic > 0);
assert(Math.abs(duplicatedEpistemic / baseEpistemic - 1) < 0.15,
  'duplicating rows inside the same clusters must not manufacture confidence');

const compiled = compileTournamentValueModel(first);
const state = publicState(9, 37);
const permutedState = { ...state, opponentStacks: [...state.opponentStacks].reverse() };
const prediction = compiled.predict(state);
assert.deepEqual(compiled.predict(permutedState), prediction,
  'inference must be exactly opponent-order invariant');
assert.deepEqual(predictTournamentValue(compiled, state), prediction,
  'predict must accept a compiled model');
assert.deepEqual(predictTournamentValue(first, state), prediction,
  'predict must also validate and compile a raw artifact');
assert(prediction.mean >= -1 && prediction.mean <= 1);
assert.equal(typeof prediction.clipped, 'boolean');
assert(prediction.uncertainty >= prediction.epistemicStd);
assert(Number.isFinite(prediction.oodScore));

const json = serializeTournamentValueModel(compiled, 2);
const reorderedArtifact = {
  version: first.version,
  schema: first.schema,
  training: Object.fromEntries(Object.entries(first.training).reverse()),
  scaler: Object.fromEntries(Object.entries(first.scaler).reverse()),
  ood: Object.fromEntries(Object.entries(first.ood).reverse()),
  members: first.members.map((member) => ({
    coefficients: member.coefficients,
    intercept: member.intercept,
  })),
  featureSchema: Object.fromEntries(Object.entries(first.featureSchema).reverse()),
};
assert.equal(
  serializeTournamentValueModel(reorderedArtifact, 2),
  json,
  'serialization must recursively canonicalize object key order',
);
const reparsed = parseTournamentValueModel(json);
assert.deepEqual(reparsed.predict(state), prediction,
  'JSON serialization must preserve inference exactly');
assert(!json.includes('opponentStacks') || json.includes('stateFields'),
  'the model may name its schema but must not retain source stack rows');
assert.equal(Object.hasOwn(first, 'samples'), false);
assert(!json.includes('"state":') && !json.includes('"seatId"') && !json.includes('"holeCards"'),
  'serialized artifacts must not retain source public-state rows or private identifiers');
assert(!json.includes('training-cluster-'),
  'bootstrap cluster identifiers must never be serialized');

const knownPredictions = samples.map((sample) => compiled.predict(sample.state));
assert(knownPredictions.some((result) => result.ood === false),
  'the OOD envelope must accept supported training-domain states');
const farOutsideTraining = {
  tableSize: 9,
  round: 11,
  maxRounds: 12,
  bigBlind: 0.0001,
  focalStack: 1_000_000_000_000,
  opponentStacks: Array(8).fill(1),
  liveStacksFromButton: [1_000_000_000_000, ...Array(8).fill(1)],
  focalPosition: 0,
};
const outsidePrediction = compiled.predict(farOutsideTraining);
assert.equal(outsidePrediction.ood, true,
  'extreme public states must signal that the integration layer should fall back');
assert(outsidePrediction.oodScore > 1);

const unsupportedTable = compiled.predict(publicState(3, 8));
assert.equal(unsupportedTable.supportedTableSize, false);
assert.equal(unsupportedTable.supportedStratum, false);
assert.equal(unsupportedTable.ood, true,
  'a numerically interpolated but untrained table size must always be OOD');
const unsupportedStratumState = {
  tableSize: 6,
  round: 5,
  maxRounds: 12,
  bigBlind: 40,
  focalStack: 1_500,
  opponentStacks: [1_500, 0, 0, 0, 0],
  liveStacksFromButton: [1_500, 1_500],
  focalPosition: 0,
};
const unsupportedStratum = compiled.predict(unsupportedStratumState);
assert.equal(unsupportedStratum.supportedTableSize, true);
assert.equal(unsupportedStratum.supportedStratum, false);
assert.equal(unsupportedStratum.ood, true,
  'an unseen round/alive-count stratum on a trained table must always be OOD');

const valid = publicState(6, 10);
assert.throws(() => encodeTournamentPublicState({ ...valid, seatId: 'seat-3' }), /unknown field/);
assert.throws(() => encodeTournamentPublicState({ ...valid, holeCards: ['SA', 'SK'] }), /unknown field/);
assert.throws(() => encodeTournamentPublicState({ ...valid, focalStack: '1000' }), /finite number/);
assert.throws(() => encodeTournamentPublicState({
  ...valid, opponentStacks: [NaN, ...valid.opponentStacks.slice(1)],
}), /finite number/);
assert.throws(() => encodeTournamentPublicState({
  ...valid, opponentStacks: valid.opponentStacks.slice(1),
}), /cover every other table position/);
assert.throws(() => encodeTournamentPublicState({ ...valid, round: valid.maxRounds }), /0\.\.11/,
  'terminal states are deliberately excluded because they have exact rank value');
assert.throws(() => encodeTournamentPublicState({
  ...valid,
  focalPosition: (valid.focalPosition + 1) % valid.liveStacksFromButton.length,
}), /must identify/);
assert.throws(() => encodeTournamentPublicState({
  ...valid,
  liveStacksFromButton: valid.liveStacksFromButton.slice(1),
}), /every positive table stack/);
assert.throws(() => trainTournamentValueModel(samples.map((sample, index) => (
  index ? sample : { state: valid, value: 0.12345 }
)), options), /normalized final-rank utility/);
assert.throws(() => trainTournamentValueModel(samples.map((sample, index) => (
  index ? sample : { ...sample, seatId: 2 }
)), options), /unknown field/);
assert.throws(() => trainTournamentValueModel(samples, {
  ...options, ridge: 1e-12,
}), /at least 1e-8/);
assert.throws(() => projectTournamentValueTrainingSamples([
  { ...collectorRows[0], actorSeat: 3 },
]), /unknown field/);

const artifactWithUnknownField = structuredClone(first);
artifactWithUnknownField.debug = { rows: samples };
assert.throws(() => compileTournamentValueModel(artifactWithUnknownField), /unknown field/);
const artifactWithNonFiniteWeight = structuredClone(first);
artifactWithNonFiniteWeight.members[0].coefficients[0] = NaN;
assert.throws(() => compileTournamentValueModel(artifactWithNonFiniteWeight), /finite number/);
const artifactWithUnknownNestedField = structuredClone(first);
artifactWithUnknownNestedField.ood.note = 'trust me';
assert.throws(() => compileTournamentValueModel(artifactWithUnknownNestedField), /unknown field/);

console.log('tournament value tests passed: strict public 2/6/9-player deterministic ensemble + OOD');
