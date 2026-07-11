import { HEROES, getHero } from '../game/heroes.js';
import { makeCommand, parseServerMessage, resolveWebSocketUrl } from '../net/protocol.js';
import { createWsClient } from '../net/ws-client.js';
import {
  loadPlayerProfile,
  mergeServerPlayerProfile,
  playerIdentityPayload,
  PLAYER_EMBLEMS,
  validateNickname,
} from '../services/player-profile.js';
import { createRemoteBattleSession } from './remote-battle-session.js';

const CONNECTING_TEXT = '正在连接决斗阵盘…';
const RESUME_STORAGE_KEY = 'qyj.online.resume-token.v1';
const PRESERVED_SCREENS = new Set(['room', 'pick', 'battle', 'result']);

function resolveStorage(override) {
  if (override) return override;
  try { return globalThis.sessionStorage || null; } catch { return null; }
}

function readResumeToken(storage) {
  try { return storage?.getItem(RESUME_STORAGE_KEY) || ''; } catch { return ''; }
}

function writeResumeToken(storage, token) {
  try {
    if (token) storage?.setItem(RESUME_STORAGE_KEY, token);
    else storage?.removeItem(RESUME_STORAGE_KEY);
  } catch {
    // Privacy mode can deny storage. The current in-memory session still works.
  }
}

function resultRanking(rows = []) {
  return rows.map((row) => ({
    idx: row.seat,
    hero: getHero(row.heroId) || HEROES[0],
    playerName: row.name,
    hp: row.hp,
    alive: row.alive,
    deathRound: row.deathRound,
  }));
}

export class OnlineSession {
  constructor({
    url = resolveWebSocketUrl(),
    WebSocketImpl = globalThis.WebSocket,
    clientFactory = createWsClient,
    autoReconnect = true,
    retryDelays = [500, 1000, 2000, 5000],
    sessionStorage: storageOverride = null,
    playerProfile: playerProfileOverride = null,
  } = {}) {
    this.url = url;
    this.subscribers = new Set();
    this.revision = 0;
    this.noticeId = 0;
    this.lastNoticeKey = '';
    this.lastNoticeAt = 0;
    this.myName = '';
    this.battle = null;
    this.destroyed = false;
    this.autoReconnect = autoReconnect;
    this.retryDelays = [...retryDelays];
    this.retryAttempt = 0;
    this.reconnectTimer = null;
    this.transportOpen = false;
    this.everConnected = false;
    this.recovering = false;
    this.attemptedResumeToken = '';
    this.resumeNeedsAwait = false;
    this.tokenStorage = resolveStorage(storageOverride);
    this.resumeToken = readResumeToken(this.tokenStorage);
    this.playerProfile = playerProfileOverride || loadPlayerProfile();
    this.pendingPlayerProfile = null;
    this.profileUpdatePending = null;
    this.state = Object.freeze({
      revision: this.revision,
      screen: 'connecting',
      data: { text: CONNECTING_TEXT },
      connection: 'connecting',
      error: null,
      notice: null,
      battle: null,
      recovering: false,
      writeBlocked: true,
      resumeGraceMs: 0,
      player: this.playerProfile,
      profileSync: 'local',
    });
    this.client = clientFactory(url, { WebSocketImpl });
    this.unsubscribeClient = this.client.subscribe((event) => this.handleClientEvent(event));
    this.onBrowserOffline = () => {
      if (this.destroyed) return;
      this.transportOpen = false;
      this.client.close();
      this.scheduleReconnect('网络已离线');
    };
    this.onBrowserOnline = () => {
      if (this.destroyed || !this.state.writeBlocked) return;
      this.reconnect();
    };
    try {
      globalThis.addEventListener?.('offline', this.onBrowserOffline);
      globalThis.addEventListener?.('online', this.onBrowserOnline);
    } catch { /* non-browser runtime */ }
    this.client.connect();
  }

