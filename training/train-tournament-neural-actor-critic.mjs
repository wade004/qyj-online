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
import { createSeededRng, deriveSeed } from './eval/rng.mjs';
import {
  TOURNAMENT_NEURAL_FEATURES,
  createTournamentNeuralPolicy,
  evaluateTournamentNeuralPolicy,
} from './tournament-policy/neural-policy.mjs';
import {
  TOURNAMENT_CATEGORICAL_FACTORS,
  tournamentCategoricalActionEmbedding,
} from './tournament-policy/categorical-policy.mjs';
import { scoreEvolutionSeedGroups } from './tournament-policy/evolution-trainer.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const tableSize = Number(value('--table', 6));
const hiddenSize = Number(value('--hidden', 8));
const epochs = Number(value('--epochs', 10));
const trainSeeds = Number(value('--train-seeds', 8));
const validationSeeds = Number(value('--validation-seeds', 6));
const selectionSeeds = Number(value('--selection-seeds', 8));
const selectionCandidates = Number(value('--selection-candidates', 3));
const rotations = Number(value('--rotations', 1));
const actorLearningRate = Number(value('--actor-learning-rate', 0.08));
const criticLearningRate = Number(value('--critic-learning-rate', 0.08));
const samplingTemperature = Number(value('--temperature', 0.18));
const anchorPenalty = Number(value('--anchor-penalty', 0.35));
const minAdvantage = Number(value('--min-advantage', 0.05));
const actorL2 = Number(value('--actor-l2', 0.002));
const criticL2 = Number(value('--critic-l2', 0.005));
const gradientClip = Number(value('--gradient-clip', 1));
const uncertaintyZ = Number(value('--uncertainty-z', 1));
const minChangeRate = Number(value('--min-change-rate', 0.01));
const maxChangeRate = Number(value('--max-change-rate', 0.12));
const seedNamespace = String(value('--seed', 'qyj-v159-neural-actor-critic-train'));
const output = value('--output', 'training/checkpoints/qyj-v159-neural-actor-critic-6.json');
const stateOutput = value('--state-output', `${output}.state.json`);
const resumePath = value('--resume');
const stopAfterEpoch = Number(value('--stop-after-epoch', epochs));
if (![6, 9].includes(tableSize) || !Number.isSafeInteger(hiddenSize)
  || hiddenSize < 2 || hiddenSize > 64
  || !Number.isSafeInteger(epochs) || epochs < 1
  || !Number.isSafeInteger(stopAfterEpoch) || stopAfterEpoch < 1 || stopAfterEpoch > epochs
  || !Number.isSafeInteger(trainSeeds) || trainSeeds < 2
  || !Number.isSafeInteger(validationSeeds) || validationSeeds < 3
  || !Number.isSafeInteger(selectionSeeds) || selectionSeeds < 3
  || !Number.isSafeInteger(selectionCandidates) || selectionCandidates < 1
  || !Number.isSafeInteger(rotations) || rotations < 1 || rotations > tableSize
  || !(actorLearningRate > 0 && actorLearningRate <= 1)
  || !(criticLearningRate > 0 && criticLearningRate <= 1)
  || !(samplingTemperature >= 0.05 && samplingTemperature <= 2)
  || !(anchorPenalty >= 0.05 && anchorPenalty <= 3)
  || !(minAdvantage >= 0 && minAdvantage <= 2)
  || !(actorL2 >= 0 && actorL2 <= 0.1)
  || !(criticL2 >= 0 && criticL2 <= 0.1)
  || !(gradientClip > 0) || !(uncertaintyZ >= 0 && uncertaintyZ <= 3)
  || !(minChangeRate >= 0 && minChangeRate <= maxChangeRate && maxChangeRate <= 1)) {
  throw new TypeError('invalid tournament neural actor-critic options');
}

