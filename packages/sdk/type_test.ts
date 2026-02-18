/**
 * Compile-time type tests for test.extend() and configure() plugins.
 *
 * These tests verify that TypeScript correctly infers the augmented
 * context types. They don't need to run — they just need to compile.
 * If any type inference breaks, `deno check` will catch it.
 */
// deno-lint-ignore-file require-await no-unused-vars

import { configure, definePlugin, test, type TestBuilder } from "./mod.ts";
import type { ExtensionFn, ResolveExtensions, TestContext } from "./types.ts";

// =============================================================================
// Type-level assertion helpers
// =============================================================================

/** Compile-time check that A is assignable to B. */
type AssertAssignable<A, B> = A extends B ? true : never;

/** Compile-time check that A is exactly B (bidirectional assignability). */
type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// =============================================================================
// ResolveExtensions type inference
// =============================================================================

// Simple factory
type _SimpleFactory = AssertExact<
  ResolveExtensions<{ auth: (ctx: TestContext) => { token: string } }>,
  { auth: { token: string } }
>;

// Async factory
type _AsyncFactory = AssertExact<
  ResolveExtensions<{ auth: (ctx: TestContext) => Promise<{ token: string }> }>,
  { auth: { token: string } }
>;

// Lifecycle factory
type _LifecycleFactory = AssertExact<
  ResolveExtensions<{
    db: (ctx: TestContext, use: (instance: { query: () => void }) => Promise<void>) => Promise<void>;
  }>,
  { db: { query: () => void } }
>;

// Multiple extensions
type _MultipleExtensions = AssertExact<
  ResolveExtensions<{
    auth: (ctx: TestContext) => { token: string };
    db: (ctx: TestContext, use: (instance: { query: () => void }) => Promise<void>) => Promise<void>;
    cache: (ctx: TestContext) => Promise<Map<string, string>>;
  }>,
  { auth: { token: string }; db: { query: () => void }; cache: Map<string, string> }
>;

// =============================================================================
// test.extend() type inference
// =============================================================================

// Single extension — ctx should have the extended property
const withAuth = test.extend({
  auth: (_ctx: TestContext) => ({ token: "abc" as string, refresh: () => {} }),
});

// Quick mode: ctx has auth
withAuth("type-test-1", async (ctx) => {
  const _token: string = ctx.auth.token;
  ctx.auth.refresh();
  // Base TestContext methods still available
  ctx.log("hello");
  ctx.assert(true, "works");
});

// Builder mode: ctx has auth in steps
withAuth("type-test-2")
  .step("use auth", async (ctx) => {
    const _token: string = ctx.auth.token;
    ctx.log("in step");
  });

// Builder mode: setup receives augmented ctx
withAuth("type-test-3")
  .setup(async (ctx) => {
    const _token: string = ctx.auth.token;
    return { setupValue: 42 };
  })
  .step("with state", async (ctx, state) => {
    const _n: number = state.setupValue;
    const _t: string = ctx.auth.token;
  })
  .teardown(async (ctx, state) => {
    const _n: number = state.setupValue;
    ctx.auth.refresh();
  });

// =============================================================================
// Chained extend type inference
// =============================================================================

const withDb = withAuth.extend({
  db: (_ctx: TestContext) => ({ query: (sql: string) => [sql] }),
});

// Chained: ctx has both auth and db
withDb("type-test-4", async (ctx) => {
  const _token: string = ctx.auth.token;
  const _result: string[] = ctx.db.query("SELECT 1");
  ctx.log("both available");
});

// Triple chain
const withCache = withDb.extend({
  cache: (_ctx: TestContext) => new Map<string, string>(),
});

withCache("type-test-5", async (ctx) => {
  const _token: string = ctx.auth.token;
  const _result: string[] = ctx.db.query("SELECT 1");
  ctx.cache.set("key", "value");
});

// =============================================================================
// Extended test .each() type inference
// =============================================================================

withAuth.each([
  { id: 1, expected: 200 },
  { id: 2, expected: 404 },
])("get-$id", async (ctx, row) => {
  const _token: string = ctx.auth.token;
  const _id: number = row.id;
  const _exp: number = row.expected;
});

// Builder mode each
withAuth.each([
  { userId: 1 },
])("user-$userId")
  .step("check", async (ctx, _state, row) => {
    const _token: string = ctx.auth.token;
    const _uid: number = row.userId;
  });

// =============================================================================
// Extended test .pick() type inference
// =============================================================================

withAuth.pick({
  normal: { name: "Alice" },
  edge: { name: "" },
})("create-$_pick", async (ctx, data) => {
  const _token: string = ctx.auth.token;
  const _name: string = data.name;
  const _pick: string = data._pick;
});

// =============================================================================
// configure() with 3+ plugins type inference
// =============================================================================

const gqlPlugin = definePlugin((_runtime) => ({
  query: (_doc: string) => Promise.resolve({}),
}));

const cachePlugin = definePlugin((_runtime) => new Map<string, unknown>());

const metricsPlugin = definePlugin((_runtime) => ({
  count: (_name: string) => {},
  gauge: (_name: string, _value: number) => {},
}));

// Verify that configure with multiple plugins produces correct types
// (This doesn't run — it's a compile check)
function _configureTypeTest() {
  const result = configure({
    vars: { baseUrl: "BASE_URL" },
    plugins: {
      gql: gqlPlugin,
      cache: cachePlugin,
      metrics: metricsPlugin,
    },
  });

  // Each plugin value should be accessible with correct type
  const _gql: { query: (doc: string) => Promise<object> } = result.gql;
  const _cache: Map<string, unknown> = result.cache;
  const _metrics: { count: (name: string) => void; gauge: (name: string, value: number) => void } = result.metrics;

  // Core fields still available
  const _vars = result.vars;
  const _secrets = result.secrets;
  const _http = result.http;
}

// =============================================================================
// TestBuilder<S, Ctx> backward compatibility
// =============================================================================

// Base test() still works without Ctx (defaults to TestContext)
const baseBuilder: TestBuilder<unknown> = test("compat-test");

// Steps with base TestContext
test("compat-steps")
  .step("step1", async (ctx) => {
    ctx.log("still works");
    return { value: 1 };
  })
  .step("step2", async (ctx, state) => {
    const _n: number = state.value;
    ctx.assert(true);
  });

// Base test.each still works
test.each([{ x: 1 }])("compat-each-$x", async (ctx, row) => {
  ctx.log(`x=${row.x}`);
});
