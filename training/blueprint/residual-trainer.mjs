import { createHash } from 'node:crypto';

import {
  BLUEPRINT_ABSTRACTION,
  blueprintActionKeysForMask,
} from '../../js/game/blueprint-policy.js';
import {
  COMPACT_RESIDUAL_ACTION_SCHEMA,
  COMPACT_RESIDUAL_BASE_TRANSFORM,
  COMPACT_RESIDUAL_FEATURE_ORDER,
  COMPACT_RESIDUAL_FEATURE_SCHEMA,
  COMPACT_RESIDUAL_POLICY_MODE,
  COMPACT_RESIDUAL_POLICY_SCHEMA,
  COMPACT_RESIDUAL_POLICY_VERSION,
  compactResidualFeatures,
  compileCompactResidualPolicy,
  predictCompactResidualPolicy,
} from '../../js/game/blueprint-residual-policy.js';
import { validateCompactResidualRowDataset } from './residual-contract.mjs';
import { validateResidualAdvantageGuidance } from './residual-advantage.mjs';

export const COMPACT_RESIDUAL_TRAINER_VERSION = 'qyj-compact-residual-trainer-v1';

function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

function hashOrder(value) {
  return digest(`qyj-residual-split-v1\u0000${value}`);
}

function splitGroups(dataset) {
  const tableByGroup = new Map(dataset.profileSources.flatMap((source) => (
    source.sourceGroups.map((group) => [group, source.tableSize])
  )));
  const split = new Map();
  for (const tableSize of [...new Set(tableByGroup.values())].sort()) {
    const groups = [...tableByGroup].filter(([, table]) => table === tableSize)
      .map(([group]) => group).sort((a, b) => hashOrder(a).localeCompare(hashOrder(b)));
    if (groups.length < 5) throw new RangeError(`table ${tableSize} needs at least 5 source groups`);
    const heldout = Math.max(1, Math.floor(groups.length * 0.2));
    groups.forEach((group, index) => split.set(group,
      index < heldout ? 'test' : index < heldout * 2 ? 'validation' : 'train'));
  }
  return split;
}

function centeredTarget(row, maxAbsResidual, epsilon) {
  const denominator = 1 + epsilon * row.actionKeys.length;
  const values = row.actionKeys.map((action) => {
    const base = (row.baseStrategy[action] + epsilon) / denominator;
    return Math.log(Math.max(1e-9, row.targetStrategy[action]) / base);
  });
  const supported = row.actionKeys.map((_, index) => index);
  const center = supported.reduce((sum, index) => sum + values[index], 0) / supported.length;
  return values.map((value, index) => {
    const residual = Math.max(-maxAbsResidual * 0.95,
      Math.min(maxAbsResidual * 0.95, value - center));
    return Math.atanh(residual / maxAbsResidual);
  });
}

function groupMultiplier(group, member) {
  const value = Number.parseInt(digest(`qyj-residual-bootstrap-v1|${member}|${group}`).slice(0, 8), 16);
  return value % 5 === 0 ? 0 : value % 5 === 1 ? 2 : 1;
}

const TARGET_LEVEL_WEIGHT = Object.freeze({
  exact: 1,
  history: 0.75,
  position: 0.55,
  strategic: 0.35,
  population: 0.2,
  'mask-projected': 0.12,
  'independent-advantage': 1.5,
});

const COMMON_LEGAL_MASKS = Object.freeze([
  '5', '42', '45', '4a', '4d', '5a', '5d', '6a', '7a', '7d',
]);

function replaceKeyField(key, field, value) {
  return key.replace(new RegExp(`(\\|${field}=)[^|]+`), `$1${encodeURIComponent(value)}`);
}

function passiveTarget(actionKeys, sourceAction) {
  if (sourceAction === 'fold') {
    return actionKeys.includes('fold') ? 'fold'
      : actionKeys.includes('check') ? 'check' : 'call';
  }
  if (sourceAction === 'call' || sourceAction === 'check') {
    return actionKeys.includes('call') ? 'call'
      : actionKeys.includes('check') ? 'check' : 'fold';
  }
  if (sourceAction === 'allin') {
    return actionKeys.includes('allin') ? 'allin'
      : actionKeys.filter((action) => action.startsWith('raise:')).at(-1)
        || (actionKeys.includes('call') ? 'call' : 'check');
  }
  return null;
}

