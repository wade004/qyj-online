#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { buildSuccessorAugmentedOptionSelector } from './blueprint/residual-selector.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
for (const flag of ['--base-selector', '--successor-guidance', '--output']) {
  if (!value(flag)) throw new RangeError(`${flag} is required`);
}
const read = (flag) => JSON.parse(fs.readFileSync(path.resolve(value(flag)), 'utf8'));
const base = read('--base-selector');
const successorBasePath = value('--successor-base');
const order = String(value('--features', (base.featureOrder || []).join(',')))
  .split(',').map((feature) => feature.trim()).filter(Boolean);
const selector = buildSuccessorAugmentedOptionSelector(base, read('--successor-guidance'), {
  ...(successorBasePath
    ? { baseDataset: JSON.parse(fs.readFileSync(path.resolve(successorBasePath), 'utf8')) } : {}),
  featureOrder: order,
  minSimilarity: Number(value('--min-similarity', 0.75)),
  neighborCount: Number(value('--neighbors', 3)),
  minNeighbors: Number(value('--min-neighbors', 1)),
  uncertaintyPenalty: Number(value('--uncertainty-penalty', 1.64)),
  minPredictedValue: Number(value('--min-predicted-value', 0)),
  minPolicyTV: Number(value('--min-policy-tv', 0.001)),
});
const output = path.resolve(value('--output'));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(selector, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  output,
  tableSize: selector.tableSize,
  successorRoots: selector.successor.roots.length,
  featureOrder: selector.successor.featureOrder,
  ...(selector.successorValidation ? { validation: selector.successorValidation } : {}),
}));
