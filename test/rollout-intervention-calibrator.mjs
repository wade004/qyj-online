import assert from 'node:assert/strict';

import {
  buildRolloutInterventionCalibrator,
  evaluateRolloutInterventionCalibrator,
  evaluateRolloutInterventionTest,
} from '../training/eval/rollout-intervention-calibrator.mjs';

const secret = 'ri_fixture';
const dataset = (split, tableSize, prefix, records, resolverDecisionCount = 100) => ({
  schema: 'qyj-rollout-intervention-outcomes-v1',
  version: 1,
  mode: 'offline-evaluation-only',
  split,
  tableSize,
  resolverStrategyKey: 'online-resolver-v19-table-powered',
  sourceGroupSecretId: secret,
  resolverDecisionCount,
  records: records.map((record, index) => ({
    sampleId: `${prefix}-${index}`,
    clusterId: `${prefix}-cluster-${index}`,
    tableSize,
    street: 'turn',
    baseActionKey: record.baseActionKey,
    actionKey: record.actionKey,
    outcome: { rankAdvantage: record.rank, hpAdvantage: record.hp },
  })),
});
const bad = (count) => Array.from({ length: count }, () => ({
  baseActionKey: 'check', actionKey: 'allin', rank: 0, hp: -100,
}));
const good = (count) => Array.from({ length: count }, () => ({
  baseActionKey: 'check', actionKey: 'raise:strike', rank: 0.2, hp: 50,
}));
const training = [
  dataset('training', 6, 'tr6', bad(4)),
  dataset('training', 9, 'tr9', bad(4)),
];
const calibration = [
  dataset('calibration', 6, 'ca6', bad(2)),
  dataset('calibration', 9, 'ca9', bad(2)),
];
const calibrator = buildRolloutInterventionCalibrator(training, calibration);
assert.equal(calibrator.rules.length, 2);
assert.equal(evaluateRolloutInterventionCalibrator(calibrator, {
  tableSize: 6, street: 'turn', baseActionKey: 'check', actionKey: 'allin',
}).eligible, false);
assert.equal(evaluateRolloutInterventionCalibrator(calibrator, {
  tableSize: 6, street: 'turn', baseActionKey: 'check', actionKey: 'raise:strike',
}).eligible, true);

const test = [
  dataset('test', 6, 'te6', [...bad(2), ...good(2)], 200),
  dataset('test', 9, 'te9', [...bad(2), ...good(2)], 200),
];
const report = evaluateRolloutInterventionTest(calibrator, test);
assert.equal(report.passed, true);
assert(report.byTable.every((row) => row.coverage === 0.01 && row.rejectedInterventions === 2));

assert.throws(() => buildRolloutInterventionCalibrator(
  training,
  [dataset('calibration', 6, 'tr6', bad(2))],
), /overlapping seed clusters/);

console.log('rollout intervention calibrator tests passed');
