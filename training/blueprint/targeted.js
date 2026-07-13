import { createDeck, shuffle } from '../../js/game/deck.js';
import { MAX_ROUNDS, getBlinds } from '../../js/game/config.js';
import {
  OpponentRangeModel,
  actionLikelihood,
  normalizeActionEvent,
  prepareRangeSampler,
} from '../../js/game/opponent-range.js';
import {
  BLUEPRINT_ABSTRACTION,
  BLUEPRINT_SCHEMA,
  BLUEPRINT_VERSION,
  buildBlueprintInfoSetKey,
  compileBlueprintCheckpoint,
} from '../../js/game/blueprint-policy.js';
import {
  QyjAbstractHoldemGame,
  abstractObservation,
} from './qyj-abstract-game.js';
import { ExternalSamplingMccfr } from './mccfr.js';
import {
  DEFAULT_TARGETED_TOURNAMENT_VALUE_OPTIONS,
  TargetedTournamentUtility,
} from '../tournament-value/targeted-utility.js';

const STREETS = Object.freeze(['preflop', 'flop', 'turn', 'river']);
const REVEALED_BY_STREET = Object.freeze({ preflop: 0, flop: 3, turn: 4, river: 5 });
const RAISE_TIERS = new Set(['feint', 'strike', 'fierce']);
export const DEFAULT_TARGET_BELIEF_TEMPERATURE = 0.5;

