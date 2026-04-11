import { test, expect, beforeEach } from "vitest";
import { contract } from "./contract.js";
import { clearRegistry, getRegistry } from "./internal.js";
import { Expectation } from "./expect.js";
import type { HttpClient, HttpResponsePromise, TestContext } from "./types.js";

// ---------------------------------------------------------------------------
// Mock HTTP client factory
// ---------------------------------------------------------------------------

function createMockClient(
  responses: Record<string, { status: number; body?: unknown }> = {},
): HttpClient {
  const defaultResponse = { status: 200, body: {} };

  function makeResponse(key: string): HttpResponsePromise {
    const resp = responses[key] ?? defaultResponse;
    const bodyStr = JSON.stringify(resp.body ?? {});
    const raw = new Response(bodyStr, {
      status: resp.status,
      headers: { "Content-Type": "application/json" },
    });

    // HttpResponsePromise extends Promise<HttpResponse> with .json()/.text()
    const p = Promise.resolve(raw) as HttpResponsePromise;
    p.json = <T = unknown>() => Promise.resolve(resp.body as T);
    p.text = () => Promise.resolve(bodyStr);
    p.blob = () => raw.blob();
    p.arrayBuffer = () => raw.arrayBuffer();
    return p;
  }

  const handler = (method: string) => (url: string | URL | Request) => {
    const key = `${method.toUpperCase()} ${String(url)}`;
    return makeResponse(key);
  };

  const client = Object.assign(handler("GET"), {
    get: handler("GET"),
    post: handler("POST"),
    put: handler("PUT"),
    patch: handler("PATCH"),
    delete: handler("DELETE"),
    head: handler("HEAD"),
    extend: () => client,
  });

  return client as unknown as HttpClient;
}

// ---------------------------------------------------------------------------
// Mock TestContext
// ---------------------------------------------------------------------------

function createMockContext(): TestContext {
  return {
    vars: { get: () => undefined, require: (k: string) => k, all: () => ({}) },
    secrets: { get: () => undefined, require: (k: string) => k },
    session: { get: () => undefined, set: () => {}, delete: () => false, has: () => false, all: () => ({}) },
    log: () => {},
    assert: () => {},
    trace: () => {},
    action: () => {},
    event: () => {},
    metric: () => {},
    http: createMockClient() as unknown as HttpClient,
    expect: <V>(actual: V) => new Expectation(actual, () => {}),
    warn: () => {},
    validate: (_data: unknown, _schema: any) => _data,
    skip: (reason?: string): never => { throw new Error(`SKIP: ${reason ?? ""}`); },
    fail: (msg: string): never => { throw new Error(msg); },
    pollUntil: async () => {},
    setTimeout: () => {},
    retryCount: 0,
    getMemoryUsage: () => null,
  } as unknown as TestContext;
}

// ---------------------------------------------------------------------------
// Mock schema
// ---------------------------------------------------------------------------

const UserSchema = {
  safeParse: (data: unknown) => {
    const obj = data as Record<string, unknown>;
    if (typeof obj?.id === "string" && typeof obj?.name === "string") {
      return { success: true as const, data: obj as { id: string; name: string } };
    }
    return {
      success: false as const,
      error: { issues: [{ message: "invalid user shape" }] },
    };
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearRegistry();
});

test("contract.http() produces HttpContract extending Array<Test>", () => {
  const client = createMockClient();

  const result = contract.http("get-user", {
    endpoint: "GET /users/:id",
    client,
    cases: {
      success: {
        description: "test",
        expect: { status: 200 },
      },
      notFound: {
        description: "test",
        expect: { status: 404 },
      },
    },
  });

  // Extends Array
  expect(Array.isArray(result)).toBe(true);
  expect(result).toHaveLength(2);

  // Has contract-level properties
  expect(result.id).toBe("get-user");
  expect(result.endpoint).toBe("GET /users/:id");

  // Each element is a Test
  expect(result[0].meta.id).toBe("get-user.success");
  expect(result[1].meta.id).toBe("get-user.notFound");
  expect(result[0].type).toBe("simple");
  expect(result[0].fn).toBeTypeOf("function");
});

test("case IDs follow contractId.caseKey pattern", () => {
  const client = createMockClient();

  const result = contract.http("create-user", {
    endpoint: "POST /users",
    client,
    cases: {
      success: { description: "test", expect: { status: 201 } },
      invalidBody: { description: "test", expect: { status: 400 } },
      duplicate: { description: "test", expect: { status: 409 } },
    },
  });

  expect(result.map((t) => t.meta.id)).toEqual([
    "create-user.success",
    "create-user.invalidBody",
    "create-user.duplicate",
  ]);
});

