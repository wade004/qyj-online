// ============================================================================
// ai.js - QYZ belief/range driven bot runtime (2..9 seats)
//
// Engine access is confined to the adapter at the bottom of this file. The
// strategy itself receives an immutable, allow-listed information set only.
// ============================================================================

import * as Config from './config.js';
import * as WinRate from './winrate.js';
import { describe } from './handeval.js';
import { buildObservation } from './observation.js';
import {
  OpponentRangeModel,
  comboFeatures,
  normalizeOpponentStats,
  preflopComboStrength,
} from './opponent-range.js';
import {
  clamp,
  drawProfile,
  normalizePolicyOptions,
  postflopPolicy,
  preflopPercentile,
  preflopPolicy,
  preflopStrength as policyPreflopStrength,
  tablePosition,
  tournamentRiskAdjustment,
  QYJ_BASE_POLICY_CONTRACT,
} from './ai-policy.js';
import {
  blendBlueprintPolicy,
  compileBlueprintCheckpoint,
  getBlueprintPolicyDiagnostics,
  loadBlueprintCheckpoint as loadStaticBlueprintCheckpoint,
} from './blueprint-policy.js';

const ENGINE_STATES = new WeakMap();
const COMPILED_BLUEPRINTS = new WeakMap();
const MAX_RUNTIME_BLUEPRINT_WEIGHT = 0.35;
let activeBlueprintCheckpoint = null;
let blueprintLoadGeneration = 0;

function checkpointIterations(checkpoint) {
  const iterations = Number(checkpoint?.metadata?.iterations);
  return Number.isFinite(iterations) && iterations >= 0 ? iterations : null;
}

function asCompiledBlueprint(checkpoint) {
  if (checkpoint == null) return null;
  if (typeof checkpoint !== 'object') return compileBlueprintCheckpoint(checkpoint);
  let compiled = COMPILED_BLUEPRINTS.get(checkpoint);
  if (!compiled) {
    compiled = compileBlueprintCheckpoint(checkpoint);
    COMPILED_BLUEPRINTS.set(checkpoint, compiled);
    COMPILED_BLUEPRINTS.set(compiled, compiled);
  }
  return compiled;
}

/** Install a parsed or already-compiled checkpoint. Passing null disables it. */
export function installBlueprintCheckpoint(checkpoint) {
  blueprintLoadGeneration++;
  activeBlueprintCheckpoint = checkpoint == null
    ? null : asCompiledBlueprint(checkpoint);
  return getBlueprintStatus();
}

/** Disable the blueprint without touching any Engine/range-model state. */
export function clearBlueprintCheckpoint() {
  blueprintLoadGeneration++;
  activeBlueprintCheckpoint = null;
  return getBlueprintStatus();
}

/**
 * Fetch/compile/install transactionally. A failed request rejects and leaves
 * the previously installed checkpoint intact; callers may catch and keep the
 * default range/EV policy running.
 */
export async function loadBlueprintCheckpoint(source, options = {}) {
  const generation = ++blueprintLoadGeneration;
  const checkpoint = await loadStaticBlueprintCheckpoint(source, options);
  if (generation !== blueprintLoadGeneration) return getBlueprintStatus();
  activeBlueprintCheckpoint = checkpoint == null ? null : asCompiledBlueprint(checkpoint);
  return getBlueprintStatus();
}

/** Safe status for UI/telemetry; never includes information-set keys. */
export function getBlueprintStatus() {
  const checkpoint = activeBlueprintCheckpoint;
  if (!checkpoint) {
    return Object.freeze({
      installed: false,
      schema: null,
      weight: 0,
      iterations: null,
      size: 0,
    });
  }
  return Object.freeze({
    installed: true,
    schema: checkpoint.schema,
    weight: Math.min(
      MAX_RUNTIME_BLUEPRINT_WEIGHT,
      Math.max(0, Number(checkpoint.blendWeight) || 0),
    ),
    iterations: checkpointIterations(checkpoint),
    size: checkpoint.size,
  });
}

function styleOf(player) {
  return player?.style || Config.AI_STYLES.find((style) => style.key === 'tag') || {
    looseness: 0,
    aggression: 0,
    bluffFactor: 1,
  };
}

export function preflopStrength(hole) {
  return policyPreflopStrength(hole);
}

export { drawProfile };

/** Compatibility helper retained for Advisor and existing UI code. */
export function positionAdjustment(engine, player) {
  const seats = engine.players.slice(1).filter((candidate) => candidate?.alive)
    .map((candidate) => candidate.idx);
  const position = tablePosition(player.idx, engine.dealerIdx, seats).name;
  return {
    'BTN/SB': 0.08,
    BTN: 0.08,
    CO: 0.045,
    HJ: -0.005,
    SB: 0.02,
    BB: 0,
    MP: -0.025,
    LJ: -0.035,
    'UTG+1': -0.045,
    UTG: -0.05,
  }[position] ?? 0;
}

export function effectiveStack(engine, player) {
  const opponents = engine.activePlayers().filter((candidate) => candidate.idx !== player.idx);
  const largestOpponent = Math.max(0, ...opponents.map(
    (candidate) => candidate.hp + candidate.betStreet,
  ));
  return Math.min(
    player.hp + player.betStreet,
    largestOpponent || player.hp + player.betStreet,
  );
}

function newProfile() {
  return {
    rounds: new Set(),
    vpipRounds: new Set(),
    pfrRounds: new Set(),
    threeBetRounds: new Set(),
    threeBetOpportunityRounds: new Set(),
    postflopAggressive: 0,
    postflopCalls: 0,
    facedPostflopBet: 0,
    foldedToPostflopBet: 0,
  };
}

function getProfile(state, seat) {
  if (!state.profiles.has(seat)) state.profiles.set(seat, newProfile());
  return state.profiles.get(seat);
}

