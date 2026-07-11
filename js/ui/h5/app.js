import { HEROES, getHero } from '../../game/heroes.js';
import { shuffle } from '../../game/deck.js';
import { createLocalBattleSession } from '../../session/local-battle-session.js';
import { createOnlineSession } from '../../session/online-session.js';
import { loadPlayerProfile, validateNickname, PLAYER_EMBLEMS } from '../../services/player-profile.js';
import { h5HeroPortrait } from '../../services/asset-variants.js';
import { button, clear, element, trapEscape } from '../shared/dom.js';
import { mountH5Battle } from './battle-view.js';

const PHASE_LABELS = Object.freeze({ lobby: '待命', picking: '选将中', game: '对局中', battle: '对局中' });

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

function dialog({ title, message, confirmText = '确认', danger = false, onConfirm, onClose }) {
  let releaseEscape;
  const close = () => {
    releaseEscape?.();
    layer.remove();
    onClose?.();
  };
  const cancel = button('取消', { className: 'h5-secondary-button', on: { click: close } });
  const confirm = button(confirmText, {
    className: danger ? 'h5-danger-button' : 'h5-primary-button',
    attrs: { 'data-testid': 'h5-dialog-confirm' },
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

export function mountH5App({ root }) {
  let current = 'mode';
  let currentView = null;
  let localSession = null;
  let onlineSession = null;
  let onlineUnsubscribe = null;
  let onlineState = null;
  let lastOnlineData = null;
  let lastOnlineScreen = '';
  let lastOnlineBattle = null;
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

  function stopLocal() {
    destroyView();
    localSession?.destroy?.();
    localSession = null;
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

  function showMode() {
    stopLocal();
    stopOnline();
    current = 'mode';
    const single = button('', {
      className: 'h5-mode-card',
      attrs: { 'data-testid': 'h5-mode-single', 'aria-label': '单机人机对战' },
      on: { click: showSinglePick },
    }, [
      element('span', { className: 'h5-mode-card__mark', text: '单' }),
      element('span', { className: 'h5-mode-card__copy' }, [
        element('strong', { text: '单机 · 人机对战' }),
        element('small', { text: '选择英雄，与五名 AI 完成 12 回合对局' }),
      ]),
      element('span', { className: 'h5-mode-card__arrow', text: '›' }),
    ]);
    const online = button('', {
      className: 'h5-mode-card is-online',
      attrs: { 'data-testid': 'h5-mode-online', 'aria-label': '联机组队对战' },
      on: { click: startOnline },
    }, [
      element('span', { className: 'h5-mode-card__mark', text: '联' }),
      element('span', { className: 'h5-mode-card__copy' }, [
        element('strong', { text: '联机 · 组队对战' }),
        element('small', { text: '1–3 名真人，AI 补足至 6 人' }),
      ]),
      element('span', { className: 'h5-mode-card__arrow', text: '›' }),
    ]);
    clear(root, element('div', { className: 'h5-screen h5-home', attrs: { 'data-testid': 'h5-home' } }, [
      element('section', { className: 'h5-home__brand' }, [
        element('p', { className: 'h5-eyebrow', text: 'HEROES SHOWDOWN' }),
        element('h1', { text: '群 英 决' }),
        element('p', { text: '英雄对决 · 天机博弈 · 气血为注 · 杀招定生死' }),
        element('span', { className: 'h5-home__version', text: 'H5 横屏版 · v1.0' }),
      ]),
      element('section', { className: 'h5-home__modes' }, [single, online]),
    ]));
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

  function showSinglePick() {
    stopLocal();
    stopOnline();
    current = 'single-pick';
    const render = () => {
      const selected = getHero(selectedHeroId) || HEROES[0];
      const grid = element('div', { className: 'h5-hero-grid', attrs: { role: 'list', 'data-testid': 'h5-hero-grid' } }, heroCards({ onSelect: render }));
      clear(root, element('div', { className: 'h5-screen h5-pick', attrs: { 'data-testid': 'h5-single-pick' } }, [
        header({ title: '选择英雄', subtitle: '单机 · 点击查看，确认后开战', onBack: showMode }),
        element('div', { className: 'h5-pick__body' }, [
          element('section', { className: 'h5-pick__grid-wrap' }, grid),
          heroDetail({ hero: selected, primaryText: '选择该英雄并开战', onPrimary: () => startLocalBattle(selected.id) }),
        ]),
      ]));
    };
    render();
  }

  function startLocalBattle(heroId) {
    stopLocal();
    current = 'single-battle';
    const rest = shuffle(HEROES.filter((hero) => hero.id !== heroId).map((hero) => hero.id));
    localSession = createLocalBattleSession({
      heroIds: [heroId, ...rest.slice(0, 5)],
      rules: { endWhenHumanEliminated: true },
    });
    currentView = mountH5Battle({
      root,
      battle: localSession,
      myIdx: 1,
      onGameOver: (ranking) => showResult(ranking, 1, false),
    });
    localSession.start();
  }

  function showResult(ranking = [], myIdx = 1, isOnline = false) {
    destroyView();
    current = isOnline ? 'online-result' : 'single-result';
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
      header({ title: '本局结算', subtitle: isOnline ? '联机对局' : '单机对局' }),
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
          button(isOnline ? '返回队伍' : '重新选将', {
            className: 'h5-primary-button',
            attrs: { 'data-testid': isOnline ? 'h5-back-to-room' : 'h5-again' },
            on: { click: () => isOnline ? onlineSession?.backToRoom() : showSinglePick() },
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
    stopLocal();
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
      const changed = state.screen !== lastOnlineScreen || state.data !== lastOnlineData || state.battle !== lastOnlineBattle;
      if (changed) {
        lastOnlineScreen = state.screen;
        lastOnlineData = state.data;
        lastOnlineBattle = state.battle;
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
    } else {
      showMode();
    }
  }

  function renderOnlineConnecting() {
    const failed = onlineState.connection === 'error' || onlineState.connection === 'closed' || onlineState.error;
    clear(root, element('div', { className: 'h5-screen h5-connection', attrs: { 'data-testid': 'h5-online-connecting' } }, [
      header({ title: '联机模式', onBack: showMode, status: failed ? '离线' : '连接中' }),
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
    const body = element('div', { className: 'h5-profile-form' }, [
      element('p', { text: `玩家档案 · #${profile.shortId} · 服务端同步` }),
      element('label', { text: '纹章' }), element('div', { className: 'h5-emblem-options' }, options),
      element('label', { text: '昵称' }), nickname, error,
    ]);
    root.appendChild(dialog({
      title: '编辑玩家档案',
      message: body,
      confirmText: '保存',
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

  function renderOnlineLobby() {
    const teams = onlineState.data?.teams || [];
    const list = element('div', { className: 'h5-team-list', attrs: { 'data-testid': 'h5-team-list' } });
    if (!teams.length) list.appendChild(element('div', { className: 'h5-empty', text: '暂无公开队伍，创建第一支队伍吧。' }));
    for (const team of teams) {
      const joinable = team.phase === 'lobby' && team.count < 3;
      list.appendChild(element('article', { className: 'h5-team-row' }, [
        element('div', {}, [element('strong', { text: team.name || `队伍 ${team.id}` }), element('small', { text: `#${team.id}` })]),
        element('span', { text: `${team.count}/3` }),
        element('span', { className: `is-${team.phase}`, text: PHASE_LABELS[team.phase] || team.phase }),
        button(joinable ? '加入' : PHASE_LABELS[team.phase] || '不可加入', {
          className: joinable ? 'h5-small-button' : 'h5-small-button is-disabled',
          attrs: { disabled: !joinable, 'data-testid': joinable ? `h5-join-team-${team.id}` : undefined },
          on: { click: () => joinable && onlineSession.joinTeam(team.id) },
        }),
      ]));
    }
    clear(root, element('div', { className: 'h5-screen h5-lobby', attrs: { 'data-testid': 'h5-online-lobby' } }, [
      header({
        title: '联机大厅',
        subtitle: `${profile.emblem} ${profile.nickname} · #${profile.shortId}`,
        subtitleTestId: 'h5-player-id',
        onBack: showMode,
        status: onlineState.profileSync === 'synced' ? '● 在线 · 档案已同步' : '● 在线 · 同步中',
        statusTestId: 'h5-player-sync',
      }),
      element('main', { className: 'h5-lobby__body' }, [
        element('div', { className: 'h5-lobby__head' }, [
          element('div', {}, [element('h1', { text: '公开队伍' }), element('p', { text: '最多 3 名真人，AI 补足至 6 人' })]),
          element('div', {}, [
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
          click: () => root.appendChild(dialog({
            title: '创建队伍',
            message: '系统将生成公开队伍：3 名真人上限，AI 补足 6 人，固定 12 回合。',
            confirmText: '确认创建',
            onConfirm: () => onlineSession.createTeam(),
          })),
        },
      })),
    ]));
  }

  function renderOnlineRoom() {
    const data = onlineState.data || {};
    const members = data.members || [];
    const me = members.find((member) => member.isYou);
    const unavailableMembers = members.filter((member) => memberConnection(member) !== 'online');
    const seats = [];
    for (let index = 0; index < (data.maxMembers || 3); index++) {
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
    const aiCount = 6 - members.length;
    const isOwner = Boolean(data.isOwner || me?.isOwner);
    const startBlocked = unavailableMembers.length > 0;
    clear(root, element('div', { className: 'h5-screen h5-room', attrs: { 'data-testid': 'h5-online-room' } }, [
      header({ title: data.name || '队伍房间', subtitle: `房间 #${data.id || ''} · ${members.length}/3 真人`, onBack: onlineBack, status: '● 在线' }),
      element('main', { className: 'h5-room__body' }, [
        element('section', { className: 'h5-room__seats' }, [
          element('div', { className: 'h5-room__section-head' }, [element('h1', { text: '真人席位' }), element('span', { text: '无准备环节' })]),
          element('div', { className: 'h5-room-seat-grid', attrs: { 'data-testid': 'h5-room-members' } }, seats),
        ]),
        element('aside', { className: 'h5-room__summary' }, [
          element('h2', { text: '本局信息' }),
          element('dl', {}, [
            element('div', {}, [element('dt', { text: '真人' }), element('dd', { text: `${members.length}/3` })]),
            element('div', {}, [element('dt', { text: 'AI 补位' }), element('dd', { text: `${aiCount} 名` })]),
            element('div', {}, [element('dt', { text: '总人数' }), element('dd', { text: '6 人' })]),
            element('div', {}, [element('dt', { text: '赛制' }), element('dd', { text: '12 回合' })]),
          ]),
          button('编辑档案', { className: 'h5-secondary-button', on: { click: openH5Profile } }),
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
      online: true,
      onGameOver: (ranking) => showResult(ranking, onlineState.data?.mySeat || 1, true),
    });
  }

  function renderOnlineState() {
    if (!onlineState || !onlineSession) return;
    current = `online-${onlineState.screen}`;
    if (onlineState.screen !== 'battle') destroyView();
    if (onlineState.screen === 'lobby') renderOnlineLobby();
    else if (onlineState.screen === 'room') renderOnlineRoom();
    else if (onlineState.screen === 'pick') renderOnlinePick();
    else if (onlineState.screen === 'battle') renderOnlineBattle();
    else if (onlineState.screen === 'result') showResult(onlineState.data?.ranking || [], onlineState.data?.mySeat || 1, true);
    else renderOnlineConnecting();
  }

  function tick(dt, interactionAllowed = true) {
    if (!started) return;
    if (onlineSession) {
      onlineSession.tick(dt);
      currentView?.tick?.(dt);
    } else if (localSession && interactionAllowed) {
      localSession.update(dt);
      currentView?.tick?.(dt);
    }
  }

  showMode();
  return {
    start() { started = true; },
    tick,
    get screen() { return current; },
    get isOnlineBattle() { return current === 'online-battle'; },
    destroy() {
      stopLocal();
      stopOnline();
      clear(root);
    },
  };
}
