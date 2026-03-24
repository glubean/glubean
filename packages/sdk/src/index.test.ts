import { test, expect } from "vitest";
import { EachBuilder, SPEC_VERSION, test as glubeanTest, TestBuilder } from "./index.js";
import { clearRegistry, getRegistry } from "./internal.js";
import { Expectation } from "./expect.js";
import type { SecretsAccessor, TestContext, ValidatorFn, VarsAccessor } from "./types.js";

function runValidator(
  result: boolean | string | void | null,
  key: string,
  type: "var" | "secret",
): void {
  if (result === true || result === undefined || result === null) {
    return;
  }
  if (typeof result === "string") {
    throw new Error(`Invalid ${type} "${key}": ${result}`);
  }
  throw new Error(`Invalid ${type} "${key}": validation failed`);
}

function createVarsAccessor(
  initial: Record<string, string> = {},
): VarsAccessor {
  const vars = { ...initial };
  return {
    get: (key) => vars[key],
    require: (key, validate?: ValidatorFn) => {
      const value = vars[key];
      if (value === undefined || value === null || value === "") {
        throw new Error(`Missing required var: ${key}`);
      }
      if (validate) {
        runValidator(validate(value), key, "var");
      }
      return value;
    },
    all: () => ({ ...vars }),
  };
}

function createSecretsAccessor(
  initial: Record<string, string> = {},
): SecretsAccessor {
  const secrets = { ...initial };
  return {
    get: (key) => secrets[key],
    require: (key, validate?: ValidatorFn) => {
      const value = secrets[key];
      if (value === undefined || value === null || value === "") {
        throw new Error(`Missing required secret: ${key}`);
      }
      if (validate) {
        runValidator(validate(value), key, "secret");
      }
      return value;
    },
  };
}

function createMockContext(
  vars: Record<string, string> = {},
  secrets: Record<string, string> = {},
): TestContext {
  // Create a minimal mock http client for testing
  const mockHttp = Object.assign(
    (_url: string | URL | Request) => Promise.resolve(new Response()),
    {
      get: (_url: string | URL | Request) => Promise.resolve(new Response()),
      post: (_url: string | URL | Request) => Promise.resolve(new Response()),
      put: (_url: string | URL | Request) => Promise.resolve(new Response()),
      patch: (_url: string | URL | Request) => Promise.resolve(new Response()),
      delete: (_url: string | URL | Request) => Promise.resolve(new Response()),
      head: (_url: string | URL | Request) => Promise.resolve(new Response()),
      extend: () => mockHttp,
    },
  );

  return {
    vars: createVarsAccessor(vars),
    secrets: createSecretsAccessor(secrets),
    log: () => {},
    assert: () => {},
    trace: () => {},
    action: () => {},
    event: () => {},
    metric: () => {},
    http: mockHttp as unknown as import("./types.js").HttpClient,
    expect: <V>(actual: V) => new Expectation(actual, () => {}),
    warn: () => {},
    validate: () => undefined,
    skip: (reason?: string): never => {
      throw new Error(`Test skipped${reason ? `: ${reason}` : ""}`);
    },
    fail: (message: string): never => {
      throw new Error(`Test failed: ${message}`);
    },
    pollUntil: async (_options, fn) => {
      const result = await fn();
      if (!result) throw new Error("pollUntil: condition not met");
    },
    setTimeout: () => {},
    retryCount: 0,
    getMemoryUsage: () => null, // Not available in test environment
  };
}

// ==================== SPEC VERSION ====================

test("SPEC_VERSION is 2.0", () => {
  expect(SPEC_VERSION).toBe("2.0");
});

// ==================== Registry Tests ====================

test("getRegistry returns empty array initially", () => {
  clearRegistry();
  const registry = getRegistry();
  expect(registry).toEqual([]);
});

test("clearRegistry clears all registered tests", () => {
  clearRegistry();
  glubeanTest("temp-test", () => Promise.resolve());
  expect(getRegistry().length).toBe(1);
  clearRegistry();
  expect(getRegistry().length).toBe(0);
});

// ==================== New test() API Tests ====================

test("test() - quick mode with string id", () => {
  clearRegistry();
  const fn = (_ctx: TestContext) => Promise.resolve();
  const result = glubeanTest("simple-test", fn);

  expect(result).toBeDefined();
  expect(result.meta.id).toBe("simple-test");
  expect(result.meta.name).toBe("simple-test");
  expect(result.type).toBe("simple");
  expect(result.fn).toBe(fn);

  // Check registry
  const registry = getRegistry();
  expect(registry.length).toBe(1);
  expect(registry[0].id).toBe("simple-test");
  expect(registry[0].type).toBe("simple");
});

test("test() - quick mode with metadata object", () => {
  clearRegistry();
  const fn = (_ctx: TestContext) => Promise.resolve();
  const result = glubeanTest(
    { id: "full-test", name: "Full Test", tags: ["smoke"] },
    fn,
  );

  expect(result.meta.id).toBe("full-test");
  expect(result.meta.name).toBe("Full Test");
  expect(result.meta.tags).toEqual(["smoke"]);
  expect(result.type).toBe("simple");

  const registry = getRegistry();
  expect(registry[0].tags).toEqual(["smoke"]);
});

