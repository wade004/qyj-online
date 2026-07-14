// H5-only application entry. This module owns orientation/fullscreen behavior
// and is never imported by the PC entry.

import { bindAudioToggle, initAudio } from '../audio.js';
import { mountH5App } from '../ui/h5/app.js';
import { mountOrientationGate } from '../ui/h5/orientation-gate.js';

const stage = document.getElementById('h5-stage');
const uiRoot = document.getElementById('h5-ui');
const appRoot = document.getElementById('app');
const gateRoot = document.getElementById('h5-orientation-gate');

const H5_REFERENCE_VIEWPORT = Object.freeze({ width: 844, height: 390 });
const H5_MAX_UI_SCALE = 2.4;

/**
 * Keep the compact 568x320 layout at native size, then scale the complete H5
 * visual tree continuously from the 844x390 design viewport.  Updating only
 * this wrapper preserves the current battle/application state during resize.
 */
export function syncH5ViewportScale() {
  if (!stage || !uiRoot) return 1;
  const style = getComputedStyle(stage);
  const horizontalPadding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const verticalPadding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const width = Math.max(1, stage.clientWidth - horizontalPadding);
  const height = Math.max(1, stage.clientHeight - verticalPadding);
  const scale = Math.max(1, Math.min(
    H5_MAX_UI_SCALE,
    width / H5_REFERENCE_VIEWPORT.width,
    height / H5_REFERENCE_VIEWPORT.height,
  ));
  uiRoot.style.setProperty('--h5-ui-scale', String(scale));
  uiRoot.style.width = `${width / scale}px`;
  uiRoot.style.height = `${height / scale}px`;
  uiRoot.dataset.uiScale = scale.toFixed(3);
  return scale;
}

syncH5ViewportScale();
window.addEventListener('resize', syncH5ViewportScale, { passive: true });
window.visualViewport?.addEventListener('resize', syncH5ViewportScale, { passive: true });

const application = mountH5App({ root: appRoot });
const orientation = mountOrientationGate({
  stage,
  gateRoot,
  onStarted() {
    initAudio();
    application.start();
  },
  isOnlineBattle: () => application.isOnlineBattle,
});

bindAudioToggle(document.getElementById('audio-toggle'));

let previousFrame = performance.now();
function frame(now) {
  const dt = Math.min(.1, (now - previousFrame) / 1000);
  previousFrame = now;
  application.tick(dt, orientation.allowed && !document.hidden);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('pagehide', () => {
  if (!application.isOnlineBattle) return;
  // The server remains authoritative. No client command is emitted here.
}, { passive: true });
