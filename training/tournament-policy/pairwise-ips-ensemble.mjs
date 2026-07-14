import { compactResidualFeatures } from '../../js/game/blueprint-residual-policy.js';
import { LINEAR_ACTION_KEYS } from './linear-ensemble-model.mjs';

export const TOURNAMENT_PAIRWISE_IPS_SCHEMA = 'qyj-tournament-pairwise-ips-ensemble-v1';
export const TOURNAMENT_PAIRWISE_JACKKNIFE_IPS_SCHEMA =
  'qyj-tournament-pairwise-jackknife-ips-v1';
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

function vector(encoded, dimensions) {
  const f = encoded.features;
  const tokens = [
    'bias', `mask=${encoded.mask}`,
    ...Object.entries(f).map(([key, value]) => `${key}=${value}`),
    `s+p=${f.s}|${f.p}`, `s+h=${f.s}|${f.h}`, `s+a=${f.s}|${f.a}`,
    `tc+r=${f.tc}|${f.r}`, `stk+spr=${f.stk}|${f.spr}`, `h+b=${f.h}|${f.b}`,
  ];
  const scale = 1 / Math.sqrt(tokens.length);
  const result = new Map();
  for (const token of tokens) {
    const index = token === 'bias' ? 0 : hash32(token) % dimensions;
    const sign = token === 'bias' || (hash32(token, 0x9e3779b9) & 1) === 0 ? 1 : -1;
    result.set(index, (result.get(index) || 0) + sign * scale);
  }
  return [...result].map(([index, value]) => ({ index, value }));
}

function dot(weights, features) {
  return features.reduce((sum, feature) => sum + weights[feature.index] * feature.value, 0);
}

function probability(actionKey, baselineActionKey, support, epsilon) {
  if (!support.includes(actionKey)) return 0;
  return epsilon / support.length + (actionKey === baselineActionKey ? 1 - epsilon : 0);
}

function validateRows(dataset, tableSize) {
  if (dataset?.schema !== 'qyj-tournament-trajectory-dataset-v1'
    || dataset.version !== 1 || !Array.isArray(dataset.rows)) {
    throw new TypeError('invalid pairwise IPS dataset');
  }
  return dataset.rows.flatMap((row, index) => {
    if (Number(row.tableSize) !== Number(tableSize)) return [];
    const encoded = compactResidualFeatures(row.informationSetKey);
    const epsilon = Number(row.behaviorEpsilon);
    const support = row.behaviorSupportActionKeys;
    const baseline = row.behaviorBaselineActionKey;
    if (!encoded || !LINEAR_ACTION_KEYS.includes(row.actionKey)
      || !LINEAR_ACTION_KEYS.includes(baseline) || !Array.isArray(support)
      || support.some((action) => !LINEAR_ACTION_KEYS.includes(action))
      || !(epsilon > 0 && epsilon < 1) || typeof row.sourceGroup !== 'string'
      || typeof row.trajectoryId !== 'string' || !Number.isFinite(Number(row.rankValue))
      || !Number.isFinite(Number(row.hpValue))) {
      throw new TypeError(`invalid pairwise IPS row ${index}`);
    }
    if (['fold', 'allin'].includes(baseline)
      || !support.includes(row.actionKey) || !support.includes(baseline)) return [];
    return [{ ...row, encoded, epsilon, support, baseline,
      rankReward: Number(row.rankValue), hpReward: Number(row.hpValue) }];
  });
}

