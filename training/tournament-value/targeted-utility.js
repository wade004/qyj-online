import {
  TOURNAMENT_VALUE_OOD_THRESHOLD,
  compileTournamentValueModel,
  predictTournamentValue,
} from './model.js';
import {
  buildTargetedTournamentRootState,
  evaluateTargetedTournamentLeaf,
  normalizedRankUtility,
} from './targeted-leaf.js';

export const DEFAULT_TARGETED_TOURNAMENT_VALUE_OPTIONS = Object.freeze({
  maxUncertainty: 0.75,
  maxOodScore: TOURNAMENT_VALUE_OOD_THRESHOLD,
  fallbackShareScale: 2,
});

function finite(value, label, { minimum = -Infinity } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) {
    throw new RangeError(`${label} must be finite${minimum > -Infinity ? ` >= ${minimum}` : ''}`);
  }
  return number;
}

function clampRankValue(value) {
  return Math.max(-1, Math.min(1, value));
}

function predictionPasses(prediction, options) {
  return prediction.ood !== true
    && prediction.oodScore <= options.maxOodScore
    && prediction.uncertainty <= options.maxUncertainty;
}

function focalTransferProbeState(state) {
  const ring = state?.liveStacksFromButton;
  const focal = Number(state?.focalPosition);
  if (!Array.isArray(ring) || ring.length < 2
    || !Number.isInteger(focal) || focal < 0 || focal >= ring.length) return null;
  const opponent = (focal + 1) % ring.length;
  const amount = Math.min(
    Math.max(1, Math.floor(Number(state.bigBlind) / 2)),
    Math.floor(Number(ring[opponent]) / 2),
  );
  if (!(amount > 0)) return null;
  const improvedRing = [...ring];
  improvedRing[focal] += amount;
  improvedRing[opponent] -= amount;
  return Object.freeze({
    tableSize: state.tableSize,
    round: state.round,
    maxRounds: state.maxRounds,
    bigBlind: state.bigBlind,
    focalStack: improvedRing[focal],
    opponentStacks: Object.freeze([
      ...improvedRing.filter((_, index) => index !== focal),
      ...Array(state.tableSize - improvedRing.length).fill(0),
    ].sort((left, right) => right - left)),
    liveStacksFromButton: Object.freeze(improvedRing),
    focalPosition: focal,
  });
}

function frozenDiagnostics(source) {
  return Object.freeze({ ...source });
}

function expectedSurvivorValueSum(survivorCount, tableSize) {
  let total = 0;
  for (let rank = 1; rank <= survivorCount; rank++) {
    total += normalizedRankUtility(rank, tableSize);
  }
  return total;
}

