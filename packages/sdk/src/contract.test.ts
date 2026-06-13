/**
 * Tests for the protocol-agnostic contract core (`contract-core.ts`).
 *
 * Scope: register / dispatcher / bootstrap / tracer. (Legacy flow tests
 * were deleted with contract.flow — Nv1-D2.)
 * All HTTP-specific behavior tests live in `./contract-http/*.test.ts` (P2).
 *
 * Uses a mock adapter to avoid any HTTP dependency.
 */

import { test, expect, beforeEach } from "vitest";
import {
  contract,
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
} from "./contract-types.js";
import type { TestContext } from "./types.js";
import {
  clearRegistry,
  getRegistry,
  setExplicitInput,
  setBootstrapInput,
  setForceStandalone,
  clearRunnerInputs,
} from "./internal.js";
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
  clearRunnerInputs();
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

test("needs case without overlay hard-errors before adapter.execute (RFR v3 P1)", async () => {
  // Per attachment model §5.1: a case declaring `needs` cannot run without
  // an input source. Three valid sources: (1) bootstrap overlay, (2) explicit
  // --input-json (Spike 3), (3) flow `.step({ in })` (different code path).
  // The standalone-no-overlay branch must hard-error rather than feed
  // undefined to the adapter and let author callbacks blow up cryptically.
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  contract.register("mock_needs_no_overlay", adapter);

  // Mock adapter case shape doesn't include `needs`, so cast to bypass.
  const c = (contract as any).mock_needs_no_overlay("svc", {
    target: "/x",
    cases: {
      ok: {
        description: "needs case",
        needs: { safeParse: () => ({ success: true, data: undefined }) },
      },
    },
  }) as ProtocolContract<MockSpec>;

  // Intentionally NO contract.bootstrap(...) registered

  await expect(c[0]!.fn!(makeMockCtx())).rejects.toThrow(
    /declares `needs` but has no bootstrap overlay and no explicit input/,
  );
  expect(log).not.toContain("execute:needs case"); // adapter never reached
});

test("no-needs case with requireAttachment hard-errors when overlay missing (RFR v6 P1.2)", async () => {
  // A case with no `needs` but `runnability.requireAttachment: true`
  // explicitly opts out of raw execution. Without this guard, the v3
  // P1 check (which only looks at `needs`) would let the case silently
  // fall through to `adapter.execute`, violating the attachment invariant.
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  contract.register("mock_require_attachment", adapter);

  const c = (contract as any).mock_require_attachment("svc", {
    target: "/x",
    cases: {
      ok: {
        description: "no needs but requires attachment",
        runnability: { requireAttachment: true },
      },
    },
  }) as ProtocolContract<MockSpec>;

  // Intentionally NO contract.bootstrap(...) registered

  await expect(c[0]!.fn!(makeMockCtx())).rejects.toThrow(
    /runnability\.requireAttachment.*no bootstrap overlay is registered/,
  );
  expect(log).not.toContain("execute:no needs but requires attachment");
});

test("no-needs case with requireSession hard-errors when session state is absent", async () => {
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  contract.register("mock_require_session", adapter);

  const c = (contract as any).mock_require_session("svc", {
    target: "/x",
    cases: {
      ok: {
        description: "requires project session",
        runnability: { requireSession: true },
      },
    },
  }) as ProtocolContract<MockSpec>;

  await expect(c[0]!.fn!(makeMockCtx())).rejects.toThrow(
    /runnability\.requireSession.*no session state is available/,
  );
  expect(log).not.toContain("execute:requires project session");
});

test("no-needs case with requireSession executes when session state exists", async () => {
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  contract.register("mock_require_session_present", adapter);

  const c = (contract as any).mock_require_session_present("svc", {
    target: "/x",
    cases: {
      ok: {
        description: "requires project session",
        runnability: { requireSession: true },
      },
    },
  }) as ProtocolContract<MockSpec>;

  expect((c.case("ok") as { runnability?: unknown }).runnability).toEqual({ requireSession: true });

  await c[0]!.fn!(
    makeMockCtx({
      session: {
        get: () => "session-token",
        set: () => {},
        require: () => "session-token",
        entries: () => ({ token: "session-token" }),
      } as any,
    }),
  );

  expect(log).toContain("execute:requires project session");
});

