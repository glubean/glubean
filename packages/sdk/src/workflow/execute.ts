/**
 * @module workflow/execute
 *
 * vNext `workflow` EXECUTOR — the per-node runtime harness.
 *
 * GOVERNING PRINCIPLE (2026-06-09): no backward compatibility. Where `runFlow`
 * (`contract-core.ts`) and the `test()` harness (`packages/runner`) diverge, this
 * executor picks the ONE rule decided in the proposal §17 self-consistency corpus
 * and every node obeys it. See `internal/40-discovery/proposals/contract-workflow-vnext.md`.
 *
 * This slice (S2.0) builds the foundation every later node type stands on:
 *   - a per-node derived child ctx (`makeNodeScope`) that attributes evidence to
 *     the node, tracks its pass/fail + structured-evidence emission, and — after
 *     the node settles — QUARANTINES any late evidence the body still emits (§17 #12);
 *   - `runNode`: brackets the node with `workflow:node_start` / `:node_end`
 *     events, runs the body under a per-node `AbortController`, and enforces a
 *     TERMINAL per-node timeout (no retry; §17 #4) that aborts the node (§17 #12).
 *
 * On top of it: `runWorkflow` walks setup → nodes → teardown (S2.1); `runBranch`
 * runs only the taken side (S2.4a, §17 #6); `runPollNode` is the bounded
 * poll-until with per-attempt quarantine (S2.4b, §17 #3). Control-flow nodes
 * (branch/poll) own their bracket/bounds and are dispatched by `runNodeList`,
 * not `runNode`; remaining reserved kinds throw "not implemented yet".
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AssertionDetails,
  AssertionResultInput,
  GlubeanAction,
  GlubeanEvent,
  SchemaLike,
  TestContext,
  Trace,
  ValidateOptions,
} from "../types.js";
import { GlubeanSkipError } from "../types.js";
import { Expectation } from "../expect.js";
import { getAdapter, validateNeedsOutput } from "../contract-core.js";
import { evalPredicate, extractPredicate, resolvePath } from "../contract-flow-condition.js";
import type { ExtractedPredicate } from "../contract-flow-condition.js";
import type { BranchPredicate, OpaquePredicate } from "../contract-flow-condition.js";
import {
  quarantinedCtx,
  raceBudget,
  validatePollBounds,
  PollExhaustedError,
  BACKOFF_CAP_MS,
  DEFAULT_EVERY_MS,
} from "../contract-flow-poll.js";
import { staticGradeOf } from "./project.js";
import type {
  ActionNode,
  GroupNode,
  BranchNode,
  CheckNode,
  ComputeNode,
  ContractCallNode,
  NodeMeta,
  PollNode,
  PollOpaqueUntil,
  ProjectionGrade,
  RetryMeta,
  StaticGrade,
  Workflow,
  WorkflowContext,
  WorkflowNode,
} from "./types.js";

/**
 * Human-readable label for a declarative expect item (phase4 §7.2) — derived
 * from the extracted predicate, never authored, so it cannot drift from what
 * actually evaluates. Used for assertion-event messages.
 */
