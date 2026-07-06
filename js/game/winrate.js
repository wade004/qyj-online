// ============================================================================
// winrate.js - 蒙特卡洛胜率评估（与 Maker 版 WinRate.lua 一一对应）
// ============================================================================

import { remaining } from './deck.js';
import { score7 } from './handeval.js';

/**
 * 估算胜率（平局按0.5折算）
 * @param {Array} hole 自己的2枚暗令
 * @param {Array} board 已揭示的天机（0~5张）
 * @param {number} numOpponents 仍在对局中的对手数
 * @param {number} sims 模拟局数
 */
export function estimate(hole, board, numOpponents, sims) {
  if (numOpponents <= 0) return 1.0;
  const rest = remaining([...hole, ...board]);
  const restN = rest.length;
  const boardNeed = 5 - board.length;
  const need = numOpponents * 2 + boardNeed;

  const myCards = [hole[0], hole[1], null, null, null, null, null];
  const oppCards = new Array(7);
  let wins = 0, ties = 0;

  for (let s = 0; s < sims; s++) {
    // 部分 Fisher-Yates：只洗出前 need 张
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(Math.random() * (restN - i));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    for (let i = 0; i < board.length; i++) myCards[2 + i] = board[i];
    for (let i = 0; i < boardNeed; i++) myCards[2 + board.length + i] = rest[i];
    const myScore = score7(myCards);

    let bestOpp = -1;
    let idx = boardNeed;
    for (let o = 0; o < numOpponents; o++) {
      oppCards[0] = rest[idx];
      oppCards[1] = rest[idx + 1];
      idx += 2;
      for (let i = 2; i < 7; i++) oppCards[i] = myCards[i];
      const sc = score7(oppCards);
      if (sc > bestOpp) bestOpp = sc;
    }
    if (myScore > bestOpp) wins++;
    else if (myScore === bestOpp) ties++;
  }
  return (wins + ties * 0.5) / sims;
}
