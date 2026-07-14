// Strategy registry used by the offline evaluation league. Keeping the
// registry outside Engine/ai.js makes it possible to benchmark a candidate
// without changing production decisions.

import fs from 'node:fs';
import { createHash } from 'node:crypto';

import * as AI from '../../js/game/ai.js';
import * as Config from '../../js/game/config.js';
import { buildObservation } from '../../js/game/observation.js';
import {
  actionFromBlueprintKey,
  actionToBlueprintKey,
  buildBlueprintInfoSetKey,
} from '../../js/game/blueprint-policy.js';
import {
  compactResidualFeatures,
  predictCompactResidualPolicy,
} from '../../js/game/blueprint-residual-policy.js';
import { evaluateResidualInterventionSelector } from '../blueprint/residual-selector.mjs';
import { compileTournamentValueModel } from '../tournament-value/model.js';
import {
  buildOnlineResolverTarget,
  solveOnlineResolverTarget,
} from './online-resolver.mjs';
import {
  evaluateRealEngineTransferSelector,
  validateRealEngineTransferSelector,
} from './real-engine-transfer-selector.mjs';
import {
  choosePublicOptionContinuationAction,
  evaluatePublicBeliefRolloutActions,
  evaluatePublicBeliefOptionPlans,
  evaluateScreenedPublicBeliefRolloutActions,
} from './public-belief-rollout.mjs';
import {
  evaluateConfirmedRolloutSelector,
  validateConfirmedRolloutSelector,
} from './confirmed-rollout-selector.mjs';
import {
  evaluateCausalHarmGate,
  validateCausalHarmGate,
} from './causal-harm-gate.mjs';
import {
  evaluateRolloutValueCalibrator,
  validateRolloutValueCalibrator,
} from './rollout-value-calibrator.mjs';
import {
  evaluateTournamentTrajectoryPolicy,
  validateTournamentTrajectoryPolicy,
} from '../tournament-policy/model.mjs';
import {
  evaluateTournamentSequencePolicy,
  validateTournamentSequencePolicy,
} from '../tournament-policy/sequence-model.mjs';
import {
  evaluateTournamentLinearEnsemble,
  validateTournamentLinearEnsemble,
} from '../tournament-policy/linear-ensemble-model.mjs';
import {
  evaluateTournamentPairwiseJackknifeIps,
  evaluateTournamentPairwiseIpsEnsemble,
  validateTournamentPairwiseJackknifeIps,
  validateTournamentPairwiseIpsEnsemble,
} from '../tournament-policy/pairwise-ips-ensemble.mjs';
import {
  evaluateTournamentEvolutionPolicy,
  validateTournamentEvolutionPolicy,
} from '../tournament-policy/evolution-policy.mjs';
import {
  evaluateTournamentCategoricalPolicy,
  tournamentCategoricalActionEmbedding,
  validateTournamentCategoricalPolicy,
} from '../tournament-policy/categorical-policy.mjs';
import {
  evaluateTournamentNeuralPolicy,
  validateTournamentNeuralPolicy,
} from '../tournament-policy/neural-policy.mjs';

const RESIDUAL_OPTION_STATES = new WeakMap();
const PUBLIC_BELIEF_OPTION_STATES = new WeakMap();
const TOURNAMENT_SEQUENCE_STATES = new WeakMap();
const HAND_FROZEN_STYLE_STATES = new WeakMap();
const TOURNAMENT_NEURAL_STATES = new WeakMap();
let FORMAL_TOURNAMENT_VALUE_MODEL = null;

let FORMAL_TOURNAMENT_VALUE_BUNDLE = null;
const REAL_ENGINE_TRANSFER_SELECTORS = new Map();
const CONFIRMED_ROLLOUT_SELECTORS = new Map();
const CAUSAL_HARM_GATES = new Map();
const ROLLOUT_VALUE_CALIBRATORS = new Map();
const TOURNAMENT_TRAJECTORY_POLICIES = new Map();
const TOURNAMENT_SEQUENCE_POLICIES = new Map();
const TOURNAMENT_LINEAR_ENSEMBLES = new Map();
const TOURNAMENT_PAIRWISE_IPS_ENSEMBLES = new Map();
const TOURNAMENT_PAIRWISE_JACKKNIFE_IPS_MODELS = new Map();
const TOURNAMENT_EVOLUTION_POLICIES = new Map();
const TOURNAMENT_CATEGORICAL_POLICIES = new Map();
const TOURNAMENT_NEURAL_POLICIES = new Map();

