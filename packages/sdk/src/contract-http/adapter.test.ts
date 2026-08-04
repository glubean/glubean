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
import { z } from "zod";
// Import from main index so the HTTP adapter side-effect registration fires.
import { contract } from "../index.js";
import { readJsonBody } from "./adapter.js";
import { REQUEST_SENSITIVE_VALUES } from "../request-trace-security.js";
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
import {
  setRuntime as carrierSetRuntime,
  type InternalRuntime,
} from "../runtime-carrier.js";

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

/**
 * Install a fake runtime (vars/secrets/session) into the carrier so
 * `{{KEY}}` param templating (GLU-156) has somewhere to resolve from.
 * Returns a cleanup function — callers MUST call it (try/finally) so a
 * runtime installed by one test never leaks into the next.
 */
function installRuntime(
  vars: Record<string, string> = {},
  secrets: Record<string, string> = {},
  session: Record<string, unknown> = {},
): () => void {
  const runtime: InternalRuntime = {
    vars,
    secrets,
    session,
    http: {} as HttpClient,
  };
  carrierSetRuntime(runtime);
  return () => carrierSetRuntime(undefined);
}

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
// GLU-156: path/query params resolve `{{KEY}}` env placeholders
// ---------------------------------------------------------------------------

test("GLU-156: path param `{{KEY}}` resolves from runtime vars and is URL-encoded AFTER resolution", async () => {
  const cleanup = installRuntime({ GLUBEAN_PROJECT_ID: "proj_abc/def" });
  try {
    const client = makeMockClient({ status: 200, body: {} });
    const api = contract.http.with("api", { client });
    const c = api("projects.get", {
      endpoint: "GET /v1/projects/:projectId",
      cases: {
        ok: {
          description: "fetch a project by id",
          params: {
            projectId: { value: "{{GLUBEAN_PROJECT_ID}}", schema: z.string().min(1) },
          },
          expect: { status: 200 },
        },
      },
    });

    await c[0].fn!(makeCtx());

    expect(client._calls.length).toBe(1);
    // Resolved to the real id, NOT the literal placeholder — and the "/" in
    // the resolved value is percent-encoded (proves resolve-THEN-encode
    // ordering, not merely "no double-encoding").
    expect(client._calls[0].url).toBe("/v1/projects/proj_abc%2Fdef");
  } finally {
    cleanup();
  }
});

test("GLU-156: path param plain string ParamValue (no {{}} wrapper object) also resolves", async () => {
  const cleanup = installRuntime({ GLUBEAN_PROJECT_ID: "proj_xyz" });
  try {
    const client = makeMockClient({ status: 200, body: {} });
    const api = contract.http.with("api", { client });
    const c = api("projects.get2", {
      endpoint: "GET /v1/projects/:projectId",
      cases: {
        ok: {
          description: "fetch a project by id (string-shorthand ParamValue)",
          params: { projectId: "{{GLUBEAN_PROJECT_ID}}" },
          expect: { status: 200 },
        },
      },
    });

    await c[0].fn!(makeCtx());
    expect(client._calls[0].url).toBe("/v1/projects/proj_xyz");
  } finally {
    cleanup();
  }
});

test("GLU-156: query param `{{KEY}}` resolves the same way as path params", async () => {
  const cleanup = installRuntime({ GLUBEAN_TARGET_ID: "target_1" });
  try {
    const client = makeMockClient({ status: 200, body: {} });
    const api = contract.http.with("api", { client });
    const c = api("targets.list", {
      endpoint: "GET /v1/targets",
      cases: {
        ok: {
          description: "list targets filtered by target id",
          query: { targetId: { value: "{{GLUBEAN_TARGET_ID}}" } },
          expect: { status: 200 },
        },
      },
    });

    await c[0].fn!(makeCtx());
    expect(client._calls[0].options.searchParams).toEqual({ targetId: "target_1" });
  } finally {
    cleanup();
  }
});

