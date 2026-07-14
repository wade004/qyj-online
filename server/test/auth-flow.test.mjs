import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import WebSocket from 'ws';

import {
  PLAYER_EMBLEMS,
  PlayerValidationError,
  createPlayerStore,
} from '../player-store.mjs';
import { ERROR_CODES, PROTOCOL_VERSION } from '../protocol.mjs';
import { createPasswordResetMailer } from '../password-mailer.mjs';
import { startServer } from '../server.mjs';

const ORIGIN = 'http://127.0.0.1:8080';
const PASSWORD = 'Correct-Horse-2026';
const NEW_PASSWORD = 'New-Correct-Horse-2026';

function hasValidationCode(code) {
  return (error) => error instanceof PlayerValidationError && error.code === code;
}

function fastPasswordHash(password) {
  return Promise.resolve(`test-password:${password}`);
}

function fastPasswordVerify(password, encoded) {
  return Promise.resolve(encoded === `test-password:${password}`);
}

async function openServer() {
  const outbox = [];
  const passwordResetMailer = {
    outbox,
    async send(message) {
      outbox.push({ ...message });
      return { delivered: true };
    },
  };
  const server = startServer(0, {
    heartbeatMs: 0,
    shutdownGraceMs: 100,
    databasePath: ':memory:',
    passwordResetMailer,
  });
  await server.ready;
  const address = server.httpServer.address();
  assert.ok(address && typeof address === 'object');
  return {
    server,
    outbox,
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

function cookiePair(response) {
  const header = response.headers.getSetCookie?.()[0]
    || response.headers.get('set-cookie')
    || '';
  return header.split(';', 1)[0];
}

async function requestJson(baseUrl, path, {
  method = 'GET',
  body,
  cookie = '',
} = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    response,
    payload: await response.json(),
    cookie: cookiePair(response),
  };
}

async function registerOverHttp(baseUrl, {
  username = 'network_player',
  email = 'network.player@example.com',
  password = PASSWORD,
} = {}) {
  return requestJson(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: {
      username,
      email,
      password,
      guestId: `guest-${username}-000001`,
      nickname: '联机侠客',
      emblem: PLAYER_EMBLEMS[0],
    },
  });
}

function createSocketInbox(ws) {
  const messages = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const waiterIndex = waiters.findIndex(({ predicate }) => predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    messages.push(message);
  });
  return {
    waitFor(predicate, label, timeoutMs = 2_000) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const waiterIndex = waiters.findIndex((item) => item.resolve === resolve);
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
          reject(new Error(`${label} timed out`));
        }, timeoutMs);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
  };
}

async function connectWebSocket(port, cookie = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: {
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
  });
  const inbox = createSocketInbox(ws);
  await once(ws, 'open');
  ws.send(JSON.stringify({
    cmd: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    capabilities: ['table-size-9'],
  }));
  const session = await inbox.waitFor((message) => message.ev === 'session', 'session');
  return { ws, inbox, session };
}

async function closeSocket(ws) {
  if (ws.readyState >= WebSocket.CLOSING) return;
  const closed = once(ws, 'close');
  ws.close();
  await closed;
}

