import type { ContractCaseRef } from "../contract-types.js";
import type { TestContext } from "../types.js";
import type {
  BranchPredicate,
  ExtractedPredicate,
  OpaquePredicate,
} from "../contract-flow-condition.js";

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

/**
 * The `ctx` every workflow node body (setup / action / check / teardown)
 * receives: a `TestContext` plus a per-node `AbortSignal` (§17 #12). The signal
 * fires when the node times out or fails; cooperative bodies and protocol
 * adapters observe it to bail early. Because arbitrary async cannot be force
 * cancelled, the real guarantee is not cancellation but QUARANTINE: any evidence
 * a body emits AFTER its node has settled is dropped, never reaching the run
 * (so a body that ignores `signal` still cannot leak late assertions/traces).
 */
export interface WorkflowContext extends TestContext {
  /** Per-node abort signal — fires on this node's timeout/failure (§17 #12). */
  readonly signal: AbortSignal;
}

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
  fn: (ctx: WorkflowContext, state: State) => State | void | Promise<State | void>;
  project?: ActionProjection;
}

/** Arbitrary assertion that may not map to a contract case. */
export interface CheckNode<State = any> {
  kind: "check";
  meta: NodeMeta;
  fn: (ctx: WorkflowContext, state: State) => void | Promise<void>;
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

/**
 * 2-way branch (proposal §6.6). Runs ONLY the taken side's nodes; the non-taken
 * side is emitted as `skipped` (§17 #6, first-match). The predicate reuses the flow
 * condition model: an L2 declarative `BranchPredicate` (statically projectable →
 * grade `full`) or an L1/L0 `OpaquePredicate` (runtime → grade `opaque`).
 */
export interface BranchNode<State = any> {
  kind: "branch";
  meta: NodeMeta;
  /** Taken side selected by this predicate (L2 declarative, or L1/L0 opaque). */
  when: BranchPredicate<State> | OpaquePredicate;
  /** Author label — required for opaque predicates (projection / diagnostics). */
  message?: string;
  /** Nodes run when `when` holds. */
  then: WorkflowNode[];
  /** Nodes run otherwise (absent = empty else). */
  else?: WorkflowNode[];
}

/**
 * Opaque poll exit predicate (`untilRuntime`) — gets the per-node ctx, the raw
 * attempt response, AND the workflow state (so a poll can wait for the response
 * to reflect something already in state, e.g. `res.version >= state.lastSeen`).
 * Like branch `whenRuntime`, the builder cannot statically prove synchronicity,
 * so it is stored conservatively as L0 (`sync: false`); the runtime awaits it
 * either way and rejects non-boolean results.
 */
export interface PollOpaqueUntil<State = any> {
  kind: "opaque";
  sync: boolean;
  fn: (ctx: WorkflowContext, res: any, state: State) => boolean | Promise<boolean>;
}

/**
 * Bounded poll-until (proposal §6.7, §17 #3): repeat ONE contract case until an
 * exit predicate over the RESPONSE holds, bounded by a total wall-clock deadline
 * and/or a finite per-attempt budget (validated at build time — a poll can never
 * be unbounded). Attempt evidence is QUARANTINED per §17 #3: a probe's assertion
 * noise and a timed-out orphan's late failures are discarded; the satisfying
 * attempt and any in-budget deliberate failure are flushed. The poll node owns
 * its own bounds (§17 #4) — it does not take the generic per-node timeout.
 */
export interface PollNode<State = any> {
  kind: "poll";
  meta: NodeMeta;
  ref: ContractCaseRef;
  /** Pure lens projecting workflow state → the case's logical input. */
  in?: (state: State) => unknown;
  /** Pure lens folding the SATISFYING response back into state (probes discarded). */
  out?: (state: State, res: any) => State;
  /** Accepted alternate outcome keys (e.g. HTTP statuses) — poll-on-status needs this. */
  accept?: ReadonlyArray<string | number>;
  /** Exit predicate — L2 declarative over the response (grade `full`) or opaque (`opaque`). */
  until: BranchPredicate<any> | PollOpaqueUntil<State>;
  /** Author label — required for opaque predicates (projection / diagnostics). */
  message?: string;
  /** Interval between attempts (ms); builder defaults it. */
  every: number;
  /** Multiplier applied to the interval after each attempt (1 = fixed); builder defaults it. */
  backoff: number;
  /** Total wall-clock bound (ms). */
  timeoutMs?: number;
  /** Per-attempt budget (ms) — required when `timeoutMs` is absent. */
  perAttemptTimeoutMs?: number;
  /** Max attempts (>= 1). */
  maxAttempts?: number;
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
export type V1WorkflowNodeKind =
  | "contract-call"
  | "action"
  | "check"
  | "compute"
  | "branch"
  | "poll";

export type WorkflowSetup<State> = (ctx: WorkflowContext) => State | Promise<State>;
/**
 * Cleanup — ALWAYS runs (§17 #1), even when setup threw. On a setup failure the
 * graph never produced a state, so `state` is `undefined` and `cause` carries the
 * error that aborted the run (otherwise `undefined`). A teardown that itself
 * throws is logged and NEVER masks the primary `cause`.
 */
export type WorkflowTeardown<State> = (
  ctx: WorkflowContext,
  state: State | undefined,
  cause?: unknown,
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
  /** branch: the extracted predicate — an L2 declarative tree, or an opaque marker. */
  when?: ExtractedPredicate;
  /** branch/poll: author label (required for opaque predicates). */
  message?: string;
  /** branch: projected `then` / `else` side nodes (only the taken side runs at runtime). */
  then?: ProjectedWorkflowNode[];
  else?: ProjectedWorkflowNode[];
  /** poll: the extracted exit predicate — L2 declarative over the response, or opaque. */
  until?: ExtractedPredicate;
  /** poll bounds (every/backoff always present; the rest as authored). */
  every?: number;
  backoff?: number;
  timeoutMs?: number;
  perAttemptTimeoutMs?: number;
  maxAttempts?: number;
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
