#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { buildRealEngineTransferSelector } from './eval/real-engine-transfer-selector.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const inputs = String(value('--inputs', '')).split(',').map((item) => item.trim()).filter(Boolean);
if (!inputs.length) throw new RangeError('--inputs requires forced-branch calibration artifacts');
const calibrations = inputs.map((input) => {
  const raw = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
  if (raw?.schema !== 'qyj-forced-decision-branch-calibration-v1'
    || ![6, 9].includes(Number(raw?.tableSize)) || !raw?.records) {
    throw new TypeError(`unsupported forced-branch artifact: ${input}`);
  }
  return {
    schema: 'qyj-online-resolver-transfer-calibration-v1',
    version: 1,
    mode: 'offline-evaluation-only',
    tableSize: Number(raw.tableSize),
    resolverStrategyKey: 'qyz-forced-branch-policy',
    featureOrder: raw.featureOrder,
    tournamentValueSources: [],
    records: Object.fromEntries(Object.entries(raw.records).map(([recordId, record]) => [
      recordId,
      { ...record, baseActionKey: record.baselineActionKey },
    ])),
  };
});
const selector = buildRealEngineTransferSelector(calibrations, {
  resolverStrategyKey: 'qyz-forced-branch-policy',
  minSimilarity: Number(value('--min-similarity', 0.5)),
  neighborCount: Number(value('--neighbors', 12)),
  minNeighbors: Number(value('--min-neighbors', 4)),
  minIndependentClusters: Number(value('--min-clusters', 6)),
  minSamples: Number(value('--min-samples', 24)),
  minRankLowerBound: Number(value('--min-rank-lcb', 0)),
  minHpLowerBound: Number(value('--min-hp-lcb', 0)),
});
const output = path.resolve(value(
  '--output', 'training/checkpoints/qyj-v61-real-engine-policy-selector.json',
));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(selector, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, roots: selector.roots.length }));
