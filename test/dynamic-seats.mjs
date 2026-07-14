import { Engine } from '../js/game/engine.js';
import { HEROES } from '../js/game/heroes.js';
import { RemoteEngine } from '../js/net/remoteengine.js';

const assert = (condition, message) => {
  if (!condition) throw new Error(`动态桌型断言失败：${message}`);
};

const assertRangeError = (fn, message) => {
  let error = null;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof RangeError, message);
};

const heroIds = HEROES.slice(0, 9).map((hero) => hero.id);
const allNineHumanSeats = new Set(Array.from({ length: 9 }, (_, index) => index + 1));

function createEngine(tableSize, listeners = {}) {
  const humanSeats = new Set(Array.from({ length: tableSize }, (_, index) => index + 1));
  return new Engine(heroIds, listeners, humanSeats, {}, { tableSize });
}

function prepareNineSeatHand(engine) {
  engine.dealerIdx = 9;
  engine.startRound();
  // These tests drive the state machine synchronously; discard presentation/AI delays.
  engine.queue.length = 0;
  engine.waitingIdx = null;
  engine.actingIdx = 0;
  return engine;
}

// Six- and nine-seat engines must coexist without leaking instance state.
const six = createEngine(6);
const nine = createEngine(9);
assert(six.tableSize === 6 && six.players.length === 7,
  '六人桌必须维持 1-based 的六个席位');
assert(nine.tableSize === 9 && nine.players.length === 10,
  '九人桌必须生成 1-based 的九个席位');
assert(six.privateSkillKnowledge.length === 7,
  '六人桌私有知识必须严格按六席隔离');
assert(nine.privateSkillKnowledge.length === 10,
  '九人桌私有知识必须严格按九席隔离');

nine.players[1].hp = 777;
nine.privateSkillKnowledge[1].push({ id: 'nine-only' });
assert(six.players[1].hp === 1500 && six.privateSkillKnowledge[1].length === 0,
  '九人桌玩家状态不得污染同时存在的六人桌实例');
assert(six.players[7] === undefined && nine.players[7]?.idx === 7,
  '六人桌不得因九人桌实例扩充全局席位');

six.dealerIdx = 6;
nine.dealerIdx = 9;
six.startRound();
nine.startRound();
six.queue.length = 0;
nine.queue.length = 0;
assert(six.deck.length === 35, '六人桌发出 12 张暗牌和 5 张公共牌后应剩 35 张');
assert(nine.deck.length === 29, '九人桌发出 18 张暗牌和 5 张公共牌后应剩 29 张');
assert(six.players.length === 7 && nine.players.length === 10,
  '分别开局后六人桌与九人桌仍须保持独立桌型');

// A real nine-seat betting rotation must visit seats 7, 8 and 9, then wrap to 1.
const rotation = prepareNineSeatHand(new Engine(
  heroIds,
  {},
  allNineHumanSeats,
  {},
  { tableSize: 9 },
));
for (const player of rotation.players.slice(1)) {
  player.alive = true;
  player.folded = false;
  player.allIn = false;
  player.betStreet = 0;
  player.acted = false;
}
rotation.currentBet = 0;
rotation.actionCursorIdx = 6;
rotation.proceedAction();
for (const expectedSeat of [7, 8, 9]) {
  assert(rotation.waitingIdx === expectedSeat && rotation.actingIdx === expectedSeat,
    `九人桌行动应轮到 ${expectedSeat} 号位`);
  rotation.playerAct({ type: 'check' });
  rotation.queue.length = 0;
  assert(rotation.players[expectedSeat].acted,
    `${expectedSeat} 号位完成行动后必须标记 acted`);
  rotation.proceedAction();
}
assert(rotation.waitingIdx === 1 && rotation.actingIdx === 1,
  '九号位行动完成后必须回到一号位，而不是按六人桌截断');

// A full raise from seat 9 reopens action for every other seat, including 7 and 8.
const reopen = prepareNineSeatHand(createEngine(9));
for (const player of reopen.players.slice(1)) {
  player.acted = true;
  player.betStreet = 20;
  player.lastActionBet = 20;
}
reopen.currentBet = 20;
reopen.minRaiseInc = 20;
reopen.applyAction(reopen.players[9], {
  type: 'raise',
  tier: { key: 'feint', name: '佯攻', inc: 20 },
});
reopen.queue.length = 0;
assert(reopen.players[9].acted, '九号位加注者应保持已行动状态');
assert(reopen.players.slice(1, 9).every((player) => !player.acted),
  '九号位完整加注必须重置一至八号位 acted，不能漏掉七八号位');