function profileStats(
  profile, priorHands = 60, evidenceWeighted = false, threeBetEvidenceWeighted = false,
) {
  const hands = Math.max(1, profile.rounds.size);
  const faced = profile.facedPostflopBet;
  const threeBetOpportunities = profile.threeBetOpportunityRounds.size;
  return {
    hands,
    priorHands,
    evidenceWeighted,
    threeBetEvidenceWeighted,
    vpip: profile.vpipRounds.size / hands,
    pfr: profile.pfrRounds.size / hands,
    threeBet: profile.threeBetRounds.size / hands,
    threeBetCount: profile.threeBetRounds.size,
    threeBetOpportunities,
    af: profile.postflopAggressive / Math.max(1, profile.postflopCalls),
    foldToCbet: faced ? profile.foldedToPostflopBet / faced : 0.45,
    facedPostflopBet: faced,
    postflopActions: profile.postflopAggressive + profile.postflopCalls,
  };
}

function updateProfiles(state, observation) {
  for (const seat of observation.handSeats) {
    if (seat !== observation.observerIdx) getProfile(state, seat).rounds.add(observation.round);
  }
  const events = observation.actionHistory
    .filter((event) => event.id > state.lastProfileActionId)
    .sort((a, b) => a.id - b.id);
  for (const event of events) {
    state.lastProfileActionId = Math.max(state.lastProfileActionId, event.id);
    if (event.forced) continue;
    const key = `${event.round}:${event.street}`;
    const aggressiveBefore = state.publicAggressions.get(key) || 0;
    if (event.actorIdx !== observation.observerIdx) {
      const profile = getProfile(state, event.actorIdx);
      profile.rounds.add(event.round);
      if (event.street === 'preflop') {
        if (aggressiveBefore > 0) profile.threeBetOpportunityRounds.add(event.round);
        if (event.isAggressive || event.type === 'call' || event.key === 'call') {
          profile.vpipRounds.add(event.round);
        }
        if (event.isAggressive) {
          profile.pfrRounds.add(event.round);
          if (aggressiveBefore > 0) profile.threeBetRounds.add(event.round);
        }
      } else {
        if (event.callAmount > 0) {
          profile.facedPostflopBet++;
          if (event.type === 'fold' || event.key === 'fold') profile.foldedToPostflopBet++;
        }
        if (event.isAggressive) profile.postflopAggressive++;
        if (event.type === 'call' || event.key === 'call') profile.postflopCalls++;
      }
    }
    if (event.isAggressive) state.publicAggressions.set(key, aggressiveBefore + 1);
  }
}

function stateFor(engine, observerIdx) {
  let bySeat = ENGINE_STATES.get(engine);
  if (!bySeat) {
    bySeat = new Map();
    ENGINE_STATES.set(engine, bySeat);
  }
  if (!bySeat.has(observerIdx)) {
    bySeat.set(observerIdx, {
      profiles: new Map(),
      publicAggressions: new Map(),
      lastProfileActionId: 0,
      modelRound: null,
      model: null,
      processedRangeActionId: 0,
      processedKnowledgeIds: new Set(),
      rangeAggressions: new Map(),
      decisionCounter: 0,
      skillDecisionCounter: 0,
      opponentPriorHands: 60,
      opponentEvidenceWeighted: false,
      opponentThreeBetOpportunityWeighted: false,
      heterogeneousFoldModel: false,
      continuousTournamentRisk: false,
      tournamentRiskScope: 'all',
      consistentPreflopEv: false,
      callerAdjustedPreflopEv: false,
      callerProjectionWeight: 1,
      directCallerPreflopEv: false,
      tournamentValueModel: null,
      tournamentValueMaxUncertainty: 0.75,
      tournamentValueMaxOodScore: 1,
      disableTournamentRisk: false,
      equitySimulationScale: 1,
      equitySimulationFloor: Config.AI_SIMS,
      modelErrors: [],
      lastDiagnostics: null,
    });
  }
  return bySeat.get(observerIdx);
}

function currentRunoutConstraints(observation) {
  const bySlot = new Map();
  for (const entry of observation.knowledge.privateSkillResults) {
    if (entry.round !== observation.round) continue;
    const result = entry.result || {};
    const fallbackSlot = observation.board.length + 1;
    const slot = Number(result.slot) || fallbackSlot;
    if (slot <= observation.board.length || slot > 5) continue;
    if (result.kind === 'peek_board' && result.card) {
      bySlot.set(slot, { slot, card: result.card });
    } else if (result.kind === 'peek_board_suit' && result.suit) {
      bySlot.set(slot, { slot, suit: result.suit });
    }
  }
  return [...bySlot.values()].sort((a, b) => a.slot - b.slot);
}

function rangePlayerIds(observation) {
  return observation.handSeats.filter((seat) => seat !== observation.observerIdx
    && observation.players[seat]);
}

function resetRangeModel(state, observation, runoutConstraints) {
  const playerIds = rangePlayerIds(observation);
  const tableSize = Math.min(9, Math.max(2, playerIds.length + 1));
  const statsByPlayer = new Map(playerIds.map((seat) => [seat,
    profileStats(
      getProfile(state, seat), state.opponentPriorHands, state.opponentEvidenceWeighted,
      state.opponentThreeBetOpportunityWeighted,
    )]));
  const futureExact = runoutConstraints.filter((item) => item.card).map((item) => item.card);
  state.model = new OpponentRangeModel(playerIds, {
    knownCards: [...observation.self.hole, ...observation.board, ...futureExact],
    statsByPlayer,
    tableSize,
  });
  state.modelRound = observation.round;
  state.processedRangeActionId = 0;
  state.processedKnowledgeIds = new Set();
  state.rangeAggressions = new Map();
  state.modelErrors = [];
}

