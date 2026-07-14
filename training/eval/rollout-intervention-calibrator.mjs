import { createHash } from 'node:crypto';

export const ROLLOUT_INTERVENTION_DATASET_SCHEMA =
  'qyj-rollout-intervention-outcomes-v1';
export const ROLLOUT_INTERVENTION_CALIBRATOR_SCHEMA =
  'qyj-rollout-intervention-calibrator-v1';

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

function interval(values) {
  if (!values.length) return { mean: null, lowerBound: null, upperBound: null };
  const average = mean(values);
  if (values.length < 2) {
    return { mean: average, lowerBound: null, upperBound: null };
  }
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0)
    / (values.length - 1);
  const t95 = 1.644854 + 0.710 / (values.length - 1);
  const margin = t95 * Math.sqrt(variance / values.length);
  return { mean: average, lowerBound: average - margin, upperBound: average + margin };
}

function validateDataset(raw, split) {
  if (raw?.schema !== ROLLOUT_INTERVENTION_DATASET_SCHEMA
    || Number(raw?.version) !== 1 || raw?.mode !== 'offline-evaluation-only'
    || ![6, 9].includes(Number(raw?.tableSize)) || raw?.split !== split
    || !Array.isArray(raw?.records) || typeof raw?.sourceGroupSecretId !== 'string') {
    throw new TypeError(`unsupported ${split} rollout intervention dataset`);
  }
  return raw;
}

function actionPair(record) {
  return `${record.baseActionKey}=>${record.actionKey}`;
}

function clusterEffects(records) {
  const buckets = new Map();
  for (const record of records) {
    const id = String(record.clusterId);
    const bucket = buckets.get(id) || { rank: [], hp: [] };
    bucket.rank.push(Number(record.outcome.rankAdvantage));
    bucket.hp.push(Number(record.outcome.hpAdvantage));
    buckets.set(id, bucket);
  }
  const clusters = [...buckets].map(([clusterId, bucket]) => ({
    clusterId,
    rankAdvantage: mean(bucket.rank),
    hpAdvantage: mean(bucket.hp),
    samples: bucket.hp.length,
  })).sort((left, right) => left.clusterId.localeCompare(right.clusterId));
  return {
    clusters,
    samples: records.length,
    rank: interval(clusters.map((cluster) => cluster.rankAdvantage)),
    hp: interval(clusters.map((cluster) => cluster.hpAdvantage)),
  };
}

function groupByStreetAndPair(datasets) {
  const groups = new Map();
  for (const dataset of datasets) {
    for (const record of dataset.records) {
      if (Number(record.tableSize) !== Number(dataset.tableSize)
        || !record.baseActionKey || !record.actionKey
        || record.baseActionKey === record.actionKey
        || !record.outcome || !record.clusterId) continue;
      if (!['flop', 'turn', 'river'].includes(record.street)) continue;
      const key = `${dataset.tableSize}|${record.street}|${actionPair(record)}`;
      const group = groups.get(key) || {
        tableSize: Number(dataset.tableSize),
        street: record.street,
        baseActionKey: record.baseActionKey,
        actionKey: record.actionKey,
        records: [],
      };
      group.records.push(record);
      groups.set(key, group);
    }
  }
  return groups;
}

function assertDisjoint(left, right, names) {
  const leftClusters = new Set(left.flatMap((dataset) => (
    dataset.records.map((record) => record.clusterId)
  )));
  for (const dataset of right) {
    if (dataset.records.some((record) => leftClusters.has(record.clusterId))) {
      throw new RangeError(`${names} datasets contain overlapping seed clusters`);
    }
  }
}

