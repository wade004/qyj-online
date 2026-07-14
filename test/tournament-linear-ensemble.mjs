import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  evaluateTournamentLinearEnsemble,
  trainTournamentLinearEnsemble,
  validateTournamentLinearEnsemble,
} from '../training/tournament-policy/linear-ensemble-model.mjs';

const profile = JSON.parse(fs.readFileSync(
  'training/profiles/qyj-reach-v45b-train-6.json', 'utf8',
));
const entry = profile.entries.find((candidate) => (
  candidate.exactKey && candidate.trainingSnapshot?.legalActions?.canCheck
  && candidate.trainingSnapshot.legalActions.tiers?.length
));
assert(entry);
const baselineActionKey = 'check';
const candidateActionKey = `raise:${entry.trainingSnapshot.legalActions.tiers[0].key}`;
const legalActionKeys = [baselineActionKey, candidateActionKey];
const rows = [];
for (let group = 1; group <= 8; group++) {
  for (let sample = 1; sample <= 8; sample++) {
    for (const [actionKey, reward] of [
      [baselineActionKey, -0.6], [candidateActionKey, 0.6],
    ]) {
      rows.push({
        rowId: `row-${group}-${sample}-${actionKey}`,
        sourceGroup: `group-${group}`,
        matchId: `match-${group}-${sample}`,
        trajectoryId: `trajectory-${group}-${sample}-${actionKey}`,
        tableSize: 6,
        informationSetKey: entry.exactKey,
        legalActionKeys,
        actionKey,
        actionPropensity: 0.5,
        rankValue: reward,
        hpValue: reward,
      });
    }
  }
}
const dataset = {
  schema: 'qyj-tournament-trajectory-dataset-v1',
  version: 1,
  secretId: 'linear-ensemble-test-secret',
  sourceNamespaceSha256: 'linear-ensemble-test-namespace',
  rows,
};
const options = {
  tableSize: 6,
  dimensions: 32,
  epochs: 30,
  learningRate: 0.03,
  minGroups: 8,
  minActionSamples: 8,
  minAdvantage: 0,
};
const first = trainTournamentLinearEnsemble(dataset, options);
const second = trainTournamentLinearEnsemble(structuredClone(dataset), options);
assert.deepEqual(second, first, 'linear ensemble training must be deterministic');
assert.doesNotThrow(() => validateTournamentLinearEnsemble(
  JSON.parse(JSON.stringify(first)),
));
const prediction = evaluateTournamentLinearEnsemble(first, {
  informationSetKey: entry.exactKey,
  tableSize: 6,
  baselineActionKey,
  legalActionKeys,
});
assert.equal(prediction.accepted, true);
assert.equal(prediction.selected.actionKey, candidateActionKey);
assert(prediction.selected.rank.lower95 > 0 && prediction.selected.hp.lower95 > 0);
assert.equal(evaluateTournamentLinearEnsemble(first, {
  informationSetKey: entry.exactKey,
  tableSize: 6,
  baselineActionKey: 'fold',
  legalActionKeys: ['fold', 'call'],
}).reason, 'baseline-extreme-protected');
assert.equal(evaluateTournamentLinearEnsemble(first, {
  informationSetKey: entry.exactKey,
  tableSize: 9,
  baselineActionKey,
  legalActionKeys,
}).accepted, false);

console.log('tournament linear ensemble tests passed');
