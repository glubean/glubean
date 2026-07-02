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
import { contract } from "../index.js";
import { readJsonBody } from "./adapter.js";
import type {
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
  // _spec.cases is the HttpCase union since I2 (inbound cases) — narrow for
  // the outbound-only assertion.
  const okCase = c._spec.cases.ok as { expect: { status: number } };
  expect(okCase.expect.status).toBe(201);
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
  // The exact route template (M8) rides on ky's NON-WIRE `context`, not a header, so it
  // can't leak to the SUT; the load runner reads it for an exact endpoint routeKey.
  expect(call.options.context).toEqual({ glubeanRoute: "POST /projects/:projectId/orders" });
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

test("HTTP projection surfaces given and verify markers", () => {
  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  const c = api("fetch", {
    endpoint: "GET /x",
    cases: {
      ok: {
        description: "x",
        expect: { status: 200 },
        given: "user is signed in",
        verifyRules: [{ id: "audit", description: "audit row is written" }],
        verify: async () => {},
      },
    },
  });

  const caseMeta = (c as any)._extracted.cases[0];
  expect(caseMeta.given).toBe("user is signed in");
  expect(caseMeta.hasVerify).toBe(true);
  expect(caseMeta.verifyRules).toEqual([
    { id: "audit", description: "audit row is written" },
  ]);
});

test("contract.http.with errorEnvelope applies to non-2xx cases without schema", () => {
  const client = makeMockClient();
  const errorEnvelope = {
    safeParse: (input: unknown) => ({ success: true as const, data: input }),
    toJSONSchema: () => ({
      type: "object",
      required: ["error", "requestId"],
      properties: {
        error: { type: "string" },
        requestId: { type: "string" },
      },
    }),
  } satisfies SchemaLike<unknown> & { toJSONSchema(): unknown };
  const explicitNotFoundSchema = {
    safeParse: (input: unknown) => ({ success: true as const, data: input }),
    toJSONSchema: () => ({ type: "object", properties: { missing: { type: "boolean" } } }),
  } satisfies SchemaLike<unknown> & { toJSONSchema(): unknown };

  const api = contract.http.with("api", { client, errorEnvelope });
  const c = api("fetch", {
    endpoint: "GET /x",
    cases: {
      ok: { description: "ok", expect: { status: 200 } },
      invalid: { description: "bad request", expect: { status: 400 } },
      missing: {
        description: "not found",
        expect: { status: 404, schema: explicitNotFoundSchema },
      },
    },
  });

  const cases = Object.fromEntries(
    (c as any)._extracted.cases.map((item: any) => [item.key, item]),
  );
  expect(cases.ok.schemas.response.body).toBeUndefined();
  expect(cases.invalid.schemas.response.body).toEqual({
    type: "object",
    required: ["error", "requestId"],
    properties: {
      error: { type: "string" },
      requestId: { type: "string" },
    },
  });
  expect(cases.missing.schemas.response.body).toEqual({
    type: "object",
    properties: { missing: { type: "boolean" } },
  });
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

// ---------------------------------------------------------------------------
// unprojectableSchemas — distinguish "schema failed to project" from "absent".
// The schema VALUE stays undefined either way (consumers unaffected); the
// failure is recorded as a fully-qualified path so a snapshot can derive
// projectionComplete. See ExtractedContractProjection.unprojectableSchemas.
// ---------------------------------------------------------------------------

test("unprojectableSchemas records a response schema whose toJSONSchema throws", () => {
  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  // A SchemaLike whose toJSONSchema() throws — conversion fails, distinct from
  // an absent schema. (`expect.schema` maps to cases[].schemas.response.body.)
  const failing = {
    toJSONSchema: () => {
      throw new Error("boom");
    },
  };
  const c = api("fetch", {
    endpoint: "GET /x",
    cases: {
      ok: { description: "x", expect: { status: 200, schema: failing as any } },
    },
  });

  expect(c._extracted.unprojectableSchemas).toEqual(["cases.ok.response.body"]);
  // Value is undefined — OpenAPI / MCP / descriptors degrade exactly as before.
  expect((c._extracted.cases[0].schemas as any)?.response?.body).toBeUndefined();
});

test("no unprojectableSchemas when schemas are absent or project cleanly", () => {
  const client = makeMockClient();
  const api = contract.http.with("api", { client });

  // Absent response schema → no entry.
  const c1 = api("a", {
    endpoint: "GET /x",
    cases: { ok: { description: "x", expect: { status: 200 } } },
  });
  expect(c1._extracted.unprojectableSchemas).toBeUndefined();

  // Plain JSON Schema (has `type`) projects cleanly → no entry, value preserved.
  const c2 = api("b", {
    endpoint: "GET /x",
    cases: {
      ok: { description: "x", expect: { status: 200, schema: { type: "object" } as any } },
    },
  });
  expect(c2._extracted.unprojectableSchemas).toBeUndefined();
  expect((c2._extracted.cases[0].schemas as any)?.response?.body).toEqual({ type: "object" });
});

// GLU-90 — hand-rolled `SchemaLike` (safeParse-only, no schema-library
// backing, no `toJSONSchema`, no `type`/`$ref` key) is the ONE shape that
// fell through every existing branch of schemaToJsonSchema to `null` no
// matter how well-documented the validator was. This is the exact shape of
// the public-demo's `inventory-items-shape` / `stable-users-shape` /
// `tier-account-shape` contracts (zod-free demos), which is why they never
// showed up in Cloud's Validate picker (projectionComplete === false).
test("GLU-90: a hand-rolled safeParse-only SchemaLike with no jsonSchema hint stays unprojectable (documents the pre-existing gap)", () => {
  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  // Mirrors packages/demo/tests/inventory/inventory-items.contract.ts exactly:
  // only `safeParse`, no `toJSONSchema`, no `type`/`$ref` key, no `jsonSchema`.
  const handRolledNoHint: SchemaLike<unknown> = {
    safeParse(data: unknown) {
      return { success: true as const, data };
    },
  };
  const c = api("fetch", {
    endpoint: "GET /x",
    cases: {
      ok: { description: "x", expect: { status: 200, schema: handRolledNoHint } },
    },
  });

  expect(c._extracted.unprojectableSchemas).toEqual(["cases.ok.response.body"]);
  expect((c._extracted.cases[0].schemas as any)?.response?.body).toBeUndefined();
});

test("GLU-90: a hand-rolled safeParse-only SchemaLike WITH a jsonSchema hint now projects fully", () => {
  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  // Same opaque safeParse-only shape as inventory-items-shape, but with the
  // new sanctioned escape hatch: SchemaLike.jsonSchema declared verbatim.
  const itemsJsonSchema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sku: { type: "string" },
            name: { type: "string" },
            stockQty: { type: "number" },
            priceCents: { type: "number" },
          },
          required: ["sku", "name", "stockQty", "priceCents"],
        },
      },
      total: { type: "number" },
      inStock: { type: "number" },
    },
    required: ["items", "total", "inStock"],
  };
  const handRolledWithHint: SchemaLike<unknown> = {
    safeParse(data: unknown) {
      return { success: true as const, data };
    },
    jsonSchema: itemsJsonSchema,
  };
  const c = api("fetch", {
    endpoint: "GET /x",
    cases: {
      ok: { description: "x", expect: { status: 200, schema: handRolledWithHint } },
    },
  });

  // No unprojectable entry — the contract is now projectionComplete.
  expect(c._extracted.unprojectableSchemas).toBeUndefined();
  // The declared hint is used verbatim (array response, nested object item shape).
  expect((c._extracted.cases[0].schemas as any)?.response?.body).toEqual(itemsJsonSchema);
});

