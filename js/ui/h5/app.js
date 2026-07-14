import { HEROES, getHero } from '../../game/heroes.js';
import { createOnlineSession } from '../../session/online-session.js';
import { loadPlayerProfile, validateNickname, PLAYER_EMBLEMS } from '../../services/player-profile.js';
import { h5HeroPortrait } from '../../services/asset-variants.js';
import { button, clear, element, trapEscape } from '../shared/dom.js';
import { createHandHistoryPanel } from '../shared/hand-history.js';
import { createH5AuthView } from './auth-view.js';
import { mountH5Battle } from './battle-view.js';

const PHASE_LABELS = Object.freeze({ lobby: '待命', picking: '选将中', game: '对局中', battle: '对局中' });

function onlineTableSize(value) {
  const size = Number(value?.tableSize || value?.totalPlayers || value?.maxMembers);
  return size === 9 ? 9 : 6;
}

const POKER_CORE_STATS = Object.freeze([
  { key: 'vpip', label: 'VPIP', name: '主动入池率', description: '翻牌前主动投入筹码进入牌局的比例。', percent: true },
  { key: 'pfr', label: 'PFR', name: '翻前加注率', description: '翻牌前主动加注或再加注的比例。', percent: true },
  { key: 'threeBet', label: '3Bet', name: '翻前再加注率', description: '面对已有加注时再次加注的比例。', percent: true },
  { key: 'af', label: 'AF', name: '激进系数', description: '下注与加注次数相对跟注次数的比值。' },
  { key: 'hands', label: '手数', name: '统计手数', description: '当前统计样本包含的有效牌局手数。', integer: true },
]);

const POKER_DETAIL_STATS = Object.freeze([
  { key: 'wtsd', label: 'WTSD', name: '入池后摊牌率', description: '看到翻牌后继续打到摊牌的比例。', percent: true },
  { key: 'wsd', label: 'W$SD', name: '摊牌胜率', description: '进入摊牌后赢得底池的比例。', percent: true },
  { key: 'cbet', label: 'CBet', name: '持续下注率', description: '翻前进攻者在翻牌后继续下注的比例。', percent: true },
  { key: 'foldToCbet', label: 'Fold CBet', name: '面对持续下注弃牌率', description: '面对对手持续下注时选择弃牌的比例。', percent: true },
]);

const POKER_NUMERIC_KEYS = Object.freeze([
  'vpip', 'pfr', 'threeBet', 'af', 'wtsd', 'wsd', 'cbet', 'foldToCbet',
]);

