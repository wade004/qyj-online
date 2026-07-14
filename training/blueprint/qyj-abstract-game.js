import { createDeck, shuffle } from '../../js/game/deck.js';
import { evalBest } from '../../js/game/handeval.js';
import { buildBlueprintInfoSetKey } from '../../js/game/blueprint-policy.js';
import { ATTACK_TIERS, roundAmount } from '../../js/game/config.js';

const STREETS = Object.freeze(['preflop', 'flop', 'turn', 'river']);
const REVEALED_BY_STREET = Object.freeze([0, 3, 4, 5]);
// Use the live Engine tier identities and ratios so a learned raise:<tier>
// key means exactly the same size at runtime.
const TIER_SPECS = Object.freeze(ATTACK_TIERS.map((tier) => Object.freeze({
  key: tier.key,
  name: tier.name,
  ratio: tier.ratio,
})));

const clockwise = (seat, count, step = 1) => (seat + step) % count;

function publicSeatId(state, zeroBasedSeat) {
  return Array.isArray(state.seatIds)
    ? state.seatIds[zeroBasedSeat] : zeroBasedSeat + 1;
}

function seatsFrom(start, count) {
  return Array.from({ length: count }, (_, offset) => clockwise(start, count, offset));
}

function nextMatching(from, state, predicate) {
  for (let step = 1; step <= state.config.tableSize; step++) {
    const seat = clockwise(from, state.config.tableSize, step);
    if (predicate(seat)) return seat;
  }
  return null;
}

function activeSeats(state) {
  return Array.from({ length: state.config.tableSize }, (_, seat) => seat)
    .filter((seat) => !state.folded[seat]);
}

function actionableSeats(state) {
  return activeSeats(state).filter((seat) => !state.allIn[seat]);
}

function totalPot(state) {
  return state.betRound.reduce((sum, value) => sum + value, 0);
}

function commit(state, seat, requested) {
  const amount = Math.max(0, Math.min(state.hp[seat], Number(requested) || 0));
  state.hp[seat] -= amount;
  state.betStreet[seat] += amount;
  state.betRound[seat] += amount;
  if (state.hp[seat] <= 0) {
    state.hp[seat] = 0;
    state.allIn[seat] = true;
    state.pending[seat] = false;
  }
  return amount;
}

function copyState(state) {
  return {
    ...state,
    seatIds: Array.isArray(state.seatIds) ? [...state.seatIds] : undefined,
    board: state.board.map((card) => ({ ...card })),
    hole: state.hole.map((cards) => cards.map((card) => ({ ...card }))),
    initialStacks: [...state.initialStacks],
    hp: [...state.hp],
    folded: [...state.folded],
    allIn: [...state.allIn],
    betStreet: [...state.betStreet],
    betRound: [...state.betRound],
    acted: [...state.acted],
    lastActionBet: [...state.lastActionBet],
    pending: [...state.pending],
    actionHistory: [...state.actionHistory],
    terminalStacks: state.terminalStacks ? [...state.terminalStacks] : null,
  };
}

function settleUncontested(state, winner) {
  const stacks = [...state.hp];
  stacks[winner] += totalPot(state);
  state.terminal = true;
  state.actingSeat = null;
  state.terminalStacks = stacks;
}

function oddChipOrder(state, winners) {
  const publicCapacity = Number.isInteger(state.publicSeatCapacity)
    ? state.publicSeatCapacity
    : Math.max(
      state.config.tableSize,
      ...(Array.isArray(state.seatIds) ? state.seatIds : []),
    );
  const publicDealer = publicSeatId(state, state.dealer);
  return [...winners].sort((left, right) => {
    const leftDistance = (publicSeatId(state, left) - publicDealer + publicCapacity)
      % publicCapacity || publicCapacity;
    const rightDistance = (publicSeatId(state, right) - publicDealer + publicCapacity)
      % publicCapacity || publicCapacity;
    return leftDistance - rightDistance;
  });
}

