#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import {
  buildResidualInterventionSelector,
  buildResidualInterventionOptionSelector,
  buildResidualContinuationOptionSelector,
  buildResidualInterventionValueSelector,
} from './blueprint/residual-selector.mjs';

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
};
for (const flag of ['--model', '--guidance', '--output']) if (!value(flag)) throw new RangeError(`${flag} is required`);
const modelText = fs.readFileSync(path.resolve(value('--model')), 'utf8');
const guidancePaths = args.flatMap((arg, index) => arg === '--guidance' ? [args[index + 1]] : []);
const guidances = guidancePaths.map((file) => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')));
const valueHead = args.includes('--value-head');
const optionHead = args.includes('--option-head');
const continuationHead = args.includes('--continuation-head');
if ((valueHead || optionHead || continuationHead) && guidances.length !== 1) {
  throw new RangeError('value/option head requires exactly one table-specific guidance');
}
const builder = continuationHead ? buildResidualContinuationOptionSelector
  : optionHead ? buildResidualInterventionOptionSelector
  : valueHead ? buildResidualInterventionValueSelector : buildResidualInterventionSelector;
const selector = builder((valueHead || optionHead || continuationHead) ? guidances[0] : guidances, {
  residualModelSha256: createHash('sha256').update(modelText).digest('hex'),
  ...((valueHead || optionHead || continuationHead)
    ? { tableSize: Number(value('--table-size')) } : {}),
  minSimilarity: Number(value('--min-similarity') ?? 0.625),
  minAdvantageLowerBound: Number(value('--min-advantage-lcb') ?? 0.01),
  maxFallbackFeatures: Number(value('--max-fallback-features') ?? 3),
  minPolicyTV: Number(value('--min-policy-tv') ?? 0.001),
  neighborCount: Number(value('--neighbors') ?? 8),
  minNeighbors: Number(value('--min-neighbors') ?? 4),
  uncertaintyPenalty: Number(value('--uncertainty-penalty') ?? 1),
  minPredictedValue: Number(value('--min-predicted-value') ?? 0.001),
  optionHorizon: Number(value('--option-horizon') ?? 1),
  continuationMinPredictedValue: Number(
    value('--continuation-min-predicted-value') ?? value('--min-predicted-value') ?? 0.001,
  ),
});
const output = path.resolve(value('--output'));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(selector, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  output, roots: selector.roots.length, thresholds: selector.thresholds,
  ...(selector.validation ? { validation: selector.validation } : {}),
}));
