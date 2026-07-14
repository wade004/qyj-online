// ============================================================================
// skills.js - 声明式技能注册表与通用解释器
// 技能只能影响信息、能量、预测和小额保险，不修改牌堆、牌面或胜负判定。
// ============================================================================

import * as Config from './config.js';
import * as WinRate from './winrate.js';
import { EXTRA_SKILLS } from './skills-extra.js';

const ACTIVE = 'active';
const PASSIVE = 'passive';

export const SKILLS = Object.freeze({
  zhugeliang_guantian: {
    id: 'zhugeliang_guantian', kind: ACTIVE, name: '观天', cost: 2,
    description: '窥探下一张尚未揭示的天机牌',
    conditionDescription: '令含玄武♠，且仍有天机未揭示',
    timings: ['preflop', 'flop', 'turn'],
    condition: { type: 'ALL', items: [
      { type: 'HOLE_SUIT_CONTAINS', suit: 1 },
      { type: 'BOARD_REMAINING' },
    ] },
    effects: [{ op: 'PEEK_NEXT_BOARD' }],
    presentation: { preset: 'celestial_reveal', tone: '#7fd4ff', sfx: 'judge' },
  },
  zhugeliang_tongse: {
    id: 'zhugeliang_tongse', kind: PASSIVE, name: '同契', trigger: 'DEAL', once: 'round',
    description: '两令同花色时 +1⚡',
    condition: { type: 'HOLE_SAME_SUIT' },
    effects: [{ op: 'ENERGY_CHANGE', amount: 1 }],
    log: '两令同契，获得 1⚡',
    presentation: { preset: 'energy_wisp', tone: '#7fd4ff', sfx: 'draw' },
  },

  diaochan_meihuo: {
    id: 'diaochan_meihuo', kind: ACTIVE, name: '魅惑', cost: 3,
    description: '随机窥视一名对手的一枚暗令',
    conditionDescription: '令含 Q、K 或 A',
    timings: ['preflop', 'flop', 'turn', 'river'],
    condition: { type: 'ALL', items: [
      { type: 'HOLE_RANK_AT_LEAST', rank: 12 },
      { type: 'ACTIVE_OPPONENT_EXISTS' },
    ] },
    effects: [{ op: 'PEEK_RANDOM_HOLE' }],
    presentation: { preset: 'silk_glimpse', tone: '#c58bff', sfx: 'judge' },
  },
  diaochan_biyue: {
    id: 'diaochan_biyue', kind: PASSIVE, name: '闭月', trigger: 'SHOWDOWN_RESULT', once: 'round',
    description: '亮招获胜时 +1⚡',
    condition: { type: 'OWNER_WON_SHOWDOWN' },
    effects: [{ op: 'ENERGY_CHANGE', amount: 1 }],
    log: '闭月夺魁，获得 1⚡',
    presentation: { preset: 'energy_wisp', tone: '#c58bff', sfx: 'recover' },
  },

  hanxin_beishui: {
    id: 'hanxin_beishui', kind: ACTIVE, name: '背水列阵', cost: 1,
    description: '若保持在局至下一阶段，获得 2⚡',
    conditionDescription: '两令花色不同，且当前不是人和阶段',
    timings: ['preflop', 'flop', 'turn'],
    condition: { type: 'HOLE_DIFFERENT_SUIT' },
    effects: [{
      op: 'APPLY_STATUS', status: {
        id: 'reach_next_street', trigger: 'STREET_ADVANCE',
        condition: { type: 'OWNER_ACTIVE' },
        effects: [{ op: 'ENERGY_CHANGE', amount: 2 }],
        log: '背水列阵兑现，获得 2⚡',
      },
    }],
    presentation: { preset: 'battle_standard', tone: '#ff9d76', sfx: 'link' },
  },
  hanxin_duoyi: {
    id: 'hanxin_duoyi', kind: PASSIVE, name: '多益', trigger: 'DEAL', once: 'round',
    description: '两令不成对且花色不同时 +1⚡',
    condition: { type: 'ALL', items: [
      { type: 'HOLE_DIFFERENT_SUIT' },
      { type: 'HOLE_UNPAIRED' },
    ] },
    effects: [{ op: 'ENERGY_CHANGE', amount: 1 }],
    log: '多多益善，获得 1⚡',
    presentation: { preset: 'energy_wisp', tone: '#ff9d76', sfx: 'draw' },
  },

  xiangyu_weizhen: {
    id: 'xiangyu_weizhen', kind: ACTIVE, name: '威震', cost: 1,
    description: '本回合若兵不血刃夺池，返还 1⚡',
    conditionDescription: '令含 J、Q 或 K',
    timings: ['preflop', 'flop', 'turn', 'river'],
    condition: { type: 'HOLE_RANK_RANGE_CONTAINS', min: 11, max: 13 },
    effects: [{
      op: 'APPLY_STATUS', status: {
        id: 'uncontested_refund', trigger: 'UNCONTESTED_WIN',
        condition: { type: 'OWNER_IS_EVENT_WINNER' },
        effects: [{ op: 'ENERGY_CHANGE', amount: 1 }],
        log: '威震兑现，返还 1⚡',
      },
    }],
    presentation: { preset: 'overlord_aura', tone: '#ff6b6b', sfx: 'damage' },
  },
  xiangyu_bawang: {
    id: 'xiangyu_bawang', kind: PASSIVE, name: '霸王', trigger: 'UNCONTESTED_WIN', once: 'round',
    description: '不亮招夺池时 +1⚡',
    condition: { type: 'OWNER_IS_EVENT_WINNER' },
    effects: [{ op: 'ENERGY_CHANGE', amount: 1 }],
    log: '霸王慑敌，获得 1⚡',
    presentation: { preset: 'energy_wisp', tone: '#ff6b6b', sfx: 'damage' },
  },

  lvbuwei_qihuo: {
    id: 'lvbuwei_qihuo', kind: ACTIVE, name: '奇货可居', cost: 1,
    description: '预测本回合以亮招或不亮招结束，猜中获得 2⚡',
    conditionDescription: '两令点数和不小于 20（A=14）',
    timings: ['preflop', 'flop', 'turn', 'river'],
    condition: { type: 'HOLE_RANK_SUM_MIN', value: 20 },
    input: {
      type: 'choice', title: '奇货可居 · 预测本回合结局',
      options: [
        { value: 'showdown', label: '亮招决胜', description: '至少两人进入亮招结算' },
        { value: 'uncontested', label: '兵不血刃', description: '一人迫使其余对手退避' },
      ],
    },
    effects: [{
      op: 'APPLY_STATUS', status: {
        id: 'round_mode_prediction', trigger: 'ROUND_RESOLVED',
        condition: { type: 'EVENT_MODE_MATCHES_SELECTION' },
        effects: [{ op: 'ENERGY_CHANGE', amount: 2 }],
        log: '奇货押中，获得 2⚡',
      },
    }],
    presentation: { preset: 'merchant_seal', tone: '#f6c343', sfx: 'equip2' },
  },
  lvbuwei_shangdao: {
    id: 'lvbuwei_shangdao', kind: PASSIVE, name: '商道', trigger: 'ROUND_END', once: 'round',
    description: '本回合气血净增长时 +1⚡',
    condition: { type: 'OWNER_PROFITABLE' },
    effects: [{ op: 'ENERGY_CHANGE', amount: 1 }],
    log: '经营有道，获得 1⚡',
    presentation: { preset: 'energy_wisp', tone: '#f6c343', sfx: 'equip2' },
  },

  lianpo_jianbi: {
    id: 'lianpo_jianbi', kind: ACTIVE, name: '坚壁', cost: 2,
    description: '本回合亮招落败时返还投入的 10%，最多 50 气血',
    conditionDescription: '令含朱雀♥',
    timings: ['preflop', 'flop', 'turn', 'river'],
    condition: { type: 'HOLE_SUIT_CONTAINS', suit: 2 },
    effects: [{
      op: 'APPLY_STATUS', status: {
        id: 'showdown_insurance', trigger: 'SHOWDOWN_RESULT',
        condition: { type: 'OWNER_LOST_SHOWDOWN' },
        effects: [{
          op: 'HP_REBATE', ratio: Config.SKILL_REBATE_RATIO, cap: Config.SKILL_REBATE_CAP,
        }],
        log: '坚壁生效，返还 {amount} 气血',
      },
    }],
    presentation: { preset: 'shield_wall', tone: '#54d97c', sfx: 'equip1' },
  },
  lianpo_laolian: {
    id: 'lianpo_laolian', kind: PASSIVE, name: '老练', trigger: 'SHOWDOWN_RESULT', once: 'round',
    description: '亮招落败时 +1⚡',
    condition: { type: 'OWNER_LOST_SHOWDOWN' },
    effects: [{ op: 'ENERGY_CHANGE', amount: 1 }],
    log: '老将弥坚，获得 1⚡',
    presentation: { preset: 'energy_wisp', tone: '#54d97c', sfx: 'recover' },
  },
  ...EXTRA_SKILLS,
});

