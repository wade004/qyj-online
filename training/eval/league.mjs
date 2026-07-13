// Reproducible, seat-balanced offline tournament runner for qyj-online bots.
// It drives every Engine seat through onAwaitAction, so production Engine and
// game rules remain the single source of truth while strategies stay pluggable.

import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { Engine } from '../../js/game/engine.js';
import * as Config from '../../js/game/config.js';
import { HEROES, getHero } from '../../js/game/heroes.js';
import { getLastDecisionDiagnostics } from '../../js/game/ai.js';
import { buildObservation } from '../../js/game/observation.js';
import {
  actionFromBlueprintKey,
  actionToBlueprintKey,
  buildBlueprintInfoSetKey,
} from '../../js/game/blueprint-policy.js';
import {
  buildExactInfosetTrainingSnapshot,
  exactInfosetProfileSecretId,
  exactInfosetProfileSourceGroup,
} from '../blueprint/target-profile.js';
import {
  DEFAULT_TARGET_BELIEF_TEMPERATURE,
  buildTargetPublicBeliefModel,
} from '../blueprint/targeted.js';
import {
  DEFAULT_STRATEGY_KEYS,
  coerceLegalAction,
  configurePlayerForStrategy,
  getStrategy,
  isLegalAction,
} from './strategies.mjs';
import {
  createSeededRng,
  deriveSeed,
  sampleWithReplacement,
} from './rng.mjs';
import {
  captureTournamentValueState,
  createTournamentValueSample,
  tournamentValueOpaqueId,
  tournamentValueSecretId,
} from '../tournament-value/dataset.mjs';

const ACTION_KEYS = Object.freeze(['fold', 'check', 'call', 'raise', 'allin']);
const DEFAULT_MIN_BLUEPRINT_HIT_RATE = 0.01;
const DEFAULT_MIN_BLUEPRINT_MEAN_INFLUENCE = 0.01;
const DEFAULT_MIN_BLUEPRINT_ACTION_CHANGE_RATE = 0.01;
const BELIEF_PROBABILITY_FLOOR = 1e-15;

function finiteNonNegative(value, maximum = Number.MAX_VALUE) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(maximum, number);
}

/**
 * Normalize optional runtime blueprint telemetry. Older runtimes/checkpoints
 * omit these fields, which must remain a conservative all-zero signal rather
 * than accidentally passing a promotion gate.
 */
export function blueprintDecisionMetrics(diagnostics) {
  const blueprint = diagnostics?.blueprint;
  if (!blueprint || typeof blueprint !== 'object') {
    return Object.freeze({
      hit: false,
      backoffLevel: 'none',
      nodeVisits: 0,
      confidence: 0,
      effectiveWeight: 0,
      intervened: false,
      actionChanged: false,
      policyTV: 0,
      influence: 0,
      advantageGuardEnabled: false,
      advantageComplete: false,
      advantagePassed: false,
      advantageMean: null,
      advantageLowerBound: null,
      advantageMinSamples: 0,
      advantageCoveredActions: 0,
      advantageRequiredActions: 0,
    });
  }
  const backoffLevel = ['exact', 'history', 'position', 'strategic', 'population']
    .includes(blueprint.backoffLevel)
    ? blueprint.backoffLevel : 'none';
  return Object.freeze({
    hit: blueprint.hit === true
      || (blueprint.hit == null && blueprint.keyHit === true),
    backoffLevel,
    nodeVisits: finiteNonNegative(blueprint.nodeVisits),
    confidence: finiteNonNegative(blueprint.confidence, 1),
    effectiveWeight: finiteNonNegative(
      blueprint.effectiveWeight ?? blueprint.weight,
      1,
    ),
    intervened: blueprint.intervened === true,
    actionChanged: blueprint.actionChanged === true,
    policyTV: finiteNonNegative(blueprint.policyTV, 1),
    influence: finiteNonNegative(blueprint.influence, 1),
    advantageGuardEnabled: blueprint.advantageGuardEnabled === true,
    advantageComplete: blueprint.advantageComplete === true,
    advantagePassed: blueprint.advantagePassed === true,
    advantageMean: blueprint.advantageMean != null
      && Number.isFinite(Number(blueprint.advantageMean))
      ? Number(blueprint.advantageMean) : null,
    advantageLowerBound: blueprint.advantageLowerBound != null
      && Number.isFinite(Number(blueprint.advantageLowerBound))
      ? Number(blueprint.advantageLowerBound) : null,
    advantageMinSamples: finiteNonNegative(blueprint.advantageMinSamples),
    advantageCoveredActions: finiteNonNegative(blueprint.advantageCoveredActions),
    advantageRequiredActions: finiteNonNegative(blueprint.advantageRequiredActions),
  });
}

function assertInteger(value, label, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer in [${min}, ${max}]`);
  }
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sorted, probability) {
  if (!sorted.length) return 0;
  const position = Math.max(0, Math.min(sorted.length - 1,
    Math.floor(probability * sorted.length)));
  return sorted[position];
}

function freshActions() {
  return {
    decisions: 0,
    fold: 0,
    check: 0,
    call: 0,
    raise: 0,
    allin: 0,
    aggressive: 0,
    committed: 0,
    skills: 0,
    passives: 0,
    blueprintDecisions: 0,
    blueprintHits: 0,
    blueprintWeightTotal: 0,
    blueprintHitWeightTotal: 0,
    blueprintNodeVisitsTotal: 0,
    blueprintConfidenceTotal: 0,
    blueprintInterventions: 0,
    blueprintActionChanges: 0,
    blueprintPolicyTVTotal: 0,
    blueprintInfluenceTotal: 0,
    blueprintAdvantageGuardDecisions: 0,
    blueprintAdvantageComplete: 0,
    blueprintAdvantagePassed: 0,
    blueprintAdvantageMeanTotal: 0,
    blueprintAdvantageMeanSamples: 0,
    blueprintAdvantageLowerBoundTotal: 0,
    blueprintAdvantageLowerBoundSamples: 0,
    blueprintAdvantageMinSamplesTotal: 0,
    blueprintAdvantageCoveredActionsTotal: 0,
    blueprintAdvantageRequiredActionsTotal: 0,
    blueprintExactHits: 0,
    blueprintHistoryBackoffHits: 0,
    blueprintPositionBackoffHits: 0,
    blueprintStrategicBackoffHits: 0,
    blueprintPopulationBackoffHits: 0,
    blueprintUnknownBackoffHits: 0,
    residualDecisions: 0,
    residualAccepted: 0,
    residualActionChanges: 0,
    residualPolicyTVTotal: 0,
    residualFallbackFeaturesTotal: 0,
    residualRejectionReasons: {},
    residualOptionStarts: 0,
    residualOptionContinuations: 0,
    residualOptionAborts: 0,
    onlineResolverDecisions: 0,
    onlineResolverAccepted: 0,
    onlineResolverInterventions: 0,
    onlineResolverActionChanges: 0,
    onlineResolverUtilitySamples: 0,
    onlineResolverPolicyTVTotal: 0,
    onlineResolverInfluenceTotal: 0,
    onlineResolverRejectionReasons: {},
    onlineResolverChangePairs: {},
    onlineResolverAcceptedByStreet: {},
    onlineResolverScreenLowerBoundTotal: 0,
    onlineResolverScreenLowerBoundSamples: 0,
    onlineResolverConfirmationLowerBoundTotal: 0,
    onlineResolverConfirmationLowerBoundSamples: 0,
    onlineResolverPreflopDecisions: 0,
    onlineResolverFlopDecisions: 0,
    onlineResolverTurnDecisions: 0,
    onlineResolverRiverDecisions: 0,
    onlineResolverPreflopChanges: 0,
    onlineResolverFlopChanges: 0,
    onlineResolverTurnChanges: 0,
    onlineResolverRiverChanges: 0,
  };
}

function freshCalibrationBucket() {
  return {
    samples: 0,
    posteriorLogLossTotal: 0,
    uniformLogLossTotal: 0,
    posteriorBrierTotal: 0,
    uniformBrierTotal: 0,
  };
}

function freshBeliefCalibration() {
  return { all: freshCalibrationBucket(), conditioned: freshCalibrationBucket() };
}

function addCalibrationBucket(target, source) {
  for (const key of Object.keys(target)) target[key] += Number(source?.[key]) || 0;
}

function addBeliefCalibration(target, source) {
  addCalibrationBucket(target.all, source?.all);
  addCalibrationBucket(target.conditioned, source?.conditioned);
}

function addCalibrationSample(bucket, posteriorProbability, weights, support) {
  const posterior = Math.max(BELIEF_PROBABILITY_FLOOR, Number(posteriorProbability) || 0);
  const uniform = 1 / support;
  let posteriorSquareMass = 0;
  for (const weight of weights) posteriorSquareMass += weight * weight;
  bucket.samples++;
  bucket.posteriorLogLossTotal -= Math.log(posterior);
  bucket.uniformLogLossTotal -= Math.log(uniform);
  bucket.posteriorBrierTotal += 1 - 2 * posterior + posteriorSquareMass;
  bucket.uniformBrierTotal += 1 - uniform;
}

/**
 * Offline-only calibration against true simulator holes. The return value is
 * aggregate-only and never contains a seat, card, range vector or raw key.
 */
export function beliefCalibrationDecision(trainingSnapshot, actualHolesBySeat, {
  beliefTemperature = DEFAULT_TARGET_BELIEF_TEMPERATURE,
} = {}) {
  if (!(actualHolesBySeat instanceof Map)) {
    throw new TypeError('actualHolesBySeat must be a Map used only by the offline evaluator');
  }
  const { observerIdx, ...snapshot } = trainingSnapshot;
  const model = buildTargetPublicBeliefModel(snapshot, observerIdx, { beliefTemperature });
  const totals = freshBeliefCalibration();
  for (const seat of snapshot.handSeats) {
    if (seat === observerIdx) continue;
    const range = model.get(seat);
    const actualHole = actualHolesBySeat.get(seat);
    if (!range || !Array.isArray(actualHole) || actualHole.length !== 2) continue;
    const weights = range.weights();
    const support = range.supportCount();
    if (!(support > 0)) continue;
    const posterior = range.probabilityOf(actualHole);
    addCalibrationSample(totals.all, posterior, weights, support);
    if (range.history.length > 0) {
      addCalibrationSample(totals.conditioned, posterior, weights, support);
    }
  }
  return totals;
}

function finalizeCalibrationBucket(bucket) {
  const denominator = Math.max(1, bucket.samples);
  const posteriorLogLoss = bucket.posteriorLogLossTotal / denominator;
  const uniformLogLoss = bucket.uniformLogLossTotal / denominator;
  const posteriorBrier = bucket.posteriorBrierTotal / denominator;
  const uniformBrier = bucket.uniformBrierTotal / denominator;
  return Object.freeze({
    samples: bucket.samples,
    posteriorLogLoss,
    uniformLogLoss,
    logLossImprovement: uniformLogLoss - posteriorLogLoss,
    posteriorBrier,
    uniformBrier,
    brierImprovement: uniformBrier - posteriorBrier,
  });
}

export function summarizeBeliefCalibration(matches, beliefTemperature) {
  const totals = freshBeliefCalibration();
  for (const match of matches || []) addBeliefCalibration(totals, match.beliefCalibration);
  const all = finalizeCalibrationBucket(totals.all);
  const conditioned = finalizeCalibrationBucket(totals.conditioned);
  return Object.freeze({
    schema: 'qyj-public-belief-calibration-v1',
    likelihoodTemperature: Number(beliefTemperature),
    all,
    conditioned,
    passed: conditioned.samples > 0
      && conditioned.logLossImprovement > 0
      && conditioned.brierImprovement > 0,
  });
}

function sumActions(rows) {
  const total = freshActions();
  for (const row of rows) {
    for (const key of Object.keys(total)) {
      if (key === 'residualRejectionReasons' || key === 'onlineResolverRejectionReasons'
        || key === 'onlineResolverChangePairs' || key === 'onlineResolverAcceptedByStreet') {
        for (const [reason, count] of Object.entries(row.actions?.[key] || {})) {
          total[key][reason] = (total[key][reason] || 0) + (Number(count) || 0);
        }
      } else total[key] += Number(row.actions?.[key]) || 0;
    }
  }
  return total;
}

function validateTableSize(tableSize) {
  if (!Config.SUPPORTED_TABLE_SIZES.includes(tableSize)) {
    throw new RangeError(
      `Unsupported table size ${tableSize}; expected ${Config.SUPPORTED_TABLE_SIZES.join(' or ')}`,
    );
  }
}

/** Build stable logical competitors. Strategies and heroes move together. */
export function createLineup(strategyEntries, tableSize) {
  validateTableSize(tableSize);
  let source = strategyEntries;
  if (typeof source === 'string') source = source.split(',').map((item) => item.trim()).filter(Boolean);
  if (!Array.isArray(source) || source.length === 0) source = DEFAULT_STRATEGY_KEYS;

  const keyCounts = new Map();
  const ids = new Set();
  const lineup = [];
  for (let index = 0; index < tableSize; index++) {
    const raw = source[index % source.length];
    const entry = typeof raw === 'string' ? { strategy: raw } : { ...raw };
    const strategy = getStrategy(entry.strategy || entry.strategyKey || entry.key);
    const occurrence = (keyCounts.get(strategy.key) || 0) + 1;
    keyCounts.set(strategy.key, occurrence);
    const id = String(entry.id || `${strategy.key}#${occurrence}`);
    if (ids.has(id)) throw new Error(`Duplicate lineup competitor id: ${id}`);
    ids.add(id);
    const heroId = String(entry.heroId || HEROES[index % HEROES.length].id);
    if (!getHero(heroId)) throw new RangeError(`Unknown hero id: ${heroId}`);
    lineup.push(Object.freeze({
      id,
      strategy: strategy.key,
      strategyLabel: strategy.label,
      heroId,
      name: String(entry.name || id),
      logicalIndex: index,
    }));
  }
  return Object.freeze(lineup);
}

