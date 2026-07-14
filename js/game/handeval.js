// ============================================================================
// handeval.js - 杀招（牌型）评估器（与 Maker 版 HandEval.lua 一一对应）
// 5张评估 + 7选5最优评估，返回可直接比较大小的分值
// category: 1高牌 2一对 3两对 4三条 5顺子 6同花 7葫芦 8四条 9同花顺 10皇家同花顺
// ============================================================================

import { HAND_NAMES } from './config.js';

const B1 = 15, B2 = 225, B3 = 3375, B4 = 50625, B5 = 759375;

/** 评估恰好5张牌 → [score, category] */
export function eval5(cards) {
  const counts = new Map();
  for (let i = 0; i < 5; i++) {
    counts.set(cards[i].rank, (counts.get(cards[i].rank) || 0) + 1);
  }
  let isFlush = true;
  for (let i = 1; i < 5; i++) {
    if (cards[i].suit !== cards[0].suit) { isFlush = false; break; }
  }
  const groups = [...counts.entries()].map(([rank, count]) => ({ rank, count }));
  groups.sort((a, b) => (b.count - a.count) || (b.rank - a.rank));

  let isStraight = false, straightHigh = 0;
  if (groups.length === 5) {
    const hi = groups[0].rank, lo = groups[4].rank;
    if (hi - lo === 4) { isStraight = true; straightHigh = hi; }
    else if (hi === 14 && groups[1].rank === 5 && groups[4].rank === 2) {
      isStraight = true; straightHigh = 5; // 轮子 A2345
    }
  }

  let cat;
  const t = [0, 0, 0, 0, 0];
  if (isStraight && isFlush) {
    cat = straightHigh === 14 ? 10 : 9;
    t[0] = straightHigh;
  } else if (groups[0].count === 4) {
    cat = 8; t[0] = groups[0].rank; t[1] = groups[1].rank;
  } else if (groups[0].count === 3 && groups[1].count === 2) {
    cat = 7; t[0] = groups[0].rank; t[1] = groups[1].rank;
  } else if (isFlush) {
    cat = 6; for (let i = 0; i < 5; i++) t[i] = groups[i].rank;
  } else if (isStraight) {
    cat = 5; t[0] = straightHigh;
  } else if (groups[0].count === 3) {
    cat = 4; t[0] = groups[0].rank; t[1] = groups[1].rank; t[2] = groups[2].rank;
  } else if (groups[0].count === 2 && groups[1].count === 2) {
    cat = 3; t[0] = groups[0].rank; t[1] = groups[1].rank; t[2] = groups[2].rank;
  } else if (groups[0].count === 2) {
    cat = 2; t[0] = groups[0].rank; t[1] = groups[1].rank; t[2] = groups[2].rank; t[3] = groups[3].rank;
  } else {
    cat = 1; for (let i = 0; i < 5; i++) t[i] = groups[i].rank;
  }
  const score = cat * B5 + t[0] * B4 + t[1] * B3 + t[2] * B2 + t[3] * B1 + t[4];
  return [score, cat];
}

/** 从 5~7 张牌中选最强5张 → { score, cat, best5 } */
export function evalBest(cards) {
  const n = cards.length;
  if (n === 5) {
    const [s, c] = eval5(cards);
    return { score: s, cat: c, best5: cards.slice() };
  }
  let bestScore = -1, bestCat = 1, best5 = [];
  const pick = new Array(5);
  if (n === 6) {
    for (let skip = 0; skip < 6; skip++) {
      let k = 0;
      for (let i = 0; i < 6; i++) if (i !== skip) pick[k++] = cards[i];
      const [s, c] = eval5(pick);
      if (s > bestScore) { bestScore = s; bestCat = c; best5 = pick.slice(); }
    }
  } else {
    for (let a = 0; a < 6; a++) {
      for (let b = a + 1; b < 7; b++) {
        let k = 0;
        for (let i = 0; i < 7; i++) if (i !== a && i !== b) pick[k++] = cards[i];
        const [s, c] = eval5(pick);
        if (s > bestScore) { bestScore = s; bestCat = c; best5 = pick.slice(); }
      }
    }
  }
  return { score: bestScore, cat: bestCat, best5 };
}

/** 仅计算分值（蒙特卡洛热路径） */
export function score7(cards) {
  let best = -1;
  const pick = new Array(5);
  for (let a = 0; a < 6; a++) {
    for (let b = a + 1; b < 7; b++) {
      let k = 0;
      for (let i = 0; i < 7; i++) if (i !== a && i !== b) pick[k++] = cards[i];
      const [s] = eval5(pick);
      if (s > best) best = s;
    }
  }
  return best;
}

/** 不足5张时的简易牌力分类 → [category, coreCards] */
function evalPartial(cards) {
  const byRank = new Map();
  for (const c of cards) {
    if (!byRank.has(c.rank)) byRank.set(c.rank, []);
    byRank.get(c.rank).push(c);
  }
  let bestCount = 1, bestRank = 0;
  const pairs = [];
  for (const [r, list] of byRank) {
    if (list.length >= 2) pairs.push(r);
    if (list.length > bestCount || (list.length === bestCount && r > bestRank)) {
      bestCount = list.length; bestRank = r;
    }
  }
  if (bestCount >= 4) return [8, byRank.get(bestRank)];
  if (bestCount === 3) return [4, byRank.get(bestRank)];
  if (pairs.length >= 2) {
    pairs.sort((a, b) => b - a);
    const core = [...byRank.get(pairs[0]), ...byRank.get(pairs[1])];
    return [3, core];
  }
  if (bestCount === 2) return [2, byRank.get(bestRank)];
  return [1, []];
}

/** 通用当前牌力查询（任意2~7张）→ { cat, name, poker, core } */
export function describe(cards) {
  let cat, core;
  if (cards.length >= 5) {
    const r = evalBest(cards);
    cat = r.cat;
    if (cat === 1) {
      core = [];
    } else if (cat === 2 || cat === 3 || cat === 4 || cat === 8) {
      const counts = new Map();
      for (const c of r.best5) counts.set(c.rank, (counts.get(c.rank) || 0) + 1);
      core = r.best5.filter((c) => counts.get(c.rank) >= 2);
    } else {
      core = r.best5;
    }
  } else {
    [cat, core] = evalPartial(cards);
  }
  const info = HAND_NAMES[cat];
  return { cat, name: info.name, poker: info.poker, core };
}

const cardSignature = (card) => `${card?.rank || 0}:${card?.suit || 0}`;

/**
 * UI strong-hand policy shared by PC and H5.
 *
 * Three of a kind and above keep the existing strong-hand threshold. A two
 * pair only qualifies when both distinct hole cards are part of the paired
 * ranks selected into the best hand. This rejects a public pair plus one
 * personal pair, a pocket pair plus a public pair, and board-only two pair.
 */
export function isPlayerMadeStrongHand(current, hole = []) {
  const category = Number(current?.cat) || 0;
  if (category > 3) return true;
  if (category !== 3 || !Array.isArray(hole) || hole.length !== 2) return false;
  const [first, second] = hole;
  if (!Number.isFinite(first?.rank) || !Number.isFinite(first?.suit)
    || !Number.isFinite(second?.rank) || !Number.isFinite(second?.suit)
    || first.rank === second.rank) return false;
  const coreCards = new Set((current?.core || []).map(cardSignature));
  return coreCards.has(cardSignature(first)) && coreCards.has(cardSignature(second));
}
