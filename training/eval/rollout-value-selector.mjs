import { createHash } from 'node:crypto';

import {
  COMPACT_RESIDUAL_FEATURE_ORDER,
  compactResidualFeatures,
} from '../../js/game/blueprint-residual-policy.js';

export const ROLLOUT_VALUE_SELECTOR_SCHEMA = 'qyj-rollout-value-selector-v1';

const INTERACTIONS = Object.freeze([
  ['s', 'h'], ['s', 'b'], ['s', 'spr'], ['h', 'b'], ['h', 'spr'],
  ['stk', 'spr'], ['p', 'ip'], ['a', 'ao'], ['r', 'rc'], ['r', 'rr'],
  ['tc', 'b'], ['cl', 'h'], ['jm', 'r'],
]);
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = (value) => createHash('sha256').update(String(value)).digest('hex');

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function featureTokens(row) {
  const prefix = `${row.tableSize}|${row.baseActionKey}>${row.actionKey}`;
  const tokens = [
    'bias',
    `table=${row.tableSize}`,
    `base=${row.baseActionKey}`,
    `action=${row.actionKey}`,
    `pair=${prefix}`,
    `mask=${row.mask}`,
    `pair-mask=${prefix}|${row.mask}`,
  ];
  for (const field of COMPACT_RESIDUAL_FEATURE_ORDER) {
    const value = row.features[field];
    tokens.push(`f:${field}=${value}`);
    tokens.push(`a:${row.actionKey}|${field}=${value}`);
    tokens.push(`p:${prefix}|${field}=${value}`);
  }
  for (const [left, right] of INTERACTIONS) {
    const value = `${left}=${row.features[left]}|${right}=${row.features[right]}`;
    tokens.push(`i:${value}`);
    tokens.push(`ai:${row.actionKey}|${value}`);
  }
  return tokens;
}

function sparseFeatures(row, dimension) {
  const buckets = new Map();
  for (const token of featureTokens(row)) {
    const hash = fnv1a(token);
    const index = hash % dimension;
    const sign = (hash & 0x80000000) === 0 ? 1 : -1;
    buckets.set(index, (buckets.get(index) || 0) + sign);
  }
  return [...buckets.entries()].sort((left, right) => left[0] - right[0]);
}

function dot(weights, sparse) {
  let value = 0;
  for (const [index, amount] of sparse) value += weights[index] * amount;
  return value;
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-Math.min(40, value)));
  const exp = Math.exp(Math.max(-40, value));
  return exp / (1 + exp);
}

function componentPartitions(roots) {
  const parent = roots.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };
  const owner = new Map();
  roots.forEach((root, index) => root.sourceGroups.forEach((group) => {
    if (owner.has(group)) union(index, owner.get(group));
    else owner.set(group, index);
  }));
  const components = new Map();
  roots.forEach((root, index) => {
    const key = find(index);
    const bucket = components.get(key) || [];
    bucket.push(root);
    components.set(key, bucket);
  });
  const allocations = new Map();
  for (const tableSize of [6, 9]) {
    const tableComponents = [...components.values()].filter(
      (component) => component[0].tableSize === tableSize,
    ).sort((left, right) => right.length - left.length
      || digest(left.map((root) => root.informationSetKey).sort().join('|')).localeCompare(
        digest(right.map((root) => root.informationSetKey).sort().join('|')),
      ));
    const total = tableComponents.reduce((sum, component) => sum + component.length, 0);
    const targets = { train: total * 0.6, calibration: total * 0.2, test: total * 0.2 };
    const counts = { train: 0, calibration: 0, test: 0 };
    for (const component of tableComponents) {
      const partition = ['train', 'calibration', 'test'].sort((left, right) => (
        (targets[right] - counts[right]) - (targets[left] - counts[left])
        || left.localeCompare(right)
      ))[0];
      const componentId = digest(component.map((root) => root.rootId).sort().join('|'));
      for (const root of component) allocations.set(root.rootId, { partition, componentId });
      counts[partition] += component.length;
    }
  }
  return allocations;
}

