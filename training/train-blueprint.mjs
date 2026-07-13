#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { compileBlueprintCheckpoint } from '../js/game/blueprint-policy.js';
import { ExternalSamplingMccfr } from './blueprint/mccfr.js';
import { QyjAbstractHoldemGame } from './blueprint/qyj-abstract-game.js';
import {
  addBlueprintBackoffInfosets,
  summarizeBlueprintCoverage,
} from './blueprint/curriculum.js';

const DEFAULT_OUTPUT = 'training/checkpoints/qyj-blueprint-v2.json';

function usage() {
  return `QYJ no-skill abstract blueprint trainer

Usage:
  node training/train-blueprint.mjs [options]

Options:
  --iterations N       Additional MCCFR iterations (default: 1000)
  --table-size N       Seats, 2..9 (default: 2)
  --stack-bb N         Starting stack in big blinds (default: 20)
  --round N            QYJ round bucket to train, 1..12 (default: 1)
  --max-raises N       Blueprint action-abstraction cap, 0..3 (default: 3)
  --seed TEXT          Deterministic seed (default: qyj-blueprint)
  --blend-weight N     Runtime blueprint mixture weight, 0..1 (default: 0.25)
  --output PATH        Checkpoint JSON path (default: ${DEFAULT_OUTPUT})
  --resume PATH        Resume a checkpoint including trainerState
  --progress N         Print every N completed iterations (default: 100)
  --runtime-only       Omit regrets/RNG state; resulting file cannot resume
  --help               Show this message

Scope: single-hand, no-skill Hold'em; live 1/3, 1/2, 2/3-pot/all-in action abstraction.
This is a bootstrap blueprint, not a full nine-player/12-hand equilibrium solver.`;
}

function parseNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${flag} requires a finite number`);
  return number;
}

function parseArgs(argv) {
  const result = {
    iterations: 1000,
    tableSize: 2,
    stackBb: 20,
    round: 1,
    maxRaisesPerStreet: 3,
    seed: 'qyj-blueprint',
    blendWeight: 0.25,
    output: DEFAULT_OUTPUT,
    resume: null,
    progress: 100,
    runtimeOnly: false,
    explicit: new Set(),
  };
  const values = {
    '--iterations': ['iterations', true],
    '--table-size': ['tableSize', true],
    '--stack-bb': ['stackBb', true],
    '--round': ['round', true],
    '--max-raises': ['maxRaisesPerStreet', true],
    '--seed': ['seed', false],
    '--blend-weight': ['blendWeight', true],
    '--output': ['output', false],
    '--resume': ['resume', false],
    '--progress': ['progress', true],
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--runtime-only') {
      result.runtimeOnly = true;
      continue;
    }
    const spec = values[flag];
    if (!spec) throw new TypeError(`Unknown option ${flag}`);
    const value = argv[++index];
    if (value == null) throw new TypeError(`${flag} requires a value`);
    result[spec[0]] = spec[1] ? parseNumber(value, flag) : value;
    result.explicit.add(spec[0]);
  }
  for (const key of ['iterations', 'tableSize', 'round', 'maxRaisesPerStreet', 'progress']) {
    if (!Number.isInteger(result[key])) throw new TypeError(`${key} must be an integer`);
  }
  if (result.iterations < 0 || result.progress < 1) {
    throw new RangeError('iterations must be >= 0 and progress must be >= 1');
  }
  if (result.blendWeight < 0 || result.blendWeight > 1) {
    throw new RangeError('blendWeight must be in 0..1');
  }
  return result;
}

async function loadJson(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  let checkpoint = null;
  let gameOptions = {
    tableSize: args.tableSize,
    stackBb: args.stackBb,
    round: args.round,
    maxRaisesPerStreet: args.maxRaisesPerStreet,
  };
  if (args.resume) {
    checkpoint = await loadJson(args.resume);
    const savedConfig = checkpoint.metadata?.gameConfig;
    if (!savedConfig || typeof savedConfig !== 'object') {
      throw new TypeError('Resumable checkpoint is missing metadata.gameConfig');
    }
    for (const key of ['tableSize', 'stackBb', 'round', 'maxRaisesPerStreet']) {
      if (args.explicit.has(key) && Number(args[key]) !== Number(savedConfig[key])) {
        throw new RangeError(`${key} cannot change when resuming a checkpoint`);
      }
    }
    const savedSeed = checkpoint.metadata?.seed ?? checkpoint.trainerState?.rng?.seed;
    if (args.explicit.has('seed') && String(args.seed) !== String(savedSeed)) {
      throw new RangeError(`seed cannot change when resuming a checkpoint`
        + ` (saved=${String(savedSeed)}, requested=${String(args.seed)})`);
    }
    gameOptions = savedConfig;
  }

  const game = new QyjAbstractHoldemGame(gameOptions);
  const trainer = checkpoint
    ? ExternalSamplingMccfr.fromCheckpoint(game, checkpoint)
    : new ExternalSamplingMccfr(game, {
      seed: args.seed,
      blendWeight: args.blendWeight,
    });
  // Changing this value does not alter the sampled training trajectory. It is
  // an explicit runtime publication setting, so allow callers to revise it on
  // resume instead of silently ignoring the flag.
  if (checkpoint && args.explicit.has('blendWeight')) {
    trainer.blendWeight = args.blendWeight;
  }
  const startingIteration = trainer.iterations;
  const startedAt = Date.now();
  trainer.train(args.iterations, {
    onProgress(summary) {
      const completed = summary.iterations - startingIteration;
      if (completed % args.progress === 0 || completed === args.iterations) {
        const seconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
        console.log(`iteration=${summary.iterations} infosets=${summary.infoSets}`
          + ` utilitySamples=${summary.utilitySamples} speed=${Math.round(completed / seconds)}/s`);
      }
    },
  });

  const output = trainer.toCheckpoint({
    includeTrainerState: !args.runtimeOnly,
    metadata: {
      gameConfig: game.config,
      seed: checkpoint?.metadata?.seed ?? checkpoint?.trainerState?.rng?.seed ?? args.seed,
      trainingScope: 'single-hand-no-skill-capped-betting',
      limitations: [
        'not the full 12-hand QYJ tournament',
        'hero skills and energy are disabled',
        'live 1/3, 1/2, 2/3-pot/all-in sizes with a per-street raise cap',
        game.playerCount > 2
          ? 'multiplayer regret minimisation has no Nash convergence guarantee'
          : 'lossy information/action abstraction prevents an exact-game guarantee',
      ],
    },
  });
  addBlueprintBackoffInfosets(output);
  output.metadata.coverage = summarizeBlueprintCoverage(output);
  // Run the same validator used by browsers before writing the artifact.
  compileBlueprintCheckpoint(output);
  const outputPath = resolve(args.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  const summary = trainer.summary();
  console.log(`saved=${outputPath}`);
  console.log(JSON.stringify(summary));
  console.log(JSON.stringify(output.metadata.coverage));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
