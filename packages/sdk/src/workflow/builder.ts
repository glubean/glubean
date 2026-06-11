import type { ContractCaseRef } from "../contract-types.js";
import { predicateScope, assertL2Predicate } from "../contract-flow-condition.js";
import type {
  BranchPredicate,
  OpaquePredicate,
  PredicateScope,
} from "../contract-flow-condition.js";
import { validatePollBounds, DEFAULT_EVERY_MS } from "../contract-flow-poll.js";
import { registerTest } from "../internal.js";
import type { Test, TestContext } from "../types.js";
import { runWorkflow, validateRetryMeta, WorkflowPhaseFailedError } from "./execute.js";
import { projectWorkflow } from "./project.js";
import type {
  ActionNode,
  ActionProjection,
  BranchCase,
  BranchCaseValue,
  BranchNode,
  BuiltWorkflow,
  CheckNode,
  CheckProjection,
  ComputeNode,
  ContractCallNode,
  NodeMeta,
  NodeMetaInput,
  PollNode,
  PollOpaqueUntil,
  RetryMeta,
  WorkflowContext,
  WorkflowMeta,
  WorkflowNode,
  WorkflowSetup,
  WorkflowTeardown,
} from "./types.js";

/**
 * A branch-family side: STRICT-S convergence (addendum §9 #1) — the sub-chain
 * must return to the trunk's State, so a side that forgets `...s` is caught at
 * the branch line instead of exploding as runtime `undefined` downstream. The
 * managed-shape rule (§9 #3): sides don't invent shape, they fill slots the
 * trunk pre-declared (optional fields / one tagged-union FIELD — never a
 * whole-state union).
 */
export type StrictSide<State> = (b: WorkflowBuilder<State>) => WorkflowBuilder<State>;

/**
 * `.branch()` options (addendum §9) — a declarative `when` (L2, statically
 * projectable → `full`) XOR a runtime `whenRuntime` (opaque, requires
 * `message`). `then`/`else` are STRICT-S sub-builders over the same state.
 */
export type BranchOpts<State> =
  | {
      when: (w: PredicateScope<State>) => BranchPredicate<State>;
      whenRuntime?: never;
      message?: string;
      then: StrictSide<State>;
      else?: StrictSide<State>;
    }
  | {
      when?: never;
      whenRuntime: (ctx: WorkflowContext, state: State) => boolean | Promise<boolean>;
      message: string;
      then: StrictSide<State>;
      else?: StrictSide<State>;
    };

/**
 * `.switch()` options (addendum §9 #4) — the full heir of flow's
 * switchOn/switchCond: value mode (`on` lens + literal case table) XOR
 * predicate mode (ordered L2 predicates, first-match). One method, option-key
 * split. Every case is STRICT-S; `default` is OPTIONAL = identity pass-through.
 * Case predicates are L2-only (a clean decision table — an opaque N-way gate
 * is a nested `branch` with `whenRuntime`, not a switch).
 */
export type SwitchOpts<State> =
  | {
      /** value mode: pure lens state → a JSON-scalar discriminant. */
      on: (state: State) => BranchCaseValue | undefined;
      cases: ReadonlyArray<{ value: BranchCaseValue; then: StrictSide<State>; label?: string }>;
      default?: StrictSide<State>;
    }
  | {
      on?: never;
      /** predicate mode: ordered, possibly-overlapping L2 predicates; first-match. */
      cases: ReadonlyArray<{
        when: (w: PredicateScope<State>) => BranchPredicate<State>;
        then: StrictSide<State>;
        label?: string;
      }>;
      default?: StrictSide<State>;
    };

/**
 * `.route()` options (addendum §9 #5) — the N-way TERMINAL tree. Cases are
 * UNCONSTRAINED (`(b) => WorkflowBuilder<any>`): no downstream trunk exists to
 * lie to, so strict-S has nothing to protect. `default` is REQUIRED (a
 * no-match must be defined). After `.route()` only `.teardown()/.build()`.
 */
export type RouteOpts<State> =
  | {
      on: (state: State) => BranchCaseValue | undefined;
      cases: ReadonlyArray<{
        value: BranchCaseValue;
        then: (b: WorkflowBuilder<State>) => WorkflowBuilder<any>;
        label?: string;
      }>;
      default: (b: WorkflowBuilder<State>) => WorkflowBuilder<any>;
    }
  | {
      on?: never;
      cases: ReadonlyArray<{
        when: (w: PredicateScope<State>) => BranchPredicate<State>;
        then: (b: WorkflowBuilder<State>) => WorkflowBuilder<any>;
        label?: string;
      }>;
      default: (b: WorkflowBuilder<State>) => WorkflowBuilder<any>;
    };

/**
 * What `.route()` returns: the workflow is a terminal tree now — paths own
 * their futures, no trunk continues. Only cleanup and finalization remain.
 * `teardown` is typed against the TRUNK State: at runtime it receives the
 * taken leaf's state (the union of leaf states) — common trunk fields stay
 * accessible without narrowing, which §9 accepts as the contained compromise
 * at the last station.
 */
