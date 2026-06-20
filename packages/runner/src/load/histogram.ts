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

export class LoadHistogram {
  private readonly base: number;
  private readonly logBase: number;
  private readonly buckets = new Map<number, number>();
  private zeroCount = 0;
  private _count = 0;
  private _sum = 0;
  private _min = Infinity;
  private _max = 0;

  /** @param relativeError bucket width as a fraction (0,1); default 1%. */
  constructor(relativeError: number = DEFAULT_RELATIVE_ERROR) {
    if (!(relativeError > 0 && relativeError < 1)) {
      throw new Error(`LoadHistogram relativeError must be in (0, 1), got ${relativeError}`);
    }
    this.base = 1 + relativeError;
    this.logBase = Math.log(this.base);
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
   * Percentile `p` in [0, 100]. Returns the bucket upper bound (so at most
   * `relativeError` above the true value), never above the observed max.
   */
  percentile(p: number): number {
    if (this._count === 0) return 0;
    if (p <= 0) return this.min;
    if (p >= 100) return this._max;
    const target = Math.min(this._count, Math.max(1, Math.ceil((p / 100) * this._count)));
    let cumulative = this.zeroCount;
    if (cumulative >= target) return 0;
    const indices = [...this.buckets.keys()].sort((a, b) => a - b);
    for (const idx of indices) {
      cumulative += this.buckets.get(idx) ?? 0;
      if (cumulative >= target) {
        return Math.min(this.base ** idx, this._max);
      }
    }
    return this._max;
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
   * Bucket the observations against fixed upper-bound `boundaries` (ms, ascending) for a
   * distribution / CDF chart. Each emitted bucket counts observations in (prevBound, leMs];
   * a final overflow bucket (leMs = the observed max) carries anything PAST the last
   * boundary. A FIXED ladder keeps two runs' distributions directly comparable (aligned
   * x-axis). Empty when there are no observations.
   *
   * Each log bucket is placed by its LOWER bound `base^(idx-1)` — the largest value strictly
   * below every observation in the bucket. The upper bound over-estimates by up to
   * `relativeError`, which would push an exact ladder-edge value (e.g. 1000ms) into the next
   * bucket or a false overflow; the lower bound keeps an exact boundary latency in its own
   * bucket. So a run whose max is at/below the last boundary emits no overflow, every
   * observation lands in exactly one bucket (counts sum to the total), and the buckets stay
   * monotonic (codex). Values strictly between two boundaries but within one log bucket of a
   * boundary may round down by that bucket — the histogram's inherent `relativeError`.
   */
  distribution(boundaries: number[]): { leMs: number; count: number }[] {
    if (this._count === 0 || boundaries.length === 0) return [];
    const counts = new Array<number>(boundaries.length).fill(0);
    let overflow = 0;
    counts[0] += this.zeroCount; // a zero observation is ≤ the first (positive) boundary
    for (const [idx, cnt] of this.buckets) {
      const lower = this.base ** (idx - 1); // lower bound of (base^(idx-1), base^idx]
      let placed = false;
      for (let i = 0; i < boundaries.length; i++) {
        if (lower <= boundaries[i]) {
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
    this.zeroCount += other.zeroCount;
    this._count += other._count;
    this._sum += other._sum;
    if (other._count > 0) {
      if (other._min < this._min) this._min = other._min;
      if (other._max > this._max) this._max = other._max;
    }
    for (const [idx, c] of other.buckets) {
      this.buckets.set(idx, (this.buckets.get(idx) ?? 0) + c);
    }
  }
}