test("test() - quick mode function is callable", async () => {
  clearRegistry();
  let called = false;
  const ctx = createMockContext();

  const t = glubeanTest("callable", (_ctx) => {
    called = true;
    return Promise.resolve();
  });

  await t.fn!(ctx);
  expect(called).toBe(true);
});

test("test.only() - quick mode marks metadata as only", () => {
  clearRegistry();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const focused = glubeanTest.only("focused-quick", async (_ctx) => {});
  expect(focused.meta.id).toBe("focused-quick");
  expect(focused.meta.only).toBe(true);
  expect(focused.type).toBe("simple");
});

test("test.skip() - quick mode marks metadata as skip", () => {
  clearRegistry();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const skipped = glubeanTest.skip("skipped-quick", async (_ctx) => {});
  expect(skipped.meta.id).toBe("skipped-quick");
  expect(skipped.meta.skip).toBe(true);
  expect(skipped.type).toBe("simple");
});

test("test() - builder mode returns TestBuilder", () => {
  clearRegistry();
  const builder = glubeanTest("builder-test");

  expect(builder).toBeDefined();
  expect(builder instanceof TestBuilder).toBe(true);
});

test("test.only() - builder mode marks metadata as only", () => {
  clearRegistry();
  const result = glubeanTest.only("focused-builder")
    .step("s", async () => {})
    .build();
  expect(result.meta.only).toBe(true);
});

test("test.skip() - builder mode marks metadata as skip", () => {
  clearRegistry();
  const result = glubeanTest.skip("skipped-builder")
    .step("s", async () => {})
    .build();
  expect(result.meta.skip).toBe(true);
});

test("TestBuilder.only()/skip() - fluent flags update metadata", () => {
  clearRegistry();
  const result = glubeanTest("fluent-flags")
    .only()
    .skip()
    .step("s", async () => {})
    .build();
  expect(result.meta.only).toBe(true);
  expect(result.meta.skip).toBe(true);
});

test("test() - builder mode with steps", () => {
  clearRegistry();
  const result = glubeanTest("multi-step")
    .meta({ tags: ["e2e"] })
    .step("Step 1", (_ctx, _state) => Promise.resolve())
    .step("Step 2", (_ctx, _state) => Promise.resolve())
    .build();

  expect(result.meta.id).toBe("multi-step");
  expect(result.meta.tags).toEqual(["e2e"]);
  expect(result.type).toBe("steps");
  expect(result.steps?.length).toBe(2);
  expect(result.steps?.[0].meta.name).toBe("Step 1");
  expect(result.steps?.[1].meta.name).toBe("Step 2");

  // Check registry
  const registry = getRegistry();
  expect(registry.length).toBe(1);
  expect(registry[0].steps).toEqual([{ name: "Step 1" }, { name: "Step 2" }]);
});

test("test() - builder mode with setup and teardown", () => {
  clearRegistry();
  const result = glubeanTest("with-hooks")
    .setup((_ctx) => Promise.resolve({ value: 42 }))
    .step("Use state", (_ctx, state) => {
      expect(state.value).toBe(42);
      return Promise.resolve();
    })
    .teardown((_ctx, _state) => Promise.resolve())
    .build();

  expect(result.setup).toBeDefined();
  expect(result.teardown).toBeDefined();
  expect(result.steps?.length).toBe(1);

  const registry = getRegistry();
  expect(registry[0].hasSetup).toBe(true);
  expect(registry[0].hasTeardown).toBe(true);
});

test("test() - builder with step options", () => {
  clearRegistry();
  const result = glubeanTest("with-options")
    .step("Retry step", { retries: 3, timeout: 5000 }, (_ctx, _state) => Promise.resolve())
    .build();

  expect(result.steps?.[0].meta.name).toBe("Retry step");
  expect(result.steps?.[0].meta.retries).toBe(3);
  expect(result.steps?.[0].meta.timeout).toBe(5000);
});

test("test() - builder build() is idempotent", () => {
  clearRegistry();
  const builder = glubeanTest("double-build").step("s", () => Promise.resolve());
  const first = builder.build();
  const second = builder.build();

  // Both calls return a plain Test object with the same data
  expect(first.meta.id).toBe("double-build");
  expect(second.meta.id).toBe("double-build");

  // Only one entry in registry (idempotent finalization)
  const registry = getRegistry();
  const entries = registry.filter((r) => r.id === "double-build");
  expect(entries.length).toBe(1);
});

test("test() - builder has __glubean_type marker", () => {
  clearRegistry();
  const builder = glubeanTest("marker-test").step("s", () => Promise.resolve());

  expect(builder.__glubean_type).toBe("builder");
  expect(typeof builder.build).toBe("function");
});

test(
  "test() - builder auto-registers via microtask (no .build())",
  async () => {
    clearRegistry();

    // Create builder WITHOUT calling .build()
    const _builder = glubeanTest("auto-reg")
      .meta({ tags: ["auto"] })
      .step("Step A", () => Promise.resolve())
      .step("Step B", () => Promise.resolve());

    // Registry should be empty before microtask fires
    expect(getRegistry().length).toBe(0);

    // Yield to microtask queue
    await new Promise<void>((r) => queueMicrotask(r));

    // Now the registry should have the test
    const registry = getRegistry();
    expect(registry.length).toBe(1);
    expect(registry[0].id).toBe("auto-reg");
    expect(registry[0].tags).toEqual(["auto"]);
    expect(registry[0].steps).toEqual([{ name: "Step A" }, { name: "Step B" }]);
  },
);