test("overlay with adapter missing executeCase hard-errors (no silent fallback)", async () => {
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  // Deliberately do NOT set adapter.executeCase — simulates an unmigrated
  // adapter (pre-Phase-2b) with an overlay registered.
  contract.register("mock_no_execcase", adapter);

  const c = (contract as any).mock_no_execcase("svc", {
    target: "/x",
    cases: { ok: { description: "unmigrated adapter" } },
  }) as ProtocolContract<MockSpec>;

  (contract.bootstrap as any)(
    c.case("ok"),
    async () => ({ token: "seeded" }),
  );

  await expect(c[0]!.fn!(makeMockCtx())).rejects.toThrow(
    /has not been migrated to the attachment model/,
  );
  expect(log).not.toContain("execute:unmigrated adapter"); // legacy NOT silently invoked
});

// =============================================================================
// §5.1 Runnable resolution algorithm — Spike 3 runner input channels
// =============================================================================

test("§5.1 step 1: explicit input wins, overlay NOT invoked", async () => {
  // Both an overlay AND explicit input are present. Per §5.1 invariants,
  // the overlay must NOT be invoked — explicit input is trusted directly.
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  let executedInput: unknown = "<not-called>";
  adapter.executeCase = async ({ resolvedInput }) => {
    executedInput = resolvedInput;
    log.push("executeCase");
  };
  contract.register("mock_step1", adapter);

  const tokenSchema = {
    safeParse: (d: unknown) =>
      typeof d === "object" && d !== null && typeof (d as any).token === "string"
        ? { success: true as const, data: d as { token: string } }
        : { success: false as const, error: { issues: [{ message: "token required" }] } },
  };

  const c = (contract as any).mock_step1("svc", {
    target: "/x",
    cases: { ok: { description: "explicit-wins", needs: tokenSchema } },
  }) as ProtocolContract<MockSpec>;

  // Register an overlay that, if invoked, would log "OVERLAY_RAN".
  (contract.bootstrap as any)(c.case("ok"), async () => {
    log.push("OVERLAY_RAN");
    return { token: "from-overlay" };
  });

  // Provide explicit input. Per §5.1 step 1: dispatch must validate AND
  // run raw with this input, ignoring the overlay.
  setExplicitInput("svc.ok", { token: "from-cli" });

  await c[0]!.fn!(makeMockCtx());

  expect(log).toContain("executeCase");
  expect(log).not.toContain("OVERLAY_RAN");
  expect(executedInput).toEqual({ token: "from-cli" });
});

test("§5.1 step 1: explicit input validated against needs schema; rejects bad shape", async () => {
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  adapter.executeCase = async () => { log.push("executeCase"); };
  contract.register("mock_step1_validate", adapter);

  const tokenSchema = {
    safeParse: (d: unknown) =>
      typeof d === "object" && d !== null && typeof (d as any).token === "string"
        ? { success: true as const, data: d as { token: string } }
        : {
            success: false as const,
            error: { issues: [{ path: ["token"], message: "token required" }] },
          },
  };

  const c = (contract as any).mock_step1_validate("svc", {
    target: "/x",
    cases: { ok: { description: "validate", needs: tokenSchema } },
  }) as ProtocolContract<MockSpec>;

  setExplicitInput("svc.ok", { wrongField: 123 });

  await expect(c[0]!.fn!(makeMockCtx())).rejects.toThrow(
    /Explicit input.*does not satisfy needs schema/,
  );
  expect(log).not.toContain("executeCase");
});

test("§5.1 step 1b: no-needs case + explicit input → reject (input meaningless)", async () => {
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  adapter.executeCase = async () => { log.push("executeCase"); };
  contract.register("mock_step1b", adapter);

  const c = (contract as any).mock_step1b("svc", {
    target: "/x",
    cases: { ok: { description: "no-needs case" } },
  }) as ProtocolContract<MockSpec>;

  setExplicitInput("svc.ok", { whatever: 1 });

  await expect(c[0]!.fn!(makeMockCtx())).rejects.toThrow(
    /has no `needs` schema; explicit input is meaningless/,
  );
  expect(log).not.toContain("executeCase");
});

test("§5.1 step 1b: no-needs + requireAttachment + explicit input → reject with --force-standalone hint", async () => {
  const adapter = makeMockAdapter();
  adapter.executeCase = async () => {};
  contract.register("mock_step1b_req", adapter);

  const c = (contract as any).mock_step1b_req("svc", {
    target: "/x",
    cases: {
      ok: {
        description: "no-needs require-attach",
        runnability: { requireAttachment: true },
      },
    },
  }) as ProtocolContract<MockSpec>;

  setExplicitInput("svc.ok", { whatever: 1 });

  await expect(c[0]!.fn!(makeMockCtx())).rejects.toThrow(
    /Use --force-standalone for debug, or attach a bootstrap/,
  );
});

