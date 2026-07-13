import { assertBattleEngineContract } from '../js/session/battle-session.js';
import { createRemoteBattleSession } from '../js/session/remote-battle-session.js';
import { createOnlineSession } from '../js/session/online-session.js';
import { HEROES } from '../js/game/heroes.js';

const assert = (condition, message) => {
  if (!condition) throw new Error(`BattleSession 契约失败：${message}`);
};

const heroIds = HEROES.slice(0, 6).map((hero) => hero.id);
const samplePokerStats = {
  rangeLabel: '近30天 · 最近200手', windowDays: 30, maxHands: 200,
  hands: 42, confidence: 'medium', vpip: 31, pfr: 19, threeBet: 7.5,
  af: 2.1, wtsd: 28, wsd: 52, cbet: 61, foldToCbet: 44,
};
const startData = {
  mySeat: 1,
  players: heroIds.map((heroId, index) => ({
    seat: index + 1,
    heroId,
    name: index === 0 ? '契约玩家' : `AI·${index + 1}`,
    isHuman: index === 0,
    ...(index === 0 ? {
      playerId: 'p_contract_player_0000000001',
      shortId: 'C0DE1234',
      emblem: '墨',
      pokerStats: samplePokerStats,
    } : {}),
  })),
};
const commands = [];
const remote = createRemoteBattleSession(startData, (command) => commands.push(command));
assertBattleEngineContract(remote.rawEngine, 'RemoteEngine');
assert(remote.kind === 'remote', '远程 facade 类型');
assert(remote.players[1].pokerStats?.hands === 42
  && remote.players[1].shortId === 'C0DE1234', '远程玩家保留公开扑克统计与身份元数据');
remote.rawEngine.waitingIdx = 1;
remote.playerAct({ type: 'raise', tier: { key: 'feint' } });
assert(commands[0]?.cmd === 'act' && commands[0]?.tierKey === 'feint', '远程行动命令透传');

const remoteMe = remote.players[1];
remote.rawEngine.street = 'preflop';
remote.rawEngine.revealed = 0;
remoteMe.hole = [{ rank: 8, suit: 1 }, { rank: 4, suit: 2 }];
remoteMe.energy = 5;
remoteMe.skillUsed = false;
remoteMe.folded = false;
remoteMe.alive = true;
remote.rawEngine.actingIdx = 2;
remote.rawEngine.waitingIdx = 2;
assert(!remote.useSkill(1) && commands.length === 1, '远程镜像不得在别人回合发送技能命令');
remote.rawEngine.actingIdx = 1;
remote.rawEngine.waitingIdx = 1;
assert(remote.useSkill(1) && commands[1]?.cmd === 'skill', '本人行动窗口应发送技能命令');
remote.rawEngine.actingIdx = 0;
remote.rawEngine.waitingIdx = null;
assert(!remote.useSkill(1) && commands.length === 2, '行动完成后不得继续发送技能命令');

const playerSnapshot = (seat, betStreet = 0) => ({
  seat,
  hp: 1500,
  energy: 2,
  alive: true,
  folded: false,
  allIn: false,
  betStreet,
  betRound: betStreet,
  skillUsed: false,
  skillModifiers: [],
});
remote.players[2].hole = [{ rank: 14, suit: 1 }, { rank: 13, suit: 1 }];
remote.players[2].showdownInfo = { name: '前局牌型', cat: 2, score: 1 };
remote.onMessage({
  ev: 'onRoundStart',
  a: { round: 1, blinds: { sb: 10, bb: 20 }, dealerIdx: 4 },
  s: {
    round: 1,
    street: 'preflop',
    pot: 30,
    waitingIdx: null,
    revealed: 0,
    board: [],
    players: heroIds.map((_, index) => playerSnapshot(index + 1, index === 1 ? 20 : 0)),
    potDisplay: [{ label: '当前血池', amount: 30, kind: 'main' }],
  },
});
assert(remote.dealerIdx === 4, '旧协议可由 onRoundStart 补齐庄位');
assert(remote.currentBet === 20, '旧协议可由玩家投入推导当前下注');
assert(remote.players.slice(1).every((player) => player.hole.length === 0 && !player.showdownInfo),
  '新一局必须清除上一局已公开的底牌和牌型，等待本人私有发牌或新的公开亮牌');

remote.onMessage({
  ev: 'onTurnStart',
  a: {
    idx: 2,
    clock: { turnId: 7, idx: 2, remainingMs: 30000, totalMs: 30000 },
  },
  s: {
    actingIdx: 2,
    actionClock: { turnId: 7, idx: 2, remainingMs: 30000, totalMs: 30000 },
  },
});
assert(remote.actionClock?.idx === 2 && remote.actionClock?.remainingMs === 30000,
  '公开行动时钟应通过快照镜像到 BattleSession');
