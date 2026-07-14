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

  it("rejects a relativeError below the supported floor (1e-9)", () => {
    // codex R7: machine rounding in the log/exp bucket math contributes up to ~1.3e-12
    // relative error across the double range, so a configured error below that scale
    // cannot be honoured (and near 2e-16 base collapses to exactly 1 — a divide-by-zero
    // in record()). The 1e-9 floor keeps the configured error three orders of magnitude
    // above float noise and prunes that whole pathological corner of the domain.
    expect(() => new LoadHistogram(1e-10)).toThrow(/relativeError must be in \[1e-9, 1\)/);
    expect(() => new LoadHistogram(1e-15)).toThrow(/relativeError/);
    expect(() => new LoadHistogram(2e-16)).toThrow(/relativeError/);
    expect(() => new LoadHistogram(Number.MIN_VALUE)).toThrow(/relativeError/);
    expect(() => new LoadHistogram(1e-9)).not.toThrow(); // the floor itself is supported
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

  it("distribution() places a sample one ULP above a rung into that rung (lower-edge rule)", () => {
    // codex R9: placement keys on the bucket's LOWER edge (index idx − 1), not its upper
    // edge. record(1 + ε) lands in bucket 1, whose lower edge bucketBound(0) = 1 ≤ the
    // rung at 1 — the documented one-bucket round-down slack — but the old idx ≤ rungIdx
    // comparison used the upper edge and spilled it into a false overflow bucket.
    const h = new LoadHistogram(0.01);
    h.record(1.0000000000000002); // 1 + ε → bucket 1
    expect(h.distribution([1])).toEqual([{ leMs: 1, count: 1 }]);
  });

  it("distribution() excludes a rung strictly below the bucket's lower edge (R10)", () => {
    // codex R10: the R9 index-only condition (idx − 1 ≤ rungIdx) also admitted rungs
    // STRICTLY BELOW the bucket's lower edge whenever they shared its index —
    // record(1.0100001) lands in bucket 2 (lower edge ≈ 1.01) and the rung 1.009 has
    // index 1 === idx − 1, so the sample was counted as ≤ 1.009 and the CDF tail
    // under-reported. The two-part predicate falls back to the value comparison
    // bucketBound(idx−1) ≤ r in exactly that sliver: 1.01 ≤ 1.009 is false → overflow.
    const h = new LoadHistogram(0.01);
    h.record(1.0100001);
    expect(h.distribution([1.009])).toEqual([
      { leMs: 1.009, count: 0 },
      { leMs: 1.0100001, count: 1 }, // overflow: the sample is genuinely > 1.009
    ]);
  });

  it("distribution() placement agrees with the computed-lower-edge oracle (seeded sweep)", () => {
    // Differential check of the two-part predicate: for every sample, its bucket's
    // COMPUTED lower edge exp((idx−1)·logBase) is the placement oracle — the sample goes
    // into the first rung ≥ that edge, or overflow when none is. Random (seeded, so
    // deterministic) samples sit far from bucket boundaries relative to float jitter, so
    // the oracle is exact here; the boundary slivers are covered by the R1/R6/R9/R10
    // cases above.
    let s = 42;
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
    for (let t = 0; t < 200; t++) {
      const relativeError = [0.001, 0.01, 0.05, 0.3, 0.9][Math.floor(rand() * 5)];
      const logBase = Math.log(1 + relativeError);
      const samples = Array.from({ length: 1 + Math.floor(rand() * 4) }, () =>
        Math.exp(rand() * 40 - 15),
      );
      const ladder = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 3) }, () =>
        Math.exp(rand() * 40 - 15),
      ))].sort((a, b) => a - b);
      const h = new LoadHistogram(relativeError);
      samples.forEach((v) => h.record(v));
      const expected = ladder.map((leMs) => ({ leMs, count: 0 }));
      let overflow = 0;
      const max = Math.max(...samples);
      for (const v of samples) {
        const idx = Math.ceil(Math.log(v) / logBase);
        const lowerEdge = Math.exp((idx - 1) * logBase);
        const i = ladder.findIndex((r) => r >= lowerEdge);
        if (i === -1) overflow += 1;
        else expected[i].count += 1;
      }
      if (overflow > 0) expected.push({ leMs: max, count: overflow });
      expect(h.distribution(ladder)).toEqual(expected);
    }
  });

  it("distribution() adjudicates a rung within float jitter of an edge by its index (documented)", () => {
    // codex R11 — DOCUMENTED behavior, not a bug fix: this rung sits one ULP below the
    // computed lower edge of the sample's bucket, yet its ceil(log/logBase) index rounds
    // to the sample's own bucket index, so the first predicate branch places the sample
    // at ≤ rung. Floating point cannot honour both infinite-precision sides of this
    // sliver at once (R6 showed the value comparison failing in the OPPOSITE direction);
    // the contract is the deterministic encoder-index verdict — identical formula to
    // record(), so consistent across processes — and any CDF deviation stays within the
    // histogram's one-bucket (relativeError) placement resolution.
    const logBase = Math.log(1.3);
    const edge = Math.exp(-508 * logBase); // computed lower edge of bucket −507
    const rung = edge * (1 - Number.EPSILON); // one ULP below that edge …
    // … construction premises (assert them so a Math.log change fails loudly):
    expect(rung).toBeLessThan(edge);
    expect(Math.ceil(Math.log(rung) / logBase)).toBe(-507); // … yet same index
    const v = Math.exp(-507.5 * logBase); // sample mid-bucket −507
    const h = new LoadHistogram(0.3);
    h.record(v);
    expect(h.distribution([rung])).toEqual([{ leMs: rung, count: 1 }]); // placed, no overflow
  });

  it("distribution() keeps a boundary-exact sample out of a bogus overflow bucket", () => {
    // codex R6: exp((idx−1)·logBase) can round a hair ABOVE a sample sitting exactly on a
    // bucket boundary, so the old value-space rung comparison spilled it into a false
    // overflow bucket. Rung placement now compares encoder-computed INDICES — the sample
    // and the rung run the identical ceil(log/logBase), so there is no float edge at all.
    const v = 7.430345113555486e-306;
    const h = new LoadHistogram(0.99);
    h.record(v);
    expect(h.distribution([v])).toEqual([{ leMs: v, count: 1 }]);
  });

  // Quantile intervals: percentileBounds() returns the hit bucket's [lower, upper] so the
  // true nearest-rank quantile is bracketed; threshold evaluation compares against the
  // conservative side instead of trusting a point estimate.

  it("percentileBounds() brackets the true quantile and matches percentiles() on the upper side", () => {
    const relativeError = 0.01;
    const h = new LoadHistogram(relativeError);
    for (let v = 1; v <= 1000; v++) h.record(v);
    const bounds = h.percentileBounds();
    const pcts = h.percentiles();
    // nearest-rank truth for 1..1000: rank ceil(p/100 · 1000) = the value itself
    const truth = { p50: 500, p90: 900, p95: 950, p99: 990 } as const;
    for (const key of ["p50", "p90", "p95", "p99"] as const) {
      const { lower, upper } = bounds[key];
      expect(lower).toBeLessThan(upper);
      expect(lower).toBeLessThanOrEqual(truth[key]); // true value ∈ (lower, upper]
      expect(upper).toBeGreaterThanOrEqual(truth[key]);
      // percentile() IS the interval's upper bound — one implementation (codex R11), so
      // the point estimate inherits the outward rounding and stays ≥ the true value.
      expect(upper).toBe(pcts[key]);
      expect(lower).toBeLessThanOrEqual(pcts[key]);
      // Adjacent log-bucket bounds differ by the factor base = 1 + relativeError, so the
      // interval's relative width is relativeError (clamping upper to the observed max
      // only narrows it) plus the outward ULP rounding — orders of magnitude below the
      // 1e-9-relative slack allowed here.
      expect((upper - lower) / lower).toBeLessThanOrEqual(relativeError * (1 + 1e-9));
    }
    expect(bounds.max).toEqual({ lower: pcts.max, upper: pcts.max }); // max is exact
  });

  it("percentileBounds() keeps the upper-side identity across shapes (zeros / single / mixed)", () => {
    const zeros = new LoadHistogram();
    [0, 0, 0].forEach((v) => zeros.record(v));
    const single = new LoadHistogram();
    single.record(1000); // its log bucket's upper bound > 1000 → both sides clamp to max
    const mixed = new LoadHistogram(0.05);
    [-7, 0.25, 3, 42, 999, 1e8].forEach((v) => mixed.record(v)); // sub-ms → negative bucket index
    for (const h of [zeros, single, mixed]) {
      const bounds = h.percentileBounds();
      const pcts = h.percentiles();
      for (const key of ["p50", "p90", "p95", "p99", "max"] as const) {
        // percentile() delegates to the interval's upper bound — exact identity.
        expect(bounds[key].upper).toBe(pcts[key]);
        expect(bounds[key].lower).toBeLessThanOrEqual(bounds[key].upper);
      }
    }
  });

  it("percentileBounds() brackets a boundary-exact sample (outward ULP rounding)", () => {
    // codex R3: `base ** idx` can round one ULP below the real bucket boundary, so a
    // sample within one representable float of the boundary could otherwise escape
    // [lower, upper]. Sweep computed boundaries (and their ±1 ULP neighbours) across
    // magnitudes and relativeErrors; pairing each with a 1000× larger sample keeps
    // p50 = the boundary sample while leaving the interval's upper end unclamped by max.
    const sweeps: Array<[number, number[]]> = [
      [0.01, [-800, -407, -101, -3, 0, 7, 162, 555, 800]],
      [0.001, [-5000, -1234, 0, 1111, 4999]],
      [0.3, [-200, -57, 0, 3, 89, 200]],
      [1e-9, [-5e11, -1e10, 1e10, 7e10, 2e11]], // the relativeError floor → huge |idx|
    ];
    for (const [relativeError, ks] of sweeps) {
      const base = 1 + relativeError;
      for (const k of ks) {
        const boundary = base ** k;
        const neighbours = [
          boundary,
          boundary * (1 - Number.EPSILON),
          boundary * (1 + Number.EPSILON),
        ];
        for (const v of neighbours) {
          const h = new LoadHistogram(relativeError);
          h.record(v);
          h.record(v * 1000);
          const { p50 } = h.percentileBounds(); // p50 rank 1 of 2 → the boundary sample
          expect(p50.lower).toBeLessThanOrEqual(v);
          expect(p50.upper).toBeGreaterThanOrEqual(v);
        }
      }
    }
  });

  it("percentileBounds() is all zero-width intervals with no samples (matches percentiles())", () => {
    const zero = { lower: 0, upper: 0 };
    expect(new LoadHistogram().percentileBounds()).toEqual({
      p50: zero,
      p90: zero,
      p95: zero,
      p99: zero,
      max: zero,
    });
  });

  it("percentile() stays at the true quantile for samples in the top reachable bucket", () => {
    // codex R8: with log-space bounds the top bucket's computed upper bound can round
    // below MAX_VALUE without overflowing (the old base**idx path overflowed to Infinity
    // and the max clamp saved it), so percentile() returned LESS than the true quantile
    // for samples at the float ceiling. bucketUpperBound() pins the top reachable bucket
    // to MAX_VALUE — its true per-sample upper bound — before the max clamp.
    const h = new LoadHistogram(0.9999999999999999); // in-domain trigger (deficit ~4e294)
    h.record(Number.MAX_VALUE);
    h.record(Number.MAX_VALUE);
    const pcts = h.percentiles();
    for (const key of ["p50", "p90", "p95", "p99", "max"] as const) {
      expect(pcts[key]).toBe(Number.MAX_VALUE); // every sample IS the max
    }
    const bounds = h.percentileBounds();
    expect(bounds.p50.upper).toBe(Number.MAX_VALUE);
    expect(bounds.p50.lower).toBeLessThanOrEqual(Number.MAX_VALUE);
  });

  it("percentile() never falls below a boundary-exact sample (single implementation)", () => {
    // codex R11: 1.01^555 computes to a value whose own bucket's raw upper bound rounds
    // one ULP below it, so the old separate percentile() scan returned LESS than the true
    // quantile — violating the documented upper-bound promise. percentile() now IS
    // percentileBounds().upper (outward rounding + max clamp in one path).
    const v = 1.01 ** 555;
    const h = new LoadHistogram(0.01);
    h.record(v);
    h.record(v * 1000); // keeps p50's bucket unclamped by the observed max
    expect(h.percentile(50)).toBeGreaterThanOrEqual(v);
    expect(h.percentile(50)).toBe(h.percentileBounds().p50.upper);
  });

  it("percentileBounds() collapses to exact zero when the quantile falls in the zero bucket", () => {
    const h = new LoadHistogram();
    [0, 0, 100].forEach((v) => h.record(v));
    expect(h.percentileBounds().p50).toEqual({ lower: 0, upper: 0 }); // 2 of 3 are zero
  });

  // Serialization: toJSON()/fromJSON() are the worker → coordinator wire form. Round-trips
  // must preserve every observable behavior; malformed payloads must be rejected loudly.

  it("round-trips an empty histogram (and restores the min sentinel)", () => {
    const h = new LoadHistogram();
    expect(h.toJSON()).toEqual({
      v: 1,
      relativeError: 0.01,
      buckets: [],
      zeroCount: 0,
      count: 0,
      sum: 0,
      min: 0,
      max: 0,
    });
    const revived = LoadHistogram.fromJSON(h.toJSON());
    expect(revived.count).toBe(0);
    expect(revived.percentiles()).toEqual({ p50: 0, p90: 0, p95: 0, p99: 0, max: 0 });
    // The internal min sentinel (Infinity, not JSON-representable) must be restored — a
    // revived empty histogram that starts min-tracking from 0 would report min 0 forever.
    revived.record(5);
    expect(revived.min).toBe(5);
  });

  it("round-trips a zero-bucket-only histogram (zeros + clamped negatives)", () => {
    const h = new LoadHistogram();
    [0, 0, -3].forEach((v) => h.record(v)); // -3 clamps into the zero bucket
    const revived = LoadHistogram.fromJSON(h.toJSON());
    expect(revived.toJSON()).toEqual(h.toJSON());
    expect(revived.count).toBe(3);
    expect(revived.min).toBe(0);
    expect(revived.percentile(50)).toBe(0);
  });

  it("round-trips a wide value range with identical observable behavior", () => {
    const h = new LoadHistogram(0.01);
    for (let v = 1; v <= 1000; v++) h.record(v);
    [0.25, 4e9, -50].forEach((v) => h.record(v)); // sub-ms, huge, clamped negative
    // Through an actual JSON string (toJSON is the stringify hook): proves the payload is
    // wire-safe — no Infinity/NaN or non-JSON values survive the encode.
    const revived = LoadHistogram.fromJSON(JSON.parse(JSON.stringify(h)));
    expect(revived.toJSON()).toEqual(h.toJSON()); // bucket-for-bucket identical
    expect(revived.count).toBe(h.count);
    expect(revived.sum).toBe(h.sum);
    expect(revived.min).toBe(h.min);
    expect(revived.max).toBe(h.max);
    expect(revived.mean).toBe(h.mean);
    expect(revived.bucketCount).toBe(h.bucketCount);
    expect(revived.percentiles()).toEqual(h.percentiles());
    expect(revived.percentileBounds()).toEqual(h.percentileBounds());
    expect(revived.distribution([10, 100, 1000])).toEqual(h.distribution([10, 100, 1000]));
  });

  it("round-trips the smallest supported relativeError (1e-9)", () => {
    // codex R3/R4/R7: the MIN_RELATIVE_ERROR floor prunes the old sub-floor corners
    // (indices past 2^53, base collapsing toward 1) — at 1e-9 encoder bucket indices stay
    // within ±~7.5e11 (safe integers) and the log/exp rounding (~1.3e-12) sits three
    // orders of magnitude below the configured error, so the relative-error contract and
    // the round-trip identity hold across the entire supported domain edge.
    const h = new LoadHistogram(1e-9);
    [8103.1, 1e9, 3.7e12, 2e15].forEach((v) => h.record(v));
    const revived = LoadHistogram.fromJSON(JSON.parse(JSON.stringify(h)));
    expect(revived.toJSON()).toEqual(h.toJSON());
    expect(revived.percentiles()).toEqual(h.percentiles());
    expect(revived.percentileBounds()).toEqual(h.percentileBounds());
  });

  it("round-trips a saturated (overflowed) sum via the explicit Infinity sentinel", () => {
    // Two finite MAX_VALUE observations legitimately saturate the float sum to +Infinity,
    // which raw JSON cannot carry (JSON.stringify would silently emit null).
    const h = new LoadHistogram();
    h.record(Number.MAX_VALUE);
    h.record(Number.MAX_VALUE);
    expect(h.sum).toBe(Number.POSITIVE_INFINITY);
    const json = JSON.parse(JSON.stringify(h));
    expect(json.sum).toBe("Infinity"); // explicit sentinel, not a silent null
    const revived = LoadHistogram.fromJSON(json);
    expect(revived.sum).toBe(Number.POSITIVE_INFINITY);
    expect(revived.mean).toBe(Number.POSITIVE_INFINITY); // mean stays saturated, not a fabricated finite value
    expect(revived.max).toBe(Number.MAX_VALUE);
    expect(revived.count).toBe(2);
    expect(revived.toJSON()).toEqual(h.toJSON());
    expect(revived.percentiles()).toEqual(h.percentiles());
  });

  it("round-trips a finite sum at the float ceiling (two MAX_VALUE/2 samples)", () => {
    // codex R9: with base ≈ 2 the per-bucket term cnt × bucketBound(idx−1) of sumLower
    // crossed the float ceiling even though the true sum — exactly MAX_VALUE — is finite
    // and legal, so a genuine worker payload rejected itself. sumLower now accumulates
    // saturating at MAX_VALUE: any finite sum is ≤ MAX_VALUE, so the capped lower bound
    // stays conservative.
    const h = new LoadHistogram(0.9999999999999999);
    h.record(Number.MAX_VALUE / 2);
    h.record(Number.MAX_VALUE / 2);
    expect(h.sum).toBe(Number.MAX_VALUE); // finite: exactly at the ceiling
    const revived = LoadHistogram.fromJSON(JSON.parse(JSON.stringify(h)));
    expect(revived.toJSON()).toEqual(h.toJSON());
    expect(revived.percentiles()).toEqual(h.percentiles());
  });

  it("round-trips a saturated sum whose top bucket is the highest reachable index", () => {
    // codex R6/R7: at relativeError 0.9999999999999999 — the in-domain trigger — the
    // COMPUTED bound of the top reachable bucket rounds below MAX_VALUE (deficit ~4e294),
    // so the per-sample sum cap left sumUpper finite and a legitimately saturated
    // histogram rejected its own payload. The idxMax bucket caps at MAX_VALUE — its true
    // reachable upper bound, since idxMax is idxOf(MAX_VALUE) by construction. (The
    // sub-floor relativeErrors that also hit this are pruned by MIN_RELATIVE_ERROR.)
    const h = new LoadHistogram(0.9999999999999999);
    h.record(Number.MAX_VALUE);
    h.record(1e293); // saturates the float sum from a bucket below the top one
    expect(h.sum).toBe(Number.POSITIVE_INFINITY);
    const revived = LoadHistogram.fromJSON(JSON.parse(JSON.stringify(h)));
    expect(revived.toJSON()).toEqual(h.toJSON());
    expect(revived.percentiles()).toEqual(h.percentiles());
  });

  it("merge() refuses to push count past MAX_SAFE_INTEGER, before any mutation", () => {
    // codex R13, per R6's alternative option: merging two histograms of MAX_SAFE_INTEGER
    // samples would leave the exact-integer count domain — physically unreachable for a
    // real run — so merge() throws instead, and it checks BEFORE touching any state: a
    // failed merge must not leave `this` half-merged.
    const big = (count: number) =>
      LoadHistogram.fromJSON({
        v: 1,
        relativeError: 0.01,
        buckets: [[0, count]] as [number, number][],
        zeroCount: 0,
        count,
        sum: count,
        min: 1,
        max: 1,
      });
    const one = () => {
      const h = new LoadHistogram(0.01);
      h.record(5);
      return h;
    };
    const a = big(Number.MAX_SAFE_INTEGER);
    const before = a.toJSON();
    expect(() => a.merge(one())).toThrow(/exceeds MAX_SAFE_INTEGER/);
    expect(a.toJSON()).toEqual(before); // no half-merged state
    // The old R6 payload — double MAX_SAFE_INTEGER — refuses too.
    expect(() => big(Number.MAX_SAFE_INTEGER).merge(big(Number.MAX_SAFE_INTEGER))).toThrow(
      /exceeds MAX_SAFE_INTEGER/,
    );
    // The bound itself is reachable: a merge landing exactly ON it succeeds.
    const almost = big(Number.MAX_SAFE_INTEGER - 1);
    almost.merge(one());
    expect(almost.count).toBe(Number.MAX_SAFE_INTEGER);
    expect(almost.toJSON().count).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("fromJSON rejects counts past MAX_SAFE_INTEGER (closed count domain)", () => {
    // codex R6→R13: the super-2^53 count domain took four consecutive rounds of machinery
    // to keep self-consistent (summation orders, stale toJSON counts, a stalled runtime
    // += 1, Infinity overflow through merge), and its only live producer is a forged
    // payload — the encoder itself refuses at the bound (record()/merge() throw). The
    // domain is closed: counts are SAFE integers, and 2^53 already is not one.
    const good = () => {
      const h = new LoadHistogram(0.01);
      [5, 60, 250].forEach((v) => h.record(v));
      return h.toJSON();
    };
    expect(() => LoadHistogram.fromJSON({ ...good(), count: 2 ** 53 })).toThrow(
      /count must be a non-negative safe integer/,
    );
    expect(() => LoadHistogram.fromJSON({ ...good(), zeroCount: 2 ** 53 })).toThrow(
      /zeroCount must be a non-negative safe integer/,
    );
    // codex R13: integer-valued but absurd magnitudes — previously admitted, then
    // overflowed straight to Infinity/NaN through merge sums.
    expect(() => LoadHistogram.fromJSON({ ...good(), count: 1e300 })).toThrow(/safe integer/);
    expect(() => LoadHistogram.fromJSON({ ...good(), count: Number.MAX_VALUE })).toThrow(
      /safe integer/,
    );
    // Bucket counts share the closed domain.
    const forged = {
      v: 1,
      relativeError: 0.01,
      buckets: [[0, 2 ** 53]] as [number, number][],
      zeroCount: 0,
      count: 2 ** 53,
      sum: 2 ** 53,
      min: 1,
      max: 1,
    };
    expect(() => LoadHistogram.fromJSON(forged)).toThrow(
      /bucket count must be a positive safe integer/,
    );
  });

  it("record() fails loudly at MAX_SAFE_INTEGER samples instead of silently stalling", () => {
    // codex R13: a revived histogram at the bound must not keep record()ing on a stalled
    // `_count += 1` (the runtime count would silently go stale against the buckets). The
    // bound is physically unreachable for a real run (2^53 samples at 1M rps ≈ 285
    // years), so reaching it is a loud error by the count domain contract.
    const h = LoadHistogram.fromJSON({
      v: 1,
      relativeError: 0.01,
      buckets: [[0, Number.MAX_SAFE_INTEGER]] as [number, number][],
      zeroCount: 0,
      count: Number.MAX_SAFE_INTEGER,
      sum: Number.MAX_SAFE_INTEGER,
      min: 1,
      max: 1,
    });
    expect(() => h.record(5)).toThrow(/cannot record more than/);
    // …and the refused record left the histogram untouched: it still round-trips.
    expect(() => LoadHistogram.fromJSON(h.toJSON())).not.toThrow();
    expect(h.count).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("merging a revived histogram ≡ merging the original, bucket for bucket", () => {
    const makeA = () => {
      const a = new LoadHistogram(0.01);
      for (let v = 1; v <= 500; v++) a.record(v);
      return a;
    };
    const b = new LoadHistogram(0.01);
    for (let v = 300; v <= 1200; v++) b.record(v); // overlaps A's buckets
    b.record(0);
    const direct = makeA();
    direct.merge(b);
    const viaWire = makeA();
    viaWire.merge(LoadHistogram.fromJSON(b.toJSON()));
    // toJSON carries the sorted sparse buckets → deep equality IS the per-bucket assertion.
    expect(viaWire.toJSON()).toEqual(direct.toJSON());
    expect(viaWire.percentiles()).toEqual(direct.percentiles());
    // Merging INTO a revived instance is equivalent too.
    const revivedA = LoadHistogram.fromJSON(makeA().toJSON());
    revivedA.merge(b);
    expect(revivedA.toJSON()).toEqual(direct.toJSON());
  });

  it("rejects merging a revived histogram with a different relativeError", () => {
    const a = new LoadHistogram(0.01);
    const b = LoadHistogram.fromJSON(new LoadHistogram(0.02).toJSON());
    expect(() => a.merge(b)).toThrow(/relativeError/);
  });

  it("fromJSON rejects non-object and unknown-version payloads", () => {
    expect(() => LoadHistogram.fromJSON(null)).toThrow(/payload must be an object, got null/);
    expect(() => LoadHistogram.fromJSON("{}")).toThrow(/payload must be an object, got string/);
    expect(() => LoadHistogram.fromJSON([])).toThrow(/payload must be an object, got an array/);
    const good = new LoadHistogram().toJSON();
    expect(() => LoadHistogram.fromJSON({ ...good, v: 2 })).toThrow(
      /unsupported payload version 2/,
    );
    const { v: _v, ...missingVersion } = good;
    expect(() => LoadHistogram.fromJSON(missingVersion)).toThrow(/unsupported payload version/);
  });

  it("fromJSON rejects malformed fields, naming the field", () => {
    const good = () => {
      const h = new LoadHistogram(0.01);
      [5, 60, 250].forEach((v) => h.record(v));
      return h.toJSON();
    };
    expect(() => LoadHistogram.fromJSON({ ...good(), relativeError: 0 })).toThrow(
      /relativeError must be a number in \[1e-9, 1\)/,
    );
    expect(() => LoadHistogram.fromJSON({ ...good(), relativeError: 2e-16 })).toThrow(
      /relativeError/, // below the supported floor — same domain as the constructor
    );
    expect(() => LoadHistogram.fromJSON({ ...good(), relativeError: "0.01" })).toThrow(
      /relativeError/,
    );
    expect(() => LoadHistogram.fromJSON({ ...good(), count: -1 })).toThrow(/count/);
    expect(() => LoadHistogram.fromJSON({ ...good(), zeroCount: 0.5 })).toThrow(/zeroCount/);
    expect(() => LoadHistogram.fromJSON({ ...good(), sum: Number.POSITIVE_INFINITY })).toThrow(
      /sum/,
    );
    expect(() => LoadHistogram.fromJSON({ ...good(), buckets: {} })).toThrow(
      /buckets must be an array/,
    );
    expect(() => LoadHistogram.fromJSON({ ...good(), buckets: [[1]] })).toThrow(
      /\[bucketIndex, count\] pairs/,
    );
    expect(() => LoadHistogram.fromJSON({ ...good(), buckets: [[1.5, 3]] })).toThrow(
      /bucket index must be an integer/,
    );
    expect(() => LoadHistogram.fromJSON({ ...good(), buckets: [[1, 0]] })).toThrow(
      /bucket count must be a positive safe integer/,
    );
    const unsorted = good();
    expect(unsorted.buckets.length).toBeGreaterThan(1);
    expect(() =>
      LoadHistogram.fromJSON({ ...unsorted, buckets: [...unsorted.buckets].reverse() }),
    ).toThrow(/strictly ascending/);
    const duplicated = good();
    expect(() =>
      LoadHistogram.fromJSON({
        ...duplicated,
        buckets: [duplicated.buckets[0], ...duplicated.buckets],
      }),
    ).toThrow(/strictly ascending/);
  });

  it("fromJSON rejects internally inconsistent payloads (wire-validation foundation)", () => {
    const h = new LoadHistogram(0.01);
    [5, 60, 250].forEach((v) => h.record(v));
    const good = h.toJSON();
    expect(() => LoadHistogram.fromJSON({ ...good, count: good.count + 1 })).toThrow(
      /count 4 does not equal zeroCount 0 \+ bucket counts 3/,
    );
    expect(() => LoadHistogram.fromJSON({ ...good, min: good.max + 1 })).toThrow(
      /min 251 exceeds max 250/,
    );
    expect(() => LoadHistogram.fromJSON({ ...new LoadHistogram().toJSON(), max: 5 })).toThrow(
      /empty histogram/,
    );
  });

  it("fromJSON rejects extremes inconsistent with the bucket state", () => {
    const good = () => {
      const h = new LoadHistogram(0.01);
      [5, 60, 250].forEach((v) => h.record(v));
      return h.toJSON();
    };
    // Positive bucket counts but zeroed extremes: min > max is false, yet the revived
    // instance would report zero percentiles over positive samples and percentileBounds()
    // would return lower > upper — must be rejected, not revived.
    expect(() => LoadHistogram.fromJSON({ ...good(), min: 0, max: 0 })).toThrow(
      /max 0 is outside the highest non-empty bucket/,
    );
    // max must land inside the highest non-empty bucket's (lower, upper] boundaries.
    expect(() => LoadHistogram.fromJSON({ ...good(), max: 100 })).toThrow(/highest non-empty/);
    expect(() => LoadHistogram.fromJSON({ ...good(), max: 500 })).toThrow(/highest non-empty/);
    // Without zeros, min must land inside the lowest non-empty bucket.
    expect(() => LoadHistogram.fromJSON({ ...good(), min: 0.5 })).toThrow(/lowest non-empty/);
    expect(() => LoadHistogram.fromJSON({ ...good(), min: 0 })).toThrow(/lowest non-empty/);
    // A populated zero bucket pins min to exactly 0.
    const withZero = new LoadHistogram(0.01);
    [0, 5].forEach((v) => withZero.record(v));
    expect(() => LoadHistogram.fromJSON({ ...withZero.toJSON(), min: 5 })).toThrow(
      /min must be 0 when zeroCount > 0/,
    );
    // A zeros-only histogram (zeroCount === count, no buckets) must carry all-zero extremes.
    const zerosOnly = new LoadHistogram(0.01);
    [0, 0].forEach((v) => zerosOnly.record(v));
    expect(() => LoadHistogram.fromJSON({ ...zerosOnly.toJSON(), max: 3 })).toThrow(/zeros-only/);
    // The untampered payloads still revive fine (the checks are exact-or-toleranced).
    expect(() => LoadHistogram.fromJSON(good())).not.toThrow();
    expect(() => LoadHistogram.fromJSON(withZero.toJSON())).not.toThrow();
    expect(() => LoadHistogram.fromJSON(zerosOnly.toJSON())).not.toThrow();
  });

  it("fromJSON rejects a malformed or impossible saturated-sum sentinel", () => {
    const good = () => {
      const h = new LoadHistogram(0.01);
      [5, 60, 250].forEach((v) => h.record(v));
      return h.toJSON();
    };
    // Only the exact "Infinity" sentinel string is accepted for a non-finite sum.
    expect(() => LoadHistogram.fromJSON({ ...good(), sum: "banana" })).toThrow(/sum/);
    expect(() => LoadHistogram.fromJSON({ ...good(), sum: "-Infinity" })).toThrow(/sum/);
    // A saturated sum grafted onto buckets that cannot add up to the float ceiling is a lie.
    expect(() => LoadHistogram.fromJSON({ ...good(), sum: "Infinity" })).toThrow(
      /outside the feasible range/,
    );
    // codex R2: a SINGLE sample can never saturate — its sum IS the sample, capped at
    // MAX_VALUE — even when it sits in the top bucket whose nominal upper bound overflows.
    const single = new LoadHistogram();
    single.record(Number.MAX_VALUE);
    expect(() => LoadHistogram.fromJSON({ ...single.toJSON(), sum: "Infinity" })).toThrow(
      /outside the feasible range/,
    );
  });

  it("fromJSON rejects a sum outside the range the bucket contents can produce", () => {
    // codex R2: sum had only type/range checks, so a payload could fabricate mean — each
    // of bucket i's count_i samples lies in (base^(i−1), base^i], which bounds the sum.
    const attack = {
      v: 1,
      relativeError: 0.01,
      buckets: [[0, 1]] as [number, number][], // one sample in (base^-1 ≈ 0.9901, 1]
      zeroCount: 0,
      count: 1,
      sum: 0, // infeasible: the revived mean would be 0 over a positive sample
      min: 1,
      max: 1,
    };
    expect(() => LoadHistogram.fromJSON(attack)).toThrow(/outside the feasible range/);
    // The same payload with a feasible sum revives fine.
    expect(() => LoadHistogram.fromJSON({ ...attack, sum: 1 })).not.toThrow();
    const good = () => {
      const h = new LoadHistogram(0.01);
      [5, 60, 250].forEach((v) => h.record(v));
      return h.toJSON(); // true sum 315; feasible range ≈ (312.4, 315.6]
    };
    expect(() => LoadHistogram.fromJSON({ ...good(), sum: 100 })).toThrow(
      /outside the feasible range/, // below Σ count_i × base^(i−1)
    );
    expect(() => LoadHistogram.fromJSON({ ...good(), sum: 1000 })).toThrow(
      /outside the feasible range/, // above Σ count_i × base^i
    );
    expect(() => LoadHistogram.fromJSON(good())).not.toThrow();
  });

  it("fromJSON checks extremes in index space (no value slack at the relativeError floor)", () => {
    // codex R8: at relativeError 1e-9 the old value-space slack (~1e-9) was comparable to
    // the bucket width itself, so a forged extreme one bucket over slipped through and
    // could fabricate percentiles. The check now re-derives idxOf(max)/idxOf(min) with
    // the encoder's own ceil(log/logBase) — identical doubles through the identical
    // formula are bit-for-bit reproducible, so exact equality needs no tolerance.
    const v = 1.0000000005; // record() puts this in bucket 1 at relativeError 1e-9 …
    const forged = {
      v: 1,
      relativeError: 1e-9,
      buckets: [[0, 1]] as [number, number][], // … so claiming bucket 0 is a lie
      zeroCount: 0,
      count: 1,
      sum: v,
      min: v,
      max: v,
    };
    expect(() => LoadHistogram.fromJSON(forged)).toThrow(/highest non-empty bucket/);
    // Positive control: the same value actually recorded round-trips exactly.
    const h = new LoadHistogram(1e-9);
    h.record(v);
    expect(h.toJSON().buckets).toEqual([[1, 1]]);
    const revived = LoadHistogram.fromJSON(JSON.parse(JSON.stringify(h)));
    expect(revived.toJSON()).toEqual(h.toJSON());
    expect(revived.percentiles()).toEqual(h.percentiles());
  });

  it("fromJSON rejects a sum outside the exact-extremes envelope", () => {
    // codex R4: min/max are exact aggregates — all count samples lie in [min, max] with at
    // least one sample at each end — so max + (count−1)·min ≤ sum ≤ min + (count−1)·max.
    // This payload passes the coarser bucket-range check (bucket 1 of re=0.01 spans
    // (1, 1.01], so sum 1.01 is bucket-feasible) yet its mean 1.01 exceeds its own max.
    const attack = {
      v: 1,
      relativeError: 0.01,
      buckets: [[1, 1]] as [number, number][],
      zeroCount: 0,
      count: 1,
      sum: 1.01,
      min: 1.005,
      max: 1.005,
    };
    expect(() => LoadHistogram.fromJSON(attack)).toThrow(/exact-extremes envelope/);
    // count === 1 forces sum === min === max.
    expect(() => LoadHistogram.fromJSON({ ...attack, sum: 1.005 })).not.toThrow();
    // count === 2 pins sum to ~(min + max) from BOTH sides; the bucket range (2, 2.02]
    // alone would accept all three sums below.
    const two = {
      v: 1,
      relativeError: 0.01,
      buckets: [[1, 2]] as [number, number][],
      zeroCount: 0,
      count: 2,
      sum: 2.01,
      min: 1.002,
      max: 1.008,
    };
    expect(() => LoadHistogram.fromJSON(two)).not.toThrow();
    expect(() => LoadHistogram.fromJSON({ ...two, sum: 2.015 })).toThrow(
      /exact-extremes envelope/, // above min + (count−1)·max
    );
    expect(() => LoadHistogram.fromJSON({ ...two, sum: 2.005 })).toThrow(
      /exact-extremes envelope/, // below max + (count−1)·min
    );
  });

  it("fromJSON keeps the sum lower-bound checks effective at huge counts (capped slack)", () => {
    // codex R5: the count-scaled sum tolerance (count × ε) exceeds 1 near count ~2^52,
    // turning `1 − slack` negative and switching BOTH sum lower-bound checks off — a
    // forged sum 0 over ~9e15 positive samples would revive with mean 0 and poison
    // merges. The slack is capped (MAX_SUM_SLACK) so the checks never go vacuous.
    const attack = {
      v: 1,
      relativeError: 0.01,
      buckets: [[0, Number.MAX_SAFE_INTEGER]] as [number, number][], // bucket (base^-1, 1]
      zeroCount: 0,
      count: Number.MAX_SAFE_INTEGER,
      sum: 0,
      min: 1,
      max: 1,
    };
    expect(() => LoadHistogram.fromJSON(attack)).toThrow(/outside the feasible range/);
    // Positive control: the same enormous count (2^53 − 1 samples, all exactly 1) with a
    // self-consistent sum still passes under the capped slack.
    const consistent = { ...attack, sum: Number.MAX_SAFE_INTEGER };
    const revived = LoadHistogram.fromJSON(consistent);
    expect(revived.count).toBe(Number.MAX_SAFE_INTEGER);
    expect(revived.mean).toBe(1);
  });

  it("fromJSON rejects bucket indices outside the encoder-reachable range", () => {
    // codex R2: for an extreme negative index both base^(idx−1) and base^idx underflow to
    // 0, the extremes checks "pass" on the 0 boundary, and the revived histogram reports
    // zero percentiles for a positive sample. record() can never produce such an index:
    // ceil(log(v) / logBase) over v ∈ [MIN_VALUE, MAX_VALUE] stays inside the range.
    const attack = {
      v: 1,
      relativeError: 0.01,
      buckets: [[-Number.MAX_SAFE_INTEGER, 1]] as [number, number][],
      zeroCount: 0,
      count: 1,
      sum: 0,
      min: 0,
      max: 0,
    };
    expect(() => LoadHistogram.fromJSON(attack)).toThrow(/outside the encoder-reachable range/);
    expect(() =>
      LoadHistogram.fromJSON({ ...attack, buckets: [[Number.MAX_SAFE_INTEGER, 1]] }),
    ).toThrow(/outside the encoder-reachable range/);
    // The true extremes of the encoder's own range still round-trip.
    const tiny = new LoadHistogram();
    tiny.record(Number.MIN_VALUE); // the smallest positive double → lowest reachable index
    expect(LoadHistogram.fromJSON(tiny.toJSON()).toJSON()).toEqual(tiny.toJSON());
    const huge = new LoadHistogram();
    huge.record(Number.MAX_VALUE); // the largest finite double → highest reachable index
    expect(LoadHistogram.fromJSON(huge.toJSON()).toJSON()).toEqual(huge.toJSON());
  });
});
