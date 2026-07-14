// Maps a terminal targeted single-hand state to either an exact tournament
// placement or the strict public continuation-value model input.
//
// This module deliberately reads only the sanitized tournament envelope and
// the abstract state's public seat/stack vectors. Cards, action history,
// strategy identity and absolute opponent identities never enter its output.

import { getBlinds } from '../../js/game/config.js';

const PUBLIC_STATE_KEYS = Object.freeze([
  'tableSize',
  'round',
  'maxRounds',
  'bigBlind',
  'focalStack',
  'opponentStacks',
  'liveStacksFromButton',
  'focalPosition',
]);
const TOURNAMENT_KEYS = new Set(['tableSize', 'maxRounds', 'players']);
const TOURNAMENT_PLAYER_KEYS = new Set(['idx', 'hp', 'alive']);

function unavailable(reason) {
  return Object.freeze({ available: false, reason });
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new TypeError(`${label} contains unknown field: ${unknown[0]}`);
  const missing = [...allowed].filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new TypeError(`${label} is missing field: ${missing[0]}`);
}

function integerIn(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function nonNegative(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
  return value;
}

function seatVector(value, tableSize, label, { minimumLength = 1 } = {}) {
  if (!Array.isArray(value) || value.length < minimumLength || value.length > tableSize) {
    throw new RangeError(`${label} must contain ${minimumLength}..${tableSize} seats`);
  }
  const seats = value.map((seat, index) => integerIn(
    seat, 1, tableSize, `${label}[${index}]`,
  ));
  if (new Set(seats).size !== seats.length) {
    throw new RangeError(`${label} must contain unique seats`);
  }
  return seats;
}

function sameSeatSet(left, right) {
  return left.length === right.length
    && left.every((seat) => right.includes(seat));
}

function normalizeTournament(snapshot) {
  const tournament = record(snapshot.tournament, 'snapshot.tournament');
  exactKeys(tournament, TOURNAMENT_KEYS, 'snapshot.tournament');
  const tableSize = integerIn(tournament.tableSize, 2, 9, 'snapshot.tournament.tableSize');
  const maxRounds = integerIn(
    tournament.maxRounds, 1, 100, 'snapshot.tournament.maxRounds',
  );
  const round = integerIn(snapshot.round, 1, maxRounds, 'snapshot.round');
  if (!Array.isArray(tournament.players) || tournament.players.length !== tableSize) {
    throw new RangeError('snapshot.tournament.players must cover every table seat');
  }

  const players = tournament.players.map((rawPlayer, index) => {
    const player = record(rawPlayer, `snapshot.tournament.players[${index}]`);
    exactKeys(player, TOURNAMENT_PLAYER_KEYS, `snapshot.tournament.players[${index}]`);
    const normalized = Object.freeze({
      idx: integerIn(player.idx, 1, tableSize, `snapshot.tournament.players[${index}].idx`),
      hp: nonNegative(player.hp, `snapshot.tournament.players[${index}].hp`),
      alive: player.alive,
    });
    if (typeof normalized.alive !== 'boolean') {
      throw new TypeError(`snapshot.tournament.players[${index}].alive must be boolean`);
    }
    if (!normalized.alive && normalized.hp !== 0) {
      throw new RangeError('eliminated tournament players must have zero hp');
    }
    return normalized;
  }).sort((left, right) => left.idx - right.idx);
  if (new Set(players.map((player) => player.idx)).size !== tableSize
    || players.some((player, index) => player.idx !== index + 1)) {
    throw new RangeError('snapshot.tournament.players must uniquely cover seats 1..tableSize');
  }

  const handSeats = seatVector(snapshot.handSeats, tableSize, 'snapshot.handSeats', {
    minimumLength: 2,
  });
  const aliveSeats = players.filter((player) => player.alive).map((player) => player.idx);
  if (!sameSeatSet(handSeats, aliveSeats)) {
    throw new RangeError('snapshot.handSeats must exactly match alive tournament seats');
  }
  return Object.freeze({ tableSize, maxRounds, round, players, handSeats });
}

function normalizeTerminalState(abstractState, tournament, zeroBasedPlayer) {
  const state = record(abstractState, 'abstractState');
  if (state.terminal !== true) {
    throw new TypeError('abstractState must be terminal');
  }
  if (!Array.isArray(state.seatIds)) return unavailable('missing-seat-map');
  const seatIds = seatVector(state.seatIds, tournament.tableSize, 'abstractState.seatIds');
  if (!sameSeatSet(seatIds, tournament.handSeats)) {
    throw new RangeError('abstractState.seatIds must exactly match snapshot.handSeats');
  }
  integerIn(zeroBasedPlayer, 0, seatIds.length - 1, 'zeroBasedPlayer');
  if (!Array.isArray(state.terminalStacks)
    || state.terminalStacks.length !== seatIds.length) {
    throw new RangeError('abstractState.terminalStacks must align with seatIds');
  }
  const terminalStacks = state.terminalStacks.map((stack, index) => (
    nonNegative(stack, `abstractState.terminalStacks[${index}]`)
  ));
  if (!(terminalStacks.reduce((sum, stack) => sum + stack, 0) > 0)) {
    throw new RangeError('abstractState.terminalStacks must retain positive tournament chips');
  }
  return Object.freeze({
    seatIds,
    terminalStacks,
    focalSeat: seatIds[zeroBasedPlayer],
  });
}

/** +1 for first place, -1 for last, evenly spaced and zero-sum over ranks. */
export function normalizedRankUtility(rank, tableSize) {
  const size = integerIn(tableSize, 2, 9, 'tableSize');
  const placement = integerIn(rank, 1, size, 'rank');
  return 1 - (2 * (placement - 1)) / (size - 1);
}

function postHandPlayers(tournament, terminal) {
  const stackBySeat = new Map(terminal.seatIds.map((seat, index) => (
    [seat, terminal.terminalStacks[index]]
  )));
  return tournament.players.map((player) => Object.freeze({
    idx: player.idx,
    wasAlive: player.alive,
    stack: player.alive ? stackBySeat.get(player.idx) : 0,
  }));
}

function exactRank(postPlayers, focalSeat) {
  // Engine.doGameOver starts from ascending seats and uses a stable sort for
  // equal live stacks, so the lower public seat wins an exact stack tie.
  const survivors = postPlayers.filter((player) => player.stack > 0)
    .sort((left, right) => (right.stack - left.stack) || (left.idx - right.idx));
  const liveIndex = survivors.findIndex((player) => player.idx === focalSeat);
  if (liveIndex >= 0) return liveIndex + 1;

  // Engine.endRound assigns increasing deathOrder while scanning low-to-high
  // seats. doGameOver then sorts deathOrder descending: among players newly
  // eliminated in this hand, the higher seat ranks first. Every previous
  // elimination has an older deathOrder and therefore follows the whole group.
  const newlyEliminated = postPlayers.filter((player) => player.wasAlive && player.stack === 0)
    .sort((left, right) => right.idx - left.idx);
  const deathIndex = newlyEliminated.findIndex((player) => player.idx === focalSeat);
  if (deathIndex < 0) throw new Error('focal seat is absent from the post-hand ranking');
  return survivors.length + deathIndex + 1;
}

function clockwiseLivePlayers(players, buttonSeat, tableSize) {
  const bySeat = new Map(players.filter((player) => player.stack > 0)
    .map((player) => [player.idx, player]));
  const ordered = [];
  for (let step = 0; step < tableSize; step++) {
    const seat = ((buttonSeat - 1 + step) % tableSize) + 1;
    const player = bySeat.get(seat);
    if (player) ordered.push(player);
  }
  return ordered;
}

function nextLiveButton(players, dealerIdx, tableSize) {
  const live = new Set(players.filter((player) => player.stack > 0)
    .map((player) => player.idx));
  for (let step = 1; step <= tableSize; step++) {
    const seat = ((dealerIdx - 1 + step) % tableSize) + 1;
    if (live.has(seat)) return seat;
  }
  throw new RangeError('post-hand tournament has no live next button');
}

function continuationState(tournament, postPlayers, focalSeat, dealerIdx) {
  const focal = postPlayers.find((player) => player.idx === focalSeat);
  const opponentStacks = postPlayers.filter((player) => player.idx !== focalSeat)
    .map((player) => player.stack)
    .sort((left, right) => right - left);
  const nextBlindRound = Math.min(tournament.round + 1, tournament.maxRounds);
  const button = nextLiveButton(postPlayers, dealerIdx, tournament.tableSize);
  const liveRing = clockwiseLivePlayers(postPlayers, button, tournament.tableSize);
  const focalPosition = liveRing.findIndex((player) => player.idx === focalSeat);
  if (focalPosition < 0) throw new RangeError('focal survivor is missing from next-button ring');
  const state = {
    tableSize: tournament.tableSize,
    round: tournament.round,
    maxRounds: tournament.maxRounds,
    bigBlind: Number(getBlinds(nextBlindRound).bb),
    focalStack: focal.stack,
    opponentStacks: Object.freeze(opponentStacks),
    liveStacksFromButton: Object.freeze(liveRing.map((player) => player.stack)),
    focalPosition,
  };
  if (Object.keys(state).some((key) => !PUBLIC_STATE_KEYS.includes(key))) {
    throw new Error('internal public tournament-state schema violation');
  }
  return Object.freeze(state);
}

/**
 * Build the public pre-hand baseline paired with a targeted leaf.  Abstract
 * `initialStacks` already reconstruct each live player's stack before this
 * hand's forced bets/actions, so the result aligns with collector start(r).
 */
export function buildTargetedTournamentRootState(
  snapshot,
  abstractState,
  zeroBasedPlayer,
) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return unavailable('missing-snapshot');
  }
  if (!snapshot.tournament) return unavailable('missing-tournament-context');
  const tournament = normalizeTournament(snapshot);
  const state = record(abstractState, 'abstractState');
  if (!Array.isArray(state.seatIds)) return unavailable('missing-seat-map');
  const seatIds = seatVector(state.seatIds, tournament.tableSize, 'abstractState.seatIds');
  if (!sameSeatSet(seatIds, tournament.handSeats)) {
    throw new RangeError('abstractState.seatIds must exactly match snapshot.handSeats');
  }
  integerIn(zeroBasedPlayer, 0, seatIds.length - 1, 'zeroBasedPlayer');
  if (!Array.isArray(state.initialStacks) || state.initialStacks.length !== seatIds.length) {
    throw new RangeError('abstractState.initialStacks must align with seatIds');
  }
  const initialStacks = state.initialStacks.map((stack, index) => (
    nonNegative(stack, `abstractState.initialStacks[${index}]`)
  ));
  if (initialStacks.some((stack) => !(stack > 0))) {
    throw new RangeError('abstractState.initialStacks must be positive for live hand seats');
  }
  const stackBySeat = new Map(seatIds.map((seat, index) => [seat, initialStacks[index]]));
  const focalSeat = seatIds[zeroBasedPlayer];
  const allPlayers = tournament.players.map((player) => ({
    idx: player.idx,
    stack: player.alive ? stackBySeat.get(player.idx) : 0,
  }));
  if (allPlayers.some((player) => !Number.isFinite(player.stack))) {
    throw new RangeError('abstractState.initialStacks omitted a live tournament seat');
  }
  const bigBlind = nonNegative(snapshot.blinds?.bb, 'snapshot.blinds.bb');
  if (!(bigBlind > 0)) throw new RangeError('snapshot.blinds.bb must be positive');
  const focal = allPlayers.find((player) => player.idx === focalSeat);
  const dealerIdx = integerIn(
    snapshot.dealerIdx,
    1,
    tournament.tableSize,
    'snapshot.dealerIdx',
  );
  const liveRing = clockwiseLivePlayers(allPlayers, dealerIdx, tournament.tableSize);
  const focalPosition = liveRing.findIndex((player) => player.idx === focalSeat);
  if (focalPosition < 0) throw new RangeError('focal player is missing from current-button ring');
  return Object.freeze({
    available: true,
    state: Object.freeze({
      tableSize: tournament.tableSize,
      round: tournament.round - 1,
      maxRounds: tournament.maxRounds,
      bigBlind,
      focalStack: focal.stack,
      opponentStacks: Object.freeze(allPlayers
        .filter((player) => player.idx !== focalSeat)
        .map((player) => player.stack)
        .sort((left, right) => right - left)),
      liveStacksFromButton: Object.freeze(liveRing.map((player) => player.stack)),
      focalPosition,
    }),
  });
}

