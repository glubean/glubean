/**
 * @module each-builder
 *
 * Data-driven builder for multi-step tests (`EachBuilder`).
 *
 * Entry point: `test.each(table)("id-$key")` (no callback) returns an `EachBuilder`.
 * Same fluent API as `TestBuilder`, but each step/setup/teardown also receives
 * the data row (`row`) as a third argument. One `Test` is generated per row.
 * Also exports `EachStepFunction`, `EachSetupFunction`, `EachTeardownFunction` types.
 */
import type {
  ExtensionFn,
  SetupFunction,
  StepFunction,
  StepMeta,
  TeardownFunction,
  Test,
  TestContext,
  TestMeta,
} from "./types.js";
import { registerTest } from "./internal.js";
import { toArray } from "./data.js";
import { interpolateTemplate } from "./test-utils.js";

/**
 * Step function for data-driven builder tests.
 * Receives context, current state, and the data row for this test.
 *
 * @template S The state type passed between steps
 * @template T The data row type
 * @template Ctx The context type (defaults to TestContext)
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
export type EachStepFunction<S, T, Ctx extends TestContext = TestContext> = (
  ctx: Ctx,
  state: S,
  row: T,
) => Promise<S | void>;

/**
 * Setup function for data-driven builder tests.
 * Receives context and the data row, returns initial state.
 *
 * @template S The state type to return
 * @template T The data row type
 * @template Ctx The context type (defaults to TestContext)
 *
 * @example
 * ```ts
 * const setupFn: EachSetupFunction<{ api: HttpClient }, { env: string }> =
 *   async (ctx, row) => {
 *     const api = ctx.http.extend({ prefixUrl: row.env });
 *     return { api };
 *   };
 * ```
 */
export type EachSetupFunction<S, T, Ctx extends TestContext = TestContext> = (
  ctx: Ctx,
  row: T,
) => Promise<S>;

