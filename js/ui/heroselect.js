// ============================================================================
// heroselect.js - 英雄选择界面：六宫格英雄卡
// ============================================================================

import { HEROES } from '../game/heroes.js';

export function showHeroSelect(onPick) {
  const app = document.getElementById('app');
  const screen = document.createElement('div');
  screen.className = 'screen';
  screen.innerHTML = `
    <div class="select-title">群 英 决</div>
    <div class="select-sub">英雄对决 · 天机博弈 · 气血为注 · 杀招定生死</div>
    <div class="select-hint">—— 选择你的英雄 ——</div>
    <div class="hero-grid"></div>`;
  const grid = screen.querySelector('.hero-grid');
  for (const hero of HEROES) {
    const card = document.createElement('div');
    card.className = 'hero-card';
    card.innerHTML = `
      <div class="hc-portrait" style="background-image:url('${hero.portrait}')">
        <div class="hc-namebar">
          <span class="hc-name">${hero.name}</span>
          <span style="color:${hero.color};font-weight:bold;font-size:12px">${hero.type}</span>
        </div>
      </div>
      <div class="hc-body">
        <div>主动【${hero.skillName}】${hero.skillCost}⚡ ${hero.skillDesc}</div>
        <div class="hc-dim">条件：${hero.condDesc}</div>
        <div class="hc-dim">被动：${hero.passiveDesc}</div>
        <div class="hc-quote">「${hero.lines.enter}」</div>
      </div>`;
    card.addEventListener('click', () => onPick(hero.id));
    grid.appendChild(card);
  }
  app.replaceChildren(screen);
}
