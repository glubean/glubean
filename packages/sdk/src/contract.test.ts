/**
 * Tests for the protocol-agnostic contract core (`contract-core.ts`).
 *
 * Scope: register / dispatcher / flow / runFlow / normalizeFlow / tracer.
 * All HTTP-specific behavior tests live in `./contract-http/*.test.ts` (P2).
 *
 * Uses a mock adapter to avoid any HTTP dependency.
 */

import { test, expect, beforeEach } from "vitest";
import {
  contract,
  runFlow,
  normalizeFlow,
  extractMappings,
  extractMappingsOut,
  traceComputeFn,
  getAdapter,
} from "./contract-core.js";
import type {
  ContractProtocolAdapter,
  ContractProjection,
  ExtractedContractProjection,
  ProtocolContract,
  FlowContract,
} from "./contract-types.js";
import type { TestContext } from "./types.js";
import { clearRegistry, getRegistry } from "./internal.js";
import { clearBootstrapRegistry } from "./bootstrap-registry.js";

// ---------------------------------------------------------------------------
// Mock adapter factory
// ---------------------------------------------------------------------------

type MockSpec = {
  target: string;
  cases: Record<string, { description?: string; deferred?: string; deprecated?: string }>;
};

function makeMockAdapter(options?: {
  onExecute?: () => Promise<void> | void;
  withFlow?: boolean;
  executionLog?: string[];
}): ContractProtocolAdapter<MockSpec, Record<string, unknown>, unknown, Record<string, unknown>, unknown> {
  const log = options?.executionLog ?? [];
  const adapter: ContractProtocolAdapter<MockSpec, Record<string, unknown>, unknown, Record<string, unknown>, unknown> = {
    async execute(_ctx, caseSpec, spec) {
      log.push(`execute:${(caseSpec as any).description ?? spec.target}`);
      if (options?.onExecute) await options.onExecute();
    },
    project(spec): ContractProjection<Record<string, unknown>, unknown> {
      return {
        protocol: "mock",
        target: spec.target,
        cases: Object.entries(spec.cases).map(([key, c]) => ({
          key,
          description: c.description,
          lifecycle: c.deprecated ? "deprecated" : c.deferred ? "deferred" : "active",
          severity: "warning",
          deferredReason: c.deferred,
          deprecatedReason: c.deprecated,
          schemas: {},
        })),
      };
    },
    normalize(projection): ExtractedContractProjection<Record<string, unknown>, unknown> {
      return {
        id: projection.id,
        protocol: projection.protocol,
        target: projection.target,
        description: projection.description,
        feature: projection.feature,
        instanceName: projection.instanceName,
        tags: projection.tags,
        extensions: projection.extensions,
        deprecated: projection.deprecated,
        cases: projection.cases.map((c) => ({ ...c, schemas: {} })),
        schemas: {},
      };
    },
  };

  if (options?.withFlow) {
    (adapter as any).executeCaseInFlow = async ({ caseKey, resolvedInputs }: { caseKey: string; resolvedInputs: unknown }) => {
      log.push(`flow:${caseKey}:${JSON.stringify(resolvedInputs ?? null)}`);
      return { caseKey, resolvedInputs };
    };
  }

  return adapter;
}

