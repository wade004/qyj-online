import assert from 'node:assert/strict';

import {
  buildRolloutValueCalibrator,
  evaluateRolloutValueCalibrator,
  validateRolloutValueCalibrator,
} from '../training/eval/rollout-value-calibrator.mjs';

const records = [];
for (const tableSize of [6, 9]) {
  for (let cluster = 0; cluster < 8; cluster++) {
    for (let copy = 0; copy < 2; copy++) records.push({
      sampleId: `${tableSize}-${cluster}-${copy}`,
      clusterId: `c-${tableSize}-${cluster}`,
      tableSize,
      street: copy ? 'turn' : 'river',
      mask: '42',
      features: { h: 'c3-d0', stk: copy ? 'm' : 's', p: 'late' },
      baseActionKey: 'check',
      actionKey: copy ? 'raise:feint' : 'allin',
      pot: 1000,
      screen: { mean: copy ? 100 : 20, lowerBound: copy ? 60 : 5 },
      confirmation: { mean: copy ? 120 : 10, lowerBound: copy ? 70 : 2 },
      outcome: { hpAdvantage: copy ? 300 : -500, rankAdvantage: copy ? 1 : -1 },
    });
  }
}
const datasets = [6, 9].map((tableSize) => ({
  schema: 'qyj-rollout-intervention-outcomes-v1',
  version: 1,
  mode: 'offline-evaluation-only',
  split: 'training',
  tableSize,
  resolverStrategyKey: 'online-resolver-v19-table-powered',
  sourceGroupSecretId: 'test',
  resolverDecisionCount: 1200,
  records: records.filter((record) => record.tableSize === tableSize),
}));
const calibrator = buildRolloutValueCalibrator(datasets);
assert.equal(calibrator.calibration.passed, true);
assert.equal(validateRolloutValueCalibrator(calibrator), calibrator);
assert.equal(evaluateRolloutValueCalibrator(calibrator, records[1]).eligible, true);
assert.equal(evaluateRolloutValueCalibrator(calibrator, records[0]).eligible, false);
assert.equal(evaluateRolloutValueCalibrator(calibrator, {
  baseActionKey: 'check', actionKey: 'check',
}).eligible, true);

console.log('rollout value calibrator tests passed');