export function getSkill(id) {
  return SKILLS[id] || null;
}

export function getActiveSkill(hero) {
  return hero ? getSkill(hero.skillIds.active) : null;
}

export function getPassiveSkill(hero) {
  return hero ? getSkill(hero.skillIds.passive) : null;
}

function hasHole(player) {
  return !!player && Array.isArray(player.hole) && player.hole.length >= 2;
}

function isRedSuit(suit) {
  return suit === 2 || suit === 3;
}

function isTargetBlocked(player) {
  return (player.skillStatuses || []).some((status) => status.modifier === 'BLOCK_TARGETING');
}

function isCopyablePassiveTarget(player) {
  const passive = getPassiveSkill(player.hero);
  return !!passive && passive.copyable !== false;
}

function targetCandidates(engine, player, skill) {
  const copiesPassive = skill.effects.some((effect) => effect.op === 'COPY_TARGET_PASSIVE');
  return engine.activePlayers().filter((other) =>
    other.idx !== player.idx
    && !isTargetBlocked(other)
    && (!copiesPassive || isCopyablePassiveTarget(other)));
}

function dynamicSkillCost(player, skill) {
  const modifier = (player.skillStatuses || [])
    .filter((status) => status.modifier === 'SKILL_COST')
    .reduce((sum, status) => sum + (status.amount || 0), 0);
  return Math.max(1, skill.cost + modifier);
}

