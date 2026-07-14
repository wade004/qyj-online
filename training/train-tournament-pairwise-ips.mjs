#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  trainTournamentPairwiseIpsEnsemble,
  trainTournamentPairwiseJackknifeIps,
} from './tournament-policy/pairwise-ips-ensemble.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const input = value('--input');
const output = value('--output');
const jackknife = args.includes('--jackknife');
if (!input || !output) throw new TypeError('--input and --output are required');
const dataset = JSON.parse(await readFile(resolve(input), 'utf8'));
const train = jackknife
  ? trainTournamentPairwiseJackknifeIps
  : trainTournamentPairwiseIpsEnsemble;
const model = train(dataset, {
  tableSize: Number(value('--table', 6)),
  dimensions: Number(value('--dimensions', 128)),
  epochs: Number(value('--epochs', 30)),
  learningRate: Number(value('--learning-rate', 0.02)),
  l2: Number(value('--l2', 0.001)),
  maxPseudoOutcome: Number(value('--max-pseudo-outcome', 8)),
  minGroups: Number(value('--min-groups', 8)),
  minPairSamples: Number(value('--min-pair-samples', 12)),
  minAdvantage: Number(value('--min-advantage', 0.005)),
});
const destination = resolve(output);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(model)}\n`, 'utf8');
console.log(JSON.stringify({
  output: destination,
  tableSize: model.tableSize,
  rows: model.training.rows,
  groups: model.training.sourceGroups,
  pairs: jackknife
    ? Object.keys(model.pairs).length
    : [...new Set(model.models.flatMap((group) => Object.keys(group.pairs)))].length,
  estimator: model.training.estimator,
}));