function makeMockCtx(partial: Partial<TestContext> = {}): TestContext {
  return {
    vars: { get: () => undefined, require: () => { throw new Error(); } } as any,
    secrets: { get: () => undefined, require: () => { throw new Error(); } } as any,
    log: () => {},
    assert: () => {},
    trace: () => {},
    action: () => {},
    event: () => {},
    metric: () => {},
    http: {} as any,
    fetch: {} as any,
    expect: ((() => {
      const e = { toBe: () => {}, toEqual: () => {}, toHaveStatus: () => {}, toMatchSchema: () => {} };
      return () => e;
    })()) as any,
    validate: () => undefined,
    skip: () => {},
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
// contract.register + dispatcher
// ---------------------------------------------------------------------------

test("contract.register adds protocol and rejects reserved names", () => {
  const adapter = makeMockAdapter();
  contract.register("mock", adapter);
  expect(getAdapter("mock")).toBe(adapter);
  expect(typeof (contract as any).mock).toBe("function");

  expect(() => contract.register("register", adapter as any)).toThrow(/reserved/);
  expect(() => contract.register("flow", adapter as any)).toThrow(/reserved/);
});

test("dispatcher validates 1:1 case key match between spec and projection", () => {
  const badProjectExtra: ContractProtocolAdapter<MockSpec> = {
    async execute() {},
    project(spec) {
      return {
        protocol: "bad1",
        target: spec.target,
        cases: [
          { key: "ok", lifecycle: "active", severity: "warning" },
          { key: "extra", lifecycle: "active", severity: "warning" },
        ],
      };
    },
    normalize: (p) => p as any,
  };
  contract.register("bad1", badProjectExtra);
  expect(() =>
    (contract as any).bad1("c", { target: "/x", cases: { ok: {} } }),
  ).toThrow(/not present in spec\.cases/);

  const badProjectMissing: ContractProtocolAdapter<MockSpec> = {
    async execute() {},
    project(spec) {
      return {
        protocol: "bad2",
        target: spec.target,
        cases: [{ key: "ok", lifecycle: "active", severity: "warning" }],
      };
    },
    normalize: (p) => p as any,
  };
  contract.register("bad2", badProjectMissing);
  expect(() =>
    (contract as any).bad2("c", { target: "/x", cases: { ok: {}, missing: {} } }),
  ).toThrow(/did not return it/);

  const badDupe: ContractProtocolAdapter<MockSpec> = {
    async execute() {},
    project(spec) {
      return {
        protocol: "bad3",
        target: spec.target,
        cases: [
          { key: "dup", lifecycle: "active", severity: "warning" },
          { key: "dup", lifecycle: "active", severity: "warning" },
        ],
      };
    },
    normalize: (p) => p as any,
  };
  contract.register("bad3", badDupe);
  expect(() =>
    (contract as any).bad3("c", { target: "/x", cases: { dup: {} } }),
  ).toThrow(/duplicate case key/);
});

test("dispatcher produces ProtocolContract extending Array<Test>", () => {
  contract.register("mock_pc", makeMockAdapter());
  const c = (contract as any).mock_pc("my-contract", {
    target: "/x",
    cases: { ok: {}, bad: {} },
  }) as ProtocolContract<MockSpec>;

  expect(Array.isArray(c)).toBe(true);
  expect(c.length).toBe(2);
  expect(c[0].meta.id).toBe("my-contract.ok");
  expect(c[1].meta.id).toBe("my-contract.bad");
  expect(c._projection.id).toBe("my-contract");
  expect(c._projection.protocol).toBe("mock_pc");
  expect(c._spec).toBeDefined();
  expect(typeof c.case).toBe("function");
});

test("dispatcher registers cases with contract metadata", () => {
  contract.register("mock_reg", makeMockAdapter());
  (contract as any).mock_reg("c", {
    target: "/users",
    cases: {
      ok: { description: "happy path" },
    },
  });

  const registry = getRegistry();
  const entry = registry.find((r) => r.id === "c.ok");
  expect(entry).toBeDefined();
  expect(entry?.contract).toBeDefined();
  expect(entry?.contract?.protocol).toBe("mock_reg");
  expect(entry?.contract?.target).toBe("/users");
  expect(entry?.contract?.caseKey).toBe("ok");
  expect(entry?.contract?.lifecycle).toBe("active");
});

test("dispatcher calls adapter.execute at runtime", async () => {
  const log: string[] = [];
  contract.register("mock_exec", makeMockAdapter({ executionLog: log }));
  const c = (contract as any).mock_exec("c", {
    target: "/x",
    cases: { ok: { description: "a case" } },
  }) as ProtocolContract<MockSpec>;

  const test0 = c[0];
  await test0.fn!(makeMockCtx());
  expect(log).toContain("execute:a case");
});

// ---------------------------------------------------------------------------
// v10 attachment model: bootstrap overlay dispatch
//
// When contract.bootstrap(ref, spec) is registered for a testId, the
// dispatcher routes test.fn through adapter.executeCase (not the legacy
// adapter.execute). Bootstrap's return value becomes resolvedInput.
// No overlay → legacy path preserved.
// ---------------------------------------------------------------------------

test("dispatcher routes through adapter.executeCase when bootstrap overlay registered", async () => {
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  let executeCaseCalled: { caseKey: string; resolvedInput: unknown } | null = null;
  adapter.executeCase = async ({ caseKey, resolvedInput }) => {
    executeCaseCalled = { caseKey, resolvedInput };
    log.push(`executeCase:${caseKey}`);
  };
  contract.register("mock_overlay", adapter);

  const c = (contract as any).mock_overlay("svc", {
    target: "/x",
    cases: { ok: { description: "with overlay" } },
  }) as ProtocolContract<MockSpec>;

  // Register bootstrap overlay BEFORE running the test.
  // Mock case has no `needs` schema (MockSpec doesn't carry one), so the
  // ref's inferred Needs is `void`. The `as any` bypasses the void-only
  // constraint — dispatcher doesn't run needs validation when `needs` is
  // absent, so any shape reaches adapter.executeCase as resolvedInput.
  (contract.bootstrap as any)(
    c.case("ok"),
    async () => ({ token: "seeded" }),
  );

  const test0 = c[0];
  await test0.fn!(makeMockCtx());

  expect(log).toContain("executeCase:ok");
  expect(log).not.toContain("execute:with overlay"); // legacy path skipped
  expect(executeCaseCalled).not.toBeNull();
  expect(executeCaseCalled!.caseKey).toBe("ok");
  expect(executeCaseCalled!.resolvedInput).toEqual({ token: "seeded" });
});

test("dispatcher falls back to adapter.execute when no overlay registered", async () => {
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  adapter.executeCase = async ({ caseKey }) => {
    log.push(`executeCase:${caseKey}`);
  };
  contract.register("mock_no_overlay", adapter);

  const c = (contract as any).mock_no_overlay("svc", {
    target: "/x",
    cases: { ok: { description: "no overlay" } },
  }) as ProtocolContract<MockSpec>;

  // Intentionally NO contract.bootstrap(...) call

  const test0 = c[0];
  await test0.fn!(makeMockCtx());

  expect(log).toContain("execute:no overlay"); // legacy path
  expect(log).not.toContain("executeCase:ok");
});

test("bootstrap ctx.cleanup callbacks run LIFO after case execution", async () => {
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  adapter.executeCase = async () => {
    log.push("executeCase");
  };
  contract.register("mock_cleanup", adapter);

  const c = (contract as any).mock_cleanup("svc", {
    target: "/x",
    cases: { ok: { description: "cleanup" } },
  }) as ProtocolContract<MockSpec>;

  contract.bootstrap(c.case("ok"), async (ctx) => {
    (ctx as any).cleanup(() => { log.push("cleanup-A"); });
    (ctx as any).cleanup(() => { log.push("cleanup-B"); });
    (ctx as any).cleanup(() => { log.push("cleanup-C"); });
    return undefined;
  });

  const test0 = c[0];
  await test0.fn!(makeMockCtx());

  // LIFO: C registered last runs first
  const cleanupIdx = [
    log.indexOf("executeCase"),
    log.indexOf("cleanup-C"),
    log.indexOf("cleanup-B"),
    log.indexOf("cleanup-A"),
  ];
  expect(cleanupIdx.every((i) => i >= 0)).toBe(true);
  // Each index strictly greater than the previous (order matches expectation)
  expect(cleanupIdx[0]).toBeLessThan(cleanupIdx[1]);
  expect(cleanupIdx[1]).toBeLessThan(cleanupIdx[2]);
  expect(cleanupIdx[2]).toBeLessThan(cleanupIdx[3]);
});

test("needs schema validates bootstrap output before executeCase", async () => {
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  adapter.executeCase = async ({ resolvedInput }) => {
    log.push(`executeCase:${JSON.stringify(resolvedInput)}`);
  };
  contract.register("mock_needs_ok", adapter);

  // Case carries a `needs` schema using safeParse (Zod-shape)
  const schema = {
    safeParse: (d: unknown) => {
      if (d && typeof d === "object" && "token" in d && typeof (d as any).token === "string") {
        return { success: true as const, data: d };
      }
      return {
        success: false as const,
        error: { issues: [{ message: "token must be string", path: ["token"] }] },
      };
    },
  };

  const c = (contract as any).mock_needs_ok("svc", {
    target: "/x",
    cases: { ok: { description: "needs-validated", needs: schema } },
  }) as ProtocolContract<MockSpec>;

  (contract.bootstrap as any)(
    c.case("ok"),
    async () => ({ token: "valid-string" }),
  );

  await c[0]!.fn!(makeMockCtx());
  expect(log).toContain('executeCase:{"token":"valid-string"}');
});

test("needs schema rejects bootstrap output; executeCase not called", async () => {
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  adapter.executeCase = async () => {
    log.push("executeCase");
  };
  contract.register("mock_needs_bad", adapter);

  const schema = {
    safeParse: (d: unknown) => {
      if (d && typeof d === "object" && "token" in d && typeof (d as any).token === "string") {
        return { success: true as const, data: d };
      }
      return {
        success: false as const,
        error: { issues: [{ message: "token must be string", path: ["token"] }] },
      };
    },
  };

  const c = (contract as any).mock_needs_bad("svc", {
    target: "/x",
    cases: { ok: { description: "needs-bad", needs: schema } },
  }) as ProtocolContract<MockSpec>;

  // Bootstrap returns wrong shape (missing token) — should be rejected
  (contract.bootstrap as any)(
    c.case("ok"),
    async () => ({ wrongField: "x" }),
  );

  await expect(c[0]!.fn!(makeMockCtx())).rejects.toThrow(/does not satisfy needs schema/);
  expect(log).not.toContain("executeCase"); // adapter never reached
});

test("needs schema validation failure runs cleanups registered during bootstrap", async () => {
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  adapter.executeCase = async () => {
    log.push("executeCase");
  };
  contract.register("mock_needs_cleanup", adapter);

  const schema = {
    safeParse: () => ({
      success: false as const,
      error: { issues: [{ message: "always fails", path: [] }] },
    }),
  };

  const c = (contract as any).mock_needs_cleanup("svc", {
    target: "/x",
    cases: { ok: { description: "cleanup on validation fail", needs: schema } },
  }) as ProtocolContract<MockSpec>;

  (contract.bootstrap as any)(c.case("ok"), async (ctx: any) => {
    ctx.cleanup(() => { log.push("cleanup"); });
    return { irrelevant: true };
  });

  await expect(c[0]!.fn!(makeMockCtx())).rejects.toThrow(/always fails/);
  expect(log).toContain("cleanup");       // cleanup ran despite validation failure
  expect(log).not.toContain("executeCase"); // case never dispatched
});

test("bootstrap cleanup runs even when executeCase throws", async () => {
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  adapter.executeCase = async () => {
    log.push("executeCase:will-throw");
    throw new Error("case failed");
  };
  contract.register("mock_cleanup_fail", adapter);

  const c = (contract as any).mock_cleanup_fail("svc", {
    target: "/x",
    cases: { ok: { description: "cleanup on fail" } },
  }) as ProtocolContract<MockSpec>;

  contract.bootstrap(c.case("ok"), async (ctx) => {
    (ctx as any).cleanup(() => { log.push("cleanup"); });
    return undefined;
  });

  const test0 = c[0];
  await expect(test0.fn!(makeMockCtx())).rejects.toThrow("case failed");
  expect(log).toContain("cleanup"); // still ran despite executeCase failure
});

test("deferred/deprecated lifecycle propagates to skip() at runtime", async () => {
  contract.register("mock_dep", makeMockAdapter());
  const c = (contract as any).mock_dep("c", {
    target: "/x",
    cases: {
      later: { deferred: "not yet" },
      old: { deprecated: "gone" },
    },
  }) as ProtocolContract<MockSpec>;

  const skipReasons: string[] = [];
  const ctx = makeMockCtx({ skip: ((r: string) => skipReasons.push(r)) as any });
  await c.find((t) => t.meta.id === "c.later")!.fn!(ctx);
  await c.find((t) => t.meta.id === "c.old")!.fn!(ctx);
  expect(skipReasons).toContain("not yet");
  expect(skipReasons.some((r) => r.includes("gone"))).toBe(true);
});

// ---------------------------------------------------------------------------
// dispatcher → adapter.normalize → _extracted wiring
//
// The invariant: every ProtocolContract carrier MUST expose `_extracted`
// equal to `adapter.normalize(_projection)`. Scanner / MCP / CLI / Cloud all
// read `_extracted` as the JSON-safe form. If dispatcher forgets to call
// normalize, these consumers silently fall back to generic recursion and
// lose protocol-specific normalization (HTTP `security` preservation,
// gRPC `requestExample` literal passthrough, etc.).
// ---------------------------------------------------------------------------

test("dispatcher calls adapter.normalize and exposes result as _extracted", () => {
  contract.register("mock_extracted", makeMockAdapter());
  const c = (contract as any).mock_extracted("my-contract", {
    target: "/x",
    cases: { ok: {}, bad: {} },
  }) as ProtocolContract<MockSpec>;

  // The mock adapter's normalize() returns a safe projection with
  // `schemas: {}` at both contract and case level, plus the injected `id`.
  expect((c as any)._extracted).toBeDefined();
  expect((c as any)._extracted.id).toBe("my-contract");
  expect((c as any)._extracted.protocol).toBe("mock_extracted");
  expect((c as any)._extracted.schemas).toEqual({});
  expect((c as any)._extracted.cases.length).toBe(2);
  expect((c as any)._extracted.cases[0].schemas).toEqual({});
});

test("_extracted equals adapter.normalize(_projection) exactly", () => {
  const adapter = makeMockAdapter();
  contract.register("mock_equiv", adapter);
  const c = (contract as any).mock_equiv("c-id", {
    target: "/users",
    cases: { ok: { description: "happy" } },
  }) as ProtocolContract<MockSpec>;

  // Dispatcher's _extracted must match what we'd get by calling normalize
  // manually against _projection. If dispatcher skips normalize, this fails.
  const manual = adapter.normalize!({ ...c._projection, id: (c._projection as any).id } as any);
  expect((c as any)._extracted).toEqual(manual);
});

// ---------------------------------------------------------------------------
// contract.flow — generic builder
// ---------------------------------------------------------------------------

test("contract.flow builds a FlowContract with single Test", () => {
  const flow = contract.flow("my-flow").build() as FlowContract<unknown>;
  expect(Array.isArray(flow)).toBe(true);
  expect(flow.length).toBe(1);
  expect(flow[0].meta.id).toBe("my-flow");
  expect(flow._flow.id).toBe("my-flow");
  expect(flow._flow.protocol).toBe("flow");
});

test("flow meta.skip maps to Test.meta.deferred + skips at runtime", async () => {
  const flowObj = contract
    .flow("illustrative")
    .meta({ skip: "docs example — no live server", tags: ["example"] })
    .setup(async () => ({ x: 1 }))
    .build();

  // The inner orchestrator Test should carry `deferred` so the runner
  // surfaces the reason to reporters (mirrors contract case convention).
  expect(flowObj[0].meta.deferred).toBe("docs example — no live server");

  // At runtime, the fn calls ctx.skip() before attempting runFlow so the
  // flow body never hits any network stub.
  const skipReasons: string[] = [];
  const ctx = makeMockCtx({
    skip: ((r?: string) => {
      skipReasons.push(r ?? "");
      throw new Error(`__skipped__:${r ?? ""}`);
    }) as any,
  });
  await expect(flowObj[0].fn!(ctx)).rejects.toThrow(/__skipped__/);
  expect(skipReasons).toContain("docs example — no live server");
});

test("contract.flow meta / setup / teardown are captured in runtime projection", () => {
  const flow = contract
    .flow("m")
    .meta({ description: "d", tags: ["e2e"] })
    .setup(async () => ({ foo: 1 }))
    .teardown(async () => {})
    .build() as FlowContract<unknown>;

  expect(flow._flow.description).toBe("d");
  expect(flow._flow.tags).toEqual(["e2e"]);
  expect(typeof flow._flow.setup).toBe("function");
  expect(typeof flow._flow.teardown).toBe("function");
});

test("flow.step rejects unknown protocol", () => {
  expect(() =>
    contract.flow("f").step({
      __glubean_type: "contract-case-ref",
      contractId: "c",
      caseKey: "ok",
      protocol: "nonexistent_protocol_xyz",
      target: "/x",
      contract: [] as any,
    } as any),
  ).toThrow(/unknown protocol/);
});

test("flow.step rejects adapter without executeCaseInFlow", () => {
  contract.register("no_flow", makeMockAdapter({ withFlow: false }));
  const c = (contract as any).no_flow("c", {
    target: "/x",
    cases: { ok: {} },
  }) as ProtocolContract<MockSpec>;

  expect(() =>
    contract.flow("f").step(c.case("ok") as any),
  ).toThrow(/does not implement executeCaseInFlow/);
});

test("flow.step with compliant adapter accepts ContractCaseRef", async () => {
  const log: string[] = [];
  contract.register(
    "yes_flow",
    makeMockAdapter({ withFlow: true, executionLog: log }),
  );
  const c = (contract as any).yes_flow("c", {
    target: "/x",
    cases: { ok: {} },
  }) as ProtocolContract<MockSpec>;

  const flowObj = contract
    .flow("f")
    .setup(async () => ({ seed: 42 }))
    .step(c.case("ok") as any, {
      in: (s: any) => ({ body: { v: s.seed } }),
    })
    .build() as FlowContract<unknown>;

  await runFlow(flowObj, makeMockCtx());

  expect(log.some((l) => l.startsWith("flow:ok"))).toBe(true);
});

// ---------------------------------------------------------------------------
// runFlow — teardown Rule 1/2, compute async rejection
// ---------------------------------------------------------------------------

test("runFlow runs flow.teardown after successful steps", async () => {
  contract.register(
    "td1",
    makeMockAdapter({ withFlow: true }),
  );
  const c = (contract as any).td1("c", { target: "/x", cases: { ok: {} } }) as ProtocolContract<MockSpec>;
  const order: string[] = [];
  const flowObj = contract
    .flow("f")
    .setup(async () => { order.push("setup"); return {}; })
    .step(c.case("ok") as any)
    .teardown(async () => { order.push("teardown"); })
    .build() as FlowContract<unknown>;

  await runFlow(flowObj, makeMockCtx());
  expect(order).toEqual(["setup", "teardown"]);
});

test("runFlow runs flow.teardown in outer finally on step failure (Rule 2)", async () => {
  const adapter: ContractProtocolAdapter<MockSpec> = {
    async execute() {},
    project(spec) {
      return {
        protocol: "td2",
        target: spec.target,
        cases: [{ key: "ok", lifecycle: "active", severity: "warning" }],
      };
    },
    normalize: (p) => p as any,
  };
  (adapter as any).executeCaseInFlow = async () => {
    throw new Error("step failed");
  };
  contract.register("td2", adapter);
  const c = (contract as any).td2("c", { target: "/x", cases: { ok: {} } }) as ProtocolContract<MockSpec>;
  const order: string[] = [];
  const flowObj = contract
    .flow("f")
    .setup(async () => { order.push("setup"); return {}; })
    .step(c.case("ok") as any)
    .teardown(async () => { order.push("teardown"); })
    .build() as FlowContract<unknown>;

  await expect(runFlow(flowObj, makeMockCtx())).rejects.toThrow("step failed");
  expect(order).toEqual(["setup", "teardown"]);
});

test("runFlow does NOT run teardown when flow.setup throws", async () => {
  const order: string[] = [];
  const flowObj = contract
    .flow("f")
    .setup(async (): Promise<{ x: number }> => {
      order.push("setup");
      throw new Error("setup fail");
    })
    .teardown(async () => { order.push("teardown"); })
    .build() as FlowContract<unknown>;

  await expect(runFlow(flowObj, makeMockCtx())).rejects.toThrow("setup fail");
  expect(order).toEqual(["setup"]);
});

test("runFlow rejects async compute fn (syntactic)", async () => {
  const flowObj = contract
    .flow("f")
    .setup(async () => ({}))
    .compute((async (s: any) => s) as any)
    .build() as FlowContract<unknown>;

  await expect(runFlow(flowObj, makeMockCtx())).rejects.toThrow(/async functions are not allowed/);
});

test("runFlow rejects compute returning a thenable (value-level)", async () => {
  const flowObj = contract
    .flow("f")
    .setup(async () => ({}))
    .compute(((s: any) => Promise.resolve(s)) as any)
    .build() as FlowContract<unknown>;

  await expect(runFlow(flowObj, makeMockCtx())).rejects.toThrow(/thenable/);
});

test("runFlow threads state through compute + steps", async () => {
  const log: string[] = [];
  contract.register("thread", makeMockAdapter({ withFlow: true, executionLog: log }));
  const c = (contract as any).thread("c", {
    target: "/x",
    cases: { ok: {} },
  }) as ProtocolContract<MockSpec>;

  const flowObj = contract
    .flow("f")
    .setup(async () => ({ a: 1 }))
    .compute((s: any) => ({ ...s, b: `${s.a}-derived` }))
    .step(c.case("ok") as any, {
      in: (s: any) => ({ body: { v: s.b } }),
    })
    .build() as FlowContract<unknown>;

  await runFlow(flowObj, makeMockCtx());
  const lastLog = log[log.length - 1];
  expect(lastLog).toContain("1-derived");
});

// ---------------------------------------------------------------------------
// normalizeFlow — produces JSON-safe projection with FieldMappings
// ---------------------------------------------------------------------------

test("normalizeFlow emits ExtractedFlowProjection with kind discriminator", () => {
  contract.register("nf", makeMockAdapter({ withFlow: true }));
  const c = (contract as any).nf("c", {
    target: "/x",
    cases: { ok: {} },
  }) as ProtocolContract<MockSpec>;
  const flowObj = contract
    .flow("f")
    .setup(async () => ({ email: "a@b" }))
    .compute((s: any) => ({ ...s, upper: s.email }))
    .step(c.case("ok") as any, {
      in: (s: any) => ({ body: { email: s.email } }),
      out: (s: any, res: any) => ({ ...s, id: res.body }),
    })
    .build() as FlowContract<unknown>;

  const extracted = normalizeFlow(flowObj._flow);

  expect(extracted.id).toBe("f");
  expect(extracted.protocol).toBe("flow");
  expect(extracted.setupDynamic).toBe(true);
  expect(extracted.steps.length).toBe(2);
  expect(extracted.steps[0].kind).toBe("compute");
  expect(extracted.steps[1].kind).toBe("contract-call");

  // Projection is JSON-safe
  const cloned = JSON.parse(JSON.stringify(extracted));
  expect(cloned).toEqual(extracted);
});

test("extractMappings captures state field access", () => {
  const mappings = extractMappings((s: any) => ({
    body: { email: s.email, name: s.name },
  }));
  const byTarget = new Map(mappings.map((m) => [m.target, m]));
  const email = byTarget.get("body.email");
  const name = byTarget.get("body.name");
  expect(email).toBeDefined();
  expect((email!.source as any).path).toBe("state.email");
  expect((name!.source as any).path).toBe("state.name");
});

test("traceComputeFn records top-level reads + writes", () => {
  const r = traceComputeFn((s: any) => ({ combined: `${s.a}:${s.b}`, c: s.c }));
  expect(r.reads.sort()).toEqual(["state.a", "state.b", "state.c"]);
  expect(r.writes.sort()).toEqual(["c", "combined"]);
});

test("traceComputeFn handles method calls + arithmetic permissively", () => {
  const r = traceComputeFn((s: any) => ({
    greeting: `${s.name.toUpperCase()}-hi`,
  }));
  expect(r.reads).toContain("state.name");
  expect(r.writes).toContain("greeting");
});

test("lens purity: method call in lens fn throws LensPurityError", async () => {
  const { LensPurityError } = await import("./contract-core.js");
  // Users who accidentally call a method on the traced state / response
  // must see a clear error, not silently lose projection mappings.
  expect(() => extractMappings((s: any) => ({ body: { id: s.name.toUpperCase() } })))
    .toThrow(LensPurityError);

  expect(() => extractMappings((s: any) => ({ body: { id: s.name.toUpperCase() } })))
    .toThrow(/must be a pure select\/repack function/);
});

test("lens purity: normalizeFlow wraps LensPurityError with step context", async () => {
  contract.register("lens_bad", makeMockAdapter({ withFlow: true }));
  const c = (contract as any).lens_bad("c", {
    target: "/x",
    cases: { ok: {} },
  }) as ProtocolContract<MockSpec>;

  // Build a flow with an impure `in` lens — should throw at build/normalize time
  expect(() => {
    contract
      .flow("broken-flow")
      .step(c.case("ok") as any, {
        in: (s: any) => ({ body: { x: s.name.toUpperCase() } }),
      })
      .build();
  }).toThrow(/broken-flow.*in lens.*pure select\/repack/s);
});

test("compute tracer errors wrap with step context (P2 regression)", () => {
  // A compute fn that throws at call time should surface through `.build()`
  // as a wrapped Error with the flow/step prefix, matching the lens error
  // wrapping format — so authors can localize failures symmetrically.
  expect(() => {
    contract
      .flow("broken-compute")
      .setup(async () => ({}))
      .compute(() => { throw new Error("compute blew up"); })
      .build();
  }).toThrow(/broken-compute.*step 1.*\(compute\).*compute blew up/s);
});

test("lens purity: pure lens with spread + nested access still works", () => {
  // Pass-through spread + multi-level access should NOT throw
  const mappings = extractMappingsOut((s: any, res: any) => ({
    ...s,
    id: res.body.userId,
    createdAt: res.body.meta.ts,
  }));
  expect(mappings.find((m) => m.target === "state.id")).toBeDefined();
  expect(
    mappings.find((m) => m.target === "state.createdAt" && (m.source as any).path === "response.body.meta.ts"),
  ).toBeDefined();
});

test("extractMappingsOut tracks state pass-through + response.body access", () => {
  const mappings = extractMappingsOut((s: any, res: any) => ({
    ...s,
    id: res.body.userId,
  }));
  const idMapping = mappings.find((m) => m.target === "state.id");
  expect(idMapping).toBeDefined();
  expect((idMapping!.source as any).path).toBe("response.body.userId");
});