export function checkSkillCondition(condition, context) {
  if (!condition) return true;
  const { engine, player, payload, status } = context;
  const hole = hasHole(player) ? player.hole : [];
  const [a, b] = hole;

  switch (condition.type) {
    case 'ALL':
      return condition.items.every((item) => checkSkillCondition(item, context));
    case 'ANY':
      return condition.items.some((item) => checkSkillCondition(item, context));
    case 'HOLE_SUIT_CONTAINS':
      return hasHole(player) && (a.suit === condition.suit || b.suit === condition.suit);
    case 'HOLE_SAME_SUIT':
      return hasHole(player) && a.suit === b.suit;
    case 'HOLE_DIFFERENT_SUIT':
      return hasHole(player) && a.suit !== b.suit;
    case 'HOLE_UNPAIRED':
      return hasHole(player) && a.rank !== b.rank;
    case 'HOLE_RANK_AT_LEAST':
      return hasHole(player) && (a.rank >= condition.rank || b.rank >= condition.rank);
    case 'HOLE_RANK_RANGE_CONTAINS':
      return hasHole(player) && [a, b].some((card) => card.rank >= condition.min && card.rank <= condition.max);
    case 'HOLE_RANK_SUM_MIN':
      return hasHole(player) && a.rank + b.rank >= condition.value;
    case 'HOLE_ONE_RED_ONE_BLACK':
      return hasHole(player) && isRedSuit(a.suit) !== isRedSuit(b.suit);
    case 'HOLE_SAME_COLOR':
      return hasHole(player) && isRedSuit(a.suit) === isRedSuit(b.suit);
    case 'HOLE_RANK_DIFF_MAX':
      return hasHole(player) && Math.abs(a.rank - b.rank) <= condition.value;
    case 'HOLE_RANK_SUM_PARITY':
      return hasHole(player) && ((a.rank + b.rank) % 2 === 0 ? 'even' : 'odd') === condition.value;
    case 'BOARD_REMAINING':
      return !!engine && engine.revealed < 5;
    case 'ACTIVE_OPPONENT_EXISTS':
      return !!engine && engine.activePlayers().some((other) => other.idx !== player.idx);
    case 'TARGETABLE_OPPONENT_EXISTS':
      return !!engine && targetCandidates(engine, player, getActiveSkill(player.hero)).length > 0;
    case 'COPYABLE_PASSIVE_TARGET_EXISTS':
      return !!engine && targetCandidates(engine, player, getActiveSkill(player.hero)).length > 0;
    case 'OWNER_ACTIVE':
      return player.alive && !player.folded;
    case 'OWNER_IS_EVENT_WINNER':
      return !!payload && payload.winner && payload.winner.idx === player.idx;
    case 'OWNER_WON_SHOWDOWN':
      return !!payload && payload.winnerIds instanceof Set && payload.winnerIds.has(player.idx);
    case 'OWNER_LOST_SHOWDOWN':
      return !!payload && payload.entrantIds instanceof Set && payload.entrantIds.has(player.idx)
        && !payload.winnerIds.has(player.idx);
    case 'OWNER_PROFITABLE':
      return player.hp > player.roundStartHp;
    case 'EVENT_MODE_MATCHES_SELECTION':
      return !!payload && !!status && payload.mode === status.selection.choice;
    case 'OWNER_IS_EVENT_TARGET':
      return !!payload && payload.target && payload.target.idx === player.idx
        && payload.source && payload.source.idx !== player.idx;
    case 'EVENT_ACTOR_IS_STATUS_TARGET':
      return !!payload && !!status && payload.actor
        && payload.actor.idx === (status.targetIdx || player.idx);
    case 'EVENT_ACTION_MATCHES_SELECTION':
      return !!payload && !!status && payload.group === status.selection.choice;
    case 'EVENT_BOARD_COLOR_MATCHES_SELECTION':
      return !!payload && !!payload.firstCard && !!status
        && (isRedSuit(payload.firstCard.suit) ? 'red' : 'black') === status.selection.choice;
    case 'EVENT_SHOWDOWN_TIER_MATCHES_SELECTION': {
      if (!payload || !status || !payload.entrantIds.has(player.idx) || !player.showdownInfo) return false;
      const tier = player.showdownInfo.cat <= 2 ? 'low' : 'high';
      return tier === status.selection.choice;
    }
    case 'ROUND_FLAG':
      return !!player.skillData?.flags?.[condition.key];
    case 'EVENT_STREET_NO_RAISE':
      return !!payload && !payload.hadRaise;
    case 'OWNER_HAND_TIER_CHANGED':
      return !!payload && payload.changedIds instanceof Set && payload.changedIds.has(player.idx);
    case 'OWNER_SHOWDOWN_WITHOUT_RAISE':
      return !!payload && payload.entrantIds.has(player.idx) && !player.skillData?.raisedThisRound;
    case 'OWNER_ATTACKED_CROWDED':
      return !!payload && payload.actor && payload.actor.idx === player.idx
        && payload.group === 'attack' && payload.activeCount - 1 >= condition.opponents;
    case 'OWNER_SURVIVED_ALLIN_SHOWDOWN':
      return !!payload && payload.entrantIds.has(player.idx) && player.allIn && player.hp > 0;
    case 'COPIED_PASSIVE_MISSED':
      return (player.skillData?.copiedPassiveIds?.length || 0) > 0
        && player.skillData.copiedPassiveIds.every((id) => !player.passiveUsed[id]);
    case 'REVEALED_SUIT_MATCHES_HOLE':
      return hasHole(player) && !!payload && payload.cards.some((card) =>
        card.suit === a.suit || card.suit === b.suit);
    case 'REVEALED_CARD_UNUSED': {
      const card = player.skillData?.revealedCard;
      if (!card || !payload || !payload.entrantIds.has(player.idx) || !player.showdownInfo) return false;
      return !player.showdownInfo.best5.some((best) => best.rank === card.rank && best.suit === card.suit);
    }
    default:
      return false;
  }
}

