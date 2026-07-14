// Deterministic aggregation for opt-in runtime exact-infoset reach profiles.
// Raw abstract keys are confined to the separately written profile artifact;
// ordinary league reports only retain their existing aggregate telemetry.

import { createHmac } from 'node:crypto';

import {
  BLUEPRINT_ABSTRACTION,
  BLUEPRINT_SCHEMA,
  BLUEPRINT_VERSION,
} from '../../js/game/blueprint-policy.js';
import { MAX_ROUNDS } from '../../js/game/config.js';
import { derivePublicOpponentStats } from '../../js/game/opponent-range.js';

export const EXACT_INFOSET_PROFILE_SCHEMA = 'qyj-exact-infoset-reach-profile-v2';
export const EXACT_INFOSET_PROFILE_VERSION = 2;
export const LEGACY_EXACT_INFOSET_PROFILE_SCHEMA = 'qyj-exact-infoset-reach-profile-v1';
export const LEGACY_EXACT_INFOSET_PROFILE_VERSION = 1;

const SOURCE_GROUP_PREFIX = 'pg_';
const SOURCE_GROUP_SECRET_PREFIX = 'ps_';
const SHA256_HEX = '[0-9a-f]{64}';
const SOURCE_GROUP_PATTERN = new RegExp(`^${SOURCE_GROUP_PREFIX}${SHA256_HEX}$`);
const SOURCE_GROUP_SECRET_PATTERN = new RegExp(
  `^${SOURCE_GROUP_SECRET_PREFIX}${SHA256_HEX}$`,
);
const PROFILE_HMAC_DOMAIN = 'qyj-exact-infoset-profile-v2';
const LEGACY_PROVENANCE_BLOCKER = 'profile-v1-missing-source-group-provenance';
const DISABLED_PROVENANCE_BLOCKER = 'profile-source-group-provenance-disabled';
const EMPTY_PROVENANCE_BLOCKER = 'profile-has-no-source-groups';

const BACKOFF_LEVELS = Object.freeze([
  'exact', 'history', 'position', 'strategic', 'population', 'unknown', 'none',
]);

function secretBytes(secret) {
  const bytes = typeof secret === 'string'
    ? Buffer.from(secret, 'utf8')
    : Buffer.isBuffer(secret) || secret instanceof Uint8Array
      ? Buffer.from(secret)
      : null;
  if (!bytes || bytes.length < 32) {
    throw new RangeError('profile source-group secret must contain at least 32 bytes');
  }
  return bytes;
}

