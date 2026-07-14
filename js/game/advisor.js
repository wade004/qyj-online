// GTO-inspired decision advisor. It reads public state and never executes an action.

import * as Config from './config.js';
import * as WinRate from './winrate.js';
import { describe } from './handeval.js';
import { tablePosition } from './ai-policy.js';
import {
  drawProfile,
  effectiveStack,
  positionAdjustment,
  preflopStrength,
} from './ai.js';

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

const RANK_TEXT = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T' };

function preflopHandText(hole) {
  const sorted = [...hole].sort((a, b) => b.rank - a.rank);
  const high = RANK_TEXT[sorted[0].rank] || String(sorted[0].rank);
  const low = RANK_TEXT[sorted[1].rank] || String(sorted[1].rank);
  if (sorted[0].rank === sorted[1].rank) return `${high}${low}`;
  return `${high}${low}${sorted[0].suit === sorted[1].suit ? 's' : 'o'}`;
}

function positionContext(engine, player) {
  const activeSeats = engine.players.slice(1)
    .filter((candidate) => candidate.alive)
    .map((candidate) => candidate.idx);
  const position = tablePosition(player.idx, engine.dealerIdx, activeSeats);
  return {
    name: position.name === 'UNKNOWN' ? '未知位置' : position.name,
    playersBehind: position.playersBehind,
  };
}

