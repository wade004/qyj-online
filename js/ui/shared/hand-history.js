import { RANK_NAMES, SUITS } from '../../game/config.js';
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

function cardNode(card, testId) {
  if (!card) {
    return element('span', {
      className: 'hand-history__card is-hidden',
      text: '暗',
      attrs: { 'data-testid': testId, 'aria-label': '未公开底牌' },
    });
  }
  const rank = Number(card.r ?? card.rank);
  const suit = Number(card.s ?? card.suit);
  const suitInfo = SUITS[suit];
  const label = `${RANK_NAMES[rank] || rank}${suitInfo?.char || '?'}`;
  return element('span', {
    className: `hand-history__card${suitInfo?.red ? ' is-red' : ''}`,
    text: label,
    attrs: { 'data-testid': testId, 'aria-label': label },
  });
}

function participantRow(participant, prefix) {
  const net = netMeta(participant.netResult);
  const hero = getHero(participant.heroId);
  const visible = Number(participant.visibleCardCount) || participant.hole?.filter(Boolean).length || 0;
  const state = participant.folded
    ? '已弃牌'
    : participant.handName
      ? participant.handName
      : participant.allIn
        ? '全押亮牌'
        : visible === 2
          ? '已亮牌'
          : '未公开';
  return element('li', {
    className: `hand-history__player${participant.isYou ? ' is-self' : ''}`,
    attrs: {
      'data-testid': `${prefix}-player`,
      'data-player-seat': String(participant.seat),
      'data-is-you': participant.isYou ? 'true' : 'false',
      'data-folded': participant.folded ? 'true' : 'false',
      'data-visible-cards': String(visible),
    },
  }, [
    element('span', { className: 'hand-history__seat', text: `${participant.seat}号位` }),
    element('span', { className: 'hand-history__identity' }, [
      element('strong', { text: participant.playerName || hero?.name || '玩家' }),
      element('small', { text: hero?.name || participant.heroId || '未知英雄' }),
    ]),
    element('span', { className: 'hand-history__cards' }, [
      cardNode(participant.hole?.[0], `${prefix}-hole-card`),
      cardNode(participant.hole?.[1], `${prefix}-hole-card`),
    ]),
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
      element('small', { text: `房间 #${record.roomId} · ${record.tableSize}人桌 · ${safeDate(record.playedAt)}` }),
    ]),
    element('span', { className: `hand-history__result is-${net.tone}` }, [
      element('small', { text: resolution }),
      element('strong', { text: net.text }),
    ]),
  ]);
  const boardCards = Array.from({ length: 5 }, (_, index) => (
    cardNode(record.board?.[index], `${prefix}-board-card`)
  ));
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
        record.players || []).map((participant) => participantRow(participant, prefix))
      ),
      element('p', {
        className: 'hand-history__privacy',
        text: '自己的底牌始终可见；弃牌对手保持隐藏，只有实际亮牌的牌才会公开。',
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
