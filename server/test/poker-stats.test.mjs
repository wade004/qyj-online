import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { HEROES } from '../../js/game/heroes.js';
import { Engine } from '../../js/game/engine.js';
import {
  PLAYER_SCHEMA_VERSION,
  createPlayerStore,
} from '../player-store.mjs';
import { createPokerHandTracker } from '../server.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

async function withTempDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'qyj-poker-stats-'));
  const databasePath = join(directory, 'qyj.sqlite');
  try {
    await run(databasePath);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}

function identity(store, suffix = '0001') {
  return store.identify({
    guestId: `guest-poker-stats-${suffix}`,
    nickname: `牌客${suffix.slice(-1)}`,
    emblem: '侠',
  }).profile;
}

function blankHand(playerId, round, patch = {}) {
  return {
    playerId,
    round,
    vpip: 0,
    pfr: 0,
    threeBet: 0,
    threeBetOpportunity: 0,
    postflopAggressiveActions: 0,
    postflopCallActions: 0,
    postflopFoldActions: 0,
    sawFlop: 0,
    showdown: 0,
    showdownWin: 0,
    cbet: 0,
    cbetOpportunity: 0,
    foldToCbet: 0,
    foldToCbetOpportunity: 0,
    ...patch,
  };
}

test('扑克 HUD 按官方分母聚合，空分母为 null 且逐手写入幂等', () => {
  const now = Date.UTC(2026, 6, 11, 12, 0, 0);
  const store = createPlayerStore({ databasePath: ':memory:', now: () => now });
  try {
    const player = identity(store);
    assert.deepEqual(player.pokerStats, {
      rangeLabel: '近30天 · 最近200手',
      windowDays: 30,
      maxHands: 200,
      hands: 0,
      confidence: 'none',
      vpip: null,
      pfr: null,
      threeBet: null,
      af: null,
      wtsd: null,
      wsd: null,
      cbet: null,
      foldToCbet: null,
    });

    // 超出 30 天的记录应保留在明细表，但不进入默认 HUD 窗口。
    store.recordHands({
      matchId: 'poker_old_match',
      playedAt: now - 31 * DAY_MS,
      hands: [blankHand(player.playerId, 1, { vpip: 1 })],
    });
    const hands = [
      blankHand(player.playerId, 1, {
        vpip: 1, pfr: 1, threeBet: 1, threeBetOpportunity: 1,
        postflopAggressiveActions: 2, postflopCallActions: 1,
        sawFlop: 1, showdown: 1, showdownWin: 1,
        cbet: 1, cbetOpportunity: 1,
      }),
      blankHand(player.playerId, 2, {
        vpip: 1, threeBetOpportunity: 1,
        postflopCallActions: 1, postflopFoldActions: 1,
        sawFlop: 1, showdown: 1,
        cbetOpportunity: 1,
        foldToCbet: 1, foldToCbetOpportunity: 1,
      }),
      blankHand(player.playerId, 3, {
        postflopAggressiveActions: 1, postflopFoldActions: 1,
        sawFlop: 1, foldToCbetOpportunity: 1,
      }),
    ];
    const first = store.recordHands({
      matchId: 'poker_formula_match', playedAt: now, hands,
    });
    assert.equal(first.insertedHands, 3);
    const duplicate = store.recordHands({
      matchId: 'poker_formula_match', playedAt: now, hands,
    });
    assert.equal(duplicate.insertedHands, 0);

    assert.deepEqual(store.getProfile(player.playerId).pokerStats, {
      rangeLabel: '近30天 · 最近200手',
      windowDays: 30,
      maxHands: 200,
      hands: 3,
      confidence: 'low',
      vpip: 66.7,
      pfr: 33.3,
      threeBet: 50,
      af: 1.5,
      wtsd: 66.7,
      wsd: 50,
      cbet: 50,
      foldToCbet: 50,
    });
  } finally {
    store.close();
  }
});

test('默认窗口最多聚合最近 200 手并按统一阈值输出 confidence', () => {
  const now = Date.UTC(2026, 6, 11, 12, 0, 0);
  const store = createPlayerStore({ databasePath: ':memory:', now: () => now });
  try {
    const player = identity(store, '0002');
    let written = 0;
    const append = (count, prefix) => {
      while (count > 0) {
        const batch = Math.min(12, count);
        const matchId = `${prefix}_${written}`;
        store.recordHands({
          matchId,
          playedAt: now - written,
          hands: Array.from({ length: batch }, (_, index) =>
            blankHand(player.playerId, index + 1)),
        });
        written += batch;
        count -= batch;
      }
    };

    append(29, 'confidence_low');
    assert.equal(store.getProfile(player.playerId).pokerStats.confidence, 'low');
    append(1, 'confidence_medium');
    assert.equal(store.getProfile(player.playerId).pokerStats.confidence, 'medium');
    append(70, 'confidence_high');
    assert.equal(store.getProfile(player.playerId).pokerStats.confidence, 'high');
    append(105, 'confidence_cap');
    const stats = store.getProfile(player.playerId).pokerStats;
    assert.equal(stats.hands, 200);
    assert.equal(stats.confidence, 'high');
  } finally {
    store.close();
  }
});

