import {
  COMPACT_RESIDUAL_FEATURE_ORDER,
  compactResidualFeatures,
} from '../../js/game/blueprint-residual-policy.js';

export const TOURNAMENT_TRAJECTORY_DATASET_SCHEMA = 'qyj-tournament-trajectory-dataset-v1';
export const TOURNAMENT_TRAJECTORY_POLICY_SCHEMA = 'qyj-tournament-trajectory-policy-v1';

const LEGACY_LEVEL_FIELDS = Object.freeze({
  tactical: Object.freeze(['s', 'n', 'a', 'p', 'ip', 'h', 'b', 'stk', 'spr', 'tc', 'r', 'rr', 'jm']),
  strategic: Object.freeze(['s', 'n', 'a', 'p', 'h', 'b', 'stk', 'spr', 'tc', 'r']),
  coarse: Object.freeze(['s', 'n', 'a', 'p', 'h', 'b', 'tc', 'r']),
});
const PROPENSITY_LEVEL_FIELDS = Object.freeze({
  ...LEGACY_LEVEL_FIELDS,
  generalized: Object.freeze(['s', 'a', 'p', 'h', 'tc', 'r']),
  population: Object.freeze(['s', 'a', 'h', 'tc', 'r']),
  contextual: Object.freeze(['s', 'a', 'p', 'tc', 'r']),
  global: Object.freeze(['s', 'a', 'tc', 'r']),
});

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return number;
}

function signature(encoded, level, levelFields) {
  const fields = levelFields[level];
  if (!fields) throw new RangeError(`unsupported trajectory level ${level}`);
  return fields.map((field) => `${field}=${encoded.features[field]}`).join('|');
}

function groupStats(groupValues, samples, weightSum, weightSquaredSum) {
  const values = [...groupValues.values()];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1)
    : 0;
  return Object.freeze({
    samples,
    weightSum,
    effectiveSamples: weightSum ** 2 / Math.max(Number.EPSILON, weightSquaredSum),
    groups: values.length,
    mean,
    standardError: values.length > 1 ? Math.sqrt(variance / values.length) : 1,
  });
}

function validateDataset(raw) {
  if (!raw || raw.schema !== TOURNAMENT_TRAJECTORY_DATASET_SCHEMA
    || raw.version !== 1 || !Array.isArray(raw.rows) || !raw.rows.length) {
    throw new TypeError('invalid tournament trajectory dataset');
  }
  return raw.rows.map((row, index) => {
    const encoded = compactResidualFeatures(row?.informationSetKey);
    if (!encoded || typeof row?.sourceGroup !== 'string' || !row.sourceGroup
      || typeof row?.actionKey !== 'string' || !row.actionKey
      || !Array.isArray(row.legalActionKeys) || !row.legalActionKeys.includes(row.actionKey)) {
      throw new TypeError(`invalid tournament trajectory row ${index}`);
    }
    if (![6, 9].includes(Number(row.tableSize))) {
      throw new RangeError('trajectory tableSize must be 6 or 9');
    }
    const reward = finite(row.rankValue, `rows[${index}].rankValue`);
    if (reward < -1 || reward > 1) throw new RangeError('trajectory rankValue must be in -1..1');
    const hpReward = finite(row.hpValue, `rows[${index}].hpValue`);
    if (hpReward < -1 || hpReward > 1) throw new RangeError('trajectory hpValue must be in -1..1');
    const rawPropensity = row?.actionPropensity;
    const hasPropensity = rawPropensity != null;
    const propensity = hasPropensity ? finite(rawPropensity, `rows[${index}].actionPropensity`) : 1;
    if (!(propensity > 0 && propensity <= 1)) {
      throw new RangeError('trajectory actionPropensity must be in (0, 1]');
    }
    return Object.freeze({ ...row, encoded, reward, hpReward, propensity, hasPropensity });
  });
}

