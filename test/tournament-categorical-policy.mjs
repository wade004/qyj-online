import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  TOURNAMENT_CATEGORICAL_FACTORS,
  createTournamentCategoricalPolicy,
  evaluateTournamentCategoricalPolicy,
  validateTournamentCategoricalPolicy,
} from '../training/tournament-policy/categorical-policy.mjs';
import { TOURNAMENT_EVOLUTION_FEATURES } from '../training/tournament-policy/evolution-policy.mjs';
import { buildSeatAssignments, createLineup, runMatch } from '../training/eval/league.mjs';

const profile = JSON.parse(fs.readFileSync('training/profiles/qyj-reach-v45b-train-6.json', 'utf8'));
const entry = profile.entries.find((candidate) => candidate.exactKey
  && candidate.trainingSnapshot?.legalActions?.canCheck
  && candidate.trainingSnapshot.legalActions.tiers?.length);
assert(entry);
const raise = `raise:${entry.trainingSnapshot.legalActions.tiers[0].key}`;
const dimensions = TOURNAMENT_EVOLUTION_FEATURES.length * TOURNAMENT_CATEGORICAL_FACTORS.length;
const zero = createTournamentCategoricalPolicy(Array(dimensions).fill(0), {
  provenance: { seedNamespaceSha256: '0'.repeat(64) },
});
assert.doesNotThrow(() => validateTournamentCategoricalPolicy(JSON.parse(JSON.stringify(zero))));
const unchanged = evaluateTournamentCategoricalPolicy(zero, {
  informationSetKey: entry.exactKey,
  tableSize: 6,
  baselineActionKey: 'check',
  legalActionKeys: ['check', raise],
});
assert.equal(unchanged.accepted, false);
assert.equal(unchanged.selectedActionKey, 'check');
const initiative = Array(dimensions).fill(0);
initiative[2 * TOURNAMENT_EVOLUTION_FEATURES.length] = 1;
const active = createTournamentCategoricalPolicy(initiative, {
  provenance: { seedNamespaceSha256: '1'.repeat(64) },
});
const changed = evaluateTournamentCategoricalPolicy(active, {
  informationSetKey: entry.exactKey,
  tableSize: 6,
  baselineActionKey: 'check',
  legalActionKeys: ['check', raise],
});
assert.equal(changed.accepted, true);
assert.equal(changed.selectedActionKey, raise);
assert.equal(changed.factors.length, 3);
assert.equal(changed.candidates.length, 2);
assert(changed.candidates.every((candidate) => Number.isFinite(candidate.score)));
const lineup = createLineup([
  { strategy: 'online-resolver-categorical-explorer', id: 'explorer' },
  'qyz', 'qyz-tight', 'qyz-aggressive', 'qyz-loose', 'calling-station',
], 6);
const traces = [];
const match = runMatch({
  assignment: buildSeatAssignments(lineup, { rotations: 1, mirror: false })[0],
  seed: 'categorical-exploration-integration',
  strategyModels: new Map([['explorer', createTournamentCategoricalPolicy(
    Array(dimensions).fill(0), {
      training: { samplingTemperature: 0.18 },
      provenance: { seedNamespaceSha256: '3'.repeat(64) },
    },
  )]]),
  onDecisionTrace: (trace) => {
    if (trace.entryId === 'explorer') traces.push(trace);
  },
});
assert.equal(match.errorCount, 0);
assert(traces.length > 0);
assert(traces.every((trace) => trace.behaviorPolicy === 'qyj-factorized-categorical-softmax-v1'
  && trace.behaviorProbability > 0 && trace.behaviorProbability <= 1
  && trace.behaviorSupportActionKeys.includes(trace.actionKey)));
console.log('tournament categorical policy tests passed');