test(
  "test() - explicit .build() prevents double registration from microtask",
  async () => {
    clearRegistry();

    // Call .build() explicitly
    const _t = glubeanTest("explicit-build")
      .step("s1", () => Promise.resolve())
      .build();

    expect(getRegistry().length).toBe(1);

    // Yield to microtask — should NOT create a second registry entry
    await new Promise<void>((r) => queueMicrotask(r));

    expect(getRegistry().length).toBe(1);
    expect(getRegistry()[0].id).toBe("explicit-build");
  },
);

test("test() - setup returns state to steps", async () => {
  clearRegistry();
  const ctx = createMockContext();

  let receivedState: { token: string } | undefined;

  const t = glubeanTest<{ token: string }>("state-flow")
    .setup((_ctx) => Promise.resolve({ token: "abc123" }))
    .step("Use token", (_ctx, state) => {
      receivedState = state;
      return Promise.resolve(state);
    })
    .build();

  // Simulate runner behavior
  const state = await t.setup!(ctx);
  expect(state.token).toBe("abc123");

  await t.steps![0].fn(ctx, state);
  expect(receivedState?.token).toBe("abc123");
});

// ==================== test.each Tests ====================

test("test.each - generates one test per row", () => {
  clearRegistry();
  const tests = glubeanTest.each([
    { id: 1, expected: 200 },
    { id: 999, expected: 404 },
    { id: -1, expected: 400 },
  ])("get-user-$id", async (_ctx, _data) => {});

  expect(tests.length).toBe(3);
  expect(tests[0].meta.id).toBe("get-user-1");
  expect(tests[1].meta.id).toBe("get-user-999");
  expect(tests[2].meta.id).toBe("get-user--1");

  // All should be simple type
  for (const t of tests) {
    expect(t.type).toBe("simple");
    expect(t.fn).toBeDefined();
  }
});

test("test.each - registers all tests to registry", () => {
  clearRegistry();
  glubeanTest.each([{ role: "admin" }, { role: "viewer" }])(
    "auth-$role",
    async (_ctx, _data) => {},
  );

  const registry = getRegistry();
  expect(registry.length).toBe(2);
  expect(registry[0].id).toBe("auth-admin");
  expect(registry[1].id).toBe("auth-viewer");
  expect(registry[0].type).toBe("simple");
});

test("test.each - parallel option sets groupId and parallel in registry", () => {
  clearRegistry();
  glubeanTest.each([{ id: 1 }, { id: 2 }], { parallel: true })(
    "case-$id",
    async (_ctx, _data) => {},
  );

  const registry = getRegistry();
  expect(registry.length).toBe(2);
  expect(registry[0].groupId).toBe("case-$id");
  expect(registry[0].parallel).toBe(true);
  expect(registry[1].groupId).toBe("case-$id");
  expect(registry[1].parallel).toBe(true);
});

test("test.each - without parallel option has no parallel field", () => {
  clearRegistry();
  glubeanTest.each([{ id: 1 }])("case-$id", async (_ctx, _data) => {});

  const registry = getRegistry();
  expect(registry[0].parallel).toBeUndefined();
});

test("test.each - supports $index interpolation", () => {
  clearRegistry();
  const tests = glubeanTest.each([{ name: "a" }, { name: "b" }, { name: "c" }])(
    "item-$index-$name",
    async (_ctx, _data) => {},
  );

  expect(tests[0].meta.id).toBe("item-0-a");
  expect(tests[1].meta.id).toBe("item-1-b");
  expect(tests[2].meta.id).toBe("item-2-c");
});

test("test.each - supports metadata object with tags", () => {
  clearRegistry();
  const tests = glubeanTest.each([{ status: 200 }, { status: 404 }])(
    { id: "status-$status", tags: ["smoke", "api"] },
    async (_ctx, _data) => {},
  );

  expect(tests.length).toBe(2);
  expect(tests[0].meta.id).toBe("status-200");
  expect(tests[1].meta.id).toBe("status-404");
  // Tags should be inherited by each test
  expect(tests[0].meta.tags).toEqual(["smoke", "api"]);
  expect(tests[1].meta.tags).toEqual(["smoke", "api"]);

  const registry = getRegistry();
  expect(registry[0].tags).toEqual(["smoke", "api"]);
  expect(registry[1].tags).toEqual(["smoke", "api"]);
});

test("test.each - name interpolation works", () => {
  clearRegistry();
  const tests = glubeanTest.each([{ method: "GET", path: "/users" }])(
    { id: "$method-$path", name: "$method $path test" },
    async (_ctx, _data) => {},
  );

  expect(tests[0].meta.id).toBe("GET-/users");
  expect(tests[0].meta.name).toBe("GET /users test");
});

test("test.each - each test receives correct data row", async () => {
  clearRegistry();
  const received: Array<{ id: number; expected: number }> = [];
  const ctx = createMockContext();

  const tests = glubeanTest.each([
    { id: 1, expected: 200 },
    { id: 2, expected: 404 },
  ])("test-$id", async (_ctx, data) => {
    received.push(data);
  });

  // Execute each test
  await tests[0].fn!(ctx);
  await tests[1].fn!(ctx);

  expect(received.length).toBe(2);
  expect(received[0]).toEqual({ id: 1, expected: 200 });
  expect(received[1]).toEqual({ id: 2, expected: 404 });
});

