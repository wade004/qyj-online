import {
  BLUEPRINT_ABSTRACTION,
  BLUEPRINT_SCHEMA,
  BLUEPRINT_VERSION,
  DEFAULT_BLUEPRINT_ADVANTAGE_MIN_SAMPLES,
  DEFAULT_BLUEPRINT_ADVANTAGE_Z,
  blueprintBackoffKeys,
  compileBlueprintCheckpoint,
} from '../../js/game/blueprint-policy.js';
import { ExternalSamplingMccfr } from './mccfr.js';
import { QyjAbstractHoldemGame } from './qyj-abstract-game.js';

const PUBLICATION_LEVELS = Object.freeze([
  'exact', 'history', 'position', 'strategic', 'population',
]);
const SOURCE_EXACT_VISITS_DEFINITION = 'sum of exact traverser visits before publication thresholds and hierarchical backoff expansion';
const SOURCE_EXACT_ROOTS_DEFINITION = 'count of distinct exact information-set keys before publication thresholds and hierarchical backoff expansion';
const PUBLISHED_EXACT_FALLBACK_DEFINITION = 'sum of published exact-node support because pre-publication source support was not recorded';
const PUBLISHED_EXACT_ROOTS_FALLBACK_DEFINITION = 'count of published exact nodes because pre-publication distinct source roots were not recorded';

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return number;
}

function integerList(values, label, min, max) {
  const list = [...new Set((Array.isArray(values) ? values : []).map(Number))].sort((a, b) => a - b);
  if (!list.length || list.some((value) => !Number.isInteger(value) || value < min || value > max)) {
    throw new RangeError(`${label} must contain integers in ${min}..${max}`);
  }
  return Object.freeze(list);
}

function percentile(sorted, probability) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(probability * sorted.length))];
}

function exactSourceVisits(checkpoint) {
  let visits = 0;
  for (const [key, value] of Object.entries(checkpoint?.infosets || {})) {
    if (key.includes('|bk=')) continue;
    const count = Number(value?.visits);
    if (Number.isSafeInteger(count) && count > 0) visits += count;
  }
  return visits;
}

function exactSourceKeys(checkpoint) {
  return new Set(Object.keys(checkpoint?.infosets || {})
    .filter((key) => !key.includes('|bk=')));
}

function mergeMoment(target, raw, label) {
  const samples = Number(raw?.samples);
  const mean = Number(raw?.mean);
  const m2 = Number(raw?.m2);
  if (!Number.isSafeInteger(samples) || samples < 0
    || !Number.isFinite(mean) || !Number.isFinite(m2) || m2 < 0) {
    throw new TypeError(`${label} contains invalid action-value moments`);
  }
  if (samples === 0) {
    if (mean !== 0 || m2 !== 0) throw new RangeError(`${label} zero-sample moments must be zero`);
    return target;
  }
  if (target.samples === 0) {
    target.samples = samples;
    target.mean = mean;
    target.m2 = m2;
    return target;
  }
  const combinedSamples = target.samples + samples;
  if (!Number.isSafeInteger(combinedSamples)) {
    throw new RangeError(`${label} sample count exceeds Number.MAX_SAFE_INTEGER`);
  }
  const delta = mean - target.mean;
  target.mean += delta * samples / combinedSamples;
  target.m2 += m2 + delta * delta * target.samples * samples / combinedSamples;
  target.samples = combinedSamples;
  return target;
}

function advantageGuardMetadata({ enabled = true } = {}) {
  return Object.freeze({
    enabled: enabled === true,
    minSamples: DEFAULT_BLUEPRINT_ADVANTAGE_MIN_SAMPLES,
    confidenceZ: DEFAULT_BLUEPRINT_ADVANTAGE_Z,
    minLowerBound: 0,
    estimator: 'external-sampling-action-utility-welford-lcb',
  });
}

function recordedSourceExactVisits(checkpoint) {
  const visits = Number(checkpoint?.metadata?.publication?.sourceExactVisits);
  return Number.isSafeInteger(visits) && visits >= 0 ? visits : null;
}

