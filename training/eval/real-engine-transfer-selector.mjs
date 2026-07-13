import { createHash } from 'node:crypto';

import {
  COMPACT_RESIDUAL_FEATURE_ORDER,
  compactResidualFeatures,
} from '../../js/game/blueprint-residual-policy.js';

export const REAL_ENGINE_TRANSFER_CALIBRATION_SCHEMA =
  'qyj-online-resolver-transfer-calibration-v1';
export const REAL_ENGINE_TRANSFER_SELECTOR_SCHEMA =
  'qyj-real-engine-transfer-selector-v1';

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

function lowerBound(values) {
  if (!values.length) return { mean: null, lowerBound: null };
  const average = mean(values);
  if (values.length < 2) return { mean: average, lowerBound: null };
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0)
    / (values.length - 1);
  const t95 = 1.644854 + 0.710 / (values.length - 1);
  return { mean: average, lowerBound: average - t95 * Math.sqrt(variance / values.length) };
}

function validateCalibration(raw) {
  if (raw?.schema !== REAL_ENGINE_TRANSFER_CALIBRATION_SCHEMA
    || Number(raw?.version) !== 1 || raw?.mode !== 'offline-evaluation-only'
    || ![6, 9].includes(Number(raw?.tableSize)) || !Array.isArray(raw?.featureOrder)
    || !raw?.records || typeof raw.records !== 'object'
    || typeof raw?.resolverStrategyKey !== 'string') {
    throw new TypeError('unsupported real-engine transfer calibration');
  }
  return raw;
}

export function buildRealEngineTransferSelector(calibrations, {
  resolverStrategyKey,
  minSimilarity = 0.75,
  neighborCount = 12,
  minNeighbors = 4,
  minIndependentClusters = 6,
  minSamples = 24,
  minRankLowerBound = 0,
  minHpLowerBound = 0,
} = {}) {
  const sources = (Array.isArray(calibrations) ? calibrations : [calibrations])
    .map(validateCalibration);
  if (!sources.length || !resolverStrategyKey
    || sources.some((source) => source.resolverStrategyKey !== resolverStrategyKey)) {
    throw new RangeError('selector calibrations must bind one resolver strategy');
  }
  const tournamentSources = new Map();
  const rootBuckets = new Map();
  for (const source of sources) {
    for (const modelSource of source.tournamentValueSources || []) {
      tournamentSources.set(sha(modelSource), modelSource);
    }
    for (const [recordId, record] of Object.entries(source.records)) {
      if (!record?.mask || !record?.features || !record?.baseActionKey || !record?.actionKey
        || record.baseActionKey === record.actionKey || !Array.isArray(record.clusters)) continue;
      const rootKey = `${source.tableSize}:${recordId}`;
      const bucket = rootBuckets.get(rootKey) || {
        rootSha256: createHash('sha256').update(rootKey).digest('hex'),
        tableSize: Number(source.tableSize),
        mask: record.mask,
        features: { ...record.features },
        featureOrder: [...source.featureOrder],
        baseActionKey: record.baseActionKey,
        actionKey: record.actionKey,
        clusters: new Map(),
      };
      for (const cluster of record.clusters) {
        const clusterId = String(cluster.clusterId);
        const prior = bucket.clusters.get(clusterId) || { rank: 0, hp: 0, samples: 0 };
        const samples = Math.max(1, Number(cluster.samples) || 0);
        prior.rank += Number(cluster.rankAdvantage) * samples;
        prior.hp += Number(cluster.hpAdvantage) * samples;
        prior.samples += samples;
        bucket.clusters.set(clusterId, prior);
      }
      rootBuckets.set(rootKey, bucket);
    }
  }
  const roots = [...rootBuckets.values()].map((root) => {
    const clusters = [...root.clusters].map(([clusterId, cluster]) => Object.freeze({
      clusterId,
      rankAdvantage: cluster.rank / cluster.samples,
      hpAdvantage: cluster.hp / cluster.samples,
      samples: cluster.samples,
    })).sort((left, right) => left.clusterId.localeCompare(right.clusterId));
    return Object.freeze({
      ...root,
      features: Object.freeze(root.features),
      featureOrder: Object.freeze(root.featureOrder),
      samples: clusters.reduce((sum, cluster) => sum + cluster.samples, 0),
      clusters: Object.freeze(clusters),
    });
  });
  roots.sort((left, right) => left.rootSha256.localeCompare(right.rootSha256));
  if (!roots.length) throw new RangeError('selector has no changed-action roots');
  return Object.freeze({
    schema: REAL_ENGINE_TRANSFER_SELECTOR_SCHEMA,
    version: 1,
    mode: 'offline-evaluation-only',
    resolverStrategyKey,
    calibrationSha256: Object.freeze(sources.map(sha).sort()),
    tournamentValueSources: Object.freeze([...tournamentSources.entries()]
      .sort(([left], [right]) => left.localeCompare(right)).map(([, source]) => source)),
    thresholds: Object.freeze({
      minSimilarity, neighborCount, minNeighbors, minIndependentClusters,
      minSamples, minRankLowerBound, minHpLowerBound,
    }),
    roots: Object.freeze(roots),
    promotionEligible: false,
    promotionBlockers: Object.freeze([
      'real-engine-transfer-selector-requires-fresh-dual-table-evaluation',
      'offline-evaluation-only',
    ]),
  });
}