test('PlayerStore supports registration, username/email login, sessions, profile edits, and email reset', async () => {
  const store = createPlayerStore({
    databasePath: ':memory:',
    hashPasswordImpl: fastPasswordHash,
    verifyPasswordImpl: fastPasswordVerify,
  });
  try {
    const requiredRegistrationCases = [
      [{ email: 'missing.username@example.com', password: PASSWORD }, 'INVALID_USERNAME'],
      [{ username: 'missing_email', password: PASSWORD }, 'INVALID_EMAIL'],
      [{ username: 'missing_password', email: 'missing.password@example.com' }, 'INVALID_PASSWORD'],
    ];
    for (const [input, code] of requiredRegistrationCases) {
      await assert.rejects(store.registerAccount(input), hasValidationCode(code));
    }

    const registered = await store.registerAccount({
      username: 'Sword_Master',
      email: 'Sword.Master@Example.com',
      password: PASSWORD,
      guestId: 'guest-store-account-000001',
      nickname: '剑客',
      emblem: PLAYER_EMBLEMS[1],
    });
    assert.equal(registered.account.username, 'Sword_Master');
    assert.equal(registered.account.email, 'Sword.Master@Example.com');
    assert.equal(registered.profile.nickname, '剑客');
    assert.equal(Object.hasOwn(registered.account, 'passwordHash'), false);
    assert.equal(JSON.stringify(registered).includes(PASSWORD), false);

    const usernameLogin = await store.loginAccount({
      identifier: 'sword_master',
      password: PASSWORD,
    });
    const emailLogin = await store.loginAccount({
      login: 'sword.master@example.com',
      password: PASSWORD,
    });
    assert.equal(usernameLogin.account.playerId, registered.profile.playerId);
    assert.equal(emailLogin.account.playerId, registered.profile.playerId);

    const updated = store.updateProfile(registered.profile.playerId, {
      nickname: '新剑客',
      emblem: PLAYER_EMBLEMS[2],
    });
    assert.equal(updated.nickname, '新剑客');
    assert.equal(updated.emblem, PLAYER_EMBLEMS[2]);

    const issuedSession = store.issueAuthSession(registered.profile.playerId);
    assert.equal(
      store.resolveAuthSession(issuedSession.token)?.account.playerId,
      registered.profile.playerId,
    );
    assert.equal(store.logoutAuthSession(issuedSession.token), true);
    assert.equal(store.resolveAuthSession(issuedSession.token), null);

    const reset = store.issuePasswordReset({ email: 'SWORD.MASTER@EXAMPLE.COM' });
    assert.equal(reset.recipient.email, 'Sword.Master@Example.com');
    await store.confirmPasswordReset({ token: reset.token, newPassword: NEW_PASSWORD });
    await assert.rejects(
      store.loginAccount({ login: 'Sword_Master', password: PASSWORD }),
      hasValidationCode('INVALID_CREDENTIALS'),
    );
    const afterReset = await store.loginAccount({
      login: 'Sword.Master@Example.com',
      password: NEW_PASSWORD,
    });
    assert.equal(afterReset.profile.playerId, registered.profile.playerId);
    await assert.rejects(
      store.confirmPasswordReset({ token: reset.token, newPassword: PASSWORD }),
      hasValidationCode('RESET_TOKEN_INVALID'),
    );
  } finally {
    store.close();
  }
});

test('account registration promotes a short username when the requested nickname is the system default', async () => {
  for (const [label, nickname] of [
    ['omitted', undefined],
    ['explicit default', '无名侠客'],
  ]) {
    const store = createPlayerStore({
      databasePath: ':memory:',
      hashPasswordImpl: fastPasswordHash,
      verifyPasswordImpl: fastPasswordVerify,
    });
    try {
      const registered = await store.registerAccount({
        username: '阳顶天',
        email: `yang.dingtian.${label.replace(' ', '.')}@example.com`,
        password: PASSWORD,
        guestId: `guest-default-nickname-${label.replace(' ', '-')}-0001`,
        ...(nickname === undefined ? {} : { nickname }),
      });
      assert.equal(registered.account.username, '阳顶天');
      assert.equal(registered.profile.nickname, '阳顶天');
      assert.equal(store.getProfile(registered.profile.playerId).nickname, '阳顶天');
    } finally {
      store.close();
    }
  }
});

