// PC-only application entry. H5 orientation and touch UI are intentionally not
// imported here so desktop behavior cannot be changed by mobile breakpoints.

import { HEROES } from '../game/heroes.js';
import { shuffle } from '../game/deck.js';
import { createLocalBattleSession } from '../session/local-battle-session.js';
import { createOnlineSession } from '../session/online-session.js';
import { showHeroSelect } from '../ui/heroselect.js';
import { attachBattle } from '../ui/battle.js';
import { showResult } from '../ui/result.js';
import { mountPcOnline } from '../ui/pc/online-view.js';
import { bindAudioToggle, initAudio } from '../audio.js';

const app = document.getElementById('app');
let localSession = null;
let battleView = null;
let onlineView = null;

function cleanupActiveFlow() {
  onlineView?.destroy?.();
  localSession?.destroy?.();
  onlineView = null;
  localSession = null;
  battleView = null;
}

function startLocalBattle(heroId) {
  const rest = shuffle(HEROES.filter((hero) => hero.id !== heroId).map((hero) => hero.id));
  localSession = createLocalBattleSession({
    heroIds: [heroId, ...rest.slice(0, 5)],
    rules: { endWhenHumanEliminated: true },
  });
  battleView = attachBattle(localSession, localSession.listeners, 1, (ranking) => {
    localSession?.destroy?.();
    localSession = null;
    battleView = null;
    showResult(ranking, 1, enterHeroSelect);
  });
  localSession.start();
}

function enterHeroSelect() {
  cleanupActiveFlow();
  showHeroSelect(startLocalBattle);
}

function enterOnline() {
  cleanupActiveFlow();
  const session = createOnlineSession();
  onlineView = mountPcOnline({ root: app, session, onExit: enterModeSelect });
}

function enterModeSelect() {
  cleanupActiveFlow();
  const screen = document.createElement('div');
  screen.className = 'screen';
  const content = document.createElement('div');
  content.className = 'pc-mode-select';

  const title = document.createElement('div');
  title.className = 'select-title';
  title.textContent = '群 英 决';
  const subtitle = document.createElement('div');
  subtitle.className = 'select-sub';
  subtitle.textContent = '英雄对决 · 天机博弈 · 气血为注 · 杀招定生死';
  const single = document.createElement('button');
  single.className = 'again-btn mode-sp';
  single.type = 'button';
  single.dataset.testid = 'pc-mode-single';
  single.textContent = '单 机 · 人 机 对 战';
  const online = document.createElement('button');
  online.className = 'again-btn mode-mp';
  online.type = 'button';
  online.dataset.testid = 'pc-mode-online';
  online.textContent = '联 机 · 组 队 对 战';
  const note = document.createElement('div');
  note.className = 'pc-mode-select__note';
  note.textContent = '联机模式需要对战服务器在线';

  single.addEventListener('click', () => { initAudio(); enterHeroSelect(); });
  online.addEventListener('click', () => { initAudio(); enterOnline(); });
  content.append(title, subtitle, single, online, note);
  screen.appendChild(content);
  app.replaceChildren(screen);
}

let previousFrame = performance.now();
function frame(now) {
  const dt = Math.min(.1, (now - previousFrame) / 1000);
  previousFrame = now;
  if (onlineView) onlineView.tick(dt);
  else if (localSession) {
    localSession.update(dt);
    battleView?.tick?.(dt);
  }
  requestAnimationFrame(frame);
}

bindAudioToggle(document.getElementById('audio-toggle'));
enterModeSelect();
requestAnimationFrame(frame);