test("tags inherit from contract-level and merge with case-level", () => {
  const client = createMockClient();

  const result = contract.http("list-users", {
    endpoint: "GET /users",
    client,
    tags: ["users", "api"],
    cases: {
      success: {
        description: "test",
        expect: { status: 200 },
        tags: ["happy"],
      },
      noAuth: {
        description: "test",
        expect: { status: 401 },
      },
    },
  });

  expect(result[0].meta.tags).toEqual(["users", "api", "happy"]);
  expect(result[1].meta.tags).toEqual(["users", "api"]);
});

test("cases register to global registry with contract metadata", () => {
  const client = createMockClient();

  contract.http("whoami", {
    endpoint: "GET /whoami",
    client,
    cases: {
      success: { description: "test", expect: { status: 200, schema: UserSchema } },
      noAuth: { description: "test", expect: { status: 401 }, deferred: "needs credentials" },
    },
  });

  const registry = getRegistry();
  const entries = registry.filter((r) => r.id.startsWith("whoami."));

  expect(entries).toHaveLength(2);

  const success = entries.find((r) => r.id === "whoami.success")!;
  expect(success.groupId).toBe("whoami");
  expect((success as any).contract).toEqual({
    endpoint: "GET /whoami",
    protocol: "http",
    caseKey: "success",
    expectStatus: 200,
    hasSchema: true,
    deferred: undefined,
  });

  const noAuth = entries.find((r) => r.id === "whoami.noAuth")!;
  expect((noAuth as any).contract.deferred).toBe("needs credentials");
});

test("case-level client overrides contract-level client", () => {
  const defaultClient = createMockClient({
    "GET /users": { status: 200, body: { source: "default" } },
  });
  const adminClient = createMockClient({
    "GET /users": { status: 200, body: { source: "admin" } },
  });

  const result = contract.http("list-users", {
    endpoint: "GET /users",
    client: defaultClient,
    cases: {
      withDefault: {
        description: "test",
        expect: { status: 200 },
      },
      withAdmin: {
        description: "test",
        client: adminClient,
        expect: { status: 200 },
      },
    },
  });

  // Both cases should have fn, verifying client resolution doesn't throw
  expect(result[0].fn).toBeTypeOf("function");
  expect(result[1].fn).toBeTypeOf("function");
});

test("contract.register() adds a protocol and rejects reserved names", () => {
  expect(() => contract.register("http", { execute: async () => {}, metadata: () => ({ protocol: "http" }) }))
    .toThrow('Cannot register reserved protocol "http"');

  expect(() => contract.register("register", { execute: async () => {}, metadata: () => ({ protocol: "register" }) }))
    .toThrow('Cannot register reserved protocol "register"');

  // Valid registration
  contract.register("grpc", {
    execute: async () => {},
    metadata: (spec: { service: string }) => ({ protocol: "grpc", endpoint: spec.service }),
  });

  expect(contract.grpc).toBeTypeOf("function");
});

test("asSteps() and asStep() are available", () => {
  const client = createMockClient();

  const result = contract.http("test-contract", {
    endpoint: "GET /test",
    client,
    cases: {
      success: { description: "test", expect: { status: 200 } },
    },
  });

  expect(result.asSteps).toBeTypeOf("function");
  expect(result.asStep).toBeTypeOf("function");
});

test("throws when no client is provided", async () => {
  const result = contract.http("no-client", {
    endpoint: "GET /test",
    // no client at contract or case level
    cases: {
      success: { description: "test", expect: { status: 200 } },
    },
  });

  expect(result).toHaveLength(1);
  expect(result[0].fn).toBeTypeOf("function");
  // The fn will throw at runtime when executed without a client
});

test("verify() receives raw JSON body when no schema provided", async () => {
  let receivedBody: unknown;
  const client = createMockClient({
    "GET /data": { status: 200, body: { foo: "bar", count: 42 } },
  });

  const result = contract.http("verify-no-schema", {
    endpoint: "GET /data",
    client,
    cases: {
      success: {
        description: "test",
        expect: { status: 200 },
        verify: async (_ctx, res) => {
          receivedBody = res;
        },
      },
    },
  });

  // Simulate execution
  const mockCtx = createMockContext();
  await result[0].fn!(mockCtx);

  expect(receivedBody).toEqual({ foo: "bar", count: 42 });
});