function fitPair(samples, { dimensions, epochs, learningRate, l2 }) {
  const rankWeights = new Float64Array(dimensions);
  const hpWeights = new Float64Array(dimensions);
  const counts = new Map();
  for (const sample of samples) {
    counts.set(sample.trajectoryId, (counts.get(sample.trajectoryId) || 0) + 1);
  }
  const prepared = samples.map((sample) => ({
    ...sample,
    features: vector(sample.encoded, dimensions),
    rawWeight: 1 / counts.get(sample.trajectoryId),
  })).sort((left, right) => hash32(left.rowId) - hash32(right.rowId));
  const scale = prepared.length / prepared.reduce((sum, sample) => sum + sample.rawWeight, 0);
  for (let epoch = 0; epoch < epochs; epoch++) {
    const rate = learningRate / Math.sqrt(1 + epoch / 4);
    const start = (epoch * 997) % prepared.length;
    for (let offset = 0; offset < prepared.length; offset++) {
      const sample = prepared[(start + offset) % prepared.length];
      const weight = sample.rawWeight * scale;
      const rankError = Math.max(-8, Math.min(8, dot(rankWeights, sample.features)
        - sample.rankPseudo));
      const hpError = Math.max(-8, Math.min(8, dot(hpWeights, sample.features)
        - sample.hpPseudo));
      for (const feature of sample.features) {
        const gradient = weight * feature.value;
        rankWeights[feature.index] -= rate
          * (rankError * gradient + l2 * rankWeights[feature.index]);
        hpWeights[feature.index] -= rate
          * (hpError * gradient + l2 * hpWeights[feature.index]);
      }
    }
  }
  const serialize = (weights) => [...weights].map((value) => Math.round(value * 1e7) / 1e7);
  return {
    samples: samples.length,
    trajectories: counts.size,
    rankWeights: serialize(rankWeights),
    hpWeights: serialize(hpWeights),
  };
}

export function trainTournamentPairwiseIpsEnsemble(dataset, {
  tableSize = 6,
  dimensions = 128,
  epochs = 30,
  learningRate = 0.02,
  l2 = 0.001,
  maxPseudoOutcome = 8,
  minGroups = 8,
  minPairSamples = 12,
  minAdvantage = 0.005,
} = {}) {
  if (![6, 9].includes(Number(tableSize)) || !Number.isSafeInteger(dimensions)
    || dimensions < 32 || !Number.isSafeInteger(epochs) || epochs < 1
    || !(learningRate > 0) || !(l2 >= 0) || !(maxPseudoOutcome >= 1)
    || !Number.isSafeInteger(minGroups) || minGroups < 3
    || !Number.isSafeInteger(minPairSamples) || minPairSamples < 1
    || !(minAdvantage >= 0)) throw new TypeError('invalid pairwise IPS training options');
  const rows = validateRows(dataset, tableSize);
  if (!rows.length) throw new RangeError('no pairwise IPS rows for requested table');
  const byGroup = new Map();
  for (const row of rows) {
    const group = byGroup.get(row.sourceGroup) || new Map();
    if (!['fold', 'allin'].includes(row.baseline)) {
      const baselineProbability = probability(
        row.baseline, row.baseline, row.support, row.epsilon,
      );
      for (const actionKey of row.support) {
        if (actionKey === row.baseline || ['fold', 'allin'].includes(actionKey)) continue;
        const actionProbability = probability(actionKey, row.baseline, row.support, row.epsilon);
        const contrast = Number(row.actionKey === actionKey) / actionProbability
          - Number(row.actionKey === row.baseline) / baselineProbability;
        const pairKey = `${row.baseline}>${actionKey}`;
        const samples = group.get(pairKey) || [];
        samples.push({
          ...row,
          rankPseudo: Math.max(-maxPseudoOutcome, Math.min(
            maxPseudoOutcome, row.rankReward * contrast,
          )),
          hpPseudo: Math.max(-maxPseudoOutcome, Math.min(
            maxPseudoOutcome, row.hpReward * contrast,
          )),
        });
        group.set(pairKey, samples);
      }
    }
    byGroup.set(row.sourceGroup, group);
  }
  const models = [...byGroup].sort(([left], [right]) => left.localeCompare(right)).map(
    ([, pairs]) => ({
      pairs: Object.fromEntries([...pairs].sort(([left], [right]) => left.localeCompare(right))
        .map(([key, samples]) => [key, fitPair(samples, {
          dimensions, epochs, learningRate, l2,
        })])),
    }),
  );
  return {
    schema: TOURNAMENT_PAIRWISE_IPS_SCHEMA,
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
      maxPseudoOutcome,
      minGroups,
      minPairSamples,
      minAdvantage,
      estimator: 'trajectory-normalized-centered-pairwise-ips-independent-group-ensemble',
      targets: ['normalized-final-rank-contrast', 'normalized-final-hp-contrast'],
      tablePartitioned: true,
    },
    models,
    provenance: {
      datasetSchema: dataset.schema,
      datasetSecretId: dataset.secretId,
      sourceNamespaceSha256: dataset.sourceNamespaceSha256,
    },
  };
}

