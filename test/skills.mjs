import assert from 'node:assert/strict';
import { Engine } from '../js/game/engine.js';
import { HEROES } from '../js/game/heroes.js';
import {
  SKILLS,
  dispatchSkillEvent,
  getActiveSkills,
  getHeroSkills,
  getPassiveSkills,
  getSkillActionSeconds,
  openInsuranceOffer,
  resetRoundSkillState,
  settleSkillAdjustments,
} from '../js/game/skills.js';

const C = (rank, suit) => ({ rank, suit });

assert.equal(HEROES.length, 16, '应保留16名英雄');
assert.equal(Object.keys(SKILLS).length, 32, '每名英雄应有两个正式技能');
for (const hero of HEROES) {
  const skills = getHeroSkills(hero);
  assert.equal(skills.length, 2, `${hero.name}必须恰有两个技能`);
  assert.deepEqual(hero.skills.actives, getActiveSkills(hero),
    `${hero.name} actives alias must include every active skill`);
  assert.deepEqual(hero.skills.passives, getPassiveSkills(hero),
    `${hero.name} passives alias must include every passive skill`);
  assert.equal(hero.skills.active, hero.skills.actives[0] || null,
    `${hero.name} active compatibility alias must point at the first active skill`);
  assert.equal(hero.skills.passive, hero.skills.passives[0] || null,
    `${hero.name} passive compatibility alias must point at the first passive skill`);
  assert.ok(skills.every((item) => item.cost === 0), `${hero.name}技能不得消耗能量`);
  assert.ok(skills.every((item) => item.description && item.conditionDescription),
    `${hero.name}技能描述与条件必须完整`);
  assert.ok(skills.every((item) => item.presentation?.preset
    && item.presentation?.role && item.presentation?.sfx),
  `${hero.name}每个技能都必须声明语义特效和音效`);
  for (const item of skills) {
    assert.ok(hero.lines.skills?.[item.id]?.cast && hero.lines.skills?.[item.id]?.effect,
      `${hero.name}【${item.name}】缺少发动/生效语音`);
  }
}

function prepared(heroIds, human = new Set([1])) {
  const engine = new Engine(heroIds, {}, human, {}, { tableSize: 6, rng: () => 0.42 });
  engine.round = 3;
  engine.street = 'flop';
  engine.revealed = 3;
  engine.board = [C(2, 1), C(7, 2), C(9, 3), C(11, 4), C(14, 1)];
  engine.deck = [C(3, 1), C(4, 2), C(5, 3)];
  engine.currentBet = 0;
  engine.minRaiseInc = 20;
  engine.actionHistory = [];
  for (const player of engine.players.slice(1)) {
    player.alive = true;
    player.folded = false;
    player.allIn = false;
    player.hp = 1500;
    player.betRound = 100;
    player.betStreet = 0;
    player.hole = [C(8, 1), C(4, 2)];
    resetRoundSkillState(player);
  }
  engine.actingIdx = 1;
  engine.waitingIdx = 1;
  return engine;
}

// 双主动与行动门禁。
{
  const engine = prepared(['zhugeliang', 'diaochan', 'hanxin', 'xiangyu', 'lvbuwei', 'lianpo']);
  const zhuge = engine.players[1];
  assert.equal(getActiveSkills(zhuge.hero).length, 2, '诸葛亮应有两个主动技能');
  engine.actingIdx = 2;
  assert.equal(engine.skillAvailability(1, 'zhugeliang_guanxing').ok, false);
  assert.match(engine.skillAvailability(1, 'zhugeliang_guanxing').reason, /轮到你行动/);
  engine.actingIdx = 1;
  engine.currentBet = 160;
  engine.players[2].betStreet = 160;
  engine.players[3].betStreet = 160;
  assert.equal(engine.skillAvailability(1, 'zhugeliang_guanxing').ok, true);
}

// 花木兰由进攻切换为防守时，必须由“变阵”被动槽发出事件。
{
  let passiveEvent = null;
  const engine = prepared(['huamulan', 'diaochan', 'hanxin', 'xiangyu', 'lvbuwei', 'lianpo']);
  engine.listeners.onPassive = (idx, skillId, name) => {
    passiveEvent = { idx, skillId, name };
  };
  const mulan = engine.players[1];
  dispatchSkillEvent(engine, 'ACTION', { actor: mulan, type: 'raise', group: 'attack' });
  dispatchSkillEvent(engine, 'ACTION', { actor: mulan, type: 'call', group: 'defense' });
  assert.deepEqual(passiveEvent, {
    idx: 1,
    skillId: 'huamulan_bianzhen',
    name: '变阵',
  }, '花木兰攻转守应由变阵被动触发，而不是点亮易装主动');
}