/**
 * Generate circular seat rotations plus their reflected table orientation.
 * The logical competitor id remains stable, allowing results to follow a bot
 * while physical hole-card/dealer positions change.
 */
export function buildSeatAssignments(lineup, options = {}) {
  const tableSize = lineup.length;
  validateTableSize(tableSize);
  const requested = options.rotations ?? 'full';
  const rotations = requested === 'full' ? tableSize : Number(requested);
  assertInteger(rotations, 'rotations', 1, tableSize);
  const orientations = options.mirror === false ? [false] : [false, true];
  const assignments = [];
  for (const mirrored of orientations) {
    for (let rotation = 0; rotation < rotations; rotation++) {
      const seats = Array(tableSize);
      for (let logicalIndex = 0; logicalIndex < tableSize; logicalIndex++) {
        const oriented = mirrored && logicalIndex > 0
          ? tableSize - logicalIndex
          : logicalIndex;
        const seat = ((oriented + rotation) % tableSize) + 1;
        seats[seat - 1] = Object.freeze({ seat, ...lineup[logicalIndex] });
      }
      assignments.push(Object.freeze({
        key: `r${rotation + 1}${mirrored ? '-mirror' : ''}`,
        rotation,
        mirrored,
        seats: Object.freeze(seats),
      }));
    }
  }
  return Object.freeze(assignments);
}

/**
 * Move the complete candidate and baseline competitors into each other's
 * logical table slots. Circular seat rotations alone preserve their relative
 * neighbourhood, so this crossover is required for an attributable A/B gate.
 */
export function buildPromotionCrossoverLineup(lineup, gate = {}) {
  const candidate = String(gate.candidate || 'qyz');
  const baseline = String(gate.baseline || 'qyz-tight');
  if (candidate === baseline) return null;
  const candidateSlots = lineup
    .map((entry, index) => (entry.strategy === candidate ? index : -1))
    .filter((index) => index >= 0);
  const baselineSlots = lineup
    .map((entry, index) => (entry.strategy === baseline ? index : -1))
    .filter((index) => index >= 0);
  if (candidateSlots.length !== 1 || baselineSlots.length !== 1) return null;
  const candidateSlot = candidateSlots[0];
  const baselineSlot = baselineSlots[0];
  return Object.freeze(lineup.map((entry, index) => {
    const source = index === candidateSlot
      ? lineup[baselineSlot]
      : index === baselineSlot ? lineup[candidateSlot] : entry;
    return Object.freeze({ ...source, logicalIndex: index });
  }));
}

function strategyError(message, context, cause = null) {
  const error = new Error(`${message}: ${JSON.stringify(context)}`);
  if (cause) error.cause = cause;
  return error;
}

function actionType(key, context) {
  if (ACTION_KEYS.includes(context?.type)) return context.type;
  if (['feint', 'strike', 'fierce'].includes(key)) return 'raise';
  return ACTION_KEYS.includes(key) ? key : null;
}

