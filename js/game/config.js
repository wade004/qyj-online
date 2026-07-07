// ============================================================================
// config.js - 群英决 全局配置与数值表（与 Maker 版 Config.lua 一一对应）
// 数值来源：《群英决》策划案 V1.3 · 第十章 数值总表
// ============================================================================

export const PLAYER_COUNT = 6;
export const MAX_ROUNDS = 12;
export const INIT_HP = 1500;
export const INIT_ENERGY = 2;
export const ROUND_STEP = 5;
export const SHAKE_POT = 600;

// 血祭（盲注）每3回合翻倍
export const BLIND_SCHEDULE = [
  { sb: 10, bb: 20 },
  { sb: 20, bb: 40 },
  { sb: 40, bb: 80 },
  { sb: 80, bb: 160 },
];

// 攻击档位（加注增量 = 血池 × 系数）
export const ATTACK_TIERS = [
  { key: 'feint', name: '佯攻', ratio: 1 / 3 },
  { key: 'strike', name: '强攻', ratio: 1 / 2 },
  { key: 'fierce', name: '猛攻', ratio: 2 / 3 },
];

export const ACTION_TIME = 30;
export const EXTEND_TIME = 30;
export const EXTEND_COST = 1;

// 花色：扑克 ♠♥♦♣（四象为世界观别名：玄武=♠ 朱雀=♥ 白虎=♦ 青龙=♣）
export const SUITS = [
  null, // 1-based 对齐 Lua
  { id: 1, name: '玄武', char: '♠', red: false },
  { id: 2, name: '朱雀', char: '♥', red: true },
  { id: 3, name: '白虎', char: '♦', red: true },
  { id: 4, name: '青龙', char: '♣', red: false },
];

export const RANK_NAMES = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

// 杀招（牌型）十品：category 1~10（越大越强）
export const HAND_NAMES = {
  1: { name: '孤锋独行', poker: '高牌' },
  2: { name: '双雄并立', poker: '一对' },
  3: { name: '双龙戏珠', poker: '两对' },
  4: { name: '三英聚首', poker: '三条' },
  5: { name: '五连星阵', poker: '顺子' },
  6: { name: '四象归一', poker: '同花' },
  7: { name: '龙争虎斗', poker: '葫芦' },
  8: { name: '四神临世', poker: '四条' },
  9: { name: '万象天诀', poker: '同花顺' },
  10: { name: '九五至尊', poker: '皇家同花顺' },
};

export const BOARD_SLOT_NAMES = [null, '天时', '天时', '天时', '地利', '人和'];

// AI 性格参数（策划案 第八章）
export const AI_STYLES = [
  { key: 'aggressive', name: '激进', raiseThreshold: 0.52, callAdj: -0.05, bluffRate: 0.22 },
  { key: 'tight', name: '紧手', raiseThreshold: 0.68, callAdj: 0.04, bluffRate: 0.05 },
  { key: 'bluffer', name: '诈唬', raiseThreshold: 0.60, callAdj: 0.00, bluffRate: 0.32 },
  { key: 'tag', name: '紧凶', raiseThreshold: 0.62, callAdj: 0.06, bluffRate: 0.10 },
  { key: 'loose', name: '松浪', raiseThreshold: 0.46, callAdj: -0.08, bluffRate: 0.18 },
];

export const AI_SIMS = 80;
export const PLAYER_SIMS = 150;
export const AI_SKILL_RATE = 0.4;

export const LBW_PASSIVE_BONUS = 0.10;
export const LBW_ACTIVE_BONUS = 0.30;
export const LP_REFUND_RATIO = 0.50;

/** 数额取整到5 */
export function roundAmount(n) {
  let v = Math.floor(n / ROUND_STEP + 0.5) * ROUND_STEP;
  if (v < ROUND_STEP) v = ROUND_STEP;
  return v;
}

/** 获取某回合的血祭档位 */
export function getBlinds(round) {
  let level = Math.min(Math.ceil(round / 3), BLIND_SCHEDULE.length);
  if (level < 1) level = 1;
  return BLIND_SCHEDULE[level - 1];
}

// 牌面/花色/牌背资源（noname 素材迁移版）
export const CARD_FACE_IMG = 'assets/card/handcard.png';
export const CARD_BACK_IMG = 'assets/card/cardback_scroll.png';
export const SUIT_IMGS = {
  1: 'assets/card/lukai_spade.png',
  2: 'assets/card/lukai_heart.png',
  3: 'assets/card/lukai_diamond.png',
  4: 'assets/card/lukai_club.png',
};
export const RANK_FACE_IMGS = {
  2: 'assets/rankb_02_20260705150419.png',
  3: 'assets/rankb_03_20260705150419.png',
  4: 'assets/rankb_04_20260705150419.png',
  5: 'assets/rankb_05_20260705150419.png',
  6: 'assets/rankb_06_20260705150419.png',
  7: 'assets/rankb_07_20260705150845.png',
  8: 'assets/rankb_08_20260705150845.png',
  9: 'assets/rankb_09_20260705150845.png',
  10: 'assets/rankb_10_20260705150845.png',
  11: 'assets/rankc_J_20260705154216.png',
  12: 'assets/rankc_Q_20260705154216.png',
  13: 'assets/rankc_K_20260705154216.png',
  14: 'assets/rankc_A_20260705154216.png',
};
export const BG_IMG = 'assets/bg/zhulin_bg.jpg';
