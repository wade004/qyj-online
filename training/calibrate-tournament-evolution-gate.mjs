#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

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
import { scoreEvolutionSeedGroups } from './tournament-policy/evolution-trainer.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const input = value('--input');
const output = value('--output');
const tableSize = Number(value('--table', 6));
const seeds = Number(value('--seeds', 4));
const rotations = Number(value('--rotations', 1));
const minChangeRate = Number(value('--min-change-rate', 0.01));
const maxChangeRate = Number(value('--max-change-rate', 0.12));
const uncertaintyZ = Number(value('--uncertainty-z', 1));
const seedNamespace = String(value('--seed', 'qyj-v153-evolution-gate-calibration'));
if (!input || !output || ![6, 9].includes(tableSize)
  || !Number.isSafeInteger(seeds) || seeds < 3
  || !Number.isSafeInteger(rotations) || rotations < 1 || rotations > tableSize
  || !(minChangeRate >= 0 && minChangeRate <= maxChangeRate && maxChangeRate <= 1)
  || !(uncertaintyZ >= 0 && uncertaintyZ <= 3)) {
  throw new TypeError('gate calibration requires input, output and valid table options');
}

const inputText = await readFile(resolve(input), 'utf8');
const source = validateTournamentEvolutionPolicy(JSON.parse(inputText));
if (!source.tableSizes.includes(tableSize)) {
  throw new RangeError('evolution input does not support the calibration table');
}
const inputSha256 = createHash('sha256').update(inputText).digest('hex');
const namespaceSha256 = createHash('sha256').update(seedNamespace).digest('hex');

// Pre-registered grid: scale controls global capacity; the dead zone prevents
// low-margin contextual scores from changing an otherwise legal QYZ action.
const candidates = [0.4, 0.6, 0.8, 1].flatMap((scale) => (
  [0.3, 0.45, 0.6, 0.75].map((interventionThreshold) => ({
    id: `scale-${scale}-threshold-${interventionThreshold}`,
    scale,
    interventionThreshold,
    weights: source.weights.map((weight) => Number(weight) * scale),
  }))
));

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

const audit = [];
for (let index = 0; index < candidates.length; index++) {
  const spec = candidates[index];
  const candidateId = `gate-candidate-${index}`;
  const baselineId = `gate-qyz-${index}`;
  const lineup = fixedLineup(candidateId, baselineId);
  const crossed = buildPromotionCrossoverLineup(lineup, {
    candidate: 'online-resolver-evolution-candidate', baseline: 'qyz',
  });
  if (!crossed) throw new Error('gate calibration crossover construction failed');
  const assignments = [lineup, crossed].flatMap((entry) => buildSeatAssignments(entry, {
    rotations, mirror: true,
  }));
  const model = createTournamentEvolutionPolicy(spec.weights, {
    tableSizes: [tableSize],
    maxShift: source.maxShift,
    interventionThreshold: spec.interventionThreshold,
    extremeShiftThreshold: source.extremeShiftThreshold,
    training: { provisionalGateCalibration: true },
    provenance: { seedNamespaceSha256: namespaceSha256 },
  });
  const matchGroups = [];
  for (let seedIndex = 0; seedIndex < seeds; seedIndex++) {
    const seed = deriveSeed(seedNamespace, `seed=${seedIndex + 1}`);
    const matches = assignments.map((assignment) => runMatch({
      assignment,
      seed,
      seedGroup: `gate-calibration-${seedIndex + 1}`,
      tableSize,
      skillsEnabled: false,
      strategyModels: new Map([[candidateId, model]]),
    }));
    const invalid = matches.find((match) => match.errorCount !== 0
      || (!match.fullSchedule && !match.naturalEarlyFinish));
    if (invalid) throw new Error(`gate calibration requires valid matches (${invalid.id})`);
    matchGroups.push(matches);
  }
  const score = scoreEvolutionSeedGroups(matchGroups, {
    candidateId, baselineId, tableSize,
  }, { uncertaintyZ });
  const row = {
    id: spec.id,
    scale: spec.scale,
    interventionThreshold: spec.interventionThreshold,
    rankAdvantage: score.rankAdvantage,
    hpAdvantage: score.hpAdvantage,
    rankStandardError: score.rankStandardError,
    hpStandardError: score.hpStandardError,
    robustRank: score.robustRank,
    robustHp: score.robustHp,
    fitness: score.fitness,
    seeds: score.seedGroups,
    matches: score.matches,
    decisions: score.decisions,
    changes: score.changes,
    changeRate: score.changeRate,
    material: score.changeRate >= minChangeRate && score.changeRate <= maxChangeRate,
    dualMeanPositive: score.rankAdvantage > 0 && score.hpAdvantage > 0,
  };
  audit.push(row);
  console.log(JSON.stringify(row));
}

audit.sort((left, right) => Number(right.material && right.dualMeanPositive)
  - Number(left.material && left.dualMeanPositive)
  || right.fitness - left.fitness
  || Math.min(right.rankAdvantage, right.hpAdvantage)
    - Math.min(left.rankAdvantage, left.hpAdvantage)
  || left.changeRate - right.changeRate
  || left.id.localeCompare(right.id));
const selected = audit[0];
const selectedSpec = candidates.find((candidate) => candidate.id === selected.id);
const calibrationPassed = selected.material && selected.dualMeanPositive;
const artifact = createTournamentEvolutionPolicy(selectedSpec.weights, {
  tableSizes: [tableSize],
  maxShift: source.maxShift,
  interventionThreshold: selected.interventionThreshold,
  extremeShiftThreshold: source.extremeShiftThreshold,
  training: {
    estimator: 'multi-seed-paired-crossover-evolution-dead-zone-calibration',
    seeds,
    rotations,
    uncertaintyZ,
    minChangeRate,
    maxChangeRate,
    calibrationPassed,
    selected,
    audit,
  },
  provenance: {
    trainerVersion: 'qyj-v153-evolution-dead-zone-calibration-v1',
    seedNamespaceSha256: namespaceSha256,
    rawTrainingSeedsPersisted: false,
    inputSha256,
  },
});
const destination = resolve(output);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(`saved=${destination} selected=${selected.id} calibrationPassed=${calibrationPassed}`);
