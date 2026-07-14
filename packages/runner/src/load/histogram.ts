/**
 * Bounded streaming latency histogram for the load reducer.
 *
 * Load mode must NOT keep full sample arrays (the ordinary threshold
 * MetricCollector sorts every value — fine for a handful of tests, fatal at
 * hundreds of concurrent producers). This is a relative-error log-bucket
 * histogram: memory is bounded by the LOG of the value range (a few hundred to
 * ~2k buckets for realistic latencies), percentiles are within `relativeError`
 * of the true value, and two histograms with the same error are mergeable
 * (for future external-engine partial-aggregate ingestion).
 */
import type { Percentiles } from "@glubean/sdk/load";

const DEFAULT_RELATIVE_ERROR = 0.01;

/** Lower bound for relativeError. Machine rounding in the log/exp bucket math contributes
 *  up to ~8ε·|ln v| ≈ 1.3e-12 relative error across the full double range (|ln v| ≤ ~745),
 *  so a configured error below that scale cannot be honoured — the documented
 *  relative-error contract would be dominated by float noise (and far below it,
 *  1 + relativeError collapses to exactly 1: a latent divide-by-zero in record()). 1e-9
 *  keeps the configured error at least three orders of magnitude above the rounding
 *  floor; the default is 0.01, and 1e-9 is already absurd precision for a latency
 *  histogram, so no real use case is excluded. */
const MIN_RELATIVE_ERROR = 1e-9;

/** Base tolerance for the sum-feasibility checks in `fromJSON`. The log-space bucket
 *  boundaries entering sumLower/sumUpper are COMPUTED values carrying up to
 *  ~8ε·|ln v| ≈ 1.3e-12 relative encoding error (they are derived, not recorded), so the
 *  base slack must sit above that scale; 1e-9 matches the MIN_RELATIVE_ERROR floor. (The
 *  extremes checks need no tolerance at all — they compare encoder-formula bucket
 *  INDICES, which are bit-for-bit reproducible on identical doubles.) */
const SUM_BASE_SLACK = 1e-9;

/** Bucket boundary base^exponent computed in LOG SPACE — exp(exponent × logBase) — the
 *  ONE formula shared by `percentile`/bounds, `distribution`, and `fromJSON` validation
 *  (the encoder's `ceil(log(v) / logBase)` is its inverse). Direct `base ** exponent`
 *  degrades once relativeError approaches machine precision: bucket indices reach ~3e18
 *  (base = the smallest double above 1) and pow's evaluation of (1+ε)^idx overflows /
 *  loses the tiny log, inverting bucket bounds. The product exponent × logBase ≈
 *  ln(boundary) stays within ±~745, so exp never overflows mid-computation (the RESULT
 *  may still legitimately round to Infinity / a subnormal at the float ceiling/floor). */
const bucketBound = (exponent: number, logBase: number): number => Math.exp(exponent * logBase);

/** A bucket's true reachable per-sample upper bound. Samples are finite doubles, so no
 *  bucket's contents can exceed MAX_VALUE; and the TOP reachable bucket (idx === idxMax,
 *  which is idxOf(MAX_VALUE) by construction) really holds values up to MAX_VALUE even
 *  though its COMPUTED log-space bound can round below it (deficit ~4e294 at some
 *  relativeErrors — the old `base ** idx` path overflowed to Infinity and the max clamp
 *  saved it; the exp path does not overflow, so it must pin explicitly to stay
 *  conservative, codex R6/R8). `percentile`, `percentileBounds` and `fromJSON`'s sumUpper
 *  all share this one rule. */
const bucketUpperBound = (idx: number, idxMax: number, logBase: number): number =>
  idx === idxMax ? Number.MAX_VALUE : Math.min(bucketBound(idx, logBase), Number.MAX_VALUE);

/** Cap for the count-scaled sum tolerance in `fromJSON`. count × ε models the worst-case
 *  relative error of sequentially float-summing count samples, but left uncapped it
 *  exceeds 1 near count ~2^52, turning `1 − slack` negative and switching the sum
 *  lower-bound checks (bucket feasibility AND the exact-extremes envelope) off — a forged
 *  sum 0 over ~9e15 positive samples would revive with mean 0 and poison merges. A legit
 *  encoder would need to accumulate ~4.5×10^12 samples for the real summation error to
 *  reach this 1e-3 cap — far beyond any realistic run — so larger counts simply validate
 *  against the capped slack and the lower bounds never go vacuous. */
