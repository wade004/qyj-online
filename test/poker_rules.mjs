// 德州扑克规则与 AI 策略边界：主/边池、未跟注返还、单挑盲注、短码全下与翻前范围。
import { Engine } from '../js/game/engine.js';
import { HEROES } from '../js/game/heroes.js';
import * as AI from '../js/game/ai.js';
import * as WinRate from '../js/game/winrate.js';

const ids = HEROES.slice(0, 6).map((hero) => hero.id);
const assert = (condition, message) => {
  if (!condition) throw new Error('扑克规则断言失败: ' + message);
};
const C = (rank, suit) => ({ rank, suit });

// 100 / 300 / 300 三名亮牌者，另有一名已弃牌者投入 300。
const potEngine = new Engine(ids, {}, new Set());
const contributions = [100, 300, 300, 300, 0, 0];
for (let i = 1; i <= 6; i++) {
  potEngine.players[i].betRound = contributions[i - 1];
  potEngine.players[i].folded = i === 4;
}
const entrants = [potEngine.players[1], potEngine.players[2], potEngine.players[3]];
const layers = potEngine.buildPots(entrants);
assert(layers.length === 2, '应形成一个主池和一个边池');
assert(layers[0].amount === 400, `主池应为400，实际${layers[0].amount}`);
assert(layers[0].eligible.map((p) => p.idx).join(',') === '1,2,3', '主池应有三名可争夺者');
assert(layers[1].amount === 600, `边池应为600，实际${layers[1].amount}`);
assert(layers[1].eligible.map((p) => p.idx).join(',') === '2,3', '边池应仅由深筹码两人争夺');

assert(potEngine.getPotBreakdown().length === 1, '无人全下时桌面不应把普通加注误拆为边池');
potEngine.players[1].allIn = true;
const visibleLayers = potEngine.getPotBreakdown();
assert(visibleLayers.map((pot) => pot.label).join(',') === '主池,边池 1', '全下后应在桌面分开标记主池和边池');
assert(visibleLayers.map((pot) => pot.amount).join(',') === '400,600', '桌面主池/边池金额应与结算分层一致');

// 唯一最高投入者刚全下时，未完成响应的普通投入不是全下档位，不得提前拆边池。
const openingAllInEngine = new Engine(ids, {}, new Set());
const openingContributions = [1500, 10, 20, 30, 40, 0];
for (let i = 1; i <= 6; i++) {
  const player = openingAllInEngine.players[i];
  player.betRound = openingContributions[i - 1];
  player.folded = i === 6;
  player.allIn = i === 1;
}
const openingDisplay = openingAllInEngine.getPotBreakdown();
assert(openingDisplay.map((pot) => pot.label).join(',') === '主池,待跟注',
  '首个玩家全下后，其他玩家响应前不应出现任何边池');
assert(openingDisplay.map((pot) => pot.amount).join(',') === '140,1460',
  '实时桌面应将已匹配/已投入的140合并显示，最高1460作为待跟注');
const openingCollapsed = openingAllInEngine.getPotDisplay(false);
assert(openingCollapsed.length === 1 && openingCollapsed[0].amount === 1600,
  '非真人决策窗口不应显示待跟注，所有当前投入应直接并入血池总额');

// 中央信息区只保留当前血池和最近一次主动下注前的血池。
const potContextEngine = new Engine(ids, {}, new Set());
potContextEngine.round = 1;
potContextEngine.street = 'flop';
potContextEngine.currentBet = 0;
potContextEngine.minRaiseInc = 20;
for (const player of potContextEngine.players.slice(1)) {
  player.alive = true;
  player.folded = false;
  player.betRound = 50;
  player.betStreet = 0;
  player.acted = false;
  player.lastActionBet = 0;
}
potContextEngine.applyAction(potContextEngine.players[1], {
  type: 'raise', tier: { key: 'strike', name: '强攻', inc: 100 },
});
let potContext = potContextEngine.getPotDisplay();
assert(potContext.map((item) => item.label).join(',') === '当前血池,上次下注前',
  '中央区域必须固定只返回两个血池上下文指标');
assert(potContext[0].amount === 400 && potContext[1].amount === 300,
  '投入100前血池为300，投入后当前血池应为400');
assert(potContext[1].actorIdx === 1 && potContext[1].wagerAmount === 100
  && Math.abs(potContext[1].ratio - 1 / 3) < 1e-9,
  '应记录上一名主动下注者、投入金额及其占下注前血池的比例');