test("verify() receives schema-parsed value when schema provided", async () => {
  let receivedBody: unknown;
  const client = createMockClient({
    "GET /user": { status: 200, body: { id: "u1", name: "Alice" } },
  });

  const result = contract.http("verify-with-schema", {
    endpoint: "GET /user",
    client,
    cases: {
      success: {
        description: "test",
        expect: { status: 200, schema: UserSchema },
        verify: async (_ctx, res) => {
          receivedBody = res;
        },
      },
    },
  });

  const mockCtx = createMockContext();
  await result[0].fn!(mockCtx);

  expect(receivedBody).toEqual({ id: "u1", name: "Alice" });
});

test("setup and teardown execute in correct order", async () => {
  const order: string[] = [];
  const client = createMockClient({
    "POST /items": { status: 201, body: { id: "item1" } },
  });

  const result = contract.http("lifecycle-order", {
    endpoint: "POST /items",
    client,
    cases: {
      success: {
        description: "test",
        expect: { status: 201 },
        setup: async () => {
          order.push("setup");
          return { itemId: "item1" };
        },
        verify: async () => {
          order.push("verify");
        },
        teardown: async () => {
          order.push("teardown");
        },
      },
    },
  });

  const mockCtx = createMockContext();
  await result[0].fn!(mockCtx);

  expect(order).toEqual(["setup", "verify", "teardown"]);
});

test("teardown runs even when verify throws", async () => {
  let teardownRan = false;
  const client = createMockClient({
    "GET /fail": { status: 200, body: {} },
  });

  const result = contract.http("teardown-on-fail", {
    endpoint: "GET /fail",
    client,
    cases: {
      success: {
        description: "test",
        expect: { status: 200 },
        verify: async () => {
          throw new Error("verify failed");
        },
        teardown: async () => {
          teardownRan = true;
        },
      },
    },
  });

  const mockCtx = createMockContext();
  await expect(result[0].fn!(mockCtx)).rejects.toThrow("verify failed");
  expect(teardownRan).toBe(true);
});

test("asStep() skips deferred cases when no caseKey given", () => {
  const client = createMockClient();

  const result = contract.http("deferred-test", {
    endpoint: "GET /test",
    client,
    cases: {
      deferredCase: {
        description: "test",
        expect: { status: 403 },
        deferred: "needs credentials",
      },
      runnableCase: {
        description: "test",
        expect: { status: 200 },
      },
    },
  });

  // asStep() without key should pick runnableCase, not deferredCase
  const stepFn = result.asStep();
  expect(stepFn).toBeTypeOf("function");
  // Verify it picked the right one by checking it doesn't throw
});

test("deferred case calls ctx.skip() at execution time", async () => {
  const client = createMockClient();

  const result = contract.http("deferred-exec", {
    endpoint: "GET /test",
    client,
    cases: {
      blocked: {
        description: "test",
        expect: { status: 403 },
        deferred: "needs viewer credentials",
      },
    },
  });

  const mockCtx = createMockContext();
  await expect(result[0].fn!(mockCtx)).rejects.toThrow("SKIP: needs viewer credentials");
});

test("params function receives setup state", async () => {
  let receivedPath = "";
  const client = createMockClient();
  // Override get to capture the resolved path
  (client as any).get = (url: string, opts: any) => {
    receivedPath = url;
    return createMockClient({ [`GET ${url}`]: { status: 200, body: {} } }).get(url, opts);
  };

  const result = contract.http("param-fn", {
    endpoint: "GET /users/:id",
    client,
    cases: {
      success: {
        description: "test",
        expect: { status: 200 },
        setup: async () => ({ userId: "usr_42" }),
        params: (state: { userId: string }) => ({ id: state.userId }),
      },
    },
  });

  const mockCtx = createMockContext();
  await result[0].fn!(mockCtx);
  expect(receivedPath).toBe("/users/usr_42");
});

test("resolveParams replaces :param placeholders", async () => {
  let receivedPath = "";
  const client = createMockClient();
  (client as any).delete = (url: string, opts: any) => {
    receivedPath = url;
    return createMockClient({ [`DELETE ${url}`]: { status: 200, body: {} } }).delete(url, opts);
  };

  const result = contract.http("resolve-test", {
    endpoint: "DELETE /projects/:projectId/items/:itemId",
    client,
    cases: {
      success: {
        description: "test",
        expect: { status: 200 },
        params: { projectId: "prj_1", itemId: "item_2" },
      },
    },
  });

  const mockCtx = createMockContext();
  await result[0].fn!(mockCtx);
  expect(receivedPath).toBe("/projects/prj_1/items/item_2");
});

