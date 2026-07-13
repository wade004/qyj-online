import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import * as Config from '../js/game/config.js';
import {
  buildSeatAssignments,
  createLineup,
  runLeague,
  runMatch,
} from '../training/eval/league.mjs';
import {
  TOURNAMENT_VALUE_DATASET_SCHEMA,
  TOURNAMENT_VALUE_SAMPLE_SCHEMA,
  assertSeedGroupIsolation,
  buildTournamentValueDataset,
  captureTournamentValueState,
  createTournamentValueSample,
  splitTournamentValueSamples,
  tournamentRankUtility,
  tournamentValueOpaqueId,
  tournamentValueSecretId,
  validateTournamentValueSample,
  validateTournamentValueState,
} from '../training/tournament-value/dataset.mjs';

const SECRET_A = '0123456789abcdef'.repeat(4);
const SECRET_B = 'fedcba9876543210'.repeat(4);

function fakeEngine(stacks, round = 5, dealerIdx = 1) {
  return {
    tableSize: stacks.length,
    round,
    dealerIdx,
    players: [null, ...stacks.map((hp, index) => ({
      idx: index + 1,
      hp,
      alive: hp > 0,
    }))],
  };
}

function opaqueIds(tableSize, group, match, sample) {
  return {
    seedGroup: tournamentValueOpaqueId(SECRET_A, 'group', tableSize, group),
    matchId: tournamentValueOpaqueId(SECRET_A, 'match', tableSize, group, match),
    sampleId: tournamentValueOpaqueId(SECRET_A, 'sample', tableSize, group, match, sample),
  };
}

function syntheticSample(tableSize, group, item = 1) {
  const state = captureTournamentValueState(
    fakeEngine(Array(tableSize).fill(1500), 1, 1),
    1,
    'start',
  );
  return createTournamentValueSample({
    state,
    rank: ((group + item) % tableSize) + 1,
    ...opaqueIds(tableSize, `table-${tableSize}-seed-${group}`, 'r1', `item-${item}`),
  });
}

// V2 IDs are deterministic HMACs, reveal no source component, and require a
// high-entropy secret that is never stored with the dataset.
const rawSeedGroup = 'replayable-engine-seed:t6:1';
const opaqueGroup = tournamentValueOpaqueId(SECRET_A, 'group', 6, rawSeedGroup);
assert.match(opaqueGroup, /^tvg_[A-Za-z0-9_-]{43}$/);
assert(!opaqueGroup.includes(rawSeedGroup));
assert.equal(
  opaqueGroup,
  tournamentValueOpaqueId(SECRET_A, 'group', 6, rawSeedGroup),
);
assert.notEqual(
  opaqueGroup,
  tournamentValueOpaqueId(SECRET_B, 'group', 6, rawSeedGroup),
);
assert.match(tournamentValueSecretId(SECRET_A), /^tvsecret_[A-Za-z0-9_-]{43}$/);
assert.notEqual(tournamentValueSecretId(SECRET_A), tournamentValueSecretId(SECRET_B));
assert.throws(() => tournamentValueSecretId('too-short'), /at least 32 bytes/);

// Rotating every absolute seat, focal seat and button together must leave the
// public V2 state unchanged. Changing relative button position must not.
const stateA = captureTournamentValueState(
  fakeEngine([500, 900, 0, 2500, 1200, 400], 5, 4),
  1,
  'start',
);
const stateB = captureTournamentValueState(
  fakeEngine([1200, 400, 500, 900, 0, 2500], 5, 6),
  3,
  'start',
);
assert.deepEqual(stateA, stateB);
assert.deepEqual(Object.keys(stateA).sort(), [
  'bigBlind', 'focalPosition', 'focalStack', 'liveStacksFromButton',
  'maxRounds', 'opponentStacks', 'round', 'tableSize',
]);
assert.deepEqual(stateA.opponentStacks, [2500, 1200, 900, 400, 0]);
assert.deepEqual(stateA.liveStacksFromButton, [2500, 1200, 400, 500, 900]);
assert.equal(stateA.focalPosition, 3);
assert.equal(stateA.round, 4);
assert.notDeepEqual(
  stateA,
  captureTournamentValueState(fakeEngine([500, 900, 0, 2500, 1200, 400], 5, 5), 1, 'start'),
  'relative button position is public poker state and must remain learnable',
);

