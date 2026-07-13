export const ONLINE_SCREENS = Object.freeze([
  'connecting', 'auth', 'lobby', 'room', 'pick', 'battle', 'result', 'closed',
]);

export function resolveWebSocketUrl({
  location: locationLike = globalThis.location,
  override = globalThis.QYJ_WS_URL,
} = {}) {
  if (override) return String(override);
  const protocol = locationLike?.protocol === 'https:' ? 'wss' : 'ws';
  const hostname = locationLike?.hostname || '127.0.0.1';
  return `${protocol}://${hostname}:8790`;
}

export function makeCommand(cmd, payload = {}) {
  if (typeof cmd !== 'string' || !cmd) throw new TypeError('command name is required');
  return { cmd, ...(payload || {}) };
}

export function parseServerMessage(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return value && typeof value === 'object' && typeof value.ev === 'string' ? value : null;
  } catch {
    return null;
  }
}
