import { compactResidualFeatures } from '../../js/game/blueprint-residual-policy.js';

export const TOURNAMENT_EVOLUTION_POLICY_SCHEMA = 'qyj-tournament-evolution-policy-v1';
export const TOURNAMENT_EVOLUTION_FEATURES = Object.freeze([
  'bias',
  'preflop',
  'flop',
  'turn',
  'river',
  'stackDepth',
  'spr',
  'inPosition',
  'multiway',
  'lateRound',
  'handStrength',
  'facingBet',
]);

const ACTION_RISK = Object.freeze({
  fold: -2,
  check: -0.5,
  call: 0,
  'raise:feint': 0.7,
  'raise:strike': 1.2,
  'raise:fierce': 1.7,
  allin: 2.5,
});
const STACK_DEPTH = Object.freeze({ xs: -1, s: -0.5, m: 0, d: 0.5, xd: 1 });
const SPR = Object.freeze({ 1: -1, 2: -0.5, 4: 0, 8: 0.5, hi: 1 });
const POSITION = Object.freeze({ early: -0.6, blind: -0.35, other: 0, middle: 0.25, late: 1 });
const ROUND = Object.freeze({ l1: -1, l2: -0.33, l3: 0.33, l4: 1 });

function finite(value, label, { min = -Infinity, max = Infinity } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new RangeError(`${label} must be finite in [${min}, ${max}]`);
  }
  return number;
}

function handStrength(label) {
  const postflop = /^c(\d+)-d([01])$/.exec(String(label));
  if (postflop) return Math.max(-1, Math.min(1,
    (Number(postflop[1]) - 2.5) / 2.5 + Number(postflop[2]) * 0.15,
  ));
  const pair = { 'pair-small': 0.35, 'pair-middle': 0.65, 'pair-premium': 1 }[label];
  if (pair != null) return pair;
  const bucket = /^h([1-5])-[so]$/.exec(String(label));
  return bucket ? (Number(bucket[1]) - 3) / 2 : 0;
}

export function tournamentEvolutionFeatures(informationSetKey) {
  const encoded = compactResidualFeatures(informationSetKey);
  if (!encoded) return null;
  const f = encoded.features;
  const street = String(f.s);
  return Object.freeze({
    tableSize: encoded.tableSize,
    values: Object.freeze([
      1,
      Number(street === 'preflop'),
      Number(street === 'flop'),
      Number(street === 'turn'),
      Number(street === 'river'),
      STACK_DEPTH[f.stk] ?? 0,
      SPR[f.spr] ?? 0,
      f.ip === '1' ? 1 : POSITION[f.p] ?? 0,
      f.a === 'hu' ? -1 : f.a === 'three' ? 0 : f.a === 'multi' ? 1 : 0,
      ROUND[f.r] ?? 0,
      handStrength(f.h),
      f.cl === '1' ? 1 : -1,
    ]),
  });
}

export function validateTournamentEvolutionPolicy(raw) {
  if (raw?.schema !== TOURNAMENT_EVOLUTION_POLICY_SCHEMA || raw.version !== 1
    || raw.mode !== 'offline-evaluation-only'
    || !Array.isArray(raw.tableSizes) || !raw.tableSizes.length
    || raw.tableSizes.some((value) => ![6, 9].includes(Number(value)))
    || new Set(raw.tableSizes.map(Number)).size !== raw.tableSizes.length
    || JSON.stringify(raw.featureOrder) !== JSON.stringify(TOURNAMENT_EVOLUTION_FEATURES)
    || !Array.isArray(raw.weights) || raw.weights.length !== TOURNAMENT_EVOLUTION_FEATURES.length
    || raw.weights.some((value) => !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 4)
    || !raw.training || !raw.provenance) {
    throw new TypeError('invalid tournament evolution policy');
  }
  const policy = {
    ...raw,
    tableSizes: Object.freeze(raw.tableSizes.map(Number)),
    featureOrder: TOURNAMENT_EVOLUTION_FEATURES,
    weights: Object.freeze(raw.weights.map((value, index) => finite(
      value, `weights[${index}]`, { min: -4, max: 4 },
    ))),
    maxShift: finite(raw.maxShift, 'maxShift', { min: 0.25, max: 3 }),
    interventionThreshold: finite(
      raw.interventionThreshold ?? 0, 'interventionThreshold', { min: 0, max: 3 },
    ),
    extremeShiftThreshold: finite(
      raw.extremeShiftThreshold, 'extremeShiftThreshold', { min: 0.25, max: 3 },
    ),
  };
  return Object.freeze(policy);
}

export function createTournamentEvolutionPolicy(weights, {
  tableSizes = [6],
  maxShift = 1.5,
  interventionThreshold = 0,
  extremeShiftThreshold = 0.9,
  training = {},
  provenance = {},
} = {}) {
  return validateTournamentEvolutionPolicy({
    schema: TOURNAMENT_EVOLUTION_POLICY_SCHEMA,
    version: 1,
    mode: 'offline-evaluation-only',
    tableSizes,
    featureOrder: TOURNAMENT_EVOLUTION_FEATURES,
    weights: [...weights],
    maxShift,
    interventionThreshold,
    extremeShiftThreshold,
    training: { estimator: 'complete-tournament-cross-entropy-evolution', ...training },
    provenance: { trainerVersion: 'qyj-v148-tournament-evolution-v1', ...provenance },
  });
}

export function evaluateTournamentEvolutionPolicy(modelOrArtifact, {
  informationSetKey,
  tableSize,
  baselineActionKey,
  legalActionKeys,
} = {}) {
  const model = validateTournamentEvolutionPolicy(modelOrArtifact);
  const encoded = tournamentEvolutionFeatures(informationSetKey);
  if (!encoded || !model.tableSizes.includes(Number(tableSize))
    || !Array.isArray(legalActionKeys) || !legalActionKeys.includes(baselineActionKey)
    || legalActionKeys.some((action) => ACTION_RISK[action] == null)
    || ACTION_RISK[baselineActionKey] == null) {
    return { accepted: false, reason: 'invalid-or-unsupported-state' };
  }
  const rawShift = encoded.values.reduce(
    (sum, value, index) => sum + value * model.weights[index], 0,
  );
  const shift = Math.max(-model.maxShift, Math.min(model.maxShift, rawShift));
  const targetRisk = ACTION_RISK[baselineActionKey] + shift;
  if (Math.abs(shift) < model.interventionThreshold) {
    return {
      accepted: false,
      reason: 'risk-shift-below-intervention-threshold',
      selectedActionKey: baselineActionKey,
      shift,
      rawShift,
      targetRisk,
      features: encoded.values,
    };
  }
  let candidates = legalActionKeys.map((actionKey) => ({
    actionKey,
    risk: ACTION_RISK[actionKey],
    distance: Math.abs(ACTION_RISK[actionKey] - targetRisk),
  }));
  if (Math.abs(shift) < model.extremeShiftThreshold
    && !['fold', 'allin'].includes(baselineActionKey)) {
    candidates = candidates.filter((candidate) => !['fold', 'allin'].includes(candidate.actionKey));
  }
  candidates.sort((left, right) => left.distance - right.distance
    || Number(left.actionKey !== baselineActionKey) - Number(right.actionKey !== baselineActionKey)
    || left.actionKey.localeCompare(right.actionKey));
  const selected = candidates[0]?.actionKey || baselineActionKey;
  return {
    accepted: selected !== baselineActionKey,
    reason: selected === baselineActionKey ? 'risk-shift-kept-baseline' : null,
    selectedActionKey: selected,
    shift,
    rawShift,
    targetRisk,
    features: encoded.values,
  };
}