export function buildRolloutInterventionCalibrator(trainingInputs, calibrationInputs, {
  resolverStrategyKey = 'online-resolver-v19-table-powered',
  minTrainingClusters = 4,
  minCalibrationClusters = 2,
  maxTrainingHpUpperBound = 0,
  maxTrainingRankUpperBound = 0,
  maxCalibrationHpMean = 0,
  maxCalibrationRankMean = 0,
} = {}) {
  const training = (Array.isArray(trainingInputs) ? trainingInputs : [trainingInputs])
    .map((raw) => validateDataset(raw, 'training'));
  const calibration = (Array.isArray(calibrationInputs) ? calibrationInputs : [calibrationInputs])
    .map((raw) => validateDataset(raw, 'calibration'));
  if (!training.length || !calibration.length
    || [...training, ...calibration].some(
      (dataset) => dataset.resolverStrategyKey !== resolverStrategyKey,
    )) {
    throw new RangeError('calibrator datasets must bind the requested resolver strategy');
  }
  const secretIds = new Set([...training, ...calibration]
    .map((dataset) => dataset.sourceGroupSecretId));
  if (secretIds.size !== 1) {
    throw new RangeError('calibrator datasets must use one cluster-id secret');
  }
  assertDisjoint(training, calibration, 'training/calibration');
  const trainingGroups = groupByStreetAndPair(training);
  const calibrationGroups = groupByStreetAndPair(calibration);
  const rules = [];
  const audit = [];
  for (const [key, group] of [...trainingGroups].sort()) {
    const trainingEvidence = clusterEffects(group.records);
    const calibrationGroup = calibrationGroups.get(key);
    const calibrationEvidence = clusterEffects(calibrationGroup?.records || []);
    const discovered = trainingEvidence.clusters.length >= minTrainingClusters
      && trainingEvidence.hp.upperBound != null
      && trainingEvidence.rank.upperBound != null
      && trainingEvidence.hp.upperBound <= maxTrainingHpUpperBound
      && trainingEvidence.rank.upperBound <= maxTrainingRankUpperBound;
    const confirmed = discovered
      && calibrationEvidence.clusters.length >= minCalibrationClusters
      && calibrationEvidence.hp.mean < maxCalibrationHpMean
      && calibrationEvidence.rank.mean <= maxCalibrationRankMean;
    audit.push({
      tableSize: group.tableSize,
      street: group.street,
      baseActionKey: group.baseActionKey,
      actionKey: group.actionKey,
      discovered,
      confirmed,
      training: trainingEvidence,
      calibration: calibrationEvidence,
    });
    if (confirmed) rules.push(Object.freeze({
      tableSize: group.tableSize,
      street: group.street,
      baseActionKey: group.baseActionKey,
      actionKey: group.actionKey,
      reason: 'independent-real-engine-harm-confirmed',
      trainingIndependentClusters: trainingEvidence.clusters.length,
      calibrationIndependentClusters: calibrationEvidence.clusters.length,
      trainingHpUpperBound: trainingEvidence.hp.upperBound,
      trainingRankUpperBound: trainingEvidence.rank.upperBound,
      calibrationHpMean: calibrationEvidence.hp.mean,
      calibrationRankMean: calibrationEvidence.rank.mean,
    }));
  }
  return Object.freeze({
    schema: ROLLOUT_INTERVENTION_CALIBRATOR_SCHEMA,
    version: 1,
    mode: 'offline-evaluation-only',
    resolverStrategyKey,
    datasetSha256: Object.freeze({
      training: training.map(sha).sort(),
      calibration: calibration.map(sha).sort(),
    }),
    developmentClusterSha256: Object.freeze([...new Set(
      [...training, ...calibration].flatMap((dataset) => (
        dataset.records.map((record) => sha(String(record.clusterId)))
      )),
    )].sort()),
    sourceGroupSecretId: [...secretIds][0],
    thresholds: Object.freeze({
      minTrainingClusters,
      minCalibrationClusters,
      maxTrainingHpUpperBound,
      maxTrainingRankUpperBound,
      maxCalibrationHpMean,
      maxCalibrationRankMean,
    }),
    rules: Object.freeze(rules),
    audit: Object.freeze(audit),
    promotionEligible: false,
    promotionBlockers: Object.freeze([
      'calibrator-requires-untouched-test-evaluation',
      'offline-evaluation-only',
    ]),
  });
}

export function validateRolloutInterventionCalibrator(raw, { resolverStrategyKey } = {}) {
  if (raw?.schema !== ROLLOUT_INTERVENTION_CALIBRATOR_SCHEMA
    || Number(raw?.version) !== 1 || raw?.mode !== 'offline-evaluation-only'
    || !Array.isArray(raw?.rules) || !raw?.thresholds
    || !Array.isArray(raw?.developmentClusterSha256)
    || typeof raw?.resolverStrategyKey !== 'string') {
    throw new TypeError('unsupported rollout intervention calibrator');
  }
  if (resolverStrategyKey && raw.resolverStrategyKey !== resolverStrategyKey) {
    throw new RangeError('rollout intervention calibrator strategy mismatch');
  }
  return raw;
}

