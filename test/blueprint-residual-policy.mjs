import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  BLUEPRINT_ABSTRACTION,
  blueprintActionKeysForMask,
  buildBlueprintInfoSetKey,
} from '../js/game/blueprint-policy.js';
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
  evaluateCompactResidualShadow,
  predictCompactResidualPolicy,
} from '../js/game/blueprint-residual-policy.js';
import { QyjAbstractHoldemGame, abstractObservation } from '../training/blueprint/qyj-abstract-game.js';
import { SerializableRng } from '../training/blueprint/rng.js';
import {
  COMPACT_RESIDUAL_ROWS_SCHEMA,
  COMPACT_RESIDUAL_ROWS_VERSION,
  validateCompactResidualRowDataset,
} from '../training/blueprint/residual-contract.mjs';
import { trainCompactResidualPolicy } from '../training/blueprint/residual-trainer.mjs';
import { CompactResidualSuccessorCollector } from '../training/blueprint/residual-data.mjs';
import { buildResidualAdvantageGuidance } from '../training/blueprint/residual-advantage.mjs';
import {
  buildResidualInterventionSelector,
  buildResidualInterventionOptionSelector,
  buildResidualContinuationOptionSelector,
  buildJointCalibratedContinuationOptionSelector,
  buildGeneralizedJointOptionSelector,
  buildSuccessorAugmentedOptionSelector,
  buildTransitionConditionedOptionSelector,
  buildJointTrajectoryOptionSelector,
  buildEmpiricalTrajectoryOptionSelector,
  buildResidualInterventionValueSelector,
  evaluateResidualInterventionSelector,
  validateResidualInterventionSelector,
} from '../training/blueprint/residual-selector.mjs';

const game = new QyjAbstractHoldemGame({ tableSize: 6, round: 4, maxRaisesPerStreet: 1 });
const state = game.createInitialState(new SerializableRng('residual-policy-test'));
const observation = abstractObservation(state, state.actingSeat);
const key = buildBlueprintInfoSetKey(observation, { maxRaisesPerStreet: 1 });
const encoded = compactResidualFeatures(key);
assert(encoded, 'fixture must produce a supported exact information-set key');
const actionKeys = blueprintActionKeysForMask(encoded.mask);

function artifact({ bias = 0, disagreement = 0, supportGroups = 3 } = {}) {
  const categories = Object.fromEntries(COMPACT_RESIDUAL_FEATURE_ORDER.map((feature) => [
    feature,
    { [encoded.features[feature]]: { rows: 10, sourceGroups: supportGroups } },
  ]));
  const member = (sign) => ({
    bias: actionKeys.map((_, index) => (index === actionKeys.length - 1 ? bias + sign * disagreement : 0)),
    features: Object.fromEntries(COMPACT_RESIDUAL_FEATURE_ORDER.map((feature) => [
      feature,
      { [encoded.features[feature]]: actionKeys.map(() => 0) },
    ])),
  });
  return {
    schema: COMPACT_RESIDUAL_POLICY_SCHEMA,
    version: COMPACT_RESIDUAL_POLICY_VERSION,
    mode: COMPACT_RESIDUAL_POLICY_MODE,
    contracts: {
      abstraction: BLUEPRINT_ABSTRACTION,
      featureSchema: COMPACT_RESIDUAL_FEATURE_SCHEMA,
      actionSchema: COMPACT_RESIDUAL_ACTION_SCHEMA,
      basePolicyContract: 'qyj-range-ev-v1',
      baseStyleKey: 'tag',
      baseLogitTransform: COMPACT_RESIDUAL_BASE_TRANSFORM,
      epsilon: 0.0001,
    },
    feature: { order: [...COMPACT_RESIDUAL_FEATURE_ORDER] },
    model: {
      maxAbsResidual: 0.5,
      minCategoryGroups: 2,
      maxOodScore: 0,
      maxEpistemicStd: 0.1,
      ensembleSize: 2,
      heads: [{
        mask: encoded.mask,
        actionKeys: [...actionKeys],
        members: [member(1), member(-1)],
        support: { rows: 20, sourceGroups: 4, categories },
      }],
    },
    provenance: {
      trainerVersion: 'residual-policy-test-v1',
      trainingManifestSha256: '0'.repeat(64),
    },
  };
}

