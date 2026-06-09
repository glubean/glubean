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
 * The pure-flow walk (setup/call/compute/teardown) lands in S2.1; branch/poll in
 * S2.4. `runNode` here executes only the `ctx`-bearing async nodes (action/check);
 * other kinds throw "not implemented yet" until their slice fills them in.
 */

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
import { evalPredicate } from "../contract-flow-condition.js";
import type { BranchPredicate, OpaquePredicate } from "../contract-flow-condition.js";
import { staticGradeOf } from "./project.js";
import type {
  ActionNode,
  BranchNode,
  CheckNode,
  ComputeNode,
  ContractCallNode,
  ProjectionGrade,
  StaticGrade,
  Workflow,
  WorkflowContext,
  WorkflowNode,
} from "./types.js";

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
  // KNOWN LIMITATION (codex S2.0 P2): `ctx.http` is a ky client pre-bound to the
  // ORIGINAL ctx at construction, so its auto-traces emit straight to `base`,
  // bypassing this scope's `trace` override. Two consequences for a node that
  // calls `ctx.http` directly (an action escape hatch — the contract-call path in
  // S2.1 instead hands the child ctx to `executeCaseInFlow`, whose traces DO route
  // through it): (1) an opaque HTTP action won't promote to `trace` (#10), and
  // (2) an HTTP response landing after the node seals can still leak past the #12
  // quarantine. TODO(S2.1+): rebind/wrap `ctx.http` onto the node scope so inline
  // HTTP obeys attribution + quarantine. Acceptable for this skeleton slice.
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

export interface RunNodeOptions {
  /** Static floor grade for this node (from the projector); promoted per §17 #10. */
  staticGrade: StaticGrade;
  /** Per-node terminal timeout (ms). Omit / non-finite = unbounded (§17 #4). */
  timeoutMs?: number;
}

function emitNodeStart(base: TestContext, node: WorkflowNode): void {
  const data: NodeStartEventData = {
    nodeId: node.meta.id,
    kind: node.kind,
    name: node.meta.name ?? node.meta.id,
  };
  base.event({ type: NODE_START_EVENT, data });
}

function emitNodeEnd(
  base: TestContext,
  node: WorkflowNode,
  status: NodeStatus,
  grade: ProjectionGrade,
  durationMs: number,
  error?: unknown,
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
  base.event({ type: NODE_END_EVENT, data });
}

/** True for a Promise or any Promise-like (`.then` is a function). */
function isThenable(v: unknown): boolean {
  return v != null && typeof (v as { then?: unknown }).then === "function";
}

/**
 * Invoke a contract case IN-GRAPH (§17 #8). Independent of the flow engine
 * (which gets deleted — plan fork a): dispatch through the PUBLIC adapter registry
 * and call the protocol-neutral `executeCaseInFlow`, handing it the per-node child
 * ctx + signal. `in` maps state → the case's logical input; `out` folds the raw
 * response back into state (no `out` → response discarded, state preserved, like
 * runFlow contract-core.ts:1625-1628). NOTE: `needs` validation + build-time
 * flow-safety (port of contract-core.ts:818) land in S2.3 (§17 #8).
 */