function hmacParts(secret, ...parts) {
  const hmac = createHmac('sha256', secretBytes(secret));
  for (const part of parts) {
    const bytes = Buffer.from(String(part), 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hmac.update(length);
    hmac.update(bytes);
  }
  return hmac.digest('hex');
}

/** One-way identifier used to prove that two profile group sets are comparable. */
export function exactInfosetProfileSecretId(secret) {
  return `${SOURCE_GROUP_SECRET_PREFIX}${hmacParts(
    secret, PROFILE_HMAC_DOMAIN, 'secret-fingerprint',
  )}`;
}

/** HMAC one seed cluster without persisting its raw base seed or match seed. */
export function exactInfosetProfileSourceGroup(secret, seedGroup) {
  if (seedGroup == null || String(seedGroup).length === 0) {
    throw new TypeError('profile seedGroup must be non-empty');
  }
  return `${SOURCE_GROUP_PREFIX}${hmacParts(
    secret, PROFILE_HMAC_DOMAIN, 'source-group', String(seedGroup),
  )}`;
}

function validateSourceGroupSecretId(value, label = 'sourceGroupSecretId') {
  if (value == null) return null;
  const id = String(value);
  if (!SOURCE_GROUP_SECRET_PATTERN.test(id)) {
    throw new TypeError(`${label} must be an opaque profile secret fingerprint`);
  }
  return id;
}

function validateSourceGroups(values, label) {
  if (!Array.isArray(values)
    || values.some((value) => typeof value !== 'string' || !SOURCE_GROUP_PATTERN.test(value))) {
    throw new TypeError(`${label} must contain only opaque profile source groups`);
  }
  if (new Set(values).size !== values.length
    || values.some((value, index) => index > 0 && value < values[index - 1])) {
    throw new RangeError(`${label} must be unique and sorted`);
  }
  return values;
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function safeLevel(value) {
  return BACKOFF_LEVELS.includes(value) ? value : 'unknown';
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function optionalFinite(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function snapshotCard(card) {
  const rank = Number(card?.rank);
  const suit = Number(card?.suit);
  if (!Number.isInteger(rank) || rank < 2 || rank > 14
    || !Number.isInteger(suit) || suit < 1 || suit > 4) {
    throw new TypeError('training snapshot contains an invalid card');
  }
  return { rank, suit };
}

/**
 * Training-only reconstruction snapshot. This is an exact allow-list and is
 * intentionally separate from ordinary league JSON because selfHole contains
 * physical private cards. Opponent holes and unrevealed board/deck state are
 * never accepted or retained.
 */
export function buildExactInfosetTrainingSnapshot(observation) {
  if (!observation || typeof observation !== 'object') {
    throw new TypeError('training snapshot requires an Observation');
  }
  const handSeats = (Array.isArray(observation.handSeats) ? observation.handSeats : [])
    .map(finite);
  const handSeatSet = new Set(handSeats);
  const publicSeatCapacity = Math.max(
    0,
    finite(observation.publicSeatCapacity),
    ...(Array.isArray(observation.players) ? observation.players : [])
      .filter(Boolean)
      .map((player) => finite(player.idx)),
    ...handSeats,
  );
  const players = (Array.isArray(observation.players) ? observation.players : [])
    .filter((player) => player && handSeatSet.has(finite(player.idx)))
    .map((player) => ({
      idx: finite(player.idx),
      hp: finite(player.hp),
      folded: player.folded === true,
      allIn: player.allIn === true,
      betStreet: finite(player.betStreet),
      betRound: finite(player.betRound),
      acted: player.acted === true,
      position: typeof player.position === 'string' ? player.position : null,
    }))
    .sort((left, right) => left.idx - right.idx);
  const currentRound = finite(observation.round);
  // Keep the cross-hand state in a separate, deliberately tiny allow-list.
  // The normal `players` array below still contains only this hand's seats;
  // tournament players never carry names, heroes, policies, cards or account
  // identifiers.  Accepting an already-sanitized `tournament` object keeps a
  // profile stable when ExactInfosetReachProfiler validates it a second time.
  const rawTournament = observation.tournament && typeof observation.tournament === 'object'
    ? observation.tournament : null;
  const observationPlayers = Array.isArray(observation.players) ? observation.players : [];
  const hasTournamentSource = rawTournament != null
    || observation.seatCount != null
    || observationPlayers.some((player) => typeof player?.alive === 'boolean');
  const tournamentSource = Array.isArray(rawTournament?.players)
    ? rawTournament.players : hasTournamentSource ? observationPlayers : [];
  const tournamentPlayers = tournamentSource
    .filter(Boolean)
    .map((player) => ({
      idx: finite(player.idx),
      hp: finite(player.hp),
      alive: player.alive === true,
    }))
    .filter((player) => Number.isInteger(player.idx) && player.idx > 0)
    .sort((left, right) => left.idx - right.idx);
  const tournamentTableSize = finite(
    rawTournament?.tableSize ?? observation.seatCount ?? tournamentPlayers.length,
  );
  const tournamentMaxRounds = finite(rawTournament?.maxRounds ?? MAX_ROUNDS);
  const rangeStats = [...derivePublicOpponentStats({
    actionHistory: observation.actionHistory,
    handSeats,
    observerIdx: observation.observerIdx,
    round: currentRound,
  })].map(([idx, stats]) => ({ idx, ...stats }));
  const actionHistory = (Array.isArray(observation.actionHistory)
    ? observation.actionHistory : [])
    .filter((event) => finite(event?.round) === currentRound
      && handSeatSet.has(finite(event?.actorIdx)))
    .map((event) => ({
    id: finite(event.id),
    actorIdx: finite(event.actorIdx),
    round: finite(event.round),
    street: typeof event.street === 'string' ? event.street : 'idle',
    type: typeof event.type === 'string' ? event.type : 'unknown',
    key: typeof event.key === 'string' ? event.key : 'unknown',
    amount: finite(event.amount),
    callAmount: finite(event.callAmount),
    raiseIncrement: finite(event.raiseIncrement),
    raiseTo: optionalFinite(event.raiseTo),
    potBefore: finite(event.potBefore),
    potAfter: finite(event.potAfter),
    currentBetBefore: finite(event.currentBetBefore),
    currentBetAfter: finite(event.currentBetAfter),
    actorStackBefore: finite(event.actorStackBefore),
    actorBetStreetBefore: finite(event.actorBetStreetBefore),
    position: typeof event.position === 'string' ? event.position : null,
    playersInHand: finite(event.playersInHand),
    board: (Array.isArray(event.board) ? event.board : []).map(snapshotCard),
    isAggressive: event.isAggressive === true,
    forced: event.forced === true,
  }));
  const legal = observation.legalActions || {};
  return {
    observerIdx: finite(observation.observerIdx),
    publicSeatCapacity,
    round: currentRound,
    street: typeof observation.street === 'string' ? observation.street : 'idle',
    dealerIdx: finite(observation.dealerIdx),
    blinds: observation.blinds ? {
      sb: finite(observation.blinds.sb),
      bb: finite(observation.blinds.bb),
    } : null,
    board: (Array.isArray(observation.board) ? observation.board : []).map(snapshotCard),
    handSeats,
    activeSeats: (Array.isArray(observation.activeSeats) ? observation.activeSeats : [])
      .map(finite),
    players,
    rangeStats,
    tournament: hasTournamentSource ? {
      tableSize: tournamentTableSize,
      maxRounds: tournamentMaxRounds,
      players: tournamentPlayers,
    } : null,
    selfHole: (Array.isArray(observation.selfHole)
      ? observation.selfHole
      : Array.isArray(observation.self?.hole) ? observation.self.hole : [])
      .map(snapshotCard),
    betting: {
      pot: finite(observation.betting?.pot),
      currentBet: finite(observation.betting?.currentBet),
      minRaiseIncrement: finite(observation.betting?.minRaiseIncrement),
      streetRaiseCount: finite(observation.betting?.streetRaiseCount),
    },
    legalActions: {
      toCall: finite(legal.toCall),
      canCheck: legal.canCheck === true,
      callAmount: finite(legal.callAmount ?? legal.callAmt),
      allInAmount: finite(legal.allInAmount ?? legal.allinAmt),
      canRaise: legal.canRaise === true,
      canAllIn: legal.canAllIn === true,
      tiers: (Array.isArray(legal.tiers) ? legal.tiers : []).map((tier) => ({
        key: typeof tier.key === 'string' ? tier.key : '',
        increment: finite(tier.increment ?? tier.inc),
        cost: finite(tier.cost),
      })),
    },
    actionHistory,
  };
}

function assertAllowedKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new TypeError(`${label} contains a forbidden field`);
}

function validateSnapshotPrivacy(snapshot) {
  assertAllowedKeys(snapshot, [
    'observerIdx', 'publicSeatCapacity', 'round', 'street', 'dealerIdx', 'blinds', 'board',
    'handSeats', 'activeSeats', 'players', 'rangeStats', 'tournament', 'selfHole', 'betting',
    'legalActions', 'actionHistory',
  ], 'training snapshot');
  const publicSeatCapacity = Number(snapshot.publicSeatCapacity);
  const highestHandSeat = Math.max(0, ...(snapshot.handSeats || []).map(Number));
  if (!Number.isSafeInteger(publicSeatCapacity)
    || publicSeatCapacity < highestHandSeat || publicSeatCapacity > 9) {
    throw new RangeError('snapshot publicSeatCapacity is invalid');
  }
  if (snapshot.blinds) assertAllowedKeys(snapshot.blinds, ['sb', 'bb'], 'snapshot blinds');
  for (const card of [...(snapshot.board || []), ...(snapshot.selfHole || [])]) {
    assertAllowedKeys(card, ['rank', 'suit'], 'snapshot card');
  }
  for (const player of snapshot.players || []) {
    assertAllowedKeys(player, [
      'idx', 'hp', 'folded', 'allIn', 'betStreet', 'betRound', 'acted', 'position',
    ], 'snapshot player');
  }
  for (const stats of snapshot.rangeStats || []) {
    assertAllowedKeys(stats, [
      'idx', 'hands', 'vpip', 'pfr', 'threeBet', 'threeBetCount',
      'threeBetOpportunities', 'af', 'foldToCbet',
    ], 'snapshot public range stats');
  }
  if (snapshot.tournament != null) {
    assertAllowedKeys(snapshot.tournament, [
      'tableSize', 'maxRounds', 'players',
    ], 'snapshot tournament');
    for (const player of snapshot.tournament.players || []) {
      assertAllowedKeys(player, ['idx', 'hp', 'alive'], 'snapshot tournament player');
    }
  }
  assertAllowedKeys(snapshot.betting, [
    'pot', 'currentBet', 'minRaiseIncrement', 'streetRaiseCount',
  ], 'snapshot betting');
  assertAllowedKeys(snapshot.legalActions, [
    'toCall', 'canCheck', 'callAmount', 'allInAmount', 'canRaise', 'canAllIn', 'tiers',
  ], 'snapshot legal actions');
  for (const tier of snapshot.legalActions?.tiers || []) {
    assertAllowedKeys(tier, ['key', 'increment', 'cost'], 'snapshot legal tier');
  }
  for (const event of snapshot.actionHistory || []) {
    assertAllowedKeys(event, [
      'id', 'actorIdx', 'round', 'street', 'type', 'key', 'amount', 'callAmount',
      'raiseIncrement', 'raiseTo', 'potBefore', 'potAfter', 'currentBetBefore',
      'currentBetAfter', 'actorStackBefore', 'actorBetStreetBefore',
      'position', 'playersInHand', 'board', 'isAggressive', 'forced',
    ], 'snapshot action event');
    for (const card of event.board || []) {
      assertAllowedKeys(card, ['rank', 'suit'], 'snapshot action board card');
    }
  }
  return snapshot;
}

function sortedCounter(counter) {
  return Object.fromEntries([...counter.entries()]
    .sort(([left], [right]) => left.localeCompare(right)));
}

function fixedLevelCounter(source = null) {
  return Object.fromEntries(BACKOFF_LEVELS.map((level) => [
    level,
    nonNegative(source?.[level]),
  ]));
}

function validateTop(top) {
  const number = Number(top);
  if (!Number.isSafeInteger(number) || number < 1 || number > 1_000_000) {
    throw new RangeError('profile top must be an integer in 1..1000000');
  }
  return number;
}

function validateVariantsPerKey(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 32) {
    throw new RangeError('profile variantsPerKey must be an integer in 1..32');
  }
  return number;
}

function validateRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new TypeError('profile record must be an object');
  }
  if (typeof record.exactKey !== 'string'
    || !record.exactKey.startsWith('bp2|')
    || record.exactKey.length > 16_384) {
    // Do not interpolate the rejected key into an error that could reach an
    // ordinary league failure report.
    throw new TypeError('profile record has an invalid abstract key');
  }
  if (typeof record.strategy !== 'string' || !record.strategy) {
    throw new TypeError('profile record has an invalid strategy');
  }
  if (!['preflop', 'flop', 'turn', 'river'].includes(record.street)) {
    throw new TypeError('profile record has an invalid street');
  }
  if (record.sourceGroup != null
    && (typeof record.sourceGroup !== 'string'
      || !SOURCE_GROUP_PATTERN.test(record.sourceGroup))) {
    throw new TypeError('profile record has an invalid opaque source group');
  }
  validateSnapshotPrivacy(record.trainingSnapshot);
  return record;
}

