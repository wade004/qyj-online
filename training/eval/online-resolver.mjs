import { createHash } from 'node:crypto';

import {
  buildBlueprintInfoSetKey,
  compileBlueprintCheckpoint,
} from '../../js/game/blueprint-policy.js';
import { QYJ_BASE_POLICY_CONTRACT } from '../../js/game/ai-policy.js';
import {
  attachFrozenExactRootCalibration,
  evaluateFrozenExactRootCalibration,
} from '../blueprint/frozen-calibration.mjs';
import { buildExactInfosetTrainingSnapshot } from '../blueprint/target-profile.js';
import {
  filterTournamentSafeTargets,
  trainSingleTargetedBlueprint,
} from '../blueprint/targeted.js';

export const ONLINE_RESOLVER_SCHEMA = 'qyj-public-belief-online-resolver-v1';
export const ONLINE_RESOLVER_VERSION = 1;

function integer(raw, label, min, max) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be a safe integer in ${min}..${max}`);
  }
  return value;
}

function digest(raw, label) {
  const value = String(raw || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function finite(raw, label, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${label} must be finite in ${min}..${max}`);
  }
  return value;
}

/**
 * Convert one live, actor-private Observation into the exact allow-listed
 * public-belief root accepted by targeted MCCFR. Opponent hole cards never
 * enter this object; only the acting player's own cards are retained.
 */
export function buildOnlineResolverTarget(observation, {
  maxRaisesPerStreet = 3,
} = {}) {
  const cap = integer(maxRaisesPerStreet, 'maxRaisesPerStreet', 0, 3);
  const profiled = buildExactInfosetTrainingSnapshot(observation);
  const actorIdx = integer(profiled.observerIdx, 'observation.observerIdx', 1, 9);
  const { observerIdx: _observerIdx, ...snapshot } = profiled;
  const targetKey = buildBlueprintInfoSetKey(observation, {
    opts: observation.legalActions,
    maxRaisesPerStreet: cap,
  });
  return Object.freeze({ targetKey, actorIdx, snapshot });
}

function sourceContract(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('tournamentValueSource is required');
  }
  return Object.freeze({
    schema: String(raw.schema || ''),
    version: integer(raw.version, 'tournamentValueSource.version', 1, 100),
    sha256: digest(raw.sha256, 'tournamentValueSource.sha256'),
    qualityReportSha256: digest(
      raw.qualityReportSha256, 'tournamentValueSource.qualityReportSha256',
    ),
    datasetSha256: raw.datasetSha256 == null
      ? null : digest(raw.datasetSha256, 'tournamentValueSource.datasetSha256'),
  });
}

function safePreflight(diagnostics) {
  return Object.freeze({
    selectedExactKeys: Number(diagnostics?.selectedExactKeys) || 0,
    acceptedExactKeys: Number(diagnostics?.acceptedExactKeys) || 0,
    rejectedExactKeys: Number(diagnostics?.rejectedExactKeys) || 0,
    selectedTargetVariants: Number(diagnostics?.selectedTargetVariants) || 0,
    acceptedTargetVariants: Number(diagnostics?.acceptedTargetVariants) || 0,
    rejectedTargetVariants: Number(diagnostics?.rejectedTargetVariants) || 0,
    rejectionReasons: Object.freeze({ ...(diagnostics?.rejectionReasons || {}) }),
  });
}

/**
 * Deterministic, simulation-budgeted public subgame solve. This deliberately
 * returns a one-root ephemeral checkpoint: publication/deployment remains the
 * responsibility of the independent league promotion gate.
 */
