import type { ContractCaseRef } from "../contract-types.js";
import type { Test, TestContext } from "../types.js";
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
  /** Data-driven member's un-interpolated template id (set by workflow.each/
   * pick on EVERY member — the shared-structure marker, addendum §3). */
  templateId?: string;
  /** Trace-grouping id (set for parallel matrices — mirrors test.each). */
  groupId?: string;
  /** Members of the same group may run in parallel (workflow.each option). */
  parallel?: boolean;
}

/**
 * Explicit-intent retry (§17 #7) — `call` + `action` ONLY (never check/compute:
 * a `check` failure must never replay a prior action's side effect). NOT a blind
 * `retries` knob: `reason` is REQUIRED and documents WHY replay is safe —
 * idempotency is the author's responsibility. Every attempt stays VISIBLE
 * (attempt-stamped node_start/node_end brackets, traces, a retry log line), but
 * the run's pass/fail COUNTERS belong to the final, verdict-deciding attempt
 * only — a non-final failed attempt's assert/validate counts are dropped, so a
 * retried-and-passed node cannot fail the host run (mirrors the shipped step
 * retry's per-attempt counter reset). A node `timeout` is TERMINAL and is never
 * retried (§17 #4); a `ctx.skip()` is control flow and is never retried either.
 */
export interface RetryMeta {
  /** Total attempts, an integer >= 2 (1 attempt is "no retry" — omit `retry`). */
  attempts: number;
  /** Delay between attempts (ms, finite >= 0). Default 0. */
  delay?: number;
  /** REQUIRED statement of why replay is safe (e.g. "GET is idempotent"). */
  reason: string;
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
  /**
   * Per-node TERMINAL timeout in ms (§17 #4): the node is aborted (its signal
   * fires, late evidence is quarantined) and NEVER retried — a timeout wins
   * over `retry`. Accepted on the ASYNC node kinds (call / action / check);
   * rejected on `compute` (synchronous by contract) and `poll` (owns its own
   * bounds: timeout/perAttemptTimeout/maxAttempts).
   */
  timeout?: number;
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
  /** Explicit-intent retry (§17 #7). */
  retry?: RetryMeta;
}

/** Arbitrary async state-producing glue. Grade `partial` w/ hints else `opaque`. */
export interface ActionNode<State = any> {
  kind: "action";
  meta: NodeMeta;
  fn: (ctx: WorkflowContext, state: State) => State | void | Promise<State | void>;
  project?: ActionProjection;
  /** Explicit-intent retry (§17 #7). */
  retry?: RetryMeta;
}

/**
 * Assertion node — two forms (phase4 §7 / addendum §2):
 * - INLINE: arbitrary fn (grade: partial with `project.asserts`, else opaque;
 *   runtime evidence may promote to trace).
 * - DECLARATIVE: `expects` — L2 predicates over state; assertions are DATA
 *   (grade: full; each item projects and emits its own assertion event).
 */
export type CheckNode<State = any> = {
  kind: "check";
  meta: NodeMeta;
} & (
  | {
      fn: (ctx: WorkflowContext, state: State) => void | Promise<void>;
      expects?: undefined;
      project?: CheckProjection;
    }
  | {
      fn?: undefined;
      /** Declarative form: live L2 predicates (extracted at projection time). */
      expects: ReadonlyArray<BranchPredicate<State>>;
      /** hints belong to the inline form — the declarative form IS the data. */
      project?: undefined;
    }
);