export function getSkillAvailability(engine, player) {
  const skill = getActiveSkill(player && player.hero);
  if (!skill) return { ok: false, reason: '没有可发动的主动技能', skill: null };
  const cost = player ? dynamicSkillCost(player, skill) : skill.cost;
  if (!player || engine.gameOver || !player.alive) return { ok: false, reason: '已阵亡', skill, cost };
  if (player.folded) return { ok: false, reason: '已退避', skill, cost };
  if (player.skillUsed) return { ok: false, reason: '本回合已发动', skill, cost };
  if (engine.street === 'idle' || !skill.timings.includes(engine.street)) {
    return { ok: false, reason: '当前阶段不能发动', skill, cost };
  }
  if (Number(engine.actingIdx) !== Number(player.idx)) {
    return { ok: false, reason: '仅可在轮到你行动时发动', skill, cost };
  }
  if (player.energy < cost) {
    return { ok: false, reason: `能量不足（${player.energy}/${cost}⚡）`, skill, cost };
  }
  if (!checkSkillCondition(skill.condition, { engine, player })) {
    return { ok: false, reason: `条件未满足：${skill.conditionDescription}`, skill, cost };
  }
  return { ok: true, reason: '条件已满足，可以发动', skill, cost };
}

function inputFields(skill) {
  if (!skill.input) return [];
  if (skill.input.fields) return skill.input.fields;
  if (skill.input.type === 'choice') {
    return [{ key: 'choice', type: 'choice', label: '选择一项', options: skill.input.options }];
  }
  return [];
}

