import { HEROES, getHero } from '../game/heroes.js';
import { makeCommand, parseServerMessage, resolveWebSocketUrl } from '../net/protocol.js';
import { createWsClient } from '../net/ws-client.js';
import {
  DEFAULT_PLAYER_NICKNAME,
  loadPlayerProfile,
  mergeServerPlayerProfile,
  PLAYER_EMBLEMS,
  validateNickname,
} from '../services/player-profile.js';
import {
  createAccountClient,
  consumeResetTokenFromLocation,
} from '../services/account-client.js';
import { createRemoteBattleSession } from './remote-battle-session.js';

const CONNECTING_TEXT = '正在连接决斗阵盘…';
const RESUME_STORAGE_KEY = 'qyj.online.resume-token.v1';
const PRESERVED_SCREENS = new Set(['room', 'pick', 'battle', 'result']);
const CLIENT_PROTOCOL_VERSION = 3;
const TABLE_SIZE_9_CAPABILITY = 'table-size-9';
const SUPPORTED_TABLE_SIZE_SET = new Set([6, 9]);

function resolveTableSize(value, players = []) {
  const explicit = Number(value);
  if (SUPPORTED_TABLE_SIZE_SET.has(explicit)) return explicit;
  const inferred = Array.isArray(players) ? players.length : 0;
  return SUPPORTED_TABLE_SIZE_SET.has(inferred) ? inferred : 6;
}

