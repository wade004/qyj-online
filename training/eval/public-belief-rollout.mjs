import { createHash } from 'node:crypto';

import * as AI from '../../js/game/ai.js';
import * as Config from '../../js/game/config.js';
import { Engine } from '../../js/game/engine.js';
import { buildObservation } from '../../js/game/observation.js';
import { describe } from '../../js/game/handeval.js';
import { drawProfile, preflopPercentile } from '../../js/game/ai-policy.js';
import {
  actionFromBlueprintKey,
  actionToBlueprintKey,
} from '../../js/game/blueprint-policy.js';
import { sampleTargetPublicBeliefDeal } from '../blueprint/targeted.js';
import { SerializableRng } from '../blueprint/rng.js';
import { captureTournamentValueState } from '../tournament-value/dataset.mjs';
import { normalizedFinalRankValue } from '../tournament-value/model.js';

export const PUBLIC_BELIEF_ROLLOUT_SCHEMA = 'qyj-public-belief-engine-rollout-v1';

function cardKey(card) {
  return `${Number(card?.rank)}:${Number(card?.suit)}`;
}

function lowerBound(values) {
  if (values.length < 2) return { mean: values[0] ?? null, lowerBound: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0)
    / (values.length - 1);
  const t95 = 1.644854 + 0.710 / (values.length - 1);
  return { mean, lowerBound: mean - t95 * Math.sqrt(variance / values.length) };
}

function cloneActionHistory(history) {
  return (history || []).map((event) => Object.freeze({
    ...event,
    board: Object.freeze((event.board || []).map((card) => Object.freeze({ ...card }))),
    handSeats: Object.freeze([...(event.handSeats || [])]),
    activeSeatsBefore: Object.freeze([...(event.activeSeatsBefore || [])]),
    activeSeats: Object.freeze([...(event.activeSeats || [])]),
  }));
}

function hydratePublicBeliefEngine(target, deal, seed) {
  const { snapshot, actorIdx } = target;
  const tableSize = Number(snapshot.publicSeatCapacity);
  const allHuman = new Set(Array.from({ length: tableSize }, (_, index) => index + 1));
  let resolved = false;
  const engine = new Engine(
    Array(tableSize).fill('zhugeliang'),
    {
      onRoundEnd: () => { resolved = true; },
    },
    allHuman,
    {},
    {
      tableSize,
      skillsEnabled: false,
      endWhenHumanEliminated: false,
      rng: () => seed.next(),
    },
  );
  const snapshotPlayers = new Map(snapshot.players.map((player) => [player.idx, player]));
  const tournamentPlayers = new Map(
    (snapshot.tournament?.players || []).map((player) => [player.idx, player]),
  );
  const holes = new Map(deal.holes.map((entry) => [entry.seat, entry.cards]));
  const tag = Config.AI_STYLES.find((style) => style.key === 'tag') || Config.AI_STYLES[0];
  for (let seat = 1; seat <= tableSize; seat++) {
    const player = engine.players[seat];
    const publicPlayer = snapshotPlayers.get(seat);
    const tournamentPlayer = tournamentPlayers.get(seat);
    const alive = tournamentPlayer ? tournamentPlayer.alive !== false : !!publicPlayer;
    player.style = tag;
    player.hp = Number(publicPlayer?.hp ?? tournamentPlayer?.hp) || 0;
    player.energy = Config.INIT_ENERGY;
    player.alive = alive;
    player.hole = (holes.get(seat) || []).map((card) => ({ ...card }));
    player.folded = publicPlayer ? publicPlayer.folded === true : true;
    player.allIn = publicPlayer?.allIn === true;
    player.betStreet = Number(publicPlayer?.betStreet) || 0;
    player.betRound = Number(publicPlayer?.betRound) || 0;
    player.acted = publicPlayer?.acted === true;
    player.lastActionBet = !player.acted ? 0
      : seat === actorIdx && snapshot.legalActions.canRaise
        ? Math.max(0, snapshot.betting.currentBet - snapshot.betting.minRaiseIncrement)
        : snapshot.betting.currentBet;
    player.lastAction = null;
    player.roundStartHp = player.hp + player.betRound;
    player.deathRound = alive ? null : Math.max(0, snapshot.round - 1);
    player.deathOrder = alive ? null : seat;
    player.showdownInfo = null;
  }
  engine.round = snapshot.round;
  engine.dealerIdx = snapshot.dealerIdx;
  engine.street = snapshot.street;
  engine.board = deal.board.map((card) => ({ ...card }));
  engine.revealed = snapshot.board.length;
  engine.deck = [];
  engine.currentBet = snapshot.betting.currentBet;
  engine.minRaiseInc = snapshot.betting.minRaiseIncrement;
  engine.streetRaiseCount = snapshot.betting.streetRaiseCount;
  engine.actingIdx = actorIdx;
  engine.waitingIdx = actorIdx;
  engine.actionCursorIdx = actorIdx;
  engine.streetHadRaise = snapshot.actionHistory.some((event) => (
    event.round === snapshot.round && event.street === snapshot.street && event.isAggressive
  ));
  engine.allInHandsRevealed = false;
  engine.lastAggressiveWager = null;
  engine.currentHandSeats = [...snapshot.handSeats];
  engine.actionHistory = cloneActionHistory(snapshot.actionHistory);
  engine.actionEventSeq = Math.max(0, ...snapshot.actionHistory.map((event) => Number(event.id) || 0));
  engine.privateSkillKnowledge = Array.from({ length: tableSize + 1 }, () => []);
  engine.publicSkillKnowledge = [];
  engine.queue = [];
  engine.time = 0;
  const known = new Set([
    ...snapshot.selfHole,
    ...snapshot.board,
  ].map(cardKey));
  if (known.size !== snapshot.selfHole.length + snapshot.board.length) {
    throw new RangeError('rollout root contains duplicate known cards');
  }
  return { engine, resolved: () => resolved };
}

