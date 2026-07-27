// ============================================================================
// skills.js - 群英决 V2 英雄技能规则
// 技能不再消耗能量；能量只保留给行动延时。所有结算增减均为玩家间转账。
// ============================================================================

import * as Config from './config.js';
import * as WinRate from './winrate.js';

const ACTIVE = 'active';
const PASSIVE = 'passive';
const LIMITED = 'match';
const STREET_LABEL = { preflop: '暗令', flop: '天时', turn: '地利', river: '人和' };
const ACTION_GROUPS = Object.freeze({
  fold: 'retreat', check: 'defend', call: 'defend',
  feint: 'attack', strike: 'attack', fierce: 'attack', raise: 'attack', allin: 'attack',
});
const STREET_ORDER = Object.freeze(['preflop', 'flop', 'turn', 'river']);

const presentation = (preset, tone, sfx, role, intensity = 'medium') => ({
  preset, tone, sfx, role, intensity,
});

const skill = (id, kind, name, description, conditionDescription, present, extra = {}) => Object.freeze({
  id, kind, name, cost: 0, description, conditionDescription,
  presentation: presentation(...present), ...extra,
});

export const SKILLS = Object.freeze({
  zhugeliang_guanxing: skill('zhugeliang_guanxing', ACTIVE, '观星',
    '限定技。天时或地利阶段、底池达到8BB时，选择一个点数区间和两种花色；私下得知下一张公共牌是否分别命中这两个范围。',
    '天时/地利阶段；底池≥8BB；仍有公共牌未发', ['celestial_reveal', '#7fd4ff', 'judge', 'control', 'high'],
    { limited: LIMITED, timings: ['flop', 'turn'] }),
  zhugeliang_kongcheng: skill('zhugeliang_kongcheng', ACTIVE, '空城计',
    '本阶段首位行动且无人下注时，选择33%或75%底池并立即静观；行动返回前，首名非决死进攻者只能采用该比例。',
    '天时/地利阶段；本阶段首位行动；无人下注；间隔一手', ['celestial_lock', '#7fd4ff', 'link', 'bluff', 'high'],
    { timings: ['flop', 'turn'], cooldownHands: 1 }),

  diaochan_lianhuan: skill('diaochan_lianhuan', ACTIVE, '连环计',
    '同一对手连续两个阶段主动进攻你且底池达到8BB时，指定其下一阶段首次非决死进攻为33%或66%底池。',
    '遭同一对手连续两阶段进攻；底池≥8BB', ['silk_chain', '#c58bff', 'link', 'taunt', 'high'],
    { timings: ['turn', 'river'] }),
  diaochan_biyue: skill('diaochan_biyue', PASSIVE, '闭月',
    '上手净赢最多者本手首次主动进攻你时，其行动时间-6秒，你的应对时间+6秒。',
    '每手一次', ['moon_silk', '#c58bff', 'judge', 'taunt']),

  hanxin_andu: skill('hanxin_andu', ACTIVE, '暗度陈仓',
    '至少两名对手已自愿投入且可以加注时，立即加注：补齐跟注额后，再加行动前底池的80%；所有应对者行动时间-5秒。',
    '至少两名对手自愿投入；当前可加注', ['battle_standard', '#ff9d76', 'damage', 'attack', 'high'],
    { timings: ['preflop', 'flop', 'turn', 'river'] }),
  hanxin_beishui: skill('hanxin_beishui', PASSIVE, '背水一战',
    '限定技。筹码≤12BB并主动决死时：若胜，额外获得基础净赢的12%，且不超过所有输家普通结算后剩余筹码总额的20%；若败，额外损失基础净输的12%，且不超过自己剩余筹码的20%。',
    '整局一次；筹码≤12BB；韩信主动决死', ['last_stand', '#ff755f', 'damage', 'attack', 'high'],
    { limited: LIMITED }),

  xiangyu_pofu: skill('xiangyu_pofu', ACTIVE, '破釜沉舟',
    '限定技。筹码≤15BB或底池≥12BB时立即决死；项羽与所有跟入者之间的最终净输赢放大15%，无设计上限。',
    '整局一次；筹码≤15BB或底池≥12BB', ['overlord_aura', '#ff554f', 'damage', 'attack', 'high'],
    { limited: LIMITED, timings: ['preflop', 'flop', 'turn', 'river'] }),
  xiangyu_bawang: skill('xiangyu_bawang', PASSIVE, '霸王威压',
    '每阶段首次主动决死且有效筹码≥8BB时，其他玩家本次应对时间-8秒（最低8秒），本次延时最多补充15秒。',
    '每阶段一次；有效筹码≥8BB', ['overlord_pressure', '#ff554f', 'damage', 'pressure', 'high']),

  lvbuwei_qihuo: skill('lvbuwei_qihuo', ACTIVE, '奇货可居',
    '限定技。决死亮牌且公共牌未发完时，按实时公平赔率向当前领先者出售25%/50%/75%/100%风险本金的保险。',
    '整局一次；决死亮牌；存在胜率>50%的可投保玩家', ['merchant_seal', '#f6c343', 'equip2', 'trade', 'high'],
    { limited: LIMITED, timings: ['flop', 'turn'] }),
  lvbuwei_shangdao: skill('lvbuwei_shangdao', ACTIVE, '商道',
    '限定技。首份保险售出后下一张公共牌揭示，若买家仍领先且尚有未投保风险，可按新公平赔率追加一份保险。',
    '整局一次；已售奇货可居；下一张公共牌已揭示', ['coin_contract', '#f6c343', 'equip2', 'trade', 'high'],
    { limited: LIMITED, timings: ['turn', 'river'] }),

  lianpo_jianbi: skill('lianpo_jianbi', PASSIVE, '坚壁清野',
    '本手从未主动下注或加注、底池≥10BB且亮牌落败时，返还自愿投入损失的10%，最多1.5BB；相关底池赢家按收益比例支付。触发后隔一手才可再触发。',
    '从未进攻；底池≥10BB；亮牌落败', ['shield_wall', '#54d97c', 'equip1', 'defense', 'high']),
  lianpo_laolian: skill('lianpo_laolian', PASSIVE, '老而弥坚',
    '限定技。本手未主动进攻时，首个以你为目标的敌方主动技能对你无效；群体技能仅取消影响你的部分。',
    '整局一次；本手未主动进攻', ['iron_guard', '#54d97c', 'equip1', 'defense', 'high'],
    { limited: LIMITED }),

  wuzetian_linchao: skill('wuzetian_linchao', ACTIVE, '临朝称制',
    '本阶段剩余所有非决死下注与加注统一为当前底池的50%；不限制退避、静观、跟注和决死。',
    '天时/地利阶段；底池≥8BB；尚未出现决死；间隔一手', ['imperial_edict', '#d8b24a', 'equip2', 'control', 'high'],
    { timings: ['flop', 'turn'], cooldownHands: 1 }),
  wuzetian_zhiheng: skill('wuzetian_zhiheng', PASSIVE, '制衡',
    '同一玩家连续两个阶段进攻你时，其下一次对你的非决死进攻上限为50%底池且行动时间-5秒。',
    '每手一次', ['imperial_balance', '#d8b24a', 'judge', 'control']),

  huamulan_yizhuang: skill('huamulan_yizhuang', ACTIVE, '易装',
    '限定技。复制本手其他玩家已经发动的普通主动技能，数值效果按70%生效；不能复制限定技、保险、换牌与反制技能。',
    '整局一次；本手存在可复制的普通主动技能', ['cloak_reveal', '#df6a5b', 'link', 'trick', 'high'],
    { limited: LIMITED, timings: ['preflop', 'flop', 'turn', 'river'] }),
  huamulan_bianzhen: skill('huamulan_bianzhen', PASSIVE, '变阵',
    '本手首次由进攻转防守时，抵挡下一次指向技能；首次由防守转进攻时，所有应对者行动时间-5秒。',
    '每手一次', ['formation_shift', '#df6a5b', 'link', 'tactical']),

  xishi_huansha: skill('xishi_huansha', ACTIVE, '浣纱观心',
    '面对不低于50%底池的下注且底池≥6BB时，随机获得该下注者的一条真实线索：高张、同花、成牌、听牌或皆无。',
    '面对≥50%底池下注；底池≥6BB；每手一次', ['water_ripple', '#68c9c3', 'judge', 'read']),
  xishi_chenyu: skill('xishi_chenyu', PASSIVE, '沉鱼',
    '河牌单挑跟注：若击败最终仅高牌的下注者，下注者额外支付你基础净赢的10%；若跟注失败，你额外支付下注者基础净输的5%。',
    '河牌单挑跟注并亮牌', ['water_bloom', '#68c9c3', 'recover', 'read', 'high']),

  wangzhaojun_zhige: skill('wangzhaojun_zhige', ACTIVE, '止戈',
    '本阶段普通下注上限为50%底池；出现首次下注后，最多再发生一次非决死加注。',
    '天时/地利阶段；底池6-14BB；尚未决死；间隔一手', ['wild_goose', '#9fcbe8', 'link', 'defense', 'high'],
    { timings: ['flop', 'turn'], cooldownHands: 1 }),
  wangzhaojun_heming: skill('wangzhaojun_heming', PASSIVE, '和鸣',
    '限定技。止戈期间有人决死且你需要应对时，你+10秒、决死者-5秒；若你跟入并败给该玩家，对方返还你基础净输的10%。',
    '整局一次；止戈期间应对决死', ['peace_chord', '#9fcbe8', 'recover', 'defense', 'high'],
    { limited: LIMITED }),

  shangguanwaner_luobi: skill('shangguanwaner_luobi', ACTIVE, '落笔定局',
    '预测一名在你之后行动的对手下一次为退避、防守或进攻。正确向对方索取5BB；错误向对方缴纳2BB，双方预先托管。',
    '自身筹码≥2BB；目标筹码≥5BB；间隔一手', ['golden_script', '#e6b75c', 'judge', 'prediction', 'high'],
    { timings: ['preflop', 'flop', 'turn', 'river'], cooldownHands: 1 }),
  shangguanwaner_wenxin: skill('shangguanwaner_wenxin', PASSIVE, '文心',
    '同一玩家连续两个阶段使用同一下注尺度区间后，其下一次行动前你获得8秒额外思考时间。',
    '每手一次', ['ink_mark', '#e6b75c', 'draw', 'read']),

  liqingzhao_rumeng: skill('liqingzhao_rumeng', ACTIVE, '如梦令',
    '限定技。河牌单挑面对非决死下注时进行对冲跟注：若败，下注者返还跟注额20%；若胜，你返还基础净赢10%。',
    '整局一次；河牌单挑；面对非决死下注', ['poem_scroll', '#a8c68f', 'recover', 'defense', 'high'],
    { limited: LIMITED, timings: ['river'] }),
  liqingzhao_shengsheng: skill('liqingzhao_shengsheng', PASSIVE, '声声慢',
    '连续输掉两手后，免疫行动减时且每次行动+6秒，直到下一次获胜。',
    '连续两手基础净输', ['slow_rain', '#a8c68f', 'recover', 'defense']),

  fuhao_zhenbu: skill('fuhao_zhenbu', ACTIVE, '贞卜',
    '预测一名在你之后行动的对手下一次具体操作。正确向对方索取5BB；错误向对方缴纳2.5BB，双方预先托管。',
    '自身筹码≥2.5BB；目标筹码≥5BB且至少有3种合法操作；每手一次', ['oracle_bone', '#c58a55', 'judge', 'prediction', 'high'],
    { timings: ['preflop', 'flop', 'turn', 'river'] }),
  fuhao_zhengfa: skill('fuhao_zhengfa', PASSIVE, '征伐',
    '贞卜正确后，你的下一次进攻令所有应对者-5秒；若本手基础净赢，额外获得基础净赢的5%，由所有基础输家等额承担。',
    '贞卜正确且本手净赢', ['war_oracle', '#c58a55', 'damage', 'attack', 'high']),

  muguiying_pozhen: skill('muguiying_pozhen', ACTIVE, '破阵',
    '出现“下注+跟注”或至少两名跟注者、底池≥6BB且可以加注时，立即加注：补齐跟注额后，再加行动前底池的80%；应对者-5秒。',
    '多人底池；底池≥6BB；当前可加注', ['marshal_banner', '#e65e55', 'damage', 'attack', 'high'],
    { timings: ['preflop', 'flop', 'turn', 'river'] }),
  muguiying_guashuai: skill('muguiying_guashuai', PASSIVE, '挂帅',
    '翻牌时至少3人仍在局，本手每次行动+6秒；最终基础净输赢放大8%，无设计上限，输赢双方按基础结果比例转账。',
    '翻牌多人底池', ['red_banner', '#e65e55', 'link', 'attack', 'high']),

  nvwa_zaohua: skill('nvwa_zaohua', ACTIVE, '造化',
    '限定技。翻牌后转牌前，选择一张底牌暗置弃牌堆，并从未发牌堆随机换入一张牌；仅公开发生过换牌。',
    '整局一次；天时阶段；底池≤8BB；尚未决死', ['five_color_stone', '#76d0ad', 'drawx', 'mystic', 'high'],
    { limited: LIMITED, timings: ['flop'] }),
  nvwa_butian: skill('nvwa_butian', PASSIVE, '补天',
    '限定技。亮牌落败且与对应赢家仅差踢脚，或牌型恰差一级时，返还基础净输的10%；相关赢家按收益比例支付。',
    '整局一次；满足窄差距亮牌落败', ['mending_light', '#76d0ad', 'recover', 'defense', 'high'],
    { limited: LIMITED }),

  change_yueyin: skill('change_yueyin', PASSIVE, '月隐',
    '限定技。首个以你为目标的敌方主动技能对你无效；群体技能仅取消影响你的部分，攻击者本次使用仍被消耗。',
    '整局一次', ['moon_disc', '#b7d6ec', 'judge', 'defense', 'high'],
    { limited: LIMITED }),
  change_qinghui: skill('change_qinghui', ACTIVE, '清辉',
    '选择静观或跟注后，直到你的下一次行动前不能成为技能目标、免疫行动减时，且下一次行动+8秒。',
    '天时/地利阶段；本次可静观或跟注；每手一次', ['moonlight_veil', '#b7d6ec', 'recover', 'defense', 'high'],
    { timings: ['flop', 'turn'] }),
});

