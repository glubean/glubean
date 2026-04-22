/**
 * `@glubean/runner` public API.
 *
 * Three tiers of intended use:
 *
 * 1. **Recommended top-level API** — `ProjectRunner` facade. New consumers
 *    (VSCode extension, third-party embedders, future tooling) should start
 *    here. Handles the full "run a project's tests" pipeline (bootstrap +
 *    env + session + per-file batched TestExecutor loop) with a typed
 *    event stream.
 *
 * 2. **Entry-point infrastructure** — `bootstrap()` / `loadProjectEnv()`
 *    and friends. Every tool that touches a Glubean project calls these
 *    early in its lifecycle regardless of whether it uses the facade.
 *
 * 3. **Execution primitives** — `TestExecutor`, `RunOrchestrator`,
 *    `MetricCollector`, `discoverSessionFile`, etc. Pre-facade API,
 *    retained because CLI still uses them directly (migration tracked
 *    as RF-1b in backlog). Treat as legacy; new code should prefer the
 *    facade. These may become internal once all first-party consumers
 *    migrate.
 *
 * Anything not exported here is considered internal. That includes:
 *   - Deeper orchestrator helpers (`buildExecutionOrder`,
 *     `collectSessionUpdates`, scheduling types)
 *   - Test-resolution utilities beyond `resolveModuleTests`
 *     (`autoResolve`, `findTestById`, `findTestByExport`, `is*` guards,
 *     `ResolvedTest`)
 *   - Threshold math helpers (`aggregate`, `parseExpression`)
 *   - Rarely-used config utilities (`SHARED_RUN_DEFAULTS`,
 *     `WORKER_RUN_DEFAULTS`, `toExecutionOptions`)
 *   - Internal event-stream types (`EventHandler`, `ExecutionBatchResult`,
 *     `Summary`, `ExecutionOptions`, `ExecutionResult`, `ExecutorOptions`,
 *     `SingleExecutionOptions`)
 *
 * None of these are used outside this package (`@glubean/cli`,
 * `@glubean/mcp`, and `/Users/peisong/glubean/vscode` all verified as of
 * 2026-04-22). If a future consumer needs one, promote it to a public
 * export with a rationale rather than back-channeling.
 */

// =============================================================================
// 1. Recommended top-level API
// =============================================================================

/** Facade — `ProjectRunner` wraps the full run pipeline. Start here for new code. */
export { ProjectRunner } from "./project-runner.js";
export type {
  ProjectRunEvent,
  ProjectRunnerOptions,
  ProjectRunnerTest,
} from "./project-runner.js";

// =============================================================================
// 2. Entry-point infrastructure
// =============================================================================

/**
 * Plugin bootstrap — locate and import `glubean.setup.ts` so plugin
 * registrations (matchers / protocol adapters) are in place before
 * scanner runtime extraction or test execution.
 *
 * MUST be awaited at the top of any entry point that observes plugin
 * registrations (CLI `run`, CLI `contracts`, MCP tool handlers, VSCode
 * scan path, runner harness).
 */
export { bootstrap, discoverSetupFile } from "./bootstrap.js";

/**
 * Canonical project-env loader. Returns `{ vars, secrets }` with
 * `${NAME}` expansion applied cross-file (vars ↔ secrets) and
 * process.env fallback. CLI / MCP / VSCode all route through this.
 */
export { loadEnvFile, loadProjectEnv, expandVars } from "./env.js";
export type { ProjectEnv } from "./env.js";

// =============================================================================
// 3. Execution primitives (pre-facade; review after RF-1b migration)
// =============================================================================

/** Legacy subprocess orchestrator. `ProjectRunner` uses it internally. */
export { TestExecutor, generateSummary } from "./executor.js";
export type {
  ExecutionContext,
  ExecutionEvent,
  TimelineEvent,
} from "./executor.js";

/** Per-run metadata (git sha, hostname, versions, timestamp). */
export { buildRunContext } from "./run_context.js";

/** Config helpers — callers use `LOCAL_RUN_DEFAULTS` as the base shape. */
export {
  LOCAL_RUN_DEFAULTS,
  normalizePositiveTimeoutMs,
  toSingleExecutionOptions,
} from "./config.js";
export type { SharedRunConfig } from "./config.js";

/** Session lifecycle orchestration (used by CLI pre-RF-1b). */
export {
  createContextWithSession,
  discoverSessionFile,
  RunOrchestrator,
} from "./orchestrator.js";

/** Threshold metric accumulation + evaluation. */
export { evaluateThresholds, MetricCollector } from "./thresholds.js";

/** Test discovery helper; VSCode extension uses it to extract tests from a module. */
export { resolveModuleTests } from "./resolve.js";
