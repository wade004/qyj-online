// ============================================================================
// effects.js - 演出反馈：飘字/横幅/气泡/印章/血珠飞行/震屏/刀光
// ============================================================================

const fx = () => document.getElementById('fx');

export function centerOf(el) {
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}

function spawn(node, ttl) {
  fx().appendChild(node);
  setTimeout(() => node.remove(), ttl);
  return node;
}

export function floatText(x, y, text, color, size = 20) {
  const node = document.createElement('div');
  node.className = 'fx-float';
  node.style.left = `${x}px`;
  node.style.top = `${y - 12}px`;
  node.style.color = color;
  node.style.fontSize = `${size}px`;
  node.textContent = String(text ?? '');
  spawn(node, 1600);
}

export function banner(mainText, subText = '', color = '') {
  const node = document.createElement('div');
  node.className = 'fx-banner';
  const main = document.createElement('div');
  main.className = 'b-main';
  if (color) main.style.color = color;
  main.textContent = String(mainText ?? '');
  node.appendChild(main);
  if (subText) {
    const sub = document.createElement('div');
    sub.className = 'b-sub';
    sub.textContent = String(subText);
    node.appendChild(sub);
  }
  spawn(node, 2100);
}

export function bubble(anchorEl, text) {
  const r = anchorEl.getBoundingClientRect();
  const node = document.createElement('div');
  node.className = 'fx-bubble';
  node.style.left = `${r.left + r.width / 2}px`;
  node.style.top = `${r.top - 48}px`;
  node.textContent = `「${String(text ?? '')}」`;
  spawn(node, 2700);
}

export function deathStamp(seatEl) {
  const div = document.createElement('div');
  div.className = 'death-stamp';
  div.innerHTML = '<span>阵 亡</span>';
  seatEl.appendChild(div);
}

export function shake() {
  const el = document.querySelector('.screen');
  if (!el) return;
  el.classList.remove('shake');
  void el.offsetWidth; // 重置动画
  el.classList.add('shake');
}

export function slashFlash(el) {
  const r = el.getBoundingClientRect();
  const node = document.createElement('div');
  node.className = 'fx-slash';
  node.style.left = `${r.left}px`;
  node.style.top = `${r.top}px`;
  node.style.width = `${r.width}px`;
  node.style.height = `${r.height}px`;
  spawn(node, 600);
}

export function potFly(fromX, fromY, toX, toY, onArrive) {
  const node = document.createElement('div');
  node.className = 'fx-orb';
  node.style.left = `${fromX}px`;
  node.style.top = `${fromY}px`;
  const orb = spawn(node, 1000);
  requestAnimationFrame(() => {
    orb.style.left = `${toX}px`;
    orb.style.top = `${toY}px`;
  });
  if (onArrive) setTimeout(onArrive, 880);
}