export function getSkill(id) { return SKILLS[id] || null; }

export function getHeroSkills(hero) {
  if (!hero?.skillIds) return [];
  const ids = Array.isArray(hero.skillIds)
    ? hero.skillIds
    : [hero.skillIds.active, hero.skillIds.passive];
  return ids.map(getSkill).filter(Boolean);
}

export function getActiveSkills(hero) {
  return getHeroSkills(hero).filter((item) => item.kind === ACTIVE);
}

export function getActiveSkill(hero) {
  return getActiveSkills(hero)[0] || null;
}

export function getPassiveSkills(hero) {
  return getHeroSkills(hero).filter((item) => item.kind === PASSIVE);
}

export function getPassiveSkill(hero) {
  return getPassiveSkills(hero)[0] || null;
}

function bb(engine) { return Math.max(1, Config.getBlinds(Math.max(1, engine.round || 1)).bb); }
function potBb(engine) { return engine.totalPot() / bb(engine); }
function stackBb(engine, player) { return player.hp / bb(engine); }
function roundChip(value) { return Math.max(0, Math.round(Number(value) || 0)); }
function nextStreet(street) {
  const index = STREET_ORDER.indexOf(street);
  return index >= 0 ? STREET_ORDER[index + 1] || null : null;
}
function hasActedThisStreet(engine) {
  return engine.actionHistory?.some((entry) => entry.round === engine.round
    && entry.street === engine.street && !entry.forced);
}
function voluntaryInvestors(engine, excludeIdx = 0) {
  const ids = new Set();
  for (const entry of engine.actionHistory || []) {
    if (entry.round !== engine.round || entry.actorIdx === excludeIdx || entry.forced) continue;
    if (entry.amount > 0 && entry.key !== 'blind') ids.add(entry.actorIdx);
  }
  return ids;
}
function previousAction(engine, player) {
  const history = engine.actionHistory || [];
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item.round === engine.round && item.actorIdx !== player.idx && !item.forced) return item;
  }
  return null;
}
function targetablePlayers(engine, player) {
  return engine.activePlayers().filter((other) => other.idx !== player.idx);
}
function ownsSkill(player, skillId) {
  return getHeroSkills(player?.hero).some((item) => item.id === skillId);
}
function matchUsed(player, id) { return !!player.skillMatchUsed?.[id]; }
function handUsed(player, id) { return !!player.skillData?.used?.[id]; }
function onCooldown(engine, player, skillDef) {
  const last = Number(player.skillLastHand?.[skillDef.id] || 0);
  return !!skillDef.cooldownHands && last > 0 && engine.round - last <= skillDef.cooldownHands;
}
function state(engine) {
  if (!engine.skillState) {
    engine.skillState = {
      streetRule: null, predictions: [], insurance: [], markedAllIn: null,
      copiedActives: [], insuranceOffer: null,
    };
  }
  return engine.skillState;
}