test("GLU-90: a jsonSchema hint that is an array (malformed) is ignored, not passed through", () => {
  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  const malformed: SchemaLike<unknown> = {
    safeParse: (data: unknown) => ({ success: true as const, data }),
    // Malformed hint (array, not a JSON Schema object) — must NOT be treated
    // as a valid declared shape; still recorded as unprojectable.
    jsonSchema: ["not", "a", "schema"] as unknown as Record<string, unknown>,
  };
  const c = api("fetch", {
    endpoint: "GET /x",
    cases: {
      ok: { description: "x", expect: { status: 200, schema: malformed } },
    },
  });

  expect(c._extracted.unprojectableSchemas).toEqual(["cases.ok.response.body"]);
  expect((c._extracted.cases[0].schemas as any)?.response?.body).toBeUndefined();
});

test("GLU-90: a jsonSchema hint recovers projection when toJSONSchema() throws (codex round-1 P3)", () => {
  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  // A schema-library instance whose toJSONSchema() throws (e.g. z.date(), a
  // custom refinement zod can't represent) — but the author also declared a
  // jsonSchema hint as a manual override. Must NOT fall through to the
  // `"type" in schema` shortcut (that would leak whatever partial shape the
  // throwing instance carries); must use the declared hint instead.
  const throwingWithHint: SchemaLike<unknown> & { toJSONSchema(): unknown } = {
    safeParse: (data: unknown) => ({ success: true as const, data }),
    toJSONSchema: () => {
      throw new Error("unrepresentable");
    },
    jsonSchema: { type: "string", format: "date-time" },
  };
  const c = api("fetch", {
    endpoint: "GET /x",
    cases: {
      ok: { description: "x", expect: { status: 200, schema: throwingWithHint as any } },
    },
  });

  expect(c._extracted.unprojectableSchemas).toBeUndefined();
  expect((c._extracted.cases[0].schemas as any)?.response?.body).toEqual({
    type: "string",
    format: "date-time",
  });
});