/** Run one native QYJ match (normally all 12 hands) for one seat assignment. */
export function runMatch({
  assignment,
  seed,
  seedGroup = String(seed),
  tableSize = assignment?.seats?.length,
  skillsEnabled = false,
  blueprintCheckpoint = null,
  residualPolicyModel = null,
  residualInterventionSelector = null,
  onExactInfosetProfile = null,
  onResidualPolicyProfile = null,
  onResidualSuccessor = null,
  onDecisionTrace = null,
  forcedDecision = null,
  profileStrategies = null,
  profileMaxRaises = 3,
  profileSourceGroupSecret = null,
  beliefCalibration = false,
  beliefTemperature = DEFAULT_TARGET_BELIEF_TEMPERATURE,
  onTournamentValueSample = null,
  tournamentValueFocalStrategies = ['qyz'],
  tournamentValueIdSecret = null,
  failFast = true,
  tickSeconds = 10,
  maxSteps = 50000,
} = {}) {
  validateTableSize(tableSize);
  if (!assignment || assignment.seats?.length !== tableSize) {
    throw new RangeError('assignment must contain exactly tableSize seats');
  }
  assertInteger(maxSteps, 'maxSteps', 1);
  if (onExactInfosetProfile != null && typeof onExactInfosetProfile !== 'function') {
    throw new TypeError('onExactInfosetProfile must be a function or null');
  }
  if (onResidualPolicyProfile != null && typeof onResidualPolicyProfile !== 'function') {
    throw new TypeError('onResidualPolicyProfile must be a function or null');
  }
  if (onResidualSuccessor != null && typeof onResidualSuccessor !== 'function') {
    throw new TypeError('onResidualSuccessor must be a function or null');
  }
  if (onDecisionTrace != null && typeof onDecisionTrace !== 'function') {
    throw new TypeError('onDecisionTrace must be a function or null');
  }
  if (forcedDecision != null && (!forcedDecision.entryId
    || !Number.isSafeInteger(Number(forcedDecision.ordinal))
    || Number(forcedDecision.ordinal) < 1 || !forcedDecision.actionKey)) {
    throw new TypeError('forcedDecision requires entryId, positive ordinal and actionKey');
  }
  if ((onDecisionTrace || forcedDecision) && skillsEnabled) {
    throw new RangeError('decision replay requires skillsEnabled=false');
  }
  if ((onExactInfosetProfile || onResidualPolicyProfile || onResidualSuccessor) && skillsEnabled) {
    throw new RangeError('exact-infoset profiling requires skillsEnabled=false');
  }
  if (profileSourceGroupSecret != null
    && !onExactInfosetProfile && !onResidualPolicyProfile && !onResidualSuccessor) {
    throw new RangeError('profileSourceGroupSecret requires a profile callback');
  }
  if (profileSourceGroupSecret != null) {
    // Validate before the Engine starts. The secret and raw seedGroup remain
    // process-local and never enter a profile record or ordinary report field.
    exactInfosetProfileSecretId(profileSourceGroupSecret);
  }
  if (beliefCalibration && skillsEnabled) {
    throw new RangeError('belief calibration requires skillsEnabled=false');
  }
  if (onTournamentValueSample != null
    && typeof onTournamentValueSample !== 'function') {
    throw new TypeError('onTournamentValueSample must be a function or null');
  }
  if (onTournamentValueSample && skillsEnabled) {
    throw new RangeError('tournament-value collection requires skillsEnabled=false');
  }
  const tournamentValueFocalValues = typeof tournamentValueFocalStrategies === 'string'
    ? tournamentValueFocalStrategies.split(',').map((value) => value.trim()).filter(Boolean)
    : tournamentValueFocalStrategies;
  const tournamentValueFocalSet = new Set([...(tournamentValueFocalValues instanceof Set
    ? tournamentValueFocalValues
    : Array.isArray(tournamentValueFocalValues) ? tournamentValueFocalValues : [])].map(String));
  if (onTournamentValueSample) {
    if (!tournamentValueFocalSet.size) {
      throw new RangeError('tournamentValueFocalStrategies must select at least one strategy');
    }
    for (const strategy of tournamentValueFocalSet) getStrategy(strategy);
    // Validate the high-entropy secret before the Engine starts; only its
    // one-way identifier may be persisted by a collector.
    tournamentValueSecretId(tournamentValueIdSecret);
  }
  if (!Number.isFinite(Number(beliefTemperature))
    || Number(beliefTemperature) < 0 || Number(beliefTemperature) > 1) {
    throw new RangeError('beliefTemperature must be in 0..1');
  }
  if (!Number.isSafeInteger(Number(profileMaxRaises))
    || Number(profileMaxRaises) < 0
    || Number(profileMaxRaises) > 3) {
    throw new RangeError('profileMaxRaises must be an integer in 0..3');
  }
  const profileStrategyValues = typeof profileStrategies === 'string'
    ? profileStrategies.split(',').map((value) => value.trim()).filter(Boolean)
    : profileStrategies;
  const profileStrategySet = profileStrategyValues == null
    ? null
    : new Set([...(profileStrategyValues instanceof Set
      ? profileStrategyValues : profileStrategyValues)].map(String));

  const seedValue = typeof seed === 'number' ? seed >>> 0 : deriveSeed(seed);
  const profileSourceGroup = (onExactInfosetProfile || onResidualPolicyProfile || onResidualSuccessor)
    && profileSourceGroupSecret != null
    ? exactInfosetProfileSourceGroup(
      profileSourceGroupSecret,
      `table:${tableSize}|seed-group:${String(seedGroup)}`,
    )
    : null;
  const engineRng = createSeededRng(seedValue);
  const strategyRngById = new Map(assignment.seats.map((entry) => [
    entry.id,
    createSeededRng(deriveSeed(seedValue, 'strategy', entry.id)),
  ]));
  const bySeat = new Map(assignment.seats.map((entry) => [entry.seat, entry]));
  const statsBySeat = new Map(assignment.seats.map((entry) => [entry.seat, freshActions()]));
  const decisionOrdinals = new Map(assignment.seats.map((entry) => [entry.id, 0]));
  const residualTrajectoriesBySeat = new Map(assignment.seats.map((entry) => [
    entry.seat, new Map(),
  ]));
  const errors = [];
  let ranking = null;
  let roundsStarted = 0;
  let showdownCount = 0;
  let sidePotLayers = 0;
  let engine;
  const calibrationTotals = freshBeliefCalibration();
  const tournamentValueStates = [];
  const tournamentValueStateKeys = new Set();
  const tournamentValueGroupId = onTournamentValueSample
    ? tournamentValueOpaqueId(
        tournamentValueIdSecret,
        'group',
        tableSize,
        String(seedGroup),
      )
    : null;
  const tournamentValueMatchId = onTournamentValueSample
    ? tournamentValueOpaqueId(
        tournamentValueIdSecret,
        'match',
        tableSize,
        String(seedGroup),
        assignment.key,
      )
    : null;

  const handlePolicyError = (errorRecord, cause = null) => {
    errors.push(errorRecord);
    if (failFast) throw strategyError('Evaluation strategy failure', errorRecord, cause);
  };

  const captureTournamentBoundary = (boundary) => {
    if (!onTournamentValueSample) return;
    try {
      for (const seat of engine.currentHandSeats || []) {
        const entry = bySeat.get(seat);
        const player = engine.players[seat];
        if (!entry || !tournamentValueFocalSet.has(entry.strategy)
          || player?.alive === false || !(Number(player?.hp) > 0)) continue;
        const state = captureTournamentValueState(engine, seat, boundary);
        // End(r) and start(r + 1) intentionally describe the same public
        // model input. Keep one copy per focal player and match.
        const key = `${seat}|${JSON.stringify(state)}`;
        if (tournamentValueStateKeys.has(key)) continue;
        tournamentValueStateKeys.add(key);
        tournamentValueStates.push(Object.freeze({ seat, state }));
      }
    } catch (error) {
      handlePolicyError({
        kind: 'tournament-value-state-error',
        round: engine.round,
        street: engine.street,
        message: 'Unable to capture sanitized public tournament state',
      }, error);
    }
  };

  const listeners = {
    onRoundStart(round) {
      roundsStarted = Math.max(roundsStarted, Number(round) || 0);
      captureTournamentBoundary('start');
    },
    onRoundEnd() {
      captureTournamentBoundary('end');
    },
    onShowdown(data) {
      showdownCount++;
      sidePotLayers += Math.max(0, (data?.pots?.length || 1) - 1);
    },
    onSkill(idx) {
      statsBySeat.get(idx).skills++;
    },
    onPassive(idx) {
      statsBySeat.get(idx).passives++;
    },
    onAction(idx, key, amount, context) {
      const stats = statsBySeat.get(idx);
      const type = actionType(key, context);
      if (type) stats[type]++;
      if (context?.isAggressive) stats.aggressive++;
      stats.committed += Number(amount) || 0;
    },
    onAwaitAction(idx) {
      const entry = bySeat.get(idx);
      const player = engine.players[idx];
      const strategy = getStrategy(entry.strategy);
      const stats = statsBySeat.get(idx);
      stats.decisions++;

      if (skillsEnabled && strategy.supportsSkills && strategy.maybeUseSkill) {
        try {
          strategy.maybeUseSkill({ engine, player, rng: strategyRngById.get(entry.id) });
        } catch (error) {
          handlePolicyError({
            kind: 'skill-error', entryId: entry.id, strategy: entry.strategy,
            seat: idx, round: engine.round, street: engine.street, message: error.message,
          }, error);
        }
      }

      // A skill can alter stack/availability, so refresh options after it.
      const options = engine.getOptions(player);
      const shouldProfile = (typeof onExactInfosetProfile === 'function'
          || typeof onResidualPolicyProfile === 'function')
        && (!profileStrategySet || profileStrategySet.has(entry.strategy));
      let profileHead = null;
      let decisionObservation = null;
      if (shouldProfile || beliefCalibration || onDecisionTrace || forcedDecision) {
        try {
          decisionObservation = buildObservation(engine, player);
        } catch {
          handlePolicyError({
            kind: 'observation-build-error', entryId: entry.id, strategy: entry.strategy,
            seat: idx, round: engine.round, street: engine.street,
            message: 'Unable to construct offline decision observation',
          });
        }
      }
      if (shouldProfile) {
        try {
          const observation = decisionObservation;
          profileHead = Object.freeze({
            exactKey: buildBlueprintInfoSetKey(observation, {
              opts: observation.legalActions,
              maxRaisesPerStreet: Number(profileMaxRaises),
            }),
            strategy: entry.strategy,
            street: observation.street,
            trainingSnapshot: buildExactInfosetTrainingSnapshot(observation),
            ...(profileSourceGroup ? { sourceGroup: profileSourceGroup } : {}),
          });
        } catch {
          // Never include the raw key or Observation in a normal error record.
          handlePolicyError({
            kind: 'profile-build-error', entryId: entry.id, strategy: entry.strategy,
            seat: idx, round: engine.round, street: engine.street,
            message: 'Unable to construct sanitized exact-infoset profile record',
          });
        }
      }
      if (beliefCalibration) {
        try {
          const trainingSnapshot = buildExactInfosetTrainingSnapshot(decisionObservation);
          const actualHoles = new Map(trainingSnapshot.handSeats.map((seat) => [
            seat,
            engine.players[seat]?.hole,
          ]));
          addBeliefCalibration(calibrationTotals, beliefCalibrationDecision(
            trainingSnapshot,
            actualHoles,
            { beliefTemperature: Number(beliefTemperature) },
          ));
        } catch {
          // Never expose the held-out true holes through an error message.
          handlePolicyError({
            kind: 'belief-calibration-error', entryId: entry.id, strategy: entry.strategy,
            seat: idx, round: engine.round, street: engine.street,
            message: 'Unable to aggregate private held-out belief calibration',
          });
        }
      }
      let proposed;
      try {
        proposed = strategy.decide({
          engine,
          player,
          options,
          rng: strategyRngById.get(entry.id),
          blueprintCheckpoint,
          residualPolicyModel,
          residualInterventionSelector,
        });
      } catch (error) {
        handlePolicyError({
          kind: 'decision-error', entryId: entry.id, strategy: entry.strategy,
          seat: idx, round: engine.round, street: engine.street, message: error.message,
        }, error);
      }
      const ordinal = (decisionOrdinals.get(entry.id) || 0) + 1;
      decisionOrdinals.set(entry.id, ordinal);
      const baselineActionKey = actionToBlueprintKey(proposed);
      let forced = false;
      if (forcedDecision && String(forcedDecision.entryId) === entry.id
        && Number(forcedDecision.ordinal) === ordinal) {
        const replacement = actionFromBlueprintKey(forcedDecision.actionKey, options);
        if (!replacement) {
          throw new RangeError('forced decision action is not legal at replay node');
        }
        proposed = replacement;
        forced = true;
      }
      if (onDecisionTrace) {
        const policyDiagnostics = getLastDecisionDiagnostics(engine, player);
        const policyCandidates = (policyDiagnostics?.distribution || []).flatMap((candidate) => {
          const actionKey = candidate.type === 'raise' && candidate.tier
            ? `raise:${candidate.tier}` : candidate.type;
          return actionKey && Number.isFinite(Number(candidate.ev)) ? [{
            actionKey,
            ev: Number(candidate.ev),
            probability: Number(candidate.probability) || 0,
          }] : [];
        });
        policyCandidates.sort((left, right) => right.ev - left.ev
          || left.actionKey.localeCompare(right.actionKey));
        const sampledCandidate = policyCandidates.find(
          (candidate) => candidate.actionKey === baselineActionKey,
        );
        const bestEvGap = policyCandidates[0] && sampledCandidate
          ? policyCandidates[0].ev - sampledCandidate.ev : null;
        const informationSetKey = buildBlueprintInfoSetKey(decisionObservation, {
          opts: decisionObservation.legalActions,
          maxRaisesPerStreet: 3,
        });
        const legalActionKeys = [
          ...(options.canCheck ? ['check'] : ['fold', 'call']),
          ...(options.tiers || []).map((tier) => `raise:${tier.key}`),
          ...(options.canAllIn ? ['allin'] : []),
        ];
        onDecisionTrace(Object.freeze({
          entryId: entry.id,
          strategy: entry.strategy,
          seat: entry.seat,
          ordinal,
          informationSetKey,
          baselineActionKey,
          actionKey: actionToBlueprintKey(proposed),
          legalActionKeys: Object.freeze(legalActionKeys),
          policyCandidates: Object.freeze(policyCandidates.map(Object.freeze)),
          bestEvActionKey: policyCandidates[0]?.actionKey || null,
          bestEvGap,
          normalizedBestEvGap: Number.isFinite(bestEvGap)
            ? bestEvGap / Math.max(1, Number(decisionObservation.betting?.pot) || 0) : null,
          pot: Math.max(0, Number(decisionObservation.betting?.pot) || 0),
          learnedTournamentValue: policyDiagnostics?.learnedTournamentValue
            ? Object.freeze({ ...policyDiagnostics.learnedTournamentValue }) : null,
          onlineResolver: proposed?.onlineResolverDiagnostics
            ? Object.freeze({
              accepted: proposed.onlineResolverDiagnostics.accepted === true,
              reason: typeof proposed.onlineResolverDiagnostics.reason === 'string'
                ? proposed.onlineResolverDiagnostics.reason : null,
              actionChanged: proposed.onlineResolverDiagnostics.actionChanged === true,
              baseActionKey: typeof proposed.onlineResolverDiagnostics.baseActionKey === 'string'
                ? proposed.onlineResolverDiagnostics.baseActionKey : null,
              resolverActionKey:
                typeof proposed.onlineResolverDiagnostics.resolverActionKey === 'string'
                  ? proposed.onlineResolverDiagnostics.resolverActionKey : null,
              proposedActionKey:
                typeof proposed.onlineResolverDiagnostics.proposedActionKey === 'string'
                  ? proposed.onlineResolverDiagnostics.proposedActionKey : null,
              causalHarmGate: proposed.onlineResolverDiagnostics.causalHarmGate
                ? Object.freeze({
                  eligible:
                    proposed.onlineResolverDiagnostics.causalHarmGate.eligible !== false,
                  reason: proposed.onlineResolverDiagnostics.causalHarmGate.reason || null,
                  hpUpper: Number.isFinite(Number(
                    proposed.onlineResolverDiagnostics.causalHarmGate.hpUpper,
                  )) ? Number(proposed.onlineResolverDiagnostics.causalHarmGate.hpUpper) : null,
                  rankUpper: Number.isFinite(Number(
                    proposed.onlineResolverDiagnostics.causalHarmGate.rankUpper,
                  )) ? Number(proposed.onlineResolverDiagnostics.causalHarmGate.rankUpper) : null,
                }) : null,
              realValueCalibration: proposed.onlineResolverDiagnostics.realValueCalibration
                ? Object.freeze({
                  eligible:
                    proposed.onlineResolverDiagnostics.realValueCalibration.eligible === true,
                  reason:
                    proposed.onlineResolverDiagnostics.realValueCalibration.reason || null,
                  prediction: proposed.onlineResolverDiagnostics.realValueCalibration.prediction
                    ? Object.freeze({
                      ...proposed.onlineResolverDiagnostics.realValueCalibration.prediction,
                    }) : null,
                }) : null,
              policyTV: Number(proposed.onlineResolverDiagnostics.policyTV) || 0,
              influence: Number(proposed.onlineResolverDiagnostics.influence) || 0,
              advantageLowerBound:
                Number.isFinite(Number(proposed.onlineResolverDiagnostics.advantageLowerBound))
                  ? Number(proposed.onlineResolverDiagnostics.advantageLowerBound) : null,
              tournamentValueSource: proposed.onlineResolverDiagnostics.tournamentValueSource
                ? Object.freeze({ ...proposed.onlineResolverDiagnostics.tournamentValueSource })
                : null,
              transferSelection: proposed.onlineResolverDiagnostics.transferSelection
                ? Object.freeze({ ...proposed.onlineResolverDiagnostics.transferSelection }) : null,
              rollout: proposed.onlineResolverDiagnostics.rollout
                ? Object.freeze({
                  schema: proposed.onlineResolverDiagnostics.rollout.schema,
                  clusterCount: Number(proposed.onlineResolverDiagnostics.rollout.clusterCount) || 0,
                  utilitySamples: Number(proposed.onlineResolverDiagnostics.rollout.utilitySamples) || 0,
                  continuationDecisions:
                    Number(proposed.onlineResolverDiagnostics.rollout.continuationDecisions) || 0,
                  minAdvantage: Number(proposed.onlineResolverDiagnostics.rollout.minAdvantage) || 0,
                  selected: proposed.onlineResolverDiagnostics.rollout.selected
                    ? Object.freeze({ ...proposed.onlineResolverDiagnostics.rollout.selected }) : null,
                  candidates: Object.freeze(
                    (proposed.onlineResolverDiagnostics.rollout.candidates || [])
                      .map((candidate) => Object.freeze({ ...candidate })),
                  ),
                  screen: proposed.onlineResolverDiagnostics.rollout.screen
                    ? Object.freeze({
                      schema: proposed.onlineResolverDiagnostics.rollout.screen.schema,
                      accepted:
                        proposed.onlineResolverDiagnostics.rollout.screen.accepted === true,
                      actionKey:
                        proposed.onlineResolverDiagnostics.rollout.screen.actionKey || null,
                      baseActionKey:
                        proposed.onlineResolverDiagnostics.rollout.screen.baseActionKey || null,
                      clusterCount: Number(
                        proposed.onlineResolverDiagnostics.rollout.screen.clusterCount,
                      ) || 0,
                      utilitySamples: Number(
                        proposed.onlineResolverDiagnostics.rollout.screen.utilitySamples,
                      ) || 0,
                      selected: proposed.onlineResolverDiagnostics.rollout.screen.selected
                        ? Object.freeze({
                          ...proposed.onlineResolverDiagnostics.rollout.screen.selected,
                        }) : null,
                    }) : null,
                  confirmation: proposed.onlineResolverDiagnostics.rollout.confirmation
                    ? Object.freeze({
                      schema: proposed.onlineResolverDiagnostics.rollout.confirmation.schema,
                      accepted:
                        proposed.onlineResolverDiagnostics.rollout.confirmation.accepted === true,
                      actionKey:
                        proposed.onlineResolverDiagnostics.rollout.confirmation.actionKey || null,
                      baseActionKey:
                        proposed.onlineResolverDiagnostics.rollout.confirmation.baseActionKey || null,
                      clusterCount: Number(
                        proposed.onlineResolverDiagnostics.rollout.confirmation.clusterCount,
                      ) || 0,
                      utilitySamples: Number(
                        proposed.onlineResolverDiagnostics.rollout.confirmation.utilitySamples,
                      ) || 0,
                      selected: proposed.onlineResolverDiagnostics.rollout.confirmation.selected
                        ? Object.freeze({
                          ...proposed.onlineResolverDiagnostics.rollout.confirmation.selected,
                        }) : null,
                    }) : null,
                }) : null,
            }) : null,
          forced,
          round: engine.round,
          street: engine.street,
        }));
      }
      if (!isLegalAction(proposed, options)) {
        handlePolicyError({
          kind: 'illegal-action', entryId: entry.id, strategy: entry.strategy,
          seat: idx, round: engine.round, street: engine.street,
          proposed: proposed?.type || null,
        });
      }
      if (entry.strategy === 'residual-candidate') {
        const residual = proposed?.residualDiagnostics;
        stats.residualDecisions++;
        if (residual?.optionStarted === true) stats.residualOptionStarts++;
        if (residual?.optionContinuation === true) stats.residualOptionContinuations++;
        if (residual?.optionAborted === true) stats.residualOptionAborts++;
        if (residual?.optionAttempted === true && onResidualSuccessor && profileSourceGroup) {
          onResidualSuccessor({
            sourceGroup: profileSourceGroup,
            tableSize,
            startInformationSetKey: residual.optionStartInformationSetKey,
            successorInformationSetKey: residual.optionSuccessorInformationSetKey,
            continued: residual.optionContinuation === true,
            aborted: residual.optionAborted === true,
            reason: residual.reason || null,
            baseDistribution: residual.baseDistribution,
          });
        }
        if (residual?.optionAttempted === true
          && residual.optionStartInformationSetKey
          && residual.optionSuccessorInformationSetKey) {
          const exactTrajectorySha256 = createHash('sha256').update(
            `${residual.optionStartInformationSetKey}\n${residual.optionSuccessorInformationSetKey}`,
          ).digest('hex');
          const trajectoryBucketSha256 = residual.optionTrajectoryBucketSha256
            || exactTrajectorySha256;
          const trajectories = residualTrajectoriesBySeat.get(entry.seat);
          const record = trajectories.get(trajectoryBucketSha256) || {
            trajectoryBucketSha256,
            attempts: 0,
            continuations: 0,
            aborts: 0,
            actionChanges: 0,
          };
          record.attempts++;
          if (residual.optionContinuation === true) record.continuations++;
          if (residual.optionAborted === true) record.aborts++;
          if (residual.optionStartActionChanged === true || residual.actionChanged === true) {
            record.actionChanges++;
          }
          trajectories.set(trajectoryBucketSha256, record);
        }
        if (residual?.accepted === true) {
          stats.residualAccepted++;
          stats.residualPolicyTVTotal += Number(residual.shadowTV) || 0;
          stats.residualFallbackFeaturesTotal
            += Number(residual.fallbackFeatureCount) || 0;
          if (residual.actionChanged === true) stats.residualActionChanges++;
        } else {
          const reason = String(residual?.reason || 'missing-diagnostics');
          stats.residualRejectionReasons[reason]
            = (stats.residualRejectionReasons[reason] || 0) + 1;
        }
      }
      if (entry.strategy.startsWith('online-resolver-')) {
        const resolver = proposed?.onlineResolverDiagnostics;
        const resolverStreet = ['preflop', 'flop', 'turn', 'river']
          .includes(resolver?.street) ? resolver.street : null;
        stats.onlineResolverDecisions++;
        if (resolverStreet) {
          const streetName = resolverStreet[0].toUpperCase() + resolverStreet.slice(1);
          stats[`onlineResolver${streetName}Decisions`]++;
          if (resolver?.actionChanged === true) stats[`onlineResolver${streetName}Changes`]++;
        }
        stats.onlineResolverUtilitySamples += Number(resolver?.utilitySamples) || 0;
        stats.onlineResolverPolicyTVTotal += Number(resolver?.policyTV) || 0;
        stats.onlineResolverInfluenceTotal += Number(resolver?.influence) || 0;
        if (resolver?.accepted === true) stats.onlineResolverAccepted++;
        else {
          const reason = String(resolver?.reason || 'missing-diagnostics');
          stats.onlineResolverRejectionReasons[reason]
            = (stats.onlineResolverRejectionReasons[reason] || 0) + 1;
        }
        if (resolver?.intervened === true) stats.onlineResolverInterventions++;
        if (resolver?.actionChanged === true) {
          stats.onlineResolverActionChanges++;
          const pair = `${resolverStreet || 'unknown'}:${String(resolver.baseActionKey || 'unknown')}`
            + `>${String(resolver.resolverActionKey || 'unknown')}`;
          stats.onlineResolverChangePairs[pair]
            = (stats.onlineResolverChangePairs[pair] || 0) + 1;
          const street = resolverStreet || 'unknown';
          stats.onlineResolverAcceptedByStreet[street]
            = (stats.onlineResolverAcceptedByStreet[street] || 0) + 1;
          const screenLowerBound = Number(resolver.rollout?.screen?.selected?.lowerBound);
          if (Number.isFinite(screenLowerBound)) {
            stats.onlineResolverScreenLowerBoundTotal += screenLowerBound;
            stats.onlineResolverScreenLowerBoundSamples++;
          }
          const confirmationLowerBound = Number(
            resolver.rollout?.confirmation?.selected?.lowerBound,
          );
          if (Number.isFinite(confirmationLowerBound)) {
            stats.onlineResolverConfirmationLowerBoundTotal += confirmationLowerBound;
            stats.onlineResolverConfirmationLowerBoundSamples++;
          }
        }
      }
      const legalAction = coerceLegalAction(proposed, options);
      let blueprintMetrics = null;
      let decisionDiagnostics = null;
      if (entry.strategy === 'blueprint' || entry.strategy.startsWith('online-resolver-')
        || profileHead) {
        // Reading diagnostics is observational only; it lets reports
        // distinguish an installed-but-unmatched checkpoint from real hits.
        // Baseline seats only pay this diagnostic read when opt-in profiling
        // explicitly selected their strategy.
        decisionDiagnostics = getLastDecisionDiagnostics(engine, player);
        blueprintMetrics = blueprintDecisionMetrics(decisionDiagnostics);
      }
      if (entry.strategy === 'blueprint' || entry.strategy.startsWith('online-resolver-')) {
        stats.blueprintDecisions++;
        stats.blueprintWeightTotal += blueprintMetrics.effectiveWeight;
        stats.blueprintPolicyTVTotal += blueprintMetrics.policyTV;
        stats.blueprintInfluenceTotal += blueprintMetrics.influence;
        if (blueprintMetrics.advantageGuardEnabled) {
          stats.blueprintAdvantageGuardDecisions++;
          if (blueprintMetrics.advantageComplete) stats.blueprintAdvantageComplete++;
          if (blueprintMetrics.advantagePassed) stats.blueprintAdvantagePassed++;
          if (blueprintMetrics.advantageMean != null) {
            stats.blueprintAdvantageMeanTotal += blueprintMetrics.advantageMean;
            stats.blueprintAdvantageMeanSamples++;
          }
          if (blueprintMetrics.advantageLowerBound != null) {
            stats.blueprintAdvantageLowerBoundTotal += blueprintMetrics.advantageLowerBound;
            stats.blueprintAdvantageLowerBoundSamples++;
          }
          stats.blueprintAdvantageMinSamplesTotal += blueprintMetrics.advantageMinSamples;
          stats.blueprintAdvantageCoveredActionsTotal
            += blueprintMetrics.advantageCoveredActions;
          stats.blueprintAdvantageRequiredActionsTotal
            += blueprintMetrics.advantageRequiredActions;
        }
        if (blueprintMetrics.intervened) stats.blueprintInterventions++;
        if (blueprintMetrics.actionChanged) stats.blueprintActionChanges++;
        if (blueprintMetrics.hit) {
          stats.blueprintHits++;
          stats.blueprintHitWeightTotal += blueprintMetrics.effectiveWeight;
          stats.blueprintNodeVisitsTotal += blueprintMetrics.nodeVisits;
          stats.blueprintConfidenceTotal += blueprintMetrics.confidence;
          if (blueprintMetrics.backoffLevel === 'exact') stats.blueprintExactHits++;
          else if (blueprintMetrics.backoffLevel === 'history') {
            stats.blueprintHistoryBackoffHits++;
          } else if (blueprintMetrics.backoffLevel === 'position') {
            stats.blueprintPositionBackoffHits++;
          } else if (blueprintMetrics.backoffLevel === 'strategic') {
            stats.blueprintStrategicBackoffHits++;
          } else if (blueprintMetrics.backoffLevel === 'population') {
            stats.blueprintPopulationBackoffHits++;
          } else {
            stats.blueprintUnknownBackoffHits++;
          }
        }
      }
      if (profileHead && onExactInfosetProfile) {
        const metrics = blueprintMetrics || blueprintDecisionMetrics(null);
        try {
          onExactInfosetProfile(Object.freeze({
            ...profileHead,
            actionKey: actionToBlueprintKey(legalAction) || 'unknown',
            usableHit: metrics.hit,
            exactHit: metrics.hit && metrics.backoffLevel === 'exact',
            backoffLevel: metrics.hit ? metrics.backoffLevel : 'none',
            nodeVisits: metrics.nodeVisits,
            confidence: metrics.confidence,
            influence: metrics.influence,
            advantageGuardEnabled: metrics.advantageGuardEnabled,
            advantageComplete: metrics.advantageComplete,
            advantagePassed: metrics.advantagePassed,
            advantageMean: metrics.advantageMean,
            advantageLowerBound: metrics.advantageLowerBound,
            advantageMinSamples: metrics.advantageMinSamples,
            advantageCoveredActions: metrics.advantageCoveredActions,
            advantageRequiredActions: metrics.advantageRequiredActions,
            intervened: metrics.intervened,
            actionChanged: metrics.actionChanged,
          }));
        } catch {
          // A custom sink can see the raw abstract key, so deliberately hide
          // its exception message from ordinary match errors.
          handlePolicyError({
            kind: 'profile-sink-error', entryId: entry.id, strategy: entry.strategy,
            seat: idx, round: engine.round, street: engine.street,
            message: 'Exact-infoset profile sink rejected a sanitized record',
          });
        }
      }
      if (profileHead && onResidualPolicyProfile) {
        const metrics = blueprintMetrics || blueprintDecisionMetrics(null);
        try {
          onResidualPolicyProfile(Object.freeze({
            ...profileHead,
            actionKey: actionToBlueprintKey(legalAction) || 'unknown',
            baseStrategy: Array.isArray(decisionDiagnostics?.blueprint?.baseStrategy)
              ? decisionDiagnostics.blueprint.baseStrategy
              : (decisionDiagnostics?.baseDistribution || []),
            targetStrategy: Array.isArray(decisionDiagnostics?.blueprint?.targetStrategy)
              ? decisionDiagnostics.blueprint.targetStrategy : null,
            usableHit: metrics.hit,
            exactHit: metrics.hit && metrics.backoffLevel === 'exact',
            backoffLevel: metrics.hit ? metrics.backoffLevel : 'none',
          }));
        } catch {
          handlePolicyError({
            kind: 'residual-profile-sink-error', entryId: entry.id,
            strategy: entry.strategy, seat: idx, round: engine.round,
            street: engine.street,
            message: 'Residual policy profile sink rejected a record',
          });
        }
      }
      engine.playerAct(legalAction);
    },
    onGameOver(finalRanking) {
      ranking = [...finalRanking];
      if (!onTournamentValueSample) return;
      const rankBySeat = new Map(ranking.map((player, index) => [player.idx, index + 1]));
      for (let index = 0; index < tournamentValueStates.length; index++) {
        const pending = tournamentValueStates[index];
        try {
          onTournamentValueSample(createTournamentValueSample({
            state: pending.state,
            rank: rankBySeat.get(pending.seat),
            seedGroup: tournamentValueGroupId,
            matchId: tournamentValueMatchId,
            sampleId: tournamentValueOpaqueId(
              tournamentValueIdSecret,
              'sample',
              tableSize,
              String(seedGroup),
              assignment.key,
              index,
            ),
          }));
        } catch (error) {
          handlePolicyError({
            kind: 'tournament-value-sink-error',
            round: engine.round,
            street: engine.street,
            message: 'Tournament-value sink rejected a sanitized sample',
          }, error);
        }
      }
    },
  };

  const heroIds = assignment.seats.map((entry) => entry.heroId);
  const humanSeats = new Set(assignment.seats.map((entry) => entry.seat));
  const names = Object.fromEntries(assignment.seats.map((entry) => [entry.seat, entry.name]));
  engine = new Engine(heroIds, listeners, humanSeats, names, {
    tableSize,
    rng: engineRng,
    endWhenHumanEliminated: false,
    skillsEnabled,
  });
  for (const entry of assignment.seats) {
    configurePlayerForStrategy(engine.players[entry.seat], entry.strategy);
  }

  const startedAt = performance.now();
  engine.startGame();
  let steps = 0;
  while (!engine.gameOver && steps < maxSteps) {
    engine.update(tickSeconds);
    steps++;
  }
  const durationMs = performance.now() - startedAt;
  if (!engine.gameOver || !ranking) {
    throw new Error(
      `Evaluation match stalled after ${steps} steps (round=${engine.round}, street=${engine.street})`,
    );
  }

  const rankBySeat = new Map(ranking.map((player, index) => [player.idx, index + 1]));
  const results = assignment.seats.map((entry) => {
    const player = engine.players[entry.seat];
    return {
      entryId: entry.id,
      strategy: entry.strategy,
      strategyLabel: entry.strategyLabel,
      heroId: entry.heroId,
      seat: entry.seat,
      rank: rankBySeat.get(entry.seat),
      firstPlace: rankBySeat.get(entry.seat) === 1,
      alive: !!player.alive,
      hp: player.hp,
      hpDelta: player.hp - Config.INIT_HP,
      energy: player.energy,
      deathRound: player.deathRound,
      roundsSurvived: player.deathRound || engine.round,
      actions: { ...statsBySeat.get(entry.seat) },
      ...(entry.strategy === 'residual-candidate' ? {
        residualTrajectories: [...residualTrajectoriesBySeat.get(entry.seat).values()]
          .sort((left, right) => (
            left.trajectoryBucketSha256.localeCompare(right.trajectoryBucketSha256)
          )),
      } : {}),
    };
  });

  return {
    id: `${seedGroup}/${assignment.key}`,
    seedGroup: String(seedGroup),
    seedValue,
    variant: assignment.key,
    rotation: assignment.rotation,
    mirrored: assignment.mirrored,
    tableSize,
    skillsEnabled: !!skillsEnabled,
    rounds: engine.round,
    roundsStarted,
    fullSchedule: engine.round === Config.MAX_ROUNDS,
    naturalEarlyFinish: engine.round < Config.MAX_ROUNDS,
    steps,
    durationMs,
    showdownCount,
    sidePotLayers,
    errorCount: errors.length,
    errors,
    ...(beliefCalibration ? { beliefCalibration: calibrationTotals } : {}),
    results,
  };
}