function pressureResponders(engine, source, seconds, predicate = null, extendSeconds = null) {
  for (const target of engine.activePlayers()) {
    if (target.idx === source.idx || target.allIn || (predicate && !predicate(target))) continue;
    target.skillData.nextTimePenalty = (target.skillData.nextTimePenalty || 0) + seconds;
    if (Number.isFinite(Number(extendSeconds))) {
      target.skillData.nextExtendSeconds = Math.max(
        0,
        Math.min(
          Number(target.skillData.nextExtendSeconds ?? Config.EXTEND_TIME),
          Number(extendSeconds),
        ),
      );
    }
  }
}

function availableCondition(engine, player, def) {
  const opts = engine.getOptions(player);
  const last = previousAction(engine, player);
  switch (def.id) {
    case 'zhugeliang_guanxing':
      return potBb(engine) >= 8 && engine.revealed < 5;
    case 'zhugeliang_kongcheng':
      return !hasActedThisStreet(engine) && engine.currentBet === 0 && opts.canCheck;
    case 'diaochan_lianhuan':
      return potBb(engine) >= 8 && !!player.skillData?.consecutiveAttackerIdx;
    case 'hanxin_andu':
    case 'muguiying_pozhen':
      return voluntaryInvestors(engine, player.idx).size >= 2 && opts.canRaise;
    case 'xiangyu_pofu':
      return stackBb(engine, player) <= 15 || potBb(engine) >= 12;
    case 'lvbuwei_qihuo':
      return !!state(engine).insuranceOffer?.buyers?.length;
    case 'lvbuwei_shangdao':
      return !!state(engine).insuranceOffer?.secondTranche;
    case 'wuzetian_linchao':
      return potBb(engine) >= 8 && !engine.activePlayers().some((p) => p.allIn);
    case 'huamulan_yizhuang':
      return state(engine).copiedActives.some((item) => !item.limited && item.copyable !== false);
    case 'xishi_huansha':
      return potBb(engine) >= 6 && !!last && last.isAggressive
        && last.amount >= last.potBefore * 0.5;
    case 'wangzhaojun_zhige':
      return potBb(engine) >= 6 && potBb(engine) <= 14
        && !engine.activePlayers().some((p) => p.allIn);
    case 'shangguanwaner_luobi':
      return stackBb(engine, player) >= 2
        && targetablePlayers(engine, player).some((p) => stackBb(engine, p) >= 5);
    case 'liqingzhao_rumeng':
      return engine.activePlayers().length === 2 && !!last && last.isAggressive
        && last.key !== 'allin' && opts.toCall > 0;
    case 'fuhao_zhenbu':
      return stackBb(engine, player) >= 2.5
        && targetablePlayers(engine, player).some((p) => stackBb(engine, p) >= 5);
    case 'nvwa_zaohua':
      return potBb(engine) <= 8 && !engine.activePlayers().some((p) => p.allIn);
    case 'change_qinghui':
      return opts.canCheck || opts.toCall > 0;
    default:
      return true;
  }
}

function activeById(player, skillId) {
  const active = getActiveSkills(player?.hero);
  if (!skillId) return active[0] || null;
  return active.find((item) => item.id === skillId) || null;
}

export function getSkillAvailability(engine, player, skillId = null) {
  const def = activeById(player, skillId);
  if (!def) return { ok: false, reason: '没有可发动的主动技能', skill: null, cost: 0 };
  if (!player || engine.gameOver || !player.alive) return { ok: false, reason: '已阵亡', skill: def, cost: 0 };
  if (player.folded) return { ok: false, reason: '已退避', skill: def, cost: 0 };
  if (handUsed(player, def.id)) return { ok: false, reason: '本手已发动', skill: def, cost: 0 };
  if (def.limited === LIMITED && matchUsed(player, def.id)) {
    return { ok: false, reason: '限定技本局已使用', skill: def, cost: 0 };
  }
  if (onCooldown(engine, player, def)) return { ok: false, reason: '需要间隔一手', skill: def, cost: 0 };
  if (def.timings && !def.timings.includes(engine.street)) {
    return { ok: false, reason: '当前阶段不能发动', skill: def, cost: 0 };
  }
  const isInsuranceWindow = ['lvbuwei_qihuo', 'lvbuwei_shangdao'].includes(def.id)
    && !!state(engine).insuranceOffer;
  if (!isInsuranceWindow && Number(engine.actingIdx) !== Number(player.idx)) {
    return { ok: false, reason: '仅可在轮到你行动时发动', skill: def, cost: 0 };
  }
  if (!availableCondition(engine, player, def)) {
    return { ok: false, reason: `条件未满足：${def.conditionDescription}`, skill: def, cost: 0 };
  }
  return { ok: true, reason: '条件已满足，可以发动', skill: def, cost: 0 };
}

function predictionTargets(engine, player) {
  return targetablePlayers(engine, player)
    .filter((target) => stackBb(engine, target) >= 5)
    .map((target) => ({
      value: target.idx,
      label: `${target.idx}号位 · ${target.playerName || target.hero.name}`,
      description: `${target.hero.name} · ${Math.round(target.hp / bb(engine))}BB`,
    }));
}

export function getSkillInput(engine, player, skillId = null) {
  const def = activeById(player, skillId);
  if (!def) return null;
  const targetField = { key: 'targetIdx', type: 'target', label: '选择目标', options: predictionTargets(engine, player) };
  switch (def.id) {
    case 'zhugeliang_guanxing':
      return { title: '观星 · 划定天机范围', fields: [
        { key: 'rankBand', type: 'choice', label: '点数区间', options: [
          { value: 'low', label: '2—6' }, { value: 'mid', label: '7—10' }, { value: 'high', label: 'J—A' },
        ] },
        { key: 'suitPair', type: 'choice', label: '两种花色', options: [
          { value: '12', label: '♠ + ♥' }, { value: '13', label: '♠ + ♦' }, { value: '14', label: '♠ + ♣' },
          { value: '23', label: '♥ + ♦' }, { value: '24', label: '♥ + ♣' }, { value: '34', label: '♦ + ♣' },
        ] },
      ] };
    case 'zhugeliang_kongcheng':
    case 'diaochan_lianhuan':
      return { title: `${def.name} · 锁定下注尺度`, fields: [{
        key: 'ratio', type: 'choice', label: '下注尺度', options: [
          { value: 0.33, label: '33%底池' }, { value: def.id === 'diaochan_lianhuan' ? 0.66 : 0.75, label: `${def.id === 'diaochan_lianhuan' ? 66 : 75}%底池` },
        ],
      }] };
    case 'lvbuwei_qihuo':
    case 'lvbuwei_shangdao':
      return { title: `${def.name} · 公平保险契约`, fields: [
        { ...targetField, options: (state(engine).insuranceOffer?.buyers || []).map((idx) => ({
          value: idx, label: `${idx}号位 · ${engine.players[idx].playerName || engine.players[idx].hero.name}`,
        })) },
        { key: 'coverage', type: 'choice', label: '承保比例', options: [25, 50, 75, 100].map((v) => ({
          value: v / 100, label: `${v}%风险本金`,
        })) },
      ] };
    case 'huamulan_yizhuang':
      return { title: '易装 · 选择复刻技能', fields: [{
        key: 'copySkillId', type: 'choice', label: '可复制技能',
        options: state(engine).copiedActives.filter((item) => !item.limited && item.copyable !== false)
          .map((item) => ({ value: item.skillId, label: item.name, description: `来源：${item.heroName}` })),
      }] };
    case 'shangguanwaner_luobi':
      return { title: '落笔定局 · 预测行动类别', fields: [targetField, {
        key: 'choice', type: 'choice', label: '预测', options: [
          { value: 'retreat', label: '退避' }, { value: 'defend', label: '防守' }, { value: 'attack', label: '进攻' },
        ],
      }] };
    case 'fuhao_zhenbu': {
      const opts = engine.getOptions(engine.players[predictionTargets(engine, player)[0]?.value] || player);
      const choices = [];
      if (opts.canCheck) choices.push({ value: 'check', label: '静观' });
      else choices.push({ value: 'fold', label: '退避' }, { value: 'call', label: '应战' });
      for (const tier of opts.tiers || []) choices.push({ value: tier.key, label: tier.name });
      if (opts.canAllIn) choices.push({ value: 'allin', label: '决死' });
      return { title: '贞卜 · 精确预测', fields: [targetField, {
        key: 'choice', type: 'choice', label: '预测具体操作', options: choices,
      }] };
    }
    case 'nvwa_zaohua':
      return { title: '造化 · 选择重塑的暗令', fields: [{
        key: 'cardIndex', type: 'choice', label: '更换', options: [
          { value: 1, label: '第一张暗令' }, { value: 2, label: '第二张暗令' },
        ],
      }] };
    case 'change_qinghui': {
      const opts = engine.getOptions(player);
      return { title: '清辉 · 选择防守动作', fields: [{
        key: 'choice', type: 'choice', label: '动作',
        options: opts.canCheck ? [{ value: 'check', label: '静观' }] : [{ value: 'call', label: '应战' }],
      }] };
    }
    default:
      return null;
  }
}