test("test.each - empty table produces no tests", () => {
  clearRegistry();
  const tests = glubeanTest.each([])("empty-$index", async (_ctx, _data) => {});
  expect(tests.length).toBe(0);
  expect(getRegistry().length).toBe(0);
});

test("test.each - returns Test[] array (not single Test)", () => {
  clearRegistry();
  const result = glubeanTest.each([{ x: 1 }])("t-$x", async () => {});
  expect(Array.isArray(result)).toBe(true);
  expect(result.length).toBe(1);
  expect(result[0].meta.id).toBe("t-1");
});

// ==================== test.each Builder Mode Tests ====================

test(
  "test.each builder - returns EachBuilder when no fn is passed",
  () => {
    clearRegistry();
    const builder = glubeanTest.each([{ id: 1 }, { id: 2 }])("item-$id");

    expect(builder).toBeDefined();
    expect(builder instanceof EachBuilder).toBe(true);
    expect(builder.__glubean_type).toBe("each-builder");
  },
);

test("test.each builder - build() produces Test[] with steps", () => {
  clearRegistry();
  const tests = glubeanTest
    .each([{ userId: 1 }, { userId: 2 }])("user-flow-$userId")
    .step("fetch user", async (_ctx, _state, _row) => {})
    .step("verify posts", async (_ctx, _state, _row) => {})
    .build();

  expect(tests.length).toBe(2);
  expect(tests[0].meta.id).toBe("user-flow-1");
  expect(tests[1].meta.id).toBe("user-flow-2");
  expect(tests[0].type).toBe("steps");
  expect(tests[1].type).toBe("steps");
  expect(tests[0].steps?.length).toBe(2);
  expect(tests[0].steps?.[0].meta.name).toBe("fetch user");
  expect(tests[0].steps?.[1].meta.name).toBe("verify posts");
});

test(
  "test.each builder - registers all tests with steps to registry",
  () => {
    clearRegistry();
    glubeanTest
      .each([{ role: "admin" }, { role: "viewer" }])("auth-flow-$role")
      .meta({ tags: ["auth"] })
      .step("login", async () => {})
      .step("check perms", async () => {})
      .build();

    const registry = getRegistry();
    expect(registry.length).toBe(2);
    expect(registry[0].id).toBe("auth-flow-admin");
    expect(registry[1].id).toBe("auth-flow-viewer");
    expect(registry[0].type).toBe("steps");
    expect(registry[0].steps).toEqual([
      { name: "login" },
      {
        name: "check perms",
      },
    ]);
    expect(registry[0].tags).toEqual(["auth"]);
    expect(registry[1].steps).toEqual([
      { name: "login" },
      {
        name: "check perms",
      },
    ]);
  },
);

test("test.each builder - setup receives data row", async () => {
  clearRegistry();
  const ctx = createMockContext();

  const tests = glubeanTest
    .each([{ userId: 42 }])("setup-$userId")
    .setup(async (_ctx, row) => {
      return { capturedUserId: row.userId };
    })
    .step("verify state", async (_ctx, state) => {
      expect(state.capturedUserId).toBe(42);
    })
    .build();

  expect(tests.length).toBe(1);
  const state = await tests[0].setup!(ctx);
  expect(state.capturedUserId).toBe(42);
});

test("test.each builder - step receives data row", async () => {
  clearRegistry();
  const ctx = createMockContext();
  const received: number[] = [];

  const tests = glubeanTest
    .each([{ n: 10 }, { n: 20 }])("step-row-$n")
    .step("capture", async (_ctx, _state, row) => {
      received.push(row.n);
    })
    .build();

  // Execute both tests' first step with undefined state
  await tests[0].steps![0].fn(ctx, undefined);
  await tests[1].steps![0].fn(ctx, undefined);

  expect(received).toEqual([10, 20]);
});

test("test.each builder - teardown receives data row", async () => {
  clearRegistry();
  const ctx = createMockContext();
  const teardownRows: number[] = [];

  const tests = glubeanTest
    .each([{ id: 1 }, { id: 2 }])("td-$id")
    .step("noop", async () => {})
    .teardown(async (_ctx, _state, row) => {
      teardownRows.push(row.id);
    })
    .build();

  await tests[0].teardown!(ctx, undefined);
  await tests[1].teardown!(ctx, undefined);

  expect(teardownRows).toEqual([1, 2]);
});

test("test.each builder - supports $index interpolation", () => {
  clearRegistry();
  const tests = glubeanTest
    .each([{ x: "a" }, { x: "b" }])("item-$index-$x")
    .step("s", async () => {})
    .build();

  expect(tests[0].meta.id).toBe("item-0-a");
  expect(tests[1].meta.id).toBe("item-1-b");
});

test("test.each builder - supports metadata object", () => {
  clearRegistry();
  const tests = glubeanTest
    .each([{ code: 200 }, { code: 404 }])({
      id: "status-$code",
      tags: ["smoke"],
    })
    .step("check", async () => {})
    .build();

  expect(tests[0].meta.id).toBe("status-200");
  expect(tests[0].meta.tags).toEqual(["smoke"]);
  expect(tests[1].meta.id).toBe("status-404");
  expect(tests[1].meta.tags).toEqual(["smoke"]);
});

