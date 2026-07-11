import { HEROES, getHero } from '../../game/heroes.js';
import { attachBattle } from '../battle.js';
import { element, button, clear, trapEscape } from '../shared/dom.js';
import {
  loadPlayerProfile,
  savePlayerProfile,
  validateNickname,
  PLAYER_EMBLEMS,
} from '../../services/player-profile.js';

const PHASE_LABELS = Object.freeze({
  lobby: '待命',
  picking: '选将中',
  game: '对局中',
  battle: '对局中',
  playing: '对局中',
});

const SCREEN_LABELS = Object.freeze({
  connecting: '连接中',
  lobby: '联机大厅',
  room: '队伍房间',
  pick: '选择英雄',
  battle: '对局',
  result: '结算',
  closed: '已离线',
});

const ROOM_FILTERS = Object.freeze([
  { key: 'all', label: '全部' },
  { key: 'joinable', label: '可加入' },
  { key: 'waiting', label: '等待中' },
  { key: 'playing', label: '对局中' },
  { key: 'full', label: '已满' },
]);

const ROOM_JOIN_ERROR_CODES = new Set([
  'ROOM_NOT_FOUND', 'ROOM_NOT_JOINABLE', 'ROOM_FULL', 'ALREADY_IN_ROOM', 'INVALID_FIELD',
]);

const EMPTY_STATS = Object.freeze({ matches: 0, wins: 0, top3: 0, winRate: 0, bestRank: null });

