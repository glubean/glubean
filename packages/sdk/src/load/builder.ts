/**
 * @module load-builder
 *
 * Fluent builder for performance transactions (`LoadBuilder`).
 *
 * Entry point: `loadScenario("id")` returns a `LoadBuilder`. Chain
 * `.setup()` → `.step()` → `.teardown()` to define a repeatable transaction;
 * state flows between steps via each step's return value (mirroring
 * `test().builder()`). `.build()` produces a `LoadScenario` consumed by
 * `loadRunner()`.
 *
 * Unlike `TestBuilder`, a `LoadBuilder` does NOT auto-register in the global
 * test registry: a scenario is not independently runnable — only `loadRunner()`
 * exports are scheduled.
 */
import { assertSwitchCaseValues } from "../predicates.js";
import { validatePollBounds } from "../poll-primitives.js";
import type { StepJsonScalar, StepNoExtraKeys } from "../types.js";
import type { LoadContext } from "./context.js";
import type { LoadStepOptions } from "./step.js";
import type {
  LoadBranchData,
  LoadConditionSpec,
  LoadFragmentBuilder,
  LoadPollData,
  LoadPollOpts,
  LoadScenario,
  LoadScenarioMeta,
  LoadStepDefinition,
} from "./scenario.js";

// =============================================================================
// Branch / poll desugar (condition / switchOn / switchCond / poll → one step)
// =============================================================================

/** Module-private key holding a load fragment sink's accumulated step list. */
const FRAGMENT_STEPS = Symbol("glubean.load-fragment-steps");

function makeStepDef(
  name: string,
  optionsOrFn: LoadStepOptions | ((ctx: any, state: any) => Promise<any>),
  maybeFn?: (ctx: any, state: any) => Promise<any>,
): LoadStepDefinition {
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn!;
  const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
  return {
    meta: { name, ...options },
    fn: fn as LoadStepDefinition["fn"],
  };
}

/**
 * A branch step carries `branch`; a branch-aware load orchestrator dispatches
 * on it and never calls `fn`. If `fn` IS called the runner is too old to
 * execute load branch steps (SDK/runner version skew) — surface an actionable
 * upgrade message rather than an opaque internal error.
 */
function makeBranchStepDef(branch: LoadBranchData): LoadStepDefinition {
  return {
    meta: { name: branch.message ?? `<${branch.mode}-branch>` },
    fn: (async () => {
      throw new Error(
        `This load scenario uses condition/switch branching (loadScenario().${branch.mode === "value" ? "switchOn" : "condition/switchCond"}), ` +
          `which requires a @glubean/runner / Glubean CLI new enough to execute load branch steps. ` +
          `Upgrade @glubean/runner and the CLI to match @glubean/sdk.`,
      );
    }) as LoadStepDefinition["fn"],
    branch,
  };
}

function collectLoadFragment(
  fn: (b: LoadFragmentBuilder<any, any>) => LoadFragmentBuilder<any, any>,
): LoadStepDefinition[] {
  const result = fn(makeLoadSink([])) as unknown as Record<symbol, unknown>;
  const steps = result?.[FRAGMENT_STEPS];
  if (!Array.isArray(steps)) {
    throw new Error(
      "a loadScenario() branch body must return the fragment builder " +
        "(e.g. `(b) => b.step(...)` or `(b) => b`); it returned a non-builder value",
    );
  }
  return steps as LoadStepDefinition[];
}

function makeLoadSink(
  steps: readonly LoadStepDefinition[],
): LoadFragmentBuilder<any, any> {
  const extend = (s: LoadStepDefinition) => makeLoadSink([...steps, s]);
  const sink: any = {
    step(name: string, optionsOrFn: any, maybeFn?: any) {
      return extend(makeStepDef(name, optionsOrFn, maybeFn));
    },
    use(fn: (b: any) => any) {
      return fn(sink);
    },
    condition(spec: any, thenB: any, elseB?: any) {
      return extend(buildLoadConditionStep(spec, thenB, elseB));
    },
    switchOn(lens: any) {
      return (cases: any, deflt: any) => extend(buildLoadSwitchOnStep(lens, cases, deflt));
    },
    switchCond(cases: any, deflt: any) {
      return extend(buildLoadSwitchCondStep(cases, deflt));
    },
    poll(name: string, fn: any, opts: any) {
      return extend(buildLoadPollStep(name, fn, opts));
    },
  };
  Object.defineProperty(sink, FRAGMENT_STEPS, {
    value: Object.freeze(steps),
    enumerable: false,
  });
  return sink as LoadFragmentBuilder<any, any>;
}