test("EachBuilder.only()/skip() - applies flags to every generated test", () => {
  clearRegistry();
  const tests = glubeanTest
    .each([{ id: 1 }, { id: 2 }])("flags-$id")
    .only()
    .skip()
    .step("run", async () => {})
    .build();

  expect(tests.length).toBe(2);
  expect(tests[0].meta.only).toBe(true);
  expect(tests[0].meta.skip).toBe(true);
  expect(tests[1].meta.only).toBe(true);
  expect(tests[1].meta.skip).toBe(true);
});

test("test.each builder - .meta() merges additional metadata", () => {
  clearRegistry();
  const tests = glubeanTest
    .each([{ v: 1 }])("meta-$v")
    .meta({ tags: ["e2e"], description: "End-to-end" })
    .step("s", async () => {})
    .build();

  expect(tests[0].meta.tags).toEqual(["e2e"]);
  expect(tests[0].meta.description).toBe("End-to-end");
});

test("test.each builder - step options (retries, timeout)", () => {
  clearRegistry();
  const tests = glubeanTest
    .each([{ x: 1 }])("opts-$x")
    .step("retry step", { retries: 3, timeout: 5000 }, async () => {})
    .build();

  expect(tests[0].steps![0].meta.name).toBe("retry step");
  expect(tests[0].steps![0].meta.retries).toBe(3);
  expect(tests[0].steps![0].meta.timeout).toBe(5000);
});

test("test.each builder - empty table produces empty array", () => {
  clearRegistry();
  const tests = glubeanTest
    .each([])("empty-$index")
    .step("s", async () => {})
    .build();

  expect(tests.length).toBe(0);
  expect(getRegistry().length).toBe(0);
});

test("test.each builder - build() is idempotent", () => {
  clearRegistry();
  const builder = glubeanTest
    .each([{ x: 1 }])("idem-$x")
    .step("s", async () => {});
  const first = builder.build();
  const second = builder.build();

  expect(first.length).toBe(1);
  expect(second.length).toBe(1);
  expect(first[0].meta.id).toBe("idem-1");

  // Only one entry in registry
  const entries = getRegistry().filter((r) => r.id === "idem-1");
  expect(entries.length).toBe(1);
});

test(
  "test.each builder - auto-registers via microtask (no .build())",
  async () => {
    clearRegistry();

    // Create EachBuilder WITHOUT calling .build()
    const _builder = glubeanTest
      .each([{ env: "staging" }, { env: "prod" }])("deploy-$env")
      .meta({ tags: ["deploy"] })
      .step("prepare", async () => {})
      .step("verify", async () => {});

    // Registry should be empty before microtask fires
    expect(getRegistry().length).toBe(0);

    // Yield to microtask queue
    await new Promise<void>((r) => queueMicrotask(r));

    // Now the registry should have both tests
    const registry = getRegistry();
    expect(registry.length).toBe(2);
    expect(registry[0].id).toBe("deploy-staging");
    expect(registry[1].id).toBe("deploy-prod");
    expect(registry[0].steps).toEqual([{ name: "prepare" }, { name: "verify" }]);
    expect(registry[0].tags).toEqual(["deploy"]);
  },
);

test(
  "test.each builder - explicit .build() prevents double registration",
  async () => {
    clearRegistry();

    const _tests = glubeanTest
      .each([{ x: 1 }])("no-dup-$x")
      .step("s", async () => {})
      .build();

    expect(getRegistry().length).toBe(1);

    // Yield to microtask — should NOT create a second registry entry
    await new Promise<void>((r) => queueMicrotask(r));

    expect(getRegistry().length).toBe(1);
    expect(getRegistry()[0].id).toBe("no-dup-1");
  },
);

test("test.each builder - state flows through steps", async () => {
  clearRegistry();
  const ctx = createMockContext();

  const tests = glubeanTest
    .each([{ factor: 10 }])("flow-$factor")
    .setup(async (_ctx, row) => {
      return { value: row.factor };
    })
    .step("double", async (_ctx, state) => {
      return { value: state.value * 2 };
    })
    .step("check", async (_ctx, state) => {
      expect(state.value).toBe(20);
    })
    .build();

  // Simulate runner: setup -> steps
  let state = await tests[0].setup!(ctx);
  expect(state.value).toBe(10);

  state = (await tests[0].steps![0].fn(ctx, state)) as { value: number };
  expect(state.value).toBe(20);

  await tests[0].steps![1].fn(ctx, state);
});

test("test.each builder - hasSetup/hasTeardown in registry", () => {
  clearRegistry();
  glubeanTest
    .each([{ x: 1 }])("hooks-$x")
    .setup(async () => ({ v: 1 }))
    .step("s", async () => {})
    .teardown(async () => {})
    .build();

  const reg = getRegistry();
  expect(reg[0].hasSetup).toBe(true);
  expect(reg[0].hasTeardown).toBe(true);
});

// ==================== Type Guard Tests ====================

test("Test type has correct structure (simple)", () => {
  clearRegistry();
  const t = glubeanTest("type-test", () => Promise.resolve());

  // Type narrowing
  if (t.type === "simple") {
    expect(t.fn).toBeDefined();
    expect(t.steps).toBeUndefined();
  }
});

