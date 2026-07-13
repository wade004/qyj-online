#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { buildResidualAdvantageGuidance } from './blueprint/residual-advantage.mjs';

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
};
for (const flag of ['--calibration', '--dataset', '--output']) {
  if (!value(flag)) throw new RangeError(`${flag} is required`);
}
const calibrationPaths = args.flatMap((arg, index) => (
  arg === '--calibration' && args[index + 1] ? [args[index + 1]] : []
));
const calibrations = calibrationPaths.map((file) => (
  JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
));
const first = calibrations[0];
for (const candidate of calibrations.slice(1)) {
  for (const field of [
    'schema', 'version', 'frozenPolicySha256', 'tournamentValueModelSha256',
    'tournamentValueReportSha256', 'basePolicyContract', 'baseStyleKey',
  ]) {
    if (candidate[field] !== first[field]) {
      throw new RangeError(`calibration binding mismatch: ${field}`);
    }
  }
}
const calibration = {
  ...first,
  records: Object.assign({}, ...calibrations.map((candidate) => candidate.records)),
};
const dataset = JSON.parse(fs.readFileSync(path.resolve(value('--dataset')), 'utf8'));
const guidance = buildResidualAdvantageGuidance(calibration, dataset);
const output = path.resolve(value('--output'));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(guidance, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, summary: guidance.summary }));
