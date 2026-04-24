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
  SchemaLike,
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
  // End-to-end HTTP overlay test on the PUBLIC authoring path:
  //   contract.http.with(...) → api(id, spec) → c.case(key) → contract.bootstrap(ref, run)
  // Proves bootstrap output flows through httpAdapter.executeCase →
  // executeStandaloneCase → function-valued params/headers/body → outgoing
  // request construction.
  //
  // v10 made this work by separating pure case-ref creation from flow-safety
  // validation: .case() no longer rejects function-valued action fields
  // (that check moved to flow.step()), so bootstrap overlays can legitimately
  // attach to cases with function-valued fields. See contract-core.ts §case()
  // and §step() comments.
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

  // Public API: contract.bootstrap(ref, spec).
  (contract.bootstrap as any)(
    c.case("success"),
    async () => ({
      projectId: "p_42",
      token: "tok-abc",
      items: [{ sku: "X", qty: 1 }],
    }),
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

test("function-valued body accepted in flow (v10 logical-input)", () => {
  // v10: function-valued body/params/headers are the CANONICAL pattern for
  // logical-input cases. They receive `resolvedInput` (from flow `in` lens
  // or bootstrap overlay) and build the request. v9's validateCaseForFlow
  // rule "function fields can't resolve in flow" is removed — the runtime
  // (`executeCaseInFlowHttp`) now handles them directly.
  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  const c = api("c", {
    endpoint: "POST /x",
    cases: {
      ok: {
        description: "x",
        needs: {} as SchemaLike<{ x: unknown }>,
        expect: { status: 200 },
        body: (s: { x: unknown }) => ({ v: s.x }),
      },
    },
  });

  // Pure case-ref creation — OK
  const ref = c.case("ok");
  expect(ref.__glubean_type).toBe("contract-case-ref");

  // Flow step accepts — no longer rejected (v10 logical-input is canonical).
  expect(() =>
    contract.flow("f").step(ref, { in: () => ({ x: 1 }) }),
  ).not.toThrow();
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
// executeCaseInFlow: logical-input construction (v10, Phase 2d Step 2)
// ---------------------------------------------------------------------------

test("flow step: needs case without `in` throws at runtime (TS bypass guard)", async () => {
  // v10 invariant: a case with `needs` MUST have `bindings.in` in flow mode.
  // The conditional-tuple FlowBuilder.step() signature catches this at
  // compile time, but `as any` / JS callers can bypass. Runtime guard in
  // runFlow throws a clear error before adapter is invoked.
  const client = makeMockClient({ status: 200 });
  const api = contract.http.with("api", { client });

  const stringSchema = {
    safeParse: (d: unknown) =>
      typeof d === "string"
        ? { success: true as const, data: d }
        : { success: false as const, error: { issues: [{ message: "not a string" }] } },
  };

  const c = api("create", {
    endpoint: "POST /users",
    cases: {
      ok: {
        description: "create",
        needs: stringSchema as SchemaLike<string>,
        expect: { status: 200 },
      },
    },
  });

  // Simulate the TS bypass: `.step(ref)` WITHOUT bindings on a needs case.
  // Cast step to any to skip the conditional-tuple type check (simulates
  // JS callers / `as any` usage).
  const flowObj = (contract
    .flow("f")
    .step as any)(c.case("ok"))
    .build() as FlowContract<unknown>;

  await expect(runFlow(flowObj, makeCtx())).rejects.toThrow(
    /declares `needs` but the step has no `bindings\.in`/,
  );
  // Critical: HTTP client NEVER called — guard fires before adapter dispatch.
  expect(client._calls.length).toBe(0);
});

test("flow step: needs schema rejects invalid `in` output BEFORE HTTP call", async () => {
  // v10: flow `in` output must pass the case's `needs` schema at runtime,
  // mirroring the standalone overlay path. Without this guard, TS-only
  // logical-input enforcement could be bypassed via `as any`, JS callers,
  // or state drift producing invalid values. Runtime validation is the
  // only line of defense that also applies Zod parse / coerce / default.
  const client = makeMockClient({ status: 200 });
  const api = contract.http.with("api", { client });

  // Schema rejects anything without a non-empty `email` string.
  const emailSchema = {
    safeParse: (d: unknown) => {
      if (
        d && typeof d === "object" &&
        "email" in d &&
        typeof (d as { email: unknown }).email === "string" &&
        (d as { email: string }).email.length > 0
      ) {
        return { success: true as const, data: d };
      }
      return {
        success: false as const,
        error: {
          issues: [{ message: "email must be a non-empty string", path: ["email"] }],
        },
      };
    },
  };

  const c = api("create", {
    endpoint: "POST /users",
    cases: {
      ok: {
        description: "create",
        needs: emailSchema as SchemaLike<{ email: string }>,
        expect: { status: 200 },
        body: ({ email }: { email: string }) => ({ email }),
      },
    },
  });

  // Flow `in` returns an invalid shape (email missing).
  const flowObj = contract
    .flow("f")
    .setup(async () => ({ somethingElse: true }))
    .step(c.case("ok"), {
      in: () => ({ email: "" }), // fails schema (length === 0)
    })
    .build() as FlowContract<unknown>;

  await expect(runFlow(flowObj, makeCtx())).rejects.toThrow(
    /Flow `in` output.*does not satisfy needs/,
  );
  // Critical: HTTP client NEVER called — validation fires before adapter.
  expect(client._calls.length).toBe(0);
});

test("flow step: function-valued body receives logical input", async () => {
  // v10 equivalent of the v9 "deep-merges lens inputs over case static body"
  // test. Previously: static `body: { role, source }` + adapter-patch in-lens
  // `{ body: { email } }` produced `{ role, source, email }`. Now: case
  // declares `needs: { email }`, body is a function that builds the full
  // request from logical input, flow `in` returns that logical input.
  const client = makeMockClient({ status: 200, body: { id: "u1" } });
  const api = contract.http.with("api", { client });
  const c = api("create", {
    endpoint: "POST /users",
    cases: {
      ok: {
        description: "create",
        needs: {} as SchemaLike<{ email: string }>, // type-only; no runtime parse
        expect: { status: 200 },
        body: ({ email }: { email: string }) => ({
          role: "admin",
          source: "web",
          email,
        }),
      },
    },
  });

  const flowObj = contract
    .flow("f")
    .setup(async () => ({ email: "alice@test" }))
    .step(c.case("ok"), {
      in: (s: { email: string }) => ({ email: s.email }),
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

// ---------------------------------------------------------------------------
// v10 attachment model migration note — Category B (flow-mode setup/teardown)
// ---------------------------------------------------------------------------
// Three v9 tests deleted in Phase 2d Step 2:
//   - "Rule 1: case teardown runs when setup returns undefined"
//   - "Rule 1: case teardown does NOT run when setup itself throws"
//   - "Rule 1: case teardown runs even if flow step request throws"
//
// All three documented v9 flow-mode case-level setup/teardown semantics.
// In v10 (attachment model §4.1) contract cases have no lifecycle; their
// equivalents live as bootstrap overlay cleanups (contract.bootstrap +
// ctx.cleanup). Overlay coverage in contract.test.ts:
//   - "bootstrap ctx.cleanup callbacks run LIFO after case execution"
//   - "bootstrap cleanup runs even when executeCase throws"
//   - "cleanup error is reported on ALL three failure paths" (3 sub-paths)
//
// These overlay tests subsume the Rule-1 semantics with adapter-agnostic
// coverage. The adapter-specific flavor added no new signal. If future
// needs arise for HTTP-specific overlay coverage (e.g., that a bootstrap's
// HTTP-client cleanup doesn't leak keep-alive sockets), add it here with
// a new test name that reflects v10 vocabulary.

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
