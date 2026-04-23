/**
 * Tests for the built-in GraphQL contract adapter.
 *
 * Scope: authoring (contract.graphql.with), projection / normalize, case
 * execution, executeCaseInFlow (deep-merge + Rule 1 teardown),
 * classifyFailure mapping (3-layer: transport / payload errors / error
 * shape), renderTarget, toMarkdown.
 *
 * Uses a mock GraphQLClient that records calls and returns canned
 * GraphQLResult envelopes.
 */

import { test, expect, beforeAll, beforeEach, describe } from "vitest";
import { contract, installPlugin, runFlow } from "@glubean/sdk";
import type { FlowContract, TestContext } from "@glubean/sdk";
import { clearRegistry } from "@glubean/sdk/internal";
import graphqlPlugin from "../index.js";

// Install the GraphQL manifest once per test file. Replaces the old
// `import "./index.js"` side-effect that used to register adapter + matchers
// at module load. Now registration is explicit and identity-tracked.
beforeAll(async () => {
  await installPlugin(graphqlPlugin);
});

import { graphqlAdapter } from "./adapter.js";
import { createGraphqlRoot } from "./factory.js";
import type { GraphQLClient, GraphQLResult } from "../index.js";
import type {
  GraphqlContractRoot,
  GraphqlContractSpec,
} from "./types.js";

// ---------------------------------------------------------------------------
// Mock GraphQL client
// ---------------------------------------------------------------------------

interface MockGqlCall {
  op: "query" | "mutation";
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  headers?: Record<string, string>;
}

function makeMockGqlClient(
  canned: Partial<GraphQLResult<unknown>> & {
    /** Dynamic canned response based on call count or variables */
    respond?: (call: MockGqlCall) => Partial<GraphQLResult<unknown>>;
  } = {},
): GraphQLClient & { _calls: MockGqlCall[] } {
  const calls: MockGqlCall[] = [];
  const build = (op: "query" | "mutation", q: string, opts: any = {}) => {
    const call: MockGqlCall = {
      op,
      query: q,
      variables: opts.variables,
      operationName: opts.operationName,
      headers: opts.headers,
    };
    calls.push(call);
    const dyn = canned.respond ? canned.respond(call) : {};
    const merged: GraphQLResult<unknown> = {
      data: canned.data ?? null,
      errors: canned.errors,
      extensions: canned.extensions,
      httpStatus: canned.httpStatus ?? 200,
      headers: canned.headers ?? {},
      rawBody: canned.rawBody ?? null,
      ...dyn,
    };
    return Promise.resolve(merged);
  };
  const client: GraphQLClient & { _calls: MockGqlCall[] } = {
    query: (<T>(q: string, opts?: any) => build("query", q, opts) as Promise<GraphQLResult<T>>) as GraphQLClient["query"],
    mutate: (<T>(q: string, opts?: any) => build("mutation", q, opts) as Promise<GraphQLResult<T>>) as GraphQLClient["mutate"],
    _calls: calls,
  };
  return client;
}

// ---------------------------------------------------------------------------
// Mock TestContext
// ---------------------------------------------------------------------------