test("GLU-156: literal param value with no `{{}}` is passed through unchanged (no runtime needed)", async () => {
  // No installRuntime() call — proves the fast-path never touches the
  // carrier for a plain literal, so this also can't throw
  // "configure() values can only be accessed during test execution."
  const client = makeMockClient({ status: 200, body: {} });
  const api = contract.http.with("api", { client });
  const c = api("projects.get3", {
    endpoint: "GET /v1/projects/:projectId",
    cases: {
      ok: {
        description: "fetch a project by literal id",
        params: { projectId: "proj_literal" },
        expect: { status: 200 },
      },
    },
  });

  await c[0].fn!(makeCtx());
  expect(client._calls[0].url).toBe("/v1/projects/proj_literal");
});

test("GLU-156: missing env var referenced by a path param throws the same error as other {{KEY}} consumers", async () => {
  const cleanup = installRuntime({}); // GLUBEAN_PROJECT_ID intentionally absent
  try {
    const client = makeMockClient({ status: 200, body: {} });
    const api = contract.http.with("api", { client });
    const c = api("projects.get4", {
      endpoint: "GET /v1/projects/:projectId",
      cases: {
        ok: {
          description: "fetch a project by id",
          params: { projectId: { value: "{{GLUBEAN_PROJECT_ID}}" } },
          expect: { status: 200 },
        },
      },
    });

    await expect(c[0].fn!(makeCtx())).rejects.toThrow(
      'Missing value for template placeholder "{{GLUBEAN_PROJECT_ID}}"',
    );
    expect(client._calls.length).toBe(0); // never sent — fails before the request goes out
  } finally {
    cleanup();
  }
});

