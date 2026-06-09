import type { ContractCaseRef } from "../contract-types.js";
import { predicateScope, assertL2Predicate } from "../contract-flow-condition.js";
import type {
  BranchPredicate,
  OpaquePredicate,
  PredicateScope,
} from "../contract-flow-condition.js";
import type {
  ActionNode,
  ActionProjection,
  BranchNode,
  CheckNode,
  CheckProjection,
  ComputeNode,
  ContractCallNode,
  NodeMeta,
  NodeMetaInput,
  Workflow,
  WorkflowContext,
  WorkflowMeta,
  WorkflowNode,
  WorkflowSetup,
  WorkflowTeardown,
} from "./types.js";

/**
 * `.branch()` options (proposal §6.6) — a declarative `when` (L2, statically
 * projectable → `full`) XOR a runtime `whenRuntime` (opaque L1 sync / L0 async,
 * requires `message`). `then`/`else` are sub-builders over the same state.
 */
export type BranchOpts<State> =
  | {
      when: (w: PredicateScope<State>) => BranchPredicate<State>;
      whenRuntime?: never;
      message?: string;
      then: (b: WorkflowBuilder<State>) => unknown;
      else?: (b: WorkflowBuilder<State>) => unknown;
    }
  | {
      when?: never;
      whenRuntime: (ctx: WorkflowContext, state: State) => boolean | Promise<boolean>;
      message: string;
      then: (b: WorkflowBuilder<State>) => unknown;
      else?: (b: WorkflowBuilder<State>) => unknown;
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
 * graph (`./types`); execution + projection live elsewhere. Branch / poll /
 * group / use / each / pick come in later phases — the IR already reserves them.
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
    opts?: { project?: ActionProjection },
  ): WorkflowBuilder<State>;
  action<NewState>(
    idOrMeta: NodeMetaInput,
    fn: (ctx: WorkflowContext, state: State) => Promise<NewState>,
    opts?: { project?: ActionProjection },
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
  /** Finalize into a `Workflow`. */
  build(): Workflow<State>;
}

class WorkflowBuilderImpl<State> implements WorkflowBuilder<State> {
  private _meta: WorkflowMeta;
  private _setup?: WorkflowSetup<any>;
  private _teardown?: WorkflowTeardown<any>;
  private readonly _nodes: WorkflowNode[] = [];

  constructor(
    meta: WorkflowMeta,
    private readonly _idPrefix = "",
  ) {
    this._meta = meta;
  }

  meta(meta: Omit<Partial<WorkflowMeta>, "id">): WorkflowBuilder<State> {
    this._meta = { ...this._meta, ...meta, id: this._meta.id };
    return this;
  }

  setup<S>(fn: WorkflowSetup<S>): WorkflowBuilder<S> {
    // setup runs first at execution, so authoring it after a node OR after
    // teardown would make the advertised state type dishonest (codex slice-1 P2).
    if (this._nodes.length > 0 || this._teardown) {
      throw new Error(
        "workflow.setup() must be called before any step (call/action/check/compute) or teardown",
      );
    }
    this._setup = fn;
    return this as unknown as WorkflowBuilder<S>;
  }

  teardown(fn: WorkflowTeardown<State>): WorkflowBuilder<State> {
    this._teardown = fn;
    return this;
  }

  // teardown receives the FINAL state, so no step may follow it (else its
  // callback is authored against a stale state type) (codex slice-1 P2).
  private assertNoTeardown(method: string): void {
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
    this.assertNoTeardown("call");
    const bindings = rest[0] as
      | {
          in?: (state: State) => unknown;
          out?: (state: State, res: unknown) => unknown;
          accept?: ReadonlyArray<string | number>;
        }
      | undefined;
    const node: ContractCallNode<State> = {
      kind: "contract-call",
      meta: normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix),
      ref,
      in: bindings?.in,
      out: bindings?.out as ContractCallNode<State>["out"],
      accept: bindings?.accept,
    };
    this._nodes.push(node as WorkflowNode);
    return this;
  }

  // Broad impl satisfies both action overloads; call sites use the interface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  action(
    idOrMeta: NodeMetaInput,
    fn: (ctx: WorkflowContext, state: State) => Promise<unknown>,
    opts?: { project?: ActionProjection },
  ): any {
    this.assertNoTeardown("action");
    const node: ActionNode<State> = {
      kind: "action",
      meta: normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix),
      fn: fn as ActionNode<State>["fn"],
      project: opts?.project,
    };
    this._nodes.push(node as WorkflowNode);
    return this;
  }

  check(
    idOrMeta: NodeMetaInput,
    fn: (ctx: WorkflowContext, state: State) => void | Promise<void>,
    opts?: { project?: CheckProjection },
  ): WorkflowBuilder<State> {
    this.assertNoTeardown("check");
    const node: CheckNode<State> = {
      kind: "check",
      meta: normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix),
      fn: fn as CheckNode<State>["fn"],
      project: opts?.project,
    };
    this._nodes.push(node as WorkflowNode);
    return this;
  }

  // Broad impl returns `any` to satisfy the interface's conditional return type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  compute(idOrMeta: NodeMetaInput, fn: (state: State) => unknown): any {
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
  }

  branch(idOrMeta: NodeMetaInput, opts: BranchOpts<State>): WorkflowBuilder<State> {
    this.assertNoTeardown("branch");
    const meta = normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix);
    // Prefix each side's anonymous-fallback ids with the branch id + side so the
    // flat outcome/projection ids stay unique (codex S2.4a R7).
    const node: BranchNode<State> = {
      kind: "branch",
      meta,
      when: this.buildBranchPredicate(opts),
      message: opts.message,
      then: this.collectSubNodes(opts.then, `${meta.id}.then.`),
      else: opts.else ? this.collectSubNodes(opts.else, `${meta.id}.else.`) : undefined,
    };
    this._nodes.push(node as WorkflowNode);
    return this;
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
    const child = new WorkflowBuilderImpl<State>({ id: this._meta.id }, idPrefix);
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
    return child._nodes.slice();
  }

  build(): Workflow<State> {
    return {
      __glubean_type: "workflow",
      meta: this._meta,
      setup: this._setup,
      teardown: this._teardown,
      nodes: this._nodes.slice(),
    };
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