function projectDistribution(source, targetActions) {
  const output = Object.fromEntries(targetActions.map((action) => [action, 0]));
  const targetRaises = targetActions.filter((action) => action.startsWith('raise:'));
  for (const [sourceAction, probability] of Object.entries(source)) {
    if (!(probability > 0)) continue;
    if (sourceAction.startsWith('raise:') && targetRaises.length) {
      // Preserve total aggressive mass while making all available bet sizes
      // learnable. The descending prior is deliberately conservative.
      const raw = targetRaises.map((_, index) => 1 / (index + 1));
      const total = raw.reduce((sum, value) => sum + value, 0);
      targetRaises.forEach((action, index) => { output[action] += probability * raw[index] / total; });
      continue;
    }
    const target = targetActions.includes(sourceAction)
      ? sourceAction : passiveTarget(targetActions, sourceAction);
    if (target) output[target] += probability;
  }
  const total = Object.values(output).reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) output[targetActions[0]] = 1;
  else for (const action of targetActions) output[action] /= total;
  return output;
}

function augmentLegalMaskRows(rows, masks = COMMON_LEGAL_MASKS) {
  const augmented = [...rows];
  for (const row of rows) {
    for (const mask of masks) {
      if (mask === row.legalMask) continue;
      const actionKeys = blueprintActionKeysForMask(mask);
      let key = replaceKeyField(row.informationSetKey, 'lm', mask);
      key = replaceKeyField(key, 'rr', actionKeys.some((action) => action.startsWith('raise:')) ? '1' : '0');
      const encoded = compactResidualFeatures(key);
      if (!encoded) continue;
      augmented.push(Object.freeze({
        ...row,
        informationSetKey: key,
        legalMask: mask,
        actionKeys,
        baseStrategy: Object.freeze(projectDistribution(row.baseStrategy, actionKeys)),
        targetStrategy: Object.freeze(projectDistribution(row.targetStrategy, actionKeys)),
        targetLevel: 'mask-projected',
      }));
    }
  }
  return augmented;
}

function fitMember(rows, width, memberIndex, maxAbsResidual, ridge, epsilon) {
  const examples = rows.map((row) => ({
    row,
    encoded: compactResidualFeatures(row.informationSetKey),
    target: centeredTarget(row, maxAbsResidual, epsilon),
    weight: row.reachWeight * TARGET_LEVEL_WEIGHT[row.targetLevel]
      * groupMultiplier(row.sourceGroup, memberIndex),
  })).filter((entry) => entry.weight > 0);
  if (!examples.length) throw new RangeError('bootstrap member has no training examples');
  const weightedMean = (selector) => {
    const total = examples.reduce((sum, entry) => sum + entry.weight, 0);
    return Array.from({ length: width }, (_, action) => examples.reduce(
      (sum, entry) => sum + entry.weight * selector(entry)[action], 0,
    ) / total);
  };
  const bias = weightedMean((entry) => entry.target);
  const features = Object.fromEntries(COMPACT_RESIDUAL_FEATURE_ORDER.map((feature) => {
    const categories = [...new Set(examples.map((entry) => entry.encoded.features[feature]))].sort();
    const fitted = Object.fromEntries(categories.map((category) => {
      const matching = examples.filter((entry) => entry.encoded.features[feature] === category);
      const total = matching.reduce((sum, entry) => sum + entry.weight, 0);
      const vector = Array.from({ length: width }, (_, action) => {
        const mean = matching.reduce((sum, entry) => (
          sum + entry.weight * (entry.target[action] - bias[action])
        ), 0) / total;
        // Each of the categorical fields contributes a conservative fraction;
        // ridge keeps rare categories close to the frozen QYZ base policy.
        return mean / (COMPACT_RESIDUAL_FEATURE_ORDER.length * (1 + ridge / total));
      });
      return [category, vector];
    }));
    fitted.__GLOBAL__ = Array.from({ length: width }, () => 0);
    return [feature, fitted];
  }));
  return { bias, features };
}

