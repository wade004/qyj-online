import { RANK_NAMES, SUITS } from '../../game/config.js';
import { evalBest } from '../../game/handeval.js';
import { getHero } from '../../game/heroes.js';
import { button, element } from './dom.js';

function safeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function netMeta(value) {
  const net = Math.round(Number(value) || 0);
  return {
    net,
    tone: net > 0 ? 'win' : net < 0 ? 'loss' : 'draw',
    text: net > 0 ? `+${net}` : String(net),
  };
}

export function handRecordNumber(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0
    ? `#${String(id).padStart(6, '0')}`
    : '#------';
}

function normalizedCard(card) {
  if (!card) return null;
  return {
    rank: Number(card.r ?? card.rank),
    suit: Number(card.s ?? card.suit),
  };
}

const cardKey = (card) => {
  const normalized = normalizedCard(card);
  return normalized ? `${normalized.rank}:${normalized.suit}` : '';
};

export function bestFiveCardKeys(participant, board = []) {
  const hole = Array.isArray(participant?.hole) ? participant.hole : [];
  const community = Array.isArray(board) ? board.filter(Boolean) : [];
  if (!participant?.handName || hole.length !== 2 || hole.some((card) => !card)
    || community.length !== 5) return new Set();
  const cards = [...hole, ...community].map(normalizedCard);
  return new Set(evalBest(cards).best5.map(cardKey));
}

export function historyPlayersBySeat(record = {}) {
  const playersBySeat = new Map((record.players || []).map((participant) => [
    Number(participant.seat), participant,
  ]));
  return Array.from({ length: Number(record.tableSize) || 0 }, (_, index) => (
    playersBySeat.get(index + 1) || {
      seat: index + 1,
      playerName: '本局未参与',
      heroId: '',
      isYou: false,
      hole: [null, null],
      participated: false,
      folded: false,
      allIn: false,
      netResult: 0,
      handName: null,
    }
  ));
}

function cardNode(card, testId, { source = '', best = false } = {}) {
  if (!card) {
    return element('span', {
      className: `hand-history__card is-hidden${source ? ` is-${source}` : ''}`,
      text: '暗',
      attrs: { 'data-testid': testId, 'aria-label': '未公开底牌' },
    });
  }
  const rank = Number(card.r ?? card.rank);
  const suit = Number(card.s ?? card.suit);
  const suitInfo = SUITS[suit];
  const label = `${RANK_NAMES[rank] || rank}${suitInfo?.char || '?'}`;
  return element('span', {
    className: `hand-history__card${suitInfo?.red ? ' is-red' : ''}${source ? ` is-${source}` : ''}${best ? ' is-best-five' : ''}`,
    text: label,
    attrs: {
      'data-testid': testId,
      'data-card-source': source || undefined,
      'data-best-five': best ? 'true' : 'false',
      'aria-label': `${label}${best ? '，最终成牌' : ''}`,
    },
  });
}

function participantRow(participant, board, prefix) {
  const net = netMeta(participant.netResult);
  const hero = getHero(participant.heroId);
  const visible = Number(participant.visibleCardCount) || participant.hole?.filter(Boolean).length || 0;
  const state = participant.participated === false
    ? '本局未参与'
    : participant.folded
    ? '已弃牌'
    : participant.handName
      ? participant.handName
      : participant.allIn
        ? '全押亮牌'
        : visible === 2
          ? '已亮牌'
          : '未公开';
  const bestFive = bestFiveCardKeys(participant, board);
  const combinedCards = [
    ...(participant.hole || [null, null]).map((card) => cardNode(
      card,
      `${prefix}-hole-card`,
      { source: 'hole', best: bestFive.has(cardKey(card)) },
    )),
    ...Array.from({ length: 5 }, (_, index) => {
      const card = board?.[index];
      return cardNode(card, `${prefix}-player-board-card`, {
        source: 'board', best: bestFive.has(cardKey(card)),
      });
    }),
  ];
  return element('li', {
    className: `hand-history__player${participant.isYou ? ' is-self' : ''}${participant.participated === false ? ' is-absent' : ''}`,
    attrs: {
      'data-testid': `${prefix}-player`,
      'data-player-seat': String(participant.seat),
      'data-is-you': participant.isYou ? 'true' : 'false',
      'data-folded': participant.folded ? 'true' : 'false',
      'data-participated': participant.participated === false ? 'false' : 'true',
      'data-visible-cards': String(visible),
    },
  }, [
    element('span', { className: 'hand-history__seat', text: `${participant.seat}号位` }),
    element('span', { className: 'hand-history__identity' }, [
      element('strong', { text: participant.playerName || hero?.name || '玩家' }),
      element('small', { text: hero?.name || participant.heroId || '未知英雄' }),
    ]),
    element('span', { className: 'hand-history__cards hand-history__cards--combined' }, combinedCards),
    element('span', { className: 'hand-history__state', text: state }),
    element('strong', { className: `hand-history__net is-${net.tone}`, text: net.text }),
  ]);
}