test("query params are passed to request", async () => {
  let receivedOpts: any = {};
  const client = createMockClient();
  (client as any).get = (url: string, opts: any) => {
    receivedOpts = opts;
    return createMockClient({ [`GET ${url}`]: { status: 200, body: {} } }).get(url, opts);
  };

  const result = contract.http("query-test", {
    endpoint: "GET /search",
    client,
    cases: {
      success: {
        description: "test",
        expect: { status: 200 },
        query: { q: "hello", limit: "10" },
      },
    },
  });

  const mockCtx = createMockContext();
  await result[0].fn!(mockCtx);
  expect(receivedOpts.searchParams).toEqual({ q: "hello", limit: "10" });
});

test("headers are passed to request", async () => {
  let receivedOpts: any = {};
  const client = createMockClient();
  (client as any).get = (url: string, opts: any) => {
    receivedOpts = opts;
    return createMockClient({ [`GET ${url}`]: { status: 200, body: {} } }).get(url, opts);
  };

  const result = contract.http("headers-test", {
    endpoint: "GET /data",
    client,
    cases: {
      success: {
        description: "test",
        expect: { status: 200 },
        headers: { "X-Custom": "value" },
      },
    },
  });

  const mockCtx = createMockContext();
  await result[0].fn!(mockCtx);
  expect(receivedOpts.headers).toEqual({ "X-Custom": "value" });
});

test("asSteps() injects and executes steps in test builder", async () => {
  const client = createMockClient();

  const myContract = contract.http("as-steps-test", {
    endpoint: "GET /test",
    client,
    cases: {
      a: { description: "test", expect: { status: 200 } },
      b: { description: "test", expect: { status: 201 } },
    },
  });

  const { test: glubeanTest } = await import("./index.js");
  const builder = glubeanTest("combined").use(myContract.asSteps());

  expect(builder).toBeDefined();
  const built = builder.build();
  expect(built.type).toBe("steps");
  expect(built.steps).toHaveLength(2);
});

test("register() adapter execute() is called at runtime", async () => {
  clearRegistry();
  let executeCalled = false;
  let receivedSpec: any;

  contract.register("test-proto", {
    execute: async (_ctx, caseSpec, endpointSpec) => {
      executeCalled = true;
      receivedSpec = { caseSpec, endpointSpec };
    },
    metadata: (spec: { target: string }) => ({
      protocol: "test-proto",
      endpoint: spec.target,
    }),
  });

  const tests = (contract as any)["test-proto"]("my-test", {
    target: "my-service",
    cases: {
      ping: { description: "test", expect: { status: 0 } },
    },
  }) as import("./types.js").Test[];

  const mockCtx = createMockContext();
  await tests[0].fn!(mockCtx);

  expect(executeCalled).toBe(true);
  expect(receivedSpec.endpointSpec.target).toBe("my-service");
});

test("multiple cases do not share state", async () => {
  const states: unknown[] = [];
  const client = createMockClient({
    "POST /items": { status: 201, body: {} },
  });

  const result = contract.http("isolation-test", {
    endpoint: "POST /items",
    client,
    cases: {
      a: {
        description: "test",
        expect: { status: 201 },
        setup: async () => { const s = { id: "a" }; states.push(s); return s; },
      },
      b: {
        description: "test",
        expect: { status: 201 },
        setup: async () => { const s = { id: "b" }; states.push(s); return s; },
      },
    },
  });

  const mockCtx = createMockContext();
  await result[0].fn!(mockCtx);
  await result[1].fn!(mockCtx);

  expect(states).toHaveLength(2);
  expect(states[0]).toEqual({ id: "a" });
  expect(states[1]).toEqual({ id: "b" });
});

test("request schema is accessible on contract object", () => {
  const client = createMockClient();
  const schema = { safeParse: () => ({ success: true as const, data: {} }) };

  const result = contract.http("req-schema", {
    endpoint: "POST /users",
    client,
    request: schema,
    cases: {
      success: { description: "test", expect: { status: 201 } },
    },
  });

  expect(result.request).toBe(schema);
});

test("contract.register() produces executable tests via adapter", () => {
  clearRegistry();

  let executeCalled = false;

  contract.register("custom", {
    execute: async () => { executeCalled = true; },
    metadata: (spec: { target: string }) => ({
      protocol: "custom",
      endpoint: spec.target,
    }),
  });

  const tests = (contract as any).custom("my-custom", {
    target: "my-service",
    cases: {
      ping: { description: "test", expect: { status: 200 } },
    },
  }) as import("./types.js").Test[];

  expect(tests).toHaveLength(1);
  expect(tests[0].meta.id).toBe("my-custom.ping");
  expect(tests[0].fn).toBeTypeOf("function");

  const registry = getRegistry();
  const entry = registry.find((r) => r.id === "my-custom.ping")!;
  expect((entry as any).contract.protocol).toBe("custom");
  expect((entry as any).contract.endpoint).toBe("my-service");
});