function settleShowdown(state) {
  const stacks = [...state.hp];
  const levels = [...new Set(state.betRound.filter((amount) => amount > 0))]
    .sort((a, b) => a - b);
  const score = Object.create(null);
  for (const seat of activeSeats(state)) {
    score[seat] = evalBest([...state.hole[seat], ...state.board]).score;
  }
  let previous = 0;
  for (const level of levels) {
    const contributors = state.betRound
      .map((amount, seat) => ({ amount, seat }))
      .filter((entry) => entry.amount >= level)
      .map((entry) => entry.seat);
    const amount = (level - previous) * contributors.length;
    previous = level;
    if (!(amount > 0)) continue;
    let eligible = contributors.filter((seat) => !state.folded[seat]);
    // A legal betting trajectory should never create a layer funded solely
    // by folded players.  Keep a defensive refund path for malformed custom
    // configurations rather than silently destroying chips.
    if (!eligible.length) eligible = contributors;
    const best = Math.max(...eligible.map((seat) => score[seat] ?? -1));
    let winners = eligible.filter((seat) => (score[seat] ?? -1) === best);
    if (!winners.length) winners = [eligible[0]];
    // Match Engine.showdown exactly: every side-pot layer is divided in whole
    // chips, then its remainder is awarded clockwise from the button.  Use
    // public seat ids/capacity here so a targeted sparse ring (for example
    // seats 1, 4 and 8 of a nine-seat table) keeps the live Engine ordering.
    const share = Math.floor(amount / winners.length);
    const remainder = amount - share * winners.length;
    oddChipOrder(state, winners).forEach((winner, index) => {
      stacks[winner] += share + (index < remainder ? 1 : 0);
    });
  }
  state.terminal = true;
  state.actingSeat = null;
  state.terminalStacks = stacks;
}

function advanceStreet(state) {
  const active = activeSeats(state);
  if (active.length <= 1) {
    settleUncontested(state, active[0]);
    return;
  }
  if (state.streetIndex >= STREETS.length - 1) {
    settleShowdown(state);
    return;
  }
  state.streetIndex++;
  state.street = STREETS[state.streetIndex];
  state.revealed = REVEALED_BY_STREET[state.streetIndex];
  state.betStreet.fill(0);
  state.acted.fill(false);
  state.lastActionBet.fill(0);
  state.currentBet = 0;
  state.minRaiseIncrement = state.config.bb;
  state.raiseCount = 0;
  state.pending = state.pending.map((_, seat) => !state.folded[seat] && !state.allIn[seat]);
  const canAct = actionableSeats(state);
  // Once at most one player can still put chips in, no strategic betting
  // remains. Reveal the sampled runout and settle immediately.
  if (canAct.length <= 1) {
    state.streetIndex = STREETS.length - 1;
    state.street = 'river';
    state.revealed = 5;
    settleShowdown(state);
    return;
  }
  state.actingSeat = nextMatching(state.dealer, state, (seat) => state.pending[seat]);
}

function finishBettingIfReady(state, fromSeat) {
  const active = activeSeats(state);
  if (active.length <= 1) {
    settleUncontested(state, active[0]);
    return;
  }
  const next = nextMatching(fromSeat, state, (seat) => state.pending[seat]
    && !state.folded[seat] && !state.allIn[seat]);
  if (next == null) advanceStreet(state);
  else state.actingSeat = next;
}

function actionSpecs(state) {
  if (state.terminal || state.actingSeat == null) return [];
  const seat = state.actingSeat;
  const rawToCall = Math.max(0, state.currentBet - state.betStreet[seat]);
  const callAmount = Math.min(rawToCall, state.hp[seat]);
  const specs = [];
  if (rawToCall > 0) {
    specs.push({ key: 'fold', type: 'fold', cost: 0, increment: 0 });
    specs.push({ key: 'call', type: 'call', cost: callAmount, increment: 0 });
  } else {
    specs.push({ key: 'check', type: 'check', cost: 0, increment: 0 });
  }

  const raiseRightsOpen = !state.acted[seat]
    || state.currentBet - state.lastActionBet[seat] >= state.minRaiseIncrement;
  // Match Engine.getOptions(): formal raise rights do not disappear merely
  // because every opponent is already all-in. Any unmatched excess is later
  // returned by the same pot-settlement semantics.
  const canRaise = state.raiseCount < state.config.maxRaisesPerStreet
    && state.hp[seat] > rawToCall && raiseRightsOpen;
  if (canRaise) {
    const seenCosts = new Set();
    for (const tier of TIER_SPECS) {
      const pot = Math.max(state.config.bb, totalPot(state));
      let increment = roundAmount(pot * tier.ratio);
      if (increment < state.minRaiseIncrement) increment = roundAmount(state.minRaiseIncrement);
      const cost = rawToCall + increment;
      if (cost >= state.hp[seat] || seenCosts.has(cost)) continue;
      seenCosts.add(cost);
      specs.push({
        key: `raise:${tier.key}`,
        type: 'raise',
        tier,
        cost,
        increment,
      });
    }
    if (state.config.includeAllIn) {
      specs.push({
        key: 'allin', type: 'allin', cost: state.hp[seat],
        increment: Math.max(0, state.betStreet[seat] + state.hp[seat] - state.currentBet),
      });
    }
  }
  return specs;
}

