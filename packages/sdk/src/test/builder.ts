/**
 * @module test-builder
 *
 * Fluent builder for multi-step tests (`TestBuilder`).
 *
 * Entry point: `test("id")` (no callback) returns a `TestBuilder`.
 * Chain `.setup()` → `.step()` → `.teardown()` to define the test workflow.
 * State flows between steps via the return value of each step function.
 * `.build()` is optional — the builder auto-registers via microtask.
 */
import type {
  ExtensionFn,
  SetupFunction,
  StepDefinition,
  StepFunction,
  StepJsonScalar,
  StepMeta,
  StepNoExtraKeys,
  TeardownFunction,
  Test,
  TestBranchData,
  TestConditionSpec,
  TestContext,
  TestFragmentBuilder,
  TestMeta,
} from "../types.js";
import { isTestBranchStep } from "../types.js";
import { registerTest } from "../internal.js";
import { toArray } from "../data.js";
import { assertSwitchCaseValues } from "../contract-flow-condition.js";

/**
 * Flatten steps for registry metadata: a branch contributes its first-class
 * LEAF steps (recursively, across cases + default) — NOT a synthetic branch
 * node. This keeps runtime-registry discovery aligned with the static
 * scanner, which extracts the same nested `.step(...)` leaves by regex; the
 * branch decision itself is surfaced at run time via the `branch` event. A
 * branch added inside `.group(id, ...)` propagates its group to its leaves.
 */
function flattenStepsForRegistry(
  steps: StepDefinition<any>[],
  inheritedGroup?: string,
): Array<{ name: string; group?: string }> {
  const out: Array<{ name: string; group?: string }> = [];
  for (const s of steps) {
    const group = s.meta.group ?? inheritedGroup;
    if (isTestBranchStep(s)) {
      for (const c of s.branch.cases) out.push(...flattenStepsForRegistry(c.steps, group));
      out.push(...flattenStepsForRegistry(s.branch.default, group));
    } else {
      out.push({ name: s.meta.name, ...(group ? { group } : {}) });
    }
  }
  return out;
}

// =============================================================================
// Branch desugar (test() condition / switchOn / switchCond → one branch step)
// =============================================================================

/** Module-private key holding a test fragment sink's accumulated step list. */
const FRAGMENT_STEPS = Symbol("glubean.test-fragment-steps");

function makeStepDef(
  name: string,
  optionsOrFn: Omit<StepMeta, "name"> | ((ctx: any, state: any) => Promise<any>),
  maybeFn?: (ctx: any, state: any) => Promise<any>,
): StepDefinition {
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn!;
  const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
  return { meta: { name, ...options }, fn: fn as unknown as StepFunction };
}

/**
 * Run a test branch-body callback and return the steps of the fragment it
 * RETURNS. The sink is persistent (each method returns a new sink carrying
 * `[...steps, step]`), so the executed sub-steps exactly match the type-checked
 * chain — a block body that mutates then returns an earlier sink can't smuggle
 * an untyped reshape (mirrors the flow-side guarantee).
 */
/**
 * A branch step is a StepDefinition carrying `branch`; a branch-aware harness
 * dispatches on `branch` and never calls `fn`. If `fn` IS called, the harness
 * is too old to understand branch steps (SDK/runner version skew) — surface
 * an actionable upgrade message rather than an opaque internal error.
 */
function makeBranchStepDef(branch: TestBranchData): StepDefinition {
  return {
    meta: { name: branch.message ?? `<${branch.mode}-branch>` },
    fn: (async () => {
      throw new Error(
        `This test uses condition/switch branching (test().${branch.mode === "value" ? "switchOn" : "condition/switchCond"}), ` +
          `which requires a @glubean/runner / Glubean CLI new enough to execute branch steps. ` +
          `Your runner is older than the @glubean/sdk that built this test — upgrade @glubean/runner and the CLI to match @glubean/sdk.`,
      );
    }) as unknown as StepFunction,
    branch,
  };
}

function collectTestFragment(
  fn: (b: TestFragmentBuilder<any, any>) => TestFragmentBuilder<any, any>,
): StepDefinition[] {
  const result = fn(makeTestSink([])) as unknown as Record<symbol, unknown>;
  const steps = result?.[FRAGMENT_STEPS];
  if (!Array.isArray(steps)) {
    throw new Error(
      "a test() branch body must return the fragment builder " +
        "(e.g. `(b) => b.step(...)` or `(b) => b`); it returned a non-builder value",
    );
  }
  return steps as StepDefinition[];
}

