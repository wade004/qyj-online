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

function fastPublicContinuationAction(engine, player) {
  const observation = buildObservation(engine, player);
  const options = engine.getOptions(player);
  const opponents = Math.max(1, observation.activeSeats.length - 1);
  let strength;
  if (observation.street === 'preflop') {
    strength = preflopPercentile(observation.self.hole) - Math.min(0.18, (opponents - 1) * 0.025);
  } else {
    const hand = describe([...observation.self.hole, ...observation.board]);
    const draw = drawProfile(observation.self.hole, observation.board);
    const made = [0, 0.18, 0.43, 0.66, 0.76, 0.83, 0.88, 0.93, 0.97, 0.99, 1][hand.cat] || 0.18;
    strength = Math.min(1, made + draw.potential * 0.18 + draw.nutPotential * 0.08
      - Math.min(0.16, (opponents - 1) * 0.025));
  }
  const pot = Math.max(1, Number(observation.betting.pot) || 1);
  const callAmount = Math.max(0, Number(options.callAmt) || 0);
  const potOdds = callAmount / Math.max(1, pot + callAmount);
  const tier = (key) => options.tiers.find((candidate) => candidate.key === key);
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

function runBeliefHand(
  target, deal, firstActionKey, continuationSeed, continuationOptions, continuationMode,
  tournamentValueModel = null, tournamentRiskWeight = 0,
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
  // A nine-seat hand with repeated full raises can legitimately require more
  // than 256 scheduler/action transitions. The live Engine caps raise tiers;
  // 1024 remains a finite defensive boundary well above every legal hand.
  for (let step = 0; step < 1024 && !resolved(); step++) {
    if (engine.waitingIdx) {
      const player = engine.players[engine.waitingIdx];
      const options = engine.getOptions(player);
      const action = first
        ? actionFromBlueprintKey(firstActionKey, options)
        : continuationMode === 'fast-public'
          ? fastPublicContinuationAction(engine, player)
          : AI.decideWithBlueprint(engine, player, null, continuationOptions);
      first = false;
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
    if (focal.hp <= 0 || focal.alive === false) {
      const rank = 1 + engine.players.slice(1).filter((player) => (
        player.alive === true
        || Number(player.deathOrder) > Number(focal.deathOrder)
      )).length;
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
  if (!['hp', 'dual-tournament', 'hp-survival'].includes(utilityMode)
    || (utilityMode === 'dual-tournament'
      && typeof tournamentValueModel?.predict !== 'function')) {
    throw new RangeError('dual-tournament rollout requires a compiled tournament-value model');
  }
  if (!['lowerBound', 'mean'].includes(survivalGateStatistic)) {
    throw new RangeError('unsupported survival gate statistic');
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
        utilityMode === 'dual-tournament' ? tournamentValueModel : null,
        tournamentRiskWeight,
      );
      values.get(actionKey).hp.push(result.hp);
      values.get(actionKey).survival.push(result.survival);
      if (utilityMode === 'dual-tournament') {
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
    const survival = utilityMode === 'hp-survival'
      ? lowerBound(actionValues.survival.map(
        (value, index) => value - base.survival[index],
      )) : null;
    const tournament = utilityMode === 'dual-tournament'
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
    utilityMode === 'dual-tournament'
      ? (right.tournament?.lowerBound ?? -Infinity)
        - (left.tournament?.lowerBound ?? -Infinity)
      : utilityMode === 'hp-survival'
        ? (right.survival?.[survivalGateStatistic] ?? -Infinity)
          - (left.survival?.[survivalGateStatistic] ?? -Infinity)
      : (right.lowerBound ?? -Infinity) - (left.lowerBound ?? -Infinity)
    || (right.lowerBound ?? -Infinity) - (left.lowerBound ?? -Infinity)
    || (right.mean ?? -Infinity) - (left.mean ?? -Infinity)
    || left.actionKey.localeCompare(right.actionKey)
  ));
  const selected = candidates.find((candidate) => (
    Number(candidate.lowerBound) >= Number(minAdvantage)
    && (utilityMode !== 'dual-tournament'
      || Number(candidate.tournament?.lowerBound) >= Number(minTournamentAdvantage))
    && (utilityMode !== 'hp-survival'
      || Number(candidate.survival?.[survivalGateStatistic]) >= Number(minSurvivalAdvantage))
  ));
  return Object.freeze({
    schema: PUBLIC_BELIEF_ROLLOUT_SCHEMA,
    version: 1,
    mode: 'offline-evaluation-only',
    accepted: !!selected,
    reason: selected ? null : utilityMode === 'dual-tournament'
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
    minSurvivalAdvantage,
    survivalGateStatistic,
    utilityMode,
    selected: selected || null,
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
      utilityObjective: utilityMode === 'dual-tournament'
        ? 'paired-hp-and-risk-adjusted-tournament-value-lcb'
        : utilityMode === 'hp-survival'
          ? `paired-hp-lcb-and-hand-survival-${survivalGateStatistic}`
          : 'paired-terminal-hand-hp-lcb',
      tournamentRiskWeight: utilityMode === 'dual-tournament'
        ? Math.max(0, Number(tournamentRiskWeight) || 0) : null,
      survivalGateStatistic: utilityMode === 'hp-survival'
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
  beliefTemperature = 0.5,
  minAdvantage = 1,
  confirmationUtilityMode = 'hp',
  tournamentValueModel = null,
  tournamentRiskWeight = 0.25,
  minTournamentAdvantage = 0,
  minSurvivalAdvantage = 0,
  survivalGateStatistic = 'lowerBound',
} = {}) {
  const screen = evaluatePublicBeliefRolloutActions(target, {
    baseActionKey,
    actionKeys,
    seedNamespace: `${seedNamespace}|screen`,
    clusterCount: screenClusterCount,
    beliefTemperature,
    minAdvantage,
    continuationMode: 'fast-public',
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
    });
  }
  const confirmation = evaluatePublicBeliefRolloutActions(target, {
    baseActionKey,
    actionKeys: [baseActionKey, screen.actionKey],
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
    minSurvivalAdvantage,
    survivalGateStatistic,
  });
  const accepted = confirmation.accepted && confirmation.actionKey === screen.actionKey;
  return Object.freeze({
    schema: 'qyj-screened-public-belief-engine-rollout-v1',
    version: 1,
    mode: 'offline-evaluation-only',
    accepted,
    reason: accepted ? null : `confirmation:${confirmation.reason || 'action-mismatch'}`,
    actionKey: accepted ? screen.actionKey : baseActionKey,
    baseActionKey,
    clusterCount: screenClusterCount + confirmationClusterCount,
    utilitySamples: screen.utilitySamples + confirmation.utilitySamples,
    continuationDecisions: screen.continuationDecisions + confirmation.continuationDecisions,
    selected: accepted ? confirmation.selected : null,
    candidates: confirmation.candidates,
    screen,
    confirmation,
    utilityMode: confirmationUtilityMode,
  });
}