const MAX_SUM_SLACK = 1e-3;

/** One quantile as an interval: the true (nearest-rank) value lies in [lower, upper]. */
export interface QuantileBounds {
  lower: number;
  upper: number;
}

/** {@link Percentiles} as intervals instead of point estimates. Threshold evaluation
 *  compares `<`/`<=` against `upper` and `>`/`>=` against `lower`; an interval that
 *  straddles the threshold is unevaluable rather than a false pass/fail. */
export type PercentileBounds = { [K in keyof Percentiles]: QuantileBounds };

/**
 * Versioned wire form of a {@link LoadHistogram} (a worker serializes its reducer
 * state, the coordinator revives and merges it — merge on the revived instance is
 * exact, so partial aggregation loses nothing).
 *
 * `buckets` encodes the sparse log-bucket map as `[bucketIndex, count]` pairs in
 * strictly ascending index order: indices stay numbers end to end (an object keyed
 * by index would stringify every index and force parse-back), empty buckets are
 * simply absent, and the canonical order makes equal histograms produce
 * byte-identical payloads.
 */
export interface LoadHistogramJSON {
  /** Payload schema version; `fromJSON` rejects anything it does not recognize. */
  v: 1;
  relativeError: number;
  /** Sparse `[bucketIndex, count]` pairs, strictly ascending index, count ≥ 1. */
  buckets: [number, number][];
  zeroCount: number;
  count: number;
  /** Total of the observations. Float addition of finite inputs can legitimately saturate
   *  to +Infinity (e.g. two `Number.MAX_VALUE` observations), which JSON cannot carry — a
   *  saturated sum is encoded as the explicit string sentinel `"Infinity"` and revives as
   *  +Infinity, so `mean` stays saturated (+Infinity) rather than fabricating a finite
   *  value. */
  sum: number | "Infinity";
  /** Observed min; 0 when empty (mirrors the `min` getter — the internal
   *  no-observations sentinel is `Infinity`, which JSON cannot carry). */
  min: number;
  max: number;
}

/**
 * Domain contract for counts: the total, zeroCount and every per-bucket count are exact
 * SAFE integers (≤ Number.MAX_SAFE_INTEGER) at all times — serialization, merge and
 * runtime share one arithmetic. The bound is physically unreachable for a real run
 * (2^53 samples at 1M rps ≈ 285 years), so `record`/`merge` fail loudly at it instead of
 * entering float-integer territory, and `fromJSON` rejects anything beyond it.
 */
export class LoadHistogram {
  private readonly relativeError: number;
  private readonly base: number;
  private readonly logBase: number;
  /** idxOf(MAX_VALUE) — the highest bucket index `record` can produce. */
  private readonly idxMax: number;
  private readonly buckets = new Map<number, number>();
  private zeroCount = 0;
  /** Exact by the domain contract (see class doc): record()/merge() refuse to push it
   *  past MAX_SAFE_INTEGER, so wire, merge and runtime all read the same number. */
  private _count = 0;
  private _sum = 0;
  private _min = Infinity;
  private _max = 0;

  /** @param relativeError bucket width as a fraction in [{@link MIN_RELATIVE_ERROR}, 1); default 1%. */
  constructor(relativeError: number = DEFAULT_RELATIVE_ERROR) {
    if (!(relativeError >= MIN_RELATIVE_ERROR && relativeError < 1)) {
      throw new Error(
        `LoadHistogram relativeError must be in [${MIN_RELATIVE_ERROR}, 1), got ${relativeError}`,
      );
    }
    this.relativeError = relativeError;
    this.base = 1 + relativeError;
    this.logBase = Math.log(this.base);
    this.idxMax = Math.ceil(Math.log(Number.MAX_VALUE) / this.logBase);
  }

