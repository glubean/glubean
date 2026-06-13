/**
 * Poll Phase 1 — runtime (bounded retry, exit tiers, quarantine), bound
 * validation, and projection. The builder (FlowBuilder.poll) lands in Phase 2,
 * so these tests hand-build a RuntimePollStep and run it through `runFlow`,
 * mirroring how the condition runtime was tested before its builder.
 */
import { afterEach, describe, expect, test } from "vitest";
import { runFlow, normalizeFlow, contract } from "./index.js";
import { __unregisterProtocolForTesting } from "./contract-core.js";
import { predicateScope } from "./predicates.js";
import {
  validatePollBounds,
  PollExhaustedError,
  evalPollExit,
  quarantinedCtx,
  type RuntimePollStep,
} from "./poll-primitives.js";
import type { TestContext } from "./types.js";

const ctx = { log: () => {} } as unknown as TestContext;
const PROTO = "pollmock";

/** Register a mock adapter whose executeCaseInFlow replays a response sequence. */
function mockAdapter(responses: unknown[], opts?: { onCall?: (n: number) => void }): { calls: number } {
  const state = { calls: 0 };
  contract.register(PROTO, {
    executeCaseInFlow: async (_input: unknown) => {
      opts?.onCall?.(state.calls);
      const r = responses[Math.min(state.calls, responses.length - 1)];
      state.calls += 1;
      return r;
    },
  } as never);
  return state;
}

/** Hand-build a flow whose only step is the given poll step. */
function pollFlow(
  poll: Partial<RuntimePollStep> & Pick<RuntimePollStep, "until">,
  setupState: Record<string, unknown>,
  box: { value: any },
): any {
  const step: RuntimePollStep = {
    kind: "poll",
    caseKey: "status",
    ref: { protocol: PROTO, contractId: "job", caseKey: "status", target: "GET /jobs/:id" } as any,
    contract: {
      _projection: { id: "job", protocol: PROTO, target: "GET /jobs/:id" },
      _spec: { cases: { status: {} } },
    } as any,
    every: 1,
    backoff: 1,
    ...poll,
  };
  return {
    _flow: {
      id: "poll-test",
      setup: async () => ({ ...setupState }),
      steps: [step],
      teardown: async (_c: TestContext, s: unknown) => {
        box.value = s;
      },
    },
  };
}

afterEach(() => __unregisterProtocolForTesting(PROTO));

// ── bound validation ─────────────────────────────────────────────────────────

describe("validatePollBounds", () => {
  test("accepts timeout-only", () => {
    expect(() => validatePollBounds({ timeout: 1000 }, "p")).not.toThrow();
  });
  test("accepts maxAttempts + perAttemptTimeout", () => {
    expect(() => validatePollBounds({ maxAttempts: 5, perAttemptTimeout: 100 }, "p")).not.toThrow();
  });
  test("rejects no stop condition", () => {
    expect(() => validatePollBounds({ perAttemptTimeout: 100 }, "p")).toThrow(/stop condition/);
  });
  test("rejects maxAttempts-only (no per-attempt budget)", () => {
    expect(() => validatePollBounds({ maxAttempts: 5 }, "p")).toThrow(/not bounded/);
  });
  test("rejects Infinity timeout", () => {
    expect(() => validatePollBounds({ timeout: Infinity }, "p")).toThrow(/finite/);
  });
  test("rejects Infinity maxAttempts", () => {
    expect(() => validatePollBounds({ maxAttempts: Infinity, perAttemptTimeout: 100 }, "p")).toThrow(/finite/);
  });
  test("rejects Infinity every", () => {
    expect(() => validatePollBounds({ timeout: 1000, every: Infinity }, "p")).toThrow(/finite/);
  });
  test("rejects non-integer maxAttempts", () => {
    expect(() => validatePollBounds({ maxAttempts: 2.5, perAttemptTimeout: 100 }, "p")).toThrow(/integer/);
  });
});

// ── runtime: bounded retry ─────────────────────────────────────────────────────

