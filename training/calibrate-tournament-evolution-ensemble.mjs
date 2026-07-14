#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import * as Config from '../js/game/config.js';
import {
  buildPromotionCrossoverLineup,
  buildSeatAssignments,
  createLineup,
  runMatch,
} from './eval/league.mjs';
import { deriveSeed } from './eval/rng.mjs';
import {
  createTournamentEvolutionPolicy,
  validateTournamentEvolutionPolicy,
} from './tournament-policy/evolution-policy.mjs';
import { scoreEvolutionResults } from './tournament-policy/evolution-trainer.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const inputPaths = String(value('--inputs', '')).split(',').map((item) => item.trim()).filter(Boolean);
const output = value('--output');
const tableSize = Number(value('--table', 6));
const seeds = Number(value('--seeds', 3));
const rotations = Number(value('--rotations', 2));
const minChangeRate = Number(value('--min-change-rate', 0.01));
const maxChangeRate = Number(value('--max-change-rate', 0.12));
const seedNamespace = String(value('--seed', 'qyj-v151-evolution-ensemble-calibration'));
if (inputPaths.length !== 2 || !output || ![6, 9].includes(tableSize)
  || !Number.isSafeInteger(seeds) || seeds < 2
  || !Number.isSafeInteger(rotations) || rotations < 1 || rotations > tableSize
  || !(minChangeRate >= 0 && minChangeRate <= maxChangeRate && maxChangeRate <= 1)) {
  throw new TypeError('ensemble calibration requires two inputs, output and valid table options');
}

const texts = await Promise.all(inputPaths.map((path) => readFile(resolve(path), 'utf8')));
const models = texts.map((text) => validateTournamentEvolutionPolicy(JSON.parse(text)));
if (models.some((model) => !model.tableSizes.includes(tableSize))) {
  throw new RangeError('all evolution inputs must support the calibration table');
}
const inputSha256 = texts.map((text) => createHash('sha256').update(text).digest('hex'));
const namespaceSha256 = createHash('sha256').update(seedNamespace).digest('hex');
const combine = (leftWeight, rightWeight, blend, scale) => leftWeight.map(
  (value, index) => scale * (Number(value) * (1 - blend) + Number(rightWeight[index]) * blend),
);
const rawSpecs = [
  ...[0.25, 0.5, 0.75, 1].map((scale) => ({ blend: 0, scale })),
  ...[0.1, 0.2, 0.3, 0.4, 0.5].map((scale) => ({ blend: 1, scale })),
  ...[0.25, 0.5, 0.75].flatMap((blend) => [0.25, 0.5].map((scale) => ({ blend, scale }))),
];
const seen = new Set();
const candidates = rawSpecs.flatMap((spec) => {
  const weights = combine(models[0].weights, models[1].weights, spec.blend, spec.scale);
  const key = weights.map((item) => item.toFixed(10)).join(',');
  if (seen.has(key)) return [];
  seen.add(key);
  return [{ ...spec, weights }];
});

function fixedLineup(candidateId, baselineId) {
  return createLineup([
    { strategy: 'online-resolver-evolution-candidate', id: candidateId },
    { strategy: 'qyz', id: baselineId },
    { strategy: 'qyz-tight', id: `${baselineId}-tight` },
    { strategy: 'qyz-aggressive', id: `${baselineId}-aggressive` },
    { strategy: 'qyz-loose', id: `${baselineId}-loose` },
    { strategy: 'calling-station', id: `${baselineId}-calling` },
    { strategy: 'qyz-bluffer', id: `${baselineId}-bluffer` },
    { strategy: 'qyz-aggressive', id: `${baselineId}-aggressive-2` },
    { strategy: 'qyz-tight', id: `${baselineId}-tight-2` },
  ], tableSize);
}

const T95 = [Infinity, Infinity, 12.706, 4.303, 3.182, 2.776, 2.571,
  2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145];
function stats(values) {
  const mean = values.reduce((sum, item) => sum + item, 0) / values.length;
  const variance = values.reduce((sum, item) => sum + ((item - mean) ** 2), 0)
    / Math.max(1, values.length - 1);
  const se = Math.sqrt(variance / values.length);
  const critical = T95[Math.min(T95.length - 1, values.length)] || 1.96;
  return { mean, lower95: values.length > 1 ? mean - critical * se : null, se };
}

