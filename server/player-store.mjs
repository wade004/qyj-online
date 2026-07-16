import {
  createHash,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { DEFAULT_TABLE_SIZE, SUPPORTED_TABLE_SIZES } from './protocol.mjs';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_DATABASE_PATH = join(SERVER_DIR, 'data', 'qyj.sqlite');
export const PLAYER_EMBLEMS = Object.freeze(['侠', '群', '墨', '月']);
export const DEFAULT_PLAYER_NICKNAME = '无名侠客';
export const RECENT_MATCH_LIMIT = 10;
export const POKER_STATS_WINDOW_DAYS = 30;
export const POKER_STATS_MAX_HANDS = 200;
export const POKER_STATS_RANGE_LABEL = '近30天 · 最近200手';
export const PLAYER_SCHEMA_VERSION = 8;
export const DEFAULT_PLAYER_AVATAR_COUNT = 20;

export const AUTH_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const AUTH_SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTH_SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
export const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;
export const MAX_AUTH_SESSIONS_PER_PLAYER = 5;
export const DEVICE_LOGIN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
export const PASSWORD_SCRYPT_OPTIONS = Object.freeze({
  N: 2 ** 17,
  r: 8,
  p: 1,
  keyLength: 64,
  maxmem: 256 * 1024 * 1024,
});

const EMBLEM_SET = new Set(PLAYER_EMBLEMS);
const DAY_MS = 24 * 60 * 60 * 1000;
const GUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{11,127}$/u;
const MATCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HERO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const FORBIDDEN_NICKNAME_RE = /[<>\p{Cc}\p{Cs}\u202A-\u202E\u2066-\u2069]/u;
const TABLE_SIZE_SET = new Set(SUPPORTED_TABLE_SIZES);
const MAX_ROUNDS_PER_GAME = 12;
const USERNAME_RE = /^[\p{L}\p{N}_]+$/u;
const FORBIDDEN_EMAIL_RE = /[<>\s\p{Cc}\p{Cs}\u202A-\u202E\u2066-\u2069]/u;
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/u;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/u;
const SCRYPT_HASH_RE = /^scrypt\$N=(\d+)\$r=(\d+)\$p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/u;
const MAX_CONCURRENT_SCRYPT = 2;
const MAX_QUEUED_SCRYPT = 32;

let activeScryptJobs = 0;
const scryptQueue = [];

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

function runBoundedScrypt(work) {
  return new Promise((resolve, reject) => {
    if (activeScryptJobs >= MAX_CONCURRENT_SCRYPT && scryptQueue.length >= MAX_QUEUED_SCRYPT) {
      reject(new PlayerValidationError('AUTH_BUSY', '认证请求繁忙，请稍后重试'));
      return;
    }
    const run = () => {
      activeScryptJobs++;
      Promise.resolve()
        .then(work)
        .then(resolve, reject)
        .finally(() => {
          activeScryptJobs--;
          const next = scryptQueue.shift();
          if (next) next();
        });
    };
    if (activeScryptJobs < MAX_CONCURRENT_SCRYPT) run();
    else scryptQueue.push(run);
  });
}

function deriveScrypt(password, salt, keyLength, options) {
  return runBoundedScrypt(() => new Promise((resolve, reject) => {
    nodeScrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  }));
}

export function normalizeUsername(value) {
  if (typeof value !== 'string') {
    validationError('INVALID_USERNAME', '用户名必须是字符串');
  }
  const username = value.trim().normalize('NFKC');
  const length = [...username].length;
  if (length < 3 || length > 20 || !USERNAME_RE.test(username)) {
    validationError('INVALID_USERNAME', '用户名需为 3~20 个字母、数字、汉字或下划线');
  }
  return { username, key: username.toLowerCase() };
}

export function normalizeEmail(value) {
  if (typeof value !== 'string') validationError('INVALID_EMAIL', '邮箱必须是字符串');
  const email = value.trim().normalize('NFKC');
  if (email.length < 3 || email.length > 254 || FORBIDDEN_EMAIL_RE.test(email)) {
    validationError('INVALID_EMAIL', '邮箱格式无效');
  }
  const at = email.lastIndexOf('@');
  if (at < 1 || at !== email.indexOf('@') || at > 64) {
    validationError('INVALID_EMAIL', '邮箱格式无效');
  }
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local || domain.length < 3 || domain.startsWith('.') || domain.endsWith('.')
    || !domain.includes('.') || domain.includes('..')) {
    validationError('INVALID_EMAIL', '邮箱格式无效');
  }
  return { email, key: email.toLowerCase() };
}

export function normalizePassword(value, errorCode = 'INVALID_PASSWORD') {
  if (typeof value !== 'string') validationError(errorCode, '密码必须是字符串');
  const length = [...value].length;
  const bytes = Buffer.byteLength(value, 'utf8');
  if (length < 8 || length > 128 || bytes > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    validationError(errorCode, '密码需为 8~128 个可用字符');
  }
  return value;
}

function normalizeLogin(value) {
  if (typeof value !== 'string') validationError('INVALID_CREDENTIALS', '用户名或密码错误');
  const login = value.trim().normalize('NFKC');
  try {
    if (login.includes('@')) {
      const normalized = normalizeEmail(login);
      return { kind: 'email', key: normalized.key };
    }
    const normalized = normalizeUsername(login);
    return { kind: 'username', key: normalized.key };
  } catch (error) {
    if (error instanceof PlayerValidationError) {
      validationError('INVALID_CREDENTIALS', '用户名或密码错误');
    }
    throw error;
  }
}

export async function hashPassword(value, {
  randomBytesImpl = randomBytes,
  scryptOptions = PASSWORD_SCRYPT_OPTIONS,
} = {}) {
  const password = normalizePassword(value);
  const salt = randomBytesImpl(16);
  if (!Buffer.isBuffer(salt) && !(salt instanceof Uint8Array)) {
    throw new TypeError('randomBytesImpl must return a Buffer or Uint8Array');
  }
  const N = Number(scryptOptions.N);
  const r = Number(scryptOptions.r);
  const p = Number(scryptOptions.p);
  const keyLength = Number(scryptOptions.keyLength);
  const maxmem = Number(scryptOptions.maxmem);
  const derivedKey = await deriveScrypt(password, salt, keyLength, { N, r, p, maxmem });
  return `scrypt$N=${N}$r=${r}$p=${p}$${Buffer.from(salt).toString('base64url')}`
    + `$${Buffer.from(derivedKey).toString('base64url')}`;
}

function parsePasswordHash(encodedHash) {
  if (typeof encodedHash !== 'string') return null;
  const match = SCRYPT_HASH_RE.exec(encodedHash);
  if (!match) return null;
  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  if (!Number.isSafeInteger(N) || N < 2 ** 13 || N > 2 ** 20 || (N & (N - 1)) !== 0
    || !Number.isSafeInteger(r) || r < 1 || r > 32
    || !Number.isSafeInteger(p) || p < 1 || p > 16) return null;
  let salt;
  let expected;
  try {
    salt = Buffer.from(match[4], 'base64url');
    expected = Buffer.from(match[5], 'base64url');
  } catch {
    return null;
  }
  if (salt.length < 16 || salt.length > 64 || expected.length < 32 || expected.length > 128) {
    return null;
  }
  return { N, r, p, salt, expected };
}

export async function verifyPassword(value, encodedHash) {
  if (typeof value !== 'string') return false;
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed) return false;
  const memoryFloor = 128 * parsed.N * parsed.r;
  const maxmem = Math.max(PASSWORD_SCRYPT_OPTIONS.maxmem, memoryFloor + 1024 * 1024);
  let actual;
  try {
    actual = await deriveScrypt(value, parsed.salt, parsed.expected.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem,
    });
  } catch (error) {
    if (error instanceof PlayerValidationError && error.code === 'AUTH_BUSY') throw error;
    return false;
  }
  return actual.length === parsed.expected.length && timingSafeEqual(actual, parsed.expected);
}

