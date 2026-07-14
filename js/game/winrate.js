// ============================================================================
// winrate.js - blocker-aware Monte Carlo equity for 2..9 player tables
// ============================================================================

import { remaining } from './deck.js';
import { score7 } from './handeval.js';
import { prepareRangeSampler } from './opponent-range.js';

const MAX_OPPONENTS = 8;

function normalizedSimulationCount(sims) {
  const count = Math.floor(Number(sims));
  return Number.isFinite(count) && count > 0 ? count : 1;
}

function validateCard(card) {
  if (!card || !Number.isInteger(card.rank) || card.rank < 2 || card.rank > 14
    || !Number.isInteger(card.suit) || card.suit < 1 || card.suit > 4) {
    throw new TypeError('cards must use { rank: 2..14, suit: 1..4 }');
  }
  return (card.suit - 1) * 13 + (card.rank - 2);
}

function validateKnownCards(hole, board) {
  if (!Array.isArray(hole) || hole.length !== 2) {
    throw new TypeError('hole must contain exactly two cards');
  }
  if (!Array.isArray(board) || board.length > 5) {
    throw new TypeError('board must contain zero to five cards');
  }
  const ids = [...hole, ...board].map(validateCard);
  if (new Set(ids).size !== ids.length) throw new RangeError('known cards contain duplicates');
}

function randomIndex(rng, length) {
  const value = Number(rng());
  if (!Number.isFinite(value)) throw new TypeError('rng must return a finite number');
  return Math.min(length - 1, Math.floor(Math.max(0, Math.min(1 - Number.EPSILON, value)) * length));
}

function normalizeRunoutConstraints(board, constraints = []) {
  if (!Array.isArray(constraints)) throw new TypeError('runoutConstraints must be an array');
  const bySlot = new Map();
  for (const raw of constraints) {
    const slot = Math.floor(Number(raw?.slot));
    if (!Number.isInteger(slot) || slot < board.length + 1 || slot > 5) continue;
    const constraint = { slot };
    if (raw.card) {
      validateCard(raw.card);
      constraint.card = raw.card;
    } else if (raw.suit != null) {
      const suit = Number(raw.suit);
      if (!Number.isInteger(suit) || suit < 1 || suit > 4) continue;
      constraint.suit = suit;
    } else {
      continue;
    }
    bySlot.set(slot, constraint);
  }
  const exactCards = [...bySlot.values()].filter((item) => item.card).map((item) => item.card);
  return { bySlot, exactCards };
}

function fillRunout(rest, board, constraints, rng) {
  const complete = [...board];
  const available = [...rest];
  for (let slot = board.length + 1; slot <= 5; slot++) {
    const constraint = constraints.bySlot.get(slot);
    if (constraint?.card) {
      complete.push(constraint.card);
      continue;
    }
    const candidateIndexes = [];
    for (let index = 0; index < available.length; index++) {
      if (!constraint?.suit || available[index].suit === constraint.suit) candidateIndexes.push(index);
    }
    if (!candidateIndexes.length) throw new RangeError(`no legal runout card for board slot ${slot}`);
    const candidateIndex = candidateIndexes[randomIndex(rng, candidateIndexes.length)];
    complete.push(available[candidateIndex]);
    available.splice(candidateIndex, 1);
  }
  return complete;
}

function resolveSuitConstraints(constraints, knownCards, rng) {
  const bySlot = new Map([...constraints.bySlot].map(([slot, item]) => [slot, { ...item }]));
  const available = remaining(knownCards);
  for (const [slot, constraint] of bySlot) {
    if (!constraint.suit || constraint.card) continue;
    const candidates = available.filter((card) => card.suit === constraint.suit);
    if (!candidates.length) throw new RangeError(`no card remains for known suit at board slot ${slot}`);
    const card = candidates[randomIndex(rng, candidates.length)];
    bySlot.set(slot, { slot, card });
    const usedIndex = available.findIndex((item) => validateCard(item) === validateCard(card));
    if (usedIndex >= 0) available.splice(usedIndex, 1);
  }
  return {
    bySlot,
    exactCards: [...bySlot.values()].filter((item) => item.card).map((item) => item.card),
  };
}

function scoreShowdown(hole, completeBoard, opponentHoles) {
  const heroScore = score7([...hole, ...completeBoard]);
  const opponentScores = [];
  let bestScore = heroScore;
  let winners = 1;
  let heroBest = true;
  for (const opponentHole of opponentHoles) {
    const score = score7([...opponentHole, ...completeBoard]);
    opponentScores.push(score);
    if (score > bestScore) {
      bestScore = score;
      winners = 1;
      heroBest = false;
    } else if (score === bestScore) {
      winners++;
    }
  }
  if (!heroBest) return { payoff: 0, result: 'loss', heroScore, opponentScores };
  if (winners === 1) return { payoff: 1, result: 'win', heroScore, opponentScores };
  return { payoff: 1 / winners, result: 'tie', heroScore, opponentScores };
}

