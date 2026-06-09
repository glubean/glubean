import { describe, it, expect } from "vitest";
import type { TestContext, Trace } from "../types.js";
import { GlubeanSkipError } from "../types.js";
import {
  makeNodeScope,
  promoteGrade,
  runNode,
  NodeTimeoutError,
  NODE_START_EVENT,
  NODE_END_EVENT,
} from "./execute.js";
import type { ActionNode, CheckNode, WorkflowTeardown } from "./types.js";

// --- Test doubles ------------------------------------------------------------

interface Recorder {
  events: Array<{ type: string; data: Record<string, unknown> }>;
  asserts: Array<{ passed: boolean; message?: string }>;
  traces: Trace[];
  metrics: Array<{ name: string; value: number }>;
  logs: string[];
  warns: Array<{ condition: boolean; message: string }>;
  validations: number;
}

/** A minimal `TestContext` double that records what a node scope forwards to it. */
function fakeBase(): { ctx: TestContext; rec: Recorder } {
  const rec: Recorder = {
    events: [],
    asserts: [],
    traces: [],
    metrics: [],
    logs: [],
    warns: [],
    validations: 0,
  };
  const ctx = {
    assert: (a: boolean | { passed: boolean }, message?: string) => {
      const passed = typeof a === "boolean" ? a : a.passed;
      rec.asserts.push({ passed, message });
    },
    validate: (data: unknown) => {
      rec.validations++;
      return data;
    },
    trace: (t: Trace) => {
      rec.traces.push(t);
    },
    metric: (name: string, value: number) => {
      rec.metrics.push({ name, value });
    },
    event: (ev: { type: string; data?: Record<string, unknown> }) => {
      rec.events.push({ type: ev.type, data: ev.data ?? {} });
    },
    log: (m: string) => {
      rec.logs.push(m);
    },
    warn: (condition: boolean, message: string) => {
      rec.warns.push({ condition, message });
    },
    action: () => {},
    // Simulate the REAL runner's private SkipError (name "SkipError", NOT the SDK
    // GlubeanSkipError; harness.ts:692). Proves the node scope's own `skip`
    // override — not this base.skip — is what drives classification.
    skip: (reason?: string): never => {
      const e = new Error(reason ?? "skipped");
      e.name = "SkipError";
      throw e;
    },
  } as unknown as TestContext;
  return { ctx, rec };
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const aTrace = (): Trace => ({
  protocol: "http",
  target: "GET /x",
  status: 200,
  durationMs: 1,
  ok: true,
});

const actionNode = (
  id: string,
  fn: ActionNode["fn"],
  project?: ActionNode["project"],
): ActionNode => ({ kind: "action", meta: { id, name: id }, fn, project });

const checkNode = (id: string, fn: CheckNode["fn"]): CheckNode => ({
  kind: "check",
  meta: { id, name: id },
  fn,
});

// --- runNode: happy path + evidence + boundary events ------------------------

describe("runNode — evidence + boundary events", () => {
  it("forwards live evidence, commits the returned state, brackets node_start/node_end", async () => {
    const { ctx, rec } = fakeBase();
    const node = actionNode("seed", async (c, s: { initial: number }) => {
      c.trace(aTrace());
      c.assert(true, "ok");
      return { ...s, seeded: true };
    });

    const res = await runNode(ctx, node, { initial: 1 }, { staticGrade: "partial" });

    expect(res.status).toBe("passed");
    expect(res.state).toEqual({ initial: 1, seeded: true }); // returned state committed (§17 #13)
    expect(res.grade).toBe("partial");
    expect(rec.traces).toHaveLength(1);
    expect(rec.asserts).toEqual([{ passed: true, message: "ok" }]);

    expect(rec.events.map((e) => e.type)).toEqual([NODE_START_EVENT, NODE_END_EVENT]);
    expect(rec.events[0].data).toMatchObject({ nodeId: "seed", kind: "action", name: "seed" });
    expect(rec.events[1].data).toMatchObject({
      nodeId: "seed",
      kind: "action",
      status: "passed",
      grade: "partial",
    });
    expect(typeof rec.events[1].data.durationMs).toBe("number");
  });

  it("void/undefined return PRESERVES prior state (§17 #2)", async () => {
    const { ctx } = fakeBase();
    const node = actionNode("noop", async () => {
      /* returns void */
    });
    const res = await runNode(ctx, node, { keep: true }, { staticGrade: "opaque" });
    expect(res.status).toBe("passed");
    expect(res.state).toEqual({ keep: true });
  });
});

// --- runNode: failure semantics (§17 #5 / #13) -------------------------------

describe("runNode — failure does not commit", () => {
  it("a soft-failed check fails the node and never changes state", async () => {
    const { ctx, rec } = fakeBase();
    const node = checkNode("verify", async (c) => {
      c.expect(1).toBe(2, "mismatch");
    });
    const res = await runNode(ctx, node, { a: 1 }, { staticGrade: "opaque" });
    expect(res.status).toBe("failed");
    expect(res.state).toEqual({ a: 1 }); // check never changes state
    expect(rec.asserts.some((x) => !x.passed)).toBe(true);
    expect(rec.events[1].data).toMatchObject({ status: "failed" });
  });

  it("a thrown body fails the node, keeps prior state, surfaces the error on node_end", async () => {
    const { ctx, rec } = fakeBase();
    const node = actionNode("boom", async () => {
      throw new Error("kaboom");
    });
    const res = await runNode(ctx, node, { s: 1 }, { staticGrade: "opaque" });
    expect(res.status).toBe("failed");
    expect(res.state).toEqual({ s: 1 }); // no commit on failure (§17 #13)
    expect((res.error as Error).message).toBe("kaboom");
    expect(rec.events[1].data).toMatchObject({ status: "failed", error: "kaboom" });
  });

  it("ctx.fail() records a failed assertion and fails the node", async () => {
    const { ctx, rec } = fakeBase();
    const node = actionNode("f", async (c) => {
      c.fail("nope");
    });
    const res = await runNode(ctx, node, {}, { staticGrade: "opaque" });
    expect(res.status).toBe("failed");
    expect(rec.asserts.some((x) => !x.passed && x.message === "nope")).toBe(true);
  });

  it("a soft assertion failure aborts the per-node signal (codex S2.0 P2)", async () => {
    const { ctx } = fakeBase();
    let aborted = false;
    const node = checkNode("c", async (c) => {
      c.signal.addEventListener("abort", () => {
        aborted = true;
      });
      c.expect(1).toBe(2, "soft fail"); // soft fail, body still resolves
    });
    const res = await runNode(ctx, node, {}, { staticGrade: "opaque" });
    expect(res.status).toBe("failed");
    expect(aborted).toBe(true); // failure notifies cooperative work via the signal
  });

  it("an unsupported validate schema fails the node, not silently passed (codex S2.0 P2)", async () => {
    const { ctx } = fakeBase();
    const node = actionNode("v", async (c) => {
      // Neither safeParse nor parse — an unusable schema object.
      c.validate({ a: 1 }, {} as never, "bad schema");
    });
    const res = await runNode(ctx, node, {}, { staticGrade: "opaque" });
    expect(res.status).toBe("failed");
  });
});

// --- runNode: dynamic skip is not a failure (codex S2.0 P2) ------------------

describe("runNode — ctx.skip() settles skipped, not failed", () => {
  it("a deliberate skip with no prior failure settles `skipped` and keeps prior state", async () => {
    const { ctx, rec } = fakeBase();
    const node = actionNode("maybe", async (c) => {
      c.skip("feature flag off");
      return { reached: true };
    });
    const res = await runNode(ctx, node, { keep: 1 }, { staticGrade: "opaque" });
    expect(res.status).toBe("skipped");
    expect(res.state).toEqual({ keep: 1 }); // skip never commits the body's return
    expect(res.error).toBeInstanceOf(GlubeanSkipError);
    expect(rec.events[1].data).toMatchObject({ status: "skipped" });
    expect(rec.events[1].data.error).toBeUndefined(); // a skip is not an error
  });

  it("a failed assertion BEFORE a skip still wins (failed, not skipped)", async () => {
    const { ctx } = fakeBase();
    const node = checkNode("guard", async (c) => {
      c.assert(false, "precondition");
      c.skip("bail after failure");
    });
    const res = await runNode(ctx, node, {}, { staticGrade: "opaque" });
    expect(res.status).toBe("failed"); // earlier failure beats the later skip
  });
});

// --- runNode: late-evidence quarantine (§17 #12) -----------------------------

describe("runNode — late evidence is quarantined", () => {
  it("evidence emitted after the body settles is dropped and cannot flip the verdict", async () => {
    const { ctx, rec } = fakeBase();
    const node = actionNode("leaky", async (c) => {
      // Schedule emissions that land AFTER this body resolves (the node settles).
      setTimeout(() => {
        c.trace(aTrace());
        c.assert(false, "late fail");
      }, 5);
      return undefined;
    });
    const res = await runNode(ctx, node, {}, { staticGrade: "opaque" });
    expect(res.status).toBe("passed");
    await delay(25); // let the late timer fire
    expect(res.status).toBe("passed"); // late failure did NOT flip it
    expect(rec.traces).toHaveLength(0); // late trace dropped
    expect(rec.asserts).toHaveLength(0); // late assertion dropped
  });
});

// --- runNode: terminal timeout + abort (§17 #4 / #12) ------------------------

describe("runNode — terminal timeout aborts the node", () => {
  it("times out, fails terminally, fires the abort signal, and quarantines post-timeout evidence", async () => {
    const { ctx, rec } = fakeBase();
    let aborted = false;
    const node = actionNode("slow", async (c) => {
      c.signal.addEventListener("abort", () => {
        aborted = true;
      });
      await delay(100);
      c.assert(true, "should be dropped"); // emitted after the timeout
      return { done: true };
    });

    const res = await runNode(ctx, node, { x: 0 }, { staticGrade: "opaque", timeoutMs: 20 });

    expect(res.status).toBe("failed");
    expect(res.error).toBeInstanceOf(NodeTimeoutError);
    expect(res.state).toEqual({ x: 0 }); // no commit (§17 #13)
    expect(aborted).toBe(true); // the per-node signal fired on timeout (§17 #12)
    expect(rec.events[1].data).toMatchObject({ status: "failed" });

    await delay(120); // let the slow body run to completion and try to emit
    expect(rec.asserts).toHaveLength(0); // post-timeout assertion quarantined
  });

  it("evidence emitted from an abort listener at timeout is also quarantined (codex S2.0 P2)", async () => {
    const { ctx, rec } = fakeBase();
    const node = actionNode("slow", async (c) => {
      c.signal.addEventListener("abort", () => {
        // Fires synchronously when the timeout aborts — must NOT leak.
        c.assert(false, "from abort listener");
        c.trace(aTrace());
      });
      await delay(100);
      return { done: true };
    });
    const res = await runNode(ctx, node, {}, { staticGrade: "opaque", timeoutMs: 20 });
    expect(res.status).toBe("failed");
    expect(res.error).toBeInstanceOf(NodeTimeoutError);
    expect(rec.asserts).toHaveLength(0); // abort-listener assertion quarantined
    expect(rec.traces).toHaveLength(0); // abort-listener trace quarantined
    expect(res.grade).toBe("opaque"); // not promoted by the would-be-leaked trace
  });
});

// --- runNode: grade promotion (§17 #10) --------------------------------------

describe("runNode — runtime grade promotion (opaque → trace)", () => {
  it("promotes opaque → trace when the node emits structured evidence (trace)", async () => {
    const { ctx } = fakeBase();
    const node = actionNode("a", async (c) => {
      c.trace(aTrace());
    });
    const res = await runNode(ctx, node, {}, { staticGrade: "opaque" });
    expect(res.grade).toBe("trace");
    expect(res.status).toBe("passed");
  });

  it("does NOT promote when the node emits only a plain log", async () => {
    const { ctx } = fakeBase();
    const node = actionNode("b", async (c) => {
      c.log("hi");
      c.warn(true, "should");
    });
    const res = await runNode(ctx, node, {}, { staticGrade: "opaque" });
    expect(res.grade).toBe("opaque");
  });

  it("never promotes full/partial (already ≥ trace)", async () => {
    const { ctx } = fakeBase();
    const node = actionNode("c", async (c) => {
      c.trace(aTrace());
    });
    const res = await runNode(ctx, node, {}, { staticGrade: "partial" });
    expect(res.grade).toBe("partial");
  });
});

// --- runNode: child-scope isolation ------------------------------------------

describe("runNode — per-node scope isolation", () => {
  it("a failed node does not poison a later node's verdict", async () => {
    const { ctx } = fakeBase();
    const r1 = await runNode(ctx, checkNode("c1", async (c) => c.assert(false, "fail1")), {}, {
      staticGrade: "opaque",
    });
    const r2 = await runNode(ctx, checkNode("c2", async (c) => c.assert(true, "ok2")), {}, {
      staticGrade: "opaque",
    });
    expect(r1.status).toBe("failed");
    expect(r2.status).toBe("passed"); // independent scope, not poisoned by r1
  });
});

// --- makeNodeScope: unit-level guards ----------------------------------------

describe("makeNodeScope — seal drops late evidence; flags track failure/structured", () => {
  it("forwards while live, then drops after seal()", () => {
    const { ctx, rec } = fakeBase();
    const ac = new AbortController();
    const scope = makeNodeScope(ctx, ac.signal);

    scope.ctx.assert(false, "live fail");
    scope.ctx.trace(aTrace());
    expect(scope.hasFailure()).toBe(true);
    expect(scope.emittedStructuredEvidence()).toBe(true);
    expect(rec.asserts).toHaveLength(1);
    expect(rec.traces).toHaveLength(1);

    scope.seal();
    scope.ctx.assert(false, "late fail");
    scope.ctx.trace(aTrace());
    scope.ctx.log("late log");
    expect(rec.asserts).toHaveLength(1); // unchanged
    expect(rec.traces).toHaveLength(1); // unchanged
    expect(rec.logs).toHaveLength(0); // dropped
  });

  it("promoteGrade only lifts opaque, and only with structured evidence", () => {
    const { ctx } = fakeBase();
    const ac = new AbortController();
    const bare = makeNodeScope(ctx, ac.signal);
    expect(promoteGrade("opaque", bare)).toBe("opaque");
    bare.ctx.metric("m", 1);
    expect(promoteGrade("opaque", bare)).toBe("trace");
    expect(promoteGrade("partial", bare)).toBe("partial");
    expect(promoteGrade("full", bare)).toBe("full");
  });
});

// --- Compile-time guard: teardown type debt (§17 #1) -------------------------
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _teardownTypeGuard(): void {
  // teardown must accept state: State | undefined AND a third `cause` arg.
  const _td: WorkflowTeardown<{ x: number }> = (_ctx, state, cause) => {
    const _state: { x: number } | undefined = state; // widened to | undefined
    const _cause: unknown = cause;
    void _state;
    void _cause;
  };
  // A no-arg / partial-arg teardown still satisfies the type (cause is optional).
  const _td2: WorkflowTeardown<number> = () => {};
  void _td;
  void _td2;
}
void _teardownTypeGuard;