function freshTotals() {
  return {
    observedDecisions: 0,
    usableHits: 0,
    exactHits: 0,
    interventions: 0,
    actionChanges: 0,
    nodeVisitSum: 0,
    confidenceSum: 0,
    influenceSum: 0,
    backoffCounts: fixedLevelCounter(),
  };
}

function updateTotals(target, record) {
  target.observedDecisions++;
  if (record.usableHit === true) target.usableHits++;
  if (record.exactHit === true) target.exactHits++;
  if (record.intervened === true) target.interventions++;
  if (record.actionChanged === true) target.actionChanges++;
  target.nodeVisitSum += nonNegative(record.nodeVisits);
  target.confidenceSum += Math.min(1, nonNegative(record.confidence));
  target.influenceSum += Math.min(1, nonNegative(record.influence));
  const level = record.usableHit === true ? safeLevel(record.backoffLevel) : 'none';
  target.backoffCounts[level]++;
}

function freshEntry(exactKey) {
  return {
    exactKey,
    count: 0,
    streets: new Map(),
    strategies: new Map(),
    actions: new Map(),
    totals: freshTotals(),
    snapshots: new Map(),
    sourceGroups: new Set(),
  };
}

function finalizedRates(totals) {
  const denominator = Math.max(1, totals.observedDecisions);
  return {
    usableHitRate: totals.usableHits / denominator,
    exactHitRate: totals.exactHits / denominator,
    interventionRate: totals.interventions / denominator,
    actionChangeRate: totals.actionChanges / denominator,
    meanNodeVisits: totals.nodeVisitSum / denominator,
    meanConfidence: totals.confidenceSum / denominator,
    meanInfluence: totals.influenceSum / denominator,
    backoffRates: Object.fromEntries(BACKOFF_LEVELS.map((level) => [
      level,
      totals.backoffCounts[level] / denominator,
    ])),
  };
}