export function predicateLabel(p: ExtractedPredicate): string {
  switch (p.kind) {
    case "compare": {
      const OPS: Record<string, string> = { eq: "==", ne: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" };
      const lhs = p.path.join(".") || "<state>";
      const rhs = p.rhsPath !== undefined ? p.rhsPath.join(".") : JSON.stringify(p.value);
      return `${lhs} ${OPS[p.op] ?? p.op} ${rhs}`;
    }
    case "in":
      return `${p.path.join(".")} in ${JSON.stringify(p.values)}`;
    case "presence":
      return `${p.path.join(".")} ${p.op}`;
    case "matches":
      return `${p.path.join(".")} matches /${p.pattern}/${p.flags ?? ""}`;
    case "and":
      return p.clauses.map(predicateLabel).join(" && ");
    case "or":
      return `(${p.clauses.map(predicateLabel).join(" || ")})`;
    case "not":
      return `not(${predicateLabel(p.clause)})`;
    case "opaque":
      return "<opaque predicate>";
  }
}

// =============================================================================
// Active-node context channel (§17 #9/#12 — the ctx.http rebind, S2.10)
// =============================================================================

/**
 * The per-node child ctx of the CURRENTLY EXECUTING workflow node body.
 *
 * The host harness pre-binds `ctx.http`'s auto-trace/metric hooks to the
 * test-level ctx at construction, so inline HTTP inside a workflow node used
 * to bypass the node scope entirely — no attribution (an opaque HTTP action
 * never promoted to `trace`, §17 #10) and no late-evidence quarantine
 * (§17 #12). The executor now runs every node body inside this
 * AsyncLocalStorage scope; the harness's hooks ask for the active node ctx
 * FIRST and fall back to their own closure ctx (non-workflow tests see no
 * behavior change).
 */
const activeNodeCtx = new AsyncLocalStorage<TestContext>();

/**
 * Host integration point (used by @glubean/runner's http hooks): the ctx that
 * observability emitted DURING a workflow node body should be attributed to,
 * or undefined outside any workflow node.
 */
export function __activeWorkflowNodeCtx(): TestContext | undefined {
  return activeNodeCtx.getStore();
}

/** Run a node body (or attempt/decision) attributed to `ctx`. */
function withActiveNodeCtx<T>(ctx: TestContext, fn: () => T): T {
  return activeNodeCtx.run(ctx, fn);
}

// =============================================================================
// Per-node evidence events (§17 #9)
// =============================================================================

/**
 * Per-node boundary events ride the generic `ctx.event` channel for this slice
 * (zero runner-package change — they reach the timeline as namespaced
 * `GlubeanEvent`s). S2.5 decides whether to promote them to first-class
 * `node_start` / `node_end` event kinds for richer Cloud rendering.
 */
export const NODE_START_EVENT = "workflow:node_start";
export const NODE_END_EVENT = "workflow:node_end";

export type NodeStatus = "passed" | "failed" | "skipped";

export interface NodeStartEventData {
  nodeId: string;
  kind: WorkflowNode["kind"];
  name: string;
  /** Set on a retrying node (§17 #7): which attempt this bracket is (1-based). */
  attempt?: number;
  /** Set on a retrying node (§17 #7): the configured total attempts. */
  attempts?: number;
  [k: string]: unknown;
}

export interface NodeEndEventData {
  nodeId: string;
  kind: WorkflowNode["kind"];
  name: string;
  status: NodeStatus;
  /** Runtime grade after evidence promotion (§17 #10). */
  grade: ProjectionGrade;
  durationMs: number;
  error?: string;
  /** Set on a retrying node (§17 #7): which attempt this bracket is (1-based). */
  attempt?: number;
  /** Set on a retrying node (§17 #7): the configured total attempts. */
  attempts?: number;
  [k: string]: unknown;
}

// =============================================================================
// Timeout (§17 #4 — terminal, never retried) + abort (§17 #12)
// =============================================================================

/** A node exceeded its `timeout`. TERMINAL — the node is not retried (§17 #4). */
export class NodeTimeoutError extends Error {
  readonly nodeId: string;
  readonly timeoutMs: number;
  constructor(nodeId: string, timeoutMs: number) {
    super(`workflow node "${nodeId}" timed out after ${timeoutMs}ms`);
    this.name = "NodeTimeoutError";
    this.nodeId = nodeId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A workflow phase (setup, or a node) FAILED via soft assertions/validation —
 * nothing was thrown, so `runNode` has no `error` to report. The executor
 * synthesizes this as the run's `cause` so teardown + the result carry a
 * non-empty failure even for the pure soft-failure path (codex S2.1 P2).
 */
export class WorkflowPhaseFailedError extends Error {
  readonly workflowId: string;
  readonly phase: string;
  constructor(workflowId: string, phase: string) {
    super(`workflow "${workflowId}" ${phase} failed (soft assertion/validation)`);
    this.name = "WorkflowPhaseFailedError";
    this.workflowId = workflowId;
    this.phase = phase;
  }
}

/**
 * A `compute` node returned a thenable — an async fn, or (the case the builder
 * can't catch) a sync fn that returns a Promise. compute MUST be synchronous and
 * I/O-free; the executor FAILS the node rather than committing the Promise as
 * state, so async/I/O can't masquerade as a `full` pure transform (§17 #11).
 */
export class ComputeAsyncError extends Error {
  readonly nodeId: string;
  constructor(nodeId: string) {
    super(
      `workflow compute "${nodeId}" returned a thenable — compute must be ` +
        `synchronous and I/O-free; use .action() for async work`,
    );
    this.name = "ComputeAsyncError";
    this.nodeId = nodeId;
  }
}

// =============================================================================
// Node scope — the per-node derived child ctx (§17 #9 / #10 / #12)
// =============================================================================

/**
 * A per-node child `TestContext` (+ `signal`). Sibling to `quarantinedCtx`
 * (`contract-flow-poll.ts`): same "derive with `Object.create`, override the
 * pass/fail APIs, pass observability through" technique, different policy —
 * evidence emits IMMEDIATELY while the node is live, then is DROPPED once the
 * node settles (`seal()`), so a body that ignores `signal` and keeps running
 * after a timeout/failure cannot leak late evidence into the run (§17 #12).
 *
 * It also records, for the executor: whether any assertion/validate/fail FAILED
 * (the node's pass/fail decision, §17 #5) and whether the node emitted ≥1 piece
 * of STRUCTURED evidence — protocol `trace`, `assertion`, `schema_validation`,
 * `metric` — which promotes a statically-`opaque` node to `trace` (§17 #10).
 * Plain `log` / `warn` / `action` / `event` do NOT count as structured evidence.
 */
export interface NodeScope {
  readonly ctx: WorkflowContext;
  /** True iff some assertion / error-severity validation / `fail()` recorded a failure (§17 #5). */
  hasFailure(): boolean;
  /** True iff the node emitted ≥1 structured evidence (drives opaque→trace, §17 #10). */
  emittedStructuredEvidence(): boolean;
  /** Settle the node: subsequent emissions are quarantined (dropped) (§17 #12). */
  seal(): void;
}

export function makeNodeScope(base: TestContext, signal: AbortSignal): NodeScope {
  let live = true;
  let failed = false;
  let structured = false;

  // Single gate for every emit: while live, record flags + forward to the real
  // ctx; once sealed, do NOTHING (drop the late emission, leave flags untouched —
  // the node's verdict is already fixed). `run` returns its value so accessors
  // that must yield a sound result to the (now-abandoned) body still can.
  const onEvidence = (
    flags: { failed?: boolean; structured?: boolean },
    forward: () => void,
  ): void => {
    if (!live) return;
    if (flags.failed) failed = true;
    if (flags.structured) structured = true;
    forward();
  };

  // `Object.create(base)` (not a spread) so prototype-inherited APIs survive — a
  // fixture-augmented ctx (test.extend) carries vars/http/log/etc. on its
  // prototype chain. Only the APIs below are overridden; everything else resolves
  // through `base`.
  //
  // `ctx.http` rebind (closes the S2.0 known limitation): the host's ky hooks
  // are pre-bound to the test-level ctx, so the executor runs every node body
  // inside the activeNodeCtx ALS scope and the harness's hooks route their
  // auto-trace/metric through `__activeWorkflowNodeCtx()` first — inline HTTP
  // inside a node now attributes to THIS scope (opaque HTTP actions promote to
  // `trace`, §17 #10) and is quarantined after seal (§17 #12).
  const ctx = Object.assign(Object.create(base) as TestContext, {
    signal,

    assert: (
      a: boolean | AssertionResultInput,
      message?: string,
      details?: AssertionDetails,
    ): void => {
      const passed = typeof a === "boolean" ? a : a.passed;
      onEvidence({ failed: !passed, structured: true }, () =>
        (base.assert as (...args: unknown[]) => void)(a, message, details),
      );
    },

    expect: <V>(actual: V): Expectation<V> =>
      new Expectation(actual, (result) => {
        onEvidence({ failed: !result.passed, structured: true }, () =>
          (base.assert as (...args: unknown[]) => void)(
            { passed: result.passed, actual: result.actual, expected: result.expected },
            result.message,
          ),
        );
      }),

    validate: <T>(
      data: unknown,
      schema: SchemaLike<T>,
      label?: string,
      options?: ValidateOptions,
    ): T | undefined => {
      // Run the schema NOW regardless of liveness — the body consumes the return
      // value (mirrors `quarantinedCtx.validate`). Supports both safeParse and
      // parse-only SchemaLikes. Only the EMIT + failure flag + fatal-throw are
      // gated on liveness.
      const s = schema as {
        safeParse?: (d: unknown) => { success: boolean; data?: T };
        parse?: (d: unknown) => T;
      };
      let ok = true;
      let value: T | undefined;
      if (typeof s.safeParse === "function") {
        const r = s.safeParse(data);
        ok = r.success;
        value = r.success ? r.data : undefined;
      } else if (typeof s.parse === "function") {
        try {
          value = s.parse(data);
        } catch {
          ok = false;
        }
      } else {
        // Neither safeParse nor parse — an unusable schema. The delegated
        // base.validate still records a failed validation, so this scope must
        // count it as a failure too, else runNode would report `passed` despite
        // failed validation evidence (codex S2.0 R2 P2).
        ok = false;
      }
      const severity = options?.severity ?? "error";
      onEvidence({ failed: !ok && severity !== "warn", structured: true }, () =>
        (base.validate as (...args: unknown[]) => unknown)(data, schema, label, options),
      );
      // `severity: "fatal"` aborts the body at the validation point — preserve
      // that control flow, but only while live (a sealed node is already done).
      if (live && !ok && severity === "fatal") {
        throw new Error(`fatal validation failed: ${label ?? "data"}`);
      }
      return value;
    },

    // `fail` emits a failed assertion AND aborts the body. It must NOT delegate to
    // `base.fail` (that would mutate the real ctx even from a sealed/abandoned
    // node). Emit (gated) + throw (always — the throw is control flow, not leaked
    // evidence).
    fail: (message: string): never => {
      onEvidence({ failed: true, structured: true }, () =>
        (base.assert as (...args: unknown[]) => void)({ passed: false }, message),
      );
      throw new Error(message);
    },

    // `skip` is pure control flow (emits nothing). OVERRIDE it (don't inherit
    // base.skip) so a node skip throws the SDK `GlubeanSkipError` REGARDLESS of
    // what the host ctx's skip throws — the real runner's `ctx.skip` throws its
    // own private `SkipError` (harness.ts:692), which `runNode`'s instanceof check
    // would miss. Overriding makes the skip shape the executor's own, not the
    // host's (codex S2.0 R2 P1; no-compat — workflow owns its skip semantics).
    skip: (reason?: string): never => {
      throw new GlubeanSkipError(reason);
    },

    warn: (condition: boolean, message: string): void =>
      onEvidence({}, () => base.warn(condition, message)),

    // Structured observability that DOES count toward opaque→trace (§17 #10).
    trace: (request: Trace): void =>
      onEvidence({ structured: true }, () => base.trace(request)),
    metric: (name: string, value: number, options?: unknown): void =>
      onEvidence({ structured: true }, () =>
        (base.metric as (...args: unknown[]) => void)(name, value, options),
      ),

    // Non-structured channels: forwarded while live, never promote the grade.
    action: (a: GlubeanAction): void => onEvidence({}, () => base.action(a)),
    event: (ev: GlubeanEvent): void => onEvidence({}, () => base.event(ev)),
    log: (message: string, data?: unknown): void =>
      onEvidence({}, () => base.log(message, data)),
  }) as unknown as WorkflowContext;

  return {
    ctx,
    hasFailure: () => failed,
    emittedStructuredEvidence: () => structured,
    seal: () => {
      live = false;
    },
  };
}

// =============================================================================
// Grade promotion (§17 #10)
// =============================================================================

/**
 * Runtime grade = the static floor, promoted from `opaque` → `trace` iff the node
 * emitted structured evidence at run time (§17 #10). `full` / `partial` are never
 * promoted (they are already as good as or better than `trace`).
 */
export function promoteGrade(staticGrade: StaticGrade, scope: NodeScope): ProjectionGrade {
  return staticGrade === "opaque" && scope.emittedStructuredEvidence()
    ? "trace"
    : staticGrade;
}

// =============================================================================
// runNode — execute one node under scope + abort + terminal timeout
// =============================================================================

export interface NodeRunResult {
  status: NodeStatus;
  /** Committed state. On failure this is the PRIOR state — a failed node does not
   * commit its return (§17 #13). On success: the body's return, or the prior state
   * when the body returned void/undefined (§17 #2).
   *
   * §17 #14: state is treated as IMMUTABLE, but the executor does NOT clone it
   * (perf). A body that mutates the LIVE state object in place takes effect
   * IMMEDIATELY and is NOT isolated or rolled back on failure/timeout — commit-on-
   * success governs the RETURN VALUE, not in-place writes. A node needing rollback
   * safety MUST return a new object instead of mutating in place. */
  state: unknown;
  /** Runtime grade after evidence promotion (§17 #10). */
  grade: ProjectionGrade;
  /** The error that failed the node (throw / timeout / fatal), if any. */
  error?: unknown;
}

/** Attempt label for a retrying node's events (§17 #7): `n` of `of`. */
export interface AttemptInfo {
  n: number;
  of: number;
}

export interface RunNodeOptions {
  /** Static floor grade for this node (from the projector); promoted per §17 #10. */
  staticGrade: StaticGrade;
  /** Per-node terminal timeout (ms). Omit / non-finite = unbounded (§17 #4). */
  timeoutMs?: number;
  /** Stamp this run's node_start/node_end events as attempt n of of (§17 #7). */
  attempt?: AttemptInfo;
  /**
   * Called with the settled verdict JUST BEFORE this run's node_end event is
   * emitted — the retry wrapper uses it to flush the terminal attempt's buffered
   * assert/validate evidence INSIDE the attempt bracket, so timeline grouping
   * holds (codex S2.4c R2 P2). Runs after the scope is sealed; anything it emits
   * goes straight to the base ctx.
   */
  beforeNodeEnd?: (status: NodeStatus, error?: unknown) => void;
  /**
   * Adjust the runtime grade before it is reported — applied to BOTH the
   * node_end event and the returned result, so they always agree. The retry
   * wrapper uses it to tie opaque→trace promotion to HOST-VISIBLE evidence
   * across attempts: the scope's structured flag cannot distinguish
   * pass-through traces from buffered (possibly-discarded) assert counts, and
   * an earlier attempt's promotion must survive into the terminal bracket
   * (§17 #10; codex S2.5 R5 P2).
   */
  adjustGrade?: (
    computed: ProjectionGrade,
    info: { structured: boolean; status: NodeStatus; error?: unknown },
  ) => ProjectionGrade;
}

function emitNodeStart(base: TestContext, node: WorkflowNode, attempt?: AttemptInfo): void {
  const data: NodeStartEventData = {
    nodeId: node.meta.id,
    kind: node.kind,
    name: node.meta.name ?? node.meta.id,
  };
  if (attempt) {
    data.attempt = attempt.n;
    data.attempts = attempt.of;
  }
  base.event({ type: NODE_START_EVENT, data });
}

function emitNodeEnd(
  base: TestContext,
  node: WorkflowNode,
  status: NodeStatus,
  grade: ProjectionGrade,
  durationMs: number,
  error?: unknown,
  attempt?: AttemptInfo,
): void {
  const data: NodeEndEventData = {
    nodeId: node.meta.id,
    kind: node.kind,
    name: node.meta.name ?? node.meta.id,
    status,
    grade,
    durationMs,
  };
  if (error !== undefined) data.error = error instanceof Error ? error.message : String(error);
  if (attempt) {
    data.attempt = attempt.n;
    data.attempts = attempt.of;
  }
  base.event({ type: NODE_END_EVENT, data });
}

/**
 * Validate an explicit-intent retry (§17 #7). `attempts` must be an integer >= 2
 * (1 attempt is "no retry" — omit `retry` instead), `delay` finite >= 0, and
 * `reason` a non-empty statement of why replay is safe. Called by the builder at
 * construction AND by the executor before looping (an `as any`/JS caller could
 * smuggle an invalid retry — e.g. `attempts: Infinity` — past the types).
 */
export function validateRetryMeta(retry: RetryMeta, stepLabel: string): void {
  if (!Number.isInteger(retry.attempts) || retry.attempts < 2) {
    throw new Error(
      `workflow step "${stepLabel}": retry.attempts must be an integer >= 2 ` +
        `(1 attempt is no retry — omit \`retry\`); got ${String(retry.attempts)}`,
    );
  }
  if (
    retry.delay !== undefined &&
    (typeof retry.delay !== "number" || !Number.isFinite(retry.delay) || retry.delay < 0)
  ) {
    throw new Error(
      `workflow step "${stepLabel}": retry.delay must be a finite number >= 0; got ${String(retry.delay)}`,
    );
  }
  if (typeof retry.reason !== "string" || retry.reason.length === 0) {
    throw new Error(
      `workflow step "${stepLabel}": retry.reason is required — state why replaying ` +
        `this step is safe (idempotency is the author's responsibility, §17 #7)`,
    );
  }
}

/** True for a Promise or any Promise-like (`.then` is a function). */
function isThenable(v: unknown): boolean {
  return v != null && typeof (v as { then?: unknown }).then === "function";
}

/** The node shape `executeCallAttempt` needs — both call and poll nodes match it. */
interface CallLikeNode {
  meta: NodeMeta;
  ref: ContractCallNode["ref"];
  in?: (state: any) => unknown;
  accept?: ReadonlyArray<string | number>;
}

/**
 * Execute ONE in-graph contract-case invocation (§17 #8). Independent of the flow
 * engine (which gets deleted — plan fork a): dispatch through the PUBLIC adapter
 * registry and call the protocol-neutral `executeCaseInFlow`. Covers the adapter
 * lookup, the third-party `validateCaseForFlow` veto (mirrors contract-core.ts:818),
 * the `needs` validation at the call boundary (contract-core.ts:1402-1427 parity;
 * codex S2.1 R4 P2), and the `in` lens (PURE SYNCHRONOUS — thenables rejected,
 * codex S2.1 R7). Shared by `.call` (one shot, node signal) and `.poll` (one
 * invocation per attempt, per-attempt budget signal + quarantined ctx).
 */
async function executeCallAttempt(
  kind: "call" | "poll",
  node: CallLikeNode,
  ctx: TestContext,
  state: unknown,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const label = `workflow ${kind} "${node.meta.id}"`;
  const adapter = getAdapter(node.ref.protocol);
  if (!adapter?.executeCaseInFlow) {
    throw new Error(
      `${label}: protocol "${node.ref.protocol}" ` +
        (adapter
          ? "does not implement executeCaseInFlow — it cannot be called in a workflow"
          : "has no registered adapter (did you import its contract plugin package?)"),
    );
  }
  // Third-party adapter veto: a protocol can reject specific cases from in-graph use
  // (§17 #8, the validateCaseForFlow half — a third-party slot; built-in adapters
  // don't implement it).
  adapter.validateCaseForFlow?.(
    (node.ref.contract as { _spec?: unknown })._spec,
    node.ref.caseKey,
    node.ref.contractId,
  );

  const contractSpec = (node.ref.contract as { _spec?: unknown })._spec as
    | { cases?: Record<string, { needs?: unknown }> }
    | undefined;
  const needsSchema = contractSpec?.cases?.[node.ref.caseKey]?.needs;
  const caseId = `${node.ref.contractId}.${node.ref.caseKey}`;
  if (needsSchema && typeof node.in !== "function") {
    throw new Error(
      `${label}: case "${caseId}" declares \`needs\` but the ` +
        `${kind} has no \`in\` binding. Provide \`in: (state) => <logical input>\`.`,
    );
  }
  let resolvedInputs = node.in ? node.in(state) : undefined;
  if (isThenable(resolvedInputs)) {
    throw new Error(
      `${label}: \`in\` returned a thenable — in must be a ` +
        `pure synchronous lens (state) => input; do async work in .action()`,
    );
  }
  if (needsSchema) {
    resolvedInputs = validateNeedsOutput(
      needsSchema as { safeParse?: unknown; parse?: unknown },
      resolvedInputs,
      { testId: caseId, source: "workflow" },
    );
  }

  return adapter.executeCaseInFlow({
    ctx,
    // The adapter owns the contract's concrete spec type; the ref carries the live
    // instance. Cast at this protocol-neutral seam (mirrors contract-core.ts:1431).
    contract: node.ref.contract as never,
    caseKey: node.ref.caseKey,
    resolvedInputs,
    ...(node.accept ? { accept: node.accept } : {}),
    ...(signal ? { signal } : {}),
  });
}

/**
 * Invoke a contract case IN-GRAPH for a `.call` node: one `executeCallAttempt`
 * under the node's ctx + signal, then the `out` lens. `in` maps state → the
 * case's logical input; `out` folds the raw response back into state (no `out`
 * → response discarded, state preserved, like runFlow contract-core.ts:1625-1628).
 */
async function runContractCall(
  node: ContractCallNode,
  ctx: WorkflowContext,
  state: unknown,
  scope: NodeScope,
): Promise<unknown> {
  const res = await executeCallAttempt("call", node, ctx, state, ctx.signal);
  // If the adapter already recorded a soft failure (scoped expect/validate on a
  // failing case), STOP before `out`: an out lens that assumes the validated success
  // shape would throw and become the cause, masking the real validation failure.
  // runNode then fails the node on hasFailure() with a synthesized cause (codex S2.1 R7).
  if (scope.hasFailure()) {
    return state; // preserve; the node fails on the recorded failure, not via `out`
  }

  // `out` REPLACES state; absent `out` returns undefined → §17 #2 preserves it.
  // `out` is a PURE SYNCHRONOUS lens — reject a thenable result so async/I/O can't
  // hide inside a `full`-graded call lens (mirrors compute, §17 #11; codex S2.1 R6).
  const next = node.out ? node.out(state, res) : undefined;
  if (isThenable(next)) {
    throw new Error(
      `workflow call "${node.meta.id}": \`out\` returned a thenable — out must be a ` +
        `pure synchronous lens (state, res) => state; do async work in .action()`,
    );
  }
  return next;
}

/** Dispatch a node's body to its kind-specific executor. */
function runBody(
  node: WorkflowNode,
  ctx: WorkflowContext,
  state: unknown,
  scope: NodeScope,
): Promise<unknown> {
  switch (node.kind) {
    case "action":
      return Promise.resolve((node as ActionNode).fn(ctx, state));
    case "check": {
      const check = node as CheckNode;
      // DECLARATIVE form (phase4 §7): pure evaluation, one assertion event
      // per item, soft semantics (§17 #5) — the node fails iff any item
      // failed, via the scope's existing hasFailure aggregation. No user
      // code runs.
      if (check.expects !== undefined) {
        for (const item of check.expects) {
          const extracted = extractPredicate(item as Parameters<typeof extractPredicate>[0]);
          ctx.assert(evalPredicate(item, state), predicateLabel(extracted));
        }
        return Promise.resolve(undefined);
      }
      // `as any`/JS construction can hand a check with NEITHER form — the
      // type is an XOR union, but fail fast for bypassers (codex S2.17 R2).
      if (typeof check.fn !== "function") {
        throw new Error(
          `workflow check "${node.meta.id}": needs an inline fn or { expect: [...] }`,
        );
      }
      // A check returns void → it never changes state (resolve to `undefined` so
      // the caller's §17 #2 "void preserves" rule keeps the prior state).
      return Promise.resolve(check.fn(ctx, state)).then(() => undefined);
    }
    case "compute": {
      // Pure synchronous transform; the return REPLACES state (§17 #2/#13). The
      // builder rejects `async` compute syntactically; here we also catch a sync fn
      // that RETURNS a thenable (JS / cast bypass) — fail the node, never commit the
      // Promise as state (§17 #11).
      const result = (node as ComputeNode).fn(state);
      if (isThenable(result)) {
        throw new ComputeAsyncError(node.meta.id);
      }
      return Promise.resolve(result);
    }
    case "contract-call":
      return runContractCall(node as ContractCallNode, ctx, state, scope);
    case "branch":
    case "poll":
      // Control-flow nodes own their bracket/bounds — runNodeList dispatches them
      // to runBranch / runPollNode directly, never through runNode.
      throw new Error(
        `runNode: "${node.kind}" nodes run via the node-list dispatcher, not runNode`,
      );
    default:
      throw new Error(
        `runNode: node kind "${node.kind}" is not implemented yet (lands in a later slice)`,
      );
  }
}

/**
 * Run ONE node: bracket it with node_start/node_end, execute its body under a
 * per-node child ctx + `AbortController`, enforce a TERMINAL timeout (§17 #4),
 * and quarantine any late evidence after the node settles (§17 #12). Returns the
 * verdict + the state to carry forward (commit-on-success, §17 #13).
 */
export async function runNode(
  base: TestContext,
  node: WorkflowNode,
  state: unknown,
  opts: RunNodeOptions,
): Promise<NodeRunResult> {
  const ac = new AbortController();
  const scope = makeNodeScope(base, ac.signal);
  const started = Date.now();

  // One grade per settle path, shared by the node_end event AND the result so
  // they always agree; `adjustGrade` lets the retry wrapper tie promotion to
  // host-visible evidence (codex S2.5 R5 P2). Called only after settle().
  const finalGrade = (status: NodeStatus, error?: unknown): ProjectionGrade => {
    const computed = promoteGrade(opts.staticGrade, scope);
    return opts.adjustGrade
      ? opts.adjustGrade(computed, {
          structured: scope.emittedStructuredEvidence(),
          status,
          error,
        })
      : computed;
  };

  emitNodeStart(base, node, opts.attempt);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const hasTimeout = opts.timeoutMs != null && Number.isFinite(opts.timeoutMs);

  const settle = (): void => {
    // Order matters: seal BEFORE clearing the timer so a body that races the
    // timer can't slip an emission through the gap.
    scope.seal();
    if (timer !== undefined) clearTimeout(timer);
  };

  try {
    const body = withActiveNodeCtx(scope.ctx, () => runBody(node, scope.ctx, state, scope));
    const raced = hasTimeout
      ? Promise.race([
          body,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              // Seal BEFORE aborting: `ac.abort()` runs abort listeners
              // synchronously, and a listener that emits evidence must be
              // quarantined too — sealing first stops it leaking past the timeout
              // boundary or promoting the grade (codex S2.0 R3 P2).
              scope.seal();
              ac.abort();
              reject(new NodeTimeoutError(node.meta.id, opts.timeoutMs as number));
            }, opts.timeoutMs as number);
          }),
        ])
      : body;

    const returned = await raced;
    settle();

    if (scope.hasFailure()) {
      // Body resolved but a soft assertion failed → node fails, no commit (§17 #13).
      // Abort the signal too (as timeout/throw do) so any cooperative work the node
      // started observes the failure and stops — the WorkflowContext signal contract.
      if (!ac.signal.aborted) ac.abort();
      const grade = finalGrade("failed");
      opts.beforeNodeEnd?.("failed", undefined);
      emitNodeEnd(base, node, "failed", grade, Date.now() - started, undefined, opts.attempt);
      return { status: "failed", state, grade };
    }
    // Success: return REPLACES state; void/undefined PRESERVES it (§17 #2 / #13).
    const nextState = returned === undefined ? state : returned;
    const grade = finalGrade("passed");
    opts.beforeNodeEnd?.("passed", undefined);
    emitNodeEnd(base, node, "passed", grade, Date.now() - started, undefined, opts.attempt);
    return { status: "passed", state: nextState, grade };
  } catch (err) {
    settle();
    // Ensure the body's signal fires even on a thrown (non-timeout) failure, so a
    // dangling async leg observes the abort.
    if (!ac.signal.aborted) ac.abort();
    // `ctx.skip()` is control flow, not a failure: a node that deliberately skips
    // (and had no earlier failed assertion) settles `skipped`, NOT `failed` — a
    // failed assertion before the skip still wins (mirrors harness.ts:2297). The
    // skip is preserved on `err` so the caller (runWorkflow, S2.1) can decide its
    // graph-level meaning (skip the rest vs. continue); runNode only classifies.
    if (err instanceof GlubeanSkipError && !scope.hasFailure()) {
      const grade = finalGrade("skipped", err);
      opts.beforeNodeEnd?.("skipped", err);
      emitNodeEnd(base, node, "skipped", grade, Date.now() - started, undefined, opts.attempt);
      return { status: "skipped", state, grade, error: err };
    }
    // A skip thrown AFTER a soft failure is NOT the cause — the prior failure is.
    // Drop the skip so runWorkflow synthesizes a proper phase-failure cause; a real
    // thrown error / timeout stays as the cause (codex S2.1 R4 P3).
    const failError = err instanceof GlubeanSkipError ? undefined : err;
    const grade = finalGrade("failed", failError);
    opts.beforeNodeEnd?.("failed", failError);
    emitNodeEnd(base, node, "failed", grade, Date.now() - started, failError, opts.attempt);
    return { status: "failed", state, grade, error: failError };
  }
}