  get count(): number {
    return this._count;
  }
  get sum(): number {
    return this._sum;
  }
  get min(): number {
    return this._count === 0 ? 0 : this._min;
  }
  get max(): number {
    return this._max;
  }
  get mean(): number {
    return this._count === 0 ? 0 : this._sum / this._count;
  }
  /** Distinct buckets retained — bounded by the log of the observed value range. */
  get bucketCount(): number {
    return this.buckets.size + (this.zeroCount > 0 ? 1 : 0);
  }

  /** Record one observation (ms). Non-finite values are ignored; negatives clamp to 0. */
  record(value: number): void {
    if (!Number.isFinite(value)) return;
    if (this._count >= Number.MAX_SAFE_INTEGER) {
      // Fail loud rather than silently stall `+= 1` past 2^53: the bound is physically
      // unreachable for a real run (2^53 samples at 1M rps ≈ 285 years), so reaching it
      // means something upstream is broken — see the class doc's count domain contract.
      throw new Error(
        `LoadHistogram cannot record more than ${Number.MAX_SAFE_INTEGER} samples`,
      );
    }
    const v = value < 0 ? 0 : value;
    this._count += 1;
    this._sum += v;
    if (v < this._min) this._min = v;
    if (v > this._max) this._max = v;
    if (v === 0) {
      this.zeroCount += 1;
      return;
    }
    const idx = Math.ceil(Math.log(v) / this.logBase);
    this.buckets.set(idx, (this.buckets.get(idx) ?? 0) + 1);
  }

  /**
   * Percentile `p` in [0, 100] as a point estimate: the interval upper bound from
   * {@link percentileBoundsAt} — guaranteed ≥ the true nearest-rank value and at most
   * `relativeError` plus the machine outward factor (~8ε·|ln v|, see the bounds doc)
   * above it, never above the observed max. Delegating keeps percentile() and
   * percentileBounds().upper a SINGLE implementation (codex R11: a separate scan without
   * the outward factor returned BELOW the true quantile for a sample sitting on a
   * computed bucket boundary, e.g. 1.01^555 — violating this upper-bound promise).
   */
  percentile(p: number): number {
    return this.percentileBoundsAt(p).upper;
  }

  /** The standard {p50, p90, p95, p99, max} shape (max is exact). */
  percentiles(): Percentiles {
    return {
      p50: this.percentile(50),
      p90: this.percentile(90),
      p95: this.percentile(95),
      p99: this.percentile(99),
      max: this._max,
    };
  }

  /**
   * Interval form of {@link percentile}: the hit bucket's lower/upper bounds rounded
   * OUTWARD, so the true nearest-rank quantile lies in [lower, upper] and the interval's
   * relative width stays at the relativeError scale. Outward rounding: `record`'s
   * `ceil(log(v) / logBase)` carries a few-ε relative error on the RATIO, so a sample can
   * sit up to ~ε·|ln v| (relative) past the computed `base ** idx` boundary — a fixed
   * one-ULP expansion is not enough at large |ln v|, hence the expansion scales with
   * |idx · logBase| (≈ |ln v|) with a 4ε floor. Exact positions (no samples → 0,
   * p ≤ 0 → min, p ≥ 100 → max, the zero bucket) stay exact with lower === upper.
   * `percentile()` delegates to this interval's `upper` — one implementation, so the
   * point estimate and the interval can never disagree (codex R11).
   */
  private percentileBoundsAt(p: number): QuantileBounds {
    if (this._count === 0) return { lower: 0, upper: 0 };
    if (p <= 0) return { lower: this.min, upper: this.min };
    if (p >= 100) return { lower: this._max, upper: this._max };
    const target = Math.min(this._count, Math.max(1, Math.ceil((p / 100) * this._count)));
    let cumulative = this.zeroCount;
    if (cumulative >= target) return { lower: 0, upper: 0 };
    const indices = [...this.buckets.keys()].sort((a, b) => a - b);
    for (const idx of indices) {
      cumulative += this.buckets.get(idx) ?? 0;
      if (cumulative >= target) {
        const outward = Math.max(
          4 * Number.EPSILON,
          8 * Number.EPSILON * Math.abs(idx * this.logBase),
        );
        return {
          lower: bucketBound(idx - 1, this.logBase) * (1 - outward),
          upper: Math.min(
            bucketUpperBound(idx, this.idxMax, this.logBase) * (1 + outward),
            this._max,
          ),
        };
      }
    }
    return { lower: this._max, upper: this._max };
  }

