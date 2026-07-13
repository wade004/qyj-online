import {
  aggregateLeague,
  blueprintDecisionMetrics,
  bootstrapMeanCI,
  buildSeatAssignments,
  buildPromotionCrossoverLineup,
  createLineup,
  enforcePromotionEligibility,
  evaluatePromotionGate,
  runLeague,
  runMatch,
  summarizeBeliefCalibration,
} from '../training/eval/league.mjs';
import { createSeededRng, deriveSeed } from '../training/eval/rng.mjs';
import { coerceLegalAction, isLegalAction } from '../training/eval/strategies.mjs';
import {
  EXACT_INFOSET_PROFILE_SCHEMA,
  EXACT_INFOSET_PROFILE_VERSION,
  LEGACY_EXACT_INFOSET_PROFILE_SCHEMA,
  LEGACY_EXACT_INFOSET_PROFILE_VERSION,
  ExactInfosetReachProfiler,
  exactInfosetProfileProvenance,
  exactInfosetProfileSecretId,
  exactInfosetProfileSourceGroup,
  validateExactInfosetProfile,
} from '../training/blueprint/target-profile.js';
import {
  BLUEPRINT_ABSTRACTION,
  BLUEPRINT_SCHEMA,
  BLUEPRINT_VERSION,
  compileBlueprintCheckpoint,
} from '../js/game/blueprint-policy.js';

const assert = (condition, message) => {
  if (!condition) throw new Error(`AI league assertion failed: ${message}`);
};

const assertApprox = (actual, expected, message, tolerance = 1e-12) => {
  assert(Math.abs(actual - expected) <= tolerance,
    `${message}: expected=${expected}, actual=${actual}`);
};

const assertThrows = (fn, pattern, message) => {
  let error = null;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert(error && pattern.test(error.message), message);
};

function deterministicView(match) {
  const {
    durationMs: _duration,
    ...stable
  } = match;
  return stable;
}

// RNG streams and derived namespaces must be reproducible.
const rngA = createSeededRng('league-seed');
const rngB = createSeededRng('league-seed');
assert(
  Array.from({ length: 20 }, () => rngA()).join(',')
    === Array.from({ length: 20 }, () => rngB()).join(','),
  'same seed must produce the same RNG stream',
);
assert(deriveSeed('ab', 'c') !== deriveSeed('a', 'bc'),
  'length-prefixed derived seeds must separate component boundaries');

// Blueprint telemetry is a pure, conservative compatibility boundary. A
// missing field is zero, while both hit aliases and effective weight work.
assert(JSON.stringify(blueprintDecisionMetrics(null)) === JSON.stringify({
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
}), 'missing blueprint diagnostics must normalize to an all-zero signal');
const normalizedBlueprint = blueprintDecisionMetrics({
  blueprint: {
    keyHit: true,
    backoffLevel: 'history',
    nodeVisits: 120,
    confidence: 0.8,
    effectiveWeight: 0.25,
    intervened: true,
    actionChanged: true,
    policyTV: 0.3,
    influence: 0.075,
    advantageGuardEnabled: true,
    advantageComplete: true,
    advantagePassed: true,
    advantageMean: 12.5,
    advantageLowerBound: 3.25,
    advantageMinSamples: 200,
    advantageCoveredActions: 3,
    advantageRequiredActions: 3,
  },
});
assert(normalizedBlueprint.hit && normalizedBlueprint.intervened
  && normalizedBlueprint.actionChanged, 'boolean blueprint telemetry must be retained');
assert(normalizedBlueprint.backoffLevel === 'history',
  'blueprint backoff level must be retained');
assertApprox(normalizedBlueprint.nodeVisits, 120, 'node visits must be retained');
assertApprox(normalizedBlueprint.confidence, 0.8, 'confidence must be retained');
assertApprox(normalizedBlueprint.effectiveWeight, 0.25, 'effective weight must be retained');
assertApprox(normalizedBlueprint.policyTV, 0.3, 'policy TV must be retained');
assertApprox(normalizedBlueprint.influence, 0.075, 'influence must be retained');
assert(normalizedBlueprint.advantageGuardEnabled && normalizedBlueprint.advantageComplete
  && normalizedBlueprint.advantagePassed, 'advantage guard booleans must be retained');
assertApprox(normalizedBlueprint.advantageMean, 12.5, 'advantage mean must be retained');
assertApprox(normalizedBlueprint.advantageLowerBound, 3.25,
  'advantage lower bound must be retained');
assertApprox(normalizedBlueprint.advantageMinSamples, 200,
  'advantage sample floor must be retained');
assertApprox(normalizedBlueprint.advantageCoveredActions, 3,
  'covered advantage actions must be retained');
assertApprox(normalizedBlueprint.advantageRequiredActions, 3,
  'required advantage actions must be retained');
