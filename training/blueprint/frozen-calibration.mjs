// Independent exact-root action calibration for a frozen QYZ blueprint.
//
// The evaluator forces every legal root action under common random numbers,
// then follows one immutable continuation contract: frozen blueprint lookup
// (exact -> published backoffs) with a uniform legal fallback. Raw seeds never
// enter the artifact; only HMAC-derived opaque cluster identifiers are kept.

import { createHash, createHmac } from 'node:crypto';

import {
  EXACT_ROOT_CALIBRATION_EVALUATOR,
  EXACT_ROOT_CALIBRATION_SAMPLING_UNIT,
  EXACT_ROOT_CALIBRATION_SCHEMA,
  EXACT_ROOT_CALIBRATION_VERSION,
  blueprintBackoffKeys,
  compileBlueprintCheckpoint,
  frozenBlueprintPolicySha256,
  lookupBlueprintDistribution,
} from '../../js/game/blueprint-policy.js';
import { QyjTargetedHoldemGame } from './targeted.js';
import { SerializableRng } from './rng.js';
import {
  evaluateResidualInterventionSelector,
  validateResidualInterventionSelector,
} from './residual-selector.mjs';

const ACTION_ORDER = Object.freeze([
  'fold', 'check', 'call', 'raise:feint', 'raise:strike', 'raise:fierce', 'allin',
]);
const MAX_EVALUATOR_DEPTH = 160;
export const JOINT_CONTINUATION_OPTION_CALIBRATION_SCHEMA =
  'qyj-joint-continuation-option-calibration-v1';
const JOINT_CONTINUATION_OPTION_EVALUATOR = 'qyj-joint-continuation-option-evaluator-v2';

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > 1 + 1e-9) {
    throw new RangeError(`${label} must be normalized tournament utility in -1..1`);
  }
  return number;
}

function secretBytes(secret) {
  const bytes = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(String(secret || ''));
  if (bytes.length < 32) throw new RangeError('clusterIdSecret must contain at least 32 bytes');
  return bytes;
}

function normalizedSeeds(clusterSeeds, forbiddenSeedClusters) {
  if (!Array.isArray(clusterSeeds) || clusterSeeds.length < 2) {
    throw new RangeError('clusterSeeds must contain at least two independent new seeds');
  }
  if (!Array.isArray(forbiddenSeedClusters)) {
    throw new TypeError('forbiddenSeedClusters must explicitly list training/evaluation seeds');
  }
  const forbidden = new Set(forbiddenSeedClusters.map(String));
  const seen = new Set();
  return Object.freeze(clusterSeeds.map((rawSeed, index) => {
    const seed = String(rawSeed || '');
    if (!seed || seed.length > 512 || seen.has(seed)) {
      throw new RangeError(`clusterSeeds[${index}] must be unique and non-empty`);
    }
    if (forbidden.has(seed)) {
      throw new RangeError(`clusterSeeds[${index}] overlaps a forbidden prior seed cluster`);
    }
    seen.add(seed);
    return seed;
  }));
}

function opaqueClusterId(secret, seed) {
  return `fc_${createHmac('sha256', secret)
    .update(`${EXACT_ROOT_CALIBRATION_EVALUATOR}\0${seed}`)
    .digest('hex')}`;
}

function opaqueJointClusterId(secret, seed) {
  return `jc_${createHmac('sha256', secret)
    .update(`${JOINT_CONTINUATION_OPTION_EVALUATOR}\0${seed}`)
    .digest('hex')}`;
}

function sortedActions(actions) {
  return [...new Set(actions.map(String))].sort((left, right) => {
    const leftIndex = ACTION_ORDER.indexOf(left);
    const rightIndex = ACTION_ORDER.indexOf(right);
    return (leftIndex < 0 ? ACTION_ORDER.length : leftIndex)
      - (rightIndex < 0 ? ACTION_ORDER.length : rightIndex)
      || left.localeCompare(right);
  });
}

function fixedActionMask(targetKey) {
  const match = /(?:^|\|)lm=([^|]+)/.exec(String(targetKey));
  if (!match) throw new RangeError('exact target key has no fixed legal-action mask');
  return decodeURIComponent(match[1]).toLowerCase();
}