remote.onMessage({
  ev: 'onActionClock',
  a: { clock: { turnId: 7, idx: 2, remainingMs: 34000, totalMs: 60000 } },
  s: {
    actingIdx: 2,
    actionClock: { turnId: 7, idx: 2, remainingMs: 34000, totalMs: 60000 },
  },
});
assert(remote.actionClock?.remainingMs === 34000 && remote.actionClock?.totalMs === 60000,
  '延时后的公开行动时钟应同步剩余时间和总时长');

remote.onMessage({
  ev: 'onAction',
  a: { idx: 1, key: 'feint', amount: 30 },
  s: {
    street: 'preflop',
    pot: 60,
    players: heroIds.map((_, index) => playerSnapshot(index + 1, index === 0 ? 30 : index === 1 ? 20 : 0)),
    potDisplay: [
      { label: '当前血池', amount: 60, kind: 'main' },
      {
        label: '上次下注前', amount: 30, kind: 'reference',
        actorIdx: 1, wagerAmount: 30, ratio: 1,
      },
    ],
  },
});
assert(remote.streetRaiseCount === 1, '旧协议可由行动事件跟踪加注次数');
assert(remote.lastAggressiveWager?.actorIdx === 1, '旧协议可由血池展示恢复最近进攻');
assert(remote.actingIdx === 0 && remote.players[1].acted
  && remote.players[1].lastAction?.key === 'feint'
  && remote.players[1].lastAction?.amount === 30,
  '旧快照缺少行动字段时仍可由事件镜像最近行动');
assert(remote.actionClock === null, '行动完成后必须清除公开行动时钟');

remote.rawEngine.applySnapshot({
  dealerIdx: 5,
  currentBet: 45,
  streetRaiseCount: 2,
  actingIdx: 3,
  players: heroIds.map((_, index) => ({
    ...playerSnapshot(index + 1),
    acted: index === 1,
    lastAction: index === 1
      ? { key: 'call', amount: 20, street: 'preflop', round: 1 }
      : null,
  })),
  lastAggressiveWager: { actorIdx: 2, amount: 25, potBefore: 40, ratio: 0.625 },
});
assert(remote.dealerIdx === 5 && remote.currentBet === 45 && remote.streetRaiseCount === 2,
  '兼容未来协议直接提供决策字段');
assert(remote.actingIdx === 3 && remote.getState().actingIdx === 3,
  'BattleSession 应暴露权威快照中的当前行动者');
assert(remote.players[2].acted && remote.players[2].lastAction?.key === 'call',
  'RemoteEngine 应镜像权威 acted/lastAction 玩家状态');
remote.onMessage({
  ev: 'onAction',
  a: { idx: 3, key: 'check', amount: 0 },
  s: {
    actingIdx: 0,
    players: heroIds.map((_, index) => ({
      ...playerSnapshot(index + 1),
      acted: index === 2,
      lastAction: index === 2
        ? { key: 'check', amount: 0, street: 'preflop', round: 1 }
        : null,
    })),
  },
});
assert(remote.actingIdx === 0 && remote.players[3].lastAction?.key === 'check',
  '完成行动的权威快照应清除 actingIdx 并保存最近操作');

class FakeClient {
  constructor(url = '') {
    this.url = url;
    this.listener = null;
    this.sent = [];
    this.closed = false;
    this.reconnected = false;
  }
  subscribe(listener) { this.listener = listener; return () => { this.listener = null; }; }
  connect() { this.listener?.({ type: 'open' }); }
  send(value) { this.sent.push(value); return true; }
  close() { this.closed = true; }
  reconnect() { this.reconnected = true; this.connect(); }
  setUrl(url) { this.url = url; }
  message(value) { this.listener?.({ type: 'message', data: JSON.stringify(value) }); }
}

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.get(key) || null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const resumeStorage = new MemoryStorage();

