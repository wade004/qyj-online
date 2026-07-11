// ============================================================================
// online.js - legacy PC renderer adapter for the DOM-free OnlineSession.
// ============================================================================

import { HEROES, getHero } from '../game/heroes.js';
import { createOnlineSession } from '../session/online-session.js';
import { attachBattle } from './battle.js';
import { showResult } from './result.js';

const h = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

const setText = (root, selector, value) => {
  const element = root.querySelector(selector);
  if (element) element.textContent = String(value ?? '');
  return element;
};

export function startOnline(onExit) {
  const app = document.getElementById('app');
  let renderedScreen = '';
  let renderedData = null;
  let renderedBattle = null;
  let battleView = null;
  let renameDraft = null;
  let lastNoticeRevision = 0;
  let closed = false;

  // ---------------- 界面骨架 ----------------

  const page = (inner) => {
    const el = h(`<div class="screen"><div class="online-wrap" style="position:relative;z-index:1;
      display:flex;flex-direction:column;align-items:center;height:100%;padding-top:28px;gap:10px">
      ${inner}</div></div>`);
    app.replaceChildren(el);
    return el;
  };
  const titleHtml = `<div class="select-title" style="margin-top:0">群 英 决</div>`;

  function toastMsg(message) {
    const fx = document.getElementById('fx');
    const div = h(`<div style="position:absolute;left:50%;top:70px;transform:translateX(-50%);
      background:rgba(22,17,11,.95);border:1px solid var(--gold);border-radius:8px;
      padding:8px 18px;color:var(--text);font-size:13px;z-index:300"></div>`);
    div.textContent = String(message ?? '');
    fx.appendChild(div);
    setTimeout(() => div.remove(), 2500);
  }

  function showConnecting(text = '正在连接决斗阵盘…') {
    battleView = null;
    const el = page(`${titleHtml}<div class="connecting-text" style="color:var(--text-dim);margin-top:20px"></div>
      <button class="again-btn back-btn" style="margin-top:24px">返 回 单 机</button>`);
    setText(el, '.connecting-text', text);
    el.querySelector('.back-btn').addEventListener('click', () => quit());
  }

  function showLobby(data) {
    battleView = null;
    const el = page(`${titleHtml}
      <div class="select-hint" style="margin-top:0">组 队 大 厅</div>
      <div class="lobby-player-name" style="font-size:12px;color:var(--text-dim)"></div>
      <div class="result-rows lobby-team-list" style="width:min(86%,620px);overflow-y:auto;flex:1;margin-top:6px"></div>
      <div style="display:flex;gap:14px;margin:8px 0 24px">
        <button class="again-btn create-btn" style="width:170px">创 建 队 伍</button>
        <button class="again-btn refresh-btn" style="width:110px;background:#4a3a26">刷 新</button>
        <button class="again-btn back-btn" style="width:130px;background:#3a322e">返 回 单 机</button>
      </div>`);
    setText(el, '.lobby-player-name', `你的代号：${data.yourName || ''}（进入队伍后可改名）`);
    const list = el.querySelector('.lobby-team-list');
    const teams = Array.isArray(data.teams) ? data.teams : [];
    if (!teams.length) {
      const empty = h(`<div style="color:var(--text-faint);text-align:center;padding:20px"></div>`);
      empty.textContent = '暂无队伍，点击下方按钮创建第一支队伍';
      list.appendChild(empty);
    }
    for (const team of teams) {
      const joinable = team.phase === 'lobby' && team.count < 3;
      const state = team.phase === 'lobby' ? '待命' : team.phase === 'picking' ? '选将中' : '对局中';
      const row = h(`<div class="result-row" style="gap:12px">
        <span class="rr-name team-name"></span>
        <span class="team-count" style="width:44px"></span>
        <span class="team-state" style="width:56px"></span>
        <button class="join-btn" style="height:34px;padding:0 14px;background:#287846;border-radius:8px">加 入</button>
      </div>`);
      setText(row, '.team-name', team.name);
      setText(row, '.team-count', `${Number(team.count) || 0}/3`);
      const stateEl = setText(row, '.team-state', state);
      stateEl.style.color = team.phase === 'lobby' ? 'var(--green)' : 'var(--text-dim)';
      const join = row.querySelector('.join-btn');
      join.disabled = !joinable;
      join.addEventListener('click', () => session.joinTeam(team.id));
      list.appendChild(row);
    }
    el.querySelector('.create-btn').addEventListener('click', () => session.createTeam());
    el.querySelector('.refresh-btn').addEventListener('click', () => session.refreshLobby());
    el.querySelector('.back-btn').addEventListener('click', () => quit());
  }

  function showRoom(data) {
    battleView = null;
    const ownerAction = data.isOwner
      ? `<button class="again-btn start-btn" style="width:270px">开 始 游 戏（不足6人AI补位）</button>`
      : `<span class="wait-owner" style="color:var(--text-dim);align-self:center">等待房主开始游戏…</span>`;
    const el = page(`${titleHtml}
      <div class="select-hint room-title" style="margin-top:0"></div>
      <div class="result-rows room-member-list" style="width:min(80%,560px);margin-top:8px"></div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:12px">
        <span style="font-size:13px;color:var(--text-dim)">我的代号</span>
        <input class="name-input" maxlength="8"
          style="width:180px;height:36px;padding:0 10px;background:var(--panel-dark);
          border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px">
        <button class="again-btn rename-btn" style="width:90px;height:38px;background:#5a3e82">改 名</button>
      </div>
      <div class="room-actions" style="display:flex;gap:14px;margin-top:10px">
        ${ownerAction}
        <button class="again-btn leave-btn" style="width:130px;background:#3a322e">退 出 队 伍</button>
      </div>`);
    const members = Array.isArray(data.members) ? data.members : [];
    const maxMembers = Number(data.maxMembers) || 3;
    setText(el, '.room-title', `${data.name || ''} · ${members.length}/${maxMembers}`);
    const list = el.querySelector('.room-member-list');
    for (const member of members) {
      const row = h(`<div class="result-row">
        <span class="rr-name member-name"></span>
        <span class="owner-mark" style="color:var(--gold-bright);font-size:13px"></span>
      </div>`);
      if (member.isYou) row.classList.add('me');
      setText(row, '.member-name', `${member.name || ''}${member.isYou ? '（你）' : ''}`);
      setText(row, '.owner-mark', member.isOwner ? '👑 房主' : '');
      list.appendChild(row);
    }
    for (let i = members.length; i < maxMembers; i++) {
      const empty = h(`<div class="result-row" style="opacity:.5;justify-content:center;color:var(--text-faint)"></div>`);
      empty.textContent = '— 虚位以待 —';
      list.appendChild(empty);
    }
    const input = el.querySelector('.name-input');
    input.value = renameDraft ?? data.yourName ?? '';
    input.addEventListener('input', () => { renameDraft = input.value; });
    el.querySelector('.rename-btn').addEventListener('click', () => {
      if (renameDraft && renameDraft.trim()) session.rename(renameDraft);
    });
    el.querySelector('.leave-btn').addEventListener('click', () => {
      renameDraft = null;
      session.leaveTeam();
    });
    el.querySelector('.start-btn')?.addEventListener('click', () => session.startPick());
  }

  function showPick(data) {
    const el = page(`${titleHtml}
      <div class="select-hint" style="margin-top:0">选 将 · 英雄不可重复 · 先选先得</div>
      <div class="hero-grid pick-grid" style="flex:1;margin:6px auto"></div>
      <div style="display:flex;gap:14px;align-items:center;margin-bottom:20px">
        <span class="pick-deadline" style="font-size:13px;color:var(--text-dim)"></span>
        <div class="pick-owner-action"></div>
      </div>`);
    const grid = el.querySelector('.pick-grid');
    for (const pick of Array.isArray(data.heroes) ? data.heroes : []) {
      const hero = getHero(pick.id) || HEROES[0];
      const takenByOther = !!pick.takenBy && !pick.mine;
      const stateText = pick.mine ? '✓ 已选定（点其他英雄可换）'
        : pick.takenBy ? `已被 ${pick.takenBy} 选走` : '点击选择';
      const card = h(`<button type="button" class="hero-card pick-card">
        <div class="hc-portrait"><div class="hc-namebar">
          <span class="hc-name"></span><span class="hero-type" style="font-weight:bold;font-size:12px"></span>
        </div></div>
        <div class="hc-body pick-state" style="text-align:center"></div>
      </button>`);
      card.querySelector('.hc-portrait').style.backgroundImage = `url('${hero.portrait}')`;
      setText(card, '.hc-name', hero.name);
      const typeEl = setText(card, '.hero-type', hero.type);
      typeEl.style.color = hero.color;
      const stateEl = setText(card, '.pick-state', stateText);
      stateEl.style.color = pick.mine ? 'var(--green)'
        : pick.takenBy ? 'var(--red)' : 'var(--text-dim)';
      if (pick.mine) {
        card.style.borderColor = 'var(--gold-bright)';
        card.style.borderWidth = '3px';
      }
      if (takenByOther) card.style.opacity = '.45';
      card.addEventListener('click', () => {
        if (!takenByOther) session.pickHero(pick.id);
      });
      grid.appendChild(card);
    }
    setText(el, '.pick-deadline', `⏳ ${Number(data.deadline) || 0} 秒后未选将随机分配`);
    const action = el.querySelector('.pick-owner-action');
    if (data.isOwner) {
      const go = h(`<button class="again-btn go-btn" style="width:170px"></button>`);
      go.textContent = data.allPicked ? '开 战 ！' : '等待全员选定…';
      go.style.background = data.allPicked ? '#9e2a22' : '#3a322e';
      go.disabled = !data.allPicked;
      go.addEventListener('click', () => session.startGame());
      action.appendChild(go);
    } else if (data.allPicked) {
      const waiting = h(`<span style="color:var(--green);font-size:13px"></span>`);
      waiting.textContent = '全员已选定，等待房主开战…';
      action.appendChild(waiting);
    }
  }

  function startBattle(state) {
    if (!state.battle || renderedBattle === state.battle) return;
    renderedBattle = state.battle;
    const mySeat = state.data.mySeat;
    battleView = attachBattle(state.battle, state.battle.listeners, mySeat, (ranking) => {
      battleView = null;
      showResult(ranking, mySeat, () => session.backToRoom(), '返 回 队 伍');
    });
  }

  const session = createOnlineSession();
  const unsubscribe = session.subscribe((state) => {
    if (state.notice && state.notice.revision > lastNoticeRevision) {
      lastNoticeRevision = state.notice.revision;
      toastMsg(state.notice.message);
    }
    if (state.screen === 'result') return; // attachBattle preserves the existing result timing.
    if (state.screen === renderedScreen && state.data === renderedData
      && (state.screen !== 'battle' || state.battle === renderedBattle)) return;
    renderedScreen = state.screen;
    renderedData = state.data;
    if (state.screen === 'connecting') showConnecting(state.data?.text);
    else if (state.screen === 'lobby') showLobby(state.data || {});
    else if (state.screen === 'room') {
      renameDraft = null;
      showRoom(state.data || {});
    } else if (state.screen === 'pick') showPick(state.data || {});
    else if (state.screen === 'battle') startBattle(state);
  });

  function quit() {
    if (closed) return;
    closed = true;
    unsubscribe();
    session.destroy();
    onExit();
  }

  return {
    tick(dt) {
      session.tick(dt);
      if (session.getState().screen === 'battle' && battleView) battleView.tick(dt);
    },
    destroy: quit,
    session,
  };
}
