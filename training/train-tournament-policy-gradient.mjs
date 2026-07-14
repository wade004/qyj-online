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
import { deriveSeed } from './eval/rng.mjs';
import {
  TOURNAMENT_CATEGORICAL_FACTORS,
  createTournamentCategoricalPolicy,
  evaluateTournamentCategoricalPolicy,
  tournamentCategoricalActionEmbedding,
} from './tournament-policy/categorical-policy.mjs';
import { TOURNAMENT_EVOLUTION_FEATURES } from './tournament-policy/evolution-policy.mjs';
import { scoreEvolutionSeedGroups } from './tournament-policy/evolution-trainer.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const tableSize = Number(value('--table', 6));
const epochs = Number(value('--epochs', 10));
const trainSeeds = Number(value('--train-seeds', 8));
const validationSeeds = Number(value('--validation-seeds', 4));
const selectionSeeds = Number(value('--selection-seeds', 8));
const selectionCandidates = Number(value('--selection-candidates', 3));
const rotations = Number(value('--rotations', 1));
const learningRate = Number(value('--learning-rate', 0.08));
const samplingTemperature = Number(value('--temperature', 0.18));
const anchorPenalty = Number(value('--anchor-penalty', 0.35));
const minAdvantage = Number(value('--min-advantage', 0.05));
const l2 = Number(value('--l2', 0.002));
const gradientClip = Number(value('--gradient-clip', 1));
const criticLearningRate = Number(value('--critic-learning-rate', 0.08));
const criticL2 = Number(value('--critic-l2', 0.005));
const uncertaintyZ = Number(value('--uncertainty-z', 1));
const minChangeRate = Number(value('--min-change-rate', 0.01));
const maxChangeRate = Number(value('--max-change-rate', 0.12));
const seedNamespace = String(value('--seed', 'qyj-v157-policy-gradient-train'));
const output = value('--output', 'training/checkpoints/qyj-v157-policy-gradient-6.json');
if (![6, 9].includes(tableSize) || !Number.isSafeInteger(epochs) || epochs < 1
  || !Number.isSafeInteger(trainSeeds) || trainSeeds < 2
  || !Number.isSafeInteger(validationSeeds) || validationSeeds < 3
  || !Number.isSafeInteger(selectionSeeds) || selectionSeeds < 3
  || !Number.isSafeInteger(selectionCandidates) || selectionCandidates < 1
  || !Number.isSafeInteger(rotations) || rotations < 1 || rotations > tableSize
  || !(learningRate > 0 && learningRate <= 1)
  || !(samplingTemperature >= 0.05 && samplingTemperature <= 2)
  || !(anchorPenalty >= 0.05 && anchorPenalty <= 3)
  || !(minAdvantage >= 0 && minAdvantage <= 2)
  || !(l2 >= 0 && l2 <= 0.1) || !(gradientClip > 0)
  || !(criticLearningRate > 0 && criticLearningRate <= 1)
  || !(criticL2 >= 0 && criticL2 <= 0.1)
  || !(uncertaintyZ >= 0 && uncertaintyZ <= 3)
  || !(minChangeRate >= 0 && minChangeRate <= maxChangeRate && maxChangeRate <= 1)) {
  throw new TypeError('invalid tournament policy-gradient options');
}

const namespaceSha256 = createHash('sha256').update(seedNamespace).digest('hex');
const featureCount = TOURNAMENT_EVOLUTION_FEATURES.length;
const dimensions = featureCount * TOURNAMENT_CATEGORICAL_FACTORS.length;
let weights = Array(dimensions).fill(0);
let criticWeights = Array(featureCount).fill(0);
let matchCount = 0;
let decisionCount = 0;
let sampledChangeCount = 0;
const history = [];
const checkpointPool = [];

