/**
 * `@glubean/sdk/load` — first-class single-node load testing.
 *
 * Authoring surface for performance transactions (`loadScenario()`) and the
 * pressure plans that execute them (`loadRunner()`). This subpath intentionally
 * stays separate from the main `@glubean/sdk` entry so ordinary test authoring
 * is not widened by load-only concepts.
 *
 * Boundary:
 *   contract() / workflow() / test() = correctness + evidence
 *   loadScenario()                   = a repeatable performance transaction
 *   loadRunner()                     = how much pressure to apply
 *
 * NOTE (M1): this is the static authoring surface only. Actual load execution
 * lives in @glubean/runner and ships in later milestones.
 */
export type {
  LoadContext,
  LoadProducerSlot,
  LoadIteration,
  LoadReportSignal,
  LoadPrimaryCompletionReceipt,
  LoadOmittedContextKeys,
} from "./context.js";

export type {
  LoadStepOptions,
  LoadAssertionFailureMode,
  LoadSetupFunction,
  LoadStepFunction,
  LoadTeardownFunction,
} from "./step.js";

export { loadScenario, LoadBuilder } from "./builder.js";

export { isLoadBranchStep, isLoadPollStep } from "./scenario.js";

export type {
  LoadScenario,
  LoadScenarioMeta,
  LoadStepMeta,
  LoadStepDefinition,
  LoadBranchData,
  LoadPollData,
  LoadConditionSpec,
  LoadPollOpts,
  LoadFragmentBuilder,
} from "./scenario.js";

export { loadRunner, loadMixEntry } from "./runner.js";

export type {
  LoadPlan,
  LoadRunnerConfig,
  LoadMixConfig,
  LoadMixEntry,
  AnyLoadRunnerConfig,
  LoadInputOption,
  LoadInputArgs,
  LoadDuration,
  LoadContinuationConfig,
  LoadPacingConfig,
  LoadHttpConfig,
  LoadThresholds,
  LoadThresholdScope,
  LoadCustomMetricThresholdScope,
  LoadReportConfig,
  LoadScenarioRef,
  LoadProducerSlotInfo,
  LoadIterationInfo,
} from "./runner.js";

export { rate, trend, counter } from "./metrics.js";

export type {
  LoadMetricKind,
  LoadMetricDescriptor,
  LoadMetricDeclarations,
  LoadMetricTags,
  LoadMetricHandle,
  LoadMetricHandles,
} from "./metrics.js";

export { projectLoadPlan } from "./projection.js";
export type { LoadProjection, LoadScenarioRefProjection } from "./projection.js";

export { parseDurationMs } from "./duration.js";

export type * from "./artifact.js";

export type {
  LoadEvent,
  LoadEventEnvelope,
  LoadEventOf,
  LoadEndReason,
  LoadRouteKeySource,
  LoadResolvedConfig,
} from "./events.js";

export type {
  LoadReducer,
  LoadProgressSnapshot,
  LoadFailureSummary,
} from "./progress.js";

export { feeder } from "./feeder.js";

export type {
  FeederBinding,
  FeederSource,
  FeederSourceOptions,
  FeederStrategy,
  ExhaustedPolicy,
  FeederStrategyOptions,
  WeightedRandomOptions,
  FeederDrawContext,
  FeederDraw,
} from "./feeder.js";