function legalActionKeys(engine, player) {
  const options = engine.getOptions(player);
  return [
    ...(options.canCheck ? ['check'] : ['fold', 'call']),
    ...options.tiers.map((tier) => `raise:${tier.key}`),
    ...(options.canAllIn ? ['allin'] : []),
  ];
}

function publicContinuationProfile(engine, player) {
  const observation = buildObservation(engine, player);
  const options = engine.getOptions(player);
  const opponents = Math.max(1, observation.activeSeats.length - 1);
  let draw = { potential: 0, nutPotential: 0 };
  let strength;
  if (observation.street === 'preflop') {
    strength = preflopPercentile(observation.self.hole) - Math.min(0.18, (opponents - 1) * 0.025);
  } else {
    const hand = describe([...observation.self.hole, ...observation.board]);
    draw = drawProfile(observation.self.hole, observation.board);
    const made = [0, 0.18, 0.43, 0.66, 0.76, 0.83, 0.88, 0.93, 0.97, 0.99, 1][hand.cat] || 0.18;
    strength = Math.min(1, made + draw.potential * 0.18 + draw.nutPotential * 0.08
      - Math.min(0.16, (opponents - 1) * 0.025));
  }
  const pot = Math.max(1, Number(observation.betting.pot) || 1);
  const callAmount = Math.max(0, Number(options.callAmt) || 0);
  const potOdds = callAmount / Math.max(1, pot + callAmount);
  const tier = (key) => options.tiers.find((candidate) => candidate.key === key);
  return { observation, options, strength, draw, pot, callAmount, potOdds, tier };
}

function fastPublicContinuationAction(engine, player) {
  const {
    options, strength, pot, callAmount, potOdds, tier,
  } = publicContinuationProfile(engine, player);
  if (options.canCheck) {
    if (strength >= 0.82 && tier('fierce')) return { type: 'raise', tier: tier('fierce') };
    if (strength >= 0.68 && tier('strike')) return { type: 'raise', tier: tier('strike') };
    if (strength >= 0.55 && tier('feint')) return { type: 'raise', tier: tier('feint') };
    return { type: 'check' };
  }
  if (strength + 0.04 < potOdds) return { type: 'fold' };
  if (strength >= 0.86 && tier('fierce')) return { type: 'raise', tier: tier('fierce') };
  if (strength >= 0.75 && tier('strike') && callAmount <= pot * 0.45) {
    return { type: 'raise', tier: tier('strike') };
  }
  return { type: 'call' };
}

