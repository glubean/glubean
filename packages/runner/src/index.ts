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

/**
 * Programmatic single-case runner mirroring CLI `--input-json` /
 * `--bootstrap-json` / `--force-standalone` and MCP `glubean_run_local_file`'s
 * runner-input parameters. See attachment-model §8.
 */
export { runCase } from "./run-case.js";
export type { RunCaseOptions, RunCaseResult } from "./run-case.js";

/**
 * `{{VAR}}` env templating for runner-supplied inputs (§8). Used
 * internally by CLI / MCP / `runCase` to interpolate before schema
 * validation. Exposed for embedders that pre-process inputs themselves.
 */
export { applyEnvTemplating } from "./runner-input-templating.js";

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

/**
 * The `{id, rowIndex}` "only" selector protocol (B2 M3). Shared shape + matching
 * with the cloud-vendored harness; the CLI builds selectors and the harness
 * consumes them via GLUBEAN_RUNNER_ONLY_SELECTORS.
 */
export { normalizeSelectors, matchOnly, collectFailedSelectors } from "./selector.js";
export type { OnlySelector } from "./selector.js";

/**
 * Workflow executor entry. A built `workflow()` is a DEF the host runs (plan 0007
 * invocation inversion); `runWorkflow(ir, ctx)` drives the graph and returns the
 * verdict. The harness uses it internally; it's exported here so adapter packages
 * (graphql/grpc) can exercise a contract call THROUGH a workflow in their tests.
 */
export { runWorkflow } from "./workflow/execute.js";
export type { WorkflowRunResult, WorkflowNodeOutcome } from "./workflow/execute.js";

// =============================================================================
// 4. Load runner (closed-model performance plans)
// =============================================================================

/**
 * Run a `loadRunner()` plan locally through the closed-model orchestrator and
 * return its finalized `LoadArtifact` (concurrency producer slots + feeder /
 * session / pacing / thresholds). The `glubean load` command drives this; the
 * `LoadArtifact` / `LoadPlan` types live in `@glubean/sdk/load`.
 */
export { runLoad } from "./load/orchestrator.js";
export type { RunLoadOptions } from "./load/orchestrator.js";

/**
 * Run a single `.load.ts` file's plans in a child process so the harness and the
 * user file co-resolve one `@glubean/sdk` (no in-process split-brain). The
 * `glubean load` command drives this; `collectLoadPlans` / `withProcessEnvFallback`
 * are the shared helpers the child `load-harness` uses.
 */
export {
  runLoadFileInSubprocess,
  collectLoadPlans,
  withProcessEnvFallback,
} from "./load/subprocess.js";
export type {
  RunLoadFileOptions,
  RunLoadFileResult,
  LoadSubprocessOutcome,
  LoadSubprocessError,
  LoadHarnessMessage,
} from "./load/subprocess.js";

/**
 * Dry-run shape projection (C2 / P2) — execute a simple test's body against a
 * synthetic context to capture what it verifies (assertions) and touches
 * (endpoints) without real I/O. `dryRunTest` projects a single in-memory Test;
 * `dryRunFiles` spawns a tsx worker to project every simple test in a set of
 * `.test.ts` files. Powers `glubean dry-run` → cloud team-review view.
 */
export { dryRunTest } from "./dry-run.js";
export type { TestShape, ProjAssertion, ProjEndpoint } from "./dry-run.js";
export { dryRunFiles } from "./dry-run-spawn.js";
export type { DryRunFilesResult } from "./dry-run-spawn.js";