function makeTestSink(steps: readonly StepDefinition[]): TestFragmentBuilder<any, any> {
  const extend = (s: StepDefinition) => makeTestSink([...steps, s]);
  const sink: any = {
    step(name: string, optionsOrFn: any, maybeFn?: any) {
      return extend(makeStepDef(name, optionsOrFn, maybeFn));
    },
    use(fn: (b: any) => any) {
      return fn(sink);
    },
    condition(spec: any, thenB: any, elseB?: any) {
      return extend(buildTestConditionStep(spec, thenB, elseB));
    },
    switchOn(lens: any) {
      return (cases: any, deflt: any) => extend(buildTestSwitchOnStep(lens, cases, deflt));
    },
    switchCond(cases: any, deflt: any) {
      return extend(buildTestSwitchCondStep(cases, deflt));
    },
  };
  Object.defineProperty(sink, FRAGMENT_STEPS, {
    value: Object.freeze(steps),
    enumerable: false,
  });
  return sink as TestFragmentBuilder<any, any>;
}

/** condition → predicate-mode branch (1 case + default). */
function buildTestConditionStep(
  spec: TestConditionSpec<any, any>,
  thenB: (b: any) => any,
  elseB?: (b: any) => any,
): StepDefinition {
  if (!spec || typeof spec.predicate !== "function") {
    throw new Error("test().condition: spec.predicate must be a function");
  }
  return makeBranchStepDef({
    mode: "predicate",
    ...(spec.message ? { message: spec.message } : {}),
    cases: [
      {
        predicate: spec.predicate,
        ...(spec.message ? { message: spec.message } : {}),
        steps: collectTestFragment(thenB),
      },
    ],
    default: elseB ? collectTestFragment(elseB) : [],
  });
}

/** switchCond → predicate-mode branch (N cases + default), each an arbitrary predicate. */
function buildTestSwitchCondStep(
  cases: ReadonlyArray<{ when: (ctx: any, s: any) => any; then: (b: any) => any }>,
  deflt: (b: any) => any,
): StepDefinition {
  return makeBranchStepDef({
    mode: "predicate",
    cases: cases.map((c) => ({ predicate: c.when, steps: collectTestFragment(c.then) })),
    default: collectTestFragment(deflt),
  });
}

/** switchOn → value-mode branch (subject lens evaluated once + scalar match). */
function buildTestSwitchOnStep(
  lens: (ctx: any, s: any) => any,
  cases: ReadonlyArray<{ value: StepJsonScalar; then: (b: any) => any }>,
  deflt: (b: any) => any,
): StepDefinition {
  assertSwitchCaseValues(cases.map((c) => c.value));
  return makeBranchStepDef({
    mode: "value",
    subject: lens,
    cases: cases.map((c) => ({ value: c.value, steps: collectTestFragment(c.then) })),
    default: collectTestFragment(deflt),
  });
}

/**
 * Builder class for creating tests with a fluent API.
 *
 * @template S The state type for multi-step tests
 * @template Ctx The context type (defaults to TestContext; augmented by test.extend())
 *
 * @example Simple test (quick mode)
 * ```ts
 * export const login = test("login", async (ctx) => {
 *   ctx.assert(true, "works");
 * });
 * ```
 *
 * @example Multi-step test (builder mode)
 * ```ts
 * export const checkout = test("checkout")
 *   .meta({ tags: ["e2e"] })
 *   .setup(async (ctx) => ({ cart: await createCart() }))
 *   .step("Add to cart", async (ctx, state) => {
 *     await addItem(state.cart, "item-1");
 *     return state;
 *   })
 *   .step("Checkout", async (ctx, state) => {
 *     await checkout(state.cart);
 *     return state;
 *   })
 *   .teardown(async (ctx, state) => {
 *     await cleanup(state.cart);
 *   })
 *   .build();
 * ```
 */
export class TestBuilder<S = unknown, Ctx extends TestContext = TestContext> {
  private _meta: TestMeta;
  private _setup?: SetupFunction<S>;
  private _teardown?: TeardownFunction<S>;

  private _steps: StepDefinition<any>[] = [];
  private _built = false;

  _fixtures?: Record<string, ExtensionFn<any>>;

  /**
   * Marker property so the runner can detect un-built TestBuilder exports
   * without importing the SDK. The runner checks this string to auto-build.
   */
  readonly __glubean_type = "builder" as const;