test("a schema-lib instance that carries a `type` field (zod v4 shape) projects to JSON Schema, not raw", () => {
  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  // A real zod v4 instance exposes a `type` getter (e.g. "object"), which used
  // to trip the `"type" in schema` shortcut and leak the raw object (def/checks/
  // shape/format:null). The mock reproduces that shape: `type` + `toJSONSchema`.
  const zodLike = {
    type: "object",
    _zod: {},
    safeParse: (input: unknown) => ({ success: true as const, data: input }),
    toJSONSchema: () => ({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { email: { type: "string", format: "email" } },
      required: ["email"],
      additionalProperties: false,
    }),
  };
  const c = api("fetch", {
    endpoint: "GET /x",
    cases: {
      ok: { description: "x", expect: { status: 200, schema: zodLike as any } },
    },
  });

  const body = (c._extracted.cases[0].schemas as any)?.response?.body;
  expect(body.properties.email.format).toBe("email"); // converted, not the raw instance
  expect(body).not.toHaveProperty("$schema"); // dialect noise stripped
  expect(body).not.toHaveProperty("safeParse"); // not the raw zod object
  expect(body).not.toHaveProperty("_zod");
  expect(c._extracted.unprojectableSchemas).toBeUndefined();
});

// --- readJsonBody: ky 2-safe body read (codex ky2 P2-6) ---------------------
function fakeRes(status: number, opts: { contentLength?: string; body?: unknown } = {}) {
  return {
    status,
    headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? (opts.contentLength ?? null) : null) },
    json: async () => {
      if (opts.body === undefined) throw new SyntaxError("Unexpected end of JSON input"); // ky 2 on empty
      return opts.body;
    },
  };
}

test("readJsonBody returns undefined for 204/205/304 (no throw)", async () => {
  expect(await readJsonBody(fakeRes(204))).toBeUndefined();
  expect(await readJsonBody(fakeRes(205))).toBeUndefined();
  expect(await readJsonBody(fakeRes(304))).toBeUndefined();
});

test("readJsonBody returns undefined for content-length 0 (no throw)", async () => {
  expect(await readJsonBody(fakeRes(200, { contentLength: "0" }))).toBeUndefined();
});

test("readJsonBody parses a normal JSON body", async () => {
  expect(await readJsonBody(fakeRes(200, { body: { ok: true } }))).toEqual({ ok: true });
});

test("readJsonBody still surfaces a genuine parse error on a non-empty bad body", async () => {
  // status 200, no content-length 0 → delegates to .json(), which throws here.
  await expect(readJsonBody(fakeRes(200))).rejects.toBeInstanceOf(SyntaxError);
});
