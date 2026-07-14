#!/usr/bin/env node

import { createHash, createHmac } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { compactResidualFeatures } from '../js/game/blueprint-residual-policy.js';
import { buildSeatAssignments, createLineup, runMatch } from './eval/league.mjs';
import { deriveSeed } from './eval/rng.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const tableSize = Number(value('--table', 6));
const seedCount = Number(value('--seeds', 8));
const seedOffset = Number(value('--seed-offset', 0));
const namespace = String(value('--seed-namespace', 'qyj-v130-sequence-opportunities'));
const output = resolve(value('--output', 'training/artifacts/qyj-v130-sequence-opportunities.json'));
const secretName = value('--cluster-secret');
if (![6, 9].includes(tableSize) || !Number.isSafeInteger(seedCount) || seedCount < 2
  || !Number.isSafeInteger(seedOffset) || seedOffset < 0 || !secretName
  || !process.env[secretName] || Buffer.byteLength(process.env[secretName]) < 32) {
  throw new RangeError('sequence opportunity census requires table, seeds and 32-byte secret');
}

const LEVEL_FIELDS = Object.freeze({
  global: Object.freeze(['s', 'a', 'tc', 'r']),
  contextual: Object.freeze(['s', 'a', 'p', 'tc', 'r']),
  tactical: Object.freeze(['s', 'a', 'p', 'h', 'tc', 'r']),
});
const secret = process.env[secretName];
const opponentPool = ['qyz-tight', 'qyz-aggressive', 'qyz-loose', 'qyz-bluffer', 'calling-station'];
const lineup = createLineup([
  { strategy: 'qyz', id: 'sequence-target' },
  ...Array.from({ length: tableSize - 1 }, (_, index) => ({
    strategy: opponentPool[index % opponentPool.length],
    id: `opponent-${index + 1}`,
  })),
], tableSize);
const assignments = buildSeatAssignments(lineup, { rotations: 'full', mirror: true });
const buckets = new Map();
let matches = 0;
let decisions = 0;
let baselineSameRoundPairs = 0;

for (let seedIndex = 0; seedIndex < seedCount; seedIndex++) {
  const groupNumber = seedOffset + seedIndex + 1;
  const rawGroup = `${namespace}|table=${tableSize}|group=${groupNumber}`;
  const clusterId = `sop_${createHmac('sha256', secret).update(rawGroup).digest('hex')}`;
  const dealSeed = deriveSeed(rawGroup, 'deal');
  for (const assignment of assignments) {
    const trace = [];
    runMatch({
      assignment,
      seed: dealSeed,
      seedGroup: rawGroup,
      tableSize,
      skillsEnabled: false,
      onDecisionTrace: (row) => trace.push(row),
    });
    matches++;
    const focal = trace.filter((row) => row.entryId === 'sequence-target');
    decisions += focal.length;
    for (let index = 0; index + 1 < focal.length; index++) {
      const row = focal[index];
      const next = focal[index + 1];
      if (row.round !== next.round) continue;
      baselineSameRoundPairs++;
      if (['fold', 'allin'].includes(row.actionKey)) continue;
      const encoded = compactResidualFeatures(row.informationSetKey);
      const alternatives = row.legalActionKeys.filter(
        (actionKey) => actionKey !== row.actionKey && !['fold', 'allin'].includes(actionKey),
      );
      for (const [level, fields] of Object.entries(LEVEL_FIELDS)) {
        const features = Object.fromEntries(fields.map((field) => [field, encoded.features[field]]));
        const signature = fields.map((field) => `${field}=${features[field]}`).join('|');
        for (const firstActionKey of alternatives) {
          const key = `${level}\n${signature}\n${row.actionKey}\n${firstActionKey}`;
          let bucket = buckets.get(key);
          if (!bucket) {
            bucket = {
              level,
              features,
              baselineActionKey: row.actionKey,
              firstActionKey,
              continuationActionKey: 'fold',
              samples: 0,
              clusters: new Set(),
              baselineContinuations: new Map(),
            };
            buckets.set(key, bucket);
          }
          bucket.samples++;
          bucket.clusters.add(clusterId);
          bucket.baselineContinuations.set(
            next.actionKey,
            (bucket.baselineContinuations.get(next.actionKey) || 0) + 1,
          );
        }
      }
    }
  }
  console.log(`table=${tableSize} group=${groupNumber} candidates=${buckets.size}`);
}

const candidates = [...buckets.values()].map((bucket) => ({
  level: bucket.level,
  features: bucket.features,
  baselineActionKey: bucket.baselineActionKey,
  firstActionKey: bucket.firstActionKey,
  continuationActionKey: bucket.continuationActionKey,
  samples: bucket.samples,
  independentClusters: bucket.clusters.size,
  baselineContinuations: Object.fromEntries(
    [...bucket.baselineContinuations].sort((left, right) => right[1] - left[1]
      || left[0].localeCompare(right[0])),
  ),
})).sort((left, right) => right.independentClusters - left.independentClusters
  || right.samples - left.samples || left.level.localeCompare(right.level)
  || JSON.stringify(left).localeCompare(JSON.stringify(right)));

const artifact = {
  schema: 'qyj-sequence-opportunity-census-v1',
  version: 1,
  mode: 'offline-evaluation-only',
  tableSize,
  seedClusters: seedCount,
  seedOffset,
  assignments: assignments.length,
  matches,
  decisions,
  baselineSameRoundPairs,
  secretId: createHash('sha256').update(secret).digest('hex'),
  namespaceSha256: createHash('sha256').update(namespace).digest('hex'),
  candidates,
  promotionEligible: false,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(`saved=${output} candidates=${candidates.length} pairs=${baselineSameRoundPairs}`);
