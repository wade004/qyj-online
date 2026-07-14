// ============================================================================
// audio.js - 群英决 音效系统（BGM + 游戏音效）
// ============================================================================

const AUDIO_BASE = 'assets/audio';
const MUTE_STORAGE_KEY = 'qyj.masterMuted';

// BGM 音轨池
export const BGM_TRACKS = Object.freeze([
  `${AUDIO_BASE}/bgm/music_default.mp3`,
  `${AUDIO_BASE}/bgm/music_jifeng.mp3`,
  `${AUDIO_BASE}/bgm/aozhan_online.mp3`,
]);

// 音效映射
export const SFX = Object.freeze({
  draw: `${AUDIO_BASE}/effect/draw.mp3`,
  drawx: `${AUDIO_BASE}/effect/drawx.mp3`,
  discard: `${AUDIO_BASE}/effect/discard.mp3`,
  damage: `${AUDIO_BASE}/effect/damage.mp3`,
  damageMale: `${AUDIO_BASE}/effect/damage_male.mp3`,
  damageFemale: `${AUDIO_BASE}/effect/damage_female.mp3`,
  die: `${AUDIO_BASE}/effect/die_male.mp3`,
  dieFemale: `${AUDIO_BASE}/effect/die_female.mp3`,
  recover: `${AUDIO_BASE}/effect/recover.mp3`,
  judge: `${AUDIO_BASE}/effect/judge.mp3`,
  link: `${AUDIO_BASE}/effect/link.mp3`,
  // `equip` is kept for existing battle call sites; skill presentations use
  // the explicit equip1/equip2 keys.
  equip: `${AUDIO_BASE}/effect/equip1.mp3`,
  equip1: `${AUDIO_BASE}/effect/equip1.mp3`,
  equip2: `${AUDIO_BASE}/effect/equip2.mp3`,
  win: `${AUDIO_BASE}/effect/win.mp3`,
  lose: `${AUDIO_BASE}/effect/lose.mp3`,
});

let bgmAudio = null;
let masterMuted = false;
try {
  masterMuted = localStorage.getItem(MUTE_STORAGE_KEY) === '1';
} catch {
  masterMuted = false;
}
let bgmEnabled = !masterMuted;
let sfxEnabled = !masterMuted;
let currentTrack = 0;
const activeSfx = new Set();

// 预加载音效（减少首次延迟）
const sfxCache = {};
function preloadSFX() {
  for (const [key, url] of Object.entries(SFX)) {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.src = url;
    sfxCache[key] = audio;
  }
}

// 播放 BGM
export function playBGM(trackIndex = -1) {
  if (!bgmEnabled) return;
  if (bgmAudio) {
    bgmAudio.pause();
    bgmAudio = null;
  }
  if (trackIndex < 0) {
    currentTrack = (currentTrack + 1) % BGM_TRACKS.length;
    trackIndex = currentTrack;
  } else {
    currentTrack = trackIndex;
  }
  bgmAudio = new Audio(BGM_TRACKS[trackIndex]);
  bgmAudio.loop = true;
  bgmAudio.volume = 0.3;
  bgmAudio.play().catch(() => {}); // 忽略自动播放限制
}

export function stopBGM() {
  if (bgmAudio) {
    bgmAudio.pause();
    bgmAudio = null;
  }
}

// 播放音效
export function playSFX(name) {
  if (!sfxEnabled) return;
  const cached = sfxCache[name];
  if (cached) {
    const clone = cached.cloneNode();
    clone.volume = 0.6;
    activeSfx.add(clone);
    clone.addEventListener('ended', () => activeSfx.delete(clone), { once: true });
    clone.play().catch(() => activeSfx.delete(clone));
  } else {
    const audio = new Audio(SFX[name]);
    audio.volume = 0.6;
    activeSfx.add(audio);
    audio.addEventListener('ended', () => activeSfx.delete(audio), { once: true });
    audio.play().catch(() => activeSfx.delete(audio));
  }
}

function stopActiveSFX() {
  for (const audio of activeSfx) {
    audio.pause();
    try { audio.currentTime = 0; } catch {}
  }
  activeSfx.clear();
}

export function setMuted(muted) {
  masterMuted = !!muted;
  bgmEnabled = !masterMuted;
  sfxEnabled = !masterMuted;
  try { localStorage.setItem(MUTE_STORAGE_KEY, masterMuted ? '1' : '0'); } catch {}
  if (masterMuted) {
    stopBGM();
    stopActiveSFX();
  } else if (initialized) {
    playBGM(currentTrack);
  }
  return masterMuted;
}

export function toggleMuted() { return setMuted(!masterMuted); }
export function isMuted() { return masterMuted; }

export function bindAudioToggle(button) {
  if (!button) return;
  const render = () => {
    const muted = isMuted();
    button.textContent = muted ? '🔇' : '🔊';
    button.title = muted ? '开启声音' : '关闭声音';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(muted));
    button.classList.toggle('muted', muted);
  };
  button.addEventListener('click', () => {
    toggleMuted();
    render();
  });
  render();
}

// 控制开关
export function toggleBGM() {
  bgmEnabled = !bgmEnabled;
  if (bgmEnabled) {
    playBGM(currentTrack);
  } else {
    stopBGM();
  }
  return bgmEnabled;
}

export function toggleSFX() {
  sfxEnabled = !sfxEnabled;
  return sfxEnabled;
}

export function isBGMEnabled() { return bgmEnabled; }
export function isSFXEnabled() { return sfxEnabled; }

// 初始化（在用户首次交互后调用，绕过自动播放限制）
let initialized = false;
export function initAudio() {
  if (initialized) return;
  initialized = true;
  preloadSFX();
  playBGM(0);
}
