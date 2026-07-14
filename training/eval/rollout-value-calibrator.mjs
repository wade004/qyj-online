import { createHash } from 'node:crypto';

export const ROLLOUT_VALUE_CALIBRATOR_SCHEMA = 'qyj-rollout-real-value-calibrator-v1';
const DATASET_SCHEMA = 'qyj-rollout-intervention-outcomes-v1';

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const finite = (value, fallback = 0) => Number.isFinite(Number(value))
  ? Number(value) : fallback;

function validateDataset(raw) {
  if (raw?.schema !== DATASET_SCHEMA || Number(raw?.version) !== 1
    || raw?.mode !== 'offline-evaluation-only' || ![6, 9].includes(Number(raw?.tableSize))
    || !Array.isArray(raw?.records) || typeof raw?.resolverStrategyKey !== 'string') {
    throw new TypeError('unsupported rollout intervention dataset');
  }
  return raw;
}

function aggression(actionKey) {
  if (actionKey === 'fold' || actionKey === 'check') return 0;
  if (actionKey === 'call') return 0.2;
  if (actionKey === 'raise:feint') return 0.5;
  if (actionKey === 'raise:strike') return 0.68;
  if (actionKey === 'raise:fierce') return 0.84;
  if (actionKey === 'allin') return 1;
  return 0.4;
}

function hashToken(token, buckets) {
  const digest = createHash('sha256').update(String(token)).digest();
  return {
    bucket: digest.readUInt32BE(0) % buckets,
    sign: (digest[4] & 1) ? 1 : -1,
  };
}

function vectorize(record, hashBuckets = 40) {
  const pot = Math.max(100, finite(record.pot));
  const base = aggression(record.baseActionKey);
  const action = aggression(record.actionKey);
  const vector = [
    1,
    clamp(Math.log1p(Math.max(0, finite(record.pot))) / 10, 0, 1.5),
    clamp(finite(record.screen?.mean) / pot, -3, 3),
    clamp(finite(record.screen?.lowerBound) / pot, -3, 3),
    clamp(finite(record.confirmation?.mean) / pot, -3, 3),
    clamp(finite(record.confirmation?.lowerBound) / pot, -3, 3),
    base,
    action,
    action - base,
  ];
  for (let index = 0; index < hashBuckets; index++) vector.push(0);
  const tokens = [
    `table=${record.tableSize}`,
    `street=${record.street}`,
    `base=${record.baseActionKey}`,
    `action=${record.actionKey}`,
    `pair=${record.baseActionKey}=>${record.actionKey}`,
    `table-street=${record.tableSize}|${record.street}`,
    `table-pair=${record.tableSize}|${record.baseActionKey}=>${record.actionKey}`,
    ...Object.entries(record.features || {}).map(([key, value]) => `${key}=${value}`),
  ];
  for (const token of tokens) {
    const hashed = hashToken(token, hashBuckets);
    vector[9 + hashed.bucket] += hashed.sign / Math.sqrt(tokens.length);
  }
  return vector;
}

function outcome(record) {
  return {
    hp: clamp(finite(record.outcome?.hpAdvantage)
      / Math.max(500, finite(record.pot)), -4, 4),
    rank: clamp(finite(record.outcome?.rankAdvantage)
      / Math.max(1, Number(record.tableSize) - 1), -1, 1),
  };
}

function solve(matrix, values) {
  const size = values.length;
  const augmented = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (pivot !== column) [augmented[pivot], augmented[column]]
      = [augmented[column], augmented[pivot]];
    const divisor = augmented[column][column];
    if (Math.abs(divisor) < 1e-12) continue;
    for (let index = column; index <= size; index++) augmented[column][index] /= divisor;
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      if (!factor) continue;
      for (let index = column; index <= size; index++) {
        augmented[row][index] -= factor * augmented[column][index];
      }
    }
  }
  return augmented.map((row, index) => Number.isFinite(row[size]) ? row[size] : 0);
}

