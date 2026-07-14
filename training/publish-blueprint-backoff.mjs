#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

import { compileBlueprintCheckpoint } from '../js/game/blueprint-policy.js';
import {
  addBlueprintBackoffInfosets,
  summarizeBlueprintCoverage,
} from './blueprint/curriculum.js';
import { buildBlueprintReachSupport } from './blueprint/coverage.js';

function usage() {
  return `Publish conservative hierarchical backoff nodes from exact blueprint roots

Usage:
  node training/publish-blueprint-backoff.mjs --input PATH --output PATH [options]

Options:
  --input PATH              Exact-root checkpoint (required)
  --output PATH             Expanded runtime checkpoint (required)
  --min-exact-visits N      Exact publication support floor (default: 50)
  --min-backoff-visits N    Backoff support floor (default: 200)
  --min-backoff-roots N     Distinct exact roots per backoff node (default: 2)
  --min-population-roots N  Distinct exact roots per population node (default: 3)
  --reach-profile PATH      Reach evidence profile; repeatable
  --min-reach-decisions N   Reach decisions per backoff node (default: 6 with profiles, 0 without)
  --min-reach-groups N      Independent opaque groups per backoff node (default: 2 for eligible V2 profiles)
  --help                    Show this message

Action-value moments are merged with Welford's parallel formula. Runtime still
requires a positive empirical advantage lower bound before any node can act.
Formal publication should always supply independent reach profiles; artifacts
without them remain diagnostic and fail the held-out coverage gate.`;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError(`${flag} must be a positive safe integer`);
  }
  return parsed;
}

function nonNegativeInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`${flag} must be a non-negative safe integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const args = {
    input: null,
    output: null,
    minExactVisits: 50,
    minBackoffVisits: 200,
    minBackoffRoots: 2,
    minPopulationRoots: 3,
    minReachDecisions: null,
    minReachGroups: null,
    reachProfiles: [],
  };
  const valueAfter = (index, flag) => {
    if (index + 1 >= argv.length) throw new TypeError(`${flag} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--input') args.input = valueAfter(index++, flag);
    else if (flag === '--output') args.output = valueAfter(index++, flag);
    else if (flag === '--min-exact-visits') {
      args.minExactVisits = positiveInteger(valueAfter(index++, flag), flag);
    } else if (flag === '--min-backoff-visits') {
      args.minBackoffVisits = positiveInteger(valueAfter(index++, flag), flag);
    } else if (flag === '--min-backoff-roots') {
      args.minBackoffRoots = positiveInteger(valueAfter(index++, flag), flag);
    } else if (flag === '--min-population-roots') {
      args.minPopulationRoots = positiveInteger(valueAfter(index++, flag), flag);
    } else if (flag === '--reach-profile') {
      args.reachProfiles.push(valueAfter(index++, flag));
    } else if (flag === '--min-reach-decisions') {
      args.minReachDecisions = nonNegativeInteger(valueAfter(index++, flag), flag);
    } else if (flag === '--min-reach-groups') {
      args.minReachGroups = nonNegativeInteger(valueAfter(index++, flag), flag);
    } else throw new TypeError(`Unknown option ${flag}`);
  }
  if (!args.input || !args.output) throw new TypeError('--input and --output are required');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const inputPath = resolve(args.input);
  const outputPath = resolve(args.output);
  if (inputPath === outputPath) {
    throw new RangeError('--output must differ from --input');
  }
  const checkpoint = JSON.parse(await readFile(inputPath, 'utf8'));
  // Validate the exact artifact before deriving any publication-only nodes.
  compileBlueprintCheckpoint(checkpoint);
  const exactNodeCount = Object.keys(checkpoint.infosets || {})
    .filter((key) => !key.includes('|bk=')).length;
  if (exactNodeCount === 0) {
    throw new RangeError('--input must contain at least one exact infoset root');
  }
  const profileSources = [];
  for (const profilePath of args.reachProfiles) {
    const text = await readFile(resolve(profilePath), 'utf8');
    profileSources.push({
      profile: JSON.parse(text),
      sha256: createHash('sha256').update(text).digest('hex'),
    });
  }
  const reachSupport = profileSources.length
    ? buildBlueprintReachSupport(profileSources) : null;
  const minReachDecisions = args.minReachDecisions
    ?? (profileSources.length ? 6 : 0);
  const minReachGroups = args.minReachGroups
    ?? (reachSupport?.promotionEligible ? 2 : 0);
  addBlueprintBackoffInfosets(checkpoint, {
    minExactVisits: args.minExactVisits,
    minBackoffVisits: args.minBackoffVisits,
    minBackoffRoots: args.minBackoffRoots,
    minPopulationRoots: args.minPopulationRoots,
    minReachDecisions,
    minReachGroups,
    reachSupport,
  });
  checkpoint.metadata.publication = {
    ...checkpoint.metadata.publication,
    exactOnly: false,
    backoffPublished: true,
    derivation: profileSources.length
      ? 'welford-merged-distinct-exact-roots-with-reach-evidence'
      : 'welford-merged-distinct-exact-roots-diagnostic-no-reach-evidence',
  };
  checkpoint.metadata.coverage = summarizeBlueprintCoverage(checkpoint);
  compileBlueprintCheckpoint(checkpoint);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
  console.log(`saved=${outputPath}`);
  console.log(JSON.stringify(checkpoint.metadata.coverage));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
