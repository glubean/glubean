/**
 * Glubean vNext `workflow` — public surface (Phase 1).
 *
 * No backward compatibility (2026-06-09): a fresh, self-consistent authoring
 * model. See `internal/40-discovery/proposals/contract-workflow-vnext.md`.
 */
export * from "./types.js";
export { workflow } from "./builder.js";
export type {
  WorkflowBuilder,
  TerminalWorkflowBuilder,
  CallBindings,
  BranchOpts,
  SwitchOpts,
  RouteOpts,
  StrictSide,
  PollOpts,
  PollOptsWithInput,
  PollUntil,
  PollBounds,
} from "./builder.js";
export { projectWorkflow } from "./project.js";
// The workflow executor (`runWorkflow` + the node-scope ALS / `__activeWorkflowNodeCtx`)
// lives in @glubean/runner (node-only) as of plan 0007 — it is execution semantics,
// not authoring DSL, and it drags node:async_hooks. The SDK exports only the authoring
// surface + projection here; the host owns execution. `validateRetryMeta` (shared
// authoring/run validation) lives in ./retry.js, bridged via @glubean/sdk/internal.
