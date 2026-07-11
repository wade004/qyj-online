// ============================================================================
// result.js - 结算界面：名次表 + 再来一局
// ============================================================================

const RANK_ICONS = ['🥇', '🥈', '🥉', '第4名', '第5名', '第6名'];

export function showResult(ranking, myIdx, onAgain, btnText = '再 来 一 局') {
  const app = document.getElementById('app');
  const screen = document.createElement('div');
  screen.className = 'screen';

  let humanRank = 0;
  ranking.forEach((p, i) => { if (p.idx === myIdx) humanRank = i + 1; });
  const verdict = humanRank === 1 ? '傲视群雄！'
    : humanRank <= 3 ? '虽败犹荣。' : '胜败乃兵家常事，再战！';

  screen.innerHTML = `<div class="result-mask">
    <div class="result-box">
      <h1>决 斗 落 幕</h1>
      <div class="verdict"></div>
      <div class="result-rows"></div>
      <button class="again-btn"></button>
    </div>
  </div>`;
  screen.querySelector('.verdict').textContent = verdict;
  const rows = screen.querySelector('.result-rows');
  ranking.forEach((p, i) => {
    const isMe = p.idx === myIdx;
    const state = p.alive ? `存活 · 气血 ${p.hp}` : `第 ${p.deathRound ?? '?'} 回合阵亡`;
    const row = document.createElement('div');
    row.className = `result-row${isMe ? ' me' : ''}`;
    const rank = document.createElement('span');
    rank.className = `rr-rank${i < 3 ? ' top' : ''}`;
    rank.textContent = RANK_ICONS[i] || `第${i + 1}名`;
    const portrait = document.createElement('div');
    portrait.className = 'rr-portrait';
    portrait.style.backgroundImage = `url('${p.hero.portrait}')`;
    const name = document.createElement('span');
    name.className = 'rr-name';
    name.textContent = `${p.hero.name}${p.playerName ? `·${p.playerName}` : ''}${isMe ? '（你）' : ''}`;
    const stateEl = document.createElement('span');
    stateEl.className = 'rr-state';
    stateEl.style.color = p.alive ? 'var(--green)' : 'var(--red)';
    stateEl.textContent = state;
    row.append(rank, portrait, name, stateEl);
    rows.appendChild(row);
  });

  const again = screen.querySelector('.again-btn');
  again.textContent = String(btnText ?? '');
  again.addEventListener('click', onAgain);
  app.replaceChildren(screen);
}
