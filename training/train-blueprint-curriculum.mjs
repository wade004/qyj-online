#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import {
  summarizeBlueprintCoverage,
  trainBlueprintCurriculum,
} from './blueprint/curriculum.js';

const DEFAULT_OUTPUT = 'training/checkpoints/qyj-blueprint-v2-curriculum.json';

function usage() {
  return `QYJ blueprint v2 coverage curriculum

Usage:
  node training/train-blueprint-curriculum.mjs [options]

Options:
  --preset <6max|9max>       Player-count curriculum (default: 6max)
  --table-sizes <2,3,...>    Explicit surviving-player counts
  --rounds <1,4,7,10>        Representative QYJ rounds (default: 2,5,8,11)
  --stack-bbs <8,20,80>      Effective-stack curriculum
  --iterations N             MCCFR iterations per configuration (default: 100)
  --max-raises N             Blueprint action-abstraction cap, 0..3 (default: 3)
  --seed TEXT                Deterministic root seed
  --blend-weight N           Runtime mixture request, 0..1 (default: 0.25)
  --min-exact-visits N       Publish exact nodes from N visits (default: 50)
  --min-backoff-visits N     Publish backoff nodes from N visits (default: 10)
  --output PATH              Output checkpoint (default: ${DEFAULT_OUTPUT})
  --quiet                    Do not print per-configuration progress
  --help                     Show this message`;
}

function list(value, flag) {
  const parsed = String(value).split(',').map((item) => Number(item.trim()));
  if (!parsed.length || parsed.some((item) => !Number.isFinite(item))) {
    throw new TypeError(`${flag} requires a comma-separated numeric list`);
  }
  return parsed;
}

function parseArgs(argv) {
  const args = {
    preset: '6max',
    tableSizes: null,
    rounds: [2, 5, 8, 11],
    stackBbs: [8, 20, 80],
    iterationsPerConfig: 100,
    maxRaisesPerStreet: 3,
    seed: 'qyj-blueprint-v2-curriculum',
    blendWeight: 0.25,
    minExactVisits: 50,
    minBackoffVisits: 10,
    output: DEFAULT_OUTPUT,
    quiet: false,
  };
  const valueAfter = (index, flag) => {
    if (index + 1 >= argv.length) throw new TypeError(`${flag} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--quiet') args.quiet = true;
    else if (flag === '--preset') args.preset = valueAfter(index++, flag);
    else if (flag === '--table-sizes') args.tableSizes = list(valueAfter(index++, flag), flag);
    else if (flag === '--rounds') args.rounds = list(valueAfter(index++, flag), flag);
    else if (flag === '--stack-bbs') args.stackBbs = list(valueAfter(index++, flag), flag);
    else if (flag === '--iterations') args.iterationsPerConfig = Number(valueAfter(index++, flag));
    else if (flag === '--max-raises') args.maxRaisesPerStreet = Number(valueAfter(index++, flag));
    else if (flag === '--seed') args.seed = valueAfter(index++, flag);
    else if (flag === '--blend-weight') args.blendWeight = Number(valueAfter(index++, flag));
    else if (flag === '--min-exact-visits') args.minExactVisits = Number(valueAfter(index++, flag));
    else if (flag === '--min-backoff-visits') args.minBackoffVisits = Number(valueAfter(index++, flag));
    else if (flag === '--output') args.output = valueAfter(index++, flag);
    else throw new TypeError(`Unknown option ${flag}`);
  }
  if (!['6max', '9max'].includes(args.preset)) throw new RangeError('preset must be 6max or 9max');
  args.tableSizes ||= Array.from(
    { length: args.preset === '9max' ? 8 : 5 }, (_, index) => index + 2,
  );
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const checkpoint = trainBlueprintCurriculum({
    ...args,
    onProgress: args.quiet ? null : ({ completed, total, config, infoSets }) => {
      console.log(`[${completed}/${total}] n=${config.tableSize} round=${config.round}`
        + ` stack=${config.stackBb} infosets=${infoSets}`);
    },
  });
  const output = resolve(args.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
  console.log(`saved=${output}`);
  console.log(JSON.stringify(summarizeBlueprintCoverage(checkpoint)));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
