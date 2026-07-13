// 群英决 Node 对战服端到端测试（node test/mp_smoke.mjs）
// 真实 WebSocket 双客户端：建队/加入/改名/选将互斥/AI补位开局/自动打满/断线托管/再开局
import { startServer } from '../server/server.mjs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const WebSocket = require('ws');
const server = startServer(0, {
  speed: 10,
  resumeGraceMs: 0,
  databasePath: ':memory:',
}); // 测试加速；本用例保留旧的立即清退语义
await server.ready;
const PORT = server.wss.address().port;

function makeClient(tag, cookie) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, {
    headers: { cookie },
  });
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      const found = inbox.find(w.pred);
      if (found) {
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(found);
      }
    }
  });
  return {
    tag, ws, inbox,
    send: (obj) => ws.send(JSON.stringify(obj)),
    open: () => new Promise((res) => ws.addEventListener('open', res, { once: true })),
    /** 等待满足条件的消息（会消费掉收件箱中匹配项之前的所有消息） */
    waitFor(pred, timeoutMs = 15000, desc = '') {
      const found = inbox.find(pred);
      if (found) {
        inbox.splice(0, inbox.indexOf(found) + 1);
        return Promise.resolve(found);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${tag} 等待超时: ${desc}`)), timeoutMs);
        waiters.push({
          pred, timer,
          resolve: (m) => {
            inbox.splice(0, inbox.indexOf(m) + 1);
            resolve(m);
          },
        });
      });
    },
  };
}

const assert = (cond, msg) => { if (!cond) throw new Error('断言失败: ' + msg); };

async function createAuthenticatedCookie(tag) {
  const registered = await server.playerStore.registerAccount({
    username: `smoke_${tag.toLowerCase()}`,
    email: `smoke.${tag.toLowerCase()}@example.com`,
    password: 'smoke-password-2026',
    guestId: `guest-mp-smoke-${tag.toLowerCase()}-000001`,
    nickname: `联机玩家${tag}`,
    emblem: '侠',
  });
  const issued = server.playerStore.issueAuthSession(registered.profile.playerId);
  return `qyj_session=${issued.token}`;
}

const [cookieA, cookieB] = await Promise.all([
  createAuthenticatedCookie('A'),
  createAuthenticatedCookie('B'),
]);
const A = makeClient('A', cookieA);
const B = makeClient('B', cookieB);
await Promise.all([A.open(), B.open()]);

// 1. 大厅与赐名
const lbA = await A.waitFor((m) => m.ev === 'lobby', 5000, '大厅快照');
assert(lbA.a.yourName, 'A 应获随机赐名');
console.log(`[OK] 连接+赐名 A=${lbA.a.yourName}`);

// 2. 建队/加入/改名
A.send({ cmd: 'create' });
const tmA = await A.waitFor((m) => m.ev === 'team', 5000, 'A 建队');
assert(tmA.a.isOwner && tmA.a.members.length === 1, 'A 应为房主');
B.send({ cmd: 'join', teamId: tmA.a.id });
await B.waitFor((m) => m.ev === 'team' && m.a.members.length === 2, 5000, 'B 入队');
B.send({ cmd: 'rename', name: '阿豹' });
await B.waitFor((m) => m.ev === 'team' && m.a.yourName === '阿豹', 5000, 'B 改名');
B.send({ cmd: 'rename', name: '超过八个字的超长名字' });
await B.waitFor((m) => m.ev === 'error' && m.a.code === 'INVALID_NAME', 5000, '超长名拒绝');
console.log('[OK] 建队/加入/改名（超长名拒绝）');

// 3. 选将互斥
A.send({ cmd: 'startPick' });
await A.waitFor((m) => m.ev === 'pick', 5000, '进入选将');
A.send({ cmd: 'pick', heroId: 'xiangyu' });
await A.waitFor((m) => m.ev === 'pick' && m.a.heroes.some((hh) => hh.id === 'xiangyu' && hh.mine), 5000, 'A 锁定项羽');
B.send({ cmd: 'pick', heroId: 'xiangyu' });
await B.waitFor((m) => m.ev === 'error' && m.a.code === 'HERO_TAKEN', 5000, 'B 抢占被拒');
B.send({ cmd: 'pick', heroId: 'diaochan' });
const pk = await B.waitFor((m) => m.ev === 'pick' && m.a.allPicked, 5000, '全员选定');
assert(pk.a.heroes.find((hh) => hh.id === 'xiangyu').takenBy, '项羽应标注占用者');
console.log('[OK] 选将互斥 + allPicked');

// 4. 开局（AI补位·英雄唯一）
B.send({ cmd: 'startGame' }); // 非房主应被忽略
A.send({ cmd: 'startGame' });
const gsA = await A.waitFor((m) => m.ev === 'gameStart', 5000, 'A gameStart');
const gsB = await B.waitFor((m) => m.ev === 'gameStart', 5000, 'B gameStart');
assert(gsA.a.mySeat === 1 && gsB.a.mySeat === 2, '座位分配');
const heroIds = gsA.a.players.map((p) => p.heroId);
assert(new Set(heroIds).size === 6, '英雄唯一: ' + heroIds);
assert(gsA.a.players.filter((p) => !p.isHuman).every((p) => p.name.startsWith('AI·')), 'AI 命名');
console.log(`[OK] 开局 2真人+4AI 英雄唯一 ${heroIds.join(',')}`);

// 5. 自动打满一局（真人跟AI策略：能静观则静观，否则应战；A 测一次延时）
let extendTested = false;
const clockAudit = {
  A: { initial: false, extended: false, cleared: false, leakedOptions: false },
  B: { initial: false, extended: false, cleared: false, leakedOptions: false },
};
async function autoPlay(client, seat) {
  let over = null;
  const handler = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.ev === 'onTurnStart' && msg.a.clock) {
      const clock = msg.a.clock;
      if (clock.remainingMs > 0 && clock.remainingMs <= 30000 && clock.totalMs === 30000) {
        clockAudit[client.tag].initial = true;
      }
    } else if (msg.ev === 'onActionClock') {
      const clock = msg.a.clock;
      clockAudit[client.tag].leakedOptions ||= Object.hasOwn(msg.a, 'opts');
      if (clock?.totalMs >= 60000 && clock.remainingMs > 30000) {
        clockAudit[client.tag].extended = true;
      }
    } else if (msg.ev === 'onAction' && msg.s?.actionClock === null) {
      clockAudit[client.tag].cleared = true;
    }
    if (msg.ev === 'onGameOver') over = msg.a.ranking;
    else if (msg.ev === 'onAwaitAction' && msg.a.idx === seat) {
      if (!extendTested && client.tag === 'A') {
        extendTested = true;
        client.send({ cmd: 'extend' });
      }
      client.send({ cmd: 'act', type: msg.a.opts.canCheck ? 'check' : 'call' });
    }
  };
  client.ws.addEventListener('message', handler);
  const t0 = Date.now();
  while (!over && Date.now() - t0 < 180000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  client.ws.removeEventListener('message', handler);
  if (!over) throw new Error(`${client.tag} 对局未在限时内结束`);
  return over;
}
const [rkA, rkB] = await Promise.all([autoPlay(A, 1), autoPlay(B, 2)]);
assert(rkA.length === 6 && rkB.length === 6, '结算名次6人');
assert(rkA.filter((r) => r.isMe).length === 1, 'isMe 恰好1个');
for (const [tag, audit] of Object.entries(clockAudit)) {
  assert(audit.initial, `${tag} 应收到全员公开的30秒行动时钟`);
  assert(audit.extended, `${tag} 应同步看到A延时后的60秒总时长`);
  assert(audit.cleared, `${tag} 应在行动完成快照中清除行动时钟`);
  assert(!audit.leakedOptions, `${tag} 的公开时钟事件不得泄露私有操作选项`);
}
console.log(`[OK] 完整对局打满 冠军=${rkA[0].name}(${rkA[0].heroId})`);

// 6. 战后回房 & 再开一局 & B 断线托管
A.inbox.length = 0; B.inbox.length = 0;
A.send({ cmd: 'backToRoom' });
const tm2 = await A.waitFor((m) => m.ev === 'team', 5000, '战后回房');
assert(tm2.a.phase === 'lobby', '队伍应回待命');
A.send({ cmd: 'startPick' });
await A.waitFor((m) => m.ev === 'pick', 5000, '二局选将');
A.send({ cmd: 'pick', heroId: 'lianpo' });
B.send({ cmd: 'pick', heroId: 'hanxin' });
await A.waitFor((m) => m.ev === 'pick' && m.a.allPicked, 5000, '二局全选');
A.send({ cmd: 'startGame' });
await A.waitFor((m) => m.ev === 'gameStart', 5000, '二局开局');
await B.waitFor((m) => m.ev === 'gameStart', 5000, 'B 二局开局');
B.ws.close(); // 对局中断线 → 托管
const rk2 = await autoPlay(A, 1);
assert(rk2.length === 6, 'B断线后对局仍完整结算');
console.log(`[OK] 断线托管：B掉线后打满 冠军=${rk2[0].name}`);

// 7. 断线成员必须从房间清退；幸存者接任房主并可立即再次开局
A.inbox.length = 0;
A.send({ cmd: 'backToRoom' });
const tm3 = await A.waitFor((m) => m.ev === 'team', 5000, '断线结算后回房');
assert(tm3.a.members.length === 1, '断线成员不得在结算后占据房间名额');
assert(tm3.a.isOwner, '房间幸存者应持有房主权限');
A.send({ cmd: 'startPick' });
await A.waitFor((m) => m.ev === 'pick', 5000, '断线后再次选将');
A.send({ cmd: 'pick', heroId: 'xiangyu' });
await A.waitFor((m) => m.ev === 'pick' && m.a.allPicked, 5000, '单人再次选定');
A.send({ cmd: 'startGame' });
const gs3 = await A.waitFor((m) => m.ev === 'gameStart', 5000, '断线后再次开局');
assert(gs3.a.players.filter((p) => p.isHuman).length === 1, '再次开局应仅保留在线真人');
console.log('[OK] 断线清退：回房无幽灵成员，幸存者可再次开局');

A.ws.close();
await server.close();
console.log('MP-SMOKE ALL PASS');
