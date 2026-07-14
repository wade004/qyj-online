import { AUTH_COOKIE_NAME } from '../auth-http.mjs';
import { PLAYER_EMBLEMS } from '../player-store.mjs';

export const TEST_ACCOUNT_PASSWORD = 'Server-Test-Password-2026';

let accountSequence = 0;

function cookieForToken(token) {
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`;
}

export function issueTestSession(server, playerId) {
  const session = server.playerStore.issueAuthSession(playerId);
  return {
    session,
    token: session.token,
    cookie: cookieForToken(session.token),
  };
}

export async function registerTestAccount(server, overrides = {}) {
  const sequence = ++accountSequence;
  const username = overrides.username || `test_user_${sequence}`;
  const email = overrides.email || `test.user.${sequence}@example.com`;
  const password = overrides.password || TEST_ACCOUNT_PASSWORD;
  const registered = await server.playerStore.registerAccount({
    username,
    email,
    password,
    guestId: overrides.guestId || `test-guest-account-${sequence.toString().padStart(6, '0')}`,
    nickname: overrides.nickname || `测试${sequence}`.slice(0, 8),
    emblem: overrides.emblem || PLAYER_EMBLEMS[sequence % PLAYER_EMBLEMS.length],
  });
  return {
    ...registered,
    username,
    email,
    password,
    ...issueTestSession(server, registered.profile.playerId),
  };
}

export async function loginTestAccount(server, {
  login,
  password = TEST_ACCOUNT_PASSWORD,
} = {}) {
  const authenticated = await server.playerStore.loginAccount({ login, password });
  return {
    ...authenticated,
    login,
    password,
    ...issueTestSession(server, authenticated.profile.playerId),
  };
}

export function withAuthCookie(cookie, options = {}) {
  return {
    ...options,
    headers: {
      ...(options.headers || {}),
      cookie,
    },
  };
}