export function trainTournamentTrajectoryPolicy(dataset, {
  confidenceZ = 1.96,
  minGroups = 3,
  minSamples = 12,
  minAdvantage = 0,
  requirePropensity = false,
  rewardMode = 'rank',
} = {}) {
  const rows = validateDataset(dataset);
  const levelFields = requirePropensity ? PROPENSITY_LEVEL_FIELDS : LEGACY_LEVEL_FIELDS;
  const levelOrder = Object.keys(levelFields);
  if (!Number.isFinite(Number(confidenceZ)) || Number(confidenceZ) < 0
    || !Number.isSafeInteger(Number(minGroups)) || Number(minGroups) < 2
    || !Number.isSafeInteger(Number(minSamples)) || Number(minSamples) < 1
    || !Number.isFinite(Number(minAdvantage)) || typeof requirePropensity !== 'boolean'
    || !['rank', 'rank-hp'].includes(rewardMode)) {
    throw new TypeError('invalid tournament trajectory training options');
  }
  if (requirePropensity && rows.some((row) => !row.hasPropensity)) {
    throw new TypeError('propensity-corrected training requires actionPropensity on every row');
  }
  const buckets = new Map();
  for (const row of rows) {
    for (const level of levelOrder) {
      const encodedSignature = signature(row.encoded, level, levelFields);
      const key = `${row.tableSize}\n${row.encoded.mask}\n${level}\n${encodedSignature}`;
      let node = buckets.get(key);
      if (!node) {
        node = {
          tableSize: Number(row.tableSize), mask: row.encoded.mask, level,
          signature: encodedSignature, actions: new Map(),
        };
        buckets.set(key, node);
      }
      let action = node.actions.get(row.actionKey);
      if (!action) {
        action = { samples: 0, weightSum: 0, weightSquaredSum: 0, groups: new Map() };
        node.actions.set(row.actionKey, action);
      }
      const weight = requirePropensity ? 1 / row.propensity : 1;
      const reward = rewardMode === 'rank-hp'
        ? (row.reward + row.hpReward) / 2 : row.reward;
      action.samples++;
      action.weightSum += weight;
      action.weightSquaredSum += weight ** 2;
      const group = action.groups.get(row.sourceGroup)
        || { weightedReward: 0, weightSum: 0, count: 0 };
      group.weightedReward += reward * weight;
      group.weightSum += weight;
      group.count++;
      action.groups.set(row.sourceGroup, group);
    }
  }
  const heads = {};
  for (const node of buckets.values()) {
    const headKey = `${node.tableSize}:${node.mask}`;
    const head = heads[headKey] ||= {
      tableSize: node.tableSize,
      levels: Object.fromEntries(levelOrder.map((level) => [level, {}])),
    };
    const actions = {};
    for (const [actionKey, bucket] of [...node.actions].sort(([a], [b]) => a.localeCompare(b))) {
      const means = new Map([...bucket.groups].map(([group, value]) => [
        group, value.weightedReward / value.weightSum,
      ]));
      actions[actionKey] = groupStats(
        means, bucket.samples, bucket.weightSum, bucket.weightSquaredSum,
      );
    }
    head.levels[node.level][node.signature] = { actions };
  }
  return Object.freeze({
    schema: TOURNAMENT_TRAJECTORY_POLICY_SCHEMA,
    version: 1,
    mode: 'offline-evaluation-only',
    featureSchema: 'bp2-hierarchical-residual-features-v3',
    featureOrder: [...COMPACT_RESIDUAL_FEATURE_ORDER],
    levelFields,
    training: Object.freeze({
      rows: rows.length,
      sourceGroups: new Set(rows.map((row) => row.sourceGroup)).size,
      confidenceZ: Number(confidenceZ),
      minGroups: Number(minGroups),
      minSamples: Number(minSamples),
      minAdvantage: Number(minAdvantage),
      propensityCorrected: requirePropensity === true,
      tablePartitioned: true,
      target: rewardMode === 'rank-hp'
        ? 'complete-12-hand-equal-normalized-rank-hp'
        : 'complete-12-hand-normalized-final-rank',
      estimator: requirePropensity
        ? 'self-normalized-ips-within-independent-group-welch-lower-bound'
        : 'independent-seed-group-mean-welch-lower-bound',
    }),
    heads,
    provenance: Object.freeze({
      datasetSchema: dataset.schema,
      datasetVersion: dataset.version,
      datasetSecretId: dataset.secretId,
    }),
  });
}