const TARGET_KEYS = new Set(['targetKey', 'actorIdx', 'snapshot']);
const SNAPSHOT_KEYS = new Set([
  'publicSeatCapacity', 'round', 'street', 'dealerIdx', 'blinds', 'board', 'handSeats', 'activeSeats',
  'players', 'rangeStats', 'tournament', 'selfHole', 'betting', 'legalActions', 'actionHistory',
]);
const PLAYER_KEYS = new Set([
  'idx', 'hp', 'folded', 'allIn', 'betStreet', 'betRound', 'acted', 'position',
]);
const RANGE_STATS_KEYS = new Set([
  'idx', 'hands', 'vpip', 'pfr', 'threeBet', 'threeBetCount',
  'threeBetOpportunities', 'af', 'foldToCbet',
]);
const TOURNAMENT_KEYS = new Set(['tableSize', 'maxRounds', 'players']);
const TOURNAMENT_PLAYER_KEYS = new Set(['idx', 'hp', 'alive']);
const BLIND_KEYS = new Set(['sb', 'bb']);
const BETTING_KEYS = new Set([
  'pot', 'currentBet', 'minRaiseIncrement', 'streetRaiseCount',
]);
const LEGAL_KEYS = new Set([
  'toCall', 'canCheck', 'callAmount', 'allInAmount', 'canRaise', 'canAllIn', 'tiers',
]);
const TIER_KEYS = new Set(['key', 'name', 'increment', 'cost']);
const CARD_KEYS = new Set(['rank', 'suit']);
const EVENT_KEYS = new Set([
  'id', 'actorIdx', 'round', 'street', 'type', 'key', 'amount', 'callAmount',
  'raiseIncrement', 'raiseTo', 'potBefore', 'potAfter', 'currentBetBefore',
  'currentBetAfter', 'actorStackBefore', 'actorStackAfter',
  'actorBetStreetBefore', 'actorBetStreetAfter', 'dealerIdx', 'position',
  'playersInHand', 'handSize', 'handSeats', 'board', 'activeSeatsBefore',
  'activeSeats', 'isAggressive', 'forced',
]);
const EVENT_NUMBER_KEYS = new Set([
  'id', 'actorIdx', 'round', 'amount', 'callAmount', 'raiseIncrement', 'raiseTo',
  'potBefore', 'potAfter', 'currentBetBefore', 'currentBetAfter', 'actorStackBefore',
  'actorStackAfter', 'actorBetStreetBefore', 'actorBetStreetAfter', 'dealerIdx',
  'playersInHand', 'handSize',
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
}

function assertAllowedKeys(value, allowed, label) {
  assertRecord(value, label);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new TypeError(`${label} contains unsupported field ${unknown[0]}`);
}

function finiteNumber(value, label, { min = -Infinity, integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || (integer && !Number.isInteger(number))) {
    throw new TypeError(`${label} must be ${integer ? 'an integer' : 'finite'}${min > -Infinity ? ` >= ${min}` : ''}`);
  }
  return number;
}

function booleanValue(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`);
  return value;
}

function stringValue(value, label, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !value) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function closeEnough(left, right) {
  return Math.abs(Number(left) - Number(right)) <= 1e-8;
}

function cloneCard(raw, label) {
  assertAllowedKeys(raw, CARD_KEYS, label);
  const rank = finiteNumber(raw.rank, `${label}.rank`, { integer: true });
  const suit = finiteNumber(raw.suit, `${label}.suit`, { integer: true });
  if (rank < 2 || rank > 14 || suit < 1 || suit > 4) {
    throw new RangeError(`${label} is not a valid card`);
  }
  return { rank, suit };
}

function cardKey(card) {
  return `${card.rank}:${card.suit}`;
}

function cloneCards(raw, label, expectedLength = null) {
  if (!Array.isArray(raw)) throw new TypeError(`${label} must be an array`);
  if (expectedLength != null && raw.length !== expectedLength) {
    throw new RangeError(`${label} must contain exactly ${expectedLength} cards`);
  }
  const cards = raw.map((card, index) => cloneCard(card, `${label}[${index}]`));
  if (new Set(cards.map(cardKey)).size !== cards.length) {
    throw new RangeError(`${label} contains duplicate cards`);
  }
  return cards;
}

function seatList(raw, label, { minLength = 0 } = {}) {
  if (!Array.isArray(raw)) throw new TypeError(`${label} must be an array`);
  const seats = raw.map((seat, index) => finiteNumber(
    seat, `${label}[${index}]`, { integer: true, min: 1 },
  ));
  if (seats.length < minLength || seats.some((seat) => seat > 9)
    || new Set(seats).size !== seats.length) {
    throw new RangeError(`${label} must contain unique seat ids in 1..9`);
  }
  return seats.sort((left, right) => left - right);
}

function clonePlayer(raw, label) {
  assertAllowedKeys(raw, PLAYER_KEYS, label);
  return {
    idx: finiteNumber(raw.idx, `${label}.idx`, { integer: true, min: 1 }),
    hp: finiteNumber(raw.hp, `${label}.hp`, { min: 0 }),
    folded: booleanValue(raw.folded, `${label}.folded`),
    allIn: booleanValue(raw.allIn, `${label}.allIn`),
    betStreet: finiteNumber(raw.betStreet, `${label}.betStreet`, { min: 0 }),
    betRound: finiteNumber(raw.betRound, `${label}.betRound`, { min: 0 }),
    acted: booleanValue(raw.acted, `${label}.acted`),
    position: stringValue(raw.position, `${label}.position`, { nullable: true }),
  };
}

function cloneRangeStats(raw, label) {
  assertAllowedKeys(raw, RANGE_STATS_KEYS, label);
  const stats = {
    idx: finiteNumber(raw.idx, `${label}.idx`, { integer: true, min: 1 }),
    hands: finiteNumber(raw.hands, `${label}.hands`, { integer: true, min: 1 }),
    vpip: finiteNumber(raw.vpip, `${label}.vpip`, { min: 0 }),
    pfr: finiteNumber(raw.pfr, `${label}.pfr`, { min: 0 }),
    threeBet: finiteNumber(raw.threeBet, `${label}.threeBet`, { min: 0 }),
    af: finiteNumber(raw.af, `${label}.af`, { min: 0 }),
    foldToCbet: finiteNumber(raw.foldToCbet, `${label}.foldToCbet`, { min: 0 }),
  };
  if (raw.threeBetCount != null || raw.threeBetOpportunities != null) {
    stats.threeBetCount = finiteNumber(
      raw.threeBetCount ?? 0, `${label}.threeBetCount`, { integer: true, min: 0 },
    );
    stats.threeBetOpportunities = finiteNumber(
      raw.threeBetOpportunities ?? 0,
      `${label}.threeBetOpportunities`, { integer: true, min: 0 },
    );
    if (stats.threeBetCount > stats.threeBetOpportunities
      || stats.threeBetOpportunities > stats.hands) {
      throw new RangeError(`${label} requires threeBetCount <= opportunities <= hands`);
    }
  }
  for (const key of ['vpip', 'pfr', 'threeBet', 'foldToCbet']) {
    if (stats[key] > 1) throw new RangeError(`${label}.${key} must be in 0..1`);
  }
  return stats;
}

function cloneTournament(raw, label, {
  publicSeatCapacity,
  handSeats,
  players,
} = {}) {
  if (raw == null) return null;
  assertAllowedKeys(raw, TOURNAMENT_KEYS, label);
  const tableSize = finiteNumber(raw.tableSize, `${label}.tableSize`, {
    integer: true, min: 2,
  });
  if (tableSize > 9 || tableSize !== publicSeatCapacity) {
    throw new RangeError(`${label}.tableSize must equal publicSeatCapacity in 2..9`);
  }
  const maxRounds = finiteNumber(raw.maxRounds, `${label}.maxRounds`, {
    integer: true, min: 1,
  });
  if (maxRounds !== MAX_ROUNDS) {
    throw new RangeError(`${label}.maxRounds must match the live ${MAX_ROUNDS}-round ruleset`);
  }
  if (!Array.isArray(raw.players) || raw.players.length !== tableSize) {
    throw new RangeError(`${label}.players must cover every table seat`);
  }
  const tournamentPlayers = raw.players.map((player, index) => {
    const playerLabel = `${label}.players[${index}]`;
    assertAllowedKeys(player, TOURNAMENT_PLAYER_KEYS, playerLabel);
    const result = {
      idx: finiteNumber(player.idx, `${playerLabel}.idx`, { integer: true, min: 1 }),
      hp: finiteNumber(player.hp, `${playerLabel}.hp`, { min: 0 }),
      alive: booleanValue(player.alive, `${playerLabel}.alive`),
    };
    if (result.idx > tableSize) throw new RangeError(`${playerLabel}.idx exceeds tableSize`);
    if (!result.alive && result.hp !== 0) {
      throw new RangeError(`${playerLabel} eliminated players must have zero hp`);
    }
    return result;
  }).sort((left, right) => left.idx - right.idx);
  if (new Set(tournamentPlayers.map((player) => player.idx)).size !== tableSize
    || tournamentPlayers.some((player, index) => player.idx !== index + 1)) {
    throw new RangeError(`${label}.players must uniquely cover contiguous seats 1..tableSize`);
  }
  const aliveSeats = tournamentPlayers
    .filter((player) => player.alive)
    .map((player) => player.idx);
  if (aliveSeats.length !== handSeats.length
    || aliveSeats.some((seat, index) => seat !== handSeats[index])) {
    throw new RangeError(`${label} alive seats must exactly match target.snapshot.handSeats`);
  }
  const handPlayerBySeat = new Map(players.map((player) => [player.idx, player]));
  for (const tournamentPlayer of tournamentPlayers) {
    const handPlayer = handPlayerBySeat.get(tournamentPlayer.idx);
    if (handPlayer && !closeEnough(handPlayer.hp, tournamentPlayer.hp)) {
      throw new RangeError(`${label} hp disagrees with target.snapshot.players`);
    }
  }
  return { tableSize, maxRounds, players: tournamentPlayers };
}

function cloneTier(raw, label) {
  assertAllowedKeys(raw, TIER_KEYS, label);
  const key = stringValue(raw.key, `${label}.key`);
  if (!RAISE_TIERS.has(key)) throw new RangeError(`${label}.key is not a live QYJ tier`);
  return {
    key,
    name: raw.name == null ? key : stringValue(raw.name, `${label}.name`),
    increment: finiteNumber(raw.increment, `${label}.increment`, { min: 0 }),
    cost: finiteNumber(raw.cost, `${label}.cost`, { min: 0 }),
  };
}

function cloneLegalActions(raw, label) {
  assertAllowedKeys(raw, LEGAL_KEYS, label);
  if (!Array.isArray(raw.tiers)) throw new TypeError(`${label}.tiers must be an array`);
  const tiers = raw.tiers.map((tier, index) => cloneTier(tier, `${label}.tiers[${index}]`));
  if (new Set(tiers.map((tier) => tier.key)).size !== tiers.length) {
    throw new RangeError(`${label}.tiers contains duplicate keys`);
  }
  return {
    toCall: finiteNumber(raw.toCall, `${label}.toCall`, { min: 0 }),
    canCheck: booleanValue(raw.canCheck, `${label}.canCheck`),
    callAmount: finiteNumber(raw.callAmount, `${label}.callAmount`, { min: 0 }),
    allInAmount: finiteNumber(raw.allInAmount, `${label}.allInAmount`, { min: 0 }),
    canRaise: booleanValue(raw.canRaise, `${label}.canRaise`),
    canAllIn: booleanValue(raw.canAllIn, `${label}.canAllIn`),
    tiers,
  };
}

function optionalEventNumber(value, label) {
  return value == null ? null : finiteNumber(value, label);
}

function cloneActionEvent(raw, label, handSeatSet, currentBoard) {
  assertAllowedKeys(raw, EVENT_KEYS, label);
  const event = Object.create(null);
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (EVENT_NUMBER_KEYS.has(key)) event[key] = optionalEventNumber(value, `${label}.${key}`);
    else if (key === 'street') {
      event.street = stringValue(value, `${label}.street`);
      if (!STREETS.includes(event.street)) throw new RangeError(`${label}.street is invalid`);
    } else if (key === 'type' || key === 'key') {
      event[key] = stringValue(value, `${label}.${key}`);
    } else if (key === 'position') {
      event.position = stringValue(value, `${label}.position`, { nullable: true });
    } else if (key === 'isAggressive' || key === 'forced') {
      event[key] = booleanValue(value, `${label}.${key}`);
    } else if (key === 'handSeats' || key === 'activeSeatsBefore' || key === 'activeSeats') {
      event[key] = seatList(value, `${label}.${key}`);
      if (event[key].some((seat) => !handSeatSet.has(seat))) {
        throw new RangeError(`${label}.${key} references a seat outside the target hand`);
      }
    } else if (key === 'board') {
      event.board = cloneCards(value, `${label}.board`);
      const visible = REVEALED_BY_STREET[event.street ?? raw.street] ?? 0;
      const expected = currentBoard.slice(0, visible);
      if (event.board.length !== expected.length
        || event.board.some((card, index) => cardKey(card) !== cardKey(expected[index]))) {
        throw new RangeError(`${label}.board is not the strict public street prefix`);
      }
    }
  }
  if (!handSeatSet.has(event.actorIdx)) {
    throw new RangeError(`${label}.actorIdx references a seat outside the target hand`);
  }
  return event;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function normalizeSnapshot(raw, actorIdx) {
  assertAllowedKeys(raw, SNAPSHOT_KEYS, 'target.snapshot');
  const round = finiteNumber(raw.round, 'target.snapshot.round', { integer: true, min: 1 });
  if (round > 12) throw new RangeError('target.snapshot.round must be in 1..12');
  const street = stringValue(raw.street, 'target.snapshot.street');
  if (!STREETS.includes(street)) throw new RangeError('target.snapshot.street is invalid');
  const handSeats = seatList(raw.handSeats, 'target.snapshot.handSeats', { minLength: 2 });
  if (handSeats.length > 9) throw new RangeError('target.snapshot supports at most 9 seats');
  const publicSeatCapacity = finiteNumber(
    raw.publicSeatCapacity ?? Math.max(...handSeats),
    'target.snapshot.publicSeatCapacity',
    { integer: true, min: Math.max(...handSeats) },
  );
  if (publicSeatCapacity > 9) {
    throw new RangeError('target.snapshot.publicSeatCapacity must be <= 9');
  }
  const handSeatSet = new Set(handSeats);
  if (!handSeatSet.has(actorIdx)) throw new RangeError('target.actorIdx is not in handSeats');
  const activeSeats = seatList(raw.activeSeats, 'target.snapshot.activeSeats', { minLength: 2 });
  if (activeSeats.some((seat) => !handSeatSet.has(seat))) {
    throw new RangeError('target.snapshot.activeSeats must be a subset of handSeats');
  }
  const dealerIdx = finiteNumber(raw.dealerIdx, 'target.snapshot.dealerIdx', {
    integer: true, min: 1,
  });
  if (!handSeatSet.has(dealerIdx)) throw new RangeError('target.snapshot.dealerIdx is not in handSeats');

  assertAllowedKeys(raw.blinds, BLIND_KEYS, 'target.snapshot.blinds');
  const blinds = {
    sb: finiteNumber(raw.blinds.sb, 'target.snapshot.blinds.sb', { min: 0 }),
    bb: finiteNumber(raw.blinds.bb, 'target.snapshot.blinds.bb', { min: 0 }),
  };
  if (!(blinds.sb > 0) || blinds.sb > blinds.bb) {
    throw new RangeError('target.snapshot.blinds must satisfy 0 < sb <= bb');
  }

  const board = cloneCards(
    raw.board, 'target.snapshot.board', REVEALED_BY_STREET[street],
  );
  const selfHole = cloneCards(raw.selfHole, 'target.snapshot.selfHole', 2);
  const knownCards = [...board, ...selfHole];
  if (new Set(knownCards.map(cardKey)).size !== knownCards.length) {
    throw new RangeError('target snapshot public board and selfHole overlap');
  }

  if (!Array.isArray(raw.players)) throw new TypeError('target.snapshot.players must be an array');
  const players = raw.players.filter((player) => player != null)
    .map((player, index) => clonePlayer(player, `target.snapshot.players[${index}]`))
    .sort((left, right) => left.idx - right.idx);
  const playerIds = new Set(players.map((player) => player.idx));
  if (playerIds.size !== players.length
    || players.some((player) => player.idx > 9)
    || handSeats.some((seat) => !playerIds.has(seat))) {
    throw new RangeError('target.snapshot.players must uniquely cover every hand seat in 1..9');
  }
  const activeSet = new Set(activeSeats);
  for (const player of players) {
    if (handSeatSet.has(player.idx) && player.folded === activeSet.has(player.idx)) {
      throw new RangeError(`target player ${player.idx} folded flag disagrees with activeSeats`);
    }
    if (player.allIn && player.hp !== 0) {
      throw new RangeError(`target player ${player.idx} allIn requires zero hp`);
    }
    if (player.folded && player.allIn) {
      throw new RangeError(`target player ${player.idx} cannot be folded and all-in`);
    }
    if (player.betStreet > player.betRound) {
      throw new RangeError(`target player ${player.idx} betStreet exceeds betRound`);
    }
  }

  if (raw.rangeStats != null && !Array.isArray(raw.rangeStats)) {
    throw new TypeError('target.snapshot.rangeStats must be an array when present');
  }
  const rangeStats = (raw.rangeStats || [])
    .map((stats, index) => cloneRangeStats(stats, `target.snapshot.rangeStats[${index}]`))
    .sort((left, right) => left.idx - right.idx);
  const rangeStatIds = new Set(rangeStats.map((stats) => stats.idx));
  if (rangeStatIds.size !== rangeStats.length
    || rangeStats.some((stats) => !handSeatSet.has(stats.idx) || stats.idx === actorIdx)) {
    throw new RangeError('target.snapshot.rangeStats must uniquely identify opponent hand seats');
  }
  const tournament = cloneTournament(raw.tournament, 'target.snapshot.tournament', {
    publicSeatCapacity,
    handSeats,
    players,
  });
  if (tournament && round > tournament.maxRounds) {
    throw new RangeError('target.snapshot.round exceeds tournament maxRounds');
  }
  if (tournament) {
    const scheduled = getBlinds(round);
    if (!closeEnough(blinds.sb, scheduled.sb) || !closeEnough(blinds.bb, scheduled.bb)) {
      throw new RangeError('target.snapshot.blinds disagree with tournament round schedule');
    }
  }
  const actor = players.find((player) => player.idx === actorIdx);
  if (!actor || actor.folded || actor.allIn || actor.hp <= 0) {
    throw new RangeError('target actor must be active, actionable and have chips');
  }

  assertAllowedKeys(raw.betting, BETTING_KEYS, 'target.snapshot.betting');
  const betting = {
    pot: finiteNumber(raw.betting.pot, 'target.snapshot.betting.pot', { min: 0 }),
    currentBet: finiteNumber(raw.betting.currentBet, 'target.snapshot.betting.currentBet', { min: 0 }),
    minRaiseIncrement: finiteNumber(
      raw.betting.minRaiseIncrement, 'target.snapshot.betting.minRaiseIncrement', { min: 0 },
    ),
    streetRaiseCount: finiteNumber(
      raw.betting.streetRaiseCount, 'target.snapshot.betting.streetRaiseCount', { integer: true, min: 0 },
    ),
  };
  if (!(betting.minRaiseIncrement > 0)) {
    throw new RangeError('target.snapshot.betting.minRaiseIncrement must be positive');
  }
  const contributionPot = players.reduce((sum, player) => sum + player.betRound, 0);
  const maximumStreetBet = Math.max(...players.map((player) => player.betStreet));
  // Engine keeps the nominal big blind as currentBet even when the BB can post
  // only a short all-in. In that one preflop state no player's contribution
  // reaches currentBet, but callers must still complete to the configured BB.
  const nominalShortBigBlind = street === 'preflop'
    && closeEnough(betting.currentBet, blinds.bb)
    && maximumStreetBet < betting.currentBet
    && players.some((player) => (
      player.position === 'BB'
      && player.allIn
      && player.betStreet < blinds.bb
    ));
  if (!closeEnough(betting.pot, contributionPot)
    || (!closeEnough(betting.currentBet, maximumStreetBet) && !nominalShortBigBlind)) {
    throw new RangeError('target betting pot/currentBet disagree with player contributions');
  }

  const legalActions = cloneLegalActions(raw.legalActions, 'target.snapshot.legalActions');
  const expectedToCall = Math.max(0, betting.currentBet - actor.betStreet);
  if (!closeEnough(legalActions.toCall, expectedToCall)
    || !closeEnough(legalActions.callAmount, Math.min(expectedToCall, actor.hp))
    || !closeEnough(legalActions.allInAmount, actor.hp)
    || legalActions.canCheck !== (expectedToCall === 0)) {
    throw new RangeError('target legalActions disagree with the target actor public state');
  }
  if (actor.acted && actor.betStreet >= betting.currentBet) {
    throw new RangeError('target actor is not pending an action');
  }

  if (!Array.isArray(raw.actionHistory)) {
    throw new TypeError('target.snapshot.actionHistory must be an array');
  }
  const actionHistory = raw.actionHistory.map((event, index) => cloneActionEvent(
    event, `target.snapshot.actionHistory[${index}]`, handSeatSet, board,
  ));
  const rootStreetIndex = STREETS.indexOf(street);
  let previousStreetIndex = -1;
  for (const event of actionHistory) {
    const eventStreetIndex = STREETS.indexOf(event.street);
    if (event.round !== round || eventStreetIndex < previousStreetIndex
      || eventStreetIndex > rootStreetIndex) {
      throw new RangeError('target actionHistory must be ordered within the target round and root street');
    }
    previousStreetIndex = eventStreetIndex;
  }

  return deepFreeze({
    publicSeatCapacity,
    round,
    street,
    dealerIdx,
    blinds,
    board,
    handSeats,
    activeSeats,
    players,
    rangeStats,
    tournament,
    selfHole,
    betting,
    legalActions,
    actionHistory,
  });
}

function observationFromSnapshot(snapshot, actorIdx) {
  const highestSeat = snapshot.publicSeatCapacity;
  const players = Array(highestSeat + 1).fill(null);
  for (const player of snapshot.players) {
    players[player.idx] = {
      ...player,
      alive: true,
      energy: 0,
      skillUsed: false,
      skillModifiers: [],
      publicRevealedCard: null,
      showdown: null,
    };
  }
  return {
    version: 1,
    observerIdx: actorIdx,
    seatCount: snapshot.handSeats.length,
    maxSupportedSeats: 9,
    round: snapshot.round,
    street: snapshot.street,
    dealerIdx: snapshot.dealerIdx,
    actingIdx: actorIdx,
    waitingIdx: actorIdx,
    gameOver: false,
    blinds: snapshot.blinds,
    board: snapshot.board,
    revealed: snapshot.board.length,
    handSeats: snapshot.handSeats,
    activeSeats: snapshot.activeSeats,
    players,
    self: { ...players[actorIdx], hole: snapshot.selfHole },
    betting: snapshot.betting,
    legalActions: snapshot.legalActions,
    actionHistory: snapshot.actionHistory,
    knowledge: {
      privateSkillResults: [],
      publicSkillResults: [],
      persistence: {
        privateSkillResults: 'disabled-for-no-skill-training',
        publicSkillResults: 'disabled-for-no-skill-training',
        gap: null,
      },
    },
  };
}

function validateRaiseCap(value) {
  const cap = Number(value ?? 3);
  if (!Number.isInteger(cap) || cap < 0 || cap > 3) {
    throw new RangeError('maxRaisesPerStreet must be an integer in 0..3');
  }
  return cap;
}

export function buildTargetKeyFromSnapshot(rawSnapshot, actorIdx, {
  maxRaisesPerStreet = 3,
} = {}) {
  const actor = finiteNumber(actorIdx, 'target.actorIdx', { integer: true, min: 1 });
  const cap = validateRaiseCap(maxRaisesPerStreet);
  const snapshot = normalizeSnapshot(rawSnapshot, actor);
  const observation = observationFromSnapshot(snapshot, actor);
  return buildBlueprintInfoSetKey(observation, {
    position: observation.self.position,
    opts: observation.legalActions,
    tableSize: snapshot.handSeats.length,
    maxRaisesPerStreet: cap,
  });
}

export function normalizeTargetDefinition(raw, {
  maxRaisesPerStreet = 3,
} = {}) {
  assertAllowedKeys(raw, TARGET_KEYS, 'target');
  const cap = validateRaiseCap(maxRaisesPerStreet);
  const actorIdx = finiteNumber(raw.actorIdx, 'target.actorIdx', { integer: true, min: 1 });
  const targetKey = stringValue(raw.targetKey, 'target.targetKey');
  if (!targetKey.startsWith('bp2|') || targetKey.includes('|bk=')) {
    throw new TypeError('target.targetKey must be an exact bp2 information-set key');
  }
  const snapshot = normalizeSnapshot(raw.snapshot, actorIdx);
  const computed = buildTargetKeyFromSnapshot(snapshot, actorIdx, { maxRaisesPerStreet: cap });
  if (computed !== targetKey) {
    throw new RangeError('target.targetKey does not match the allow-listed snapshot');
  }
  return deepFreeze({ targetKey, actorIdx, snapshot });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableHash(value) {
  const text = String(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeBeliefTemperature(value) {
  const temperature = Number(value ?? DEFAULT_TARGET_BELIEF_TEMPERATURE);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
    throw new RangeError('beliefTemperature must be in 0..1');
  }
  return temperature;
}

function publicHistoryLedger(snapshot) {
  const initialStacks = new Map(snapshot.players.map((player) => [
    player.idx,
    player.hp + player.betRound,
  ]));
  const contributed = new Map(snapshot.handSeats.map((seat) => [seat, 0]));
  const betStreet = new Map(snapshot.handSeats.map((seat) => [seat, 0]));
  let street = 'preflop';
  const contexts = new Map();
  for (const event of snapshot.actionHistory) {
    if (event.street !== street) {
      street = event.street;
      for (const seat of snapshot.handSeats) betStreet.set(seat, 0);
    }
    const actor = event.actorIdx;
    const ledgerStackBefore = Math.max(
      0,
      (initialStacks.get(actor) || 0) - (contributed.get(actor) || 0),
    );
    const ledgerBetStreetBefore = betStreet.get(actor) || 0;
    const actorStackBefore = event.actorStackBefore != null
      && Number(event.actorStackBefore) > 0
      ? Number(event.actorStackBefore) : ledgerStackBefore;
    const actorBetStreetBefore = event.actorBetStreetBefore != null
      ? Number(event.actorBetStreetBefore) : ledgerBetStreetBefore;
    const currentBetBefore = Number(event.currentBetBefore) || 0;
    contexts.set(event, Object.freeze({
      actorStackBefore,
      actorBetStreetBefore,
      toCallBefore: Math.max(0, currentBetBefore - actorBetStreetBefore),
    }));
    const amount = Math.max(0, Number(event.amount) || 0);
    contributed.set(actor, (contributed.get(actor) || 0) + amount);
    betStreet.set(actor, ledgerBetStreetBefore + amount);
  }
  return contexts;
}

function buildPublicBeliefFromSnapshot(snapshot, actorIdx, beliefTemperature) {
  const opponentSeats = snapshot.handSeats
    .filter((seat) => seat !== actorIdx)
    .sort((left, right) => left - right);
  const statsByPlayer = new Map(snapshot.rangeStats.map((stats) => [stats.idx, stats]));
  const model = new OpponentRangeModel(opponentSeats, {
    knownCards: [...snapshot.selfHole, ...snapshot.board],
    statsByPlayer,
    tableSize: snapshot.handSeats.length,
  });
  const ledger = publicHistoryLedger(snapshot);
  const aggressions = new Map();
  let evidenceEvents = 0;
  for (const event of snapshot.actionHistory) {
    const key = `${event.round}:${event.street}`;
    const raisesBefore = aggressions.get(key) || 0;
    const range = model.get(event.actorIdx);
    if (range && event.forced !== true) {
      const publicBoard = snapshot.board.slice(0, REVEALED_BY_STREET[event.street]);
      const ledgerContext = ledger.get(event);
      const normalized = normalizeActionEvent({ ...event, board: publicBoard }, {
        toCallBefore: ledgerContext.toCallBefore,
        betStreetBefore: ledgerContext.actorBetStreetBefore,
        effectiveStack: ledgerContext.actorStackBefore,
        activeCount: event.playersInHand,
        streetRaiseCountBefore: raisesBefore,
      });
      if (beliefTemperature > 0) {
        range.applyLikelihood(
          (combo) => Math.pow(
            actionLikelihood(combo, normalized, {}, range.stats),
            beliefTemperature,
          ),
          {
            floor: 1e-6,
            label: `public-action:${event.round}:${event.street}:${event.id ?? evidenceEvents}`,
          },
        );
      }
      evidenceEvents++;
    }
    if (event.forced !== true && event.isAggressive === true) {
      aggressions.set(key, raisesBefore + 1);
    }
  }
  return Object.freeze({ model, opponentSeats: Object.freeze(opponentSeats), evidenceEvents });
}

/** Public, deterministic calibration hook; it consumes only an allow-listed snapshot. */
export function buildTargetPublicBeliefModel(rawSnapshot, actorIdx, {
  beliefTemperature = DEFAULT_TARGET_BELIEF_TEMPERATURE,
} = {}) {
  const actor = finiteNumber(actorIdx, 'target.actorIdx', { integer: true, min: 1 });
  const snapshot = normalizeSnapshot(rawSnapshot, actor);
  return buildPublicBeliefFromSnapshot(
    snapshot,
    actor,
    normalizeBeliefTemperature(beliefTemperature),
  ).model;
}

function compileTargetBeliefSampler(target, beliefTemperature) {
  const compiled = buildPublicBeliefFromSnapshot(
    target.snapshot,
    target.actorIdx,
    beliefTemperature,
  );
  const sampler = prepareRangeSampler(
    compiled.opponentSeats.map((seat) => compiled.model.get(seat)),
    { excludedCards: [...target.snapshot.selfHole, ...target.snapshot.board] },
  );
  return Object.freeze({
    opponentSeats: compiled.opponentSeats,
    evidenceEvents: compiled.evidenceEvents,
    sample(rng) {
      if (!rng || typeof rng.next !== 'function') {
        throw new TypeError('targeted public beliefs require a SerializableRng-like input');
      }
      const sampled = sampler.sample({ rng: () => rng.next() });
      return new Map(compiled.opponentSeats.map((seat, index) => [seat, sampled[index]]));
    },
  });
}

function shuffledRemainingCards(snapshot, sampledHoles, rng) {
  if (!rng || typeof rng.next !== 'function') {
    throw new TypeError('targeted public subgames require a SerializableRng-like input');
  }
  const blocked = new Set([
    ...snapshot.board,
    ...snapshot.selfHole,
    ...[...sampledHoles.values()].flat(),
  ].map(cardKey));
  return shuffle(createDeck().filter((card) => !blocked.has(cardKey(card))), () => rng.next());
}

/**
 * Sample one complete, privacy-safe deal from an allow-listed targeted root.
 * This is the only bridge used by the real Engine rollout planner: it never
 * accepts an Engine instance and therefore cannot observe true opponent holes
 * or unrevealed board cards.
 */
export function sampleTargetPublicBeliefDeal(rawTarget, rng, {
  beliefTemperature = DEFAULT_TARGET_BELIEF_TEMPERATURE,
  maxRaisesPerStreet = 3,
} = {}) {
  if (!rng || typeof rng.next !== 'function') {
    throw new TypeError('public-belief deal sampling requires a SerializableRng-like input');
  }
  const target = normalizeTargetDefinition(rawTarget, { maxRaisesPerStreet });
  const sampler = compileTargetBeliefSampler(
    target, normalizeBeliefTemperature(beliefTemperature),
  );
  const sampledHoles = sampler.sample(rng);
  const remaining = shuffledRemainingCards(target.snapshot, sampledHoles, rng);
  const holes = target.snapshot.handSeats.map((seat) => Object.freeze({
    seat,
    cards: Object.freeze((seat === target.actorIdx
      ? target.snapshot.selfHole : sampledHoles.get(seat)).map(
      (card) => Object.freeze({ ...card }),
    )),
  }));
  const board = target.snapshot.board.map((card) => ({ ...card }));
  while (board.length < 5) board.push({ ...remaining.pop() });
  return Object.freeze({
    actorIdx: target.actorIdx,
    evidenceEvents: sampler.evidenceEvents,
    holes: Object.freeze(holes),
    board: Object.freeze(board.map((card) => Object.freeze(card))),
  });
}

function hydrateState(target, rng, maxRaisesPerStreet, beliefSampler) {
  const { snapshot, actorIdx, targetKey } = target;
  const seatIds = [...snapshot.handSeats];
  const seatIndex = new Map(seatIds.map((seat, index) => [seat, index]));
  const actor = seatIndex.get(actorIdx);
  const dealer = seatIndex.get(snapshot.dealerIdx);
  const playerBySeat = new Map(snapshot.players.map((player) => [player.idx, player]));
  const orderedPlayers = seatIds.map((seat) => playerBySeat.get(seat));
  const sampledHoles = beliefSampler.sample(rng);
  const remaining = shuffledRemainingCards(snapshot, sampledHoles, rng);
  const hole = Array.from({ length: seatIds.length }, () => null);
  hole[actor] = snapshot.selfHole.map((card) => ({ ...card }));
  for (let seat = 0; seat < seatIds.length; seat++) {
    if (seat === actor) continue;
    const sampled = sampledHoles.get(seatIds[seat]);
    if (!sampled || sampled.length !== 2) {
      throw new Error('public-belief sampler omitted an opponent hand seat');
    }
    hole[seat] = sampled.map((card) => ({ ...card }));
  }
  const board = snapshot.board.map((card) => ({ ...card }));
  while (board.length < 5) board.push(remaining.pop());

  const hp = orderedPlayers.map((player) => player.hp);
  const betStreet = orderedPlayers.map((player) => player.betStreet);
  const betRound = orderedPlayers.map((player) => player.betRound);
  const folded = orderedPlayers.map((player) => player.folded);
  const allIn = orderedPlayers.map((player) => player.allIn);
  const acted = orderedPlayers.map((player) => player.acted);
  const currentBet = snapshot.betting.currentBet;
  const minRaiseIncrement = snapshot.betting.minRaiseIncrement;
  const lastActionBet = orderedPlayers.map((player, seat) => {
    if (!player.acted) return 0;
    if (seat === actor && snapshot.legalActions.canRaise) {
      return Math.max(0, currentBet - minRaiseIncrement);
    }
    return currentBet;
  });
  const pending = orderedPlayers.map((player, seat) => (
    !player.folded && !player.allIn
      && (seat === actor || !player.acted || player.betStreet < currentBet)
  ));
  const initialStacks = orderedPlayers.map((player) => player.hp + player.betRound);
  const largestInitialStack = Math.max(...initialStacks);
  const config = Object.freeze({
    tableSize: seatIds.length,
    bb: snapshot.blinds.bb,
    sb: snapshot.blinds.sb,
    stackBb: Math.max(2, largestInitialStack / snapshot.blinds.bb),
    maxRaisesPerStreet,
    round: snapshot.round,
    includeAllIn: true,
  });
  const state = {
    config,
    seatIds,
    publicSeatCapacity: snapshot.publicSeatCapacity,
    dealer,
    board,
    hole,
    initialStacks,
    hp,
    folded,
    allIn,
    betStreet,
    betRound,
    acted,
    lastActionBet,
    pending,
    streetIndex: STREETS.indexOf(snapshot.street),
    street: snapshot.street,
    revealed: snapshot.board.length,
    currentBet,
    minRaiseIncrement,
    raiseCount: snapshot.betting.streetRaiseCount,
    actingSeat: actor,
    terminal: false,
    terminalStacks: null,
    actionHistory: snapshot.actionHistory.map((event) => Object.freeze({ ...event })),
    targetKey,
    targetActor: actor,
    targetSnapshot: snapshot,
  };
  return state;
}

function targetTrainingPlayers(target) {
  const seats = target.snapshot.handSeats;
  return target.snapshot.players
    .filter((player) => !player.folded && !player.allIn && player.hp > 0)
    .map((player) => seats.indexOf(player.idx))
    .sort((left, right) => left - right);
}

function targetPreflightState(target) {
  const playerBySeat = new Map(target.snapshot.players.map((player) => [player.idx, player]));
  return Object.freeze({
    seatIds: Object.freeze([...target.snapshot.handSeats]),
    initialStacks: Object.freeze(target.snapshot.handSeats.map((seat) => {
      const player = playerBySeat.get(seat);
      return player.hp + player.betRound;
    })),
  });
}

/** A deterministic public-subgame adapter for one exact key and one or more root variants. */
export class QyjTargetedHoldemGame extends QyjAbstractHoldemGame {
  constructor(rawTargets, {
    maxRaisesPerStreet = 3,
    beliefTemperature = DEFAULT_TARGET_BELIEF_TEMPERATURE,
    tournamentValueModel = null,
    tournamentValueMaxUncertainty = DEFAULT_TARGETED_TOURNAMENT_VALUE_OPTIONS.maxUncertainty,
    tournamentValueMaxOodScore = DEFAULT_TARGETED_TOURNAMENT_VALUE_OPTIONS.maxOodScore,
    tournamentValueFallbackShareScale = DEFAULT_TARGETED_TOURNAMENT_VALUE_OPTIONS.fallbackShareScale,
  } = {}) {
    const cap = validateRaiseCap(maxRaisesPerStreet);
    const temperature = normalizeBeliefTemperature(beliefTemperature);
    const list = Array.isArray(rawTargets) ? rawTargets : [rawTargets];
    if (!list.length) throw new RangeError('QyjTargetedHoldemGame requires at least one target');
    const targets = list.map((target) => normalizeTargetDefinition(target, {
      maxRaisesPerStreet: cap,
    })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    const targetKey = targets[0].targetKey;
    const tableSize = targets[0].snapshot.handSeats.length;
    if (targets.some((target) => target.targetKey !== targetKey)) {
      throw new RangeError('one targeted game may contain variants of only one exact key');
    }
    if (targets.some((target) => target.snapshot.handSeats.length !== tableSize)) {
      throw new RangeError('target variants must use one table size');
    }
    const first = targets[0].snapshot;
    super({
      tableSize,
      bb: first.blinds.bb,
      sb: first.blinds.sb,
      stackBb: Math.max(2, Math.max(...first.players.map(
        (player) => player.hp + player.betRound,
      )) / first.blinds.bb),
      maxRaisesPerStreet: cap,
      round: first.round,
    });
    this.targets = Object.freeze(targets);
    this.targetKey = targetKey;
    this.maxRaisesPerStreet = cap;
    this.beliefTemperature = temperature;
    this.beliefSamplers = new Map(targets.map((target) => [
      target,
      compileTargetBeliefSampler(target, temperature),
    ]));
    this.tournamentUtility = tournamentValueModel == null ? null
      : new TargetedTournamentUtility(tournamentValueModel, {
          maxUncertainty: tournamentValueMaxUncertainty,
          maxOodScore: tournamentValueMaxOodScore,
          fallbackShareScale: tournamentValueFallbackShareScale,
        });
    if (this.tournamentUtility) {
      this.tournamentUtility.preflight(targets.map((target) => Object.freeze({
        snapshot: target.snapshot,
        abstractState: targetPreflightState(target),
        // Joint projection needs every still-alive tournament seat, including
        // folded/all-in players who are not root traversers.
        players: Object.freeze(target.snapshot.handSeats.map((_, index) => index)),
      })));
    }
  }

  targetForContext(context = {}) {
    const iteration = Number.isSafeInteger(context.iteration) && context.iteration >= 0
      ? context.iteration : 0;
    return this.targets[iteration % this.targets.length];
  }

  trainingPlayers(context = {}) {
    const target = this.targetForContext(context);
    return targetTrainingPlayers(target);
  }

  createInitialState(rng, context = {}) {
    const target = this.targetForContext(context);
    const state = hydrateState(
      target,
      rng,
      this.maxRaisesPerStreet,
      this.beliefSamplers.get(target),
    );
    this.assertState(state);
    if (this.currentPlayer(state) !== state.targetActor) {
      throw new Error('hydrated targeted root does not act with the target player');
    }
    const hydratedKey = this.infoSetKey(state, state.targetActor);
    if (hydratedKey !== target.targetKey) {
      throw new Error(`hydrated targeted root key mismatch: expected ${target.targetKey}, got ${hydratedKey}`);
    }
    return state;
  }

  utility(state, zeroBasedPlayer) {
    const chipUtility = super.utility(state, zeroBasedPlayer);
    if (!this.tournamentUtility) return chipUtility;
    return this.tournamentUtility.evaluate(
      state.targetSnapshot,
      state,
      zeroBasedPlayer,
      chipUtility,
    );
  }
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

function mergeShardCheckpoint(accumulator, checkpoint, publishedRootKeys) {
  for (const key of [...publishedRootKeys].sort()) {
    const entry = checkpoint.infosets[key];
    const visits = Number(entry?.visits);
    if (!Number.isSafeInteger(visits) || visits <= 0) continue;
    let target = accumulator.get(key);
    if (!target) {
      target = { visits: 0, weighted: new Map(), actionValues: new Map() };
      accumulator.set(key, target);
    }
    target.visits += visits;
    for (const action of Object.keys(entry.strategy || {}).sort()) {
      target.weighted.set(
        action,
        (target.weighted.get(action) || 0) + Number(entry.strategy[action]) * visits,
      );
    }
    for (const action of Object.keys(entry.actionValues || {}).sort()) {
      let moments = target.actionValues.get(action);
      if (!moments) {
        moments = { samples: 0, mean: 0, m2: 0 };
        target.actionValues.set(action, moments);
      }
      mergeMoment(moments, entry.actionValues[action], `actionValues(${key}, ${action})`);
    }
  }
}

function serializeMergedInfosets(accumulator) {
  const infosets = Object.create(null);
  for (const key of [...accumulator.keys()].sort()) {
    const entry = accumulator.get(key);
    const strategy = Object.create(null);
    for (const action of [...entry.weighted.keys()].sort()) {
      strategy[action] = entry.weighted.get(action) / entry.visits;
    }
    const actionValues = Object.create(null);
    for (const action of [...entry.actionValues.keys()].sort()) {
      const moments = entry.actionValues.get(action);
      if (moments.samples > 0) actionValues[action] = { ...moments };
    }
    infosets[key] = {
      strategy,
      visits: entry.visits,
      ...(Object.keys(actionValues).length ? { actionValues } : {}),
    };
  }
  return infosets;
}

/**
 * Train one or more exact target keys. Every group receives exactly
 * `visitsPerTarget` genuine root traverser updates; no support is synthesized.
 */
export function filterTournamentSafeTargets(rawTargets, {
  maxRaisesPerStreet = 3,
  beliefTemperature = DEFAULT_TARGET_BELIEF_TEMPERATURE,
  tournamentValueModel,
  tournamentValueMaxUncertainty = DEFAULT_TARGETED_TOURNAMENT_VALUE_OPTIONS.maxUncertainty,
  tournamentValueMaxOodScore = DEFAULT_TARGETED_TOURNAMENT_VALUE_OPTIONS.maxOodScore,
  tournamentValueFallbackShareScale = DEFAULT_TARGETED_TOURNAMENT_VALUE_OPTIONS.fallbackShareScale,
} = {}) {
  if (tournamentValueModel == null) {
    throw new TypeError('tournamentValueModel is required for tournament root filtering');
  }
  const cap = validateRaiseCap(maxRaisesPerStreet);
  const temperature = normalizeBeliefTemperature(beliefTemperature);
  const list = Array.isArray(rawTargets) ? rawTargets : [rawTargets];
  const normalized = list.map((target, index) => {
    try {
      return normalizeTargetDefinition(target, { maxRaisesPerStreet: cap });
    } catch (cause) {
      throw new Error(`target[${index}] failed public-state validation: ${cause.message}`, {
        cause,
      });
    }
  });
  const groups = new Map();
  for (const target of normalized) {
    const variants = groups.get(target.targetKey) || [];
    variants.push(target);
    groups.set(target.targetKey, variants);
  }
  const acceptedTargets = [];
  const rejected = [];
  for (const targetKey of [...groups.keys()].sort()) {
    const variants = groups.get(targetKey)
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    const game = new QyjTargetedHoldemGame(variants, {
      maxRaisesPerStreet: cap,
      beliefTemperature: temperature,
      tournamentValueModel,
      tournamentValueMaxUncertainty,
      tournamentValueMaxOodScore,
      tournamentValueFallbackShareScale,
    });
    const diagnostics = game.tournamentUtility?.diagnostics();
    if (diagnostics?.enabled) acceptedTargets.push(...variants);
    else rejected.push(Object.freeze({
      targetKey,
      variants: variants.length,
      reason: diagnostics?.disabledReason || 'unknown',
      preflightRoots: diagnostics?.preflightRoots || 0,
      preflightPassed: diagnostics?.preflightPassed || 0,
    }));
  }
  const reasonCounts = {};
  for (const row of rejected) reasonCounts[row.reason] = (reasonCounts[row.reason] || 0) + 1;
  return Object.freeze({
    targets: Object.freeze(acceptedTargets),
    diagnostics: Object.freeze({
      selectedExactKeys: groups.size,
      acceptedExactKeys: new Set(acceptedTargets.map((target) => target.targetKey)).size,
      rejectedExactKeys: rejected.length,
      selectedTargetVariants: normalized.length,
      acceptedTargetVariants: acceptedTargets.length,
      rejectedTargetVariants: rejected.reduce((sum, row) => sum + row.variants, 0),
      rejectionReasons: Object.freeze(reasonCounts),
      rejected: Object.freeze(rejected),
    }),
  });
}

export function trainTargetedBlueprint(rawTargets, {
  visitsPerTarget = 50,
  seed = 'qyj-targeted-blueprint-v1',
  maxRaisesPerStreet = 3,
  blendWeight = 0.25,
  maxDepth = 160,
  beliefTemperature = DEFAULT_TARGET_BELIEF_TEMPERATURE,
  tournamentValueModel = null,
  tournamentValueMaxUncertainty = DEFAULT_TARGETED_TOURNAMENT_VALUE_OPTIONS.maxUncertainty,
  tournamentValueMaxOodScore = DEFAULT_TARGETED_TOURNAMENT_VALUE_OPTIONS.maxOodScore,
  tournamentValueFallbackShareScale = DEFAULT_TARGETED_TOURNAMENT_VALUE_OPTIONS.fallbackShareScale,
  publishSubgameNodes = false,
} = {}) {
  if (!Number.isSafeInteger(visitsPerTarget) || visitsPerTarget < 2) {
    throw new RangeError('visitsPerTarget must be a safe integer >= 2');
  }
  const cap = validateRaiseCap(maxRaisesPerStreet);
  const temperature = normalizeBeliefTemperature(beliefTemperature);
  if (typeof publishSubgameNodes !== 'boolean') {
    throw new TypeError('publishSubgameNodes must be boolean');
  }
  const runtimeWeight = finiteNumber(blendWeight, 'blendWeight');
  if (runtimeWeight < 0 || runtimeWeight > 1) throw new RangeError('blendWeight must be in 0..1');
  const list = Array.isArray(rawTargets) ? rawTargets : [rawTargets];
  if (!list.length) throw new RangeError('trainTargetedBlueprint requires at least one target');
  const normalized = list.map((target, index) => {
    try {
      return normalizeTargetDefinition(target, { maxRaisesPerStreet: cap });
    } catch (cause) {
      throw new Error(`target[${index}] failed public-state validation: ${cause.message}`, {
        cause,
      });
    }
  });
  const groups = new Map();
  for (const target of normalized) {
    const variants = groups.get(target.targetKey) || [];
    variants.push(target);
    groups.set(target.targetKey, variants);
  }

  const gameShards = [...groups.keys()].sort().map((targetKey) => {
    const variants = groups.get(targetKey)
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    const game = new QyjTargetedHoldemGame(variants, {
      maxRaisesPerStreet: cap,
      beliefTemperature: temperature,
      tournamentValueModel,
      tournamentValueMaxUncertainty,
      tournamentValueMaxOodScore,
      tournamentValueFallbackShareScale,
    });
    return Object.freeze({ targetKey, variants, game });
  });
  // One checkpoint must use one terminal-utility scale. If any exact key or
  // public variant cannot safely activate the model, every shard retains the
  // original BB chip-EV objective.
  if (tournamentValueModel != null
    && gameShards.some(({ game }) => !game.tournamentUtility?.enabled)) {
    for (const { game } of gameShards) {
      game.tournamentUtility?.forceDisable('checkpoint-root-gate');
    }
  }

  const accumulator = new Map();
  let utilitySamples = 0;
  const playerCounts = new Set();
  for (const { targetKey, variants, game } of gameShards) {
    playerCounts.add(game.playerCount);
    const shardIdentity = canonicalJson(variants);
    const trainer = new ExternalSamplingMccfr(game, {
      seed: `${String(seed)}|target=${stableHash(shardIdentity)}`,
      maxDepth,
      blendWeight: runtimeWeight,
    });
    trainer.train(visitsPerTarget);
    const shard = trainer.toCheckpoint({
      includeTrainerState: false,
      metadata: { trainingScope: 'targeted-public-subgame-no-skill' },
    });
    const root = shard.infosets[targetKey];
    if (!root || root.visits !== visitsPerTarget) {
      throw new Error('targeted training did not produce the requested real root traverser visits');
    }
    utilitySamples += trainer.utilitySamples;
    // Static targeted publication is deliberately root-only. An ephemeral
    // online solve may retain genuinely traversed downstream nodes so its
    // independent forced-action evaluator follows the same frozen subgame
    // continuation instead of an unrelated uniform fallback. Such a
    // checkpoint remains explicitly non-publishable outside the resolver.
    mergeShardCheckpoint(
      accumulator,
      shard,
      publishSubgameNodes ? Object.keys(shard.infosets) : [targetKey],
    );
  }

  const tournamentUtilityDiagnostics = tournamentValueModel == null ? null : (() => {
    const rows = gameShards.map(({ game }) => game.tournamentUtility.diagnostics());
    const counts = [
      'preflightRoots', 'preflightPassed', 'rawChipFallbacks', 'exactRankValues',
      'modeledValues', 'scaledChipFallbacks', 'jointProjections',
      'monotonicCorrections', 'monotonicityChecks', 'monotonicityFallbacks',
    ];
    return Object.freeze({
      requested: true,
      enabled: rows.length > 0 && rows.every((row) => row.enabled),
      objective: rows.length > 0 && rows.every((row) => row.enabled)
        ? 'normalized-final-rank-continuation-value'
        : 'single-hand-chip-ev',
      allCheckpointRootGate: true,
      maxUncertainty: rows[0]?.maxUncertainty ?? null,
      maxOodScore: rows[0]?.maxOodScore ?? null,
      fallbackShareScale: rows[0]?.fallbackShareScale ?? null,
      disabledReasons: [...new Set(rows.map((row) => row.disabledReason).filter(Boolean))].sort(),
      maxRawSumError: rows.reduce(
        (largest, row) => Math.max(largest, Number(row.maxRawSumError) || 0), 0,
      ),
      maxProjectionAdjustment: rows.reduce(
        (largest, row) => Math.max(largest, Number(row.maxProjectionAdjustment) || 0), 0,
      ),
      ...Object.fromEntries(counts.map((key) => [
        key, rows.reduce((sum, row) => sum + Number(row[key] || 0), 0),
      ])),
    });
  })();

  const checkpoint = {
    schema: BLUEPRINT_SCHEMA,
    version: BLUEPRINT_VERSION,
    metadata: {
      algorithm: 'targeted-public-subgame-external-sampling-mccfr',
      abstraction: BLUEPRINT_ABSTRACTION,
      seed: String(seed),
      iterations: visitsPerTarget * groups.size,
      visitsPerTarget,
      targetCount: groups.size,
      targetVariantCount: normalized.length,
      playerCounts: [...playerCounts].sort((left, right) => left - right),
      maxRaisesPerStreet: cap,
      utilitySamples,
      terminalUtility: tournamentUtilityDiagnostics || {
        requested: false,
        enabled: false,
        objective: 'single-hand-chip-ev',
      },
      rootBelief: {
        model: 'public-action-bayesian-range-v1',
        likelihoodTemperature: temperature,
        jointSampler: 'product-posterior-conditioned-on-physical-card-exclusivity',
        foldedPlayersBlockCards: true,
        futureRunout: 'uniform-after-all-known-and-sampled-hole-card-blockers',
      },
      advantageGuard: {
        enabled: true,
        minSamples: Math.max(2, Math.min(20, visitsPerTarget)),
        confidenceZ: 1.96,
        minLowerBound: 0,
        estimator: 'external-sampling-action-utility-welford-lcb',
      },
      trainingScope: 'exact-public-subgame-no-skill',
      publicationScope: publishSubgameNodes
        ? 'ephemeral-online-subgame-only' : 'static-exact-root-only',
      limitations: [
        'public-action likelihoods are calibrated heuristics rather than a learned counterfactual belief network',
        'profiles without cross-hand rangeStats fall back to population opponent-style priors',
        ...(tournamentUtilityDiagnostics?.enabled ? [
          'public tournament value is a learned continuation approximation with same-scale leaf fallback',
          'the value state omits counterfactual updates to cross-hand opponent-style sufficient statistics',
        ] : [
          'single-hand utility rather than the complete 12-round tournament value',
        ]),
        'multiplayer regret minimisation has no Nash convergence guarantee',
      ],
    },
    blendWeight: runtimeWeight,
    infosets: serializeMergedInfosets(accumulator),
  };
  compileBlueprintCheckpoint(checkpoint);
  for (const targetKey of groups.keys()) {
    if ((checkpoint.infosets[targetKey]?.visits || 0) < visitsPerTarget) {
      throw new Error('merged targeted checkpoint lost real root support');
    }
  }
  return checkpoint;
}

export function trainSingleTargetedBlueprint(target, options = {}) {
  return trainTargetedBlueprint([target], options);
}
