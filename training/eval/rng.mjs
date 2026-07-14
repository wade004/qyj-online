// Deterministic random helpers for offline AI evaluation.
// These functions deliberately have no dependency on the game runtime so a
// report can always be reproduced from its printed seed.

export function hashSeed(value) {
  const input = String(value ?? '');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function deriveSeed(...parts) {
  // Length-prefix every component so ['ab', 'c'] and ['a', 'bc'] cannot
  // silently produce the same derived seed.
  return hashSeed(parts.map((part) => {
    const text = String(part ?? '');
    return `${text.length}:${text}`;
  }).join('|'));
}

export function createSeededRng(seed) {
  let state = typeof seed === 'number' && Number.isFinite(seed)
    ? seed >>> 0
    : hashSeed(seed);
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleWithReplacement(values, count, rng) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const result = [];
  for (let index = 0; index < count; index++) {
    result.push(values[Math.floor(rng() * values.length)]);
  }
  return result;
}
