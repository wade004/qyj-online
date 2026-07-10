import { formatActionHint } from '../js/ui/battle.js';

const cases = [
  ['smallBlind', 10, false, '小盲 10'],
  ['bigBlind', 20, false, '大盲 20'],
  ['fold', 0, false, '退避'],
  ['check', 0, false, '静观'],
  ['call', 80, false, '应战 80'],
  ['call', 80, true, '决死应战 80'],
  ['allin', 1490, true, '决死 1490'],
  ['feint', 185, false, '佯攻 185'],
  ['strike', 240, false, '强攻 240'],
  ['fierce', 295, false, '猛攻 295'],
];

for (const [key, amount, allIn, expected] of cases) {
  const actual = formatActionHint(key, amount, allIn);
  if (actual !== expected) {
    throw new Error(`行动提示错误：${key} 预期“${expected}”，实际“${actual}”`);
  }
}

console.log('玩家行动提示自检通过：盲注、退避、静观、应战、决死与三档进攻均显示具体操作');