function guidanceRoots(guidances, minActualLowerBound) {
  const sources = Array.isArray(guidances) ? guidances : [guidances];
  const roots = [];
  for (const source of sources) {
    if (source?.schema !== 'qyj-public-belief-rollout-guidance-v1'
      || source?.mode !== 'offline-evaluation-only' || ![6, 9].includes(Number(source.tableSize))) {
      throw new TypeError('unsupported rollout guidance for value selector');
    }
    for (const [informationSetKey, record] of Object.entries(source.records || {})) {
      const encoded = compactResidualFeatures(informationSetKey);
      if (!encoded || !record.rollout || !(record.rollout.candidates || []).length) continue;
      const sourceGroups = [...new Set(record.sourceGroups || [])].sort();
      if (!sourceGroups.length) continue;
      const candidates = record.rollout.candidates.map((candidate) => {
        const actualLowerBound = finite(candidate.lowerBound, -1e6);
        return {
          tableSize: Number(source.tableSize),
          informationSetKey,
          mask: encoded.mask,
          features: encoded.features,
          baseActionKey: record.baseActionKey,
          actionKey: candidate.actionKey,
          actualLowerBound,
          positive: actualLowerBound >= minActualLowerBound,
        };
      });
      roots.push({
        rootId: `${Number(source.tableSize)}|${informationSetKey}`,
        informationSetKey,
        tableSize: Number(source.tableSize),
        sourceGroups,
        candidates,
      });
    }
  }
  return roots;
}

function trainLogistic(rows, { dimension, epochs, learningRate, l2 }) {
  const weights = new Float64Array(dimension);
  const positives = rows.filter((row) => row.positive).length;
  const negatives = rows.length - positives;
  const positiveWeight = Math.min(12, Math.max(1, negatives / Math.max(1, positives)));
  const sparseRows = rows.map((row) => ({ ...row, sparse: sparseFeatures(row, dimension) }));
  const gradient = new Float64Array(dimension);
  for (let epoch = 0; epoch < epochs; epoch++) {
    gradient.fill(0);
    for (const row of sparseRows) {
      const sampleWeight = row.positive ? positiveWeight : 1;
      const error = (sigmoid(dot(weights, row.sparse)) - Number(row.positive)) * sampleWeight;
      for (const [index, amount] of row.sparse) gradient[index] += error * amount;
    }
    const rate = learningRate / Math.sqrt(1 + epoch * 0.08);
    for (let index = 0; index < dimension; index++) {
      weights[index] -= rate * ((gradient[index] / rows.length) + l2 * weights[index]);
    }
  }
  return { weights: [...weights], positiveWeight, positives, negatives };
}

function scoreCandidate(model, row) {
  const weights = model.weightsByTable?.[row.tableSize] || model.weights;
  const logit = dot(weights, sparseFeatures(row, model.dimension));
  return { logit, probability: sigmoid(logit) };
}

function bestRows(model, roots) {
  return roots.map((root) => {
    const candidates = root.candidates.map((row) => ({ ...row, ...scoreCandidate(model, row) }))
      .sort((left, right) => right.logit - left.logit
        || right.actualLowerBound - left.actualLowerBound
        || left.actionKey.localeCompare(right.actionKey));
    return { root, selected: candidates[0] };
  });
}

function metrics(rows, threshold, minActualLowerBound) {
  const selected = rows.filter((row) => row.selected.logit >= threshold);
  const summarize = (subset) => {
    const positives = subset.filter(
      (row) => row.selected.actualLowerBound >= minActualLowerBound,
    ).length;
    return {
      roots: subset.length,
      positives,
      positivePrecision: subset.length ? positives / subset.length : 0,
      meanActualLowerBound: subset.length ? subset.reduce(
        (sum, row) => sum + row.selected.actualLowerBound, 0,
      ) / subset.length : null,
    };
  };
  return {
    selected: selected.length,
    ...summarize(selected),
    byTable: Object.fromEntries([6, 9].map((tableSize) => [
      tableSize, summarize(selected.filter((row) => row.root.tableSize === tableSize)),
    ])),
  };
}

function calibrationThreshold(rows, minActualLowerBound, minPrecision, minSelectedPerTable) {
  const thresholds = [...new Set(rows.map((row) => row.selected.logit))].sort((a, b) => b - a);
  const qualified = thresholds.map((threshold) => ({
    threshold,
    metrics: metrics(rows, threshold, minActualLowerBound),
  })).filter(({ metrics: result }) => [6, 9].every((tableSize) => {
    const table = result.byTable[tableSize];
    return table.roots >= minSelectedPerTable && table.positivePrecision >= minPrecision
      && table.meanActualLowerBound > 0;
  })).sort((left, right) => right.metrics.selected - left.metrics.selected
    || right.metrics.positivePrecision - left.metrics.positivePrecision
    || right.metrics.meanActualLowerBound - left.metrics.meanActualLowerBound
    || right.threshold - left.threshold);
  return qualified[0] || null;
}

