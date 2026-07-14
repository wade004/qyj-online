// Browser-safe compact residual-policy compiler and shadow evaluator.
// This schema has no active/intervention mode by design. A future deployable
// policy must use a new schema and independent promotion evidence.

import {
  BLUEPRINT_ABSTRACTION,
  actionToBlueprintKey,
  blueprintActionKeysForMask,
} from './blueprint-policy.js';

export const COMPACT_RESIDUAL_POLICY_SCHEMA = 'qyj-compact-residual-policy-v3';
export const COMPACT_RESIDUAL_POLICY_VERSION = 3;
export const COMPACT_RESIDUAL_POLICY_MODE = 'shadow-only';
export const COMPACT_RESIDUAL_FEATURE_SCHEMA = 'bp2-hierarchical-residual-features-v3';
export const COMPACT_RESIDUAL_ACTION_SCHEMA = 'bp2-legal-mask-heads-v1';
export const COMPACT_RESIDUAL_BASE_TRANSFORM = 'legal-support-floor-log-v2';
export const COMPACT_RESIDUAL_FEATURE_ORDER = Object.freeze([
  's', 'n', 'a', 'ao', 'p', 'ip', 'cl', 'h', 'b', 'stk', 'spr',
  'tc', 'r', 'rc', 'rr', 'jm',
]);