function historyItem(record, prefix) {
  const net = netMeta(record.selfNetResult);
  const resolution = record.resolution === 'showdown' ? '摊牌比大小' : '其他玩家弃牌';
  const summary = element('summary', { className: 'hand-history__summary' }, [
    element('span', {}, [
      element('strong', { text: `${record.roomName || '联机房间'} · 第${record.round}局` }),
      element('small', {
        text: `唯一局号 ${handRecordNumber(record.id)} · 房间 #${record.roomId} · ${record.tableSize}人桌 · ${safeDate(record.playedAt)}`,
      }),
    ]),
    element('span', { className: `hand-history__result is-${net.tone}` }, [
      element('small', { text: resolution }),
      element('strong', { text: net.text }),
    ]),
  ]);
  const self = record.players?.find((participant) => participant.isYou);
  const selfBestFive = bestFiveCardKeys(self, record.board);
  const boardCards = Array.from({ length: 5 }, (_, index) => {
    const card = record.board?.[index];
    return cardNode(card, `${prefix}-board-card`, {
      source: 'board', best: selfBestFive.has(cardKey(card)),
    });
  });
  const players = historyPlayersBySeat(record);
  return element('details', {
    className: 'hand-history__item',
    attrs: {
      'data-testid': `${prefix}-item`,
      'data-record-id': String(record.id),
      'data-resolution': record.resolution,
    },
  }, [
    summary,
    element('div', { className: 'hand-history__detail' }, [
      element('div', { className: 'hand-history__board' }, [
        element('span', { text: '公牌' }),
        element('div', { className: 'hand-history__cards' }, boardCards),
        element('small', { text: `庄位 ${record.dealerSeat} · ${resolution}` }),
      ]),
      element('ol', { className: 'hand-history__players' }, (
        players.map((participant) => participantRow(participant, record.board, prefix))
      )),
      element('p', {
        className: 'hand-history__privacy',
        text: '每位玩家底牌后均展示本局公牌；完整亮牌时高亮最终五张成牌，弃牌对手的暗牌不会被推断或公开。',
      }),
    ]),
  ]);
}

export function createHandHistoryPanel({ loadPage, prefix = 'hand-history', pageSize = 20 } = {}) {
  const list = element('div', {
    className: 'hand-history__list', attrs: { 'data-testid': `${prefix}-list` },
  });
  const status = element('p', {
    className: 'hand-history__status', text: '正在读取牌局记录…',
    attrs: { 'data-testid': `${prefix}-status`, role: 'status', 'aria-live': 'polite' },
  });
  const more = button('加载更多', {
    className: 'hand-history__more',
    attrs: { 'data-testid': `${prefix}-load-more`, hidden: true },
  });
  const root = element('section', {
    className: 'hand-history', attrs: { 'data-testid': `${prefix}-panel` },
  }, [status, list, more]);
  let cursor = null;
  let loading = false;
  let loaded = false;

  async function load({ reset = false } = {}) {
    if (loading || typeof loadPage !== 'function') return false;
    loading = true;
    more.disabled = true;
    status.hidden = false;
    status.textContent = reset || !loaded ? '正在读取牌局记录…' : '正在加载更多…';
    if (reset) {
      cursor = null;
      loaded = false;
      list.replaceChildren();
    }
    try {
      const response = await loadPage({ limit: pageSize, cursor });
      if (!response?.ok) throw new Error(response?.error?.message || '牌局记录读取失败');
      const items = Array.isArray(response.data?.items) ? response.data.items : [];
      items.forEach((record) => list.appendChild(historyItem(record, prefix)));
      cursor = response.data?.nextCursor ?? null;
      loaded = true;
      status.textContent = list.childElementCount ? `已显示 ${list.childElementCount} 局` : '还没有联机牌局记录';
      more.hidden = cursor == null;
      return true;
    } catch (error) {
      status.textContent = error?.message || '牌局记录读取失败，请稍后重试';
      more.hidden = true;
      return false;
    } finally {
      loading = false;
      more.disabled = false;
    }
  }

  more.addEventListener('click', () => load());
  return { root, load };
}
