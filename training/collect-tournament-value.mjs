#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from 'node:worker_threads';
import {
  buildSeatAssignments,
  createLineup,
  runMatch,
} from './eval/league.mjs';
import { deriveSeed } from './eval/rng.mjs';
import {
  buildTournamentValueDataset,
  tournamentValueSecretId,
} from './tournament-value/dataset.mjs';

const DEFAULT_GROUP_SECRET_ENV = 'QYJ_TOURNAMENT_VALUE_GROUP_SECRET';
const DEFAULT_SEED_GROUPS_PER_TABLE = 720;
const MAX_COLLECTOR_WORKERS = 32;
const WORKER_PROTOCOL = 'qyj-tournament-value-collector-worker-v1';

function defaultWorkerCount() {
  return Math.max(1, Math.min(8, availableParallelism()));
}

function help() {
  console.log(`QYJ public active-state 12-hand tournament-value V2 collector

Usage:
  node training/collect-tournament-value.mjs [options]

Options:
  --tables <6,9>            Native Engine table sizes (default: 6,9)
  --seeds <n>               Independent seed groups per table (default: ${DEFAULT_SEED_GROUPS_PER_TABLE})
  --workers <n>             Parallel deterministic workers (default: ${defaultWorkerCount()}, max: ${MAX_COLLECTOR_WORKERS})
  --seed <text>             Reproducible Engine seed; generated if omitted
  --split-seed <text>       Deterministic split seed (never written to dataset)
  --rotations <full|n>      Seat rotations per seed (default: full)
  --mirror / --no-mirror    Include reflected table order (default: mirror)
  --lineup <a,b,...>        League strategy keys, repeated to fill each table
  --focal-strategy <a,b>    Strategies eligible as focal samples (default: qyz)
  --group-secret <ENV_NAME> Read HMAC secret from an environment variable
                             (default env name: ${DEFAULT_GROUP_SECRET_ENV}; random if absent)
  --validation <0..1>       Validation seed-group fraction (default: 0.15)
  --test <0..1>             Test seed-group fraction (default: 0.15)
  --output <path>           Dataset JSON output path
  --quick                   Three cheap six-seat seed groups for a smoke run
  --help                    Show this help

Never pass the HMAC secret itself on the command line. The dataset contains
only an opaque secret fingerprint and HMAC identifiers. Engine replay seeds,
cards, absolute seats and per-sample strategy identity are never written.
`);
}