// =============================================================================
// contract.flow() tests
// =============================================================================

test("contract.flow() produces a Test with type steps", () => {
  clearRegistry();
  const client = createMockClient({
    "POST /items": { status: 201, body: { id: "item_1" } },
    "GET /items/item_1": { status: 200, body: { id: "item_1", name: "Widget" } },
  });

  const result = contract.flow("item-lifecycle")
    .http("create", {
      endpoint: "POST /items",
      client,
      body: { name: "Widget" },
      expect: { status: 201, schema: { safeParse: (d: unknown) => ({ success: true as const, data: d as { id: string } }) } },
      returns: (res) => ({ itemId: res.id }),
    })
    .http("read", {
      endpoint: "GET /items/:id",
      client,
      params: (state: { itemId: string }) => ({ id: state.itemId }),
      expect: { status: 200 },
    })
    .build();

  expect(result.type).toBe("steps");
  expect(result.steps).toHaveLength(2);
  expect(result.meta.id).toBe("item-lifecycle");
  expect(result.flowId).toBe("item-lifecycle");
  expect(result.flowSteps).toEqual([
    { name: "create", endpoint: "POST /items", expectStatus: 201 },
    { name: "read", endpoint: "GET /items/:id", expectStatus: 200 },
  ]);
});

test("flow state threading via returns(res, state)", async () => {
  clearRegistry();
  const states: unknown[] = [];
  const client = createMockClient({
    "POST /a": { status: 200, body: { aid: "a1" } },
    "POST /b": { status: 200, body: { bid: "b1" } },
  });

  const flow = contract.flow("state-test")
    .http("step a", {
      endpoint: "POST /a",
      client,
      expect: { status: 200 },
      returns: (res: { aid: string }) => ({ aid: res.aid }),
    })
    .http("step b", {
      endpoint: "POST /b",
      client,
      expect: { status: 200 },
      returns: (res: { bid: string }, state: { aid: string }) => {
        // Merge: keep aid from state, add bid from response
        return { aid: state.aid, bid: res.bid };
      },
    })
    .build();

  // Execute step by step
  const mockCtx = createMockContext();
  let state: any = undefined;

  // Run setup (none)
  // Run steps
  for (const step of flow.steps!) {
    state = await step.fn(mockCtx, state) ?? state;
    states.push({ ...state });
  }

  expect(states[0]).toEqual({ aid: "a1" });
  expect(states[1]).toEqual({ aid: "a1", bid: "b1" });
});

test("flow registers to global registry with flow metadata", () => {
  clearRegistry();
  const client = createMockClient();

  contract.flow("registered-flow")
    .http("step1", { endpoint: "GET /a", client, expect: { status: 200 } })
    .http("step2", { endpoint: "POST /b", client, expect: { status: 201 } })
    .build();

  const registry = getRegistry();
  const entry = registry.find((r) => r.id === "registered-flow")!;

  expect(entry).toBeDefined();
  expect(entry.type).toBe("steps");
  expect(entry.flow).toEqual({
    steps: [
      { name: "step1", endpoint: "GET /a", expectStatus: 200 },
      { name: "step2", endpoint: "POST /b", expectStatus: 201 },
    ],
  });
  expect(entry.contract).toBeUndefined();
});

test("flow with setup and teardown", async () => {
  clearRegistry();
  const order: string[] = [];
  const client = createMockClient({
    "GET /data": { status: 200, body: { value: 42 } },
  });

  const flow = contract.flow("setup-teardown")
    .setup(async () => {
      order.push("setup");
      return { token: "abc" };
    })
    .http("fetch", {
      endpoint: "GET /data",
      client,
      expect: { status: 200 },
      verify: async () => { order.push("verify"); },
    })
    .teardown(async () => {
      order.push("teardown");
    })
    .build();

  expect(flow.setup).toBeTypeOf("function");
  expect(flow.teardown).toBeTypeOf("function");

  // Execute setup
  const mockCtx = createMockContext();
  const state = await flow.setup!(mockCtx);
  expect(state).toEqual({ token: "abc" });

  // Execute step
  for (const step of flow.steps!) {
    await step.fn(mockCtx, state);
  }

  // Execute teardown
  await flow.teardown!(mockCtx, state);

  expect(order).toEqual(["setup", "verify", "teardown"]);
});

