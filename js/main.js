// ============================================================================
// main.js - 群英决 网页版入口
// 首屏模式选择：单机人机对战 / 联机组队对战（Node 权威对战服）
// ============================================================================

import { Engine } from './game/engine.js';
import { HEROES } from './game/heroes.js';
import { shuffle } from './game/deck.js';
import { showHeroSelect } from './ui/heroselect.js?v=16-heroes';
import { attachBattle } from './ui/battle.js?v=pot-metrics';
import { showResult } from './ui/result.js';
import { startOnline } from './ui/online.js';
import { bindAudioToggle, initAudio } from './audio.js';

let engine = null;   // 单机引擎
let battle = null;
let online = null;   // 联机会话（自带 tick）

// ---------------- 单机流程 ----------------

function startBattle(heroId) {
  const rest = shuffle(HEROES.filter((h) => h.id !== heroId).map((h) => h.id));
  const ids = [heroId, ...rest.slice(0, 5)];
  const listeners = {};
  engine = new Engine(ids, listeners, null, {}, { endWhenHumanEliminated: true });
  battle = attachBattle(engine, listeners, 1, (ranking) => {
    engine = null;
    battle = null;
    showResult(ranking, 1, () => enterSelect());
  });
  engine.startGame();
}

function enterSelect() {
  engine = null; battle = null; online = null;
  showHeroSelect((heroId) => startBattle(heroId));
}

// ---------------- 首屏：模式选择 ----------------

function enterModeSelect() {
  engine = null; battle = null; online = null;
  const app = document.getElementById('app');
  const el = document.createElement('div');
  el.className = 'screen';
  el.innerHTML = `
    <div style="position:relative;z-index:1;display:flex;flex-direction:column;
      align-items:center;justify-content:center;height:100%;gap:16px">
      <div class="select-title" style="margin-top:0">群 英 决</div>
      <div class="select-sub">英雄对决 · 天机博弈 · 气血为注 · 杀招定生死</div>
      <button class="again-btn mode-sp" style="width:260px;margin-top:26px">单 机 · 人 机 对 战</button>
      <button class="again-btn mode-mp" style="width:260px;background:#287846">联 机 · 组 队 对 战</button>
      <div style="font-size:11px;color:var(--text-faint);margin-top:10px">
        联机模式需要对战服务器在线（web/server：node server.mjs）</div>
    </div>`;
  el.querySelector('.mode-sp').addEventListener('click', () => { initAudio(); enterSelect(); });
  el.querySelector('.mode-mp').addEventListener('click', () => {
    initAudio();
    online = startOnline(() => enterModeSelect());
  });
  app.replaceChildren(el);
}

// ---------------- 主循环 ----------------

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (online) {
    online.tick(dt);
  } else if (engine) {
    engine.update(dt);
    if (battle) battle.tick(dt);
  }
  requestAnimationFrame(loop);
}

bindAudioToggle(document.getElementById('audio-toggle'));
enterModeSelect();
requestAnimationFrame(loop);