export function bootstrapMeanCI(values, options = {}) {
  const numeric = values.map(Number).filter(Number.isFinite);
  const confidence = Number(options.confidence ?? 0.95);
  const iterations = Number(options.iterations ?? 2000);
  if (!(confidence > 0 && confidence < 1)) {
    throw new RangeError('bootstrap confidence must be between 0 and 1');
  }
  assertInteger(iterations, 'bootstrap iterations', 1, 1_000_000);
  if (!numeric.length) {
    return { mean: 0, low: 0, high: 0, confidence, units: 0, iterations: 0 };
  }
  if (numeric.length === 1) {
    const value = mean(numeric);
    return {
      mean: value, low: value, high: value, confidence,
      units: numeric.length, iterations: 0,
    };
  }
  const rng = createSeededRng(options.seed ?? 'qyj-bootstrap');
  const estimates = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    estimates.push(mean(sampleWithReplacement(numeric, numeric.length, rng)));
  }
  estimates.sort((left, right) => left - right);
  const alpha = (1 - confidence) / 2;
  return {
    mean: mean(numeric),
    low: percentile(estimates, alpha),
    high: percentile(estimates, 1 - alpha),
    confidence,
    units: numeric.length,
    iterations,
  };
}

function rowsByStrategyAndSeed(matches) {
  const byStrategy = new Map();
  for (const match of matches) {
    for (const result of match.results) {
      if (!byStrategy.has(result.strategy)) byStrategy.set(result.strategy, new Map());
      const bySeed = byStrategy.get(result.strategy);
      if (!bySeed.has(match.seedGroup)) bySeed.set(match.seedGroup, []);
      bySeed.get(match.seedGroup).push(result);
    }
  }
  return byStrategy;
}