export function evaluateRolloutInterventionCalibrator(calibrator, {
  tableSize,
  street,
  baseActionKey,
  actionKey,
} = {}) {
  const source = validateRolloutInterventionCalibrator(calibrator);
  if (!baseActionKey || !actionKey || baseActionKey === actionKey) {
    return Object.freeze({ eligible: false, reason: 'unchanged-action' });
  }
  const rule = source.rules.find((candidate) => (
    Number(candidate.tableSize) === Number(tableSize)
    && candidate.street === street
    && candidate.baseActionKey === baseActionKey
    && candidate.actionKey === actionKey
  ));
  return rule
    ? Object.freeze({ eligible: false, reason: rule.reason, rule })
    : Object.freeze({ eligible: true, reason: null });
}

export function evaluateRolloutInterventionTest(calibrator, testInputs, {
  minCoverage = 0.005,
} = {}) {
  const source = validateRolloutInterventionCalibrator(calibrator);
  const tests = (Array.isArray(testInputs) ? testInputs : [testInputs])
    .map((raw) => validateDataset(raw, 'test'));
  if (tests.some((dataset) => dataset.resolverStrategyKey !== source.resolverStrategyKey
    || dataset.sourceGroupSecretId !== source.sourceGroupSecretId)) {
    throw new RangeError('test datasets are not provenance-compatible with calibrator');
  }
  const developmentHashes = new Set([
    ...source.datasetSha256.training,
    ...source.datasetSha256.calibration,
  ]);
  if (tests.some((dataset) => developmentHashes.has(sha(dataset)))) {
    throw new RangeError('test dataset overlaps model-development artifacts');
  }
  const developmentClusters = new Set(source.developmentClusterSha256);
  if (tests.some((dataset) => dataset.records.some(
    (record) => developmentClusters.has(sha(String(record.clusterId))),
  ))) {
    throw new RangeError('test dataset overlaps model-development seed clusters');
  }
  const byTable = [];
  for (const tableSize of [6, 9]) {
    const datasets = tests.filter((dataset) => Number(dataset.tableSize) === tableSize);
    const records = datasets.flatMap((dataset) => dataset.records);
    const kept = records.filter((record) => evaluateRolloutInterventionCalibrator(source, {
      tableSize,
      street: record.street,
      baseActionKey: record.baseActionKey,
      actionKey: record.actionKey,
    }).eligible);
    const rejected = records.filter((record) => !kept.includes(record));
    const evidence = clusterEffects(kept);
    const rejectedEvidence = clusterEffects(rejected);
    const resolverDecisions = datasets.reduce(
      (sum, dataset) => sum + (Number(dataset.resolverDecisionCount) || 0), 0,
    );
    const coverage = resolverDecisions > 0 ? kept.length / resolverDecisions : 0;
    const hasRules = source.rules.some(
      (rule) => Number(rule.tableSize) === tableSize,
    );
    const rejectedRuleConfirmed = !hasRules
      || (rejectedEvidence.clusters.length >= 2
        && rejectedEvidence.hp.mean < 0 && rejectedEvidence.rank.mean <= 0);
    const passed = resolverDecisions > 0 && kept.length > 0 && coverage >= minCoverage
      && evidence.rank.lowerBound != null && evidence.rank.lowerBound >= 0
      && evidence.hp.lowerBound != null && evidence.hp.lowerBound > 0
      && rejectedRuleConfirmed;
    byTable.push({
      tableSize,
      resolverDecisions,
      observedInterventions: records.length,
      keptInterventions: kept.length,
      rejectedInterventions: records.length - kept.length,
      coverage,
      minCoverage,
      evidence,
      rejectedEvidence,
      rejectedRuleConfirmed,
      passed,
    });
  }
  const passed = byTable.every((row) => row.passed);
  return Object.freeze({
    schema: 'qyj-rollout-intervention-test-report-v1',
    version: 1,
    mode: 'offline-evaluation-only',
    calibratorSha256: sha(source),
    testDatasetSha256: Object.freeze(tests.map(sha).sort()),
    byTable: Object.freeze(byTable),
    passed,
    promotionEligible: false,
    promotionBlockers: Object.freeze(passed
      ? ['requires-fresh-balanced-dual-table-league-evaluation', 'offline-evaluation-only']
      : ['untouched-intervention-test-failed', 'offline-evaluation-only']),
  });
}