test('recordGame 在同一事务写逐手与赛果并对整场重放幂等', () => {
  const store = createPlayerStore({ databasePath: ':memory:' });
  try {
    const player = identity(store, '0003');
    const payload = {
      matchId: 'atomic_poker_game_001',
      results: [{
        playerId: player.playerId,
        placement: 2,
        heroId: 'xiangyu',
        survived: true,
      }],
      hands: [blankHand(player.playerId, 1, { vpip: 1, pfr: 1 })],
    };
    const first = store.recordGame(payload);
    assert.equal(first.inserted, 1);
    assert.equal(first.insertedHands, 1);
    assert.equal(first.profiles[0].stats.matches, 1);
    assert.equal(first.profiles[0].pokerStats.hands, 1);

    const replay = store.recordGame(payload);
    assert.equal(replay.inserted, 0);
    assert.equal(replay.insertedHands, 0);
    assert.equal(replay.profiles[0].stats.matches, 1);
    assert.equal(replay.profiles[0].pokerStats.hands, 1);

    assert.throws(() => store.recordGame({
      matchId: 'atomic_poker_game_002',
      results: payload.results,
      hands: [blankHand(player.playerId, 1, { pfr: 1, vpip: 0 })],
    }), /分子不能大于机会数/u);
    assert.equal(store.getProfile(player.playerId).stats.matches, 1);
    assert.equal(store.getProfile(player.playerId).pokerStats.hands, 1);
  } finally {
    store.close();
  }
});

test('9 人桌单场可原子写入 9 份赛果与 108 条逐手统计', () => {
  const store = createPlayerStore({ databasePath: ':memory:' });
  try {
    const players = Array.from({ length: 9 }, (_, index) =>
      identity(store, `9${String(index).padStart(3, '0')}`));
    const results = players.map((player, index) => ({
      playerId: player.playerId,
      placement: index + 1,
      heroId: HEROES[index].id,
      survived: index === 0,
    }));
    const hands = players.flatMap((player) =>
      Array.from({ length: 12 }, (_, index) => blankHand(player.playerId, index + 1)));
    const written = store.recordGame({
      matchId: 'nine_seat_full_stats_001',
      tableSize: 9,
      results,
      hands,
    });
    assert.equal(written.inserted, 9);
    assert.equal(written.insertedHands, 108);
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS count FROM player_poker_hands
      WHERE match_id = ? AND table_size = 9
    `).get('nine_seat_full_stats_001').count, 108);
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS count FROM player_match_results
      WHERE match_id = ? AND table_size = 9
    `).get('nine_seat_full_stats_001').count, 9);
  } finally {
    store.close();
  }
});

