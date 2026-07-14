import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  TOURNAMENT_TRAJECTORY_DATASET_SCHEMA,
  evaluateTournamentTrajectoryPolicy,
  trainTournamentTrajectoryPolicy,
  validateTournamentTrajectoryPolicy,
} from '../training/tournament-policy/model.mjs';

const profile = JSON.parse(fs.readFileSync(
  'training/profiles/qyj-reach-v45b-train-6.json', 'utf8',
));
const entry = profile.entries.find((candidate) => (
  candidate.exactKey && candidate.trainingSnapshot?.legalActions
));
assert(entry);
const legal = [
  ...(entry.trainingSnapshot.legalActions.canCheck ? ['check'] : ['fold', 'call']),
  ...entry.trainingSnapshot.legalActions.tiers.map((tier) => `raise:${tier.key}`),
  ...(entry.trainingSnapshot.legalActions.canAllIn ? ['allin'] : []),
];
assert(legal.length >= 2);
const [baselineActionKey, candidateActionKey] = legal;
const rows = [];
for (let group = 1; group <= 4; group++) {
  for (const [actionKey, rankValue] of [
    [baselineActionKey, -0.25], [candidateActionKey, 0.75],
  ]) {
    rows.push({
      rowId: `row-${group}-${actionKey}`,
      sourceGroup: `group-${group}`,
      matchId: `match-${group}`,
      tableSize: 6,
      behaviorStrategy: 'qyz-v120-explorer',
      behaviorPolicy: 'qyz-bounded-epsilon-exploration-v1',
      informationSetKey: entry.exactKey,
      legalActionKeys: legal,
      actionKey,
      actionPropensity: 0.2,
      round: entry.trainingSnapshot.round,
      street: entry.trainingSnapshot.street,
      rankValue,
      hpValue: 0,
    });
  }
}
const dataset = {
  schema: TOURNAMENT_TRAJECTORY_DATASET_SCHEMA,
  version: 1,
  secretId: 'test-secret-id',
  rows,
};
const options = {
  minGroups: 4, minSamples: 4, confidenceZ: 1.96, requirePropensity: true,
  rewardMode: 'rank-hp',
};
const first = trainTournamentTrajectoryPolicy(dataset, options);
const second = trainTournamentTrajectoryPolicy(structuredClone(dataset), options);
assert.deepEqual(second, first, 'trajectory policy training must be deterministic');
assert.doesNotThrow(() => validateTournamentTrajectoryPolicy(
  JSON.parse(JSON.stringify(first)),
));
const prediction = evaluateTournamentTrajectoryPolicy(first, {
  informationSetKey: entry.exactKey,
  tableSize: 6,
  baselineActionKey,
  legalActionKeys: legal,
});
assert.equal(prediction.accepted, true);
assert.equal(prediction.selected.actionKey, candidateActionKey);
assert(prediction.selected.lowerBound > 0);
assert.equal(first.training.propensityCorrected, true);
assert.match(first.training.estimator, /ips/);
assert.match(first.training.target, /rank-hp/);
assert.equal(evaluateTournamentTrajectoryPolicy(first, {
  informationSetKey: entry.exactKey,
  tableSize: 6,
  baselineActionKey,
  legalActionKeys: [baselineActionKey],
}).accepted, false);
assert.throws(() => trainTournamentTrajectoryPolicy({ ...dataset, rows: [] }, options),
  /invalid tournament trajectory dataset/);
assert.throws(() => trainTournamentTrajectoryPolicy({
  ...dataset,
  rows: dataset.rows.map(({ actionPropensity, ...row }) => row),
}, options), /requires actionPropensity/);

console.log('tournament trajectory policy tests passed');
