import { createHash } from 'node:crypto';

export const CAUSAL_HARM_GATE_SCHEMA = 'qyj-rollout-causal-harm-gate-v1';
export const INTERVENTION_DATASET_SCHEMA = 'qyj-rollout-intervention-outcomes-v1';

const sha = (value) => createHash('sha256').update(
  typeof value === 'string' ? value : JSON.stringify(value),
).digest('hex');
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function interval(values) {
  if (!values.length) return { mean: null, lowerBound: null, upperBound: null };
  const average = mean(values);
  if (values.length < 2) {
    return { mean: average, lowerBound: null, upperBound: null };
  }
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0)
    / (values.length - 1);
  const t95 = 1.644854 + 0.710 / (values.length - 1);
  const margin = t95 * Math.sqrt(variance / values.length);
  return { mean: average, lowerBound: average - margin, upperBound: average + margin };
}

function validateDataset(raw) {
  if (raw?.schema !== INTERVENTION_DATASET_SCHEMA || Number(raw?.version) !== 1
    || raw?.mode !== 'offline-evaluation-only' || ![6, 9].includes(Number(raw?.tableSize))
    || !Array.isArray(raw?.records) || typeof raw?.sourceGroupSecretId !== 'string'
    || typeof raw?.resolverStrategyKey !== 'string') {
    throw new TypeError('unsupported rollout intervention dataset');
  }
  return raw;
}

