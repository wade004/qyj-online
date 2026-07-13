// ============================================================================
// deck.js - 牌组：52张杀招令（花色1~4 × 阶数2~14）
// 牌结构：{ rank: 2..14, suit: 1..4 }
// ============================================================================

export function createDeck() {
  const cards = [];
  for (let suit = 1; suit <= 4; suit++) {
    for (let rank = 2; rank <= 14; rank++) {
      cards.push({ rank, suit });
    }
  }
  return cards;
}

/** Fisher-Yates 洗牌（原地） */
export function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const value = Math.max(0, Math.min(1 - Number.EPSILON, Number(rng())));
    const j = Math.floor(value * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function newShuffledDeck(rng = Math.random) {
  return shuffle(createDeck(), rng);
}

/** 从牌堆顶抽一张 */
export function draw(deck) {
  return deck.pop();
}

/** 生成排除指定牌后的剩余牌堆（蒙特卡洛用） */
export function remaining(excluded) {
  const used = new Set();
  for (const c of excluded) used.add((c.suit - 1) * 13 + c.rank);
  const rest = [];
  for (let suit = 1; suit <= 4; suit++) {
    for (let rank = 2; rank <= 14; rank++) {
      if (!used.has((suit - 1) * 13 + rank)) rest.push({ rank, suit });
    }
  }
  return rest;
}