  getState() { return this.state; }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this.subscribers.add(listener);
    listener(this.state);
    return () => this.subscribers.delete(listener);
  }

  publish(patch) {
    if (this.destroyed) return;
    this.revision++;
    this.state = Object.freeze({
      ...this.state,
      ...patch,
      revision: this.revision,
      battle: patch.battle === undefined ? this.battle : patch.battle,
    });
    for (const listener of [...this.subscribers]) {
      try { listener(this.state); } catch { /* isolate views */ }
    }
  }

  pushNotice(message, { kind = 'info', key = String(message || '') } = {}) {
    const text = String(message || '');
    if (!text) return false;
    const now = Date.now();
    if (key === this.lastNoticeKey && now - this.lastNoticeAt < 1500) return false;
    this.lastNoticeKey = key;
    this.lastNoticeAt = now;
    this.noticeId++;
    this.publish({ notice: { id: this.noticeId, message: text, kind } });
    return true;
  }

  showConnecting(text = CONNECTING_TEXT, patch = {}) {
    this.publish({
      screen: 'connecting',
      data: { text },
      error: null,
      writeBlocked: true,
      ...patch,
    });
  }

  handleClientEvent(event) {
    if (this.destroyed) return;
    if (event.type === 'open') {
      this.clearReconnectTimer();
      this.transportOpen = true;
      this.attemptedResumeToken = this.resumeToken;
      const wantsResume = Boolean(this.attemptedResumeToken);
      this.recovering = wantsResume;
      this.publish({
        connection: wantsResume ? 'reconnecting' : 'connecting',
        error: null,
        recovering: wantsResume,
        writeBlocked: true,
        profileSync: 'syncing',
      });
      if (wantsResume) {
        this.sendObject({ cmd: 'resume', resumeToken: this.attemptedResumeToken });
      } else {
        this.sendObject({ cmd: 'lobby' });
      }
      return;
    }
    if (event.type === 'message') {
      const message = parseServerMessage(event.data);
      if (message) this.handleMessage(message);
      return;
    }
    if (event.type === 'error') {
      this.transportOpen = false;
      this.scheduleReconnect('无法连接对战服务器');
      return;
    }
    if (event.type === 'close' && !event.intentional) {
      this.transportOpen = false;
      this.scheduleReconnect('与服务器断开连接');
    }
  }

  clearReconnectTimer() {
    if (this.reconnectTimer != null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  reconnectPatch(text, connection = 'reconnecting') {
    const patch = {
      connection,
      error: text,
      recovering: true,
      writeBlocked: true,
    };
    if (!PRESERVED_SCREENS.has(this.state.screen) && this.state.screen !== 'lobby') {
      patch.screen = 'connecting';
      patch.data = { text };
    }
    return patch;
  }

  scheduleReconnect(errorText) {
    if (this.destroyed || this.reconnectTimer != null) return;
    this.recovering = true;
    if (!this.autoReconnect || this.retryAttempt >= this.retryDelays.length) {
      this.publish(this.reconnectPatch(errorText, 'error'));
      return;
    }
    const delay = this.retryDelays[this.retryAttempt++];
    this.publish(this.reconnectPatch(
      `${errorText}，${Math.max(1, Math.ceil(delay / 1000))} 秒后重试…`,
    ));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.destroyed) return;
      this.publish(this.reconnectPatch('正在重新连接决斗阵盘…'));
      if (typeof this.client.reconnect === 'function') this.client.reconnect();
      else {
        this.client.close();
        this.client.connect();
      }
    }, delay);
  }

  reconnect() {
    if (this.destroyed) return false;
    this.clearReconnectTimer();
    this.retryAttempt = 0;
    this.recovering = true;
    this.publish(this.reconnectPatch('正在重新连接决斗阵盘…'));
    if (typeof this.client.reconnect === 'function') this.client.reconnect();
    else {
      this.client.close();
      this.client.connect();
    }
    return true;
  }

  markConnected({ recovered = false } = {}) {
    this.clearReconnectTimer();
    this.retryAttempt = 0;
    this.recovering = false;
    this.resumeNeedsAwait = false;
    this.everConnected = true;
    this.publish({
      connection: 'open',
      error: null,
      recovering: false,
      writeBlocked: false,
    });
    if (recovered) this.pushNotice('已恢复至最新进度', { kind: 'success', key: 'session-restored' });
  }

  handleSession(data) {
    const attemptedResume = Boolean(this.attemptedResumeToken);
    const nextToken = typeof data.resumeToken === 'string' ? data.resumeToken : '';
    if (nextToken) {
      this.resumeToken = nextToken;
      writeResumeToken(this.tokenStorage, nextToken);
    } else if (!data.resumed && attemptedResume) {
      this.resumeToken = '';
      writeResumeToken(this.tokenStorage, '');
    }
    const resumeGraceMs = Number(data.resumeGraceMs) || 0;
    this.publish({ resumeGraceMs });
    this.attemptedResumeToken = '';
    this.identifyPlayer();

    if (data.resumed) {
      this.recovering = true;
      this.publish({
        connection: 'reconnecting',
        error: null,
        recovering: true,
        writeBlocked: true,
      });
      return;
    }

    if (attemptedResume) {
      this.recovering = false;
      this.battle?.destroy();
      this.battle = null;
      this.showConnecting('原会话已过期，正在返回联机大厅…', {
        connection: 'open',
        battle: null,
        recovering: false,
        writeBlocked: false,
        resumeGraceMs,
      });
      this.pushNotice('原会话已过期，已返回联机大厅', {
        kind: 'warning', key: 'session-expired',
      });
      this.sendObject({ cmd: 'lobby' });
      return;
    }

    this.markConnected();
  }

  handleResumeResult(data) {
    const ranking = resultRanking(Array.isArray(data.ranking) ? data.ranking : []);
    const mySeat = Number(data.mySeat) || 1;
    this.publish({ screen: 'result', data: { ranking, mySeat }, error: null });
    this.markConnected({ recovered: true });
  }

  handleMessage(message) {
    const { ev } = message;
    const data = message.a || {};
    if (ev === 'session') {
      this.handleSession(data);
      return;
    }
    if (ev === 'playerProfile') {
      this.applyPlayerProfile(data.profile || data.player || data, Boolean(data.saved));
      return;
    }
    if (ev === 'resumeResult') {
      this.handleResumeResult(data);
      return;
    }

    // Backward-compatible promotion for servers that send screen state before
    // the session envelope on a brand-new connection.
    if (!this.everConnected && !this.recovering && this.state.connection !== 'open') {
      this.markConnected();
    }

    if (ev === 'lobby') {
      if (data.player) this.applyPlayerProfile(data.player, false);
      this.myName = data.yourName || this.myName;
      if (this.state.screen === 'connecting' || this.state.screen === 'lobby' || this.recovering) {
        this.battle?.destroy();
        this.battle = null;
        const recovered = this.recovering;
        const shouldUnblock = this.state.writeBlocked && this.transportOpen;
        this.publish({ screen: 'lobby', data, battle: null, error: null });
        if (recovered) this.markConnected({ recovered: true });
        else if (shouldUnblock) this.markConnected();
      }
      return;
    }
    if (ev === 'team') {
      if (data.player) this.applyPlayerProfile(data.player, false);
      this.myName = data.yourName || this.myName;
      if (this.state.screen === 'pick') {
        this.publish({
          screen: 'pick',
          data: { ...this.state.data, members: data.members || [], room: data },
          error: null,
        });
        return;
      }
      if (this.state.screen !== 'battle' && this.state.screen !== 'result') {
        const recovered = this.recovering;
        const shouldUnblock = this.state.writeBlocked && this.transportOpen;
        this.publish({ screen: 'room', data, error: null });
        if (recovered && data.phase !== 'picking') this.markConnected({ recovered: true });
        else if (!recovered && shouldUnblock) this.markConnected();
      }
      return;
    }
    if (ev === 'pick') {
      if (this.state.screen === 'room' || this.state.screen === 'pick' || this.recovering) {
        const recovered = this.recovering;
        const members = this.state.data?.members || this.state.data?.room?.members;
        this.publish({
          screen: 'pick',
          data: members ? { ...data, members } : data,
          error: null,
        });
        if (recovered) this.markConnected({ recovered: true });
      }
      return;
    }
    if (ev === 'gameStart') {
      if (this.recovering && this.battle) {
        this.battle.rawEngine.myIdx = data.mySeat ?? this.battle.rawEngine.myIdx;
      } else {
        this.battle?.destroy();
        this.battle = createRemoteBattleSession(data, (command) => this.sendBattleCommand(command));
      }
      this.publish({ screen: 'battle', data, battle: this.battle, error: null });
      return;
    }
    if (ev === 'toast') {
      this.pushNotice(data.msg, { kind: 'info', key: String(data.msg || '') });
      return;
    }
    if (ev === 'error') {
      const messageText = String(data.message || '服务器拒绝了本次操作');
      const profileError = [
        'INVALID_PROFILE', 'INVALID_NAME', 'INVALID_EMBLEM', 'INVALID_FIELD',
        'PLAYER_NOT_IDENTIFIED', 'PLAYER_ALREADY_IDENTIFIED',
      ].includes(data.code);
      if (profileError) {
        this.pendingPlayerProfile = null;
        this.settleProfileUpdate({
          ok: false,
          saved: false,
          error: { code: data.code || 'INVALID_PROFILE', message: messageText },
        });
      }
      this.publish({
        error: { code: data.code || 'SERVER_ERROR', message: messageText },
        ...(profileError ? { profileSync: 'error' } : {}),
      });
      this.pushNotice(messageText, { kind: 'error', key: messageText });
      return;
    }
    if (this.battle && this.state.screen === 'battle') {
      this.battle.onMessage(message);
      if (this.recovering && ev === 'sync') {
        this.resumeNeedsAwait = this.battle.waitingIdx === this.battle.rawEngine.myIdx;
      } else if (this.recovering && ev === 'hole' && !this.resumeNeedsAwait) {
        this.markConnected({ recovered: true });
      } else if (this.recovering && ev === 'onAwaitAction') {
        this.markConnected({ recovered: true });
      }
      if (ev === 'onGameOver') {
        const activeBattle = this.battle;
        const ranking = activeBattle.lastRanking || [];
        const mySeat = activeBattle.rawEngine.myIdx;
        activeBattle.delay(2, () => {
          if (this.battle !== activeBattle || this.destroyed) return;
          this.publish({ screen: 'result', data: { ranking, mySeat } });
        });
      }
    }
  }

  sendObject(command) { return this.client.send(command); }

  identifyPlayer() {
    if (!this.transportOpen || !this.playerProfile?.guestId) return false;
    return this.sendObject({
      cmd: 'identify',
      ...playerIdentityPayload(this.playerProfile),
    });
  }

  applyPlayerProfile(serverProfile, saved = false) {
    if (!serverProfile || typeof serverProfile !== 'object') return false;
    this.playerProfile = mergeServerPlayerProfile(this.playerProfile, serverProfile);
    this.pendingPlayerProfile = null;
    this.myName = this.playerProfile.nickname || this.myName;
    const currentData = this.state.data && typeof this.state.data === 'object'
      ? { ...this.state.data, player: this.playerProfile }
      : this.state.data;
    this.publish({
      player: this.playerProfile,
      profileSync: 'synced',
      data: currentData,
      error: null,
    });
    if (saved) {
      this.settleProfileUpdate({ ok: true, saved: true, profile: this.playerProfile });
      this.pushNotice('玩家资料已保存', { kind: 'success', key: 'player-profile-saved' });
    }
    return true;
  }

  settleProfileUpdate(result) {
    const pending = this.profileUpdatePending;
    if (!pending) return false;
    this.profileUpdatePending = null;
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(result);
    return true;
  }

  updatePlayerProfile(next = {}) {
    if (this.state.writeBlocked || this.state.connection !== 'open') {
      return Promise.resolve({
        ok: false,
        saved: false,
        error: { code: 'OFFLINE', message: '连接恢复后才能保存玩家资料' },
      });
    }
    const checked = validateNickname(next.nickname ?? this.playerProfile.nickname);
    if (!checked.ok) {
      this.pushNotice(checked.reason, { kind: 'error', key: checked.reason });
      return Promise.resolve({
        ok: false,
        saved: false,
        error: { code: 'INVALID_NAME', message: checked.reason },
      });
    }
    const emblem = String(next.emblem ?? this.playerProfile.emblem);
    if (!PLAYER_EMBLEMS.includes(emblem)) {
      this.pushNotice('请选择有效纹章', { kind: 'error', key: 'invalid-emblem' });
      return Promise.resolve({
        ok: false,
        saved: false,
        error: { code: 'INVALID_EMBLEM', message: '请选择有效纹章' },
      });
    }
    this.settleProfileUpdate({
      ok: false,
      saved: false,
      error: { code: 'SUPERSEDED', message: '已提交新的资料修改' },
    });
    this.pendingPlayerProfile = { nickname: checked.nickname, emblem };
    this.publish({ profileSync: 'saving', error: null });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.profileUpdatePending?.resolve !== resolve) return;
        this.profileUpdatePending = null;
        this.pendingPlayerProfile = null;
        this.publish({ profileSync: 'error' });
        resolve({
          ok: false,
          saved: false,
          error: { code: 'PROFILE_SAVE_TIMEOUT', message: '保存超时，请重试' },
        });
      }, 8_000);
      timer.unref?.();
      this.profileUpdatePending = { resolve, timer };
      const sent = this.sendObject({
        cmd: 'updateProfile',
        nickname: checked.nickname,
        emblem,
      });
      if (!sent) {
        this.pendingPlayerProfile = null;
        this.publish({ profileSync: 'error' });
        this.settleProfileUpdate({
          ok: false,
          saved: false,
          error: { code: 'SEND_FAILED', message: '资料未能发送，请重试' },
        });
      }
    });
  }

  sendBattleCommand(command) {
    if (this.state.writeBlocked || this.state.connection !== 'open') return false;
    return this.sendObject(command);
  }

  send(cmd, payload = {}) {
    if (this.state.writeBlocked || this.state.connection !== 'open') return false;
    return this.sendObject(makeCommand(cmd, payload));
  }
  createTeam() { return this.send('create'); }
  refreshLobby() { return this.send('lobby'); }
  joinTeam(teamId) { return this.send('join', { teamId: Number(teamId) }); }
  rename(name) { return this.send('rename', { name: String(name || '').trim() }); }
  leaveTeam() {
    if (this.state.writeBlocked || this.state.connection !== 'open') return false;
    this.showConnecting('正在退出队伍…');
    return this.sendObject({ cmd: 'leave' });
  }
  startPick() { return this.send('startPick'); }
  pickHero(heroId) { return this.send('pick', { heroId }); }
  startGame() { return this.send('startGame'); }
  backToRoom() {
    if (this.state.writeBlocked || this.state.connection !== 'open') return false;
    this.battle?.destroy();
    this.battle = null;
    this.showConnecting('正在返回队伍房间…', { battle: null });
    return this.sendObject({ cmd: 'backToRoom' });
  }

  tick(dt) {
    if (this.state.screen === 'battle') this.battle?.update(dt);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearReconnectTimer();
    this.settleProfileUpdate({
      ok: false,
      saved: false,
      error: { code: 'SESSION_CLOSED', message: '会话已关闭' },
    });
    this.battle?.destroy();
    this.unsubscribeClient?.();
    try {
      globalThis.removeEventListener?.('offline', this.onBrowserOffline);
      globalThis.removeEventListener?.('online', this.onBrowserOnline);
    } catch { /* non-browser runtime */ }
    this.client.close();
    this.revision++;
    this.state = Object.freeze({
      ...this.state,
      revision: this.revision,
      screen: 'closed',
      connection: 'closed',
      recovering: false,
      writeBlocked: true,
      battle: null,
    });
    for (const listener of [...this.subscribers]) {
      try { listener(this.state); } catch { /* isolate views */ }
    }
    this.subscribers.clear();
  }
}

export function createOnlineSession(options) {
  return new OnlineSession(options);
}