function updateRangeActions(state, observation) {
  const events = observation.actionHistory
    .filter((event) => event.round === observation.round
      && event.id > state.processedRangeActionId)
    .sort((a, b) => a.id - b.id);
  for (const event of events) {
    state.processedRangeActionId = Math.max(state.processedRangeActionId, event.id);
    if (event.forced) continue;
    const key = `${event.round}:${event.street}`;
    const raisesBefore = state.rangeAggressions.get(key) || 0;
    const range = state.model.get(event.actorIdx);
    if (range) {
      try {
        state.model.setStats(event.actorIdx, profileStats(
          getProfile(state, event.actorIdx), state.opponentPriorHands,
          state.opponentEvidenceWeighted,
          state.opponentThreeBetOpportunityWeighted,
        ));
        state.model.update(event.actorIdx, event, {
          toCallBefore: event.callAmount,
          effectiveStack: event.actorStackBefore,
          activeCount: event.playersInHand,
          streetRaiseCountBefore: raisesBefore,
        });
      } catch (error) {
        state.modelErrors.push(`action ${event.id}: ${error.message}`);
      }
    }
    if (event.isAggressive) state.rangeAggressions.set(key, raisesBefore + 1);
  }
}

function strengthBandLikelihood(band, board, opponentCount) {
  return (combo) => {
    const features = comboFeatures(combo, board);
    const headsUpProxy = board.length
      ? clamp(0.08 + features.made * 0.86 + features.draw * 0.08)
      : clamp(0.18 + preflopComboStrength(combo.cards) * 0.70);
    const exponent = board.length && board.length < 5
      ? 1 + Math.max(0, opponentCount - 1) * 0.72
      : Math.max(1, opponentCount);
    const jointProxy = Math.pow(headsUpProxy, exponent);
    const predicted = jointProxy < 0.3 ? 'low' : jointProxy < 0.6 ? 'medium' : 'high';
    if (predicted === band) return 1;
    const order = { low: 0, medium: 1, high: 2 };
    return Math.abs((order[predicted] ?? 1) - (order[band] ?? 1)) === 1 ? 0.28 : 0.07;
  };
}

function applyKnowledgeEntry(state, observation, entry, publicActorIdx = null) {
  if (entry.round !== observation.round || state.processedKnowledgeIds.has(entry.id)) return;
  state.processedKnowledgeIds.add(entry.id);
  const result = entry.result || {};
  const targetIdx = Number(result.targetIdx ?? publicActorIdx);
  const range = state.model.get(targetIdx);
  if (!range) return;
  try {
    if ((result.kind === 'peek_hole' || result.kind === 'reveal_self') && result.card) {
      state.model.constrain(targetIdx, { type: 'EXACT_CARD', card: result.card });
    } else if (result.kind === 'strength_band' && result.band) {
      range.applyLikelihood(
        strengthBandLikelihood(
          result.band,
          observation.board,
          Math.max(1, observation.activeSeats.length - 1),
        ),
        { floor: 0.04, label: `strength-band:${result.band}` },
      );
    }
  } catch (error) {
    state.modelErrors.push(`knowledge ${entry.id}: ${error.message}`);
  }
}

function updateRangeKnowledge(state, observation) {
  for (const entry of observation.knowledge.privateSkillResults) {
    applyKnowledgeEntry(state, observation, entry);
  }
  for (const entry of observation.knowledge.publicSkillResults) {
    if (entry.actorIdx !== observation.observerIdx) {
      applyKnowledgeEntry(state, observation, entry, entry.actorIdx);
    }
  }
}