test('schema v1 原地迁移到 v3，旧玩家、赛果与默认 6 人桌保持可读', async () => {
  await withTempDatabase(async (databasePath) => {
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
        matches INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        top3 INTEGER NOT NULL DEFAULT 0,
        best_rank INTEGER
      );
      CREATE TABLE player_match_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT NOT NULL,
        player_id TEXT NOT NULL REFERENCES players(player_id),
        placement INTEGER NOT NULL,
        hero_id TEXT NOT NULL,
        survived INTEGER NOT NULL,
        played_at INTEGER NOT NULL,
        UNIQUE (match_id, player_id)
      );
      PRAGMA user_version = 1;
    `);
    const playerId = `p_${'A'.repeat(22)}`;
    legacy.prepare(`
      INSERT INTO players VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      playerId, 'A1B2C3D4', 'legacy-hash', '旧档客', '墨',
      Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2), 1, 0, 1, 2,
    );
    legacy.prepare(`
      INSERT INTO player_match_results
        (match_id, player_id, placement, hero_id, survived, played_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('legacy_match', playerId, 2, 'xiangyu', 1, Date.UTC(2026, 0, 2));
    legacy.close();

    const store = createPlayerStore({
      databasePath,
      now: () => Date.UTC(2026, 0, 3),
    });
    try {
      const profile = store.getProfile(playerId);
      assert.equal(profile.nickname, '旧档客');
      assert.equal(profile.stats.matches, 1);
      assert.equal(profile.recentMatches[0].matchId, 'legacy_match');
      assert.equal(profile.recentMatches[0].tableSize, 6);
      assert.equal(profile.pokerStats.hands, 0);
      store.recordHands({
        matchId: 'migrated_hand',
        hands: [blankHand(playerId, 1, { vpip: 1 })],
      });
      assert.equal(store.getProfile(playerId).pokerStats.hands, 1);
      assert.equal(
        store.db.prepare(`
          SELECT table_size FROM player_poker_hands WHERE match_id = ?
        `).get('migrated_hand').table_size,
        6,
      );
      assert.equal(
        Number(store.db.prepare('PRAGMA user_version').get().user_version),
        PLAYER_SCHEMA_VERSION,
      );
    } finally {
      store.close();
    }
  });
});

test('生产 schema v2 原地迁移到 v3 后解除 6 名次约束并补齐 table_size', async () => {
  await withTempDatabase(async (databasePath) => {
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
        best_rank INTEGER CHECK (best_rank BETWEEN 1 AND 6 OR best_rank IS NULL)
      );
      CREATE TABLE player_match_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT NOT NULL,
        player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
        placement INTEGER NOT NULL CHECK (placement BETWEEN 1 AND 6),
        hero_id TEXT NOT NULL,
        survived INTEGER NOT NULL CHECK (survived IN (0, 1)),
        played_at INTEGER NOT NULL,
        UNIQUE (match_id, player_id)
      );
      CREATE TABLE player_poker_hands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT NOT NULL,
        round INTEGER NOT NULL CHECK (round BETWEEN 1 AND 12),
        player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
        played_at INTEGER NOT NULL,
        vpip INTEGER NOT NULL DEFAULT 0 CHECK (vpip IN (0, 1)),
        pfr INTEGER NOT NULL DEFAULT 0 CHECK (pfr IN (0, 1)),
        three_bet INTEGER NOT NULL DEFAULT 0 CHECK (three_bet IN (0, 1)),
        three_bet_opportunity INTEGER NOT NULL DEFAULT 0 CHECK (three_bet_opportunity IN (0, 1)),
        postflop_aggressive_actions INTEGER NOT NULL DEFAULT 0 CHECK (postflop_aggressive_actions >= 0),
        postflop_call_actions INTEGER NOT NULL DEFAULT 0 CHECK (postflop_call_actions >= 0),
        postflop_fold_actions INTEGER NOT NULL DEFAULT 0 CHECK (postflop_fold_actions >= 0),
        saw_flop INTEGER NOT NULL DEFAULT 0 CHECK (saw_flop IN (0, 1)),
        showdown INTEGER NOT NULL DEFAULT 0 CHECK (showdown IN (0, 1)),
        showdown_win INTEGER NOT NULL DEFAULT 0 CHECK (showdown_win IN (0, 1)),
        cbet INTEGER NOT NULL DEFAULT 0 CHECK (cbet IN (0, 1)),
        cbet_opportunity INTEGER NOT NULL DEFAULT 0 CHECK (cbet_opportunity IN (0, 1)),
        fold_to_cbet INTEGER NOT NULL DEFAULT 0 CHECK (fold_to_cbet IN (0, 1)),
        fold_to_cbet_opportunity INTEGER NOT NULL DEFAULT 0 CHECK (fold_to_cbet_opportunity IN (0, 1)),
        UNIQUE (match_id, round, player_id)
      );
      PRAGMA user_version = 2;
    `);
    const playerId = `p_${'B'.repeat(22)}`;
    const playedAt = Date.UTC(2026, 0, 2);
    legacy.prepare(`
      INSERT INTO players VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(playerId, 'B1C2D3E4', 'legacy-v2-hash', '旧二档', '侠',
      playedAt, playedAt, 1, 0, 0, 6);
    legacy.prepare(`
      INSERT INTO player_match_results
        (match_id, player_id, placement, hero_id, survived, played_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('legacy_v2_match', playerId, 6, 'xiangyu', 0, playedAt);
    legacy.prepare(`
      INSERT INTO player_poker_hands (match_id, round, player_id, played_at)
      VALUES (?, ?, ?, ?)
    `).run('legacy_v2_match', 1, playerId, playedAt);
    legacy.close();

    const store = createPlayerStore({ databasePath, now: () => playedAt + DAY_MS });
    try {
      const profile = store.getProfile(playerId);
      assert.equal(profile.recentMatches[0].tableSize, 6);
      assert.equal(profile.pokerStats.hands, 1);
      store.recordMatch({
        matchId: 'migrated_v2_nine_seat',
        tableSize: 9,
        results: [{
          playerId, placement: 9, heroId: 'xiangyu', survived: false,
        }],
      });
      const migrated = store.db.prepare(`
        SELECT table_size, placement FROM player_match_results WHERE match_id = ?
      `).get('migrated_v2_nine_seat');
      assert.equal(migrated.table_size, 9);
      assert.equal(migrated.placement, 9);
      assert.equal(
        Number(store.db.prepare('PRAGMA user_version').get().user_version),
        PLAYER_SCHEMA_VERSION,
      );
    } finally {
      store.close();
    }
  });
});

