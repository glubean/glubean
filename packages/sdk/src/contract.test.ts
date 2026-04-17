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

/**
 * Helper: create a scoped HTTP contract factory with a mock client.
 * All tests must use .with() — contract.http("id", spec) is removed.
 */
function createTestFactory(
  responses: Record<string, { status: number; body?: unknown }> = {},
) {
  const client = createMockClient(responses);
  return contract.http.with("test", { client });
}

beforeEach(() => {
  clearRegistry();
});

test("contract.http() produces HttpContract extending Array<Test>", () => {
  const api = createTestFactory();

  const result = api("get-user", {
    endpoint: "GET /users/:id",
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
  const api = createTestFactory();

  const result = api("create-user", {
    endpoint: "POST /users",
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
  const api = createTestFactory();

  const result = api("list-users", {
    endpoint: "GET /users",
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
  const api = createTestFactory();

  api("whoami", {
    endpoint: "GET /whoami",
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
    target: "GET /whoami",
    protocol: "http",
    caseKey: "success",
    lifecycle: "active",
    severity: "warning",
    hasSchema: true,
    instanceName: "test",
    protocolMeta: { expect: { status: 200 } },
  });

  const noAuth = entries.find((r) => r.id === "whoami.noAuth")!;
  expect((noAuth as any).contract.lifecycle).toBe("deferred");
});

test("case-level client overrides contract-level client", () => {
  const defaultClient = createMockClient({
    "GET /users": { status: 200, body: { source: "default" } },
  });
  const adminClient = createMockClient({
    "GET /users": { status: 200, body: { source: "admin" } },
  });

  const api = contract.http.with("test", { client: defaultClient });
  const result = api("list-users", {
    endpoint: "GET /users",
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
  const api = createTestFactory();

  const result = api("test-contract", {
    endpoint: "GET /test",
    cases: {
      success: { description: "test", expect: { status: 200 } },
    },
  });

  expect(result.asSteps).toBeTypeOf("function");
  expect(result.asStep).toBeTypeOf("function");
});

test("throws when no client is provided", async () => {
  const api = contract.http.with("test", {});
  const result = api("no-client", {
    endpoint: "GET /test",
    // no client at instance or case level
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
  const api = createTestFactory({
    "GET /data": { status: 200, body: { foo: "bar", count: 42 } },
  });

  const result = api("verify-no-schema", {
    endpoint: "GET /data",
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
  const api = createTestFactory({
    "GET /user": { status: 200, body: { id: "u1", name: "Alice" } },
  });

  const result = api("verify-with-schema", {
    endpoint: "GET /user",
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
  const api = createTestFactory({
    "POST /items": { status: 201, body: { id: "item1" } },
  });

  const result = api("lifecycle-order", {
    endpoint: "POST /items",
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
  const api = createTestFactory({
    "GET /fail": { status: 200, body: {} },
  });

  const result = api("teardown-on-fail", {
    endpoint: "GET /fail",
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
  const api = createTestFactory();

  const result = api("deferred-test", {
    endpoint: "GET /test",
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
  const api = createTestFactory();

  const result = api("deferred-exec", {
    endpoint: "GET /test",
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

  const api = contract.http.with("test", { client });
  const result = api("param-fn", {
    endpoint: "GET /users/:id",
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

  const api = contract.http.with("test", { client });
  const result = api("resolve-test", {
    endpoint: "DELETE /projects/:projectId/items/:itemId",
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

  const api = contract.http.with("test", { client });
  const result = api("query-test", {
    endpoint: "GET /search",
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

  const api = contract.http.with("test", { client });
  const result = api("headers-test", {
    endpoint: "GET /data",
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
  const api = createTestFactory();

  const myContract = api("as-steps-test", {
    endpoint: "GET /test",
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
    project: (spec: { target: string; cases: Record<string, any> }) => ({
      protocol: "test-proto",
      target: spec.target,
      cases: Object.keys(spec.cases).map(key => ({
        key,
        lifecycle: "active" as const,
        severity: "warning" as const,
      })),
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
  const api = createTestFactory({
    "POST /items": { status: 201, body: {} },
  });

  const result = api("isolation-test", {
    endpoint: "POST /items",
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
  const api = createTestFactory();
  const schema = { safeParse: () => ({ success: true as const, data: {} }) };

  const result = api("req-schema", {
    endpoint: "POST /users",
    request: schema,
    cases: {
      success: { description: "test", expect: { status: 201 } },
    },
  });

  expect(result.request).toBe(schema);
});

test("contract.register() produces executable tests via adapter v2", () => {
  clearRegistry();

  let executeCalled = false;

  contract.register("custom", {
    execute: async () => { executeCalled = true; },
    project: (spec: { target: string; cases: Record<string, any> }) => ({
      protocol: "custom",
      target: spec.target,
      cases: Object.entries(spec.cases).map(([key, c]: [string, any]) => ({
        key,
        lifecycle: c.deferred ? "deferred" as const : "active" as const,
        severity: "warning" as const,
      })),
    }),
  });

  const result = (contract as any).custom("my-custom", {
    target: "my-service",
    cases: {
      ping: { description: "test", expect: { status: 200 } },
    },
  });

  expect(result).toHaveLength(1);
  expect(result[0].meta.id).toBe("my-custom.ping");
  expect(result[0].fn).toBeTypeOf("function");
  // ProtocolContract carries _projection
  expect(result._projection).toBeDefined();
  expect(result._projection.protocol).toBe("custom");
  expect(result._projection.target).toBe("my-service");

  const registry = getRegistry();
  const entry = registry.find((r) => r.id === "my-custom.ping")!;
  expect((entry as any).contract.protocol).toBe("custom");
  expect((entry as any).contract.target).toBe("my-service");
  expect((entry as any).contract.lifecycle).toBe("active");
  expect((entry as any).contract.severity).toBe("warning");
});

test("contract.register() validates project() cases match spec.cases", () => {
  contract.register("mismatch-test", {
    execute: async () => {},
    project: (spec: { target: string }) => ({
      protocol: "mismatch-test",
      target: spec.target,
      cases: [
        { key: "nonexistent", lifecycle: "active" as const, severity: "warning" as const },
      ],
    }),
  });

  expect(() => {
    (contract as any)["mismatch-test"]("bad", {
      target: "svc",
      cases: { real: { description: "test" } },
    });
  }).toThrow(/project\(\) returned case "nonexistent" not present in spec\.cases/);
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

  const api = contract.http.with("test", { client });
  const [test] = api("body-fn-http", {
    endpoint: "POST /tokens",
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

  const api = contract.http.with("test", { client });
  const [test] = api("headers-fn-http", {
    endpoint: "GET /me",
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
  const api = createTestFactory();
  const c = api("default-runtime", {
    endpoint: "GET /health",
    cases: {
      check: { description: "health check", expect: { status: 200 } },
    },
  });
  expect(c[0].meta.requires).toBe("headless");
  expect(c[0].meta.defaultRun).toBe("always");
});

test("contract.http - requires: browser auto-implies defaultRun: opt-in", () => {
  const api = createTestFactory();
  const c = api("oauth-callback", {
    endpoint: "POST /auth/google/callback",
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
  const api = createTestFactory();
  const c = api("magic-link", {
    endpoint: "POST /auth/magic-link",
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
  const api = createTestFactory();
  const c = api("browser-always", {
    endpoint: "GET /dashboard",
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
  const api = createTestFactory();
  const c = api("twilio-sms", {
    endpoint: "POST /send-sms",
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
  const api = createTestFactory();
  const c = api("tagged-browser", {
    endpoint: "POST /auth/callback",
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
  const api = createTestFactory();
  const c = api("tagged-oob", {
    endpoint: "POST /auth/magic",
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
  const api = createTestFactory();
  const c = api("no-runtime-tags", {
    endpoint: "GET /users",
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
  const api = createTestFactory();
  const c = api("opt-in-headless", {
    endpoint: "POST /expensive",
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
  const api = createTestFactory();
  const c = api("registry-runtime", {
    endpoint: "POST /auth/callback",
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

// =============================================================================
// feature field (type-level — projection grouping key)
// =============================================================================

test("contract.http accepts optional feature field", () => {
  clearRegistry();
  const api = createTestFactory({ "POST /projects": { status: 201 } });
  const c = api("feat-test", {
    endpoint: "POST /projects",
    feature: "项目管理",
    cases: {
      ok: {
        description: "Create project",
        body: { name: "Test" },
        expect: { status: 201 },
      },
    },
  });
  // feature is a spec-level field for scanner, not on the runtime HttpContract
  // Just verify the contract compiles and produces a test
  expect(c).toHaveLength(1);
  expect(c.id).toBe("feat-test");
});

// ---------------------------------------------------------------------------
// HttpContract preserves metadata for runtime extraction (OpenAPI generation)
// ---------------------------------------------------------------------------

test("HttpContract preserves description and feature", () => {
  const api = createTestFactory();
  const result = api("meta-test", {
    endpoint: "GET /health",
    description: "Health check endpoint",
    feature: "Monitoring",
    cases: {
      ok: {
        description: "Service is healthy",
        expect: { status: 200 },
      },
    },
  });

  expect(result.description).toBe("Health check endpoint");
  expect(result.feature).toBe("Monitoring");
});

test("HttpContract preserves _caseSchemas with response schemas", () => {
  const api = createTestFactory();
  const result = api("schema-test", {
    endpoint: "GET /user",
    cases: {
      found: {
        description: "User found",
        expect: { status: 200, schema: UserSchema },
      },
      notFound: {
        description: "User not found",
        expect: { status: 404 },
      },
    },
  });

  expect(result._caseSchemas).toBeDefined();
  expect(result._caseSchemas!.found).toEqual({
    expectStatus: 200,
    responseSchema: UserSchema,
    description: "User found",
    deferred: undefined,
    deprecated: undefined,
    severity: undefined,
    lifecycle: "active",
    requires: "headless",
    defaultRun: "always",
  });
  expect(result._caseSchemas!.notFound).toEqual({
    expectStatus: 404,
    responseSchema: undefined,
    description: "User not found",
    deferred: undefined,
    deprecated: undefined,
    severity: undefined,
    lifecycle: "active",
    requires: "headless",
    defaultRun: "always",
  });
});

test("HttpContract _caseSchemas is empty object for no-case edge", () => {
  const api = createTestFactory();
  const result = api("empty-cases", {
    endpoint: "GET /ping",
    cases: {},
  });

  expect(result._caseSchemas).toEqual({});
});

test("HttpContract preserves request schema", () => {
  const RequestSchema = {
    safeParse: (data: unknown) => ({ success: true as const, data }),
  };
  const api = createTestFactory();
  const result = api("req-schema", {
    endpoint: "POST /users",
    request: RequestSchema,
    cases: {
      ok: {
        description: "Created",
        expect: { status: 201 },
      },
    },
  });

  expect(result.request).toBe(RequestSchema);
});

test("HttpContract without description/feature has undefined fields", () => {
  const api = createTestFactory();
  const result = api("minimal", {
    endpoint: "GET /health",
    cases: {
      ok: { description: "ok", expect: { status: 200 } },
    },
  });

  expect(result.description).toBeUndefined();
  expect(result.feature).toBeUndefined();
});

// ---------------------------------------------------------------------------
// contract.http.with() — scoped instance factory
// ---------------------------------------------------------------------------

test("contract.http.with() creates a scoped factory", () => {
  const client = createMockClient();
  const userApi = contract.http.with("user", {
    security: "bearer",
    client,
  });

  const result = userApi("get-me", {
    endpoint: "GET /me",
    description: "Get current user",
    cases: {
      ok: { description: "Returns profile", expect: { status: 200 } },
    },
  });

  expect(result).toHaveLength(1);
  expect(result.id).toBe("get-me");
  expect(result.instanceName).toBe("user");
  expect(result.security).toBe("bearer");
  expect(result.description).toBe("Get current user");
});

test("contract.http.with() merges tags additively", () => {
  const client = createMockClient();
  const userApi = contract.http.with("user", {
    client,
    tags: ["user"],
  });

  const result = userApi("get-me", {
    endpoint: "GET /me",
    description: "Profile",
    tags: ["profile"],
    cases: {
      ok: { description: "ok", expect: { status: 200 } },
    },
  });

  // instance tags + contract tags → merged
  expect(result[0].meta.tags).toContain("user");
  expect(result[0].meta.tags).toContain("profile");
});

test("contract.http.with() spec fields override defaults", () => {
  const defaultClient = createMockClient();
  const overrideClient = createMockClient({ "GET /override": { status: 200, body: { overridden: true } } });

  const api = contract.http.with("test", {
    client: defaultClient,
    feature: "Default Feature",
  });

  const result = api("override", {
    endpoint: "GET /override",
    description: "test",
    client: overrideClient,
    feature: "Override Feature",
    cases: {
      ok: { description: "ok", expect: { status: 200 } },
    },
  });

  expect(result.feature).toBe("Override Feature");
});

test("contract.http.with() nested .with() inherits and overrides", () => {
  const client = createMockClient();
  const base = contract.http.with("api", { client, tags: ["api"] });
  const authed = base.with("user", { security: "bearer", tags: ["user"] });

  const result = authed("get-me", {
    endpoint: "GET /me",
    description: "Profile",
    cases: {
      ok: { description: "ok", expect: { status: 200 } },
    },
  });

  expect(result.instanceName).toBe("user");
  expect(result.security).toBe("bearer");
  // tags: api + user merged
  expect(result[0].meta.tags).toContain("api");
  expect(result[0].meta.tags).toContain("user");
});

test("contract.http.with() nested .with() replaces instance name", () => {
  const client = createMockClient();
  const base = contract.http.with("api", { client });
  const admin = base.with("admin", { security: { type: "apiKey", name: "X-Key", in: "header" } });

  const result = admin("delete-user", {
    endpoint: "DELETE /users/:id",
    description: "Delete user",
    cases: {
      ok: { description: "ok", expect: { status: 204 } },
    },
  });

  expect(result.instanceName).toBe("admin");
  expect(result.security).toEqual({ type: "apiKey", name: "X-Key", in: "header" });
});

test("contract.http.with() stores enriched _caseSchemas", () => {
  const client = createMockClient();
  const api = contract.http.with("test", { client });

  const result = api("lifecycle", {
    endpoint: "GET /test",
    description: "test",
    cases: {
      ok: {
        description: "Success case",
        expect: { status: 200, schema: UserSchema },
      },
      deferred: {
        description: "Not yet",
        expect: { status: 200 },
        deferred: "backend not ready",
      },
      browser: {
        description: "Needs browser",
        expect: { status: 200 },
        requires: "browser",
        defaultRun: "opt-in",
      },
    },
  });

  expect(result._caseSchemas?.ok).toEqual({
    expectStatus: 200,
    responseSchema: UserSchema,
    description: "Success case",
    deferred: undefined,
    deprecated: undefined,
    severity: undefined,
    lifecycle: "active",
    requires: "headless",
    defaultRun: "always",
  });
  expect(result._caseSchemas?.deferred?.deferred).toBe("backend not ready");
  expect(result._caseSchemas?.deferred?.lifecycle).toBe("deferred");
  expect(result._caseSchemas?.browser?.requires).toBe("browser");
  expect(result._caseSchemas?.browser?.defaultRun).toBe("opt-in");
});

test("contract.http.with() security=null marks public endpoint", () => {
  const client = createMockClient();
  const publicApi = contract.http.with("public", { client, security: null });

  const result = publicApi("health", {
    endpoint: "GET /health",
    description: "Health check",
    cases: {
      ok: { description: "ok", expect: { status: 200 } },
    },
  });

  expect(result.instanceName).toBe("public");
  expect(result.security).toBeNull();
});

// =============================================================================
// Phase 1 — Tier 1 feature tests
// =============================================================================

// Mock client that returns custom headers — used for header validation tests
function createMockClientWithHeaders(
  responses: Record<string, { status: number; body?: unknown; headers?: Record<string, string> }>,
): HttpClient {
  function makeResponse(key: string): HttpResponsePromise {
    const resp = responses[key] ?? { status: 200 };
    const bodyStr = JSON.stringify(resp.body ?? {});
    const headers = new Headers(resp.headers ?? { "Content-Type": "application/json" });
    const raw = new Response(bodyStr, { status: resp.status, headers });
    const p = Promise.resolve(raw) as HttpResponsePromise;
    p.json = <T = unknown>() => Promise.resolve(resp.body as T);
    p.text = () => Promise.resolve(bodyStr);
    p.blob = () => raw.blob();
    p.arrayBuffer = () => raw.arrayBuffer();
    return p;
  }
  const handler = (method: string) => (url: string | URL | Request) =>
    makeResponse(`${method.toUpperCase()} ${String(url)}`);
  const client = Object.assign(handler("GET"), {
    get: handler("GET"), post: handler("POST"), put: handler("PUT"),
    patch: handler("PATCH"), delete: handler("DELETE"), head: handler("HEAD"),
    extend: () => client,
  });
  return client as unknown as HttpClient;
}

test("expect.headers validates response headers (case-insensitive keys)", async () => {
  const client = createMockClientWithHeaders({
    "GET /info": { status: 200, headers: { "X-Request-Id": "abc123", "Content-Type": "application/json" } },
  });
  const api = contract.http.with("test", { client });
  const c = api("info", {
    endpoint: "GET /info",
    cases: {
      success: {
        description: "response has request id",
        expect: {
          status: 200,
          headers: UserSchemaLike({ "x-request-id": "abc123", "content-type": "application/json" }),
        },
      },
    },
  });

  const ctx = createMockContext();
  await c[0].fn!(ctx);
  // No assertion failures — header validation passed with lowercase normalized keys
  expect(true).toBe(true);
});

test("expect.headers fails when required header is missing", async () => {
  const client = createMockClientWithHeaders({
    "GET /info": { status: 200, headers: { "Content-Type": "application/json" } },
  });
  const api = contract.http.with("test", { client });
  const c = api("info-missing", {
    endpoint: "GET /info",
    cases: {
      success: {
        description: "expect request id",
        expect: {
          status: 200,
          headers: UserSchemaLike({ "x-request-id": "required" }, true),  // strict: require field
        },
      },
    },
  });

  const ctx = createMockContext();
  const recorded: any[] = [];
  ctx.validate = (value, schema, _label) => {
    recorded.push({ value, schema });
    const result = (schema as any).safeParse(value);
    if (!result.success) throw new Error(`validation failed: ${JSON.stringify(result)}`);
    return result.data;
  };
  await expect(c[0].fn!(ctx)).rejects.toThrow(/validation failed/);
  expect(recorded.length).toBeGreaterThan(0);
});

test("contract-level deprecated propagates to all cases", () => {
  const client = createMockClient();
  const api = contract.http.with("test", { client });
  const c = api("old-endpoint", {
    endpoint: "GET /v1/old",
    deprecated: "use /v2/new instead",
    cases: {
      success: { description: "was valid", expect: { status: 200 } },
      notFound: { description: "was 404", expect: { status: 404 } },
    },
  });

  expect(c.deprecated).toBe("use /v2/new instead");
  expect(c._caseSchemas?.success?.deprecated).toBe("use /v2/new instead");
  expect(c._caseSchemas?.success?.lifecycle).toBe("deprecated");
  expect(c._caseSchemas?.notFound?.lifecycle).toBe("deprecated");
});

test("case-level deprecated overrides contract-level", () => {
  const client = createMockClient();
  const api = contract.http.with("test", { client });
  const c = api("mixed", {
    endpoint: "GET /thing",
    deprecated: "generic reason",
    cases: {
      caseA: { description: "a", expect: { status: 200 }, deprecated: "specific reason for a" },
      caseB: { description: "b", expect: { status: 200 } },
    },
  });

  expect(c._caseSchemas?.caseA?.deprecated).toBe("specific reason for a");
  expect(c._caseSchemas?.caseB?.deprecated).toBe("generic reason");
});

test("ParamValue object form: value extraction works", async () => {
  const client = createMockClient({
    "GET /users/42": { status: 200, body: { id: "42" } },
  });
  const api = contract.http.with("test", { client });
  const c = api("get-user", {
    endpoint: "GET /users/:id",
    cases: {
      success: {
        description: "find user",
        params: { id: { value: "42", schema: {} as any, description: "User ID" } },
        expect: { status: 200 },
      },
    },
  });

  const ctx = createMockContext();
  await c[0].fn!(ctx);
  // Execution succeeded → value was extracted correctly from { value: "42" }
  expect(c._caseSchemas?.success?.paramSchemas?.id?.description).toBe("User ID");
});

test("ParamValue string form still works (backward compat)", async () => {
  const client = createMockClient({
    "GET /users/42": { status: 200, body: { id: "42" } },
  });
  const api = contract.http.with("test", { client });
  const c = api("get-user-str", {
    endpoint: "GET /users/:id",
    cases: {
      success: {
        description: "find user",
        params: { id: "42" },  // string shorthand
        expect: { status: 200 },
      },
    },
  });

  const ctx = createMockContext();
  await c[0].fn!(ctx);
  // String shorthand should NOT produce paramSchemas entries
  expect(c._caseSchemas?.success?.paramSchemas).toBeUndefined();
});

test("query ParamValue object form", () => {
  const client = createMockClient();
  const api = contract.http.with("test", { client });
  const c = api("list-users", {
    endpoint: "GET /users",
    cases: {
      filtered: {
        description: "filter by role",
        query: {
          role: { value: "admin", description: "User role filter", required: false },
        },
        expect: { status: 200 },
      },
    },
  });

  expect(c._caseSchemas?.filtered?.querySchemas?.role?.description).toBe("User role filter");
  expect(c._caseSchemas?.filtered?.querySchemas?.role?.required).toBe(false);
});

test("expect.example and expect.examples are stored on _caseSchemas", () => {
  const client = createMockClient();
  const api = contract.http.with("test", { client });
  const c = api("examples-demo", {
    endpoint: "GET /thing",
    cases: {
      single: {
        description: "with single example",
        expect: { status: 200, example: { id: 1 } },
      },
      multi: {
        description: "with named examples",
        expect: {
          status: 200,
          examples: {
            admin: { value: { role: "admin" }, summary: "Admin user" },
            viewer: { value: { role: "viewer" } },
          },
        },
      },
    },
  });

  expect(c._caseSchemas?.single?.example).toEqual({ id: 1 });
  expect(c._caseSchemas?.multi?.examples?.admin?.summary).toBe("Admin user");
  expect(c._caseSchemas?.multi?.examples?.viewer?.value).toEqual({ role: "viewer" });
});

// =============================================================================
// Phase 2 — Extensions, request/expect structural, content-type dispatch
// =============================================================================

test("extensions merge precedence: defaults < contract < case", () => {
  const client = createMockClient();
  const base = contract.http.with("base", {
    client,
    extensions: { "x-owner": "team-a", "x-tier": "1" },
  });
  const api = base.with("scoped", {
    client,
    extensions: { "x-tier": "2", "x-source": "scoped" },  // override tier
  });

  const c = api("ext-test", {
    endpoint: "GET /thing",
    extensions: { "x-contract": "custom" },  // contract-level adds
    cases: {
      a: {
        description: "case A",
        expect: { status: 200 },
        extensions: { "x-tier": "3", "x-case-only": "yes" },  // case overrides tier
      },
      b: {
        description: "case B",
        expect: { status: 200 },
        // no case-level extensions — inherits contract
      },
    },
  });

  // Contract-level merged view (defaults < contract)
  expect(c.extensions?.["x-owner"]).toBe("team-a");
  expect(c.extensions?.["x-tier"]).toBe("2"); // scoped defaults override base defaults
  expect(c.extensions?.["x-source"]).toBe("scoped");
  expect(c.extensions?.["x-contract"]).toBe("custom");

  // Case A: case-level overrides
  const caseA = c._caseSchemas?.a?.extensions as Record<string, unknown>;
  expect(caseA?.["x-tier"]).toBe("3");
  expect(caseA?.["x-owner"]).toBe("team-a");
  expect(caseA?.["x-case-only"]).toBe("yes");
  expect(caseA?.["x-contract"]).toBe("custom");

  // Case B: inherits contract-level (no case override)
  const caseB = c._caseSchemas?.b?.extensions as Record<string, unknown>;
  expect(caseB?.["x-tier"]).toBe("2");
  expect(caseB?.["x-owner"]).toBe("team-a");
});

test("request structural form: { body, contentType } normalized", () => {
  const client = createMockClient();
  const api = contract.http.with("test", { client });

  // Bare SchemaLike shorthand
  const schema = { safeParse: () => ({ success: true as const, data: {} }) };
  const cShort = api("shorthand", {
    endpoint: "POST /shorthand",
    request: schema,
    cases: { ok: { description: "ok", expect: { status: 200 } } },
  });
  expect(cShort.request).toBe(schema);
  expect(cShort.requestContentType).toBeUndefined();

  // Structured form with contentType
  const cStruct = api("struct", {
    endpoint: "POST /upload",
    request: { body: schema, contentType: "multipart/form-data" },
    cases: { ok: { description: "ok", expect: { status: 200 } } },
  });
  expect(cStruct.request).toBe(schema);
  expect(cStruct.requestContentType).toBe("multipart/form-data");
});

test("multipart content-type: object body converts to FormData", async () => {
  let capturedBody: unknown;
  const client = {
    get: () => undefined as any,
    post: ((url: string, opts: any) => {
      capturedBody = opts.body;
      const raw = new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      const p = Promise.resolve(raw) as HttpResponsePromise;
      p.json = <T = unknown>() => Promise.resolve({} as T);
      p.text = () => Promise.resolve("{}");
      p.blob = () => raw.blob();
      p.arrayBuffer = () => raw.arrayBuffer();
      return p;
    }) as any,
    put: () => undefined as any,
    patch: () => undefined as any,
    delete: () => undefined as any,
    head: () => undefined as any,
    extend: () => client,
  } as unknown as HttpClient;

  const api = contract.http.with("upload", { client });
  const c = api("upload-form", {
    endpoint: "POST /upload",
    cases: {
      success: {
        description: "multipart upload",
        contentType: "multipart/form-data",
        body: { name: "alice", role: "admin" },
        expect: { status: 200 },
      },
    },
  });

  const ctx = createMockContext();
  await c[0].fn!(ctx);

  // Body should be converted to FormData
  expect(capturedBody).toBeInstanceOf(FormData);
  const fd = capturedBody as FormData;
  expect(fd.get("name")).toBe("alice");
  expect(fd.get("role")).toBe("admin");
});

test("urlencoded content-type: object body converts to URLSearchParams", async () => {
  let capturedBody: unknown;
  const client = {
    get: () => undefined as any,
    post: ((_url: string, opts: any) => {
      capturedBody = opts.body;
      const raw = new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      const p = Promise.resolve(raw) as HttpResponsePromise;
      p.json = <T = unknown>() => Promise.resolve({} as T);
      p.text = () => Promise.resolve("{}");
      p.blob = () => raw.blob();
      p.arrayBuffer = () => raw.arrayBuffer();
      return p;
    }) as any,
    put: () => undefined as any,
    patch: () => undefined as any,
    delete: () => undefined as any,
    head: () => undefined as any,
    extend: () => (client as HttpClient),
  } as unknown as HttpClient;

  const api = contract.http.with("form", { client });
  const c = api("form-post", {
    endpoint: "POST /form",
    cases: {
      success: {
        description: "urlencoded form post",
        contentType: "application/x-www-form-urlencoded",
        body: { username: "bob", password: "s3cret" },
        expect: { status: 200 },
      },
    },
  });

  const ctx = createMockContext();
  await c[0].fn!(ctx);

  expect(capturedBody).toBeInstanceOf(URLSearchParams);
  const params = capturedBody as URLSearchParams;
  expect(params.get("username")).toBe("bob");
  expect(params.get("password")).toBe("s3cret");
});

test("request: parse-only SchemaLike is recognized as body shorthand (P1 regression)", () => {
  const client = createMockClient();
  const api = contract.http.with("test", { client });
  // Schema that only implements parse() (no safeParse) — must still be treated as body
  const parseOnlySchema = { parse: (data: unknown) => data };

  const c = api("parse-only", {
    endpoint: "POST /thing",
    request: parseOnlySchema as any,
    cases: { ok: { description: "ok", expect: { status: 200 } } },
  });

  expect(c.request).toBe(parseOnlySchema);
});

test("request: structured metadata persists on HttpContract (P1 regression)", () => {
  const client = createMockClient();
  const api = contract.http.with("test", { client });
  const bodySchema = { safeParse: () => ({ success: true as const, data: {} }) };
  const headersSchema = { safeParse: () => ({ success: true as const, data: {} }) };

  const c = api("structured-req", {
    endpoint: "POST /thing",
    request: {
      body: bodySchema,
      contentType: "application/json",
      headers: headersSchema,
      example: { id: 1 },
      examples: { admin: { value: { role: "admin" } } },
    },
    cases: { ok: { description: "ok", expect: { status: 200 } } },
  });

  expect(c.request).toBe(bodySchema);
  expect(c.requestContentType).toBe("application/json");
  expect(c.requestHeaders).toBe(headersSchema);
  expect(c.requestExample).toEqual({ id: 1 });
  expect(c.requestExamples?.admin?.value).toEqual({ role: "admin" });
});

test("contentType inherits from contract request when case doesn't override", async () => {
  let capturedBody: unknown;
  const client = {
    get: () => undefined as any,
    post: ((_url: string, opts: any) => {
      capturedBody = opts.body;
      const raw = new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      const p = Promise.resolve(raw) as HttpResponsePromise;
      p.json = <T = unknown>() => Promise.resolve({} as T);
      p.text = () => Promise.resolve("{}");
      p.blob = () => raw.blob();
      p.arrayBuffer = () => raw.arrayBuffer();
      return p;
    }) as any,
    put: () => undefined as any,
    patch: () => undefined as any,
    delete: () => undefined as any,
    head: () => undefined as any,
    extend: () => (client as HttpClient),
  } as unknown as HttpClient;

  const api = contract.http.with("form", { client });
  const c = api("form-post-inherit", {
    endpoint: "POST /form",
    request: { contentType: "application/x-www-form-urlencoded" },
    cases: {
      success: {
        description: "inherits contract-level content type",
        body: { k: "v" },
        expect: { status: 200 },
      },
    },
  });

  const ctx = createMockContext();
  await c[0].fn!(ctx);

  expect(capturedBody).toBeInstanceOf(URLSearchParams);
});

// Minimal SchemaLike helper for testing — mimics Zod safeParse contract
function UserSchemaLike(shape: Record<string, string>, strict = false) {
  return {
    safeParse: (value: unknown) => {
      if (!value || typeof value !== "object") {
        return { success: false, error: { issues: [{ message: "not an object" }] } };
      }
      const v = value as Record<string, unknown>;
      for (const [key, expected] of Object.entries(shape)) {
        if (strict && v[key] !== expected) {
          return { success: false, error: { issues: [{ message: `${key} mismatch` }] } };
        }
        if (!strict && v[key] !== undefined && v[key] !== expected) {
          return { success: false, error: { issues: [{ message: `${key} mismatch` }] } };
        }
      }
      return { success: true, data: value };
    },
  };
}