function deterministicRoll(engine, player, tag) {
  const cards = [...player.hole, ...engine.revealedBoard()]
    .map((card) => `${card.rank}-${card.suit}`).join('|');
  const source = [
    engine.round, engine.street, player.idx, engine.currentBet,
    player.betStreet, engine.streetRaiseCount || 0, cards, tag,
  ].join(':');
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

function tierAction(opts, preference) {
  if (!opts.tiers.length) return null;
  const index = preference === 'small' ? 0
    : preference === 'large' ? opts.tiers.length - 1
      : Math.min(1, opts.tiers.length - 1);
  return { type: 'raise', tier: opts.tiers[index] };
}

function passiveAction(opts) {
  return opts.canCheck ? { type: 'check' } : { type: 'call' };
}

function actionText(action, opts) {
  if (!action) return '';
  if (action.type === 'fold') return '退避';
  if (action.type === 'check') return '静观';
  if (action.type === 'call') return `应战 ${opts.callAmt}`;
  if (action.type === 'allin') return `决死 ${opts.allinAmt}`;
  if (action.type === 'raise') return `${action.tier.name} ${action.tier.cost}`;
  return action.type;
}

function toneFor(action) {
  if (!action) return 'neutral';
  if (action.type === 'fold') return 'fold';
  if (action.type === 'raise' || action.type === 'allin') return 'attack';
  return 'defend';
}

function actionKey(action) {
  return action ? `${action.type}:${action.tier?.key || ''}` : '';
}

function alternateReason(action) {
  if (!action) return '';
  if (action.type === 'fold') return '收紧边缘范围，减少反向隐含赔率风险';
  if (action.type === 'call' || action.type === 'check') return '保留摊牌价值并控制底池规模';
  if (action.type === 'raise') return '作为价值牌与诈唬牌的低频平衡分支';
  if (action.type === 'allin') return '仅在低SPR或极化范围中保留的低频分支';
  return '用于降低策略可预测性的混合分支';
}

function buildSuggestions(action, alternative, opts, reasons, mixed, confidence) {
  const actions = [action, alternative].filter(Boolean);
  if (mixed && action?.type === 'raise' && opts.tiers.length > 1) {
    const extra = opts.tiers
      .map((tier) => ({ type: 'raise', tier }))
      .find((candidate) => !actions.some((item) => actionKey(item) === actionKey(candidate)));
    if (extra) actions.push(extra);
  }
  const unique = actions
    .filter((item, index) => actions.findIndex((other) => actionKey(other) === actionKey(item)) === index)
    .slice(0, 3);
  const frequencies = unique.length === 1 ? [100]
    : unique.length === 2
      ? mixed ? (confidence === 'low' ? [60, 40] : [70, 30]) : [85, 15]
      : confidence === 'low' ? [55, 35, 10] : [60, 30, 10];
  return unique.map((item, index) => ({
    action: item,
    label: actionText(item, opts),
    frequency: frequencies[index],
    reason: index === 0 ? reasons.join('；') : alternateReason(item),
  }));
}

function result(action, alternative, opts, context, reasons, mixed = false, confidence = 'medium') {
  const suggestions = buildSuggestions(action, alternative, opts, reasons, mixed, confidence);
  return {
    action,
    recommendation: actionText(action, opts),
    alternative: actionText(alternative, opts),
    reason: reasons.join('；'),
    metrics: context.metrics,
    equity: context.equity,
    mixed,
    confidence,
    tone: toneFor(action),
    suggestions,
  };
}

function analyzePreflop(engine, player, opts, context) {
  const strength = preflopStrength(player.hole);
  const positional = positionAdjustment(engine, player);
  const adjusted = clamp(strength + positional);
  const blinds = Config.getBlinds(engine.round);
  const stackBb = effectiveStack(engine, player) / Math.max(1, blinds.bb);
  const potBb = engine.totalPot() / Math.max(1, blinds.bb);
  const callBb = opts.callAmt / Math.max(1, blinds.bb);
  const handText = preflopHandText(player.hole);
  const raised = (engine.streetRaiseCount || 0) > 0 || engine.currentBet > blinds.bb;
  const limperCount = raised ? 0 : Math.max(0, Math.round(
    (engine.totalPot() - blinds.sb - blinds.bb) / Math.max(1, blinds.bb),
  ));
  const entryRangeText = limperCount > 0 ? '隔离/跟入范围' : '首入范围';
  const playersBehind = Number.isInteger(context.playersBehind)
    ? context.playersBehind
    : Math.max(0, context.numOpponents - 1);
  const premium = adjusted >= 0.84;
  const playable = adjusted >= 0.66;
  const marginal = adjusted >= 0.58;
  const priceText = opts.canCheck ? '可静观'
    : raised
      ? `需跟 ${callBb.toFixed(1)}BB（赔率 ${Math.round(context.potOdds * 100)}%）`
      : `跟入 ${callBb.toFixed(1)}BB`;
  const spotText = raised ? '已加注'
    : limperCount > 0 ? `${limperCount}人跛入` : '未加注';
  context.metrics = `${context.position} · 底池 ${potBb.toFixed(1)}BB · 有效筹码 ${stackBb.toFixed(1)}BB · ${priceText} · ${spotText} · 手牌 ${handText}`;

  if (!raised) {
    if (opts.canAllIn && stackBb <= 10 && adjusted >= 0.60) {
      return result(
        { type: 'allin' }, tierAction(opts, 'small'), opts, context,
        [`有效筹码仅 ${stackBb.toFixed(1)}BB`, '低筹码时应压缩跟注范围并优先直接实现牌力'],
        false, 'high',
      );
    }
    if (premium && opts.tiers.length) {
      const action = tierAction(opts, adjusted >= 0.93 ? 'medium' : 'small');
      return result(
        action, null, opts, context,
        [`${handText} 处于 ${context.position} 的强价值${entryRangeText}`, limperCount > 0 ? '主动隔离跛入者，避免让身后玩家低价进入多人池' : '主动建池并保持价值牌与轻质开池的同尺度'],
        false, 'high',
      );
    }
    if (playable && opts.tiers.length) {
      const mixed = adjusted < 0.71;
      const raise = tierAction(opts, 'small');
      return result(
        raise, mixed ? (context.position === 'SB' ? { type: 'call' } : { type: 'fold' }) : null,
        opts, context,
        [`${handText} 位于 ${context.position} 的${mixed ? '边界' : '主要'}${entryRangeText}`, limperCount > 0 ? '优先加注隔离已有跛入者，不用被动跟入替代主动范围' : '未加注底池优先采用开池加注，不用跛入代替正常开池'],
        mixed, mixed ? 'medium' : 'high',
      );
    }
    if (opts.canCheck) {
      return result(
        { type: 'check' }, null, opts, context,
        ['可以免费看牌', '边缘范围没有必要额外扩大底池'],
        false, 'high',
      );
    }
    if (marginal && context.position === 'SB') {
      return result(
        { type: 'call' }, { type: 'fold' }, opts, context,
        [`${handText} 是小盲位的边界牌`, '小盲位可保留少量补齐与弃牌的混合频率'],
        true, 'low',
      );
    }
    return result(
      { type: 'fold' }, null, opts, context,
      [`${handText} 低于 ${context.position} 的主要${entryRangeText}`, limperCount > 0
        ? `当前是 ${potBb.toFixed(1)}BB 的${limperCount}人跛入底池，边缘牌跟入后容易形成多人池并被更强范围压制`
        : `当前只是 ${potBb.toFixed(1)}BB 的盲注底池；跟入属于首入跛入，身后仍有 ${playersBehind} 人可以加注或继续`],
      false, 'high',
    );
  }

  const pressure = Math.max(0, (engine.streetRaiseCount || 1) - 1) * 0.04;
  const threeBetThreshold = 0.82 + pressure;
  const callThreshold = 0.64 + pressure;
  if (opts.canAllIn && stackBb <= 14 && adjusted >= 0.68 + pressure) {
    return result(
      { type: 'allin' }, tierAction(opts, 'large'), opts, context,
      [`面对已有加注且有效筹码仅 ${stackBb.toFixed(1)}BB`, '强范围直接决死可避免留下尴尬SPR'],
      false, 'high',
    );
  }
  if (adjusted >= threeBetThreshold && opts.tiers.length) {
    const size = ['SB', 'BB', 'UTG'].includes(context.position) ? 'large' : 'medium';
    return result(
      tierAction(opts, size), { type: 'call' }, opts, context,
      ['手牌进入强价值再加注范围', `${context.position} ${size === 'large' ? '处于不利位置，用更大尺度降低SPR' : '有位置优势，中等尺度足够'}`],
      adjusted < threeBetThreshold + 0.04, adjusted > 0.90 ? 'high' : 'medium',
    );
  }
  const pair = player.hole[0].rank === player.hole[1].rank;
  const setMine = pair && opts.toCall <= effectiveStack(engine, player) * 0.05;
  if ((adjusted >= callThreshold || setMine) && context.potOdds <= 0.38) {
    return result(
      { type: 'call' }, { type: 'fold' }, opts, context,
      [`需要胜率约 ${Math.round(context.potOdds * 100)}%`, setMine ? '小对子投入占有效筹码较低，保留成三条的隐含赔率' : '当前牌仍在应战范围内'],
      adjusted < callThreshold + 0.04, 'medium',
    );
  }
  return result(
    { type: 'fold' }, adjusted >= callThreshold - 0.04 ? { type: 'call' } : null, opts, context,
    ['对手加注后范围收紧', '当前牌力与位置不足以支撑继续投入'],
    adjusted >= callThreshold - 0.04, adjusted < callThreshold - 0.08 ? 'high' : 'medium',
  );
}

function analyzePostflop(engine, player, opts, context) {
  const board = engine.revealedBoard();
  const hand = describe([...player.hole, ...board]);
  const draws = drawProfile(player.hole, board);
  const numOpp = context.numOpponents;
  const positional = positionAdjustment(engine, player);
  const realized = clamp(context.equity + positional * 0.06 - Math.max(0, numOpp - 1) * 0.01);
  const riskPremium = Math.max(0, numOpp - 1) * 0.025 + (positional < 0 ? 0.015 : 0);
  const valueThreshold = clamp(0.56 + Math.max(0, numOpp - 1) * 0.04, 0.56, 0.72);
  const strongThreshold = clamp(0.75 + Math.max(0, numOpp - 1) * 0.035, 0.75, 0.88);
  const strongMadeHand = hand.cat >= 7 || (hand.cat >= 5 && context.equity >= 0.62);
  const roll = deterministicRoll(engine, player, `postflop-${hand.cat}`);
  const texture = draws.wetness >= 0.56 ? '湿润' : draws.wetness <= 0.25 ? '干燥' : '中性';
  const drawText = [draws.flushDraw && '同花听牌', draws.straightDraw && '顺子听牌']
    .filter(Boolean).join('+');
  context.metrics = `${context.position} · 底池 ${context.potBb.toFixed(1)}BB · 有效筹码 ${context.stackBb.toFixed(1)}BB · ${numOpp + 1}人池 · SPR ${context.spr.toFixed(1)} · ${texture}牌面`;

  if (opts.toCall > 0) {
    const last = engine.lastAggressiveWager;
    const pressure = last?.potBefore > 0 ? last.amount / last.potBefore : 0;
    if (realized >= strongThreshold || strongMadeHand) {
      if (opts.canAllIn && context.spr <= 1.05) {
        return result(
          { type: 'allin' }, tierAction(opts, 'large'), opts, context,
          [`估算权益 ${Math.round(context.equity * 100)}% 明显高于继续门槛`, `SPR ${context.spr.toFixed(1)} 已进入强牌可直接投入全部筹码的区间`],
          false, 'high',
        );
      }
      return result(
        tierAction(opts, texture === '湿润' ? 'large' : 'medium') || { type: 'call' },
        { type: 'call' }, opts, context,
        [`${hand.poker}属于当前的强价值区间`, texture === '湿润' ? '湿润牌面需要更大尺度收取听牌价格' : '中等尺度可同时保留更差跟注和保护范围'],
        false, 'high',
      );
    }
    const strongDraw = !['river'].includes(engine.street) && draws.potential >= 0.75;
    if (strongDraw && realized >= context.potOdds - 0.04 && opts.tiers.length
      && numOpp <= 2 && roll < (positional > 0 ? 0.52 : 0.34)) {
      return result(
        tierAction(opts, texture === '湿润' ? 'large' : 'medium'), { type: 'call' }, opts, context,
        [`${drawText || '组合听牌'}拥有可观改善空间`, '以低频半诈唬加注，同时利用弃牌率和成牌权益'],
        true, 'medium',
      );
    }
    if (realized >= context.potOdds + riskPremium) {
      const margin = realized - context.potOdds - riskPremium;
      return result(
        { type: 'call' }, margin < 0.04 ? { type: 'fold' } : null, opts, context,
        [`估算权益 ${Math.round(context.equity * 100)}%，底池赔率需要约 ${Math.round(context.potOdds * 100)}%`, numOpp > 1 ? '多人池已加入风险溢价，仍保持正权益继续' : '跟注可保留对手诈唬与较差价值范围'],
        margin < 0.04, margin >= 0.10 ? 'high' : 'medium',
      );
    }
    if (strongDraw && context.spr >= 2.2 && realized + 0.06 >= context.potOdds + riskPremium) {
      return result(
        { type: 'call' }, { type: 'fold' }, opts, context,
        [`${drawText || '强听牌'}接近直接底池赔率`, '较高SPR保留了成牌后的隐含赔率，但属于边界继续'],
        true, 'low',
      );
    }
    return result(
      { type: 'fold' }, realized + 0.04 >= context.potOdds + riskPremium ? { type: 'call' } : null,
      opts, context,
      [`估算权益 ${Math.round(context.equity * 100)}% 低于风险调整后的继续门槛 ${Math.round((context.potOdds + riskPremium) * 100)}%`, pressure >= 0.75 ? '对手使用了大尺度，你的边缘范围应显著收紧' : '当前牌力与听牌潜力不足以支付跟注成本'],
      false, realized + 0.08 < context.potOdds + riskPremium ? 'high' : 'medium',
    );
  }

  if (realized >= strongThreshold || strongMadeHand) {
    if (opts.canAllIn && context.spr <= 0.72) {
      return result(
        { type: 'allin' }, tierAction(opts, 'large'), opts, context,
        [`${hand.poker}处于强价值区间`, `SPR ${context.spr.toFixed(1)} 允许直接决死而不会过度超池`],
        false, 'high',
      );
    }
    const preference = texture === '湿润' ? 'large' : 'medium';
    return result(
      tierAction(opts, preference) || { type: 'check' }, { type: 'check' }, opts, context,
      [`估算权益 ${Math.round(context.equity * 100)}%，应主动获取价值`, texture === '湿润' ? '听牌较多，大尺度能收费并拒绝免费实现权益' : '牌面较干，中等尺度更容易留住弱牌'],
      false, 'high',
    );
  }
  if (realized >= valueThreshold) {
    const preference = texture === '干燥' ? 'small' : 'medium';
    return result(
      tierAction(opts, preference) || { type: 'check' }, { type: 'check' }, opts, context,
      ['手牌属于中等至薄价值范围', texture === '干燥' ? '干燥牌面用小注即可向弱对子收取价值' : '较多转牌会改变权益，中等尺度同时获取价值与保护'],
      realized < valueThreshold + 0.04, realized >= valueThreshold + 0.08 ? 'high' : 'medium',
    );
  }
  const strongDraw = engine.street !== 'river' && draws.potential >= 0.75;
  if (strongDraw && opts.tiers.length && numOpp <= 2 && roll < (positional > 0 ? 0.62 : 0.42)) {
    return result(
      tierAction(opts, texture === '湿润' ? 'medium' : 'small'), { type: 'check' }, opts, context,
      [`${drawText || '强听牌'}保留较多成牌权益`, '半诈唬可同时从弃牌率和后续成牌中获取价值'],
      true, 'medium',
    );
  }
  if (positional > 0 && numOpp === 1 && texture === '干燥' && opts.tiers.length && roll < 0.22) {
    return result(
      tierAction(opts, 'small'), { type: 'check' }, opts, context,
      ['单挑且拥有位置优势', '干燥牌面可以用低频小注攻击对手未命中范围'],
      true, 'low',
    );
  }
  return result(
    { type: 'check' }, strongDraw ? tierAction(opts, 'small') : null, opts, context,
    [strongDraw ? `${drawText || '听牌'}属于可过牌保护的混合范围` : '当前摊牌价值与弃牌率不足以支撑主动下注', '静观不放弃底池权益，也避免用过宽范围无效扩大底池'],
    strongDraw, strongDraw ? 'medium' : 'high',
  );
}

export function decisionKey(engine, player, opts) {
  const cards = [...player.hole, ...engine.revealedBoard()]
    .map((card) => `${card.rank}${card.suit}`).join('-');
  const activePlayers = engine.activePlayers().map((item) => item.idx).join(',');
  return [
    engine.round, engine.street, engine.revealed, engine.currentBet,
    engine.totalPot(), engine.streetRaiseCount || 0, player.idx,
    player.hp, player.betStreet, opts.toCall, opts.callAmt,
    opts.tiers.map((tier) => `${tier.key}:${tier.cost}`).join(','), cards, activePlayers,
  ].join('|');
}

export function estimateEquity(engine, player, simulations = Config.ADVICE_SIMS || 360) {
  if (!engine || !player || player.hole?.length < 2) return null;
  const numOpponents = Math.max(1, engine.activePlayers().length - 1);
  return WinRate.estimate(
    player.hole, engine.revealedBoard(), numOpponents, simulations,
  );
}

export function analyzeDecision(engine, player, opts, { equity: suppliedEquity } = {}) {
  if (!engine || !player || !opts || player.hole.length < 2) return null;
  const numOpponents = Math.max(1, engine.activePlayers().length - 1);
  const pot = Math.max(1, engine.totalPot());
  const blinds = Config.getBlinds(engine.round);
  const bb = Math.max(1, blinds.bb);
  const stack = effectiveStack(engine, player);
  const equity = suppliedEquity !== null
    && suppliedEquity !== undefined
    && Number.isFinite(Number(suppliedEquity))
    ? clamp(Number(suppliedEquity))
    : estimateEquity(engine, player);
  const position = positionContext(engine, player);
  const context = {
    equity,
    numOpponents,
    position: position.name,
    playersBehind: position.playersBehind,
    potOdds: opts.toCall / Math.max(1, engine.totalPot() + opts.toCall),
    spr: stack / pot,
    potBb: engine.totalPot() / bb,
    stackBb: stack / bb,
    metrics: '',
  };
  return engine.street === 'preflop'
    ? analyzePreflop(engine, player, opts, context)
    : analyzePostflop(engine, player, opts, context);
}
