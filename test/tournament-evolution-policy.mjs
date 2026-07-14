import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  TOURNAMENT_EVOLUTION_FEATURES,
  createTournamentEvolutionPolicy,
  evaluateTournamentEvolutionPolicy,
  tournamentEvolutionFeatures,
  validateTournamentEvolutionPolicy,
} from '../training/tournament-policy/evolution-policy.mjs';
import {
  buildSeatAssignments,
  createLineup,
  runMatch,
} from '../training/eval/league.mjs';
import { createSeededRng } from '../training/eval/rng.mjs';
import {
  sampleEvolutionPopulation,
  scoreEvolutionResults,
  scoreEvolutionSeedGroups,
  updateEvolutionDistribution,
} from '../training/tournament-policy/evolution-trainer.mjs';

const profile = JSON.parse(fs.readFileSync(
  'training/profiles/qyj-reach-v45b-train-6.json', 'utf8',
));
const entry = profile.entries.find((candidate) => candidate.exactKey
  && candidate.trainingSnapshot?.legalActions?.canCheck
  && candidate.trainingSnapshot.legalActions.tiers?.length);
assert(entry);
const raise = `raise:${entry.trainingSnapshot.legalActions.tiers[0].key}`;
const legal = ['check', raise];
const zero = createTournamentEvolutionPolicy(
  Array(TOURNAMENT_EVOLUTION_FEATURES.length).fill(0),
  { training: { generations: 0 }, provenance: { seedNamespaceSha256: '0'.repeat(64) } },
);
assert.doesNotThrow(() => validateTournamentEvolutionPolicy(JSON.parse(JSON.stringify(zero))));
assert.equal(tournamentEvolutionFeatures(entry.exactKey).values.length,
  TOURNAMENT_EVOLUTION_FEATURES.length);
assert.deepEqual(evaluateTournamentEvolutionPolicy(zero, {
  informationSetKey: entry.exactKey,
  tableSize: 6,
  baselineActionKey: 'check',
  legalActionKeys: legal,
}), {
  accepted: false,
  reason: 'risk-shift-kept-baseline',
  selectedActionKey: 'check',
  shift: 0,
  rawShift: 0,
  targetRisk: -0.5,
  features: tournamentEvolutionFeatures(entry.exactKey).values,
});

const aggressiveWeights = Array(TOURNAMENT_EVOLUTION_FEATURES.length).fill(0);
aggressiveWeights[0] = 1.2;
const aggressive = createTournamentEvolutionPolicy(aggressiveWeights, {
  training: { generations: 1 }, provenance: { seedNamespaceSha256: '1'.repeat(64) },
});
const changed = evaluateTournamentEvolutionPolicy(aggressive, {
  informationSetKey: entry.exactKey,
  tableSize: 6,
  baselineActionKey: 'check',
  legalActionKeys: legal,
});
assert.equal(changed.accepted, true);
assert.equal(changed.selectedActionKey, raise);
const gated = createTournamentEvolutionPolicy(aggressiveWeights, {
  interventionThreshold: 1.3,
  training: { generations: 1 }, provenance: { seedNamespaceSha256: '2'.repeat(64) },
});
assert.deepEqual(evaluateTournamentEvolutionPolicy(gated, {
  informationSetKey: entry.exactKey,
  tableSize: 6,
  baselineActionKey: 'check',
  legalActionKeys: legal,
}), {
  accepted: false,
  reason: 'risk-shift-below-intervention-threshold',
  selectedActionKey: 'check',
  shift: 1.2,
  rawShift: 1.2,
  targetRisk: 0.7,
  features: tournamentEvolutionFeatures(entry.exactKey).values,
});
assert.equal(evaluateTournamentEvolutionPolicy(aggressive, {
  informationSetKey: entry.exactKey,
  tableSize: 9,
  baselineActionKey: 'check',
  legalActionKeys: legal,
}).reason, 'invalid-or-unsupported-state');