const audit = [];
for (let index = 0; index < candidates.length; index++) {
  const candidateId = `ensemble-candidate-${index}`;
  const baselineId = `ensemble-qyz-${index}`;
  const lineup = fixedLineup(candidateId, baselineId);
  const crossed = buildPromotionCrossoverLineup(lineup, {
    candidate: 'online-resolver-evolution-candidate', baseline: 'qyz',
  });
  if (!crossed) throw new Error('ensemble calibration crossover construction failed');
  const assignments = [lineup, crossed].flatMap((entry) => buildSeatAssignments(entry, {
    rotations, mirror: true,
  }));
  const model = createTournamentEvolutionPolicy(candidates[index].weights, {
    tableSizes: [tableSize],
    training: { provisionalCalibration: true },
    provenance: { seedNamespaceSha256: namespaceSha256 },
  });
  const rankBySeed = [];
  const hpBySeed = [];
  let decisions = 0;
  let changes = 0;
  let matches = 0;
  for (let seedIndex = 0; seedIndex < seeds; seedIndex++) {
    const seedMatches = [];
    const seed = deriveSeed(seedNamespace, `seed=${seedIndex + 1}`);
    for (const assignment of assignments) {
      const match = runMatch({
        assignment,
        seed,
        seedGroup: `calibration-${seedIndex + 1}`,
        tableSize,
        skillsEnabled: false,
        strategyModels: new Map([[candidateId, model]]),
      });
      if (match.errorCount !== 0 || (!match.fullSchedule && !match.naturalEarlyFinish)) {
        throw new Error(`ensemble calibration requires complete/natural matches (${match.id})`);
      }
      seedMatches.push(match);
      matches++;
    }
    const score = scoreEvolutionResults(seedMatches, { candidateId, baselineId, tableSize });
    rankBySeed.push(score.rankAdvantage);
    decisions += score.decisions;
    changes += score.changes;
    const hpDeltas = seedMatches.map((match) => {
      const candidate = match.results.find((result) => result.entryId === candidateId);
      const baseline = match.results.find((result) => result.entryId === baselineId);
      return Number(candidate.hp) - Number(baseline.hp);
    });
    hpBySeed.push(hpDeltas.reduce((sum, item) => sum + item, 0) / hpDeltas.length);
  }
  const rank = stats(rankBySeed);
  const hp = stats(hpBySeed);
  const changeRate = decisions ? changes / decisions : 0;
  const safetyLowerBound = Math.min(rank.lower95, hp.lower95 / Config.INIT_HP);
  const row = {
    id: `blend-${candidates[index].blend}-scale-${candidates[index].scale}`,
    blend: candidates[index].blend,
    scale: candidates[index].scale,
    weights: candidates[index].weights,
    rank,
    hp,
    decisions,
    changes,
    changeRate,
    matches,
    material: changeRate >= minChangeRate && changeRate <= maxChangeRate,
    dualMeanPositive: rank.mean > 0 && hp.mean > 0,
    safetyLowerBound,
  };
  audit.push(row);
  console.log(JSON.stringify({ ...row, weights: undefined }));
}
audit.sort((left, right) => Number(right.material && right.dualMeanPositive)
  - Number(left.material && left.dualMeanPositive)
  || right.safetyLowerBound - left.safetyLowerBound
  || Math.min(right.rank.mean, right.hp.mean / Config.INIT_HP)
    - Math.min(left.rank.mean, left.hp.mean / Config.INIT_HP)
  || left.id.localeCompare(right.id));
const selected = audit[0];
const artifact = createTournamentEvolutionPolicy(selected.weights, {
  tableSizes: [tableSize],
  training: {
    estimator: 'multi-seed-paired-crossover-evolution-ensemble-shrinkage',
    seeds,
    rotations,
    matches: selected.matches,
    minChangeRate,
    maxChangeRate,
    selected: { ...selected, weights: undefined },
    calibrationPassed: selected.material && selected.dualMeanPositive,
    audit: audit.map((row) => ({ ...row, weights: undefined })),
  },
  provenance: {
    trainerVersion: 'qyj-v151-multi-seed-evolution-ensemble-v1',
    seedNamespaceSha256: namespaceSha256,
    rawTrainingSeedsPersisted: false,
    inputSha256,
  },
});
const destination = resolve(output);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(`saved=${destination} selected=${selected.id}`
  + ` calibrationPassed=${artifact.training.calibrationPassed}`);