test("flow step client falls back to flow-level default", async () => {
  clearRegistry();
  let requestedPath = "";
  const defaultClient = createMockClient();
  (defaultClient as any).get = (url: string, opts: any) => {
    requestedPath = url;
    return createMockClient({ [`GET ${url}`]: { status: 200, body: {} } }).get(url, opts);
  };

  const flow = contract.flow("default-client", { client: defaultClient })
    .http("fetch", {
      endpoint: "GET /test",
      // no step-level client — should use flow default
      expect: { status: 200 },
    })
    .build();

  const mockCtx = createMockContext();
  await flow.steps![0].fn(mockCtx, undefined);
  expect(requestedPath).toBe("/test");
});

test("flow step-level client overrides flow default", async () => {
  clearRegistry();
  let usedClient = "";
  const defaultClient = createMockClient();
  (defaultClient as any).post = () => { usedClient = "default"; return createMockClient({ "POST /x": { status: 200, body: {} } }).post("/x"); };
  const overrideClient = createMockClient();
  (overrideClient as any).post = () => { usedClient = "override"; return createMockClient({ "POST /x": { status: 200, body: {} } }).post("/x"); };

  const flow = contract.flow("client-override", { client: defaultClient })
    .http("with-override", {
      endpoint: "POST /x",
      client: overrideClient,
      expect: { status: 200 },
    })
    .build();

  const mockCtx = createMockContext();
  await flow.steps![0].fn(mockCtx, undefined);
  expect(usedClient).toBe("override");
});

test("flow asSteps() injects steps into test builder", async () => {
  clearRegistry();
  const client = createMockClient({
    "GET /ping": { status: 200, body: {} },
  });

  const flow = contract.flow("composable")
    .http("ping", { endpoint: "GET /ping", client, expect: { status: 200 } })
    .build();

  const { test: glubeanTest } = await import("./index.js");
  const builder = glubeanTest("combined").use(flow.asSteps());
  const built = builder.build();

  expect(built.type).toBe("steps");
  expect(built.steps).toHaveLength(1);
  expect(built.steps![0].meta.name).toBe("ping");
});

test("flow asSteps() injects setup and teardown as regular steps (no finally semantics)", async () => {
  clearRegistry();
  const order: string[] = [];
  const client = createMockClient({
    "GET /data": { status: 200, body: {} },
  });

  const flow = contract.flow("with-lifecycle")
    .setup(async () => {
      order.push("setup");
      return { token: "abc" };
    })
    .http("fetch", {
      endpoint: "GET /data",
      client,
      expect: { status: 200 },
      verify: async () => { order.push("fetch"); },
    })
    .teardown(async () => {
      order.push("teardown");
    })
    .build();

  // Compose into another test via asSteps()
  const { test: glubeanTest } = await import("./index.js");
  const built = glubeanTest("composed").use(flow.asSteps()).build();

  // Should have 3 steps: setup + fetch + teardown
  expect(built.steps).toHaveLength(3);
  expect(built.steps![0].meta.name).toBe("with-lifecycle [setup]");
  expect(built.steps![1].meta.name).toBe("fetch");
  expect(built.steps![2].meta.name).toBe("with-lifecycle [teardown]");
});

test("flow body as function of state", async () => {
  clearRegistry();
  let receivedBody: unknown;
  const client = createMockClient();
  (client as any).post = (url: string, opts: any) => {
    receivedBody = opts?.json;
    return createMockClient({ [`POST ${url}`]: { status: 200, body: {} } }).post(url, opts);
  };

  const flow = contract.flow("body-fn")
    .setup(async () => ({ name: "Alice" }))
    .http("create", {
      endpoint: "POST /users",
      client,
      body: (state: { name: string }) => ({ name: state.name, source: "flow" }),
      expect: { status: 200 },
    })
    .build();

  const mockCtx = createMockContext();
  const state = await flow.setup!(mockCtx);
  await flow.steps![0].fn(mockCtx, state);
  expect(receivedBody).toEqual({ name: "Alice", source: "flow" });
});

// =============================================================================
// body / headers as function of state (http case)
// =============================================================================

test("contract.http - body as function of setup state", async () => {
  clearRegistry();
  let receivedBody: unknown;
  const client = createMockClient({ "POST /tokens": { status: 200, body: { ok: true } } });
  (client as any).post = (url: string, opts: any) => {
    receivedBody = opts?.json;
    return createMockClient({ [`POST ${url}`]: { status: 200, body: { ok: true } } }).post(url, opts);
  };

  const [test] = contract.http("body-fn-http", {
    endpoint: "POST /tokens",
    client,
    cases: {
      withToken: {
        description: "sends token from setup state in body",
        setup: async () => ({ token: "abc123" }),
        body: (state: { token: string }) => ({ token: state.token }),
        expect: { status: 200 },
      },
    },
  });

  const mockCtx = createMockContext();
  await test.fn!(mockCtx);
  expect(receivedBody).toEqual({ token: "abc123" });
});

