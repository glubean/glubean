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
  CallBindings,
  BranchOpts,
  PollOpts,
  PollOptsWithInput,
  PollUntil,
  PollBounds,
} from "./builder.js";
export { projectWorkflow } from "./project.js";
