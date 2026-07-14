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
const seedCount = Number(value('--seeds', 4));
const seedOffset = Number(value('--seed-offset', 0));
const targetsPerMatch = Number(value('--targets-per-match', 1));
const styles = String(value('--styles', 'aggressive,tight')).split(',').filter(Boolean);
const namespace = String(value('--seed-namespace', 'qyj-v137-forced-hand-style'));
const output = resolve(value('--output', 'training/artifacts/qyj-v137-forced-hand-style.json'));
const secretName = value('--cluster-secret');
if (![6, 9].includes(tableSize) || !Number.isSafeInteger(seedCount) || seedCount < 2
  || !Number.isSafeInteger(seedOffset) || seedOffset < 0
  || !Number.isSafeInteger(targetsPerMatch) || targetsPerMatch < 1
  || !styles.length || styles.some((style) => !['tight', 'aggressive', 'loose', 'bluffer'].includes(style))
  || !secretName || !process.env[secretName] || Buffer.byteLength(process.env[secretName]) < 32) {
  throw new RangeError('forced hand style collection requires valid table, seeds, styles and secret');
}

const secret = process.env[secretName];
const opponentPool = ['qyz-tight', 'qyz-aggressive', 'qyz-loose', 'qyz-bluffer', 'calling-station'];
const lineup = createLineup([
  { strategy: 'qyz', id: 'hand-style-target' },
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
  const clusterId = `fhs_${createHmac('sha256', secret).update(rawGroup).digest('hex')}`;
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
    const baselineResult = baseline.results.find((row) => row.entryId === 'hand-style-target');
    const firstByRound = new Map();
    for (const row of trace) {
      if (row.entryId === 'hand-style-target' && !firstByRound.has(row.round)) {
        firstByRound.set(row.round, row);
      }
    }
    const targets = [...firstByRound.values()].sort((left, right) => createHash('sha256').update(
      `${rawGroup}|${assignment.key}|${left.round}|${left.informationSetKey}`,
    ).digest('hex').localeCompare(createHash('sha256').update(
      `${rawGroup}|${assignment.key}|${right.round}|${right.informationSetKey}`,
    ).digest('hex'))).slice(0, targetsPerMatch);
    for (const target of targets) {
      const encoded = compactResidualFeatures(target.informationSetKey);
      const baselineHandActionKeys = trace.filter((row) => row.entryId === target.entryId
        && row.round === target.round).map((row) => row.actionKey);
      for (const styleKey of styles) {
        const branchTrace = [];
        const branch = runMatch({
          assignment,
          seed: dealSeed,
          seedGroup: rawGroup,
          tableSize,
          skillsEnabled: false,
          forcedHandStyle: {
            entryId: target.entryId,
            round: target.round,
            styleKey,
          },
          onDecisionTrace: (row) => branchTrace.push(row),
        });
        branchMatches++;
        const branchResult = branch.results.find((row) => row.entryId === 'hand-style-target');
        const branchHandActionKeys = branchTrace.filter((row) => row.entryId === target.entryId
          && row.round === target.round).map((row) => row.actionKey);
        records.push({
          recordId: `fhr_${createHmac('sha256', secret).update(
            `${rawGroup}|${assignment.key}|${target.round}|${styleKey}`,
          ).digest('hex')}`,
          clusterId,
          tableSize,
          round: target.round,
          mask: encoded.mask,
          features: encoded.features,
          baselineStyleKey: 'tag',
          styleKey,
          actionChanged: JSON.stringify(branchHandActionKeys)
            !== JSON.stringify(baselineHandActionKeys),
          baselineHandActionKeys,
          branchHandActionKeys,
          rankAdvantage: Number(baselineResult.rank) - Number(branchResult.rank),
          hpAdvantage: Number(branchResult.hp) - Number(baselineResult.hp),
        });
      }
    }
  }
  console.log(`table=${tableSize} group=${groupNumber} records=${records.length}`);
}

records.sort((left, right) => left.recordId.localeCompare(right.recordId));
const artifact = {
  schema: 'qyj-forced-hand-style-outcomes-v1',
  version: 1,
  mode: 'offline-evaluation-only',
  tableSize,
  styles,
  seedClusters: seedCount,
  seedOffset,
  assignments: assignments.length,
  baselineMatches,
  branchMatches,
  secretId: createHash('sha256').update(secret).digest('hex'),
  namespaceSha256: createHash('sha256').update(namespace).digest('hex'),
  records,
  promotionEligible: false,
  promotionBlockers: ['forced-hand-style-data-is-training-evidence', 'offline-evaluation-only'],
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(`saved=${output} records=${records.length} branches=${branchMatches}`);