function parseInteger(value, flag, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new RangeError(`${flag} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    tables: [6, 9],
    seedCount: DEFAULT_SEED_GROUPS_PER_TABLE,
    workers: defaultWorkerCount(),
    baseSeed: null,
    splitSeed: 'qyj-tournament-value-split-v2',
    rotations: 'full',
    mirror: true,
    lineup: [
      'qyz', 'qyz-tight', 'qyz-aggressive',
      'qyz-loose', 'qyz-bluffer', 'random-legal',
      'calling-station', 'check-fold', 'calling-station',
    ],
    focalStrategies: ['qyz'],
    groupSecretEnv: DEFAULT_GROUP_SECRET_ENV,
    groupSecretEnvRequired: false,
    validationFraction: 0.15,
    testFraction: 0.15,
    allowIncompleteStrata: false,
    output: 'training/datasets/qyj-tournament-value-v2.json',
  };
  const valueAfter = (index, flag) => {
    if (index + 1 >= argv.length) throw new Error(`${flag} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--mirror') options.mirror = true;
    else if (flag === '--no-mirror') options.mirror = false;
    else if (flag === '--quick') {
      options.tables = [6];
      options.seedCount = 3;
      options.rotations = 1;
      options.mirror = false;
      options.lineup = ['qyz', 'random-legal'];
      options.focalStrategies = ['qyz'];
      options.allowIncompleteStrata = true;
    } else if (flag === '--tables') {
      options.tables = valueAfter(index++, flag)
        .split(',').map((value) => parseInteger(value.trim(), flag));
    } else if (flag === '--seeds') {
      options.seedCount = parseInteger(valueAfter(index++, flag), flag);
    } else if (flag === '--workers') {
      options.workers = parseInteger(valueAfter(index++, flag), flag);
    } else if (flag === '--seed') options.baseSeed = valueAfter(index++, flag);
    else if (flag === '--split-seed') options.splitSeed = valueAfter(index++, flag);
    else if (flag === '--rotations') {
      const value = valueAfter(index++, flag);
      options.rotations = value === 'full' ? 'full' : parseInteger(value, flag);
    } else if (flag === '--lineup') {
      options.lineup = valueAfter(index++, flag)
        .split(',').map((value) => value.trim()).filter(Boolean);
    } else if (flag === '--focal-strategy') {
      options.focalStrategies = valueAfter(index++, flag)
        .split(',').map((value) => value.trim()).filter(Boolean);
    } else if (flag === '--group-secret' || flag === '--group-secret-env') {
      const envName = valueAfter(index++, flag);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
        throw new RangeError(`${flag} must name an environment variable`);
      }
      options.groupSecretEnv = envName;
      options.groupSecretEnvRequired = true;
    } else if (flag === '--validation') {
      options.validationFraction = Number(valueAfter(index++, flag));
    } else if (flag === '--test') {
      options.testFraction = Number(valueAfter(index++, flag));
    } else if (flag === '--output') options.output = valueAfter(index++, flag);
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!options.tables.length || options.tables.some((size) => ![6, 9].includes(size))) {
    throw new RangeError('--tables supports only native Engine sizes 6 and 9');
  }
  if (new Set(options.tables).size !== options.tables.length) {
    throw new RangeError('--tables must not contain duplicates');
  }
  if (!options.lineup.length) throw new RangeError('--lineup must not be empty');
  if (options.workers > MAX_COLLECTOR_WORKERS) {
    throw new RangeError(`--workers must be <= ${MAX_COLLECTOR_WORKERS}`);
  }
  if (!options.focalStrategies.length) throw new RangeError('--focal-strategy must not be empty');
  if (!options.focalStrategies.some((strategy) => options.lineup.includes(strategy))) {
    throw new RangeError('at least one focal strategy must occur in --lineup');
  }
  return options;
}

function resolveSecrets(options) {
  const configured = process.env[options.groupSecretEnv];
  if (options.groupSecretEnvRequired && !(configured && configured.length)) {
    throw new RangeError(`group-secret environment variable ${options.groupSecretEnv} is missing`);
  }
  const groupSecret = configured && configured.length
    ? configured
    : randomBytes(32);
  // Validates a configured secret before running hundreds of matches.
  const groupSecretId = tournamentValueSecretId(groupSecret);
  const baseSeed = options.baseSeed ?? randomBytes(32).toString('base64url');
  return { groupSecret, groupSecretId, baseSeed };
}

function buildCollectionTasks(options, baseSeed) {
  const tasks = [];
  // Even different table-size strata must not reuse the same 32-bit Engine
  // deal stream. A rare collision fails before any worker starts or file is
  // written; the caller can supply a different high-entropy --seed.
  const usedDealSeeds = new Map();
  let ordinal = 0;
  for (const tableSize of options.tables) {
    const tableBaseSeed = `${baseSeed}:t${tableSize}`;
    for (let seedIndex = 0; seedIndex < options.seedCount; seedIndex++) {
      const dealSeed = deriveSeed(tableBaseSeed, 'deal', seedIndex);
      const previous = usedDealSeeds.get(dealSeed);
      if (previous != null) {
        throw new Error(
          `Derived Engine seed collision between table ${previous.tableSize} group ${previous.seedIndex + 1} and table ${tableSize} group ${seedIndex + 1}; choose another --seed`,
        );
      }
      usedDealSeeds.set(dealSeed, { tableSize, seedIndex });
      tasks.push(Object.freeze({
        ordinal: ordinal++,
        tableSize,
        seedIndex,
        dealSeed,
        seedGroup: `${tableBaseSeed}:${seedIndex + 1}`,
      }));
    }
  }
  return Object.freeze(tasks);
}

