import { SerializableRng, sampleIndex } from './rng.js';
import {
  BLUEPRINT_ABSTRACTION,
  BLUEPRINT_SCHEMA,
  BLUEPRINT_VERSION,
} from '../../js/game/blueprint-policy.js';

export { BLUEPRINT_SCHEMA, BLUEPRINT_VERSION };

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return number;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a finite non-negative integer`);
  }
  return number;
}

function uniqueActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new RangeError('A non-terminal state must expose at least one legal action');
  }
  const normalized = [...new Set(actions.map(String))].sort();
  if (normalized.some((action) => !action)) throw new TypeError('Action keys must be non-empty');
  return normalized;
}

function emptyActionValue() {
  return {
    samples: 0,
    mean: 0,
    m2: 0,
  };
}

/** Numerically stable online moments for sampled traverser action utilities. */
function updateActionValue(moment, rawValue, label) {
  const value = finiteNumber(rawValue, label);
  if (moment.samples >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} sample count exceeds Number.MAX_SAFE_INTEGER`);
  }
  const samples = moment.samples + 1;
  const delta = value - moment.mean;
  const mean = moment.mean + delta / samples;
  const m2 = moment.m2 + delta * (value - mean);
  if (!Number.isFinite(mean) || !Number.isFinite(m2)) {
    throw new RangeError(`${label} moments overflowed`);
  }
  moment.samples = samples;
  moment.mean = mean;
  moment.m2 = Math.max(0, m2);
}

function serializeActionValue(moment) {
  return {
    samples: moment.samples,
    mean: moment.mean,
    m2: moment.m2,
  };
}

function restoreActionValue(raw, label) {
  if (raw == null) return emptyActionValue();
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`${label} must be an object`);
  }
  const samples = Number(raw.samples);
  if (!Number.isSafeInteger(samples) || samples < 0) {
    throw new TypeError(`${label}.samples must be a non-negative safe integer`);
  }
  const mean = finiteNumber(raw.mean, `${label}.mean`);
  const m2 = finiteNumber(raw.m2, `${label}.m2`);
  if (m2 < 0) throw new TypeError(`${label}.m2 must be non-negative`);
  if (samples === 0 && (mean !== 0 || m2 !== 0)) {
    throw new TypeError(`${label} with zero samples must have zero mean and m2`);
  }
  return { samples, mean, m2 };
}

function createNode(actions) {
  const node = {
    actions: [],
    regretSum: Object.create(null),
    strategySum: Object.create(null),
    actionValues: Object.create(null),
    visits: 0,
    traverserVisits: 0,
  };
  mergeActions(node, actions);
  return node;
}

function mergeActions(node, actions) {
  for (const action of uniqueActions(actions)) {
    if (!node.actions.includes(action)) {
      node.actions.push(action);
      node.regretSum[action] = 0;
      node.strategySum[action] = 0;
      node.actionValues[action] = emptyActionValue();
    }
  }
  node.actions.sort();
}

/** Regret matching restricted to the actions legal in the current state. */
export function regretMatching(node, legalActions = node?.actions) {
  const actions = uniqueActions(legalActions);
  let total = 0;
  const result = Object.create(null);
  for (const action of actions) {
    const positive = Math.max(0, finiteNumber(node?.regretSum?.[action] ?? 0,
      `regret(${action})`));
    result[action] = positive;
    total += positive;
  }
  if (total > 0) {
    for (const action of actions) result[action] /= total;
  } else {
    for (const action of actions) result[action] = 1 / actions.length;
  }
  return result;
}

function averageStrategy(node) {
  let total = 0;
  for (const action of node.actions) total += Math.max(0, node.strategySum[action] || 0);
  if (total <= 0) return regretMatching(node, node.actions);
  const result = Object.create(null);
  for (const action of node.actions) result[action] = Math.max(0, node.strategySum[action] || 0) / total;
  return result;
}