function metricClusters(rowsBySeed, selector) {
  return [...rowsBySeed.values()].map((rows) => mean(rows.map(selector)));
}

function nonNegativeThreshold(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
  return number;
}

export function aggregateLeague(matches, options = {}) {
  const iterations = Number(options.bootstrapIterations ?? 2000);
  const confidence = Number(options.confidence ?? 0.95);
  const baseSeed = options.baseSeed ?? 'qyj-eval-v1';
  const grouped = rowsByStrategyAndSeed(matches);
  const summary = [];
  for (const [strategy, rowsBySeed] of grouped) {
    const rows = [...rowsBySeed.values()].flat();
    const ci = (name, selector) => bootstrapMeanCI(metricClusters(rowsBySeed, selector), {
      iterations,
      confidence,
      seed: deriveSeed(baseSeed, 'bootstrap', strategy, name),
    });
    const actions = sumActions(rows);
    const decisionDenominator = Math.max(1, actions.decisions);
    const blueprintDecisionDenominator = Math.max(1, actions.blueprintDecisions);
    const blueprintLevelCounts = Object.freeze({
      exact: actions.blueprintExactHits,
      history: actions.blueprintHistoryBackoffHits,
      position: actions.blueprintPositionBackoffHits,
      strategic: actions.blueprintStrategicBackoffHits,
      population: actions.blueprintPopulationBackoffHits,
      unknown: actions.blueprintUnknownBackoffHits,
      none: Math.max(0, actions.blueprintDecisions - actions.blueprintHits),
    });
    const blueprintLevelRates = Object.freeze(Object.fromEntries(
      Object.entries(blueprintLevelCounts).map(([level, count]) => [
        level,
        count / blueprintDecisionDenominator,
      ]),
    ));
    summary.push({
      strategy,
      label: rows[0]?.strategyLabel || strategy,
      samples: rows.length,
      seedClusters: rowsBySeed.size,
      meanRank: ci('meanRank', (row) => row.rank),
      firstPlaceRate: ci('firstPlaceRate', (row) => Number(row.firstPlace)),
      survivalRate: ci('survivalRate', (row) => Number(row.alive)),
      meanHp: ci('meanHp', (row) => row.hp),
      meanHpDelta: ci('meanHpDelta', (row) => row.hpDelta),
      meanRoundsSurvived: ci('roundsSurvived', (row) => row.roundsSurvived),
      actions,
      actionRates: Object.fromEntries(ACTION_KEYS.map((key) => [
        key,
        actions[key] / decisionDenominator,
      ])),
      aggressionRate: actions.aggressive / decisionDenominator,
      blueprintHitRate: actions.blueprintHits / Math.max(1, actions.blueprintDecisions),
      exactHitRate: actions.blueprintExactHits / blueprintDecisionDenominator,
      blueprintBackoffCounts: blueprintLevelCounts,
      blueprintBackoffRates: blueprintLevelRates,
      meanBlueprintWeight: actions.blueprintWeightTotal
        / Math.max(1, actions.blueprintDecisions),
      blueprintConditionalWeight: actions.blueprintHitWeightTotal
        / Math.max(1, actions.blueprintHits),
      meanBlueprintNodeVisits: actions.blueprintNodeVisitsTotal
        / Math.max(1, actions.blueprintHits),
      meanBlueprintConfidence: actions.blueprintConfidenceTotal
        / Math.max(1, actions.blueprintHits),
      interventionRate: actions.blueprintInterventions
        / Math.max(1, actions.blueprintDecisions),
      actionChangeRate: actions.blueprintActionChanges
        / Math.max(1, actions.blueprintDecisions),
      meanPolicyTV: actions.blueprintPolicyTVTotal
        / Math.max(1, actions.blueprintDecisions),
      meanInfluence: actions.blueprintInfluenceTotal
        / Math.max(1, actions.blueprintDecisions),
      advantageGuardDecisionRate: actions.blueprintAdvantageGuardDecisions
        / blueprintDecisionDenominator,
      advantageCompleteRate: actions.blueprintAdvantageComplete
        / Math.max(1, actions.blueprintAdvantageGuardDecisions),
      advantagePassRate: actions.blueprintAdvantagePassed
        / Math.max(1, actions.blueprintAdvantageGuardDecisions),
      meanAdvantage: actions.blueprintAdvantageMeanTotal
        / Math.max(1, actions.blueprintAdvantageMeanSamples),
      meanAdvantageLowerBound: actions.blueprintAdvantageLowerBoundTotal
        / Math.max(1, actions.blueprintAdvantageLowerBoundSamples),
      meanAdvantageMinSamples: actions.blueprintAdvantageMinSamplesTotal
        / Math.max(1, actions.blueprintAdvantageGuardDecisions),
      advantageActionCoverage: actions.blueprintAdvantageCoveredActionsTotal
        / Math.max(1, actions.blueprintAdvantageRequiredActionsTotal),
      residualCoverage: actions.residualAccepted / Math.max(1, actions.residualDecisions),
      residualActionChangeRate: actions.residualActionChanges
        / Math.max(1, actions.residualDecisions),
      residualMeanPolicyTV: actions.residualPolicyTVTotal
        / Math.max(1, actions.residualAccepted),
      residualMeanFallbackFeatures: actions.residualFallbackFeaturesTotal
        / Math.max(1, actions.residualAccepted),
      onlineResolverCoverage: actions.onlineResolverAccepted
        / Math.max(1, actions.onlineResolverDecisions),
      onlineResolverInterventionRate: actions.onlineResolverInterventions
        / Math.max(1, actions.onlineResolverDecisions),
      onlineResolverActionChangeRate: actions.onlineResolverActionChanges
        / Math.max(1, actions.onlineResolverDecisions),
      onlineResolverMeanUtilitySamples: actions.onlineResolverUtilitySamples
        / Math.max(1, actions.onlineResolverAccepted),
      onlineResolverMeanPolicyTV: actions.onlineResolverPolicyTVTotal
        / Math.max(1, actions.onlineResolverAccepted),
      onlineResolverMeanInfluence: actions.onlineResolverInfluenceTotal
        / Math.max(1, actions.onlineResolverAccepted),
      onlineResolverMeanScreenLowerBound: actions.onlineResolverScreenLowerBoundTotal
        / Math.max(1, actions.onlineResolverScreenLowerBoundSamples),
      onlineResolverMeanConfirmationLowerBound:
        actions.onlineResolverConfirmationLowerBoundTotal
        / Math.max(1, actions.onlineResolverConfirmationLowerBoundSamples),
    });
  }
  summary.sort((left, right) => (
    left.meanRank.mean - right.meanRank.mean
    || right.meanHp.mean - left.meanHp.mean
  ));
  return summary;
}

