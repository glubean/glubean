/**
 * Tests for the built-in HTTP adapter.
 *
 * Scope: authoring (contract.http.with), projection / normalize, case
 * execution, executeCaseInFlow (deep-merge + Rule 1 teardown), function-
 * field fail-fast, classifyFailure mapping.
 *
 * Uses a mock HttpClient that records calls and returns canned responses.
 */

import { test, expect, beforeEach } from "vitest";
// Import from main index so the HTTP adapter side-effect registration fires.
import { contract, runFlow } from "../index.js";
import type {
  FlowContract,
  ProtocolContract,
} from "../contract-types.js";
import type {
  HttpContractSpec,
  HttpPayloadSchemas,
  HttpContractMeta,
} from "./types.js";
import type {
  HttpClient,
  HttpResponsePromise,
  TestContext,
} from "../types.js";
import { clearRegistry } from "../internal.js";
import { clearBootstrapRegistry } from "../bootstrap-registry.js";
import { Expectation } from "../expect.js";

// ---------------------------------------------------------------------------
// Mock HTTP client
// ---------------------------------------------------------------------------

interface MockCall {
  method: string;
  url: string;
  options: Record<string, unknown>;
}

function makeMockClient(
  canned: { status?: number; body?: unknown; headers?: Record<string, string> } = {},
): HttpClient & { _calls: MockCall[] } {
  const calls: MockCall[] = [];
  const respond = (method: string) =>
    (url: string | URL | Request, opts?: Record<string, unknown>) => {
      calls.push({ method, url: String(url), options: opts ?? {} });
      const headers = new Headers(canned.headers ?? {});
      const json = async () => canned.body ?? {};
      const promise = Promise.resolve({
        ok: (canned.status ?? 200) < 400,
        status: canned.status ?? 200,
        statusText: "OK",
        headers,
        json,
      });
      return Object.assign(promise, { json }) as unknown as HttpResponsePromise;
    };

  const client: any = respond("get");
  client.get = respond("get");
  client.post = respond("post");
  client.put = respond("put");
  client.patch = respond("patch");
  client.delete = respond("delete");
  client.head = respond("head");
  client.extend = () => client;
  client._calls = calls;
  return client as HttpClient & { _calls: MockCall[] };
}

function makeCtx(partial: Partial<TestContext> = {}): TestContext {
  return {
    vars: { get: () => undefined, require: () => { throw new Error(); }, all: () => ({}) } as any,
    secrets: { get: () => undefined, require: () => { throw new Error(); } } as any,
    log: () => {},
    assert: () => {},
    trace: () => {},
    action: () => {},
    event: () => {},
    metric: () => {},
    http: {} as any,
    fetch: {} as any,
    expect: (<V>(actual: V) =>
      new Expectation(actual, (emission) => {
        if (!emission.passed) {
          throw new Error(emission.message ?? "assertion failed");
        }
      })) as any,
    validate: ((v: unknown) => v) as any,
    skip: () => { throw new Error("skipped"); },
    ci: {} as any,
    session: { get: () => undefined, set: () => {}, require: () => { throw new Error(); }, has: () => false, entries: () => ({}) } as any,
    run: {} as any,
    getMemoryUsage: () => null,
    ...partial,
  } as TestContext;
}

beforeEach(() => {
  clearRegistry();
  clearBootstrapRegistry();
});

// ---------------------------------------------------------------------------
// Authoring: contract.http.with() → ProtocolContract
// ---------------------------------------------------------------------------

test("contract.http direct call without .with() throws", () => {
  expect(() =>
    (contract as any).http("c", {
      endpoint: "GET /x",
      cases: { ok: { description: "x", expect: { status: 200 } } },
    }),
  ).toThrow(/use contract\.http\.with/i);
});

test("contract.http.with() returns a callable scoped factory", () => {
  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  expect(typeof api).toBe("function");
  expect(typeof api.with).toBe("function");
});

test("scoped factory produces ProtocolContract with _projection + _spec", () => {
  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  const c = api("create-user", {
    endpoint: "POST /users",
    cases: {
      ok: {
        description: "happy path",
        expect: { status: 201 },
        body: { name: "Alice" },
      },
    },
  }) as ProtocolContract<HttpContractSpec, HttpPayloadSchemas, HttpContractMeta>;

  expect(Array.isArray(c)).toBe(true);
  expect(c.length).toBe(1);
  expect(c._projection.id).toBe("create-user");
  expect(c._projection.protocol).toBe("http");
  expect(c._projection.target).toBe("POST /users");
  expect(c._projection.instanceName).toBe("api");
  expect(c._spec.endpoint).toBe("POST /users");
  expect(c._spec.cases.ok.expect.status).toBe(201);
});

