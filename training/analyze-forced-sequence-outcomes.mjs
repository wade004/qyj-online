#!/usr/bin/env node

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const input = resolve(value('--input'));
const output = resolve(value('--output', 'training/artifacts/qyj-forced-sequence-analysis.json'));
const fields = String(value('--fields', 's,a,tc,r')).split(',').filter(Boolean);
const artifact = JSON.parse(await readFile(input, 'utf8'));
if (artifact?.schema !== 'qyj-forced-sequence-outcomes-v1' || artifact.version !== 1
  || !Array.isArray(artifact.records)) {
  throw new TypeError('invalid forced sequence outcome artifact');
}

const T95 = [Infinity, Infinity, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447,
  2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12,
  2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056,
  2.052, 2.048, 2.045];
const t95 = (n) => T95[Math.min(30, Math.max(0, n))] || 1.96;
const buckets = new Map();
for (const row of artifact.records) {
  const features = Object.fromEntries(fields.map((field) => [field, row.features?.[field]]));
  const key = JSON.stringify([
    features, row.baselineActionKey, row.firstActionKey, row.continuationActionKey,
  ]);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      features,
      baselineActionKey: row.baselineActionKey,
      firstActionKey: row.firstActionKey,
      continuationActionKey: row.continuationActionKey,
      records: [],
    };
    buckets.set(key, bucket);
  }
  bucket.records.push(row);
}

const metric = (values) => {
  const mean = values.reduce((sum, current) => sum + current, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((sum, current) => sum + ((current - mean) ** 2), 0)
      / (values.length - 1) : 0;
  const standardError = values.length > 1 ? Math.sqrt(variance / values.length) : Infinity;
  const critical = t95(values.length);
  return {
    mean,
    standardError: Number.isFinite(standardError) ? standardError : null,
    lower95: Number.isFinite(standardError) ? mean - critical * standardError : null,
    upper95: Number.isFinite(standardError) ? mean + critical * standardError : null,
    min: Math.min(...values),
    max: Math.max(...values),
  };
};
const analyses = [...buckets.values()].map((bucket) => {
  const byCluster = new Map();
  for (const row of bucket.records) {
    const cluster = byCluster.get(row.clusterId) || [];
    cluster.push(row);
    byCluster.set(row.clusterId, cluster);
  }
  const clusterRows = [...byCluster].map(([clusterId, rows]) => ({
    clusterId,
    records: rows.length,
    rankAdvantage: rows.reduce((sum, row) => sum + row.rankAdvantage, 0) / rows.length,
    hpAdvantage: rows.reduce((sum, row) => sum + row.hpAdvantage, 0) / rows.length,
    continuationReachRate: rows.filter((row) => row.continuationReached).length / rows.length,
  }));
  const rank = metric(clusterRows.map((row) => row.rankAdvantage));
  const hp = metric(clusterRows.map((row) => row.hpAdvantage));
  return {
    features: bucket.features,
    baselineActionKey: bucket.baselineActionKey,
    firstActionKey: bucket.firstActionKey,
    continuationActionKey: bucket.continuationActionKey,
    records: bucket.records.length,
    independentClusters: clusterRows.length,
    continuationReachRate: bucket.records.filter((row) => row.continuationReached).length
      / bucket.records.length,
    rank,
    hp,
    clusterRows,
    passesTrainingScreen: clusterRows.length >= 4 && rank.lower95 >= 0 && hp.lower95 >= 0,
  };
}).sort((left, right) => Number(right.passesTrainingScreen) - Number(left.passesTrainingScreen)
  || right.independentClusters - left.independentClusters || right.rank.mean - left.rank.mean
  || right.hp.mean - left.hp.mean);

const analysis = {
  schema: 'qyj-forced-sequence-analysis-v1',
  version: 1,
  mode: 'offline-evaluation-only',
  tableSize: artifact.tableSize,
  groupingFields: fields,
  sourceSeedClusters: artifact.seedClusters,
  sourceRecords: artifact.records.length,
  analyses,
  promotionEligible: false,
  promotionBlockers: ['training-screen-is-not-independent-league-validation'],
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
console.log(`saved=${output} analyses=${analyses.length}`);
for (const row of analyses) {
  console.log(JSON.stringify({
    features: row.features,
    pair: `${row.baselineActionKey}=>${row.firstActionKey}=>${row.continuationActionKey}`,
    records: row.records,
    clusters: row.independentClusters,
    reach: row.continuationReachRate,
    rankMean: row.rank.mean,
    rankLower95: row.rank.lower95,
    hpMean: row.hp.mean,
    hpLower95: row.hp.lower95,
    pass: row.passesTrainingScreen,
  }));
}
