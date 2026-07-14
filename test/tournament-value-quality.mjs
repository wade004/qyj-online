import assert from 'node:assert/strict';

import {
  buildTournamentValueDataset,
  createTournamentValueSample,
  tournamentValueOpaqueId,
} from '../training/tournament-value/dataset.mjs';
import {
  projectTournamentValueTrainingSamples,
  trainTournamentValueModel,
} from '../training/tournament-value/model.js';
import {
  currentStackRankBaseline,
  evaluateTournamentValueSplit,
  stressTournamentValueModel,
  tournamentValuePromotionGate,
} from '../training/tournament-value/quality.mjs';

const secret = 'quality-test-secret-material-32-bytes-minimum';

function state(tableSize, group, round) {
  const liveCount = Math.max(2, tableSize - Math.floor(round / 4));
  const ring = Array.from({ length: liveCount }, (_, position) => (
    500 + ((group * 311 + round * 137 + position * 719) % 2_600)
  ));
  const focalPosition = (group + round) % liveCount;
  const focalStack = ring[focalPosition];
  return {
    tableSize,
    round,
    maxRounds: 12,
    bigBlind: [20, 40, 80, 160][Math.min(3, Math.floor(round / 3))],
    focalStack,
    opponentStacks: [
      ...ring.filter((_, index) => index !== focalPosition),
      ...Array(tableSize - liveCount).fill(0),
    ].sort((left, right) => right - left),
    liveStacksFromButton: ring,
    focalPosition,
  };
}

const samples = [];
for (const tableSize of [6, 9]) {
  for (let group = 0; group < 15; group++) {
    const groupId = tournamentValueOpaqueId(secret, 'group', tableSize, group);
    const matchId = tournamentValueOpaqueId(secret, 'match', tableSize, group);
    for (let round = 0; round < 10; round++) {
      const publicState = state(tableSize, group, round);
      const greater = publicState.opponentStacks
        .filter((stack) => stack > publicState.focalStack).length;
      const rank = greater + 1;
      samples.push(createTournamentValueSample({
        state: publicState,
        rank,
        seedGroup: groupId,
        matchId,
        sampleId: tournamentValueOpaqueId(secret, 'sample', tableSize, group, round),
      }));
    }
  }
}

const dataset = buildTournamentValueDataset(samples, {
  seed: 'quality-split',
  validationFraction: 0.2,
  testFraction: 0.2,
});
const train = projectTournamentValueTrainingSamples(dataset.splits.train);
const model = trainTournamentValueModel(train.rows, {
  clusterIds: train.clusterIds,
  ensembleSize: 9,
  ridge: 0.02,
  seed: 'quality-model',
});
const options = {
  bootstrapIterations: 200,
  confidence: 0.95,
  seed: 'quality-eval',
  maxUncertainty: 10,
};
const first = evaluateTournamentValueSplit(model, dataset.splits.test, options);
const second = evaluateTournamentValueSplit(model, dataset.splits.test, options);
assert.deepEqual(first, second, 'quality metrics and cluster CI must be deterministic');
assert.deepEqual(Object.keys(first.byTable).sort(), ['6', '9']);
for (const table of [6, 9]) {
  assert(first.byTable[table].groups >= 1);
  assert(Number.isFinite(first.byTable[table].modelRmse));
  assert(Number.isFinite(first.byTable[table].baselineRmse));
  assert(Number.isFinite(first.byTable[table].rmseImprovementCi.low));
}

const probe = state(6, 3, 4);
assert(currentStackRankBaseline(probe) >= -1
  && currentStackRankBaseline(probe) <= 1);
const stress = stressTournamentValueModel(model, dataset.splits.test, { maxStates: 500 });
assert(stress.jointAccepted > 0 && stress.monotonicTests > 0);
assert(stress.maxProjectedSumError <= 1e-9,
  'joint integration projection must satisfy the exact rank-value sum');

// Even with relaxed sample-count thresholds, a model cannot pass unless it
// materially beats the public current-stack baseline with a positive CI.
const gate = tournamentValuePromotionGate({
  trainSamples: dataset.splits.train,
  validationSamples: dataset.splits.validation,
  testSamples: dataset.splits.test,
  testMetrics: first,
  stress,
  thresholds: {
    minTrainGroupsPerTable: 1,
    minValidationGroupsPerTable: 1,
    minTestGroupsPerTable: 1,
    minRelativeRmseImprovement: 0.05,
    minCoverage: 0,
    maxClipRate: 1,
    maxMonotonicViolations: Number.MAX_SAFE_INTEGER,
    maxJointSumError: 1e-9,
  },
});
assert.equal(gate.passed, false);
assert(gate.blockers.some((blocker) => blocker.includes('rmse')),
  'a baseline-copying/weak model must not be promoted');