function pokerMetricValue(value, { percent = false, integer = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (integer) return Math.max(0, Math.round(number));
  if (percent) return Math.max(0, Math.min(100, number));
  return Math.max(0, number);
}

function normalizePokerStats(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const hands = pokerMetricValue(source.hands, { integer: true }) ?? 0;
  const metrics = Object.fromEntries(POKER_NUMERIC_KEYS.map((key) => [
    key,
    pokerMetricValue(source[key], { percent: key !== 'af' }),
  ]));
  const available = hands > 0 || Object.values(metrics).some((value) => value !== null);
  const confidenceKey = available
    ? String(source.confidence || (hands >= 100 ? 'high' : hands >= 30 ? 'medium' : 'low')).toLowerCase()
    : 'none';
  const confidence = ({
    high: { label: '高可信度', tone: 'high' },
    medium: { label: '中可信度', tone: 'medium' },
    low: { label: '低可信度', tone: 'low' },
    none: { label: '暂无样本', tone: 'none' },
  })[confidenceKey] || { label: '低可信度', tone: 'low' };
  const windowDays = pokerMetricValue(source.windowDays, { integer: true }) || 30;
  const maxHands = pokerMetricValue(source.maxHands, { integer: true }) || 200;
  return {
    ...metrics,
    hands,
    available,
    confidence,
    rangeLabel: String(source.rangeLabel || `近${windowDays}天 · 最近${maxHands}手`),
  };
}

function pokerTestKey(key) {
  if (key === 'threeBet') return 'threebet';
  if (key === 'foldToCbet') return 'fold-to-cbet';
  return key.toLowerCase();
}

function pokerValue(stats, definition) {
  const value = definition.key === 'hands' ? stats.hands : stats[definition.key];
  if (definition.key === 'hands') return stats.available ? String(value) : '—';
  if (value === null || value === undefined) return '—';
  if (definition.percent) {
    return `${Number(value).toFixed(value >= 10 || Number.isInteger(value) ? 0 : 1)}%`;
  }
  return Number(value).toFixed(Number.isInteger(value) ? 0 : 1);
}

function pokerMetric(stats, definition, prefix, detailed = false) {
  return element('div', {
    className: `h5-poker-metric${detailed ? ' is-detailed' : ''}`,
    attrs: {
      title: `${definition.name}：${definition.description}`,
      'data-testid': `${prefix}-${pokerTestKey(definition.key)}`,
    },
  }, [
    element('span', { className: 'h5-poker-metric__label', text: definition.label }),
    element('strong', { text: pokerValue(stats, definition) }),
    element('small', { text: detailed ? `${definition.name} · ${definition.description}` : definition.name }),
  ]);
}

function playerStatsContent(subject, prefix = 'h5-player-stats') {
  const stats = normalizePokerStats(subject?.pokerStats);
  return [
    element('div', { className: 'h5-poker-summary' }, [
      element('div', {}, [
        element('span', { className: 'h5-poker-summary__eyebrow', text: 'POKER PROFILE' }),
        element('strong', { text: stats.rangeLabel }),
      ]),
      element('span', {
        className: `h5-poker-confidence is-${stats.confidence.tone}`,
        text: stats.confidence.label,
      }),
    ]),
    !stats.available && element('div', { className: 'h5-poker-empty' }, [
      element('strong', { text: '暂无扑克统计' }),
      element('span', { text: '本地 AI 或旧数据尚未形成可用样本。' }),
    ]),
    element('section', { className: 'h5-poker-section' }, [
      element('header', {}, [element('h3', { text: '核心数据' }), element('span', { text: '首屏概览' })]),
      element('div', { className: 'h5-poker-grid is-core' },
        POKER_CORE_STATS.map((definition) => pokerMetric(stats, definition, prefix))),
    ]),
    element('details', { className: 'h5-poker-details' }, [
      element('summary', { text: '查看详细指标与中文释义' }),
      element('div', { className: 'h5-poker-grid is-detail' },
        POKER_DETAIL_STATS.map((definition) => pokerMetric(stats, definition, prefix, true))),
    ]),
    element('p', {
      className: 'h5-poker-disclaimer',
      text: '以上数据仅描述历史频率，不代表当前手牌强弱，也不提供行动建议。',
    }),
  ];
}

function memberConnection(member) {
  const value = member?.connection || 'online';
  if (value === 'online' || value === 'open' || value === 'connected') return 'online';
  if (value === 'reconnecting') return 'reconnecting';
  return 'offline';
}

function memberConnectionLabel(member) {
  const value = memberConnection(member);
  if (value === 'online') return '在线';
  if (value === 'reconnecting') return '重连中';
  return '重连中 · 离线保留';
}

function header({
  title,
  subtitle = '',
  subtitleTestId = '',
  backLabel = '返回',
  onBack,
  status = '',
  statusTestId = '',
}) {
  return element('header', { className: 'h5-page-header' }, [
    onBack && button(backLabel, { className: 'h5-page-header__back', attrs: { 'data-testid': 'h5-back' }, on: { click: onBack } }),
    element('div', { className: 'h5-page-header__title' }, [
      element('strong', { text: title }),
      subtitle && element('span', {
        text: subtitle,
        attrs: subtitleTestId ? { 'data-testid': subtitleTestId } : {},
      }),
    ]),
    status && element('span', {
      className: 'h5-page-header__status',
      text: status,
      attrs: statusTestId ? { 'data-testid': statusTestId } : {},
    }),
  ]);
}

function dialog({
  title,
  message,
  confirmText = '确认',
  confirmTestId = 'h5-dialog-confirm',
  danger = false,
  showCancel = true,
  onConfirm,
  onClose,
}) {
  let releaseEscape;
  const close = () => {
    releaseEscape?.();
    layer.remove();
    onClose?.();
  };
  const cancel = showCancel
    ? button('取消', { className: 'h5-secondary-button', on: { click: close } })
    : null;
  const confirm = button(confirmText, {
    className: danger ? 'h5-danger-button' : 'h5-primary-button',
    attrs: { 'data-testid': confirmTestId },
    on: {
      click: async () => {
        confirm.disabled = true;
        const result = await onConfirm?.();
        if (result !== false) close();
        else confirm.disabled = false;
      },
    },
  });
  const panel = element('section', {
    className: 'h5-dialog',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
  }, [
    element('h2', { text: title }),
    typeof message === 'string' ? element('p', { text: message }) : message,
    element('div', { className: 'h5-dialog__actions' }, [cancel, confirm]),
  ]);
  const layer = element('div', { className: 'h5-dialog-layer' }, panel);
  layer.addEventListener('click', (event) => { if (event.target === layer) close(); });
  releaseEscape = trapEscape(panel, close);
  queueMicrotask(() => confirm.focus());
  return layer;
}

function toast(root, notice) {
  root.querySelector('[data-testid="h5-notice"]')?.remove();
  const item = element('div', {
    className: `h5-toast is-${notice.kind || 'info'}`,
    text: notice.message,
    attrs: { role: 'status', 'aria-live': 'polite', 'data-testid': 'h5-notice' },
  });
  root.appendChild(item);
  setTimeout(() => item.remove(), 2600);
}

export function classifyH5GameOutcome(ranking = [], myIdx = 1) {
  const rows = Array.isArray(ranking) ? ranking : [];
  const myRank = rows.findIndex((player) => Number(player?.idx) === Number(myIdx)) + 1;
  const myPlayer = myRank > 0 ? rows[myRank - 1] : null;
  const totalPlayers = rows.length;
  const outcome = myRank === 1 ? 'victory' : myRank > 1 ? 'defeat' : 'complete';
  const outcomeLabel = outcome === 'victory' ? '胜利' : outcome === 'defeat' ? '失败' : '对局结束';
  const outcomeEnglish = outcome === 'victory' ? 'VICTORY' : outcome === 'defeat' ? 'DEFEAT' : 'BATTLE COMPLETE';
  const podium = myRank > 0 && myRank <= 3;
  const resultMessage = outcome === 'victory'
    ? '你赢下本局，傲视群雄'
    : podium
      ? `本局落败，但以第 ${myRank} 名进入前三`
      : myRank > 0
        ? `本局落败，你以第 ${myRank} 名结束对局`
        : '本局排名数据暂不可用';
  return {
    myRank,
    myPlayer,
    totalPlayers,
    outcome,
    outcomeLabel,
    outcomeEnglish,
    podium,
    resultMessage,
  };
}

export function battleLeaveRequiresConfirmation(battle, mySeat = 1) {
  const player = battle?.engine?.players?.[Number(mySeat)];
  // An unknown snapshot stays on the safe path and still asks for confirmation.
  return player?.alive !== false;
}

export function requestOnlineBattleLeave({ root, battle, mySeat = 1, onlineSession } = {}) {
  if (!battleLeaveRequiresConfirmation(battle, mySeat)) {
    return onlineSession?.leaveBattle?.({ managed: false });
  }
  const layer = dialog({
    title: '离开当前牌局',
    message: '离开后将返回联机大厅。若你尚未阵亡，系统会在每次轮到你时立即执行默认操作（能静观则静观，否则退避），不会等待倒计时。之后可从大厅重新接管这局牌。',
    confirmText: '离开并托管',
    danger: true,
    onConfirm: () => onlineSession?.leaveBattle?.({ managed: true }),
  });
  root?.appendChild(layer);
  return layer;
}

export function mountH5App({ root }) {
  let current = 'boot';
  let currentView = null;
  let onlineSession = null;
  let onlineUnsubscribe = null;
  let onlineState = null;
  let lastOnlineData = null;
  let lastOnlineScreen = '';
  let lastOnlineBattle = null;
  let lastOnlineRevision = -1;
  let lastNoticeId = 0;
  let selectedHeroId = HEROES[0].id;
  let profile = loadPlayerProfile();
  let started = false;
  let releasePlayerStatsEscape = null;

  function closePlayerStats() {
    releasePlayerStatsEscape?.();
    releasePlayerStatsEscape = null;
    root.querySelector('.h5-player-stats-layer')?.remove();
  }

  function openPlayerStats(subject) {
    closePlayerStats();
    const displayName = subject?.nickname || subject?.name || '玩家';
    const number = subject?.shortId ? `#${subject.shortId}` : '公开统计';
    const closeButton = button('关闭', { className: 'h5-player-stats-panel__close' });
    const panel = element('section', {
      className: 'h5-player-stats-panel',
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'h5-player-stats-title',
        'data-testid': 'h5-player-stats-panel',
      },
    }, [
      element('header', { className: 'h5-player-stats-panel__header' }, [
        element('div', {}, [
          element('span', { text: `${subject?.emblem || '侠'} ${number}` }),
          element('h2', { text: `${displayName} · 扑克统计`, attrs: { id: 'h5-player-stats-title' } }),
        ]),
        closeButton,
      ]),
      element('div', { className: 'h5-player-stats-panel__body' }, playerStatsContent(subject)),
    ]);
    const layer = element('div', { className: 'h5-player-stats-layer' }, panel);
    const close = () => closePlayerStats();
    closeButton.addEventListener('click', close);
    layer.addEventListener('click', (event) => { if (event.target === layer) close(); });
    releasePlayerStatsEscape = trapEscape(panel, close);
    root.appendChild(layer);
    queueMicrotask(() => closeButton.focus());
  }

  function destroyView() {
    closePlayerStats();
    currentView?.destroy?.();
    currentView = null;
  }

  function stopOnline() {
    destroyView();
    onlineUnsubscribe?.();
    onlineUnsubscribe = null;
    onlineSession?.destroy?.();
    onlineSession = null;
    onlineState = null;
    lastOnlineData = null;
    lastOnlineScreen = '';
    lastOnlineBattle = null;
    lastOnlineRevision = -1;
    lastNoticeId = 0;
  }

  function renderReconnectOverlay() {
    root.querySelector('[data-testid="h5-reconnect-overlay"]')?.remove();
    const preserved = ['room', 'pick', 'battle', 'result', 'lobby'].includes(onlineState?.screen);
    if (!preserved || !onlineState?.writeBlocked) return;
    const failed = onlineState.connection === 'error';
    root.appendChild(element('div', {
      className: 'h5-reconnect-overlay',
      attrs: {
        role: 'dialog', 'aria-modal': 'true', 'aria-label': '连接恢复中',
        'data-testid': 'h5-reconnect-overlay',
      },
    }, element('section', { className: 'h5-reconnect-overlay__panel' }, [
      element('span', { className: 'h5-reconnect-overlay__mark', text: failed ? '!' : '↻' }),
      element('strong', { text: failed ? '连接恢复失败' : '正在恢复当前会话' }),
      element('p', { text: onlineState.error?.message || onlineState.error || '原页面与对局状态已保留，恢复完成前暂不可操作。' }),
      failed && button('立即重试', {
        className: 'h5-primary-button',
        on: { click: () => onlineSession?.reconnect() },
      }),
    ])));
  }

  function heroCards({ picks = null, onSelect }) {
    return HEROES.map((hero) => {
      const pick = picks?.find((item) => item.id === hero.id) || {};
      const taken = Boolean(pick.takenBy && !pick.mine);
      const portrait = element('span', { className: 'h5-hero-card__portrait' });
      portrait.style.backgroundImage = `url("${h5HeroPortrait(hero, 'thumb')}")`;
      return button('', {
        className: `h5-hero-card${selectedHeroId === hero.id ? ' is-selected' : ''}${pick.mine ? ' is-mine' : ''}${taken ? ' is-taken' : ''}`,
        attrs: {
          disabled: taken,
          'aria-label': `${hero.name}，${taken ? `已被${pick.takenBy}选择` : pick.mine ? '已选定' : '可选择'}`,
          'data-testid': `h5-hero-${hero.id}`,
        },
        on: { click: () => { selectedHeroId = hero.id; onSelect?.(hero.id); } },
      }, [
        portrait,
        element('span', { className: 'h5-hero-card__name', text: hero.name }),
        element('span', { className: 'h5-hero-card__type', text: hero.type }),
        (pick.mine || taken) && element('span', { className: 'h5-hero-card__state', text: pick.mine ? '已选' : '锁定' }),
      ]);
    });
  }

  function heroDetail({ hero, primaryText, onPrimary, primaryDisabled = false, secondary = null }) {
    const portrait = element('div', { className: 'h5-hero-detail__portrait' });
    portrait.style.backgroundImage = `url("${h5HeroPortrait(hero, 'detail')}")`;
    return element('aside', { className: 'h5-hero-detail' }, [
      portrait,
      element('div', { className: 'h5-hero-detail__heading' }, [element('h2', { text: hero.name }), element('span', { text: hero.type })]),
      element('div', { className: 'h5-hero-detail__scroll' }, [
        element('h3', { text: `主动 · ${hero.skillName} · ${hero.skillCost}⚡` }),
        element('p', { text: hero.skillDesc }),
        element('small', { text: `发动条件：${hero.condDesc}` }),
        element('h3', { text: '被动' }),
        element('p', { text: hero.passiveDesc }),
        element('blockquote', { text: `“${hero.lines?.enter || ''}”` }),
      ]),
      button(primaryText, {
        className: 'h5-primary-button h5-hero-detail__primary',
        attrs: { disabled: primaryDisabled, 'data-testid': 'h5-confirm-hero' },
        on: { click: onPrimary },
      }),
      secondary,
    ]);
  }

  function showResult(ranking = [], myIdx = 1) {
    destroyView();
    current = 'online-result';
    const resultRows = Array.isArray(ranking) ? ranking : [];
    const {
      myRank,
      myPlayer,
      totalPlayers,
      outcome,
      outcomeLabel,
      outcomeEnglish,
      podium,
      resultMessage,
    } = classifyH5GameOutcome(resultRows, myIdx);
    const rows = resultRows.map((player, index) => {
      const hero = player.hero || getHero(player.heroId) || HEROES[0];
      const portrait = element('span', { className: 'h5-result-row__portrait' });
      portrait.style.backgroundImage = `url("${h5HeroPortrait(hero, 'thumb')}")`;
      const isYou = Number(player.idx) === Number(myIdx);
      return element('li', {
        className: `h5-result-row${isYou ? ' is-you' : ''}${index < 3 ? ' is-podium' : ''}`,
        attrs: {
          'data-testid': isYou ? 'h5-result-you' : 'h5-result-row',
          'data-rank': String(index + 1),
          'aria-label': `${isYou ? '你的排名，' : ''}第 ${index + 1} 名，${hero.name}`,
        },
      }, [
        element('strong', { text: String(index + 1) }), portrait,
        element('span', { className: 'h5-result-row__name', text: `${hero.name}${player.playerName ? ` · ${player.playerName}` : ''}` }),
        element('span', { className: 'h5-result-row__state', text: player.alive ? `存活 ${player.hp}` : `第${player.deathRound || '?'}回合阵亡` }),
      ]);
    });
    clear(root, element('div', { className: 'h5-screen h5-result', attrs: { 'data-testid': 'h5-result' } }, [
      header({ title: '本局结算', subtitle: '联网对局' }),
      element('main', { className: 'h5-result__body' }, [
        element('section', {
          className: `h5-result__summary is-${outcome}`,
          attrs: { 'data-outcome': outcome },
        }, [
          element('div', {
            className: `h5-result__outcome is-${outcome}`,
            attrs: {
              role: 'status',
              'aria-live': 'assertive',
              'data-testid': 'h5-game-result-outcome',
              'data-outcome': outcome,
            },
          }, [
            element('span', { text: outcomeEnglish }),
            element('strong', { text: outcomeLabel }),
          ]),
          element('div', { className: 'h5-result__placement' }, [
            element('h1', {
              text: myRank ? `第 ${myRank} 名` : '排名待同步',
              attrs: { 'data-testid': 'h5-game-result-rank' },
            }),
            myRank > 0 && element('span', { text: `/ 共 ${totalPlayers} 名` }),
          ]),
          podium && element('span', {
            className: 'h5-result__podium',
            text: myRank === 1 ? '冠军' : '进入前三',
            attrs: { 'data-testid': 'h5-game-result-podium' },
          }),
          element('p', { className: 'h5-result__message', text: resultMessage }),
          myPlayer && element('p', {
            className: 'h5-result__survival',
            text: myPlayer.alive ? `终局气血 ${myPlayer.hp}` : `第 ${myPlayer.deathRound || '?'} 回合阵亡`,
          }),
          button('返回队伍', {
            className: 'h5-primary-button',
            attrs: { 'data-testid': 'h5-back-to-room' },
            on: { click: () => onlineSession?.backToRoom() },
          }),
        ]),
        element('section', { className: 'h5-result__ranking' }, [
          element('header', {}, [
            element('h2', { text: '最终排名' }),
            element('span', { text: `${totalPlayers} 位英雄` }),
          ]),
          element('ol', { className: 'h5-result__list' }, rows),
        ]),
      ]),
    ]));
  }

  function startOnline() {
    stopOnline();
    current = 'online';
    onlineSession = createOnlineSession();
    onlineUnsubscribe = onlineSession.subscribe((state) => {
      onlineState = state;
      if (state.player) profile = state.player;
      let noticeToShow = null;
      if (state.notice && Number(state.notice.id) > lastNoticeId) {
        lastNoticeId = Number(state.notice.id);
        noticeToShow = state.notice;
      }
      const changed = state.screen !== lastOnlineScreen
        || state.data !== lastOnlineData
        || state.battle !== lastOnlineBattle
        || (state.screen === 'auth' && Number(state.revision) !== lastOnlineRevision);
      if (changed) {
        lastOnlineScreen = state.screen;
        lastOnlineData = state.data;
        lastOnlineBattle = state.battle;
        lastOnlineRevision = Number(state.revision);
        renderOnlineState();
      }
      renderReconnectOverlay();
      if (noticeToShow) toast(root, noticeToShow);
    });
  }

  function onlineBack() {
    if (onlineState?.screen === 'room' || onlineState?.screen === 'pick') {
      root.appendChild(dialog({
        title: '退出队伍',
        message: '退出后将返回联机大厅，确定退出？',
        confirmText: '确认退出',
        danger: true,
        onConfirm: () => onlineSession.leaveTeam(),
      }));
    }
  }

  function renderOnlineAuth() {
    clear(root, createH5AuthView({
      state: onlineState,
      session: onlineSession,
    }));
  }

  function renderOnlineConnecting() {
    const failed = onlineState.connection === 'error' || onlineState.connection === 'closed' || onlineState.error;
    clear(root, element('div', { className: 'h5-screen h5-connection', attrs: { 'data-testid': 'h5-online-connecting' } }, [
      header({ title: '群英决 · 联网版', status: failed ? '离线' : '连接中' }),
      element('main', { className: 'h5-state' }, [
        element('span', { className: 'h5-state__mark', text: failed ? '!' : '◎' }),
        element('h1', { text: failed ? '暂时无法连接' : '正在进入联机大厅' }),
        element('p', { text: onlineState.data?.text || onlineState.error || '正在同步房间状态…' }),
        failed && button('重新连接', {
          className: 'h5-primary-button',
          attrs: { 'data-testid': 'h5-retry-connect' },
          on: { click: () => onlineSession.reconnect() },
        }),
      ]),
    ]));
  }

  function openH5Profile() {
    const account = onlineState?.account || {};
    const username = String(account.username || '—');
    const email = String(account.email || '—');
    const nickname = element('input', {
      className: 'h5-field',
      attrs: { value: profile.nickname, maxlength: '8', 'aria-label': '玩家昵称', 'data-testid': 'h5-profile-name' },
    });
    let emblem = profile.emblem;
    const error = element('p', { className: 'h5-field-error', attrs: { 'aria-live': 'polite' } });
    const options = PLAYER_EMBLEMS.map((value) => button(value, {
      className: `h5-emblem-option${value === emblem ? ' is-selected' : ''}`,
      attrs: { 'aria-pressed': value === emblem ? 'true' : 'false' },
      on: { click: () => { emblem = value; options.forEach((item) => item.classList.toggle('is-selected', item.textContent === value)); } },
    }));
    const logout = button('退出登录', {
      className: 'h5-danger-button h5-account-panel__logout',
      attrs: { 'data-testid': 'h5-account-logout' },
      on: {
        async click() {
          if (onlineState?.authPending) return;
          error.textContent = '';
          logout.disabled = true;
          logout.textContent = '退出中…';
          nickname.disabled = true;
          for (const option of options) option.disabled = true;
          try {
            const result = await onlineSession.logoutAccount();
            if (result === false || result?.ok === false) {
              throw new Error(result?.error?.message || result?.message || '退出登录失败，请稍后重试');
            }
          } catch (logoutError) {
            error.textContent = logoutError?.message || '退出登录失败，请稍后重试';
            logout.disabled = false;
            logout.textContent = '重新退出';
            nickname.disabled = false;
            for (const option of options) option.disabled = false;
          }
        },
      },
    });
    const body = element('div', { className: 'h5-profile-form' }, [
      element('p', { text: `玩家档案 · #${profile.shortId} · 服务端同步` }),
      element('section', {
        className: 'h5-account-panel',
        attrs: { 'data-testid': 'h5-account-panel', 'aria-label': '登录账号信息' },
      }, [
        element('div', { className: 'h5-account-panel__heading' }, [
          element('strong', { text: '账号信息' }),
          element('span', { text: '仅自己可见' }),
        ]),
        element('dl', {}, [
          element('div', {}, [
            element('dt', { text: '用户名' }),
            element('dd', { text: username, attrs: { 'data-testid': 'h5-account-username', title: username } }),
          ]),
          element('div', {}, [
            element('dt', { text: '邮箱' }),
            element('dd', { text: email, attrs: { 'data-testid': 'h5-account-email', title: email } }),
          ]),
        ]),
        logout,
      ]),
      element('label', { text: '纹章' }), element('div', { className: 'h5-emblem-options' }, options),
      element('label', { text: '昵称' }), nickname, error,
    ]);
    root.appendChild(dialog({
      title: '编辑玩家档案',
      message: body,
      confirmText: '保存',
      confirmTestId: 'h5-profile-save',
      onConfirm: async () => {
        const checked = validateNickname(nickname.value);
        if (!checked.ok) { error.textContent = checked.reason; return false; }
        const result = await onlineSession.updatePlayerProfile({ nickname: checked.nickname, emblem });
        if (result === false || result?.ok === false || result?.saved === false) {
          error.textContent = result?.error?.message || result?.message || '当前无法保存，请恢复连接后重试';
          return false;
        }
        return true;
      },
    }));
  }

  function openH5HandHistory() {
    const history = createHandHistoryPanel({
      prefix: 'h5-hand-history',
      loadPage: (options) => onlineSession.getHandHistory(options),
    });
    root.appendChild(dialog({
      title: '我的牌局记录',
      message: history.root,
      confirmText: '关闭',
      confirmTestId: 'h5-hand-history-close',
      showCancel: false,
    }));
    history.load();
  }

  function renderOnlineLobby() {
    const teams = onlineState.data?.teams || [];
    const activeGames = onlineState.data?.activeGames || [];
    const list = element('div', { className: 'h5-team-list', attrs: { 'data-testid': 'h5-team-list' } });
    if (!teams.length) list.appendChild(element('div', { className: 'h5-empty', text: '暂无公开队伍，创建第一支队伍吧。' }));
    for (const team of teams) {
      const tableSize = onlineTableSize(team);
      const maxMembers = Number(team.maxMembers) || tableSize;
      const joinable = team.phase === 'lobby' && Number(team.count) < maxMembers;
      list.appendChild(element('article', { className: 'h5-team-row' }, [
        element('div', {}, [
          element('strong', { text: team.name || `队伍 ${team.id}` }),
          element('small', { text: `#${team.id} · ${tableSize} 人桌` }),
        ]),
        element('span', { text: `${team.count}/${maxMembers}` }),
        element('span', { className: `is-${team.phase}`, text: PHASE_LABELS[team.phase] || team.phase }),
        button(joinable ? '加入' : PHASE_LABELS[team.phase] || '不可加入', {
          className: joinable ? 'h5-small-button' : 'h5-small-button is-disabled',
          attrs: { disabled: !joinable, 'data-testid': joinable ? `h5-join-team-${team.id}` : undefined },
          on: { click: () => joinable && onlineSession.joinTeam(team.id) },
        }),
      ]));
    }
    const activeGameList = activeGames.length ? element('section', {
      className: 'h5-active-games', attrs: { 'data-testid': 'h5-active-games' },
    }, [
      element('div', { className: 'h5-active-games__head' }, [
        element('div', {}, [
          element('h2', { text: '托管中的牌局' }),
          element('p', { text: '离桌后系统会在轮到你时立即静观或退避，你可以随时重新接管。' }),
        ]),
      ]),
      element('div', { className: 'h5-active-games__list' }, activeGames.map((game) => element('article', {
        className: 'h5-active-game', attrs: { 'data-testid': `h5-active-game-${game.id}` },
      }, [
        element('div', {}, [
          element('strong', { text: game.name || `房间 ${game.id}` }),
          element('small', { text: `#${game.id} · ${game.tableSize}人桌 · 第${game.round || 1}局 · ${game.heroName || '原席位'}` }),
        ]),
        element('span', {
          className: game.alive ? 'is-alive' : 'is-dead',
          text: game.alive ? `托管中 · 气血 ${game.hp}` : '已阵亡 · 可观战',
        }),
        button('继续牌局', {
          className: 'h5-small-button',
          attrs: { 'data-testid': `h5-rejoin-game-${game.id}` },
          on: { click: () => onlineSession.rejoinGame(game.id) },
        }),
      ]))),
    ]) : null;
    clear(root, element('div', { className: 'h5-screen h5-lobby', attrs: { 'data-testid': 'h5-online-lobby' } }, [
      header({
        title: '联机大厅',
        subtitle: `${profile.emblem} ${profile.nickname} · #${profile.shortId}`,
        subtitleTestId: 'h5-player-id',
        status: onlineState.profileSync === 'synced' ? '● 在线 · 档案已同步' : '● 在线 · 同步中',
        statusTestId: 'h5-player-sync',
      }),
      element('main', { className: 'h5-lobby__body' }, [
        activeGameList,
        element('div', { className: 'h5-lobby__head' }, [
          element('div', {}, [element('h1', { text: '公开队伍' }), element('p', { text: '6 / 9 人桌 · 1 人即可开局 · AI 自动补位' })]),
          element('div', {}, [
            button('牌谱', {
              className: 'h5-secondary-button',
              attrs: { 'data-testid': 'h5-hand-history-open' },
              on: { click: openH5HandHistory },
            }),
            button('统计', {
              className: 'h5-secondary-button',
              attrs: { 'data-testid': 'h5-player-stats-open' },
              on: { click: () => openPlayerStats(profile) },
            }),
            button('档案', { className: 'h5-secondary-button', attrs: { 'data-testid': 'h5-profile-edit' }, on: { click: openH5Profile } }),
            button('刷新', { className: 'h5-secondary-button', on: { click: () => onlineSession.refreshLobby() } }),
          ]),
        ]),
        list,
      ]),
      element('footer', { className: 'h5-sticky-footer' }, button('创建队伍', {
        className: 'h5-primary-button',
        attrs: { 'data-testid': 'h5-create-team' },
        on: {
          click: () => {
            let tableSize = 6;
            const summary = element('p', { className: 'h5-table-size-picker__summary', text: '6 名真人上限，AI 补足至 6 人。' });
            const options = [6, 9].map((size) => button(`${size} 人桌`, {
              className: `h5-table-size-option${size === tableSize ? ' is-active' : ''}`,
              attrs: {
                'data-testid': `h5-table-size-${size}`,
                'aria-pressed': size === tableSize ? 'true' : 'false',
              },
              on: {
                click: (event) => {
                  tableSize = size;
                  for (const option of event.currentTarget.parentElement.children) {
                    const active = option === event.currentTarget;
                    option.classList.toggle('is-active', active);
                    option.setAttribute('aria-pressed', active ? 'true' : 'false');
                  }
                  summary.textContent = `${size} 名真人上限，AI 补足至 ${size} 人。`;
                },
              },
            }));
            root.appendChild(dialog({
              title: '创建队伍',
              message: element('div', { className: 'h5-table-size-picker' }, [
                element('p', { text: '选择本局桌型。房主 1 人即可开局，空位由 AI 补齐。' }),
                element('div', { className: 'h5-table-size-picker__options' }, options),
                summary,
                element('small', { text: '同一桌台内每位真人与 AI 都使用不同英雄。' }),
              ]),
              confirmText: '确认创建',
              onConfirm: () => onlineSession.createTeam(tableSize),
            }));
          },
        },
      })),
    ]));
  }

  function renderOnlineRoom() {
    const data = onlineState.data || {};
    const members = data.members || [];
    const totalPlayers = onlineTableSize(data);
    const maxMembers = Number(data.maxMembers) || totalPlayers;
    const me = members.find((member) => member.isYou);
    const unavailableMembers = members.filter((member) => memberConnection(member) !== 'online');
    const seats = [];
    for (let index = 0; index < maxMembers; index++) {
      const member = members[index];
      seats.push(member
        ? button('', {
          className: `h5-room-seat${member.isYou ? ' is-you' : ''}`,
          attrs: {
            'data-testid': 'h5-room-member',
            'data-is-you': member.isYou ? 'true' : 'false',
            'data-owner': member.isOwner ? 'true' : 'false',
            'aria-label': `查看${member.name}的扑克统计`,
          },
          on: { click: () => openPlayerStats(member) },
        }, [
          element('span', {
            className: 'h5-room-seat__emblem',
            text: member.emblem || (member.isYou ? profile.emblem : '侠'),
            attrs: { 'data-testid': 'h5-room-member-emblem' },
          }),
          element('strong', { text: member.name, attrs: { 'data-testid': 'h5-room-member-name' } }),
          element('small', {
            className: `is-${memberConnection(member)}`,
            text: `${member.shortId ? `#${member.shortId} · ` : ''}${member.isYou ? '你 · ' : ''}${member.isOwner ? '房主 · ' : '成员 · '}${memberConnectionLabel(member)}`,
            attrs: { 'data-testid': 'h5-room-member-id' },
          }),
          element('span', {
            className: 'h5-room-seat__stats-open',
            text: '查看统计',
            attrs: { 'data-testid': 'h5-player-stats-open' },
          }),
        ])
        : element('article', { className: 'h5-room-seat is-empty' }, [element('span', { text: '+' }), element('strong', { text: '等待玩家' }), element('small', { text: '开局后 AI 补位' })]));
    }
    const aiCount = Math.max(0, totalPlayers - members.length);
    const isOwner = Boolean(data.isOwner || me?.isOwner);
    const startBlocked = unavailableMembers.length > 0;
    clear(root, element('div', { className: 'h5-screen h5-room', attrs: { 'data-testid': 'h5-online-room' } }, [
      header({ title: data.name || '队伍房间', subtitle: `房间 #${data.id || ''} · ${totalPlayers} 人桌 · ${members.length}/${maxMembers} 真人`, onBack: onlineBack, status: '● 在线' }),
      element('main', { className: 'h5-room__body' }, [
        element('section', { className: 'h5-room__seats' }, [
          element('div', { className: 'h5-room__section-head' }, [element('h1', { text: '真人席位' }), element('span', { text: '无准备环节' })]),
          element('div', {
            className: 'h5-room-seat-grid',
            attrs: { 'data-testid': 'h5-room-members', 'data-table-size': String(totalPlayers) },
          }, seats),
        ]),
        element('aside', { className: 'h5-room__summary' }, [
          element('h2', { text: '本局信息' }),
          element('dl', {}, [
            element('div', {}, [element('dt', { text: '桌型' }), element('dd', { text: `${totalPlayers} 人桌` })]),
            element('div', {}, [element('dt', { text: '真人' }), element('dd', { text: `${members.length}/${maxMembers}` })]),
            element('div', {}, [element('dt', { text: 'AI 补位' }), element('dd', { text: `${aiCount} 名` })]),
            element('div', {}, [element('dt', { text: '总人数' }), element('dd', { text: `${totalPlayers} 人` })]),
            element('div', {}, [element('dt', { text: '赛制' }), element('dd', { text: '12 回合' })]),
          ]),
          element('div', { className: 'h5-room__profile-actions' }, [
            button('牌局记录', {
              className: 'h5-secondary-button',
              attrs: { 'data-testid': 'h5-hand-history-open' },
              on: { click: openH5HandHistory },
            }),
            button('编辑档案', { className: 'h5-secondary-button', on: { click: openH5Profile } }),
          ]),
        ]),
      ]),
      element('footer', { className: 'h5-sticky-footer h5-room__actions' }, [
        isOwner
          ? button(`开始选将 · ${members.length}真人 + ${aiCount}AI`, {
            className: 'h5-primary-button',
            attrs: {
              'data-testid': 'h5-start-pick',
              disabled: startBlocked,
              title: startBlocked ? '有成员正在重连或离线保留，暂不能开始' : undefined,
            },
            on: { click: () => onlineSession.startPick() },
          })
          : element('span', { className: 'h5-room__waiting', text: '等待房主开始选将…' }),
        startBlocked && element('span', {
          className: 'h5-room__connection-warning',
          text: `${unavailableMembers.length} 名成员正在重连或离线保留`,
        }),
        button('退出队伍', { className: 'h5-danger-button', attrs: { 'data-testid': 'h5-leave-team' }, on: { click: onlineBack } }),
      ]),
    ]));
  }

  function renderOnlinePick() {
    const data = onlineState.data || {};
    const unavailableMembers = (data.members || []).filter((member) => memberConnection(member) !== 'online');
    const startBlocked = unavailableMembers.length > 0;
    const picks = data.heroes || [];
    const mine = picks.find((item) => item.mine);
    if (!selectedHeroId || picks.find((item) => item.id === selectedHeroId && item.takenBy && !item.mine)) {
      selectedHeroId = mine?.id || picks.find((item) => !item.takenBy)?.id || HEROES[0].id;
    }
    const render = () => {
      const hero = getHero(selectedHeroId) || HEROES[0];
      const option = picks.find((item) => item.id === hero.id) || {};
      const ownerAction = data.isOwner
        ? button(startBlocked ? '等待成员恢复' : data.allPicked ? '全员已选 · 开战' : '等待全员选定', {
          className: 'h5-danger-button h5-hero-detail__start',
          attrs: {
            disabled: !data.allPicked || startBlocked,
            'data-testid': 'h5-start-game',
            title: startBlocked ? '有成员正在重连或离线保留' : undefined,
          },
          on: { click: () => onlineSession.startGame() },
        })
        : element('p', { className: 'h5-hero-detail__waiting', text: data.allPicked ? '等待房主开战…' : '等待队友选择…' });
      clear(root, element('div', { className: 'h5-screen h5-pick', attrs: { 'data-testid': 'h5-online-pick' } }, [
        header({ title: '选择英雄', subtitle: '联机 · 英雄不可重复', onBack: onlineBack, status: `${data.deadline || 0}s` }),
        element('div', { className: 'h5-pick__body' }, [
          element('section', { className: 'h5-pick__grid-wrap' }, element('div', { className: 'h5-hero-grid' }, heroCards({ picks, onSelect: render }))),
          heroDetail({
            hero,
            primaryText: option.mine ? '已选，可点击更换' : '选择该英雄',
            primaryDisabled: Boolean(option.takenBy && !option.mine),
            onPrimary: () => onlineSession.pickHero(hero.id),
            secondary: [
              ownerAction,
              startBlocked && element('p', {
                className: 'h5-room__connection-warning',
                text: `${unavailableMembers.length} 名成员正在重连或离线保留，恢复后才能开战。`,
              }),
            ],
          }),
        ]),
      ]));
    };
    render();
  }

  function renderOnlineBattle() {
    if (!onlineState.battle) return;
    destroyView();
    current = 'online-battle';
    currentView = mountH5Battle({
      root,
      battle: onlineState.battle,
      myIdx: onlineState.data?.mySeat || 1,
      onGameOver: (ranking) => showResult(ranking, onlineState.data?.mySeat || 1),
      onLeave: () => {
        const mySeat = onlineState.data?.mySeat || 1;
        requestOnlineBattleLeave({
          root,
          battle: onlineState.battle,
          mySeat,
          onlineSession,
        });
      },
    });
  }

  function renderOnlineState() {
    if (!onlineState || !onlineSession) return;
    current = `online-${onlineState.screen}`;
    if (onlineState.screen !== 'battle') destroyView();
    if (onlineState.screen === 'auth') renderOnlineAuth();
    else if (onlineState.screen === 'lobby') renderOnlineLobby();
    else if (onlineState.screen === 'room') renderOnlineRoom();
    else if (onlineState.screen === 'pick') renderOnlinePick();
    else if (onlineState.screen === 'battle') renderOnlineBattle();
    else if (onlineState.screen === 'result') showResult(onlineState.data?.ranking || [], onlineState.data?.mySeat || 1);
    else renderOnlineConnecting();
  }

  function tick(dt, interactionAllowed = true) {
    if (!started) return;
    if (!interactionAllowed || !onlineSession) return;
    onlineSession.tick(dt);
    currentView?.tick?.(dt);
  }

  return {
    start() {
      if (started) return;
      started = true;
      startOnline();
    },
    tick,
    get screen() { return current; },
    get isOnlineBattle() { return current === 'online-battle'; },
    destroy() {
      stopOnline();
      clear(root);
    },
  };
}
