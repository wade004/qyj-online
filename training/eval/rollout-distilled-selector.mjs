import { createHash } from 'node:crypto';

import {
  COMPACT_RESIDUAL_FEATURE_ORDER,
  compactResidualFeatures,
} from '../../js/game/blueprint-residual-policy.js';

export const ROLLOUT_DISTILLED_SELECTOR_SCHEMA = 'qyj-rollout-distilled-selector-v1';

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function validateGuidance(raw) {
  if (raw?.schema !== 'qyj-public-belief-rollout-guidance-v1'
    || Number(raw?.version) !== 1 || raw?.mode !== 'offline-evaluation-only'
    || ![6, 9].includes(Number(raw?.tableSize)) || !raw?.records) {
    throw new TypeError('unsupported public-belief rollout guidance');
  }
  return raw;
}

function estimateAction(roots, encoded, tableSize, baseActionKey, actionKey, thresholds) {
  const neighbors = [];
  for (const root of roots) {
    if (root.tableSize !== Number(tableSize) || root.baseActionKey !== baseActionKey
      || root.actionKey !== actionKey) continue;
    const matches = COMPACT_RESIDUAL_FEATURE_ORDER.reduce((sum, feature) => (
      sum + Number(root.features[feature] === encoded.features[feature])
    ), 0);
    const similarity = (matches + Number(root.mask === encoded.mask))
      / (COMPACT_RESIDUAL_FEATURE_ORDER.length + 1);
    if (similarity >= thresholds.minSimilarity) neighbors.push({ ...root, similarity });
  }
  neighbors.sort((left, right) => right.similarity - left.similarity
    || right.teacherLowerBound - left.teacherLowerBound
    || left.rootSha256.localeCompare(right.rootSha256));
  const selected = neighbors.slice(0, thresholds.neighborCount);
  if (selected.length < thresholds.minNeighbors) return null;
  const weighted = selected.map((root) => ({
    ...root,
    weight: (root.similarity ** 4) * Math.sqrt(Math.max(1, root.count)),
  }));
  const weight = weighted.reduce((sum, root) => sum + root.weight, 0);
  const mean = weighted.reduce(
    (sum, root) => sum + root.teacherLowerBound * root.weight, 0,
  ) / weight;
  const variance = weighted.reduce((sum, root) => (
    sum + root.weight * ((root.teacherLowerBound - mean) ** 2)
  ), 0) / weight;
  const predictedLowerBound = mean
    - thresholds.uncertaintyPenalty * Math.sqrt(variance / selected.length);
  return Object.freeze({
    actionKey,
    neighbors: selected.length,
    nearestSimilarity: selected[0].similarity,
    predictedMean: mean,
    predictedLowerBound,
  });
}

function evaluateEncoded(selector, encoded, { tableSize, baseActionKey, legalActionKeys }, roots) {
  const estimates = [...new Set(legalActionKeys)].filter((actionKey) => actionKey !== baseActionKey)
    .map((actionKey) => estimateAction(
      roots, encoded, tableSize, baseActionKey, actionKey, selector.thresholds,
    )).filter(Boolean)
    .sort((left, right) => right.predictedLowerBound - left.predictedLowerBound
      || right.predictedMean - left.predictedMean
      || left.actionKey.localeCompare(right.actionKey));
  const selected = estimates.find((estimate) => (
    estimate.predictedLowerBound >= selector.thresholds.minPredictedLowerBound
  ));
  return selected || null;
}

