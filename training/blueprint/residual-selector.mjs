import { createHash } from 'node:crypto';

import {
  COMPACT_RESIDUAL_FEATURE_ORDER,
  compactResidualFeatures,
} from '../../js/game/blueprint-residual-policy.js';
import { validateResidualAdvantageGuidance } from './residual-advantage.mjs';

export const RESIDUAL_INTERVENTION_SELECTOR_SCHEMA = 'qyj-residual-intervention-selector-v1';
export const RESIDUAL_INTERVENTION_VALUE_SELECTOR_SCHEMA =
  'qyj-residual-intervention-value-selector-v2';
export const RESIDUAL_INTERVENTION_OPTION_SELECTOR_SCHEMA =
  'qyj-residual-intervention-option-selector-v3';
export const RESIDUAL_CONTINUATION_OPTION_SELECTOR_SCHEMA =
  'qyj-residual-continuation-option-selector-v4';
export const RESIDUAL_JOINT_CONTINUATION_OPTION_SELECTOR_SCHEMA =
  'qyj-residual-joint-continuation-option-selector-v5';
export const RESIDUAL_GENERALIZED_JOINT_OPTION_SELECTOR_SCHEMA =
  'qyj-residual-generalized-joint-option-selector-v6';
export const RESIDUAL_SUCCESSOR_AUGMENTED_OPTION_SELECTOR_SCHEMA =
  'qyj-residual-successor-augmented-option-selector-v7';
export const RESIDUAL_CUMULATIVE_SUCCESSOR_OPTION_SELECTOR_SCHEMA =
  'qyj-residual-cumulative-successor-option-selector-v8';
export const RESIDUAL_TRANSITION_CONDITIONED_OPTION_SELECTOR_SCHEMA =
  'qyj-residual-transition-conditioned-option-selector-v9';
export const RESIDUAL_JOINT_TRAJECTORY_OPTION_SELECTOR_SCHEMA =
  'qyj-residual-joint-trajectory-option-selector-v10';
export const RESIDUAL_EMPIRICAL_TRAJECTORY_OPTION_SELECTOR_SCHEMA =
  'qyj-residual-empirical-trajectory-option-selector-v11';