export interface TerminalWorkflowBuilder<State> {
  teardown(fn: WorkflowTeardown<State>): TerminalWorkflowBuilder<State>;
  build(): BuiltWorkflow<State>;
}

/**
 * `.poll()` exit predicate (proposal §6.7) — a declarative `until` over the
 * RESPONSE (L2, statically projectable → `full`) XOR a runtime `untilRuntime`
 * (opaque, requires `message`; gets ctx + response + state). Mirrors branch's
 * `when`/`whenRuntime` split: the two forms cannot share one key because both
 * are functions and the builder cannot soundly tell them apart.
 */
export type PollUntil<State, Res> =
  | {
      until: (w: PredicateScope<Res>) => BranchPredicate<Res>;
      untilRuntime?: never;
      message?: string;
    }
  | {
      until?: never;
      untilRuntime: (
        ctx: WorkflowContext,
        res: Res,
        state: State,
      ) => boolean | Promise<boolean>;
      message: string;
    };

/**
 * `.poll()` bounds — validated at build time (`validatePollBounds`): a total
 * stop condition (`timeout` | `maxAttempts`) AND a finite single-attempt budget
 * (`timeout` | `perAttemptTimeout`) are BOTH required, so a poll can never hang
 * unbounded. `every` defaults to 1s; `backoff` to 1 (fixed interval).
 */
export interface PollBounds {
  /** Interval between attempts (ms). Default 1000. */
  every?: number;
  /** Multiplier applied to the interval after each attempt (>= 1). Default 1. */
  backoff?: number;
  /** Total wall-clock bound (ms). */
  timeout?: number;
  /** Per-attempt budget (ms) — required when `timeout` is absent. */
  perAttemptTimeout?: number;
  /** Max attempts (>= 1). */
  maxAttempts?: number;
}

/** `.poll()` options when the polled case needs NO logical input. */
export type PollOpts<
  State,
  NewState,
  CaseOutput,
  RawOutcome,
  AcceptKey,
  Accept extends ReadonlyArray<AcceptKey> = never,
> = PollUntil<State, CallResponse<Accept, CaseOutput, RawOutcome>> &
  PollBounds & {
    /** Pure lens folding the SATISFYING response into the next state. */
    out?: (state: State, res: CallResponse<Accept, CaseOutput, RawOutcome>) => NewState;
    /** Accepted alternate outcome keys (poll-on-status needs this). */
    accept?: Accept;
  };

/** `.poll()` options when the polled case REQUIRES input — `in` is mandatory. */
export type PollOptsWithInput<
  State,
  NewState,
  CaseInputs,
  CaseOutput,
  RawOutcome,
  AcceptKey,
  Accept extends ReadonlyArray<AcceptKey> = never,
> = PollOpts<State, NewState, CaseOutput, RawOutcome, AcceptKey, Accept> & {
  /** Pure lens: workflow state → the case's logical input (required). */
  in: (state: State) => CaseInputs;
};

/**
 * Normalize a step's first argument into a `NodeMeta`. A string is shorthand for
 * the node `id` (mirrors `workflow(id)`); an object is spread as-is. `id` falls
 * back to `name` then to a positional `${idPrefix}node-${index}`; `name` defaults
 * to `id`. `idPrefix` keeps anonymous-fallback ids unique inside branch sides
 * (each side collects with its own positional counter — codex S2.4a R7).
 */
function normalizeNodeMeta(input: NodeMetaInput, index: number, idPrefix = ""): NodeMeta {
  const m = typeof input === "string" ? { id: input } : { ...input };
  const id = m.id ?? m.name ?? `${idPrefix}node-${index}`;
  return { ...m, id, name: m.name ?? id };
}

/**
 * vNext `workflow()` authoring builder (Phase 1 surface). Emits the runtime node
 * graph (`./types`); execution + projection live elsewhere. Group / use / each /
 * pick come in later phases — the IR already reserves them.
 *
 * No backward compatibility: this is a fresh self-consistent surface (2026-06-09).
 */

/**
 * `out`'s `res` type: the typed PRIMARY outcome by default, widened to the raw
 * multi-status outcome ONLY when `accept` is set (the caller must then narrow on
 * status). Mirrors `contract.flow().step` (codex slice-1 P2 parity).
 */
type CallResponse<Accept, CaseOutput, RawOutcome> = [Accept] extends [never]
  ? CaseOutput
  : RawOutcome;

/** Step bindings when the called case needs NO logical input. */
export interface CallBindings<
  State,
  NewState,
  CaseOutput,
  RawOutcome,
  AcceptKey,
  Accept extends ReadonlyArray<AcceptKey> = never,