/**
 * A paired promotion gate compares per-seed averages after all seat rotations.
 * Rank advantage is baseline rank - candidate rank, so positive is always
 * better; HP advantage is candidate HP - baseline HP.
 */
export function evaluatePromotionGate(matches, gate = {}, bootstrap = {}) {
  const candidate = String(gate.candidate || 'qyz');
  const baseline = String(gate.baseline || 'qyz-tight');
  const metric = String(gate.metric || 'rank');
  if (!['rank', 'hp', 'both'].includes(metric)) {
    throw new RangeError('promotion metric must be rank, hp, or both');
  }
  const minPairedSeeds = Number(gate.minPairedSeeds ?? 8);
  assertInteger(minPairedSeeds, 'minPairedSeeds', 1);
  const minImprovement = Number(gate.minImprovement ?? 0);
  if (!Number.isFinite(minImprovement)) {
    throw new TypeError('minImprovement must be finite');
  }
  const grouped = rowsByStrategyAndSeed(matches);
  const candidateSeeds = grouped.get(candidate);
  const baselineSeeds = grouped.get(baseline);
  if (!candidateSeeds || !baselineSeeds) {
    return {
      candidate,
      baseline,
      metric,
      passed: false,
      reason: 'candidate-or-baseline-missing',
      pairedSeeds: 0,
    };
  }
  const seedIds = [...candidateSeeds.keys()].filter((seedId) => baselineSeeds.has(seedId));
  const rankAdvantages = [];
  const hpAdvantages = [];
  for (const seedId of seedIds) {
    const candidateRows = candidateSeeds.get(seedId);
    const baselineRows = baselineSeeds.get(seedId);
    rankAdvantages.push(
      mean(baselineRows.map((row) => row.rank)) - mean(candidateRows.map((row) => row.rank)),
    );
    hpAdvantages.push(
      mean(candidateRows.map((row) => row.hp)) - mean(baselineRows.map((row) => row.hp)),
    );
  }
  const common = {
    iterations: Number(bootstrap.bootstrapIterations ?? 2000),
    confidence: Number(bootstrap.confidence ?? 0.95),
  };
  const rankAdvantage = bootstrapMeanCI(rankAdvantages, {
    ...common,
    seed: deriveSeed(bootstrap.baseSeed || 'qyj-eval-v1', 'gate', candidate, baseline, 'rank'),
  });
  const hpAdvantage = bootstrapMeanCI(hpAdvantages, {
    ...common,
    seed: deriveSeed(bootstrap.baseSeed || 'qyj-eval-v1', 'gate', candidate, baseline, 'hp'),
  });
  const enoughSamples = seedIds.length >= minPairedSeeds;
  const rankPass = rankAdvantage.low > minImprovement;
  const hpPass = hpAdvantage.low > minImprovement;
  const effectPass = metric === 'rank' ? rankPass : metric === 'hp' ? hpPass : rankPass && hpPass;
  return {
    candidate,
    baseline,
    metric,
    minImprovement,
    minPairedSeeds,
    pairedSeeds: seedIds.length,
    rankAdvantage,
    hpAdvantage,
    passed: enoughSamples && effectPass,
    reason: !enoughSamples
      ? 'insufficient-paired-seeds'
      : effectPass ? 'lower-confidence-bound-clears-threshold' : 'confidence-bound-not-cleared',
  };
}