function resolvedInputFields(engine, player, skill) {
  return inputFields(skill).map((field) => {
    if (field.type !== 'target') return field;
    return {
      ...field,
      options: targetCandidates(engine, player, skill).map((target) => ({
        value: target.idx,
        label: `${target.idx}号位 · ${target.hero.name}`,
        description: target.hero.type,
      })),
    };
  });
}

export function getSkillInput(engine, player) {
  const skill = getActiveSkill(player && player.hero);
  if (!skill || !skill.input) return null;
  return { title: skill.input.title, fields: resolvedInputFields(engine, player, skill) };
}

function resolveSelection(engine, skill, player, selection) {
  if (!skill.input) return {};
  const resolved = {};
  for (const field of resolvedInputFields(engine, player, skill)) {
    const options = field.options || [];
    const requested = selection && selection[field.key];
    if (options.some((option) => option.value === requested)) {
      resolved[field.key] = requested;
    } else if (!player.isHuman && options.length) {
      const rng = typeof engine.rng === 'function' ? engine.rng : Math.random;
      resolved[field.key] = options[Math.floor(rng() * options.length)].value;
    } else {
      return undefined;
    }
  }
  return resolved;
}

function changeEnergy(engine, player, amount) {
  player.energy = Math.max(0, player.energy + amount);
  engine.emit('onEnergyChange', player.idx);
}

