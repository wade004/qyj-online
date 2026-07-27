import { HEROES, getHero } from '../../game/heroes.js';
import { createOnlineSession } from '../../session/online-session.js';
import { loadPlayerProfile, validateNickname, PLAYER_EMBLEMS } from '../../services/player-profile.js';
import { h5HeroPortrait } from '../../services/asset-variants.js';
import { button, clear, element, trapEscape } from '../shared/dom.js';
import { createHandHistoryPanel } from '../shared/hand-history.js';
import { createH5AuthView } from './auth-view.js';
import { mountH5Battle } from './battle-view.js';

const PHASE_LABELS = Object.freeze({ lobby: '等待入席', picking: '选将中', playing: '牌局中', game: '牌局中', battle: '牌局中' });

function playerAvatarUrl(value) {
  const number = Number(value);
  const avatarId = Number.isInteger(number) && number >= 1 && number <= 20 ? number : 1;
  return `./assets/avatars/default/avatar-${String(avatarId).padStart(2, '0')}.webp`;
}

function roomMessageTime(value) {
  const date = new Date(Number(value) || Date.now());
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

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
  focusConfirm = true,
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
    attrs: {
      role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
      ...(!focusConfirm ? { tabindex: '-1' } : {}),
    },
  }, [
    element('h2', { text: title }),
    typeof message === 'string' ? element('p', { text: message }) : message,
    element('div', { className: 'h5-dialog__actions' }, [cancel, confirm]),
  ]);
  const layer = element('div', { className: 'h5-dialog-layer' }, panel);
  layer.addEventListener('click', (event) => { if (event.target === layer) close(); });
  releaseEscape = trapEscape(panel, close);
  queueMicrotask(() => {
    if (focusConfirm) confirm.focus();
    else {
      panel.scrollTop = 0;
      panel.focus({ preventScroll: true });
    }
  });
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

  function heroSkillSections(hero) {
    const skills = hero.skills?.display || hero.skills?.all || [];
    return skills.map((skill) => element('section', { className: 'h5-hero-skill-summary' }, [
      element('h3', {
        text: `${skill.kind === 'active' ? '主动' : '被动'} · ${skill.name}${skill.limited ? ' · 限定技' : ''}`,
      }),
      element('p', { text: skill.description }),
      element('small', {
        text: skill.kind === 'active'
          ? `发动条件：${skill.conditionDescription}`
          : `触发条件：${skill.conditionDescription}`,
      }),
    ]));
  }

  function heroDetail({ hero, primaryText, onPrimary, primaryDisabled = false, secondary = null }) {
    const portrait = element('div', { className: 'h5-hero-detail__portrait' });
    portrait.style.backgroundImage = `url("${h5HeroPortrait(hero, 'detail')}")`;
    return element('aside', { className: 'h5-hero-detail' }, [
      portrait,
      element('div', { className: 'h5-hero-detail__heading' }, [element('h2', { text: hero.name }), element('span', { text: hero.type })]),
      element('div', { className: 'h5-hero-detail__scroll' }, [
        ...heroSkillSections(hero),
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
    const credentialsConfigured = account.credentialsConfigured !== false;
    const username = String(account.username || (account.deviceAccount ? '设备快捷账号' : '—'));
    const originalEmail = String(account.email || '');
    const email = String(account.email || '尚未设置');
    const nickname = element('input', {
      className: 'h5-field',
      attrs: { value: profile.nickname, maxlength: '8', 'aria-label': '玩家昵称', 'data-testid': 'h5-profile-name' },
    });
    const emailInput = element('input', {
      className: 'h5-field',
      attrs: {
        type: 'email', value: originalEmail, maxlength: '254', autocomplete: 'email', inputmode: 'email',
        placeholder: '设置后可跨设备登录', 'aria-label': '登录邮箱', 'data-testid': 'h5-profile-email',
      },
    });
    const currentPassword = credentialsConfigured ? element('input', {
      className: 'h5-field',
      attrs: {
        type: 'password', maxlength: '128', autocomplete: 'current-password',
        placeholder: '修改邮箱或密码时必填', 'aria-label': '当前密码', 'data-testid': 'h5-profile-current-password',
      },
    }) : null;
    const newPassword = element('input', {
      className: 'h5-field',
      attrs: {
        type: 'password', maxlength: '128', autocomplete: 'new-password',
        placeholder: credentialsConfigured ? '不修改请留空' : '至少 8 个字符',
        'aria-label': '新密码', 'data-testid': 'h5-profile-new-password',
      },
    });
    const confirmPassword = element('input', {
      className: 'h5-field',
      attrs: {
        type: 'password', maxlength: '128', autocomplete: 'new-password',
        placeholder: '再次输入新密码', 'aria-label': '确认新密码', 'data-testid': 'h5-profile-confirm-password',
      },
    });
    const profileAvatarId = Number(profile.avatarId);
    let avatarId = Number.isSafeInteger(profileAvatarId) && profileAvatarId >= 1 && profileAvatarId <= 20
      ? profileAvatarId : 1;
    const avatarPreview = element('img', {
      attrs: {
        src: playerAvatarUrl(avatarId), alt: `当前头像 ${avatarId}`, draggable: 'false',
        'data-testid': 'h5-profile-avatar-preview',
      },
    });
    let avatarOptions = [];
    avatarOptions = Array.from({ length: 20 }, (_, index) => {
      const value = index + 1;
      return button('', {
        className: `h5-avatar-option${value === avatarId ? ' is-selected' : ''}`,
        attrs: {
          type: 'button', 'aria-label': `选择头像 ${value}`,
          'aria-pressed': value === avatarId ? 'true' : 'false',
          'data-testid': `h5-profile-avatar-${value}`,
        },
        on: {
          click: () => {
            avatarId = value;
            avatarPreview.src = playerAvatarUrl(value);
            avatarPreview.alt = `当前头像 ${value}`;
            avatarOptions.forEach((item, itemIndex) => {
              const selected = itemIndex + 1 === value;
              item.classList.toggle('is-selected', selected);
              item.setAttribute('aria-pressed', selected ? 'true' : 'false');
            });
          },
        },
      }, [element('img', {
        attrs: { src: playerAvatarUrl(value), alt: '', draggable: 'false', loading: 'lazy' },
      })]);
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
          for (const option of avatarOptions) option.disabled = true;
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
            for (const option of avatarOptions) option.disabled = false;
          }
        },
      },
    });
    const body = element('div', { className: 'h5-profile-form' }, [
      element('p', { text: `玩家档案 · #${profile.shortId} · 服务端同步` }),
      element('section', { className: 'h5-avatar-picker', attrs: { 'aria-label': '选择玩家头像' } }, [
        element('div', { className: 'h5-avatar-picker__preview' }, [avatarPreview]),
        element('div', { className: 'h5-avatar-picker__content' }, [
          element('div', { className: 'h5-avatar-picker__heading' }, [
            element('strong', { text: '玩家头像' }),
            element('span', { text: '选择后保存，房间与聊天同步更新' }),
          ]),
          element('div', { className: 'h5-avatar-picker__grid' }, avatarOptions),
        ]),
      ]),
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
      element('label', { text: '昵称' }), nickname,
      element('section', { className: 'h5-profile-credentials' }, [
        element('header', {}, [
          element('strong', { text: credentialsConfigured ? '跨设备登录' : '开启跨设备登录' }),
          element('span', {
            text: credentialsConfigured
              ? '修改登录资料需要验证当前密码'
              : '设置邮箱和密码后，可在其他设备登录',
          }),
        ]),
        element('label', { text: '邮箱' }), emailInput,
        ...(currentPassword ? [element('label', { text: '当前密码' }), currentPassword] : []),
        element('label', { text: credentialsConfigured ? '新密码（可选）' : '登录密码' }), newPassword,
        element('label', { text: '确认新密码' }), confirmPassword,
      ]),
      error,
    ]);
    root.appendChild(dialog({
      title: '编辑玩家档案',
      message: body,
      confirmText: '保存',
      confirmTestId: 'h5-profile-save',
      focusConfirm: false,
      onConfirm: async () => {
        const checked = validateNickname(nickname.value);
        if (!checked.ok) { error.textContent = checked.reason; return false; }
        const nextEmail = emailInput.value.trim();
        const emailChanged = nextEmail !== originalEmail;
        const passwordChanged = newPassword.value.length > 0 || confirmPassword.value.length > 0;
        const credentialsTouched = emailChanged || passwordChanged;
        if (credentialsTouched) {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(nextEmail)) {
            error.textContent = '请输入有效邮箱';
            emailInput.focus();
            return false;
          }
          if (!credentialsConfigured && newPassword.value.length < 8) {
            error.textContent = '首次开启跨设备登录需要设置至少 8 位密码';
            newPassword.focus();
            return false;
          }
          if (passwordChanged && newPassword.value.length < 8) {
            error.textContent = '新密码至少需要 8 个字符';
            newPassword.focus();
            return false;
          }
          if (newPassword.value !== confirmPassword.value) {
            error.textContent = '两次输入的新密码不一致';
            confirmPassword.focus();
            return false;
          }
          if (credentialsConfigured && !currentPassword?.value) {
            error.textContent = '请输入当前密码以确认修改';
            currentPassword?.focus();
            return false;
          }
          const credentialResult = await onlineSession.updateAccountCredentials({
            email: nextEmail,
            ...(passwordChanged ? { newPassword: newPassword.value } : {}),
            ...(credentialsConfigured ? { currentPassword: currentPassword.value } : {}),
          });
          if (!credentialResult?.ok) {
            error.textContent = credentialResult?.error?.message || '登录资料保存失败';
            return false;
          }
        }
        const result = await onlineSession.updatePlayerProfile({
          nickname: checked.nickname,
          emblem,
          avatarId,
        });
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
    if (!teams.length) list.appendChild(element('div', { className: 'h5-empty' }, [
      element('span', { className: 'h5-empty__mark', text: '席' }),
      element('strong', { text: '静候第一桌' }),
      element('small', { text: '当前没有公开队伍，创建牌桌即可邀请侠客入席。' }),
    ]));
    for (const team of teams) {
      const tableSize = onlineTableSize(team);
      const maxMembers = Number(team.maxMembers) || tableSize;
      const joinable = team.phase === 'lobby' && Number(team.count) < maxMembers;
      const memberCount = Math.max(0, Math.min(maxMembers, Number(team.count) || 0));
      list.appendChild(element('article', { className: `h5-team-row is-${team.phase}${joinable ? ' is-joinable' : ''}` }, [
        element('div', { className: 'h5-team-row__tablemark' }, [
          element('strong', { text: tableSize }),
          element('small', { text: '人桌' }),
        ]),
        element('div', { className: 'h5-team-row__identity' }, [
          element('small', { className: 'h5-team-row__serial', text: `ROOM · ${String(team.id).padStart(2, '0')}` }),
          element('strong', { text: team.name || `队伍 ${team.id}` }),
          element('span', { className: `h5-team-row__phase is-${team.phase}`, text: PHASE_LABELS[team.phase] || team.phase }),
        ]),
        element('div', { className: 'h5-team-row__occupancy' }, [
          element('div', {}, [
            element('span', { text: '真人席位' }),
            element('strong', { text: `${memberCount}/${maxMembers}` }),
          ]),
          element('div', { className: 'h5-team-row__seats', attrs: { 'aria-label': `${memberCount} / ${maxMembers} 名真人` } },
            Array.from({ length: maxMembers }, (_, index) => element('i', {
              className: index < memberCount ? 'is-filled' : '',
            }))),
        ]),
        button(joinable ? '入席' : PHASE_LABELS[team.phase] || '暂不可加入', {
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
        element('span', { className: 'h5-active-games__sigil', text: '续' }),
        element('div', {}, [element('h2', { text: '续接牌局' }), element('p', { text: '你的原席仍被保留，可立即返回接管。' })]),
      ]),
      element('div', { className: 'h5-active-games__list' }, activeGames.map((game) => element('article', {
        className: 'h5-active-game', attrs: { 'data-testid': `h5-active-game-${game.id}` },
      }, [
        element('span', { className: 'h5-active-game__table', text: String(game.tableSize || 6) }),
        element('div', { className: 'h5-active-game__identity' }, [
          element('strong', { text: game.name || `房间 ${game.id}` }),
          element('small', { text: `#${game.id} · 第${game.round || 1}局 · ${game.heroName || '原席位'}` }),
        ]),
        element('span', {
          className: `h5-active-game__state ${game.alive ? 'is-alive' : 'is-dead'}`,
          text: game.alive
            ? `${game.managed === false ? '已接管' : '托管中'} · 气血 ${game.hp}`
            : '已阵亡 · 可观战',
        }),
        button('继续牌局', {
          className: 'h5-small-button',
          attrs: { 'data-testid': `h5-rejoin-game-${game.id}` },
          on: { click: () => onlineSession.rejoinGame(game.id) },
        }),
      ]))),
    ]) : null;
    clear(root, element('div', { className: 'h5-screen h5-lobby', attrs: { 'data-testid': 'h5-online-lobby' } }, [
      element('header', { className: 'h5-page-header h5-lobby-masthead' }, [
        element('div', { className: 'h5-lobby-player' }, [
          element('img', { attrs: { src: playerAvatarUrl(profile.avatarId), alt: '', draggable: 'false' } }),
          element('div', { attrs: { 'data-testid': 'h5-player-id' } }, [
            element('span', { text: 'ONLINE LOBBY' }),
            element('strong', { text: profile.nickname }),
            element('small', { text: `${profile.emblem} · #${profile.shortId}` }),
          ]),
        ]),
        element('div', { className: 'h5-lobby-masthead__title' }, [
          element('strong', { text: '群英会馆' }),
          element('span', { text: '以牌会友 · 共逐天下' }),
        ]),
        element('span', {
          className: 'h5-page-header__status h5-lobby-status',
          text: onlineState.profileSync === 'synced' ? '在线 · 已同步' : '在线 · 同步中',
          attrs: { 'data-testid': 'h5-player-sync' },
        }),
      ]),
      element('main', { className: 'h5-lobby__body' }, [
        activeGameList,
        element('div', { className: 'h5-lobby__head' }, [
          element('div', {}, [
            element('span', { className: 'h5-lobby__eyebrow', text: 'TABLE DIRECTORY' }),
            element('h1', { text: '寻找牌桌' }),
            element('p', { text: '6 / 9 人桌 · 单人即可开局 · 空位由 AI 补齐' }),
          ]),
          element('div', { className: 'h5-lobby-tools' }, [
            button('▤ 牌谱', {
              className: 'h5-secondary-button',
              attrs: { 'data-testid': 'h5-hand-history-open' },
              on: { click: openH5HandHistory },
            }),
            button('▥ 统计', {
              className: 'h5-secondary-button',
              attrs: { 'data-testid': 'h5-player-stats-open' },
              on: { click: () => openPlayerStats(profile) },
            }),
            button('◇ 档案', { className: 'h5-secondary-button', attrs: { 'data-testid': 'h5-profile-edit' }, on: { click: openH5Profile } }),
            button('↻ 刷新', { className: 'h5-secondary-button', on: { click: () => onlineSession.refreshLobby() } }),
            button('⇥ 退出', {
              className: 'h5-secondary-button h5-lobby-logout',
              attrs: { 'data-testid': 'h5-lobby-logout', 'aria-label': '退出登录' },
              on: {
                click: () => root.appendChild(dialog({
                  title: '退出登录',
                  message: '退出当前账号并返回登录页面。本设备的一键登录凭据也会失效，下次需要重新登录。',
                  confirmText: '确认退出',
                  confirmTestId: 'h5-lobby-logout-confirm',
                  danger: true,
                  onConfirm: async () => {
                    const result = await onlineSession.logoutAccount();
                    return result !== false && result?.ok !== false;
                  },
                })),
              },
            }),
          ]),
        ]),
        list,
      ]),
      element('footer', { className: 'h5-sticky-footer h5-lobby-footer' }, button('', {
        className: 'h5-primary-button h5-lobby-create',
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
      }, [
        element('span', { className: 'h5-lobby-create__mark', text: '＋' }),
        element('span', { className: 'h5-lobby-create__copy' }, [
          element('strong', { text: '创建新队伍' }),
          element('small', { text: '自选 6 人桌或 9 人桌' }),
        ]),
        element('span', { className: 'h5-lobby-create__arrow', text: '›' }),
      ])),
    ]));
  }

  function confirmKickRoomMember(member) {
    if (!member?.playerId || member.isYou) return;
    const offline = memberConnection(member) !== 'online';
    root.appendChild(dialog({
      title: '移出房间成员',
      message: offline
        ? `${member.name} 当前处于离线保留状态。移出后将立即释放席位，房间可以继续开局。`
        : `确定将 ${member.name} 移出房间吗？对方会返回联机大厅。`,
      confirmText: '确认移出',
      confirmTestId: 'h5-kick-member-confirm',
      danger: true,
      onConfirm: () => onlineSession.kickMember(member.playerId),
    }));
  }

  function renderOnlineRoom() {
    const data = onlineState.data || {};
    const members = data.members || [];
    const totalPlayers = onlineTableSize(data);
    const maxMembers = Number(data.maxMembers) || totalPlayers;
    const me = members.find((member) => member.isYou);
    const isOwner = Boolean(data.isOwner || me?.isOwner);
    const unavailableMembers = members.filter((member) => memberConnection(member) !== 'online');
    const seats = [];
    for (let index = 0; index < maxMembers; index++) {
      const member = members[index];
      seats.push(member
        ? element('article', {
          className: `h5-room-seat${member.isYou ? ' is-you' : ''}`,
          attrs: {
            'data-testid': 'h5-room-member',
            'data-is-you': member.isYou ? 'true' : 'false',
            'data-owner': member.isOwner ? 'true' : 'false',
          },
        }, [
          button('', {
            className: 'h5-room-seat__stats-hit',
            attrs: { 'aria-label': `查看${member.name}的扑克统计` },
            on: { click: () => openPlayerStats(member) },
          }),
          element('span', { className: 'h5-room-seat__avatar-wrap' }, [
            element('img', {
              className: 'h5-room-seat__avatar',
              attrs: { src: playerAvatarUrl(member.avatarId), alt: '', draggable: 'false' },
            }),
            element('span', {
              className: `h5-room-seat__presence is-${memberConnection(member)}`,
              attrs: { title: memberConnectionLabel(member) },
            }),
          ]),
          element('span', { className: 'h5-room-seat__identity' }, [
            element('span', { className: 'h5-room-seat__name-row' }, [
              element('strong', { text: member.name, attrs: { 'data-testid': 'h5-room-member-name' } }),
              member.isOwner && element('i', { className: 'h5-room-seat__badge', text: '房主' }),
              member.isYou && element('i', { className: 'h5-room-seat__badge is-you', text: '你' }),
              isOwner && !member.isYou && button('移出', {
                className: `h5-room-seat__kick${memberConnection(member) === 'online' ? '' : ' is-offline'}`,
                attrs: {
                  'data-testid': 'h5-kick-member',
                  'aria-label': `移出${member.name}`,
                  title: memberConnection(member) === 'online' ? '移出房间' : '释放离线席位',
                },
                on: {
                  click: (event) => {
                    event.stopPropagation();
                    confirmKickRoomMember(member);
                  },
                },
              }),
            ]),
            element('small', {
              className: `is-${memberConnection(member)}`,
              text: `${member.shortId ? `#${member.shortId}` : '玩家'} · ${memberConnectionLabel(member)}`,
              attrs: { 'data-testid': 'h5-room-member-id' },
            }),
            element('span', {
              className: 'h5-room-seat__stats-open',
              text: '查看牌风数据 ›',
              attrs: { 'data-testid': 'h5-player-stats-open' },
            }),
          ]),
          element('span', {
            className: 'h5-room-seat__emblem',
            text: member.emblem || (member.isYou ? profile.emblem : '侠'),
            attrs: { 'data-testid': 'h5-room-member-emblem' },
          }),
        ])
        : element('article', { className: 'h5-room-seat is-empty' }, [
          element('span', { text: '+' }),
          element('span', { className: 'h5-room-seat__empty-copy' }, [
            element('strong', { text: '等待侠客' }),
            element('small', { text: '开局后由 AI 补位' }),
          ]),
        ]));
    }
    const aiCount = Math.max(0, totalPlayers - members.length);
    const startBlocked = unavailableMembers.length > 0;
    const chatMessages = Array.isArray(data.chatMessages) ? data.chatMessages : [];
    const chatList = element('div', {
      className: 'h5-room-chat__messages',
      attrs: { 'data-testid': 'h5-room-chat-messages', 'aria-live': 'polite' },
    });
    if (!chatMessages.length) {
      chatList.append(element('div', { className: 'h5-room-chat__empty' }, [
        element('strong', { text: '和同桌侠客打个招呼' }),
        element('span', { text: '消息仅在当前房间可见，最多保留最近 60 条。' }),
      ]));
    } else {
      for (const message of chatMessages) {
        const mine = Boolean(message.playerId && message.playerId === profile.playerId)
          || Boolean(message.shortId && message.shortId === profile.shortId);
        chatList.append(element('article', { className: `h5-room-chat__message${mine ? ' is-mine' : ''}` }, [
          element('img', {
            className: 'h5-room-chat__avatar',
            attrs: { src: playerAvatarUrl(message.avatarId), alt: '', draggable: 'false' },
          }),
          element('div', { className: 'h5-room-chat__bubble' }, [
            element('span', { className: 'h5-room-chat__meta' }, [
              element('strong', { text: mine ? '我' : (message.name || '侠客') }),
              element('time', { text: roomMessageTime(message.ts) }),
            ]),
            element('p', { text: message.text || '' }),
          ]),
        ]));
      }
    }
    const chatInput = element('input', {
      className: 'h5-room-chat__input',
      attrs: {
        type: 'text', maxlength: '80', autocomplete: 'off', enterkeyhint: 'send',
        placeholder: '和同桌玩家交流…', 'aria-label': '房间聊天内容',
        'data-testid': 'h5-room-chat-input',
      },
    });
    const submitChat = () => {
      const text = chatInput.value.trim();
      if (!text || !onlineSession.sendRoomChat(text)) return;
      chatInput.value = '';
      chatInput.focus({ preventScroll: true });
    };
    const chatSend = button('发送', {
      className: 'h5-room-chat__send',
      attrs: { 'data-testid': 'h5-room-chat-send', 'aria-label': '发送房间消息' },
      on: { click: submitChat },
    });
    chatInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      submitChat();
    });
    clear(root, element('div', { className: 'h5-screen h5-room', attrs: { 'data-testid': 'h5-online-room' } }, [
      header({ title: data.name || '队伍房间', subtitle: `房间 #${data.id || ''} · ${totalPlayers} 人桌 · ${members.length}/${maxMembers} 真人`, onBack: onlineBack, status: '● 在线' }),
      element('main', { className: 'h5-room__body' }, [
        element('section', { className: 'h5-room__seats' }, [
          element('div', { className: 'h5-room__section-head' }, [
            element('span', {}, [element('i', { className: 'h5-room__eyebrow', text: 'ROOM ROSTER' }), element('h1', { text: '同桌侠客' })]),
            element('span', { className: 'h5-room__seat-count', text: `${members.length} 真人 · ${aiCount} AI 补位` }),
          ]),
          element('div', {
            className: 'h5-room-seat-grid',
            attrs: { 'data-testid': 'h5-room-members', 'data-table-size': String(totalPlayers) },
          }, seats),
        ]),
        element('section', { className: 'h5-room__social' }, [
          element('section', { className: 'h5-room-chat' }, [
            element('div', { className: 'h5-room-chat__head' }, [
              element('span', {}, [element('strong', { text: '房间聊天' }), element('small', { text: `${chatMessages.length}/60` })]),
              element('span', { text: '同桌可见' }),
            ]),
            chatList,
            element('div', { className: 'h5-room-chat__composer' }, [chatInput, chatSend]),
          ]),
          element('aside', { className: 'h5-room__summary' }, [
            element('div', { className: 'h5-room__summary-head' }, [
              element('span', {}, [element('small', { text: `${totalPlayers} 人桌` }), element('strong', { text: '12 回合' })]),
              element('span', { text: `#${data.id || '—'}` }),
            ]),
            element('div', { className: 'h5-room__quick-links' }, [
              button('牌局记录', {
                className: 'h5-room__link-button',
                attrs: { 'data-testid': 'h5-hand-history-open' },
                on: { click: openH5HandHistory },
              }),
              button('我的档案', { className: 'h5-room__link-button', on: { click: openH5Profile } }),
            ]),
            element('div', { className: 'h5-room__actions' }, [
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
          ]),
        ]),
      ]),
    ]));
    requestAnimationFrame(() => { chatList.scrollTop = chatList.scrollHeight; });
  }

  function renderOnlinePick() {
    const data = onlineState.data || {};
    const members = Array.isArray(data.members) ? data.members : [];
    const unavailableMembers = members.filter((member) => memberConnection(member) !== 'online');
    const startBlocked = unavailableMembers.length > 0;
    const picks = data.heroes || [];
    const mine = picks.find((item) => item.mine);
    const locked = Boolean(mine);
    const deadlineAt = Number(data.deadlineAt)
      || (Date.now() + Math.max(0, Number(data.deadline) || 0) * 1000);
    const updateDraftDeadline = () => {
      const target = root.querySelector('[data-testid="h5-pick-deadline"]');
      if (!target) return;
      const seconds = Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000));
      target.textContent = seconds > 0 ? `剩余 ${seconds} 秒 · 超时自动分配` : '正在自动分配未选英雄';
    };
    const deadlineTimer = window.setInterval(updateDraftDeadline, 250);
    currentView = { destroy: () => window.clearInterval(deadlineTimer) };
    if (locked) {
      selectedHeroId = mine.id;
    } else if (!selectedHeroId || picks.find((item) => item.id === selectedHeroId && item.takenBy)) {
      selectedHeroId = mine?.id || picks.find((item) => !item.takenBy)?.id || HEROES[0].id;
    }
    const render = () => {
      const hero = getHero(selectedHeroId) || HEROES[0];
      const option = picks.find((item) => item.id === hero.id) || {};
      const readyCount = members.filter((member) => member.ready || member.heroId).length;
      const chatMessages = Array.isArray(data.chatMessages) ? data.chatMessages : [];
      const chatList = element('div', {
        className: 'h5-pick-chat__messages',
        attrs: { 'data-testid': 'h5-pick-chat-messages', 'aria-live': 'polite' },
      });
      if (!chatMessages.length) {
        chatList.appendChild(element('div', { className: 'h5-pick-chat__empty' }, [
          element('strong', { text: '选将时也可以交流' }),
          element('span', { text: '提醒队友阵容搭配，或直接打个招呼。' }),
        ]));
      } else {
        chatMessages.forEach((message) => {
          const isMine = (message.playerId && message.playerId === profile.playerId)
            || (message.shortId && message.shortId === profile.shortId);
          chatList.appendChild(element('article', {
            className: `h5-pick-chat__message${isMine ? ' is-mine' : ''}`,
          }, [
            element('img', {
              className: 'h5-pick-chat__avatar',
              attrs: { src: playerAvatarUrl(message.avatarId), alt: '', draggable: 'false' },
            }),
            element('div', {}, [
              element('span', {}, [
                element('strong', { text: isMine ? '我' : String(message.name || '侠客') }),
                element('time', { text: roomMessageTime(message.ts) }),
              ]),
              element('p', { text: String(message.text || '') }),
            ]),
          ]));
        });
      }
      const chatInput = element('input', {
        className: 'h5-pick-chat__input',
        attrs: {
          type: 'text', maxlength: '80', autocomplete: 'off',
          placeholder: '和同桌玩家交流…', 'aria-label': '选将聊天内容',
          'data-testid': 'h5-pick-chat-input',
        },
      });
      const sendMessage = () => {
        const text = String(chatInput.value || '').trim();
        if (!text || !onlineSession.sendRoomChat(text)) return;
        chatInput.value = '';
        chatInput.focus();
      };
      const chatSend = button('发送', {
        className: 'h5-pick-chat__send',
        attrs: { 'data-testid': 'h5-pick-chat-send', 'aria-label': '发送选将消息' },
        on: { click: sendMessage },
      });
      chatInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        sendMessage();
      });

      const ownerAction = data.isOwner
        ? button(startBlocked ? '等待成员恢复' : data.allPicked ? '全员已选 · 开战' : '等待全员选定', {
          className: 'h5-danger-button h5-pick-roster__start',
          attrs: {
            disabled: !data.allPicked || startBlocked,
            'data-testid': 'h5-start-game',
            title: startBlocked ? '有成员正在重连或离线保留' : undefined,
          },
          on: { click: () => onlineSession.startGame() },
        })
        : element('p', { className: 'h5-pick-roster__waiting', text: data.allPicked ? '等待房主开战…' : '等待队友选择…' });

      const memberRows = members.map((member, index) => {
        const memberHero = member.heroId ? getHero(member.heroId) : null;
        const ready = Boolean(memberHero);
        const heroPortrait = memberHero
          ? element('span', {
            className: 'h5-pick-player__hero',
            attrs: { title: memberHero.name, 'aria-label': `已选择${memberHero.name}` },
          })
          : element('span', { className: 'h5-pick-player__hero is-empty', text: '?' });
        if (memberHero) heroPortrait.style.backgroundImage = `url("${h5HeroPortrait(memberHero, 'thumb')}")`;
        return element('article', {
          className: `h5-pick-player${ready ? ' is-ready' : ' is-waiting'}${member.isYou ? ' is-you' : ''}`,
          attrs: { 'data-testid': 'h5-pick-player', 'data-ready': String(ready) },
        }, [
          element('span', { className: 'h5-pick-player__avatar-wrap' }, [
            element('img', {
              className: 'h5-pick-player__avatar',
              attrs: { src: playerAvatarUrl(member.avatarId), alt: '', draggable: 'false' },
            }),
            element('i', { className: `h5-pick-player__presence is-${memberConnection(member)}` }),
          ]),
          element('span', { className: 'h5-pick-player__identity' }, [
            element('span', { className: 'h5-pick-player__name' }, [
              element('strong', { text: String(member.name || `玩家${index + 1}`) }),
              member.isOwner && element('i', { text: '房主' }),
              member.isYou && element('i', { className: 'is-you', text: '你' }),
              data.isOwner && !member.isYou && button('移出', {
                className: `h5-pick-player__kick${memberConnection(member) === 'online' ? '' : ' is-offline'}`,
                attrs: {
                  'data-testid': 'h5-pick-kick-member',
                  'aria-label': `移出${member.name}`,
                },
                on: { click: () => confirmKickRoomMember(member) },
              }),
            ]),
            element('small', { text: ready ? `${memberHero.name} · 已准备` : '尚未选择 · 未准备' }),
          ]),
          heroPortrait,
        ]);
      });

      const lockedPortrait = element('div', { className: 'h5-pick-lock__portrait' },
        element('span', { text: '已确认 · 本局不可更换' }));
      lockedPortrait.style.backgroundImage = `url("${h5HeroPortrait(hero, 'detail')}")`;
      const center = locked
        ? element('section', { className: 'h5-pick-lock', attrs: { 'data-testid': 'h5-pick-locked' } }, [
          lockedPortrait,
          element('div', { className: 'h5-pick-lock__content' }, [
            element('header', {}, [
              element('div', {}, [
                element('small', { text: 'YOUR HERO' }),
                element('h2', { text: hero.name }),
              ]),
              element('span', { text: hero.type }),
            ]),
            element('div', { className: 'h5-pick-lock__traits' }, [
              element('span', { text: hero.type }),
              ...(hero.skills?.display || hero.skills?.all || [])
                .map((skill) => element('span', { text: skill.name })),
              element('span', { text: '条件技' }),
            ]),
            ...heroSkillSections(hero),
            element('blockquote', { text: `“${hero.lines?.enter || ''}”` }),
          ]),
        ])
        : element('section', { className: 'h5-pick-select', attrs: { 'data-testid': 'h5-pick-select' } }, [
          element('header', { className: 'h5-pick-select__head' }, [
            element('div', {}, [
              element('small', { text: 'HERO ROSTER' }),
              element('h2', { text: '选择你的英雄' }),
            ]),
            element('span', { text: `${picks.filter((item) => !item.takenBy).length} 名可选` }),
          ]),
          element('div', { className: 'h5-pick-select__grid' }, heroCards({ picks, onSelect: render })),
          element('footer', { className: 'h5-pick-select__confirm' }, [
            element('div', {}, [
              element('strong', { text: `${hero.name} · ${hero.type}` }),
              element('span', {
                text: (hero.skills?.display || hero.skills?.all || []).map((skill) =>
                  `${skill.kind === 'active' ? '主动' : '被动'}：${skill.name}`).join(' · '),
              }),
            ]),
            button('确认选择', {
              className: 'h5-primary-button',
              attrs: {
                disabled: Boolean(option.takenBy),
                'data-testid': 'h5-confirm-hero',
              },
              on: { click: () => onlineSession.pickHero(hero.id) },
            }),
          ]),
        ]);

      clear(root, element('div', { className: 'h5-screen h5-pick', attrs: { 'data-testid': 'h5-online-pick' } }, [
        header({
          title: data.name || '选择英雄',
          subtitle: `${onlineTableSize(data)} 人桌 · 英雄不可重复 · 确认后不可更换`,
          onBack: onlineBack,
          status: `${readyCount}/${members.length || 1} 已就绪`,
        }),
        element('div', { className: 'h5-pick__body' }, [
          element('aside', { className: 'h5-pick-roster', attrs: { 'data-testid': 'h5-pick-members' } }, [
            element('header', {}, [
              element('div', {}, [element('small', { text: 'TEAM STATUS' }), element('h2', { text: '同桌玩家' })]),
              element('strong', { text: `${readyCount}/${members.length || 1}` }),
            ]),
            element('div', { className: 'h5-pick-roster__list' }, memberRows),
            element('footer', {}, [
              element('span', {
                text: `剩余 ${Math.max(0, Number(data.deadline) || 0)} 秒 · 超时自动分配`,
                attrs: { 'data-testid': 'h5-pick-deadline' },
              }),
              startBlocked && element('span', { className: 'h5-room__connection-warning', text: `${unavailableMembers.length} 名成员离线` }),
              ownerAction,
            ]),
          ]),
          center,
          element('aside', { className: 'h5-pick-chat' }, [
            element('header', {}, [
              element('div', {}, [element('small', { text: 'ROOM CHAT' }), element('h2', { text: '房间聊天' })]),
              element('span', { text: `${chatMessages.length}/60` }),
            ]),
            chatList,
            element('div', { className: 'h5-pick-chat__composer' }, [chatInput, chatSend]),
          ]),
        ]),
      ]));
      updateDraftDeadline();
      requestAnimationFrame(() => { chatList.scrollTop = chatList.scrollHeight; });
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