// ---------------------------------------------------------------------------
// Case execution (standalone)
// ---------------------------------------------------------------------------

test("case execution sends HTTP request and asserts status", async () => {
  const client = makeMockClient({ status: 201, body: { id: "u1" } });
  const api = contract.http.with("api", { client });
  const c = api("c", {
    endpoint: "POST /users",
    cases: {
      ok: {
        description: "create",
        expect: { status: 201 },
        body: { name: "Alice" },
      },
    },
  });

  await c[0].fn!(makeCtx());
  expect(client._calls.length).toBe(1);
  expect(client._calls[0].method).toBe("post");
  expect(client._calls[0].options.json).toEqual({ name: "Alice" });
});

// ---------------------------------------------------------------------------
// v10 attachment model migration note
// ---------------------------------------------------------------------------
// Tests for standalone case-level `setup`/`teardown` lifecycle lived here
// before v10. That lifecycle is going away (attachment model §4.1 — contract
// case has no lifecycle; use contract.bootstrap overlay with ctx.cleanup).
// Equivalent coverage now lives in contract.test.ts using the mock adapter:
//   - "dispatcher routes through adapter.executeCase when bootstrap overlay registered"
//   - "bootstrap ctx.cleanup callbacks run LIFO after case execution"
//   - "bootstrap cleanup runs even when executeCase throws"
// The HTTP-specific flavor added no coverage beyond what the mock path proves,
// so these two tests are removed. Flow-mode setup/teardown (further down in
// this file) is retained until Phase 2d migrates flow to logical-input
// semantics and case-level lifecycle is removed from the HTTP type as well.

test("standalone case without setup/teardown runs cleanly (v10 baseline)", async () => {
  const client = makeMockClient({ status: 200 });
  const api = contract.http.with("api", { client });
  const c = api("c", {
    endpoint: "GET /x",
    cases: { ok: { description: "v10 baseline", expect: { status: 200 } } },
  });
  await c[0].fn!(makeCtx());
  expect(client._calls.length).toBe(1);
});

test("v10 overlay: bootstrap resolvedInput drives real HTTP request construction", async () => {
  // End-to-end HTTP overlay test. Proves bootstrap output flows through
  // httpAdapter.executeCase → executeStandaloneCase → function-valued
  // params/headers/body → outgoing request construction. Mock-adapter
  // tests cover routing; this test covers HTTP-specific construction.
  //
  // Implementation note: HTTP's `validateCaseForFlow` (which fires from
  // ProtocolContract.case()) rejects function-valued body/params/headers
  // as a v9 flow-safety rule. v10 overlay dispatch legitimately uses
  // these with resolvedInput, but the validator doesn't yet distinguish
  // "used in flow" from "used via overlay". Relaxing the validator is
  // Phase 2d scope (flow migration). Until then, this test bypasses
  // `.case()` and registers the overlay directly via registerBootstrap.
  const { registerBootstrap } = await import("../bootstrap-registry.js");

  const client = makeMockClient({ status: 200, body: { ok: true } });
  const api = contract.http.with("api", { client });

  const c = api("orders.create", {
    endpoint: "POST /projects/:projectId/orders",
    cases: {
      success: {
        description: "create order under project",
        params: ({ projectId }: any) => ({ projectId }),
        body: ({ items }: any) => ({ items }),
        headers: ({ token }: any) => ({ Authorization: `Bearer ${token}` }),
        expect: { status: 200 },
      },
    },
  });

  // Register overlay directly (bypasses .case()'s function-field validator).
  registerBootstrap(
    {
      __glubean_type: "contract-case-ref",
      contractId: "orders.create",
      caseKey: "success",
      protocol: "http",
      target: "POST /projects/:projectId/orders",
      contract: c as any,
    } as any,
    (async () => ({
      projectId: "p_42",
      token: "tok-abc",
      items: [{ sku: "X", qty: 1 }],
    })) as any,
  );

  await c[0].fn!(makeCtx());

  expect(client._calls.length).toBe(1);
  const call = client._calls[0];
  expect(call.method).toBe("post");
  expect(call.url).toBe("/projects/p_42/orders");                      // :projectId resolved
  expect(call.options.json).toEqual({ items: [{ sku: "X", qty: 1 }] }); // body from bootstrap
  expect(call.options.headers).toEqual({ Authorization: "Bearer tok-abc" }); // headers from bootstrap
});

// ---------------------------------------------------------------------------
// .case() fail-fast for function-valued inputs
// ---------------------------------------------------------------------------

test(".case() rejects function-valued body (fail-fast for flow)", () => {
  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  const c = api("c", {
    endpoint: "POST /x",
    cases: {
      ok: {
        description: "x",
        expect: { status: 200 },
        body: (s: any) => ({ v: s.x }),
      },
    },
  });

  expect(() => c.case("ok")).toThrow(/function-valued field/);
});

