// ============================================================================
// heroes.js - 首发六英雄（与 Maker 版 Heroes.lua 一一对应）
// ============================================================================

const P = (n) => `assets/heroes/${n}`;
const C = (n) => `assets/characters/${n}`;

export const HEROES = [
  {
    id: 'zhugeliang', name: '诸葛亮', type: '侦查',
    gender: 'male',
    color: '#7fd4ff',
    portrait: C('zhuge_liang.png'),
    skillName: '观天', skillCost: 2,
    skillDesc: '窥探下一道天机',
    condDesc: '令含黑桃♠',
    passiveDesc: '两令同花色时 +1⚡',
    lines: {
      enter: '亮，静候诸君。', skill: '夜观天象，天机尽显。',
      allin: '鞠躬尽瘁，死而后已！', die: '悠悠苍天，曷此其极…', win: '万事俱备，只欠东风。',
    },
  },
  {
    id: 'diaochan', name: '貂蝉', type: '侦查',
    gender: 'female',
    color: '#c58bff',
    portrait: C('diao_chan.png'),
    skillName: '魅惑', skillCost: 3,
    skillDesc: '窥视一名对手一枚杀招令',
    condDesc: '令含A/K/Q',
    passiveDesc: '亮招获胜 +1⚡',
    lines: {
      enter: '乱世之中，红颜亦是刀锋。', skill: '你的心思，瞒不过我。',
      allin: '倾国倾城，孤注一掷！', die: '月，落了…', win: '这一舞，可还入眼？',
    },
  },
  {
    id: 'hanxin', name: '韩信', type: '换牌',
    gender: 'male',
    color: '#ff9d76',
    portrait: C('han_xin.png'),
    skillName: '暗度陈仓', skillCost: 2,
    skillDesc: '弃换一枚杀招令',
    condDesc: '两令花色不同',
    passiveDesc: '两令不成对且不同花色 +1⚡',
    lines: {
      enter: '明修栈道，诸位可要看仔细了。', skill: '明修栈道，暗度陈仓！',
      allin: '置之死地而后生！', die: '成也萧何，败也萧何…', win: '多多益善。',
    },
  },
  {
    id: 'xiangyu', name: '项羽', type: '控制',
    gender: 'male',
    color: '#ff6b6b',
    portrait: C('xiang_yu.png'),
    skillName: '威压', skillCost: 2,
    skillDesc: '本轮对手不得加注（决死除外）',
    condDesc: '令含J/Q/K',
    passiveDesc: '不亮招夺池 +1⚡',
    lines: {
      enter: '今日，吾主此桌！', skill: '吾在此，谁敢造次！',
      allin: '力拔山兮气盖世！', die: '天亡我，非战之罪！', win: '彼可取而代也！',
    },
  },
  {
    id: 'lvbuwei', name: '吕不韦', type: '经济',
    gender: 'male',
    color: '#f6c343',
    portrait: C('lv_buwei.png'),
    skillName: '奇货可居', skillCost: 3,
    skillDesc: '本回合获胜额外+30%血池',
    condDesc: '两令阶数和≥20（A=14）',
    passiveDesc: '所有夺池额外+10%',
    lines: {
      enter: '天下，皆是生意。', skill: '此局，奇货可居！',
      allin: '倾尽家财，博一场泼天富贵！', die: '这笔买卖…亏了…', win: '钱货两讫，概不赊欠。',
    },
  },
  {
    id: 'lianpo', name: '廉颇', type: '防御',
    gender: 'male',
    color: '#54d97c',
    portrait: C('lian_po.png'),
    skillName: '坚壁', skillCost: 2,
    skillDesc: '本回合亮招若败返还50%气血',
    condDesc: '令含红桃♥',
    passiveDesc: '亮招落败 +1⚡',
    lines: {
      enter: '老夫的盾，还提得动！', skill: '坚壁清野，固守不出。',
      allin: '廉颇老矣，尚能一战！', die: '甲…碎了…', win: '尚能饭否？尚能战也！',
    },
  },
];

export function getHero(id) {
  return HEROES.find((h) => h.id === id) || null;
}

/** 主动技条件是否满足（以两枚暗令判定） */
export function checkCondition(heroId, hole) {
  if (!hole || hole.length < 2) return false;
  const [a, b] = hole;
  switch (heroId) {
    case 'zhugeliang': return a.suit === 1 || b.suit === 1;          // 含♠
    case 'diaochan': return a.rank >= 12 || b.rank >= 12;            // 含A/K/Q
    case 'hanxin': return a.suit !== b.suit;                          // 花色不同
    case 'xiangyu':
      return (a.rank >= 11 && a.rank <= 13) || (b.rank >= 11 && b.rank <= 13); // 含J/Q/K
    case 'lvbuwei': return a.rank + b.rank >= 20;
    case 'lianpo': return a.suit === 2 || b.suit === 2;              // 含♥
    default: return false;
  }
}

/** 发令时被动能量（诸葛亮/韩信） */
export function dealPassiveEnergy(heroId, hole) {
  if (!hole || hole.length < 2) return 0;
  const [a, b] = hole;
  if (heroId === 'zhugeliang' && a.suit === b.suit) return 1;
  if (heroId === 'hanxin' && a.rank !== b.rank && a.suit !== b.suit) return 1;
  return 0;
}
