/**
 * Feeder: data source + allocation strategy + scope + exhaustion policy.
 *
 * A feeder draws rows for a producer slot / iteration / step during load
 * execution. It is NOT inventory expansion (that's `loadRunner.each()`); a
 * feeder does not generate runnables, it allocates data at run time.
 *
 * M1-c defines the binding TYPES that `loadRunner().feeders` references. The
 * in-memory sources (array / CSV / JSON) and the allocation logic land in M1-d.
 */

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

/**
 * A resolved feeder binding, ready for the load runtime to draw rows from.
 *
 * Single-node only in M1 — `uniquePerVu` / `uniquePerIteration` /
 * `partitionByVu` guarantee uniqueness on one node; a distributed engine needs
 * its own coordination layer (artifact records `feederGuarantee`).
 */
export interface FeederBinding<T = unknown> {
  readonly __glubean_type: "load-feeder";
  readonly strategy: FeederStrategy;
  readonly exhausted: ExhaustedPolicy;
  /** Row field used as the report / uniqueness key, if configured. */
  readonly key?: string;
  /** Row field carrying the weight (`weightedRandom` only). */
  readonly weight?: string;
}
