/**
 * rng.js — deterministic randomness, and the one seed a game is identified by.
 *
 * Everything random in Ridgeline comes from here; nothing reads Math.random()
 * or the clock. That is not tidiness, it is what makes three things possible:
 *
 *   - A run is fully described by its seed, so a golden screenshot, the
 *     playability simulation in tools/simulate.py and a bug report can all
 *     reproduce the same tower exactly.
 *   - Difficulty tuning is done by simulating thousands of runs, which is only
 *     meaningful if a seed replays.
 *   - Tests can pin a behaviour to a seed instead of to a fuzzy average.
 *
 * sfc32, with the seeding folded through four mixing multiplies and 8 discarded
 * outputs. Two properties are checked by tests/rng.test.mjs rather than
 * assumed, because the first version of this file shipped a bug that only a
 * test of exactly these properties caught:
 *
 *   1. Successive outputs are uncorrelated. A step written so that `d` was
 *      returned directly produced 3206914815, 3206914816, 3206914817... —
 *      consecutive integers. Layouts generated with it looked plausible and the
 *      suite would not have noticed.
 *   2. Seeds differing by one character share no first output, so run 7 and run
 *      8 are different towers from the first draw.
 */

/** sfc32 with 8 warm-up steps; see the properties above. */
const WARMUP_STEPS = 8;

export function makeRng(seedText) {
  if (typeof seedText !== 'string' || seedText.length === 0) {
    throw new Error('makeRng requires a non-empty seed string');
  }

  let h1 = 0x9e3779b9;
  let h2 = 0x85ebca6b;
  let h3 = 0xc2b2ae35;
  let h4 = 0x27d4eb2f;
  for (let i = 0; i < seedText.length; i += 1) {
    const ch = seedText.charCodeAt(i);
    h1 = (Math.imul(h1 ^ ch, 2654435761)) >>> 0;
    h2 = (Math.imul(h2 + ch, 1597334677)) >>> 0;
    h3 = (Math.imul(h3 ^ ch, 2246822519) + h1) >>> 0;
    h4 = (Math.imul(h4 + ch, 3266489917) ^ h2) >>> 0;
  }
  let a = h1 >>> 0;
  let b = h2 >>> 0;
  let c = h3 >>> 0;
  let d = h4 >>> 0;

  /** One sfc32 step. Returns uint32. */
  function next() {
    const t = ((a << 9) ^ a) >>> 0;
    a = (b + d) >>> 0;
    // b << 3 alone would drop the top three bits of b out of the state forever
    // once rotated through; the rotate keeps all 32 in play.
    b = ((b << 3) | (b >>> 29)) ^ c;
    c = (((c >>> 8) ^ c) << 0) >>> 0;
    c = (c ^ t) >>> 0;
    d = (d + 1) >>> 0;
    return c >>> 0;
  }

  for (let i = 0; i < WARMUP_STEPS; i += 1) next();

  /** Uniform float in [0, 1). */
  function float() {
    return next() / 4294967296;
  }

  /** Uniform integer in [0, maxExclusive). */
  function int(maxExclusive) {
    if (!(maxExclusive >= 1)) throw new Error(`int() needs a positive bound, got ${maxExclusive}`);
    return next() % maxExclusive;
  }

  /** Uniform integer in [min, max] inclusive. */
  function range(min, max) {
    return min + int(max - min + 1);
  }

  /** True with the given probability, as an integer percent out of 100. */
  function chance(percent) {
    return int(100) < percent;
  }

  /** Pick one element. Throws on an empty list rather than returning undefined. */
  function pick(list) {
    if (!Array.isArray(list) || list.length === 0) throw new Error('pick() needs a non-empty array');
    return list[int(list.length)];
  }

  /** Weighted pick from [[item, weight], ...]. Weights must be non-negative. */
  function weighted(pairs) {
    let total = 0;
    for (const [, weight] of pairs) {
      if (!(weight >= 0)) throw new Error('weighted() needs non-negative weights');
      total += weight;
    }
    if (total <= 0) throw new Error('weighted() needs a positive total weight');
    let roll = float() * total;
    for (const [item, weight] of pairs) {
      roll -= weight;
      if (roll < 0) return item;
    }
    return pairs[pairs.length - 1][0];
  }

  /** Fisher-Yates, in place; returns the same array. */
  function shuffle(list) {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = int(i + 1);
      const tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    return list;
  }

  /** Snapshot / restore, so the playability harness can replay from a point. */
  function save() {
    return [a, b, c, d];
  }

  function restore(state) {
    [a, b, c, d] = state;
  }

  return { next, float, int, range, chance, pick, weighted, shuffle, save, restore };
}

/**
 * Seed text for run N of an epoch. A plain string rather than a number so a
 * player can be told a seed and repeat it, and so an epoch bump (a balance
 * change) cannot silently collide with a tower from the old balance.
 */
export function seedForRun(epoch, runIndex) {
  if (!Number.isInteger(runIndex) || runIndex < 0) throw new Error('runIndex must be a non-negative integer');
  return `ridgeline-${epoch}-${runIndex}`;
}