let fakeClient;
const online = createOnlineSession({
  url: 'ws://contract.test',
  autoReconnect: false,
  sessionStorage: resumeStorage,
  playerProfile: {
    guestId: 'guest-contract-player-0001',
    nickname: '本地契约玩家',
    emblem: '侠',
  },
  clientFactory: (url) => (fakeClient = new FakeClient(url)),
});
const states = [];
online.subscribe((state) => states.push(state));
assert(fakeClient.sent[0]?.cmd === 'hello', '连接成功后先请求登录会话');
assert(fakeClient.sent[0]?.protocolVersion === 3
  && fakeClient.sent[0]?.capabilities?.includes('table-size-9'),
'首包必须声明 9 人桌能力');
fakeClient.message({
  ev: 'session',
  a: {
    resumeToken: 'token-1', resumed: false, resumeGraceMs: 15000,
    protocolVersion: 3, supportedTableSizes: [6, 9], authenticated: true,
    account: { username: 'contract_player', email: 'contract@example.com' },
  },
});
assert(online.getState().supportedTableSizes.join(',') === '6,9',
  '会话状态透传服务端支持桌型');
assert([...resumeStorage.values.values()].includes('token-1'), '恢复令牌仅写入 sessionStorage');
assert(online.getState().authenticated
  && online.getState().account?.username === 'contract_player', '会话由安全 Cookie 绑定联机账号');
fakeClient.message({
  ev: 'playerProfile',
  a: {
    profile: {
      playerId: 'QYJ-CONTRACT', shortId: 'C0DE', nickname: '契约玩家', emblem: '墨',
      stats: { matches: 5, wins: 2, top3: 4, bestRank: 1, winRate: 40 },
      recentMatches: [],
      pokerStats: samplePokerStats,
    },
  },
});
assert(online.getState().player.playerId === 'QYJ-CONTRACT'
  && online.getState().player.stats.matches === 5
  && online.getState().player.pokerStats.hands === 42
  && online.getState().player.pokerStats.threeBet === 7.5
  && online.getState().profileSync === 'synced', '服务端玩家资料成为会话权威状态');
fakeClient.message({ ev: 'lobby', a: { yourName: '契约玩家', teams: [] } });
assert(online.getState().screen === 'lobby', '大厅状态');
assert(online.createTeam(9) && fakeClient.sent.at(-1)?.tableSize === 9,
  '创建 9 人桌命令透传 tableSize');
const profileSave = online.updatePlayerProfile({ nickname: '新契约名', emblem: '月' });
assert(fakeClient.sent.at(-1)?.cmd === 'updateProfile', '玩家资料更新走服务端命令');
fakeClient.message({
  ev: 'playerProfile',
  a: {
    saved: true,
    profile: {
      playerId: 'QYJ-CONTRACT', shortId: 'C0DE', nickname: '新契约名', emblem: '月',
      stats: { matches: 5, wins: 2, top3: 4, bestRank: 1, winRate: 40 },
      recentMatches: [],
      pokerStats: samplePokerStats,
    },
  },
});
const profileSaveResult = await profileSave;
assert(profileSaveResult.ok && profileSaveResult.saved
  && online.getState().player.nickname === '新契约名'
  && online.getState().notice?.message === '玩家资料已保存', '资料保存回执刷新玩家状态与提示');
const rejectedProfileSave = online.updatePlayerProfile({ nickname: '待拒绝名', emblem: '侠' });
fakeClient.message({
  ev: 'error',
  a: { code: 'PLAYER_NOT_IDENTIFIED', message: '尚未绑定玩家身份' },
});
const rejectedProfileResult = await rejectedProfileSave;
assert(!rejectedProfileResult.ok
  && rejectedProfileResult.error.code === 'PLAYER_NOT_IDENTIFIED'
  && online.getState().profileSync === 'error', '资料保存失败由服务端回执立即结束等待');
fakeClient.message({ ev: 'team', a: { yourName: '契约玩家', members: [], isOwner: true } });
fakeClient.message({ ev: 'pick', a: { heroes: [], isOwner: true } });
fakeClient.message({
  ev: 'team',
  a: {
    phase: 'picking', yourName: '契约玩家', isOwner: true,
    members: [{ name: '契约玩家', isYou: true, isOwner: true, connection: 'offline' }],
  },
});
assert(online.getState().screen === 'pick'
  && online.getState().data.members[0].connection === 'offline', '选将中成员连接态更新不退出选将页');
fakeClient.message({
  ev: 'team',
  a: {
    phase: 'picking', yourName: '契约玩家', isOwner: true,
    members: [{ name: '契约玩家', isYou: true, isOwner: true, connection: 'online' }],
  },
});
fakeClient.message({ ev: 'gameStart', a: startData });
assert(online.getState().screen === 'battle' && online.getState().battle?.kind === 'remote',
  '联机会话提供远程 BattleSession');
