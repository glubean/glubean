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
export type {
  FileScheduleEntry,
  OrchestratorOptions,
  SessionLifecycleEvent,
  SessionState,
} from "./orchestrator.js";