// =============================================================================
// runWorkflow — walk the graph: setup → nodes → teardown (§17 #1 / #5 / #13)
// =============================================================================

export interface WorkflowNodeOutcome {
  id: string;
  status: NodeStatus;
  /** Runtime grade after evidence promotion (§17 #10). */
  grade: ProjectionGrade;
}

export interface WorkflowRunResult {
  /** `skipped` if the workflow opts out (meta.skip) or a node called `ctx.skip()`;
   * `failed` if setup threw / soft-failed or a node failed; else `passed`. */
  status: "passed" | "failed" | "skipped";
  /** Last COMMITTED state — passed nodes commit, failed/skipped do not (§17 #13). */
  state: unknown;
  /** Per-node outcomes, authored order. */
  nodes: WorkflowNodeOutcome[];
  /** The primary cause that failed the run (the one teardown sees), if any. */
  error?: unknown;
  /** Why the run skipped: the user-authored ctx.skip(reason) (setup/node/
   * branch-predicate/poll), or `meta.skip`. Only set when status === "skipped"
   * (codex S2.5 R6 — the host's skipped status must keep the authored reason). */
  skipReason?: string;
}

/**
 * Derive a lifecycle (setup/teardown) child ctx + its `AbortController` — same
 * per-node attribution + late-evidence quarantine as a graph node, AND the same
 * failure-abort guarantee: the caller aborts the signal when the phase fails, so
 * signal-aware async work the body started gets cancelled (codex S2.1 R2). No
 * per-node timeout for this slice (§17 #4 timeout on setup/teardown lands later).
 */