  constructor(
    id: string,
    fixtures?: Record<string, ExtensionFn<any>>,
  ) {
    this._meta = { id, name: id };
    this._fixtures = fixtures;
    // Auto-finalize (register) after all synchronous chaining completes.
    // Module top-level code is synchronous, so by the time the microtask
    // fires, all .step() / .meta() / .setup() / .teardown() calls are done.
    queueMicrotask(() => this._finalize());
  }

  /**
   * Set additional metadata for the test.
   *
   * @example
   * ```ts
   * test("my-test")
   *   .meta({ tags: ["smoke"], description: "A smoke test" })
   *   .step(...)
   * ```
   */
  meta(meta: Omit<TestMeta, "id">): TestBuilder<S, Ctx> {
    this._meta = { ...this._meta, ...meta };
    return this;
  }

  /**
   * Mark this test as focused.
   *
   * Focused tests are intended for local debugging sessions. When any tests in
   * a run are marked as `only`, non-focused tests may be excluded by discovery
   * tooling/orchestrators. If `skip` is also set on the same test, `skip`
   * still wins during run selection.
   */
  only(): TestBuilder<S, Ctx> {
    this._meta = { ...this._meta, only: true };
    return this;
  }

  /**
   * Mark this test as skipped.
   *
   * Skip takes precedence over `only` when both are present.
   */
  skip(): TestBuilder<S, Ctx> {
    this._meta = { ...this._meta, skip: true };
    return this;
  }

  /**
   * Set the setup function that runs before all steps.
   * The returned state is passed to all steps and teardown.
   *
   * @example
   * ```ts
   * test("auth")
   *   .setup(async (ctx) => {
   *     const baseUrl = ctx.vars.require("BASE_URL");
   *     const apiKey = ctx.secrets.require("API_KEY");
   *     const { token } = await ctx.http.post(`${baseUrl}/auth/token`, {
   *       headers: { "X-API-Key": apiKey },
   *     }).json();
   *     return { token };
   *   })
   *   .step("verify", async (ctx, { token }) => { ... })
   * ```
   */
  setup<NewS>(fn: (ctx: Ctx) => Promise<NewS>): TestBuilder<NewS, Ctx> {
    (this as unknown as TestBuilder<NewS, Ctx>)._setup = fn as unknown as SetupFunction<NewS>;
    return this as unknown as TestBuilder<NewS, Ctx>;
  }

  /**
   * Set the teardown function that runs after all steps (even on failure).
   *
   * @example
   * ```ts
   * test("db-test")
   *   .setup(async (ctx) => ({ conn: await connect() }))
   *   .step(...)
   *   .teardown(async (ctx, { conn }) => {
   *     await conn.close();
   *   })
   * ```
   */
  teardown(fn: (ctx: Ctx, state: S) => Promise<void>): TestBuilder<S, Ctx> {
    this._teardown = fn as unknown as TeardownFunction<S>;
    return this;
  }

  /**
   * Add a step that does not return state (void).
   * The state type is preserved for subsequent steps.
   *
   * @param name Step name (displayed in reports)
   * @param fn Step function that performs assertions/side-effects without returning state
   */
  step(
    name: string,
    fn: (ctx: Ctx, state: S) => Promise<void>,
  ): TestBuilder<S, Ctx>;
  /**
   * Add a step that returns new state, replacing the current state type.
   *
   * The returned value becomes the `state` argument for subsequent steps.
   * This enables fully type-safe chained steps without needing `.setup()`.
   *
   * @param name Step name (displayed in reports)
   * @param fn Step function receiving context and current state, returning new state
   *
   * @example
   * ```ts
   * test("auth-flow")
   *   .step("login", async (ctx) => {
   *     const data = await ctx.http.post("/auth/login", { json: creds }).json<{ token: string }>();
   *     return { token: data.token };
   *   })
   *   .step("get profile", async (ctx, { token }) => {
   *     // token is inferred as string ✓
   *     const profile = await ctx.http.get("/auth/me", {
   *       headers: { Authorization: `Bearer ${token}` },
   *     }).json<{ name: string }>();
   *     return { token, name: profile.name };
   *   })
   * ```
   */
  step<NewS>(
    name: string,
    fn: (ctx: Ctx, state: S) => Promise<NewS>,
  ): TestBuilder<NewS, Ctx>;
  /**
   * Add a step with options (void return).
   */
  step(
    name: string,
    options: Omit<StepMeta, "name">,
    fn: (ctx: Ctx, state: S) => Promise<void>,
  ): TestBuilder<S, Ctx>;
  /**
   * Add a step with additional options, returning new state.
   */
  step<NewS>(
    name: string,
    options: Omit<StepMeta, "name">,
    fn: (ctx: Ctx, state: S) => Promise<NewS>,
  ): TestBuilder<NewS, Ctx>;
  step(
    name: string,
    optionsOrFn:
      | Omit<StepMeta, "name">
      | ((ctx: Ctx, state: any) => Promise<any>),
    maybeFn?: (ctx: Ctx, state: any) => Promise<any>,
  ): TestBuilder<any, Ctx> {
    const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn!;
    const options = typeof optionsOrFn === "function" ? {} : (optionsOrFn as StepMeta);

    this._steps.push({
      meta: { name, ...options },
      fn: fn as unknown as StepFunction,
    });

    return this as TestBuilder<any, Ctx>;
  }