const retainedBattle = online.getState().battle;
retainedBattle.rawEngine.players[1].playerName = '无名侠客';
retainedBattle.rawEngine.waitingIdx = 1;
const sentBeforeDisconnect = fakeClient.sent.length;
fakeClient.listener?.({ type: 'close', intentional: false });
assert(online.getState().screen === 'battle' && online.getState().battle === retainedBattle,
  '断线保留 battle screen 与原 facade');
assert(online.getState().writeBlocked && online.getState().connection === 'error', '恢复前阻断写操作');
assert(retainedBattle.playerAct({ type: 'check' }) === false
  && fakeClient.sent.length === sentBeforeDisconnect, '恢复层阻止战斗命令外发');

online.reconnect();
assert(fakeClient.sent.at(-1)?.cmd === 'resume' && fakeClient.sent.at(-1)?.resumeToken === 'token-1',
  '重连首条命令携带 sessionStorage 恢复令牌');
assert(fakeClient.url === 'ws://contract.test', '恢复令牌不进入 URL');
fakeClient.message({
  ev: 'session',
  a: {
    resumeToken: 'token-2', resumed: true, resumeGraceMs: 15000, authenticated: true,
    profile: {
      playerId: 'QYJ-CONTRACT', shortId: 'C0DE', nickname: '阳顶天', emblem: '月',
      stats: { matches: 5, wins: 2, top3: 4, bestRank: 1, winRate: 40 },
      recentMatches: [], pokerStats: samplePokerStats,
    },
  },
});
fakeClient.message({ ev: 'gameStart', a: startData });
assert(online.getState().battle === retainedBattle, '恢复 gameStart 复用原 battle facade');
assert(retainedBattle.rawEngine.players[1].playerName === '阳顶天',
  '恢复 gameStart 必须用权威玩家资料刷新旧 RemoteEngine 姓名');
fakeClient.message({
  ev: 'sync', a: {},
  s: {
    round: 2, street: 'flop', pot: 40, waitingIdx: null, revealed: 3,
    board: [{ r: 2, s: 1 }, { r: 7, s: 2 }, { r: 11, s: 3 }],
    players: heroIds.map((_, index) => playerSnapshot(index + 1)),
    potDisplay: [{ label: '当前血池', amount: 40, kind: 'main' }],
  },
});
fakeClient.message({ ev: 'hole', a: { hole: [{ r: 14, s: 1 }, { r: 13, s: 1 }] } });
assert(online.getState().connection === 'open' && !online.getState().writeBlocked,
  '同步公开快照和本人暗令后解除恢复阻断');
assert(online.getState().battle === retainedBattle, '恢复完成仍使用原 battle 对象');
assert([...resumeStorage.values.values()].includes('token-2'), '恢复成功后轮换 sessionStorage 令牌');
const restoredNotice = online.getState().notice;
assert(restoredNotice?.message === '已恢复至最新进度', '恢复成功统一提示');

fakeClient.message({ ev: 'error', a: { code: 'HERO_TAKEN', message: '该英雄已被占用' } });
const errorNoticeId = online.getState().notice.id;
fakeClient.message({ ev: 'toast', a: { msg: '该英雄已被占用' } });
assert(online.getState().notice.id === errorNoticeId, 'error/toast 相同提示按 notice id 去重');

fakeClient.message({
  ev: 'onGameOver',
  a: {
    ranking: [{
      seat: 1, heroId: heroIds[0], name: '契约玩家', hp: 1500,
      alive: true, deathRound: null,
    }],
  },
});
online.tick(2.1);
assert(online.getState().screen === 'result', '对局结束后进入结算状态');
assert(online.getState().data.mySeat === 1 && online.getState().data.ranking.length === 1,
  '结算状态包含 ranking/mySeat');

fakeClient.listener?.({ type: 'close', intentional: false });
online.reconnect();
assert(fakeClient.sent.at(-1)?.resumeToken === 'token-2', '结算页使用轮换后的令牌恢复');
  fakeClient.message({ ev: 'session', a: { resumeToken: 'token-3', resumed: true, resumeGraceMs: 15000, authenticated: true } });
fakeClient.message({
  ev: 'resumeResult',
  a: {
    mySeat: 1,
    tableSize: 9,
    ranking: [{ seat: 1, heroId: heroIds[0], name: '契约玩家', hp: 1500, alive: true, deathRound: null, isMe: true }],
  },
});
assert(online.getState().screen === 'result' && online.getState().data.ranking[0].idx === 1,
  'resumeResult 映射为现有结算模型');
assert(online.getState().data.tableSize === 9, 'resumeResult 保留桌型');
assert(online.backToRoom()
  && online.getState().screen === 'connecting'
  && online.getState().writeBlocked, '返回房间期间暂时阻断写操作');
