// Public tournament continuation-value model.
//
// The model deliberately accepts a very small, strict state schema.  It has no
// seat identifiers, action history or cards, and reduces every opponent stack
// to permutation-invariant aggregates before training or inference.  Terminal
// rounds are excluded: their value can be settled exactly by the game engine.

export const TOURNAMENT_VALUE_SCHEMA = 'qyj-public-tournament-value';
export const TOURNAMENT_VALUE_VERSION = 3;
export const TOURNAMENT_VALUE_OOD_THRESHOLD = 1;
export const DEFAULT_TOURNAMENT_VALUE_OPTIONS = Object.freeze({
  ensembleSize: 7,
  ridge: 0.01,
  seed: 'qyj-public-tournament-value-v0',
  rangePaddingZ: 0.75,
  distancePaddingZ: 0.5,
  targetLinkScale: 0.98,
  monotonePriorWeight: 0.25,
});

export const TOURNAMENT_VALUE_STATE_FIELDS = Object.freeze([
  'tableSize',
  'round',
  'maxRounds',
  'bigBlind',
  'focalStack',
  'opponentStacks',
  'liveStacksFromButton',
  'focalPosition',
]);

export const TOURNAMENT_VALUE_FEATURES = Object.freeze([
  'roundProgress',
  'tableSizeFraction',
  'aliveFraction',
  'focalAlive',
  'logTotalChipsBb',
  'logFocalStackBb',
  'focalChipShare',
  'focalVsAliveMean',
  'focalRankPercentile',
  'leaderChipShare',
  'shortestAliveChipShare',
  'opponentChipShareMean',
  'opponentChipShareStd',
  'opponentChipShareQ25',
  'opponentChipShareQ50',
  'opponentChipShareQ75',
  'shortStackFraction',
  'focalGapToLeaderShare',
  'focalIsButton',
  'focalIsSmallBlind',
  'focalIsBigBlind',
  'focalIsOtherPosition',
  'buttonStackShare0',
  'buttonStackShare1',
  'buttonStackShare2',
  'buttonStackShare3',
  'buttonStackShare4',
  'buttonStackShare5',
  'buttonStackShare6',
  'buttonStackShare7',
  'buttonStackShare8',
]);

const SAMPLE_FIELDS = Object.freeze(['state', 'value']);
const DATASET_SAMPLE_FIELDS = Object.freeze(['schema', 'sampleId', 'group', 'state', 'target']);
const DATASET_TARGET_FIELDS = Object.freeze(['rank', 'rankUtility', 'firstPlace']);
const DATASET_SAMPLE_SCHEMA = 'qyj-tournament-value-sample-v2';
const ARTIFACT_FIELDS = Object.freeze([
  'schema', 'version', 'featureSchema', 'training', 'scaler', 'ood', 'members',
]);
const FEATURE_SCHEMA_FIELDS = Object.freeze([
  'version', 'names', 'stateFields', 'terminalRoundPolicy', 'targetBounds',
  'targetDefinition',
]);
const TRAINING_FIELDS = Object.freeze([
  'sampleCount', 'clusterCount', 'bootstrapUnit', 'oobSampleCount',
  'ensembleSize', 'ridge', 'seed', 'fitRmse', 'residualStd', 'targetMean',
  'targetStd', 'targetLinkScale', 'monotonePriorWeight',
]);
const SCALER_FIELDS = Object.freeze(['mean', 'scale']);
const OOD_FIELDS = Object.freeze([
  'minZ', 'maxZ', 'rmsLimit', 'rangePaddingZ', 'distancePaddingZ',
  'supportedTableSizes', 'supportedStrata',
]);
const STRATUM_FIELDS = Object.freeze(['tableSize', 'round', 'aliveCount']);
const MEMBER_FIELDS = Object.freeze(['intercept', 'coefficients']);
const TARGET_MIN = -1;
const TARGET_MAX = 1;
const COMPILED_ARTIFACTS = new WeakMap();

function objectRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, allowed, label) {
  const record = objectRecord(value, label);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !Object.hasOwn(record, key));
  if (unknown.length) throw new TypeError(`${label} contains unknown field: ${unknown[0]}`);
  if (missing.length) throw new TypeError(`${label} is missing field: ${missing[0]}`);
  return record;
}

function finiteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function integerInRange(value, min, max, label) {
  const number = finiteNumber(value, label);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new RangeError(`${label} must be an integer in ${min}..${max}`);
  }
  return number;
}

function nonNegative(value, label) {
  const number = finiteNumber(value, label);
  if (number < 0) throw new RangeError(`${label} must be non-negative`);
  return number;
}

function finiteVector(value, length, label) {
  if (!Array.isArray(value) || value.length !== length) {
    throw new RangeError(`${label} must contain exactly ${length} values`);
  }
  return value.map((entry, index) => finiteNumber(entry, `${label}[${index}]`));
}

function sameArray(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length
    || actual.some((entry, index) => entry !== expected[index])) {
    throw new TypeError(`${label} does not match the supported schema`);
  }
}

