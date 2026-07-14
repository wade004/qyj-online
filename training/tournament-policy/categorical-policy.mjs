import {
  TOURNAMENT_EVOLUTION_FEATURES,
  tournamentEvolutionFeatures,
} from './evolution-policy.mjs';

export const TOURNAMENT_CATEGORICAL_POLICY_SCHEMA = 'qyj-tournament-categorical-policy-v1';
export const TOURNAMENT_CATEGORICAL_FACTORS = Object.freeze([
  'risk', 'continuation', 'initiative',
]);

const ACTION_EMBEDDINGS = Object.freeze({
  fold: Object.freeze([-1, -1, -1]),
  check: Object.freeze([-0.25, -0.4, -1]),
  call: Object.freeze([0, 1, -0.7]),
  'raise:feint': Object.freeze([0.35, 0.4, 0.6]),
  'raise:strike': Object.freeze([0.6, 0.3, 0.8]),
  'raise:fierce': Object.freeze([0.8, 0.15, 1]),
  allin: Object.freeze([1, 0, 1]),
});

export function tournamentCategoricalActionEmbedding(actionKey) {
  const embedding = ACTION_EMBEDDINGS[actionKey];
  return embedding ? Object.freeze([...embedding]) : null;
}

const finite = (value, label, min, max) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new RangeError(`${label} must be finite in [${min}, ${max}]`);
  }
  return number;
};

export function validateTournamentCategoricalPolicy(raw) {
  const dimensions = TOURNAMENT_EVOLUTION_FEATURES.length
    * TOURNAMENT_CATEGORICAL_FACTORS.length;
  if (raw?.schema !== TOURNAMENT_CATEGORICAL_POLICY_SCHEMA || raw.version !== 1
    || raw.mode !== 'offline-evaluation-only'
    || !Array.isArray(raw.tableSizes) || !raw.tableSizes.length
    || raw.tableSizes.some((value) => ![6, 9].includes(Number(value)))
    || JSON.stringify(raw.featureOrder) !== JSON.stringify(TOURNAMENT_EVOLUTION_FEATURES)
    || JSON.stringify(raw.factorOrder) !== JSON.stringify(TOURNAMENT_CATEGORICAL_FACTORS)
    || !Array.isArray(raw.weights) || raw.weights.length !== dimensions
    || raw.weights.some((weight) => !Number.isFinite(Number(weight))
      || Math.abs(Number(weight)) > 4)
    || !raw.training || !raw.provenance) {
    throw new TypeError('invalid tournament categorical policy');
  }
  return Object.freeze({
    ...raw,
    tableSizes: Object.freeze(raw.tableSizes.map(Number)),
    featureOrder: TOURNAMENT_EVOLUTION_FEATURES,
    factorOrder: TOURNAMENT_CATEGORICAL_FACTORS,
    weights: Object.freeze(raw.weights.map(Number)),
    anchorPenalty: finite(raw.anchorPenalty, 'anchorPenalty', 0.05, 3),
    minAdvantage: finite(raw.minAdvantage, 'minAdvantage', 0, 2),
  });
}

export function createTournamentCategoricalPolicy(weights, {
  tableSizes = [6], anchorPenalty = 0.35, minAdvantage = 0.05,
  training = {}, provenance = {},
} = {}) {
  return validateTournamentCategoricalPolicy({
    schema: TOURNAMENT_CATEGORICAL_POLICY_SCHEMA,
    version: 1,
    mode: 'offline-evaluation-only',
    tableSizes,
    featureOrder: TOURNAMENT_EVOLUTION_FEATURES,
    factorOrder: TOURNAMENT_CATEGORICAL_FACTORS,
    weights: [...weights],
    anchorPenalty,
    minAdvantage,
    training: { estimator: 'complete-tournament-factorized-categorical-evolution', ...training },
    provenance: { trainerVersion: 'qyj-v154-factorized-categorical-evolution-v1', ...provenance },
  });
}

export function evaluateTournamentCategoricalPolicy(modelOrArtifact, {
  informationSetKey, tableSize, baselineActionKey, legalActionKeys,
} = {}) {
  const model = validateTournamentCategoricalPolicy(modelOrArtifact);
  const encoded = tournamentEvolutionFeatures(informationSetKey);
  if (!encoded || !model.tableSizes.includes(Number(tableSize))
    || !Array.isArray(legalActionKeys) || !legalActionKeys.includes(baselineActionKey)
    || legalActionKeys.some((action) => !ACTION_EMBEDDINGS[action])) {
    return { accepted: false, reason: 'invalid-or-unsupported-state' };
  }
  const featureCount = TOURNAMENT_EVOLUTION_FEATURES.length;
  const factors = TOURNAMENT_CATEGORICAL_FACTORS.map((_, factorIndex) => (
    encoded.values.reduce((sum, feature, featureIndex) => (
      sum + feature * model.weights[factorIndex * featureCount + featureIndex]
    ), 0)
  ));
  const candidates = legalActionKeys.map((actionKey) => ({
    actionKey,
    score: ACTION_EMBEDDINGS[actionKey].reduce(
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
  return {
    accepted,
    reason: accepted ? null : 'categorical-anchor-kept-baseline',
    selectedActionKey: accepted ? best.actionKey : baselineActionKey,
    advantage,
    factors,
    features: encoded.values,
    candidates: candidates.map((candidate) => Object.freeze({ ...candidate })),
  };
}