function supportFor(rows) {
  const features = Object.fromEntries(COMPACT_RESIDUAL_FEATURE_ORDER.map((feature) => {
    const categories = new Map();
    for (const row of rows) {
      const category = compactResidualFeatures(row.informationSetKey).features[feature];
      let entry = categories.get(category);
      if (!entry) categories.set(category, entry = { rows: 0, groups: new Set() });
      entry.rows += row.reachWeight;
      entry.groups.add(row.sourceGroup);
    }
    const fitted = Object.fromEntries([...categories].sort(([a], [b]) => a.localeCompare(b))
      .map(([category, entry]) => [category, {
        rows: entry.rows,
        sourceGroups: entry.groups.size,
      }]));
    fitted.__GLOBAL__ = {
      rows: rows.reduce((sum, row) => sum + row.reachWeight, 0),
      sourceGroups: new Set(rows.map((row) => row.sourceGroup)).size,
    };
    return [feature, fitted];
  }));
  return {
    rows: rows.reduce((sum, row) => sum + row.reachWeight, 0),
    sourceGroups: new Set(rows.map((row) => row.sourceGroup)).size,
    categories: features,
  };
}

function evaluate(model, rows) {
  let accepted = 0;
  let weight = 0;
  let tv = 0;
  let targetTv = 0;
  let fallbackFeatures = 0;
  const reasons = {};
  for (const row of rows) {
    const baseDistribution = row.actionKeys.map((actionKey) => ({
      actionKey, probability: row.baseStrategy[actionKey],
    }));
    const prediction = predictCompactResidualPolicy(model, {
      informationSetKey: row.informationSetKey,
      baseDistribution,
      basePolicyContract: model.contracts.basePolicyContract,
      baseStyleKey: model.contracts.baseStyleKey,
    });
    weight += row.reachWeight;
    if (!prediction.accepted) {
      reasons[prediction.reason] = (reasons[prediction.reason] || 0) + row.reachWeight;
      continue;
    }
    accepted += row.reachWeight;
    fallbackFeatures += prediction.fallbackFeatureCount * row.reachWeight;
    tv += prediction.shadowTV * row.reachWeight;
    targetTv += prediction.distribution.reduce((sum, entry) => (
      sum + Math.abs(entry.probability - row.targetStrategy[entry.actionKey])
    ), 0) * 0.5 * row.reachWeight;
  }
  return Object.freeze({
    decisions: weight,
    acceptedDecisions: accepted,
    coverage: weight ? accepted / weight : 0,
    meanShadowTV: accepted ? tv / accepted : 0,
    meanTargetTV: accepted ? targetTv / accepted : null,
    meanFallbackFeatures: accepted ? fallbackFeatures / accepted : null,
    rejectionReasons: Object.freeze(reasons),
  });
}

