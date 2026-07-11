import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_DATABASE_PATH = join(SERVER_DIR, 'data', 'qyj.sqlite');
export const PLAYER_EMBLEMS = Object.freeze(['侠', '群', '墨', '月']);
export const RECENT_MATCH_LIMIT = 10;
export const POKER_STATS_WINDOW_DAYS = 30;
export const POKER_STATS_MAX_HANDS = 200;
export const POKER_STATS_RANGE_LABEL = '近30天 · 最近200手';
export const PLAYER_SCHEMA_VERSION = 2;

const EMBLEM_SET = new Set(PLAYER_EMBLEMS);
const DAY_MS = 24 * 60 * 60 * 1000;
const GUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{11,127}$/u;
const MATCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HERO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const FORBIDDEN_NICKNAME_RE = /[<>\p{Cc}\p{Cs}\u202A-\u202E\u2066-\u2069]/u;

export class PlayerValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlayerValidationError';
    this.code = code;
  }
}

function validationError(code, message) {
  throw new PlayerValidationError(code, message);
}

export function normalizeGuestId(value) {
  if (typeof value !== 'string' || !GUEST_ID_RE.test(value)) {
    validationError('INVALID_GUEST_ID', 'guestId 格式无效');
  }
  return value;
}

export function normalizeNickname(value) {
  if (typeof value !== 'string') validationError('INVALID_NAME', '昵称必须是字符串');
  const nickname = value.trim().normalize('NFC');
  const length = [...nickname].length;
  if (length < 1 || length > 8) {
    validationError('INVALID_NAME', '昵称需为 1~8 个字符');
  }
  if (FORBIDDEN_NICKNAME_RE.test(nickname)) {
    validationError('INVALID_NAME', '昵称包含不可用字符');
  }
  return nickname;
}

export function normalizeEmblem(value) {
  if (typeof value !== 'string' || !EMBLEM_SET.has(value)) {
    validationError('INVALID_EMBLEM', '纹章不存在');
  }
  return value;
}

export function guestFingerprint(guestId) {
  return createHash('sha256').update(normalizeGuestId(guestId), 'utf8').digest('hex');
}

function normalizeTimestamp(value, fieldName = '时间') {
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    validationError('INVALID_MATCH_RESULT', `${fieldName}格式无效`);
  }
  return timestamp;
}

function toIso(timestamp) {
  return new Date(Number(timestamp)).toISOString();
}

function safeWinRate(matches, wins) {
  return matches > 0 ? Math.round((wins / matches) * 1000) / 10 : 0;
}

