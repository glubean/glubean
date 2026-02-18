// deno-lint-ignore-file require-await
import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { EachBuilder, SPEC_VERSION, test, TestBuilder } from "./mod.ts";
import { clearRegistry, getRegistry } from "./internal.ts";
import { Expectation } from "./expect.ts";
import type { SecretsAccessor, TestContext, ValidatorFn, VarsAccessor } from "./types.ts";

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
    metric: () => {},
    http: mockHttp as unknown as import("./types.ts").HttpClient,
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

Deno.test("SPEC_VERSION is 2.0", () => {
  assertEquals(SPEC_VERSION, "2.0");
});

// ==================== Registry Tests ====================

Deno.test("getRegistry returns empty array initially", () => {
  clearRegistry();
  const registry = getRegistry();
  assertEquals(registry, []);
});

Deno.test("clearRegistry clears all registered tests", () => {
  clearRegistry();
  test("temp-test", () => Promise.resolve());
  assertEquals(getRegistry().length, 1);
  clearRegistry();
  assertEquals(getRegistry().length, 0);
});

// ==================== New test() API Tests ====================

Deno.test("test() - quick mode with string id", () => {
  clearRegistry();
  const fn = (_ctx: TestContext) => Promise.resolve();
  const result = test("simple-test", fn);

  assertExists(result);
  assertEquals(result.meta.id, "simple-test");
  assertEquals(result.meta.name, "simple-test");
  assertEquals(result.type, "simple");
  assertEquals(result.fn, fn);

  // Check registry
  const registry = getRegistry();
  assertEquals(registry.length, 1);
  assertEquals(registry[0].id, "simple-test");
  assertEquals(registry[0].type, "simple");
});

Deno.test("test() - quick mode with metadata object", () => {
  clearRegistry();
  const fn = (_ctx: TestContext) => Promise.resolve();
  const result = test(
    { id: "full-test", name: "Full Test", tags: ["smoke"] },
    fn,
  );

  assertEquals(result.meta.id, "full-test");
  assertEquals(result.meta.name, "Full Test");
  assertEquals(result.meta.tags, ["smoke"]);
  assertEquals(result.type, "simple");

  const registry = getRegistry();
  assertEquals(registry[0].tags, ["smoke"]);
});

Deno.test("test() - quick mode function is callable", async () => {
  clearRegistry();
  let called = false;
  const ctx = createMockContext();

  const t = test("callable", (_ctx) => {
    called = true;
    return Promise.resolve();
  });

  await t.fn!(ctx);
  assertEquals(called, true);
});

Deno.test("test() - builder mode returns TestBuilder", () => {
  clearRegistry();
  const builder = test("builder-test");

  assertExists(builder);
  assertEquals(builder instanceof TestBuilder, true);
});

Deno.test("test() - builder mode with steps", () => {
  clearRegistry();
  const result = test("multi-step")
    .meta({ tags: ["e2e"] })
    .step("Step 1", (_ctx, _state) => Promise.resolve())
    .step("Step 2", (_ctx, _state) => Promise.resolve())
    .build();

  assertEquals(result.meta.id, "multi-step");
  assertEquals(result.meta.tags, ["e2e"]);
  assertEquals(result.type, "steps");
  assertEquals(result.steps?.length, 2);
  assertEquals(result.steps?.[0].meta.name, "Step 1");
  assertEquals(result.steps?.[1].meta.name, "Step 2");

  // Check registry
  const registry = getRegistry();
  assertEquals(registry.length, 1);
  assertEquals(registry[0].steps, [{ name: "Step 1" }, { name: "Step 2" }]);
});

Deno.test("test() - builder mode with setup and teardown", () => {
  clearRegistry();
  const result = test("with-hooks")
    .setup((_ctx) => Promise.resolve({ value: 42 }))
    .step("Use state", (_ctx, state) => {
      assertEquals(state.value, 42);
      return Promise.resolve();
    })
    .teardown((_ctx, _state) => Promise.resolve())
    .build();

  assertExists(result.setup);
  assertExists(result.teardown);
  assertEquals(result.steps?.length, 1);

  const registry = getRegistry();
  assertEquals(registry[0].hasSetup, true);
  assertEquals(registry[0].hasTeardown, true);
});

Deno.test("test() - builder with step options", () => {
  clearRegistry();
  const result = test("with-options")
    .step("Retry step", { retries: 3, timeout: 5000 }, (_ctx, _state) => Promise.resolve())
    .build();

  assertEquals(result.steps?.[0].meta.name, "Retry step");
  assertEquals(result.steps?.[0].meta.retries, 3);
  assertEquals(result.steps?.[0].meta.timeout, 5000);
});

