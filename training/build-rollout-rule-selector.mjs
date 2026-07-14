#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { buildRolloutRuleSelector } from './eval/rollout-rule-selector.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const inputs = String(value('--inputs', '')).split(',').map((item) => item.trim()).filter(Boolean);
if (!inputs.length) throw new RangeError('--inputs requires rollout guidance artifacts');
const selector = buildRolloutRuleSelector(inputs.map((input) => (
  JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'))
)), {
  minActualLowerBound: Number(value('--min-lcb', 5)),
  minTrainSamples: Number(value('--min-train-samples', 4)),
  minTrainGroups: Number(value('--min-train-groups', 3)),
  minTrainPrecision: Number(value('--min-train-precision', 0.9)),
  maxFeatures: Number(value('--max-features', 4)),
  minValidationSelected: Number(value('--min-validation-selected', 3)),
  minValidationPrecision: Number(value('--min-validation-precision', 0.75)),
});
const output = path.resolve(value(
  '--output', 'training/checkpoints/qyj-v63-rollout-rule-selector.json',
));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(selector, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, rules: selector.rules.length, validation: selector.validation }));
