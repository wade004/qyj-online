// ============================================================================
// ai.js - AI 决策：蒙特卡洛胜率 + 底池赔率 + 性格参数（对应 AI.lua）
// ============================================================================

import * as Config from './config.js';
import * as WinRate from './winrate.js';

/** 条件满足时以一定概率发动技能 */
export function maybeUseSkill(engine, p) {
  if (!engine.canUseSkill(p.idx)) return;
  if (Math.random() < Config.AI_SKILL_RATE) {
    engine.useSkill(p.idx);
  }
}

/** 决策主入口 → { type, tier? } */
export function decide(engine, p) {
  const style = p.style;
  const opts = engine.getOptions(p);
  const activeCount = engine.activePlayers().length;
  const numOpp = Math.max(1, activeCount - 1);
  const wr = WinRate.estimate(p.hole, engine.revealedBoard(), numOpp, Config.AI_SIMS);
  const pot = engine.totalPot();
  const toCall = opts.toCall;

  // 极强牌：一定概率直接决死
  if (wr >= 0.88 && Math.random() < 0.45) return { type: 'allin' };

  const thr = style.raiseThreshold;
  if (wr > thr && opts.tiers.length > 0) {
    let tierIdx;
    if (wr > thr + 0.16) tierIdx = 2;
    else if (wr > thr + 0.08) tierIdx = 1;
    else tierIdx = 0;
    if (tierIdx >= opts.tiers.length) tierIdx = opts.tiers.length - 1;
    return { type: 'raise', tier: opts.tiers[tierIdx] };
  }

  if (toCall <= 0) {
    if (Math.random() < style.bluffRate && opts.tiers.length > 0) {
      return { type: 'raise', tier: opts.tiers[0] };
    }
    return { type: 'check' };
  }

  const potOdds = toCall / (pot + toCall);
  if (toCall >= p.hp) {
    // 跟注即决死：更严格
    if (wr > Math.max(potOdds + style.callAdj, 0.45)) return { type: 'allin' };
    return { type: 'fold' };
  }
  if (wr > potOdds + style.callAdj) return { type: 'call' };
  if (Math.random() < style.bluffRate * 0.5 && opts.tiers.length > 0) {
    return { type: 'raise', tier: opts.tiers[0] };
  }
  if (toCall <= p.hp * 0.06 && Math.random() < 0.5) return { type: 'call' };
  return { type: 'fold' };
}
