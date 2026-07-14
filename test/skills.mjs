// 声明式技能框架测试：配置完整性、发动条件、扑克核心不可变与事件结算。
import { Engine } from '../js/game/engine.js';
import { HEROES } from '../js/game/heroes.js';
import {
  SKILLS,
  checkSkillCondition,
  dispatchSkillEvent,
  getActiveSkill,
  getPassiveSkill,
} from '../js/game/skills.js';

const assert = (condition, message) => {
  if (!condition) throw new Error('技能框架断言失败: ' + message);
};
const C = (rank, suit) => ({ rank, suit });
const clone = (value) => JSON.stringify(value);

const allowedOps = new Set([
  'PEEK_NEXT_BOARD',
  'PEEK_RANDOM_HOLE',
  'PEEK_NEXT_BOARD_SUIT',
  'PEEK_STRENGTH_BAND',
  'REVEAL_SELF_HOLE',
  'APPLY_STATUS',
  'APPLY_STATUS_TO_TARGET',
  'APPLY_ACTION_PREDICTION',
  'APPLY_BOARD_COLOR_PREDICTION',
  'APPLY_SHOWDOWN_TIER_PREDICTION',
  'COPY_TARGET_PASSIVE',
  'SET_ROUND_FLAG',
  'ENERGY_CHANGE',
  'HP_REBATE',
]);
const forbiddenOps = new Set([
  'DRAW_CARD',
  'REPLACE_CARD',
  'SHUFFLE_DECK',
  'MODIFY_HAND_SCORE',
  'MODIFY_POT',
  'FORCE_ACTION',
  'BLOCK_RAISE',
]);

function walkEffects(effects, owner) {
  for (const effect of effects || []) {
    assert(allowedOps.has(effect.op), `${owner} 使用未登记操作码 ${effect.op}`);
    assert(!forbiddenOps.has(effect.op), `${owner} 使用禁止操作码 ${effect.op}`);
    if (effect.status) walkEffects(effect.status.effects, owner);
  }
}

for (const hero of HEROES) {
  const active = getActiveSkill(hero);
  const passive = getPassiveSkill(hero);
  assert(active && active.kind === 'active', `${hero.name} 缺少主动技能`);
  assert(passive && passive.kind === 'passive', `${hero.name} 缺少被动技能`);
  assert(active.presentation && passive.presentation, `${hero.name} 缺少表现配置`);
  walkEffects(active.effects, active.id);
  walkEffects(passive.effects, passive.id);
}
assert(HEROES.length === 16, '英雄池应包含原有六将与新增十将');
assert(Object.keys(SKILLS).length === HEROES.length * 2, '每名英雄应恰好配置主动、被动各一个');

const ids = HEROES.map((hero) => hero.id);
const engine = new Engine(ids, {}, new Set());
engine.street = 'preflop';
engine.board = [C(2, 1), C(7, 2), C(9, 3), C(11, 4), C(14, 1)];
engine.revealed = 0;
engine.deck = [C(3, 1), C(4, 2), C(5, 3)];
for (const p of engine.players.slice(1)) {
  p.folded = false;
  p.alive = true;
  p.energy = 5;
  p.skillUsed = false;
  p.skillStatuses = [];
  p.passiveUsed = Object.create(null);
  p.betRound = 0;
  p.roundStartHp = p.hp;
}

const holes = {
  zhugeliang: [C(8, 1), C(4, 3)],
  diaochan: [C(12, 2), C(3, 4)],
  hanxin: [C(8, 1), C(4, 2)],
  xiangyu: [C(11, 3), C(4, 3)],
  lvbuwei: [C(14, 1), C(10, 4)],
  lianpo: [C(8, 2), C(4, 4)],
};
for (const p of engine.players.slice(1)) p.hole = holes[p.hero.id];

const gatedPlayer = engine.players[1];
engine.actingIdx = 2;
const gatedEnergy = gatedPlayer.energy;
const gatedStatuses = gatedPlayer.skillStatuses.length;
assert(!engine.canUseSkill(gatedPlayer.idx), '别人的行动回合不得显示主动技能可用');
assert(engine.skillAvailability(gatedPlayer.idx).reason === '仅可在轮到你行动时发动',
  '非本人回合应返回明确的技能门禁原因');
assert(!engine.useSkill(gatedPlayer.idx), '别人的行动回合不得发动主动技能');
assert(gatedPlayer.energy === gatedEnergy && !gatedPlayer.skillUsed
  && gatedPlayer.skillStatuses.length === gatedStatuses, '被门禁拒绝的技能不得扣能量或写入状态');

for (const p of engine.players.slice(1)) {
  engine.actingIdx = p.idx;
  const skill = getActiveSkill(p.hero);
  assert(checkSkillCondition(skill.condition, { engine, player: p }), `${p.hero.name} 测试暗令应满足条件`);
  const coreBefore = {
    hole: clone(p.hole), board: clone(engine.board), deck: clone(engine.deck), pot: engine.totalPot(),
  };
  const selection = p.hero.id === 'lvbuwei' ? { choice: 'showdown' } : null;
  assert(engine.useSkill(p.idx, selection), `${p.hero.name} 主动技能应成功发动`);
  assert(clone(p.hole) === coreBefore.hole, `${p.hero.name} 不得修改暗令`);
  assert(clone(engine.board) === coreBefore.board, `${p.hero.name} 不得修改公共牌`);
  assert(clone(engine.deck) === coreBefore.deck, `${p.hero.name} 不得修改牌堆`);
  assert(engine.totalPot() === coreBefore.pot, `${p.hero.name} 不得修改血池`);
}

