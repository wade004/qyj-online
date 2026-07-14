// ============================================================================
// heroes.js - 人物清单
// 人物只声明身份、技能引用和表现资源；技能规则统一由 skills.js 解释。
// ============================================================================

import { getActiveSkill, getPassiveSkill } from './skills.js';

const C = (name) => `assets/characters/${name}`;

const DEFINITIONS = [
  {
    id: 'zhugeliang', name: '诸葛亮', type: '天机', gender: 'male', color: '#7fd4ff',
    portrait: C('zhuge_liang.png'),
    skillIds: { active: 'zhugeliang_guantian', passive: 'zhugeliang_tongse' },
    presentation: { faction: '蜀', vfxTheme: 'celestial', voicePack: 'zhugeliang_default' },
    lines: {
      enter: '亮，静候诸君。', skill: '夜观天象，天机尽显。',
      allin: '鞠躬尽瘁，死而后已！', die: '悠悠苍天，曷此其极…', win: '万事俱备，只欠东风。',
    },
  },
  {
    id: 'diaochan', name: '貂蝉', type: '洞察', gender: 'female', color: '#c58bff',
    portrait: C('diao_chan.png'),
    skillIds: { active: 'diaochan_meihuo', passive: 'diaochan_biyue' },
    presentation: { faction: '群', vfxTheme: 'silk', voicePack: 'diaochan_default' },
    lines: {
      enter: '乱世之中，红颜亦是刀锋。', skill: '你的心思，瞒不过我。',
      allin: '倾国倾城，孤注一掷！', die: '月，落了…', win: '这一舞，可还入眼？',
    },
  },
  {
    id: 'hanxin', name: '韩信', type: '谋攻', gender: 'male', color: '#ff9d76',
    portrait: C('han_xin.png'),
    skillIds: { active: 'hanxin_beishui', passive: 'hanxin_duoyi' },
    presentation: { faction: '汉', vfxTheme: 'battle_standard', voicePack: 'hanxin_default' },
    lines: {
      enter: '明修栈道，诸位可要看仔细了。', skill: '背水列阵，置之死地而后生！',
      allin: '置之死地而后生！', die: '成也萧何，败也萧何…', win: '多多益善。',
    },
  },
  {
    id: 'xiangyu', name: '项羽', type: '威慑', gender: 'male', color: '#ff6b6b',
    portrait: C('xiang_yu.png'),
    skillIds: { active: 'xiangyu_weizhen', passive: 'xiangyu_bawang' },
    presentation: { faction: '楚', vfxTheme: 'overlord', voicePack: 'xiangyu_default' },
    lines: {
      enter: '今日，吾主此桌！', skill: '吾在此，谁敢造次！',
      allin: '力拔山兮气盖世！', die: '天亡我，非战之罪！', win: '彼可取而代也！',
    },
  },
  {
    id: 'lvbuwei', name: '吕不韦', type: '经营', gender: 'male', color: '#f6c343',
    portrait: C('lv_buwei.png'),
    skillIds: { active: 'lvbuwei_qihuo', passive: 'lvbuwei_shangdao' },
    presentation: { faction: '秦', vfxTheme: 'merchant_seal', voicePack: 'lvbuwei_default' },
    lines: {
      enter: '天下，皆是生意。', skill: '此局，奇货可居！',
      allin: '倾尽家财，博一场泼天富贵！', die: '这笔买卖…亏了…', win: '钱货两讫，概不赊欠。',
    },
  },
  {
    id: 'lianpo', name: '廉颇', type: '防守', gender: 'male', color: '#54d97c',
    portrait: C('lian_po.png'),
    skillIds: { active: 'lianpo_jianbi', passive: 'lianpo_laolian' },
    presentation: { faction: '赵', vfxTheme: 'shield_wall', voicePack: 'lianpo_default' },
    lines: {
      enter: '老夫的盾，还提得动！', skill: '坚壁清野，固守不出。',
      allin: '廉颇老矣，尚能一战！', die: '甲…碎了…', win: '尚能饭否？尚能战也！',
    },
  },
  {
    id: 'wuzetian', name: '武则天', type: '制衡', gender: 'female', color: '#d8b24a',
    portrait: C('wuzetian.png'),
    skillIds: { active: 'wuzetian_linchao', passive: 'wuzetian_tianshou' },
    presentation: { faction: '周', vfxTheme: 'imperial_edict', voicePack: 'wuzetian_default' },
    lines: {
      enter: '日月当空，诸君入朝。', skill: '朕意已决，尔当奉诏。',
      allin: '天下之局，尽在朕手！', die: '无字碑前…任后人评说。', win: '乾坤既定，万邦来朝。',
    },
  },
  {
    id: 'huamulan', name: '花木兰', type: '变阵', gender: 'female', color: '#df6a5b',
    portrait: C('hua_mulan.png'),
    skillIds: { active: 'huamulan_yizhuang', passive: 'huamulan_guijia' },
    presentation: { faction: '北魏', vfxTheme: 'cloak_reveal', voicePack: 'huamulan_default' },
    lines: {
      enter: '卸下红妆，且看我执戈。', skill: '真假虚实，只在一念。',
      allin: '万里赴戎机！', die: '愿故乡…烽烟已息。', win: '策勋十二转，不问女儿身。',
    },
  },
  {
    id: 'xishi', name: '西施', type: '观心', gender: 'female', color: '#68c9c3',
    portrait: C('xi_shi.png'),
    skillIds: { active: 'xishi_huansha', passive: 'xishi_chenyu' },
    presentation: { faction: '越', vfxTheme: 'water_ripple', voicePack: 'xishi_default' },
    lines: {
      enter: '苎萝溪水，照见人心。', skill: '纱动水纹，心事自明。',
      allin: '此身入局，便无归途。', die: '一叶扁舟…终未归。', win: '沉鱼非貌，是局中无声。',
    },
  },
  {
    id: 'wangzhaojun', name: '王昭君', type: '止戈', gender: 'female', color: '#9fcbe8',
    portrait: C('wang_zhaojun.png'),
    skillIds: { active: 'wangzhaojun_chusai', passive: 'wangzhaojun_heming' },
    presentation: { faction: '汉', vfxTheme: 'wild_goose', voicePack: 'wangzhaojun_default' },
    lines: {
      enter: '琵琶一曲，愿边塞无烽。', skill: '雁过长空，且听弦中之意。',
      allin: '此去千里，为两境安宁。', die: '胡天落雪…故乡可安？', win: '弦声既止，干戈亦休。',
    },
  },
  {
    id: 'shangguanwaner', name: '上官婉儿', type: '文心', gender: 'female', color: '#e6b75c',
    portrait: C('shangguan_waner.png'),
    skillIds: { active: 'shangguanwaner_guanci', passive: 'shangguanwaner_luobi' },
    presentation: { faction: '周', vfxTheme: 'golden_script', voicePack: 'shangguanwaner_default' },
    lines: {
      enter: '称量天下士，落笔定风流。', skill: '辞色之间，虚实已见。',
      allin: '一纸诏书，敢定此局！', die: '墨痕未干…人事已非。', win: '彩笔题成，满座皆惊。',
    },
  },
  {
    id: 'liqingzhao', name: '李清照', type: '词韵', gender: 'female', color: '#a8c68f',
    portrait: C('li_qingzhao.png'),
    skillIds: { active: 'liqingzhao_xunci', passive: 'liqingzhao_shuyu' },
    presentation: { faction: '宋', vfxTheme: 'poem_scroll', voicePack: 'liqingzhao_default' },
    lines: {
      enter: '赌书泼茶，今日也赌一局。', skill: '寻寻觅觅，此中自有佳句。',
      allin: '生当作人杰！', die: '梧桐细雨…到黄昏。', win: '此情此景，恰成新词。',
    },
  },
  {
    id: 'fuhao', name: '妇好', type: '卜战', gender: 'female', color: '#c58a55',
    portrait: C('fu_hao.png'),
    skillIds: { active: 'fuhao_zhenbu', passive: 'fuhao_zhengfa' },
    presentation: { faction: '商', vfxTheme: 'oracle_bone', voicePack: 'fuhao_default' },
    lines: {
      enter: '问卜于天，执钺于阵。', skill: '兆已显，依卦而行。',
      allin: '三军听令，随我征伐！', die: '甲骨有痕…英魂不灭。', win: '吉兆应验，班师告庙。',
    },
  },
  {
    id: 'muguiying', name: '穆桂英', type: '帅阵', gender: 'female', color: '#e65e55',
    portrait: C('mu_guiying.png'),
    skillIds: { active: 'muguiying_guashuai', passive: 'muguiying_pozhen' },
    presentation: { faction: '宋', vfxTheme: 'marshal_banner', voicePack: 'muguiying_default' },
    lines: {
      enter: '帅旗所向，诸军并进。', skill: '挂帅出征，此阵由我。',
      allin: '杨门女将，破阵在今朝！', die: '帅旗不倒…军心不散。', win: '阵门已破，鸣金收兵。',
    },
  },
  {
    id: 'nvwa', name: '女娲', type: '造化', gender: 'female', color: '#76d0ad',
    portrait: C('nv_wa.png'),
    skillIds: { active: 'nvwa_zaohua', passive: 'nvwa_butian' },
    presentation: { faction: '神', vfxTheme: 'five_color_stone', voicePack: 'nvwa_default' },
    lines: {
      enter: '抟土为生，炼石补天。', skill: '借众生之灵，衍万般造化。',
      allin: '天倾地裂，吾自补之！', die: '山河万古…生生不息。', win: '五色归位，天地重明。',
    },
  },
  {
    id: 'change', name: '嫦娥', type: '月鉴', gender: 'female', color: '#b7d6ec',
    portrait: C('chang_e.png'),
    skillIds: { active: 'change_wangyue', passive: 'change_qinghui' },
    presentation: { faction: '神', vfxTheme: 'moon_disc', voicePack: 'change_default' },
    lines: {
      enter: '广寒清寂，照见此局。', skill: '月华如水，天机留影。',
      allin: '碧海青天，今夜无悔。', die: '月宫虽远…故心仍在。', win: '清辉遍洒，胜负皆明。',
    },
  },
];

function hydrateHero(definition) {
  const active = getActiveSkill(definition);
  const passive = getPassiveSkill(definition);
  return Object.freeze({
    ...definition,
    skills: Object.freeze({ active, passive }),
    // 兼容现有武将牌组件；所有值仍来源于统一技能清单。
    skillName: active.name,
    skillCost: active.cost,
    skillDesc: active.description,
    condDesc: active.conditionDescription,
    passiveDesc: `【${passive.name}】${passive.description}`,
  });
}

export const HEROES = Object.freeze(DEFINITIONS.map(hydrateHero));

export function getHero(id) {
  return HEROES.find((hero) => hero.id === id) || null;
}