Deno.test("test() - builder build() is idempotent", () => {
  clearRegistry();
  const builder = test("double-build").step("s", () => Promise.resolve());
  const first = builder.build();
  const second = builder.build();

  // Both calls return a plain Test object with the same data
  assertEquals(first.meta.id, "double-build");
  assertEquals(second.meta.id, "double-build");

  // Only one entry in registry (idempotent finalization)
  const registry = getRegistry();
  const entries = registry.filter((r) => r.id === "double-build");
  assertEquals(entries.length, 1);
});

Deno.test("test() - builder has __glubean_type marker", () => {
  clearRegistry();
  const builder = test("marker-test").step("s", () => Promise.resolve());

  assertEquals(builder.__glubean_type, "builder");
  assertEquals(typeof builder.build, "function");
});

Deno.test(
  "test() - builder auto-registers via microtask (no .build())",
  async () => {
    clearRegistry();

    // Create builder WITHOUT calling .build()
    const _builder = test("auto-reg")
      .meta({ tags: ["auto"] })
      .step("Step A", () => Promise.resolve())
      .step("Step B", () => Promise.resolve());

    // Registry should be empty before microtask fires
    assertEquals(getRegistry().length, 0);

    // Yield to microtask queue
    await new Promise<void>((r) => queueMicrotask(r));

    // Now the registry should have the test
    const registry = getRegistry();
    assertEquals(registry.length, 1);
    assertEquals(registry[0].id, "auto-reg");
    assertEquals(registry[0].tags, ["auto"]);
    assertEquals(registry[0].steps, [{ name: "Step A" }, { name: "Step B" }]);
  },
);

Deno.test(
  "test() - explicit .build() prevents double registration from microtask",
  async () => {
    clearRegistry();

    // Call .build() explicitly
    const _t = test("explicit-build")
      .step("s1", () => Promise.resolve())
      .build();

    assertEquals(getRegistry().length, 1);

    // Yield to microtask — should NOT create a second registry entry
    await new Promise<void>((r) => queueMicrotask(r));

    assertEquals(getRegistry().length, 1);
    assertEquals(getRegistry()[0].id, "explicit-build");
  },
);

Deno.test("test() - setup returns state to steps", async () => {
  clearRegistry();
  const ctx = createMockContext();

  let receivedState: { token: string } | undefined;

  const t = test<{ token: string }>("state-flow")
    .setup((_ctx) => Promise.resolve({ token: "abc123" }))
    .step("Use token", (_ctx, state) => {
      receivedState = state;
      return Promise.resolve(state);
    })
    .build();

  // Simulate runner behavior
  const state = await t.setup!(ctx);
  assertEquals(state.token, "abc123");

  await t.steps![0].fn(ctx, state);
  assertEquals(receivedState?.token, "abc123");
});

// ==================== test.each Tests ====================

Deno.test("test.each - generates one test per row", () => {
  clearRegistry();
  const tests = test.each([
    { id: 1, expected: 200 },
    { id: 999, expected: 404 },
    { id: -1, expected: 400 },
  ])("get-user-$id", async (_ctx, _data) => {});

  assertEquals(tests.length, 3);
  assertEquals(tests[0].meta.id, "get-user-1");
  assertEquals(tests[1].meta.id, "get-user-999");
  assertEquals(tests[2].meta.id, "get-user--1");

  // All should be simple type
  for (const t of tests) {
    assertEquals(t.type, "simple");
    assertExists(t.fn);
  }
});

Deno.test("test.each - registers all tests to registry", () => {
  clearRegistry();
  test.each([{ role: "admin" }, { role: "viewer" }])(
    "auth-$role",
    async (_ctx, _data) => {},
  );

  const registry = getRegistry();
  assertEquals(registry.length, 2);
  assertEquals(registry[0].id, "auth-admin");
  assertEquals(registry[1].id, "auth-viewer");
  assertEquals(registry[0].type, "simple");
});

Deno.test("test.each - supports $index interpolation", () => {
  clearRegistry();
  const tests = test.each([{ name: "a" }, { name: "b" }, { name: "c" }])(
    "item-$index-$name",
    async (_ctx, _data) => {},
  );

  assertEquals(tests[0].meta.id, "item-0-a");
  assertEquals(tests[1].meta.id, "item-1-b");
  assertEquals(tests[2].meta.id, "item-2-c");
});

