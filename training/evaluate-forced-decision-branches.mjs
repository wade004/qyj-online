#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash, createHmac } from 'node:crypto';

import { compactResidualFeatures } from '../js/game/blueprint-residual-policy.js';
import {
  buildSeatAssignments,
  createLineup,
  runMatch,
} from './eval/league.mjs';
import { deriveSeed } from './eval/rng.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const tableSize = Number(value('--table', 6));
const seedCount = Number(value('--seeds', 4));
const seedOffset = Number(value('--seed-offset', 0));
const targetsPerMatch = Number(value('--targets-per-match', 1));
const alternativesPerTarget = Number(value('--alternatives-per-target', 1));
const output = path.resolve(value('--output', 'training/artifacts/forced-branches.json'));
const namespace = String(value('--seed-namespace', 'qyj-forced-decision-v1'));
const targetSignaturePath = value('--target-signature');
const targetSignature = targetSignaturePath
  ? JSON.parse(fs.readFileSync(path.resolve(targetSignaturePath), 'utf8')) : null;
const targetSignatures = targetSignature?.schema === 'qyj-forced-action-target-set-v1'
  ? targetSignature.targets : (targetSignature ? [targetSignature] : []);
const forceBestEv = args.includes('--force-best-ev');
const minNormalizedEvGap = Number(value('--min-normalized-ev-gap', 0));
const targetStreets = new Set(String(value('--streets', 'preflop,flop,turn,river'))
  .split(',').map((item) => item.trim()).filter(Boolean));
const excludedActions = new Set(String(value('--exclude-actions', ''))
  .split(',').map((item) => item.trim()).filter(Boolean));
const secretName = value('--cluster-secret');
if (!secretName || !process.env[secretName] || Buffer.byteLength(process.env[secretName]) < 32) {
  throw new RangeError('--cluster-secret must name an environment value of at least 32 bytes');
}
if (![6, 9].includes(tableSize) || !Number.isSafeInteger(seedCount) || seedCount < 2
  || !Number.isSafeInteger(seedOffset) || seedOffset < 0
  || !Number.isSafeInteger(targetsPerMatch) || targetsPerMatch < 1
  || !Number.isSafeInteger(alternativesPerTarget) || alternativesPerTarget < 1) {
  throw new RangeError('invalid forced-decision evaluation limits');
}
if (!targetStreets.size
  || [...targetStreets].some((street) => !['preflop', 'flop', 'turn', 'river'].includes(street))) {
  throw new RangeError('--streets must contain preflop, flop, turn, or river');
}
const defaultLineup = tableSize === 6
  ? ['qyz', 'qyz-tight', 'qyz-aggressive', 'calling-station', 'random-legal', 'qyz-loose']
  : ['qyz', 'qyz-tight', 'qyz-aggressive', 'calling-station', 'random-legal',
    'check-fold', 'qyz-loose', 'qyz-bluffer', 'calling-station'];
const lineup = createLineup(String(value('--lineup', defaultLineup.join(','))), tableSize);
const assignments = buildSeatAssignments(lineup, {
  rotations: value('--rotations', 'full'),
  mirror: value('--mirror', 'true') !== 'false',
});
const targetEntry = lineup.find((entry) => entry.strategy === 'qyz');
if (!targetEntry) throw new RangeError('lineup requires one qyz target');
if (targetSignature && (!Array.isArray(targetSignatures) || !targetSignatures.length
  || targetSignatures.some((target) => Number(target.tableSize || tableSize) !== tableSize
    || !target.features || !target.baselineActionKey || !target.actionKey)
  || targetSignatures.some((target) => JSON.stringify(Object.keys(target.features))
    !== JSON.stringify(Object.keys(targetSignatures[0].features))))) {
  throw new TypeError('invalid forced action target signature or inconsistent feature fields');
}
const featureOrder = targetSignature
  ? Object.keys(targetSignatures[0].features || {})
  : tableSize === 6 ? ['s', 'p', 'ip'] : ['s', 'n', 'p', 'ip', 'cl'];
