// Shared facade used by PC/H5 battle renderers. It keeps the UI contract
// identical for the authoritative local Engine and the mirrored RemoteEngine.

export const BATTLE_ENGINE_METHODS = Object.freeze([
  'update',
  'delay',
  'totalPot',
  'getPotDisplay',
  'revealedBoard',
  'activePlayers',
  'playerAct',
  'extendTime',
  'canUseSkill',
  'skillAvailability',
  'getSkillPrompt',
  'useSkill',
]);

/**
 * Fail early when an engine adapter no longer satisfies the battle UI port.
 * @param {object} engine
 * @param {string} label
 * @returns {true}
 */
export function assertBattleEngineContract(engine, label = 'BattleEngine') {
  if (!engine || typeof engine !== 'object') {
    throw new TypeError(`${label} must be an object`);
  }
  if (!Array.isArray(engine.players) || !Array.isArray(engine.board)) {
    throw new TypeError(`${label} must expose players and board arrays`);
  }
  const missing = BATTLE_ENGINE_METHODS.filter((name) => typeof engine[name] !== 'function');
  if (missing.length) {
    throw new TypeError(`${label} is missing methods: ${missing.join(', ')}`);
  }
  return true;
}

export class BattleSession {
  constructor(engine, listeners, { kind = 'local' } = {}) {
    assertBattleEngineContract(engine, `${kind} battle engine`);
    this.rawEngine = engine;
    this.listeners = listeners || engine.listeners || {};
    this.kind = kind;
    this.destroyed = false;
  }

  get players() { return this.rawEngine.players; }
  get board() { return this.rawEngine.board; }
  get waitingIdx() { return this.rawEngine.waitingIdx ?? null; }
  get actingIdx() { return this.rawEngine.actingIdx ?? 0; }
  get round() { return this.rawEngine.round ?? 0; }
  get street() { return this.rawEngine.street ?? 'idle'; }
  get revealed() { return this.rawEngine.revealed ?? 0; }
  get dealerIdx() { return this.rawEngine.dealerIdx ?? 0; }
  get currentBet() { return this.rawEngine.currentBet ?? 0; }
  get streetRaiseCount() { return this.rawEngine.streetRaiseCount ?? 0; }
  get lastAggressiveWager() { return this.rawEngine.lastAggressiveWager ?? null; }
  get actionClock() { return this.rawEngine.actionClock ?? null; }
  get gameOver() { return !!this.rawEngine.gameOver; }
  get lastRanking() { return this.rawEngine.lastRanking || null; }

  getState() {
    return {
      kind: this.kind,
      players: this.players,
      board: this.board,
      waitingIdx: this.waitingIdx,
      actingIdx: this.actingIdx,
      round: this.round,
      street: this.street,
      revealed: this.revealed,
      dealerIdx: this.dealerIdx,
      currentBet: this.currentBet,
      streetRaiseCount: this.streetRaiseCount,
      lastAggressiveWager: this.lastAggressiveWager,
      actionClock: this.actionClock,
      gameOver: this.gameOver,
    };
  }

  start() {
    if (typeof this.rawEngine.startGame === 'function') this.rawEngine.startGame();
  }

  update(dt) {
    if (!this.destroyed) this.rawEngine.update(dt);
  }

  tick(dt) { this.update(dt); }

  delay(sec, fn) { return this.rawEngine.delay(sec, fn); }
  totalPot() { return this.rawEngine.totalPot(); }
  getPotDisplay(includeReference = true) {
    return this.rawEngine.getPotDisplay(includeReference);
  }
  getPotBreakdown() {
    return typeof this.rawEngine.getPotBreakdown === 'function'
      ? this.rawEngine.getPotBreakdown()
      : this.getPotDisplay(false);
  }
  revealedBoard() { return this.rawEngine.revealedBoard(); }
  activePlayers() { return this.rawEngine.activePlayers(); }
  playerAct(action) { return this.rawEngine.playerAct(action); }
  extendTime(idx) { return this.rawEngine.extendTime(idx); }
  canUseSkill(idx) { return this.rawEngine.canUseSkill(idx); }
  skillAvailability(idx) { return this.rawEngine.skillAvailability(idx); }
  getSkillPrompt(idx) { return this.rawEngine.getSkillPrompt(idx); }
  useSkill(idx, selection = null) { return this.rawEngine.useSkill(idx, selection); }

  onMessage(message) {
    if (typeof this.rawEngine.onMessage === 'function') {
      this.rawEngine.onMessage(message);
    }
  }

  dispatch(command, payload = {}) {
    if (command === 'action') return this.playerAct(payload.action || payload);
    if (command === 'skill') return this.useSkill(payload.idx, payload.selection || null);
    if (command === 'extend') return this.extendTime(payload.idx);
    throw new Error(`Unsupported battle command: ${command}`);
  }

  destroy() {
    this.destroyed = true;
  }
}