assertApprox(blueprintDecisionMetrics({ blueprint: { hit: true, weight: 0.2 } })
  .effectiveWeight, 0.2, 'legacy weight must alias effectiveWeight');
assert(!blueprintDecisionMetrics({ blueprint: { hit: false, keyHit: true } }).hit,
  'an explicit ineligible hit=false must take precedence over the legacy keyHit alias');
assert(blueprintDecisionMetrics({
  blueprint: { hit: true, backoffLevel: 'unexpected-future-level' },
}).backoffLevel === 'none', 'unknown backoff levels must remain unclassified');
assert(blueprintDecisionMetrics({
  blueprint: { hit: true, advantageMean: null, advantageLowerBound: null },
}).advantageMean === null, 'missing advantage estimates must not be coerced to zero');

// Full rotations plus reflection move every logical bot while preserving ids.
const numbered = createLineup([
  { id: 'A', strategy: 'calling-station' },
  { id: 'B', strategy: 'calling-station' },
  { id: 'C', strategy: 'calling-station' },
  { id: 'D', strategy: 'calling-station' },
  { id: 'E', strategy: 'calling-station' },
  { id: 'F', strategy: 'calling-station' },
], 6);
const assignments = buildSeatAssignments(numbered, { rotations: 'full', mirror: true });
assert(assignments.length === 12, 'six rotations and two orientations should create 12 variants');
assert(assignments[0].seats.map((entry) => entry.id).join('') === 'ABCDEF',
  'regular orientation should retain logical order');
assert(assignments[6].seats.map((entry) => entry.id).join('') === 'AFEDCB',
  'mirrored orientation should reverse the table around logical seat A');
for (const competitor of numbered) {
  const regularSeats = assignments.slice(0, 6).map((assignment) => (
    assignment.seats.find((entry) => entry.id === competitor.id).seat
  ));
  assert(new Set(regularSeats).size === 6,
    `${competitor.id} must visit all six physical seats`);
}
const crossoverLineup = buildPromotionCrossoverLineup(createLineup([
  'calling-station', 'check-fold', 'random-legal',
  'qyz-tight', 'qyz-aggressive', 'qyz-loose',
], 6), {
  candidate: 'calling-station',
  baseline: 'check-fold',
});
assert(crossoverLineup[0].strategy === 'check-fold'
  && crossoverLineup[1].strategy === 'calling-station'
  && crossoverLineup.slice(2).map((entry) => entry.strategy).join(',')
    === 'random-legal,qyz-tight,qyz-aggressive,qyz-loose',
'promotion crossover must swap only candidate/baseline logical slots');

// The action guard replaces stale/invalid policy output with a legal fallback.
const facingBet = {
  canCheck: false,
  canAllIn: true,
  tiers: [{ key: 'feint', inc: 20, cost: 40 }],
};
assert(isLegalAction({ type: 'raise', tier: { key: 'feint' } }, facingBet),
  'matching a current tier by key should be legal');
assert(!isLegalAction({ type: 'raise', tier: { key: 'stale' } }, facingBet),
  'a stale tier must be rejected');
assert(coerceLegalAction({ type: 'raise', tier: { key: 'stale' } }, facingBet).type === 'call',
  'invalid action should fall back to a legal call');

// A native six-seat 12-hand match must be bit-for-bit reproducible apart from wall time.
const passiveLineup = createLineup(['calling-station'], 6);
const passiveAssignment = buildSeatAssignments(
  passiveLineup,
  { rotations: 1, mirror: false },
)[0];
const profileSourceSecret = 'profile-source-group-secret-for-tests-2026';
const profileSourceSecretId = exactInfosetProfileSecretId(profileSourceSecret);
const rawProfileSeedGroup = 'raw-profile-seed-group-must-not-persist';
const exactProfileRecords = [];
const matchA = runMatch({
  assignment: passiveAssignment,
  seed: 'repeatable-match',
  seedGroup: rawProfileSeedGroup,
  onExactInfosetProfile: (record) => exactProfileRecords.push(record),
  profileStrategies: ['calling-station'],
  profileMaxRaises: 3,
  profileSourceGroupSecret: profileSourceSecret,
});
const matchB = runMatch({
  assignment: passiveAssignment,
  seed: 'repeatable-match',
  seedGroup: rawProfileSeedGroup,
});
assert(JSON.stringify(deterministicView(matchA)) === JSON.stringify(deterministicView(matchB)),
  'fixed seed must reproduce ranking, HP and every action counter');
assert(matchA.fullSchedule && matchA.rounds === 12,
  'six-seat benchmark must run the native complete 12-hand schedule');
assert(matchA.results.length === 6 && matchA.errorCount === 0,
  'six-seat report must contain every competitor without policy errors');
assert(matchA.results.every((row) => row.actions.decisions === (
  row.actions.fold + row.actions.check + row.actions.call + row.actions.raise + row.actions.allin
)), 'every requested decision must produce exactly one counted action');