export function trainCompactResidualPolicy(rawDataset, {
  basePolicyContract = 'qyj-range-ev-v1',
  baseStyleKey = 'tag',
  ensembleSize = 5,
  maxAbsResidual = 0.5,
  minCategoryGroups = 2,
  ridge = 4,
  epsilon = 0.0001,
  augmentLegalMasks = true,
  advantageGuidance = null,
} = {}) {
  const dataset = validateCompactResidualRowDataset(rawDataset);
  const guidance = advantageGuidance
    ? validateResidualAdvantageGuidance(advantageGuidance) : null;
  if (guidance && (guidance.basePolicyContract !== basePolicyContract
    || guidance.baseStyleKey !== baseStyleKey)) {
    throw new RangeError('advantage guidance base-policy contract mismatch');
  }
  const splitByGroup = splitGroups(dataset);
  const guidedRows = guidance ? dataset.rows.map((row) => {
    const record = guidance.records[row.informationSetKey];
    if (!record) return row;
    return Object.freeze({
      ...row,
      targetStrategy: Object.freeze({ ...record.targetStrategy }),
      targetLevel: 'independent-advantage',
      independentActionAdvantages: Object.freeze(Object.fromEntries(
        row.actionKeys.map((action) => [action, record.advantages[action].lowerBound]),
      )),
    });
  }) : dataset.rows;
  const trainingRows = augmentLegalMasks
    ? augmentLegalMaskRows(guidedRows) : guidedRows;
  const rowsBySplit = Object.fromEntries(['train', 'validation', 'test'].map((split) => [
    split, trainingRows.filter((row) => splitByGroup.get(row.sourceGroup) === split),
  ]));
  if (Object.values(rowsBySplit).some((rows) => !rows.length)) {
    throw new RangeError('group-disjoint train/validation/test rows are required');
  }
  const heads = [...new Set(rowsBySplit.train.map((row) => row.legalMask))].sort()
    .map((mask) => {
      const rows = rowsBySplit.train.filter((row) => row.legalMask === mask);
      const actionKeys = rows[0].actionKeys;
      return {
        mask,
        actionKeys: [...actionKeys],
        members: Array.from({ length: ensembleSize }, (_, member) => fitMember(
          rows, actionKeys.length, member, maxAbsResidual, ridge, epsilon,
        )),
        support: supportFor(rows),
      };
    });
  const trainingManifestSha256 = digest(JSON.stringify({
    dataset: rawDataset,
    advantageGuidance: guidance,
  }));
  const model = compileCompactResidualPolicy({
    schema: COMPACT_RESIDUAL_POLICY_SCHEMA,
    version: COMPACT_RESIDUAL_POLICY_VERSION,
    mode: COMPACT_RESIDUAL_POLICY_MODE,
    contracts: {
      abstraction: BLUEPRINT_ABSTRACTION,
      featureSchema: COMPACT_RESIDUAL_FEATURE_SCHEMA,
      actionSchema: COMPACT_RESIDUAL_ACTION_SCHEMA,
      basePolicyContract,
      baseStyleKey,
      baseLogitTransform: COMPACT_RESIDUAL_BASE_TRANSFORM,
      epsilon,
    },
    feature: { order: [...COMPACT_RESIDUAL_FEATURE_ORDER] },
    model: {
      maxAbsResidual,
      minCategoryGroups,
      maxOodScore: 0.25,
      maxEpistemicStd: 0.15,
      ensembleSize,
      heads,
    },
    provenance: { trainerVersion: COMPACT_RESIDUAL_TRAINER_VERSION, trainingManifestSha256 },
  });
  const metrics = Object.fromEntries(Object.entries(rowsBySplit).map(([split, rows]) => [
    split, evaluate(model, rows),
  ]));
  const groupSplits = Object.fromEntries(['train', 'validation', 'test'].map((split) => [
    split, [...splitByGroup].filter(([, value]) => value === split).map(([group]) => group).sort(),
  ]));
  return Object.freeze({ model, report: Object.freeze({
    schema: 'qyj-compact-residual-training-report-v1',
    version: 1,
    mode: 'shadow-only',
    trainingManifestSha256,
    sourceGroupSecretId: dataset.sourceGroupSecretId,
    groupSplits,
    metrics,
    promotionEligible: false,
    promotionBlockers: Object.freeze([
      guidance
        ? 'independent-action-advantage-coverage-below-threshold'
        : dataset.summary.independentAdvantageRows > 0
          ? 'independent-action-advantage-coverage-below-threshold'
          : 'independent-action-advantage-calibration-required',
      'mask-projected-targets-require-calibration',
      'hierarchical-category-fallback-requires-calibration',
      'shadow-only-schema-cannot-deploy',
    ]),
    augmentation: Object.freeze({
      legalMaskProjection: augmentLegalMasks,
      sourceRows: dataset.rows.length,
      fittedRows: trainingRows.length,
      masks: augmentLegalMasks ? COMMON_LEGAL_MASKS : [],
    }),
    advantageGuidance: guidance ? Object.freeze({
      calibratedRoots: guidance.summary.calibratedRoots,
      actionableRoots: guidance.summary.actionableRoots,
      actionableActions: guidance.summary.actionableActions,
      calibrationSha256: guidance.calibrationSha256,
    }) : dataset.summary.independentAdvantageRows > 0 ? Object.freeze({
      materializedRows: dataset.summary.independentAdvantageRows,
      calibratedRoots: new Set(dataset.rows.filter(
        (row) => row.independentActionAdvantages,
      ).map((row) => row.informationSetKey)).size,
    }) : null,
  }) });
}
