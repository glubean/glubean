/**
 * Tests for the built-in gRPC contract adapter.
 *
 * Scope: authoring (contract.grpc.with), projection / normalize, case
 * execution, executeCaseInFlow (deep-merge + Rule 1 teardown),
 * classifyFailure mapping, renderTarget, toMarkdown.
 *
 * Uses a mock GrpcClient that records calls and returns canned responses.
 */

import { test, expect, beforeAll, beforeEach, describe } from "vitest";
import { contract, installPlugin, runFlow } from "@glubean/sdk";
import type { FlowContract, TestContext } from "@glubean/sdk";
import { clearRegistry } from "@glubean/sdk/internal";
import grpcPlugin from "../index.js";

// Install the gRPC manifest once per test file. Replaces the old
// `import "./index.js"` side-effect that used to register adapter + matchers
// at module load. Registration is now explicit and identity-tracked.
beforeAll(async () => {
  await installPlugin(grpcPlugin);
});

import { grpcAdapter } from "./adapter.js";
import { createGrpcRoot } from "./factory.js";
import type { GrpcClient } from "../index.js";
import type {
  GrpcContractRoot,
  GrpcContractSpec,
} from "./types.js";

// ---------------------------------------------------------------------------
// Mock gRPC client
// ---------------------------------------------------------------------------

interface MockGrpcCall {
  method: string;
  request: Record<string, unknown>;
  options: Record<string, unknown>;
}

function makeMockGrpcClient(
  canned: {
    message?: unknown;
    statusCode?: number;
    statusDetails?: string;
    responseMetadata?: Record<string, string>;
    duration?: number;
  } = {},
): GrpcClient & { _calls: MockGrpcCall[] } {
  const calls: MockGrpcCall[] = [];
  const client: GrpcClient & { _calls: MockGrpcCall[] } = {
    async call<T = unknown>(
      method: string,
      request: Record<string, unknown>,
      options?: { metadata?: Record<string, string>; deadlineMs?: number },
    ) {
      calls.push({ method, request, options: (options ?? {}) as Record<string, unknown> });
      return {
        message: (canned.message ?? {}) as T,
        status: {
          code: canned.statusCode ?? 0,
          details: canned.statusDetails ?? "OK",
        },
        responseMetadata: canned.responseMetadata ?? {},
        duration: canned.duration ?? 1,
      };
    },
    close: () => {},
    raw: {} as GrpcClient["raw"],
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
  // Re-register gRPC adapter + wrap factory (mirrors what installPlugin(grpcPlugin) does)
  contract.register("grpc", grpcAdapter);
  {
    const dispatcher = (contract as any).grpc as Parameters<typeof createGrpcRoot>[0];
    (contract as unknown as { grpc: GrpcContractRoot }).grpc = createGrpcRoot(dispatcher);
  }
});

// ---------------------------------------------------------------------------
// Factory smoke tests
// ---------------------------------------------------------------------------

describe("factory", () => {
  test("contract.grpc.with returns a factory", () => {
    const grpc = contract.grpc;
    const factory = grpc.with("users", {});
    expect(typeof factory).toBe("function");
    const carrier = factory("typed-payment", {
      target: "PaymentService/Complete",
      cases: { ok: { description: "ok" } },
    });
    expect(typeof carrier.case).toBe("function");
  });

  test("direct contract.grpc(id, spec) throws with helpful error", () => {
    const grpc = (contract as any).grpc;
    expect(() =>
      grpc("payment", {
        target: "PaymentService/Complete",
        cases: { ok: { description: "ok" } },
      }),
    ).toThrow(/contract\.grpc\.with/);
  });
});

// ---------------------------------------------------------------------------
// project + normalize
// ---------------------------------------------------------------------------

