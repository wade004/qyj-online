import {
  bestFiveCardKeys,
  handRecordNumber,
  historyPlayersBySeat,
} from '../js/ui/shared/hand-history.js';

const assert = (condition, message) => {
  if (!condition) throw new Error(`Hand history assertion failed: ${message}`);
};
const C = (r, s) => ({ r, s });

const board = [C(4, 1), C(5, 2), C(6, 3), C(13, 4), C(14, 1)];
const participant = {
  seat: 1,
  hole: [C(7, 2), C(8, 4)],
  handName: '顺子',
};
const best = bestFiveCardKeys(participant, board);
assert(best.size === 5, 'showdown should identify exactly five final cards');
for (const key of ['7:2', '8:4', '4:1', '5:2', '6:3']) {
  assert(best.has(key), `final straight should contain ${key}`);
}
assert(bestFiveCardKeys({ ...participant, handName: null }, board).size === 0,
  'folded or unrevealed hands must not receive inferred highlights');
assert(bestFiveCardKeys({ ...participant, hole: [C(7, 2), null] }, board).size === 0,
  'partially revealed opponent cards must not be inferred');

const seats = historyPlayersBySeat({ tableSize: 6, players: [participant, { seat: 3 }] });
assert(seats.length === 6, 'legacy sparse records should render every table seat');
assert(seats[1].seat === 2 && seats[1].participated === false,
  'missing seat two should render as a non-participant placeholder');
assert(seats[2].seat === 3, 'existing seat records must keep their original position');
assert(handRecordNumber(42) === '#000042', 'database hand id should render as a stable unique number');
assert(handRecordNumber(null) === '#------', 'missing legacy ids should have an explicit placeholder');

console.log('Hand history presentation passed: unique ids, complete seats, board context and privacy-safe best-five highlights.');
