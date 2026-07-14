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
  TOURNAMENT_CATEGORICAL_FACTORS,
  createTournamentCategoricalPolicy,
} from './tournament-policy/categorical-policy.mjs';
import { TOURNAMENT_EVOLUTION_FEATURES } from './tournament-policy/evolution-policy.mjs';
import {
  sampleEvolutionPopulation,
  scoreEvolutionSeedGroups,
  updateEvolutionDistribution,
} from './tournament-policy/evolution-trainer.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const tableSize = Number(value('--table', 6));
const generations = Number(value('--generations', 5));
const populationSize = Number(value('--population', 6));
const rotations = Number(value('--rotations', 1));
const seedsPerGeneration = Number(value('--seeds-per-generation', 3));
const validationSeeds = Number(value('--validation-seeds', 3));
const calibrationElites = Number(value('--calibration-elites', 2));
const selectionSeeds = Number(value('--selection-seeds', 0));
const selectionCandidates = Number(value('--selection-candidates', 5));
const initialSigma = Number(value('--sigma', 0.12));
const eliteFraction = Number(value('--elite-fraction', 0.5));
const smoothing = Number(value('--smoothing', 0.45));
const minSigma = Number(value('--min-sigma', 0.025));
const maxSigma = Number(value('--max-sigma', 0.5));
const uncertaintyZ = Number(value('--uncertainty-z', 0.75));
const anchorPenalty = Number(value('--anchor-penalty', 0.35));
const minAdvantage = Number(value('--min-advantage', 0.05));
const minChangeRate = Number(value('--min-change-rate', 0.01));
const maxChangeRate = Number(value('--max-change-rate', 0.15));
const seedNamespace = String(value('--seed', 'qyj-v154-factorized-categorical-train'));
const output = value('--output', 'training/checkpoints/qyj-v154-tournament-categorical-6.json');
if (![6, 9].includes(tableSize) || !Number.isSafeInteger(generations) || generations < 1
  || !Number.isSafeInteger(populationSize) || populationSize < 4 || populationSize % 2 !== 0
  || !Number.isSafeInteger(rotations) || rotations < 1 || rotations > tableSize
  || !Number.isSafeInteger(seedsPerGeneration) || seedsPerGeneration < 2
  || !Number.isSafeInteger(validationSeeds) || validationSeeds < 2
  || !Number.isSafeInteger(calibrationElites) || calibrationElites < 0
  || calibrationElites > populationSize
  || !Number.isSafeInteger(selectionSeeds) || selectionSeeds < 0
  || (selectionSeeds > 0 && selectionSeeds < 3)
  || !Number.isSafeInteger(selectionCandidates) || selectionCandidates < 1
  || !(initialSigma > 0) || !(eliteFraction > 0 && eliteFraction <= 0.5)
  || !(smoothing > 0 && smoothing <= 1) || !(minSigma > 0) || !(maxSigma >= minSigma)
  || !(uncertaintyZ >= 0 && uncertaintyZ <= 3)
  || !(anchorPenalty >= 0.05 && anchorPenalty <= 3)
  || !(minAdvantage >= 0 && minAdvantage <= 2)
  || !(minChangeRate >= 0 && minChangeRate <= maxChangeRate && maxChangeRate <= 1)) {
  throw new TypeError('invalid tournament categorical training options');
}

const namespaceSha256 = createHash('sha256').update(seedNamespace).digest('hex');
const dimensions = TOURNAMENT_EVOLUTION_FEATURES.length * TOURNAMENT_CATEGORICAL_FACTORS.length;
const rng = createSeededRng(deriveSeed(seedNamespace, 'population'));
let distributionMean = Array(dimensions).fill(0);
let distributionSigma = Array(dimensions).fill(initialSigma);
let matchCount = 0;
let decisionCount = 0;
let changeCount = 0;
let bestCalibration = null;
const calibrationPool = [];
const history = [];