/**
 * Evaluate a terminal single-hand state in its sanitized tournament context.
 *
 * The result is a frozen discriminated union:
 * - `{ available:false, reason }` for legacy roots without the required public
 *   tournament envelope/seat map (the caller must keep chip-EV fallback).
 * - `{ available:true, terminal:true, rank, value }` when placement is exact.
 * - `{ available:true, terminal:false, state }` for continuation-model input.
 */
export function evaluateTargetedTournamentLeaf(snapshot, abstractState, zeroBasedPlayer) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return unavailable('missing-snapshot');
  }
  if (!snapshot.tournament) return unavailable('missing-tournament-context');
  const tournament = normalizeTournament(snapshot);
  const terminal = normalizeTerminalState(abstractState, tournament, zeroBasedPlayer);
  if (terminal.available === false) return terminal;
  const players = postHandPlayers(tournament, terminal);
  const focal = players.find((player) => player.idx === terminal.focalSeat);
  const survivorCount = players.filter((player) => player.stack > 0).length;
  const placementIsExact = focal.stack === 0
    || tournament.round >= tournament.maxRounds
    || survivorCount < 2;

  if (placementIsExact) {
    const rank = exactRank(players, terminal.focalSeat);
    return Object.freeze({
      available: true,
      terminal: true,
      rank,
      value: normalizedRankUtility(rank, tournament.tableSize),
    });
  }
  return Object.freeze({
    available: true,
    terminal: false,
    state: continuationState(
      tournament,
      players,
      terminal.focalSeat,
      integerIn(snapshot.dealerIdx, 1, tournament.tableSize, 'snapshot.dealerIdx'),
    ),
  });
}
