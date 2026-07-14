import { compactResidualFeatures } from '../../js/game/blueprint-residual-policy.js';

export const TOURNAMENT_LINEAR_ENSEMBLE_SCHEMA = 'qyj-tournament-linear-ensemble-v1';
export const LINEAR_ACTION_KEYS = Object.freeze([
  'fold', 'check', 'call', 'raise:feint', 'raise:strike', 'raise:fierce', 'allin',
]);

const T95 = Object.freeze([Infinity, Infinity, 12.706, 4.303, 3.182, 2.776, 2.571,
  2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131,
  2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06,
  2.056, 2.052, 2.048, 2.045]);

function hash32(text, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function sparseFeatures(encoded, dimensions) {
  const features = encoded.features;
  const tokens = [
    'bias', `mask=${encoded.mask}`,
    ...Object.entries(features).map(([key, value]) => `${key}=${value}`),
    `s+p=${features.s}|${features.p}`,
    `s+h=${features.s}|${features.h}`,
    `s+a=${features.s}|${features.a}`,
    `tc+r=${features.tc}|${features.r}`,
    `stk+spr=${features.stk}|${features.spr}`,
    `h+b=${features.h}|${features.b}`,
  ];
  const scale = 1 / Math.sqrt(tokens.length);
  const combined = new Map();
  for (const token of tokens) {
    const index = token === 'bias' ? 0 : hash32(token) % dimensions;
    const sign = token === 'bias' || (hash32(token, 0x9e3779b9) & 1) === 0 ? 1 : -1;
    combined.set(index, (combined.get(index) || 0) + sign * scale);
  }
  return [...combined].map(([index, value]) => Object.freeze({ index, value }));
}

function predict(weights, vector, actionIndex, dimensions) {
  const actionOffset = dimensions * (actionIndex + 1);
  let result = 0;
  for (const feature of vector) {
    result += feature.value * (weights[feature.index] + weights[actionOffset + feature.index]);
  }
  return result;
}

function validateDataset(dataset) {
  if (!dataset || dataset.schema !== 'qyj-tournament-trajectory-dataset-v1'
    || dataset.version !== 1 || !Array.isArray(dataset.rows) || !dataset.rows.length) {
    throw new TypeError('invalid tournament trajectory dataset');
  }
  return dataset.rows.map((row, index) => {
    const encoded = compactResidualFeatures(row.informationSetKey);
    const propensity = Number(row.actionPropensity);
    const rankReward = Number(row.rankValue);
    const hpReward = Number(row.hpValue);
    if (!encoded || ![6, 9].includes(Number(row.tableSize))
      || typeof row.sourceGroup !== 'string' || !row.sourceGroup
      || typeof row.trajectoryId !== 'string' || !row.trajectoryId
      || !LINEAR_ACTION_KEYS.includes(row.actionKey)
      || !Array.isArray(row.legalActionKeys) || !row.legalActionKeys.includes(row.actionKey)
      || !(propensity > 0 && propensity <= 1)
      || !Number.isFinite(rankReward) || rankReward < -1 || rankReward > 1
      || !Number.isFinite(hpReward) || hpReward < -1 || hpReward > 1) {
      throw new TypeError(`invalid linear ensemble row ${index}`);
    }
    return { ...row, encoded, propensity, rankReward, hpReward };
  });
}

function fitGroup(rows, {
  dimensions, epochs, learningRate, l2, maxImportanceWeight,
}) {
  const width = dimensions * (LINEAR_ACTION_KEYS.length + 1);
  const rankWeights = new Float64Array(width);
  const hpWeights = new Float64Array(width);
  const trajectoryCounts = new Map();
  const support = Object.fromEntries(LINEAR_ACTION_KEYS.map((action) => [action, 0]));
  for (const row of rows) {
    trajectoryCounts.set(row.trajectoryId, (trajectoryCounts.get(row.trajectoryId) || 0) + 1);
    support[row.actionKey]++;
  }
  const samples = rows.map((row) => ({
    row,
    vector: sparseFeatures(row.encoded, dimensions),
    actionIndex: LINEAR_ACTION_KEYS.indexOf(row.actionKey),
    rawWeight: Math.min(maxImportanceWeight, 1 / row.propensity)
      / trajectoryCounts.get(row.trajectoryId),
  })).sort((left, right) => hash32(left.row.rowId || left.row.informationSetKey)
    - hash32(right.row.rowId || right.row.informationSetKey));
  const weightScale = samples.length
    / samples.reduce((sum, sample) => sum + sample.rawWeight, 0);
  let rankSquaredError = 0;
  let hpSquaredError = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const rate = learningRate / Math.sqrt(1 + epoch / 4);
    const start = (epoch * 997) % samples.length;
    for (let offset = 0; offset < samples.length; offset++) {
      const sample = samples[(start + offset) % samples.length];
      const sampleWeight = sample.rawWeight * weightScale;
      const rankPrediction = predict(
        rankWeights, sample.vector, sample.actionIndex, dimensions,
      );
      const hpPrediction = predict(hpWeights, sample.vector, sample.actionIndex, dimensions);
      const rankError = Math.max(-4, Math.min(4, rankPrediction - sample.row.rankReward));
      const hpError = Math.max(-4, Math.min(4, hpPrediction - sample.row.hpReward));
      const actionOffset = dimensions * (sample.actionIndex + 1);
      for (const feature of sample.vector) {
        const gradientScale = sampleWeight * feature.value;
        for (const index of [feature.index, actionOffset + feature.index]) {
          rankWeights[index] -= rate * (rankError * gradientScale + l2 * rankWeights[index]);
          hpWeights[index] -= rate * (hpError * gradientScale + l2 * hpWeights[index]);
        }
      }
    }
  }
  for (const sample of samples) {
    rankSquaredError += (predict(rankWeights, sample.vector, sample.actionIndex, dimensions)
      - sample.row.rankReward) ** 2;
    hpSquaredError += (predict(hpWeights, sample.vector, sample.actionIndex, dimensions)
      - sample.row.hpReward) ** 2;
  }
  const serialize = (weights) => [...weights].map((value) => Math.round(value * 1e7) / 1e7);
  return Object.freeze({
    rows: rows.length,
    trajectories: trajectoryCounts.size,
    support,
    rankRmse: Math.sqrt(rankSquaredError / samples.length),
    hpRmse: Math.sqrt(hpSquaredError / samples.length),
    rankWeights: serialize(rankWeights),
    hpWeights: serialize(hpWeights),
  });
}