export function choosePublicOptionContinuationAction(engine, player, mode) {
  if (!['control', 'pressure', 'thin-value', 'polarized'].includes(mode)) {
    throw new RangeError('unsupported public option continuation mode');
  }
  if (mode === 'pressure') return fastPublicContinuationAction(engine, player);
  const {
    options, strength, draw, pot, callAmount, potOdds, tier,
  } = publicContinuationProfile(engine, player);
  if (mode === 'control') {
    if (options.canCheck) return { type: 'check' };
    return strength + 0.08 >= potOdds ? { type: 'call' } : { type: 'fold' };
  }
  if (mode === 'thin-value') {
    if (options.canCheck) {
      if (strength >= 0.72 && tier('strike')) return { type: 'raise', tier: tier('strike') };
      if (strength >= 0.5 && tier('feint')) return { type: 'raise', tier: tier('feint') };
      return { type: 'check' };
    }
    if (strength + draw.potential * 0.08 < potOdds + 0.02) return { type: 'fold' };
    if (strength >= 0.78 && callAmount <= pot * 0.3 && tier('feint')) {
      return { type: 'raise', tier: tier('feint') };
    }
    return { type: 'call' };
  }
  const semiBluff = strength < 0.55
    && (draw.nutPotential >= 0.2 || draw.potential >= 0.4);
  if (options.canCheck) {
    if (strength >= 0.84 && tier('fierce')) return { type: 'raise', tier: tier('fierce') };
    if (strength >= 0.74 && tier('strike')) return { type: 'raise', tier: tier('strike') };
    if (semiBluff && tier('strike')) return { type: 'raise', tier: tier('strike') };
    return { type: 'check' };
  }
  if (strength >= 0.86 && tier('fierce')) return { type: 'raise', tier: tier('fierce') };
  if (strength >= 0.76 && callAmount <= pot * 0.4 && tier('strike')) {
    return { type: 'raise', tier: tier('strike') };
  }
  if (semiBluff && callAmount <= pot * 0.25 && tier('feint')) {
    return { type: 'raise', tier: tier('feint') };
  }
  return strength + 0.02 >= potOdds ? { type: 'call' } : { type: 'fold' };
}

function runBeliefHand(
  target, deal, firstActionKey, continuationSeed, continuationOptions, continuationMode,
  tournamentValueModel = null, tournamentRiskWeight = 0,
  focalContinuationMode = null, focalContinuationLimit = 0,
) {
  const { engine, resolved } = hydratePublicBeliefEngine(
    target, deal, new SerializableRng(`${continuationSeed}|engine`),
  );
  const actor = engine.players[target.actorIdx];
  const rootKeys = legalActionKeys(engine, actor);
  if (!rootKeys.includes(firstActionKey)) {
    throw new RangeError('rollout first action is not legal at the hydrated root');
  }
  let first = true;
  let decisions = 0;
  let focalContinuationDecisions = 0;
  // A nine-seat hand with repeated full raises can legitimately require more
  // than 256 scheduler/action transitions. The live Engine caps raise tiers;
  // 1024 remains a finite defensive boundary well above every legal hand.
  for (let step = 0; step < 1024 && !resolved(); step++) {
    if (engine.waitingIdx) {
      const player = engine.players[engine.waitingIdx];
      const options = engine.getOptions(player);
      const focalContinuation = !first && player.idx === target.actorIdx
        && focalContinuationMode && focalContinuationDecisions < focalContinuationLimit;
      const action = first
        ? actionFromBlueprintKey(firstActionKey, options)
        : focalContinuation
          ? choosePublicOptionContinuationAction(engine, player, focalContinuationMode)
          : continuationMode === 'fast-public'
            ? fastPublicContinuationAction(engine, player)
            : AI.decideWithBlueprint(engine, player, null, continuationOptions);
      first = false;
      if (focalContinuation) focalContinuationDecisions++;
      if (!action) throw new RangeError('rollout policy produced no legal action');
      decisions++;
      engine.playerAct(action);
      continue;
    }
    if (engine.queue.length) {
      engine.update(10_000);
      continue;
    }
    engine.proceedAction();
  }
  if (!resolved()) {
    throw new RangeError(
      `public-belief Engine rollout exceeded step budget at ${engine.street}`
      + ` waiting=${engine.waitingIdx ?? 0} queue=${engine.queue.length}`
      + ` active=${engine.activePlayers().length} currentBet=${engine.currentBet}`,
    );
  }
  const focal = engine.players[target.actorIdx];
  let tournamentValue = null;
  let tournamentValueSource = null;
  if (tournamentValueModel) {
    const terminalTournament = focal.hp <= 0 || focal.alive === false
      || engine.round >= Config.MAX_ROUNDS || engine.aliveCount() < 2;
    if (terminalTournament) {
      const ranking = engine.players.slice(1).sort((left, right) => {
        if (left.alive !== right.alive) return left.alive ? -1 : 1;
        if (left.alive) return right.hp - left.hp || left.idx - right.idx;
        return (right.deathOrder || 0) - (left.deathOrder || 0)
          || left.idx - right.idx;
      });
      const rank = ranking.findIndex((player) => player.idx === focal.idx) + 1;
      tournamentValue = normalizedFinalRankValue(rank, engine.tableSize);
      tournamentValueSource = Object.freeze({ terminal: true, rank, uncertainty: 0 });
    } else {
      const state = captureTournamentValueState(engine, target.actorIdx, 'end');
      const prediction = tournamentValueModel.predict(state);
      if (prediction.ood || !Number.isFinite(Number(prediction.mean))
        || !Number.isFinite(Number(prediction.uncertainty))) {
        throw new RangeError('rollout tournament-value leaf is outside the promoted domain');
      }
      tournamentValue = Number(prediction.mean)
        - Math.max(0, Number(tournamentRiskWeight) || 0) * Number(prediction.uncertainty);
      tournamentValueSource = Object.freeze({
        terminal: false,
        mean: Number(prediction.mean),
        uncertainty: Number(prediction.uncertainty),
        riskWeight: Math.max(0, Number(tournamentRiskWeight) || 0),
      });
    }
  }
  return Object.freeze({
    hp: focal.hp,
    survival: focal.hp > 0 && focal.alive !== false ? 1 : 0,
    tournamentValue,
    tournamentValueSource,
    decisions,
    focalContinuationDecisions,
  });
}

