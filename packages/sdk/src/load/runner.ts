/**
 * loadRunner(): the pressure model + report model over a loadScenario.
 *
 * `loadRunner()` is the runnable: it references one `loadScenario()` (or a
 * traffic mix of several) and says how much pressure to apply. Discovery
 * (M2) surfaces only `loadRunner()` exports as runnable; the referenced
 * scenarios are workloads, not independently scheduled.
 *
 * M1 is the static authoring surface: `loadRunner()` returns a `LoadPlan`
 * holding the resolved config. Actual execution lives in @glubean/runner.
 */
import type { LoadBuilder } from "./builder.js";
import type { FeederBinding } from "./feeder.js";
import { projectLoadPlan } from "./projection.js";
import type { LoadProjection } from "./projection.js";
import type { LoadMetricDeclarations } from "./metrics.js";
import type { LoadScenario } from "./scenario.js";
import type { LoadAssertionFailureMode } from "./step.js";

/** A duration as milliseconds (number) or a human string like `"60s"` / `"2m"`. */
export type LoadDuration = number | string;

export interface LoadProducerSlotInfo {
  id: string;
  index: number;
}
export interface LoadIterationInfo {
  id: string;
  index: number;
}

/**
 * Arguments passed to a function-form `input`. `TRow` is the `loadRunner.each()`
 * row type that produced this plan (typed and present for each variants);
 * `undefined` for non-each plans.
 */
export interface LoadInputArgs<TRow = undefined> {
  row: TRow;
  /** Feeder-allocated rows for this iteration, keyed by feeder name. */
  feed: Record<string, any>;
  producerSlot: LoadProducerSlotInfo;
  iteration: LoadIterationInfo;
}

/**
 * Per-iteration scenario input. Object form is a static input (same for every
 * iteration); function form is the canonical form when feeders / producer-slot /
 * iteration / `.each()` row participate. There is no hidden merge.
 */
export type LoadInputOption<TInput, TRow = undefined> =
  | TInput
  | ((args: LoadInputArgs<TRow>) => TInput);

/** Safety valve for `ctx.report.primaryComplete(... releaseProducerSlot: true)`. */
export interface LoadContinuationConfig {
  maxOutstanding?: number;
  maxConcurrent?: number;
  minPollInterval?: LoadDuration;
  drainTimeout?: LoadDuration;
  onBacklogFull?: "block-producer" | "fail-iteration";
}

/** Optional pacing / think-time (MVP may leave unimplemented → back-to-back). */
export interface LoadPacingConfig {
  thinkTime?: LoadDuration | { min: LoadDuration; max: LoadDuration };
}

/** Threshold expressions for one scope (e.g. `errorRate: "<1%"`, `p95: "<800ms"`). */
export interface LoadThresholdScope {
  errorRate?: string;
  p50?: string;
  p90?: string;
  p95?: string;
  p99?: string;
  throughputPerSec?: string;
  backlog?: string;
  backpressureMs?: string;
}

/** Threshold expressions for a custom metric. `rate`/`sum`/`count` apply to the
 *  matching kind; `p50`..`p99` gate a `trend` distribution. */
export interface LoadCustomMetricThresholdScope {
  rate?: string;
  sum?: string;
  count?: string;
  p50?: string;
  p90?: string;
  p95?: string;
  p99?: string;
}

/** Structured thresholds. `endpoints` / `steps` are keyed by routeKey / stepId;
 *  `customMetric` is keyed by `metricId` or `metricId:tagKey=tagVal` (per series). */
export interface LoadThresholds {
  transaction?: LoadThresholdScope;
  primary?: LoadThresholdScope;
  endToEnd?: LoadThresholdScope;
  continuation?: LoadThresholdScope;
  endpoints?: Record<string, LoadThresholdScope>;
  steps?: Record<string, LoadThresholdScope>;
  customMetric?: Record<string, LoadCustomMetricThresholdScope>;
}

/** Bounded report sampling caps. */
export interface LoadReportConfig {
  failureTraces?: number;
  slowTransactionSummaries?: number;
}

/** A scenario reference: a built `LoadScenario` or an un-built `LoadBuilder`. */
export type LoadScenarioRef<Input = unknown> =
  | LoadScenario<Input, any>
  | LoadBuilder<Input, any>;

