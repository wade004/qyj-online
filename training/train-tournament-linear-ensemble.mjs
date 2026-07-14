#!/usr/bin/env node

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { trainTournamentLinearEnsemble } from './tournament-policy/linear-ensemble-model.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const input = value('--input');
const output = value('--output');
if (!input || !output) throw new TypeError('--input and --output are required');
const dataset = JSON.parse(await readFile(resolve(input), 'utf8'));
const model = trainTournamentLinearEnsemble(dataset, {
  tableSize: Number(value('--table', 6)),
  dimensions: Number(value('--dimensions', 256)),
  epochs: Number(value('--epochs', 24)),
  learningRate: Number(value('--learning-rate', 0.025)),
  l2: Number(value('--l2', 0.0005)),
  maxImportanceWeight: Number(value('--max-importance-weight', 8)),
  minGroups: Number(value('--min-groups', 8)),
  minActionSamples: Number(value('--min-action-samples', 8)),
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
  models: model.models.length,
  meanRankRmse: model.models.reduce((sum, item) => sum + item.rankRmse, 0)
    / model.models.length,
  meanHpRmse: model.models.reduce((sum, item) => sum + item.hpRmse, 0)
    / model.models.length,
}));