Deno.test("test.each - supports metadata object with tags", () => {
  clearRegistry();
  const tests = test.each([{ status: 200 }, { status: 404 }])(
    { id: "status-$status", tags: ["smoke", "api"] },
    async (_ctx, _data) => {},
  );

  assertEquals(tests.length, 2);
  assertEquals(tests[0].meta.id, "status-200");
  assertEquals(tests[1].meta.id, "status-404");
  // Tags should be inherited by each test
  assertEquals(tests[0].meta.tags, ["smoke", "api"]);
  assertEquals(tests[1].meta.tags, ["smoke", "api"]);

  const registry = getRegistry();
  assertEquals(registry[0].tags, ["smoke", "api"]);
  assertEquals(registry[1].tags, ["smoke", "api"]);
});

Deno.test("test.each - name interpolation works", () => {
  clearRegistry();
  const tests = test.each([{ method: "GET", path: "/users" }])(
    { id: "$method-$path", name: "$method $path test" },
    async (_ctx, _data) => {},
  );

  assertEquals(tests[0].meta.id, "GET-/users");
  assertEquals(tests[0].meta.name, "GET /users test");
});

Deno.test("test.each - each test receives correct data row", async () => {
  clearRegistry();
  const received: Array<{ id: number; expected: number }> = [];
  const ctx = createMockContext();

  const tests = test.each([
    { id: 1, expected: 200 },
    { id: 2, expected: 404 },
  ])("test-$id", async (_ctx, data) => {
    received.push(data);
  });

  // Execute each test
  await tests[0].fn!(ctx);
  await tests[1].fn!(ctx);

  assertEquals(received.length, 2);
  assertEquals(received[0], { id: 1, expected: 200 });
  assertEquals(received[1], { id: 2, expected: 404 });
});

Deno.test("test.each - empty table produces no tests", () => {
  clearRegistry();
  const tests = test.each([])("empty-$index", async (_ctx, _data) => {});
  assertEquals(tests.length, 0);
  assertEquals(getRegistry().length, 0);
});

Deno.test("test.each - returns Test[] array (not single Test)", () => {
  clearRegistry();
  const result = test.each([{ x: 1 }])("t-$x", async () => {});
  assertEquals(Array.isArray(result), true);
  assertEquals(result.length, 1);
  assertEquals(result[0].meta.id, "t-1");
});

// ==================== test.each Builder Mode Tests ====================

Deno.test(
  "test.each builder - returns EachBuilder when no fn is passed",
  () => {
    clearRegistry();
    const builder = test.each([{ id: 1 }, { id: 2 }])("item-$id");

    assertExists(builder);
    assertEquals(builder instanceof EachBuilder, true);
    assertEquals(builder.__glubean_type, "each-builder");
  },
);

Deno.test("test.each builder - build() produces Test[] with steps", () => {
  clearRegistry();
  const tests = test
    .each([{ userId: 1 }, { userId: 2 }])("user-flow-$userId")
    .step("fetch user", async (_ctx, _state, _row) => {})
    .step("verify posts", async (_ctx, _state, _row) => {})
    .build();

  assertEquals(tests.length, 2);
  assertEquals(tests[0].meta.id, "user-flow-1");
  assertEquals(tests[1].meta.id, "user-flow-2");
  assertEquals(tests[0].type, "steps");
  assertEquals(tests[1].type, "steps");
  assertEquals(tests[0].steps?.length, 2);
  assertEquals(tests[0].steps?.[0].meta.name, "fetch user");
  assertEquals(tests[0].steps?.[1].meta.name, "verify posts");
});

Deno.test(
  "test.each builder - registers all tests with steps to registry",
  () => {
    clearRegistry();
    test
      .each([{ role: "admin" }, { role: "viewer" }])("auth-flow-$role")
      .meta({ tags: ["auth"] })
      .step("login", async () => {})
      .step("check perms", async () => {})
      .build();

    const registry = getRegistry();
    assertEquals(registry.length, 2);
    assertEquals(registry[0].id, "auth-flow-admin");
    assertEquals(registry[1].id, "auth-flow-viewer");
    assertEquals(registry[0].type, "steps");
    assertEquals(registry[0].steps, [
      { name: "login" },
      {
        name: "check perms",
      },
    ]);
    assertEquals(registry[0].tags, ["auth"]);
    assertEquals(registry[1].steps, [
      { name: "login" },
      {
        name: "check perms",
      },
    ]);
  },
);