function applyEffect(engine, player, effect, context) {
  switch (effect.op) {
    case 'ENERGY_CHANGE':
      changeEnergy(engine, player, effect.amount);
      return { amount: effect.amount };
    case 'HP_REBATE': {
      if (player.betRound <= 0) return { amount: 0 };
      const amount = Math.min(effect.cap, Config.roundAmount(player.betRound * effect.ratio));
      if (amount > 0) {
        player.hp += amount;
        engine.emit('onHpChange', player.idx);
      }
      return { amount };
    }
    case 'PEEK_NEXT_BOARD': {
      const card = engine.board[engine.revealed];
      if (card) {
        engine.emit('onSkillResult', player.idx, {
          kind: 'peek_board', card, slot: engine.revealed + 1,
        });
      }
      return { card };
    }
    case 'PEEK_RANDOM_HOLE': {
      const targets = engine.activePlayers().filter((other) => other.idx !== player.idx);
      if (!targets.length) return null;
      const rng = typeof engine.rng === 'function' ? engine.rng : Math.random;
      const target = targets[Math.floor(rng() * targets.length)];
      const cardIdx = 1 + Math.floor(rng() * 2);
      const card = target.hole[cardIdx - 1];
      engine.emit('onSkillResult', player.idx, {
        kind: 'peek_hole', targetIdx: target.idx, cardIdx, card,
      });
      return { targetIdx: target.idx, cardIdx, card };
    }
    case 'REVEAL_SELF_HOLE': {
      const cardIdx = Number(context.selection[effect.selectionKey]);
      const card = player.hole[cardIdx - 1];
      if (!card) return null;
      player.skillData.revealedCard = card;
      engine.emit('onSkillPublicResult', player.idx, { kind: 'reveal_self', cardIdx, card });
      return { cardIdx, card };
    }
    case 'PEEK_NEXT_BOARD_SUIT': {
      const card = engine.board[engine.revealed];
      if (card) engine.emit('onSkillResult', player.idx, { kind: 'peek_board_suit', suit: card.suit });
      return { suit: card && card.suit };
    }
    case 'PEEK_STRENGTH_BAND': {
      const target = engine.players[context.selection.targetIdx];
      if (!target) return null;
      const opponents = Math.max(1, engine.activePlayers().length - 1);
      const value = WinRate.estimate(target.hole, engine.revealedBoard(), opponents, Config.AI_SIMS);
      const band = value < 0.3 ? 'low' : value < 0.6 ? 'medium' : 'high';
      engine.emit('onSkillResult', player.idx, {
        kind: 'strength_band', targetIdx: target.idx, band,
      });
      return { targetIdx: target.idx, band };
    }
    case 'SET_ROUND_FLAG':
      player.skillData.flags[effect.key] = true;
      return { key: effect.key };
    case 'APPLY_ACTION_PREDICTION': {
      const targetIdx = effect.target === 'self' ? player.idx : context.selection.targetIdx;
      player.skillStatuses.push({
        id: 'action_prediction', trigger: 'ACTION',
        consumeCondition: { type: 'EVENT_ACTOR_IS_STATUS_TARGET' },
        condition: { type: 'EVENT_ACTION_MATCHES_SELECTION' },
        effects: [
          { op: 'SET_ROUND_FLAG', key: 'prediction_success' },
          { op: 'ENERGY_CHANGE', amount: effect.reward },
        ],
        log: '行动预测命中，获得 {amount}⚡',
        sourceSkillId: context.skill.id,
        selection: context.selection,
        targetIdx,
      });
      engine.emit('onSkillResult', player.idx, {
        kind: 'prediction', choice: context.selection.choice, targetIdx,
      });
      return { targetIdx };
    }
    case 'APPLY_BOARD_COLOR_PREDICTION':
      player.skillStatuses.push({
        id: 'board_color_prediction', trigger: 'BOARD_REVEALED',
        condition: { type: 'EVENT_BOARD_COLOR_MATCHES_SELECTION' },
        effects: [{ op: 'ENERGY_CHANGE', amount: effect.reward }],
        log: '牌色预测命中，获得 {amount}⚡',
        sourceSkillId: context.skill.id,
        selection: context.selection,
      });
      engine.emit('onSkillResult', player.idx, { kind: 'prediction', choice: context.selection.choice });
      return { choice: context.selection.choice };
    case 'APPLY_SHOWDOWN_TIER_PREDICTION':
      player.skillStatuses.push({
        id: 'showdown_tier_prediction', trigger: 'SHOWDOWN_RESULT',
        condition: { type: 'EVENT_SHOWDOWN_TIER_MATCHES_SELECTION' },
        effects: [{ op: 'ENERGY_CHANGE', amount: effect.reward }],
        log: '牌型预测命中，获得 {amount}⚡',
        sourceSkillId: context.skill.id,
        selection: context.selection,
      });
      engine.emit('onSkillResult', player.idx, { kind: 'prediction', choice: context.selection.choice });
      return { choice: context.selection.choice };
    case 'APPLY_STATUS_TO_TARGET': {
      const target = engine.players[context.selection.targetIdx];
      if (!target) return null;
      target.skillStatuses.push({ ...effect.status, sourceSkillId: context.skill.id });
      return { targetIdx: target.idx };
    }
    case 'COPY_TARGET_PASSIVE': {
      const target = engine.players[context.selection.targetIdx];
      const passive = target && getPassiveSkill(target.hero);
      if (!passive || passive.copyable === false) return null;
      if (!player.skillData.copiedPassiveIds.includes(passive.id)) {
        player.skillData.copiedPassiveIds.push(passive.id);
      }
      engine.emit('onSkillResult', player.idx, {
        kind: 'copy_passive', targetIdx: target.idx, skillName: passive.name,
      });
      return { targetIdx: target.idx, skillId: passive.id };
    }
    case 'APPLY_STATUS': {
      const status = {
        ...effect.status,
        effects: (effect.status.effects || []).map((item) => ({ ...item })),
        sourceSkillId: context.skill.id,
        selection: context.selection,
      };
      player.skillStatuses.push(status);
      if (context.selection && context.selection.choice) {
        engine.emit('onSkillResult', player.idx, {
          kind: 'prediction', choice: context.selection.choice,
        });
      }
      return { status };
    }
    default:
      return null;
  }
}