engine.actingIdx = 0;
const hanxin = engine.players.find((p) => p && p.hero.id === 'hanxin');
const hanxinEnergy = hanxin.energy;
dispatchSkillEvent(engine, 'STREET_ADVANCE', { from: 'preflop' });
assert(hanxin.energy === hanxinEnergy + 2, '韩信保持在局应兑现2能量');

const xiangyu = engine.players.find((p) => p && p.hero.id === 'xiangyu');
const xiangyuEnergy = xiangyu.energy;
dispatchSkillEvent(engine, 'UNCONTESTED_WIN', { winner: xiangyu });
assert(xiangyu.energy === xiangyuEnergy + 2, '项羽主动兑现与被动应各获得1能量');

const lvbuwei = engine.players.find((p) => p && p.hero.id === 'lvbuwei');
const lvbuweiEnergy = lvbuwei.energy;
dispatchSkillEvent(engine, 'ROUND_RESOLVED', { mode: 'showdown' });
assert(lvbuwei.energy === lvbuweiEnergy + 2, '吕不韦预测正确应获得2能量');

const lianpo = engine.players.find((p) => p && p.hero.id === 'lianpo');
lianpo.betRound = 400;
const lianpoHp = lianpo.hp;
const lianpoEnergy = lianpo.energy;
dispatchSkillEvent(engine, 'SHOWDOWN_RESULT', {
  entrantIds: new Set([lianpo.idx]),
  winnerIds: new Set(),
});
assert(lianpo.hp === lianpoHp + 40, '廉颇保险应返还10%投入');
assert(lianpo.energy === lianpoEnergy + 1, '廉颇亮招落败被动应获得1能量');

console.log('技能框架自检通过：32技能、统一操作码、扑克核心不可变、事件结算正常');

// 新框架能力：多字段目标、动态费用、公开信息、行动预测、被动复制。
const setup = (heroIds, listeners = {}) => {
  const e = new Engine(heroIds, listeners, new Set([1]));
  e.street = 'preflop';
  e.board = [C(2, 1), C(7, 2), C(9, 3), C(11, 4), C(14, 1)];
  e.revealed = 0;
  e.deck = [C(3, 1), C(4, 2), C(5, 3)];
  for (const p of e.players.slice(1)) {
    p.folded = false; p.alive = true; p.energy = 6; p.skillUsed = false;
    p.skillStatuses = []; p.passiveUsed = Object.create(null);
    p.skillData = { flags: Object.create(null), copiedPassiveIds: [], revealedCard: null, raisedThisRound: false };
    p.hole = [C(8, 1), C(4, 2)];
  }
  e.actingIdx = 1;
  return e;
};

const wuEngine = setup(['wuzetian', 'liqingzhao', 'fuhao', 'change', 'xishi', 'muguiying']);
const wu = wuEngine.players[1];
wu.hole = [C(12, 1), C(4, 2)];
const wuPrompt = wuEngine.getSkillPrompt(1);
assert(wuPrompt.fields[0].type === 'target' && wuPrompt.fields[0].options.length === 5,
  '武则天应通过统一输入框架选择五名对手');
assert(wuEngine.useSkill(1, { targetIdx: 2 }), '武则天应能对目标施加技能费用修正');
assert(wuEngine.skillAvailability(2).cost === 2, '临朝应令目标下一次技能费用增加1');

let revealed = null;
const mulanEngine = setup(['huamulan', 'wuzetian', 'xishi', 'change', 'fuhao', 'nvwa'], {
  onSkillPublicResult(idx, result) { revealed = { idx, result }; },
});
const mulan = mulanEngine.players[1];
mulan.hole = [C(9, 1), C(6, 2)];
const mulanEnergy = mulan.energy;
assert(mulanEngine.useSkill(1, { choice: 1 }), '花木兰应能公开指定暗令');
assert(revealed?.idx === 1 && revealed.result.card === mulan.hole[0], '公开暗令应通过公共结果事件广播');
assert(mulan.energy === mulanEnergy, '易装费用与返还能量应相抵');

const xishiEngine = setup(['xishi', 'wuzetian', 'fuhao', 'change', 'liqingzhao', 'muguiying']);
const xishi = xishiEngine.players[1];
xishi.hole = [C(10, 2), C(3, 1)];
const predictionStart = xishi.energy;
assert(xishiEngine.useSkill(1, { targetIdx: 2, choice: 'fold' }), '西施应接受目标与行动两个字段');
dispatchSkillEvent(xishiEngine, 'ACTION', { actor: xishiEngine.players[2], group: 'fold', activeCount: 5 });
assert(xishi.energy === predictionStart, '浣纱命中后应抵消1点发动费用');
dispatchSkillEvent(xishiEngine, 'ROUND_END', { round: 1 });
assert(xishi.energy === predictionStart + 1, '沉鱼应在预测成功的回合额外获得1能量');

const nvwaEngine = setup(['nvwa', 'lianpo', 'wuzetian', 'xishi', 'change', 'fuhao']);
const nvwa = nvwaEngine.players[1];
nvwa.hole = [C(9, 1), C(4, 1)];
const nvwaStart = nvwa.energy;
assert(nvwaEngine.useSkill(1, { targetIdx: 2 }), '女娲应能复制可复制被动');
dispatchSkillEvent(nvwaEngine, 'SHOWDOWN_RESULT', {
  entrantIds: new Set([1]), winnerIds: new Set(),
});
assert(nvwa.energy === nvwaStart - 1, '复制老练并落败应获得1能量');
dispatchSkillEvent(nvwaEngine, 'ROUND_END', { round: 1 });
assert(nvwa.energy === nvwaStart - 1, '复制被动已触发时补天不应重复返还');

console.log('新增十将框架自检通过：多字段目标、动态费用、公开信息、预测与被动复制正常');