// 预测托管：猜中净得5BB，猜错净付2BB，不能出现无论对错都盈利。
{
  const correctEngine = prepared([
    'shangguanwaner', 'diaochan', 'hanxin', 'xiangyu', 'lvbuwei', 'lianpo',
  ]);
  const owner = correctEngine.players[1];
  const target = correctEngine.players[2];
  assert.equal(correctEngine.useSkill(1, {
    targetIdx: 2,
    choice: 'attack',
  }, 'shangguanwaner_luobi'), true);
  correctEngine.actionHistory.push({
    round: correctEngine.round,
    street: correctEngine.street,
    actorIdx: 2,
    key: 'strike',
    isAggressive: true,
  });
  dispatchSkillEvent(correctEngine, 'ACTION', {
    actor: target, type: 'raise', group: 'attack',
  });
  assert.equal(owner.hp, 1600, '落笔猜中后应在返还自身托管的同时净得5BB');
  assert.equal(target.hp, 1400, '目标猜中后应净付5BB');

  const wrongEngine = prepared([
    'shangguanwaner', 'diaochan', 'hanxin', 'xiangyu', 'lvbuwei', 'lianpo',
  ]);
  assert.equal(wrongEngine.useSkill(1, {
    targetIdx: 2,
    choice: 'defend',
  }, 'shangguanwaner_luobi'), true);
  wrongEngine.actionHistory.push({
    round: wrongEngine.round,
    street: wrongEngine.street,
    actorIdx: 2,
    key: 'strike',
    isAggressive: true,
  });
  dispatchSkillEvent(wrongEngine, 'ACTION', {
    actor: wrongEngine.players[2], type: 'raise', group: 'attack',
  });
  assert.equal(wrongEngine.players[1].hp, 1460, '落笔猜错后应净付2BB');
  assert.equal(wrongEngine.players[2].hp, 1540, '目标应取回托管并获得2BB');
}

// 霸王威压：只在主动决死且有效筹码≥8BB时触发，每阶段一次，并限制延时为15秒。
{
  const engine = prepared(['xiangyu', 'diaochan', 'hanxin', 'zhugeliang', 'lvbuwei', 'lianpo']);
  const actor = engine.players[1];
  const target = engine.players[2];
  const allInEvent = {
    round: engine.round,
    street: engine.street,
    actorIdx: actor.idx,
    key: 'allin',
    actorStackBefore: 1000,
    isAggressive: true,
  };
  engine.actionHistory.push(allInEvent);
  dispatchSkillEvent(engine, 'ACTION', { actor, type: 'allin', group: 'attack' });
  assert.equal(target.skillData.nextTimePenalty, 8);
  assert.equal(target.skillData.nextExtendSeconds, 15);
  dispatchSkillEvent(engine, 'ACTION', { actor, type: 'allin', group: 'attack' });
  assert.equal(target.skillData.nextTimePenalty, 8, '同一阶段不得重复施加霸王威压');

  target.skillData.nextTimePenalty = 0;
  target.skillData.nextExtendSeconds = null;
  engine.street = 'turn';
  engine.actionHistory.push({ ...allInEvent, street: 'turn' });
  dispatchSkillEvent(engine, 'ACTION', { actor, type: 'allin', group: 'attack' });
  assert.equal(target.skillData.nextTimePenalty, 8, '新阶段允许再次触发霸王威压');
  target.skillData.currentExtendSeconds = 15;
  target.energy = 2;
  assert.equal(engine.extendTime(target.idx), 15, '受威压玩家本次只能延时15秒');
  assert.equal(engine.extendTime(target.idx), 0, '同一次行动不能重复购买延时');
}

// 破釜沉舟必须记录“以决死跟入”的玩家，且不能把项羽自己重复加入。
{
  const engine = prepared(['xiangyu', 'diaochan', 'hanxin', 'zhugeliang', 'lvbuwei', 'lianpo']);
  engine.skillState = {
    streetRule: null,
    predictions: [],
    insurance: [],
    copiedActives: [],
    insuranceOffer: null,
    markedAllIn: { ownerIdx: 1, callerIds: new Set(), ratio: 0.15 },
  };
  dispatchSkillEvent(engine, 'ACTION', {
    actor: engine.players[1], type: 'allin', group: 'attack',
  });
  dispatchSkillEvent(engine, 'ACTION', {
    actor: engine.players[2], type: 'allin', group: 'defend',
  });
  assert.deepEqual([...engine.skillState.markedAllIn.callerIds], [2]);
}