// End(r) uses the next surviving button; start(r + 1) uses the already-rotated
// current button. Blind levels, including every schedule transition, match.
assert.deepEqual(
  captureTournamentValueState(fakeEngine([500, 900, 0, 2500, 1200, 400], 5, 4), 1, 'end'),
  captureTournamentValueState(fakeEngine([500, 900, 0, 2500, 1200, 400], 6, 5), 1, 'start'),
  'end(r) and start(r + 1) must share one boundary-state meaning',
);
for (let round = 1; round <= Config.MAX_ROUNDS; round++) {
  const start = captureTournamentValueState(
    fakeEngine(Array(6).fill(1500), round, 1), 1, 'start',
  );
  assert.equal(start.round, round - 1);
  assert.equal(start.bigBlind, Config.getBlinds(round).bb);
  const end = captureTournamentValueState(
    fakeEngine(Array(6).fill(1500), round, 1), 1, 'end',
  );
  assert.equal(end.round, round);
  assert.equal(end.bigBlind, Config.getBlinds(Math.min(Config.MAX_ROUNDS, round + 1)).bb);
  if (round < Config.MAX_ROUNDS) {
    assert.deepEqual(
      end,
      captureTournamentValueState(
        fakeEngine(Array(6).fill(1500), round + 1, 2), 1, 'start',
      ),
    );
  }
}
assert.throws(
  () => captureTournamentValueState(fakeEngine([0, 900, 0, 2500, 1200, 400]), 1, 'end'),
  /live positive-stack focal/,
);
assert.throws(
  () => validateTournamentValueState({ ...stateA, hole: [{ rank: 14, suit: 1 }] }),
  /must contain only/,
);
assert.throws(
  () => validateTournamentValueState({ ...stateA, bigBlind: 999 }),
  /blind schedule/,
);

const utilitySum = Array.from({ length: 6 }, (_, index) => (
  tournamentRankUtility(index + 1, 6)
)).reduce((sum, utility) => sum + utility, 0);
assert(Math.abs(utilitySum) < 1e-12);
assert.equal(tournamentRankUtility(1, 9), 1);
assert.equal(tournamentRankUtility(9, 9), -1);

function collectNative(tableSize, seed) {
  const lineup = createLineup(['qyz', 'calling-station'], tableSize);
  const assignment = buildSeatAssignments(lineup, { rotations: 1, mirror: false })[0];
  const samples = [];
  const match = runMatch({
    assignment,
    seed,
    seedGroup: `${seed}:raw-group`,
    tableSize,
    skillsEnabled: false,
    tournamentValueIdSecret: SECRET_A,
    // Omit tournamentValueFocalStrategies to exercise the qyz default.
    onTournamentValueSample(sample) {
      samples.push(sample);
    },
  });
  return { assignment, match, samples };
}

// Exercise the real native Engine at both supported table sizes. Only live qyz
// seats are focal rows; no seat or strategy field is persisted per sample.
const nativeSix = collectNative(6, 'tournament-value-v2-six');
const nativeNine = collectNative(9, 'tournament-value-v2-nine');
for (const { match, samples } of [nativeSix, nativeNine]) {
  assert(match.rounds >= 1 && samples.length > 0);
  assert(samples.every((sample) => {
    validateTournamentValueSample(sample);
    return sample.schema === TOURNAMENT_VALUE_SAMPLE_SCHEMA
      && sample.state.focalStack > 0
      && Object.isFrozen(sample)
      && Object.isFrozen(sample.state)
      && Object.isFrozen(sample.state.opponentStacks)
      && Object.isFrozen(sample.state.liveStacksFromButton);
  }));
  assert(samples.some((sample) => sample.state.round === 0));
}
assert.equal(
  nativeSix.samples.filter((sample) => sample.state.round === 0).length,
  3,
  'only the three qyz seats in the alternating six-seat lineup are focal rows',
);
assert.equal(
  nativeNine.samples.filter((sample) => sample.state.round === 0).length,
  5,
  'only the five qyz seats in the alternating nine-seat lineup are focal rows',
);
assert(nativeSix.samples.every((sample) => sample.state.tableSize === 6));
assert(nativeNine.samples.every((sample) => sample.state.tableSize === 9));
const serializedNative = JSON.stringify([...nativeSix.samples, ...nativeNine.samples]);
for (const forbidden of [
  'hole', 'board', 'heroId', 'strategy', 'entryId', 'playerName',
  'dealerIdx', 'seat', 'actionHistory', 'seedValue',
  'tournament-value-v2-six', 'tournament-value-v2-nine',
]) {
  assert(!serializedNative.includes(`"${forbidden}"`)
    && !serializedNative.includes(forbidden), `sample leaked ${forbidden}`);
}

