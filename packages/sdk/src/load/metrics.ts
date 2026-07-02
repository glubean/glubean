/**
 * Load custom metrics — declared-up-front, folded aggregate dimensions.
 *
 * A custom metric is a user-defined aggregate (poll-success ratio per class,
 * user-measured duration distribution, a summed counter) that the load reducer
 * folds in O(1) alongside latency/statusCounts, and that thresholds can gate CI
 * on. It is the load-mode replacement for the per-point `ctx.metric` removed in
 * load mode (`LoadOmittedContextKeys`): an aggregate primitive instead of a
 * per-event record, so it is safe under concurrency.
 *
 * Authoring: declare on the runner (`loadRunner({ metrics: { pollOk: rate() } })`)
 * and fold inline in a step (`ctx.metrics.pollOk.add(ok, { class })`). Handles are
 * permissively typed: a `loadScenario()` is authored independently of the
 * `loadRunner()` that declares `metrics` and references it, so the declared set is
 * not in scope at the step — `ctx.metrics.<id>` resolves to a generic handle, not
 * a per-kind one. (Per-key typing can't be threaded to an already-built scenario
 * closure, so it isn't offered rather than offered-but-unreachable.)
 *
 * The fold (reducer), `maxSeries` enforcement, and threshold evaluation live in
 * @glubean/runner.
 *
 * Analogous to k6's Counter / Rate / Trend, so an external-engine adapter (M9)
 * can map its native custom metrics onto the same artifact shape.
 */

/** The three folded custom-metric kinds. */
export type LoadMetricKind = "rate" | "trend" | "counter";

/**
 * A declared custom metric, produced by `rate()` / `trend()` / `counter()` and
 * passed to `loadRunner({ metrics })`. Static data (kind + optional unit), so
 * cardinality/shape is known at build and projectable.
 */
export interface LoadMetricDescriptor<K extends LoadMetricKind = LoadMetricKind> {
  readonly kind: K;
  /** Display unit for a `trend` distribution (e.g. `"ms"`). */
  readonly unit?: string;
}

/**
 * Low-cardinality tag set attached to a fold. Tags fan a metric into series
 * (`class=extreme`); they MUST stay low-cardinality — a high-cardinality tag
 * (`itemId`) is an author error the reducer surfaces via `maxSeries` truncation
 * + an advisory, not a silent memory leak.
 */
export type LoadMetricTags = Record<string, string>;

/**
 * A folding handle for one declared metric. The value's meaning is set by the
 * metric's kind:
 *   - `rate`: pass a boolean outcome (a number folds as `!== 0`);
 *   - `counter`: an optional increment (default `+1`);
 *   - `trend`: a numeric sample.
 * A value that doesn't fit the kind (or a non-finite number) is dropped, never
 * folded — a bad `add(...)` must not fell an iteration under load.
 */
export interface LoadMetricHandle {
  add(value?: boolean | number, tags?: LoadMetricTags): void;
}

/** `ctx.metrics` — declared metric ids resolve to a handle; an undeclared id is a no-op. */
export type LoadMetricHandles = Record<string, LoadMetricHandle>;

/** A declared set of custom metrics, as passed to `loadRunner({ metrics })`. */
export type LoadMetricDeclarations = Record<string, LoadMetricDescriptor>;

/** Declare a boolean-ratio metric (k6 Rate). */
export function rate(): LoadMetricDescriptor<"rate"> {
  return { kind: "rate" };
}

/** Declare a numeric-distribution metric (k6 Trend). Optional display `unit`.
 *  Thresholds (`p50`..`p99`) are ms-shaped (`"<800ms"`, `"<2s"`) when the unit is
 *  `"ms"` or unset; any OTHER unit (`"bytes"`, `"items"`) is gated with bare
 *  numbers in that unit (`"<4096"`) — an `ms`/`s` suffix is rejected there. */
export function trend(options?: { unit?: string }): LoadMetricDescriptor<"trend"> {
  return options?.unit !== undefined
    ? { kind: "trend", unit: options.unit }
    : { kind: "trend" };
}

/** Declare a summed counter metric (k6 Counter). */
export function counter(): LoadMetricDescriptor<"counter"> {
  return { kind: "counter" };
}