export function validateTournamentPairwiseIpsEnsemble(raw) {
  if (raw?.schema !== TOURNAMENT_PAIRWISE_IPS_SCHEMA || raw.version !== 1
    || raw.mode !== 'offline-evaluation-only' || ![6, 9].includes(Number(raw.tableSize))
    || JSON.stringify(raw.actionKeys) !== JSON.stringify(LINEAR_ACTION_KEYS)
    || !Number.isSafeInteger(Number(raw.dimensions)) || !raw.training
    || !Array.isArray(raw.models) || !raw.models.length
    || raw.models.some((model) => !model.pairs || Object.values(model.pairs).some(
      (pair) => !Array.isArray(pair.rankWeights)
        || pair.rankWeights.length !== raw.dimensions
        || !Array.isArray(pair.hpWeights) || pair.hpWeights.length !== raw.dimensions,
    ))) throw new TypeError('invalid tournament pairwise IPS ensemble');
  return raw;
}

function stats(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length < 2) return { mean, lower95: null };
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0)
    / (values.length - 1);
  const standardError = Math.sqrt(variance / values.length);
  return { mean, lower95: mean - (T95[Math.min(30, values.length)] || 1.96) * standardError };
}

export function evaluateTournamentPairwiseIpsEnsemble(modelOrArtifact, {
  informationSetKey, tableSize, baselineActionKey, legalActionKeys,
} = {}) {
  const model = validateTournamentPairwiseIpsEnsemble(modelOrArtifact);
  const encoded = compactResidualFeatures(informationSetKey);
  if (!encoded || Number(tableSize) !== Number(model.tableSize)
    || !Array.isArray(legalActionKeys) || !legalActionKeys.includes(baselineActionKey)
    || !LINEAR_ACTION_KEYS.includes(baselineActionKey)) {
    return { accepted: false, reason: 'invalid-or-unsupported-state' };
  }
  if (['fold', 'allin'].includes(baselineActionKey)) {
    return { accepted: false, reason: 'baseline-extreme-protected' };
  }
  const features = vector(encoded, model.dimensions);
  const candidates = legalActionKeys.flatMap((actionKey) => {
    if (actionKey === baselineActionKey || ['fold', 'allin'].includes(actionKey)) return [];
    const pairKey = `${baselineActionKey}>${actionKey}`;
    const estimates = model.models.flatMap((group) => {
      const pair = group.pairs[pairKey];
      if (!pair || pair.samples < model.training.minPairSamples) return [];
      return [{
        rank: Math.max(-2, Math.min(2, dot(pair.rankWeights, features))),
        hp: Math.max(-2, Math.min(2, dot(pair.hpWeights, features))),
      }];
    });
    if (estimates.length < model.training.minGroups) return [];
    const rank = stats(estimates.map((item) => item.rank));
    const hp = stats(estimates.map((item) => item.hp));
    return [{ actionKey, groups: estimates.length, rank, hp,
      safetyLowerBound: Math.min(rank.lower95, hp.lower95) }];
  }).sort((left, right) => right.safetyLowerBound - left.safetyLowerBound
    || left.actionKey.localeCompare(right.actionKey));
  const selected = candidates[0] || null;
  const accepted = Boolean(selected && selected.rank.lower95 > model.training.minAdvantage
    && selected.hp.lower95 > model.training.minAdvantage);
  return {
    accepted,
    reason: accepted ? null : selected ? 'dual-pairwise-lcb-not-positive' : 'support-insufficient',
    selected,
    candidates,
  };
}