/** Pure synchronous state transform. */
export interface ComputeNode<State = any> {
  kind: "compute";
  meta: NodeMeta;
  fn: (state: State) => State;
  /**
   * Dataflow, auto-traced at BUILD time via the proxy dry-run
   * (`traceComputeFn` — the same tracer flow's normalizer uses). The body's
   * transform logic is inherently not declarable, which is why compute
   * grades `partial`, never `full` (S2.18 lens-purity).
   *
   * ABSENT (not empty) when tracing degraded: a value-sensitive helper
   * (`new URL(state.url)`) may throw on the proxy's dummy values — that is
   * not an authoring error, so the build proceeds and the node grades
   * `opaque` instead (codex S2.18 R1 P2). Empty arrays mean "traced: no
   * dataflow" (e.g. the identity transform) — still `partial`.
   */
  reads?: string[];
  writes?: string[];
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

/** A JSON-scalar literal a value-mode case matches against (===). */
export type BranchCaseValue = string | number | boolean | null;

/** One case of the generalized branch family (addendum §9). */
export interface BranchCase {
  /** value mode: the JSON-scalar literal this case matches (=== on the `on` lens result). */
  value?: BranchCaseValue;
  /** predicate mode (incl. the 2-way `branch` sugar): this case's predicate.
   * L2 declarative, or — for `branch`'s `whenRuntime` only — an opaque fn. */
  when?: BranchPredicate<any> | OpaquePredicate;
  /** Display label: explicit, else derived (String(value) / "then" / "case-N"). */
  label?: string;
  nodes: WorkflowNode[];
}

/**
 * The branch FAMILY node (addendum §9 — supersedes the 2-way-only sketch).
 * One IR for all three authoring constructs, mirroring the flow IR's proven
 * cases[] extraction shape (Gate B canonical-hash rules: order preserved):
 *
 * - `.branch()` — 2-way converging sugar: mode "predicate", one case (then) +
 *   `default` (else).
 * - `.switch()` — N-way converging, heir of switchOn/switchCond: mode "value"
 *   (`on` lens + literal case table) XOR mode "predicate" (ordered L2
 *   first-match). `default` optional = identity pass-through.
 * - `.route()`  — N-way TERMINAL tree: same decision modes, `default`
 *   REQUIRED, `terminal: true` (no trunk continues; only teardown/build after).
 *
 * Runtime (§17 #6, all three): ONLY the taken case's nodes execute; every
 * non-taken case (and the un-taken default) is emitted `skipped`.
 */
export interface BranchNode<State = any> {
  kind: "branch";
  meta: NodeMeta;
  /** How the taken case is decided. */
  mode: "predicate" | "value";
  /**
   * value mode: the EXTRACTED selector path of the `on` lens (S2.18
   * lens-purity — the lens passes the same P0 gate as every predicate lens;
   * classification expressions are rejected at build). The RUNTIME also
   * dispatches via safe path resolution over this path — projection and
   * execution share one truth, the live function is not kept.
   */
  onPath?: readonly string[];
  /** Author label — required when a predicate is opaque (projection/diagnostics). */
  message?: string;
  /** Decision table — first-match (predicate) / ===-match (value). Order preserved. */
  cases: BranchCase[];
  /** Fallback: branch's else / switch's optional identity / route's REQUIRED default. */
  default?: WorkflowNode[];
  /** route: paths own their futures — after the taken case the workflow ends
   * (runNodeList stops; the builder allows only teardown/build after). */
  terminal?: boolean;
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
 * Inbound poll configuration (inbound-contract-design §9.3). `via` is a pure
 * lens from workflow state to the live ReceiverHandle; `correlate` pins the
 * INSTANCE (which run's event) — it lives on the poll because it references
 * run state. All lenses pass the selector-source gate at build time; their
 * extracted paths ride the projection (full grade — same trust as eqPath).
 */
export interface InboundPollSpec<State = any> {
  /** Lens: state → ReceiverHandle (validated structurally at run time). */
  via: (state: State) => unknown;
  /** Selector path of `via` (projection). */
  viaPath: readonly string[];
  correlate?: {
    /** Lens over the PARSED delivery body. */
    event: (event: any) => unknown;
    eventPath: readonly string[];
    /** Lens over workflow state. */
    state: (state: State) => unknown;
    statePath: readonly string[];
  };
  /**
   * The case's `expect.within` (ms) — evidence + the poll's default timeout,
   * NOT an independent failure condition (§9.4a #5).
   */
  withinMs?: number;
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
  /** Contract attempt (`.poll`): the polled case. XOR `attemptFn`. */
  ref?: ContractCaseRef;
  /**
   * Action attempt (`.pollAction`, addendum §4): an arbitrary async probe —
   * inbox.take(), DB read, queue peek. Runs under the attempt's QUARANTINED
   * ctx (probe noise discarded, §17 #3) with `ctx.signal` = the per-attempt
   * budget abort. Statically opaque, so the node's grade caps at `partial`
   * (an L2 `until` over the probed value) — §6.7's projection ladder.
   */
  attemptFn?: (ctx: WorkflowContext, state: State) => unknown | Promise<unknown>;
  /** pollAction: dataflow hints for the opaque attempt (projection only). */
  project?: ActionProjection;
  /** Pure lens projecting workflow state → the case's logical input. */
  in?: (state: State) => unknown;
  /** Pure lens folding the SATISFYING response back into state (probes discarded). */
  out?: (state: State, res: any) => State;
  /** Accepted alternate outcome keys (e.g. HTTP statuses) — poll-on-status needs this. */
  accept?: ReadonlyArray<string | number>;
  /**
   * Exit predicate — L2 declarative over the response (grade `full`) or
   * opaque (`opaque`). ABSENT exactly when `inbound` is set: an inbound
   * poll's exit IS the adapter matcher's `matched` classification
   * (inbound-contract-design §9.4a) — there is no response to predicate over.
   */
  until?: BranchPredicate<any> | PollOpaqueUntil<State>;
  /**
   * Inbound await configuration (design §9.3, slice I3) — present exactly
   * when `ref` points at a `direction: "inbound"` case. One attempt = one
   * pass over `via(state).deliveries()` through the adapter's
   * `matchInboundCase`, first terminal classification wins (§9.4a #4).
   */
  inbound?: InboundPollSpec<State>;
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

/**
 * A DISPLAY-ONLY grouping bracket (phase4 §2, owner decision 2026-06-12 —
 * "this was always meant as a visualization capability"): members execute
 * exactly as if the wrapper were absent; no own lifecycle/scope. Summary
 * counts members, never the container.
 */
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
  | "poll"
  | "group";

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
  /** Terminal timeout for setup (ms, §17 #4) — a timed-out setup fails the run. */
  readonly setupTimeoutMs?: number;
  /** Natural-language hint: what setup does (phase4 §6 — a DECLARATION, the
   * same trust tier as action hints; lifecycle is otherwise the one opaque
   * position with no outlet). */
  readonly setupNote?: string;
  readonly teardown?: WorkflowTeardown<State>;
  /** Terminal timeout for teardown (ms, §17 #4) — logged, never masks the cause. */
  readonly teardownTimeoutMs?: number;
  /** Natural-language hint: what teardown does (phase4 §6). */
  readonly teardownNote?: string;
  readonly nodes: readonly WorkflowNode[];
}

/**
 * What `workflow(...).build()` actually returns (S2.5 discovery): the Workflow
 * IR fields AND a one-element `Test[]` whose simple test executes the graph via
 * `runWorkflow` — the same array-handle shape as `contract.flow()`'s
 * FlowContract, so the runner's existing array/`isTest` resolution discovers
 * and executes it with no special casing. `runWorkflow`/`projectWorkflow`
 * consume it directly (it IS a `Workflow`).
 *
 * `_projection` carries the pre-computed JSON-safe graded projection (the same
 * object registered on `RegisteredTestMeta.workflow`) so dep-free consumers —
 * the scanner's runtime extractor, mirroring `FlowContract._extracted` — read
 * it off the handle without importing the SDK to call `projectWorkflow` (S2.6).
 */
export type BuiltWorkflow<State = any> = Workflow<State> &
  ReadonlyArray<Test> & { readonly _projection: WorkflowProjection };

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
  /** branch family: how the taken case is decided (addendum §9). */
  mode?: "predicate" | "value";
  /** branch family: the projected decision table (order preserved). Only the
   * taken case runs at runtime; the rest are reported skipped (§17 #6). */
  cases?: Array<{
    label?: string;
    value?: BranchCaseValue;
    when?: ExtractedPredicate;
    nodes: ProjectedWorkflowNode[];
  }>;
  /** branch family: fallback nodes (branch's else / switch identity / route default). */
  default?: ProjectedWorkflowNode[];
  /** route: terminal — no trunk continues after the taken case. */
  terminal?: boolean;
  /** branch/poll: author label (required for opaque predicates). */
  message?: string;
  /** compute: build-time proxy-traced dataflow (S2.18). `reads` are
   * `state.<path>` strings; `writes` are top-level result keys. */
  // (reads/writes fields are shared with action above.)
  /** branch (value mode): the extracted selector path of `on` (S2.18). */
  onPath?: string[];
  /** branch family: present (always `"identity"`) when NO default subtree is
   * declared — absent-default means "pass through unchanged", and projecting
   * that explicitly stops consumers reading absence as "unknown" (S2.18,
   * codex consult). Route never carries it (default is required there). */
  defaultBehavior?: "identity";
  /** poll: the extracted exit predicate — L2 declarative over the response, or
   * opaque. ABSENT on inbound polls (matched IS the exit — see `inbound`). */
  until?: ExtractedPredicate;
  /** poll (inbound, design §9.3): the await declaration — gated lens paths +
   * the case's `within` promise. Presence marks the poll as inbound. */
  inbound?: {
    viaPath: string[];
    correlate?: { eventPath: string[]; statePath: string[] };
    withinMs?: number;
  };
  /** poll bounds (every/backoff always present; the rest as authored). */
  every?: number;
  backoff?: number;
  timeoutMs?: number;
  perAttemptTimeoutMs?: number;
  maxAttempts?: number;
  /** call/action: explicit-intent retry (§17 #7) — intent is projectable. */
  retry?: RetryMeta;
  /** check (declarative form, phase4 §7): the extracted L2 predicates —
   * assertions as DATA, individually renderable/auditable. */
  expects?: ExtractedPredicate[];
  /** call/action/check: per-node terminal timeout (§17 #4). (Poll's own
   * bounds already project via timeoutMs/perAttemptTimeoutMs/maxAttempts.) */
  nodeTimeoutMs?: number;
}

export interface WorkflowProjection {
  id: string;
  /** Data-driven member (workflow.each/pick): the un-interpolated template id.
   * All rows share ONE projected structure — only id/name/tags vary — so a
   * canonical hash over the structure is identical across rows (addendum §3:
   * one version × N runs). */
  templateId?: string;
  /** Trace-grouping id (parallel matrices — mirrors test.each). */
  groupId?: string;
  /** Members of this group may run in parallel (drives runner concurrency). */
  parallel?: boolean;
  name?: string;
  description?: string;
  tags?: string[];
  /** Skip reason — discoverable so scanner/Cloud can honor a skipped workflow. */
  skip?: string;
  /** Focus filter. */
  only?: boolean;
  extensions?: Record<string, unknown>;
  /**
   * Lifecycle visibility (phase4 §6): object presence ⟺ the workflow declares
   * that phase. NOT a node — never joins gradeSummary/node counts; a render
   * layer may style a noteless lifecycle as opaque-looking, but that is
   * presentation. Before this, setup/teardown were ZERO information to
   * Cloud/agents (the receiver glue in a webhook journey — typically the most
   * opaque code in the whole test — was simply invisible).
   */
  setup?: { note?: string; timeoutMs?: number };
  teardown?: { note?: string; timeoutMs?: number };
  nodes: ProjectedWorkflowNode[];
  /** Count of node static grades (rollup for the workflow-level summary, §7.2). */
  gradeSummary: Record<StaticGrade, number>;
}