test("§5.1 step 3: bootstrap input feeds overlay's structured-form `params` schema", async () => {
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  adapter.executeCase = async () => { log.push("executeCase"); };
  contract.register("mock_step3", adapter);

  const c = (contract as any).mock_step3("svc", {
    target: "/x",
    cases: { ok: { description: "params form" } },
  }) as ProtocolContract<MockSpec>;

  let receivedParams: unknown = "<not-called>";
  // Structured form WITH params. Spike 3: this is now valid. Bootstrap
  // input is validated against the params schema and passed to run().
  (contract.bootstrap as any)(c.case("ok"), {
    params: {
      safeParse: (d: unknown) =>
        typeof d === "object" && d !== null && typeof (d as any).projectId === "string"
          ? { success: true as const, data: d as { projectId: string } }
          : {
              success: false as const,
              error: { issues: [{ path: ["projectId"], message: "projectId required" }] },
            },
    },
    run: async (_ctx: any, params: any) => {
      receivedParams = params;
    },
  });

  setBootstrapInput("svc.ok", { projectId: "p_42" });

  await c[0]!.fn!(makeMockCtx());

  expect(log).toContain("executeCase");
  expect(receivedParams).toEqual({ projectId: "p_42" });
});

test("§5.1 step 3: bootstrap input rejected when fails params schema", async () => {
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  adapter.executeCase = async () => { log.push("executeCase"); };
  contract.register("mock_step3_bad", adapter);

  const c = (contract as any).mock_step3_bad("svc", {
    target: "/x",
    cases: { ok: { description: "bad params" } },
  }) as ProtocolContract<MockSpec>;

  (contract.bootstrap as any)(c.case("ok"), {
    params: {
      safeParse: (d: unknown) =>
        typeof d === "object" && d !== null && typeof (d as any).projectId === "string"
          ? { success: true as const, data: d as { projectId: string } }
          : {
              success: false as const,
              error: { issues: [{ path: ["projectId"], message: "projectId required" }] },
            },
    },
    run: async () => undefined,
  });

  setBootstrapInput("svc.ok", { wrongShape: true });

  await expect(c[0]!.fn!(makeMockCtx())).rejects.toThrow(
    /Bootstrap params.*does not satisfy params schema/,
  );
  expect(log).not.toContain("executeCase");
});

test("§5.1 RFR-followup: bootstrap input + plain-function overlay (no params) hard-errors (was P2 silent drop)", async () => {
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  adapter.executeCase = async () => { log.push("executeCase"); };
  contract.register("mock_bs_no_params", adapter);

  const c = (contract as any).mock_bs_no_params("svc", {
    target: "/x",
    cases: { ok: { description: "no-params overlay" } },
  }) as ProtocolContract<MockSpec>;

  // Plain-function overlay — no `params` schema declared.
  (contract.bootstrap as any)(c.case("ok"), async () => undefined);

  // Runner supplies bootstrap input even though overlay can't consume it.
  // Pre-fix: silently dropped. Post-fix: hard-error before run().
  setBootstrapInput("svc.ok", { projectId: "p_1" });

  await expect(c[0]!.fn!(makeMockCtx())).rejects.toThrow(
    /runner supplied bootstrap input.*does not declare a `params` schema/,
  );
  expect(log).not.toContain("executeCase");
});

test("§5.1 RFR-followup: bootstrap input + no overlay registered hard-errors (was P1.2 silent drop)", async () => {
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  contract.register("mock_bs_no_overlay", adapter);

  const c = (contract as any).mock_bs_no_overlay("svc", {
    target: "/x",
    cases: { ok: { description: "no overlay" } },
  }) as ProtocolContract<MockSpec>;

  // No bootstrap registered — but runner supplies bootstrap input.
  // Pre-fix: silently fell through to raw `adapter.execute`.
  // Post-fix: hard-error.
  setBootstrapInput("svc.ok", { projectId: "p_1" });

  await expect(c[0]!.fn!(makeMockCtx())).rejects.toThrow(
    /runner supplied bootstrap input but no bootstrap overlay is registered/,
  );
  expect(log).not.toContain("execute:no overlay");
});