test(".case() succeeds for static-input cases", () => {
  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  const c = api("c", {
    endpoint: "GET /x/:id",
    cases: {
      ok: {
        description: "x",
        expect: { status: 200 },
        params: { id: "42" },
      },
    },
  });

  const ref = c.case("ok");
  expect(ref.__glubean_type).toBe("contract-case-ref");
  expect(ref.caseKey).toBe("ok");
  expect(ref.protocol).toBe("http");
});

// ---------------------------------------------------------------------------
// executeCaseInFlow: deep-merge + Rule 1 teardown
// ---------------------------------------------------------------------------

test("flow step deep-merges lens inputs over case static body", async () => {
  const client = makeMockClient({ status: 200, body: { id: "u1" } });
  const api = contract.http.with("api", { client });
  const c = api("create", {
    endpoint: "POST /users",
    cases: {
      ok: {
        description: "create",
        expect: { status: 200 },
        // Static body with role & source; flow will patch email onto this
        body: { role: "admin", source: "web" },
      },
    },
  });

  const flowObj = contract
    .flow("f")
    .setup(async () => ({ email: "alice@test" }))
    .step(c.case("ok"), {
      in: (s: any) => ({ body: { email: s.email } }),
    })
    .build() as FlowContract<unknown>;

  await runFlow(flowObj, makeCtx());

  const call = client._calls[0];
  expect(call.options.json).toEqual({
    role: "admin",
    source: "web",
    email: "alice@test",
  });
});

test("flow step returns adapter CaseOutput shape for out lens", async () => {
  const client = makeMockClient({
    status: 201,
    body: { id: "u1", name: "Alice" },
  });
  const api = contract.http.with("api", { client });
  const c = api("create", {
    endpoint: "POST /users",
    cases: {
      ok: {
        description: "create",
        expect: { status: 201 },
        body: { name: "Alice" },
      },
    },
  });

  let outState: any;
  const flowObj = contract
    .flow("f")
    .setup(async () => ({}))
    .step(c.case("ok"), {
      out: (s: any, res: any) => {
        outState = { status: res.status, id: res.body?.id };
        return outState;
      },
    })
    .build() as FlowContract<unknown>;

  await runFlow(flowObj, makeCtx());
  expect(outState).toEqual({ status: 201, id: "u1" });
});

test("Rule 1: case teardown runs when setup returns undefined (not gated on state value)", async () => {
  const client = makeMockClient({ status: 200 });
  const api = contract.http.with("api", { client });
  const order: string[] = [];
  const c = api("c", {
    endpoint: "POST /x",
    cases: {
      ok: {
        description: "x",
        expect: { status: 200 },
        body: {},
        // setup returns undefined legitimately — still owes a teardown
        setup: async () => { order.push("setup"); return undefined as any; },
        teardown: async () => { order.push("teardown"); },
      },
    },
  });

  const flowObj = contract
    .flow("f")
    .step(c.case("ok"))
    .build() as FlowContract<unknown>;

  await runFlow(flowObj, makeCtx());
  expect(order).toEqual(["setup", "teardown"]);
});

test("Rule 1: case teardown does NOT run when setup itself throws", async () => {
  const client = makeMockClient({ status: 200 });
  const api = contract.http.with("api", { client });
  const order: string[] = [];
  const c = api("c", {
    endpoint: "POST /x",
    cases: {
      ok: {
        description: "x",
        expect: { status: 200 },
        body: {},
        setup: async () => { order.push("setup"); throw new Error("setup fail"); },
        teardown: async () => { order.push("teardown"); },
      },
    },
  });

  const flowObj = contract
    .flow("f")
    .step(c.case("ok"))
    .build() as FlowContract<unknown>;

  await expect(runFlow(flowObj, makeCtx())).rejects.toThrow("setup fail");
  expect(order).toEqual(["setup"]);
});

test("Rule 1: case teardown runs even if flow step request throws", async () => {
  const client = makeMockClient({ status: 500 }); // will fail status assertion
  const api = contract.http.with("api", { client });
  const order: string[] = [];
  const c = api("create", {
    endpoint: "POST /x",
    cases: {
      ok: {
        description: "x",
        expect: { status: 200 },
        body: {},
        setup: async () => { order.push("setup"); return {}; },
        teardown: async () => { order.push("teardown"); },
      },
    },
  });

  const flowObj = contract
    .flow("f")
    .step(c.case("ok"))
    .build() as FlowContract<unknown>;

  await expect(runFlow(flowObj, makeCtx())).rejects.toThrow();
  expect(order).toEqual(["setup", "teardown"]);
});

// ---------------------------------------------------------------------------
// projection + normalize
// ---------------------------------------------------------------------------

