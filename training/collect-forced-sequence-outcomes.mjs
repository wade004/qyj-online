#!/usr/bin/env node

import { createHash, createHmac } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { compactResidualFeatures } from '../js/game/blueprint-residual-policy.js';
import {
  buildSeatAssignments,
  createLineup,
  runMatch,
} from './eval/league.mjs';
import { deriveSeed } from './eval/rng.mjs';
import {
  evaluateTournamentSequencePolicy,
  validateTournamentSequencePolicy,
} from './tournament-policy/sequence-model.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const tableSize = Number(value('--table', 6));
const seedCount = Number(value('--seeds', 6));
const seedOffset = Number(value('--seed-offset', 0));
const targetsPerMatch = Number(value('--targets-per-match', 2));
const namespace = String(value('--seed-namespace', 'qyj-v128-forced-sequence'));
const policyPath = value('--policy');
const targetSignaturePath = value('--target-signature');
const output = resolve(value('--output', 'training/artifacts/qyj-v128-forced-sequence.json'));
const secretName = value('--cluster-secret');
if (![6, 9].includes(tableSize) || !Number.isSafeInteger(seedCount) || seedCount < 2
  || !Number.isSafeInteger(seedOffset) || seedOffset < 0
  || !Number.isSafeInteger(targetsPerMatch) || targetsPerMatch < 1
  || Boolean(policyPath) === Boolean(targetSignaturePath)
  || !secretName || !process.env[secretName] || Buffer.byteLength(process.env[secretName]) < 32) {
  throw new RangeError(
    'forced sequence collection requires table, seeds, exactly one policy/target signature and 32-byte secret',
  );
}
const secret = process.env[secretName];
const policy = policyPath ? validateTournamentSequencePolicy(JSON.parse(
  await readFile(resolve(policyPath), 'utf8'),
)) : null;
const targetSignature = targetSignaturePath ? JSON.parse(
  await readFile(resolve(targetSignaturePath), 'utf8'),
) : null;
const targetSignatures = targetSignature?.schema === 'qyj-forced-sequence-target-set-v1'
  ? targetSignature.targets : (targetSignature ? [targetSignature] : []);