export function evaluatePublicBeliefOptionPlans(target, {
  basePlanId,
  plans,
  seedNamespace = 'qyj-v109-public-belief-option',
  clusterCount = 12,
  beliefTemperature = 0.5,
  minAdvantage = 1,
  continuationMode = 'fast-public',
  continuationEquityScale = 0.08,
  continuationEquityFloor = 24,
  tournamentValueModel,
  tournamentRiskWeight = 0.25,
  tournamentGateStatistic = 'lowerBound',
  hpGateStatistic = 'lowerBound',
  minTournamentAdvantage = 0,
  survivalGateStatistic = 'lowerBound',
  minSurvivalAdvantage = 0,
  minContinuationReachRate = 0.5,
  allowPartialPlanFailures = false,
  minPlanValidRate = 1,
} = {}) {
  if (!target?.snapshot || !Array.isArray(plans) || plans.length < 2
    || !Number.isSafeInteger(clusterCount) || clusterCount < 2 || clusterCount > 32
    || !['fast-public', 'qyz'].includes(continuationMode)
    || !['lowerBound', 'mean'].includes(tournamentGateStatistic)
    || !['lowerBound', 'mean'].includes(hpGateStatistic)
    || !['lowerBound', 'mean'].includes(survivalGateStatistic)
    || !Number.isFinite(Number(minContinuationReachRate))
    || Number(minContinuationReachRate) < 0
    || Number(minContinuationReachRate) > 1
    || typeof allowPartialPlanFailures !== 'boolean'
    || !Number.isFinite(Number(minPlanValidRate))
    || Number(minPlanValidRate) < 0
    || Number(minPlanValidRate) > 1
    || typeof tournamentValueModel?.predict !== 'function') {
    throw new TypeError('invalid public-belief option-plan request');
  }
  const normalizedPlans = [...new Map(plans.map((plan) => [String(plan.id), Object.freeze({
    id: String(plan.id),
    firstActionKey: String(plan.firstActionKey),
    continuationMode: plan.continuationMode == null ? null : String(plan.continuationMode),
  })])).values()];
  const basePlan = normalizedPlans.find((plan) => plan.id === String(basePlanId));
  if (!basePlan || basePlan.continuationMode !== null
    || normalizedPlans.some((plan) => plan.continuationMode != null
      && !['control', 'pressure', 'thin-value', 'polarized'].includes(plan.continuationMode))) {
    throw new RangeError('option plans require one null-continuation base plan');
  }
  const values = new Map(normalizedPlans.map((plan) => [plan.id, {
    hp: Array(clusterCount).fill(null),
    tournament: Array(clusterCount).fill(null),
    survival: Array(clusterCount).fill(null),
    focalContinuations: 0,
    errors: {},
  }]));
  const rootDigest = createHash('sha256').update(target.targetKey).digest('hex');
  const continuationOptions = Object.freeze({
    equitySimulationScale: Math.max(0.01, Math.min(1, Number(continuationEquityScale) || 1)),
    equitySimulationFloor: Math.max(16, Math.min(
      Config.AI_SIMS, Math.round(Number(continuationEquityFloor) || Config.AI_SIMS),
    )),
  });
  let utilitySamples = 0;
  let continuationDecisions = 0;
  for (let cluster = 0; cluster < clusterCount; cluster++) {
    const deal = sampleTargetPublicBeliefDeal(
      target,
      new SerializableRng(`${seedNamespace}|${rootDigest}|deal|${cluster}`),
      { beliefTemperature, maxRaisesPerStreet: 3 },
    );
    for (const plan of normalizedPlans) {
      const bucket = values.get(plan.id);
      try {
        const result = runBeliefHand(
          target, deal, plan.firstActionKey,
          `${seedNamespace}|${rootDigest}|continuation|${cluster}`,
          continuationOptions, continuationMode, tournamentValueModel, tournamentRiskWeight,
          plan.continuationMode, plan.continuationMode ? 1 : 0,
        );
        bucket.hp[cluster] = result.hp;
        bucket.tournament[cluster] = result.tournamentValue;
        bucket.survival[cluster] = result.survival;
        bucket.focalContinuations += result.focalContinuationDecisions;
        utilitySamples++;
        continuationDecisions += result.decisions;
      } catch (error) {
        if (!allowPartialPlanFailures) throw error;
        const reason = String(error?.message || error).slice(0, 140);
        bucket.errors[reason] = (bucket.errors[reason] || 0) + 1;
      }
    }
  }
  const base = values.get(basePlan.id);
  const candidates = normalizedPlans.filter((plan) => plan.id !== basePlan.id).map((plan) => {
    const bucket = values.get(plan.id);
    const validIndices = Array.from({ length: clusterCount }, (_, index) => index).filter(
      (index) => Number.isFinite(bucket.hp[index]) && Number.isFinite(base.hp[index])
        && Number.isFinite(bucket.tournament[index]) && Number.isFinite(base.tournament[index])
        && Number.isFinite(bucket.survival[index]) && Number.isFinite(base.survival[index]),
    );
    const hp = lowerBound(validIndices.map((index) => bucket.hp[index] - base.hp[index]));
    const tournament = lowerBound(validIndices.map(
      (index) => bucket.tournament[index] - base.tournament[index],
    ));
    const survival = lowerBound(validIndices.map(
      (index) => bucket.survival[index] - base.survival[index],
    ));
    return Object.freeze({
      ...plan,
      ...hp,
      hp: Object.freeze(hp),
      tournament: Object.freeze(tournament),
      survival: Object.freeze(survival),
      focalContinuationDecisions: bucket.focalContinuations,
      continuationReachRate: validIndices.length
        ? bucket.focalContinuations / validIndices.length : 0,
      validClusterCount: validIndices.length,
      validClusterRate: validIndices.length / clusterCount,
      errorCounts: Object.freeze({ ...bucket.errors }),
    });
  }).sort((left, right) => (
    (right.tournament[tournamentGateStatistic] ?? -Infinity)
      - (left.tournament[tournamentGateStatistic] ?? -Infinity)
    || right.lowerBound - left.lowerBound
    || left.id.localeCompare(right.id)
  ));
  const eligibleCandidates = candidates.filter((candidate) => (
    candidate.validClusterCount >= 2
    && candidate.validClusterRate >= Number(minPlanValidRate)
    && candidate.continuationReachRate >= Number(minContinuationReachRate)
    && Number(candidate.hp[hpGateStatistic]) >= Number(minAdvantage)
    && Number(candidate.tournament[tournamentGateStatistic]) >= Number(minTournamentAdvantage)
    && Number(candidate.survival[survivalGateStatistic]) >= Number(minSurvivalAdvantage)
  ));
  const selected = eligibleCandidates[0] || null;
  return Object.freeze({
    schema: 'qyj-public-belief-two-step-option-v1',
    version: 1,
    mode: 'offline-evaluation-only',
    accepted: !!selected,
    reason: selected ? null : 'option-no-positive-triple-paired-bound',
    basePlanId: basePlan.id,
    actionKey: selected?.firstActionKey || basePlan.firstActionKey,
    continuationMode: selected?.continuationMode || null,
    selected,
    eligibleCandidates: Object.freeze(eligibleCandidates),
    candidates: Object.freeze(candidates),
    clusterCount,
    utilitySamples,
    continuationDecisions,
    tournamentGateStatistic,
    hpGateStatistic,
    survivalGateStatistic,
    minContinuationReachRate: Number(minContinuationReachRate),
    minPlanValidRate: Number(minPlanValidRate),
    provenance: Object.freeze({
      seedNamespace,
      rootSha256: rootDigest,
      continuationMode,
      hpGateStatistic,
      continuationEquityScale: continuationOptions.equitySimulationScale,
      continuationEquityFloor: continuationOptions.equitySimulationFloor,
      minContinuationReachRate: Number(minContinuationReachRate),
      allowPartialPlanFailures,
      minPlanValidRate: Number(minPlanValidRate),
      utilityObjective: 'paired-hp-tournament-survival-two-step-option',
    }),
  });
}

