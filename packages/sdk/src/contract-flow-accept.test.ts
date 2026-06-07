/**
 * Phase 4 — `accept` multi-status outcome model.
 *
 * `accept` lets a flow step treat extra outcome keys (HTTP: status numbers) as
 * legal so the RAW response reaches `out`/state for a condition to branch on —
 * the signature status-gated use case (200 → use / 404 → create). When the
 * actual status is an accepted alternate (in `accept` and != primary
 * expect.status), the adapter skips the case's primary validation
 * (status/schema/headers/verify) and returns the raw outcome.
 *
 * Runtime behavior runs under vitest; the `accept` / `res`-type machinery is
 * checked at compile time in `_acceptTypeTests` (validated by `tsc --noEmit`).
 */
import { test, expect, beforeEach } from "vitest";
import { contract, runFlow } from "./index.js";
import type { FlowContract } from "./contract-types.js";
import type { HttpClient, HttpResponsePromise, SchemaLike, TestContext } from "./types.js";
import { clearRegistry } from "./internal.js";
import { clearBootstrapRegistry } from "./bootstrap-registry.js";
import { Expectation } from "./expect.js";

function makeMockClient(
  canned: { status?: number; body?: unknown; headers?: Record<string, string> } = {},
): HttpClient & { _calls: number } {
  const state = { _calls: 0 };
  const respond = () => (url: string | URL | Request, opts?: Record<string, unknown>) => {
    state._calls++;
    void url;
    void opts;
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
  const client: any = respond();
  for (const m of ["get", "post", "put", "patch", "delete", "head"]) client[m] = respond();
  client.extend = () => client;
  Object.defineProperty(client, "_calls", { get: () => state._calls });
  return client as HttpClient & { _calls: number };
}

function makeCtx(opts: { validate?: (v: unknown) => unknown } = {}): TestContext {
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
        if (!emission.passed) throw new Error(emission.message ?? "assertion failed");
      })) as any,
    validate: (opts.validate ?? ((v: unknown) => v)) as any,
    skip: () => { throw new Error("skipped"); },
    ci: {} as any,
    session: { get: () => undefined, set: () => {}, require: () => { throw new Error(); }, has: () => false, entries: () => ({}) } as any,
    run: {} as any,
    getMemoryUsage: () => null,
  } as unknown as TestContext;
}

beforeEach(() => {
  clearRegistry();
  clearBootstrapRegistry();
});

test("accepted alternate status: 404 does not fail, raw response reaches out + condition branches", async () => {
  const client = makeMockClient({ status: 404, body: { error: "not found" } });
  const api = contract.http.with("api", { client });
  const lookup = api("lookup", {
    endpoint: "GET /users/:id",
    cases: { byId: { description: "lookup", expect: { status: 200 } } },
  });

  let final: any;
  const flowObj = contract
    .flow("create-or-fetch")
    .setup(async () => ({ id: "u1", route: "" }))
    .step(lookup.case("byId"), {
      accept: [200, 404],
      out: (s, res) => ({ ...s, status: res.status, body: res.body }),
    })
    .condition(
      { predicate: (w) => w.when((s) => s.status).eq(404) },
      (b) => b.compute((s) => ({ ...s, route: "create" })),
      (b) => b.compute((s) => ({ ...s, route: "use" })),
    )
    .teardown(async (_c, s) => { final = s; })
    .build() as FlowContract<unknown>;

  await runFlow(flowObj, makeCtx());
  expect(final.status).toBe(404);
  expect(final.route).toBe("create"); // branched on the accepted 404
});

test("primary status (200) still gets full validation when also listed in accept", async () => {
  const client = makeMockClient({ status: 200, body: { id: "u1" } });
  const api = contract.http.with("api", { client });
  let validateCalls = 0;
  const lookup = api("lookup", {
    endpoint: "GET /users/:id",
    cases: {
      byId: {
        description: "lookup",
        expect: { status: 200, schema: {} as SchemaLike<{ id: string }> },
      },
    },
  });

  let final: any;
  const flowObj = contract
    .flow("primary-validates")
    .setup(async () => ({ id: "u1" }))
    .step(lookup.case("byId"), {
      accept: [200, 404],
      out: (s, res) => ({ ...s, status: res.status }),
    })
    .teardown(async (_c, s) => { final = s; })
    .build() as FlowContract<unknown>;

  await runFlow(flowObj, makeCtx({ validate: (v) => { validateCalls++; return v; } }));
  expect(final.status).toBe(200);
  expect(validateCalls).toBeGreaterThan(0); // schema validation ran for the primary status
});

