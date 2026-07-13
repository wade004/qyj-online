import {
  BLUEPRINT_ABSTRACTION,
  BLUEPRINT_SCHEMA,
  BLUEPRINT_VERSION,
  blueprintBackoffKeys,
  compileBlueprintCheckpoint,
} from '../../js/game/blueprint-policy.js';
import {
  exactInfosetProfileProvenance,
  validateExactInfosetProfile,
} from './target-profile.js';

export const BLUEPRINT_HELDOUT_COVERAGE_SCHEMA = 'qyj-blueprint-heldout-coverage-v1';
export const BLUEPRINT_HELDOUT_COVERAGE_VERSION = 1;
export const DEFAULT_MIN_HELDOUT_COVERAGE = 0.25;
export const DEFAULT_MIN_HELDOUT_DECISIONS = 100;

const LEVELS = Object.freeze([
  'exact', 'history', 'position', 'strategic', 'population', 'none',
]);
const STREETS = Object.freeze(['preflop', 'flop', 'turn', 'river']);

function profileSource(raw, index) {
  const profile = raw?.profile || raw;
  validateExactInfosetProfile(profile);
  const sha256 = String(raw?.sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new TypeError(`profileSources[${index}].sha256 must be a SHA-256 hex digest`);
  }
  return Object.freeze({ profile, sha256 });
}

function normalizedProfileSources(profileSources) {
  if (!Array.isArray(profileSources) || profileSources.length === 0) {
    throw new TypeError('profileSources must contain at least one hashed reach profile');
  }
  const sources = profileSources.map(profileSource)
    .sort((left, right) => left.sha256.localeCompare(right.sha256));
  if (new Set(sources.map((source) => source.sha256)).size !== sources.length) {
    throw new RangeError('profileSources must not repeat a reach profile');
  }
  return Object.freeze(sources);
}

function profileMetadata(source) {
  const collection = source.profile.collection || {};
  const provenance = exactInfosetProfileProvenance(source.profile);
  return Object.freeze({
    sha256: source.sha256,
    schema: source.profile.schema,
    version: Number(source.profile.version),
    tableSize: Number(collection.tableSize),
    observedDecisions: Number(collection.observedDecisions) || 0,
    uniqueExactKeys: Number(collection.uniqueExactKeys) || 0,
    truncated: collection.truncated === true,
    promotionEligible: provenance.promotionEligible,
    promotionBlockers: provenance.promotionBlockers,
    sourceGroupSecretId: provenance.sourceGroupSecretId,
    sourceGroups: provenance.sourceGroups,
  });
}

/**
 * Convert independently collected reach profiles into exact-root support.
 * The returned Map is training-only and never serializes raw profile keys.
 */
export function buildBlueprintReachSupport(profileSources) {
  const sources = normalizedProfileSources(profileSources);
  const provenances = sources.map((source) => exactInfosetProfileProvenance(source.profile));
  const byExactKey = new Map();
  sources.forEach((source, profileId) => {
    const provenance = provenances[profileId];
    for (const entry of source.profile.entries) {
      const count = Number(entry?.count);
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new RangeError('reach profile entry count must be a positive safe integer');
      }
      let support = byExactKey.get(entry.exactKey);
      if (!support) {
        support = { decisions: 0, profileIds: new Set(), sourceGroups: new Set() };
        byExactKey.set(entry.exactKey, support);
      }
      support.decisions += count;
      support.profileIds.add(profileId);
      for (const sourceGroup of entry.sourceGroups || []) {
        support.sourceGroups.add(sourceGroup);
      }
    }
  });
  const secretIds = new Set(provenances.map((value) => value.sourceGroupSecretId).filter(Boolean));
  const promotionBlockers = [...new Set(provenances.flatMap(
    (value) => value.promotionBlockers,
  ))];
  if (secretIds.size > 1) promotionBlockers.push('reach-profile-source-group-secret-mismatch');
  const promotionEligible = provenances.every((value) => value.promotionEligible)
    && secretIds.size === 1;
  return Object.freeze({
    byExactKey,
    profileCount: sources.length,
    profileSources: Object.freeze(sources.map(profileMetadata)),
    promotionEligible,
    promotionBlockers: Object.freeze([...new Set(promotionBlockers)].sort()),
    sourceGroupSecretId: secretIds.size === 1 ? [...secretIds][0] : null,
  });
}