test("projection captures endpoint, method, cases, and meta", () => {
  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  const c = api("fetch-user", {
    endpoint: "GET /users/:id",
    description: "fetch a user",
    cases: {
      ok: {
        description: "happy",
        expect: { status: 200 },
      },
      notFound: {
        description: "missing",
        expect: { status: 404 },
      },
    },
  });

  expect(c._projection.protocol).toBe("http");
  expect(c._projection.target).toBe("GET /users/:id");
  expect(c._projection.meta?.method).toBe("GET");
  expect(c._projection.meta?.path).toBe("/users/:id");
  expect(c._projection.cases.length).toBe(2);
  expect(c._projection.cases.find((x) => x.key === "ok")?.lifecycle).toBe("active");
  expect(c._projection.cases.find((x) => x.key === "notFound")?.lifecycle).toBe("active");
});

test("normalize produces JSON-safe projection", async () => {
  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  const c = api("fetch", {
    endpoint: "GET /x",
    cases: {
      ok: {
        description: "x",
        expect: { status: 200 },
      },
    },
  });

  const extracted = c._extracted;
  expect(extracted.id).toBe("fetch");
  expect(extracted.protocol).toBe("http");
  const cloned = JSON.parse(JSON.stringify(extracted));
  expect(cloned).toEqual(extracted);
});

test("normalize preserves contract-level security from scoped factory", () => {
  const client = makeMockClient();
  const api = contract.http.with("api", { client, security: "bearer" });
  const c = api("fetch", {
    endpoint: "GET /x",
    cases: {
      ok: { description: "x", expect: { status: 200 } },
    },
  });

  // Runtime projection has security injected by the factory
  expect((c._projection.schemas as any)?.security).toBe("bearer");

  // _extracted is the dispatcher-populated safe form (adapter.normalize output)
  expect((c._extracted.schemas as any)?.security).toBe("bearer");
});

test("normalize preserves apiKey security object verbatim", () => {
  const client = makeMockClient();
  const apiKey = { type: "apiKey" as const, name: "X-API-Key", in: "header" as const };
  const api = contract.http.with("api", { client, security: apiKey });
  const c = api("fetch", {
    endpoint: "GET /x",
    cases: {
      ok: { description: "x", expect: { status: 200 } },
    },
  });

  expect((c._extracted.schemas as any)?.security).toEqual(apiKey);
});

// ---------------------------------------------------------------------------
// dispatcher auto-wires _extracted — regression against the "adapter.normalize
// is declared but never called" gap. Prior to this, every test in this file
// that reads the safe form had to call `httpAdapter.normalize!(...)` manually
// (see the `!` non-null assertions). After the fix, dispatcher always calls
// normalize and stores the result as _extracted on the carrier.
// ---------------------------------------------------------------------------

test("HTTP carrier exposes _extracted auto-populated from httpAdapter.normalize", async () => {
  const { httpAdapter } = await import("./adapter.js");
  const client = makeMockClient();
  const api = contract.http.with("api", { client, security: "bearer" });
  const c = api("fetch", {
    endpoint: "GET /x",
    cases: { ok: { description: "x", expect: { status: 200 } } },
  });

  // Invariant 1: dispatcher populated _extracted
  expect((c as any)._extracted).toBeDefined();

  // Invariant 2: _extracted === what adapter.normalize would produce manually
  const manual = httpAdapter.normalize!({ ...c._projection });
  expect((c as any)._extracted).toEqual(manual);

  // Invariant 3: protocol-specific normalization survives (HTTP `security`
  // field is explicitly preserved by normalizeHttp's "must survive" branch)
  expect(((c as any)._extracted.schemas as any)?.security).toBe("bearer");
});

// ---------------------------------------------------------------------------
// classifyFailure
// ---------------------------------------------------------------------------

test("classifyFailure maps HTTP status to FailureKind", async () => {
  const { httpAdapter } = await import("./adapter.js");
  const classify = httpAdapter.classifyFailure!;

  expect(classify({ events: [{ type: "http:response", data: { status: 401 } }] })?.kind).toBe("auth");
  expect(classify({ events: [{ type: "http:response", data: { status: 403 } }] })?.kind).toBe("permission");
  expect(classify({ events: [{ type: "http:response", data: { status: 404 } }] })?.kind).toBe("not-found");
  expect(classify({ events: [{ type: "http:response", data: { status: 429 } }] })?.kind).toBe("rate-limit");
  expect(classify({ events: [{ type: "http:response", data: { status: 502 } }] })?.kind).toBe("transport");

  const timeoutErr = new Error("Request timed out");
  timeoutErr.name = "TimeoutError";
  expect(classify({ error: timeoutErr, events: [] })?.kind).toBe("timeout");
});