Deno.test("test.each builder - setup receives data row", async () => {
  clearRegistry();
  const ctx = createMockContext();

  const tests = test
    .each([{ userId: 42 }])("setup-$userId")
    .setup(async (_ctx, row) => {
      return { capturedUserId: row.userId };
    })
    .step("verify state", async (_ctx, state) => {
      assertEquals(state.capturedUserId, 42);
    })
    .build();

  assertEquals(tests.length, 1);
  const state = await tests[0].setup!(ctx);
  assertEquals(state.capturedUserId, 42);
});

Deno.test("test.each builder - step receives data row", async () => {
  clearRegistry();
  const ctx = createMockContext();
  const received: number[] = [];

  const tests = test
    .each([{ n: 10 }, { n: 20 }])("step-row-$n")
    .step("capture", async (_ctx, _state, row) => {
      received.push(row.n);
    })
    .build();

  // Execute both tests' first step with undefined state
  await tests[0].steps![0].fn(ctx, undefined);
  await tests[1].steps![0].fn(ctx, undefined);

  assertEquals(received, [10, 20]);
});

Deno.test("test.each builder - teardown receives data row", async () => {
  clearRegistry();
  const ctx = createMockContext();
  const teardownRows: number[] = [];

  const tests = test
    .each([{ id: 1 }, { id: 2 }])("td-$id")
    .step("noop", async () => {})
    .teardown(async (_ctx, _state, row) => {
      teardownRows.push(row.id);
    })
    .build();

  await tests[0].teardown!(ctx, undefined);
  await tests[1].teardown!(ctx, undefined);

  assertEquals(teardownRows, [1, 2]);
});

Deno.test("test.each builder - supports $index interpolation", () => {
  clearRegistry();
  const tests = test
    .each([{ x: "a" }, { x: "b" }])("item-$index-$x")
    .step("s", async () => {})
    .build();

  assertEquals(tests[0].meta.id, "item-0-a");
  assertEquals(tests[1].meta.id, "item-1-b");
});

Deno.test("test.each builder - supports metadata object", () => {
  clearRegistry();
  const tests = test
    .each([{ code: 200 }, { code: 404 }])({
      id: "status-$code",
      tags: ["smoke"],
    })
    .step("check", async () => {})
    .build();

  assertEquals(tests[0].meta.id, "status-200");
  assertEquals(tests[0].meta.tags, ["smoke"]);
  assertEquals(tests[1].meta.id, "status-404");
  assertEquals(tests[1].meta.tags, ["smoke"]);
});

Deno.test("test.each builder - .meta() merges additional metadata", () => {
  clearRegistry();
  const tests = test
    .each([{ v: 1 }])("meta-$v")
    .meta({ tags: ["e2e"], description: "End-to-end" })
    .step("s", async () => {})
    .build();

  assertEquals(tests[0].meta.tags, ["e2e"]);
  assertEquals(tests[0].meta.description, "End-to-end");
});

Deno.test("test.each builder - step options (retries, timeout)", () => {
  clearRegistry();
  const tests = test
    .each([{ x: 1 }])("opts-$x")
    .step("retry step", { retries: 3, timeout: 5000 }, async () => {})
    .build();

  assertEquals(tests[0].steps![0].meta.name, "retry step");
  assertEquals(tests[0].steps![0].meta.retries, 3);
  assertEquals(tests[0].steps![0].meta.timeout, 5000);
});

Deno.test("test.each builder - empty table produces empty array", () => {
  clearRegistry();
  const tests = test
    .each([])("empty-$index")
    .step("s", async () => {})
    .build();

  assertEquals(tests.length, 0);
  assertEquals(getRegistry().length, 0);
});

Deno.test("test.each builder - build() is idempotent", () => {
  clearRegistry();
  const builder = test
    .each([{ x: 1 }])("idem-$x")
    .step("s", async () => {});
  const first = builder.build();
  const second = builder.build();

  assertEquals(first.length, 1);
  assertEquals(second.length, 1);
  assertEquals(first[0].meta.id, "idem-1");

  // Only one entry in registry
  const entries = getRegistry().filter((r) => r.id === "idem-1");
  assertEquals(entries.length, 1);
});