test('claiming a guest promotes only the system-default nickname and preserves a custom nickname', async () => {
  const store = createPlayerStore({
    databasePath: ':memory:',
    hashPasswordImpl: fastPasswordHash,
    verifyPasswordImpl: fastPasswordVerify,
  });
  try {
    const defaultGuestId = 'guest-claim-default-nickname-0001';
    const defaultGuest = store.identify({
      guestId: defaultGuestId,
      nickname: '无名侠客',
      emblem: PLAYER_EMBLEMS[0],
    }).profile;
    const claimedDefault = await store.registerAccount({
      username: '阳顶天',
      email: 'claimed.default@example.com',
      password: PASSWORD,
      guestId: defaultGuestId,
      nickname: '无名侠客',
    });
    assert.equal(claimedDefault.claimedGuest, true);
    assert.equal(claimedDefault.createdPlayer, false);
    assert.equal(claimedDefault.profile.playerId, defaultGuest.playerId);
    assert.equal(claimedDefault.profile.nickname, '阳顶天');

    const customGuestId = 'guest-claim-custom-nickname-0002';
    const customGuest = store.identify({
      guestId: customGuestId,
      nickname: '剑胆琴心',
      emblem: PLAYER_EMBLEMS[1],
    }).profile;
    const claimedCustom = await store.registerAccount({
      username: '东方白',
      email: 'claimed.custom@example.com',
      password: PASSWORD,
      guestId: customGuestId,
      nickname: '无名侠客',
    });
    assert.equal(claimedCustom.claimedGuest, true);
    assert.equal(claimedCustom.createdPlayer, false);
    assert.equal(claimedCustom.profile.playerId, customGuest.playerId);
    assert.equal(claimedCustom.profile.nickname, '剑胆琴心');
    assert.equal(store.getProfile(customGuest.playerId).nickname, '剑胆琴心');
  } finally {
    store.close();
  }
});

test('production password reset refuses to start without a delivery webhook', () => {
  assert.throws(
    () => createPasswordResetMailer({ environment: 'production', webhookUrl: '' }),
    /QYJ_MAIL_WEBHOOK_URL/u,
  );
});