function runEffects(engine, player, effects, context) {
  let combined = null;
  for (const effect of effects) {
    const result = applyEffect(engine, player, effect, context);
    if (!result || typeof result !== 'object') continue;
    combined ||= {};
    if (result.amount != null) combined.amount = (combined.amount || 0) + result.amount;
    Object.assign(combined, result, combined.amount != null ? { amount: combined.amount } : {});
  }
  return combined;
}

function formatLog(template, result) {
  if (!template) return '';
  return template.replace('{amount}', String(result && result.amount ? result.amount : 0));
}

export function executeActiveSkill(engine, player, selection = null) {
  const availability = getSkillAvailability(engine, player);
  if (!availability.ok) return false;
  const skill = availability.skill;
  const resolvedSelection = resolveSelection(engine, skill, player, selection);
  if (skill.input && resolvedSelection === undefined) return false;

  player.energy -= availability.cost;
  player.skillUsed = true;
  player.skillStatuses = player.skillStatuses.filter((status) => status.consumeOn !== 'SKILL_USED');
  engine.emit('onEnergyChange', player.idx);
  engine.emit('onSkill', player.idx, skill.id, skill.name, skill.presentation);
  engine.emit('onQuote', player.idx, player.hero.lines.skill);
  engine.log(`${player.hero.name} 发动【${skill.name}】！`, 'skill');
  if (resolvedSelection.targetIdx != null) {
    dispatchSkillEvent(engine, 'SKILL_TARGETED', {
      source: player, target: engine.players[resolvedSelection.targetIdx], skill,
    });
  }
  runEffects(engine, player, skill.effects, { skill, selection: resolvedSelection });
  return true;
}

export function dispatchSkillEvent(engine, eventName, payload = {}) {
  for (const player of engine.players.slice(1)) {
    if (!player) continue;

    const remainingStatuses = [];
    for (const status of player.skillStatuses) {
      if (status.trigger !== eventName) {
        if (status.expiresOn !== eventName) remainingStatuses.push(status);
        continue;
      }
      const consume = !status.consumeCondition
        || checkSkillCondition(status.consumeCondition, { engine, player, payload, status });
      if (!consume) {
        remainingStatuses.push(status);
        continue;
      }
      if (checkSkillCondition(status.condition, { engine, player, payload, status })) {
        const skill = getSkill(status.sourceSkillId);
        const result = runEffects(engine, player, status.effects, {
          skill, selection: status.selection, payload, status,
        });
        const text = formatLog(status.log, result);
        if (text) engine.log(`${player.hero.name}【${skill.name}】${text}`, 'skill');
        engine.emit('onSkillEffect', player.idx, skill.id, skill.name, skill.presentation);
      }
    }
    player.skillStatuses = remainingStatuses;

    const passiveIds = [
      ...(player.skillData?.copiedPassiveIds || []),
      getPassiveSkill(player.hero) && getPassiveSkill(player.hero).id,
    ].filter(Boolean);
    for (const passiveId of [...new Set(passiveIds)]) {
      const passive = getSkill(passiveId);
      if (!passive || passive.trigger !== eventName || !player.alive) continue;
      if (passive.once === 'round' && player.passiveUsed[passive.id]) continue;
      if (!checkSkillCondition(passive.condition, { engine, player, payload })) continue;

      runEffects(engine, player, passive.effects, { skill: passive, payload });
      if (passive.once === 'round') player.passiveUsed[passive.id] = true;
      engine.log(`${player.hero.name}【${passive.name}】${passive.log}`, 'skill');
      engine.emit('onPassive', player.idx, passive.id, passive.name, passive.presentation);
    }
  }
}

export function resetRoundSkillState(player) {
  player.skillUsed = false;
  player.skillStatuses = [];
  player.passiveUsed = Object.create(null);
  player.skillData = {
    flags: Object.create(null),
    copiedPassiveIds: [],
    revealedCard: null,
    raisedThisRound: false,
  };
}
