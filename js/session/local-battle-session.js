import { Engine } from '../game/engine.js';
import { BattleSession } from './battle-session.js';

export function createLocalBattleSession({
  heroIds,
  humanSeats = null,
  names = {},
  rules = {},
} = {}) {
  const listeners = {};
  const engine = new Engine(heroIds || [], listeners, humanSeats, names, rules);
  return new BattleSession(engine, listeners, { kind: 'local' });
}
