// deno-lint-ignore-file require-await
import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { test, TestBuilder } from "./mod.ts";
import { clearRegistry, getRegistry } from "./internal.ts";
import type { TestContext } from "./types.ts";

// ---------------------------------------------------------------------------
// test.extend() — basic callable behavior
// ---------------------------------------------------------------------------

Deno.test("test.extend() returns a callable test function", () => {
  clearRegistry();

  const myTest = test.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  // Quick mode
  const t = myTest("ext-quick", async (_ctx) => {});
  assertExists(t);
  assertEquals(t.type, "simple");
  assertEquals(t.meta.id, "ext-quick");
});

Deno.test("test.extend() creates tests with correct fixture definitions", () => {
  clearRegistry();

  const factory = (_ctx: TestContext) => ({ token: "abc" });
  const myTest = test.extend({ auth: factory });

  const t = myTest("ext-fixtures", async (_ctx) => {});
  assertExists(t.fixtures);
  assertEquals(typeof t.fixtures!.auth, "function");
  assertEquals(t.fixtures!.auth, factory);
});

Deno.test("test.extend() registers test in global registry", () => {
  clearRegistry();

  const myTest = test.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  myTest("ext-registered", async (_ctx) => {});

  const registry = getRegistry();
  assertEquals(registry.length, 1);
  assertEquals(registry[0].id, "ext-registered");
  assertEquals(registry[0].type, "simple");
});

// ---------------------------------------------------------------------------
// test.extend() — builder mode
// ---------------------------------------------------------------------------

Deno.test("test.extend() builder mode returns TestBuilder with fixtures", async () => {
  clearRegistry();

  const myTest = test.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  const builder = myTest("ext-builder");
  assertExists(builder);
  assertEquals(builder instanceof TestBuilder, true);

  // Build and verify fixtures
  const t = builder
    .step("check", async (_ctx) => {})
    .build();

  assertExists(t.fixtures);
  assertEquals(typeof t.fixtures!.auth, "function");

  // Wait for microtask (auto-finalize)
  await new Promise((r) => setTimeout(r, 10));
});

Deno.test("test.extend() builder steps receive augmented Ctx type", async () => {
  clearRegistry();

  const myTest = test.extend({
    auth: (_ctx: TestContext) => ({ token: "hello" }),
  });

  const t = myTest("ext-builder-ctx")
    .step("use auth", async (ctx) => {
      // Type-level: ctx should have auth property
      // Runtime: the runner would merge fixtures into ctx, but here
      // we verify the test structure is correct
      void ctx;
    })
    .build();

  assertEquals(t.type, "steps");
  assertEquals(t.steps!.length, 1);
  assertEquals(t.steps![0].meta.name, "use auth");
  assertExists(t.fixtures);

  await new Promise((r) => setTimeout(r, 10));
});

// ---------------------------------------------------------------------------
// Chained extend
// ---------------------------------------------------------------------------

Deno.test("chained extend accumulates fixtures", () => {
  clearRegistry();

  const authFactory = (_ctx: TestContext) => ({ token: "abc" });
  const dbFactory = (_ctx: TestContext) => ({ query: (sql: string) => sql });

  const withAuth = test.extend({ auth: authFactory });
  const withBoth = withAuth.extend({ db: dbFactory });

  const t = withBoth("chained-extend", async (_ctx) => {});

  assertExists(t.fixtures);
  assertEquals(typeof t.fixtures!.auth, "function");
  assertEquals(typeof t.fixtures!.db, "function");
  assertEquals(t.fixtures!.auth, authFactory);
  assertEquals(t.fixtures!.db, dbFactory);
});

Deno.test("chained extend preserves parent fixtures", () => {
  clearRegistry();

  const parentFactory = (_ctx: TestContext) => "parent-value";
  const childFactory = (_ctx: TestContext) => "child-value";

  const parent = test.extend({ parent: parentFactory });
  const child = parent.extend({ child: childFactory });

  const t = child("chained-preserve", async (_ctx) => {});
  assertEquals(t.fixtures!.parent, parentFactory);
  assertEquals(t.fixtures!.child, childFactory);
});

Deno.test("chained extend can override parent fixtures", () => {
  clearRegistry();

  const originalFactory = (_ctx: TestContext) => "original";
  const overrideFactory = (_ctx: TestContext) => "overridden";

  const parent = test.extend({ auth: originalFactory });
  const child = parent.extend({ auth: overrideFactory });

  const t = child("chained-override", async (_ctx) => {});
  assertEquals(t.fixtures!.auth, overrideFactory);
});

// ---------------------------------------------------------------------------
// Extended test — .each()
// ---------------------------------------------------------------------------