async function runContractCall(
  node: ContractCallNode,
  ctx: WorkflowContext,
  state: unknown,
  scope: NodeScope,
): Promise<unknown> {
  const adapter = getAdapter(node.ref.protocol);
  if (!adapter?.executeCaseInFlow) {
    throw new Error(
      `workflow call "${node.meta.id}": protocol "${node.ref.protocol}" ` +
        (adapter
          ? "does not implement executeCaseInFlow — it cannot be called in a workflow"
          : "has no registered adapter (did you import its contract plugin package?)"),
    );
  }
  // Third-party adapter veto: a protocol can reject specific cases from in-graph use
  // (§17 #8, the validateCaseForFlow half — a third-party slot; built-in adapters
  // don't implement it). Mirrors contract-core.ts:818.
  adapter.validateCaseForFlow?.(
    (node.ref.contract as { _spec?: unknown })._spec,
    node.ref.caseKey,
    node.ref.contractId,
  );

  // Validate the logical input against the case's `needs` schema at the call
  // boundary, exactly as runFlow does (contract-core.ts:1402-1427) — JS/`as any`
  // callers can't slip invalid inputs past the adapter, and Zod transforms/defaults
  // apply (codex S2.1 R4 P2; this is the needs half of §17 #8, brought forward).
  const contractSpec = (node.ref.contract as { _spec?: unknown })._spec as
    | { cases?: Record<string, { needs?: unknown }> }
    | undefined;
  const needsSchema = contractSpec?.cases?.[node.ref.caseKey]?.needs;
  const caseId = `${node.ref.contractId}.${node.ref.caseKey}`;
  if (needsSchema && typeof node.in !== "function") {
    throw new Error(
      `workflow call "${node.meta.id}": case "${caseId}" declares \`needs\` but the ` +
        `call has no \`in\` binding. Provide \`in: (state) => <logical input>\`.`,
    );
  }
  let resolvedInputs = node.in ? node.in(state) : undefined;
  // `in` is a PURE SYNCHRONOUS lens — reject a thenable so an async lens can't pass
  // a Promise to the adapter as the logical input (mirrors out/compute; codex S2.1 R7).
  if (isThenable(resolvedInputs)) {
    throw new Error(
      `workflow call "${node.meta.id}": \`in\` returned a thenable — in must be a ` +
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

  const res = await adapter.executeCaseInFlow({
    ctx,
    // The adapter owns the contract's concrete spec type; the ref carries the live
    // instance. Cast at this protocol-neutral seam (mirrors contract-core.ts:1431).
    contract: node.ref.contract as never,
    caseKey: node.ref.caseKey,
    resolvedInputs,
    ...(node.accept ? { accept: node.accept } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
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
    case "check":
      // A check returns void → it never changes state (resolve to `undefined` so
      // the caller's §17 #2 "void preserves" rule keeps the prior state).
      return Promise.resolve((node as CheckNode).fn(ctx, state)).then(() => undefined);
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

  emitNodeStart(base, node);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const hasTimeout = opts.timeoutMs != null && Number.isFinite(opts.timeoutMs);

  const settle = (): void => {
    // Order matters: seal BEFORE clearing the timer so a body that races the
    // timer can't slip an emission through the gap.
    scope.seal();
    if (timer !== undefined) clearTimeout(timer);
  };

  try {
    const body = runBody(node, scope.ctx, state, scope);
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

    const grade = promoteGrade(opts.staticGrade, scope);
    if (scope.hasFailure()) {
      // Body resolved but a soft assertion failed → node fails, no commit (§17 #13).
      // Abort the signal too (as timeout/throw do) so any cooperative work the node
      // started observes the failure and stops — the WorkflowContext signal contract.
      if (!ac.signal.aborted) ac.abort();
      emitNodeEnd(base, node, "failed", grade, Date.now() - started);
      return { status: "failed", state, grade };
    }
    // Success: return REPLACES state; void/undefined PRESERVES it (§17 #2 / #13).
    const nextState = returned === undefined ? state : returned;
    emitNodeEnd(base, node, "passed", grade, Date.now() - started);
    return { status: "passed", state: nextState, grade };
  } catch (err) {
    settle();
    // Ensure the body's signal fires even on a thrown (non-timeout) failure, so a
    // dangling async leg observes the abort.
    if (!ac.signal.aborted) ac.abort();
    const grade = promoteGrade(opts.staticGrade, scope);
    // `ctx.skip()` is control flow, not a failure: a node that deliberately skips
    // (and had no earlier failed assertion) settles `skipped`, NOT `failed` — a
    // failed assertion before the skip still wins (mirrors harness.ts:2297). The
    // skip is preserved on `err` so the caller (runWorkflow, S2.1) can decide its
    // graph-level meaning (skip the rest vs. continue); runNode only classifies.
    if (err instanceof GlubeanSkipError && !scope.hasFailure()) {
      emitNodeEnd(base, node, "skipped", grade, Date.now() - started);
      return { status: "skipped", state, grade, error: err };
    }
    // A skip thrown AFTER a soft failure is NOT the cause — the prior failure is.
    // Drop the skip so runWorkflow synthesizes a proper phase-failure cause; a real
    // thrown error / timeout stays as the cause (codex S2.1 R4 P3).
    const failError = err instanceof GlubeanSkipError ? undefined : err;
    emitNodeEnd(base, node, "failed", grade, Date.now() - started, failError);
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
  }
}

/** Outcome of running a node LIST (the top-level graph, or a branch side). */
interface NodeListOutcome {
  state: unknown;
  status: "passed" | "failed" | "skipped";
  /** Failure cause to thread to teardown (only when status === "failed"). */
  cause?: unknown;
}

/** Is this `when` an L1/L0 opaque predicate (vs an L2 declarative `BranchPredicate`)? */
function isOpaquePredicate(
  when: BranchPredicate<unknown> | OpaquePredicate,
): when is OpaquePredicate {
  return (when as { kind?: unknown }).kind === "opaque";
}

/**
 * Evaluate a branch predicate against state. L2 declarative → pure synchronous
 * `evalPredicate` (reused from the flow condition model). L1/L0 opaque → run its fn
 * under the branch's child ctx (it may read ctx + emit evidence; an L0 async fn is
 * awaited). A non-boolean opaque result is coerced with Boolean().
 */
async function selectBranch(
  node: BranchNode,
  state: unknown,
  ctx: WorkflowContext,
): Promise<boolean> {
  const when = node.when;
  if (isOpaquePredicate(when)) {
    const result = await when.fn(ctx, state);
    if (typeof result !== "boolean") {
      // The public type promises boolean; reject non-booleans rather than coercing
      // (a `'false'` string or a forgotten return would silently pick `then`) — codex S2.4a P2.
      throw new Error(
        `workflow branch "${node.meta.id}": whenRuntime must return a boolean, got ${typeof result}`,
      );
    }
    return result;
  }
  return evalPredicate(when as BranchPredicate<unknown>, state);
}

/** Run a single leaf (non-branch) node: runNode + push outcome + cause synthesis. */
async function runLeafNode(
  baseCtx: TestContext,
  workflowId: string,
  node: WorkflowNode,
  state: unknown,
  outcomes: WorkflowNodeOutcome[],
): Promise<NodeListOutcome> {
  const grade = staticGradeOf(node);
  const r = await runNode(baseCtx, node, state, { staticGrade: grade });
  outcomes.push({ id: node.meta.id, status: r.status, grade: r.grade });
  if (r.status === "passed") return { state: r.state, status: "passed" };
  if (r.status === "failed") {
    return {
      state,
      status: "failed",
      cause: r.error ?? new WorkflowPhaseFailedError(workflowId, `node "${node.meta.id}"`),
    };
  }
  return { state, status: "skipped" }; // node ctx.skip()
}

/**
 * Run a 2-way branch (§17 #6): evaluate the predicate (under a child ctx so an
 * opaque predicate's evidence is attributed + quarantined), then run ONLY the taken
 * side via runNodeList; the non-taken side is emitted as `skipped`. A predicate that
 * throws or soft-fails fails the branch node (both sides skipped).
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
  // The branch node's own outcome precedes its children (tree order); the final
  // status is set once the taken side settles.
  const outcomeIndex = outcomes.length;
  outcomes.push({ id: node.meta.id, status: "passed", grade });

  const ac = new AbortController();
  const scope = makeNodeScope(baseCtx, ac.signal);

  const failBoth = (cause: unknown, error?: unknown): NodeListOutcome => {
    ac.abort();
    emitNodesSkipped(baseCtx, node.then, outcomes, 0);
    if (node.else) emitNodesSkipped(baseCtx, node.else, outcomes, 0);
    const g = promoteGrade(grade, scope); // a soft-failed predicate may have emitted evidence (§17 #10)
    outcomes[outcomeIndex] = { id: node.meta.id, status: "failed", grade: g };
    emitNodeEnd(baseCtx, node, "failed", g, Date.now() - started, error);
    return { state, status: "failed", cause };
  };

  let taken: boolean;
  try {
    taken = await selectBranch(node, state, scope.ctx);
  } catch (err) {
    scope.seal();
    if (err instanceof GlubeanSkipError && !scope.hasFailure()) {
      // predicate ctx.skip() with no prior failure → skip the branch (→ whole
      // workflow, like a node skip), NOT a failure (codex S2.4a R5).
      ac.abort();
      emitNodesSkipped(baseCtx, node.then, outcomes, 0);
      if (node.else) emitNodesSkipped(baseCtx, node.else, outcomes, 0);
      const g = promoteGrade(grade, scope);
      outcomes[outcomeIndex] = { id: node.meta.id, status: "skipped", grade: g };
      emitNodeEnd(baseCtx, node, "skipped", g, Date.now() - started);
      return { state, status: "skipped" };
    }
    // a real throw, OR a soft-failure-then-skip → fail. A skip is never the cause;
    // synthesize a phase failure (mirrors runNode/setup, codex S2.4a R6).
    if (err instanceof GlubeanSkipError) {
      return failBoth(new WorkflowPhaseFailedError(workflowId, `branch "${node.meta.id}" predicate`));
    }
    return failBoth(err, err);
  }
  if (scope.hasFailure()) {
    // opaque predicate soft-failed (scoped assert/validate) — fail the branch.
    scope.seal();
    return failBoth(new WorkflowPhaseFailedError(workflowId, `branch "${node.meta.id}" predicate`));
  }
  scope.seal();

  // Emit children in AUTHORED order (then before else regardless of which is taken):
  // run the taken side, mark the other skipped — so outcomes/events align with the
  // projected tree, not with which branch was selected (codex S2.4a P2).
  let r: NodeListOutcome;
  if (taken) {
    r = await runNodeList(baseCtx, workflowId, node.then, state, outcomes);
    if (node.else) emitNodesSkipped(baseCtx, node.else, outcomes, 0);
  } else {
    emitNodesSkipped(baseCtx, node.then, outcomes, 0);
    r = node.else
      ? await runNodeList(baseCtx, workflowId, node.else, state, outcomes)
      : { state, status: "passed" };
  }

  // promote opaque→trace if the predicate emitted structured evidence, same as
  // runNode (§17 #10; codex S2.4a P2).
  const runtimeGrade = promoteGrade(grade, scope);
  outcomes[outcomeIndex] = { id: node.meta.id, status: r.status, grade: runtimeGrade };
  emitNodeEnd(baseCtx, node, r.status, runtimeGrade, Date.now() - started);
  return r;
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
        : await runLeafNode(baseCtx, workflowId, node, state, outcomes);
    state = r.state;
    if (r.status === "passed") continue;
    emitNodesSkipped(baseCtx, list, outcomes, i + 1); // rest of THIS list → skipped
    return r;
  }
  return { state, status: "passed" };
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
    return { status: "skipped", state: undefined, nodes, error: undefined };
  }

  let state: unknown;
  let cause: unknown;
  let failed = false;
  let skipped = false; // setup or a node called ctx.skip() → the whole workflow is skipped

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
        setupResult = await wf.setup(scope.ctx);
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
      }
    }
  } finally {
    // --- teardown: ALWAYS runs (§17 #1), sees the last committed state + cause ---
    if (wf.teardown) {
      const { scope, ac } = deriveLifecycleScope(baseCtx);
      let teardownThrew = false;
      try {
        await wf.teardown(scope.ctx, state as State | undefined, cause);
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
  };
}