// 观星只返回范围真假，不泄露精确牌。
{
  let result = null;
  let presentation = null;
  let quote = null;
  const engine = prepared(['zhugeliang', 'diaochan', 'hanxin', 'xiangyu', 'lvbuwei', 'lianpo']);
  engine.listeners.onSkillResult = (_idx, value) => { result = value; };
  engine.listeners.onSkill = (_idx, _skillId, _name, value) => { presentation = value; };
  engine.listeners.onQuote = (_idx, value, meta) => { quote = { value, meta }; };
  engine.currentBet = 160;
  engine.players[2].betStreet = 160;
  engine.players[3].betStreet = 160;
  assert.equal(engine.useSkill(1, { rankBand: 'high', suitPair: '14' }, 'zhugeliang_guanxing'), true);
  assert.equal(typeof result.rankHit, 'boolean');
  assert.equal(typeof result.suitHit, 'boolean');
  assert.equal(Object.hasOwn(result, 'card'), false, '观星不得返回精确公共牌');
  assert.equal(engine.players[1].energy, 2, '技能不得扣除延时能量');
  assert.equal(presentation.role, 'control');
  assert.equal(presentation.phase, 'cast');
  assert.ok(quote.value && quote.meta.skillId === 'zhugeliang_guanxing',
    '技能发动时必须同步对应角色语音与演出元数据');
}

// 女娲真实换牌，且只公开“发生换牌”。
{
  let publicResult = null;
  const engine = prepared(['nvwa', 'diaochan', 'hanxin', 'xiangyu', 'lvbuwei', 'lianpo']);
  for (const player of engine.players.slice(1)) player.betRound = 0;
  engine.listeners.onSkillPublicResult = (_idx, value) => { publicResult = value; };
  const old = engine.players[1].hole[0];
  assert.equal(engine.useSkill(1, { cardIndex: 1 }, 'nvwa_zaohua'), true);
  assert.notDeepEqual(engine.players[1].hole[0], old);
  assert.equal(publicResult.kind, 'card_replaced');
  assert.equal(Object.hasOwn(publicResult, 'card'), false, '换入牌不得向其他玩家公开');
}

// 行动时限遵守最低8秒/最高45秒，免疫减时后仍获得加时。
{
  const engine = prepared(['lvbuwei', 'diaochan', 'hanxin', 'xiangyu', 'nvwa', 'lianpo']);
  const seller = engine.players[1];
  const buyer = engine.players[2];
  seller.hole = [C(3, 1), C(5, 2)];
  buyer.hole = [C(14, 3), C(14, 4)];
  for (const player of engine.players.slice(3)) player.folded = true;
  engine.board = [C(2, 1), C(7, 2), C(9, 3), C(11, 4), C(13, 1)];
  assert.equal(openInsuranceOffer(engine, [seller, buyer]), true);
  assert.equal(engine.skillAvailability(1, 'lvbuwei_qihuo').ok, true);
  const sellerBefore = seller.hp;
  const buyerBefore = buyer.hp;
  assert.equal(engine.useSkill(1, {
    targetIdx: buyer.idx,
    coverage: 0.5,
  }, 'lvbuwei_qihuo'), true);
  assert.equal(engine.skillState.insurance.length, 1);
  assert.ok(seller.hp < sellerBefore, '保险卖方须用自己的筹码锁定赔付准备金');
  assert.ok(buyer.hp < buyerBefore, '保险买方须从自己的筹码支付保费');
}

// 行动时限遵守最低 8 秒、最高 45 秒，免疫减时后仍可获得加时。
{
  const engine = prepared(['liqingzhao', 'xiangyu', 'hanxin', 'diaochan', 'lvbuwei', 'lianpo']);
  const player = engine.players[1];
  player.skillData.nextTimePenalty = 40;
  assert.equal(getSkillActionSeconds(engine, player, 30), 8);
  player.skillData.shengshengActive = true;
  player.skillData.nextTimePenalty = 40;
  player.skillData.nextTimeBonus = 20;
  assert.equal(getSkillActionSeconds(engine, player, 30), 45);
}

// 结算技能只能做玩家间转账，技能调整总和必须严格为0。
{
  const engine = prepared(['xishi', 'fuhao', 'muguiying', 'nvwa', 'hanxin', 'xiangyu']);
  engine.players[1].skillData.riverCallBettorIdx = 2;
  engine.players[2].showdownInfo = { cat: 1, score: 1 };
  engine.players[1].showdownInfo = { cat: 2, score: 2 };
  const base = { 1: 500, 2: -300, 3: -200 };
  engine.players[1].hp = 2000;
  engine.players[2].hp = 1200;
  engine.players[3].hp = 1300;
  const before = engine.players.slice(1).reduce((sum, player) => sum + player.hp, 0);
  const adjusted = settleSkillAdjustments(engine, { mode: 'showdown', netResult: base, wonAmount: { 1: 800 } });
  const after = engine.players.slice(1).reduce((sum, player) => sum + player.hp, 0);
  assert.equal(after, before, '技能结算不得创造或销毁筹码');
  assert.equal(Object.values(adjusted.ledger).reduce((sum, amount) => sum + amount, 0), 0);
  assert.equal(adjusted.netResult[1], 550, '沉鱼应获得基础净赢10%');
  assert.equal(adjusted.netResult[2], -350, '额外盈利应由对应下注者支付');
}

console.log('技能V2自检通过：32技能、双主动、零能量、范围情报、换牌、计时与零和结算');