function fixedLineup(strategy, candidateId, baselineId) {
  return createLineup([
    { strategy, id: candidateId },
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

function assignmentsFor(strategy, candidateId, baselineId) {
  const lineup = fixedLineup(strategy, candidateId, baselineId);
  const crossed = buildPromotionCrossoverLineup(lineup, {
    candidate: strategy, baseline: 'qyz',
  });
  if (!crossed) throw new Error('policy-gradient crossover construction failed');
  return [lineup, crossed].flatMap((entry) => buildSeatAssignments(entry, {
    rotations, mirror: true,
  }));
}

function policy(weightsValue, training = {}) {
  return createTournamentCategoricalPolicy(weightsValue, {
    tableSizes: [tableSize], anchorPenalty, minAdvantage,
    training,
    provenance: { seedNamespaceSha256: namespaceSha256 },
  });
}

const material = (score) => score.changeRate >= minChangeRate
  && score.changeRate <= maxChangeRate;
const tier = (row) => {
  const dual = row.score.rankAdvantage > 0 && row.score.hpAdvantage > 0;
  return dual && material(row.score) ? 2 : dual ? 1 : 0;
};
const better = (left, right) => !right || tier(left) > tier(right)
  || (tier(left) === tier(right) && left.score.fitness > right.score.fitness);

function evaluateCheckpoint(weightsValue, seedScope, seedCount, index = 0) {
  const candidateId = `evaluation-candidate-${index}`;
  const baselineId = `evaluation-qyz-${index}`;
  const assignments = assignmentsFor(
    'online-resolver-categorical-candidate', candidateId, baselineId,
  );
  const model = policy(weightsValue, { evaluation: true });
  const groups = [];
  for (let seedIndex = 0; seedIndex < seedCount; seedIndex++) {
    const seed = deriveSeed(seedNamespace, seedScope, `seed=${seedIndex + 1}`);
    const matches = assignments.map((assignment) => runMatch({
      assignment,
      seed,
      seedGroup: `${seedScope}-${seedIndex + 1}`,
      tableSize,
      skillsEnabled: false,
      strategyModels: new Map([[candidateId, model]]),
    }));
    const invalid = matches.find((match) => match.errorCount !== 0
      || (!match.fullSchedule && !match.naturalEarlyFinish));
    if (invalid) throw new Error(`checkpoint evaluation failed (${invalid.id})`);
    groups.push(matches);
    matchCount += matches.length;
  }
  return scoreEvolutionSeedGroups(groups, { candidateId, baselineId, tableSize }, { uncertaintyZ });
}

for (let epoch = 1; epoch <= epochs; epoch++) {
  const candidateId = 'explorer';
  const baselineId = 'training-qyz';
  const assignments = assignmentsFor(
    'online-resolver-categorical-explorer', candidateId, baselineId,
  );
  const model = policy(weights, { epoch, samplingTemperature });
  const trajectories = [];
  for (let seedIndex = 0; seedIndex < trainSeeds; seedIndex++) {
    const seed = deriveSeed(seedNamespace, `epoch=${epoch}`, `seed=${seedIndex + 1}`);
    for (const assignment of assignments) {
      const traces = [];
      const match = runMatch({
        assignment,
        seed,
        seedGroup: `epoch-${epoch}-seed-${seedIndex + 1}`,
        tableSize,
        skillsEnabled: false,
        strategyModels: new Map([[candidateId, model]]),
        onDecisionTrace: (trace) => {
          if (trace.entryId === candidateId) traces.push(trace);
        },
      });
      if (match.errorCount !== 0 || (!match.fullSchedule && !match.naturalEarlyFinish)) {
        throw new Error(`policy-gradient training match failed (${match.id})`);
      }
      const candidate = match.results.find((result) => result.entryId === candidateId);
      const baseline = match.results.find((result) => result.entryId === baselineId);
      const rankAdvantage = (Number(baseline.rank) - Number(candidate.rank)) * 2
        / Math.max(1, tableSize - 1);
      const hpAdvantage = Math.tanh((Number(candidate.hp) - Number(baseline.hp)) / 1500);
      trajectories.push({ reward: 0.5 * (rankAdvantage + hpAdvantage), traces });
      matchCount++;
    }
  }
  const rewardMean = trajectories.reduce((sum, row) => sum + row.reward, 0)
    / trajectories.length;
  const rewardVariance = trajectories.reduce(
    (sum, row) => sum + ((row.reward - rewardMean) ** 2), 0,
  ) / Math.max(1, trajectories.length - 1);
  const decisionRows = [];
  for (const trajectory of trajectories) {
    for (const trace of trajectory.traces) {
      const prediction = evaluateTournamentCategoricalPolicy(model, {
        informationSetKey: trace.informationSetKey,
        tableSize,
        baselineActionKey: trace.behaviorBaselineActionKey,
        legalActionKeys: trace.legalActionKeys,
      });
      const candidates = prediction.candidates;
      if (!candidates?.length) continue;
      const valueEstimate = prediction.features.reduce(
        (sum, feature, index) => sum + feature * criticWeights[index], 0,
      );
      decisionRows.push({
        trajectory,
        trace,
        prediction,
        criticError: trajectory.reward - valueEstimate,
      });
    }
  }
  const criticErrorMean = decisionRows.reduce((sum, row) => sum + row.criticError, 0)
    / Math.max(1, decisionRows.length);
  const criticErrorVariance = decisionRows.reduce(
    (sum, row) => sum + ((row.criticError - criticErrorMean) ** 2), 0,
  ) / Math.max(1, decisionRows.length - 1);
  const criticErrorScale = Math.max(0.1, Math.sqrt(criticErrorVariance));
  const gradient = Array(dimensions).fill(0);
  const criticGradient = Array(featureCount).fill(0);
  for (const row of decisionRows) {
      const { trajectory, trace, prediction } = row;
      const candidates = prediction.candidates;
      const traceScale = ((row.criticError - criticErrorMean) / criticErrorScale)
        / Math.max(1, trajectory.traces.length);
      const maxLogit = Math.max(...candidates.map(
        (candidate) => candidate.score / samplingTemperature,
      ));
      const masses = candidates.map((candidate) => Math.exp(
        candidate.score / samplingTemperature - maxLogit,
      ));
      const total = masses.reduce((sum, mass) => sum + mass, 0);
      const expected = Array(TOURNAMENT_CATEGORICAL_FACTORS.length).fill(0);
      candidates.forEach((candidate, candidateIndex) => {
        const embedding = tournamentCategoricalActionEmbedding(candidate.actionKey);
        embedding.forEach((value, factorIndex) => {
          expected[factorIndex] += masses[candidateIndex] / total * value;
        });
      });
      const chosen = tournamentCategoricalActionEmbedding(trace.actionKey);
      if (!chosen) continue;
      for (let factorIndex = 0; factorIndex < chosen.length; factorIndex++) {
        const factorGradient = (chosen[factorIndex] - expected[factorIndex])
          / samplingTemperature;
        for (let featureIndex = 0; featureIndex < featureCount; featureIndex++) {
          gradient[factorIndex * featureCount + featureIndex]
            += traceScale * factorGradient * prediction.features[featureIndex];
        }
      }
      prediction.features.forEach((feature, featureIndex) => {
        criticGradient[featureIndex] += row.criticError * feature;
      });
      decisionCount++;
      if (trace.actionKey !== trace.behaviorBaselineActionKey) sampledChangeCount++;
  }
  const averageCriticGradient = criticGradient.map((value, index) => (
    value / Math.max(1, decisionRows.length) - criticL2 * criticWeights[index]
  ));
  const criticGradientNorm = Math.sqrt(averageCriticGradient.reduce(
    (sum, value) => sum + value * value, 0,
  ));
  const criticClipScale = criticGradientNorm > gradientClip
    ? gradientClip / criticGradientNorm : 1;
  criticWeights = criticWeights.map((weight, index) => Math.max(-4, Math.min(4,
    weight + criticLearningRate * criticClipScale * averageCriticGradient[index],
  )));
  const averageGradient = gradient.map((value) => value / trajectories.length);
  const gradientNorm = Math.sqrt(averageGradient.reduce(
    (sum, value) => sum + value * value, 0,
  ));
  const clipScale = gradientNorm > gradientClip ? gradientClip / gradientNorm : 1;
  weights = weights.map((weight, index) => Math.max(-4, Math.min(4,
    weight * (1 - learningRate * l2)
      + learningRate * clipScale * averageGradient[index],
  )));
  const validation = evaluateCheckpoint(weights, 'fixed-validation', validationSeeds, epoch);
  const checkpoint = { epoch, weights: [...weights], score: validation };
  checkpointPool.push(checkpoint);
  const row = {
    epoch,
    rewardMean,
    rewardStandardDeviation: Math.sqrt(rewardVariance),
    criticRmse: Math.sqrt(decisionRows.reduce(
      (sum, row) => sum + row.criticError * row.criticError, 0,
    ) / Math.max(1, decisionRows.length)),
    criticGradientNorm,
    sampledChangeRate: decisionCount ? sampledChangeCount / decisionCount : 0,
    gradientNorm,
    appliedGradientNorm: gradientNorm * clipScale,
    weightNorm: Math.sqrt(weights.reduce((sum, weight) => sum + weight * weight, 0)),
    validationRankAdvantage: validation.rankAdvantage,
    validationHpAdvantage: validation.hpAdvantage,
    validationChangeRate: validation.changeRate,
    validationFitness: validation.fitness,
  };
  history.push(row);
  console.log(JSON.stringify(row));
}

const ranked = [...checkpointPool].sort((left, right) => (
  better(left, right) ? -1 : better(right, left) ? 1 : left.epoch - right.epoch
));
const shortlist = ranked.slice(0, selectionCandidates);
const finalSelection = shortlist.map((checkpoint, index) => ({
  epoch: checkpoint.epoch,
  preliminaryScore: checkpoint.score,
  weights: checkpoint.weights,
  score: evaluateCheckpoint(
    checkpoint.weights, 'final-selection', selectionSeeds, index,
  ),
}));
const selected = finalSelection.reduce((best, row) => (better(row, best) ? row : best), null);
const calibrationPassed = tier(selected) === 2;
const artifact = policy(selected.weights, {
  estimator: 'paired-tournament-reinforce-with-nested-checkpoint-selection',
  epochs,
  trainSeeds,
  validationSeeds,
  selectionSeeds,
  selectionCandidates,
  rotations,
  learningRate,
  samplingTemperature,
  l2,
  gradientClip,
  criticLearningRate,
  criticL2,
  uncertaintyZ,
  minChangeRate,
  maxChangeRate,
  selectedEpoch: selected.epoch,
  preliminaryCalibration: selected.preliminaryScore,
  calibration: selected.score,
  calibrationPassed,
  matches: matchCount,
  decisions: decisionCount,
  sampledChanges: sampledChangeCount,
  history,
  finalCriticWeights: criticWeights,
  finalSelection: finalSelection.map((row) => ({
    epoch: row.epoch,
    preliminaryScore: row.preliminaryScore,
    score: row.score,
  })),
});
artifact.provenance.trainerVersion = 'qyj-v158-tournament-actor-critic-v1';
const destination = resolve(output);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  finalSelection: artifact.training.finalSelection.map((row) => ({
    epoch: row.epoch,
    rankAdvantage: row.score.rankAdvantage,
    hpAdvantage: row.score.hpAdvantage,
    changeRate: row.score.changeRate,
    fitness: row.score.fitness,
  })),
}));
console.log(`saved=${destination} matches=${matchCount} calibrationPassed=${calibrationPassed}`);