function deriveLifecycleScope(base: TestContext): { scope: NodeScope; ac: AbortController } {
  const ac = new AbortController();
  return { scope: makeNodeScope(base, ac.signal), ac };
}

/**
 * Record nodes in `list` from `startIndex` onward as `skipped` (emit end-only — they
 * never started). Indexed by POSITION, not `meta.id`, so two nodes that accidentally
 * share an id both still get an outcome (the builder doesn't reject dup ids — codex
 * S2.1 R3 P3). A skipped branch node is recorded as one `skipped` node (its sides are
 * not expanded — they never ran).
 */
function emitNodesSkipped(
  baseCtx: TestContext,
  list: readonly WorkflowNode[],
  outcomes: WorkflowNodeOutcome[],
  startIndex: number,
): void {
  for (let i = startIndex; i < list.length; i++) {
    const node = list[i];
    const grade = staticGradeOf(node);
    emitNodeEnd(baseCtx, node, "skipped", grade, 0);
    outcomes.push({ id: node.meta.id, status: "skipped", grade });
    // RECURSIVE (phase4 §2.4 / design-R2): summary and Cloud count nodes from
    // per-child node_end events. A skipped GROUP's members are a definite
    // execution list — they must each report. A skipped BRANCH's case
    // sub-graphs get the same treatment for consistency with the executed
    // branch path, which emits skipped node_ends for every non-taken case.
    if (node.kind === "group") {
      emitNodesSkipped(baseCtx, (node as GroupNode).nodes, outcomes, 0);
    } else if (node.kind === "branch") {
      const b = node as BranchNode;
      for (const c of b.cases) emitNodesSkipped(baseCtx, c.nodes, outcomes, 0);
      if (b.default) emitNodesSkipped(baseCtx, b.default, outcomes, 0);
    }
  }
}

/** Outcome of running a node LIST (the top-level graph, or a branch side). */
interface NodeListOutcome {
  state: unknown;
  status: "passed" | "failed" | "skipped";
  /** Failure cause to thread to teardown (only when status === "failed"). */
  cause?: unknown;
  /** The user-authored ctx.skip(reason), preserved to the run result (codex S2.5 R6). */
  skipReason?: string;
  /** A terminal route completed — the trunk ends here (addendum §9 #5). */
  terminal?: boolean;
}

/** Is this `when` an L1/L0 opaque predicate (vs an L2 declarative `BranchPredicate`)? */
function isOpaquePredicate(
  when: BranchPredicate<unknown> | OpaquePredicate,
): when is OpaquePredicate {
  return (when as { kind?: unknown }).kind === "opaque";
}

/** The taken-case decision (branch_decision event payload + dispatch result). */
type BranchDecision = { takenIndex: number | "default"; takenLabel?: string };

/**
 * Decide the taken case of a branch-family node (addendum §9).
 *
 * - value mode: run the `on` lens (pure + synchronous — thenables rejected,
 *   mirrors call's `in`), === match against the literal case table.
 * - predicate mode: ordered first-match. L2 declarative → pure synchronous
 *   `evalPredicate`; an opaque fn (branch's whenRuntime) runs under the node's
 *   child ctx (may read ctx + emit evidence; async awaited). A non-boolean
 *   opaque result is rejected, not coerced (codex S2.4a P2).
 *
 * No match → "default" (which the caller maps to the `default` nodes, or — for
 * switch with no default — the identity pass-through).
 */
async function selectBranchCase(
  node: BranchNode,
  state: unknown,
  ctx: WorkflowContext,
): Promise<BranchDecision> {
  if (node.mode === "value") {
    const discriminant = node.on?.(state);
    if (isThenable(discriminant)) {
      throw new Error(
        `workflow ${node.meta.id}: \`on\` returned a thenable — on must be a pure ` +
          `synchronous lens (state) => scalar; do async work in .action()`,
      );
    }
    const idx = node.cases.findIndex((c) => c.value === discriminant);
    return idx >= 0
      ? { takenIndex: idx, takenLabel: node.cases[idx].label }
      : { takenIndex: "default" };
  }
  for (let i = 0; i < node.cases.length; i++) {
    const when = node.cases[i].when;
    if (when === undefined) continue; // defensive: a case without a predicate never matches
    let hit: boolean;
    if (isOpaquePredicate(when)) {
      const result = await when.fn(ctx, state);
      if (typeof result !== "boolean") {
        // The public type promises boolean; reject non-booleans rather than coercing
        // (a `'false'` string or a forgotten return would silently take the case).
        throw new Error(
          `workflow branch "${node.meta.id}": whenRuntime must return a boolean, got ${typeof result}`,
        );
      }
      hit = result;
    } else {
      hit = evalPredicate(when as BranchPredicate<unknown>, state);
    }
    if (hit) return { takenIndex: i, takenLabel: node.cases[i].label };
  }
  return { takenIndex: "default" };
}

/**
 * Run a single leaf (non-control-flow) node: runNode + push outcome + cause
 * synthesis. Explicit-intent retry (§17 #7) lives HERE: each attempt is a FULL
 * runNode bracket (fresh scope + abort + attempt-stamped node_start/node_end).
 *
 * Attempt-evidence policy (§17 #7, codex S2.4c R1 P2): the run's pass/fail
 * counters belong to the FINAL attempt only — a retried-and-passed node must
 * not leave failed assertion/validation counts on the host ctx (the shipped
 * step retry resets per-attempt counters the same way; otherwise a host
 * summary computed from assertion events contradicts the node verdict). So a
 * retrying node buffers each attempt's pass/fail evidence (`quarantinedCtx`)
 * and flushes ONLY the attempt that decides the verdict: the passing/skipping
 * attempt, the terminal-timeout attempt, or the last exhausted attempt. A
 * non-final failed attempt stays VISIBLE — its attempt-stamped node_end
 * (failed, with the error), its traces/logs/metrics, and a retry log line all
 * pass through; only its buffered assert/validate COUNTS are dropped.
 *
 * Each attempt re-reads the same last-committed state (a failed attempt
 * commits nothing, §17 #13). Never retried: a passed/skipped attempt (skip is
 * control flow), and a timeout (TERMINAL, §17 #4). check/compute cannot carry
 * retry — a check failure must never replay a prior action.
 */
