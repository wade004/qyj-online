#!/usr/bin/env node

import { createHash, createHmac } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import * as Config from '../js/game/config.js';
import {
  buildSeatAssignments,
  createLineup,
  runMatch,
} from './eval/league.mjs';
import { deriveSeed } from './eval/rng.mjs';
import { normalizedFinalRankValue } from './tournament-value/model.js';
import { TOURNAMENT_TRAJECTORY_DATASET_SCHEMA } from './tournament-policy/model.mjs';

function parseArgs(argv) {
  const result = {
    tables: [6, 9], seeds: 2, rotations: 'full', mirror: true,
    seedOffset: 0,
    behavior: 'qyz-family',
    seedNamespace: 'qyj-v118-tournament-trajectories', secret: null,
    output: 'training/datasets/qyj-v118-tournament-trajectories.json',
  };
  const value = (index, flag) => {
    if (index + 1 >= argv.length) throw new TypeError(`${flag} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--tables') result.tables = value(index++, flag).split(',').map(Number);
    else if (flag === '--seeds') result.seeds = Number(value(index++, flag));
    else if (flag === '--seed-offset') result.seedOffset = Number(value(index++, flag));
    else if (flag === '--rotations') {
      const raw = value(index++, flag);
      result.rotations = raw === 'full' ? raw : Number(raw);
    } else if (flag === '--no-mirror') result.mirror = false;
    else if (flag === '--behavior') result.behavior = value(index++, flag);
    else if (flag === '--seed-namespace') result.seedNamespace = value(index++, flag);
    else if (flag === '--cluster-secret') result.secret = value(index++, flag);
    else if (flag === '--output') result.output = value(index++, flag);
    else if (flag === '--help') result.help = true;
    else throw new TypeError(`unknown option ${flag}`);
  }
  if (result.help) return result;
  if (!result.tables.length || result.tables.some(
    (table) => !Config.SUPPORTED_TABLE_SIZES.includes(table),
  )) throw new RangeError('tables must contain supported table sizes');
  if (!['qyz-family', 'qyz-explorer'].includes(result.behavior)) {
    throw new RangeError('behavior must be qyz-family or qyz-explorer');
  }
  if (!Number.isSafeInteger(result.seeds) || result.seeds < 1) {
    throw new RangeError('seeds must be a positive integer');
  }
  if (!Number.isSafeInteger(result.seedOffset) || result.seedOffset < 0) {
    throw new RangeError('seed-offset must be a non-negative integer');
  }
  if (typeof result.secret !== 'string' || result.secret.length < 16) {
    throw new RangeError('cluster-secret must contain at least 16 characters');
  }
  return result;
}

function usage() {
  return 'Usage: node training/collect-tournament-policy-trajectories.mjs '
    + '--tables 6,9 --seeds N --behavior qyz-family|qyz-explorer '
    + '--cluster-secret SECRET --output PATH';
}

function opaque(secret, kind, ...parts) {
  return `${kind}_${createHmac('sha256', secret).update(parts.join('\n')).digest('hex')}`;
}

function lineupKeys(tableSize, behavior) {
  if (behavior === 'qyz-explorer') return Array(tableSize).fill('qyz-v120-explorer');
  const pool = ['qyz', 'qyz-tight', 'qyz-aggressive', 'qyz-loose', 'qyz-bluffer'];
  return Array.from({ length: tableSize }, (_, index) => pool[index % pool.length]);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const rows = [];
  let matches = 0;
  for (const tableSize of options.tables) {
    const assignments = buildSeatAssignments(createLineup(
      lineupKeys(tableSize, options.behavior), tableSize,
    ), {
      rotations: options.rotations,
      mirror: options.mirror,
    });
    for (let seedIndex = 0; seedIndex < options.seeds; seedIndex++) {
      const groupNumber = options.seedOffset + seedIndex + 1;
      const rawGroup = `${options.seedNamespace}|table=${tableSize}|group=${groupNumber}`;
      const sourceGroup = opaque(options.secret, 'tg', rawGroup);
      const dealSeed = deriveSeed(rawGroup, 'deal');
      for (const assignment of assignments) {
        const traces = [];
        const match = runMatch({
          assignment,
          seed: dealSeed,
          seedGroup: rawGroup,
          tableSize,
          skillsEnabled: false,
          onDecisionTrace(trace) { traces.push(trace); },
        });
        if (match.errorCount !== 0 || !match.fullSchedule) {
          const details = (match.errors || []).map((error) => (
            `${error.kind || 'error'}:${error.message || 'unknown'}`
          )).join('; ');
          throw new Error('trajectory collection requires complete error-free matches'
            + ` (table=${tableSize}, group=${groupNumber}, assignment=${assignment.key},`
            + ` fullSchedule=${match.fullSchedule}, errors=${match.errorCount}, details=${details})`);
        }
        const resultByEntry = new Map(match.results.map((result) => [result.entryId, result]));
        const matchId = opaque(options.secret, 'tm', rawGroup, assignment.key);
        const decisionIndexByEntry = new Map();
        traces.forEach((trace, index) => {
          const result = resultByEntry.get(trace.entryId);
          if (!result) throw new Error('decision trace has no terminal result');
          const playerDecisionIndex = (decisionIndexByEntry.get(trace.entryId) || 0) + 1;
          decisionIndexByEntry.set(trace.entryId, playerDecisionIndex);
          rows.push(Object.freeze({
            rowId: opaque(options.secret, 'tr', matchId, String(index)),
            sourceGroup,
            matchId,
            trajectoryId: opaque(options.secret, 'tp', matchId, trace.entryId),
            playerDecisionIndex,
            tableSize,
            behaviorStrategy: trace.strategy,
            informationSetKey: trace.informationSetKey,
            legalActionKeys: [...trace.legalActionKeys],
            actionKey: trace.actionKey,
            actionPropensity: trace.behaviorProbability,
            behaviorPolicy: trace.behaviorPolicy || trace.strategy,
            behaviorEpsilon: trace.behaviorEpsilon,
            behaviorBaselineActionKey: trace.behaviorBaselineActionKey,
            behaviorSupportActionKeys: trace.behaviorSupportActionKeys
              ? [...trace.behaviorSupportActionKeys] : null,
            behaviorExplored: trace.behaviorExplored === true,
            round: trace.round,
            street: trace.street,
            rankValue: normalizedFinalRankValue(result.rank, tableSize),
            hpValue: Math.max(-1, Math.min(1, result.hpDelta / Config.INIT_HP)),
          }));
        });
        matches++;
      }
      console.log(`table=${tableSize} group=${groupNumber}`
        + ` matches=${matches} rows=${rows.length}`);
    }
  }
  rows.sort((left, right) => left.rowId.localeCompare(right.rowId));
  const artifact = {
    schema: TOURNAMENT_TRAJECTORY_DATASET_SCHEMA,
    version: 1,
    secretId: createHash('sha256').update(options.secret).digest('hex'),
    sourceNamespaceSha256: createHash('sha256').update(options.seedNamespace).digest('hex'),
    tables: [...options.tables].sort((a, b) => a - b),
    sourceGroups: new Set(rows.map((row) => row.sourceGroup)).size,
    matches,
    behavior: options.behavior,
    rows,
  };
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(`saved=${output} rows=${rows.length} groups=${artifact.sourceGroups}`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
