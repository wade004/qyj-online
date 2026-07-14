#!/usr/bin/env node

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { trainTournamentTrajectoryPolicy } from './tournament-policy/model.mjs';

function parseArgs(argv) {
  const result = {
    input: null,
    output: 'training/checkpoints/qyj-v118-tournament-trajectory-policy.json',
    confidenceZ: 1.96,
    minGroups: 3,
    minSamples: 12,
    minAdvantage: 0,
    requirePropensity: false,
    rewardMode: 'rank',
  };
  const value = (index, flag) => {
    if (index + 1 >= argv.length) throw new TypeError(`${flag} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--input') result.input = value(index++, flag);
    else if (flag === '--output') result.output = value(index++, flag);
    else if (flag === '--confidence-z') result.confidenceZ = Number(value(index++, flag));
    else if (flag === '--min-groups') result.minGroups = Number(value(index++, flag));
    else if (flag === '--min-samples') result.minSamples = Number(value(index++, flag));
    else if (flag === '--min-advantage') result.minAdvantage = Number(value(index++, flag));
    else if (flag === '--require-propensity') result.requirePropensity = true;
    else if (flag === '--reward-mode') result.rewardMode = value(index++, flag);
    else throw new TypeError(`unknown option ${flag}`);
  }
  if (!result.input) throw new TypeError('--input is required');
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dataset = JSON.parse(await readFile(resolve(options.input), 'utf8'));
  const artifact = trainTournamentTrajectoryPolicy(dataset, options);
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(`saved=${output} rows=${artifact.training.rows}`
    + ` groups=${artifact.training.sourceGroups} masks=${Object.keys(artifact.heads).length}`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
