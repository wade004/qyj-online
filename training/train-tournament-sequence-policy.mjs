#!/usr/bin/env node

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { trainTournamentSequencePolicy } from './tournament-policy/sequence-model.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const input = value('--input');
const output = value('--output', 'training/checkpoints/qyj-v124-tournament-sequence-policy.json');
if (!input) throw new TypeError('--input is required');
const dataset = JSON.parse(await readFile(resolve(input), 'utf8'));
const artifact = trainTournamentSequencePolicy(dataset, {
  minGroups: Number(value('--min-groups', 3)),
  minSamples: Number(value('--min-samples', 12)),
  minAdvantage: Number(value('--min-advantage', 0.02)),
  confidenceZ: Number(value('--confidence-z', 0)),
  maxImportanceWeight: Number(value('--max-importance-weight', 64)),
  rewardMode: String(value('--reward-mode', 'rank-hp')),
  minReachRate: Number(value('--min-reach-rate', 0)),
});
const destination = resolve(output);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(`saved=${destination} rows=${artifact.training.rows}`
  + ` trajectories=${artifact.training.trajectories} pairs=${artifact.training.pairs}`);
