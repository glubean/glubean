import type { ContractCaseRef } from "../contract-types.js";
import { predicateScope, assertL2Predicate, selectorPath } from "../predicates.js";
import type {
  BranchPredicate,
  OpaquePredicate,
  PredicateScope,
} from "../predicates.js";
import { validatePollBounds, DEFAULT_EVERY_MS } from "../poll-primitives.js";
import { registerTest } from "../internal.js";
import { traceComputeFn } from "../contract-core.js";
import { interpolateTemplate, normalizeEachTable } from "../test/utils.js";
import type { Test, TestContext } from "../types.js";
import { runWorkflow, validateRetryMeta, WorkflowPhaseFailedError } from "./execute.js";
import { projectWorkflow } from "./project.js";
import type {
  ActionNode,
  GroupNode,
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
  InboundPollSpec,
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
export type StrictSide<State> = (b: WorkflowBuilder<State>) => ChainedWorkflowBuilder<State>;

/** Phantom brand for builders that came off a CHAIN CALL (not the raw side
 * parameter). Closes the block-body strict-S bypass (codex S2.8 R1 P1):
 * `then: b => { b.compute(reshape); return b; }` returned the parameter — the
 * type held while the collected nodes reshaped state. A strict side must now
 * return the chain itself (`b.compute(...)`, or `const c = b.x(); return c`),
 * never the bare parameter. Purely type-level — no runtime field exists.
 * (A deliberately forked chain — building twice off `b` and returning one —
 * still collects both; that is `as never` territory, same as every other
 * type-layer bypass.) */
declare const CHAINED: unique symbol;
export interface ChainedWorkflowBuilder<State> extends WorkflowBuilder<State> {
  readonly [CHAINED]: true;
}

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
  teardown(
    fn: WorkflowTeardown<State>,
    opts?: { timeout?: number; note?: string },
  ): TerminalWorkflowBuilder<State>;
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

/**
 * `.poll()` options for an INBOUND case ref (inbound-contract-design §9.3):
 * the counterparty calls US, so there is no `until` (matched IS the exit),
 * no `in`/`accept` (nothing is sent). `via` selects the live ReceiverHandle
 * from state; `correlate` pins WHICH instance (=== compare, both lenses
 * required together). `timeout` defaults from the case's `expect.within`.
 */
export type InboundPollOpts<State, NewState = State, Event = unknown> = PollBounds & {
  /** Pure lens: state → ReceiverHandle (put the handle in state during setup). */
  via: (state: State) => unknown;
  correlate?: {
    /** Lens over the PARSED delivery body. */
    event: (event: Event) => unknown;
    /** Lens over workflow state. */
    state: (state: State) => unknown;
  };
  /** Pure lens folding the parsed, schema-validated event into the next state. */
  out?: (state: State, event: Event) => NewState;
  until?: never;
  untilRuntime?: never;
  in?: never;
  accept?: never;
  message?: never;
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
 * Validate a per-node timeout (§17 #4) at build time. Only the ASYNC node
 * kinds accept one; `compute` is synchronous by contract and `poll`/the branch
 * family own their own bounds/decision semantics — a timeout there would be
 * dead config pretending to protect something.
 */
function validateNodeTimeout(meta: NodeMeta, kind: string): void {
  if (meta.timeout === undefined) return;
  if (kind !== "call" && kind !== "action" && kind !== "check") {
    throw new Error(
      `workflow.${kind}() "${meta.id}": \`timeout\` is not supported on ${kind} nodes — ` +
        (kind === "poll"
          ? "a poll owns its own bounds (timeout/perAttemptTimeout/maxAttempts)"
          : kind === "compute"
            ? "compute is synchronous by contract"
            : kind === "group"
              ? "a group is a display-only bracket; members carry their own timeouts"
              : "the branch family's decision has no timeout semantics"),
    );
  }
  if (typeof meta.timeout !== "number" || !Number.isFinite(meta.timeout) || meta.timeout <= 0) {
    throw new Error(
      `workflow.${kind}() "${meta.id}": \`timeout\` must be a finite number > 0 (ms); got ${String(meta.timeout)}`,
    );
  }
}

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
  meta(
    meta: Omit<Partial<WorkflowMeta>, "id" | "templateId" | "groupId" | "parallel">,
  ): ChainedWorkflowBuilder<State>;
  /** The one I/O-capable initializer; its return is the initial state.
   * `timeout` (ms, §17 #4) is TERMINAL — a timed-out setup fails the run. */
  setup<S>(fn: WorkflowSetup<S>, opts?: { timeout?: number; note?: string }): ChainedWorkflowBuilder<S>;
  /** Always-run cleanup (see lifecycle decision in the plan's self-consistency
   * corpus). `timeout` (ms, §17 #4) is TERMINAL — logged, never masks the cause. */
  teardown(
    fn: WorkflowTeardown<State>,
    opts?: { timeout?: number; note?: string },
  ): ChainedWorkflowBuilder<State>;
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
  ): ChainedWorkflowBuilder<NewState>;
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
  ): ChainedWorkflowBuilder<State>;
  action<NewState>(
    idOrMeta: NodeMetaInput,
    fn: (ctx: WorkflowContext, state: State) => Promise<NewState>,
    opts?: { project?: ActionProjection; retry?: RetryMeta },
  ): ChainedWorkflowBuilder<NewState>;
  /** Arbitrary assertion (graded partial w/ asserts hint, else opaque/trace). */
  /**
   * DECLARATIVE check (phase4 §7 / addendum §2): assertions as DATA — each
   * item is an L2 predicate over state, projects individually (grade: full)
   * and emits its own assertion event with soft semantics (§17 #5). Cheaper
   * than inline at runtime: pure evaluation, no user code. Opaque logic
   * belongs in the inline form below.
   */
  check(
    idOrMeta: NodeMetaInput,
    opts: { expect: (w: PredicateScope<State>) => BranchPredicate<State>[] },
  ): ChainedWorkflowBuilder<State>;
  check(
    idOrMeta: NodeMetaInput,
    fn: (ctx: WorkflowContext, state: State) => void | Promise<void>,
    opts?: { project?: CheckProjection },
  ): ChainedWorkflowBuilder<State>;
  /**
   * Pure SYNCHRONOUS state transform. First arg: node id or `{...NodeMeta}`.
   * Async callbacks are rejected at RUNTIME (the impl throws) — route async work
   * through `.action()` (codex slice-1 P2).
   */
  compute<NewState = State>(
    idOrMeta: NodeMetaInput,
    fn: (state: State) => NewState,
  ): ChainedWorkflowBuilder<NewState>;
  /**
   * 2-way branch (§6.6): run `then` when the predicate holds, else `else`. ONLY the
   * taken side executes; the other is reported `skipped` (§17 #6). Declarative `when`
   * projects to `full`; runtime `whenRuntime` is opaque and needs a `message`. The
   * branch does not change the State type — sub-graph state writes apply at runtime.
   */
  /**
   * Apply a reusable FRAGMENT in-chain (phase4 §1): a fragment is a plain
   * typed function over the builder; `.use(f)` is `f(this)` without breaking
   * the chain. Zero new semantics — the fragment's nodes land on the trunk
   * exactly as if hand-written. The fragment must return ITS OWN chain (the
   * CHAINED brand rejects the bare parameter at the type level, and a
   * runtime check rejects a chain from a DIFFERENT builder). A fragment
   * meant for reuse parameterizes its node ids (build() enforces global
   * uniqueness).
   */
  use<NewState>(
    fragment: (b: WorkflowBuilder<State>) => ChainedWorkflowBuilder<NewState>,
  ): ChainedWorkflowBuilder<NewState>;
  /**
   * A DISPLAY-ONLY grouping bracket (phase4 §2, owner-decided): members run
   * exactly as if the wrapper were absent — same order, same state flow, same
   * fail-stop. The group only adds a collapsible node_start/node_end bracket
   * for CLI/Cloud rendering (status = failed > skipped > passed aggregate;
   * grade = worst member). TYPE-TRANSPARENT, not strict-S: a group is a
   * linear trunk segment, so state may evolve through it (strict-S is a
   * property of CONVERGENCE points — branch sides — not segments). The body
   * cannot declare setup/teardown; the group node takes no timeout/retry.
   */
  group<NewState>(
    idOrMeta: NodeMetaInput,
    body: (b: WorkflowBuilder<State>) => ChainedWorkflowBuilder<NewState>,
  ): ChainedWorkflowBuilder<NewState>;
  branch(idOrMeta: NodeMetaInput, opts: BranchOpts<State>): ChainedWorkflowBuilder<State>;
  /**
   * N-way CONVERGING dispatch (addendum §9 #4) — the heir of flow's
   * switchOn/switchCond. Value mode (`on` lens + literal case table, ===) XOR
   * predicate mode (ordered L2 predicates, first-match). Every case is
   * STRICT-S; `default` is optional = identity pass-through. Only the taken
   * case executes; the rest are reported skipped (§17 #6).
   */
  switch(idOrMeta: NodeMetaInput, opts: SwitchOpts<State>): ChainedWorkflowBuilder<State>;
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
  /**
   * Inbound await (inbound-contract-design §9.3): the polled case has
   * `direction: "inbound"` — the counterparty calls US. One attempt scans
   * `via(state).deliveries()` through the adapter matcher; matched claims
   * the delivery and exits (no `until`). Authentication decides failure,
   * content decides attribution (§9.4a): forged/stale/non-JSON deliveries
   * FAIL the node; mismatched shapes are probes. `timeout` defaults from
   * the case's `expect.within`.
   */
  poll<Event = unknown, NewState = State>(
    idOrMeta: NodeMetaInput,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- don't-care
    // slots: the inbound overload keys on `direction` alone (adapter generics
    // vary per protocol; `void/unknown` would reject HTTP's typed refs).
    ref: ContractCaseRef<any, any, any, any> & { direction: "inbound" },
    opts: InboundPollOpts<State, NewState, Event>,
  ): ChainedWorkflowBuilder<NewState>;
  poll<
    CaseInputs,
    CaseOutput,
    AcceptKey,
    RawOutcome,
    Accept extends ReadonlyArray<AcceptKey> = never,
    NewState = State,
  >(
    idOrMeta: NodeMetaInput,
    // `direction?: undefined` excludes inbound refs — without it an inbound
    // ref with outbound-shaped opts ({until, timeout}) would fall through the
    // inbound overload (until: never) into THIS one and only fail at runtime
    // (codex I3 R3 P2). `.case()` pins outbound refs to direction?: undefined.
    ref: ContractCaseRef<CaseInputs, CaseOutput, AcceptKey, RawOutcome> & {
      direction?: undefined;
    },
    ...rest: [CaseInputs] extends [void]
      ? [opts: PollOpts<State, NewState, CaseOutput, RawOutcome, AcceptKey, Accept>]
      : [opts: PollOptsWithInput<State, NewState, CaseInputs, CaseOutput, RawOutcome, AcceptKey, Accept>]
  ): ChainedWorkflowBuilder<NewState>;
  /**
   * Bounded poll over an ARBITRARY async attempt (addendum §4 — the webhook/
   * inbox customer): `.poll`'s twin where the probe is a function instead of a
   * contract case. Same bounds validation, same per-attempt quarantine
   * (§17 #3, with `ctx.signal` = the attempt's budget abort), same `until`
   * split (L2 over the probed value XOR untilRuntime + message). The attempt
   * is statically opaque, so the grade caps at `partial` (L2 until) /
   * `opaque` (untilRuntime) — §6.7's ladder.
   */
  pollAction<Res, NewState = State>(
    idOrMeta: NodeMetaInput,
    fn: (ctx: WorkflowContext, state: State) => Res | Promise<Res>,
    opts: PollUntil<State, Res> &
      PollBounds & {
        /** Pure lens folding the SATISFYING probe result into the next state. */
        out?: (state: State, res: Res) => NewState;
        /** Dataflow hints for the opaque attempt (projection only). */
        project?: ActionProjection;
      },
  ): ChainedWorkflowBuilder<NewState>;
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
  private _setupTimeoutMs?: number;
  private _setupNote?: string;
  private _teardown?: WorkflowTeardown<any>;
  private _teardownTimeoutMs?: number;
  private _teardownNote?: string;
  private readonly _nodes: WorkflowNode[] = [];
  private _built?: BuiltWorkflow<State>;
  /** The first authoring error, if any — a poisoned builder never finalizes. */
  private _poisoned?: unknown;
  /** Set by `.route()` — the tree is terminal; only teardown/build may follow. */
  private _terminated?: string;

  /** workflow.each: registration is deferred until EVERY row passes the
   * one-structure validation — set by the engine, never by users. */
  _suppressRegistration = false;

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
        if (this._built || this._poisoned !== undefined) return;
        try {
          this.build();
        } catch (e) {
          // Auto-build is fire-and-forget on a microtask — a build-time
          // validation error (e.g. duplicate node ids) must not become an
          // unhandled exception (codex S2.13 R1 P1). The builder is poisoned
          // (build() did that) so it never registers; surface the cause
          // loudly enough to find.
          console.error(
            `[glubean] workflow "${this._meta.id}" failed to auto-build and will not be registered: ` +
              (e instanceof Error ? e.message : String(e)),
          );
        }
      });
    }
  }

  // The CHAINED brand is purely type-level — at runtime every chain call
  // returns this same instance; the cast just re-labels it.
  private chained(): ChainedWorkflowBuilder<State> {
    return this as unknown as ChainedWorkflowBuilder<State>;
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

  meta(
    meta: Omit<Partial<WorkflowMeta>, "id" | "templateId" | "groupId" | "parallel">,
  ): ChainedWorkflowBuilder<State> {
    return this.authoring(() => {
      this.assertNotBuilt("meta");
      // ENGINE-OWNED fields are locked (codex S2.12 R21 P2): a factory
      // overwriting them would desync discovery from execution. The Omit
      // above blocks the type level; this reapply blocks `as any`.
      this._meta = {
        ...this._meta,
        ...meta,
        id: this._meta.id,
        templateId: this._meta.templateId,
        groupId: this._meta.groupId,
        parallel: this._meta.parallel,
      };
      return this.chained();
    });
  }

  /** A blank hint is noise pretending to be signal (phase4 §6.1). */
  private static validateLifecycleNote(phase: string, note: string | undefined): void {
    if (note === undefined) return;
    if (typeof note !== "string" || note.trim().length === 0) {
      throw new Error(
        `workflow.${phase}(): \`note\` must be a non-empty string — omit it instead of leaving it blank`,
      );
    }
  }

  private static validateLifecycleTimeout(phase: string, timeout: number | undefined): void {
    if (timeout === undefined) return;
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      throw new Error(
        `workflow.${phase}(): \`timeout\` must be a finite number > 0 (ms); got ${String(timeout)}`,
      );
    }
  }

  setup<S>(fn: WorkflowSetup<S>, opts?: { timeout?: number; note?: string }): ChainedWorkflowBuilder<S> {
    return this.authoring(() => {
      this.assertNotBuilt("setup");
      // setup runs first at execution, so authoring it after a node OR after
      // teardown would make the advertised state type dishonest (codex slice-1 P2).
      if (this._nodes.length > 0 || this._teardown) {
        throw new Error(
          "workflow.setup() must be called before any step (call/action/check/compute) or teardown",
        );
      }
      // Lifecycle belongs to the WORKFLOW AUTHOR: a fragment silently
      // replacing the host's setup (and reshaping runtime state invisibly to
      // the tip guard, which only tracks nodes) is exactly the stale-handle
      // hazard again (codex S2.13 R5 P2). meta() stays allowed — display
      // annotation, not behavior.
      if (this._fragmentDepth > 0) {
        throw new Error(
          `workflow "${this._meta.id}": a .use() fragment cannot declare setup — ` +
            `lifecycle belongs to the workflow author`,
        );
      }
      WorkflowBuilderImpl.validateLifecycleTimeout("setup", opts?.timeout);
      WorkflowBuilderImpl.validateLifecycleNote("setup", opts?.note);
      this._setup = fn;
      this._setupTimeoutMs = opts?.timeout;
      this._setupNote = opts?.note;
      return this as unknown as ChainedWorkflowBuilder<S>;
    });
  }

  teardown(
    fn: WorkflowTeardown<State>,
    opts?: { timeout?: number; note?: string },
  ): ChainedWorkflowBuilder<State> {
    return this.authoring(() => {
      this.assertNotBuilt("teardown");
      if (this._fragmentDepth > 0) {
        throw new Error(
          `workflow "${this._meta.id}": a .use() fragment cannot declare teardown — ` +
            `lifecycle belongs to the workflow author`,
        );
      }
      WorkflowBuilderImpl.validateLifecycleTimeout("teardown", opts?.timeout);
      WorkflowBuilderImpl.validateLifecycleNote("teardown", opts?.note);
      this._teardown = fn;
      this._teardownTimeoutMs = opts?.timeout;
      this._teardownNote = opts?.note;
      return this.chained();
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
      validateNodeTimeout(meta, "call");
      if ((ref as { direction?: string } | undefined)?.direction === "inbound") {
        throw new Error(
          `workflow.call() "${meta.id}": case "${ref.contractId}.${ref.caseKey}" is ` +
            `inbound — the counterparty calls us, so there is nothing to call. ` +
            `Await it with an inbound poll instead.`,
        );
      }
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
      validateNodeTimeout(meta, "action");
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

  // Broad impl satisfies both check overloads; call sites use the interface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  check(idOrMeta: NodeMetaInput, fnOrOpts: unknown, opts?: { project?: CheckProjection }): any {
    return this.authoring(() => {
      this.assertNoTeardown("check");
      const checkMeta = normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix);
      validateNodeTimeout(checkMeta, "check");
      // Declarative form: { expect: (w) => [...] } (phase4 §7)
      if (
        fnOrOpts !== null &&
        typeof fnOrOpts === "object" &&
        typeof (fnOrOpts as { expect?: unknown }).expect === "function"
      ) {
        const expectFn = (fnOrOpts as {
          expect: (w: PredicateScope<State>) => BranchPredicate<State>[];
        }).expect;
        const items = expectFn(predicateScope<State>());
        if (!Array.isArray(items) || items.length === 0) {
          throw new Error(
            `workflow.check() "${checkMeta.id}": \`expect\` must return a non-empty array of predicates`,
          );
        }
        for (const item of items) {
          // every item must be L2 declarative — an opaque predicate here is a
          // contradiction in terms; use the inline form for opaque logic.
          assertL2Predicate(item as never, `check "${checkMeta.id}" expect`);
        }
        const node: CheckNode<State> = {
          kind: "check",
          meta: checkMeta,
          expects: Object.freeze([...items]),
        };
        this._nodes.push(node as WorkflowNode);
        return this.chained();
      }
      if (typeof fnOrOpts !== "function") {
        throw new Error(
          `workflow.check() "${checkMeta.id}" requires a check function or { expect: (w) => [...] }`,
        );
      }
      const node: CheckNode<State> = {
        kind: "check",
        meta: checkMeta,
        fn: fnOrOpts as (ctx: WorkflowContext, state: State) => void | Promise<void>,
        project: opts?.project,
      };
      this._nodes.push(node as WorkflowNode);
      return this.chained();
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
      const computeMeta = normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix);
      validateNodeTimeout(computeMeta, "compute");
      // S2.18 lens-purity: trace the dataflow at BUILD time (proxy dry-run —
      // the same tracer flow's normalizer runs). Transform LOGIC stays
      // undeclarable, which is why compute grades `partial` at best.
      //
      // DESIGN STANCE (codex S2.18 R3, defended): yes, this executes the fn
      // once at authoring/scan time. That is the established vNext mechanism
      // for EVERY declared function — predicate lenses, selector lenses,
      // via/correlate lenses all dry-run through a proxy at build — and the
      // public contract of compute is "pure synchronous transform": a body
      // with closure mutation/side effects (`++n`) violates that contract,
      // and the dry run makes the violation observable instead of latent.
      // No published users exist (pre-0.6 window); a static-analysis
      // alternative is the regex bottomless pit S2.15 already disproved.
      //
      // A throw during the dry run is NOT an authoring error: the proxy
      // feeds dummy values ("", 0) and a value-sensitive helper
      // (`new URL(state.url)`, schema validators) may legitimately reject
      // them — degrade to untraced (grade `opaque`) instead of failing a
      // build the runtime would have passed (codex S2.18 R1 P2).
      let traced: { reads: string[]; writes: string[] } | undefined;
      try {
        traced = traceComputeFn(fn as (state: any) => any);
      } catch {
        traced = undefined;
      }
      const node: ComputeNode<State> = {
        kind: "compute",
        meta: computeMeta,
        fn: fn as unknown as ComputeNode<State>["fn"],
        ...(traced ? { reads: traced.reads, writes: traced.writes } : {}),
      };
      this._nodes.push(node as WorkflowNode);
      return this;
    });
  }

  /** DEPTH of currently-executing `.use()` fragments (nested fragments
   * compose — a boolean would be cleared by the inner finally, reopening the
   * premature-build hole; codex S2.13 R3 P2). A fragment finalizing the
   * workflow (`b.build()` via JS/as-any) would register it BEFORE use() can
   * reject the handle, and the set `_built` would defeat poisoning. */
  private _fragmentDepth = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  use(fragment: (b: WorkflowBuilder<State>) => unknown): any {
    return this.authoring(() => {
      this.assertNotBuilt("use");
      if (typeof fragment !== "function") {
        throw new Error(`workflow.use() on "${this._meta.id}": a fragment function is required`);
      }
      // The fragment gets a TIP-GUARDED FACADE, not the raw builder — the
      // same stale-handle hazard branch sides have exists on the trunk: a
      // block-body fragment could chain off a pre-reshape handle and run a
      // check against state that no longer exists (codex S2.13 R3 P2).
      const { facade, tipOf } = WorkflowBuilderImpl.makeTipGuardedFacade(
        this,
        `fragment in "${this._meta.id}"`,
      );
      let result: unknown;
      this._fragmentDepth += 1;
      try {
        result = fragment(facade);
      } finally {
        this._fragmentDepth -= 1;
      }
      // An async fragment would add nodes after the chain moved on — same
      // hazard as an async branch side (codex S2.4a R5). Consume the promise
      // first: its later rejection would otherwise surface as unhandled even
      // when the caller catches this throw (codex S2.13 R2 P2).
      if (result && typeof (result as { then?: unknown }).then === "function") {
        (result as Promise<unknown>).then(
          () => {},
          () => {},
        );
        throw new Error(
          `workflow.use() on "${this._meta.id}": the fragment must be synchronous — an ` +
            `async fragment loses any steps added after an await`,
        );
      }
      // The CHAINED brand is type-only — a fragment returning a chain built
      // from a DIFFERENT workflow() satisfies the type while redirecting
      // every subsequent trunk call to that other builder and leaving this
      // one half-authored (codex phase4 design-R1). The returned handle must
      // be THIS use()'s facade chain AND its tip (a stale prefix means steps
      // were appended after it — same belt-and-suspenders as branch sides).
      const returnedTip = tipOf(result);
      if (returnedTip === undefined) {
        throw new Error(
          `workflow.use() on "${this._meta.id}": the fragment must return the chain built ` +
            `from the builder it was given — it returned ${result === undefined ? "undefined" : "a different builder/value"}`,
        );
      }
      if (returnedTip !== this._nodes.length) {
        throw new Error(
          `workflow.use() on "${this._meta.id}": the fragment returned a stale chain handle — ` +
            `return the value of the LAST chain call`,
        );
      }
      return this.chained();
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  group(idOrMeta: NodeMetaInput, body: (b: WorkflowBuilder<State>) => unknown): any {
    return this.authoring(() => {
      this.assertNoTeardown("group");
      const meta = normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix);
      validateNodeTimeout(meta, "group");
      if (typeof body !== "function") {
        throw new Error(`workflow.group() "${meta.id}" requires a body function`);
      }
      const node: GroupNode = {
        kind: "group",
        meta,
        nodes: this.collectSubNodes(body, `${meta.id}.`),
      };
      this._nodes.push(node as WorkflowNode);
      return this.chained();
    });
  }

  branch(idOrMeta: NodeMetaInput, opts: BranchOpts<State>): ChainedWorkflowBuilder<State> {
    return this.authoring(() => {
      this.assertNoTeardown("branch");
      const meta = normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix);
      validateNodeTimeout(meta, "branch");
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
      return this.chained();
    });
  }

  // Broad impls satisfy the interface signatures; call sites type-check against
  // the precise interface, not these.
  switch(idOrMeta: NodeMetaInput, opts: SwitchOpts<State>): ChainedWorkflowBuilder<State> {
    return this.authoring(() => {
      this.assertNoTeardown("switch");
      const meta = normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix);
      validateNodeTimeout(meta, "switch");
      const node: BranchNode<State> = {
        kind: "branch",
        meta,
        ...this.buildFamilyDecision("switch", meta.id, opts),
        default: opts.default
          ? this.collectSubNodes(opts.default, `${meta.id}.default.`)
          : undefined, // optional = identity pass-through (addendum §9 #4)
      };
      this._nodes.push(node as WorkflowNode);
      return this.chained();
    });
  }

  route(idOrMeta: NodeMetaInput, opts: RouteOpts<State>): TerminalWorkflowBuilder<State> {
    return this.authoring(() => {
      this.assertNoTeardown("route");
      const meta = normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix);
      validateNodeTimeout(meta, "route");
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
  ): Pick<BranchNode<State>, "mode" | "onPath" | "cases"> {
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
        // NaN never matches under === and non-finite numbers serialize as null
        // in JSON metadata — reject before they poison the case table (codex
        // S2.8 R1 P2).
        if (typeof v === "number" && !Number.isFinite(v)) {
          throw new Error(
            `workflow.${method}() "${nodeId}" case ${i}: \`value\` must be a finite number — ` +
              `${String(v)} never matches (===) and is not JSON-safe`,
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
    // Labels must be unique: they prefix anonymous child ids and identify the
    // taken case in branch_decision events — `value: 1` vs `value: "1"` both
    // stringify to "1", and explicit labels can collide too (codex S2.8 R1 P2).
    const seenLabels = new Set<string>();
    for (const c of cases) {
      // "default" is reserved: the fallback side collects under the same
      // `${nodeId}.default.` prefix, so a case labeled "default" (e.g.
      // `value: "default"`) would collide with it (codex S2.8 R2 P2).
      if (c.label === "default") {
        throw new Error(
          `workflow.${method}() "${nodeId}": case label "default" is reserved for the ` +
            `fallback side — give the case an explicit different \`label\``,
        );
      }
      if (seenLabels.has(c.label!)) {
        throw new Error(
          `workflow.${method}() "${nodeId}": duplicate case label "${c.label}" — ` +
            `labels prefix child node ids and identify the taken case; give the ` +
            `colliding case an explicit distinct \`label\``,
        );
      }
      seenLabels.add(c.label!);
    }
    if (valueMode) {
      // S2.18 lens-purity: `on` passes the same P0 selector gate as every
      // predicate lens, and only its EXTRACTED path is kept — the runtime
      // dispatches via safe path resolution over onPath, so projection and
      // execution share one truth. A classification expression (ternary,
      // comparison, call) is rejected here: make it explicit — `.compute()`
      // a discriminant field first, or use predicate mode.
      const onPath = selectorPath((opts as { on: (s: State) => unknown }).on);
      return { mode: "value", onPath, cases };
    }
    return { mode: "predicate", cases };
  }

  // Broad impl satisfies the interface's conditional-tuple signature; call sites
  // type-check against the precise interface signature, not this one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  poll(idOrMeta: NodeMetaInput, ref: ContractCaseRef, ...rest: any[]): any {
    return this.authoring(() => {
      this.assertNoTeardown("poll");
      const meta = normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix);
      validateNodeTimeout(meta, "poll");
      if ((ref as { direction?: string } | undefined)?.direction === "inbound") {
        return this.inboundPoll(meta, ref, rest[0]);
      }
      const opts = rest[0] as
        | (PollUntil<State, unknown> &
            PollBounds & {
              in?: (state: State) => unknown;
              out?: (state: State, res: unknown) => unknown;
              accept?: ReadonlyArray<string | number>;
            })
        | undefined;
      // Inbound-only vocabulary on an outbound poll = a direction mixup —
      // reject loudly instead of silently ignoring the receiver lens.
      const stray = opts as Record<string, unknown> | undefined;
      if (stray && (stray.via !== undefined || stray.correlate !== undefined)) {
        throw new Error(
          `workflow.poll() "${meta.id}": \`via\`/\`correlate\` are inbound-poll options, ` +
            `but case "${ref?.contractId}.${ref?.caseKey}" is outbound — did you mean an ` +
            `inboundCase (direction: "inbound")?`,
        );
      }
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

  /**
   * Inbound await (inbound-contract-design §9.3, slice I3): the counterparty
   * calls US — one attempt scans `via(state).deliveries()` through the
   * adapter matcher; matched IS the exit (no `until`), nothing is sent (no
   * `in`/`accept`). `timeout` defaults from the case's `expect.within`
   * (evidence + default bound, not an independent failure condition —
   * §9.4a #5). All lenses pass the selector-source gate at build time.
   */
  private inboundPoll(
    meta: NodeMeta,
    ref: ContractCaseRef,
    rawOpts: unknown,
  ): this {
    const opts = (rawOpts ?? {}) as {
      via?: (state: State) => unknown;
      correlate?: { event?: (e: unknown) => unknown; state?: (s: State) => unknown };
      out?: (state: State, parsed: unknown) => State;
    } & PollBounds & Record<string, unknown>;
    const where = `workflow.poll() "${meta.id}" (inbound "${ref.contractId}.${ref.caseKey}")`;

    // Outbound-only vocabulary is rejected loudly — silent acceptance would
    // read as "this knob works" when nothing is ever sent or predicated.
    const rejected: Array<[string, string]> = [
      ["until", "matched IS the exit — an inbound poll has no response to predicate over"],
      ["untilRuntime", "matched IS the exit"],
      ["in", "nothing is sent — an inbound case has no logical input"],
      ["accept", "alternate outcome keys are outbound response vocabulary"],
      ["message", "no opaque predicate exists to label"],
    ];
    for (const [key, why] of rejected) {
      if (opts[key] !== undefined) {
        throw new Error(`${where}: \`${key}\` is not allowed on an inbound poll — ${why}.`);
      }
    }
    if (typeof opts.via !== "function") {
      throw new Error(
        `${where}: \`via\` is required — a pure lens selecting the ReceiverHandle ` +
          `from workflow state, e.g. \`via: (s) => s.inbox\` (design §9.3).`,
      );
    }
    const viaPath = selectorPath(opts.via);
    let correlate: InboundPollSpec<State>["correlate"];
    if (opts.correlate !== undefined) {
      const { event, state: stateLens } = opts.correlate;
      // §9.3: correlation is an === compare — BOTH lenses must be defined or
      // the comparison degenerates to undefined === x.
      if (typeof event !== "function" || typeof stateLens !== "function") {
        throw new Error(
          `${where}: \`correlate\` needs BOTH lenses — { event: (e) => ..., state: (s) => ... } (design §9.3).`,
        );
      }
      correlate = {
        event,
        eventPath: selectorPath(event),
        state: stateLens,
        statePath: selectorPath(stateLens),
      };
    }

    // `expect.within` (duck-read; the adapter owns the case shape) is the
    // poll's default total timeout.
    const within = (
      (ref.contract._spec as { cases?: Record<string, { expect?: { within?: number } }> })
        ?.cases?.[ref.caseKey]?.expect?.within
    );
    const timeout = opts.timeout ?? within;
    validatePollBounds(
      {
        timeout,
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
      inbound: {
        via: opts.via,
        viaPath,
        ...(correlate ? { correlate } : {}),
        ...(within !== undefined ? { withinMs: within } : {}),
      },
      out: opts.out as PollNode<State>["out"],
      every: opts.every ?? DEFAULT_EVERY_MS,
      backoff: opts.backoff ?? 1,
      timeoutMs: timeout,
      perAttemptTimeoutMs: opts.perAttemptTimeout,
      maxAttempts: opts.maxAttempts,
    };
    this._nodes.push(node as WorkflowNode);
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pollAction(idOrMeta: NodeMetaInput, fn: (ctx: WorkflowContext, state: State) => unknown, ...rest: any[]): any {
    return this.authoring(() => {
      this.assertNoTeardown("pollAction");
      const meta = normalizeNodeMeta(idOrMeta, this._nodes.length, this._idPrefix);
      validateNodeTimeout(meta, "poll");
      const opts = rest[0] as
        | (PollUntil<State, unknown> &
            PollBounds & {
              out?: (state: State, res: unknown) => unknown;
              project?: ActionProjection;
            })
        | undefined;
      if (typeof fn !== "function") {
        throw new Error(`workflow.pollAction() "${meta.id}" requires an attempt function`);
      }
      if (!opts || (typeof opts.until !== "function" && typeof opts.untilRuntime !== "function")) {
        throw new Error(
          `workflow.pollAction() "${meta.id}" requires an exit predicate — \`until\` (declarative) or \`untilRuntime\``,
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
        attemptFn: fn as PollNode<State>["attemptFn"],
        project: opts.project,
        out: opts.out as PollNode<State>["out"],
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
  /**
   * Tip-guarded facade over a builder (codex S2.8 R3 / S2.13 R3): the CHAINED
   * brand catches `return b`, but a FORKED chain needs a runtime guard — e.g.
   * `b.compute(reshape); return b.check(noop)` compiles (the second chain is
   * S→S) while the discarded reshaping chain still lands in the node list.
   * Every facade remembers the chain length at its creation; a node call from
   * a handle whose tip is no longer the chain's end IS the fork — throw at
   * authoring time. Sequential chains (incl. `const c = b.x(); return c`)
   * pass untouched. Shared by branch-family sides (collectSubNodes) AND
   * `.use()` fragments — the same stale-handle hazard exists on the trunk.
   */
  private static makeTipGuardedFacade<S>(
    target: WorkflowBuilderImpl<S>,
    label: string,
  ): { facade: WorkflowBuilder<S>; tipOf: (v: unknown) => number | undefined } {
    const tips = new WeakMap<object, number>();
    const make = (tip: number): WorkflowBuilder<S> => {
      const proxy = new Proxy(target as object, {
        get: (t, prop) => {
          const v = Reflect.get(t, prop, t);
          if (typeof v !== "function") return v;
          return (...args: unknown[]) => {
            if (target._nodes.length !== tip) {
              throw new Error(
                `workflow ${label} forked its chain — continue from the ` +
                  `latest chain return value; don't call off an earlier handle`,
              );
            }
            const out = v.apply(t, args);
            // A node call advanced the chain → hand back a fresh tip handle.
            if (target._nodes.length !== tip) return make(target._nodes.length);
            // A NON-advancing chain call (meta/setup/teardown) returns the
            // raw builder — re-wrap at the same tip so the chain never
            // escapes the facade, else the final return-value validation
            // would reject a perfectly valid fragment that starts with
            // metadata (codex S2.13 R4 P2). Non-builder results (e.g. a
            // guard's return) pass through untouched.
            return out === t ? make(tip) : out;
          };
        },
      }) as WorkflowBuilder<S>;
      tips.set(proxy as object, tip);
      return proxy;
    };
    // The facade starts at the CURRENT chain end — a trunk facade (.use) is
    // created mid-chain, so tip 0 would instantly false-positive the fork
    // guard on the first call; a child builder starts empty so this is 0.
    return {
      facade: make(target._nodes.length),
      tipOf: (v) => (typeof v === "object" && v !== null ? tips.get(v as object) : undefined),
    };
  }

  private collectSubNodes(
    fn: (b: WorkflowBuilder<State>) => unknown,
    idPrefix: string,
  ): WorkflowNode[] {
    const child = new WorkflowBuilderImpl<State>({ id: this._meta.id }, idPrefix, true);
    const { facade, tipOf } = WorkflowBuilderImpl.makeTipGuardedFacade(
      child,
      `side under "${idPrefix}"`,
    );
    const result = fn(facade);
    // An async then/else callback would snapshot child._nodes BEFORE its post-await
    // steps are added — silently dropping them. Reject thenables (codex S2.4a R5).
    if (result && typeof (result as { then?: unknown }).then === "function") {
      throw new Error(
        "workflow.branch() then/else callback must be synchronous — an async callback " +
          "loses any steps added after an await",
      );
    }
    // The callback MUST return its own facade chain (codex S2.14 R2 P2): a
    // body closing over a DIFFERENT builder (`group("g", () => other.compute(
    // ...))`) type-checks when shapes match, but the sub-graph would be EMPTY
    // while the other builder mutates — silently dropping every member. And a
    // returned handle that is not the chain's tip means steps were added
    // after it (stale prefix — codex S2.8 R3).
    const returnedTip = tipOf(result);
    if (returnedTip === undefined) {
      throw new Error(
        `workflow sub-graph under "${idPrefix}": the callback must return the chain built ` +
          `from the builder it was given — it returned ` +
          `${result === undefined ? "undefined" : "a different builder/value"}`,
      );
    }
    if (returnedTip !== child._nodes.length) {
      throw new Error(
        `workflow side under "${idPrefix}" returned a stale chain handle — ` +
          `return the value of the LAST chain call`,
      );
    }
    if (child._setup || child._teardown) {
      throw new Error("a workflow sub-graph callback (branch side / group body) cannot declare setup/teardown");
    }
    // A poisoned child holds a half-authored side (the callback caught an
    // authoring error on it) — accepting its nodes would smuggle the partial
    // graph past the parent's poison protection (codex S2.5 R4 P2). This throw
    // runs inside the parent's authoring() wrapper, so the parent poisons too.
    if (child._poisoned !== undefined) {
      const causeMsg =
        child._poisoned instanceof Error ? child._poisoned.message : String(child._poisoned);
      throw new Error(
        `workflow sub-graph (branch side / group body) is half-authored — a sub-builder call failed: ${causeMsg}`,
      );
    }
    return child._nodes.slice();
  }

  /**
   * Node ids must be UNIQUE across the whole graph (S2.13 / phase4 §1.3):
   * evidence addressing (§17 #9), summary folding (per-nodeId last-wins) and
   * Cloud rendering all assume it, and a fragment used twice (.use) would
   * silently collide. Walks the trunk plus branch-family cases/default and
   * group children; throws naming both occurrences.
   */
  private static assertUniqueNodeIds(nodes: readonly WorkflowNode[], wfId: string): void {
    const seen = new Map<string, string>();
    const visit = (node: WorkflowNode, path: string): void => {
      const where = path ? `${path} > ${node.meta.id}` : node.meta.id;
      const prior = seen.get(node.meta.id);
      if (prior !== undefined) {
        throw new Error(
          `workflow "${wfId}": duplicate node id "${node.meta.id}" (first at ${prior}, ` +
            `again at ${where}) — node ids address evidence and must be unique; a reused ` +
            `fragment should parameterize its ids (e.g. makeLogin(prefix))`,
        );
      }
      seen.set(node.meta.id, where);
      if (node.kind === "branch") {
        for (const c of node.cases) for (const n of c.nodes) visit(n, where);
        for (const n of node.default ?? []) visit(n, where);
      } else if (node.kind === "group") {
        for (const n of node.nodes) visit(n, where);
      }
    };
    for (const n of nodes) visit(n, "");
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
    // A fragment finalizing its host would register the workflow before
    // use() can validate the return — and `_built` would then defeat the
    // poison path (codex S2.13 R2 P2).
    if (this._fragmentDepth > 0) {
      throw new Error(
        `workflow "${this._meta.id}": build() cannot be called inside a .use() fragment — ` +
          `return the chain; the workflow's author builds it`,
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
    try {
      WorkflowBuilderImpl.assertUniqueNodeIds(this._nodes, this._meta.id);
    } catch (e) {
      // Build-time validation failure must POISON the builder: the queued
      // auto-build would otherwise call build() again on the next microtask
      // and throw UNHANDLED even though the caller caught this one
      // (codex S2.13 R1 P1).
      this._poisoned ??= e;
      throw e;
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
    // Mark the simple wrapper so the runner-on-engine gate (engineSupports) keeps it
    // on the LEGACY harness: its fn emits workflow:* events the harness unwraps into
    // node/poll timeline events, which the browser-safe engine does not (plan 0005
    // §scope: workflow stays node-only / cloud; codex Phase-3 P2).
    (wfTest as { __glubean_kind?: string }).__glubean_kind = "workflow";

    // The handle IS both the Workflow IR (runWorkflow/projectWorkflow consume it
    // directly) and a one-element Test[] (the runner's array resolution discovers
    // it) — the same dual shape as contract.flow()'s FlowContract.
    const handle = Object.assign([wfTest], {
      __glubean_type: "workflow" as const,
      meta,
      setup: this._setup,
      ...(this._setupTimeoutMs !== undefined ? { setupTimeoutMs: this._setupTimeoutMs } : {}),
      ...(this._setupNote !== undefined ? { setupNote: this._setupNote } : {}),
      teardown: this._teardown,
      ...(this._teardownTimeoutMs !== undefined
        ? { teardownTimeoutMs: this._teardownTimeoutMs }
        : {}),
      ...(this._teardownNote !== undefined ? { teardownNote: this._teardownNote } : {}),
      nodes: this._nodes.slice(),
    }) as unknown as BuiltWorkflow<State>;

    // Pre-compute the graded projection ONCE; the registry entry and the
    // handle's `_projection` (the scanner's dep-free read, mirroring
    // FlowContract._extracted — S2.6) share the same object. A data-driven
    // member carries its template id (addendum §3: rows share ONE structure).
    // templateId/groupId/parallel ride projectWorkflow itself (from meta) so
    // every projection path agrees, not just this cached one (codex R5 P2).
    const projection = projectWorkflow(handle);
    Object.assign(handle, { _projection: projection });

    // Register for scanner discovery with the full graded projection (§7) —
    // scanner/Cloud/agents read grades + call identity without executing.
    // workflow.each defers this until every row validates (codex S2.12 R3 P2:
    // a rejected matrix must not leave half its members in the registry).
    const register = (): void =>
      registerTest({
        id: meta.id,
        name: meta.name ?? meta.id,
        type: "simple",
        ...(meta.tags ? { tags: meta.tags } : {}),
        ...(meta.description ? { description: meta.description } : {}),
        ...(meta.groupId ? { groupId: meta.groupId } : {}),
        ...(meta.parallel ? { parallel: true } : {}),
        workflow: projection,
      });
    if (this._suppressRegistration) {
      Object.assign(handle, { _pendingRegistration: register });
    } else {
      register();
    }

    this._built = handle;
    return handle;
  }
}

function workflowFn(idOrMeta: string | WorkflowMeta): WorkflowBuilder<undefined> {
  const meta: WorkflowMeta =
    typeof idOrMeta === "string" ? { id: idOrMeta } : { ...idOrMeta };
  if (typeof meta.id !== "string" || meta.id.length === 0) {
    throw new Error("workflow(): a non-empty string id is required");
  }
  // Engine-owned data-driven fields can only be minted by workflow.each/pick.
  delete meta.templateId;
  delete meta.groupId;
  delete meta.parallel;
  return new WorkflowBuilderImpl<undefined>(meta);
}

/**
 * Template meta for `workflow.each` (addendum §3). `id` is a TEMPLATE — the
 * engine interpolates `$field` / `$index` per row (the test.each engine,
 * reused wholesale). The engine owns id templating / tagging / groupId; the
 * factory only authors the body.
 */
export interface WorkflowEachMeta<T>
  extends Omit<WorkflowMeta, "groupId" | "parallel" | "templateId"> {
  /** Template id, e.g. "checkout-$region". */
  id: string;
  /** Row fields auto-tagged as `field:value` per member. */
  tagFields?: string | ReadonlyArray<Extract<keyof T, string>>;
  /** Members of this group may run in parallel. */
  parallel?: boolean;
  /** Keep only rows passing this predicate (applied before building). */
  filter?: (row: T, index: number) => boolean;
}

/** The per-row authoring factory: the engine creates the builder (templated
 * id + tags + groupId) and hands it in with the fully-typed row. */
export type WorkflowEachFactory<T> = (
  wf: WorkflowBuilder<undefined>,
  row: T,
) => unknown;

function buildEachMembers<T extends Record<string, unknown>>(
  rows: readonly T[],
  meta: WorkflowEachMeta<T>,
  factory: WorkflowEachFactory<T>,
): BuiltWorkflow[] {
  {
    if (typeof meta?.id !== "string" || meta.id.length === 0) {
      throw new Error("workflow.each(): a non-empty template id is required");
    }
    if (typeof factory !== "function") {
      throw new Error(`workflow.each() "${meta.id}": a (wf, row) factory is required`);
    }
    const filtered = meta.filter
      ? rows.filter((row, index) => meta.filter!(row as T, index))
      : rows;
    const tagFieldNames =
      typeof meta.tagFields === "string" ? [meta.tagFields] : [...(meta.tagFields ?? [])];
    const staticTags = meta.tags ?? [];
    // Grouping is parallel-only: an object-table each has _pick on its rows
    // (the map key) but stays deterministic and ungrouped (codex S2.12 R11).
    const hasGroup = meta.parallel === true;

    // Addendum §3 binding rule 2 made executable: row data enters state ONLY
    // via setup (or closure literals), so every row must project to ONE
    // structure — identical canonicalHash, one version × N runs. A factory
    // that shapes the GRAPH from the row (conditional nodes) breaks that
    // contract and is rejected here, not silently shipped as N blobs.
    let canonicalStructure: string | undefined;
    let canonicalRowId: string | undefined;
    // Row-INVARIANT top-level meta participates too: a factory varying e.g.
    // `skip` per row via wf.meta() would let pick's collapsed template entry
    // inherit the first member's deferral and skip runnable examples
    // (codex S2.12 R14 P2). name/tags are engine-owned (templated per row)
    // and excluded.
    // Lifecycle PRESENCE and timeouts are structure too: one row declaring
    // setup while another doesn't is a different workflow shape even though
    // projected nodes match (codex S2.12 R15 P2). The setup fn itself may
    // freely close over row data — only presence/bounds are compared.
    const structureOf = (handle: BuiltWorkflow): string =>
      JSON.stringify({
        nodes: handle._projection.nodes,
        gradeSummary: handle._projection.gradeSummary,
        description: handle.meta.description ?? null,
        skip: handle.meta.skip ?? null,
        only: handle.meta.only ?? null,
        extensions: handle.meta.extensions ?? null,
        setup: handle.setup
          ? { timeoutMs: handle.setupTimeoutMs ?? null, note: handle.setupNote ?? null }
          : null,
        teardown: handle.teardown
          ? { timeoutMs: handle.teardownTimeoutMs ?? null, note: handle.teardownNote ?? null }
          : null,
      });

    return filtered.map((row, index) => {
      const id = interpolateTemplate(meta.id, row, index);
      const name = meta.name ? interpolateTemplate(meta.name, row, index) : id;
      const dynamicTags = tagFieldNames
        .map((field) => {
          const value = (row as Record<string, unknown>)[field];
          return value != null ? `${field}:${String(value)}` : null;
        })
        .filter((t): t is string => t !== null);
      const allTags = [...staticTags, ...dynamicTags];

      const builder = new WorkflowBuilderImpl<undefined>({
        ...meta,
        id,
        name,
        tags: allTags.length > 0 ? allTags : undefined,
        templateId: meta.id, // every member carries the shared-structure marker
        groupId: hasGroup ? meta.id : undefined,
        parallel: meta.parallel === true ? true : undefined,
      } as WorkflowMeta);
      builder._suppressRegistration = true; // registered only after ALL rows validate
      const result = factory(builder, row as T);
      // An async factory would add nodes after we build — same hazard as an
      // async branch side (codex S2.4a R5): reject thenables. Consume the
      // promise first: its continuation will reject later (the builder is
      // finalized by then), and an unhandled rejection would bury this
      // actionable diagnostic (codex S2.12 R4 P3).
      if (result && typeof (result as { then?: unknown }).then === "function") {
        (result as Promise<unknown>).then(
          () => {},
          () => {},
        );
        throw new Error(
          `workflow.each() "${meta.id}": the factory must be synchronous — an async ` +
            `factory loses any steps added after an await`,
        );
      }
      const handle = builder.build();

      const structure = structureOf(handle);
      if (canonicalStructure === undefined) {
        canonicalStructure = structure;
        canonicalRowId = id;
      } else if (structure !== canonicalStructure) {
        throw new Error(
          `workflow.each() "${meta.id}": row ${index} ("${id}") projects a DIFFERENT ` +
            `structure than "${canonicalRowId}" — all rows must share one projected shape ` +
            `(addendum §3: row data enters state via setup only; don't shape the graph ` +
            `from the row — use filter, or split into separate workflows)`,
        );
      }
      return handle;
    });
  }
}

function workflowEach<T extends Record<string, unknown>>(
  table: readonly T[] | Record<string, T>,
): (meta: WorkflowEachMeta<T>, factory: WorkflowEachFactory<T>) => BuiltWorkflow[] {
  const rows = normalizeEachTable(table);
  return (meta, factory) => {
    const members = buildEachMembers(rows, meta, factory);
    // Every row validated against the canonical structure — register now
    // (a rejected matrix never reaches the registry; codex S2.12 R3 P2).
    for (const m of members) {
      (m as unknown as { _pendingRegistration?: () => void })._pendingRegistration?.();
    }
    return members;
  };
}

/** Create a workflow builder. `id` is required (string or `WorkflowMeta`).
 * `workflow.each(table)(metaTemplate, factory)` authors data-driven matrices
 * (addendum §3). There is deliberately NO `workflow.pick`: random selection
 * is a test-layer idea — a workflow's declaration inventory must be
 * deterministic (canonicalHash, one version × N runs), and "hand-run one
 * member" is already covered because every each member is an addressable
 * test (`glubean run -t checkout-us`). Owner decision 2026-06-12. */
export const workflow = Object.assign(workflowFn, {
  each: workflowEach,
});