/** condition → predicate-mode branch (1 case + default). */
function buildLoadConditionStep(
  spec: LoadConditionSpec<any, any>,
  thenB: (b: any) => any,
  elseB?: (b: any) => any,
): LoadStepDefinition {
  if (!spec || typeof spec.predicate !== "function") {
    throw new Error("loadScenario().condition: spec.predicate must be a function");
  }
  return makeBranchStepDef({
    mode: "predicate",
    ...(spec.message ? { message: spec.message } : {}),
    cases: [
      {
        predicate: spec.predicate,
        ...(spec.message ? { message: spec.message } : {}),
        steps: collectLoadFragment(thenB),
      },
    ],
    default: elseB ? collectLoadFragment(elseB) : [],
  });
}

/** switchCond → predicate-mode branch (N cases + default). */
function buildLoadSwitchCondStep(
  cases: ReadonlyArray<{ when: (ctx: any, s: any) => any; then: (b: any) => any }>,
  deflt: (b: any) => any,
): LoadStepDefinition {
  return makeBranchStepDef({
    mode: "predicate",
    cases: cases.map((c) => ({ predicate: c.when, steps: collectLoadFragment(c.then) })),
    default: collectLoadFragment(deflt),
  });
}

/** switchOn → value-mode branch (subject lens evaluated once + scalar match). */
function buildLoadSwitchOnStep(
  lens: (ctx: any, s: any) => any,
  cases: ReadonlyArray<{ value: StepJsonScalar; then: (b: any) => any }>,
  deflt: (b: any) => any,
): LoadStepDefinition {
  assertSwitchCaseValues(cases.map((c) => c.value));
  return makeBranchStepDef({
    mode: "value",
    subject: lens,
    cases: cases.map((c) => ({ value: c.value, steps: collectLoadFragment(c.then) })),
    default: collectLoadFragment(deflt),
  });
}

/** A poll step carries `poll`; a poll-aware orchestrator dispatches on it. */
function makePollStepDef(name: string, poll: LoadPollData): LoadStepDefinition {
  return {
    meta: { name },
    fn: (async () => {
      throw new Error(
        `This load scenario uses .poll, which requires a @glubean/runner / Glubean CLI ` +
          `new enough to execute load poll steps. Upgrade @glubean/runner and the CLI to match @glubean/sdk.`,
      );
    }) as LoadStepDefinition["fn"],
    poll,
  };
}

/** loadScenario().poll → a bounded poll-until step (validates bounds at construction). */
function buildLoadPollStep(
  name: string,
  fn: (ctx: any, state: any) => Promise<unknown>,
  opts: {
    until: (ctx: any, res: unknown, state: any) => boolean | Promise<boolean>;
    out?: (state: any, res: unknown) => unknown;
    every?: number;
    backoff?: number;
    timeout?: number;
    perAttemptTimeout?: number;
    maxAttempts?: number;
  },
): LoadStepDefinition {
  if (typeof fn !== "function") {
    throw new Error("loadScenario().poll: the attempt `fn` must be a function");
  }
  if (!opts || typeof opts.until !== "function") {
    throw new Error("loadScenario().poll: `opts.until` must be a function");
  }
  validatePollBounds(
    {
      timeout: opts.timeout,
      maxAttempts: opts.maxAttempts,
      perAttemptTimeout: opts.perAttemptTimeout,
      every: opts.every,
      backoff: opts.backoff,
    },
    name,
  );
  return makePollStepDef(name, {
    fn,
    until: opts.until,
    ...(opts.out ? { out: opts.out } : {}),
    ...(opts.every !== undefined ? { every: opts.every } : {}),
    ...(opts.backoff !== undefined ? { backoff: opts.backoff } : {}),
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    ...(opts.perAttemptTimeout !== undefined ? { perAttemptTimeout: opts.perAttemptTimeout } : {}),
    ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
  });
}