test('HTTP account flow uses an HttpOnly cookie and supports me/logout/profile/reset end to end', async () => {
  const runtime = await openServer();
  try {
    const registered = await registerOverHttp(runtime.baseUrl, {
      username: 'http_player',
      email: 'http.player@example.com',
    });
    assert.equal(registered.response.status, 201);
    assert.equal(registered.payload.data.authenticated, true);
    assert.equal(registered.payload.data.account.username, 'http_player');
    assert.equal(registered.payload.data.account.email, 'http.player@example.com');
    assert.match(registered.response.headers.get('set-cookie'), /HttpOnly/iu);
    assert.match(registered.response.headers.get('set-cookie'), /SameSite=Strict/iu);
    assert.ok(registered.cookie.startsWith('qyj_session='));

    const me = await requestJson(runtime.baseUrl, '/api/auth/me', {
      cookie: registered.cookie,
    });
    assert.equal(me.response.status, 200);
    assert.equal(me.payload.data.authenticated, true);
    assert.equal(me.payload.data.profile.playerId, registered.payload.data.profile.playerId);

    const edited = await requestJson(runtime.baseUrl, '/api/player/me', {
      method: 'PATCH',
      cookie: registered.cookie,
      body: { nickname: '资料已改', emblem: PLAYER_EMBLEMS[3] },
    });
    assert.equal(edited.response.status, 200);
    assert.equal(edited.payload.data.profile.nickname, '资料已改');
    assert.equal(edited.payload.data.profile.emblem, PLAYER_EMBLEMS[3]);

    const loggedOut = await requestJson(runtime.baseUrl, '/api/auth/logout', {
      method: 'POST',
      cookie: registered.cookie,
    });
    assert.equal(loggedOut.response.status, 200);
    assert.match(loggedOut.response.headers.get('set-cookie'), /Max-Age=0/iu);
    const afterLogout = await requestJson(runtime.baseUrl, '/api/auth/me', {
      cookie: registered.cookie,
    });
    assert.equal(afterLogout.payload.data.authenticated, false);

    const usernameLogin = await requestJson(runtime.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { identifier: 'HTTP_PLAYER', password: PASSWORD },
    });
    assert.equal(usernameLogin.response.status, 200);
    assert.equal(usernameLogin.payload.data.authenticated, true);
    const usernameCookie = usernameLogin.cookie;

    const emailLogin = await requestJson(runtime.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { identifier: 'HTTP.PLAYER@EXAMPLE.COM', password: PASSWORD },
    });
    assert.equal(emailLogin.response.status, 200);
    assert.equal(emailLogin.payload.data.account.username, 'http_player');

    const resetRequested = await requestJson(
      runtime.baseUrl,
      '/api/auth/password-reset/request',
      { method: 'POST', body: { email: 'http.player@example.com' } },
    );
    assert.equal(resetRequested.response.status, 202);
    assert.equal(resetRequested.payload.data.accepted, true);
    assert.equal(runtime.outbox.length, 1);
    assert.equal(runtime.outbox[0].to, 'http.player@example.com');
    assert.match(runtime.outbox[0].token, /^[A-Za-z0-9_-]{32,128}$/u);

    const unknownReset = await requestJson(
      runtime.baseUrl,
      '/api/auth/password-reset/request',
      { method: 'POST', body: { email: 'unknown.player@example.com' } },
    );
    assert.equal(unknownReset.response.status, 202);
    assert.deepEqual(unknownReset.payload.data, resetRequested.payload.data);
    assert.equal(runtime.outbox.length, 1);

    const resetConfirmed = await requestJson(
      runtime.baseUrl,
      '/api/auth/password-reset/confirm',
      {
        method: 'POST',
        body: { token: runtime.outbox[0].token, newPassword: NEW_PASSWORD },
      },
    );
    assert.equal(resetConfirmed.response.status, 200);
    assert.equal(resetConfirmed.payload.data.reset, true);

    for (const staleCookie of [usernameCookie, emailLogin.cookie]) {
      const staleMe = await requestJson(runtime.baseUrl, '/api/auth/me', {
        cookie: staleCookie,
      });
      assert.equal(staleMe.payload.data.authenticated, false);
    }

    const oldPassword = await requestJson(runtime.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { identifier: 'http_player', password: PASSWORD },
    });
    assert.equal(oldPassword.response.status, 401);
    assert.equal(oldPassword.payload.error.code, 'INVALID_CREDENTIALS');

    const newPassword = await requestJson(runtime.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { identifier: 'http.player@example.com', password: NEW_PASSWORD },
    });
    assert.equal(newPassword.response.status, 200);
    assert.equal(newPassword.payload.data.authenticated, true);
  } finally {
    await runtime.server.close();
  }
});

test('HTTP hand history requires login, ignores forged player scope and filters hidden opponent cards', async () => {
  const runtime = await openServer();
  try {
    const first = await registerOverHttp(runtime.baseUrl, {
      username: 'history_first', email: 'history.first@example.com',
    });
    const second = await registerOverHttp(runtime.baseUrl, {
      username: 'history_second', email: 'history.second@example.com',
    });
    const firstProfile = first.payload.data.profile;
    const secondProfile = second.payload.data.profile;
    runtime.server.playerStore.recordHandHistory({
      matchId: 'auth-history-match-1',
      round: 1,
      roomId: 5201,
      roomName: '朱雀坛·隐私测试',
      tableSize: 6,
      dealerSeat: 1,
      resolution: 'showdown',
      board: [{ r: 2, s: 1 }, { r: 6, s: 2 }, { r: 9, s: 3 }, { r: 11, s: 4 }, { r: 13, s: 1 }],
      players: [
        {
          seat: 1, playerId: firstProfile.playerId, playerName: firstProfile.nickname,
          heroId: 'diaochan', hole: [{ r: 14, s: 1 }, { r: 12, s: 2 }],
          publicHole: [null, null], folded: true, netResult: -20,
        },
        {
          seat: 2, playerId: secondProfile.playerId, playerName: secondProfile.nickname,
          heroId: 'zhugeliang', hole: [{ r: 14, s: 2 }, { r: 14, s: 3 }],
          publicHole: [{ r: 14, s: 2 }, { r: 14, s: 3 }], folded: false,
          netResult: 20, wonAmount: 40, handName: '三才归一',
        },
      ],
    });

    const anonymous = await requestJson(runtime.baseUrl, '/api/player/me/hands');
    assert.equal(anonymous.response.status, 401);
    assert.equal(anonymous.payload.error.code, 'AUTH_REQUIRED');

    const firstView = await requestJson(
      runtime.baseUrl,
      `/api/player/me/hands?limit=20&playerId=${encodeURIComponent(secondProfile.playerId)}`,
      { cookie: first.cookie },
    );
    assert.equal(firstView.response.status, 200);
    assert.equal(firstView.payload.data.items.length, 1);
    assert.equal(firstView.payload.data.items[0].players.find((row) => row.isYou).seat, 1,
      '查询范围必须来自 Cookie，而不是客户端伪造的 playerId');
    assert.equal(firstView.payload.data.items[0].players[1].visibleCardCount, 2);

    const secondView = await requestJson(runtime.baseUrl, '/api/player/me/hands', {
      cookie: second.cookie,
    });
    assert.deepEqual(secondView.payload.data.items[0].players[0].hole, [null, null],
      '弃牌对手的原始底牌不能进入其他账号响应');
    assert.equal(JSON.stringify(secondView.payload).includes('"r":14,"s":1'), false);
  } finally {
    await runtime.server.close();
  }
});

