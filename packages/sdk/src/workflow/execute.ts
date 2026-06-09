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
import type {
  ActionNode,
  CheckNode,
  ProjectionGrade,
  StaticGrade,
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
   * when the body returned void/undefined (§17 #2). */
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

/** Dispatch a node's body. S2.0 runs only the ctx-bearing async nodes. */
function runBody(node: WorkflowNode, ctx: WorkflowContext, state: unknown): Promise<unknown> {
  switch (node.kind) {
    case "action":
      return Promise.resolve((node as ActionNode).fn(ctx, state));
    case "check":
      // A check returns void → it never changes state (resolve to `undefined` so
      // the caller's §17 #2 "void preserves" rule keeps the prior state).
      return Promise.resolve((node as CheckNode).fn(ctx, state)).then(() => undefined);
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
    const body = runBody(node, scope.ctx, state);
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
    emitNodeEnd(base, node, "failed", grade, Date.now() - started, err);
    return { status: "failed", state, grade, error: err };
  }
}