function assignmentCacheKey(tableSize, config) {
  return JSON.stringify([
    tableSize,
    config.rotations,
    config.mirror,
    config.lineup,
  ]);
}

function assignmentsFor(tableSize, config, cache) {
  const key = assignmentCacheKey(tableSize, config);
  let assignments = cache.get(key);
  if (!assignments) {
    assignments = buildSeatAssignments(createLineup(config.lineup, tableSize), {
      rotations: config.rotations,
      mirror: config.mirror,
    });
    cache.set(key, assignments);
  }
  return assignments;
}

/** Collect exactly one statistical seed group; this is the parallelism boundary. */
function collectSeedGroup(task, config, assignmentCache = new Map()) {
  const assignments = assignmentsFor(task.tableSize, config, assignmentCache);
  const samples = [];
  for (const assignment of assignments) {
    runMatch({
      assignment,
      seed: task.dealSeed,
      seedGroup: task.seedGroup,
      tableSize: task.tableSize,
      skillsEnabled: false,
      tournamentValueFocalStrategies: config.focalStrategies,
      tournamentValueIdSecret: config.groupSecret,
      onTournamentValueSample(sample) {
        samples.push(sample);
      },
    });
  }
  return {
    ordinal: task.ordinal,
    tableSize: task.tableSize,
    seedIndex: task.seedIndex,
    matchCount: assignments.length,
    samples,
  };
}

function startCollectorWorker() {
  if (!parentPort || workerData?.protocol !== WORKER_PROTOCOL) {
    throw new Error('Invalid tournament-value collector worker bootstrap');
  }
  const assignmentCache = new Map();
  parentPort.on('message', (task) => {
    try {
      parentPort.postMessage({
        protocol: WORKER_PROTOCOL,
        result: collectSeedGroup(task, workerData.config, assignmentCache),
      });
    } catch (error) {
      parentPort.postMessage({
        protocol: WORKER_PROTOCOL,
        error: {
          name: String(error?.name || 'Error'),
          message: String(error?.message || error),
          stack: typeof error?.stack === 'string' ? error.stack : null,
        },
        ordinal: task?.ordinal,
      });
    }
  });
}

async function collectTasks(tasks, config, requestedWorkers) {
  const workerCount = Math.min(requestedWorkers, tasks.length);
  if (workerCount <= 1) {
    const assignmentCache = new Map();
    return {
      workersUsed: 1,
      results: tasks.map((task) => collectSeedGroup(task, config, assignmentCache)),
    };
  }

  const results = new Array(tasks.length);
  const pool = [];
  let nextTask = 0;
  let completed = 0;
  let settled = false;

  const collected = await new Promise((resolve, reject) => {
    const stopWorkers = () => {
      for (const worker of pool) worker.terminate().catch(() => {});
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      stopWorkers();
      reject(error);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      Promise.all(pool.map((worker) => worker.terminate()))
        .then(() => resolve(results), reject);
    };
    const dispatch = (worker) => {
      if (nextTask < tasks.length) worker.postMessage(tasks[nextTask++]);
    };

    for (let index = 0; index < workerCount; index++) {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { protocol: WORKER_PROTOCOL, config },
      });
      pool.push(worker);
      worker.on('message', (message) => {
        if (settled) return;
        if (message?.protocol !== WORKER_PROTOCOL) {
          fail(new Error('Tournament-value collector worker protocol mismatch'));
          return;
        }
        if (message.error) {
          const error = new Error(
            `Collector worker failed on task ${message.ordinal}: ${message.error.message}`,
          );
          error.name = message.error.name;
          if (message.error.stack) error.stack = message.error.stack;
          fail(error);
          return;
        }
        const result = message.result;
        const ordinal = Number(result?.ordinal);
        if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= tasks.length
          || results[ordinal] != null) {
          fail(new Error('Collector worker returned an invalid or duplicate task ordinal'));
          return;
        }
        results[ordinal] = result;
        completed++;
        if (completed === tasks.length) finish();
        else dispatch(worker);
      });
      worker.once('error', fail);
      worker.once('exit', (code) => {
        if (!settled) {
          fail(new Error(`Tournament-value collector worker exited early with code ${code}`));
        }
      });
      dispatch(worker);
    }
  });
  return { workersUsed: workerCount, results: collected };
}