function makeCtx(partial: Partial<TestContext> = {}): TestContext {
  const assertions: Array<{ passed: boolean; message?: string }> = [];
  const ctx = {
    vars: { get: () => undefined, require: () => { throw new Error(); }, all: () => ({}) } as any,
    secrets: { get: () => undefined, require: () => { throw new Error(); } } as any,
    log: () => {},
    assert: (cond: unknown, message?: string) => {
      assertions.push({ passed: Boolean(cond), message });
      if (!cond) throw new Error(message ?? "assertion failed");
    },
    trace: () => {},
    action: () => {},
    event: () => {},
    metric: () => {},
    http: {} as any,
    fetch: {} as any,
    expect: ((v: unknown) => {
      const e: any = {
        toBe: (other: unknown) => {
          if (v !== other) throw new Error(`toBe: ${String(v)} !== ${String(other)}`);
        },
        toEqual: (other: unknown) => {
          if (JSON.stringify(v) !== JSON.stringify(other)) {
            throw new Error(`toEqual: ${JSON.stringify(v)} !== ${JSON.stringify(other)}`);
          }
        },
        toMatchObject: (partial: Record<string, unknown>) => {
          const src = v as Record<string, unknown>;
          for (const [k, expected] of Object.entries(partial)) {
            if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
              const nested = src?.[k];
              if (!nested) throw new Error(`toMatchObject: missing ${k}`);
              for (const [nk, nv] of Object.entries(expected)) {
                if ((nested as Record<string, unknown>)[nk] !== nv) {
                  throw new Error(`toMatchObject: .${k}.${nk} mismatch`);
                }
              }
            } else if (src?.[k] !== expected) {
              throw new Error(`toMatchObject: .${k} = ${String(src?.[k])}, expected ${String(expected)}`);
            }
          }
        },
        toHaveStatus: () => {},
        toMatchSchema: () => {},
      };
      return e;
    }) as any,
    validate: (data: unknown, schema: any) => {
      if (schema && typeof schema.safeParse === "function") {
        const parsed = schema.safeParse(data);
        if (!parsed.success) throw new Error(`validate failed`);
        return parsed.data;
      }
      return data;
    },
    skip: () => {},
    ci: {} as any,
    session: { get: () => undefined, set: () => {}, require: () => { throw new Error(); }, has: () => false, entries: () => ({}) } as any,
    run: {} as any,
    getMemoryUsage: () => null,
    ...partial,
  } as unknown as TestContext & { _assertions: typeof assertions };
  (ctx as any)._assertions = assertions;
  return ctx;
}

// ---------------------------------------------------------------------------
// Registry bootstrap — fresh per-test
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearRegistry();
  contract.register("graphql", graphqlAdapter);
  {
    const dispatcher = (contract as any).graphql as Parameters<typeof createGraphqlRoot>[0];
    (contract as unknown as { graphql: GraphqlContractRoot }).graphql = createGraphqlRoot(dispatcher);
  }
});

// ---------------------------------------------------------------------------
// Factory smoke tests
// ---------------------------------------------------------------------------

describe("factory", () => {
  test("contract.graphql.with returns a factory", () => {
    const gql = (contract as any).graphql as GraphqlContractRoot;
    const factory = gql.with("api", {});
    expect(typeof factory).toBe("function");
  });

  test("direct contract.graphql(id, spec) throws with helpful error", () => {
    const gql = (contract as any).graphql;
    expect(() =>
      gql("get-user", {
        cases: { ok: { description: "ok", query: "{ user { id } }" } },
      }),
    ).toThrow(/contract\.graphql\.with/);
  });
});

// ---------------------------------------------------------------------------
// project + normalize
// ---------------------------------------------------------------------------

