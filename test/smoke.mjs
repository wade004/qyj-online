// 群英决 web 版逻辑冒烟测试（node test/smoke.mjs）
// 与 Maker 版 lupa 冒烟等价：牌型自检 + 整局完赛 + 血池不丢失 + 小额保险受控
import './battle_session.mjs';
import { Engine } from '../js/game/engine.js';
import { evalBest } from '../js/game/handeval.js';
import * as AI from '../js/game/ai.js';
import { HEROES } from '../js/game/heroes.js';

const C = (r, s) => ({ rank: r, suit: s });
const tests = [
  [[C(14,1),C(13,1),C(12,1),C(11,1),C(10,1),C(2,2),C(3,3)], 10, '皇家同花顺'],
  [[C(9,2),C(8,2),C(7,2),C(6,2),C(5,2),C(2,1),C(3,3)], 9, '同花顺'],
  [[C(7,1),C(7,2),C(7,3),C(7,4),C(5,2),C(2,1),C(3,3)], 8, '四条'],
  [[C(7,1),C(7,2),C(7,3),C(5,4),C(5,2),C(2,1),C(3,3)], 7, '葫芦'],
  [[C(2,1),C(6,1),C(9,1),C(11,1),C(13,1),C(5,2),C(3,3)], 6, '同花'],
  [[C(4,1),C(5,2),C(6,3),C(7,4),C(8,2),C(2,1),C(13,3)], 5, '顺子'],
  [[C(14,1),C(2,2),C(3,3),C(4,4),C(5,2),C(9,1),C(13,3)], 5, '轮子顺'],
  [[C(7,1),C(7,2),C(7,3),C(4,4),C(5,2),C(2,1),C(13,3)], 4, '三条'],
  [[C(7,1),C(7,2),C(5,3),C(5,4),C(9,2),C(2,1),C(13,3)], 3, '两对'],
  [[C(7,1),C(7,2),C(4,3),C(5,4),C(9,2),C(2,1),C(13,3)], 2, '一对'],
  [[C(7,1),C(8,2),C(4,3),C(5,4),C(10,2),C(2,1),C(13,3)], 1, '高牌'],
];
for (const [cards, expect, name] of tests) {
  const r = evalBest(cards);
  if (r.cat !== expect) throw new Error(`牌型自检失败 ${name}: got=${r.cat}`);
}
console.log('牌型评估自检通过（11例）');

// 单机真人阵亡应结束整局；联机/通用引擎默认不启用该模式规则。
let soloEnded = false;
const soloRuleEngine = new Engine(
  HEROES.slice(0, 6).map((h) => h.id),
  { onGameOver() { soloEnded = true; } },
  null,
  {},
  { endWhenHumanEliminated: true },
);
soloRuleEngine.round = 3;
soloRuleEngine.players[1].hp = 0;
soloRuleEngine.endRound();
soloRuleEngine.update(2);
if (!soloEnded || !soloRuleEngine.gameOver) throw new Error('单机真人阵亡后对局未结束');

let sharedEnded = false;
const sharedRuleEngine = new Engine(
  HEROES.slice(0, 6).map((h) => h.id),
  { onGameOver() { sharedEnded = true; } },
  new Set([1]),
);
sharedRuleEngine.round = 3;
sharedRuleEngine.players[1].hp = 0;
sharedRuleEngine.endRound();
sharedRuleEngine.update(2);
if (sharedEnded || sharedRuleEngine.gameOver) throw new Error('通用/联机引擎不应因单个真人阵亡结束');
console.log('模式终局规则自检通过（单机真人阵亡结束，联机不受影响）');

let ids = HEROES.map((h) => h.id);
const actionTotals = { fold: 0, call: 0, check: 0, raise: 0, allin: 0, sidePots: 0 };
for (let game = 1; game <= 6; game++) {
  let finished = false;
  let finalRanking = null;
  let engine = null;
  const listeners = {
    onGameOver(ranking) { finished = true; finalRanking = ranking; },
    onAction(idx, key) {
      if (key === 'fold' || key === 'call' || key === 'check' || key === 'allin') actionTotals[key]++;
      else actionTotals.raise++;
    },
    onShowdown(data) { actionTotals.sidePots += Math.max(0, (data.pots?.length || 1) - 1); },
    onAwaitAction(idx) {
      const act = AI.decide(engine, engine.players[idx]);
      engine.playerAct(act);
    },
  };
  engine = new Engine(ids, listeners);
  engine.players[1].style = engine.players[2].style; // 人类座位由 AI 代打
  engine.startGame();

  let steps = 0;
  while (!finished && steps < 8000) {
    engine.update(0.5);
    steps++;
  }
  if (!finished) throw new Error(`对局未结束 round=${engine.round} steps=${steps}`);

  let total = 0, alive = 0;
  for (let i = 1; i <= 6; i++) {
    total += engine.players[i].hp;
    if (engine.players[i].alive) alive++;
    if (engine.players[i].hp < 0) throw new Error('负气血!');
  }
  if (total < 9000) throw new Error(`气血凭空消失 total=${total}`);
  // 首发阵容只有廉颇可通过保险获得气血：每回合至多50，12回合理论上限600。
  if (total > 9600) throw new Error(`技能保险超出整局上限 total=${total}`);
  console.log(`对局${game} 完成：${engine.round}回合 存活${alive} 总气血${total} 冠军=${finalRanking[0].hero.name}`);
  ids = [ids[ids.length - 1], ...ids.slice(0, -1)];
}
if (actionTotals.raise + actionTotals.allin === 0) throw new Error('AI整轮测试没有任何主动进攻');
console.log(`AI行动统计：加注${actionTotals.raise} 决死${actionTotals.allin} 跟注${actionTotals.call} 弃牌${actionTotals.fold} 边池${actionTotals.sidePots}`);
console.log('SMOKE OK');