export function solveOnlineResolverTarget(target, {
  tournamentValueModel,
  tournamentValueSource,
  tournamentValueModelText = null,
  tournamentValueReportText = null,
  simulationBudget = 12,
  validationClusterCount = 0,
  validationRolloutsPerCluster = 1,
  seedNamespace = 'qyj-online-resolver-v1',
  maxRaisesPerStreet = 3,
  maxDepth = 160,
  beliefTemperature = 0.5,
  tournamentValueMaxUncertainty = 0.75,
  tournamentValueMaxOodScore = 1,
  tournamentValueFallbackShareScale = 2,
} = {}) {
  if (!tournamentValueModel) throw new TypeError('tournamentValueModel is required');
  const source = sourceContract(tournamentValueSource);
  const budget = integer(simulationBudget, 'simulationBudget', 2, 256);
  const validationClusters = integer(
    validationClusterCount, 'validationClusterCount', 0, 256,
  );
  const validationRollouts = integer(
    validationRolloutsPerCluster, 'validationRolloutsPerCluster', 1, 256,
  );
  if (validationClusters > 0 && validationClusters < Math.min(20, budget)) {
    throw new RangeError('validationClusterCount must cover the checkpoint advantage floor');
  }
  const cap = integer(maxRaisesPerStreet, 'maxRaisesPerStreet', 0, 3);
  const depth = integer(maxDepth, 'maxDepth', 16, 512);
  const temperature = finite(beliefTemperature, 'beliefTemperature', 0, 1);
  const maxUncertainty = finite(
    tournamentValueMaxUncertainty, 'tournamentValueMaxUncertainty', 0, 10,
  );
  const maxOodScore = finite(tournamentValueMaxOodScore, 'tournamentValueMaxOodScore', 0, 10);
  const fallbackShareScale = finite(
    tournamentValueFallbackShareScale, 'tournamentValueFallbackShareScale', 0, 10,
  );
  const filter = filterTournamentSafeTargets([target], {
    maxRaisesPerStreet: cap,
    beliefTemperature: temperature,
    tournamentValueModel,
    tournamentValueMaxUncertainty: maxUncertainty,
    tournamentValueMaxOodScore: maxOodScore,
    tournamentValueFallbackShareScale: fallbackShareScale,
    publishSubgameNodes: true,
  });
  if (filter.targets.length !== 1 || filter.diagnostics.acceptedExactKeys !== 1) {
    return Object.freeze({
      checkpoint: null,
      diagnostics: Object.freeze({
        schema: ONLINE_RESOLVER_SCHEMA,
        version: ONLINE_RESOLVER_VERSION,
        accepted: false,
        reason: 'tournament-root-preflight-rejected',
        simulationBudget: budget,
        utilitySamples: 0,
        tournamentValueSource: source,
        preflight: safePreflight(filter.diagnostics),
      }),
    });
  }

  const trainingSeed = `${String(seedNamespace)}|train|${target.targetKey}`;
  let checkpoint = trainSingleTargetedBlueprint(filter.targets[0], {
    visitsPerTarget: budget,
    seed: trainingSeed,
    maxRaisesPerStreet: cap,
    // The online resolver publishes a pure local strategy; the runtime league
    // still applies its own bounded mixing and empirical advantage guard.
    blendWeight: 1,
    maxDepth: depth,
    beliefTemperature: temperature,
    tournamentValueModel,
    tournamentValueMaxUncertainty: maxUncertainty,
    tournamentValueMaxOodScore: maxOodScore,
    tournamentValueFallbackShareScale: fallbackShareScale,
  });
  if (checkpoint.metadata?.terminalUtility?.enabled !== true
    || checkpoint.metadata?.targetCount !== 1
    || checkpoint.infosets?.[target.targetKey]?.visits !== budget) {
    throw new Error('online resolver failed its exact-root tournament-value contract');
  }
  checkpoint.metadata.onlineResolver = {
    schema: ONLINE_RESOLVER_SCHEMA,
    version: ONLINE_RESOLVER_VERSION,
    deterministicSimulationBudget: budget,
    ephemeralExactRootOnly: true,
    failClosedTournamentRootPreflight: true,
  };
  checkpoint.metadata.publication = {
    exactOnly: false,
    minExactVisits: budget,
    backoffPublished: false,
    ephemeral: true,
    onlineSubgameNodes: true,
  };
  checkpoint.metadata.tournamentValueSource = source;
  if (validationClusters > 0) {
    if (typeof tournamentValueModelText !== 'string'
      || typeof tournamentValueReportText !== 'string') {
      throw new TypeError('independent validation requires tournament model/report text');
    }
    if (createHash('sha256').update(tournamentValueModelText).digest('hex') !== source.sha256
      || createHash('sha256').update(tournamentValueReportText).digest('hex')
        !== source.qualityReportSha256) {
      throw new RangeError('independent validation model/report text violates provenance binding');
    }
    const rootFingerprint = createHash('sha256')
      .update(JSON.stringify(target)).digest('hex');
    const validationSeeds = Array.from({ length: validationClusters }, (_, index) => (
      `${String(seedNamespace)}|validate|${rootFingerprint}|cluster:${index}`
    ));
    const calibration = evaluateFrozenExactRootCalibration(filter.targets[0], {
      checkpoint,
      tournamentValueModelText,
      tournamentValueReportText,
      clusterSeeds: validationSeeds,
      forbiddenSeedClusters: [trainingSeed],
      clusterIdSecret: `${source.sha256}|qyj-online-resolver-calibration-v1`,
      basePolicyContract: QYJ_BASE_POLICY_CONTRACT,
      baseStyleKey: 'tag',
      rolloutsPerCluster: validationRollouts,
      bootstrapIterations: 200,
    });
    checkpoint = attachFrozenExactRootCalibration(checkpoint, calibration);
  }
  const compiled = compileBlueprintCheckpoint(checkpoint, { maxInfosets: 100_000 });
  return Object.freeze({
    checkpoint: compiled,
    diagnostics: Object.freeze({
      schema: ONLINE_RESOLVER_SCHEMA,
      version: ONLINE_RESOLVER_VERSION,
      accepted: true,
      reason: null,
      simulationBudget: budget,
      utilitySamples: Number(checkpoint.metadata.utilitySamples) || 0,
      rootVisits: checkpoint.infosets[target.targetKey].visits,
      subgameInfoSets: Object.keys(checkpoint.infosets).length,
      validationClusterCount: validationClusters,
      validationRolloutsPerCluster: validationClusters > 0 ? validationRollouts : 0,
      tableSize: target.snapshot.publicSeatCapacity,
      tournamentValueSource: source,
      preflight: safePreflight(filter.diagnostics),
    }),
  });
}