const collapsedPotContext = potContextEngine.getPotDisplay(false);
assert(collapsedPotContext.length === 1 && collapsedPotContext[0].amount === 400,
  '主角操作完成后必须立即收起上次下注参考，只显示当前血池');
potContextEngine.applyAction(potContextEngine.players[2], { type: 'call' });
potContext = potContextEngine.getPotDisplay();
assert(potContext[0].amount === 500 && potContext[1].amount === 300
  && potContext[1].actorIdx === 1,
  '普通跟注只更新当前血池，不能覆盖最近一次主动下注快照');

// 弃牌玩家的独立投入档位不能制造额外边池：可争夺者相同的相邻层必须合并。
const foldedBoundaryEngine = new Engine(ids, {}, new Set());
const foldedBoundaryContributions = [100, 300, 300, 200, 0, 0];
for (let i = 1; i <= 6; i++) {
  const player = foldedBoundaryEngine.players[i];
  player.betRound = foldedBoundaryContributions[i - 1];
  player.folded = i >= 4;
  player.allIn = i === 1 || i === 2;
}
const foldedBoundaryEntrants = foldedBoundaryEngine.players.slice(1, 4);
const foldedBoundaryPots = foldedBoundaryEngine.buildPots(foldedBoundaryEntrants);
assert(foldedBoundaryPots.length === 2, '弃牌者的200投入不应把同一边池错拆为两个');
assert(foldedBoundaryPots.map((pot) => pot.amount).join(',') === '400,500',
  '应形成400主池和500边池');
assert(foldedBoundaryPots[1].eligible.map((player) => player.idx).join(',') === '2,3',
  '合并后的500边池应仅由2、3号位争夺');

// 多个全下额度各自改变资格集合，折叠弃牌投入后仍只形成必要的边池。
const multiAllInEngine = new Engine(ids, {}, new Set());
const multiContributions = [100, 250, 400, 600, 350, 0];
for (let i = 1; i <= 6; i++) {
  const player = multiAllInEngine.players[i];
  player.betRound = multiContributions[i - 1];
  player.folded = i >= 5;
  player.allIn = i <= 3;
}
const multiEntrants = multiAllInEngine.players.slice(1, 5);
const multiPots = multiAllInEngine.buildPots(multiEntrants);
assert(multiPots.map((pot) => pot.amount).join(',') === '500,600,400,200',
  '多级全下应形成500主池、600边池1、400边池2与200未跟注返还');
assert(multiPots[0].eligible.map((player) => player.idx).join(',') === '1,2,3,4',
  '主池应由1至4号位争夺');
assert(multiPots[1].eligible.map((player) => player.idx).join(',') === '2,3,4',
  '边池1应由2至4号位争夺');
assert(multiPots[2].eligible.map((player) => player.idx).join(',') === '3,4',
  '边池2应仅由3、4号位争夺');
assert(multiPots[2].contributionById[3] === 150
  && multiPots[2].contributionById[4] === 150
  && multiPots[2].contributionById[5] === 100,
  '合并边池必须保留每位玩家在该池的实际投入');
assert(multiPots[3].uncalledTo === 4, '最高200未跟注应返还4号位');
assert(multiPots.reduce((sum, pot) => sum + pot.amount, 0)
  === multiContributions.reduce((sum, amount) => sum + amount, 0),
  '分池后总额必须与全部玩家总投入守恒');
const multiDisplay = multiAllInEngine.getPotBreakdown();
assert(multiDisplay.map((pot) => pot.label).join(',') === '主池,边池 1,边池 2,待跟注',
  '只有真正的多个全下投入上限才应在桌面上生成多级边池');
assert(multiDisplay.map((pot) => pot.amount).join(',') === '500,600,400,200',
  '多级边池实时显示应与封闭后的标准结算一致');
const collapsedMultiDisplay = multiAllInEngine.getPotDisplay(false);
assert(collapsedMultiDisplay.map((pot) => pot.label).join(',') === '主池,边池 1,边池 2',
  '非主角操作阶段仍应常驻显示真实主池和各级边池');
assert(collapsedMultiDisplay.map((pot) => pot.amount).join(',') === '500,600,600',
  '不单独显示待跟注时，当前最深层的投入应直接并入最后一个边池显示');

