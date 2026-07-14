/**
 * Counter-style keyed PRNG for load-run random decisions (distributed-execution
 * proposal §6.5).
 *
 * `prng(seed, ...keys)` is a PURE function `hash(seed, keys) → [0,1)`. There is
 * NO sequential generator state: every random decision in a run is keyed by its
 * GLOBAL identity — e.g. `prng(seed, "mix", iterationIndex)` for traffic-mix
 * selection, `prng(seed, feederSlotKey, iterationIndex)` for a random feeder
 * draw, `prng(seed, "pacing", iterationIndex)` for think-time jitter (keyed by
 * the iteration, not the slot: the iteration→slot binding is scheduling-driven
 * and non-deterministic, so slot-keyed streams would not replay).
 * Same seed + same keys ⇒ same value, in any process, in any call order. That
 * is what makes a distributed run's randomness independent of the worker count
 * (each worker computes the same value for the same global decision) and makes
 * any run reproducible from the `rngSeed` recorded in its artifact config.
 *
 * Implementation choice: cyrb53 (public-domain 53-bit string hash by bryc — the
 * FNV/xxhash family: two 32-bit `imul` mix lanes over the input, cross-mixed by
 * a murmur3-style finalizer), over a JSON-encoded key tuple, mapped to [0,1) by
 * `/ 2**53`. Chosen because it is tiny, zero-dependency, fast (no BigInt), and
 * has good avalanche behavior for this use. It is NOT cryptographic and its
 * statistical quality is "good enough for load-test decision streams", not
 * formally proven — do not use it for anything security-sensitive.
 */

/**
 * Deterministic keyed random value in [0,1).
 *
 * The key tuple is encoded with `JSON.stringify`, which is injective over
 * string/finite-number keys (`["a","b"]` ≠ `["ab"]`, `1` ≠ `"1"`), so distinct
 * decision identities can't collide by concatenation. (Non-finite numbers all
 * encode as `null` — keys here are indices and names, so that never applies.)
 */
export function prng(seed: string, ...keys: Array<string | number>): number {
  const input = JSON.stringify([seed, ...keys]);
  // cyrb53: two 32-bit lanes absorb the input…
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  // …then a murmur3-style cross-lane finalizer avalanches the state.
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  // 53-bit unsigned result (21 high bits from h2, 32 low bits from h1) → [0,1).
  const h53 = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return h53 / 2 ** 53;
}
