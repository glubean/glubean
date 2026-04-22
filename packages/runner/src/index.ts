export { generateSummary, TestExecutor } from "./executor.js";
export { buildRunContext } from "./run_context.js";
export type {
  EventHandler,
  ExecutionBatchResult,
  Summary,
  ExecutionContext,
  ExecutionEvent,
  ExecutionOptions,
  ExecutionResult,
  ExecutorOptions,
  SingleExecutionOptions,
  TimelineEvent,
} from "./executor.js";

export {
  LOCAL_RUN_DEFAULTS,
  normalizePositiveTimeoutMs,
  SHARED_RUN_DEFAULTS,
  toExecutionOptions,
  toSingleExecutionOptions,
  WORKER_RUN_DEFAULTS,
} from "./config.js";
export type { SharedRunConfig } from "./config.js";

export {
  autoResolve,
  findTestByExport,
  findTestById,
  isEachBuilder,
  isTest,
  isTestBuilder,
  resolveModuleTests,
} from "./resolve.js";
export type { ResolvedTest } from "./resolve.js";

export { aggregate, evaluateThresholds, MetricCollector, parseExpression } from "./thresholds.js";

export {
  buildExecutionOrder,
  collectSessionUpdates,
  createContextWithSession,
  discoverSessionFile,
  RunOrchestrator,
} from "./orchestrator.js";

// Plugin bootstrap — locates and imports `glubean.setup.ts` so plugin
// registrations run before test execution / scanner dynamic imports.
// Must be awaited at the top of any entry point that observes plugin state.
export { bootstrap, discoverSetupFile } from "./bootstrap.js";

// Canonical project-env loader. CLI / MCP / VSCode all route through this
// to get {vars, secrets} with `${NAME}` expansion.
export { loadEnvFile, loadProjectEnv, expandVars } from "./env.js";
export type { ProjectEnv } from "./env.js";

// ProjectRunner facade — single top-level API for "run the tests of a project".
// Wraps loadProjectEnv + bootstrap + RunOrchestrator + TestExecutor loop into
// one coherent pipeline with a typed event stream. CLI / MCP / VSCode all
// consume it rather than re-assembling primitives.
export { ProjectRunner } from "./project-runner.js";
export type { ProjectRunEvent, ProjectRunnerOptions, ProjectRunnerTest } from "./project-runner.js";
export type {
  FileScheduleEntry,
  OrchestratorOptions,
  SessionLifecycleEvent,
  SessionState,
} from "./orchestrator.js";