// =============================================================================
// LoadBuilder
// =============================================================================

/**
 * Fluent builder for a performance transaction.
 *
 * @template Input The per-iteration input type (from `loadRunner().input`).
 * @template S     The threaded state type.
 */
export class LoadBuilder<Input = unknown, S = unknown> {
  private _meta: LoadScenarioMeta;
  private _setup?: (ctx: LoadContext<Input>) => Promise<unknown>;
  private _teardown?: (ctx: LoadContext<Input>, state: unknown) => Promise<void>;
  private _steps: LoadStepDefinition<Input, unknown>[] = [];

  /**
   * Marker so the scanner / loadRunner can detect an un-built LoadBuilder
   * export without importing the SDK.
   */
  readonly __glubean_type = "load-scenario-builder" as const;

  constructor(id: string) {
    this._meta = { id };
  }

  /** Set additional scenario metadata. */
  meta(meta: Omit<LoadScenarioMeta, "id">): LoadBuilder<Input, S> {
    this._meta = { ...this._meta, ...meta };
    return this;
  }

  /** Set the setup function that runs before all steps and produces the initial state. */
  setup<NewS>(fn: (ctx: LoadContext<Input>) => Promise<NewS>): LoadBuilder<Input, NewS> {
    (this as unknown as LoadBuilder<Input, NewS>)._setup = fn as (
      ctx: LoadContext<Input>,
    ) => Promise<unknown>;
    return this as unknown as LoadBuilder<Input, NewS>;
  }

  /** Set the teardown function (always run with the last committed state). */
  teardown(fn: (ctx: LoadContext<Input>, state: S) => Promise<void>): LoadBuilder<Input, S> {
    this._teardown = fn as (ctx: LoadContext<Input>, state: unknown) => Promise<void>;
    return this;
  }

  /** Add a step that does not return state (void); the state type is preserved. */
  step(
    name: string,
    fn: (ctx: LoadContext<Input>, state: S) => Promise<void>,
  ): LoadBuilder<Input, S>;
  /** Add a step that returns new state, replacing the current state type. */
  step<NewS>(
    name: string,
    fn: (ctx: LoadContext<Input>, state: S) => Promise<NewS>,
  ): LoadBuilder<Input, NewS>;
  /** Add a step with options (void return). */
  step(
    name: string,
    options: LoadStepOptions,
    fn: (ctx: LoadContext<Input>, state: S) => Promise<void>,
  ): LoadBuilder<Input, S>;
  /** Add a step with options, returning new state. */
  step<NewS>(
    name: string,
    options: LoadStepOptions,
    fn: (ctx: LoadContext<Input>, state: S) => Promise<NewS>,
  ): LoadBuilder<Input, NewS>;
  step(name: string, optionsOrFn: any, maybeFn?: any): LoadBuilder<any, any> {
    this._steps.push(makeStepDef(name, optionsOrFn, maybeFn));
    return this as LoadBuilder<any, any>;
  }

  /** Apply a builder transform for reusable step composition (preserves state flow). */
  use<NewS>(
    fn: (builder: LoadBuilder<Input, S>) => LoadBuilder<Input, NewS>,
  ): LoadBuilder<Input, NewS> {
    return fn(this);
  }

  /** Apply a builder transform and tag all newly added steps with a group ID. */
  group<NewS>(
    id: string,
    fn: (builder: LoadBuilder<Input, S>) => LoadBuilder<Input, NewS>,
  ): LoadBuilder<Input, NewS> {
    const before = this._steps.length;
    const result = fn(this);
    for (let i = before; i < this._steps.length; i++) {
      this._steps[i].meta.group = id;
    }
    return result;
  }

