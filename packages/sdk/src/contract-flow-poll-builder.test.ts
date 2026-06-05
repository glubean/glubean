/**
 * Poll Phase 2 — FlowBuilder.poll / pollFn / pollAsync (+ FlowFragmentBuilder)
 * authoring surface: desugar + build-time validation + runtime behavior, plus
 * compile-time `_typeTests` (never called; `tsc --noEmit` enforces the
 * @ts-expect-error directives — mirrors Spike P against the real API).
 */
import { afterEach, describe, expect, test } from "vitest";
import { contract, runFlow } from "./index.js";
import { LensPurityError } from "./contract-core.js";
import type { FlowBuilder, ContractCaseRef } from "./contract-types.js";
import type { TestContext } from "./types.js";

const ctx = { log: () => {} } as unknown as TestContext;
const PROTO = "pollmock";

function mockAdapter(responses: unknown[]): { calls: number } {
  const state = { calls: 0 };
  contract.register(PROTO, {
    executeCaseInFlow: async () => {
      const r = responses[Math.min(state.calls, responses.length - 1)];
      state.calls += 1;
      return r;
    },
  } as never);
  return state;
}

/** A hand-built ContractCaseRef for the mock protocol (the builder reads protocol/contract/caseKey). */
function mockRef(): ContractCaseRef<any, any, any, any> {
  return {
    protocol: PROTO,
    contractId: "job",
    caseKey: "status",
    target: "GET /jobs/:id",
    contract: {
      _projection: { id: "job", protocol: PROTO, target: "GET /jobs/:id" },
      _spec: { cases: { status: {} } },
    },
  } as any;
}

afterEach(async () => {
  const { __unregisterProtocolForTesting } = await import("./contract-core.js");
  __unregisterProtocolForTesting(PROTO);
});

// ── desugar + runtime ───────────────────────────────────────────────────────

describe("FlowBuilder.poll — desugar + runtime", () => {
  test("L2 poll desugars to a poll step and retries until satisfied", async () => {
    const adapter = mockAdapter([
      { status: 202, body: { s: "pending" } },
      { status: 200, body: { s: "done" } },
    ]);
    const box = { value: undefined as any };
    const f = contract
      .flow("p2-poll-1")
      .setup(async () => ({ jobId: "j1" }))
      .poll(mockRef() as ContractCaseRef<{ params: { id: string } }, unknown, number, { status: number; body: unknown }>, {
        in: (s) => ({ params: { id: s.jobId } }),
        accept: [200, 202],
        until: (w) => w.when((r) => r.status).eq(200),
        every: 1,
        timeout: 5000,
        out: (s, res) => ({ ...s, settled: res.status === 200 }),
      })
      .teardown(async (_c, s) => {
        box.value = s;
      })
      .build();

    const step = f._flow.steps[0] as any;
    expect(step.kind).toBe("poll");
    expect(step.until.kind).toBe("compare"); // L2 branded predicate
    expect(step.bindings.accept).toEqual([200, 202]);
    expect(step.every).toBe(1);
    expect(step.timeoutMs).toBe(5000);

    await runFlow(f, ctx);
    expect(adapter.calls).toBe(2);
    expect(box.value.settled).toBe(true);
  });

  test("pollFn (opaque L1) desugars with an opaque exit predicate", async () => {
    mockAdapter([{ status: 200, body: { s: "done" } }]);
    const f = contract
      .flow("p2-poll-2")
      .setup(async () => ({}))
      .pollFn(mockRef(), {
        accept: [200],
        until: (_c, res: any) => res.body.s === "done",
        message: "job done",
        maxAttempts: 5,
        perAttemptTimeout: 1000,
      })
      .build();
    const step = f._flow.steps[0] as any;
    expect(step.until.kind).toBe("opaque");
    expect(step.until.sync).toBe(true);
    expect(step.message).toBe("job done");
  });
});

// ── build-time validation ───────────────────────────────────────────────────

