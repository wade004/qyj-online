import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { PLAYER_SCHEMA_VERSION, createPlayerStore } from '../player-store.mjs';

const C = (r, s) => ({ r, s });

function player(store, suffix, nickname) {
  return store.identify({
    guestId: `hand-history-device-${suffix}`,
    nickname,
    emblem: '侠',
  }).profile;
}

function firstHand(one, two) {
  return {
    matchId: 'match-hand-history-001',
    round: 1,
    roomId: 1288,
    roomName: '青龙殿·牌谱测试',
    tableSize: 6,
    dealerSeat: 3,
    resolution: 'showdown',
    board: [C(2, 1), C(7, 2), C(9, 3), C(11, 4), C(14, 1)],
    pots: [{ label: '主池', amount: 120, winnerSeats: [2] }],
    players: [
      {
        seat: 1, playerId: one.playerId, playerName: one.nickname, heroId: 'diaochan',
        hole: [C(13, 1), C(12, 2)], publicHole: [null, null],
        folded: true, allIn: false, netResult: -40, wonAmount: 0,
      },
      {
        seat: 2, playerId: two.playerId, playerName: two.nickname, heroId: 'zhugeliang',
        hole: [C(14, 2), C(14, 3)], publicHole: [C(14, 2), C(14, 3)],
        folded: false, allIn: true, netResult: 60, wonAmount: 120, handName: '三才归一',
      },
      {
        seat: 3, playerName: 'AI·韩信', heroId: 'hanxin',
        hole: [C(10, 4), C(8, 1)], publicHole: [C(10, 4), null],
        folded: true, allIn: false, netResult: -20, wonAmount: 0,
      },
    ],
  };
}

test('逐局牌谱按本人权限裁剪：自己的牌完整、弃牌对手隐藏、公开牌按单张掩码展示', () => {
  const store = createPlayerStore({ databasePath: ':memory:' });
  try {
    const one = player(store, 'one-0001', '甲方牌手');
    const two = player(store, 'two-0002', '乙方牌手');
    const outsider = player(store, 'outside-0003', '局外牌手');
    const hand = firstHand(one, two);

    assert.deepEqual(store.recordHandHistory(hand).inserted, 1);
    assert.deepEqual(store.recordHandHistory(hand).inserted, 0, '重复结算回调必须幂等');

    const oneHistory = store.getHandHistory(one.playerId);
    assert.equal(oneHistory.items.length, 1);
    assert.equal(oneHistory.items[0].roomId, 1288);
    assert.equal(oneHistory.items[0].roomName, '青龙殿·牌谱测试');
    assert.equal(oneHistory.items[0].round, 1);
    assert.equal(oneHistory.items[0].selfNetResult, -40);
    assert.deepEqual(oneHistory.items[0].board, hand.board);
    assert.deepEqual(oneHistory.items[0].players[0].hole, hand.players[0].hole, '本人弃牌后仍可看自己的底牌');
    assert.deepEqual(oneHistory.items[0].players[1].hole, hand.players[1].hole, '实际摊牌的对手应公开两张');
    assert.deepEqual(oneHistory.items[0].players[2].hole, [C(10, 4), null], '只公开一张时不得泄露另一张');

    const twoHistory = store.getHandHistory(two.playerId);
    assert.deepEqual(twoHistory.items[0].players[0].hole, [null, null], '弃牌对手的底牌必须保持隐藏');
    assert.deepEqual(twoHistory.items[0].players[1].hole, hand.players[1].hole, '本人底牌始终完整');
    assert.equal(JSON.stringify(twoHistory).includes('"r":13,"s":1'), false, '脱敏 DTO 不得夹带弃牌原始牌值');
    assert.deepEqual(store.getHandHistory(outsider.playerId).items, [], '局外账号不能查询该手牌');

    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM poker_hand_records').get().count, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM poker_hand_record_players').get().count, 3);
  } finally {
    store.close();
  }
});

test('牌谱支持游标分页，并在 schema v5 数据库上原地新增 v6 表后持久可读', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qyj-hand-history-'));
  const databasePath = join(directory, 'players.sqlite');
  try {
    let store = createPlayerStore({ databasePath });
    const one = player(store, 'persist-one', '持久甲');
    const two = player(store, 'persist-two', '持久乙');
    store.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE poker_hand_record_players;
      DROP TABLE poker_hand_records;
      PRAGMA user_version = 5;
    `);
    legacy.close();

    store = createPlayerStore({ databasePath });
    assert.equal(Number(store.db.prepare('PRAGMA user_version').get().user_version), PLAYER_SCHEMA_VERSION);
    const first = firstHand(one, two);
    store.recordHandHistory(first);
    store.recordHandHistory({
      ...first,
      round: 2,
      resolution: 'uncontested',
      dealerSeat: 4,
      board: [],
      pots: [{ label: '主池', amount: 30, winnerSeats: [1] }],
      players: [
        { ...first.players[0], hole: [C(3, 1), C(4, 2)], publicHole: [null, null], folded: false, netResult: 20, wonAmount: 30 },
        { ...first.players[1], hole: [C(5, 3), C(6, 4)], publicHole: [null, null], folded: true, allIn: false, netResult: -10, wonAmount: 0, handName: null },
      ],
    });
    const pageOne = store.getHandHistory(one.playerId, { limit: 1 });
    assert.equal(pageOne.items.length, 1);
    assert.equal(pageOne.items[0].round, 2);
    assert.ok(pageOne.nextCursor);
    const pageTwo = store.getHandHistory(one.playerId, { limit: 1, beforeId: pageOne.nextCursor });
    assert.equal(pageTwo.items[0].round, 1);
    store.close();

    store = createPlayerStore({ databasePath });
    assert.equal(store.getHandHistory(one.playerId).items.length, 2, '数据库关闭重开后逐手牌谱仍应可读');
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
