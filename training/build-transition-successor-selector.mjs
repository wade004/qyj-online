#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { buildTransitionConditionedOptionSelector } from './blueprint/residual-selector.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
for (const flag of ['--base-selector', '--successor-guidance', '--successor-artifacts', '--output']) {
  if (!value(flag)) throw new RangeError(`${flag} is required`);
}
const readPath = (input) => JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
const base = readPath(value('--base-selector'));
const guidance = readPath(value('--successor-guidance'));
const artifacts = String(value('--successor-artifacts')).split(',')
  .map((entry) => entry.trim()).filter(Boolean).map(readPath);
const features = (flag, fallback) => String(value(flag, fallback)).split(',')
  .map((entry) => entry.trim()).filter(Boolean);
const selector = buildTransitionConditionedOptionSelector(base, guidance, artifacts, {
  startFeatureOrder: features('--start-features', (base.featureOrder || []).join(',')),
  successorFeatureOrder: features('--successor-features', 's'),
  minSimilarity: Number(value('--min-similarity', 0.75)),
  neighborCount: Number(value('--neighbors', 3)),
  minNeighbors: Number(value('--min-neighbors', 1)),
  uncertaintyPenalty: Number(value('--uncertainty-penalty', 1.64)),
  minPredictedValue: Number(value('--min-predicted-value', 0)),
  minPolicyTV: Number(value('--min-policy-tv', 0.001)),
  minPositiveLcbActionShift: Number(value('--min-positive-lcb-action-shift', 0.01)),
  maxTransitionPolicyTV: Number(value('--max-transition-policy-tv', 0.05)),
  minValidationPrecision: Number(value('--min-validation-precision', 0.75)),
  minValidationSelected: Number(value('--min-validation-selected', 3)),
});
const output = path.resolve(value('--output'));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(selector, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  output,
  tableSize: selector.tableSize,
  transitionRoots: selector.transition.roots.length,
  startFeatureOrder: selector.transition.startFeatureOrder,
  successorFeatureOrder: selector.transition.successorFeatureOrder,
  validation: selector.transitionValidation,
}));