let multiShowdownData = null;
const multiShowdownEngine = new Engine(ids, {
  onShowdown(data) { multiShowdownData = data; },
}, new Set());
multiShowdownEngine.street = 'river';
multiShowdownEngine.revealed = 5;
multiShowdownEngine.board = [C(2, 4), C(3, 3), C(4, 2), C(9, 1), C(13, 4)];
for (let i = 1; i <= 6; i++) {
  const player = multiShowdownEngine.players[i];
  player.alive = true;
  player.folded = i >= 5;
  player.allIn = i <= 3;
  player.betRound = multiContributions[i - 1];
}
multiShowdownEngine.players[1].hole = [C(14, 1), C(5, 1)]; // 顺子，赢主池
multiShowdownEngine.players[2].hole = [C(13, 2), C(13, 3)]; // K三条，赢边池1
multiShowdownEngine.players[3].hole = [C(9, 2), C(9, 3)]; // 9三条，赢边池2
multiShowdownEngine.players[4].hole = [C(14, 2), C(14, 3)];
multiShowdownEngine.showdown();
assert(multiShowdownData.pots.map((pot) => pot.amount).join(',') === '500,600,400',
  '亮招结算不应把200未跟注返还计入主池或边池');
assert(multiShowdownData.pots.map((pot) => pot.winnerIds[0]).join(',') === '1,2,3',
  '主池、边池1、边池2必须各自独立比牌与颁奖');
assert(multiShowdownData.pots[1].netWinnings[2] === 450,
  '边池1赢家的净赢应只扣除其在边池1的150投入');
assert(multiShowdownData.pots[2].netWinnings[3] === 250,
  '边池2赢家的净赢应扣除合并后其在该池的150投入');
assert(multiShowdownData.netResult[5] === -350,
  '亮招权威净额应包含已退避但有投入的玩家');

let showdownData = null;
const showdownEngine = new Engine(ids, { onShowdown(data) { showdownData = data; } }, new Set());
showdownEngine.street = 'river';
showdownEngine.revealed = 5;
showdownEngine.board = [C(2, 4), C(3, 3), C(4, 2), C(9, 1), C(13, 4)];
for (let i = 1; i <= 6; i++) {
  const player = showdownEngine.players[i];
  player.alive = true; player.folded = i >= 4; player.betRound = contributions[i - 1];
}
showdownEngine.players[1].hole = [C(14, 1), C(5, 1)]; // 顺子，赢主池
showdownEngine.players[2].hole = [C(13, 2), C(13, 3)]; // 三条，赢边池
showdownEngine.players[3].hole = [C(12, 2), C(12, 3)];
showdownEngine.showdown();
assert(showdownData?.pots.length === 2, '亮招事件应公开主池和边池明细');
assert(showdownData.pots[0].label === '主池' && showdownData.pots[0].winnerIds[0] === 1,
  '1号位应赢得主池');
assert(showdownData.pots[1].label === '边池 1' && showdownData.pots[1].winnerIds[0] === 2,
  '2号位应赢得边池');
assert(showdownData.wonAmount[1] === 400 && showdownData.wonAmount[2] === 600,
  '主池/边池奖金应分别为400/600');
assert(showdownData.pots[0].netWinnings[1] === 300, '主池赢家扣除主池投入后应净赢300');
assert(showdownData.pots[1].netWinnings[2] === 400, '边池赢家扣除边池投入后应净赢400');
assert(showdownData.netResult[1] === 300 && showdownData.netResult[2] === 300,
  '座位总提示应按总奖金减去本回合总投入，二人均净赢300');
assert(showdownData.netResult[4] === -300,
  '座位总提示应包含已退避玩家的完整损失');

// 只有一人多投入的部分不是边池，必须作为未跟注筹码返还。
potEngine.players[1].betRound = 100;
potEngine.players[2].betRound = 300;
potEngine.players[3].betRound = 100;
potEngine.players[4].betRound = 0;
const uncalled = potEngine.buildPots(entrants);
assert(uncalled.length === 2 && uncalled[1].amount === 200, '应识别200未跟注筹码');
assert(uncalled[1].uncalledTo === 2, '未跟注筹码应返还2号位');
const pendingLayers = potEngine.getPotBreakdown();
assert(pendingLayers[1].label === '待跟注' && pendingLayers[1].amount === 200,
  '尚未跟平的投入应显示为待跟注，不应冒充边池');

