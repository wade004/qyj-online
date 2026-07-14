import assert from 'node:assert/strict';

import {
  buildSeatAssignments,
  createLineup,
  runMatch,
} from '../training/eval/league.mjs';
import { deriveSeed } from '../training/eval/rng.mjs';

const tableSize = 6;
const rawGroup = 'qyj-v120-contract-smoke|table=6|group=1';
const lineup = createLineup(Array(tableSize).fill('qyz-v120-explorer'), tableSize);
const [assignment] = buildSeatAssignments(lineup, { rotations: 1, mirror: false });
const traces = [];
const match = runMatch({
  assignment,
  seed: deriveSeed(rawGroup, 'deal'),
  seedGroup: rawGroup,
  tableSize,
  skillsEnabled: false,
  onDecisionTrace: (trace) => traces.push(trace),
});
assert.equal(match.errorCount, 0);
assert.equal(match.fullSchedule, true);
assert(traces.length > 0);
for (const trace of traces) {
  assert.equal(trace.behaviorPolicy, 'qyz-bounded-epsilon-exploration-v1');
  assert(trace.legalActionKeys.includes(trace.actionKey));
  assert(!trace.behaviorSupportActionKeys.includes('allin'));
  const support = trace.behaviorSupportActionKeys;
  const baseSupported = support.includes(trace.behaviorBaselineActionKey);
  const expected = trace.actionKey === trace.behaviorBaselineActionKey
    ? 0.6 + (baseSupported ? 0.4 / support.length : 0)
    : 0.4 / support.length;
  assert(Math.abs(trace.behaviorProbability - expected) < 1e-12);
  if (trace.behaviorExplored) assert(support.includes(trace.actionKey));
}

console.log('bounded tournament exploration propensity tests passed');
