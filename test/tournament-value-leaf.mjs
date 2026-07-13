import assert from 'node:assert/strict';
import { getBlinds } from '../js/game/config.js';

import {
  buildTargetedTournamentRootState,
  evaluateTargetedTournamentLeaf,
  normalizedRankUtility,
} from '../training/tournament-value/targeted-leaf.js';

function snapshot({
  tableSize = 6,
  round = 3,
  maxRounds = 12,
  aliveSeats = Array.from({ length: tableSize }, (_, index) => index + 1),
} = {}) {
  const alive = new Set(aliveSeats);
  return {
    round,
    street: 'flop',
    dealerIdx: aliveSeats[0],
    blinds: { ...getBlinds(round) },
    handSeats: [...aliveSeats],
    selfHole: [{ rank: 99, suit: 99 }], // Must never reach model input.
    accountId: 'private-root-metadata',
    tournament: {
      tableSize,
      maxRounds,
      players: Array.from({ length: tableSize }, (_, index) => ({
        idx: index + 1,
        hp: alive.has(index + 1) ? 1_500 - index * 20 : 0,
        alive: alive.has(index + 1),
      })),
    },
  };
}

function terminalState(seatIds, terminalStacks) {
  return {
    terminal: true,
    seatIds: [...seatIds],
    terminalStacks: [...terminalStacks],
    hole: [[{ rank: 98, suit: 98 }]], // Must never reach model input.
    strategyId: 'private-policy-name',
  };
}

assert.equal(normalizedRankUtility(1, 9), 1);
assert.equal(normalizedRankUtility(5, 9), 0);
assert.equal(normalizedRankUtility(9, 9), -1);
assert.equal(normalizedRankUtility(2, 2), -1);

// Pre-hand baseline uses the abstract root stacks before blinds/actions and
// the current hand blind/round-1 boundary, never cards or policy metadata.
const rootBaseline = buildTargetedTournamentRootState(
  snapshot({ round: 4, aliveSeats: [1, 3, 5, 6] }),
  {
    seatIds: [1, 3, 5, 6],
    initialStacks: [1_800, 1_500, 1_200, 900],
    hole: [{ rank: 97, suit: 97 }],
  },
  2,
);
assert.deepEqual(rootBaseline, {
  available: true,
  state: {
    tableSize: 6,
    round: 3,
    maxRounds: 12,
    bigBlind: 40,
    focalStack: 1_200,
    opponentStacks: [1_800, 1_500, 900, 0, 0],
    liveStacksFromButton: [1_800, 1_500, 1_200, 900],
    focalPosition: 2,
  },
});
assert.equal(JSON.stringify(rootBaseline).includes('"rank":97'), false);
assert(Object.isFrozen(rootBaseline.state.opponentStacks));

// Variable 2..9-player continuation states include every original table seat,
// sort opponent stacks and expose only the six public model fields.
for (const tableSize of [2, 6, 9]) {
  const seats = Array.from({ length: tableSize }, (_, index) => index + 1);
  const stacks = seats.map((seat) => 500 + ((seat * 379) % 1_700));
  const result = evaluateTargetedTournamentLeaf(
    snapshot({ tableSize, aliveSeats: seats }),
    terminalState(seats, stacks),
    tableSize - 1,
  );
  assert.equal(result.available, true);
  assert.equal(result.terminal, false);
  assert.deepEqual(Object.keys(result.state).sort(), [
    'bigBlind', 'focalPosition', 'focalStack', 'liveStacksFromButton',
    'maxRounds', 'opponentStacks', 'round', 'tableSize',
  ]);
  assert.equal(result.state.tableSize, tableSize);
  assert.equal(result.state.focalStack, stacks.at(-1));
  assert.deepEqual(
    result.state.opponentStacks,
    stacks.slice(0, -1).sort((left, right) => right - left),
  );
  assert(Object.isFrozen(result) && Object.isFrozen(result.state)
    && Object.isFrozen(result.state.opponentStacks)
    && Object.isFrozen(result.state.liveStacksFromButton));
  const serialized = JSON.stringify(result);
  for (const secret of ['private-root-metadata', 'private-policy-name', '"rank":98', '"rank":99']) {
    assert.equal(serialized.includes(secret), false, `leaf output leaked ${secret}`);
  }
}

