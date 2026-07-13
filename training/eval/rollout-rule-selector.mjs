import { createHash } from 'node:crypto';

import { compactResidualFeatures } from '../../js/game/blueprint-residual-policy.js';

export const ROLLOUT_RULE_SELECTOR_SCHEMA = 'qyj-rollout-rule-selector-v1';

const CANDIDATE_FEATURES = Object.freeze([
  's', 'n', 'a', 'ao', 'p', 'ip', 'cl', 'h', 'b', 'stk', 'spr', 'tc', 'r', 'rc',
]);
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function combinations(values, size, start = 0, prefix = [], output = []) {
  if (prefix.length === size) {
    output.push([...prefix]);
    return output;
  }
  for (let index = start; index <= values.length - (size - prefix.length); index++) {
    prefix.push(values[index]);
    combinations(values, size, index + 1, prefix, output);
    prefix.pop();
  }
  return output;
}

function validationGroup(record, informationSetKey) {
  const digest = createHash('sha256').update(informationSetKey).digest('hex');
  const groups = [...(record.sourceGroups || [])].sort();
  return groups.length ? groups[Number.parseInt(digest.slice(0, 8), 16) % groups.length] : digest;
}

function groupPartition(group) {
  return Number.parseInt(createHash('sha256').update(group).digest('hex').slice(0, 8), 16) % 4;
}

function ruleKey(row, features) {
  return JSON.stringify({
    tableSize: row.tableSize,
    baseActionKey: row.baseActionKey,
    actionKey: row.actionKey,
    values: Object.fromEntries(features.map((feature) => [feature, row.features[feature]])),
  });
}

function matchesRule(rule, row) {
  return rule.tableSize === row.tableSize && rule.baseActionKey === row.baseActionKey
    && rule.actionKey === row.actionKey
    && rule.features.every((feature) => rule.values[feature] === row.features[feature]);
}

function selectRule(rules, row) {
  return rules.filter((rule) => matchesRule(rule, row)).sort((left, right) => (
    right.trainPrecision - left.trainPrecision
    || right.trainMeanLowerBound - left.trainMeanLowerBound
    || right.independentGroups - left.independentGroups
    || right.features.length - left.features.length
    || left.ruleSha256.localeCompare(right.ruleSha256)
  ))[0] || null;
}