function finalizedEntry(entry) {
  const totals = {
    ...entry.totals,
    backoffCounts: fixedLevelCounter(entry.totals.backoffCounts),
  };
  const trainingSnapshots = [...entry.snapshots.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, snapshot]) => snapshot);
  return {
    exactKey: entry.exactKey,
    count: entry.count,
    streets: sortedCounter(entry.streets),
    strategies: sortedCounter(entry.strategies),
    actions: sortedCounter(entry.actions),
    // Keep the singular field for v1 readers while publishing a bounded set
    // of distinct deterministic variants for tournament-value training.
    trainingSnapshot: trainingSnapshots[0],
    trainingSnapshots,
    sourceGroups: [...entry.sourceGroups].sort(),
    checkpoint: {
      usableHits: totals.usableHits,
      exactHits: totals.exactHits,
      interventions: totals.interventions,
      actionChanges: totals.actionChanges,
      backoffCounts: totals.backoffCounts,
      nodeVisitSum: totals.nodeVisitSum,
      confidenceSum: totals.confidenceSum,
      influenceSum: totals.influenceSum,
      ...finalizedRates(totals),
    },
  };
}

export class ExactInfosetReachProfiler {
  constructor({
    top = 50_000,
    variantsPerKey = 4,
    sourceGroupSecretId = null,
  } = {}) {
    this.top = validateTop(top);
    this.variantsPerKey = validateVariantsPerKey(variantsPerKey);
    this.sourceGroupSecretId = validateSourceGroupSecretId(sourceGroupSecretId);
    this.requireSourceGroups = this.sourceGroupSecretId != null;
    this.sourceGroups = new Set();
    this.entries = new Map();
    this.totals = freshTotals();
  }