function assertAdapter(adapter) {
  const required = [
    'createInitialState', 'isTerminal', 'utility', 'currentPlayer',
    'legalActions', 'nextState', 'infoSetKey',
  ];
  for (const method of required) {
    if (typeof adapter?.[method] !== 'function') {
      throw new TypeError(`MCCFR adapter is missing ${method}()`);
    }
  }
  if (!Number.isInteger(adapter.playerCount) || adapter.playerCount < 2 || adapter.playerCount > 9) {
    throw new RangeError('MCCFR adapter.playerCount must be an integer in 2..9');
  }
}

/**
 * External-sampling Monte-Carlo CFR.
 *
 * Chance and non-traverser actions are sampled; every legal traverser action
 * is enumerated.  In two-player zero-sum perfect-recall games this is a
 * standard MCCFR estimator.  With multiplayer games or the lossy QYJ buckets,
 * it remains a practical regret-minimisation approximation and has no Nash
 * convergence guarantee.
 */
export class ExternalSamplingMccfr {
  constructor(adapter, {
    seed = 'qyj-blueprint',
    maxDepth = 160,
    blendWeight = 0.35,
  } = {}) {
    assertAdapter(adapter);
    if (!Number.isInteger(maxDepth) || maxDepth < 1) {
      throw new RangeError('maxDepth must be a positive integer');
    }
    this.adapter = adapter;
    this.rng = new SerializableRng(seed);
    this.maxDepth = maxDepth;
    this.blendWeight = Math.max(0, Math.min(1, finiteNumber(blendWeight, 'blendWeight')));
    this.iterations = 0;
    this.nodes = new Map();
    this.utilitySamples = 0;
  }

  _node(key, actions) {
    const normalizedKey = String(key || '');
    if (!normalizedKey) throw new TypeError('infoSetKey() must return a non-empty string');
    let node = this.nodes.get(normalizedKey);
    if (!node) {
      node = createNode(actions);
      this.nodes.set(normalizedKey, node);
    } else {
      // Lossy abstractions can map states with slightly different legal sets
      // together.  Keep their union, while regret matching below is always
      // restricted to the current state's legal subset.
      mergeActions(node, actions);
    }
    return node;
  }

  _terminalUtility(state, traverser) {
    this.utilitySamples++;
    return finiteNumber(this.adapter.utility(state, traverser), 'terminal utility');
  }

  _traverse(state, traverser, ownReach, iterationWeight, depth) {
    if (depth > this.maxDepth) {
      throw new RangeError(`MCCFR traversal exceeded maxDepth=${this.maxDepth}`);
    }
    if (this.adapter.isTerminal(state)) return this._terminalUtility(state, traverser);

    const actor = this.adapter.currentPlayer(state);
    if (actor === 'chance' || actor == null) {
      if (typeof this.adapter.sampleChance !== 'function') {
        throw new TypeError('Chance state requires adapter.sampleChance(state, rng)');
      }
      return this._traverse(
        this.adapter.sampleChance(state, this.rng), traverser, ownReach, iterationWeight, depth + 1,
      );
    }
    if (!Number.isInteger(actor) || actor < 0 || actor >= this.adapter.playerCount) {
      throw new RangeError(`currentPlayer() returned invalid zero-based player ${actor}`);
    }

    const actions = uniqueActions(this.adapter.legalActions(state));
    const key = this.adapter.infoSetKey(state, actor);
    const node = this._node(key, actions);
    const strategy = regretMatching(node, actions);
    node.visits++;

    if (actor === traverser) {
      node.traverserVisits++;
      // Linear averaging improves the practical blueprint without changing
      // the regret update estimator itself.
      for (const action of actions) {
        node.strategySum[action] += iterationWeight * ownReach * strategy[action];
      }
      const actionUtilities = Object.create(null);
      let nodeUtility = 0;
      for (const action of actions) {
        const utility = this._traverse(
          this.adapter.nextState(state, action),
          traverser,
          ownReach * strategy[action],
          iterationWeight,
          depth + 1,
        );
        actionUtilities[action] = utility;
        nodeUtility += strategy[action] * utility;
      }
      for (const action of actions) {
        updateActionValue(
          node.actionValues[action],
          actionUtilities[action],
          `action utility(${key}, ${action})`,
        );
      }
      for (const action of actions) node.regretSum[action] += actionUtilities[action] - nodeUtility;
      return nodeUtility;
    }

    const probabilities = actions.map((action) => strategy[action]);
    const sampledAction = actions[sampleIndex(probabilities, this.rng)];
    return this._traverse(
      this.adapter.nextState(state, sampledAction),
      traverser,
      ownReach,
      iterationWeight,
      depth + 1,
    );
  }