/**
 * Statistical improvement is necessary but not sufficient for release.  This
 * layer blocks schedules or artifacts that cannot attribute the effect to the
 * candidate strategy while preserving the raw result for diagnostics.
 */
export function enforcePromotionEligibility(statisticalPromotion, context = {}) {
  if (!statisticalPromotion) return null;
  const blockers = [];
  const tableSize = Number(context.tableSize);
  const rotations = context.rotations ?? 'full';
  const hasFullRotations = rotations === 'full' || Number(rotations) === tableSize;
  const hasMirror = context.mirror !== false;
  if (context.skillsEnabled === true) {
    blockers.push('skills-enabled-requires-hero-crossover');
  }
  if (!hasFullRotations || !hasMirror) {
    blockers.push('unbalanced-seat-schedule');
  }
  if (context.candidateBaselineCrossover !== true) {
    blockers.push('candidate-baseline-crossover-required');
  }

  let blueprintCoverage = null;
  let residualCoverage = null;
  if (statisticalPromotion.candidate === 'blueprint'
    || statisticalPromotion.candidate.startsWith('online-resolver-')) {
    const minHitRate = nonNegativeThreshold(
      context.gate?.minBlueprintHitRate ?? DEFAULT_MIN_BLUEPRINT_HIT_RATE,
      'minBlueprintHitRate',
    );
    const minMeanInfluence = nonNegativeThreshold(
      context.gate?.minBlueprintMeanInfluence ?? DEFAULT_MIN_BLUEPRINT_MEAN_INFLUENCE,
      'minBlueprintMeanInfluence',
    );
    const minActionChangeRate = nonNegativeThreshold(
      context.gate?.minBlueprintActionChangeRate
        ?? DEFAULT_MIN_BLUEPRINT_ACTION_CHANGE_RATE,
      'minBlueprintActionChangeRate',
    );
    if (minHitRate > 1 || minMeanInfluence > 1 || minActionChangeRate > 1) {
      throw new RangeError('blueprint rate/influence thresholds must be at most 1');
    }
    const candidate = (context.summary || [])
      .find((row) => row.strategy === statisticalPromotion.candidate);
    const isOnlineResolver = statisticalPromotion.candidate.startsWith('online-resolver-');
    const decisions = Number(isOnlineResolver
      ? candidate?.actions?.onlineResolverDecisions : candidate?.actions?.blueprintDecisions) || 0;
    const hits = Number(isOnlineResolver
      ? candidate?.actions?.onlineResolverAccepted : candidate?.actions?.blueprintHits) || 0;
    const observedHitRate = decisions > 0 ? hits / decisions : 0;
    const rawLevelCounts = candidate?.blueprintBackoffCounts || {};
    const exactHits = finiteNonNegative(rawLevelCounts.exact
      ?? candidate?.actions?.blueprintExactHits);
    const historyHits = finiteNonNegative(rawLevelCounts.history
      ?? candidate?.actions?.blueprintHistoryBackoffHits);
    const positionHits = finiteNonNegative(rawLevelCounts.position
      ?? candidate?.actions?.blueprintPositionBackoffHits);
    const strategicHits = finiteNonNegative(rawLevelCounts.strategic
      ?? candidate?.actions?.blueprintStrategicBackoffHits);
    const populationHits = finiteNonNegative(rawLevelCounts.population
      ?? candidate?.actions?.blueprintPopulationBackoffHits);
    const classifiedHits = exactHits + historyHits + positionHits + strategicHits
      + populationHits;
    const unknownHits = finiteNonNegative(rawLevelCounts.unknown
      ?? candidate?.actions?.blueprintUnknownBackoffHits
      ?? Math.max(0, hits - classifiedHits));
    const levelCounts = Object.freeze({
      exact: exactHits,
      history: historyHits,
      position: positionHits,
      strategic: strategicHits,
      population: populationHits,
      unknown: unknownHits,
      none: finiteNonNegative(rawLevelCounts.none ?? Math.max(0, decisions - hits)),
    });
    const levelRates = Object.freeze(Object.fromEntries(
      Object.entries(levelCounts).map(([level, count]) => [
        level,
        count / Math.max(1, decisions),
      ]),
    ));
    const blueprintConditionalWeight = Number(candidate?.blueprintConditionalWeight) || 0;
    const interventionRate = Number(isOnlineResolver
      ? candidate?.onlineResolverInterventionRate : candidate?.interventionRate) || 0;
    const actionChangeRate = Number(isOnlineResolver
      ? candidate?.onlineResolverActionChangeRate : candidate?.actionChangeRate) || 0;
    const meanPolicyTV = Number(isOnlineResolver
      ? candidate?.onlineResolverMeanPolicyTV : candidate?.meanPolicyTV) || 0;
    const meanInfluence = Number(isOnlineResolver
      ? candidate?.onlineResolverMeanInfluence : candidate?.meanInfluence) || 0;
    blueprintCoverage = {
      decisions,
      hits,
      observedHitRate,
      usableHitRate: observedHitRate,
      exactHits: levelCounts.exact,
      exactHitRate: levelRates.exact,
      backoffCounts: levelCounts,
      backoffRates: levelRates,
      minHitRate,
      meanEffectiveWeight: Number(candidate?.meanBlueprintWeight) || 0,
      blueprintConditionalWeight,
      meanNodeVisits: Number(candidate?.meanBlueprintNodeVisits) || 0,
      meanConfidence: Number(candidate?.meanBlueprintConfidence) || 0,
      interventionRate,
      actionChangeRate,
      minActionChangeRate,
      meanPolicyTV,
      meanInfluence,
      minMeanInfluence,
    };
    if (!(decisions > 0) || observedHitRate < minHitRate) {
      blockers.push('blueprint-hit-rate-below-threshold');
    }
    if (meanInfluence < minMeanInfluence) {
      blockers.push('blueprint-influence-below-threshold');
    }
    if (actionChangeRate < minActionChangeRate) {
      blockers.push('blueprint-action-change-rate-below-threshold');
    }
    if (isOnlineResolver
      && context.onlineResolverDeployable !== true) {
      blockers.push('online-resolver-offline-only-cannot-deploy');
    }
  }

  if (statisticalPromotion.candidate === 'residual-candidate') {
    const candidate = (context.summary || [])
      .find((row) => row.strategy === statisticalPromotion.candidate);
    const minCoverage = nonNegativeThreshold(
      context.gate?.minResidualCoverage
        ?? (context.residualInterventionSelector ? 0.005 : 0.5), 'minResidualCoverage',
    );
    const minMeanPolicyTV = nonNegativeThreshold(
      context.gate?.minResidualMeanPolicyTV ?? 0.002, 'minResidualMeanPolicyTV',
    );
    const minActionChangeRate = nonNegativeThreshold(
      context.gate?.minResidualActionChangeRate ?? 0.001, 'minResidualActionChangeRate',
    );
    const decisions = Number(candidate?.actions?.residualDecisions) || 0;
    residualCoverage = {
      decisions,
      accepted: Number(candidate?.actions?.residualAccepted) || 0,
      observedCoverage: Number(candidate?.residualCoverage) || 0,
      minCoverage,
      meanPolicyTV: Number(candidate?.residualMeanPolicyTV) || 0,
      minMeanPolicyTV,
      actionChangeRate: Number(candidate?.residualActionChangeRate) || 0,
      minActionChangeRate,
      meanFallbackFeatures: Number(candidate?.residualMeanFallbackFeatures) || 0,
    };
    if (context.residualPolicyModel?.mode === 'shadow-only') {
      blockers.push('residual-shadow-only-schema-cannot-deploy');
    }
    if (!(decisions > 0) || residualCoverage.observedCoverage < minCoverage) {
      blockers.push('residual-coverage-below-threshold');
    }
    if (residualCoverage.meanPolicyTV < minMeanPolicyTV) {
      blockers.push('residual-policy-tv-below-threshold');
    }
    if (residualCoverage.actionChangeRate < minActionChangeRate) {
      blockers.push('residual-action-change-rate-below-threshold');
    }
  }

  if (!blockers.length) {
    return {
      ...statisticalPromotion,
      ...(blueprintCoverage ? { blueprintCoverage } : {}),
      ...(residualCoverage ? { residualCoverage } : {}),
    };
  }
  return {
    ...statisticalPromotion,
    passed: false,
    statisticalReason: statisticalPromotion.reason,
    reason: blockers[0],
    eligibilityBlockers: blockers,
    ...(blueprintCoverage ? { blueprintCoverage } : {}),
    ...(residualCoverage ? { residualCoverage } : {}),
  };
}