test("§5.1 step 2: requireAttachment + no overlay + --force-standalone bypasses guard with warning", async () => {
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  contract.register("mock_force_std", adapter);

  const c = (contract as any).mock_force_std("svc", {
    target: "/x",
    cases: {
      ok: {
        description: "force-std bypass",
        runnability: { requireAttachment: true },
      },
    },
  }) as ProtocolContract<MockSpec>;

  // Capture console.warn to verify the debug warning fires.
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = ((...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.warn;

  try {
    setForceStandalone("svc.ok");
    await c[0]!.fn!(makeMockCtx());
  } finally {
    console.warn = originalWarn;
  }

  // Adapter ran (raw path).
  expect(log).toContain("execute:force-std bypass");
  // Warning emitted.
  expect(warnings.some((w) => /bypassing runnability\.requireAttachment/.test(w))).toBe(true);
});

test("overlay with structured-form WITHOUT params is accepted (pre-Spike-3)", async () => {
  const log: string[] = [];
  const adapter = makeMockAdapter({ executionLog: log });
  adapter.executeCase = async () => { log.push("executeCase"); };
  contract.register("mock_noparams", adapter);

  const c = (contract as any).mock_noparams("svc", {
    target: "/x",
    cases: { ok: { description: "no-params struct" } },
  }) as ProtocolContract<MockSpec>;

  (contract.bootstrap as any)(c.case("ok"), {
    // No `params` field — valid before Spike 3.
    run: async (_ctx: any) => undefined,
  });

  await c[0]!.fn!(makeMockCtx());
  expect(log).toContain("executeCase");
});

test("cleanup error is reported on ALL three failure paths (not swallowed)", async () => {
  // All three paths that had cleanup-running code: bootstrap-run throws,
  // needs-validation fails, executeCase throws. Previously two of them
  // swallowed cleanup errors silently; v3 unifies via runCleanupsLifo.
  const originalConsoleError = console.error;
  const consoleLog: unknown[][] = [];
  console.error = ((...args: unknown[]) => { consoleLog.push(args); }) as typeof console.error;

  try {
    // Path 1: bootstrap-run throws
    {
      const adapter = makeMockAdapter();
      adapter.executeCase = async () => {};
      contract.register("mock_path1", adapter);
      const c = (contract as any).mock_path1("svc", {
        target: "/x",
        cases: { ok: { description: "p1" } },
      }) as ProtocolContract<MockSpec>;
      (contract.bootstrap as any)(c.case("ok"), async (ctx: any) => {
        ctx.cleanup(() => { throw new Error("cleanup-p1"); });
        throw new Error("bootstrap-p1");
      });
      await expect(c[0]!.fn!(makeMockCtx())).rejects.toThrow("bootstrap-p1");
    }

    // Path 2: needs validation fails
    clearRegistry();
    clearBootstrapRegistry();
    {
      const adapter = makeMockAdapter();
      adapter.executeCase = async () => {};
      contract.register("mock_path2", adapter);
      const schema = {
        safeParse: () => ({
          success: false as const,
          error: { issues: [{ message: "p2 validation" }] },
        }),
      };
      const c = (contract as any).mock_path2("svc", {
        target: "/x",
        cases: { ok: { description: "p2", needs: schema } },
      }) as ProtocolContract<MockSpec>;
      (contract.bootstrap as any)(c.case("ok"), async (ctx: any) => {
        ctx.cleanup(() => { throw new Error("cleanup-p2"); });
        return { anything: true };
      });
      await expect(c[0]!.fn!(makeMockCtx())).rejects.toThrow(/p2 validation/);
    }

    // Path 3: executeCase throws
    clearRegistry();
    clearBootstrapRegistry();
    {
      const adapter = makeMockAdapter();
      adapter.executeCase = async () => { throw new Error("case-p3"); };
      contract.register("mock_path3", adapter);
      const c = (contract as any).mock_path3("svc", {
        target: "/x",
        cases: { ok: { description: "p3" } },
      }) as ProtocolContract<MockSpec>;
      (contract.bootstrap as any)(c.case("ok"), async (ctx: any) => {
        ctx.cleanup(() => { throw new Error("cleanup-p3"); });
        return undefined;
      });
      await expect(c[0]!.fn!(makeMockCtx())).rejects.toThrow("case-p3");
    }

    // All three cleanup errors should have been reported via console.error
    const flat = consoleLog.map((args) => args.join(" ")).join("\n");
    expect(flat).toMatch(/cleanup-p1/);
    expect(flat).toMatch(/cleanup-p2/);
    expect(flat).toMatch(/cleanup-p3/);
  } finally {
    console.error = originalConsoleError;
  }
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