const inputSize = TOURNAMENT_NEURAL_FEATURES.length;
const factorCount = TOURNAMENT_CATEGORICAL_FACTORS.length;
const namespaceSha256 = createHash('sha256').update(seedNamespace).digest('hex');
const config = {
  tableSize, hiddenSize, epochs, trainSeeds, validationSeeds, selectionSeeds,
  selectionCandidates, rotations, actorLearningRate, criticLearningRate,
  samplingTemperature, anchorPenalty, minAdvantage, actorL2, criticL2,
  gradientClip, uncertaintyZ, minChangeRate, maxChangeRate,
};
const configSha256 = createHash('sha256').update(JSON.stringify(config)).digest('hex');
const rng = createSeededRng(deriveSeed(seedNamespace, 'initial-parameters'));
const randomWeights = (length, scale) => Array.from(
  { length }, () => (rng() * 2 - 1) * scale,
);
const newActor = () => ({
  inputWeights: randomWeights(hiddenSize * inputSize, Math.sqrt(3 / inputSize) * 0.35),
  hiddenBias: Array(hiddenSize).fill(0),
  outputWeights: randomWeights(factorCount * hiddenSize, Math.sqrt(3 / hiddenSize) * 0.2),
  outputBias: Array(factorCount).fill(0),
});
const newCritic = () => ({
  inputWeights: randomWeights(hiddenSize * inputSize, Math.sqrt(3 / inputSize) * 0.25),
  hiddenBias: Array(hiddenSize).fill(0),
  outputWeights: randomWeights(hiddenSize, Math.sqrt(3 / hiddenSize) * 0.15),
  outputBias: 0,
});
const cloneNetwork = (network) => JSON.parse(JSON.stringify(network));
let actor = newActor();
let critic = newCritic();
let startEpoch = 1;
let matchCount = 0;
let decisionCount = 0;
let sampledChangeCount = 0;
let history = [];
let checkpointPool = [];
let completedEpoch = 0;

if (resumePath) {
  const state = JSON.parse(await readFile(resolve(resumePath), 'utf8'));
  if (state?.schema !== 'qyj-neural-actor-critic-state-v1'
    || state.namespaceSha256 !== namespaceSha256
    || state.configSha256 !== configSha256
    || !Number.isSafeInteger(state.completedEpoch) || state.completedEpoch < 0
    || state.completedEpoch >= epochs) {
    throw new TypeError('resume state does not match the requested training run');
  }
  actor = cloneNetwork(state.actor);
  critic = cloneNetwork(state.critic);
  startEpoch = state.completedEpoch + 1;
  matchCount = Number(state.matchCount) || 0;
  decisionCount = Number(state.decisionCount) || 0;
  sampledChangeCount = Number(state.sampledChangeCount) || 0;
  history = [...state.history];
  checkpointPool = state.checkpointPool.map((row) => ({
    ...row,
    actor: cloneNetwork(row.actor),
    critic: cloneNetwork(row.critic),
  }));
  completedEpoch = state.completedEpoch;
}

function policy(actorValue, training = {}) {
  return createTournamentNeuralPolicy(actorValue, {
    tableSizes: [tableSize], hiddenSize, anchorPenalty, minAdvantage,
    training,
    provenance: { seedNamespaceSha256: namespaceSha256 },
  });
}

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
  if (!crossed) throw new Error('neural actor-critic crossover construction failed');
  return [lineup, crossed].flatMap((entry) => buildSeatAssignments(entry, {
    rotations, mirror: true,
  }));
}

function forwardCritic(network, inputs) {
  const hidden = Array.from({ length: hiddenSize }, (_, hiddenIndex) => {
    let value = network.hiddenBias[hiddenIndex];
    for (let inputIndex = 0; inputIndex < inputSize; inputIndex++) {
      value += network.inputWeights[hiddenIndex * inputSize + inputIndex]
        * inputs[inputIndex];
    }
    return Math.tanh(value);
  });
  const value = network.outputWeights.reduce(
    (sum, weight, index) => sum + weight * hidden[index], network.outputBias,
  );
  return { hidden, value };
}

function zeroActorGradient() {
  return {
    inputWeights: Array(hiddenSize * inputSize).fill(0),
    hiddenBias: Array(hiddenSize).fill(0),
    outputWeights: Array(factorCount * hiddenSize).fill(0),
    outputBias: Array(factorCount).fill(0),
  };
}

function zeroCriticGradient() {
  return {
    inputWeights: Array(hiddenSize * inputSize).fill(0),
    hiddenBias: Array(hiddenSize).fill(0),
    outputWeights: Array(hiddenSize).fill(0),
    outputBias: 0,
  };
}

