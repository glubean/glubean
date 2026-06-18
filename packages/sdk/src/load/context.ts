/**
 * Load execution context.
 *
 * `LoadContext` is a narrowed `TestContext`: ordinary test-evidence APIs
 * (full trace / metric / action / event / schema validation / memory usage /
 * retry reflection) are removed, and load-only input / identity / report
 * capabilities are added.
 *
 * It deliberately reuses the same runtime-carrier contract as `test()`, so a
 * user's `configure(...)` clients, global `session`, and `vars` / `secrets`
 * work unchanged inside a load scenario — the load runtime just installs a
 * per-iteration runtime (via `runWithRuntime`) instead of a per-test one.
 */
import type { TestContext } from "../types.js";

/** Identity of a primary producer slot (the concurrency unit). */
export interface LoadProducerSlot {
  id: string;
  index: number;
}

/** Identity of one logical scenario iteration (a transaction instance). */
export interface LoadIteration {
  id: string;
  index: number;
}

/** Receipt returned by `ctx.report.primaryComplete()` for diagnostics. */
export interface LoadPrimaryCompletionReceipt {
  /** Whether this call recorded the primary measurement boundary. */
  measuredPrimaryComplete: boolean;
  /** Whether a producer slot was actually released for back-fill. */
  releasedProducerSlot: boolean;
  /** Whether this was a duplicate boundary call (ignored for scheduling). */
  duplicate: boolean;
  /** How long the call waited on continuation backpressure, in ms. */
  backpressureMs: number;
}

/**
 * Bounded report signals understood by the load runtime. This is NOT a
 * free-form event API like ordinary `ctx.event`; only these signals exist.
 */
export interface LoadReportSignal {
  /** Pure report attribution; does not affect scheduling. */
  checkpoint(id: string, data?: Record<string, unknown>): void;
  /**
   * Declare that the primary load for this iteration has been issued, switching
   * the logical iteration into its continuation phase (splits primary vs
   * end-to-end metrics). Pass `releaseProducerSlot: true` to also let the
   * runner back-fill a new primary iteration on this slot.
   *
   * Always `await` it: when `releaseProducerSlot` is set and the continuation
   * backlog is full, it applies producer backpressure.
   */
  primaryComplete(
    id: string,
    data?: Record<string, unknown> & { releaseProducerSlot?: true },
  ): Promise<LoadPrimaryCompletionReceipt>;
}

/**
 * `TestContext` capabilities removed in load mode. These are ordinary
 * test-evidence APIs that would mislead users into expecting contract-grade
 * schema evidence or a full per-request timeline in a load run.
 */
export type LoadOmittedContextKeys =
  | "validate"
  | "trace"
  | "metric"
  | "action"
  | "event"
  | "getMemoryUsage"
  | "retryCount";

/**
 * Load execution context: a narrowed `TestContext` plus load-only members.
 *
 * Retained from `TestContext`: `vars`, `secrets`, `http`, `session`, `log`,
 * `warn`, `expect`, `assert`, `skip`, `fail`, `pollUntil`, `setTimeout`.
 * Added: `input`, `producerSlot`, `iteration`, `now()`, `report`.
 */
export type LoadContext<Input = unknown> = Omit<
  TestContext,
  LoadOmittedContextKeys
> & {
  /** Per-iteration raw input produced by `loadRunner().input`. */
  input: Input;
  /** Identity of the producer slot running this iteration's primary phase. */
  producerSlot: LoadProducerSlot;
  /** Identity of this logical scenario iteration. */
  iteration: LoadIteration;
  /** Monotonic-ish timestamp source for measuring durations within a scenario. */
  now(): number;
  /** Bounded load report signals (checkpoint / primaryComplete). */
  report: LoadReportSignal;
};