function meanVector(actionVectors, width, label) {
  if (!Array.isArray(actionVectors) || !actionVectors.length) {
    throw new RangeError(`${label}.actionVectors must be non-empty`);
  }
  const sums = new Array(width).fill(0);
  const corrections = new Array(width).fill(0);
  for (let sampleIndex = 0; sampleIndex < actionVectors.length; sampleIndex++) {
    const vector = actionVectors[sampleIndex];
    if (!Array.isArray(vector) || vector.length !== width) {
      throw new RangeError(`${label}.actionVectors[${sampleIndex}] has a changing action mask`);
    }
    for (let actionIndex = 0; actionIndex < width; actionIndex++) {
      const value = finite(vector[actionIndex], `${label}.actionVectors[${sampleIndex}]`);
      const adjusted = value - corrections[actionIndex];
      const next = sums[actionIndex] + adjusted;
      corrections[actionIndex] = (next - sums[actionIndex]) - adjusted;
      sums[actionIndex] = next;
    }
  }
  return sums.map((sum) => sum / actionVectors.length);
}

function provenance(checkpoint) {
  const source = checkpoint?.metadata?.tournamentValueSource;
  const modelSha = String(source?.sha256 || '').toLowerCase();
  const reportSha = String(source?.qualityReportSha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(modelSha) || !/^[0-9a-f]{64}$/.test(reportSha)) {
    throw new RangeError('frozen checkpoint must bind a promoted tournament model and report SHA');
  }
  return Object.freeze({ modelSha, reportSha });
}

function contractToken(value, label) {
  const token = String(value || '');
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(token)) {
    throw new TypeError(`${label} must be a stable lowercase policy contract token`);
  }
  return token;
}

/**
 * Build and validate a calibration attachment from independent cluster
 * samples. Each cluster supplies one or more complete paired action vectors;
 * those replicates are averaged before publication, preserving the cluster as
 * the only statistical sampling unit.
 */
export function buildFrozenExactRootCalibration(checkpoint, rawRecords, {
  clusterIdSecret,
  forbiddenSeedClusters,
  basePolicyContract,
  baseStyleKey,
  bootstrapIterations = 1000,
  counterfactual = false,
} = {}) {
  if (checkpoint?.exactRootCalibration != null) {
    throw new RangeError('calibration must bind the original frozen checkpoint, not an attachment');
  }
  compileBlueprintCheckpoint(checkpoint);
  if (!Array.isArray(rawRecords) || !rawRecords.length) {
    throw new RangeError('rawRecords must contain at least one exact root');
  }
  if (!Number.isSafeInteger(bootstrapIterations)
    || bootstrapIterations < 200 || bootstrapIterations > 10_000) {
    throw new RangeError('bootstrapIterations must be in 200..10000');
  }
  const secret = secretBytes(clusterIdSecret);
  const { modelSha, reportSha } = provenance(checkpoint);
  const policySha = frozenBlueprintPolicySha256(checkpoint);
  const boundBasePolicyContract = contractToken(basePolicyContract, 'basePolicyContract');
  const boundBaseStyleKey = contractToken(baseStyleKey, 'baseStyleKey');
  const records = Object.create(null);
  for (const rawRecord of [...rawRecords]
    .sort((left, right) => String(left?.informationSetKey)
      .localeCompare(String(right?.informationSetKey)))) {
    const key = String(rawRecord?.informationSetKey || '');
    if (!key.startsWith('bp2|') || key.includes('|bk=') || records[key]) {
      throw new RangeError('calibration records require unique exact bp2 keys');
    }
    const actionMask = String(rawRecord.actionMask || '').toLowerCase();
    if (actionMask !== fixedActionMask(key)) {
      throw new RangeError(`calibration record ${key} changed its legal-action mask`);
    }
    const actionKeys = sortedActions(rawRecord.actionKeys || []);
    if (!actionKeys.length
      || actionKeys.length !== rawRecord.actionKeys.length
      || actionKeys.some((actionKey, index) => actionKey !== rawRecord.actionKeys[index])) {
      throw new RangeError(`calibration record ${key} actionKeys are not one canonical fixed vector`);
    }
    const seeds = normalizedSeeds(
      (rawRecord.clusters || []).map((cluster) => cluster?.seedCluster),
      forbiddenSeedClusters,
    );
    const clusters = rawRecord.clusters.map((cluster, index) => ({
      clusterId: opaqueClusterId(secret, seeds[index]),
      values: meanVector(cluster.actionVectors, actionKeys.length,
        `calibration record ${key}.clusters[${index}]`),
    }));
    records[key] = {
      frozenPolicySha256: policySha,
      tournamentValueModelSha256: modelSha,
      tournamentValueReportSha256: reportSha,
      evaluatorVersion: EXACT_ROOT_CALIBRATION_EVALUATOR,
      samplingUnit: EXACT_ROOT_CALIBRATION_SAMPLING_UNIT,
      basePolicyContract: boundBasePolicyContract,
      baseStyleKey: boundBaseStyleKey,
      independentClusterCount: clusters.length,
      actionMask,
      actionKeys,
      clusters,
    };
  }
  const artifact = {
    schema: counterfactual
      ? 'qyj-counterfactual-root-action-calibration-v1'
      : EXACT_ROOT_CALIBRATION_SCHEMA,
    version: EXACT_ROOT_CALIBRATION_VERSION,
    frozenPolicySha256: policySha,
    tournamentValueModelSha256: modelSha,
    tournamentValueReportSha256: reportSha,
    evaluatorVersion: EXACT_ROOT_CALIBRATION_EVALUATOR,
    samplingUnit: EXACT_ROOT_CALIBRATION_SAMPLING_UNIT,
    basePolicyContract: boundBasePolicyContract,
    baseStyleKey: boundBaseStyleKey,
    confidenceLevel: 0.95,
    bootstrapIterations,
    records,
  };
  // Exercise the browser compiler now; an invalid mask, binding or vector can
  // never escape the offline builder as a publishable artifact.
  if (!counterfactual) {
    compileBlueprintCheckpoint({ ...checkpoint, exactRootCalibration: artifact });
  }
  return artifact;
}

