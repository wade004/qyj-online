import {
  actionToBlueprintKey,
  blueprintActionKeysForMask,
} from '../../js/game/blueprint-policy.js';
import { compactResidualFeatures } from '../../js/game/blueprint-residual-policy.js';
import {
  COMPACT_RESIDUAL_ROWS_SCHEMA,
  COMPACT_RESIDUAL_ROWS_VERSION,
  validateCompactResidualRowDataset,
} from './residual-contract.mjs';

const GROUP = /^pg_[0-9a-f]{64}$/;
const SECRET = /^ps_[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{64}$/;

function actionKey(entry) {
  if (typeof entry?.actionKey === 'string') return entry.actionKey;
  return actionToBlueprintKey(entry?.action || entry);
}

function completeDistribution(raw, actionKeys, label) {
  if (!Array.isArray(raw) || raw.length < 1) throw new TypeError(`${label} must be an array`);
  const totals = Object.fromEntries(actionKeys.map((key) => [key, 0]));
  for (const entry of raw) {
    const key = actionKey(entry);
    const probability = Number(entry?.probability);
    if (!(key in totals) || !Number.isFinite(probability) || probability < 0) {
      throw new RangeError(`${label} contains an illegal action probability`);
    }
    totals[key] += probability;
  }
  const sum = Object.values(totals).reduce((total, value) => total + value, 0);
  if (!(sum > 0) || !Number.isFinite(sum)) throw new RangeError(`${label} has no mass`);
  for (const key of actionKeys) totals[key] /= sum;
  return totals;
}

function profileSource(raw) {
  const sha256 = String(raw?.sha256 || '').toLowerCase();
  const tableSize = Number(raw?.tableSize);
  const sourceGroups = [...(raw?.sourceGroups || [])].sort();
  if (!SHA.test(sha256) || !Number.isInteger(tableSize) || tableSize < 2 || tableSize > 9
    || !sourceGroups.length || sourceGroups.some((group) => !GROUP.test(group))
    || new Set(sourceGroups).size !== sourceGroups.length) {
    throw new TypeError('invalid residual profile source');
  }
  return { sha256, tableSize, sourceGroups };
}

/** Aggregate complete base/target vectors without retaining raw seeds. */
export class CompactResidualRowCollector {
  constructor({ sourceGroupSecretId, exactOnly = true } = {}) {
    if (!SECRET.test(String(sourceGroupSecretId || ''))) {
      throw new TypeError('residual collector requires an opaque sourceGroupSecretId');
    }
    this.sourceGroupSecretId = sourceGroupSecretId;
    this.exactOnly = exactOnly !== false;
    this.entries = new Map();
    this.rejected = Object.create(null);
  }

  reject(reason) {
    this.rejected[reason] = (this.rejected[reason] || 0) + 1;
    return false;
  }

  observe(record) {
    if (!record || typeof record !== 'object') return this.reject('invalid-record');
    if (!GROUP.test(String(record.sourceGroup || ''))) return this.reject('missing-source-group');
    if (this.exactOnly && record.backoffLevel !== 'exact') return this.reject('not-exact-target');
    const encoded = compactResidualFeatures(record.exactKey);
    if (!encoded) return this.reject('invalid-information-set');
    if (!Array.isArray(record.targetStrategy)) return this.reject('target-distribution-missing');
    let baseStrategy;
    let targetStrategy;
    try {
      const actions = blueprintActionKeysForMask(encoded.mask);
      baseStrategy = completeDistribution(record.baseStrategy, actions, 'baseStrategy');
      targetStrategy = completeDistribution(record.targetStrategy, actions, 'targetStrategy');
    } catch {
      return this.reject('invalid-distribution');
    }
    const targetLevel = String(record.backoffLevel || '');
    if (!['exact', 'history', 'position', 'strategic', 'population'].includes(targetLevel)) {
      return this.reject('unsupported-target-level');
    }
    const identity = `${record.sourceGroup}\u0000${record.exactKey}`;
    let entry = this.entries.get(identity);
    if (!entry) {
      entry = {
        informationSetKey: record.exactKey,
        sourceGroup: record.sourceGroup,
        targetLevel,
        actionKeys: Object.keys(baseStrategy),
        baseSums: Object.fromEntries(Object.keys(baseStrategy).map((key) => [key, 0])),
        targetSums: Object.fromEntries(Object.keys(baseStrategy).map((key) => [key, 0])),
        reachWeight: 0,
      };
      this.entries.set(identity, entry);
    } else if (entry.targetLevel !== targetLevel) {
      // Prefer the narrower target if one root is observed through different
      // publication levels in the same independent group.
      const order = ['exact', 'history', 'position', 'strategic', 'population'];
      if (order.indexOf(targetLevel) < order.indexOf(entry.targetLevel)) {
        entry.targetLevel = targetLevel;
        entry.baseSums = Object.fromEntries(entry.actionKeys.map((key) => [key, 0]));
        entry.targetSums = Object.fromEntries(entry.actionKeys.map((key) => [key, 0]));
        entry.reachWeight = 0;
      } else {
        return this.reject('coarser-duplicate-target');
      }
    }
    entry.reachWeight++;
    for (const key of entry.actionKeys) {
      entry.baseSums[key] += baseStrategy[key];
      entry.targetSums[key] += targetStrategy[key];
    }
    return true;
  }

  finalize({ profileSources } = {}) {
    const sources = (profileSources || []).map(profileSource)
      .sort((left, right) => left.sha256.localeCompare(right.sha256));
    const rows = [...this.entries.values()]
      .sort((left, right) => left.sourceGroup.localeCompare(right.sourceGroup)
        || left.informationSetKey.localeCompare(right.informationSetKey))
      .map((entry) => ({
        informationSetKey: entry.informationSetKey,
        baseStrategy: Object.fromEntries(entry.actionKeys.map((key) => [
          key, entry.baseSums[key] / entry.reachWeight,
        ])),
        targetStrategy: Object.fromEntries(entry.actionKeys.map((key) => [
          key, entry.targetSums[key] / entry.reachWeight,
        ])),
        sourceGroup: entry.sourceGroup,
        targetLevel: entry.targetLevel,
        reachWeight: entry.reachWeight,
        independentActionAdvantages: null,
      }));
    if (!rows.length) throw new RangeError('residual collector retained no exact target rows');
    const artifact = {
      schema: COMPACT_RESIDUAL_ROWS_SCHEMA,
      version: COMPACT_RESIDUAL_ROWS_VERSION,
      profileSchema: 'qyj-exact-infoset-reach-profile-v2',
      profileVersion: 2,
      sourceGroupSecretId: this.sourceGroupSecretId,
      profileSources: sources,
      rows,
    };
    validateCompactResidualRowDataset(artifact);
    return Object.freeze(artifact);
  }

  summary() {
    return Object.freeze({
      exactRoots: this.entries.size,
      retainedDecisions: [...this.entries.values()].reduce(
        (sum, entry) => sum + entry.reachWeight, 0,
      ),
      rejected: Object.freeze({ ...this.rejected }),
    });
  }
}

/** Complete QYZ distributions for every profiled decision, target hit or not. */
export class CompactResidualBaseRowCollector {
  constructor({ sourceGroupSecretId } = {}) {
    if (!SECRET.test(String(sourceGroupSecretId || ''))) {
      throw new TypeError('base-row collector requires an opaque sourceGroupSecretId');
    }
    this.sourceGroupSecretId = sourceGroupSecretId;
    this.entries = new Map();
    this.rejected = Object.create(null);
  }

  observe(record) {
    const encoded = compactResidualFeatures(record?.exactKey);
    if (!encoded || !GROUP.test(String(record?.sourceGroup || ''))) return false;
    const actions = blueprintActionKeysForMask(encoded.mask);
    let baseStrategy;
    try {
      baseStrategy = completeDistribution(record.baseStrategy, actions, 'baseStrategy');
    } catch {
      this.rejected.invalidDistribution = (this.rejected.invalidDistribution || 0) + 1;
      return false;
    }
    const identity = `${record.sourceGroup}\u0000${record.exactKey}`;
    let entry = this.entries.get(identity);
    if (!entry) {
      entry = {
        informationSetKey: record.exactKey,
        sourceGroup: record.sourceGroup,
        actionKeys: actions,
        sums: Object.fromEntries(actions.map((action) => [action, 0])),
        reachWeight: 0,
      };
      this.entries.set(identity, entry);
    }
    entry.reachWeight++;
    for (const action of actions) entry.sums[action] += baseStrategy[action];
    return true;
  }

  finalize({ profileSources } = {}) {
    const sources = (profileSources || []).map(profileSource)
      .sort((left, right) => left.sha256.localeCompare(right.sha256));
    const artifact = {
      schema: 'qyj-compact-residual-base-rows-v1',
      version: 1,
      profileSchema: 'qyj-exact-infoset-reach-profile-v2',
      profileVersion: 2,
      sourceGroupSecretId: this.sourceGroupSecretId,
      profileSources: sources,
      rows: [...this.entries.values()].sort((left, right) => (
        left.sourceGroup.localeCompare(right.sourceGroup)
          || left.informationSetKey.localeCompare(right.informationSetKey)
      )).map((entry) => ({
        informationSetKey: entry.informationSetKey,
        baseStrategy: Object.fromEntries(entry.actionKeys.map((action) => [
          action, entry.sums[action] / entry.reachWeight,
        ])),
        sourceGroup: entry.sourceGroup,
        reachWeight: entry.reachWeight,
      })),
    };
    if (!artifact.rows.length) throw new RangeError('base-row collector retained no rows');
    return Object.freeze(artifact);
  }

  summary() {
    return Object.freeze({
      rows: this.entries.size,
      decisions: [...this.entries.values()].reduce((sum, entry) => sum + entry.reachWeight, 0),
      rejected: Object.freeze({ ...this.rejected }),
    });
  }
}

/** Option-induced next decisions, aggregated without retaining raw seeds. */
export class CompactResidualSuccessorCollector {
  constructor({ sourceGroupSecretId } = {}) {
    if (!SECRET.test(String(sourceGroupSecretId || ''))) {
      throw new TypeError('successor collector requires an opaque sourceGroupSecretId');
    }
    this.sourceGroupSecretId = sourceGroupSecretId;
    this.entries = new Map();
    this.rejected = Object.create(null);
  }

  reject(reason) {
    this.rejected[reason] = (this.rejected[reason] || 0) + 1;
    return false;
  }

  observe(record) {
    if (!GROUP.test(String(record?.sourceGroup || ''))) return this.reject('source-group');
    const start = compactResidualFeatures(record?.startInformationSetKey);
    const successor = compactResidualFeatures(record?.successorInformationSetKey);
    if (!start || !successor) return this.reject('information-set');
    const tableSize = Number(record.tableSize);
    if (!Number.isInteger(tableSize) || tableSize < 2 || tableSize > 9) {
      return this.reject('table-size');
    }
    const reason = record.reason == null ? null : String(record.reason).slice(0, 120);
    const actionKeys = blueprintActionKeysForMask(successor.mask);
    let baseDistribution;
    try {
      baseDistribution = completeDistribution(
        record.baseDistribution, actionKeys, 'successorBaseDistribution',
      );
    } catch {
      return this.reject('base-distribution');
    }
    const identity = [record.sourceGroup, record.startInformationSetKey,
      record.successorInformationSetKey].join('\u0000');
    let entry = this.entries.get(identity);
    if (!entry) {
      entry = {
        sourceGroup: record.sourceGroup,
        tableSize,
        startInformationSetKey: record.startInformationSetKey,
        successorInformationSetKey: record.successorInformationSetKey,
        startMask: start.mask,
        successorMask: successor.mask,
        attempts: 0,
        continuations: 0,
        aborts: 0,
        reasons: Object.create(null),
        actionKeys,
        baseSums: Object.fromEntries(actionKeys.map((action) => [action, 0])),
      };
      this.entries.set(identity, entry);
    }
    entry.attempts++;
    if (record.continued === true) entry.continuations++;
    if (record.aborted === true) entry.aborts++;
    if (reason) entry.reasons[reason] = (entry.reasons[reason] || 0) + 1;
    for (const action of actionKeys) entry.baseSums[action] += baseDistribution[action];
    return true;
  }

  finalize({ profileSources } = {}) {
    const sources = (profileSources || []).map(profileSource)
      .sort((left, right) => left.sha256.localeCompare(right.sha256));
    const rows = [...this.entries.values()].sort((left, right) => (
      left.sourceGroup.localeCompare(right.sourceGroup)
      || left.startInformationSetKey.localeCompare(right.startInformationSetKey)
      || left.successorInformationSetKey.localeCompare(right.successorInformationSetKey)
    )).map((entry) => ({
      sourceGroup: entry.sourceGroup,
      tableSize: entry.tableSize,
      startInformationSetKey: entry.startInformationSetKey,
      successorInformationSetKey: entry.successorInformationSetKey,
      startMask: entry.startMask,
      successorMask: entry.successorMask,
      attempts: entry.attempts,
      continuations: entry.continuations,
      aborts: entry.aborts,
      reasons: { ...entry.reasons },
      baseStrategy: Object.fromEntries(entry.actionKeys.map((action) => [
        action, entry.baseSums[action] / entry.attempts,
      ])),
    }));
    if (!rows.length) throw new RangeError('successor collector retained no rows');
    return Object.freeze({
      schema: 'qyj-residual-option-successors-v1',
      version: 1,
      mode: 'offline-evaluation-only',
      sourceGroupSecretId: this.sourceGroupSecretId,
      profileSources: sources,
      rows,
      promotionEligible: false,
      promotionBlockers: ['successor-coverage-below-formal-scale', 'offline-evaluation-only'],
    });
  }

  summary() {
    const rows = [...this.entries.values()];
    return Object.freeze({
      rows: rows.length,
      attempts: rows.reduce((sum, row) => sum + row.attempts, 0),
      continuations: rows.reduce((sum, row) => sum + row.continuations, 0),
      aborts: rows.reduce((sum, row) => sum + row.aborts, 0),
      rejected: Object.freeze({ ...this.rejected }),
    });
  }
}

export function mergeCompactResidualRowDatasets(datasets) {
  if (!Array.isArray(datasets) || datasets.length < 1) {
    throw new TypeError('at least one residual dataset is required');
  }
  const validated = datasets.map(validateCompactResidualRowDataset);
  const secret = validated[0].sourceGroupSecretId;
  if (validated.some((dataset) => dataset.sourceGroupSecretId !== secret)) {
    throw new RangeError('residual datasets use different source-group secrets');
  }
  const groups = new Set();
  const identities = new Set();
  for (const dataset of validated) {
    for (const group of dataset.sourceGroups) {
      if (groups.has(group)) throw new RangeError('residual dataset source groups overlap');
      groups.add(group);
    }
    for (const row of dataset.rows) {
      const identity = `${row.sourceGroup}\u0000${row.informationSetKey}`;
      if (identities.has(identity)) throw new RangeError('residual dataset rows overlap');
      identities.add(identity);
    }
  }
  const artifact = {
    schema: COMPACT_RESIDUAL_ROWS_SCHEMA,
    version: COMPACT_RESIDUAL_ROWS_VERSION,
    profileSchema: 'qyj-exact-infoset-reach-profile-v2',
    profileVersion: 2,
    sourceGroupSecretId: secret,
    profileSources: datasets.flatMap((dataset) => dataset.profileSources),
    rows: datasets.flatMap((dataset) => dataset.rows),
  };
  validateCompactResidualRowDataset(artifact);
  return Object.freeze(artifact);
}
