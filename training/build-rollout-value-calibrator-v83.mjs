#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { buildRolloutValueCalibrator } from './eval/rollout-value-calibrator.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const inputs = String(value('--development', '')).split(',')
  .map((item) => item.trim()).filter(Boolean).map((item) => path.resolve(item));
if (!inputs.length) throw new RangeError('--development requires dataset paths');
const artifact = buildRolloutValueCalibrator(inputs.map(
  (item) => JSON.parse(fs.readFileSync(item, 'utf8')),
));
const output = path.resolve(value(
  '--output', 'training/checkpoints/qyj-v83-rollout-value-calibrator.json',
));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  output,
  records: artifact.developmentRecords.length,
  clusters: artifact.developmentClusterSha256.length,
  calibrationPassed: artifact.calibration.passed,
  selected: artifact.calibration.selected,
}));