function positionFor(seat, dealer, count) {
  const offset = (seat - dealer + count) % count;
  if (count === 2) return offset === 0 ? 'BTN/SB' : 'BB';
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
  return earlyToLate[count]?.[offset - 3] || `EP+${offset - 3}`;
}

function publicPlayers(state) {
  const highestSeat = Number.isInteger(state.publicSeatCapacity)
    ? state.publicSeatCapacity
    : Array.isArray(state.seatIds) ? Math.max(...state.seatIds) : state.config.tableSize;
  const players = Array(highestSeat + 1).fill(null);
  for (let seat = 0; seat < state.config.tableSize; seat++) {
    const idx = publicSeatId(state, seat);
    players[idx] = {
      idx,
      playerName: null,
      playerId: null,
      isHuman: false,
      hero: null,
      position: positionFor(seat, state.dealer, state.config.tableSize),
      hp: state.hp[seat],
      energy: 0,
      alive: true,
      folded: state.folded[seat],
      allIn: state.allIn[seat],
      betStreet: state.betStreet[seat],
      betRound: state.betRound[seat],
      acted: state.acted[seat],
      lastAction: null,
      skillUsed: false,
      skillModifiers: [],
      publicRevealedCard: null,
      showdown: null,
    };
  }
  return players;
}