/** Bounded Euclidean projection onto the exact survivor-value sum. */
export function projectJointTournamentValues(entries, tableSize) {
  if (!Array.isArray(entries) || !entries.length) {
    throw new RangeError('joint tournament projection requires survivors');
  }
  const size = Number(tableSize);
  if (!Number.isSafeInteger(size) || size < 2 || size > 9
    || entries.length > size) {
    throw new RangeError('joint tournament projection tableSize/entry count is invalid');
  }
  const normalized = entries.map((entry, index) => ({
    seat: Number(entry?.seat),
    stack: finite(entry?.stack, `entries[${index}].stack`, { minimum: 0 }),
    value: finite(entry?.value, `entries[${index}].value`),
  }));
  if (normalized.some((entry) => !Number.isSafeInteger(entry.seat))
    || new Set(normalized.map((entry) => entry.seat)).size !== normalized.length) {
    throw new RangeError('joint tournament projection seats must be unique integers');
  }
  // Seat order is used only as a deterministic map key. Do not force values
  // to be ordered by stack here: different relative button positions are
  // strategically distinct, so cross-player stack ordering is not a valid
  // monotonicity constraint. Chip-transfer monotonicity is gated separately.
  const ordered = normalized.sort((left, right) => left.seat - right.seat);
  const rawValues = ordered.map((entry) => entry.value);
  const targetSum = expectedSurvivorValueSum(normalized.length, size);
  // Euclidean projection onto the box-constrained sum hyperplane. With at
  // most nine survivors the active set converges in at most nine passes and
  // avoids a per-leaf iterative bisection inside MCCFR's hot path.
  const projected = Array(rawValues.length).fill(null);
  const active = new Set(rawValues.map((_, index) => index));
  let fixedSum = 0;
  while (active.size) {
    let activeRawSum = 0;
    for (const index of active) activeRawSum += rawValues[index];
    const shift = (targetSum - fixedSum - activeRawSum) / active.size;
    let clipped = false;
    for (const index of [...active]) {
      const candidate = rawValues[index] + shift;
      if (candidate < -1) {
        projected[index] = -1;
        fixedSum -= 1;
        active.delete(index);
        clipped = true;
      } else if (candidate > 1) {
        projected[index] = 1;
        fixedSum += 1;
        active.delete(index);
        clipped = true;
      }
    }
    if (!clipped) {
      for (const index of active) projected[index] = rawValues[index] + shift;
      active.clear();
    }
  }
  // Remove the final floating-point residue without violating the box.
  let residue = targetSum - projected.reduce((sum, value) => sum + value, 0);
  for (let index = projected.length - 1; index >= 0 && Math.abs(residue) > 1e-12; index--) {
    const room = residue > 0 ? 1 - projected[index] : projected[index] + 1;
    const adjustment = Math.sign(residue) * Math.min(Math.abs(residue), room);
    projected[index] += adjustment;
    residue -= adjustment;
  }
  if (Math.abs(residue) > 1e-9) throw new Error('joint tournament projection is infeasible');
  return Object.freeze({
    values: new Map(ordered.map((entry, index) => [entry.seat, projected[index]])),
    rawSumError: Math.abs(normalized.reduce((sum, entry) => sum + entry.value, 0) - targetSum),
    monotonicCorrections: 0,
    maxAdjustment: ordered.reduce((largest, entry, index) => (
      Math.max(largest, Math.abs(projected[index] - entry.value))
    ), 0),
  });
}

/**
 * Safe terminal-utility adapter for one exact targeted game.
 *
 * Preflight is deliberately all-or-nothing across every target variant and
 * root traverser.  Therefore raw BB chip utility and normalized rank utility
 * can never be mixed merely because one root happened to be out of domain.
 */
export class TargetedTournamentUtility {
  constructor(modelOrArtifact, options = {}) {
    this.model = compileTournamentValueModel(modelOrArtifact);
    this.options = Object.freeze({
      maxUncertainty: finite(
        options.maxUncertainty
          ?? DEFAULT_TARGETED_TOURNAMENT_VALUE_OPTIONS.maxUncertainty,
        'maxUncertainty', { minimum: 0 },
      ),
      maxOodScore: finite(
        options.maxOodScore ?? DEFAULT_TARGETED_TOURNAMENT_VALUE_OPTIONS.maxOodScore,
        'maxOodScore', { minimum: 0 },
      ),
      fallbackShareScale: finite(
        options.fallbackShareScale
          ?? DEFAULT_TARGETED_TOURNAMENT_VALUE_OPTIONS.fallbackShareScale,
        'fallbackShareScale', { minimum: 0 },
      ),
    });
    this.enabled = false;
    this.preflighted = false;
    this.rootPredictions = new WeakMap();
    this.rootProjectedValues = new WeakMap();
    this.leafBundles = new WeakMap();
    this.counts = {
      preflightRoots: 0,
      preflightPassed: 0,
      rawChipFallbacks: 0,
      exactRankValues: 0,
      modeledValues: 0,
      scaledChipFallbacks: 0,
      jointProjections: 0,
      monotonicCorrections: 0,
      maxRawSumError: 0,
      maxProjectionAdjustment: 0,
      monotonicityChecks: 0,
      monotonicityFallbacks: 0,
    };
    this.disabledReason = 'not-preflighted';
  }