export function buildRolloutRuleSelector(guidances, {
  minActualLowerBound = 5,
  minTrainSamples = 4,
  minTrainGroups = 3,
  minTrainPrecision = 0.9,
  maxFeatures = 4,
  minValidationSelected = 3,
  minValidationPrecision = 0.75,
} = {}) {
  const sources = (Array.isArray(guidances) ? guidances : [guidances]);
  const rows = [];
  for (const source of sources) {
    if (source?.schema !== 'qyj-public-belief-rollout-guidance-v1'
      || source?.mode !== 'offline-evaluation-only') {
      throw new TypeError('unsupported rollout guidance for rule selector');
    }
    for (const [informationSetKey, record] of Object.entries(source.records || {})) {
      const encoded = compactResidualFeatures(informationSetKey);
      if (!encoded || !record.rollout) continue;
      const group = validationGroup(record, informationSetKey);
      for (const candidate of record.rollout.candidates || []) {
        const actualLowerBound = Number(candidate.lowerBound);
        rows.push({
          tableSize: Number(source.tableSize),
          baseActionKey: record.baseActionKey,
          actionKey: candidate.actionKey,
          features: encoded.features,
          validationGroup: group,
          actualLowerBound: Number.isFinite(actualLowerBound) ? actualLowerBound : -1e6,
          positive: Number.isFinite(actualLowerBound) && actualLowerBound >= minActualLowerBound,
        });
      }
    }
  }
  const trainingRows = rows.filter((row) => groupPartition(row.validationGroup) !== 0);
  const validationRows = rows.filter((row) => groupPartition(row.validationGroup) === 0);
  const rules = [];
  for (let size = 2; size <= maxFeatures; size++) {
    for (const features of combinations(CANDIDATE_FEATURES, size)) {
      const buckets = new Map();
      for (const row of trainingRows) {
        const key = ruleKey(row, features);
        const bucket = buckets.get(key) || { rows: [], groups: new Set() };
        bucket.rows.push(row);
        bucket.groups.add(row.validationGroup);
        buckets.set(key, bucket);
      }
      for (const [key, bucket] of buckets) {
        if (bucket.rows.length < minTrainSamples || bucket.groups.size < minTrainGroups) continue;
        const positives = bucket.rows.filter((row) => row.positive);
        const precision = positives.length / bucket.rows.length;
        const meanLowerBound = bucket.rows.reduce(
          (sum, row) => sum + row.actualLowerBound, 0,
        ) / bucket.rows.length;
        if (precision < minTrainPrecision || meanLowerBound < minActualLowerBound) continue;
        const parsed = JSON.parse(key);
        rules.push(Object.freeze({
          ruleSha256: createHash('sha256').update(`${features.join(',')}|${key}`).digest('hex'),
          tableSize: parsed.tableSize,
          baseActionKey: parsed.baseActionKey,
          actionKey: parsed.actionKey,
          features: Object.freeze([...features]),
          values: Object.freeze(parsed.values),
          trainSamples: bucket.rows.length,
          independentGroups: bucket.groups.size,
          trainPrecision: precision,
          trainMeanLowerBound: meanLowerBound,
        }));
      }
    }
  }
  const deduped = [...new Map(rules.sort((left, right) => (
    right.trainPrecision - left.trainPrecision
    || right.independentGroups - left.independentGroups
    || right.features.length - left.features.length
    || left.ruleSha256.localeCompare(right.ruleSha256)
  )).map((rule) => [JSON.stringify({
    tableSize: rule.tableSize,
    baseActionKey: rule.baseActionKey,
    actionKey: rule.actionKey,
    values: rule.values,
  }), rule])).values()];
  const selected = [];
  for (const row of validationRows) {
    const rule = selectRule(deduped, row);
    if (rule) selected.push({ row, rule });
  }
  const positives = selected.filter(({ row }) => row.positive);
  const precision = selected.length ? positives.length / selected.length : 0;
  const meanActualLowerBound = selected.length ? selected.reduce(
    (sum, { row }) => sum + row.actualLowerBound, 0,
  ) / selected.length : null;
  const validation = Object.freeze({
    method: 'source-group-hash-holdout-25-percent',
    trainingRows: trainingRows.length,
    validationRows: validationRows.length,
    rules: deduped.length,
    selected: selected.length,
    positivePrecision: precision,
    meanActualLowerBound,
    passed: deduped.length > 0 && selected.length >= minValidationSelected
      && precision >= minValidationPrecision && meanActualLowerBound > 0,
  });
  return Object.freeze({
    schema: ROLLOUT_RULE_SELECTOR_SCHEMA,
    version: 1,
    mode: 'offline-evaluation-only',
    guidanceSha256: Object.freeze(sources.map(sha).sort()),
    thresholds: Object.freeze({
      minActualLowerBound, minTrainSamples, minTrainGroups,
      minTrainPrecision, maxFeatures,
    }),
    rules: Object.freeze(deduped),
    validation,
    promotionEligible: false,
    promotionBlockers: Object.freeze([
      ...(validation.passed ? [] : ['rollout-rule-validation-failed']),
      'requires-real-engine-branch-calibration-and-fresh-league',
      'offline-evaluation-only',
    ]),
  });
}

export function validateRolloutRuleSelector(raw) {
  if (raw?.schema !== ROLLOUT_RULE_SELECTOR_SCHEMA || Number(raw?.version) !== 1
    || raw?.mode !== 'offline-evaluation-only' || !Array.isArray(raw?.rules)
    || raw?.validation?.passed !== true) {
    throw new TypeError('unsupported or unvalidated rollout rule selector');
  }
  return raw;
}

export function evaluateRolloutRuleSelector(selector, {
  informationSetKey,
  tableSize,
  baseActionKey,
  legalActionKeys,
} = {}) {
  const source = validateRolloutRuleSelector(selector);
  const encoded = compactResidualFeatures(informationSetKey);
  if (!encoded) return Object.freeze({ eligible: false, reason: 'invalid-information-set' });
  const legal = new Set(legalActionKeys || []);
  const matches = source.rules.filter((rule) => rule.tableSize === Number(tableSize)
    && rule.baseActionKey === baseActionKey && legal.has(rule.actionKey)
    && rule.features.every((feature) => rule.values[feature] === encoded.features[feature]));
  matches.sort((left, right) => right.trainPrecision - left.trainPrecision
    || right.trainMeanLowerBound - left.trainMeanLowerBound
    || right.independentGroups - left.independentGroups
    || right.features.length - left.features.length
    || left.ruleSha256.localeCompare(right.ruleSha256));
  const selected = matches[0];
  if (!selected) return Object.freeze({ eligible: false, reason: 'no-validated-rollout-rule' });
  return Object.freeze({
    eligible: true,
    reason: null,
    actionKey: selected.actionKey,
    ruleSha256: selected.ruleSha256,
    trainPrecision: selected.trainPrecision,
    trainMeanLowerBound: selected.trainMeanLowerBound,
    independentGroups: selected.independentGroups,
  });
}
