import { compactResidualFeatures } from '../../js/game/blueprint-residual-policy.js';

export const TOURNAMENT_SEQUENCE_POLICY_SCHEMA = 'qyj-tournament-sequence-policy-v1';

const LEVEL_FIELDS = Object.freeze({
  tactical: Object.freeze(['s', 'a', 'p', 'h', 'tc', 'r']),
  contextual: Object.freeze(['s', 'a', 'p', 'tc', 'r']),
  global: Object.freeze(['s', 'a', 'tc', 'r']),
});

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return number;
}

function signature(encoded, level) {
  return LEVEL_FIELDS[level].map(
    (field) => `${field}=${encoded.features[field]}`,
  ).join('|');
}

function addSample(map, key, row, reward, weight) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = { samples: 0, weightSum: 0, weightSquaredSum: 0, groups: new Map() };
    map.set(key, bucket);
  }
  bucket.samples++;
  bucket.weightSum += weight;
  bucket.weightSquaredSum += weight ** 2;
  const group = bucket.groups.get(row.sourceGroup)
    || { weightedReward: 0, weightSum: 0 };
  group.weightedReward += reward * weight;
  group.weightSum += weight;
  bucket.groups.set(row.sourceGroup, group);
}

function addReachSample(map, actionKey, row, reached, weight) {
  let bucket = map.get(actionKey);
  if (!bucket) {
    bucket = { samples: 0, groups: new Map() };
    map.set(actionKey, bucket);
  }
  bucket.samples++;
  const group = bucket.groups.get(row.sourceGroup) || { startWeight: 0, reachedWeight: 0 };
  group.startWeight += weight;
  if (reached) group.reachedWeight += weight;
  bucket.groups.set(row.sourceGroup, group);
}