export function evaluatePublicBeliefRolloutActions(target, {
  baseActionKey,
  actionKeys,
  seedNamespace = 'qyj-v62-public-belief-rollout',
  clusterCount = 6,
  beliefTemperature = 0.5,
  minAdvantage = 1,
  continuationEquityScale = 1,
  continuationEquityFloor = Config.AI_SIMS,
  continuationMode = 'qyz',
  utilityMode = 'hp',
  tournamentValueModel = null,
  tournamentRiskWeight = 0.25,
  minTournamentAdvantage = 0,
  tournamentGateStatistic = 'lowerBound',
  minSurvivalAdvantage = 0,
  survivalGateStatistic = 'lowerBound',
} = {}) {
  if (!target?.snapshot || !baseActionKey || !Array.isArray(actionKeys)
    || !Number.isSafeInteger(clusterCount) || clusterCount < 2 || clusterCount > 32) {
    throw new TypeError('invalid public-belief rollout request');
  }
  if (!['qyz', 'fast-public'].includes(continuationMode)) {
    throw new RangeError('unsupported public-belief continuation mode');
  }
  const usesTournament = utilityMode === 'dual-tournament'
    || utilityMode === 'triple-tournament-survival';
  const usesSurvival = utilityMode === 'hp-survival'
    || utilityMode === 'triple-tournament-survival';
  if (!['hp', 'dual-tournament', 'hp-survival',
    'triple-tournament-survival'].includes(utilityMode)
    || (usesTournament
      && typeof tournamentValueModel?.predict !== 'function')) {
    throw new RangeError('dual-tournament rollout requires a compiled tournament-value model');
  }
  if (!['lowerBound', 'mean'].includes(survivalGateStatistic)) {
    throw new RangeError('unsupported survival gate statistic');
  }
  if (!['lowerBound', 'mean'].includes(tournamentGateStatistic)) {
    throw new RangeError('unsupported tournament gate statistic');
  }
  const actions = [...new Set(actionKeys.map(String))].sort();
  if (!actions.includes(baseActionKey)) throw new RangeError('base action must be evaluated');
  const values = new Map(actions.map((actionKey) => [actionKey, {
    hp: [], survival: [], tournament: [],
  }]));
  let utilitySamples = 0;
  let continuationDecisions = 0;
  let evidenceEvents = 0;
  const rootDigest = createHash('sha256').update(target.targetKey).digest('hex');
  const continuationOptions = Object.freeze({
    equitySimulationScale: Math.max(0.01, Math.min(1, Number(continuationEquityScale) || 1)),
    equitySimulationFloor: Math.max(16, Math.min(
      Config.AI_SIMS, Math.round(Number(continuationEquityFloor) || Config.AI_SIMS),
    )),
  });
  for (let cluster = 0; cluster < clusterCount; cluster++) {
    const deal = sampleTargetPublicBeliefDeal(
      target,
      new SerializableRng(`${seedNamespace}|${rootDigest}|deal|${cluster}`),
      { beliefTemperature, maxRaisesPerStreet: 3 },
    );
    evidenceEvents = deal.evidenceEvents;
    for (const actionKey of actions) {
      const result = runBeliefHand(
        target, deal, actionKey,
        `${seedNamespace}|${rootDigest}|continuation|${cluster}`,
        continuationOptions,
        continuationMode,
        usesTournament ? tournamentValueModel : null,
        tournamentRiskWeight,
      );
      values.get(actionKey).hp.push(result.hp);
      values.get(actionKey).survival.push(result.survival);
      if (usesTournament) {
        values.get(actionKey).tournament.push(result.tournamentValue);
      }
      utilitySamples++;
      continuationDecisions += result.decisions;
    }
  }
  const base = values.get(baseActionKey);
  const candidates = actions.filter((actionKey) => actionKey !== baseActionKey).map((actionKey) => {
    const actionValues = values.get(actionKey);
    const pairedHp = actionValues.hp.map((value, index) => value - base.hp[index]);
    const hp = lowerBound(pairedHp);
    const survival = usesSurvival
      ? lowerBound(actionValues.survival.map(
        (value, index) => value - base.survival[index],
      )) : null;
    const tournament = usesTournament
      ? lowerBound(actionValues.tournament.map(
        (value, index) => value - base.tournament[index],
      )) : null;
    return Object.freeze({
      actionKey,
      // Preserve the V62-V74 diagnostics contract: top-level mean/LCB remain HP.
      ...hp,
      hp: Object.freeze(hp),
      survival: survival ? Object.freeze(survival) : null,
      tournament: tournament ? Object.freeze(tournament) : null,
    });
  }).sort((left, right) => (
    usesTournament
      ? (right.tournament?.[tournamentGateStatistic] ?? -Infinity)
        - (left.tournament?.[tournamentGateStatistic] ?? -Infinity)
      : utilityMode === 'hp-survival'
        ? (right.survival?.[survivalGateStatistic] ?? -Infinity)
          - (left.survival?.[survivalGateStatistic] ?? -Infinity)
      : (right.lowerBound ?? -Infinity) - (left.lowerBound ?? -Infinity)
    || (right.lowerBound ?? -Infinity) - (left.lowerBound ?? -Infinity)
    || (right.mean ?? -Infinity) - (left.mean ?? -Infinity)
    || left.actionKey.localeCompare(right.actionKey)
  ));
  const eligibleCandidates = candidates.filter((candidate) => (
    Number(candidate.lowerBound) >= Number(minAdvantage)
    && (!usesTournament
      || Number(candidate.tournament?.[tournamentGateStatistic])
        >= Number(minTournamentAdvantage))
    && (!usesSurvival
      || Number(candidate.survival?.[survivalGateStatistic]) >= Number(minSurvivalAdvantage))
  ));
  const selected = eligibleCandidates[0] || null;
  return Object.freeze({
    schema: PUBLIC_BELIEF_ROLLOUT_SCHEMA,
    version: 1,
    mode: 'offline-evaluation-only',
    accepted: !!selected,
    reason: selected ? null : utilityMode === 'triple-tournament-survival'
      ? 'rollout-no-positive-triple-paired-lcb'
      : utilityMode === 'dual-tournament'
        ? 'rollout-no-positive-dual-paired-lcb'
      : utilityMode === 'hp-survival'
        ? 'rollout-no-positive-hp-survival-paired-lcb'
        : 'rollout-no-positive-paired-lcb',
    actionKey: selected?.actionKey || baseActionKey,
    baseActionKey,
    clusterCount,
    utilitySamples,
    continuationDecisions,
    evidenceEvents,
    minAdvantage,
    minTournamentAdvantage,
    tournamentGateStatistic,
    minSurvivalAdvantage,
    survivalGateStatistic,
    utilityMode,
    selected: selected || null,
    eligibleCandidates: Object.freeze(eligibleCandidates),
    candidates: Object.freeze(candidates),
    provenance: Object.freeze({
      rootSha256: rootDigest,
      seedNamespace,
      beliefTemperature,
      hiddenStateSource: 'allow-listed-public-belief-sampler-only',
      continuationPolicy: continuationMode === 'fast-public'
        ? 'deterministic-fast-public-hand-strength-pot-odds-v1'
        : continuationOptions.equitySimulationScale === 1
        && continuationOptions.equitySimulationFloor === Config.AI_SIMS
        ? 'frozen-qyz-tag-no-skills'
        : 'frozen-qyz-tag-no-skills-scaled-equity',
      continuationEquityScale: continuationOptions.equitySimulationScale,
      continuationEquityFloor: continuationOptions.equitySimulationFloor,
      continuationMode,
      utilityObjective: utilityMode === 'triple-tournament-survival'
        ? `paired-hp-tournament-and-hand-survival-${survivalGateStatistic}`
        : utilityMode === 'dual-tournament'
        ? tournamentGateStatistic === 'lowerBound'
          ? 'paired-hp-and-risk-adjusted-tournament-value-lcb'
          : 'paired-hp-lcb-and-risk-adjusted-tournament-value-mean'
        : utilityMode === 'hp-survival'
          ? `paired-hp-lcb-and-hand-survival-${survivalGateStatistic}`
          : 'paired-terminal-hand-hp-lcb',
      tournamentRiskWeight: usesTournament
        ? Math.max(0, Number(tournamentRiskWeight) || 0) : null,
      tournamentGateStatistic: usesTournament
        ? tournamentGateStatistic : null,
      survivalGateStatistic: usesSurvival
        ? survivalGateStatistic : null,
    }),
  });
}