  /**
   * Apply a builder transform function for step composition.
   *
   * Reusable step sequences are just plain functions that take a builder
   * and return a builder. `.use()` applies such a function to the current
   * chain, preserving state flow.
   *
   * @param fn Transform function that receives this builder and returns a (possibly re-typed) builder
   *
   * @example Reusable step sequence
   * ```ts
   * // Define once — just a function
   * const withAuth = (b: TestBuilder<unknown>) => b
   *   .step("login", async (ctx) => {
   *     const data = await ctx.http.post("/login", { json: creds }).json<{ token: string }>();
   *     return { token: data.token };
   *   });
   *
   * // Reuse across tests
   * export const testA = test("test-a").use(withAuth).step("act", async (ctx, { token }) => { ... });
   * export const testB = test("test-b").use(withAuth).step("verify", async (ctx, { token }) => { ... });
   * ```
   */
  use<NewS>(
    fn: (builder: TestBuilder<S, Ctx>) => TestBuilder<NewS, Ctx>,
  ): TestBuilder<NewS, Ctx> {
    return fn(this);
  }

  /**
   * Apply a builder transform and tag all newly added steps with a group ID.
   *
   * Works exactly like `.use()`, but every step added by `fn` is marked with
   * `group` metadata for visual grouping in reports and dashboards.
   *
   * @param id Group identifier (displayed in reports as a section header)
   * @param fn Transform function that adds steps to the builder
   *
   * @example Reusable steps with grouping
   * ```ts
   * const withAuth = (b: TestBuilder<unknown>) => b
   *   .step("login", async (ctx) => ({ token: "..." }))
   *   .step("verify", async (ctx, { token }) => ({ token, verified: true }));
   *
   * export const checkout = test("checkout")
   *   .group("auth", withAuth)
   *   .step("pay", async (ctx, { token }) => { ... });
   *
   * // Report output:
   * // checkout
   * //   ├─ [auth]
   * //   │   ├─ login ✓
   * //   │   └─ verify ✓
   * //   └─ pay ✓
   * ```
   *
   * @example Inline grouping (no reuse, just organization)
   * ```ts
   * export const e2e = test("e2e")
   *   .group("setup", b => b
   *     .step("seed db", async (ctx) => ({ dbId: "..." }))
   *     .step("create user", async (ctx, { dbId }) => ({ dbId, userId: "..." }))
   *   )
   *   .step("verify", async (ctx, { dbId, userId }) => { ... });
   * ```
   */
  group<NewS>(
    id: string,
    fn: (builder: TestBuilder<S, Ctx>) => TestBuilder<NewS, Ctx>,
  ): TestBuilder<NewS, Ctx> {
    const before = this._steps.length;
    const result = fn(this);
    for (let i = before; i < this._steps.length; i++) {
      this._steps[i].meta.group = id;
    }
    return result;
  }