describe("runtime — bounded retry until satisfied", () => {
  test("L2 exit on response.status retries pending then commits out on satisfaction", async () => {
    const adapter = mockAdapter([
      { status: 202, body: { state: "pending" } },
      { status: 202, body: { state: "pending" } },
      { status: 200, body: { state: "done" } },
    ]);
    const box = { value: undefined as any };
    const until = predicateScope<{ status: number }>().when((r) => r.status).eq(200);
    const flow = pollFlow(
      {
        until,
        bindings: { out: (s: any, res: any) => ({ ...s, settled: res.status === 200, body: res.body }) },
        timeoutMs: 5000,
      },
      { jobId: "j1" },
      box,
    );
    await runFlow(flow, ctx);
    expect(adapter.calls).toBe(3);
    expect(box.value.settled).toBe(true);
    expect(box.value.body).toEqual({ state: "done" });
    expect(box.value.jobId).toBe("j1"); // state threaded
  });

  test("opaque (L1) exit on body retries until done", async () => {
    const adapter = mockAdapter([
      { status: 200, body: { state: "pending" } },
      { status: 200, body: { state: "done" } },
    ]);
    const box = { value: undefined as any };
    const flow = pollFlow(
      {
        until: {
          kind: "opaque",
          sync: true,
          fn: (_c: TestContext, res: any) => res.body.state === "done",
        },
        message: "state == done",
        bindings: { out: (s: any, res: any) => ({ ...s, report: res.body }) },
        maxAttempts: 10,
        perAttemptTimeoutMs: 1000,
      },
      {},
      box,
    );
    await runFlow(flow, ctx);
    expect(adapter.calls).toBe(2);
    expect(box.value.report).toEqual({ state: "done" });
  });

  test("omitted backoff defaults to 1 in the loop (no NaN delay)", async () => {
    const adapter = mockAdapter([
      { status: 202, body: {} },
      { status: 200, body: {} },
    ]);
    const box = { value: undefined as any };
    const until = predicateScope<{ status: number }>().when((r) => r.status).eq(200);
    // backoff omitted → runtime defaults to 1; delay * undefined would be NaN.
    const flow = pollFlow({ until, timeoutMs: 5000, every: 5, backoff: undefined as any }, {}, box);
    await runFlow(flow, ctx);
    expect(adapter.calls).toBe(2); // retried once at the default backoff, then satisfied
  });

  test("first attempt already satisfied → 1 call, no waiting", async () => {
    const adapter = mockAdapter([{ status: 200, body: {} }]);
    const box = { value: undefined as any };
    const until = predicateScope<{ status: number }>().when((r) => r.status).eq(200);
    const flow = pollFlow({ until, timeoutMs: 5000 }, {}, box);
    await runFlow(flow, ctx);
    expect(adapter.calls).toBe(1);
  });
});

// ── runtime: exhaustion ─────────────────────────────────────────────────────