function normalizedDiagnostic(record, stage, field) {
  const pot = Math.max(100, finite(record?.pot, 0));
  return clamp(finite(record?.[stage]?.[field], 0) / pot, -3, 3);
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

const FEATURE_WEIGHTS = Object.freeze({
  h: 0.45,
  b: 0.35,
  stk: 0.25,
  spr: 0.25,
  tc: 0.2,
  r: 0.15,
  p: 0.15,
  n: 0.1,
  a: 0.1,
  ip: 0.08,
  cl: 0.08,
  ao: 0.08,
  rc: 0.08,
  rr: 0.08,
  jm: 0.08,
});

function publicDistance(left, right) {
  if (Number(left.tableSize) !== Number(right.tableSize)) return Infinity;
  let distance = left.street === right.street ? 0 : 0.8;
  if (left.baseActionKey !== right.baseActionKey) distance += 0.55;
  if (left.actionKey !== right.actionKey) distance += 0.7;
  distance += 0.5 * Math.abs(
    aggression(left.baseActionKey) - aggression(right.baseActionKey),
  );
  distance += 0.75 * Math.abs(aggression(left.actionKey) - aggression(right.actionKey));
  distance += 0.35 * Math.abs(
    Math.log1p(Math.max(0, finite(left.pot))) - Math.log1p(Math.max(0, finite(right.pot))),
  );
  for (const stage of ['screen', 'confirmation']) {
    distance += 0.3 * Math.abs(
      normalizedDiagnostic(left, stage, 'mean') - normalizedDiagnostic(right, stage, 'mean'),
    );
    distance += 0.45 * Math.abs(
      normalizedDiagnostic(left, stage, 'lowerBound')
        - normalizedDiagnostic(right, stage, 'lowerBound'),
    );
  }
  for (const [key, weight] of Object.entries(FEATURE_WEIGHTS)) {
    if (String(left.features?.[key] ?? '') !== String(right.features?.[key] ?? '')) {
      distance += weight;
    }
  }
  if (String(left.mask ?? '') !== String(right.mask ?? '')) distance += 0.08;
  return distance;
}

function targets(record) {
  const tableSize = Number(record.tableSize);
  return {
    hp: clamp(finite(record.outcome?.hpAdvantage) / Math.max(500, finite(record.pot)), -4, 4),
    rank: clamp(finite(record.outcome?.rankAdvantage) / Math.max(1, tableSize - 1), -1, 1),
  };
}

function predict(records, query, hyperparameters, excludedClusterId = null) {
  const bandwidth = Number(hyperparameters.bandwidth);
  const neighbors = Number(hyperparameters.neighbors);
  const byCluster = new Map();
  for (const record of records) {
    if (String(record.clusterId) === String(excludedClusterId)) continue;
    const distance = publicDistance(record, query);
    if (!Number.isFinite(distance)) continue;
    const bucket = byCluster.get(record.clusterId) || [];
    bucket.push({ record, distance });
    byCluster.set(record.clusterId, bucket);
  }
  const clusters = [...byCluster].map(([clusterId, rows]) => {
    rows.sort((left, right) => left.distance - right.distance);
    const local = rows.slice(0, 3);
    const weights = local.map((row) => Math.exp(-row.distance / bandwidth));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    const weighted = (selector) => local.reduce(
      (sum, row, index) => sum + weights[index] * selector(targets(row.record)), 0,
    ) / totalWeight;
    return {
      clusterId,
      distance: local[0].distance,
      hp: weighted((value) => value.hp),
      rank: weighted((value) => value.rank),
      hpLoss: weighted((value) => Number(value.hp < -0.5)),
      rankLoss: weighted((value) => Number(value.rank < 0)),
      catastrophicLoss: weighted((value) => Number(value.hp < -1.5 || value.rank < -0.15)),
    };
  }).sort((left, right) => left.distance - right.distance
    || String(left.clusterId).localeCompare(String(right.clusterId))).slice(0, neighbors);
  if (clusters.length < Number(hyperparameters.minClusters)) {
    return { available: false, reason: 'insufficient-independent-neighbors' };
  }
  const weights = clusters.map((cluster) => Math.exp(-cluster.distance / bandwidth));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const totalSquaredWeight = weights.reduce((sum, value) => sum + (value ** 2), 0);
  const effectiveClusters = (totalWeight ** 2) / Math.max(Number.EPSILON, totalSquaredWeight);
  const estimate = (field) => {
    const average = clusters.reduce(
      (sum, cluster, index) => sum + weights[index] * cluster[field], 0,
    ) / totalWeight;
    const variance = clusters.reduce(
      (sum, cluster, index) => sum + weights[index] * ((cluster[field] - average) ** 2), 0,
    ) / totalWeight;
    const standardError = Math.sqrt(variance / Math.max(1, effectiveClusters - 1));
    return { mean: average, standardError };
  };
  return {
    available: true,
    reason: null,
    independentClusters: clusters.length,
    effectiveClusters,
    nearestDistance: clusters[0].distance,
    hp: estimate('hp'),
    rank: estimate('rank'),
    hpLossProbability: estimate('hpLoss'),
    rankLossProbability: estimate('rankLoss'),
    catastrophicLossProbability: estimate('catastrophicLoss'),
  };
}

function gatePrediction(prediction, hyperparameters) {
  if (!prediction.available) return { eligible: true, reason: prediction.reason };
  const z = Number(hyperparameters.z);
  const hpUpper = prediction.hp.mean + z * prediction.hp.standardError;
  const rankUpper = prediction.rank.mean + z * prediction.rank.standardError;
  const hpHarm = hpUpper < Number(hyperparameters.hpHarmUpper)
    && prediction.rank.mean <= Number(hyperparameters.rankNeutral);
  const rankHarm = rankUpper < Number(hyperparameters.rankHarmUpper)
    && prediction.hp.mean <= Number(hyperparameters.hpNeutral);
  const escalates = aggression(hyperparameters.queryActionKey)
    > aggression(hyperparameters.queryBaseActionKey) + 0.15;
  const downsideUpper = prediction.catastrophicLossProbability.mean
    + z * prediction.catastrophicLossProbability.standardError;
  const hpLossUpper = prediction.hpLossProbability.mean
    + z * prediction.hpLossProbability.standardError;
  const downsideHarm = escalates && (
    downsideUpper > Number(hyperparameters.maxCatastrophicLossProbability)
    || (hpLossUpper > Number(hyperparameters.maxHpLossProbability)
      && prediction.rankLossProbability.mean
        > Number(hyperparameters.minRankLossProbability))
  );
  return {
    eligible: !(hpHarm || rankHarm || downsideHarm),
    reason: hpHarm || rankHarm || downsideHarm
      ? 'cluster-causal-harm-predicted' : null,
    hpUpper,
    rankUpper,
    hpHarm,
    rankHarm,
    downsideHarm,
    downsideUpper,
    hpLossUpper,
  };
}

function clusterEvidence(records) {
  const buckets = new Map();
  for (const record of records) {
    const bucket = buckets.get(record.clusterId) || { hp: [], rank: [] };
    const target = targets(record);
    bucket.hp.push(target.hp);
    bucket.rank.push(target.rank);
    buckets.set(record.clusterId, bucket);
  }
  const clusters = [...buckets].map(([clusterId, bucket]) => ({
    clusterId,
    hp: mean(bucket.hp),
    rank: mean(bucket.rank),
  }));
  return {
    independentClusters: clusters.length,
    hp: interval(clusters.map((cluster) => cluster.hp)),
    rank: interval(clusters.map((cluster) => cluster.rank)),
  };
}

export function crossValidateCausalHarmGate(records, hyperparameters) {
  const evaluated = records.map((record) => {
    const prediction = predict(records, record, hyperparameters, record.clusterId);
    return { record, prediction, gate: gatePrediction(prediction, {
      ...hyperparameters,
      queryBaseActionKey: record.baseActionKey,
      queryActionKey: record.actionKey,
    }) };
  });
  const byTable = [6, 9].map((tableSize) => {
    const rows = evaluated.filter((row) => Number(row.record.tableSize) === tableSize);
    const available = rows.filter((row) => row.prediction.available);
    const kept = rows.filter((row) => row.gate.eligible).map((row) => row.record);
    const rejected = rows.filter((row) => !row.gate.eligible).map((row) => row.record);
    return {
      tableSize,
      samples: rows.length,
      predictableSamples: available.length,
      keptSamples: kept.length,
      rejectedSamples: rejected.length,
      kept: clusterEvidence(kept),
      rejected: clusterEvidence(rejected),
      all: clusterEvidence(rows.map((row) => row.record)),
    };
  });
  return { byTable, evaluated };
}

function candidateScore(report) {
  let score = 0;
  for (const row of report.byTable) {
    if (!row.rejectedSamples || row.rejected.independentClusters < 2) return -Infinity;
    const rejectedHp = row.rejected.hp.mean ?? 0;
    const rejectedRank = row.rejected.rank.mean ?? 0;
    if (rejectedHp >= 0 || rejectedRank > 0) return -Infinity;
    const keepRate = row.keptSamples / Math.max(1, row.samples);
    // Development coverage is only an estimate of future action-change coverage.
    // Retain a wide buffer over the 0.5% league gate instead of calibrating on its edge.
    if (keepRate < 0.7) return -Infinity;
    const improvementHp = (row.kept.hp.mean ?? 0) - (row.all.hp.mean ?? 0);
    const improvementRank = (row.kept.rank.mean ?? 0) - (row.all.rank.mean ?? 0);
    score += improvementRank * 8 + improvementHp + keepRate * 0.01;
  }
  return score;
}

export function buildCausalHarmGate(datasetInputs, options = {}) {
  const datasets = datasetInputs.map(validateDataset);
  if (!datasets.length) throw new RangeError('causal harm gate requires development datasets');
  const secretIds = new Set(datasets.map((dataset) => dataset.sourceGroupSecretId));
  const records = datasets.flatMap((dataset) => dataset.records).filter((record) => (
    record?.outcome && record?.clusterId && record.baseActionKey && record.actionKey
    && record.baseActionKey !== record.actionKey && [6, 9].includes(Number(record.tableSize))
  ));
  const grid = options.grid || [];
  const defaultGrid = [];
  for (const bandwidth of [0.65, 0.9, 1.2]) {
    for (const neighbors of [5, 7, 9]) {
      for (const z of [0.75, 1, 1.5]) {
        for (const hpHarmUpper of [-0.2, -0.35, -0.5]) {
          for (const rankHarmUpper of [-0.025, -0.05, -0.1]) {
            for (const maxCatastrophicLossProbability of [0.3, 0.45, 0.6]) {
              defaultGrid.push({
                bandwidth,
                neighbors,
                minClusters: 4,
                z,
                hpHarmUpper,
                rankHarmUpper,
                hpNeutral: 0.05,
                rankNeutral: 0.015,
                maxCatastrophicLossProbability,
                maxHpLossProbability: 0.55,
                minRankLossProbability: 0.15,
              });
            }
          }
        }
      }
    }
  }
  const candidates = grid.length ? grid : defaultGrid;
  const calibration = candidates.map((hyperparameters) => {
    const report = crossValidateCausalHarmGate(records, hyperparameters);
    return { hyperparameters, score: candidateScore(report), byTable: report.byTable };
  }).sort((left, right) => right.score - left.score
    || JSON.stringify(left.hyperparameters).localeCompare(JSON.stringify(right.hyperparameters)));
  const selected = calibration.find((candidate) => Number.isFinite(candidate.score));
  const fallback = {
    bandwidth: 1,
    neighbors: 7,
    minClusters: Number.MAX_SAFE_INTEGER,
    z: 1,
    hpHarmUpper: -0.02,
    rankHarmUpper: -0.01,
    hpNeutral: 0.08,
    rankNeutral: 0.025,
    maxCatastrophicLossProbability: 1,
    maxHpLossProbability: 1,
    minRankLossProbability: 1,
  };
  const hyperparameters = selected?.hyperparameters || fallback;
  return Object.freeze({
    schema: CAUSAL_HARM_GATE_SCHEMA,
    version: 1,
    mode: 'offline-evaluation-only',
    targetResolverStrategyKey: String(
      options.targetResolverStrategyKey || 'online-resolver-v19-table-powered',
    ),
    sourceResolverStrategyKeys: Object.freeze([
      ...new Set(datasets.map((dataset) => dataset.resolverStrategyKey)),
    ].sort()),
    sourceGroupSecretIds: Object.freeze([...secretIds].sort()),
    datasetSha256: Object.freeze(datasets.map(sha).sort()),
    developmentClusterSha256: Object.freeze([
      ...new Set(records.map((record) => sha(String(record.clusterId)))),
    ].sort()),
    developmentRecords: Object.freeze(records),
    hyperparameters: Object.freeze(hyperparameters),
    calibration: Object.freeze({
      method: 'leave-one-seed-cluster-out-neighborhood-validation',
      selected: selected ? Object.freeze({
        score: selected.score,
        byTable: selected.byTable,
      }) : null,
      candidateCount: calibration.length,
      audit: Object.freeze(calibration.slice(0, 18).map((candidate) => Object.freeze({
        hyperparameters: candidate.hyperparameters,
        score: Number.isFinite(candidate.score) ? candidate.score : null,
        byTable: candidate.byTable,
      }))),
      passed: !!selected,
    }),
    promotionEligible: false,
    promotionBlockers: Object.freeze([
      selected ? 'requires-fresh-untouched-forced-branch-test' : 'development-calibration-failed',
      'requires-fresh-balanced-dual-table-league-evaluation',
      'offline-evaluation-only',
    ]),
  });
}

export function validateCausalHarmGate(raw, { targetResolverStrategyKey } = {}) {
  if (raw?.schema !== CAUSAL_HARM_GATE_SCHEMA || Number(raw?.version) !== 1
    || raw?.mode !== 'offline-evaluation-only' || !Array.isArray(raw?.developmentRecords)
    || !raw?.hyperparameters || !raw?.calibration
    || !Array.isArray(raw?.developmentClusterSha256)
    || (!Array.isArray(raw?.sourceGroupSecretIds)
      && typeof raw?.sourceGroupSecretId !== 'string')
    || typeof raw?.targetResolverStrategyKey !== 'string') {
    throw new TypeError('unsupported causal harm gate');
  }
  if (targetResolverStrategyKey
    && raw.targetResolverStrategyKey !== targetResolverStrategyKey) {
    throw new RangeError('causal harm gate target strategy mismatch');
  }
  return raw;
}

export function evaluateCausalHarmGate(gate, query) {
  const source = validateCausalHarmGate(gate);
  if (!query?.baseActionKey || !query?.actionKey
    || query.baseActionKey === query.actionKey) {
    return Object.freeze({ eligible: true, reason: 'unchanged-action' });
  }
  const prediction = predict(source.developmentRecords, query, source.hyperparameters);
  const decision = gatePrediction(prediction, {
    ...source.hyperparameters,
    queryBaseActionKey: query.baseActionKey,
    queryActionKey: query.actionKey,
  });
  return Object.freeze({
    ...decision,
    prediction: Object.freeze(prediction),
  });
}
