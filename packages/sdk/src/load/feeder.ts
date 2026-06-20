/**
 * Feeder: data source + allocation strategy + scope + exhaustion policy.
 *
 * A feeder draws rows for a producer slot / iteration during load execution.
 * It is NOT inventory expansion (that's `loadRunner.each()`); a feeder does not
 * generate runnables, it allocates data at run time.
 *
 * M1-d is the in-memory implementation: `feeder.fromArray()` is the synchronous
 * core; `feeder.fromJson()` / `feeder.fromCsv()` reuse the SDK data loaders.
 * Allocation is single-node only — `uniquePerVu` / `uniquePerIteration` /
 * `partitionByVu` guarantee uniqueness on one node; a distributed engine needs
 * its own coordination layer (the artifact records `feederGuarantee`).
 */
import { fromCsv as loadCsv, fromJson as loadJson } from "../data.js";

/** Built-in allocation strategies. */
export type FeederStrategy =
  | "uniquePerVu"
  | "uniquePerIteration"
  | "roundRobin"
  | "random"
  | "weightedRandom"
  | "partitionByVu";

/** What to do when a feeder runs out of rows. */
export type ExhaustedPolicy = "fail" | "recycle" | "skip" | "wait";

/** Common options for an allocation strategy. */
export interface FeederStrategyOptions {
  exhausted?: ExhaustedPolicy;
}

/** Options for `weightedRandom` — `weight` names the numeric weight field. */
export interface WeightedRandomOptions extends FeederStrategyOptions {
  weight: string;
}

/** Options for constructing a feeder source. */
export interface FeederSourceOptions {
  /** Row field used as the report / uniqueness key. */
  key?: string;
}

/** Context the load runtime provides when drawing a row. */
export interface FeederDrawContext {
  /** 0-based producer slot index. */
  producerSlot: number;
  /** Total number of producer slots (concurrency) — used by `partitionByVu`. */
  producerCount: number;
  /** 0-based iteration index within this producer slot. */
  slotIteration: number;
  /** 0-based global iteration index across all slots. */
  globalIteration: number;
  /**
   * 0-based count of how many times THIS feeder has already been drawn across all slots —
   * the run-global DRAW index. Equals `globalIteration` for a single scenario (a feeder is
   * drawn every iteration); in a traffic mix it advances only on iterations that draw this
   * feeder, so a per-entry (or partially-overridden shared) feeder consumes its rows
   * contiguously. Built-in `uniquePerIteration` / `roundRobin` index by it. Optional: a
   * caller that omits it falls back to `globalIteration` (single-scenario parity).
   */
  drawIndex?: number;
  /** 0-based count of how many times THIS feeder has already been drawn BY THIS producer
   *  slot — the per-slot DRAW index (the slot-scoped analogue of `drawIndex`). Built-in
   *  `partitionByVu` indexes by it; omitting it falls back to `slotIteration`. */
  slotDrawIndex?: number;
}

/** Result of a feeder draw. */
export type FeederDraw<T> =
  | { outcome: "value"; value: T; key?: string }
  | { outcome: "exhausted" } // `fail` policy → runtime fails the iteration
  | { outcome: "skip" } // `skip` policy → runtime skips the iteration
  | { outcome: "wait" }; // `wait` policy → runtime should retry later

/**
 * A resolved feeder binding, ready for the load runtime to draw rows from.
 */
export interface FeederBinding<T = unknown> {
  readonly __glubean_type: "load-feeder";
  readonly strategy: FeederStrategy;
  readonly exhausted: ExhaustedPolicy;
  /** Row field used as the report / uniqueness key, if configured. */
  readonly key?: string;
  /** Row field carrying the weight (`weightedRandom` only). */
  readonly weight?: string;
  /** Number of rows backing this feeder (single-node, in-memory). */
  readonly size: number;
  /** Draw a row for the given allocation context. */
  allocate(ctx: FeederDrawContext): FeederDraw<T>;
}