const replayTrace = [];
const replayBaseline = runMatch({
  assignment: passiveAssignment,
  seed: 'forced-decision-replay',
  onDecisionTrace: (record) => replayTrace.push(record),
});
const replayTarget = replayTrace.find((record) => (
  record.entryId === 'calling-station#1'
  && record.legalActionKeys.some((actionKey) => actionKey !== record.actionKey)
));
assert(replayTarget, 'replay fixture must expose a legal alternative action');
const forcedActionKey = replayTarget.legalActionKeys.find(
  (actionKey) => actionKey !== replayTarget.actionKey,
);
const forcedTrace = [];
const replayBranch = runMatch({
  assignment: passiveAssignment,
  seed: 'forced-decision-replay',
  onDecisionTrace: (record) => forcedTrace.push(record),
  forcedDecision: {
    entryId: replayTarget.entryId,
    ordinal: replayTarget.ordinal,
    actionKey: forcedActionKey,
  },
});
const forcedRecord = forcedTrace.find((record) => record.forced);
assert(forcedRecord?.informationSetKey === replayTarget.informationSetKey,
  'forced branch must reach the identical public decision node before diverging');
assert(forcedRecord.actionKey === forcedActionKey
  && forcedRecord.baselineActionKey === replayTarget.actionKey,
  'forced branch must change exactly the requested legal action');
assert(JSON.stringify(deterministicView(replayBaseline))
  !== JSON.stringify(deterministicView(replayBranch)),
  'forced decision branch must be observable in the deterministic match record');

const calibrationMatch = runMatch({
  assignment: passiveAssignment,
  seed: 'belief-calibration-contract',
  beliefCalibration: true,
  beliefTemperature: 0.5,
});
assert(calibrationMatch.beliefCalibration.all.samples > 0,
  'offline belief calibration must score held-out simulator holes');
assert(calibrationMatch.beliefCalibration.conditioned.samples > 0,
  'public voluntary actions must produce conditioned calibration samples');
assert(!JSON.stringify(calibrationMatch).includes('"hole"'),
  'belief calibration match output must never retain held-out physical holes');
const calibrationSummary = summarizeBeliefCalibration([calibrationMatch], 0.5);
assert(calibrationSummary.schema === 'qyj-public-belief-calibration-v1'
  && calibrationSummary.conditioned.samples
    === calibrationMatch.beliefCalibration.conditioned.samples,
'belief calibration summary must retain only aggregate scoring totals');
assert(Number.isFinite(calibrationSummary.conditioned.posteriorLogLoss)
  && Number.isFinite(calibrationSummary.conditioned.posteriorBrier),
'belief calibration scores must remain finite');
const matchADecisions = matchA.results.reduce(
  (sum, row) => sum + row.actions.decisions, 0,
);
assert(exactProfileRecords.length === matchADecisions,
  'opt-in profiler must observe every selected strategy decision');
assert(!JSON.stringify(matchA).includes('bp2|'),
  'ordinary match JSON must never retain raw exact infoset keys');
const allowedProfileRecordKeys = [
  'exactKey', 'strategy', 'street', 'trainingSnapshot', 'actionKey',
  'sourceGroup',
  'usableHit', 'exactHit', 'backoffLevel', 'nodeVisits', 'confidence',
  'influence', 'advantageGuardEnabled', 'advantageComplete', 'advantagePassed',
  'advantageMean', 'advantageLowerBound', 'advantageMinSamples',
  'advantageCoveredActions', 'advantageRequiredActions',
  'intervened', 'actionChanged',
].sort().join(',');
assert(exactProfileRecords.every((record) => (
  Object.keys(record).sort().join(',') === allowedProfileRecordKeys
  && record.exactKey.startsWith('bp2|')
  && !Object.prototype.hasOwnProperty.call(record, 'observation')
  && !Object.prototype.hasOwnProperty.call(record, 'engine')
)), 'profile sink must receive only the exact allow-listed record');
const expectedProfileSourceGroup = exactInfosetProfileSourceGroup(
  profileSourceSecret,
  `table:6|seed-group:${rawProfileSeedGroup}`,
);
assert(exactProfileRecords.every((record) => (
  record.sourceGroup === expectedProfileSourceGroup
  && /^pg_[0-9a-f]{64}$/.test(record.sourceGroup)
  && !Object.prototype.hasOwnProperty.call(record, 'seedGroup')
  && !Object.prototype.hasOwnProperty.call(record, 'seedValue')
)), 'profile records must carry only the deterministic HMAC source group');
assert(exactInfosetProfileSourceGroup(profileSourceSecret, 'other-seed-group')
  !== expectedProfileSourceGroup,
'different raw seed groups must receive different opaque identifiers');
assertThrows(() => exactInfosetProfileSecretId('too-short'), /at least 32 bytes/,
  'profile provenance must reject low-entropy secrets');