/** Attach independent evidence without changing the frozen policy digest. */
export function attachFrozenExactRootCalibration(checkpoint, calibration) {
  if (checkpoint?.exactRootCalibration != null) {
    throw new RangeError('checkpoint already contains exact-root calibration');
  }
  const attached = { ...checkpoint, exactRootCalibration: calibration };
  compileBlueprintCheckpoint(attached);
  return attached;
}

function frozenContinuationDistribution(game, state, checkpoint) {
  const legal = new Set(game.legalActions(state));
  const key = game.infoSetKey(state, game.currentPlayer(state));
  for (const candidateKey of [key, ...blueprintBackoffKeys(key)]) {
    const infoSet = lookupBlueprintDistribution(checkpoint, candidateKey);
    if (!infoSet) continue;
    const candidates = infoSet.strategy.filter((entry) => legal.has(entry.actionKey));
    const total = candidates.reduce((sum, entry) => sum + entry.probability, 0);
    if (!(total > 0)) continue;
    return candidates.map((candidate) => ({
      actionKey: candidate.actionKey,
      probability: candidate.probability / total,
    }));
  }
  // Versioned, immutable fallback for states absent from the frozen policy.
  const actions = sortedActions([...legal]);
  return actions.map((actionKey) => ({ actionKey, probability: 1 / actions.length }));
}

function sampleDistribution(distribution, rng) {
  let roll = rng.next();
  for (const candidate of distribution) {
    roll -= candidate.probability;
    if (roll < 0) return candidate.actionKey;
  }
  return distribution.at(-1).actionKey;
}

function sampleFrozenContinuation(game, state, checkpoint, rng) {
  return sampleDistribution(frozenContinuationDistribution(game, state, checkpoint), rng);
}

function rolloutForcedRootAction(game, root, rootAction, checkpoint, rng) {
  let state = game.nextState(root, rootAction);
  for (let depth = 1; depth <= MAX_EVALUATOR_DEPTH; depth++) {
    if (game.isTerminal(state)) return game.utility(state, root.targetActor);
    const action = sampleFrozenContinuation(game, state, checkpoint, rng);
    state = game.nextState(state, action);
  }
  throw new RangeError(`frozen continuation exceeded evaluator depth ${MAX_EVALUATOR_DEPTH}`);
}