const uniform = actionKeys.map((actionKey) => ({ actionKey, probability: 1 / actionKeys.length }));
const zeroModel = compileCompactResidualPolicy(artifact());
const zero = predictCompactResidualPolicy(zeroModel, {
  informationSetKey: key,
  baseDistribution: uniform,
  basePolicyContract: 'qyj-range-ev-v1',
  baseStyleKey: 'tag',
});
assert.equal(zero.accepted, true);
assert(zero.distribution.every((entry, index) => Math.abs(entry.probability - uniform[index].probability) < 1e-12));

const shiftedModel = compileCompactResidualPolicy(artifact({ bias: 1 }));
const sparse = actionKeys.map((actionKey, index) => ({
  actionKey,
  probability: index === 0 ? 0 : 1 / (actionKeys.length - 1),
}));
const shifted = predictCompactResidualPolicy(shiftedModel, {
  informationSetKey: key,
  baseDistribution: sparse,
  basePolicyContract: 'qyj-range-ev-v1',
  baseStyleKey: 'tag',
});
assert.equal(shifted.accepted, true);
assert(shifted.distribution[0].probability > 0, 'V2 shadow transform must expose every legal action');
assert(shifted.distribution[0].probability < 0.001, 'the explicit legal-action floor must remain bounded');
assert(shifted.shadowTV > 0);

assert.equal(predictCompactResidualPolicy(shiftedModel, {
  informationSetKey: key,
  baseDistribution: uniform,
  basePolicyContract: 'wrong-contract',
  baseStyleKey: 'tag',
}).reason, 'base-policy-contract-mismatch');

const lowSupport = compileCompactResidualPolicy(artifact({ supportGroups: 1 }));
assert.equal(predictCompactResidualPolicy(lowSupport, {
  informationSetKey: key,
  baseDistribution: uniform,
  basePolicyContract: 'qyj-range-ev-v1',
  baseStyleKey: 'tag',
}).reason, 'ood');

const activeArtifact = artifact();
activeArtifact.mode = 'active';
assert.throws(() => compileCompactResidualPolicy(activeArtifact), /unsupported compact residual policy/);

const badOrder = artifact();
badOrder.model.heads[0].actionKeys.reverse();
assert.throws(() => compileCompactResidualPolicy(badOrder), /fixed mask tensor order/);

const basePolicy = Object.freeze({ distribution: uniform, marker: Symbol('same-object') });
const shadow = evaluateCompactResidualShadow(basePolicy, {
  model: shiftedModel,
  informationSetKey: key,
  basePolicyContract: 'qyj-range-ev-v1',
  baseStyleKey: 'tag',
});
assert.strictEqual(shadow.policy, basePolicy, 'shadow evaluator must never replace the live policy');
assert.equal(shadow.diagnostics.shadowOnly, true);

function replaceField(informationSetKey, field, value) {
  return informationSetKey.replace(new RegExp(`(\\|${field}=)[^|]+`), `$1${encodeURIComponent(value)}`);
}

