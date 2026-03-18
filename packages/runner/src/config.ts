import type { ExecutionOptions, SingleExecutionOptions } from "./executor.js";

/**
 * Shared execution configuration consumed by CLI, Worker, and MCP.
 *
 * This is the single source of truth for run-time behavior that is
 * common across all execution contexts. Each consumer constructs a
 * `SharedRunConfig` and passes it to `TestExecutor.fromSharedConfig()`
 * to get a correctly configured executor.
 *
 * @example
 * const shared: SharedRunConfig = {
 *   ...LOCAL_RUN_DEFAULTS,
 *   failFast: true,
 * };
 * const executor = TestExecutor.fromSharedConfig(shared, { cwd: rootDir });
 */
export interface SharedRunConfig {
  /** Stop after first failure. Default: false. */
  failFast: boolean;

  /** Stop after N failures. Takes precedence over failFast. Default: undefined. */
  failAfter?: number;

  /**
   * Per-test timeout in ms. Default: 30_000.
   *
   * Used as the timeout for each individual test execution (passed to
   * SingleExecutionOptions.timeout). NOT a batch-level timeout.
   *
   * For batch-level timeout, Worker uses its own `taskTimeoutMs`
   * (overall task deadline) and derives per-test timeout from it.
   */
  perTestTimeoutMs: number;

  /** Max parallel test execution. Default: 1. */
  concurrency: number;

  /** Include full HTTP request/response in trace events. Default: false. */
  emitFullTrace: boolean;

  /** Infer JSON Schema from response bodies in trace events. Default: false. */
  inferSchema: boolean;

  /** Always truncate arrays in trace bodies (not just >1MB). Default: false. */
  truncateArrays: boolean;
}

/** Minimal safe defaults. */
export const SHARED_RUN_DEFAULTS: SharedRunConfig = {
  failFast: false,
  perTestTimeoutMs: 30_000,
  concurrency: 1,
  emitFullTrace: false,
  inferSchema: false,
  truncateArrays: false,
};

/** CLI/MCP preset: same as shared defaults (local development). */
export const LOCAL_RUN_DEFAULTS: SharedRunConfig = {
  ...SHARED_RUN_DEFAULTS,
};

/** Worker preset: longer timeout. */
export const WORKER_RUN_DEFAULTS: SharedRunConfig = {
  ...SHARED_RUN_DEFAULTS,
  perTestTimeoutMs: 300_000,
};

/**
 * Normalize timeout input to a positive integer milliseconds value.
 *
 * Returns undefined for missing, non-numeric, zero, or negative values.
 */
export function normalizePositiveTimeoutMs(
  value: unknown,
): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const normalized = Math.floor(Number(value));
  return normalized > 0 ? normalized : undefined;
}

/**
 * Build ExecutionOptions from SharedRunConfig.
 * Maps failFast -> stopOnFailure for backward compatibility
 * with the existing executeMany() interface.
 */
export function toExecutionOptions(
  shared: SharedRunConfig,
  extra?: Partial<ExecutionOptions>,
): ExecutionOptions {
  return {
    concurrency: shared.concurrency,
    stopOnFailure: shared.failFast,
    failAfter: shared.failAfter,
    ...extra,
  };
}

/**
 * Build SingleExecutionOptions from SharedRunConfig.
 * Wires perTestTimeoutMs to the per-test timeout parameter.
 */
export function toSingleExecutionOptions(
  shared: SharedRunConfig,
  extra?: Partial<SingleExecutionOptions>,
): SingleExecutionOptions {
  return {
    timeout: shared.perTestTimeoutMs,
    ...extra,
  };
}
