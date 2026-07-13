#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { buildCausalHarmGate } from './eval/causal-harm-gate.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const developmentPaths = String(value('--development', '')).split(',')
  .map((item) => item.trim()).filter(Boolean).map((item) => path.resolve(item));
if (!developmentPaths.length) {
  throw new RangeError('--development requires comma-separated intervention datasets');
}
const datasets = developmentPaths.map((item) => JSON.parse(fs.readFileSync(item, 'utf8')));
const artifact = buildCausalHarmGate(datasets, {
  targetResolverStrategyKey: String(value(
    '--target-resolver-strategy', 'online-resolver-v19-table-powered',
  )),
});
const output = path.resolve(value(
  '--output', 'training/checkpoints/qyj-v78-causal-harm-gate.json',
));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  output,
  records: artifact.developmentRecords.length,
  clusters: artifact.developmentClusterSha256.length,
  calibrationPassed: artifact.calibration.passed,
  hyperparameters: artifact.hyperparameters,
  byTable: artifact.calibration.selected?.byTable || null,
}));
