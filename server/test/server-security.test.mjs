import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';

import { startServer } from '../server.mjs';
import { ERROR_CODES } from '../protocol.mjs';
import { detachRoomMember } from '../room.mjs';

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

async function openClient(port, options = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, options);
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
  const ws = await openClient(port);

  await expectError(ws, '{bad json', ERROR_CODES.INVALID_JSON);
  await expectError(ws, JSON.stringify({ cmd: 'not-supported' }), ERROR_CODES.UNKNOWN_COMMAND);
  await expectError(ws, JSON.stringify({ cmd: 'join', teamId: '1' }), ERROR_CODES.INVALID_FIELD);
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

test('超过消息上限时使用标准 1009 关闭码', async () => {
  const { server, port } = await openServer({ maxPayload: 128, heartbeatMs: 0 });
  const ws = await openClient(port);
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ cmd: 'rename', name: 'x'.repeat(512) }));
  const [code] = await timeout(closed, 2_000, '超大消息关闭');
  assert.equal(code, 1009);
  await server.close();
});

test('心跳会清理不响应 pong 的连接', async () => {
  const { server, port } = await openServer({ heartbeatMs: 20, shutdownGraceMs: 50 });
  const ws = await openClient(port, { autoPong: false });
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