  /**
   * Runtime conditional branch (2 overloads). The predicate runs at execution
   * time — arbitrary, may be async / read ctx / do I/O (the builder doesn't
   * project, so no purity gate). Branch-body steps are FIRST-CLASS (emit
   * step_start/step_end + a branch decision event); non-taken branches' steps
   * are emitted as `skipped`.
   *
   * No-else: `then` keeps State's shape (may narrow values, not add keys).
   * With-else: `T` is inferred from `then`; `else` is checked via `NoInfer<T>`.
   */
  condition<R extends S = S>(
    spec: TestConditionSpec<S, Ctx>,
    thenBranch: (b: TestFragmentBuilder<S, Ctx>) => TestFragmentBuilder<R & StepNoExtraKeys<R, S>, Ctx>,
  ): TestBuilder<S, Ctx>;
  condition<T>(
    spec: TestConditionSpec<S, Ctx>,
    thenBranch: (b: TestFragmentBuilder<S, Ctx>) => TestFragmentBuilder<T, Ctx>,
    elseBranch: (b: TestFragmentBuilder<S, Ctx>) => TestFragmentBuilder<NoInfer<T>, Ctx>,
  ): TestBuilder<T, Ctx>;
  condition(spec: any, thenBranch: any, elseBranch?: any): TestBuilder<any, Ctx> {
    this._steps.push(buildTestConditionStep(spec, thenBranch, elseBranch));
    return this as TestBuilder<any, Ctx>;
  }

  /**
   * value-switch (single lens × N scalar values; curried so V infers from the
   * lens). `default` required (anchors T; the no-match path).
   */
  switchOn<V>(lens: (ctx: Ctx, state: S) => V): <T>(
    // `Awaited<V>` unwraps async subject lenses (the harness awaits them), so a
    // `switchOn(async () => 404)` types `value` as the resolved scalar (number),
    // not `Promise<number>` → never. Sync lenses are unaffected.
    cases: ReadonlyArray<{
      value: [Exclude<Awaited<V>, undefined>] extends [StepJsonScalar] ? Exclude<Awaited<V>, undefined> : never;
      then: (b: TestFragmentBuilder<S, Ctx>) => TestFragmentBuilder<NoInfer<T>, Ctx>;
    }>,
    deflt: (b: TestFragmentBuilder<S, Ctx>) => TestFragmentBuilder<T, Ctx>,
  ) => TestBuilder<T, Ctx>;
  switchOn(lens: any) {
    return (cases: any, deflt: any): TestBuilder<any, Ctx> => {
      this._steps.push(buildTestSwitchOnStep(lens, cases, deflt));
      return this as TestBuilder<any, Ctx>;
    };
  }

  /** cond-switch (ordered first-match arbitrary predicates). `default` required. */
  switchCond<T>(
    cases: ReadonlyArray<{
      when: (ctx: Ctx, state: S) => boolean | Promise<boolean>;
      then: (b: TestFragmentBuilder<S, Ctx>) => TestFragmentBuilder<NoInfer<T>, Ctx>;
    }>,
    deflt: (b: TestFragmentBuilder<S, Ctx>) => TestFragmentBuilder<T, Ctx>,
  ): TestBuilder<T, Ctx>;
  switchCond(cases: any, deflt: any): TestBuilder<any, Ctx> {
    this._steps.push(buildTestSwitchCondStep(cases, deflt));
    return this as TestBuilder<any, Ctx>;
  }

  /**
   * Finalize and register the test in the global registry.
   * Called automatically via microtask if not explicitly invoked via build().
   * Idempotent — safe to call multiple times.
   * @internal
   */
  private _finalize(): void {
    if (this._built) return;
    this._built = true;

    registerTest({
      id: this._meta.id,
      name: this._meta.name || this._meta.id,
      type: "steps",
      tags: toArray(this._meta.tags),
      description: this._meta.description,
      steps: flattenStepsForRegistry(this._steps),
      hasSetup: !!this._setup,
      hasTeardown: !!this._teardown,
    });
  }

  /**
   * Build and register the test. Returns a plain `Test<S>` object.
   *
   * **Optional** — if omitted, the builder auto-finalizes via microtask
   * after all synchronous chaining completes, and the runner will
   * auto-detect the builder export. Calling `.build()` explicitly is
   * still supported for backward compatibility.
   *
   * @example
   * ```ts
   * // With .build() (explicit — backward compatible)
   * export const myTest = test("my-test")
   *   .step("step-1", async (ctx) => { ... })
   *   .build();
   *
   * // Without .build() (auto-finalized — recommended)
   * export const myTest = test("my-test")
   *   .step("step-1", async (ctx) => { ... });
   * ```
   */
  build(): Test<S> {
    this._finalize();

    return {
      meta: this._meta,
      type: "steps",
      setup: this._setup,
      teardown: this._teardown,
      steps: this._steps as StepDefinition<S>[],
      ...(this._fixtures ? { fixtures: this._fixtures } : {}),
    };
  }
}
