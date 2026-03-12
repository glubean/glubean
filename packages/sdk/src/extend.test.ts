import { test, expect } from "vitest";
import { test as glubeanTest, TestBuilder } from "./index.js";
import { clearRegistry, getRegistry } from "./internal.js";
import type { TestContext } from "./types.js";

// ---------------------------------------------------------------------------
// test.extend() — basic callable behavior
// ---------------------------------------------------------------------------

test("test.extend() returns a callable test function", () => {
  clearRegistry();

  const myTest = glubeanTest.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  // Quick mode
  const t = myTest("ext-quick", async (_ctx) => {});
  expect(t).toBeDefined();
  expect(t.type).toBe("simple");
  expect(t.meta.id).toBe("ext-quick");
});

test("test.extend() creates tests with correct fixture definitions", () => {
  clearRegistry();

  const factory = (_ctx: TestContext) => ({ token: "abc" });
  const myTest = glubeanTest.extend({ auth: factory });

  const t = myTest("ext-fixtures", async (_ctx) => {});
  expect(t.fixtures).toBeDefined();
  expect(typeof t.fixtures!.auth).toBe("function");
  expect(t.fixtures!.auth).toBe(factory);
});

test("test.extend() registers test in global registry", () => {
  clearRegistry();

  const myTest = glubeanTest.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  myTest("ext-registered", async (_ctx) => {});

  const registry = getRegistry();
  expect(registry.length).toBe(1);
  expect(registry[0].id).toBe("ext-registered");
  expect(registry[0].type).toBe("simple");
});

// ---------------------------------------------------------------------------
// test.extend() — builder mode
// ---------------------------------------------------------------------------

test("test.extend() builder mode returns TestBuilder with fixtures", async () => {
  clearRegistry();

  const myTest = glubeanTest.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  const builder = myTest("ext-builder");
  expect(builder).toBeDefined();
  expect(builder instanceof TestBuilder).toBe(true);

  // Build and verify fixtures
  const t = builder
    .step("check", async (_ctx) => {})
    .build();

  expect(t.fixtures).toBeDefined();
  expect(typeof t.fixtures!.auth).toBe("function");

  // Wait for microtask (auto-finalize)
  await new Promise((r) => setTimeout(r, 10));
});

