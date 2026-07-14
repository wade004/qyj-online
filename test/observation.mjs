import assert from 'node:assert/strict';

import { Engine } from '../js/game/engine.js';
import { HEROES } from '../js/game/heroes.js';
import { buildObservation, MAX_SUPPORTED_SEATS } from '../js/game/observation.js';

const C = (rank, suit) => ({ rank, suit });
const ids = HEROES.slice(0, 6).map((hero) => hero.id);

let actionCallback = null;
let privateCallback = null;
const engine = new Engine(ids, {
  onAction(idx, key, amount, meta) {
    actionCallback = { idx, key, amount, meta };
  },
  onSkillResult(idx, result) {
    privateCallback = { idx, result };
  },
}, new Set());

engine.round = 3;
engine.street = 'flop';
engine.dealerIdx = 6;
engine.board = [C(2, 1), C(7, 2), C(11, 3), C(95, 4), C(96, 1)];
engine.revealed = 3;
engine.deck = [C(97, 2)];
engine.currentBet = 100;
engine.minRaiseInc = 50;
engine.streetRaiseCount = 1;
engine.currentHandSeats = [1, 2, 3, 4, 5, 6];
for (const player of engine.players.slice(1)) {
  player.alive = true;
  player.folded = false;
  player.allIn = false;
  player.hp = 1000;
  player.betStreet = player.idx === 1 ? 50 : 100;
  player.betRound = player.betStreet;
  player.acted = false;
  player.lastActionBet = 0;
  player.hole = [C(80 + player.idx * 2, 1), C(81 + player.idx * 2, 2)];
}
engine.players[1].hole = [C(14, 1), C(13, 1)];
engine.players[2].hole = [C(91, 3), C(92, 4)];
engine.players[3].hole = [C(93, 1), C(94, 2)];

const potBefore = engine.totalPot();
engine.applyAction(engine.players[1], {
  type: 'raise',
  tier: { key: 'medium', name: '中注', inc: 100 },
});

assert.equal(actionCallback?.idx, 1, '原 onAction 回调的座位参数必须保持不变');
assert.equal(actionCallback?.key, 'medium', '原 onAction 回调的动作键必须保持不变');
assert.equal(actionCallback?.amount, 150, '原 onAction 回调的下注额必须保持不变');
assert.equal(actionCallback?.meta.currentBetBefore, 100, '原行动前元数据必须继续提供');
assert.equal(actionCallback?.meta.potBefore, potBefore, '原底池元数据必须继续提供');

const raiseEvent = engine.actionHistory.at(-1);
assert.deepEqual({
  actorIdx: raiseEvent.actorIdx,
  round: raiseEvent.round,
  street: raiseEvent.street,
  type: raiseEvent.type,
  key: raiseEvent.key,
  amount: raiseEvent.amount,
  callAmount: raiseEvent.callAmount,
  raiseIncrement: raiseEvent.raiseIncrement,
  raiseTo: raiseEvent.raiseTo,
  potBefore: raiseEvent.potBefore,
  potAfter: raiseEvent.potAfter,
  currentBetBefore: raiseEvent.currentBetBefore,
  currentBetAfter: raiseEvent.currentBetAfter,
}, {
  actorIdx: 1,
  round: 3,
  street: 'flop',
  type: 'raise',
  key: 'medium',
  amount: 150,
  callAmount: 50,
  raiseIncrement: 100,
  raiseTo: 200,
  potBefore,
  potAfter: potBefore + 150,
  currentBetBefore: 100,
  currentBetAfter: 200,
}, 'ActionEvent 必须完整描述行动前后资金语义');
assert.equal(raiseEvent.dealerIdx, 6, 'ActionEvent 必须记录本手庄位');
assert.equal(raiseEvent.position, 'SB', 'ActionEvent 必须按本手座位计算位置');
assert.equal(raiseEvent.playersInHand, 6, 'ActionEvent 必须记录行动时仍在池人数');
assert.deepEqual(raiseEvent.handSeats, [1, 2, 3, 4, 5, 6], 'ActionEvent 必须记录开手座位');
assert.deepEqual(raiseEvent.board, engine.board.slice(0, 3), 'ActionEvent 只能快照当时已揭示公共牌');

