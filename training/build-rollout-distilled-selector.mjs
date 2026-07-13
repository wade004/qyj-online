#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { buildRolloutDistilledSelector } from './eval/rollout-distilled-selector.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const inputs = String(value('--inputs', '')).split(',').map((item) => item.trim()).filter(Boolean);
if (!inputs.length) throw new RangeError('--inputs requires rollout guidance artifacts');
const selector = buildRolloutDistilledSelector(inputs.map((input) => (
  JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'))
)), {
  minSimilarity: Number(value('--min-similarity', 0.5)),
  neighborCount: Number(value('--neighbors', 5)),
  minNeighbors: Number(value('--min-neighbors', 2)),
  uncertaintyPenalty: Number(value('--uncertainty-penalty', 1.64)),
  minPredictedLowerBound: Number(value('--min-lcb', 5)),
  minValidationPrecision: Number(value('--min-validation-precision', 0.75)),
  minValidationSelected: Number(value('--min-validation-selected', 3)),
});
const output = path.resolve(value(
  '--output', 'training/checkpoints/qyj-v63-rollout-distilled-selector.json',
));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(selector, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, roots: selector.roots.length, validation: selector.validation }));
