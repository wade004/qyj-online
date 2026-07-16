import { resolveWebSocketUrl } from '../net/protocol.js';

const DEFAULT_NETWORK_MESSAGE = '无法连接账号服务，请检查网络后重试';
const DEFAULT_RESPONSE_MESSAGE = '账号服务返回了无效响应';

function fallbackBase(locationLike) {
  if (typeof locationLike?.href === 'string' && locationLike.href) return locationLike.href;
  const protocol = locationLike?.protocol === 'https:' ? 'https:' : 'http:';
  const hostname = locationLike?.hostname || '127.0.0.1';
  const port = locationLike?.port ? `:${locationLike.port}` : '';
  return `${protocol}//${hostname}${port}/`;
}

function httpOrigin(value, base) {
  if (value == null || value === '') return '';
  try {
    const url = new URL(String(value), base);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

/**
 * Resolve the HTTP origin that owns the account API. An explicit
 * QYJ_API_URL wins; otherwise the configured WebSocket host is reused with
 * ws/wss translated to http/https. Only the origin is retained deliberately:
 * every endpoint below has one canonical /api path.
 */
export function resolveAccountApiOrigin({
  override = globalThis.QYJ_API_URL,
  wsUrl = globalThis.QYJ_WS_URL,
  location: locationLike = globalThis.location,
} = {}) {
  const base = fallbackBase(locationLike);
  const explicit = httpOrigin(override, base);
  if (explicit) return explicit;

  const socket = resolveWebSocketUrl({ location: locationLike, override: wsUrl });
  const derived = httpOrigin(socket, base);
  if (derived) return derived;

  return httpOrigin(base, 'http://127.0.0.1:8790/') || 'http://127.0.0.1:8790';
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedError(value, response) {
  const source = isObject(value?.error)
    ? value.error
    : isObject(value)
      ? value
      : {};
  const status = Number(response?.status) || 0;
  const code = typeof source.code === 'string' && source.code
    ? source.code
    : status > 0
      ? `HTTP_${status}`
      : 'REQUEST_FAILED';
  const message = typeof source.message === 'string' && source.message
    ? source.message
    : response?.statusText
      ? String(response.statusText)
      : '请求未能完成';
  return {
    code,
    message,
    ...(status > 0 ? { status } : {}),
  };
}

function success(data = null) {
  return { ok: true, data: data ?? null, error: null };
}

function failure(error) {
  return { ok: false, data: null, error };
}

async function readJsonResponse(response) {
  let text;
  try {
    text = await response.text();
  } catch {
    return { parsed: false, empty: false, value: null };
  }
  if (!text) return { parsed: true, empty: true, value: null };
  try {
    return { parsed: true, empty: false, value: JSON.parse(text) };
  } catch {
    return { parsed: false, empty: false, value: null };
  }
}

function loginPayload(value, password) {
  if (isObject(value)) {
    const login = value.login ?? value.identifier;
    return { ...value, login, identifier: undefined };
  }
  return { login: value, password };
}

function emailPayload(value) {
  return isObject(value) ? value : { email: value };
}

function resetPayload(value, newPassword) {
  return isObject(value) ? value : { token: value, newPassword };
}

/**
 * Cookie-backed account API client. Authentication is intentionally absent
 * from this object's state: the browser owns the HttpOnly session cookie and
 * every request opts into credentials. No token is read from or written to
 * localStorage/sessionStorage.
 */
export function createAccountClient({
  apiOrigin = '',
  wsUrl = globalThis.QYJ_WS_URL,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  const origin = resolveAccountApiOrigin({ override: apiOrigin, wsUrl });

  async function request(path, { method = 'GET', body } = {}) {
    if (typeof fetchImpl !== 'function') {
      return failure({ code: 'FETCH_UNAVAILABLE', message: DEFAULT_NETWORK_MESSAGE });
    }

    const headers = { Accept: 'application/json' };
    const init = {
      method,
      credentials: 'include',
      cache: 'no-store',
      headers,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetchImpl(new URL(path, `${origin}/`).href, init);
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      return failure({
        code: aborted ? 'REQUEST_ABORTED' : 'NETWORK_ERROR',
        message: aborted ? '请求已取消' : DEFAULT_NETWORK_MESSAGE,
      });
    }

    const bodyResult = await readJsonResponse(response);
    if (!bodyResult.parsed) {
      if (!response.ok) return failure(normalizedError(null, response));
      return failure({
        code: 'INVALID_RESPONSE',
        message: DEFAULT_RESPONSE_MESSAGE,
        status: Number(response.status) || 0,
      });
    }

    const value = bodyResult.value;
    if (!response.ok) return failure(normalizedError(value, response));
    if (isObject(value) && value.ok === false) {
      return failure(normalizedError(value, response));
    }
    if (isObject(value) && value.ok === true) {
      if (Object.hasOwn(value, 'data')) return success(value.data);
      const { ok: _ok, error: _error, ...data } = value;
      return success(Object.keys(data).length ? data : null);
    }
    return success(value);
  }

  return Object.freeze({
    apiOrigin: origin,
    getSession: () => request('/api/auth/me'),
    deviceLogin: (payload = {}) => request('/api/auth/device', { method: 'POST', body: payload }),
    register: (payload) => request('/api/auth/register', { method: 'POST', body: payload }),
    login: (payload, password) => request('/api/auth/login', {
      method: 'POST',
      body: loginPayload(payload, password),
    }),
    logout: () => request('/api/auth/logout', { method: 'POST' }),
    updateProfile: (payload) => request('/api/player/me', { method: 'PATCH', body: payload }),
    updateCredentials: (payload) => request('/api/player/me/credentials', {
      method: 'PATCH',
      body: payload,
    }),
    getHandHistory: ({ limit = 20, cursor = null } = {}) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor != null && cursor !== '') query.set('cursor', String(cursor));
      return request(`/api/player/me/hands?${query}`);
    },
    requestPasswordReset: (payload) => request('/api/auth/password-reset/request', {
      method: 'POST',
      body: emailPayload(payload),
    }),
    confirmPasswordReset: (payload, newPassword) => request('/api/auth/password-reset/confirm', {
      method: 'POST',
      body: resetPayload(payload, newPassword),
    }),
  });
}

/**
 * Consume a reset token exactly once from the current address. The token is
 * returned to the caller in memory and removed from the visible URL before
 * any asynchronous work can expose it through copied links or referrers.
 */
export function consumeResetTokenFromLocation({
  location: locationLike = globalThis.location,
  history: historyLike = globalThis.history,
  parameter = 'resetToken',
} = {}) {
  let href = typeof locationLike?.href === 'string' ? locationLike.href : '';
  if (!href) {
    try {
      href = new URL(
        `${locationLike?.pathname || '/'}${locationLike?.search || ''}${locationLike?.hash || ''}`,
        fallbackBase(locationLike),
      ).href;
    } catch {
      return '';
    }
  }
  let url;
  try {
    url = new URL(href, fallbackBase(locationLike));
  } catch {
    return '';
  }
  if (!url.searchParams.has(parameter)) return '';

  const token = url.searchParams.get(parameter) || '';
  url.searchParams.delete(parameter);
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  try {
    historyLike?.replaceState?.(historyLike.state ?? null, '', nextUrl);
  } catch {
    // A restrictive embedded browser can deny history mutation. The token is
    // still never stored by this module and remains only in the return value.
  }
  return token;
}
