#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { buildJointCalibratedContinuationOptionSelector }
  from './blueprint/residual-selector.mjs';

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
};
for (const flag of ['--base-selector', '--calibration', '--output']) {
  if (!value(flag)) throw new RangeError(`${flag} is required`);
}
const read = (flag) => JSON.parse(fs.readFileSync(path.resolve(value(flag)), 'utf8'));
const selector = buildJointCalibratedContinuationOptionSelector(
  read('--base-selector'),
  read('--calibration'),
  { minJointLowerBound: Number(value('--min-joint-lcb') || 0) },
);
const output = path.resolve(value('--output'));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(selector, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  output,
  roots: selector.roots.length,
  thresholds: selector.thresholds,
}));