/**
 * Teardown function for data-driven builder tests.
 *
 * @template S The state type received from setup
 * @template T The data row type
 * @template Ctx The context type (defaults to TestContext)
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
export type EachTeardownFunction<
  S,
  T,
  Ctx extends TestContext = TestContext,
> = (ctx: Ctx, state: S, row: T) => Promise<void>;

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
  T extends Record<string, unknown> = Record<string, unknown>,
  Ctx extends TestContext = TestContext,
> {
  private _baseMeta: TestMeta;
  private _table: readonly T[];
  private _setup?: EachSetupFunction<S, T, Ctx>;
  private _teardown?: EachTeardownFunction<S, T, Ctx>;

  private _steps: { meta: StepMeta; fn: EachStepFunction<any, T, Ctx> }[] = [];
  private _built = false;
  private _parallel: boolean;

  _fixtures?: Record<string, ExtensionFn<any>>;

  /**
   * Marker property so the runner and scanner can detect EachBuilder exports.
   */
  readonly __glubean_type = "each-builder" as const;

  constructor(
    baseMeta: TestMeta,
    table: readonly T[],
    fixtures?: Record<string, ExtensionFn<any>>,
    parallel = false,
  ) {
    this._baseMeta = baseMeta;
    this._table = table;
    this._fixtures = fixtures;
    this._parallel = parallel;
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
  meta(meta: Omit<TestMeta, "id">): EachBuilder<S, T, Ctx> {
    this._baseMeta = { ...this._baseMeta, ...meta };
    return this;
  }

  /**
   * Mark all generated tests from this data set as focused.
   * If `skip` is also set, skipped tests are still excluded.
   */
  only(): EachBuilder<S, T, Ctx> {
    this._baseMeta = { ...this._baseMeta, only: true };
    return this;
  }

  /**
   * Mark all generated tests from this data set as skipped.
   * Skip takes precedence over `only` when both are present.
   */
  skip(): EachBuilder<S, T, Ctx> {
    this._baseMeta = { ...this._baseMeta, skip: true };
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
  setup<NewS>(
    fn: (ctx: Ctx, row: T) => Promise<NewS>,
  ): EachBuilder<NewS, T, Ctx> {
    (this as unknown as EachBuilder<NewS, T, Ctx>)._setup = fn as unknown as EachSetupFunction<NewS, T, Ctx>;
    return this as unknown as EachBuilder<NewS, T, Ctx>;
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
  teardown(
    fn: (ctx: Ctx, state: S, row: T) => Promise<void>,
  ): EachBuilder<S, T, Ctx> {
    this._teardown = fn as unknown as EachTeardownFunction<S, T, Ctx>;
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
    fn: (ctx: Ctx, state: S, row: T) => Promise<void>,
  ): EachBuilder<S, T, Ctx>;
  /**
   * Add a step that returns new state, replacing the current state type.
   */
  step<NewS>(
    name: string,
    fn: (ctx: Ctx, state: S, row: T) => Promise<NewS>,
  ): EachBuilder<NewS, T, Ctx>;
  /**
   * Add a step with options (void return).
   */
  step(
    name: string,
    options: Omit<StepMeta, "name">,
    fn: (ctx: Ctx, state: S, row: T) => Promise<void>,
  ): EachBuilder<S, T, Ctx>;
  /**
   * Add a step with options, returning new state.
   */
  step<NewS>(
    name: string,
    options: Omit<StepMeta, "name">,
    fn: (ctx: Ctx, state: S, row: T) => Promise<NewS>,
  ): EachBuilder<NewS, T, Ctx>;
  step(
    name: string,
    optionsOrFn:
      | Omit<StepMeta, "name">
      | ((ctx: Ctx, state: any, row: T) => Promise<any>),
    maybeFn?: (ctx: Ctx, state: any, row: T) => Promise<any>,
  ): EachBuilder<any, T, Ctx> {
    const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn!;
    const options = typeof optionsOrFn === "function" ? {} : (optionsOrFn as StepMeta);

    this._steps.push({
      meta: { name, ...options },
      fn,
    });

    return this as EachBuilder<any, T, Ctx>;
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
  use<NewS>(
    fn: (builder: EachBuilder<S, T, Ctx>) => EachBuilder<NewS, T, Ctx>,
  ): EachBuilder<NewS, T, Ctx> {
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
    fn: (builder: EachBuilder<S, T, Ctx>) => EachBuilder<NewS, T, Ctx>,
  ): EachBuilder<NewS, T, Ctx> {
    const before = this._steps.length;
    const result = fn(this);
    for (let i = before; i < this._steps.length; i++) {
      this._steps[i].meta.group = id;
    }
    return result;
  }

  /** @internal */
  private _filteredTable(): readonly T[] {
    const filter = this._baseMeta.filter;
    if (!filter) return this._table;
    return this._table.filter((row, index) => filter(row as Record<string, unknown>, index));
  }

  /** @internal */
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
    const isPick = table.length > 0 && "_pick" in table[0];
    const hasGroup = isPick || this._parallel;
    for (let i = 0; i < table.length; i++) {
      const row = table[i];
      const id = interpolateTemplate(this._baseMeta.id, row, i);
      const name = this._baseMeta.name ? interpolateTemplate(this._baseMeta.name, row, i) : id;

      registerTest({
        id,
        name,
        type: "steps",
        tags: this._tagsForRow(row),
        description: this._baseMeta.description,
        steps: stepMetas,
        hasSetup: !!this._setup,
        hasTeardown: !!this._teardown,
        ...(hasGroup ? { groupId: this._baseMeta.id } : {}),
        ...(this._parallel ? { parallel: true } : {}),
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
      const name = this._baseMeta.name ? interpolateTemplate(this._baseMeta.name, row, index) : id;

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
        setup: setup ? (((ctx: TestContext) => setup(ctx as Ctx, row)) as SetupFunction<S>) : undefined,
        teardown: teardown
          ? (((ctx: TestContext, state: S) => teardown(ctx as Ctx, state, row)) as TeardownFunction<S>)
          : undefined,
        steps: this._steps.map((s) => ({
          meta: s.meta,
          fn: ((ctx: TestContext, state: S) => s.fn(ctx as Ctx, state, row)) as StepFunction<S>,
        })),
        ...(this._fixtures ? { fixtures: this._fixtures } : {}),
      };
    });
  }
}