describe("project + normalize", () => {
  test("project emits protocol / target / cases with lifecycle", () => {
    const spec: GrpcContractSpec = {
      target: "PaymentService/Complete",
      description: "Payment completion",
      tags: ["billing"],
      cases: {
        ok: {
          description: "happy",
          expect: { statusCode: 0 },
          given: "payment intent exists",
          verifyRules: ["settlement event is emitted"],
          verify: async () => {},
        },
        legacyFlow: { description: "old", deprecated: "use v2" },
        notYet: { description: "future", deferred: "Q3" },
      },
    };

    const projection = grpcAdapter.project(spec);

    expect(projection.protocol).toBe("grpc");
    expect(projection.target).toBe("PaymentService/Complete");
    expect(projection.tags).toEqual(["billing"]);
    expect(projection.cases).toHaveLength(3);

    const okCase = projection.cases.find((c) => c.key === "ok")!;
    expect(okCase.lifecycle).toBe("active");
    expect(okCase.given).toBe("payment intent exists");
    expect(okCase.hasVerify).toBe(true);
    expect(okCase.verifyRules).toEqual(["settlement event is emitted"]);

    const deprecatedCase = projection.cases.find((c) => c.key === "legacyFlow")!;
    expect(deprecatedCase.lifecycle).toBe("deprecated");
    expect(deprecatedCase.deprecatedReason).toBe("use v2");

    const deferredCase = projection.cases.find((c) => c.key === "notYet")!;
    expect(deferredCase.lifecycle).toBe("deferred");
    expect(deferredCase.deferredReason).toBe("Q3");

    expect(projection.meta).toMatchObject({
      target: "PaymentService/Complete",
      service: "PaymentService",
      method: "Complete",
    });
  });

  test("normalize produces JSON-safe projection", () => {
    const spec: GrpcContractSpec = {
      target: "A/B",
      cases: {
        ok: {
          description: "ok",
          given: "account exists",
          verifyRules: [{ id: "balance", description: "balance unchanged" }],
          verify: async () => {},
        },
      },
    };
    const runtime = grpcAdapter.project(spec);
    const extracted = grpcAdapter.normalize!({ ...runtime, id: "my-id" });

    expect(extracted.id).toBe("my-id");
    expect(extracted.protocol).toBe("grpc");
    expect(extracted.cases[0].key).toBe("ok");
    expect(extracted.cases[0].given).toBe("account exists");
    expect(extracted.cases[0].hasVerify).toBe(true);
    expect(extracted.cases[0].verifyRules).toEqual([
      { id: "balance", description: "balance unchanged" },
    ]);
    // JSON-safe check: round-trip through JSON should preserve shape
    expect(() => JSON.parse(JSON.stringify(extracted))).not.toThrow();
  });

  test("invalid target is tolerated at projection time", () => {
    // parseTarget returns undefined for bad targets; project still emits
    // meta with empty service/method (normalize still JSON-safe).
    const spec: GrpcContractSpec = {
      target: "malformed-no-slash",
      cases: { ok: { description: "ok" } },
    };
    const projection = grpcAdapter.project(spec);
    expect(projection.meta?.service).toBe("");
    expect(projection.meta?.method).toBe("");
  });
});

// ---------------------------------------------------------------------------
// renderTarget + markdown artifact
// ---------------------------------------------------------------------------

describe("renderTarget + markdown artifact", () => {
  test("renderTarget: 'Service/Method' → 'Service.Method'", () => {
    expect(grpcAdapter.renderTarget!("PaymentService/Complete")).toBe(
      "PaymentService.Complete",
    );
  });

  test("renderTarget: malformed input passes through unchanged", () => {
    expect(grpcAdapter.renderTarget!("no-slash")).toBe("no-slash");
  });

  test("artifacts.markdown produces a structured MarkdownPart per contract", async () => {
    const { renderArtifact, markdownArtifact } = await import("@glubean/sdk");
    const spec: GrpcContractSpec = {
      target: "A/B",
      description: "Desc",
      cases: {
        ok: { description: "happy path" },
        old: { description: "legacy", deprecated: "use new" },
      },
    };
    const runtime = grpcAdapter.project(spec);
    const extracted = grpcAdapter.normalize!({ ...runtime, id: "c1" });
    const md = renderArtifact(markdownArtifact, [extracted as any]);

    // CLI-format output (see sdk assembleMarkdownDocument): active cases
    // use `- **key** — description`; deprecated cases replace the
    // description with `⊘ **key** — deprecated: <reason>` (original
    // description is shadowed).
    expect(md).toContain("- **ok** — happy path");
    expect(md).toContain("⊘ **old** — deprecated: use new");
  });
});