function createAccumulator() {
  return {
    equitySum: 0,
    squareSum: 0,
    payoutSum: 0,
    allFoldPayoutSum: 0,
    actionableEquitySum: 0,
    opponentEquitySums: [],
    wins: 0,
    ties: 0,
    losses: 0,
  };
}

function heroLayeredPayout(showdown, potModel, eligibleOpponentIds = null) {
  if (!potModel) return 0;
  const heroId = String(potModel.heroId);
  const opponentIds = Array.isArray(potModel.opponentIds) ? potModel.opponentIds : [];
  const eligible = eligibleOpponentIds == null
    ? null
    : new Set(eligibleOpponentIds.map(String));
  const contributions = Object.fromEntries(Object.entries(potModel.contributions || {})
    .map(([id, amount]) => [String(id), Math.max(0, Number(amount) || 0)]));
  const scores = new Map([[heroId, showdown.heroScore]]);
  opponentIds.forEach((id, index) => {
    if (eligible == null || eligible.has(String(id))) {
      scores.set(String(id), showdown.opponentScores[index]);
    }
  });
  const levels = [...new Set(Object.values(contributions).filter((amount) => amount > 0))]
    .sort((a, b) => a - b);
  let previous = 0;
  let payout = 0;
  for (const level of levels) {
    const contributorIds = Object.entries(contributions)
      .filter(([, amount]) => amount >= level)
      .map(([id]) => id);
    const amount = (level - previous) * contributorIds.length;
    previous = level;
    if (contributorIds.length === 1) {
      if (contributorIds[0] === heroId) payout += amount;
      continue;
    }
    const eligible = [...scores.entries()]
      .filter(([id]) => (contributions[id] || 0) >= level);
    if (!eligible.length || !eligible.some(([id]) => id === heroId)) continue;
    const best = Math.max(...eligible.map(([, score]) => score));
    const winners = eligible.filter(([, score]) => score === best);
    if (winners.some(([id]) => id === heroId)) payout += amount / winners.length;
  }
  return payout;
}

function heroSubsetEquity(showdown, potModel) {
  const opponentIds = Array.isArray(potModel?.opponentIds)
    ? potModel.opponentIds.map(String) : [];
  const actionable = Array.isArray(potModel?.actionableOpponentIds)
    ? new Set(potModel.actionableOpponentIds.map(String)) : null;
  if (actionable == null) return showdown.payoff;
  if (actionable.size === 0) return 1;
  let best = showdown.heroScore;
  let winners = 1;
  let heroBest = true;
  opponentIds.forEach((id, index) => {
    if (!actionable.has(id)) return;
    const score = showdown.opponentScores[index];
    if (score > best) {
      best = score;
      winners = 1;
      heroBest = false;
    } else if (score === best) {
      winners++;
    }
  });
  if (!heroBest) return 0;
  return 1 / winners;
}

function accumulate(accumulator, showdown, potModel = null) {
  accumulator.equitySum += showdown.payoff;
  accumulator.squareSum += showdown.payoff * showdown.payoff;
  showdown.opponentScores.forEach((score, index) => {
    const payoff = showdown.heroScore > score ? 1 : showdown.heroScore === score ? 0.5 : 0;
    accumulator.opponentEquitySums[index] = (accumulator.opponentEquitySums[index] || 0) + payoff;
  });
  accumulator.payoutSum += heroLayeredPayout(showdown, potModel);
  if (potModel) {
    const allFoldEligible = Array.isArray(potModel.allFoldEligibleOpponentIds)
      ? potModel.allFoldEligibleOpponentIds : null;
    accumulator.allFoldPayoutSum += heroLayeredPayout(
      showdown,
      potModel,
      allFoldEligible,
    );
    accumulator.actionableEquitySum += heroSubsetEquity(showdown, potModel);
  }
  if (showdown.result === 'win') accumulator.wins++;
  else if (showdown.result === 'tie') accumulator.ties++;
  else accumulator.losses++;
}

function finish(accumulator, samples, potModel = null) {
  const equity = accumulator.equitySum / samples;
  const variance = Math.max(0, accumulator.squareSum / samples - equity * equity);
  return Object.freeze({
    equity,
    winRate: accumulator.wins / samples,
    tieRate: accumulator.ties / samples,
    lossRate: accumulator.losses / samples,
    standardError: Math.sqrt(variance / samples),
    opponentEquities: Object.freeze(accumulator.opponentEquitySums
      .map((sum) => sum / samples)),
    expectedPayout: potModel ? accumulator.payoutSum / samples : null,
    allFoldExpectedPayout: potModel ? accumulator.allFoldPayoutSum / samples : null,
    actionableEquity: potModel ? accumulator.actionableEquitySum / samples : null,
    samples,
  });
}

/**
 * Uniform unknown-card equity. This keeps the original numeric API while adding
 * an injectable RNG for reproducible tests and mirrored-seat evaluation.
 */
