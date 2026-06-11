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
// Host integration point: @glubean/runner's http hooks attribute auto-traces
// to the active workflow node's scope (the ctx.http rebind, S2.10).
export { __activeWorkflowNodeCtx } from "./execute.js";