// ---------------------------------------------------------------------------
// classifyFailure — gRPC status 0-16 → FailureKind
// ---------------------------------------------------------------------------

describe("classifyFailure", () => {
  const classify = (code?: number) =>
    grpcAdapter.classifyFailure!({
      events: code !== undefined
        ? [{ type: "grpc_status", data: { code } }]
        : [],
    });

  test("code 0 (OK) classifies as undefined", () => {
    expect(classify(0)).toBeUndefined();
  });

  test("code 14 (UNAVAILABLE) is transient + retryable", () => {
    const c = classify(14)!;
    expect(c.kind).toBe("transient");
    expect(c.retryable).toBe(true);
  });

  test("code 3 (INVALID_ARGUMENT) is client", () => {
    expect(classify(3)!.kind).toBe("client");
  });

  test("code 5 (NOT_FOUND) is semantic", () => {
    expect(classify(5)!.kind).toBe("semantic");
  });

  test("code 7 (PERMISSION_DENIED) is auth", () => {
    expect(classify(7)!.kind).toBe("auth");
  });

  test("code 13 (INTERNAL) is server", () => {
    expect(classify(13)!.kind).toBe("server");
  });

  test("code 8 (RESOURCE_EXHAUSTED) is transient + retryable (backpressure semantics)", () => {
    // Reviewer D-2 (2026-04-20): RESOURCE_EXHAUSTED 更像 backpressure 而非
    // server error. Retryable with backoff is the standard interpretation.
    const c = classify(8)!;
    expect(c.kind).toBe("transient");
    expect(c.retryable).toBe(true);
  });

  test("code 10 (ABORTED) is semantic (optimistic-concurrency default)", () => {
    // Reviewer D-2: product-specific interpretations may want transient,
    // but default stays semantic since ABORTED commonly indicates
    // optimistic-concurrency failure.
    expect(classify(10)!.kind).toBe("semantic");
  });

  test("DeadlineExceededError classifies as transient", () => {
    const err = new Error("deadline");
    err.name = "DeadlineExceededError";
    const c = grpcAdapter.classifyFailure!({ error: err, events: [] });
    expect(c?.kind).toBe("transient");
    expect(c?.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// executeCaseInFlow — deep-merge + typed state
// ---------------------------------------------------------------------------

describe("executeCaseInFlow + flow integration", () => {
  test("flow step (v10): function-valued request receives logical input from step.in lens", async () => {
    // v10 — flow lens returns LOGICAL input (matches case `needs`); the
    // case's function-valued `request` builds the final wire shape from
    // it. Contract defaults still merge under the case-built request, so
    // case + contract defaults still compose; the deep-merge of lens
    // adapter-patch is gone (v9 → v10 §5.1).
    const client = makeMockGrpcClient({
      message: { paymentId: "pay-1" },
    });
    const paymentContracts = (contract as any).grpc.with("payment", { client });
    const inputSchema = {
      safeParse: (d: unknown) => ({ success: true as const, data: d as { orderId: string; amount: number } }),
    };
    const paymentContract = paymentContracts("complete-payment", {
      target: "PaymentService/Complete",
      defaultRequest: { currency: "USD" },
      cases: {
        ok: {
          description: "happy",
          expect: { statusCode: 0 },
          needs: inputSchema,
          // v10: function-valued `request` builds wire shape from logical
          // input; static fields the case always wants live here too.
          request: (input: { orderId: string; amount: number }) => ({
            orderId: input.orderId,
            amount: input.amount,
            processorHint: "fast-lane",
          }),
        },
      },
    });

    const flowObj = contract
      .flow("pay-flow")
      .setup(async () => ({ orderId: "o-1", amount: 99.99 }))
      .step(paymentContract.case("ok"), {
        in: (s: any) => ({ orderId: s.orderId, amount: s.amount }),
      } as any)
      .build() as FlowContract<unknown>;

    await runFlow(flowObj, makeCtx());

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].method).toBe("Complete");
    expect(client._calls[0].request).toEqual({
      currency: "USD",            // from defaultRequest (still merged)
      processorHint: "fast-lane", // from case static piece of request fn
      orderId: "o-1",             // from logical input via lens
      amount: 99.99,              // from logical input via lens
    });
  });

  test("flow step output available via out lens", async () => {
    const client = makeMockGrpcClient({
      message: { serverId: "server-1" },
    });
    const svcContracts = (contract as any).grpc.with("svc", { client });
    const svcContract = svcContracts("my-svc", {
      target: "MyService/DoThing",
      cases: { ok: { description: "ok" } },
    });

    let capturedOut: any;
    const flowObj = contract
      .flow("f")
      .setup(async () => ({}))
      .step(svcContract.case("ok"), {
        out: (_s: any, res: any) => {
          capturedOut = res;
          return { statusCode: res.status.code, serverId: res.message.serverId };
        },
      } as any)  // Spike 4 — gRPC factory returns `any` via (contract as any).grpc,
                  // so conditional tuple on step() matches typed-input branch. gRPC
                  // flow migration is deferred per Option X.
      .build() as FlowContract<unknown>;

    await runFlow(flowObj, makeCtx());

    expect(capturedOut.status.code).toBe(0);
    expect(capturedOut.message.serverId).toBe("server-1");
  });

  test("metadata merges contract defaults + case (v10): function-valued case metadata builds from logical input", async () => {
    // v10 — lens returns logical input; case's function-valued metadata
    // builds final headers from it. Contract `defaultMetadata` still
    // merges under case metadata, but the lens no longer contributes a
    // metadata adapter-patch directly.
    const client = makeMockGrpcClient();
    const svcContracts = (contract as any).grpc.with("svc", {
      client,
      metadata: { "x-instance-tag": "a" },
    });
    const inputSchema = {
      safeParse: (d: unknown) => ({ success: true as const, data: d as { tag: string } }),
    };
    const svcContract = svcContracts("my-svc", {
      target: "MyService/Echo",
      defaultMetadata: { "x-contract-tag": "b" },
      cases: {
        ok: {
          description: "ok",
          needs: inputSchema,
          metadata: (input: { tag: string }) => ({
            "x-case-tag": "c",
            "x-from-lens": input.tag,
          }),
        },
      },
    });

    const flowObj = contract
      .flow("f")
      .setup(async () => ({ lensTag: "d" }))
      .step(svcContract.case("ok"), {
        in: (s: any) => ({ tag: s.lensTag }),
      } as any)
      .build() as FlowContract<unknown>;

    await runFlow(flowObj, makeCtx());

    const opts = client._calls[0].options as { metadata: Record<string, string> };
    expect(opts.metadata).toMatchObject({
      "x-contract-tag": "b",
      "x-case-tag": "c",
      "x-from-lens": "d",
    });
  });
});

// ---------------------------------------------------------------------------
// Direct grpcAdapter.execute (non-flow) path — reviewer gap priority #2
// ---------------------------------------------------------------------------
//
// 20 unit tests above exercise the flow path. The non-flow `execute`
// wrapper goes through executeCase(ctx, caseSpec, spec), which has its own
// merge/assert/verify/teardown logic. Add direct coverage so we catch
// divergence between the two paths (reviewer 2026-04-20 priority #2).

describe("grpcAdapter.execute (non-flow path)", () => {
  test("execute: happy unary call with status + message assertions", async () => {
    const client = makeMockGrpcClient({
      message: { greeting: "hello alice" },
      statusCode: 0,
    });

    const spec: GrpcContractSpec = {
      target: "Greeter/SayHello",
      client,
      cases: {
        ok: {
          description: "greet alice",
          expect: {
            statusCode: 0,
            message: { greeting: "hello alice" },
          },
          request: { name: "alice" },
        },
      },
    };

    const ctx = makeCtx();
    await grpcAdapter.execute(ctx, spec.cases.ok as any, spec as any);

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].method).toBe("SayHello");
    expect(client._calls[0].request).toEqual({ name: "alice" });
  });

  test("execute: deep-merges defaultRequest + case.request", async () => {
    const client = makeMockGrpcClient({ message: {} });

    const spec: GrpcContractSpec = {
      target: "Svc/Call",
      client,
      defaultRequest: { currency: "USD", tier: "standard" },
      cases: {
        ok: {
          description: "merge",
          request: { amount: 100, tier: "premium" }, // overrides default tier
        },
      },
    };

    const ctx = makeCtx();
    await grpcAdapter.execute(ctx, spec.cases.ok as any, spec as any);

    expect(client._calls[0].request).toEqual({
      currency: "USD",      // from defaultRequest
      tier: "premium",      // case override of default
      amount: 100,          // from case
    });
  });

  test("execute (v10): no per-case lifecycle — overlay owns setup/teardown", () => {
    // v10 removed `setup` / `teardown` from GrpcContractCase. Lifecycle
    // around a case is owned by `contract.bootstrap()` overlays (whose
    // `ctx.cleanup(...)` runs LIFO, including on assert failure). The
    // pre-v10 test that asserted `setup → teardown` ordering on the case
    // is no longer applicable; the equivalent invariant lives in SDK-level
    // bootstrap-cleanup tests (`packages/sdk/src/contract.test.ts`).
    expect(true).toBe(true); // documentation marker
  });

  test("execute: function-valued request receives resolvedInput (v10 logical input)", async () => {
    // v0 path — `adapter.execute` is reached only when no overlay AND no
    // `needs` (per §5.1 step 5), so resolvedInput is undefined. To prove
    // function-valued fields wire to resolvedInput, exercise the v10
    // entry `adapter.executeCase({ ..., resolvedInput })` directly.
    const client = makeMockGrpcClient({ message: {} });

    const spec = {
      target: "Svc/Call",
      client,
      cases: {
        ok: {
          description: "function request",
          // Function fields receive logical input (matches `needs`). In a
          // real run, dispatcher provides resolvedInput from overlay or
          // --input-json after needs validation.
          request: (input: any) => ({ userId: input.userId }),
          metadata: (input: any) => ({ authorization: `Bearer ${input.authToken}` }),
        },
      },
    };

    const ctx = makeCtx();
    await grpcAdapter.executeCase!({
      ctx,
      contract: { _projection: {}, _spec: spec } as any,
      caseKey: "ok",
      resolvedInput: { userId: "u-1", authToken: "t-1" },
    });

    expect(client._calls[0].request).toEqual({ userId: "u-1" });
    const opts = client._calls[0].options as { metadata: Record<string, string> };
    expect(opts.metadata).toMatchObject({ authorization: "Bearer t-1" });
  });

  test("execute: non-zero statusCode fails assertion with helpful message", async () => {
    const client = makeMockGrpcClient({
      statusCode: 5, // NOT_FOUND
      statusDetails: "user not found",
    });

    const spec: GrpcContractSpec = {
      target: "Svc/GetUser",
      client,
      cases: {
        ok: {
          description: "expects OK but server returns NOT_FOUND",
          expect: { statusCode: 0 },
        },
      },
    };

    const ctx = makeCtx();
    await expect(
      grpcAdapter.execute(ctx, spec.cases.ok as any, spec as any),
    ).rejects.toThrow(/status code 0.*got 5.*user not found/);
  });

  test("execute: expected non-zero statusCode passes (negative case)", async () => {
    const client = makeMockGrpcClient({
      statusCode: 5,
      statusDetails: "not found",
    });

    const spec: GrpcContractSpec = {
      target: "Svc/GetUser",
      client,
      cases: {
        notFound: {
          description: "user missing returns NOT_FOUND",
          expect: { statusCode: 5 },
        },
      },
    };

    const ctx = makeCtx();
    await grpcAdapter.execute(ctx, spec.cases.notFound as any, spec as any);

    // No throw — assertion passes because expectation matched
    expect(client._calls).toHaveLength(1);
  });

  test("execute: verify callback receives GrpcCaseResult<unknown>", async () => {
    const client = makeMockGrpcClient({
      message: { id: "u-1" },
      statusCode: 0,
      responseMetadata: { "x-tracked": "yes" },
      duration: 42,
    });

    let capturedResult: any;
    const spec: GrpcContractSpec = {
      target: "Svc/Call",
      client,
      cases: {
        ok: {
          description: "verify receives result",
          expect: { statusCode: 0 },
          verify: (_ctx, res) => {
            capturedResult = res;
          },
        },
      },
    };

    const ctx = makeCtx();
    await grpcAdapter.execute(ctx, spec.cases.ok as any, spec as any);

    expect(capturedResult).toMatchObject({
      message: { id: "u-1" },
      status: { code: 0 },
      responseMetadata: { "x-tracked": "yes" },
      duration: 42,
    });
  });
});

// ---------------------------------------------------------------------------
// Schema validation failure path — reviewer gap priority #3
// ---------------------------------------------------------------------------
//
// Ensures ctx.validate reject paths propagate correctly through both
// execute and executeCaseInFlow. Users who first-time write a Zod schema
// will hit this path on their first server-shape divergence.

describe("schema validation failure path", () => {
  // Minimal SchemaLike that rejects everything — simulates a Zod schema
  // whose .safeParse returns { success: false }.
  const rejectSchema = {
    safeParse: (_data: unknown) => ({
      success: false as const,
      error: { issues: [{ message: "schema rejects all" }] },
    }),
  };

  test("execute: response-message schema failure throws via ctx.validate", async () => {
    const client = makeMockGrpcClient({
      message: { anything: "server-returns-this" },
      statusCode: 0,
    });

    const spec: GrpcContractSpec = {
      target: "Svc/Call",
      client,
      cases: {
        ok: {
          description: "schema will reject",
          expect: {
            statusCode: 0,
            schema: rejectSchema as any,
          },
        },
      },
    };

    const ctx = makeCtx();
    await expect(
      grpcAdapter.execute(ctx, spec.cases.ok as any, spec as any),
    ).rejects.toThrow(/validate failed/);
  });

  test("execute: response-metadata schema failure throws via ctx.validate", async () => {
    const client = makeMockGrpcClient({
      message: {},
      statusCode: 0,
      responseMetadata: { "x-tag": "value" },
    });

    const spec: GrpcContractSpec = {
      target: "Svc/Call",
      client,
      cases: {
        ok: {
          description: "metadata schema rejects",
          expect: {
            statusCode: 0,
            metadata: rejectSchema as any,
          },
        },
      },
    };

    const ctx = makeCtx();
    await expect(
      grpcAdapter.execute(ctx, spec.cases.ok as any, spec as any),
    ).rejects.toThrow(/validate failed/);
  });

  test("executeCaseInFlow: schema failure still propagates (flow path parity)", async () => {
    const client = makeMockGrpcClient({
      message: { any: "shape" },
      statusCode: 0,
    });
    const svcContracts = (contract as any).grpc.with("svc", { client });
    const svcContract = svcContracts("svc-flow", {
      target: "Svc/Call",
      cases: {
        ok: {
          description: "schema rejects in flow",
          expect: {
            statusCode: 0,
            schema: rejectSchema as any,
          },
        },
      },
    });

    const flowObj = (contract
      .flow("schema-fail-flow")
      .setup(async () => ({}))
      .step as any)(svcContract.case("ok"))
      .build() as FlowContract<unknown>;

    await expect(runFlow(flowObj, makeCtx())).rejects.toThrow(/validate failed/);
  });
});

// ---------------------------------------------------------------------------
// validateCaseForFlow — REMOVED in v10
// ---------------------------------------------------------------------------
//
// In v9, function-valued `request` / `metadata` referenced case-local
// `setup` state and so couldn't run inside flows (state belonged to the
// flow orchestrator, not to the case). v10 removes per-case setup
// entirely; function fields receive the case's logical input (from
// `step.in` lens or `--input-json`), so flows accept them natively.
// `needs`-vs-function-fields consistency is enforced by the type system
// + §5.3 load-time guard, not at flow-step registration. The describe
// block that lived here is gone; flow-mode function-field behavior is
// covered by the executeCaseInFlow tests above.