export function estimate(hole, board, numOpponents, sims, { rng = Math.random } = {}) {
  validateKnownCards(hole, board);
  const opponents = Math.floor(Number(numOpponents));
  if (!Number.isFinite(opponents) || opponents < 0 || opponents > MAX_OPPONENTS) {
    throw new RangeError(`numOpponents must be 0..${MAX_OPPONENTS}`);
  }
  if (opponents === 0) return 1;
  const samples = normalizedSimulationCount(sims);
  const baseRest = remaining([...hole, ...board]);
  const boardNeed = 5 - board.length;
  const need = opponents * 2 + boardNeed;
  if (need > baseRest.length) throw new RangeError('not enough cards for requested table size');
  const accumulator = createAccumulator();

  for (let sample = 0; sample < samples; sample++) {
    const rest = [...baseRest];
    for (let i = 0; i < need; i++) {
      const j = i + randomIndex(rng, rest.length - i);
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    const completeBoard = boardNeed ? [...board, ...rest.slice(0, boardNeed)] : board;
    const opponentHoles = [];
    let cursor = boardNeed;
    for (let opponent = 0; opponent < opponents; opponent++) {
      opponentHoles.push([rest[cursor], rest[cursor + 1]]);
      cursor += 2;
    }
    accumulate(accumulator, scoreShowdown(hole, completeBoard, opponentHoles));
  }
  return accumulator.equitySum / samples;
}

/**
 * Equity against Bayesian opponent ranges. Opponent cards are sampled jointly,
 * without replacement, so the same physical card can never appear twice even
 * at a full nine-player table.
 */
export function estimateAgainstRanges(
  hole,
  board,
  ranges,
  sims,
  {
    rng = Math.random,
    maxRestarts = 128,
    maxBacktrackNodes = 6000,
    runoutConstraints = [],
    deadRanges = [],
    potModel = null,
  } = {},
) {
  validateKnownCards(hole, board);
  if (!Array.isArray(ranges) || ranges.length > MAX_OPPONENTS) {
    throw new RangeError(`ranges must contain at most ${MAX_OPPONENTS} opponents`);
  }
  if (!Array.isArray(deadRanges) || ranges.length + deadRanges.length > MAX_OPPONENTS) {
    throw new RangeError(`active plus dead ranges must contain at most ${MAX_OPPONENTS} players`);
  }
  const samples = normalizedSimulationCount(sims);
  if (ranges.length === 0) {
    return Object.freeze({
      equity: 1, winRate: 1, tieRate: 0, lossRate: 0, standardError: 0,
      opponentEquities: Object.freeze([]), samples,
    });
  }
  const constraints = normalizeRunoutConstraints(board, runoutConstraints);
  const knownCards = [...hole, ...board, ...constraints.exactCards];
  validateKnownCards(hole, [...board, ...constraints.exactCards]);
  const accumulator = createAccumulator();
  const allRanges = [...ranges, ...deadRanges];
  // Known blockers and posteriors are fixed for this decision. Cache their
  // normalized vectors once instead of rebuilding 1,326 weights per opponent
  // for every Monte Carlo sample.
  const rangeSampler = prepareRangeSampler(allRanges, {
    excludedCards: knownCards,
    maxRestarts,
    maxBacktrackNodes,
  });

  for (let sample = 0; sample < samples; sample++) {
    let sampledHoles = null;
    let resolvedConstraints = null;
    // Jointly condition opponent holes and a privately known future suit.
    // Propose both independently and reject the whole proposal on collision.
    for (let attempt = 0; attempt < 16; attempt++) {
      const proposedHoles = rangeSampler.sample({ rng });
      const proposedRunout = resolveSuitConstraints(constraints, knownCards, rng);
      const holeIds = new Set(proposedHoles.flat().map(validateCard));
      const collides = proposedRunout.exactCards.some((card) => holeIds.has(validateCard(card)));
      if (!collides) {
        sampledHoles = proposedHoles;
        resolvedConstraints = proposedRunout;
        break;
      }
    }
    if (!sampledHoles) {
      // Degenerate injected RNGs may repeat one conflicting proposal forever.
      // Preserve the suit evidence by selecting from cards left by a legal
      // opponent assignment instead of abandoning the entire range estimate.
      sampledHoles = rangeSampler.sample({ rng });
      resolvedConstraints = resolveSuitConstraints(
        constraints,
        [...knownCards, ...sampledHoles.flat()],
        rng,
      );
    }
    const sampleKnownCards = [...hole, ...board, ...resolvedConstraints.exactCards];
    const opponentHoles = sampledHoles.slice(0, ranges.length);
    const rest = remaining([...sampleKnownCards, ...sampledHoles.flat()]);
    const completeBoard = fillRunout(rest, board, resolvedConstraints, rng);
    accumulate(accumulator, scoreShowdown(hole, completeBoard, opponentHoles), potModel);
  }
  return finish(accumulator, samples, potModel);
}

export function estimateRangeEquity(hole, board, ranges, sims, options) {
  return estimateAgainstRanges(hole, board, ranges, sims, options).equity;
}