  observe(rawRecord) {
    const record = validateRecord(rawRecord);
    const hasSourceGroup = typeof record.sourceGroup === 'string';
    if (this.requireSourceGroups && !hasSourceGroup) {
      throw new TypeError('profile V2 provenance requires an opaque source group on every record');
    }
    if (!this.requireSourceGroups && hasSourceGroup) {
      throw new TypeError('opaque source groups require a configured sourceGroupSecretId');
    }
    let entry = this.entries.get(record.exactKey);
    if (!entry) {
      entry = freshEntry(record.exactKey);
      this.entries.set(record.exactKey, entry);
    }
    entry.count++;
    entry.streets.set(record.street, (entry.streets.get(record.street) || 0) + 1);
    entry.strategies.set(
      record.strategy,
      (entry.strategies.get(record.strategy) || 0) + 1,
    );
    const actionKey = typeof record.actionKey === 'string' && record.actionKey
      ? record.actionKey : 'unknown';
    entry.actions.set(actionKey, (entry.actions.get(actionKey) || 0) + 1);
    if (hasSourceGroup) {
      entry.sourceGroups.add(record.sourceGroup);
      this.sourceGroups.add(record.sourceGroup);
    }
    const snapshot = buildExactInfosetTrainingSnapshot(record.trainingSnapshot);
    const snapshotCanonical = JSON.stringify(snapshot);
    if (!entry.snapshots.has(snapshotCanonical)) {
      entry.snapshots.set(snapshotCanonical, snapshot);
      if (entry.snapshots.size > this.variantsPerKey) {
        const largest = [...entry.snapshots.keys()].sort().at(-1);
        entry.snapshots.delete(largest);
      }
    }
    updateTotals(entry.totals, record);
    updateTotals(this.totals, record);
  }

