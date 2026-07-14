// 全局声音开关在无浏览器环境下也应保持纯状态逻辑可测试。
import { isMuted, setMuted, toggleMuted } from '../js/audio.js';

const assert = (condition, message) => {
  if (!condition) throw new Error('音频开关断言失败: ' + message);
};

setMuted(true);
assert(isMuted(), 'setMuted(true) 后应静音');
assert(toggleMuted() === false && !isMuted(), 'toggleMuted 应恢复声音');
setMuted(false);

console.log('音频开关自检通过：主静音状态切换正常');