async function runLeafNode(
  baseCtx: TestContext,
  workflowId: string,
  node: WorkflowNode,
  state: unknown,
  outcomes: WorkflowNodeOutcome[],
): Promise<NodeListOutcome> {
  const grade = staticGradeOf(node);
  const retry =
    node.kind === "contract-call" || node.kind === "action"
      ? (node as ContractCallNode | ActionNode).retry
      : undefined;
  // Re-validate at run time: an `as any`/JS caller could smuggle e.g.
  // `attempts: Infinity` past the builder — fail the node fast, don't loop.
  let r: NodeRunResult;
  if (retry) {
    try {
      validateRetryMeta(retry, node.meta.id);
    } catch (err) {
      outcomes.push({ id: node.meta.id, status: "failed", grade });
      emitNodeEnd(baseCtx, node, "failed", grade, 0, err);
      return { state, status: "failed", cause: err };
    }
  }
  const maxAttempts = retry?.attempts ?? 1;
  const timeoutOpt =
    node.meta.timeout !== undefined ? { timeoutMs: node.meta.timeout } : {};
  if (!retry) {
    r = await runNode(baseCtx, node, state, { staticGrade: grade, ...timeoutOpt });
  } else {
    // A failed attempt is terminal when it cannot/must not be replayed: a
    // passed/skipped verdict (skip is control flow), a timeout (TERMINAL,
    // §17 #4), or attempt exhaustion.
    const isTerminal = (attempt: number, status: NodeStatus, error?: unknown): boolean =>
      status !== "failed" || error instanceof NodeTimeoutError || attempt >= maxAttempts;
    // Replaying a buffered FATAL validation onto the real host ctx throws again
    // (the host's validate aborts on fatal). That control flow is already spent —
    // it failed the attempt at the original throw — so the replay's throw must
    // not escape runNode/runWorkflow (codex S2.4c R3 P2). Evidence before the
    // fatal entry has already replayed; nothing follows it (the attempt body
    // stopped at the throw).
    const safeFlush = (attemptCtx: { flushTo: (t: TestContext) => void }): void => {
      try {
        attemptCtx.flushTo(baseCtx);
      } catch {
        /* replayed fatal validation — already accounted in the attempt verdict */
      }
    };
    // Promotion aggregates across attempts, but ONLY from evidence that actually
    // reached the host (codex S2.4c R3+R4 P2): pass-through trace/metric on ANY
    // attempt counts (it is on the host timeline even when the attempt's buffered
    // counts are dropped); buffered assert/validate counts only when FLUSHED —
    // i.e. on the terminal attempt. The adjustment is applied INSIDE runNode (via
    // adjustGrade) so each attempt's node_end event and the final outcome carry
    // the same host-visible grade — a discarded attempt's assert-only "trace"
    // must not show anywhere, and an earlier attempt's pass-through promotion
    // must survive into the terminal bracket (codex S2.5 R5 P2).
    let promoted = false;
    for (let attempt = 1; ; attempt++) {
      // Buffer this attempt's pass/fail evidence; observability (traces, logs,
      // node_start/node_end events) passes straight through to the host — via a
      // probe that records whether any pass-through STRUCTURED evidence landed.
      let passthroughStructured = false;
      const probe = Object.assign(Object.create(baseCtx) as TestContext, {
        trace: (t: Trace): void => {
          passthroughStructured = true;
          baseCtx.trace(t);
        },
        metric: (name: string, value: number, options?: unknown): void => {
          passthroughStructured = true;
          (baseCtx.metric as (...a: unknown[]) => void)(name, value, options);
        },
      });
      const attemptCtx = quarantinedCtx(probe);
      let flushed = false;
      r = await runNode(attemptCtx, node, state, {
        staticGrade: grade,
        ...timeoutOpt, // §17 #4: a timed-out attempt is TERMINAL — never retried
        attempt: { n: attempt, of: maxAttempts },
        // Flush the verdict-deciding attempt's evidence BEFORE its node_end is
        // emitted, so the assertions land INSIDE the attempt bracket on the
        // host timeline (codex S2.4c R2 P2).
        beforeNodeEnd: (status, error) => {
          if (isTerminal(attempt, status, error)) {
            flushed = true; // set first — a throwing replay still counts as flushed
            safeFlush(attemptCtx);
          }
        },
        adjustGrade: (computed, info) => {
          if (grade !== "opaque") return computed; // only opaque→trace exists (§17 #10)
          const terminal = isTerminal(attempt, info.status, info.error);
          // Host-visible structured evidence: a pass-through trace/metric (this
          // or any earlier attempt), or — only when this attempt's buffers flush
          // (terminal) — its scope-recorded assert/validate evidence.
          const hostVisible =
            promoted || passthroughStructured || (terminal && info.structured);
          return hostVisible ? "trace" : "opaque";
        },
      });
      if (passthroughStructured) promoted = true;
      if (isTerminal(attempt, r.status, r.error)) {
        // beforeNodeEnd already flushed on every runNode settle path; this is a
        // safety net for a future runNode path that misses the hook (flushTo
        // replays the buffer, so it must run at most once).
        if (!flushed) safeFlush(attemptCtx);
        break;
      }
      // Non-final failed attempt: drop its buffered counts, log the retry
      // (mirrors the shipped step-retry log line), wait, go again.
      baseCtx.log?.(
        `retrying workflow node "${node.meta.id}" (${attempt + 1}/${maxAttempts}) ` +
          `after failure — ${retry.reason}`,
      );
      if (retry.delay) await sleep(retry.delay);
    }
    // r.grade already carries the cross-attempt host-visible promotion (adjustGrade).
  }
  outcomes.push({ id: node.meta.id, status: r.status, grade: r.grade });
  if (r.status === "passed") return { state: r.state, status: "passed" };
  if (r.status === "failed") {
    return {
      state,
      status: "failed",
      cause: r.error ?? new WorkflowPhaseFailedError(workflowId, `node "${node.meta.id}"`),
    };
  }
  // node ctx.skip() — preserve the authored reason (codex S2.5 R6).
  return {
    state,
    status: "skipped",
    skipReason: r.error instanceof GlubeanSkipError ? r.error.reason : undefined,
  };
}

/** Branch-family decision event (§17 #9 "branch decision") — rides the generic
 * ctx.event channel like node_start/node_end; the runner unwraps it into a
 * first-class `branch_decision` timeline event. */
export const BRANCH_DECISION_EVENT = "workflow:branch_decision";

export interface BranchDecisionEventData {
  nodeId: string;
  mode: "predicate" | "value";
  takenIndex: number | "default";
  takenLabel?: string;
  [k: string]: unknown;
}

/**
 * Run a branch-family node (§17 #6, addendum §9): decide the taken case (under
 * a child ctx so an opaque predicate's evidence is attributed + quarantined),
 * then run ONLY the taken case's nodes via runNodeList; every non-taken case
 * (and the un-taken default) is emitted `skipped`. A decision that throws or
 * soft-fails fails the node (all cases skipped). switch with no default and no
 * match = identity pass-through. A terminal route's outcome carries
 * `terminal: true` so runNodeList stops the trunk after it.
 */
async function runBranch(
  baseCtx: TestContext,
  workflowId: string,
  node: BranchNode,
  state: unknown,
  outcomes: WorkflowNodeOutcome[],
): Promise<NodeListOutcome> {
  const grade = staticGradeOf(node);
  const started = Date.now();
  emitNodeStart(baseCtx, node);
  // The family node's own outcome precedes its children (tree order); the final
  // status is set once the taken case settles.
  const outcomeIndex = outcomes.length;
  outcomes.push({ id: node.meta.id, status: "passed", grade });

  const ac = new AbortController();
  const scope = makeNodeScope(baseCtx, ac.signal);

  // Emit ALL children (every case in authored order, then default) as skipped.
  // `exceptIndex` skips the taken case's slot (its children get real outcomes).
  const emitChildrenSkipped = (exceptIndex?: number | "default"): void => {
    node.cases.forEach((c, i) => {
      if (exceptIndex !== i) emitNodesSkipped(baseCtx, c.nodes, outcomes, 0);
    });
    if (node.default && exceptIndex !== "default") {
      emitNodesSkipped(baseCtx, node.default, outcomes, 0);
    }
  };

  const failAll = (cause: unknown, error?: unknown): NodeListOutcome => {
    ac.abort();
    emitChildrenSkipped();
    const g = promoteGrade(grade, scope); // a soft-failed predicate may have emitted evidence (§17 #10)
    outcomes[outcomeIndex] = { id: node.meta.id, status: "failed", grade: g };
    emitNodeEnd(baseCtx, node, "failed", g, Date.now() - started, error);
    return { state, status: "failed", cause };
  };

  let decision: BranchDecision;
  try {
    decision = await withActiveNodeCtx(scope.ctx, () =>
      selectBranchCase(node, state, scope.ctx),
    );
  } catch (err) {
    scope.seal();
    if (err instanceof GlubeanSkipError && !scope.hasFailure()) {
      // decision ctx.skip() with no prior failure → skip the node (→ whole
      // workflow, like a node skip), NOT a failure (codex S2.4a R5).
      ac.abort();
      emitChildrenSkipped();
      const g = promoteGrade(grade, scope);
      outcomes[outcomeIndex] = { id: node.meta.id, status: "skipped", grade: g };
      emitNodeEnd(baseCtx, node, "skipped", g, Date.now() - started);
      return { state, status: "skipped", skipReason: err.reason };
    }
    // a real throw, OR a soft-failure-then-skip → fail. A skip is never the cause;
    // synthesize a phase failure (mirrors runNode/setup, codex S2.4a R6).
    if (err instanceof GlubeanSkipError) {
      return failAll(new WorkflowPhaseFailedError(workflowId, `branch "${node.meta.id}" decision`));
    }
    return failAll(err, err);
  }
  if (scope.hasFailure()) {
    // opaque predicate soft-failed (scoped assert/validate) — fail the node.
    scope.seal();
    return failAll(new WorkflowPhaseFailedError(workflowId, `branch "${node.meta.id}" decision`));
  }
  // The decision is observability (§17 #9) — emit through the scope while live.
  const decisionData: BranchDecisionEventData = {
    nodeId: node.meta.id,
    mode: node.mode,
    takenIndex: decision.takenIndex,
    ...(decision.takenLabel !== undefined ? { takenLabel: decision.takenLabel } : {}),
  };
  scope.ctx.event({ type: BRANCH_DECISION_EVENT, data: decisionData });
  scope.seal();

  // Run the taken case; emit every other case's children skipped — in AUTHORED
  // order, so outcomes/events align with the projected tree (codex S2.4a P2):
  // cases before the taken one first, then the taken sub-run, then the rest.
  let r: NodeListOutcome;
  if (decision.takenIndex === "default") {
    emitChildrenSkipped("default");
    r = node.default
      ? await runNodeList(baseCtx, workflowId, node.default, state, outcomes)
      : { state, status: "passed" }; // switch with no default: identity pass-through (§9 #4)
  } else {
    const takenIdx = decision.takenIndex;
    node.cases.forEach((c, i) => {
      if (i < takenIdx) emitNodesSkipped(baseCtx, c.nodes, outcomes, 0);
    });
    r = await runNodeList(baseCtx, workflowId, node.cases[takenIdx].nodes, state, outcomes);
    node.cases.forEach((c, i) => {
      if (i > takenIdx) emitNodesSkipped(baseCtx, c.nodes, outcomes, 0);
    });
    if (node.default) emitNodesSkipped(baseCtx, node.default, outcomes, 0);
  }

  // promote opaque→trace if the decision emitted structured evidence, same as
  // runNode (§17 #10; codex S2.4a P2).
  const runtimeGrade = promoteGrade(grade, scope);
  outcomes[outcomeIndex] = { id: node.meta.id, status: r.status, grade: runtimeGrade };
  emitNodeEnd(baseCtx, node, r.status, runtimeGrade, Date.now() - started);
  // A terminal route that completed (passed OR skipped) ends the trunk; a
  // failed one already fail-stops the list the normal way.
  if (node.terminal && r.status === "passed") {
    return { ...r, terminal: true };
  }
  return r;
}