function percent(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

function confidenceForHands(hands) {
  if (hands === 0) return 'none';
  if (hands < 30) return 'low';
  if (hands < 100) return 'medium';
  return 'high';
}

function aggregatePokerStats(rows) {
  const totals = rows.reduce((sum, row) => {
    for (const key of Object.keys(sum)) sum[key] += Number(row[key] || 0);
    return sum;
  }, {
    vpip: 0,
    pfr: 0,
    three_bet: 0,
    three_bet_opportunity: 0,
    postflop_aggressive_actions: 0,
    postflop_call_actions: 0,
    saw_flop: 0,
    showdown: 0,
    showdown_win: 0,
    cbet: 0,
    cbet_opportunity: 0,
    fold_to_cbet: 0,
    fold_to_cbet_opportunity: 0,
  });
  const hands = rows.length;
  return {
    rangeLabel: POKER_STATS_RANGE_LABEL,
    windowDays: POKER_STATS_WINDOW_DAYS,
    maxHands: POKER_STATS_MAX_HANDS,
    hands,
    confidence: confidenceForHands(hands),
    vpip: percent(totals.vpip, hands),
    pfr: percent(totals.pfr, hands),
    threeBet: percent(totals.three_bet, totals.three_bet_opportunity),
    af: totals.postflop_call_actions > 0
      ? Math.round((totals.postflop_aggressive_actions / totals.postflop_call_actions) * 100) / 100
      : null,
    wtsd: percent(totals.showdown, totals.saw_flop),
    wsd: percent(totals.showdown_win, totals.showdown),
    cbet: percent(totals.cbet, totals.cbet_opportunity),
    foldToCbet: percent(totals.fold_to_cbet, totals.fold_to_cbet_opportunity),
  };
}

function randomPlayerId(randomBytesImpl) {
  return `p_${randomBytesImpl(16).toString('base64url')}`;
}

function randomShortId(randomBytesImpl) {
  return randomBytesImpl(4).toString('hex').toUpperCase();
}

function databaseRowToProfile(row, recentMatches, pokerStats) {
  if (!row) return null;
  const matches = Number(row.matches);
  const wins = Number(row.wins);
  return {
    playerId: row.player_id,
    shortId: row.short_id,
    nickname: row.nickname,
    emblem: row.emblem,
    createdAt: toIso(row.created_at),
    lastSeenAt: toIso(row.last_seen_at),
    stats: {
      matches,
      wins,
      top3: Number(row.top3),
      winRate: safeWinRate(matches, wins),
      bestRank: row.best_rank == null ? null : Number(row.best_rank),
    },
    recentMatches,
    pokerStats,
  };
}

const BASE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS players (
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

  CREATE TABLE IF NOT EXISTS player_match_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL,
    player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
    placement INTEGER NOT NULL CHECK (placement BETWEEN 1 AND 6),
    hero_id TEXT NOT NULL,
    survived INTEGER NOT NULL CHECK (survived IN (0, 1)),
    played_at INTEGER NOT NULL,
    UNIQUE (match_id, player_id)
  );

  CREATE INDEX IF NOT EXISTS idx_player_match_results_recent
    ON player_match_results(player_id, played_at DESC, id DESC);
`;

const POKER_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS player_poker_hands (
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

  CREATE INDEX IF NOT EXISTS idx_player_poker_hands_window
    ON player_poker_hands(player_id, played_at DESC, id DESC);
`;

function migrateDatabase(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
  `);
  const version = Number(db.prepare('PRAGMA user_version').get().user_version || 0);
  if (version > PLAYER_SCHEMA_VERSION) {
    throw new Error(`Unsupported player database schema version: ${version}`);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(BASE_SCHEMA_SQL);
    db.exec(POKER_SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${PLAYER_SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve migration error */ }
    throw error;
  }
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object') {
    validationError('INVALID_MATCH_RESULT', '战绩必须是对象');
  }
  const playerId = typeof result.playerId === 'string' ? result.playerId : '';
  if (!/^p_[A-Za-z0-9_-]{20,64}$/u.test(playerId)) {
    validationError('INVALID_MATCH_RESULT', '战绩 playerId 格式无效');
  }
  const placement = Number(result.placement);
  if (!Number.isSafeInteger(placement) || placement < 1 || placement > 6) {
    validationError('INVALID_MATCH_RESULT', '战绩名次必须为 1~6');
  }
  const heroId = typeof result.heroId === 'string' ? result.heroId : '';
  if (!HERO_ID_RE.test(heroId)) {
    validationError('INVALID_MATCH_RESULT', '战绩 heroId 格式无效');
  }
  return {
    playerId,
    placement,
    heroId,
    survived: Boolean(result.survived),
  };
}

function normalizePlayerId(value, errorCode = 'INVALID_MATCH_RESULT') {
  const playerId = typeof value === 'string' ? value : '';
  if (!/^p_[A-Za-z0-9_-]{20,64}$/u.test(playerId)) {
    validationError(errorCode, 'playerId 格式无效');
  }
  return playerId;
}

function handFlag(value, field) {
  if (value == null || value === false || value === 0) return 0;
  if (value === true || value === 1) return 1;
  validationError('INVALID_POKER_HAND', `${field} 必须为布尔值`);
}

function handCounter(value, field) {
  if (value == null) return 0;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0 || count > 100) {
    validationError('INVALID_POKER_HAND', `${field} 计数无效`);
  }
  return count;
}

function normalizePokerHand(hand) {
  if (!hand || typeof hand !== 'object') {
    validationError('INVALID_POKER_HAND', '逐手统计必须是对象');
  }
  const round = Number(hand.round);
  if (!Number.isSafeInteger(round) || round < 1 || round > 12) {
    validationError('INVALID_POKER_HAND', '逐手统计 round 必须为 1~12');
  }
  const normalized = {
    round,
    playerId: normalizePlayerId(hand.playerId, 'INVALID_POKER_HAND'),
    vpip: handFlag(hand.vpip, 'vpip'),
    pfr: handFlag(hand.pfr, 'pfr'),
    threeBet: handFlag(hand.threeBet, 'threeBet'),
    threeBetOpportunity: handFlag(hand.threeBetOpportunity, 'threeBetOpportunity'),
    postflopAggressiveActions: handCounter(
      hand.postflopAggressiveActions, 'postflopAggressiveActions',
    ),
    postflopCallActions: handCounter(hand.postflopCallActions, 'postflopCallActions'),
    postflopFoldActions: handCounter(hand.postflopFoldActions, 'postflopFoldActions'),
    sawFlop: handFlag(hand.sawFlop, 'sawFlop'),
    showdown: handFlag(hand.showdown, 'showdown'),
    showdownWin: handFlag(hand.showdownWin, 'showdownWin'),
    cbet: handFlag(hand.cbet, 'cbet'),
    cbetOpportunity: handFlag(hand.cbetOpportunity, 'cbetOpportunity'),
    foldToCbet: handFlag(hand.foldToCbet, 'foldToCbet'),
    foldToCbetOpportunity: handFlag(
      hand.foldToCbetOpportunity, 'foldToCbetOpportunity',
    ),
  };
  if (normalized.pfr > normalized.vpip
    || normalized.threeBet > normalized.threeBetOpportunity
    || normalized.showdownWin > normalized.showdown
    || normalized.cbet > normalized.cbetOpportunity
    || normalized.foldToCbet > normalized.foldToCbetOpportunity) {
    validationError('INVALID_POKER_HAND', '逐手统计分子不能大于机会数');
  }
  return normalized;
}

export class PlayerStore {
  constructor({
    databasePath = DEFAULT_DATABASE_PATH,
    now = Date.now,
    randomBytesImpl = randomBytes,
  } = {}) {
    if (typeof databasePath !== 'string' || !databasePath) {
      throw new TypeError('databasePath must be a non-empty string');
    }
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.now = now;
    this.randomBytes = randomBytesImpl;
    this.closed = false;
    this.db = new DatabaseSync(databasePath);
    try {
      migrateDatabase(this.db);
    } catch (error) {
      this.closed = true;
      this.db.close();
      throw error;
    }

    this.findByGuest = this.db.prepare(
      'SELECT * FROM players WHERE guest_hash = ?',
    );
    this.findById = this.db.prepare(
      'SELECT * FROM players WHERE player_id = ?',
    );
    this.insertPlayer = this.db.prepare(`
      INSERT INTO players (
        player_id, short_id, guest_hash, nickname, emblem, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.touchPlayer = this.db.prepare(
      'UPDATE players SET last_seen_at = ? WHERE player_id = ?',
    );
    this.updatePlayer = this.db.prepare(`
      UPDATE players
      SET nickname = COALESCE(?, nickname), emblem = COALESCE(?, emblem)
      WHERE player_id = ?
    `);
    this.recentMatches = this.db.prepare(`
      SELECT match_id, placement, hero_id, survived, played_at
      FROM player_match_results
      WHERE player_id = ?
      ORDER BY played_at DESC, id DESC
      LIMIT ?
    `);
    this.recentPokerHands = this.db.prepare(`
      SELECT vpip, pfr, three_bet, three_bet_opportunity,
             postflop_aggressive_actions, postflop_call_actions,
             postflop_fold_actions, saw_flop, showdown, showdown_win,
             cbet, cbet_opportunity, fold_to_cbet, fold_to_cbet_opportunity
      FROM player_poker_hands
      WHERE player_id = ? AND played_at >= ?
      ORDER BY played_at DESC, id DESC
      LIMIT ?
    `);
    this.insertMatchResult = this.db.prepare(`
      INSERT OR IGNORE INTO player_match_results (
        match_id, player_id, placement, hero_id, survived, played_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.insertPokerHand = this.db.prepare(`
      INSERT OR IGNORE INTO player_poker_hands (
        match_id, round, player_id, played_at,
        vpip, pfr, three_bet, three_bet_opportunity,
        postflop_aggressive_actions, postflop_call_actions, postflop_fold_actions,
        saw_flop, showdown, showdown_win,
        cbet, cbet_opportunity, fold_to_cbet, fold_to_cbet_opportunity
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateStats = this.db.prepare(`
      UPDATE players
      SET matches = matches + 1,
          wins = wins + ?,
          top3 = top3 + ?,
          best_rank = CASE
            WHEN best_rank IS NULL OR ? < best_rank THEN ?
            ELSE best_rank
          END
      WHERE player_id = ?
    `);
  }

  assertOpen() {
    if (this.closed) throw new Error('PlayerStore is closed');
  }

  currentTime() {
    return normalizeTimestamp(this.now(), '当前时间');
  }

  profileForRow(row) {
    if (!row) return null;
    const recentMatches = this.recentMatches.all(row.player_id, RECENT_MATCH_LIMIT).map((match) => ({
      matchId: match.match_id,
      placement: Number(match.placement),
      heroId: match.hero_id,
      playedAt: toIso(match.played_at),
      survived: Boolean(match.survived),
    }));
    const cutoff = this.currentTime() - POKER_STATS_WINDOW_DAYS * DAY_MS;
    const pokerRows = this.recentPokerHands.all(
      row.player_id,
      cutoff,
      POKER_STATS_MAX_HANDS,
    );
    return databaseRowToProfile(row, recentMatches, aggregatePokerStats(pokerRows));
  }

  identify({ guestId, nickname, emblem, fallbackNickname = '无名侠客' }) {
    this.assertOpen();
    const guestHash = guestFingerprint(guestId);
    // Validate optional seed fields on every call, even though existing
    // server-side profile data always wins over a stale browser cache.
    const initialNickname = nickname == null
      ? normalizeNickname(fallbackNickname)
      : normalizeNickname(nickname);
    const initialEmblem = emblem == null ? PLAYER_EMBLEMS[0] : normalizeEmblem(emblem);
    const now = this.currentTime();
    const existing = this.findByGuest.get(guestHash);
    if (existing) {
      this.touchPlayer.run(now, existing.player_id);
      return {
        created: false,
        guestHash,
        profile: this.getProfile(existing.player_id),
      };
    }

    for (let attempt = 0; attempt < 8; attempt++) {
      const playerId = randomPlayerId(this.randomBytes);
      const shortId = randomShortId(this.randomBytes);
      try {
        this.insertPlayer.run(
          playerId, shortId, guestHash, initialNickname, initialEmblem, now, now,
        );
        return {
          created: true,
          guestHash,
          profile: this.getProfile(playerId),
        };
      } catch (error) {
        const concurrent = this.findByGuest.get(guestHash);
        if (concurrent) {
          this.touchPlayer.run(now, concurrent.player_id);
          return {
            created: false,
            guestHash,
            profile: this.getProfile(concurrent.player_id),
          };
        }
        if (attempt === 7) throw error;
      }
    }
    throw new Error('Unable to allocate player id');
  }

  getProfile(playerId) {
    this.assertOpen();
    return this.profileForRow(this.findById.get(playerId));
  }

  updateProfile(playerId, patch = {}) {
    this.assertOpen();
    if (typeof playerId !== 'string' || !playerId) {
      validationError('PLAYER_NOT_IDENTIFIED', '尚未绑定玩家身份');
    }
    const hasNickname = Object.hasOwn(patch, 'nickname') && patch.nickname != null;
    const hasEmblem = Object.hasOwn(patch, 'emblem') && patch.emblem != null;
    if (!hasNickname && !hasEmblem) {
      validationError('INVALID_PROFILE', '至少提供一个资料字段');
    }
    const nickname = hasNickname ? normalizeNickname(patch.nickname) : null;
    const emblem = hasEmblem ? normalizeEmblem(patch.emblem) : null;
    const result = this.updatePlayer.run(nickname, emblem, playerId);
    if (result.changes !== 1) {
      validationError('PLAYER_NOT_IDENTIFIED', '玩家资料不存在');
    }
    return this.getProfile(playerId);
  }

  normalizeMatchWrite({ matchId, playedAt, results = [], hands = [] }, {
    requireResults = false,
    requireHands = false,
  } = {}) {
    if (typeof matchId !== 'string' || !MATCH_ID_RE.test(matchId)) {
      validationError('INVALID_MATCH_RESULT', 'matchId 格式无效');
    }
    const timestamp = normalizeTimestamp(
      playedAt == null ? this.currentTime() : playedAt,
      '对局时间',
    );
    if (!Array.isArray(results) || results.length > 6
      || (requireResults && results.length < 1)) {
      validationError('INVALID_MATCH_RESULT', '战绩人数必须为 1~6');
    }
    if (!Array.isArray(hands) || hands.length > 72 || (requireHands && hands.length < 1)) {
      validationError('INVALID_POKER_HAND', '逐手统计数量必须为 1~72');
    }
    const normalizedResults = results.map(normalizeResult);
    const normalizedHands = hands.map(normalizePokerHand);
    if (new Set(normalizedResults.map((result) => result.playerId)).size
      !== normalizedResults.length) {
      validationError('INVALID_MATCH_RESULT', '同一玩家不能重复写入一场对局');
    }
    const handKeys = normalizedHands.map((hand) => `${hand.round}:${hand.playerId}`);
    if (new Set(handKeys).size !== handKeys.length) {
      validationError('INVALID_POKER_HAND', '同一玩家每回合只能写入一条逐手统计');
    }
    const playerIds = new Set([
      ...normalizedResults.map((result) => result.playerId),
      ...normalizedHands.map((hand) => hand.playerId),
    ]);
    for (const playerId of playerIds) {
      if (!this.findById.get(playerId)) {
        validationError('PLAYER_NOT_IDENTIFIED', '战绩包含不存在的玩家');
      }
    }
    return { matchId, timestamp, normalizedResults, normalizedHands, playerIds };
  }

  writeGameTransaction({ matchId, timestamp, normalizedResults, normalizedHands, playerIds }) {
    let insertedHands = 0;
    let inserted = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const hand of normalizedHands) {
        const write = this.insertPokerHand.run(
          matchId,
          hand.round,
          hand.playerId,
          timestamp,
          hand.vpip,
          hand.pfr,
          hand.threeBet,
          hand.threeBetOpportunity,
          hand.postflopAggressiveActions,
          hand.postflopCallActions,
          hand.postflopFoldActions,
          hand.sawFlop,
          hand.showdown,
          hand.showdownWin,
          hand.cbet,
          hand.cbetOpportunity,
          hand.foldToCbet,
          hand.foldToCbetOpportunity,
        );
        insertedHands += Number(write.changes || 0);
      }

      for (const result of normalizedResults) {
        const write = this.insertMatchResult.run(
          matchId,
          result.playerId,
          result.placement,
          result.heroId,
          result.survived ? 1 : 0,
          timestamp,
        );
        if (write.changes !== 1) continue;
        const stats = this.updateStats.run(
          result.placement === 1 ? 1 : 0,
          result.placement <= 3 ? 1 : 0,
          result.placement,
          result.placement,
          result.playerId,
        );
        if (stats.changes !== 1) throw new Error('Player disappeared during result write');
        inserted++;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original database error */ }
      throw error;
    }

    return {
      inserted,
      insertedHands,
      profiles: [...playerIds].map((playerId) => this.getProfile(playerId)),
    };
  }

  recordGame({ matchId, playedAt = this.currentTime(), results, hands = [] }) {
    this.assertOpen();
    return this.writeGameTransaction(this.normalizeMatchWrite({
      matchId, playedAt, results, hands,
    }, { requireResults: true }));
  }

  recordMatch({ matchId, playedAt = this.currentTime(), results }) {
    return this.recordGame({ matchId, playedAt, results, hands: [] });
  }

  recordHands({ matchId, playedAt = this.currentTime(), hands }) {
    this.assertOpen();
    return this.writeGameTransaction(this.normalizeMatchWrite({
      matchId, playedAt, results: [], hands,
    }, { requireHands: true }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

export function createPlayerStore(options) {
  return new PlayerStore(options);
}
