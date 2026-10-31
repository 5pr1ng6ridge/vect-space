/**
 * Deterministic randomness for the sketch UI generator.  Every asset seeds its
 * own generator from its name, so regenerating produces byte-identical SVGs and
 * editing one asset never reshuffles the others.
 */

export function hashString(text) {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32 with a few convenience methods. */
export function makeRng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    next,
    /** Uniform in [a, b). */
    range: (a, b) => a + (b - a) * next(),
    /** Integer in [a, b]. */
    int: (a, b) => Math.floor(a + (b - a + 1) * next()),
    sign: () => (next() < 0.5 ? -1 : 1),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    /** Roughly normal, mean 0, deviation 1 (sum of three uniforms). */
    gauss: () => (next() + next() + next() - 1.5) * 2,
    /** An independent generator derived from this one and a label. */
    fork: (label) =>
      makeRng(hashString(label) ^ Math.floor(next() * 4294967296)),
  };
  return rng;
}

/**
 * Smooth 1-D value noise in [-1, 1] over t in [0, 1] with `cells` lattice
 * cells; the lattice values are drawn from `rng` up front.
 */
export function smoothNoise(rng, cells) {
  const count = Math.max(1, Math.ceil(cells));
  const values = Array.from({ length: count + 1 }, () => rng.range(-1, 1));
  return (t) => {
    const x = Math.min(Math.max(t, 0), 1) * count;
    const i = Math.min(Math.floor(x), count - 1);
    const f = x - i;
    const s = f * f * (3 - 2 * f);
    return values[i] * (1 - s) + values[i + 1] * s;
  };
}