if (targetSignature && (targetSignature.version !== 1
  || !['qyj-forced-sequence-target-v1', 'qyj-forced-sequence-target-set-v1']
    .includes(targetSignature.schema)
  || !Array.isArray(targetSignatures) || !targetSignatures.length
  || targetSignatures.some((target) => Number(target.tableSize) !== tableSize
    || !target.features || typeof target.features !== 'object'
    || !target.baselineActionKey || !target.firstActionKey || !target.continuationActionKey
    || ['fold', 'allin'].includes(target.firstActionKey)
    || target.continuationActionKey === 'allin'))) {
  throw new TypeError('invalid forced sequence target signature');
}
const opponentPool = ['qyz-tight', 'qyz-aggressive', 'qyz-loose', 'qyz-bluffer', 'calling-station'];
const lineup = createLineup([
  { strategy: 'qyz', id: 'sequence-target' },
  ...Array.from({ length: tableSize - 1 }, (_, index) => ({
    strategy: opponentPool[index % opponentPool.length],
    id: `opponent-${index + 1}`,
  })),
], tableSize);
const assignments = buildSeatAssignments(lineup, { rotations: 'full', mirror: true });
const records = [];
let baselineMatches = 0;
let branchMatches = 0;
for (let seedIndex = 0; seedIndex < seedCount; seedIndex++) {
  const groupNumber = seedOffset + seedIndex + 1;
  const rawGroup = `${namespace}|table=${tableSize}|group=${groupNumber}`;
  const clusterId = `fsq_${createHmac('sha256', secret).update(rawGroup).digest('hex')}`;
  const dealSeed = deriveSeed(rawGroup, 'deal');
  for (const assignment of assignments) {
    const trace = [];
    const baseline = runMatch({
      assignment,
      seed: dealSeed,
      seedGroup: rawGroup,
      tableSize,
      skillsEnabled: false,
      onDecisionTrace: (row) => trace.push(row),
    });
    baselineMatches++;
    const baselineResult = baseline.results.find((row) => row.entryId === 'sequence-target');
    const targets = trace.flatMap((row) => {
      if (row.entryId !== 'sequence-target' || row.actionKey === 'fold') return [];
      if (targetSignature) {
        const encoded = compactResidualFeatures(row.informationSetKey);
        return targetSignatures.flatMap((target) => {
          const matches = row.actionKey === target.baselineActionKey
            && row.legalActionKeys.includes(target.firstActionKey)
            && Object.entries(target.features).every(
              ([field, expected]) => encoded.features[field] === expected,
            );
          if (!matches) return [];
          return [{
            row,
            selected: {
              optionKey: `${target.firstActionKey}>${target.continuationActionKey}`,
              firstActionKey: target.firstActionKey,
              continuationActionKey: target.continuationActionKey,
            },
            level: 'targeted',
          }];
        });
      }
      const prediction = evaluateTournamentSequencePolicy(policy, {
        informationSetKey: row.informationSetKey,
        tableSize,
        baselineActionKey: row.actionKey,
        legalActionKeys: row.legalActionKeys,
      });
      const selected = prediction.selected;
      if (!prediction.accepted || ['fold', 'allin'].includes(selected.firstActionKey)
        || selected.continuationActionKey === 'allin') return [];
      return [{ row, selected, level: prediction.level }];
    }).sort((left, right) => createHash('sha256').update(
      `${rawGroup}|${assignment.key}|${left.row.ordinal}|${left.selected.optionKey}`,
    ).digest('hex').localeCompare(createHash('sha256').update(
      `${rawGroup}|${assignment.key}|${right.row.ordinal}|${right.selected.optionKey}`,
    ).digest('hex'))).slice(0, targetsPerMatch);
    for (const target of targets) {
      const branchTrace = [];
      const branch = runMatch({
        assignment,
        seed: dealSeed,
        seedGroup: rawGroup,
        tableSize,
        skillsEnabled: false,
        onDecisionTrace: (row) => branchTrace.push(row),
        forcedDecisionSequence: {
          entryId: target.row.entryId,
          ordinal: target.row.ordinal,
          firstActionKey: target.selected.firstActionKey,
          continuationActionKey: target.selected.continuationActionKey,
        },
      });
      branchMatches++;
      const branchResult = branch.results.find((row) => row.entryId === 'sequence-target');
      const encoded = compactResidualFeatures(target.row.informationSetKey);
      const forcedSteps = branchTrace.filter((row) => row.forcedSequenceStep);
      records.push({
        recordId: `fsr_${createHmac('sha256', secret).update(
          `${rawGroup}|${assignment.key}|${target.row.ordinal}|${target.selected.optionKey}`,
        ).digest('hex')}`,
        clusterId,
        tableSize,
        mask: encoded.mask,
        features: encoded.features,
        level: target.level,
        baselineActionKey: target.row.actionKey,
        firstActionKey: target.selected.firstActionKey,
        continuationActionKey: target.selected.continuationActionKey,
        continuationReached: forcedSteps.some((row) => row.forcedSequenceStep === 'continuation'),
        continuationAborted: forcedSteps.some(
          (row) => row.forcedSequenceStep === 'continuation-aborted',
        ),
        rankAdvantage: Number(baselineResult.rank) - Number(branchResult.rank),
        hpAdvantage: Number(branchResult.hp) - Number(baselineResult.hp),
      });
    }
  }
  console.log(`table=${tableSize} group=${groupNumber} records=${records.length}`);
}
records.sort((left, right) => left.recordId.localeCompare(right.recordId));
const artifact = {
  schema: 'qyj-forced-sequence-outcomes-v1',
  version: 1,
  mode: 'offline-evaluation-only',
  tableSize,
  seedClusters: seedCount,
  seedOffset,
  baselineMatches,
  branchMatches,
  secretId: createHash('sha256').update(secret).digest('hex'),
  namespaceSha256: createHash('sha256').update(namespace).digest('hex'),
  policySha256: policy
    ? createHash('sha256').update(JSON.stringify(policy)).digest('hex') : null,
  targetSignatureSha256: targetSignature
    ? createHash('sha256').update(JSON.stringify(targetSignature)).digest('hex') : null,
  records,
  promotionEligible: false,
  promotionBlockers: ['forced-sequence-data-is-training-evidence', 'offline-evaluation-only'],
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(`saved=${output} records=${records.length} branches=${branchMatches}`);