const networkValues = (network) => [
  ...network.inputWeights,
  ...network.hiddenBias,
  ...network.outputWeights,
  ...(Array.isArray(network.outputBias) ? network.outputBias : [network.outputBias]),
];
const gradientNorm = (gradient) => Math.sqrt(
  networkValues(gradient).reduce((sum, value) => sum + value * value, 0),
);
const updateArray = (values, gradient, rate, scale, l2Value) => values.map(
  (value, index) => Math.max(-8, Math.min(8,
    value + rate * scale * (gradient[index] - l2Value * value),
  )),
);

const isMaterial = (score) => score.changeRate >= minChangeRate
  && score.changeRate <= maxChangeRate;
const tier = (row) => {
  const dualPositive = row.score.rankAdvantage > 0 && row.score.hpAdvantage > 0;
  return dualPositive && isMaterial(row.score) ? 2 : dualPositive ? 1 : 0;
};
const better = (left, right) => !right || tier(left) > tier(right)
  || (tier(left) === tier(right) && left.score.fitness > right.score.fitness);

function evaluateCheckpoint(actorValue, seedScope, seedCount, index = 0) {
  const candidateId = `neural-evaluation-candidate-${index}`;
  const baselineId = `neural-evaluation-qyz-${index}`;
  const assignments = assignmentsFor('online-resolver-neural-candidate', candidateId, baselineId);
  const model = policy(actorValue, { evaluation: true });
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
    if (invalid) throw new Error(`neural checkpoint evaluation failed (${invalid.id})`);
    groups.push(matches);
    matchCount += matches.length;
  }
  return scoreEvolutionSeedGroups(groups, { candidateId, baselineId, tableSize }, { uncertaintyZ });
}