  train(additionalIterations, { onProgress = null } = {}) {
    if (!Number.isInteger(additionalIterations) || additionalIterations < 0) {
      throw new RangeError('additionalIterations must be a non-negative integer');
    }
    for (let step = 0; step < additionalIterations; step++) {
      const iterationWeight = this.iterations + 1;
      const iterationContext = Object.freeze({
        iteration: this.iterations,
        iterationWeight,
      });
      const requestedTraversers = typeof this.adapter.trainingPlayers === 'function'
        ? this.adapter.trainingPlayers(iterationContext)
        : Array.from({ length: this.adapter.playerCount }, (_, player) => player);
      if (!Array.isArray(requestedTraversers) || requestedTraversers.length === 0) {
        throw new TypeError('trainingPlayers() must return a non-empty player array');
      }
      const traversers = [...new Set(requestedTraversers.map(Number))];
      if (traversers.some((player) => !Number.isInteger(player)
        || player < 0 || player >= this.adapter.playerCount)) {
        throw new RangeError('trainingPlayers() returned an invalid zero-based player');
      }
      for (const traverser of traversers) {
        const root = this.adapter.createInitialState(this.rng, Object.freeze({
          ...iterationContext,
          traverser,
        }));
        this._traverse(root, traverser, 1, iterationWeight, 0);
      }
      this.iterations++;
      if (typeof onProgress === 'function') onProgress(this.summary());
    }
    return this.summary();
  }

  summary() {
    return Object.freeze({
      algorithm: 'external-sampling-mccfr',
      iterations: this.iterations,
      infoSets: this.nodes.size,
      utilitySamples: this.utilitySamples,
      rngState: this.rng.state >>> 0,
    });
  }

  toCheckpoint({ includeTrainerState = true, metadata = {} } = {}) {
    const infosets = Object.create(null);
    const serializedNodes = Object.create(null);
    for (const key of [...this.nodes.keys()].sort()) {
      const node = this.nodes.get(key);
      // A node seen only while another player was the traverser has not yet
      // received a regret/average-strategy update. Keep it for resume, but do
      // not publish a misleading uniform runtime strategy with fake confidence.
      if (node.traverserVisits > 0) {
        infosets[key] = {
          strategy: { ...averageStrategy(node) },
          visits: node.traverserVisits,
          actionValues: Object.fromEntries(node.actions.map((action) => [
            action,
            serializeActionValue(node.actionValues[action]),
          ])),
        };
      }
      if (includeTrainerState) {
        serializedNodes[key] = {
          actions: [...node.actions],
          regretSum: Object.fromEntries(node.actions.map((action) => [action, node.regretSum[action]])),
          strategySum: Object.fromEntries(node.actions.map((action) => [action, node.strategySum[action]])),
          actionValues: Object.fromEntries(node.actions.map((action) => [
            action,
            serializeActionValue(node.actionValues[action]),
          ])),
          visits: node.visits,
          traverserVisits: node.traverserVisits,
        };
      }
    }
    const checkpoint = {
      schema: BLUEPRINT_SCHEMA,
      version: BLUEPRINT_VERSION,
      metadata: {
        ...metadata,
        algorithm: 'external-sampling-mccfr',
        iterations: this.iterations,
        playerCount: this.adapter.playerCount,
        abstraction: BLUEPRINT_ABSTRACTION,
        guarantee: this.adapter.playerCount === 2
          ? 'MCCFR estimator; abstraction and capped action tree remain approximate'
          : 'multiplayer regret-minimisation approximation; no Nash convergence guarantee',
      },
      blendWeight: this.blendWeight,
      infosets,
    };
    if (includeTrainerState) {
      checkpoint.trainerState = {
        iterations: this.iterations,
        utilitySamples: this.utilitySamples,
        maxDepth: this.maxDepth,
        rng: this.rng.snapshot(),
        nodes: serializedNodes,
      };
    }
    return checkpoint;
  }