type Feeders = Record<string, FeederBinding>;

interface LoadRunnerCommon {
  concurrency: number;
  duration?: LoadDuration;
  iterations?: number;
  rampUp?: LoadDuration;
  pacing?: LoadPacingConfig;
  continuation?: LoadContinuationConfig;
  assertions?: { onFailure?: LoadAssertionFailureMode };
  thresholds?: LoadThresholds;
  report?: LoadReportConfig;
  /** Custom metrics to fold + gate, declared up front via `rate()`/`trend()`/
   *  `counter()`. Surfaced to steps as `ctx.metrics.<id>.add(...)` and folded
   *  into `summary.customMetrics`. */
  metrics?: LoadMetricDeclarations;
  /** How a run-level abort (stop / duration deadline / SIGINT) reaches in-flight
   *  requests.
   *  - `"precise"` (default): cancel in-flight HTTP at once. Uses a leak-free
   *    per-iteration abort bridge — no per-request listener accumulation.
   *  - `"coarse"`: don't wire the abort signal into each request; stop between steps
   *    instead. A few % more throughput for high-RPS runs where requests are short,
   *    at the cost of letting an already-sent request finish before the run stops. */
  abort?: "precise" | "coarse";
}

/** Single-scenario load runner config. `TRow` is the `.each()` row, if any. */
export interface LoadRunnerConfig<Input = unknown, TRow = undefined>
  extends LoadRunnerCommon {
  scenario: LoadScenarioRef<Input>;
  feeders?: Feeders;
  input?: LoadInputOption<Input, TRow>;
}

/** One entry in a traffic mix. */
export interface LoadMixEntry<Input = unknown, TRow = undefined> {
  id: string;
  scenario: LoadScenarioRef<Input>;
  weight: number;
  feeders?: Feeders;
  input?: LoadInputOption<Input, TRow>;
}

/** Multi-scenario (traffic mix) config. Each entry may have its own input/feeders. */
export interface LoadMixConfig<TRow = undefined> extends LoadRunnerCommon {
  // `LoadMixEntry<any, TRow>` so a mix can hold heterogeneous typed scenarios:
  // each entry binds its own scenario↔input Input (use `loadMixEntry()` for
  // per-entry type checking), while sharing the `.each()` row type.
  scenarios: LoadMixEntry<any, TRow>[];
  /** Shared feeders (no Input coupling). Per-entry feeders override these. */
  feeders?: Feeders;
  // NOTE: `input` is per-entry only. A top-level shared `input` can't be made
  // type-safe over a heterogeneous scenario array — it would erase to `any` and
  // silently accept a shape no scenario expects — so each entry carries its own
  // typed `input` (via `loadMixEntry()` for full checking).
}

export type AnyLoadRunnerConfig = LoadRunnerConfig<any, any> | LoadMixConfig<any>;

/** A runnable load plan (output of `loadRunner()`). */
export interface LoadPlan {
  readonly __glubean_type: "load-runner";
  id: string;
  config: AnyLoadRunnerConfig;
  /**
   * For `loadRunner.each()` variants: the table row that produced this plan.
   * The load runtime surfaces it to function-form `input` as `args.row`.
   * Absent for non-each plans.
   */
  row?: Record<string, unknown>;
  /**
   * Plain-data projection of this plan (runnerId / scenarios / steps /
   * normalized durations / threshold scopes), exposed as a lazily-recomputed
   * getter so it always reflects the current config / scenario builders — no
   * stale snapshot if a scenario gains steps after `loadRunner()`. Discovery
   * (scanner / CLI) reads it by duck-typing the exported value: no SDK import
   * and no global registry needed.
   */
  readonly projection: LoadProjection;
}

/** Interpolate `$index` and `$field` placeholders in an `.each()` id template. */
function interpolateId(
  template: string,
  row: Record<string, unknown>,
  index: number,
): string {
  // Token-aware: match a whole `$identifier` placeholder, so a field name that
  // prefixes another (possibly missing) longer placeholder can't corrupt it
  // (e.g. `$plan` must not eat the `$plan` inside a missing `$planId`).
  return template.replace(/\$(\w+)/g, (match, name: string) => {
    if (name === "index") return String(index);
    if (Object.prototype.hasOwnProperty.call(row, name)) return String(row[name]);
    return match; // unknown placeholder — leave intact rather than silently corrupt
  });
}