function prepareState(engine, observation, {
  opponentPriorHands = 60,
  opponentEvidenceWeighted = false,
  opponentThreeBetOpportunityWeighted = false,
  heterogeneousFoldModel = false,
  continuousTournamentRisk = false,
  tournamentRiskScope = 'all',
  consistentPreflopEv = false,
  callerAdjustedPreflopEv = false,
  callerProjectionWeight = 1,
  directCallerPreflopEv = false,
  tournamentValueModel = null,
  tournamentValueMaxUncertainty = 0.75,
  tournamentValueMaxOodScore = 1,
  disableTournamentRisk = false,
  equitySimulationScale = 1,
  equitySimulationFloor = Config.AI_SIMS,
} = {}) {
  const state = stateFor(engine, observation.observerIdx);
  state.opponentPriorHands = clamp(Number(opponentPriorHands) || 60, 12, 200);
  state.opponentEvidenceWeighted = opponentEvidenceWeighted === true;
  state.opponentThreeBetOpportunityWeighted = opponentThreeBetOpportunityWeighted === true;
  state.heterogeneousFoldModel = heterogeneousFoldModel === true;
  state.continuousTournamentRisk = continuousTournamentRisk === true;
  state.tournamentRiskScope = ['all', 'preflop', 'postflop'].includes(tournamentRiskScope)
    ? tournamentRiskScope : 'all';
  state.consistentPreflopEv = consistentPreflopEv === true;
  state.callerAdjustedPreflopEv = callerAdjustedPreflopEv === true;
  state.callerProjectionWeight = clamp(Number(callerProjectionWeight) || 0, 0, 1);
  state.directCallerPreflopEv = directCallerPreflopEv === true;
  state.tournamentValueModel = tournamentValueModel
    && typeof tournamentValueModel.predict === 'function' ? tournamentValueModel : null;
  state.tournamentValueMaxUncertainty = clamp(
    Number(tournamentValueMaxUncertainty) || 0, 0, 2,
  );
  state.tournamentValueMaxOodScore = clamp(Number(tournamentValueMaxOodScore) || 0, 0, 10);
  state.disableTournamentRisk = disableTournamentRisk === true;
  state.equitySimulationScale = clamp(Number(equitySimulationScale) || 0, 0.01, 1);
  state.equitySimulationFloor = Math.round(clamp(
    Number(equitySimulationFloor) || 0, 16, Config.AI_SIMS,
  ));
  updateProfiles(state, observation);
  const runoutConstraints = currentRunoutConstraints(observation);
  if (state.modelRound !== observation.round || !state.model) {
    resetRangeModel(state, observation, runoutConstraints);
  }
  const futureExact = runoutConstraints.filter((item) => item.card).map((item) => item.card);
  state.model.setKnownCards([...observation.self.hole, ...observation.board, ...futureExact]);
  updateRangeActions(state, observation);
  updateRangeKnowledge(state, observation);
  return { state, runoutConstraints };
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function seededRng(observation, counter, purpose) {
  const cards = [...observation.self.hole, ...observation.board]
    .map((card) => `${card.rank}.${card.suit}`).join(',');
  const latestId = observation.actionHistory.at(-1)?.id || 0;
  const key = [purpose, observation.observerIdx, observation.round, observation.street,
    observation.dealerIdx, observation.betting.pot, observation.betting.currentBet,
    latestId, cards, counter].join('|');
  return mulberry32(hashString(key));
}

function safeOptions(observation, engine, player) {
  if (observation.legalActions) return normalizePolicyOptions(observation.legalActions);
  // Compatibility for direct unit/advisor calls outside requestAction. Only
  // the public legal-action projection crosses this adapter boundary.
  return normalizePolicyOptions(engine.getOptions(player));
}

function publicEffectiveStack(observation) {
  const own = observation.self.hp + observation.self.betStreet;
  const largestOpponent = Math.max(0, ...observation.activeSeats
    .filter((seat) => seat !== observation.observerIdx)
    .map((seat) => {
      const player = observation.players[seat];
      return player ? player.hp + player.betStreet : 0;
    }));
  return Math.min(own, largestOpponent || own);
}

function tournamentBoundaryState(observation, wealthBySeat) {
  const tableSize = observation.players.length - 1;
  const liveSeats = [];
  for (let step = 0; step < tableSize; step++) {
    const seat = ((observation.dealerIdx - 1 + step) % tableSize) + 1;
    if (observation.players[seat]?.alive && wealthBySeat[seat] > 0) liveSeats.push(seat);
  }
  const focalPosition = liveSeats.indexOf(observation.observerIdx);
  if (focalPosition < 0) return null;
  const focalStack = wealthBySeat[observation.observerIdx];
  const opponentStacks = [];
  for (let seat = 1; seat <= tableSize; seat++) {
    if (seat !== observation.observerIdx) opponentStacks.push(wealthBySeat[seat]);
  }
  opponentStacks.sort((left, right) => right - left);
  return {
    tableSize,
    round: Math.max(0, Math.min(Config.MAX_ROUNDS - 1, observation.round - 1)),
    maxRounds: Config.MAX_ROUNDS,
    bigBlind: Number(Config.getBlinds(observation.round).bb),
    focalStack,
    opponentStacks,
    liveStacksFromButton: liveSeats.map((seat) => wealthBySeat[seat]),
    focalPosition,
  };
}

function transferTournamentWealth(wealthBySeat, focalSeat, amount) {
  const next = [...wealthBySeat];
  const opponents = [];
  for (let seat = 1; seat < next.length; seat++) {
    if (seat !== focalSeat && next[seat] > 0) opponents.push(seat);
  }
  const opponentTotal = opponents.reduce((sum, seat) => sum + next[seat], 0);
  if (!(opponentTotal > 0) || !Number.isFinite(amount) || amount === 0) return null;
  next[focalSeat] += amount;
  for (const seat of opponents) next[seat] -= amount * (next[seat] / opponentTotal);
  if (next.some((stack, seat) => seat > 0 && stack < -1e-8)) return null;
  for (let seat = 1; seat < next.length; seat++) next[seat] = Math.max(0, next[seat]);
  return next;
}

function learnedTournamentRisk(observation, state) {
  const model = state.tournamentValueModel;
  if (!model) return null;
  const tableSize = observation.players.length - 1;
  if (![6, 9].includes(tableSize)) return null;
  const wealth = Array.from({ length: tableSize + 1 }, (_, seat) => {
    if (seat === 0) return 0;
    const player = observation.players[seat];
    return Math.max(0, Number(player?.hp) || 0) + Math.max(0, Number(player?.betRound) || 0);
  });
  const focal = wealth[observation.observerIdx];
  const opponentTotal = wealth.reduce((sum, stack, seat) => (
    seat === observation.observerIdx ? sum : sum + stack
  ), 0);
  const bb = Number(Config.getBlinds(observation.round).bb);
  const probe = Math.min(bb, focal * 0.20, opponentTotal * 0.05);
  if (!(probe > 0)) return null;
  const baseState = tournamentBoundaryState(observation, wealth);
  const upWealth = transferTournamentWealth(wealth, observation.observerIdx, probe);
  const downWealth = transferTournamentWealth(wealth, observation.observerIdx, -probe);
  const upState = upWealth && tournamentBoundaryState(observation, upWealth);
  const downState = downWealth && tournamentBoundaryState(observation, downWealth);
  if (!baseState || !upState || !downState) return null;
  try {
    const base = model.predict(baseState);
    const up = model.predict(upState);
    const down = model.predict(downState);
    const predictions = [base, up, down];
    const safe = predictions.every((prediction) => !prediction.ood
      && prediction.oodScore <= state.tournamentValueMaxOodScore
      && prediction.uncertainty <= state.tournamentValueMaxUncertainty
      && Number.isFinite(prediction.mean));
    if (!safe) return { accepted: false, reason: 'model-gate' };
    const loss = Math.max(0, base.mean - down.mean);
    const gain = Math.max(0, up.mean - base.mean);
    const scale = loss + gain;
    if (!(scale > 1e-9)) return { accepted: false, reason: 'flat-marginal-value' };
    const asymmetry = clamp((loss - gain) / scale, -1, 1);
    const risk = asymmetry >= 0 ? 0.06 * asymmetry : 0.04 * asymmetry;
    return {
      accepted: true, risk, asymmetry, probe,
      baseValue: base.mean, uncertainty: Math.max(...predictions.map((row) => row.uncertainty)),
      oodScore: Math.max(...predictions.map((row) => row.oodScore)),
    };
  } catch (error) {
    state.modelErrors.push(`tournament value fallback: ${error.message}`);
    return { accepted: false, reason: 'model-error' };
  }
}

function simulationBudget(street, opponentCount, scale = 1, floor = Config.AI_SIMS) {
  const base = { preflop: 180, flop: 340, turn: 440, river: 560 }[street] || 220;
  const opponentScale = Math.max(0.52, 1 / Math.sqrt(Math.max(1, opponentCount / 2)));
  return Math.max(floor, Math.round(base * opponentScale * scale));
}

function estimateBeliefEquity(
  observation,
  state,
  runoutConstraints,
  opponentIds,
  deadIds,
  opts,
  rng,
  fallbackRng,
) {
  const sims = simulationBudget(
    observation.street,
    opponentIds.length + deadIds.length,
    state.equitySimulationScale,
    state.equitySimulationFloor,
  );
  const ranges = opponentIds.map((seat) => state.model.get(seat)).filter(Boolean);
  const deadRanges = deadIds.map((seat) => state.model.get(seat)).filter(Boolean);
  if (ranges.length !== opponentIds.length) {
    const equity = WinRate.estimate(
      observation.self.hole,
      observation.board,
      opponentIds.length,
      sims,
      { rng: fallbackRng },
    );
    return { equity, samples: sims, standardError: null, fallback: 'missing-range' };
  }
  try {
    const contributions = Object.fromEntries(observation.players
      .filter(Boolean)
      .map((player) => [player.idx, player.betRound]));
    contributions[observation.observerIdx] = (contributions[observation.observerIdx] || 0)
      + opts.callAmt;
    const actionableOpponentIds = opponentIds.filter(
      (seat) => !observation.players[seat]?.allIn,
    );
    const allFoldEligibleOpponentIds = opponentIds.filter(
      (seat) => observation.players[seat]?.allIn,
    );
    return {
      ...WinRate.estimateAgainstRanges(
        observation.self.hole,
        observation.board,
        ranges,
        sims,
        {
          rng,
          runoutConstraints,
          deadRanges,
          potModel: {
            heroId: observation.observerIdx,
            opponentIds,
            contributions,
            actionableOpponentIds,
            allFoldEligibleOpponentIds,
          },
        },
      ),
      fallback: null,
    };
  } catch (error) {
    const equity = WinRate.estimate(
      observation.self.hole,
      observation.board,
      opponentIds.length,
      sims,
      { rng: fallbackRng },
    );
    state.modelErrors.push(`equity fallback: ${error.message}`);
    return { equity, samples: sims, standardError: null, fallback: error.message };
  }
}

function isInPosition(observation) {
  const active = observation.activeSeats.filter((seat) => {
    const player = observation.players[seat];
    return player && !player.allIn && (seat !== observation.observerIdx || !observation.self.folded);
  });
  if (!active.includes(observation.observerIdx)) return false;
  const ringSize = Math.max(observation.players.length - 1, ...observation.handSeats);
  const distance = (seat) => (seat - observation.dealerIdx + ringSize) % ringSize || ringSize;
  const last = [...active].sort((a, b) => distance(a) - distance(b)).at(-1);
  return last === observation.observerIdx;
}

function closesAction(observation) {
  return observation.activeSeats
    .filter((seat) => seat !== observation.observerIdx)
    .every((seat) => {
      const player = observation.players[seat];
      return player?.allIn || (player?.acted && player.betStreet >= observation.betting.currentBet);
    });
}

function averageFoldTendency(state, opponentIds) {
  if (!opponentIds.length) return 0.5;
  const values = opponentIds.map((seat) => normalizeOpponentStats(
    profileStats(
      getProfile(state, seat), state.opponentPriorHands, state.opponentEvidenceWeighted,
      state.opponentThreeBetOpportunityWeighted,
    ),
  ).foldToCbet);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function opponentFoldTendencies(state, opponentIds) {
  return opponentIds.map((seat) => normalizeOpponentStats(profileStats(
    getProfile(state, seat), state.opponentPriorHands, state.opponentEvidenceWeighted,
    state.opponentThreeBetOpportunityWeighted,
  )).foldToCbet);
}

function averagePreflopFoldTendency(state, opponentIds) {
  if (!opponentIds.length) return 0.72;
  const values = opponentIds.map((seat) => 1 - normalizeOpponentStats(profileStats(
    getProfile(state, seat), state.opponentPriorHands, state.opponentEvidenceWeighted,
    state.opponentThreeBetOpportunityWeighted,
  )).vpip);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function preflopFoldTendencies(state, opponentIds) {
  return opponentIds.map((seat) => 1 - normalizeOpponentStats(profileStats(
    getProfile(state, seat), state.opponentPriorHands, state.opponentEvidenceWeighted,
    state.opponentThreeBetOpportunityWeighted,
  )).vpip);
}

function countPreflopContext(observation) {
  const events = observation.actionHistory.filter((event) => event.round === observation.round
    && event.street === 'preflop' && !event.forced);
  let raiseCount = 0;
  let limpers = 0;
  for (const event of events) {
    if (event.isAggressive) raiseCount++;
    else if (raiseCount === 0 && (event.type === 'call' || event.key === 'call')) limpers++;
  }
  return { raiseCount, limpers };
}

function legalizeAction(action, opts, preferCall = false) {
  if (action?.type === 'raise' && opts.canRaise) {
    const tier = opts.tiers.find((candidate) => candidate.key === action.tier?.key);
    if (tier && Number.isFinite(tier.inc) && Number.isFinite(tier.cost)) {
      return { type: 'raise', tier };
    }
  }
  if (action?.type === 'allin' && opts.canAllIn) return { type: 'allin' };
  if (action?.type === 'check' && opts.canCheck) return { type: 'check' };
  if (action?.type === 'call' && opts.callAmt > 0) return { type: 'call' };
  if (action?.type === 'fold' && opts.toCall > 0) return { type: 'fold' };
  if (opts.canCheck) return { type: 'check' };
  if (preferCall && opts.callAmt > 0) return { type: 'call' };
  return { type: 'fold' };
}

function actionDiagnostics(policy) {
  const distribution = Array.isArray(policy?.distribution) ? policy.distribution : [];
  if (!distribution.length && policy?.action) {
    return [{
      type: policy.action.type,
      tier: policy.action.tier?.key || null,
      probability: 1,
      ev: null,
      foldAll: null,
      estimatedCallers: null,
    }];
  }
  return distribution.map((candidate) => ({
    type: candidate.action.type,
    tier: candidate.action.tier?.key || null,
    probability: candidate.probability,
    ev: candidate.ev,
    foldAll: candidate.foldAll ?? null,
    estimatedCallers: candidate.estimatedCallers ?? null,
  }));
}

function decidePrepared(
  observation,
  state,
  runoutConstraints,
  opts,
  style,
  blueprintCheckpoint = null,
  blueprintRuntimeOptions = {},
) {
  const opponentIds = observation.activeSeats.filter((seat) => seat !== observation.observerIdx);
  const deadIds = observation.handSeats.filter((seat) => seat !== observation.observerIdx
    && !observation.activeSeats.includes(seat) && state.model.get(seat));
  if (!opponentIds.length) return { action: opts.canCheck ? { type: 'check' } : { type: 'fold' } };
  const decisionNumber = ++state.decisionCounter;
  const equityRng = seededRng(observation, decisionNumber, 'range-equity');
  const fallbackRng = seededRng(observation, decisionNumber, 'uniform-fallback');
  const policyRng = seededRng(observation, decisionNumber, 'mixed-policy');
  const blueprintGateRng = seededRng(observation, decisionNumber, 'blueprint-gate');
  const blueprintActionRng = seededRng(observation, decisionNumber, 'blueprint-action');
  const equityResult = estimateBeliefEquity(
    observation, state, runoutConstraints, opponentIds, deadIds, opts, equityRng, fallbackRng,
  );
  const tableSize = Math.min(9, Math.max(2, observation.handSeats.length));
  const position = observation.self.position
    || tablePosition(observation.observerIdx, observation.dealerIdx, observation.handSeats).name;
  const stack = publicEffectiveStack(observation);
  const allHps = observation.players.filter((player) => player?.alive).map((player) => player.hp);
  const heuristicTournamentRisk = state.disableTournamentRisk ? 0 : tournamentRiskAdjustment({
    round: observation.round,
    maxRounds: Config.MAX_ROUNDS,
    hp: observation.self.hp,
    allHps,
    continuous: state.continuousTournamentRisk,
  });
  const learnedTournament = learnedTournamentRisk(observation, state);
  const tournamentRisk = learnedTournament?.accepted
    ? learnedTournament.risk : heuristicTournamentRisk;
  const preflopTournamentRisk = state.tournamentRiskScope === 'postflop' ? 0 : tournamentRisk;
  const postflopTournamentRisk = state.tournamentRiskScope === 'preflop' ? 0 : tournamentRisk;
  let policy;
  let quality = null;

  if (observation.street === 'preflop') {
    const rawQuality = preflopPercentile(observation.self.hole);
    const fairShare = 1 / (opponentIds.length + 1);
    quality = clamp(rawQuality + (equityResult.equity - fairShare) * 0.10);
    const { raiseCount, limpers } = countPreflopContext(observation);
    const bb = Math.max(1, observation.blinds?.bb || 1);
    policy = preflopPolicy({
      quality,
      rangeEquity: equityResult.equity,
      callExpectedPayout: equityResult.expectedPayout,
      allFoldExpectedPayout: equityResult.allFoldExpectedPayout,
      actionableEquity: equityResult.actionableEquity,
      position,
      tableSize,
      stackBb: stack / bb,
      potOdds: opts.toCall / Math.max(1, observation.betting.pot + opts.toCall),
      raiseCount,
      limpers,
      opts,
      style,
      tournamentRisk: preflopTournamentRisk,
      consistentPreflopEv: state.consistentPreflopEv,
      callerAdjustedPreflopEv: state.callerAdjustedPreflopEv,
      callerProjectionWeight: state.callerProjectionWeight,
      foldTendency: averagePreflopFoldTendency(state, opponentIds),
      foldTendencies: preflopFoldTendencies(state, opponentIds),
      opponentEquities: equityResult.opponentEquities,
      directCallerPreflopEv: state.directCallerPreflopEv,
      numOpponents: opponentIds.length,
      pot: observation.betting.pot,
      rng: policyRng,
    });
  } else {
    const allInOpponents = opponentIds.filter((seat) => observation.players[seat]?.allIn).length;
    const actionableOpponentIds = opponentIds.filter(
      (seat) => !observation.players[seat]?.allIn,
    );
    policy = postflopPolicy({
      hole: observation.self.hole,
      board: observation.board,
      equity: equityResult.equity,
      callExpectedPayout: equityResult.expectedPayout,
      allFoldExpectedPayout: equityResult.allFoldExpectedPayout,
      actionableEquity: equityResult.actionableEquity,
      numOpponents: opponentIds.length,
      opts,
      pot: observation.betting.pot,
      stack,
      inPosition: isInPosition(observation),
      closesAction: closesAction(observation),
      tournamentRisk: postflopTournamentRisk,
      foldTendency: averageFoldTendency(state, opponentIds),
      foldTendencies: state.heterogeneousFoldModel
        ? opponentFoldTendencies(state, actionableOpponentIds) : null,
      allInOpponents,
      rng: policyRng,
    });
  }

  const baseDistributionDiagnostics = actionDiagnostics(policy);
  const preferCall = equityResult.equity
    >= opts.callAmt / Math.max(1, observation.betting.pot + opts.callAmt);
  policy = blendBlueprintPolicy(policy, {
    checkpoint: blueprintCheckpoint,
    observation,
    opts,
    weight: blueprintRuntimeOptions.blueprintWeight,
    maxBlueprintWeight: blueprintRuntimeOptions.blueprintMaxWeight
      ?? MAX_RUNTIME_BLUEPRINT_WEIGHT,
    minVisits: blueprintRuntimeOptions.blueprintMinVisits,
    gateRng: blueprintRuntimeOptions.blueprintForceIntervention === true
      ? () => 0 : blueprintGateRng,
    actionRng: blueprintActionRng,
    preferCall,
    basePolicyContract: QYJ_BASE_POLICY_CONTRACT,
    baseStyleKey: String(style?.key || 'tag').toLowerCase(),
    blockedBlueprintActionKeys: blueprintRuntimeOptions.blueprintBlockedActionKeys,
  });
  const action = legalizeAction(
    policy.action,
    opts,
    preferCall,
  );
  const policyBlueprint = getBlueprintPolicyDiagnostics(policy);
  const blueprintDiagnostics = blueprintCheckpoint
    ? Object.freeze({
      schema: blueprintCheckpoint.schema,
      hit: policyBlueprint?.hit === true,
      keyHit: policyBlueprint?.keyHit === true,
      eligible: policyBlueprint?.eligible === true,
      nodeVisits: Number.isSafeInteger(policyBlueprint?.nodeVisits)
        ? policyBlueprint.nodeVisits : 0,
      backoffLevel: ['exact', 'history', 'position', 'strategic', 'population']
        .includes(policyBlueprint?.backoffLevel)
        ? policyBlueprint.backoffLevel : 'none',
      confidence: Number(policyBlueprint?.confidence) || 0,
      backoffMultiplier: Number(policyBlueprint?.backoffMultiplier) || 0,
      weight: Number(policyBlueprint?.effectiveWeight ?? policyBlueprint?.weight) || 0,
      effectiveWeight: Number(policyBlueprint?.effectiveWeight ?? policyBlueprint?.weight) || 0,
      policyTV: Number(policyBlueprint?.policyTV) || 0,
      influence: Number(policyBlueprint?.influence) || 0,
      advantageGuardEnabled: policyBlueprint?.advantageGuardEnabled === true,
      advantageComplete: policyBlueprint?.advantageComplete === true,
      advantagePassed: policyBlueprint?.advantagePassed === true,
      advantageMean: policyBlueprint?.advantageMean != null
        && Number.isFinite(Number(policyBlueprint.advantageMean))
        ? Number(policyBlueprint.advantageMean) : null,
      advantageLowerBound: policyBlueprint?.advantageLowerBound != null
        && Number.isFinite(Number(policyBlueprint.advantageLowerBound))
        ? Number(policyBlueprint.advantageLowerBound) : null,
      advantageMinSamples: Number.isSafeInteger(policyBlueprint?.advantageMinSamples)
        ? policyBlueprint.advantageMinSamples : 0,
      advantageCoveredActions: Number.isSafeInteger(policyBlueprint?.advantageCoveredActions)
        ? policyBlueprint.advantageCoveredActions : 0,
      advantageRequiredActions: Number.isSafeInteger(policyBlueprint?.advantageRequiredActions)
        ? policyBlueprint.advantageRequiredActions : 0,
      intervened: policyBlueprint?.intervened === true,
      actionChanged: policyBlueprint?.actionChanged === true,
      baseActionKey: typeof policyBlueprint?.baseActionKey === 'string'
        ? policyBlueprint.baseActionKey : null,
      selectedActionKey: typeof policyBlueprint?.selectedActionKey === 'string'
        ? policyBlueprint.selectedActionKey : null,
      iterations: checkpointIterations(blueprintCheckpoint),
      size: blueprintCheckpoint.size,
      baseStrategy: Array.isArray(policyBlueprint?.baseStrategy)
        ? policyBlueprint.baseStrategy : null,
      targetStrategy: Array.isArray(policyBlueprint?.targetStrategy)
        ? policyBlueprint.targetStrategy : null,
    })
    : null;
  state.lastDiagnostics = Object.freeze({
    observerIdx: observation.observerIdx,
    round: observation.round,
    street: observation.street,
    tableSize,
    activeOpponents: opponentIds.length,
    position,
    quality,
    equity: equityResult.equity,
    equityStandardError: equityResult.standardError,
    simulations: equityResult.samples,
    equityFallback: equityResult.fallback,
    tournamentRisk,
    learnedTournamentValue: learnedTournament,
    tournamentRiskScope: state.tournamentRiskScope,
    selected: { type: action.type, tier: action.tier?.key || null },
    distribution: actionDiagnostics(policy),
    baseDistribution: baseDistributionDiagnostics,
    modeledOpponents: opponentIds.length,
    modelErrorCount: state.modelErrors.length,
    blueprint: blueprintDiagnostics,
  });
  return { action, policy, equityResult };
}

function threatScore(observation, state, seat) {
  const player = observation.players[seat];
  const stats = normalizeOpponentStats(profileStats(
    getProfile(state, seat), state.opponentPriorHands, state.opponentEvidenceWeighted,
    state.opponentThreeBetOpportunityWeighted,
  ));
  const latestAggression = observation.actionHistory.slice().reverse().find(
    (event) => event.round === observation.round && event.actorIdx === seat && event.isAggressive,
  );
  return (player?.hp || 0) + (player?.energy || 0) * (observation.blinds?.bb || 20) * 0.5
    + stats.aggression * 80 + (latestAggression ? 120 : 0);
}

function chooseSkillField(field, selection, observation, state) {
  const options = field.options || [];
  if (!options.length) return undefined;
  if (field.type === 'target') {
    return [...options].sort((a, b) => threatScore(observation, state, Number(b.value))
      - threatScore(observation, state, Number(a.value)))[0].value;
  }
  const values = options.map((option) => option.value);
  if (values.includes(1) && values.includes(2)) {
    return observation.self.hole[0].rank <= observation.self.hole[1].rank ? 1 : 2;
  }
  if (values.includes('red') && values.includes('black')) {
    const known = [...observation.self.hole, ...observation.board];
    const redKnown = known.filter((card) => card.suit === 2 || card.suit === 3).length;
    return redKnown <= known.length - redKnown ? 'red' : 'black';
  }
  if (values.includes('low') && values.includes('high')) {
    const hand = describe([...observation.self.hole, ...observation.board]);
    const draws = drawProfile(observation.self.hole, observation.board);
    return hand.cat >= 3 || draws.outs >= 8 ? 'high' : 'low';
  }
  if (values.includes('showdown') && values.includes('uncontested')) {
    const quality = preflopPercentile(observation.self.hole);
    return observation.activeSeats.length <= 3 && quality < 0.93 ? 'showdown' : 'uncontested';
  }
  if (values.includes('fold') && values.includes('defend') && values.includes('attack')) {
    const target = observation.players[selection.targetIdx];
    if (target?.lastAction && ['feint', 'strike', 'fierce', 'allin'].includes(target.lastAction.key)) {
      return 'attack';
    }
    const stats = target
      ? normalizeOpponentStats(profileStats(
        getProfile(state, target.idx), state.opponentPriorHands, state.opponentEvidenceWeighted,
        state.opponentThreeBetOpportunityWeighted,
      ))
      : null;
    return stats?.foldToCbet > 0.52 ? 'fold' : 'defend';
  }
  if (values.includes('defend') && values.includes('attack')) {
    const target = observation.players[selection.targetIdx];
    if (target) {
      if (target.lastAction && ['feint', 'strike', 'fierce', 'allin'].includes(target.lastAction.key)) {
        return 'attack';
      }
      const stats = normalizeOpponentStats(profileStats(
        getProfile(state, target.idx), state.opponentPriorHands, state.opponentEvidenceWeighted,
        state.opponentThreeBetOpportunityWeighted,
      ));
      return stats.aggression > 0.22 ? 'attack' : 'defend';
    }
    return preflopPercentile(observation.self.hole) >= 0.78 ? 'attack' : 'defend';
  }
  return options[0].value;
}

function skillUseProbability(observation, availability) {
  const effects = JSON.stringify(availability.skill?.effects || []);
  const informationValue = /PEEK_/.test(effects) ? 0.34 : 0;
  const energyReturn = /ENERGY_CHANGE/.test(effects) ? 0.16 : 0;
  const progress = observation.round / Math.max(1, Config.MAX_ROUNDS);
  const potBb = observation.betting.pot / Math.max(1, observation.blinds?.bb || 1);
  const reservePenalty = observation.self.energy - availability.cost <= 0 && progress < 0.65 ? 0.22 : 0;
  return clamp(0.28 + informationValue + energyReturn + Math.min(0.14, potBb * 0.012)
    + progress * 0.16 - reservePenalty, 0.12, 0.94);
}

/** Choose and execute a skill using only public/self information and persisted legal discoveries. */
export function maybeUseSkill(engine, player) {
  const availability = engine.skillAvailability(player.idx);
  if (!availability.ok) return false;
  const observation = buildObservation(engine, player.idx);
  const { state } = prepareState(engine, observation);
  const rng = seededRng(observation, ++state.skillDecisionCounter, 'skill-policy');
  if (rng() >= skillUseProbability(observation, availability)) return false;
  const prompt = engine.getSkillPrompt(player.idx);
  let selection = null;
  if (prompt?.fields?.length) {
    selection = {};
    for (const field of prompt.fields) {
      const value = chooseSkillField(field, selection, observation, state);
      if (value === undefined) return false;
      selection[field.key] = value;
    }
  }
  return !!engine.useSkill(player.idx, selection);
}

/** Main Engine adapter -> { type, tier? }. */
export function decide(engine, player) {
  const observation = buildObservation(engine, player.idx);
  const { state, runoutConstraints } = prepareState(engine, observation);
  const opts = safeOptions(observation, engine, player);
  return decidePrepared(
    observation,
    state,
    runoutConstraints,
    opts,
    styleOf(player),
    activeBlueprintCheckpoint,
  ).action;
}

/**
 * Evaluate one seat with a local checkpoint without changing global runtime
 * configuration. This is used by mirrored leagues and candidate-vs-baseline
 * matches running in the same process.
 */
export function decideWithBlueprint(engine, player, checkpoint, options = {}) {
  const compiled = asCompiledBlueprint(checkpoint);
  const observation = buildObservation(engine, player.idx);
  const { state, runoutConstraints } = prepareState(engine, observation, options);
  const opts = safeOptions(observation, engine, player);
  return decidePrepared(
    observation,
    state,
    runoutConstraints,
    opts,
    styleOf(player),
    compiled,
    options,
  ).action;
}

export function getLastDecisionDiagnostics(engine, playerOrSeat) {
  const seat = Number(typeof playerOrSeat === 'object' ? playerOrSeat?.idx : playerOrSeat);
  const diagnostics = ENGINE_STATES.get(engine)?.get(seat)?.lastDiagnostics;
  return diagnostics ? JSON.parse(JSON.stringify(diagnostics)) : null;
}

export function clearDecisionState(engine) {
  return ENGINE_STATES.delete(engine);
}
