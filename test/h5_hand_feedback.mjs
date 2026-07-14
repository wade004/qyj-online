import assert from 'node:assert/strict';

import { describe, isPlayerMadeStrongHand } from '../js/game/handeval.js';
import {
  classifyH5HandHit,
  classifyH5PremiumStartingHand,
  shouldRenderH5PortraitReveal,
} from '../js/ui/h5/battle-view.js';

const card = (rank, suit) => ({ rank, suit });

assert.equal(shouldRenderH5PortraitReveal(1, 1), false,
  '主角亮牌只保留在专用手牌区，不重复覆盖头像');
assert.equal(shouldRenderH5PortraitReveal(2, 1), true,
  '其他玩家亮牌继续在各自头像框中展示');

assert.deepEqual(
  classifyH5PremiumStartingHand([card(14, 1), card(12, 2)]),
  {
    category: 1,
    stage: '天时',
    name: '强力起手',
    poker: 'AQo',
    tier: 'premium',
    strong: true,
  },
  'AQ offsuit should receive the premium starting-hand treatment',
);
assert.equal(classifyH5PremiumStartingHand([card(14, 3), card(13, 3)])?.poker, 'AKs');
assert.equal(classifyH5PremiumStartingHand([card(10, 1), card(10, 4)])?.poker, 'TT');
assert.equal(classifyH5PremiumStartingHand([card(14, 1), card(11, 1)])?.poker, 'AJs');
assert.equal(classifyH5PremiumStartingHand([card(13, 2), card(12, 2)])?.poker, 'KQs');
assert.equal(classifyH5PremiumStartingHand([card(14, 1), card(11, 2)]), null);
assert.equal(classifyH5PremiumStartingHand([card(9, 1), card(9, 2)]), null);
assert.equal(classifyH5PremiumStartingHand([card(13, 1), card(12, 2)]), null);

const publicPairHole = [card(4, 2), card(2, 3)];
const publicPairTwoPair = describe([
  ...publicPairHole,
  card(4, 1), card(7, 2), card(7, 1),
]);
assert.equal(publicPairTwoPair.cat, 3);
assert.equal(isPlayerMadeStrongHand(publicPairTwoPair, publicPairHole), false);
assert.equal(
  classifyH5HandHit(1, publicPairTwoPair, publicPairHole, 'flop', false),
  null,
  'one personal pair plus a public pair must not emit a strong-hand hit',
);

const trueTwoPairHole = [card(14, 1), card(13, 2)];
const trueTwoPair = describe([
  ...trueTwoPairHole,
  card(14, 3), card(13, 4), card(7, 1),
]);
assert.equal(trueTwoPair.cat, 3);
assert.equal(isPlayerMadeStrongHand(trueTwoPair, trueTwoPairHole), true);
assert.equal(classifyH5HandHit(2, trueTwoPair, trueTwoPairHole, 'turn', false)?.strong, true);

const falseTwoPairSameCategory = describe([
  ...trueTwoPairHole,
  card(14, 3), card(2, 1), card(2, 4),
]);
const trueTwoPairSameCategory = describe([
  ...trueTwoPairHole,
  card(14, 3), card(2, 1), card(2, 4), card(13, 4),
]);
assert.equal(falseTwoPairSameCategory.cat, 3);
assert.equal(isPlayerMadeStrongHand(falseTwoPairSameCategory, trueTwoPairHole), false);
assert.equal(trueTwoPairSameCategory.cat, 3);
assert.equal(isPlayerMadeStrongHand(trueTwoPairSameCategory, trueTwoPairHole), true);
assert.equal(
  classifyH5HandHit(3, trueTwoPairSameCategory, trueTwoPairHole, 'turn', false)?.strong,
  true,
  'a non-strong cat3 becoming a personal cat3 must still announce the strong hand',
);
assert.equal(
  classifyH5HandHit(3, trueTwoPairSameCategory, trueTwoPairHole, 'turn', true),
  null,
  'the same personal strong hand must not be announced repeatedly',
);

const pocketPairHole = [card(4, 2), card(4, 3)];
const pocketPlusPublicPair = describe([
  ...pocketPairHole,
  card(7, 1), card(7, 2), card(13, 4),
]);
assert.equal(pocketPlusPublicPair.cat, 3);
assert.equal(isPlayerMadeStrongHand(pocketPlusPublicPair, pocketPairHole), false);

const boardTwoPairHole = [card(14, 1), card(12, 2)];
const boardTwoPair = describe([
  ...boardTwoPairHole,
  card(13, 1), card(13, 2), card(7, 3), card(7, 4), card(2, 1),
]);
assert.equal(boardTwoPair.cat, 3);
assert.equal(isPlayerMadeStrongHand(boardTwoPair, boardTwoPairHole), false);

const tripsHole = [card(7, 1), card(2, 2)];
const personalTrips = describe([...tripsHole, card(7, 2), card(7, 3), card(13, 1)]);
assert.equal(personalTrips.cat, 4);
assert.equal(isPlayerMadeStrongHand(personalTrips, tripsHole), true);
assert.equal(classifyH5HandHit(2, personalTrips, tripsHole, 'flop', false)?.strong, true);

console.log('H5 hand feedback passed: premium starting hands and personal made hands are highlighted without false public-pair alerts.');
