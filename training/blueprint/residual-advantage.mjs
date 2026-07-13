import { createHash } from 'node:crypto';

import { validateCompactResidualRowDataset } from './residual-contract.mjs';
import {
  COMPACT_RESIDUAL_ROWS_SCHEMA,
  COMPACT_RESIDUAL_ROWS_VERSION,
} from './residual-contract.mjs';
import { blueprintActionKeysForMask } from '../../js/game/blueprint-policy.js';
import { compactResidualFeatures } from '../../js/game/blueprint-residual-policy.js';

export const RESIDUAL_ADVANTAGE_GUIDANCE_SCHEMA = 'qyj-residual-advantage-guidance-v1';
export const RESIDUAL_ADVANTAGE_GUIDANCE_VERSION = 1;

const T95_ONE_SIDED = [Infinity, 6.3138, 2.92, 2.3534, 2.1318, 2.015, 1.9432,
  1.8946, 1.8595, 1.8331, 1.8125, 1.7959, 1.7823, 1.7709, 1.7613,
  1.7531, 1.7459, 1.7396, 1.7341, 1.7291, 1.7247];

function t95(df) {
  return T95_ONE_SIDED[df] || (1.644854 + 0.710 / Math.max(1, df));
}

function sha(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Compile independent cluster values into conservative action guidance. */
export function buildResidualAdvantageGuidance(rawCalibration, rawDataset, {
  minLowerBound = 0,
  advantageTemperature = 0.05,
  maxLogitShift = 2,
} = {}) {
  const dataset = rawDataset?.schema === 'qyj-compact-residual-base-rows-v1'
    ? {
      ...rawDataset,
      rows: rawDataset.rows.map((row) => {
        const encoded = compactResidualFeatures(row.informationSetKey);
        if (!encoded) throw new RangeError('base row has an invalid information set');
        const actionKeys = blueprintActionKeysForMask(encoded.mask);
        const total = actionKeys.reduce((sum, action) => sum + Number(row.baseStrategy[action]), 0);
        if (Math.abs(total - 1) > 1e-9) throw new RangeError('base row strategy must sum to one');
        return { ...row, actionKeys };
      }),
    }
    : validateCompactResidualRowDataset(rawDataset);
  if (!['qyj-exact-root-action-calibration-v1',
    'qyj-counterfactual-root-action-calibration-v1'].includes(rawCalibration?.schema)
    || Number(rawCalibration?.version) !== 1
    || rawCalibration?.samplingUnit !== 'independent-seed-cluster') {
    throw new TypeError('unsupported independent exact-root calibration');
  }
  const records = {};
  for (const [informationSetKey, calibration] of Object.entries(rawCalibration.records || {})) {
    const rows = dataset.rows.filter((row) => row.informationSetKey === informationSetKey);
    if (!rows.length) continue;
    const actionKeys = calibration.actionKeys;
    const baseStrategy = Object.fromEntries(actionKeys.map((action) => [
      action,
      rows.reduce((sum, row) => sum + row.baseStrategy[action] * row.reachWeight, 0)
        / rows.reduce((sum, row) => sum + row.reachWeight, 0),
    ]));
    const contrasts = calibration.clusters.map((cluster) => {
      const baseline = actionKeys.reduce((sum, action, index) => (
        sum + baseStrategy[action] * cluster.values[index]
      ), 0);
      return cluster.values.map((value) => value - baseline);
    });
    const advantages = {};
    const actionableActions = [];
    actionKeys.forEach((action, actionIndex) => {
      const samples = contrasts.map((vector) => vector[actionIndex]);
      const average = mean(samples);
      const variance = samples.length > 1 ? samples.reduce(
        (sum, value) => sum + (value - average) ** 2, 0,
      ) / (samples.length - 1) : Infinity;
      const standardError = Math.sqrt(Math.max(0, variance) / samples.length);
      const lowerBound = average - t95(samples.length - 1) * standardError;
      advantages[action] = { mean: average, lowerBound, samples: samples.length };
      if (lowerBound > minLowerBound) actionableActions.push(action);
    });
    let targetStrategy = { ...baseStrategy };
    if (actionableActions.length) {
      const epsilon = 0.0001;
      const weights = actionKeys.map((action) => {
        const base = baseStrategy[action] + epsilon;
        const shift = Math.min(maxLogitShift,
          Math.max(0, advantages[action].lowerBound - minLowerBound) / advantageTemperature);
        return base * Math.exp(shift);
      });
      const total = weights.reduce((sum, value) => sum + value, 0);
      targetStrategy = Object.fromEntries(actionKeys.map((action, index) => [
        action, weights[index] / total,
      ]));
    }
    records[informationSetKey] = {
      actionKeys,
      baseStrategy,
      targetStrategy,
      advantages,
      actionableActions,
      independentClusterCount: calibration.independentClusterCount,
    };
  }
  const artifact = {
    schema: RESIDUAL_ADVANTAGE_GUIDANCE_SCHEMA,
    version: RESIDUAL_ADVANTAGE_GUIDANCE_VERSION,
    mode: 'shadow-only',
    calibrationSha256: sha(rawCalibration),
    frozenPolicySha256: rawCalibration.frozenPolicySha256,
    tournamentValueModelSha256: rawCalibration.tournamentValueModelSha256,
    tournamentValueReportSha256: rawCalibration.tournamentValueReportSha256,
    basePolicyContract: rawCalibration.basePolicyContract,
    baseStyleKey: rawCalibration.baseStyleKey,
    minLowerBound,
    advantageTemperature,
    maxLogitShift,
    records,
    summary: {
      calibratedRoots: Object.keys(records).length,
      actionableRoots: Object.values(records).filter((record) => record.actionableActions.length).length,
      actionableActions: Object.values(records).reduce(
        (sum, record) => sum + record.actionableActions.length, 0,
      ),
    },
    promotionEligible: false,
    promotionBlockers: [
      'calibrated-root-coverage-below-threshold',
      'shadow-only-schema-cannot-deploy',
    ],
  };
  return Object.freeze(artifact);
}

export function validateResidualAdvantageGuidance(raw) {
  if (raw?.schema !== RESIDUAL_ADVANTAGE_GUIDANCE_SCHEMA
    || Number(raw?.version) !== RESIDUAL_ADVANTAGE_GUIDANCE_VERSION
    || raw?.mode !== 'shadow-only') {
    throw new TypeError('unsupported residual advantage guidance');
  }
  return raw;
}

export function materializeResidualAdvantageRows(rawGuidance, baseDataset, {
  includeIdentityRows = false,
} = {}) {
  const guidance = validateResidualAdvantageGuidance(rawGuidance);
  if (baseDataset?.schema !== 'qyj-compact-residual-base-rows-v1') {
    throw new TypeError('advantage materialization requires a base-row dataset');
  }
  const rows = [];
  for (const row of baseDataset.rows || []) {
    const record = guidance.records[row.informationSetKey];
    if (!record && !includeIdentityRows) continue;
    const encoded = compactResidualFeatures(row.informationSetKey);
    const actionKeys = blueprintActionKeysForMask(encoded.mask);
    rows.push({
      informationSetKey: row.informationSetKey,
      baseStrategy: row.baseStrategy,
      targetStrategy: record?.targetStrategy || row.baseStrategy,
      sourceGroup: row.sourceGroup,
      targetLevel: record ? 'independent-advantage' : 'exact',
      reachWeight: row.reachWeight,
      independentActionAdvantages: record ? Object.fromEntries(actionKeys.map((action) => [
        action, Math.max(-2, Math.min(2, record.advantages[action].lowerBound)),
      ])) : null,
    });
  }
  if (!rows.length) throw new RangeError('guidance and base rows have no matching roots');
  const artifact = {
    schema: COMPACT_RESIDUAL_ROWS_SCHEMA,
    version: COMPACT_RESIDUAL_ROWS_VERSION,
    profileSchema: 'qyj-exact-infoset-reach-profile-v2',
    profileVersion: 2,
    sourceGroupSecretId: baseDataset.sourceGroupSecretId,
    profileSources: baseDataset.profileSources,
    rows,
  };
  validateCompactResidualRowDataset(artifact);
  return Object.freeze(artifact);
}
