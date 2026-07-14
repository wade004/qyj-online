import {
  TOURNAMENT_CATEGORICAL_FACTORS,
  tournamentCategoricalActionEmbedding,
} from './categorical-policy.mjs';
import {
  TOURNAMENT_EVOLUTION_FEATURES,
  tournamentEvolutionFeatures,
} from './evolution-policy.mjs';

export const TOURNAMENT_NEURAL_POLICY_SCHEMA = 'qyj-tournament-neural-policy-v1';
export const TOURNAMENT_NEURAL_MEMORY_FEATURES = Object.freeze([
  'decisionDepth',
  'foldRate',
  'callRate',
  'aggressionRate',
  'lastActionRisk',
  'averageActionRisk',
  'hpTrend',
]);
export const TOURNAMENT_NEURAL_FEATURES = Object.freeze([
  ...TOURNAMENT_EVOLUTION_FEATURES,
  ...TOURNAMENT_NEURAL_MEMORY_FEATURES,
]);

function finite(value, label, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new RangeError(`${label} must be finite in [${min}, ${max}]`);
  }
  return number;
}

function finiteArray(values, length, label, maxAbs = 8) {
  if (!Array.isArray(values) || values.length !== length
    || values.some((value) => !Number.isFinite(Number(value))
      || Math.abs(Number(value)) > maxAbs)) {
    throw new TypeError(`${label} must contain ${length} finite weights`);
  }
  return Object.freeze(values.map(Number));
}

export function validateTournamentNeuralPolicy(raw) {
  const hiddenSize = Number(raw?.hiddenSize);
  const inputSize = TOURNAMENT_NEURAL_FEATURES.length;
  const outputSize = TOURNAMENT_CATEGORICAL_FACTORS.length;
  if (raw?.schema !== TOURNAMENT_NEURAL_POLICY_SCHEMA || raw.version !== 1
    || raw.mode !== 'offline-evaluation-only'
    || !Array.isArray(raw.tableSizes) || !raw.tableSizes.length
    || raw.tableSizes.some((value) => ![6, 9].includes(Number(value)))
    || !Number.isSafeInteger(hiddenSize) || hiddenSize < 2 || hiddenSize > 64
    || JSON.stringify(raw.featureOrder) !== JSON.stringify(TOURNAMENT_NEURAL_FEATURES)
    || JSON.stringify(raw.factorOrder) !== JSON.stringify(TOURNAMENT_CATEGORICAL_FACTORS)
    || !raw.actor || !raw.training || !raw.provenance) {
    throw new TypeError('invalid tournament neural policy');
  }
  return Object.freeze({
    ...raw,
    tableSizes: Object.freeze(raw.tableSizes.map(Number)),
    featureOrder: TOURNAMENT_NEURAL_FEATURES,
    factorOrder: TOURNAMENT_CATEGORICAL_FACTORS,
    hiddenSize,
    actor: Object.freeze({
      inputWeights: finiteArray(
        raw.actor.inputWeights, hiddenSize * inputSize, 'actor.inputWeights',
      ),
      hiddenBias: finiteArray(raw.actor.hiddenBias, hiddenSize, 'actor.hiddenBias'),
      outputWeights: finiteArray(
        raw.actor.outputWeights, outputSize * hiddenSize, 'actor.outputWeights',
      ),
      outputBias: finiteArray(raw.actor.outputBias, outputSize, 'actor.outputBias'),
    }),
    anchorPenalty: finite(raw.anchorPenalty, 'anchorPenalty', 0.05, 3),
    minAdvantage: finite(raw.minAdvantage, 'minAdvantage', 0, 2),
  });
}

export function createTournamentNeuralPolicy(actor, {
  tableSizes = [6],
  hiddenSize = 8,
  anchorPenalty = 0.35,
  minAdvantage = 0.05,
  training = {},
  provenance = {},
} = {}) {
  return validateTournamentNeuralPolicy({
    schema: TOURNAMENT_NEURAL_POLICY_SCHEMA,
    version: 1,
    mode: 'offline-evaluation-only',
    tableSizes,
    featureOrder: TOURNAMENT_NEURAL_FEATURES,
    factorOrder: TOURNAMENT_CATEGORICAL_FACTORS,
    hiddenSize,
    actor: {
      inputWeights: [...actor.inputWeights],
      hiddenBias: [...actor.hiddenBias],
      outputWeights: [...actor.outputWeights],
      outputBias: [...actor.outputBias],
    },
    anchorPenalty,
    minAdvantage,
    training: { estimator: 'tournament-neural-actor-critic', ...training },
    provenance: { trainerVersion: 'qyj-v159-neural-actor-critic-v1', ...provenance },
  });
}