const forbiddenSnapshotKeys = new Set([
  'deck', 'futureBoard', 'futureCards', 'opponentHole', 'hole',
  'playerId', 'playerName', 'name', 'hero', 'knowledge',
  'privateSkillKnowledge', 'publicSkillKnowledge',
]);
const scanSnapshotPrivacy = (value, path = 'snapshot') => {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert(!forbiddenSnapshotKeys.has(key),
      `training snapshot leaked forbidden field ${path}.${key}`);
    scanSnapshotPrivacy(child, `${path}.${key}`);
  }
};
for (const record of exactProfileRecords) {
  scanSnapshotPrivacy(record.trainingSnapshot);
  assert(Array.isArray(record.trainingSnapshot.selfHole)
    && record.trainingSnapshot.selfHole.length === 2,
  'training-only snapshot must retain only the observer physical hole cards');
  assert(record.trainingSnapshot.players.every((player) => (
    !Object.prototype.hasOwnProperty.call(player, 'selfHole')
  )), 'training-only snapshot players must never contain opponent hole cards');
}

const exactProfiler = new ExactInfosetReachProfiler({
  top: 5,
  sourceGroupSecretId: profileSourceSecretId,
});
for (const record of exactProfileRecords) exactProfiler.observe(record);
const exactProfile = validateExactInfosetProfile(exactProfiler.finalize({
  tableSize: 6,
  skillsEnabled: false,
  maxRaisesPerStreet: 3,
  strategies: ['calling-station'],
  matches: 1,
  fullScheduleMatches: 1,
}));
assert(exactProfile.schema === EXACT_INFOSET_PROFILE_SCHEMA
  && exactProfile.version === EXACT_INFOSET_PROFILE_VERSION
  && exactProfile.collection.observedDecisions === matchADecisions,
'separate profile artifact must expose a versioned deterministic contract');
assert(exactProfile.collection.promotionEligible
  && exactProfile.collection.promotionBlockers.length === 0
  && exactProfile.collection.sourceGroupCount === 1
  && exactProfile.collection.sourceGroupSecretId === profileSourceSecretId
  && exactProfile.collection.sourceGroups[0] === expectedProfileSourceGroup
  && exactProfile.entries.every((entry) => (
    JSON.stringify(entry.sourceGroups) === JSON.stringify([expectedProfileSourceGroup])
  )), 'V2 profile must retain sorted unique opaque provenance at both levels');
assert(exactInfosetProfileProvenance(exactProfile).promotionEligible,
  'normalized V2 provenance must be promotion-capable');
const exactProfileJson = JSON.stringify(exactProfile);
assert(!exactProfileJson.includes(rawProfileSeedGroup)
  && !exactProfileJson.includes(profileSourceSecret)
  && !exactProfileJson.includes('repeatable-match'),
'profile V2 must never persist a raw base seed, match seed or HMAC secret');
assert(exactProfile.entries.length <= 5
  && exactProfile.collection.truncated
    === (exactProfile.collection.uniqueExactKeys > exactProfile.entries.length),
'profile-top must deterministically cap retained exact keys');
for (let index = 1; index < exactProfile.entries.length; index++) {
  const previous = exactProfile.entries[index - 1];
  const current = exactProfile.entries[index];
  assert(previous.count > current.count
    || (previous.count === current.count && previous.exactKey <= current.exactKey),
  'profile entries must sort by descending frequency then exact key');
}
assert(JSON.stringify(exactProfile) === JSON.stringify(exactProfiler.finalize({
  tableSize: 6,
  skillsEnabled: false,
  maxRaisesPerStreet: 3,
  strategies: ['calling-station'],
  matches: 1,
  fullScheduleMatches: 1,
})), 'profile finalization must be deterministic and contain no wall-clock fields');

const diagnosticProfiler = new ExactInfosetReachProfiler({ top: 5 });
for (const record of exactProfileRecords) {
  const { sourceGroup: _sourceGroup, ...legacyRecord } = record;
  diagnosticProfiler.observe(legacyRecord);
}
const diagnosticProfile = validateExactInfosetProfile(diagnosticProfiler.finalize({
  tableSize: 6,
  skillsEnabled: false,
  maxRaisesPerStreet: 3,
  strategies: ['calling-station'],
  matches: 1,
  fullScheduleMatches: 1,
}));
assert(!diagnosticProfile.collection.promotionEligible
  && diagnosticProfile.collection.sourceGroupCount === 0
  && diagnosticProfile.collection.promotionBlockers.includes(
    'profile-source-group-provenance-disabled'
  ), 'a V2 profile collected without the opt-in secret must remain diagnostic');