function buildPairSamplesByGroup(rows, maxPseudoOutcome) {
  const byPair = new Map();
  for (const row of rows) {
    const baselineProbability = probability(
      row.baseline, row.baseline, row.support, row.epsilon,
    );
    for (const actionKey of row.support) {
      if (actionKey === row.baseline || ['fold', 'allin'].includes(actionKey)) continue;
      const actionProbability = probability(actionKey, row.baseline, row.support, row.epsilon);
      const contrast = Number(row.actionKey === actionKey) / actionProbability
        - Number(row.actionKey === row.baseline) / baselineProbability;
      const pairKey = `${row.baseline}>${actionKey}`;
      const byGroup = byPair.get(pairKey) || new Map();
      const samples = byGroup.get(row.sourceGroup) || [];
      samples.push({
        ...row,
        rankPseudo: Math.max(-maxPseudoOutcome, Math.min(
          maxPseudoOutcome, row.rankReward * contrast,
        )),
        hpPseudo: Math.max(-maxPseudoOutcome, Math.min(
          maxPseudoOutcome, row.hpReward * contrast,
        )),
      });
      byGroup.set(row.sourceGroup, samples);
      byPair.set(pairKey, byGroup);
    }
  }
  return byPair;
}

export function trainTournamentPairwiseJackknifeIps(dataset, {
  tableSize = 6,
  dimensions = 128,
  epochs = 30,
  learningRate = 0.02,
  l2 = 0.001,
  maxPseudoOutcome = 8,
  minGroups = 8,
  minPairSamples = 12,
  minAdvantage = 0.005,
} = {}) {
  if (![6, 9].includes(Number(tableSize)) || !Number.isSafeInteger(dimensions)
    || dimensions < 32 || !Number.isSafeInteger(epochs) || epochs < 1
    || !(learningRate > 0) || !(l2 >= 0) || !(maxPseudoOutcome >= 1)
    || !Number.isSafeInteger(minGroups) || minGroups < 3
    || !Number.isSafeInteger(minPairSamples) || minPairSamples < 1
    || !(minAdvantage >= 0)) throw new TypeError('invalid pairwise jackknife IPS options');
  const rows = validateRows(dataset, tableSize);
  if (!rows.length) throw new RangeError('no pairwise jackknife IPS rows for requested table');
  const fitOptions = { dimensions, epochs, learningRate, l2 };
  const pairs = Object.fromEntries([...buildPairSamplesByGroup(rows, maxPseudoOutcome)]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([pairKey, rawGroups]) => {
      const groups = [...rawGroups].filter(([, samples]) => samples.length >= minPairSamples)
        .sort(([left], [right]) => left.localeCompare(right));
      if (groups.length < minGroups) return [];
      const fullSamples = groups.flatMap(([, samples]) => samples);
      return [[pairKey, {
        groups: groups.length,
        samples: fullSamples.length,
        full: fitPair(fullSamples, fitOptions),
        deleteOne: groups.map(([omittedGroup]) => ({
          omittedGroup,
          model: fitPair(groups.flatMap(([group, samples]) => (
            group === omittedGroup ? [] : samples
          )), fitOptions),
        })),
      }]];
    }));
  if (!Object.keys(pairs).length) {
    throw new RangeError('no action pair meets pairwise jackknife group support');
  }
  return {
    schema: TOURNAMENT_PAIRWISE_JACKKNIFE_IPS_SCHEMA,
    version: 1,
    mode: 'offline-evaluation-only',
    tableSize: Number(tableSize),
    actionKeys: [...LINEAR_ACTION_KEYS],
    dimensions,
    training: {
      rows: rows.length,
      sourceGroups: new Set(rows.map((row) => row.sourceGroup)).size,
      epochs,
      learningRate,
      l2,
      maxPseudoOutcome,
      minGroups,
      minPairSamples,
      minAdvantage,
      estimator: 'trajectory-normalized-centered-pairwise-ips-cluster-delete-one-jackknife',
      targets: ['normalized-final-rank-contrast', 'normalized-final-hp-contrast'],
      tablePartitioned: true,
    },
    pairs,
    provenance: {
      datasetSchema: dataset.schema,
      datasetSecretId: dataset.secretId,
      sourceNamespaceSha256: dataset.sourceNamespaceSha256,
    },
  };
}