// 单挑时按钮位同时是小盲，且翻牌前先行动。
let blindEvent = null;
let turnEvent = null;
let actionEvent = null;
const headsUp = new Engine(ids, {
  onBlindsPosted(sbIdx, sbAmt, bbIdx, bbAmt) {
    blindEvent = { sbIdx, sbAmt, bbIdx, bbAmt };
  },
  onTurnStart(idx) {
    turnEvent = { idx, actingIdx: headsUp.actingIdx };
  },
  onAction(idx, key, amount) {
    actionEvent = { idx, key, amount, actingIdx: headsUp.actingIdx };
  },
}, new Set());
for (let i = 3; i <= 6; i++) {
  headsUp.players[i].alive = false;
  headsUp.players[i].hp = 0;
}
headsUp.startRound();
assert(blindEvent?.sbIdx === headsUp.dealerIdx, '单挑按钮位必须下小盲');
assert(blindEvent?.bbIdx !== headsUp.dealerIdx, '单挑非按钮位必须下大盲');
assert(headsUp.actingIdx === 0, '发完盲注后的演出等待期不应误报正在行动者');
assert(headsUp.players[blindEvent.sbIdx].lastAction?.key === 'smallBlind'
  && headsUp.players[blindEvent.sbIdx].lastAction?.amount === blindEvent.sbAmt,
'小盲状态应记录为公开的最近行动');
assert(headsUp.players[blindEvent.bbIdx].lastAction?.key === 'bigBlind'
  && headsUp.players[blindEvent.bbIdx].lastAction?.amount === blindEvent.bbAmt,
'大盲状态应记录为公开的最近行动');
headsUp.update(1.4);
assert(turnEvent?.idx === blindEvent.sbIdx && turnEvent.actingIdx === blindEvent.sbIdx,
  '翻牌前应从大盲之后的按钮/小盲开始行动，且 onTurnStart 快照标记当前行动者');
const headsUpActor = headsUp.players[turnEvent.idx];
headsUp.applyAction(headsUpActor, { type: 'call' });
assert(actionEvent?.idx === headsUpActor.idx && actionEvent.key === 'call'
  && actionEvent.actingIdx === 0, 'onAction 发出前必须清除正在行动者，避免重连误报');
assert(headsUpActor.lastAction?.key === 'call'
  && headsUpActor.lastAction?.amount === blindEvent.bbAmt - blindEvent.sbAmt
  && headsUpActor.lastAction?.street === 'preflop'
  && headsUpActor.lastAction?.round === 1,
'玩家最近行动应携带动作、金额、街道与回合');

const streetStateEngine = new Engine(ids, {}, new Set());
streetStateEngine.round = 1;
streetStateEngine.street = 'preflop';
streetStateEngine.board = [C(2, 1), C(3, 2), C(4, 3), C(9, 4), C(13, 1)];
for (let i = 1; i <= 6; i++) {
  const player = streetStateEngine.players[i];
  player.alive = true;
  player.folded = false;
  player.allIn = false;
  player.hole = [C(10 + i, 1), C(8 + i, 2)];
  player.lastAction = { key: 'check', amount: 0, street: 'preflop', round: 1 };
}
streetStateEngine.players[2].folded = true;
streetStateEngine.players[2].lastAction = {
  key: 'fold', amount: 0, street: 'preflop', round: 1,
};
streetStateEngine.players[3].allIn = true;
streetStateEngine.players[3].lastAction = {
  key: 'allin', amount: 1500, street: 'preflop', round: 1,
};
streetStateEngine.actingIdx = 4;
streetStateEngine.advanceStreet();
assert(streetStateEngine.actingIdx === 0, '切换街道期间不得保留正在行动者');
assert(streetStateEngine.players[1].lastAction === null,
  '仍可行动的普通玩家跨街后应清除上一街行动');
assert(streetStateEngine.players[2].lastAction?.key === 'fold'
  && streetStateEngine.players[3].lastAction?.key === 'allin',
'已退避或决死玩家跨街后应保留终局状态');

// 所有后续下注行动封闭时，必须在发剩余公共牌之前立即公开在局底牌，且只公开一次。
let allInRevealCount = 0;
let allInRevealEntrants = null;
const revealEngine = new Engine(ids, {
  onAllInReveal(players) {
    allInRevealCount++;
    allInRevealEntrants = players;
  },
}, new Set());
revealEngine.round = 1;
revealEngine.street = 'preflop';
revealEngine.board = [C(2, 1), C(3, 2), C(4, 3), C(9, 4), C(13, 1)];
revealEngine.revealed = 0;
for (let i = 1; i <= 6; i++) {
  const player = revealEngine.players[i];
  player.alive = true; player.folded = i > 2; player.allIn = i <= 2;
  player.hole = [C(10 + i, 1), C(8 + i, 2)];
}
revealEngine.advanceStreet();
assert(allInRevealCount === 1, '行动封闭时应立即触发一次决死亮牌');
assert(allInRevealEntrants?.length === 2 && allInRevealEntrants.every((p) => p.hole.length === 2),
  '决死亮牌应公开全部在局者的两张底牌');