const legacyProfile = structuredClone(diagnosticProfile);
legacyProfile.schema = LEGACY_EXACT_INFOSET_PROFILE_SCHEMA;
legacyProfile.version = LEGACY_EXACT_INFOSET_PROFILE_VERSION;
for (const field of [
  'sourceGroupCount', 'sourceGroups', 'sourceGroupSecretId',
  'promotionEligible', 'promotionBlockers',
]) delete legacyProfile.collection[field];
for (const entry of legacyProfile.entries) delete entry.sourceGroups;
validateExactInfosetProfile(legacyProfile);
assert(!exactInfosetProfileProvenance(legacyProfile).promotionEligible
  && exactInfosetProfileProvenance(legacyProfile).promotionBlockers.includes(
    'profile-v1-missing-source-group-provenance'
  ), 'legacy V1 profiles must remain readable but explicitly non-promotable');
assertThrows(() => new ExactInfosetReachProfiler().observe(exactProfileRecords[0]),
  /configured sourceGroupSecretId/,
  'opaque groups must not be accepted without their comparable secret fingerprint');
const missingGroupProfiler = new ExactInfosetReachProfiler({
  sourceGroupSecretId: profileSourceSecretId,
});
assertThrows(() => {
  const { sourceGroup: _sourceGroup, ...missingGroupRecord } = exactProfileRecords[0];
  missingGroupProfiler.observe(missingGroupRecord);
}, /requires an opaque source group/,
'a provenance-enabled profiler must reject any ungrouped decision');
assert(!JSON.stringify(exactProfiler.safeSummary()).includes('bp2|'),
  'safe profile aggregate must never expose raw exact keys');
scanSnapshotPrivacy(exactProfile, 'profile');
for (const entry of exactProfile.entries) scanSnapshotPrivacy(entry.trainingSnapshot);

let sanitizedProfileError = null;
try {
  runMatch({
    assignment: passiveAssignment,
    seed: 'profile-error-sanitization',
    profileStrategies: ['calling-station'],
    onExactInfosetProfile() {
      throw new Error('bp2|must-not-escape');
    },
  });
} catch (error) {
  sanitizedProfileError = error;
}
assert(sanitizedProfileError && !sanitizedProfileError.message.includes('bp2|'),
  'profile sink errors reaching ordinary logs must redact raw keys');
assertThrows(() => runMatch({
  assignment: passiveAssignment,
  seed: 'skills-profile-rejection',
  skillsEnabled: true,
  onExactInfosetProfile() {},
}), /skillsEnabled=false/, 'exact profile collection must reject skills-enabled games');

// Exercise the production QYZ decision adapter in the league without enabling skills.
const candidateLineup = createLineup([
  'blueprint',
  'qyz',
  'calling-station',
  'calling-station',
  'calling-station',
  'calling-station',
], 6);
const emptyCheckpoint = compileBlueprintCheckpoint({
  schema: BLUEPRINT_SCHEMA,
  version: BLUEPRINT_VERSION,
  blendWeight: 0.25,
  metadata: { abstraction: BLUEPRINT_ABSTRACTION, iterations: 1 },
  infosets: {},
});
const candidateMatch = runMatch({
  assignment: buildSeatAssignments(candidateLineup, { rotations: 1, mirror: false })[0],
  seed: 'qyz-smoke',
  skillsEnabled: false,
  blueprintCheckpoint: emptyCheckpoint,
});
const candidateRow = candidateMatch.results.find((row) => row.strategy === 'qyz');
const blueprintRow = candidateMatch.results.find((row) => row.strategy === 'blueprint');
assert(candidateMatch.rounds >= 1 && candidateRow.actions.decisions > 0,
  'production QYZ policy must complete a native neutral league match');
assert(blueprintRow.actions.blueprintDecisions > 0 && blueprintRow.actions.blueprintHits === 0,
  'per-seat blueprint candidate must run and report an empty-checkpoint miss');
assert(blueprintRow.actions.blueprintInterventions === 0
  && blueprintRow.actions.blueprintActionChanges === 0
  && blueprintRow.actions.blueprintInfluenceTotal === 0,
'missing/empty checkpoint telemetry must remain a zero-influence signal');
assert(candidateMatch.results.every((row) => (
  row.actions.skills === 0 && row.actions.passives === 0
)), 'skillsEnabled=false must disable both active and passive hero effects');

// Nine-seat support uses the same complete schedule and accounting schema.
const nineLineup = createLineup(['calling-station'], 9);
const nineMatch = runMatch({
  assignment: buildSeatAssignments(nineLineup, { rotations: 1, mirror: false })[0],
  seed: 'nine-seat-match',
});
assert(nineMatch.fullSchedule && nineMatch.rounds === 12,
  'nine-seat benchmark must run the native complete 12-hand schedule');
assert(nineMatch.results.length === 9 && new Set(nineMatch.results.map((row) => row.rank)).size === 9,
  'nine-seat result must have nine distinct final ranks');

