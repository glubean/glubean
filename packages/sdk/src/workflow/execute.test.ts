import { describe, it, expect, afterEach } from "vitest";
import type { TestContext, Trace } from "../types.js";
import { GlubeanSkipError } from "../types.js";
import { contract, __unregisterProtocolForTesting } from "../contract-core.js";
import type { ContractCaseRef } from "../contract-types.js";
import { workflow } from "./builder.js";
import {
  makeNodeScope,
  promoteGrade,
  runNode,
  runWorkflow,
  NodeTimeoutError,
  WorkflowPhaseFailedError,
  ComputeAsyncError,
  NODE_START_EVENT,
  NODE_END_EVENT,
} from "./execute.js";
import type { ActionNode, CheckNode, WorkflowTeardown } from "./types.js";

const fakeRef = <I = unknown, O = unknown>(
  contractId: string,
  caseKey: string,
  protocol: string,
  target: string,
): ContractCaseRef<I, O> =>
  ({
    __glubean_type: "contract-case-ref",
    contractId,
    caseKey,
    protocol,
    target,
    contract: {} as ContractCaseRef["contract"],
  }) as unknown as ContractCaseRef<I, O>;

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

// --- runWorkflow: lifecycle + state threading (§17 #1 / #5 / #13) ------------

describe("runWorkflow — lifecycle + state threading", () => {
  it("runs setup → nodes → teardown, threads state, all passed", async () => {
    const { ctx } = fakeBase();
    let teardownState: unknown;
    let teardownCause: unknown;
    const wf = workflow("happy")
      .setup(async () => ({ n: 1 }))
      .action("inc", async (_c, s: { n: number }) => ({ n: s.n + 1 }))
      .compute("double", (s: { n: number }) => ({ n: s.n * 2 }))
      .check("verify", async (c, s: { n: number }) => {
        c.expect(s.n).toBe(4, "n");
      })
      .teardown(async (_c, s, cause) => {
        teardownState = s;
        teardownCause = cause;
      })
      .build();

    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(res.state).toEqual({ n: 4 });
    expect(res.nodes.map((n) => n.status)).toEqual(["passed", "passed", "passed"]);
    expect(teardownState).toEqual({ n: 4 }); // teardown sees last committed state
    expect(teardownCause).toBeUndefined();
  });

  it("void/undefined node return preserves state across the graph (§17 #2)", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("preserve")
      .setup(async () => ({ keep: true }))
      .action("noop", async () => {
        /* void */
      })
      .compute("identity", (s) => s)
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(res.state).toEqual({ keep: true });
  });

  it("teardown ALWAYS runs even when setup throws (state undefined, cause set) (§17 #1)", async () => {
    const { ctx } = fakeBase();
    let td: { s: unknown; cause: unknown } | undefined;
    const boom = new Error("setup boom");
    const wf = workflow("setup-throws")
      .setup(async () => {
        throw boom;
      })
      .action("never", async (_c, s) => s)
      .teardown(async (_c, s, cause) => {
        td = { s, cause };
      })
      .build();

    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(res.error).toBe(boom);
    expect(td).toEqual({ s: undefined, cause: boom }); // §17 #1: state undefined + cause
    expect(res.nodes.map((n) => n.status)).toEqual(["skipped"]); // node never ran
  });

  it("a failed node fail-stops the graph; teardown sees the cause + last committed state", async () => {
    const { ctx } = fakeBase();
    let td: { s: unknown; cause: unknown } | undefined;
    const wf = workflow("fail-stop")
      .setup(async () => ({ step: 0 }))
      .action("ok", async () => ({ step: 1 }))
      .check("boom", async (c) => {
        c.fail("nope");
      })
      .action("after", async () => ({ step: 99 }))
      .teardown(async (_c, s, cause) => {
        td = { s, cause };
      })
      .build();

    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(res.nodes.map((n) => n.status)).toEqual(["passed", "failed", "skipped"]);
    expect(td!.s).toEqual({ step: 1 }); // last committed before the failed check
    expect((td!.cause as Error).message).toBe("nope");
  });

  it("a soft assertion failure in setup fails the run and skips the graph (codex S2.1 P2)", async () => {
    const { ctx } = fakeBase();
    let td: { s: unknown; cause: unknown } | undefined;
    const wf = workflow("setup-soft-fail")
      .setup(async (c) => {
        c.expect(1).toBe(2, "setup precondition"); // soft fail, does not throw
        return { x: 1 };
      })
      .action("never", async (_c, s) => s)
      .teardown(async (_c, s, cause) => {
        td = { s, cause };
      })
      .build();

    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed"); // soft setup failure still fails the run
    expect(res.nodes.map((n) => n.status)).toEqual(["skipped"]);
    expect(td!.cause).toBeInstanceOf(WorkflowPhaseFailedError);
    expect(td!.s).toBeUndefined(); // setup's return is not committed on failure
  });

  it("a soft-failed node still threads a non-empty cause to teardown (codex S2.1 P2)", async () => {
    const { ctx } = fakeBase();
    let cause: unknown = "unset";
    const wf = workflow("node-soft-fail")
      .setup(async () => ({ ok: true }))
      .check("verify", async (c) => {
        c.expect(1).toBe(2, "soft assertion"); // soft fail, does not throw
      })
      .teardown(async (_c, _s, c) => {
        cause = c;
      })
      .build();

    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(res.error).toBeInstanceOf(WorkflowPhaseFailedError); // synthesized, not undefined
    expect(cause).toBeInstanceOf(WorkflowPhaseFailedError);
  });

  it("a throwing teardown is logged and never masks the run result (§17 #1)", async () => {
    const { ctx, rec } = fakeBase();
    const wf = workflow("td-throws")
      .setup(async () => ({}))
      .check("boom", async (c) => {
        c.fail("primary");
      })
      .teardown(async () => {
        throw new Error("teardown boom");
      })
      .build();

    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect((res.error as Error).message).toBe("primary"); // teardown error did NOT mask
    expect(rec.logs.some((l) => l.includes("teardown failed"))).toBe(true);
  });

  it("meta.skip opts the workflow out entirely — no setup/nodes/teardown run (codex S2.1 R2)", async () => {
    const { ctx } = fakeBase();
    let ran = false;
    const wf = workflow("skipped-wf")
      .meta({ skip: "demo only" })
      .setup(async () => {
        ran = true;
        return {};
      })
      .action("a", async (_c, s) => {
        ran = true;
        return s;
      })
      .teardown(async () => {
        ran = true;
      })
      .build();

    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("skipped");
    expect(ran).toBe(false); // nothing executed
    expect(res.nodes.map((n) => n.status)).toEqual(["skipped"]);
  });

  it("a setup ctx.skip() skips the whole workflow, not fails it (codex S2.1 R3)", async () => {
    const { ctx } = fakeBase();
    let teardownRan = false;
    const wf = workflow("setup-skip")
      .setup(async (c) => {
        c.skip("env not configured");
        return { x: 1 };
      })
      .action("a", async (_c, s) => s)
      .teardown(async () => {
        teardownRan = true;
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("skipped"); // NOT failed
    expect(res.nodes.map((n) => n.status)).toEqual(["skipped"]);
    expect(teardownRan).toBe(true);
  });

  it("a setup soft-failure before a skip fails the run with a phase-failure cause (codex S2.1 R3/R5)", async () => {
    const { ctx } = fakeBase();
    let cause: unknown;
    const wf = workflow("setup-fail-then-skip")
      .setup(async (c) => {
        c.expect(1).toBe(2, "precondition"); // soft fail
        c.skip("then skip");
        return {};
      })
      .teardown(async (_c, _s, cz) => {
        cause = cz;
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed"); // a prior soft failure wins over the skip
    expect(res.error).toBeInstanceOf(WorkflowPhaseFailedError); // NOT the skip (codex R5)
    expect(cause).toBeInstanceOf(WorkflowPhaseFailedError);
  });

  it("duplicate node ids each still get a skipped outcome (codex S2.1 R3 P3)", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("dup-ids")
      .meta({ skip: "discoverable only" })
      .action({ id: "dup" }, async (_c, s) => s)
      .action({ id: "dup" }, async (_c, s) => s)
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.nodes).toHaveLength(2); // both reported despite the shared id
    expect(res.nodes.every((n) => n.status === "skipped")).toBe(true);
  });

  it("a node ctx.skip() skips the whole workflow (status skipped, not passed) (codex S2.1 R2)", async () => {
    const { ctx } = fakeBase();
    let teardownRan = false;
    const wf = workflow("node-skip")
      .setup(async () => ({ ok: true }))
      .action("precheck", async (c, s) => {
        c.skip("precondition unavailable");
        return s;
      })
      .action("after", async (_c, s) => s)
      .teardown(async () => {
        teardownRan = true;
      })
      .build();

    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("skipped"); // NOT passed — CI must see skipped
    expect(res.nodes.map((n) => n.status)).toEqual(["skipped", "skipped"]);
    expect(teardownRan).toBe(true); // teardown still runs on skip
  });

  it("aborts the setup lifecycle signal when setup throws (codex S2.1 R2)", async () => {
    const { ctx } = fakeBase();
    let aborted = false;
    const wf = workflow("setup-abort")
      .setup(async (c) => {
        c.signal.addEventListener("abort", () => {
          aborted = true;
        });
        throw new Error("setup boom");
      })
      .build();

    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(aborted).toBe(true); // signal-aware work in setup gets cancelled
  });

  it("compute returning a thenable fails the node — sync invariant (§17 #11) (codex S2.1 R4)", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("compute-thenable")
      .setup(async () => ({ n: 1 }))
      // a NON-async fn that still returns a Promise (builder can't catch this; cast).
      .compute("bad", ((s: { n: number }) => Promise.resolve({ n: s.n + 1 })) as never)
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(res.error).toBeInstanceOf(ComputeAsyncError);
  });

  it("a soft failure then a skip surfaces a phase-failure cause, not the skip (codex S2.1 R4 P3)", async () => {
    const { ctx } = fakeBase();
    let cause: unknown;
    const wf = workflow("fail-then-skip")
      .setup(async () => ({}))
      .check("c", async (c) => {
        c.expect(1).toBe(2, "soft fail");
        c.skip("then skip");
      })
      .teardown(async (_c, _s, cz) => {
        cause = cz;
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(res.error).toBeInstanceOf(WorkflowPhaseFailedError); // NOT the skip
    expect(cause).toBeInstanceOf(WorkflowPhaseFailedError);
  });

  it("node outcomes carry the runtime grade (compute=full, opaque+trace→trace, bare→opaque)", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("grades")
      .setup(async () => ({}))
      .compute("pure", (s) => s)
      .action("opaque-traced", async (c, s) => {
        c.trace(aTrace());
        return s;
      })
      .action("bare", async (_c, s) => s)
      .build();
    const res = await runWorkflow(wf, ctx);
    const byId = Object.fromEntries(res.nodes.map((n) => [n.id, n.grade]));
    expect(byId).toEqual({ pure: "full", "opaque-traced": "trace", bare: "opaque" });
  });
});

// --- runWorkflow: contract-call via the adapter registry (§17 #8 happy path) --

describe("runWorkflow — contract-call dispatch", () => {
  afterEach(() => {
    __unregisterProtocolForTesting("wf-fake");
    __unregisterProtocolForTesting("wf-needs");
  });

  it("validates call input against the case needs schema before the adapter (codex S2.1 R4)", async () => {
    contract.register("wf-needs", {
      project: () => ({ cases: {} }),
      executeCaseInFlow: async ({ resolvedInputs }: { resolvedInputs: unknown }) => ({
        got: resolvedInputs,
      }),
    } as never);
    // A schema that requires { x: number } and transforms to the same shape.
    const needsSchema = {
      safeParse: (v: unknown) =>
        v && typeof (v as { x?: unknown }).x === "number"
          ? { success: true, data: { x: (v as { x: number }).x } }
          : { success: false, error: { issues: [{ message: "x must be a number" }] } },
    };
    const ref = {
      __glubean_type: "contract-case-ref",
      contractId: "c",
      caseKey: "case",
      protocol: "wf-needs",
      target: "POST /x",
      contract: { _spec: { cases: { case: { needs: needsSchema } } } },
    } as unknown as ContractCaseRef<{ x: unknown }, { got: unknown }>;
    const { ctx } = fakeBase();

    // invalid input → the needs schema rejects it → the call node fails
    const bad = workflow("needs-bad").call("do", ref, { in: () => ({ x: "nope" }) }).build();
    expect((await runWorkflow(bad, ctx)).status).toBe("failed");

    // valid input → passes; the validated/transformed value reaches the adapter
    const good = workflow("needs-good")
      .setup(async () => ({}))
      .call("do", ref, { in: () => ({ x: 42 }), out: (s, r) => ({ ...s, got: r.got }) })
      .build();
    const resGood = await runWorkflow(good, ctx);
    expect(resGood.status).toBe("passed");
    expect(resGood.state).toMatchObject({ got: { x: 42 } });
  });

  it("dispatches .call through the registered adapter; in maps input, out folds response", async () => {
    contract.register("wf-fake", {
      project: () => ({ cases: {} }),
      executeCaseInFlow: async ({ resolvedInputs }: { resolvedInputs: unknown }) => ({
        echo: resolvedInputs,
      }),
    } as never);

    const { ctx } = fakeBase();
    const ref = fakeRef<{ x: number }, { echo: { x: number } }>(
      "c",
      "case",
      "wf-fake",
      "POST /x",
    );
    const wf = workflow("call-wf")
      .setup(async () => ({ x: 7 }))
      .call("do", ref, {
        in: (s: { x: number }) => ({ x: s.x }),
        out: (s, res) => ({ ...s, echoed: res.echo.x }),
      })
      .build();

    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(res.state).toEqual({ x: 7, echoed: 7 });
    expect(res.nodes[0]).toMatchObject({ id: "do", status: "passed", grade: "full" });
  });

  it("fails the call node when its `in` lens returns a thenable (codex S2.1 R7)", async () => {
    contract.register("wf-fake", {
      project: () => ({ cases: {} }),
      executeCaseInFlow: async ({ resolvedInputs }: { resolvedInputs: unknown }) => ({
        got: resolvedInputs,
      }),
    } as never);
    const { ctx } = fakeBase();
    const ref = fakeRef<{ x: number }, { got: unknown }>("c", "case", "wf-fake", "POST /x");
    const wf = workflow("async-in")
      .setup(async () => ({}))
      .call("do", ref, { in: (() => Promise.resolve({ x: 1 })) as never })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed"); // in must be a pure synchronous lens
  });

  it("does NOT run `out` after the adapter records a soft failure (codex S2.1 R7)", async () => {
    // adapter soft-fails via the scoped ctx, then returns a (failing-shape) response.
    contract.register("wf-fake", {
      project: () => ({ cases: {} }),
      executeCaseInFlow: async ({ ctx: c }: { ctx: { expect: (a: unknown) => { toBe: (b: unknown, m?: string) => void } } }) => {
        c.expect(500).toBe(200, "status"); // soft failure recorded on the node scope
        return { body: null }; // a shape `out` would choke on
      },
    } as never);
    const { ctx } = fakeBase();
    const ref = fakeRef<void, { body: { id: string } }>("c", "case", "wf-fake", "POST /x");
    let outRan = false;
    const wf = workflow("soft-fail-no-out")
      .setup(async () => ({}))
      .call("do", ref, {
        out: (s, res) => {
          outRan = true;
          return { ...s, id: res.body.id }; // would throw on null body if reached
        },
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(outRan).toBe(false); // stopped before `out` (no TypeError masking the cause)
    expect(res.error).toBeInstanceOf(WorkflowPhaseFailedError); // synthesized validation failure
  });

  it("fails the call node when its `out` lens returns a thenable (codex S2.1 R6)", async () => {
    contract.register("wf-fake", {
      project: () => ({ cases: {} }),
      executeCaseInFlow: async () => ({ ok: true }),
    } as never);
    const { ctx } = fakeBase();
    const ref = fakeRef<void, { ok: boolean }>("c", "case", "wf-fake", "POST /x");
    const wf = workflow("async-out")
      .setup(async () => ({}))
      // a non-async out that returns a Promise (cast past the pure-lens type).
      .call("do", ref, { out: ((s: object) => Promise.resolve({ ...s, x: 1 })) as never })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed"); // out must be a pure synchronous lens
  });

  it("fails the call node when the protocol has no registered adapter (§17 #8 runtime half)", async () => {
    const { ctx } = fakeBase();
    const ref = fakeRef<void>("c", "case", "nonexistent-proto", "POST /x");
    const wf = workflow("no-adapter").call("do", ref).build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(res.nodes[0].status).toBe("failed");
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