  safeSummary() {
    const totals = {
      ...this.totals,
      backoffCounts: fixedLevelCounter(this.totals.backoffCounts),
    };
    return Object.freeze({
      observedDecisions: totals.observedDecisions,
      uniqueExactKeys: this.entries.size,
      sourceGroupCount: this.sourceGroups.size,
      usableHits: totals.usableHits,
      exactHits: totals.exactHits,
      backoffCounts: Object.freeze(totals.backoffCounts),
      ...finalizedRates(totals),
    });
  }

  finalize({
    tableSize,
    skillsEnabled = false,
    maxRaisesPerStreet = 3,
    strategies = [],
    matches = 0,
    fullScheduleMatches = 0,
    checkpointSha256 = null,
  } = {}) {
    if (skillsEnabled === true) {
      throw new RangeError('exact-infoset profiles require skillsEnabled=false');
    }
    const sortedEntries = [...this.entries.values()]
      .sort((left, right) => right.count - left.count
        || left.exactKey.localeCompare(right.exactKey));
    const retained = sortedEntries.slice(0, this.top).map(finalizedEntry);
    const safeSummary = this.safeSummary();
    const sourceGroups = [...this.sourceGroups].sort();
    const promotionEligible = this.requireSourceGroups && sourceGroups.length > 0;
    const promotionBlockers = promotionEligible
      ? []
      : [this.requireSourceGroups
        ? EMPTY_PROVENANCE_BLOCKER : DISABLED_PROVENANCE_BLOCKER];
    return {
      schema: EXACT_INFOSET_PROFILE_SCHEMA,
      version: EXACT_INFOSET_PROFILE_VERSION,
      blueprint: {
        schema: BLUEPRINT_SCHEMA,
        version: BLUEPRINT_VERSION,
        abstraction: BLUEPRINT_ABSTRACTION,
        keyPrefix: 'bp2',
        checkpointSha256: checkpointSha256 || null,
      },
      collection: {
        tableSize: Number(tableSize) || 0,
        skillsEnabled: skillsEnabled === true,
        maxRaisesPerStreet: Number(maxRaisesPerStreet),
        strategies: [...new Set([...(strategies || [])].map(String))].sort(),
        matches: Number(matches) || 0,
        fullScheduleMatches: Number(fullScheduleMatches) || 0,
        observedDecisions: safeSummary.observedDecisions,
        uniqueExactKeys: safeSummary.uniqueExactKeys,
        retainedExactKeys: retained.length,
        top: this.top,
        variantsPerKey: this.variantsPerKey,
        retainedTargetVariants: retained.reduce(
          (sum, entry) => sum + entry.trainingSnapshots.length, 0,
        ),
        truncated: retained.length < safeSummary.uniqueExactKeys,
        sourceGroupCount: sourceGroups.length,
        sourceGroups,
        sourceGroupSecretId: this.sourceGroupSecretId,
        promotionEligible,
        promotionBlockers,
      },
      totals: {
        usableHits: safeSummary.usableHits,
        exactHits: safeSummary.exactHits,
        usableHitRate: safeSummary.usableHitRate,
        exactHitRate: safeSummary.exactHitRate,
        interventionRate: safeSummary.interventionRate,
        actionChangeRate: safeSummary.actionChangeRate,
        meanNodeVisits: safeSummary.meanNodeVisits,
        meanConfidence: safeSummary.meanConfidence,
        meanInfluence: safeSummary.meanInfluence,
        backoffCounts: safeSummary.backoffCounts,
        backoffRates: safeSummary.backoffRates,
      },
      entries: retained,
    };
  }
}

