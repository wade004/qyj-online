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

  const rows = ranking.map((p, i) => {
    const isMe = p.idx === myIdx;
    const state = p.alive ? `存活 · 气血 ${p.hp}` : `第 ${p.deathRound ?? '?'} 回合阵亡`;
    return `<div class="result-row${isMe ? ' me' : ''}">
      <span class="rr-rank${i < 3 ? ' top' : ''}">${RANK_ICONS[i]}</span>
      <div class="rr-portrait" style="background-image:url('${p.hero.portrait}')"></div>
      <span class="rr-name">${p.hero.name}${p.playerName ? '·' + p.playerName : ''}${isMe ? '（你）' : ''}</span>
      <span class="rr-state" style="color:${p.alive ? 'var(--green)' : 'var(--red)'}">${state}</span>
    </div>`;
  }).join('');

  screen.innerHTML = `<div class="result-mask">
    <div class="result-box">
      <h1>决 斗 落 幕</h1>
      <div class="verdict">${verdict}</div>
      <div class="result-rows">${rows}</div>
      <button class="again-btn">${btnText}</button>
    </div>
  </div>`;
  screen.querySelector('.again-btn').addEventListener('click', onAgain);
  app.replaceChildren(screen);
}