/** A feeder data source; call a strategy method to get a `FeederBinding`. */
export interface FeederSource<T = unknown> {
  readonly rows: readonly T[];
  /** One row per producer slot, fixed for that slot's lifetime. Default: fail. */
  uniquePerVu(opts?: FeederStrategyOptions): FeederBinding<T>;
  /** A fresh, never-reused row per iteration. Default: fail. */
  uniquePerIteration(opts?: FeederStrategyOptions): FeederBinding<T>;
  /** Cycle through rows in order. Default: recycle. */
  roundRobin(opts?: FeederStrategyOptions): FeederBinding<T>;
  /** Uniformly random row each draw. Default: recycle. */
  random(opts?: FeederStrategyOptions): FeederBinding<T>;
  /** Weighted-random row by a numeric field. Default: recycle. */
  weightedRandom(opts: WeightedRandomOptions): FeederBinding<T>;
  /** Shard rows across producer slots (avoids contention). Default: fail. */
  partitionByVu(opts?: FeederStrategyOptions): FeederBinding<T>;
}

// =============================================================================
// Allocation
// =============================================================================

function toValueDraw<T extends object>(row: T, key?: string): FeederDraw<T> {
  if (key === undefined) return { outcome: "value", value: row };
  return { outcome: "value", value: row, key: String((row as Record<string, unknown>)[key]) };
}

function missDraw<T>(policy: ExhaustedPolicy): FeederDraw<T> {
  switch (policy) {
    case "skip":
      return { outcome: "skip" };
    case "wait":
      return { outcome: "wait" };
    // `recycle` can't recycle an empty/over-range set with no rows → behaves as fail
    default:
      return { outcome: "exhausted" };
  }
}

function drawIndexed<T extends object>(
  rows: readonly T[],
  rawIndex: number,
  policy: ExhaustedPolicy,
  key?: string,
): FeederDraw<T> {
  if (rows.length === 0) return missDraw(policy);
  if (rawIndex >= 0 && rawIndex < rows.length) return toValueDraw(rows[rawIndex], key);
  if (policy === "recycle") {
    const wrapped = ((rawIndex % rows.length) + rows.length) % rows.length;
    return toValueDraw(rows[wrapped], key);
  }
  return missDraw(policy);
}

function pickWeighted<T extends object>(rows: readonly T[], weightField: string): T | undefined {
  let total = 0;
  const weights = rows.map((row) => {
    const raw = Number((row as Record<string, unknown>)[weightField]);
    const w = Number.isFinite(raw) && raw > 0 ? raw : 0;
    total += w;
    return w;
  });
  if (total <= 0) return undefined;
  let r = Math.random() * total;
  for (let i = 0; i < rows.length; i++) {
    r -= weights[i];
    if (r < 0) return rows[i];
  }
  return rows[rows.length - 1];
}

function makeBinding<T extends object>(
  rows: readonly T[],
  strategy: FeederStrategy,
  exhausted: ExhaustedPolicy,
  key?: string,
  weight?: string,
): FeederBinding<T> {
  const allocate = (ctx: FeederDrawContext): FeederDraw<T> => {
    switch (strategy) {
      case "uniquePerVu":
        return drawIndexed(rows, ctx.producerSlot, exhausted, key);
      case "uniquePerIteration":
      case "roundRobin":
        // Index by THIS feeder's run-global draw count so a mix entry / overridden shared
        // feeder stays contiguous; `?? globalIteration` keeps single-scenario parity.
        return drawIndexed(rows, ctx.drawIndex ?? ctx.globalIteration, exhausted, key);
      case "random":
        return rows.length === 0
          ? missDraw(exhausted)
          : toValueDraw(rows[Math.floor(Math.random() * rows.length)], key);
      case "weightedRandom": {
        const picked = weight ? pickWeighted(rows, weight) : undefined;
        return picked === undefined ? missDraw(exhausted) : toValueDraw(picked, key);
      }
      case "partitionByVu": {
        const partition =
          ctx.producerCount > 0
            ? rows.filter((_, i) => i % ctx.producerCount === ctx.producerSlot)
            : rows.slice();
        // Index within the VU partition by THIS feeder's per-slot draw count (mix-correct);
        // `?? slotIteration` keeps single-scenario parity.
        return drawIndexed(partition, ctx.slotDrawIndex ?? ctx.slotIteration, exhausted, key);
      }
    }
  };
  return {
    __glubean_type: "load-feeder",
    strategy,
    exhausted,
    ...(key !== undefined ? { key } : {}),
    ...(weight !== undefined ? { weight } : {}),
    size: rows.length,
    allocate,
  };
}