// =============================================================================
// runPollNode — bounded poll-until with per-attempt quarantine (§17 #3, §6.7)
// =============================================================================

/** Per-attempt timeline event (§17 #9 "poll attempt timeline"). Rides the generic
 * `ctx.event` channel like node_start/node_end; emitted through the NODE scope, so
 * it is observability (never promotes the grade) and is quarantined after seal. */
export const POLL_ATTEMPT_EVENT = "workflow:poll_attempt";

export interface PollAttemptEventData {
  nodeId: string;
  attempt: number;
  /** `satisfied` — until held; `probe` — until not yet; `failed` — the attempt
   * threw / exceeded its budget (the poll node fails). */
  outcome: "satisfied" | "probe" | "failed";
  durationMs: number;
  /**
   * Inbound polls only (design §9.4): the matcher's classification for this
   * attempt — `matched`, the probe attributions (`no-delivery` /
   * `type-mismatch` / `correlation-mismatch` / `schema-mismatch`), or the
   * fail class that ended the poll. Diagnosis, never verdict.
   */
  classification?: string;
  /**
   * Inbound polls, satisfied attempts only: `receivedAt − pollStart` of the
   * matched delivery (ms) — the measured side of `expect.within` (§9.4a #5).
   * NEGATIVE when the delivery arrived before the poll started (allowed
   * evidence, §9.4a #3).
   */
  withinDeltaMs?: number;
  [k: string]: unknown;
}