> {
  /** Pure lens folding the response into the next state. */
  out?: (state: State, res: CallResponse<Accept, CaseOutput, RawOutcome>) => NewState;
  /** Accepted alternate outcome keys to branch on (adapter-specific; HTTP: statuses). */
  accept?: Accept;
  /** Explicit-intent retry (§17 #7) — `reason` is required (documents why replay is safe). */
  retry?: RetryMeta;
}

/** Step bindings when the called case REQUIRES input — `in` is mandatory. */
export interface CallBindingsWithInput<
  State,
  NewState,
  CaseInputs,
  CaseOutput,
  RawOutcome,
  AcceptKey,
  Accept extends ReadonlyArray<AcceptKey> = never,
> extends CallBindings<State, NewState, CaseOutput, RawOutcome, AcceptKey, Accept> {
  /** Pure lens: workflow state → the case's logical input (required). */
  in: (state: State) => CaseInputs;
}

export interface WorkflowBuilder<State> {
  /** Merge workflow-level metadata (id is fixed at creation). */
  meta(meta: Omit<Partial<WorkflowMeta>, "id">): WorkflowBuilder<State>;
  /** The one I/O-capable initializer; its return is the initial state. */
  setup<S>(fn: WorkflowSetup<S>): WorkflowBuilder<S>;
  /** Always-run cleanup (see lifecycle decision in the plan's self-consistency corpus). */
  teardown(fn: WorkflowTeardown<State>): WorkflowBuilder<State>;
  /**
   * Use a reusable contract interaction. First arg: node id or `{...NodeMeta}`.
   * Preserves the case's generics (codex slice-1 P2): when the case requires
   * input, `in` is mandatory; `out`'s `res` and `accept` are typed from the ref.
   */
  call<
    CaseInputs,
    CaseOutput,
    AcceptKey,
    RawOutcome,
    Accept extends ReadonlyArray<AcceptKey> = never,
    NewState = State,
  >(
    idOrMeta: NodeMetaInput,
    ref: ContractCaseRef<CaseInputs, CaseOutput, AcceptKey, RawOutcome>,
    ...rest: [CaseInputs] extends [void]
      ? [bindings?: CallBindings<State, NewState, CaseOutput, RawOutcome, AcceptKey, Accept>]
      : [bindings: CallBindingsWithInput<State, NewState, CaseInputs, CaseOutput, RawOutcome, AcceptKey, Accept>]
  ): WorkflowBuilder<NewState>;
  /**
   * Arbitrary ASYNC state-producing glue (graded partial w/ hints, else opaque).
   * A void-returning action PRESERVES the state type; a value-returning one
   * transitions it (codex slice-1 P2 — uses the `Promise<void>` overload trick
   * so a value-returning action can't be swallowed by the void overload).
   */
  action(
    idOrMeta: NodeMetaInput,
    fn: (ctx: WorkflowContext, state: State) => Promise<void>,
    opts?: { project?: ActionProjection; retry?: RetryMeta },
  ): WorkflowBuilder<State>;
  action<NewState>(
    idOrMeta: NodeMetaInput,
    fn: (ctx: WorkflowContext, state: State) => Promise<NewState>,
    opts?: { project?: ActionProjection; retry?: RetryMeta },
  ): WorkflowBuilder<NewState>;
  /** Arbitrary assertion (graded partial w/ asserts hint, else opaque/trace). */
  check(
    idOrMeta: NodeMetaInput,
    fn: (ctx: WorkflowContext, state: State) => void | Promise<void>,
    opts?: { project?: CheckProjection },
  ): WorkflowBuilder<State>;
  /**
   * Pure SYNCHRONOUS state transform. First arg: node id or `{...NodeMeta}`.
   * Async callbacks are rejected at RUNTIME (the impl throws) — route async work
   * through `.action()` (codex slice-1 P2).
   */
  compute<NewState = State>(
    idOrMeta: NodeMetaInput,
    fn: (state: State) => NewState,
  ): WorkflowBuilder<NewState>;
  /**
   * 2-way branch (§6.6): run `then` when the predicate holds, else `else`. ONLY the
   * taken side executes; the other is reported `skipped` (§17 #6). Declarative `when`
   * projects to `full`; runtime `whenRuntime` is opaque and needs a `message`. The
   * branch does not change the State type — sub-graph state writes apply at runtime.
   */
  branch(idOrMeta: NodeMetaInput, opts: BranchOpts<State>): WorkflowBuilder<State>;
  /**
   * N-way CONVERGING dispatch (addendum §9 #4) — the heir of flow's
   * switchOn/switchCond. Value mode (`on` lens + literal case table, ===) XOR
   * predicate mode (ordered L2 predicates, first-match). Every case is
   * STRICT-S; `default` is optional = identity pass-through. Only the taken
   * case executes; the rest are reported skipped (§17 #6).
   */
  switch(idOrMeta: NodeMetaInput, opts: SwitchOpts<State>): WorkflowBuilder<State>;
  /**
   * N-way TERMINAL tree (addendum §9 #5) — paths own their futures; no trunk
   * continues. Cases are unconstrained (`(b) => WorkflowBuilder<any>`);
   * `default` is REQUIRED. Returns a terminal builder allowing only
   * `.teardown()/.build()`. teardown sees the taken leaf's runtime state
   * (typed against the trunk State — §9's contained compromise).
   */
  route(idOrMeta: NodeMetaInput, opts: RouteOpts<State>): TerminalWorkflowBuilder<State>;
  /**
   * Bounded poll-until (§6.7, §17 #3): repeat ONE contract case until the exit
   * predicate over the RESPONSE holds. Declarative `until` projects to `full`;
   * runtime `untilRuntime` is opaque and needs a `message`. Bounds are validated
   * at build time (total stop condition AND finite per-attempt budget). Probe
   * attempts' assertion noise is quarantined; only the satisfying attempt's
   * evidence (and any in-budget deliberate failure) lands on the run.
   */
  poll<
    CaseInputs,
    CaseOutput,
    AcceptKey,
    RawOutcome,
    Accept extends ReadonlyArray<AcceptKey> = never,
    NewState = State,
  >(
    idOrMeta: NodeMetaInput,
    ref: ContractCaseRef<CaseInputs, CaseOutput, AcceptKey, RawOutcome>,
    ...rest: [CaseInputs] extends [void]
      ? [opts: PollOpts<State, NewState, CaseOutput, RawOutcome, AcceptKey, Accept>]
      : [opts: PollOptsWithInput<State, NewState, CaseInputs, CaseOutput, RawOutcome, AcceptKey, Accept>]
  ): WorkflowBuilder<NewState>;
  /**
   * Finalize into a `BuiltWorkflow`: the Workflow IR + a one-element `Test[]`
   * (a simple test that executes the graph via `runWorkflow`), registered for
   * discovery. Idempotent — repeat calls return the same handle. The builder
   * auto-builds on a microtask (mirrors `contract.flow()`), so an exported,
   * never-built builder is still discovered and registered.
   */
  build(): BuiltWorkflow<State>;
}