const learnedCard = engine.players[2].hole[0];
const privateResult = { kind: 'peek_hole', targetIdx: 2, cardIdx: 1, card: learnedCard };
engine.emit('onSkillResult', 1, privateResult);
assert.equal(privateCallback?.idx, 1, '私有技能原监听器仍须收到同一座位');
assert.strictEqual(privateCallback?.result, privateResult, '私有技能原监听器载荷不得被替换');
engine.emit('onSkillResult', 2, {
  kind: 'peek_board', slot: 4, card: engine.board[3],
});

const observation = buildObservation(engine, engine.players[1]);
assert.equal(observation.observerIdx, 1);
assert.deepEqual(observation.self.hole, engine.players[1].hole, '观察者必须看到自己的两张暗牌');
assert.notStrictEqual(observation.self.hole[0], engine.players[1].hole[0], '自身暗牌必须是拷贝');
assert.deepEqual(observation.board, engine.board.slice(0, 3), '只可看到已揭示公共牌');
assert.notStrictEqual(observation.board[0], engine.board[0], '公共牌必须是拷贝');
for (const publicPlayer of observation.players.slice(1)) {
  assert.equal(Object.hasOwn(publicPlayer, 'hole'), false, '公开玩家快照绝不能含 hole 字段');
}
assert.equal(observation.knowledge.privateSkillResults.length, 1,
  '观察者只能获得发给自己座位的私有技能结果');
assert.deepEqual(observation.knowledge.privateSkillResults[0].result.card, learnedCard,
  '合法窥得的对手牌必须进入该观察者信息集');
assert.equal(observation.knowledge.persistence.gap, null,
  '本地 Engine 必须完整持久化技能知识流');
assert.notStrictEqual(observation.actionHistory[0], engine.actionHistory[0],
  '行动历史不得保留 Engine 内部对象引用');

const serialized = JSON.stringify(observation);
assert.equal(serialized.includes('"deck"'), false, '观察对象不得出现 deck');
assert.equal(serialized.includes('"rank":93'), false, '不得泄露未被窥得的对手暗牌');
assert.equal(serialized.includes('"rank":94'), false, '不得泄露未被窥得的对手暗牌');
assert.equal(serialized.includes('"rank":95'), false, '不得泄露其他座位窥得的未来公共牌');
assert.equal(serialized.includes('"rank":96'), false, '不得泄露未揭示河牌');
assert.equal(serialized.includes('"rank":97'), false, '不得泄露牌堆');
assert.equal(serialized.includes('"rank":91'), true, '合法窥牌知识不应被误删');

assert.equal(Object.isFrozen(observation), true, '观察对象顶层必须只读');
assert.equal(Object.isFrozen(observation.self.hole), true, '自身暗牌数组必须只读');
assert.equal(Object.isFrozen(observation.players[1]), true, '玩家公开快照必须只读');
assert.equal(Object.isFrozen(observation.actionHistory[0].board), true, '历史公共牌必须只读');
assert.throws(() => observation.board.push(C(99, 4)), TypeError,
  '冻结观察对象不得被策略代码篡改');
const observedHp = observation.players[1].hp;
engine.players[1].hp -= 123;
assert.equal(observation.players[1].hp, observedHp, 'Engine 后续变化不得回写既有观察快照');