test("Test type has correct structure (steps)", () => {
  clearRegistry();
  const t = glubeanTest("type-test")
    .step("s1", () => Promise.resolve())
    .build();

  if (t.type === "steps") {
    expect(t.steps).toBeDefined();
    expect(t.fn).toBeUndefined();
  }
});

// ==================== test.pick Tests ====================

const pickExamples = {
  normal: { name: "Alice", age: 25 },
  "edge-case": { name: "", age: -1 },
  admin: { name: "Admin", role: "admin" },
};

test(
  "test.pick - selects one example by default and injects _pick",
  () => {
    clearRegistry();
    // Ensure no GLUBEAN_PICK env is set
    delete process.env["GLUBEAN_PICK"];

    const tests = glubeanTest.pick(pickExamples)("pick-$_pick", async (_ctx, row) => {
      expect(row._pick).toBeDefined();
      expect(row.name).toBeDefined();
    });

    // Default count=1 → should produce exactly 1 test
    expect(tests.length).toBe(1);
    // The test ID should include the picked key
    const id = tests[0].meta.id;
    const validKeys = Object.keys(pickExamples);
    const pickedKey = id.replace("pick-", "");
    expect(validKeys.includes(pickedKey)).toBe(true);
  },
);

test(
  "test.pick - respects GLUBEAN_PICK env var for specific selection",
  () => {
    clearRegistry();
    process.env["GLUBEAN_PICK"] = "admin";

    try {
      const tests = glubeanTest.pick(pickExamples)(
        "pick-$_pick",
        async (_ctx, row) => {
          expect(row._pick).toBe("admin");
          expect(row.name).toBe("Admin");
        },
      );

      expect(tests.length).toBe(1);
      expect(tests[0].meta.id).toBe("pick-admin");
    } finally {
      delete process.env["GLUBEAN_PICK"];
    }
  },
);

test("test.pick - supports multiple keys via GLUBEAN_PICK", () => {
  clearRegistry();
  process.env["GLUBEAN_PICK"] = "normal,admin";

  try {
    const tests = glubeanTest.pick(pickExamples)("pick-$_pick", async () => {});

    expect(tests.length).toBe(2);
    expect(tests[0].meta.id).toBe("pick-normal");
    expect(tests[1].meta.id).toBe("pick-admin");
  } finally {
    delete process.env["GLUBEAN_PICK"];
  }
});

test(
  "test.pick - falls back to random when GLUBEAN_PICK key not found",
  () => {
    clearRegistry();
    process.env["GLUBEAN_PICK"] = "nonexistent";

    try {
      // Invalid key should NOT throw — falls back to random selection.
      // This handles the case where GLUBEAN_PICK leaks across multiple
      // test.pick calls in the same file (each with different key sets).
      const tests = glubeanTest.pick(pickExamples)("pick-$_pick", async () => {});
      expect(tests.length).toBe(1);
      // Extract picked key from the test ID (e.g. "pick-admin" → "admin")
      const id = tests[0].meta.id;
      const pickedKey = id.replace("pick-", "");
      const validKeys = Object.keys(pickExamples);
      expect(validKeys.includes(pickedKey)).toBe(true);
    } finally {
      delete process.env["GLUBEAN_PICK"];
    }
  },
);

test("test.pick - throws on empty examples", () => {
  clearRegistry();
  delete process.env["GLUBEAN_PICK"];

  expect(
    () =>
      glubeanTest.pick({} as Record<string, Record<string, unknown>>)(
        "empty-$_pick",
        async () => {},
      ),
  ).toThrow("test.pick requires at least one example");
});

test("test.pick - count > 1 selects multiple random examples", () => {
  clearRegistry();
  delete process.env["GLUBEAN_PICK"];

  const tests = glubeanTest.pick(pickExamples, 2)("pick-$_pick", async () => {});

  expect(tests.length).toBe(2);
  // Both should have valid _pick keys and distinct IDs
  const ids = tests.map((t) => t.meta.id);
  expect(new Set(ids).size).toBe(2);
});

test("test.pick - count larger than examples returns all", () => {
  clearRegistry();
  delete process.env["GLUBEAN_PICK"];

  const tests = glubeanTest.pick(pickExamples, 10)("pick-$_pick", async () => {});

  // Should return all 3, not 10
  expect(tests.length).toBe(3);
});

test("test.pick - GLUBEAN_PICK=all selects every example", () => {
  clearRegistry();
  process.env["GLUBEAN_PICK"] = "all";

  try {
    const tests = glubeanTest.pick(pickExamples)("pick-$_pick", async () => {});

    expect(tests.length).toBe(3);
    const ids = tests.map((t) => t.meta.id).sort();
    expect(ids).toEqual(["pick-admin", "pick-edge-case", "pick-normal"]);
  } finally {
    delete process.env["GLUBEAN_PICK"];
  }
});

test("test.pick - GLUBEAN_PICK=* selects every example", () => {
  clearRegistry();
  process.env["GLUBEAN_PICK"] = "*";

  try {
    const tests = glubeanTest.pick(pickExamples)("pick-$_pick", async () => {});

    expect(tests.length).toBe(3);
  } finally {
    delete process.env["GLUBEAN_PICK"];
  }
});