function quantile(sorted, probability) {
  if (sorted.length === 1) return sorted[0];
  const position = probability * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function populationStd(values, average = mean(values)) {
  return Math.sqrt(values.reduce((sum, value) => (
    sum + (value - average) ** 2
  ), 0) / values.length);
}

// A canonical compensated sum keeps opponent relabeling bit-stable even when
// callers supply finite fractional stacks with very different magnitudes.
function canonicalFiniteSum(values, label) {
  const sorted = [...values].sort((left, right) => left - right);
  let sum = 0;
  let compensation = 0;
  for (const value of sorted) {
    const next = sum + value;
    compensation += Math.abs(sum) >= Math.abs(value)
      ? (sum - next) + value
      : (value - next) + sum;
    sum = next;
  }
  const result = sum + compensation;
  if (!Number.isFinite(result)) throw new RangeError(`${label} exceeds finite range`);
  return result;
}

function validatedPublicState(
  state,
  { allowTerminal = false, allowExact = false } = {},
) {
  const record = assertExactKeys(state, TOURNAMENT_VALUE_STATE_FIELDS, 'state');
  const tableSize = integerInRange(record.tableSize, 2, 9, 'state.tableSize');
  const maxRounds = integerInRange(record.maxRounds, 1, 10_000, 'state.maxRounds');
  const round = integerInRange(
    record.round, 0, allowTerminal ? maxRounds : maxRounds - 1, 'state.round',
  );
  const bigBlind = finiteNumber(record.bigBlind, 'state.bigBlind');
  if (bigBlind <= 0) throw new RangeError('state.bigBlind must be positive');
  const focalStack = nonNegative(record.focalStack, 'state.focalStack');
  if (!Array.isArray(record.opponentStacks)
    || record.opponentStacks.length !== tableSize - 1) {
    throw new RangeError('state.opponentStacks must cover every other table position');
  }
  const opponentStacks = record.opponentStacks.map((stack, index) => (
    nonNegative(stack, `state.opponentStacks[${index}]`)
  ));
  const allStacks = [focalStack, ...opponentStacks];
  const totalChips = canonicalFiniteSum(allStacks, 'state total chips');
  if (!(totalChips > 0)) throw new RangeError('state must contain at least one positive stack');
  if (!Array.isArray(record.liveStacksFromButton)) {
    throw new TypeError('state.liveStacksFromButton must be an array');
  }
  const liveStacksFromButton = record.liveStacksFromButton.map((stack, index) => {
    const parsed = finiteNumber(stack, `state.liveStacksFromButton[${index}]`);
    if (!(parsed > 0)) {
      throw new RangeError(`state.liveStacksFromButton[${index}] must be positive`);
    }
    return parsed;
  });
  const positiveStacks = allStacks.filter((stack) => stack > 0)
    .sort((left, right) => left - right);
  const sortedLiveStacks = [...liveStacksFromButton].sort((left, right) => left - right);
  if (liveStacksFromButton.length !== positiveStacks.length
    || sortedLiveStacks.some((stack, index) => stack !== positiveStacks[index])) {
    throw new RangeError(
      'state.liveStacksFromButton must contain every positive table stack exactly once',
    );
  }
  let focalPosition = record.focalPosition;
  if (focalStack > 0) {
    focalPosition = integerInRange(
      focalPosition, 0, liveStacksFromButton.length - 1, 'state.focalPosition',
    );
    if (liveStacksFromButton[focalPosition] !== focalStack) {
      throw new RangeError('state.focalPosition must identify state.focalStack');
    }
  } else if (focalPosition !== null && focalPosition !== -1) {
    throw new RangeError('state.focalPosition must be null or -1 for an eliminated focal player');
  }
  const aliveCount = liveStacksFromButton.length;
  if (!allowExact && (focalStack <= 0 || aliveCount < 2)) {
    throw new RangeError('state must describe a live focal player with at least two survivors');
  }
  return Object.freeze({
    tableSize,
    round,
    maxRounds,
    bigBlind,
    focalStack,
    opponentStacks: Object.freeze(opponentStacks),
    allStacks: Object.freeze(allStacks),
    liveStacksFromButton: Object.freeze(liveStacksFromButton),
    focalPosition,
    aliveCount,
    totalChips,
  });
}

function encodeValidatedPublicState(parsed) {
  const {
    tableSize,
    round,
    maxRounds,
    bigBlind,
    focalStack,
    opponentStacks,
    allStacks,
    liveStacksFromButton,
    focalPosition,
    aliveCount,
    totalChips,
  } = parsed;

  const sortedOpponentShares = opponentStacks
    .map((stack) => stack / totalChips)
    .sort((left, right) => left - right);
  const focalShare = focalStack / totalChips;
  const leaderShare = Math.max(...allStacks) / totalChips;
  const shortestAliveShare = Math.min(...liveStacksFromButton) / totalChips;
  const opponentShareMean = mean(sortedOpponentShares);
  const opponentShareStd = populationStd(sortedOpponentShares, opponentShareMean);
  const smallerOpponents = opponentStacks.filter((stack) => stack < focalStack).length;
  const equalOpponents = opponentStacks.filter((stack) => stack === focalStack).length;
  const focalRankPercentile = (smallerOpponents + equalOpponents * 0.5)
    / opponentStacks.length;
  const aliveMean = totalChips / aliveCount;
  const shortStacks = allStacks.filter((stack) => stack > 0 && stack <= bigBlind * 10).length;
  const headsUp = aliveCount === 2;
  const focalIsButton = focalPosition === 0 ? 1 : 0;
  const focalIsSmallBlind = !headsUp && focalPosition === 1 ? 1 : 0;
  const focalIsBigBlind = (headsUp ? focalPosition === 1 : focalPosition === 2) ? 1 : 0;
  const focalIsOtherPosition = (
    focalIsButton || focalIsSmallBlind || focalIsBigBlind
  ) ? 0 : 1;
  const buttonStackShares = Array(9).fill(0);
  liveStacksFromButton.forEach((stack, index) => {
    buttonStackShares[index] = stack / totalChips;
  });

  const features = [
    round / maxRounds,
    (tableSize - 2) / 7,
    aliveCount / tableSize,
    1,
    Math.log1p(totalChips / bigBlind),
    Math.log1p(focalStack / bigBlind),
    focalShare,
    focalStack / aliveMean,
    focalRankPercentile,
    leaderShare,
    shortestAliveShare,
    opponentShareMean,
    opponentShareStd,
    quantile(sortedOpponentShares, 0.25),
    quantile(sortedOpponentShares, 0.5),
    quantile(sortedOpponentShares, 0.75),
    shortStacks / tableSize,
    leaderShare - focalShare,
    focalIsButton,
    focalIsSmallBlind,
    focalIsBigBlind,
    focalIsOtherPosition,
    ...buttonStackShares,
  ];
  if (features.some((value) => !Number.isFinite(value))) {
    throw new RangeError('state cannot be represented as finite normalized features');
  }
  return Object.freeze(features);
}

/**
 * Converts the strict public state into a fixed-size, seat-permutation
 * invariant numerical feature vector.
 */
export function encodeTournamentPublicState(state) {
  return encodeValidatedPublicState(validatedPublicState(state));
}

/** Exact normalized tournament utility for a 1-based final rank. */
export function normalizedFinalRankValue(rank, tableSize) {
  const players = integerInRange(tableSize, 2, 9, 'tableSize');
  const finalRank = integerInRange(rank, 1, players, 'rank');
  return 1 - (2 * (finalRank - 1)) / (players - 1);
}

function isNormalizedFinalRankValue(value, tableSize) {
  for (let rank = 1; rank <= tableSize; rank++) {
    if (Math.abs(value - normalizedFinalRankValue(rank, tableSize)) <= 1e-12) return true;
  }
  return false;
}

/**
 * Projects collector sample-v2 rows into the model's minimal training rows.
 * The aligned seed-group IDs are returned solely for cluster bootstrap; they
 * never enter features or serialized artifacts. Exact placement states are
 * counted and excluded from continuation-value learning.
 */
export function projectTournamentValueTrainingSamples(samples) {
  if (!Array.isArray(samples)) throw new TypeError('dataset samples must be an array');
  const rows = [];
  const clusterIds = [];
  let droppedTerminal = 0;
  let droppedEliminated = 0;
  let droppedEarlyFinish = 0;
  samples.forEach((sample, index) => {
    const record = assertExactKeys(
      sample, DATASET_SAMPLE_FIELDS, `dataset samples[${index}]`,
    );
    if (record.schema !== DATASET_SAMPLE_SCHEMA) {
      throw new TypeError(`dataset samples[${index}] has unsupported schema`);
    }
    const group = objectRecord(record.group, `dataset samples[${index}].group`);
    if (typeof group.seedGroup !== 'string' || !group.seedGroup.length
      || group.seedGroup.length > 512) {
      throw new TypeError(
        `dataset samples[${index}].group.seedGroup must contain 1..512 characters`,
      );
    }
    const state = validatedPublicState(record.state, {
      allowTerminal: true,
      allowExact: true,
    });
    const target = assertExactKeys(
      record.target, DATASET_TARGET_FIELDS, `dataset samples[${index}].target`,
    );
    const rank = integerInRange(
      target.rank, 1, state.tableSize, `dataset samples[${index}].target.rank`,
    );
    const rankUtility = finiteNumber(
      target.rankUtility, `dataset samples[${index}].target.rankUtility`,
    );
    const expectedUtility = normalizedFinalRankValue(rank, state.tableSize);
    if (Math.abs(rankUtility - expectedUtility) > 1e-12) {
      throw new RangeError(`dataset samples[${index}] has inconsistent rank utility`);
    }
    if (typeof target.firstPlace !== 'boolean'
      || target.firstPlace !== (rank === 1)) {
      throw new TypeError(`dataset samples[${index}] has inconsistent firstPlace label`);
    }
    if (state.round === state.maxRounds) {
      droppedTerminal++;
      return;
    }
    if (state.focalStack <= 0) {
      droppedEliminated++;
      return;
    }
    if (state.aliveCount < 2) {
      droppedEarlyFinish++;
      return;
    }
    rows.push(Object.freeze({
      state: Object.freeze({
        tableSize: state.tableSize,
        round: state.round,
        maxRounds: state.maxRounds,
        bigBlind: state.bigBlind,
        focalStack: state.focalStack,
        opponentStacks: state.opponentStacks,
        liveStacksFromButton: state.liveStacksFromButton,
        focalPosition: state.focalPosition,
      }),
      value: rankUtility,
    }));
    clusterIds.push(group.seedGroup);
  });
  const droppedExact = droppedTerminal + droppedEliminated + droppedEarlyFinish;
  return Object.freeze({
    rows: Object.freeze(rows),
    clusterIds: Object.freeze(clusterIds),
    inputCount: samples.length,
    continuationCount: rows.length,
    droppedTerminal,
    droppedEliminated,
    droppedEarlyFinish,
    droppedExact,
  });
}

function hashSeed(seed) {
  const text = String(seed);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function solveLinearSystem(matrix, rightHandSide) {
  const size = rightHandSide.length;
  const augmented = matrix.map((row, index) => [...row, rightHandSide[index]]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-14) {
      throw new RangeError('ridge system is numerically singular');
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let item = column; item <= size; item++) augmented[column][item] /= divisor;
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      if (factor === 0) continue;
      for (let item = column; item <= size; item++) {
        augmented[row][item] -= factor * augmented[column][item];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

function trainRidge(features, targets, counts, ridge) {
  const dimensions = features[0].length;
  const parameterCount = dimensions + 1;
  const gram = Array.from({ length: parameterCount }, () => (
    Array(parameterCount).fill(0)
  ));
  const rhs = Array(parameterCount).fill(0);
  let totalWeight = 0;
  for (let row = 0; row < features.length; row++) {
    const weight = counts[row];
    if (!weight) continue;
    totalWeight += weight;
    const design = [1, ...features[row]];
    for (let left = 0; left < parameterCount; left++) {
      rhs[left] += weight * design[left] * targets[row];
      for (let right = 0; right < parameterCount; right++) {
        gram[left][right] += weight * design[left] * design[right];
      }
    }
  }
  for (let index = 1; index < parameterCount; index++) {
    gram[index][index] += ridge * totalWeight;
  }
  // A tiny intercept stabilizer only matters for a malformed zero-information
  // shard and remains far below the configured slope regularization.
  gram[0][0] += Number.EPSILON * Math.max(1, totalWeight);
  const solution = solveLinearSystem(gram, rhs);
  return Object.freeze({
    intercept: solution[0],
    coefficients: Object.freeze(solution.slice(1)),
  });
}

function memberPrediction(member, standardized) {
  return member.intercept + member.coefficients.reduce((sum, coefficient, index) => (
    sum + coefficient * standardized[index]
  ), 0);
}

function survivorMeanRankValue(state) {
  let sum = 0;
  for (let rank = 1; rank <= state.aliveCount; rank++) {
    sum += normalizedFinalRankValue(rank, state.tableSize);
  }
  return sum / state.aliveCount;
}

function monotoneChipSharePrior(state) {
  const focalShare = state.focalStack / state.totalChips;
  const equalShare = 1 / state.aliveCount;
  return boundedTarget(
    survivorMeanRankValue(state) + 2 * (focalShare - equalShare),
  );
}

function linkedTarget(value, scale) {
  return Math.atanh(Math.max(-scale, Math.min(scale, value * scale)));
}

function linearTrainingTarget(value, state, settings) {
  // The learned latent fits rank utility while the fixed chip-share prior is
  // intentionally *not* algebraically cancelled. It provides a genuine
  // positive marginal-value floor under small chip transfers.
  return linkedTarget(value, settings.targetLinkScale);
}

function memberValue(member, standardized, state, settings) {
  const learnedLatent = memberPrediction(member, standardized);
  const priorLatent = linkedTarget(
    monotoneChipSharePrior(state),
    settings.targetLinkScale,
  );
  return Math.tanh(
    (1 - settings.monotonePriorWeight) * learnedLatent
      + settings.monotonePriorWeight * priorLatent,
  );
}

function boundedTarget(value) {
  return Math.max(TARGET_MIN, Math.min(TARGET_MAX, value));
}

function percentile(values, probability) {
  const sorted = [...values].sort((left, right) => left - right);
  return quantile(sorted, probability);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateOptions({
  ensembleSize = DEFAULT_TOURNAMENT_VALUE_OPTIONS.ensembleSize,
  ridge = DEFAULT_TOURNAMENT_VALUE_OPTIONS.ridge,
  seed = DEFAULT_TOURNAMENT_VALUE_OPTIONS.seed,
  rangePaddingZ = DEFAULT_TOURNAMENT_VALUE_OPTIONS.rangePaddingZ,
  distancePaddingZ = DEFAULT_TOURNAMENT_VALUE_OPTIONS.distancePaddingZ,
  targetLinkScale = DEFAULT_TOURNAMENT_VALUE_OPTIONS.targetLinkScale,
  monotonePriorWeight = DEFAULT_TOURNAMENT_VALUE_OPTIONS.monotonePriorWeight,
} = {}) {
  const size = integerInRange(ensembleSize, 2, 64, 'ensembleSize');
  const regularization = finiteNumber(ridge, 'ridge');
  if (!(regularization >= 1e-8)) {
    throw new RangeError('ridge must be at least 1e-8 for numerical stability');
  }
  const rangePadding = finiteNumber(rangePaddingZ, 'rangePaddingZ');
  const distancePadding = finiteNumber(distancePaddingZ, 'distancePaddingZ');
  if (!(rangePadding > 0) || !(distancePadding > 0)) {
    throw new RangeError('OOD paddings must be positive');
  }
  const linkScale = finiteNumber(targetLinkScale, 'targetLinkScale');
  if (!(linkScale > 0 && linkScale < 1)) {
    throw new RangeError('targetLinkScale must be in 0..1');
  }
  const priorWeight = finiteNumber(monotonePriorWeight, 'monotonePriorWeight');
  if (!(priorWeight >= 0 && priorWeight < 1)) {
    throw new RangeError('monotonePriorWeight must be in 0..1');
  }
  const seedText = String(seed);
  if (!seedText.length || seedText.length > 256) throw new RangeError('seed must contain 1..256 characters');
  return Object.freeze({
    ensembleSize: size,
    ridge: regularization,
    seed: seedText,
    rangePaddingZ: rangePadding,
    distancePaddingZ: distancePadding,
    targetLinkScale: linkScale,
    monotonePriorWeight: priorWeight,
  });
}

function standardizedFeatures(features, scaler) {
  return features.map((value, index) => (
    (value - scaler.mean[index]) / scaler.scale[index]
  ));
}

function prepareBootstrapClusters(clusterIds, sampleCount) {
  const explicitClusters = clusterIds != null;
  if (explicitClusters && (!Array.isArray(clusterIds) || clusterIds.length !== sampleCount)) {
    throw new RangeError('clusterIds must align one-to-one with samples');
  }
  const groupsById = new Map();
  for (let index = 0; index < sampleCount; index++) {
    const id = explicitClusters ? clusterIds[index] : `sample-row-${index}`;
    if (typeof id !== 'string' || !id.length || id.length > 512) {
      throw new TypeError(`clusterIds[${index}] must contain 1..512 characters`);
    }
    if (!groupsById.has(id)) groupsById.set(id, []);
    groupsById.get(id).push(index);
  }
  const groups = [...groupsById.values()].map((indices) => Object.freeze(indices));
  if (groups.length < 2) {
    throw new RangeError('training requires at least two independent bootstrap clusters');
  }
  return Object.freeze({
    groups: Object.freeze(groups),
    clusterCount: groups.length,
    bootstrapUnit: explicitClusters ? 'seed-group-cluster' : 'sample-row',
  });
}

/**
 * Trains a deterministic bootstrapped ridge ensemble.  Values are normalized
 * final-rank utilities in [-1, 1].  The returned artifact is directly JSON
 * serializable and intentionally contains no source rows.
 */
export function trainTournamentValueModel(samples, options = {}) {
  if (!Array.isArray(samples)) throw new TypeError('samples must be an array');
  const minimumSamples = TOURNAMENT_VALUE_FEATURES.length + 2;
  if (samples.length < minimumSamples) {
    throw new RangeError(`samples must contain at least ${minimumSamples} rows`);
  }
  const parsed = samples.map((sample, index) => {
    const record = assertExactKeys(sample, SAMPLE_FIELDS, `samples[${index}]`);
    const value = finiteNumber(record.value, `samples[${index}].value`);
    if (value < TARGET_MIN || value > TARGET_MAX) {
      throw new RangeError(`samples[${index}].value must be in [-1, 1]`);
    }
    const state = validatedPublicState(record.state);
    const features = encodeValidatedPublicState(state);
    if (!isNormalizedFinalRankValue(value, state.tableSize)) {
      throw new RangeError(
        `samples[${index}].value must equal normalized final-rank utility for its tableSize`,
      );
    }
    return Object.freeze({ features, value, state });
  });
  const settings = validateOptions(options);
  const bootstrap = prepareBootstrapClusters(options.clusterIds, samples.length);
  const rawFeatures = parsed.map((row) => row.features);
  const targets = parsed.map((row) => row.value);
  const regressionTargets = parsed.map((row) => (
    linearTrainingTarget(row.value, row.state, settings)
  ));
  const featureMean = TOURNAMENT_VALUE_FEATURES.map((_, dimension) => (
    mean(rawFeatures.map((row) => row[dimension]))
  ));
  const featureScale = TOURNAMENT_VALUE_FEATURES.map((_, dimension) => {
    const scale = populationStd(rawFeatures.map((row) => row[dimension]), featureMean[dimension]);
    return scale > 1e-12 ? scale : 1;
  });
  const scaler = Object.freeze({
    mean: Object.freeze(featureMean),
    scale: Object.freeze(featureScale),
  });
  const standardized = rawFeatures.map((row) => standardizedFeatures(row, scaler));
  const members = [];
  const oobPredictionSums = Array(samples.length).fill(0);
  const oobPredictionCounts = Array(samples.length).fill(0);
  for (let memberIndex = 0; memberIndex < settings.ensembleSize; memberIndex++) {
    const random = seededRandom(`${settings.seed}|bootstrap=${memberIndex}`);
    const counts = Array(samples.length).fill(0);
    const clusterDrawCounts = Array(bootstrap.clusterCount).fill(0);
    for (let draw = 0; draw < bootstrap.clusterCount; draw++) {
      clusterDrawCounts[Math.floor(random() * bootstrap.clusterCount)]++;
    }
    for (let cluster = 0; cluster < bootstrap.clusterCount; cluster++) {
      const count = clusterDrawCounts[cluster];
      if (!count) continue;
      for (const row of bootstrap.groups[cluster]) counts[row] += count;
    }
    const member = trainRidge(standardized, regressionTargets, counts, settings.ridge);
    members.push(member);
    for (let cluster = 0; cluster < bootstrap.clusterCount; cluster++) {
      if (clusterDrawCounts[cluster]) continue;
      for (const row of bootstrap.groups[cluster]) {
        oobPredictionSums[row] += memberValue(
          member,
          standardized[row],
          parsed[row].state,
          settings,
        );
        oobPredictionCounts[row]++;
      }
    }
  }

  const ensembleMeans = standardized.map((row, rowIndex) => mean(
    members.map((member) => memberValue(
      member,
      row,
      parsed[rowIndex].state,
      settings,
    )),
  ));
  const squaredErrors = targets.map((target, index) => (
    (ensembleMeans[index] - target) ** 2
  ));
  const fitRmse = Math.sqrt(mean(squaredErrors));
  const oobSquaredErrors = [];
  for (let row = 0; row < samples.length; row++) {
    if (!oobPredictionCounts[row]) continue;
    const prediction = boundedTarget(oobPredictionSums[row] / oobPredictionCounts[row]);
    oobSquaredErrors.push((prediction - targets[row]) ** 2);
  }
  if (!oobSquaredErrors.length) {
    throw new RangeError(
      'cluster bootstrap produced no out-of-bag predictions; add clusters or ensemble members',
    );
  }
  const residualStd = Math.sqrt(mean(oobSquaredErrors));
  const oobSampleCount = oobSquaredErrors.length;
  const targetMean = mean(targets);
  const targetStd = populationStd(targets, targetMean);
  const minZ = Array(TOURNAMENT_VALUE_FEATURES.length).fill(Number.POSITIVE_INFINITY);
  const maxZ = Array(TOURNAMENT_VALUE_FEATURES.length).fill(Number.NEGATIVE_INFINITY);
  for (const row of standardized) {
    for (let dimension = 0; dimension < row.length; dimension++) {
      if (row[dimension] < minZ[dimension]) minZ[dimension] = row[dimension];
      if (row[dimension] > maxZ[dimension]) maxZ[dimension] = row[dimension];
    }
  }
  const rmsDistances = standardized.map((row) => Math.sqrt(
    mean(row.map((value) => value * value)),
  ));
  const supportedTableSizes = [...new Set(parsed.map((row) => row.state.tableSize))]
    .sort((left, right) => left - right);
  const strataByKey = new Map();
  for (const row of parsed) {
    const stratum = {
      tableSize: row.state.tableSize,
      round: row.state.round,
      aliveCount: row.state.aliveCount,
    };
    strataByKey.set(`${stratum.tableSize}|${stratum.round}|${stratum.aliveCount}`, stratum);
  }
  const supportedStrata = [...strataByKey.values()].sort((left, right) => (
    (left.tableSize - right.tableSize)
      || (left.round - right.round)
      || (left.aliveCount - right.aliveCount)
  ));

  return deepFreeze({
    schema: TOURNAMENT_VALUE_SCHEMA,
    version: TOURNAMENT_VALUE_VERSION,
    featureSchema: {
      version: 3,
      names: [...TOURNAMENT_VALUE_FEATURES],
      stateFields: [...TOURNAMENT_VALUE_STATE_FIELDS],
      terminalRoundPolicy:
        'continuation-only-round-less-than-maxRounds-live-focal-at-least-two-survivors',
      targetBounds: [TARGET_MIN, TARGET_MAX],
      targetDefinition: '1 - 2 * (finalRank - 1) / (tableSize - 1)',
    },
    training: {
      sampleCount: samples.length,
      clusterCount: bootstrap.clusterCount,
      bootstrapUnit: bootstrap.bootstrapUnit,
      oobSampleCount,
      ensembleSize: settings.ensembleSize,
      ridge: settings.ridge,
      seed: settings.seed,
      fitRmse,
      residualStd,
      targetMean,
      targetStd,
      targetLinkScale: settings.targetLinkScale,
      monotonePriorWeight: settings.monotonePriorWeight,
    },
    scaler,
    ood: {
      minZ,
      maxZ,
      rmsLimit: percentile(rmsDistances, 0.99),
      rangePaddingZ: settings.rangePaddingZ,
      distancePaddingZ: settings.distancePaddingZ,
      supportedTableSizes,
      supportedStrata,
    },
    members,
  });
}

function validateArtifact(artifact) {
  const record = assertExactKeys(artifact, ARTIFACT_FIELDS, 'artifact');
  if (record.schema !== TOURNAMENT_VALUE_SCHEMA
    || record.version !== TOURNAMENT_VALUE_VERSION) {
    throw new TypeError('artifact schema/version is not supported');
  }
  const featureSchema = assertExactKeys(
    record.featureSchema, FEATURE_SCHEMA_FIELDS, 'artifact.featureSchema',
  );
  if (featureSchema.version !== 3
    || featureSchema.terminalRoundPolicy
      !== 'continuation-only-round-less-than-maxRounds-live-focal-at-least-two-survivors'
    || featureSchema.targetDefinition
      !== '1 - 2 * (finalRank - 1) / (tableSize - 1)') {
    throw new TypeError('artifact feature schema is not supported');
  }
  sameArray(featureSchema.names, TOURNAMENT_VALUE_FEATURES, 'artifact.featureSchema.names');
  sameArray(
    featureSchema.stateFields,
    TOURNAMENT_VALUE_STATE_FIELDS,
    'artifact.featureSchema.stateFields',
  );
  sameArray(featureSchema.targetBounds, [TARGET_MIN, TARGET_MAX], 'artifact target bounds');

  const training = assertExactKeys(record.training, TRAINING_FIELDS, 'artifact.training');
  const sampleCount = integerInRange(
    training.sampleCount, TOURNAMENT_VALUE_FEATURES.length + 2,
    Number.MAX_SAFE_INTEGER, 'artifact.training.sampleCount');
  const clusterCount = integerInRange(
    training.clusterCount, 2, sampleCount, 'artifact.training.clusterCount',
  );
  if (!['sample-row', 'seed-group-cluster'].includes(training.bootstrapUnit)) {
    throw new TypeError('artifact.training.bootstrapUnit is not supported');
  }
  if (training.bootstrapUnit === 'sample-row' && clusterCount !== sampleCount) {
    throw new RangeError('sample-row bootstrap must use one cluster per sample');
  }
  integerInRange(
    training.oobSampleCount, 1, sampleCount, 'artifact.training.oobSampleCount',
  );
  const ensembleSize = integerInRange(training.ensembleSize, 2, 64,
    'artifact.training.ensembleSize');
  if (!(finiteNumber(training.ridge, 'artifact.training.ridge') > 0)) {
    throw new RangeError('artifact.training.ridge must be positive');
  }
  if (typeof training.seed !== 'string' || !training.seed.length || training.seed.length > 256) {
    throw new TypeError('artifact.training.seed must be a non-empty string');
  }
  for (const field of ['fitRmse', 'residualStd', 'targetMean', 'targetStd']) {
    const value = finiteNumber(training[field], `artifact.training.${field}`);
    if ((field === 'fitRmse' || field === 'residualStd' || field === 'targetStd') && value < 0) {
      throw new RangeError(`artifact.training.${field} must be non-negative`);
    }
  }
  const targetLinkScale = finiteNumber(
    training.targetLinkScale,
    'artifact.training.targetLinkScale',
  );
  if (!(targetLinkScale > 0 && targetLinkScale < 1)) {
    throw new RangeError('artifact.training.targetLinkScale must be in 0..1');
  }
  const monotonePriorWeight = finiteNumber(
    training.monotonePriorWeight,
    'artifact.training.monotonePriorWeight',
  );
  if (!(monotonePriorWeight >= 0 && monotonePriorWeight < 1)) {
    throw new RangeError('artifact.training.monotonePriorWeight must be in 0..1');
  }

  const dimensions = TOURNAMENT_VALUE_FEATURES.length;
  const scaler = assertExactKeys(record.scaler, SCALER_FIELDS, 'artifact.scaler');
  finiteVector(scaler.mean, dimensions, 'artifact.scaler.mean');
  const scales = finiteVector(scaler.scale, dimensions, 'artifact.scaler.scale');
  if (scales.some((scale) => !(scale > 0))) {
    throw new RangeError('artifact scaler scales must be positive');
  }
  const ood = assertExactKeys(record.ood, OOD_FIELDS, 'artifact.ood');
  const minZ = finiteVector(ood.minZ, dimensions, 'artifact.ood.minZ');
  const maxZ = finiteVector(ood.maxZ, dimensions, 'artifact.ood.maxZ');
  if (minZ.some((value, index) => value > maxZ[index])) {
    throw new RangeError('artifact OOD bounds are reversed');
  }
  if (finiteNumber(ood.rmsLimit, 'artifact.ood.rmsLimit') < 0) {
    throw new RangeError('artifact.ood.rmsLimit must be non-negative');
  }
  for (const field of ['rangePaddingZ', 'distancePaddingZ']) {
    if (!(finiteNumber(ood[field], `artifact.ood.${field}`) > 0)) {
      throw new RangeError(`artifact.ood.${field} must be positive`);
    }
  }
  if (!Array.isArray(ood.supportedTableSizes) || !ood.supportedTableSizes.length) {
    throw new RangeError('artifact.ood.supportedTableSizes must be a non-empty array');
  }
  const supportedTableSizes = ood.supportedTableSizes.map((tableSize, index) => (
    integerInRange(tableSize, 2, 9, `artifact.ood.supportedTableSizes[${index}]`)
  ));
  if (supportedTableSizes.some((tableSize, index) => (
    index > 0 && tableSize <= supportedTableSizes[index - 1]
  ))) {
    throw new RangeError('artifact.ood.supportedTableSizes must be sorted and unique');
  }
  if (!Array.isArray(ood.supportedStrata) || !ood.supportedStrata.length) {
    throw new RangeError('artifact.ood.supportedStrata must be a non-empty array');
  }
  let previousStratumKey = null;
  const coveredTables = new Set();
  ood.supportedStrata.forEach((entry, index) => {
    const stratum = assertExactKeys(
      entry, STRATUM_FIELDS, `artifact.ood.supportedStrata[${index}]`,
    );
    const tableSize = integerInRange(
      stratum.tableSize, 2, 9, `artifact.ood.supportedStrata[${index}].tableSize`,
    );
    const round = integerInRange(
      stratum.round, 0, 10_000, `artifact.ood.supportedStrata[${index}].round`,
    );
    const aliveCount = integerInRange(
      stratum.aliveCount, 2, tableSize,
      `artifact.ood.supportedStrata[${index}].aliveCount`,
    );
    if (!supportedTableSizes.includes(tableSize)) {
      throw new RangeError('artifact OOD stratum names an unsupported table size');
    }
    const key = `${String(tableSize).padStart(2, '0')}|${String(round).padStart(5, '0')}|${String(aliveCount).padStart(2, '0')}`;
    if (previousStratumKey != null && key <= previousStratumKey) {
      throw new RangeError('artifact.ood.supportedStrata must be sorted and unique');
    }
    previousStratumKey = key;
    coveredTables.add(tableSize);
  });
  if (supportedTableSizes.some((tableSize) => !coveredTables.has(tableSize))) {
    throw new RangeError('every supported table size must have at least one OOD stratum');
  }
  if (!Array.isArray(record.members) || record.members.length !== ensembleSize) {
    throw new RangeError('artifact.members length must equal ensembleSize');
  }
  record.members.forEach((member, index) => {
    const parsedMember = assertExactKeys(member, MEMBER_FIELDS, `artifact.members[${index}]`);
    finiteNumber(parsedMember.intercept, `artifact.members[${index}].intercept`);
    finiteVector(parsedMember.coefficients, dimensions,
      `artifact.members[${index}].coefficients`);
  });
  return record;
}

/** Validates and compiles an untrusted JSON artifact once for repeated use. */
export function compileTournamentValueModel(artifact) {
  if (COMPILED_ARTIFACTS.has(artifact)) return artifact;
  validateArtifact(artifact);
  const immutableArtifact = deepFreeze(structuredClone(artifact));
  const domain = Object.freeze({
    tableSizes: new Set(immutableArtifact.ood.supportedTableSizes),
    strata: new Set(immutableArtifact.ood.supportedStrata.map((stratum) => (
      `${stratum.tableSize}|${stratum.round}|${stratum.aliveCount}`
    ))),
  });
  const compiled = Object.freeze({
    schema: immutableArtifact.schema,
    version: immutableArtifact.version,
    predict: (state) => predictCompiled(immutableArtifact, domain, state),
  });
  COMPILED_ARTIFACTS.set(compiled, immutableArtifact);
  return compiled;
}

function predictCompiled(artifact, domain, state) {
  const parsedState = validatedPublicState(state);
  const features = encodeValidatedPublicState(parsedState);
  const standardized = standardizedFeatures(features, artifact.scaler);
  const predictions = artifact.members.map((member) => memberValue(
    member,
    standardized,
    parsedState,
    artifact.training,
  ));
  if (standardized.some((value) => !Number.isFinite(value))
    || predictions.some((value) => !Number.isFinite(value))) {
    throw new RangeError('model inference produced a non-finite value');
  }
  const rawMean = mean(predictions);
  const epistemicStd = populationStd(predictions, rawMean);
  const uncertainty = Math.sqrt(
    epistemicStd * epistemicStd
      + artifact.training.residualStd * artifact.training.residualStd,
  );
  let rangeScore = 0;
  for (let index = 0; index < standardized.length; index++) {
    const value = standardized[index];
    if (value < artifact.ood.minZ[index]) {
      rangeScore = Math.max(
        rangeScore,
        (artifact.ood.minZ[index] - value) / artifact.ood.rangePaddingZ,
      );
    } else if (value > artifact.ood.maxZ[index]) {
      rangeScore = Math.max(
        rangeScore,
        (value - artifact.ood.maxZ[index]) / artifact.ood.rangePaddingZ,
      );
    }
  }
  const rmsDistance = Math.sqrt(mean(standardized.map((value) => value * value)));
  const distanceScore = rmsDistance <= artifact.ood.rmsLimit
    ? 0
    : (rmsDistance - artifact.ood.rmsLimit) / artifact.ood.distancePaddingZ;
  const supportedTableSize = domain.tableSizes.has(parsedState.tableSize);
  const supportedStratum = domain.strata.has(
    `${parsedState.tableSize}|${parsedState.round}|${parsedState.aliveCount}`,
  );
  const categoricalScore = supportedTableSize && supportedStratum ? 0 : 2;
  const oodScore = Math.max(rangeScore, distanceScore, categoricalScore);
  if (![rawMean, epistemicStd, uncertainty, oodScore].every(Number.isFinite)) {
    throw new RangeError('model inference produced a non-finite aggregate');
  }
  return Object.freeze({
    mean: rawMean,
    // Smooth tanh-linked members are bounded by construction; this field is
    // retained so quality gates can reject older hard-clipped artifacts.
    clipped: false,
    uncertainty,
    epistemicStd,
    residualStd: artifact.training.residualStd,
    ood: oodScore > TOURNAMENT_VALUE_OOD_THRESHOLD,
    oodScore,
    supportedTableSize,
    supportedStratum,
  });
}

/** Predicts through either a compiled model or a raw artifact. */
export function predictTournamentValue(modelOrArtifact, state) {
  return compileTournamentValueModel(modelOrArtifact).predict(state);
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== 'object') return value;
  const canonical = {};
  for (const key of Object.keys(value).sort()) {
    canonical[key] = canonicalJsonValue(value[key]);
  }
  return canonical;
}

/** Canonical JSON serialization for storage, hashing and byte-level replay. */
export function serializeTournamentValueModel(modelOrArtifact, space = 0) {
  const artifact = COMPILED_ARTIFACTS.get(modelOrArtifact) || modelOrArtifact;
  validateArtifact(artifact);
  const indentation = integerInRange(space, 0, 10, 'space');
  return JSON.stringify(canonicalJsonValue(artifact), null, indentation);
}

/** Parses and validates model JSON before exposing an inference function. */
export function parseTournamentValueModel(json) {
  if (typeof json !== 'string') throw new TypeError('model JSON must be a string');
  return compileTournamentValueModel(JSON.parse(json));
}