export function buildRolloutDistilledSelector(guidances, {
  minSimilarity = 0.5,
  neighborCount = 5,
  minNeighbors = 2,
  uncertaintyPenalty = 1.64,
  minPredictedLowerBound = 5,
  minValidationPrecision = 0.75,
  minValidationSelected = 3,
} = {}) {
  const sources = (Array.isArray(guidances) ? guidances : [guidances]).map(validateGuidance);
  const roots = [];
  const backgrounds = [];
  for (const source of sources) {
    for (const [informationSetKey, record] of Object.entries(source.records)) {
      const encoded = compactResidualFeatures(informationSetKey);
      if (!encoded || !record.rollout) continue;
      const rootSha256 = createHash('sha256').update(informationSetKey).digest('hex');
      const groups = [...(record.sourceGroups || [])].sort();
      const validationGroup = groups.length
        ? groups[Number.parseInt(rootSha256.slice(0, 8), 16) % groups.length] : rootSha256;
      backgrounds.push({
        informationSetKey,
        encoded,
        tableSize: Number(source.tableSize),
        baseActionKey: record.baseActionKey,
        legalActionKeys: record.legalActionKeys,
        rollout: record.rollout,
        validationGroup,
      });
      if (!record.rollout.accepted || !record.rollout.selected) continue;
      roots.push(Object.freeze({
        rootSha256,
        tableSize: Number(source.tableSize),
        mask: encoded.mask,
        features: Object.freeze({ ...encoded.features }),
        baseActionKey: record.baseActionKey,
        actionKey: record.rollout.actionKey,
        teacherMean: Number(record.rollout.selected.mean),
        teacherLowerBound: Number(record.rollout.selected.lowerBound),
        count: Number(record.count) || 1,
        validationGroup,
      }));
    }
  }
  roots.sort((left, right) => left.rootSha256.localeCompare(right.rootSha256));
  if (roots.length < minNeighbors + 1) throw new RangeError('insufficient rollout teacher roots');
  const selector = {
    schema: ROLLOUT_DISTILLED_SELECTOR_SCHEMA,
    version: 1,
    mode: 'offline-evaluation-only',
    guidanceSha256: sources.map(sha).sort(),
    thresholds: {
      minSimilarity, neighborCount, minNeighbors, uncertaintyPenalty,
      minPredictedLowerBound,
    },
    roots,
  };
  const rows = [];
  for (const background of backgrounds) {
    const trainingRoots = roots.filter((root) => root.validationGroup !== background.validationGroup);
    const selected = evaluateEncoded(selector, background.encoded, background, trainingRoots);
    if (!selected) continue;
    const actual = background.rollout.candidates.find(
      (candidate) => candidate.actionKey === selected.actionKey,
    );
    rows.push({
      selected,
      actualLowerBound: Number(actual?.lowerBound),
      positive: Number(actual?.lowerBound) >= minPredictedLowerBound,
      validationGroup: background.validationGroup,
    });
  }
  const positives = rows.filter((row) => row.positive);
  const precision = rows.length ? positives.length / rows.length : 0;
  const meanActualLowerBound = rows.length ? rows.reduce(
    (sum, row) => sum + (Number.isFinite(row.actualLowerBound) ? row.actualLowerBound : -1e6), 0,
  ) / rows.length : null;
  const sourceGroups = new Set(backgrounds.map((row) => row.validationGroup));
  const validation = Object.freeze({
    method: 'canonical-source-group-disjoint',
    backgrounds: backgrounds.length,
    roots: roots.length,
    sourceGroups: sourceGroups.size,
    selected: rows.length,
    positivePrecision: precision,
    meanActualLowerBound,
    passed: roots.length >= 12 && sourceGroups.size >= 4
      && rows.length >= minValidationSelected
      && precision >= minValidationPrecision && meanActualLowerBound > 0,
  });
  return Object.freeze({
    ...selector,
    roots: Object.freeze(roots),
    validation,
    promotionEligible: false,
    promotionBlockers: Object.freeze([
      ...(validation.passed ? [] : ['rollout-distillation-validation-failed']),
      'requires-real-engine-branch-calibration-and-fresh-league',
      'offline-evaluation-only',
    ]),
  });
}

export function validateRolloutDistilledSelector(raw) {
  if (raw?.schema !== ROLLOUT_DISTILLED_SELECTOR_SCHEMA || Number(raw?.version) !== 1
    || raw?.mode !== 'offline-evaluation-only' || !Array.isArray(raw?.roots)
    || !raw?.thresholds || raw?.validation?.passed !== true) {
    throw new TypeError('unsupported or unvalidated rollout distilled selector');
  }
  return raw;
}

export function evaluateRolloutDistilledSelector(selector, {
  informationSetKey,
  tableSize,
  baseActionKey,
  legalActionKeys,
} = {}) {
  const source = validateRolloutDistilledSelector(selector);
  const encoded = compactResidualFeatures(informationSetKey);
  if (!encoded) return Object.freeze({ eligible: false, reason: 'invalid-information-set' });
  const selected = evaluateEncoded(source, encoded, {
    tableSize, baseActionKey, legalActionKeys,
  }, source.roots);
  if (!selected) return Object.freeze({ eligible: false, reason: 'distilled-no-positive-action' });
  return Object.freeze({ eligible: true, reason: null, ...selected });
}