function reachStats(bucket) {
  const values = [...bucket.groups.values()].map(
    (group) => group.reachedWeight / group.startWeight,
  );
  return {
    samples: bucket.samples,
    groups: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

function stats(bucket) {
  const values = [...bucket.groups.values()].map(
    (group) => group.weightedReward / group.weightSum,
  );
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1)
    : 0;
  return {
    samples: bucket.samples,
    effectiveSamples: bucket.weightSum ** 2
      / Math.max(Number.EPSILON, bucket.weightSquaredSum),
    groups: values.length,
    mean,
    standardError: values.length > 1 ? Math.sqrt(variance / values.length) : 1,
  };
}

function validateRows(dataset) {
  if (!dataset || dataset.version !== 1 || !Array.isArray(dataset.rows) || !dataset.rows.length) {
    throw new TypeError('invalid tournament sequence dataset');
  }
  return dataset.rows.map((row, index) => {
    const encoded = compactResidualFeatures(row.informationSetKey);
    if (!encoded || ![6, 9].includes(Number(row.tableSize))
      || typeof row.trajectoryId !== 'string' || !row.trajectoryId
      || !Number.isSafeInteger(Number(row.playerDecisionIndex))
      || typeof row.sourceGroup !== 'string' || !row.sourceGroup
      || !Array.isArray(row.legalActionKeys) || !row.legalActionKeys.includes(row.actionKey)) {
      throw new TypeError(`invalid tournament sequence row ${index}`);
    }
    const propensity = finite(row.actionPropensity, `rows[${index}].actionPropensity`);
    const rank = finite(row.rankValue, `rows[${index}].rankValue`);
    const hp = finite(row.hpValue, `rows[${index}].hpValue`);
    if (!(propensity > 0 && propensity <= 1) || rank < -1 || rank > 1 || hp < -1 || hp > 1) {
      throw new RangeError('invalid tournament sequence probability or reward');
    }
    return { ...row, encoded, propensity, rankReward: rank, hpReward: hp };
  });
}

export function trainTournamentSequencePolicy(dataset, {
  minGroups = 3,
  minSamples = 12,
  minAdvantage = 0.02,
  confidenceZ = 0,
  maxImportanceWeight = 64,
  rewardMode = 'rank-hp',
  minReachRate = 0,
} = {}) {
  const rows = validateRows(dataset);
  if (!Number.isSafeInteger(Number(minGroups)) || minGroups < 2
    || !Number.isSafeInteger(Number(minSamples)) || minSamples < 1
    || !Number.isFinite(Number(minAdvantage)) || !Number.isFinite(Number(confidenceZ))
    || confidenceZ < 0 || !Number.isFinite(Number(maxImportanceWeight))
    || maxImportanceWeight < 1 || !['rank', 'rank-hp'].includes(rewardMode)) {
    throw new TypeError('invalid sequence training options');
  }
  if (!Number.isFinite(Number(minReachRate)) || minReachRate < 0 || minReachRate > 1) {
    throw new TypeError('invalid sequence minReachRate');
  }
  const trajectories = new Map();
  for (const row of rows) {
    const list = trajectories.get(row.trajectoryId) || [];
    list.push(row);
    trajectories.set(row.trajectoryId, list);
  }
  const nodes = new Map();
  let pairCount = 0;
  for (const trajectory of trajectories.values()) {
    trajectory.sort((left, right) => left.playerDecisionIndex - right.playerDecisionIndex);
    for (let index = 0; index < trajectory.length; index++) {
      const first = trajectory[index];
      const next = trajectory[index + 1];
      const reached = Boolean(next && first.round === next.round
        && first.tableSize === next.tableSize && first.sourceGroup === next.sourceGroup);
      const firstWeight = Math.min(maxImportanceWeight, 1 / first.propensity);
      const weight = reached
        ? Math.min(maxImportanceWeight, 1 / (first.propensity * next.propensity)) : null;
      const reward = rewardMode === 'rank'
        ? first.rankReward : (first.rankReward + first.hpReward) / 2;
      for (const level of Object.keys(LEVEL_FIELDS)) {
        const stateSignature = signature(first.encoded, level);
        const key = `${first.tableSize}\n${first.encoded.mask}\n${level}\n${stateSignature}`;
        let node = nodes.get(key);
        if (!node) {
          node = {
            tableSize: first.tableSize,
            mask: first.encoded.mask,
            level,
            signature: stateSignature,
            baselines: new Map(),
            options: new Map(),
            reach: new Map(),
          };
          nodes.set(key, node);
        }
        addReachSample(node.reach, first.actionKey, first, reached, firstWeight);
        if (!reached) continue;
        addSample(node.baselines, first.actionKey, first, reward, weight);
        addSample(node.options, `${first.actionKey}>${next.actionKey}`, first, reward, weight);
      }
      if (reached) pairCount++;
    }
  }
  const heads = {};
  for (const node of nodes.values()) {
    const headKey = `${node.tableSize}:${node.mask}`;
    const head = heads[headKey] ||= {
      tableSize: Number(node.tableSize),
      levels: Object.fromEntries(Object.keys(LEVEL_FIELDS).map((level) => [level, {}])),
    };
    head.levels[node.level][node.signature] = {
      baselines: Object.fromEntries([...node.baselines].sort().map(
        ([actionKey, bucket]) => [actionKey, stats(bucket)],
      )),
      options: Object.fromEntries([...node.options].sort().map(
        ([optionKey, bucket]) => [optionKey, stats(bucket)],
      )),
      reach: Object.fromEntries([...node.reach].sort().map(
        ([actionKey, bucket]) => [actionKey, reachStats(bucket)],
      )),
    };
  }
  return {
    schema: TOURNAMENT_SEQUENCE_POLICY_SCHEMA,
    version: 1,
    mode: 'offline-evaluation-only',
    levelFields: LEVEL_FIELDS,
    training: {
      rows: rows.length,
      trajectories: trajectories.size,
      pairs: pairCount,
      sourceGroups: new Set(rows.map((row) => row.sourceGroup)).size,
      minGroups: Number(minGroups),
      minSamples: Number(minSamples),
      minAdvantage: Number(minAdvantage),
      confidenceZ: Number(confidenceZ),
      maxImportanceWeight: Number(maxImportanceWeight),
      minReachRate: Number(minReachRate),
      target: rewardMode === 'rank'
        ? 'two-decision-option-normalized-final-rank'
        : 'two-decision-option-equal-normalized-rank-hp',
      estimator: 'clipped-joint-propensity-independent-group-option-value',
      tablePartitioned: true,
    },
    heads,
    provenance: {
      datasetSecretId: dataset.secretId,
      sourceNamespaceSha256: dataset.sourceNamespaceSha256,
    },
  };
}

export function validateTournamentSequencePolicy(raw) {
  if (!raw || raw.schema !== TOURNAMENT_SEQUENCE_POLICY_SCHEMA || raw.version !== 1
    || raw.mode !== 'offline-evaluation-only' || !raw.training || !raw.heads
    || JSON.stringify(raw.levelFields) !== JSON.stringify(LEVEL_FIELDS)) {
    throw new TypeError('invalid tournament sequence policy');
  }
  return raw;
}

export function evaluateTournamentSequencePolicy(modelOrArtifact, {
  informationSetKey,
  tableSize,
  baselineActionKey,
  legalActionKeys,
} = {}) {
  const model = validateTournamentSequencePolicy(modelOrArtifact);
  const encoded = compactResidualFeatures(informationSetKey);
  if (!encoded || ![6, 9].includes(Number(tableSize))
    || !Array.isArray(legalActionKeys) || !legalActionKeys.includes(baselineActionKey)) {
    return { accepted: false, reason: 'invalid-or-unsupported-state' };
  }
  const head = model.heads[`${Number(tableSize)}:${encoded.mask}`];
  if (!head) return { accepted: false, reason: 'legal-mask-not-covered' };
  for (const level of Object.keys(LEVEL_FIELDS)) {
    const node = head.levels?.[level]?.[signature(encoded, level)];
    const baseline = node?.baselines?.[baselineActionKey];
    if (!baseline || baseline.groups < model.training.minGroups
      || baseline.effectiveSamples < model.training.minSamples) continue;
    const candidates = Object.entries(node.options || {}).flatMap(([optionKey, option]) => {
      const separator = optionKey.indexOf('>');
      const firstActionKey = optionKey.slice(0, separator);
      const continuationActionKey = optionKey.slice(separator + 1);
      const reach = node.reach?.[firstActionKey];
      if (firstActionKey === baselineActionKey || !legalActionKeys.includes(firstActionKey)
        || option.groups < model.training.minGroups
        || option.effectiveSamples < model.training.minSamples
        || (model.training.minReachRate > 0 && (
          !reach || reach.groups < model.training.minGroups
          || reach.mean < model.training.minReachRate
        ))) return [];
      const advantage = option.mean - baseline.mean;
      const standardError = Math.sqrt(option.standardError ** 2 + baseline.standardError ** 2);
      return [{
        optionKey, firstActionKey, continuationActionKey, option, baseline, reach, advantage,
        lowerBound: advantage - model.training.confidenceZ * standardError,
      }];
    }).sort((left, right) => right.lowerBound - left.lowerBound
      || right.advantage - left.advantage || left.optionKey.localeCompare(right.optionKey));
    const selected = candidates[0] || null;
    if (selected && selected.lowerBound > model.training.minAdvantage) {
      return { accepted: true, reason: null, level, selected, candidates };
    }
    return {
      accepted: false,
      reason: selected ? 'sequence-advantage-not-cleared' : 'sequence-option-not-supported',
      level,
      selected,
      candidates,
    };
  }
  return { accepted: false, reason: 'sequence-independent-support-insufficient' };
}
