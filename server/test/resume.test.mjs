import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';

import { startServer } from '../server.mjs';
import { ERROR_CODES } from '../protocol.mjs';

const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms);
  Promise.resolve(promise).then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); },
  );
});

async function openServer(options = {}) {
  const server = startServer(0, {
    heartbeatMs: 0,
    databasePath: ':memory:',
    ...options,
  });
  await withTimeout(server.ready, 2_000, '服务监听');
  return { server, port: server.wss.address().port };
}

async function connect(port, { resumeToken, silent = false } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox = [];
  const history = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    inbox.push(msg);
    history.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      const found = inbox.find(waiter.predicate);
      if (!found) continue;
      waiters.splice(i, 1);
      clearTimeout(waiter.timer);
      inbox.splice(0, inbox.indexOf(found) + 1);
      waiter.resolve(found);
    }
  });
  const client = {
    ws,
    inbox,
    history,
    send(value) { ws.send(JSON.stringify(value)); },
    waitFor(predicate, label, timeoutMs = 3_000) {
      const found = inbox.find(predicate);
      if (found) {
        inbox.splice(0, inbox.indexOf(found) + 1);
        return Promise.resolve(found);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} 超时`)), timeoutMs);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
  };
  await withTimeout(once(ws, 'open'), 2_000, '连接');
  if (resumeToken) client.send({ cmd: 'resume', resumeToken });
  else if (!silent) client.send({ cmd: 'lobby' });
  client.session = await client.waitFor((msg) => msg.ev === 'session', 'session');
  return client;
}

async function closeSocket(ws) {
  if (ws.readyState >= WebSocket.CLOSING) return;
  const closed = once(ws, 'close');
  ws.close();
  await withTimeout(closed, 1_000, '连接关闭');
}

test('无首条消息的旧客户端在握手期后获得 session 与 lobby', async () => {
  const { server, port } = await openServer();
  const startedAt = Date.now();
  const client = await connect(port, { silent: true });
  try {
    await client.waitFor((msg) => msg.ev === 'lobby', '旧客户端大厅');
    assert.equal(client.history[0].ev, 'session');
    assert.equal(client.history[1].ev, 'lobby');
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    await closeSocket(client.ws).catch(() => {});
    await server.close();
  }
});

test('对局中恢复原座位与暗牌并轮换 resumeToken', async () => {
  const { server, port } = await openServer({ speed: 10, resumeGraceMs: 2_000 });
  const sockets = [];
  try {
    const a = await connect(port); sockets.push(a.ws);
    const b = await connect(port); sockets.push(b.ws);
    const originalToken = a.session.a.resumeToken;
    assert.equal(a.session.a.resumed, false);
    assert.equal(a.session.a.resumeGraceMs, 2_000);

    a.send({ cmd: 'create' });
    const room = await a.waitFor((msg) => msg.ev === 'team' && msg.a.members.length === 1, '创建房间');
    b.send({ cmd: 'join', teamId: room.a.id });
    await b.waitFor((msg) => msg.ev === 'team' && msg.a.members.length === 2, '加入房间');
    a.send({ cmd: 'startPick' });
    await a.waitFor((msg) => msg.ev === 'pick', '进入选将');
    a.send({ cmd: 'pick', heroId: 'xiangyu' });
    b.send({ cmd: 'pick', heroId: 'diaochan' });
    await a.waitFor((msg) => msg.ev === 'pick' && msg.a.allPicked, '完成选将');
    a.send({ cmd: 'startGame' });
    const firstStart = await a.waitFor((msg) => msg.ev === 'gameStart', '首次 gameStart');
    const firstHole = await a.waitFor((msg) => msg.ev === 'hole', '首次暗牌');
    const originalSeat = firstStart.a.mySeat;

    a.inbox.length = 0;
    b.inbox.length = 0;
    await closeSocket(a.ws);
    const offlineTeam = await b.waitFor((msg) => msg.ev === 'team'
      && msg.a.members.some((member) => !member.isYou && member.connection === 'offline'), '离线成员状态');
    assert.equal(offlineTeam.a.members.filter((member) => !member.connected).length, 1);
    assert.equal(offlineTeam.a.members.find((member) => !member.isYou).isOwner, true,
      '房主在宽限期内必须保留身份');

    const resumed = await connect(port, { resumeToken: originalToken }); sockets.push(resumed.ws);
    assert.equal(resumed.session.a.resumed, true);
    assert.notEqual(resumed.session.a.resumeToken, originalToken, '恢复后必须轮换 token');
    const resumedStart = await resumed.waitFor((msg) => msg.ev === 'gameStart', '恢复 gameStart');
    const resumedSync = await resumed.waitFor((msg) => msg.ev === 'sync' && msg.s, '恢复快照');
    const resumedHole = await resumed.waitFor((msg) => msg.ev === 'hole', '恢复暗牌');
    assert.equal(resumedStart.a.mySeat, originalSeat);
    assert.deepEqual(resumedHole.a.hole, firstHole.a.hole);
    assert.ok(Number.isInteger(resumedSync.s.actingIdx)
      && resumedSync.s.actingIdx >= 0 && resumedSync.s.actingIdx <= 6,
    '恢复快照应携带权威的当前行动者索引');
    assert.ok(Object.hasOwn(resumedSync.s, 'actionClock'),
      '恢复快照必须显式携带公开行动时钟或 null，避免客户端残留旧倒计时');
    if (resumedSync.s.actingIdx > 0) {
      assert.equal(resumedSync.s.actionClock?.idx, resumedSync.s.actingIdx,
        '存在当前行动者时，恢复的公开时钟必须属于同一座位');
      assert.ok(resumedSync.s.actionClock.remainingMs >= 0
        && resumedSync.s.actionClock.totalMs >= 30000,
      '恢复的公开时钟必须携带有效剩余时间与总时长');
    }
    assert.ok(resumedSync.s.players.every((player) => typeof player.acted === 'boolean'
      && Object.hasOwn(player, 'lastAction')),
    '恢复快照应携带每名玩家的 acted/lastAction 状态');
    const order = resumed.history.map((msg) => msg.ev);
    assert.ok(order.indexOf('session') < order.indexOf('gameStart'));
    assert.ok(order.indexOf('gameStart') < order.indexOf('sync'));
    assert.ok(order.indexOf('sync') < order.indexOf('hole'));

    const onlineTeam = await b.waitFor((msg) => msg.ev === 'team'
      && msg.a.members.every((member) => member.connected), '恢复在线状态');
    assert.equal(onlineTeam.a.members.length, 2);

    const staleToken = await connect(port, { resumeToken: originalToken }); sockets.push(staleToken.ws);
    assert.equal(staleToken.session.a.resumed, false, '旧 token 不得再次恢复原会话');
  } finally {
    await Promise.all(sockets.map((ws) => closeSocket(ws).catch(() => {})));
    await server.close();
  }
});

test('新连接替换旧 socket 时旧 close 不会把会话再次标离线', async () => {
  const { server, port } = await openServer({ resumeGraceMs: 2_000 });
  const sockets = [];
  try {
    const original = await connect(port); sockets.push(original.ws);
    const oldClosed = once(original.ws, 'close');
    const replacement = await connect(port, { resumeToken: original.session.a.resumeToken });
    sockets.push(replacement.ws);
    assert.equal(replacement.session.a.resumed, true);
    const [closeCode] = await withTimeout(oldClosed, 1_000, '旧连接替换关闭');
    assert.equal(closeCode, 4000);

    replacement.send({ cmd: 'create' });
    const team = await replacement.waitFor((msg) => msg.ev === 'team', '替换后创建房间');
    assert.equal(team.a.members.length, 1);
    assert.equal(team.a.members[0].connected, true);
  } finally {
    await Promise.all(sockets.map((ws) => closeSocket(ws).catch(() => {})));
    await server.close();
  }
});

test('离线成员阻止开局并在宽限期后清退', async () => {
  const { server, port } = await openServer({ resumeGraceMs: 80 });
  const sockets = [];
  try {
    const owner = await connect(port); sockets.push(owner.ws);
    const member = await connect(port); sockets.push(member.ws);
    const expiredToken = member.session.a.resumeToken;
    owner.send({ cmd: 'create' });
    const room = await owner.waitFor((msg) => msg.ev === 'team' && msg.a.members.length === 1, '创建房间');
    member.send({ cmd: 'join', teamId: room.a.id });
    await owner.waitFor((msg) => msg.ev === 'team' && msg.a.members.length === 2, '成员加入');

    owner.inbox.length = 0;
    await closeSocket(member.ws);
    await owner.waitFor((msg) => msg.ev === 'team'
      && msg.a.members.some((item) => item.connection === 'offline'), '成员离线');
    owner.send({ cmd: 'startPick' });
    const blocked = await owner.waitFor((msg) => msg.ev === 'error', '离线开局阻断');
    assert.equal(blocked.a.code, ERROR_CODES.ROOM_MEMBER_OFFLINE);

    const cleaned = await owner.waitFor((msg) => msg.ev === 'team' && msg.a.members.length === 1, '过期清退');
    assert.equal(cleaned.a.members[0].isYou, true);
    assert.equal(cleaned.a.members[0].connected, true);
    owner.send({ cmd: 'startPick' });
    await owner.waitFor((msg) => msg.ev === 'pick', '清退后选将');

    const expired = await connect(port, { resumeToken: expiredToken }); sockets.push(expired.ws);
    assert.equal(expired.session.a.resumed, false, '过期 token 不得恢复');
  } finally {
    await Promise.all(sockets.map((ws) => closeSocket(ws).catch(() => {})));
    await server.close();
  }
});

test('选将阶段离线成员阻止开战，过期后可继续', async () => {
  const { server, port } = await openServer({ resumeGraceMs: 80 });
  const sockets = [];
  try {
    const owner = await connect(port); sockets.push(owner.ws);
    const member = await connect(port); sockets.push(member.ws);
    owner.send({ cmd: 'create' });
    const room = await owner.waitFor((msg) => msg.ev === 'team' && msg.a.members.length === 1, '创建房间');
    member.send({ cmd: 'join', teamId: room.a.id });
    await owner.waitFor((msg) => msg.ev === 'team' && msg.a.members.length === 2, '成员加入');
    owner.send({ cmd: 'startPick' });
    await owner.waitFor((msg) => msg.ev === 'pick', '进入选将');
    owner.send({ cmd: 'pick', heroId: 'xiangyu' });
    member.send({ cmd: 'pick', heroId: 'diaochan' });
    await owner.waitFor((msg) => msg.ev === 'pick' && msg.a.allPicked, '全员选定');

    owner.inbox.length = 0;
    await closeSocket(member.ws);
    await owner.waitFor((msg) => msg.ev === 'team'
      && msg.a.members.some((item) => !item.connected), '选将成员离线');
    owner.send({ cmd: 'startGame' });
    const blocked = await owner.waitFor((msg) => msg.ev === 'error', '离线开战阻断');
    assert.equal(blocked.a.code, ERROR_CODES.ROOM_MEMBER_OFFLINE);

    await owner.waitFor((msg) => msg.ev === 'team' && msg.a.members.length === 1, '选将过期清退');
    owner.send({ cmd: 'startGame' });
    const started = await owner.waitFor((msg) => msg.ev === 'gameStart', '清退后开战');
    assert.equal(started.a.players.filter((item) => item.isHuman).length, 1);
  } finally {
    await Promise.all(sockets.map((ws) => closeSocket(ws).catch(() => {})));
    await server.close();
  }
});

test('结算后未回房的会话恢复为 resumeResult', async () => {
  const { server, port } = await openServer({ speed: 100, resumeGraceMs: 2_000 });
  const sockets = [];
  try {
    const player = await connect(port); sockets.push(player.ws);
    const token = player.session.a.resumeToken;
    player.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.ev !== 'onAwaitAction') return;
      player.send({ cmd: 'act', type: msg.a.opts.canCheck ? 'check' : 'call' });
    });
    player.send({ cmd: 'create' });
    await player.waitFor((msg) => msg.ev === 'team', '创建单人房');
    player.send({ cmd: 'startPick' });
    await player.waitFor((msg) => msg.ev === 'pick', '单人选将');
    player.send({ cmd: 'pick', heroId: 'xiangyu' });
    await player.waitFor((msg) => msg.ev === 'pick' && msg.a.allPicked, '锁定英雄');
    player.send({ cmd: 'startGame' });
    const started = await player.waitFor((msg) => msg.ev === 'gameStart', '单人开局');
    const over = await player.waitFor((msg) => msg.ev === 'onGameOver', '对局结算', 30_000);
    await closeSocket(player.ws);

    const resumed = await connect(port, { resumeToken: token }); sockets.push(resumed.ws);
    assert.equal(resumed.session.a.resumed, true);
    const result = await resumed.waitFor((msg) => msg.ev === 'resumeResult', '恢复结算');
    assert.equal(result.a.mySeat, started.a.mySeat);
    assert.equal(result.a.ranking.length, 6);
    assert.equal(result.a.ranking.filter((item) => item.isMe).length, 1);
    assert.ok(result.a.ranking.every((item) => Object.hasOwn(item, 'deathRound')));
    assert.deepEqual(result.a.ranking, over.a.ranking);
    assert.equal(resumed.history[0].ev, 'session');
    assert.equal(resumed.history[1].ev, 'resumeResult');
  } finally {
    await Promise.all(sockets.map((ws) => closeSocket(ws).catch(() => {})));
    await server.close();
  }
});

test('server.close 不等待保留中的恢复计时器', async () => {
  const { server, port } = await openServer({ resumeGraceMs: 90_000 });
  const client = await connect(port);
  await closeSocket(client.ws);
  await withTimeout(server.close(), 500, '带保留会话关闭服务');
});
