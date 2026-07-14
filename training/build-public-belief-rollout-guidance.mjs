#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';

import { evaluatePublicBeliefRolloutActions } from './eval/public-belief-rollout.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const tableSize = Number(value('--table', 6));
const profilePath = path.resolve(value('--profile', ''));
const output = path.resolve(value(
  '--output', `training/artifacts/qyj-v62-rollout-guidance-${tableSize}.json`,
));
const rootLimit = Number(value('--roots', 8));
const clusterCount = Number(value('--clusters', 6));
const minCount = Number(value('--min-count', 2));
const confirmationPath = value('--confirm-from', null);
const confirmationText = confirmationPath
  ? fs.readFileSync(path.resolve(confirmationPath), 'utf8') : null;
const confirmation = confirmationText ? JSON.parse(confirmationText) : null;
if (confirmation && (confirmation.schema !== 'qyj-public-belief-rollout-guidance-v1'
  || Number(confirmation.tableSize) !== tableSize)) {
  throw new TypeError('--confirm-from must be matching rollout guidance');
}
const confirmationKeys = confirmation ? new Set(Object.entries(confirmation.records || {})
  .filter(([, record]) => record.rollout?.accepted && record.rollout?.selected)
  .map(([informationSetKey]) => informationSetKey)) : null;
const seedNamespace = String(value(
  '--seed-namespace', `qyj-v62-rollout-guidance-${tableSize}`,
));
if (![6, 9].includes(tableSize) || !profilePath
  || !Number.isSafeInteger(rootLimit) || rootLimit < 1
  || !Number.isSafeInteger(clusterCount) || clusterCount < 2
  || !Number.isSafeInteger(minCount) || minCount < 1) {
  throw new RangeError('invalid rollout guidance arguments');
}
const profileText = fs.readFileSync(profilePath, 'utf8');
const profile = JSON.parse(profileText);
const legalKeys = (snapshot) => [
  ...(snapshot.legalActions.canCheck ? ['check'] : ['fold', 'call']),
  ...snapshot.legalActions.tiers.map((tier) => `raise:${tier.key}`),
  ...(snapshot.legalActions.canAllIn ? ['allin'] : []),
];
const modalAction = (entry, legal) => Object.entries(entry.actions || {})
  .filter(([actionKey]) => legal.includes(actionKey))
  .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
const roots = profile.entries.filter((entry) => (
  ['flop', 'turn', 'river'].includes(entry.trainingSnapshot?.street)
  && Number(entry.count) >= minCount
  && (!confirmationKeys || confirmationKeys.has(entry.exactKey))
)).map((entry) => {
  const legal = legalKeys(entry.trainingSnapshot);
  return { entry, legal, baseActionKey: modalAction(entry, legal) };
}).filter((row) => row.baseActionKey && row.legal.length > 1)
  .sort((left, right) => Number(right.entry.count) - Number(left.entry.count)
    || left.entry.exactKey.localeCompare(right.entry.exactKey))
  .slice(0, rootLimit);
const records = {};
let utilitySamples = 0;
let acceptedRoots = 0;
let errors = 0;
for (let index = 0; index < roots.length; index++) {
  const { entry, legal, baseActionKey } = roots[index];
  const { observerIdx, ...snapshot } = entry.trainingSnapshot;
  try {
    const result = evaluatePublicBeliefRolloutActions({
      targetKey: entry.exactKey,
      actorIdx: observerIdx,
      snapshot,
    }, {
      baseActionKey,
      actionKeys: legal,
      seedNamespace: `${seedNamespace}|root|${index}`,
      clusterCount,
      beliefTemperature: 0.5,
      minAdvantage: Math.max(1, Number(snapshot.betting?.pot) * 0.005),
    });
    utilitySamples += result.utilitySamples;
    if (result.accepted) acceptedRoots++;
    records[entry.exactKey] = {
      count: Number(entry.count) || 0,
      street: snapshot.street,
      tableSize,
      baseActionKey,
      legalActionKeys: legal,
      sourceGroups: [...(entry.sourceGroups || [])].sort(),
      rollout: result,
    };
  } catch {
    errors++;
    records[entry.exactKey] = {
      count: Number(entry.count) || 0,
      street: snapshot.street,
      tableSize,
      baseActionKey,
      legalActionKeys: legal,
      sourceGroups: [...(entry.sourceGroups || [])].sort(),
      error: 'rollout-guidance-root-failed',
    };
  }
}
const artifact = {
  schema: 'qyj-public-belief-rollout-guidance-v1',
  version: 1,
  mode: 'offline-evaluation-only',
  tableSize,
  profileSha256: createHash('sha256').update(profileText).digest('hex'),
  seedNamespace,
  selectionMode: confirmation ? 'fresh-seed-confirmation-of-pilot-accepted-roots' : 'reach-count',
  selectionSourceSha256: confirmationText
    ? createHash('sha256').update(confirmationText).digest('hex') : null,
  rootLimit,
  selectedRoots: roots.length,
  clusterCount,
  utilitySamples,
  acceptedRoots,
  errors,
  records,
  promotionEligible: false,
  promotionBlockers: [
    'rollout-guidance-requires-distillation-and-real-engine-calibration',
    'offline-evaluation-only',
  ],
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  output, tableSize, roots: roots.length, acceptedRoots, utilitySamples, errors,
}));
