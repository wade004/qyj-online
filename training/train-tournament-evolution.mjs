#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  buildPromotionCrossoverLineup,
  buildSeatAssignments,
  createLineup,
  runMatch,
} from './eval/league.mjs';
import { createSeededRng, deriveSeed } from './eval/rng.mjs';
import {
  TOURNAMENT_EVOLUTION_FEATURES,
  createTournamentEvolutionPolicy,
} from './tournament-policy/evolution-policy.mjs';
import {
  sampleEvolutionPopulation,
  scoreEvolutionResults,
  scoreEvolutionSeedGroups,
  updateEvolutionDistribution,
} from './tournament-policy/evolution-trainer.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const tableSize = Number(value('--table', 6));
const generations = Number(value('--generations', 10));
const populationSize = Number(value('--population', 12));
const rotations = Number(value('--rotations', 3));
const mirror = !args.includes('--no-mirror');
const seedsPerGeneration = Number(value('--seeds-per-generation', 1));
const initialSigma = Number(value('--sigma', 0.35));
const eliteFraction = Number(value('--elite-fraction', 0.25));
const smoothing = Number(value('--smoothing', 0.55));
const minSigma = Number(value('--min-sigma', 0.04));
const maxSigma = Number(value('--max-sigma', 1.25));
const validationSeeds = Number(value('--validation-seeds', 1));
const validationRotations = Number(value('--validation-rotations', 2));
const seedNamespace = String(value('--seed', 'qyj-v148-tournament-evolution-train'));
const output = value('--output', 'training/checkpoints/qyj-v148-tournament-evolution-6.json');
const pairedCrossover = args.includes('--paired-crossover');
const robustSeedGroups = args.includes('--robust-seed-groups');
const candidateSlots = tableSize - 2;
if (![6, 9].includes(tableSize) || !Number.isSafeInteger(generations) || generations < 1
  || !Number.isSafeInteger(populationSize) || populationSize < 2
  || populationSize % 2 !== 0
  || (!pairedCrossover && (populationSize < candidateSlots
    || populationSize % candidateSlots !== 0))
  || !Number.isSafeInteger(rotations) || rotations < 1 || rotations > tableSize
  || !Number.isSafeInteger(seedsPerGeneration) || seedsPerGeneration < 1
  || !Number.isSafeInteger(validationSeeds) || validationSeeds < 1
  || !Number.isSafeInteger(validationRotations)
  || validationRotations < 1 || validationRotations > tableSize
  || (robustSeedGroups && (!pairedCrossover
    || seedsPerGeneration < 2 || validationSeeds < 2))
  || !(initialSigma > 0) || !(eliteFraction > 0 && eliteFraction <= 0.5)
  || !(smoothing > 0 && smoothing <= 1) || !(minSigma > 0) || !(maxSigma >= minSigma)) {
  throw new TypeError('invalid tournament evolution training options');
}

const namespaceSha256 = createHash('sha256').update(seedNamespace).digest('hex');
const rng = createSeededRng(deriveSeed(seedNamespace, 'population'));
let distributionMean = Array(TOURNAMENT_EVOLUTION_FEATURES.length).fill(0);
let distributionSigma = Array(TOURNAMENT_EVOLUTION_FEATURES.length).fill(initialSigma);
const history = [];
let matchCount = 0;
let decisionCount = 0;
let changeCount = 0;
let bestCalibration = null;

function calibrationLineup() {
  const pool = [
    { strategy: 'online-resolver-evolution-candidate', id: 'calibration-candidate' },
    { strategy: 'qyz', id: 'calibration-qyz' },
    { strategy: 'qyz-tight', id: 'calibration-tight' },
    { strategy: 'qyz-aggressive', id: 'calibration-aggressive' },
    { strategy: 'qyz-loose', id: 'calibration-loose' },
    { strategy: 'calling-station', id: 'calibration-calling' },
    { strategy: 'qyz-bluffer', id: 'calibration-bluffer' },
    { strategy: 'qyz-aggressive', id: 'calibration-aggressive-2' },
    { strategy: 'qyz-tight', id: 'calibration-tight-2' },
  ];
  return createLineup(pool, tableSize);
}

function assignmentsFor(lineup, rotationCount, includeCrossover, mirrorValue = true) {
  const lineups = [lineup];
  if (includeCrossover) {
    const crossed = buildPromotionCrossoverLineup(lineup, {
      candidate: 'online-resolver-evolution-candidate',
      baseline: 'qyz',
    });
    if (!crossed) throw new Error('paired evolution requires one candidate and one qyz baseline');
    lineups.push(crossed);
  }
  return lineups.flatMap((entry) => buildSeatAssignments(entry, {
    rotations: rotationCount,
    mirror: mirrorValue,
  }));
}