function validSelection(prompt, selection, engine, player) {
  if (!prompt?.fields?.length) return {};
  const result = {};
  for (const field of prompt.fields) {
    const requested = selection?.[field.key];
    const found = field.options?.find((item) => String(item.value) === String(requested));
    if (found) result[field.key] = found.value;
    else if (!player.isHuman && field.options?.length) {
      result[field.key] = field.options[Math.floor(engine.rng() * field.options.length)].value;
    } else return null;
  }
  return result;
}

function quote(engine, player, def, phase = 'cast') {
  const lines = player.hero.lines?.skills?.[def.id];
  const text = lines?.[phase] || (phase === 'effect' ? lines?.cast : null) || player.hero.lines?.skill;
  if (text) engine.emit('onQuote', player.idx, text, { skillId: def.id, phase, presentation: def.presentation });
}

function announce(engine, player, def, phase = 'cast', detail = '') {
  const event = phase === 'cast' ? 'onSkill' : phase === 'passive' ? 'onPassive' : 'onSkillEffect';
  engine.emit(event, player.idx, def.id, def.name, { ...def.presentation, phase, detail });
  quote(engine, player, def, phase === 'cast' ? 'cast' : 'effect');
  engine.log(`${player.hero.name}${phase === 'passive' ? '触发' : phase === 'effect' ? '生效' : '发动'}【${def.name}】${detail ? `：${detail}` : ''}`, 'skill');
}

function markUse(engine, player, def) {
  player.skillData.used[def.id] = true;
  player.skillUsed = true;
  player.skillLastHand ||= Object.create(null);
  player.skillLastHand[def.id] = engine.round;
  if (def.limited === LIMITED) {
    player.skillMatchUsed ||= Object.create(null);
    player.skillMatchUsed[def.id] = true;
  }
  if (!def.limited) {
    const copyableIds = new Set([
      'zhugeliang_kongcheng', 'diaochan_lianhuan', 'hanxin_andu',
      'wuzetian_linchao', 'wangzhaojun_zhige', 'muguiying_pozhen',
      'change_qinghui',
    ]);
    state(engine).copiedActives.push({
      skillId: def.id, name: def.name, heroName: player.hero.name,
      sourceIdx: player.idx, limited: false, copyable: copyableIds.has(def.id),
    });
  }
}

function rankInBand(rank, band) {
  return band === 'low' ? rank <= 6 : band === 'mid' ? rank >= 7 && rank <= 10 : rank >= 11;
}

function escrow(engine, from, amount) {
  const paid = Math.min(from.hp, roundChip(amount));
  from.hp -= paid;
  engine.emit('onHpChange', from.idx);
  return paid;
}

function resolvePredictionStake(engine, player, def, selection, exact) {
  const target = engine.players[selection.targetIdx];
  if (!target) return false;
  const unit = bb(engine);
  const targetStake = escrow(engine, target, unit * 5);
  const ownerStake = escrow(engine, player, unit * (exact ? 2.5 : 2));
  state(engine).predictions.push({
    skillId: def.id, ownerIdx: player.idx, targetIdx: target.idx, choice: selection.choice,
    exact, targetStake, ownerStake, resolved: false,
  });
  engine.emit('onSkillPublicResult', player.idx, {
    kind: 'prediction_declared', targetIdx: target.idx, choice: selection.choice, exact,
  });
  return true;
}

function immediateRaise(engine, player, ratio) {
  const opts = engine.getOptions(player);
  if (!opts.canRaise) return false;
  const pot = engine.totalPot();
  const inc = Math.max(engine.minRaiseInc, roundChip(pot * ratio));
  engine.playerAct({ type: 'raise', tier: { key: 'skillRaise', name: '技能强攻', inc, cost: opts.toCall + inc } });
  return true;
}

function sellInsurance(engine, seller, def, selection) {
  const offer = state(engine).insuranceOffer;
  const buyer = engine.players[selection.targetIdx];
  if (!offer || !buyer || !offer.buyers.includes(buyer.idx)) return false;
  const opponents = Math.max(1, engine.activePlayers().length - 1);
  const equity = WinRate.estimate(buyer.hole, engine.revealedBoard(), opponents, Math.max(360, Config.AI_SIMS));
  if (!(equity > 0.5)) return false;
  const risk = Math.max(0, Math.min(buyer.betRound, ...engine.activePlayers()
    .filter((p) => p.idx !== buyer.idx).map((p) => p.betRound)));
  const priorCoverage = state(engine).insurance
    .filter((contract) => contract.buyerIdx === buyer.idx).reduce((sum, item) => sum + item.coverageAmount, 0);
  const coverageAmount = roundChip(Math.max(0, risk - priorCoverage) * Number(selection.coverage || 0));
  if (!coverageAmount) return false;
  const premium = escrow(engine, buyer, coverageAmount * (1 - equity));
  seller.hp += premium;
  const locked = escrow(engine, seller, coverageAmount);
  if (locked < coverageAmount) {
    seller.hp += locked;
    buyer.hp += premium;
    engine.emit('onHpChange', seller.idx);
    engine.emit('onHpChange', buyer.idx);
    return false;
  }
  state(engine).insurance.push({
    skillId: def.id, sellerIdx: seller.idx, buyerIdx: buyer.idx,
    coverageAmount, premium, equity, resolved: false,
  });
  if (def.id === 'lvbuwei_qihuo') {
    state(engine).insuranceOffer.secondTranche = false;
    state(engine).insuranceOffer.secondTranchePending = true;
  } else {
    state(engine).insuranceOffer.secondTranche = false;
    state(engine).insuranceOffer.secondTranchePending = false;
  }
  engine.emit('onSkillPublicResult', seller.idx, {
    kind: 'insurance', buyerIdx: buyer.idx, coverageAmount, premium, equity: Math.round(equity * 100),
  });
  return true;
}

/**
 * Opens the dedicated fair-insurance window after an all-in reveal. It exposes
 * only eligible buyer seat ids; exact equity remains server-side.
 */