Deno.test("extended test .each() simple mode creates tests with fixtures", () => {
  clearRegistry();

  const myTest = test.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  const tests = myTest.each([
    { id: 1, expected: 200 },
    { id: 2, expected: 404 },
  ])("get-$id", async (_ctx, _row) => {});

  assertEquals(tests.length, 2);
  assertEquals(tests[0].meta.id, "get-1");
  assertEquals(tests[1].meta.id, "get-2");
  assertExists(tests[0].fixtures);
  assertExists(tests[1].fixtures);

  const registry = getRegistry();
  assertEquals(registry.length, 2);
});

Deno.test("extended test .each() builder mode returns EachBuilder with fixtures", async () => {
  clearRegistry();

  const myTest = test.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  const builder = myTest.each([
    { userId: 1 },
    { userId: 2 },
  ])("user-$userId");

  const tests = builder
    .step("check", async (_ctx, _state, _row) => {})
    .build();

  assertEquals(tests.length, 2);
  assertExists(tests[0].fixtures);
  assertExists(tests[1].fixtures);

  await new Promise((r) => setTimeout(r, 10));
});

// ---------------------------------------------------------------------------
// Extended test — .pick()
// ---------------------------------------------------------------------------

Deno.test("extended test .pick() creates tests with fixtures", () => {
  clearRegistry();

  const myTest = test.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  const tests = myTest.pick({
    normal: { name: "Alice" },
    edge: { name: "" },
  })("create-$_pick", async (_ctx, _data) => {});

  assertEquals(tests.length, 1); // Default count is 1
  assertExists(tests[0].fixtures);
  assertExists(tests[0].meta.id);
});

// ---------------------------------------------------------------------------
// Reserved key guard
// ---------------------------------------------------------------------------

Deno.test("test.extend() throws on reserved key 'vars'", () => {
  assertThrows(
    () => test.extend({ vars: (_ctx: TestContext) => ({}) }),
    Error,
    'reserved key "vars"',
  );
});

Deno.test("test.extend() throws on reserved key 'secrets'", () => {
  assertThrows(
    () => test.extend({ secrets: (_ctx: TestContext) => ({}) }),
    Error,
    'reserved key "secrets"',
  );
});

Deno.test("test.extend() throws on reserved key 'http'", () => {
  assertThrows(
    () => test.extend({ http: (_ctx: TestContext) => ({}) }),
    Error,
    'reserved key "http"',
  );
});

Deno.test("chained extend throws on reserved key", () => {
  const myTest = test.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  assertThrows(
    () => myTest.extend({ vars: (_ctx: TestContext) => ({}) }),
    Error,
    'reserved key "vars"',
  );
});

// ---------------------------------------------------------------------------
// Fixtures stored on Test object for runner resolution
// ---------------------------------------------------------------------------

Deno.test("Test object from quick mode has fixtures for runner", () => {
  clearRegistry();

  const lifecycleFactory = async (_ctx: TestContext, use: (instance: string) => Promise<void>) => {
    await use("lifecycle-value");
  };

  const myTest = test.extend({
    simple: (_ctx: TestContext) => "simple-value",
    lifecycle: lifecycleFactory,
  });

  const t = myTest("runner-fixtures", async (_ctx) => {});
  assertExists(t.fixtures);
  assertEquals(Object.keys(t.fixtures!).sort(), ["lifecycle", "simple"]);
});

Deno.test("Test object from builder has fixtures for runner", async () => {
  clearRegistry();

  const myTest = test.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  const t = myTest("runner-builder-fixtures")
    .step("check", async (_ctx) => {})
    .build();

  assertExists(t.fixtures);
  assertEquals(Object.keys(t.fixtures!), ["auth"]);

  await new Promise((r) => setTimeout(r, 10));
});

// ---------------------------------------------------------------------------
// Extended test with metadata
// ---------------------------------------------------------------------------

Deno.test("extended test quick mode supports metadata object", () => {
  clearRegistry();

  const myTest = test.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  const t = myTest(
    { id: "ext-meta", tags: ["smoke"], description: "with metadata" },
    async (_ctx) => {},
  );

  assertEquals(t.meta.id, "ext-meta");
  assertEquals(t.meta.tags, ["smoke"]);
  assertEquals(t.meta.description, "with metadata");

  const registry = getRegistry();
  assertEquals(registry[0].tags, ["smoke"]);
});

Deno.test("extended test builder mode supports .meta()", async () => {
  clearRegistry();

  const myTest = test.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  const t = myTest("ext-builder-meta")
    .meta({ tags: ["e2e"], description: "builder with meta" })
    .step("do stuff", async (_ctx) => {})
    .build();

  assertEquals(t.meta.tags, ["e2e"]);
  assertEquals(t.meta.description, "builder with meta");

  await new Promise((r) => setTimeout(r, 10));
});