describe("project + normalize", () => {
  test("project emits protocol / cases with selection-set-per-case query", () => {
    const spec: GraphqlContractSpec = {
      endpoint: "/graphql",
      description: "User API",
      tags: ["users"],
      cases: {
        short: {
          description: "name only",
          query: "query GetUser { user(id:\"1\") { name } }",
        },
        full: {
          description: "name + orders",
          query: "query GetUserFull { user(id:\"1\") { name orders { id } } }",
        },
        old: { description: "legacy", query: "{ me { id } }", deprecated: "use new" },
        future: { description: "tba", query: "{ foo }", deferred: "Q3" },
      },
    };

    const projection = graphqlAdapter.project(spec);

    expect(projection.protocol).toBe("graphql");
    expect(projection.target).toBe("/graphql");
    expect(projection.cases).toHaveLength(4);

    const shortCase = projection.cases.find((c) => c.key === "short")!;
    expect(shortCase.schemas?.operation).toBe("query");
    expect(shortCase.schemas?.operationName).toBe("GetUser");
    expect(shortCase.schemas?.query).toContain("{ name }");

    const fullCase = projection.cases.find((c) => c.key === "full")!;
    expect(fullCase.schemas?.query).toContain("orders");
    // Selection-set-per-case: different query for different case
    expect(fullCase.schemas?.query).not.toBe(shortCase.schemas?.query);

    expect(projection.cases.find((c) => c.key === "old")!.lifecycle).toBe("deprecated");
    expect(projection.cases.find((c) => c.key === "future")!.lifecycle).toBe("deferred");
  });

  test("project defaults operation to 'query' when not specified", () => {
    const spec: GraphqlContractSpec = {
      cases: { ok: { description: "ok", query: "{ hi }" } },
    };
    const p = graphqlAdapter.project(spec);
    expect(p.cases[0].schemas?.operation).toBe("query");
  });

  test("project respects spec-level defaultOperation", () => {
    const spec: GraphqlContractSpec = {
      defaultOperation: "mutation",
      cases: { ok: { description: "ok", query: "mutation Do { do }" } },
    };
    const p = graphqlAdapter.project(spec);
    expect(p.cases[0].schemas?.operation).toBe("mutation");
  });

  test("project preserves explicit types map (Phase 2 projection hint)", () => {
    const spec: GraphqlContractSpec = {
      types: {
        User: { id: "ID!", name: "String!" },
        Order: { id: "ID!" },
      },
      cases: { ok: { description: "ok", query: "{ user { name } }" } },
    };
    const p = graphqlAdapter.project(spec);
    expect(p.meta?.types).toEqual({
      User: { id: "ID!", name: "String!" },
      Order: { id: "ID!" },
    });
  });

  test("normalize produces JSON-safe projection", () => {
    const spec: GraphqlContractSpec = {
      endpoint: "/graphql",
      cases: { ok: { description: "ok", query: "{ hi }" } },
    };
    const runtime = graphqlAdapter.project(spec);
    const extracted = graphqlAdapter.normalize!({ ...runtime, id: "my-gql" });

    expect(extracted.id).toBe("my-gql");
    expect(extracted.protocol).toBe("graphql");
    expect(extracted.cases[0].key).toBe("ok");
    expect(() => JSON.parse(JSON.stringify(extracted))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// endpoint — projection-only contract (RFR P1 addressed 2026-04-21)
// ---------------------------------------------------------------------------
//
// `spec.endpoint` / `defaults.endpoint` travel on projection meta for
// markdown + scanner + MCP display, but the adapter does NOT redirect the
// live call. Runtime dispatches through the supplied GraphQLClient, whose
// endpoint is fixed at construction time.

describe("endpoint is projection-only (not runtime override)", () => {
  test("execute: spec.endpoint is NOT forwarded to client.query options", async () => {
    const client = makeMockGqlClient({ data: {}, httpStatus: 200 });

    const spec: GraphqlContractSpec = {
      endpoint: "/this-endpoint-must-not-reach-the-client",
      client,
      cases: { ok: { description: "ok", query: "{ hi }" } },
    };

    await graphqlAdapter.execute(makeCtx(), spec.cases.ok as any, spec as any);

    expect(client._calls).toHaveLength(1);
    // Adapter must never smuggle an endpoint into client call options — the
    // mock records every option it receives; none should be an `endpoint` key.
    expect(client._calls[0]).not.toHaveProperty("endpoint");
  });

  test("project: spec.endpoint surfaces on projection meta for display", () => {
    const spec: GraphqlContractSpec = {
      endpoint: "/graphql/v2",
      cases: { ok: { description: "ok", query: "{ hi }" } },
    };
    const projection = graphqlAdapter.project(spec);
    expect(projection.meta?.endpoint).toBe("/graphql/v2");
    expect(projection.target).toBe("/graphql/v2");
  });

  test("instance default endpoint merges into meta for projection display only", () => {
    const client = makeMockGqlClient({ data: {}, httpStatus: 200 });
    const api = (contract as any).graphql.with("api", {
      client,
      endpoint: "/display-only",
    });
    const c = api("c", {
      cases: { ok: { description: "ok", query: "{ hi }" } },
    });
    // Projection meta reflects the instance-level endpoint (for markdown).
    expect(c._projection.meta.endpoint).toBe("/display-only");
  });
});

// ---------------------------------------------------------------------------
// renderTarget + markdown artifact
// ---------------------------------------------------------------------------

describe("renderTarget + markdown artifact", () => {
  test("renderTarget returns endpoint as-is", () => {
    expect(graphqlAdapter.renderTarget!("/graphql")).toBe("/graphql");
  });

  test("renderTarget returns '(graphql)' when endpoint missing", () => {
    expect(graphqlAdapter.renderTarget!("")).toBe("(graphql)");
  });

  test("artifacts.markdown produces structured output via renderArtifact", async () => {
    const { renderArtifact, markdownArtifact } = await import("@glubean/sdk");
    const spec: GraphqlContractSpec = {
      endpoint: "/graphql",
      description: "User API",
      cases: {
        ok: {
          description: "happy",
          query: "query GetUser { user { name } }",
        },
        create: {
          description: "create",
          operation: "mutation",
          query: "mutation NewUser($i: Input!) { createUser(input: $i) { id } }",
        },
        old: {
          description: "legacy",
          query: "{ me { id } }",
          deprecated: "use new",
        },
      },
    };
    const runtime = graphqlAdapter.project(spec);
    const extracted = graphqlAdapter.normalize!({ ...runtime, id: "users-gql" });
    const md = renderArtifact(markdownArtifact, [extracted as any]);

    // CLI-format output (see sdk assembleMarkdownDocument):
    //   "## <feature or endpoint>" heading, "- **key** — desc" for active
    //   cases, "⊘ **key** — deprecated: <reason>" shadows description for
    //   deprecated cases.
    expect(md).toContain("## /graphql"); // feature unset → heading uses endpoint
    expect(md).toContain("- **ok** — happy");
    expect(md).toContain("- **create** — create");
    expect(md).toContain("⊘ **old** — deprecated: use new");
  });
});

// ---------------------------------------------------------------------------
// classifyFailure — 3-layer (transport / payload / error shape)
// ---------------------------------------------------------------------------

describe("classifyFailure (3-layer)", () => {
  const classifyGql = (data: Record<string, unknown>) =>
    graphqlAdapter.classifyFailure!({
      events: [{ type: "graphql_response", data }],
    });

  test("HTTP 401 → auth (transport layer wins)", () => {
    const c = classifyGql({ httpStatus: 401 })!;
    expect(c.kind).toBe("auth");
  });

  test("HTTP 403 → auth", () => {
    expect(classifyGql({ httpStatus: 403 })!.kind).toBe("auth");
  });

  test("HTTP 429 → transient retryable", () => {
    const c = classifyGql({ httpStatus: 429 })!;
    expect(c.kind).toBe("transient");
    expect(c.retryable).toBe(true);
  });

  test("HTTP 4xx (generic) → client", () => {
    expect(classifyGql({ httpStatus: 400 })!.kind).toBe("client");
  });

  test("HTTP 503 → transient retryable", () => {
    const c = classifyGql({ httpStatus: 503 })!;
    expect(c.kind).toBe("transient");
    expect(c.retryable).toBe(true);
  });

  test("HTTP 500 (generic) → server", () => {
    expect(classifyGql({ httpStatus: 500 })!.kind).toBe("server");
  });

  test("HTTP 200 OK + no errors → undefined (success)", () => {
    expect(classifyGql({ httpStatus: 200 })).toBeUndefined();
  });

  test("HTTP 200 + errors[0].extensions.code=UNAUTHENTICATED → auth (payload layer)", () => {
    const c = classifyGql({
      httpStatus: 200,
      errors: [{ message: "nope", extensions: { code: "UNAUTHENTICATED" } }],
    })!;
    expect(c.kind).toBe("auth");
  });

  test("HTTP 200 + BAD_USER_INPUT → client", () => {
    const c = classifyGql({
      httpStatus: 200,
      errors: [{ message: "bad", extensions: { code: "BAD_USER_INPUT" } }],
    })!;
    expect(c.kind).toBe("client");
  });

  test("HTTP 200 + INTERNAL_SERVER_ERROR → server", () => {
    expect(
      classifyGql({
        httpStatus: 200,
        errors: [{ message: "oops", extensions: { code: "INTERNAL_SERVER_ERROR" } }],
      })!.kind,
    ).toBe("server");
  });

  test("HTTP 200 + error with unknown/missing code → semantic", () => {
    expect(
      classifyGql({
        httpStatus: 200,
        errors: [{ message: "something", extensions: { code: "USER_NOT_FOUND" } }],
      })!.kind,
    ).toBe("semantic");

    expect(
      classifyGql({
        httpStatus: 200,
        errors: [{ message: "bare error" }],
      })!.kind,
    ).toBe("semantic");
  });

  test("falls back to http_response event when graphql_response absent", () => {
    const c = graphqlAdapter.classifyFailure!({
      events: [{ type: "http_response", data: { status: 502 } }],
    })!;
    expect(c.kind).toBe("transient");
    expect(c.retryable).toBe(true);
  });

  test("TimeoutError → transient retryable", () => {
    const err = new Error("timeout");
    err.name = "TimeoutError";
    const c = graphqlAdapter.classifyFailure!({ error: err, events: [] })!;
    expect(c.kind).toBe("transient");
    expect(c.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// executeCaseInFlow — deep-merge + typed state
// ---------------------------------------------------------------------------

describe("executeCaseInFlow + flow integration", () => {
  test("flow step deep-merges lens variables over case static + defaultVariables", async () => {
    const client = makeMockGqlClient({
      data: { user: { name: "alice" } },
      httpStatus: 200,
    });
    const api = (contract as any).graphql.with("api", { client });
    const getUser = api("get-user", {
      endpoint: "/graphql",
      defaultVariables: { locale: "en" },
      cases: {
        ok: {
          description: "happy",
          query: "query GetUser($id: ID!) { user(id:$id) { name } }",
          variables: { tier: "premium" },
        },
      },
    });

    const flowObj = contract
      .flow("user-flow")
      .setup(async () => ({ userId: "u-1" }))
      .step(getUser.case("ok"), {
        in: (s: any) => ({ variables: { id: s.userId } }),
      })
      .build() as FlowContract<unknown>;

    await runFlow(flowObj, makeCtx());

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe("query");
    expect(client._calls[0].variables).toEqual({
      locale: "en",     // from defaultVariables
      tier: "premium",  // from case.variables
      id: "u-1",        // from lens
    });
  });

  test("flow step output available via out lens (envelope fields present)", async () => {
    const client = makeMockGqlClient({
      data: { createUser: { id: "u-9" } },
      httpStatus: 200,
      headers: { "x-request-id": "rid-1" },
      rawBody: '{"data":{"createUser":{"id":"u-9"}}}',
    });
    const api = (contract as any).graphql.with("api", { client });
    const mutContract = api("create-user", {
      defaultOperation: "mutation",
      cases: {
        ok: {
          description: "ok",
          query: "mutation New($i: Input!) { createUser(input:$i) { id } }",
        },
      },
    });

    let captured: any;
    const flowObj = contract
      .flow("f")
      .setup(async () => ({}))
      .step(mutContract.case("ok"), {
        out: (_s: any, res: any) => {
          captured = res;
          return { id: res.data.createUser.id };
        },
      })
      .build() as FlowContract<unknown>;

    await runFlow(flowObj, makeCtx());

    expect(captured.data.createUser.id).toBe("u-9");
    expect(captured.httpStatus).toBe(200);
    expect(captured.headers["x-request-id"]).toBe("rid-1");
    expect(captured.rawBody).toContain("u-9");
    expect(captured.operationName).toBe("New");
    expect(client._calls[0].op).toBe("mutation");
  });

  test("headers merge contract < lens in flow mode", async () => {
    const client = makeMockGqlClient({ data: {}, httpStatus: 200 });
    const api = (contract as any).graphql.with("api", {
      client,
      headers: { "x-instance-tag": "a" },
    });
    const c = api("c", {
      defaultHeaders: { "x-contract-tag": "b" },
      cases: {
        ok: {
          description: "ok",
          query: "{ hi }",
          headers: { "x-case-tag": "c" },
        },
      },
    });

    const flowObj = contract
      .flow("f")
      .setup(async () => ({}))
      .step(c.case("ok"), {
        in: () => ({ headers: { "x-lens-tag": "d" } }),
      })
      .build() as FlowContract<unknown>;

    await runFlow(flowObj, makeCtx());

    const headers = client._calls[0].headers!;
    expect(headers).toMatchObject({
      "x-contract-tag": "b",
      "x-case-tag": "c",
      "x-lens-tag": "d",
    });
  });
});

// ---------------------------------------------------------------------------
// validateCaseForFlow — reject function-valued fields in flow mode
// ---------------------------------------------------------------------------

describe("validateCaseForFlow", () => {
  test("rejects function-valued variables", () => {
    const client = makeMockGqlClient();
    const api = (contract as any).graphql.with("api", { client });
    const c = api("c", {
      cases: {
        ok: {
          description: "needs state",
          query: "{ hi }",
          setup: async () => ({ v: 1 }),
          variables: (s: any) => ({ v: s.v }),
        },
      },
    });

    expect(() =>
      contract.flow("f").step(c.case("ok") as any),
    ).toThrow(/function-valued variables.*flow/);
  });

  test("rejects function-valued headers", () => {
    const client = makeMockGqlClient();
    const api = (contract as any).graphql.with("api", { client });
    const c = api("c", {
      cases: {
        ok: {
          description: "needs state",
          query: "{ hi }",
          setup: async () => ({ t: "tok" }),
          headers: (s: any) => ({ authorization: `Bearer ${s.t}` }),
        },
      },
    });

    expect(() =>
      contract.flow("f").step(c.case("ok") as any),
    ).toThrow(/function-valued.*headers/);
  });
});

// ---------------------------------------------------------------------------
// Direct graphqlAdapter.execute (non-flow) path
// ---------------------------------------------------------------------------

describe("graphqlAdapter.execute (non-flow path)", () => {
  test("execute: happy query with data + errors='absent'", async () => {
    const client = makeMockGqlClient({
      data: { user: { name: "alice" } },
      httpStatus: 200,
    });

    const spec: GraphqlContractSpec = {
      endpoint: "/graphql",
      client,
      cases: {
        ok: {
          description: "greet",
          query: "query GetUser($id: ID!) { user(id:$id) { name } }",
          variables: { id: "u-1" } as any,
          expect: {
            httpStatus: 200,
            data: { user: { name: "alice" } } as any,
            errors: "absent",
          },
        },
      },
    };

    const ctx = makeCtx();
    await graphqlAdapter.execute(ctx, spec.cases.ok as any, spec as any);

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].op).toBe("query");
    expect(client._calls[0].variables).toEqual({ id: "u-1" });
    expect(client._calls[0].operationName).toBe("GetUser");
  });

  test("execute: mutation goes through client.mutate", async () => {
    const client = makeMockGqlClient({
      data: { createUser: { id: "u-1" } },
      httpStatus: 200,
    });

    const spec: GraphqlContractSpec = {
      client,
      cases: {
        ok: {
          description: "create",
          operation: "mutation",
          query: "mutation New($i: Input!) { createUser(input:$i) { id } }",
          variables: { i: { name: "alice" } } as any,
        },
      },
    };

    const ctx = makeCtx();
    await graphqlAdapter.execute(ctx, spec.cases.ok as any, spec as any);

    expect(client._calls[0].op).toBe("mutation");
  });

  test("execute: deep-merges defaultVariables + case.variables", async () => {
    const client = makeMockGqlClient({ data: {}, httpStatus: 200 });

    const spec: GraphqlContractSpec = {
      client,
      defaultVariables: { locale: "en", tier: "standard" } as any,
      cases: {
        ok: {
          description: "merge",
          query: "query Get($id: ID!) { user(id:$id) { name } }",
          variables: { id: "u-1", tier: "premium" } as any,
        },
      },
    };

    const ctx = makeCtx();
    await graphqlAdapter.execute(ctx, spec.cases.ok as any, spec as any);

    expect(client._calls[0].variables).toEqual({
      locale: "en",      // from defaultVariables
      tier: "premium",   // case override
      id: "u-1",         // from case
    });
  });

  test("execute: runs setup → teardown even on assertion failure", async () => {
    const client = makeMockGqlClient({
      data: { user: { name: "wrong" } },
      httpStatus: 200,
    });

    const order: string[] = [];
    const spec: GraphqlContractSpec = {
      client,
      cases: {
        ok: {
          description: "lifecycle",
          query: "{ user { name } }",
          setup: async () => {
            order.push("setup");
            return { tag: "x" };
          },
          teardown: async () => {
            order.push("teardown");
          },
          expect: {
            data: { user: { name: "alice" } } as any, // mismatch → throws
          },
        },
      },
    };

    const ctx = makeCtx();
    await expect(
      graphqlAdapter.execute(ctx, spec.cases.ok as any, spec as any),
    ).rejects.toThrow();
    expect(order).toEqual(["setup", "teardown"]);
  });

  test("execute: function-valued variables / headers receive setup state", async () => {
    const client = makeMockGqlClient({ data: {}, httpStatus: 200 });

    const spec: GraphqlContractSpec = {
      client,
      cases: {
        ok: {
          description: "fn fields",
          query: "{ me { id } }",
          setup: async () => ({ userId: "u-1", token: "t-1" }),
          variables: (state: any) => ({ id: state.userId }),
          headers: (state: any) => ({ authorization: `Bearer ${state.token}` }),
        },
      },
    };

    const ctx = makeCtx();
    await graphqlAdapter.execute(ctx, spec.cases.ok as any, spec as any);

    expect(client._calls[0].variables).toEqual({ id: "u-1" });
    expect(client._calls[0].headers).toMatchObject({ authorization: "Bearer t-1" });
  });

  test("execute: HTTP status mismatch throws with helpful message", async () => {
    const client = makeMockGqlClient({
      data: null,
      httpStatus: 500,
    });

    const spec: GraphqlContractSpec = {
      client,
      cases: {
        ok: {
          description: "expects 200",
          query: "{ hi }",
          expect: { httpStatus: 200 },
        },
      },
    };

    const ctx = makeCtx();
    await expect(
      graphqlAdapter.execute(ctx, spec.cases.ok as any, spec as any),
    ).rejects.toThrow(/HTTP status 200.*got 500/);
  });

  test("execute: expected HTTP 401 passes for auth-negative case", async () => {
    const client = makeMockGqlClient({ data: null, httpStatus: 401 });
    const spec: GraphqlContractSpec = {
      client,
      cases: {
        unauth: {
          description: "missing token yields 401",
          query: "{ me { id } }",
          expect: { httpStatus: 401, errors: "any" },
        },
      },
    };

    await graphqlAdapter.execute(makeCtx(), spec.cases.unauth as any, spec as any);
    expect(client._calls).toHaveLength(1);
  });

  test("execute: errors='absent' rejects when server returns errors", async () => {
    const client = makeMockGqlClient({
      data: null,
      errors: [{ message: "validation" }],
      httpStatus: 200,
    });
    const spec: GraphqlContractSpec = {
      client,
      cases: {
        ok: {
          description: "strict success",
          query: "{ hi }",
          expect: { errors: "absent" },
        },
      },
    };

    await expect(
      graphqlAdapter.execute(makeCtx(), spec.cases.ok as any, spec as any),
    ).rejects.toThrow(/GraphQL errors/);
  });

  test("execute: partial errors array matches by extensions.code", async () => {
    const client = makeMockGqlClient({
      data: null,
      errors: [
        { message: "no perms", extensions: { code: "FORBIDDEN", metadata: "x" } },
      ],
      httpStatus: 200,
    });
    const spec: GraphqlContractSpec = {
      client,
      cases: {
        forbidden: {
          description: "expects FORBIDDEN",
          query: "{ hi }",
          expect: {
            errors: [{ extensions: { code: "FORBIDDEN" } }],
          },
        },
      },
    };

    await graphqlAdapter.execute(makeCtx(), spec.cases.forbidden as any, spec as any);
    expect(client._calls).toHaveLength(1);
  });

  test("execute: verify receives GraphqlCaseResult with envelope fields", async () => {
    const client = makeMockGqlClient({
      data: { hi: "world" },
      httpStatus: 200,
      headers: { "x-tag": "v" },
      rawBody: '{"data":{"hi":"world"}}',
    });

    let captured: any;
    const spec: GraphqlContractSpec = {
      client,
      cases: {
        ok: {
          description: "verify receives result",
          query: "query Hi { hi }",
          expect: { errors: "absent" },
          verify: (_ctx, res) => {
            captured = res;
          },
        },
      },
    };

    await graphqlAdapter.execute(makeCtx(), spec.cases.ok as any, spec as any);

    expect(captured.data).toEqual({ hi: "world" });
    expect(captured.httpStatus).toBe(200);
    expect(captured.headers["x-tag"]).toBe("v");
    expect(captured.rawBody).toContain("world");
    expect(captured.operationName).toBe("Hi");
  });

  test("execute: missing query throws authoring error", async () => {
    const client = makeMockGqlClient();
    const spec: GraphqlContractSpec = {
      client,
      cases: {
        ok: { description: "no query", query: undefined as any },
      },
    };

    await expect(
      graphqlAdapter.execute(makeCtx(), spec.cases.ok as any, spec as any),
    ).rejects.toThrow(/query.*required/);
  });
});

// ---------------------------------------------------------------------------
// Schema validation failure path
// ---------------------------------------------------------------------------

describe("schema validation failure path", () => {
  const rejectSchema = {
    safeParse: (_data: unknown) => ({
      success: false as const,
      error: { issues: [{ message: "schema rejects all" }] },
    }),
  };

  test("execute: response-data schema failure throws via ctx.validate", async () => {
    const client = makeMockGqlClient({
      data: { anything: "yes" },
      httpStatus: 200,
    });
    const spec: GraphqlContractSpec = {
      client,
      cases: {
        ok: {
          description: "schema rejects",
          query: "{ hi }",
          expect: { schema: rejectSchema as any },
        },
      },
    };

    await expect(
      graphqlAdapter.execute(makeCtx(), spec.cases.ok as any, spec as any),
    ).rejects.toThrow(/validate failed/);
  });

  test("executeCaseInFlow: schema failure propagates (flow path parity)", async () => {
    const client = makeMockGqlClient({ data: { any: "x" }, httpStatus: 200 });
    const api = (contract as any).graphql.with("api", { client });
    const c = api("c-flow", {
      cases: {
        ok: {
          description: "flow schema reject",
          query: "{ hi }",
          expect: { schema: rejectSchema as any },
        },
      },
    });

    const flowObj = contract
      .flow("schema-fail-flow")
      .setup(async () => ({}))
      .step(c.case("ok"))
      .build() as FlowContract<unknown>;

    await expect(runFlow(flowObj, makeCtx())).rejects.toThrow(/validate failed/);
  });
});
