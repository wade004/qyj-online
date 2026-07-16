import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { startServer } from '../server.mjs';
import { ERROR_CODES, PROTOCOL_VERSION } from '../protocol.mjs';
import {
  loginTestAccount,
  registerTestAccount,
  withAuthCookie,
} from './auth-test-helpers.mjs';

const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms);
  Promise.resolve(promise).then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); },
  );
});

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'qyj-player-protocol-'));
  const databasePath = join(directory, 'qyj.sqlite');
  try {
    await run(databasePath);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}

async function openServer(databasePath, options = {}) {
  const server = startServer(0, {
    heartbeatMs: 0,
    shutdownGraceMs: 100,
    databasePath,
    ...options,
  });
  await withTimeout(server.ready, 2_000, '服务监听');
  return { server, port: server.wss.address().port };
}

async function connect(server, port, {
  authenticated = true,
  cookie: suppliedCookie,
} = {}) {
  const account = authenticated && !suppliedCookie
    ? await registerTestAccount(server)
    : null;
  const cookie = suppliedCookie || account?.cookie || '';
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}`,
    cookie ? withAuthCookie(cookie) : undefined,
  );
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    inbox.push(message);
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index];
      const foundIndex = inbox.findIndex(waiter.predicate);
      if (foundIndex < 0) continue;
      const [found] = inbox.splice(foundIndex, 1);
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(found);
    }
  });
  await withTimeout(once(ws, 'open'), 2_000, '客户端连接');
  const client = {
    ws,
    inbox,
    send(message) { ws.send(JSON.stringify(message)); },
    waitFor(predicate, label, timeoutMs = 3_000) {
      const foundIndex = inbox.findIndex(predicate);
      if (foundIndex >= 0) return Promise.resolve(inbox.splice(foundIndex, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`${label} 超时`));
        }, timeoutMs);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
  };
  client.send({
    cmd: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    capabilities: ['table-size-9'],
  });
  client.session = await client.waitFor((message) => message.ev === 'session', 'session');
  client.cookie = cookie;
  client.account = account;
  return client;
}

async function closeSocket(ws) {
  if (ws.readyState >= WebSocket.CLOSING) return;
  const closed = once(ws, 'close');
  ws.close();
  await withTimeout(closed, 1_000, '客户端关闭');
}

function assertProfileShape(profile) {
  assert.match(profile.playerId, /^p_[A-Za-z0-9_-]{20,64}$/u);
  assert.match(profile.shortId, /^[0-9A-F]{8}$/u);
  assert.equal(typeof profile.nickname, 'string');
  assert.equal(typeof profile.emblem, 'string');
  assert.ok(Number.isFinite(Date.parse(profile.createdAt)));
  assert.ok(Number.isFinite(Date.parse(profile.lastSeenAt)));
  assert.deepEqual(Object.keys(profile.stats).sort(),
    ['bestRank', 'matches', 'top3', 'winRate', 'wins'].sort());
  assert.ok(Array.isArray(profile.recentMatches));
  assert.equal(profile.pokerStats.rangeLabel, '近30天 · 最近200手');
  assert.equal(profile.pokerStats.windowDays, 30);
  assert.equal(profile.pokerStats.maxHands, 200);
}

test('登录会话/updateProfile/rename 使用统一 playerProfile 契约并跨重启恢复', async () => {
  await withDatabase(async (databasePath) => {
    const firstRuntime = await openServer(databasePath);
    const sockets = [];
    let stableProfile;
    let ownerUsername;
    try {
      const ownerAccount = await registerTestAccount(firstRuntime.server, {
        username: 'protocol_owner',
        email: 'protocol.owner@example.com',
        guestId: 'guest-protocol-owner-0001',
        nickname: '燕云客',
        emblem: '墨',
      });
      ownerUsername = ownerAccount.username;
      const owner = await connect(firstRuntime.server, firstRuntime.port, {
        cookie: ownerAccount.cookie,
      }); sockets.push(owner.ws);
      const initialProfile = owner.session.a.profile;
      assert.equal(owner.session.a.authenticated, true);
      assertProfileShape(initialProfile);
      assert.equal(initialProfile.nickname, '燕云客');

      const lobby = await owner.waitFor(
        (message) => message.ev === 'lobby' && message.a.player?.playerId,
        '大厅玩家资料',
      );
      assert.equal(lobby.a.player.playerId, initialProfile.playerId);

      owner.send({ cmd: 'updateProfile', nickname: '月下客', emblem: '月', avatarId: 14 });
      const updated = await owner.waitFor(
        (message) => message.ev === 'playerProfile' && message.a.saved === true,
        '资料保存',
      );
      assert.equal(updated.a.profile.nickname, '月下客');
      assert.equal(updated.a.profile.emblem, '月');
      assert.equal(updated.a.profile.avatarId, 14);

      owner.send({ cmd: 'rename', name: '墨客' });
      const renamed = await owner.waitFor(
        (message) => message.ev === 'playerProfile'
          && message.a.saved === true
          && message.a.profile.nickname === '墨客',
        '旧 rename 同步资料库',
      );
      stableProfile = renamed.a.profile;

      owner.send({ cmd: 'create' });
      const room = await owner.waitFor(
        (message) => message.ev === 'team' && message.a.members.length === 1,
        '创建房间',
      );
      const member = room.a.members[0];
      assert.equal(member.playerId, stableProfile.playerId);
      assert.equal(member.shortId, stableProfile.shortId);
      assert.equal(member.emblem, '月');
      assert.deepEqual(member.stats, stableProfile.stats);
      assert.deepEqual(member.pokerStats, stableProfile.pokerStats);

      const teammateAccount = await registerTestAccount(firstRuntime.server, {
        username: 'protocol_member',
        email: 'protocol.member@example.com',
        guestId: 'guest-protocol-member-0002',
        nickname: '青州客',
        emblem: '群',
      });
      const teammate = await connect(firstRuntime.server, firstRuntime.port, {
        cookie: teammateAccount.cookie,
      }); sockets.push(teammate.ws);
      const teammateProfile = teammate.session.a.profile;
      teammate.send({ cmd: 'join', teamId: room.a.id });
      const joined = await owner.waitFor(
        (message) => message.ev === 'team' && message.a.members.length === 2,
        '身份化队员加入',
      );
      assert.ok(joined.a.members.some((item) =>
        item.playerId === teammateProfile.playerId
          && item.shortId === teammateProfile.shortId
          && item.emblem === '群'));
      const teammateView = await teammate.waitFor(
        (message) => message.ev === 'team' && message.a.members.length === 2,
        '队员视角房间身份',
      );
      const self = teammateView.a.members.find((item) => item.isYou);
      const viewedOwner = teammateView.a.members.find((item) => item.isOwner);
      assert.equal(self.playerId, teammateProfile.playerId);
      assert.equal(self.shortId, teammateProfile.shortId);
      assert.equal(self.emblem, '群');
      assert.deepEqual(self.pokerStats, teammateProfile.pokerStats);
      assert.equal(self.isOwner, false);
      assert.equal(viewedOwner.playerId, stableProfile.playerId);
      assert.equal(viewedOwner.shortId, stableProfile.shortId);
      assert.equal(viewedOwner.emblem, '月');
      assert.deepEqual(viewedOwner.pokerStats, stableProfile.pokerStats);
      assert.equal(viewedOwner.isYou, false);
      for (const payload of [joined, teammateView]) {
        const serialized = JSON.stringify(payload);
        assert.equal(serialized.includes('guestId'), false);
        assert.equal(serialized.includes('guestHash'), false);
      }
    } finally {
      await Promise.all(sockets.map((ws) => closeSocket(ws).catch(() => {})));
      await firstRuntime.server.close();
    }

    const secondRuntime = await openServer(databasePath);
    const restoredAccount = await loginTestAccount(secondRuntime.server, {
      login: ownerUsername,
    });
    const restored = await connect(secondRuntime.server, secondRuntime.port, {
      cookie: restoredAccount.cookie,
    });
    try {
      const identifiedAgain = restored.session.a.profile;
      assert.equal(restored.session.a.authenticated, true);
      assert.equal(identifiedAgain.playerId, stableProfile.playerId);
      assert.equal(identifiedAgain.shortId, stableProfile.shortId);
      assert.equal(identifiedAgain.nickname, '墨客');
      assert.equal(identifiedAgain.emblem, '月');
    } finally {
      await closeSocket(restored.ws).catch(() => {});
      await secondRuntime.server.close();
    }
  });
});

test('玩家协议拒绝非法身份字段、未登录更新及登录连接内换号', async () => {
  const { server, port } = await openServer(':memory:');
  const sockets = [];
  const client = await connect(server, port, { authenticated: false });
  sockets.push(client.ws);
  try {
    const cases = [
      [
        { cmd: 'updateProfile', nickname: '合法名' },
        ERROR_CODES.AUTH_REQUIRED,
      ],
      [
        { cmd: 'identify', guestId: '../../etc/passwd', nickname: '甲', emblem: '侠' },
        ERROR_CODES.INVALID_GUEST_ID,
      ],
      [
        { cmd: 'identify', guestId: 'guest-security-player-0001', nickname: '甲', emblem: '远程图' },
        ERROR_CODES.INVALID_EMBLEM,
      ],
      [
        { cmd: 'updateProfile' },
        ERROR_CODES.INVALID_PROFILE,
      ],
      [
        { cmd: 'updateProfile', avatarId: 99 },
        ERROR_CODES.INVALID_AVATAR,
      ],
    ];
    for (const [payload, code] of cases) {
      client.send(payload);
      const error = await client.waitFor(
        (message) => message.ev === 'error' && message.a.code === code,
        code,
      );
      assert.equal(error.a.code, code);
    }

    client.send({
      cmd: 'identify',
      guestId: 'guest-security-player-0001',
      nickname: '甲',
      emblem: '侠',
    });
    const unauthenticatedIdentify = await client.waitFor(
      (message) => message.ev === 'error' && message.a.code === ERROR_CODES.AUTH_REQUIRED,
      '未登录身份绑定拦截',
    );
    assert.equal(unauthenticatedIdentify.a.code, ERROR_CODES.AUTH_REQUIRED);

    const account = await registerTestAccount(server, {
      nickname: '甲',
      emblem: '侠',
    });
    const authenticated = await connect(server, port, { cookie: account.cookie });
    sockets.push(authenticated.ws);
    authenticated.send({
      cmd: 'identify',
      guestId: 'guest-security-player-0002',
      nickname: '乙',
      emblem: '群',
    });
    const switched = await authenticated.waitFor(
      (message) => message.ev === 'error'
        && message.a.code === ERROR_CODES.PLAYER_ALREADY_IDENTIFIED,
      '连接内换号拦截',
    );
    assert.equal(switched.a.code, ERROR_CODES.PLAYER_ALREADY_IDENTIFIED);

    authenticated.send({ cmd: 'rename', name: '甲\n乙' });
    const unsafeName = await authenticated.waitFor(
      (message) => message.ev === 'error' && message.a.code === ERROR_CODES.INVALID_NAME,
      '控制字符昵称拦截',
    );
    assert.equal(unsafeName.a.code, ERROR_CODES.INVALID_NAME);
  } finally {
    await Promise.all(sockets.map((socket) => closeSocket(socket).catch(() => {})));
    await server.close();
  }
});

test('联机主动技能命令在本人行动窗口之外由服务端拒绝', async () => {
  const { server, port } = await openServer(':memory:', { speed: 1 });
  const client = await connect(server, port);
  try {
    client.send({ cmd: 'create' });
    await client.waitFor((message) => message.ev === 'team', '技能门禁房间');
    client.send({ cmd: 'startPick' });
    await client.waitFor((message) => message.ev === 'pick', '技能门禁选将');
    client.send({ cmd: 'pick', heroId: 'zhugeliang' });
    await client.waitFor(
      (message) => message.ev === 'pick' && message.a.allPicked,
      '技能门禁锁定英雄',
    );
    client.send({ cmd: 'startGame' });
    await client.waitFor((message) => message.ev === 'gameStart', '技能门禁开局');

    client.send({ cmd: 'skill' });
    const error = await client.waitFor(
      (message) => message.ev === 'error' && message.a.code === ERROR_CODES.NOT_YOUR_TURN,
      '非本人行动回合技能拒绝',
    );
    assert.equal(error.a.code, ERROR_CODES.NOT_YOUR_TURN);
  } finally {
    await closeSocket(client.ws).catch(() => {});
    await server.close();
  }
});

test('权威对局结算写入统计与最近战绩，重启后仍可读取', async () => {
  await withDatabase(async (databasePath) => {
    const firstRuntime = await openServer(databasePath, { speed: 1_000 });
    const playerAccount = await registerTestAccount(firstRuntime.server, {
      username: 'result_player',
      email: 'result.player@example.com',
      guestId: 'guest-result-player-0001',
      nickname: '战绩客',
      emblem: '侠',
    });
    const player = await connect(firstRuntime.server, firstRuntime.port, {
      cookie: playerAccount.cookie,
    });
    let resultProfile;
    const observedRounds = new Set();
    try {
      player.ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.ev === 'onRoundStart') observedRounds.add(message.a.round);
        if (message.ev !== 'onAwaitAction') return;
        player.send({ cmd: 'act', type: message.a.opts.canCheck ? 'check' : 'call' });
      });
      const initialProfile = player.session.a.profile;
      assert.equal(initialProfile.pokerStats.hands, 0);
      assert.equal(initialProfile.pokerStats.confidence, 'none');
      player.send({ cmd: 'create' });
      await player.waitFor((message) => message.ev === 'team', '单人房间');
      player.send({ cmd: 'startPick' });
      await player.waitFor((message) => message.ev === 'pick', '单人选将');
      player.send({ cmd: 'pick', heroId: 'xiangyu' });
      await player.waitFor(
        (message) => message.ev === 'pick' && message.a.allPicked,
        '锁定英雄',
      );
      player.send({ cmd: 'startGame' });
      const started = await player.waitFor(
        (message) => message.ev === 'gameStart', '开始对局',
      );
      const human = started.a.players.find((row) => row.seat === started.a.mySeat);
      assert.equal(human.isHuman, true);
      assert.equal(human.playerId, initialProfile.playerId);
      assert.equal(human.shortId, initialProfile.shortId);
      assert.equal(human.emblem, initialProfile.emblem);
      assert.deepEqual(human.pokerStats, initialProfile.pokerStats);
      assert.ok(started.a.players.filter((row) => !row.isHuman)
        .every((row) => !Object.hasOwn(row, 'playerId')));
      const over = await player.waitFor(
        (message) => message.ev === 'onGameOver', '对局结算', 30_000,
      );
      resultProfile = (await player.waitFor(
        (message) => message.ev === 'playerProfile'
          && message.a.profile.stats.matches === 1,
        '战绩资料推送',
      )).a.profile;
      const placement = over.a.ranking.findIndex((row) => row.isMe) + 1;
      assert.equal(resultProfile.playerId, initialProfile.playerId);
      assert.equal(resultProfile.stats.matches, 1);
      assert.equal(resultProfile.stats.wins, placement === 1 ? 1 : 0);
      assert.equal(resultProfile.stats.top3, placement <= 3 ? 1 : 0);
      assert.equal(resultProfile.stats.bestRank, placement);
      assert.equal(resultProfile.recentMatches.length, 1);
      assert.equal(resultProfile.recentMatches[0].tableSize, 6);
      assert.equal(resultProfile.recentMatches[0].placement, placement);
      assert.equal(resultProfile.recentMatches[0].heroId, 'xiangyu');
      assert.match(resultProfile.recentMatches[0].matchId, /^[0-9a-f-]{36}$/u);
      assert.equal(resultProfile.pokerStats.hands, observedRounds.size);
      assert.ok(resultProfile.pokerStats.hands >= 1 && resultProfile.pokerStats.hands <= 12);
      assert.equal(resultProfile.pokerStats.confidence, 'low');
      assert.equal(typeof resultProfile.pokerStats.vpip, 'number');
      assert.equal(typeof resultProfile.pokerStats.pfr, 'number');
    } finally {
      await closeSocket(player.ws).catch(() => {});
      await firstRuntime.server.close();
    }

    const secondRuntime = await openServer(databasePath);
    const restoredAccount = await loginTestAccount(secondRuntime.server, {
      login: playerAccount.username,
    });
    const restored = await connect(secondRuntime.server, secondRuntime.port, {
      cookie: restoredAccount.cookie,
    });
    try {
      const profile = restored.session.a.profile;
      assert.deepEqual(profile.stats, resultProfile.stats);
      assert.deepEqual(profile.recentMatches, resultProfile.recentMatches);
      assert.deepEqual(profile.pokerStats, resultProfile.pokerStats);
    } finally {
      await closeSocket(restored.ws).catch(() => {});
      await secondRuntime.server.close();
    }
  });
});
