#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { buildEmpiricalTrajectoryOptionSelector } from './blueprint/residual-selector.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
for (const flag of ['--base-selector', '--guidance', '--output']) {
  if (!value(flag)) throw new RangeError(`${flag} is required`);
}
const read = (flag) => JSON.parse(fs.readFileSync(path.resolve(value(flag)), 'utf8'));
const selector = buildEmpiricalTrajectoryOptionSelector(read('--base-selector'), read('--guidance'), {
  gateMetric: value('--gate-metric', 'both'),
  minLowerBound: Number(value('--min-lower-bound', 0)),
  minIndependentClusters: Number(value('--min-independent-clusters', 4)),
});
const output = path.resolve(value('--output'));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(selector, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, validation: selector.empiricalTrajectoryValidation }));