function fixedLineup(candidateId, baselineId) {
  return createLineup([
    { strategy: 'online-resolver-categorical-candidate', id: candidateId },
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

function assignmentsFor(lineup) {
  const crossed = buildPromotionCrossoverLineup(lineup, {
    candidate: 'online-resolver-categorical-candidate', baseline: 'qyz',
  });
  if (!crossed) throw new Error('categorical evolution crossover construction failed');
  return [lineup, crossed].flatMap((entry) => buildSeatAssignments(entry, {
    rotations, mirror: true,
  }));
}

function evaluateWeights(weights, {
  candidateId, baselineId, seedScope, seedCount,
} = {}) {
  const model = createTournamentCategoricalPolicy(weights, {
    tableSizes: [tableSize], anchorPenalty, minAdvantage,
    training: { provisional: true },
    provenance: { seedNamespaceSha256: namespaceSha256 },
  });
  const assignments = assignmentsFor(fixedLineup(candidateId, baselineId));
  const groups = [];
  for (let seedIndex = 0; seedIndex < seedCount; seedIndex++) {
    const seed = deriveSeed(seedNamespace, seedScope, `seed=${seedIndex + 1}`);
    const matches = assignments.map((assignment) => runMatch({
      assignment,
      seed,
      seedGroup: `${seedScope}-seed-${seedIndex + 1}`,
      tableSize,
      skillsEnabled: false,
      strategyModels: new Map([[candidateId, model]]),
    }));
    const invalid = matches.find((match) => match.errorCount !== 0
      || (!match.fullSchedule && !match.naturalEarlyFinish));
    if (invalid) throw new Error(`categorical evolution requires valid matches (${invalid.id})`);
    groups.push(matches);
    matchCount += matches.length;
  }
  return scoreEvolutionSeedGroups(groups, { candidateId, baselineId, tableSize }, { uncertaintyZ });
}

const isMaterial = (score) => score.changeRate >= minChangeRate
  && score.changeRate <= maxChangeRate;
const calibrationBetter = (candidate, current) => {
  if (!current) return true;
  const tier = (entry) => {
    const dualPositive = entry.score.rankAdvantage > 0 && entry.score.hpAdvantage > 0;
    return dualPositive && isMaterial(entry.score) ? 2 : dualPositive ? 1 : 0;
  };
  return tier(candidate) > tier(current)
    || (tier(candidate) === tier(current) && candidate.score.fitness > current.score.fitness);
};

for (let generation = 1; generation <= generations; generation++) {
  const population = sampleEvolutionPopulation(distributionMean, distributionSigma, {
    populationSize, rng,
  });
  const evaluations = [];
  for (let index = 0; index < population.length; index++) {
    const score = evaluateWeights(population[index], {
      candidateId: `candidate-${index}`,
      baselineId: `baseline-${index}`,
      seedScope: `generation-${generation}`,
      seedCount: seedsPerGeneration,
    });
    decisionCount += score.decisions;
    changeCount += score.changes;
    const materialPenalty = score.changeRate < minChangeRate
      ? 0.05 : score.changeRate > maxChangeRate ? score.changeRate - maxChangeRate : 0;
    evaluations.push(Object.freeze({
      id: `candidate-${index}`,
      ...score,
      rawFitness: score.fitness,
      fitness: score.fitness - materialPenalty,
    }));
  }
  const update = updateEvolutionDistribution(population, evaluations, {
    eliteFraction, minSigma, maxSigma,
  });
  distributionMean = distributionMean.map((value, index) => (
    value * (1 - smoothing) + update.targetMean[index] * smoothing
  ));
  distributionSigma = distributionSigma.map((value, index) => Math.max(
    minSigma,
    Math.min(maxSigma, value * (1 - smoothing) + update.targetSigma[index] * smoothing),
  ));
  const calibrationWeights = [
    { source: 'distribution-mean', weights: [...distributionMean] },
    ...update.elites.slice(0, calibrationElites).map((elite) => ({
      source: elite.id,
      weights: [...population[evaluations.findIndex((evaluation) => evaluation.id === elite.id)]],
    })),
  ];
  const calibrationRows = calibrationWeights.map((entry, index) => ({
    generation,
    source: entry.source,
    weights: entry.weights,
    score: evaluateWeights(entry.weights, {
      candidateId: `calibration-candidate-${index}`,
      baselineId: `calibration-qyz-${index}`,
      seedScope: 'fixed-calibration',
      seedCount: validationSeeds,
    }),
  }));
  for (const calibrationRow of calibrationRows) {
    calibrationPool.push(calibrationRow);
    if (calibrationBetter(calibrationRow, bestCalibration)) bestCalibration = calibrationRow;
  }
  const calibration = calibrationRows.reduce(
    (best, row) => (calibrationBetter(row, best) ? row : best), null,
  );
  const mean = (field) => evaluations.reduce(
    (sum, evaluation) => sum + Number(evaluation[field]), 0,
  ) / evaluations.length;
  const row = {
    generation,
    bestFitness: update.elites[0].fitness,
    meanFitness: mean('fitness'),
    meanRankAdvantage: mean('rankAdvantage'),
    meanHpAdvantage: mean('hpAdvantage'),
    meanChangeRate: mean('changeRate'),
    calibrationSource: calibration.source,
    calibrationFitness: calibration.score.fitness,
    calibrationRankAdvantage: calibration.score.rankAdvantage,
    calibrationHpAdvantage: calibration.score.hpAdvantage,
    calibrationChangeRate: calibration.score.changeRate,
    sigmaMean: distributionSigma.reduce((sum, sigma) => sum + sigma, 0)
      / distributionSigma.length,
  };
  history.push(row);
  console.log(JSON.stringify(row));
}

let finalSelection = null;
if (selectionSeeds > 0) {
  const ranked = [...calibrationPool].sort((left, right) => (
    calibrationBetter(left, right) ? -1 : calibrationBetter(right, left) ? 1
      : left.generation - right.generation || left.source.localeCompare(right.source)
  ));
  const seen = new Set();
  const shortlist = ranked.filter((row) => {
    const key = row.weights.map((weight) => Number(weight).toFixed(12)).join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, selectionCandidates);
  const evaluated = shortlist.map((row, index) => ({
    generation: row.generation,
    source: row.source,
    weights: row.weights,
    preliminaryScore: row.score,
    score: evaluateWeights(row.weights, {
      candidateId: `selection-candidate-${index}`,
      baselineId: `selection-qyz-${index}`,
      seedScope: 'final-selection',
      seedCount: selectionSeeds,
    }),
  }));
  bestCalibration = evaluated.reduce(
    (best, row) => (calibrationBetter(row, best) ? row : best), null,
  );
  finalSelection = evaluated.map((row) => ({
    generation: row.generation,
    source: row.source,
    preliminaryScore: row.preliminaryScore,
    score: row.score,
  }));
  console.log(JSON.stringify({
    finalSelection: finalSelection.map((row) => ({
      generation: row.generation,
      source: row.source,
      rankAdvantage: row.score.rankAdvantage,
      hpAdvantage: row.score.hpAdvantage,
      changeRate: row.score.changeRate,
      fitness: row.score.fitness,
    })),
  }));
}

const calibrationPassed = isMaterial(bestCalibration.score)
  && bestCalibration.score.rankAdvantage > 0 && bestCalibration.score.hpAdvantage > 0;
const artifact = createTournamentCategoricalPolicy(bestCalibration.weights, {
  tableSizes: [tableSize], anchorPenalty, minAdvantage,
  training: {
    generations, populationSize, rotations, seedsPerGeneration, validationSeeds,
    calibrationElites,
    selectionSeeds,
    selectionCandidates,
    uncertaintyZ, minChangeRate, maxChangeRate,
    selectedGeneration: bestCalibration.generation,
    selectedSource: bestCalibration.source,
    calibration: bestCalibration.score,
    preliminaryCalibration: bestCalibration.preliminaryScore || null,
    finalSelection,
    calibrationPassed,
    matches: matchCount,
    decisions: decisionCount,
    changes: changeCount,
    changeRate: decisionCount ? changeCount / decisionCount : 0,
    objective: 'paired-complete-tournament-factorized-categorical-rank-hp-dual-floor',
    finalSigma: distributionSigma,
    history,
  },
  provenance: {
    trainerVersion: selectionSeeds > 0
      ? 'qyj-v156-nested-selection-categorical-evolution-v1'
      : 'qyj-v154-factorized-categorical-evolution-v1',
    seedNamespaceSha256: namespaceSha256,
    rawTrainingSeedsPersisted: false,
    trainingTableSize: tableSize,
  },
});
const destination = resolve(output);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(`saved=${destination} matches=${matchCount} calibrationPassed=${calibrationPassed}`);