  _rootPrediction(snapshot, abstractState, zeroBasedPlayer) {
    let byPlayer = this.rootPredictions.get(snapshot);
    if (!byPlayer) {
      byPlayer = new Map();
      this.rootPredictions.set(snapshot, byPlayer);
    }
    if (byPlayer.has(zeroBasedPlayer)) return byPlayer.get(zeroBasedPlayer);
    const root = buildTargetedTournamentRootState(snapshot, abstractState, zeroBasedPlayer);
    const result = root.available === false
      ? Object.freeze({ available: false, reason: root.reason })
      : Object.freeze({
          available: true,
          state: root.state,
          prediction: predictTournamentValue(this.model, root.state),
        });
    byPlayer.set(zeroBasedPlayer, result);
    return result;
  }

  _predictionPassesWithMonotonicity(state, prediction) {
    if (!predictionPasses(prediction, this.options)) return false;
    const improvedState = focalTransferProbeState(state);
    if (!improvedState) return true;
    const improved = predictTournamentValue(this.model, improvedState);
    this.counts.monotonicityChecks++;
    const passed = predictionPasses(improved, this.options)
      && improved.mean + 1e-9 >= prediction.mean;
    if (!passed) this.counts.monotonicityFallbacks++;
    return passed;
  }

  /** Preflight every root variant/traverser before the first regret update. */
  preflight(entries) {
    if (this.preflighted) throw new Error('tournament utility was already preflighted');
    if (!Array.isArray(entries) || !entries.length) {
      throw new RangeError('tournament utility preflight requires root entries');
    }
    this.preflighted = true;
    for (const entry of entries) {
      const snapshot = entry?.snapshot;
      const abstractState = entry?.abstractState;
      const players = entry?.players;
      if (!Array.isArray(players) || !players.length) {
        throw new RangeError('tournament utility preflight entry has no traversers');
      }
      const jointEntries = [];
      for (const zeroBasedPlayer of players) {
        this.counts.preflightRoots++;
        const root = this._rootPrediction(snapshot, abstractState, zeroBasedPlayer);
        if (!root.available) {
          this.disabledReason = root.reason;
          return this.diagnostics();
        }
        if (!this._predictionPassesWithMonotonicity(root.state, root.prediction)) {
          this.disabledReason = root.prediction.ood
            || root.prediction.oodScore > this.options.maxOodScore
            ? 'root-ood'
            : root.prediction.uncertainty > this.options.maxUncertainty
              ? 'root-uncertainty' : 'root-monotonicity';
          return this.diagnostics();
        }
        this.counts.preflightPassed++;
        jointEntries.push({
          seat: abstractState.seatIds[zeroBasedPlayer],
          stack: root.state.focalStack,
          value: root.prediction.mean,
        });
      }
      const projection = projectJointTournamentValues(
        jointEntries,
        snapshot.tournament.tableSize,
      );
      this.rootProjectedValues.set(snapshot, projection.values);
      this._recordProjection(projection);
    }
    this.enabled = true;
    this.disabledReason = null;
    return this.diagnostics();
  }

  /** Apply an all-checkpoint gate before any utility call/regret update. */
  forceDisable(reason = 'checkpoint-root-gate') {
    if (!this.preflighted) throw new Error('tournament utility requires preflight before disable');
    if (this.counts.rawChipFallbacks || this.counts.exactRankValues
      || this.counts.modeledValues || this.counts.scaledChipFallbacks) {
      throw new Error('tournament utility cannot be disabled after training started');
    }
    if (this.enabled) {
      this.enabled = false;
      this.disabledReason = String(reason || 'checkpoint-root-gate');
    }
    return this.diagnostics();
  }

  _recordProjection(projection) {
    this.counts.jointProjections++;
    this.counts.monotonicCorrections += projection.monotonicCorrections;
    this.counts.maxRawSumError = Math.max(
      this.counts.maxRawSumError,
      projection.rawSumError,
    );
    this.counts.maxProjectionAdjustment = Math.max(
      this.counts.maxProjectionAdjustment,
      projection.maxAdjustment,
    );
  }