function tournamentNeuralPolicy(relativePath) {
  if (TOURNAMENT_NEURAL_POLICIES.has(relativePath)) {
    return TOURNAMENT_NEURAL_POLICIES.get(relativePath);
  }
  const text = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const bundle = Object.freeze({
    model: validateTournamentNeuralPolicy(JSON.parse(text)),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  TOURNAMENT_NEURAL_POLICIES.set(relativePath, bundle);
  return bundle;
}

function tournamentCategoricalPolicy(relativePath) {
  if (TOURNAMENT_CATEGORICAL_POLICIES.has(relativePath)) {
    return TOURNAMENT_CATEGORICAL_POLICIES.get(relativePath);
  }
  const text = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const bundle = Object.freeze({
    model: validateTournamentCategoricalPolicy(JSON.parse(text)),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  TOURNAMENT_CATEGORICAL_POLICIES.set(relativePath, bundle);
  return bundle;
}

function tournamentEvolutionPolicy(relativePath) {
  if (TOURNAMENT_EVOLUTION_POLICIES.has(relativePath)) {
    return TOURNAMENT_EVOLUTION_POLICIES.get(relativePath);
  }
  const text = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const bundle = Object.freeze({
    model: validateTournamentEvolutionPolicy(JSON.parse(text)),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  TOURNAMENT_EVOLUTION_POLICIES.set(relativePath, bundle);
  return bundle;
}

function tournamentPairwiseJackknifeIps(relativePath) {
  if (TOURNAMENT_PAIRWISE_JACKKNIFE_IPS_MODELS.has(relativePath)) {
    return TOURNAMENT_PAIRWISE_JACKKNIFE_IPS_MODELS.get(relativePath);
  }
  const text = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const bundle = Object.freeze({
    model: validateTournamentPairwiseJackknifeIps(JSON.parse(text)),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  TOURNAMENT_PAIRWISE_JACKKNIFE_IPS_MODELS.set(relativePath, bundle);
  return bundle;
}

function tournamentPairwiseIpsEnsemble(relativePath) {
  if (TOURNAMENT_PAIRWISE_IPS_ENSEMBLES.has(relativePath)) {
    return TOURNAMENT_PAIRWISE_IPS_ENSEMBLES.get(relativePath);
  }
  const text = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const bundle = Object.freeze({
    model: validateTournamentPairwiseIpsEnsemble(JSON.parse(text)),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  TOURNAMENT_PAIRWISE_IPS_ENSEMBLES.set(relativePath, bundle);
  return bundle;
}

function tournamentLinearEnsemble(relativePath) {
  if (TOURNAMENT_LINEAR_ENSEMBLES.has(relativePath)) {
    return TOURNAMENT_LINEAR_ENSEMBLES.get(relativePath);
  }
  const text = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const bundle = Object.freeze({
    model: validateTournamentLinearEnsemble(JSON.parse(text)),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  TOURNAMENT_LINEAR_ENSEMBLES.set(relativePath, bundle);
  return bundle;
}

function tournamentSequencePolicy(relativePath) {
  if (TOURNAMENT_SEQUENCE_POLICIES.has(relativePath)) {
    return TOURNAMENT_SEQUENCE_POLICIES.get(relativePath);
  }
  const text = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const bundle = Object.freeze({
    policy: validateTournamentSequencePolicy(JSON.parse(text)),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  TOURNAMENT_SEQUENCE_POLICIES.set(relativePath, bundle);
  return bundle;
}

function tournamentTrajectoryPolicy(relativePath) {
  if (TOURNAMENT_TRAJECTORY_POLICIES.has(relativePath)) {
    return TOURNAMENT_TRAJECTORY_POLICIES.get(relativePath);
  }
  const text = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const bundle = Object.freeze({
    policy: validateTournamentTrajectoryPolicy(JSON.parse(text)),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  TOURNAMENT_TRAJECTORY_POLICIES.set(relativePath, bundle);
  return bundle;
}

function rolloutValueCalibrator(relativePath, targetResolverStrategyKey) {
  if (!relativePath) return null;
  const cacheKey = `${relativePath}|${targetResolverStrategyKey}`;
  if (ROLLOUT_VALUE_CALIBRATORS.has(cacheKey)) {
    return ROLLOUT_VALUE_CALIBRATORS.get(cacheKey);
  }
  const text = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const bundle = Object.freeze({
    calibrator: validateRolloutValueCalibrator(JSON.parse(text), {
      targetResolverStrategyKey,
    }),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  ROLLOUT_VALUE_CALIBRATORS.set(cacheKey, bundle);
  return bundle;
}

function causalHarmGate(relativePath, targetResolverStrategyKey) {
  if (!relativePath) return null;
  const cacheKey = `${relativePath}|${targetResolverStrategyKey}`;
  if (CAUSAL_HARM_GATES.has(cacheKey)) return CAUSAL_HARM_GATES.get(cacheKey);
  const text = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const bundle = Object.freeze({
    gate: validateCausalHarmGate(JSON.parse(text), { targetResolverStrategyKey }),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  CAUSAL_HARM_GATES.set(cacheKey, bundle);
  return bundle;
}

function confirmedRolloutSelector(relativePath) {
  if (CONFIRMED_ROLLOUT_SELECTORS.has(relativePath)) {
    return CONFIRMED_ROLLOUT_SELECTORS.get(relativePath);
  }
  const text = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const bundle = Object.freeze({
    selector: validateConfirmedRolloutSelector(JSON.parse(text)),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  CONFIRMED_ROLLOUT_SELECTORS.set(relativePath, bundle);
  return bundle;
}

function realEngineTransferSelector(relativePath, resolverStrategyKey) {
  if (!relativePath) return null;
  const cacheKey = `${relativePath}|${resolverStrategyKey}`;
  if (REAL_ENGINE_TRANSFER_SELECTORS.has(cacheKey)) {
    return REAL_ENGINE_TRANSFER_SELECTORS.get(cacheKey);
  }
  const text = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const selector = validateRealEngineTransferSelector(JSON.parse(text), { resolverStrategyKey });
  const bundle = Object.freeze({
    selector,
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  REAL_ENGINE_TRANSFER_SELECTORS.set(cacheKey, bundle);
  return bundle;
}

function formalTournamentValueBundle() {
  if (FORMAL_TOURNAMENT_VALUE_BUNDLE) return FORMAL_TOURNAMENT_VALUE_BUNDLE;
  const modelText = fs.readFileSync(
    new URL('../checkpoints/qyj-tv-v4-formal.json', import.meta.url), 'utf8',
  );
  const reportText = fs.readFileSync(
    new URL('../checkpoints/qyj-tv-v4-formal-quality.json', import.meta.url), 'utf8',
  );
  const artifact = JSON.parse(modelText);
  const report = JSON.parse(reportText);
  const sha256 = createHash('sha256').update(modelText).digest('hex');
  if (report?.promotion?.passed !== true || report?.model?.sha256 !== sha256) {
    throw new RangeError('formal tournament value model is not bound to a passed quality report');
  }
  FORMAL_TOURNAMENT_VALUE_MODEL = compileTournamentValueModel(artifact);
  FORMAL_TOURNAMENT_VALUE_BUNDLE = Object.freeze({
    model: FORMAL_TOURNAMENT_VALUE_MODEL,
    modelText,
    reportText,
    source: Object.freeze({
      schema: artifact.schema,
      version: artifact.version,
      sha256,
      qualityReportSha256: createHash('sha256').update(reportText).digest('hex'),
      datasetSha256: report?.dataset?.sha256 || null,
    }),
  });
  return FORMAL_TOURNAMENT_VALUE_BUNDLE;
}

function formalTournamentValueModel() {
  return formalTournamentValueBundle().model;
}

function residualOptionStates(engine) {
  let states = RESIDUAL_OPTION_STATES.get(engine);
  if (!states) {
    states = new Map();
    RESIDUAL_OPTION_STATES.set(engine, states);
  }
  return states;
}

function publicBeliefOptionStates(engine) {
  let states = PUBLIC_BELIEF_OPTION_STATES.get(engine);
  if (!states) {
    states = new Map();
    PUBLIC_BELIEF_OPTION_STATES.set(engine, states);
  }
  return states;
}

function tournamentSequenceStates(engine) {
  let states = TOURNAMENT_SEQUENCE_STATES.get(engine);
  if (!states) {
    states = new Map();
    TOURNAMENT_SEQUENCE_STATES.set(engine, states);
  }
  return states;
}

function aiStyle(key) {
  const style = Config.AI_STYLES.find((candidate) => candidate.key === key);
  if (!style) throw new Error(`Unknown AI style: ${key}`);
  return style;
}

function qyzStrategy(key, label, styleKey, decisionOptions = {}) {
  return Object.freeze({
    key,
    label,
    description: `QYZ range/EV policy using the ${styleKey} runtime profile`,
    style: aiStyle(styleKey),
    supportsSkills: true,
    decide({ engine, player }) {
      // Explicit null keeps league baselines isolated from any checkpoint that
      // the browser/runtime may have installed globally in this process.
      const options = typeof decisionOptions === 'function'
        ? decisionOptions(engine) : decisionOptions;
      return AI.decideWithBlueprint(engine, player, null, options);
    },
    maybeUseSkill({ engine, player }) {
      return AI.maybeUseSkill(engine, player);
    },
  });
}

function handFrozenStyle(engine, player, mode) {
  let states = HAND_FROZEN_STYLE_STATES.get(engine);
  if (!states) {
    states = new Map();
    HAND_FROZEN_STYLE_STATES.set(engine, states);
  }
  const previous = states.get(player.idx);
  if (previous?.round === engine.round && previous.mode === mode) return previous.style;
  const alive = (engine.players || []).filter(
    (candidate) => candidate?.alive !== false && Number(candidate?.hp) > 0,
  );
  const averageHp = alive.length
    ? alive.reduce((sum, candidate) => sum + Number(candidate.hp), 0) / alive.length
    : Math.max(1, Number(player.hp));
  const ratio = Number(player.hp) / Math.max(1, averageHp);
  let styleKey = 'tag';
  if (mode === 'short-pressure' && ratio <= 0.85) styleKey = 'aggressive';
  if (mode === 'stack-polarized') {
    if (ratio <= 0.75) styleKey = 'aggressive';
    else if (ratio >= 1.4) styleKey = 'tight';
  }
  if (mode === 'survivor') {
    if (ratio <= 0.75) styleKey = 'aggressive';
    else if (alive.length <= Math.ceil(Number(engine.tableSize) / 2) && ratio >= 1.15) {
      styleKey = 'tight';
    }
  }
  const style = aiStyle(styleKey);
  states.set(player.idx, { round: engine.round, mode, style });
  return style;
}

function withPlayerStyle(player, style, callback) {
  const original = player.style;
  player.style = style;
  try {
    return callback();
  } finally {
    player.style = original;
  }
}

function qyzHandFrozenStyleStrategy({ key, label, mode }) {
  return Object.freeze({
    key,
    label,
    description: `QYZ whole-hand frozen public stack style (${mode})`,
    style: aiStyle('tag'),
    supportsSkills: true,
    decide({ engine, player }) {
      const style = handFrozenStyle(engine, player, mode);
      return withPlayerStyle(player, style, () => AI.decideWithBlueprint(engine, player, null));
    },
    maybeUseSkill({ engine, player }) {
      const style = handFrozenStyle(engine, player, mode);
      return withPlayerStyle(player, style, () => AI.maybeUseSkill(engine, player));
    },
  });
}

function legalActions(options) {
  const actions = [];
  if (options.canCheck) actions.push({ type: 'check' });
  if (!options.canCheck) {
    actions.push({ type: 'fold' });
    actions.push({ type: 'call' });
  }
  for (const tier of options.tiers || []) actions.push({ type: 'raise', tier });
  if (options.canAllIn) actions.push({ type: 'allin' });
  return actions;
}

function qyzExplorationStrategy({ key, label, epsilon = 0.4 }) {
  if (!(epsilon > 0 && epsilon < 1)) throw new RangeError('exploration epsilon must be in (0, 1)');
  return Object.freeze({
    key,
    label,
    description: `Offline QYZ epsilon exploration with logged propensity (${epsilon}).`,
    style: aiStyle('tag'),
    supportsSkills: false,
    decide({ engine, player, options, rng }) {
      const baseAction = AI.decideWithBlueprint(engine, player, null);
      const baseActionKey = actionToBlueprintKey(baseAction);
      const actions = legalActions(options).filter((action) => action.type !== 'allin');
      const explore = rng() < epsilon;
      const selected = explore ? actions[Math.floor(rng() * actions.length)] : baseAction;
      const selectedActionKey = actionToBlueprintKey(selected);
      const uniformProbability = epsilon / actions.length;
      const baseInSupport = actions.some(
        (action) => actionToBlueprintKey(action) === baseActionKey,
      );
      return {
        ...selected,
        behaviorPolicy: 'qyz-bounded-epsilon-exploration-v1',
        behaviorProbability: selectedActionKey === baseActionKey
          ? (1 - epsilon) + (baseInSupport ? uniformProbability : 0)
          : uniformProbability,
        behaviorEpsilon: epsilon,
        behaviorBaselineActionKey: baseActionKey,
        behaviorSupportActionKeys: actions.map(actionToBlueprintKey),
        behaviorExplored: explore,
      };
    },
  });
}

function tournamentTrajectoryStrategy({ key, label, policyPath, blockedActionTransitions = null }) {
  return Object.freeze({
    key,
    label,
    description: 'Complete-12-hand trajectory action-value policy with independent-group LCB.',
    style: aiStyle('tag'),
    supportsSkills: false,
    decide({ engine, player, options }) {
      const baseAction = AI.decideWithBlueprint(engine, player, null);
      const baseActionKey = actionToBlueprintKey(baseAction);
      try {
        const observation = buildObservation(engine, player);
        const informationSetKey = buildBlueprintInfoSetKey(observation, {
          opts: observation.legalActions,
          maxRaisesPerStreet: 3,
        });
        const legalActionKeys = legalActions(options).map(actionToBlueprintKey).filter(Boolean);
        const bundle = tournamentTrajectoryPolicy(policyPath);
        const prediction = evaluateTournamentTrajectoryPolicy(bundle.policy, {
          informationSetKey,
          tableSize: engine.tableSize,
          baselineActionKey: baseActionKey,
          legalActionKeys,
        });
        const selectedActionKey = prediction.selected?.actionKey || null;
        const transitionBlocked = prediction.accepted
          && typeof blockedActionTransitions === 'function'
          && blockedActionTransitions({ engine, baseActionKey, actionKey: selectedActionKey });
        if (!prediction.accepted || ['fold', 'allin'].includes(selectedActionKey)
          || transitionBlocked) {
          return { ...baseAction, onlineResolverDiagnostics: {
            accepted: false,
            reason: prediction.accepted
              ? transitionBlocked
                ? 'trajectory-transition-disabled'
                : 'trajectory-extreme-action-disabled'
              : `trajectory:${prediction.reason}`,
            street: engine.street,
            utilitySamples: 0,
            intervened: false,
            actionChanged: false,
            baseActionKey,
            resolverActionKey: baseActionKey,
            trajectoryLevel: prediction.level || null,
            trajectoryPolicySha256: bundle.sha256,
          } };
        }
        const action = actionFromBlueprintKey(selectedActionKey, options);
        if (!action) throw new RangeError('trajectory-selected action is not legal');
        return { ...action, onlineResolverDiagnostics: {
          accepted: true,
          reason: null,
          street: engine.street,
          utilitySamples: 0,
          intervened: true,
          actionChanged: selectedActionKey !== baseActionKey,
          baseActionKey,
          resolverActionKey: selectedActionKey,
          advantageLowerBound: prediction.selected.lowerBound,
          policyTV: 1,
          influence: 1,
          trajectoryLevel: prediction.level,
          trajectoryPolicySha256: bundle.sha256,
        } };
      } catch (error) {
        return { ...baseAction, onlineResolverDiagnostics: {
          accepted: false,
          reason: `trajectory-error:${String(error?.message || error).slice(0, 140)}`,
          street: engine.street,
          utilitySamples: 0,
          intervened: false,
          actionChanged: false,
          baseActionKey,
          resolverActionKey: baseActionKey,
        } };
      }
    },
  });
}

function tournamentLinearEnsembleStrategy({
  key, label, modelPath, causalHarmGatePath = null,
  causalHarmTargetResolverStrategyKey = 'online-resolver-v19-table-powered',
  streets = ['preflop', 'flop', 'turn', 'river'],
}) {
  return Object.freeze({
    key,
    label,
    description: 'Independent-group propensity-weighted dual-objective linear ensemble.',
    style: aiStyle('tag'),
    supportsSkills: true,
    decide({ engine, player, options }) {
      const baseAction = AI.decideWithBlueprint(engine, player, null);
      const baseActionKey = actionToBlueprintKey(baseAction);
      if (!streets.includes(engine.street)) {
        return { ...baseAction, onlineResolverDiagnostics: {
          accepted: false,
          reason: 'linear-ensemble:street-disabled',
          street: engine.street,
          utilitySamples: 0,
          intervened: false,
          actionChanged: false,
          baseActionKey,
          resolverActionKey: baseActionKey,
        } };
      }
      try {
        const observation = buildObservation(engine, player);
        const informationSetKey = buildBlueprintInfoSetKey(observation, {
          opts: observation.legalActions,
          maxRaisesPerStreet: 3,
        });
        const legalActionKeys = legalActions(options).map(actionToBlueprintKey).filter(Boolean);
        const bundle = tournamentLinearEnsemble(modelPath);
        const prediction = evaluateTournamentLinearEnsemble(bundle.model, {
          informationSetKey,
          tableSize: engine.tableSize,
          baselineActionKey: baseActionKey,
          legalActionKeys,
        });
        const selectedActionKey = prediction.selected?.actionKey || null;
        if (!prediction.accepted || !selectedActionKey) {
          return { ...baseAction, onlineResolverDiagnostics: {
            accepted: false,
            reason: `linear-ensemble:${prediction.reason}`,
            street: engine.street,
            utilitySamples: prediction.selected?.groups || 0,
            intervened: false,
            actionChanged: false,
            baseActionKey,
            resolverActionKey: baseActionKey,
            linearEnsembleSha256: bundle.sha256,
          } };
        }
        let harmGate = null;
        let harmBundle = null;
        if (causalHarmGatePath) {
          const encoded = compactResidualFeatures(informationSetKey);
          harmBundle = causalHarmGate(
            causalHarmGatePath,
            causalHarmTargetResolverStrategyKey,
          );
          harmGate = evaluateCausalHarmGate(harmBundle.gate, {
            tableSize: engine.tableSize,
            street: engine.street,
            mask: encoded?.mask || '',
            features: encoded?.features || {},
            baseActionKey,
            actionKey: selectedActionKey,
            pot: observation.betting.pot,
            screen: null,
            confirmation: null,
          });
          if (!harmGate.eligible) {
            return { ...baseAction, onlineResolverDiagnostics: {
              accepted: false,
              reason: `linear-ensemble:${harmGate.reason}`,
              street: engine.street,
              utilitySamples: prediction.selected.groups,
              intervened: false,
              actionChanged: false,
              baseActionKey,
              resolverActionKey: baseActionKey,
              proposedActionKey: selectedActionKey,
              causalHarmGate: harmGate,
              causalHarmGateSha256: harmBundle.sha256,
              linearEnsembleSha256: bundle.sha256,
            } };
          }
        }
        const action = actionFromBlueprintKey(selectedActionKey, options);
        if (!action) throw new RangeError('linear ensemble selected an illegal action');
        return { ...action, onlineResolverDiagnostics: {
          accepted: true,
          reason: null,
          street: engine.street,
          utilitySamples: prediction.selected.groups,
          intervened: true,
          actionChanged: selectedActionKey !== baseActionKey,
          baseActionKey,
          resolverActionKey: selectedActionKey,
          advantageLowerBound: prediction.selected.safetyLowerBound,
          policyTV: selectedActionKey === baseActionKey ? 0 : 1,
          influence: selectedActionKey === baseActionKey ? 0 : 1,
          linearRankLower95: prediction.selected.rank.lower95,
          linearHpLower95: prediction.selected.hp.lower95,
          causalHarmGate: harmGate,
          causalHarmGateSha256: harmBundle?.sha256 || null,
          linearEnsembleSha256: bundle.sha256,
        } };
      } catch (error) {
        return { ...baseAction, onlineResolverDiagnostics: {
          accepted: false,
          reason: `linear-ensemble-error:${String(error?.message || error).slice(0, 140)}`,
          street: engine.street,
          utilitySamples: 0,
          intervened: false,
          actionChanged: false,
          baseActionKey,
          resolverActionKey: baseActionKey,
        } };
      }
    },
    maybeUseSkill({ engine, player }) {
      return AI.maybeUseSkill(engine, player);
    },
  });
}

function tournamentPairwiseIpsStrategy({ key, label, modelPath, jackknife = false }) {
  return Object.freeze({
    key,
    label,
    description: 'Centered pairwise IPS causal action-contrast ensemble.',
    style: aiStyle('tag'),
    supportsSkills: true,
    decide({ engine, player, options }) {
      const baseAction = AI.decideWithBlueprint(engine, player, null);
      const baseActionKey = actionToBlueprintKey(baseAction);
      try {
        const observation = buildObservation(engine, player);
        const informationSetKey = buildBlueprintInfoSetKey(observation, {
          opts: observation.legalActions,
          maxRaisesPerStreet: 3,
        });
        const legalActionKeys = legalActions(options).map(actionToBlueprintKey).filter(Boolean);
        const bundle = jackknife
          ? tournamentPairwiseJackknifeIps(modelPath)
          : tournamentPairwiseIpsEnsemble(modelPath);
        const prediction = (jackknife
          ? evaluateTournamentPairwiseJackknifeIps
          : evaluateTournamentPairwiseIpsEnsemble)(bundle.model, {
          informationSetKey,
          tableSize: engine.tableSize,
          baselineActionKey: baseActionKey,
          legalActionKeys,
        });
        const selectedActionKey = prediction.selected?.actionKey || null;
        if (!prediction.accepted || !selectedActionKey) {
          return { ...baseAction, onlineResolverDiagnostics: {
            accepted: false,
            reason: `pairwise-ips:${prediction.reason}`,
            street: engine.street,
            utilitySamples: prediction.selected?.groups || 0,
            intervened: false,
            actionChanged: false,
            baseActionKey,
            resolverActionKey: baseActionKey,
            pairwiseIpsSha256: bundle.sha256,
          } };
        }
        const action = actionFromBlueprintKey(selectedActionKey, options);
        if (!action) throw new RangeError('pairwise IPS selected an illegal action');
        return { ...action, onlineResolverDiagnostics: {
          accepted: true,
          reason: null,
          street: engine.street,
          utilitySamples: prediction.selected.groups,
          intervened: true,
          actionChanged: selectedActionKey !== baseActionKey,
          baseActionKey,
          resolverActionKey: selectedActionKey,
          advantageLowerBound: prediction.selected.safetyLowerBound,
          policyTV: 1,
          influence: 1,
          pairwiseRankLower95: prediction.selected.rank.lower95,
          pairwiseHpLower95: prediction.selected.hp.lower95,
          pairwiseIpsSha256: bundle.sha256,
        } };
      } catch (error) {
        return { ...baseAction, onlineResolverDiagnostics: {
          accepted: false,
          reason: `pairwise-ips-error:${String(error?.message || error).slice(0, 140)}`,
          street: engine.street,
          utilitySamples: 0,
          intervened: false,
          actionChanged: false,
          baseActionKey,
          resolverActionKey: baseActionKey,
        } };
      }
    },
    maybeUseSkill({ engine, player }) {
      return AI.maybeUseSkill(engine, player);
    },
  });
}

function tournamentEvolutionStrategy({ key, label, modelPath = null }) {
  return Object.freeze({
    key,
    label,
    description: 'Complete-tournament evolved contextual risk-shift policy.',
    style: aiStyle('tag'),
    supportsSkills: true,
    decide({ engine, player, options, tournamentEvolutionModel }) {
      const baseAction = AI.decideWithBlueprint(engine, player, null);
      const baseActionKey = actionToBlueprintKey(baseAction);
      try {
        const bundle = modelPath ? tournamentEvolutionPolicy(modelPath) : null;
        const model = bundle?.model
          || validateTournamentEvolutionPolicy(tournamentEvolutionModel);
        const observation = buildObservation(engine, player);
        const informationSetKey = buildBlueprintInfoSetKey(observation, {
          opts: observation.legalActions,
          maxRaisesPerStreet: 3,
        });
        const legalActionKeys = legalActions(options).map(actionToBlueprintKey).filter(Boolean);
        const prediction = evaluateTournamentEvolutionPolicy(model, {
          informationSetKey,
          tableSize: engine.tableSize,
          baselineActionKey: baseActionKey,
          legalActionKeys,
        });
        if (!prediction.accepted) {
          return { ...baseAction, onlineResolverDiagnostics: {
            accepted: false,
            reason: `tournament-evolution:${prediction.reason}`,
            street: engine.street,
            utilitySamples: Number(model.training?.matches) || 0,
            intervened: false,
            actionChanged: false,
            baseActionKey,
            resolverActionKey: baseActionKey,
            tournamentEvolutionSha256: bundle?.sha256 || null,
          } };
        }
        const action = actionFromBlueprintKey(prediction.selectedActionKey, options);
        if (!action) throw new RangeError('tournament evolution selected an illegal action');
        return { ...action, onlineResolverDiagnostics: {
          accepted: true,
          reason: null,
          street: engine.street,
          utilitySamples: Number(model.training?.matches) || 0,
          intervened: true,
          actionChanged: prediction.selectedActionKey !== baseActionKey,
          baseActionKey,
          resolverActionKey: prediction.selectedActionKey,
          advantageLowerBound: null,
          policyTV: 1,
          influence: Math.min(1, Math.abs(prediction.shift) / Math.max(0.01, model.maxShift)),
          tournamentEvolutionSha256: bundle?.sha256 || null,
        } };
      } catch (error) {
        return { ...baseAction, onlineResolverDiagnostics: {
          accepted: false,
          reason: `tournament-evolution-error:${String(error?.message || error).slice(0, 140)}`,
          street: engine.street,
          utilitySamples: 0,
          intervened: false,
          actionChanged: false,
          baseActionKey,
          resolverActionKey: baseActionKey,
        } };
      }
    },
    maybeUseSkill({ engine, player }) {
      return AI.maybeUseSkill(engine, player);
    },
  });
}

function tournamentCategoricalStrategy({ key, label, modelPath = null }) {
  return Object.freeze({
    key,
    label,
    description: 'Complete-tournament evolved factorized categorical policy.',
    style: aiStyle('tag'),
    supportsSkills: true,
    decide({ engine, player, options, strategyModel }) {
      const baseAction = AI.decideWithBlueprint(engine, player, null);
      const baseActionKey = actionToBlueprintKey(baseAction);
      try {
        const bundle = modelPath ? tournamentCategoricalPolicy(modelPath) : null;
        const model = bundle?.model || validateTournamentCategoricalPolicy(strategyModel);
        const observation = buildObservation(engine, player);
        const informationSetKey = buildBlueprintInfoSetKey(observation, {
          opts: observation.legalActions,
          maxRaisesPerStreet: 3,
        });
        const legalActionKeys = legalActions(options).map(actionToBlueprintKey).filter(Boolean);
        const prediction = evaluateTournamentCategoricalPolicy(model, {
          informationSetKey,
          tableSize: engine.tableSize,
          baselineActionKey: baseActionKey,
          legalActionKeys,
        });
        if (!prediction.accepted) {
          return { ...baseAction, onlineResolverDiagnostics: {
            accepted: false,
            reason: `tournament-categorical:${prediction.reason}`,
            street: engine.street,
            utilitySamples: Number(model.training?.matches) || 0,
            intervened: false,
            actionChanged: false,
            baseActionKey,
            resolverActionKey: baseActionKey,
            tournamentCategoricalSha256: bundle?.sha256 || null,
          } };
        }
        const action = actionFromBlueprintKey(prediction.selectedActionKey, options);
        if (!action) throw new RangeError('tournament categorical policy selected an illegal action');
        return { ...action, onlineResolverDiagnostics: {
          accepted: true,
          reason: null,
          street: engine.street,
          utilitySamples: Number(model.training?.matches) || 0,
          intervened: true,
          actionChanged: true,
          baseActionKey,
          resolverActionKey: prediction.selectedActionKey,
          advantageLowerBound: null,
          policyTV: 1,
          influence: Math.min(1, Math.max(0, prediction.advantage)),
          tournamentCategoricalSha256: bundle?.sha256 || null,
        } };
      } catch (error) {
        return { ...baseAction, onlineResolverDiagnostics: {
          accepted: false,
          reason: `tournament-categorical-error:${String(error?.message || error).slice(0, 140)}`,
          street: engine.street,
          utilitySamples: 0,
          intervened: false,
          actionChanged: false,
          baseActionKey,
          resolverActionKey: baseActionKey,
        } };
      }
    },
    maybeUseSkill({ engine, player }) {
      return AI.maybeUseSkill(engine, player);
    },
  });
}

function tournamentCategoricalExplorationStrategy({ key, label }) {
  return Object.freeze({
    key,
    label,
    description: 'Training-only stochastic factorized categorical policy.',
    style: aiStyle('tag'),
    supportsSkills: false,
    decide({ engine, player, options, strategyModel, rng }) {
      const baseAction = AI.decideWithBlueprint(engine, player, null);
      const baseActionKey = actionToBlueprintKey(baseAction);
      const model = validateTournamentCategoricalPolicy(strategyModel);
      const observation = buildObservation(engine, player);
      const informationSetKey = buildBlueprintInfoSetKey(observation, {
        opts: observation.legalActions,
        maxRaisesPerStreet: 3,
      });
      const legalActionKeys = legalActions(options).map(actionToBlueprintKey).filter(Boolean);
      const prediction = evaluateTournamentCategoricalPolicy(model, {
        informationSetKey,
        tableSize: engine.tableSize,
        baselineActionKey: baseActionKey,
        legalActionKeys,
      });
      const temperature = Math.max(0.05, Math.min(
        2, Number(model.training?.samplingTemperature) || 0.18,
      ));
      const candidates = prediction.candidates || [{ actionKey: baseActionKey, score: 0 }];
      const maxLogit = Math.max(...candidates.map((candidate) => candidate.score / temperature));
      const masses = candidates.map((candidate) => Math.exp(
        candidate.score / temperature - maxLogit,
      ));
      const total = masses.reduce((sum, mass) => sum + mass, 0);
      const probabilities = masses.map((mass) => mass / total);
      let draw = rng() * total;
      let selectedIndex = masses.length - 1;
      for (let index = 0; index < masses.length; index++) {
        draw -= masses[index];
        if (draw <= 0) {
          selectedIndex = index;
          break;
        }
      }
      const selectedActionKey = candidates[selectedIndex].actionKey;
      const action = actionFromBlueprintKey(selectedActionKey, options);
      if (!action) throw new RangeError('categorical exploration selected an illegal action');
      const changed = selectedActionKey !== baseActionKey;
      return {
        ...action,
        behaviorPolicy: 'qyj-factorized-categorical-softmax-v1',
        behaviorProbability: probabilities[selectedIndex],
        behaviorBaselineActionKey: baseActionKey,
        behaviorSupportActionKeys: candidates.map((candidate) => candidate.actionKey),
        behaviorExplored: changed,
        onlineResolverDiagnostics: {
          accepted: changed,
          reason: changed ? null : 'tournament-categorical-sampled-baseline',
          street: engine.street,
          utilitySamples: Number(model.training?.matches) || 0,
          intervened: changed,
          actionChanged: changed,
          baseActionKey,
          resolverActionKey: selectedActionKey,
          policyTV: 1 - probabilities[candidates.findIndex(
            (candidate) => candidate.actionKey === baseActionKey,
          )],
          influence: changed ? 1 : 0,
        },
      };
    },
    maybeUseSkill() {
      return false;
    },
  });
}

function tournamentNeuralMemory(engine, player) {
  let byPlayer = TOURNAMENT_NEURAL_STATES.get(engine);
  if (!byPlayer) {
    byPlayer = new Map();
    TOURNAMENT_NEURAL_STATES.set(engine, byPlayer);
  }
  let memory = byPlayer.get(player.idx);
  if (!memory) {
    memory = {
      decisions: 0,
      folds: 0,
      calls: 0,
      aggressive: 0,
      lastActionRisk: 0,
      totalActionRisk: 0,
      startHp: Number(Config.INIT_HP) || 1500,
      currentHp: Number(player.hp) || Number(Config.INIT_HP) || 1500,
    };
    byPlayer.set(player.idx, memory);
  }
  memory.currentHp = Math.max(0, Number(player.hp) || 0);
  return memory;
}

function updateTournamentNeuralMemory(memory, actionKey) {
  const embedding = tournamentCategoricalActionEmbedding(actionKey) || [0];
  const risk = Number(embedding[0]) * 2.5;
  memory.decisions++;
  if (actionKey === 'fold') memory.folds++;
  if (actionKey === 'call') memory.calls++;
  if (actionKey === 'allin' || actionKey?.startsWith('raise:')) memory.aggressive++;
  memory.lastActionRisk = risk;
  memory.totalActionRisk += risk;
}

function tournamentNeuralStrategy({ key, label, modelPath = null, explore = false }) {
  return Object.freeze({
    key,
    label,
    description: explore
      ? 'Training-only stochastic tournament-memory neural policy.'
      : 'Nonlinear tournament-memory actor distilled to a low-latency policy head.',
    style: aiStyle('tag'),
    supportsSkills: !explore,
    decide({ engine, player, options, strategyModel, rng }) {
      const baseAction = AI.decideWithBlueprint(engine, player, null);
      const baseActionKey = actionToBlueprintKey(baseAction);
      try {
        const bundle = modelPath ? tournamentNeuralPolicy(modelPath) : null;
        const model = bundle?.model || validateTournamentNeuralPolicy(strategyModel);
        const observation = buildObservation(engine, player);
        const informationSetKey = buildBlueprintInfoSetKey(observation, {
          opts: observation.legalActions,
          maxRaisesPerStreet: 3,
        });
        const legalActionKeys = legalActions(options).map(actionToBlueprintKey).filter(Boolean);
        const memory = tournamentNeuralMemory(engine, player);
        const prediction = evaluateTournamentNeuralPolicy(model, {
          informationSetKey,
          memory,
          tableSize: engine.tableSize,
          baselineActionKey: baseActionKey,
          legalActionKeys,
        });
        if (!prediction.candidates?.length) {
          updateTournamentNeuralMemory(memory, baseActionKey);
          return { ...baseAction, onlineResolverDiagnostics: {
            accepted: false,
            reason: `tournament-neural:${prediction.reason}`,
            street: engine.street,
            utilitySamples: Number(model.training?.matches) || 0,
            intervened: false,
            actionChanged: false,
            baseActionKey,
            resolverActionKey: baseActionKey,
          } };
        }
        let selectedActionKey = prediction.selectedActionKey;
        let selectedProbability = 1;
        let probabilities = null;
        if (explore) {
          const temperature = Math.max(0.05, Math.min(
            2, Number(model.training?.samplingTemperature) || 0.18,
          ));
          const maxLogit = Math.max(...prediction.candidates.map(
            (candidate) => candidate.score / temperature,
          ));
          const masses = prediction.candidates.map((candidate) => Math.exp(
            candidate.score / temperature - maxLogit,
          ));
          const total = masses.reduce((sum, mass) => sum + mass, 0);
          probabilities = masses.map((mass) => mass / total);
          let draw = rng() * total;
          let selectedIndex = masses.length - 1;
          for (let index = 0; index < masses.length; index++) {
            draw -= masses[index];
            if (draw <= 0) {
              selectedIndex = index;
              break;
            }
          }
          selectedActionKey = prediction.candidates[selectedIndex].actionKey;
          selectedProbability = probabilities[selectedIndex];
        }
        const action = actionFromBlueprintKey(selectedActionKey, options);
        if (!action) throw new RangeError('tournament neural policy selected an illegal action');
        const changed = selectedActionKey !== baseActionKey;
        updateTournamentNeuralMemory(memory, selectedActionKey);
        const baselineIndex = prediction.candidates.findIndex(
          (candidate) => candidate.actionKey === baseActionKey,
        );
        return {
          ...action,
          ...(explore ? {
            behaviorPolicy: 'qyj-tournament-memory-neural-softmax-v1',
            behaviorProbability: selectedProbability,
            behaviorBaselineActionKey: baseActionKey,
            behaviorSupportActionKeys: prediction.candidates.map(
              (candidate) => candidate.actionKey,
            ),
            behaviorFeatures: prediction.inputs,
            behaviorExplored: changed,
          } : {}),
          onlineResolverDiagnostics: {
            accepted: changed,
            reason: changed ? null : 'tournament-neural-kept-baseline',
            street: engine.street,
            utilitySamples: Number(model.training?.matches) || 0,
            intervened: changed,
            actionChanged: changed,
            baseActionKey,
            resolverActionKey: selectedActionKey,
            advantageLowerBound: null,
            policyTV: explore && probabilities
              ? 1 - probabilities[baselineIndex] : changed ? 1 : 0,
            influence: changed ? Math.min(1, Math.max(0.01, prediction.advantage)) : 0,
            tournamentNeuralSha256: bundle?.sha256 || null,
          },
        };
      } catch (error) {
        if (explore) throw error;
        const memory = tournamentNeuralMemory(engine, player);
        updateTournamentNeuralMemory(memory, baseActionKey);
        return { ...baseAction, onlineResolverDiagnostics: {
          accepted: false,
          reason: `tournament-neural-error:${String(error?.message || error).slice(0, 140)}`,
          street: engine.street,
          utilitySamples: 0,
          intervened: false,
          actionChanged: false,
          baseActionKey,
          resolverActionKey: baseActionKey,
        } };
      }
    },
    maybeUseSkill({ engine, player }) {
      return explore ? false : AI.maybeUseSkill(engine, player);
    },
  });
}

function tournamentSequenceStrategy({
  key, label, policyPath, allowContinuationFold = false,
}) {
  return Object.freeze({
    key,
    label,
    description: 'Two-decision propensity-corrected tournament option policy.',
    style: aiStyle('tag'),
    supportsSkills: false,
    decide({ engine, player, options }) {
      const baseAction = AI.decideWithBlueprint(engine, player, null);
      const baseActionKey = actionToBlueprintKey(baseAction);
      const states = tournamentSequenceStates(engine);
      const pending = states.get(player.idx);
      if (pending) {
        states.delete(player.idx);
        if (pending.round === engine.round
          && pending.continuationActionKey !== 'allin'
          && (allowContinuationFold || pending.continuationActionKey !== 'fold')) {
          const continuation = actionFromBlueprintKey(pending.continuationActionKey, options);
          if (continuation) {
            return { ...continuation, onlineResolverDiagnostics: {
              accepted: true,
              reason: null,
              street: engine.street,
              utilitySamples: pending.samples,
              intervened: true,
              actionChanged: pending.continuationActionKey !== baseActionKey,
              baseActionKey,
              resolverActionKey: pending.continuationActionKey,
              advantageLowerBound: pending.lowerBound,
              policyTV: pending.continuationActionKey === baseActionKey ? 0 : 1,
              influence: pending.continuationActionKey === baseActionKey ? 0 : 1,
            } };
          }
        }
      }
      try {
        const observation = buildObservation(engine, player);
        const informationSetKey = buildBlueprintInfoSetKey(observation, {
          opts: observation.legalActions,
          maxRaisesPerStreet: 3,
        });
        const legalActionKeys = legalActions(options).map(actionToBlueprintKey).filter(Boolean);
        const bundle = tournamentSequencePolicy(policyPath);
        const prediction = evaluateTournamentSequencePolicy(bundle.policy, {
          informationSetKey,
          tableSize: engine.tableSize,
          baselineActionKey: baseActionKey,
          legalActionKeys,
        });
        const selected = prediction.selected;
        if (!prediction.accepted || baseActionKey === 'fold'
          || ['fold', 'allin'].includes(selected?.firstActionKey)
          || selected?.continuationActionKey === 'allin'
          || (!allowContinuationFold && selected?.continuationActionKey === 'fold')) {
          return { ...baseAction, onlineResolverDiagnostics: {
            accepted: false,
            reason: prediction.accepted
              ? `sequence-risk-transition-disabled:${baseActionKey}`
                + `>${selected?.firstActionKey}>${selected?.continuationActionKey}`
              : `sequence:${prediction.reason}`,
            street: engine.street,
            utilitySamples: 0,
            intervened: false,
            actionChanged: false,
            baseActionKey,
            resolverActionKey: baseActionKey,
          } };
        }
        const firstAction = actionFromBlueprintKey(selected.firstActionKey, options);
        if (!firstAction) throw new RangeError('sequence first action is not legal');
        states.set(player.idx, {
          round: engine.round,
          continuationActionKey: selected.continuationActionKey,
          lowerBound: selected.lowerBound,
          samples: selected.option.samples,
        });
        return { ...firstAction, onlineResolverDiagnostics: {
          accepted: true,
          reason: null,
          street: engine.street,
          utilitySamples: selected.option.samples,
          intervened: true,
          actionChanged: selected.firstActionKey !== baseActionKey,
          baseActionKey,
          resolverActionKey: selected.firstActionKey,
          advantageLowerBound: selected.lowerBound,
          policyTV: 1,
          influence: 1,
          trajectoryPolicySha256: bundle.sha256,
        } };
      } catch (error) {
        return { ...baseAction, onlineResolverDiagnostics: {
          accepted: false,
          reason: `sequence-error:${String(error?.message || error).slice(0, 140)}`,
          street: engine.street,
          utilitySamples: 0,
          intervened: false,
          actionChanged: false,
          baseActionKey,
          resolverActionKey: baseActionKey,
        } };
      }
    },
  });
}

export function evaluateConfirmationConfidenceCap(result, {
  pot,
  maxNormalizedConfirmationAdvantage = Infinity,
} = {}) {
  const cap = Number(maxNormalizedConfirmationAdvantage);
  const normalizedConfirmationAdvantage = result?.confirmation?.selected
    ? Number(result.confirmation.selected.lowerBound) / Math.max(1, Number(pot) || 0)
    : null;
  return Object.freeze({
    rejected: result?.accepted === true && Number.isFinite(cap)
      && Number.isFinite(normalizedConfirmationAdvantage)
      && normalizedConfirmationAdvantage > cap,
    normalizedConfirmationAdvantage,
    maxNormalizedConfirmationAdvantage: Number.isFinite(cap) ? cap : null,
  });
}

export function evaluateConfirmationConfidenceFloor(result, {
  pot,
  minNormalizedConfirmationAdvantage = -Infinity,
} = {}) {
  const floor = Number(minNormalizedConfirmationAdvantage);
  const normalizedConfirmationAdvantage = result?.confirmation?.selected
    ? Number(result.confirmation.selected.lowerBound) / Math.max(1, Number(pot) || 0)
    : null;
  return Object.freeze({
    rejected: result?.accepted === true && Number.isFinite(floor)
      && Number.isFinite(normalizedConfirmationAdvantage)
      && normalizedConfirmationAdvantage < floor,
    normalizedConfirmationAdvantage,
    minNormalizedConfirmationAdvantage: Number.isFinite(floor) ? floor : null,
  });
}

function onlineResolverStrategy({
  key,
  label,
  streets,
  seedNamespace,
  simulationBudget = 6,
  validationRolloutsPerCluster = 1,
  blockedActionKeys = [],
  confirmationClusterCount = 0,
  transferSelectorPath = null,
  transferResolverStrategyKey = null,
}) {
  return Object.freeze({
    key,
    label,
    description: 'Deterministic budgeted public subgame MCCFR with promoted tournament leaves.',
    style: aiStyle('tag'),
    supportsSkills: false,
    decide({ engine, player, options }) {
      const enabledStreets = new Set(
        typeof streets === 'function' ? streets(engine) : streets,
      );
      if (!enabledStreets.has(engine.street)) {
        const action = AI.decideWithBlueprint(engine, player, null);
        return { ...action, onlineResolverDiagnostics: {
          accepted: false,
          reason: 'street-disabled',
          street: engine.street,
          simulationBudget,
          utilitySamples: 0,
          intervened: false,
          actionChanged: false,
        } };
      }
      let transferBundle = null;
      if (transferSelectorPath) {
        try {
          transferBundle = realEngineTransferSelector(
            transferSelectorPath, transferResolverStrategyKey,
          );
        } catch {
          const action = AI.decideWithBlueprint(engine, player, null);
          return { ...action, onlineResolverDiagnostics: {
            accepted: false,
            reason: 'transfer-selector-unavailable',
            street: engine.street,
            simulationBudget,
            utilitySamples: 0,
            intervened: false,
            actionChanged: false,
          } };
        }
      }
      let result;
      let target;
      try {
        const observation = buildObservation(engine, player);
        target = buildOnlineResolverTarget(observation, { maxRaisesPerStreet: 3 });
        const bundle = formalTournamentValueBundle();
        result = solveOnlineResolverTarget(target, {
          tournamentValueModel: bundle.model,
          tournamentValueSource: bundle.source,
          tournamentValueModelText: bundle.modelText,
          tournamentValueReportText: bundle.reportText,
          simulationBudget,
          validationClusterCount: simulationBudget,
          validationRolloutsPerCluster,
          seedNamespace,
          maxRaisesPerStreet: 3,
        });
      } catch {
        const action = AI.decideWithBlueprint(engine, player, null);
        return { ...action, onlineResolverDiagnostics: {
          accepted: false,
          reason: 'resolver-error',
          street: engine.street,
          simulationBudget,
          utilitySamples: 0,
          intervened: false,
          actionChanged: false,
        } };
      }
      if (!result.checkpoint) {
        const action = AI.decideWithBlueprint(engine, player, null);
        return { ...action, onlineResolverDiagnostics: {
          ...result.diagnostics,
          street: engine.street,
          intervened: false,
          actionChanged: false,
        } };
      }
      const action = AI.decideWithBlueprint(engine, player, result.checkpoint, {
        // Independent CRN calibration, rather than the training visit count,
        // is the authority gate for an ephemeral solve. Once that LCB passes,
        // the resolver executes its frozen distribution without applying the
        // static-checkpoint confidence shrinkage a second time.
        blueprintMinVisits: 0,
        blueprintWeight: 1,
        blueprintMaxWeight: 1,
        blueprintForceIntervention: true,
        blueprintBlockedActionKeys: typeof blockedActionKeys === 'function'
          ? blockedActionKeys(engine) : blockedActionKeys,
      });
      const blueprint = AI.getLastDecisionDiagnostics(engine, player)?.blueprint;
      const baseActionKey = blueprint?.baseActionKey || null;
      const resolverActionKey = blueprint?.selectedActionKey
        || actionToBlueprintKey(action);
      let transferSelection = null;
      if (transferBundle && blueprint?.actionChanged === true) {
        transferSelection = evaluateRealEngineTransferSelector(transferBundle.selector, {
          informationSetKey: target?.targetKey,
          tableSize: engine.tableSize,
          baseActionKey,
          actionKey: resolverActionKey,
          tournamentValueSource: result.diagnostics?.tournamentValueSource,
        });
        if (!transferSelection.eligible) {
          const baseAction = actionFromBlueprintKey(baseActionKey, options);
          if (baseAction) {
            return { ...baseAction, onlineResolverDiagnostics: {
              ...result.diagnostics,
              accepted: false,
              reason: transferSelection.reason,
              street: engine.street,
              intervened: false,
              actionChanged: false,
              baseActionKey,
              resolverActionKey,
              advantageLowerBound: blueprint?.advantageLowerBound ?? null,
              influence: Number(blueprint?.influence) || 0,
              policyTV: Number(blueprint?.policyTV) || 0,
              transferSelectorSha256: transferBundle.sha256,
              transferSelection,
            } };
          }
        }
      }
      return { ...action, onlineResolverDiagnostics: {
        ...result.diagnostics,
        street: engine.street,
        intervened: blueprint?.intervened === true,
        actionChanged: blueprint?.actionChanged === true,
        advantagePassed: blueprint?.advantagePassed === true,
        influence: Number(blueprint?.influence) || 0,
        policyTV: Number(blueprint?.policyTV) || 0,
        advantageLowerBound: blueprint?.advantageLowerBound ?? null,
        baseActionKey,
        resolverActionKey,
        transferSelectorSha256: transferBundle?.sha256 || null,
        transferSelection,
      } };
    },
  });
}

function realEnginePolicyStrategy({
  key, label, selectorPath, blockedActionTransitions = null,
}) {
  return Object.freeze({
    key,
    label,
    description: 'QYZ with dual-LCB real-engine forced-branch policy improvement.',
    style: aiStyle('tag'),
    supportsSkills: false,
    decide({ engine, player, options }) {
      const baseAction = AI.decideWithBlueprint(engine, player, null);
      const baseActionKey = actionToBlueprintKey(baseAction);
      let bundle;
      try {
        bundle = realEngineTransferSelector(selectorPath, 'qyz-forced-branch-policy');
      } catch {
        return { ...baseAction, onlineResolverDiagnostics: {
          accepted: false, reason: 'engine-policy-selector-unavailable',
          street: engine.street, utilitySamples: 0, intervened: false,
          actionChanged: false, baseActionKey, resolverActionKey: baseActionKey,
        } };
      }
      const observation = buildObservation(engine, player);
      const informationSetKey = buildBlueprintInfoSetKey(observation, {
        opts: observation.legalActions,
        maxRaisesPerStreet: 3,
      });
      const alternatives = legalActions(options).map(actionToBlueprintKey)
        .filter((actionKey) => actionKey && actionKey !== baseActionKey
          && !(typeof blockedActionTransitions === 'function'
            && blockedActionTransitions({ engine, baseActionKey, actionKey })));
      const evaluations = alternatives.map((actionKey) => ({
        actionKey,
        selection: evaluateRealEngineTransferSelector(bundle.selector, {
          informationSetKey,
          tableSize: engine.tableSize,
          baseActionKey,
          actionKey,
        }),
      }));
      const eligible = evaluations.filter((entry) => entry.selection.eligible)
        .sort((left, right) => (
          right.selection.rankLowerBound - left.selection.rankLowerBound
          || right.selection.hpLowerBound - left.selection.hpLowerBound
          || left.actionKey.localeCompare(right.actionKey)
        ));
      const selected = eligible[0];
      const action = selected ? actionFromBlueprintKey(selected.actionKey, options) : null;
      if (!action) {
        const reasonCounts = {};
        for (const entry of evaluations) {
          const reason = String(entry.selection.reason || 'unknown');
          reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
        }
        const dominantReason = Object.entries(reasonCounts).sort((left, right) => (
          right[1] - left[1] || left[0].localeCompare(right[0])
        ))[0]?.[0] || 'unknown';
        return { ...baseAction, onlineResolverDiagnostics: {
          accepted: false,
          reason: `engine-policy-${dominantReason}`,
          street: engine.street,
          utilitySamples: 0,
          intervened: false,
          actionChanged: false,
          baseActionKey,
          resolverActionKey: baseActionKey,
          transferSelectorSha256: bundle.sha256,
          transferSelection: Object.freeze({ eligible: false, reasonCounts }),
        } };
      }
      return { ...action, onlineResolverDiagnostics: {
        accepted: true,
        reason: null,
        street: engine.street,
        utilitySamples: selected.selection.samples,
        intervened: true,
        actionChanged: true,
        baseActionKey,
        resolverActionKey: selected.actionKey,
        policyTV: 1,
        influence: 1,
        transferSelectorSha256: bundle.sha256,
        transferSelection: selected.selection,
      } };
    },
  });
}

function publicCausalPolicyStrategy({
  key,
  label,
  gatePath,
  targetResolverStrategyKey = 'online-resolver-v19-table-powered',
  streets = ['flop', 'turn', 'river'],
  z = 0.5,
  maxDistance = 2,
  minEffectiveClusters = 4,
  blockedActionTransitions = null,
}) {
  return Object.freeze({
    key,
    label,
    description: 'Low-latency public-feature policy distilled from paired real-Engine outcomes.',
    style: aiStyle('tag'),
    supportsSkills: false,
    decide({ engine, player, options }) {
      const baseAction = AI.decideWithBlueprint(engine, player, null);
      const baseActionKey = actionToBlueprintKey(baseAction);
      if (!streets.includes(engine.street)) {
        return { ...baseAction, onlineResolverDiagnostics: {
          accepted: false,
          reason: 'street-disabled',
          street: engine.street,
          utilitySamples: 0,
          intervened: false,
          actionChanged: false,
          baseActionKey,
          resolverActionKey: baseActionKey,
        } };
      }
      try {
        const observation = buildObservation(engine, player);
        const informationSetKey = buildBlueprintInfoSetKey(observation, {
          opts: observation.legalActions,
          maxRaisesPerStreet: 3,
        });
        const encoded = compactResidualFeatures(informationSetKey);
        const bundle = causalHarmGate(gatePath, targetResolverStrategyKey);
        const alternatives = legalActions(options).map(actionToBlueprintKey)
          .filter((actionKey) => actionKey && actionKey !== baseActionKey
            && !(typeof blockedActionTransitions === 'function'
              && blockedActionTransitions({ engine, baseActionKey, actionKey })));
        const evaluations = alternatives.map((actionKey) => {
          const local = evaluateCausalHarmGate(bundle.gate, {
            tableSize: engine.tableSize,
            street: engine.street,
            mask: encoded?.mask || '',
            features: encoded?.features || {},
            baseActionKey,
            actionKey,
            pot: observation.betting.pot,
            screen: null,
            confirmation: null,
          });
          const prediction = local.prediction;
          const hpLower = prediction?.available
            ? prediction.hp.mean - Number(z) * prediction.hp.standardError : -Infinity;
          const rankLower = prediction?.available
            ? prediction.rank.mean - Number(z) * prediction.rank.standardError : -Infinity;
          const eligible = local.eligible === true && prediction?.available === true
            && prediction.nearestDistance <= Number(maxDistance)
            && prediction.effectiveClusters >= Number(minEffectiveClusters)
            && hpLower >= 0 && rankLower >= 0;
          return Object.freeze({ actionKey, eligible, hpLower, rankLower, local });
        });
        const selected = evaluations.filter((entry) => entry.eligible)
          .sort((left, right) => right.rankLower - left.rankLower
            || right.hpLower - left.hpLower
            || left.actionKey.localeCompare(right.actionKey))[0];
        const action = selected ? actionFromBlueprintKey(selected.actionKey, options) : null;
        if (!action) {
          const reasonCounts = {};
          for (const entry of evaluations) {
            const reason = entry.local?.prediction?.reason
              || entry.local?.reason || 'positive-dual-lcb-not-cleared';
            reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
          }
          return { ...baseAction, onlineResolverDiagnostics: {
            accepted: false,
            reason: 'public-causal-positive-dual-lcb-not-cleared',
            street: engine.street,
            utilitySamples: 0,
            intervened: false,
            actionChanged: false,
            baseActionKey,
            resolverActionKey: baseActionKey,
            transferSelection: Object.freeze({ eligible: false, reasonCounts }),
          } };
        }
        return { ...action, onlineResolverDiagnostics: {
          accepted: true,
          reason: null,
          street: engine.street,
          utilitySamples: 0,
          intervened: true,
          actionChanged: true,
          baseActionKey,
          resolverActionKey: selected.actionKey,
          advantageLowerBound: selected.hpLower,
          policyTV: 1,
          influence: 1,
          transferSelectorSha256: bundle.sha256,
          transferSelection: Object.freeze({
            eligible: true,
            hpLower: selected.hpLower,
            rankLower: selected.rankLower,
            prediction: selected.local.prediction,
          }),
        } };
      } catch (error) {
        return { ...baseAction, onlineResolverDiagnostics: {
          accepted: false,
          reason: `public-causal-policy-error:${String(error?.message || error).slice(0, 120)}`,
          street: engine.street,
          utilitySamples: 0,
          intervened: false,
          actionChanged: false,
          baseActionKey,
          resolverActionKey: baseActionKey,
        } };
      }
    },
  });
}

function publicBeliefOptionStrategy({
  key,
  label,
  seedNamespace = 'qyj-v109-two-step-option',
  screenClusterCount = 12,
  confirmationClusterCount = 24,
  screenCandidateCount = 2,
  continuationModes = ['control', 'pressure'],
  allowPartialPlanFailures = false,
  minPlanValidRate = 1,
  screenHpGateStatistic = 'lowerBound',
  screenSurvivalGateStatistic = 'lowerBound',
}) {
  const optionContinuationModes = Object.freeze([...new Set(continuationModes)]);
  if (!optionContinuationModes.length || optionContinuationModes.some(
    (mode) => !['control', 'pressure', 'thin-value', 'polarized'].includes(mode),
  ) || !['lowerBound', 'mean'].includes(screenHpGateStatistic)
    || !['lowerBound', 'mean'].includes(screenSurvivalGateStatistic)) {
    throw new RangeError('invalid public-belief option screening configuration');
  }
  return Object.freeze({
    key,
    label,
    description: 'Two-step public-belief option jointly confirming root and next focal action.',
    style: aiStyle('tag'),
    supportsSkills: false,
    decide({ engine, player, options }) {
      const baseAction = AI.decideWithBlueprint(engine, player, null);
      const baseActionKey = actionToBlueprintKey(baseAction);
      const states = publicBeliefOptionStates(engine);
      let active = states.get(player.idx);
      if (active && active.round !== engine.round) {
        states.delete(player.idx);
        active = null;
      }
      if (active) {
        states.delete(player.idx);
        try {
          const action = choosePublicOptionContinuationAction(
            engine, player, active.continuationMode,
          );
          const actionKey = actionToBlueprintKey(action);
          return { ...action, onlineResolverDiagnostics: {
            accepted: true,
            reason: 'two-step-option-continuation',
            street: engine.street,
            utilitySamples: 0,
            intervened: true,
            actionChanged: actionKey !== baseActionKey,
            baseActionKey,
            resolverActionKey: actionKey,
            policyTV: actionKey === baseActionKey ? 0 : 1,
            influence: actionKey === baseActionKey ? 0 : 1,
            optionContinuation: true,
            optionStartStreet: active.startStreet,
            optionContinuationMode: active.continuationMode,
          } };
        } catch (error) {
          return { ...baseAction, onlineResolverDiagnostics: {
            accepted: false,
            reason: `two-step-option-continuation-error:${String(error?.message || error)}`,
            street: engine.street,
            utilitySamples: 0,
            intervened: false,
            actionChanged: false,
            baseActionKey,
            resolverActionKey: baseActionKey,
          } };
        }
      }
      if (!['flop', 'turn'].includes(engine.street)) {
        return { ...baseAction, onlineResolverDiagnostics: {
          accepted: false,
          reason: 'street-disabled',
          street: engine.street,
          utilitySamples: 0,
          intervened: false,
          actionChanged: false,
          baseActionKey,
          resolverActionKey: baseActionKey,
        } };
      }
      try {
        const observation = buildObservation(engine, player);
        const target = buildOnlineResolverTarget(observation, { maxRaisesPerStreet: 3 });
        const actionKeys = legalActions(options).map(actionToBlueprintKey).filter(
          (actionKey) => actionKey && (actionKey === baseActionKey
            || (actionKey !== 'fold' && actionKey !== 'allin')),
        );
        const basePlan = Object.freeze({
          id: `${baseActionKey}|qyz`, firstActionKey: baseActionKey, continuationMode: null,
        });
        const plans = [basePlan];
        for (const firstActionKey of actionKeys) {
          for (const continuationMode of optionContinuationModes) {
            plans.push(Object.freeze({
              id: `${firstActionKey}|${continuationMode}`,
              firstActionKey,
              continuationMode,
            }));
          }
        }
        const tournamentValueModel = formalTournamentValueBundle().model;
        const minAdvantage = Math.max(1, observation.betting.pot * 0.001);
        const screen = evaluatePublicBeliefOptionPlans(target, {
          basePlanId: basePlan.id,
          plans,
          seedNamespace: `${seedNamespace}|screen`,
          clusterCount: screenClusterCount,
          continuationMode: 'fast-public',
          continuationEquityScale: 0.08,
          continuationEquityFloor: 24,
          minAdvantage,
          tournamentValueModel,
          tournamentGateStatistic: 'mean',
          hpGateStatistic: screenHpGateStatistic,
          survivalGateStatistic: screenSurvivalGateStatistic,
          allowPartialPlanFailures,
          minPlanValidRate,
        });
        if (!screen.accepted) {
          return { ...baseAction, onlineResolverDiagnostics: {
            accepted: false,
            reason: `option-screen:${screen.reason}`,
            street: engine.street,
            utilitySamples: screen.utilitySamples,
            intervened: false,
            actionChanged: false,
            baseActionKey,
            resolverActionKey: baseActionKey,
            rollout: screen,
          } };
        }
        const selectedIds = new Set(screen.eligibleCandidates
          .slice(0, screenCandidateCount).map((candidate) => candidate.id));
        const confirmationPlans = plans.filter(
          (plan) => plan.id === basePlan.id || selectedIds.has(plan.id),
        );
        const confirmation = evaluatePublicBeliefOptionPlans(target, {
          basePlanId: basePlan.id,
          plans: confirmationPlans,
          seedNamespace: `${seedNamespace}|confirmation`,
          clusterCount: confirmationClusterCount,
          continuationMode: 'qyz',
          continuationEquityScale: 0.08,
          continuationEquityFloor: 24,
          minAdvantage,
          tournamentValueModel,
          tournamentGateStatistic: 'lowerBound',
          hpGateStatistic: 'lowerBound',
          survivalGateStatistic: 'lowerBound',
          allowPartialPlanFailures,
          minPlanValidRate,
        });
        if (!confirmation.accepted || !selectedIds.has(confirmation.selected.id)) {
          return { ...baseAction, onlineResolverDiagnostics: {
            accepted: false,
            reason: `option-confirmation:${confirmation.reason || 'candidate-mismatch'}`,
            street: engine.street,
            utilitySamples: screen.utilitySamples + confirmation.utilitySamples,
            intervened: false,
            actionChanged: false,
            baseActionKey,
            resolverActionKey: baseActionKey,
            rollout: Object.freeze({
              ...confirmation,
              screen,
              confirmation,
              clusterCount: screen.clusterCount + confirmation.clusterCount,
              utilitySamples: screen.utilitySamples + confirmation.utilitySamples,
            }),
          } };
        }
        const selected = confirmation.selected;
        const action = actionFromBlueprintKey(selected.firstActionKey, options);
        if (!action) throw new RangeError('confirmed option root action is not legal');
        states.set(player.idx, Object.freeze({
          round: engine.round,
          startStreet: engine.street,
          continuationMode: selected.continuationMode,
        }));
        const actionKey = actionToBlueprintKey(action);
        return { ...action, onlineResolverDiagnostics: {
          accepted: true,
          reason: null,
          street: engine.street,
          utilitySamples: screen.utilitySamples + confirmation.utilitySamples,
          intervened: true,
          actionChanged: actionKey !== baseActionKey,
          baseActionKey,
          resolverActionKey: actionKey,
          advantageLowerBound: selected.lowerBound,
          tournamentAdvantageLowerBound: selected.tournament.lowerBound,
          policyTV: actionKey === baseActionKey ? 0 : 1,
          influence: actionKey === baseActionKey ? 0 : 1,
          optionStarted: true,
          optionContinuationMode: selected.continuationMode,
          rollout: Object.freeze({
            ...confirmation,
            screen,
            confirmation,
            clusterCount: screen.clusterCount + confirmation.clusterCount,
            utilitySamples: screen.utilitySamples + confirmation.utilitySamples,
          }),
        } };
      } catch (error) {
        states.delete(player.idx);
        return { ...baseAction, onlineResolverDiagnostics: {
          accepted: false,
          reason: `public-belief-option-error:${String(error?.message || error).slice(0, 140)}`,
          street: engine.street,
          utilitySamples: 0,
          intervened: false,
          actionChanged: false,
          baseActionKey,
          resolverActionKey: baseActionKey,
        } };
      }
    },
  });
}

function publicBeliefRolloutStrategy({
  key,
  label,
  streets = ['flop', 'turn', 'river'],
  clusterCount = 6,
  seedNamespace,
  continuationEquityScale = 1,
  continuationEquityFloor = Config.AI_SIMS,
  continuationMode = 'qyz',
  blockedActionKeys = [],
  blockedActionTransitions = null,
  confirmationClusterCount = 0,
  screenCandidateCount = 1,
  maxNormalizedConfirmationAdvantage = Infinity,
  minNormalizedConfirmationAdvantage = -Infinity,
  screenUtilityMode = 'hp',
  confirmationUtilityMode = 'hp',
  tournamentRiskWeight = 0.25,
  minTournamentAdvantage = 0,
  screenTournamentGateStatistic = 'lowerBound',
  confirmationTournamentGateStatistic = 'lowerBound',
  minSurvivalAdvantage = 0,
  survivalGateStatistic = 'lowerBound',
  causalHarmGatePath = null,
  causalHarmTargetResolverStrategyKey = 'online-resolver-v19-table-powered',
  rolloutValueCalibratorPath = null,
  rolloutValueTargetResolverStrategyKey = 'online-resolver-v19-table-powered',
  minNormalizedRolloutAdvantage = 0.005,
  minRolloutValueRankPrediction = -Infinity,
  minRolloutValueHpPrediction = -Infinity,
  causalPositiveOverridePath = null,
  causalPositiveOverrideTargetResolverStrategyKey = 'online-resolver-v19-table-powered',
  causalPositiveOverrideZ = 0.5,
  causalPositiveOverrideMaxDistance = 2,
  causalPositiveOverrideMinEffectiveClusters = 4,
}) {
  return Object.freeze({
    key,
    label,
    description: 'Receding-horizon public-belief rollouts through a reconstructed no-skill Engine.',
    style: aiStyle('tag'),
    supportsSkills: false,
    decide({ engine, player, options }) {
      const baseAction = AI.decideWithBlueprint(engine, player, null);
      const baseActionKey = actionToBlueprintKey(baseAction);
      if (!streets.includes(engine.street)) {
        return { ...baseAction, onlineResolverDiagnostics: {
          accepted: false,
          reason: 'street-disabled',
          street: engine.street,
          utilitySamples: 0,
          intervened: false,
          actionChanged: false,
          baseActionKey,
          resolverActionKey: baseActionKey,
        } };
      }
      try {
        const observation = buildObservation(engine, player);
        const target = buildOnlineResolverTarget(observation, { maxRaisesPerStreet: 3 });
        const blocked = new Set(typeof blockedActionKeys === 'function'
          ? blockedActionKeys(engine) : blockedActionKeys);
        const actionKeys = legalActions(options).map(actionToBlueprintKey).filter(
          (actionKey) => actionKey && (actionKey === baseActionKey
            || (!blocked.has(actionKey) && !(typeof blockedActionTransitions === 'function'
              && blockedActionTransitions({
                engine,
                baseActionKey,
                actionKey,
              })))),
        );
        const resolvedClusterCount = Number(
          typeof clusterCount === 'function' ? clusterCount(engine) : clusterCount,
        ) || 0;
        const resolvedConfirmationClusterCount = Number(
          typeof confirmationClusterCount === 'function'
            ? confirmationClusterCount(engine) : confirmationClusterCount,
        ) || 0;
        const resolvedScreenUtilityMode = typeof screenUtilityMode === 'function'
          ? screenUtilityMode(engine) : screenUtilityMode;
        const resolvedConfirmationUtilityMode = typeof confirmationUtilityMode === 'function'
          ? confirmationUtilityMode(engine) : confirmationUtilityMode;
        const tournamentValueModel = resolvedScreenUtilityMode === 'dual-tournament'
          || resolvedScreenUtilityMode === 'triple-tournament-survival'
          || resolvedConfirmationUtilityMode === 'dual-tournament'
          || resolvedConfirmationUtilityMode === 'triple-tournament-survival'
          ? formalTournamentValueBundle().model : null;
        const resolvedScreenCandidateCount = Number(
          typeof screenCandidateCount === 'function'
            ? screenCandidateCount(engine) : screenCandidateCount,
        );
        const resolvedSeedNamespace = typeof seedNamespace === 'function'
          ? seedNamespace(engine) : seedNamespace;
        const resolvedMinNormalizedRolloutAdvantage = Number(
          typeof minNormalizedRolloutAdvantage === 'function'
            ? minNormalizedRolloutAdvantage(engine)
            : minNormalizedRolloutAdvantage,
        );
        const minRolloutAdvantage = Math.max(
          1,
          observation.betting.pot * (Number.isFinite(resolvedMinNormalizedRolloutAdvantage)
            ? resolvedMinNormalizedRolloutAdvantage
            : 0.005),
        );
        const result = resolvedConfirmationClusterCount > 0
          ? evaluateScreenedPublicBeliefRolloutActions(target, {
            baseActionKey,
            actionKeys,
            seedNamespace: resolvedSeedNamespace,
            screenClusterCount: resolvedClusterCount,
            confirmationClusterCount: resolvedConfirmationClusterCount,
            screenCandidateCount: resolvedScreenCandidateCount,
            beliefTemperature: 0.5,
            minAdvantage: minRolloutAdvantage,
            screenUtilityMode: resolvedScreenUtilityMode,
            confirmationUtilityMode: resolvedConfirmationUtilityMode,
            tournamentValueModel,
            tournamentRiskWeight,
            minTournamentAdvantage,
            screenTournamentGateStatistic,
            confirmationTournamentGateStatistic,
            minSurvivalAdvantage,
            survivalGateStatistic,
          })
          : evaluatePublicBeliefRolloutActions(target, {
          baseActionKey,
          actionKeys,
          seedNamespace: resolvedSeedNamespace,
          clusterCount: resolvedClusterCount,
          beliefTemperature: 0.5,
          minAdvantage: minRolloutAdvantage,
          continuationEquityScale,
          continuationEquityFloor,
          continuationMode,
          });
        const resolvedConfidenceCap = Number(
          typeof maxNormalizedConfirmationAdvantage === 'function'
            ? maxNormalizedConfirmationAdvantage(engine)
            : maxNormalizedConfirmationAdvantage,
        );
        const confidenceCalibration = evaluateConfirmationConfidenceCap(result, {
          pot: observation.betting.pot,
          maxNormalizedConfirmationAdvantage: resolvedConfidenceCap,
        });
        const resolvedConfidenceFloor = Number(
          typeof minNormalizedConfirmationAdvantage === 'function'
            ? minNormalizedConfirmationAdvantage(engine)
            : minNormalizedConfirmationAdvantage,
        );
        const confidenceFloorCalibration = evaluateConfirmationConfidenceFloor(result, {
          pot: observation.betting.pot,
          minNormalizedConfirmationAdvantage: resolvedConfidenceFloor,
        });
        if (confidenceFloorCalibration.rejected) {
          return { ...baseAction, onlineResolverDiagnostics: {
            accepted: false,
            reason: 'confirmation-confidence-floor-not-cleared',
            street: engine.street,
            utilitySamples: result.utilitySamples,
            intervened: false,
            actionChanged: false,
            baseActionKey,
            resolverActionKey: baseActionKey,
            proposedActionKey: result.actionKey,
            rollout: result,
            confidenceCalibration,
            confidenceFloorCalibration,
          } };
        }
        if (confidenceCalibration.rejected) {
          return { ...baseAction, onlineResolverDiagnostics: {
            accepted: false,
            reason: 'confirmation-confidence-tail-capped',
            street: engine.street,
            utilitySamples: result.utilitySamples,
            intervened: false,
            actionChanged: false,
            baseActionKey,
            resolverActionKey: baseActionKey,
            rollout: result,
            confidenceCalibration,
            confidenceFloorCalibration,
          } };
        }
        let realValueCalibration = null;
        let realValueBundle = null;
        let positiveOverrideCalibration = null;
        let positiveOverrideBundle = null;
        const resolvedRolloutValueCalibratorPath = typeof rolloutValueCalibratorPath
          === 'function' ? rolloutValueCalibratorPath(engine) : rolloutValueCalibratorPath;
        if (result.accepted && result.actionKey !== baseActionKey
          && resolvedRolloutValueCalibratorPath) {
          const informationSetKey = buildBlueprintInfoSetKey(observation, {
            opts: observation.legalActions,
            maxRaisesPerStreet: 3,
          });
          const encoded = compactResidualFeatures(informationSetKey);
          realValueBundle = rolloutValueCalibrator(
            resolvedRolloutValueCalibratorPath,
            rolloutValueTargetResolverStrategyKey,
          );
          const realValueRecord = {
            tableSize: engine.tableSize,
            street: engine.street,
            mask: encoded?.mask || '',
            features: encoded?.features || {},
            baseActionKey,
            actionKey: result.actionKey,
            pot: observation.betting.pot,
            screen: result.screen?.selected || null,
            confirmation: result.confirmation?.selected || null,
          };
          realValueCalibration = evaluateRolloutValueCalibrator(
            realValueBundle.calibrator,
            realValueRecord,
          );
          const resolvedMinRolloutValueRankPrediction = Number(
            typeof minRolloutValueRankPrediction === 'function'
              ? minRolloutValueRankPrediction(engine)
              : minRolloutValueRankPrediction,
          );
          if (realValueCalibration.eligible
            && Number.isFinite(resolvedMinRolloutValueRankPrediction)
            && realValueCalibration.prediction?.rank
              < resolvedMinRolloutValueRankPrediction) {
            realValueCalibration = Object.freeze({
              ...realValueCalibration,
              eligible: false,
              reason: 'real-engine-calibrated-value-not-cleared',
              rankPredictionFloor: resolvedMinRolloutValueRankPrediction,
            });
          }
          const resolvedMinRolloutValueHpPrediction = Number(
            typeof minRolloutValueHpPrediction === 'function'
              ? minRolloutValueHpPrediction(engine)
              : minRolloutValueHpPrediction,
          );
          if (realValueCalibration.eligible
            && Number.isFinite(resolvedMinRolloutValueHpPrediction)
            && realValueCalibration.prediction?.hp
              < resolvedMinRolloutValueHpPrediction) {
            realValueCalibration = Object.freeze({
              ...realValueCalibration,
              eligible: false,
              reason: 'real-engine-calibrated-value-not-cleared',
              hpPredictionFloor: resolvedMinRolloutValueHpPrediction,
            });
          }
          const resolvedCausalPositiveOverridePath = typeof causalPositiveOverridePath
            === 'function' ? causalPositiveOverridePath(engine) : causalPositiveOverridePath;
          if (!realValueCalibration.eligible
            && realValueCalibration.reason === 'real-engine-calibrated-value-not-cleared'
            && resolvedCausalPositiveOverridePath) {
            positiveOverrideBundle = causalHarmGate(
              resolvedCausalPositiveOverridePath,
              causalPositiveOverrideTargetResolverStrategyKey,
            );
            const local = evaluateCausalHarmGate(
              positiveOverrideBundle.gate,
              realValueRecord,
            );
            const localPrediction = local.prediction;
            const z = Number(causalPositiveOverrideZ);
            const hpLower = localPrediction?.available
              ? localPrediction.hp.mean - z * localPrediction.hp.standardError : -Infinity;
            const rankLower = localPrediction?.available
              ? localPrediction.rank.mean - z * localPrediction.rank.standardError : -Infinity;
            const eligible = local.eligible === true && localPrediction?.available === true
              && localPrediction.nearestDistance <= Number(causalPositiveOverrideMaxDistance)
              && localPrediction.effectiveClusters
                >= Number(causalPositiveOverrideMinEffectiveClusters)
              && hpLower >= 0 && rankLower >= 0;
            positiveOverrideCalibration = Object.freeze({
              eligible,
              reason: eligible ? null : 'local-positive-causal-evidence-not-cleared',
              hpLower,
              rankLower,
              local,
            });
          }
          if (!realValueCalibration.eligible && !positiveOverrideCalibration?.eligible) {
            return { ...baseAction, onlineResolverDiagnostics: {
              accepted: false,
              reason: realValueCalibration.reason,
              street: engine.street,
              utilitySamples: result.utilitySamples,
              intervened: false,
              actionChanged: false,
              baseActionKey,
              resolverActionKey: baseActionKey,
              proposedActionKey: result.actionKey,
              rollout: result,
              confidenceCalibration,
              confidenceFloorCalibration,
              realValueCalibration,
              rolloutValueCalibratorSha256: realValueBundle.sha256,
              positiveOverrideCalibration,
              causalPositiveOverrideSha256: positiveOverrideBundle?.sha256 || null,
            } };
          }
        }
        let harmGate = null;
        let harmGateBundle = null;
        if (result.accepted && result.actionKey !== baseActionKey && causalHarmGatePath) {
          const informationSetKey = buildBlueprintInfoSetKey(observation, {
            opts: observation.legalActions,
            maxRaisesPerStreet: 3,
          });
          const encoded = compactResidualFeatures(informationSetKey);
          harmGateBundle = causalHarmGate(
            causalHarmGatePath,
            causalHarmTargetResolverStrategyKey,
          );
          harmGate = evaluateCausalHarmGate(harmGateBundle.gate, {
            tableSize: engine.tableSize,
            street: engine.street,
            mask: encoded?.mask || '',
            features: encoded?.features || {},
            baseActionKey,
            actionKey: result.actionKey,
            pot: observation.betting.pot,
            screen: result.screen?.selected || null,
            confirmation: result.confirmation?.selected || null,
          });
          if (!harmGate.eligible) {
            return { ...baseAction, onlineResolverDiagnostics: {
              accepted: false,
              reason: harmGate.reason,
              street: engine.street,
              utilitySamples: result.utilitySamples,
              intervened: false,
              actionChanged: false,
              baseActionKey,
              resolverActionKey: baseActionKey,
              proposedActionKey: result.actionKey,
              rollout: result,
              confidenceCalibration,
              confidenceFloorCalibration,
              causalHarmGate: harmGate,
              causalHarmGateSha256: harmGateBundle.sha256,
            } };
          }
        }
        const action = result.accepted
          ? actionFromBlueprintKey(result.actionKey, options) : null;
        if (!action) {
          return { ...baseAction, onlineResolverDiagnostics: {
            accepted: false,
            reason: result.reason,
            street: engine.street,
            utilitySamples: result.utilitySamples,
            intervened: false,
            actionChanged: false,
            baseActionKey,
            resolverActionKey: baseActionKey,
            rollout: result,
            confidenceCalibration,
            confidenceFloorCalibration,
          } };
        }
        return { ...action, onlineResolverDiagnostics: {
          accepted: true,
          reason: null,
          street: engine.street,
          utilitySamples: result.utilitySamples,
          intervened: true,
          actionChanged: result.actionKey !== baseActionKey,
          baseActionKey,
          resolverActionKey: result.actionKey,
          advantageLowerBound: result.selected?.lowerBound ?? null,
          tournamentAdvantageLowerBound:
            result.selected?.tournament?.lowerBound ?? null,
          policyTV: result.actionKey === baseActionKey ? 0 : 1,
          influence: result.actionKey === baseActionKey ? 0 : 1,
          rollout: result,
          confidenceCalibration,
          confidenceFloorCalibration,
          realValueCalibration,
          rolloutValueCalibratorSha256: realValueBundle?.sha256 || null,
          positiveOverrideCalibration,
          causalPositiveOverrideSha256: positiveOverrideBundle?.sha256 || null,
          causalHarmGate: harmGate,
          causalHarmGateSha256: harmGateBundle?.sha256 || null,
        } };
      } catch (error) {
        const detail = String(error?.message || error?.name || 'unknown').slice(0, 160);
        return { ...baseAction, onlineResolverDiagnostics: {
          accepted: false,
          reason: `public-belief-rollout-error:${detail}`,
          street: engine.street,
          utilitySamples: 0,
          intervened: false,
          actionChanged: false,
          baseActionKey,
          resolverActionKey: baseActionKey,
        } };
      }
    },
  });
}

function confirmedRolloutStrategy({ key, label, selectorPath }) {
  return Object.freeze({
    key,
    label,
    description: 'Fresh-seed 24-cluster exact public-belief rollout interventions.',
    style: aiStyle('tag'),
    supportsSkills: false,
    decide({ engine, player, options }) {
      const baseAction = AI.decideWithBlueprint(engine, player, null);
      const baseActionKey = actionToBlueprintKey(baseAction);
      try {
        const observation = buildObservation(engine, player);
        const informationSetKey = buildBlueprintInfoSetKey(observation, {
          opts: observation.legalActions,
          maxRaisesPerStreet: 3,
        });
        const legalActionKeys = legalActions(options).map(actionToBlueprintKey).filter(Boolean);
        const bundle = confirmedRolloutSelector(selectorPath);
        const selection = evaluateConfirmedRolloutSelector(bundle.selector, {
          tableSize: engine.tableSize,
          informationSetKey,
          baseActionKey,
          legalActionKeys,
        });
        const action = selection.eligible
          ? actionFromBlueprintKey(selection.actionKey, options) : null;
        if (!action) return { ...baseAction, onlineResolverDiagnostics: {
          accepted: false,
          reason: selection.reason,
          street: engine.street,
          utilitySamples: 0,
          intervened: false,
          actionChanged: false,
          baseActionKey,
          resolverActionKey: baseActionKey,
          confirmedSelectorSha256: bundle.sha256,
        } };
        return { ...action, onlineResolverDiagnostics: {
          accepted: true,
          reason: null,
          street: engine.street,
          utilitySamples: selection.clusterCount,
          intervened: true,
          actionChanged: selection.actionKey !== baseActionKey,
          baseActionKey,
          resolverActionKey: selection.actionKey,
          advantageLowerBound: selection.lowerBound,
          policyTV: 1,
          influence: 1,
          confirmedSelectorSha256: bundle.sha256,
          confirmedSelection: selection,
        } };
      } catch {
        return { ...baseAction, onlineResolverDiagnostics: {
          accepted: false,
          reason: 'confirmed-rollout-selector-error',
          street: engine.street,
          utilitySamples: 0,
          intervened: false,
          actionChanged: false,
          baseActionKey,
          resolverActionKey: baseActionKey,
        } };
      }
    },
  });
}

const REGISTRY = new Map([
  ['online-resolver-v1', onlineResolverStrategy({
    key: 'online-resolver-v1',
    label: 'V53 Public-belief Online Resolver (offline candidate)',
    streets: ['preflop', 'flop', 'turn', 'river'],
    seedNamespace: 'qyj-v53-online-resolver',
  })],
  ['online-resolver-v2-postflop', onlineResolverStrategy({
    key: 'online-resolver-v2-postflop',
    label: 'V54 Postflop Public-belief Online Resolver (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    seedNamespace: 'qyj-v54-postflop-online-resolver',
  })],
  ['online-resolver-v3-deep-postflop', onlineResolverStrategy({
    key: 'online-resolver-v3-deep-postflop',
    label: 'V55 Deep Postflop Public-belief Online Resolver (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    seedNamespace: 'qyj-v55-deep-postflop-online-resolver',
    simulationBudget: 12,
    validationRolloutsPerCluster: 2,
  })],
  ['online-resolver-v4-no-new-allin', onlineResolverStrategy({
    key: 'online-resolver-v4-no-new-allin',
    label: 'V56 Deep Postflop Resolver without New All-ins (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    seedNamespace: 'qyj-v56-no-new-allin-online-resolver',
    simulationBudget: 12,
    validationRolloutsPerCluster: 2,
    blockedActionKeys: ['allin'],
  })],
  ['online-resolver-v5-late-streets', onlineResolverStrategy({
    key: 'online-resolver-v5-late-streets',
    label: 'V57 Turn/River Deep Public-belief Resolver (offline candidate)',
    streets: ['turn', 'river'],
    seedNamespace: 'qyj-v57-late-streets-online-resolver',
    simulationBudget: 12,
    validationRolloutsPerCluster: 2,
  })],
  ['online-resolver-v6-river-allin-only', onlineResolverStrategy({
    key: 'online-resolver-v6-river-allin-only',
    label: 'V58 6-max Resolver with River-only New All-ins (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    seedNamespace: 'qyj-v58-river-allin-only-resolver',
    simulationBudget: 12,
    validationRolloutsPerCluster: 2,
    blockedActionKeys: (engine) => (engine.street === 'river' ? [] : ['allin']),
  })],
  ['online-resolver-v7-table-specific', onlineResolverStrategy({
    key: 'online-resolver-v7-table-specific',
    label: 'V59 Table-specific Deep Public-belief Resolver (offline candidate)',
    streets: (engine) => (Number(engine.tableSize) >= 9
      ? ['turn', 'river'] : ['flop', 'turn', 'river']),
    seedNamespace: 'qyj-v59-table-specific-online-resolver',
    simulationBudget: 12,
    validationRolloutsPerCluster: 2,
    blockedActionKeys: (engine) => (
      Number(engine.tableSize) >= 9 || engine.street === 'river' ? [] : ['allin']
    ),
  })],
  ['online-resolver-v8-real-engine-transfer', onlineResolverStrategy({
    key: 'online-resolver-v8-real-engine-transfer',
    label: 'V60 Real-engine Transfer-gated Resolver (offline candidate)',
    streets: (engine) => (Number(engine.tableSize) >= 9
      ? ['turn', 'river'] : ['flop', 'turn', 'river']),
    seedNamespace: 'qyj-v59-table-specific-online-resolver',
    simulationBudget: 12,
    validationRolloutsPerCluster: 2,
    blockedActionKeys: (engine) => (
      Number(engine.tableSize) >= 9 || engine.street === 'river' ? [] : ['allin']
    ),
    transferSelectorPath: '../checkpoints/qyj-v60-real-engine-transfer-selector.json',
    transferResolverStrategyKey: 'online-resolver-v7-table-specific',
  })],
  ['online-resolver-v9-engine-policy', realEnginePolicyStrategy({
    key: 'online-resolver-v9-engine-policy',
    label: 'V61 Real-engine Forced-branch Policy (offline candidate)',
    selectorPath: '../checkpoints/qyj-v61-real-engine-policy-selector.json',
  })],
  ['online-resolver-v10-engine-rollout', publicBeliefRolloutStrategy({
    key: 'online-resolver-v10-engine-rollout',
    label: 'V62 Multi-step Public-belief Engine Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: 6,
    seedNamespace: 'qyj-v62-public-belief-engine-rollout',
  })],
  ['online-resolver-v11-confirmed-exact', confirmedRolloutStrategy({
    key: 'online-resolver-v11-confirmed-exact',
    label: 'V64 Confirmed Exact Engine Rollout (offline candidate)',
    selectorPath: '../checkpoints/qyj-v64-confirmed-rollout-selector.json',
  })],
  ['online-resolver-v12-light-engine-rollout', publicBeliefRolloutStrategy({
    key: 'online-resolver-v12-light-engine-rollout',
    label: 'V65 Lightweight Public-belief Engine Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: 4,
    seedNamespace: 'qyj-v65-light-public-belief-rollout',
    continuationEquityScale: 0.08,
    continuationEquityFloor: 24,
  })],
  ['online-resolver-v13-fast-engine-rollout', publicBeliefRolloutStrategy({
    key: 'online-resolver-v13-fast-engine-rollout',
    label: 'V66 Fast 24-cluster Public-belief Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: 24,
    seedNamespace: 'qyj-v66-fast-public-belief-rollout',
    continuationMode: 'fast-public',
    blockedActionKeys: ['allin'],
  })],
  ['online-resolver-v14-screened-engine-rollout', publicBeliefRolloutStrategy({
    key: 'online-resolver-v14-screened-engine-rollout',
    label: 'V67 Screened 24+8 Public-belief Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: 24,
    confirmationClusterCount: 8,
    seedNamespace: 'qyj-v67-screened-public-belief-rollout',
    blockedActionKeys: ['allin'],
  })],
  ['online-resolver-v15-screened-all-actions', publicBeliefRolloutStrategy({
    key: 'online-resolver-v15-screened-all-actions',
    label: 'V68 Screened 24+8 All-action Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: 24,
    confirmationClusterCount: 8,
    seedNamespace: 'qyj-v68-screened-all-action-rollout',
    blockedActionKeys: [],
  })],
  ['online-resolver-v16-screened-confirm16', publicBeliefRolloutStrategy({
    key: 'online-resolver-v16-screened-confirm16',
    label: 'V69 Screened 24+16 All-action Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: 24,
    confirmationClusterCount: 16,
    seedNamespace: 'qyj-v69-screened-confirm16-rollout',
    blockedActionKeys: [],
  })],
  ['online-resolver-v17-screened-confirm24', publicBeliefRolloutStrategy({
    key: 'online-resolver-v17-screened-confirm24',
    label: 'V70 Screened 24+24 All-action Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: 24,
    confirmationClusterCount: 24,
    seedNamespace: 'qyj-v70-screened-confirm24-rollout',
    blockedActionKeys: [],
  })],
  ['online-resolver-v18-table-confirmed', publicBeliefRolloutStrategy({
    key: 'online-resolver-v18-table-confirmed',
    label: 'V71 Table-adaptive 24+16/24 Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: 24,
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 24 : 16),
    seedNamespace: 'qyj-v71-table-adaptive-screened-rollout',
    blockedActionKeys: [],
  })],
  ['online-resolver-v19-table-powered', publicBeliefRolloutStrategy({
    key: 'online-resolver-v19-table-powered',
    label: 'V72 Table-powered 24/32+16/24 Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 24 : 16),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
  })],
  ['online-resolver-v20-confidence-capped', publicBeliefRolloutStrategy({
    key: 'online-resolver-v20-confidence-capped',
    label: 'V74 9-max Confidence-tail Capped Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 24 : 16),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
  })],
  ['online-resolver-v21-tournament-dual', publicBeliefRolloutStrategy({
    key: 'online-resolver-v21-tournament-dual',
    label: 'V75 HP + Tournament-value Dual-LCB Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 24 : 16),
    seedNamespace: 'qyj-v75-tournament-dual-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    confirmationUtilityMode: 'dual-tournament',
    tournamentRiskWeight: 0.25,
    minTournamentAdvantage: 0,
  })],
  ['online-resolver-v22-hp-survival', publicBeliefRolloutStrategy({
    key: 'online-resolver-v22-hp-survival',
    label: 'V76 HP + Hand-survival Dual-LCB Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 24 : 16),
    seedNamespace: 'qyj-v76-hp-survival-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    confirmationUtilityMode: 'hp-survival',
    minSurvivalAdvantage: 0,
  })],
  ['online-resolver-v23-hp-survival-mean', publicBeliefRolloutStrategy({
    key: 'online-resolver-v23-hp-survival-mean',
    label: 'V77 HP-LCB + No-extra-bust Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 24 : 16),
    seedNamespace: 'qyj-v77-hp-survival-mean-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    confirmationUtilityMode: 'hp-survival',
    minSurvivalAdvantage: 0,
    survivalGateStatistic: 'mean',
  })],
  ['online-resolver-v24-causal-harm-gated', publicBeliefRolloutStrategy({
    key: 'online-resolver-v24-causal-harm-gated',
    label: 'V78 Cluster-causal Harm-gated Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 24 : 16),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    causalHarmGatePath: '../checkpoints/qyj-v78-causal-harm-gate.json',
    causalHarmTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
  })],
  ['online-resolver-v25-confidence-floored', publicBeliefRolloutStrategy({
    key: 'online-resolver-v25-confidence-floored',
    label: 'V80 6-max Confirmation-floor Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 24 : 16),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    minNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? -Infinity : 0.0075
    ),
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
  })],
  ['online-resolver-v26-no-call-to-allin', publicBeliefRolloutStrategy({
    key: 'online-resolver-v26-no-call-to-allin',
    label: 'V81 No Call-to-All-in Escalation Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 24 : 16),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    blockedActionTransitions: ({ baseActionKey, actionKey }) => (
      baseActionKey === 'call' && actionKey === 'allin'
    ),
    minNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? -Infinity : 0.0075
    ),
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
  })],
  ['online-resolver-v27-table-risk-transitions', publicBeliefRolloutStrategy({
    key: 'online-resolver-v27-table-risk-transitions',
    label: 'V82 Table-specific Risk-transition Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 24 : 16),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    blockedActionTransitions: ({ engine, baseActionKey, actionKey }) => (
      (baseActionKey === 'call' && actionKey === 'allin')
      || (Number(engine.tableSize) >= 9
        && baseActionKey === 'check'
        && actionKey === 'allin'
        && engine.street !== 'turn')
    ),
    minNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? -Infinity : 0.0075
    ),
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
  })],
  ['online-resolver-v28-real-value-calibrated', publicBeliefRolloutStrategy({
    key: 'online-resolver-v28-real-value-calibrated',
    label: 'V83 Real-Engine Value-calibrated Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 24 : 16),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    rolloutValueCalibratorPath: '../checkpoints/qyj-v83-rollout-value-calibrator.json',
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
  })],
  ['online-resolver-v29-table-value-calibrated', publicBeliefRolloutStrategy({
    key: 'online-resolver-v29-table-value-calibrated',
    label: 'V84 Table-calibrated Real-Engine Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 24 : 16),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    rolloutValueCalibratorPath: '../checkpoints/qyj-v84-rollout-value-calibrator.json',
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
  })],
  ['online-resolver-v30-adaptive-value-calibrated', publicBeliefRolloutStrategy({
    key: 'online-resolver-v30-adaptive-value-calibrated',
    label: 'V85 Adaptive Real-Engine Value-calibrated Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 24 : 16),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    rolloutValueCalibratorPath: '../checkpoints/qyj-v85-rollout-value-calibrator.json',
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
  })],
  ['online-resolver-v31-expanded-recall', publicBeliefRolloutStrategy({
    key: 'online-resolver-v31-expanded-recall',
    label: 'V86 Expanded-recall Real-Engine Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 24 : 16),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: 0.0025,
    rolloutValueCalibratorPath: '../checkpoints/qyj-v86-rollout-value-calibrator.json',
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
  })],
  ['online-resolver-v32-refit-value-calibrated', publicBeliefRolloutStrategy({
    key: 'online-resolver-v32-refit-value-calibrated',
    label: 'V87 Refit Real-Engine Value-calibrated Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 24 : 16),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: 0.0025,
    rolloutValueCalibratorPath: '../checkpoints/qyj-v87-rollout-value-calibrator.json',
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
  })],
  ['online-resolver-v33-precision-confirmed', publicBeliefRolloutStrategy({
    key: 'online-resolver-v33-precision-confirmed',
    label: 'V88 Precision-confirmed Real-Engine Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 16),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: 0.0025,
    rolloutValueCalibratorPath: '../checkpoints/qyj-v86-rollout-value-calibrator.json',
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
  })],
  ['online-resolver-v34-dual-objective-recall', publicBeliefRolloutStrategy({
    key: 'online-resolver-v34-dual-objective-recall',
    label: 'V89 Dual-objective Expanded-recall Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 16),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.001 : 0.0025
    ),
    minRolloutValueRankPrediction: (engine) => (
      Number(engine.tableSize) >= 9 ? 0 : -Infinity
    ),
    rolloutValueCalibratorPath: '../checkpoints/qyj-v86-rollout-value-calibrator.json',
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
  })],
  ['online-resolver-v35-balanced-dual-objective', publicBeliefRolloutStrategy({
    key: 'online-resolver-v35-balanced-dual-objective',
    label: 'V90 Balanced Dual-objective Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 16),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.001 : 0.0025
    ),
    minRolloutValueRankPrediction: (engine) => (
      Number(engine.tableSize) >= 9 ? -0.04 : -Infinity
    ),
    rolloutValueCalibratorPath: '../checkpoints/qyj-v86-rollout-value-calibrator.json',
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
  })],
  ['online-resolver-v36-midpoint-dual-objective', publicBeliefRolloutStrategy({
    key: 'online-resolver-v36-midpoint-dual-objective',
    label: 'V91 Midpoint Dual-objective Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 16),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.001 : 0.0025
    ),
    minRolloutValueRankPrediction: (engine) => (
      Number(engine.tableSize) >= 9 ? -0.06 : -Infinity
    ),
    rolloutValueCalibratorPath: '../checkpoints/qyj-v86-rollout-value-calibrator.json',
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
  })],
  ['online-resolver-v37-transition-aware', publicBeliefRolloutStrategy({
    key: 'online-resolver-v37-transition-aware',
    label: 'V92 Transition-aware Real-Engine Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 16),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    blockedActionTransitions: ({ engine, baseActionKey, actionKey }) => (
      Number(engine.tableSize) >= 9
        && actionKey === 'raise:feint'
        && baseActionKey !== actionKey
    ),
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.001 : 0.0025
    ),
    rolloutValueCalibratorPath: '../checkpoints/qyj-v86-rollout-value-calibrator.json',
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
  })],
  ['online-resolver-v38-local-causal-override', publicBeliefRolloutStrategy({
    key: 'online-resolver-v38-local-causal-override',
    label: 'V93 Local-causal Positive-override Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 16),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.001 : 0.0025
    ),
    minRolloutValueRankPrediction: (engine) => (
      Number(engine.tableSize) >= 9 ? -0.06 : -Infinity
    ),
    rolloutValueCalibratorPath: '../checkpoints/qyj-v86-rollout-value-calibrator.json',
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverridePath: '../checkpoints/qyj-v93-local-causal-gate.json',
    causalPositiveOverrideTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverrideZ: 0.5,
    causalPositiveOverrideMaxDistance: 2,
    causalPositiveOverrideMinEffectiveClusters: 4,
  })],
  ['online-resolver-v39-table-isolated-causal', publicBeliefRolloutStrategy({
    key: 'online-resolver-v39-table-isolated-causal',
    label: 'V94 Table-isolated Local-causal Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 16),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.001 : 0.0025
    ),
    minRolloutValueRankPrediction: (engine) => (
      Number(engine.tableSize) >= 9 ? -0.06 : -Infinity
    ),
    rolloutValueCalibratorPath: '../checkpoints/qyj-v86-rollout-value-calibrator.json',
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverridePath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v93-local-causal-gate.json' : null
    ),
    causalPositiveOverrideTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverrideZ: 0.5,
    causalPositiveOverrideMaxDistance: 2,
    causalPositiveOverrideMinEffectiveClusters: 4,
  })],
  ['online-resolver-v40-dual-table-precision', publicBeliefRolloutStrategy({
    key: 'online-resolver-v40-dual-table-precision',
    label: 'V95 Dual-table Precision Local-causal Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: 0.001,
    minRolloutValueRankPrediction: (engine) => (
      Number(engine.tableSize) >= 9 ? -0.06 : -Infinity
    ),
    rolloutValueCalibratorPath: '../checkpoints/qyj-v86-rollout-value-calibrator.json',
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverridePath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v93-local-causal-gate.json' : null
    ),
    causalPositiveOverrideTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverrideZ: 0.5,
    causalPositiveOverrideMaxDistance: 2,
    causalPositiveOverrideMinEffectiveClusters: 4,
  })],
  ['online-resolver-v41-dual-table-hp-safe', publicBeliefRolloutStrategy({
    key: 'online-resolver-v41-dual-table-hp-safe',
    label: 'V96 Dual-table HP-safe Local-causal Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: 0.001,
    minRolloutValueRankPrediction: (engine) => (
      Number(engine.tableSize) >= 9 ? -0.06 : -Infinity
    ),
    minRolloutValueHpPrediction: (engine) => (
      Number(engine.tableSize) >= 9 ? -Infinity : -0.1
    ),
    rolloutValueCalibratorPath: '../checkpoints/qyj-v86-rollout-value-calibrator.json',
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverridePath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v93-local-causal-gate.json' : null
    ),
    causalPositiveOverrideTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverrideZ: 0.5,
    causalPositiveOverrideMaxDistance: 2,
    causalPositiveOverrideMinEffectiveClusters: 4,
  })],
  ['online-resolver-v42-dual-table-dual-safe', publicBeliefRolloutStrategy({
    key: 'online-resolver-v42-dual-table-dual-safe',
    label: 'V97 Dual-table Dual-safe Local-causal Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: 0.001,
    minRolloutValueRankPrediction: (engine) => (
      Number(engine.tableSize) >= 9 ? -0.06 : -0.04
    ),
    minRolloutValueHpPrediction: (engine) => (
      Number(engine.tableSize) >= 9 ? -Infinity : -0.1
    ),
    rolloutValueCalibratorPath: '../checkpoints/qyj-v86-rollout-value-calibrator.json',
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverridePath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v93-local-causal-gate.json' : null
    ),
    causalPositiveOverrideTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverrideZ: 0.5,
    causalPositiveOverrideMaxDistance: 2,
    causalPositiveOverrideMinEffectiveClusters: 4,
  })],
  ['online-resolver-v43-table-specific-calibrators', publicBeliefRolloutStrategy({
    key: 'online-resolver-v43-table-specific-calibrators',
    label: 'V98 Table-specific Real-Engine Calibrators (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    seedNamespace: 'qyj-v72-table-powered-screened-rollout',
    blockedActionKeys: [],
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: 0.001,
    minRolloutValueRankPrediction: (engine) => (
      Number(engine.tableSize) >= 9 ? -0.06 : -Infinity
    ),
    rolloutValueCalibratorPath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v86-rollout-value-calibrator.json'
        : '../checkpoints/qyj-v98-rollout-value-calibrator.json'
    ),
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverridePath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v93-local-causal-gate.json' : null
    ),
    causalPositiveOverrideTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverrideZ: 0.5,
    causalPositiveOverrideMaxDistance: 2,
    causalPositiveOverrideMinEffectiveClusters: 4,
  })],
  ['online-resolver-v44-dual-stage-tournament', publicBeliefRolloutStrategy({
    key: 'online-resolver-v44-dual-stage-tournament',
    label: 'V99 Dual-stage Tournament-aware Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    seedNamespace: 'qyj-v99-dual-stage-tournament-rollout',
    blockedActionKeys: [],
    blockedActionTransitions: ({ engine, baseActionKey, actionKey }) => (
      Number(engine.tableSize) < 9
        && baseActionKey === 'call' && actionKey === 'allin'
    ),
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: 0.001,
    screenUtilityMode: (engine) => (
      Number(engine.tableSize) >= 9 ? 'hp' : 'dual-tournament'
    ),
    confirmationUtilityMode: (engine) => (
      Number(engine.tableSize) >= 9 ? 'hp' : 'dual-tournament'
    ),
    tournamentRiskWeight: 0.25,
    minTournamentAdvantage: 0,
    minRolloutValueRankPrediction: (engine) => (
      Number(engine.tableSize) >= 9 ? -0.06 : -Infinity
    ),
    rolloutValueCalibratorPath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v86-rollout-value-calibrator.json' : null
    ),
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverridePath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v93-local-causal-gate.json' : null
    ),
    causalPositiveOverrideTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverrideZ: 0.5,
    causalPositiveOverrideMaxDistance: 2,
    causalPositiveOverrideMinEffectiveClusters: 4,
  })],
  ['online-resolver-v45-mean-screen-tournament', publicBeliefRolloutStrategy({
    key: 'online-resolver-v45-mean-screen-tournament',
    label: 'V100 Mean-screen Tournament-confirmed Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    seedNamespace: 'qyj-v100-mean-screen-tournament-rollout',
    blockedActionKeys: [],
    blockedActionTransitions: ({ engine, baseActionKey, actionKey }) => (
      Number(engine.tableSize) < 9
        && baseActionKey === 'call' && actionKey === 'allin'
    ),
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: 0.001,
    screenUtilityMode: (engine) => (
      Number(engine.tableSize) >= 9 ? 'hp' : 'dual-tournament'
    ),
    confirmationUtilityMode: (engine) => (
      Number(engine.tableSize) >= 9 ? 'hp' : 'dual-tournament'
    ),
    screenTournamentGateStatistic: 'mean',
    confirmationTournamentGateStatistic: 'lowerBound',
    tournamentRiskWeight: 0.25,
    minTournamentAdvantage: 0,
    minRolloutValueRankPrediction: (engine) => (
      Number(engine.tableSize) >= 9 ? -0.06 : -Infinity
    ),
    rolloutValueCalibratorPath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v86-rollout-value-calibrator.json' : null
    ),
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverridePath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v93-local-causal-gate.json' : null
    ),
    causalPositiveOverrideTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverrideZ: 0.5,
    causalPositiveOverrideMaxDistance: 2,
    causalPositiveOverrideMinEffectiveClusters: 4,
  })],
  ['online-resolver-v46-top2-tournament-confirmed', publicBeliefRolloutStrategy({
    key: 'online-resolver-v46-top2-tournament-confirmed',
    label: 'V101 Top-2 Tournament-confirmed Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    screenCandidateCount: 2,
    seedNamespace: 'qyj-v101-top2-tournament-confirmed-rollout',
    blockedActionKeys: [],
    blockedActionTransitions: ({ engine, baseActionKey, actionKey }) => (
      Number(engine.tableSize) < 9
        && baseActionKey === 'call' && actionKey === 'allin'
    ),
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: 0.001,
    screenUtilityMode: (engine) => (
      Number(engine.tableSize) >= 9 ? 'hp' : 'dual-tournament'
    ),
    confirmationUtilityMode: (engine) => (
      Number(engine.tableSize) >= 9 ? 'hp' : 'dual-tournament'
    ),
    screenTournamentGateStatistic: 'mean',
    confirmationTournamentGateStatistic: 'lowerBound',
    tournamentRiskWeight: 0.25,
    minTournamentAdvantage: 0,
    minRolloutValueRankPrediction: (engine) => (
      Number(engine.tableSize) >= 9 ? -0.06 : -Infinity
    ),
    rolloutValueCalibratorPath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v86-rollout-value-calibrator.json' : null
    ),
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverridePath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v93-local-causal-gate.json' : null
    ),
    causalPositiveOverrideTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverrideZ: 0.5,
    causalPositiveOverrideMaxDistance: 2,
    causalPositiveOverrideMinEffectiveClusters: 4,
  })],
  ['online-resolver-v47-triple-value-confirmed', publicBeliefRolloutStrategy({
    key: 'online-resolver-v47-triple-value-confirmed',
    label: 'V102 HP/Tournament/Survival-confirmed Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    screenCandidateCount: (engine) => (Number(engine.tableSize) >= 9 ? 1 : 2),
    seedNamespace: (engine) => (Number(engine.tableSize) >= 9
      ? 'qyj-v72-table-powered-screened-rollout'
      : 'qyj-v102-triple-value-confirmed-rollout'),
    blockedActionKeys: [],
    blockedActionTransitions: ({ engine, baseActionKey, actionKey }) => (
      Number(engine.tableSize) < 9
        && baseActionKey === 'call' && actionKey === 'allin'
    ),
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: 0.001,
    screenUtilityMode: (engine) => (
      Number(engine.tableSize) >= 9 ? 'hp' : 'dual-tournament'
    ),
    confirmationUtilityMode: (engine) => (
      Number(engine.tableSize) >= 9 ? 'hp' : 'triple-tournament-survival'
    ),
    screenTournamentGateStatistic: 'mean',
    confirmationTournamentGateStatistic: 'lowerBound',
    tournamentRiskWeight: 0.25,
    minTournamentAdvantage: 0,
    minSurvivalAdvantage: 0,
    survivalGateStatistic: 'lowerBound',
    minRolloutValueRankPrediction: (engine) => (
      Number(engine.tableSize) >= 9 ? -0.06 : -Infinity
    ),
    rolloutValueCalibratorPath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v86-rollout-value-calibrator.json' : null
    ),
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverridePath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v93-local-causal-gate.json' : null
    ),
    causalPositiveOverrideTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverrideZ: 0.5,
    causalPositiveOverrideMaxDistance: 2,
    causalPositiveOverrideMinEffectiveClusters: 4,
  })],
  ['online-resolver-v48-risk-bounded-top3', publicBeliefRolloutStrategy({
    key: 'online-resolver-v48-risk-bounded-top3',
    label: 'V103 Risk-bounded Top-3 Triple-confirmed Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    screenCandidateCount: (engine) => (Number(engine.tableSize) >= 9 ? 1 : 3),
    seedNamespace: (engine) => (Number(engine.tableSize) >= 9
      ? 'qyj-v72-table-powered-screened-rollout'
      : 'qyj-v103-risk-bounded-top3-rollout'),
    blockedActionKeys: (engine) => (Number(engine.tableSize) >= 9 ? [] : ['allin']),
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: 0.001,
    screenUtilityMode: (engine) => (
      Number(engine.tableSize) >= 9 ? 'hp' : 'dual-tournament'
    ),
    confirmationUtilityMode: (engine) => (
      Number(engine.tableSize) >= 9 ? 'hp' : 'triple-tournament-survival'
    ),
    screenTournamentGateStatistic: 'mean',
    confirmationTournamentGateStatistic: 'lowerBound',
    tournamentRiskWeight: 0.25,
    minTournamentAdvantage: 0,
    minSurvivalAdvantage: 0,
    survivalGateStatistic: 'lowerBound',
    minRolloutValueRankPrediction: (engine) => (
      Number(engine.tableSize) >= 9 ? -0.06 : -Infinity
    ),
    rolloutValueCalibratorPath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v86-rollout-value-calibrator.json' : null
    ),
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverridePath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v93-local-causal-gate.json' : null
    ),
    causalPositiveOverrideTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverrideZ: 0.5,
    causalPositiveOverrideMaxDistance: 2,
    causalPositiveOverrideMinEffectiveClusters: 4,
  })],
  ['online-resolver-v49-river-allin-top3', publicBeliefRolloutStrategy({
    key: 'online-resolver-v49-river-allin-top3',
    label: 'V104 River-only All-in Top-3 Triple-confirmed Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    screenCandidateCount: (engine) => (Number(engine.tableSize) >= 9 ? 1 : 3),
    seedNamespace: (engine) => (Number(engine.tableSize) >= 9
      ? 'qyj-v72-table-powered-screened-rollout'
      : 'qyj-v104-river-allin-top3-rollout'),
    blockedActionKeys: (engine) => (
      Number(engine.tableSize) < 9 && engine.street !== 'river' ? ['allin'] : []
    ),
    blockedActionTransitions: ({ engine, baseActionKey, actionKey }) => (
      Number(engine.tableSize) < 9
        && baseActionKey === 'call' && actionKey === 'allin'
    ),
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: 0.001,
    screenUtilityMode: (engine) => (
      Number(engine.tableSize) >= 9 ? 'hp' : 'dual-tournament'
    ),
    confirmationUtilityMode: (engine) => (
      Number(engine.tableSize) >= 9 ? 'hp' : 'triple-tournament-survival'
    ),
    screenTournamentGateStatistic: 'mean',
    confirmationTournamentGateStatistic: 'lowerBound',
    tournamentRiskWeight: 0.25,
    minTournamentAdvantage: 0,
    minSurvivalAdvantage: 0,
    survivalGateStatistic: 'lowerBound',
    minRolloutValueRankPrediction: (engine) => (
      Number(engine.tableSize) >= 9 ? -0.06 : -Infinity
    ),
    rolloutValueCalibratorPath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v86-rollout-value-calibrator.json' : null
    ),
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverridePath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v93-local-causal-gate.json' : null
    ),
    causalPositiveOverrideTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverrideZ: 0.5,
    causalPositiveOverrideMaxDistance: 2,
    causalPositiveOverrideMinEffectiveClusters: 4,
  })],
  ['online-resolver-v50-precision-top4', publicBeliefRolloutStrategy({
    key: 'online-resolver-v50-precision-top4',
    label: 'V105 32-cluster Precision Top-4 Triple-confirmed Rollout (offline candidate)',
    streets: ['flop', 'turn', 'river'],
    clusterCount: (engine) => (Number(engine.tableSize) >= 9 ? 32 : 24),
    confirmationClusterCount: 32,
    screenCandidateCount: (engine) => (Number(engine.tableSize) >= 9 ? 1 : 4),
    seedNamespace: (engine) => (Number(engine.tableSize) >= 9
      ? 'qyj-v72-table-powered-screened-rollout'
      : 'qyj-v105-precision-top4-rollout'),
    blockedActionKeys: (engine) => (
      Number(engine.tableSize) < 9 && engine.street !== 'river' ? ['allin'] : []
    ),
    blockedActionTransitions: ({ engine, baseActionKey, actionKey }) => (
      Number(engine.tableSize) < 9
        && baseActionKey === 'call' && actionKey === 'allin'
    ),
    maxNormalizedConfirmationAdvantage: (engine) => (
      Number(engine.tableSize) >= 9 ? 0.125 : Infinity
    ),
    minNormalizedRolloutAdvantage: 0.001,
    screenUtilityMode: (engine) => (
      Number(engine.tableSize) >= 9 ? 'hp' : 'dual-tournament'
    ),
    confirmationUtilityMode: (engine) => (
      Number(engine.tableSize) >= 9 ? 'hp' : 'triple-tournament-survival'
    ),
    screenTournamentGateStatistic: 'mean',
    confirmationTournamentGateStatistic: 'lowerBound',
    tournamentRiskWeight: 0.25,
    minTournamentAdvantage: 0,
    minSurvivalAdvantage: 0,
    survivalGateStatistic: 'lowerBound',
    minRolloutValueRankPrediction: (engine) => (
      Number(engine.tableSize) >= 9 ? -0.06 : -Infinity
    ),
    rolloutValueCalibratorPath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v86-rollout-value-calibrator.json' : null
    ),
    rolloutValueTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverridePath: (engine) => (
      Number(engine.tableSize) >= 9
        ? '../checkpoints/qyj-v93-local-causal-gate.json' : null
    ),
    causalPositiveOverrideTargetResolverStrategyKey: 'online-resolver-v19-table-powered',
    causalPositiveOverrideZ: 0.5,
    causalPositiveOverrideMaxDistance: 2,
    causalPositiveOverrideMinEffectiveClusters: 4,
  })],
  ['online-resolver-v51-public-causal-direct', publicCausalPolicyStrategy({
    key: 'online-resolver-v51-public-causal-direct',
    label: 'V106 Direct Public-causal Dual-LCB Policy (offline candidate)',
    gatePath: '../checkpoints/qyj-v93-local-causal-gate.json',
    targetResolverStrategyKey: 'online-resolver-v19-table-powered',
    z: 0.5,
    maxDistance: 2,
    minEffectiveClusters: 4,
    blockedActionTransitions: ({ engine, baseActionKey, actionKey }) => (
      Number(engine.tableSize) < 9 && (
        (engine.street !== 'river' && actionKey === 'allin')
        || (baseActionKey === 'call' && actionKey === 'allin')
      )
    ),
  })],
  ['online-resolver-v52-bounded-public-causal', publicCausalPolicyStrategy({
    key: 'online-resolver-v52-bounded-public-causal',
    label: 'V107 Bounded Direct Public-causal Policy (offline candidate)',
    gatePath: '../checkpoints/qyj-v93-local-causal-gate.json',
    targetResolverStrategyKey: 'online-resolver-v19-table-powered',
    z: 0.75,
    maxDistance: 1.5,
    minEffectiveClusters: 4,
    blockedActionTransitions: ({ actionKey }) => (
      actionKey === 'fold' || actionKey === 'allin'
    ),
  })],
  ['online-resolver-v53-expanded-engine-policy', realEnginePolicyStrategy({
    key: 'online-resolver-v53-expanded-engine-policy',
    label: 'V108 Expanded Real-engine Dual-LCB Policy (offline candidate)',
    selectorPath: '../checkpoints/qyj-v108-real-engine-policy-selector.json',
    blockedActionTransitions: ({ engine, actionKey }) => (
      Number(engine.tableSize) < 9 && (actionKey === 'fold' || actionKey === 'allin')
    ),
  })],
  ['online-resolver-v54-two-step-option', publicBeliefOptionStrategy({
    key: 'online-resolver-v54-two-step-option',
    label: 'V109 Two-step Public-belief Option (offline candidate)',
    seedNamespace: 'qyj-v109-two-step-option',
    screenClusterCount: 12,
    confirmationClusterCount: 24,
    screenCandidateCount: 2,
  })],
  ['online-resolver-v55-contextual-option', publicBeliefOptionStrategy({
    key: 'online-resolver-v55-contextual-option',
    label: 'V110 Contextual Two-step Public-belief Option (offline candidate)',
    seedNamespace: 'qyj-v110-contextual-option',
    screenClusterCount: 12,
    confirmationClusterCount: 24,
    screenCandidateCount: 3,
    continuationModes: ['control', 'thin-value', 'polarized'],
  })],
  ['online-resolver-v56-robust-contextual-option', publicBeliefOptionStrategy({
    key: 'online-resolver-v56-robust-contextual-option',
    label: 'V111 Robust Contextual Public-belief Option (offline candidate)',
    seedNamespace: 'qyj-v111-robust-contextual-option',
    screenClusterCount: 12,
    confirmationClusterCount: 24,
    screenCandidateCount: 3,
    continuationModes: ['control', 'thin-value', 'polarized'],
    allowPartialPlanFailures: true,
    minPlanValidRate: 0.9,
  })],
  ['online-resolver-v57-mean-screened-option', publicBeliefOptionStrategy({
    key: 'online-resolver-v57-mean-screened-option',
    label: 'V112 Mean-screened Strict-confirm Option (offline candidate)',
    seedNamespace: 'qyj-v112-mean-screened-option',
    screenClusterCount: 12,
    confirmationClusterCount: 24,
    screenCandidateCount: 3,
    continuationModes: ['control', 'thin-value', 'polarized'],
    allowPartialPlanFailures: true,
    minPlanValidRate: 0.9,
    screenHpGateStatistic: 'mean',
    screenSurvivalGateStatistic: 'mean',
  })],
  ['online-resolver-v58-tournament-trajectory-policy', tournamentTrajectoryStrategy({
    key: 'online-resolver-v58-tournament-trajectory-policy',
    label: 'V118 Complete-tournament Trajectory Policy (offline candidate)',
    policyPath: '../checkpoints/qyj-v118-tournament-trajectory-policy.json',
  })],
  ['online-resolver-v59-propensity-trajectory-policy', tournamentTrajectoryStrategy({
    key: 'online-resolver-v59-propensity-trajectory-policy',
    label: 'V120 Propensity-corrected Tournament Policy (offline candidate)',
    policyPath: '../checkpoints/qyj-v120-propensity-trajectory-policy.json',
  })],
  ['online-resolver-v60-propensity-mean-policy', tournamentTrajectoryStrategy({
    key: 'online-resolver-v60-propensity-mean-policy',
    label: 'V121 Propensity Mean-advantage Policy (offline candidate)',
    policyPath: '../checkpoints/qyj-v121-propensity-mean-policy.json',
  })],
  ['online-resolver-v61-rank-survival-policy', tournamentTrajectoryStrategy({
    key: 'online-resolver-v61-rank-survival-policy',
    label: 'V122 Rank-survival Propensity Policy (offline candidate)',
    policyPath: '../checkpoints/qyj-v122-rank-survival-policy.json',
    blockedActionTransitions: ({ baseActionKey }) => baseActionKey === 'fold',
  })],
  ['online-resolver-v62-audited-trajectory-policy', tournamentTrajectoryStrategy({
    key: 'online-resolver-v62-audited-trajectory-policy',
    label: 'V123 Forced-branch Audited Trajectory Policy (offline candidate)',
    policyPath: '../checkpoints/qyj-v122-rank-survival-policy.json',
    blockedActionTransitions: ({ baseActionKey, actionKey }) => !(
      baseActionKey === 'raise:strike' && actionKey === 'raise:feint'
    ),
  })],
  ['online-resolver-v63-tournament-sequence-policy', tournamentSequenceStrategy({
    key: 'online-resolver-v63-tournament-sequence-policy',
    label: 'V124 Two-decision Tournament Sequence Policy (offline candidate)',
    policyPath: '../checkpoints/qyj-v124-tournament-sequence-policy.json',
  })],
  ['online-resolver-v64-rank-sequence-policy', tournamentSequenceStrategy({
    key: 'online-resolver-v64-rank-sequence-policy',
    label: 'V125 Rank-survival Two-decision Sequence Policy (offline candidate)',
    policyPath: '../checkpoints/qyj-v125-rank-sequence-policy.json',
  })],
  ['online-resolver-v65-controlled-fold-sequence', tournamentSequenceStrategy({
    key: 'online-resolver-v65-controlled-fold-sequence',
    label: 'V126 Controlled-fold Rank Sequence Policy (offline candidate)',
    policyPath: '../checkpoints/qyj-v125-rank-sequence-policy.json',
    allowContinuationFold: true,
  })],
  ['online-resolver-v66-reach-calibrated-sequence', tournamentSequenceStrategy({
    key: 'online-resolver-v66-reach-calibrated-sequence',
    label: 'V127 Reach-calibrated Controlled-fold Sequence (offline candidate)',
    policyPath: '../checkpoints/qyj-v127-reach-sequence-policy.json',
    allowContinuationFold: true,
  })],
  ['online-resolver-v67-tournament-linear-ensemble', tournamentLinearEnsembleStrategy({
    key: 'online-resolver-v67-tournament-linear-ensemble',
    label: 'V140 Tournament Linear Ensemble (offline candidate)',
    modelPath: '../checkpoints/qyj-v140-linear-ensemble-6.json',
  })],
  ['online-resolver-v68-causal-calibrated-linear', tournamentLinearEnsembleStrategy({
    key: 'online-resolver-v68-causal-calibrated-linear',
    label: 'V141 Causal-calibrated Tournament Linear Ensemble (offline candidate)',
    modelPath: '../checkpoints/qyj-v140-linear-ensemble-6.json',
    causalHarmGatePath: '../checkpoints/qyj-v93-local-causal-gate.json',
  })],
  ['online-resolver-v69-flop-causal-linear', tournamentLinearEnsembleStrategy({
    key: 'online-resolver-v69-flop-causal-linear',
    label: 'V142 Flop-only Causal Tournament Linear Ensemble (offline candidate)',
    modelPath: '../checkpoints/qyj-v140-linear-ensemble-6.json',
    causalHarmGatePath: '../checkpoints/qyj-v93-local-causal-gate.json',
    streets: ['flop'],
  })],
  ['online-resolver-v70-flop-turn-causal-linear', tournamentLinearEnsembleStrategy({
    key: 'online-resolver-v70-flop-turn-causal-linear',
    label: 'V143 Flop/Turn Causal Tournament Linear Ensemble (offline candidate)',
    modelPath: '../checkpoints/qyj-v140-linear-ensemble-6.json',
    causalHarmGatePath: '../checkpoints/qyj-v93-local-causal-gate.json',
    streets: ['flop', 'turn'],
  })],
  ['online-resolver-v71-pairwise-ips-ensemble', tournamentPairwiseIpsStrategy({
    key: 'online-resolver-v71-pairwise-ips-ensemble',
    label: 'V144 Pairwise IPS Tournament Ensemble (offline candidate)',
    modelPath: '../checkpoints/qyj-v144-pairwise-ips-6.json',
  })],
  ['online-resolver-v72-pairwise-ips-24g', tournamentPairwiseIpsStrategy({
    key: 'online-resolver-v72-pairwise-ips-24g',
    label: 'V145 24-group Pairwise IPS Tournament Ensemble (offline candidate)',
    modelPath: '../checkpoints/qyj-v145-pairwise-ips-24g-6.json',
  })],
  ['online-resolver-v73-pairwise-jackknife-24g', tournamentPairwiseIpsStrategy({
    key: 'online-resolver-v73-pairwise-jackknife-24g',
    label: 'V146 24-group Pairwise Jackknife IPS (offline candidate)',
    modelPath: '../checkpoints/qyj-v146-pairwise-jackknife-24g-6.json',
    jackknife: true,
  })],
  ['online-resolver-v74-pairwise-jackknife-48g', tournamentPairwiseIpsStrategy({
    key: 'online-resolver-v74-pairwise-jackknife-48g',
    label: 'V147 48-group Pairwise Jackknife IPS (offline candidate)',
    modelPath: '../checkpoints/qyj-v147-pairwise-jackknife-48g-6.json',
    jackknife: true,
  })],
  ['online-resolver-evolution-candidate', tournamentEvolutionStrategy({
    key: 'online-resolver-evolution-candidate',
    label: 'Tournament Evolution Candidate (injected offline model)',
  })],
  ['online-resolver-v75-tournament-evolution', tournamentEvolutionStrategy({
    key: 'online-resolver-v75-tournament-evolution',
    label: 'V148 Complete-tournament Evolution Policy (offline candidate)',
    modelPath: '../checkpoints/qyj-v148-tournament-evolution-6.json',
  })],
  ['online-resolver-v76-calibrated-tournament-evolution', tournamentEvolutionStrategy({
    key: 'online-resolver-v76-calibrated-tournament-evolution',
    label: 'V149 Calibrated Tournament Evolution Policy (offline candidate)',
    modelPath: '../checkpoints/qyj-v149-tournament-evolution-6.json',
  })],
  ['online-resolver-v77-paired-tournament-evolution', tournamentEvolutionStrategy({
    key: 'online-resolver-v77-paired-tournament-evolution',
    label: 'V150 Paired-crossover Tournament Evolution Policy (offline candidate)',
    modelPath: '../checkpoints/qyj-v150-tournament-evolution-6.json',
  })],
  ['online-resolver-v78-ensemble-tournament-evolution', tournamentEvolutionStrategy({
    key: 'online-resolver-v78-ensemble-tournament-evolution',
    label: 'V151 Multi-seed Ensemble Tournament Evolution (offline candidate)',
    modelPath: '../checkpoints/qyj-v151-tournament-evolution-ensemble-6.json',
  })],
  ['online-resolver-v79-robust-tournament-evolution', tournamentEvolutionStrategy({
    key: 'online-resolver-v79-robust-tournament-evolution',
    label: 'V152 Robust-seed Tournament Evolution Policy (offline candidate)',
    modelPath: '../checkpoints/qyj-v152-tournament-evolution-6.json',
  })],
  ['online-resolver-categorical-candidate', tournamentCategoricalStrategy({
    key: 'online-resolver-categorical-candidate',
    label: 'Tournament Categorical Candidate (injected offline model)',
  })],
  ['online-resolver-categorical-explorer', tournamentCategoricalExplorationStrategy({
    key: 'online-resolver-categorical-explorer',
    label: 'Tournament Categorical Explorer (training only)',
  })],
  ['online-resolver-v80-factorized-categorical', tournamentCategoricalStrategy({
    key: 'online-resolver-v80-factorized-categorical',
    label: 'V154 Factorized Categorical Tournament Policy (offline candidate)',
    modelPath: '../checkpoints/qyj-v154-tournament-categorical-6.json',
  })],
  ['online-resolver-v81-elite-categorical', tournamentCategoricalStrategy({
    key: 'online-resolver-v81-elite-categorical',
    label: 'V155 Elite-calibrated Categorical Tournament Policy (offline candidate)',
    modelPath: '../checkpoints/qyj-v155-tournament-categorical-6.json',
  })],
  ['online-resolver-v82-policy-gradient', tournamentCategoricalStrategy({
    key: 'online-resolver-v82-policy-gradient',
    label: 'V157 Nested-selection Policy-gradient Tournament Policy (offline candidate)',
    modelPath: '../checkpoints/qyj-v157-policy-gradient-6.json',
  })],
  ['online-resolver-neural-candidate', tournamentNeuralStrategy({
    key: 'online-resolver-neural-candidate',
    label: 'Tournament Memory Neural Candidate (injected offline model)',
  })],
  ['online-resolver-neural-explorer', tournamentNeuralStrategy({
    key: 'online-resolver-neural-explorer',
    label: 'Tournament Memory Neural Explorer (training only)',
    explore: true,
  })],
  ['residual-candidate', Object.freeze({
    key: 'residual-candidate',
    label: 'Residual Candidate (offline only)',
    description: 'Offline-only sampled compact residual policy; never installable in runtime.',
    style: aiStyle('tag'),
    supportsSkills: false,
    decide({ engine, player, options, rng, residualPolicyModel, residualInterventionSelector }) {
      if (!residualPolicyModel) throw new Error('residual-candidate requires a compiled model');
      const baseAction = AI.decideWithBlueprint(engine, player, null);
      const diagnostics = AI.getLastDecisionDiagnostics(engine, player);
      const observation = buildObservation(engine, player);
      const informationSetKey = buildBlueprintInfoSetKey(observation, {
        opts: observation.legalActions,
        maxRaisesPerStreet: 3,
      });
      const prediction = predictCompactResidualPolicy(residualPolicyModel, {
        informationSetKey,
        baseDistribution: diagnostics?.baseDistribution || diagnostics?.distribution,
        basePolicyContract: residualPolicyModel.contracts.basePolicyContract,
        baseStyleKey: residualPolicyModel.contracts.baseStyleKey,
      });
      let interventionDistribution = null;
      let interventionPolicyTV = null;
      let optionStarted = false;
      let optionContinuation = false;
      let optionAborted = false;
      let optionAttempted = false;
      let optionStartInformationSetKey = null;
      let optionStartActionChanged = false;
      let optionTrajectoryBucketSha256 = null;
      if (prediction.accepted && residualInterventionSelector) {
        const states = residualOptionStates(engine);
        let active = states.get(player.idx);
        if (active && active.round !== engine.round) {
          states.delete(player.idx);
          active = null;
        }
        optionAttempted = Boolean(active);
        optionStartInformationSetKey = active?.startInformationSetKey || null;
        optionStartActionChanged = active?.startActionChanged === true;
        const selection = evaluateResidualInterventionSelector(residualInterventionSelector, {
          informationSetKey,
          startInformationSetKey: active?.startInformationSetKey || null,
          prediction,
          tableSize: engine.tableSize,
          continuation: Boolean(active),
        });
        optionTrajectoryBucketSha256 = selection.trajectoryBucketSha256 || null;
        if (!selection.eligible) {
          if (active) {
            states.delete(player.idx);
            optionAborted = true;
          }
          return { ...baseAction, residualDiagnostics: {
            accepted: false,
            reason: `selector:${selection.reason}`,
            shadowTV: prediction.shadowTV,
            actionChanged: false,
            fallbackFeatureCount: prediction.fallbackFeatureCount,
            optionStarted: false,
            optionContinuation: false,
            optionAborted,
            optionAttempted,
            optionStartInformationSetKey,
            optionStartActionChanged,
            optionTrajectoryBucketSha256,
            optionSuccessorInformationSetKey: optionAttempted ? informationSetKey : null,
            baseDistribution: prediction.baseDistribution,
          } };
        }
        if (active) {
          optionContinuation = true;
          active.remaining--;
          if (active.remaining <= 0) states.delete(player.idx);
        } else if (Number(residualInterventionSelector.optionHorizon) > 1) {
          optionStarted = true;
          states.set(player.idx, {
            round: engine.round,
            remaining: Number(residualInterventionSelector.optionHorizon) - 1,
            startInformationSetKey: informationSetKey,
            startActionChanged: false,
          });
        }
        interventionDistribution = selection.distribution || null;
        interventionPolicyTV = Number.isFinite(selection.policyTV) ? selection.policyTV : null;
      }
      if (!prediction.accepted) {
        if (residualInterventionSelector?.optionHorizon) {
          residualOptionStates(engine).delete(player.idx);
        }
        return { ...baseAction, residualDiagnostics: {
          accepted: false, reason: prediction.reason, shadowTV: 0,
          actionChanged: false, fallbackFeatureCount: 0,
          optionStarted: false, optionContinuation: false, optionAborted: false,
          optionAttempted: false,
          optionStartInformationSetKey: null,
          optionSuccessorInformationSetKey: null,
        } };
      }
      let roll = Math.max(0, Math.min(0.999999999999, Number(rng()) || 0));
      const sampledDistribution = interventionDistribution || prediction.distribution;
      let selected = sampledDistribution.at(-1);
      for (const entry of sampledDistribution) {
        roll -= entry.probability;
        if (roll < 0) { selected = entry; break; }
      }
      const action = actionFromBlueprintKey(selected.actionKey, options) || baseAction;
      const actionChanged = actionToBlueprintKey(action) !== actionToBlueprintKey(baseAction);
      if (optionStarted) {
        const state = residualOptionStates(engine).get(player.idx);
        if (state) state.startActionChanged = actionChanged;
        optionStartActionChanged = actionChanged;
      }
      return { ...action, residualDiagnostics: {
        accepted: true,
        reason: null,
        shadowTV: interventionPolicyTV ?? prediction.shadowTV,
        actionChanged,
        fallbackFeatureCount: prediction.fallbackFeatureCount,
        optionStarted,
        optionContinuation,
        optionAborted,
        optionAttempted,
        optionStartInformationSetKey,
        optionStartActionChanged,
        optionTrajectoryBucketSha256,
        optionSuccessorInformationSetKey: optionAttempted ? informationSetKey : null,
        baseDistribution: prediction.baseDistribution,
      } };
    },
  })],
  ['blueprint', Object.freeze({
    key: 'blueprint',
    label: 'Blueprint Candidate',
    description: 'QYZ range/EV policy blended with a per-seat MCCFR checkpoint.',
    style: aiStyle('tag'),
    supportsSkills: true,
    decide({ engine, player, blueprintCheckpoint }) {
      if (!blueprintCheckpoint) {
        throw new Error('blueprint strategy requires a compiled checkpoint');
      }
      return AI.decideWithBlueprint(engine, player, blueprintCheckpoint);
    },
    maybeUseSkill({ engine, player }) {
      return AI.maybeUseSkill(engine, player);
    },
  })],
  ['qyz', qyzStrategy('qyz', 'QYZ-TAG', 'tag')],
  ['qyz-v134-hand-short-pressure', qyzHandFrozenStyleStrategy({
    key: 'qyz-v134-hand-short-pressure',
    label: 'QYZ V134 Whole-hand Short-stack Pressure (offline candidate)',
    mode: 'short-pressure',
  })],
  ['qyz-v135-hand-stack-polarized', qyzHandFrozenStyleStrategy({
    key: 'qyz-v135-hand-stack-polarized',
    label: 'QYZ V135 Whole-hand Stack-polarized Style (offline candidate)',
    mode: 'stack-polarized',
  })],
  ['qyz-v136-hand-survivor', qyzHandFrozenStyleStrategy({
    key: 'qyz-v136-hand-survivor',
    label: 'QYZ V136 Whole-hand Survivor Style (offline candidate)',
    mode: 'survivor',
  })],
  ['qyz-v120-explorer', qyzExplorationStrategy({
    key: 'qyz-v120-explorer',
    label: 'QYZ V120 Propensity Explorer (offline data collection only)',
    epsilon: 0.4,
  })],
  ['qyz-adaptive', qyzStrategy(
    'qyz-adaptive', 'QYZ-Adaptive (offline candidate)', 'tag', { opponentPriorHands: 20 },
  )],
  ['qyz-adaptive-fast', qyzStrategy(
    'qyz-adaptive-fast', 'QYZ-Adaptive Fast (offline candidate)', 'tag',
    { opponentPriorHands: 12 },
  )],
  ['qyz-adaptive-evidence', qyzStrategy(
    'qyz-adaptive-evidence', 'QYZ-Adaptive Evidence (offline candidate)', 'tag',
    { opponentPriorHands: 20, opponentEvidenceWeighted: true },
  )],
  ['qyz-adaptive-balanced', qyzStrategy(
    'qyz-adaptive-balanced', 'QYZ-Adaptive Balanced (offline candidate)', 'tag',
    { opponentPriorHands: 30 },
  )],
  ['qyz-v29-multiway', qyzStrategy(
    'qyz-v29-multiway', 'QYZ V29 Multiway (offline candidate)', 'tag',
    { opponentPriorHands: 20, heterogeneousFoldModel: true },
  )],
  ['qyz-v30-table-adaptive', qyzStrategy(
    'qyz-v30-table-adaptive', 'QYZ V30 Table Adaptive (offline candidate)', 'tag',
    (engine) => ({
      opponentPriorHands: 20,
      heterogeneousFoldModel: Number(engine.tableSize) >= 9,
    }),
  )],
  ['qyz-v31-tournament-risk', qyzStrategy(
    'qyz-v31-tournament-risk', 'QYZ V31 Tournament Risk (offline candidate)', 'tag',
    (engine) => ({
      opponentPriorHands: 20,
      heterogeneousFoldModel: Number(engine.tableSize) >= 9,
      continuousTournamentRisk: true,
    }),
  )],
  ['qyz-v36-consistent-preflop-ev', qyzStrategy(
    'qyz-v36-consistent-preflop-ev', 'QYZ V36 Consistent Preflop EV (offline candidate)',
    'tag', { consistentPreflopEv: true },
  )],
  ['qyz-v37-consistent-risk', qyzStrategy(
    'qyz-v37-consistent-risk', 'QYZ V37 Consistent EV + Risk (offline candidate)',
    'tag', { consistentPreflopEv: true, continuousTournamentRisk: true },
  )],
  ['qyz-v38-consistent-preflop-risk', qyzStrategy(
    'qyz-v38-consistent-preflop-risk', 'QYZ V38 Consistent EV + Preflop Risk (offline candidate)',
    'tag', {
      consistentPreflopEv: true,
      continuousTournamentRisk: true,
      tournamentRiskScope: 'preflop',
    },
  )],
  ['qyz-v39-consistent-postflop-risk', qyzStrategy(
    'qyz-v39-consistent-postflop-risk', 'QYZ V39 Consistent EV + Postflop Risk (offline candidate)',
    'tag', {
      consistentPreflopEv: true,
      continuousTournamentRisk: true,
      tournamentRiskScope: 'postflop',
    },
  )],
  ['qyz-v40-caller-adjusted-preflop-ev', qyzStrategy(
    'qyz-v40-caller-adjusted-preflop-ev',
    'QYZ V40 Caller-adjusted Preflop EV (offline candidate)',
    'tag', { consistentPreflopEv: true, callerAdjustedPreflopEv: true },
  )],
  ['qyz-v41-shrunk-caller-preflop-ev', qyzStrategy(
    'qyz-v41-shrunk-caller-preflop-ev',
    'QYZ V41 Shrunk Caller-adjusted Preflop EV (offline candidate)',
    'tag', {
      consistentPreflopEv: true,
      callerAdjustedPreflopEv: true,
      callerProjectionWeight: 0.55,
    },
  )],
  ['qyz-v42-conservative-caller-preflop-ev', qyzStrategy(
    'qyz-v42-conservative-caller-preflop-ev',
    'QYZ V42 Conservative Caller-adjusted Preflop EV (offline candidate)',
    'tag', {
      consistentPreflopEv: true,
      callerAdjustedPreflopEv: true,
      callerProjectionWeight: 0.15,
    },
  )],
  ['qyz-v43-direct-caller-preflop-ev', qyzStrategy(
    'qyz-v43-direct-caller-preflop-ev',
    'QYZ V43 Direct Caller Preflop EV (offline candidate)',
    'tag', { consistentPreflopEv: true, directCallerPreflopEv: true },
  )],
  ['qyz-v44-learned-tournament-risk', qyzStrategy(
    'qyz-v44-learned-tournament-risk',
    'QYZ V44 Learned Tournament Marginal Risk (offline candidate)',
    'tag', () => ({
      tournamentValueModel: formalTournamentValueModel(),
      tournamentValueMaxUncertainty: 0.75,
      tournamentValueMaxOodScore: 1,
    }),
  )],
  ['qyz-v48-chip-ev-only', qyzStrategy(
    'qyz-v48-chip-ev-only', 'QYZ V48 Chip-EV Only (offline candidate)',
    'tag', { disableTournamentRisk: true },
  )],
  ['qyz-v49-chip-ev-prior20', qyzStrategy(
    'qyz-v49-chip-ev-prior20', 'QYZ V49 Chip-EV + 20-hand Prior (offline candidate)',
    'tag', { disableTournamentRisk: true, opponentPriorHands: 20 },
  )],
  ['qyz-v50-sufficient-stats', qyzStrategy(
    'qyz-v50-sufficient-stats', 'QYZ V50 Sufficient-stat Reliability (offline candidate)',
    'tag', { opponentEvidenceWeighted: true },
  )],
  ['qyz-v51-threebet-opportunities', qyzStrategy(
    'qyz-v51-threebet-opportunities',
    'QYZ V51 Three-bet Opportunity Reliability (offline candidate)',
    'tag', { opponentThreeBetOpportunityWeighted: true },
  )],
  ['qyz-v52-consistent-prior20', qyzStrategy(
    'qyz-v52-consistent-prior20', 'QYZ V52 Consistent Preflop EV + Prior20 (offline candidate)',
    'tag', { consistentPreflopEv: true, opponentPriorHands: 20 },
  )],
  ['qyz-tight', qyzStrategy('qyz-tight', 'QYZ-Tight', 'tight')],
  ['qyz-aggressive', qyzStrategy('qyz-aggressive', 'QYZ-Aggressive', 'aggressive')],
  ['qyz-loose', qyzStrategy('qyz-loose', 'QYZ-Loose', 'loose')],
  ['qyz-bluffer', qyzStrategy('qyz-bluffer', 'QYZ-Bluffer', 'bluffer')],
  ['calling-station', Object.freeze({
    key: 'calling-station',
    label: 'Calling Station',
    description: 'Always checks when possible and otherwise calls.',
    style: null,
    supportsSkills: false,
    decide({ options }) {
      return options.canCheck ? { type: 'check' } : { type: 'call' };
    },
  })],
  ['check-fold', Object.freeze({
    key: 'check-fold',
    label: 'Check/Fold',
    description: 'Always checks when possible and otherwise folds.',
    style: null,
    supportsSkills: false,
    decide({ options }) {
      return options.canCheck ? { type: 'check' } : { type: 'fold' };
    },
  })],
  ['random-legal', Object.freeze({
    key: 'random-legal',
    label: 'Random Legal',
    description: 'Uniformly samples one currently legal poker action.',
    style: null,
    supportsSkills: false,
    decide({ options, rng }) {
      const actions = legalActions(options);
      return actions[Math.floor(rng() * actions.length)];
    },
  })],
]);