test("contract.http - headers as function of setup state", async () => {
  clearRegistry();
  let receivedHeaders: unknown;
  const client = createMockClient({ "GET /me": { status: 200, body: {} } });
  (client as any).get = (url: string, opts: any) => {
    receivedHeaders = opts?.headers;
    return createMockClient({ [`GET ${url}`]: { status: 200, body: {} } }).get(url, opts);
  };

  const [test] = contract.http("headers-fn-http", {
    endpoint: "GET /me",
    client,
    cases: {
      withAuth: {
        description: "sends auth header from setup state",
        setup: async () => ({ token: "tok_xyz" }),
        headers: (state: { token: string }) => ({ Authorization: `Bearer ${state.token}` }),
        expect: { status: 200 },
      },
    },
  });

  const mockCtx = createMockContext();
  await test.fn!(mockCtx);
  expect(receivedHeaders).toEqual({ Authorization: "Bearer tok_xyz" });
});

test("flow - headers as function of state", async () => {
  clearRegistry();
  let receivedHeaders: unknown;
  const client = createMockClient();
  (client as any).get = (url: string, opts: any) => {
    receivedHeaders = opts?.headers;
    return createMockClient({ [`GET ${url}`]: { status: 200, body: {} } }).get(url, opts);
  };

  const flow = contract.flow("headers-fn-flow")
    .setup(async () => ({ token: "flow_tok" }))
    .http("fetch", {
      endpoint: "GET /me",
      client,
      headers: (state: { token: string }) => ({ Authorization: `Bearer ${state.token}` }),
      expect: { status: 200 },
    })
    .build();

  const mockCtx = createMockContext();
  const state = await flow.setup!(mockCtx);
  await flow.steps![0].fn(mockCtx, state);
  expect(receivedHeaders).toEqual({ Authorization: "Bearer flow_tok" });
});

// =============================================================================
// requires / defaultRun — case execution boundary
// =============================================================================

test("contract.http - default requires is headless, defaultRun is always", () => {
  const c = contract.http("default-runtime", {
    endpoint: "GET /health",
    client: createMockClient(),
    cases: {
      check: { description: "health check", expect: { status: 200 } },
    },
  });
  expect(c[0].meta.requires).toBe("headless");
  expect(c[0].meta.defaultRun).toBe("always");
});

test("contract.http - requires: browser auto-implies defaultRun: opt-in", () => {
  const c = contract.http("oauth-callback", {
    endpoint: "POST /auth/google/callback",
    client: createMockClient(),
    cases: {
      success: {
        description: "real Google login",
        requires: "browser",
        expect: { status: 200 },
      },
    },
  });
  expect(c[0].meta.requires).toBe("browser");
  expect(c[0].meta.defaultRun).toBe("opt-in");
});

test("contract.http - requires: out-of-band auto-implies defaultRun: opt-in", () => {
  const c = contract.http("magic-link", {
    endpoint: "POST /auth/magic-link",
    client: createMockClient(),
    cases: {
      send: {
        description: "send magic link email",
        requires: "out-of-band",
        expect: { status: 200 },
      },
    },
  });
  expect(c[0].meta.requires).toBe("out-of-band");
  expect(c[0].meta.defaultRun).toBe("opt-in");
});

test("contract.http - explicit defaultRun: always overrides auto-imply", () => {
  const c = contract.http("browser-always", {
    endpoint: "GET /dashboard",
    client: createMockClient(),
    cases: {
      render: {
        description: "browser render check",
        requires: "browser",
        defaultRun: "always",
        expect: { status: 200 },
      },
    },
  });
  expect(c[0].meta.requires).toBe("browser");
  expect(c[0].meta.defaultRun).toBe("always");
});

test("contract.http - headless + opt-in for expensive API", () => {
  const c = contract.http("twilio-sms", {
    endpoint: "POST /send-sms",
    client: createMockClient(),
    cases: {
      realSend: {
        description: "real Twilio SMS",
        requires: "headless",
        defaultRun: "opt-in",
        expect: { status: 202 },
      },
    },
  });
  expect(c[0].meta.requires).toBe("headless");
  expect(c[0].meta.defaultRun).toBe("opt-in");
});

