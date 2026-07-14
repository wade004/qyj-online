// ============================================================================
// blueprint-policy.js - browser-safe static blueprint checkpoint adapter
//
// The runtime contract deliberately consumes only an Observation-shaped
// information set.  The offline trainer imports the same key/action encoders,
// so a checkpoint cannot silently use a second, incompatible abstraction.
// This module has no DOM or Node dependencies and is safe in browsers/workers.
// ============================================================================

import {
  normalizePolicyOptions,
  preflopHandLabel,
  tablePosition,
} from './ai-policy.js';
import { boardTexture, comboFeatures } from './opponent-range.js';

export const BLUEPRINT_SCHEMA = 'qyj-blueprint-v2';
export const BLUEPRINT_VERSION = 2;
export const BLUEPRINT_ABSTRACTION = 'qyj-public-compact-v2';
export const DEFAULT_BLUEPRINT_WEIGHT = 0.25;
export const DEFAULT_MAX_BLUEPRINT_WEIGHT = 0.35;
export const DEFAULT_BLUEPRINT_MIN_VISITS = 50;
export const DEFAULT_BLUEPRINT_ADVANTAGE_MIN_SAMPLES = 20;
export const DEFAULT_BLUEPRINT_ADVANTAGE_Z = 1.96;
export const EXACT_ROOT_CALIBRATION_SCHEMA = 'qyj-exact-root-action-calibration-v1';
export const EXACT_ROOT_CALIBRATION_VERSION = 1;
export const EXACT_ROOT_CALIBRATION_EVALUATOR = 'qyj-frozen-exact-root-evaluator-v1';
export const EXACT_ROOT_CALIBRATION_SAMPLING_UNIT = 'independent-seed-cluster';
export const BLUEPRINT_BACKOFF_WEIGHT_MULTIPLIERS = Object.freeze({
  exact: 1,
  history: 0.6,
  position: 0.35,
  strategic: 0.15,
  // Population nodes deliberately pool several independently reached exact
  // roots.  Keep their runtime authority below every more specific level.
  // Shadow-only until independently clustered held-out coverage and league
  // materiality both pass. A hit remains observable, but cannot intervene.
  population: 0,
});

const COMPILED_TABLES = new WeakMap();
const COMPILED_EXACT_ROOT_CALIBRATIONS = new WeakMap();
const POLICY_BLUEPRINT_DIAGNOSTICS = new WeakMap();
const HISTORY_STREETS = Object.freeze(['preflop', 'flop', 'turn', 'river']);
const STREET_CODES = Object.freeze({ preflop: 'p', flop: 'f', turn: 't', river: 'r' });
const ACTION_ORDER = Object.freeze([
  'fold', 'check', 'call', 'raise:feint', 'raise:strike', 'raise:fierce', 'allin',
]);
const BLUEPRINT_RAISE_TIERS = new Set(['feint', 'strike', 'fierce']);
const ACTION_MASK_BITS = Object.freeze([
  Object.freeze(['fold', 0x01]),
  Object.freeze(['check', 0x02]),
  Object.freeze(['call', 0x04]),
  Object.freeze(['raise:feint', 0x08]),
  Object.freeze(['raise:strike', 0x10]),
  Object.freeze(['raise:fierce', 0x20]),
  Object.freeze(['allin', 0x40]),
]);
const KEY_FIELD_ORDER = Object.freeze([
  's', 'n', 'a', 'ao', 'p', 'ip', 'cl', 'h', 'b', 'stk', 'spr',
  'tc', 'r', 'rc', 'lm', 'rr', 'jm', 'x',
]);

const clamp = (value, min = 0, max = 1) => {
  const number = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : min));
};

const finite = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

function bucket(value, limits, labels) {
  const number = finite(value);
  for (let index = 0; index < limits.length; index++) {
    if (number <= limits[index]) return labels[index];
  }
  return labels[labels.length - 1];
}

function safePart(value) {
  return encodeURIComponent(String(value ?? 'unknown'));
}

function compareActionKeys(left, right) {
  const leftIndex = ACTION_ORDER.indexOf(left);
  const rightIndex = ACTION_ORDER.indexOf(right);
  if (leftIndex >= 0 || rightIndex >= 0) {
    return (leftIndex < 0 ? ACTION_ORDER.length : leftIndex)
      - (rightIndex < 0 ? ACTION_ORDER.length : rightIndex);
  }
  return left.localeCompare(right);
}

function cloneAndFreezeJson(value, label = 'metadata', depth = 0, seen = new Set()) {
  if (depth > 32) throw new RangeError(`${label} is nested too deeply`);
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must contain only finite numbers`);
    return value;
  }
  if (typeof value !== 'object') throw new TypeError(`${label} must be JSON-compatible`);
  if (seen.has(value)) throw new TypeError(`${label} must not contain cycles`);
  seen.add(value);
  let copy;
  if (Array.isArray(value)) {
    copy = value.map((item, index) => cloneAndFreezeJson(
      item, `${label}[${index}]`, depth + 1, seen,
    ));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must contain only plain objects`);
    }
    copy = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      copy[key] = cloneAndFreezeJson(value[key], `${label}.${key}`, depth + 1, seen);
    }
  }
  seen.delete(value);
  return Object.freeze(copy);
}