export function openInsuranceOffer(engine, entrants = engine.activePlayers()) {
  const seller = entrants.find((player) => player.hero.id === 'lvbuwei'
    && player.alive && !player.folded && player.hp > 0
    && !matchUsed(player, 'lvbuwei_qihuo'));
  if (!seller || engine.revealed >= 5 || entrants.length < 2) return false;
  const buyers = entrants.filter((buyer) => {
    if (buyer.idx === seller.idx) return false;
    const opponents = Math.max(1, entrants.length - 1);
    return WinRate.estimate(
      buyer.hole,
      engine.revealedBoard(),
      opponents,
      Math.max(360, Config.AI_SIMS),
    ) > 0.5;
  }).map((buyer) => buyer.idx);
  if (!buyers.length) return false;
  state(engine).insuranceOffer = {
    sellerIdx: seller.idx,
    buyers,
    round: engine.round,
    street: engine.street,
    secondTranche: false,
    secondTranchePending: false,
  };
  engine.emit('onInsuranceWindow', {
    sellerIdx: seller.idx,
    buyers: [...buyers],
    phase: 'first',
    seconds: 6,
  });
  if (!seller.isHuman) {
    engine.delay(0.25, () => executeActiveSkill(engine, seller, {
      targetIdx: buyers[0], coverage: 0.5,
    }, 'lvbuwei_qihuo'));
  }
  return true;
}

export function hasOpenInsuranceWindow(engine) {
  const offer = state(engine).insuranceOffer;
  if (!offer || offer.round !== engine.round) return false;
  const seller = engine.players[offer.sellerIdx];
  if (!seller?.alive || seller.folded) return false;
  if (offer.secondTranche) return !matchUsed(seller, 'lvbuwei_shangdao');
  return !matchUsed(seller, 'lvbuwei_qihuo');
}

function applyCopiedSkill(engine, player, copied) {
  if (!copied) return false;
  const source = getSkill(copied.skillId);
  const scale = 0.7;
  switch (source?.id) {
    case 'zhugeliang_kongcheng':
      state(engine).streetRule = {
        type: 'firstSizingLock', ownerIdx: player.idx, ratio: 0.33,
        street: engine.street, copied: true,
      };
      return true;
    case 'diaochan_lianhuan': {
      const targetIdx = player.skillData.consecutiveAttackerIdx;
      if (!targetIdx) return false;
      engine.players[targetIdx].skillData.nextStreetSizingLock = {
        ratio: 0.33,
        sourceStreet: engine.street,
        activateStreet: nextStreet(engine.street),
        sourceIdx: player.idx,
        skillId: 'huamulan_yizhuang',
        copied: true,
      };
      return true;
    }
    case 'hanxin_andu':
    case 'muguiying_pozhen':
      pressureResponders(engine, player, Math.round(5 * scale));
      return immediateRaise(engine, player, 0.8 * scale);
    case 'wuzetian_linchao':
      state(engine).streetRule = {
        type: 'fixedSizing', ownerIdx: player.idx, ratio: 0.5 * scale,
        street: engine.street, copied: true,
      };
      return true;
    case 'wangzhaojun_zhige':
      state(engine).streetRule = {
        type: 'peaceCap', ownerIdx: player.idx, ratio: 0.5 * scale,
        street: engine.street, raises: 0, copied: true,
      };
      return true;
    case 'change_qinghui':
      player.skillData.qinghui = { protected: true, nextTurnBonus: Math.round(8 * scale) };
      return true;
    default:
      return false;
  }
}

export function executeActiveSkill(engine, player, selection = null, skillId = null) {
  const availability = getSkillAvailability(engine, player, skillId);
  if (!availability.ok) return false;
  const def = availability.skill;
  const prompt = getSkillInput(engine, player, def.id);
  const chosen = validSelection(prompt, selection, engine, player);
  if (prompt && !chosen) return false;

  markUse(engine, player, def);
  announce(engine, player, def, 'cast');
  if (chosen?.targetIdx != null) {
    const target = engine.players[chosen.targetIdx];
    if (isSkillTargetBlocked(engine, player, target, def)) {
      engine.emit('onSkillPublicResult', player.idx, {
        kind: 'skill_blocked', targetIdx: target.idx, skillName: def.name,
      });
      announce(engine, target, getHeroSkills(target.hero).find((item) =>
        ['change_yueyin', 'lianpo_laolian', 'huamulan_bianzhen'].includes(item.id)), 'effect', `抵消【${def.name}】`);
      return true;
    }
  }
  const s = state(engine);
  let success = true;
  switch (def.id) {
    case 'zhugeliang_guanxing': {
      const card = engine.board[engine.revealed];
      const suits = String(chosen.suitPair).split('').map(Number);
      engine.emit('onSkillResult', player.idx, {
        kind: 'range_read', rankBand: chosen.rankBand, suitPair: chosen.suitPair,
        rankHit: rankInBand(card.rank, chosen.rankBand), suitHit: suits.includes(card.suit),
      });
      break;
    }
    case 'zhugeliang_kongcheng':
      s.streetRule = { type: 'firstSizingLock', ownerIdx: player.idx, ratio: Number(chosen.ratio), street: engine.street };
      engine.playerAct({ type: 'check' });
      break;
    case 'diaochan_lianhuan':
      engine.players[player.skillData.consecutiveAttackerIdx].skillData.nextStreetSizingLock = {
        ratio: Number(chosen.ratio),
        sourceStreet: engine.street,
        activateStreet: nextStreet(engine.street),
        sourceIdx: player.idx,
        skillId: def.id,
      };
      break;
    case 'hanxin_andu':
    case 'muguiying_pozhen':
      pressureResponders(engine, player, 5);
      success = immediateRaise(engine, player, 0.8);
      break;
    case 'xiangyu_pofu':
      s.markedAllIn = { ownerIdx: player.idx, callerIds: new Set(), ratio: 0.15 };
      player.skillData.xiangyuMarked = true;
      engine.playerAct({ type: 'allin' });
      break;
    case 'lvbuwei_qihuo':
    case 'lvbuwei_shangdao':
      success = sellInsurance(engine, player, def, chosen);
      break;
    case 'wuzetian_linchao':
      s.streetRule = { type: 'fixedSizing', ownerIdx: player.idx, ratio: 0.5, street: engine.street };
      break;
    case 'huamulan_yizhuang': {
      const copied = s.copiedActives.find((item) => item.skillId === chosen.copySkillId);
      player.skillData.copiedSkill = copied ? { ...copied, scale: 0.7 } : null;
      success = applyCopiedSkill(engine, player, copied);
      engine.emit('onSkillResult', player.idx, { kind: 'copy_active', skillName: copied?.name, scale: 0.7 });
      break;
    }
    case 'xishi_huansha': {
      const target = engine.players[previousAction(engine, player)?.actorIdx];
      if (!target) { success = false; break; }
      const board = engine.revealedBoard();
      const all = [...target.hole, ...board];
      const clues = [];
      if (target.hole.some((c) => c.rank >= 11)) clues.push('至少一张暗令为J或更高');
      if (target.hole[0]?.suit === target.hole[1]?.suit) clues.push('两张暗令同花');
      const category = engine.revealed >= 3 ? (target.lastHandCategory || 1) : 1;
      if (category >= 2) clues.push('当前已经成对或更好');
      const suitCounts = new Map();
      all.forEach((c) => suitCounts.set(c.suit, (suitCounts.get(c.suit) || 0) + 1));
      if ([...suitCounts.values()].some((count) => count === 4)) clues.push('存在同花听牌');
      const clue = clues.length ? clues[Math.floor(engine.rng() * clues.length)] : '未发现高张、同花、成牌或明显听牌';
      engine.emit('onSkillResult', player.idx, { kind: 'true_clue', targetIdx: target.idx, clue });
      break;
    }
    case 'wangzhaojun_zhige':
      s.streetRule = { type: 'peaceCap', ownerIdx: player.idx, ratio: 0.5, street: engine.street, raises: 0 };
      break;
    case 'shangguanwaner_luobi':
      success = resolvePredictionStake(engine, player, def, chosen, false);
      break;
    case 'liqingzhao_rumeng':
      player.skillData.hedgedCall = { bettorIdx: previousAction(engine, player)?.actorIdx, callAmount: engine.getOptions(player).callAmt };
      engine.playerAct({ type: 'call' });
      break;
    case 'fuhao_zhenbu':
      success = resolvePredictionStake(engine, player, def, chosen, true);
      break;
    case 'nvwa_zaohua': {
      const index = Number(chosen.cardIndex) - 1;
      const old = player.hole[index];
      const replacement = engine.deck.pop();
      if (!old || !replacement) { success = false; break; }
      player.hole[index] = replacement;
      player.skillData.burnedCard = old;
      engine.emit('onHoleChange', player.idx);
      engine.emit('onSkillPublicResult', player.idx, { kind: 'card_replaced', cardIndex: index + 1 });
      break;
    }
    case 'change_qinghui':
      player.skillData.qinghui = { protected: true, nextTurnBonus: 8 };
      engine.playerAct({ type: chosen.choice });
      break;
    default:
      break;
  }
  if (!success) {
    // A failed precondition never consumes the use.
    delete player.skillData.used[def.id];
    if (def.limited === LIMITED) delete player.skillMatchUsed[def.id];
    player.skillUsed = Object.keys(player.skillData.used).length > 0;
    return false;
  }
  return true;
}