// The input is after the current hand, so the blind belongs to round + 1.
for (const [completedRound, expectedBigBlind] of [[3, 40], [6, 80], [9, 160]]) {
  const result = evaluateTargetedTournamentLeaf(
    snapshot({ round: completedRound }),
    terminalState([1, 2, 3, 4, 5, 6], [1_700, 1_600, 1_500, 1_400, 1_300, 1_200]),
    0,
  );
  assert.equal(result.terminal, false);
  assert.equal(result.state.round, completedRound);
  assert.equal(result.state.bigBlind, expectedBigBlind,
    `round ${completedRound + 1} blind level must be used`);
}

// At the scheduled end, live players are ranked by stack; a stable Engine sort
// makes the lower seat win an exact equal-stack tie.
const scheduledEnd = evaluateTargetedTournamentLeaf(
  snapshot({ round: 12 }),
  terminalState([1, 2, 3, 4, 5, 6], [100, 0, 0, 100, 0, 200]),
  3,
);
assert.deepEqual(scheduledEnd, {
  available: true,
  terminal: true,
  rank: 3,
  value: normalizedRankUtility(3, 6),
});

// Seats 2/3 died in earlier hands. Seats 1/5 die together now: seat 5 receives
// the later deathOrder and ranks above seat 1, while both prior deaths follow.
const sparse = snapshot({ aliveSeats: [1, 4, 5, 6], round: 4 });
const sparseTerminal = terminalState([1, 4, 5, 6], [0, 100, 0, 200]);
const lowSeatDeath = evaluateTargetedTournamentLeaf(sparse, sparseTerminal, 0);
const highSeatDeath = evaluateTargetedTournamentLeaf(sparse, sparseTerminal, 2);
assert.equal(lowSeatDeath.rank, 4);
assert.equal(highSeatDeath.rank, 3);
assert.equal(lowSeatDeath.value, normalizedRankUtility(4, 6));
assert.equal(highSeatDeath.value, normalizedRankUtility(3, 6));

// Fewer than two survivors settles all focal placements exactly even before
// the final scheduled hand.
const lastSurvivor = evaluateTargetedTournamentLeaf(
  snapshot({ tableSize: 2, round: 2 }),
  terminalState([1, 2], [0, 3_000]),
  1,
);
assert.deepEqual(lastSurvivor, {
  available: true, terminal: true, rank: 1, value: 1,
});

// Legacy profiles remain safe: integration can retain existing chip-EV.
assert.deepEqual(evaluateTargetedTournamentLeaf({ round: 3 }, {}, 0), {
  available: false, reason: 'missing-tournament-context',
});
assert.deepEqual(evaluateTargetedTournamentLeaf(null, {}, 0), {
  available: false, reason: 'missing-snapshot',
});
assert.deepEqual(evaluateTargetedTournamentLeaf(snapshot(), {
  terminal: true, terminalStacks: [1, 2, 3, 4, 5, 6],
}, 0), {
  available: false, reason: 'missing-seat-map',
});

// Once the new structure is present, inconsistencies are errors rather than a
// silent model/chip-EV fallback that could contaminate training.
assert.throws(() => evaluateTargetedTournamentLeaf(
  { ...snapshot(), tournament: {
    ...snapshot().tournament,
    players: snapshot().tournament.players.map((player, index) => (
      index ? player : { ...player, name: 'identity leak' }
    )),
  } },
  terminalState([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6]),
  0,
), /unknown field: name/);
assert.throws(() => evaluateTargetedTournamentLeaf(
  snapshot(),
  terminalState([1, 2, 3, 4, 5, 6], [1, 2, -1, 4, 5, 6]),
  0,
), /finite non-negative/);
assert.throws(() => evaluateTargetedTournamentLeaf(
  snapshot(),
  { ...terminalState([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6]), terminal: false },
  0,
), /must be terminal/);
assert.throws(() => evaluateTargetedTournamentLeaf(
  snapshot(),
  terminalState([1, 2, 3, 4, 5, 5], [1, 2, 3, 4, 5, 6]),
  0,
), /unique seats/);
assert.throws(() => evaluateTargetedTournamentLeaf(
  snapshot(),
  terminalState([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6]),
  6,
), /zeroBasedPlayer/);
assert.throws(() => normalizedRankUtility(0, 6), /rank/);

console.log('targeted tournament leaf tests passed: exact Engine ranks, public continuation state and legacy fallback');
