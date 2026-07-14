#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash, createHmac } from 'node:crypto';

import { compactResidualFeatures } from '../js/game/blueprint-residual-policy.js';
import { buildSeatAssignments, createLineup, runMatch } from './eval/league.mjs';
import { deriveSeed } from './eval/rng.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const tableSize = Number(value('--table', 6));
const seedCount = Number(value('--seeds', 2));
const namespace = String(value('--seed-namespace', 'qyj-resolver-attempt-profile'));
const strategyKey = String(value(
  '--strategy', 'online-resolver-v8-real-engine-transfer',
));
const output = path.resolve(value('--output', 'training/artifacts/resolver-attempts.json'));
const secretName = value('--cluster-secret');
if (![6, 9].includes(tableSize) || !Number.isSafeInteger(seedCount) || seedCount < 1
  || !secretName || !process.env[secretName] || Buffer.byteLength(process.env[secretName]) < 32) {
  throw new RangeError('attempt profiling requires table 6/9 and a 32-byte secret');
}
const defaultLineup = tableSize === 6
  ? [strategyKey, 'qyz', 'qyz-tight', 'qyz-aggressive', 'calling-station', 'random-legal']
  : [strategyKey, 'qyz', 'qyz-tight', 'qyz-aggressive', 'calling-station',
    'random-legal', 'check-fold', 'qyz-loose', 'qyz-bluffer'];
const lineup = createLineup(String(value('--lineup', defaultLineup.join(','))), tableSize);
const target = lineup.find((entry) => entry.strategy === strategyKey);
if (!target) throw new RangeError('lineup requires the profiled strategy');
const assignments = buildSeatAssignments(lineup, { rotations: 'full', mirror: true });
const pairs = new Map();
let decisions = 0;
let attemptedChanges = 0;
for (let seedIndex = 0; seedIndex < seedCount; seedIndex++) {
  const seedCluster = `${namespace}:${seedIndex + 1}`;
  const clusterId = `ra_${createHmac('sha256', process.env[secretName])
    .update(seedCluster).digest('hex')}`;
  const dealSeed = deriveSeed(namespace, 'deal', seedIndex);
  for (const assignment of assignments) {
    runMatch({
      assignment, seed: dealSeed, seedGroup: seedCluster,
      onDecisionTrace(row) {
        if (row.entryId !== target.id) return;
        decisions++;
        const resolver = row.onlineResolver;
        if (!resolver?.baseActionKey || !resolver?.resolverActionKey
          || resolver.baseActionKey === resolver.resolverActionKey) return;
        attemptedChanges++;
        const pair = `${resolver.baseActionKey}=>${resolver.resolverActionKey}`;
        const record = pairs.get(pair) || {
          attempts: 0, accepted: 0, reasons: {}, clusters: new Set(), signatures: new Set(),
        };
        record.attempts++;
        if (resolver.transferSelection?.eligible === true) record.accepted++;
        const reason = String(resolver.transferSelection?.reason
          || (resolver.accepted ? 'resolver-accepted-no-transfer-gate' : 'resolver-rejected'));
        record.reasons[reason] = (record.reasons[reason] || 0) + 1;
        record.clusters.add(clusterId);
        const encoded = compactResidualFeatures(row.informationSetKey);
        if (encoded) record.signatures.add(createHash('sha256').update(JSON.stringify({
          mask: encoded.mask, features: encoded.features,
        })).digest('hex'));
        pairs.set(pair, record);
      },
    });
  }
}
const artifact = {
  schema: 'qyj-online-resolver-attempt-profile-v1',
  version: 1,
  mode: 'offline-evaluation-only',
  tableSize,
  strategyKey,
  seedClusters: seedCount,
  assignments: assignments.length,
  decisions,
  attemptedChanges,
  sourceGroupSecretId: `ra_${createHash('sha256').update(process.env[secretName]).digest('hex')}`,
  pairs: Object.fromEntries([...pairs].sort().map(([pair, record]) => [pair, {
    attempts: record.attempts,
    accepted: record.accepted,
    independentClusterCount: record.clusters.size,
    signatures: record.signatures.size,
    reasons: record.reasons,
  }])),
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, tableSize, decisions, attemptedChanges, pairs: artifact.pairs }));
