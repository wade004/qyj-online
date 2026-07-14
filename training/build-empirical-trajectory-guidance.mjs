#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash, createHmac } from 'node:crypto';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
for (const flag of ['--report', '--selector', '--output']) {
  if (!value(flag)) throw new RangeError(`${flag} is required`);
}
const secretName = value('--cluster-secret');
if (!secretName || !process.env[secretName] || Buffer.byteLength(process.env[secretName]) < 32) {
  throw new RangeError('--cluster-secret must name an environment value of at least 32 bytes');
}
const readText = (flag) => fs.readFileSync(path.resolve(value(flag)), 'utf8');
const reportText = readText('--report');
const selectorText = readText('--selector');
const report = JSON.parse(reportText);
const selector = JSON.parse(selectorText);
if (selector.schema !== 'qyj-residual-transition-conditioned-option-selector-v9'
  || report?.config?.residualSelector?.schema !== selector.schema
  || !Array.isArray(report.matches)) {
  throw new TypeError('report and V9 selector are not compatible');
}
const semanticSha = createHash('sha256').update(JSON.stringify(selector)).digest('hex');
const fileSha = createHash('sha256').update(selectorText).digest('hex');
if (report.config.residualSelector.sha256 !== fileSha) {
  throw new RangeError('report residual selector file SHA mismatch');
}
const candidate = String(report.promotion?.candidate || 'residual-candidate');
const baseline = String(report.promotion?.baseline || 'qyz');
const baselines = new Map();
for (const match of report.matches) {
  const rows = (match.results || []).filter((row) => row.strategy === baseline);
  if (!rows.length) continue;
  const entry = baselines.get(match.seedGroup) || { ranks: [], hps: [] };
  entry.ranks.push(...rows.map((row) => Number(row.rank)));
  entry.hps.push(...rows.map((row) => Number(row.hp)));
  baselines.set(match.seedGroup, entry);
}
const means = (values) => values.reduce((sum, item) => sum + item, 0) / values.length;
const observations = new Map();
for (const match of report.matches) {
  const base = baselines.get(match.seedGroup);
  if (!base) continue;
  const baselineRank = means(base.ranks);
  const baselineHp = means(base.hps);
  for (const row of match.results || []) {
    if (row.strategy !== candidate) continue;
    for (const trajectory of row.residualTrajectories || []) {
      if (Number(trajectory.actionChanges) < 1) continue;
      const trajectoryBucketSha256 = trajectory.trajectoryBucketSha256
        || trajectory.trajectorySha256;
      if (!/^[0-9a-f]{64}$/.test(String(trajectoryBucketSha256 || ''))) continue;
      const bySeed = observations.get(trajectoryBucketSha256) || new Map();
      const bucket = bySeed.get(match.seedGroup) || {
        rank: [], hp: [], actionChanges: 0, continuations: 0,
      };
      bucket.rank.push(baselineRank - Number(row.rank));
      bucket.hp.push(Number(row.hp) - baselineHp);
      bucket.actionChanges += Number(trajectory.actionChanges);
      bucket.continuations += Number(trajectory.continuations);
      bySeed.set(match.seedGroup, bucket);
      observations.set(trajectoryBucketSha256, bySeed);
    }
  }
}
const lowerBound = (values) => {
  const mean = means(values);
  if (values.length < 2) return { mean, lowerBound: null };
  const variance = values.reduce((sum, item) => sum + ((item - mean) ** 2), 0)
    / (values.length - 1);
  const t = 1.644854 + 0.710 / (values.length - 1);
  return { mean, lowerBound: mean - t * Math.sqrt(variance / values.length) };
};
const secret = process.env[secretName];
const records = {};
for (const [trajectorySha256, bySeed] of [...observations].sort()) {
  const clusters = [...bySeed].map(([seed, bucket]) => ({
    clusterId: `ec_${createHmac('sha256', secret).update(seed).digest('hex')}`,
    rankAdvantage: means(bucket.rank),
    hpAdvantage: means(bucket.hp),
    actionChanges: bucket.actionChanges,
    continuations: bucket.continuations,
  })).sort((left, right) => left.clusterId.localeCompare(right.clusterId));
  const rank = lowerBound(clusters.map((cluster) => cluster.rankAdvantage));
  const hp = lowerBound(clusters.map((cluster) => cluster.hpAdvantage));
  records[trajectorySha256] = {
    independentClusterCount: clusters.length,
    actionChanges: clusters.reduce((sum, cluster) => sum + cluster.actionChanges, 0),
    continuations: clusters.reduce((sum, cluster) => sum + cluster.continuations, 0),
    rankMean: rank.mean,
    rankLowerBound: rank.lowerBound,
    hpMean: hp.mean,
    hpLowerBound: hp.lowerBound,
    clusters,
  };
}
const artifact = {
  schema: 'qyj-empirical-trajectory-guidance-v1',
  version: 1,
  mode: 'offline-evaluation-only',
  selectorSemanticSha256: semanticSha,
  selectorFileSha256: fileSha,
  reportSha256: createHash('sha256').update(reportText).digest('hex'),
  sourceGroupSecretId: `es_${createHash('sha256').update(secret).digest('hex')}`,
  tableSize: report.config.tableSize,
  candidate,
  baseline,
  records,
  promotionEligible: false,
  promotionBlockers: ['empirical-trajectory-below-formal-scale', 'offline-evaluation-only'],
};
const output = path.resolve(value('--output'));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  output,
  trajectories: Object.keys(records).length,
  clusters: new Set(Object.values(records).flatMap((record) => (
    record.clusters.map((cluster) => cluster.clusterId)
  ))).size,
  actionChanges: Object.values(records).reduce((sum, record) => sum + record.actionChanges, 0),
}));