const repeatedSix = collectNative(6, 'tournament-value-v2-six');
assert.deepEqual(
  repeatedSix.samples,
  nativeSix.samples,
  'fixed Engine seed and injected HMAC secret must reproduce every sample and label',
);
assert.throws(() => runMatch({
  assignment: nativeSix.assignment,
  seed: 'missing-secret',
  tableSize: 6,
  skillsEnabled: false,
  onTournamentValueSample() {},
}), /group secret/);
assert.throws(() => runMatch({
  assignment: nativeSix.assignment,
  seed: 'skills-not-allowed',
  tableSize: 6,
  skillsEnabled: true,
  tournamentValueIdSecret: SECRET_A,
  onTournamentValueSample() {},
}), /requires skillsEnabled=false/);

// Split whole seed groups independently inside each table-size stratum.
const grouped = [];
for (const tableSize of [6, 9]) {
  for (let group = 1; group <= 5; group++) {
    for (let item = 1; item <= 2; item++) grouped.push(syntheticSample(tableSize, group, item));
  }
}
const splitA = splitTournamentValueSamples(grouped, {
  seed: 'fixed-split', validationFraction: 0.2, testFraction: 0.2,
});
const splitB = splitTournamentValueSamples(grouped, {
  seed: 'fixed-split', validationFraction: 0.2, testFraction: 0.2,
});
assert.deepEqual(splitA, splitB);
assert.deepEqual(splitA.strata[6], { train: 3, validation: 1, test: 1 });
assert.deepEqual(splitA.strata[9], { train: 3, validation: 1, test: 1 });
for (const name of ['train', 'validation', 'test']) {
  assert.deepEqual(
    [...new Set(splitA[name].map((sample) => sample.state.tableSize))].sort(),
    [6, 9],
    `${name} must contain every requested table size`,
  );
}
assertSeedGroupIsolation(splitA);
assert.throws(() => assertSeedGroupIsolation({
  train: [grouped[0]], validation: [], test: [grouped[1]],
}), /leaked across/);

const tooFewGroups = [syntheticSample(6, 1), syntheticSample(6, 2)];
assert.throws(() => splitTournamentValueSamples(tooFewGroups, {
  validationFraction: 0.2, testFraction: 0.2,
}), /no validation seed group|no test seed group/);
assert.doesNotThrow(() => splitTournamentValueSamples(tooFewGroups, {
  validationFraction: 0.2, testFraction: 0.2, allowIncompleteStrata: true,
}));

const datasetA = buildTournamentValueDataset(grouped, {
  seed: 'fixed-split', validationFraction: 0.2, testFraction: 0.2,
});
const datasetB = buildTournamentValueDataset(grouped, {
  seed: 'fixed-split', validationFraction: 0.2, testFraction: 0.2,
});
assert.deepEqual(datasetA, datasetB, 'default dataset build must be byte-stable for identical input');
assert.equal(JSON.stringify(datasetA), JSON.stringify(datasetB));
assert.equal(datasetA.schema, TOURNAMENT_VALUE_DATASET_SCHEMA);
assert.equal(datasetA.generatedAt, undefined);
assert.equal(datasetA.summary.samples, grouped.length);
assert.equal(datasetA.summary.byTable[6].validation, 1);
assert.equal(datasetA.summary.byTable[9].test, 1);
assert.equal(datasetA.config.seedGroupAtomic, true);
assert.equal(datasetA.config.absoluteSeatInvariant, true);
assert.equal(datasetA.config.buttonRelativeState, true);
assert.equal(datasetA.config.rawReplaySeedIncluded, false);
assert.deepEqual(
  buildTournamentValueDataset(grouped, {
    seed: 'fixed-split', validationFraction: 0.2, testFraction: 0.2,
    generatedAt: '2026-07-12T00:00:00.000Z',
  }).generatedAt,
  '2026-07-12T00:00:00.000Z',
);