describe("FlowBuilder.poll — build-time validation", () => {
  test("opaque poll without a message throws", () => {
    mockAdapter([{ status: 200 }]);
    expect(() =>
      contract
        .flow("p2-bad-1")
        .setup(async () => ({}))
        .pollFn(mockRef(), {
          until: () => true,
          message: "" as any, // empty → rejected
          timeout: 1000,
        }),
    ).toThrow(LensPurityError);
  });

  test("unbounded poll (no stop condition) throws", () => {
    mockAdapter([{ status: 200 }]);
    expect(() =>
      contract
        .flow("p2-bad-2")
        .setup(async () => ({}))
        .poll(mockRef(), {
          until: (w: any) => w.when((r: any) => r.status).eq(200),
        } as any),
    ).toThrow(/stop condition/);
  });

  test("maxAttempts-only (no per-attempt budget) throws", () => {
    mockAdapter([{ status: 200 }]);
    expect(() =>
      contract
        .flow("p2-bad-3")
        .setup(async () => ({}))
        .poll(mockRef(), { until: (w: any) => w.when((r: any) => r.status).eq(200), maxAttempts: 5 } as any),
    ).toThrow(/not bounded/);
  });

  test("forged (non-branded) L2 exit predicate throws", () => {
    mockAdapter([{ status: 200 }]);
    expect(() =>
      contract
        .flow("p2-bad-4")
        .setup(async () => ({}))
        .poll(mockRef(), {
          until: () => ({ kind: "compare", op: "eq", path: ["status"], value: 200 }) as any, // hand-authored, no brand
          timeout: 1000,
        }),
    ).toThrow(LensPurityError);
  });
});

// ── fragment builder (poll inside a branch) ─────────────────────────────────

describe("FlowFragmentBuilder.poll — poll inside a condition branch", () => {
  test("a branch body can poll; only the taken branch's poll runs", async () => {
    const adapter = mockAdapter([
      { status: 202, body: {} },
      { status: 200, body: {} },
    ]);
    const box = { value: undefined as any };
    const f = contract
      .flow("p2-frag-1")
      .setup(async () => ({ needsWait: true, done: false }))
      .condition(
        { predicate: (w) => w.when((s) => s.needsWait).eq(true) },
        (b) =>
          b.poll(mockRef() as ContractCaseRef<void, unknown, number, { status: number; body: unknown }>, {
            accept: [200, 202],
            until: (w) => w.when((r) => r.status).eq(200),
            every: 1,
            timeout: 5000,
            out: (s, res) => ({ ...s, done: res.status === 200 }),
          }),
        (b) => b.compute((s) => s),
      )
      .teardown(async (_c, s) => {
        box.value = s;
      })
      .build();
    await runFlow(f, ctx);
    expect(adapter.calls).toBe(2);
    expect(box.value.done).toBe(true);
  });
});

// ── compile-time type tests (mirrors Spike P against the real API) ──────────

interface HttpRaw {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _typeTests() {
  const fb = null as unknown as FlowBuilder<{ jobId: string }>;
  const voidRef = null as unknown as ContractCaseRef<void, unknown, number, HttpRaw>;
  const needsRef = null as unknown as ContractCaseRef<{ params: { id: string } }, unknown, number, HttpRaw>;

  // GOOD: accept → until/out see RawOutcome (status/headers); void-input → no `in`.
  fb.poll(voidRef, {
    accept: [200, 202],
    until: (w) => w.when((r) => r.status).eq(200),
    timeout: 1000,
    out: (s, res) => ({ ...s, httpStatus: res.status }),
  });

  // GOOD: needs-input → `in` required.
  fb.poll(needsRef, {
    in: (s) => ({ params: { id: s.jobId } }),
    accept: [200],
    until: (w) => w.when((r) => r.status).eq(200),
    maxAttempts: 30,
    perAttemptTimeout: 5000,
  });

  // BAD: needs-input WITHOUT `in`.
  // @ts-expect-error `in` is required for a needs-input case
  fb.poll(needsRef, { accept: [200], until: (w) => w.when((r) => r.status).eq(200), timeout: 1000 });

  // BAD: void-input WITH `in`.
  fb.poll(voidRef, {
    accept: [200],
    // @ts-expect-error void-input case forbids `in`
    in: (s) => ({ params: { id: s.jobId } }),
    until: (w) => w.when((r) => r.status).eq(200),
    timeout: 1000,
  });

  // BAD: no accept ⇒ Res=unknown ⇒ `until` cannot read `.status`.
  fb.poll(voidRef, {
    // @ts-expect-error no accept ⇒ Res=unknown; status not accessible
    until: (w) => w.when((r) => r.status).eq(200),
    timeout: 1000,
  });

  // BAD: .eq value type mismatch (status is number).
  fb.poll(voidRef, {
    accept: [200],
    // @ts-expect-error '200' is not number
    until: (w) => w.when((r) => r.status).eq("200"),
    timeout: 1000,
  });

  // BAD: pollFn requires a message (missing-required-property errors attach to the call).
  // @ts-expect-error message is required for the opaque tier
  fb.pollFn(voidRef, {
    accept: [200],
    until: (_c, _res) => true,
    timeout: 1000,
  });
}
void _typeTests;