export function runLeague(options = {}) {
  const tableSize = Number(options.tableSize ?? Config.DEFAULT_TABLE_SIZE);
  validateTableSize(tableSize);
  const baseSeed = String(options.baseSeed ?? 'qyj-eval-v1');
  const skillsEnabled = options.skillsEnabled === true;
  const seedCount = Number(options.seedCount ?? 2);
  const bootstrapIterations = Number(options.bootstrapIterations ?? 2000);
  const confidence = Number(options.confidence ?? 0.95);
  assertInteger(seedCount, 'seedCount', 1, 10000);
  assertInteger(bootstrapIterations, 'bootstrap iterations', 1, 1_000_000);
  if (!(confidence > 0 && confidence < 1)) {
    throw new RangeError('bootstrap confidence must be between 0 and 1');
  }
  const lineup = createLineup(options.lineup, tableSize);
  const requestedRotations = options.rotations ?? 'full';
  const mirror = options.mirror !== false;
  const baseAssignments = buildSeatAssignments(lineup, {
    rotations: requestedRotations,
    mirror,
  });
  const gateConfig = options.promotionGate === false ? null : (options.promotionGate || {});
  const fullRotationSchedule = requestedRotations === 'full'
    || Number(requestedRotations) === tableSize;
  const crossedLineup = gateConfig && !skillsEnabled && fullRotationSchedule && mirror
    ? buildPromotionCrossoverLineup(lineup, gateConfig)
    : null;
  const crossedAssignments = crossedLineup
    ? buildSeatAssignments(crossedLineup, {
        rotations: requestedRotations,
        mirror,
      }).map((assignment) => Object.freeze({
        ...assignment,
        key: `${assignment.key}-candidate-baseline-swap`,
        promotionCrossover: true,
      }))
    : [];
  const assignments = Object.freeze([...baseAssignments, ...crossedAssignments]);
  const promotionCrossover = gateConfig ? {
    enabled: crossedAssignments.length > 0,
    candidate: String(gateConfig.candidate || 'qyz'),
    baseline: String(gateConfig.baseline || 'qyz-tight'),
    baseVariants: baseAssignments.length,
    swappedVariants: crossedAssignments.length,
    reason: crossedAssignments.length > 0
      ? 'candidate-and-baseline-logical-slots-crossed'
      : !fullRotationSchedule || !mirror
        ? 'requires-balanced-base-schedule'
        : skillsEnabled
          ? 'skills-enabled'
          : 'candidate-and-baseline-must-appear-exactly-once',
  } : null;
  const totalMatches = seedCount * assignments.length;
  const matches = [];
  const startedAt = performance.now();
  let completed = 0;
  for (let seedIndex = 0; seedIndex < seedCount; seedIndex++) {
    const seedGroup = `${baseSeed}:${seedIndex + 1}`;
    const dealSeed = deriveSeed(baseSeed, 'deal', seedIndex);
    for (const assignment of assignments) {
      const match = runMatch({
        assignment,
        seed: dealSeed,
        seedGroup,
        tableSize,
        skillsEnabled,
        blueprintCheckpoint: options.blueprintCheckpoint || null,
        residualPolicyModel: options.residualPolicyModel || null,
        residualInterventionSelector: options.residualInterventionSelector || null,
        onExactInfosetProfile: options.onExactInfosetProfile || null,
        onResidualPolicyProfile: options.onResidualPolicyProfile || null,
        onResidualSuccessor: options.onResidualSuccessor || null,
        profileStrategies: options.profileStrategies ?? null,
        profileMaxRaises: options.profileMaxRaises ?? 3,
        profileSourceGroupSecret: options.profileSourceGroupSecret ?? null,
        beliefCalibration: options.beliefCalibration === true,
        beliefTemperature: options.beliefTemperature
          ?? DEFAULT_TARGET_BELIEF_TEMPERATURE,
        onTournamentValueSample: options.onTournamentValueSample || null,
        tournamentValueFocalStrategies: options.tournamentValueFocalStrategies ?? ['qyz'],
        tournamentValueIdSecret: options.tournamentValueIdSecret ?? null,
        failFast: options.failFast !== false,
        tickSeconds: options.tickSeconds ?? 10,
        maxSteps: options.maxSteps ?? 50000,
      });
      matches.push(match);
      completed++;
      options.onProgress?.({
        completed,
        total: totalMatches,
        matchId: match.id,
        durationMs: match.durationMs,
      });
    }
  }
  const bootstrap = {
    bootstrapIterations,
    confidence,
    baseSeed,
  };
  const summary = aggregateLeague(matches, bootstrap);
  const statisticalPromotion = options.promotionGate === false
    ? null
    : evaluatePromotionGate(matches, options.promotionGate || {}, bootstrap);
  const promotion = enforcePromotionEligibility(statisticalPromotion, {
    tableSize,
    rotations: options.rotations ?? 'full',
    mirror: options.mirror !== false,
    skillsEnabled,
    summary,
    gate: options.promotionGate || {},
    candidateBaselineCrossover: promotionCrossover?.enabled === true,
    residualPolicyModel: options.residualPolicyModel || null,
    residualInterventionSelector: options.residualInterventionSelector || null,
  });
  const durationMs = performance.now() - startedAt;
  const beliefCalibration = options.beliefCalibration === true
    ? summarizeBeliefCalibration(
        matches,
        options.beliefTemperature ?? DEFAULT_TARGET_BELIEF_TEMPERATURE,
      )
    : null;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    config: {
      tableSize,
      baseSeed,
      seedCount,
      rotations: requestedRotations,
      mirror,
      skillsEnabled,
      bootstrapIterations: bootstrap.bootstrapIterations,
      confidence: bootstrap.confidence,
      lineup,
      blueprint: options.blueprintCheckpoint ? {
        schema: options.blueprintCheckpoint.schema,
        version: options.blueprintCheckpoint.version,
        size: options.blueprintCheckpoint.size,
        blendWeight: options.blueprintCheckpoint.blendWeight,
        metadata: options.blueprintCheckpoint.metadata,
        source: options.blueprintSource || null,
        sha256: options.blueprintSha256 || null,
      } : null,
      residualPolicy: options.residualPolicyModel ? {
        schema: options.residualPolicyModel.schema,
        version: options.residualPolicyModel.version,
        mode: 'offline-evaluation-only',
        source: options.residualPolicySource || null,
        sha256: options.residualPolicySha256 || null,
      } : null,
      residualSelector: options.residualInterventionSelector ? {
        schema: options.residualInterventionSelector.schema,
        version: options.residualInterventionSelector.version,
        mode: options.residualInterventionSelector.mode,
        source: options.residualSelectorSource || null,
        sha256: options.residualSelectorSha256 || null,
        thresholds: options.residualInterventionSelector.thresholds,
        roots: options.residualInterventionSelector.roots.length,
      } : null,
      sharedInitialSeedAcrossSeatVariants: true,
      promotionCrossover,
      beliefCalibration: options.beliefCalibration === true,
      beliefTemperature: options.beliefTemperature
        ?? DEFAULT_TARGET_BELIEF_TEMPERATURE,
    },
    matchCount: matches.length,
    fullScheduleMatches: matches.filter((match) => match.fullSchedule).length,
    naturalEarlyFinishMatches: matches.filter((match) => match.naturalEarlyFinish).length,
    durationMs,
    warnings: [
      ...(seedCount < 2
        ? ['Only one independent seed cluster: confidence intervals are degenerate.']
        : []),
      ...(promotion?.eligibilityBlockers?.includes('skills-enabled-requires-hero-crossover')
        ? ['Promotion is blocked with skills enabled: hero identity is coupled to each logical competitor until a hero-crossover schedule is implemented.']
        : []),
      ...(promotion?.eligibilityBlockers?.includes('unbalanced-seat-schedule')
        ? ['Promotion is blocked unless every competitor visits every seat and the reflected table order is included.']
        : []),
      ...(promotion?.eligibilityBlockers?.includes('candidate-baseline-crossover-required')
        ? ['Promotion is blocked unless candidate and baseline each appear once and exchange logical table slots under the same deal seeds.']
        : []),
      ...(promotion?.eligibilityBlockers?.includes('blueprint-hit-rate-below-threshold')
        ? ['Blueprint promotion is blocked because the checkpoint did not cover enough candidate decisions.']
        : []),
      ...(promotion?.eligibilityBlockers?.includes('blueprint-influence-below-threshold')
        ? ['Blueprint promotion is blocked because its mean policy influence is too small.']
        : []),
      ...(promotion?.eligibilityBlockers?.includes('blueprint-action-change-rate-below-threshold')
        ? ['Blueprint promotion is blocked because it changed too few selected actions.']
        : []),
      ...(beliefCalibration && !beliefCalibration.passed
        ? ['Public-belief calibration did not improve both conditioned log-loss and Brier score over uniform.']
        : []),
    ],
    beliefCalibration,
    summary,
    promotion,
    matches,
  };
}