function scoreDiagnostics(rows, minActualLowerBound) {
  return Object.fromEntries([6, 9].map((tableSize) => {
    const table = rows.filter((row) => row.root.tableSize === tableSize)
      .sort((left, right) => right.selected.logit - left.selected.logit
        || left.root.informationSetKey.localeCompare(right.root.informationSetKey));
    const points = [1, 3, 5, 10, 20, 50, table.length].filter(
      (count, index, values) => count <= table.length && values.indexOf(count) === index,
    );
    return [tableSize, {
      roots: table.length,
      positiveBestActions: table.filter(
        (row) => row.selected.actualLowerBound >= minActualLowerBound,
      ).length,
      top: Object.fromEntries(points.map((count) => [
        count, metrics(table.slice(0, count), -Infinity, minActualLowerBound),
      ])),
      scoreRange: table.length ? {
        min: table[table.length - 1].selected.logit,
        max: table[0].selected.logit,
      } : null,
    }];
  }));
}

export function buildRolloutValueSelector(guidances, {
  minActualLowerBound = 5,
  dimension = 8192,
  epochs = 240,
  learningRate = 0.32,
  l2 = 0.002,
  minPrecision = 0.75,
  minSelectedPerTable = 3,
} = {}) {
  if (!Number.isSafeInteger(dimension) || dimension < 256 || dimension > 65536
    || !Number.isSafeInteger(epochs) || epochs < 1 || epochs > 2000) {
    throw new RangeError('invalid rollout value model dimensions');
  }
  const sources = Array.isArray(guidances) ? guidances : [guidances];
  const roots = guidanceRoots(sources, minActualLowerBound);
  const allocations = componentPartitions(roots);
  for (const root of roots) Object.assign(root, allocations.get(root.rootId));
  const partitions = Object.fromEntries(['train', 'calibration', 'test'].map((partition) => [
    partition, roots.filter((root) => root.partition === partition),
  ]));
  const trainingRows = partitions.train.flatMap((root) => root.candidates);
  if (!trainingRows.some((row) => row.positive)) throw new RangeError('no positive training rows');
  const learnedByTable = Object.fromEntries([6, 9].map((tableSize) => [
    tableSize,
    trainLogistic(trainingRows.filter((row) => row.tableSize === tableSize), {
      dimension, epochs, learningRate, l2,
    }),
  ]));
  const model = {
    dimension,
    weightsByTable: Object.fromEntries([6, 9].map((tableSize) => [
      tableSize, learnedByTable[tableSize].weights,
    ])),
    featureSchema: 'fnv1a-signed-public-categorical-interactions-v1',
  };
  const calibrationBest = bestRows(model, partitions.calibration);
  const calibrated = calibrationThreshold(
    calibrationBest, minActualLowerBound, minPrecision, minSelectedPerTable,
  );
  const threshold = calibrated?.threshold ?? Number.POSITIVE_INFINITY;
  const calibration = calibrated?.metrics || metrics(
    calibrationBest, threshold, minActualLowerBound,
  );
  const testBest = bestRows(model, partitions.test);
  const test = metrics(testBest, threshold, minActualLowerBound);
  const partitionSummary = Object.fromEntries(Object.entries(partitions).map(([name, rows]) => [
    name,
    {
      roots: rows.length,
      candidates: rows.reduce((sum, root) => sum + root.candidates.length, 0),
      sourceGroups: new Set(rows.flatMap((root) => root.sourceGroups)).size,
      components: new Set(rows.map((root) => root.componentId)).size,
      byTable: Object.fromEntries([6, 9].map((tableSize) => [
        tableSize, rows.filter((root) => root.tableSize === tableSize).length,
      ])),
    },
  ]));
  const overlapPairs = [];
  ['train', 'calibration', 'test'].forEach((left, index, names) => (
    names.slice(index + 1).forEach((right) => {
      const leftGroups = new Set(partitions[left].flatMap((root) => root.sourceGroups));
      const shared = [...new Set(partitions[right].flatMap((root) => root.sourceGroups)
        .filter((group) => leftGroups.has(group)))].sort();
      if (shared.length) overlapPairs.push({ left, right, sourceGroups: shared });
    })
  ));
  const noGroupLeakage = overlapPairs.length === 0;
  const testPassed = Number.isFinite(threshold) && noGroupLeakage
    && [6, 9].every((tableSize) => test.byTable[tableSize].roots >= minSelectedPerTable
      && test.byTable[tableSize].positivePrecision >= minPrecision
      && test.byTable[tableSize].meanActualLowerBound > 0);
  return Object.freeze({
    schema: ROLLOUT_VALUE_SELECTOR_SCHEMA,
    version: 1,
    mode: 'offline-evaluation-only',
    guidanceSha256: Object.freeze(sources.map(sha).sort()),
    feature: Object.freeze({
      schema: model.featureSchema,
      dimension,
      interactions: INTERACTIONS,
    }),
    training: Object.freeze({
      epochs, learningRate, l2,
      rows: trainingRows.length,
      byTable: Object.fromEntries([6, 9].map((tableSize) => [tableSize, {
        rows: learnedByTable[tableSize].positives + learnedByTable[tableSize].negatives,
        positives: learnedByTable[tableSize].positives,
        negatives: learnedByTable[tableSize].negatives,
        positiveWeight: learnedByTable[tableSize].positiveWeight,
      }])),
    }),
    thresholds: Object.freeze({
      minActualLowerBound, minPrecision, minSelectedPerTable,
      minLogit: Number.isFinite(threshold) ? threshold : null,
    }),
    weightsByTable: Object.freeze(Object.fromEntries([6, 9].map((tableSize) => [
      tableSize, Object.freeze(learnedByTable[tableSize].weights),
    ]))),
    split: Object.freeze({
      method: 'shared-source-group-connected-components-60-20-20',
      noGroupLeakage,
      overlapPairs,
      partitions: partitionSummary,
    }),
    calibration: Object.freeze({ ...calibration, passed: Number.isFinite(threshold) }),
    test: Object.freeze({ ...test, passed: testPassed }),
    diagnostics: Object.freeze({
      calibration: scoreDiagnostics(calibrationBest, minActualLowerBound),
      test: scoreDiagnostics(testBest, minActualLowerBound),
    }),
    promotionEligible: false,
    promotionBlockers: Object.freeze([
      ...(testPassed ? [] : ['rollout-value-independent-test-failed']),
      'requires-real-engine-branch-calibration-and-fresh-league',
      'offline-evaluation-only',
    ]),
  });
}