test('公开行动跟踪正确区分 VPIP/PFR/3Bet、CBet 与直接应对', () => {
  const ids = new Map([
    [1, `p_${'a'.repeat(22)}`],
    [2, `p_${'b'.repeat(22)}`],
    [3, `p_${'c'.repeat(22)}`],
  ]);
  const tracker = createPokerHandTracker(ids);
  const act = (seat, type, amount, street, before, aggressive = false, round = 1) =>
    tracker.onAction(seat, type === 'raise' ? 'probe' : type, amount, {
      round,
      street,
      type,
      streetRaiseCountBefore: before,
      isAggressive: aggressive,
    });

  tracker.onRoundStart(1, [1, 2, 3]);
  act(1, 'call', 10, 'preflop', 0);
  act(2, 'raise', 30, 'preflop', 0, true);
  act(3, 'fold', 0, 'preflop', 1);
  act(1, 'raise', 80, 'preflop', 1, true);
  tracker.onFlop([1, 2]);
  act(2, 'check', 0, 'flop', 0);
  act(1, 'raise', 100, 'flop', 0, true);
  act(2, 'fold', 0, 'flop', 1);

  tracker.onRoundStart(2, [1, 2]);
  act(1, 'raise', 30, 'preflop', 0, true, 2);
  tracker.onFlop([1, 2]);
  act(2, 'raise', 50, 'flop', 0, true, 2); // donk：取消 1 的纯 CBet 机会
  act(1, 'fold', 0, 'flop', 1, false, 2);
  tracker.onShowdown([2], [2]);

  const rows = tracker.getHands();
  const first1 = rows.find((row) => row.round === 1 && row.playerId === ids.get(1));
  const first2 = rows.find((row) => row.round === 1 && row.playerId === ids.get(2));
  const first3 = rows.find((row) => row.round === 1 && row.playerId === ids.get(3));
  const second1 = rows.find((row) => row.round === 2 && row.playerId === ids.get(1));
  assert.deepEqual({
    vpip: first1.vpip,
    pfr: first1.pfr,
    threeBet: first1.threeBet,
    threeBetOpportunity: first1.threeBetOpportunity,
    cbet: first1.cbet,
    cbetOpportunity: first1.cbetOpportunity,
  }, { vpip: 1, pfr: 1, threeBet: 1, threeBetOpportunity: 1, cbet: 1, cbetOpportunity: 1 });
  assert.equal(first2.foldToCbetOpportunity, 1);
  assert.equal(first2.foldToCbet, 1);
  assert.equal(first2.postflopFoldActions, 1);
  assert.equal(first3.threeBetOpportunity, 1);
  assert.equal(first3.threeBet, 0);
  assert.equal(second1.cbetOpportunity, 0);
  assert.equal(second1.foldToCbetOpportunity, 0);
});

test('Engine onAction 第四参数只含公开下注上下文且旧三参数监听兼容', () => {
  const metadata = [];
  const legacyCalls = [];
  const listeners = {
    onAction(idx, key, amount, meta) {
      legacyCalls.push([idx, key, amount]);
      metadata.push(meta);
    },
  };
  const engine = new Engine(
    HEROES.slice(0, 6).map((hero) => hero.id),
    listeners,
    new Set(),
  );
  engine.round = 1;
  engine.street = 'preflop';
  engine.currentBet = 20;
  engine.minRaiseInc = 20;
  engine.streetRaiseCount = 1;
  const player = engine.players[1];
  player.betStreet = 10;
  player.betRound = 10;
  engine.applyAction(player, {
    type: 'raise',
    tier: { key: 'probe', name: '试探', inc: 20 },
  });

  assert.equal(legacyCalls.length, 1);
  assert.deepEqual(legacyCalls[0].slice(0, 2), [1, 'probe']);
  assert.deepEqual(metadata[0], {
    round: 1,
    street: 'preflop',
    type: 'raise',
    currentBetBefore: 20,
    betStreetBefore: 10,
    toCallBefore: 10,
    streetRaiseCountBefore: 1,
    potBefore: 10,
    isAggressive: true,
  });
  assert.equal(Object.hasOwn(metadata[0], 'hole'), false);
  assert.equal(Object.hasOwn(metadata[0], 'cards'), false);
});