// Advancing a street resets betting state for all nine seats.
const streetReset = prepareNineSeatHand(createEngine(9));
streetReset.street = 'preflop';
streetReset.currentBet = 45;
for (const player of streetReset.players.slice(1)) {
  player.acted = true;
  player.betStreet = player.idx * 5;
  player.lastActionBet = 45;
  player.lastAction = { key: 'call', amount: 5, street: 'preflop', round: 1 };
}
streetReset.advanceStreet();
streetReset.queue.length = 0;
assert(streetReset.street === 'flop' && streetReset.revealed === 3,
  '九人桌应正常从暗令推进至天时');
assert(streetReset.players.slice(1).every((player) => (
  !player.acted
  && player.betStreet === 0
  && player.lastActionBet === 0
  && player.lastAction === null
)), '跨街必须重置一至九号位的 acted、街注和最近操作');

// Seats 7-9 must participate in elimination bookkeeping and final ranking.
let finalRanking = null;
const deaths = [];
const rankingEngine = createEngine(9, {
  onDeath: (idx) => deaths.push(idx),
  onGameOver: (ranking) => { finalRanking = ranking; },
});
rankingEngine.round = 5;
for (const player of rankingEngine.players.slice(1)) {
  player.hp = 1000 + player.idx;
  player.alive = true;
}
for (const idx of [7, 8, 9]) rankingEngine.players[idx].hp = 0;
rankingEngine.endRound();
rankingEngine.queue.length = 0;
assert(deaths.join(',') === '7,8,9',
  '九人桌回合结算必须处理七至九号位阵亡事件');
assert([7, 8, 9].every((idx) => (
  !rankingEngine.players[idx].alive
  && rankingEngine.players[idx].deathRound === 5
  && rankingEngine.players[idx].deathOrder === idx - 6
)), '七至九号位必须记录稳定的阵亡回合与顺序');
rankingEngine.doGameOver();
assert(finalRanking?.length === 9, '九人桌终局排名必须包含全部九席');
assert(finalRanking.slice(-3).map((player) => player.idx).join(',') === '9,8,7',
  '同回合阵亡排名应包含七至九号位并按既有 deathOrder 规则排列');

// RemoteEngine must mirror and validate a complete nine-seat authoritative table.
const remotePlayers = heroIds.map((heroId, index) => ({
  seat: index + 1,
  heroId,
  name: `联机玩家${index + 1}`,
  isHuman: index < 2,
}));
const remote = new RemoteEngine({
  tableSize: 9,
  mySeat: 9,
  players: remotePlayers,
}, {}, () => true);
assert(remote.tableSize === 9 && remote.players.length === 10 && remote.myIdx === 9,
  'RemoteEngine 必须建立完整九席并允许本机位于九号位');

const remoteSnapshotPlayers = remotePlayers.map(({ seat }) => ({
  seat,
  hp: seat === 9 ? 909 : 1500,
  energy: 2,
  alive: true,
  folded: false,
  allIn: false,
  betStreet: 0,
  betRound: 0,
  acted: seat === 9,
  lastAction: seat === 9
    ? { key: 'check', amount: 0, street: 'preflop', round: 2 }
    : null,
  skillUsed: false,
  skillModifiers: [],
}));
remote.applySnapshot({ tableSize: 9, round: 2, players: remoteSnapshotPlayers });
assert(remote.round === 2 && remote.players[9].hp === 909 && remote.players[9].acted,
  '九人桌公开快照必须同步九号位状态');

const roundBeforeMismatch = remote.round;
assertRangeError(
  () => remote.applySnapshot({ tableSize: 6, round: 99 }),
  'RemoteEngine 必须拒绝与 gameStart 桌型不一致的快照',
);
assert(remote.round === roundBeforeMismatch,
  '拒绝桌型不一致快照时不得部分写入远程状态');

assertRangeError(
  () => new RemoteEngine({ tableSize: 9, mySeat: 1, players: remotePlayers.slice(0, 8) }, {}, () => true),
  '九人桌 gameStart 缺席位时必须拒绝初始化',
);
assertRangeError(
  () => new RemoteEngine({
    tableSize: 9,
    mySeat: 1,
    players: remotePlayers.map((player, index) => (
      index === 8 ? { ...player, seat: 8 } : player
    )),
  }, {}, () => true),
  '九人桌 gameStart 座位重复时必须拒绝初始化',
);

const inferredRemote = new RemoteEngine({ mySeat: 1, players: remotePlayers }, {}, () => true);
assert(inferredRemote.tableSize === 9 && inferredRemote.players.length === 10,
  '兼容消息缺少 tableSize 时，应从九名玩家安全推断九人桌');

assertRangeError(
  () => new Engine(heroIds, {}, new Set(), {}, { tableSize: 7 }),
  '非法七人桌必须被规则引擎拒绝',
);

console.log('动态 6/9 人桌自检通过：实例隔离、7-9 号位轮转、行动/跨街重置、阵亡排名与远程快照校验正常');