Deno.test(
  "test.each builder - auto-registers via microtask (no .build())",
  async () => {
    clearRegistry();

    // Create EachBuilder WITHOUT calling .build()
    const _builder = test
      .each([{ env: "staging" }, { env: "prod" }])("deploy-$env")
      .meta({ tags: ["deploy"] })
      .step("prepare", async () => {})
      .step("verify", async () => {});

    // Registry should be empty before microtask fires
    assertEquals(getRegistry().length, 0);

    // Yield to microtask queue
    await new Promise<void>((r) => queueMicrotask(r));

    // Now the registry should have both tests
    const registry = getRegistry();
    assertEquals(registry.length, 2);
    assertEquals(registry[0].id, "deploy-staging");
    assertEquals(registry[1].id, "deploy-prod");
    assertEquals(registry[0].steps, [{ name: "prepare" }, { name: "verify" }]);
    assertEquals(registry[0].tags, ["deploy"]);
  },
);

Deno.test(
  "test.each builder - explicit .build() prevents double registration",
  async () => {
    clearRegistry();

    const _tests = test
      .each([{ x: 1 }])("no-dup-$x")
      .step("s", async () => {})
      .build();

    assertEquals(getRegistry().length, 1);

    // Yield to microtask — should NOT create a second registry entry
    await new Promise<void>((r) => queueMicrotask(r));

    assertEquals(getRegistry().length, 1);
    assertEquals(getRegistry()[0].id, "no-dup-1");
  },
);

Deno.test("test.each builder - state flows through steps", async () => {
  clearRegistry();
  const ctx = createMockContext();

  const tests = test
    .each([{ factor: 10 }])("flow-$factor")
    .setup(async (_ctx, row) => {
      return { value: row.factor };
    })
    .step("double", async (_ctx, state) => {
      return { value: state.value * 2 };
    })
    .step("check", async (_ctx, state) => {
      assertEquals(state.value, 20);
    })
    .build();

  // Simulate runner: setup -> steps
  let state = await tests[0].setup!(ctx);
  assertEquals(state.value, 10);

  state = (await tests[0].steps![0].fn(ctx, state)) as { value: number };
  assertEquals(state.value, 20);

  await tests[0].steps![1].fn(ctx, state);
});

Deno.test("test.each builder - hasSetup/hasTeardown in registry", () => {
  clearRegistry();
  test
    .each([{ x: 1 }])("hooks-$x")
    .setup(async () => ({ v: 1 }))
    .step("s", async () => {})
    .teardown(async () => {})
    .build();

  const reg = getRegistry();
  assertEquals(reg[0].hasSetup, true);
  assertEquals(reg[0].hasTeardown, true);
});

// ==================== Type Guard Tests ====================

Deno.test("Test type has correct structure (simple)", () => {
  clearRegistry();
  const t = test("type-test", () => Promise.resolve());

  // Type narrowing
  if (t.type === "simple") {
    assertExists(t.fn);
    assertEquals(t.steps, undefined);
  }
});

Deno.test("Test type has correct structure (steps)", () => {
  clearRegistry();
  const t = test("type-test")
    .step("s1", () => Promise.resolve())
    .build();

  if (t.type === "steps") {
    assertExists(t.steps);
    assertEquals(t.fn, undefined);
  }
});

// ==================== test.pick Tests ====================

const pickExamples = {
  normal: { name: "Alice", age: 25 },
  "edge-case": { name: "", age: -1 },
  admin: { name: "Admin", role: "admin" },
};

Deno.test(
  "test.pick - selects one example by default and injects _pick",
  () => {
    clearRegistry();
    // Ensure no GLUBEAN_PICK env is set
    try {
      Deno.env.delete("GLUBEAN_PICK");
    } catch {
      // env var may not exist
    }

    const tests = test.pick(pickExamples)("pick-$_pick", async (_ctx, row) => {
      assertExists(row._pick);
      assertExists(row.name);
    });

    // Default count=1 → should produce exactly 1 test
    assertEquals(tests.length, 1);
    // The test ID should include the picked key
    const id = tests[0].meta.id;
    const validKeys = Object.keys(pickExamples);
    const pickedKey = id.replace("pick-", "");
    assertEquals(validKeys.includes(pickedKey), true);
  },
);

Deno.test(
  "test.pick - respects GLUBEAN_PICK env var for specific selection",
  () => {
    clearRegistry();
    Deno.env.set("GLUBEAN_PICK", "admin");

    try {
      const tests = test.pick(pickExamples)(
        "pick-$_pick",
        async (_ctx, row) => {
          assertEquals(row._pick, "admin");
          assertEquals(row.name, "Admin");
        },
      );

      assertEquals(tests.length, 1);
      assertEquals(tests[0].meta.id, "pick-admin");
    } finally {
      Deno.env.delete("GLUBEAN_PICK");
    }
  },
);