// CLI integration: a caller may inject the HMAC secret only through an env
// variable. Neither it nor the replay seed may occur anywhere in the artifact.
const tempDirectory = mkdtempSync(path.join(process.cwd(), 'test', '.tmp-tv-v2-'));
const output = path.join(tempDirectory, 'dataset.json');
const parallelOutput = path.join(tempDirectory, 'dataset-parallel.json');
const replaySeed = 'private-replay-seed-must-not-leak';
const secretEnvName = 'TV_V2_TEST_GROUP_SECRET';
try {
  execFileSync(process.execPath, [
    'training/collect-tournament-value.mjs',
    '--quick',
    '--tables', '6,9',
    '--workers', '1',
    '--seed', replaySeed,
    '--group-secret', secretEnvName,
    '--output', output,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, [secretEnvName]: SECRET_A },
  });
  execFileSync(process.execPath, [
    'training/collect-tournament-value.mjs',
    '--quick',
    '--tables', '6,9',
    '--workers', '4',
    '--seed', replaySeed,
    '--group-secret', secretEnvName,
    '--output', parallelOutput,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, [secretEnvName]: SECRET_A },
  });
  const artifactText = readFileSync(output, 'utf8');
  assert.equal(
    readFileSync(parallelOutput, 'utf8'),
    artifactText,
    'seed-group worker scheduling must not change a single dataset byte',
  );
  const artifact = JSON.parse(artifactText);
  const sequentialLeagueSamples = [];
  const sequentialLeagueMatchCounts = {};
  for (const tableSize of [6, 9]) {
    const sequentialLeagueReport = runLeague({
      tableSize,
      baseSeed: `${replaySeed}:t${tableSize}`,
      seedCount: 3,
      rotations: 1,
      mirror: false,
      lineup: ['qyz', 'random-legal'],
      skillsEnabled: false,
      promotionGate: false,
      bootstrapIterations: 1,
      tournamentValueFocalStrategies: ['qyz'],
      tournamentValueIdSecret: SECRET_A,
      onTournamentValueSample(sample) {
        sequentialLeagueSamples.push(sample);
      },
    });
    sequentialLeagueMatchCounts[tableSize] = sequentialLeagueReport.matchCount;
  }
  const sequentialLeagueDataset = buildTournamentValueDataset(sequentialLeagueSamples, {
    seed: 'qyj-tournament-value-split-v2',
    validationFraction: 0.15,
    testFraction: 0.15,
    allowIncompleteStrata: true,
  });
  assert.deepEqual(
    artifact.splits,
    sequentialLeagueDataset.splits,
    'parallel seed-group sharding must preserve the original runLeague seed schedule',
  );
  assert.deepEqual(artifact.collection.matchCounts, sequentialLeagueMatchCounts);
  assert.equal(artifact.schema, TOURNAMENT_VALUE_DATASET_SCHEMA);
  assert.equal(artifact.collection.groupSecretId, tournamentValueSecretId(SECRET_A));
  assert.equal(artifact.collection.rawReplaySeedIncluded, false);
  assert.equal(artifact.collection.baseSeed, undefined);
  assert(!artifactText.includes(replaySeed));
  assert(!artifactText.includes(SECRET_A));
  assert(!artifactText.includes(secretEnvName));
  assert(!artifactText.includes(':tv1'));
  assert(artifact.splits.train.concat(artifact.splits.validation, artifact.splits.test)
    .every((sample) => /^tvs_[A-Za-z0-9_-]{43}$/.test(sample.sampleId)
      && /^tvg_[A-Za-z0-9_-]{43}$/.test(sample.group.seedGroup)
      && /^tvm_[A-Za-z0-9_-]{43}$/.test(sample.group.matchId)));
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}

const helpText = execFileSync(process.execPath, [
  'training/collect-tournament-value.mjs', '--help',
], { cwd: process.cwd(), encoding: 'utf8' });
assert(helpText.includes('tournament-value V2 collector'));
assert(helpText.includes('--group-secret <ENV_NAME>'));
assert(helpText.includes('--workers <n>'));
assert(helpText.includes('per table (default: 720)'));
assert(helpText.includes('default: full'));
assert.throws(() => execFileSync(process.execPath, [
  'training/collect-tournament-value.mjs', '--quick', '--workers', '0',
], { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' }), /--workers must be an integer/);
assert.throws(() => execFileSync(process.execPath, [
  'training/collect-tournament-value.mjs',
  '--quick',
  '--group-secret', 'TV_V2_DELIBERATELY_MISSING_SECRET',
], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: { ...process.env, TV_V2_DELIBERATELY_MISSING_SECRET: '' },
  stdio: 'pipe',
}), /group-secret environment variable/);

console.log('Tournament-value V2 data self-test passed: opaque IDs, active target focals, button-relative state, table-stratified atomic splits and deterministic artifacts');