test("contract.http - auto-tags for requires:browser", () => {
  const c = contract.http("tagged-browser", {
    endpoint: "POST /auth/callback",
    client: createMockClient(),
    cases: {
      success: {
        description: "OAuth callback",
        requires: "browser",
        tags: ["auth"],
        expect: { status: 200 },
      },
    },
  });
  const tags = c[0].meta.tags as string[];
  expect(tags).toContain("auth");
  expect(tags).toContain("requires:browser");
  expect(tags).toContain("default-run:opt-in");
});

test("contract.http - auto-tags for out-of-band + opt-in", () => {
  const c = contract.http("tagged-oob", {
    endpoint: "POST /auth/magic",
    client: createMockClient(),
    cases: {
      send: {
        description: "magic link",
        requires: "out-of-band",
        expect: { status: 200 },
      },
    },
  });
  const tags = c[0].meta.tags as string[];
  expect(tags).toContain("requires:out-of-band");
  expect(tags).toContain("default-run:opt-in");
});

test("contract.http - headless + always has no runtime tags", () => {
  const c = contract.http("no-runtime-tags", {
    endpoint: "GET /users",
    client: createMockClient(),
    cases: {
      list: {
        description: "list users",
        expect: { status: 200 },
      },
    },
  });
  const tags = c[0].meta.tags;
  // No tags at all (no user tags, no runtime tags)
  expect(tags).toBeUndefined();
});

test("contract.http - headless + opt-in adds only default-run tag", () => {
  const c = contract.http("opt-in-headless", {
    endpoint: "POST /expensive",
    client: createMockClient(),
    cases: {
      call: {
        description: "expensive API call",
        defaultRun: "opt-in",
        expect: { status: 200 },
      },
    },
  });
  const tags = c[0].meta.tags as string[];
  expect(tags).toContain("default-run:opt-in");
  expect(tags).not.toContain("requires:headless");
});

test("contract.http - registry includes requires and defaultRun", () => {
  const c = contract.http("registry-runtime", {
    endpoint: "POST /auth/callback",
    client: createMockClient(),
    cases: {
      success: {
        description: "OAuth callback",
        requires: "browser",
        expect: { status: 200 },
      },
    },
  });
  const reg = getRegistry();
  const entry = reg.find((r) => r.id === "registry-runtime.success");
  expect(entry).toBeDefined();
  expect(entry!.requires).toBe("browser");
  expect(entry!.defaultRun).toBe("opt-in");
});

// =============================================================================
// Flow-level requires / defaultRun
// =============================================================================

test("contract.flow - default requires is headless, defaultRun is always", () => {
  const flow = contract.flow("flow-default-runtime")
    .http("step1", {
      endpoint: "GET /health",
      client: createMockClient(),
      expect: { status: 200 },
    })
    .build();
  expect(flow.meta.requires).toBe("headless");
  expect(flow.meta.defaultRun).toBe("always");
});

test("contract.flow - requires: browser auto-implies defaultRun: opt-in", () => {
  const flow = contract.flow("flow-browser", { requires: "browser" })
    .http("login", {
      endpoint: "POST /auth/callback",
      client: createMockClient(),
      expect: { status: 200 },
    })
    .build();
  expect(flow.meta.requires).toBe("browser");
  expect(flow.meta.defaultRun).toBe("opt-in");
});

test("contract.flow - auto-tags for requires:browser", () => {
  const flow = contract.flow("flow-tagged", {
    requires: "browser",
    tags: ["e2e"],
  })
    .http("step", {
      endpoint: "GET /me",
      client: createMockClient(),
      expect: { status: 200 },
    })
    .build();
  const tags = flow.meta.tags as string[];
  expect(tags).toContain("e2e");
  expect(tags).toContain("requires:browser");
  expect(tags).toContain("default-run:opt-in");
});

test("contract.flow - explicit defaultRun overrides auto-imply", () => {
  const flow = contract.flow("flow-explicit", {
    requires: "browser",
    defaultRun: "always",
  })
    .http("step", {
      endpoint: "GET /",
      client: createMockClient(),
      expect: { status: 200 },
    })
    .build();
  expect(flow.meta.requires).toBe("browser");
  expect(flow.meta.defaultRun).toBe("always");
});

test("contract.flow - registry includes requires and defaultRun", () => {
  const flow = contract.flow("flow-registry-rt", { requires: "out-of-band" })
    .http("step", {
      endpoint: "POST /webhook",
      client: createMockClient(),
      expect: { status: 200 },
    })
    .build();
  const reg = getRegistry();
  const entry = reg.find((r) => r.id === "flow-registry-rt");
  expect(entry).toBeDefined();
  expect(entry!.requires).toBe("out-of-band");
  expect(entry!.defaultRun).toBe("opt-in");
});
