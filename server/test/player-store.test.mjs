import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PlayerValidationError,
  createPlayerStore,
  normalizeEmblem,
  normalizeGuestId,
  normalizeNickname,
} from '../player-store.mjs';

async function withTempDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'qyj-player-store-'));
  const databasePath = join(directory, 'players.sqlite');
  try {
    await run({ directory, databasePath });
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}

function assertValidation(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof PlayerValidationError);
    assert.equal(error.code, code);
    return true;
  });
}

test('guestId 建档后跨数据库重开保持稳定身份与资料', async () => {
  await withTempDatabase(async ({ databasePath }) => {
    let now = Date.UTC(2026, 6, 11, 1, 2, 3);
    const firstStore = createPlayerStore({ databasePath, now: () => now });
    const first = firstStore.identify({
      guestId: 'guest-device_1234567890',
      nickname: '燕云客',
      emblem: '墨',
    });
    assert.equal(first.created, true);
    assert.match(first.profile.playerId, /^p_[A-Za-z0-9_-]{20,64}$/u);
    assert.match(first.profile.shortId, /^[0-9A-F]{8}$/u);
    assert.equal(first.profile.nickname, '燕云客');
    assert.equal(first.profile.emblem, '墨');
    assert.equal(first.profile.createdAt, new Date(now).toISOString());
    assert.deepEqual(first.profile.stats, {
      matches: 0, wins: 0, top3: 0, winRate: 0, bestRank: null,
    });
    assert.deepEqual(first.profile.recentMatches, []);
    const saved = firstStore.updateProfile(first.profile.playerId, {
      nickname: '持久客',
      emblem: '月',
    });
    assert.equal(saved.nickname, '持久客');
    assert.equal(saved.emblem, '月');
    firstStore.close();

    now += 60_000;
    const reopened = createPlayerStore({ databasePath, now: () => now });
    const again = reopened.identify({
      guestId: 'guest-device_1234567890',
      // identify 的资料字段仅用于首次建档，避免旧本地缓存覆盖服务端资料。
      nickname: '不应覆盖',
      emblem: '月',
    });
    assert.equal(again.created, false);
    assert.equal(again.profile.playerId, first.profile.playerId);
    assert.equal(again.profile.shortId, first.profile.shortId);
    assert.equal(again.profile.nickname, '持久客');
    assert.equal(again.profile.emblem, '月');
    assert.equal(again.profile.createdAt, first.profile.createdAt);
    assert.equal(again.profile.lastSeenAt, new Date(now).toISOString());
    reopened.close();

    const bytes = await readFile(databasePath);
    assert.equal(bytes.includes(Buffer.from('guest-device_1234567890')), false,
      '数据库只保存 guestId 哈希，不落明文设备标识');
  });
});

test('资料更新安全校验并持久化昵称与纹章', async () => {
  const store = createPlayerStore({ databasePath: ':memory:' });
  try {
    const { profile } = store.identify({
      guestId: '550e8400-e29b-41d4-a716-446655440000',
      nickname: '  羽林郎  ',
      emblem: '侠',
    });
    const updated = store.updateProfile(profile.playerId, { nickname: '墨客', emblem: '月' });
    assert.equal(updated.nickname, '墨客');
    assert.equal(updated.emblem, '月');
    assert.equal(store.getProfile(profile.playerId).nickname, '墨客');

    assertValidation(
      () => store.updateProfile(profile.playerId, { nickname: '<script>' }),
      'INVALID_NAME',
    );
    assertValidation(
      () => store.updateProfile(profile.playerId, { emblem: '任意图片地址' }),
      'INVALID_EMBLEM',
    );
    assertValidation(() => store.updateProfile(profile.playerId, {}), 'INVALID_PROFILE');
  } finally {
    store.close();
  }
});