function rolloutJointContinuationOption(game, root, checkpoint, rng, selector = null) {
  let state = root;
  let controlledDecisions = 0;
  let optionActive = selector != null;
  let optionStartInformationSetKey = null;
  for (let depth = 0; depth <= MAX_EVALUATOR_DEPTH; depth++) {
    if (game.isTerminal(state)) {
      return {
        utility: game.utility(state, root.targetActor),
        controlledDecisions,
      };
    }
    const currentPlayer = game.currentPlayer(state);
    const baseDistribution = frozenContinuationDistribution(game, state, checkpoint);
    let distribution = baseDistribution;
    if (optionActive && currentPlayer === root.targetActor
      && controlledDecisions < selector.optionHorizon) {
      const informationSetKey = game.infoSetKey(state, currentPlayer);
      const selection = evaluateResidualInterventionSelector(selector, {
        informationSetKey,
        startInformationSetKey: optionStartInformationSetKey,
        tableSize: selector.tableSize,
        continuation: controlledDecisions > 0,
        prediction: {
          accepted: true,
          fallbackFeatureCount: 0,
          shadowTV: 0,
          baseDistribution,
        },
      });
      if (selection.eligible) {
        distribution = selection.distribution;
        if (controlledDecisions === 0) optionStartInformationSetKey = informationSetKey;
        controlledDecisions++;
      } else optionActive = false;
    }
    state = game.nextState(state, sampleDistribution(distribution, rng));
  }
  throw new RangeError(`joint continuation exceeded evaluator depth ${MAX_EVALUATOR_DEPTH}`);
}

function pairedLowerBound(values) {
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length < 2) return { mean: average, lowerBound: -Infinity };
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0)
    / (values.length - 1);
  const tOneSided = 1.644854 + 0.710 / (values.length - 1);
  return {
    mean: average,
    lowerBound: average - tOneSided * Math.sqrt(variance / values.length),
  };
}

function validatePromotedTournamentTexts(checkpoint, modelText, reportText) {
  const modelSha = sha256(modelText);
  const reportSha = sha256(reportText);
  const source = provenance(checkpoint);
  if (modelSha !== source.modelSha || reportSha !== source.reportSha) {
    throw new RangeError('tournament model/report bytes do not match frozen checkpoint SHA binding');
  }
  const report = JSON.parse(reportText);
  if (report?.schema !== 'qyj-tournament-value-quality-v1'
    || report?.version !== 1 || report?.promotion?.passed !== true
    || report?.model?.sha256 !== modelSha) {
    throw new RangeError('tournament value report has not formally promoted these model bytes');
  }
  return JSON.parse(modelText);
}

/**
 * End-to-end exact-root evaluator. `clusterSeeds` must be a fresh set and
 * `forbiddenSeedClusters` must contain every training/tuning/evaluation seed
 * namespace known to the caller. No policy update occurs during evaluation.
 */