function actionBand(entry) {
  if (!entry?.isAggressive || !(entry.potBefore > 0)) return null;
  const ratio = entry.amount / entry.potBefore;
  return ratio <= 0.4 ? 'small' : ratio <= 0.75 ? 'medium' : 'large';
}

function triggerPassive(engine, player, id, detail = '') {
  const def = getSkill(id);
  if (!def || handUsed(player, id) || (def.limited === LIMITED && matchUsed(player, id))) return false;
  player.skillData.used[id] = true;
  if (def.limited === LIMITED) {
    player.skillMatchUsed ||= Object.create(null);
    player.skillMatchUsed[id] = true;
  }
  announce(engine, player, def, 'passive', detail);
  return true;
}

function triggerStreetPassive(engine, player, id, detail = '') {
  const def = getSkill(id);
  if (!def || (def.limited === LIMITED && matchUsed(player, id))) return false;
  player.skillData.streetUsed ||= Object.create(null);
  const token = `${engine.round}:${engine.street}`;
  if (player.skillData.streetUsed[id] === token) return false;
  player.skillData.streetUsed[id] = token;
  player.skillData.used[id] = true;
  announce(engine, player, def, 'passive', detail);
  return true;
}

function resolvePredictions(engine, payload) {
  for (const bet of state(engine).predictions) {
    if (bet.resolved || bet.targetIdx !== payload.actor.idx) continue;
    const actual = bet.exact ? payload.key : ACTION_GROUPS[payload.key] || payload.group;
    const correct = actual === bet.choice;
    const owner = engine.players[bet.ownerIdx];
    const target = engine.players[bet.targetIdx];
    if (correct) {
      owner.hp += bet.ownerStake + bet.targetStake;
      owner.skillData.predictionCorrect = true;
    } else {
      target.hp += bet.targetStake + bet.ownerStake;
    }
    bet.resolved = true;
    engine.emit('onHpChange', owner.idx);
    engine.emit('onHpChange', target.idx);
    const def = getSkill(bet.skillId);
    announce(engine, owner, def, 'effect', correct ? `预测正确，获得${bet.targetStake}` : `预测错误，支付${bet.ownerStake}`);
    engine.emit('onSkillPublicResult', owner.idx, {
      kind: 'prediction_result', targetIdx: target.idx, correct, actual,
    });
  }
}

function observeActionPassives(engine, payload) {
  const actor = payload.actor;
  const entry = engine.actionHistory[engine.actionHistory.length - 1];
  resolvePredictions(engine, { ...payload, key: entry?.key || payload.type });
  if (payload.group === 'attack') {
    for (const target of engine.activePlayers()) {
      if (target.idx === actor.idx) continue;
      target.skillData.attackersByStreet ||= Object.create(null);
      const prior = target.skillData.lastAttacker;
      target.skillData.attackersByStreet[engine.street] = actor.idx;
      if (prior?.idx === actor.idx && prior.street !== engine.street) {
        target.skillData.consecutiveAttackerIdx = actor.idx;
      }
      target.skillData.lastAttacker = { idx: actor.idx, street: engine.street };
      if (target.hero.id === 'diaochan' && engine.previousTopWinnerIdx === actor.idx
        && !handUsed(target, 'diaochan_biyue')) {
        target.skillData.nextTimeBonus = (target.skillData.nextTimeBonus || 0) + 6;
        actor.skillData.nextTimePenalty = (actor.skillData.nextTimePenalty || 0) + 6;
        triggerPassive(engine, target, 'diaochan_biyue', '一进一退，夺走对手6秒');
      }
    }
    if (actor.skillData.predictionCorrect && actor.hero.id === 'fuhao') {
      pressureResponders(engine, actor, 5);
      triggerPassive(engine, actor, 'fuhao_zhengfa', '卦成兵动，应对者-5秒');
      actor.skillData.zhengfaSettlement = true;
    }
  }

  if (actor.hero.id === 'xiangyu' && payload.type === 'allin' && payload.group === 'attack') {
    const actorStackBefore = Number(entry?.actorStackBefore || 0);
    const largestOpponentStack = Math.max(0, ...engine.activePlayers()
      .filter((player) => player.idx !== actor.idx)
      .map((player) => Number(player.hp || 0) + Number(player.betStreet || 0)));
    const effectiveStack = Math.min(actorStackBefore, largestOpponentStack);
    if (effectiveStack >= bb(engine) * 8
      && triggerStreetPassive(engine, actor, 'xiangyu_bawang', '霸王决死，应对时间缩短')) {
      pressureResponders(engine, actor, 8, null, 15);
    }
  }
  if (state(engine).markedAllIn
    && actor.idx !== state(engine).markedAllIn.ownerIdx
    && ['call', 'allin'].includes(payload.type)) {
    state(engine).markedAllIn.callerIds.add(actor.idx);
  }

  const group = payload.group === 'attack' ? 'attack' : 'defense';
  const previousGroup = actor.skillData.lastActionGroup;
  if (actor.hero.id === 'huamulan' && previousGroup && previousGroup !== group
    && !handUsed(actor, 'huamulan_bianzhen')) {
    if (previousGroup === 'attack') actor.skillData.blockNextTargetedSkill = true;
    else pressureResponders(engine, actor, 5);
    triggerPassive(engine, actor, 'huamulan_bianzhen', previousGroup === 'attack' ? '卸势藏锋' : '变阵突击');
  }
  actor.skillData.lastActionGroup = group;

  if (payload.group === 'attack') {
    for (const target of engine.activePlayers()) {
      if (target.idx === actor.idx) continue;
      if (target.hero.id === 'wuzetian'
        && target.skillData.consecutiveAttackerIdx === actor.idx
        && !handUsed(target, 'wuzetian_zhiheng')) {
        actor.skillData.nextStreetSizingLock = {
          ratio: 0.5,
          sourceStreet: engine.street,
          activateStreet: nextStreet(engine.street),
          sourceIdx: target.idx,
          skillId: 'wuzetian_zhiheng',
        };
        actor.skillData.nextTimePenalty = (actor.skillData.nextTimePenalty || 0) + 5;
        triggerPassive(engine, target, 'wuzetian_zhiheng', '连续犯驾，下次进攻受限');
      }
    }
  }

  const peace = state(engine).streetRule;
  if (payload.type === 'allin' && peace?.type === 'peaceCap'
    && peace.street === engine.street && peace.ownerIdx !== actor.idx) {
    const owner = engine.players[peace.ownerIdx];
    if (owner?.hero.id === 'wangzhaojun' && owner.alive && !owner.folded
      && !matchUsed(owner, 'wangzhaojun_heming')) {
      owner.skillData.nextTimeBonus = (owner.skillData.nextTimeBonus || 0) + 10;
      actor.skillData.nextTimePenalty = (actor.skillData.nextTimePenalty || 0) + 5;
      owner.skillData.hemingBettorIdx = actor.idx;
      triggerPassive(engine, owner, 'wangzhaojun_heming', '决死入曲，双方时限改变');
    }
  }
  if (actor.hero.id === 'wangzhaojun' && actor.skillData.hemingBettorIdx) {
    actor.skillData.hemingFollowed = ['call', 'allin'].includes(payload.type);
  }

  if (entry?.isAggressive) {
    actor.skillData.sizingHistory ||= [];
    actor.skillData.sizingHistory.push({ street: engine.street, band: actionBand(entry) });
    const history = actor.skillData.sizingHistory;
    if (history.length >= 2 && history.at(-1).band === history.at(-2).band
      && history.at(-1).street !== history.at(-2).street) {
      for (const watcher of engine.activePlayers().filter((p) => p.hero.id === 'shangguanwaner')) {
        watcher.skillData.nextTimeBonus = (watcher.skillData.nextTimeBonus || 0) + 8;
        triggerPassive(engine, watcher, 'shangguanwaner_wenxin', '识破重复尺度，思考时间+8秒');
      }
    }
  }
}