test('WebSocket rejects unauthenticated room commands and accepts a valid login cookie', async () => {
  const runtime = await openServer();
  const sockets = [];
  try {
    const anonymous = await connectWebSocket(runtime.port);
    sockets.push(anonymous.ws);
    assert.equal(anonymous.session.a.authenticated, false);
    assert.equal(anonymous.session.a.resumeToken, null);

    anonymous.ws.send(JSON.stringify({ cmd: 'create' }));
    const createError = await anonymous.inbox.waitFor(
      (message) => message.ev === 'error' && message.a.code === ERROR_CODES.AUTH_REQUIRED,
      'anonymous create rejection',
    );
    assert.equal(createError.a.code, ERROR_CODES.AUTH_REQUIRED);

    anonymous.ws.send(JSON.stringify({ cmd: 'join', teamId: 1 }));
    const joinError = await anonymous.inbox.waitFor(
      (message) => message.ev === 'error' && message.a.code === ERROR_CODES.AUTH_REQUIRED,
      'anonymous join rejection',
    );
    assert.equal(joinError.a.code, ERROR_CODES.AUTH_REQUIRED);

    const registration = await registerOverHttp(runtime.baseUrl, {
      username: 'ws_player',
      email: 'ws.player@example.com',
    });
    assert.equal(registration.response.status, 201);

    const authenticated = await connectWebSocket(runtime.port, registration.cookie);
    sockets.push(authenticated.ws);
    assert.equal(authenticated.session.a.authenticated, true);
    assert.ok(authenticated.session.a.resumeToken);
    assert.equal(authenticated.session.a.account.username, 'ws_player');
    assert.equal(authenticated.session.a.profile.nickname, '联机侠客');

    const lobby = await authenticated.inbox.waitFor(
      (message) => message.ev === 'lobby',
      'authenticated lobby',
    );
    assert.deepEqual(lobby.a.teams, []);
    assert.equal(lobby.a.player.playerId, registration.payload.data.profile.playerId);

    authenticated.ws.send(JSON.stringify({ cmd: 'create', tableSize: 6 }));
    const room = await authenticated.inbox.waitFor(
      (message) => message.ev === 'team' && message.a.members?.length === 1,
      'authenticated room creation',
    );
    assert.equal(room.a.members[0].isYou, true);
    assert.equal(room.a.members[0].playerId, registration.payload.data.profile.playerId);
  } finally {
    await Promise.all(sockets.map((socket) => closeSocket(socket).catch(() => {})));
    await runtime.server.close();
  }
});