const POKER_CORE_STATS = Object.freeze([
  { key: 'vpip', label: 'VPIP', name: '主动入池率', description: '翻牌前主动投入筹码进入牌局的比例。', percent: true },
  { key: 'pfr', label: 'PFR', name: '翻前加注率', description: '翻牌前主动加注或再加注的比例。', percent: true },
  { key: 'threeBet', label: '3Bet', name: '翻前再加注率', description: '面对已有加注时再次加注的比例。', percent: true },
  { key: 'af', label: 'AF', name: '激进系数', description: '下注与加注次数相对跟注次数的比值。', percent: false },
  { key: 'hands', label: 'HANDS', name: '统计手数', description: '当前统计样本包含的有效牌局手数。', integer: true },
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

function safeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function nullableNumber(value, { percent = false, integer = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (integer) return Math.max(0, Math.round(number));
  if (percent) return Math.max(0, Math.min(100, number));
  return Math.max(0, number);
}

function pokerConfidence(value, hands, available) {
  if (!available) return { label: '暂无样本', tone: 'empty', value: null };
  const numeric = Number(value);
  if (value !== null && value !== undefined && value !== '' && Number.isFinite(numeric)) {
    const normalized = numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric;
    const percent = Math.max(0, Math.min(100, normalized));
    return {
      label: `可信度 ${Math.round(percent)}%`,
      tone: percent >= 75 ? 'high' : percent >= 45 ? 'medium' : 'low',
      value: percent,
    };
  }
  const text = String(value || '').toLowerCase();
  if (['high', 'reliable', '高', '高可信'].includes(text)) return { label: '高可信度', tone: 'high', value: null };
  if (['medium', 'mid', '中', '中可信'].includes(text)) return { label: '中可信度', tone: 'medium', value: null };
  if (['low', '低', '低可信'].includes(text)) return { label: '低可信度', tone: 'low', value: null };
  if (hands >= 100) return { label: '高可信度', tone: 'high', value: null };
  if (hands >= 30) return { label: '中可信度', tone: 'medium', value: null };
  return { label: '低可信度', tone: 'low', value: null };
}

function normalizePokerStats(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const hands = nullableNumber(source.hands, { integer: true }) ?? 0;
  const values = Object.fromEntries(POKER_NUMERIC_KEYS.map((key) => [
    key,
    nullableNumber(source[key], { percent: key !== 'af' }),
  ]));
  const available = hands > 0 || Object.values(values).some((value) => value !== null);
  const confidence = pokerConfidence(source.confidence, hands, available);
  return {
    ...values,
    hands,
    available,
    confidence,
    rangeLabel: String(source.rangeLabel || '近30天 · 最近200手'),
  };
}

function pokerValue(stats, definition) {
  const value = stats[definition.key];
  if (definition.key === 'hands') return String(stats.hands);
  if (value === null || value === undefined) return '—';
  if (definition.percent) return `${Number(value).toFixed(value >= 10 || Number.isInteger(value) ? 0 : 1)}%`;
  return Number(value).toFixed(Number.isInteger(value) ? 0 : 1);
}

function normalizeWinRate(value, matches, wins) {
  const number = Number(value);
  if (!Number.isFinite(number)) return matches > 0 ? (wins / matches) * 100 : 0;
  if (number >= 0 && number <= 1) {
    const ratio = matches > 0 ? wins / matches : number;
    if (Math.abs(number - ratio) < 0.02) return number * 100;
  }
  return Math.max(0, Math.min(100, number));
}

function normalizePlayerAccount(state, localProfile) {
  const raw = state?.player || state?.data?.player || null;
  const rawStats = raw?.stats || {};
  const matches = safeCount(rawStats.matches);
  const wins = safeCount(rawStats.wins);
  const top3 = safeCount(rawStats.top3);
  const serverSynced = Boolean(raw?.playerId);
  const recentMatches = Array.isArray(raw?.recentMatches)
    ? raw.recentMatches.map((match) => ({
      matchId: String(match?.matchId || ''),
      placement: safeCount(match?.placement),
      heroId: String(match?.heroId || ''),
      playedAt: match?.playedAt || '',
      survived: Boolean(match?.survived),
    })).slice(0, 8)
    : [];
  const rawSync = typeof state?.profileSync === 'object'
    ? state.profileSync?.status : state?.profileSync;
  let syncStatus = 'connecting';
  if (rawSync === 'local') syncStatus = state?.connection === 'open' ? 'syncing' : 'connecting';
  else if (['saving', 'syncing', 'pending'].includes(rawSync)) syncStatus = 'syncing';
  else if (['error', 'failed'].includes(rawSync)) syncStatus = 'error';
  else if (serverSynced || ['saved', 'synced', 'ready'].includes(rawSync)) syncStatus = 'synced';
  else if (state?.connection === 'error' || state?.connection === 'closed') syncStatus = 'error';
  else if (state?.connection === 'open' || state?.connection === 'online') syncStatus = 'syncing';
  return {
    guestId: localProfile.guestId,
    playerId: String(raw?.playerId || localProfile.guestId || ''),
    shortId: String(raw?.shortId || localProfile.shortId || '').replace(/^#/, ''),
    nickname: String(raw?.nickname || localProfile.nickname || '无名侠客'),
    emblem: String(raw?.emblem || localProfile.emblem || PLAYER_EMBLEMS[0]),
    createdAt: raw?.createdAt || '',
    lastSeenAt: raw?.lastSeenAt || '',
    statsAvailable: serverSynced,
    stats: {
      matches,
      wins,
      top3,
      winRate: normalizeWinRate(rawStats.winRate, matches, wins),
      bestRank: safeCount(rawStats.bestRank) || null,
    },
    pokerStats: normalizePokerStats(raw?.pokerStats || localProfile?.pokerStats),
    recentMatches,
    syncStatus,
    serverSynced,
  };
}

function playerNumber(player) {
  return `#${player.shortId || String(player.playerId || '').slice(-8) || '--------'}`;
}

function percentText(value) {
  const number = Number(value) || 0;
  const fixed = number.toFixed(number >= 10 || Number.isInteger(number) ? 0 : 1);
  return `${fixed}%`;
}

function localDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function syncStatusMeta(player) {
  if (player.syncStatus === 'synced') return { label: '服务端已同步', tone: 'synced' };
  if (player.syncStatus === 'error') return { label: '档案同步失败', tone: 'error' };
  if (player.syncStatus === 'syncing') return { label: '正在同步档案', tone: 'syncing' };
  return { label: '连接后自动同步', tone: 'connecting' };
}

function roomPhase(team) {
  return String(team?.phase || 'lobby');
}

function roomCapacity(team) {
  return Math.max(1, safeCount(team?.maxMembers) || 3);
}

function roomIsJoinable(team) {
  return roomPhase(team) === 'lobby' && safeCount(team?.count) < roomCapacity(team);
}

function roomMatchesFilter(team, selected) {
  if (selected === 'all') return true;
  if (selected === 'joinable') return roomIsJoinable(team);
  if (selected === 'waiting') return roomPhase(team) === 'lobby';
  if (selected === 'playing') return ['picking', 'game', 'battle', 'playing'].includes(roomPhase(team));
  if (selected === 'full') return safeCount(team?.count) >= roomCapacity(team);
  return true;
}

function memberName(member) {
  return String(member?.profile?.nickname || member?.nickname || member?.name || '未命名玩家');
}

function memberNumber(member, fallback = '') {
  const value = member?.profile?.shortId || member?.shortId
    || member?.profile?.playerId || member?.playerId || member?.id || fallback;
  return value ? `#${String(value).replace(/^#/, '').slice(-12)}` : '玩家编号同步中';
}

function statusLabel(connection) {
  if (connection === 'open' || connection === 'online') return '在线';
  if (connection === 'connecting') return '连接中';
  if (connection === 'reconnecting') return '重连中';
  return '离线';
}

function memberConnection(member) {
  const value = member?.connection || 'online';
  if (value === 'online' || value === 'open' || value === 'connected') return 'online';
  if (value === 'reconnecting') return 'reconnecting';
  return 'offline';
}

function memberConnectionLabel(member) {
  const value = memberConnection(member);
  if (value === 'online') return '● 在线';
  if (value === 'reconnecting') return '◌ 重连中';
  return '◌ 重连中 · 离线保留';
}

function iconButton(label, className, onClick, testId) {
  return button(label, {
    className,
    attrs: { 'aria-label': label, ...(testId ? { 'data-testid': testId } : {}) },
    on: { click: onClick },
  });
}

function createModal({ title, body, confirmText = '确认', danger = false, onConfirm }) {
  const confirm = button(confirmText, {
    className: `pc-dialog__confirm${danger ? ' is-danger' : ''}`,
    attrs: { 'data-testid': 'pc-dialog-confirm' },
  });
  const cancel = button('取消', { className: 'pc-dialog__cancel' });
  const panel = element('section', {
    className: 'pc-dialog',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pc-dialog-title' },
  }, [
    element('h2', { text: title, attrs: { id: 'pc-dialog-title' } }),
    element('div', { className: 'pc-dialog__body' }, body),
    element('div', { className: 'pc-dialog__actions' }, [cancel, confirm]),
  ]);
  const overlay = element('div', { className: 'pc-dialog-layer' }, panel);
  const close = () => {
    releaseEscape();
    overlay.remove();
  };
  const releaseEscape = trapEscape(panel, close);
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    try {
      const shouldClose = await onConfirm?.();
      if (shouldClose !== false) close();
      else confirm.disabled = false;
    } catch {
      confirm.disabled = false;
    }
  });
  queueMicrotask(() => confirm.focus());
  return overlay;
}

function createRecentMatches(player, {
  compact = false,
  testId = compact ? 'pc-recent-matches' : '',
} = {}) {
  const list = element('ol', {
    className: `pc-recent-matches${compact ? ' is-compact' : ''}`,
    attrs: testId ? { 'data-testid': testId } : {},
  });
  if (!player.recentMatches.length) {
    list.appendChild(element('li', { className: 'pc-recent-matches__empty' }, [
      element('strong', { text: player.statsAvailable ? '暂无最近战绩' : '战绩正在同步' }),
      element('span', { text: player.statsAvailable ? '完成一局后会展示在这里' : '连接服务端后自动读取' }),
    ]));
    return list;
  }
  for (const match of player.recentMatches.slice(0, compact ? 3 : 8)) {
    const hero = getHero(match.heroId);
    const placement = match.placement > 0 ? `第 ${match.placement} 名` : '已结算';
    list.appendChild(element('li', {
      className: `pc-recent-match${match.placement === 1 ? ' is-win' : match.placement <= 3 ? ' is-top3' : ''}`,
    }, [
      element('span', { className: 'pc-recent-match__rank', text: placement }),
      element('span', { className: 'pc-recent-match__hero', text: hero?.name || '未知英雄' }),
      element('span', { className: 'pc-recent-match__state', text: match.survived ? '存活' : '阵亡' }),
      element('time', { text: localDate(match.playedAt), attrs: { datetime: String(match.playedAt || '') } }),
    ]));
  }
  return list;
}

function resolvedPokerStats(value) {
  return value?.confidence && typeof value.confidence === 'object' && 'available' in value
    ? value : normalizePokerStats(value);
}

function pokerTestKey(key) {
  if (key === 'threeBet') return 'threebet';
  if (key === 'foldToCbet') return 'fold-to-cbet';
  return key.toLowerCase();
}

function createPokerMetric(stats, definition, { prefix = 'pc-player-stats', detailed = false } = {}) {
  return element('div', {
    className: `pc-poker-metric${detailed ? ' is-detailed' : ''}${stats[definition.key] == null && definition.key !== 'hands' ? ' is-empty' : ''}`,
    attrs: {
      title: `${definition.name}：${definition.description}`,
      'data-testid': `${prefix}-${pokerTestKey(definition.key)}`,
    },
  }, [
    element('span', { className: 'pc-poker-metric__label', text: definition.label }),
    element('strong', { text: pokerValue(stats, definition) }),
    element('span', { className: 'pc-poker-metric__name', text: definition.name }),
    detailed && element('small', { text: definition.description }),
  ]);
}

function createPokerHud(pokerStats, {
  onOpen,
  openTestId = 'pc-player-stats-open',
  prefix = 'pc-player-stats-hud',
  compact = false,
  title = '扑克统计',
} = {}) {
  const stats = resolvedPokerStats(pokerStats);
  return element('section', {
    className: `pc-poker-hud${compact ? ' is-compact' : ''}${stats.available ? '' : ' is-empty'}`,
    attrs: { 'aria-label': `${title}，${stats.confidence.label}` },
  }, [
    element('header', { className: 'pc-poker-hud__head' }, [
      element('div', {}, [
        element('span', { className: 'pc-poker-hud__eyebrow', text: 'POKER PROFILE' }),
        element('h3', { text: title }),
      ]),
      element('span', {
        className: `pc-poker-confidence is-${stats.confidence.tone}`,
        text: stats.confidence.label,
      }),
    ]),
    element('div', { className: 'pc-poker-hud__grid' },
      POKER_CORE_STATS.map((definition) => createPokerMetric(stats, definition, { prefix }))),
    element('footer', { className: 'pc-poker-hud__footer' }, [
      element('span', { text: stats.rangeLabel }),
      onOpen && button('查看详情', {
        className: 'pc-poker-hud__open',
        attrs: { 'data-testid': openTestId },
        on: { click: onOpen },
      }),
    ]),
  ]);
}

function createPokerStatsPanel(subject, onClose, {
  panelTestId = 'pc-player-stats-panel',
  prefix = 'pc-player-stats',
} = {}) {
  const stats = resolvedPokerStats(subject?.pokerStats);
  const confidenceWidth = stats.confidence.value ?? (
    stats.confidence.tone === 'high' ? 88 : stats.confidence.tone === 'medium' ? 60
      : stats.confidence.tone === 'low' ? 32 : 0
  );
  const close = iconButton('关闭扑克统计', 'pc-poker-panel__close', onClose);
  const panel = element('section', {
    className: 'pc-poker-panel',
    attrs: {
      role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pc-poker-panel-title',
      'data-testid': panelTestId,
    },
  }, [
    element('header', { className: 'pc-poker-panel__header' }, [
      element('div', {}, [
        element('span', { className: 'pc-poker-panel__eyebrow', text: 'POKER STATISTICS' }),
        element('h2', { text: `${subject?.nickname || subject?.name || '玩家'} · 扑克统计`, attrs: { id: 'pc-poker-panel-title' } }),
        element('p', { text: `${subject?.number || ''}${subject?.number ? ' · ' : ''}${stats.rangeLabel}` }),
      ]),
      close,
    ]),
    element('div', { className: 'pc-poker-panel__confidence' }, [
      element('div', {}, [
        element('strong', { text: stats.confidence.label }),
        element('span', { text: stats.available ? `有效样本 ${stats.hands} 手` : '尚未形成可用统计样本' }),
      ]),
      element('div', { className: 'pc-poker-confidence-bar' },
        element('span', { attrs: { style: `width:${confidenceWidth}%` } })),
    ]),
    !stats.available && element('div', { className: 'pc-poker-panel__empty' }, [
      element('strong', { text: '暂无扑克统计' }),
      element('span', { text: '完成足够的真人对局后，这里会逐步形成稳定样本。' }),
    ]),
    element('section', { className: 'pc-poker-panel__section' }, [
      element('div', { className: 'pc-poker-panel__section-title' }, [
        element('h3', { text: '核心数据' }),
        element('span', { text: '首屏 HUD 指标' }),
      ]),
      element('div', { className: 'pc-poker-panel__metrics is-core' },
        POKER_CORE_STATS.map((definition) => createPokerMetric(stats, definition, { prefix, detailed: true }))),
    ]),
    element('section', { className: 'pc-poker-panel__section' }, [
      element('div', { className: 'pc-poker-panel__section-title' }, [
        element('h3', { text: '摊牌与持续下注' }),
        element('span', { text: '补充行为数据' }),
      ]),
      element('div', { className: 'pc-poker-panel__metrics' },
        POKER_DETAIL_STATS.map((definition) => createPokerMetric(stats, definition, { prefix, detailed: true }))),
    ]),
    element('footer', { className: 'pc-poker-panel__footer' }, [
      element('span', { text: '以上数据仅反映历史牌局，不会触发自动行动。' }),
      button('关闭', { className: 'pc-btn pc-btn--secondary', on: { click: onClose } }),
    ]),
  ]);
  const layer = element('div', { className: 'pc-poker-panel-layer' }, panel);
  layer.addEventListener('click', (event) => { if (event.target === layer) onClose(); });
  return { layer, panel };
}

function createProfileCard(player, state, onEdit, onStats) {
  const sync = syncStatusMeta(player);
  const statValue = (value) => player.statsAvailable ? String(value) : '—';
  return element('aside', { className: 'pc-profile-card', attrs: { 'data-testid': 'pc-player-card' } }, [
    element('div', { className: 'pc-profile-card__topline' }, [
      element('div', { className: 'pc-profile-card__eyebrow', text: 'PLAYER ACCOUNT' }),
      element('span', {
        className: `pc-profile-sync is-${sync.tone}`,
        text: sync.label,
        attrs: { 'data-testid': 'pc-player-sync' },
      }),
    ]),
    element('div', { className: 'pc-profile-card__identity' }, [
      element('span', { className: 'pc-emblem', text: player.emblem, attrs: { 'aria-hidden': 'true' } }),
      element('div', {}, [
        element('strong', { text: player.nickname }),
        element('span', {
          text: `${playerNumber(player)} · ${player.serverSynced ? '稳定玩家编号' : '连接前占位编号'}`,
          attrs: { title: player.playerId, 'data-testid': 'pc-player-id' },
        }),
      ]),
    ]),
    element('div', { className: 'pc-profile-stats', attrs: { 'aria-label': '玩家战绩' } }, [
      element('div', {}, [
        element('strong', { text: statValue(player.stats.matches), attrs: { 'data-testid': 'pc-stat-matches' } }),
        element('span', { text: '对局' }),
      ]),
      element('div', {}, [element('strong', { text: statValue(player.stats.wins) }), element('span', { text: '胜场' })]),
      element('div', {}, [element('strong', { text: statValue(player.stats.top3) }), element('span', { text: '前三' })]),
      element('div', {}, [element('strong', { text: player.statsAvailable ? percentText(player.stats.winRate) : '—' }), element('span', { text: '胜率' })]),
    ]),
    createPokerHud(player.pokerStats, { onOpen: onStats }),
    element('dl', { className: 'pc-profile-card__meta' }, [
      element('div', {}, [element('dt', { text: '当前' }), element('dd', { text: SCREEN_LABELS[state.screen] || state.screen })]),
      element('div', {}, [element('dt', { text: '网络' }), element('dd', { text: statusLabel(state.connection) })]),
      element('div', {}, [element('dt', { text: '最佳名次' }), element('dd', { text: player.stats.bestRank ? `第 ${player.stats.bestRank} 名` : '—' })]),
    ]),
    element('section', { className: 'pc-profile-card__recent' }, [
      element('h3', { text: '最近战绩' }),
      createRecentMatches(player, { compact: true }),
    ]),
    button('编辑玩家档案', {
      className: 'pc-btn pc-btn--secondary pc-profile-card__edit',
      attrs: { 'data-testid': 'pc-profile-edit' },
      on: { click: onEdit },
    }),
  ]);
}

function createProfileDrawer(player, onClose, onSave, onStats) {
  let selectedEmblem = player.emblem;
  let saving = false;
  const previewEmblem = element('span', { className: 'pc-emblem', text: player.emblem });
  const previewName = element('strong', { text: player.nickname });
  const nickname = element('input', {
    className: 'pc-field',
    attrs: {
      value: player.nickname,
      maxlength: '8',
      autocomplete: 'nickname',
      'aria-label': '玩家昵称',
      'data-testid': 'pc-profile-name',
    },
    on: { input: () => { previewName.textContent = nickname.value.trim() || '未命名玩家'; } },
  });
  const error = element('p', { className: 'pc-field-error', attrs: { 'aria-live': 'polite' } });
  const saveStatus = element('p', {
    className: 'pc-profile-save-status',
    attrs: { role: 'status', 'aria-live': 'polite', 'data-testid': 'pc-profile-save-status' },
  });
  const emblemButtons = PLAYER_EMBLEMS.map((emblem) => button(emblem, {
    className: `pc-emblem-option${emblem === selectedEmblem ? ' is-selected' : ''}`,
    attrs: { 'aria-label': `选择${emblem}纹章`, 'aria-pressed': emblem === selectedEmblem ? 'true' : 'false' },
    on: {
      click(event) {
        if (saving) return;
        selectedEmblem = emblem;
        previewEmblem.textContent = emblem;
        for (const item of emblemButtons) {
          const selected = item.textContent === emblem;
          item.classList.toggle('is-selected', selected);
          item.setAttribute('aria-pressed', selected ? 'true' : 'false');
        }
        event.currentTarget.focus();
      },
    },
  }));
  const close = iconButton('关闭玩家中心', 'pc-drawer__close', onClose);
  const cancel = button('取消', { className: 'pc-btn pc-btn--ghost', on: { click: onClose } });
  const setBusy = (busy) => {
    saving = busy;
    drawer.dataset.saving = busy ? 'true' : 'false';
    nickname.disabled = busy;
    close.disabled = busy;
    cancel.disabled = busy;
    for (const item of emblemButtons) item.disabled = busy;
  };
  const save = button('保存', {
    className: 'pc-btn pc-btn--primary',
    attrs: { 'data-testid': 'pc-profile-save' },
    on: {
      async click() {
        if (saving) return;
        const checked = validateNickname(nickname.value);
        if (!checked.ok) {
          error.textContent = checked.reason;
          nickname.focus();
          return;
        }
        error.textContent = '';
        saveStatus.className = 'pc-profile-save-status is-saving';
        saveStatus.textContent = '正在同步到服务端…';
        save.textContent = '保存中…';
        save.disabled = true;
        setBusy(true);
        try {
          const saved = await onSave({ nickname: checked.nickname, emblem: selectedEmblem });
          if (saved?.nickname) previewName.textContent = saved.nickname;
          if (saved?.emblem) previewEmblem.textContent = saved.emblem;
          saveStatus.className = 'pc-profile-save-status is-success';
          saveStatus.textContent = '保存成功，玩家档案已同步';
          save.textContent = '已保存';
          saving = false;
          drawer.dataset.saving = 'false';
          setTimeout(() => { if (drawer.isConnected) onClose(); }, 420);
        } catch (saveError) {
          setBusy(false);
          save.disabled = false;
          save.textContent = '重新保存';
          saveStatus.className = 'pc-profile-save-status is-error';
          saveStatus.textContent = saveError?.message || '保存失败，请稍后重试';
        }
      },
    },
  });
  const sync = syncStatusMeta(player);
  const drawer = element('aside', {
    className: 'pc-drawer',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pc-profile-title' },
  }, [
    element('header', { className: 'pc-drawer__header' }, [
      element('div', {}, [
        element('span', { className: 'pc-drawer__eyebrow', text: 'PLAYER ACCOUNT' }),
        element('h2', { text: '玩家中心', attrs: { id: 'pc-profile-title' } }),
      ]),
      close,
    ]),
    element('div', { className: 'pc-drawer__content' }, [
      element('div', { className: 'pc-profile-preview' }, [
        previewEmblem,
        element('div', {}, [
          previewName,
          element('span', { text: playerNumber(player), attrs: { title: player.playerId } }),
        ]),
        element('span', { className: `pc-profile-sync is-${sync.tone}`, text: sync.label }),
      ]),
      element('label', { className: 'pc-label', text: '选择纹章' }),
      element('div', { className: 'pc-emblem-options' }, emblemButtons),
      element('label', { className: 'pc-label', text: '昵称' }),
      nickname,
      element('small', { className: 'pc-help', text: '1–8 个字符，保存后同步到所有联机房间' }),
      error,
      saveStatus,
      element('div', { className: 'pc-profile-stats is-drawer' }, [
        element('div', {}, [
          element('strong', {
            text: player.statsAvailable ? String(player.stats.matches) : '—',
            attrs: { 'data-testid': 'pc-profile-stat-matches' },
          }),
          element('span', { text: '对局' }),
        ]),
        element('div', {}, [element('strong', { text: player.statsAvailable ? String(player.stats.wins) : '—' }), element('span', { text: '胜场' })]),
        element('div', {}, [element('strong', { text: player.statsAvailable ? String(player.stats.top3) : '—' }), element('span', { text: '前三' })]),
        element('div', {}, [element('strong', { text: player.statsAvailable ? percentText(player.stats.winRate) : '—' }), element('span', { text: '胜率' })]),
      ]),
      createPokerHud(player.pokerStats, {
        compact: true,
        onOpen: onStats,
        openTestId: 'pc-profile-poker-stats-open',
        prefix: 'pc-profile-poker-stats',
      }),
      element('dl', { className: 'pc-profile-detail' }, [
        element('div', {}, [element('dt', { text: '稳定玩家编号' }), element('dd', { text: playerNumber(player), attrs: { title: player.playerId } })]),
        element('div', {}, [element('dt', { text: '首次加入' }), element('dd', { text: localDate(player.createdAt) })]),
        element('div', {}, [element('dt', { text: '最近在线' }), element('dd', { text: localDate(player.lastSeenAt) })]),
      ]),
      element('section', { className: 'pc-profile-history' }, [
        element('h3', { text: '最近战绩' }),
        createRecentMatches(player, { testId: 'pc-profile-recent-matches' }),
      ]),
    ]),
    element('footer', { className: 'pc-drawer__footer' }, [cancel, save]),
  ]);
  queueMicrotask(() => nickname.focus());
  return drawer;
}

export function mountPcOnline({ root, session, onExit }) {
  let profile = loadPlayerProfile();
  let state = session.getState?.() || { screen: 'connecting', connection: 'connecting', data: {} };
  let player = normalizePlayerAccount(state, profile);
  let unsubscribe = null;
  let releaseDrawerEscape = null;
  let releaseStatsEscape = null;
  let drawerScreen = null;
  let filter = 'all';
  let roomCodeDraft = '';
  let roomCodeStatus = '';
  let roomCodeStatusTone = 'info';
  let selectedHeroId = null;
  let battleMounted = false;
  let battleController = null;
  let battleResult = null;
  let lastNoticeId = 0;
  let noticeTimer = null;
  let lastRoomId = null;
  let lastRoomMembers = new Map();
  let lastRenameAttempt = '';
  const roomEvents = [];

  function send(method, ...args) {
    const fn = session[method];
    if (typeof fn === 'function') return fn.apply(session, args);
    return undefined;
  }

  function adoptPlayerState(nextState = state) {
    const nextPlayer = normalizePlayerAccount(nextState, profile);
    if (nextPlayer.serverSynced
      && (profile.nickname !== nextPlayer.nickname || profile.emblem !== nextPlayer.emblem)) {
      profile = savePlayerProfile({
        ...profile,
        nickname: nextPlayer.nickname,
        emblem: nextPlayer.emblem,
      });
    }
    player = nextPlayer;
  }

  function leaveOnline() {
    session.destroy?.();
    onExit?.();
  }

  function closePokerStats() {
    releaseStatsEscape?.();
    releaseStatsEscape = null;
    root.querySelector('.pc-poker-panel-layer')?.remove();
  }

  function openPokerStats(subject) {
    closePokerStats();
    const { layer, panel } = createPokerStatsPanel(subject, closePokerStats);
    root.appendChild(layer);
    releaseStatsEscape = trapEscape(panel, closePokerStats);
    queueMicrotask(() => panel.querySelector('.pc-poker-panel__close')?.focus());
  }

  function openCurrentPlayerStats() {
    openPokerStats({
      nickname: player.nickname,
      number: playerNumber(player),
      pokerStats: player.pokerStats,
    });
  }

  function openProfile() {
    closeProfile();
    drawerScreen = state.screen;
    const backdrop = element('div', { className: 'pc-drawer-layer' });
    let drawer = null;
    const close = () => {
      if (drawer?.dataset.saving === 'true') return;
      closeProfile();
      render();
    };
    drawer = createProfileDrawer(player, close, async (next) => {
      let response = null;
      if (typeof session.updatePlayerProfile === 'function') {
        response = await session.updatePlayerProfile({ nickname: next.nickname, emblem: next.emblem });
        if (response === false || response?.ok === false || response?.saved === false) {
          throw new Error(
            response?.error?.message
              || (typeof response?.error === 'string' ? response.error : '')
              || response?.message
              || '服务端未能保存玩家档案',
          );
        }
      } else {
        const renamed = send('rename', next.nickname);
        if (renamed === false) throw new Error('连接尚未恢复，暂时无法保存');
      }
      profile = savePlayerProfile({ ...profile, ...next });
      const remote = response?.profile || response?.player
        || (response?.playerId || response?.shortId ? response : null)
        || session.getState?.()?.player
        || state.data?.player;
      if (remote) {
        player = normalizePlayerAccount({ ...state, player: { ...remote, nickname: next.nickname, emblem: next.emblem } }, profile);
      } else {
        player = {
          ...player,
          nickname: next.nickname,
          emblem: next.emblem,
          syncStatus: typeof session.updatePlayerProfile === 'function' ? 'syncing' : player.syncStatus,
        };
      }
      lastRenameAttempt = next.nickname;
      showNoticeMessage(
        typeof session.updatePlayerProfile === 'function' ? '玩家档案已同步' : '玩家档案已保存，本局昵称已更新',
        'success',
      );
      return player;
    }, () => {
      closeProfile();
      openCurrentPlayerStats();
    });
    backdrop.appendChild(drawer);
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
    root.appendChild(backdrop);
    releaseDrawerEscape = trapEscape(drawer, close);
  }

  function closeProfile() {
    releaseDrawerEscape?.();
    releaseDrawerEscape = null;
    drawerScreen = null;
    root.querySelector('.pc-drawer-layer')?.remove();
  }

  function showNoticeMessage(message, kind = 'info') {
    if (noticeTimer) clearTimeout(noticeTimer);
    root.querySelector('[data-testid="pc-notice"]')?.remove();
    const item = element('div', {
      className: `pc-notice is-${kind}`,
      text: message,
      attrs: { role: 'status', 'aria-live': 'polite', 'data-testid': 'pc-notice' },
    });
    root.appendChild(item);
    noticeTimer = setTimeout(() => item.remove(), 3200);
  }

  function showNotice(notice) {
    if (!notice || Number(notice.id) <= lastNoticeId) return;
    lastNoticeId = Number(notice.id);
    showNoticeMessage(notice.message, notice.kind || 'info');
  }

  function renderReconnectOverlay() {
    root.querySelector('[data-testid="pc-reconnect-overlay"]')?.remove();
    const preserved = ['room', 'pick', 'battle', 'result', 'lobby'].includes(state.screen);
    if (!preserved || !state.writeBlocked) return;
    const failed = state.connection === 'error';
    const retry = failed && button('立即重试', {
      className: 'pc-btn pc-btn--primary',
      on: { click: () => session.reconnect?.() },
    });
    root.appendChild(element('div', {
      className: 'pc-reconnect-overlay',
      attrs: {
        role: 'dialog', 'aria-modal': 'true', 'aria-label': '连接恢复中',
        'data-testid': 'pc-reconnect-overlay',
      },
    }, element('section', { className: 'pc-reconnect-overlay__panel' }, [
      element('span', { className: 'pc-reconnect-overlay__mark', text: failed ? '!' : '↻' }),
      element('strong', { text: failed ? '连接恢复失败' : '正在恢复当前会话' }),
      element('p', { text: state.error?.message || state.error || '原页面与对局状态已保留，恢复完成前暂不可操作。' }),
      retry,
    ])));
  }

  function createShell() {
    const connection = statusLabel(state.connection);
    const back = button(state.screen === 'room' || state.screen === 'pick' ? '返回大厅' : '返回首页', {
      className: 'pc-topbar__back',
      attrs: { 'data-testid': 'pc-online-back' },
      on: {
        click: () => {
          if (state.screen === 'room' || state.screen === 'pick') confirmLeave();
          else leaveOnline();
        },
      },
    });
    const profileButton = button(`${player.emblem} ${player.nickname}`, {
      className: 'pc-topbar__profile',
      attrs: { 'data-testid': 'pc-topbar-profile', title: `${playerNumber(player)} · 打开玩家中心` },
      on: { click: openProfile },
    });
    const banner = element('div', {
      className: `pc-network-banner${state.connection === 'open' || state.connection === 'online' ? '' : ' is-visible'}`,
      attrs: { role: 'status', 'aria-live': 'polite' },
      text: state.connection === 'connecting'
        ? '正在连接对战服务器，操作将在连接后开放。'
        : state.connection === 'reconnecting'
          ? '网络波动，正在恢复连接。当前页面会保留。'
          : state.connection === 'open' || state.connection === 'online'
            ? '' : '与服务器断开连接，请重试或返回首页。',
    });
    const main = element('main', { className: 'pc-online__main', attrs: { 'data-testid': `pc-screen-${state.screen}` } });
    const shell = element('div', { className: 'pc-online' }, [
      element('header', { className: 'pc-topbar' }, [
        element('div', { className: 'pc-topbar__brand', text: '群英决 · 联机' }),
        back,
        element('span', { className: 'pc-topbar__crumb', text: SCREEN_LABELS[state.screen] || '联机' }),
        element('span', { className: `pc-topbar__network is-${state.connection || 'closed'}`, text: `● ${connection}` }),
        profileButton,
      ]),
      banner,
      main,
    ]);
    return { shell, main };
  }

  function renderConnecting(main) {
    const failed = state.connection === 'closed' || state.connection === 'error' || state.error;
    main.appendChild(element('section', { className: 'pc-state-card' }, [
      element('span', { className: 'pc-state-card__mark', text: failed ? '!' : '◎' }),
      element('p', { className: 'pc-eyebrow', text: failed ? 'CONNECTION ERROR' : 'CONNECTING' }),
      element('h1', { text: failed ? '暂时无法连接' : '正在进入联机大厅' }),
      element('p', { text: failed ? (state.error?.message || state.error || '请检查对战服务器后重试。') : '正在同步房间和玩家状态…' }),
      element('div', { className: 'pc-state-card__actions' }, [
        failed && button('重新连接', {
          className: 'pc-btn pc-btn--primary',
          attrs: { 'data-testid': 'pc-retry-connect' },
          on: { click: () => session.reconnect?.() },
        }),
        button('返回首页', { className: 'pc-btn pc-btn--ghost', on: { click: leaveOnline } }),
      ]),
    ]));
  }

  function showCreateDialog() {
    root.appendChild(createModal({
      title: '创建队伍',
      body: element('div', { className: 'pc-dialog-summary' }, [
        element('p', { text: '队伍名称和房间号由系统生成，大厅内公开可见。' }),
        element('dl', {}, [
          element('div', {}, [element('dt', { text: '真人上限' }), element('dd', { text: '3 名' })]),
          element('div', {}, [element('dt', { text: 'AI 补位' }), element('dd', { text: '补足至 6 名' })]),
          element('div', {}, [element('dt', { text: '赛制' }), element('dd', { text: '固定 12 回合' })]),
        ]),
      ]),
      confirmText: '确认创建',
      onConfirm: () => send('createTeam'),
    }));
  }

  function renderLobby(main) {
    const data = state.data || {};
    if (ROOM_JOIN_ERROR_CODES.has(state.error?.code)) {
      roomCodeStatus = state.error.message || '未能加入该房间';
      roomCodeStatusTone = 'error';
    }
    const allTeams = Array.isArray(data.teams) ? data.teams : [];
    const teams = allTeams
      .filter((team) => roomMatchesFilter(team, filter))
      .sort((a, b) => {
        const aOpen = roomIsJoinable(a) ? 1 : 0;
        const bOpen = roomIsJoinable(b) ? 1 : 0;
        return bOpen - aOpen || Number(b.id) - Number(a.id);
      });
    const joinableCount = allTeams.filter(roomIsJoinable).length;
    const waitingCount = allTeams.filter((team) => roomPhase(team) === 'lobby').length;
    const playingCount = allTeams.filter((team) => ['picking', 'game', 'battle', 'playing'].includes(roomPhase(team))).length;
    const onlinePlayers = allTeams.reduce((total, team) => total + safeCount(team.onlineCount ?? team.count), 0);
    const codeFeedback = element('p', {
      className: `pc-lobby__code-status is-${roomCodeStatusTone}`,
      text: roomCodeStatus,
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    const roomInput = element('input', {
      className: 'pc-field pc-lobby__room-input',
      attrs: {
        inputmode: 'numeric', placeholder: '输入房间号', 'aria-label': '房间号',
        value: roomCodeDraft, maxlength: '10', 'data-testid': 'pc-room-id',
      },
    });
    const setCodeStatus = (message, tone = 'info') => {
      roomCodeStatus = message;
      roomCodeStatusTone = tone;
      codeFeedback.className = `pc-lobby__code-status is-${tone}`;
      codeFeedback.textContent = message;
      roomInput.setAttribute('aria-invalid', tone === 'error' ? 'true' : 'false');
    };
    const joinRoomCode = () => {
      const id = Number(roomCodeDraft.replace(/\D/g, ''));
      if (!Number.isSafeInteger(id) || id <= 0) {
        setCodeStatus('请输入有效的房间号', 'error');
        roomInput.focus();
        return;
      }
      const accepted = send('joinTeam', id);
      if (accepted === false) setCodeStatus('连接尚未恢复，请稍后再试', 'error');
      else setCodeStatus(`正在加入房间 #${id}…`, 'success');
    };
    roomInput.addEventListener('input', () => {
      roomCodeDraft = roomInput.value.replace(/\D/g, '').slice(0, 10);
      if (roomInput.value !== roomCodeDraft) roomInput.value = roomCodeDraft;
      setCodeStatus('', 'info');
    });
    roomInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') joinRoomCode();
    });
    const joinById = button('加入', {
      className: 'pc-btn pc-btn--secondary',
      attrs: { 'data-testid': 'pc-join-by-id' },
      on: { click: joinRoomCode },
    });
    const list = element('div', { className: 'pc-team-list', attrs: { role: 'list', 'data-testid': 'pc-team-list' } });
    if (!teams.length) {
      const selectedLabel = ROOM_FILTERS.find((item) => item.key === filter)?.label || '当前';
      list.appendChild(element('div', { className: 'pc-empty' }, [
        element('span', { className: 'pc-empty__mark', text: '◇' }),
        element('strong', { text: allTeams.length ? `暂无“${selectedLabel}”房间` : '大厅还没有公开房间' }),
        element('span', { text: allTeams.length ? '切换筛选条件，或通过房间号直接加入。' : '你可以创建房间，成为第一位房主。' }),
        element('div', { className: 'pc-empty__actions' }, [
          allTeams.length && filter !== 'all' && button('查看全部', {
            className: 'pc-btn pc-btn--ghost',
            on: { click: () => { filter = 'all'; render(); } },
          }),
          button('创建房间', { className: 'pc-btn pc-btn--secondary', on: { click: showCreateDialog } }),
        ]),
      ]));
    }
    for (const team of teams) {
      const maxMembers = roomCapacity(team);
      const memberCount = safeCount(team.count);
      const onlineCount = safeCount(team.onlineCount ?? memberCount);
      const joinable = roomIsJoinable(team);
      const full = memberCount >= maxMembers;
      const statusText = full && roomPhase(team) === 'lobby'
        ? '已满' : joinable ? '可加入' : PHASE_LABELS[roomPhase(team)] || '不可加入';
      const statusClass = joinable ? 'joinable'
        : full && roomPhase(team) === 'lobby' ? 'full' : roomPhase(team);
      const action = button(joinable ? '加入' : statusText, {
        className: `pc-team-row__action${joinable ? '' : ' is-disabled'}`,
        attrs: {
          disabled: !joinable,
          'data-testid': joinable ? `pc-join-team-${team.id}` : undefined,
          'aria-label': `${joinable ? '加入' : '不可加入'}${team.name || `队伍${team.id}`}`,
        },
        on: { click: () => joinable && send('joinTeam', Number(team.id)) },
      });
      list.appendChild(element('article', { className: 'pc-team-row', attrs: { role: 'listitem' } }, [
        element('div', { className: 'pc-team-row__name' }, [
          element('strong', { text: team.name || `队伍 ${team.id}` }),
          element('span', { text: `#${team.id}` }),
          team.ownerName && element('small', { text: `房主 ${team.ownerName}` }),
        ]),
        element('span', { className: 'pc-team-row__players' }, [
          element('strong', { text: `${memberCount}/${maxMembers}` }),
          element('small', { text: `${onlineCount} 人在线` }),
        ]),
        element('span', {
          className: `pc-team-row__status is-${statusClass}`,
          text: statusText,
        }),
        action,
      ]));
    }
    const filters = element('div', { className: 'pc-segmented', attrs: { 'aria-label': '房间筛选' } },
      ROOM_FILTERS.map((item) => button(item.label, {
        className: filter === item.key ? 'is-active' : '',
        attrs: {
          'aria-pressed': filter === item.key ? 'true' : 'false',
          'data-testid': `pc-room-filter-${item.key}`,
        },
        on: { click: () => { filter = item.key; render(); } },
      })));
    main.appendChild(element('div', { className: 'pc-lobby-layout' }, [
      element('section', { className: 'pc-lobby' }, [
        element('header', { className: 'pc-page-heading' }, [
          element('div', {}, [
            element('p', { className: 'pc-eyebrow', text: 'ONLINE LOBBY' }),
            element('h1', { text: '联机大厅' }),
            element('p', { text: '最多 3 名真人，开局后由 AI 补足至 6 人。' }),
          ]),
          button('创建队伍', {
            className: 'pc-btn pc-btn--primary',
            attrs: { 'data-testid': 'pc-create-team' },
            on: { click: showCreateDialog },
          }),
        ]),
        element('div', { className: 'pc-lobby-overview', attrs: { 'aria-label': '大厅实时状态' } }, [
          element('div', {}, [element('strong', { text: String(allTeams.length) }), element('span', { text: '公开房间' })]),
          element('div', {}, [element('strong', { text: String(joinableCount) }), element('span', { text: '可加入' })]),
          element('div', {}, [element('strong', { text: String(waitingCount) }), element('span', { text: '等待中' })]),
          element('div', {}, [element('strong', { text: String(playingCount) }), element('span', { text: '对局中' })]),
          element('div', {}, [element('strong', { text: String(onlinePlayers) }), element('span', { text: '大厅玩家' })]),
        ]),
        element('div', { className: 'pc-lobby__toolbar' }, [
          filters,
          element('div', { className: 'pc-lobby__join-wrap' }, [
            element('div', { className: 'pc-lobby__join-code' }, [roomInput, joinById]),
            codeFeedback,
          ]),
          iconButton('刷新', 'pc-btn pc-btn--ghost', () => send('refreshLobby'), 'pc-refresh-lobby'),
        ]),
        element('div', { className: 'pc-team-list__head' }, [
          element('span', { text: '队伍' }),
          element('span', { text: '真人 / 在线' }),
          element('span', { text: '状态' }),
          element('span', { text: '操作' }),
        ]),
        list,
      ]),
      createProfileCard(player, state, openProfile, openCurrentPlayerStats),
    ]));
  }

  function updateRoomEvents(data) {
    const members = Array.isArray(data.members) ? data.members : [];
    const roomId = String(data.id || 'unknown');
    const nextMembers = new Map(members.map((member) => [
      String(member.profile?.playerId || member.playerId
        || member.profile?.shortId || member.shortId || member.id || `name:${memberName(member)}`),
      {
        name: memberName(member),
        owner: Boolean(member.isOwner),
        connection: memberConnection(member),
        emblem: member.profile?.emblem || member.emblem || '',
      },
    ]));
    const pushEvent = (text, tone = 'info') => {
      roomEvents.unshift({
        text,
        tone,
        time: new Intl.DateTimeFormat('zh-CN', {
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        }).format(new Date()),
      });
      roomEvents.splice(10);
    };
    if (lastRoomId !== roomId) {
      roomEvents.length = 0;
      lastRoomMembers = new Map();
      lastRoomId = roomId;
      pushEvent(`已进入 ${data.name || '队伍房间'}`, 'success');
    }
    for (const [key, member] of nextMembers) {
      const previous = lastRoomMembers.get(key);
      if (!previous) {
        if (lastRoomMembers.size) pushEvent(`${member.name} 加入了房间`, 'success');
        continue;
      }
      if (previous.name !== member.name) pushEvent(`${previous.name} 更新昵称为 ${member.name}`);
      if (!previous.owner && member.owner) pushEvent(`${member.name} 成为房主`, 'owner');
      if (previous.connection !== member.connection) {
        if (member.connection === 'online') pushEvent(`${member.name} 已恢复在线`, 'success');
        else if (member.connection === 'reconnecting') pushEvent(`${member.name} 正在重新连接`, 'warning');
        else pushEvent(`${member.name} 暂时离线，席位已保留`, 'warning');
      }
      if (previous.emblem && member.emblem && previous.emblem !== member.emblem) {
        pushEvent(`${member.name} 更新了玩家纹章`);
      }
    }
    for (const [key, previous] of lastRoomMembers) {
      if (!nextMembers.has(key)) pushEvent(`${previous.name} 离开了房间`, 'warning');
    }
    lastRoomMembers = nextMembers;
  }

  function confirmLeave() {
    const members = state.data?.members || [];
    const me = members.find((member) => member.isYou);
    const nextOwner = members.find((member) => !member.isYou);
    const text = me?.isOwner && nextOwner
      ? `退出后房主将自动移交给 ${nextOwner.name}，确定退出？`
      : '退出后将返回联机大厅，确定退出？';
    root.appendChild(createModal({
      title: '退出队伍',
      body: element('p', { text }),
      confirmText: '确认退出',
      danger: true,
      onConfirm: () => send('leaveTeam'),
    }));
  }

  function renderRoom(main) {
    const data = state.data || {};
    const members = Array.isArray(data.members) ? data.members : [];
    updateRoomEvents(data);
    const me = members.find((member) => member.isYou);
    const unavailableMembers = members.filter((member) => memberConnection(member) !== 'online');
    if (typeof session.updatePlayerProfile !== 'function'
      && me && profile.nickname !== memberName(me) && profile.nickname !== lastRenameAttempt) {
      lastRenameAttempt = profile.nickname;
      queueMicrotask(() => send('rename', profile.nickname));
    }
    const rules = data.rules || {};
    const maxMembers = safeCount(data.maxMembers || rules.maxMembers) || 3;
    const totalPlayers = safeCount(data.totalPlayers || rules.totalPlayers) || 6;
    const roundCount = safeCount(data.rounds || rules.rounds) || 12;
    const phase = roomPhase(data);
    const phaseLabel = PHASE_LABELS[phase] || (phase === 'lobby' ? '等待中' : phase);
    const seats = [];
    for (let index = 0; index < maxMembers; index++) {
      const member = members[index];
      if (!member) {
        seats.push(element('article', { className: 'pc-room-seat is-empty' }, [
          element('span', { className: 'pc-room-seat__empty-mark', text: '+' }),
          element('strong', { text: `真人席位 ${index + 1}` }),
          element('span', { text: '等待玩家加入' }),
          element('small', { text: '开局后由 AI 补位' }),
        ]));
        continue;
      }
      const connection = memberConnection(member);
      const rawMemberStats = member.profile?.stats || member.stats || {};
      const memberMatches = safeCount(rawMemberStats.matches);
      const memberWins = safeCount(rawMemberStats.wins);
      const record = memberMatches > 0 ? `${memberWins} 胜 / ${memberMatches} 局` : '战绩同步中';
      const memberPoker = normalizePokerStats(member.profile?.pokerStats || member.pokerStats);
      const memberSubject = {
        nickname: memberName(member),
        number: member.isYou ? playerNumber(player) : memberNumber(member),
        pokerStats: memberPoker,
      };
      const openMemberStats = () => openPokerStats(memberSubject);
      seats.push(element('article', {
        className: `pc-room-seat${member.isYou ? ' is-you' : ''}${member.isOwner ? ' is-owner' : ''} is-${connection}`,
        attrs: {
          'data-testid': 'pc-room-member',
          'data-is-you': member.isYou ? 'true' : 'false',
          'data-owner': member.isOwner ? 'true' : 'false',
        },
      }, [
        element('div', { className: 'pc-room-seat__identity' }, [
          button(member.profile?.emblem || member.emblem || (member.isYou ? player.emblem : '侠'), {
            className: 'pc-emblem pc-emblem--small',
            attrs: {
              'data-testid': 'pc-room-member-emblem',
              'aria-label': `查看${memberName(member)}的扑克统计`,
            },
            on: { click: openMemberStats },
          }),
          element('div', {}, [
            element('strong', { text: memberName(member), attrs: { 'data-testid': 'pc-room-member-name' } }),
            element('span', {
              text: member.isYou ? playerNumber(player) : memberNumber(member),
              attrs: {
                title: member.profile?.playerId || member.playerId || (member.isYou ? player.playerId : ''),
                'data-testid': 'pc-room-member-id',
              },
            }),
          ]),
        ]),
        element('div', { className: 'pc-room-seat__badges' }, [
          element('span', { className: 'pc-badge is-seat', text: `席位 ${index + 1}` }),
          member.isYou && element('span', { className: 'pc-badge', text: '你' }),
          member.isOwner && element('span', { className: 'pc-badge is-owner', text: '房主' }),
        ]),
        element('div', { className: 'pc-room-seat__record' }, [
          element('span', { text: '联机战绩' }),
          element('strong', { text: record }),
        ]),
        button('', {
          className: `pc-room-seat__poker${memberPoker.available ? '' : ' is-empty'}`,
          attrs: {
            'data-testid': 'pc-room-member-stats-open',
            'aria-label': `打开${memberName(member)}的详细扑克统计`,
          },
          on: { click: openMemberStats },
        }, POKER_CORE_STATS.map((definition) => element('span', {}, [
          element('small', { text: definition.label === 'HANDS' ? '手数' : definition.label }),
          element('strong', { text: pokerValue(memberPoker, definition) }),
        ]))),
        element('span', {
          className: `pc-room-seat__network is-${connection}`,
          text: memberConnectionLabel(member),
        }),
      ]));
    }
    const aiCount = Math.max(0, totalPlayers - members.length);
    const isOwner = Boolean(data.isOwner || me?.isOwner);
    const startBlocked = unavailableMembers.length > 0;
    const primary = isOwner
      ? button('开始选将', {
        className: 'pc-btn pc-btn--primary pc-room__start',
        attrs: {
          'data-testid': 'pc-start-pick',
          disabled: startBlocked,
          title: startBlocked ? '有成员正在重连或离线保留，暂不能开始' : undefined,
        },
        on: { click: () => send('startPick') },
      })
      : element('div', { className: 'pc-room__waiting', text: '等待房主开始选将…' });
    main.appendChild(element('div', { className: 'pc-room-layout' }, [
      element('section', { className: 'pc-room' }, [
        element('header', { className: 'pc-page-heading' }, [
          element('div', {}, [
            element('p', { className: 'pc-eyebrow', text: `ROOM #${data.id || ''}` }),
            element('h1', { text: data.name || '队伍房间' }),
            element('p', { text: `${members.length} 名真人席位，开局后由 ${aiCount} 名 AI 补足 ${totalPlayers} 个席位。` }),
          ]),
          element('span', { className: `pc-room__phase is-${phase}`, text: phaseLabel }),
        ]),
        element('div', { className: 'pc-room__section-title' }, [
          element('h2', { text: `真人席位 ${members.length}/${maxMembers}` }),
          element('span', { text: unavailableMembers.length ? '存在离线保留席位，恢复后可开局' : '成员均在线，房主可开始选将' }),
        ]),
        element('div', { className: 'pc-room-seats', attrs: { 'data-testid': 'pc-room-members' } }, seats),
      ]),
      element('aside', { className: 'pc-room-sidebar' }, [
        element('section', { className: 'pc-room-summary' }, [
          element('h2', { text: '房间信息' }),
          element('dl', {}, [
            element('div', {}, [element('dt', { text: '房间号' }), element('dd', { text: `#${data.id || '—'}` })]),
            element('div', {}, [element('dt', { text: '可见性' }), element('dd', { text: data.visibility === 'private' ? '仅凭房号' : '大厅公开' })]),
            element('div', {}, [element('dt', { text: '真人' }), element('dd', { text: `${members.length}/${maxMembers}` })]),
            element('div', {}, [element('dt', { text: '当前状态' }), element('dd', { text: phaseLabel })]),
          ]),
        ]),
        element('section', { className: 'pc-room-rules' }, [
          element('h2', { text: '本局规则' }),
          element('div', { className: 'pc-room-rule-grid' }, [
            element('div', {}, [element('strong', { text: String(totalPlayers) }), element('span', { text: '总席位' })]),
            element('div', {}, [element('strong', { text: String(aiCount) }), element('span', { text: 'AI 补位' })]),
            element('div', {}, [element('strong', { text: String(roundCount) }), element('span', { text: '回合' })]),
            element('div', {}, [element('strong', { text: rules.modeName || '标准' }), element('span', { text: '模式' })]),
          ]),
        ]),
        element('section', { className: 'pc-room-events' }, [
          element('h2', { text: '房间动态' }),
          element('ol', {}, roomEvents.length
            ? roomEvents.map((roomEvent) => element('li', { className: `is-${roomEvent.tone}` }, [
              element('time', { text: roomEvent.time }),
              element('span', { text: roomEvent.text }),
            ]))
            : [element('li', {}, [element('span', { text: '等待房间动态' })])]),
        ]),
        element('div', { className: 'pc-room-actions' }, [
          primary,
          startBlocked && element('p', {
            className: 'pc-room__connection-warning',
            text: `${unavailableMembers.length} 名成员正在重连或离线保留，恢复后才能开始。`,
          }),
          button('编辑玩家档案', { className: 'pc-btn pc-btn--secondary', on: { click: openProfile } }),
          button('退出队伍', {
            className: 'pc-btn pc-btn--danger',
            attrs: { 'data-testid': 'pc-leave-team' },
            on: { click: confirmLeave },
          }),
        ]),
      ]),
    ]));
  }

  function renderPick(main) {
    const data = state.data || {};
    const unavailableMembers = (data.members || []).filter((member) => memberConnection(member) !== 'online');
    const startBlocked = unavailableMembers.length > 0;
    const options = Array.isArray(data.heroes) ? data.heroes : HEROES.map((hero) => ({ id: hero.id }));
    if (!selectedHeroId) selectedHeroId = options.find((item) => item.mine)?.id || options.find((item) => !item.takenBy)?.id || HEROES[0].id;
    const selected = getHero(selectedHeroId) || HEROES[0];
    const selectedOption = options.find((item) => item.id === selected.id) || {};
    const grid = element('div', { className: 'pc-pick-grid', attrs: { role: 'list', 'data-testid': 'pc-pick-grid' } });
    for (const option of options) {
      const hero = getHero(option.id);
      if (!hero) continue;
      const unavailable = Boolean(option.takenBy && !option.mine);
      const card = button('', {
        className: `pc-pick-card${hero.id === selectedHeroId ? ' is-selected' : ''}${option.mine ? ' is-mine' : ''}${unavailable ? ' is-taken' : ''}`,
        attrs: {
          disabled: unavailable,
          'data-testid': `pc-pick-${hero.id}`,
          'aria-label': `${hero.name}，${option.mine ? '已选定' : unavailable ? `已被${option.takenBy}选择` : '可选择'}`,
        },
        on: { click: () => { selectedHeroId = hero.id; render(); } },
      });
      const portrait = element('span', { className: 'pc-pick-card__portrait' });
      portrait.style.backgroundImage = `url("${hero.portrait}")`;
      card.append(
        portrait,
        element('span', { className: 'pc-pick-card__name', text: hero.name }),
        element('span', { className: 'pc-pick-card__type', text: hero.type }),
        element('span', { className: 'pc-pick-card__state', text: option.mine ? '已选定' : unavailable ? `已被 ${option.takenBy} 选择` : '查看详情' }),
      );
      grid.appendChild(card);
    }
    const detailPortrait = element('div', { className: 'pc-pick-detail__portrait' });
    detailPortrait.style.backgroundImage = `url("${selected.portrait}")`;
    const choose = button(selectedOption.mine ? '已选，可更换' : '选择该英雄', {
      className: 'pc-btn pc-btn--primary pc-pick-detail__choose',
      attrs: {
        disabled: Boolean(selectedOption.takenBy && !selectedOption.mine),
        'data-testid': 'pc-confirm-hero',
      },
      on: { click: () => send('pickHero', selected.id) },
    });
    main.appendChild(element('section', { className: 'pc-pick' }, [
      element('header', { className: 'pc-page-heading pc-pick__header' }, [
        element('div', {}, [
          element('p', { className: 'pc-eyebrow', text: 'HERO DRAFT' }),
          element('h1', { text: '选择英雄' }),
          element('p', { text: '英雄不可重复，服务端确认后才算选定。' }),
        ]),
        element('span', { className: 'pc-pick__timer', text: `剩余 ${data.deadline || 0} 秒` }),
      ]),
      element('div', { className: 'pc-pick__body' }, [
        grid,
        element('aside', { className: 'pc-pick-detail' }, [
          detailPortrait,
          element('div', { className: 'pc-pick-detail__title' }, [
            element('h2', { text: selected.name }),
            element('span', { text: selected.type }),
          ]),
          element('h3', { text: `主动 · ${selected.skillName} · ${selected.skillCost}⚡` }),
          element('p', { text: selected.skillDesc }),
          element('small', { text: `发动条件：${selected.condDesc}` }),
          element('h3', { text: '被动' }),
          element('p', { text: selected.passiveDesc }),
          element('blockquote', { text: `“${selected.lines?.enter || ''}”` }),
          choose,
          data.isOwner && button(startBlocked ? '等待成员恢复' : data.allPicked ? '开战' : '等待全员选定', {
            className: 'pc-btn pc-btn--danger pc-pick-detail__start',
            attrs: {
              disabled: !data.allPicked || startBlocked,
              'data-testid': 'pc-start-game',
              title: startBlocked ? '有成员正在重连或离线保留' : undefined,
            },
            on: { click: () => send('startGame') },
          }),
          startBlocked && element('p', {
            className: 'pc-room__connection-warning',
            text: `${unavailableMembers.length} 名成员正在重连或离线保留，恢复后才能开战。`,
          }),
          !data.isOwner && element('p', { className: 'pc-pick-detail__waiting', text: data.allPicked ? '等待房主开战…' : '等待其他玩家选定…' }),
        ]),
      ]),
    ]));
  }

  function renderResult(main, ranking = [], mySeat = 1) {
    const rows = ranking.map((player, index) => {
      const isMe = player.idx === mySeat;
      const hero = player.hero || getHero(player.heroId) || HEROES[0];
      const portrait = element('span', { className: 'pc-result-row__portrait' });
      portrait.style.backgroundImage = `url("${hero.portrait}")`;
      return element('li', { className: `pc-result-row${isMe ? ' is-you' : ''}` }, [
        element('strong', { className: 'pc-result-row__rank', text: index < 3 ? ['冠', '亚', '季'][index] : String(index + 1) }),
        portrait,
        element('span', { className: 'pc-result-row__name', text: `${hero.name}${player.playerName ? ` · ${player.playerName}` : ''}${isMe ? '（你）' : ''}` }),
        element('span', { className: 'pc-result-row__state', text: player.alive ? `存活 · 气血 ${player.hp}` : `第 ${player.deathRound || '?'} 回合阵亡` }),
      ]);
    });
    const myRank = Math.max(0, ranking.findIndex((player) => player.idx === mySeat)) + 1;
    main.appendChild(element('section', { className: 'pc-result' }, [
      element('div', { className: 'pc-result__summary' }, [
        element('p', { className: 'pc-eyebrow', text: 'BATTLE RESULT' }),
        element('h1', { text: myRank ? `本局第 ${myRank} 名` : '本局结算' }),
        element('p', { text: myRank === 1 ? '傲视群雄' : myRank <= 3 ? '虽败犹荣' : '胜负乃兵家常事' }),
        button('返回队伍', {
          className: 'pc-btn pc-btn--primary',
          attrs: { 'data-testid': 'pc-back-to-room' },
          on: { click: () => { battleResult = null; send('backToRoom'); } },
        }),
      ]),
      element('ol', { className: 'pc-result__ranking' }, rows),
    ]));
  }

  function mountBattle() {
    if (battleMounted) return;
    const battleSession = state.battle;
    if (!battleSession) return;
    battleMounted = true;
    const engine = battleSession.engine || battleSession;
    const listeners = battleSession.listeners || engine.listeners || {};
    const mySeat = state.data?.mySeat || battleSession.myIdx || engine.myIdx || 1;
    battleController = attachBattle(engine, listeners, mySeat, (ranking) => {
      battleResult = { ranking, mySeat };
      battleMounted = false;
      render();
    });
  }

  function render() {
    closeProfile();
    closePokerStats();
    if (state.screen === 'battle' && !battleResult) {
      mountBattle();
      return;
    }
    battleMounted = false;
    battleController?.destroy?.();
    battleController = null;
    const { shell, main } = createShell();
    clear(root, shell);
    if (battleResult) renderResult(main, battleResult.ranking, battleResult.mySeat);
    else if (state.screen === 'lobby') renderLobby(main);
    else if (state.screen === 'room') renderRoom(main);
    else if (state.screen === 'pick') renderPick(main);
    else if (state.screen === 'result') renderResult(main, state.data?.ranking || [], state.data?.mySeat || 1);
    else renderConnecting(main);
  }

  unsubscribe = session.subscribe?.((nextState) => {
    const previousScreen = state.screen;
    const drawerOpen = Boolean(root.querySelector('.pc-drawer-layer'));
    state = nextState || state;
    adoptPlayerState(state);
    if (state.screen !== 'battle') battleMounted = false;
    if (!(drawerOpen && drawerScreen === state.screen && previousScreen === state.screen)) {
      render();
    }
    renderReconnectOverlay();
    showNotice(state.notice);
  });
  if (!unsubscribe) render();

  return {
    tick(dt) {
      session.tick?.(dt);
      battleController?.tick?.(dt);
    },
    destroy() {
      unsubscribe?.();
      if (noticeTimer) clearTimeout(noticeTimer);
      closeProfile();
      closePokerStats();
      battleController?.destroy?.();
      battleController = null;
      session.destroy?.();
      clear(root);
    },
  };
}
