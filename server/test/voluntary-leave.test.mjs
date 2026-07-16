import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';

import { startServer } from '../server.mjs';
import { PROTOCOL_VERSION } from '../protocol.mjs';
import { registerTestAccount, withAuthCookie } from './auth-test-helpers.mjs';

const timeout = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  Promise.resolve(promise).then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); },
  );
});

async function connect(server, port, cookie) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, withAuthCookie(cookie));
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    inbox.push(message);
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index];
      const found = inbox.find(waiter.predicate);
      if (!found) continue;
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      inbox.splice(0, inbox.indexOf(found) + 1);
      waiter.resolve(found);
    }
  });
  await timeout(once(ws, 'open'), 2_000, 'websocket open');
  const client = {
    ws,
    send(payload) { ws.send(JSON.stringify(payload)); },
    waitFor(predicate, label, timeoutMs = 5_000) {
      const found = inbox.find(predicate);
      if (found) {
        inbox.splice(0, inbox.indexOf(found) + 1);
        return Promise.resolve(found);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
  };
  client.send({ cmd: 'lobby', protocolVersion: PROTOCOL_VERSION, capabilities: ['table-size-9'] });
  await client.waitFor((message) => message.ev === 'session', 'session');
  await client.waitFor((message) => message.ev === 'lobby', 'initial lobby');
  return client;
}

async function close(ws) {
  if (ws.readyState >= WebSocket.CLOSING) return;
  const closed = once(ws, 'close');
  ws.close();
  await timeout(closed, 1_000, 'websocket close');
}

test('voluntary leave enables immediate default actions and allows new rooms plus old-game rejoin', async () => {
  const server = startServer(0, {
    heartbeatMs: 0,
    speed: 1,
    resumeGraceMs: 1_000,
    databasePath: ':memory:',
  });
  await timeout(server.ready, 2_000, 'server ready');
  const port = server.wss.address().port;
  const sockets = [];
  try {
    const accountA = await registerTestAccount(server, { nickname: '主动离桌' });
    const accountB = await registerTestAccount(server, { nickname: '桌内观察' });
    const a = await connect(server, port, accountA.cookie); sockets.push(a.ws);
    const b = await connect(server, port, accountB.cookie); sockets.push(b.ws);

    a.send({ cmd: 'create', tableSize: 6 });
    const room = await a.waitFor((message) => message.ev === 'team', 'room create');
    b.send({ cmd: 'join', teamId: room.a.id });
    await b.waitFor((message) => message.ev === 'team' && message.a.members.length === 2, 'room join');
    a.send({ cmd: 'startPick' });
    await a.waitFor((message) => message.ev === 'pick', 'pick start');
    a.send({ cmd: 'pick', heroId: 'xiangyu' });
    b.send({ cmd: 'pick', heroId: 'diaochan' });
    await a.waitFor((message) => message.ev === 'pick' && message.a.allPicked, 'all picked');
    const autoB = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.ev !== 'onAwaitAction' || message.a.idx !== 2) return;
      b.send({ cmd: 'act', type: message.a.opts.canCheck ? 'check' : 'fold' });
    };
    b.ws.on('message', autoB);
    a.send({ cmd: 'startGame' });
    await a.waitFor((message) => message.ev === 'gameStart' && message.a.mySeat === 1, 'game start A');
    await b.waitFor((message) => message.ev === 'gameStart' && message.a.mySeat === 2, 'game start B');

    await a.waitFor((message) => message.ev === 'onAwaitAction' && message.a.idx === 1, 'A turn', 20_000);
    const leftAt = Date.now();
    a.send({ cmd: 'leave' });
    const [lobbyAfterLeave, defaultAction] = await Promise.all([
      a.waitFor((message) => message.ev === 'lobby'
        && message.a.activeGames?.some((game) => game.id === room.a.id), 'detached game lobby'),
      b.waitFor((message) => message.ev === 'onAction' && message.a.idx === 1, 'immediate default action'),
    ]);
    assert.ok(Date.now() - leftAt < 700, 'default action must not wait for the 30-second clock');
    assert.match(defaultAction.a.key, /check|fold/);
    assert.equal(lobbyAfterLeave.a.activeGames[0].seat, 1);

    a.send({ cmd: 'create', tableSize: 6 });
    const newRoom = await a.waitFor((message) => message.ev === 'team' && message.a.id !== room.a.id, 'new room');
    assert.notEqual(newRoom.a.id, room.a.id);
    a.send({ cmd: 'leave' });
    await a.waitFor((message) => message.ev === 'lobby'
      && message.a.activeGames?.some((game) => game.id === room.a.id), 'old game remains available');

    a.send({ cmd: 'rejoinGame', teamId: room.a.id });
    const resumed = await a.waitFor(
      (message) => message.ev === 'gameStart' && message.a.mySeat === 1,
      'old game rejoin',
    );
    assert.equal(resumed.a.mySeat, 1);
    await a.waitFor((message) => message.ev === 'sync', 'old game state sync');
    const ready = await a.waitFor((message) => message.ev === 'resumeReady', 'old game recovery ready');
    assert.deepEqual(ready.a, { teamId: room.a.id, seat: 1 });

    // A UI refresh can request the lobby after the server has already rebound
    // the seat. The running game must remain discoverable and rejoin idempotent.
    a.send({ cmd: 'lobby' });
    const refreshedLobby = await a.waitFor((message) => message.ev === 'lobby'
      && message.a.activeGames?.some((game) => game.id === room.a.id), 'attached game lobby refresh');
    const attachedGame = refreshedLobby.a.activeGames.find((game) => game.id === room.a.id);
    assert.equal(attachedGame.managed, false);
    assert.equal(attachedGame.attached, true);
    a.send({ cmd: 'rejoinGame', teamId: room.a.id });
    await a.waitFor((message) => message.ev === 'gameStart' && message.a.mySeat === 1,
      'idempotent attached game rejoin');
    await a.waitFor((message) => message.ev === 'sync', 'idempotent attached game sync');
    await a.waitFor((message) => message.ev === 'resumeReady', 'idempotent attached game ready');
    b.ws.off('message', autoB);
  } finally {
    await Promise.all(sockets.map((ws) => close(ws).catch(() => {})));
    await server.close();
  }
});