async function persistState(completedEpoch) {
  const destination = resolve(stateOutput);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify({
    schema: 'qyj-neural-actor-critic-state-v1',
    namespaceSha256,
    configSha256,
    completedEpoch,
    actor,
    critic,
    matchCount,
    decisionCount,
    sampledChangeCount,
    history,
    checkpointPool,
  }, null, 2)}\n`, 'utf8');
}

for (let epoch = startEpoch; epoch <= epochs; epoch++) {
  const candidateId = 'neural-explorer';
  const baselineId = 'neural-training-qyz';
  const assignments = assignmentsFor('online-resolver-neural-explorer', candidateId, baselineId);
  const model = policy(actor, { epoch, samplingTemperature });
  const trajectories = [];
  let epochDecisions = 0;
  let epochChanges = 0;
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
        throw new Error(`neural training match failed (${match.id})`);
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

  const decisionRows = [];
  for (const trajectory of trajectories) {
    for (const trace of trajectory.traces) {
      if (!Array.isArray(trace.policyFeatures)
        || trace.policyFeatures.length !== inputSize) continue;
      const prediction = evaluateTournamentNeuralPolicy(model, {
        inputFeatures: trace.policyFeatures,
        tableSize,
        baselineActionKey: trace.behaviorBaselineActionKey,
        legalActionKeys: trace.legalActionKeys,
      });
      if (!prediction.candidates?.length) continue;
      const criticPrediction = forwardCritic(critic, prediction.inputs);
      decisionRows.push({
        trajectory,
        trace,
        prediction,
        criticPrediction,
        criticError: trajectory.reward - criticPrediction.value,
      });
    }
  }
  const errorMean = decisionRows.reduce((sum, row) => sum + row.criticError, 0)
    / Math.max(1, decisionRows.length);
  const errorVariance = decisionRows.reduce(
    (sum, row) => sum + ((row.criticError - errorMean) ** 2), 0,
  ) / Math.max(1, decisionRows.length - 1);
  const errorScale = Math.max(0.1, Math.sqrt(errorVariance));
  const actorGradient = zeroActorGradient();
  const criticGradient = zeroCriticGradient();
  for (const row of decisionRows) {
    const { trajectory, trace, prediction, criticPrediction } = row;
    const maxLogit = Math.max(...prediction.candidates.map(
      (candidate) => candidate.score / samplingTemperature,
    ));
    const masses = prediction.candidates.map((candidate) => Math.exp(
      candidate.score / samplingTemperature - maxLogit,
    ));
    const total = masses.reduce((sum, mass) => sum + mass, 0);
    const expectedEmbedding = Array(factorCount).fill(0);
    prediction.candidates.forEach((candidate, candidateIndex) => {
      const embedding = tournamentCategoricalActionEmbedding(candidate.actionKey);
      embedding.forEach((value, factorIndex) => {
        expectedEmbedding[factorIndex] += masses[candidateIndex] / total * value;
      });
    });
    const chosenEmbedding = tournamentCategoricalActionEmbedding(trace.actionKey);
    if (!chosenEmbedding) continue;
    const traceScale = ((row.criticError - errorMean) / errorScale)
      / Math.max(1, trajectory.traces.length);
    const factorGradient = chosenEmbedding.map((value, factorIndex) => (
      traceScale * (value - expectedEmbedding[factorIndex]) / samplingTemperature
    ));
    for (let factorIndex = 0; factorIndex < factorCount; factorIndex++) {
      actorGradient.outputBias[factorIndex] += factorGradient[factorIndex];
      for (let hiddenIndex = 0; hiddenIndex < hiddenSize; hiddenIndex++) {
        actorGradient.outputWeights[factorIndex * hiddenSize + hiddenIndex]
          += factorGradient[factorIndex] * prediction.hidden[hiddenIndex];
      }
    }
    for (let hiddenIndex = 0; hiddenIndex < hiddenSize; hiddenIndex++) {
      let hiddenGradient = 0;
      for (let factorIndex = 0; factorIndex < factorCount; factorIndex++) {
        hiddenGradient += factorGradient[factorIndex]
          * actor.outputWeights[factorIndex * hiddenSize + hiddenIndex];
      }
      hiddenGradient *= 1 - prediction.hidden[hiddenIndex] ** 2;
      actorGradient.hiddenBias[hiddenIndex] += hiddenGradient;
      for (let inputIndex = 0; inputIndex < inputSize; inputIndex++) {
        actorGradient.inputWeights[hiddenIndex * inputSize + inputIndex]
          += hiddenGradient * prediction.inputs[inputIndex];
      }
    }

    criticGradient.outputBias += row.criticError;
    for (let hiddenIndex = 0; hiddenIndex < hiddenSize; hiddenIndex++) {
      criticGradient.outputWeights[hiddenIndex]
        += row.criticError * criticPrediction.hidden[hiddenIndex];
      const hiddenGradient = row.criticError * critic.outputWeights[hiddenIndex]
        * (1 - criticPrediction.hidden[hiddenIndex] ** 2);
      criticGradient.hiddenBias[hiddenIndex] += hiddenGradient;
      for (let inputIndex = 0; inputIndex < inputSize; inputIndex++) {
        criticGradient.inputWeights[hiddenIndex * inputSize + inputIndex]
          += hiddenGradient * prediction.inputs[inputIndex];
      }
    }
    epochDecisions++;
    if (trace.actionKey !== trace.behaviorBaselineActionKey) epochChanges++;
  }

  const actorDivisor = Math.max(1, trajectories.length);
  for (const key of ['inputWeights', 'hiddenBias', 'outputWeights', 'outputBias']) {
    actorGradient[key] = actorGradient[key].map((item) => item / actorDivisor);
  }
  const criticDivisor = Math.max(1, decisionRows.length);
  for (const key of ['inputWeights', 'hiddenBias', 'outputWeights']) {
    criticGradient[key] = criticGradient[key].map((item) => item / criticDivisor);
  }
  criticGradient.outputBias /= criticDivisor;
  const actorNorm = gradientNorm(actorGradient);
  const criticNorm = gradientNorm(criticGradient);
  const actorScale = actorNorm > gradientClip ? gradientClip / actorNorm : 1;
  const criticScale = criticNorm > gradientClip ? gradientClip / criticNorm : 1;
  actor = {
    inputWeights: updateArray(
      actor.inputWeights, actorGradient.inputWeights,
      actorLearningRate, actorScale, actorL2,
    ),
    hiddenBias: updateArray(
      actor.hiddenBias, actorGradient.hiddenBias,
      actorLearningRate, actorScale, 0,
    ),
    outputWeights: updateArray(
      actor.outputWeights, actorGradient.outputWeights,
      actorLearningRate, actorScale, actorL2,
    ),
    outputBias: updateArray(
      actor.outputBias, actorGradient.outputBias,
      actorLearningRate, actorScale, 0,
    ),
  };
  critic = {
    inputWeights: updateArray(
      critic.inputWeights, criticGradient.inputWeights,
      criticLearningRate, criticScale, criticL2,
    ),
    hiddenBias: updateArray(
      critic.hiddenBias, criticGradient.hiddenBias,
      criticLearningRate, criticScale, 0,
    ),
    outputWeights: updateArray(
      critic.outputWeights, criticGradient.outputWeights,
      criticLearningRate, criticScale, criticL2,
    ),
    outputBias: Math.max(-8, Math.min(8,
      critic.outputBias + criticLearningRate * criticScale * criticGradient.outputBias,
    )),
  };
  decisionCount += epochDecisions;
  sampledChangeCount += epochChanges;
  const validation = evaluateCheckpoint(actor, 'fixed-validation', validationSeeds, epoch);
  const checkpoint = {
    epoch,
    actor: cloneNetwork(actor),
    critic: cloneNetwork(critic),
    score: validation,
  };
  checkpointPool.push(checkpoint);
  const rewards = trajectories.map((row) => row.reward);
  const rewardMean = rewards.reduce((sum, reward) => sum + reward, 0) / rewards.length;
  const rewardVariance = rewards.reduce(
    (sum, reward) => sum + ((reward - rewardMean) ** 2), 0,
  ) / Math.max(1, rewards.length - 1);
  const row = {
    epoch,
    rewardMean,
    rewardStandardDeviation: Math.sqrt(rewardVariance),
    criticRmse: Math.sqrt(decisionRows.reduce(
      (sum, item) => sum + item.criticError ** 2, 0,
    ) / Math.max(1, decisionRows.length)),
    actorGradientNorm: actorNorm,
    criticGradientNorm: criticNorm,
    actorWeightNorm: gradientNorm(actor),
    criticWeightNorm: gradientNorm(critic),
    sampledChangeRate: epochDecisions ? epochChanges / epochDecisions : 0,
    validationRankAdvantage: validation.rankAdvantage,
    validationHpAdvantage: validation.hpAdvantage,
    validationChangeRate: validation.changeRate,
    validationFitness: validation.fitness,
  };
  history.push(row);
  console.log(JSON.stringify(row));
  await persistState(epoch);
  completedEpoch = epoch;
  if (epoch >= stopAfterEpoch && epoch < epochs) break;
}

if (completedEpoch < epochs) {
  console.log(`paused=${resolve(stateOutput)} completedEpoch=${completedEpoch}/${epochs}`);
  process.exit(0);
}

const ranked = [...checkpointPool].sort((left, right) => (
  better(left, right) ? -1 : better(right, left) ? 1 : left.epoch - right.epoch
));
const shortlist = ranked.slice(0, selectionCandidates);
const finalSelection = shortlist.map((checkpoint, index) => ({
  epoch: checkpoint.epoch,
  preliminaryScore: checkpoint.score,
  actor: checkpoint.actor,
  critic: checkpoint.critic,
  score: evaluateCheckpoint(checkpoint.actor, 'final-selection', selectionSeeds, index),
}));
const selected = finalSelection.reduce((best, row) => (better(row, best) ? row : best), null);
const calibrationPassed = tier(selected) === 2;
const artifact = policy(selected.actor, {
  estimator: 'paired-tournament-memory-neural-actor-critic-with-nested-selection',
  ...config,
  selectedEpoch: selected.epoch,
  preliminaryCalibration: selected.preliminaryScore,
  calibration: selected.score,
  calibrationPassed,
  matches: matchCount,
  decisions: decisionCount,
  sampledChanges: sampledChangeCount,
  selectedCritic: selected.critic,
  history,
  finalSelection: finalSelection.map((row) => ({
    epoch: row.epoch,
    preliminaryScore: row.preliminaryScore,
    score: row.score,
  })),
});
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
console.log(`saved=${destination} state=${resolve(stateOutput)}`
  + ` matches=${matchCount} calibrationPassed=${calibrationPassed}`);