class FeederSourceImpl<T extends object> implements FeederSource<T> {
  constructor(
    readonly rows: readonly T[],
    private readonly key?: string,
  ) {}

  uniquePerVu(opts?: FeederStrategyOptions): FeederBinding<T> {
    return makeBinding(this.rows, "uniquePerVu", opts?.exhausted ?? "fail", this.key);
  }
  uniquePerIteration(opts?: FeederStrategyOptions): FeederBinding<T> {
    return makeBinding(this.rows, "uniquePerIteration", opts?.exhausted ?? "fail", this.key);
  }
  roundRobin(opts?: FeederStrategyOptions): FeederBinding<T> {
    return makeBinding(this.rows, "roundRobin", opts?.exhausted ?? "recycle", this.key);
  }
  random(opts?: FeederStrategyOptions): FeederBinding<T> {
    return makeBinding(this.rows, "random", opts?.exhausted ?? "recycle", this.key);
  }
  weightedRandom(opts: WeightedRandomOptions): FeederBinding<T> {
    return makeBinding(this.rows, "weightedRandom", opts.exhausted ?? "recycle", this.key, opts.weight);
  }
  partitionByVu(opts?: FeederStrategyOptions): FeederBinding<T> {
    return makeBinding(this.rows, "partitionByVu", opts?.exhausted ?? "fail", this.key);
  }
}

// =============================================================================
// Sources
// =============================================================================

/**
 * Feeder data-source factories. `fromArray` is synchronous; `fromJson` /
 * `fromCsv` read a file and must be awaited.
 *
 * @example
 * ```ts
 * const users = feeder.fromArray([{ userId: "u1" }, { userId: "u2" }], { key: "userId" });
 * const products = await feeder.fromJson("./data/products.json", { key: "sku" });
 * loadRunner("checkout", {
 *   scenario,
 *   concurrency: 300,
 *   feeders: {
 *     user: users.uniquePerVu({ exhausted: "fail" }),
 *     product: products.weightedRandom({ weight: "trafficWeight" }),
 *   },
 *   input: ({ feed }) => ({ user: feed.user, product: feed.product }),
 * });
 * ```
 */
export const feeder = {
  /** In-memory rows. */
  fromArray<T extends object>(
    rows: readonly T[],
    opts?: FeederSourceOptions,
  ): FeederSource<T> {
    return new FeederSourceImpl<T>(rows, opts?.key);
  },

  /** Load rows from a JSON file (array, or `pick` a nested array). Await it. */
  async fromJson<T extends object = Record<string, unknown>>(
    path: string,
    opts?: FeederSourceOptions & { pick?: string },
  ): Promise<FeederSource<T>> {
    const rows = (await loadJson(
      path,
      opts?.pick ? { pick: opts.pick } : undefined,
    )) as unknown as readonly T[];
    return new FeederSourceImpl<T>(rows, opts?.key);
  },

  /** Load rows from a CSV/TSV file. Await it. */
  async fromCsv<T extends object = Record<string, string>>(
    path: string,
    opts?: FeederSourceOptions & { separator?: string; headers?: boolean },
  ): Promise<FeederSource<T>> {
    const loaderOpts: { separator?: string; headers?: boolean } = {};
    if (opts?.separator !== undefined) loaderOpts.separator = opts.separator;
    if (opts?.headers !== undefined) loaderOpts.headers = opts.headers;
    const rows = (await loadCsv(path, loaderOpts)) as unknown as readonly T[];
    return new FeederSourceImpl<T>(rows, opts?.key);
  },
};
