// ============================================================================
// effects.js - 演出反馈：飘字/横幅/气泡/印章/血珠飞行/震屏/刀光
// ============================================================================

const fx = () => document.getElementById('fx');

export function centerOf(el) {
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}

function spawn(html, ttl) {
  const div = document.createElement('div');
  div.innerHTML = html;
  const node = div.firstElementChild;
  fx().appendChild(node);
  setTimeout(() => node.remove(), ttl);
  return node;
}

export function floatText(x, y, text, color, size = 20) {
  spawn(
    `<div class="fx-float" style="left:${x}px;top:${y - 12}px;color:${color};font-size:${size}px">${text}</div>`,
    1600,
  );
}

export function banner(mainText, subText = '', color = '') {
  spawn(
    `<div class="fx-banner"><div class="b-main" style="${color ? `color:${color}` : ''}">${mainText}</div>` +
    (subText ? `<div class="b-sub">${subText}</div>` : '') + `</div>`,
    2100,
  );
}

export function bubble(anchorEl, text) {
  const r = anchorEl.getBoundingClientRect();
  spawn(
    `<div class="fx-bubble" style="left:${r.left + r.width / 2}px;top:${r.top - 48}px">「${text}」</div>`,
    2700,
  );
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
  spawn(
    `<div class="fx-slash" style="left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px"></div>`,
    600,
  );
}

export function potFly(fromX, fromY, toX, toY, onArrive) {
  const orb = spawn(`<div class="fx-orb" style="left:${fromX}px;top:${fromY}px"></div>`, 1000);
  requestAnimationFrame(() => {
    orb.style.left = `${toX}px`;
    orb.style.top = `${toY}px`;
  });
  if (onArrive) setTimeout(onArrive, 880);
}