export function evaluateFrozenExactRootCalibration(rawTargets, {
  checkpoint,
  tournamentValueModelText,
  tournamentValueReportText,
  clusterSeeds,
  forbiddenSeedClusters,
  clusterIdSecret,
  basePolicyContract,
  baseStyleKey,
  rolloutsPerCluster = 32,
  bootstrapIterations = 1000,
  allowCounterfactualRoots = false,
} = {}) {
  if (checkpoint?.exactRootCalibration != null) {
    throw new RangeError('evaluation requires the unmodified frozen checkpoint');
  }
  const compiledCheckpoint = compileBlueprintCheckpoint(checkpoint);
  const tournamentValueModel = validatePromotedTournamentTexts(
    checkpoint, tournamentValueModelText, tournamentValueReportText,
  );
  const seeds = normalizedSeeds(clusterSeeds, forbiddenSeedClusters);
  if (!Number.isSafeInteger(rolloutsPerCluster) || rolloutsPerCluster < 1) {
    throw new RangeError('rolloutsPerCluster must be a positive safe integer');
  }
  const targets = Array.isArray(rawTargets) ? rawTargets : [rawTargets];
  if (!targets.length) throw new RangeError('at least one exact target is required');
  const grouped = new Map();
  for (const target of targets) {
    const key = String(target?.targetKey || '');
    const list = grouped.get(key) || [];
    list.push(target);
    grouped.set(key, list);
  }
  const maxRaisesPerStreet = Number(checkpoint?.metadata?.maxRaisesPerStreet);
  const terminalUtility = checkpoint?.metadata?.terminalUtility || {};
  const records = [];
  for (const key of [...grouped.keys()].sort()) {
    const game = new QyjTargetedHoldemGame(grouped.get(key), {
      maxRaisesPerStreet: Number.isSafeInteger(maxRaisesPerStreet)
        ? maxRaisesPerStreet : 3,
      tournamentValueModel,
      tournamentValueMaxUncertainty: terminalUtility.maxUncertainty,
      tournamentValueMaxOodScore: terminalUtility.maxOodScore,
      tournamentValueFallbackShareScale: terminalUtility.fallbackShareScale,
    });
    if (game.tournamentUtility?.diagnostics().enabled !== true) {
      throw new RangeError(`exact root ${key} failed tournament continuation preflight`);
    }
    let fixedActions = null;
    const clusters = seeds.map((seedCluster, clusterIndex) => {
      const actionVectors = [];
      for (let rollout = 0; rollout < rolloutsPerCluster; rollout++) {
        const root = game.createInitialState(
          new SerializableRng(`${seedCluster}|deal|${rollout}`),
          { iteration: rollout },
        );
        const actions = sortedActions(game.legalActions(root));
        if (fixedActions == null) fixedActions = actions;
        if (actions.length !== fixedActions.length
          || actions.some((action, index) => action !== fixedActions[index])) {
          throw new RangeError(`exact root ${key} changed legal action mask across samples`);
        }
        actionVectors.push(actions.map((rootAction) => rolloutForcedRootAction(
          game,
          root,
          rootAction,
          compiledCheckpoint,
          new SerializableRng(`${seedCluster}|continuation|${rollout}`),
        )));
      }
      // Keep raw seed only in this transient builder input. It is HMACed by
      // buildFrozenExactRootCalibration and never returned.
      return { seedCluster, clusterIndex, actionVectors };
    });
    records.push({
      informationSetKey: key,
      actionMask: fixedActionMask(key),
      actionKeys: fixedActions,
      clusters,
    });
  }
  return buildFrozenExactRootCalibration(checkpoint, records, {
    clusterIdSecret,
    forbiddenSeedClusters,
    basePolicyContract,
    baseStyleKey,
    bootstrapIterations,
    counterfactual: allowCounterfactualRoots,
  });
}

/**
 * Evaluate a complete, stateful option against the frozen continuation under
 * paired common random numbers. The option may control only the target actor
 * and only for its declared horizon; all other decisions use the frozen
 * checkpoint continuation contract.
 */
