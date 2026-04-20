/**
 * Tests for the built-in gRPC contract adapter.
 *
 * Scope: authoring (contract.grpc.with), projection / normalize, case
 * execution, executeCaseInFlow (deep-merge + Rule 1 teardown),
 * classifyFailure mapping, renderTarget, toMarkdown.
 *
 * Uses a mock GrpcClient that records calls and returns canned responses.
 */

import { test, expect, beforeEach, describe } from "vitest";
// Import "@glubean/grpc" (this package) so its side-effect registers the
// contract adapter. Inside the package, import via relative path.
import "./index.js";
import { contract, runFlow } from "@glubean/sdk";
import type { FlowContract, TestContext } from "@glubean/sdk";
import { clearRegistry } from "@glubean/sdk/internal";

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
  // Re-register gRPC adapter + wrap factory (mirrors side-effect from package index)
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
    const grpc = (contract as any).grpc as GrpcContractRoot;
    const factory = grpc.with("users", {});
    expect(typeof factory).toBe("function");
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
        ok: { description: "happy", expect: { statusCode: 0 } },
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
      cases: { ok: { description: "ok" } },
    };
    const runtime = grpcAdapter.project(spec);
    const extracted = grpcAdapter.normalize!({ ...runtime, id: "my-id" });

    expect(extracted.id).toBe("my-id");
    expect(extracted.protocol).toBe("grpc");
    expect(extracted.cases[0].key).toBe("ok");
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
// renderTarget + toMarkdown
// ---------------------------------------------------------------------------

describe("renderTarget + toMarkdown", () => {
  test("renderTarget: 'Service/Method' → 'Service.Method'", () => {
    expect(grpcAdapter.renderTarget!("PaymentService/Complete")).toBe(
      "PaymentService.Complete",
    );
  });

  test("renderTarget: malformed input passes through unchanged", () => {
    expect(grpcAdapter.renderTarget!("no-slash")).toBe("no-slash");
  });

  test("toMarkdown lists cases with lifecycle markers", () => {
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
    const md = grpcAdapter.toMarkdown!(extracted);

    expect(md).toContain("A.B"); // renderTarget-style display
    expect(md).toContain("happy path");
    expect(md).toContain("legacy");
    expect(md).toContain("⚠ deprecated"); // deprecated marker
    expect(md).toContain("use new");
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
  test("flow step deep-merges lens request over case static + contract defaultRequest", async () => {
    const client = makeMockGrpcClient({
      message: { paymentId: "pay-1" },
    });
    const paymentContracts = (contract as any).grpc.with("payment", { client });
    const paymentContract = paymentContracts("complete-payment", {
      target: "PaymentService/Complete",
      defaultRequest: { currency: "USD" },
      cases: {
        ok: {
          description: "happy",
          expect: { statusCode: 0 },
          request: { processorHint: "fast-lane" },
        },
      },
    });

    const flowObj = contract
      .flow("pay-flow")
      .setup(async () => ({ orderId: "o-1", amount: 99.99 }))
      .step(paymentContract.case("ok"), {
        in: (s: any) => ({
          request: { orderId: s.orderId, amount: s.amount },
        }),
      })
      .build() as FlowContract<unknown>;

    await runFlow(flowObj, makeCtx());

    expect(client._calls).toHaveLength(1);
    expect(client._calls[0].method).toBe("Complete");
    expect(client._calls[0].request).toEqual({
      currency: "USD",           // from defaultRequest
      processorHint: "fast-lane", // from case.request
      orderId: "o-1",            // from lens
      amount: 99.99,              // from lens
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
      })
      .build() as FlowContract<unknown>;

    await runFlow(flowObj, makeCtx());

    expect(capturedOut.status.code).toBe(0);
    expect(capturedOut.message.serverId).toBe("server-1");
  });

  test("metadata merges instance < contract < lens in flow", async () => {
    const client = makeMockGrpcClient();
    const svcContracts = (contract as any).grpc.with("svc", {
      client,
      metadata: { "x-instance-tag": "a" },
    });
    const svcContract = svcContracts("my-svc", {
      target: "MyService/Echo",
      defaultMetadata: { "x-contract-tag": "b" },
      cases: {
        ok: {
          description: "ok",
          metadata: { "x-case-tag": "c" },
        },
      },
    });

    const flowObj = contract
      .flow("f")
      .setup(async () => ({}))
      .step(svcContract.case("ok"), {
        in: () => ({ metadata: { "x-lens-tag": "d" } }),
      })
      .build() as FlowContract<unknown>;

    await runFlow(flowObj, makeCtx());

    // In flow mode, the adapter merges: instance defaults + contract defaults + lens
    // (case static metadata is used but function-valued metadata would be rejected).
    const opts = client._calls[0].options as { metadata: Record<string, string> };
    expect(opts.metadata).toMatchObject({
      "x-contract-tag": "b",
      "x-lens-tag": "d",
    });
  });
});

// ---------------------------------------------------------------------------
// validateCaseForFlow — reject function-valued fields
// ---------------------------------------------------------------------------

describe("validateCaseForFlow", () => {
  test("rejects function-valued request", () => {
    const client = makeMockGrpcClient();
    const svcContracts = (contract as any).grpc.with("svc", { client });
    const c = svcContracts("c", {
      target: "A/B",
      cases: {
        ok: {
          description: "uses setup",
          setup: async () => ({ x: 1 }),
          request: (s: any) => ({ x: s.x }),
        },
      },
    });

    expect(() =>
      contract.flow("f").step(c.case("ok") as any),
    ).toThrow(/function-valued request.*flow/);
  });

  test("rejects function-valued metadata", () => {
    const client = makeMockGrpcClient();
    const svcContracts = (contract as any).grpc.with("svc", { client });
    const c = svcContracts("c", {
      target: "A/B",
      cases: {
        ok: {
          description: "uses setup",
          setup: async () => ({ tag: "v" }),
          metadata: (s: any) => ({ "x-tag": s.tag }),
        },
      },
    });

    expect(() =>
      contract.flow("f").step(c.case("ok") as any),
    ).toThrow(/function-valued.*metadata/);
  });
});
