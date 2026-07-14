import assert from 'node:assert/strict';

import { Engine } from '../js/game/engine.js';

const heroIds = Array(6).fill('zhugeliang');
const allSeats = new Set([1, 2, 3, 4, 5, 6]);

let livePassiveEvents = 0;
const live = new Engine(
  heroIds,
  { onPassive() { livePassiveEvents++; } },
  allSeats,
  {},
  { rng: () => 0 },
);
live.startRound();
assert.equal(livePassiveEvents, 5,
  'the deterministic control deal should trigger five live passive skills');
assert.deepEqual(live.players.slice(1).map((player) => player.energy), [3, 3, 3, 3, 2, 3]);

let trainingPassiveEvents = 0;
const training = new Engine(
  heroIds,
  { onPassive() { trainingPassiveEvents++; } },
  allSeats,
  {},
  { rng: () => 0, skillsEnabled: false },
);
training.startRound();
assert.equal(trainingPassiveEvents, 0,
  'neutral poker training must suppress passive hero effects');
assert.deepEqual(training.players.slice(1).map((player) => player.energy), [2, 2, 2, 2, 2, 2]);
assert.equal(training.canUseSkill(1), false);
assert.equal(training.skillAvailability(1).ok, false);
assert.equal(training.getSkillPrompt(1), null);
assert.equal(training.useSkill(1), false);

console.log('训练规则自检通过：skillsEnabled=false 同时关闭主动与被动技能，默认规则保持不变。');