function validateCollectedSamples(samples, options, matchCounts) {
  const sampleIds = new Set();
  const groupTable = new Map();
  const matchGroup = new Map();
  const groupsByTable = new Map(options.tables.map((tableSize) => [tableSize, new Set()]));
  const matchesByTable = new Map(options.tables.map((tableSize) => [tableSize, new Set()]));
  for (const sample of samples) {
    if (sampleIds.has(sample.sampleId)) {
      throw new Error(`Collector produced duplicate opaque sample id ${sample.sampleId}`);
    }
    sampleIds.add(sample.sampleId);
    const tableSize = sample.state.tableSize;
    const groupId = sample.group.seedGroup;
    const matchId = sample.group.matchId;
    if (!groupsByTable.has(tableSize)) {
      throw new Error(`Collector returned an unexpected table size ${tableSize}`);
    }
    const previousTable = groupTable.get(groupId);
    if (previousTable != null && previousTable !== tableSize) {
      throw new Error('Opaque seed group crossed table-size strata');
    }
    groupTable.set(groupId, tableSize);
    const previousGroup = matchGroup.get(matchId);
    if (previousGroup != null && previousGroup !== groupId) {
      throw new Error('Opaque match id crossed seed-group boundaries');
    }
    matchGroup.set(matchId, groupId);
    groupsByTable.get(tableSize).add(groupId);
    matchesByTable.get(tableSize).add(matchId);
  }
  for (const tableSize of options.tables) {
    const groupCount = groupsByTable.get(tableSize).size;
    const matchCount = matchesByTable.get(tableSize).size;
    if (groupCount !== options.seedCount) {
      throw new Error(
        `Collection incomplete for table ${tableSize}: expected ${options.seedCount} opaque seed groups, got ${groupCount}`,
      );
    }
    if (matchCount !== matchCounts[tableSize]) {
      throw new Error(
        `Collection incomplete for table ${tableSize}: expected ${matchCounts[tableSize]} opaque matches, got ${matchCount}`,
      );
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    help();
    return;
  }
  const { groupSecret, groupSecretId, baseSeed } = resolveSecrets(options);
  const tasks = buildCollectionTasks(options, baseSeed);
  const config = Object.freeze({
    rotations: options.rotations,
    mirror: options.mirror,
    lineup: Object.freeze([...options.lineup]),
    focalStrategies: Object.freeze([...options.focalStrategies]),
    groupSecret,
  });
  const { workersUsed, results } = await collectTasks(tasks, config, options.workers);
  const samples = [];
  const matchCounts = Object.fromEntries(options.tables.map((tableSize) => [tableSize, 0]));
  for (const result of results) {
    matchCounts[result.tableSize] += result.matchCount;
    samples.push(...result.samples);
  }
  validateCollectedSamples(samples, options, matchCounts);
  const dataset = buildTournamentValueDataset(samples, {
    seed: options.splitSeed,
    validationFraction: options.validationFraction,
    testFraction: options.testFraction,
    allowIncompleteStrata: options.allowIncompleteStrata,
  });
  dataset.collection = {
    tables: options.tables,
    seedGroupsPerTable: options.seedCount,
    rotations: options.rotations,
    mirror: options.mirror,
    matchCounts,
    focalStrategies: options.focalStrategies,
    lineup: options.lineup,
    skillsEnabled: false,
    groupSecretId,
    rawReplaySeedIncluded: false,
  };
  const output = path.resolve(options.output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(dataset, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    output,
    schema: dataset.schema,
    ...dataset.summary,
    tables: dataset.config.tables,
    matchCounts,
    groupSecretId,
    workersUsed,
  }, null, 2));
}

if (isMainThread) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
} else {
  startCollectorWorker();
}