export function trainTournamentLinearEnsemble(dataset, {
  tableSize = 6,
  dimensions = 256,
  epochs = 24,
  learningRate = 0.025,
  l2 = 0.0005,
  maxImportanceWeight = 8,
  minGroups = 8,
  minActionSamples = 8,
  minAdvantage = 0.005,
} = {}) {
  const rows = validateDataset(dataset).filter((row) => Number(row.tableSize) === tableSize);
  if (![6, 9].includes(Number(tableSize)) || !Number.isSafeInteger(dimensions)
    || dimensions < 32 || !Number.isSafeInteger(epochs) || epochs < 1
    || !(learningRate > 0) || !(l2 >= 0) || !(maxImportanceWeight >= 1)
    || !Number.isSafeInteger(minGroups) || minGroups < 3
    || !Number.isSafeInteger(minActionSamples) || minActionSamples < 1
    || !(minAdvantage >= 0)) {
    throw new TypeError('invalid tournament linear ensemble training options');
  }
  if (!rows.length) throw new RangeError('dataset has no rows for requested table');
  const byGroup = new Map();
  for (const row of rows) {
    const group = byGroup.get(row.sourceGroup) || [];
    group.push(row);
    byGroup.set(row.sourceGroup, group);
  }
  const models = [...byGroup].sort(([left], [right]) => left.localeCompare(right)).map(
    ([, groupRows]) => fitGroup(groupRows, {
      dimensions, epochs, learningRate, l2, maxImportanceWeight,
    }),
  );
  return Object.freeze({
    schema: TOURNAMENT_LINEAR_ENSEMBLE_SCHEMA,
    version: 1,
    mode: 'offline-evaluation-only',
    tableSize: Number(tableSize),
    actionKeys: [...LINEAR_ACTION_KEYS],
    dimensions,
    training: {
      rows: rows.length,
      sourceGroups: models.length,
      epochs,
      learningRate,
      l2,
      maxImportanceWeight,
      minGroups,
      minActionSamples,
      minAdvantage,
      estimator: 'trajectory-normalized-clipped-ips-independent-group-linear-ensemble',
      targets: ['normalized-final-rank', 'normalized-final-hp'],
      tablePartitioned: true,
    },
    models,
    provenance: {
      datasetSchema: dataset.schema,
      datasetSecretId: dataset.secretId,
      sourceNamespaceSha256: dataset.sourceNamespaceSha256,
    },
  });
}

