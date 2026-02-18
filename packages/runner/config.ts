import type { ExecutionOptions, SingleExecutionOptions } from "./executor.ts";

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

  /**
   * Base Deno permission flags for the sandboxed subprocess.
   * Default: ["--allow-read"]
   *
   * SECURITY: Read access is intentionally unrestricted because:
   * - Deno needs to read its module cache (~/.cache/deno)
   * - Test code may import from parent directories (../shared/)
   * - Data files (fromCsv/fromYaml) may use absolute paths
   * - In local dev, tests are user-authored (trusted)
   * - In Cloud Worker, the real security boundary is --allow-env
   *   exclusion + maskEnvPrefixes (credentials live in env, not files)
   *
   * Consumers add context-appropriate permissions on top:
   * - CLI/MCP add "--allow-env" (local dev, user's own machine)
   * - Cloud Worker does NOT add "--allow-env" (multi-tenant, holds credentials)
   * - Self-hosted Worker may add "--allow-env" (safe when maskEnvPrefixes is set)
   *
   * Note: `--allow-net` is handled separately via `allowNet` because
   * it accepts a host allowlist (security policy, not a simple on/off).
   */
  permissions: string[];

  /**
   * Network access policy for the sandboxed subprocess.
   * - "*" or undefined: unrestricted (--allow-net)
   * - "api.example.com,db:5432": host allowlist (--allow-net=host1,host2)
   * - "": no network access (--allow-net omitted)
   *
   * Default: "*" (unrestricted)
   */
  allowNet: string;

  /** Include full HTTP request/response in trace events. Default: false. */
  emitFullTrace: boolean;
}

/** Minimal safe defaults — no --allow-env, unrestricted network. */
export const SHARED_RUN_DEFAULTS: SharedRunConfig = {
  failFast: false,
  perTestTimeoutMs: 30_000,
  concurrency: 1,
  permissions: ["--allow-read"],
  allowNet: "*",
  emitFullTrace: false,
};

/** CLI/MCP preset: adds --allow-env for local development. */
export const LOCAL_RUN_DEFAULTS: SharedRunConfig = {
  ...SHARED_RUN_DEFAULTS,
  permissions: ["--allow-read", "--allow-env"],
};

/** Worker preset: no --allow-env, longer timeout. */
export const WORKER_RUN_DEFAULTS: SharedRunConfig = {
  ...SHARED_RUN_DEFAULTS,
  perTestTimeoutMs: 300_000,
};

/**
 * Resolve the `allowNet` policy string into a Deno permission flag.
 *
 * Fail-closed: if the input contains only commas/whitespace (no valid hosts),
 * returns `null` (no network) rather than granting unrestricted access.
 *
 * @returns `"--allow-net"` for `"*"`, `"--allow-net=host1,host2"`
 *          for a valid allowlist, or `null` for no network access.
 */
export function resolveAllowNetFlag(allowNet: string): string | null {
  const raw = allowNet.trim();
  if (raw === "") return null;
  if (raw === "*") return "--allow-net";
  const normalized = raw.split(",").map((h) => h.trim()).filter(Boolean).join(
    ",",
  );
  return normalized ? `--allow-net=${normalized}` : null;
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