Deno.test("test.pick - supports multiple keys via GLUBEAN_PICK", () => {
  clearRegistry();
  Deno.env.set("GLUBEAN_PICK", "normal,admin");

  try {
    const tests = test.pick(pickExamples)("pick-$_pick", async () => {});

    assertEquals(tests.length, 2);
    assertEquals(tests[0].meta.id, "pick-normal");
    assertEquals(tests[1].meta.id, "pick-admin");
  } finally {
    Deno.env.delete("GLUBEAN_PICK");
  }
});

Deno.test(
  "test.pick - falls back to random when GLUBEAN_PICK key not found",
  () => {
    clearRegistry();
    Deno.env.set("GLUBEAN_PICK", "nonexistent");

    try {
      // Invalid key should NOT throw — falls back to random selection.
      // This handles the case where GLUBEAN_PICK leaks across multiple
      // test.pick calls in the same file (each with different key sets).
      const tests = test.pick(pickExamples)("pick-$_pick", async () => {});
      assertEquals(tests.length, 1);
      // Extract picked key from the test ID (e.g. "pick-admin" → "admin")
      const id = tests[0].meta.id;
      const pickedKey = id.replace("pick-", "");
      const validKeys = Object.keys(pickExamples);
      assertEquals(validKeys.includes(pickedKey), true);
    } finally {
      Deno.env.delete("GLUBEAN_PICK");
    }
  },
);

Deno.test("test.pick - throws on empty examples", () => {
  clearRegistry();
  try {
    Deno.env.delete("GLUBEAN_PICK");
  } catch {
    // env var may not exist
  }

  assertThrows(
    () =>
      test.pick({} as Record<string, Record<string, unknown>>)(
        "empty-$_pick",
        async () => {},
      ),
    Error,
    "test.pick requires at least one example",
  );
});

Deno.test("test.pick - count > 1 selects multiple random examples", () => {
  clearRegistry();
  try {
    Deno.env.delete("GLUBEAN_PICK");
  } catch {
    // env var may not exist
  }

  const tests = test.pick(pickExamples, 2)("pick-$_pick", async () => {});

  assertEquals(tests.length, 2);
  // Both should have valid _pick keys and distinct IDs
  const ids = tests.map((t) => t.meta.id);
  assertEquals(new Set(ids).size, 2);
});

Deno.test("test.pick - count larger than examples returns all", () => {
  clearRegistry();
  try {
    Deno.env.delete("GLUBEAN_PICK");
  } catch {
    // env var may not exist
  }

  const tests = test.pick(pickExamples, 10)("pick-$_pick", async () => {});

  // Should return all 3, not 10
  assertEquals(tests.length, 3);
});

Deno.test("test.pick - GLUBEAN_PICK=all selects every example", () => {
  clearRegistry();
  Deno.env.set("GLUBEAN_PICK", "all");

  try {
    const tests = test.pick(pickExamples)("pick-$_pick", async () => {});

    assertEquals(tests.length, 3);
    const ids = tests.map((t) => t.meta.id).sort();
    assertEquals(ids, ["pick-admin", "pick-edge-case", "pick-normal"]);
  } finally {
    Deno.env.delete("GLUBEAN_PICK");
  }
});

Deno.test("test.pick - GLUBEAN_PICK=* selects every example", () => {
  clearRegistry();
  Deno.env.set("GLUBEAN_PICK", "*");

  try {
    const tests = test.pick(pickExamples)("pick-$_pick", async () => {});

    assertEquals(tests.length, 3);
  } finally {
    Deno.env.delete("GLUBEAN_PICK");
  }
});

Deno.test("test.pick - glob pattern matches subset of keys", () => {
  clearRegistry();
  const regionExamples = {
    "us-east-1": { endpoint: "https://us-east-1.example.com" },
    "us-east-2": { endpoint: "https://us-east-2.example.com" },
    "eu-west-1": { endpoint: "https://eu-west-1.example.com" },
    "eu-west-2": { endpoint: "https://eu-west-2.example.com" },
    "ap-south-1": { endpoint: "https://ap-south-1.example.com" },
  };

  Deno.env.set("GLUBEAN_PICK", "us-*");
  try {
    const tests = test.pick(regionExamples)("region-$_pick", async () => {});

    assertEquals(tests.length, 2);
    const ids = tests.map((t) => t.meta.id).sort();
    assertEquals(ids, ["region-us-east-1", "region-us-east-2"]);
  } finally {
    Deno.env.delete("GLUBEAN_PICK");
  }
});