fakeClient.message({
  ev: 'team',
  a: {
    phase: 'lobby', yourName: '契约玩家', isOwner: true,
    members: [{ name: '契约玩家', isYou: true, isOwner: true, connection: 'online' }],
  },
});
assert(online.getState().screen === 'room' && !online.getState().writeBlocked,
  '返回房间收到权威状态后解除写锁与遮罩');

fakeClient.listener?.({ type: 'close', intentional: false });
online.reconnect();
  fakeClient.message({ ev: 'session', a: { resumeToken: 'token-4', resumed: false, resumeGraceMs: 15000, authenticated: true } });
assert(online.getState().screen === 'connecting' && online.getState().battle === null,
  '服务端明确会话过期后才清理 battle');
fakeClient.message({ ev: 'lobby', a: { yourName: '新会话玩家', teams: [] } });
assert(online.getState().screen === 'lobby', '会话过期返回大厅');
assert(states.every((state, index) => index === 0 || state.revision > states[index - 1].revision),
  '状态 revision 单调递增');
assert(states.every((state, index) => index === 0 || state !== states[index - 1]),
  '每次发布使用新状态对象');
online.destroy();
assert(fakeClient.closed && online.getState().screen === 'closed', '销毁会话关闭连接');

let authGateClient;
const authCalls = [];
const authGateSession = createOnlineSession({
  url: 'ws://auth-gate.test',
  autoReconnect: false,
  sessionStorage: new MemoryStorage(),
  playerProfile: {
    guestId: 'guest-auth-gate-0000001', nickname: '待登录联网玩家', emblem: '侠',
  },
  accountClient: {
    async login(payload) {
      authCalls.push(payload);
      return { ok: true, data: { authenticated: true } };
    },
  },
  clientFactory: (url) => (authGateClient = new FakeClient(url)),
});
authGateClient.message({
  ev: 'session',
  a: { resumeToken: null, resumed: false, authenticated: false, protocolVersion: 3 },
});
assert(authGateSession.getState().screen === 'auth'
  && !authGateSession.getState().authenticated, '联机未登录时进入账号入口');
await authGateSession.loginAccount({ identifier: 'hero@example.com', password: 'password-123' });
assert(authCalls[0]?.identifier === 'hero@example.com'
  && authGateClient.reconnected, '用户名或邮箱登录成功后重建联机连接');
authGateSession.destroy();

let retryClient;
const retrySession = createOnlineSession({
  url: 'ws://retry.test',
  retryDelays: [0],
  sessionStorage: new MemoryStorage(),
  clientFactory: (url) => (retryClient = new FakeClient(url)),
});
retryClient.listener?.({ type: 'close', intentional: false });
assert(retrySession.getState().connection === 'reconnecting', '断线进入自动重连状态');
await new Promise((resolve) => setTimeout(resolve, 5));
assert(retryClient.reconnected, '自动重连执行');
retryClient.message({ ev: 'session', a: { resumeToken: 'retry-token', resumed: false, authenticated: true } });
retryClient.message({ ev: 'lobby', a: { yourName: '重连玩家', teams: [] } });
assert(retrySession.getState().connection === 'open', '自动重连后恢复可写状态');
retrySession.destroy();

let cancelledClient;
const cancelledSession = createOnlineSession({
  url: 'ws://cancel-retry.test',
  retryDelays: [30],
  sessionStorage: new MemoryStorage(),
  clientFactory: (url) => (cancelledClient = new FakeClient(url)),
});
cancelledClient.listener?.({ type: 'close', intentional: false });
cancelledSession.destroy();
await new Promise((resolve) => setTimeout(resolve, 40));
assert(!cancelledClient.reconnected, 'destroy 取消待执行的自动重连');

const throwingStorage = {
  getItem() { throw new Error('denied'); },
  setItem() { throw new Error('denied'); },
  removeItem() { throw new Error('denied'); },
};
let privacyClient;
const privacySession = createOnlineSession({
  url: 'ws://privacy.test',
  sessionStorage: throwingStorage,
  clientFactory: (url) => (privacyClient = new FakeClient(url)),
});
privacyClient.message({ ev: 'session', a: { resumeToken: 'private-token', resumed: false, authenticated: true } });
privacyClient.message({ ev: 'lobby', a: { yourName: '隐私玩家', teams: [] } });
assert(privacySession.getState().screen === 'lobby', '隐私模式拒绝 sessionStorage 时仍可使用');
privacySession.destroy();

console.log('BattleSession/OnlineSession 契约自检通过：联网远程 facade、旧快照兼容与状态流正常');