export function validateTournamentLinearEnsemble(raw) {
  const width = Number(raw?.dimensions) * (LINEAR_ACTION_KEYS.length + 1);
  if (!raw || raw.schema !== TOURNAMENT_LINEAR_ENSEMBLE_SCHEMA || raw.version !== 1
    || raw.mode !== 'offline-evaluation-only' || ![6, 9].includes(Number(raw.tableSize))
    || JSON.stringify(raw.actionKeys) !== JSON.stringify(LINEAR_ACTION_KEYS)
    || !Number.isSafeInteger(Number(raw.dimensions)) || raw.dimensions < 32
    || !raw.training || !Array.isArray(raw.models) || !raw.models.length
    || raw.models.some((model) => !Array.isArray(model.rankWeights)
      || model.rankWeights.length !== width || !Array.isArray(model.hpWeights)
      || model.hpWeights.length !== width || !model.support)) {
    throw new TypeError('invalid tournament linear ensemble');
  }
  return raw;
}

function stats(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length < 2) return { mean, lower95: null, standardError: null };
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0)
    / (values.length - 1);
  const standardError = Math.sqrt(variance / values.length);
  const critical = T95[Math.min(30, values.length)] || 1.96;
  return { mean, lower95: mean - critical * standardError, standardError };
}

export function evaluateTournamentLinearEnsemble(modelOrArtifact, {
  informationSetKey,
  tableSize,
  baselineActionKey,
  legalActionKeys,
} = {}) {
  const model = validateTournamentLinearEnsemble(modelOrArtifact);
  const encoded = compactResidualFeatures(informationSetKey);
  if (!encoded || Number(tableSize) !== Number(model.tableSize)
    || !Array.isArray(legalActionKeys) || !legalActionKeys.includes(baselineActionKey)
    || !LINEAR_ACTION_KEYS.includes(baselineActionKey)) {
    return Object.freeze({ accepted: false, reason: 'invalid-or-unsupported-state' });
  }
  if (['fold', 'allin'].includes(baselineActionKey)) {
    return Object.freeze({ accepted: false, reason: 'baseline-extreme-protected' });
  }
  const vector = sparseFeatures(encoded, model.dimensions);
  const candidates = legalActionKeys.flatMap((actionKey) => {
    if (actionKey === baselineActionKey || ['fold', 'allin'].includes(actionKey)
      || !LINEAR_ACTION_KEYS.includes(actionKey)) return [];
    const baselineIndex = LINEAR_ACTION_KEYS.indexOf(baselineActionKey);
    const actionIndex = LINEAR_ACTION_KEYS.indexOf(actionKey);
    const estimates = model.models.flatMap((group) => {
      if (Number(group.support[baselineActionKey] || 0) < model.training.minActionSamples
        || Number(group.support[actionKey] || 0) < model.training.minActionSamples) return [];
      const rankBase = Math.max(-1, Math.min(1, predict(
        group.rankWeights, vector, baselineIndex, model.dimensions,
      )));
      const rankAction = Math.max(-1, Math.min(1, predict(
        group.rankWeights, vector, actionIndex, model.dimensions,
      )));
      const hpBase = Math.max(-1, Math.min(1, predict(
        group.hpWeights, vector, baselineIndex, model.dimensions,
      )));
      const hpAction = Math.max(-1, Math.min(1, predict(
        group.hpWeights, vector, actionIndex, model.dimensions,
      )));
      return [{ rank: rankAction - rankBase, hp: hpAction - hpBase }];
    });
    if (estimates.length < model.training.minGroups) return [];
    const rank = stats(estimates.map((estimate) => estimate.rank));
    const hp = stats(estimates.map((estimate) => estimate.hp));
    return [{ actionKey, groups: estimates.length, rank, hp,
      safetyLowerBound: Math.min(rank.lower95, hp.lower95) }];
  }).sort((left, right) => right.safetyLowerBound - left.safetyLowerBound
    || (right.rank.mean + right.hp.mean) - (left.rank.mean + left.hp.mean)
    || left.actionKey.localeCompare(right.actionKey));
  const selected = candidates[0] || null;
  const accepted = Boolean(selected && selected.rank.lower95 > model.training.minAdvantage
    && selected.hp.lower95 > model.training.minAdvantage);
  return Object.freeze({
    accepted,
    reason: accepted ? null : selected ? 'dual-advantage-lcb-not-positive' : 'support-insufficient',
    selected,
    candidates,
  });
}