const groups6 = Array.from({ length: 5 }, (_, index) => `pg_${(index + 1).toString(16).padStart(64, '0')}`);
const groups9 = Array.from({ length: 5 }, (_, index) => `pg_${(index + 101).toString(16).padStart(64, '0')}`);
const target = Object.fromEntries(actionKeys.map((action, index) => [
  action,
  index === 0 ? 0.1 : index === actionKeys.length - 1
    ? 0.9 - (actionKeys.length - 2) * 0.1 : 0.1,
]));
const base = Object.fromEntries(actionKeys.map((action) => [action, 1 / actionKeys.length]));
const rows = [...groups6.map((sourceGroup) => ({ sourceGroup, informationSetKey: key })),
  ...groups9.map((sourceGroup) => ({
    sourceGroup,
    informationSetKey: replaceField(key, 'n', '9'),
  }))].map(({ sourceGroup, informationSetKey }) => ({
  informationSetKey,
  baseStrategy: base,
  targetStrategy: target,
  sourceGroup,
  targetLevel: 'exact',
  reachWeight: 10,
  independentActionAdvantages: null,
}));
const dataset = {
  schema: COMPACT_RESIDUAL_ROWS_SCHEMA,
  version: COMPACT_RESIDUAL_ROWS_VERSION,
  profileSchema: 'qyj-exact-infoset-reach-profile-v2',
  profileVersion: 2,
  sourceGroupSecretId: `ps_${'a'.repeat(64)}`,
  profileSources: [
    { sha256: 'b'.repeat(64), tableSize: 6, sourceGroups: groups6 },
    { sha256: 'c'.repeat(64), tableSize: 9, sourceGroups: groups9 },
  ],
  rows,
};
assert.equal(validateCompactResidualRowDataset(dataset).summary.rows, 10);
const trained = trainCompactResidualPolicy(dataset, { ensembleSize: 3, minCategoryGroups: 2 });
assert.equal(trained.model.mode, 'shadow-only');
assert.equal(trained.report.metrics.test.decisions, 200);
assert.equal(trained.report.metrics.validation.decisions, 200);
assert.equal(trained.report.metrics.train.decisions, 600);
const splitGroups = Object.values(trained.report.groupSplits).flat();
assert.equal(new Set(splitGroups).size, splitGroups.length, 'source groups must belong to exactly one split');
assert.equal(trained.report.promotionEligible, false);
assert(trained.report.promotionBlockers.includes('independent-action-advantage-calibration-required'));
assert.equal(trained.model.model.heads.length, 10);
assert.equal(trained.report.augmentation.fittedRows, 100);
const hierarchicalKey = replaceField(key, 'h', 'previously-unseen-hand-bucket');
const hierarchical = predictCompactResidualPolicy(trained.model, {
  informationSetKey: hierarchicalKey,
  baseDistribution: uniform,
  basePolicyContract: 'qyj-range-ev-v1',
  baseStyleKey: 'tag',
});
assert.equal(hierarchical.accepted, true);
assert(hierarchical.fallbackFeatures.includes('h'));

const syntheticCalibration = {
  schema: 'qyj-exact-root-action-calibration-v1',
  version: 1,
  samplingUnit: 'independent-seed-cluster',
  frozenPolicySha256: 'd'.repeat(64),
  tournamentValueModelSha256: 'e'.repeat(64),
  tournamentValueReportSha256: 'f'.repeat(64),
  basePolicyContract: 'qyj-range-ev-v1',
  baseStyleKey: 'tag',
  records: {
    [key]: {
      actionKeys,
      independentClusterCount: 20,
      clusters: Array.from({ length: 20 }, (_, index) => ({
        clusterId: `fc_${index.toString(16).padStart(64, '0')}`,
        values: actionKeys.map((_, actionIndex) => (
          actionIndex === actionKeys.length - 1 ? 0.5 : 0
        )),
      })),
    },
  },
};
const guidance = buildResidualAdvantageGuidance(syntheticCalibration, dataset);
assert.equal(guidance.summary.actionableRoots, 1);
assert(guidance.records[key].targetStrategy[actionKeys.at(-1)] > base[actionKeys.at(-1)]);
const guidedTraining = trainCompactResidualPolicy(dataset, {
  ensembleSize: 3,
  minCategoryGroups: 2,
  advantageGuidance: guidance,
});
assert.equal(guidedTraining.report.advantageGuidance.actionableRoots, 1);
assert(guidedTraining.report.promotionBlockers.includes(
  'independent-action-advantage-coverage-below-threshold',
));
const selector = buildResidualInterventionSelector(guidance, {
  residualModelSha256: '1'.repeat(64),
  minSimilarity: 0.5,
  minAdvantageLowerBound: 0.001,
  maxFallbackFeatures: 4,
  minPolicyTV: 0,
});
const guidedPrediction = predictCompactResidualPolicy(guidedTraining.model, {
  informationSetKey: key,
  baseDistribution: uniform,
  basePolicyContract: 'qyj-range-ev-v1',
  baseStyleKey: 'tag',
});
assert.equal(evaluateResidualInterventionSelector(selector, {
  informationSetKey: key,
  prediction: guidedPrediction,
}).eligible, true);
assert.throws(() => validateResidualInterventionSelector(selector, {
  residualModelSha256: '2'.repeat(64),
}), /model SHA mismatch/);

