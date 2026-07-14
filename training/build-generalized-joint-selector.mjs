#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { buildGeneralizedJointOptionSelector } from './blueprint/residual-selector.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
for (const flag of ['--base-selector', '--calibration', '--base-dataset', '--output']) {
  if (!value(flag)) throw new RangeError(`${flag} is required`);
}
const presets = {
  street: ['s'],
  street_risk: ['s', 'stk', 'spr', 'r', 'rc'],
  street_position: ['s', 'p', 'ip'],
  street_texture: ['s', 'h', 'b', 'tc'],
  structural: ['s', 'n', 'p', 'ip', 'cl', 'stk', 'spr', 'r', 'rc'],
  balanced: ['s', 'n', 'p', 'ip', 'cl', 'h', 'b', 'stk', 'spr', 'r', 'rc'],
  tactical: ['s', 'n', 'p', 'ip', 'cl', 'h', 'b', 'stk', 'spr', 'tc', 'r', 'rc'],
};
const preset = value('--preset', 'balanced');
if (!presets[preset]) throw new RangeError(`unknown --preset ${preset}`);
const read = (flag) => JSON.parse(fs.readFileSync(path.resolve(value(flag)), 'utf8'));
const selector = buildGeneralizedJointOptionSelector(
  read('--base-selector'), read('--calibration'), read('--base-dataset'), {
    featureOrder: presets[preset],
    minSimilarity: Number(value('--min-similarity', 0.75)),
    neighborCount: Number(value('--neighbors', 5)),
    minNeighbors: Number(value('--min-neighbors', 3)),
    uncertaintyPenalty: Number(value('--uncertainty-penalty', 1.64)),
    minPredictedValue: Number(value('--min-predicted-value', 0)),
    minPolicyTV: Number(value('--min-policy-tv', 0.001)),
    minValidationPrecision: Number(value('--min-validation-precision', 0.75)),
    minValidationSelected: Number(value('--min-validation-selected', 3)),
  },
);
const output = path.resolve(value('--output'));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(selector, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, preset, validation: selector.validation }));
