import { createHash, createHmac } from 'node:crypto';
import * as Config from '../../js/game/config.js';
import { createSeededRng, deriveSeed } from '../eval/rng.mjs';

export const TOURNAMENT_VALUE_SAMPLE_SCHEMA = 'qyj-tournament-value-sample-v2';
export const TOURNAMENT_VALUE_DATASET_SCHEMA = 'qyj-tournament-value-dataset-v2';

const MIN_GROUP_SECRET_BYTES = 32;
const OPAQUE_ID_PREFIX = Object.freeze({
  group: 'tvg_',
  match: 'tvm_',
  sample: 'tvs_',
});
const STATE_KEYS = Object.freeze([
  'tableSize',
  'round',
  'maxRounds',
  'bigBlind',
  'focalStack',
  'opponentStacks',
  'liveStacksFromButton',
  'focalPosition',
]);
const SAMPLE_KEYS = Object.freeze(['schema', 'sampleId', 'group', 'state', 'target']);
const GROUP_KEYS = Object.freeze(['seedGroup', 'matchId']);
const TARGET_KEYS = Object.freeze(['rank', 'rankUtility', 'firstPlace']);
const SPLIT_NAMES = Object.freeze(['train', 'validation', 'test']);

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} must contain only: ${wanted.join(', ')}`);
  }
}

function integerIn(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer in [${minimum}, ${maximum}]`);
  }
}

function finiteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}

function secretBytes(secret) {
  const value = typeof secret === 'string'
    ? Buffer.from(secret, 'utf8')
    : secret instanceof Uint8Array ? Buffer.from(secret) : null;
  if (!value || value.length < MIN_GROUP_SECRET_BYTES) {
    throw new RangeError(`group secret must contain at least ${MIN_GROUP_SECRET_BYTES} bytes`);
  }
  return value;
}

function lengthPrefixed(parts) {
  return parts.map((part) => {
    const value = String(part ?? '');
    return `${Buffer.byteLength(value, 'utf8')}:${value}`;
  }).join('|');
}

/**
 * Return an opaque, non-enumerable identifier suitable for a published
 * dataset. The source seed, seat and capture ordinal never appear in the ID.
 */
export function tournamentValueOpaqueId(secret, kind, ...parts) {
  const prefix = OPAQUE_ID_PREFIX[kind];
  if (!prefix) throw new RangeError('opaque id kind must be group, match or sample');
  const digest = createHmac('sha256', secretBytes(secret))
    .update('qyj-tournament-value-id-v2\0', 'utf8')
    .update(kind, 'utf8')
    .update('\0', 'utf8')
    .update(lengthPrefixed(parts), 'utf8')
    .digest('base64url');
  return `${prefix}${digest}`;
}

/** Hash only identifies which high-entropy HMAC secret was used; it is not a replay seed. */
export function tournamentValueSecretId(secret) {
  return `tvsecret_${createHash('sha256')
    .update('qyj-tournament-value-secret-id-v2\0', 'utf8')
    .update(secretBytes(secret))
    .digest('base64url')}`;
}

