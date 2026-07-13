// Small serializable PRNG used by offline training.  Keeping the generator
// state in checkpoints makes "N iterations + resume M" byte-for-byte
// reproducible with a single uninterrupted N+M run.

const UINT32_RANGE = 0x1_0000_0000;

function hashSeed(seed) {
  if (Number.isInteger(seed)) return Number(seed) >>> 0;
  const text = String(seed ?? 'qyj-blueprint');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class SerializableRng {
  constructor(seed = 'qyj-blueprint', state = null) {
    this.seed = String(seed);
    this.state = state == null ? hashSeed(seed) : Number(state) >>> 0;
  }

  next() {
    // Mulberry32.  This is a simulation PRNG, not a cryptographic generator.
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / UINT32_RANGE;
  }

  int(maxExclusive) {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError('SerializableRng.int requires a positive integer');
    }
    return Math.floor(this.next() * maxExclusive);
  }

  snapshot() {
    return Object.freeze({ algorithm: 'mulberry32', seed: this.seed, state: this.state >>> 0 });
  }

  static restore(snapshot) {
    if (!snapshot || snapshot.algorithm !== 'mulberry32'
      || !Number.isInteger(Number(snapshot.state))) {
      throw new TypeError('Invalid mulberry32 RNG snapshot');
    }
    return new SerializableRng(snapshot.seed, Number(snapshot.state));
  }
}

export function sampleIndex(probabilities, rng) {
  if (!Array.isArray(probabilities) || probabilities.length === 0) {
    throw new RangeError('sampleIndex requires at least one probability');
  }
  let roll = rng.next();
  for (let index = 0; index < probabilities.length; index++) {
    roll -= Math.max(0, Number(probabilities[index]) || 0);
    if (roll < 0) return index;
  }
  return probabilities.length - 1;
}