interface LoadRunnerFn {
  /** Single-scenario load plan. */
  <Input, TRow = undefined>(id: string, config: LoadRunnerConfig<Input, TRow>): LoadPlan;
  /** Traffic-mix load plan. */
  (id: string, config: LoadMixConfig): LoadPlan;
  /**
   * Scenario-level inventory expansion: one load plan per row (e.g. by plan,
   * region, tenant). Each variant has its own id / thresholds / report, and the
   * factory may return a single scenario or a traffic mix. Function-form `input`
   * receives the producing row as a typed `args.row`.
   */
  each<TRow extends object>(
    table: readonly TRow[],
  ): <Input>(
    idTemplate: string,
    factory: (
      row: TRow,
      index: number,
    ) => LoadRunnerConfig<Input, TRow> | LoadMixConfig<TRow>,
  ) => LoadPlan[];
}

/**
 * Build a LoadPlan whose `projection` is a lazily-recomputed getter, so it
 * always reflects the current config / scenario builders (no stale snapshot if
 * a scenario gains steps after `loadRunner()` is called).
 */
function makeLoadPlan(
  id: string,
  config: AnyLoadRunnerConfig,
  row?: Record<string, unknown>,
): LoadPlan {
  const plan = {
    __glubean_type: "load-runner" as const,
    id,
    config,
    ...(row !== undefined ? { row } : {}),
  };
  Object.defineProperty(plan, "projection", {
    get: () => projectLoadPlan(plan),
    enumerable: true,
  });
  return plan as LoadPlan;
}

const loadRunnerImpl = (id: string, config: AnyLoadRunnerConfig): LoadPlan =>
  makeLoadPlan(id, config);

loadRunnerImpl.each = <TRow extends object>(table: readonly TRow[]) => {
  return <Input>(
    idTemplate: string,
    factory: (
      row: TRow,
      index: number,
    ) => LoadRunnerConfig<Input, TRow> | LoadMixConfig<TRow>,
  ): LoadPlan[] =>
    table.map((row, index) => {
      const rowRecord = row as Record<string, unknown>;
      return makeLoadPlan(
        interpolateId(idTemplate, rowRecord, index),
        factory(row, index) as AnyLoadRunnerConfig,
        rowRecord,
      );
    });
};

/**
 * Define a pressure plan over one or more load scenarios.
 *
 * @example single scenario
 * ```ts
 * export const checkoutLoad = loadRunner("checkout-300", {
 *   scenario: checkoutScenario,
 *   concurrency: 300,
 *   duration: "60s",
 *   input: ({ feed, producerSlot, iteration }) => ({
 *     user: feed.user,
 *     clientRequestId: `${producerSlot.id}-${iteration.id}`,
 *   }),
 *   thresholds: { transaction: { errorRate: "<1%", p95: "<2000ms" } },
 * });
 * ```
 */
export const loadRunner = loadRunnerImpl as LoadRunnerFn;

/**
 * Type-safe constructor for a traffic-mix entry: it binds `input` to the
 * scenario's `Input`, so a mismatched input shape is rejected at author time.
 *
 * Use it inside `scenarios: [...]`. A bare object literal in the array is only
 * checked against `LoadMixEntry<any>` (TypeScript can't infer a distinct `Input`
 * per array element), so wrap each entry with `loadMixEntry()` for per-entry
 * type checking of heterogeneous typed scenarios.
 *
 * @example
 * ```ts
 * scenarios: [
 *   loadMixEntry({ id: "checkout", scenario: checkout, weight: 70, input: () => ({ sku: "s" }) }),
 *   loadMixEntry({ id: "refund", scenario: refund, weight: 30, input: () => ({ orderId: "o" }) }),
 * ]
 * ```
 */
export function loadMixEntry<Input, TRow = undefined>(
  entry: LoadMixEntry<Input, TRow>,
): LoadMixEntry<any, TRow> {
  return entry as LoadMixEntry<any, TRow>;
}