const valueGuidance = structuredClone(guidance);
const alternateKey = key.replace(/\|ip=([01])\|/, (_, value) => `|ip=${value === '0' ? '1' : '0'}|`);
valueGuidance.records[alternateKey] = structuredClone(valueGuidance.records[key]);
const valueSelector = buildResidualInterventionValueSelector(valueGuidance, {
  residualModelSha256: '1'.repeat(64),
  tableSize: 6,
  minSimilarity: 0.5,
  neighborCount: 2,
  minNeighbors: 1,
  uncertaintyPenalty: 0,
  minPredictedValue: 0.001,
  minPolicyTV: 0,
  maxFallbackFeatures: 4,
});
assert.equal(valueSelector.validation.positivePrecision, 1);
assert.equal(evaluateResidualInterventionSelector(valueSelector, {
  informationSetKey: key,
  prediction: guidedPrediction,
  tableSize: 6,
}).eligible, true);
assert.equal(evaluateResidualInterventionSelector(valueSelector, {
  informationSetKey: key,
  prediction: guidedPrediction,
  tableSize: 9,
}).reason, 'value-head-table-mismatch');
const optionSelector = buildResidualInterventionOptionSelector(valueGuidance, {
  residualModelSha256: '1'.repeat(64),
  tableSize: 6,
  minSimilarity: 0.5,
  neighborCount: 2,
  minNeighbors: 1,
  uncertaintyPenalty: 0,
  minPredictedValue: 0.001,
  minPolicyTV: 0,
  maxFallbackFeatures: 4,
});
const optionSelection = evaluateResidualInterventionSelector(optionSelector, {
  informationSetKey: key,
  prediction: guidedPrediction,
  tableSize: 6,
});
assert.equal(optionSelection.eligible, true);
assert(Math.abs(optionSelection.distribution.reduce(
  (sum, entry) => sum + entry.probability, 0,
) - 1) < 1e-12);
assert(optionSelection.policyTV >= 0);
assert.equal(validateResidualInterventionSelector(optionSelector), optionSelector);
const continuationSelector = buildResidualContinuationOptionSelector(valueGuidance, {
  residualModelSha256: '1'.repeat(64),
  tableSize: 6,
  optionHorizon: 2,
  continuationMinPredictedValue: -0.01,
  minSimilarity: 0.5,
  neighborCount: 2,
  minNeighbors: 1,
  uncertaintyPenalty: 0,
  minPredictedValue: 0.001,
  minPolicyTV: 0,
  maxFallbackFeatures: 4,
});
assert.equal(continuationSelector.optionHorizon, 2);
assert.equal(evaluateResidualInterventionSelector(continuationSelector, {
  informationSetKey: key,
  prediction: guidedPrediction,
  tableSize: 6,
  continuation: true,
}).eligible, true);
assert.throws(() => buildResidualContinuationOptionSelector(valueGuidance, {
  residualModelSha256: '1'.repeat(64), tableSize: 6, optionHorizon: 4,
}), /optionHorizon/);
const jointSelector = buildJointCalibratedContinuationOptionSelector(
  continuationSelector,
  {
    schema: 'qyj-joint-continuation-option-calibration-v1',
    version: 1,
    optionSelectorSha256: createHash('sha256')
      .update(JSON.stringify(continuationSelector)).digest('hex'),
    records: {
      [key]: { meanAdvantage: 0.02, lowerBound: 0.01, controlledDecisions: 20 },
    },
  },
);
assert.equal(jointSelector.roots.length, 1);
assert.equal(jointSelector.thresholds.minSimilarity, 1);
assert.equal(validateResidualInterventionSelector(jointSelector), jointSelector);
const generalizedCalibration = {
  schema: 'qyj-joint-continuation-option-calibration-v1',
  version: 1,
  optionSelectorSha256: createHash('sha256')
    .update(JSON.stringify(continuationSelector)).digest('hex'),
  records: {
    [key]: { meanAdvantage: 0.02, lowerBound: 0.01, controlledDecisions: 20 },
    [alternateKey]: { meanAdvantage: -0.01, lowerBound: -0.02, controlledDecisions: 20 },
  },
};
const generalizedSelector = buildGeneralizedJointOptionSelector(
  continuationSelector,
  generalizedCalibration,
  {
    schema: 'qyj-compact-residual-base-rows-v1',
    rows: [
      { informationSetKey: key, sourceGroup: 'pg_a' },
      { informationSetKey: alternateKey, sourceGroup: 'pg_b' },
    ],
  },
  {
    featureOrder: ['s'],
    minSimilarity: 0,
    neighborCount: 1,
    minNeighbors: 1,
    minValidationSelected: 1,
  },
);
assert.equal(generalizedSelector.featureOrder.length, 1);
assert.equal(generalizedSelector.validation.sourceGroups, 2);
assert.equal(validateResidualInterventionSelector(generalizedSelector), generalizedSelector);
const successorSelector = buildSuccessorAugmentedOptionSelector(
  generalizedSelector, valueGuidance, {
    featureOrder: ['s'], minSimilarity: 1, neighborCount: 2, minNeighbors: 1,
    uncertaintyPenalty: 0, minPredictedValue: 0, minPolicyTV: 0,
  },
);
const successorSelection = evaluateResidualInterventionSelector(successorSelector, {
  informationSetKey: key,
  prediction: guidedPrediction,
  tableSize: 6,
  continuation: true,
});
assert.equal(successorSelection.eligible, true);
assert.equal(successorSelection.successor, true);
assert.equal(validateResidualInterventionSelector(successorSelector), successorSelector);
const cumulativeSuccessorSelector = buildSuccessorAugmentedOptionSelector(
  generalizedSelector, valueGuidance, {
    baseDataset: {
      rows: [
        { informationSetKey: key, sourceGroup: 'group-a' },
        { informationSetKey: alternateKey, sourceGroup: 'group-b' },
      ],
    },
    featureOrder: ['s'], minSimilarity: 1, neighborCount: 1, minNeighbors: 1,
    uncertaintyPenalty: 0, minPredictedValue: 0, minPolicyTV: 0,
  },
);
assert.equal(cumulativeSuccessorSelector.version, 8);
assert.equal(cumulativeSuccessorSelector.successorValidation.roots, 2);
assert.equal(validateResidualInterventionSelector(
  cumulativeSuccessorSelector,
), cumulativeSuccessorSelector);
const transitionSelector = buildTransitionConditionedOptionSelector(
  generalizedSelector,
  valueGuidance,
  {
    schema: 'qyj-residual-option-successors-v1',
    version: 1,
    rows: [
      {
        tableSize: 6, sourceGroup: 'group-a',
        startInformationSetKey: key, successorInformationSetKey: key,
      },
      {
        tableSize: 6, sourceGroup: 'group-b',
        startInformationSetKey: alternateKey, successorInformationSetKey: alternateKey,
      },
    ],
  },
  {
    startFeatureOrder: ['s'], successorFeatureOrder: ['s'],
    minSimilarity: 1, neighborCount: 1, minNeighbors: 1,
    uncertaintyPenalty: 0, minPredictedValue: 0, minPolicyTV: 0,
    minValidationSelected: 1,
  },
);
assert.equal(transitionSelector.version, 9);
assert.equal(transitionSelector.transition.roots.length, 2);
assert.equal(validateResidualInterventionSelector(transitionSelector), transitionSelector);
const transitionSelection = evaluateResidualInterventionSelector(transitionSelector, {
  informationSetKey: key,
  startInformationSetKey: key,
  prediction: guidedPrediction,
  tableSize: 6,
  continuation: true,
});
assert.equal(transitionSelection.eligible, true);
assert.equal(transitionSelection.transitionConditioned, true);
assert.match(transitionSelection.trajectoryBucketSha256, /^[0-9a-f]{64}$/);
assert.equal(evaluateResidualInterventionSelector(transitionSelector, {
  informationSetKey: key,
  prediction: guidedPrediction,
  tableSize: 6,
  continuation: true,
}).reason, 'transition-start-unavailable');
const trajectoryCalibration = {
  schema: 'qyj-joint-continuation-option-calibration-v1',
  optionSelectorSha256: createHash('sha256')
    .update(JSON.stringify(transitionSelector)).digest('hex'),
  records: {
    [key]: {
      meanAdvantage: 0.03, lowerBound: 0.02,
      controlledDecisions: 20, horizonReached: 8,
    },
    [alternateKey]: {
      meanAdvantage: -0.01, lowerBound: -0.02,
      controlledDecisions: 20, horizonReached: 7,
    },
  },
};
const trajectorySelector = buildJointTrajectoryOptionSelector(
  transitionSelector,
  trajectoryCalibration,
  {
    schema: 'qyj-compact-residual-base-rows-v1',
    rows: [
      { informationSetKey: key, sourceGroup: 'group-a' },
      { informationSetKey: alternateKey, sourceGroup: 'group-b' },
    ],
  },
  {
    featureOrder: ['s'], minSimilarity: 1, neighborCount: 1, minNeighbors: 1,
    uncertaintyPenalty: 0, minPredictedValue: -1, minPolicyTV: 0,
    minValidationSelected: 1,
  },
);
assert.equal(trajectorySelector.version, 10);
assert.equal(trajectorySelector.trajectory.roots.length, 2);
assert.equal(validateResidualInterventionSelector(trajectorySelector), trajectorySelector);
assert.equal(evaluateResidualInterventionSelector(trajectorySelector, {
  informationSetKey: key,
  prediction: guidedPrediction,
  tableSize: 6,
}).jointTrajectory, true);
assert.equal(evaluateResidualInterventionSelector(trajectorySelector, {
  informationSetKey: key,
  startInformationSetKey: key,
  prediction: guidedPrediction,
  tableSize: 6,
  continuation: true,
}).transitionConditioned, true);
const empiricalRoot = transitionSelector.transition.roots[0];
const empiricalSelector = buildEmpiricalTrajectoryOptionSelector(
  transitionSelector,
  {
    schema: 'qyj-empirical-trajectory-guidance-v1',
    selectorSemanticSha256: createHash('sha256')
      .update(JSON.stringify(transitionSelector)).digest('hex'),
    records: {
      [empiricalRoot.trajectoryBucketSha256]: {
        independentClusterCount: 2,
        actionChanges: 2,
        rankLowerBound: 0.01,
        hpLowerBound: 1,
      },
    },
  },
  { minIndependentClusters: 1 },
);
assert.equal(empiricalSelector.version, 11);
assert.equal(empiricalSelector.transition.roots.length, 2);
assert.equal(empiricalSelector.empiricalTrajectoryValidation.passed, false);
assert.equal(validateResidualInterventionSelector(empiricalSelector), empiricalSelector);
const successorCollector = new CompactResidualSuccessorCollector({
  sourceGroupSecretId: `ps_${'a'.repeat(64)}`,
});
assert.equal(successorCollector.observe({
  sourceGroup: `pg_${'b'.repeat(64)}`,
  tableSize: 6,
  startInformationSetKey: key,
  successorInformationSetKey: alternateKey,
  continued: false,
  aborted: true,
  reason: 'selector:continuation-value-below-threshold',
  baseDistribution: guidedPrediction.baseDistribution,
}), true);
const successorArtifact = successorCollector.finalize({ profileSources: [{
  sha256: 'c'.repeat(64), tableSize: 6, sourceGroups: [`pg_${'b'.repeat(64)}`],
}] });
assert.equal(successorArtifact.rows[0].attempts, 1);
assert.equal(successorArtifact.rows[0].aborts, 1);
assert(Math.abs(Object.values(successorArtifact.rows[0].baseStrategy)
  .reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
assert(!JSON.stringify(successorArtifact).includes('raw-seed'));

const supportExpansion = structuredClone(dataset);
supportExpansion.rows[0].baseStrategy[actionKeys[0]] = 0;
supportExpansion.rows[0].baseStrategy[actionKeys[1]] += 1 / actionKeys.length;
assert.equal(validateCompactResidualRowDataset(supportExpansion).summary.rows, 10);

console.log('blueprint residual shadow policy tests passed');
