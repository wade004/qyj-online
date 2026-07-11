import { button, element, listen } from '../shared/dom.js';

function isLandscape() {
  return window.matchMedia?.('(orientation: landscape)').matches
    ?? window.innerWidth > window.innerHeight;
}

function isLargeEnough() {
  return window.innerWidth >= 568 && window.innerHeight >= 320;
}

export function mountOrientationGate({ stage, gateRoot, onStarted, isOnlineBattle = () => false }) {
  let started = false;
  let destroyed = false;

  const mark = element('div', { className: 'h5-orientation__phone', attrs: { 'aria-hidden': 'true' } }, [
    element('span', { text: '群' }),
  ]);
  const title = element('h1', { text: '请横屏进入游戏' });
  const message = element('p', { text: '《群英决》手机 H5 仅支持横屏，竖屏下禁止操作。' });
  const status = element('p', { className: 'h5-orientation__status', attrs: { 'aria-live': 'polite' } });
  const enter = button('横屏进入游戏', {
    className: 'h5-primary-button h5-orientation__enter',
    attrs: { 'data-testid': 'h5-enter-landscape' },
  });
  const panel = element('section', {
    className: 'h5-orientation__panel',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'h5-orientation-title' },
  }, [mark, title, message, status, enter]);
  title.id = 'h5-orientation-title';
  gateRoot.replaceChildren(panel);

  async function requestLandscape() {
    started = true;
    enter.disabled = true;
    status.textContent = '正在尝试进入全屏并锁定横屏…';
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      }
    } catch {
      // Fullscreen is an enhancement; manual rotation remains supported.
    }
    try {
      if (screen.orientation?.lock) await screen.orientation.lock('landscape');
    } catch {
      // iOS Safari and embedded webviews commonly require manual rotation.
    }
    onStarted?.();
    update();
  }

  function update() {
    if (destroyed) return;
    const landscape = isLandscape();
    const sizeOk = isLargeEnough();
    const allowed = started && landscape && sizeOk;
    gateRoot.hidden = allowed;
    gateRoot.setAttribute('aria-hidden', allowed ? 'true' : 'false');
    stage.inert = !allowed;
    stage.setAttribute('aria-hidden', allowed ? 'false' : 'true');
    document.body.classList.toggle('h5-is-blocked', !allowed);

    if (!started) {
      title.textContent = '横屏进入《群英决》';
      message.textContent = '点击后尝试进入全屏并锁定横屏；不支持方向锁时，请手动旋转手机。';
      status.textContent = landscape ? '当前已横置，可以进入。' : '当前为竖屏，进入后请旋转手机。';
      enter.textContent = '横屏进入游戏';
    } else if (!landscape) {
      title.textContent = '请将手机横置';
      message.textContent = '竖屏已被禁止。横置后会自动恢复原页面，不会重新连接或重建对局。';
      status.textContent = isOnlineBattle() ? '联机行动计时仍在继续。' : '当前页面已暂停操作。';
      enter.textContent = '再次尝试横屏';
    } else if (!sizeOk) {
      title.textContent = '当前屏幕尺寸过小';
      message.textContent = '横屏视口至少需要 568×320，请关闭分屏或使用更大的设备。';
      status.textContent = `${window.innerWidth}×${window.innerHeight}`;
      enter.textContent = '重新检测';
    }
    enter.disabled = false;
    if (!allowed) queueMicrotask(() => enter.focus({ preventScroll: true }));
  }

  enter.addEventListener('click', requestLandscape);
  const cleanups = [
    listen(window, 'resize', update),
    listen(window, 'orientationchange', update),
    listen(document, 'fullscreenchange', update),
  ];
  update();

  return {
    update,
    get allowed() { return started && isLandscape() && isLargeEnough(); },
    destroy() {
      destroyed = true;
      cleanups.forEach((cleanup) => cleanup());
      gateRoot.replaceChildren();
      stage.inert = false;
      stage.removeAttribute('aria-hidden');
      document.body.classList.remove('h5-is-blocked');
    },
  };
}