export function tournamentNeuralFeatures(informationSetKey, memory = {}) {
  const encoded = tournamentEvolutionFeatures(informationSetKey);
  if (!encoded) return null;
  const decisions = Math.max(0, Number(memory.decisions) || 0);
  const divisor = Math.max(1, decisions);
  const startHp = Math.max(1, Number(memory.startHp) || Number(memory.currentHp) || 1500);
  const currentHp = Math.max(0, Number(memory.currentHp) || startHp);
  const clamp = (value) => Math.max(-1, Math.min(1, Number(value) || 0));
  return Object.freeze({
    tableSize: encoded.tableSize,
    values: Object.freeze([
      ...encoded.values,
      Math.min(1, decisions / 24),
      Math.min(1, Math.max(0, Number(memory.folds) || 0) / divisor),
      Math.min(1, Math.max(0, Number(memory.calls) || 0) / divisor),
      Math.min(1, Math.max(0, Number(memory.aggressive) || 0) / divisor),
      clamp((Number(memory.lastActionRisk) || 0) / 2.5),
      clamp((Number(memory.totalActionRisk) || 0) / divisor / 2.5),
      clamp((currentHp - startHp) / startHp),
    ]),
  });
}

export function evaluateTournamentNeuralPolicy(modelOrArtifact, {
  informationSetKey,
  inputFeatures = null,
  memory = {},
  tableSize,
  baselineActionKey,
  legalActionKeys,
} = {}) {
  const model = validateTournamentNeuralPolicy(modelOrArtifact);
  const encoded = inputFeatures == null
    ? tournamentNeuralFeatures(informationSetKey, memory)
    : { tableSize: Number(tableSize), values: inputFeatures.map(Number) };
  const inputs = encoded?.values;
  if (!encoded || !model.tableSizes.includes(Number(tableSize))
    || !Array.isArray(inputs) || inputs.length !== TOURNAMENT_NEURAL_FEATURES.length
    || inputs.some((value) => !Number.isFinite(value) || Math.abs(value) > 2)
    || !Array.isArray(legalActionKeys) || !legalActionKeys.includes(baselineActionKey)
    || legalActionKeys.some((action) => !tournamentCategoricalActionEmbedding(action))) {
    return { accepted: false, reason: 'invalid-or-unsupported-state' };
  }
  const hidden = Array.from({ length: model.hiddenSize }, (_, hiddenIndex) => {
    let value = model.actor.hiddenBias[hiddenIndex];
    for (let inputIndex = 0; inputIndex < inputs.length; inputIndex++) {
      value += model.actor.inputWeights[hiddenIndex * inputs.length + inputIndex]
        * inputs[inputIndex];
    }
    return Math.tanh(value);
  });
  const factors = TOURNAMENT_CATEGORICAL_FACTORS.map((_, factorIndex) => {
    let value = model.actor.outputBias[factorIndex];
    for (let hiddenIndex = 0; hiddenIndex < hidden.length; hiddenIndex++) {
      value += model.actor.outputWeights[factorIndex * hidden.length + hiddenIndex]
        * hidden[hiddenIndex];
    }
    return value;
  });
  const candidates = legalActionKeys.map((actionKey) => ({
    actionKey,
    score: tournamentCategoricalActionEmbedding(actionKey).reduce(
      (sum, embedding, index) => sum + embedding * factors[index],
      actionKey === baselineActionKey ? 0 : -model.anchorPenalty,
    ),
  })).sort((left, right) => right.score - left.score
    || Number(left.actionKey !== baselineActionKey) - Number(right.actionKey !== baselineActionKey)
    || left.actionKey.localeCompare(right.actionKey));
  const baselineScore = candidates.find((candidate) => candidate.actionKey === baselineActionKey).score;
  const best = candidates[0];
  const advantage = best.score - baselineScore;
  const accepted = best.actionKey !== baselineActionKey && advantage >= model.minAdvantage;
  return Object.freeze({
    accepted,
    reason: accepted ? null : 'neural-anchor-kept-baseline',
    selectedActionKey: accepted ? best.actionKey : baselineActionKey,
    advantage,
    inputs: Object.freeze([...inputs]),
    hidden: Object.freeze(hidden),
    factors: Object.freeze(factors),
    candidates: Object.freeze(candidates.map((candidate) => Object.freeze({ ...candidate }))),
  });
}