revealEngine.advanceStreet();
assert(allInRevealCount === 1, '后续自动发牌不得重复触发决死亮牌');

// 不足一个完整加注的全下不会重新开放已行动者的加注权；累计达到完整加注后会开放。
const raiseEngine = new Engine(ids, {}, new Set());
raiseEngine.street = 'flop';
raiseEngine.currentBet = 100;
raiseEngine.minRaiseInc = 100;
for (const player of raiseEngine.players.slice(1)) {
  player.folded = false;
  player.alive = true;
  player.betStreet = 100;
  player.betRound = 100;
  player.hp = 1000;
  player.acted = false;
  player.lastActionBet = 0;
}
const alreadyActed = raiseEngine.players[1];
alreadyActed.acted = true;
alreadyActed.lastActionBet = 100;
const shortOne = raiseEngine.players[2];
shortOne.hp = 50;
raiseEngine.applyAction(shortOne, { type: 'allin' });
let actedOptions = raiseEngine.getOptions(alreadyActed);
assert(raiseEngine.currentBet === 150, '第一次短码全下应把当前注额提高到150');
assert(!actedOptions.canRaise && actedOptions.tiers.length === 0, '短码全下不应重新开放加注');
assert(!actedOptions.canAllIn, '加注权关闭时不能用超额全下绕过限制');
assert(raiseEngine.getOptions(raiseEngine.players[3]).canRaise, '尚未行动者仍可正常加注');

const shortTwo = raiseEngine.players[3];
shortTwo.hp = 120;
raiseEngine.applyAction(shortTwo, { type: 'allin' });
actedOptions = raiseEngine.getOptions(alreadyActed);
assert(raiseEngine.currentBet === 220, '第二次短码全下应把当前注额提高到220');
assert(actedOptions.canRaise, '累计短码加注达到完整加注额后应重新开放加注');

// 翻前范围必须能稳定区分顶级牌与垃圾牌，避免用六人裸胜率套固定阈值。
assert(AI.preflopStrength([C(14, 1), C(14, 2)]) > 0.95, 'AA应属于顶级范围');
assert(AI.preflopStrength([C(14, 1), C(13, 1)]) > 0.82, 'AK同花应属于强范围');
assert(AI.preflopStrength([C(7, 1), C(2, 2)]) < 0.30, '72不同花应属于弃牌范围');
const boardRoyal = [C(10, 1), C(11, 1), C(12, 1), C(13, 1), C(14, 1)];
const fourWayTieEquity = WinRate.estimate([C(2, 2), C(3, 3)], boardRoyal, 3, 12);
assert(fourWayTieEquity === 0.25, `四人公牌平分胜率应为25%，实际${fourWayTieEquity}`);

const aiEngine = new Engine(ids, {}, new Set());
aiEngine.street = 'preflop';
aiEngine.round = 1;
aiEngine.currentBet = 20;
aiEngine.minRaiseInc = 20;
aiEngine.streetRaiseCount = 0;
for (const player of aiEngine.players.slice(1)) {
  player.folded = false; player.alive = true; player.hp = 1500;
  player.betStreet = 0; player.betRound = 0; player.acted = false; player.lastActionBet = 0;
}
const aiPlayer = aiEngine.players[3];
aiPlayer.style = { looseness: 0, aggression: 0.05, bluffFactor: 1 };
const originalRandom = Math.random;
try {
  Math.random = () => 0.2;
  aiPlayer.hole = [C(14, 1), C(14, 2)];
  const premiumAction = AI.decide(aiEngine, aiPlayer);
  assert(['raise', 'allin'].includes(premiumAction.type), 'AA未面对加注时应主动进攻');
  aiPlayer.hole = [C(7, 1), C(2, 2)];
  const trashAction = AI.decide(aiEngine, aiPlayer);
  assert(trashAction.type === 'fold', '72不同花面对大盲应弃牌');
} finally {
  Math.random = originalRandom;
}

console.log('扑克规则自检通过：主/边池资格合并、多级全下、未跟注返还、单挑盲注、短码全下与AI范围正常');