export function evaluateScreenedPublicBeliefRolloutActions(target, {
  baseActionKey,
  actionKeys,
  seedNamespace = 'qyj-v67-screened-public-belief-rollout',
  screenClusterCount = 24,
  confirmationClusterCount = 8,
  screenCandidateCount = 1,
  beliefTemperature = 0.5,
  minAdvantage = 1,
  screenUtilityMode = 'hp',
  confirmationUtilityMode = 'hp',
  tournamentValueModel = null,
  tournamentRiskWeight = 0.25,
  minTournamentAdvantage = 0,
  screenTournamentGateStatistic = 'lowerBound',
  confirmationTournamentGateStatistic = 'lowerBound',
  minSurvivalAdvantage = 0,
  survivalGateStatistic = 'lowerBound',
} = {}) {
  if (!Number.isSafeInteger(screenCandidateCount)
    || screenCandidateCount < 1 || screenCandidateCount > 4) {
    throw new RangeError('screen candidate count must be an integer from 1 to 4');
  }
  const screen = evaluatePublicBeliefRolloutActions(target, {
    baseActionKey,
    actionKeys,
    seedNamespace: `${seedNamespace}|screen`,
    clusterCount: screenClusterCount,
    beliefTemperature,
    minAdvantage,
    continuationMode: 'fast-public',
    utilityMode: screenUtilityMode,
    tournamentValueModel,
    tournamentRiskWeight,
    minTournamentAdvantage,
    tournamentGateStatistic: screenTournamentGateStatistic,
    minSurvivalAdvantage,
    survivalGateStatistic,
  });
  if (!screen.accepted || screen.actionKey === baseActionKey) {
    return Object.freeze({
      schema: 'qyj-screened-public-belief-engine-rollout-v1',
      version: 1,
      mode: 'offline-evaluation-only',
      accepted: false,
      reason: `screen:${screen.reason || 'no-action-change'}`,
      actionKey: baseActionKey,
      baseActionKey,
      clusterCount: screenClusterCount,
      utilitySamples: screen.utilitySamples,
      continuationDecisions: screen.continuationDecisions,
      selected: null,
      candidates: screen.candidates,
      screen,
      confirmation: null,
      screenCandidateActionKeys: Object.freeze([]),
      screenUtilityMode,
      screenTournamentGateStatistic,
      confirmationTournamentGateStatistic,
      utilityMode: confirmationUtilityMode,
    });
  }
  const screenCandidateActionKeys = Object.freeze(
    screen.eligibleCandidates.slice(0, screenCandidateCount)
      .map((candidate) => candidate.actionKey),
  );
  const confirmation = evaluatePublicBeliefRolloutActions(target, {
    baseActionKey,
    actionKeys: [baseActionKey, ...screenCandidateActionKeys],
    seedNamespace: `${seedNamespace}|confirmation`,
    clusterCount: confirmationClusterCount,
    beliefTemperature,
    minAdvantage,
    continuationEquityScale: 0.08,
    continuationEquityFloor: 24,
    utilityMode: confirmationUtilityMode,
    tournamentValueModel,
    tournamentRiskWeight,
    minTournamentAdvantage,
    tournamentGateStatistic: confirmationTournamentGateStatistic,
    minSurvivalAdvantage,
    survivalGateStatistic,
  });
  const accepted = confirmation.accepted
    && screenCandidateActionKeys.includes(confirmation.actionKey);
  return Object.freeze({
    schema: 'qyj-screened-public-belief-engine-rollout-v1',
    version: 1,
    mode: 'offline-evaluation-only',
    accepted,
    reason: accepted ? null : `confirmation:${confirmation.reason || 'action-mismatch'}`,
    actionKey: accepted ? confirmation.actionKey : baseActionKey,
    baseActionKey,
    clusterCount: screenClusterCount + confirmationClusterCount,
    utilitySamples: screen.utilitySamples + confirmation.utilitySamples,
    continuationDecisions: screen.continuationDecisions + confirmation.continuationDecisions,
    selected: accepted ? confirmation.selected : null,
    candidates: confirmation.candidates,
    screen,
    confirmation,
    screenCandidateActionKeys,
    screenUtilityMode,
    screenTournamentGateStatistic,
    confirmationTournamentGateStatistic,
    utilityMode: confirmationUtilityMode,
  });
}