function positiveRate(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new RangeError(`${label} must be in 0..1`);
  }
  return number;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return number;
}

function requiredTables(values) {
  const tables = [...new Set((Array.isArray(values) ? values : [6, 9]).map(Number))]
    .sort((left, right) => left - right);
  if (!tables.length || tables.some((table) => !Number.isInteger(table)
    || table < 2 || table > 9)) {
    throw new RangeError('requiredTableSizes must contain table sizes in 2..9');
  }
  return Object.freeze(tables);
}

function exactSourceKeys(checkpoint) {
  return new Set(Object.keys(checkpoint?.infosets || {})
    .filter((key) => !key.includes('|bk=')));
}

function fieldOf(key, field) {
  const match = new RegExp(`\\|${field}=([^|]+)`).exec(key);
  if (!match) return 'unknown';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return 'unknown';
  }
}

function levelOf(key) {
  return fieldOf(key, 'bk') === 'unknown' ? 'exact' : fieldOf(key, 'bk');
}

function freshCounts() {
  return Object.fromEntries(LEVELS.map((level) => [level, 0]));
}

function freshBucket() {
  return {
    decisions: 0,
    coveredDecisions: 0,
    heldoutExactRoots: new Set(),
    coveredExactRoots: new Set(),
    levelCounts: freshCounts(),
  };
}

function observe(bucket, exactKey, count, selectedKey) {
  bucket.decisions += count;
  bucket.heldoutExactRoots.add(exactKey);
  const level = selectedKey ? levelOf(selectedKey) : 'none';
  bucket.levelCounts[LEVELS.includes(level) ? level : 'none'] += count;
  if (selectedKey) {
    bucket.coveredDecisions += count;
    bucket.coveredExactRoots.add(exactKey);
  }
}

function finalizeBucket(bucket) {
  return Object.freeze({
    decisions: bucket.decisions,
    coveredDecisions: bucket.coveredDecisions,
    coverage: bucket.decisions ? bucket.coveredDecisions / bucket.decisions : 0,
    heldoutExactRoots: bucket.heldoutExactRoots.size,
    coveredExactRoots: bucket.coveredExactRoots.size,
    exactRootCoverage: bucket.heldoutExactRoots.size
      ? bucket.coveredExactRoots.size / bucket.heldoutExactRoots.size : 0,
    levelCounts: Object.freeze({ ...bucket.levelCounts }),
    levelRates: Object.freeze(Object.fromEntries(LEVELS.map((level) => [
      level,
      bucket.levelCounts[level] / Math.max(1, bucket.decisions),
    ]))),
  });
}

function sortedBuckets(map) {
  return Object.freeze(Object.fromEntries([...map.entries()]
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
    .map(([key, bucket]) => [key, finalizeBucket(bucket)])));
}

function selectedPublishedKey(infosets, exactKey) {
  return [exactKey, ...blueprintBackoffKeys(exactKey)]
    .find((candidate) => Object.hasOwn(infosets, candidate)) || null;
}

function publicationProfileHashes(checkpoint) {
  return new Set((checkpoint?.metadata?.publication?.reachProfiles || [])
    .map((source) => String(source?.sha256 || '').toLowerCase())
    .filter((value) => /^[0-9a-f]{64}$/.test(value)));
}

function validatePublishedSupport(checkpoint, blockers) {
  const publication = checkpoint?.metadata?.publication || {};
  if (Number(publication.minBackoffRoots) < 2) {
    blockers.push('publication-distinct-root-gate-disabled');
  }
  if (Number(publication.minPopulationRoots) < 3) {
    blockers.push('publication-population-root-gate-below-three');
  }
  if (Number(publication.minReachDecisions) < 1
    || publication.reachEvidenceAvailable !== true) {
    blockers.push('publication-reach-gate-disabled');
  }
  if (Number(publication.minReachGroups) < 2) {
    blockers.push('publication-independent-group-gate-below-two');
  }
  for (const [key, node] of Object.entries(checkpoint?.infosets || {})) {
    const level = levelOf(key);
    if (level === 'exact') continue;
    const requiredRoots = level === 'population'
      ? Number(publication.minPopulationRoots) : Number(publication.minBackoffRoots);
    if (!Number.isSafeInteger(Number(node?.distinctSourceExactRoots))
      || Number(node.distinctSourceExactRoots) < requiredRoots) {
      blockers.push('published-node-insufficient-distinct-roots');
      break;
    }
    if (!Number.isSafeInteger(Number(node?.sourceReachDecisions))
      || Number(node.sourceReachDecisions) < Number(publication.minReachDecisions)) {
      blockers.push('published-node-insufficient-reach-support');
      break;
    }
    if (!Number.isSafeInteger(Number(node?.sourceReachGroups))
      || Number(node.sourceReachGroups) < Number(publication.minReachGroups)) {
      blockers.push('published-node-insufficient-independent-groups');
      break;
    }
  }
}

