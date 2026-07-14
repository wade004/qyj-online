import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  evaluateTournamentPairwiseJackknifeIps,
  evaluateTournamentPairwiseIpsEnsemble,
  trainTournamentPairwiseJackknifeIps,
  trainTournamentPairwiseIpsEnsemble,
  validateTournamentPairwiseJackknifeIps,
  validateTournamentPairwiseIpsEnsemble,
} from '../training/tournament-policy/pairwise-ips-ensemble.mjs';

const profile = JSON.parse(fs.readFileSync(
  'training/profiles/qyj-reach-v45b-train-6.json', 'utf8',
));
const entry = profile.entries.find((candidate) => candidate.exactKey
  && candidate.trainingSnapshot?.legalActions?.canCheck
  && candidate.trainingSnapshot.legalActions.tiers?.length);
assert(entry);
const baselineActionKey = 'check';
const candidateActionKey = `raise:${entry.trainingSnapshot.legalActions.tiers[0].key}`;
const support = [baselineActionKey, candidateActionKey];
const rows = [];
for (let group = 1; group <= 8; group++) {
  for (let sample = 1; sample <= 32; sample++) {
    const actionKey = sample % 2 ? baselineActionKey : candidateActionKey;
    const reward = actionKey === candidateActionKey ? 0.6 : -0.6;
    rows.push({
      rowId: `row-${group}-${sample}`,
      sourceGroup: `group-${group}`,
      matchId: `match-${group}-${sample}`,
      trajectoryId: `trajectory-${group}-${sample}`,
      tableSize: 6,
      informationSetKey: entry.exactKey,
      legalActionKeys: support,
      actionKey,
      actionPropensity: 0.5,
      behaviorBaselineActionKey: baselineActionKey,
      behaviorSupportActionKeys: support,
      behaviorEpsilon: 0.5,
      rankValue: reward,
      hpValue: reward,
    });
  }
}
const dataset = {
  schema: 'qyj-tournament-trajectory-dataset-v1',
  version: 1,
  secretId: 'pairwise-test-secret',
  sourceNamespaceSha256: 'pairwise-test-namespace',
  rows,
};
const options = {
  tableSize: 6, dimensions: 32, epochs: 30, learningRate: 0.03,
  minGroups: 8, minPairSamples: 16, minAdvantage: 0,
};
const first = trainTournamentPairwiseIpsEnsemble(dataset, options);
const second = trainTournamentPairwiseIpsEnsemble(structuredClone(dataset), options);
assert.deepEqual(second, first, 'pairwise IPS training must be deterministic');
assert.doesNotThrow(() => validateTournamentPairwiseIpsEnsemble(
  JSON.parse(JSON.stringify(first)),
));
const prediction = evaluateTournamentPairwiseIpsEnsemble(first, {
  informationSetKey: entry.exactKey,
  tableSize: 6,
  baselineActionKey,
  legalActionKeys: support,
});
assert.equal(prediction.accepted, true);
assert.equal(prediction.selected.actionKey, candidateActionKey);
assert(prediction.selected.rank.lower95 > 0 && prediction.selected.hp.lower95 > 0);
assert.equal(evaluateTournamentPairwiseIpsEnsemble(first, {
  informationSetKey: entry.exactKey,
  tableSize: 6,
  baselineActionKey: 'fold',
  legalActionKeys: ['fold', 'call'],
}).reason, 'baseline-extreme-protected');

const jackknife = trainTournamentPairwiseJackknifeIps(dataset, options);
assert.deepEqual(
  trainTournamentPairwiseJackknifeIps(structuredClone(dataset), options),
  jackknife,
  'pairwise jackknife IPS training must be deterministic',
);
assert.doesNotThrow(() => validateTournamentPairwiseJackknifeIps(
  JSON.parse(JSON.stringify(jackknife)),
));
const jackknifePrediction = evaluateTournamentPairwiseJackknifeIps(jackknife, {
  informationSetKey: entry.exactKey,
  tableSize: 6,
  baselineActionKey,
  legalActionKeys: support,
});
assert.equal(jackknifePrediction.accepted, true);
assert.equal(jackknifePrediction.selected.actionKey, candidateActionKey);
assert(jackknifePrediction.selected.rank.lower95 > 0
  && jackknifePrediction.selected.hp.lower95 > 0);

console.log('tournament pairwise IPS tests passed');
