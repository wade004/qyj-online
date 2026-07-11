// WebSocket wire protocol validation shared by the server transport and tests.
// Existing command/event envelopes stay unchanged: { cmd, ... } and { ev, a, s }.

export const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024;

export const ERROR_CODES = Object.freeze({
  INVALID_JSON: 'INVALID_JSON',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  UNSUPPORTED_DATA: 'UNSUPPORTED_DATA',
  MESSAGE_TOO_LARGE: 'MESSAGE_TOO_LARGE',
  INVALID_COMMAND: 'INVALID_COMMAND',
  UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
  INVALID_FIELD: 'INVALID_FIELD',
  ALREADY_IN_ROOM: 'ALREADY_IN_ROOM',
  ROOM_LIMIT_REACHED: 'ROOM_LIMIT_REACHED',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_NOT_JOINABLE: 'ROOM_NOT_JOINABLE',
  ROOM_FULL: 'ROOM_FULL',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  NOT_ROOM_OWNER: 'NOT_ROOM_OWNER',
  INVALID_ROOM_PHASE: 'INVALID_ROOM_PHASE',
  INVALID_NAME: 'INVALID_NAME',
  HERO_NOT_FOUND: 'HERO_NOT_FOUND',
  HERO_TAKEN: 'HERO_TAKEN',
  PICKS_INCOMPLETE: 'PICKS_INCOMPLETE',
  GAME_NOT_FOUND: 'GAME_NOT_FOUND',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_RAISE_TIER: 'INVALID_RAISE_TIER',
  SKILL_REJECTED: 'SKILL_REJECTED',
  EXTEND_REJECTED: 'EXTEND_REJECTED',
  SERVER_SHUTTING_DOWN: 'SERVER_SHUTTING_DOWN',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  ROOM_MEMBER_OFFLINE: 'ROOM_MEMBER_OFFLINE',
  SESSION_ALREADY_INITIALIZED: 'SESSION_ALREADY_INITIALIZED',
  INVALID_GUEST_ID: 'INVALID_GUEST_ID',
  INVALID_EMBLEM: 'INVALID_EMBLEM',
  INVALID_PROFILE: 'INVALID_PROFILE',
  PLAYER_NOT_IDENTIFIED: 'PLAYER_NOT_IDENTIFIED',
  PLAYER_ALREADY_IDENTIFIED: 'PLAYER_ALREADY_IDENTIFIED',
});

const KNOWN_COMMANDS = new Set([
  'create', 'join', 'leave', 'rename', 'startPick', 'pick', 'startGame',
  'act', 'skill', 'extend', 'backToRoom', 'lobby', 'resume',
  'identify', 'updateProfile',
]);

const ACTION_TYPES = new Set(['fold', 'check', 'call', 'raise', 'allin']);
const PLAYER_EMBLEMS = new Set(['侠', '群', '墨', '月']);
const GUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{11,127}$/u;
const FORBIDDEN_NICKNAME_RE = /[<>\p{Cc}\p{Cs}\u202A-\u202E\u2066-\u2069]/u;

const failure = (code, message) => ({ ok: false, error: { code, message } });

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function payloadLength(data) {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (typeof data?.byteLength === 'number') return data.byteLength;
  if (typeof data?.length === 'number') return data.length;
  return 0;
}

function validateNickname(value) {
  if (typeof value !== 'string') {
    return failure(ERROR_CODES.INVALID_NAME, '昵称必须是字符串');
  }
  const nickname = value.trim().normalize('NFC');
  const length = [...nickname].length;
  if (length < 1 || length > 8 || FORBIDDEN_NICKNAME_RE.test(nickname)) {
    return failure(ERROR_CODES.INVALID_NAME, '昵称需为 1~8 个可用字符');
  }
  return null;
}

function validateEmblem(value) {
  if (typeof value !== 'string' || !PLAYER_EMBLEMS.has(value)) {
    return failure(ERROR_CODES.INVALID_EMBLEM, '纹章不存在');
  }
  return null;
}