const lineup = createLineup([
  { strategy: 'online-resolver-evolution-candidate', id: 'candidate' },
  'qyz', 'qyz-tight', 'qyz-aggressive', 'qyz-loose', 'calling-station',
], 6);
const assignment = buildSeatAssignments(lineup, { rotations: 1, mirror: false })[0];
const zeroMatch = runMatch({
  assignment,
  seed: 'tournament-evolution-integration',
  strategyModels: new Map([['candidate', zero]]),
});
const zeroResult = zeroMatch.results.find((result) => result.entryId === 'candidate');
assert.equal(zeroMatch.errorCount, 0);
assert(zeroResult.actions.onlineResolverDecisions > 0);
assert.equal(zeroResult.actions.onlineResolverActionChanges, 0,
  'zero weights must reproduce QYZ exactly');

const changedMatch = runMatch({
  assignment,
  seed: 'tournament-evolution-integration',
  strategyModels: new Map([['candidate', aggressive]]),
});
const changedResult = changedMatch.results.find((result) => result.entryId === 'candidate');
assert.equal(changedMatch.errorCount, 0);
assert(changedResult.actions.onlineResolverActionChanges > 0,
  'an injected contextual shift must reach real Engine decisions');

const sampled = sampleEvolutionPopulation([0, 0], [0.5, 0.5], {
  populationSize: 4,
  rng: createSeededRng('evolution-test'),
});
assert.deepEqual(sampled, sampleEvolutionPopulation([0, 0], [0.5, 0.5], {
  populationSize: 4,
  rng: createSeededRng('evolution-test'),
}));
assert(Math.abs(sampled[0][0] + sampled[1][0]) < 1e-12
  && Math.abs(sampled[0][1] + sampled[1][1]) < 1e-12,
'evolution perturbations must be antithetic');
const update = updateEvolutionDistribution(sampled, [
  { id: 'a', fitness: 4 }, { id: 'b', fitness: 1 },
  { id: 'c', fitness: 3 }, { id: 'd', fitness: 2 },
]);
assert.equal(update.eliteCount, 2);
assert.deepEqual(update.elites.map((elite) => elite.id), ['a', 'c']);
const syntheticScore = scoreEvolutionResults([{
  errorCount: 0,
  fullSchedule: true,
  results: [
    { entryId: 'candidate', rank: 1, hp: 2600,
      actions: { onlineResolverDecisions: 10, onlineResolverActionChanges: 2 } },
    { entryId: 'baseline', rank: 4, hp: 1200, actions: {} },
  ],
}], { candidateId: 'candidate', baselineId: 'baseline', tableSize: 6 });
assert(syntheticScore.rankAdvantage > 0 && syntheticScore.hpAdvantage > 0
  && syntheticScore.fitness > 0);
assert.equal(syntheticScore.changeRate, 0.2);
assert.doesNotThrow(() => scoreEvolutionResults([{
  errorCount: 0,
  fullSchedule: false,
  naturalEarlyFinish: true,
  results: [
    { entryId: 'candidate', rank: 1, hp: 3000, actions: {} },
    { entryId: 'baseline', rank: 2, hp: 0, actions: {} },
  ],
}], { candidateId: 'candidate', baselineId: 'baseline', tableSize: 6 }));
const robust = scoreEvolutionSeedGroups([[{
  errorCount: 0, fullSchedule: true,
  results: [
    { entryId: 'candidate', rank: 1, hp: 2400, actions: {} },
    { entryId: 'baseline', rank: 3, hp: 1300, actions: {} },
  ],
}], [{
  errorCount: 0, fullSchedule: true,
  results: [
    { entryId: 'candidate', rank: 2, hp: 2100, actions: {} },
    { entryId: 'baseline', rank: 3, hp: 1500, actions: {} },
  ],
}]], { candidateId: 'candidate', baselineId: 'baseline', tableSize: 6 });
assert(robust.robustRank > 0 && robust.robustHp > 0 && robust.fitness > 0);

console.log('tournament evolution policy tests passed');
