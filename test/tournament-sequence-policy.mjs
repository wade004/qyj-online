import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  evaluateTournamentSequencePolicy,
  trainTournamentSequencePolicy,
  validateTournamentSequencePolicy,
} from '../training/tournament-policy/sequence-model.mjs';

const profile = JSON.parse(fs.readFileSync(
  'training/profiles/qyj-reach-v45b-train-6.json', 'utf8',
));
const entry = profile.entries.find((candidate) => candidate.exactKey
  && candidate.trainingSnapshot?.legalActions);
assert(entry);
const legal = [
  ...(entry.trainingSnapshot.legalActions.canCheck ? ['check'] : ['fold', 'call']),
  ...entry.trainingSnapshot.legalActions.tiers.map((tier) => `raise:${tier.key}`),
  ...(entry.trainingSnapshot.legalActions.canAllIn ? ['allin'] : []),
];
const [baselineActionKey, candidateActionKey] = legal;
assert(candidateActionKey);
const rows = [];
for (let group = 1; group <= 4; group++) {
  for (const [kind, firstAction, continuationAction, reward] of [
    ['base', baselineActionKey, baselineActionKey, -0.5],
    ['candidate', candidateActionKey, candidateActionKey, 0.5],
  ]) {
    const trajectoryId = `trajectory-${group}-${kind}`;
    for (const [offset, actionKey] of [firstAction, continuationAction].entries()) {
      rows.push({
        rowId: `${trajectoryId}-${offset}`,
        sourceGroup: `group-${group}`,
        matchId: `match-${group}-${kind}`,
        trajectoryId,
        playerDecisionIndex: offset + 1,
        tableSize: 6,
        informationSetKey: entry.exactKey,
        legalActionKeys: legal,
        actionKey,
        actionPropensity: 0.2,
        round: 1,
        street: 'preflop',
        rankValue: reward,
        hpValue: reward,
      });
    }
  }
}
const dataset = {
  version: 1,
  secretId: 'sequence-test-secret',
  sourceNamespaceSha256: 'sequence-test-namespace',
  rows,
};
const options = { minGroups: 4, minSamples: 4, minAdvantage: 0.02 };
const first = trainTournamentSequencePolicy(dataset, options);
const second = trainTournamentSequencePolicy(structuredClone(dataset), options);
assert.deepEqual(second, first);
assert.doesNotThrow(() => validateTournamentSequencePolicy(
  JSON.parse(JSON.stringify(first)),
));
const prediction = evaluateTournamentSequencePolicy(first, {
  informationSetKey: entry.exactKey,
  tableSize: 6,
  baselineActionKey,
  legalActionKeys: legal,
});
assert.equal(prediction.accepted, true);
assert.equal(prediction.selected.firstActionKey, candidateActionKey);
assert.equal(prediction.selected.continuationActionKey, candidateActionKey);
assert(prediction.selected.lowerBound > 0);
assert.equal(evaluateTournamentSequencePolicy(first, {
  informationSetKey: entry.exactKey,
  tableSize: 9,
  baselineActionKey,
  legalActionKeys: legal,
}).accepted, false);

console.log('tournament sequence policy tests passed');