function validFittedPair(model, dimensions) {
  return model && Array.isArray(model.rankWeights) && model.rankWeights.length === dimensions
    && Array.isArray(model.hpWeights) && model.hpWeights.length === dimensions;
}

export function validateTournamentPairwiseJackknifeIps(raw) {
  if (raw?.schema !== TOURNAMENT_PAIRWISE_JACKKNIFE_IPS_SCHEMA || raw.version !== 1
    || raw.mode !== 'offline-evaluation-only' || ![6, 9].includes(Number(raw.tableSize))
    || JSON.stringify(raw.actionKeys) !== JSON.stringify(LINEAR_ACTION_KEYS)
    || !Number.isSafeInteger(Number(raw.dimensions)) || !raw.training
    || !raw.pairs || !Object.keys(raw.pairs).length
    || Object.values(raw.pairs).some((pair) => !Number.isSafeInteger(pair.groups)
      || pair.groups < raw.training.minGroups || !validFittedPair(pair.full, raw.dimensions)
      || !Array.isArray(pair.deleteOne) || pair.deleteOne.length !== pair.groups
      || pair.deleteOne.some((replicate) => typeof replicate.omittedGroup !== 'string'
        || !validFittedPair(replicate.model, raw.dimensions)))) {
    throw new TypeError('invalid tournament pairwise jackknife IPS model');
  }
  return raw;
}

function jackknifeStats(full, replicates) {
  const mean = replicates.reduce((sum, value) => sum + value, 0) / replicates.length;
  const sumSquares = replicates.reduce((sum, value) => sum + ((value - mean) ** 2), 0);
  const standardError = Math.sqrt(((replicates.length - 1) / replicates.length) * sumSquares);
  const critical = T95[Math.min(30, replicates.length - 1)] || 1.96;
  return { mean: full, lower95: full - critical * standardError, standardError };
}

export function evaluateTournamentPairwiseJackknifeIps(modelOrArtifact, {
  informationSetKey, tableSize, baselineActionKey, legalActionKeys,
} = {}) {
  const model = validateTournamentPairwiseJackknifeIps(modelOrArtifact);
  const encoded = compactResidualFeatures(informationSetKey);
  if (!encoded || Number(tableSize) !== Number(model.tableSize)
    || !Array.isArray(legalActionKeys) || !legalActionKeys.includes(baselineActionKey)
    || !LINEAR_ACTION_KEYS.includes(baselineActionKey)) {
    return { accepted: false, reason: 'invalid-or-unsupported-state' };
  }
  if (['fold', 'allin'].includes(baselineActionKey)) {
    return { accepted: false, reason: 'baseline-extreme-protected' };
  }
  const features = vector(encoded, model.dimensions);
  const bounded = (value) => Math.max(-2, Math.min(2, value));
  const candidates = legalActionKeys.flatMap((actionKey) => {
    if (actionKey === baselineActionKey || ['fold', 'allin'].includes(actionKey)) return [];
    const pair = model.pairs[`${baselineActionKey}>${actionKey}`];
    if (!pair || pair.groups < model.training.minGroups) return [];
    const rank = jackknifeStats(
      bounded(dot(pair.full.rankWeights, features)),
      pair.deleteOne.map((replicate) => bounded(dot(replicate.model.rankWeights, features))),
    );
    const hp = jackknifeStats(
      bounded(dot(pair.full.hpWeights, features)),
      pair.deleteOne.map((replicate) => bounded(dot(replicate.model.hpWeights, features))),
    );
    return [{ actionKey, groups: pair.groups, rank, hp,
      safetyLowerBound: Math.min(rank.lower95, hp.lower95) }];
  }).sort((left, right) => right.safetyLowerBound - left.safetyLowerBound
    || left.actionKey.localeCompare(right.actionKey));
  const selected = candidates[0] || null;
  const accepted = Boolean(selected && selected.rank.lower95 > model.training.minAdvantage
    && selected.hp.lower95 > model.training.minAdvantage);
  return {
    accepted,
    reason: accepted ? null : selected ? 'dual-jackknife-lcb-not-positive' : 'support-insufficient',
    selected,
    candidates,
  };
}