class WorkflowBuilderImpl<State> implements WorkflowBuilder<State> {
  /** Discovery marker — the runner's resolver auto-builds exported builders. */
  readonly __glubean_type = "workflow-builder";

  private _meta: WorkflowMeta;
  private _setup?: WorkflowSetup<any>;
  private _teardown?: WorkflowTeardown<any>;
  private readonly _nodes: WorkflowNode[] = [];
  private _built?: BuiltWorkflow<State>;
  /** The first authoring error, if any — a poisoned builder never finalizes. */
  private _poisoned?: unknown;
  /** Set by `.route()` — the tree is terminal; only teardown/build may follow. */
  private _terminated?: string;

  constructor(
    meta: WorkflowMeta,
    private readonly _idPrefix = "",
    /** Child builders (branch/poll sub-graphs) never finalize/register. */
    private readonly _isChild = false,
  ) {
    this._meta = meta;
    // Auto-finalize via microtask (mirrors contract.flow()/TestBuilder): an
    // exported, never-built workflow still registers for discovery. A poisoned
    // builder (a chained call threw) must NOT auto-build — registering the
    // partial graph would leak a phantom workflow into discovery when the
    // author caught the error (codex S2.5 R3 P2).
    if (!_isChild) {
      queueMicrotask(() => {
        if (!this._built && this._poisoned === undefined) this.build();
      });
    }
  }