export const DEFAULT_STRATEGY_KEYS = Object.freeze([
  'qyz',
  'qyz-tight',
  'qyz-aggressive',
  'calling-station',
  'random-legal',
  'check-fold',
  'qyz-loose',
  'qyz-bluffer',
  'calling-station',
]);

export function listStrategies() {
  return [...REGISTRY.values()].map(({ key, label, description, supportsSkills }) => ({
    key, label, description, supportsSkills,
  }));
}

export function getStrategy(key) {
  const strategy = REGISTRY.get(String(key));
  if (!strategy) {
    throw new RangeError(
      `Unknown strategy "${key}". Available: ${[...REGISTRY.keys()].join(', ')}`,
    );
  }
  return strategy;
}

export function configurePlayerForStrategy(player, strategyKey) {
  const strategy = getStrategy(strategyKey);
  if (strategy.style) player.style = strategy.style;
  return strategy;
}

/**
 * Defensively maps a strategy result onto the exact option objects emitted by
 * Engine. A malformed benchmark policy is recorded by the league, but cannot
 * corrupt a match by submitting a stale raise tier.
 */
export function coerceLegalAction(action, options) {
  if (action?.type === 'check' && options.canCheck) return { type: 'check' };
  if (action?.type === 'fold' && !options.canCheck) return { type: 'fold' };
  if (action?.type === 'call' && !options.canCheck) return { type: 'call' };
  if (action?.type === 'allin' && options.canAllIn) return { type: 'allin' };
  if (action?.type === 'raise') {
    const requested = action.tier || {};
    const tier = (options.tiers || []).find((candidate) => (
      (requested.key && candidate.key === requested.key)
      || (Number.isFinite(requested.inc) && candidate.inc === requested.inc)
    ));
    if (tier) return { type: 'raise', tier };
  }
  if (options.canCheck) return { type: 'check' };
  return { type: 'call' };
}

export function isLegalAction(action, options) {
  if (!action || typeof action !== 'object') return false;
  if (action.type === 'check') return !!options.canCheck;
  if (action.type === 'fold' || action.type === 'call') return !options.canCheck;
  if (action.type === 'allin') return !!options.canAllIn;
  if (action.type === 'raise') {
    return (options.tiers || []).some((tier) => (
      tier === action.tier
      || (action.tier?.key && tier.key === action.tier.key)
      || (Number.isFinite(action.tier?.inc) && tier.inc === action.tier.inc)
    ));
  }
  return false;
}