test("accepted alternate SKIPS the case schema/verify (only the primary status is validated)", async () => {
  // ctx.validate throws if called; the 404 alternate must skip schema validation.
  const client = makeMockClient({ status: 404, body: { wrong: "shape" } });
  const api = contract.http.with("api", { client });
  const lookup = api("lookup", {
    endpoint: "GET /users/:id",
    cases: {
      byId: {
        description: "lookup",
        expect: { status: 200, schema: {} as SchemaLike<{ id: string }> },
      },
    },
  });

  let final: any;
  const flowObj = contract
    .flow("alt-skips-schema")
    .setup(async () => ({ id: "u1" }))
    .step(lookup.case("byId"), {
      accept: [404],
      out: (s, res) => ({ ...s, status: res.status }),
    })
    .teardown(async (_c, s) => { final = s; })
    .build() as FlowContract<unknown>;

  // validate throws — if the alternate ran the 200 schema, this would reject
  await runFlow(flowObj, makeCtx({ validate: () => { throw new Error("VALIDATE_CALLED"); } }));
  expect(final.status).toBe(404);
});

test("backward compat: without accept, a non-primary status still fails", async () => {
  const client = makeMockClient({ status: 404 });
  const api = contract.http.with("api", { client });
  const lookup = api("lookup", {
    endpoint: "GET /users/:id",
    cases: { byId: { description: "lookup", expect: { status: 200 } } },
  });

  const flowObj = contract
    .flow("no-accept-fails")
    .setup(async () => ({ id: "u1" }))
    .step(lookup.case("byId"), { out: (s) => s })
    .build() as FlowContract<unknown>;

  await expect(runFlow(flowObj, makeCtx())).rejects.toThrow();
});

test("a status NOT in accept still fails (accept is an allow-list, not a wildcard)", async () => {
  const client = makeMockClient({ status: 500 });
  const api = contract.http.with("api", { client });
  const lookup = api("lookup", {
    endpoint: "GET /users/:id",
    cases: { byId: { description: "lookup", expect: { status: 200 } } },
  });

  const flowObj = contract
    .flow("unlisted-status-fails")
    .setup(async () => ({ id: "u1" }))
    .step(lookup.case("byId"), {
      accept: [200, 404], // 500 not listed
      out: (s, res) => ({ ...s, status: res.status }),
    })
    .build() as FlowContract<unknown>;

  await expect(runFlow(flowObj, makeCtx())).rejects.toThrow();
});

test("accept is preserved in the extracted flow projection", () => {
  const client = makeMockClient({ status: 200 });
  const api = contract.http.with("api", { client });
  const lookup = api("lookup", {
    endpoint: "GET /users/:id",
    cases: { byId: { description: "lookup", expect: { status: 200 } } },
  });

  const flowObj = contract
    .flow("projection-carries-accept")
    .setup(async () => ({ id: "u1" }))
    .step(lookup.case("byId"), {
      accept: [200, 404],
      out: (s, res) => ({ ...s, status: res.status }),
    })
    .build() as FlowContract<unknown>;

  const ext = flowObj._extracted.steps[0] as any;
  expect(ext.kind).toBe("contract-call");
  expect(ext.accept).toEqual([200, 404]);
});

// =============================================================================
// Compile-time type tests (never executed; checked by `tsc --noEmit`).
// =============================================================================
// Opt-out: an adapter whose PayloadSchemas has no `__acceptKey` marker resolves
// `InferAcceptKey` to `never`, so `accept` is rejected; HTTP resolves to number.
type _AcceptHttp = import("./contract-types.js").InferAcceptKey<
  import("./contract-http/types.js").HttpPayloadSchemas
>;
type _AcceptUnmarked = import("./contract-types.js").InferAcceptKey<{ foo: string }>;
const _acceptHttpIsNumber: _AcceptHttp = 404; // number — ok
void _acceptHttpIsNumber;
// @ts-expect-error unmarked adapter → InferAcceptKey is `never`, no value assignable
const _acceptUnmarkedIsNever: _AcceptUnmarked = 1;
void _acceptUnmarkedIsNever;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _acceptTypeTests() {
  const api = contract.http.with("api", { client: {} as HttpClient });
  const lookup = api("lookup", {
    endpoint: "GET /users/:id",
    cases: { byId: { description: "d", expect: { status: 200 } } },
  });
  const ref = lookup.case("byId");

  const fb = contract.flow("tt").setup(async () => ({ id: "u1" }));

  // With accept → res is the raw HttpFlowCaseOutput: res.status is number, body unknown.
  fb.step(ref, {
    accept: [200, 404],
    out: (s, res) => {
      const n: number = res.status;
      void n;
      return { ...s, n };
    },
  });

  // accept element type is number → a string element is rejected.
  fb.step(ref, {
    // @ts-expect-error accept element must be number (HTTP status), not string
    accept: ["200"],
    out: (s) => s,
  });

  // Without accept → res is the primary CaseOutput: for HTTP that is now
  // `HttpFlowCaseOutput` (ApplyCaseOutput marker), so `res.status` is accessible
  // directly (no narrow needed). `res.body` is typed from the case's `expect.schema`
  // when present, else `unknown`.
  fb.step(ref, {
    out: (s, res) => {
      const n: number = res.status;
      void n;
      return s;
    },
  });
}

test("Phase 4 accept type tests compile", () => {
  expect(typeof _acceptTypeTests).toBe("function");
});
