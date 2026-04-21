import type {
  ExtensionFn,
  SetupFunction,
  StepDefinition,
  StepFunction,
  StepMeta,
  TeardownFunction,
  Test,
  TestContext,
  TestMeta,
} from "./types.js";
import { registerTest } from "./internal.js";
import { toArray } from "./data.js";

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
      steps: this._steps.map((s) => ({
        name: s.meta.name,
        ...(s.meta.group ? { group: s.meta.group } : {}),
      })),
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
