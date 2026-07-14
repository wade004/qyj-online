#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { buildRolloutValueSelector } from './eval/rollout-value-selector.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const inputs = String(value('--inputs', '')).split(',').map((item) => item.trim()).filter(Boolean);
if (!inputs.length) throw new RangeError('--inputs requires rollout guidance artifacts');
const selector = buildRolloutValueSelector(inputs.map((input) => (
  JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'))
)), {
  minActualLowerBound: Number(value('--min-lcb', 5)),
  dimension: Number(value('--dimension', 8192)),
  epochs: Number(value('--epochs', 240)),
  learningRate: Number(value('--learning-rate', 0.32)),
  l2: Number(value('--l2', 0.002)),
  minPrecision: Number(value('--min-precision', 0.75)),
  minSelectedPerTable: Number(value('--min-selected-per-table', 3)),
});
const output = path.resolve(value(
  '--output', 'training/checkpoints/qyj-v63-rollout-value-selector.json',
));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(selector, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  output,
  split: selector.split,
  calibration: selector.calibration,
  test: selector.test,
}));