/**
 * Evaluate unseen exact roots from reach profiles.  The exact training source
 * is mandatory so publication thresholds cannot make a trained root look
 * held out merely by removing its exact runtime node.
 */
export function evaluateBlueprintHeldoutCoverage({
  checkpoint,
  sourceCheckpoint,
  profileSources,
  requiredTableSizes = [6, 9],
  minCoverage = DEFAULT_MIN_HELDOUT_COVERAGE,
  minDecisionsPerTable = DEFAULT_MIN_HELDOUT_DECISIONS,
} = {}) {
  compileBlueprintCheckpoint(checkpoint);
  compileBlueprintCheckpoint(sourceCheckpoint);
  const sources = normalizedProfileSources(profileSources);
  const tables = requiredTables(requiredTableSizes);
  const coverageFloor = positiveRate(minCoverage, 'minCoverage');
  const decisionFloor = positiveInteger(minDecisionsPerTable, 'minDecisionsPerTable');
  const sourceKeys = exactSourceKeys(sourceCheckpoint);
  const publishedInfosets = checkpoint.infosets || {};
  const overall = freshBucket();
  const byTable = new Map(tables.map((table) => [String(table), freshBucket()]));
  const byStreet = new Map(STREETS.map((street) => [street, freshBucket()]));
  const byLegalMask = new Map();
  const unseenOverall = freshBucket();
  const unseenByTable = new Map(tables.map((table) => [String(table), freshBucket()]));
  let excludedTrainingDecisions = 0;
  let excludedTrainingExactRoots = 0;
  const excludedKeys = new Set();

  for (const source of sources) {
    const table = Number(source.profile.collection?.tableSize);
    const tableBucket = byTable.get(String(table)) || freshBucket();
    if (!byTable.has(String(table))) byTable.set(String(table), tableBucket);
    const unseenTableBucket = unseenByTable.get(String(table)) || freshBucket();
    if (!unseenByTable.has(String(table))) unseenByTable.set(String(table), unseenTableBucket);
    for (const entry of source.profile.entries) {
      const count = Number(entry.count);
      const seenTrainingRoot = sourceKeys.has(entry.exactKey);
      if (seenTrainingRoot) {
        excludedTrainingDecisions += count;
        excludedKeys.add(entry.exactKey);
      }
      const selectedKey = selectedPublishedKey(publishedInfosets, entry.exactKey);
      const street = fieldOf(entry.exactKey, 's');
      const legalMask = fieldOf(entry.exactKey, 'lm');
      if (!byStreet.has(street)) byStreet.set(street, freshBucket());
      if (!byLegalMask.has(legalMask)) byLegalMask.set(legalMask, freshBucket());
      observe(overall, entry.exactKey, count, selectedKey);
      observe(tableBucket, entry.exactKey, count, selectedKey);
      observe(byStreet.get(street), entry.exactKey, count, selectedKey);
      observe(byLegalMask.get(legalMask), entry.exactKey, count, selectedKey);
      if (!seenTrainingRoot) {
        observe(unseenOverall, entry.exactKey, count, selectedKey);
        observe(unseenTableBucket, entry.exactKey, count, selectedKey);
      }
    }
  }
  excludedTrainingExactRoots = excludedKeys.size;

  const blockers = [];
  const recordedRootCount = Number(checkpoint?.metadata?.publication?.sourceExactRootCount);
  if (!Number.isSafeInteger(recordedRootCount) || recordedRootCount !== sourceKeys.size) {
    blockers.push('source-exact-root-contract-mismatch');
  }
  const trainingProfileHashes = publicationProfileHashes(checkpoint);
  if (sources.some((source) => trainingProfileHashes.has(source.sha256))) {
    blockers.push('heldout-profile-overlaps-publication-reach-evidence');
  }
  const heldoutProvenances = sources.map((source) => exactInfosetProfileProvenance(source.profile));
  for (const provenance of heldoutProvenances) {
    if (!provenance.promotionEligible) {
      blockers.push(...provenance.promotionBlockers.map((blocker) => `heldout-${blocker}`));
    }
  }
  const publicationProfiles = checkpoint?.metadata?.publication?.reachProfiles || [];
  const publicationSecretIds = new Set(publicationProfiles
    .map((profile) => profile?.sourceGroupSecretId).filter(Boolean));
  const heldoutSecretIds = new Set(heldoutProvenances
    .map((provenance) => provenance.sourceGroupSecretId).filter(Boolean));
  if (publicationSecretIds.size !== 1 || heldoutSecretIds.size !== 1
    || [...publicationSecretIds][0] !== [...heldoutSecretIds][0]) {
    blockers.push('heldout-source-group-secret-mismatch');
  } else {
    const publicationGroups = new Set(publicationProfiles.flatMap(
      (profile) => profile?.sourceGroups || [],
    ));
    const heldoutGroups = new Set(heldoutProvenances.flatMap(
      (provenance) => provenance.sourceGroups,
    ));
    if ([...heldoutGroups].some((sourceGroup) => publicationGroups.has(sourceGroup))) {
      blockers.push('heldout-source-groups-overlap-publication');
    }
  }
  if (sources.some((source) => source.profile.collection?.truncated === true)) {
    blockers.push('heldout-profile-truncated');
  }
  validatePublishedSupport(checkpoint, blockers);

  const finalizedTables = sortedBuckets(byTable);
  for (const table of tables) {
    const metrics = finalizedTables[String(table)];
    if (!metrics || metrics.decisions < decisionFloor) {
      blockers.push(`table-${table}-heldout-decisions-below-threshold`);
    } else if (metrics.coverage < coverageFloor) {
      blockers.push(`table-${table}-coverage-below-threshold`);
    }
  }

  const uniqueBlockers = Object.freeze([...new Set(blockers)].sort());
  return Object.freeze({
    schema: BLUEPRINT_HELDOUT_COVERAGE_SCHEMA,
    version: BLUEPRINT_HELDOUT_COVERAGE_VERSION,
    blueprint: Object.freeze({
      schema: BLUEPRINT_SCHEMA,
      version: BLUEPRINT_VERSION,
      abstraction: BLUEPRINT_ABSTRACTION,
    }),
    source: Object.freeze({
      exactRootCount: sourceKeys.size,
      sourceExactMatchedDecisions: excludedTrainingDecisions,
      sourceExactMatchedRoots: excludedTrainingExactRoots,
      excludedTrainingDecisions,
      excludedTrainingExactRoots,
      profiles: Object.freeze(sources.map(profileMetadata)),
    }),
    overall: finalizeBucket(overall),
    byTable: finalizedTables,
    unseenRoot: Object.freeze({
      overall: finalizeBucket(unseenOverall),
      byTable: sortedBuckets(unseenByTable),
    }),
    byStreet: sortedBuckets(byStreet),
    byLegalMask: sortedBuckets(byLegalMask),
    gate: Object.freeze({
      passed: uniqueBlockers.length === 0,
      promotable: uniqueBlockers.length === 0,
      diagnostic: uniqueBlockers.length > 0,
      blockers: uniqueBlockers,
      minCoverage: coverageFloor,
      minDecisionsPerTable: decisionFloor,
      requiredTableSizes: tables,
    }),
    definitions: Object.freeze({
      heldout: 'all decisions from opaque-source-group-disjoint reach profiles; exact keys may legitimately coincide with trained roots',
      unseenRoot: 'diagnostic subset whose exact keys are absent from the mandatory pre-publication source artifact',
      coverage: 'held-out reach-decision-weighted fraction with a published exact or hierarchical key',
      independence: 'formal promotion also requires held-out profile file hashes to differ from publication reach-evidence hashes',
    }),
  });
}