const secret = process.env[secretName];
const records = new Map();
const globalClusters = new Map();
const mean = (values) => values.reduce((sum, item) => sum + item, 0) / values.length;
const lowerBound = (values) => {
  const average = mean(values);
  if (values.length < 2) return { mean: average, lowerBound: null };
  const variance = values.reduce((sum, item) => sum + ((item - average) ** 2), 0)
    / (values.length - 1);
  const t = 1.644854 + 0.710 / (values.length - 1);
  return { mean: average, lowerBound: average - t * Math.sqrt(variance / values.length) };
};
let branchCount = 0;
for (let seedIndex = 0; seedIndex < seedCount; seedIndex++) {
  const groupNumber = seedOffset + seedIndex + 1;
  const seedCluster = `${namespace}:${groupNumber}`;
  const dealSeed = deriveSeed(namespace, 'deal', seedOffset + seedIndex);
  const clusterId = `fc_${createHmac('sha256', secret).update(seedCluster).digest('hex')}`;
  for (const assignment of assignments) {
    const trace = [];
    const baseline = runMatch({
      assignment, seed: dealSeed, seedGroup: seedCluster,
      onDecisionTrace: (row) => trace.push(row),
    });
    const baselineResult = baseline.results.find((row) => row.entryId === targetEntry.id);
    const targets = trace.filter((row) => {
      if (row.entryId !== targetEntry.id
        || !row.legalActionKeys.some((action) => action !== row.actionKey)) return false;
      const publicFeatures = compactResidualFeatures(row.informationSetKey);
      if (!publicFeatures || !targetStreets.has(publicFeatures.features.s)) return false;
      if (forceBestEv) return row.bestEvActionKey
        && row.bestEvActionKey !== row.actionKey
        && row.legalActionKeys.includes(row.bestEvActionKey)
        && Number(row.normalizedBestEvGap) >= minNormalizedEvGap;
      if (!targetSignature) return true;
      const encoded = compactResidualFeatures(row.informationSetKey);
      return targetSignatures.some((target) => (target.mask == null || encoded?.mask === target.mask)
        && row.actionKey === target.baselineActionKey
        && row.legalActionKeys.includes(target.actionKey)
        && Object.entries(target.features || {}).every(([feature, featureValue]) => (
          encoded.features[feature] === featureValue
        )));
    })
      .sort((left, right) => createHash('sha256').update(
        `${seedCluster}|${assignment.key}|${left.ordinal}|${left.informationSetKey}`,
      ).digest('hex').localeCompare(createHash('sha256').update(
        `${seedCluster}|${assignment.key}|${right.ordinal}|${right.informationSetKey}`,
      ).digest('hex'))).slice(0, targetsPerMatch);
    for (const target of targets) {
      const encoded = compactResidualFeatures(target.informationSetKey);
      if (!encoded) continue;
      const alternatives = (forceBestEv
        ? [target.bestEvActionKey]
        : targetSignature
        ? targetSignatures.filter((signature) => (
          (signature.mask == null || encoded.mask === signature.mask)
          && target.actionKey === signature.baselineActionKey
          && target.legalActionKeys.includes(signature.actionKey)
          && Object.entries(signature.features).every(([feature, featureValue]) => (
            encoded.features[feature] === featureValue
          ))
        )).map((signature) => signature.actionKey)
        : target.legalActionKeys.filter((action) => action !== target.actionKey))
        .filter((action) => !excludedActions.has(action))
        .slice(0, alternativesPerTarget);
      for (const actionKey of alternatives) {
        const branch = runMatch({
          assignment, seed: dealSeed, seedGroup: seedCluster,
          forcedDecision: { entryId: target.entryId, ordinal: target.ordinal, actionKey },
        });
        const result = branch.results.find((row) => row.entryId === targetEntry.id);
        const signature = {
          mask: encoded.mask,
          features: Object.fromEntries(featureOrder.map((feature) => [
            feature, encoded.features[feature],
          ])),
          baselineActionKey: target.actionKey,
          actionKey,
        };
        const signatureSha256 = createHash('sha256').update(JSON.stringify(signature)).digest('hex');
        const byCluster = records.get(signatureSha256) || { signature, clusters: new Map() };
        const bucket = byCluster.clusters.get(clusterId) || { rank: [], hp: [], samples: 0 };
        bucket.rank.push(Number(baselineResult.rank) - Number(result.rank));
        bucket.hp.push(Number(result.hp) - Number(baselineResult.hp));
        bucket.samples++;
        byCluster.clusters.set(clusterId, bucket);
        records.set(signatureSha256, byCluster);
        const global = globalClusters.get(clusterId) || { rank: [], hp: [], samples: 0 };
        global.rank.push(Number(baselineResult.rank) - Number(result.rank));
        global.hp.push(Number(result.hp) - Number(baselineResult.hp));
        global.samples++;
        globalClusters.set(clusterId, global);
        branchCount++;
      }
    }
  }
}
const serialized = {};
for (const [signatureSha256, record] of [...records].sort()) {
  const clusters = [...record.clusters].map(([clusterId, bucket]) => ({
    clusterId,
    rankAdvantage: mean(bucket.rank),
    hpAdvantage: mean(bucket.hp),
    samples: bucket.samples,
  })).sort((left, right) => left.clusterId.localeCompare(right.clusterId));
  const rank = lowerBound(clusters.map((cluster) => cluster.rankAdvantage));
  const hp = lowerBound(clusters.map((cluster) => cluster.hpAdvantage));
  serialized[signatureSha256] = {
    ...record.signature,
    independentClusterCount: clusters.length,
    samples: clusters.reduce((sum, cluster) => sum + cluster.samples, 0),
    rankMean: rank.mean,
    rankLowerBound: rank.lowerBound,
    hpMean: hp.mean,
    hpLowerBound: hp.lowerBound,
    clusters,
  };
}
const artifact = {
  schema: 'qyj-forced-decision-branch-calibration-v1',
  version: 1,
  mode: 'offline-evaluation-only',
  tableSize,
  featureOrder,
  seedClusters: seedCount,
  seedOffset,
  assignments: assignments.length,
  branchCount,
  targetStreets: [...targetStreets].sort(),
  excludedActions: [...excludedActions].sort(),
  sourceGroupSecretId: `fs_${createHash('sha256').update(secret).digest('hex')}`,
  records: serialized,
  global: (() => {
    const clusters = [...globalClusters].map(([clusterId, bucket]) => ({
      clusterId,
      rankAdvantage: mean(bucket.rank),
      hpAdvantage: mean(bucket.hp),
      samples: bucket.samples,
    })).sort((left, right) => left.clusterId.localeCompare(right.clusterId));
    if (!clusters.length) return null;
    const rank = lowerBound(clusters.map((cluster) => cluster.rankAdvantage));
    const hp = lowerBound(clusters.map((cluster) => cluster.hpAdvantage));
    return {
      independentClusterCount: clusters.length,
      samples: clusters.reduce((sum, cluster) => sum + cluster.samples, 0),
      rankMean: rank.mean,
      rankLowerBound: rank.lowerBound,
      hpMean: hp.mean,
      hpLowerBound: hp.lowerBound,
      clusters,
    };
  })(),
  promotionEligible: false,
  promotionBlockers: ['forced-branch-calibration-below-formal-scale', 'offline-evaluation-only'],
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, tableSize, branchCount, signatures: Object.keys(serialized).length }));
