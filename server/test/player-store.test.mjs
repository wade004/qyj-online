import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  PLAYER_SCHEMA_VERSION,
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
    assert.ok(Number.isInteger(first.profile.avatarId));
    assert.ok(first.profile.avatarId >= 1 && first.profile.avatarId <= 20);
    assert.equal(first.profile.createdAt, new Date(now).toISOString());
    assert.deepEqual(first.profile.stats, {
      matches: 0, wins: 0, top3: 0, winRate: 0, bestRank: null,
    });
    assert.deepEqual(first.profile.recentMatches, []);
    const saved = firstStore.updateProfile(first.profile.playerId, {
      nickname: '持久客',
      emblem: '月',
      avatarId: 12,
    });
    assert.equal(saved.nickname, '持久客');
    assert.equal(saved.emblem, '月');
    assert.equal(saved.avatarId, 12);
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
    assert.equal(again.profile.avatarId, 12);
    assert.equal(again.profile.createdAt, first.profile.createdAt);
    assert.equal(again.profile.lastSeenAt, new Date(now).toISOString());
    reopened.close();

    const bytes = await readFile(databasePath);
    assert.equal(bytes.includes(Buffer.from('guest-device_1234567890')), false,
      '数据库只保存 guestId 哈希，不落明文设备标识');
  });
});

test('资料更新安全校验并持久化昵称、纹章与头像', async () => {
  const store = createPlayerStore({ databasePath: ':memory:' });
  try {
    const { profile } = store.identify({
      guestId: '550e8400-e29b-41d4-a716-446655440000',
      nickname: '  羽林郎  ',
      emblem: '侠',
    });
    const updated = store.updateProfile(profile.playerId, {
      nickname: '墨客', emblem: '月', avatarId: 20,
    });
    assert.equal(updated.nickname, '墨客');
    assert.equal(updated.emblem, '月');
    assert.equal(updated.avatarId, 20);
    assert.equal(store.getProfile(profile.playerId).nickname, '墨客');

    assertValidation(
      () => store.updateProfile(profile.playerId, { nickname: '<script>' }),
      'INVALID_NAME',
    );
    assertValidation(
      () => store.updateProfile(profile.playerId, { emblem: '任意图片地址' }),
      'INVALID_EMBLEM',
    );
    assertValidation(
      () => store.updateProfile(profile.playerId, { avatarId: 21 }),
      'INVALID_AVATAR',
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
      tableSize: 6,
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

test('9 人桌允许第 9 名并持久化桌型，旧调用仍默认 6 人桌', () => {
  const store = createPlayerStore({ databasePath: ':memory:' });
  try {
    const player = store.identify({
      guestId: 'guest-nine-seat-player-0001', nickname: '九席客', emblem: '侠',
    }).profile;
    const written = store.recordMatch({
      matchId: 'match_nine_seat_001',
      tableSize: 9,
      results: [
        { playerId: player.playerId, placement: 9, heroId: 'xiangyu', survived: false },
      ],
    });
    assert.equal(written.inserted, 1);
    assert.equal(store.getProfile(player.playerId).stats.bestRank, 9);
    assert.equal(store.getProfile(player.playerId).recentMatches[0].tableSize, 9);
    const stored = store.db.prepare(`
      SELECT table_size, placement FROM player_match_results WHERE match_id = ?
    `).get('match_nine_seat_001');
    assert.equal(stored.table_size, 9);
    assert.equal(stored.placement, 9);
    assert.throws(() => store.recordMatch({
      matchId: 'match_six_seat_invalid_rank',
      results: [
        { playerId: player.playerId, placement: 9, heroId: 'xiangyu', survived: false },
      ],
    }), (error) => error instanceof PlayerValidationError
      && error.code === 'INVALID_MATCH_RESULT');
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

test('schema v4 migration backfills only account profiles still using the system-default nickname', async () => {
  await withTempDatabase(async ({ databasePath }) => {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE players (
        player_id TEXT PRIMARY KEY,
        short_id TEXT NOT NULL UNIQUE,
        guest_hash TEXT NOT NULL UNIQUE,
        nickname TEXT NOT NULL,
        emblem TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        matches INTEGER NOT NULL DEFAULT 0 CHECK (matches >= 0),
        wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
        top3 INTEGER NOT NULL DEFAULT 0 CHECK (top3 >= 0),
        best_rank INTEGER CHECK (best_rank BETWEEN 1 AND 9 OR best_rank IS NULL)
      );
      CREATE TABLE player_accounts (
        player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        username_key TEXT NOT NULL UNIQUE
          CHECK (length(username_key) BETWEEN 3 AND 20),
        email TEXT NOT NULL,
        email_key TEXT NOT NULL UNIQUE
          CHECK (length(email_key) BETWEEN 3 AND 254),
        password_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'disabled')),
        auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        password_changed_at INTEGER NOT NULL,
        last_login_at INTEGER
      );
      PRAGMA user_version = 4;
    `);
    const createdAt = Date.UTC(2026, 6, 1);
    const defaultPlayerId = `p_${'D'.repeat(22)}`;
    const customPlayerId = `p_${'C'.repeat(22)}`;
    const guestOnlyPlayerId = `p_${'G'.repeat(22)}`;
    const insertPlayer = legacy.prepare(`
      INSERT INTO players (
        player_id, short_id, guest_hash, nickname, emblem, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertPlayer.run(
      defaultPlayerId, 'D0000001', 'legacy-default-account-hash', '无名侠客', '侠',
      createdAt, createdAt,
    );
    insertPlayer.run(
      customPlayerId, 'C0000001', 'legacy-custom-account-hash', '自定义侠客', '群',
      createdAt, createdAt,
    );
    insertPlayer.run(
      guestOnlyPlayerId, 'G0000001', 'legacy-default-guest-hash', '无名侠客', '墨',
      createdAt, createdAt,
    );
    const insertAccount = legacy.prepare(`
      INSERT INTO player_accounts (
        player_id, username, username_key, email, email_key, password_hash,
        created_at, updated_at, password_changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertAccount.run(
      defaultPlayerId, '阳顶天', '阳顶天', 'legacy.default@example.com',
      'legacy.default@example.com', 'legacy-password-hash', createdAt, createdAt, createdAt,
    );
    insertAccount.run(
      customPlayerId, '东方白', '东方白', 'legacy.custom@example.com',
      'legacy.custom@example.com', 'legacy-password-hash', createdAt, createdAt, createdAt,
    );
    legacy.close();

    assert.ok(PLAYER_SCHEMA_VERSION > 4, '昵称回填需要通过 v4 之后的 schema 迁移发布');
    const store = createPlayerStore({ databasePath });
    try {
      assert.equal(store.getProfile(defaultPlayerId).nickname, '阳顶天');
      assert.equal(store.getProfile(customPlayerId).nickname, '自定义侠客');
      assert.equal(store.getProfile(guestOnlyPlayerId).nickname, '无名侠客');
      assert.equal(
        Number(store.db.prepare('PRAGMA user_version').get().user_version),
        PLAYER_SCHEMA_VERSION,
      );
    } finally {
      store.close();
    }
  });
});
