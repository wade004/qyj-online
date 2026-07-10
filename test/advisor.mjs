import { Engine } from '../js/game/engine.js';
import { HEROES } from '../js/game/heroes.js';
import * as Advisor from '../js/game/advisor.js';

const ids = HEROES.slice(0, 6).map((hero) => hero.id);
const C = (rank, suit) => ({ rank, suit });
const assert = (condition, message) => {
  if (!condition) throw new Error('GTO建议断言失败: ' + message);
};

function baseEngine(street = 'preflop') {
  const engine = new Engine(ids, {}, new Set());
  engine.round = 1;
  engine.street = street;
  engine.dealerIdx = 4;
  engine.currentBet = street === 'preflop' ? 20 : 0;
  engine.minRaiseInc = 20;
  engine.streetRaiseCount = 0;
  for (const player of engine.players.slice(1)) {
    player.alive = true;
    player.folded = false;
    player.allIn = false;
    player.hp = 1500;
    player.betRound = 0;
    player.betStreet = 0;
    player.acted = false;
    player.lastActionBet = 0;
  }
  return engine;
}

const originalRandom = Math.random;
try {
  Math.random = () => 0.314159;

  const premiumEngine = baseEngine();
  const premium = premiumEngine.players[1];
  premium.hole = [C(14, 1), C(14, 2)];
  const premiumOpts = premiumEngine.getOptions(premium);
  const premiumAdvice = Advisor.analyzeDecision(premiumEngine, premium, premiumOpts);
  assert(['raise', 'allin'].includes(premiumAdvice.action.type), 'AA翻前应建议主动进攻');
  assert(premiumAdvice.reason.length >= 20 && premiumAdvice.metrics.includes('BB'),
    '建议必须提供范围/筹码理由和定量指标');
  assert(premiumAdvice.suggestions.length >= 1 && premiumAdvice.suggestions.length <= 3,
    '每个决策节点必须给出一至三个建议');
  assert(premiumAdvice.suggestions[0].label === premiumAdvice.recommendation,
    '第一项必须是主建议');
  assert(premiumAdvice.suggestions.reduce((sum, item) => sum + item.frequency, 0) === 100,
    '建议近似频率之和必须为100%');
  assert(premiumAdvice.suggestions.every((item) => ['fold', 'check', 'call', 'raise', 'allin'].includes(item.action.type)),
    '建议必须映射到游戏支持的合法行动类型');

  const trashEngine = baseEngine();
  const trash = trashEngine.players[1];
  trash.hole = [C(7, 1), C(2, 2)];
  const trashAdvice = Advisor.analyzeDecision(trashEngine, trash, trashEngine.getOptions(trash));
  assert(trashAdvice.action.type === 'fold', 'UTG的72不同花应建议弃牌');

  const screenshotEngine = baseEngine();
  screenshotEngine.dealerIdx = 3;
  screenshotEngine.players[4].betStreet = 10;
  screenshotEngine.players[4].betRound = 10;
  screenshotEngine.players[5].betStreet = 20;
  screenshotEngine.players[5].betRound = 20;
  const screenshotHand = screenshotEngine.players[1];
  screenshotHand.hole = [C(11, 1), C(9, 2)];
  const screenshotAdvice = Advisor.analyzeDecision(
    screenshotEngine, screenshotHand, screenshotEngine.getOptions(screenshotHand),
  );
  assert(screenshotAdvice.action.type === 'fold', '六人桌HJ的J9o应以弃牌为主，不建议首入跛入');
  assert(screenshotAdvice.metrics.includes('底池 1.5BB')
    && screenshotAdvice.metrics.includes('有效筹码 75.0BB')
    && screenshotAdvice.metrics.includes('跟入 1.0BB')
    && screenshotAdvice.metrics.includes('未加注')
    && screenshotAdvice.metrics.includes('手牌 J9o'),
  '翻前指标必须明确区分底池、有效筹码、跟入成本与手牌');
  assert(screenshotAdvice.reason.includes('J9o') && screenshotAdvice.reason.includes('身后仍有 4 人'),
    'HJ弃牌理由必须说明首入范围，不能把有效筹码误述为底池');

  screenshotEngine.players[2].betStreet = 20;
  screenshotEngine.players[2].betRound = 20;
  const limpedAdvice = Advisor.analyzeDecision(
    screenshotEngine, screenshotHand, screenshotEngine.getOptions(screenshotHand),
  );
  assert(limpedAdvice.metrics.includes('1人跛入') && limpedAdvice.reason.includes('跛入底池'),
    '已有玩家跟入时必须按跛入底池分析，不能误写为无人首入');

  const riverEngine = baseEngine('river');
  riverEngine.board = [C(14, 1), C(13, 2), C(12, 3), C(11, 4), C(9, 1)];
  riverEngine.revealed = 5;
  riverEngine.currentBet = 600;
  riverEngine.minRaiseInc = 600;
  riverEngine.streetRaiseCount = 1;
  riverEngine.players[2].betRound = 600;
  riverEngine.players[2].betStreet = 600;
  const weakRiver = riverEngine.players[1];
  weakRiver.hole = [C(2, 2), C(3, 3)];
  const hpBefore = weakRiver.hp;
  const potBefore = riverEngine.totalPot();
  const weakAdvice = Advisor.analyzeDecision(riverEngine, weakRiver, riverEngine.getOptions(weakRiver));
  assert(weakAdvice.action.type === 'fold', '河牌无听牌的弱牌面对大注应建议弃牌');
  assert(weakAdvice.reason.includes('权益') && weakAdvice.metrics.includes('SPR'),
    '河牌理由必须同时解释权益/赔率和SPR上下文');
  assert(weakRiver.hp === hpBefore && riverEngine.totalPot() === potBefore,
    '建议模块只读，不得修改玩家筹码或血池');

  const nutsEngine = baseEngine('river');
  nutsEngine.board = [C(14, 1), C(13, 2), C(12, 3), C(11, 4), C(9, 1)];
  nutsEngine.revealed = 5;
  nutsEngine.currentBet = 200;
  nutsEngine.minRaiseInc = 200;
  nutsEngine.streetRaiseCount = 1;
  nutsEngine.players[2].betRound = 200;
  nutsEngine.players[2].betStreet = 200;
  const nuts = nutsEngine.players[1];
  nuts.hole = [C(10, 2), C(2, 3)];
  const nutsAdvice = Advisor.analyzeDecision(nutsEngine, nuts, nutsEngine.getOptions(nuts));
  assert(['raise', 'allin'].includes(nutsAdvice.action.type), '河牌坚果范围面对下注应建议加注取价');

  const stableKeyA = Advisor.decisionKey(nutsEngine, nuts, nutsEngine.getOptions(nuts));
  const stableKeyB = Advisor.decisionKey(nutsEngine, nuts, nutsEngine.getOptions(nuts));
  assert(stableKeyA === stableKeyB, '同一决策节点的建议缓存键必须稳定');
} finally {
  Math.random = originalRandom;
}

console.log('GTO主角建议自检通过：翻前范围、河牌赔率、强牌取价、只读交互与节点稳定性正常');