// Bootstrap is deterministic, clustered by independent deal seed rather than
// pretending mirrored seat variants are independent samples.
const ciA = bootstrapMeanCI([1, 2, 3, 4, 5], { iterations: 500, seed: 'ci' });
const ciB = bootstrapMeanCI([1, 2, 3, 4, 5], { iterations: 500, seed: 'ci' });
assert(JSON.stringify(ciA) === JSON.stringify(ciB), 'bootstrap CI must be deterministic');
assert(ciA.low <= ciA.mean && ciA.high >= ciA.mean, 'CI must contain the sample mean');
for (const invalidOptions of [
  { confidence: 0 },
  { confidence: 1 },
  { iterations: 0 },
  { iterations: -1 },
]) {
  let rejected = false;
  try {
    bootstrapMeanCI([1, 2, 3], invalidOptions);
  } catch (error) {
    rejected = error instanceof RangeError;
  }
  assert(rejected, `invalid bootstrap settings must be rejected: ${JSON.stringify(invalidOptions)}`);
}

const leagueProfileRecords = [];
const tinyLeague = runLeague({
  tableSize: 6,
  lineup: ['calling-station', 'check-fold'],
  baseSeed: 'tiny-league',
  seedCount: 2,
  rotations: 1,
  mirror: false,
  bootstrapIterations: 100,
  onExactInfosetProfile: (record) => leagueProfileRecords.push(record),
  profileStrategies: ['calling-station'],
  profileMaxRaises: 3,
  profileSourceGroupSecret: profileSourceSecret,
  promotionGate: {
    candidate: 'calling-station',
    baseline: 'check-fold',
    minPairedSeeds: 2,
  },
});
assert(tinyLeague.matchCount === 2 && tinyLeague.summary.length === 2,
  'runLeague must return machine-readable matches and per-policy summaries');
assert(tinyLeague.summary.every((row) => row.seedClusters === 2),
  'summary confidence units must be independent seed clusters');
assert(leagueProfileRecords.length > 0 && !JSON.stringify(tinyLeague).includes('bp2|'),
  'opt-in runLeague collection must not place raw keys in the ordinary report');
assert(new Set(leagueProfileRecords.map((record) => record.sourceGroup)).size === 2
  && !JSON.stringify(leagueProfileRecords).includes('tiny-league:'),
'runLeague must map each independent seed cluster to one opaque source group');
assert(!tinyLeague.promotion.passed
  && tinyLeague.promotion.reason === 'unbalanced-seat-schedule',
'partial rotations or a missing table-order mirror must never pass promotion');

const balancedCrossoverLeague = runLeague({
  tableSize: 6,
  lineup: [
    'calling-station', 'check-fold', 'random-legal',
    'random-legal', 'random-legal', 'random-legal',
  ],
  baseSeed: 'balanced-crossover-league',
  seedCount: 1,
  rotations: 'full',
  mirror: true,
  bootstrapIterations: 25,
  promotionGate: {
    candidate: 'calling-station',
    baseline: 'check-fold',
    minPairedSeeds: 1,
  },
});
assert(balancedCrossoverLeague.matchCount === 24
  && balancedCrossoverLeague.config.promotionCrossover.enabled
  && balancedCrossoverLeague.config.promotionCrossover.swappedVariants === 12,
'a six-seat promotion must add 12 matched candidate/baseline slot-swap variants');
assert(!balancedCrossoverLeague.promotion.eligibilityBlockers?.includes(
  'candidate-baseline-crossover-required',
), 'a completed crossover schedule must clear the crossover eligibility blocker');

const skillDiagnosticLeague = runLeague({
  tableSize: 6,
  lineup: ['calling-station', 'check-fold'],
  baseSeed: 'skill-diagnostic-league',
  seedCount: 1,
  rotations: 1,
  mirror: false,
  skillsEnabled: true,
  bootstrapIterations: 25,
  promotionGate: {
    candidate: 'calling-station',
    baseline: 'check-fold',
    minPairedSeeds: 1,
  },
});
assert(!skillDiagnosticLeague.promotion.passed
  && skillDiagnosticLeague.promotion.reason === 'skills-enabled-requires-hero-crossover'
  && typeof skillDiagnosticLeague.promotion.statisticalReason === 'string',
'skills-enabled results may be diagnostic, but must never pass the strategy promotion gate');

// A promotion gate only passes when the paired bootstrap lower bound is
// positive and the requested independent-seed minimum is met.
const syntheticMatches = Array.from({ length: 8 }, (_, seedIndex) => ({
  seedGroup: `seed-${seedIndex}`,
  results: [
    {
      strategy: 'candidate', strategyLabel: 'Candidate', rank: 1, hp: 2200,
      hpDelta: 700, alive: true, firstPlace: true, roundsSurvived: 12, actions: {},
    },
    {
      strategy: 'baseline', strategyLabel: 'Baseline', rank: 3, hp: 1200,
      hpDelta: -300, alive: true, firstPlace: false, roundsSurvived: 12, actions: {},
    },
  ],
}));
const syntheticSummary = aggregateLeague(syntheticMatches, { bootstrapIterations: 100 });
assert(syntheticSummary[0].strategy === 'candidate',
  'summary should sort the lower average rank first');