function validateFields(msg) {
  switch (msg.cmd) {
    case 'resume':
      if (typeof msg.resumeToken !== 'string'
        || msg.resumeToken.length < 16 || msg.resumeToken.length > 256) {
        return failure(ERROR_CODES.INVALID_FIELD, 'resumeToken 格式无效');
      }
      break;
    case 'identify':
      if (typeof msg.guestId !== 'string' || !GUEST_ID_RE.test(msg.guestId)) {
        return failure(ERROR_CODES.INVALID_GUEST_ID, 'guestId 格式无效');
      }
      if (msg.nickname != null) {
        const invalidNickname = validateNickname(msg.nickname);
        if (invalidNickname) return invalidNickname;
      }
      if (msg.emblem != null) {
        const invalidEmblem = validateEmblem(msg.emblem);
        if (invalidEmblem) return invalidEmblem;
      }
      break;
    case 'updateProfile': {
      const hasNickname = Object.hasOwn(msg, 'nickname') && msg.nickname != null;
      const hasEmblem = Object.hasOwn(msg, 'emblem') && msg.emblem != null;
      if (!hasNickname && !hasEmblem) {
        return failure(ERROR_CODES.INVALID_PROFILE, '至少提供一个资料字段');
      }
      if (hasNickname) {
        const invalidNickname = validateNickname(msg.nickname);
        if (invalidNickname) return invalidNickname;
      }
      if (hasEmblem) {
        const invalidEmblem = validateEmblem(msg.emblem);
        if (invalidEmblem) return invalidEmblem;
      }
      break;
    }
    case 'join':
      if (!Number.isSafeInteger(msg.teamId) || msg.teamId < 1) {
        return failure(ERROR_CODES.INVALID_FIELD, 'teamId 必须是正整数');
      }
      break;
    case 'rename':
      if (typeof msg.name !== 'string') {
        return failure(ERROR_CODES.INVALID_FIELD, 'name 必须是字符串');
      }
      break;
    case 'pick':
      if (typeof msg.heroId !== 'string' || !msg.heroId) {
        return failure(ERROR_CODES.INVALID_FIELD, 'heroId 必须是非空字符串');
      }
      break;
    case 'act':
      if (typeof msg.type !== 'string' || !ACTION_TYPES.has(msg.type)) {
        return failure(ERROR_CODES.INVALID_ACTION, 'type 不是支持的行动');
      }
      if (msg.type === 'raise' && (typeof msg.tierKey !== 'string' || !msg.tierKey)) {
        return failure(ERROR_CODES.INVALID_FIELD, '加注命令必须提供 tierKey');
      }
      break;
    case 'skill': {
      if (msg.selection == null) break;
      if (!isPlainObject(msg.selection)) {
        return failure(ERROR_CODES.INVALID_FIELD, 'selection 必须是对象');
      }
      const { choice, targetIdx } = msg.selection;
      if (choice !== undefined && typeof choice !== 'string' && !Number.isSafeInteger(choice)) {
        return failure(ERROR_CODES.INVALID_FIELD, 'selection.choice 类型无效');
      }
      if (targetIdx !== undefined && !Number.isSafeInteger(targetIdx)) {
        return failure(ERROR_CODES.INVALID_FIELD, 'selection.targetIdx 必须是整数');
      }
      break;
    }
    default:
      break;
  }
  return { ok: true, value: msg };
}

export function decodeClientMessage(data, {
  isBinary = false,
  maxBytes = DEFAULT_MAX_PAYLOAD_BYTES,
} = {}) {
  if (isBinary) {
    return failure(ERROR_CODES.UNSUPPORTED_DATA, '仅支持 UTF-8 JSON 文本消息');
  }
  if (payloadLength(data) > maxBytes) {
    return failure(ERROR_CODES.MESSAGE_TOO_LARGE, `消息不得超过 ${maxBytes} 字节`);
  }

  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return failure(ERROR_CODES.INVALID_JSON, '消息不是有效 JSON');
  }
  if (!isPlainObject(msg)) {
    return failure(ERROR_CODES.INVALID_MESSAGE, '消息必须是 JSON 对象');
  }
  if (typeof msg.cmd !== 'string' || !msg.cmd) {
    return failure(ERROR_CODES.INVALID_COMMAND, 'cmd 必须是非空字符串');
  }
  if (!KNOWN_COMMANDS.has(msg.cmd)) {
    return failure(ERROR_CODES.UNKNOWN_COMMAND, '不支持的命令');
  }
  return validateFields(msg);
}

export function errorEvent(code, message) {
  return { ev: 'error', a: { code, message } };
}
