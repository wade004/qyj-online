import * as Config from '../../game/config.js';
import * as Advisor from '../../game/advisor.js';
import { cardText } from '../../game/engine.js';
import { describe, isPlayerMadeStrongHand } from '../../game/handeval.js';
import { playSFX } from '../../audio.js';
import {
  H5_CARD_BACK,
  H5_CARD_FACES,
  h5HeroPortrait,
} from '../../services/asset-variants.js';
import { button, clear, element, trapEscape } from '../shared/dom.js';

const ACTION_LABELS = Object.freeze({
  fold: '退避', check: '静观', call: '应战', allin: '决死',
  feint: '佯攻', strike: '强攻', fierce: '猛攻',
  smallBlind: '小血祭', bigBlind: '大血祭',
});

const STREET_FEEDBACK_LABELS = Object.freeze({
  flop: '天时', turn: '地利', river: '人和',
});

const cardSignature = (card) => `${card?.rank || 0}:${card?.suit || 0}`;
const UNIFIED_SKILL_GLYPH = '技';
const heroSkillTooltip = (hero) => {
  const active = hero?.skills?.active;
  const passive = hero?.skills?.passive;
  return [
    `主动【${active?.name || hero?.skillName || '未知'}】${active?.cost ?? hero?.skillCost ?? 0}⚡`,
    active?.description || hero?.skillDesc || '',
    `条件：${active?.conditionDescription || hero?.condDesc || '满足技能发动条件'}`,
    `被动【${passive?.name || '未知'}】${passive?.description || hero?.passiveDesc || ''}`,
  ].filter(Boolean).join(' · ');
};
const h5HandEffectTier = (category) => (
  category >= 7 ? 'legendary' : category >= 4 ? 'strong' : 'made'
);

/**
 * A displayed two-pair is only a personal major hand when both distinct hole
 * cards belong to the evaluated pair cores. This excludes a board pair plus
 * one matched hole card, a pocket pair plus a board pair, and two pair already
 * present on the board. Categories above two pair keep the established major
 * hand threshold; the transient hit notice still requires a hole-card core.
 */
export const isH5StrongMadeHand = isPlayerMadeStrongHand;
export const shouldRenderH5PortraitReveal = (playerIdx, myIdx) => (
  Number(playerIdx) !== Number(myIdx)
);