function emitPollAttempt(
  ctx: WorkflowContext,
  node: PollNode,
  attempt: number,
  outcome: PollAttemptEventData["outcome"],
  durationMs: number,
  inboundDetail?: { classification: string; withinDeltaMs?: number },
): void {
  const data: PollAttemptEventData = {
    nodeId: node.meta.id,
    attempt,
    outcome,
    durationMs: Math.round(durationMs),
    ...(inboundDetail ? inboundDetail : {}),
  };
  ctx.event({ type: POLL_ATTEMPT_EVENT, data });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A fail-class inbound classification (inbound-contract-design §9.4 rows 1–3):
 * a property of the delivery CHANNEL (forgery / replay / non-JSON), never
 * noise — it fails the poll node even when a later delivery in the same
 * snapshot would have matched (§9.4a #4, first terminal wins).
 */
export class InboundDeliveryFailError extends Error {
  constructor(
    readonly classification: "signature-invalid" | "stale" | "unparseable",
    nodeId: string,
    detail?: string,
  ) {
    super(
      `workflow poll "${nodeId}": inbound delivery classified ${classification}` +
        `${detail ? ` (${detail})` : ""} — authentication/channel failures are ` +
        `never noise (inbound-contract-design §9.4).`,
    );
    this.name = "InboundDeliveryFailError";
  }
}

interface InboundAttemptResult {
  matched: boolean;
  parsed?: unknown;
  /** Matcher classification for poll_attempt diagnosis (§9.4). */
  classification: string;
  /** Matched delivery's receipt time (epoch ms) — `within` evidence. */
  receivedAt?: number;
}

/**
 * ONE inbound attempt (design §9.3): walk the receiver's unclaimed snapshot
 * in receiver order (oldest first) through the adapter matcher; the FIRST
 * terminal classification wins — matched claims and exits, a fail class
 * throws (§9.4a #4). Pre-existing deliveries are allowed evidence
 * (§9.4a #3) — eligibility is "unclaimed", not "received after poll start".
 */
function runInboundAttempt(
  node: PollNode,
  state: unknown,
  ctx: TestContext,
): InboundAttemptResult {
  const inbound = node.inbound!;
  const ref = node.ref!;
  const label = node.meta.id;
  const adapter = getAdapter(ref.protocol);
  if (!adapter?.matchInboundCase) {
    throw new Error(
      `workflow poll "${label}": adapter for protocol "${ref.protocol}" does ` +
        `not implement matchInboundCase — it cannot await inbound deliveries.`,
    );
  }
  const handle = inbound.via(state) as {
    deliveries?: unknown;
    claim?: unknown;
  } | null;
  if (
    !handle ||
    typeof handle.deliveries !== "function" ||
    typeof handle.claim !== "function"
  ) {
    throw new Error(
      `workflow poll "${label}": \`via\` did not resolve to a ReceiverHandle ` +
        `(needs deliveries() and claim()) — put the live handle in state ` +
        `during setup and select it with a pure lens.`,
    );
  }
  const caseSpec = (ref.contract._spec as { cases?: Record<string, unknown> })
    ?.cases?.[ref.caseKey];
  if (!caseSpec) {
    throw new Error(
      `workflow poll "${label}": case "${ref.caseKey}" not found in contract "${ref.contractId}"`,
    );
  }
  // Delivery-less preflight (§9.4 row P): an EMPTY inbox must not let an
  // unknown scheme / missing secret exhaust as a timeout — the matcher's own
  // preflight only runs when a delivery exists (codex I3 R3 P2).
  adapter.preflightInboundCase?.({ caseSpec, secrets: ctx.secrets });
  // Both correlate sides resolve via EXTRACTED paths (safe traversal) — a
  // lens call (`s => s.a.b`) throws on a missing intermediate. Event side:
  // missing path = type-mismatch probe (the matcher walks it). State side:
  // state is OURS and deterministic, so a missing/undefined correlation
  // value is an authoring bug — fail fast with a named error instead of
  // letting `undefined === undefined` match someone else's event or probing
  // silently to exhaustion (the missing-operand rule, same as eqPath).
  let correlate: { eventPath: readonly string[]; stateValue: unknown } | undefined;
  if (inbound.correlate) {
    const stateValue = resolvePath(state, inbound.correlate.statePath);
    if (stateValue === undefined) {
      throw new Error(
        `workflow poll "${label}": correlate.state resolved \`undefined\` at ` +
          `path "${inbound.correlate.statePath.join(".")}" — the value to ` +
          `correlate on must be in state before the poll starts.`,
      );
    }
    correlate = { eventPath: inbound.correlate.eventPath, stateValue };
  }

  type Handle = { deliveries(): readonly { id: string; receivedAt: number }[]; claim(id: string): void };
  let last: InboundAttemptResult = { matched: false, classification: "no-delivery" };
  for (const delivery of (handle as Handle).deliveries()) {
    const result = adapter.matchInboundCase({
      caseSpec,
      delivery: delivery as Parameters<NonNullable<typeof adapter.matchInboundCase>>[0]["delivery"],
      secrets: ctx.secrets,
      correlate,
    });
    if (result.kind === "matched") {
      (handle as Handle).claim(delivery.id);
      return {
        matched: true,
        parsed: result.parsed,
        classification: "matched",
        receivedAt: delivery.receivedAt,
      };
    }
    if (
      result.kind === "signature-invalid" ||
      result.kind === "stale" ||
      result.kind === "unparseable"
    ) {
      throw new InboundDeliveryFailError(result.kind, label, result.detail);
    }
    last = { matched: false, classification: result.kind };
  }
  return last;
}

/**
 * Evaluate the poll exit predicate. L2 declarative reads the RESPONSE (shared
 * `evalPredicate`, subject = response — the single predicate engine, same as
 * branch). An opaque `untilRuntime` gets `(ctx, res, state)` and is awaited; a
 * non-boolean result is rejected (same rule + wording as branch `whenRuntime`).
 * Deliberately NOT the flow's `evalPollExit`: that helper's error text names the
 * legacy `pollFn`/`pollAsync` API, which is deleted before release (no-compat).
 */
async function evalUntil(
  node: PollNode,
  response: unknown,
  ctx: TestContext,
  state: unknown,
): Promise<boolean> {
  const until = node.until;
  if ((until as { kind?: unknown }).kind === "opaque") {
    // The quarantined predicate ctx prototype-chains to the node scope's ctx, so
    // `signal` and observability resolve through it — the WorkflowContext cast is
    // sound at runtime (same seam as the branch predicate).
    const result = await (until as PollOpaqueUntil).fn(
      ctx as WorkflowContext,
      response,
      state,
    );
    if (typeof result !== "boolean") {
      throw new Error(
        `workflow poll "${node.meta.id}": untilRuntime must return a boolean, got ${typeof result}`,
      );
    }
    return result;
  }
  return evalPredicate(until as BranchPredicate<unknown>, response);
}

/**
 * The bounded attempt loop — a port of the flow's `runPollStep`
 * (contract-core.ts:1449-1569) onto the workflow node scope. Each attempt runs
 * request + exit predicate in their own quarantined ctxs over `scope.ctx`
 * (§17 #3):
 *   - satisfy (until=true)    → flush reqCtx, return the response (caller applies `out`);
 *   - probe (until=false)     → DISCARD reqCtx (pending validation noise);
 *   - in-budget fail/throw    → flush the throwing ctx (the deliberate failure lands), rethrow;
 *   - orphan (budget timeout) → DISCARD that ctx (a timed-out attempt cannot corrupt the run);
 *   - exhaust (any bound)     → throw PollExhaustedError (the node fails).
 * The predicate ctx is flushed after EVERY in-budget evaluation — its traces and
 * deliberate asserts are observability/intent, not probe noise (§17 #3). Both the
 * request and the predicate are budget-raced, so the loop is bounded even when
 * the adapter ignores `signal`.
 */
async function pollLoop(node: PollNode, state: unknown, scope: NodeScope): Promise<unknown> {
  const label = node.meta.id;
  // `as any`/JS callers can hand a poll node with neither attempt source —
  // executeCallAttempt would crash on an undefined ref; fail fast instead.
  if (!node.ref && !node.attemptFn) {
    throw new Error(`workflow poll "${label}": needs a contract ref (.poll) or an attempt fn (.pollAction)`);
  }
  // Inbound polls have no exit predicate — matched IS the exit (§9.4a); every
  // other poll requires one (an exit-predicate-less poll loops for nothing).
  if (!node.inbound && !node.until) {
    throw new Error(`workflow poll "${label}": needs an exit predicate — \`until\` (declarative) or \`untilRuntime\``);
  }
  // Epoch anchor for `within` evidence (receivedAt is epoch ms; §9.4a #3 —
  // the delta may be negative for deliveries that beat the poll start).
  const pollStartEpochMs = Date.now();
  // Runtime bound guard — the builder validates at construction, but `as any` /
  // JS callers can hand the executor an unbounded poll node. Fail fast instead of
  // looping forever (mirrors runPollStep's guard).
  validatePollBounds(
    {
      timeout: node.timeoutMs,
      maxAttempts: node.maxAttempts,
      perAttemptTimeout: node.perAttemptTimeoutMs,
      every: node.every,
      backoff: node.backoff,
    },
    label,
  );
  // Defaults for as-any/JS callers — the builder already applies them (a missing
  // `every` would hot-loop; `delay * undefined` is NaN).
  const everyMs = node.every ?? DEFAULT_EVERY_MS;
  const backoffFactor = node.backoff ?? 1;
  const now = (): number => performance.now();
  const start = now();
  const deadline = node.timeoutMs !== undefined ? start + node.timeoutMs : Infinity;
  const perAttempt = node.perAttemptTimeoutMs ?? Infinity;
  let attempt = 0;
  let delay = everyMs;
  let lastRes: unknown;

  for (;;) {
    attempt += 1;
    const remainingTotal = deadline - now();
    if (remainingTotal <= 0) {
      throw new PollExhaustedError(label, attempt - 1, "total timeout reached before next attempt");
    }
    const attemptBudget = Math.min(perAttempt, remainingTotal); // build-time validation ⇒ finite
    const attemptStart = now();

    // Request: quarantined ctx + per-attempt abort signal; budget-raced so a
    // non-honoring adapter can't block past the budget.
    const attemptAc = new AbortController();
    let budgetAborted = false;
    const budgetTimer = Number.isFinite(attemptBudget)
      ? setTimeout(() => {
          budgetAborted = true;
          attemptAc.abort();
        }, Math.max(0, attemptBudget))
      : undefined;
    // The attempt ctx: quarantined over the node scope, with `signal` =
    // THIS attempt's budget abort (an attemptFn reads ctx.signal; a contract
    // attempt gets the same signal explicitly).
    const reqCtx = Object.assign(quarantinedCtx(scope.ctx), { signal: attemptAc.signal });
    const exhausted = (): PollExhaustedError =>
      new PollExhaustedError(label, attempt, `attempt budget ${Math.round(attemptBudget)}ms exceeded`);
    try {
      // Attempt source: inbound await (design §9.3 — scan the receiver
      // snapshot through the adapter matcher), pollAction probe (addendum
      // §4), or a contract-call attempt. Same quarantine, same budget race.
      const attemptRun = node.inbound
        ? Promise.resolve(runInboundAttempt(node, state, reqCtx))
        : node.attemptFn
          ? Promise.resolve(node.attemptFn(reqCtx as unknown as WorkflowContext, state))
          : executeCallAttempt("poll", node as CallLikeNode, reqCtx, state, attemptAc.signal);
      lastRes = await raceBudget(attemptRun, attemptBudget, exhausted);
    } catch (err) {
      // Once OUR budget timer fired, the attempt is over budget no matter HOW
      // the cancelled body rejects — an AbortError from a signal-honoring
      // adapter, or (pollAction takes arbitrary fns — codex S2.11 R1 P2) a
      // plain Error thrown from an abort handler. Either way the rejection is
      // the cancellation's echo, not an in-budget verdict: normalize to poll
      // exhaustion and DISCARD the orphan's buffered evidence.
      const isBudgetAbort = budgetAborted && !(err instanceof PollExhaustedError);
      // A genuine IN-BUDGET request error (incl. fatal validation / ctx.fail)
      // flushes its buffered effects (the failure assertion lands) then fails
      // the poll; budget overruns discard the orphan ctx.
      if (!isBudgetAbort && !(err instanceof PollExhaustedError)) reqCtx.flushTo(scope.ctx);
      emitPollAttempt(
        scope.ctx,
        node,
        attempt,
        "failed",
        now() - attemptStart,
        err instanceof InboundDeliveryFailError
          ? { classification: err.classification }
          : undefined,
      );
      throw isBudgetAbort ? exhausted() : err;
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer);
    }

    // A sync-heavy request the timer couldn't preempt may have overrun — re-check.
    if (now() > deadline) throw new PollExhaustedError(label, attempt, "total timeout reached");
    if (now() - attemptStart > perAttempt) throw new PollExhaustedError(label, attempt, "attempt budget exceeded");

    let done: boolean;
    let inboundDetail: { classification: string; withinDeltaMs?: number } | undefined;
    if (node.inbound) {
      // Inbound: matched IS the exit (§9.4a) — no predicate, no predCtx.
      const res = lastRes as InboundAttemptResult;
      done = res.matched;
      inboundDetail = {
        classification: res.classification,
        ...(res.matched && res.receivedAt !== undefined
          ? { withinDeltaMs: res.receivedAt - pollStartEpochMs }
          : {}),
      };
    } else {
      // Exit predicate — quarantined ctx, budget-raced, flushed only on in-budget completion.
      const predBudget = Math.min(deadline - now(), perAttempt - (now() - attemptStart));
      const predCtx = quarantinedCtx(scope.ctx);
      try {
        done = await raceBudget(
          evalUntil(node, lastRes, predCtx, state),
          Math.max(0, predBudget),
          () => new PollExhaustedError(label, attempt, "exit-predicate budget exceeded"),
        );
      } catch (err) {
        // Timed-out predicate orphan → discard predCtx. An in-budget predicate that
        // threw (ctx.fail / ctx.skip / a thrown error) → flush its buffered effects
        // (the failure assertion lands) then propagate (the poll fails / skips).
        if (!(err instanceof PollExhaustedError)) predCtx.flushTo(scope.ctx);
        emitPollAttempt(scope.ctx, node, attempt, "failed", now() - attemptStart);
        throw err;
      }
      if (now() > deadline) throw new PollExhaustedError(label, attempt, "total timeout reached");
      if (now() - attemptStart > perAttempt) throw new PollExhaustedError(label, attempt, "attempt budget exceeded");
      predCtx.flushTo(scope.ctx); // in-budget: the user's deliberate skip/fail/assert count (§17 #3)
    }

    if (done) {
      reqCtx.flushTo(scope.ctx); // satisfying attempt: final-response validation failures surface
      emitPollAttempt(scope.ctx, node, attempt, "satisfied", now() - attemptStart, inboundDetail);
      // The satisfying inbound result hands `out` the PARSED, schema-validated
      // body (§9.4a) — the wrapper is loop machinery, not user data.
      return node.inbound ? (lastRes as InboundAttemptResult).parsed : lastRes;
    }
    // probe (not satisfied): reqCtx discarded (pending validation noise).
    emitPollAttempt(scope.ctx, node, attempt, "probe", now() - attemptStart, inboundDetail);

    if (node.maxAttempts && attempt >= node.maxAttempts) {
      throw new PollExhaustedError(label, attempt, "maxAttempts reached");
    }
    // A wait that would cross the deadline is pointless — fail now, don't sleep.
    if (Number.isFinite(deadline) && now() + delay >= deadline) {
      throw new PollExhaustedError(label, attempt, "next wait would exceed timeout");
    }
    await sleep(delay);
    delay = Math.min(delay * backoffFactor, BACKOFF_CAP_MS);
  }
}

/**
 * Run a poll node (§17 #3): a leaf with its OWN bounds (it does not take the
 * generic per-node timeout, §17 #4) — so like branch it owns its bracket instead
 * of going through runNode. The loop runs under the node scope; quarantine policy
 * is layered: per-attempt buffered ctxs (flush/discard, §17 #3) over the node
 * scope (late-evidence seal, §17 #12). On satisfy the `out` lens folds the
 * response into state (commit-on-success, §17 #13); on exhaustion / a deliberate
 * in-budget failure the node fails; a predicate/adapter `ctx.skip()` with no
 * prior failure skips the node (→ whole workflow, same as every other node).
 */
async function runPollNode(
  baseCtx: TestContext,
  workflowId: string,
  node: PollNode,
  state: unknown,
  outcomes: WorkflowNodeOutcome[],
): Promise<NodeListOutcome> {
  const staticGrade = staticGradeOf(node);
  const started = Date.now();
  emitNodeStart(baseCtx, node);

  const ac = new AbortController();
  const scope = makeNodeScope(baseCtx, ac.signal);

  let status: NodeStatus;
  let nextState = state;
  let cause: unknown;
  let errForEvent: unknown;
  let skipReason: string | undefined;
  try {
    const res = await withActiveNodeCtx(scope.ctx, () => pollLoop(node, state, scope));
    if (scope.hasFailure()) {
      // The satisfying attempt's flushed evidence (or an earlier in-budget
      // predicate assert) recorded a soft failure → the node fails and `out` is
      // NOT applied (an out lens assumes the validated success shape — same rule
      // as runContractCall, codex S2.1 R7).
      status = "failed";
      cause = new WorkflowPhaseFailedError(workflowId, `poll "${node.meta.id}"`);
    } else {
      // `out` REPLACES state; absent/void `out` preserves it (§17 #2). Reject a
      // thenable so async/I/O can't hide inside the lens (§17 #11; mirrors call).
      const next = node.out ? node.out(state, res) : undefined;
      if (isThenable(next)) {
        throw new Error(
          `workflow poll "${node.meta.id}": \`out\` returned a thenable — out must be a ` +
            `pure synchronous lens (state, res) => state; do async work in .action()`,
        );
      }
      nextState = next === undefined ? state : next;
      status = "passed";
    }
  } catch (err) {
    if (err instanceof GlubeanSkipError && !scope.hasFailure()) {
      // deliberate ctx.skip() (predicate or adapter, in-budget, no prior failure)
      // → skip the poll (→ whole workflow), NOT a failure.
      status = "skipped";
      skipReason = err.reason;
    } else if (err instanceof GlubeanSkipError) {
      // skip AFTER a soft failure → the failure wins; never surface the skip.
      status = "failed";
      cause = new WorkflowPhaseFailedError(workflowId, `poll "${node.meta.id}"`);
    } else {
      status = "failed";
      cause = err;
      errForEvent = err;
    }
  }

  // Seal BEFORE aborting (abort listeners that emit must be quarantined too —
  // same ordering as runNode's timeout path). Abort on any non-success so
  // signal-aware work the node started observes it; a passed poll's attempts are
  // already settled (per-attempt signals own in-flight aborts).
  scope.seal();
  if (status !== "passed" && !ac.signal.aborted) ac.abort();

  const grade = promoteGrade(staticGrade, scope);
  outcomes.push({ id: node.meta.id, status, grade });
  emitNodeEnd(baseCtx, node, status, grade, Date.now() - started, errForEvent);
  if (status === "passed") return { state: nextState, status };
  if (status === "failed") return { state, status, cause };
  return { state, status, skipReason };
}

/**
 * Run a node LIST with fail-stop / skip-stop + commit-on-success state threading
 * (§17 #5/#13). Shared by the top-level graph and each branch side (recursion). A
 * non-passed node stops the list; the rest are emitted `skipped`.
 */
async function runNodeList(
  baseCtx: TestContext,
  workflowId: string,
  list: readonly WorkflowNode[],
  state: unknown,
  outcomes: WorkflowNodeOutcome[],
): Promise<NodeListOutcome> {
  for (let i = 0; i < list.length; i++) {
    const node = list[i];
    const r =
      node.kind === "branch"
        ? await runBranch(baseCtx, workflowId, node as BranchNode, state, outcomes)
        : node.kind === "poll"
          ? await runPollNode(baseCtx, workflowId, node as PollNode, state, outcomes)
          : node.kind === "group"
            ? await runGroup(baseCtx, workflowId, node as GroupNode, state, outcomes)
            : await runLeafNode(baseCtx, workflowId, node, state, outcomes);
    state = r.state;
    if (r.status === "passed") {
      // A terminal route completed: the trunk ends here (§9 #5). Anything
      // smuggled after it (the builder forbids it; `as any` can't) is reported
      // skipped, never executed.
      if (r.terminal) {
        emitNodesSkipped(baseCtx, list, outcomes, i + 1);
        return r;
      }
      continue;
    }
    emitNodesSkipped(baseCtx, list, outcomes, i + 1); // rest of THIS list → skipped
    return r;
  }
  return { state, status: "passed" };
}

/**
 * Run a `.group()` node — a DISPLAY-ONLY container (phase4 §2, owner-decided):
 * members execute sequentially on the trunk's state exactly as if the group
 * wrapper were absent; deleting the group changes nothing about execution.
 * The group adds ONLY a node_start/node_end bracket so CLI/Cloud can render a
 * collapsible section. Aggregate status precedence: failed > skipped > passed
 * (design-R2 — a member ctx.skip() must not render a "passed" bracket).
 * Grade = worst member RUNTIME grade (promotions included). Summary counts
 * MEMBERS, not the bracket (kind:"group" on node_end is the discriminator).
 * No own lifecycle, no timeout, no retry — those were rejected at build time.
 */
async function runGroup(
  baseCtx: TestContext,
  workflowId: string,
  node: GroupNode,
  state: unknown,
  outcomes: WorkflowNodeOutcome[],
): Promise<NodeListOutcome> {
  const started = Date.now();
  emitNodeStart(baseCtx, node);
  const before = outcomes.length;
  const r = await runNodeList(baseCtx, workflowId, node.nodes, state, outcomes);
  // Worst DIRECT-member grade — same scope as staticGradeOf(group), which
  // folds direct children only (a branch member contributes its DECISION
  // grade; its case sub-graphs are tallied independently, S2.4a R4). Folding
  // descendants here would let a skipped opaque side DOWNGRADE the bracket
  // below its static floor (codex S2.14 R1 P2) — runtime may only promote.
  const directIds = new Set(node.nodes.map((n) => n.meta.id));
  const RANK: Record<ProjectionGrade, number> = { full: 0, partial: 1, trace: 2, opaque: 3 };
  let grade: ProjectionGrade = "full";
  for (let i = before; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (directIds.has(o.id) && RANK[o.grade] > RANK[grade]) grade = o.grade;
  }
  if (node.nodes.length === 0) grade = staticGradeOf(node);
  outcomes.push({ id: node.meta.id, status: r.status, grade });
  emitNodeEnd(baseCtx, node, r.status, grade, Date.now() - started);
  return r;
}

/**
 * Execute a built `Workflow` against a host `TestContext`. setup runs INSIDE the
 * protected region so teardown ALWAYS runs — even when setup throws (§17 #1, the
 * opposite of runFlow). Nodes run in authored order with fail-stop: a non-passed
 * node stops the rest (emitted `skipped`). A node `ctx.skip()` skips the whole
 * workflow (mirrors the runner's whole-test skip); `meta.skip` opts the workflow
 * out entirely (discoverable, never executed). teardown sees the last committed
 * state + the failing cause; a teardown that throws is logged and never masks it.
 */
export async function runWorkflow<State = unknown>(
  wf: Workflow<State>,
  baseCtx: TestContext,
): Promise<WorkflowRunResult> {
  const nodes: WorkflowNodeOutcome[] = [];

  // --- workflow-level skip: discoverable but NEVER executed — no setup, no nodes,
  // --- no teardown; every node reported skipped (codex S2.1 R2). ---
  if (wf.meta.skip !== undefined) {
    emitNodesSkipped(baseCtx, wf.nodes, nodes, 0);
    return {
      status: "skipped",
      state: undefined,
      nodes,
      error: undefined,
      skipReason: wf.meta.skip,
    };
  }

  let state: unknown;
  let cause: unknown;
  let failed = false;
  let skipped = false; // setup or a node called ctx.skip() → the whole workflow is skipped
  let skipReason: string | undefined; // the authored ctx.skip(reason) (codex S2.5 R6)

  try {
    // --- setup: an async lifecycle node, SELF-CONTAINED — its throw / ctx.skip() /
    // --- soft-failure is classified here (no outer catch); on any non-success the
    // --- graph is skipped and we stop before the node loop. ---
    let proceed = true;
    if (wf.setup) {
      const { scope, ac } = deriveLifecycleScope(baseCtx);
      let setupResult: unknown;
      let setupError: unknown;
      let threw = false;
      try {
        // setup is an async lifecycle node — its terminal timeout (§17 #4)
        // budget-races the body; on expiry the run fails with the timeout as
        // the cause and the seal (below) quarantines any late evidence.
        const setupRun = Promise.resolve(
          withActiveNodeCtx(scope.ctx, () => wf.setup!(scope.ctx)),
        );
        setupResult =
          wf.setupTimeoutMs !== undefined
            ? await raceBudget(setupRun, wf.setupTimeoutMs, () =>
                new NodeTimeoutError("setup", wf.setupTimeoutMs as number),
              )
            : await setupRun;
      } catch (e) {
        threw = true;
        setupError = e;
      } finally {
        scope.seal();
      }
      const softFailed = scope.hasFailure();
      if (threw || softFailed) {
        ac.abort(); // failure/skip → cancel signal-aware work setup started (codex S2.1 R2)
        proceed = false;
        emitNodesSkipped(baseCtx, wf.nodes, nodes, 0);
        if (threw && setupError instanceof GlubeanSkipError && !softFailed) {
          // deliberate setup ctx.skip() with no prior failure → whole workflow
          // skipped, like a node skip (codex S2.1 R3 P2).
          skipped = true;
          skipReason = setupError.reason;
        } else {
          // a thrown error, or a soft failure (possibly then a skip) → run fails.
          // A skip after a soft failure is NOT the cause (failure wins, mirroring the
          // node path); use the real thrown error, else synthesize a phase failure —
          // never surface the skip as the cause (codex S2.1 R5 P2).
          failed = true;
          cause =
            setupError && !(setupError instanceof GlubeanSkipError)
              ? setupError
              : new WorkflowPhaseFailedError(wf.meta.id, "setup");
        }
      } else {
        state = setupResult; // commit-on-success (§17 #13)
      }
    }

    // --- walk nodes in authored order; fail-stop / skip-stop (§17 #5 basic). The
    // --- graph + each branch side share runNodeList (commit-on-success threading,
    // --- §17 #13; node ctx.skip() → whole-workflow skip, mirrors harness.ts:1944). ---
    if (proceed) {
      const r = await runNodeList(baseCtx, wf.meta.id, wf.nodes, state, nodes);
      state = r.state;
      if (r.status === "failed") {
        failed = true;
        cause = r.cause;
      } else if (r.status === "skipped") {
        skipped = true;
        skipReason = r.skipReason;
      }
    }
  } finally {
    // --- teardown: ALWAYS runs (§17 #1), sees the last committed state + cause ---
    if (wf.teardown) {
      const { scope, ac } = deriveLifecycleScope(baseCtx);
      let teardownThrew = false;
      try {
        const teardownRun = Promise.resolve(
          withActiveNodeCtx(scope.ctx, () =>
            wf.teardown!(scope.ctx, state as State | undefined, cause),
          ),
        );
        // teardown's terminal timeout (§17 #4): logged like any teardown
        // failure — it NEVER masks the primary cause (§17 #1).
        if (wf.teardownTimeoutMs !== undefined) {
          await raceBudget(teardownRun, wf.teardownTimeoutMs, () =>
            new NodeTimeoutError("teardown", wf.teardownTimeoutMs as number),
          );
        } else {
          await teardownRun;
        }
      } catch (teardownErr) {
        teardownThrew = true;
        // Logged, NEVER masks the primary cause (§17 #1).
        baseCtx.log?.(`workflow "${wf.meta.id}" teardown failed: ${String(teardownErr)}`);
      } finally {
        scope.seal();
        // Abort on failure so signal-aware cleanup work is cancelled, mirroring the
        // node/setup failure path (codex S2.1 R2).
        if (teardownThrew || scope.hasFailure()) ac.abort();
      }
    }
  }

  return {
    status: failed ? "failed" : skipped ? "skipped" : "passed",
    state,
    nodes,
    error: cause,
    ...(skipped && skipReason !== undefined ? { skipReason } : {}),
  };
}
