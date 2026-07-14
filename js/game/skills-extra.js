// 新增女性英雄技能配置。这里只声明规则，不包含英雄专属执行代码。

const A = 'active';
const P = 'passive';
const ALL_STREETS = ['preflop', 'flop', 'turn', 'river'];
const BEFORE_RIVER = ['preflop', 'flop', 'turn'];

const targetField = (label = '选择目标') => ({
  key: 'targetIdx', type: 'target', label, source: 'active_opponents',
});
const choiceField = (label, options) => ({ key: 'choice', type: 'choice', label, options });

export const EXTRA_SKILLS = {
  wuzetian_linchao: {
    id: 'wuzetian_linchao', kind: A, name: '临朝', cost: 2,
    description: '令一名对手下一次主动技能费用增加 1⚡，持续当前阶段',
    conditionDescription: '令含 Q、K 或 A，且存在可选目标',
    timings: ALL_STREETS,
    condition: { type: 'ALL', items: [
      { type: 'HOLE_RANK_AT_LEAST', rank: 12 },
      { type: 'TARGETABLE_OPPONENT_EXISTS' },
    ] },
    input: { title: '临朝 · 选择受诏者', fields: [targetField()] },
    effects: [{
      op: 'APPLY_STATUS_TO_TARGET', status: {
        id: 'skill_cost_up', modifier: 'SKILL_COST', amount: 1,
        expiresOn: 'STREET_ADVANCE', consumeOn: 'SKILL_USED',
      },
    }],
    presentation: { preset: 'imperial_edict', tone: '#d8b24a', sfx: 'equip2' },
  },
  wuzetian_tianshou: {
    id: 'wuzetian_tianshou', kind: P, name: '天授', trigger: 'SKILL_TARGETED', once: 'round',
    description: '每回合第一次成为其他英雄技能目标时 +1⚡',
    condition: { type: 'OWNER_IS_EVENT_TARGET' },
    effects: [{ op: 'ENERGY_CHANGE', amount: 1 }],
    log: '受诏不惊，获得 1⚡',
    presentation: { preset: 'energy_wisp', tone: '#d8b24a', sfx: 'recover' },
  },

  huamulan_yizhuang: {
    id: 'huamulan_yizhuang', kind: A, name: '易装', cost: 1,
    description: '公开自己选择的一枚暗令，并返还 1⚡',
    conditionDescription: '两令一红一黑',
    timings: ALL_STREETS,
    condition: { type: 'HOLE_ONE_RED_ONE_BLACK' },
    input: { title: '易装 · 选择公开的暗令', fields: [choiceField('选择暗令', [
      { value: 1, label: '第一枚暗令', description: '公开左侧暗令直到本回合结束' },
      { value: 2, label: '第二枚暗令', description: '公开右侧暗令直到本回合结束' },
    ])] },
    effects: [
      { op: 'REVEAL_SELF_HOLE', selectionKey: 'choice' },
      { op: 'ENERGY_CHANGE', amount: 1 },
    ],
    presentation: { preset: 'cloak_reveal', tone: '#df6a5b', sfx: 'link' },
  },
  huamulan_guijia: {
    id: 'huamulan_guijia', kind: P, name: '归甲', trigger: 'SHOWDOWN_RESULT', once: 'round',
    description: '公开的暗令未进入最佳五张牌时 +1⚡',
    condition: { type: 'REVEALED_CARD_UNUSED' },
    effects: [{ op: 'ENERGY_CHANGE', amount: 1 }],
    log: '藏锋归甲，获得 1⚡',
    presentation: { preset: 'energy_wisp', tone: '#df6a5b', sfx: 'draw' },
  },

  xishi_huansha: {
    id: 'xishi_huansha', kind: A, name: '浣纱', cost: 1,
    description: '预测一名对手下一次行动，猜中获得 1⚡',
    conditionDescription: '令含朱雀♥，且存在可选目标',
    timings: ALL_STREETS,
    condition: { type: 'ALL', items: [
      { type: 'HOLE_SUIT_CONTAINS', suit: 2 },
      { type: 'TARGETABLE_OPPONENT_EXISTS' },
    ] },
    input: { title: '浣纱 · 预测对手行动', fields: [
      targetField(),
      choiceField('预测行动', [
        { value: 'fold', label: '退避', description: '目标下一次行动为退避' },
        { value: 'defend', label: '应战', description: '目标下一次行动为静观或应战' },
        { value: 'attack', label: '进攻', description: '目标下一次行动为加注或决死' },
      ]),
    ] },
    effects: [{ op: 'APPLY_ACTION_PREDICTION', reward: 1, target: 'selected' }],
    presentation: { preset: 'water_ripple', tone: '#68c9c3', sfx: 'judge' },
  },
  xishi_chenyu: {
    id: 'xishi_chenyu', kind: P, name: '沉鱼', trigger: 'ROUND_END', once: 'round',
    description: '本回合行动预测成功时 +1⚡',
    condition: { type: 'ROUND_FLAG', key: 'prediction_success' },
    effects: [{ op: 'ENERGY_CHANGE', amount: 1 }],
    log: '洞悉人心，获得 1⚡',
    presentation: { preset: 'energy_wisp', tone: '#68c9c3', sfx: 'recover' },
  },

  wangzhaojun_chusai: {
    id: 'wangzhaojun_chusai', kind: A, name: '出塞', cost: 1,
    description: '预测下一张公共牌的颜色，猜中获得 2⚡',
    conditionDescription: '两令同色，且仍有天机未揭示',
    timings: BEFORE_RIVER,
    condition: { type: 'ALL', items: [
      { type: 'HOLE_SAME_COLOR' }, { type: 'BOARD_REMAINING' },
    ] },
    input: { title: '出塞 · 预测下一张天机', fields: [choiceField('选择颜色', [
      { value: 'red', label: '红色', description: '朱雀♥或白虎♦' },
      { value: 'black', label: '黑色', description: '玄武♠或青龙♣' },
    ])] },
    effects: [{ op: 'APPLY_BOARD_COLOR_PREDICTION', reward: 2 }],
    presentation: { preset: 'wild_goose', tone: '#9fcbe8', sfx: 'judge' },
  },
  wangzhaojun_heming: {
    id: 'wangzhaojun_heming', kind: P, name: '和鸣', trigger: 'STREET_ADVANCE', once: 'round',
    description: '一个阶段无人加注且自己仍在局内时 +1⚡',
    condition: { type: 'ALL', items: [
      { type: 'OWNER_ACTIVE' }, { type: 'EVENT_STREET_NO_RAISE' },
    ] },
    effects: [{ op: 'ENERGY_CHANGE', amount: 1 }],
    log: '一曲止戈，获得 1⚡',
    presentation: { preset: 'energy_wisp', tone: '#9fcbe8', sfx: 'draw' },
  },

  shangguanwaner_guanci: {
    id: 'shangguanwaner_guanci', kind: A, name: '观辞', cost: 2,
    description: '查看一名对手当前胜率的低、中、高区间',
    conditionDescription: '两令点数差不超过 2，且存在可选目标',
    timings: ALL_STREETS,
    condition: { type: 'ALL', items: [
      { type: 'HOLE_RANK_DIFF_MAX', value: 2 },
      { type: 'TARGETABLE_OPPONENT_EXISTS' },
    ] },
    input: { title: '观辞 · 选择观测目标', fields: [targetField()] },
    effects: [{ op: 'PEEK_STRENGTH_BAND' }],
    presentation: { preset: 'golden_script', tone: '#e6b75c', sfx: 'judge' },
  },
  shangguanwaner_luobi: {
    id: 'shangguanwaner_luobi', kind: P, name: '落笔', trigger: 'BOARD_REVEALED', once: 'round',
    description: '公共牌揭示后，自己的牌型品阶首次变化时 +1⚡',
    condition: { type: 'OWNER_HAND_TIER_CHANGED' },
    effects: [{ op: 'ENERGY_CHANGE', amount: 1 }],
    log: '落笔成章，获得 1⚡',
    presentation: { preset: 'energy_wisp', tone: '#e6b75c', sfx: 'draw' },
  },

  liqingzhao_xunci: {
    id: 'liqingzhao_xunci', kind: A, name: '寻词', cost: 1,
    description: '预测自己最终牌型为一对及以下或两对及以上，猜中获得 2⚡',
    conditionDescription: '两令点数和为奇数，且当前不是人和阶段',
    timings: BEFORE_RIVER,
    condition: { type: 'HOLE_RANK_SUM_PARITY', value: 'odd' },
    input: { title: '寻词 · 预测最终杀招', fields: [choiceField('选择牌型区间', [
      { value: 'low', label: '一对及以下', description: '孤锋独行或双雄并立' },
      { value: 'high', label: '两对及以上', description: '双龙戏珠或更高品阶' },
    ])] },
    effects: [{ op: 'APPLY_SHOWDOWN_TIER_PREDICTION', reward: 2 }],
    presentation: { preset: 'poem_scroll', tone: '#a8c68f', sfx: 'judge' },
  },
  liqingzhao_shuyu: {
    id: 'liqingzhao_shuyu', kind: P, name: '漱玉', trigger: 'SHOWDOWN_RESULT', once: 'round',
    description: '整回合没有主动加注且参与亮招时 +1⚡',
    condition: { type: 'OWNER_SHOWDOWN_WITHOUT_RAISE' },
    effects: [{ op: 'ENERGY_CHANGE', amount: 1 }],
    log: '静守词心，获得 1⚡',
    presentation: { preset: 'energy_wisp', tone: '#a8c68f', sfx: 'recover' },
  },

  fuhao_zhenbu: {
    id: 'fuhao_zhenbu', kind: A, name: '贞卜', cost: 1,
    description: '声明下一次行动采用守势或攻势，完成后获得 2⚡',
    conditionDescription: '令含青龙♣',
    timings: ALL_STREETS,
    condition: { type: 'HOLE_SUIT_CONTAINS', suit: 4 },
    input: { title: '贞卜 · 声明下一次行动', fields: [choiceField('选择姿态', [
      { value: 'defend', label: '守势', description: '下一次行动为静观或应战' },
      { value: 'attack', label: '攻势', description: '下一次行动为加注或决死' },
    ])] },
    effects: [{ op: 'APPLY_ACTION_PREDICTION', reward: 2, target: 'self' }],
    presentation: { preset: 'oracle_bone', tone: '#c58a55', sfx: 'equip1' },
  },
  fuhao_zhengfa: {
    id: 'fuhao_zhengfa', kind: P, name: '征伐', trigger: 'ACTION', once: 'round',
    description: '至少三名对手仍在局时首次进攻 +1⚡',
    condition: { type: 'OWNER_ATTACKED_CROWDED', opponents: 3 },
    effects: [{ op: 'ENERGY_CHANGE', amount: 1 }],
    log: '执钺征伐，获得 1⚡',
    presentation: { preset: 'energy_wisp', tone: '#c58a55', sfx: 'damage' },
  },

  muguiying_guashuai: {
    id: 'muguiying_guashuai', kind: A, name: '挂帅', cost: 2,
    description: '当前阶段不能成为下一次敌方指向技能的目标',
    conditionDescription: '令含 7、8、9 或 10',
    timings: ALL_STREETS,
    condition: { type: 'HOLE_RANK_RANGE_CONTAINS', min: 7, max: 10 },
    effects: [{
      op: 'APPLY_STATUS', status: {
        id: 'skill_shield', modifier: 'BLOCK_TARGETING',
        expiresOn: 'STREET_ADVANCE', consumeOn: 'SKILL_TARGETED',
      },
    }],
    presentation: { preset: 'marshal_banner', tone: '#e65e55', sfx: 'equip1' },
  },
  muguiying_pozhen: {
    id: 'muguiying_pozhen', kind: P, name: '破阵', trigger: 'SHOWDOWN_RESULT', once: 'round',
    description: '决死后参与亮招并存活时 +1⚡',
    condition: { type: 'OWNER_SURVIVED_ALLIN_SHOWDOWN' },
    effects: [{ op: 'ENERGY_CHANGE', amount: 1 }],
    log: '破阵归来，获得 1⚡',
    presentation: { preset: 'energy_wisp', tone: '#e65e55', sfx: 'recover' },
  },

  nvwa_zaohua: {
    id: 'nvwa_zaohua', kind: A, name: '造化', cost: 2,
    description: '本回合复制一名英雄标记为可复制的被动技能',
    conditionDescription: '两令同花色，且存在可选目标',
    timings: ALL_STREETS,
    condition: { type: 'ALL', items: [
      { type: 'HOLE_SAME_SUIT' }, { type: 'COPYABLE_PASSIVE_TARGET_EXISTS' },
    ] },
    input: { title: '造化 · 选择被动来源', fields: [targetField('选择被动来源')] },
    effects: [{ op: 'COPY_TARGET_PASSIVE' }],
    presentation: { preset: 'five_color_stone', tone: '#76d0ad', sfx: 'link' },
  },
  nvwa_butian: {
    id: 'nvwa_butian', kind: P, name: '补天', trigger: 'ROUND_END', once: 'round',
    description: '复制的被动本回合未触发时返还 1⚡',
    condition: { type: 'COPIED_PASSIVE_MISSED' },
    effects: [{ op: 'ENERGY_CHANGE', amount: 1 }],
    log: '五色补缺，返还 1⚡',
    presentation: { preset: 'energy_wisp', tone: '#76d0ad', sfx: 'recover' },
    copyable: false,
  },

  change_wangyue: {
    id: 'change_wangyue', kind: A, name: '望月', cost: 1,
    description: '查看下一张公共牌的花色，但不显示点数',
    conditionDescription: '令含玄武♠，且仍有天机未揭示',
    timings: BEFORE_RIVER,
    condition: { type: 'ALL', items: [
      { type: 'HOLE_SUIT_CONTAINS', suit: 1 }, { type: 'BOARD_REMAINING' },
    ] },
    effects: [{ op: 'PEEK_NEXT_BOARD_SUIT' }],
    presentation: { preset: 'moon_disc', tone: '#b7d6ec', sfx: 'judge' },
  },
  change_qinghui: {
    id: 'change_qinghui', kind: P, name: '清辉', trigger: 'BOARD_REVEALED', once: 'round',
    description: '新揭示公共牌的花色与任意暗令相同时 +1⚡',
    condition: { type: 'REVEALED_SUIT_MATCHES_HOLE' },
    effects: [{ op: 'ENERGY_CHANGE', amount: 1 }],
    log: '月华同辉，获得 1⚡',
    presentation: { preset: 'energy_wisp', tone: '#b7d6ec', sfx: 'draw' },
  },
};