export function validateTournamentTrajectoryPolicy(raw) {
  if (!raw || raw.schema !== TOURNAMENT_TRAJECTORY_POLICY_SCHEMA || raw.version !== 1
    || raw.mode !== 'offline-evaluation-only' || !raw.training || !raw.heads) {
    throw new TypeError('invalid tournament trajectory policy');
  }
  if (raw.featureSchema !== 'bp2-hierarchical-residual-features-v3'
    || JSON.stringify(raw.featureOrder) !== JSON.stringify(COMPACT_RESIDUAL_FEATURE_ORDER)
    || ![LEGACY_LEVEL_FIELDS, PROPENSITY_LEVEL_FIELDS].some(
      (fields) => JSON.stringify(raw.levelFields) === JSON.stringify(fields),
    )) {
    throw new RangeError('unsupported tournament trajectory feature contract');
  }
  return raw;
}

export function evaluateTournamentTrajectoryPolicy(modelOrArtifact, {
  informationSetKey,
  tableSize,
  baselineActionKey,
  legalActionKeys,
} = {}) {
  const model = validateTournamentTrajectoryPolicy(modelOrArtifact);
  const encoded = compactResidualFeatures(informationSetKey);
  if (!encoded || !Array.isArray(legalActionKeys) || !legalActionKeys.includes(baselineActionKey)) {
    return Object.freeze({ accepted: false, reason: 'invalid-or-unsupported-state' });
  }
  const normalizedTableSize = Number(tableSize);
  if (model.training.tablePartitioned && ![6, 9].includes(normalizedTableSize)) {
    return Object.freeze({ accepted: false, reason: 'invalid-table-size' });
  }
  const head = model.training.tablePartitioned
    ? model.heads[`${normalizedTableSize}:${encoded.mask}`]
    : model.heads[encoded.mask];
  if (!head) return Object.freeze({ accepted: false, reason: 'legal-mask-not-covered' });
  for (const level of Object.keys(model.levelFields)) {
    const node = head.levels?.[level]?.[signature(encoded, level, model.levelFields)];
    const baseline = node?.actions?.[baselineActionKey];
    if (!baseline || baseline.groups < model.training.minGroups
      || Number(baseline.effectiveSamples ?? baseline.samples) < model.training.minSamples) continue;
    const candidates = legalActionKeys.flatMap((actionKey) => {
      if (actionKey === baselineActionKey) return [];
      const action = node.actions?.[actionKey];
      if (!action || action.groups < model.training.minGroups
        || Number(action.effectiveSamples ?? action.samples) < model.training.minSamples) return [];
      const advantage = action.mean - baseline.mean;
      const standardError = Math.sqrt(
        action.standardError ** 2 + baseline.standardError ** 2,
      );
      return [Object.freeze({
        actionKey,
        advantage,
        lowerBound: advantage - model.training.confidenceZ * standardError,
        action,
        baseline,
      })];
    }).sort((left, right) => right.lowerBound - left.lowerBound
      || right.advantage - left.advantage || left.actionKey.localeCompare(right.actionKey));
    const selected = candidates[0] || null;
    if (selected && selected.lowerBound > model.training.minAdvantage) {
      return Object.freeze({ accepted: true, reason: null, level, selected, candidates });
    }
    return Object.freeze({
      accepted: false,
      reason: selected ? 'trajectory-advantage-lcb-not-positive' : 'alternative-action-not-supported',
      level,
      selected,
      candidates,
    });
  }
  return Object.freeze({ accepted: false, reason: 'independent-support-insufficient' });
}