Deno.test("test.pick - glob pattern with multiple segments", () => {
  clearRegistry();
  const regionExamples = {
    "us-east-1": { endpoint: "https://us-east-1.example.com" },
    "us-west-1": { endpoint: "https://us-west-1.example.com" },
    "eu-west-1": { endpoint: "https://eu-west-1.example.com" },
  };

  Deno.env.set("GLUBEAN_PICK", "us-*,eu-*");
  try {
    const tests = test.pick(regionExamples)("region-$_pick", async () => {});

    assertEquals(tests.length, 3);
  } finally {
    Deno.env.delete("GLUBEAN_PICK");
  }
});

Deno.test("test.pick - glob no match falls back to random", () => {
  clearRegistry();
  Deno.env.set("GLUBEAN_PICK", "zzz-*");

  try {
    const tests = test.pick(pickExamples)("pick-$_pick", async () => {});

    // No match → falls back to random 1
    assertEquals(tests.length, 1);
    const pickedKey = tests[0].meta.id.replace("pick-", "");
    const validKeys = Object.keys(pickExamples);
    assertEquals(validKeys.includes(pickedKey), true);
  } finally {
    Deno.env.delete("GLUBEAN_PICK");
  }
});

Deno.test("test.pick - mixed exact and glob in GLUBEAN_PICK", () => {
  clearRegistry();
  const regionExamples = {
    "us-east-1": { endpoint: "https://us-east-1.example.com" },
    "us-east-2": { endpoint: "https://us-east-2.example.com" },
    "eu-west-1": { endpoint: "https://eu-west-1.example.com" },
  };

  // Mix exact key with glob
  Deno.env.set("GLUBEAN_PICK", "eu-west-1,us-*");
  try {
    const tests = test.pick(regionExamples)("region-$_pick", async () => {});

    assertEquals(tests.length, 3);
  } finally {
    Deno.env.delete("GLUBEAN_PICK");
  }
});

// ==================== TestBuilder .use() / .group() Tests ====================

Deno.test("TestBuilder.use() - applies transform function", () => {
  clearRegistry();
  const withLogin = (b: TestBuilder<unknown>) => b.step("login", async (_ctx) => ({ token: "abc" }));

  const result = test("use-test").use(withLogin).build();

  assertEquals(result.steps?.length, 1);
  assertEquals(result.steps?.[0].meta.name, "login");
});

Deno.test("TestBuilder.use() - chains multiple transforms", () => {
  clearRegistry();
  const withAuth = (b: TestBuilder<unknown>) => b.step("login", async (_ctx) => ({ token: "abc" }));
  const withCart = (b: TestBuilder<{ token: string }>) =>
    b.step("create cart", async (_ctx, { token }) => ({
      token,
      cartId: "c1",
    }));

  const result = test("chain-use")
    .use(withAuth)
    .use(withCart)
    .step("checkout", async (_ctx, _state) => {})
    .build();

  assertEquals(result.steps?.length, 3);
  assertEquals(result.steps?.[0].meta.name, "login");
  assertEquals(result.steps?.[1].meta.name, "create cart");
  assertEquals(result.steps?.[2].meta.name, "checkout");
});

Deno.test("TestBuilder.use() - state flows through transform", async () => {
  clearRegistry();
  const ctx = createMockContext();

  const withSetup = (b: TestBuilder<unknown>) => b.step("init", async (_ctx) => ({ value: 42 }));

  const t = test("use-state")
    .use(withSetup)
    .step("check", async (_ctx, state) => {
      assertEquals(state.value, 42);
    })
    .build();

  // Manual step invocation outside normal runner flow — cast state type
  const state = await t.steps![0].fn(ctx, undefined as never);
  await t.steps![1].fn(ctx, state as { value: number });
});

Deno.test("TestBuilder.group() - marks steps with group id", () => {
  clearRegistry();
  const result = test("group-test")
    .group("setup", (b) =>
      b
        .step("seed db", async (_ctx) => ({ dbId: "d1" }))
        .step("create user", async (_ctx, { dbId }) => ({
          dbId,
          userId: "u1",
        })))
    .step("verify", async (_ctx, _state) => {})
    .build();

  assertEquals(result.steps?.length, 3);
  assertEquals(result.steps?.[0].meta.group, "setup");
  assertEquals(result.steps?.[1].meta.group, "setup");
  assertEquals(result.steps?.[2].meta.group, undefined);
});

