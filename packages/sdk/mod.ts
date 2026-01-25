import type {
  EachTestFunction,
  RegisteredTestMeta,
  SetupFunction,
  SimpleTestFunction,
  StepDefinition,
  StepFunction,
  StepMeta,
  TeardownFunction,
  Test,
  TestMeta,
} from "./types.ts";
import { registerTest } from "./internal.ts";
import { toArray } from "./data.ts";

/**
 * Glubean SDK spec version.
 *
 * This defines the API contract between the SDK, Scanner, and Runner.
 * - Major version: Breaking changes
 * - Minor version: New features (backward compatible)
 *
 * @example
 * ```ts
 * import { SPEC_VERSION } from "@glubean/sdk";
 * console.log("SDK spec version:", SPEC_VERSION);
 * ```
 */
export const SPEC_VERSION = "2.0";

// =============================================================================
// Note: Registry functions (getRegistry, clearRegistry) have been moved to
// internal.ts to keep the public API clean. Import from "@glubean/sdk/internal"
// if you need them (for scanner or testing purposes only).
// =============================================================================

// =============================================================================
// New Builder API
// =============================================================================

/**
 * Builder class for creating tests with a fluent API.
 *
 * @template S The state type for multi-step tests
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
export class TestBuilder<S = unknown> {
  private _meta: TestMeta;
  private _setup?: SetupFunction<S>;
  private _teardown?: TeardownFunction<S>;
  // deno-lint-ignore no-explicit-any
  private _steps: StepDefinition<any>[] = [];
  private _built = false;

  /**
   * Marker property so the runner can detect un-built TestBuilder exports
   * without importing the SDK. The runner checks this string to auto-build.
   */
  readonly __glubean_type = "builder" as const;

  constructor(id: string) {
    this._meta = { id, name: id };
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
  meta(meta: Omit<TestMeta, "id">): TestBuilder<S> {
    this._meta = { ...this._meta, ...meta };
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
   *     const token = await login(ctx.vars.require("USER"));
   *     return { token };
   *   })
   *   .step("verify", async (ctx, { token }) => { ... })
   * ```
   */
  setup<NewS>(fn: SetupFunction<NewS>): TestBuilder<NewS> {
    (this as unknown as TestBuilder<NewS>)._setup = fn;
    return this as unknown as TestBuilder<NewS>;
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
  teardown(fn: TeardownFunction<S>): TestBuilder<S> {
    this._teardown = fn;
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
    fn: (ctx: import("./types.ts").TestContext, state: S) => Promise<void>
  ): TestBuilder<S>;
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
    fn: (ctx: import("./types.ts").TestContext, state: S) => Promise<NewS>
  ): TestBuilder<NewS>;
  /**
   * Add a step with options (void return).
   */
  step(
    name: string,
    options: Omit<StepMeta, "name">,
    fn: (ctx: import("./types.ts").TestContext, state: S) => Promise<void>
  ): TestBuilder<S>;
  /**
   * Add a step with additional options, returning new state.
   */
  step<NewS>(
    name: string,
    options: Omit<StepMeta, "name">,
    fn: (ctx: import("./types.ts").TestContext, state: S) => Promise<NewS>
  ): TestBuilder<NewS>;
  // deno-lint-ignore no-explicit-any
  step(
    name: string,
    optionsOrFn:
      | Omit<StepMeta, "name">
      // deno-lint-ignore no-explicit-any
      | ((ctx: import("./types.ts").TestContext, state: any) => Promise<any>),
    // deno-lint-ignore no-explicit-any
    maybeFn?: (
      ctx: import("./types.ts").TestContext,
      state: any
    ) => Promise<any>
    // deno-lint-ignore no-explicit-any
  ): TestBuilder<any> {
    const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn!;
    const options =
      typeof optionsOrFn === "function" ? {} : (optionsOrFn as StepMeta);

    this._steps.push({
      meta: { name, ...options },
      fn,
    });
    // deno-lint-ignore no-explicit-any
    return this as TestBuilder<any>;
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
  use<NewS>(fn: (builder: TestBuilder<S>) => TestBuilder<NewS>): TestBuilder<NewS> {
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
    fn: (builder: TestBuilder<S>) => TestBuilder<NewS>
  ): TestBuilder<NewS> {
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
    };
  }
}

/**
 * Create a new test.
 *
 * This is the unified entry point for all test definitions.
 * Supports both quick mode (single function) and builder mode (multi-step).
 *
 * @example Quick mode (simple test)
 * ```ts
 * import { test } from "@glubean/sdk";
 *
 * export const login = test("login", async (ctx) => {
 *   const res = await fetch(ctx.vars.require("BASE_URL") + "/login");
 *   ctx.assert(res.ok, "Login should succeed");
 * });
 * ```
 *
 * @example Quick mode with metadata
 * ```ts
 * export const login = test(
 *   { id: "login", tags: ["auth", "smoke"] },
 *   async (ctx) => {
 *     ctx.assert(true, "works");
 *   }
 * );
 * ```
 *
 * @example Builder mode (multi-step) — .build() is optional
 * ```ts
 * export const checkout = test("checkout")
 *   .meta({ tags: ["e2e"] })
 *   .setup(async (ctx) => ({ cart: await createCart() }))
 *   .step("Add item", async (ctx, state) => { ... })
 *   .step("Pay", async (ctx, state) => { ... })
 *   .teardown(async (ctx, state) => { ... });
 * ```
 *
 * @param idOrMeta Test ID (string) or full metadata object
 * @param fn Optional test function (quick mode)
 * @returns Test object (quick mode) or TestBuilder (builder mode)
 */
export function test<S = unknown>(idOrMeta: string | TestMeta): TestBuilder<S>;
export function test(idOrMeta: string | TestMeta, fn: SimpleTestFunction): Test;
export function test<S = unknown>(
  idOrMeta: string | TestMeta,
  fn?: SimpleTestFunction
): Test | TestBuilder<S> {
  const meta: TestMeta =
    typeof idOrMeta === "string"
      ? { id: idOrMeta, name: idOrMeta }
      : { name: idOrMeta.id, ...idOrMeta };

  // Normalize tags to string[]
  if (meta.tags) {
    meta.tags = toArray(meta.tags);
  }

  // Quick mode: test("id", fn) -> returns Test directly
  if (fn) {
    const testDef: Test = {
      meta,
      type: "simple",
      fn,
    };

    // Register to global registry
    registerTest({
      id: meta.id,
      name: meta.name || meta.id,
      type: "simple",
      tags: toArray(meta.tags),
      description: meta.description,
    });

    return testDef;
  }

  // Builder mode: test("id") -> returns TestBuilder
  const builder = new TestBuilder<S>(meta.id);
  if (typeof idOrMeta !== "string") {
    builder.meta(idOrMeta);
  }
  return builder;
}

// =============================================================================
// Data-Driven API (test.each)
// =============================================================================

/**
 * Interpolate `$key` placeholders in a template string with data values.
 * Supports `$index` for the row index and `$key` for any key in the data object.
 *
 * @internal
 */
function interpolateTemplate(
  template: string,
  data: Record<string, unknown>,
  index: number
): string {
  let result = template.replace(/\$index/g, String(index));
  for (const [key, value] of Object.entries(data)) {
    result = result.replaceAll(`$${key}`, String(value));
  }
  return result;
}

/**
 * Resolve baseMeta from string or TestMeta input.
 * @internal
 */
function resolveBaseMeta(idOrMeta: string | TestMeta): TestMeta {
  return typeof idOrMeta === "string"
    ? { id: idOrMeta, name: idOrMeta }
    : { name: idOrMeta.id, ...idOrMeta };
}

// =============================================================================
// EachBuilder — data-driven builder with step support
// =============================================================================

/**
 * Step function for data-driven builder tests.
 * Receives context, current state, and the data row for this test.
 *
 * @template S The state type passed between steps
 * @template T The data row type
 *
 * @example
 * ```ts
 * const stepFn: EachStepFunction<{ token: string }, { userId: number }> =
 *   async (ctx, state, row) => {
 *     const res = await ctx.http.get(`/users/${row.userId}`);
 *     ctx.assert(res.ok, `user ${row.userId} found`);
 *     return state; // pass state to next step
 *   };
 * ```
 */
export type EachStepFunction<S, T> = (
  ctx: import("./types.ts").TestContext,
  state: S,
  row: T
) => Promise<S | void>;

/**
 * Setup function for data-driven builder tests.
 * Receives context and the data row, returns initial state.
 *
 * @template S The state type to return
 * @template T The data row type
 *
 * @example
 * ```ts
 * const setupFn: EachSetupFunction<{ api: HttpClient }, { env: string }> =
 *   async (ctx, row) => {
 *     const api = ctx.http.extend({ baseUrl: row.env });
 *     return { api };
 *   };
 * ```
 */
export type EachSetupFunction<S, T> = (
  ctx: import("./types.ts").TestContext,
  row: T
) => Promise<S>;

/**
 * Teardown function for data-driven builder tests.
 *
 * @template S The state type received from setup
 * @template T The data row type
 *
 * @example
 * ```ts
 * const teardownFn: EachTeardownFunction<{ sessionId: string }, { userId: number }> =
 *   async (ctx, state, row) => {
 *     await ctx.http.delete(`/sessions/${state.sessionId}`);
 *     ctx.log(`cleaned up session for user ${row.userId}`);
 *   };
 * ```
 */
export type EachTeardownFunction<S, T> = (
  ctx: import("./types.ts").TestContext,
  state: S,
  row: T
) => Promise<void>;

/**
 * Builder for data-driven tests with multi-step workflow support.
 *
 * Created by `test.each(table)(idTemplate)` (without a callback).
 * Provides the same fluent `.step()` / `.setup()` / `.teardown()` API
 * as `TestBuilder`, but each step/setup/teardown also receives the
 * data row for the current test.
 *
 * On finalization, creates one `Test` per row in the table, each with
 * full step definitions visible in `glubean scan` metadata and dashboards.
 *
 * @template S The state type for multi-step tests
 * @template T The data row type
 *
 * @example
 * ```ts
 * export const userFlows = test.each([
 *   { userId: 1 },
 *   { userId: 2 },
 * ])("user-flow-$userId")
 *   .step("fetch user", async (ctx, state, { userId }) => {
 *     const res = await ctx.http.get(`/users/${userId}`);
 *     ctx.assert(res.ok, "user exists");
 *     return { user: await res.json() };
 *   })
 *   .step("verify posts", async (ctx, { user }) => {
 *     const res = await ctx.http.get(`/users/${user.id}/posts`);
 *     ctx.assert(res.ok, "posts accessible");
 *   });
 * ```
 */
export class EachBuilder<
  S = unknown,
  T extends Record<string, unknown> = Record<string, unknown>
> {
  private _baseMeta: TestMeta;
  private _table: readonly T[];
  private _setup?: EachSetupFunction<S, T>;
  private _teardown?: EachTeardownFunction<S, T>;
  // deno-lint-ignore no-explicit-any
  private _steps: { meta: StepMeta; fn: EachStepFunction<any, T> }[] = [];
  private _built = false;

  /**
   * Marker property so the runner and scanner can detect EachBuilder exports.
   */
  readonly __glubean_type = "each-builder" as const;

  constructor(baseMeta: TestMeta, table: readonly T[]) {
    this._baseMeta = baseMeta;
    this._table = table;
    // Auto-finalize after all synchronous chaining completes.
    queueMicrotask(() => this._finalize());
  }

  /**
   * Set additional metadata for all generated tests.
   *
   * @example
   * ```ts
   * test.each(table)("user-$userId")
   *   .meta({ tags: ["smoke"], timeout: 10000 })
   *   .step("fetch", async (ctx, state, row) => { ... });
   * ```
   */
  meta(meta: Omit<TestMeta, "id">): EachBuilder<S, T> {
    this._baseMeta = { ...this._baseMeta, ...meta };
    return this;
  }

  /**
   * Set the setup function. Receives context and data row, returns state.
   *
   * @example
   * ```ts
   * test.each(table)("id-$key")
   *   .setup(async (ctx, row) => {
   *     const api = ctx.http.extend({ headers: { "X-User": row.userId } });
   *     return { api };
   *   })
   *   .step("use api", async (ctx, { api }) => { ... });
   * ```
   */
  setup<NewS>(fn: EachSetupFunction<NewS, T>): EachBuilder<NewS, T> {
    (this as unknown as EachBuilder<NewS, T>)._setup = fn;
    return this as unknown as EachBuilder<NewS, T>;
  }

  /**
   * Set the teardown function. Runs after all steps (even on failure).
   *
   * @example
   * ```ts
   * test.each(table)("user-$userId")
   *   .setup(async (ctx, row) => ({ token: await login(ctx, row) }))
   *   .step("test", async (ctx, { token }) => { ... })
   *   .teardown(async (ctx, state, row) => {
   *     await ctx.http.post("/logout", { body: { token: state.token } });
   *   });
   * ```
   */
  teardown(fn: EachTeardownFunction<S, T>): EachBuilder<S, T> {
    this._teardown = fn;
    return this;
  }

  /**
   * Add a step that does not return state (void).
   *
   * @example
   * ```ts
   * test.each(users)("user-$id")
   *   .step("verify", async (ctx, state, row) => {
   *     const res = await ctx.http.get(`/users/${row.id}`);
   *     ctx.expect(res.status).toBe(200);
   *   });
   * ```
   */
  step(
    name: string,
    fn: (
      ctx: import("./types.ts").TestContext,
      state: S,
      row: T
    ) => Promise<void>
  ): EachBuilder<S, T>;
  /**
   * Add a step that returns new state, replacing the current state type.
   */
  step<NewS>(
    name: string,
    fn: (
      ctx: import("./types.ts").TestContext,
      state: S,
      row: T
    ) => Promise<NewS>
  ): EachBuilder<NewS, T>;
  /**
   * Add a step with options (void return).
   */
  step(
    name: string,
    options: Omit<StepMeta, "name">,
    fn: (
      ctx: import("./types.ts").TestContext,
      state: S,
      row: T
    ) => Promise<void>
  ): EachBuilder<S, T>;
  /**
   * Add a step with options, returning new state.
   */
  step<NewS>(
    name: string,
    options: Omit<StepMeta, "name">,
    fn: (
      ctx: import("./types.ts").TestContext,
      state: S,
      row: T
    ) => Promise<NewS>
  ): EachBuilder<NewS, T>;
  // deno-lint-ignore no-explicit-any
  step(
    name: string,
    optionsOrFn:
      | Omit<StepMeta, "name">
      // deno-lint-ignore no-explicit-any
      | ((
          ctx: import("./types.ts").TestContext,
          state: any,
          row: T
        ) => Promise<any>),
    // deno-lint-ignore no-explicit-any
    maybeFn?: (
      ctx: import("./types.ts").TestContext,
      state: any,
      row: T
    ) => Promise<any>
    // deno-lint-ignore no-explicit-any
  ): EachBuilder<any, T> {
    const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn!;
    const options =
      typeof optionsOrFn === "function" ? {} : (optionsOrFn as StepMeta);

    this._steps.push({
      meta: { name, ...options },
      fn,
    });
    // deno-lint-ignore no-explicit-any
    return this as EachBuilder<any, T>;
  }

  /**
   * Apply a builder transform function for step composition.
   *
   * Works the same as `TestBuilder.use()` — reusable step sequences
   * are plain functions that take a builder and return a builder.
   *
   * @param fn Transform function that receives this builder and returns a (possibly re-typed) builder
   *
   * @example
   * ```ts
   * const withVerify = (b: EachBuilder<{ id: string }, { userId: number }>) => b
   *   .step("verify", async (ctx, { id }, row) => {
   *     ctx.expect(id).toBeTruthy();
   *   });
   *
   * export const users = test.each(table)("user-$userId")
   *   .setup(async (ctx, row) => ({ id: String(row.userId) }))
   *   .use(withVerify);
   * ```
   */
  use<NewS>(fn: (builder: EachBuilder<S, T>) => EachBuilder<NewS, T>): EachBuilder<NewS, T> {
    return fn(this);
  }

  /**
   * Apply a builder transform and tag all newly added steps with a group ID.
   *
   * Works the same as `TestBuilder.group()` — steps added by `fn` are marked
   * with `group` metadata for visual grouping in reports.
   *
   * @param id Group identifier (displayed in reports as a section header)
   * @param fn Transform function that adds steps to the builder
   *
   * @example
   * ```ts
   * export const users = test.each(table)("user-$userId")
   *   .group("setup", b => b
   *     .step("init", async (ctx, state, row) => ({ id: String(row.userId) }))
   *   )
   *   .step("verify", async (ctx, { id }) => { ... });
   * ```
   */
  group<NewS>(
    id: string,
    fn: (builder: EachBuilder<S, T>) => EachBuilder<NewS, T>
  ): EachBuilder<NewS, T> {
    const before = this._steps.length;
    const result = fn(this);
    for (let i = before; i < this._steps.length; i++) {
      this._steps[i].meta.group = id;
    }
    return result;
  }

  /**
   * Get the filtered table (apply filter callback if present).
   * @internal
   */
  private _filteredTable(): readonly T[] {
    const filter = this._baseMeta.filter;
    if (!filter) return this._table;
    return this._table.filter((row, index) =>
      filter(row as Record<string, unknown>, index)
    );
  }

  /**
   * Compute tags for a specific row (static tags + tagFields).
   * @internal
   */
  private _tagsForRow(row: T): string[] {
    const staticTags = toArray(this._baseMeta.tags);
    const tagFieldNames = toArray(this._baseMeta.tagFields);
    const dynamicTags = tagFieldNames
      .map((field) => {
        const value = row[field];
        return value != null ? `${field}:${value}` : null;
      })
      .filter((t): t is string => t !== null);
    return [...staticTags, ...dynamicTags];
  }

  /**
   * Finalize and register all tests in the global registry.
   * Called automatically via microtask if not explicitly invoked via build().
   * Idempotent — safe to call multiple times.
   * @internal
   */
  private _finalize(): void {
    if (this._built) return;
    this._built = true;

    const stepMetas = this._steps.map((s) => ({
      name: s.meta.name,
      ...(s.meta.group ? { group: s.meta.group } : {}),
    }));
    const table = this._filteredTable();
    for (let i = 0; i < table.length; i++) {
      const row = table[i];
      const id = interpolateTemplate(this._baseMeta.id, row, i);
      const name = this._baseMeta.name
        ? interpolateTemplate(this._baseMeta.name, row, i)
        : id;

      registerTest({
        id,
        name,
        type: "steps",
        tags: this._tagsForRow(row),
        description: this._baseMeta.description,
        steps: stepMetas,
        hasSetup: !!this._setup,
        hasTeardown: !!this._teardown,
      });
    }
  }

  /**
   * Build and register all tests. Returns a `Test[]` array.
   *
   * **Optional** — if omitted, the builder auto-finalizes via microtask
   * and the runner will auto-detect the EachBuilder export.
   */
  build(): Test<S>[] {
    this._finalize();

    const table = this._filteredTable();
    return table.map((row, index) => {
      const id = interpolateTemplate(this._baseMeta.id, row, index);
      const name = this._baseMeta.name
        ? interpolateTemplate(this._baseMeta.name, row, index)
        : id;

      const meta: TestMeta = {
        ...this._baseMeta,
        id,
        name,
        tags: this._tagsForRow(row),
      };

      const setup = this._setup;
      const teardown = this._teardown;

      return {
        meta,
        type: "steps" as const,
        setup: setup
          ? (((ctx: import("./types.ts").TestContext) =>
              setup(ctx, row)) as SetupFunction<S>)
          : undefined,
        teardown: teardown
          ? (((ctx: import("./types.ts").TestContext, state: S) =>
              teardown(ctx, state, row)) as TeardownFunction<S>)
          : undefined,
        steps: this._steps.map((s) => ({
          meta: s.meta,
          fn: ((ctx: import("./types.ts").TestContext, state: S) =>
            s.fn(ctx, state, row)) as StepFunction<S>,
        })),
      };
    });
  }
}

/**
 * Data-driven test generation.
 *
 * Creates one independent test per row in the data table.
 * Each test gets its own ID (from template interpolation), runs independently,
 * and reports its own pass/fail status.
 *
 * Use `$key` in the ID/name template to interpolate values from the data row.
 * Use `$index` for the row index (0-based).
 *
 * Supports two modes:
 *
 * 1. **Simple mode** — pass a callback to get `Test[]` (single-function tests).
 * 2. **Builder mode** — omit the callback to get an `EachBuilder` with
 *    `.step()` / `.setup()` / `.teardown()` support for multi-step workflows.
 *
 * @example Simple mode (backward compatible)
 * ```ts
 * import { test } from "@glubean/sdk";
 *
 * export const statusTests = test.each([
 *   { id: 1, expected: 200 },
 *   { id: 999, expected: 404 },
 * ])("get-user-$id", async (ctx, { id, expected }) => {
 *   const res = await fetch(`${ctx.vars.require("BASE_URL")}/users/${id}`);
 *   ctx.assert(res.status === expected, `status for id=${id}`);
 * });
 * ```
 *
 * @example Builder mode (multi-step per data row)
 * ```ts
 * export const userFlows = test.each([
 *   { userId: 1 },
 *   { userId: 2 },
 * ])("user-flow-$userId")
 *   .step("fetch user", async (ctx, _state, { userId }) => {
 *     const res = await ctx.http.get(`/users/${userId}`);
 *     ctx.assert(res.ok, "user exists");
 *     return { user: await res.json() };
 *   })
 *   .step("verify posts", async (ctx, { user }) => {
 *     const res = await ctx.http.get(`/users/${user.id}/posts`);
 *     ctx.assert(res.ok, "posts accessible");
 *   });
 * ```
 *
 * @param table Array of data rows. Each row produces one test.
 * @returns A function that accepts an ID template and optional test function
 */
// deno-lint-ignore no-namespace
export namespace test {
  export function each<T extends Record<string, unknown>>(
    table: readonly T[]
  ): {
    // Simple mode: with callback → Test[]
    (idOrMeta: string, fn: EachTestFunction<T>): Test[];
    (idOrMeta: TestMeta, fn: EachTestFunction<T>): Test[];
    // Builder mode: without callback → EachBuilder
    (idOrMeta: string): EachBuilder<unknown, T>;
    (idOrMeta: TestMeta): EachBuilder<unknown, T>;
  } {
    return ((
      idOrMeta: string | TestMeta,
      fn?: EachTestFunction<T>
    ): Test[] | EachBuilder<unknown, T> => {
      const baseMeta = resolveBaseMeta(idOrMeta);

      // Builder mode: no callback → return EachBuilder
      if (!fn) {
        return new EachBuilder<unknown, T>(baseMeta, table);
      }

      // Apply filter if present
      const filteredTable = baseMeta.filter
        ? table.filter((row, index) =>
            baseMeta.filter!(row as Record<string, unknown>, index)
          )
        : table;

      const tagFieldNames = toArray(baseMeta.tagFields);
      const staticTags = toArray(baseMeta.tags);

      // Simple mode: with callback → return Test[]
      return filteredTable.map((row, index) => {
        const id = interpolateTemplate(baseMeta.id, row, index);
        const name = baseMeta.name
          ? interpolateTemplate(baseMeta.name, row, index)
          : id;

        // Compute tags: static tags + dynamic tagFields
        const dynamicTags = tagFieldNames
          .map((field) => {
            const value = (row as Record<string, unknown>)[field];
            return value != null ? `${field}:${value}` : null;
          })
          .filter((t): t is string => t !== null);
        const allTags = [...staticTags, ...dynamicTags];

        const meta: TestMeta = {
          ...baseMeta,
          id,
          name,
          tags: allTags.length > 0 ? allTags : undefined,
        };

        const testDef: Test = {
          meta,
          type: "simple",
          fn: async (ctx) => await fn(ctx, row),
        };

        registerTest({
          id: meta.id,
          name: meta.name || meta.id,
          type: "simple",
          tags: allTags.length > 0 ? allTags : undefined,
          description: meta.description,
        });

        return testDef;
      });
    }) as ReturnType<typeof each<T>>;
  }

  /**
   * Example-selection API — randomly picks N examples from a named map.
   *
   * `test.pick` is a thin wrapper over `test.each`. It selects a subset of
   * examples from a `Record<string, T>`, injects a `_pick` field containing
   * the example key name, and delegates to `test.each`.
   *
   * **Default behavior (no CLI override):** randomly selects `count` examples
   * (default 1). This provides lightweight fuzz / smoke-test coverage.
   *
   * **CLI override:** `--pick key1,key2` (or env var `GLUBEAN_PICK`) selects
   * specific examples by name, overriding random selection.
   *
   * **VSCode integration:** CodeLens buttons let users click a specific
   * example to run, which passes `--pick <key>` under the hood.
   *
   * Use `$_pick` in the ID template to include the example key in the test ID.
   *
   * @param examples A named map of example data rows
   * @param count Number of examples to randomly select (default 1)
   * @returns Same as `test.each` — a function accepting ID template and callback
   *
   * @example Inline examples
   * ```ts
   * export const createUser = test.pick({
   *   "normal":    { name: "Alice", age: 25 },
   *   "edge-case": { name: "", age: -1 },
   *   "admin":     { name: "Admin", role: "admin" },
   * })("create-user-$_pick", async (ctx, example) => {
   *   await ctx.http.post("/api/users", { json: example });
   * });
   * ```
   *
   * @example JSON import
   * ```ts
   * import examples from "./data/create-user.json" with { type: "json" };
   *
   * export const createUser = test.pick(examples)
   *   ("create-user-$_pick", async (ctx, example) => {
   *     await ctx.http.post("/api/users", { json: example });
   *   });
   * ```
   *
   * @example CLI usage
   * ```bash
   * glubean run file.ts                  # random example
   * glubean run file.ts --pick normal    # specific example
   * glubean run file.ts --pick normal,admin  # multiple examples
   * ```
   */
  export function pick<T extends Record<string, unknown>>(
    examples: Record<string, T>,
    count = 1
  ): ReturnType<typeof each<T & { _pick: string }>> {
    const keys = Object.keys(examples);
    if (keys.length === 0) {
      throw new Error("test.pick requires at least one example");
    }

    // Check for explicit selection via env var (set by CLI --pick or VSCode).
    // Wrapped in try-catch because the harness subprocess may not have --allow-env
    // (older runner versions). In that case, fall back to random selection.
    let pickedEnv: string | undefined;
    try {
      pickedEnv =
        typeof Deno !== "undefined" ? Deno.env.get("GLUBEAN_PICK") : undefined;
    } catch {
      // Permission denied — fall through to random selection
      pickedEnv = undefined;
    }

    let selected: (T & { _pick: string })[];
    if (pickedEnv) {
      // Explicit selection: only use keys that exist in this examples map.
      // GLUBEAN_PICK is a process-level env var that leaks to ALL test.pick
      // calls in a file. If the key doesn't match this call's examples,
      // gracefully fall back to random selection instead of throwing.
      const pickedKeys = pickedEnv
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
      const validKeys = pickedKeys.filter((k) => k in examples);
      if (validKeys.length > 0) {
        selected = validKeys.map((k) => ({ ...examples[k], _pick: k }));
      } else {
        // None of the picked keys exist in this examples map — fall back to random
        const shuffled = [...keys].sort(() => Math.random() - 0.5);
        const picked = shuffled.slice(0, Math.min(count, keys.length));
        selected = picked.map((k) => ({ ...examples[k], _pick: k }));
      }
    } else {
      // Random selection: shuffle and take `count`
      const shuffled = [...keys].sort(() => Math.random() - 0.5);
      const picked = shuffled.slice(0, Math.min(count, keys.length));
      selected = picked.map((k) => ({ ...examples[k], _pick: k }));
    }

    return test.each(selected);
  }
}

// Re-export all types for user convenience
export * from "./types.ts";

// Re-export data loaders for convenience
// Users can also import from "@glubean/sdk/data" directly
export { fromCsv, fromDir, fromGql, fromJsonl, fromYaml, toArray } from "./data.ts";
export type {
  FromCsvOptions,
  FromDirOptions,
  FromYamlOptions,
} from "./data.ts";

// Re-export configure API
export { configure } from "./configure.ts";

// Re-export assertion utilities
export { Expectation, ExpectFailError } from "./expect.ts";
export type { AssertEmitter, AssertionEmission } from "./expect.ts";

// Re-export GraphQL utilities (⚠️ Experimental)
// Users can also import from "@glubean/sdk/graphql" directly
export {
  createGraphQLClient,
  GraphQLResponseError,
} from "./graphql.ts";
export type {
  GraphQLClient,
  GraphQLClientOptions,
  GraphQLError,
  GraphQLRequestOptions,
  GraphQLResponse,
} from "./graphql.ts";