export function dispatchSkillEvent(engine, eventName, payload = {}) {
  if (!engine.skillsEnabled) return;
  switch (eventName) {
    case 'ACTION':
      observeActionPassives(engine, payload);
      break;
    case 'BOARD_REVEALED':
      if (payload.street === 'flop' && engine.activePlayers().length >= 3) {
        for (const player of engine.activePlayers().filter((p) => p.hero.id === 'muguiying')) {
          player.skillData.guashuaiActive = true;
          triggerPassive(engine, player, 'muguiying_guashuai', '多人入阵，每次行动+6秒');
        }
      }
      if (state(engine).insuranceOffer?.secondTranchePending && engine.revealed < 5) {
        state(engine).insuranceOffer.secondTranchePending = false;
        state(engine).insuranceOffer.secondTranche = true;
        state(engine).insuranceOffer.street = engine.street;
        engine.emit('onInsuranceWindow', {
          sellerIdx: state(engine).insuranceOffer.sellerIdx,
          buyers: [...state(engine).insuranceOffer.buyers],
          phase: 'second',
          seconds: 6,
        });
        const seller = engine.players[state(engine).insuranceOffer.sellerIdx];
        if (seller && !seller.isHuman) {
          engine.delay(0.25, () => executeActiveSkill(engine, seller, {
            targetIdx: state(engine).insuranceOffer?.buyers?.[0],
            coverage: 0.5,
          }, 'lvbuwei_shangdao'));
        }
      }
      break;
    default:
      break;
  }
}

export function getSkillActionSeconds(engine, player, base = Config.ACTION_TIME) {
  let value = Number(base) || Config.ACTION_TIME;
  const immune = player.hero.id === 'liqingzhao' && player.skillData?.shengshengActive
    || player.skillData?.qinghui?.protected;
  if (!immune) {
    value -= Number(player.skillData?.nextTimePenalty || 0);
  }
  value += Number(player.skillData?.nextTimeBonus || 0);
  if (player.skillData?.guashuaiActive) value += 6;
  if (player.skillData?.qinghui?.nextTurnBonus) {
    value += player.skillData.qinghui.nextTurnBonus;
    player.skillData.qinghui = null;
  }
  player.skillData.nextTimePenalty = 0;
  player.skillData.nextTimeBonus = 0;
  return Math.max(8, Math.min(45, Math.round(value)));
}

export function applySkillOptions(engine, player, opts) {
  if (!engine.skillsEnabled || !opts) return opts;
  const s = state(engine);
  let ratio = null;
  if (s.streetRule?.street === engine.street) {
    if (s.streetRule.type === 'fixedSizing') ratio = s.streetRule.ratio;
    if (s.streetRule.type === 'peaceCap') {
      opts.tiers = opts.tiers.filter((tier) => tier.inc <= engine.totalPot() * s.streetRule.ratio + 1);
      if (s.streetRule.raises >= 1) opts.tiers = [];
    }
    if (s.streetRule.type === 'firstSizingLock' && !s.streetRule.consumed) ratio = s.streetRule.ratio;
  }
  const lock = player.skillData?.nextStreetSizingLock;
  if (lock && lock.activateStreet === engine.street) ratio = lock.ratio;
  if (ratio != null && opts.canRaise) {
    const inc = Math.max(engine.minRaiseInc, roundChip(engine.totalPot() * ratio));
    if (opts.toCall + inc < player.hp) {
      opts.tiers = [{ key: 'skillRatio', name: `${Math.round(ratio * 100)}%定式`, inc, cost: opts.toCall + inc }];
    } else opts.tiers = [];
  }
  return opts;
}

export function notifySkillActionApplied(engine, player, act) {
  const s = state(engine);
  if (act.type === 'raise') {
    if (s.streetRule?.type === 'firstSizingLock' && s.streetRule.street === engine.street) {
      s.streetRule.consumed = true;
      announce(engine, engine.players[s.streetRule.ownerIdx], getSkill('zhugeliang_kongcheng'), 'effect', '定式落下');
    }
    if (s.streetRule?.type === 'peaceCap' && s.streetRule.street === engine.street) s.streetRule.raises++;
    const sizingLock = player.skillData.nextStreetSizingLock;
    if (sizingLock?.activateStreet === engine.street) {
      const source = engine.players[sizingLock.sourceIdx];
      announce(engine, source, getSkill(sizingLock.skillId || 'diaochan_lianhuan'), 'effect', '锁定下注尺度');
      player.skillData.nextStreetSizingLock = null;
    }
  }
}

function transfer(engine, from, to, wanted, ledger, reason, def) {
  if (!from || !to || from.idx === to.idx) return 0;
  const amount = Math.min(Math.max(0, from.hp), roundChip(wanted));
  if (!amount) return 0;
  from.hp -= amount;
  to.hp += amount;
  ledger[from.idx] = (ledger[from.idx] || 0) - amount;
  ledger[to.idx] = (ledger[to.idx] || 0) + amount;
  engine.emit('onHpChange', from.idx);
  engine.emit('onHpChange', to.idx);
  if (def) announce(engine, to, def, 'effect', `${reason}，转移${amount}`);
  return amount;
}

function distributeByWeight(engine, payers, receiver, total, ledger, reason, def, weightOf) {
  const active = payers.filter((p) => p && p.hp > 0);
  const weightTotal = active.reduce((sum, p) => sum + Math.max(0, weightOf(p)), 0);
  if (!weightTotal || !total) return 0;
  let paid = 0;
  active.forEach((payer, index) => {
    const wanted = index === active.length - 1
      ? Math.max(0, total - paid)
      : total * Math.max(0, weightOf(payer)) / weightTotal;
    paid += transfer(engine, payer, receiver, wanted, ledger, reason, index === 0 ? def : null);
  });
  return paid;
}

function distributeToReceivers(engine, payer, receivers, total, ledger, reason, def, weightOf) {
  if (!payer || payer.hp <= 0) return 0;
  const eligible = receivers.filter((player) => player && player.idx !== payer.idx);
  const weightTotal = eligible.reduce((sum, player) => sum + Math.max(0, weightOf(player)), 0);
  if (!weightTotal || !total) return 0;
  const payable = Math.min(Math.max(0, payer.hp), roundChip(total));
  let paid = 0;
  eligible.forEach((receiver, index) => {
    const wanted = index === eligible.length - 1
      ? Math.max(0, payable - paid)
      : payable * Math.max(0, weightOf(receiver)) / weightTotal;
    paid += transfer(engine, payer, receiver, wanted, ledger, reason, index === 0 ? def : null);
  });
  return paid;
}

function categoryGapQualifies(loser, winners) {
  if (!loser.showdownInfo) return false;
  return winners.some((winner) => winner.showdownInfo
    && (winner.showdownInfo.cat - loser.showdownInfo.cat === 1
      || winner.showdownInfo.cat === loser.showdownInfo.cat));
}

