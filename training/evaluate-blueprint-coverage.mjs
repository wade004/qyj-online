#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  DEFAULT_MIN_HELDOUT_COVERAGE,
  DEFAULT_MIN_HELDOUT_DECISIONS,
  evaluateBlueprintHeldoutCoverage,
} from './blueprint/coverage.js';

function usage() {
  return `Evaluate reach-weighted blueprint coverage on unseen exact roots

Usage:
  node training/evaluate-blueprint-coverage.mjs [options]

Required:
  --checkpoint PATH       Published backoff checkpoint
  --source-exact PATH     Exact checkpoint used to derive the publication
  --profile PATH          Held-out reach profile; repeat for 6/9 tables
  --json PATH             Deterministic JSON report output

Options:
  --min-coverage RATE     Per-table gate (default: ${DEFAULT_MIN_HELDOUT_COVERAGE})
  --min-decisions N       Minimum unseen decisions per table (default: ${DEFAULT_MIN_HELDOUT_DECISIONS})
  --table-sizes CSV       Required table sizes (default: 6,9)
  --require-pass          Exit 2 when any formal gate fails
  --help                  Show this message

The evaluator excludes every root present in --source-exact. Held-out profile
hashes must differ from publication reach-evidence hashes; 6 and 9 tables pass
independently rather than through an aggregate average.`;
}

function valueAfter(argv, index, flag) {
  if (index + 1 >= argv.length) throw new TypeError(`${flag} requires a value`);
  return argv[index + 1];
}

function parseArgs(argv) {
  const args = {
    checkpoint: null,
    sourceExact: null,
    profiles: [],
    json: null,
    minCoverage: DEFAULT_MIN_HELDOUT_COVERAGE,
    minDecisions: DEFAULT_MIN_HELDOUT_DECISIONS,
    tableSizes: [6, 9],
    requirePass: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--checkpoint') args.checkpoint = valueAfter(argv, index++, flag);
    else if (flag === '--source-exact') args.sourceExact = valueAfter(argv, index++, flag);
    else if (flag === '--profile') args.profiles.push(valueAfter(argv, index++, flag));
    else if (flag === '--json') args.json = valueAfter(argv, index++, flag);
    else if (flag === '--min-coverage') args.minCoverage = Number(valueAfter(argv, index++, flag));
    else if (flag === '--min-decisions') args.minDecisions = Number(valueAfter(argv, index++, flag));
    else if (flag === '--table-sizes') {
      args.tableSizes = valueAfter(argv, index++, flag).split(',').map(Number);
    } else if (flag === '--require-pass') args.requirePass = true;
    else throw new TypeError(`Unknown option ${flag}`);
  }
  if (!args.checkpoint || !args.sourceExact || !args.json || args.profiles.length === 0) {
    throw new TypeError('--checkpoint, --source-exact, --profile and --json are required');
  }
  return args;
}

async function readJson(path) {
  const text = await readFile(resolve(path), 'utf8');
  return Object.freeze({
    value: JSON.parse(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const checkpoint = await readJson(args.checkpoint);
  const sourceExact = await readJson(args.sourceExact);
  const profileSources = [];
  for (const path of args.profiles) {
    const source = await readJson(path);
    profileSources.push({ profile: source.value, sha256: source.sha256 });
  }
  const report = evaluateBlueprintHeldoutCoverage({
    checkpoint: checkpoint.value,
    sourceCheckpoint: sourceExact.value,
    profileSources,
    requiredTableSizes: args.tableSizes,
    minCoverage: args.minCoverage,
    minDecisionsPerTable: args.minDecisions,
  });
  const outputPath = resolve(args.json);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`saved=${outputPath}`);
  console.log(`passed=${report.gate.passed}`);
  for (const table of report.gate.requiredTableSizes) {
    const metrics = report.byTable[String(table)];
    console.log(`table=${table} decisions=${metrics?.decisions || 0} coverage=${metrics?.coverage || 0}`);
  }
  if (report.gate.blockers.length) console.log(`blockers=${report.gate.blockers.join(',')}`);
  if (args.requirePass && !report.gate.passed) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