Deno.test("TestBuilder.group() - reusable transform with group", () => {
  clearRegistry();
  const withAuth = (b: TestBuilder<unknown>) =>
    b
      .step("login", async (_ctx) => ({ token: "abc" }))
      .step("verify", async (_ctx, state) => ({ ...state, verified: true }));

  const result = test("group-reuse")
    .group("auth", withAuth)
    .step("act", async (_ctx, _state) => {})
    .build();

  assertEquals(result.steps?.length, 3);
  assertEquals(result.steps?.[0].meta.name, "login");
  assertEquals(result.steps?.[0].meta.group, "auth");
  assertEquals(result.steps?.[1].meta.name, "verify");
  assertEquals(result.steps?.[1].meta.group, "auth");
  assertEquals(result.steps?.[2].meta.name, "act");
  assertEquals(result.steps?.[2].meta.group, undefined);
});

Deno.test("TestBuilder.group() - multiple groups", () => {
  clearRegistry();
  const result = test("multi-group")
    .group("phase-1", (b) => b.step("a", async (_ctx) => ({ v: 1 })))
    .group("phase-2", (b) => b.step("b", async (_ctx, state) => ({ ...state, w: 2 })))
    .step("final", async (_ctx, _state) => {})
    .build();

  assertEquals(result.steps?.length, 3);
  assertEquals(result.steps?.[0].meta.group, "phase-1");
  assertEquals(result.steps?.[1].meta.group, "phase-2");
  assertEquals(result.steps?.[2].meta.group, undefined);
});

Deno.test("TestBuilder.group() - steps appear in registry", async () => {
  clearRegistry();
  const _builder = test("group-reg")
    .group("auth", (b) => b.step("login", async (_ctx) => {}))
    .step("act", async (_ctx) => {});

  // Yield to microtask for auto-registration
  await new Promise<void>((r) => queueMicrotask(r));

  const registry = getRegistry();
  assertEquals(registry.length, 1);
  assertEquals(registry[0].steps, [
    { name: "login", group: "auth" },
    { name: "act" },
  ]);
});

// ==================== EachBuilder .use() / .group() Tests ====================

Deno.test("EachBuilder.use() - applies transform", () => {
  clearRegistry();
  const withStep = (b: EachBuilder<unknown, { n: number }>) => b.step("check", async (_ctx, _state, _row) => {});

  const tests = test
    .each([{ n: 1 }])("each-use-$n")
    .use(withStep)
    .build();

  assertEquals(tests[0].steps?.length, 1);
  assertEquals(tests[0].steps?.[0].meta.name, "check");
});

Deno.test("EachBuilder.group() - marks steps with group id", () => {
  clearRegistry();
  const tests = test
    .each([{ n: 1 }])("each-group-$n")
    .group("init", (b) => b.step("seed", async (_ctx) => ({ seeded: true })))
    .step("verify", async (_ctx, _state) => {})
    .build();

  assertEquals(tests[0].steps?.length, 2);
  assertEquals(tests[0].steps?.[0].meta.group, "init");
  assertEquals(tests[0].steps?.[1].meta.group, undefined);
});

// ==================== test.pick Tests ====================

Deno.test("test.pick - works with builder mode (no callback)", () => {
  clearRegistry();
  Deno.env.set("GLUBEAN_PICK", "normal");

  try {
    const builder = test.pick(pickExamples)("pick-$_pick");

    // Should return an EachBuilder
    assertExists(builder);
    assertEquals(builder instanceof EachBuilder, true);

    const tests = builder
      .step("check", async (_ctx, _state, row) => {
        assertExists(row._pick);
      })
      .build();

    assertEquals(tests.length, 1);
    assertEquals(tests[0].meta.id, "pick-normal");
  } finally {
    Deno.env.delete("GLUBEAN_PICK");
  }
});

Deno.test("test.pick - registers tests in global registry", () => {
  clearRegistry();
  Deno.env.set("GLUBEAN_PICK", "edge-case");

  try {
    test.pick(pickExamples)("pick-$_pick", async () => {});

    const reg = getRegistry();
    assertEquals(reg.length, 1);
    assertEquals(reg[0].id, "pick-edge-case");
  } finally {
    Deno.env.delete("GLUBEAN_PICK");
  }
});
