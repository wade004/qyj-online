#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash, createHmac } from 'node:crypto';

import { compactResidualFeatures } from '../js/game/blueprint-residual-policy.js';
import { buildSeatAssignments, createLineup, runMatch } from './eval/league.mjs';
import { deriveSeed } from './eval/rng.mjs';
import { REAL_ENGINE_TRANSFER_CALIBRATION_SCHEMA } from './eval/real-engine-transfer-selector.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const tableSize = Number(value('--table', 6));
const seedCount = Number(value('--seeds', 6));
const targetsPerMatch = Number(value('--targets-per-match', 1));
const namespace = String(value('--seed-namespace', 'qyj-v60-transfer-calibration'));
const output = path.resolve(value('--output', 'training/artifacts/online-resolver-transfer.json'));
const resolverStrategyKey = String(value(
  '--resolver-strategy', 'online-resolver-v7-table-specific',
));
const actionPairs = new Set(String(value('--action-pairs', '')).split(',')
  .map((item) => item.trim()).filter(Boolean));
const secretName = value('--cluster-secret');
if (![6, 9].includes(tableSize) || !Number.isSafeInteger(seedCount) || seedCount < 2
  || !Number.isSafeInteger(targetsPerMatch) || targetsPerMatch < 1
  || !secretName || !process.env[secretName] || Buffer.byteLength(process.env[secretName]) < 32) {
  throw new RangeError('transfer profiling requires table 6/9, seeds >=2 and a 32-byte secret');
}
const defaultLineup = tableSize === 6
  ? [resolverStrategyKey, 'qyz-tight', 'qyz-aggressive', 'calling-station',
    'random-legal', 'qyz-loose']
  : [resolverStrategyKey, 'qyz-tight', 'qyz-aggressive', 'calling-station',
    'random-legal', 'check-fold', 'qyz-loose', 'qyz-bluffer', 'calling-station'];
const lineup = createLineup(String(value('--lineup', defaultLineup.join(','))), tableSize);
const assignments = buildSeatAssignments(lineup, {
  rotations: value('--rotations', 'full'),
  mirror: value('--mirror', 'true') !== 'false',
});
const targetEntry = lineup.find((entry) => entry.strategy === resolverStrategyKey);
if (!targetEntry) throw new RangeError('lineup requires the resolver strategy target');
const featureOrder = String(value(
  '--features', tableSize === 6 ? 's,p,ip' : 's,n,p,ip,cl',
)).split(',').map((feature) => feature.trim()).filter(Boolean);
const records = new Map();
const tournamentValueSources = new Map();
const secret = process.env[secretName];
const average = (values) => values.reduce((sum, item) => sum + item, 0) / values.length;
let branchCount = 0;
let changedDecisionCount = 0;
for (let seedIndex = 0; seedIndex < seedCount; seedIndex++) {
  const seedCluster = `${namespace}:${seedIndex + 1}`;
  const dealSeed = deriveSeed(namespace, 'deal', seedIndex);
  const clusterId = `rt_${createHmac('sha256', secret).update(seedCluster).digest('hex')}`;
  for (const assignment of assignments) {
    const trace = [];
    const baseline = runMatch({
      assignment, seed: dealSeed, seedGroup: seedCluster,
      onDecisionTrace: (row) => trace.push(row),
    });
    const baselineResult = baseline.results.find((row) => row.entryId === targetEntry.id);
    const targets = trace.filter((row) => (
      row.entryId === targetEntry.id && row.onlineResolver?.accepted === true
      && row.onlineResolver.actionChanged === true
      && row.onlineResolver.baseActionKey && row.onlineResolver.resolverActionKey
      && row.onlineResolver.baseActionKey !== row.onlineResolver.resolverActionKey
      && row.legalActionKeys.includes(row.onlineResolver.baseActionKey)
      && (!actionPairs.size || actionPairs.has(
        `${row.onlineResolver.baseActionKey}=>${row.onlineResolver.resolverActionKey}`,
      ))
    ));
    changedDecisionCount += targets.length;
    targets.sort((left, right) => createHash('sha256').update(
      `${seedCluster}|${assignment.key}|${left.ordinal}|${left.informationSetKey}`,
    ).digest('hex').localeCompare(createHash('sha256').update(
      `${seedCluster}|${assignment.key}|${right.ordinal}|${right.informationSetKey}`,
    ).digest('hex')));
    for (const target of targets.slice(0, targetsPerMatch)) {
      const encoded = compactResidualFeatures(target.informationSetKey);
      if (!encoded) continue;
      const branch = runMatch({
        assignment, seed: dealSeed, seedGroup: seedCluster,
        forcedDecision: {
          entryId: target.entryId,
          ordinal: target.ordinal,
          actionKey: target.onlineResolver.baseActionKey,
        },
      });
      const branchResult = branch.results.find((row) => row.entryId === targetEntry.id);
      const signature = {
        mask: encoded.mask,
        features: Object.fromEntries(featureOrder.map((feature) => [
          feature, encoded.features[feature],
        ])),
        baseActionKey: target.onlineResolver.baseActionKey,
        actionKey: target.onlineResolver.resolverActionKey,
      };
      const id = createHash('sha256').update(JSON.stringify(signature)).digest('hex');
      const record = records.get(id) || { signature, clusters: new Map() };
      const bucket = record.clusters.get(clusterId) || { rank: [], hp: [], samples: 0 };
      bucket.rank.push(Number(branchResult.rank) - Number(baselineResult.rank));
      bucket.hp.push(Number(baselineResult.hp) - Number(branchResult.hp));
      bucket.samples++;
      record.clusters.set(clusterId, bucket);
      records.set(id, record);
      if (target.onlineResolver.tournamentValueSource) {
        const source = target.onlineResolver.tournamentValueSource;
        tournamentValueSources.set(
          createHash('sha256').update(JSON.stringify(source)).digest('hex'), source,
        );
      }
      branchCount++;
    }
  }
}
const serialized = Object.fromEntries([...records].sort().map(([id, record]) => [id, {
  ...record.signature,
  independentClusterCount: record.clusters.size,
  samples: [...record.clusters.values()].reduce((sum, bucket) => sum + bucket.samples, 0),
  clusters: [...record.clusters].map(([clusterId, bucket]) => ({
    clusterId,
    rankAdvantage: average(bucket.rank),
    hpAdvantage: average(bucket.hp),
    samples: bucket.samples,
  })).sort((left, right) => left.clusterId.localeCompare(right.clusterId)),
}]));
const artifact = {
  schema: REAL_ENGINE_TRANSFER_CALIBRATION_SCHEMA,
  version: 1,
  mode: 'offline-evaluation-only',
  tableSize,
  resolverStrategyKey,
  featureOrder,
  seedClusters: seedCount,
  assignments: assignments.length,
  changedDecisionCount,
  branchCount,
  sourceGroupSecretId: `rt_${createHash('sha256').update(secret).digest('hex')}`,
  tournamentValueSources: [...tournamentValueSources.entries()]
    .sort(([left], [right]) => left.localeCompare(right)).map(([, source]) => source),
  records: serialized,
  promotionEligible: false,
  promotionBlockers: ['transfer-calibration-is-training-evidence', 'offline-evaluation-only'],
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  output, tableSize, branchCount, changedDecisionCount, signatures: records.size,
}));