test("test.extend() builder steps receive augmented Ctx type", async () => {
  clearRegistry();

  const myTest = glubeanTest.extend({
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

  expect(t.type).toBe("steps");
  expect(t.steps!.length).toBe(1);
  expect(t.steps![0].meta.name).toBe("use auth");
  expect(t.fixtures).toBeDefined();

  await new Promise((r) => setTimeout(r, 10));
});

// ---------------------------------------------------------------------------
// Chained extend
// ---------------------------------------------------------------------------

test("chained extend accumulates fixtures", () => {
  clearRegistry();

  const authFactory = (_ctx: TestContext) => ({ token: "abc" });
  const dbFactory = (_ctx: TestContext) => ({ query: (sql: string) => sql });

  const withAuth = glubeanTest.extend({ auth: authFactory });
  const withBoth = withAuth.extend({ db: dbFactory });

  const t = withBoth("chained-extend", async (_ctx) => {});

  expect(t.fixtures).toBeDefined();
  expect(typeof t.fixtures!.auth).toBe("function");
  expect(typeof t.fixtures!.db).toBe("function");
  expect(t.fixtures!.auth).toBe(authFactory);
  expect(t.fixtures!.db).toBe(dbFactory);
});

test("chained extend preserves parent fixtures", () => {
  clearRegistry();

  const parentFactory = (_ctx: TestContext) => "parent-value";
  const childFactory = (_ctx: TestContext) => "child-value";

  const parent = glubeanTest.extend({ parent: parentFactory });
  const child = parent.extend({ child: childFactory });

  const t = child("chained-preserve", async (_ctx) => {});
  expect(t.fixtures!.parent).toBe(parentFactory);
  expect(t.fixtures!.child).toBe(childFactory);
});

test("chained extend can override parent fixtures", () => {
  clearRegistry();

  const originalFactory = (_ctx: TestContext) => "original";
  const overrideFactory = (_ctx: TestContext) => "overridden";

  const parent = glubeanTest.extend({ auth: originalFactory });
  const child = parent.extend({ auth: overrideFactory });

  const t = child("chained-override", async (_ctx) => {});
  expect(t.fixtures!.auth).toBe(overrideFactory);
});

// ---------------------------------------------------------------------------
// Extended test — .each()
// ---------------------------------------------------------------------------

test("extended test .each() simple mode creates tests with fixtures", () => {
  clearRegistry();

  const myTest = glubeanTest.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  const tests = myTest.each([
    { id: 1, expected: 200 },
    { id: 2, expected: 404 },
  ])("get-$id", async (_ctx, _row) => {});

  expect(tests.length).toBe(2);
  expect(tests[0].meta.id).toBe("get-1");
  expect(tests[1].meta.id).toBe("get-2");
  expect(tests[0].fixtures).toBeDefined();
  expect(tests[1].fixtures).toBeDefined();

  const registry = getRegistry();
  expect(registry.length).toBe(2);
});

test("extended test .each() builder mode returns EachBuilder with fixtures", async () => {
  clearRegistry();

  const myTest = glubeanTest.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  const builder = myTest.each([
    { userId: 1 },
    { userId: 2 },
  ])("user-$userId");

  const tests = builder
    .step("check", async (_ctx, _state, _row) => {})
    .build();

  expect(tests.length).toBe(2);
  expect(tests[0].fixtures).toBeDefined();
  expect(tests[1].fixtures).toBeDefined();

  await new Promise((r) => setTimeout(r, 10));
});

// ---------------------------------------------------------------------------
// Extended test — .pick()
// ---------------------------------------------------------------------------

test("extended test .pick() creates tests with fixtures", () => {
  clearRegistry();

  const myTest = glubeanTest.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  const tests = myTest.pick({
    normal: { name: "Alice" },
    edge: { name: "" },
  })("create-$_pick", async (_ctx, _data) => {});

  expect(tests.length).toBe(1); // Default count is 1
  expect(tests[0].fixtures).toBeDefined();
  expect(tests[0].meta.id).toBeDefined();
});

// ---------------------------------------------------------------------------
// Reserved key guard
// ---------------------------------------------------------------------------

test("test.extend() throws on reserved key 'vars'", () => {
  expect(
    () => glubeanTest.extend({ vars: (_ctx: TestContext) => ({}) }),
  ).toThrow('reserved key "vars"');
});

test("test.extend() throws on reserved key 'secrets'", () => {
  expect(
    () => glubeanTest.extend({ secrets: (_ctx: TestContext) => ({}) }),
  ).toThrow('reserved key "secrets"');
});

test("test.extend() throws on reserved key 'http'", () => {
  expect(
    () => glubeanTest.extend({ http: (_ctx: TestContext) => ({}) }),
  ).toThrow('reserved key "http"');
});

test("chained extend throws on reserved key", () => {
  const myTest = glubeanTest.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  expect(
    () => myTest.extend({ vars: (_ctx: TestContext) => ({}) }),
  ).toThrow('reserved key "vars"');
});

// ---------------------------------------------------------------------------
// Fixtures stored on Test object for runner resolution
// ---------------------------------------------------------------------------

test("Test object from quick mode has fixtures for runner", () => {
  clearRegistry();

  const lifecycleFactory = async (_ctx: TestContext, use: (instance: string) => Promise<void>) => {
    await use("lifecycle-value");
  };

  const myTest = glubeanTest.extend({
    simple: (_ctx: TestContext) => "simple-value",
    lifecycle: lifecycleFactory,
  });

  const t = myTest("runner-fixtures", async (_ctx) => {});
  expect(t.fixtures).toBeDefined();
  expect(Object.keys(t.fixtures!).sort()).toEqual(["lifecycle", "simple"]);
});

test("Test object from builder has fixtures for runner", async () => {
  clearRegistry();

  const myTest = glubeanTest.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  const t = myTest("runner-builder-fixtures")
    .step("check", async (_ctx) => {})
    .build();

  expect(t.fixtures).toBeDefined();
  expect(Object.keys(t.fixtures!)).toEqual(["auth"]);

  await new Promise((r) => setTimeout(r, 10));
});

// ---------------------------------------------------------------------------
// Extended test with metadata
// ---------------------------------------------------------------------------

test("extended test quick mode supports metadata object", () => {
  clearRegistry();

  const myTest = glubeanTest.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  const t = myTest(
    { id: "ext-meta", tags: ["smoke"], description: "with metadata" },
    async (_ctx) => {},
  );

  expect(t.meta.id).toBe("ext-meta");
  expect(t.meta.tags).toEqual(["smoke"]);
  expect(t.meta.description).toBe("with metadata");

  const registry = getRegistry();
  expect(registry[0].tags).toEqual(["smoke"]);
});

test("extended test builder mode supports .meta()", async () => {
  clearRegistry();

  const myTest = glubeanTest.extend({
    auth: (_ctx: TestContext) => ({ token: "abc" }),
  });

  const t = myTest("ext-builder-meta")
    .meta({ tags: ["e2e"], description: "builder with meta" })
    .step("do stuff", async (_ctx) => {})
    .build();

  expect(t.meta.tags).toEqual(["e2e"]);
  expect(t.meta.description).toBe("builder with meta");

  await new Promise((r) => setTimeout(r, 10));
});
