import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';

import { startServer } from '../server.mjs';
import { ERROR_CODES, PROTOCOL_VERSION } from '../protocol.mjs';
import { detachRoomMember } from '../room.mjs';
import { registerTestAccount, withAuthCookie } from './auth-test-helpers.mjs';

const timeout = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms);
  Promise.resolve(promise).then(
    (value) => { clearTimeout(timer); resolve(value); },
    (err) => { clearTimeout(timer); reject(err); },
  );
});

async function openServer(options = {}) {
  const server = startServer(0, { databasePath: ':memory:', ...options });
  await timeout(server.ready, 2_000, '服务监听');
  return { server, port: server.wss.address().port };
}

async function openClient(server, port, options = {}, authenticated = true) {
  const account = authenticated ? await registerTestAccount(server) : null;
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}`,
    account ? withAuthCookie(account.cookie, options) : options,
  );
  await timeout(once(ws, 'open'), 2_000, '客户端连接');
  return ws;
}

function waitForMessage(ws, predicate, label) {
  return timeout(new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!predicate(msg)) return;
      cleanup();
      resolve(msg);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`等待 ${label} 时连接关闭`));
    };
    const cleanup = () => {
      ws.off('message', onMessage);
      ws.off('close', onClose);
    };
    ws.on('message', onMessage);
    ws.once('close', onClose);
  }), 2_000, label);
}

async function expectError(ws, payload, code, sendOptions) {
  const response = waitForMessage(ws, (msg) => msg.ev === 'error', code);
  ws.send(payload, sendOptions);
  const msg = await response;
  assert.equal(msg.a.code, code);
  assert.equal(typeof msg.a.message, 'string');
}

test('协议拒绝异常输入并保持旧 JSON envelope 可用', async () => {
  const { server, port } = await openServer({ heartbeatMs: 20, shutdownGraceMs: 100 });
  const ws = await openClient(server, port);

  await expectError(ws, '{bad json', ERROR_CODES.INVALID_JSON);
  await expectError(ws, JSON.stringify({ cmd: 'not-supported' }), ERROR_CODES.UNKNOWN_COMMAND);
  await expectError(ws, JSON.stringify({ cmd: 'join', teamId: '1' }), ERROR_CODES.INVALID_FIELD);
  await expectError(ws, JSON.stringify({ cmd: 'create', tableSize: 7 }),
    ERROR_CODES.UNSUPPORTED_TABLE_SIZE);
  await expectError(ws, JSON.stringify({ cmd: 'lobby', capabilities: 'table-size-9' }),
    ERROR_CODES.INVALID_FIELD);
  await expectError(ws, JSON.stringify({ cmd: 'chat', text: '' }), ERROR_CODES.INVALID_FIELD);
  await expectError(ws, JSON.stringify({ cmd: 'chat', text: '聊'.repeat(81) }),
    ERROR_CODES.INVALID_FIELD);
  await expectError(ws, Buffer.from(JSON.stringify({ cmd: 'lobby' })),
    ERROR_CODES.UNSUPPORTED_DATA, { binary: true });

  const lobby = waitForMessage(ws, (msg) => msg.ev === 'lobby', '合法大厅响应');
  ws.send(JSON.stringify({ cmd: 'lobby' }));
  assert.equal((await lobby).ev, 'lobby');

  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(ws.readyState, WebSocket.OPEN, '正常客户端应通过 ping/pong 保持连接');

  const closed = once(ws, 'close');
  await server.close();
  const [code, reason] = await timeout(closed, 1_000, '优雅关闭');
  assert.equal(code, 1001);
  assert.equal(reason.toString(), 'SERVER_SHUTDOWN');
});

test('旧客户端看不到且不能加入 9 人桌，但无 tableSize 的 create 仍创建 6 人桌', async () => {
  const { server, port } = await openServer({ heartbeatMs: 0 });
  const modern = await openClient(server, port);
  const legacy = await openClient(server, port);
  try {
    const created = waitForMessage(modern, (msg) => msg.ev === 'team', '创建 9 人桌');
    modern.send(JSON.stringify({
      cmd: 'create',
      tableSize: 9,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: ['table-size-9'],
    }));
    const nineSeatRoom = await created;
    assert.equal(nineSeatRoom.a.tableSize, 9);
    assert.equal(nineSeatRoom.a.maxMembers, 9);

    const lobby = waitForMessage(legacy, (msg) => msg.ev === 'lobby', '旧客户端大厅');
    legacy.send(JSON.stringify({ cmd: 'lobby' }));
    const legacyLobby = await lobby;
    assert.equal(
      legacyLobby.a.teams.some((team) => team.id === nineSeatRoom.a.id),
      false,
    );
    await expectError(
      legacy,
      JSON.stringify({ cmd: 'join', teamId: nineSeatRoom.a.id }),
      ERROR_CODES.CLIENT_UPGRADE_REQUIRED,
    );

    const legacyCreated = waitForMessage(
      legacy,
      (msg) => msg.ev === 'team' && msg.a.isOwner,
      '旧客户端默认 6 人桌',
    );
    legacy.send(JSON.stringify({ cmd: 'create' }));
    const sixSeatRoom = await legacyCreated;
    assert.equal(sixSeatRoom.a.tableSize, 6);
    assert.equal(sixSeatRoom.a.maxMembers, 6);
    assert.equal(sixSeatRoom.a.totalPlayers, 6);
  } finally {
    await server.close();
  }
});

test('房间与选将聊天实时广播，选将状态公开且确认英雄后服务端锁定', async () => {
  const { server, port } = await openServer({ heartbeatMs: 0 });
  const owner = await openClient(server, port);
  const member = await openClient(server, port);
  try {
    const created = waitForMessage(owner, (msg) => msg.ev === 'team', '创建聊天房间');
    owner.send(JSON.stringify({ cmd: 'create' }));
    const room = await created;
    const joined = waitForMessage(member, (msg) => msg.ev === 'team', '加入聊天房间');
    member.send(JSON.stringify({ cmd: 'join', teamId: room.a.id }));
    const joinedRoom = await joined;
    assert.equal(joinedRoom.a.members.length, 2);
    assert.ok(joinedRoom.a.members.every((row) => row.avatarId >= 1 && row.avatarId <= 20));

    const ownerChat = waitForMessage(owner, (msg) => msg.ev === 'chat', '房主收到聊天');
    const memberChat = waitForMessage(member, (msg) => msg.ev === 'chat', '成员收到聊天');
    member.send(JSON.stringify({ cmd: 'chat', text: '  同桌好  ' }));
    const [first, second] = await Promise.all([ownerChat, memberChat]);
    assert.equal(first.a.text, '同桌好');
    assert.equal(first.a.id, second.a.id);
    assert.ok(first.a.avatarId >= 1 && first.a.avatarId <= 20);

    const refreshed = waitForMessage(owner, (msg) => msg.ev === 'team', '聊天历史随房间状态返回');
    owner.send(JSON.stringify({ cmd: 'rename', name: '聊天雅间' }));
    const state = await refreshed;
    assert.equal(state.a.chatMessages.at(-1).id, first.a.id);
    assert.equal(state.a.chatMessages.at(-1).text, '同桌好');

    const ownerDraft = waitForMessage(owner, (msg) => msg.ev === 'pick', '进入选将');
    const memberDraft = waitForMessage(member, (msg) => msg.ev === 'pick', '队员进入选将');
    owner.send(JSON.stringify({ cmd: 'startPick' }));
    const [ownerPick, memberPick] = await Promise.all([ownerDraft, memberDraft]);
    assert.equal(ownerPick.a.members.length, 2);
    assert.equal(ownerPick.a.members.every((row) => row.ready === false && row.heroId === null), true);
    assert.equal(ownerPick.a.chatMessages.at(-1).text, '同桌好');
    assert.equal(memberPick.a.members.some((row) => row.isYou), true);

    const pickChatOwner = waitForMessage(owner, (msg) => msg.ev === 'chat', '选将聊天房主接收');
    const pickChatMember = waitForMessage(member, (msg) => msg.ev === 'chat', '选将聊天队员接收');
    member.send(JSON.stringify({ cmd: 'chat', text: '我选貂蝉' }));
    await Promise.all([pickChatOwner, pickChatMember]);

    const ownerLocked = waitForMessage(
      owner,
      (msg) => msg.ev === 'pick' && msg.a.members.some((row) => row.isYou && row.heroId === 'zhugeliang'),
      '房主锁定诸葛亮',
    );
    owner.send(JSON.stringify({ cmd: 'pick', heroId: 'zhugeliang' }));
    const lockedState = await ownerLocked;
    assert.equal(lockedState.a.members.find((row) => row.isYou).ready, true);
    assert.equal(lockedState.a.chatMessages.at(-1).text, '我选貂蝉');

    await expectError(
      owner,
      JSON.stringify({ cmd: 'pick', heroId: 'hanxin' }),
      ERROR_CODES.HERO_ALREADY_LOCKED,
    );

    const allPicked = waitForMessage(owner, (msg) => msg.ev === 'pick' && msg.a.allPicked, '全员锁定');
    member.send(JSON.stringify({ cmd: 'pick', heroId: 'diaochan' }));
    const readyState = await allPicked;
    assert.deepEqual(
      readyState.a.members.map((row) => row.heroId).sort(),
      ['diaochan', 'zhugeliang'],
    );
  } finally {
    await server.close();
  }
});

test('9 人桌真人容量为 9，第 10 名真人被拒绝', async () => {
  const { server, port } = await openServer({ heartbeatMs: 0 });
  const sockets = [];
  const metadata = { protocolVersion: PROTOCOL_VERSION, capabilities: ['table-size-9'] };
  try {
    const owner = await openClient(server, port); sockets.push(owner);
    const created = waitForMessage(owner, (msg) => msg.ev === 'team', '房主创建 9 人桌');
    owner.send(JSON.stringify({ cmd: 'create', tableSize: 9, ...metadata }));
    const room = await created;

    let latest = room;
    for (let index = 0; index < 8; index++) {
      const member = await openClient(server, port); sockets.push(member);
      const joined = waitForMessage(
        member,
        (msg) => msg.ev === 'team' && msg.a.members.length === index + 2,
        `第 ${index + 2} 名真人加入`,
      );
      member.send(JSON.stringify({ cmd: 'join', teamId: room.a.id, ...metadata }));
      latest = await joined;
    }
    assert.equal(latest.a.members.length, 9);
    assert.equal(latest.a.maxMembers, 9);

    const overflow = await openClient(server, port); sockets.push(overflow);
    await expectError(
      overflow,
      JSON.stringify({ cmd: 'join', teamId: room.a.id, ...metadata }),
      ERROR_CODES.ROOM_FULL,
    );
  } finally {
    await server.close();
  }
});

test('6 人桌真人容量为 6，第 7 名真人被拒绝', async () => {
  const { server, port } = await openServer({ heartbeatMs: 0 });
  const sockets = [];
  const metadata = { protocolVersion: PROTOCOL_VERSION, capabilities: ['table-size-9'] };
  try {
    const owner = await openClient(server, port); sockets.push(owner);
    const created = waitForMessage(owner, (msg) => msg.ev === 'team', '房主创建 6 人桌');
    owner.send(JSON.stringify({ cmd: 'create', tableSize: 6, ...metadata }));
    const room = await created;

    let latest = room;
    for (let index = 0; index < 5; index++) {
      const member = await openClient(server, port); sockets.push(member);
      const joined = waitForMessage(
        member,
        (msg) => msg.ev === 'team' && msg.a.members.length === index + 2,
        `第 ${index + 2} 名真人加入 6 人桌`,
      );
      member.send(JSON.stringify({ cmd: 'join', teamId: room.a.id, ...metadata }));
      latest = await joined;
    }
    assert.equal(latest.a.members.length, 6);
    assert.equal(latest.a.maxMembers, 6);

    const overflow = await openClient(server, port); sockets.push(overflow);
    await expectError(
      overflow,
      JSON.stringify({ cmd: 'join', teamId: room.a.id, ...metadata }),
      ERROR_CODES.ROOM_FULL,
    );
  } finally {
    await server.close();
  }
});

test('同一登录账号重复加入同一房间时接管原席位而不重复占座', async () => {
  const { server, port } = await openServer({ heartbeatMs: 0 });
  const sockets = [];
  try {
    const account = await registerTestAccount(server, { nickname: '阳顶天' });
    const owner = new WebSocket(
      `ws://127.0.0.1:${port}`,
      withAuthCookie(account.cookie),
    );
    sockets.push(owner);
    await timeout(once(owner, 'open'), 2_000, '房主连接');

    const created = waitForMessage(owner, (msg) => msg.ev === 'team', '创建房间');
    owner.send(JSON.stringify({ cmd: 'create', tableSize: 6 }));
    const room = await created;
    assert.equal(room.a.members.length, 1);

    const duplicate = new WebSocket(
      `ws://127.0.0.1:${port}`,
      withAuthCookie(account.cookie),
    );
    sockets.push(duplicate);
    await timeout(once(duplicate, 'open'), 2_000, '同账号新连接');

    const replaced = waitForMessage(
      owner,
      (msg) => msg.ev === 'error' && msg.a.code === ERROR_CODES.ROOM_SEAT_REPLACED,
      '原连接收到席位接管通知',
    );
    const joined = waitForMessage(
      duplicate,
      (msg) => msg.ev === 'team' && msg.a.id === room.a.id,
      '新连接接管席位',
    );
    duplicate.send(JSON.stringify({ cmd: 'join', teamId: room.a.id }));
    await replaced;
    const reclaimedRoom = await joined;

    assert.equal(reclaimedRoom.a.members.length, 1);
    assert.equal(reclaimedRoom.a.members[0].playerId, account.profile.playerId);
    assert.equal(reclaimedRoom.a.members[0].name, '阳顶天');
    assert.equal(reclaimedRoom.a.members[0].isOwner, true);
    assert.equal(reclaimedRoom.a.members[0].isYou, true);

    const other = await openClient(server, port);
    sockets.push(other);
    const otherJoined = waitForMessage(
      other,
      (msg) => msg.ev === 'team' && msg.a.id === room.a.id && msg.a.members.length === 2,
      '其他账号加入房间',
    );
    other.send(JSON.stringify({ cmd: 'join', teamId: room.a.id }));
    const twoPlayerRoom = await otherJoined;
    assert.equal(new Set(twoPlayerRoom.a.members.map((member) => member.playerId)).size, 2);
  } finally {
    for (const socket of sockets) socket.close();
    await server.close();
  }
});

test('超过消息上限时使用标准 1009 关闭码', async () => {
  const { server, port } = await openServer({ maxPayload: 128, heartbeatMs: 0 });
  const ws = await openClient(server, port, {}, false);
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ cmd: 'rename', name: 'x'.repeat(512) }));
  const [code] = await timeout(closed, 2_000, '超大消息关闭');
  assert.equal(code, 1009);
  await server.close();
});

test('心跳会清理不响应 pong 的连接', async () => {
  const { server, port } = await openServer({ heartbeatMs: 20, shutdownGraceMs: 50 });
  const ws = await openClient(server, port, { autoPong: false }, false);
  const [code] = await timeout(once(ws, 'close'), 1_000, '心跳清理');
  assert.equal(code, 1006);
  await server.close();
});

test('房主离线时成员边界清退占位并转移房主', () => {
  const team = {
    ownerId: 1,
    members: [1, 2],
    picks: { 1: 'xiangyu', 2: 'diaochan' },
  };
  const result = detachRoomMember(team, 1);
  assert.deepEqual(result, { removed: true, ownerChanged: true, empty: false });
  assert.deepEqual(team.members, [2]);
  assert.equal(team.ownerId, 2);
  assert.equal(team.picks[1], undefined);
});