  _leafBundle(snapshot, terminalState) {
    const cached = this.leafBundles.get(terminalState);
    if (cached) return cached;
    const seatIds = terminalState.seatIds;
    const survivorRows = [];
    let safe = true;
    for (let player = 0; player < seatIds.length; player++) {
      const leaf = evaluateTargetedTournamentLeaf(snapshot, terminalState, player);
      if (!leaf.available) throw new Error('preflighted tournament leaf lost public context');
      if (leaf.terminal) continue;
      const prediction = predictTournamentValue(this.model, leaf.state);
      if (!this._predictionPassesWithMonotonicity(leaf.state, prediction)) safe = false;
      survivorRows.push({
        seat: seatIds[player],
        stack: leaf.state.focalStack,
        state: leaf.state,
        prediction,
      });
    }
    if (!survivorRows.length) throw new Error('continuing tournament leaf has no survivors');
    const rawEntries = survivorRows.map((row) => {
      if (safe) return { seat: row.seat, stack: row.stack, value: row.prediction.mean };
      const player = seatIds.indexOf(row.seat);
      const root = this._rootPrediction(snapshot, terminalState, player);
      const rootValue = this.rootProjectedValues.get(snapshot)?.get(row.seat);
      if (!Number.isFinite(rootValue)) throw new Error('missing projected tournament root value');
      const rootTotal = root.state.focalStack
        + root.state.opponentStacks.reduce((sum, stack) => sum + stack, 0);
      const leafTotal = row.state.focalStack
        + row.state.opponentStacks.reduce((sum, stack) => sum + stack, 0);
      const tolerance = Math.max(1e-8, rootTotal * 1e-10);
      if (Math.abs(rootTotal - leafTotal) > tolerance) {
        throw new RangeError('tournament leaf changed total public chips');
      }
      const shareDelta = row.state.focalStack / leafTotal
        - root.state.focalStack / rootTotal;
      return {
        seat: row.seat,
        stack: row.stack,
        value: clampRankValue(
          rootValue + this.options.fallbackShareScale * shareDelta,
        ),
      };
    });
    const projection = projectJointTournamentValues(
      rawEntries,
      snapshot.tournament.tableSize,
    );
    this._recordProjection(projection);
    const bundle = Object.freeze({ safe, values: projection.values });
    this.leafBundles.set(terminalState, bundle);
    return bundle;
  }

  evaluate(snapshot, terminalState, zeroBasedPlayer, rawChipUtility) {
    const chipUtility = finite(rawChipUtility, 'rawChipUtility');
    if (!this.preflighted) throw new Error('tournament utility requires preflight');
    if (!this.enabled) {
      this.counts.rawChipFallbacks++;
      return chipUtility;
    }
    const root = this._rootPrediction(snapshot, terminalState, zeroBasedPlayer);
    if (!root.available || !predictionPasses(root.prediction, this.options)) {
      throw new Error('preflighted tournament root changed eligibility');
    }
    const leaf = evaluateTargetedTournamentLeaf(snapshot, terminalState, zeroBasedPlayer);
    if (!leaf.available) throw new Error('preflighted tournament leaf lost public context');
    if (leaf.terminal) {
      this.counts.exactRankValues++;
      return leaf.value;
    }
    const bundle = this._leafBundle(snapshot, terminalState);
    const focalSeat = terminalState.seatIds[zeroBasedPlayer];
    const value = bundle.values.get(focalSeat);
    if (!Number.isFinite(value)) throw new Error('joint leaf projection omitted focal survivor');
    if (bundle.safe) {
      this.counts.modeledValues++;
      return value;
    }
    this.counts.scaledChipFallbacks++;
    return value;
  }

  diagnostics() {
    return frozenDiagnostics({
      enabled: this.enabled,
      disabledReason: this.disabledReason,
      ...this.options,
      ...this.counts,
    });
  }
}