  /** {@link percentiles} as quantile intervals (max is exact: lower === upper). */
  percentileBounds(): PercentileBounds {
    return {
      p50: this.percentileBoundsAt(50),
      p90: this.percentileBoundsAt(90),
      p95: this.percentileBoundsAt(95),
      p99: this.percentileBoundsAt(99),
      max: { lower: this._max, upper: this._max },
    };
  }

  /**
   * Bucket the observations against fixed upper-bound `boundaries` (ms, ascending) for a
   * distribution / CDF chart. Each emitted bucket counts observations in (prevBound, leMs];
   * a final overflow bucket (leMs = the observed max) carries anything PAST the last
   * boundary. A FIXED ladder keeps two runs' distributions directly comparable (aligned
   * x-axis). Empty when there are no observations.
   *
   * Placement rule: a sample bucket (lower, upper] goes into the first rung r with
   * lower ≤ r, where lower = bucketBound(idx − 1) — placing by the LOWER edge keeps an
   * exact ladder-edge value (e.g. 1000ms) in its own rung instead of the next rung / a
   * false overflow, since the upper edge over-estimates by up to `relativeError`
   * (codex R1). Evaluated as a two-part predicate over the rung's index
   * rIdx = ceil(log(r) / logBase) (the encoder's own formula):
   *
   *   rIdx ≥ idx       → place (in index space r sits at or above the bucket's edge);
   *   rIdx === idx − 1 → place iff bucketBound(idx−1) ≤ r (the one-bucket sliver where
   *                      the index alone cannot tell, codex R9/R10);
   *   rIdx < idx − 1   → exclude (r ≤ bound(idx−2) < lower).
   *
   * PRECISION CONTRACT (codex R6/R9/R10/R11): the placement RESOLUTION is one bucket —
   * the log-bucket histogram's inherent `relativeError` promise; any CDF deviation from
   * infinite-precision placement is bounded by that. For a rung within float jitter
   * (~ε·|ln r|) of a bucket edge, WHICH side it falls on is adjudicated
   * DETERMINISTICALLY by the encoder index mapping — the same formula record() runs, so
   * the verdict is identical across processes and merges. Both directions of the sliver
   * exist and are intentional: a boundary-exact rung (same index as the sample) places
   * even when the recomputed lower edge rounds a hair above it (R6/R9), and a rung a few
   * ULP BELOW the computed lower edge whose ceil still rounds to the sample's index also
   * places (R11) — floating point cannot honour both infinite-precision sides at once
   * (R6 showed the value comparison failing in the opposite direction), so the
   * deterministic index verdict IS the contract, not an approximation of a sharper one.
   *
   * A run whose max is at/below the last boundary emits no overflow, every observation
   * lands in exactly one rung (counts sum to the total), and the rungs stay monotonic.
   * Values strictly between two boundaries but within one log bucket of a boundary may
   * round down by that bucket.
   */
  distribution(boundaries: number[]): { leMs: number; count: number }[] {
    if (this._count === 0 || boundaries.length === 0) return [];
    const counts = new Array<number>(boundaries.length).fill(0);
    let overflow = 0;
    counts[0] += this.zeroCount; // a zero observation is ≤ the first (positive) boundary
    const rungIdx = boundaries.map((b) => Math.ceil(Math.log(b) / this.logBase));
    for (const [idx, cnt] of this.buckets) {
      let placed = false;
      for (let i = 0; i < boundaries.length; i++) {
        // Two-part lower-edge predicate — see the placement rule above.
        if (
          rungIdx[i] >= idx ||
          (rungIdx[i] === idx - 1 && bucketBound(idx - 1, this.logBase) <= boundaries[i])
        ) {
          counts[i] += cnt;
          placed = true;
          break;
        }
      }
      if (!placed) overflow += cnt;
    }
    const out = boundaries.map((leMs, i) => ({ leMs, count: counts[i] }));
    if (overflow > 0) out.push({ leMs: this._max, count: overflow });
    return out;
  }