function fit(records, { lambda, hashBuckets }) {
  const dimensions = 9 + hashBuckets;
  const matrix = Array.from({ length: dimensions }, () => Array(dimensions).fill(0));
  const hpValues = Array(dimensions).fill(0);
  const rankValues = Array(dimensions).fill(0);
  const counts = new Map();
  for (const record of records) {
    const key = `${record.tableSize}|${record.clusterId}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const record of records) {
    const vector = vectorize(record, hashBuckets);
    const target = outcome(record);
    const weight = 1 / counts.get(`${record.tableSize}|${record.clusterId}`);
    for (let left = 0; left < dimensions; left++) {
      hpValues[left] += weight * vector[left] * target.hp;
      rankValues[left] += weight * vector[left] * target.rank;
      for (let right = 0; right < dimensions; right++) {
        matrix[left][right] += weight * vector[left] * vector[right];
      }
    }
  }
  for (let index = 1; index < dimensions; index++) matrix[index][index] += lambda;
  matrix[0][0] += lambda * 0.01;
  return {
    hpWeights: solve(matrix, hpValues),
    rankWeights: solve(matrix, rankValues),
  };
}

function dot(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function predict(model, record) {
  const vector = vectorize(record, model.hashBuckets);
  return {
    hp: dot(model.hpWeights, vector),
    rank: dot(model.rankWeights, vector),
  };
}

function interval(values) {
  if (!values.length) return { mean: null, lowerBound: null, upperBound: null };
  const average = mean(values);
  if (values.length < 2) return { mean: average, lowerBound: null, upperBound: null };
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0)
    / (values.length - 1);
  const t95 = 1.644854 + 0.710 / (values.length - 1);
  const margin = t95 * Math.sqrt(variance / values.length);
  return { mean: average, lowerBound: average - margin, upperBound: average + margin };
}

function evidence(records) {
  const clusters = new Map();
  for (const record of records) {
    const key = `${record.tableSize}|${record.clusterId}`;
    const bucket = clusters.get(key) || { hp: [], rank: [] };
    const target = outcome(record);
    bucket.hp.push(target.hp);
    bucket.rank.push(target.rank);
    clusters.set(key, bucket);
  }
  const rows = [...clusters.values()].map((bucket) => ({
    hp: mean(bucket.hp),
    rank: mean(bucket.rank),
  }));
  return {
    independentClusters: rows.length,
    hp: interval(rows.map((row) => row.hp)),
    rank: interval(rows.map((row) => row.rank)),
  };
}

function crossValidatedPredictions(records, options) {
  const clusterKeys = [...new Set(records.map(
    (record) => `${record.tableSize}|${record.clusterId}`,
  ))].sort();
  const predictions = [];
  for (const clusterKey of clusterKeys) {
    const training = records.filter(
      (record) => `${record.tableSize}|${record.clusterId}` !== clusterKey,
    );
    const testing = records.filter(
      (record) => `${record.tableSize}|${record.clusterId}` === clusterKey,
    );
    const model = fit(training, options);
    for (const record of testing) predictions.push({ record, prediction: predict({
      ...model,
      hashBuckets: options.hashBuckets,
    }, record) });
  }
  return predictions;
}

function structurallyEligible(record, blockedTransitions) {
  return !blockedTransitions.includes(`${record.baseActionKey}=>${record.actionKey}`);
}

function tableThresholdAudit(rows, tableSize, thresholds, decisionCount, blockedTransitions) {
  const source = rows.filter((row) => Number(row.record.tableSize) === tableSize);
  const kept = source.filter((row) => structurallyEligible(row.record, blockedTransitions)
    && row.prediction.hp >= thresholds.hp
    && row.prediction.rank >= thresholds.rank).map((row) => row.record);
  const keptIds = new Set(kept.map((record) => record.sampleId));
  const rejected = source.filter((row) => !keptIds.has(row.record.sampleId))
    .map((row) => row.record);
  const result = {
    tableSize,
    samples: source.length,
    keptSamples: kept.length,
    rejectedSamples: rejected.length,
    projectedCoverage: kept.length / Math.max(1, decisionCount),
    kept: evidence(kept),
    rejected: evidence(rejected),
  };
  result.valid = result.projectedCoverage >= 0.005
    && result.kept.independentClusters >= 4
    && result.kept.hp.mean > 0 && result.kept.rank.mean >= 0;
  result.score = result.valid
    ? (result.kept.hp.lowerBound ?? -10)
      + 6 * (result.kept.rank.lowerBound ?? -10)
      + result.projectedCoverage
    : -Infinity;
  return result;
}

export function buildRolloutValueCalibrator(datasetInputs, options = {}) {
  const datasets = datasetInputs.map(validateDataset);
  const seen = new Set();
  const records = datasets.flatMap((dataset) => dataset.records).filter((record) => {
    if (!record?.sampleId || !record?.clusterId || !record?.outcome
      || record.baseActionKey === record.actionKey || seen.has(record.sampleId)) return false;
    seen.add(record.sampleId);
    return true;
  });
  if (!records.some((record) => Number(record.tableSize) === 6)
    || !records.some((record) => Number(record.tableSize) === 9)) {
    throw new RangeError('calibrator requires both 6-max and 9-max records');
  }
  const decisionCounts = new Map([6, 9].map((tableSize) => [tableSize, datasets
    .filter((dataset) => Number(dataset.tableSize) === tableSize)
    .reduce((sum, dataset) => sum + finite(dataset.resolverDecisionCount), 0)]));
  const hashBuckets = Number(options.hashBuckets || 40);
  const blockedTransitions = Object.freeze(
    options.blockedTransitions || ['call=>allin'],
  );
  const candidates = [];
  for (const lambda of [0.1, 0.3, 1, 3, 10, 30]) {
    const rows = crossValidatedPredictions(records, { lambda, hashBuckets });
    const selections = {};
    for (const tableSize of [6, 9]) {
      const tableCandidates = [];
      for (const hp of [-0.4, -0.3, -0.2, -0.1, -0.05, 0, 0.05, 0.1]) {
        for (const rank of [-0.12, -0.08, -0.04, -0.02, 0, 0.02]) {
          const thresholds = { hp, rank };
          tableCandidates.push({
            thresholds,
            audit: tableThresholdAudit(
              rows,
              tableSize,
              thresholds,
              decisionCounts.get(tableSize) || 0,
              blockedTransitions,
            ),
          });
        }
      }
      tableCandidates.sort((left, right) => right.audit.score - left.audit.score
        || left.thresholds.hp - right.thresholds.hp
        || left.thresholds.rank - right.thresholds.rank);
      selections[tableSize] = tableCandidates.find((candidate) => candidate.audit.valid) || null;
    }
    const valid = !!selections[6] && !!selections[9];
    candidates.push({
      lambda,
      thresholds: valid ? { 6: selections[6].thresholds, 9: selections[9].thresholds } : null,
      byTable: valid ? [selections[6].audit, selections[9].audit] : [
        selections[6]?.audit || null,
        selections[9]?.audit || null,
      ],
      valid,
      score: valid ? selections[6].audit.score + selections[9].audit.score : -Infinity,
    });
  }
  candidates.sort((left, right) => right.score - left.score
    || left.lambda - right.lambda
    || JSON.stringify(left.thresholds).localeCompare(JSON.stringify(right.thresholds)));
  const selected = candidates.find((candidate) => candidate.valid) || null;
  const model = selected ? fit(records, { lambda: selected.lambda, hashBuckets }) : {
    hpWeights: Array(9 + hashBuckets).fill(0),
    rankWeights: Array(9 + hashBuckets).fill(0),
  };
  return Object.freeze({
    schema: ROLLOUT_VALUE_CALIBRATOR_SCHEMA,
    version: 1,
    mode: 'offline-evaluation-only',
    targetResolverStrategyKey: String(
      options.targetResolverStrategyKey || 'online-resolver-v19-table-powered',
    ),
    hashBuckets,
    lambda: selected?.lambda ?? null,
    thresholds: Object.freeze(selected?.thresholds || {
      6: { hp: Infinity, rank: Infinity },
      9: { hp: Infinity, rank: Infinity },
    }),
    blockedTransitions,
    hpWeights: Object.freeze(model.hpWeights),
    rankWeights: Object.freeze(model.rankWeights),
    developmentRecords: Object.freeze(records),
    datasetSha256: Object.freeze(datasets.map(sha).sort()),
    developmentClusterSha256: Object.freeze([...new Set(records.map(
      (record) => sha(`${record.tableSize}|${record.clusterId}`),
    ))].sort()),
    calibration: Object.freeze({
      method: 'leave-one-seed-cluster-out-ridge-value-calibration',
      passed: !!selected,
      candidateCount: candidates.length,
      selected: selected ? Object.freeze({
        lambda: selected.lambda,
        thresholds: selected.thresholds,
        score: selected.score,
        byTable: selected.byTable,
      }) : null,
      audit: Object.freeze(candidates.slice(0, 12).map((candidate) => ({
        lambda: candidate.lambda,
        thresholds: candidate.thresholds,
        score: Number.isFinite(candidate.score) ? candidate.score : null,
        valid: candidate.valid,
        byTable: candidate.byTable,
      }))),
    }),
    promotionEligible: false,
    promotionBlockers: Object.freeze([
      selected ? 'requires-fresh-untouched-forced-branch-test'
        : 'development-cross-validation-failed',
      'requires-fresh-balanced-dual-table-league-evaluation',
      'offline-evaluation-only',
    ]),
  });
}

export function validateRolloutValueCalibrator(raw, { targetResolverStrategyKey } = {}) {
  if (raw?.schema !== ROLLOUT_VALUE_CALIBRATOR_SCHEMA || Number(raw?.version) !== 1
    || raw?.mode !== 'offline-evaluation-only' || !Number.isSafeInteger(raw?.hashBuckets)
    || !Array.isArray(raw?.hpWeights) || !Array.isArray(raw?.rankWeights)
    || raw.hpWeights.length !== 9 + raw.hashBuckets
    || raw.rankWeights.length !== 9 + raw.hashBuckets || !raw?.thresholds
    || !raw?.calibration || typeof raw?.targetResolverStrategyKey !== 'string') {
    throw new TypeError('unsupported rollout value calibrator');
  }
  if (targetResolverStrategyKey
    && raw.targetResolverStrategyKey !== targetResolverStrategyKey) {
    throw new RangeError('rollout value calibrator target strategy mismatch');
  }
  return raw;
}

export function evaluateRolloutValueCalibrator(calibrator, record) {
  const source = validateRolloutValueCalibrator(calibrator);
  if (!record?.baseActionKey || !record?.actionKey
    || record.baseActionKey === record.actionKey) {
    return Object.freeze({ eligible: true, reason: 'unchanged-action' });
  }
  if (source.calibration.passed !== true) {
    return Object.freeze({ eligible: false, reason: 'calibrator-development-gate-failed' });
  }
  if (!structurallyEligible(record, source.blockedTransitions || [])) {
    return Object.freeze({ eligible: false, reason: 'real-engine-structural-risk-blocked' });
  }
  const prediction = predict(source, record);
  const thresholds = source.thresholds[String(record.tableSize)]
    || source.thresholds[record.tableSize] || source.thresholds;
  const eligible = prediction.hp >= thresholds.hp
    && prediction.rank >= thresholds.rank;
  return Object.freeze({
    eligible,
    reason: eligible ? null : 'real-engine-calibrated-value-not-cleared',
    prediction: Object.freeze(prediction),
    thresholds,
  });
}