  /**
   * Runtime conditional branch. No-else keeps State's shape (may narrow values,
   * not add keys); with-else infers `T` from `then` and checks `else` via NoInfer.
   */
  condition<R extends S = S>(
    spec: LoadConditionSpec<Input, S>,
    thenBranch: (
      b: LoadFragmentBuilder<Input, S>,
    ) => LoadFragmentBuilder<Input, R & StepNoExtraKeys<R, S>>,
  ): LoadBuilder<Input, S>;
  condition<T>(
    spec: LoadConditionSpec<Input, S>,
    thenBranch: (b: LoadFragmentBuilder<Input, S>) => LoadFragmentBuilder<Input, T>,
    elseBranch: (b: LoadFragmentBuilder<Input, S>) => LoadFragmentBuilder<Input, NoInfer<T>>,
  ): LoadBuilder<Input, T>;
  condition(spec: any, thenBranch: any, elseBranch?: any): LoadBuilder<any, any> {
    this._steps.push(buildLoadConditionStep(spec, thenBranch, elseBranch));
    return this as LoadBuilder<any, any>;
  }

  /** value-switch (single lens × N scalar values; curried so V infers from the lens). */
  switchOn<V>(
    lens: (ctx: LoadContext<Input>, state: S) => V,
  ): <T>(
    cases: ReadonlyArray<{
      value: [Exclude<Awaited<V>, undefined>] extends [StepJsonScalar]
        ? Exclude<Awaited<V>, undefined>
        : never;
      then: (b: LoadFragmentBuilder<Input, S>) => LoadFragmentBuilder<Input, NoInfer<T>>;
    }>,
    deflt: (b: LoadFragmentBuilder<Input, S>) => LoadFragmentBuilder<Input, T>,
  ) => LoadBuilder<Input, T>;
  switchOn(lens: any) {
    return (cases: any, deflt: any): LoadBuilder<any, any> => {
      this._steps.push(buildLoadSwitchOnStep(lens, cases, deflt));
      return this as LoadBuilder<any, any>;
    };
  }

  /** cond-switch (ordered first-match arbitrary predicates). */
  switchCond<T>(
    cases: ReadonlyArray<{
      when: (ctx: LoadContext<Input>, state: S) => boolean | Promise<boolean>;
      then: (b: LoadFragmentBuilder<Input, S>) => LoadFragmentBuilder<Input, NoInfer<T>>;
    }>,
    deflt: (b: LoadFragmentBuilder<Input, S>) => LoadFragmentBuilder<Input, T>,
  ): LoadBuilder<Input, T>;
  switchCond(cases: any, deflt: any): LoadBuilder<any, any> {
    this._steps.push(buildLoadSwitchCondStep(cases, deflt));
    return this as LoadBuilder<any, any>;
  }

  /** Bounded poll-until — repeat `fn` until `opts.until` holds (or a bound exhausts). */
  poll<Res, NewS = S>(
    name: string,
    fn: (ctx: LoadContext<Input>, state: S) => Promise<Res>,
    opts: LoadPollOpts<Input, S, Res, NewS>,
  ): LoadBuilder<Input, NewS>;
  poll(name: string, fn: any, opts: any): LoadBuilder<any, any> {
    this._steps.push(buildLoadPollStep(name, fn, opts));
    return this as LoadBuilder<any, any>;
  }

  /** Build a plain `LoadScenario` definition consumed by `loadRunner()`. */
  build(): LoadScenario<Input, S> {
    return {
      __glubean_type: "load-scenario",
      meta: this._meta,
      setup: this._setup,
      steps: this._steps,
      teardown: this._teardown as
        | ((ctx: LoadContext<Input>, state: S) => Promise<void>)
        | undefined,
    };
  }
}

/**
 * Define a performance transaction.
 *
 * @example
 * ```ts
 * export const checkoutScenario = loadScenario<CheckoutInput>("checkout")
 *   .setup(async (ctx) => ({ user: ctx.input.user, product: ctx.input.product }))
 *   .step("login", async (ctx, state) => {
 *     const res = await api.post("login", { json: state.user.credentials }).json<{ token: string }>();
 *     return { ...state, token: res.token };
 *   })
 *   .step("checkout", async (ctx, state) => {
 *     const res = await api.post("checkout", { headers: { Authorization: `Bearer ${state.token}` } });
 *     ctx.expect(res.status).toBe(201).orFail();
 *     return state;
 *   });
 * ```
 */
export function loadScenario<Input = unknown>(id: string): LoadBuilder<Input, unknown> {
  return new LoadBuilder<Input, unknown>(id);
}