function validateOpaqueId(value, kind, label) {
  const prefix = OPAQUE_ID_PREFIX[kind];
  const pattern = new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`);
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TypeError(`${label} must be an opaque ${kind} id`);
  }
}

function freezeState(state) {
  return Object.freeze({
    ...state,
    opponentStacks: Object.freeze([...state.opponentStacks]),
    liveStacksFromButton: Object.freeze([...state.liveStacksFromButton]),
  });
}

function normalizedStack(player) {
  const stack = Number(player?.hp);
  if (!Number.isFinite(stack)) throw new TypeError('Engine player hp must be finite');
  return Math.max(0, stack);
}

function isLivePlayer(player) {
  return player?.alive !== false && normalizedStack(player) > 0;
}

function nextLiveSeat(engine, fromSeat) {
  for (let step = 1; step <= engine.tableSize; step++) {
    const seat = ((fromSeat - 1 + step) % engine.tableSize) + 1;
    if (isLivePlayer(engine.players[seat])) return seat;
  }
  return null;
}

function liveSeatsClockwiseFrom(engine, buttonSeat) {
  const seats = [];
  for (let step = 0; step < engine.tableSize; step++) {
    const seat = ((buttonSeat - 1 + step) % engine.tableSize) + 1;
    if (isLivePlayer(engine.players[seat])) seats.push(seat);
  }
  return seats;
}

/**
 * Capture the complete V2 model input at a public hand boundary.
 *
 * `round` is the number of completed hands. At onRoundStart(r), pass
 * `boundary='start'` and the result uses r - 1. At onRoundEnd(r), pass
 * `boundary='end'` and the result uses r. End(r) canonicalizes seats from the
 * next live dealer, while start(r + 1) uses the already-rotated current dealer;
 * consequently both callbacks describe exactly one public boundary state.
 *
 * Absolute seats, cards, actions and strategy identity are excluded. The live
 * stack ring starts at the next hand's button and therefore retains poker
 * position while remaining invariant to a circular renumbering of seats.
 */
export function captureTournamentValueState(engine, focalSeat, boundary) {
  if (!engine || !Array.isArray(engine.players)) {
    throw new TypeError('engine with a players array is required');
  }
  const tableSize = Number(engine.tableSize);
  integerIn(tableSize, 'engine.tableSize', 2, Config.MAX_TABLE_SIZE);
  integerIn(focalSeat, 'focalSeat', 1, tableSize);
  if (!['start', 'end'].includes(boundary)) {
    throw new RangeError('boundary must be start or end');
  }
  const engineRound = Number(engine.round);
  integerIn(engineRound, 'engine.round', 1, Config.MAX_ROUNDS);
  const dealerIdx = Number(engine.dealerIdx);
  integerIn(dealerIdx, 'engine.dealerIdx', 1, tableSize);
  const completedHands = boundary === 'start' ? engineRound - 1 : engineRound;
  const nextBlindRound = Math.min(
    Config.MAX_ROUNDS,
    boundary === 'start' ? engineRound : engineRound + 1,
  );
  const focal = engine.players[focalSeat];
  if (!focal) throw new RangeError(`Missing focal player ${focalSeat}`);
  if (!isLivePlayer(focal)) {
    throw new RangeError('V2 tournament-value state requires a live positive-stack focal player');
  }
  const opponentStacks = [];
  for (let seat = 1; seat <= tableSize; seat++) {
    const player = engine.players[seat];
    if (!player) throw new RangeError(`Missing engine player ${seat}`);
    if (seat !== focalSeat) opponentStacks.push(normalizedStack(player));
  }
  opponentStacks.sort((left, right) => right - left);

  const buttonSeat = boundary === 'start' ? dealerIdx : nextLiveSeat(engine, dealerIdx);
  if (!buttonSeat) throw new RangeError('Tournament boundary has no live dealer');
  const liveSeats = liveSeatsClockwiseFrom(engine, buttonSeat);
  const focalPosition = liveSeats.indexOf(focalSeat);
  if (focalPosition < 0) throw new RangeError('Focal player is missing from live seat ring');
  const liveStacksFromButton = liveSeats.map((seat) => normalizedStack(engine.players[seat]));

  return freezeState({
    tableSize,
    round: completedHands,
    maxRounds: Config.MAX_ROUNDS,
    bigBlind: Number(Config.getBlinds(nextBlindRound).bb),
    focalStack: normalizedStack(focal),
    opponentStacks,
    liveStacksFromButton,
    focalPosition,
  });
}

/** Rank utility is +1 for first, -1 for last and zero-sum across all ranks. */
export function tournamentRankUtility(rank, tableSize) {
  integerIn(tableSize, 'tableSize', 2, Config.MAX_TABLE_SIZE);
  integerIn(rank, 'rank', 1, tableSize);
  return 1 - (2 * (rank - 1)) / (tableSize - 1);
}

export function validateTournamentValueState(state) {
  exactKeys(state, STATE_KEYS, 'state');
  integerIn(state.tableSize, 'state.tableSize', 2, Config.MAX_TABLE_SIZE);
  if (state.maxRounds !== Config.MAX_ROUNDS) {
    throw new RangeError(`state.maxRounds must equal ${Config.MAX_ROUNDS}`);
  }
  integerIn(state.round, 'state.round', 0, state.maxRounds);
  finiteNonNegative(state.bigBlind, 'state.bigBlind');
  const expectedBlind = Number(Config.getBlinds(Math.min(state.maxRounds, state.round + 1)).bb);
  if (state.bigBlind !== expectedBlind) {
    throw new RangeError('state.bigBlind does not match the next-hand blind schedule');
  }
  finiteNonNegative(state.focalStack, 'state.focalStack');
  if (state.focalStack <= 0) throw new RangeError('state.focalStack must be positive');
  if (!Array.isArray(state.opponentStacks)
    || state.opponentStacks.length !== state.tableSize - 1) {
    throw new RangeError('state.opponentStacks must contain tableSize - 1 values');
  }
  for (let index = 0; index < state.opponentStacks.length; index++) {
    finiteNonNegative(state.opponentStacks[index], `state.opponentStacks[${index}]`);
    if (index > 0 && state.opponentStacks[index] > state.opponentStacks[index - 1]) {
      throw new RangeError('state.opponentStacks must be sorted descending');
    }
  }
  if (!Array.isArray(state.liveStacksFromButton)
    || state.liveStacksFromButton.length < 1
    || state.liveStacksFromButton.length > state.tableSize) {
    throw new RangeError('state.liveStacksFromButton must contain 1..tableSize live stacks');
  }
  for (let index = 0; index < state.liveStacksFromButton.length; index++) {
    finiteNonNegative(state.liveStacksFromButton[index], `state.liveStacksFromButton[${index}]`);
    if (state.liveStacksFromButton[index] <= 0) {
      throw new RangeError('state.liveStacksFromButton must contain only positive stacks');
    }
  }
  integerIn(
    state.focalPosition,
    'state.focalPosition',
    0,
    state.liveStacksFromButton.length - 1,
  );
  if (state.liveStacksFromButton[state.focalPosition] !== state.focalStack) {
    throw new RangeError('state.focalPosition must point to state.focalStack');
  }
  const expectedLiveStacks = [state.focalStack, ...state.opponentStacks]
    .filter((stack) => stack > 0)
    .sort((left, right) => right - left);
  const actualLiveStacks = [...state.liveStacksFromButton]
    .sort((left, right) => right - left);
  if (expectedLiveStacks.length !== actualLiveStacks.length
    || expectedLiveStacks.some((stack, index) => stack !== actualLiveStacks[index])) {
    throw new RangeError('state.liveStacksFromButton must match all positive table stacks');
  }
  return state;
}

export function createTournamentValueSample({
  state,
  rank,
  seedGroup,
  matchId,
  sampleId,
}) {
  validateTournamentValueState(state);
  const tableSize = state.tableSize;
  integerIn(rank, 'rank', 1, tableSize);
  validateOpaqueId(seedGroup, 'group', 'seedGroup');
  validateOpaqueId(matchId, 'match', 'matchId');
  validateOpaqueId(sampleId, 'sample', 'sampleId');
  return Object.freeze({
    schema: TOURNAMENT_VALUE_SAMPLE_SCHEMA,
    sampleId,
    group: Object.freeze({ seedGroup, matchId }),
    state: freezeState(state),
    target: Object.freeze({
      rank,
      rankUtility: tournamentRankUtility(rank, tableSize),
      firstPlace: rank === 1,
    }),
  });
}

export function validateTournamentValueSample(sample) {
  exactKeys(sample, SAMPLE_KEYS, 'sample');
  if (sample.schema !== TOURNAMENT_VALUE_SAMPLE_SCHEMA) {
    throw new RangeError(`Unsupported sample schema: ${sample.schema}`);
  }
  validateOpaqueId(sample.sampleId, 'sample', 'sample.sampleId');
  exactKeys(sample.group, GROUP_KEYS, 'sample.group');
  validateOpaqueId(sample.group.seedGroup, 'group', 'sample.group.seedGroup');
  validateOpaqueId(sample.group.matchId, 'match', 'sample.group.matchId');
  validateTournamentValueState(sample.state);
  exactKeys(sample.target, TARGET_KEYS, 'sample.target');
  integerIn(sample.target.rank, 'sample.target.rank', 1, sample.state.tableSize);
  const expectedUtility = tournamentRankUtility(sample.target.rank, sample.state.tableSize);
  if (Math.abs(Number(sample.target.rankUtility) - expectedUtility) > 1e-12) {
    throw new RangeError('sample.target.rankUtility does not match normalized rank');
  }
  if (sample.target.firstPlace !== (sample.target.rank === 1)) {
    throw new RangeError('sample.target.firstPlace does not match rank');
  }
  return sample;
}

function splitCount(groupCount, fraction) {
  if (fraction <= 0 || groupCount < 3) return 0;
  return Math.max(1, Math.floor(groupCount * fraction));
}

function shuffle(values, rng) {
  for (let index = values.length - 1; index > 0; index--) {
    const other = Math.floor(rng() * (index + 1));
    [values[index], values[other]] = [values[other], values[index]];
  }
  return values;
}

/**
 * Deterministically split whole seed clusters inside each table-size stratum.
 * All rotations, mirrors, target seats and boundaries from a seed remain
 * atomic, while every requested table receives independent held-out groups.
 */
export function splitTournamentValueSamples(samples, options = {}) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new RangeError('samples must be a non-empty array');
  }
  const validationFraction = Number(options.validationFraction ?? 0.15);
  const testFraction = Number(options.testFraction ?? 0.15);
  const allowIncompleteStrata = options.allowIncompleteStrata === true;
  if (!(validationFraction >= 0 && validationFraction < 1)
    || !(testFraction >= 0 && testFraction < 1)
    || validationFraction + testFraction >= 1) {
    throw new RangeError('validation/test fractions must be in [0, 1) and sum to less than 1');
  }

  const ids = new Set();
  const groupTable = new Map();
  const groupsByTable = new Map();
  for (const sample of samples) {
    validateTournamentValueSample(sample);
    if (ids.has(sample.sampleId)) throw new RangeError(`Duplicate sampleId: ${sample.sampleId}`);
    ids.add(sample.sampleId);
    const group = sample.group.seedGroup;
    const tableSize = sample.state.tableSize;
    const previousTable = groupTable.get(group);
    if (previousTable != null && previousTable !== tableSize) {
      throw new RangeError(`seedGroup ${group} spans table sizes ${previousTable} and ${tableSize}`);
    }
    groupTable.set(group, tableSize);
    if (!groupsByTable.has(tableSize)) groupsByTable.set(tableSize, new Set());
    groupsByTable.get(tableSize).add(group);
  }

  const testGroups = new Set();
  const validationGroups = new Set();
  const tableStrata = {};
  const splitSeed = options.seed ?? 'qyj-tournament-value-split-v2';
  for (const tableSize of [...groupsByTable.keys()].sort((left, right) => left - right)) {
    const groups = shuffle(
      [...groupsByTable.get(tableSize)].sort(),
      createSeededRng(deriveSeed(splitSeed, 'table', tableSize)),
    );
    let validationCount = splitCount(groups.length, validationFraction);
    let testCount = splitCount(groups.length, testFraction);
    while (validationCount + testCount >= groups.length) {
      if (testCount >= validationCount && testCount > 0) testCount--;
      else if (validationCount > 0) validationCount--;
    }
    if (!allowIncompleteStrata) {
      if (validationFraction > 0 && validationCount < 1) {
        throw new RangeError(`tableSize ${tableSize} has no validation seed group`);
      }
      if (testFraction > 0 && testCount < 1) {
        throw new RangeError(`tableSize ${tableSize} has no test seed group`);
      }
    }
    const stratumTest = groups.slice(0, testCount);
    const stratumValidation = groups.slice(testCount, testCount + validationCount);
    for (const group of stratumTest) testGroups.add(group);
    for (const group of stratumValidation) validationGroups.add(group);
    tableStrata[tableSize] = Object.freeze({
      train: groups.length - validationCount - testCount,
      validation: validationCount,
      test: testCount,
    });
  }

  const partitions = { train: [], validation: [], test: [] };
  for (const sample of samples) {
    const group = sample.group.seedGroup;
    const partition = testGroups.has(group)
      ? 'test' : validationGroups.has(group) ? 'validation' : 'train';
    partitions[partition].push(sample);
  }
  const allGroups = [...groupTable.keys()];
  const result = {
    train: Object.freeze(partitions.train),
    validation: Object.freeze(partitions.validation),
    test: Object.freeze(partitions.test),
    groups: Object.freeze({
      train: Object.freeze(allGroups.filter((group) => (
        !testGroups.has(group) && !validationGroups.has(group)
      )).sort()),
      validation: Object.freeze([...validationGroups].sort()),
      test: Object.freeze([...testGroups].sort()),
    }),
    strata: Object.freeze(tableStrata),
  };
  assertSeedGroupIsolation(result);
  return Object.freeze(result);
}

export function assertSeedGroupIsolation(split) {
  const owner = new Map();
  for (const name of SPLIT_NAMES) {
    if (!Array.isArray(split?.[name])) throw new TypeError(`split.${name} must be an array`);
    for (const sample of split[name]) {
      validateTournamentValueSample(sample);
      const group = sample.group.seedGroup;
      const previous = owner.get(group);
      if (previous && previous !== name) {
        throw new RangeError(`seedGroup ${group} leaked across ${previous} and ${name}`);
      }
      owner.set(group, name);
    }
  }
  return true;
}

export function buildTournamentValueDataset(samples, options = {}) {
  const split = splitTournamentValueSamples(samples, options);
  const tables = [...new Set(samples.map((sample) => sample.state.tableSize))]
    .sort((left, right) => left - right);
  const byTable = Object.fromEntries(tables.map((tableSize) => {
    const rows = samples.filter((sample) => sample.state.tableSize === tableSize);
    return [tableSize, {
      samples: rows.length,
      seedGroups: new Set(rows.map((sample) => sample.group.seedGroup)).size,
      trainSamples: split.train.filter((sample) => sample.state.tableSize === tableSize).length,
      validationSamples: split.validation
        .filter((sample) => sample.state.tableSize === tableSize).length,
      testSamples: split.test.filter((sample) => sample.state.tableSize === tableSize).length,
      ...split.strata[tableSize],
    }];
  }));
  const dataset = {
    schema: TOURNAMENT_VALUE_DATASET_SCHEMA,
    config: {
      source: 'native-engine-public-active-hand-boundaries',
      tables,
      maxRounds: Config.MAX_ROUNDS,
      splitPolicy: 'table-stratified-seed-group-v2',
      validationFraction: Number(options.validationFraction ?? 0.15),
      testFraction: Number(options.testFraction ?? 0.15),
      seedGroupAtomic: true,
      allowIncompleteStrata: options.allowIncompleteStrata === true,
      activeFocalOnly: true,
      absoluteSeatInvariant: true,
      buttonRelativeState: true,
      rawReplaySeedIncluded: false,
    },
    summary: {
      samples: samples.length,
      seedGroups: new Set(samples.map((sample) => sample.group.seedGroup)).size,
      trainSamples: split.train.length,
      validationSamples: split.validation.length,
      testSamples: split.test.length,
      trainSeedGroups: split.groups.train.length,
      validationSeedGroups: split.groups.validation.length,
      testSeedGroups: split.groups.test.length,
      byTable,
    },
    splits: {
      train: split.train,
      validation: split.validation,
      test: split.test,
    },
  };
  if (options.generatedAt != null) {
    const generatedAt = String(options.generatedAt);
    if (!Number.isFinite(Date.parse(generatedAt))) {
      throw new RangeError('generatedAt must be an ISO-compatible timestamp');
    }
    dataset.generatedAt = generatedAt;
  }
  return dataset;
}