export function classifyH5PremiumStartingHand(hole = []) {
  if (!Array.isArray(hole) || hole.length < 2) return null;
  const [first, second] = hole;
  const high = Math.max(Number(first?.rank) || 0, Number(second?.rank) || 0);
  const low = Math.min(Number(first?.rank) || 0, Number(second?.rank) || 0);
  const pair = high === low;
  const suited = Number(first?.suit) === Number(second?.suit);
  const premium = (pair && high >= 10)
    || (high === 14 && low >= 12)
    || (suited && ((high === 14 && low === 11) || (high === 13 && low === 12)));
  if (!premium) return null;
  const rankLabel = (rank) => ({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T' })[rank] || String(rank);
  return {
    category: 1,
    stage: '天时',
    name: '强力起手',
    poker: pair ? `${rankLabel(high)}${rankLabel(low)}` : `${rankLabel(high)}${rankLabel(low)}${suited ? 's' : 'o'}`,
    tier: 'premium',
    strong: true,
  };
}

function requestH5StrongHandVibration(tier = 'strong') {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
  const pattern = tier === 'legendary' ? [90, 45, 140]
    : tier === 'strong' ? [70, 40, 110]
      : tier === 'premium' ? [55, 35, 90]
        : [55, 35, 85];
  try {
    return navigator.vibrate(pattern);
  } catch {
    return false;
  }
}

export function classifyH5HandHit(
  previousCategory,
  current,
  hole = [],
  street = '',
  previousStrong = false,
) {
  if (!current || !Number.isFinite(current.cat) || !Number.isFinite(previousCategory)) return null;
  const strong = isH5StrongMadeHand(current, hole);
  const categoryImproved = current.cat > previousCategory;
  const enteredStrong = strong && !previousStrong;
  if (current.cat < 2 || (!categoryImproved && !enteredStrong)) return null;
  const holeCards = new Set(hole.map(cardSignature));
  const usesHole = (current.core || []).some((card) => holeCards.has(cardSignature(card)));
  if (!usesHole) return null;
  if (current.cat === 3 && !strong) return null;
  return {
    category: current.cat,
    stage: STREET_FEEDBACK_LABELS[street] || '天机',
    name: current.name,
    poker: current.poker,
    tier: h5HandEffectTier(current.cat),
    strong,
  };
}

export function classifyH5RoundOutcome({ net = 0, folded = false, detail = '' } = {}) {
  const value = Number.isFinite(Number(net)) ? Math.round(Number(net)) : 0;
  const tone = value > 0 ? 'win' : value < 0 ? 'loss' : 'draw';
  return {
    tone,
    title: tone === 'win' ? '本回合获胜' : tone === 'loss' ? '本回合失利' : '本回合平局',
    amount: value > 0 ? `净赢 +${value}` : value < 0 ? `净负 ${value}` : '净收益 0',
    detail: detail || (folded ? '本回合已退避' : '血池结算完成'),
    net: value,
  };
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

function playerStatsContent(player, prefix) {
  const stats = normalizePokerStats(player?.pokerStats);
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
      element('span', { text: player?.isHuman ? '旧数据尚未形成可用样本。' : '本地 AI 不提供玩家统计。' }),
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

function makeCard(className, slotName = '') {
  const suit = element('img', {
    className: 'h5-card__suit',
    attrs: { alt: '', draggable: 'false', hidden: true },
  });
  const backLabel = element('span', { className: 'h5-card__back-label', text: slotName || '暗令' });
  const back = element('span', { className: 'h5-card__back' }, backLabel);
  const backImage = new URL(H5_CARD_BACK, document.baseURI).href;
  back.style.setProperty('--h5-card-back-image', `url("${backImage}")`);
  const root = element('div', { className: `h5-card ${className}` }, [suit, back]);
  return {
    root,
    setCard(card) {
      if (!card) return this.faceDown(slotName);
      const info = Config.SUITS[card.suit];
      const faceImage = H5_CARD_FACES[card.rank];
      const suitImage = Config.SUIT_IMGS[card.suit];
      root.style.backgroundImage = faceImage ? `url("${faceImage}")` : '';
      if (suitImage) suit.src = suitImage;
      else suit.removeAttribute('src');
      suit.hidden = !suitImage;
      root.classList.toggle('is-red', Boolean(info?.red));
      root.classList.add('is-face-up');
      root.setAttribute('aria-label', cardText(card));
      back.hidden = true;
    },
    faceDown(label = slotName) {
      root.style.backgroundImage = '';
      suit.hidden = true;
      suit.removeAttribute('src');
      backLabel.textContent = label || '暗令';
      back.hidden = false;
      root.classList.remove('is-face-up', 'is-red');
      root.setAttribute('aria-label', label || '暗令未揭示');
    },
  };
}

function actionText(key, amount = 0, allIn = false) {
  const value = Math.max(0, Math.round(Number(amount) || 0));
  const label = ACTION_LABELS[key] || key || '';
  if (key === 'fold' || key === 'check') return label;
  if (key === 'call') return `${allIn ? '决死应战' : label}${value > 0 ? ` ${value}` : ''}`;
  if (key === 'allin') return `决死${value > 0 ? ` ${value}` : ''}`;
  if (key === 'smallBlind' || key === 'bigBlind') return `${label}${value > 0 ? ` ${value}` : ''}`;
  if (allIn && label) return `决死·${label}${value > 0 ? ` ${value}` : ''}`;
  return value > 0 ? `${label} ${value}` : label;
}

function makePlayerStatus(className, testId) {
  const timer = element('span', {
    className: 'h5-player-status__timer',
    attrs: { 'aria-hidden': 'true' },
  });
  const label = element('span', { className: 'h5-player-status__label' });
  const root = element('span', {
    className,
    attrs: { 'data-testid': testId, 'data-state': 'idle' },
  }, [timer, label]);
  return { root, timer, label };
}

export function classifyH5SeatStatus(player, {
  isTurn = false,
  hasActiveTurn = false,
  lastAction = null,
} = {}) {
  const action = lastAction || player?.lastAction || null;
  const actionLabel = action?.key
    ? actionText(action.key, action.amount, Boolean(player?.allIn))
    : '';
  if (!player?.alive) return { state: 'dead', label: '阵亡' };
  if (player.folded) return { state: 'folded', label: '已退避' };
  if (player.allIn) {
    const allInAmount = Math.max(0, Math.round(Number(action?.amount ?? player.betRound) || 0));
    const label = actionLabel.includes('决死')
      ? actionLabel
      : `决死${allInAmount > 0 ? ` ${allInAmount}` : ''}`;
    return { state: 'allin', label };
  }
  if (isTurn) return { state: 'turn', label: '轮到行动' };
  if (player.acted) {
    return { state: 'acted', label: actionLabel ? `已${actionLabel}` : '已操作' };
  }
  if (actionLabel) return { state: 'waiting', label: `待响应 · ${actionLabel}` };
  if (hasActiveTurn) return { state: 'waiting', label: '等待他人' };
  return { state: 'idle', label: '尚未行动' };
}

export function mountH5Battle({ root, battle, myIdx = 1, onGameOver, onLeave }) {
  const engine = battle;
  const listeners = battle.listeners || {};
  const players = engine.players;
  const playerCount = Math.max(1, Number(engine.tableSize) || players.length - 1);
  const me = players[myIdx];
  const previousListeners = new Map();
  let destroyed = false;
  let awaiting = false;
  let pending = false;
  let lastOptions = null;
  let timeLeft = 0;
  let timerTotal = Config.ACTION_TIME;
  let observedTurnClock = null;
  let turnClockSequence = 0;
  let turnIdx = null;
  let actionPhaseStarted = false;
  let skillElapsed = 0;
  let confirmAction = null;
  let confirmTimer = 0;
  let releaseDrawerEscape = null;
  let adviceCacheKey = '';
  let adviceCache = null;
  let strengthCacheKey = '';
  let strengthCache = null;
  let strengthPauseLabel = '';
  let lastHandCategory = null;
  let lastStrongHandActive = false;
  let lastHandHitAt = 0;
  let lastStrongHandVibrationKey = '';
  let handHitTimer = null;
  let handCoreTimer = null;
  let roundResultTimer = null;
  let roundResultDelayTimer = null;
  let advisorEnabled = true;
  try {
    advisorEnabled = localStorage.getItem('qyj-ai-assist') !== 'off';
  } catch {
    // The advisor remains available for this session when storage is blocked.
  }

  const roundText = element('span', { className: 'h5-battle__round', text: `第 1/${Config.MAX_ROUNDS} 回合` });
  const blindText = element('span', { className: 'h5-battle__blind', text: '血祭 10/20' });
  const networkText = element('span', { className: 'h5-battle__network', text: '● 联网' });
  const logButton = button('战报', { className: 'h5-icon-button', attrs: { 'data-testid': 'h5-open-log' } });
  const leaveButton = button('离开', {
    className: 'h5-icon-button h5-battle__leave',
    attrs: { 'data-testid': 'h5-leave-battle', 'aria-label': '离开当前牌局并启用系统托管' },
    on: { click: () => onLeave?.() },
  });
  const refreshLeaveButton = () => {
    leaveButton.dataset.playerAlive = me?.alive ? 'true' : 'false';
    leaveButton.setAttribute(
      'aria-label',
      me?.alive ? '离开当前牌局并启用系统托管' : '离开当前牌局',
    );
  };
  const advisorToggle = element('input', {
    attrs: {
      type: 'checkbox',
      'data-testid': 'h5-advisor-toggle',
      'aria-label': '开启或关闭 GTO AI 辅助',
    },
  });
  advisorToggle.checked = advisorEnabled;
  const advisorToggleLabel = element('label', {
    className: 'h5-icon-button h5-advisor-toggle',
    attrs: { title: '只读本地策略分析，不会自动操作' },
  }, [advisorToggle, element('span', { text: 'AI辅助' })]);
  const potText = element('div', { className: 'h5-battle__pot', text: '主池 0', attrs: { 'aria-live': 'polite' } });
  const hintText = element('div', { className: 'h5-battle__hint', attrs: { 'aria-live': 'polite' } });
  const strengthFill = element('span', { className: 'h5-hand-strength__fill' });
  const strengthValue = element('strong', {
    className: 'h5-hand-strength__value',
    text: '--',
    attrs: { 'data-testid': 'h5-hand-strength-value' },
  });
  const strengthGrade = element('span', {
    className: 'h5-hand-strength__grade',
    text: '等待发牌',
    attrs: { 'data-testid': 'h5-hand-strength-grade' },
  });
  const handStrength = element('div', {
    className: 'h5-hand-strength',
    attrs: {
      'data-testid': 'h5-hand-strength',
      role: 'progressbar',
      'aria-label': '实时牌力',
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuetext': '等待发牌',
      title: '根据公开牌、剩余对手及未知暗牌进行估算',
    },
  }, [
    element('span', { className: 'h5-hand-strength__label', text: '牌力' }),
    element('span', { className: 'h5-hand-strength__track' }, strengthFill),
    strengthValue,
    strengthGrade,
  ]);
  const logList = element('div', { className: 'h5-log-list', attrs: { role: 'log', 'aria-live': 'polite' } });

  const advisorRecommendation = element('strong', {
    className: 'h5-gto-advice__recommendation',
    text: '', attrs: { 'data-testid': 'h5-gto-recommendation' },
  });
  const advisorConfidence = element('span', {
    className: 'h5-gto-advice__confidence',
    text: '', attrs: { 'data-testid': 'h5-gto-confidence' },
  });
  const advisorOptions = element('span', {
    className: 'h5-gto-advice__options',
    text: '', attrs: { 'data-testid': 'h5-gto-options' },
  });
  const advisorReason = element('span', {
    className: 'h5-gto-advice__reason',
    text: '', attrs: { 'data-testid': 'h5-gto-reason' },
  });
  const advisorMetrics = element('span', {
    className: 'h5-gto-advice__metrics',
    text: '', attrs: { 'data-testid': 'h5-gto-metrics' },
  });
  const advisorEmpty = element('span', {
    className: 'h5-gto-advice__empty',
    text: '等待你的行动', attrs: { 'data-testid': 'h5-gto-empty' },
  });
  const advisorContent = element('div', {
    className: 'h5-gto-advice__content', attrs: { hidden: true },
  }, [
    element('div', { className: 'h5-gto-advice__head' }, [
      element('span', { text: 'GTO近似 · ' }), advisorRecommendation,
      element('span', { text: ' · ' }), advisorConfidence,
    ]),
    advisorOptions,
    advisorReason,
    advisorMetrics,
  ]);
  const advisorPanel = element('aside', {
    className: 'h5-gto-advice',
    attrs: {
      'data-testid': 'h5-gto-advice',
      'aria-label': 'GTO AI 辅助建议',
      'aria-live': 'polite',
    },
  }, [advisorEmpty, advisorContent]);
  const feedbackLayer = element('div', {
    className: 'h5-battle-feedback',
    attrs: { 'aria-live': 'assertive', 'aria-atomic': 'true' },
  });
  const chipFlightLayer = element('div', {
    className: 'h5-chip-flight-layer',
    attrs: { 'aria-hidden': 'true' },
  });

  const seatMap = new Map();
  const publicHoleCards = new Map();
  const statusNodes = new Map();
  const seatActions = new Map();
  const opponents = element('div', {
    className: 'h5-opponents',
    attrs: { 'data-player-count': String(playerCount) },
  });
  const skillHoverPreview = element('aside', {
    className: 'h5-seat-skill-preview',
    attrs: {
      hidden: true,
      role: 'tooltip',
      'data-testid': 'h5-seat-skill-preview',
      'aria-live': 'polite',
    },
  });
  const relativeSeats = [];
  for (let offset = 1; offset <= playerCount - 1; offset++) {
    const idx = ((myIdx - 1 + offset) % playerCount) + 1;
    relativeSeats.push(idx);
    const player = players[idx];
    const portrait = element('span', {
      className: 'h5-seat__portrait',
      attrs: { 'aria-hidden': 'true', 'data-testid': `h5-seat-portrait-${idx}` },
    });
    portrait.style.backgroundImage = `url("${h5HeroPortrait(player.hero, 'thumb')}")`;
    const heroName = element('span', { className: 'h5-seat__hero-name', text: player.hero.name });
    const hpFill = element('span', { className: 'h5-seat__hp-fill' });
    const hpText = element('span', { className: 'h5-seat__hp-text', text: player.hp });
    const energy = element('span', {
      className: 'h5-seat__energy',
      text: String(player.energy),
      attrs: {
        'data-testid': `h5-seat-energy-${idx}`,
        'aria-hidden': 'true',
      },
    });
    const actionStatus = makePlayerStatus(
      'h5-seat__action h5-player-status',
      `h5-seat-status-${idx}`,
    );
    const action = actionStatus.root;
    const seat = element('article', {
      className: `h5-seat h5-seat--${offset}`,
      attrs: {
        'data-seat': idx,
        'data-testid': `h5-seat-${idx}`,
      },
    });
    const profileHit = button('', {
      className: 'h5-seat__stats-open h5-stats-icon',
      attrs: {
        'aria-label': `查看${player.playerName || player.hero.name}的扑克统计，气血${player.hp}`,
        'data-testid': `h5-seat-stats-${idx}`,
      },
    });
    const playerName = element('span', {
      className: 'h5-seat__name',
      text: player.playerName || player.hero.name,
    });
    const seatNumber = element('span', {
      className: 'h5-seat__seat-no', text: String(idx),
      attrs: { 'aria-label': `${idx}号位`, 'data-testid': `h5-seat-number-${idx}` },
    });
    const skillStatus = element('small', {
      className: 'h5-seat__skill-state h5-visually-hidden',
      text: '未发动',
      attrs: { 'aria-hidden': 'true' },
    });
    const skillIcon = button('', {
      className: 'h5-seat__skill',
      attrs: {
        'aria-label': `查看${player.hero.name}技能：${player.hero.skillName}`,
        'data-testid': `h5-seat-skill-${idx}`,
      },
    }, [
      element('span', { className: 'h5-seat__skill-glyph', text: '主' }),
      skillStatus,
    ]);
    const passiveSkillIcon = button('', {
      className: 'h5-seat__skill h5-seat__skill--passive',
      attrs: {
        'aria-label': `查看${player.hero.name}被动技能：${player.hero.skills?.passive?.name || '被动'}`,
        'data-testid': `h5-seat-passive-skill-${idx}`,
        'data-skill-state': 'passive',
      },
    }, [
      element('span', { className: 'h5-seat__skill-glyph', text: '被' }),
    ]);
    seat.append(
      profileHit,
      portrait,
      heroName,
      playerName,
      element('span', {
        className: 'h5-seat__hp',
        attrs: { 'data-testid': `h5-seat-hp-${idx}`, 'aria-label': `气血 ${player.hp}` },
      }, [hpFill, hpText]),
      seatNumber,
      energy,
      skillIcon,
      passiveSkillIcon,
      action,
    );
    seatMap.set(idx, {
      root: seat, profileHit, portrait, heroName, playerName, hpFill, hpText, energy,
      seatNumber, skillIcon, passiveSkillIcon, skillStatus, action,
    });
    statusNodes.set(idx, actionStatus);
    opponents.appendChild(seat);
  }

  const boardCards = Array.from({ length: 5 }, (_, index) => makeCard('h5-card--board', Config.BOARD_SLOT_NAMES[index + 1]));
  const board = element('div', { className: 'h5-board', attrs: { 'aria-label': '公共牌' } }, boardCards.map((item) => item.root));
  const handCards = [makeCard('h5-card--hand'), makeCard('h5-card--hand')];
  const handName = element('span', {
    className: 'h5-hand__type',
    text: '当前：--',
    attrs: {
      'data-testid': 'h5-current-hand-type',
      'aria-live': 'polite',
      'aria-label': '当前牌型：未发牌',
    },
  });
  const handCardsRow = element('div', { className: 'h5-hand__cards' }, handCards.map((item) => item.root));
  const hand = element('section', {
    className: 'h5-hand',
    attrs: { 'data-testid': 'h5-hole-hand', 'aria-label': '我的暗令与当前牌型' },
  }, [handCardsRow, handName]);

  const myHpFill = element('span', { className: 'h5-me__hp-fill' });
  const myHpText = element('strong', { text: me.hp });
  const myEnergy = element('span', {
    className: 'h5-me__energy',
    text: String(me.energy),
    attrs: { 'data-testid': 'h5-self-energy', 'aria-hidden': 'true' },
  });
  const myStatusParts = makePlayerStatus(
    'h5-me__status h5-player-status',
    `h5-seat-status-${myIdx}`,
  );
  const myStatus = myStatusParts.root;
  statusNodes.set(myIdx, myStatusParts);
  const skillState = element('small', {
    className: 'h5-me__skill-state h5-visually-hidden',
    attrs: { 'data-testid': 'h5-skill-state', 'aria-live': 'polite' },
  });
  const skillName = element('strong', {
    className: 'h5-skill-button__name', text: me.hero.skillName,
    attrs: { 'data-testid': 'h5-skill-name' },
  });
  const mySkillIcon = element('span', {
    className: 'h5-skill-button__icon', text: '主',
    attrs: { 'data-testid': 'h5-skill-icon', 'aria-hidden': 'true' },
  });
  const skillButton = button('', {
    className: 'h5-skill-button',
    attrs: {
      'aria-disabled': 'true',
      'data-testid': 'h5-use-skill',
      'data-tooltip': heroSkillTooltip(me.hero),
      title: heroSkillTooltip(me.hero),
    },
  }, [
    mySkillIcon,
    element('span', { className: 'h5-skill-button__body' }, [skillName]),
  ]);
  const passive = me.hero.skills?.passive;
  const passiveButton = button('', {
    className: 'h5-passive-button',
    attrs: {
      'data-testid': 'h5-passive-skill',
      'aria-label': `查看被动技能：${passive?.name || '被动'}`,
      title: `被动【${passive?.name || '未知'}】${passive?.description || me.hero.passiveDesc || ''}`,
    },
  }, [
    element('span', { className: 'h5-passive-button__icon', text: '被' }),
    element('span', { className: 'h5-passive-button__body' }, [
      element('strong', { text: passive?.name || '被动' }),
    ]),
  ]);
  const myPortrait = element('span', {
    className: 'h5-me__portrait',
    attrs: { 'aria-hidden': 'true', 'data-testid': 'h5-self-portrait' },
  });
  myPortrait.style.backgroundImage = `url("${h5HeroPortrait(me.hero, 'detail')}")`;
  const myStatsButton = button('', {
    className: 'h5-me__stats-open h5-stats-icon',
    attrs: { 'data-testid': `h5-seat-stats-${myIdx}`, 'aria-label': '查看我的扑克统计' },
  });
  const skillRail = element('div', {
    className: 'h5-me__skills',
    attrs: { 'aria-label': '主动与被动技能快捷入口' },
  }, [skillButton, passiveButton]);
  const extend = button('+30s·1⚡', {
    className: 'h5-extend',
    attrs: {
      disabled: true,
      'data-testid': 'h5-extend-time',
      'aria-label': '延时30秒，消耗1点能量',
      title: '延时30秒 · 消耗1⚡',
    },
  });
  const turnTools = element('div', { className: 'h5-me__turn-tools' }, [myStatus, extend]);
  const myPlayerName = element('strong', {
    text: me.playerName || '你',
    attrs: { 'data-testid': 'h5-self-player-name' },
  });
  const myHeroName = element('span', {
    className: 'h5-me__hero-name', text: me.hero.name,
    attrs: { 'aria-hidden': 'true' },
  });
  const selfSeatCard = element('div', {
    className: 'h5-me__seat-card', attrs: { 'data-testid': 'h5-self-seat-card' },
  }, [
    myPortrait,
    myHeroName,
    element('div', { className: 'h5-me__identity' }, [
      myPlayerName,
    ]),
    element('div', { className: 'h5-me__stats', attrs: { 'data-testid': 'h5-self-vitals' } }, [
      element('span', {
        className: 'h5-me__hp', attrs: { 'data-testid': 'h5-self-hp', 'aria-label': '我的气血' },
      }, [myHpFill, myHpText]),
      myEnergy,
    ]),
    skillRail,
    myStatsButton,
    turnTools,
  ]);
  const mePanel = element('section', {
    className: 'h5-me', attrs: { 'data-testid': 'h5-self-seat' },
  }, [selfSeatCard, hand, skillState]);

  const actionButtons = {
    fold: button('退避', { attrs: { 'data-testid': 'h5-action-fold' } }),
    call: button('静观', { attrs: { 'data-testid': 'h5-action-call' } }),
    allin: button('决死', { attrs: { 'data-testid': 'h5-action-allin' } }),
    raiseS: button('佯攻', { attrs: { 'data-testid': 'h5-action-feint' } }),
    raiseM: button('强攻', { attrs: { 'data-testid': 'h5-action-strike' } }),
    raiseL: button('猛攻', { attrs: { 'data-testid': 'h5-action-fierce' } }),
  };
  for (const item of Object.values(actionButtons)) item.disabled = true;
  actionButtons.allin.classList.add('is-danger');
  const actions = element('div', { className: 'h5-actions', attrs: { 'aria-label': '行动区' } }, [
    actionButtons.fold, actionButtons.call, actionButtons.allin,
    actionButtons.raiseS, actionButtons.raiseM, actionButtons.raiseL,
  ]);
  const actionArea = element('div', { className: 'h5-action-area' }, [advisorPanel, handStrength, actions]);
  const chatList = element('div', {
    className: 'h5-chat-list',
    attrs: { role: 'log', 'aria-live': 'polite', 'data-testid': 'h5-chat-list' },
  }, [element('p', { className: 'h5-chat-list__empty', text: '暂无聊天消息' })]);
  const chatInput = element('input', {
    className: 'h5-chat-input',
    attrs: {
      type: 'text', maxlength: 80, placeholder: '输入消息…', autocomplete: 'off',
      enterkeyhint: 'send',
      'aria-label': '聊天内容', 'data-testid': 'h5-chat-input',
    },
  });
  const chatSend = button('发送', {
    className: 'h5-chat-send',
    attrs: { type: 'submit', disabled: true, 'data-testid': 'h5-chat-send' },
  });
  const chatTab = button('聊天', {
    className: 'h5-dock-tabs__tab is-active',
    attrs: { role: 'tab', 'aria-selected': 'true', 'data-testid': 'h5-chat-tab' },
  });
  const reportTab = button('战报', {
    className: 'h5-dock-tabs__tab',
    attrs: { role: 'tab', 'aria-selected': 'false', 'data-testid': 'h5-report-tab' },
  });
  const chatPanel = element('section', {
    className: 'h5-dock-panel is-active',
    attrs: { role: 'tabpanel', 'data-panel': 'chat', 'data-testid': 'h5-chat-panel' },
  }, [chatList, element('form', {
    className: 'h5-chat-compose',
    attrs: { 'aria-label': '发送聊天消息' },
  }, [chatInput, chatSend])]);
  const reportPanel = element('section', {
    className: 'h5-dock-panel',
    attrs: { role: 'tabpanel', 'data-panel': 'report', hidden: true, 'data-testid': 'h5-report-panel' },
  }, [logList]);
  const dockSide = element('aside', {
    className: 'h5-dock-side', attrs: { 'data-testid': 'h5-chat-report' },
  }, [
    element('div', { className: 'h5-dock-tabs', attrs: { role: 'tablist' } }, [chatTab, reportTab]),
    chatPanel,
    reportPanel,
  ]);
  const dock = element('footer', { className: 'h5-battle__dock' }, [mePanel, actionArea, dockSide]);

  const table = element('main', {
    className: 'h5-table',
    attrs: { 'data-player-count': String(playerCount) },
  }, [
    opponents,
    element('section', { className: 'h5-table__center' }, [board, potText, hintText]),
    skillHoverPreview,
  ]);
  const screen = element('div', {
    className: 'h5-screen h5-battle',
    attrs: { 'data-testid': 'h5-battle', 'data-player-count': String(playerCount) },
  }, [
    element('header', { className: 'h5-battle__topbar' }, [
      element('strong', { text: '群英决' }), roundText, blindText,
      element('span', { className: 'h5-battle__spacer' }), advisorToggleLabel, networkText, logButton,
      leaveButton,
    ]),
    table,
    dock,
    feedbackLayer,
    chipFlightLayer,
  ]);
  clear(root, screen);

  function bindListener(name, handler) {
    previousListeners.set(name, listeners[name]);
    listeners[name] = handler;
  }

  function addLog(text, kind = 'info') {
    const row = element('p', { className: `h5-log-list__item is-${kind}`, text });
    logList.appendChild(row);
    while (logList.childElementCount > 80) logList.firstElementChild?.remove();
    logList.scrollTop = logList.scrollHeight;
  }

  function appendChatMessage({ name = '玩家', text = '' } = {}) {
    const value = String(text || '').trim();
    if (!value) return;
    chatList.querySelector('.h5-chat-list__empty')?.remove();
    chatList.appendChild(element('p', { className: 'h5-chat-message' }, [
      element('strong', { text: `${name}：` }),
      element('span', { text: value }),
    ]));
    while (chatList.childElementCount > 60) chatList.firstElementChild?.remove();
    chatList.scrollTop = chatList.scrollHeight;
  }

  function selectDockTab(name) {
    const chatActive = name === 'chat';
    chatTab.classList.toggle('is-active', chatActive);
    reportTab.classList.toggle('is-active', !chatActive);
    chatTab.setAttribute('aria-selected', String(chatActive));
    reportTab.setAttribute('aria-selected', String(!chatActive));
    chatPanel.hidden = !chatActive;
    reportPanel.hidden = chatActive;
    chatPanel.classList.toggle('is-active', chatActive);
    reportPanel.classList.toggle('is-active', !chatActive);
  }

  function submitChat() {
    const text = chatInput.value.trim();
    if (!text || !engine.sendChat?.(text)) return;
    chatInput.value = '';
    chatSend.disabled = true;
  }

  function rememberSeatAction(idx, key, amount = 0) {
    seatActions.set(Number(idx), {
      key,
      amount: Math.max(0, Math.round(Number(amount) || 0)),
      street: engine.street,
      round: engine.round,
    });
  }

  function hydrateSeatActions() {
    for (const player of players.slice(1)) {
      if (player?.lastAction?.key) seatActions.set(Number(player.idx), { ...player.lastAction });
    }
  }

  function activeStatusTurn() {
    const idx = Number(turnIdx || engine.actingIdx || engine.waitingIdx || 0);
    return idx > 0 ? idx : null;
  }

  function seatStatus(idx) {
    const activeIdx = activeStatusTurn();
    return classifyH5SeatStatus(players[idx], {
      isTurn: activeIdx === Number(idx),
      hasActiveTurn: activeIdx !== null || actionPhaseStarted,
      lastAction: seatActions.get(Number(idx)) || players[idx]?.lastAction || null,
    });
  }

  function renderSeatStatus(idx) {
    const player = players[idx];
    const statusNode = statusNodes.get(Number(idx));
    const node = statusNode?.root;
    if (!player || !node) return;
    const status = seatStatus(idx);
    statusNode.label.textContent = status.label;
    node.dataset.state = status.state;
    node.title = status.label;
    for (const state of ['idle', 'waiting', 'turn', 'acted', 'folded', 'allin', 'dead']) {
      node.classList.toggle(`is-${state}`, state === status.state);
    }

    const panel = idx === myIdx ? mePanel : seatMap.get(idx)?.root;
    if (panel) {
      panel.classList.toggle('is-turn', status.state === 'turn');
      panel.classList.toggle('is-folded', status.state === 'folded');
      panel.classList.toggle('is-allin', status.state === 'allin');
      panel.classList.toggle('is-dead', status.state === 'dead');
      panel.dataset.playerState = status.state;
    }
    const seat = seatMap.get(idx)?.root;
    if (seat) {
      const label =
        `查看${player.playerName || player.hero.name}的扑克统计，气血${player.hp}，状态${status.label}`;
      seat.setAttribute('aria-label', label);
      seatMap.get(idx)?.profileHit?.setAttribute(
        'aria-label',
        label,
      );
    }
    renderSeatCountdown(idx);
  }

  function renderAllSeatStatuses() {
    hydrateSeatActions();
    for (let idx = 1; idx <= playerCount; idx++) renderSeatStatus(idx);
  }

  function resetStreetSeatActions() {
    turnIdx = null;
    actionPhaseStarted = false;
    for (const [idx] of seatActions) {
      const player = players[idx];
      if (!player?.folded && !player?.allIn && player?.alive) seatActions.delete(idx);
    }
    renderAllSeatStatuses();
  }

  function closeDrawer() {
    releaseDrawerEscape?.();
    releaseDrawerEscape = null;
    screen.querySelector('.h5-drawer-layer')?.remove();
  }

  function openDrawer(title, content, className = '', drawerAttrs = {}) {
    closeDrawer();
    const closeButton = button('关闭', { className: 'h5-drawer__close' });
    const drawer = element('section', {
      className: `h5-drawer ${className}`,
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title, ...drawerAttrs },
    }, [
      element('header', { className: 'h5-drawer__header' }, [element('h2', { text: title }), closeButton]),
      element('div', { className: 'h5-drawer__content' }, content),
    ]);
    const layer = element('div', { className: 'h5-drawer-layer' }, drawer);
    const close = () => closeDrawer();
    closeButton.addEventListener('click', close);
    layer.addEventListener('click', (event) => { if (event.target === layer) close(); });
    releaseDrawerEscape = trapEscape(drawer, close);
    screen.appendChild(layer);
    queueMicrotask(() => closeButton.focus());
    return drawer;
  }

  function showPlayer(idx) {
    const player = players[idx];
    const portrait = element('span', { className: 'h5-player-drawer__portrait', attrs: { 'aria-hidden': 'true' } });
    portrait.style.backgroundImage = `url("${h5HeroPortrait(player.hero, 'thumb')}")`;
    openDrawer(`${player.playerName || player.hero.name} · 玩家统计`, [
      element('section', { className: 'h5-player-drawer__identity' }, [
        portrait,
        element('div', {}, [
          element('strong', { text: player.playerName || `${idx} 号位` }),
          element('span', { text: `${player.hero.name} · ${player.hero.type}${player.shortId ? ` · #${player.shortId}` : ''}` }),
        ]),
        element('div', { className: 'h5-player-drawer__badges' }, [
          element('span', { text: `气血 ${player.hp}` }),
          element('span', { text: `⚡${player.energy}` }),
          element('span', { text: seatStatus(idx).label }),
        ]),
      ]),
      ...playerStatsContent(player, `h5-seat-stats-${idx}`),
      element('details', { className: 'h5-player-skill-details' }, [
        element('summary', { text: '查看武将技能' }),
        element('dl', { className: 'h5-info-list' }, [
          element('div', {}, [element('dt', { text: '主动' }), element('dd', { text: `${player.hero.skillName} · ${player.hero.skillCost}⚡` })]),
        ]),
        element('p', { text: player.hero.skillDesc }),
        element('small', { text: `条件：${player.hero.condDesc}` }),
        element('h3', { text: '被动' }),
        element('p', { text: player.hero.passiveDesc }),
      ]),
    ], 'h5-drawer--info h5-drawer--player-stats', { 'data-testid': 'h5-player-stats-panel' });
  }
  function showSkills(idx) {
    const player = players[idx];
    if (!player) return;
    const active = player.hero.skills?.active;
    const passiveSkill = player.hero.skills?.passive;
    openDrawer(`${player.hero.name} · 武将技能`, [
      element('section', { className: 'h5-skill-detail-card is-active' }, [
        element('span', { className: 'h5-skill-detail-card__icon', text: UNIFIED_SKILL_GLYPH }),
        element('div', {}, [
          element('small', { text: '主动技能' }),
          element('h3', { text: `${active?.name || player.hero.skillName} · ${active?.cost ?? player.hero.skillCost}⚡` }),
          element('p', { text: active?.description || player.hero.skillDesc }),
          element('em', { text: `条件：${active?.conditionDescription || player.hero.condDesc}` }),
        ]),
      ]),
      element('section', { className: 'h5-skill-detail-card is-passive' }, [
        element('span', { className: 'h5-skill-detail-card__icon', text: UNIFIED_SKILL_GLYPH }),
        element('div', {}, [
          element('small', { text: '被动技能' }),
          element('h3', { text: passiveSkill?.name || '被动' }),
          element('p', { text: passiveSkill?.description || player.hero.passiveDesc }),
        ]),
      ]),
    ], 'h5-drawer--info h5-drawer--skills', { 'data-testid': 'h5-skill-detail-panel' });
  }
  function showSkillHoverPreview(idx, anchor) {
    const player = players[idx];
    if (!player || !anchor) return;
    skillHoverPreview.textContent = heroSkillTooltip(player.hero);
    skillHoverPreview.dataset.playerIdx = String(idx);
    skillHoverPreview.hidden = false;
    const tableRect = table.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const previewRect = skillHoverPreview.getBoundingClientRect();
    const gap = 6;
    const width = Math.min(previewRect.width || 300, Math.max(160, tableRect.width - 16));
    const left = Math.max(8, Math.min(
      tableRect.width - width - 8,
      anchorRect.left - tableRect.left + anchorRect.width / 2 - width / 2,
    ));
    const below = anchorRect.bottom - tableRect.top + gap;
    const top = below + (previewRect.height || 42) <= tableRect.height - 8
      ? below
      : Math.max(8, anchorRect.top - tableRect.top - (previewRect.height || 42) - gap);
    skillHoverPreview.style.left = `${left}px`;
    skillHoverPreview.style.top = `${top}px`;
  }
  function hideSkillHoverPreview(idx) {
    if (idx !== undefined && skillHoverPreview.dataset.playerIdx !== String(idx)) return;
    skillHoverPreview.hidden = true;
    delete skillHoverPreview.dataset.playerIdx;
  }
  for (const idx of relativeSeats) {
    const seat = seatMap.get(idx);
    seat.profileHit.addEventListener('click', () => showPlayer(idx));
    for (const icon of [seat.skillIcon, seat.passiveSkillIcon]) {
      icon.addEventListener('mouseenter', () => showSkillHoverPreview(idx, icon));
      icon.addEventListener('mouseleave', () => hideSkillHoverPreview(idx));
      icon.addEventListener('focus', () => showSkillHoverPreview(idx, icon));
      icon.addEventListener('blur', () => hideSkillHoverPreview(idx));
      icon.addEventListener('click', () => {
        hideSkillHoverPreview(idx);
        showSkills(idx);
      });
    }
  }
  skillButton.addEventListener('mouseenter', () => showSkillHoverPreview(myIdx, skillButton));
  skillButton.addEventListener('mouseleave', () => hideSkillHoverPreview(myIdx));
  skillButton.addEventListener('focus', () => showSkillHoverPreview(myIdx, skillButton));
  skillButton.addEventListener('blur', () => hideSkillHoverPreview(myIdx));
  passiveButton.addEventListener('mouseenter', () => showSkillHoverPreview(myIdx, passiveButton));
  passiveButton.addEventListener('mouseleave', () => hideSkillHoverPreview(myIdx));
  passiveButton.addEventListener('focus', () => showSkillHoverPreview(myIdx, passiveButton));
  passiveButton.addEventListener('blur', () => hideSkillHoverPreview(myIdx));
  const bindSkillLongPress = (target) => {
    let timer = null;
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    target.addEventListener('pointerdown', () => {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        target.dataset.longPressed = 'true';
        showSkills(myIdx);
      }, 520);
    });
    target.addEventListener('pointerup', cancel);
    target.addEventListener('pointercancel', cancel);
    target.addEventListener('pointerleave', cancel);
  };
  bindSkillLongPress(skillButton);
  bindSkillLongPress(passiveButton);
  myStatsButton.addEventListener('click', () => showPlayer(myIdx));
  passiveButton.addEventListener('click', () => {
    if (passiveButton.dataset.longPressed === 'true') {
      delete passiveButton.dataset.longPressed;
      return;
    }
    showSkills(myIdx);
  });
  chatTab.addEventListener('click', () => selectDockTab('chat'));
  reportTab.addEventListener('click', () => selectDockTab('report'));
  logButton.addEventListener('click', () => selectDockTab('report'));
  chatInput.addEventListener('input', () => {
    chatSend.disabled = !chatInput.value.trim();
  });
  chatInput.closest('form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.isComposing) return;
    submitChat();
  });

  function setHp(idx) {
    const player = players[idx];
    const ratio = Math.max(0, Math.min(1, player.hp / Config.INIT_HP));
    if (idx === myIdx) {
      myHpFill.style.width = `${Math.round(ratio * 100)}%`;
      myHpText.textContent = String(player.hp);
      myEnergy.textContent = String(player.energy);
      return;
    }
    const seat = seatMap.get(idx);
    if (!seat) return;
    const percent = Math.round(ratio * 100);
    seat.root.style.setProperty('--h5-seat-hp-percent', `${percent}%`);
    seat.hpFill.style.width = '';
    seat.hpFill.style.height = '';
    seat.hpText.textContent = String(player.hp);
    seat.energy.textContent = String(player.energy);
    seat.root.classList.toggle('is-hp-low', percent <= 30 && percent > 15);
    seat.root.classList.toggle('is-hp-critical', percent <= 15);
    seat.root.querySelector('.h5-seat__hp')?.setAttribute('aria-label', `气血 ${player.hp}`);
  }

  function refreshSeatSkills() {
    for (const [idx, seat] of seatMap) {
      const player = players[idx];
      const active = player?.hero?.skills?.active;
      if (!player || !active) continue;
      const charged = player.alive && !player.folded && !player.skillUsed
        && Number(player.energy) >= Number(active.cost || 0);
      const possible = charged && Number(engine.actingIdx) === Number(idx);
      let state = 'idle';
      let label = '未发动';
      if (!player.alive) { state = 'dead'; label = '已阵亡'; }
      else if (player.folded) { state = 'blocked'; label = '已退避'; }
      else if (player.skillUsed) { state = 'used'; label = '已发动'; }
      else if (possible) { state = 'possible'; label = '能量充足，可发动'; }
      else if (charged) { state = 'charged'; label = '能量充足，等待行动'; }
      seat.skillIcon.dataset.skillState = state;
      seat.skillIcon.classList.toggle('is-ready', charged);
      seat.skillStatus.textContent = label;
      seat.skillIcon.title = `${heroSkillTooltip(player.hero)} · ${label}`;
      seat.skillIcon.setAttribute(
        'aria-label',
        `查看${player.hero.name}技能：${player.hero.skillName}，当前能量${player.energy}，${label}`,
      );
    }
  }

  function refreshDealerSeats(dealerIdx = engine.dealerIdx) {
    const activeDealer = Number(dealerIdx);
    for (const [idx, seat] of seatMap) {
      seat.root.classList.toggle('is-dealer', Number(idx) === activeDealer);
    }
    mePanel.classList.toggle('is-dealer', Number(myIdx) === activeDealer);
  }

  function flashSkill(idx) {
    const node = Number(idx) === Number(myIdx)
      ? skillButton
      : seatMap.get(Number(idx))?.skillIcon;
    if (!node) return;
    node.classList.remove('is-triggered');
    requestAnimationFrame(() => node.classList.add('is-triggered'));
    setTimeout(() => node.classList.remove('is-triggered'), 900);
  }

  function updatePot() {
    const layers = engine.getPotDisplay?.(engine.waitingIdx === myIdx)
      || [{ label: '主池', amount: engine.totalPot() }];
    potText.textContent = layers.map((layer) => `${layer.label} ${layer.amount}`).join(' · ');
  }

  function clearHandCoreHighlight() {
    for (const item of [...handCards, ...boardCards]) {
      item.root.classList.remove('is-hit-core', 'is-combo');
    }
  }

  function clearTransientFeedback() {
    if (handHitTimer) clearTimeout(handHitTimer);
    if (handCoreTimer) clearTimeout(handCoreTimer);
    if (roundResultTimer) clearTimeout(roundResultTimer);
    if (roundResultDelayTimer) clearTimeout(roundResultDelayTimer);
    handHitTimer = null;
    handCoreTimer = null;
    roundResultTimer = null;
    roundResultDelayTimer = null;
    clearSettlementFeedback();
    feedbackLayer.replaceChildren();
    clearHandCoreHighlight();
  }

  function showHandHit(feedback, current) {
    feedbackLayer.querySelector('[data-testid="h5-hand-hit"]')?.remove();
    feedbackLayer.querySelector('[data-testid="h5-hand-hit-effect"]')?.remove();
    const effect = element('div', {
      className: `h5-hand-hit-effect is-${feedback.tier}`,
      attrs: { 'data-testid': 'h5-hand-hit-effect', 'aria-hidden': 'true' },
    }, Array.from({ length: 8 }, (_, index) => element('span', { dataset: { particle: index } })));
    const notice = element('div', {
      className: `h5-hand-hit is-${feedback.tier}`,
      attrs: { 'data-testid': 'h5-hand-hit' },
    }, [
      element('small', { text: `${feedback.stage} · 中牌` }),
      element('strong', { text: feedback.name }),
      element('span', { text: feedback.poker }),
    ]);
    feedbackLayer.append(effect, notice);

    const core = new Set((feedback.tier === 'premium' ? me.hole : current.core || []).map(cardSignature));
    handCards.forEach((item, index) => {
      const active = core.has(cardSignature(me.hole[index]));
      item.root.classList.toggle('is-hit-core', active);
      item.root.classList.toggle('is-combo', active);
    });
    boardCards.forEach((item, index) => {
      const active = core.has(cardSignature(engine.board[index]));
      item.root.classList.toggle('is-hit-core', active);
      item.root.classList.toggle('is-combo', active);
    });
    lastHandHitAt = Date.now();
    if (feedback.strong) {
      const vibrationKey = `${engine.round || 0}:${feedback.category}:${[...(current.core || [])]
        .map(cardSignature).sort().join('|')}`;
      if (vibrationKey !== lastStrongHandVibrationKey) {
        lastStrongHandVibrationKey = vibrationKey;
        requestH5StrongHandVibration(feedback.tier);
      }
    }
    playSFX(feedback.tier === 'legendary' ? 'judge' : 'drawx');
    handHitTimer = setTimeout(() => {
      notice.remove();
      effect.remove();
      handHitTimer = null;
    }, 1900);
    handCoreTimer = setTimeout(() => {
      clearHandCoreHighlight();
      handCoreTimer = null;
    }, 1500);
  }

  function settlementHost(idx) {
    return Number(idx) === Number(myIdx) ? myStatus : seatMap.get(Number(idx))?.action;
  }

  function settlementPortrait(idx) {
    return Number(idx) === Number(myIdx) ? myPortrait : seatMap.get(Number(idx))?.portrait;
  }

  function settlementRevealHost(idx) {
    if (!shouldRenderH5PortraitReveal(idx, myIdx)) return null;
    return seatMap.get(Number(idx))?.portrait;
  }

  function syncSeatRevealChrome(idx) {
    const seat = seatMap.get(Number(idx))?.root;
    if (!seat) return;
    const isRevealing = Boolean(
      seat.querySelector('.h5-public-hole-reveal, .h5-settlement-reveal'),
    );
    seat.classList.toggle('is-revealing-hole', isRevealing);
  }

  function syncAllSeatRevealChrome() {
    seatMap.forEach((_nodes, idx) => syncSeatRevealChrome(idx));
  }

  function clearPublicHoleFeedback() {
    screen.querySelectorAll('[data-h5-public-hole]').forEach((node) => node.remove());
    syncAllSeatRevealChrome();
  }

  function showPublicHoleCards(idx, hole, label = '公开底牌') {
    const seat = Number(idx);
    const cards = Array.isArray(hole) ? [hole[0] || null, hole[1] || null] : [null, null];
    publicHoleCards.set(seat, cards);
    if (seat === Number(myIdx)) {
      cards.forEach((card, index) => {
        if (card) handCards[index].setCard(card);
      });
      return;
    }
    const host = seatMap.get(seat)?.portrait;
    if (!host) return;
    host.querySelector(`[data-h5-public-hole][data-player-idx="${seat}"]`)?.remove();
    const cardNodes = cards.map((cardValue) => {
      const card = makeCard('h5-card--public-hole h5-card--seat-reveal');
      card.root.setAttribute('data-testid', 'h5-public-hole-card');
      if (cardValue) card.setCard(cardValue);
      else card.faceDown('未公开');
      return card.root;
    });
    host.appendChild(element('span', {
      className: 'h5-seat-hole-reveal h5-public-hole-reveal',
      attrs: {
        'data-testid': 'h5-public-hole-reveal',
        'data-player-idx': seat,
        'data-h5-public-hole': true,
        'aria-label': `${players[seat]?.playerName || players[seat]?.hero?.name || '玩家'}${label}`,
      },
    }, [
      element('span', { className: 'h5-public-hole-reveal__cards' }, cardNodes),
      element('small', { className: 'h5-seat-hole-reveal__label', text: label }),
    ]));
    syncSeatRevealChrome(seat);
  }

  function clearSettlementFeedback() {
    screen.querySelectorAll('[data-h5-settlement]').forEach((node) => node.remove());
    chipFlightLayer.replaceChildren();
    syncAllSeatRevealChrome();
  }

  function settlementRows(wonAmount = {}, netResult = {}) {
    return players.slice(1).map((player) => {
      const idx = Number(player.idx);
      const award = Math.max(0, Math.round(Number(wonAmount?.[idx]) || 0));
      const contribution = Math.max(0, Math.round(Number(player.betRound) || 0));
      const hasExactNet = Object.prototype.hasOwnProperty.call(netResult || {}, idx)
        && Number.isFinite(Number(netResult[idx]));
      const net = hasExactNet ? Math.round(Number(netResult[idx])) : award - contribution;
      if (!hasExactNet && award <= 0 && contribution <= 0) return null;
      return {
        idx,
        player,
        award,
        contribution,
        net,
        tone: net > 0 ? 'win' : net < 0 ? 'loss' : 'draw',
      };
    }).filter(Boolean);
  }

  function showSettlementAmounts(rows) {
    for (const row of rows) {
      const host = settlementHost(row.idx);
      if (!host) continue;
      const text = row.net > 0 ? `+${row.net}` : String(row.net);
      host.appendChild(element('strong', {
        className: `h5-chip-delta is-${row.tone}`,
        text,
        attrs: {
          'data-testid': 'h5-chip-delta',
          'data-player-idx': row.idx,
          'data-net': row.net,
          'data-h5-settlement': true,
          'aria-label': `${row.player.playerName || row.player.hero.name}${row.net > 0 ? '净赢' : row.net < 0 ? '净负' : '净收益'}${text}`,
        },
      }));
    }
  }

  function screenPoint(node) {
    const screenRect = screen.getBoundingClientRect();
    const rect = node?.getBoundingClientRect();
    if (!rect || !screenRect.width || !screenRect.height) return null;
    const scaleX = screenRect.width / Math.max(1, screen.clientWidth);
    const scaleY = screenRect.height / Math.max(1, screen.clientHeight);
    return {
      x: (rect.left + rect.width / 2 - screenRect.left) / scaleX,
      y: (rect.top + rect.height / 2 - screenRect.top) / scaleY,
    };
  }

  function animateChipAwards(plans) {
    const start = screenPoint(potText);
    if (!start) return;
    plans.forEach((plan, index) => {
      const target = screenPoint(settlementPortrait(plan.winnerIdx));
      if (!target || !(plan.amount > 0)) return;
      const dx = target.x - start.x;
      const dy = target.y - start.y;
      const arc = Math.max(18, Math.min(54, Math.abs(dx) * .14 + 18));
      const flight = element('span', {
        className: 'h5-chip-flight',
        attrs: {
          'data-testid': 'h5-chip-flight',
          'data-winner-idx': plan.winnerIdx,
          'data-award': Math.round(plan.amount),
          'data-pot-label': plan.label || '血池',
          'data-h5-settlement': true,
        },
      }, Array.from({ length: 4 }, () => element('i', { className: 'h5-chip-flight__coin' })));
      flight.style.left = `${start.x}px`;
      flight.style.top = `${start.y}px`;
      flight.style.setProperty('--chip-mid-x', `${dx * .52}px`);
      flight.style.setProperty('--chip-mid-y', `${dy * .52 - arc}px`);
      flight.style.setProperty('--chip-end-x', `${dx}px`);
      flight.style.setProperty('--chip-end-y', `${dy}px`);
      flight.style.animationDelay = `${index * 90}ms`;
      chipFlightLayer.appendChild(flight);
    });
    if (plans.length) playSFX('drawx');
  }

  function showdownAwardPlans(data) {
    const plans = [];
    for (const pot of Array.isArray(data?.pots) ? data.pots : []) {
      for (const [idx, amount] of Object.entries(pot?.awards || {})) {
        if (Number(amount) > 0) plans.push({
          winnerIdx: Number(idx), amount: Number(amount), label: pot.label || '血池',
        });
      }
    }
    if (!plans.length) {
      for (const [idx, amount] of Object.entries(data?.wonAmount || {})) {
        if (Number(amount) > 0) plans.push({ winnerIdx: Number(idx), amount: Number(amount), label: '血池' });
      }
    }
    return plans;
  }

  function showSettlementAnnouncement(rows, totalPot = 0) {
    const summary = rows.map((row) => {
      const name = row.player.playerName || row.player.hero.name;
      return `${name}${row.net > 0 ? `净赢${row.net}` : row.net < 0 ? `净负${Math.abs(row.net)}` : '净收益0'}`;
    }).join('，');
    feedbackLayer.appendChild(element('span', {
      className: 'h5-visually-hidden',
      text: `血池${Math.round(Number(totalPot) || 0)}结算，${summary}`,
      attrs: {
        'data-testid': 'h5-settlement-announcement',
        'data-h5-settlement': true,
        role: 'status',
      },
    }));
  }

  function showShowdown(data) {
    const entrants = Array.isArray(data?.entrants) ? data.entrants : [];
    const render = () => {
      if (handHitTimer) clearTimeout(handHitTimer);
      if (handCoreTimer) clearTimeout(handCoreTimer);
      if (roundResultTimer) clearTimeout(roundResultTimer);
      handHitTimer = null;
      handCoreTimer = null;
      roundResultTimer = null;
      clearHandCoreHighlight();
      clearSettlementFeedback();

      const rows = settlementRows(data?.wonAmount, data?.netResult);
      showSettlementAmounts(rows);
      for (const entrant of entrants) {
        const idx = Number(entrant.idx);
        const player = players[idx] || entrant;
        const handNameValue = entrant.showdownInfo?.name || '牌型待同步';
        const pokerType = Config.HAND_NAMES[entrant.showdownInfo?.cat]?.poker || '';
        const handType = pokerType ? `${handNameValue} · ${pokerType}` : handNameValue;
        const host = settlementRevealHost(idx);
        if (host) {
          const cards = Array.from({ length: 2 }, (_, cardIndex) => {
            const card = makeCard('h5-card--settlement h5-card--seat-reveal');
            card.root.setAttribute('data-testid', 'h5-settlement-card');
            if (entrant.hole?.[cardIndex]) card.setCard(entrant.hole[cardIndex]);
            else card.faceDown('未同步');
            return card.root;
          });
          host.appendChild(element('span', {
            className: 'h5-seat-hole-reveal h5-settlement-reveal',
            attrs: {
              'data-testid': 'h5-settlement-reveal',
              'data-player-idx': idx,
              'data-h5-settlement': true,
              'aria-label': `${player.playerName || player.hero?.name || '玩家'}，${handType}`,
            },
          }, [
            element('span', { className: 'h5-settlement-reveal__cards' }, cards),
            element('strong', {
              className: 'h5-seat-hole-reveal__label h5-settlement-reveal__hand',
              text: handType,
              attrs: { 'data-testid': 'h5-settlement-hand-type', title: handType },
            }),
          ]));
          syncSeatRevealChrome(idx);
        }
        const row = rows.find((item) => item.idx === idx);
        const netText = row ? (row.net > 0 ? `净赢 +${row.net}` : row.net < 0 ? `净负 ${row.net}` : '净收益 0') : '净收益 0';
        addLog(`${player.playerName || player.hero?.name || '玩家'} · ${handType} · ${netText}`, row?.tone === 'win' ? 'win' : 'result');
      }
      animateChipAwards(showdownAwardPlans(data));
      showSettlementAnnouncement(rows, data?.totalPot);
      const myRow = rows.find((row) => row.idx === Number(myIdx));
      playSFX(myRow?.tone === 'win' ? 'win' : myRow?.tone === 'loss' ? 'lose' : 'judge');
      roundResultTimer = setTimeout(() => {
        clearSettlementFeedback();
        roundResultTimer = null;
      }, 3400);
    };

    if (roundResultDelayTimer) clearTimeout(roundResultDelayTimer);
    const elapsed = Date.now() - lastHandHitAt;
    const delay = elapsed < 650 ? 650 - Math.max(0, elapsed) : 0;
    if (delay) {
      roundResultDelayTimer = setTimeout(() => {
        roundResultDelayTimer = null;
        render();
      }, delay);
    } else render();
  }

  function syncMajorHandEffect(current = null, hole = me.hole) {
    const category = Number(current?.cat) || 0;
    const premium = Number(engine.revealed || 0) === 0
      ? classifyH5PremiumStartingHand(hole)
      : null;
    const active = Boolean(premium) || isH5StrongMadeHand(current, hole);
    hand.classList.toggle('is-major-hand', active);
    if (category > 0) hand.dataset.handCategory = String(category);
    else delete hand.dataset.handCategory;
    if (premium) hand.dataset.handTier = 'premium';
    else if (active) hand.dataset.handTier = h5HandEffectTier(category);
    else delete hand.dataset.handTier;
  }

  function resetCurrentHand() {
    handCards.forEach((item) => item.faceDown());
    handName.textContent = '当前：--';
    handName.setAttribute('aria-label', '当前牌型：未发牌');
    handName.removeAttribute('title');
    syncMajorHandEffect();
  }

  function updateHand({ announce = false, street = '' } = {}) {
    if (me.hole?.length >= 2) {
      handCards[0].setCard(me.hole[0]);
      handCards[1].setCard(me.hole[1]);
      const current = describe([...me.hole, ...engine.revealedBoard()]);
      handName.textContent = `当前：${current.name}`;
      handName.setAttribute('aria-label', `当前牌型：${current.name}，${current.poker}`);
      handName.title = `${current.name} · ${current.poker}`;
      syncMajorHandEffect(current);
      if (announce) {
        const feedback = classifyH5HandHit(
          lastHandCategory,
          current,
          me.hole,
          street,
          lastStrongHandActive,
        );
        if (feedback) showHandHit(feedback, current);
      }
      lastHandCategory = current.cat;
      lastStrongHandActive = isH5StrongMadeHand(current, me.hole);
      return current;
    } else {
      resetCurrentHand();
      lastHandCategory = null;
      lastStrongHandActive = false;
    }
    return null;
  }

  function refreshSkill() {
    if (destroyed) return;
    const available = engine.skillAvailability(myIdx);
    const isMyAction = Number(engine.actingIdx) === Number(myIdx)
      && Number(engine.waitingIdx) === Number(myIdx);
    const ready = available.ok && isMyAction && !pending;
    skillName.textContent = me.hero.skillName;
    skillButton.setAttribute('aria-disabled', String(!ready));
    const state = ready ? 'ready'
      : me.skillUsed ? 'used'
        : !isMyAction ? 'waiting' : 'blocked';
    skillButton.dataset.skillState = state;
    skillButton.classList.toggle('is-ready', ready);
    skillState.textContent = ready
      ? '可发动'
      : !isMyAction ? '仅可在轮到你行动时发动' : available.reason || '';
    skillState.classList.toggle('is-ready', ready);
    refreshSeatSkills();
  }

  function renderAdvisorEmpty(message) {
    advisorPanel.hidden = !advisorEnabled;
    advisorContent.hidden = true;
    advisorEmpty.hidden = false;
    advisorEmpty.textContent = message;
    advisorPanel.removeAttribute('data-tone');
    advisorPanel.title = message;
  }

  function renderDecisionAdvice(advice) {
    if (!advice?.suggestions?.length) {
      renderAdvisorEmpty('暂无可用建议');
      return;
    }
    const confidenceLabels = { high: '高把握', medium: '中等把握', low: '低频分支' };
    const [primary, ...alternatives] = advice.suggestions.slice(0, 3);
    const equity = Number.isFinite(advice.equity) ? `胜算 ${Math.round(advice.equity * 100)}%` : '';
    advisorRecommendation.textContent = `${primary.label} · ${primary.frequency}%`;
    advisorConfidence.textContent = confidenceLabels[advice.confidence] || '参考';
    advisorOptions.textContent = alternatives.length
      ? `备选：${alternatives.map((item) => `${item.label} ${item.frequency}%`).join(' / ')}`
      : '单一策略 · 100%';
    advisorReason.textContent = `理由：${advice.reason || '基于当前公开牌面与筹码深度'}`;
    advisorMetrics.textContent = [equity, advice.metrics].filter(Boolean).join(' · ');
    advisorPanel.hidden = false;
    advisorEmpty.hidden = true;
    advisorContent.hidden = false;
    advisorPanel.dataset.tone = advice.tone || 'neutral';
    advisorPanel.title = `${advisorRecommendation.textContent}；${advisorReason.textContent}；${advisorMetrics.textContent}`;
  }

  function strengthGradeFor(percent) {
    if (percent >= 72) return { key: 'crush', label: '碾压' };
    if (percent >= 50) return { key: 'good', label: '优势' };
    if (percent >= 30) return { key: 'mid', label: '胶着' };
    return { key: 'bad', label: '劣势' };
  }

  function handStrengthKey() {
    const active = typeof engine.activePlayers === 'function'
      ? engine.activePlayers().map((player) => player.idx).join(',')
      : '';
    const cards = [...(me.hole || []), ...(engine.revealedBoard?.() || [])]
      .map(cardSignature).join('|');
    return [engine.round, engine.street, engine.revealed, active, cards].join(':');
  }

  function renderEmptyHandStrength(message) {
    strengthFill.style.width = '0%';
    strengthValue.textContent = '--';
    strengthGrade.textContent = message;
    handStrength.dataset.tier = 'empty';
    handStrength.removeAttribute('aria-valuenow');
    handStrength.setAttribute('aria-valuetext', message);
  }

  function refreshHandStrength(equityOverride = null) {
    if (destroyed) return null;
    if (strengthPauseLabel) {
      renderEmptyHandStrength(strengthPauseLabel);
      return null;
    }
    if (!me?.alive) {
      renderEmptyHandStrength('已阵亡');
      return null;
    }
    if (me.folded) {
      renderEmptyHandStrength('已退避');
      return null;
    }
    if (!me.hole?.length || me.hole.length < 2) {
      renderEmptyHandStrength('等待发牌');
      return null;
    }
    const opponents = typeof engine.activePlayers === 'function'
      ? engine.activePlayers().filter((player) => Number(player.idx) !== Number(myIdx)).length
      : 0;
    if (opponents < 1) {
      renderEmptyHandStrength('无人应战');
      return null;
    }

    const key = handStrengthKey();
    let equity = equityOverride !== null
      && equityOverride !== undefined
      && Number.isFinite(Number(equityOverride))
      ? Number(equityOverride)
      : null;
    if (equity === null && key === strengthCacheKey) equity = strengthCache?.equity;
    if (!Number.isFinite(equity)) {
      try {
        equity = Advisor.estimateEquity(engine, me, Config.PLAYER_SIMS);
      } catch {
        equity = null;
      }
    }
    if (!Number.isFinite(equity)) {
      renderEmptyHandStrength('暂无数据');
      return null;
    }

    equity = Math.max(0, Math.min(1, equity));
    strengthCacheKey = key;
    strengthCache = { equity };
    const percent = Math.round(equity * 100);
    const grade = strengthGradeFor(percent);
    strengthFill.style.width = `${percent}%`;
    strengthValue.textContent = `${percent}%`;
    strengthGrade.textContent = grade.label;
    handStrength.dataset.tier = grade.key;
    handStrength.setAttribute('aria-valuenow', String(percent));
    handStrength.setAttribute('aria-valuetext', `牌力 ${percent}%，${grade.label}`);
    return equity;
  }

  function refreshAdvisor() {
    if (destroyed) return;
    refreshHandStrength();
    if (!advisorEnabled) {
      advisorPanel.hidden = true;
      return;
    }
    if (!me?.alive) {
      renderAdvisorEmpty('你已阵亡，本局不再生成建议');
      return;
    }
    if (me.folded) {
      renderAdvisorEmpty('本回合已退避，等待下一回合');
      return;
    }
    if (!me.hole?.length || me.hole.length < 2) {
      renderAdvisorEmpty('等待发牌');
      return;
    }
    if (!awaiting || pending || !lastOptions || engine.waitingIdx !== myIdx) {
      renderAdvisorEmpty('等待你的行动');
      return;
    }
    const key = Advisor.decisionKey(engine, me, lastOptions);
    if (key !== adviceCacheKey) {
      adviceCacheKey = key;
      adviceCache = Advisor.analyzeDecision(engine, me, lastOptions);
    }
    renderDecisionAdvice(adviceCache);
  }

  advisorToggle.addEventListener('change', () => {
    advisorEnabled = advisorToggle.checked;
    try {
      localStorage.setItem('qyj-ai-assist', advisorEnabled ? 'on' : 'off');
    } catch {
      // Keep the current-session preference when storage is unavailable.
    }
    refreshAdvisor();
  });

  function clockNow() {
    return globalThis.performance?.now?.() ?? Date.now();
  }

  function setObservedTurnClock(idx, rawClock = null, fallbackSeconds = Config.ACTION_TIME) {
    const seatIdx = Number(rawClock?.idx ?? idx);
    if (!Number.isInteger(seatIdx) || seatIdx < 1 || seatIdx > playerCount) {
      observedTurnClock = null;
      return;
    }
    const fallbackMs = Math.max(0, Number(fallbackSeconds) || Config.ACTION_TIME) * 1000;
    const incomingRemaining = Number(rawClock?.remainingMs);
    const incomingTotal = Number(rawClock?.totalMs);
    const remainingMs = Number.isFinite(incomingRemaining)
      ? Math.max(0, incomingRemaining)
      : fallbackMs;
    const totalMs = Math.max(
      1000,
      remainingMs,
      Number.isFinite(incomingTotal) ? incomingTotal : Config.ACTION_TIME * 1000,
    );
    turnClockSequence += 1;
    observedTurnClock = {
      turnId: rawClock?.turnId ?? `mirror-${turnClockSequence}`,
      idx: seatIdx,
      remainingMs,
      totalMs,
      receivedAt: clockNow(),
    };
  }

  function clearObservedTurnClock(idx = null) {
    if (idx !== null && Number(observedTurnClock?.idx) !== Number(idx)) return;
    observedTurnClock = null;
  }

  function observedRemainingMs() {
    if (!observedTurnClock) return 0;
    return Math.max(
      0,
      observedTurnClock.remainingMs - (clockNow() - observedTurnClock.receivedAt),
    );
  }

  function syncObservedClockFromEngine(activeIdx) {
    const clock = engine.actionClock;
    if (clock && Number(clock.idx) === Number(activeIdx)) {
      setObservedTurnClock(activeIdx, clock);
      return;
    }
    if (!observedTurnClock || Number(observedTurnClock.idx) !== Number(activeIdx)) {
      setObservedTurnClock(activeIdx);
    }
  }

  function refreshAll() {
    const syncedTurn = Number(engine.actingIdx || engine.waitingIdx || 0);
    if (syncedTurn > 0) {
      turnIdx = syncedTurn;
      actionPhaseStarted = true;
      syncObservedClockFromEngine(syncedTurn);
    }
    else if (engine.actingIdx === 0) {
      turnIdx = null;
      clearObservedTurnClock();
    }
    if (!actionPhaseStarted && ['preflop', 'flop', 'turn', 'river'].includes(engine.street)) {
      actionPhaseStarted = players.slice(1).some((player) => player?.acted || player?.lastAction);
    }
    for (let idx = 1; idx <= playerCount; idx++) setHp(idx);
    myPlayerName.textContent = me.playerName || '你';
    refreshLeaveButton();
    for (const [idx, nodes] of seatMap) {
      const player = players[idx];
      if (!player) continue;
      const displayName = player.playerName || player.hero.name;
      nodes.playerName.textContent = displayName;
      nodes.heroName.textContent = player.hero.name;
      nodes.root.setAttribute(
        'aria-label',
        `查看${displayName}的扑克统计，气血${player.hp}`,
      );
      nodes.profileHit.setAttribute(
        'aria-label',
        `查看${displayName}的扑克统计，气血${player.hp}`,
      );
    }
    refreshDealerSeats();
    updatePot();
    updateHand();
    refreshSkill();
    refreshAdvisor();
    renderAllSeatStatuses();
  }

  function renderSeatCountdown(idx) {
    const seatIdx = Number(idx);
    const statusNode = statusNodes.get(seatIdx);
    if (!statusNode) return;
    const activeIdx = Number(activeStatusTurn());
    const isMyTurn = seatIdx === Number(myIdx)
      && awaiting
      && !pending
      && activeIdx === Number(myIdx)
      && Number(engine.waitingIdx) === Number(myIdx);
    const isObservedTurn = activeIdx === seatIdx
      && Number(observedTurnClock?.idx) === seatIdx;
    const hasCountdown = isMyTurn || isObservedTurn;
    const remaining = isMyTurn
      ? Math.max(0, Number(timeLeft) || 0)
      : observedRemainingMs() / 1000;
    const total = isMyTurn
      ? Math.max(1, Number(timerTotal) || Config.ACTION_TIME, remaining)
      : Math.max(1, Number(observedTurnClock?.totalMs) / 1000 || Config.ACTION_TIME, remaining);
    const ratio = hasCountdown ? Math.max(0, Math.min(1, remaining / total)) : 0;
    const progress = Number((ratio * 100).toFixed(2));
    const seconds = Math.max(0, Math.ceil(remaining));
    const low = hasCountdown && remaining > 0 && remaining <= 5;

    const wasActive = statusNode.root.dataset.countdownActive === 'true';
    statusNode.root.classList.toggle('has-countdown', hasCountdown);
    statusNode.root.classList.toggle('is-countdown-low', low);
    if (hasCountdown) {
      statusNode.root.style.setProperty('--h5-turn-progress', `${progress}%`);
      statusNode.root.dataset.countdownActive = 'true';
      statusNode.root.dataset.remaining = String(seconds);
      statusNode.root.dataset.progress = String(progress);
      statusNode.label.textContent = `轮到行动 · ${seconds}s`;
    } else {
      statusNode.root.style.removeProperty('--h5-turn-progress');
      delete statusNode.root.dataset.countdownActive;
      delete statusNode.root.dataset.remaining;
      delete statusNode.root.dataset.progress;
      if (wasActive) statusNode.label.textContent = seatStatus(seatIdx).label;
    }
  }

  function renderActionCountdown() {
    renderSeatCountdown(myIdx);
  }

  function disableActions() {
    awaiting = false;
    for (const item of Object.values(actionButtons)) item.disabled = true;
    extend.disabled = true;
    renderActionCountdown();
    refreshAdvisor();
  }

  function submit(action) {
    if (!awaiting || pending || !engine.waitingIdx) return;
    pending = true;
    disableActions();
    hintText.textContent = '提交中…';
    engine.playerAct(action);
  }

  function guardedSubmit(key, action) {
    const needsConfirm = key === 'allin' || (key === 'fold' && lastOptions?.canCheck);
    if (!needsConfirm) return submit(action);
    if (confirmAction === key && confirmTimer > 0) {
      confirmAction = null;
      confirmTimer = 0;
      return submit(action);
    }
    confirmAction = key;
    confirmTimer = 3;
    const target = key === 'allin' ? actionButtons.allin : actionButtons.fold;
    target.textContent = key === 'allin' ? '确认决死' : '确认退避';
    hintText.textContent = key === 'allin' ? '再次点击确认决死。' : '当前可免费静观，仍要退避请再次点击。';
  }

  const actionMap = new Map();
  for (const [key, item] of Object.entries(actionButtons)) {
    item.addEventListener('click', () => {
      const action = actionMap.get(key);
      if (action) guardedSubmit(key === 'raiseS' || key === 'raiseM' || key === 'raiseL' ? 'raise' : key, action);
    });
  }

  extend.addEventListener('click', () => {
    if (!awaiting || pending) return;
    if (engine.extendTime(myIdx)) {
      timeLeft += Config.EXTEND_TIME;
      timerTotal = Math.max(timeLeft, timerTotal + Config.EXTEND_TIME);
      extend.disabled = true;
      renderActionCountdown();
    }
  });

  function updateActions(options, remain) {
    const continuing = awaiting && Number(engine.waitingIdx) === Number(myIdx);
    const previousRemaining = timeLeft;
    const incomingRemaining = Math.max(0, Number(remain ?? Config.ACTION_TIME) || 0);
    if (continuing && incomingRemaining > previousRemaining) {
      timerTotal = Math.max(timerTotal, previousRemaining)
        + (incomingRemaining - previousRemaining);
    } else {
      timerTotal = Math.max(Config.ACTION_TIME, incomingRemaining);
    }
    lastOptions = options;
    awaiting = true;
    pending = false;
    confirmAction = null;
    confirmTimer = 0;
    timeLeft = incomingRemaining;
    actionMap.clear();
    actionMap.set('fold', { type: 'fold' });
    actionMap.set('call', { type: options.canCheck ? 'check' : 'call' });
    if (options.canAllIn !== false) actionMap.set('allin', { type: 'allin' });
    const tiers = Object.fromEntries((options.tiers || []).map((tier) => [tier.key, tier]));
    const slots = { raiseS: 'feint', raiseM: 'strike', raiseL: 'fierce' };
    for (const [slot, tierKey] of Object.entries(slots)) {
      const tier = tiers[tierKey];
      if (tier) actionMap.set(slot, { type: 'raise', tier });
    }
    actionButtons.fold.textContent = '退避';
    actionButtons.call.textContent = options.canCheck ? '静观' : `应战 ${options.callAmt}`;
    actionButtons.allin.textContent = '决死';
    for (const [slot, tierKey] of Object.entries(slots)) {
      const tier = tiers[tierKey];
      actionButtons[slot].textContent = tier ? `${tier.name} ${tier.cost}` : ACTION_LABELS[tierKey];
    }
    for (const [key, item] of Object.entries(actionButtons)) item.disabled = !actionMap.has(key);
    extend.disabled = me.energy < Config.EXTEND_COST;
    hintText.textContent = '轮到你行动';
    renderActionCountdown();
    refreshAdvisor();
  }

  function openSkillChoice(input) {
    if (!input?.fields?.length) {
      engine.useSkill(myIdx);
      return;
    }
    let index = 0;
    const selection = {};
    const chosenLabels = [];
    const body = element('div', { className: 'h5-skill-choice' });
    const drawer = openDrawer(input.title || me.hero.skillName, body, 'h5-drawer--skill');
    const renderStep = () => {
      const field = input.fields[index];
      clear(body);
      if (!field) {
        body.append(
          element('p', { className: 'h5-drawer__lead', text: '确认技能选择' }),
          element('ul', { className: 'h5-skill-summary' }, chosenLabels.map((label) => element('li', { text: label }))),
          element('div', { className: 'h5-skill-choice__actions' }, [
            button('上一步', { className: 'h5-secondary-button', on: { click: () => { index = Math.max(0, index - 1); chosenLabels.pop(); renderStep(); } } }),
            button('确认发动', {
              className: 'h5-primary-button',
              attrs: { 'data-testid': 'h5-confirm-skill' },
              on: {
                click: () => {
                  if (Number(engine.waitingIdx) !== Number(myIdx)
                    || Number(engine.actingIdx) !== Number(myIdx)
                    || !engine.canUseSkill(myIdx)) {
                    closeDrawer();
                    refreshSkill();
                    return;
                  }
                  closeDrawer();
                  engine.useSkill(myIdx, selection);
                },
              },
            }),
          ]),
        );
        return;
      }
      body.append(
        element('p', { className: 'h5-skill-choice__step', text: `${index + 1}/${input.fields.length} · ${field.label}` }),
        element('div', { className: 'h5-skill-choice__options' }, (field.options || []).map((option) => (
          button('', {
            className: 'h5-skill-option',
            attrs: { 'aria-label': option.label },
            on: {
              click: () => {
                selection[field.key] = option.value;
                chosenLabels[index] = `${field.label}：${option.label}`;
                index += 1;
                renderStep();
              },
            },
          }, [
            element('strong', { text: option.label }),
            element('span', { text: option.description || '' }),
          ])
        ))),
        index > 0 && button('上一步', {
          className: 'h5-secondary-button h5-skill-choice__back',
          on: { click: () => { index -= 1; chosenLabels.pop(); renderStep(); } },
        }),
      );
    };
    renderStep();
    drawer.querySelector('.h5-drawer__close')?.setAttribute('data-testid', 'h5-cancel-skill');
  }

  skillButton.addEventListener('click', () => {
    if (skillButton.dataset.longPressed === 'true') {
      delete skillButton.dataset.longPressed;
      return;
    }
    if (Number(engine.waitingIdx) !== Number(myIdx)
      || Number(engine.actingIdx) !== Number(myIdx)
      || !engine.canUseSkill(myIdx)
      || pending) return;
    openSkillChoice(engine.getSkillPrompt(myIdx));
  });

  bindListener('onSync', refreshAll);
  bindListener('onLog', addLog);
  bindListener('chat', appendChatMessage);
  bindListener('onRoundStart', (round, blinds, dealerIdx) => {
    clearTransientFeedback();
    clearPublicHoleFeedback();
    publicHoleCards.clear();
    seatActions.clear();
    clearObservedTurnClock();
    strengthCacheKey = '';
    strengthCache = null;
    strengthPauseLabel = '';
    turnIdx = null;
    actionPhaseStarted = false;
    lastHandCategory = null;
    lastStrongHandActive = false;
    lastHandHitAt = 0;
    lastStrongHandVibrationKey = '';
    resetCurrentHand();
    roundText.textContent = `第 ${round}/${Config.MAX_ROUNDS} 回合`;
    blindText.textContent = `血祭 ${blinds.sb}/${blinds.bb}`;
    refreshDealerSeats(dealerIdx);
    hintText.textContent = '';
    boardCards.forEach((item, index) => item.faceDown(Config.BOARD_SLOT_NAMES[index + 1]));
    renderAllSeatStatuses();
    updatePot();
    refreshAdvisor();
  });
  bindListener('onDeal', () => {
    const current = updateHand();
    const premium = classifyH5PremiumStartingHand(me.hole);
    if (premium && current) showHandHit(premium, { ...current, core: [...me.hole] });
    refreshSkill();
    refreshAdvisor();
  });
  bindListener('onBlindsPosted', (smallIdx, small, bigIdx, big) => {
    actionPhaseStarted = true;
    rememberSeatAction(smallIdx, 'smallBlind', small);
    rememberSeatAction(bigIdx, 'bigBlind', big);
    renderAllSeatStatuses();
    updatePot();
  });
  bindListener('onTurnStart', (idx, clock = null) => {
    turnIdx = idx;
    actionPhaseStarted = true;
    setObservedTurnClock(idx, clock);
    renderAllSeatStatuses();
    refreshSkill();
    refreshAdvisor();
  });
  bindListener('onAwaitAction', (idx, options, remain, clock = null) => {
    turnIdx = idx;
    actionPhaseStarted = true;
    setObservedTurnClock(idx, clock, remain ?? Config.ACTION_TIME);
    renderAllSeatStatuses();
    if (idx === myIdx) updateActions(options, remain);
    else refreshAdvisor();
    refreshSkill();
  });
  bindListener('onActionClock', (clock) => {
    const idx = Number(clock?.idx || engine.actionClock?.idx || 0);
    if (idx > 0) {
      turnIdx = idx;
      actionPhaseStarted = true;
      setObservedTurnClock(idx, clock || engine.actionClock);
    } else {
      clearObservedTurnClock();
    }
    renderAllSeatStatuses();
  });
  bindListener('onAction', (idx, key, amount = 0) => {
    pending = false;
    turnIdx = null;
    clearObservedTurnClock(idx);
    if (idx === myIdx) disableActions();
    const text = actionText(key, amount, players[idx]?.allIn);
    rememberSeatAction(idx, key, amount);
    if (idx === myIdx) hintText.textContent = text;
    renderAllSeatStatuses();
    updatePot();
    screen.querySelector('.h5-drawer--skill') && closeDrawer();
    refreshSkill();
    refreshAdvisor();
  });
  bindListener('onStreet', (street, revealTo) => {
    clearObservedTurnClock();
    for (let index = 0; index < revealTo; index++) boardCards[index].setCard(engine.board[index]);
    resetStreetSeatActions();
    updateHand({ announce: true, street });
    updatePot();
    screen.querySelector('.h5-drawer--skill') && closeDrawer();
    refreshSkill();
    refreshAdvisor();
  });
  bindListener('onHpChange', (idx) => { setHp(idx); renderAllSeatStatuses(); });
  bindListener('onEnergyChange', (idx) => { setHp(idx); refreshSkill(); });
  bindListener('onHoleChange', (idx) => {
    if (idx === myIdx) {
      lastHandCategory = null;
      lastStrongHandActive = false;
      updateHand();
      refreshAdvisor();
    }
  });
  bindListener('onSkill', (idx, _skillId, skillName) => {
    flashSkill(idx);
    addLog(`${players[idx].hero.name} 发动【${skillName}】`, 'skill');
    hintText.textContent = `【${skillName}】发动`;
  });
  bindListener('onPassive', (idx, _skillId, skillName) => {
    flashSkill(idx);
    addLog(`${players[idx].hero.name} 被动【${skillName}】生效`, 'skill');
  });
  bindListener('onSkillEffect', (idx, _skillId, skillName) => addLog(`${players[idx].hero.name}【${skillName}】结算`, 'skill'));
  bindListener('onQuote', (idx, text) => addLog(`${players[idx].hero.name}：「${text}」`, 'quote'));
  bindListener('onSkillResult', (idx, result) => {
    if (idx !== myIdx || !result) return;
    if (result.card) hintText.textContent = `技能结果：${cardText(result.card)}`;
    else if (result.skillName) hintText.textContent = `已复制【${result.skillName}】`;
    else hintText.textContent = '技能已结算';
  });
  bindListener('onSkillPublicResult', (idx, result) => {
    if (result?.card) addLog(`${players[idx].hero.name} 公开 ${cardText(result.card)}`, 'skill');
    if (result?.kind === 'reveal_self' && result.card && (result.cardIdx === 1 || result.cardIdx === 2)) {
      const current = publicHoleCards.get(Number(idx)) || [null, null];
      current[result.cardIdx - 1] = result.card;
      showPublicHoleCards(idx, current, '技能公开');
    }
  });
  bindListener('onPotAwarded', (winners, amount, uncontested, bonus = 0, netWinnings = {}) => {
    turnIdx = null;
    clearObservedTurnClock();
    actionPhaseStarted = false;
    renderAllSeatStatuses();
    addLog(`${winners.map((idx) => players[idx].hero.name).join('、')} 获得 ${amount}`, 'result');
    if (uncontested) {
      if (roundResultTimer) clearTimeout(roundResultTimer);
      clearSettlementFeedback();
      const gross = Math.max(0, Number(amount) + Number(bonus || 0));
      const wonAmount = Object.fromEntries(winners.map((idx) => [idx, gross / Math.max(1, winners.length)]));
      const rows = settlementRows(wonAmount, netWinnings);
      showSettlementAmounts(rows);
      animateChipAwards(winners.map((idx) => ({
        winnerIdx: Number(idx),
        amount: gross / Math.max(1, winners.length),
        label: '主池',
      })));
      showSettlementAnnouncement(rows, gross);
      roundResultTimer = setTimeout(() => {
        clearSettlementFeedback();
        roundResultTimer = null;
      }, 2000);
    }
    updatePot();
  });
  bindListener('onAllInReveal', (entrants) => {
    clearObservedTurnClock();
    strengthPauseLabel = '亮牌中';
    renderEmptyHandStrength('亮牌中');
    addLog('决死亮牌：公开所有在局暗令', 'result');
    for (const player of entrants) {
      if (player.hole?.length >= 2) showPublicHoleCards(player.idx, player.hole, '决死亮牌');
    }
  });
  bindListener('onShowdown', (data) => {
    turnIdx = null;
    clearObservedTurnClock();
    actionPhaseStarted = false;
    strengthPauseLabel = '结算中';
    renderEmptyHandStrength('结算中');
    renderAllSeatStatuses();
    clearPublicHoleFeedback();
    publicHoleCards.clear();
    addLog(`亮招结算 · 总池 ${data.totalPot}`, 'result');
    const entry = data.entrants?.find((player) => player.idx === myIdx);
    if (entry?.showdownInfo?.name) {
      const category = Number(entry.showdownInfo.cat) || 0;
      const poker = Config.HAND_NAMES[category]?.poker || '';
      handName.textContent = `亮招：${entry.showdownInfo.name}`;
      handName.setAttribute('aria-label', `亮招牌型：${entry.showdownInfo.name}${poker ? `，${poker}` : ''}`);
      handName.title = poker ? `${entry.showdownInfo.name} · ${poker}` : entry.showdownInfo.name;
      const showdownHole = entry.hole?.length >= 2 ? entry.hole : me.hole;
      const showdownCards = [...showdownHole, ...engine.revealedBoard()];
      const showdownHand = showdownCards.length >= 5
        ? describe(showdownCards)
        : { cat: category, core: [] };
      syncMajorHandEffect(showdownHand, showdownHole);
    }
    showShowdown(data);
    updatePot();
  });
  bindListener('onDeath', (idx) => {
    if (Number(activeStatusTurn()) === Number(idx)) turnIdx = null;
    clearObservedTurnClock(idx);
    if (Number(idx) === Number(myIdx)) refreshLeaveButton();
    renderAllSeatStatuses();
    refreshHandStrength();
    addLog(`${players[idx].hero.name} 阵亡`, 'result');
  });
  bindListener('onRoundEnd', () => {
    turnIdx = null;
    clearObservedTurnClock();
    actionPhaseStarted = false;
    strengthPauseLabel = '等待下一局';
    renderEmptyHandStrength('等待下一局');
    disableActions();
    screen.querySelector('.h5-drawer--skill') && closeDrawer();
    refreshSkill();
    renderAllSeatStatuses();
  });
  bindListener('onGameOver', (ranking) => {
    clearObservedTurnClock();
    disableActions();
    const myRank = ranking.findIndex((player) => player.idx === myIdx) + 1;
    playSFX(myRank === 1 ? 'win' : 'lose');
    engine.delay(1.2, () => { if (!destroyed) onGameOver?.(ranking); });
  });

  refreshAll();
  addLog('对局开始：六位英雄已入座。', 'sys');

  return {
    tick(dt) {
      if (destroyed) return;
      const observedIdx = Number(observedTurnClock?.idx || 0);
      if (observedIdx > 0 && observedIdx !== Number(myIdx)) {
        renderSeatCountdown(observedIdx);
      }
      if (awaiting) {
        timeLeft = Math.max(0, timeLeft - dt);
        renderActionCountdown();
        if (timeLeft <= 0 && !pending) submit(lastOptions?.canCheck ? { type: 'check' } : { type: 'fold' });
      } else {
        renderActionCountdown();
      }
      if (confirmTimer > 0) {
        confirmTimer -= dt;
        if (confirmTimer <= 0) {
          confirmAction = null;
          if (lastOptions) updateActions(lastOptions, timeLeft);
        }
      }
      skillElapsed += dt;
      if (skillElapsed >= .25) {
        skillElapsed = 0;
        myPlayerName.textContent = me.playerName || '你';
        refreshSkill();
      }
    },
    destroy() {
      destroyed = true;
      clearTransientFeedback();
      closeDrawer();
      for (const [name, previous] of previousListeners) {
        if (previous) listeners[name] = previous;
        else delete listeners[name];
      }
      clear(root);
    },
  };
}
