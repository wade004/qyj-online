import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  TOURNAMENT_NEURAL_FEATURES,
  createTournamentNeuralPolicy,
  evaluateTournamentNeuralPolicy,
  validateTournamentNeuralPolicy,
} from '../training/tournament-policy/neural-policy.mjs';
import { TOURNAMENT_CATEGORICAL_FACTORS } from '../training/tournament-policy/categorical-policy.mjs';
import { buildSeatAssignments, createLineup, runMatch } from '../training/eval/league.mjs';

const profile = JSON.parse(fs.readFileSync('training/profiles/qyj-reach-v45b-train-6.json', 'utf8'));
const entry = profile.entries.find((candidate) => candidate.exactKey
  && candidate.trainingSnapshot?.legalActions?.canCheck
  && candidate.trainingSnapshot.legalActions.tiers?.length);
assert(entry);
const raise = `raise:${entry.trainingSnapshot.legalActions.tiers[0].key}`;
const hiddenSize = 2;
const zeroActor = {
  inputWeights: Array(hiddenSize * TOURNAMENT_NEURAL_FEATURES.length).fill(0),
  hiddenBias: Array(hiddenSize).fill(0),
  outputWeights: Array(hiddenSize * TOURNAMENT_CATEGORICAL_FACTORS.length).fill(0),
  outputBias: Array(TOURNAMENT_CATEGORICAL_FACTORS.length).fill(0),
};
const zero = createTournamentNeuralPolicy(zeroActor, {
  hiddenSize,
  provenance: { seedNamespaceSha256: '0'.repeat(64) },
});
assert.doesNotThrow(() => validateTournamentNeuralPolicy(JSON.parse(JSON.stringify(zero))));
const unchanged = evaluateTournamentNeuralPolicy(zero, {
  informationSetKey: entry.exactKey,
  memory: { decisions: 4, folds: 1, calls: 1, aggressive: 2, currentHp: 1800 },
  tableSize: 6,
  baselineActionKey: 'check',
  legalActionKeys: ['check', raise],
});
assert.equal(unchanged.accepted, false);
assert.equal(unchanged.inputs.length, TOURNAMENT_NEURAL_FEATURES.length);

const activeActor = JSON.parse(JSON.stringify(zeroActor));
activeActor.inputWeights[0] = 1;
activeActor.outputWeights[2 * hiddenSize] = 2;
const active = createTournamentNeuralPolicy(activeActor, {
  hiddenSize,
  provenance: { seedNamespaceSha256: '1'.repeat(64) },
});
const changed = evaluateTournamentNeuralPolicy(active, {
  informationSetKey: entry.exactKey,
  tableSize: 6,
  baselineActionKey: 'check',
  legalActionKeys: ['check', raise],
});
assert.equal(changed.accepted, true);
assert.equal(changed.selectedActionKey, raise);

const lineup = createLineup([
  { strategy: 'online-resolver-neural-explorer', id: 'explorer' },
  'qyz', 'qyz-tight', 'qyz-aggressive', 'qyz-loose', 'calling-station',
], 6);
const traces = [];
const match = runMatch({
  assignment: buildSeatAssignments(lineup, { rotations: 1, mirror: false })[0],
  seed: 'neural-policy-integration',
  strategyModels: new Map([['explorer', createTournamentNeuralPolicy(zeroActor, {
    hiddenSize,
    training: { samplingTemperature: 0.18 },
    provenance: { seedNamespaceSha256: '2'.repeat(64) },
  })]]),
  onDecisionTrace: (trace) => {
    if (trace.entryId === 'explorer') traces.push(trace);
  },
});
assert.equal(match.errorCount, 0);
assert(traces.length > 1);
assert(traces.every((trace) => trace.behaviorPolicy === 'qyj-tournament-memory-neural-softmax-v1'
  && trace.policyFeatures?.length === TOURNAMENT_NEURAL_FEATURES.length
  && trace.behaviorProbability > 0 && trace.behaviorProbability <= 1));
const decisionDepthIndex = TOURNAMENT_NEURAL_FEATURES.indexOf('decisionDepth');
assert.equal(traces[0].policyFeatures[decisionDepthIndex], 0);
assert(traces.slice(1).some((trace) => trace.policyFeatures[decisionDepthIndex] > 0));
console.log('tournament neural policy tests passed');
