import type { ContractCaseRef } from "../contract-types.js";
import type {
  ActionNode,
  ActionProjection,
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
 * Normalize a step's first argument into a `NodeMeta`. A string is shorthand for
 * the node `id` (mirrors `workflow(id)`); an object is spread as-is. `id` falls
 * back to `name` then to a positional `node-${index}`; `name` defaults to `id`.
 */
function normalizeNodeMeta(input: NodeMetaInput, index: number): NodeMeta {
  const m = typeof input === "string" ? { id: input } : { ...input };
  const id = m.id ?? m.name ?? `node-${index}`;
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
  /** Finalize into a `Workflow`. */
  build(): Workflow<State>;
}

class WorkflowBuilderImpl<State> implements WorkflowBuilder<State> {
  private _meta: WorkflowMeta;
  private _setup?: WorkflowSetup<any>;
  private _teardown?: WorkflowTeardown<any>;
  private readonly _nodes: WorkflowNode[] = [];

  constructor(meta: WorkflowMeta) {
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
      meta: normalizeNodeMeta(idOrMeta, this._nodes.length),
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
      meta: normalizeNodeMeta(idOrMeta, this._nodes.length),
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
      meta: normalizeNodeMeta(idOrMeta, this._nodes.length),
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
      meta: normalizeNodeMeta(idOrMeta, this._nodes.length),
      fn: fn as unknown as ComputeNode<State>["fn"],
    };
    this._nodes.push(node as WorkflowNode);
    return this;
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