const KEY_FIELDS = Object.freeze([
  's', 'n', 'a', 'ao', 'p', 'ip', 'cl', 'h', 'b', 'stk', 'spr',
  'tc', 'r', 'rc', 'lm', 'rr', 'jm', 'x',
]);
const COMPILED = new WeakMap();
const SHA256 = /^[0-9a-f]{64}$/;

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} fields do not match the residual schema`);
  }
}

function finite(value, label, { min = -Number.MAX_VALUE, max = Number.MAX_VALUE } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new RangeError(`${label} must be finite in ${min}..${max}`);
  }
  return number;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new RangeError(`${label} must be an integer in ${min}..${max}`);
  }
  return number;
}

function nonEmptyString(value, label, max = 128) {
  if (typeof value !== 'string' || !value || value.length > max) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function vector(raw, width, label, bound = 32) {
  if (!Array.isArray(raw) || raw.length !== width) {
    throw new RangeError(`${label} must contain ${width} values`);
  }
  return Object.freeze(raw.map((value, index) => finite(
    value, `${label}[${index}]`, { min: -bound, max: bound },
  )));
}

function sortedUniqueStrings(raw, label, { min = 0, max = 4096 } = {}) {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max
    || raw.some((value) => typeof value !== 'string' || !value)) {
    throw new TypeError(`${label} must be a bounded string array`);
  }
  if (new Set(raw).size !== raw.length
    || raw.some((value, index) => index > 0 && value < raw[index - 1])) {
    throw new RangeError(`${label} must be unique and sorted`);
  }
  return Object.freeze([...raw]);
}

function orderedUniqueStrings(raw, label, { min = 0, max = 4096 } = {}) {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max
    || raw.some((value) => typeof value !== 'string' || !value)
    || new Set(raw).size !== raw.length) {
    throw new TypeError(`${label} must be a bounded unique string array`);
  }
  return Object.freeze([...raw]);
}

function parseExactKey(key) {
  if (typeof key !== 'string' || !key.startsWith('bp2|') || key.length > 4096) return null;
  const fields = new Map();
  for (const part of key.slice(4).split('|')) {
    const separator = part.indexOf('=');
    if (separator <= 0) return null;
    const name = part.slice(0, separator);
    if (fields.has(name) || name === 'bk') return null;
    try {
      fields.set(name, decodeURIComponent(part.slice(separator + 1)));
    } catch {
      return null;
    }
  }
  if (fields.size !== KEY_FIELDS.length
    || KEY_FIELDS.some((field) => !fields.has(field))) return null;
  return fields;
}

function positionGroup(value) {
  if (['BTN', 'CO', 'BTN/SB'].includes(value)) return 'late';
  if (['SB', 'BB'].includes(value)) return 'blind';
  if (['HJ', 'LJ', 'MP'].includes(value)) return 'middle';
  if (/^(UTG|EP)/.test(value)) return 'early';
  return 'other';
}

function coarseActive(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 'unknown';
  if (count <= 1) return 'hu';
  if (count === 2) return 'three';
  return 'multi';
}

function coarseCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 'unknown';
  if (count <= 0) return '0';
  if (count === 1) return '1';
  return '2+';
}

function coarseHand(value) {
  const label = String(value || 'unknown');
  const postflop = /^c(\d+)-m\d+-d(\d+)-b\d+$/.exec(label);
  if (postflop) return `c${postflop[1]}-d${Number(postflop[2]) > 0 ? 1 : 0}`;
  const preflop = /^([2-9TJQKA])([2-9TJQKA])([so])?$/.exec(label);
  if (!preflop) return label;
  const rank = (token) => '23456789TJQKA'.indexOf(token) + 2;
  const high = rank(preflop[1]);
  const low = rank(preflop[2]);
  if (!preflop[3]) {
    return high >= 10 ? 'pair-premium' : high >= 7 ? 'pair-middle' : 'pair-small';
  }
  const suited = preflop[3] === 's';
  const gap = Math.max(0, high - low - 1);
  const score = (high * 2 + low) / 42 + (suited ? 0.045 : 0)
    - Math.min(0.1, gap * 0.012);
  const bucket = score <= 0.56 ? 'h1' : score <= 0.66 ? 'h2'
    : score <= 0.75 ? 'h3' : score <= 0.84 ? 'h4' : 'h5';
  return `${bucket}-${suited ? 's' : 'o'}`;
}

function coarseBoard(value) {
  const parsed = /^(low|mid|high|ace)-w(\d)-p([01])-m([01])$/.exec(String(value || ''));
  if (!parsed) return String(value || 'unknown');
  return `${['high', 'ace'].includes(parsed[1]) ? 'hi' : 'lo'}`
    + `-w${Number(parsed[2]) >= 2 ? 1 : 0}-p${parsed[3]}-m${parsed[4]}`;
}

/** Strict public categorical feature extraction shared by trainer and browser. */
export function compactResidualFeatures(informationSetKey) {
  const fields = parseExactKey(informationSetKey);
  if (!fields) return null;
  const tableSize = Number(fields.get('n'));
  const mask = fields.get('lm').toLowerCase();
  if (!Number.isInteger(tableSize) || tableSize < 2 || tableSize > 9
    || fields.get('lm') !== mask) return null;
  try {
    blueprintActionKeysForMask(mask);
  } catch {
    return null;
  }
  const features = Object.freeze({
    s: fields.get('s'),
    n: String(tableSize),
    a: coarseActive(fields.get('a')),
    ao: coarseCount(fields.get('ao')),
    p: positionGroup(fields.get('p')),
    ip: fields.get('ip'),
    cl: fields.get('cl'),
    h: coarseHand(fields.get('h')),
    b: coarseBoard(fields.get('b')),
    stk: fields.get('stk'),
    spr: fields.get('spr'),
    tc: fields.get('tc'),
    r: fields.get('r'),
    rc: coarseCount(fields.get('rc')),
    rr: fields.get('rr'),
    jm: fields.get('jm'),
  });
  if (COMPACT_RESIDUAL_FEATURE_ORDER.some((field) => (
    typeof features[field] !== 'string' || !features[field]
  ))) return null;
  return Object.freeze({ mask, tableSize, features });
}

function compileCategorySupport(raw, label) {
  exactKeys(raw, ['rows', 'sourceGroups'], label);
  return Object.freeze({
    rows: integer(raw.rows, `${label}.rows`, { min: 1 }),
    sourceGroups: integer(raw.sourceGroups, `${label}.sourceGroups`, { min: 1 }),
  });
}

function compileSupport(raw, label) {
  exactKeys(raw, ['rows', 'sourceGroups', 'categories'], label);
  exactKeys(raw.categories, COMPACT_RESIDUAL_FEATURE_ORDER, `${label}.categories`);
  const categories = Object.create(null);
  for (const feature of COMPACT_RESIDUAL_FEATURE_ORDER) {
    const rawCategories = raw.categories[feature];
    if (!rawCategories || typeof rawCategories !== 'object' || Array.isArray(rawCategories)
      || Object.keys(rawCategories).length > 4096) {
      throw new TypeError(`${label}.categories.${feature} must be an object`);
    }
    categories[feature] = Object.freeze(Object.fromEntries(
      Object.keys(rawCategories).sort().map((category) => [
        category,
        compileCategorySupport(
          rawCategories[category], `${label}.categories.${feature}.${category}`,
        ),
      ]),
    ));
  }
  return Object.freeze({
    rows: integer(raw.rows, `${label}.rows`, { min: 1 }),
    sourceGroups: integer(raw.sourceGroups, `${label}.sourceGroups`, { min: 1 }),
    categories: Object.freeze(categories),
  });
}

function compileMember(raw, width, label) {
  exactKeys(raw, ['bias', 'features'], label);
  exactKeys(raw.features, COMPACT_RESIDUAL_FEATURE_ORDER, `${label}.features`);
  const features = Object.create(null);
  for (const feature of COMPACT_RESIDUAL_FEATURE_ORDER) {
    const source = raw.features[feature];
    if (!source || typeof source !== 'object' || Array.isArray(source)
      || Object.keys(source).length > 4096) {
      throw new TypeError(`${label}.features.${feature} must be an object`);
    }
    features[feature] = Object.freeze(Object.fromEntries(
      Object.keys(source).sort().map((category) => [
        category,
        vector(source[category], width, `${label}.features.${feature}.${category}`),
      ]),
    ));
  }
  return Object.freeze({
    bias: vector(raw.bias, width, `${label}.bias`),
    features: Object.freeze(features),
  });
}

function compileHead(raw, label, ensembleSize) {
  exactKeys(raw, ['mask', 'actionKeys', 'members', 'support'], label);
  const mask = nonEmptyString(raw.mask, `${label}.mask`, 8);
  if (mask !== mask.toLowerCase()) throw new RangeError(`${label}.mask must be lowercase`);
  const expectedActions = blueprintActionKeysForMask(mask);
  const actionKeys = orderedUniqueStrings(
    raw.actionKeys, `${label}.actionKeys`, { min: 1, max: 7 },
  );
  if (actionKeys.length !== expectedActions.length
    || actionKeys.some((action, index) => action !== expectedActions[index])) {
    throw new RangeError(`${label}.actionKeys must match the fixed mask tensor order`);
  }
  if (!Array.isArray(raw.members) || raw.members.length !== ensembleSize) {
    throw new RangeError(`${label}.members must match ensembleSize`);
  }
  return Object.freeze({
    mask,
    actionKeys,
    members: Object.freeze(raw.members.map((member, index) => compileMember(
      member, actionKeys.length, `${label}.members[${index}]`,
    ))),
    support: compileSupport(raw.support, `${label}.support`),
  });
}

/** Strict, bounded compiler. Unknown fields cannot turn this schema active. */
export function compileCompactResidualPolicy(raw) {
  if (raw && COMPILED.has(raw)) return raw;
  exactKeys(raw, [
    'schema', 'version', 'mode', 'contracts', 'feature', 'model', 'provenance',
  ], 'residual policy');
  if (raw.schema !== COMPACT_RESIDUAL_POLICY_SCHEMA
    || Number(raw.version) !== COMPACT_RESIDUAL_POLICY_VERSION
    || raw.mode !== COMPACT_RESIDUAL_POLICY_MODE) {
    throw new TypeError('unsupported compact residual policy');
  }
  exactKeys(raw.contracts, [
    'abstraction', 'featureSchema', 'actionSchema', 'basePolicyContract',
    'baseStyleKey', 'baseLogitTransform', 'epsilon',
  ], 'residual contracts');
  if (raw.contracts.abstraction !== BLUEPRINT_ABSTRACTION
    || raw.contracts.featureSchema !== COMPACT_RESIDUAL_FEATURE_SCHEMA
    || raw.contracts.actionSchema !== COMPACT_RESIDUAL_ACTION_SCHEMA
    || raw.contracts.baseLogitTransform !== COMPACT_RESIDUAL_BASE_TRANSFORM) {
    throw new TypeError('residual policy contract mismatch');
  }
  const contracts = Object.freeze({
    abstraction: raw.contracts.abstraction,
    featureSchema: raw.contracts.featureSchema,
    actionSchema: raw.contracts.actionSchema,
    basePolicyContract: nonEmptyString(
      raw.contracts.basePolicyContract, 'contracts.basePolicyContract',
    ),
    baseStyleKey: nonEmptyString(raw.contracts.baseStyleKey, 'contracts.baseStyleKey'),
    baseLogitTransform: raw.contracts.baseLogitTransform,
    epsilon: finite(raw.contracts.epsilon, 'contracts.epsilon', {
      min: 0.000001, max: 0.01,
    }),
  });
  exactKeys(raw.feature, ['order'], 'residual feature');
  if (!Array.isArray(raw.feature.order)
    || raw.feature.order.length !== COMPACT_RESIDUAL_FEATURE_ORDER.length
    || raw.feature.order.some((field, index) => field !== COMPACT_RESIDUAL_FEATURE_ORDER[index])) {
    throw new RangeError('residual feature order is unsupported');
  }
  exactKeys(raw.model, [
    'maxAbsResidual', 'minCategoryGroups', 'maxOodScore',
    'maxEpistemicStd', 'ensembleSize', 'heads',
  ], 'residual model');
  const ensembleSize = integer(raw.model.ensembleSize, 'model.ensembleSize', {
    min: 2, max: 16,
  });
  if (!Array.isArray(raw.model.heads) || raw.model.heads.length < 1
    || raw.model.heads.length > 127) {
    throw new RangeError('model.heads must contain 1..127 legal-mask heads');
  }
  const heads = raw.model.heads.map((head, index) => compileHead(
    head, `model.heads[${index}]`, ensembleSize,
  ));
  if (new Set(heads.map((head) => head.mask)).size !== heads.length
    || heads.some((head, index) => index > 0 && head.mask < heads[index - 1].mask)) {
    throw new RangeError('model heads must be unique and mask-sorted');
  }
  exactKeys(raw.provenance, [
    'trainerVersion', 'trainingManifestSha256',
  ], 'residual provenance');
  const manifestSha = String(raw.provenance.trainingManifestSha256 || '').toLowerCase();
  if (!SHA256.test(manifestSha)) {
    throw new TypeError('provenance.trainingManifestSha256 must be a SHA-256 digest');
  }
  const compiled = Object.freeze({
    schema: raw.schema,
    version: COMPACT_RESIDUAL_POLICY_VERSION,
    mode: COMPACT_RESIDUAL_POLICY_MODE,
    contracts,
    feature: Object.freeze({ order: COMPACT_RESIDUAL_FEATURE_ORDER }),
    model: Object.freeze({
      maxAbsResidual: finite(raw.model.maxAbsResidual, 'model.maxAbsResidual', {
        min: 0.01, max: 3,
      }),
      minCategoryGroups: integer(
        raw.model.minCategoryGroups, 'model.minCategoryGroups', { min: 2, max: 10_000 },
      ),
      maxOodScore: finite(raw.model.maxOodScore, 'model.maxOodScore', { min: 0, max: 1 }),
      maxEpistemicStd: finite(
        raw.model.maxEpistemicStd, 'model.maxEpistemicStd', { min: 0, max: 1 },
      ),
      ensembleSize,
      heads: Object.freeze(heads),
    }),
    provenance: Object.freeze({
      trainerVersion: nonEmptyString(raw.provenance.trainerVersion, 'provenance.trainerVersion'),
      trainingManifestSha256: manifestSha,
    }),
  });
  COMPILED.set(compiled, new Map(heads.map((head) => [head.mask, head])));
  return compiled;
}

export async function loadCompactResidualPolicy(source, {
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  if (source == null || source === false || source === '') return null;
  if (typeof source === 'object') return compileCompactResidualPolicy(source);
  if (typeof source !== 'string' || typeof fetchImpl !== 'function') {
    throw new TypeError('residual policy source must be an object or fetchable URL');
  }
  const response = await fetchImpl(source, { signal, credentials: 'same-origin' });
  if (!response?.ok) throw new Error(`Unable to load residual policy (${response?.status || 'network error'})`);
  return compileCompactResidualPolicy(await response.json());
}

function normalizedBaseDistribution(raw, actionKeys) {
  const totals = new Map(actionKeys.map((action) => [action, 0]));
  const entries = Array.isArray(raw) ? raw : Object.entries(raw || {}).map(
    ([actionKey, probability]) => ({ actionKey, probability }),
  );
  for (const entry of entries) {
    const actionKey = entry?.actionKey || actionToBlueprintKey(entry?.action || entry);
    const probability = Number(entry?.probability);
    if (!totals.has(actionKey) || !Number.isFinite(probability) || probability < 0) return null;
    totals.set(actionKey, totals.get(actionKey) + probability);
  }
  const total = [...totals.values()].reduce((sum, value) => sum + value, 0);
  if (!(total > 0) || !Number.isFinite(total)) return null;
  return Object.freeze(actionKeys.map((actionKey) => Object.freeze({
    actionKey,
    probability: totals.get(actionKey) / total,
  })));
}

function softmaxOffset(base, residual) {
  const scores = base.map((entry, index) => (
    entry.probability > 0 ? Math.log(entry.probability) + residual[index] : -Infinity
  ));
  const maximum = Math.max(...scores);
  const exps = scores.map((score) => (Number.isFinite(score) ? Math.exp(score - maximum) : 0));
  const total = exps.reduce((sum, value) => sum + value, 0);
  return base.map((entry, index) => Object.freeze({
    actionKey: entry.actionKey,
    probability: total > 0 ? exps[index] / total : entry.probability,
  }));
}

function legalSupportFloor(base, epsilon) {
  const denominator = 1 + epsilon * base.length;
  return Object.freeze(base.map((entry) => Object.freeze({
    actionKey: entry.actionKey,
    probability: (entry.probability + epsilon) / denominator,
  })));
}

function argmax(distribution) {
  return distribution.reduce((best, entry) => (
    !best || entry.probability > best.probability ? entry : best
  ), null)?.actionKey || null;
}

function totalVariation(left, right) {
  return left.reduce((sum, entry, index) => (
    sum + Math.abs(entry.probability - right[index].probability)
  ), 0) / 2;
}

function rejected(reason, extras = {}) {
  return Object.freeze({
    accepted: false,
    reason,
    shadowOnly: true,
    distribution: null,
    shadowTV: 0,
    shadowWouldChange: false,
    oodScore: 1,
    epistemicStd: 0,
    ...extras,
  });
}

/** Compute a hypothetical distribution; this function never samples/actions. */
export function predictCompactResidualPolicy(model, {
  informationSetKey,
  baseDistribution,
  basePolicyContract,
  baseStyleKey,
} = {}) {
  if (!model || !COMPILED.has(model)) return rejected('model-not-compiled');
  if (basePolicyContract !== model.contracts.basePolicyContract
    || baseStyleKey !== model.contracts.baseStyleKey) {
    return rejected('base-policy-contract-mismatch');
  }
  const encoded = compactResidualFeatures(informationSetKey);
  if (!encoded) return rejected('invalid-information-set');
  const head = COMPILED.get(model).get(encoded.mask);
  if (!head) return rejected('unsupported-legal-mask', { tableSize: encoded.tableSize });
  const base = normalizedBaseDistribution(baseDistribution, head.actionKeys);
  if (!base) return rejected('invalid-base-distribution', { tableSize: encoded.tableSize });
  let underSupported = 0;
  const fallbackFeatures = [];
  for (const feature of COMPACT_RESIDUAL_FEATURE_ORDER) {
    const support = head.support.categories[feature][encoded.features[feature]];
    if (!support || support.sourceGroups < model.model.minCategoryGroups) {
      const globalSupport = head.support.categories[feature].__GLOBAL__;
      if (globalSupport?.sourceGroups >= model.model.minCategoryGroups) {
        underSupported += 0.5;
        fallbackFeatures.push(feature);
      } else underSupported++;
    }
  }
  const oodScore = underSupported / COMPACT_RESIDUAL_FEATURE_ORDER.length;
  const transformedBase = legalSupportFloor(base, model.contracts.epsilon);
  const memberPredictions = head.members.map((member) => {
    const latent = [...member.bias];
    for (const feature of COMPACT_RESIDUAL_FEATURE_ORDER) {
      const exactSupport = head.support.categories[feature][encoded.features[feature]];
      const exactSupported = exactSupport?.sourceGroups >= model.model.minCategoryGroups;
      const weights = exactSupported
        ? member.features[feature][encoded.features[feature]]
        : member.features[feature].__GLOBAL__;
      if (!weights) continue;
      for (let index = 0; index < latent.length; index++) latent[index] += weights[index];
    }
    const residual = latent.map((value) => (
      model.model.maxAbsResidual * Math.tanh(value)
    ));
    const center = residual.reduce((sum, value) => sum + value, 0) / residual.length;
    return softmaxOffset(transformedBase, residual.map((value) => value - center));
  });
  const distribution = Object.freeze(head.actionKeys.map((actionKey, actionIndex) => {
    const probability = memberPredictions.reduce(
      (sum, member) => sum + member[actionIndex].probability, 0,
    ) / memberPredictions.length;
    return Object.freeze({ actionKey, probability });
  }));
  let epistemicStd = 0;
  for (let actionIndex = 0; actionIndex < head.actionKeys.length; actionIndex++) {
    const mean = distribution[actionIndex].probability;
    const variance = memberPredictions.reduce((sum, member) => (
      sum + (member[actionIndex].probability - mean) ** 2
    ), 0) / memberPredictions.length;
    epistemicStd = Math.max(epistemicStd, Math.sqrt(variance));
  }
  const shadowTV = totalVariation(base, distribution);
  const diagnostics = {
    shadowOnly: true,
    distribution,
    baseDistribution: base,
    shadowTV,
    shadowWouldChange: argmax(base) !== argmax(distribution),
    oodScore,
    epistemicStd,
    tableSize: encoded.tableSize,
    legalMask: encoded.mask,
    fallbackFeatures: Object.freeze(fallbackFeatures),
    fallbackFeatureCount: fallbackFeatures.length,
  };
  if (oodScore > model.model.maxOodScore) {
    return rejected('ood', diagnostics);
  }
  if (epistemicStd > model.model.maxEpistemicStd) {
    return rejected('uncertain', diagnostics);
  }
  return Object.freeze({ accepted: true, reason: null, ...diagnostics });
}

/** Code-level shadow lock: always return the exact same base policy object. */
export function evaluateCompactResidualShadow(basePolicy, options = {}) {
  const diagnostics = predictCompactResidualPolicy(options.model, {
    ...options,
    baseDistribution: options.baseDistribution || basePolicy?.distribution,
  });
  return Object.freeze({ policy: basePolicy, diagnostics });
}
