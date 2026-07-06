// ============================================================================
// online.js - 联机模式：连接 → 组队大厅 → 队伍房间 → 选将 → 权威对局
// 协议与 Node 对战服（server/server.mjs）对齐；对局界面复用 battle.js
// ============================================================================

import { HEROES, getHero } from '../game/heroes.js';
import { RemoteEngine } from '../net/remoteengine.js';
import { attachBattle } from './battle.js';
import { showResult } from './result.js';

const h = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

export function startOnline(onExit) {
  const app = document.getElementById('app');
  let ws = null;
  let screen = 'connecting'; // connecting/lobby/room/pick/battle/result
  let myName = '';
  let renameDraft = null;
  let engine = null;   // RemoteEngine
  let battle = null;
  let mySeat = 1;
  let closed = false;

  const send = (obj) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  };

  // ---------------- 界面骨架 ----------------

  const page = (inner) => {
    const el = h(`<div class="screen"><div class="online-wrap" style="position:relative;z-index:1;
      display:flex;flex-direction:column;align-items:center;height:100%;padding-top:28px;gap:10px">
      ${inner}</div></div>`);
    app.replaceChildren(el);
    return el;
  };
  const titleHtml = `<div class="select-title" style="margin-top:0">群 英 决</div>`;

  function toastMsg(msg) {
    const fx = document.getElementById('fx');
    const div = h(`<div style="position:absolute;left:50%;top:70px;transform:translateX(-50%);
      background:rgba(22,17,11,.95);border:1px solid var(--gold);border-radius:8px;
      padding:8px 18px;color:var(--text);font-size:13px;z-index:300">${msg}</div>`);
    fx.appendChild(div);
    setTimeout(() => div.remove(), 2500);
  }

  function showConnecting(text = '正在连接决斗阵盘…') {
    screen = 'connecting';
    page(`${titleHtml}<div style="color:var(--text-dim);margin-top:20px">${text}</div>
      <button class="again-btn back-btn" style="margin-top:24px">返 回 单 机</button>`);
    app.querySelector('.back-btn').addEventListener('click', () => quit());
  }

  function showLobby(a) {
    screen = 'lobby';
    engine = null; battle = null;
    myName = a.yourName || myName;
    const rows = (a.teams || []).map((t) => {
      const joinable = t.phase === 'lobby' && t.count < 3;
      const state = t.phase === 'lobby' ? '待命' : t.phase === 'picking' ? '选将中' : '对局中';
      return `<div class="result-row" style="gap:12px">
        <span class="rr-name">${t.name}</span>
        <span style="width:44px">${t.count}/3</span>
        <span style="width:56px;color:${t.phase === 'lobby' ? 'var(--green)' : 'var(--text-dim)'}">${state}</span>
        <button class="join-btn" data-id="${t.id}" ${joinable ? '' : 'disabled'}
          style="height:34px;padding:0 14px;background:#287846;border-radius:8px">加 入</button>
      </div>`;
    }).join('') || `<div style="color:var(--text-faint);text-align:center;padding:20px">暂无队伍，点击下方按钮创建第一支队伍</div>`;

    const el = page(`${titleHtml}
      <div class="select-hint" style="margin-top:0">组 队 大 厅</div>
      <div style="font-size:12px;color:var(--text-dim)">你的代号：${myName}（进入队伍后可改名）</div>
      <div class="result-rows" style="width:min(86%,620px);overflow-y:auto;flex:1;margin-top:6px">${rows}</div>
      <div style="display:flex;gap:14px;margin:8px 0 24px">
        <button class="again-btn create-btn" style="width:170px">创 建 队 伍</button>
        <button class="again-btn refresh-btn" style="width:110px;background:#4a3a26">刷 新</button>
        <button class="again-btn back-btn" style="width:130px;background:#3a322e">返 回 单 机</button>
      </div>`);
    el.querySelector('.create-btn').addEventListener('click', () => send({ cmd: 'create' }));
    el.querySelector('.refresh-btn').addEventListener('click', () => send({ cmd: 'lobby' }));
    el.querySelector('.back-btn').addEventListener('click', () => quit());
    el.querySelectorAll('.join-btn').forEach((b) =>
      b.addEventListener('click', () => send({ cmd: 'join', teamId: Number(b.dataset.id) })));
  }

  function showRoom(a) {
    screen = 'room';
    engine = null; battle = null;
    myName = a.yourName || myName;
    const rows = (a.members || []).map((m) => `
      <div class="result-row${m.isYou ? ' me' : ''}">
        <span class="rr-name">${m.name}${m.isYou ? '（你）' : ''}</span>
        <span style="color:var(--gold-bright);font-size:13px">${m.isOwner ? '👑 房主' : ''}</span>
      </div>`).join('');
    const empty = Array.from({ length: (a.maxMembers || 3) - (a.members || []).length })
      .map(() => `<div class="result-row" style="opacity:.5;justify-content:center;color:var(--text-faint)">— 虚位以待 —</div>`)
      .join('');

    const el = page(`${titleHtml}
      <div class="select-hint" style="margin-top:0">${a.name} · ${(a.members || []).length}/${a.maxMembers || 3}</div>
      <div class="result-rows" style="width:min(80%,560px);margin-top:8px">${rows}${empty}</div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:12px">
        <span style="font-size:13px;color:var(--text-dim)">我的代号</span>
        <input class="name-input" maxlength="8" value="${renameDraft ?? myName}"
          style="width:180px;height:36px;padding:0 10px;background:var(--panel-dark);
          border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px">
        <button class="again-btn rename-btn" style="width:90px;height:38px;background:#5a3e82">改 名</button>
      </div>
      <div style="display:flex;gap:14px;margin-top:10px">
        ${a.isOwner
          ? `<button class="again-btn start-btn" style="width:270px">开 始 游 戏（不足6人AI补位）</button>`
          : `<span style="color:var(--text-dim);align-self:center">等待房主开始游戏…</span>`}
        <button class="again-btn leave-btn" style="width:130px;background:#3a322e">退 出 队 伍</button>
      </div>`);
    const input = el.querySelector('.name-input');
    input.addEventListener('input', () => { renameDraft = input.value; });
    el.querySelector('.rename-btn').addEventListener('click', () => {
      if (renameDraft && renameDraft.trim()) send({ cmd: 'rename', name: renameDraft.trim() });
    });
    el.querySelector('.leave-btn').addEventListener('click', () => {
      renameDraft = null;
      send({ cmd: 'leave' });
    });
    el.querySelector('.start-btn')?.addEventListener('click', () => send({ cmd: 'startPick' }));
  }

  function showPick(a) {
    screen = 'pick';
    const cards = (a.heroes || []).map((hh) => {
      const hero = getHero(hh.id);
      const takenByOther = hh.takenBy && !hh.mine;
      const stateText = hh.mine ? '✓ 已选定（点其他英雄可换）'
        : hh.takenBy ? `已被 ${hh.takenBy} 选走` : '点击选择';
      const stateColor = hh.mine ? 'var(--green)' : hh.takenBy ? 'var(--red)' : 'var(--text-dim)';
      return `<div class="hero-card pick-card" data-id="${hh.id}" data-taken="${takenByOther ? 1 : 0}"
        style="${hh.mine ? 'border-color:var(--gold-bright);border-width:3px;' : ''}${takenByOther ? 'opacity:.45;' : ''}">
        <div class="hc-portrait" style="background-image:url('${hero.portrait}')">
          <div class="hc-namebar">
            <span class="hc-name">${hero.name}</span>
            <span style="color:${hero.color};font-weight:bold;font-size:12px">${hero.type}</span>
          </div>
        </div>
        <div class="hc-body" style="text-align:center;color:${stateColor}">${stateText}</div>
      </div>`;
    }).join('');

    const el = page(`${titleHtml}
      <div class="select-hint" style="margin-top:0">选 将 · 英雄不可重复 · 先选先得</div>
      <div class="hero-grid" style="flex:1;margin:6px auto">${cards}</div>
      <div style="display:flex;gap:14px;align-items:center;margin-bottom:20px">
        <span style="font-size:13px;color:var(--text-dim)">⏳ ${a.deadline || 0} 秒后未选将随机分配</span>
        ${a.isOwner
          ? `<button class="again-btn go-btn" style="width:170px;${a.allPicked ? 'background:#9e2a22' : 'background:#3a322e'}"
              ${a.allPicked ? '' : 'disabled'}>${a.allPicked ? '开 战 ！' : '等待全员选定…'}</button>`
          : `<span style="color:var(--green);font-size:13px">${a.allPicked ? '全员已选定，等待房主开战…' : ''}</span>`}
      </div>`);
    el.querySelectorAll('.pick-card').forEach((c) => {
      c.addEventListener('click', () => {
        if (c.dataset.taken !== '1') send({ cmd: 'pick', heroId: c.dataset.id });
      });
    });
    el.querySelector('.go-btn')?.addEventListener('click', () => send({ cmd: 'startGame' }));
  }

  function startBattle(a) {
    screen = 'battle';
    mySeat = a.mySeat;
    const listeners = {};
    engine = new RemoteEngine(a, listeners, send);
    battle = attachBattle(engine, listeners, mySeat, (ranking) => {
      screen = 'result';
      engine = null; battle = null;
      showResult(ranking, mySeat, () => {
        screen = 'room';
        send({ cmd: 'backToRoom' });
        showConnecting('正在返回队伍房间…');
      }, '返 回 队 伍');
    });
  }

  // ---------------- 连接 ----------------

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = window.QYJ_WS_URL || `${proto}://${location.hostname}:8790`;
  showConnecting();
  try {
    ws = new WebSocket(url);
  } catch {
    showConnecting('无法连接对战服务器');
    return { tick() {} };
  }
  ws.addEventListener('open', () => send({ cmd: 'lobby' }));
  ws.addEventListener('close', () => {
    if (closed) return;
    showConnecting('与服务器断开连接，请刷新重试');
  });
  ws.addEventListener('error', () => {
    if (closed) return;
    showConnecting(`无法连接对战服务器（${url}）`);
  });
  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    const ev = msg.ev, a = msg.a || {};
    if (ev === 'lobby') {
      myName = a.yourName || myName;
      if (screen === 'connecting' || screen === 'lobby') showLobby(a);
    } else if (ev === 'team') {
      myName = a.yourName || myName;
      if (screen !== 'battle' && screen !== 'result') {
        renameDraft = null;
        showRoom(a);
      }
    } else if (ev === 'pick') {
      if (screen === 'room' || screen === 'pick') showPick(a);
    } else if (ev === 'gameStart') {
      startBattle(a);
    } else if (ev === 'toast') {
      toastMsg(a.msg || '');
    } else if (engine && screen === 'battle') {
      engine.onMessage(msg);
    }
  });

  function quit() {
    closed = true;
    try { ws && ws.close(); } catch { /* ignore */ }
    onExit();
  }

  return {
    tick(dt) {
      if (engine && screen === 'battle') {
        engine.update(dt);
        if (battle) battle.tick(dt);
      }
    },
  };
}