  /** Fold another histogram (same relativeError) into this one. */
  merge(other: LoadHistogram): void {
    if (other.base !== this.base) {
      throw new Error("cannot merge LoadHistograms with different relativeError");
    }
    // Checked BEFORE any mutation — a failed merge must not leave `this` half-merged.
    // Past MAX_SAFE_INTEGER, count addition would leave the exact-integer domain (see
    // the class doc); the bound is physically unreachable for real runs (2^53 samples at
    // 1M rps ≈ 285 years), so refuse loudly instead. This one check bounds everything:
    // zeroCount and every per-bucket count are ≤ count on both sides, so their merged
    // values stay ≤ the merged count. (The comparison itself is float-safe: a true sum
    // ≤ MAX_SAFE_INTEGER is exactly representable, and a true sum above it computes to
    // ≥ 2^53 even in the worst rounding case.)
    if (this._count + other._count > Number.MAX_SAFE_INTEGER) {
      throw new Error(
        `cannot merge LoadHistograms: combined count ${this._count} + ${other._count} exceeds MAX_SAFE_INTEGER (physically unreachable for a real run — see the count domain contract)`,
      );
    }
    this.zeroCount += other.zeroCount;
    this._count += other._count; // exact: the guard above keeps the sum a safe integer
    this._sum += other._sum;
    if (other._count > 0) {
      if (other._min < this._min) this._min = other._min;
      if (other._max > this._max) this._max = other._max;
    }
    for (const [idx, c] of other.buckets) {
      this.buckets.set(idx, (this.buckets.get(idx) ?? 0) + c);
    }
  }

  /** Deep copy: an independent histogram with identical state (same relativeError, so it
   *  stays mergeable with the original's family). Threshold evaluation folds per-phase
   *  histograms via `clone()` + `merge()` — the clone guarantees the reducer's live
   *  aggregates are never mutated by an evaluation-time merge. */
  clone(): LoadHistogram {
    const h = new LoadHistogram(this.relativeError);
    for (const [idx, c] of this.buckets) h.buckets.set(idx, c);
    h.zeroCount = this.zeroCount;
    h._count = this._count;
    h._sum = this._sum;
    h._min = this._min;
    h._max = this._max;
    return h;
  }

  /** Serialize to the versioned wire form ({@link LoadHistogramJSON}); also the
   *  `JSON.stringify` hook, so a histogram embedded in a larger payload just works. */
  toJSON(): LoadHistogramJSON {
    return {
      v: 1,
      relativeError: this.relativeError,
      buckets: [...this.buckets.entries()].sort((a, b) => a[0] - b[0]),
      zeroCount: this.zeroCount,
      count: this._count, // exact by the count domain contract (≤ MAX_SAFE_INTEGER)
      sum: Number.isFinite(this._sum) ? this._sum : "Infinity", // saturated-sum sentinel
      min: this.min, // getter: 0 when empty (the Infinity sentinel is not JSON-representable)
      max: this._max,
    };
  }