export function validateRolloutValueSelector(raw) {
  if (raw?.schema !== ROLLOUT_VALUE_SELECTOR_SCHEMA || Number(raw?.version) !== 1
    || raw?.mode !== 'offline-evaluation-only' || raw?.test?.passed !== true
    || raw?.split?.noGroupLeakage !== true || ![6, 9].every((tableSize) => (
      Array.isArray(raw?.weightsByTable?.[tableSize])
      && raw.weightsByTable[tableSize].length === Number(raw?.feature?.dimension)
    ))
    || !Number.isFinite(Number(raw?.thresholds?.minLogit))) {
    throw new TypeError('unsupported or unvalidated rollout value selector');
  }
  return raw;
}

export function evaluateRolloutValueSelector(selector, {
  informationSetKey,
  tableSize,
  baseActionKey,
  legalActionKeys,
} = {}) {
  const source = validateRolloutValueSelector(selector);
  const encoded = compactResidualFeatures(informationSetKey);
  if (!encoded) return Object.freeze({ eligible: false, reason: 'invalid-information-set' });
  const legal = [...new Set(legalActionKeys || [])].filter((key) => key !== baseActionKey);
  const candidates = legal.map((actionKey) => {
    const row = {
      tableSize: Number(tableSize), baseActionKey, actionKey,
      mask: encoded.mask, features: encoded.features,
    };
    return { actionKey, ...scoreCandidate({
      dimension: Number(source.feature.dimension), weightsByTable: source.weightsByTable,
    }, row) };
  }).sort((left, right) => right.logit - left.logit || left.actionKey.localeCompare(right.actionKey));
  const selected = candidates[0];
  if (!selected || selected.logit < Number(source.thresholds.minLogit)) {
    return Object.freeze({ eligible: false, reason: 'rollout-value-below-threshold' });
  }
  return Object.freeze({ eligible: true, reason: null, ...selected });
}