describe("runtime — exhaustion fails the flow", () => {
  test("maxAttempts reached without satisfaction → PollExhaustedError", async () => {
    mockAdapter([{ status: 202, body: {} }]); // always pending
    const box = { value: undefined as any };
    const until = predicateScope<{ status: number }>().when((r) => r.status).eq(200);
    const flow = pollFlow({ until, maxAttempts: 3, perAttemptTimeoutMs: 1000, every: 1 }, {}, box);
    await expect(runFlow(flow, ctx)).rejects.toThrow(PollExhaustedError);
  });

  test("total timeout reached → PollExhaustedError", async () => {
    mockAdapter([{ status: 202, body: {} }]); // always pending
    const box = { value: undefined as any };
    const until = predicateScope<{ status: number }>().when((r) => r.status).eq(200);
    const flow = pollFlow({ until, timeoutMs: 40, every: 10 }, {}, box);
    await expect(runFlow(flow, ctx)).rejects.toThrow(/exhausted/);
  });

  test("runtime guard: an unbounded poll step (bypassing the builder) fails fast", async () => {
    mockAdapter([{ status: 202, body: {} }]); // always pending — would loop forever if unbounded
    const box = { value: undefined as any };
    const until = predicateScope<{ status: number }>().when((r) => r.status).eq(200);
    // No timeoutMs / maxAttempts / perAttemptTimeoutMs — validatePollBounds must reject.
    const flow = pollFlow({ until }, {}, box);
    await expect(runFlow(flow, ctx)).rejects.toThrow(/stop condition/);
  });

  test("in-budget predicate ctx.fail fails the poll and the failure assertion lands", async () => {
    mockAdapter([{ status: 200, body: {} }]);
    const asserts: Array<{ passed: boolean; msg?: string }> = [];
    const failCtx = {
      log: () => {},
      assert: (a: any, m?: string) => asserts.push({ passed: a.passed ?? a, msg: m }),
    } as unknown as TestContext;
    const flow = pollFlow(
      {
        until: {
          kind: "opaque",
          sync: true,
          fn: (c: TestContext) => {
            c.fail("predicate says no");
            return false;
          },
        },
        message: "x",
        timeoutMs: 1000,
      },
      {},
      { value: undefined },
    );
    await expect(runFlow(flow, failCtx)).rejects.toThrow("predicate says no");
    expect(asserts).toContainEqual({ passed: false, msg: "predicate says no" }); // flushed to real ctx
  });

  test("signal-honoring adapter aborting on budget → PollExhaustedError, not AbortError", async () => {
    // Adapter hangs until aborted, then rejects AbortError (like fetch with signal).
    contract.register(PROTO, {
      executeCaseInFlow: (input: any) =>
        new Promise((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    } as never);
    const box = { value: undefined as any };
    const until = predicateScope<{ status: number }>().when((r) => r.status).eq(200);
    const flow = pollFlow({ until, maxAttempts: 1, perAttemptTimeoutMs: 20 }, {}, box);
    await expect(runFlow(flow, ctx)).rejects.toThrow(PollExhaustedError);
  });
});

// ── runtime: exit-predicate semantics ───────────────────────────────────────

describe("evalPollExit — tiers + fail-fast", () => {
  test("L1 sync predicate returning a thenable is rejected", async () => {
    await expect(
      evalPollExit(
        { kind: "opaque", sync: true, fn: () => Promise.resolve(true) as any },
        { status: 200 },
        ctx,
        {},
      ),
    ).rejects.toThrow(/must be synchronous/);
  });

  test("non-boolean result is rejected (fail-fast)", async () => {
    await expect(
      evalPollExit(
        { kind: "opaque", sync: true, fn: () => "done" as any },
        { status: 200 },
        ctx,
        {},
      ),
    ).rejects.toThrow(/must return a boolean/);
  });

  test("opaque predicate receives (ctx, res, state)", async () => {
    let seenState: any;
    const r = await evalPollExit(
      {
        kind: "opaque",
        sync: true,
        fn: (_c: TestContext, res: any, state: any) => {
          seenState = state;
          return res.v >= state.want;
        },
      },
      { v: 5 },
      ctx,
      { want: 3 },
    );
    expect(r).toBe(true);
    expect(seenState).toEqual({ want: 3 });
  });
});

// ── quarantine ──────────────────────────────────────────────────────────────

describe("quarantinedCtx", () => {
  test("buffers assert until flushed; hasFailure reflects a buffered failure", () => {
    const seen: Array<{ msg?: string }> = [];
    const real = {
      assert: (a: any, msg?: string) => seen.push({ msg }),
      log: () => {},
    } as unknown as TestContext;
    const q = quarantinedCtx(real);
    q.assert(false, "boom");
    expect(seen).toHaveLength(0); // buffered, not emitted
    expect(q.hasFailure()).toBe(true);
    q.flushTo(real);
    expect(seen).toEqual([{ msg: "boom" }]);
  });

  test("discarded buffer (no flush) never reaches the real ctx", () => {
    const seen: string[] = [];
    const real = { assert: (_a: any, m?: string) => seen.push(m ?? ""), log: () => {} } as unknown as TestContext;
    const q = quarantinedCtx(real);
    q.assert(false, "probe-noise");
    // no flush → discarded
    expect(seen).toHaveLength(0);
  });

  test("validate runs a parse-only schema and returns the transformed value", () => {
    const real = { validate: () => {}, log: () => {} } as unknown as TestContext;
    const q = quarantinedCtx(real);
    const parseSchema = { parse: (d: any) => ({ ...d, parsed: true }) } as any;
    const out = q.validate({ a: 1 }, parseSchema, "body");
    expect(out).toEqual({ a: 1, parsed: true }); // transformed, not undefined
    expect(q.hasFailure()).toBe(false);
  });

  test("validate records failure when a parse-only schema throws", () => {
    const real = { validate: () => {}, log: () => {} } as unknown as TestContext;
    const q = quarantinedCtx(real);
    const badSchema = { parse: () => { throw new Error("bad"); } } as any;
    const out = q.validate({ a: 1 }, badSchema, "body");
    expect(out).toBeUndefined();
    expect(q.hasFailure()).toBe(true);
  });

  test("fail buffers the assertion (no real emit until flush) and throws", () => {
    const seen: Array<{ passed: boolean; msg?: string }> = [];
    let realFailCalled = false;
    const real = {
      assert: (a: any, msg?: string) => seen.push({ passed: a.passed ?? a, msg }),
      fail: () => { realFailCalled = true; throw new Error("real-fail"); },
      log: () => {},
    } as unknown as TestContext;
    const q = quarantinedCtx(real);
    expect(() => q.fail("boom")).toThrow("boom");
    expect(realFailCalled).toBe(false); // did NOT delegate to real.fail (no orphan leak)
    expect(seen).toHaveLength(0); // buffered
    expect(q.hasFailure()).toBe(true);
    q.flushTo(real);
    expect(seen).toEqual([{ passed: false, msg: "boom" }]);
  });

  test("prototype-inherited ctx APIs survive quarantine (test.extend fixture ctx)", () => {
    const base = {
      vars: { get: () => "v" },
      log: () => {},
      assert: () => {},
    } as unknown as TestContext;
    const fixtureCtx = Object.create(base) as TestContext; // prototype-linked, like test.extend
    const q = quarantinedCtx(fixtureCtx);
    expect((q as any).vars.get()).toBe("v"); // inherited via prototype chain, not dropped
    expect(typeof (q as any).log).toBe("function");
  });

  test("validate with severity:fatal throws on failure (control flow preserved)", () => {
    const real = { validate: () => {}, log: () => {} } as unknown as TestContext;
    const q = quarantinedCtx(real);
    const schema = { safeParse: (_d: any) => ({ success: false }) } as any;
    expect(() => q.validate({ a: 1 }, schema, "body", { severity: "fatal" })).toThrow(/fatal validation/);
    expect(q.hasFailure()).toBe(true);
  });
});

// ── projection ──────────────────────────────────────────────────────────────

describe("projection — extractPollStep via normalizeFlow", () => {
  test("L2 poll projects until predicate + bounds + accept", () => {
    const box = { value: undefined as any };
    const until = predicateScope<{ status: number }>().when((r) => r.status).eq(200);
    const flow = pollFlow(
      {
        until,
        bindings: { accept: [200, 202], out: (s: any, res: any) => ({ ...s, body: res.body }) },
        every: 1000,
        backoff: 2,
        timeoutMs: 30000,
      },
      {},
      box,
    );
    const extracted = normalizeFlow(flow._flow) as any;
    const step = extracted.steps[0];
    expect(step.kind).toBe("poll");
    expect(step.contractId).toBe("job");
    expect(step.caseKey).toBe("status");
    expect(step.until).toEqual({ kind: "compare", op: "eq", path: ["status"], value: 200 });
    expect(step.accept).toEqual([200, 202]);
    expect(step.every).toBe(1000);
    expect(step.backoff).toBe(2);
    expect(step.timeoutMs).toBe(30000);
  });

  test("opaque poll projects { kind: opaque } + message + perAttemptTimeout", () => {
    const box = { value: undefined as any };
    const flow = pollFlow(
      {
        until: { kind: "opaque", sync: false, fn: async () => true },
        message: "settled",
        maxAttempts: 30,
        perAttemptTimeoutMs: 5000,
      },
      {},
      box,
    );
    const extracted = normalizeFlow(flow._flow) as any;
    const step = extracted.steps[0];
    expect(step.until).toEqual({ kind: "opaque", strictness: "L0", mayDoAsyncIO: true });
    expect(step.message).toBe("settled");
    expect(step.maxAttempts).toBe(30);
    expect(step.perAttemptTimeoutMs).toBe(5000);
  });
});
