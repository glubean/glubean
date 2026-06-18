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
});