test("GLU-156: multiple `{{KEY}}` placeholders in one path param segment all resolve", async () => {
  const cleanup = installRuntime({ ORG: "acme", PROJECT: "widgets" });
  try {
    const client = makeMockClient({ status: 200, body: {} });
    const api = contract.http.with("api", { client });
    const c = api("orgs.projects.get", {
      endpoint: "GET /v1/scoped/:scope",
      cases: {
        ok: {
          description: "compound path segment with two placeholders",
          params: { scope: { value: "{{ORG}}--{{PROJECT}}" } },
          expect: { status: 200 },
        },
      },
    });

    await c[0].fn!(makeCtx());
    expect(client._calls[0].url).toBe("/v1/scoped/acme--widgets");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Issue #15: case-level headers/body resolve runtime templates
// ---------------------------------------------------------------------------

test("case headers and nested JSON body resolve vars, secrets, and session templates", async () => {
  const cleanup = installRuntime(
    { PROJECT_ID: "project-from-vars", REGION: "us-east-1" },
    { API_TOKEN: "secret-token" },
    {
      API_TOKEN: "session-token",
      PROJECT_ID: "project-from-session",
    },
  );
  try {
    const client = makeMockClient({ status: 200, body: {} });
    const api = contract.http.with("api", { client });
    const c = api("create-project-resource", {
      endpoint: "POST /resources",
      cases: {
        ok: {
          description: "create a resource with environment-backed request data",
          headers: {
            Authorization: "Bearer {{API_TOKEN}}",
            "X-Project-Id": "{{PROJECT_ID}}",
          },
          body: {
            projectId: "{{PROJECT_ID}}",
            metadata: {
              regions: ["primary-{{REGION}}", "literal"],
              targets: [{ id: "{{PROJECT_ID}}" }],
              enabled: true,
              attempts: 2,
              nullable: null,
            },
          },
          expect: { status: 200 },
        },
      },
    });

    await c[0].fn!(makeCtx());

    expect(client._calls[0].options.headers).toEqual({
      Authorization: "Bearer session-token",
      "X-Project-Id": "project-from-session",
    });
    expect(client._calls[0].options.json).toEqual({
      projectId: "project-from-session",
      metadata: {
        regions: ["primary-us-east-1", "literal"],
        targets: [{ id: "project-from-session" }],
        enabled: true,
        attempts: 2,
        nullable: null,
      },
    });
    const context = client._calls[0].options.context as {
      [REQUEST_SENSITIVE_VALUES]: string[];
    };
    expect(context[REQUEST_SENSITIVE_VALUES]).toEqual(["session-token"]);
  } finally {
    cleanup();
  }
});

test("literal case headers and body keep their identity without an execution runtime", async () => {
  const client = makeMockClient({ status: 200, body: {} });
  const api = contract.http.with("api", { client });
  const headers = { "X-Mode": "literal {{not a placeholder}}" };
  const body = { nested: ["literal {{not a placeholder}}", { enabled: true }] };
  const c = api("literal-request", {
    endpoint: "POST /resources",
    cases: {
      ok: {
        description: "send a request containing only literal values",
        headers,
        body,
        expect: { status: 200 },
      },
    },
  });

  await c[0].fn!(makeCtx());

  expect(client._calls[0].options.headers).toBe(headers);
  expect(client._calls[0].options.json).toBe(body);
});

test("escaped valid placeholders are sent literally without an execution runtime", async () => {
  const client = makeMockClient({ status: 200, body: {} });
  const api = contract.http.with("api", { client });
  const c = api("escaped-template-request", {
    endpoint: "POST /resources",
    cases: {
      ok: {
        description: "send literal template syntax in request data",
        headers: { "X-Template": "\\{{PROJECT_ID}}" },
        body: { nested: ["\\{{PROJECT_ID}}"] },
        expect: { status: 200 },
      },
    },
  });

  await c[0].fn!(makeCtx());

  expect(client._calls[0].options.headers).toEqual({
    "X-Template": "{{PROJECT_ID}}",
  });
  expect(client._calls[0].options.json).toEqual({
    nested: ["{{PROJECT_ID}}"],
  });
});

test("body resolution preserves descriptors, custom JSON serialization, and nested opaque values", async () => {
  const cleanup = installRuntime({}, { API_TOKEN: "secret-token" });
  try {
    const symbolToken = Symbol("token");
    const opaque = new (class OpaqueValue {
      readonly value = "{{API_TOKEN}}";
    })();
    const toJSON = function (this: Record<PropertyKey, unknown>) {
      return {
        derived: `${String(this.token)}:${String(this.hiddenToken)}:${String(this[symbolToken])}`,
        token: this.token,
        opaque: this.opaque,
      };
    };
    const body = Object.create(Object.prototype, {
      token: {
        configurable: false,
        enumerable: true,
        value: "{{API_TOKEN}}",
        writable: false,
      },
      hiddenToken: {
        configurable: false,
        enumerable: false,
        value: "{{API_TOKEN}}",
        writable: false,
      },
      [symbolToken]: {
        configurable: false,
        enumerable: false,
        value: "{{API_TOKEN}}",
        writable: false,
      },
      opaque: {
        configurable: true,
        enumerable: true,
        value: opaque,
        writable: true,
      },
      toJSON: {
        configurable: true,
        enumerable: false,
        value: toJSON,
        writable: true,
      },
    }) as Record<string, unknown>;
    Object.preventExtensions(body);
    const client = makeMockClient({ status: 200, body: {} });
    const api = contract.http.with("api", { client });
    const c = api("descriptor-safe-request", {
      endpoint: "POST /resources",
      cases: {
        ok: {
          description: "resolve data properties without changing object semantics",
          body,
          expect: { status: 200 },
        },
      },
    });

    await c[0].fn!(makeCtx());

    const resolved = client._calls[0].options.json as Record<string, unknown>;
    expect(resolved === body).toBe(false);
    expect(Object.isExtensible(resolved)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(resolved, "token")).toMatchObject({
      configurable: false,
      enumerable: true,
      value: "secret-token",
      writable: false,
    });
    expect(Object.getOwnPropertyDescriptor(resolved, "toJSON")?.value).toBe(toJSON);
    expect(Object.getOwnPropertyDescriptor(resolved, "hiddenToken")?.value).toBe("secret-token");
    expect(Object.getOwnPropertyDescriptor(resolved, symbolToken)?.value).toBe("secret-token");
    expect(resolved.opaque).toBe(opaque);
    expect(opaque.value).toBe("{{API_TOKEN}}");
    expect(JSON.parse(JSON.stringify(resolved))).toEqual({
      derived: "secret-token:secret-token:secret-token",
      token: "secret-token",
      opaque: { value: "{{API_TOKEN}}" },
    });
  } finally {
    cleanup();
  }
});

test("opaque body values pass through unchanged instead of being traversed", async () => {
  const client = makeMockClient({ status: 200, body: {} });
  const api = contract.http.with("api", { client });
  const body = new URLSearchParams({ projectId: "{{PROJECT_ID}}" });
  const c = api("opaque-request", {
    endpoint: "POST /resources",
    cases: {
      ok: {
        description: "send an opaque URL-encoded body without implicit traversal",
        contentType: "application/x-www-form-urlencoded",
        body,
        expect: { status: 200 },
      },
    },
  });

  await c[0].fn!(makeCtx());

  expect(client._calls[0].options.body).toBe(body);
  expect(body.get("projectId")).toBe("{{PROJECT_ID}}");
});

test("typed-array static bodies pass through unchanged", async () => {
  const client = makeMockClient({ status: 200, body: {} });
  const api = contract.http.with("api", { client });
  const body = new Uint8Array([1, 2, 3]);
  const c = api("binary-request", {
    endpoint: "POST /resources",
    cases: {
      ok: {
        description: "send an opaque binary request body",
        contentType: "application/octet-stream",
        body,
        expect: { status: 200 },
      },
    },
  });

  await c[0].fn!(makeCtx());

  expect(client._calls[0].options.body).toBe(body);
});

test("a top-level string body resolves templates", async () => {
  const cleanup = installRuntime({}, { API_TOKEN: "secret-token" });
  try {
    const client = makeMockClient({ status: 200, body: {} });
    const api = contract.http.with("api", { client });
    const c = api("string-request", {
      endpoint: "POST /resources",
      cases: {
        ok: {
          description: "resolve a template in a top-level JSON string body",
          body: "prefix-{{API_TOKEN}}",
          expect: { status: 200 },
        },
      },
    });

    await c[0].fn!(makeCtx());

    expect(client._calls[0].options.json).toBe("prefix-secret-token");
    const context = client._calls[0].options.context as {
      glubeanRoute: string;
      [REQUEST_SENSITIVE_VALUES]: string[];
    };
    expect(context.glubeanRoute).toBe("POST /resources");
    expect(context[REQUEST_SENSITIVE_VALUES]).toEqual(["secret-token"]);
  } finally {
    cleanup();
  }
});

test("runtime replacement values remain terminal even when they contain template syntax", async () => {
  const cleanup = installRuntime({}, { API_TOKEN: "value-{{NOT_RECURSIVE}}" });
  try {
    const client = makeMockClient({ status: 200, body: {} });
    const api = contract.http.with("api", { client });
    const c = api("terminal-template-request", {
      endpoint: "POST /resources",
      cases: {
        ok: {
          description: "treat resolved runtime values as terminal data",
          headers: { "X-Token": "{{API_TOKEN}}" },
          body: { token: "{{API_TOKEN}}" },
          expect: { status: 200 },
        },
      },
    });

    await c[0].fn!(makeCtx());

    expect(client._calls[0].options.headers).toEqual({
      "X-Token": "value-{{NOT_RECURSIVE}}",
    });
    expect(client._calls[0].options.json).toEqual({
      token: "value-{{NOT_RECURSIVE}}",
    });
  } finally {
    cleanup();
  }
});

test("path and query secret templates join the non-wire trace masking context", async () => {
  const cleanup = installRuntime(
    {},
    { PATH_SECRET: "path-secret", QUERY_SECRET: "query-secret" },
  );
  try {
    const client = makeMockClient({ status: 200, body: {} });
    const api = contract.http.with("api", { client });
    const c = api("secret-url-request", {
      endpoint: "GET /tenants/:tenantId/resources",
      cases: {
        ok: {
          description: "mask secret-backed path and query values in traces",
          pathParams: { tenantId: "{{PATH_SECRET}}" },
          query: { cursor: "{{QUERY_SECRET}}" },
          expect: { status: 200 },
        },
      },
    });

    await c[0].fn!(makeCtx());

    expect(client._calls[0].url).toBe("/tenants/path-secret/resources");
    expect(client._calls[0].options.searchParams).toEqual({
      cursor: "query-secret",
    });
    const context = client._calls[0].options.context as {
      [REQUEST_SENSITIVE_VALUES]: string[];
    };
    expect(context[REQUEST_SENSITIVE_VALUES]).toEqual([
      "path-secret",
      "query-secret",
    ]);
  } finally {
    cleanup();
  }
});

test("array subclasses remain opaque and retain private instance state", async () => {
  class StatefulArray extends Array<string> {
    readonly #marker = "state-intact";

    marker(): string {
      return this.#marker;
    }
  }

  const client = makeMockClient({ status: 200, body: {} });
  const api = contract.http.with("api", { client });
  const body = new StatefulArray("{{API_TOKEN}}");
  const c = api("array-subclass-request", {
    endpoint: "POST /resources",
    cases: {
      ok: {
        description: "preserve an opaque Array subclass body",
        body,
        expect: { status: 200 },
      },
    },
  });

  await c[0].fn!(makeCtx());

  const sent = client._calls[0].options.json as StatefulArray;
  expect(sent).toBe(body);
  expect(sent[0]).toBe("{{API_TOKEN}}");
  expect(sent.marker()).toBe("state-intact");
});

test("frozen nested bodies and headers keep integrity while resolving templates", async () => {
  const cleanup = installRuntime(
    { PROJECT_ID: "project-from-vars" },
    { API_TOKEN: "secret-token" },
  );
  try {
    const headers = {
      Authorization: "Bearer {{API_TOKEN}}",
      "X-Project-Id": "{{PROJECT_ID}}",
    } as Record<string, string>;
    Object.defineProperties(headers, {
      hiddenProjectId: {
        configurable: true,
        enumerable: false,
        value: "{{PROJECT_ID}}",
        writable: true,
      },
    });
    Object.freeze(headers);
    const body = Object.freeze({
      nested: Object.freeze({ projectId: "{{PROJECT_ID}}" }),
    });
    const client = makeMockClient({ status: 200, body: {} });
    const api = contract.http.with("api", { client });
    const c = api("frozen-request", {
      endpoint: "POST /resources",
      cases: {
        ok: {
          description: "resolve a frozen request snapshot without making it mutable",
          headers,
          body,
          expect: { status: 200 },
        },
      },
    });

    await c[0].fn!(makeCtx());

    const sentHeaders = client._calls[0].options.headers as Record<string, string>;
    const sentBody = client._calls[0].options.json as {
      nested: { projectId: string };
    };
    expect(sentHeaders).toEqual({
      Authorization: "Bearer secret-token",
      "X-Project-Id": "project-from-vars",
    });
    expect(Object.isFrozen(sentHeaders)).toBe(true);
    expect(sentBody).toEqual({ nested: { projectId: "project-from-vars" } });
    expect(Object.isFrozen(sentBody)).toBe(true);
    expect(Object.isFrozen(sentBody.nested)).toBe(true);
  } finally {
    cleanup();
  }
});

test("enumerable request accessors fail before the request is sent", async () => {
  const client = makeMockClient({ status: 200, body: {} });
  const api = contract.http.with("api", { client });
  const body = Object.defineProperty({}, "value", {
    enumerable: true,
    get: () => "literal",
  });
  const c = api("accessor-request", {
    endpoint: "POST /resources",
    cases: {
      ok: {
        description: "require stable data properties in request snapshots",
        body,
        expect: { status: 200 },
      },
    },
  });

  await expect(c[0].fn!(makeCtx())).rejects.toThrow(
    "Accessor properties are not supported in contract request data",
  );
  expect(client._calls).toHaveLength(0);

  const headers = Object.defineProperty({}, "X-Mode", {
    enumerable: true,
    get: () => "literal",
  }) as Record<string, string>;
  const headerCase = api("accessor-header-request", {
    endpoint: "GET /resources",
    cases: {
      ok: {
        description: "require stable header data properties",
        headers,
        expect: { status: 200 },
      },
    },
  });
  await expect(headerCase[0].fn!(makeCtx())).rejects.toThrow(
    "Accessor properties are not supported in contract request data",
  );
  expect(client._calls).toHaveLength(0);
});

test("circular JSON-shaped bodies fail before the request is sent", async () => {
  const client = makeMockClient({ status: 200, body: {} });
  const api = contract.http.with("api", { client });
  const body: Record<string, unknown> = { projectId: "literal" };
  body.self = body;
  const c = api("circular-request", {
    endpoint: "POST /resources",
    cases: {
      ok: {
        description: "reject a body graph that cannot be serialized as JSON",
        body,
        expect: { status: 200 },
      },
    },
  });

  await expect(c[0].fn!(makeCtx())).rejects.toThrow(
    "Circular references are not supported in contract case bodies",
  );
  expect(client._calls).toHaveLength(0);
});

test("a missing body template fails before the request is sent", async () => {
  const cleanup = installRuntime();
  try {
    const client = makeMockClient({ status: 200, body: {} });
    const api = contract.http.with("api", { client });
    const c = api("missing-body-template", {
      endpoint: "POST /resources",
      cases: {
        ok: {
          description: "require every body template before sending the request",
          body: { nested: { projectId: "{{MISSING_PROJECT_ID}}" } },
          expect: { status: 200 },
        },
      },
    });

    await expect(c[0].fn!(makeCtx())).rejects.toThrow(
      'Missing value for template placeholder "{{MISSING_PROJECT_ID}}"',
    );
    expect(client._calls).toHaveLength(0);
  } finally {
    cleanup();
  }
});

test("a missing header template fails before the request is sent", async () => {
  const cleanup = installRuntime();
  try {
    const client = makeMockClient({ status: 200, body: {} });
    const api = contract.http.with("api", { client });
    const c = api("missing-header-template", {
      endpoint: "GET /resources",
      cases: {
        ok: {
          description: "require every header template before sending the request",
          headers: { Authorization: "Bearer {{MISSING_TOKEN}}" },
          expect: { status: 200 },
        },
      },
    });

    await expect(c[0].fn!(makeCtx())).rejects.toThrow(
      'Missing value for template placeholder "{{MISSING_TOKEN}}"',
    );
    expect(client._calls).toHaveLength(0);
  } finally {
    cleanup();
  }
});

test("workflow case execution resolves templates returned by body and header input functions", async () => {
  const cleanup = installRuntime(
    { PROJECT_ID: "project-from-vars" },
    { API_TOKEN: "secret-token" },
  );
  try {
    const client = makeMockClient({ status: 200, body: { ok: true } });
    const api = contract.http.with("api", { client });
    const c = api("workflow-request", {
      endpoint: "POST /resources",
      cases: {
        ok: {
          description: "resolve workflow-provided request templates at execution time",
          headers: ({ authorization }: any) => ({ Authorization: authorization }),
          body: ({ projectId }: any) => ({ projectId, nested: ["{{PROJECT_ID}}"] }),
          expect: { status: 200 },
        },
      },
    });
    const { httpAdapter } = await import("./adapter.js");

    await httpAdapter.executeCaseInFlow!({
      ctx: makeCtx(),
      contract: c,
      caseKey: "ok",
      resolvedInputs: {
        authorization: "Bearer {{API_TOKEN}}",
        projectId: "{{PROJECT_ID}}",
      },
    });

    expect(client._calls[0].options.headers).toEqual({
      Authorization: "Bearer secret-token",
    });
    expect(client._calls[0].options.json).toEqual({
      projectId: "project-from-vars",
      nested: ["project-from-vars"],
    });
    const context = client._calls[0].options.context as {
      [REQUEST_SENSITIVE_VALUES]: string[];
    };
    expect(context[REQUEST_SENSITIVE_VALUES]).toEqual(["secret-token"]);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// pathParams — canonical name for the path-parameter slot (`params` is its
// deprecated alias; the GLU-156 tests above double as alias back-compat
// coverage until `params` is removed)
// ---------------------------------------------------------------------------

test("pathParams: static values resolve :key segments", async () => {
  const client = makeMockClient({ status: 200, body: {} });
  const api = contract.http.with("api", { client });
  const c = api("projects.get5", {
    endpoint: "GET /v1/projects/:projectId",
    cases: {
      ok: {
        description: "fetch a project by id (canonical pathParams)",
        pathParams: { projectId: "proj_new" },
        expect: { status: 200 },
      },
    },
  });

  await c[0].fn!(makeCtx());
  expect(client._calls[0].url).toBe("/v1/projects/proj_new");
});

test("pathParams: function form receives the resolved logical input (bootstrap overlay)", async () => {
  const client = makeMockClient({ status: 200, body: {} });
  const api = contract.http.with("api", { client });
  const c = api("orders.get", {
    endpoint: "GET /projects/:projectId/orders/:orderId",
    cases: {
      ok: {
        description: "fetch an order under a project",
        pathParams: ({ projectId, orderId }: any) => ({ projectId, orderId }),
        expect: { status: 200 },
      },
    },
  });

  (contract.bootstrap as any)(c.case("ok"), async () => ({
    projectId: "p_1",
    orderId: "o_9",
  }));

  await c[0].fn!(makeCtx());
  expect(client._calls[0].url).toBe("/projects/p_1/orders/o_9");
});

test("pathParams: ParamValue metadata projects into case schemas (wire name stays `params`)", () => {
  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  const c = api("projects.get6", {
    endpoint: "GET /v1/projects/:projectId",
    cases: {
      ok: {
        description: "fetch a project by id",
        pathParams: {
          projectId: { value: "p_1", schema: z.string().min(1), description: "project id" },
        },
        expect: { status: 200 },
      },
    },
  });

  const projected = c._projection.cases.find((x) => x.key === "ok")!;
  expect(projected.schemas?.params?.projectId?.description).toBe("project id");
});

test("setting both pathParams and its deprecated alias params throws at construction", () => {
  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  expect(() =>
    api("projects.get7", {
      endpoint: "GET /v1/projects/:projectId",
      cases: {
        ok: {
          description: "ambiguous path-parameter slot",
          pathParams: { projectId: "a" },
          params: { projectId: "b" },
          expect: { status: 200 },
        },
      },
    }),
  ).toThrow(/both "pathParams" and "params" are set/);
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

test("GLU-120: a real Zod v4 instance WITHOUT the instance toJSONSchema() method converts via the static z.toJSONSchema fallback", () => {
  // Reproduces the real-world shape that the previous test's mock got wrong:
  // Zod's pre-4.0 transitional `zod/v4` subpath (used by the 3.23-3.25.x
  // "opt into v4 early" releases) — and any future build that drops the
  // instance method — expose the converter as a STATIC `z.toJSONSchema()`
  // only. Simulated here with a REAL zod schema's internals (`_zod`, built
  // by the actual `z.object()` factory below) stripped of every instance
  // method, so `zodV4StaticToJsonSchema`'s own module resolution
  // (`require("zod")`) is exercised against genuine Zod v4 internal
  // structure, not a hand-rolled approximation.
  const real = z.object({
    email: z.string().email(),
    age: z.number().optional(),
  });
  // Carry the real Zod `type` field ("object") alongside the internals: a real
  // Zod v4 instance exposes it, and its presence is what makes the branch
  // ORDER load-bearing (codex GLU-120 P2) — if the static fallback ran AFTER
  // the `"type" in schema` plain-JSON-Schema shortcut, this fixture would leak
  // its raw internals as if already-plain (the GLU-64 bug class) and the
  // assertions below would fail.
  const staticOnly: SchemaLike<unknown> = {
    type: (real as unknown as { type: unknown }).type,
    _zod: (real as unknown as { _zod: unknown })._zod,
  } as any;
  expect((staticOnly as any).type).toBe("object"); // precondition: carries the plain-shortcut trap field
  expect(typeof (staticOnly as any).toJSONSchema).toBe("undefined"); // precondition: no instance method

  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  const c = api("fetch", {
    endpoint: "GET /x",
    cases: {
      ok: { description: "x", expect: { status: 200, schema: staticOnly } },
    },
  });

  const body = (c._extracted.cases[0].schemas as any)?.response?.body;
  // Assert shape via the real zod converter's own output (avoids hardcoding
  // zod's internal email regex, which is a zod implementation detail, not
  // something this fix should pin) rather than by-value equality.
  const expected = z.toJSONSchema(real) as Record<string, unknown>;
  delete expected.$schema; // adapter strips the per-document dialect field
  expect(body).toEqual(expected);
  expect(body.type).toBe("object");
  expect(body.properties.email.format).toBe("email");
  expect(body.properties.age).toEqual({ type: "number" });
  expect(body.required).toEqual(["email"]);
  expect(body).not.toHaveProperty("$schema"); // dialect noise stripped, same as the instance-method path
  expect(body).not.toHaveProperty("_zod"); // GLU-64: converted, NOT the raw zod internals leaked as-is
  expect(c._extracted.unprojectableSchemas).toBeUndefined();
});

test("GLU-120 + GLU-90: a static-only Zod v4 instance whose conversion throws recovers via the declared jsonSchema hint, not raw/plain fallback", () => {
  // z.date() is unrepresentable — the STATIC z.toJSONSchema() throws on it,
  // exactly like the instance-method path's z.date()/z.bigint() case. The
  // static fallback's failure must land on the declared `.jsonSchema` hint
  // (GLU-90 recovery), NOT fall through to the plain `"type" in schema`
  // shortcut (which would leak the raw zod internals — GLU-64). Real zod
  // internals are used so the throw comes from the genuine converter.
  const throwing = z.date();
  const staticOnlyThrows: SchemaLike<unknown> = {
    type: (throwing as unknown as { type: unknown }).type, // "date" — plain-shortcut trap
    _zod: (throwing as unknown as { _zod: unknown })._zod,
    jsonSchema: { type: "string", format: "date-time" },
  } as any;
  expect(typeof (staticOnlyThrows as any).toJSONSchema).toBe("undefined"); // no instance method

  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  const c = api("fetch", {
    endpoint: "GET /x",
    cases: {
      ok: { description: "x", expect: { status: 200, schema: staticOnlyThrows } },
    },
  });

  const body = (c._extracted.cases[0].schemas as any)?.response?.body;
  expect(body).toEqual({ type: "string", format: "date-time" }); // the declared hint, verbatim
  expect(body).not.toHaveProperty("_zod"); // NOT the raw zod internals
  expect(c._extracted.unprojectableSchemas).toBeUndefined();
});

test("GLU-120: an object carrying a bare `_zod` field but no `def.type` string is NOT misclassified as Zod (marker precision)", () => {
  // codex GLU-120 P2: the v4 marker requires `_zod.def.type` to be a STRING,
  // so a plain/non-Zod object that happens to carry a `_zod: { def }` field is
  // treated as plain JSON Schema (its `type` honored), NOT silently dropped as
  // an unconvertible "Zod" schema.
  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  const notZod: SchemaLike<unknown> = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    _zod: { def: {} }, // no `type` string → below the marker threshold
  } as any;
  const c = api("fetch", {
    endpoint: "GET /x",
    cases: {
      ok: { description: "x", expect: { status: 200, schema: notZod } },
    },
  });

  const body = (c._extracted.cases[0].schemas as any)?.response?.body;
  // Honored as plain JSON Schema (passed through), not dropped as unprojectable.
  expect(body).toMatchObject({ type: "object", properties: { ok: { type: "boolean" } } });
  expect(c._extracted.unprojectableSchemas).toBeUndefined();
});

test("GLU-120: a Zod v3 instance (no _zod marker, no toJSONSchema anywhere) stays unprojectable — not silently wrong", () => {
  // Zod v3 objects (`_def.typeName` shape) ship no JSON Schema conversion at
  // all, static or instance. The static fallback must NOT misfire on them —
  // it should recognize "not Zod v4-shaped" and fall through to the existing
  // unprojectable signal, exactly like before this fix (no regression: a v3
  // schema without a declared `.jsonSchema` hint was never projectable and
  // still isn't — this fix only adds the v4-static case, it doesn't invent a
  // v3 converter).
  const client = makeMockClient();
  const api = contract.http.with("api", { client });
  const v3Like: SchemaLike<unknown> = {
    safeParse: (data: unknown) => ({ success: true as const, data }),
    _def: { typeName: "ZodObject" },
  } as any;
  const c = api("fetch", {
    endpoint: "GET /x",
    cases: {
      ok: { description: "x", expect: { status: 200, schema: v3Like } },
    },
  });

  expect((c._extracted.cases[0].schemas as any)?.response?.body).toBeUndefined();
  expect(c._extracted.unprojectableSchemas).toEqual(["cases.ok.response.body"]);
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