export function validateExactInfosetProfile(profile) {
  const isCurrent = profile?.schema === EXACT_INFOSET_PROFILE_SCHEMA
    && Number(profile?.version) === EXACT_INFOSET_PROFILE_VERSION;
  const isLegacy = profile?.schema === LEGACY_EXACT_INFOSET_PROFILE_SCHEMA
    && Number(profile?.version) === LEGACY_EXACT_INFOSET_PROFILE_VERSION;
  if (!profile || typeof profile !== 'object' || (!isCurrent && !isLegacy)) {
    throw new TypeError('unsupported exact-infoset profile');
  }
  assertAllowedKeys(profile, [
    'schema', 'version', 'blueprint', 'collection', 'totals', 'entries',
  ], 'exact-infoset profile');
  assertAllowedKeys(profile.blueprint, [
    'schema', 'version', 'abstraction', 'keyPrefix', 'checkpointSha256',
  ], 'profile blueprint contract');
  const collectionKeys = [
    'tableSize', 'skillsEnabled', 'maxRaisesPerStreet', 'strategies',
    'matches', 'fullScheduleMatches', 'observedDecisions', 'uniqueExactKeys',
    'retainedExactKeys', 'top', 'variantsPerKey', 'retainedTargetVariants', 'truncated',
    ...(isCurrent ? [
      'sourceGroupCount', 'sourceGroups', 'sourceGroupSecretId',
      'promotionEligible', 'promotionBlockers',
    ] : []),
  ];
  assertAllowedKeys(profile.collection, collectionKeys, 'profile collection');
  assertAllowedKeys(profile.totals, [
    'usableHits', 'exactHits', 'usableHitRate', 'exactHitRate',
    'interventionRate', 'actionChangeRate', 'meanNodeVisits',
    'meanConfidence', 'meanInfluence', 'backoffCounts', 'backoffRates',
  ], 'profile totals');
  assertAllowedKeys(profile.totals.backoffCounts, BACKOFF_LEVELS, 'profile backoff counts');
  assertAllowedKeys(profile.totals.backoffRates, BACKOFF_LEVELS, 'profile backoff rates');
  if (profile.blueprint?.schema !== BLUEPRINT_SCHEMA
    || profile.blueprint?.version !== BLUEPRINT_VERSION
    || profile.blueprint?.abstraction !== BLUEPRINT_ABSTRACTION) {
    throw new TypeError('exact-infoset profile blueprint contract mismatch');
  }
  if (!Array.isArray(profile.entries)) {
    throw new TypeError('exact-infoset profile entries must be an array');
  }
  let collectionSourceGroups = new Set();
  if (isCurrent) {
    validateSourceGroups(profile.collection?.sourceGroups, 'profile collection.sourceGroups');
    collectionSourceGroups = new Set(profile.collection.sourceGroups);
    if (!Number.isSafeInteger(Number(profile.collection?.sourceGroupCount))
      || Number(profile.collection.sourceGroupCount) !== collectionSourceGroups.size) {
      throw new RangeError('profile collection.sourceGroupCount does not match sourceGroups');
    }
    const sourceGroupSecretId = validateSourceGroupSecretId(
      profile.collection?.sourceGroupSecretId,
      'profile collection.sourceGroupSecretId',
    );
    if (typeof profile.collection?.promotionEligible !== 'boolean') {
      throw new TypeError('profile collection.promotionEligible must be boolean');
    }
    if (!Array.isArray(profile.collection?.promotionBlockers)
      || profile.collection.promotionBlockers.some((value) => (
        typeof value !== 'string' || !value
      ))) {
      throw new TypeError('profile collection.promotionBlockers must be a string array');
    }
    if (profile.collection.promotionEligible) {
      if (!sourceGroupSecretId || collectionSourceGroups.size < 1
        || profile.collection.promotionBlockers.length !== 0) {
        throw new RangeError('promotion-eligible profile provenance is incomplete');
      }
    } else if (profile.collection.promotionBlockers.length < 1) {
      throw new RangeError('non-promotable profile must declare a provenance blocker');
    }
  }
  for (const entry of profile.entries) {
    assertAllowedKeys(entry, [
      'exactKey', 'count', 'streets', 'strategies', 'actions',
      'trainingSnapshot', 'trainingSnapshots', 'checkpoint',
      ...(isCurrent ? ['sourceGroups'] : []),
    ], 'profile entry');
    assertAllowedKeys(entry.checkpoint, [
      'usableHits', 'exactHits', 'interventions', 'actionChanges',
      'backoffCounts', 'nodeVisitSum', 'confidenceSum', 'influenceSum',
      'usableHitRate', 'exactHitRate', 'interventionRate', 'actionChangeRate',
      'meanNodeVisits', 'meanConfidence', 'meanInfluence', 'backoffRates',
    ], 'profile entry checkpoint');
    assertAllowedKeys(
      entry.checkpoint.backoffCounts, BACKOFF_LEVELS, 'entry backoff counts',
    );
    assertAllowedKeys(
      entry.checkpoint.backoffRates, BACKOFF_LEVELS, 'entry backoff rates',
    );
    validateSnapshotPrivacy(entry?.trainingSnapshot);
    if (isCurrent) {
      validateSourceGroups(entry.sourceGroups, 'profile entry.sourceGroups');
      if (entry.sourceGroups.some((sourceGroup) => !collectionSourceGroups.has(sourceGroup))) {
        throw new RangeError('profile entry source group is absent from collection provenance');
      }
      if (profile.collection.promotionEligible && entry.sourceGroups.length < 1) {
        throw new RangeError('promotion-eligible profile entry has no source group');
      }
    }
    if (entry.trainingSnapshots != null) {
      if (!Array.isArray(entry.trainingSnapshots) || entry.trainingSnapshots.length < 1
        || entry.trainingSnapshots.length > 32) {
        throw new RangeError('profile entry trainingSnapshots must contain 1..32 variants');
      }
      const canonical = entry.trainingSnapshots.map((snapshot) => {
        validateSnapshotPrivacy(snapshot);
        return JSON.stringify(snapshot);
      });
      if (new Set(canonical).size !== canonical.length
        || canonical.some((value, index) => index > 0 && value < canonical[index - 1])
        || canonical[0] !== JSON.stringify(entry.trainingSnapshot)) {
        throw new RangeError('profile entry trainingSnapshots must be unique, sorted and representative-first');
      }
    }
    validateRecord({
      exactKey: entry?.exactKey,
      strategy: Object.keys(entry?.strategies || {})[0] || 'aggregate',
      street: Object.keys(entry?.streets || {})[0],
      trainingSnapshot: entry?.trainingSnapshot,
    });
  }
  return profile;
}

/** Normalized release provenance; every legacy V1 artifact is non-promotable. */
export function exactInfosetProfileProvenance(profile) {
  validateExactInfosetProfile(profile);
  if (profile.schema === LEGACY_EXACT_INFOSET_PROFILE_SCHEMA) {
    return Object.freeze({
      promotionEligible: false,
      promotionBlockers: Object.freeze([LEGACY_PROVENANCE_BLOCKER]),
      sourceGroupCount: 0,
      sourceGroups: Object.freeze([]),
      sourceGroupSecretId: null,
    });
  }
  return Object.freeze({
    promotionEligible: profile.collection.promotionEligible === true,
    promotionBlockers: Object.freeze([...profile.collection.promotionBlockers]),
    sourceGroupCount: Number(profile.collection.sourceGroupCount),
    sourceGroups: Object.freeze([...profile.collection.sourceGroups]),
    sourceGroupSecretId: profile.collection.sourceGroupSecretId,
  });
}