export function settleSkillAdjustments(engine, context) {
  if (!engine.skillsEnabled) return { ledger: {}, netResult: context.netResult };
  const base = { ...context.netResult };
  const ledger = {};
  const players = engine.players.slice(1);
  const winners = players.filter((p) => (base[p.idx] || 0) > 0);
  const losers = players.filter((p) => (base[p.idx] || 0) < 0);
  const s = state(engine);

  for (const bet of s.predictions) {
    if (bet.resolved) continue;
    const owner = engine.players[bet.ownerIdx];
    const target = engine.players[bet.targetIdx];
    if (owner) owner.hp += bet.ownerStake;
    if (target) target.hp += bet.targetStake;
    if (owner) engine.emit('onHpChange', owner.idx);
    if (target) engine.emit('onHpChange', target.idx);
    bet.resolved = true;
    if (owner) {
      announce(engine, owner, getSkill(bet.skillId), 'effect', '目标未行动，双方托管原额退回');
    }
  }

  for (const player of players) {
    const net = Number(base[player.idx] || 0);
    if (!net) continue;
    if (player.hero.id === 'hanxin' && player.skillData.hanxinBackwater) {
      triggerPassive(engine, player, 'hanxin_beishui');
      const def = getSkill('hanxin_beishui');
      if (net > 0) {
        const cap = losers.reduce((sum, p) => sum + p.hp, 0) * 0.2;
        distributeByWeight(engine, losers, player, Math.min(net * 0.12, cap), ledger,
          '背水胜势', def, (p) => -base[p.idx]);
      } else {
        const extra = Math.min(-net * 0.12, player.hp * 0.2);
        distributeToReceivers(engine, player, winners, extra, ledger,
          '背水败势', def, (winner) => base[winner.idx]);
      }
    }
  }

  if (s.markedAllIn) {
    const owner = engine.players[s.markedAllIn.ownerIdx];
    const participants = [owner, ...[...s.markedAllIn.callerIds].map((idx) => engine.players[idx])].filter(Boolean);
    const participantWinners = participants.filter((p) => (base[p.idx] || 0) > 0);
    const participantLosers = participants.filter((p) => (base[p.idx] || 0) < 0);
    for (const receiver of participantWinners) {
      distributeByWeight(engine, participantLosers, receiver, base[receiver.idx] * 0.15, ledger,
        '破釜沉舟', getSkill('xiangyu_pofu'), (p) => -base[p.idx]);
    }
  }

  for (const player of players) {
    const net = Number(base[player.idx] || 0);
    if (player.hero.id === 'xishi' && player.skillData.riverCallBettorIdx) {
      const bettor = engine.players[player.skillData.riverCallBettorIdx];
      if (net > 0 && bettor?.showdownInfo?.cat === 1) {
        transfer(engine, bettor, player, net * 0.1, ledger, '沉鱼识破高牌', getSkill('xishi_chenyu'));
      } else if (net < 0) {
        transfer(engine, player, bettor, -net * 0.05, ledger, '沉鱼误判', getSkill('xishi_chenyu'));
      }
    }
    if (player.hero.id === 'liqingzhao' && player.skillData.hedgedCall) {
      const bettor = engine.players[player.skillData.hedgedCall.bettorIdx];
      if (net < 0) transfer(engine, bettor, player, player.skillData.hedgedCall.callAmount * 0.2,
        ledger, '如梦令止损', getSkill('liqingzhao_rumeng'));
      else if (net > 0) transfer(engine, player, bettor, net * 0.1,
        ledger, '如梦令分润', getSkill('liqingzhao_rumeng'));
    }
    if (player.hero.id === 'fuhao' && player.skillData.zhengfaSettlement && net > 0) {
      const each = net * 0.05 / Math.max(1, losers.length);
      for (const loser of losers) transfer(engine, loser, player, each, ledger,
        '征伐均摊', getSkill('fuhao_zhengfa'));
    }
    if (player.hero.id === 'wangzhaojun' && player.skillData.hemingFollowed
      && player.skillData.hemingBettorIdx && net < 0) {
      const bettor = engine.players[player.skillData.hemingBettorIdx];
      if ((base[bettor?.idx] || 0) > 0) {
        transfer(engine, bettor, player, -net * 0.1, ledger,
          '和鸣返还', getSkill('wangzhaojun_heming'));
      }
    }
    if (player.hero.id === 'muguiying' && player.skillData.guashuaiActive) {
      if (net > 0) distributeByWeight(engine, losers, player, net * 0.08, ledger,
        '挂帅增益', getSkill('muguiying_guashuai'), (p) => -base[p.idx]);
      else if (net < 0) distributeToReceivers(engine, player, winners, -net * 0.08, ledger,
        '挂帅风险', getSkill('muguiying_guashuai'), (winner) => base[winner.idx]);
    }
    if (player.hero.id === 'nvwa' && net < 0 && categoryGapQualifies(player, winners)
      && !matchUsed(player, 'nvwa_butian')) {
      triggerPassive(engine, player, 'nvwa_butian', '五色石补回败势');
      distributeByWeight(engine, winners, player, -net * 0.1, ledger,
        '补天返还', getSkill('nvwa_butian'), (p) => base[p.idx]);
    }
    if (player.hero.id === 'lianpo' && net < 0 && !player.skillData.raisedThisRound
      && potBb(engine) >= 10 && engine.round - Number(player.skillLastTrigger?.lianpo_jianbi || -9) > 1) {
      const voluntaryLoss = Math.max(0, player.betRound - bb(engine) * 1.5);
      const refund = Math.min(voluntaryLoss * 0.1, bb(engine) * 1.5);
      if (refund > 0) {
        triggerPassive(engine, player, 'lianpo_jianbi', '坚壁承压，相关赢家返还');
        distributeByWeight(engine, winners, player, refund, ledger,
          '坚壁清野', getSkill('lianpo_jianbi'), (p) => base[p.idx]);
        player.skillLastTrigger ||= Object.create(null);
        player.skillLastTrigger.lianpo_jianbi = engine.round;
      }
    }
  }

  for (const contract of s.insurance) {
    if (contract.resolved) continue;
    const buyerNet = Number(base[contract.buyerIdx] || 0);
    const seller = engine.players[contract.sellerIdx];
    const buyer = engine.players[contract.buyerIdx];
    const shareLoss = buyerNet < 0 ? 1 : buyerNet === 0 ? 0.5 : 0;
    const payout = roundChip(contract.coverageAmount * shareLoss);
    buyer.hp += payout;
    seller.hp += contract.coverageAmount - payout;
    ledger[buyer.idx] = (ledger[buyer.idx] || 0) + payout - contract.premium;
    ledger[seller.idx] = (ledger[seller.idx] || 0) + contract.premium - payout;
    contract.resolved = true;
    engine.emit('onHpChange', buyer.idx);
    engine.emit('onHpChange', seller.idx);
    announce(engine, seller, getSkill(contract.skillId), 'effect', `保险结算，赔付${payout}`);
  }

  const netResult = { ...base };
  for (const [idx, amount] of Object.entries(ledger)) netResult[idx] = (netResult[idx] || 0) + amount;
  const ranked = Object.entries(base).sort((a, b) => b[1] - a[1]);
  engine.previousTopWinnerIdx = ranked[0]?.[1] > 0 ? Number(ranked[0][0]) : 0;
  for (const player of players) {
    const net = Number(base[player.idx] || 0);
    if (player.hero.id === 'liqingzhao') {
      player.skillLossStreak = net < 0 ? (player.skillLossStreak || 0) + 1 : 0;
      player.skillData.shengshengActive = player.skillLossStreak >= 2;
      if (player.skillData.shengshengActive) triggerPassive(engine, player, 'liqingzhao_shengsheng', '连败守心');
    }
  }
  return { ledger, netResult };
}

export function isSkillTargetBlocked(engine, source, target, def) {
  if (!target || source.idx === target.idx) return false;
  if (target.skillData?.qinghui?.protected) return true;
  if (target.skillData?.blockNextTargetedSkill) {
    target.skillData.blockNextTargetedSkill = false;
    return true;
  }
  if (target.hero.id === 'change' && !matchUsed(target, 'change_yueyin')) {
    triggerPassive(engine, target, 'change_yueyin', `抵消【${def.name}】`);
    return true;
  }
  if (target.hero.id === 'lianpo' && !target.skillData.raisedThisRound
    && !matchUsed(target, 'lianpo_laolian')) {
    triggerPassive(engine, target, 'lianpo_laolian', `抵消【${def.name}】`);
    return true;
  }
  return false;
}

export function checkSkillCondition(_condition, _context) {
  // 保留公共 API；V2 条件由 availability 中的可审计规则判定。
  return true;
}

export function resetRoundSkillState(player) {
  player.skillUsed = false;
  player.skillStatuses = [];
  player.passiveUsed = Object.create(null);
  player.skillData = {
    used: Object.create(null),
    flags: Object.create(null),
    raisedThisRound: false,
    lastActionGroup: null,
    sizingHistory: [],
    nextTimeBonus: 0,
    nextTimePenalty: 0,
    nextExtendSeconds: null,
    currentExtendSeconds: null,
    streetUsed: Object.create(null),
    consecutiveAttackerIdx: null,
    lastAttacker: null,
    predictionCorrect: false,
    zhengfaSettlement: false,
    hanxinBackwater: false,
    xiangyuMarked: false,
    qinghui: null,
    guashuaiActive: false,
    hemingBettorIdx: 0,
    hemingFollowed: false,
  };
}
