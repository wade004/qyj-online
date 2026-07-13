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
  evaluatePublicBeliefRolloutActions,
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

const RESIDUAL_OPTION_STATES = new WeakMap();
let FORMAL_TOURNAMENT_VALUE_MODEL = null;

let FORMAL_TOURNAMENT_VALUE_BUNDLE = null;
const REAL_ENGINE_TRANSFER_SELECTORS = new Map();
const CONFIRMED_ROLLOUT_SELECTORS = new Map();
const CAUSAL_HARM_GATES = new Map();
const ROLLOUT_VALUE_CALIBRATORS = new Map();

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

function realEnginePolicyStrategy({ key, label, selectorPath }) {
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
        .filter((actionKey) => actionKey && actionKey !== baseActionKey);
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
  maxNormalizedConfirmationAdvantage = Infinity,
  minNormalizedConfirmationAdvantage = -Infinity,
  confirmationUtilityMode = 'hp',
  tournamentRiskWeight = 0.25,
  minTournamentAdvantage = 0,
  minSurvivalAdvantage = 0,
  survivalGateStatistic = 'lowerBound',
  causalHarmGatePath = null,
  causalHarmTargetResolverStrategyKey = 'online-resolver-v19-table-powered',
  rolloutValueCalibratorPath = null,
  rolloutValueTargetResolverStrategyKey = 'online-resolver-v19-table-powered',
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
        const tournamentValueModel = confirmationUtilityMode === 'dual-tournament'
          ? formalTournamentValueBundle().model : null;
        const result = resolvedConfirmationClusterCount > 0
          ? evaluateScreenedPublicBeliefRolloutActions(target, {
            baseActionKey,
            actionKeys,
            seedNamespace,
            screenClusterCount: resolvedClusterCount,
            confirmationClusterCount: resolvedConfirmationClusterCount,
            beliefTemperature: 0.5,
            minAdvantage: Math.max(1, observation.betting.pot * 0.005),
            confirmationUtilityMode,
            tournamentValueModel,
            tournamentRiskWeight,
            minTournamentAdvantage,
            minSurvivalAdvantage,
            survivalGateStatistic,
          })
          : evaluatePublicBeliefRolloutActions(target, {
          baseActionKey,
          actionKeys,
          seedNamespace,
          clusterCount: resolvedClusterCount,
          beliefTemperature: 0.5,
          minAdvantage: Math.max(1, observation.betting.pot * 0.005),
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
        if (result.accepted && result.actionKey !== baseActionKey
          && rolloutValueCalibratorPath) {
          const informationSetKey = buildBlueprintInfoSetKey(observation, {
            opts: observation.legalActions,
            maxRaisesPerStreet: 3,
          });
          const encoded = compactResidualFeatures(informationSetKey);
          realValueBundle = rolloutValueCalibrator(
            rolloutValueCalibratorPath,
            rolloutValueTargetResolverStrategyKey,
          );
          realValueCalibration = evaluateRolloutValueCalibrator(
            realValueBundle.calibrator,
            {
              tableSize: engine.tableSize,
              street: engine.street,
              mask: encoded?.mask || '',
              features: encoded?.features || {},
              baseActionKey,
              actionKey: result.actionKey,
              pot: observation.betting.pot,
              screen: result.screen?.selected || null,
              confirmation: result.confirmation?.selected || null,
            },
          );
          if (!realValueCalibration.eligible) {
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
