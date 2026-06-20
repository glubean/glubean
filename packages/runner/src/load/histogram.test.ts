import { describe, expect, it } from "vitest";
import { LoadHistogram } from "./histogram.js";

describe("LoadHistogram", () => {
  it("reports zeros for an empty histogram", () => {
    const h = new LoadHistogram();
    expect(h.count).toBe(0);
    expect(h.percentile(50)).toBe(0);
    expect(h.percentiles()).toEqual({ p50: 0, p90: 0, p95: 0, p99: 0, max: 0 });
  });

  it("tracks count / sum / min / max / mean exactly", () => {
    const h = new LoadHistogram();
    for (const v of [10, 20, 30, 40]) h.record(v);
    expect(h.count).toBe(4);
    expect(h.sum).toBe(100);
    expect(h.min).toBe(10);
    expect(h.max).toBe(40);
    expect(h.mean).toBe(25);
  });

  it("estimates percentiles within the relative-error bound (and never below true)", () => {
    const h = new LoadHistogram(0.01); // 1%
    for (let v = 1; v <= 1000; v++) h.record(v);
    // nearest-rank true values: p50≈500, p90≈900, p95≈950, p99≈990
    const within = (got: number, truth: number) => {
      expect(got).toBeGreaterThanOrEqual(truth * 0.99); // bucket upper bound ≥ true (allow tiny slack)
      expect(got).toBeLessThanOrEqual(truth * 1.02); // ≤ ~relativeError over
    };
    within(h.percentile(50), 500);
    within(h.percentile(90), 900);
    within(h.percentile(95), 950);
    within(h.percentile(99), 990);
    expect(h.max).toBe(1000); // max is exact
    expect(h.percentile(100)).toBe(1000);
    expect(h.percentile(0)).toBe(1); // min
  });

  it("keeps the bucket count bounded (logarithmic in the value range)", () => {
    const h = new LoadHistogram(0.01);
    for (let v = 1; v <= 100_000; v++) h.record(v);
    expect(h.count).toBe(100_000);
    // ~log_1.01(100000) ≈ 1157 buckets — far fewer than 100k samples.
    expect(h.bucketCount).toBeLessThan(1300);
  });

  it("handles zero and ignores non-finite values", () => {
    const h = new LoadHistogram();
    h.record(0);
    h.record(0);
    h.record(100);
    h.record(Number.NaN);
    h.record(Number.POSITIVE_INFINITY);
    expect(h.count).toBe(3); // NaN / Infinity ignored
    expect(h.min).toBe(0);
    expect(h.percentile(50)).toBe(0); // median falls in the zero bucket (2 of 3)
  });

  it("merges two histograms of the same relativeError", () => {
    const a = new LoadHistogram(0.01);
    const b = new LoadHistogram(0.01);
    for (let v = 1; v <= 500; v++) a.record(v);
    for (let v = 501; v <= 1000; v++) b.record(v);
    a.merge(b);
    expect(a.count).toBe(1000);
    expect(a.max).toBe(1000);
    expect(a.min).toBe(1);
    expect(a.percentile(50)).toBeGreaterThanOrEqual(495);
    expect(a.percentile(50)).toBeLessThanOrEqual(510);
  });

  it("rejects merging histograms with a different relativeError", () => {
    const a = new LoadHistogram(0.01);
    const b = new LoadHistogram(0.02);
    expect(() => a.merge(b)).toThrow(/relativeError/);
  });

  it("rejects an out-of-range relativeError", () => {
    expect(() => new LoadHistogram(0)).toThrow();
    expect(() => new LoadHistogram(1)).toThrow();
  });

  it("distribution() buckets observations against a fixed ladder + a tail overflow", () => {
    const h = new LoadHistogram();
    [5, 5, 5, 60, 60, 250, 8000].forEach((v) => h.record(v));
    expect(h.distribution([10, 100, 500])).toEqual([
      { leMs: 10, count: 3 }, // the three 5ms
      { leMs: 100, count: 2 }, // the two 60ms
      { leMs: 500, count: 1 }, // the 250ms
      { leMs: 8000, count: 1 }, // overflow (> 500ms) — leMs is the observed max
    ]);
  });

  it("distribution() has no overflow bucket when everything is within the ladder", () => {
    const h = new LoadHistogram();
    [5, 60].forEach((v) => h.record(v));
    expect(h.distribution([10, 100])).toEqual([
      { leMs: 10, count: 1 },
      { leMs: 100, count: 1 },
    ]);
  });

  it("distribution() puts a boundary-edge sample in its bucket, not a false overflow", () => {
    // codex: 5000ms with the default 1% histogram has a log-bucket upper bound ~5001 > 5000;
    // it must still land in the ≤5000 bucket, not spawn a bogus overflow bucket.
    const h = new LoadHistogram();
    [100, 5000].forEach((v) => h.record(v));
    const dist = h.distribution([200, 5000]);
    expect(dist).toEqual([
      { leMs: 200, count: 1 }, // the 100ms
      { leMs: 5000, count: 1 }, // the 5000ms — in the last bucket, NOT a separate overflow
    ]);
    expect(dist.reduce((s, b) => s + b.count, 0)).toBe(2); // every sample counted exactly once
  });

  it("distribution() keeps an exact boundary value in its own bucket (1000 → ≤1000)", () => {
    // codex: with the 1% histogram, record(1000) sits in a log bucket whose upper bound /
    // midpoint exceed 1000; it must still land in the ≤1000 bucket, not ≤2000 / overflow.
    const h = new LoadHistogram();
    h.record(1000);
    expect(h.distribution([500, 1000, 2000])).toEqual([
      { leMs: 500, count: 0 },
      { leMs: 1000, count: 1 }, // exactly on the boundary → this bucket
      { leMs: 2000, count: 0 },
    ]);
  });

  it("distribution() is empty with no observations", () => {
    expect(new LoadHistogram().distribution([10, 100])).toEqual([]);
  });
});