function recordedSourceExactRootCount(checkpoint) {
  const count = Number(checkpoint?.metadata?.publication?.sourceExactRootCount);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function normalizeReachSupport(reachSupport) {
  if (reachSupport == null) {
    return Object.freeze({
      byExactKey: new Map(),
      profileCount: 0,
      profileSources: Object.freeze([]),
      promotionEligible: false,
      promotionBlockers: Object.freeze(['reach-evidence-not-supplied']),
      sourceGroupSecretId: null,
    });
  }
  if (!(reachSupport?.byExactKey instanceof Map)) {
    throw new TypeError('reachSupport.byExactKey must be a Map');
  }
  const byExactKey = new Map();
  for (const [key, raw] of reachSupport.byExactKey) {
    if (typeof key !== 'string' || !key.startsWith('bp2|') || key.includes('|bk=')) {
      throw new TypeError('reach support contains an invalid exact key');
    }
    const decisions = Number(raw?.decisions);
    if (!Number.isSafeInteger(decisions) || decisions < 1) {
      throw new RangeError('reach support decisions must be positive safe integers');
    }
    const profileIds = raw?.profileIds instanceof Set
      ? new Set(raw.profileIds) : new Set(raw?.profileIds || []);
    if ([...profileIds].some((value) => !Number.isSafeInteger(Number(value))
      || Number(value) < 0)) {
      throw new TypeError('reach support profile IDs must be non-negative integers');
    }
    const sourceGroups = raw?.sourceGroups instanceof Set
      ? new Set(raw.sourceGroups) : new Set(raw?.sourceGroups || []);
    if ([...sourceGroups].some((value) => !/^pg_[0-9a-f]{64}$/.test(String(value)))) {
      throw new TypeError('reach support contains an invalid opaque source group');
    }
    byExactKey.set(key, Object.freeze({ decisions, profileIds, sourceGroups }));
  }
  const profileSources = Array.isArray(reachSupport.profileSources)
    ? reachSupport.profileSources.map((source) => Object.freeze({ ...source })) : [];
  return Object.freeze({
    byExactKey,
    profileCount: Number.isSafeInteger(Number(reachSupport.profileCount))
      ? Number(reachSupport.profileCount) : profileSources.length,
    profileSources: Object.freeze(profileSources),
    promotionEligible: reachSupport.promotionEligible === true,
    promotionBlockers: Object.freeze([...(reachSupport.promotionBlockers || [])]),
    sourceGroupSecretId: reachSupport.sourceGroupSecretId || null,
  });
}

function reachSummary(sourceKeys, evidence) {
  const profiles = new Set();
  const sourceGroups = new Set();
  let decisions = 0;
  let roots = 0;
  for (const key of sourceKeys) {
    const support = evidence.byExactKey.get(key);
    if (!support) continue;
    roots++;
    decisions += support.decisions;
    for (const profileId of support.profileIds) profiles.add(profileId);
    for (const sourceGroup of support.sourceGroups) sourceGroups.add(sourceGroup);
  }
  return Object.freeze({
    sourceReachDecisions: decisions,
    sourceReachRootCount: roots,
    sourceReachProfileCount: profiles.size,
    sourceReachGroupCount: sourceGroups.size,
    reachEvidenceAvailable: evidence.promotionEligible,
    reachEvidenceBlockers: evidence.promotionBlockers,
    sourceGroupSecretId: evidence.sourceGroupSecretId,
    reachProfiles: evidence.profileSources,
  });
}

function publicationMetadata(
  thresholds,
  sourceExactVisits,
  sourceExactRootCount,
  evidenceSummary = {},
) {
  return Object.freeze({
    ...thresholds,
    sourceExactVisits,
    sourceExactVisitsDefinition: SOURCE_EXACT_VISITS_DEFINITION,
    sourceExactRootCount,
    sourceExactRootCountDefinition: SOURCE_EXACT_ROOTS_DEFINITION,
    sourceReachDecisions: Number(evidenceSummary.sourceReachDecisions) || 0,
    sourceReachRootCount: Number(evidenceSummary.sourceReachRootCount) || 0,
    sourceReachProfileCount: Number(evidenceSummary.sourceReachProfileCount) || 0,
    sourceReachGroupCount: Number(evidenceSummary.sourceReachGroupCount) || 0,
    reachEvidenceAvailable: evidenceSummary.reachEvidenceAvailable === true,
    reachEvidenceBlockers: evidenceSummary.reachEvidenceBlockers || Object.freeze([]),
    sourceGroupSecretId: evidenceSummary.sourceGroupSecretId || null,
    reachProfiles: evidenceSummary.reachProfiles || Object.freeze([]),
  });
}

export function summarizeBlueprintCoverage(checkpoint) {
  const entries = Object.entries(checkpoint?.infosets || {});
  const visits = entries.map(([, value]) => Number(value?.visits) || 0).sort((a, b) => a - b);
  const byPlayers = Object.create(null);
  const byRoundLevel = Object.create(null);
  const byBackoffLevel = Object.create(null);
  const levels = Object.fromEntries(PUBLICATION_LEVELS.map((level) => [level, {
    nodeCount: 0,
    supportVisits: 0,
    sourceExactRootReferences: 0,
    sourceReachDecisions: 0,
    sourceReachGroupReferences: 0,
    reachSupportedNodes: 0,
    sourceRootCounts: [],
  }]));
  for (const [key, value] of entries) {
    const players = /\|n=([^|]+)/.exec(key)?.[1] || 'unknown';
    const roundLevel = /\|r=([^|]+)/.exec(key)?.[1] || 'unknown';
    byPlayers[players] = (byPlayers[players] || 0) + 1;
    byRoundLevel[roundLevel] = (byRoundLevel[roundLevel] || 0) + 1;
    const backoffLevel = /\|bk=([^|]+)/.exec(key)?.[1] || 'exact';
    byBackoffLevel[backoffLevel] = (byBackoffLevel[backoffLevel] || 0) + 1;
    levels[backoffLevel] ||= {
      nodeCount: 0,
      supportVisits: 0,
      sourceExactRootReferences: 0,
      sourceReachDecisions: 0,
      sourceReachGroupReferences: 0,
      reachSupportedNodes: 0,
      sourceRootCounts: [],
    };
    levels[backoffLevel].nodeCount++;
    levels[backoffLevel].supportVisits += Number(value?.visits) || 0;
    const rootCount = Number.isSafeInteger(Number(value?.distinctSourceExactRoots))
      ? Math.max(0, Number(value.distinctSourceExactRoots))
      : (backoffLevel === 'exact' ? 1 : 0);
    const reachDecisions = Number.isSafeInteger(Number(value?.sourceReachDecisions))
      ? Math.max(0, Number(value.sourceReachDecisions)) : 0;
    const reachGroups = Number.isSafeInteger(Number(value?.sourceReachGroups))
      ? Math.max(0, Number(value.sourceReachGroups)) : 0;
    levels[backoffLevel].sourceExactRootReferences += rootCount;
    levels[backoffLevel].sourceReachDecisions += reachDecisions;
    levels[backoffLevel].sourceReachGroupReferences += reachGroups;
    levels[backoffLevel].reachSupportedNodes += reachDecisions > 0 ? 1 : 0;
    levels[backoffLevel].sourceRootCounts.push(rootCount);
  }
  const frozenLevels = Object.freeze(Object.fromEntries(Object.entries(levels)
    .map(([level, value]) => {
      const sourceRootCounts = value.sourceRootCounts.sort((a, b) => a - b);
      return [level, Object.freeze({
        nodeCount: value.nodeCount,
        supportVisits: value.supportVisits,
        sourceExactRootReferences: value.sourceExactRootReferences,
        sourceReachDecisions: value.sourceReachDecisions,
        sourceReachGroupReferences: value.sourceReachGroupReferences,
        reachSupportedNodes: value.reachSupportedNodes,
        minDistinctSourceExactRoots: sourceRootCounts[0] || 0,
        p50DistinctSourceExactRoots: percentile(sourceRootCounts, 0.5),
        maxDistinctSourceExactRoots: sourceRootCounts.at(-1) || 0,
      })];
    })));
  const totalSupportVisits = visits.reduce((sum, value) => sum + value, 0);
  const persistedSourceExactVisits = recordedSourceExactVisits(checkpoint);
  const sourceExactVisits = persistedSourceExactVisits ?? levels.exact.supportVisits;
  const sourceExactVisitsDefinition = persistedSourceExactVisits == null
    ? PUBLISHED_EXACT_FALLBACK_DEFINITION : SOURCE_EXACT_VISITS_DEFINITION;
  const persistedSourceExactRootCount = recordedSourceExactRootCount(checkpoint);
  const sourceExactRootCount = persistedSourceExactRootCount ?? levels.exact.nodeCount;
  const sourceExactRootCountDefinition = persistedSourceExactRootCount == null
    ? PUBLISHED_EXACT_ROOTS_FALLBACK_DEFINITION : SOURCE_EXACT_ROOTS_DEFINITION;
  const meanSupportVisits = entries.length ? totalSupportVisits / entries.length : 0;
  const minSupportVisits = visits[0] || 0;
  const p50SupportVisits = percentile(visits, 0.5);
  const p90SupportVisits = percentile(visits, 0.9);
  const maxSupportVisits = visits.at(-1) || 0;
  return Object.freeze({
    infoSets: entries.length,
    levels: frozenLevels,
    totalSupportVisits,
    meanSupportVisits,
    minSupportVisits,
    p50SupportVisits,
    p90SupportVisits,
    maxSupportVisits,
    sourceExactVisits,
    sourceExactVisitsDefinition,
    sourceExactRootCount,
    sourceExactRootCountDefinition,
    sourceReachDecisions: Number(
      checkpoint?.metadata?.publication?.sourceReachDecisions,
    ) || 0,
    sourceReachRootCount: Number(
      checkpoint?.metadata?.publication?.sourceReachRootCount,
    ) || 0,
    sourceReachGroupCount: Number(
      checkpoint?.metadata?.publication?.sourceReachGroupCount,
    ) || 0,
    supportVisitsDefinition: 'sum of visits attached to published nodes; hierarchical levels overlap and are not independent training samples',
    sourceExactRootReferencesDefinition: 'sum of per-node distinct-source-root counts; levels and nodes overlap, so this is an auditable support diagnostic rather than an independent sample count',
    sourceReachDecisionsDefinition: 'sum of retained-profile decision counts for the distinct exact roots contributing to each node; published nodes overlap and this quantity must not be treated as independent rollout samples',
    sourceReachGroupReferencesDefinition: 'sum of per-node opaque independent source-group counts; nodes overlap, while the publication sourceReachGroupCount is the distinct global group count',
    // Backward-compatible aliases. These are published support quantities,
    // not independent source traversals; new consumers should use the
    // explicitly named *SupportVisits fields above.
    totalVisits: totalSupportVisits,
    meanVisits: meanSupportVisits,
    minVisits: minSupportVisits,
    p50Visits: p50SupportVisits,
    p90Visits: p90SupportVisits,
    maxVisits: maxSupportVisits,
    byPlayers: Object.freeze(byPlayers),
    byRoundLevel: Object.freeze(byRoundLevel),
    byBackoffLevel: Object.freeze(byBackoffLevel),
  });
}

export function curriculumConfigurations({
  tableSizes = [2, 3, 4, 5, 6],
  rounds = [2, 5, 8, 11],
  stackBbs = [8, 20, 80],
  maxRaisesPerStreet = 3,
  utilityMode = 'chip-ev',
  tournamentRankWeight = 0.35,
} = {}) {
  const players = integerList(tableSizes, 'tableSizes', 2, 9);
  const roundStages = integerList(rounds, 'rounds', 1, 12);
  const stacks = [...new Set((Array.isArray(stackBbs) ? stackBbs : []).map(Number))]
    .sort((a, b) => a - b);
  if (!stacks.length || stacks.some((value) => !Number.isFinite(value) || value < 2)) {
    throw new RangeError('stackBbs must contain finite values >= 2');
  }
  if (!Number.isInteger(maxRaisesPerStreet)
    || maxRaisesPerStreet < 0 || maxRaisesPerStreet > 3) {
    throw new RangeError('maxRaisesPerStreet must be an integer in 0..3');
  }
  if (!['chip-ev', 'hybrid-tournament', 'phase-aware-tournament'].includes(utilityMode)) {
    throw new RangeError(
      'utilityMode must be chip-ev, hybrid-tournament or phase-aware-tournament',
    );
  }
  if (!Number.isFinite(Number(tournamentRankWeight))
    || Number(tournamentRankWeight) < 0 || Number(tournamentRankWeight) > 1) {
    throw new RangeError('tournamentRankWeight must be in 0..1');
  }
  return Object.freeze(players.flatMap((tableSize) => roundStages.flatMap((round) => (
    stacks.map((stackBb) => Object.freeze({
      tableSize, round, stackBb, maxRaisesPerStreet,
      utilityMode, tournamentRankWeight: Number(tournamentRankWeight),
    }))
  ))));
}

function mergeRuntimeCheckpoint(accumulator, checkpoint) {
  for (const [key, value] of Object.entries(checkpoint.infosets || {})) {
    if (key.includes('|bk=')) continue;
    const visits = Number(value.visits);
    if (!Number.isSafeInteger(visits) || visits <= 0) continue;
    for (const targetKey of [key, ...blueprintBackoffKeys(key)]) {
      let target = accumulator.get(targetKey);
      if (!target) {
        target = {
          visits: 0,
          weighted: new Map(),
          actionValues: new Map(),
          sourceExactRoots: new Set(),
        };
        accumulator.set(targetKey, target);
      }
      target.sourceExactRoots.add(key);
      target.visits += visits;
      for (const [action, probability] of Object.entries(value.strategy || {})) {
        target.weighted.set(
          action,
          (target.weighted.get(action) || 0) + Number(probability) * visits,
        );
      }
      for (const [action, moments] of Object.entries(value.actionValues || {})) {
        let targetMoments = target.actionValues.get(action);
        if (!targetMoments) {
          targetMoments = { samples: 0, mean: 0, m2: 0 };
          target.actionValues.set(action, targetMoments);
        }
        mergeMoment(targetMoments, moments, `actionValues(${targetKey}, ${action})`);
      }
    }
  }
}

function publicationThresholds({
  minExactVisits = 50,
  minBackoffVisits = 10,
  minBackoffRoots = 2,
  minPopulationRoots = 3,
  minReachDecisions = 0,
  minReachGroups = 0,
} = {}) {
  if (!Number.isSafeInteger(minExactVisits) || minExactVisits < 1
    || !Number.isSafeInteger(minBackoffVisits) || minBackoffVisits < 1) {
    throw new RangeError('publication visit thresholds must be positive safe integers');
  }
  if (!Number.isSafeInteger(minBackoffRoots) || minBackoffRoots < 2
    || !Number.isSafeInteger(minPopulationRoots)
    || minPopulationRoots < minBackoffRoots) {
    throw new RangeError('publication root thresholds require backoff >= 2 and population >= backoff');
  }
  if (!Number.isSafeInteger(minReachDecisions) || minReachDecisions < 0) {
    throw new RangeError('minReachDecisions must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(minReachGroups) || minReachGroups < 0) {
    throw new RangeError('minReachGroups must be a non-negative safe integer');
  }
  return Object.freeze({
    minExactVisits,
    minBackoffVisits,
    minBackoffRoots,
    minPopulationRoots,
    minReachDecisions,
    minReachGroups,
  });
}

function supportForRoots(roots, evidence) {
  const profileIds = new Set();
  const sourceGroups = new Set();
  let reachDecisions = 0;
  for (const root of roots) {
    const support = evidence.byExactKey.get(root);
    if (!support) continue;
    reachDecisions += support.decisions;
    for (const profileId of support.profileIds) profileIds.add(profileId);
    for (const sourceGroup of support.sourceGroups) sourceGroups.add(sourceGroup);
  }
  return Object.freeze({
    reachDecisions,
    reachProfiles: profileIds.size,
    reachGroups: sourceGroups.size,
  });
}

function mergedInfosets(
  accumulator,
  thresholds = publicationThresholds(),
  evidence = normalizeReachSupport(),
) {
  const infosets = Object.create(null);
  for (const key of [...accumulator.keys()].sort()) {
    const entry = accumulator.get(key);
    const backoffLevel = /\|bk=([^|]+)/.exec(key)?.[1] || 'exact';
    const isBackoff = backoffLevel !== 'exact';
    const minimum = isBackoff ? thresholds.minBackoffVisits : thresholds.minExactVisits;
    if (entry.visits < minimum) continue;
    const distinctSourceExactRoots = entry.sourceExactRoots.size;
    const requiredRoots = backoffLevel === 'population'
      ? thresholds.minPopulationRoots : thresholds.minBackoffRoots;
    const support = supportForRoots(entry.sourceExactRoots, evidence);
    if (isBackoff && distinctSourceExactRoots < requiredRoots) continue;
    if (isBackoff && support.reachDecisions < thresholds.minReachDecisions) continue;
    if (isBackoff && support.reachGroups < thresholds.minReachGroups) continue;
    const strategy = Object.create(null);
    for (const action of [...entry.weighted.keys()].sort()) {
      strategy[action] = entry.weighted.get(action) / entry.visits;
    }
    const actionValues = Object.create(null);
    for (const action of [...entry.actionValues.keys()].sort()) {
      const moments = entry.actionValues.get(action);
      if (moments.samples <= 0) continue;
      actionValues[action] = { ...moments };
    }
    infosets[key] = {
      strategy,
      visits: entry.visits,
      distinctSourceExactRoots,
      sourceReachDecisions: support.reachDecisions,
      sourceReachProfiles: support.reachProfiles,
      sourceReachGroups: support.reachGroups,
      ...(Object.keys(actionValues).length ? { actionValues } : {}),
    };
  }
  return infosets;
}

/** Add publication-only hierarchical nodes without touching trainerState. */
export function addBlueprintBackoffInfosets(checkpoint, options = {}) {
  if (!checkpoint || typeof checkpoint !== 'object') {
    throw new TypeError('addBlueprintBackoffInfosets requires a checkpoint object');
  }
  const thresholds = publicationThresholds(options);
  const evidence = normalizeReachSupport(options.reachSupport);
  const sourceKeys = exactSourceKeys(checkpoint);
  const sourceExactVisits = recordedSourceExactVisits(checkpoint)
    ?? exactSourceVisits(checkpoint);
  const sourceExactRootCount = recordedSourceExactRootCount(checkpoint)
    ?? sourceKeys.size;
  const evidenceSummary = reachSummary(sourceKeys, evidence);
  const accumulator = new Map();
  mergeRuntimeCheckpoint(accumulator, checkpoint);
  checkpoint.infosets = mergedInfosets(accumulator, thresholds, evidence);
  checkpoint.metadata ||= {};
  checkpoint.metadata.publication = publicationMetadata(
    thresholds,
    sourceExactVisits,
    sourceExactRootCount,
    evidenceSummary,
  );
  checkpoint.metadata.advantageGuard ||= advantageGuardMetadata();
  return checkpoint;
}

/** Train independent deterministic shards, then visit-weight their overlaps. */
export function trainBlueprintCurriculum({
  tableSizes,
  rounds,
  stackBbs,
  maxRaisesPerStreet = 3,
  iterationsPerConfig = 100,
  seed = 'qyj-blueprint-v2-curriculum',
  blendWeight = 0.25,
  minExactVisits = 50,
  minBackoffVisits = 10,
  minBackoffRoots = 2,
  minPopulationRoots = 3,
  utilityMode = 'chip-ev',
  tournamentRankWeight = 0.35,
  onProgress = null,
} = {}) {
  if (!Number.isInteger(iterationsPerConfig) || iterationsPerConfig < 0) {
    throw new RangeError('iterationsPerConfig must be a non-negative integer');
  }
  const runtimeWeight = finiteNumber(blendWeight, 'blendWeight');
  if (runtimeWeight < 0 || runtimeWeight > 1) {
    throw new RangeError('blendWeight must be in 0..1');
  }
  const configs = curriculumConfigurations({
    tableSizes, rounds, stackBbs, maxRaisesPerStreet, utilityMode, tournamentRankWeight,
  });
  const thresholds = publicationThresholds({
    minExactVisits,
    minBackoffVisits,
    minBackoffRoots,
    minPopulationRoots,
  });
  const accumulator = new Map();
  let utilitySamples = 0;
  let sourceExactVisits = 0;
  const sourceExactRoots = new Set();
  configs.forEach((config, index) => {
    const shardSeed = `${String(seed)}|n=${config.tableSize}|r=${config.round}`
      + `|s=${config.stackBb}|mr=${config.maxRaisesPerStreet}`;
    const game = new QyjAbstractHoldemGame(config);
    const trainer = new ExternalSamplingMccfr(game, {
      seed: shardSeed,
      blendWeight: runtimeWeight,
    });
    trainer.train(iterationsPerConfig);
    const shard = trainer.toCheckpoint({ includeTrainerState: false });
    sourceExactVisits += exactSourceVisits(shard);
    for (const key of exactSourceKeys(shard)) sourceExactRoots.add(key);
    mergeRuntimeCheckpoint(accumulator, shard);
    utilitySamples += trainer.utilitySamples;
    onProgress?.(Object.freeze({
      completed: index + 1,
      total: configs.length,
      config,
      infoSets: accumulator.size,
      utilitySamples,
    }));
  });
  const infosets = mergedInfosets(accumulator, thresholds);
  const checkpoint = {
    schema: BLUEPRINT_SCHEMA,
    version: BLUEPRINT_VERSION,
    metadata: {
      algorithm: 'curriculum-external-sampling-mccfr',
      abstraction: BLUEPRINT_ABSTRACTION,
      seed: String(seed),
      iterations: iterationsPerConfig * configs.length,
      iterationsPerConfig,
      maxRaisesPerStreet,
      utilityMode,
      tournamentRankWeight: Number(tournamentRankWeight),
      utilitySamples,
      trainingScope: utilityMode === 'phase-aware-tournament'
        ? 'multi-size-multi-round-single-hand-phase-aware-tournament-no-skill'
        : utilityMode === 'hybrid-tournament'
        ? 'multi-size-multi-round-single-hand-hybrid-tournament-no-skill'
        : 'multi-size-multi-round-single-hand-no-skill',
      advantageGuard: advantageGuardMetadata(),
      publication: publicationMetadata(
        thresholds,
        sourceExactVisits,
        sourceExactRoots.size,
      ),
      configurations: configs,
      limitations: [
        utilityMode === 'phase-aware-tournament'
          ? 'single-hand phase-aware chip/rank proxy rather than the complete 12-round tournament value'
          : utilityMode === 'hybrid-tournament'
          ? 'single-hand chip/rank proxy rather than the complete 12-round tournament value'
          : 'single-hand utility rather than the complete 12-round tournament value',
        'hero skills and energy are disabled',
        'multiplayer regret minimisation has no Nash convergence guarantee',
      ],
    },
    blendWeight: runtimeWeight,
    infosets,
  };
  checkpoint.metadata.coverage = summarizeBlueprintCoverage(checkpoint);
  compileBlueprintCheckpoint(checkpoint);
  return checkpoint;
}
