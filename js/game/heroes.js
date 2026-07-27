// ============================================================================
// heroes.js - 人物清单
// 人物只声明身份、技能引用和表现资源；技能规则统一由 skills.js 解释。
// ============================================================================

import {
  getActiveSkill,
  getActiveSkills,
  getHeroSkills,
  getPassiveSkill,
  getPassiveSkills,
} from './skills.js';

const C = (name) => `assets/characters/${name}`;

const DEFINITIONS = [
  {
    id: 'zhugeliang', name: '诸葛亮', type: '天机', gender: 'male', color: '#7fd4ff',
    portrait: C('zhuge_liang.png'),
    skillIds: ['zhugeliang_guanxing', 'zhugeliang_kongcheng'],
    presentation: { faction: '蜀', vfxTheme: 'celestial', voicePack: 'zhugeliang_default' },
    lines: {
      enter: '亮，静候诸君。', skill: '夜观天象，天机尽显。',
      allin: '鞠躬尽瘁，死而后已！', die: '悠悠苍天，曷此其极…', win: '万事俱备，只欠东风。',
      skills: {
        zhugeliang_guanxing: { cast: '星移斗转，只取天机一隅。', effect: '象在范围，局势可推。' },
        zhugeliang_kongcheng: { cast: '城门既开，谁敢先入？', effect: '虚实已定，依计而行。' },
      },
    },
  },
  {
    id: 'diaochan', name: '貂蝉', type: '洞察', gender: 'female', color: '#c58bff',
    portrait: C('diao_chan.png'),
    skillIds: ['diaochan_lianhuan', 'diaochan_biyue'],
    presentation: { faction: '群', vfxTheme: 'silk', voicePack: 'diaochan_default' },
    lines: {
      enter: '乱世之中，红颜亦是刀锋。', skill: '你的心思，瞒不过我。',
      allin: '倾国倾城，孤注一掷！', die: '月，落了…', win: '这一舞，可还入眼？',
      skills: {
        diaochan_lianhuan: { cast: '一环扣一环，你逃不掉的。', effect: '将军，按我的步子来。' },
        diaochan_biyue: { cast: '月色撩人，何必如此心急？', effect: '这一刻，归我了。' },
      },
    },
  },
  {
    id: 'hanxin', name: '韩信', type: '谋攻', gender: 'male', color: '#ff9d76',
    portrait: C('han_xin.png'),
    skillIds: ['hanxin_andu', 'hanxin_beishui'],
    presentation: { faction: '汉', vfxTheme: 'battle_standard', voicePack: 'hanxin_default' },
    lines: {
      enter: '明修栈道，诸位可要看仔细了。', skill: '背水列阵，置之死地而后生！',
      allin: '置之死地而后生！', die: '成也萧何，败也萧何…', win: '多多益善。',
      skills: {
        hanxin_andu: { cast: '明修栈道，暗度陈仓！', effect: '伏兵尽出，破！' },
        hanxin_beishui: { cast: '背水一战，不胜便死！', effect: '绝地反攻，军心如铁！' },
      },
    },
  },
  {
    id: 'xiangyu', name: '项羽', type: '威慑', gender: 'male', color: '#ff6b6b',
    portrait: C('xiang_yu.png'),
    skillIds: ['xiangyu_pofu', 'xiangyu_bawang'],
    presentation: { faction: '楚', vfxTheme: 'overlord', voicePack: 'xiangyu_default' },
    lines: {
      enter: '今日，吾主此桌！', skill: '吾在此，谁敢造次！',
      allin: '力拔山兮气盖世！', die: '天亡我，非战之罪！', win: '彼可取而代也！',
      skills: {
        xiangyu_pofu: { cast: '破釜沉舟，今日只分生死！', effect: '胜负加身，谁也别想退！' },
        xiangyu_bawang: { cast: '本王在此，谁敢不从！', effect: '还不速决！' },
      },
    },
  },
  {
    id: 'lvbuwei', name: '吕不韦', type: '经营', gender: 'male', color: '#f6c343',
    portrait: C('lv_buwei.png'),
    skillIds: ['lvbuwei_qihuo', 'lvbuwei_shangdao'],
    presentation: { faction: '秦', vfxTheme: 'merchant_seal', voicePack: 'lvbuwei_default' },
    lines: {
      enter: '天下，皆是生意。', skill: '此局，奇货可居！',
      allin: '倾尽家财，博一场泼天富贵！', die: '这笔买卖…亏了…', win: '钱货两讫，概不赊欠。',
      skills: {
        lvbuwei_qihuo: { cast: '风险有价，这份契约你买不买？', effect: '钱货两讫，依约赔付。' },
        lvbuwei_shangdao: { cast: '行情已变，再议一份新约。', effect: '商道重信，分毫不差。' },
      },
    },
  },
  {
    id: 'lianpo', name: '廉颇', type: '防守', gender: 'male', color: '#54d97c',
    portrait: C('lian_po.png'),
    skillIds: ['lianpo_jianbi', 'lianpo_laolian'],
    presentation: { faction: '赵', vfxTheme: 'shield_wall', voicePack: 'lianpo_default' },
    lines: {
      enter: '老夫的盾，还提得动！', skill: '坚壁清野，固守不出。',
      allin: '廉颇老矣，尚能一战！', die: '甲…碎了…', win: '尚能饭否？尚能战也！',
      skills: {
        lianpo_jianbi: { cast: '坚壁清野，稳住阵脚！', effect: '老夫的盾，还没有破！' },
        lianpo_laolian: { cast: '这点伎俩，也想破老夫甲阵？', effect: '攻势已尽，退下！' },
      },
    },
  },
  {
    id: 'wuzetian', name: '武则天', type: '制衡', gender: 'female', color: '#d8b24a',
    portrait: C('wuzetian.png'),
    skillIds: ['wuzetian_linchao', 'wuzetian_zhiheng'],
    presentation: { faction: '周', vfxTheme: 'imperial_edict', voicePack: 'wuzetian_default' },
    lines: {
      enter: '日月当空，诸君入朝。', skill: '朕意已决，尔当奉诏。',
      allin: '天下之局，尽在朕手！', die: '无字碑前…任后人评说。', win: '乾坤既定，万邦来朝。',
      skills: {
        wuzetian_linchao: { cast: '朕定尺度，诸卿奉诏。', effect: '越制者，止于此。' },
        wuzetian_zhiheng: { cast: '一再犯驾，当受制衡。', effect: '收起锋芒，候朕裁决。' },
      },
    },
  },
  {
    id: 'huamulan', name: '花木兰', type: '变阵', gender: 'female', color: '#df6a5b',
    portrait: C('hua_mulan.png'),
    skillIds: ['huamulan_yizhuang', 'huamulan_bianzhen'],
    presentation: { faction: '北魏', vfxTheme: 'cloak_reveal', voicePack: 'huamulan_default' },
    lines: {
      enter: '卸下红妆，且看我执戈。', skill: '真假虚实，只在一念。',
      allin: '万里赴戎机！', die: '愿故乡…烽烟已息。', win: '策勋十二转，不问女儿身。',
      skills: {
        huamulan_yizhuang: { cast: '借你一式，也可破阵。', effect: '形可换，军心不换！' },
        huamulan_bianzhen: { cast: '前阵转后阵，攻守随心！', effect: '阵势已变，接招！' },
      },
    },
  },
  {
    id: 'xishi', name: '西施', type: '观心', gender: 'female', color: '#68c9c3',
    portrait: C('xi_shi.png'),
    skillIds: ['xishi_huansha', 'xishi_chenyu'],
    presentation: { faction: '越', vfxTheme: 'water_ripple', voicePack: 'xishi_default' },
    lines: {
      enter: '苎萝溪水，照见人心。', skill: '纱动水纹，心事自明。',
      allin: '此身入局，便无归途。', die: '一叶扁舟…终未归。', win: '沉鱼非貌，是局中无声。',
      skills: {
        xishi_huansha: { cast: '水纹不语，却照得见你的心。', effect: '这一丝破绽，藏不住。' },
        xishi_chenyu: { cast: '虚张声势，也会惊散游鱼。', effect: '是真心，还是假意？' },
      },
    },
  },
  {
    id: 'wangzhaojun', name: '王昭君', type: '止戈', gender: 'female', color: '#9fcbe8',
    portrait: C('wang_zhaojun.png'),
    skillIds: ['wangzhaojun_zhige', 'wangzhaojun_heming'],
    presentation: { faction: '汉', vfxTheme: 'wild_goose', voicePack: 'wangzhaojun_default' },
    lines: {
      enter: '琵琶一曲，愿边塞无烽。', skill: '雁过长空，且听弦中之意。',
      allin: '此去千里，为两境安宁。', die: '胡天落雪…故乡可安？', win: '弦声既止，干戈亦休。',
      skills: {
        wangzhaojun_zhige: { cast: '一曲止戈，莫再穷兵。', effect: '弦音未绝，杀意当收。' },
        wangzhaojun_heming: { cast: '你若决绝，我便和鸣。', effect: '胜负之后，仍留一线。' },
      },
    },
  },
  {
    id: 'shangguanwaner', name: '上官婉儿', type: '文心', gender: 'female', color: '#e6b75c',
    portrait: C('shangguan_waner.png'),
    skillIds: ['shangguanwaner_luobi', 'shangguanwaner_wenxin'],
    presentation: { faction: '周', vfxTheme: 'golden_script', voicePack: 'shangguanwaner_default' },
    lines: {
      enter: '称量天下士，落笔定风流。', skill: '辞色之间，虚实已见。',
      allin: '一纸诏书，敢定此局！', die: '墨痕未干…人事已非。', win: '彩笔题成，满座皆惊。',
      skills: {
        shangguanwaner_luobi: { cast: '你下一笔，我已替你写好。', effect: '落笔成谶，五金归我。' },
        shangguanwaner_wenxin: { cast: '旧句重来，文心已识。', effect: '你的章法，我看懂了。' },
      },
    },
  },
  {
    id: 'liqingzhao', name: '李清照', type: '词韵', gender: 'female', color: '#a8c68f',
    portrait: C('li_qingzhao.png'),
    skillIds: ['liqingzhao_rumeng', 'liqingzhao_shengsheng'],
    presentation: { faction: '宋', vfxTheme: 'poem_scroll', voicePack: 'liqingzhao_default' },
    lines: {
      enter: '赌书泼茶，今日也赌一局。', skill: '寻寻觅觅，此中自有佳句。',
      allin: '生当作人杰！', die: '梧桐细雨…到黄昏。', win: '此情此景，恰成新词。',
      skills: {
        liqingzhao_rumeng: { cast: '这一注，如梦一场。', effect: '梦醒有得失，词中留余地。' },
        liqingzhao_shengsheng: { cast: '寻寻觅觅，冷冷清清。', effect: '再慢一些，我不会乱。' },
      },
    },
  },
  {
    id: 'fuhao', name: '妇好', type: '卜战', gender: 'female', color: '#c58a55',
    portrait: C('fu_hao.png'),
    skillIds: ['fuhao_zhenbu', 'fuhao_zhengfa'],
    presentation: { faction: '商', vfxTheme: 'oracle_bone', voicePack: 'fuhao_default' },
    lines: {
      enter: '问卜于天，执钺于阵。', skill: '兆已显，依卦而行。',
      allin: '三军听令，随我征伐！', die: '甲骨有痕…英魂不灭。', win: '吉兆应验，班师告庙。',
      skills: {
        fuhao_zhenbu: { cast: '裂甲问兆，你将如何落子？', effect: '卦象应验，献上五金！' },
        fuhao_zhengfa: { cast: '吉兆既明，大军征伐！', effect: '诸军压上，不留喘息！' },
      },
    },
  },
  {
    id: 'muguiying', name: '穆桂英', type: '帅阵', gender: 'female', color: '#e65e55',
    portrait: C('mu_guiying.png'),
    skillIds: ['muguiying_pozhen', 'muguiying_guashuai'],
    presentation: { faction: '宋', vfxTheme: 'marshal_banner', voicePack: 'muguiying_default' },
    lines: {
      enter: '帅旗所向，诸军并进。', skill: '挂帅出征，此阵由我。',
      allin: '杨门女将，破阵在今朝！', die: '帅旗不倒…军心不散。', win: '阵门已破，鸣金收兵。',
      skills: {
        muguiying_pozhen: { cast: '敌阵已聚，随我破阵！', effect: '一枪贯阵，谁来挡我！' },
        muguiying_guashuai: { cast: '帅旗一起，众军听令！', effect: '多军会战，由我统御！' },
      },
    },
  },
  {
    id: 'nvwa', name: '女娲', type: '造化', gender: 'female', color: '#76d0ad',
    portrait: C('nv_wa.png'),
    skillIds: ['nvwa_zaohua', 'nvwa_butian'],
    presentation: { faction: '神', vfxTheme: 'five_color_stone', voicePack: 'nvwa_default' },
    lines: {
      enter: '抟土为生，炼石补天。', skill: '借众生之灵，衍万般造化。',
      allin: '天倾地裂，吾自补之！', die: '山河万古…生生不息。', win: '五色归位，天地重明。',
      skills: {
        nvwa_zaohua: { cast: '舍一念，重塑一线造化。', effect: '新生已成，旧迹归尘。' },
        nvwa_butian: { cast: '天裂一线，以五色补之。', effect: '败势未绝，尚可弥合。' },
      },
    },
  },
  {
    id: 'change', name: '嫦娥', type: '月鉴', gender: 'female', color: '#b7d6ec',
    portrait: C('chang_e.png'),
    skillIds: ['change_yueyin', 'change_qinghui'],
    presentation: { faction: '神', vfxTheme: 'moon_disc', voicePack: 'change_default' },
    lines: {
      enter: '广寒清寂，照见此局。', skill: '月华如水，天机留影。',
      allin: '碧海青天，今夜无悔。', die: '月宫虽远…故心仍在。', win: '清辉遍洒，胜负皆明。',
      skills: {
        change_yueyin: { cast: '月入云中，你寻不到我。', effect: '此术，落在清辉之外。' },
        change_qinghui: { cast: '清辉覆身，尘嚣暂远。', effect: '月光未散，我心自明。' },
      },
    },
  },
];

function hydrateHero(definition) {
  const declared = getHeroSkills(definition);
  const actives = getActiveSkills(definition);
  const passives = getPassiveSkills(definition);
  const active = getActiveSkill(definition);
  const display = active || declared[0];
  const passive = getPassiveSkill(definition);
  const skills = declared;
  const displaySkills = [...actives, ...passives];
  return Object.freeze({
    ...definition,
    skills: Object.freeze({
      active,
      passive,
      actives: Object.freeze(actives),
      passives: Object.freeze(passives),
      display: Object.freeze(displaySkills),
      all: Object.freeze(skills),
    }),
    // 兼容现有武将牌组件；所有值仍来源于统一技能清单。
    skillName: display.name,
    skillCost: display.cost,
    skillDesc: display.description,
    condDesc: display.conditionDescription,
    passiveDesc: passive ? `【${passive.name}】${passive.description}` : '',
  });
}

export const HEROES = Object.freeze(DEFINITIONS.map(hydrateHero));

export function getHero(id) {
  return HEROES.find((hero) => hero.id === id) || null;
}