function evaluateCalibration(weights, generation) {
  const model = createTournamentEvolutionPolicy(weights, {
    tableSizes: [tableSize],
    training: { generation, calibration: true },
    provenance: { seedNamespaceSha256: namespaceSha256 },
  });
  const matches = [];
  const seedGroups = [];
  const assignments = assignmentsFor(
    calibrationLineup(), validationRotations, pairedCrossover,
  );
  for (let seedIndex = 0; seedIndex < validationSeeds; seedIndex++) {
    const seedMatches = [];
    const seed = deriveSeed(seedNamespace, 'calibration', `seed=${seedIndex + 1}`);
    for (const assignment of assignments) {
      const match = runMatch({
        assignment,
        seed,
        seedGroup: `calibration-${seedIndex + 1}`,
        tableSize,
        skillsEnabled: false,
        strategyModels: new Map([['calibration-candidate', model]]),
      });
      if (match.errorCount !== 0 || (!match.fullSchedule && !match.naturalEarlyFinish)) {
        throw new Error(`evolution calibration requires complete matches (${match.id})`);
      }
      matches.push(match);
      seedMatches.push(match);
      matchCount++;
    }
    seedGroups.push(seedMatches);
  }
  const scoreOptions = {
    candidateId: 'calibration-candidate',
    baselineId: 'calibration-qyz',
    tableSize,
  };
  return robustSeedGroups
    ? scoreEvolutionSeedGroups(seedGroups, scoreOptions)
    : scoreEvolutionResults(matches, scoreOptions);
}

for (let generation = 1; generation <= generations; generation++) {
  const population = sampleEvolutionPopulation(distributionMean, distributionSigma, {
    populationSize,
    rng,
  });
  const evaluations = Array(populationSize);
  if (pairedCrossover) {
    for (let index = 0; index < population.length; index++) {
      const candidateId = `candidate-${index}`;
      const baselineId = `baseline-qyz-${index}`;
      const pool = [
        { strategy: 'online-resolver-evolution-candidate', id: candidateId },
        { strategy: 'qyz', id: baselineId },
        { strategy: 'qyz-tight', id: `baseline-tight-${index}` },
        { strategy: 'qyz-aggressive', id: `baseline-aggressive-${index}` },
        { strategy: 'qyz-loose', id: `baseline-loose-${index}` },
        { strategy: 'calling-station', id: `baseline-calling-${index}` },
        { strategy: 'qyz-bluffer', id: `baseline-bluffer-${index}` },
        { strategy: 'qyz-aggressive', id: `baseline-aggressive-2-${index}` },
        { strategy: 'qyz-tight', id: `baseline-tight-2-${index}` },
      ];
      const lineup = createLineup(pool, tableSize);
      const assignments = assignmentsFor(lineup, rotations, true, mirror);
      const model = createTournamentEvolutionPolicy(population[index], {
        tableSizes: [tableSize],
        training: { generation, provisional: true, pairedCrossover: true },
        provenance: { seedNamespaceSha256: namespaceSha256 },
      });
      const matches = [];
      const seedGroups = [];
      for (let seedIndex = 0; seedIndex < seedsPerGeneration; seedIndex++) {
        const seedMatches = [];
        const seed = deriveSeed(
          seedNamespace, `generation=${generation}`, `seed=${seedIndex + 1}`,
        );
        for (const assignment of assignments) {
          const match = runMatch({
            assignment,
            seed,
            seedGroup: `generation-${generation}-seed-${seedIndex + 1}`,
            tableSize,
            skillsEnabled: false,
            strategyModels: new Map([[candidateId, model]]),
          });
          if (match.errorCount !== 0 || (!match.fullSchedule && !match.naturalEarlyFinish)) {
            throw new Error(`paired evolution requires complete matches (${match.id})`);
          }
          matches.push(match);
          seedMatches.push(match);
          matchCount++;
        }
        seedGroups.push(seedMatches);
      }
      const scoreOptions = { candidateId, baselineId, tableSize };
      const score = robustSeedGroups
        ? scoreEvolutionSeedGroups(seedGroups, scoreOptions)
        : scoreEvolutionResults(matches, scoreOptions);
      evaluations[index] = Object.freeze({ id: candidateId, ...score });
      decisionCount += score.decisions;
      changeCount += score.changes;
    }
  } else for (let start = 0; start < population.length; start += candidateSlots) {
    const group = start / candidateSlots;
    const entries = population.slice(start, start + candidateSlots).map((_, offset) => ({
      strategy: 'online-resolver-evolution-candidate',
      id: `candidate-${start + offset}`,
    }));
    const baselineId = `baseline-qyz-${group}`;
    entries.push({ strategy: 'qyz', id: baselineId });
    entries.push({ strategy: 'qyz-tight', id: `baseline-tight-${group}` });
    const lineup = createLineup(entries, tableSize);
    const assignments = buildSeatAssignments(lineup, { rotations, mirror });
    const models = new Map(population.slice(start, start + candidateSlots).map(
      (weights, offset) => [`candidate-${start + offset}`, createTournamentEvolutionPolicy(
        weights,
        {
          tableSizes: [tableSize],
          training: { generation, provisional: true },
          provenance: { seedNamespaceSha256: namespaceSha256 },
        },
      )],
    ));
    const matches = [];
    for (let seedIndex = 0; seedIndex < seedsPerGeneration; seedIndex++) {
      const seed = deriveSeed(
        seedNamespace, `generation=${generation}`, `seed=${seedIndex + 1}`,
      );
      for (const assignment of assignments) {
        const match = runMatch({
          assignment,
          seed,
          seedGroup: `generation-${generation}-seed-${seedIndex + 1}`,
          tableSize,
          skillsEnabled: false,
          strategyModels: models,
        });
        if (match.errorCount !== 0 || (!match.fullSchedule && !match.naturalEarlyFinish)) {
          throw new Error(`evolution training requires error-free complete matches (${match.id})`);
        }
        matches.push(match);
        matchCount++;
      }
    }
    for (let offset = 0; offset < candidateSlots; offset++) {
      const index = start + offset;
      const score = scoreEvolutionResults(matches, {
        candidateId: `candidate-${index}`,
        baselineId,
        tableSize,
      });
      evaluations[index] = Object.freeze({ id: `candidate-${index}`, ...score });
      decisionCount += score.decisions;
      changeCount += score.changes;
    }
  }
  const update = updateEvolutionDistribution(population, evaluations, {
    eliteFraction,
    minSigma,
    maxSigma,
  });
  distributionMean = distributionMean.map((value, index) => (
    value * (1 - smoothing) + update.targetMean[index] * smoothing
  ));
  distributionSigma = distributionSigma.map((value, index) => Math.max(
    minSigma,
    Math.min(maxSigma, value * (1 - smoothing) + update.targetSigma[index] * smoothing),
  ));
  const calibration = evaluateCalibration(distributionMean, generation);
  if (!bestCalibration || calibration.fitness > bestCalibration.score.fitness) {
    bestCalibration = Object.freeze({
      generation,
      weights: Object.freeze([...distributionMean]),
      score: calibration,
    });
  }
  const best = update.elites[0];
  const average = (field) => evaluations.reduce(
    (sum, evaluation) => sum + Number(evaluation[field]), 0,
  ) / evaluations.length;
  const row = Object.freeze({
    generation,
    bestFitness: best.fitness,
    bestRankAdvantage: best.rankAdvantage,
    bestHpAdvantage: best.hpAdvantage,
    meanFitness: average('fitness'),
    meanRankAdvantage: average('rankAdvantage'),
    meanHpAdvantage: average('hpAdvantage'),
    meanChangeRate: average('changeRate'),
    calibrationFitness: calibration.fitness,
    calibrationRankAdvantage: calibration.rankAdvantage,
    calibrationHpAdvantage: calibration.hpAdvantage,
    calibrationChangeRate: calibration.changeRate,
    sigmaMean: distributionSigma.reduce((sum, item) => sum + item, 0)
      / distributionSigma.length,
  });
  history.push(row);
  console.log(JSON.stringify(row));
}

