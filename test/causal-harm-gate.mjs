import assert from 'node:assert/strict';

import {
  buildCausalHarmGate,
  evaluateCausalHarmGate,
  validateCausalHarmGate,
} from '../training/eval/causal-harm-gate.mjs';

const record = (clusterId, tableSize, hpAdvantage, rankAdvantage, actionKey = 'allin') => ({
  sampleId: `${clusterId}-${tableSize}-${actionKey}`,
  clusterId,
  tableSize,
  street: 'turn',
  mask: '1',
  features: { h: 'c1-d0', b: 'hi-w0-p0-m0', stk: 'm', spr: '1', p: 'late' },
  baseActionKey: 'check',
  actionKey,
  pot: 1000,
  screen: { mean: 80, lowerBound: 30 },
  confirmation: { mean: 60, lowerBound: 20 },
  outcome: { hpAdvantage, rankAdvantage },
});
const records = [];
for (const tableSize of [6, 9]) {
  for (let index = 0; index < 6; index++) {
    records.push(record(`c${tableSize}-${index}`, tableSize, -400 - index * 10, -1));
    for (let copy = 0; copy < 3; copy++) {
      const beneficial = record(
        `c${tableSize}-${index}`, tableSize, 300, 1, 'raise:feint',
      );
      beneficial.sampleId += `-${copy}`;
      records.push(beneficial);
    }
  }
}
const dataset = {
  schema: 'qyj-rollout-intervention-outcomes-v1',
  version: 1,
  mode: 'offline-evaluation-only',
  split: 'training',
  tableSize: 6,
  resolverStrategyKey: 'online-resolver-v19-table-powered',
  sourceGroupSecretId: 'test-secret-id',
  records,
};
const gate = buildCausalHarmGate([dataset], {
  grid: [{
    bandwidth: 0.5,
    neighbors: 5,
    minClusters: 4,
    z: 0,
    hpHarmUpper: -0.02,
    rankHarmUpper: -0.01,
    hpNeutral: 0.08,
    rankNeutral: 0.025,
  }],
});
assert.equal(gate.calibration.passed, true);
assert.equal(validateCausalHarmGate(gate), gate);
const harmful = evaluateCausalHarmGate(gate, record('query', 6, 0, 0));
assert.equal(harmful.eligible, false);
assert.equal(harmful.reason, 'cluster-causal-harm-predicted');
const beneficial = evaluateCausalHarmGate(gate, record('query', 6, 0, 0, 'raise:feint'));
assert.equal(beneficial.eligible, true);
assert.equal(evaluateCausalHarmGate(gate, {
  baseActionKey: 'check', actionKey: 'check',
}).eligible, true);

console.log('causal harm gate tests passed');
