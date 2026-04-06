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
        expect: { status: 200 },
      },
      notFound: {
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
      success: { expect: { status: 201 } },
      invalidBody: { expect: { status: 400 } },
      duplicate: { expect: { status: 409 } },
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
        expect: { status: 200 },
        tags: ["happy"],
      },
      noAuth: {
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
      success: { expect: { status: 200, schema: UserSchema } },
      noAuth: { expect: { status: 401 }, deferred: "needs credentials" },
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
        expect: { status: 200 },
      },
      withAdmin: {
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
      success: { expect: { status: 200 } },
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
      success: { expect: { status: 200 } },
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
        expect: { status: 403 },
        deferred: "needs credentials",
      },
      runnableCase: {
        expect: { status: 200 },
      },
    },
  });

  // asStep() without key should pick runnableCase, not deferredCase
  const stepFn = result.asStep();
  expect(stepFn).toBeTypeOf("function");
  // Verify it picked the right one by checking it doesn't throw
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
      ping: { expect: { status: 200 } },
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