test("test.pick - glob pattern matches subset of keys", () => {
  clearRegistry();
  const regionExamples = {
    "us-east-1": { endpoint: "https://us-east-1.example.com" },
    "us-east-2": { endpoint: "https://us-east-2.example.com" },
    "eu-west-1": { endpoint: "https://eu-west-1.example.com" },
    "eu-west-2": { endpoint: "https://eu-west-2.example.com" },
    "ap-south-1": { endpoint: "https://ap-south-1.example.com" },
  };

  process.env["GLUBEAN_PICK"] = "us-*";
  try {
    const tests = glubeanTest.pick(regionExamples)("region-$_pick", async () => {});

    expect(tests.length).toBe(2);
    const ids = tests.map((t) => t.meta.id).sort();
    expect(ids).toEqual(["region-us-east-1", "region-us-east-2"]);
  } finally {
    delete process.env["GLUBEAN_PICK"];
  }
});

test("test.pick - glob pattern with multiple segments", () => {
  clearRegistry();
  const regionExamples = {
    "us-east-1": { endpoint: "https://us-east-1.example.com" },
    "us-west-1": { endpoint: "https://us-west-1.example.com" },
    "eu-west-1": { endpoint: "https://eu-west-1.example.com" },
  };

  process.env["GLUBEAN_PICK"] = "us-*,eu-*";
  try {
    const tests = glubeanTest.pick(regionExamples)("region-$_pick", async () => {});

    expect(tests.length).toBe(3);
  } finally {
    delete process.env["GLUBEAN_PICK"];
  }
});

test("test.pick - glob no match falls back to random", () => {
  clearRegistry();
  process.env["GLUBEAN_PICK"] = "zzz-*";

  try {
    const tests = glubeanTest.pick(pickExamples)("pick-$_pick", async () => {});

    // No match → falls back to random 1
    expect(tests.length).toBe(1);
    const pickedKey = tests[0].meta.id.replace("pick-", "");
    const validKeys = Object.keys(pickExamples);
    expect(validKeys.includes(pickedKey)).toBe(true);
  } finally {
    delete process.env["GLUBEAN_PICK"];
  }
});

test("test.pick - mixed exact and glob in GLUBEAN_PICK", () => {
  clearRegistry();
  const regionExamples = {
    "us-east-1": { endpoint: "https://us-east-1.example.com" },
    "us-east-2": { endpoint: "https://us-east-2.example.com" },
    "eu-west-1": { endpoint: "https://eu-west-1.example.com" },
  };

  // Mix exact key with glob
  process.env["GLUBEAN_PICK"] = "eu-west-1,us-*";
  try {
    const tests = glubeanTest.pick(regionExamples)("region-$_pick", async () => {});

    expect(tests.length).toBe(3);
  } finally {
    delete process.env["GLUBEAN_PICK"];
  }
});

// ==================== TestBuilder .use() / .group() Tests ====================

test("TestBuilder.use() - applies transform function", () => {
  clearRegistry();
  const withLogin = (b: TestBuilder<unknown>) => b.step("login", async (_ctx) => ({ token: "abc" }));

  const result = glubeanTest("use-test").use(withLogin).build();

  expect(result.steps?.length).toBe(1);
  expect(result.steps?.[0].meta.name).toBe("login");
});

test("TestBuilder.use() - chains multiple transforms", () => {
  clearRegistry();
  const withAuth = (b: TestBuilder<unknown>) => b.step("login", async (_ctx) => ({ token: "abc" }));
  const withCart = (b: TestBuilder<{ token: string }>) =>
    b.step("create cart", async (_ctx, { token }) => ({
      token,
      cartId: "c1",
    }));

  const result = glubeanTest("chain-use")
    .use(withAuth)
    .use(withCart)
    .step("checkout", async (_ctx, _state) => {})
    .build();

  expect(result.steps?.length).toBe(3);
  expect(result.steps?.[0].meta.name).toBe("login");
  expect(result.steps?.[1].meta.name).toBe("create cart");
  expect(result.steps?.[2].meta.name).toBe("checkout");
});

test("TestBuilder.use() - state flows through transform", async () => {
  clearRegistry();
  const ctx = createMockContext();

  const withSetup = (b: TestBuilder<unknown>) => b.step("init", async (_ctx) => ({ value: 42 }));

  const t = glubeanTest("use-state")
    .use(withSetup)
    .step("check", async (_ctx, state) => {
      expect(state.value).toBe(42);
    })
    .build();

  // Manual step invocation outside normal runner flow — cast state type
  const state = await t.steps![0].fn(ctx, undefined as never);
  await t.steps![1].fn(ctx, state as { value: number });
});

test("TestBuilder.group() - marks steps with group id", () => {
  clearRegistry();
  const result = glubeanTest("group-test")
    .group("setup", (b) =>
      b
        .step("seed db", async (_ctx) => ({ dbId: "d1" }))
        .step("create user", async (_ctx, { dbId }) => ({
          dbId,
          userId: "u1",
        })))
    .step("verify", async (_ctx, _state) => {})
    .build();

  expect(result.steps?.length).toBe(3);
  expect(result.steps?.[0].meta.group).toBe("setup");
  expect(result.steps?.[1].meta.group).toBe("setup");
  expect(result.steps?.[2].meta.group).toBeUndefined();
});

