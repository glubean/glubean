import type { ContractCaseRef } from "../contract-types.js";
import type { TestContext } from "../types.js";

/**
 * Glubean vNext `workflow` — types for the shared runtime node graph + its
 * projection. See `internal/40-discovery/proposals/contract-workflow-vnext.md`
 * and `~/.claude/plans/sdk-3-api-snuggly-blossom.md`.
 *
 * GOVERNING PRINCIPLE (2026-06-09): no backward compatibility. This module is a
 * fresh, self-consistent surface; legacy `contract.flow()` / `test()` builder
 * paths will be `@deprecated` and deleted before release. Learn from them, do
 * not preserve them.
 */

/**
 * Per-node projection quality (proposal §7). NOT an admission gate — every node
 * executes; the grade only reports how much Glubean can project.
 *
 * - `full`    — statically projectable (declared lens / declarative predicate).
 * - `partial` — human-readable hints exist, logic unknown (`reads`/`writes`/`asserts`/`note`).
 * - `trace`   — statically opaque BUT emitted structured runtime evidence; a
 *               RUNTIME promotion of an otherwise-opaque node.
 * - `opaque`  — only name / result known.
 *
 * The STATIC floor a projector can assign before running is `full | partial |
 * opaque`; `trace` is decided at run time from emitted evidence (codex R1:
 * evidence-emission is orthogonal to sync/async, so it can't be a static label).
 */
export type ProjectionGrade = "full" | "partial" | "trace" | "opaque";
export type StaticGrade = "full" | "partial" | "opaque";

/** Workflow-level metadata (set via `.meta()`); mirrors the shape of `FlowMeta`. */
export interface WorkflowMeta {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
  extensions?: Record<string, unknown>;
  /** Skip reason — discoverable for projection/docs but not executed. */
  skip?: string;
  /** Focus filter. */
  only?: boolean;
}

/** Projection hints for an opaque `.action()` (raise its grade to `partial`). */
export interface ActionProjection {
  reads?: string[];
  writes?: string[];
  note?: string;
}

/** Projection hints for an opaque `.check()` (raise its grade to `partial`). */
export interface CheckProjection {
  reads?: string[];
  asserts?: string;
}

/**
 * Per-NODE metadata. Every step can take metadata, exactly like `workflow(idOrMeta)`
 * at the top level — pass a string shorthand (becomes the node `id`) or a full
 * object. `id` is the stable node identity (evidence addressing, projection, agent
 * repair); `name` is display (defaults to `id`).
 */
export interface NodeMeta {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
  extensions?: Record<string, unknown>;
}

/** First-arg of every step: a string id shorthand, or a full `NodeMeta`. */
export type NodeMetaInput = string | (Partial<NodeMeta> & { id?: string });

// ---------------------------------------------------------------------------
// Runtime node graph (the single IR both `workflow()` and — later — legacy
// lowering target). Nodes carry live fns/refs; the executor walks them and the
// projector (project.ts) derives the JSON-safe graded view.
// ---------------------------------------------------------------------------

/** Use a reusable contract interaction. Grade `full` when in/out are pure lenses. */
export interface ContractCallNode<State = any> {
  kind: "contract-call";
  meta: NodeMeta;
  ref: ContractCaseRef;
  /** Pure lens projecting workflow state → the case's logical input. */
  in?: (state: State) => unknown;
  /** Pure lens folding the response back into state. */
  out?: (state: State, res: any) => State;
  /** Accepted alternate outcome keys (e.g. HTTP statuses) to branch on. */
  accept?: ReadonlyArray<string | number>;
}

/** Arbitrary async state-producing glue. Grade `partial` w/ hints else `opaque`. */
export interface ActionNode<State = any> {
  kind: "action";
  meta: NodeMeta;
  fn: (ctx: TestContext, state: State) => State | void | Promise<State | void>;
  project?: ActionProjection;
}

/** Arbitrary assertion that may not map to a contract case. */
export interface CheckNode<State = any> {
  kind: "check";
  meta: NodeMeta;
  fn: (ctx: TestContext, state: State) => void | Promise<void>;
  project?: CheckProjection;
}

/** Pure synchronous state transform. */
export interface ComputeNode<State = any> {
  kind: "compute";
  meta: NodeMeta;
  fn: (state: State) => State;
}

// --- Forward-compat node kinds (in the IR from day one so the executor switch
// --- is exhaustive; the v1 BUILDER does not emit these — see plan fork (c) +
// --- phases 3/4). Intentionally minimal until their phase lands.

/** One-off protocol call not yet promoted to a contract (Phase 2). */
export interface InlineProtocolNode {
  kind: "inline-protocol";
  meta: NodeMeta;
  /** reserved — shaped when inline interactions ship (proposal §6.2). */
  reserved?: never;
}

/** Declarative or runtime branch (Phase 3). */
export interface BranchNode {
  kind: "branch";
  meta: NodeMeta;
  reserved?: never;
}

/** Bounded poll-until (Phase 3). */
export interface PollNode {
  kind: "poll";
  meta: NodeMeta;
  reserved?: never;
}

/** Grouping with its own execution/cleanup scope (Phase 4). */
export interface GroupNode {
  kind: "group";
  meta: NodeMeta;
  nodes: WorkflowNode[];
}

export type WorkflowNode =
  | ContractCallNode
  | ActionNode
  | CheckNode
  | ComputeNode
  | InlineProtocolNode
  | BranchNode
  | PollNode
  | GroupNode;

/** The node kinds the v1 builder can actually emit. */
export type V1WorkflowNodeKind = "contract-call" | "action" | "check" | "compute";

export type WorkflowSetup<State> = (ctx: TestContext) => State | Promise<State>;
export type WorkflowTeardown<State> = (
  ctx: TestContext,
  state: State,
) => void | Promise<void>;

/** A built workflow — the authored artifact the executor/projector consume. */
export interface Workflow<State = any> {
  readonly __glubean_type: "workflow";
  readonly meta: WorkflowMeta;
  readonly setup?: WorkflowSetup<any>;
  readonly teardown?: WorkflowTeardown<State>;
  readonly nodes: readonly WorkflowNode[];
}

// ---------------------------------------------------------------------------
// Projection (JSON-safe, graded) — what scanner / Cloud / agents read.
// ---------------------------------------------------------------------------

export interface ProjectedWorkflowNode {
  kind: WorkflowNode["kind"];
  /** Stable node identity (from NodeMeta.id). */
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
  extensions?: Record<string, unknown>;
  /** Static floor grade; the runtime may promote `opaque` → `trace`. */
  grade: StaticGrade;
  /** contract-call: protocol target (e.g. "POST /users"). */
  target?: string;
  /** contract-call: protocol id (http/grpc/graphql) — protocol-neutral identity. */
  protocol?: string;
  contractId?: string;
  caseKey?: string;
  /** contract-call: accepted alternate outcome keys the call site branches on. */
  accept?: ReadonlyArray<string | number>;
  /** action/compute dataflow hints. */
  reads?: string[];
  writes?: string[];
  /** check intent hint. */
  asserts?: string;
  /** action note. */
  note?: string;
  /** group children. */
  nodes?: ProjectedWorkflowNode[];
}

export interface WorkflowProjection {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
  /** Skip reason — discoverable so scanner/Cloud can honor a skipped workflow. */
  skip?: string;
  /** Focus filter. */
  only?: boolean;
  extensions?: Record<string, unknown>;
  nodes: ProjectedWorkflowNode[];
  /** Count of node static grades (rollup for the workflow-level summary, §7.2). */
  gradeSummary: Record<StaticGrade, number>;
}
