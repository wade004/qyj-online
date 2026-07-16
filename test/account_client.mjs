import assert from 'node:assert/strict';

import {
  consumeResetTokenFromLocation,
  createAccountClient,
  resolveAccountApiOrigin,
} from '../js/services/account-client.js';

function response(status, body, statusText = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async text() {
      if (body === undefined || body === null) return '';
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

assert.equal(resolveAccountApiOrigin({
  override: 'https://accounts.example.test/some/path?ignored=1',
}), 'https://accounts.example.test');
assert.equal(resolveAccountApiOrigin({
  override: '',
  wsUrl: 'wss://game.example.test/ws',
}), 'https://game.example.test');
assert.equal(resolveAccountApiOrigin({
  override: '',
  wsUrl: 'ws://127.0.0.1:8790/ws',
}), 'http://127.0.0.1:8790');

const calls = [];
const replies = [
  response(200, { ok: true, data: { authenticated: true } }),
  response(201, { ok: true, data: { authenticated: true, created: true } }),
  response(201, { ok: true, data: { username: 'hero' } }),
  response(200, { ok: true, data: { username: 'hero' } }),
  response(204),
  response(200, { ok: true, data: { nickname: '青州侠' } }),
  response(200, { ok: true, data: { email: 'hero@example.test' } }),
  response(200, { ok: true, data: { items: [], nextCursor: null } }),
  response(202, { ok: true, data: { accepted: true } }),
  response(200, { ok: true, data: { reset: true } }),
];
const client = createAccountClient({
  apiOrigin: 'http://127.0.0.1:9123/base-is-ignored',
  fetch: async (url, init) => {
    calls.push({ url, init });
    return replies.shift();
  },
});

assert.deepEqual(await client.getSession(), {
  ok: true, data: { authenticated: true }, error: null,
});
await client.deviceLogin({ nickname: '一键侠' });
await client.register({ username: 'hero', email: 'hero@example.test', password: 'Secret!123' });
await client.login({ identifier: 'hero@example.test', password: 'Secret!123' });
assert.deepEqual(await client.logout(), { ok: true, data: null, error: null });
await client.updateProfile({ nickname: '青州侠', emblem: '侠' });
await client.updateCredentials({
  email: 'hero@example.test', currentPassword: 'Secret!123', newPassword: 'NewSecret!456',
});
await client.getHandHistory({ limit: 10, cursor: 42 });
await client.requestPasswordReset('hero@example.test');
await client.confirmPasswordReset('reset-token', 'NewSecret!456');

assert.deepEqual(calls.map(({ url, init }) => ({
  path: `${new URL(url).pathname}${new URL(url).search}`,
  method: init.method,
  credentials: init.credentials,
  body: init.body ? JSON.parse(init.body) : null,
})), [
  { path: '/api/auth/me', method: 'GET', credentials: 'include', body: null },
  {
    path: '/api/auth/device', method: 'POST', credentials: 'include',
    body: { nickname: '一键侠' },
  },
  {
    path: '/api/auth/register', method: 'POST', credentials: 'include',
    body: { username: 'hero', email: 'hero@example.test', password: 'Secret!123' },
  },
  {
    path: '/api/auth/login', method: 'POST', credentials: 'include',
    body: { login: 'hero@example.test', password: 'Secret!123' },
  },
  { path: '/api/auth/logout', method: 'POST', credentials: 'include', body: null },
  {
    path: '/api/player/me', method: 'PATCH', credentials: 'include',
    body: { nickname: '青州侠', emblem: '侠' },
  },
  {
    path: '/api/player/me/credentials', method: 'PATCH', credentials: 'include',
    body: {
      email: 'hero@example.test', currentPassword: 'Secret!123', newPassword: 'NewSecret!456',
    },
  },
  { path: '/api/player/me/hands?limit=10&cursor=42', method: 'GET', credentials: 'include', body: null },
  {
    path: '/api/auth/password-reset/request', method: 'POST', credentials: 'include',
    body: { email: 'hero@example.test' },
  },
  {
    path: '/api/auth/password-reset/confirm', method: 'POST', credentials: 'include',
    body: { token: 'reset-token', newPassword: 'NewSecret!456' },
  },
]);
assert.ok(calls.every(({ init }) => init.cache === 'no-store'));
assert.ok(calls.filter(({ init }) => init.body)
  .every(({ init }) => init.headers['Content-Type'] === 'application/json'));

const rejected = createAccountClient({
  apiOrigin: 'https://game.example.test',
  fetch: async () => response(401, {
    ok: false,
    error: { code: 'INVALID_CREDENTIALS', message: '用户名、邮箱或密码错误' },
  }, 'Unauthorized'),
});
assert.deepEqual(await rejected.login('hero', 'wrong'), {
  ok: false,
  data: null,
  error: {
    code: 'INVALID_CREDENTIALS',
    message: '用户名、邮箱或密码错误',
    status: 401,
  },
});

const networkFailure = createAccountClient({
  fetch: async () => { throw new TypeError('connection refused'); },
});
assert.deepEqual(await networkFailure.getSession(), {
  ok: false,
  data: null,
  error: {
    code: 'NETWORK_ERROR',
    message: '无法连接账号服务，请检查网络后重试',
  },
});

const invalidResponse = createAccountClient({
  fetch: async () => response(200, '<html>not json</html>'),
});
assert.equal((await invalidResponse.getSession()).error.code, 'INVALID_RESPONSE');

const historyCalls = [];
const token = consumeResetTokenFromLocation({
  location: {
    href: 'https://game.example.test/index.html?from=mail&resetToken=abc_123#account',
  },
  history: {
    state: { preserved: true },
    replaceState(...args) { historyCalls.push(args); },
  },
});
assert.equal(token, 'abc_123');
assert.deepEqual(historyCalls, [[
  { preserved: true },
  '',
  '/index.html?from=mail#account',
]]);
assert.equal(consumeResetTokenFromLocation({
  location: { href: 'https://game.example.test/index.html?from=mail' },
  history: { replaceState() { throw new Error('should not be called'); } },
}), '');

console.log('Account client contract passed: credentialed API, normalized failures and reset URL consumption.');