export function validateRealEngineTransferSelector(raw, { resolverStrategyKey } = {}) {
  if (raw?.schema !== REAL_ENGINE_TRANSFER_SELECTOR_SCHEMA || Number(raw?.version) !== 1
    || raw?.mode !== 'offline-evaluation-only' || !Array.isArray(raw?.roots)
    || !raw?.thresholds || typeof raw?.resolverStrategyKey !== 'string') {
    throw new TypeError('unsupported real-engine transfer selector');
  }
  if (resolverStrategyKey && raw.resolverStrategyKey !== resolverStrategyKey) {
    throw new RangeError('real-engine transfer selector strategy mismatch');
  }
  return raw;
}

export function evaluateRealEngineTransferSelector(selector, {
  informationSetKey,
  tableSize,
  baseActionKey,
  actionKey,
  tournamentValueSource = null,
} = {}) {
  const source = validateRealEngineTransferSelector(selector);
  if (source.tournamentValueSources?.length
    && !source.tournamentValueSources.some((candidate) => sha(candidate) === sha(tournamentValueSource))) {
    return Object.freeze({ eligible: false, reason: 'transfer-tournament-source-mismatch' });
  }
  const encoded = compactResidualFeatures(informationSetKey);
  if (!encoded) return Object.freeze({ eligible: false, reason: 'invalid-information-set' });
  if (!baseActionKey || !actionKey || baseActionKey === actionKey) {
    return Object.freeze({ eligible: false, reason: 'unchanged-action' });
  }
  const neighbors = [];
  for (const root of source.roots) {
    if (Number(root.tableSize) !== Number(tableSize)
      || root.baseActionKey !== baseActionKey || root.actionKey !== actionKey) continue;
    const order = root.featureOrder?.length
      ? root.featureOrder : COMPACT_RESIDUAL_FEATURE_ORDER;
    const featureMatches = order.reduce((sum, feature) => (
      sum + Number(root.features[feature] === encoded.features[feature])
    ), 0);
    // The action pair already guarantees that the base and proposed actions
    // are legal. Treat the remaining legal-action mask as one public feature
    // rather than a hard partition, so rare bet-size menus can borrow only
    // from otherwise-nearby roots while still paying an explicit penalty.
    const similarity = (featureMatches + Number(root.mask === encoded.mask))
      / (order.length + 1);
    if (similarity >= source.thresholds.minSimilarity) neighbors.push({ root, similarity });
  }
  neighbors.sort((left, right) => right.similarity - left.similarity
    || right.root.samples - left.root.samples
    || left.root.rootSha256.localeCompare(right.root.rootSha256));
  const selected = neighbors.slice(0, source.thresholds.neighborCount);
  if (selected.length < source.thresholds.minNeighbors) {
    return Object.freeze({
      eligible: false, reason: 'transfer-insufficient-neighbors', neighbors: selected.length,
    });
  }
  const byCluster = new Map();
  let samples = 0;
  for (const { root, similarity } of selected) {
    for (const cluster of root.clusters) {
      const bucket = byCluster.get(cluster.clusterId) || { rank: [], hp: [] };
      const weight = Math.max(0.000001, similarity ** 4) * Math.max(1, cluster.samples);
      bucket.rank.push({ value: cluster.rankAdvantage, weight });
      bucket.hp.push({ value: cluster.hpAdvantage, weight });
      byCluster.set(cluster.clusterId, bucket);
      samples += Math.max(1, cluster.samples);
    }
  }
  if (byCluster.size < source.thresholds.minIndependentClusters
    || samples < source.thresholds.minSamples) {
    return Object.freeze({
      eligible: false, reason: 'transfer-insufficient-independent-evidence',
      neighbors: selected.length, independentClusterCount: byCluster.size, samples,
    });
  }
  const clusterMean = (items) => items.reduce(
    (sum, item) => sum + item.value * item.weight, 0,
  ) / items.reduce((sum, item) => sum + item.weight, 0);
  const rank = lowerBound([...byCluster.values()].map((bucket) => clusterMean(bucket.rank)));
  const hp = lowerBound([...byCluster.values()].map((bucket) => clusterMean(bucket.hp)));
  const publicResult = {
    neighbors: selected.length,
    nearestSimilarity: selected[0].similarity,
    independentClusterCount: byCluster.size,
    samples,
    rankMean: rank.mean,
    rankLowerBound: rank.lowerBound,
    hpMean: hp.mean,
    hpLowerBound: hp.lowerBound,
  };
  if (!(rank.lowerBound > source.thresholds.minRankLowerBound)
    || !(hp.lowerBound > source.thresholds.minHpLowerBound)) {
    return Object.freeze({
      eligible: false, reason: 'transfer-dual-lcb-not-positive', ...publicResult,
    });
  }
  return Object.freeze({ eligible: true, reason: null, ...publicResult });
}
