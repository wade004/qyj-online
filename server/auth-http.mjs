import { createHash } from 'node:crypto';

import { PlayerValidationError } from './player-store.mjs';

export const AUTH_COOKIE_NAME = 'qyj_session';
export const DEFAULT_AUTH_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const MAX_JSON_BYTES = 16 * 1024;
const LOCAL_TRUSTED_ORIGINS = new Set([
  'http://127.0.0.1:8080',
  'http://localhost:8080',
  'http://[::1]:8080',
]);
const RATE_WINDOWS = Object.freeze({
  register: { limit: 5, windowMs: 10 * 60_000 },
  loginIp: { limit: 20, windowMs: 10 * 60_000 },
  loginIdentity: { limit: 10, windowMs: 10 * 60_000 },
  resetIp: { limit: 8, windowMs: 15 * 60_000 },
  resetEmail: { limit: 4, windowMs: 15 * 60_000 },
  resetConfirm: { limit: 10, windowMs: 15 * 60_000 },
});

function json(response, status, payload) {
  const body = payload == null ? '' : JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

function ok(response, status, data = null) {
  json(response, status, { ok: true, data });
}

function fail(response, status, code, message) {
  json(response, status, { ok: false, error: { code, message } });
}

export function parseCookies(header = '') {
  const cookies = new Map();
  for (const segment of String(header || '').split(';')) {
    const index = segment.indexOf('=');
    if (index <= 0) continue;
    const key = segment.slice(0, index).trim();
    const raw = segment.slice(index + 1).trim();
    if (!key) continue;
    try { cookies.set(key, decodeURIComponent(raw)); } catch { cookies.set(key, raw); }
  }
  return cookies;
}

export function authTokenFromRequest(request) {
  return parseCookies(request?.headers?.cookie).get(AUTH_COOKIE_NAME) || '';
}

export function authSessionHash(token) {
  return token ? createHash('sha256').update(String(token), 'utf8').digest('hex') : '';
}

function sessionCookie(token, { secure = false, maxAge = DEFAULT_AUTH_SESSION_MAX_AGE_SECONDS } = {}) {
  const attributes = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

function originSet(values = []) {
  const set = new Set(LOCAL_TRUSTED_ORIGINS);
  for (const value of values || []) {
    try { set.add(new URL(String(value)).origin); } catch { /* ignore invalid configuration */ }
  }
  return set;
}

export function isTrustedOrigin(origin, trustedOrigins = []) {
  if (!origin) return true;
  try { return originSet(trustedOrigins).has(new URL(origin).origin); } catch { return false; }
}

function applyCors(request, response, trustedOrigins) {
  const origin = String(request.headers.origin || '');
  let sameOrigin = false;
  try {
    sameOrigin = Boolean(request.headers.host)
      && new URL(origin).host.toLowerCase() === String(request.headers.host).toLowerCase();
  } catch { /* invalid or absent origin */ }
  if (!origin || (!sameOrigin && !isTrustedOrigin(origin, trustedOrigins))) return false;
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-credentials', 'true');
  response.setHeader('access-control-allow-headers', 'content-type');
  response.setHeader('access-control-allow-methods', 'GET,POST,PATCH,OPTIONS');
  response.setHeader('vary', 'Origin');
  return true;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      const error = new Error('请求内容过大');
      error.code = 'REQUEST_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    const error = new Error('请求必须是 JSON 对象');
    error.code = 'INVALID_JSON';
    throw error;
  }
}

function validationStatus(code) {
  if (['USERNAME_TAKEN', 'EMAIL_TAKEN', 'GUEST_ALREADY_LINKED'].includes(code)) return 409;
  if (code === 'INVALID_CREDENTIALS' || code === 'AUTH_REQUIRED' || code === 'AUTH_SESSION_INVALID') return 401;
  if (code === 'RATE_LIMITED') return 429;
  return 400;
}

function safeAccountData(value) {
  if (!value || typeof value !== 'object') return { account: null, profile: null };
  const account = value.account || value;
  const profile = value.profile || account.profile || null;
  return {
    account: account ? {
      username: account.username,
      email: account.email,
      createdAt: account.createdAt,
    } : null,
    profile,
  };
}

export function createAuthHttpHandler({
  playerStore,
  mailer,
  trustedOrigins = [],
  cookieSecure = process.env.NODE_ENV === 'production',
  rateLimitMultiplier = 1,
  onSessionRevoked = () => {},
  onAccountSessionsRevoked = () => {},
  onProfileUpdated = () => {},
} = {}) {
  if (!playerStore) throw new TypeError('playerStore is required');
  const rateBuckets = new Map();
  const normalizedRateLimitMultiplier = Number.isFinite(rateLimitMultiplier) && rateLimitMultiplier > 0
    ? rateLimitMultiplier
    : 1;

  function rateAllowed(kind, key) {
    const rule = RATE_WINDOWS[kind];
    const now = Date.now();
    const bucketKey = `${kind}:${String(key || '-')}`;
    let bucket = rateBuckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + rule.windowMs };
      rateBuckets.set(bucketKey, bucket);
    }
    bucket.count++;
    if (rateBuckets.size > 2_000) {
      for (const [storedKey, stored] of rateBuckets) {
        if (stored.resetAt <= now) rateBuckets.delete(storedKey);
      }
    }
    return bucket.count <= Math.max(1, Math.floor(rule.limit * normalizedRateLimitMultiplier));
  }

  function clientAddress(request) {
    return String(request.socket?.remoteAddress || 'unknown');
  }

  function sessionMetadata(request) {
    return {
      userAgent: String(request.headers['user-agent'] || '').slice(0, 512),
      ipAddress: clientAddress(request),
    };
  }

  function enforceRate(response, ...checks) {
    if (checks.every(([kind, key]) => rateAllowed(kind, key))) return true;
    fail(response, 429, 'RATE_LIMITED', '尝试次数过多，请稍后再试');
    return false;
  }

  async function resolveRequestSession(request) {
    const token = authTokenFromRequest(request);
    if (!token) return null;
    return playerStore.resolveAuthSession(token, { touch: true });
  }

  return async function handleAuthHttp(request, response) {
    const url = new URL(request.url || '/', 'http://auth.local');
    if (!url.pathname.startsWith('/api/')) return false;

    const origin = String(request.headers.origin || '');
    const corsAllowed = applyCors(request, response, trustedOrigins);
    if (origin && !corsAllowed) {
      fail(response, 403, 'ORIGIN_NOT_ALLOWED', '请求来源不受信任');
      return true;
    }
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.setHeader('cache-control', 'no-store');
      response.end();
      return true;
    }

    try {
      if (request.method === 'GET' && url.pathname === '/api/auth/me') {
        const session = await resolveRequestSession(request);
        if (!session) {
          ok(response, 200, { authenticated: false });
          return true;
        }
        ok(response, 200, { authenticated: true, ...safeAccountData(session) });
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/register') {
        const body = await readJson(request);
        if (!enforceRate(response, ['register', clientAddress(request)])) return true;
        const registered = await playerStore.registerAccount(body);
        const issued = await playerStore.issueAuthSession(
          registered.playerId || registered.profile?.playerId,
          sessionMetadata(request),
        );
        response.setHeader('set-cookie', sessionCookie(issued.token, { secure: cookieSecure }));
        ok(response, 201, { authenticated: true, ...safeAccountData(registered) });
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJson(request);
        const loginKey = String(body.login ?? body.identifier ?? '').trim().toLowerCase();
        if (!enforceRate(
          response,
          ['loginIp', clientAddress(request)],
          ['loginIdentity', loginKey],
        )) return true;
        const authenticated = await playerStore.loginAccount({
          login: body.login ?? body.identifier,
          password: body.password,
        });
        const issued = await playerStore.issueAuthSession(
          authenticated.playerId || authenticated.profile?.playerId,
          sessionMetadata(request),
        );
        response.setHeader('set-cookie', sessionCookie(issued.token, { secure: cookieSecure }));
        ok(response, 200, { authenticated: true, ...safeAccountData(authenticated) });
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        const token = authTokenFromRequest(request);
        const sessionHash = authSessionHash(token);
        if (token) await playerStore.logoutAuthSession(token);
        response.setHeader('set-cookie', sessionCookie('', { secure: cookieSecure, maxAge: 0 }));
        await onSessionRevoked(sessionHash);
        ok(response, 200, { loggedOut: true });
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/player/me/hands') {
        const session = await resolveRequestSession(request);
        if (!session) {
          fail(response, 401, 'AUTH_REQUIRED', '请先登录联机账号');
          return true;
        }
        const history = playerStore.getHandHistory(
          session.playerId || session.profile?.playerId,
          {
            limit: url.searchParams.get('limit') || 20,
            beforeId: url.searchParams.get('cursor') || null,
          },
        );
        ok(response, 200, history);
        return true;
      }

      if (request.method === 'PATCH' && url.pathname === '/api/player/me') {
        const session = await resolveRequestSession(request);
        if (!session) {
          fail(response, 401, 'AUTH_REQUIRED', '请先登录联机账号');
          return true;
        }
        const body = await readJson(request);
        const profile = playerStore.updateProfile(session.playerId || session.profile?.playerId, {
          ...(Object.hasOwn(body, 'nickname') ? { nickname: body.nickname } : {}),
          ...(Object.hasOwn(body, 'emblem') ? { emblem: body.emblem } : {}),
        });
        await onProfileUpdated(profile);
        ok(response, 200, { profile });
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/password-reset/request') {
        const body = await readJson(request);
        const emailKey = String(body.email || '').trim().toLowerCase();
        if (!enforceRate(
          response,
          ['resetIp', clientAddress(request)],
          ['resetEmail', emailKey],
        )) return true;
        const issued = await playerStore.issuePasswordReset({ email: body.email });
        if (issued && mailer?.send) {
          try {
            await mailer.send({
              to: issued.to || issued.recipient?.email,
              token: issued.token,
              expiresAt: issued.expiresAt,
            });
          } catch (error) {
            console.error('[Auth] 密码重置邮件发送失败', error);
          }
        }
        ok(response, 202, {
          accepted: true,
          message: '如果该邮箱已注册，重置邮件已经发送。',
        });
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/auth/password-reset/confirm') {
        const body = await readJson(request);
        if (!enforceRate(response, ['resetConfirm', clientAddress(request)])) return true;
        const reset = await playerStore.confirmPasswordReset({
          token: body.token,
          newPassword: body.newPassword,
        });
        await onAccountSessionsRevoked(
          reset.playerId || reset.account?.playerId || reset.profile?.playerId,
        );
        ok(response, 200, { reset: true, message: '密码已重置，请使用新密码登录。' });
        return true;
      }

      fail(response, 404, 'NOT_FOUND', '接口不存在');
      return true;
    } catch (error) {
      if (error instanceof PlayerValidationError) {
        fail(response, validationStatus(error.code), error.code, error.message);
        return true;
      }
      if (error?.code === 'REQUEST_TOO_LARGE') {
        fail(response, 413, error.code, error.message);
        return true;
      }
      if (error?.code === 'INVALID_JSON') {
        fail(response, 400, error.code, error.message);
        return true;
      }
      console.error('[Auth] HTTP 请求处理失败', error);
      fail(response, 500, 'INTERNAL_ERROR', '账号服务暂时不可用');
      return true;
    }
  };
}

export { sessionCookie as serializeAuthCookie };
