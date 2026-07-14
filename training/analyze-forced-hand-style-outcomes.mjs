#!/usr/bin/env node

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const input = resolve(value('--input'));
const output = resolve(value('--output', 'training/artifacts/qyj-forced-hand-style-analysis.json'));
const fields = String(value('--fields', 'tc,r,stk')).split(',').filter(Boolean);
const source = JSON.parse(await readFile(input, 'utf8'));
if (source?.schema !== 'qyj-forced-hand-style-outcomes-v1' || source.version !== 1
  || !Array.isArray(source.records) || !source.records.length) {
  throw new TypeError('invalid forced hand style outcomes');
}
const T95 = [Infinity, Infinity, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447,
  2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12,
  2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056,
  2.052, 2.048, 2.045];
const metric = (values) => {
  const mean = values.reduce((sum, item) => sum + item, 0) / values.length;
  if (values.length < 2) return { mean, lower95: null, upper95: null };
  const variance = values.reduce((sum, item) => sum + ((item - mean) ** 2), 0)
    / (values.length - 1);
  const se = Math.sqrt(variance / values.length);
  const critical = T95[Math.min(30, values.length)] || 1.96;
  return { mean, lower95: mean - critical * se, upper95: mean + critical * se };
};
const buckets = new Map();
for (const row of source.records) {
  const features = Object.fromEntries(fields.map((field) => [field, row.features[field]]));
  const key = JSON.stringify([features, row.styleKey]);
  const bucket = buckets.get(key) || { features, styleKey: row.styleKey, clusters: new Map() };
  const cluster = bucket.clusters.get(row.clusterId) || [];
  cluster.push(row);
  bucket.clusters.set(row.clusterId, cluster);
  buckets.set(key, bucket);
}
const analyses = [...buckets.values()].map((bucket) => {
  const clusters = [...bucket.clusters].map(([clusterId, rows]) => ({
    clusterId,
    samples: rows.length,
    rankAdvantage: rows.reduce((sum, row) => sum + row.rankAdvantage, 0) / rows.length,
    hpAdvantage: rows.reduce((sum, row) => sum + row.hpAdvantage, 0) / rows.length,
  }));
  const rank = metric(clusters.map((row) => row.rankAdvantage));
  const hp = metric(clusters.map((row) => row.hpAdvantage));
  return {
    features: bucket.features,
    styleKey: bucket.styleKey,
    samples: clusters.reduce((sum, row) => sum + row.samples, 0),
    actionChanges: [...bucket.clusters.values()].flat()
      .filter((row) => row.actionChanged).length,
    actionChangeRate: [...bucket.clusters.values()].flat()
      .filter((row) => row.actionChanged).length
      / [...bucket.clusters.values()].flat().length,
    independentClusters: clusters.length,
    rank,
    hp,
    clusters,
    passesTrainingScreen: clusters.length >= 4
      && [...bucket.clusters.values()].flat().filter((row) => row.actionChanged).length >= 4
      && rank.lower95 > 0 && hp.lower95 > 0,
  };
}).sort((left, right) => Number(right.passesTrainingScreen) - Number(left.passesTrainingScreen)
  || right.independentClusters - left.independentClusters || right.rank.mean - left.rank.mean
  || right.hp.mean - left.hp.mean);
const artifact = {
  schema: 'qyj-forced-hand-style-analysis-v1',
  version: 1,
  mode: 'offline-evaluation-only',
  tableSize: source.tableSize,
  groupingFields: fields,
  sourceSeedClusters: source.seedClusters,
  sourceRecords: source.records.length,
  analyses,
  promotionEligible: false,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(`saved=${output} analyses=${analyses.length}`);
for (const row of analyses.slice(0, 30)) console.log(JSON.stringify({
  features: row.features,
  style: row.styleKey,
  samples: row.samples,
  actionChanges: row.actionChanges,
  actionChangeRate: row.actionChangeRate,
  clusters: row.independentClusters,
  rankMean: row.rank.mean,
  rankLower95: row.rank.lower95,
  hpMean: row.hp.mean,
  hpLower95: row.hp.lower95,
  pass: row.passesTrainingScreen,
}));