function fingerprintOpaqueToken(value) {
  if (typeof value !== 'string' || !OPAQUE_TOKEN_RE.test(value)) return null;
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function authTokenFingerprint(value) {
  const fingerprint = fingerprintOpaqueToken(value);
  if (!fingerprint) validationError('INVALID_SESSION', '登录会话无效');
  return fingerprint;
}

export function passwordResetTokenFingerprint(value) {
  const fingerprint = fingerprintOpaqueToken(value);
  if (!fingerprint) validationError('RESET_TOKEN_INVALID', '重置链接无效或已过期');
  return fingerprint;
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

function resolveRegistrationNickname(username, nickname, fallbackNickname) {
  const requestedNickname = nickname == null
    ? normalizeNickname(fallbackNickname)
    : normalizeNickname(nickname);
  if (requestedNickname !== DEFAULT_PLAYER_NICKNAME) return requestedNickname;
  try {
    return normalizeNickname(username);
  } catch (error) {
    if (!(error instanceof PlayerValidationError) || error.code !== 'INVALID_NAME') throw error;
    return requestedNickname;
  }
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

export function defaultAvatarIdForPlayer(playerId) {
  const digest = createHash('sha256').update(String(playerId || ''), 'utf8').digest();
  return 1 + (digest.readUInt32BE(0) % DEFAULT_PLAYER_AVATAR_COUNT);
}

function randomOpaqueToken(randomBytesImpl) {
  return randomBytesImpl(32).toString('base64url');
}

function randomInternalGuestId(randomBytesImpl) {
  return `account-${randomBytesImpl(24).toString('base64url')}`;
}

function positiveDuration(value, fallback, field) {
  const duration = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(duration) || duration < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return duration;
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
    avatarId: Number(row.avatar_id) || defaultAvatarIdForPlayer(row.player_id),
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

function accountRowToDto(row) {
  if (!row) return null;
  const deviceAccount = row.account_origin === 'device';
  const credentialsConfigured = Number(row.login_enabled) === 1;
  return {
    playerId: row.player_id,
    username: deviceAccount ? null : row.username,
    email: credentialsConfigured ? row.email : null,
    deviceAccount,
    credentialsConfigured,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    passwordChangedAt: toIso(row.password_changed_at),
    lastLoginAt: row.last_login_at == null ? null : toIso(row.last_login_at),
  };
}

function sessionRowToDto(row) {
  if (!row) return null;
  return {
    id: row.session_hash,
    playerId: row.player_id,
    createdAt: toIso(row.created_at),
    lastSeenAt: toIso(row.last_seen_at),
    expiresAt: toIso(row.expires_at),
  };
}

function optionalMetadataFingerprint(value) {
  if (value == null || value === '') return null;
  return createHash('sha256').update(String(value).slice(0, 2048), 'utf8').digest('hex');
}

const BASE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS players (
    player_id TEXT PRIMARY KEY,
    short_id TEXT NOT NULL UNIQUE,
    guest_hash TEXT NOT NULL UNIQUE,
    nickname TEXT NOT NULL,
    emblem TEXT NOT NULL,
    avatar_id INTEGER NOT NULL DEFAULT 1 CHECK (avatar_id BETWEEN 1 AND 20),
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    matches INTEGER NOT NULL DEFAULT 0 CHECK (matches >= 0),
    wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
    top3 INTEGER NOT NULL DEFAULT 0 CHECK (top3 >= 0),
    best_rank INTEGER CHECK (best_rank BETWEEN 1 AND 9 OR best_rank IS NULL)
  );

  CREATE TABLE IF NOT EXISTS player_match_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL,
    player_id TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
    table_size INTEGER NOT NULL DEFAULT 6 CHECK (table_size IN (6, 9)),
    placement INTEGER NOT NULL CHECK (placement BETWEEN 1 AND 9),
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
    table_size INTEGER NOT NULL DEFAULT 6 CHECK (table_size IN (6, 9)),
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

const AUTH_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS player_accounts (
    player_id TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL UNIQUE
      CHECK (length(username_key) BETWEEN 3 AND 20),
    email TEXT NOT NULL,
    email_key TEXT NOT NULL UNIQUE
      CHECK (length(email_key) BETWEEN 3 AND 254),
    password_hash TEXT NOT NULL,
    login_enabled INTEGER NOT NULL DEFAULT 1 CHECK (login_enabled IN (0, 1)),
    account_origin TEXT NOT NULL DEFAULT 'standard'
      CHECK (account_origin IN ('standard', 'device')),
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'disabled')),
    auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    password_changed_at INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS player_auth_sessions (
    session_hash TEXT PRIMARY KEY CHECK (length(session_hash) = 64),
    player_id TEXT NOT NULL REFERENCES player_accounts(player_id) ON DELETE CASCADE,
    auth_version INTEGER NOT NULL CHECK (auth_version > 0),
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    user_agent_hash TEXT,
    ip_hash TEXT,
    CHECK (expires_at > created_at)
  );

  CREATE INDEX IF NOT EXISTS idx_player_auth_sessions_active
    ON player_auth_sessions(player_id, revoked_at, expires_at, last_seen_at);

  CREATE TABLE IF NOT EXISTS player_device_credentials (
    device_hash TEXT PRIMARY KEY CHECK (length(device_hash) = 64),
    player_id TEXT NOT NULL REFERENCES player_accounts(player_id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    user_agent_hash TEXT,
    CHECK (expires_at > created_at)
  );

  CREATE INDEX IF NOT EXISTS idx_player_device_credentials_player
    ON player_device_credentials(player_id, revoked_at, expires_at, last_used_at);

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
    player_id TEXT NOT NULL REFERENCES player_accounts(player_id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    CHECK (expires_at > created_at)
  );

  CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_player
    ON password_reset_tokens(player_id, used_at, expires_at);

  CREATE TABLE IF NOT EXISTS auth_rate_limits (
    scope TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    window_started_at INTEGER NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0 CHECK (hits >= 0),
    blocked_until INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, key_hash)
  ) WITHOUT ROWID;
`;

const HAND_HISTORY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS poker_hand_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL,
    round INTEGER NOT NULL CHECK (round BETWEEN 1 AND 12),
    room_id INTEGER NOT NULL CHECK (room_id > 0),
    room_name TEXT NOT NULL CHECK (length(room_name) BETWEEN 1 AND 64),
    table_size INTEGER NOT NULL CHECK (table_size IN (6, 9)),
    dealer_seat INTEGER NOT NULL CHECK (dealer_seat BETWEEN 1 AND 9),
    resolution TEXT NOT NULL CHECK (resolution IN ('showdown', 'uncontested')),
    board_json TEXT NOT NULL,
    pots_json TEXT NOT NULL,
    played_at INTEGER NOT NULL,
    UNIQUE (match_id, round)
  );

  CREATE TABLE IF NOT EXISTS poker_hand_record_players (
    hand_id INTEGER NOT NULL REFERENCES poker_hand_records(id) ON DELETE CASCADE,
    seat INTEGER NOT NULL CHECK (seat BETWEEN 1 AND 9),
    player_id TEXT REFERENCES players(player_id) ON DELETE SET NULL,
    player_name TEXT NOT NULL CHECK (length(player_name) BETWEEN 1 AND 32),
    hero_id TEXT NOT NULL,
    hole_json TEXT NOT NULL,
    public_hole_json TEXT NOT NULL,
    folded INTEGER NOT NULL CHECK (folded IN (0, 1)),
    all_in INTEGER NOT NULL CHECK (all_in IN (0, 1)),
    net_result INTEGER NOT NULL,
    won_amount INTEGER NOT NULL CHECK (won_amount >= 0),
    hand_name TEXT,
    PRIMARY KEY (hand_id, seat)
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS idx_poker_hand_record_player_history
    ON poker_hand_record_players(player_id, hand_id DESC);
`;

function tableExists(db, name) {
  return Boolean(db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(name));
}

function tableHasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function migrateExistingDatabaseToV3(db) {
  const hasPokerHands = tableExists(db, 'player_poker_hands');
  db.exec(`
    DROP TABLE IF EXISTS player_poker_hands_v3;
    DROP TABLE IF EXISTS player_match_results_v3;
    DROP TABLE IF EXISTS players_v3;

    CREATE TABLE players_v3 (
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

    INSERT INTO players_v3 (
      player_id, short_id, guest_hash, nickname, emblem, created_at, last_seen_at,
      matches, wins, top3, best_rank
    )
    SELECT player_id, short_id, guest_hash, nickname, emblem, created_at, last_seen_at,
      matches, wins, top3, best_rank
    FROM players;

    CREATE TABLE player_match_results_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id TEXT NOT NULL,
      player_id TEXT NOT NULL REFERENCES players_v3(player_id) ON DELETE CASCADE,
      table_size INTEGER NOT NULL DEFAULT 6 CHECK (table_size IN (6, 9)),
      placement INTEGER NOT NULL CHECK (placement BETWEEN 1 AND 9),
      hero_id TEXT NOT NULL,
      survived INTEGER NOT NULL CHECK (survived IN (0, 1)),
      played_at INTEGER NOT NULL,
      UNIQUE (match_id, player_id)
    );

    INSERT INTO player_match_results_v3 (
      id, match_id, player_id, table_size, placement, hero_id, survived, played_at
    )
    SELECT id, match_id, player_id, 6, placement, hero_id, survived, played_at
    FROM player_match_results;

    CREATE TABLE player_poker_hands_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id TEXT NOT NULL,
      round INTEGER NOT NULL CHECK (round BETWEEN 1 AND 12),
      player_id TEXT NOT NULL REFERENCES players_v3(player_id) ON DELETE CASCADE,
      table_size INTEGER NOT NULL DEFAULT 6 CHECK (table_size IN (6, 9)),
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
  `);
  if (hasPokerHands) {
    db.exec(`
      INSERT INTO player_poker_hands_v3 (
        id, match_id, round, player_id, table_size, played_at,
        vpip, pfr, three_bet, three_bet_opportunity,
        postflop_aggressive_actions, postflop_call_actions, postflop_fold_actions,
        saw_flop, showdown, showdown_win,
        cbet, cbet_opportunity, fold_to_cbet, fold_to_cbet_opportunity
      )
      SELECT id, match_id, round, player_id, 6, played_at,
        vpip, pfr, three_bet, three_bet_opportunity,
        postflop_aggressive_actions, postflop_call_actions, postflop_fold_actions,
        saw_flop, showdown, showdown_win,
        cbet, cbet_opportunity, fold_to_cbet, fold_to_cbet_opportunity
      FROM player_poker_hands;
    `);
  }
  db.exec(`
    DROP TABLE IF EXISTS player_poker_hands;
    DROP TABLE player_match_results;
    DROP TABLE players;
    ALTER TABLE players_v3 RENAME TO players;
    ALTER TABLE player_match_results_v3 RENAME TO player_match_results;
    ALTER TABLE player_poker_hands_v3 RENAME TO player_poker_hands;
    CREATE INDEX idx_player_match_results_recent
      ON player_match_results(player_id, played_at DESC, id DESC);
    CREATE INDEX idx_player_poker_hands_window
      ON player_poker_hands(player_id, played_at DESC, id DESC);
  `);
}

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
    if (version < 3 && tableExists(db, 'players') && tableExists(db, 'player_match_results')) {
      migrateExistingDatabaseToV3(db);
    } else {
      db.exec(BASE_SCHEMA_SQL);
      db.exec(POKER_SCHEMA_SQL);
    }
    db.exec(AUTH_SCHEMA_SQL);
    if (!tableHasColumn(db, 'player_accounts', 'login_enabled')) {
      db.exec(`ALTER TABLE player_accounts
        ADD COLUMN login_enabled INTEGER NOT NULL DEFAULT 1 CHECK (login_enabled IN (0, 1))`);
    }
    if (!tableHasColumn(db, 'player_accounts', 'account_origin')) {
      db.exec(`ALTER TABLE player_accounts
        ADD COLUMN account_origin TEXT NOT NULL DEFAULT 'standard'
        CHECK (account_origin IN ('standard', 'device'))`);
    }
    if (!tableHasColumn(db, 'players', 'avatar_id')) {
      db.exec(`ALTER TABLE players
        ADD COLUMN avatar_id INTEGER NOT NULL DEFAULT 1 CHECK (avatar_id BETWEEN 1 AND 20)`);
    }
    if (version < 8) {
      const rows = db.prepare('SELECT player_id FROM players').all();
      const setAvatar = db.prepare('UPDATE players SET avatar_id = ? WHERE player_id = ?');
      for (const row of rows) {
        setAvatar.run(defaultAvatarIdForPlayer(row.player_id), row.player_id);
      }
    }
    db.exec(HAND_HISTORY_SCHEMA_SQL);
    if (version < 5) {
      db.exec(`
        UPDATE players
        SET nickname = (
          SELECT account.username
          FROM player_accounts AS account
          WHERE account.player_id = players.player_id
        )
        WHERE nickname = '无名侠客'
          AND EXISTS (
            SELECT 1
            FROM player_accounts AS account
            WHERE account.player_id = players.player_id
              AND length(account.username) BETWEEN 3 AND 8
          );
      `);
    }
    const foreignKeyViolation = db.prepare('PRAGMA foreign_key_check').get();
    if (foreignKeyViolation) throw new Error('Player database migration failed foreign key check');
    db.exec(`PRAGMA user_version = ${PLAYER_SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve migration error */ }
    throw error;
  }
}

function normalizeTableSize(value = DEFAULT_TABLE_SIZE, errorCode = 'INVALID_MATCH_RESULT') {
  const tableSize = Number(value);
  if (!Number.isSafeInteger(tableSize) || !TABLE_SIZE_SET.has(tableSize)) {
    validationError(errorCode, `桌型必须为 ${SUPPORTED_TABLE_SIZES.join('/')} 人桌`);
  }
  return tableSize;
}

function normalizeResult(result, tableSize) {
  if (!result || typeof result !== 'object') {
    validationError('INVALID_MATCH_RESULT', '战绩必须是对象');
  }
  const playerId = typeof result.playerId === 'string' ? result.playerId : '';
  if (!/^p_[A-Za-z0-9_-]{20,64}$/u.test(playerId)) {
    validationError('INVALID_MATCH_RESULT', '战绩 playerId 格式无效');
  }
  const placement = Number(result.placement);
  if (!Number.isSafeInteger(placement) || placement < 1 || placement > tableSize) {
    validationError('INVALID_MATCH_RESULT', `战绩名次必须为 1~${tableSize}`);
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
  if (!Number.isSafeInteger(round) || round < 1 || round > MAX_ROUNDS_PER_GAME) {
    validationError(
      'INVALID_POKER_HAND',
      `逐手统计 round 必须为 1~${MAX_ROUNDS_PER_GAME}`,
    );
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

function historyInteger(value, field, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    validationError('INVALID_HAND_HISTORY', `${field} 格式无效`);
  }
  return number;
}

function normalizeHistoryCard(value, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    validationError('INVALID_HAND_HISTORY', '牌面格式无效');
  }
  const rank = historyInteger(value.r ?? value.rank, '牌面点数', { min: 2, max: 14 });
  const suit = historyInteger(value.s ?? value.suit, '牌面花色', { min: 1, max: 4 });
  return { r: rank, s: suit };
}

function historyCardKey(card) {
  return `${card.r}:${card.s}`;
}

function normalizeHistoryText(value, field, maxLength) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maxLength || FORBIDDEN_NICKNAME_RE.test(text)) {
    validationError('INVALID_HAND_HISTORY', `${field} 格式无效`);
  }
  return text;
}

function normalizeHistoryPot(value, tableSize) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    validationError('INVALID_HAND_HISTORY', '底池记录格式无效');
  }
  const amount = historyInteger(value.amount ?? 0, '底池金额', { min: 0 });
  const winnerSeats = Array.isArray(value.winnerSeats ?? value.winnerIds)
    ? (value.winnerSeats ?? value.winnerIds).map((seat) => (
      historyInteger(seat, '底池赢家座位', { min: 1, max: tableSize })
    ))
    : [];
  return {
    label: normalizeHistoryText(value.label || '底池', '底池名称', 32),
    amount,
    winnerSeats: [...new Set(winnerSeats)],
  };
}

function normalizeHistoryPlayer(value, tableSize) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    validationError('INVALID_HAND_HISTORY', '牌局玩家记录格式无效');
  }
  const seat = historyInteger(value.seat, '座位号', { min: 1, max: tableSize });
  const playerId = value.playerId == null || value.playerId === ''
    ? null
    : normalizePlayerId(value.playerId, 'INVALID_HAND_HISTORY');
  const heroId = typeof value.heroId === 'string' ? value.heroId : '';
  if (!HERO_ID_RE.test(heroId)) {
    validationError('INVALID_HAND_HISTORY', '英雄编号格式无效');
  }
  if (!Array.isArray(value.hole) || value.hole.length !== 2) {
    validationError('INVALID_HAND_HISTORY', '底牌必须包含两张牌');
  }
  const hole = value.hole.map((card) => normalizeHistoryCard(card, { nullable: true }));
  const publicHoleInput = value.publicHole == null ? [null, null] : value.publicHole;
  if (!Array.isArray(publicHoleInput) || publicHoleInput.length !== 2) {
    validationError('INVALID_HAND_HISTORY', '公开底牌必须包含两个牌位');
  }
  const publicHole = publicHoleInput.map((card, index) => {
    const normalized = normalizeHistoryCard(card, { nullable: true });
    if (normalized && (!hole[index]
      || historyCardKey(normalized) !== historyCardKey(hole[index]))) {
      validationError('INVALID_HAND_HISTORY', '公开底牌必须与原始底牌一致');
    }
    return normalized;
  });
  const handName = value.handName == null || value.handName === ''
    ? null
    : normalizeHistoryText(value.handName, '牌型名称', 32);
  return {
    seat,
    playerId,
    playerName: normalizeHistoryText(value.playerName, '玩家名称', 32),
    heroId,
    hole,
    publicHole,
    folded: Boolean(value.folded),
    allIn: Boolean(value.allIn),
    netResult: historyInteger(value.netResult ?? 0, '输赢金额'),
    wonAmount: historyInteger(value.wonAmount ?? 0, '赢得筹码', { min: 0 }),
    handName,
  };
}

function normalizeHandHistoryRecord(record, now) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    validationError('INVALID_HAND_HISTORY', '牌局记录必须是对象');
  }
  const matchId = typeof record.matchId === 'string' ? record.matchId : '';
  if (!MATCH_ID_RE.test(matchId)) {
    validationError('INVALID_HAND_HISTORY', 'matchId 格式无效');
  }
  const tableSize = normalizeTableSize(record.tableSize, 'INVALID_HAND_HISTORY');
  const round = historyInteger(record.round, '局号', { min: 1, max: MAX_ROUNDS_PER_GAME });
  const roomId = historyInteger(record.roomId, '房间号', { min: 1 });
  const dealerSeat = historyInteger(record.dealerSeat, '庄家座位', { min: 1, max: tableSize });
  const resolution = record.resolution === 'showdown' || record.resolution === 'uncontested'
    ? record.resolution
    : null;
  if (!resolution) validationError('INVALID_HAND_HISTORY', '结算方式无效');
  if (!Array.isArray(record.board) || record.board.length > 5) {
    validationError('INVALID_HAND_HISTORY', '公牌数量无效');
  }
  const board = record.board.map((card) => normalizeHistoryCard(card));
  if (!Array.isArray(record.players) || record.players.length < 1 || record.players.length > tableSize) {
    validationError('INVALID_HAND_HISTORY', `牌局玩家数量必须为 1~${tableSize}`);
  }
  const players = record.players.map((player) => normalizeHistoryPlayer(player, tableSize));
  if (new Set(players.map((player) => player.seat)).size !== players.length) {
    validationError('INVALID_HAND_HISTORY', '同一座位不能重复写入牌局记录');
  }
  const seenCards = new Set();
  for (const card of [...board, ...players.flatMap((player) => player.hole)]) {
    if (!card) continue;
    const key = historyCardKey(card);
    if (seenCards.has(key)) validationError('INVALID_HAND_HISTORY', '牌局记录包含重复实体牌');
    seenCards.add(key);
  }
  const potsInput = record.pots == null ? [] : record.pots;
  if (!Array.isArray(potsInput) || potsInput.length > tableSize) {
    validationError('INVALID_HAND_HISTORY', '底池记录数量无效');
  }
  const playedAt = normalizeTimestamp(record.playedAt == null ? now : record.playedAt, '牌局时间');
  return {
    matchId,
    round,
    roomId,
    roomName: normalizeHistoryText(record.roomName, '房间名称', 64),
    tableSize,
    dealerSeat,
    resolution,
    board,
    pots: potsInput.map((pot) => normalizeHistoryPot(pot, tableSize)),
    players,
    playedAt,
  };
}

export class PlayerStore {
  constructor({
    databasePath = DEFAULT_DATABASE_PATH,
    now = Date.now,
    randomBytesImpl = randomBytes,
    hashPasswordImpl = hashPassword,
    verifyPasswordImpl = verifyPassword,
    sessionLifetimeMs = AUTH_SESSION_LIFETIME_MS,
    sessionIdleMs = AUTH_SESSION_IDLE_MS,
    sessionTouchIntervalMs = AUTH_SESSION_TOUCH_INTERVAL_MS,
    passwordResetTtlMs = PASSWORD_RESET_TTL_MS,
    maxAuthSessions = MAX_AUTH_SESSIONS_PER_PLAYER,
  } = {}) {
    if (typeof databasePath !== 'string' || !databasePath) {
      throw new TypeError('databasePath must be a non-empty string');
    }
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.now = now;
    this.randomBytes = randomBytesImpl;
    if (typeof hashPasswordImpl !== 'function' || typeof verifyPasswordImpl !== 'function') {
      throw new TypeError('password hash and verification implementations must be functions');
    }
    this.hashPasswordImpl = hashPasswordImpl;
    this.verifyPasswordImpl = verifyPasswordImpl;
    this.sessionLifetimeMs = positiveDuration(
      sessionLifetimeMs, AUTH_SESSION_LIFETIME_MS, 'sessionLifetimeMs',
    );
    this.sessionIdleMs = positiveDuration(sessionIdleMs, AUTH_SESSION_IDLE_MS, 'sessionIdleMs');
    this.sessionTouchIntervalMs = positiveDuration(
      sessionTouchIntervalMs, AUTH_SESSION_TOUCH_INTERVAL_MS, 'sessionTouchIntervalMs',
    );
    this.passwordResetTtlMs = positiveDuration(
      passwordResetTtlMs, PASSWORD_RESET_TTL_MS, 'passwordResetTtlMs',
    );
    this.maxAuthSessions = positiveDuration(
      maxAuthSessions, MAX_AUTH_SESSIONS_PER_PLAYER, 'maxAuthSessions',
    );
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
        player_id, short_id, guest_hash, nickname, emblem, avatar_id, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
      SELECT match_id, table_size, placement, hero_id, survived, played_at
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
        match_id, player_id, table_size, placement, hero_id, survived, played_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertPokerHand = this.db.prepare(`
      INSERT OR IGNORE INTO player_poker_hands (
        match_id, round, player_id, table_size, played_at,
        vpip, pfr, three_bet, three_bet_opportunity,
        postflop_aggressive_actions, postflop_call_actions, postflop_fold_actions,
        saw_flop, showdown, showdown_win,
        cbet, cbet_opportunity, fold_to_cbet, fold_to_cbet_opportunity
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertHandRecord = this.db.prepare(`
      INSERT OR IGNORE INTO poker_hand_records (
        match_id, round, room_id, room_name, table_size, dealer_seat,
        resolution, board_json, pots_json, played_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.findHandRecord = this.db.prepare(`
      SELECT id FROM poker_hand_records WHERE match_id = ? AND round = ?
    `);
    this.insertHandRecordPlayer = this.db.prepare(`
      INSERT INTO poker_hand_record_players (
        hand_id, seat, player_id, player_name, hero_id, hole_json, public_hole_json,
        folded, all_in, net_result, won_amount, hand_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.handHistoryForPlayer = this.db.prepare(`
      SELECT record.*
      FROM poker_hand_records AS record
      INNER JOIN poker_hand_record_players AS mine
        ON mine.hand_id = record.id AND mine.player_id = ?
      ORDER BY record.played_at DESC, record.id DESC
      LIMIT ?
    `);
    this.handHistoryBeforeForPlayer = this.db.prepare(`
      SELECT record.*
      FROM poker_hand_records AS record
      INNER JOIN poker_hand_record_players AS mine
        ON mine.hand_id = record.id AND mine.player_id = ?
      WHERE record.id < ?
      ORDER BY record.played_at DESC, record.id DESC
      LIMIT ?
    `);
    this.handHistoryPlayers = this.db.prepare(`
      SELECT seat, player_id, player_name, hero_id, hole_json, public_hole_json,
             folded, all_in, net_result, won_amount, hand_name
      FROM poker_hand_record_players
      WHERE hand_id = ?
      ORDER BY seat ASC
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
    this.findAccountByPlayer = this.db.prepare(
      'SELECT * FROM player_accounts WHERE player_id = ?',
    );
    this.findAccountByUsername = this.db.prepare(
      'SELECT * FROM player_accounts WHERE username_key = ?',
    );
    this.findAccountByEmail = this.db.prepare(
      'SELECT * FROM player_accounts WHERE email_key = ?',
    );
    this.findAccountForGuest = this.db.prepare(`
      SELECT a.*
      FROM players p
      JOIN player_accounts a ON a.player_id = p.player_id
      WHERE p.guest_hash = ?
    `);
    this.insertAccount = this.db.prepare(`
      INSERT INTO player_accounts (
        player_id, username, username_key, email, email_key, password_hash,
        login_enabled, account_origin,
        status, auth_version, created_at, updated_at, password_changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)
    `);
    this.updateAccountCredentials = this.db.prepare(`
      UPDATE player_accounts
      SET email = ?, email_key = ?, password_hash = ?, login_enabled = 1,
          updated_at = ?, password_changed_at = ?
      WHERE player_id = ? AND password_hash = ? AND status = 'active'
    `);
    this.updateAccountLastLogin = this.db.prepare(`
      UPDATE player_accounts
      SET last_login_at = ?, updated_at = ?
      WHERE player_id = ? AND password_hash = ? AND status = 'active'
    `);
    this.findDeviceCredential = this.db.prepare(
      'SELECT * FROM player_device_credentials WHERE device_hash = ?',
    );
    this.insertDeviceCredential = this.db.prepare(`
      INSERT INTO player_device_credentials (
        device_hash, player_id, created_at, last_used_at, expires_at, user_agent_hash
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.touchDeviceCredential = this.db.prepare(`
      UPDATE player_device_credentials
      SET last_used_at = ?, user_agent_hash = COALESCE(?, user_agent_hash)
      WHERE device_hash = ? AND revoked_at IS NULL AND expires_at > ?
    `);
    this.revokeDeviceCredential = this.db.prepare(`
      UPDATE player_device_credentials
      SET revoked_at = ?
      WHERE device_hash = ? AND revoked_at IS NULL
    `);
    this.insertAuthSession = this.db.prepare(`
      INSERT INTO player_auth_sessions (
        session_hash, player_id, auth_version, created_at, last_seen_at, expires_at,
        user_agent_hash, ip_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.findAuthSession = this.db.prepare(
      'SELECT * FROM player_auth_sessions WHERE session_hash = ?',
    );
    this.touchAuthSession = this.db.prepare(`
      UPDATE player_auth_sessions
      SET last_seen_at = ?
      WHERE session_hash = ? AND revoked_at IS NULL
    `);
    this.revokeAuthSessionByHash = this.db.prepare(`
      UPDATE player_auth_sessions
      SET revoked_at = ?
      WHERE session_hash = ? AND revoked_at IS NULL
    `);
    this.revokeStalePlayerSessions = this.db.prepare(`
      UPDATE player_auth_sessions
      SET revoked_at = ?
      WHERE player_id = ? AND revoked_at IS NULL
        AND (expires_at <= ? OR last_seen_at <= ?)
    `);
    this.activePlayerSessions = this.db.prepare(`
      SELECT session_hash
      FROM player_auth_sessions
      WHERE player_id = ? AND revoked_at IS NULL
        AND expires_at > ? AND last_seen_at > ?
      ORDER BY created_at ASC, session_hash ASC
    `);
    this.revokeAllPlayerSessions = this.db.prepare(`
      UPDATE player_auth_sessions
      SET revoked_at = ?
      WHERE player_id = ? AND revoked_at IS NULL
    `);
    this.bumpAccountAuthVersion = this.db.prepare(`
      UPDATE player_accounts
      SET auth_version = auth_version + 1, updated_at = ?
      WHERE player_id = ?
    `);
    this.insertPasswordReset = this.db.prepare(`
      INSERT INTO password_reset_tokens (
        token_hash, player_id, created_at, expires_at
      ) VALUES (?, ?, ?, ?)
    `);
    this.findPasswordReset = this.db.prepare(
      'SELECT * FROM password_reset_tokens WHERE token_hash = ?',
    );
    this.consumePlayerPasswordResets = this.db.prepare(`
      UPDATE password_reset_tokens
      SET used_at = ?
      WHERE player_id = ? AND used_at IS NULL
    `);
    this.updateAccountPassword = this.db.prepare(`
      UPDATE player_accounts
      SET password_hash = ?, password_changed_at = ?, updated_at = ?,
          auth_version = auth_version + 1
      WHERE player_id = ? AND status = 'active'
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
      tableSize: Number(match.table_size) || DEFAULT_TABLE_SIZE,
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

  identify({ guestId, nickname, emblem, fallbackNickname = DEFAULT_PLAYER_NICKNAME }) {
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
      if (this.findAccountByPlayer.get(existing.player_id)) {
        validationError('AUTH_REQUIRED', '该玩家档案已绑定账号，请登录后继续');
      }
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
          playerId, shortId, guestHash, initialNickname, initialEmblem,
          defaultAvatarIdForPlayer(playerId), now, now,
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

  getAccount(playerId) {
    this.assertOpen();
    const normalizedPlayerId = normalizePlayerId(playerId, 'PLAYER_NOT_IDENTIFIED');
    return accountRowToDto(this.findAccountByPlayer.get(normalizedPlayerId));
  }

  getAccountBundle(playerId) {
    const account = this.getAccount(playerId);
    return account ? { account, profile: this.getProfile(account.playerId) } : null;
  }

  isGuestAccountBound(guestId) {
    this.assertOpen();
    return Boolean(this.findAccountForGuest.get(guestFingerprint(guestId)));
  }

  async registerAccount({
    username: rawUsername,
    email: rawEmail,
    password: rawPassword,
    guestId,
    nickname,
    emblem,
    fallbackNickname = DEFAULT_PLAYER_NICKNAME,
  } = {}) {
    this.assertOpen();
    const { username, key: usernameKey } = normalizeUsername(rawUsername);
    const { email, key: emailKey } = normalizeEmail(rawEmail);
    const password = normalizePassword(rawPassword);
    const initialNickname = resolveRegistrationNickname(
      username,
      nickname,
      fallbackNickname,
    );
    const initialEmblem = emblem == null ? PLAYER_EMBLEMS[0] : normalizeEmblem(emblem);
    const normalizedGuestId = guestId == null
      ? randomInternalGuestId(this.randomBytes)
      : normalizeGuestId(guestId);
    const guestHash = guestFingerprint(normalizedGuestId);

    if (this.findAccountByUsername.get(usernameKey)) {
      validationError('USERNAME_TAKEN', '用户名已被使用');
    }
    if (this.findAccountByEmail.get(emailKey)) {
      validationError('EMAIL_TAKEN', '邮箱已被使用');
    }

    const passwordHash = await this.hashPasswordImpl(password, {
      randomBytesImpl: this.randomBytes,
    });
    if (typeof passwordHash !== 'string' || !passwordHash) {
      throw new TypeError('hashPasswordImpl must resolve to a non-empty string');
    }
    this.assertOpen();
    const now = this.currentTime();
    let playerId;
    let createdPlayer = false;
    let claimedGuest = false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.findAccountByUsername.get(usernameKey)) {
        validationError('USERNAME_TAKEN', '用户名已被使用');
      }
      if (this.findAccountByEmail.get(emailKey)) {
        validationError('EMAIL_TAKEN', '邮箱已被使用');
      }

      const guestPlayer = this.findByGuest.get(guestHash);
      if (guestPlayer) {
        if (this.findAccountByPlayer.get(guestPlayer.player_id)) {
          validationError('GUEST_ALREADY_LINKED', '本机玩家档案已绑定账号，请直接登录');
        }
        playerId = guestPlayer.player_id;
        claimedGuest = true;
        if (guestPlayer.nickname === DEFAULT_PLAYER_NICKNAME
          && initialNickname !== DEFAULT_PLAYER_NICKNAME) {
          this.updatePlayer.run(initialNickname, null, playerId);
        }
        this.touchPlayer.run(now, playerId);
      } else {
        let inserted = false;
        for (let attempt = 0; attempt < 8 && !inserted; attempt++) {
          playerId = randomPlayerId(this.randomBytes);
          const shortId = randomShortId(this.randomBytes);
          try {
            this.insertPlayer.run(
              playerId, shortId, guestHash, initialNickname, initialEmblem,
              defaultAvatarIdForPlayer(playerId), now, now,
            );
            inserted = true;
          } catch (error) {
            if (attempt === 7) throw error;
          }
        }
        if (!inserted) throw new Error('Unable to allocate player id');
        createdPlayer = true;
      }

      this.insertAccount.run(
        playerId,
        username,
        usernameKey,
        email,
        emailKey,
        passwordHash,
        1,
        'standard',
        now,
        now,
        now,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve registration error */ }
      throw error;
    }

    return {
      account: this.getAccount(playerId),
      profile: this.getProfile(playerId),
      claimedGuest,
      createdPlayer,
    };
  }

  async consumeUnknownAccountPasswordWork(password) {
    await this.hashPasswordImpl(password, {
      randomBytesImpl: () => Buffer.alloc(16),
    });
  }

  createDeviceAccount({ nickname, emblem, userAgent } = {}) {
    this.assertOpen();
    const initialNickname = normalizeNickname(nickname);
    const initialEmblem = emblem == null ? PLAYER_EMBLEMS[0] : normalizeEmblem(emblem);
    const now = this.currentTime();

    for (let attempt = 0; attempt < 8; attempt++) {
      const playerId = randomPlayerId(this.randomBytes);
      const shortId = randomShortId(this.randomBytes);
      const internalUsername = `device_${this.randomBytes(8).toString('base64url')}`;
      const internalEmail = `${internalUsername}@device.invalid`;
      const passwordMarker = `device$${this.randomBytes(32).toString('hex')}`;
      const guestHash = guestFingerprint(randomInternalGuestId(this.randomBytes));
      const deviceToken = randomOpaqueToken(this.randomBytes);
      const deviceHash = authTokenFingerprint(deviceToken);
      const expiresAt = now + DEVICE_LOGIN_LIFETIME_MS;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.insertPlayer.run(
          playerId, shortId, guestHash, initialNickname, initialEmblem,
          defaultAvatarIdForPlayer(playerId), now, now,
        );
        this.insertAccount.run(
          playerId,
          internalUsername,
          internalUsername.toLowerCase(),
          internalEmail,
          internalEmail.toLowerCase(),
          passwordMarker,
          0,
          'device',
          now,
          now,
          now,
        );
        this.insertDeviceCredential.run(
          deviceHash,
          playerId,
          now,
          now,
          expiresAt,
          optionalMetadataFingerprint(userAgent),
        );
        this.db.exec('COMMIT');
        return {
          deviceToken,
          account: this.getAccount(playerId),
          profile: this.getProfile(playerId),
          created: true,
        };
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* preserve allocation error */ }
        if (attempt === 7) throw error;
      }
    }
    throw new Error('Unable to allocate device account');
  }

  resolveDeviceCredential(token, { touch = true, userAgent } = {}) {
    this.assertOpen();
    const deviceHash = fingerprintOpaqueToken(token);
    if (!deviceHash) return null;
    const row = this.findDeviceCredential.get(deviceHash);
    if (!row) return null;
    const now = this.currentTime();
    const account = this.findAccountByPlayer.get(row.player_id);
    const invalid = row.revoked_at != null || row.expires_at <= now
      || !account || account.status !== 'active';
    if (invalid) {
      if (row.revoked_at == null) this.revokeDeviceCredential.run(now, deviceHash);
      return null;
    }
    if (touch) {
      this.touchDeviceCredential.run(
        now,
        optionalMetadataFingerprint(userAgent),
        deviceHash,
        now,
      );
    }
    this.touchPlayer.run(now, row.player_id);
    return {
      account: accountRowToDto(account),
      profile: this.getProfile(row.player_id),
      deviceHash,
    };
  }

  bindDeviceCredential(playerId, token, { userAgent } = {}) {
    this.assertOpen();
    const normalizedPlayerId = normalizePlayerId(playerId, 'PLAYER_NOT_IDENTIFIED');
    const existingHash = fingerprintOpaqueToken(token);
    const existing = existingHash ? this.findDeviceCredential.get(existingHash) : null;
    const now = this.currentTime();
    if (existing?.player_id === normalizedPlayerId
      && existing.revoked_at == null && existing.expires_at > now) {
      this.touchDeviceCredential.run(
        now,
        optionalMetadataFingerprint(userAgent),
        existingHash,
        now,
      );
      return { deviceToken: token, created: false };
    }
    if (existing && existing.revoked_at == null) {
      this.revokeDeviceCredential.run(now, existingHash);
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const deviceToken = randomOpaqueToken(this.randomBytes);
      const deviceHash = authTokenFingerprint(deviceToken);
      try {
        this.insertDeviceCredential.run(
          deviceHash,
          normalizedPlayerId,
          now,
          now,
          now + DEVICE_LOGIN_LIFETIME_MS,
          optionalMetadataFingerprint(userAgent),
        );
        return { deviceToken, created: true };
      } catch (error) {
        if (attempt === 7) throw error;
      }
    }
    throw new Error('Unable to allocate device credential');
  }

  revokeDeviceLogin(token) {
    this.assertOpen();
    const deviceHash = fingerprintOpaqueToken(token);
    if (!deviceHash) return false;
    return this.revokeDeviceCredential.run(this.currentTime(), deviceHash).changes === 1;
  }

  async configureAccountAccess(playerId, {
    email: rawEmail,
    newPassword: rawNewPassword,
    password: passwordAlias,
    currentPassword,
  } = {}) {
    this.assertOpen();
    const normalizedPlayerId = normalizePlayerId(playerId, 'PLAYER_NOT_IDENTIFIED');
    const snapshot = this.findAccountByPlayer.get(normalizedPlayerId);
    if (!snapshot || snapshot.status !== 'active') {
      validationError('PLAYER_NOT_IDENTIFIED', '账号不存在');
    }
    const initialSetup = Number(snapshot.login_enabled) !== 1;
    const wantsEmail = rawEmail != null && String(rawEmail).trim() !== '';
    const suppliedPassword = rawNewPassword ?? passwordAlias;
    const wantsPassword = suppliedPassword != null && suppliedPassword !== '';
    if (!wantsEmail && !wantsPassword) {
      validationError('INVALID_PROFILE', '请填写要更新的邮箱或密码');
    }
    if (initialSetup && (!wantsEmail || !wantsPassword)) {
      validationError('CREDENTIALS_INCOMPLETE', '首次设置跨设备登录需要同时填写邮箱和密码');
    }

    const normalizedEmail = wantsEmail
      ? normalizeEmail(rawEmail)
      : { email: snapshot.email, key: snapshot.email_key };
    const duplicateEmail = this.findAccountByEmail.get(normalizedEmail.key);
    if (duplicateEmail && duplicateEmail.player_id !== normalizedPlayerId) {
      validationError('EMAIL_TAKEN', '邮箱已被使用');
    }

    if (!initialSetup) {
      let normalizedCurrent;
      try {
        normalizedCurrent = normalizePassword(currentPassword, 'INVALID_CREDENTIALS');
      } catch (error) {
        if (error instanceof PlayerValidationError) {
          await this.consumeUnknownAccountPasswordWork('invalid-credential-placeholder');
        }
        throw error;
      }
      const currentValid = await this.verifyPasswordImpl(
        normalizedCurrent,
        snapshot.password_hash,
      );
      if (!currentValid) validationError('INVALID_CREDENTIALS', '当前密码错误');
    }

    const passwordHash = wantsPassword
      ? await this.hashPasswordImpl(normalizePassword(suppliedPassword), {
        randomBytesImpl: this.randomBytes,
      })
      : snapshot.password_hash;
    this.assertOpen();
    const now = this.currentTime();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.findAccountByPlayer.get(normalizedPlayerId);
      if (!current || current.status !== 'active'
        || current.password_hash !== snapshot.password_hash) {
        validationError('ACCOUNT_CHANGED', '账号资料已变化，请重新操作');
      }
      const concurrentEmail = this.findAccountByEmail.get(normalizedEmail.key);
      if (concurrentEmail && concurrentEmail.player_id !== normalizedPlayerId) {
        validationError('EMAIL_TAKEN', '邮箱已被使用');
      }
      const write = this.updateAccountCredentials.run(
        normalizedEmail.email,
        normalizedEmail.key,
        passwordHash,
        now,
        wantsPassword ? now : current.password_changed_at,
        normalizedPlayerId,
        current.password_hash,
      );
      if (write.changes !== 1) validationError('ACCOUNT_CHANGED', '账号资料已变化，请重新操作');
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve credential update error */ }
      throw error;
    }
    return this.getAccountBundle(normalizedPlayerId);
  }

  async authenticateAccount({ login, identifier, password: rawPassword } = {}) {
    this.assertOpen();
    const normalizedLogin = normalizeLogin(login ?? identifier);
    let password;
    try {
      password = normalizePassword(rawPassword, 'INVALID_CREDENTIALS');
    } catch (error) {
      if (error instanceof PlayerValidationError) {
        await this.consumeUnknownAccountPasswordWork('invalid-credential-placeholder');
      }
      throw error;
    }
    const snapshot = normalizedLogin.kind === 'email'
      ? this.findAccountByEmail.get(normalizedLogin.key)
      : this.findAccountByUsername.get(normalizedLogin.key);
    if (!snapshot) {
      await this.consumeUnknownAccountPasswordWork(password);
      validationError('INVALID_CREDENTIALS', '用户名或密码错误');
    }
    if (Number(snapshot.login_enabled) !== 1) {
      await this.consumeUnknownAccountPasswordWork(password);
      validationError('INVALID_CREDENTIALS', '用户名或密码错误');
    }
    const valid = await this.verifyPasswordImpl(password, snapshot.password_hash);
    if (!valid) validationError('INVALID_CREDENTIALS', '用户名或密码错误');
    if (snapshot.status !== 'active') validationError('ACCOUNT_DISABLED', '账号不可用');

    this.assertOpen();
    const now = this.currentTime();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.findAccountByPlayer.get(snapshot.player_id);
      if (!current || current.status !== 'active'
        || current.password_hash !== snapshot.password_hash) {
        validationError('INVALID_CREDENTIALS', '用户名或密码错误');
      }
      const write = this.updateAccountLastLogin.run(
        now, now, current.player_id, current.password_hash,
      );
      if (write.changes !== 1) validationError('INVALID_CREDENTIALS', '用户名或密码错误');
      this.touchPlayer.run(now, current.player_id);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve authentication error */ }
      throw error;
    }
    return this.getAccountBundle(snapshot.player_id);
  }

  loginAccount(input) {
    return this.authenticateAccount(input);
  }

  issueSession(playerId, {
    lifetimeMs = this.sessionLifetimeMs,
    userAgent,
    ipAddress,
  } = {}) {
    this.assertOpen();
    const normalizedPlayerId = normalizePlayerId(playerId, 'PLAYER_NOT_IDENTIFIED');
    const requestedLifetime = positiveDuration(
      lifetimeMs, this.sessionLifetimeMs, 'lifetimeMs',
    );
    const effectiveLifetime = Math.min(requestedLifetime, this.sessionLifetimeMs);
    const now = this.currentTime();
    const expiresAt = now + effectiveLifetime;
    let token;
    let sessionHash;
    let accountRow;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      accountRow = this.findAccountByPlayer.get(normalizedPlayerId);
      if (!accountRow) validationError('PLAYER_NOT_IDENTIFIED', '账号不存在');
      if (accountRow.status !== 'active') validationError('ACCOUNT_DISABLED', '账号不可用');

      const idleCutoff = now - this.sessionIdleMs;
      this.revokeStalePlayerSessions.run(now, normalizedPlayerId, now, idleCutoff);
      const active = this.activePlayerSessions.all(normalizedPlayerId, now, idleCutoff);
      const overflow = Math.max(0, active.length - this.maxAuthSessions + 1);
      for (let index = 0; index < overflow; index++) {
        this.revokeAuthSessionByHash.run(now, active[index].session_hash);
      }

      let inserted = false;
      for (let attempt = 0; attempt < 8 && !inserted; attempt++) {
        token = randomOpaqueToken(this.randomBytes);
        sessionHash = authTokenFingerprint(token);
        try {
          this.insertAuthSession.run(
            sessionHash,
            normalizedPlayerId,
            accountRow.auth_version,
            now,
            now,
            expiresAt,
            optionalMetadataFingerprint(userAgent),
            optionalMetadataFingerprint(ipAddress),
          );
          inserted = true;
        } catch (error) {
          if (attempt === 7) throw error;
        }
      }
      if (!inserted) throw new Error('Unable to allocate auth session');
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve session issue error */ }
      throw error;
    }
    return {
      token,
      session: sessionRowToDto(this.findAuthSession.get(sessionHash)),
      account: accountRowToDto(accountRow),
      profile: this.getProfile(normalizedPlayerId),
    };
  }

  issueAuthSession(playerId, options) {
    return this.issueSession(playerId, options);
  }

  resolveSession(token, { touch = true } = {}) {
    this.assertOpen();
    const sessionHash = fingerprintOpaqueToken(token);
    if (!sessionHash || !SHA256_HEX_RE.test(sessionHash)) return null;
    const row = this.findAuthSession.get(sessionHash);
    if (!row) return null;
    const now = this.currentTime();
    const accountRow = this.findAccountByPlayer.get(row.player_id);
    const expired = row.expires_at <= now || row.last_seen_at <= now - this.sessionIdleMs;
    const invalid = row.revoked_at != null || expired || !accountRow
      || accountRow.status !== 'active' || row.auth_version !== accountRow.auth_version;
    if (invalid) {
      if (row.revoked_at == null) this.revokeAuthSessionByHash.run(now, sessionHash);
      return null;
    }
    if (touch && now - row.last_seen_at >= this.sessionTouchIntervalMs) {
      this.touchAuthSession.run(now, sessionHash);
      row.last_seen_at = now;
    }
    return {
      session: sessionRowToDto(row),
      account: accountRowToDto(accountRow),
      profile: this.getProfile(row.player_id),
    };
  }

  resolveAuthSession(token, options) {
    return this.resolveSession(token, options);
  }

  revokeSession(token) {
    this.assertOpen();
    const sessionHash = fingerprintOpaqueToken(token);
    if (!sessionHash) return false;
    return this.revokeAuthSessionByHash.run(this.currentTime(), sessionHash).changes === 1;
  }

  logoutAuthSession(token) {
    return this.revokeSession(token);
  }

  revokeAllSessions(playerId, { bumpAuthVersion = false } = {}) {
    this.assertOpen();
    const normalizedPlayerId = normalizePlayerId(playerId, 'PLAYER_NOT_IDENTIFIED');
    const now = this.currentTime();
    let revoked = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const account = this.findAccountByPlayer.get(normalizedPlayerId);
      if (!account) validationError('PLAYER_NOT_IDENTIFIED', '账号不存在');
      if (bumpAuthVersion) this.bumpAccountAuthVersion.run(now, normalizedPlayerId);
      revoked = Number(this.revokeAllPlayerSessions.run(now, normalizedPlayerId).changes || 0);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve revoke error */ }
      throw error;
    }
    return revoked;
  }

  requestPasswordReset(input) {
    this.assertOpen();
    const rawEmail = typeof input === 'string' ? input : input?.email;
    const { key: emailKey } = normalizeEmail(rawEmail);
    const account = this.findAccountByEmail.get(emailKey);
    if (!account || account.status !== 'active') return null;
    const now = this.currentTime();
    const expiresAt = now + this.passwordResetTtlMs;
    let token;
    let tokenHash;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.findAccountByPlayer.get(account.player_id);
      if (!current || current.status !== 'active' || current.email_key !== emailKey) {
        this.db.exec('COMMIT');
        return null;
      }
      this.consumePlayerPasswordResets.run(now, current.player_id);
      let inserted = false;
      for (let attempt = 0; attempt < 8 && !inserted; attempt++) {
        token = randomOpaqueToken(this.randomBytes);
        tokenHash = passwordResetTokenFingerprint(token);
        try {
          this.insertPasswordReset.run(tokenHash, current.player_id, now, expiresAt);
          inserted = true;
        } catch (error) {
          if (attempt === 7) throw error;
        }
      }
      if (!inserted) throw new Error('Unable to allocate password reset token');
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve reset request error */ }
      throw error;
    }
    return {
      token,
      expiresAt: toIso(expiresAt),
      recipient: {
        playerId: account.player_id,
        username: account.username,
        email: account.email,
      },
    };
  }

  issuePasswordReset(input) {
    return this.requestPasswordReset(input);
  }

  async consumePasswordReset({ token, newPassword, password } = {}) {
    this.assertOpen();
    const tokenHash = passwordResetTokenFingerprint(token);
    const normalizedPassword = normalizePassword(newPassword ?? password);
    const passwordHash = await this.hashPasswordImpl(normalizedPassword, {
      randomBytesImpl: this.randomBytes,
    });
    if (typeof passwordHash !== 'string' || !passwordHash) {
      throw new TypeError('hashPasswordImpl must resolve to a non-empty string');
    }
    this.assertOpen();
    const now = this.currentTime();
    let playerId;
    let revokedSessions = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const reset = this.findPasswordReset.get(tokenHash);
      const account = reset ? this.findAccountByPlayer.get(reset.player_id) : null;
      if (!reset || reset.used_at != null || reset.expires_at <= now
        || !account || account.status !== 'active') {
        validationError('RESET_TOKEN_INVALID', '重置链接无效或已过期');
      }
      playerId = reset.player_id;
      const changed = this.updateAccountPassword.run(passwordHash, now, now, playerId);
      if (changed.changes !== 1) {
        validationError('RESET_TOKEN_INVALID', '重置链接无效或已过期');
      }
      this.consumePlayerPasswordResets.run(now, playerId);
      revokedSessions = Number(
        this.revokeAllPlayerSessions.run(now, playerId).changes || 0,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve reset confirmation error */ }
      throw error;
    }
    return {
      playerId,
      account: this.getAccount(playerId),
      profile: this.getProfile(playerId),
      revokedSessions,
    };
  }

  confirmPasswordReset(input) {
    return this.consumePasswordReset(input);
  }

  normalizeMatchWrite({
    matchId,
    playedAt,
    tableSize: rawTableSize = DEFAULT_TABLE_SIZE,
    results = [],
    hands = [],
  }, {
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
    const tableSize = normalizeTableSize(rawTableSize);
    if (!Array.isArray(results) || results.length > tableSize
      || (requireResults && results.length < 1)) {
      validationError('INVALID_MATCH_RESULT', `战绩人数必须为 1~${tableSize}`);
    }
    const maxHands = tableSize * MAX_ROUNDS_PER_GAME;
    if (!Array.isArray(hands) || hands.length > maxHands
      || (requireHands && hands.length < 1)) {
      validationError('INVALID_POKER_HAND', `逐手统计数量必须为 1~${maxHands}`);
    }
    const normalizedResults = results.map((result) => normalizeResult(result, tableSize));
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
    return { matchId, timestamp, tableSize, normalizedResults, normalizedHands, playerIds };
  }

  writeGameTransaction({
    matchId, timestamp, tableSize, normalizedResults, normalizedHands, playerIds,
  }) {
    let insertedHands = 0;
    let inserted = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const hand of normalizedHands) {
        const write = this.insertPokerHand.run(
          matchId,
          hand.round,
          hand.playerId,
          tableSize,
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
          tableSize,
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

  recordGame({
    matchId,
    playedAt = this.currentTime(),
    tableSize = DEFAULT_TABLE_SIZE,
    results,
    hands = [],
  }) {
    this.assertOpen();
    return this.writeGameTransaction(this.normalizeMatchWrite({
      matchId, playedAt, tableSize, results, hands,
    }, { requireResults: true }));
  }

  recordMatch({
    matchId, playedAt = this.currentTime(), tableSize = DEFAULT_TABLE_SIZE, results,
  }) {
    return this.recordGame({ matchId, playedAt, tableSize, results, hands: [] });
  }

  recordHands({
    matchId, playedAt = this.currentTime(), tableSize = DEFAULT_TABLE_SIZE, hands,
  }) {
    this.assertOpen();
    return this.writeGameTransaction(this.normalizeMatchWrite({
      matchId, playedAt, tableSize, results: [], hands,
    }, { requireHands: true }));
  }

  recordHandHistory(record) {
    this.assertOpen();
    const normalized = normalizeHandHistoryRecord(record, this.currentTime());
    const humanIds = new Set(normalized.players.map((player) => player.playerId).filter(Boolean));
    if (humanIds.size < 1) {
      validationError('INVALID_HAND_HISTORY', '牌局记录必须包含至少一名登录玩家');
    }
    for (const playerId of humanIds) {
      if (!this.findById.get(playerId)) {
        validationError('PLAYER_NOT_IDENTIFIED', '牌局记录包含不存在的玩家');
      }
    }

    let handId;
    let inserted = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const write = this.insertHandRecord.run(
        normalized.matchId,
        normalized.round,
        normalized.roomId,
        normalized.roomName,
        normalized.tableSize,
        normalized.dealerSeat,
        normalized.resolution,
        JSON.stringify(normalized.board),
        JSON.stringify(normalized.pots),
        normalized.playedAt,
      );
      handId = Number(write.lastInsertRowid || 0);
      inserted = Number(write.changes || 0);
      if (!inserted) {
        handId = Number(this.findHandRecord.get(normalized.matchId, normalized.round)?.id || 0);
      } else {
        for (const player of normalized.players) {
          this.insertHandRecordPlayer.run(
            handId,
            player.seat,
            player.playerId,
            player.playerName,
            player.heroId,
            JSON.stringify(player.hole),
            JSON.stringify(player.publicHole),
            player.folded ? 1 : 0,
            player.allIn ? 1 : 0,
            player.netResult,
            player.wonAmount,
            player.handName,
          );
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original database error */ }
      throw error;
    }
    return { inserted, handId };
  }

  getHandHistory(playerId, { limit = 20, beforeId = null } = {}) {
    this.assertOpen();
    const normalizedPlayerId = normalizePlayerId(playerId, 'AUTH_REQUIRED');
    if (!this.findById.get(normalizedPlayerId)) {
      validationError('PLAYER_NOT_IDENTIFIED', '玩家不存在');
    }
    const normalizedLimit = historyInteger(limit, '查询数量', { min: 1, max: 50 });
    const normalizedBeforeId = beforeId == null || beforeId === ''
      ? null
      : historyInteger(beforeId, '分页游标', { min: 1 });
    const queryLimit = normalizedLimit + 1;
    const rows = normalizedBeforeId == null
      ? this.handHistoryForPlayer.all(normalizedPlayerId, queryLimit)
      : this.handHistoryBeforeForPlayer.all(normalizedPlayerId, normalizedBeforeId, queryLimit);
    const hasMore = rows.length > normalizedLimit;
    const pageRows = rows.slice(0, normalizedLimit);
    const items = pageRows.map((row) => {
      const players = this.handHistoryPlayers.all(row.id).map((participant) => {
        const isYou = participant.player_id === normalizedPlayerId;
        const rawHole = JSON.parse(participant.hole_json);
        const publicHole = JSON.parse(participant.public_hole_json);
        const hole = isYou ? rawHole : publicHole;
        return {
          seat: Number(participant.seat),
          playerName: participant.player_name,
          heroId: participant.hero_id,
          isYou,
          hole,
          participated: rawHole.some(Boolean),
          visibleCardCount: hole.filter(Boolean).length,
          folded: Boolean(participant.folded),
          allIn: Boolean(participant.all_in),
          netResult: Number(participant.net_result),
          wonAmount: Number(participant.won_amount),
          handName: participant.hand_name || null,
        };
      });
      const self = players.find((participant) => participant.isYou);
      return {
        id: Number(row.id),
        matchId: row.match_id,
        roomId: Number(row.room_id),
        roomName: row.room_name,
        round: Number(row.round),
        tableSize: Number(row.table_size),
        dealerSeat: Number(row.dealer_seat),
        resolution: row.resolution,
        board: JSON.parse(row.board_json),
        pots: JSON.parse(row.pots_json),
        playedAt: toIso(row.played_at),
        selfNetResult: self?.netResult ?? 0,
        players,
      };
    });
    return {
      items,
      nextCursor: hasMore && items.length ? items.at(-1).id : null,
    };
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