function authoritativeGameStart(data, profile) {
  const mySeat = Number(data?.mySeat);
  const ownName = typeof profile?.nickname === 'string' ? profile.nickname.trim() : '';
  const players = Array.isArray(data?.players)
    ? data.players.map((player) => {
      if (Number(player?.seat) !== mySeat || !ownName) return player;
      return {
        ...player,
        name: ownName,
        ...(profile.playerId ? { playerId: profile.playerId } : {}),
        ...(profile.shortId ? { shortId: profile.shortId } : {}),
        ...(profile.emblem ? { emblem: profile.emblem } : {}),
        ...(profile.pokerStats ? { pokerStats: profile.pokerStats } : {}),
      };
    })
    : data?.players;
  return { ...data, players };
}

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
    accountClient: accountClientOverride = null,
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
    this.accountClient = accountClientOverride || createAccountClient({ wsUrl: url });
    this.account = null;
    this.authenticated = false;
    this.authPending = false;
    this.initialResetToken = consumeResetTokenFromLocation();
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
      serverProtocolVersion: 1,
      supportedTableSizes: [6],
      player: this.playerProfile,
      account: null,
      authenticated: false,
      authPending: false,
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
        this.sendObject({ cmd: 'hello' });
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
    const authenticated = data.authenticated === true;
    if (authenticated && nextToken) {
      this.resumeToken = nextToken;
      writeResumeToken(this.tokenStorage, nextToken);
    } else if (!authenticated || (!data.resumed && attemptedResume)) {
      this.resumeToken = '';
      writeResumeToken(this.tokenStorage, '');
    }
    const resumeGraceMs = Number(data.resumeGraceMs) || 0;
    const supportedTableSizes = Array.isArray(data.supportedTableSizes)
      ? [...new Set(data.supportedTableSizes.map(Number).filter((size) =>
        SUPPORTED_TABLE_SIZE_SET.has(size)))]
      : [6];
    this.publish({
      resumeGraceMs,
      serverProtocolVersion: Number(data.protocolVersion) || 1,
      supportedTableSizes: supportedTableSizes.length ? supportedTableSizes : [6],
    });
    this.attemptedResumeToken = '';
    if (this.initialResetToken) {
      this.authenticated = authenticated;
      this.account = authenticated && data.account && typeof data.account === 'object'
        ? { ...data.account }
        : null;
      if (authenticated && data.profile) this.applyPlayerProfile(data.profile, false);
      this.recovering = false;
      this.publish({
        screen: 'auth',
        data: { authView: 'reset-confirm', resetToken: this.initialResetToken },
        account: this.account,
        authenticated,
        authPending: false,
        connection: 'open',
        error: null,
        recovering: false,
        writeBlocked: false,
      });
      this.initialResetToken = '';
      return;
    }
    if (!authenticated) {
      this.authenticated = false;
      this.account = null;
      this.recovering = false;
      this.battle?.destroy();
      this.battle = null;
      this.publish({
        screen: 'auth',
        data: {
          authView: this.initialResetToken ? 'reset-confirm' : 'login',
          resetToken: this.initialResetToken,
        },
        account: null,
        authenticated: false,
        authPending: false,
        connection: 'open',
        error: null,
        recovering: false,
        writeBlocked: false,
        battle: null,
      });
      this.initialResetToken = '';
      return;
    }

    this.authenticated = true;
    this.account = data.account && typeof data.account === 'object' ? { ...data.account } : null;
    if (data.profile) this.applyPlayerProfile(data.profile, false);
    this.publish({
      account: this.account,
      authenticated: true,
      authPending: false,
      error: null,
    });

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
    const tableSize = resolveTableSize(data.tableSize, data.ranking);
    this.publish({ screen: 'result', data: { ranking, mySeat, tableSize }, error: null });
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
      const startData = authoritativeGameStart({
        ...data,
        tableSize: resolveTableSize(data.tableSize, data.players),
      }, this.playerProfile);
      const currentEngine = this.battle?.rawEngine;
      const currentTableSize = currentEngine
        ? resolveTableSize(currentEngine.tableSize, currentEngine.players?.slice(1))
        : 0;
      const sameSeats = Array.isArray(startData.players)
        && startData.players.length === startData.tableSize
        && startData.players.every((player) => {
          const current = currentEngine?.players?.[player.seat];
          return current && current.hero?.id === player.heroId;
        });
      if (this.recovering && this.battle
        && currentTableSize === startData.tableSize && sameSeats) {
        this.battle.rawEngine.myIdx = startData.mySeat ?? this.battle.rawEngine.myIdx;
        this.battle.rawEngine.tableSize = startData.tableSize;
        this.battle.rawEngine.applyRoster?.(startData.players);
      } else {
        this.battle?.destroy();
        this.battle = createRemoteBattleSession(
          startData,
          (command) => this.sendBattleCommand(command),
        );
      }
      this.publish({ screen: 'battle', data: startData, battle: this.battle, error: null });
      return;
    }
    if (ev === 'toast') {
      this.pushNotice(data.msg, { kind: 'info', key: String(data.msg || '') });
      return;
    }
    if (ev === 'error') {
      const messageText = String(data.message || '服务器拒绝了本次操作');
      if (['AUTH_REQUIRED', 'AUTH_SESSION_INVALID'].includes(data.code)) {
        this.resumeToken = '';
        writeResumeToken(this.tokenStorage, '');
        this.authenticated = false;
        this.account = null;
        this.publish({
          screen: 'auth',
          data: { authView: 'login' },
          authenticated: false,
          account: null,
          authPending: false,
          connection: 'open',
          error: { code: data.code, message: messageText },
          writeBlocked: false,
        });
        return;
      }
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
        const tableSize = resolveTableSize(
          activeBattle.rawEngine.tableSize || this.state.data?.tableSize,
          activeBattle.rawEngine.players?.slice(1),
        );
        activeBattle.delay(2, () => {
          if (this.battle !== activeBattle || this.destroyed) return;
          this.publish({ screen: 'result', data: { ranking, mySeat, tableSize } });
        });
      }
    }
  }

  sendObject(command) {
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      return this.client.send(command);
    }
    return this.client.send({
      ...command,
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      capabilities: [TABLE_SIZE_9_CAPABILITY],
    });
  }

  applyPlayerProfile(serverProfile, saved = false) {
    if (!serverProfile || typeof serverProfile !== 'object') return false;
    this.playerProfile = mergeServerPlayerProfile(this.playerProfile, serverProfile);
    this.pendingPlayerProfile = null;
    this.myName = this.playerProfile.nickname || this.myName;
    const activeEngine = this.battle?.rawEngine;
    const activePlayer = activeEngine?.players?.[activeEngine.myIdx];
    if (activePlayer) {
      activePlayer.playerName = this.playerProfile.nickname || activePlayer.playerName;
      activePlayer.playerId = this.playerProfile.playerId || activePlayer.playerId;
      activePlayer.shortId = this.playerProfile.shortId || activePlayer.shortId;
      activePlayer.emblem = this.playerProfile.emblem || activePlayer.emblem;
      activePlayer.pokerStats = this.playerProfile.pokerStats || activePlayer.pokerStats;
    }
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

  selectAuthView(view = 'login', patch = {}) {
    const allowed = new Set(['login', 'register', 'reset-request', 'reset-confirm']);
    const authView = allowed.has(view) ? view : 'login';
    const currentData = this.state.screen === 'auth' && this.state.data
      && typeof this.state.data === 'object' ? this.state.data : {};
    this.publish({
      screen: 'auth',
      data: { ...currentData, ...patch, authView },
      authPending: false,
      error: null,
      writeBlocked: false,
    });
    return true;
  }

  publishAuthFailure(result, fallbackMessage) {
    const error = result?.error && typeof result.error === 'object'
      ? result.error
      : { code: 'AUTH_FAILED', message: result?.message || fallbackMessage };
    this.authPending = false;
    this.publish({ authPending: false, error, writeBlocked: false });
    return { ok: false, error };
  }

  reconnectAfterAuthentication(message) {
    this.resumeToken = '';
    writeResumeToken(this.tokenStorage, '');
    this.authPending = false;
    this.authenticated = false;
    this.account = null;
    this.showConnecting(message, {
      authenticated: false,
      account: null,
      authPending: false,
      connection: 'connecting',
      recovering: false,
      writeBlocked: true,
    });
    if (typeof this.client.reconnect === 'function') this.client.reconnect();
    else {
      this.client.close?.();
      this.client.connect?.();
    }
  }

  async loginAccount({ identifier, password } = {}) {
    if (this.authPending) return { ok: false, error: { code: 'AUTH_PENDING', message: '正在提交，请稍候' } };
    this.authPending = true;
    this.publish({ authPending: true, error: null });
    const result = await this.accountClient.login({ identifier, password });
    if (!result?.ok) return this.publishAuthFailure(result, '登录失败，请检查账号和密码');
    this.reconnectAfterAuthentication('登录成功，正在进入联机大厅…');
    return result;
  }

  async registerAccount({ username, email, password } = {}) {
    if (this.authPending) return { ok: false, error: { code: 'AUTH_PENDING', message: '正在提交，请稍候' } };
    this.authPending = true;
    this.publish({ authPending: true, error: null });
    const localNickname = this.playerProfile?.nickname;
    const result = await this.accountClient.register({
      username,
      email,
      password,
      guestId: this.playerProfile?.guestId,
      ...(localNickname && localNickname !== DEFAULT_PLAYER_NICKNAME
        ? { nickname: localNickname }
        : {}),
      emblem: this.playerProfile?.emblem,
    });
    if (!result?.ok) return this.publishAuthFailure(result, '注册失败，请检查填写内容');
    this.reconnectAfterAuthentication('注册成功，正在创建玩家档案…');
    return result;
  }

  async requestPasswordReset({ email } = {}) {
    if (this.authPending) return { ok: false, error: { code: 'AUTH_PENDING', message: '正在提交，请稍候' } };
    this.authPending = true;
    this.publish({ authPending: true, error: null });
    const result = await this.accountClient.requestPasswordReset({ email });
    if (!result?.ok) return this.publishAuthFailure(result, '暂时无法发送重置邮件');
    this.authPending = false;
    this.selectAuthView('reset-confirm', {
      resetEmail: String(email || '').trim(),
      authStatus: result.data?.message || '如果该邮箱已注册，重置邮件已经发送。',
    });
    return result;
  }

  async confirmPasswordReset({ token, newPassword } = {}) {
    if (this.authPending) return { ok: false, error: { code: 'AUTH_PENDING', message: '正在提交，请稍候' } };
    this.authPending = true;
    this.publish({ authPending: true, error: null });
    const result = await this.accountClient.confirmPasswordReset({ token, newPassword });
    if (!result?.ok) return this.publishAuthFailure(result, '重置链接无效或已过期');
    this.authPending = false;
    this.selectAuthView('login', {
      resetToken: '',
      authStatus: result.data?.message || '密码已重置，请使用新密码登录。',
    });
    return result;
  }

  async logoutAccount() {
    if (this.authPending) return false;
    this.authPending = true;
    this.publish({ authPending: true, error: null, writeBlocked: true });
    const result = await this.accountClient.logout();
    if (!result?.ok) {
      this.publishAuthFailure(result, '退出登录失败，请稍后重试');
      return false;
    }
    this.battle?.destroy();
    this.battle = null;
    this.reconnectAfterAuthentication('已退出登录，正在返回账号入口…');
    return true;
  }

  getHandHistory(options = {}) {
    if (!this.state.authenticated) {
      return Promise.resolve({
        ok: false,
        data: null,
        error: { code: 'AUTH_REQUIRED', message: '请先登录联机账号' },
      });
    }
    return this.accountClient.getHandHistory(options);
  }

  updatePlayerProfile(next = {}) {
    if (!this.state.authenticated || this.state.writeBlocked || this.state.connection !== 'open') {
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
    if (!this.state.authenticated || this.state.writeBlocked || this.state.connection !== 'open') return false;
    return this.sendObject(command);
  }

  send(cmd, payload = {}) {
    if (!this.state.authenticated || this.state.writeBlocked || this.state.connection !== 'open') return false;
    return this.sendObject(makeCommand(cmd, payload));
  }
  createTeam(tableSize = 6) {
    const normalized = Number(tableSize);
    if (!SUPPORTED_TABLE_SIZE_SET.has(normalized)) return false;
    if (!this.state.supportedTableSizes.includes(normalized)) {
      this.pushNotice('当前服务端暂不支持该桌型', {
        kind: 'warning', key: `unsupported-table-size-${normalized}`,
      });
      return false;
    }
    return this.send('create', { tableSize: normalized });
  }
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
