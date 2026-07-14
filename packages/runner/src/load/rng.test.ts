import { describe, expect, it } from "vitest";

import { prng } from "./rng.js";

// The counter-style keyed PRNG (§6.5) is a PURE function of (seed, keys), so every
// assertion here is deterministic — including the distribution checks (fixed inputs
// give fixed outputs; nothing is flaky).
describe("prng — counter-style keyed random stream", () => {
  it("is a pure function: same seed + keys always yields the same value", () => {
    expect(prng("seed-a", "mix", 7)).toBe(prng("seed-a", "mix", 7));
    expect(prng("seed-a", "pacing", 3, 12)).toBe(prng("seed-a", "pacing", 3, 12));
    expect(prng("seed-a")).toBe(prng("seed-a"));
  });

  it("changes with the seed and with every key position", () => {
    const base = prng("seed-a", "mix", 7);
    expect(prng("seed-b", "mix", 7)).not.toBe(base); // seed matters
    expect(prng("seed-a", "pacing", 7)).not.toBe(base); // stream name matters
    expect(prng("seed-a", "mix", 8)).not.toBe(base); // counter matters
  });

  it("encodes the key tuple injectively (no concatenation or type collisions)", () => {
    expect(prng("s", "ab")).not.toBe(prng("s", "a", "b")); // ["ab"] ≠ ["a","b"]
    expect(prng("s", "mix", 11)).not.toBe(prng("s", "mix1", 1)); // boundary can't shift
    expect(prng("s", 1)).not.toBe(prng("s", "1")); // number ≠ string
    expect(prng("sx", "y")).not.toBe(prng("s", "xy")); // seed/key boundary holds
  });

  it("stays in [0,1) across a large keyed sweep", () => {
    for (let i = 0; i < 1000; i++) {
      const v = prng("range-seed", "sweep", i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("spreads a counter sweep roughly uniformly (sanity, not a statistical proof)", () => {
    // 2000 consecutive counter values must not clump: every decile gets a healthy
    // share (expected 200 each) and the mean sits near 0.5. Deterministic inputs —
    // this guards against a broken mixer (e.g. low bits stuck), not proves quality.
    const buckets = new Array<number>(10).fill(0);
    let sum = 0;
    for (let i = 0; i < 2000; i++) {
      const v = prng("uniformity-seed", "u", i);
      buckets[Math.floor(v * 10)] += 1;
      sum += v;
    }
    for (const count of buckets) expect(count).toBeGreaterThan(100);
    expect(sum / 2000).toBeGreaterThan(0.45);
    expect(sum / 2000).toBeLessThan(0.55);
  });
});