/** Build the exact Observation-shaped projection consumed by runtime keys. */
export function abstractObservation(state, actor = state.actingSeat) {
  if (!Number.isInteger(actor) || actor < 0 || actor >= state.config.tableSize) {
    throw new RangeError('abstractObservation requires a valid zero-based actor');
  }
  const specs = actor === state.actingSeat ? actionSpecs(state) : [];
  const raises = specs.filter((spec) => spec.type === 'raise');
  const rawToCall = Math.max(0, state.currentBet - state.betStreet[actor]);
  const players = publicPlayers(state);
  const self = {
    ...players[publicSeatId(state, actor)],
    hole: state.hole[actor].map((card) => ({ ...card })),
  };
  return {
    version: 1,
    observerIdx: publicSeatId(state, actor),
    seatCount: state.config.tableSize,
    maxSupportedSeats: 9,
    round: state.config.round,
    street: state.street,
    dealerIdx: publicSeatId(state, state.dealer),
    actingIdx: state.actingSeat == null ? 0 : publicSeatId(state, state.actingSeat),
    waitingIdx: state.actingSeat == null ? null : publicSeatId(state, state.actingSeat),
    gameOver: state.terminal,
    blinds: { sb: state.config.sb, bb: state.config.bb },
    board: state.board.slice(0, state.revealed).map((card) => ({ ...card })),
    revealed: state.revealed,
    handSeats: Array.from(
      { length: state.config.tableSize }, (_, seat) => publicSeatId(state, seat),
    ),
    activeSeats: activeSeats(state).map((seat) => publicSeatId(state, seat)),
    players,
    self,
    betting: {
      pot: totalPot(state),
      currentBet: state.currentBet,
      minRaiseIncrement: state.minRaiseIncrement,
      streetRaiseCount: state.raiseCount,
    },
    legalActions: {
      toCall: rawToCall,
      canCheck: rawToCall === 0,
      callAmount: Math.min(rawToCall, state.hp[actor]),
      allInAmount: state.hp[actor],
      // Shared rr semantics: ordinary tier rights only. Jam-only and passive
      // short-stack states are represented by lm+jm instead.
      canRaise: raises.length > 0,
      canAllIn: state.hp[actor] <= rawToCall || specs.some((spec) => spec.type === 'allin'),
      tiers: raises.map((spec) => ({
        key: spec.tier.key,
        name: spec.tier.name,
        increment: spec.increment,
        cost: spec.cost,
      })),
    },
    actionHistory: state.actionHistory,
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

function normalizedConfig(options = {}) {
  const tableSize = Number(options.tableSize ?? 2);
  const bb = Number(options.bb ?? 10);
  const sb = Number(options.sb ?? bb / 2);
  const stackBb = Number(options.stackBb ?? 20);
  const maxRaisesPerStreet = Number(options.maxRaisesPerStreet ?? 3);
  const round = Number(options.round ?? 1);
  const utilityMode = String(options.utilityMode ?? 'chip-ev');
  const tournamentRankWeight = Number(options.tournamentRankWeight ?? 0.35);
  if (!Number.isInteger(tableSize) || tableSize < 2 || tableSize > 9) {
    throw new RangeError('QYJ abstract training tableSize must be 2..9');
  }
  if (!(bb > 0) || !(sb > 0) || sb > bb || !(stackBb >= 2)) {
    throw new RangeError('QYJ abstract training requires 0 < sb <= bb and stackBb >= 2');
  }
  if (!Number.isInteger(maxRaisesPerStreet) || maxRaisesPerStreet < 0 || maxRaisesPerStreet > 3) {
    throw new RangeError('maxRaisesPerStreet must be an integer in 0..3');
  }
  if (!Number.isInteger(round) || round < 1 || round > 12) {
    throw new RangeError('QYJ abstract training round must be an integer in 1..12');
  }
  if (!['chip-ev', 'hybrid-tournament', 'phase-aware-tournament'].includes(utilityMode)) {
    throw new RangeError(
      'utilityMode must be chip-ev, hybrid-tournament or phase-aware-tournament',
    );
  }
  if (!Number.isFinite(tournamentRankWeight)
    || tournamentRankWeight < 0 || tournamentRankWeight > 1) {
    throw new RangeError('tournamentRankWeight must be in 0..1');
  }
  return Object.freeze({
    tableSize,
    bb,
    sb,
    stackBb,
    maxRaisesPerStreet,
    round,
    utilityMode,
    tournamentRankWeight,
    includeAllIn: options.includeAllIn !== false,
  });
}

/**
 * Single-hand, no-skill QYJ betting abstraction used to bootstrap a blueprint.
 * It deliberately caps raises and uses only live QYJ tier/all-in sizes. It is
 * not the full 12-hand hero game and its multiplayer output has no equilibrium
 * guarantee.
 */
export class QyjAbstractHoldemGame {
  constructor(options = {}) {
    this.config = normalizedConfig(options);
    this.playerCount = this.config.tableSize;
  }

  createInitialState(rng) {
    if (!rng || typeof rng.next !== 'function' || typeof rng.int !== 'function') {
      throw new TypeError('QyjAbstractHoldemGame requires SerializableRng-like input');
    }
    const deck = shuffle(createDeck(), () => rng.next());
    const hole = Array.from({ length: this.playerCount }, () => [deck.pop(), deck.pop()]);
    const board = Array.from({ length: 5 }, () => deck.pop());
    const dealer = rng.int(this.playerCount);
    const stack = this.config.stackBb * this.config.bb;
    const state = {
      config: this.config,
      dealer,
      board,
      hole,
      initialStacks: Array(this.playerCount).fill(stack),
      hp: Array(this.playerCount).fill(stack),
      folded: Array(this.playerCount).fill(false),
      allIn: Array(this.playerCount).fill(false),
      betStreet: Array(this.playerCount).fill(0),
      betRound: Array(this.playerCount).fill(0),
      acted: Array(this.playerCount).fill(false),
      lastActionBet: Array(this.playerCount).fill(0),
      pending: Array(this.playerCount).fill(true),
      streetIndex: 0,
      street: 'preflop',
      revealed: 0,
      currentBet: 0,
      minRaiseIncrement: this.config.bb,
      raiseCount: 0,
      actingSeat: null,
      terminal: false,
      terminalStacks: null,
      actionHistory: [],
    };
    const smallBlind = this.playerCount === 2 ? dealer : clockwise(dealer, this.playerCount);
    const bigBlind = clockwise(smallBlind, this.playerCount);
    commit(state, smallBlind, this.config.sb);
    commit(state, bigBlind, this.config.bb);
    state.currentBet = Math.max(state.betStreet[smallBlind], state.betStreet[bigBlind]);
    state.pending = state.pending.map((_, seat) => !state.allIn[seat]);
    state.actingSeat = nextMatching(bigBlind, state, (seat) => state.pending[seat]);
    if (state.actingSeat == null) {
      state.streetIndex = 3;
      state.street = 'river';
      state.revealed = 5;
      settleShowdown(state);
    }
    return state;
  }

  isTerminal(state) {
    return state.terminal === true;
  }

  currentPlayer(state) {
    return state.terminal ? null : state.actingSeat;
  }

  legalActions(state) {
    return actionSpecs(state).map((spec) => spec.key);
  }

  nextState(source, actionKey) {
    const state = copyState(source);
    const spec = actionSpecs(state).find((candidate) => candidate.key === String(actionKey));
    if (!spec) throw new RangeError(`Illegal abstract action ${String(actionKey)}`);
    const seat = state.actingSeat;
    const potBefore = totalPot(state);
    const currentBetBefore = state.currentBet;
    const stackBefore = state.hp[seat];
    const betBefore = state.betStreet[seat];
    const toCall = Math.max(0, currentBetBefore - betBefore);
    state.pending[seat] = false;
    let amount = 0;
    let aggressive = false;
    if (spec.type === 'fold') {
      state.folded[seat] = true;
    } else if (spec.type === 'call') {
      amount = commit(state, seat, spec.cost);
    } else if (spec.type === 'raise' || spec.type === 'allin') {
      amount = commit(state, seat, spec.cost);
      if (state.betStreet[seat] > currentBetBefore) {
        const raiseIncrement = state.betStreet[seat] - currentBetBefore;
        const fullRaise = raiseIncrement >= state.minRaiseIncrement;
        state.currentBet = state.betStreet[seat];
        if (fullRaise) state.minRaiseIncrement = raiseIncrement;
        state.raiseCount++;
        aggressive = true;
        state.pending = state.pending.map((_, candidate) => candidate !== seat
          && !state.folded[candidate] && !state.allIn[candidate]
          && state.betStreet[candidate] < state.currentBet);
        if (fullRaise) {
          state.acted = state.acted.map((value, candidate) => (
            candidate === seat || state.folded[candidate] || state.allIn[candidate]
              ? value : false
          ));
        }
      }
    }
    state.acted[seat] = true;
    state.lastActionBet[seat] = state.currentBet;
    const eventKey = spec.type === 'raise' ? spec.tier.key : spec.type;
    const activeBefore = source.folded
      .map((folded, candidate) => ({ folded, candidate }))
      .filter((entry) => !entry.folded)
      .map((entry) => publicSeatId(source, entry.candidate));
    state.actionHistory.push(Object.freeze({
      id: state.actionHistory.length + 1,
      actorIdx: publicSeatId(state, seat),
      round: state.config.round,
      street: source.street,
      type: spec.type,
      key: eventKey,
      amount,
      callAmount: Math.min(toCall, stackBefore),
      raiseIncrement: aggressive ? state.currentBet - currentBetBefore : 0,
      raiseTo: aggressive ? state.currentBet : null,
      potBefore,
      potAfter: totalPot(state),
      currentBetBefore,
      currentBetAfter: state.currentBet,
      actorStackBefore: stackBefore,
      actorStackAfter: state.hp[seat],
      actorBetStreetBefore: betBefore,
      actorBetStreetAfter: state.betStreet[seat],
      dealerIdx: publicSeatId(state, state.dealer),
      position: positionFor(seat, state.dealer, state.config.tableSize),
      playersInHand: activeBefore.length,
      handSize: state.config.tableSize,
      handSeats: seatsFrom(0, state.config.tableSize)
        .map((candidate) => publicSeatId(state, candidate)),
      board: source.board.slice(0, source.revealed).map((card) => ({ ...card })),
      activeSeatsBefore: activeBefore,
      activeSeats: activeSeats(state).map((candidate) => publicSeatId(state, candidate)),
      isAggressive: aggressive,
      forced: false,
    }));
    finishBettingIfReady(state, seat);
    return state;
  }

  utility(state, zeroBasedPlayer) {
    if (!state.terminal || !state.terminalStacks) {
      throw new TypeError('utility() requires a terminal abstract state');
    }
    if (!Number.isInteger(zeroBasedPlayer) || zeroBasedPlayer < 0
      || zeroBasedPlayer >= this.playerCount) {
      throw new RangeError('utility() player is out of range');
    }
    const chipUtility = (state.terminalStacks[zeroBasedPlayer]
      - state.initialStacks[zeroBasedPlayer]) / state.config.bb;
    const utilityMode = state.config.utilityMode ?? this.config.utilityMode ?? 'chip-ev';
    if (utilityMode === 'chip-ev') return chipUtility;
    const playerStack = state.terminalStacks[zeroBasedPlayer];
    const better = state.terminalStacks.filter((stack) => stack > playerStack).length;
    const tied = state.terminalStacks.filter((stack) => stack === playerStack).length;
    const averageRank = better + (tied + 1) / 2;
    const centeredRank = this.playerCount === 1 ? 0
      : (this.playerCount + 1 - 2 * averageRank) / (this.playerCount - 1);
    const rankUtility = centeredRank * state.config.stackBb;
    const configuredWeight = Number(
      state.config.tournamentRankWeight ?? this.config.tournamentRankWeight ?? 0.35,
    );
    const round = Number(state.config.round ?? this.config.round ?? 1);
    const weight = utilityMode === 'phase-aware-tournament'
      ? configuredWeight * (round - 1) / 11
      : configuredWeight;
    return chipUtility * (1 - weight) + rankUtility * weight;
  }

  infoSetKey(state, zeroBasedPlayer) {
    const observation = abstractObservation(state, zeroBasedPlayer);
    return buildBlueprintInfoSetKey(observation, {
      position: observation.self.position,
      opts: observation.legalActions,
      tableSize: this.playerCount,
      maxRaisesPerStreet: state.config.maxRaisesPerStreet,
    });
  }

  /** Defensive invariant helper used by tests and training diagnostics. */
  assertState(state) {
    const vectors = [state.initialStacks, state.hp, state.folded, state.allIn,
      state.betStreet, state.betRound, state.acted, state.lastActionBet, state.pending];
    if (vectors.some((vector) => !Array.isArray(vector) || vector.length !== this.playerCount)) {
      throw new Error('Abstract state vector length mismatch');
    }
    if (state.seatIds != null) {
      if (!Array.isArray(state.seatIds) || state.seatIds.length !== this.playerCount
        || new Set(state.seatIds).size !== this.playerCount
        || state.seatIds.some((seat) => !Number.isInteger(seat) || seat < 1 || seat > 9)) {
        throw new Error('Abstract state seatIds are invalid');
      }
    }
    if (state.publicSeatCapacity != null
      && (!Number.isInteger(state.publicSeatCapacity)
        || state.publicSeatCapacity < Math.max(...(state.seatIds || [this.playerCount]))
        || state.publicSeatCapacity > 9)) {
      throw new Error('Abstract state publicSeatCapacity is invalid');
    }
    const chips = state.terminal
      ? state.terminalStacks.reduce((sum, amount) => sum + amount, 0)
      : state.hp.reduce((sum, amount) => sum + amount, 0) + totalPot(state);
    const initial = state.initialStacks.reduce((sum, amount) => sum + amount, 0);
    if (Math.abs(chips - initial) > 1e-8) throw new Error('Abstract state lost or created chips');
    const seen = new Set([...state.board, ...state.hole.flat()]
      .map((card) => `${card.rank}:${card.suit}`));
    if (seen.size !== 5 + this.playerCount * 2) throw new Error('Abstract deal contains duplicate cards');
    return true;
  }
}