const pilot = tournamentValuePromotionGate({
  trainSamples: dataset.splits.train,
  validationSamples: dataset.splits.validation,
  testSamples: dataset.splits.test,
  testMetrics: first,
  stress,
  pilot: true,
  thresholds: {
    minTrainGroupsPerTable: 1,
    minValidationGroupsPerTable: 1,
    minTestGroupsPerTable: 1,
    minRelativeRmseImprovement: -10,
    minCoverage: 0,
    maxClipRate: 1,
    maxMonotonicViolations: Number.MAX_SAFE_INTEGER,
    maxJointSumError: 1e-9,
  },
});
assert.equal(pilot.passed, false);
assert.equal(pilot.blockers[0], 'pilot-mode');

// Deployment coverage is an explicit formal contract, not the accidental
// union of tables that happened to occur in the dataset.  Build otherwise
// passing diagnostics so each regression below isolates only that contract.
const passingMetrics = structuredClone(first);
for (const table of [6, 9]) {
  passingMetrics.byTable[table].relativeRmseImprovement = 0.25;
  passingMetrics.byTable[table].rmseImprovementCi.low = 0.1;
  passingMetrics.byTable[table].coverage = 1;
  passingMetrics.byTable[table].clipRate = 0;
}
const passingStress = {
  ...stress,
  monotonicViolations: 0,
  maxProjectedSumError: 0,
  monotonicTests: Math.max(1, stress.monotonicTests),
  jointAccepted: Math.max(1, stress.jointAccepted),
};
const relaxedThresholds = {
  minTrainGroupsPerTable: 1,
  minValidationGroupsPerTable: 1,
  minTestGroupsPerTable: 1,
  minRelativeRmseImprovement: 0.05,
  minCoverage: 0.95,
  maxClipRate: 0.001,
  maxMonotonicViolations: 0,
  maxJointSumError: 1e-9,
};
const deploymentGate = (overrides = {}) => tournamentValuePromotionGate({
  trainSamples: dataset.splits.train,
  validationSamples: dataset.splits.validation,
  testSamples: dataset.splits.test,
  testMetrics: passingMetrics,
  stress: passingStress,
  deploymentTables: [6, 9],
  thresholds: relaxedThresholds,
  ...overrides,
});
assert.equal(deploymentGate().passed, true,
  'both declared production tables with complete partitions may pass');

const omittedNine = deploymentGate({ deploymentTables: [6] });
assert.equal(omittedNine.passed, false);
assert(omittedNine.blockers.includes('missing-deployment-table-9'));

const unknownDeclared = deploymentGate({ deploymentTables: [6, 8, 9] });
assert.equal(unknownDeclared.passed, false);
assert(unknownDeclared.blockers.includes('unknown-deployment-table-8'));

const sixOnlyMetrics = structuredClone(passingMetrics);
delete sixOnlyMetrics.byTable[9];
const missingNineData = deploymentGate({
  trainSamples: dataset.splits.train.filter((sample) => sample.state.tableSize === 6),
  validationSamples: dataset.splits.validation
    .filter((sample) => sample.state.tableSize === 6),
  testSamples: dataset.splits.test.filter((sample) => sample.state.tableSize === 6),
  testMetrics: sixOnlyMetrics,
});
assert.equal(missingNineData.passed, false);
for (const blocker of [
  'table-9-train-groups',
  'table-9-validation-groups',
  'table-9-test-groups',
  'table-9-missing-test-metrics',
]) assert(missingNineData.blockers.includes(blocker), `missing ${blocker}`);

const tableEightState = state(8, 99, 2);
const tableEightSample = createTournamentValueSample({
  state: tableEightState,
  rank: 1 + tableEightState.opponentStacks
    .filter((stack) => stack > tableEightState.focalStack).length,
  seedGroup: tournamentValueOpaqueId(secret, 'group', 8, 99),
  matchId: tournamentValueOpaqueId(secret, 'match', 8, 99),
  sampleId: tournamentValueOpaqueId(secret, 'sample', 8, 99, 2),
});
const unknownObserved = deploymentGate({
  trainSamples: [...dataset.splits.train, tableEightSample],
});
assert.equal(unknownObserved.passed, false);
assert(unknownObserved.blockers.includes('unknown-observed-table-8'));

const missingDeclaration = deploymentGate({ deploymentTables: null });
assert.equal(missingDeclaration.passed, false);
assert(missingDeclaration.blockers.includes('deployment-tables-missing'));

console.log('tournament value quality tests passed: stratified metrics, cluster CI, stress projection and explicit 6/9 fail-closed promotion');