export function evaluateFrozenJointContinuationOption(rawTargets, {
  checkpoint,
  optionSelector,
  tournamentValueModelText,
  tournamentValueReportText,
  clusterSeeds,
  forbiddenSeedClusters,
  clusterIdSecret,
  rolloutsPerCluster = 8,
} = {}) {
  if (checkpoint?.exactRootCalibration != null) {
    throw new RangeError('joint option evaluation requires the unmodified frozen checkpoint');
  }
  const compiledCheckpoint = compileBlueprintCheckpoint(checkpoint);
  const selector = validateResidualInterventionSelector(optionSelector);
  if (!Number.isInteger(Number(selector.optionHorizon)) || Number(selector.optionHorizon) < 2) {
    throw new TypeError('joint option evaluation requires a continuation option selector');
  }
  const tournamentValueModel = validatePromotedTournamentTexts(
    checkpoint, tournamentValueModelText, tournamentValueReportText,
  );
  const seeds = normalizedSeeds(clusterSeeds, forbiddenSeedClusters);
  const secret = secretBytes(clusterIdSecret);
  if (!Number.isSafeInteger(rolloutsPerCluster) || rolloutsPerCluster < 1) {
    throw new RangeError('rolloutsPerCluster must be a positive safe integer');
  }
  const targets = Array.isArray(rawTargets) ? rawTargets : [rawTargets];
  if (!targets.length) throw new RangeError('at least one exact target is required');
  const grouped = new Map();
  for (const target of targets) {
    const key = String(target?.targetKey || '');
    const list = grouped.get(key) || [];
    list.push(target);
    grouped.set(key, list);
  }
  const maxRaisesPerStreet = Number(checkpoint?.metadata?.maxRaisesPerStreet);
  const terminalUtility = checkpoint?.metadata?.terminalUtility || {};
  const records = {};
  for (const key of [...grouped.keys()].sort()) {
    const game = new QyjTargetedHoldemGame(grouped.get(key), {
      maxRaisesPerStreet: Number.isSafeInteger(maxRaisesPerStreet)
        ? maxRaisesPerStreet : 3,
      tournamentValueModel,
      tournamentValueMaxUncertainty: terminalUtility.maxUncertainty,
      tournamentValueMaxOodScore: terminalUtility.maxOodScore,
      tournamentValueFallbackShareScale: terminalUtility.fallbackShareScale,
    });
    if (game.tournamentUtility?.diagnostics().enabled !== true) {
      throw new RangeError(`exact root ${key} failed tournament continuation preflight`);
    }
    const clusters = seeds.map((seedCluster) => {
      const baselineValues = [];
      const optionValues = [];
      let controlledDecisions = 0;
      let horizonReached = 0;
      for (let rollout = 0; rollout < rolloutsPerCluster; rollout++) {
        const dealSeed = `${seedCluster}|joint-deal|${rollout}`;
        const continuationSeed = `${seedCluster}|joint-continuation|${rollout}`;
        const baselineRoot = game.createInitialState(
          new SerializableRng(dealSeed), { iteration: rollout },
        );
        const optionRoot = game.createInitialState(
          new SerializableRng(dealSeed), { iteration: rollout },
        );
        const baseline = rolloutJointContinuationOption(
          game, baselineRoot, compiledCheckpoint,
          new SerializableRng(continuationSeed), null,
        );
        const option = rolloutJointContinuationOption(
          game, optionRoot, compiledCheckpoint,
          new SerializableRng(continuationSeed), selector,
        );
        baselineValues.push(baseline.utility);
        optionValues.push(option.utility);
        controlledDecisions += option.controlledDecisions;
        if (option.controlledDecisions >= selector.optionHorizon) horizonReached++;
      }
      const baseline = baselineValues.reduce((sum, value) => sum + value, 0)
        / baselineValues.length;
      const option = optionValues.reduce((sum, value) => sum + value, 0)
        / optionValues.length;
      return {
        clusterId: opaqueJointClusterId(secret, seedCluster),
        baseline,
        option,
        advantage: option - baseline,
        controlledDecisions,
        horizonReached,
      };
    });
    const evidence = pairedLowerBound(clusters.map((cluster) => cluster.advantage));
    records[key] = {
      independentClusterCount: clusters.length,
      rolloutsPerCluster,
      meanAdvantage: evidence.mean,
      lowerBound: evidence.lowerBound,
      controlledDecisions: clusters.reduce(
        (sum, cluster) => sum + cluster.controlledDecisions, 0,
      ),
      horizonReached: clusters.reduce((sum, cluster) => sum + cluster.horizonReached, 0),
      clusters,
    };
  }
  const { modelSha, reportSha } = provenance(checkpoint);
  return Object.freeze({
    schema: JOINT_CONTINUATION_OPTION_CALIBRATION_SCHEMA,
    version: 1,
    mode: 'offline-evaluation-only',
    evaluatorVersion: JOINT_CONTINUATION_OPTION_EVALUATOR,
    samplingUnit: EXACT_ROOT_CALIBRATION_SAMPLING_UNIT,
    optionSelectorSha256: sha256(JSON.stringify(selector)),
    optionSelectorSchema: selector.schema,
    optionHorizon: selector.optionHorizon,
    frozenPolicySha256: frozenBlueprintPolicySha256(checkpoint),
    tournamentValueModelSha256: modelSha,
    tournamentValueReportSha256: reportSha,
    records,
    promotionEligible: false,
    promotionBlockers: [
      'joint-option-calibration-below-formal-scale',
      'offline-evaluation-only',
    ],
  });
}