const passingGate = evaluatePromotionGate(syntheticMatches, {
  candidate: 'candidate', baseline: 'baseline', metric: 'both', minPairedSeeds: 8,
}, { bootstrapIterations: 200, baseSeed: 'gate-test' });
assert(passingGate.passed && passingGate.rankAdvantage.low > 0 && passingGate.hpAdvantage.low > 0,
  'paired positive rank and HP lower bounds should pass promotion');
const underpoweredGate = evaluatePromotionGate(syntheticMatches.slice(0, 2), {
  candidate: 'candidate', baseline: 'baseline', minPairedSeeds: 8,
}, { bootstrapIterations: 50 });
assert(!underpoweredGate.passed && underpoweredGate.reason === 'insufficient-paired-seeds',
  'a positive result with too few independent seeds must not promote');

const blueprintTelemetrySummary = aggregateLeague([{
  seedGroup: 'blueprint-telemetry-seed',
  results: [{
    strategy: 'blueprint', strategyLabel: 'Blueprint', rank: 1, hp: 2200,
    hpDelta: 700, alive: true, firstPlace: true, roundsSurvived: 12,
    actions: {
      decisions: 100,
      blueprintDecisions: 100,
      blueprintHits: 5,
      blueprintWeightTotal: 1,
      blueprintHitWeightTotal: 1,
      blueprintNodeVisitsTotal: 500,
      blueprintConfidenceTotal: 4,
      blueprintInterventions: 4,
      blueprintActionChanges: 2,
      blueprintPolicyTVTotal: 6,
      blueprintInfluenceTotal: 2,
      blueprintAdvantageGuardDecisions: 5,
      blueprintAdvantageComplete: 4,
      blueprintAdvantagePassed: 2,
      blueprintAdvantageMeanTotal: 50,
      blueprintAdvantageMeanSamples: 4,
      blueprintAdvantageLowerBoundTotal: 8,
      blueprintAdvantageLowerBoundSamples: 4,
      blueprintAdvantageMinSamplesTotal: 1000,
      blueprintAdvantageCoveredActionsTotal: 10,
      blueprintAdvantageRequiredActionsTotal: 12,
      blueprintExactHits: 2,
      blueprintHistoryBackoffHits: 1,
      blueprintPositionBackoffHits: 1,
      blueprintStrategicBackoffHits: 1,
    },
  }],
}], { bootstrapIterations: 25 }).find((row) => row.strategy === 'blueprint');
assertApprox(blueprintTelemetrySummary.blueprintHitRate, 0.05, 'blueprint hit rate');
assertApprox(blueprintTelemetrySummary.exactHitRate, 0.02, 'exact blueprint hit rate');
assert(blueprintTelemetrySummary.blueprintBackoffCounts.exact === 2
  && blueprintTelemetrySummary.blueprintBackoffCounts.history === 1
  && blueprintTelemetrySummary.blueprintBackoffCounts.position === 1
  && blueprintTelemetrySummary.blueprintBackoffCounts.strategic === 1
  && blueprintTelemetrySummary.blueprintBackoffCounts.none === 95,
'exact/history/position/strategic/miss counts must remain separate');
assertApprox(blueprintTelemetrySummary.blueprintBackoffRates.history, 0.01,
  'history-backoff rate');
assertApprox(blueprintTelemetrySummary.blueprintBackoffRates.position, 0.01,
  'position-backoff rate');
assertApprox(blueprintTelemetrySummary.blueprintBackoffRates.strategic, 0.01,
  'strategic-backoff rate');
assertApprox(blueprintTelemetrySummary.blueprintConditionalWeight, 0.2,
  'conditional checkpoint weight');
assertApprox(blueprintTelemetrySummary.meanBlueprintNodeVisits, 100,
  'conditional mean blueprint node visits');
assertApprox(blueprintTelemetrySummary.meanBlueprintConfidence, 0.8,
  'conditional mean blueprint confidence');
assertApprox(blueprintTelemetrySummary.interventionRate, 0.04,
  'blueprint intervention rate');
assertApprox(blueprintTelemetrySummary.actionChangeRate, 0.02,
  'blueprint action-change rate');
assertApprox(blueprintTelemetrySummary.meanPolicyTV, 0.06, 'mean policy TV');
assertApprox(blueprintTelemetrySummary.meanInfluence, 0.02, 'mean blueprint influence');
assertApprox(blueprintTelemetrySummary.advantageGuardDecisionRate, 0.05,
  'advantage guard decision rate');
assertApprox(blueprintTelemetrySummary.advantageCompleteRate, 0.8,
  'advantage estimate completion rate');
assertApprox(blueprintTelemetrySummary.advantagePassRate, 0.4,
  'advantage lower-bound pass rate');