function sha(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function buildResidualInterventionSelector(guidances, {
  residualModelSha256,
  minSimilarity = 0.625,
  minAdvantageLowerBound = 0.01,
  maxFallbackFeatures = 3,
  minPolicyTV = 0.001,
} = {}) {
  if (!/^[0-9a-f]{64}$/i.test(String(residualModelSha256 || ''))) {
    throw new TypeError('selector requires residualModelSha256');
  }
  const sources = (Array.isArray(guidances) ? guidances : [guidances])
    .map(validateResidualAdvantageGuidance);
  const roots = [];
  for (const guidance of sources) {
    for (const [informationSetKey, record] of Object.entries(guidance.records || {})) {
      const encoded = compactResidualFeatures(informationSetKey);
      if (!encoded || !record.actionableActions?.length) continue;
      const maxLowerBound = Math.max(...record.actionableActions.map(
        (action) => Number(record.advantages[action]?.lowerBound) || 0,
      ));
      if (maxLowerBound < minAdvantageLowerBound) continue;
      roots.push({
        rootSha256: createHash('sha256').update(informationSetKey).digest('hex'),
        mask: encoded.mask,
        features: encoded.features,
        maxLowerBound,
        independentClusterCount: record.independentClusterCount,
      });
    }
  }
  if (!roots.length) throw new RangeError('selector has no positive-LCB roots');
  roots.sort((left, right) => left.rootSha256.localeCompare(right.rootSha256));
  return Object.freeze({
    schema: RESIDUAL_INTERVENTION_SELECTOR_SCHEMA,
    version: 1,
    mode: 'offline-evaluation-only',
    residualModelSha256: String(residualModelSha256).toLowerCase(),
    guidanceSha256: sources.map(sha).sort(),
    thresholds: {
      minSimilarity,
      minAdvantageLowerBound,
      maxFallbackFeatures,
      minPolicyTV,
    },
    roots,
    promotionEligible: false,
    promotionBlockers: [
      'selector-calibration-below-formal-scale',
      'offline-evaluation-only',
    ],
  });
}

function calibratedRootValue(record) {
  const values = Object.values(record?.advantages || {})
    .map((entry) => Number(entry?.lowerBound))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function boundedPositiveLcbPolicyDelta(record, {
  minActionShift = 0,
  maxPolicyTV = 1,
} = {}) {
  const actionKeys = record.actionKeys || [];
  const base = Object.fromEntries(actionKeys.map((action) => [
    action, Number(record.baseStrategy[action]) || 0,
  ]));
  const target = Object.fromEntries(actionKeys.map((action) => [
    action, Number(record.targetStrategy[action]) || 0,
  ]));
  const positive = (record.actionableActions || []).filter((action) => (
    actionKeys.includes(action) && Number(record.advantages?.[action]?.lowerBound) > 0
  )).sort((left, right) => (
    Number(record.advantages[right].lowerBound) - Number(record.advantages[left].lowerBound)
    || left.localeCompare(right)
  ));
  const best = positive[0];
  if (best && minActionShift > 0) {
    const desired = Math.min(1, Math.max(target[best], base[best] + minActionShift));
    const needed = desired - target[best];
    const donors = actionKeys.filter((action) => action !== best && target[action] > 0);
    const available = donors.reduce((sum, action) => sum + target[action], 0);
    const moved = Math.min(needed, available);
    if (moved > 0) {
      target[best] += moved;
      for (const action of donors) target[action] -= moved * target[action] / available;
    }
  }
  let delta = Object.fromEntries(actionKeys.map((action) => [action, target[action] - base[action]]));
  const tv = actionKeys.reduce((sum, action) => sum + Math.max(0, delta[action]), 0);
  if (tv > maxPolicyTV) {
    const scale = maxPolicyTV / tv;
    delta = Object.fromEntries(actionKeys.map((action) => [action, delta[action] * scale]));
  }
  return delta;
}

function valueEstimate(roots, encoded, {
  minSimilarity,
  neighborCount,
  minNeighbors,
  uncertaintyPenalty,
} = {}, featureOrder = COMPACT_RESIDUAL_FEATURE_ORDER) {
  const neighbors = [];
  for (const root of roots) {
    if (root.mask !== encoded.mask) continue;
    const matches = featureOrder.reduce((sum, feature) => (
      sum + Number(root.features[feature] === encoded.features[feature])
    ), 0);
    const similarity = matches / featureOrder.length;
    if (similarity < minSimilarity) continue;
    neighbors.push({ ...root, similarity });
  }
  neighbors.sort((left, right) => right.similarity - left.similarity
    || right.calibratedValue - left.calibratedValue
    || left.rootSha256.localeCompare(right.rootSha256));
  const selected = neighbors.slice(0, neighborCount);
  if (selected.length < minNeighbors) {
    return { accepted: false, reason: 'value-head-insufficient-neighbors', neighbors: selected.length };
  }
  const weighted = selected.map((root) => ({
    ...root,
    weight: (root.similarity ** 4) * Math.sqrt(Math.max(1, root.independentClusterCount)),
  }));
  const weight = weighted.reduce((sum, root) => sum + root.weight, 0);
  const mean = weighted.reduce((sum, root) => sum + root.weight * root.calibratedValue, 0) / weight;
  const variance = weighted.reduce((sum, root) => (
    sum + root.weight * ((root.calibratedValue - mean) ** 2)
  ), 0) / weight;
  const standardError = Math.sqrt(variance / selected.length);
  return {
    accepted: true,
    reason: null,
    neighbors: selected.length,
    nearestSimilarity: selected[0].similarity,
    predictedValue: mean,
    predictedLowerBound: mean - uncertaintyPenalty * standardError,
    weightedRoots: weighted,
  };
}

function transitionValueEstimate(roots, startEncoded, successorEncoded, thresholds,
  startFeatureOrder, successorFeatureOrder) {
  const neighbors = [];
  const featureCount = startFeatureOrder.length + successorFeatureOrder.length;
  for (const root of roots) {
    if (root.startMask !== startEncoded.mask || root.mask !== successorEncoded.mask) continue;
    const startMatches = startFeatureOrder.reduce((sum, feature) => (
      sum + Number(root.startFeatures[feature] === startEncoded.features[feature])
    ), 0);
    const successorMatches = successorFeatureOrder.reduce((sum, feature) => (
      sum + Number(root.features[feature] === successorEncoded.features[feature])
    ), 0);
    const similarity = (startMatches + successorMatches) / featureCount;
    if (similarity < thresholds.minSimilarity) continue;
    neighbors.push({ ...root, similarity });
  }
  neighbors.sort((left, right) => right.similarity - left.similarity
    || right.calibratedValue - left.calibratedValue
    || left.rootSha256.localeCompare(right.rootSha256));
  const selected = neighbors.slice(0, thresholds.neighborCount);
  if (selected.length < thresholds.minNeighbors) {
    return { accepted: false, reason: 'transition-head-insufficient-neighbors', neighbors: selected.length };
  }
  const weighted = selected.map((root) => ({
    ...root,
    weight: (root.similarity ** 4) * Math.sqrt(Math.max(1, root.independentClusterCount)),
  }));
  const weight = weighted.reduce((sum, root) => sum + root.weight, 0);
  const mean = weighted.reduce((sum, root) => sum + root.weight * root.calibratedValue, 0) / weight;
  const variance = weighted.reduce((sum, root) => (
    sum + root.weight * ((root.calibratedValue - mean) ** 2)
  ), 0) / weight;
  const standardError = Math.sqrt(variance / selected.length);
  return {
    accepted: true,
    reason: null,
    neighbors: selected.length,
    nearestSimilarity: selected[0].similarity,
    predictedValue: mean,
    predictedLowerBound: mean - thresholds.uncertaintyPenalty * standardError,
    weightedRoots: weighted,
  };
}

function transitionBucketSha256(startEncoded, successorEncoded,
  startFeatureOrder, successorFeatureOrder) {
  return createHash('sha256').update(JSON.stringify({
    startMask: startEncoded.mask,
    start: Object.fromEntries(startFeatureOrder.map((feature) => [
      feature, startEncoded.features[feature],
    ])),
    successorMask: successorEncoded.mask,
    successor: Object.fromEntries(successorFeatureOrder.map((feature) => [
      feature, successorEncoded.features[feature],
    ])),
  })).digest('hex');
}

export function buildResidualInterventionValueSelector(guidance, {
  residualModelSha256,
  tableSize,
  minSimilarity = 0.5,
  neighborCount = 8,
  minNeighbors = 4,
  uncertaintyPenalty = 1,
  minPredictedValue = 0.001,
  maxFallbackFeatures = 3,
  minPolicyTV = 0.001,
  bindPolicy = false,
  optionHorizon = 1,
  continuationMinPredictedValue = minPredictedValue,
} = {}) {
  if (!/^[0-9a-f]{64}$/i.test(String(residualModelSha256 || ''))) {
    throw new TypeError('value selector requires residualModelSha256');
  }
  if (!Number.isInteger(Number(tableSize)) || Number(tableSize) < 2 || Number(tableSize) > 9) {
    throw new RangeError('value selector requires tableSize 2..9');
  }
  if (!Number.isInteger(Number(optionHorizon)) || Number(optionHorizon) < 1
    || Number(optionHorizon) > 3) {
    throw new RangeError('optionHorizon must be 1..3');
  }
  if (!bindPolicy && Number(optionHorizon) !== 1) {
    throw new RangeError('multi-step option requires a bound policy');
  }
  const source = validateResidualAdvantageGuidance(guidance);
  const roots = [];
  for (const [informationSetKey, record] of Object.entries(source.records || {})) {
    const encoded = compactResidualFeatures(informationSetKey);
    const calibratedValue = calibratedRootValue(record);
    if (!encoded || !Number.isFinite(calibratedValue)) continue;
    roots.push({
      rootSha256: createHash('sha256').update(informationSetKey).digest('hex'),
      mask: encoded.mask,
      features: encoded.features,
      calibratedValue,
      independentClusterCount: Number(record.independentClusterCount) || 0,
      ...(bindPolicy ? {
        policyDelta: Object.fromEntries(record.actionKeys.map((action) => [
          action, Number(record.targetStrategy[action]) - Number(record.baseStrategy[action]),
        ])),
      } : {}),
    });
  }
  if (roots.length < minNeighbors + 1) throw new RangeError('value selector has insufficient roots');
  roots.sort((left, right) => left.rootSha256.localeCompare(right.rootSha256));
  const thresholds = {
    minSimilarity, neighborCount, minNeighbors, uncertaintyPenalty,
    minPredictedValue, maxFallbackFeatures, minPolicyTV,
    ...(Number(optionHorizon) > 1 ? { continuationMinPredictedValue } : {}),
  };
  const leaveOneOut = roots.map((root) => {
    const estimate = valueEstimate(roots.filter((candidate) => candidate !== root), {
      mask: root.mask,
      features: root.features,
    }, thresholds);
    return { actual: root.calibratedValue, ...estimate };
  });
  const scored = leaveOneOut.filter((row) => row.accepted);
  const selected = scored.filter((row) => row.predictedLowerBound >= minPredictedValue);
  const truePositive = selected.filter((row) => row.actual > 0).length;
  const continuation = bindPolicy && Number(optionHorizon) > 1;
  return Object.freeze({
    schema: continuation ? RESIDUAL_CONTINUATION_OPTION_SELECTOR_SCHEMA
      : bindPolicy ? RESIDUAL_INTERVENTION_OPTION_SELECTOR_SCHEMA
        : RESIDUAL_INTERVENTION_VALUE_SELECTOR_SCHEMA,
    version: continuation ? 4 : bindPolicy ? 3 : 2,
    mode: 'offline-evaluation-only',
    tableSize: Number(tableSize),
    ...(continuation ? { optionHorizon: Number(optionHorizon) } : {}),
    residualModelSha256: String(residualModelSha256).toLowerCase(),
    guidanceSha256: sha(source),
    thresholds,
    roots,
    validation: {
      method: 'leave-one-calibrated-root-out',
      roots: roots.length,
      scored: scored.length,
      selected: selected.length,
      positivePrecision: selected.length ? truePositive / selected.length : 0,
      falsePositiveRate: selected.length ? (selected.length - truePositive) / selected.length : 0,
      meanActualSelected: selected.length
        ? selected.reduce((sum, row) => sum + row.actual, 0) / selected.length : 0,
    },
    promotionEligible: false,
    promotionBlockers: [
      continuation ? 'continuation-option-calibration-below-formal-scale'
        : bindPolicy ? 'option-head-calibration-below-formal-scale'
        : 'value-head-calibration-below-formal-scale',
      'offline-evaluation-only',
    ],
  });
}

export function buildResidualInterventionOptionSelector(guidance, options = {}) {
  return buildResidualInterventionValueSelector(guidance, { ...options, bindPolicy: true });
}

export function buildResidualContinuationOptionSelector(guidance, options = {}) {
  return buildResidualInterventionValueSelector(guidance, {
    ...options,
    bindPolicy: true,
    optionHorizon: Number(options.optionHorizon),
  });
}

export function buildJointCalibratedContinuationOptionSelector(baseSelector, calibration, {
  minJointLowerBound = 0,
} = {}) {
  const base = validateResidualInterventionSelector(baseSelector);
  if (base.schema !== RESIDUAL_CONTINUATION_OPTION_SELECTOR_SCHEMA
    || calibration?.schema !== 'qyj-joint-continuation-option-calibration-v1'
    || Number(calibration?.version) !== 1
    || calibration.optionSelectorSha256 !== sha(base)) {
    throw new TypeError('joint selector requires calibration bound to one V4 selector');
  }
  const evidence = new Map(Object.entries(calibration.records || {}).map(([key, record]) => [
    createHash('sha256').update(key).digest('hex'), record,
  ]));
  const roots = base.roots.flatMap((root) => {
    const record = evidence.get(root.rootSha256);
    if (!record || Number(record.lowerBound) <= minJointLowerBound
      || Number(record.controlledDecisions) < 1) return [];
    return [{
      ...root,
      calibratedValue: Number(record.lowerBound),
      jointMeanAdvantage: Number(record.meanAdvantage),
      jointLowerBound: Number(record.lowerBound),
    }];
  });
  if (!roots.length) throw new RangeError('joint selector has no positive-LCB roots');
  return Object.freeze({
    ...base,
    schema: RESIDUAL_JOINT_CONTINUATION_OPTION_SELECTOR_SCHEMA,
    version: 5,
    jointCalibrationSha256: sha(calibration),
    thresholds: {
      ...base.thresholds,
      minSimilarity: 1,
      neighborCount: 1,
      minNeighbors: 1,
      minPredictedValue: minJointLowerBound,
      continuationMinPredictedValue: minJointLowerBound,
    },
    roots,
    promotionEligible: false,
    promotionBlockers: [
      'joint-option-root-coverage-below-formal-scale',
      'offline-evaluation-only',
    ],
  });
}

export function buildGeneralizedJointOptionSelector(baseSelector, calibration, baseDataset, {
  featureOrder,
  minSimilarity = 0.75,
  neighborCount = 5,
  minNeighbors = 3,
  uncertaintyPenalty = 1.64,
  minPredictedValue = 0,
  minPolicyTV = 0.001,
  minValidationPrecision = 0.75,
  minValidationSelected = 3,
} = {}) {
  const base = validateResidualInterventionSelector(baseSelector);
  if (base.schema !== RESIDUAL_CONTINUATION_OPTION_SELECTOR_SCHEMA
    || calibration?.schema !== 'qyj-joint-continuation-option-calibration-v1'
    || calibration.optionSelectorSha256 !== sha(base)
    || baseDataset?.schema !== 'qyj-compact-residual-base-rows-v1') {
    throw new TypeError('generalized joint selector inputs are not provenance-compatible');
  }
  const order = [...(featureOrder || [])];
  if (order.length < 1 || new Set(order).size !== order.length
    || order.some((feature) => !COMPACT_RESIDUAL_FEATURE_ORDER.includes(feature))) {
    throw new RangeError('featureOrder must contain unique residual features');
  }
  const groupsByKey = new Map();
  for (const row of baseDataset.rows || []) {
    const groups = groupsByKey.get(row.informationSetKey) || new Set();
    groups.add(row.sourceGroup);
    groupsByKey.set(row.informationSetKey, groups);
  }
  const baseRoots = new Map(base.roots.map((root) => [root.rootSha256, root]));
  const roots = [];
  for (const [key, record] of Object.entries(calibration.records || {})) {
    if (Number(record.controlledDecisions) < 1) continue;
    const rootSha256 = createHash('sha256').update(key).digest('hex');
    const root = baseRoots.get(rootSha256);
    const sourceGroups = [...(groupsByKey.get(key) || [])].sort();
    if (!root || !sourceGroups.length) continue;
    const groupIndex = Number.parseInt(rootSha256.slice(0, 8), 16) % sourceGroups.length;
    roots.push({
      ...root,
      calibratedValue: Number(record.lowerBound),
      jointMeanAdvantage: Number(record.meanAdvantage),
      jointLowerBound: Number(record.lowerBound),
      validationGroup: sourceGroups[groupIndex],
    });
  }
  roots.sort((left, right) => left.rootSha256.localeCompare(right.rootSha256));
  if (roots.length < minNeighbors + 1) throw new RangeError('insufficient joint roots');
  const thresholds = {
    ...base.thresholds,
    minSimilarity,
    neighborCount,
    minNeighbors,
    uncertaintyPenalty,
    minPredictedValue,
    continuationMinPredictedValue: minPredictedValue,
    minPolicyTV,
  };
  const validationRows = roots.map((root) => {
    const trainingRoots = roots.filter((candidate) => (
      candidate.validationGroup !== root.validationGroup
    ));
    const estimate = valueEstimate(trainingRoots, {
      mask: root.mask,
      features: root.features,
    }, thresholds, order);
    return { actual: root.jointLowerBound, group: root.validationGroup, ...estimate };
  });
  const scored = validationRows.filter((row) => row.accepted);
  const selected = scored.filter((row) => row.predictedLowerBound >= minPredictedValue);
  const positives = selected.filter((row) => row.actual > 0);
  const precision = selected.length ? positives.length / selected.length : 0;
  const sourceGroups = new Set(roots.map((root) => root.validationGroup));
  const meanActualSelected = selected.length
    ? selected.reduce((sum, row) => sum + row.actual, 0) / selected.length : 0;
  const validation = {
    method: 'canonical-source-group-disjoint',
    roots: roots.length,
    sourceGroups: sourceGroups.size,
    scored: scored.length,
    selected: selected.length,
    positivePrecision: precision,
    meanActualSelected,
    passed: roots.length >= 12 && sourceGroups.size >= 4
      && selected.length >= minValidationSelected
      && precision >= minValidationPrecision && meanActualSelected > 0,
  };
  return Object.freeze({
    ...base,
    schema: RESIDUAL_GENERALIZED_JOINT_OPTION_SELECTOR_SCHEMA,
    version: 6,
    featureOrder: order,
    jointCalibrationSha256: sha(calibration),
    thresholds,
    roots,
    validation,
    promotionEligible: false,
    promotionBlockers: [
      ...(validation.passed ? [] : ['joint-representation-validation-failed']),
      'generalized-joint-option-below-formal-scale',
      'offline-evaluation-only',
    ],
  });
}

export function buildSuccessorAugmentedOptionSelector(baseSelector, successorGuidance, {
  baseDataset = null,
  featureOrder,
  minSimilarity = 0.75,
  neighborCount = 3,
  minNeighbors = 1,
  uncertaintyPenalty = 1.64,
  minPredictedValue = 0,
  minPolicyTV = 0.001,
} = {}) {
  const base = validateResidualInterventionSelector(baseSelector);
  const guidance = validateResidualAdvantageGuidance(successorGuidance);
  if (base.schema !== RESIDUAL_GENERALIZED_JOINT_OPTION_SELECTOR_SCHEMA) {
    throw new TypeError('successor augmentation requires a V6 base selector');
  }
  const order = [...(featureOrder || base.featureOrder || [])];
  if (!order.length || order.some((feature) => !COMPACT_RESIDUAL_FEATURE_ORDER.includes(feature))) {
    throw new RangeError('invalid successor featureOrder');
  }
  const roots = [];
  const groupsByKey = new Map();
  for (const row of baseDataset?.rows || []) {
    const groups = groupsByKey.get(row.informationSetKey) || new Set();
    groups.add(row.sourceGroup);
    groupsByKey.set(row.informationSetKey, groups);
  }
  for (const [key, record] of Object.entries(guidance.records || {})) {
    const encoded = compactResidualFeatures(key);
    const calibratedValue = calibratedRootValue(record);
    if (!encoded || !Number.isFinite(calibratedValue)
      || (!baseDataset && calibratedValue <= minPredictedValue)) continue;
    const sourceGroups = [...(groupsByKey.get(key) || [])].sort();
    const rootSha256 = createHash('sha256').update(key).digest('hex');
    roots.push({
      rootSha256,
      mask: encoded.mask,
      features: encoded.features,
      calibratedValue,
      independentClusterCount: Number(record.independentClusterCount) || 0,
      policyDelta: Object.fromEntries(record.actionKeys.map((action) => [
        action, Number(record.targetStrategy[action]) - Number(record.baseStrategy[action]),
      ])),
      ...(sourceGroups.length ? {
        validationGroup: sourceGroups[
          Number.parseInt(rootSha256.slice(0, 8), 16) % sourceGroups.length
        ],
      } : {}),
    });
  }
  if (!roots.length) throw new RangeError('successor guidance has no positive roots');
  roots.sort((left, right) => left.rootSha256.localeCompare(right.rootSha256));
  let validation = null;
  if (baseDataset) {
    const thresholds = {
      minSimilarity, neighborCount, minNeighbors, uncertaintyPenalty,
      minPredictedValue, minPolicyTV,
    };
    const rows = roots.filter((root) => root.validationGroup).map((root) => ({
      actual: root.calibratedValue,
      ...valueEstimate(roots.filter((candidate) => (
        candidate.validationGroup && candidate.validationGroup !== root.validationGroup
      )), { mask: root.mask, features: root.features }, thresholds, order),
    }));
    const scored = rows.filter((row) => row.accepted);
    const selected = scored.filter((row) => row.predictedLowerBound >= minPredictedValue);
    const positives = selected.filter((row) => row.actual > 0);
    const meanActualSelected = selected.length
      ? selected.reduce((sum, row) => sum + row.actual, 0) / selected.length : 0;
    validation = {
      method: 'canonical-source-group-disjoint-successors',
      roots: roots.length,
      sourceGroups: new Set(roots.map((root) => root.validationGroup).filter(Boolean)).size,
      scored: scored.length,
      selected: selected.length,
      positivePrecision: selected.length ? positives.length / selected.length : 0,
      meanActualSelected,
    };
    validation.passed = validation.roots >= 12 && validation.sourceGroups >= 4
      && validation.selected >= 3 && validation.positivePrecision >= 0.75
      && validation.meanActualSelected > 0;
  }
  return Object.freeze({
    ...base,
    schema: validation ? RESIDUAL_CUMULATIVE_SUCCESSOR_OPTION_SELECTOR_SCHEMA
      : RESIDUAL_SUCCESSOR_AUGMENTED_OPTION_SELECTOR_SCHEMA,
    version: validation ? 8 : 7,
    successor: {
      guidanceSha256: sha(guidance),
      featureOrder: order,
      thresholds: {
        minSimilarity, neighborCount, minNeighbors, uncertaintyPenalty,
        minPredictedValue, minPolicyTV,
      },
      roots,
    },
    ...(validation ? { successorValidation: validation } : {}),
    promotionEligible: false,
    promotionBlockers: [
      ...(validation?.passed === false ? ['successor-representation-validation-failed'] : []),
      'successor-state-policy-below-formal-scale',
      'offline-evaluation-only',
    ],
  });
}

export function buildTransitionConditionedOptionSelector(baseSelector, successorGuidance,
  successorArtifacts, {
    startFeatureOrder,
    successorFeatureOrder,
    minSimilarity = 0.75,
    neighborCount = 3,
    minNeighbors = 1,
    uncertaintyPenalty = 1.64,
    minPredictedValue = 0,
    minPolicyTV = 0.001,
    minPositiveLcbActionShift = 0.01,
    maxTransitionPolicyTV = 0.05,
    minValidationPrecision = 0.75,
    minValidationSelected = 3,
  } = {}) {
  const base = validateResidualInterventionSelector(baseSelector);
  const guidance = validateResidualAdvantageGuidance(successorGuidance);
  if (base.schema !== RESIDUAL_GENERALIZED_JOINT_OPTION_SELECTOR_SCHEMA) {
    throw new TypeError('transition conditioning requires a V6 base selector');
  }
  const startOrder = [...(startFeatureOrder || base.featureOrder || [])];
  const successorOrder = [...(successorFeatureOrder || ['s'])];
  for (const [label, order] of [['start', startOrder], ['successor', successorOrder]]) {
    if (!order.length || new Set(order).size !== order.length
      || order.some((feature) => !COMPACT_RESIDUAL_FEATURE_ORDER.includes(feature))) {
      throw new RangeError(`invalid ${label} featureOrder`);
    }
  }
  const artifacts = Array.isArray(successorArtifacts) ? successorArtifacts : [successorArtifacts];
  if (!artifacts.length || artifacts.some((artifact) => (
    artifact?.schema !== 'qyj-residual-option-successors-v1'
    || Number(artifact?.version) !== 1 || !Array.isArray(artifact?.rows)
  ))) {
    throw new TypeError('transition conditioning requires successor artifacts');
  }
  const transitions = new Map();
  for (const artifact of artifacts) {
    for (const row of artifact.rows) {
      if (Number(row.tableSize) !== Number(base.tableSize)) continue;
      const identity = `${row.startInformationSetKey}\n${row.successorInformationSetKey}`;
      let transition = transitions.get(identity);
      if (!transition) {
        transition = { row, groups: new Set() };
        transitions.set(identity, transition);
      }
      transition.groups.add(row.sourceGroup);
    }
  }
  const roots = [];
  for (const [identity, transition] of transitions) {
    const { row } = transition;
    const record = guidance.records?.[row.successorInformationSetKey];
    const startEncoded = compactResidualFeatures(row.startInformationSetKey);
    const successorEncoded = compactResidualFeatures(row.successorInformationSetKey);
    const calibratedValue = calibratedRootValue(record);
    if (!record || !startEncoded || !successorEncoded || !Number.isFinite(calibratedValue)) continue;
    const rootSha256 = createHash('sha256').update(identity).digest('hex');
    const groups = [...transition.groups].sort();
    roots.push({
      rootSha256,
      startMask: startEncoded.mask,
      startFeatures: startEncoded.features,
      mask: successorEncoded.mask,
      features: successorEncoded.features,
      trajectoryBucketSha256: transitionBucketSha256(
        startEncoded, successorEncoded, startOrder, successorOrder,
      ),
      calibratedValue,
      independentClusterCount: Number(record.independentClusterCount) || 0,
      policyDelta: boundedPositiveLcbPolicyDelta(record, {
        minActionShift: minPositiveLcbActionShift,
        maxPolicyTV: maxTransitionPolicyTV,
      }),
      validationGroup: groups[Number.parseInt(rootSha256.slice(0, 8), 16) % groups.length],
    });
  }
  roots.sort((left, right) => left.rootSha256.localeCompare(right.rootSha256));
  if (roots.length < minNeighbors + 1) throw new RangeError('insufficient transition roots');
  const thresholds = {
    minSimilarity, neighborCount, minNeighbors, uncertaintyPenalty,
    minPredictedValue, minPolicyTV, minPositiveLcbActionShift, maxTransitionPolicyTV,
  };
  const rows = roots.map((root) => ({
    actual: root.calibratedValue,
    ...transitionValueEstimate(roots.filter((candidate) => (
      candidate.validationGroup !== root.validationGroup
    )), { mask: root.startMask, features: root.startFeatures }, {
      mask: root.mask, features: root.features,
    }, thresholds, startOrder, successorOrder),
  }));
  const scored = rows.filter((row) => row.accepted);
  const selected = scored.filter((row) => row.predictedLowerBound >= minPredictedValue);
  const positives = selected.filter((row) => row.actual > 0);
  const meanActualSelected = selected.length
    ? selected.reduce((sum, row) => sum + row.actual, 0) / selected.length : 0;
  const validation = {
    method: 'canonical-source-group-disjoint-transitions',
    roots: roots.length,
    sourceGroups: new Set(roots.map((root) => root.validationGroup)).size,
    scored: scored.length,
    selected: selected.length,
    positivePrecision: selected.length ? positives.length / selected.length : 0,
    meanActualSelected,
  };
  validation.passed = validation.roots >= 12 && validation.sourceGroups >= 4
    && validation.selected >= minValidationSelected
    && validation.positivePrecision >= minValidationPrecision
    && validation.meanActualSelected > 0;
  return Object.freeze({
    ...base,
    schema: RESIDUAL_TRANSITION_CONDITIONED_OPTION_SELECTOR_SCHEMA,
    version: 9,
    transition: {
      guidanceSha256: sha(guidance),
      successorArtifactSha256: artifacts.map(sha).sort(),
      startFeatureOrder: startOrder,
      successorFeatureOrder: successorOrder,
      thresholds,
      roots,
    },
    transitionValidation: validation,
    promotionEligible: false,
    promotionBlockers: [
      ...(validation.passed ? [] : ['transition-representation-validation-failed']),
      'transition-conditioned-policy-below-formal-scale',
      'offline-evaluation-only',
    ],
  });
}

export function buildJointTrajectoryOptionSelector(baseSelector, calibration, baseDataset, {
  featureOrder,
  minSimilarity = 0.75,
  neighborCount = 3,
  minNeighbors = 1,
  uncertaintyPenalty = 1.64,
  minPredictedValue = 0,
  minPolicyTV = 0.001,
  minValidationPrecision = 0.75,
  minValidationSelected = 3,
} = {}) {
  const base = validateResidualInterventionSelector(baseSelector);
  if (base.schema !== RESIDUAL_TRANSITION_CONDITIONED_OPTION_SELECTOR_SCHEMA
    || calibration?.schema !== 'qyj-joint-continuation-option-calibration-v1'
    || calibration.optionSelectorSha256 !== sha(base)
    || baseDataset?.schema !== 'qyj-compact-residual-base-rows-v1') {
    throw new TypeError('joint trajectory inputs are not provenance-compatible');
  }
  const order = [...(featureOrder || base.featureOrder || [])];
  if (!order.length || new Set(order).size !== order.length
    || order.some((feature) => !COMPACT_RESIDUAL_FEATURE_ORDER.includes(feature))) {
    throw new RangeError('invalid trajectory featureOrder');
  }
  const groupsByKey = new Map();
  for (const row of baseDataset.rows || []) {
    const groups = groupsByKey.get(row.informationSetKey) || new Set();
    groups.add(row.sourceGroup);
    groupsByKey.set(row.informationSetKey, groups);
  }
  const rootsByHash = new Map(base.roots.map((root) => [root.rootSha256, root]));
  const roots = [];
  for (const [key, record] of Object.entries(calibration.records || {})) {
    if (Number(record.controlledDecisions) < 1 || Number(record.horizonReached) < 1) continue;
    const rootSha256 = createHash('sha256').update(key).digest('hex');
    const root = rootsByHash.get(rootSha256);
    const groups = [...(groupsByKey.get(key) || [])].sort();
    if (!root || !groups.length || !Number.isFinite(Number(record.lowerBound))) continue;
    roots.push({
      ...root,
      calibratedValue: Number(record.lowerBound),
      jointMeanAdvantage: Number(record.meanAdvantage),
      jointLowerBound: Number(record.lowerBound),
      controlledDecisions: Number(record.controlledDecisions),
      horizonReached: Number(record.horizonReached),
      validationGroup: groups[Number.parseInt(rootSha256.slice(0, 8), 16) % groups.length],
    });
  }
  roots.sort((left, right) => left.rootSha256.localeCompare(right.rootSha256));
  if (roots.length < minNeighbors + 1) throw new RangeError('insufficient joint trajectory roots');
  const thresholds = {
    minSimilarity, neighborCount, minNeighbors, uncertaintyPenalty,
    minPredictedValue, minPolicyTV,
  };
  const rows = roots.map((root) => ({
    actual: root.jointLowerBound,
    ...valueEstimate(roots.filter((candidate) => (
      candidate.validationGroup !== root.validationGroup
    )), { mask: root.mask, features: root.features }, thresholds, order),
  }));
  const scored = rows.filter((row) => row.accepted);
  const selected = scored.filter((row) => row.predictedLowerBound >= minPredictedValue);
  const positives = selected.filter((row) => row.actual > 0);
  const meanActualSelected = selected.length
    ? selected.reduce((sum, row) => sum + row.actual, 0) / selected.length : 0;
  const validation = {
    method: 'canonical-source-group-disjoint-joint-trajectories',
    roots: roots.length,
    sourceGroups: new Set(roots.map((root) => root.validationGroup)).size,
    scored: scored.length,
    selected: selected.length,
    positivePrecision: selected.length ? positives.length / selected.length : 0,
    meanActualSelected,
  };
  validation.passed = validation.roots >= 12 && validation.sourceGroups >= 4
    && validation.selected >= minValidationSelected
    && validation.positivePrecision >= minValidationPrecision && meanActualSelected > 0;
  return Object.freeze({
    ...base,
    schema: RESIDUAL_JOINT_TRAJECTORY_OPTION_SELECTOR_SCHEMA,
    version: 10,
    trajectory: {
      calibrationSha256: sha(calibration),
      baseDatasetSha256: sha(baseDataset),
      featureOrder: order,
      thresholds,
      roots,
    },
    trajectoryValidation: validation,
    promotionEligible: false,
    promotionBlockers: [
      ...(validation.passed ? [] : ['joint-trajectory-validation-failed']),
      'joint-trajectory-policy-below-formal-scale',
      'offline-evaluation-only',
    ],
  });
}

export function buildEmpiricalTrajectoryOptionSelector(baseSelector, guidance, {
  gateMetric = 'both',
  minLowerBound = 0,
  minIndependentClusters = 4,
} = {}) {
  const base = validateResidualInterventionSelector(baseSelector);
  if (base.schema !== RESIDUAL_TRANSITION_CONDITIONED_OPTION_SELECTOR_SCHEMA
    || guidance?.schema !== 'qyj-empirical-trajectory-guidance-v1'
    || guidance.selectorSemanticSha256 !== sha(base)
    || !['rank', 'hp', 'both'].includes(gateMetric)) {
    throw new TypeError('empirical trajectory inputs are not provenance-compatible');
  }
  const evidence = guidance.records || {};
  const roots = base.transition.roots.flatMap((root) => {
    const record = evidence[root.trajectoryBucketSha256 || root.rootSha256];
    if (!record || Number(record.actionChanges) < 1
      || Number(record.independentClusterCount) < minIndependentClusters) return [];
    const rankPass = Number(record.rankLowerBound) > minLowerBound;
    const hpPass = Number(record.hpLowerBound) > minLowerBound;
    if (gateMetric === 'rank' ? !rankPass : gateMetric === 'hp' ? !hpPass : !rankPass || !hpPass) {
      return [];
    }
    return [{
      ...root,
      empiricalRankLowerBound: Number(record.rankLowerBound),
      empiricalHpLowerBound: Number(record.hpLowerBound),
      empiricalClusters: Number(record.independentClusterCount),
      empiricalActionChanges: Number(record.actionChanges),
    }];
  });
  if (!roots.length) throw new RangeError('empirical trajectory gate has no positive roots');
  const validation = {
    method: 'real-engine-paired-seed-cluster-outcomes',
    roots: roots.length,
    minIndependentClusters,
    minObservedClusters: Math.min(...roots.map((root) => root.empiricalClusters)),
    actionChanges: roots.reduce((sum, root) => sum + root.empiricalActionChanges, 0),
  };
  validation.passed = validation.roots >= 12
    && validation.minObservedClusters >= 8 && validation.actionChanges >= 12;
  return Object.freeze({
    ...base,
    schema: RESIDUAL_EMPIRICAL_TRAJECTORY_OPTION_SELECTOR_SCHEMA,
    version: 11,
    transition: {
      ...base.transition,
      roots,
      empiricalGuidanceSha256: sha(guidance),
      empiricalGate: { gateMetric, minLowerBound, minIndependentClusters },
    },
    empiricalTrajectoryValidation: validation,
    promotionEligible: false,
    promotionBlockers: [
      ...(validation.passed ? [] : ['empirical-trajectory-validation-failed']),
      'empirical-trajectory-policy-below-formal-scale',
      'offline-evaluation-only',
    ],
  });
}

function optionDistribution(weightedRoots, baseDistribution) {
  if (!Array.isArray(baseDistribution) || !baseDistribution.length) return null;
  const actionKeys = baseDistribution.map((entry) => entry.actionKey);
  const weight = weightedRoots.reduce((sum, root) => sum + root.weight, 0);
  const raw = actionKeys.map((actionKey, index) => {
    const delta = weightedRoots.reduce((sum, root) => (
      sum + root.weight * (Number(root.policyDelta?.[actionKey]) || 0)
    ), 0) / weight;
    return Math.max(0, Number(baseDistribution[index].probability) + delta);
  });
  const total = raw.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return null;
  const distribution = Object.freeze(actionKeys.map((actionKey, index) => Object.freeze({
    actionKey,
    probability: raw[index] / total,
  })));
  const policyTV = distribution.reduce((sum, entry, index) => (
    sum + Math.abs(entry.probability - Number(baseDistribution[index].probability))
  ), 0) / 2;
  return Object.freeze({ distribution, policyTV });
}

export function validateResidualInterventionSelector(raw, { residualModelSha256 } = {}) {
  const legacy = raw?.schema === RESIDUAL_INTERVENTION_SELECTOR_SCHEMA
    && Number(raw?.version) === 1;
  const valueHead = raw?.schema === RESIDUAL_INTERVENTION_VALUE_SELECTOR_SCHEMA
    && Number(raw?.version) === 2 && Number.isInteger(Number(raw?.tableSize));
  const optionHead = raw?.schema === RESIDUAL_INTERVENTION_OPTION_SELECTOR_SCHEMA
    && Number(raw?.version) === 3 && Number.isInteger(Number(raw?.tableSize));
  const continuationHead = raw?.schema === RESIDUAL_CONTINUATION_OPTION_SELECTOR_SCHEMA
    && Number(raw?.version) === 4 && Number.isInteger(Number(raw?.tableSize))
    && Number.isInteger(Number(raw?.optionHorizon))
    && Number(raw.optionHorizon) >= 2 && Number(raw.optionHorizon) <= 3;
  const jointHead = raw?.schema === RESIDUAL_JOINT_CONTINUATION_OPTION_SELECTOR_SCHEMA
    && Number(raw?.version) === 5 && Number.isInteger(Number(raw?.tableSize))
    && Number.isInteger(Number(raw?.optionHorizon));
  const generalizedJointHead = raw?.schema === RESIDUAL_GENERALIZED_JOINT_OPTION_SELECTOR_SCHEMA
    && Number(raw?.version) === 6 && Array.isArray(raw?.featureOrder)
    && Number.isInteger(Number(raw?.optionHorizon));
  const successorHead = raw?.schema === RESIDUAL_SUCCESSOR_AUGMENTED_OPTION_SELECTOR_SCHEMA
    && Number(raw?.version) === 7 && Array.isArray(raw?.successor?.roots)
    && Number.isInteger(Number(raw?.optionHorizon));
  const cumulativeSuccessorHead = raw?.schema === RESIDUAL_CUMULATIVE_SUCCESSOR_OPTION_SELECTOR_SCHEMA
    && Number(raw?.version) === 8 && Array.isArray(raw?.successor?.roots)
    && Number.isInteger(Number(raw?.optionHorizon));
  const transitionHead = raw?.schema === RESIDUAL_TRANSITION_CONDITIONED_OPTION_SELECTOR_SCHEMA
    && Number(raw?.version) === 9 && Array.isArray(raw?.transition?.roots)
    && Array.isArray(raw?.transition?.startFeatureOrder)
    && Array.isArray(raw?.transition?.successorFeatureOrder)
    && Number.isInteger(Number(raw?.optionHorizon));
  const trajectoryHead = raw?.schema === RESIDUAL_JOINT_TRAJECTORY_OPTION_SELECTOR_SCHEMA
    && Number(raw?.version) === 10 && Array.isArray(raw?.trajectory?.roots)
    && Array.isArray(raw?.transition?.roots) && Number.isInteger(Number(raw?.optionHorizon));
  const empiricalTrajectoryHead = raw?.schema === RESIDUAL_EMPIRICAL_TRAJECTORY_OPTION_SELECTOR_SCHEMA
    && Number(raw?.version) === 11 && Array.isArray(raw?.transition?.roots)
    && Number.isInteger(Number(raw?.optionHorizon));
  if ((!legacy && !valueHead && !optionHead && !continuationHead && !jointHead
    && !generalizedJointHead && !successorHead && !cumulativeSuccessorHead && !transitionHead
    && !trajectoryHead && !empiricalTrajectoryHead)
    || raw?.mode !== 'offline-evaluation-only') {
    throw new TypeError('unsupported residual intervention selector');
  }
  if (residualModelSha256
    && raw.residualModelSha256 !== String(residualModelSha256).toLowerCase()) {
    throw new RangeError('selector residual model SHA mismatch');
  }
  return raw;
}

export function evaluateResidualInterventionSelector(selector, {
  informationSetKey,
  startInformationSetKey = null,
  prediction,
  tableSize,
  continuation = false,
} = {}) {
  if (!prediction?.accepted) return Object.freeze({ eligible: false, reason: 'prediction-rejected' });
  const encoded = compactResidualFeatures(informationSetKey);
  if (!encoded) return Object.freeze({ eligible: false, reason: 'invalid-information-set' });
  if (prediction.fallbackFeatureCount > selector.thresholds.maxFallbackFeatures) {
    return Object.freeze({ eligible: false, reason: 'fallback-limit' });
  }
  if (![RESIDUAL_INTERVENTION_OPTION_SELECTOR_SCHEMA,
    RESIDUAL_CONTINUATION_OPTION_SELECTOR_SCHEMA,
    RESIDUAL_JOINT_CONTINUATION_OPTION_SELECTOR_SCHEMA,
    RESIDUAL_GENERALIZED_JOINT_OPTION_SELECTOR_SCHEMA,
    RESIDUAL_SUCCESSOR_AUGMENTED_OPTION_SELECTOR_SCHEMA,
    RESIDUAL_CUMULATIVE_SUCCESSOR_OPTION_SELECTOR_SCHEMA,
    RESIDUAL_TRANSITION_CONDITIONED_OPTION_SELECTOR_SCHEMA,
    RESIDUAL_JOINT_TRAJECTORY_OPTION_SELECTOR_SCHEMA,
    RESIDUAL_EMPIRICAL_TRAJECTORY_OPTION_SELECTOR_SCHEMA].includes(selector.schema)
    && prediction.shadowTV < selector.thresholds.minPolicyTV) {
    return Object.freeze({ eligible: false, reason: 'policy-tv-below-threshold' });
  }
  if ([RESIDUAL_INTERVENTION_VALUE_SELECTOR_SCHEMA,
    RESIDUAL_INTERVENTION_OPTION_SELECTOR_SCHEMA,
    RESIDUAL_CONTINUATION_OPTION_SELECTOR_SCHEMA,
    RESIDUAL_JOINT_CONTINUATION_OPTION_SELECTOR_SCHEMA,
    RESIDUAL_GENERALIZED_JOINT_OPTION_SELECTOR_SCHEMA,
    RESIDUAL_SUCCESSOR_AUGMENTED_OPTION_SELECTOR_SCHEMA,
    RESIDUAL_CUMULATIVE_SUCCESSOR_OPTION_SELECTOR_SCHEMA,
    RESIDUAL_TRANSITION_CONDITIONED_OPTION_SELECTOR_SCHEMA,
    RESIDUAL_JOINT_TRAJECTORY_OPTION_SELECTOR_SCHEMA,
    RESIDUAL_EMPIRICAL_TRAJECTORY_OPTION_SELECTOR_SCHEMA].includes(selector.schema)) {
    if (Number(tableSize) !== selector.tableSize) {
      return Object.freeze({ eligible: false, reason: 'value-head-table-mismatch' });
    }
    if (continuation && [RESIDUAL_SUCCESSOR_AUGMENTED_OPTION_SELECTOR_SCHEMA,
      RESIDUAL_CUMULATIVE_SUCCESSOR_OPTION_SELECTOR_SCHEMA].includes(selector.schema)) {
      const estimate = valueEstimate(
        selector.successor.roots, encoded, selector.successor.thresholds,
        selector.successor.featureOrder,
      );
      if (!estimate.accepted) return Object.freeze({ eligible: false, ...estimate });
      const { weightedRoots, ...publicEstimate } = estimate;
      if (estimate.predictedLowerBound < selector.successor.thresholds.minPredictedValue) {
        return Object.freeze({
          ...publicEstimate, eligible: false, reason: 'successor-value-below-threshold',
        });
      }
      const option = optionDistribution(weightedRoots, prediction.baseDistribution);
      if (!option || option.policyTV < selector.successor.thresholds.minPolicyTV) {
        return Object.freeze({
          ...publicEstimate, eligible: false, reason: 'successor-policy-tv-below-threshold',
          policyTV: option?.policyTV || 0,
        });
      }
      return Object.freeze({
        eligible: true, reason: null, continuation: true, successor: true,
        ...publicEstimate, ...option,
      });
    }
    if (continuation && [RESIDUAL_TRANSITION_CONDITIONED_OPTION_SELECTOR_SCHEMA,
      RESIDUAL_JOINT_TRAJECTORY_OPTION_SELECTOR_SCHEMA,
      RESIDUAL_EMPIRICAL_TRAJECTORY_OPTION_SELECTOR_SCHEMA].includes(selector.schema)) {
      const startEncoded = compactResidualFeatures(startInformationSetKey);
      if (!startEncoded) {
        return Object.freeze({ eligible: false, reason: 'transition-start-unavailable' });
      }
      const trajectoryBucket = transitionBucketSha256(
        startEncoded, encoded, selector.transition.startFeatureOrder,
        selector.transition.successorFeatureOrder,
      );
      const estimate = transitionValueEstimate(
        selector.transition.roots, startEncoded, encoded, selector.transition.thresholds,
        selector.transition.startFeatureOrder, selector.transition.successorFeatureOrder,
      );
      if (!estimate.accepted) return Object.freeze({
        eligible: false, trajectoryBucketSha256: trajectoryBucket, ...estimate,
      });
      const { weightedRoots, ...publicEstimate } = estimate;
      if (estimate.predictedLowerBound < selector.transition.thresholds.minPredictedValue) {
        return Object.freeze({
          ...publicEstimate, trajectoryBucketSha256: trajectoryBucket,
          eligible: false, reason: 'transition-value-below-threshold',
        });
      }
      const option = optionDistribution(weightedRoots, prediction.baseDistribution);
      if (!option || option.policyTV < selector.transition.thresholds.minPolicyTV) {
        return Object.freeze({
          ...publicEstimate, trajectoryBucketSha256: trajectoryBucket,
          eligible: false, reason: 'transition-policy-tv-below-threshold',
          policyTV: option?.policyTV || 0,
        });
      }
      return Object.freeze({
        eligible: true, reason: null, continuation: true, successor: true,
        transitionConditioned: true, trajectoryBucketSha256: trajectoryBucket,
        ...publicEstimate, ...option,
      });
    }
    if (!continuation && selector.schema === RESIDUAL_JOINT_TRAJECTORY_OPTION_SELECTOR_SCHEMA) {
      const estimate = valueEstimate(
        selector.trajectory.roots, encoded, selector.trajectory.thresholds,
        selector.trajectory.featureOrder,
      );
      if (!estimate.accepted) return Object.freeze({ eligible: false, ...estimate });
      const { weightedRoots, ...publicEstimate } = estimate;
      if (estimate.predictedLowerBound < selector.trajectory.thresholds.minPredictedValue) {
        return Object.freeze({
          ...publicEstimate, eligible: false, reason: 'joint-trajectory-value-below-threshold',
        });
      }
      const option = optionDistribution(weightedRoots, prediction.baseDistribution);
      if (!option || option.policyTV < selector.trajectory.thresholds.minPolicyTV) {
        return Object.freeze({
          ...publicEstimate, eligible: false, reason: 'joint-trajectory-policy-tv-below-threshold',
          policyTV: option?.policyTV || 0,
        });
      }
      return Object.freeze({
        eligible: true, reason: null, continuation: false, jointTrajectory: true,
        ...publicEstimate, ...option,
      });
    }
    const estimate = valueEstimate(
      selector.roots, encoded, selector.thresholds,
      selector.featureOrder || COMPACT_RESIDUAL_FEATURE_ORDER,
    );
    if (!estimate.accepted) return Object.freeze({ eligible: false, ...estimate });
    const { weightedRoots, ...publicEstimate } = estimate;
    const minPredictedValue = continuation
      ? Number(selector.thresholds.continuationMinPredictedValue)
      : Number(selector.thresholds.minPredictedValue);
    if (continuation && ![RESIDUAL_CONTINUATION_OPTION_SELECTOR_SCHEMA,
      RESIDUAL_JOINT_CONTINUATION_OPTION_SELECTOR_SCHEMA,
      RESIDUAL_GENERALIZED_JOINT_OPTION_SELECTOR_SCHEMA,
      RESIDUAL_SUCCESSOR_AUGMENTED_OPTION_SELECTOR_SCHEMA,
      RESIDUAL_CUMULATIVE_SUCCESSOR_OPTION_SELECTOR_SCHEMA,
      RESIDUAL_TRANSITION_CONDITIONED_OPTION_SELECTOR_SCHEMA,
      RESIDUAL_JOINT_TRAJECTORY_OPTION_SELECTOR_SCHEMA,
      RESIDUAL_EMPIRICAL_TRAJECTORY_OPTION_SELECTOR_SCHEMA].includes(selector.schema)) {
      return Object.freeze({ eligible: false, reason: 'continuation-not-supported' });
    }
    if (estimate.predictedLowerBound < minPredictedValue) {
      return Object.freeze({
        ...publicEstimate,
        eligible: false,
        reason: continuation ? 'continuation-value-below-threshold'
          : 'predicted-value-below-threshold',
      });
    }
    if ([RESIDUAL_INTERVENTION_OPTION_SELECTOR_SCHEMA,
      RESIDUAL_CONTINUATION_OPTION_SELECTOR_SCHEMA,
      RESIDUAL_JOINT_CONTINUATION_OPTION_SELECTOR_SCHEMA,
      RESIDUAL_GENERALIZED_JOINT_OPTION_SELECTOR_SCHEMA,
      RESIDUAL_SUCCESSOR_AUGMENTED_OPTION_SELECTOR_SCHEMA,
      RESIDUAL_CUMULATIVE_SUCCESSOR_OPTION_SELECTOR_SCHEMA,
      RESIDUAL_TRANSITION_CONDITIONED_OPTION_SELECTOR_SCHEMA,
      RESIDUAL_JOINT_TRAJECTORY_OPTION_SELECTOR_SCHEMA,
      RESIDUAL_EMPIRICAL_TRAJECTORY_OPTION_SELECTOR_SCHEMA].includes(selector.schema)) {
      const option = optionDistribution(weightedRoots, prediction.baseDistribution);
      if (!option) {
        return Object.freeze({
          ...publicEstimate, eligible: false, reason: 'option-policy-unavailable',
        });
      }
      if (option.policyTV < selector.thresholds.minPolicyTV) {
        return Object.freeze({
          ...publicEstimate, eligible: false, reason: 'option-policy-tv-below-threshold',
          policyTV: option.policyTV,
        });
      }
      return Object.freeze({
        eligible: true, reason: null, continuation, ...publicEstimate, ...option,
      });
    }
    return Object.freeze({ eligible: true, reason: null, ...publicEstimate });
  }
  let best = null;
  for (const root of selector.roots) {
    if (root.mask !== encoded.mask) continue;
    const matches = COMPACT_RESIDUAL_FEATURE_ORDER.reduce((sum, feature) => (
      sum + Number(root.features[feature] === encoded.features[feature])
    ), 0);
    const similarity = matches / COMPACT_RESIDUAL_FEATURE_ORDER.length;
    if (!best || similarity > best.similarity
      || (similarity === best.similarity && root.maxLowerBound > best.maxLowerBound)) {
      best = { similarity, maxLowerBound: root.maxLowerBound, rootSha256: root.rootSha256 };
    }
  }
  if (!best || best.similarity < selector.thresholds.minSimilarity) {
    return Object.freeze({ eligible: false, reason: 'calibrated-root-too-distant', ...(best || {}) });
  }
  return Object.freeze({ eligible: true, reason: null, ...best });
}