test("TestBuilder.group() - reusable transform with group", () => {
  clearRegistry();
  const withAuth = (b: TestBuilder<unknown>) =>
    b
      .step("login", async (_ctx) => ({ token: "abc" }))
      .step("verify", async (_ctx, state) => ({ ...state, verified: true }));

  const result = glubeanTest("group-reuse")
    .group("auth", withAuth)
    .step("act", async (_ctx, _state) => {})
    .build();

  expect(result.steps?.length).toBe(3);
  expect(result.steps?.[0].meta.name).toBe("login");
  expect(result.steps?.[0].meta.group).toBe("auth");
  expect(result.steps?.[1].meta.name).toBe("verify");
  expect(result.steps?.[1].meta.group).toBe("auth");
  expect(result.steps?.[2].meta.name).toBe("act");
  expect(result.steps?.[2].meta.group).toBeUndefined();
});

test("TestBuilder.group() - multiple groups", () => {
  clearRegistry();
  const result = glubeanTest("multi-group")
    .group("phase-1", (b) => b.step("a", async (_ctx) => ({ v: 1 })))
    .group("phase-2", (b) => b.step("b", async (_ctx, state) => ({ ...state, w: 2 })))
    .step("final", async (_ctx, _state) => {})
    .build();

  expect(result.steps?.length).toBe(3);
  expect(result.steps?.[0].meta.group).toBe("phase-1");
  expect(result.steps?.[1].meta.group).toBe("phase-2");
  expect(result.steps?.[2].meta.group).toBeUndefined();
});

test("TestBuilder.group() - steps appear in registry", async () => {
  clearRegistry();
  const _builder = glubeanTest("group-reg")
    .group("auth", (b) => b.step("login", async (_ctx) => {}))
    .step("act", async (_ctx) => {});

  // Yield to microtask for auto-registration
  await new Promise<void>((r) => queueMicrotask(r));

  const registry = getRegistry();
  expect(registry.length).toBe(1);
  expect(registry[0].steps).toEqual([
    { name: "login", group: "auth" },
    { name: "act" },
  ]);
});

// ==================== EachBuilder .use() / .group() Tests ====================

test("EachBuilder.use() - applies transform", () => {
  clearRegistry();
  const withStep = (b: EachBuilder<unknown, { n: number }>) => b.step("check", async (_ctx, _state, _row) => {});

  const tests = glubeanTest
    .each([{ n: 1 }])("each-use-$n")
    .use(withStep)
    .build();

  expect(tests[0].steps?.length).toBe(1);
  expect(tests[0].steps?.[0].meta.name).toBe("check");
});

test("EachBuilder.group() - marks steps with group id", () => {
  clearRegistry();
  const tests = glubeanTest
    .each([{ n: 1 }])("each-group-$n")
    .group("init", (b) => b.step("seed", async (_ctx) => ({ seeded: true })))
    .step("verify", async (_ctx, _state) => {})
    .build();

  expect(tests[0].steps?.length).toBe(2);
  expect(tests[0].steps?.[0].meta.group).toBe("init");
  expect(tests[0].steps?.[1].meta.group).toBeUndefined();
});

// ==================== test.pick Tests ====================

test("test.pick - works with builder mode (no callback)", () => {
  clearRegistry();
  process.env["GLUBEAN_PICK"] = "normal";

  try {
    const builder = glubeanTest.pick(pickExamples)("pick-$_pick");

    // Should return an EachBuilder
    expect(builder).toBeDefined();
    expect(builder instanceof EachBuilder).toBe(true);

    const tests = builder
      .step("check", async (_ctx, _state, row) => {
        expect(row._pick).toBeDefined();
      })
      .build();

    expect(tests.length).toBe(1);
    expect(tests[0].meta.id).toBe("pick-normal");
  } finally {
    delete process.env["GLUBEAN_PICK"];
  }
});

test("test.pick - registers tests in global registry", () => {
  clearRegistry();
  process.env["GLUBEAN_PICK"] = "edge-case";

  try {
    glubeanTest.pick(pickExamples)("pick-$_pick", async () => {});

    const reg = getRegistry();
    expect(reg.length).toBe(1);
    expect(reg[0].id).toBe("pick-edge-case");
  } finally {
    delete process.env["GLUBEAN_PICK"];
  }
});

test("test.pick - sets groupId to template ID in registry", () => {
  clearRegistry();
  process.env["GLUBEAN_PICK"] = "normal,admin";

  try {
    glubeanTest.pick(pickExamples)("pick-$_pick", async () => {});

    const reg = getRegistry();
    expect(reg.length).toBe(2);
    expect(reg[0].groupId).toBe("pick-$_pick");
    expect(reg[1].groupId).toBe("pick-$_pick");
  } finally {
    delete process.env["GLUBEAN_PICK"];
  }
});

test("test.each - does not set groupId in registry", () => {
  clearRegistry();

  glubeanTest.each([
    { id: 1, name: "a" },
    { id: 2, name: "b" },
  ])("each-$id", async () => {});

  const reg = getRegistry();
  expect(reg.length).toBe(2);
  expect(reg[0].groupId).toBeUndefined();
  expect(reg[1].groupId).toBeUndefined();
});