  // Wraps every authoring mutator: a throw from validation (invalid poll
  // bounds, sub-builder build(), …) leaves the graph half-authored, so it
  // poisons the builder — build()/auto-build then refuse instead of
  // registering the partial graph (codex S2.5 R3 P2). A post-build mutation
  // throw does NOT poison: the registered graph is complete and stays valid.
  private authoring<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (!this._built) this._poisoned ??= e;
      throw e;
    }
  }

  meta(meta: Omit<Partial<WorkflowMeta>, "id">): WorkflowBuilder<State> {
    return this.authoring(() => {
      this.assertNotBuilt("meta");
      this._meta = { ...this._meta, ...meta, id: this._meta.id };
      return this;
    });
  }

  setup<S>(fn: WorkflowSetup<S>): WorkflowBuilder<S> {
    return this.authoring(() => {
      this.assertNotBuilt("setup");
      // setup runs first at execution, so authoring it after a node OR after
      // teardown would make the advertised state type dishonest (codex slice-1 P2).
      if (this._nodes.length > 0 || this._teardown) {
        throw new Error(
          "workflow.setup() must be called before any step (call/action/check/compute) or teardown",
        );
      }
      this._setup = fn;
      return this as unknown as WorkflowBuilder<S>;
    });
  }

  teardown(fn: WorkflowTeardown<State>): WorkflowBuilder<State> {
    return this.authoring(() => {
      this.assertNotBuilt("teardown");
      this._teardown = fn;
      return this;
    });
  }

  // A finalized workflow is immutable — its Test/registry entry already
  // captured the graph; a later mutation would be silently dropped.
  private assertNotBuilt(method: string): void {
    if (this._built) {
      throw new Error(
        `workflow.${method}() called after build() — the workflow is already finalized`,
      );
    }
  }

  // teardown receives the FINAL state, so no step may follow it (else its
  // callback is authored against a stale state type) (codex slice-1 P2).
  // A `.route()` terminal tree likewise allows no further graph nodes (§9 #5).
  private assertNoTeardown(method: string): void {
    this.assertNotBuilt(method);
    if (this._terminated) {
      throw new Error(
        `workflow.${method}() cannot follow ${this._terminated} — a route is terminal; ` +
          `only .teardown()/.build() may come after`,
      );
    }
    if (this._teardown) {
      throw new Error(
        `workflow.${method}() cannot be added after .teardown() — teardown must be the last step`,
      );
    }
  }

  // Impl uses a broad `...rest` + `any` return so it satisfies the interface's
  // generic conditional-tuple signature; call-site type-checking uses the precise
  // interface signature, not this one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call(idOrMeta: NodeMetaInput, ref: ContractCaseRef, ...rest: any[]): any {
    return this.authoring(() => {
      this.assertNoTeardown("call");
      const meta = normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix);
      const bindings = rest[0] as
        | {
            in?: (state: State) => unknown;
            out?: (state: State, res: unknown) => unknown;
            accept?: ReadonlyArray<string | number>;
            retry?: RetryMeta;
          }
        | undefined;
      if (bindings?.retry) validateRetryMeta(bindings.retry, meta.id);
      const node: ContractCallNode<State> = {
        kind: "contract-call",
        meta,
        ref,
        in: bindings?.in,
        out: bindings?.out as ContractCallNode<State>["out"],
        accept: bindings?.accept,
        retry: bindings?.retry,
      };
      this._nodes.push(node as WorkflowNode);
      return this;
    });
  }

  // Broad impl satisfies both action overloads; call sites use the interface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  action(
    idOrMeta: NodeMetaInput,
    fn: (ctx: WorkflowContext, state: State) => Promise<unknown>,
    opts?: { project?: ActionProjection; retry?: RetryMeta },
  ): any {
    return this.authoring(() => {
      this.assertNoTeardown("action");
      const meta = normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix);
      if (opts?.retry) validateRetryMeta(opts.retry, meta.id);
      const node: ActionNode<State> = {
        kind: "action",
        meta,
        fn: fn as ActionNode<State>["fn"],
        project: opts?.project,
        retry: opts?.retry,
      };
      this._nodes.push(node as WorkflowNode);
      return this;
    });
  }

  check(
    idOrMeta: NodeMetaInput,
    fn: (ctx: WorkflowContext, state: State) => void | Promise<void>,
    opts?: { project?: CheckProjection },
  ): WorkflowBuilder<State> {
    return this.authoring(() => {
      this.assertNoTeardown("check");
      const node: CheckNode<State> = {
        kind: "check",
        meta: normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix),
        fn: fn as CheckNode<State>["fn"],
        project: opts?.project,
      };
      this._nodes.push(node as WorkflowNode);
      return this;
    });
  }

  // Broad impl returns `any` to satisfy the interface's conditional return type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  compute(idOrMeta: NodeMetaInput, fn: (state: State) => unknown): any {
    return this.authoring(() => {
      this.assertNoTeardown("compute");
      // Catch the common async case here (compute is modeled/projected as a
      // synchronous `full` transform; an async fn would store a Promise-returning
      // fn — codex slice-1 P2). A sync fn that still RETURNS a promise
      // (`() => Promise.resolve(x)`) can't be caught at build time (the fn isn't
      // invoked here); TODO(executor): thenable-check the compute result at run
      // time and fail the node.
      if (fn?.constructor?.name === "AsyncFunction") {
        throw new Error(
          "workflow.compute() must be synchronous — use .action() for async work",
        );
      }
      const node: ComputeNode<State> = {
        kind: "compute",
        meta: normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix),
        fn: fn as unknown as ComputeNode<State>["fn"],
      };
      this._nodes.push(node as WorkflowNode);
      return this;
    });
  }

  branch(idOrMeta: NodeMetaInput, opts: BranchOpts<State>): WorkflowBuilder<State> {
    return this.authoring(() => {
      this.assertNoTeardown("branch");
      const meta = normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix);
      // 2-way sugar over the branch-family IR (addendum §9): one predicate case
      // (then) + default (else). Prefix each side's anonymous-fallback ids with
      // the branch id + side so flat outcome/projection ids stay unique (S2.4a R7).
      const node: BranchNode<State> = {
        kind: "branch",
        meta,
        mode: "predicate",
        message: opts.message,
        cases: [
          {
            when: this.buildBranchPredicate(opts),
            label: "then",
            nodes: this.collectSubNodes(opts.then, `${meta.id}.then.`),
          },
        ],
        default: opts.else ? this.collectSubNodes(opts.else, `${meta.id}.else.`) : undefined,
      };
      this._nodes.push(node as WorkflowNode);
      return this;
    });
  }

  // Broad impls satisfy the interface signatures; call sites type-check against
  // the precise interface, not these.
  switch(idOrMeta: NodeMetaInput, opts: SwitchOpts<State>): WorkflowBuilder<State> {
    return this.authoring(() => {
      this.assertNoTeardown("switch");
      const meta = normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix);
      const node: BranchNode<State> = {
        kind: "branch",
        meta,
        ...this.buildFamilyDecision("switch", meta.id, opts),
        default: opts.default
          ? this.collectSubNodes(opts.default, `${meta.id}.default.`)
          : undefined, // optional = identity pass-through (addendum §9 #4)
      };
      this._nodes.push(node as WorkflowNode);
      return this;
    });
  }

  route(idOrMeta: NodeMetaInput, opts: RouteOpts<State>): TerminalWorkflowBuilder<State> {
    return this.authoring(() => {
      this.assertNoTeardown("route");
      const meta = normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix);
      // route's default is REQUIRED (a no-match must be defined — §9 #5); the
      // types enforce it, but `as any`/JS callers can omit it.
      if (typeof opts.default !== "function") {
        throw new Error(
          `workflow.route() "${meta.id}" requires a \`default\` case — a no-match path must be defined`,
        );
      }
      const node: BranchNode<State> = {
        kind: "branch",
        meta,
        ...this.buildFamilyDecision("route", meta.id, opts),
        default: this.collectSubNodes(opts.default, `${meta.id}.default.`),
        terminal: true,
      };
      this._nodes.push(node as WorkflowNode);
      // The tree is terminal: only teardown/build may follow (§9 #5).
      this._terminated = `route "${meta.id}"`;
      return this as TerminalWorkflowBuilder<State>;
    });
  }

  // Shared switch/route decision lowering: value mode (on lens + literal table,
  // === match) XOR predicate mode (ordered L2, first-match). Case sub-graphs
  // collect under `<id>.<label>.` prefixes; labels derive from explicit label →
  // String(value) → positional case-N.
  private buildFamilyDecision(
    method: "switch" | "route",
    nodeId: string,
    opts: SwitchOpts<State> | RouteOpts<State>,
  ): Pick<BranchNode<State>, "mode" | "on" | "cases"> {
    if (!Array.isArray(opts.cases) || opts.cases.length === 0) {
      throw new Error(`workflow.${method}() "${nodeId}" requires at least one case`);
    }
    const valueMode = typeof opts.on === "function";
    const cases: BranchCase[] = opts.cases.map((c, i) => {
      const raw = c as {
        value?: BranchCaseValue;
        when?: (w: PredicateScope<State>) => BranchPredicate<State>;
        then: (b: WorkflowBuilder<State>) => unknown;
        label?: string;
      };
      if (valueMode) {
        const v = raw.value;
        if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
          throw new Error(
            `workflow.${method}() "${nodeId}" case ${i}: value mode requires a JSON-scalar \`value\` ` +
              `(string | number | boolean | null); got ${typeof v}`,
          );
        }
        const label = raw.label ?? String(v);
        return { value: v, label, nodes: this.collectSubNodes(raw.then, `${nodeId}.${label}.`) };
      }
      if (typeof raw.when !== "function") {
        throw new Error(
          `workflow.${method}() "${nodeId}" case ${i}: predicate mode requires a declarative \`when\``,
        );
      }
      const pred = raw.when(predicateScope<State>());
      // switch/route case predicates are L2-only — a clean decision table
      // (addendum §9 #4); an opaque N-way gate is a nested branch+whenRuntime.
      assertL2Predicate(pred, method);
      const label = raw.label ?? `case-${i}`;
      return { when: pred, label, nodes: this.collectSubNodes(raw.then, `${nodeId}.${label}.`) };
    });
    // Duplicate value-mode literals would make later cases unreachable — fail
    // fast (mirrors the unreachable-case spirit of a real switch).
    if (valueMode) {
      const seen = new Set<string>();
      for (const c of cases) {
        const key = `${typeof c.value}:${String(c.value)}`;
        if (seen.has(key)) {
          throw new Error(
            `workflow.${method}() "${nodeId}": duplicate case value ${JSON.stringify(c.value)} — later case is unreachable`,
          );
        }
        seen.add(key);
      }
    }
    return valueMode
      ? { mode: "value", on: (opts as { on: (s: State) => unknown }).on, cases }
      : { mode: "predicate", cases };
  }

  // Broad impl satisfies the interface's conditional-tuple signature; call sites
  // type-check against the precise interface signature, not this one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  poll(idOrMeta: NodeMetaInput, ref: ContractCaseRef, ...rest: any[]): any {
    return this.authoring(() => {
      this.assertNoTeardown("poll");
      const meta = normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix);
      const opts = rest[0] as
        | (PollUntil<State, unknown> &
            PollBounds & {
              in?: (state: State) => unknown;
              out?: (state: State, res: unknown) => unknown;
              accept?: ReadonlyArray<string | number>;
            })
        | undefined;
      // The type system requires opts (until XOR untilRuntime), but JS / `as any`
      // callers can omit it — an exit-predicate-less poll would loop to exhaustion
      // for nothing, so fail fast here.
      if (!opts || (typeof opts.until !== "function" && typeof opts.untilRuntime !== "function")) {
        throw new Error(
          `workflow.poll() "${meta.id}" requires an exit predicate — \`until\` (declarative) or \`untilRuntime\``,
        );
      }
      validatePollBounds(
        {
          timeout: opts.timeout,
          maxAttempts: opts.maxAttempts,
          perAttemptTimeout: opts.perAttemptTimeout,
          every: opts.every,
          backoff: opts.backoff,
        },
        meta.id,
      );
      const node: PollNode<State> = {
        kind: "poll",
        meta,
        ref,
        in: opts.in,
        out: opts.out as PollNode<State>["out"],
        accept: opts.accept,
        until: this.buildPollUntil(opts),
        message: opts.message,
        every: opts.every ?? DEFAULT_EVERY_MS,
        backoff: opts.backoff ?? 1,
        timeoutMs: opts.timeout,
        perAttemptTimeoutMs: opts.perAttemptTimeout,
        maxAttempts: opts.maxAttempts,
      };
      this._nodes.push(node as WorkflowNode);
      return this;
    });
  }

  // Build the poll exit predicate: an L2 declarative tree over the RESPONSE
  // (validated + projectable) or an opaque wrapper. Mirrors buildBranchPredicate,
  // including the conservative `sync: false` (we cannot statically prove an
  // untilRuntime fn is synchronous — codex S2.4a P2 applies identically here).
  private buildPollUntil(
    opts: PollUntil<State, unknown>,
  ): BranchPredicate<unknown> | PollOpaqueUntil<State> {
    if (opts.until) {
      const pred = opts.until(predicateScope<unknown>());
      assertL2Predicate(pred, "poll");
      return pred;
    }
    if (typeof opts.message !== "string" || opts.message.length === 0) {
      throw new Error(
        "workflow.poll() with untilRuntime requires a non-empty `message`",
      );
    }
    return {
      kind: "opaque",
      sync: false,
      fn: opts.untilRuntime as PollOpaqueUntil<State>["fn"],
    };
  }

  // Build the branch predicate: an L2 declarative tree (validated + projectable) or
  // an L1/L0 opaque wrapper. Reuses the flow condition model (no second predicate
  // engine). `whenRuntime` requires a `message` (projection/diagnostics).
  private buildBranchPredicate(
    opts: BranchOpts<State>,
  ): BranchPredicate<State> | OpaquePredicate {
    if (opts.when) {
      const pred = opts.when(predicateScope<State>());
      assertL2Predicate(pred, "branch");
      return pred;
    }
    const wr = opts.whenRuntime;
    if (typeof opts.message !== "string" || opts.message.length === 0) {
      throw new Error(
        "workflow.branch() with whenRuntime requires a non-empty `message`",
      );
    }
    return {
      kind: "opaque",
      // whenRuntime's return type allows `Promise<boolean>`, so we CANNOT statically
      // prove it's synchronous — inferring sync from the constructor name is dishonest
      // for `() => Promise.resolve(x)`. Project conservatively as L0 / may-do-async-IO
      // (codex S2.4a P2). A future split (whenRuntime L1 vs whenRuntimeAsync L0) could
      // recover the L1 distinction; the runtime awaits either way.
      sync: false,
      fn: wr as OpaquePredicate["fn"],
    };
  }

  // Collect a then/else sub-graph by running its callback on a fresh child builder.
  // A branch side may NOT declare setup/teardown (those are workflow-scoped).
  private collectSubNodes(
    fn: (b: WorkflowBuilder<State>) => unknown,
    idPrefix: string,
  ): WorkflowNode[] {
    const child = new WorkflowBuilderImpl<State>({ id: this._meta.id }, idPrefix, true);
    const result = fn(child);
    // An async then/else callback would snapshot child._nodes BEFORE its post-await
    // steps are added — silently dropping them. Reject thenables (codex S2.4a R5).
    if (result && typeof (result as { then?: unknown }).then === "function") {
      throw new Error(
        "workflow.branch() then/else callback must be synchronous — an async callback " +
          "loses any steps added after an await",
      );
    }
    if (child._setup || child._teardown) {
      throw new Error("workflow.branch() then/else cannot declare setup/teardown");
    }
    // A poisoned child holds a half-authored side (the callback caught an
    // authoring error on it) — accepting its nodes would smuggle the partial
    // graph past the parent's poison protection (codex S2.5 R4 P2). This throw
    // runs inside the parent's authoring() wrapper, so the parent poisons too.
    if (child._poisoned !== undefined) {
      const causeMsg =
        child._poisoned instanceof Error ? child._poisoned.message : String(child._poisoned);
      throw new Error(
        `workflow.branch() then/else side is half-authored — a sub-builder call failed: ${causeMsg}`,
      );
    }
    return child._nodes.slice();
  }

  build(): BuiltWorkflow<State> {
    // A branch/poll sub-builder is not an independent workflow: building one
    // would register a bogus top-level entry under the parent id carrying only
    // the side's nodes (codex S2.5 R2 P2). The sub-graph belongs to its parent.
    if (this._isChild) {
      throw new Error(
        "workflow.build() cannot be called on a branch/poll sub-builder — " +
          "return the builder chain from the callback instead",
      );
    }
    if (this._built) return this._built; // idempotent — one Test, one registration
    // A poisoned builder holds a half-authored graph (a chained call threw and
    // the author caught it) — registering/executing it would be a phantom
    // workflow (codex S2.5 R3 P2).
    if (this._poisoned !== undefined) {
      const causeMsg =
        this._poisoned instanceof Error ? this._poisoned.message : String(this._poisoned);
      throw new Error(
        `workflow "${this._meta.id}" cannot build — an earlier authoring call failed: ${causeMsg}`,
      );
    }
    const meta = this._meta;

    // The single simple Test that executes the graph (mirrors the flow's
    // wrapping, contract-core.ts:1236). The WORKFLOW VERDICT is authoritative:
    // a failed run rethrows its cause (a thrown-node failure leaves no failed
    // assertion on the host, so the test must fail via the error); a skipped
    // run skips the test (whole-workflow skip, matching the harness contract).
    const wfTest: Test = {
      meta: {
        id: meta.id,
        name: meta.name ?? meta.id,
        ...(meta.tags ? { tags: meta.tags } : {}),
        ...(meta.description ? { description: meta.description } : {}),
        // `WorkflowMeta.skip: string` (the reason) → `TestMeta.deferred: string`
        // mirrors the flow convention so reporters render the reason consistently.
        ...(meta.skip !== undefined ? { deferred: meta.skip } : {}),
        ...(meta.only !== undefined ? { only: meta.only } : {}),
      },
      type: "simple",
      fn: async (ctx: TestContext) => {
        // No early meta.skip exit here: runWorkflow owns the meta.skip branch
        // and emits each authored node as `skipped` — an explicitly-run
        // deferred workflow keeps its per-node timeline evidence (codex S2.5
        // R1 P2). The skipped verdict then skips the wrapped test below.
        const result = await runWorkflow(handle, ctx);
        if (result.status === "skipped") {
          // Prefer the user-authored runtime ctx.skip(reason) (codex S2.5 R6),
          // then the authored meta.skip, then a generic fallback.
          ctx.skip(result.skipReason ?? meta.skip ?? `workflow "${meta.id}" skipped`);
        }
        if (result.status === "failed") {
          throw result.error ?? new WorkflowPhaseFailedError(meta.id, "workflow");
        }
      },
    };

    // The handle IS both the Workflow IR (runWorkflow/projectWorkflow consume it
    // directly) and a one-element Test[] (the runner's array resolution discovers
    // it) — the same dual shape as contract.flow()'s FlowContract.
    const handle = Object.assign([wfTest], {
      __glubean_type: "workflow" as const,
      meta,
      setup: this._setup,
      teardown: this._teardown,
      nodes: this._nodes.slice(),
    }) as unknown as BuiltWorkflow<State>;

    // Pre-compute the graded projection ONCE; the registry entry and the
    // handle's `_projection` (the scanner's dep-free read, mirroring
    // FlowContract._extracted — S2.6) share the same object.
    const projection = projectWorkflow(handle);
    Object.assign(handle, { _projection: projection });

    // Register for scanner discovery with the full graded projection (§7) —
    // scanner/Cloud/agents read grades + call identity without executing.
    registerTest({
      id: meta.id,
      name: meta.name ?? meta.id,
      type: "simple",
      ...(meta.tags ? { tags: meta.tags } : {}),
      ...(meta.description ? { description: meta.description } : {}),
      workflow: projection,
    });

    this._built = handle;
    return handle;
  }
}

/** Create a workflow builder. `id` is required (string or `WorkflowMeta`). */
export function workflow(idOrMeta: string | WorkflowMeta): WorkflowBuilder<undefined> {
  const meta: WorkflowMeta =
    typeof idOrMeta === "string" ? { id: idOrMeta } : { ...idOrMeta };
  if (typeof meta.id !== "string" || meta.id.length === 0) {
    throw new Error("workflow(): a non-empty string id is required");
  }
  return new WorkflowBuilderImpl<undefined>(meta);
}
