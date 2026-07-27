// Safe, immutable information-set projection for bot policies.
//
// This module intentionally constructs an allow-listed object instead of
// cloning Engine. Engine owns the deck, every hole card and all five board
// cards from the start of a hand; a generic clone would therefore be a leak.

import * as Config from './config.js';
import {
  assertNativeEngineInstance,
  assertNativePurePokerDecisionBoundary,
} from './engine.js';

export const MAX_SUPPORTED_SEATS = 9;

// A V375 collector must distinguish an immutable snapshot emitted by this
// allow-listed projection from an arbitrary object that merely resembles one.
// The provenance is process-local and non-serializable: it retains no Engine,
// card, hero, seed, or skill reference.
const PURE_POKER_OBSERVATION_PROVENANCE = new WeakMap();
// The broader pure-poker marker above is intentionally available to ordinary
// information-set consumers, including deterministic UI/test fixtures.  V375
// profile collection has a stronger requirement: its snapshot must come from
// an Engine instance registered by engine.js, not merely an Engine-shaped
// object.  This process-local capability is never serialized.
const NATIVE_PURE_POKER_OBSERVATION_PROVENANCE = new WeakMap();
const NATIVE_PURE_POKER_DECISION_RECEIPTS = new WeakMap();

const STREET_BOARD_LIMIT = Object.freeze({
  idle: 0,
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
});

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalNumber(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cloneCard(card) {
  if (!card || typeof card !== 'object') return null;
  const rank = Number(card.rank);
  const suit = Number(card.suit);
  if (!Number.isFinite(rank) || !Number.isFinite(suit)) return null;
  return { rank, suit };
}

function cloneCards(cards, limit = Infinity) {
  return (Array.isArray(cards) ? cards : [])
    .slice(0, Math.max(0, limit))
    .map(cloneCard)
    .filter(Boolean);
}

function cloneHero(hero) {
  if (!hero || typeof hero !== 'object') return null;
  const declaredIds = (Array.isArray(hero.skillIds)
    ? hero.skillIds
    : [hero.skillIds?.active, hero.skillIds?.passive])
    .filter((id) => typeof id === 'string');
  const activeIds = (hero.skills?.actives || hero.skills?.all || [])
    .filter((skill) => skill?.kind === 'active')
    .map((skill) => skill.id)
    .filter((id) => typeof id === 'string');
  const passiveIds = (hero.skills?.passives || hero.skills?.all || [])
    .filter((skill) => skill?.kind === 'passive')
    .map((skill) => skill.id)
    .filter((id) => typeof id === 'string');
  return {
    id: typeof hero.id === 'string' ? hero.id : null,
    name: typeof hero.name === 'string' ? hero.name : null,
    skillIds: {
      all: declaredIds,
      actives: activeIds,
      passives: passiveIds,
      active: activeIds[0] || null,
      passive: passiveIds[0] || null,
    },
  };
}

function cloneLastAction(action) {
  if (!action || typeof action !== 'object') return null;
  return {
    key: typeof action.key === 'string' ? action.key : null,
    amount: asNumber(action.amount),
    round: asNumber(action.round),
    street: typeof action.street === 'string' ? action.street : null,
  };
}

function clonePublicPlayer(player, position, { purePoker = false } = {}) {
  // A pure-poker policy must not even receive stable identity/skill-adjacent
  // fields.  In particular, a hero name can be a proxy for a hero id, and
  // energy/skill status can turn an otherwise ordinary poker model into a
  // skill-conditioned model.  Build the common public poker snapshot first
  // and add the richer game-mode fields only for skills-enabled observations.
  const pokerSnapshot = {
    idx: asNumber(player.idx),
    position,
    hp: asNumber(player.hp),
    alive: !!player.alive,
    folded: !!player.folded,
    allIn: !!player.allIn,
    betStreet: asNumber(player.betStreet),
    betRound: asNumber(player.betRound),
    acted: !!player.acted,
    lastAction: cloneLastAction(player.lastAction),
    showdown: player.showdownInfo && typeof player.showdownInfo === 'object'
      ? {
        name: typeof player.showdownInfo.name === 'string' ? player.showdownInfo.name : null,
        cat: optionalNumber(player.showdownInfo.cat),
      }
      : null,
  };
  if (purePoker) return pokerSnapshot;

  const skillModifiers = (Array.isArray(player.skillStatuses) ? player.skillStatuses : [])
    .filter((status) => status && typeof status.modifier === 'string')
    .map((status) => ({
      modifier: status.modifier,
      amount: asNumber(status.amount),
    }));
  const revealedCard = cloneCard(player.skillData?.revealedCard);
  return {
    ...pokerSnapshot,
    playerName: typeof player.playerName === 'string' ? player.playerName : null,
    playerId: typeof player.playerId === 'string' ? player.playerId : null,
    isHuman: !!player.isHuman,
    hero: cloneHero(player.hero),
    energy: asNumber(player.energy),
    skillUsed: !!player.skillUsed,
    skillModifiers,
    publicRevealedCard: revealedCard,
  };
}

function positionForSeat(actorIdx, dealerIdx, handSeats) {
  const seats = [...new Set(handSeats.map(Number))]
    .filter((idx) => Number.isInteger(idx) && idx > 0)
    .sort((a, b) => a - b);
  if (!seats.includes(actorIdx) || !seats.includes(dealerIdx)) return null;
  const dealerOffset = seats.indexOf(dealerIdx);
  const order = seats.slice(dealerOffset).concat(seats.slice(0, dealerOffset));
  const offset = order.indexOf(actorIdx);
  if (seats.length === 2) return offset === 0 ? 'BTN/SB' : 'BB';
  if (offset === 0) return 'BTN';
  if (offset === 1) return 'SB';
  if (offset === 2) return 'BB';
  const earlyToLate = {
    4: ['CO'],
    5: ['UTG', 'CO'],
    6: ['UTG', 'HJ', 'CO'],
    7: ['UTG', 'LJ', 'HJ', 'CO'],
    8: ['UTG', 'UTG+1', 'LJ', 'HJ', 'CO'],
    9: ['UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO'],
  };
  return earlyToLate[seats.length]?.[offset - 3] || `EP+${offset - 3}`;
}

function cloneActionEvent(event) {
  const street = typeof event?.street === 'string' ? event.street : 'idle';
  const boardLimit = STREET_BOARD_LIMIT[street] ?? 0;
  return {
    id: asNumber(event?.id),
    actorIdx: asNumber(event?.actorIdx),
    round: asNumber(event?.round),
    street,
    type: typeof event?.type === 'string' ? event.type : 'unknown',
    key: typeof event?.key === 'string' ? event.key : 'unknown',
    amount: asNumber(event?.amount),
    callAmount: asNumber(event?.callAmount),
    raiseIncrement: asNumber(event?.raiseIncrement),
    raiseTo: optionalNumber(event?.raiseTo),
    potBefore: asNumber(event?.potBefore),
    potAfter: asNumber(event?.potAfter),
    currentBetBefore: asNumber(event?.currentBetBefore),
    currentBetAfter: asNumber(event?.currentBetAfter),
    actorStackBefore: optionalNumber(event?.actorStackBefore),
    actorStackAfter: optionalNumber(event?.actorStackAfter),
    actorBetStreetBefore: optionalNumber(event?.actorBetStreetBefore),
    actorBetStreetAfter: optionalNumber(event?.actorBetStreetAfter),
    dealerIdx: asNumber(event?.dealerIdx),
    position: typeof event?.position === 'string' ? event.position : null,
    playersInHand: asNumber(event?.playersInHand),
    handSize: asNumber(event?.handSize),
    handSeats: (Array.isArray(event?.handSeats) ? event.handSeats : [])
      .map((idx) => asNumber(idx)),
    board: cloneCards(event?.board, boardLimit),
    activeSeatsBefore: (Array.isArray(event?.activeSeatsBefore)
      ? event.activeSeatsBefore : []).map((idx) => asNumber(idx)),
    activeSeats: (Array.isArray(event?.activeSeats) ? event.activeSeats : [])
      .map((idx) => asNumber(idx)),
    isAggressive: !!event?.isAggressive,
    forced: !!event?.forced,
  };
}

function cloneKnowledgeResult(result) {
  if (!result || typeof result !== 'object') return { kind: 'unknown' };
  const copy = { kind: typeof result.kind === 'string' ? result.kind : 'unknown' };
  for (const key of ['targetIdx', 'cardIdx', 'slot', 'suit']) {
    const value = optionalNumber(result[key]);
    if (value != null) copy[key] = value;
  }
  for (const key of ['band', 'choice', 'skillName']) {
    if (typeof result[key] === 'string') copy[key] = result[key];
  }
  const card = cloneCard(result.card);
  if (card) copy.card = card;
  return copy;
}

function clonePrivateKnowledge(entry) {
  return {
    id: asNumber(entry?.id),
    round: asNumber(entry?.round),
    street: typeof entry?.street === 'string' ? entry.street : 'idle',
    result: cloneKnowledgeResult(entry?.result),
  };
}

function clonePublicKnowledge(entry) {
  return {
    ...clonePrivateKnowledge(entry),
    actorIdx: asNumber(entry?.actorIdx),
  };
}

function cloneOptions(engine, observer) {
  const isTurn = Number(engine.actingIdx) === observer.idx
    || Number(engine.waitingIdx) === observer.idx;
  if (!isTurn || typeof engine.getOptions !== 'function') return null;
  const options = engine.getOptions(observer);
  if (!options || typeof options !== 'object') return null;
  return {
    toCall: asNumber(options.toCall),
    canCheck: !!options.canCheck,
    callAmount: asNumber(options.callAmt),
    allInAmount: asNumber(options.allinAmt),
    canRaise: !!options.canRaise,
    canAllIn: !!options.canAllIn,
    tiers: (Array.isArray(options.tiers) ? options.tiers : []).map((tier) => ({
      key: typeof tier.key === 'string' ? tier.key : null,
      name: typeof tier.name === 'string' ? tier.name : null,
      increment: asNumber(tier.inc),
      cost: asNumber(tier.cost),
    })),
  };
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

/**
 * Build a bot-facing information set without retaining any Engine references.
 * `player` may be the Engine player object or its one-based seat index.
 */
export function buildObservation(engine, player) {
  if (!engine || !Array.isArray(engine.players)) {
    throw new TypeError('buildObservation requires an Engine-like object with players');
  }
  const observerIdx = Number(typeof player === 'object' ? player?.idx : player);
  const observer = engine.players[observerIdx];
  if (!Number.isInteger(observerIdx) || observerIdx < 1 || !observer) {
    throw new RangeError('buildObservation requires a valid observer seat');
  }
  // `false` is the only accepted pure-poker state.  It is intentionally
  // narrow: an Engine-like object that omits the flag keeps the normal game
  // projection rather than silently being treated as skill-free.
  const purePoker = engine.skillsEnabled === false;
  let nativeEngine = false;
  if (purePoker) {
    try {
      assertNativeEngineInstance(engine);
      nativeEngine = true;
    } catch (error) {
      // The public observation projection deliberately continues to support
      // Engine-like fixtures.  They receive only the ordinary pure-poker
      // marker; V375's strict collector entry point below refuses them.
      if (!(error instanceof RangeError)) throw error;
    }
  }

  const occupiedPlayers = engine.players.slice(1).filter(Boolean);
  const highestSeat = occupiedPlayers.reduce(
    (highest, candidate) => Math.max(highest, asNumber(candidate.idx)), 0,
  );
  if (occupiedPlayers.length > MAX_SUPPORTED_SEATS || highestSeat > MAX_SUPPORTED_SEATS) {
    throw new RangeError(`buildObservation supports at most ${MAX_SUPPORTED_SEATS} seats`);
  }

  const street = typeof engine.street === 'string' ? engine.street : 'idle';
  const streetLimit = STREET_BOARD_LIMIT[street] ?? 0;
  const revealed = Math.min(
    5,
    streetLimit,
    Math.max(0, Math.floor(asNumber(engine.revealed))),
  );
  const board = cloneCards(engine.board, revealed);
  const fallbackHandSeats = occupiedPlayers
    .filter((candidate) => candidate.alive)
    .map((candidate) => asNumber(candidate.idx));
  const handSeats = (Array.isArray(engine.currentHandSeats) && engine.currentHandSeats.length
    ? engine.currentHandSeats : fallbackHandSeats)
    .map((idx) => asNumber(idx))
    .filter((idx) => Number.isInteger(idx) && idx > 0 && idx <= MAX_SUPPORTED_SEATS);
  const dealerIdx = asNumber(engine.dealerIdx);
  const players = Array(highestSeat + 1).fill(null);
  for (const candidate of occupiedPlayers) {
    const idx = asNumber(candidate.idx);
    players[idx] = clonePublicPlayer(
      candidate,
      positionForSeat(idx, dealerIdx, handSeats),
      { purePoker },
    );
  }

  // Preserve a stable, empty knowledge interface for the ordinary AI, but do
  // not read any skill store when a caller explicitly selected pure poker.
  // This makes a stale/malicious Engine skill payload observationally inert.
  const hasPrivateKnowledgeStore = !purePoker && Array.isArray(engine.privateSkillKnowledge);
  const hasPublicKnowledgeStore = !purePoker && Array.isArray(engine.publicSkillKnowledge);
  const privateSkillResults = hasPrivateKnowledgeStore
    ? (engine.privateSkillKnowledge[observerIdx] || []).map(clonePrivateKnowledge)
    : [];
  const publicSkillResults = hasPublicKnowledgeStore
    ? engine.publicSkillKnowledge.map(clonePublicKnowledge)
    : [];
  const round = asNumber(engine.round);
  const blinds = round > 0 && typeof Config.getBlinds === 'function'
    ? { ...Config.getBlinds(round) }
    : null;
  const activeSeats = occupiedPlayers
    .filter((candidate) => candidate.alive && !candidate.folded)
    .map((candidate) => asNumber(candidate.idx));
  const publicObserver = players[observerIdx];

  const observation = {
    version: 1,
    observerIdx,
    seatCount: occupiedPlayers.length,
    // `seatCount` is the currently occupied/visible count and can shrink late
    // in a tournament.  Keep the configured table size separately so an
    // offline pure-poker collector cannot silently reinterpret a short-handed
    // 6-max table as 9-max (or vice versa).
    tableSize: Number.isSafeInteger(Number(engine.tableSize))
      ? Number(engine.tableSize) : occupiedPlayers.length,
    maxSupportedSeats: MAX_SUPPORTED_SEATS,
    // These are explicit boundary sentinels for consumers that must reject
    // non-pure observations.  They are not strategy features: a pure-poker
    // projection always carries exactly false/null and V375 discards them.
    skillsEnabled: purePoker ? false : true,
    skillSchemaVersion: purePoker ? null : 'qyj-current-hero-skill-schema',
    round,
    street,
    dealerIdx,
    actingIdx: asNumber(engine.actingIdx),
    waitingIdx: optionalNumber(engine.waitingIdx),
    gameOver: !!engine.gameOver,
    blinds,
    board,
    revealed: board.length,
    handSeats: [...handSeats],
    activeSeats,
    players,
    self: {
      ...publicObserver,
      hole: cloneCards(observer.hole, 2),
    },
    betting: {
      pot: typeof engine.totalPot === 'function'
        ? asNumber(engine.totalPot())
        : asNumber(engine.pot),
      currentBet: asNumber(engine.currentBet),
      minRaiseIncrement: asNumber(engine.minRaiseInc),
      streetRaiseCount: asNumber(engine.streetRaiseCount),
    },
    legalActions: cloneOptions(engine, observer),
    actionHistory: (Array.isArray(engine.actionHistory) ? engine.actionHistory : [])
      .map(cloneActionEvent),
    knowledge: {
      privateSkillResults,
      publicSkillResults,
      persistence: {
        privateSkillResults: purePoker
          ? 'disabled-by-pure-poker-projection'
          : hasPrivateKnowledgeStore
          ? 'complete-since-engine-construction'
          : 'unavailable',
        publicSkillResults: purePoker
          ? 'disabled-by-pure-poker-projection'
          : hasPublicKnowledgeStore
          ? 'complete-since-engine-construction'
          : 'unavailable',
        gap: purePoker || (hasPrivateKnowledgeStore && hasPublicKnowledgeStore)
          ? null
          : 'This Engine-like state does not persist one or more skill-result event streams.',
      },
    },
  };

  const frozen = deepFreeze(observation);
  if (purePoker) {
    const provenance = Object.freeze({
      tableSize: frozen.tableSize,
      round: frozen.round,
      skillsEnabled: false,
      skillSchemaVersion: null,
    });
    PURE_POKER_OBSERVATION_PROVENANCE.set(frozen, provenance);
    if (nativeEngine) NATIVE_PURE_POKER_OBSERVATION_PROVENANCE.set(frozen, provenance);
  }
  return frozen;
}

/**
 * Engine-only capture path for V375.  The Engine creates the immutable
 * information set before notifying any listener, then passes this snapshot to
 * the callback.  Ordinary buildObservation() calls intentionally never gain a
 * decision receipt, even if made while a callback is running.
 */
export function captureNativePurePokerDecisionObservation(engine, player, boundary) {
  const observerIdx = Number(typeof player === 'object' ? player?.idx : player);
  const verifiedBoundary = assertNativePurePokerDecisionBoundary(engine, observerIdx, boundary);
  const frozen = buildObservation(engine, observerIdx);
  if (frozen.tableSize !== verifiedBoundary.tableSize
    || frozen.observerIdx !== verifiedBoundary.observerIdx
    || frozen.round !== verifiedBoundary.round
    || frozen.street !== verifiedBoundary.street) {
    throw new RangeError('Native pure-poker decision snapshot diverged before callback dispatch');
  }
  NATIVE_PURE_POKER_DECISION_RECEIPTS.set(frozen, Object.freeze({
    decisionReceipt: verifiedBoundary.decisionReceipt,
    chanceStreamReceipt: verifiedBoundary.chanceStreamReceipt,
    collectorBinding: verifiedBoundary.collectorBinding,
    tableSize: verifiedBoundary.tableSize,
    observerIdx: verifiedBoundary.observerIdx,
    round: verifiedBoundary.round,
    street: verifiedBoundary.street,
    sequence: verifiedBoundary.sequence,
  }));
  return frozen;
}

/**
 * Assert that an Observation was emitted by the local pure-poker projection.
 * This is intentionally a WeakMap capability rather than a serializable flag:
 * a plain JSON object cannot impersonate a native V375 decision snapshot.
 */
export function assertPurePokerObservationSnapshot(observation) {
  const provenance = PURE_POKER_OBSERVATION_PROVENANCE.get(observation);
  if (!provenance || observation?.skillsEnabled !== false
    || observation?.skillSchemaVersion !== null
    || observation?.tableSize !== provenance.tableSize
    || observation?.round !== provenance.round) {
    throw new RangeError('Observation is not a trusted local pure-poker snapshot');
  }
  return provenance;
}

/**
 * Assert the stronger V375 collector boundary: a local pure-poker snapshot
 * must also originate from an Engine-created instance.  This rejects plain
 * JSON, arbitrary Engine-like fixtures, and snapshots with separately forged
 * legal-action objects before any aggregate profile can be formed.
 */
export function assertNativePurePokerObservationSnapshot(observation) {
  const provenance = assertPurePokerObservationSnapshot(observation);
  if (!NATIVE_PURE_POKER_OBSERVATION_PROVENANCE.has(observation)) {
    throw new RangeError('Observation is not a trusted native Engine pure-poker snapshot');
  }
  return provenance;
}

/**
 * Return the opaque receipt attached only when buildObservation() ran inside
 * Engine's synchronous pure-poker action-dispatch callback.  It contains no
 * cards, seats, identity, seed, or serializable chance data.  V375 consumes
 * it exactly once to prove an actual native decision boundary.
 */
export function nativePurePokerDecisionReceipt(observation) {
  assertNativePurePokerObservationSnapshot(observation);
  const receipt = NATIVE_PURE_POKER_DECISION_RECEIPTS.get(observation);
  if (!receipt || receipt.tableSize !== observation.tableSize
    || receipt.observerIdx !== observation.observerIdx
    || receipt.round !== observation.round
    || receipt.street !== observation.street) {
    throw new RangeError('Observation was not captured at a native pure-poker decision callback');
  }
  return receipt;
}
