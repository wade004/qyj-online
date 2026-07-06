// 群英决 Node 对战服端到端测试（node test/mp_smoke.mjs）
// 真实 WebSocket 双客户端：建队/加入/改名/选将互斥/AI补位开局/自动打满/断线托管/再开局
import { startServer } from '../server/server.mjs';

const PORT = 8791;
const server = startServer(PORT, { speed: 10 }); // 测试加速：演出节奏10倍速

function makeClient(tag) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
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

const A = makeClient('A');
const B = makeClient('B');
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
await B.waitFor((m) => m.ev === 'toast', 5000, '超长名拒绝');
console.log('[OK] 建队/加入/改名（超长名拒绝）');

// 3. 选将互斥
A.send({ cmd: 'startPick' });
await A.waitFor((m) => m.ev === 'pick', 5000, '进入选将');
A.send({ cmd: 'pick', heroId: 'xiangyu' });
await A.waitFor((m) => m.ev === 'pick' && m.a.heroes.some((hh) => hh.id === 'xiangyu' && hh.mine), 5000, 'A 锁定项羽');
B.send({ cmd: 'pick', heroId: 'xiangyu' });
await B.waitFor((m) => m.ev === 'toast', 5000, 'B 抢占被拒');
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
async function autoPlay(client, seat) {
  let over = null;
  const handler = (e) => {
    const msg = JSON.parse(e.data);
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

A.ws.close();
server.close();
console.log('MP-SMOKE ALL PASS');
process.exit(0);