function canonicalJson(value, label = 'value', depth = 0, seen = new Set()) {
  if (depth > 64) throw new RangeError(`${label} is nested too deeply`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must contain only finite numbers`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (!value || typeof value !== 'object') {
    throw new TypeError(`${label} must be canonical JSON`);
  }
  if (seen.has(value)) throw new TypeError(`${label} must not contain cycles`);
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${value.map((item, index) => canonicalJson(
      item, `${label}[${index}]`, depth + 1, seen,
    )).join(',')}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must contain only plain objects`);
    }
    result = `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key], `${label}.${key}`, depth + 1, seen)}`
    )).join(',')}}`;
  }
  seen.delete(value);
  return result;
}

const SHA256_K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function utf8Bytes(text) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(text);
  const encoded = unescape(encodeURIComponent(text));
  return Uint8Array.from(encoded, (character) => character.charCodeAt(0));
}

/** Small browser-safe SHA-256 used only to bind a parsed frozen policy payload. */
function sha256Text(text) {
  const source = utf8Bytes(text);
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 0x80;
  const view = new DataView(bytes.buffer);
  const bitLength = source.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index++) {
      const left = words[index - 15];
      const right = words[index - 2];
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + SHA256_K[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, '0')).join('');
}

/**
 * SHA-256 of the canonical runtime-relevant policy, excluding a calibration
 * attachment so independently sampled evidence can bind to the frozen policy
 * without creating a circular digest.
 */
export function frozenBlueprintPolicySha256(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('frozenBlueprintPolicySha256 requires a parsed checkpoint');
  }
  return sha256Text(canonicalJson({
    schema: raw.schema,
    version: Number(raw.version),
    metadata: raw.metadata || {},
    blendWeight: raw.blendWeight == null ? DEFAULT_BLUEPRINT_WEIGHT : Number(raw.blendWeight),
    infosets: raw.infosets,
  }, 'frozen blueprint policy'));
}

function normalizedStreet(value) {
  return ['preflop', 'flop', 'turn', 'river'].includes(value) ? value : 'idle';
}

function positionOf(observation) {
  if (typeof observation?.self?.position === 'string' && observation.self.position) {
    return observation.self.position;
  }
  return tablePosition(
    observation?.observerIdx,
    observation?.dealerIdx,
    observation?.handSeats || [],
  ).name;
}

function effectiveStack(observation) {
  const own = Math.max(0, finite(observation?.self?.hp)
    + finite(observation?.self?.betStreet));
  const active = new Set(observation?.activeSeats || []);
  let largestOpponent = 0;
  for (const player of observation?.players || []) {
    if (!player || player.idx === observation?.observerIdx || !active.has(player.idx)) continue;
    largestOpponent = Math.max(
      largestOpponent,
      Math.max(0, finite(player.hp) + finite(player.betStreet)),
    );
  }
  return Math.min(own, largestOpponent || own);
}

function handBucket(observation, street) {
  const hole = observation?.self?.hole || [];
  if (hole.length !== 2) return 'unknown';
  if (street === 'preflop') return preflopHandLabel(hole);
  const board = observation?.board || [];
  if (board.length < 3 || board.length > 5) return 'unknown';
  try {
    const features = comboFeatures(hole, board);
    const made = Math.min(4, Math.floor(clamp(features.made) * 5));
    const draw = Math.min(3, Math.floor(clamp(features.draw) * 4));
    return `c${features.category}-m${made}-d${draw}-b${features.blocker ? 1 : 0}`;
  } catch {
    return 'unknown';
  }
}

function publicBoardBucket(observation, street) {
  if (street === 'preflop') return '-';
  const board = observation?.board || [];
  if (board.length < 3 || board.length > 5) return 'unknown';
  try {
    const texture = boardTexture(board);
    const wet = Math.min(3, Math.floor(clamp(texture.wetness) * 4));
    const high = Math.max(...board.map((card) => finite(card?.rank)));
    const highBucket = bucket(high, [8, 11, 13], ['low', 'mid', 'high', 'ace']);
    return `${highBucket}-w${wet}-p${texture.paired ? 1 : 0}-m${texture.monotone ? 1 : 0}`;
  } catch {
    return 'unknown';
  }
}

function eventPosition(event, observation) {
  if (typeof event?.position === 'string' && event.position) return event.position;
  const publicPlayer = observation?.players?.[event?.actorIdx];
  if (typeof publicPlayer?.position === 'string' && publicPlayer.position) {
    return publicPlayer.position;
  }
  return tablePosition(
    event?.actorIdx,
    observation?.dealerIdx,
    observation?.handSeats || [],
  ).name;
}

/** Convert an Engine/policy action to the stable checkpoint action key. */
export function actionToBlueprintKey(action) {
  if (!action || typeof action !== 'object') return null;
  if (['fold', 'check', 'call', 'allin'].includes(action.type)) return action.type;
  if (action.type !== 'raise') return null;
  const tier = String(action.tier?.key || action.tier || '');
  if (!BLUEPRINT_RAISE_TIERS.has(tier)) return null;
  return `raise:${tier}`;
}

function eventActionKey(event) {
  const type = String(event?.type || '');
  if (type === 'allin') {
    // Engine/UI callers may submit a short all-in as `{type:'allin'}` while
    // the abstract trainer records the same passive action as `call`.
    // Canonicalise both public histories to one poker meaning.
    if (!event?.isAggressive && finite(event?.raiseIncrement) <= 0) return 'call';
    return 'allin';
  }
  if (['fold', 'check', 'call'].includes(type)) return type;
  if (type === 'raise' && event?.key) {
    return actionToBlueprintKey({ type: 'raise', tier: { key: event.key } }) || 'raise:unknown';
  }
  if (['fold', 'check', 'call', 'allin'].includes(event?.key)) return event.key;
  if (event?.isAggressive && event?.key) {
    return actionToBlueprintKey({ type: 'raise', tier: { key: event.key } }) || 'raise:unknown';
  }
  return 'unknown';
}

function positionGroup(position) {
  const value = String(position || '');
  if (value === 'BTN' || value === 'CO' || value === 'BTN/SB') return 'late';
  if (value === 'SB' || value === 'BB') return 'blind';
  if (value === 'HJ' || value === 'LJ' || value === 'MP') return 'middle';
  if (value.startsWith('UTG') || value.startsWith('EP')) return 'early';
  return 'other';
}

function parseBlueprintKey(key) {
  if (typeof key !== 'string' || !key.startsWith('bp2|')) return null;
  const fields = new Map();
  for (const part of key.slice(4).split('|')) {
    const separator = part.indexOf('=');
    if (separator <= 0) return null;
    fields.set(part.slice(0, separator), decodeURIComponent(part.slice(separator + 1)));
  }
  return fields;
}

function serializeBlueprintKey(fields, backoff = null) {
  const parts = backoff ? [`bk=${safePart(backoff)}`] : [];
  for (const field of KEY_FIELD_ORDER) {
    if (!fields.has(field)) return null;
    parts.push(`${field}=${safePart(fields.get(field))}`);
  }
  return `bp2|${parts.join('|')}`;
}

function coarseHandBucket(value) {
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
  const score = (high * 2 + low) / 42 + (suited ? 0.045 : 0) - Math.min(0.1, gap * 0.012);
  return `${bucket(score, [0.56, 0.66, 0.75, 0.84], ['h1', 'h2', 'h3', 'h4', 'h5'])}`
    + `-${suited ? 's' : 'o'}`;
}

function coarseBoardBucket(value) {
  const parsed = /^(low|mid|high|ace)-w(\d)-p([01])-m([01])$/.exec(String(value || ''));
  if (!parsed) return String(value || 'unknown');
  const high = ['high', 'ace'].includes(parsed[1]) ? 'hi' : 'lo';
  return `${high}-w${Number(parsed[2]) >= 2 ? 1 : 0}-p${parsed[3]}-m${parsed[4]}`;
}

function coarseActiveOpponents(value) {
  const opponents = Math.max(0, Math.trunc(finite(value)));
  if (opponents <= 1) return 'hu';
  if (opponents === 2) return 'three';
  return 'multi';
}

/**
 * Deterministic lower-resolution keys. Legal mask, raise right, jam semantics,
 * table population and tournament level are retained at every level.
 */
export function blueprintBackoffKeys(informationSetKey) {
  const fields = parseBlueprintKey(informationSetKey);
  if (!fields || fields.has('bk')) return Object.freeze([]);
  const historyFree = new Map(fields);
  historyFree.set('x', '-');
  const positionCoarse = new Map(historyFree);
  positionCoarse.set('p', positionGroup(fields.get('p')));
  const strategic = new Map(positionCoarse);
  strategic.set('h', coarseHandBucket(fields.get('h')));
  strategic.set('b', coarseBoardBucket(fields.get('b')));
  strategic.set('stk', ['xs', 's'].includes(fields.get('stk'))
    ? 'short' : fields.get('stk') === 'm' ? 'middle' : 'deep');
  strategic.set('spr', ['1', '2'].includes(fields.get('spr'))
    ? 'low' : fields.get('spr') === '4' ? 'middle' : 'high');
  // The final level is intentionally small and auditable rather than a fitted
  // black box.  It retains the dimensions that define poker meaning at the
  // browser legality boundary: street, nominal table size, coarse private
  // hand/public board, price, legal mask, raise right and jam semantics. It
  // also retains tournament phase, coarse stack/SPR, position group and a
  // coarse active-opponent count: pooling those creates severe ICM/stack
  // aliasing. Only transient all-in/action-order/raise-count details are
  // pooled. Offline publication still requires several distinct source roots
  // and explicit reach evidence before this key may be emitted.
  const population = new Map(strategic);
  population.set('a', coarseActiveOpponents(fields.get('a')));
  for (const field of ['ao', 'ip', 'cl', 'rc', 'x']) {
    population.set(field, '-');
  }
  return Object.freeze([
    serializeBlueprintKey(historyFree, 'history'),
    serializeBlueprintKey(positionCoarse, 'position'),
    serializeBlueprintKey(strategic, 'strategic'),
    serializeBlueprintKey(population, 'population'),
  ].filter(Boolean));
}

const cappedCount = (value, max = 2) => Math.min(max, Math.max(0, Math.trunc(finite(value))));

function actorGroup(event, observation) {
  if (Number(event?.actorIdx) === Number(observation?.observerIdx)) return 'self';
  return positionGroup(eventPosition(event, observation));
}

/**
 * Fixed-cardinality public history summary. It intentionally forgets exact
 * event order so common strategic situations reuse the same node instead of
 * growing one key per full action transcript.
 */
function actionHistoryBucket(observation) {
  const round = finite(observation?.round);
  const events = (Array.isArray(observation?.actionHistory) ? observation.actionHistory : [])
    .filter((event) => !event?.forced && (!round || finite(event?.round) === round));
  return HISTORY_STREETS.map((street) => {
    const streetEvents = events.filter((event) => normalizedStreet(event?.street) === street);
    const aggressive = streetEvents.filter((event) => (
      event?.isAggressive || eventActionKey(event).startsWith('raise:')
      || (eventActionKey(event) === 'allin' && finite(event?.raiseIncrement) > 0)
    ));
    const firstAggressiveIndex = streetEvents.findIndex((event) => aggressive.includes(event));
    const lastAggressiveIndex = streetEvents.findLastIndex((event) => aggressive.includes(event));
    const limpers = streetEvents.filter((event, index) => eventActionKey(event) === 'call'
      && (firstAggressiveIndex < 0 || index < firstAggressiveIndex)).length;
    const callers = lastAggressiveIndex < 0 ? 0 : streetEvents.filter(
      (event, index) => index > lastAggressiveIndex && eventActionKey(event) === 'call',
    ).length;
    const lastAggressor = aggressive[aggressive.length - 1] || null;
    const actorCodes = { self: 'S', early: 'E', middle: 'M', late: 'L', blind: 'B', other: 'O' };
    const aggressorCode = lastAggressor ? actorCodes[actorGroup(lastAggressor, observation)] : 'N';
    const sizeCode = (() => {
      if (!lastAggressor) return 'N';
      if (eventActionKey(lastAggressor) === 'allin') return 'J';
      const amount = finite(lastAggressor.raiseIncrement) || finite(lastAggressor.amount);
      const ratio = amount / Math.max(1, finite(lastAggressor.potBefore));
      return ratio <= 0.4 ? 'Q' : ratio <= 0.8 ? 'H' : ratio <= 1.25 ? 'P' : 'O';
    })();
    const selfLast = streetEvents.filter(
      (event) => Number(event?.actorIdx) === Number(observation?.observerIdx),
    ).at(-1);
    const selfAction = (() => {
      const key = eventActionKey(selfLast);
      if (key === 'fold') return 'F';
      if (key === 'check') return 'K';
      if (key === 'call') return 'C';
      if (key === 'allin') return 'A';
      if (key.startsWith('raise:')) return 'R';
      return 'N';
    })();
    return `${STREET_CODES[street].toUpperCase()}${cappedCount(aggressive.length)}`
      + `${cappedCount(limpers)}${cappedCount(callers)}${aggressorCode}${sizeCode}${selfAction}`;
  }).join('_');
}

/** Canonical legal-action boundary shared by trainer keys and runtime keys. */
export function blueprintLegalContext(
  observation,
  rawOpts = observation?.legalActions || {},
  { maxRaisesPerStreet = Number.POSITIVE_INFINITY } = {},
) {
  const opts = normalizePolicyOptions(rawOpts);
  const configuredRaiseCap = Number(maxRaisesPerStreet);
  const raiseCap = Number.isSafeInteger(configuredRaiseCap) && configuredRaiseCap >= 0
    ? configuredRaiseCap : Number.POSITIVE_INFINITY;
  const raiseCapReached = finite(observation?.betting?.streetRaiseCount) >= raiseCap;
  let mask = 0;
  const canonicalActionKeys = [];
  const add = (condition, bit, key) => {
    if (!condition) return;
    mask |= bit;
    canonicalActionKeys.push(key);
  };
  add(opts.toCall > 0, 0x01, 'fold');
  add(opts.canCheck, 0x02, 'check');
  add(opts.callAmt > 0, 0x04, 'call');
  const tierBits = { feint: 0x08, strike: 0x10, fierce: 0x20 };
  for (const tier of [...opts.tiers].sort((left, right) => left.key.localeCompare(right.key))) {
    add(!raiseCapReached && opts.canRaise && tierBits[tier.key],
      tierBits[tier.key], `raise:${tier.key}`);
  }
  const aggressiveJamAllowed = !raiseCapReached && opts.canAllIn && opts.allInRaises;
  add(aggressiveJamAllowed, 0x40, 'allin');
  // `raw canRaise` has different producer meanings in Engine and the trainer
  // for jam-only/short-call states. lm+jm already encode those cases, so rr is
  // deliberately the shared ordinary-tier raise right after normalisation.
  const raiseRight = !raiseCapReached && opts.canRaise && opts.tiers.length > 0 ? 1 : 0;
  let jamKind = 'n';
  if (opts.canAllIn && !opts.allInRaises) {
    jamKind = 'c';
  } else if (aggressiveJamAllowed) {
    const increment = Math.max(0, opts.allinAmt - opts.toCall);
    jamKind = increment < Math.max(0, finite(observation?.betting?.minRaiseIncrement))
      ? 'u' : 'f';
  }
  return Object.freeze({
    mask: mask.toString(16),
    raiseRight,
    jamKind,
    canonicalActionKeys: Object.freeze(canonicalActionKeys.sort()),
  });
}

function inPosition(observation) {
  const active = (observation?.activeSeats || []).filter((seat) => {
    const player = observation?.players?.[seat];
    return player && !player.allIn;
  });
  if (!active.includes(observation?.observerIdx)) return false;
  const ringSize = Math.max(
    observation?.players?.length || 0,
    ...((observation?.handSeats || []).map((seat) => Number(seat) + 1)),
    1,
  );
  const distance = (seat) => (
    (seat - finite(observation?.dealerIdx) + ringSize) % ringSize || ringSize
  );
  return [...active].sort((left, right) => distance(left) - distance(right)).at(-1)
    === observation.observerIdx;
}

function closesPublicAction(observation) {
  return (observation?.activeSeats || [])
    .filter((seat) => seat !== observation?.observerIdx)
    .every((seat) => {
      const player = observation?.players?.[seat];
      return player?.allIn || (player?.acted
        && finite(player.betStreet) >= finite(observation?.betting?.currentBet));
    });
}

/**
 * Stable coarse information-set key shared by offline training and browsers.
 * It only reads public state plus the observer's own hole cards.  Opponent
 * hole cards, the undealt deck and unrevealed board cards are never inputs.
 */
export function buildBlueprintInfoSetKey(observation, context = {}) {
  if (!observation || typeof observation !== 'object') {
    throw new TypeError('buildBlueprintInfoSetKey requires an Observation-shaped object');
  }
  const street = normalizedStreet(observation.street);
  const rawOpts = context.opts || observation.legalActions || {};
  const opts = normalizePolicyOptions(rawOpts);
  const legalContext = blueprintLegalContext(observation, rawOpts, {
    maxRaisesPerStreet: context.maxRaisesPerStreet,
  });
  const handSeats = Array.isArray(observation.handSeats) ? observation.handSeats : [];
  const activeSeats = Array.isArray(observation.activeSeats) ? observation.activeSeats : [];
  const tableSize = Math.max(2, Math.min(9, Math.round(finite(
    handSeats.length || context.tableSize || observation.seatCount,
    2,
  ))));
  const activeOpponents = Math.max(0, activeSeats.length
    - (activeSeats.includes(observation.observerIdx) ? 1 : 0));
  const bb = Math.max(1, finite(observation?.blinds?.bb, 1));
  const stackBb = effectiveStack(observation) / bb;
  const pot = Math.max(0, finite(observation?.betting?.pot));
  const spr = effectiveStack(observation) / Math.max(bb, pot);
  const callRatio = opts.toCall / Math.max(bb, pot);
  const round = Math.max(1, Math.round(finite(observation.round, 1)));

  const fields = [
    ['s', street],
    ['n', tableSize],
    ['a', activeOpponents],
    ['ao', cappedCount((observation?.players || []).filter((player) => (
      player && player.idx !== observation.observerIdx && player.allIn
        && activeSeats.includes(player.idx)
    )).length)],
    ['p', context.position || positionOf(observation)],
    ['ip', inPosition(observation) ? 1 : 0],
    ['cl', closesPublicAction(observation) ? 1 : 0],
    ['h', handBucket(observation, street)],
    ['b', publicBoardBucket(observation, street)],
    ['stk', bucket(stackBb, [8, 15, 30, 60], ['xs', 's', 'm', 'd', 'xd'])],
    ['spr', bucket(spr, [1, 2, 4, 8], ['1', '2', '4', '8', 'hi'])],
    ['tc', opts.toCall <= 0
      ? '0'
      : bucket(callRatio, [0.25, 0.5, 0.75, 1.25], ['q', 'h', 't', 'p', 'over'])],
    ['r', bucket(round, [3, 6, 9], ['l1', 'l2', 'l3', 'l4'])],
    ['rc', cappedCount(observation?.betting?.streetRaiseCount)],
    ['lm', legalContext.mask],
    ['rr', legalContext.raiseRight],
    ['jm', legalContext.jamKind],
    ['x', actionHistoryBucket(observation)],
  ];
  return `bp2|${fields.map(([key, value]) => `${key}=${safePart(value)}`).join('|')}`;
}

function assertActionKey(key, label = 'action') {
  if (['fold', 'check', 'call', 'allin'].includes(key)) return;
  if (typeof key !== 'string' || !key.startsWith('raise:')) {
    throw new TypeError(`${label} has unsupported action key ${String(key)}`);
  }
  const tier = key.slice(6);
  if (!BLUEPRINT_RAISE_TIERS.has(tier)) {
    throw new TypeError(`${label} has invalid raise tier`);
  }
}

function compileDistribution(raw, label) {
  const source = raw?.strategy;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError(`${label}.strategy must be an action-probability object`);
  }
  if (Object.keys(source).length > 8) {
    throw new RangeError(`${label}.strategy contains too many actions`);
  }
  let total = 0;
  const entries = [];
  for (const [actionKey, rawProbability] of Object.entries(source)) {
    assertActionKey(actionKey, label);
    const probability = Number(rawProbability);
    if (!Number.isFinite(probability) || probability < 0) {
      throw new TypeError(`${label}.${actionKey} must be a finite non-negative probability`);
    }
    if (probability === 0) continue;
    total += probability;
    entries.push({ actionKey, probability });
  }
  if (!(total > 0) || !Number.isFinite(total)) {
    throw new TypeError(`${label} must contain positive finite probability mass`);
  }
  entries.sort((left, right) => compareActionKeys(left.actionKey, right.actionKey));
  return Object.freeze(entries.map((entry) => Object.freeze({
    actionKey: entry.actionKey,
    probability: entry.probability / total,
  })));
}

function compileActionValues(raw, label) {
  const source = raw?.actionValues;
  if (source == null) return null;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError(`${label}.actionValues must be an action-statistics object`);
  }
  if (Object.keys(source).length > 8) {
    throw new RangeError(`${label}.actionValues contains too many actions`);
  }
  const entries = [];
  for (const [actionKey, rawStats] of Object.entries(source)) {
    assertActionKey(actionKey, `${label}.actionValues`);
    if (!rawStats || typeof rawStats !== 'object' || Array.isArray(rawStats)) {
      throw new TypeError(`${label}.actionValues.${actionKey} must be an object`);
    }
    const samples = Number(rawStats.samples);
    const mean = Number(rawStats.mean);
    const m2 = Number(rawStats.m2);
    if (!Number.isSafeInteger(samples) || samples < 0) {
      throw new TypeError(`${label}.actionValues.${actionKey}.samples must be a non-negative safe integer`);
    }
    if (!Number.isFinite(mean)) {
      throw new TypeError(`${label}.actionValues.${actionKey}.mean must be finite`);
    }
    if (!Number.isFinite(m2) || m2 < 0) {
      throw new TypeError(`${label}.actionValues.${actionKey}.m2 must be finite and non-negative`);
    }
    if (samples === 0 && (mean !== 0 || m2 !== 0)) {
      throw new RangeError(`${label}.actionValues.${actionKey} zero-sample moments must be zero`);
    }
    entries.push(Object.freeze({ actionKey, samples, mean, m2 }));
  }
  entries.sort((left, right) => compareActionKeys(left.actionKey, right.actionKey));
  return Object.freeze(entries);
}

function compileInfoSet(raw, label) {
  const strategy = compileDistribution(raw, label);
  const actionValues = compileActionValues(raw, label);
  const visits = Number(raw?.visits);
  if (!Number.isSafeInteger(visits) || visits <= 0) {
    throw new TypeError(`${label}.visits must be a positive safe integer`);
  }
  if (actionValues?.some((entry) => entry.samples > visits)) {
    throw new RangeError(`${label}.actionValues samples must not exceed visits`);
  }
  const supportInteger = (field) => {
    if (raw?.[field] == null) return 0;
    const value = Number(raw[field]);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${label}.${field} must be a non-negative safe integer`);
    }
    return value;
  };
  return Object.freeze({
    strategy,
    visits,
    actionValues,
    distinctSourceExactRoots: supportInteger('distinctSourceExactRoots'),
    sourceReachDecisions: supportInteger('sourceReachDecisions'),
    sourceReachProfiles: supportInteger('sourceReachProfiles'),
    sourceReachGroups: supportInteger('sourceReachGroups'),
  });
}

function assertExactObjectKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} fields do not match the frozen calibration schema`);
  }
}

function sha256Value(value, label) {
  const normalized = String(value || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return normalized;
}

function policyContractValue(value, label) {
  const normalized = String(value || '');
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new TypeError(`${label} must be a stable lowercase policy contract token`);
  }
  return normalized;
}

function actionKeysForMask(rawMask, label) {
  const mask = String(rawMask || '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(mask)) throw new TypeError(`${label} is not a hexadecimal mask`);
  const numeric = Number.parseInt(mask, 16);
  if (!Number.isSafeInteger(numeric) || numeric <= 0 || (numeric & ~0x7f) !== 0) {
    throw new RangeError(`${label} contains unsupported action bits`);
  }
  return Object.freeze(ACTION_MASK_BITS
    .filter(([, bit]) => (numeric & bit) !== 0)
    .map(([actionKey]) => actionKey));
}

/** Fixed tensor order for a canonical blueprint legal-action mask. */
export function blueprintActionKeysForMask(rawMask) {
  return actionKeysForMask(rawMask, 'blueprint legal-action mask');
}

function compileExactRootCalibration(raw, checkpoint, table, maxInfosets) {
  if (raw == null) return null;
  if (checkpoint.metadata?.advantageGuard?.enabled !== true) {
    throw new RangeError('exactRootCalibration requires the runtime advantage guard');
  }
  assertExactObjectKeys(raw, [
    'schema', 'version', 'frozenPolicySha256', 'tournamentValueModelSha256',
    'tournamentValueReportSha256', 'evaluatorVersion', 'samplingUnit',
    'basePolicyContract', 'baseStyleKey', 'confidenceLevel',
    'bootstrapIterations', 'records',
  ], 'exactRootCalibration');
  if (raw.schema !== EXACT_ROOT_CALIBRATION_SCHEMA
    || Number(raw.version) !== EXACT_ROOT_CALIBRATION_VERSION) {
    throw new TypeError(`Unsupported exact-root calibration ${raw.schema || 'unknown'}@${raw.version}`);
  }
  if (raw.evaluatorVersion !== EXACT_ROOT_CALIBRATION_EVALUATOR) {
    throw new TypeError('exactRootCalibration evaluatorVersion is unsupported');
  }
  if (raw.samplingUnit !== EXACT_ROOT_CALIBRATION_SAMPLING_UNIT) {
    throw new TypeError('exactRootCalibration samplingUnit must be independent-seed-cluster');
  }
  if (Number(raw.confidenceLevel) !== 0.95) {
    throw new RangeError('exactRootCalibration confidenceLevel must be 0.95');
  }
  const bootstrapIterations = Number(raw.bootstrapIterations);
  if (!Number.isSafeInteger(bootstrapIterations)
    || bootstrapIterations < 200 || bootstrapIterations > 10_000) {
    throw new RangeError('exactRootCalibration bootstrapIterations must be in 200..10000');
  }
  const frozenPolicySha = sha256Value(
    raw.frozenPolicySha256, 'exactRootCalibration.frozenPolicySha256',
  );
  const computedPolicySha = frozenBlueprintPolicySha256(checkpoint);
  if (frozenPolicySha !== computedPolicySha) {
    throw new RangeError('exactRootCalibration frozen policy SHA-256 does not match checkpoint');
  }
  const modelSha = sha256Value(
    raw.tournamentValueModelSha256,
    'exactRootCalibration.tournamentValueModelSha256',
  );
  const reportSha = sha256Value(
    raw.tournamentValueReportSha256,
    'exactRootCalibration.tournamentValueReportSha256',
  );
  if (modelSha !== String(checkpoint.metadata?.tournamentValueSource?.sha256 || '').toLowerCase()
    || reportSha !== String(
      checkpoint.metadata?.tournamentValueSource?.qualityReportSha256 || '',
    ).toLowerCase()) {
    throw new RangeError('exactRootCalibration tournament model/report SHA binding mismatch');
  }
  const basePolicyContract = policyContractValue(
    raw.basePolicyContract, 'exactRootCalibration.basePolicyContract',
  );
  const baseStyleKey = policyContractValue(
    raw.baseStyleKey, 'exactRootCalibration.baseStyleKey',
  );
  if (!raw.records || typeof raw.records !== 'object' || Array.isArray(raw.records)) {
    throw new TypeError('exactRootCalibration.records must be an object');
  }
  const recordEntries = Object.entries(raw.records);
  if (!recordEntries.length || recordEntries.length > maxInfosets) {
    throw new RangeError('exactRootCalibration record count is invalid');
  }
  const records = new Map();
  for (const [key, record] of recordEntries) {
    if (!key.startsWith('bp2|') || key.includes('|bk=') || !table.has(key)) {
      throw new RangeError('exactRootCalibration may reference only published exact nodes');
    }
    const label = `exactRootCalibration.records[${JSON.stringify(key)}]`;
    assertExactObjectKeys(record, [
      'frozenPolicySha256', 'tournamentValueModelSha256',
      'tournamentValueReportSha256', 'evaluatorVersion', 'samplingUnit',
      'basePolicyContract', 'baseStyleKey', 'independentClusterCount',
      'actionMask', 'actionKeys', 'clusters',
    ], label);
    if (sha256Value(record.frozenPolicySha256, `${label}.frozenPolicySha256`)
        !== frozenPolicySha
      || sha256Value(record.tournamentValueModelSha256,
        `${label}.tournamentValueModelSha256`) !== modelSha
      || sha256Value(record.tournamentValueReportSha256,
        `${label}.tournamentValueReportSha256`) !== reportSha
      || record.evaluatorVersion !== raw.evaluatorVersion
      || record.samplingUnit !== raw.samplingUnit
      || policyContractValue(record.basePolicyContract,
        `${label}.basePolicyContract`) !== basePolicyContract
      || policyContractValue(record.baseStyleKey,
        `${label}.baseStyleKey`) !== baseStyleKey) {
      throw new RangeError(`${label} provenance binding does not match its artifact`);
    }
    const fields = parseBlueprintKey(key);
    const keyMask = String(fields?.get('lm') || '').toLowerCase();
    const recordMask = String(record.actionMask || '').toLowerCase();
    if (recordMask !== keyMask) {
      throw new RangeError(`${label}.actionMask does not match the exact information set`);
    }
    const expectedActionKeys = actionKeysForMask(keyMask, `${label}.actionMask`);
    if (!Array.isArray(record.actionKeys)
      || record.actionKeys.length !== expectedActionKeys.length
      || record.actionKeys.some((actionKey, index) => actionKey !== expectedActionKeys[index])) {
      throw new RangeError(`${label}.actionKeys must be the complete fixed action-mask vector`);
    }
    const independentClusterCount = Number(record.independentClusterCount);
    if (!Number.isSafeInteger(independentClusterCount) || independentClusterCount < 2) {
      throw new RangeError(`${label}.independentClusterCount must be a safe integer >= 2`);
    }
    const configuredMinimum = Number(checkpoint.metadata?.advantageGuard?.minSamples);
    if (independentClusterCount < (Number.isSafeInteger(configuredMinimum)
      ? configuredMinimum : DEFAULT_BLUEPRINT_ADVANTAGE_MIN_SAMPLES)) {
      throw new RangeError(`${label}.independentClusterCount is below the runtime guard floor`);
    }
    if (!Array.isArray(record.clusters)
      || record.clusters.length !== independentClusterCount) {
      throw new RangeError(`${label}.clusters must match independentClusterCount`);
    }
    const clusterIds = new Set();
    const clusters = record.clusters.map((cluster, clusterIndex) => {
      const clusterLabel = `${label}.clusters[${clusterIndex}]`;
      assertExactObjectKeys(cluster, ['clusterId', 'values'], clusterLabel);
      const clusterId = String(cluster.clusterId || '');
      if (!/^fc_[0-9a-f]{64}$/.test(clusterId) || clusterIds.has(clusterId)) {
        throw new RangeError(`${clusterLabel}.clusterId must be a unique opaque digest`);
      }
      clusterIds.add(clusterId);
      if (!Array.isArray(cluster.values)
        || cluster.values.length !== expectedActionKeys.length) {
        throw new RangeError(`${clusterLabel}.values must match the fixed action vector`);
      }
      const values = cluster.values.map((rawValue) => Number(rawValue));
      if (values.some((value) => !Number.isFinite(value) || Math.abs(value) > 1 + 1e-9)) {
        throw new RangeError(`${clusterLabel}.values must use normalized tournament utility`);
      }
      return Object.freeze({ clusterId, values: Object.freeze(values) });
    });
    records.set(key, Object.freeze({
      frozenPolicySha256: frozenPolicySha,
      tournamentValueModelSha256: modelSha,
      tournamentValueReportSha256: reportSha,
      evaluatorVersion: raw.evaluatorVersion,
      samplingUnit: raw.samplingUnit,
      basePolicyContract,
      baseStyleKey,
      independentClusterCount,
      actionMask: keyMask,
      actionKeys: expectedActionKeys,
      clusters: Object.freeze(clusters),
    }));
  }
  return Object.freeze({
    schema: raw.schema,
    version: EXACT_ROOT_CALIBRATION_VERSION,
    frozenPolicySha256: frozenPolicySha,
    tournamentValueModelSha256: modelSha,
    tournamentValueReportSha256: reportSha,
    evaluatorVersion: raw.evaluatorVersion,
    samplingUnit: raw.samplingUnit,
    basePolicyContract,
    baseStyleKey,
    confidenceLevel: 0.95,
    bootstrapIterations,
    records,
  });
}

function validateAdvantageGuardMetadata(raw) {
  if (raw == null) return;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('metadata.advantageGuard must be an object');
  }
  if (raw.enabled != null && typeof raw.enabled !== 'boolean') {
    throw new TypeError('metadata.advantageGuard.enabled must be boolean');
  }
  if (raw.minSamples != null) {
    const minSamples = Number(raw.minSamples);
    if (!Number.isSafeInteger(minSamples) || minSamples < 2) {
      throw new RangeError('metadata.advantageGuard.minSamples must be a safe integer >= 2');
    }
  }
  if (raw.confidenceZ != null) {
    const confidenceZ = Number(raw.confidenceZ);
    if (!Number.isFinite(confidenceZ) || confidenceZ < 0 || confidenceZ > 10) {
      throw new RangeError('metadata.advantageGuard.confidenceZ must be in 0..10');
    }
  }
  if (raw.minLowerBound != null && !Number.isFinite(Number(raw.minLowerBound))) {
    throw new TypeError('metadata.advantageGuard.minLowerBound must be finite');
  }
}

/**
 * Validate and compile a parsed qyj-blueprint-v2 JSON checkpoint.  Unknown
 * top-level fields (including trainerState) are intentionally ignored.
 */
export function compileBlueprintCheckpoint(raw, { maxInfosets = 1_000_000 } = {}) {
  if (raw && COMPILED_TABLES.has(raw)) return raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Blueprint checkpoint must be a JSON object');
  }
  if (raw.schema !== BLUEPRINT_SCHEMA || Number(raw.version) !== BLUEPRINT_VERSION) {
    throw new TypeError(`Unsupported blueprint checkpoint ${raw.schema || 'unknown'}@${raw.version}`);
  }
  if (raw.metadata?.abstraction !== BLUEPRINT_ABSTRACTION) {
    throw new TypeError(`Unsupported blueprint abstraction ${raw.metadata.abstraction}`);
  }
  validateAdvantageGuardMetadata(raw.metadata?.advantageGuard);
  if (!raw.infosets || typeof raw.infosets !== 'object' || Array.isArray(raw.infosets)) {
    throw new TypeError('Blueprint checkpoint infosets must be an object');
  }
  const normalizedMaxInfosets = Math.max(1, finite(maxInfosets, 1_000_000));
  const rawEntries = Object.entries(raw.infosets);
  if (rawEntries.length > normalizedMaxInfosets) {
    throw new RangeError('Blueprint checkpoint contains too many information sets');
  }
  const table = new Map();
  for (const [key, distribution] of rawEntries) {
    if (!key || key.length > 4096) throw new TypeError('Blueprint information-set key is invalid');
    if (!key.startsWith('bp2|')) {
      throw new TypeError('Blueprint information-set key does not use the v2 abstraction');
    }
    table.set(key, compileInfoSet(distribution, `infosets[${JSON.stringify(key)}]`));
  }
  const metadata = cloneAndFreezeJson(raw.metadata || {}, 'metadata');
  const requestedWeight = raw.blendWeight == null
    ? DEFAULT_BLUEPRINT_WEIGHT : Number(raw.blendWeight);
  if (!Number.isFinite(requestedWeight) || requestedWeight < 0 || requestedWeight > 1) {
    throw new RangeError('Blueprint blendWeight must be in 0..1');
  }
  const exactRootCalibration = compileExactRootCalibration(
    raw.exactRootCalibration, raw, table, normalizedMaxInfosets,
  );
  const compiled = Object.freeze({
    schema: BLUEPRINT_SCHEMA,
    version: BLUEPRINT_VERSION,
    metadata,
    blendWeight: requestedWeight,
    size: table.size,
  });
  COMPILED_TABLES.set(compiled, table);
  if (exactRootCalibration) {
    COMPILED_EXACT_ROOT_CALIBRATIONS.set(compiled, exactRootCalibration);
  }
  return compiled;
}

/** Load a parsed object or fetch a static JSON checkpoint in any browser. */
export async function loadBlueprintCheckpoint(source, {
  fetchImpl = globalThis.fetch,
  signal,
  maxInfosets,
} = {}) {
  if (source == null || source === false || source === '') return null;
  if (typeof source === 'object') {
    return compileBlueprintCheckpoint(source, { maxInfosets });
  }
  if (typeof source !== 'string') {
    throw new TypeError('Blueprint source must be a URL, parsed object or null');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('No fetch implementation is available to load the blueprint');
  }
  const response = await fetchImpl(source, { signal, credentials: 'same-origin' });
  if (!response?.ok) {
    throw new Error(`Unable to load blueprint checkpoint (${response?.status || 'network error'})`);
  }
  return compileBlueprintCheckpoint(await response.json(), { maxInfosets });
}

export function lookupBlueprintDistribution(checkpoint, informationSetKey) {
  const table = checkpoint && COMPILED_TABLES.get(checkpoint);
  return table?.get(informationSetKey) || null;
}

function checkpointRaiseCap(checkpoint) {
  const metadata = checkpoint?.metadata;
  const candidates = [
    metadata?.maxRaisesPerStreet,
    metadata?.gameConfig?.maxRaisesPerStreet,
  ];
  const configurationCaps = Array.isArray(metadata?.configurations)
    ? [...new Set(metadata.configurations.map((config) => config?.maxRaisesPerStreet))]
    : [];
  if (configurationCaps.length === 1) candidates.push(configurationCaps[0]);
  const cap = candidates.map(Number).find((value) => (
    Number.isSafeInteger(value) && value >= 0
  ));
  return cap ?? Number.POSITIVE_INFINITY;
}

function populationSupportEligible(checkpoint, infoSet, visitFloor) {
  const publication = checkpoint?.metadata?.publication;
  const minRoots = Number(publication?.minPopulationRoots);
  const minReach = Number(publication?.minReachDecisions);
  const minReachGroups = Number(publication?.minReachGroups);
  const minPublishedVisits = Number(publication?.minBackoffVisits);
  return publication?.backoffPublished === true
    && publication?.reachEvidenceAvailable === true
    && Number.isSafeInteger(minRoots) && minRoots >= 3
    && Number.isSafeInteger(minReach) && minReach >= 1
    && Number.isSafeInteger(minReachGroups) && minReachGroups >= 2
    && Number.isSafeInteger(minPublishedVisits) && minPublishedVisits >= 1
    && infoSet.visits >= Math.max(visitFloor, minPublishedVisits)
    && infoSet.distinctSourceExactRoots >= minRoots
    && infoSet.sourceReachDecisions >= minReach
    && infoSet.sourceReachProfiles >= 1
    && infoSet.sourceReachGroups >= minReachGroups;
}

/** Decode a checkpoint key only when that exact action is currently legal. */
export function actionFromBlueprintKey(actionKey, rawOpts) {
  const opts = normalizePolicyOptions(rawOpts);
  if (actionKey === 'fold') return opts.toCall > 0 ? { type: 'fold' } : null;
  if (actionKey === 'check') return opts.canCheck ? { type: 'check' } : null;
  if (actionKey === 'call') return opts.callAmt > 0 ? { type: 'call' } : null;
  if (actionKey === 'allin') {
    if (!opts.canAllIn) return null;
    // A short stack calling for all of its chips must remain a passive call;
    // labeling it as an aggressive all-in can incorrectly reopen betting.
    return !opts.allInRaises && opts.callAmt > 0 ? { type: 'call' } : { type: 'allin' };
  }
  if (typeof actionKey !== 'string' || !actionKey.startsWith('raise:') || !opts.canRaise) {
    return null;
  }
  const tierKey = actionKey.slice(6);
  const tier = opts.tiers.find((candidate) => candidate.key === tierKey);
  return tier ? { type: 'raise', tier } : null;
}

/** Final defensive legality boundary for a sampled blueprint/base action. */
export function legalizeBlueprintAction(action, rawOpts, { preferCall = false } = {}) {
  const exactKey = actionToBlueprintKey(action);
  const exact = exactKey ? actionFromBlueprintKey(exactKey, rawOpts) : null;
  if (exact) return exact;
  const opts = normalizePolicyOptions(rawOpts);
  if (opts.canCheck) return { type: 'check' };
  if (preferCall && opts.callAmt > 0) return { type: 'call' };
  return { type: 'fold' };
}

function legalDistribution(rawDistribution, opts) {
  const byKey = new Map();
  for (const candidate of rawDistribution || []) {
    const actionKey = candidate.actionKey || actionToBlueprintKey(candidate.action);
    const action = actionKey ? actionFromBlueprintKey(actionKey, opts) : null;
    const probability = Number(candidate.probability);
    if (!action || !Number.isFinite(probability) || probability <= 0) continue;
    const legalKey = actionToBlueprintKey(action);
    const previous = byKey.get(legalKey);
    if (previous) previous.probability += probability;
    else byKey.set(legalKey, { actionKey: legalKey, action, probability, ev: candidate.ev });
  }
  const total = [...byKey.values()].reduce((sum, item) => sum + item.probability, 0);
  if (!(total > 0)) return [];
  return [...byKey.values()]
    .sort((left, right) => compareActionKeys(left.actionKey, right.actionKey))
    .map((item) => ({ ...item, probability: item.probability / total }));
}

function baseDistribution(basePolicy, opts) {
  const distribution = legalDistribution(basePolicy?.distribution, opts);
  if (distribution.length) return distribution;
  const action = legalizeBlueprintAction(basePolicy?.action, opts);
  return [{
    actionKey: actionToBlueprintKey(action),
    action,
    probability: 1,
    ev: basePolicy?.selected?.ev,
  }];
}

function distributionByKey(distribution) {
  return new Map((distribution || []).map((candidate) => [
    candidate.actionKey,
    candidate.probability,
  ]));
}

function totalVariation(left, right) {
  const leftByKey = distributionByKey(left);
  const rightByKey = distributionByKey(right);
  const keys = new Set([...leftByKey.keys(), ...rightByKey.keys()]);
  let distance = 0;
  for (const key of keys) {
    distance += Math.abs((leftByKey.get(key) || 0) - (rightByKey.get(key) || 0));
  }
  return clamp(distance / 2);
}

function advantageGuardConfig(checkpoint) {
  const raw = checkpoint?.metadata?.advantageGuard;
  return Object.freeze({
    enabled: raw?.enabled === true,
    minSamples: Number.isSafeInteger(Number(raw?.minSamples))
      ? Number(raw.minSamples) : DEFAULT_BLUEPRINT_ADVANTAGE_MIN_SAMPLES,
    confidenceZ: Number.isFinite(Number(raw?.confidenceZ))
      ? Number(raw.confidenceZ) : DEFAULT_BLUEPRINT_ADVANTAGE_Z,
    minLowerBound: Number.isFinite(Number(raw?.minLowerBound))
      ? Number(raw.minLowerBound) : 0,
  });
}

function empiricalDistributionAdvantage(base, blueprint, infoSet, config) {
  const baseByKey = distributionByKey(base);
  const blueprintByKey = distributionByKey(blueprint);
  const keys = new Set([...baseByKey.keys(), ...blueprintByKey.keys()]);
  const coefficients = [...keys].map((actionKey) => ({
    actionKey,
    coefficient: (blueprintByKey.get(actionKey) || 0) - (baseByKey.get(actionKey) || 0),
  })).filter((entry) => Math.abs(entry.coefficient) > 1e-12);
  const statsByKey = new Map((infoSet?.actionValues || []).map((entry) => [entry.actionKey, entry]));
  let mean = 0;
  let conservativeMargin = 0;
  let covered = 0;
  let observedMinSamples = Number.POSITIVE_INFINITY;
  for (const { actionKey, coefficient } of coefficients) {
    const stats = statsByKey.get(actionKey);
    if (!stats) continue;
    observedMinSamples = Math.min(observedMinSamples, stats.samples);
    if (stats.samples < config.minSamples) continue;
    const variance = stats.samples > 1 ? stats.m2 / (stats.samples - 1) : Number.POSITIVE_INFINITY;
    const standardError = Math.sqrt(Math.max(0, variance) / stats.samples);
    if (!Number.isFinite(standardError)) continue;
    mean += coefficient * stats.mean;
    conservativeMargin += Math.abs(coefficient) * config.confidenceZ * standardError;
    covered++;
  }
  const complete = coefficients.length > 0 && covered === coefficients.length;
  const lowerBound = complete ? mean - conservativeMargin : null;
  return Object.freeze({
    evidence: 'training-action-values',
    complete,
    coveredActions: covered,
    requiredActions: coefficients.length,
    minSamples: Number.isFinite(observedMinSamples) ? observedMinSamples : 0,
    mean: complete ? mean : null,
    lowerBound,
    passed: complete && lowerBound > config.minLowerBound,
  });
}

const T95_ONE_SIDED = Object.freeze([
  Number.POSITIVE_INFINITY,
  6.3138, 2.92, 2.3534, 2.1318, 2.015, 1.9432, 1.8946,
  1.8595, 1.8331, 1.8125, 1.7959, 1.7823, 1.7709, 1.7613,
  1.7531, 1.7459, 1.7396, 1.7341, 1.7291, 1.7247, 1.7207,
  1.7171, 1.7139, 1.7109, 1.7081, 1.7056, 1.7033, 1.7011,
  1.6991, 1.6973,
]);

function oneSidedT95(degreesOfFreedom) {
  if (degreesOfFreedom < T95_ONE_SIDED.length) {
    return T95_ONE_SIDED[Math.max(1, degreesOfFreedom)];
  }
  return 1.644854 + 0.710 / Math.max(1, degreesOfFreedom);
}

function deterministicSeed(parts) {
  const text = parts.join('|');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function bootstrapLowerBound(values, iterations, seedParts) {
  let state = deterministicSeed(seedParts);
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
  const means = new Array(iterations);
  for (let iteration = 0; iteration < iterations; iteration++) {
    let total = 0;
    for (let draw = 0; draw < values.length; draw++) {
      total += values[Math.floor(next() * values.length)];
    }
    means[iteration] = total / values.length;
  }
  means.sort((left, right) => left - right);
  // The lower order statistic (rather than interpolation) keeps this finite
  // cluster percentile conservative and deterministic in every browser.
  return means[Math.max(0, Math.floor(iterations * 0.05) - 1)];
}

function calibratedDistributionAdvantage(
  base, blueprint, checkpoint, informationSetKey, config,
  { basePolicyContract, baseStyleKey } = {},
) {
  const calibration = COMPILED_EXACT_ROOT_CALIBRATIONS.get(checkpoint);
  const record = calibration?.records.get(informationSetKey);
  if (!record) return null;
  if (basePolicyContract !== record.basePolicyContract
    || baseStyleKey !== record.baseStyleKey) return null;
  const baseByKey = distributionByKey(base);
  const blueprintByKey = distributionByKey(blueprint);
  const keys = new Set([...baseByKey.keys(), ...blueprintByKey.keys()]);
  const coefficients = [...keys].map((actionKey) => ({
    actionKey,
    coefficient: (blueprintByKey.get(actionKey) || 0) - (baseByKey.get(actionKey) || 0),
  })).filter((entry) => Math.abs(entry.coefficient) > 1e-12);
  const actionIndex = new Map(record.actionKeys.map((actionKey, index) => [actionKey, index]));
  const covered = coefficients.filter(({ actionKey }) => actionIndex.has(actionKey)).length;
  const enoughClusters = record.independentClusterCount >= config.minSamples;
  const complete = coefficients.length > 0 && covered === coefficients.length && enoughClusters;
  if (covered !== coefficients.length || coefficients.length === 0) {
    return Object.freeze({
      evidence: 'frozen-exact-calibration',
      complete: false,
      coveredActions: covered,
      requiredActions: coefficients.length,
      minSamples: record.independentClusterCount,
      mean: null,
      lowerBound: null,
      tLowerBound: null,
      bootstrapLowerBound: null,
      passed: false,
    });
  }
  const contrasts = record.clusters.map((cluster) => coefficients.reduce(
    (sum, { actionKey, coefficient }) => (
      sum + coefficient * cluster.values[actionIndex.get(actionKey)]
    ), 0,
  ));
  const mean = contrasts.reduce((sum, value) => sum + value, 0) / contrasts.length;
  const m2 = contrasts.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const variance = contrasts.length > 1 ? m2 / (contrasts.length - 1) : Infinity;
  const standardError = Math.sqrt(Math.max(0, variance) / contrasts.length);
  const tLowerBound = mean - oneSidedT95(contrasts.length - 1) * standardError;
  const coefficientSeed = coefficients
    .sort((left, right) => compareActionKeys(left.actionKey, right.actionKey))
    .map(({ actionKey, coefficient }) => `${actionKey}:${coefficient.toPrecision(17)}`);
  const clusterBootstrapLowerBound = bootstrapLowerBound(
    contrasts,
    calibration.bootstrapIterations,
    [record.frozenPolicySha256, informationSetKey,
      ...record.clusters.map((cluster) => cluster.clusterId), ...coefficientSeed],
  );
  const lowerBound = Math.min(tLowerBound, clusterBootstrapLowerBound);
  return Object.freeze({
    evidence: 'frozen-exact-calibration',
    complete,
    coveredActions: covered,
    requiredActions: coefficients.length,
    minSamples: record.independentClusterCount,
    mean: complete ? mean : null,
    lowerBound: complete ? lowerBound : null,
    tLowerBound: complete ? tLowerBound : null,
    bootstrapLowerBound: complete ? clusterBootstrapLowerBound : null,
    passed: complete && lowerBound > config.minLowerBound,
  });
}

function expectedMixture(base, blueprint, effectiveWeight) {
  const combined = new Map();
  const add = (candidate, probability, source) => {
    const current = combined.get(candidate.actionKey) || {
      actionKey: candidate.actionKey,
      action: candidate.action,
      probability: 0,
      baseProbability: 0,
      blueprintProbability: 0,
      ev: candidate.ev,
    };
    current.probability += probability;
    current[`${source}Probability`] += candidate.probability;
    if (current.ev == null && candidate.ev != null) current.ev = candidate.ev;
    combined.set(candidate.actionKey, current);
  };
  for (const candidate of base) add(candidate, candidate.probability * (1 - effectiveWeight), 'base');
  for (const candidate of blueprint) {
    add(candidate, candidate.probability * effectiveWeight, 'blueprint');
  }
  return [...combined.values()]
    .sort((left, right) => compareActionKeys(left.actionKey, right.actionKey))
    .map((candidate) => Object.freeze({
      action: candidate.action,
      probability: candidate.probability,
      baseProbability: candidate.baseProbability,
      blueprintProbability: candidate.blueprintProbability,
      ev: candidate.ev,
    }));
}

function sampleDistribution(distribution, rng) {
  let roll = clamp(rng(), 0, 0.999999999999);
  let selected = distribution[distribution.length - 1];
  for (const candidate of distribution) {
    roll -= candidate.probability;
    if (roll < 0) {
      selected = candidate;
      break;
    }
  }
  return selected;
}

/** Safe per-decision metadata; it never contains the private information-set key. */
export function getBlueprintPolicyDiagnostics(policy) {
  return policy && typeof policy === 'object'
    ? POLICY_BLUEPRINT_DIAGNOSTICS.get(policy) || policy.blueprint || null
    : null;
}

/**
 * Bounded mixture of the existing range/EV policy and one checkpoint infoset.
 * No checkpoint, no key hit, zero weight, or no legal checkpoint action returns
 * the exact original basePolicy object without consuming RNG.
 */
export function blendBlueprintPolicy(basePolicy, {
  checkpoint = null,
  observation,
  opts = observation?.legalActions || {},
  informationSetKey = null,
  weight = checkpoint?.blendWeight,
  maxBlueprintWeight = DEFAULT_MAX_BLUEPRINT_WEIGHT,
  minVisits = DEFAULT_BLUEPRINT_MIN_VISITS,
  rng = Math.random,
  gateRng = rng,
  actionRng = rng,
  preferCall = false,
  basePolicyContract = null,
  baseStyleKey = null,
  blockedBlueprintActionKeys = [],
} = {}) {
  if (!basePolicy || typeof basePolicy !== 'object') {
    throw new TypeError('blendBlueprintPolicy requires a base policy object');
  }
  // A caller may reuse a cached base-policy object. Never let diagnostics from
  // an earlier hit survive a disabled or missed decision on that same object.
  POLICY_BLUEPRINT_DIAGNOSTICS.delete(basePolicy);
  if (!checkpoint || !COMPILED_TABLES.has(checkpoint)) return basePolicy;
  const cap = clamp(maxBlueprintWeight);
  const cappedWeight = Math.min(cap, clamp(
    weight == null ? DEFAULT_BLUEPRINT_WEIGHT : weight,
  ));
  if (!(cappedWeight > 0)) return basePolicy;
  const key = informationSetKey || buildBlueprintInfoSetKey(observation, {
    opts,
    maxRaisesPerStreet: checkpointRaiseCap(checkpoint),
  });
  const visitFloor = Math.max(0, finite(minVisits, DEFAULT_BLUEPRINT_MIN_VISITS));
  const blockedActions = new Set(Array.isArray(blockedBlueprintActionKeys)
    ? blockedBlueprintActionKeys.map(String) : []);
  const levels = ['exact', 'history', 'position', 'strategic', 'population'];
  const candidates = [key, ...blueprintBackoffKeys(key)]
    .map((candidateKey, index) => {
      const infoSet = lookupBlueprintDistribution(checkpoint, candidateKey);
      if (!infoSet) return null;
      const backoffLevel = levels[index] || `level-${index}`;
      if (backoffLevel === 'population'
        && !populationSupportEligible(checkpoint, infoSet, visitFloor)) return null;
      let strategy = legalDistribution(infoSet.strategy, opts)
        .filter((entry) => !blockedActions.has(entry.actionKey));
      const allowedTotal = strategy.reduce((sum, entry) => sum + entry.probability, 0);
      if (allowedTotal > 0 && Math.abs(allowedTotal - 1) > 1e-12) {
        strategy = strategy.map((entry) => ({
          ...entry,
          probability: entry.probability / allowedTotal,
        }));
      }
      return strategy.length ? {
        infoSet, strategy, informationSetKey: candidateKey,
        backoffLevel,
      } : null;
    })
    .filter(Boolean);
  if (!candidates.length) return basePolicy;
  const thresholdCandidate = candidates.find((candidate) => (
    visitFloor === 0 || candidate.infoSet.visits >= visitFloor
  ));
  const selectedCandidate = thresholdCandidate || [...candidates].sort((left, right) => (
    right.infoSet.visits - left.infoSet.visits
  ))[0];
  const {
    infoSet, strategy: blueprint, backoffLevel,
    informationSetKey: selectedInformationSetKey,
  } = selectedCandidate;
  if (!blueprint.length) {
    POLICY_BLUEPRINT_DIAGNOSTICS.set(basePolicy, Object.freeze({
      schema: checkpoint.schema,
      hit: false,
      keyHit: true,
      eligible: false,
      effectiveWeight: 0,
      weight: 0,
      requestedWeight: clamp(weight == null ? DEFAULT_BLUEPRINT_WEIGHT : weight),
      confidence: 0,
      nodeVisits: infoSet.visits,
      backoffLevel,
      policyTV: 0,
      influence: 0,
      intervened: false,
      actionChanged: false,
      iterations: Number.isFinite(Number(checkpoint.metadata?.iterations))
        ? Number(checkpoint.metadata.iterations) : null,
    }));
    return basePolicy;
  }
  const confidence = visitFloor === 0 ? 1 : infoSet.visits / (infoSet.visits + visitFloor);
  const backoffMultiplier = BLUEPRINT_BACKOFF_WEIGHT_MULTIPLIERS[backoffLevel] ?? 0;
  const base = baseDistribution(basePolicy, opts);
  const policyTV = totalVariation(base, blueprint);
  const guardConfig = advantageGuardConfig(checkpoint);
  // Independently sampled evidence is intentionally narrower than training
  // moments: only the exact frozen node may consume it. Every backoff level,
  // missing record, and legacy checkpoint retains the original conservative
  // actionValues guard unchanged.
  const advantage = (backoffLevel === 'exact'
    ? calibratedDistributionAdvantage(
      base, blueprint, checkpoint, selectedInformationSetKey, guardConfig,
      { basePolicyContract, baseStyleKey },
    ) : null)
    || empiricalDistributionAdvantage(base, blueprint, infoSet, guardConfig);
  const advantageEligible = !guardConfig.enabled || advantage.passed;
  const effectiveWeight = advantageEligible
    ? cappedWeight * confidence * backoffMultiplier : 0;
  const influence = effectiveWeight * policyTV;
  const iterations = Number.isFinite(Number(checkpoint.metadata?.iterations))
    ? Number(checkpoint.metadata.iterations) : null;
  const commonDiagnostics = {
    schema: checkpoint.schema,
    hit: true,
    keyHit: true,
    eligible: advantageEligible,
    effectiveWeight,
    weight: effectiveWeight,
    requestedWeight: clamp(weight == null ? DEFAULT_BLUEPRINT_WEIGHT : weight),
    confidence,
    backoffMultiplier,
    nodeVisits: infoSet.visits,
    backoffLevel,
    policyTV,
    influence,
    advantageGuardEnabled: guardConfig.enabled,
    advantageEvidence: advantage.evidence,
    advantageComplete: advantage.complete,
    advantagePassed: advantage.passed,
    advantageMean: advantage.mean,
    advantageLowerBound: advantage.lowerBound,
    advantageTLowerBound: advantage.tLowerBound ?? null,
    advantageBootstrapLowerBound: advantage.bootstrapLowerBound ?? null,
    advantageMinSamples: advantage.minSamples,
    advantageCoveredActions: advantage.coveredActions,
    advantageRequiredActions: advantage.requiredActions,
    iterations,
    baseActionKey: actionToBlueprintKey(
      legalizeBlueprintAction(basePolicy.action, opts, { preferCall }),
    ),
    // Public/self-information action vectors used only by the opt-in offline
    // residual collector. They contain no raw infoset key and never affect
    // sampling or the live policy object.
    baseStrategy: Object.freeze(base.map((entry) => Object.freeze({
      actionKey: entry.actionKey,
      probability: entry.probability,
    }))),
    targetStrategy: Object.freeze(blueprint.map((entry) => Object.freeze({
      actionKey: entry.actionKey,
      probability: entry.probability,
    }))),
  };
  // A key hit with zero confidence or an identical policy is useful coverage
  // telemetry, but cannot causally change the selected base action and must
  // not consume the intervention RNG stream.
  if (!(effectiveWeight > 0) || !(policyTV > 0)) {
    POLICY_BLUEPRINT_DIAGNOSTICS.set(basePolicy, Object.freeze({
      ...commonDiagnostics,
      intervened: false,
      actionChanged: false,
    }));
    return basePolicy;
  }

  const intervened = clamp(gateRng(), 0, 0.999999999999) < effectiveWeight;
  if (!intervened) {
    POLICY_BLUEPRINT_DIAGNOSTICS.set(basePolicy, Object.freeze({
      ...commonDiagnostics,
      intervened: false,
      actionChanged: false,
    }));
    return basePolicy;
  }

  const selectedBlueprint = sampleDistribution(blueprint, actionRng);
  const action = legalizeBlueprintAction(selectedBlueprint.action, opts, { preferCall });
  const baseAction = legalizeBlueprintAction(basePolicy.action, opts, { preferCall });
  const actionChanged = actionToBlueprintKey(action) !== actionToBlueprintKey(baseAction);
  const diagnostics = Object.freeze({
    ...commonDiagnostics,
    intervened: true,
    actionChanged,
    selectedActionKey: actionToBlueprintKey(action),
  });
  const result = {
    ...basePolicy,
    action,
    distribution: expectedMixture(base, blueprint, effectiveWeight),
    selected: Object.freeze({ ...selectedBlueprint, source: 'blueprint' }),
    blueprint: diagnostics,
  };
  POLICY_BLUEPRINT_DIAGNOSTICS.set(result, diagnostics);
  return result;
}