assertApprox(blueprintTelemetrySummary.meanAdvantage, 12.5,
  'conditional mean estimated advantage');
assertApprox(blueprintTelemetrySummary.meanAdvantageLowerBound, 2,
  'conditional mean advantage lower bound');
assertApprox(blueprintTelemetrySummary.meanAdvantageMinSamples, 200,
  'conditional mean advantage sample floor');
assertApprox(blueprintTelemetrySummary.advantageActionCoverage, 10 / 12,
  'advantage action-value coverage');

const syntheticBlueprintPass = {
  ...passingGate,
  candidate: 'blueprint',
  baseline: 'qyz',
};
const emptyBlueprintGate = enforcePromotionEligibility(syntheticBlueprintPass, {
  tableSize: 6,
  rotations: 'full',
  mirror: true,
  candidateBaselineCrossover: true,
  summary: [{
    strategy: 'blueprint',
    blueprintHitRate: 0,
    meanBlueprintWeight: 0,
    actions: { blueprintDecisions: 100, blueprintHits: 0 },
  }],
  gate: {},
});
assert(!emptyBlueprintGate.passed
  && emptyBlueprintGate.reason === 'blueprint-hit-rate-below-threshold'
  && emptyBlueprintGate.blueprintCoverage.minHitRate === 0.01
  && emptyBlueprintGate.eligibilityBlockers.includes('blueprint-influence-below-threshold')
  && emptyBlueprintGate.eligibilityBlockers.includes(
    'blueprint-action-change-rate-below-threshold',
  ),
'an empty or mismatched blueprint checkpoint must not inherit the base policy promotion');
const coveredBlueprintGate = enforcePromotionEligibility(syntheticBlueprintPass, {
  tableSize: 6,
  rotations: 6,
  mirror: true,
  candidateBaselineCrossover: true,
  summary: [{
    strategy: 'blueprint',
    blueprintHitRate: 0.02,
    exactHitRate: 0.01,
    blueprintBackoffCounts: {
      exact: 1, history: 1, position: 0, strategic: 0, unknown: 0, none: 98,
    },
    blueprintBackoffRates: {
      exact: 0.01, history: 0.01, position: 0, strategic: 0, unknown: 0, none: 0.98,
    },
    meanBlueprintWeight: 0.005,
    blueprintConditionalWeight: 0.25,
    meanBlueprintNodeVisits: 100,
    meanBlueprintConfidence: 0.8,
    interventionRate: 0.03,
    actionChangeRate: 0.02,
    meanPolicyTV: 0.04,
    meanInfluence: 0.02,
    actions: { blueprintDecisions: 100, blueprintHits: 2 },
  }],
  gate: {},
});
assert(coveredBlueprintGate.passed && coveredBlueprintGate.blueprintCoverage.hits === 2,
'a statistically passing, balanced and materially influential candidate remains eligible');
assertApprox(coveredBlueprintGate.blueprintCoverage.blueprintConditionalWeight, 0.25,
  'eligibility report conditional blueprint weight');
assertApprox(coveredBlueprintGate.blueprintCoverage.exactHitRate, 0.01,
  'eligibility must report exact hits separately from usable backoff hits');
assert(coveredBlueprintGate.blueprintCoverage.backoffCounts.history === 1,
  'eligibility must retain per-level backoff counts');

const stricterMaterialityGate = enforcePromotionEligibility(syntheticBlueprintPass, {
  tableSize: 6,
  rotations: 'full',
  mirror: true,
  candidateBaselineCrossover: true,
  summary: [{
    strategy: 'blueprint',
    blueprintHitRate: 0.02,
    actionChangeRate: 0.02,
    meanInfluence: 0.02,
    actions: { blueprintDecisions: 100, blueprintHits: 2 },
  }],
  gate: {
    minBlueprintHitRate: 0.021,
    minBlueprintMeanInfluence: 0.021,
    minBlueprintActionChangeRate: 0.021,
  },
});
assert(!stricterMaterialityGate.passed
  && stricterMaterialityGate.eligibilityBlockers.includes(
    'blueprint-hit-rate-below-threshold',
  )
  && stricterMaterialityGate.eligibilityBlockers.includes(
    'blueprint-influence-below-threshold',
  )
  && stricterMaterialityGate.eligibilityBlockers.includes(
    'blueprint-action-change-rate-below-threshold',
  ), 'stricter CLI materiality thresholds must all be enforced');
assertThrows(() => enforcePromotionEligibility(syntheticBlueprintPass, {
  tableSize: 6,
  rotations: 'full',
  mirror: true,
  candidateBaselineCrossover: true,
  summary: [blueprintTelemetrySummary],
  gate: { minBlueprintMeanInfluence: -0.1 },
}), /non-negative/, 'negative blueprint thresholds must be rejected');

console.log('AI league self-test passed: deterministic 6/9-seat matches, exact/backoff telemetry, cluster CI and material blueprint promotion gate');
