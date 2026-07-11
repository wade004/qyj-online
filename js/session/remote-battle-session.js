import { RemoteEngine } from '../net/remoteengine.js';
import { BattleSession } from './battle-session.js';

export function createRemoteBattleSession(startData, send) {
  const listeners = {};
  const engine = new RemoteEngine(startData, listeners, send);
  return new BattleSession(engine, listeners, { kind: 'remote' });
}