test('一场对局原子累计统计、生成最近战绩且 matchId 幂等', () => {
  let now = Date.UTC(2026, 6, 11, 2, 0, 0);
  const store = createPlayerStore({ databasePath: ':memory:', now: () => now });
  try {
    const a = store.identify({
      guestId: 'guest-first-player-0001', nickname: '甲', emblem: '侠',
    }).profile;
    const b = store.identify({
      guestId: 'guest-second-player-0002', nickname: '乙', emblem: '群',
    }).profile;

    const first = store.recordMatch({
      matchId: 'match_20260711_001',
      playedAt: now,
      results: [
        { playerId: a.playerId, placement: 1, heroId: 'xiangyu', survived: true },
        { playerId: b.playerId, placement: 4, heroId: 'diaochan', survived: false },
      ],
    });
    assert.equal(first.inserted, 2);
    assert.deepEqual(store.getProfile(a.playerId).stats, {
      matches: 1, wins: 1, top3: 1, winRate: 100, bestRank: 1,
    });
    assert.deepEqual(store.getProfile(b.playerId).stats, {
      matches: 1, wins: 0, top3: 0, winRate: 0, bestRank: 4,
    });
    assert.deepEqual(store.getProfile(a.playerId).recentMatches[0], {
      matchId: 'match_20260711_001',
      placement: 1,
      heroId: 'xiangyu',
      playedAt: new Date(now).toISOString(),
      survived: true,
    });

    const duplicate = store.recordMatch({
      matchId: 'match_20260711_001',
      playedAt: now,
      results: [
        { playerId: a.playerId, placement: 1, heroId: 'xiangyu', survived: true },
        { playerId: b.playerId, placement: 4, heroId: 'diaochan', survived: false },
      ],
    });
    assert.equal(duplicate.inserted, 0);
    assert.equal(store.getProfile(a.playerId).stats.matches, 1);

    now += 60_000;
    store.recordMatch({
      matchId: 'match_20260711_002',
      results: [
        { playerId: a.playerId, placement: 3, heroId: 'xiangyu', survived: false },
        { playerId: b.playerId, placement: 2, heroId: 'diaochan', survived: true },
      ],
    });
    assert.deepEqual(store.getProfile(a.playerId).stats, {
      matches: 2, wins: 1, top3: 2, winRate: 50, bestRank: 1,
    });
    assert.deepEqual(store.getProfile(b.playerId).stats, {
      matches: 2, wins: 0, top3: 1, winRate: 0, bestRank: 2,
    });
    assert.equal(store.getProfile(a.playerId).recentMatches[0].matchId, 'match_20260711_002');
  } finally {
    store.close();
  }
});

test('非法批次在事务开始前拒绝且不产生部分统计', () => {
  const store = createPlayerStore({ databasePath: ':memory:' });
  try {
    const player = store.identify({
      guestId: 'guest-atomic-player-0001', nickname: '原子客', emblem: '侠',
    }).profile;
    assertValidation(() => store.recordMatch({
      matchId: 'match_atomic_001',
      results: [
        { playerId: player.playerId, placement: 2, heroId: 'xiangyu' },
        { playerId: `p_${'x'.repeat(22)}`, placement: 3, heroId: 'diaochan' },
      ],
    }), 'PLAYER_NOT_IDENTIFIED');
    assert.equal(store.getProfile(player.playerId).stats.matches, 0);
    assert.deepEqual(store.getProfile(player.playerId).recentMatches, []);
  } finally {
    store.close();
  }
});

test('身份、昵称与纹章验证拒绝路径/控制字符/未知纹章', () => {
  assert.equal(normalizeGuestId('guest-valid_device.0001'), 'guest-valid_device.0001');
  assert.equal(normalizeNickname('  青州客  '), '青州客');
  assert.equal(normalizeEmblem('群'), '群');
  assertValidation(() => normalizeGuestId('../../etc/passwd'), 'INVALID_GUEST_ID');
  assertValidation(() => normalizeGuestId('short'), 'INVALID_GUEST_ID');
  assertValidation(() => normalizeNickname('甲\n乙'), 'INVALID_NAME');
  assertValidation(() => normalizeNickname('超过八个字符的玩家名称'), 'INVALID_NAME');
  assertValidation(() => normalizeEmblem('https://example.com/a.svg'), 'INVALID_EMBLEM');
});
