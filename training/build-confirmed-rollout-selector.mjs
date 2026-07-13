#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { buildConfirmedRolloutSelector } from './eval/confirmed-rollout-selector.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const inputs = String(value('--inputs', '')).split(',').map((item) => item.trim()).filter(Boolean);
if (!inputs.length) throw new RangeError('--inputs requires confirmation guidance artifacts');
const selector = buildConfirmedRolloutSelector(inputs.map((input) => (
  JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'))
)), { minLowerBound: Number(value('--min-lcb', 5)) });
const output = path.resolve(value(
  '--output', 'training/checkpoints/qyj-v64-confirmed-rollout-selector.json',
));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(selector, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, validation: selector.validation }));