engine.round = 4;
engine.street = 'preflop';
engine.revealed = 0;
engine.board = [C(31, 1), C(32, 2), C(33, 3), C(34, 4), C(35, 1)];
engine.currentBet = 0;
engine.minRaiseInc = 20;
engine.streetRaiseCount = 0;
for (const player of engine.players.slice(1)) {
  player.betStreet = 0;
  player.betRound = 0;
  player.acted = false;
  player.lastActionBet = 0;
}
engine.applyAction(engine.players[2], { type: 'check' });
assert.deepEqual(engine.actionHistory.slice(-2).map((event) => [event.round, event.street]), [
  [3, 'flop'], [4, 'preflop'],
], '行动历史必须跨街、跨手保留并可区分');
assert.equal(engine.actionHistory.at(-1).board.length, 0, '翻前历史不得包含预发公共牌');

const blindEngine = new Engine(Array(6).fill('lianpo'), {}, new Set());
blindEngine.startRound();
assert.deepEqual(blindEngine.actionHistory.map((event) => event.key),
  ['smallBlind', 'bigBlind'], '完整公开历史必须包含两笔强制盲注');
assert.equal(blindEngine.actionHistory.every((event) => event.forced), true,
  '盲注 ActionEvent 必须标记为强制投入');

const ninePlayers = [null];
for (let idx = 1; idx <= 9; idx++) {
  ninePlayers.push({
    idx,
    playerName: `P${idx}`,
    hero: HEROES[(idx - 1) % HEROES.length],
    isHuman: idx === 5,
    hp: 1500,
    energy: 3,
    alive: true,
    folded: false,
    allIn: false,
    betStreet: 20,
    betRound: 20,
    acted: false,
    lastAction: null,
    skillUsed: false,
    skillStatuses: [],
    skillData: { revealedCard: null },
    showdownInfo: null,
    hole: [C(40 + idx * 2, 1), C(41 + idx * 2, 2)],
  });
}
const nineSeatEngine = {
  players: ninePlayers,
  round: 7,
  street: 'turn',
  dealerIdx: 9,
  actingIdx: 5,
  waitingIdx: null,
  gameOver: false,
  board: [C(2, 1), C(3, 2), C(4, 3), C(5, 4), C(98, 1)],
  revealed: 4,
  deck: [C(99, 2)],
  currentHandSeats: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  currentBet: 40,
  minRaiseInc: 20,
  streetRaiseCount: 1,
  actionHistory: [],
  totalPot() {
    return this.players.slice(1).reduce((sum, candidate) => sum + candidate.betRound, 0);
  },
  getOptions(player) {
    return {
      toCall: 20,
      canCheck: false,
      callAmt: 20,
      allinAmt: player.hp,
      canRaise: true,
      canAllIn: true,
      tiers: [{ key: 'small', name: '小注', inc: 40, cost: 60 }],
    };
  },
};

const nineObservation = buildObservation(nineSeatEngine, 5);
assert.equal(MAX_SUPPORTED_SEATS, 9);
assert.equal(nineObservation.seatCount, 9, '观察结构必须支持九个座位');
assert.equal(nineObservation.players.length, 10, '九人桌继续采用一基座位数组');
assert.equal(nineObservation.players[9].position, 'BTN');
assert.equal(nineObservation.players[1].position, 'SB');
assert.equal(nineObservation.players[2].position, 'BB');
assert.equal(nineObservation.players[3].position, 'UTG');
assert.equal(nineObservation.players[8].position, 'CO');
assert.equal(nineObservation.legalActions.callAmount, 20, '轮到观察者时应提供安全的合法动作快照');
assert.match(nineObservation.knowledge.persistence.gap, /does not persist/,
  '不具备技能事件持久化的外部状态必须明确报告缺口');
assert.equal(JSON.stringify(nineObservation).includes('"rank":98'), false,
  '九人观察结构同样不得泄露未揭示河牌');
assert.equal(JSON.stringify(nineObservation).includes('"rank":99'), false,
  '九人观察结构同样不得泄露牌堆');

console.log('机器人信息集自检通过：完整行动历史、私有知识隔离、不可变快照与九人桌结构正常');

