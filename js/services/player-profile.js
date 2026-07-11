const STORAGE_KEY = 'qyj-player-profile-v2';
const LEGACY_STORAGE_KEY = 'qyj-guest-profile-v1';
const EMBLEMS = ['侠', '群', '墨', '月'];

function fallbackId() {
  const random = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `guest-${Date.now().toString(36)}-${random}`;
}

function makeId() {
  try {
    return crypto.randomUUID ? crypto.randomUUID() : fallbackId();
  } catch {
    return fallbackId();
  }
}

function localShortId(id) {
  let hash = 2166136261;
  for (const ch of id) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(16).slice(-4).padStart(4, '0').toUpperCase();
}

function finiteInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
}

function normalizeStats(raw = {}) {
  const matches = finiteInt(raw.matches);
  const wins = Math.min(matches, finiteInt(raw.wins));
  const top3 = Math.min(matches, finiteInt(raw.top3));
  const bestRankValue = Number(raw.bestRank);
  const bestRank = Number.isInteger(bestRankValue) && bestRankValue >= 1
    ? bestRankValue : null;
  const winRateValue = Number(raw.winRate);
  const winRate = Number.isFinite(winRateValue)
    ? Math.max(0, Math.min(100, Math.round(winRateValue * 10) / 10))
    : matches > 0 ? Math.round((wins / matches) * 1000) / 10 : 0;
  return { matches, wins, top3, bestRank, winRate };
}

function normalizeRecentMatches(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 10).map((row = {}) => ({
    matchId: String(row.matchId || ''),
    placement: Math.max(1, finiteInt(row.placement, 1)),
    heroId: String(row.heroId || ''),
    playedAt: String(row.playedAt || ''),
    survived: Boolean(row.survived),
  }));
}

function nullableMetric(value, { ratio = false } = {}) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  const upper = ratio ? Number.POSITIVE_INFINITY : 100;
  return Math.min(upper, Math.round(number * 10) / 10);
}

function normalizePokerStats(raw = {}) {
  const confidence = ['none', 'low', 'medium', 'high'].includes(raw.confidence)
    ? raw.confidence : 'none';
  return {
    rangeLabel: typeof raw.rangeLabel === 'string' && raw.rangeLabel
      ? raw.rangeLabel : '近30天 · 最近200手',
    windowDays: finiteInt(raw.windowDays, 30) || 30,
    maxHands: finiteInt(raw.maxHands, 200) || 200,
    hands: finiteInt(raw.hands),
    confidence,
    vpip: nullableMetric(raw.vpip),
    pfr: nullableMetric(raw.pfr),
    threeBet: nullableMetric(raw.threeBet),
    af: nullableMetric(raw.af, { ratio: true }),
    wtsd: nullableMetric(raw.wtsd),
    wsd: nullableMetric(raw.wsd),
    cbet: nullableMetric(raw.cbet),
    foldToCbet: nullableMetric(raw.foldToCbet),
  };
}

function normalize(raw = {}) {
  const guestId = typeof raw.guestId === 'string' && raw.guestId
    ? raw.guestId : makeId();
  const nickname = typeof raw.nickname === 'string' && raw.nickname.trim()
    ? [...raw.nickname.trim()].slice(0, 8).join('')
    : '无名侠客';
  const emblem = EMBLEMS.includes(raw.emblem) ? raw.emblem : EMBLEMS[0];
  const playerId = raw.playerId == null ? '' : String(raw.playerId);
  const serverShortId = typeof raw.shortId === 'string' ? raw.shortId.trim() : '';
  return {
    guestId,
    playerId,
    shortId: serverShortId || localShortId(guestId),
    nickname,
    emblem,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    lastSeenAt: typeof raw.lastSeenAt === 'string' ? raw.lastSeenAt : '',
    stats: normalizeStats(raw.stats),
    recentMatches: normalizeRecentMatches(raw.recentMatches),
    pokerStats: normalizePokerStats(raw.pokerStats),
  };
}

function readStoredProfile() {
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    if (current) return JSON.parse(current);
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    return legacy ? JSON.parse(legacy) : null;
  } catch {
    return null;
  }
}

export function loadPlayerProfile() {
  const profile = normalize(readStoredProfile() || {});
  savePlayerProfile(profile);
  return profile;
}

export function savePlayerProfile(next) {
  const profile = normalize(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // The in-memory profile remains usable when storage is unavailable.
  }
  return profile;
}

export function mergeServerPlayerProfile(current, serverProfile = {}) {
  const local = normalize(current || {});
  return savePlayerProfile({
    ...local,
    ...serverProfile,
    guestId: local.guestId,
    stats: serverProfile.stats || local.stats,
    recentMatches: serverProfile.recentMatches || local.recentMatches,
    pokerStats: serverProfile.pokerStats || local.pokerStats,
  });
}

export function playerIdentityPayload(profile) {
  const normalized = normalize(profile || {});
  return {
    guestId: normalized.guestId,
    nickname: normalized.nickname,
    emblem: normalized.emblem,
  };
}

export function validateNickname(value) {
  const nickname = String(value || '').trim();
  const length = [...nickname].length;
  if (!length) return { ok: false, reason: '请输入昵称' };
  if (length > 8) return { ok: false, reason: '昵称最多 8 个字符' };
  if (/[<>\u0000-\u001f]/u.test(nickname)) return { ok: false, reason: '昵称包含不可用字符' };
  return { ok: true, nickname };
}

export const PLAYER_EMBLEMS = Object.freeze([...EMBLEMS]);