const artifact = createTournamentEvolutionPolicy(bestCalibration.weights, {
  tableSizes: [tableSize],
  training: {
    generations,
    populationSize,
    rotations,
    mirror,
    seedsPerGeneration,
    validationSeeds,
    validationRotations,
    pairedCrossover,
    robustSeedGroups,
    selectedGeneration: bestCalibration.generation,
    calibration: bestCalibration.score,
    matches: matchCount,
    decisions: decisionCount,
    changes: changeCount,
    changeRate: decisionCount ? changeCount / decisionCount : 0,
    objective: 'paired-complete-tournament-rank-hp-dual-floor',
    opponentPopulation: pairedCrossover
      ? ['qyz', 'qyz-tight', 'qyz-aggressive', 'qyz-loose', 'calling-station']
      : ['qyz', 'qyz-tight', 'concurrent-evolution-candidates'],
    finalSigma: distributionSigma,
    history,
  },
  provenance: {
    trainerVersion: pairedCrossover
      ? robustSeedGroups
        ? 'qyj-v152-robust-seed-group-tournament-evolution-v1'
        : 'qyj-v150-paired-crossover-tournament-evolution-v1'
      : 'qyj-v149-tournament-evolution-calibrated-v1',
    seedNamespaceSha256: namespaceSha256,
    rawTrainingSeedsPersisted: false,
    trainingTableSize: tableSize,
  },
});
const destination = resolve(output);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(`saved=${destination} matches=${matchCount} changeRate=${artifact.training.changeRate}`);