  static fromCheckpoint(adapter, checkpoint) {
    assertAdapter(adapter);
    if (!checkpoint || checkpoint.schema !== BLUEPRINT_SCHEMA
      || Number(checkpoint.version) !== BLUEPRINT_VERSION) {
      throw new TypeError(`Expected ${BLUEPRINT_SCHEMA} checkpoint`);
    }
    if (checkpoint.metadata?.abstraction !== BLUEPRINT_ABSTRACTION) {
      throw new TypeError(`Expected blueprint abstraction ${BLUEPRINT_ABSTRACTION}`);
    }
    if (checkpoint.metadata?.algorithm !== 'external-sampling-mccfr') {
      throw new TypeError('Expected external-sampling-mccfr trainer checkpoint');
    }
    const saved = checkpoint.trainerState;
    if (!saved || !saved.rng || !saved.nodes || typeof saved.nodes !== 'object') {
      throw new TypeError('Checkpoint has no resumable trainerState');
    }
    if (Number(checkpoint.metadata?.playerCount) !== adapter.playerCount) {
      throw new RangeError('Checkpoint playerCount does not match adapter');
    }
    const iterations = nonNegativeInteger(saved.iterations, 'trainerState.iterations');
    const utilitySamples = nonNegativeInteger(
      saved.utilitySamples, 'trainerState.utilitySamples',
    );
    if (checkpoint.metadata?.iterations != null) {
      const metadataIterations = nonNegativeInteger(
        checkpoint.metadata.iterations, 'metadata.iterations',
      );
      if (metadataIterations !== iterations) {
        throw new RangeError('metadata.iterations does not match trainerState.iterations');
      }
    }
    if (checkpoint.metadata?.seed != null
      && String(checkpoint.metadata.seed) !== String(saved.rng.seed)) {
      throw new RangeError('metadata.seed does not match trainerState.rng.seed');
    }
    const trainer = new ExternalSamplingMccfr(adapter, {
      seed: saved.rng.seed,
      maxDepth: Number(saved.maxDepth),
      blendWeight: checkpoint.blendWeight,
    });
    trainer.rng = SerializableRng.restore(saved.rng);
    trainer.iterations = iterations;
    trainer.utilitySamples = utilitySamples;
    for (const key of Object.keys(saved.nodes).sort()) {
      const source = saved.nodes[key];
      const node = createNode(source.actions);
      const savedActionValues = source.actionValues;
      if (savedActionValues != null
        && (typeof savedActionValues !== 'object' || Array.isArray(savedActionValues))) {
        throw new TypeError(`checkpoint action values(${key}) must be an object`);
      }
      for (const action of node.actions) {
        node.regretSum[action] = finiteNumber(source.regretSum?.[action] ?? 0,
          `checkpoint regret(${action})`);
        node.strategySum[action] = Math.max(0, finiteNumber(source.strategySum?.[action] ?? 0,
          `checkpoint strategy(${action})`));
        node.actionValues[action] = restoreActionValue(
          savedActionValues?.[action],
          `checkpoint action value(${key}, ${action})`,
        );
      }
      node.visits = nonNegativeInteger(source.visits, `checkpoint visits(${key})`);
      node.traverserVisits = nonNegativeInteger(
        source.traverserVisits, `checkpoint traverserVisits(${key})`,
      );
      for (const action of node.actions) {
        if (node.actionValues[action].samples > node.traverserVisits) {
          throw new RangeError(
            `checkpoint action value samples(${key}, ${action}) exceed traverser visits`,
          );
        }
      }
      trainer.nodes.set(key, node);
    }
    return trainer;
  }
}