  /**
   * Revive a histogram from its wire form. Throws (with the offending field) on any
   * malformed, inconsistent, or unknown-version payload — never coerces silently. This is
   * the validation boundary worker partial-aggregate uploads will cross: a bad payload
   * must fail loudly here, not skew merged numbers downstream.
   */
  static fromJSON(json: unknown): LoadHistogram {
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      const got = json === null ? "null" : Array.isArray(json) ? "an array" : typeof json;
      throw new Error(`LoadHistogram.fromJSON: payload must be an object, got ${got}`);
    }
    const p = json as Record<string, unknown>;
    // Version first: an unknown version must fail as such, not as random shape drift.
    if (p.v !== 1) {
      throw new Error(
        `LoadHistogram.fromJSON: unsupported payload version ${JSON.stringify(p.v)} (expected 1)`,
      );
    }
    const relativeError = p.relativeError;
    if (
      typeof relativeError !== "number" ||
      !(relativeError >= MIN_RELATIVE_ERROR && relativeError < 1)
    ) {
      throw new Error(
        `LoadHistogram.fromJSON: relativeError must be a number in [${MIN_RELATIVE_ERROR}, 1), got ${JSON.stringify(relativeError)}`,
      );
    }
    if (!Array.isArray(p.buckets)) {
      throw new Error(
        `LoadHistogram.fromJSON: buckets must be an array of [bucketIndex, count] pairs, got ${JSON.stringify(p.buckets)}`,
      );
    }
    const logBase = Math.log(1 + relativeError);
    // The encoder-reachable bucket index range — an invariant `record` always holds: it
    // computes ceil(log(v) / logBase), which is (weakly) monotone in v, and only ever sees
    // positive finite doubles, v ∈ [Number.MIN_VALUE, Number.MAX_VALUE] (non-finite inputs
    // are ignored, zero/negatives go to the zero bucket). Computed with the exact same
    // formula here, so no tolerance is needed. Outside this range the bucket boundaries
    // degenerate (base^idx underflows to 0 / base^(idx−1) overflows past every finite
    // double) and the extremes checks below would compare against meaningless 0/Infinity
    // boundaries — reject such indices outright.
    const idxMin = Math.ceil(Math.log(Number.MIN_VALUE) / logBase);
    const idxMax = Math.ceil(Math.log(Number.MAX_VALUE) / logBase);
    const bucketEntries: [number, number][] = [];
    let bucketTotal = 0;
    let sumLower = 0; // Σ count_i × base^(i−1): every bucket-i sample exceeds base^(i−1)
    let sumUpper = 0; // Σ count_i × min(base^i, MAX_VALUE): samples are finite doubles
    let prevIdx = Number.NEGATIVE_INFINITY;
    for (const entry of p.buckets) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        throw new Error(
          `LoadHistogram.fromJSON: buckets entries must be [bucketIndex, count] pairs, got ${JSON.stringify(entry)}`,
        );
      }
      const idx: unknown = entry[0];
      const cnt: unknown = entry[1];
      // Integer-valued double: with the MIN_RELATIVE_ERROR floor, encoder indices stay
      // within ±~7.5e11 (idx(MIN_VALUE)..idx(MAX_VALUE) at relativeError 1e-9), so the
      // [idxMin, idxMax] range check right below pins the magnitude and integer-valued
      // is the only structural requirement here.
      if (typeof idx !== "number" || !Number.isInteger(idx)) {
        throw new Error(
          `LoadHistogram.fromJSON: bucket index must be an integer, got ${JSON.stringify(idx)}`,
        );
      }
      if (idx < idxMin || idx > idxMax) {
        throw new Error(
          `LoadHistogram.fromJSON: bucket index ${idx} is outside the encoder-reachable range [${idxMin}, ${idxMax}]`,
        );
      }
      // GUARDRAIL for future review rounds — counts are SAFE integers, full stop. We once
      // walked the "accept counts past 2^53" route (codex R6→R13, four consecutive rounds
      // of patches: non-associative summation orders, stale toJSON counts, a silently
      // stalled runtime `+= 1`, Infinity overflow through merge). That proved the
      // super-2^53 domain can only be kept self-consistent with ever more machinery,
      // while its only live producer is a forged payload — the encoder itself refuses at
      // the bound (record()/merge() throw; 2^53 samples ≈ 285 years at 1M rps). So the
      // domain is CLOSED here, per R6's alternative option. Do not reopen it.
      if (typeof cnt !== "number" || !Number.isSafeInteger(cnt) || cnt < 1) {
        throw new Error(
          `LoadHistogram.fromJSON: bucket count must be a positive safe integer (≤ ${Number.MAX_SAFE_INTEGER} — the encoder never produces more; larger counts are physically unreachable), got ${JSON.stringify(cnt)}`,
        );
      }
      if (idx <= prevIdx) {
        throw new Error(
          `LoadHistogram.fromJSON: bucket indices must be strictly ascending (canonical form), got ${idx} after ${prevIdx}`,
        );
      }
      prevIdx = idx;
      bucketTotal += cnt;
      // Saturating accumulation, capped at MAX_VALUE: near the float ceiling the
      // per-bucket term cnt × bucketBound(idx−1) can overflow even though the true sum is
      // finite and legal (codex R9: two MAX_VALUE/2 samples — real sum exactly MAX_VALUE —
      // pushed sumLower to Infinity and the payload rejected itself). Capping stays
      // conservative: any FINITE sum is ≤ MAX_VALUE, so a lower bound capped there only
      // loosens the check at the very ceiling — a payload whose true lower bound exceeds
      // MAX_VALUE either carries the saturated "Infinity" sentinel (where the lower check
      // is vacuous anyway) or, like this one, sits within the bucket width of the ceiling
      // and is legitimate. Forged finite sums over saturating buckets are still caught by
      // the exact-extremes envelope below. sumUpper is already capped per sample — the
      // two sides are symmetric.
      sumLower = Math.min(
        sumLower + Math.min(cnt * bucketBound(idx - 1, logBase), Number.MAX_VALUE),
        Number.MAX_VALUE,
      );
      // Per-sample cap via bucketUpperBound: the top reachable bucket pins to MAX_VALUE
      // (see the helper — otherwise a legitimately saturated payload would see a finite
      // sumUpper and reject itself).
      sumUpper += cnt * bucketUpperBound(idx, idxMax, logBase);
      bucketEntries.push([idx, cnt]);
    }
    // Count fields are non-negative SAFE integers — the same closed domain as the bucket
    // counts above (see the guardrail comment there; the encoder never produces more).
    const numField = (field: "zeroCount" | "count" | "min" | "max", integer: boolean) => {
      const value = p[field];
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        (integer && !Number.isSafeInteger(value))
      ) {
        throw new Error(
          `LoadHistogram.fromJSON: ${field} must be a non-negative ${integer ? "safe integer" : "finite number"}, got ${JSON.stringify(value)}`,
        );
      }
      return value;
    };
    const zeroCount = numField("zeroCount", true);
    const count = numField("count", true);
    const min = numField("min", false);
    const max = numField("max", false);
    // sum is the one aggregate that can legitimately saturate to +Infinity (float addition
    // of finite inputs); the wire form carries that as an explicit "Infinity" sentinel. A
    // raw non-finite NUMBER is still rejected — real JSON text cannot produce one, so it
    // only appears in a payload that never went through the canonical encoder.
    const rawSum = p.sum;
    let sum: number;
    if (rawSum === "Infinity") {
      sum = Infinity;
    } else if (typeof rawSum === "number" && Number.isFinite(rawSum) && rawSum >= 0) {
      sum = rawSum;
    } else {
      throw new Error(
        `LoadHistogram.fromJSON: sum must be a non-negative finite number or "Infinity", got ${JSON.stringify(rawSum)}`,
      );
    }
    // Cross-field consistency — invariants the encoder always holds: exact where the
    // arithmetic is exact (integer counts, a zero observation pinning min/sum, index
    // re-derivation for the extremes), float-summation tolerance only where SUMS are
    // compared. A payload that lies about its extremes would revive into an instance
    // whose percentile scan (clamped to max) and percentileBounds (lower > upper)
    // contradict its own buckets.
    if (zeroCount + bucketTotal !== count) {
      throw new Error(
        `LoadHistogram.fromJSON: count ${count} does not equal zeroCount ${zeroCount} + bucket counts ${bucketTotal}`,
      );
    }
    if (count === 0 && (sum !== 0 || min !== 0 || max !== 0)) {
      throw new Error(
        `LoadHistogram.fromJSON: an empty histogram (count 0) must have zero sum/min/max, got sum ${sum} min ${min} max ${max}`,
      );
    }
    if (count > 0 && min > max) {
      throw new Error(`LoadHistogram.fromJSON: min ${min} exceeds max ${max}`);
    }
    if (count > 0 && bucketEntries.length === 0 && (sum !== 0 || min !== 0 || max !== 0)) {
      // zeroCount === count (forced by the count identity above): every observation was 0.
      throw new Error(
        `LoadHistogram.fromJSON: a zeros-only histogram (zeroCount === count) must have zero sum/min/max, got sum ${sum} min ${min} max ${max}`,
      );
    }
    if (bucketEntries.length > 0) {
      // Extremes vs bucket contents in INDEX space — the same principle as
      // distribution()'s rung placement: max is an actual recorded sample, so re-deriving
      // its bucket with the encoder's own ceil(log/logBase) must land EXACTLY on the
      // highest non-empty bucket (identical doubles through the identical formula are
      // bit-for-bit reproducible, the same determinism the index-collapse and rung logic
      // already rely on). No value-space tolerance: at the MIN_RELATIVE_ERROR floor a
      // value slack is comparable to the bucket width itself and would let a forged
      // extreme slip one bucket over, fabricating percentiles (codex R8).
      const idxHi = bucketEntries[bucketEntries.length - 1][0];
      if (Math.ceil(Math.log(max) / logBase) !== idxHi) {
        throw new Error(
          `LoadHistogram.fromJSON: max ${max} is outside the highest non-empty bucket ${idxHi}`,
        );
      }
      if (zeroCount > 0) {
        // A zero observation sets min to exactly 0.
        if (min !== 0) {
          throw new Error(`LoadHistogram.fromJSON: min must be 0 when zeroCount > 0, got ${min}`);
        }
      } else {
        // No zeros: the smallest observation lands in the lowest non-empty bucket.
        const idxLo = bucketEntries[0][0];
        if (Math.ceil(Math.log(min) / logBase) !== idxLo) {
          throw new Error(
            `LoadHistogram.fromJSON: min ${min} is outside the lowest non-empty bucket ${idxLo}`,
          );
        }
      }
    }
    // sum feasibility from the bucket contents: bucket i's count_i samples each lie in
    // (base^(i−1), min(base^i, MAX_VALUE)] (samples are finite doubles — the cap is what
    // pins a forged "Infinity" on a single top-bucket sample, whose sum IS that sample)
    // and zero-bucket samples contribute exactly 0, so the true sum lies in
    // (sumLower, sumUpper]. The recorded float sum adds ≤ ~count·ε of accumulation error
    // on top — hence the count-scaled slack. The upper comparison divides instead of
    // multiplying because sumUpper × (1 + slack) itself overflows to Infinity at the float
    // ceiling, which would wave the sentinel through. The sentinel therefore only passes
    // when sumUpper overflows, i.e. the buckets really can add up past MAX_VALUE.
    const sumSlack = Math.min(SUM_BASE_SLACK + count * Number.EPSILON, MAX_SUM_SLACK);
    if (sum < sumLower * (1 - sumSlack) || sum / (1 + sumSlack) > sumUpper) {
      throw new Error(
        `LoadHistogram.fromJSON: sum ${sum} is outside the feasible range (${sumLower}, ${sumUpper}] implied by the buckets`,
      );
    }
    // Exact-extremes sum envelope, on top of the (coarser near the ends) bucket range:
    // min and max are exact aggregates — every one of the count samples lies in
    // [min, max] and at least one sample equals max and one equals min (the same sample
    // when count === 1, which forces sum === min === max; zero-bucket samples are exactly
    // 0 and are covered by the min === 0 case). Hence
    //   max + (count−1)·min ≤ true sum ≤ min + (count−1)·max.
    // These bounds are exact values, so only float-summation tolerance (the same
    // count-scaled sumSlack) applies; the upper comparison divides for the same
    // overflow-safety reason as above. A legitimately saturated sum passes naturally:
    // saturation requires max near the float ceiling, which drives the envelope's upper
    // end to Infinity.
    if (count > 0) {
      const envelopeLower = max + (count - 1) * min;
      const envelopeUpper = min + (count - 1) * max;
      if (sum < envelopeLower * (1 - sumSlack) || sum / (1 + sumSlack) > envelopeUpper) {
        throw new Error(
          `LoadHistogram.fromJSON: sum ${sum} is outside the exact-extremes envelope [${envelopeLower}, ${envelopeUpper}] (count ${count}, min ${min}, max ${max})`,
        );
      }
    }
    if (sum === Infinity && max < (Number.MAX_VALUE / count) * (1 - SUM_BASE_SLACK)) {
      // Backstop on top of the feasibility range: count × max bounds the true sum, so
      // saturation is only reachable when the observations can actually add up to the
      // float ceiling (tighter than sumUpper by up to a factor of base).
      throw new Error(
        `LoadHistogram.fromJSON: saturated sum ("Infinity") is impossible for count ${count} with max ${max}`,
      );
    }
    const h = new LoadHistogram(relativeError); // same relativeError → same base → mergeable
    h.zeroCount = zeroCount;
    h._count = count;
    h._sum = sum;
    h._min = count === 0 ? Infinity : min; // restore the no-observations sentinel
    h._max = max;
    for (const [idx, cnt] of bucketEntries) h.buckets.set(idx, cnt);
    return h;
  }
}
