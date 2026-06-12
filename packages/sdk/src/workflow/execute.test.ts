import { describe, it, expect, afterEach } from "vitest";
import type { TestContext, Trace } from "../types.js";
import { GlubeanSkipError } from "../types.js";
import { contract, __unregisterProtocolForTesting } from "../contract-core.js";
import { getRegistry as getRegistryForEach } from "../internal.js";
import type { ContractCaseRef } from "../contract-types.js";
import { workflow } from "./builder.js";
import type { WorkflowBuilder } from "./builder.js";
import { projectWorkflow } from "./project.js";
import { PollExhaustedError } from "../contract-flow-poll.js";
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
  POLL_ATTEMPT_EVENT,
} from "./execute.js";
import type { ActionNode, CheckNode, WorkflowNode, WorkflowTeardown } from "./types.js";

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

  it("duplicate node ids are rejected at BUILD time (S2.13 — supersedes the S2.1 runtime tolerance)", () => {
    // S2.1 R3 made the executor tolerate duplicates defensively; S2.13 makes
    // them unreachable: ids address evidence and must be unique.
    expect(() =>
      workflow("dup-ids")
        .meta({ skip: "discoverable only" })
        .action({ id: "dup" }, async (_c, s) => s)
        .action({ id: "dup" }, async (_c, s) => s)
        .build(),
    ).toThrow(/duplicate node id "dup"/);
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

  it("in-place mutation of live state is NOT rolled back on failure (§17 #14)", async () => {
    const { ctx } = fakeBase();
    let teardownState: unknown;
    const wf = workflow("mutate-no-rollback")
      .setup(async () => ({ obj: { v: 1 } }))
      .check("mutate-then-fail", async (c, s: { obj: { v: number } }) => {
        s.obj.v = 999; // in-place write on the LIVE committed state object
        c.fail("boom"); // node fails — but the mutation already took effect
      })
      .teardown(async (_c, s) => {
        teardownState = s;
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    // executor does NOT clone — the in-place write is immediate + not rolled back.
    // (commit-on-success governs the RETURN value, not in-place writes.)
    expect(teardownState).toEqual({ obj: { v: 999 } });
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
    __unregisterProtocolForTesting("wf-veto");
  });

  it("honors a third-party adapter's validateCaseForFlow veto (§17 #8)", async () => {
    contract.register("wf-veto", {
      project: () => ({ cases: {} }),
      executeCaseInFlow: async () => ({ ok: true }),
      validateCaseForFlow: () => {
        throw new Error("this case cannot run in a workflow");
      },
    } as never);
    const { ctx } = fakeBase();
    const ref = fakeRef<void>("c", "case", "wf-veto", "POST /x");
    const wf = workflow("veto").call("do", ref).build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed"); // adapter veto fails the call node fast
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

// --- runWorkflow: 2-way branch (§17 #6 only-taken, first-match) --------------

describe("runWorkflow — branch (§17 #6)", () => {
  it("declarative branch runs ONLY the taken (then) side; else is skipped", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("br-then")
      .setup(async () => ({ flag: true, path: "none" }))
      .branch("route", {
        when: (w) => w.when((s: { flag: boolean }) => s.flag).eq(true),
        then: (b) => b.action("a-then", async (_c, s) => ({ ...s, path: "then" })),
        else: (b) => b.action("a-else", async (_c, s) => ({ ...s, path: "else" })),
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect((res.state as { path: string }).path).toBe("then");
    expect(Object.fromEntries(res.nodes.map((n) => [n.id, n.status]))).toEqual({
      route: "passed",
      "a-then": "passed",
      "a-else": "skipped",
    });
  });

  it("declarative branch takes the else side when the predicate is false", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("br-else")
      .setup(async () => ({ flag: false, path: "none" }))
      .branch("route", {
        when: (w) => w.when((s: { flag: boolean }) => s.flag).eq(true),
        then: (b) => b.action("a-then", async (_c, s) => ({ ...s, path: "then" })),
        else: (b) => b.action("a-else", async (_c, s) => ({ ...s, path: "else" })),
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect((res.state as { path: string }).path).toBe("else");
    expect(Object.fromEntries(res.nodes.map((n) => [n.id, n.status]))).toMatchObject({
      "a-then": "skipped",
      "a-else": "passed",
    });
  });

  it("runtime branch (whenRuntime) runs the taken side; threads state out of it", async () => {
    const { ctx } = fakeBase();
    // strict-S (addendum §9 #1/#3): the trunk PRE-DECLARES the slot a side
    // fills — a side inventing `taken` out of thin air no longer compiles.
    const wf = workflow("br-rt")
      .setup(async () => ({ n: 5, taken: false }))
      .branch("gate", {
        whenRuntime: async (_c, s: { n: number }) => s.n > 3,
        message: "n over threshold",
        then: (b) => b.compute("mark", (s) => ({ ...s, taken: true as boolean })),
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect((res.state as { taken?: boolean }).taken).toBe(true);
  });

  it("a failure inside the taken branch fail-stops the workflow", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("br-fail")
      .setup(async () => ({ flag: true }))
      .branch("route", {
        when: (w) => w.when((s: { flag: boolean }) => s.flag).eq(true),
        then: (b) => b.check("inner", async (c) => c.fail("boom")),
      })
      .action("after", async (_c, s) => s)
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(Object.fromEntries(res.nodes.map((n) => [n.id, n.status]))).toMatchObject({
      route: "failed",
      inner: "failed",
      after: "skipped",
    });
  });

  it("a branch whose predicate throws fails the branch; both sides skipped", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("br-throw")
      .setup(async () => ({}))
      .branch("bad", {
        whenRuntime: async () => {
          throw new Error("pred boom");
        },
        message: "m",
        then: (b) => b.action("t", async (_c, s) => s),
        else: (b) => b.action("e", async (_c, s) => s),
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(Object.fromEntries(res.nodes.map((n) => [n.id, n.status]))).toMatchObject({
      bad: "failed",
      t: "skipped",
      e: "skipped",
    });
  });

  it("branch grade: declarative → full, runtime → opaque (via projectWorkflow)", () => {
    const declWf = workflow("g1")
      .setup(async () => ({ x: 1 }))
      .branch("b", {
        when: (w) => w.when((s: { x: number }) => s.x).eq(1),
        then: (b) => b.compute("c", (s) => s),
      })
      .build();
    expect(projectWorkflow(declWf).nodes.find((n) => n.id === "b")!.grade).toBe("full");

    const rtWf = workflow("g2")
      .setup(async () => ({ x: 1 }))
      .branch("b", {
        whenRuntime: async () => true,
        message: "m",
        then: (b) => b.compute("c", (s) => s),
      })
      .build();
    expect(projectWorkflow(rtWf).nodes.find((n) => n.id === "b")!.grade).toBe("opaque");
  });

  it("whenRuntime is projected as opaque L0 even for a non-async fn returning a Promise (codex S2.4a P2)", () => {
    const wf = workflow("rt-l0")
      .setup(async () => ({ x: 1 }))
      .branch("b", {
        // a NON-async fn that returns a Promise — must still project as may-do-async-IO.
        whenRuntime: ((_c: unknown, _s: unknown) => Promise.resolve(true)) as never,
        message: "m",
        then: (b) => b.compute("c", (s) => s),
      })
      .build();
    // branch lowers to the family IR: the predicate lives on cases[0].when
    const projected = projectWorkflow(wf).nodes.find((n) => n.id === "b")!;
    expect(projected.mode).toBe("predicate");
    const when = projected.cases![0].when as {
      kind: string;
      strictness?: string;
      mayDoAsyncIO?: boolean;
    };
    expect(when.kind).toBe("opaque");
    expect(when.strictness).toBe("L0");
    expect(when.mayDoAsyncIO).toBe(true);
  });

  it("a non-boolean whenRuntime result fails the branch (no silent coercion) (codex S2.4a P2)", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("rt-nonbool")
      .setup(async () => ({}))
      .branch("b", {
        whenRuntime: (async () => "false") as never, // truthy string would wrongly pick `then`
        message: "m",
        then: (b) => b.action("t", async (_c, s) => s),
        else: (b) => b.action("e", async (_c, s) => s),
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(res.nodes.find((n) => n.id === "b")!.status).toBe("failed");
  });

  it("an opaque predicate emitting structured evidence promotes the branch grade opaque→trace (codex S2.4a P2)", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("rt-trace")
      .setup(async () => ({}))
      .branch("b", {
        whenRuntime: async (c) => {
          c.trace(aTrace()); // structured evidence on the branch's scoped ctx
          return true;
        },
        message: "m",
        then: (b) => b.compute("c", (s) => s),
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(res.nodes.find((n) => n.id === "b")!.grade).toBe("trace"); // promoted
  });

  it("emits branch children in authored (then-before-else) order regardless of which is taken (codex S2.4a P2)", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("order")
      .setup(async () => ({ flag: true }))
      .branch("route", {
        when: (w) => w.when((s: { flag: boolean }) => s.flag).eq(true),
        then: (b) => b.action("then-node", async (_c, s) => s),
        else: (b) => b.action("else-node", async (_c, s) => s),
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    // even with `then` taken, the authored order is route, then-node, else-node.
    expect(res.nodes.map((n) => n.id)).toEqual(["route", "then-node", "else-node"]);
    expect(res.nodes.map((n) => n.status)).toEqual(["passed", "passed", "skipped"]);
  });

  it("a declarative branch with an opaque child stays full (decision projectable); child counted separately (codex S2.4a R4)", () => {
    const wf = workflow("indep")
      .setup(async () => ({ x: 1 }))
      .branch("b", {
        when: (w) => w.when((s: { x: number }) => s.x).eq(1), // declarative → full decision
        then: (b) => b.action("a", async (_c, s) => s), // opaque child
      })
      .build();
    const proj = projectWorkflow(wf);
    expect(proj.nodes.find((n) => n.id === "b")!.grade).toBe("full"); // decision projectable
    expect(proj.gradeSummary).toEqual({ full: 1, partial: 0, opaque: 1 }); // branch full + child opaque
  });

  it("gradeSummary counts the branch node plus its then/else children (codex S2.4a R3)", () => {
    const wf = workflow("sum")
      .setup(async () => ({ x: 1 }))
      .branch("b", {
        when: (w) => w.when((s: { x: number }) => s.x).eq(1), // L2 → full predicate
        then: (b) => b.compute("c1", (s) => s).compute("c2", (s) => s), // 2 full children
      })
      .build();
    // branch (full) + c1 (full) + c2 (full) = 3 full, none dropped.
    expect(projectWorkflow(wf).gradeSummary).toEqual({ full: 3, partial: 0, opaque: 0 });
  });

  it("a branch predicate ctx.skip() skips the whole workflow, not fails it (codex S2.4a R5)", async () => {
    const { ctx } = fakeBase();
    let teardownRan = false;
    const wf = workflow("br-skip")
      .setup(async () => ({}))
      .branch("gate", {
        whenRuntime: async (c) => {
          c.skip("precondition unavailable");
          return true;
        },
        message: "m",
        then: (b) => b.action("t", async (_c, s) => s),
        else: (b) => b.action("e", async (_c, s) => s),
      })
      .teardown(async () => {
        teardownRan = true;
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("skipped"); // NOT failed
    expect(res.nodes.find((n) => n.id === "gate")!.status).toBe("skipped");
    expect(res.nodes.filter((n) => n.id === "t" || n.id === "e").map((n) => n.status)).toEqual([
      "skipped",
      "skipped",
    ]);
    expect(teardownRan).toBe(true);
  });

  it("a branch predicate soft-failure then skip surfaces a phase-failure cause, not the skip (codex S2.4a R6)", async () => {
    const { ctx } = fakeBase();
    let cause: unknown;
    const wf = workflow("br-fail-skip")
      .setup(async () => ({}))
      .branch("gate", {
        whenRuntime: async (c) => {
          c.expect(1).toBe(2, "soft fail");
          c.skip("then skip");
          return true;
        },
        message: "m",
        then: (b) => b.action("t", async (_c, s) => s),
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

  it("an async then/else callback is rejected at build time (codex S2.4a R5)", () => {
    expect(() =>
      workflow("w")
        .setup(async () => ({ x: 1 }))
        .branch("b", {
          when: (w) => w.when((s: { x: number }) => s.x).eq(1),
          // async callback would drop steps added after the await.
          then: (async (b: unknown) => b) as never,
        }),
    ).toThrow(/must be synchronous/);
  });

  it("anonymous nodes in then/else get unique prefixed fallback ids (codex S2.4a R7)", () => {
    const wf = workflow("uniq")
      .setup(async () => ({ x: 1 }))
      .branch("route", {
        when: (w) => w.when((s: { x: number }) => s.x).eq(1),
        then: (b) => b.compute({}, (s) => s), // anonymous → fallback id
        else: (b) => b.compute({}, (s) => s), // anonymous → fallback id (must differ)
      })
      .build();
    const proj = projectWorkflow(wf);
    const branchNode = proj.nodes.find((n) => n.id === "route")!;
    const thenId = branchNode.cases![0].nodes[0].id; // then = cases[0] in the family IR
    const elseId = branchNode.default![0].id; // else = default
    expect(thenId).toBe("route.then.node-0");
    expect(elseId).toBe("route.else.node-0");
    expect(thenId).not.toBe(elseId);
  });

  it("whenRuntime without a message throws at build time", () => {
    expect(() =>
      workflow("w").branch("b", {
        whenRuntime: async () => true,
        then: (b: unknown) => b,
      } as never),
    ).toThrow(/requires a non-empty `message`/);
  });
});

// --- workflow.extend(): fixtures via the ONE fixture system (S2.15, phase4 §3) -

describe("workflow.extend — fixtures (phase4 §3)", () => {
  it("the fixture map rides Test.fixtures; bodies see the augmented Ctx type", async () => {
    const wf = workflow.extend({
      inbox: () => ({ take: () => "msg-1" }),
    });
    const built = wf("wfx-basic")
      .setup(async (ctx) => ({ got: ctx.inbox.take() })) // typed: ctx.inbox
      .check("verify", async (ctx, s) => {
        ctx.assert(s.got === "msg-1" || typeof s.got === "string", "fixture value flowed");
      })
      .build();
    // the runnable half carries the fixtures for the HOST's resolver
    const test = built[0] as { fixtures?: Record<string, unknown> };
    expect(typeof test.fixtures?.inbox).toBe("function");
    // registry/projection untouched by fixtures (capability plumbing, not graph)
    expect(built._projection.nodes.map((n) => n.id)).toEqual(["verify"]);
  });

  it("chained extend composes maps; later keys win", () => {
    const base = workflow.extend({ a: () => 1 });
    const both = base.extend({ b: () => 2 });
    const built = both("wfx-chain")
      .setup(async (ctx) => ({ sum: (ctx.a as number) + (ctx.b as number) }))
      .compute("noop", (s) => s)
      .build();
    const test = built[0] as { fixtures?: Record<string, unknown> };
    expect(Object.keys(test.fixtures ?? {}).sort()).toEqual(["a", "b"]);
  });

  it("reserved keys are rejected — test set + every node-scope ctx member (codex R2)", () => {
    expect(() => workflow.extend({ signal: () => "x" } as never)).toThrow(
      /reserved key "signal"/,
    );
    expect(() => workflow.extend({ vars: () => "x" } as never)).toThrow(/reserved key "vars"/);
    // node-scope wrappers would shadow the fixture AND delegate to the
    // fixture VALUE as if it were the real API
    expect(() => workflow.extend({ log: () => "x" } as never)).toThrow(/reserved key "log"/);
    expect(() => workflow.extend({ assert: () => "x" } as never)).toThrow(
      /reserved key "assert"/,
    );
    expect(() => workflow.extend({ event: () => "x" } as never)).toThrow(/reserved key "event"/);
    // inherited TestContext members shadow through the prototype chain too
    expect(() => workflow.extend({ session: () => "x" } as never)).toThrow(
      /reserved key "session"/,
    );
    expect(() => workflow.extend({ setTimeout: () => "x" } as never)).toThrow(
      /reserved key "setTimeout"/,
    );
  });

  it("extended each: every member carries the fixtures", () => {
    const wf = workflow.extend({ auth: () => "token" });
    const members = wf.each([{ region: "us" }, { region: "eu" }])(
      { id: "wfx-$region" },
      (b, row) => b.setup(async (ctx) => ({ t: ctx.auth, r: row.region })),
    );
    expect(members).toHaveLength(2);
    for (const m of members) {
      expect(typeof (m[0] as { fixtures?: Record<string, unknown> }).fixtures?.auth).toBe(
        "function",
      );
    }
  });

  it("untilRuntime sees the extended Ctx; public each takes exactly two args (codex R1)", async () => {
    const wf = workflow.extend({ inbox: () => ({ ready: () => true }) });
    // type-level: untilRuntime ctx carries the fixture
    const built = wf("wfx-until")
      .setup(async () => ({}))
      .pollAction("probe", async (ctx) => (ctx.inbox.ready() ? "ok" : null), {
        untilRuntime: (ctx, res) => ctx.inbox.ready() && res === "ok",
        message: "inbox ready",
        every: 1,
        maxAttempts: 3,
        perAttemptTimeout: 100,
      })
      .build();
    expect((built[0] as { fixtures?: Record<string, unknown> }).fixtures).toBeDefined();
    // public each surface: two parameters only — no fixtures back door
    const run = workflow.each([{ v: 1 }]);
    expect(run.length).toBe(2);
  });

  it("plain workflow() stays fixture-free", () => {
    const built = workflow("wfx-plain")
      .setup(async () => ({}))
      .compute("c", (s) => s)
      .build();
    expect((built[0] as { fixtures?: unknown }).fixtures).toBeUndefined();
  });
});

// --- .group(): display-only bracket (S2.14, phase4 §2) -------------------------

describe("workflow.group — display-only bracket (phase4 §2)", () => {
  it("members run exactly as without the wrapper; bracket reports aggregate + worst grade", async () => {
    const { ctx, rec } = fakeBase();
    const wf = workflow("g-basic")
      .setup(async () => ({ n: 1 }))
      .group("payment", (b) =>
        b
          .compute("bump", (s) => ({ ...s, n: s.n + 1 }))
          .action("seed", async (_c, s) => s) // opaque — worst member
          .check("verify", async (c, s) => c.assert(s.n === 2, "bumped")),
      )
      .check("after", async (c, s) => c.assert(s.n === 2, "state flowed out"))
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(res.state).toEqual({ n: 2 });
    // outcomes: members first (anonymous ids under the group prefix keep
    // their explicit ids), bracket last with worst grade
    const ids = res.nodes.map((n) => n.id);
    expect(ids).toEqual(["bump", "seed", "verify", "payment", "after"]);
    const bracket = res.nodes.find((n) => n.id === "payment")!;
    expect(bracket.status).toBe("passed");
    expect(bracket.grade).toBe("opaque"); // worst member (seed, no hints)
    // bracket emits first-class node events with kind:"group"
    const groupEnds = rec.events.filter(
      (e) => e.type === "workflow:node_end" && (e.data as { kind?: string }).kind === "group",
    );
    expect(groupEnds).toHaveLength(1);
  });

  it("fail-stop inside the group: remaining members + trunk rest skipped; bracket failed", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("g-fail")
      .setup(async () => ({}))
      .group("pay", (b) =>
        b
          .check("boom", async (c) => c.assert(false, "no"))
          .compute("never", (s) => s),
      )
      .check("after", async () => {})
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    const byId = Object.fromEntries(res.nodes.map((n) => [n.id, n.status]));
    expect(byId).toEqual({
      boom: "failed",
      never: "skipped",
      pay: "failed",
      after: "skipped",
    });
  });

  it("a member ctx.skip() surfaces the bracket as SKIPPED, not passed (design-R2)", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("g-skip")
      .setup(async () => ({}))
      .group("opt", (b) =>
        b.action("gate", async (c, s) => {
          c.skip("feature off");
          return s;
        }),
      )
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("skipped");
    expect(res.skipReason).toBe("feature off");
    expect(res.nodes.find((n) => n.id === "opt")!.status).toBe("skipped");
  });

  it("a group SKIPPED by an earlier failure reports each member recursively (design-R1/R2)", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("g-skipped-whole")
      .setup(async () => ({}))
      .check("first", async (c) => c.assert(false, "fail early"))
      .group("later", (b) => b.compute("a", (s) => s).compute("c2", (s) => s))
      .build();
    const res = await runWorkflow(wf, ctx);
    const byId = Object.fromEntries(res.nodes.map((n) => [n.id, n.status]));
    expect(byId).toEqual({
      first: "failed",
      later: "skipped",
      a: "skipped", // members reported, not swallowed by the container
      c2: "skipped",
    });
  });

  it("nesting: prefixes accumulate; type flows through (In → Out)", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("g-nest")
      .setup(async () => ({ n: 0 }))
      .group("outer", (b) =>
        b
          .group("inner", (bb) => bb.compute("bump", (s) => ({ n: s.n + 1 })))
          .compute("double", (s) => ({ n: s.n * 2, label: "x" })),
      )
      .check("end", async (c, s) => {
        c.assert(s.n === 2 && s.label === "x", "typed state flowed");
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
  });

  it("build-time rejections: timeout on the group; setup/teardown in the body; dup ids across groups", () => {
    expect(() =>
      workflow("g-t")
        .setup(async () => ({}))
        .group({ id: "g", timeout: 50 }, (b) => b.compute("c", (s) => s)),
    ).toThrow(/display-only bracket/);
    expect(() =>
      workflow("g-s")
        .setup(async () => ({}))
        .group("g", ((b: { setup: (f: unknown) => unknown }) => b.setup(async () => ({}))) as never),
    ).toThrow(/cannot declare setup/);
    expect(() =>
      workflow("g-dup")
        .setup(async () => ({}))
        .compute("x", (s) => s)
        .group("g", (b) => b.compute("x", (s) => s))
        .build(),
    ).toThrow(/duplicate node id "x"/);
  });

  it("runtime bracket grade matches the STATIC scope — direct members only (codex R1)", async () => {
    const { ctx } = fakeBase();
    // a branch whose taken side is empty-ish but whose OTHER side holds an
    // opaque action: static group grade = full (decision is declarative);
    // runtime must not downgrade below that floor via skipped descendants.
    const wf = workflow("g-grade-scope")
      .setup(async () => ({ ok: true }))
      .group("seg", (b) =>
        b.branch("route", {
          when: (w) => w.when((s: { ok: boolean }) => s.ok).eq(true),
          then: (x) => x.compute("c", (s) => s),
          else: (x) => x.action("opaque-side", async (_c, s) => s),
        }),
      )
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    const bracket = res.nodes.find((n) => n.id === "seg")!;
    expect(bracket.grade).toBe("full"); // NOT opaque from the skipped else-side
  });

  it("a group body returning ANOTHER builder's chain is rejected — no empty bracket (codex R2)", () => {
    const other = workflow("g-other").setup(async () => ({}));
    expect(() =>
      workflow("g-foreign")
        .setup(async () => ({}))
        .group("g", (() => other.compute("stray", (s) => s)) as never),
    ).toThrow(/must return the chain built from the builder it was given/);
    // …and the same rule protects branch sides
    expect(() =>
      workflow("g-foreign-branch")
        .setup(async () => ({ ok: true }))
        .branch("route", {
          when: (w) => w.when((s: { ok: boolean }) => s.ok).eq(true),
          then: (() => other.compute("stray2", (s) => s)) as never,
        }),
    ).toThrow(/must return the chain built from the builder it was given/);
  });

  it("group projects with children and worst-of static grade", () => {
    const wf = workflow("g-proj")
      .setup(async () => ({}))
      .group("pay", (b) =>
        b.compute("c", (s) => s).action("a", async (_c, s) => s),
      )
      .build();
    const g = projectWorkflow(wf).nodes[0];
    expect(g.kind).toBe("group");
    expect(g.grade).toBe("opaque"); // worst child
    expect(g.nodes?.map((n) => n.id)).toEqual(["c", "a"]);
  });
});

// --- .use() fragments + duplicate-node-id validation (S2.13, phase4 §1) -------

describe("workflow.use — fragments (phase4 §1)", () => {
  const withBump = <S extends { n: number }>(b: WorkflowBuilder<S>) =>
    b.compute("bump", (s) => ({ ...s, n: s.n + 1 }));

  it("applies the fragment in-chain: nodes land on the trunk, state type flows", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("use-basic")
      .setup(async () => ({ n: 1 }))
      .use(withBump)
      .check("verify", async (c, s) => c.assert(s.n === 2, "bumped"))
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(res.nodes.map((n) => n.id)).toEqual(["bump", "verify"]);
  });

  it("a fragment returning a DIFFERENT builder's chain throws (identity check)", () => {
    const other = workflow("use-other").setup(async () => ({ n: 0 }));
    expect(() =>
      workflow("use-redirect")
        .setup(async () => ({ n: 1 }))
        .use((() => other.compute("stray", (s) => s)) as never),
    ).toThrow(/must return the chain built from the builder it was given/);
    // ...and the poisoned trunk refuses to build (half-authored)
  });

  it("a fragment may start with NON-node chain calls (meta) — the chain stays guarded (codex R4)", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("use-meta")
      .setup(async () => ({ n: 1 }))
      .use((b) => b.meta({ description: "from fragment" }).compute("bump", (s) => ({ n: s.n + 1 })))
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(wf.meta.description).toBe("from fragment");
    // …and a meta-only (no-node) fragment is a valid identity-with-metadata
    expect(() =>
      workflow("use-meta-only")
        .setup(async () => ({}))
        .use((b) => b.meta({ description: "annotated" })),
    ).not.toThrow();
  });

  it("a fragment cannot declare setup/teardown — lifecycle belongs to the author (codex R5)", () => {
    expect(() =>
      workflow("use-setup")
        .setup(async () => ({ n: 1 }))
        .use(((b: { setup: (f: unknown) => unknown }) => b.setup(async () => ({ hijacked: true }))) as never),
    ).toThrow(/fragment cannot declare setup/);
    expect(() =>
      workflow("use-teardown")
        .setup(async () => ({}))
        .use(((b: { teardown: (f: unknown) => unknown }) => b.teardown(async () => {})) as never),
    ).toThrow(/fragment cannot declare teardown/);
  });

  it("a fragment chaining off a STALE handle throws (tip-guard on the trunk, codex R3)", () => {
    expect(() =>
      workflow("use-stale")
        .setup(async () => ({ n: 1 }))
        .use(((b: WorkflowBuilder<{ n: number }>) => {
          const next = b.compute("drop", () => ({})); // reshapes away n
          (b as unknown as { check: (id: string, f: unknown) => unknown }).check("late", async () => {});
          return next;
        }) as never),
    ).toThrow(/forked its chain/);
  });

  it("NESTED fragments keep the build() guard armed (depth counter, codex R3)", () => {
    const inner = <S,>(b: WorkflowBuilder<S>) => b.compute("inner", (s) => s);
    expect(() =>
      workflow("use-nested-build")
        .setup(async () => ({}))
        .use(((b: WorkflowBuilder<object>) => {
          const afterInner = b.use(inner) as unknown as { build: () => unknown };
          afterInner.build(); // inner use() returned — a boolean flag would have disarmed here
          return afterInner;
        }) as never),
    ).toThrow(/build\(\) cannot be called inside a \.use\(\) fragment/);
    expect(getRegistryForEach().some((r) => r.id === "use-nested-build")).toBe(false);
  });

  it("plain nested fragments compose fine", async () => {
    const inner = <S extends { n: number }>(b: WorkflowBuilder<S>) =>
      b.compute("inner-bump", (s) => ({ ...s, n: s.n + 1 }));
    const outer = <S extends { n: number }>(b: WorkflowBuilder<S>) =>
      b.use(inner).compute("outer-bump", (s) => ({ ...s, n: s.n + 1 }));
    const { ctx } = fakeBase();
    const wf = workflow("use-nested")
      .setup(async () => ({ n: 0 }))
      .use(outer)
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(res.state).toEqual({ n: 2 });
  });

  it("a fragment calling b.build() is rejected — no premature registration (codex R2)", () => {
    expect(() =>
      workflow("use-build")
        .setup(async () => ({}))
        .use(((b: { build: () => unknown }) => b.build()) as never),
    ).toThrow(/build\(\) cannot be called inside a \.use\(\) fragment/);
    expect(getRegistryForEach().some((r) => r.id === "use-build")).toBe(false);
  });

  it("an async fragment is rejected", () => {
    expect(() =>
      workflow("use-async")
        .setup(async () => ({}))
        .use((async (b: unknown) => b) as never),
    ).toThrow(/must be synchronous/);
  });

  it("build() rejects duplicate node ids — incl. a fragment used twice", () => {
    expect(() =>
      workflow("use-dup")
        .setup(async () => ({ n: 1 }))
        .use(withBump)
        .use(withBump)
        .build(),
    ).toThrow(/duplicate node id "bump"/);
    // parameterized fragments are the documented answer
    const makeBump = (prefix: string) => <S extends { n: number }>(b: WorkflowBuilder<S>) =>
      b.compute(`${prefix}.bump`, (s) => ({ ...s, n: s.n + 1 }));
    expect(() =>
      workflow("use-param")
        .setup(async () => ({ n: 1 }))
        .use(makeBump("a"))
        .use(makeBump("b"))
        .build(),
    ).not.toThrow();
  });

  it("duplicate ids inside branch cases are caught too", () => {
    expect(() =>
      workflow("dup-nested")
        .setup(async () => ({ ok: true }))
        .check("probe", async () => {})
        .branch("route", {
          when: (w) => w.when((s: { ok: boolean }) => s.ok).eq(true),
          then: (b) => b.check("probe", async () => {}), // collides with trunk "probe"
        })
        .build(),
    ).toThrow(/duplicate node id "probe"/);
  });
});

// --- workflow.each / .pick: data-driven matrices (addendum §3) ----------------

describe("workflow.each (addendum §3)", () => {
  const regions = [
    { region: "us", currency: "USD" },
    { region: "eu", currency: "EUR" },
    { region: "jp", currency: "JPY" },
  ];

  it("builds one member per row: templated ids, auto tags, shared structure, row via setup", async () => {
    const members = workflow.each(regions)(
      { id: "checkout-$region", tagFields: ["region"], tags: ["journey"] },
      (wf, row) =>
        wf
          .setup(async () => ({ currency: row.currency }))
          .compute("derive", (s) => ({ ...s, label: s.currency.toLowerCase() })),
    );
    expect(members.map((m) => m.meta.id)).toEqual(["checkout-us", "checkout-eu", "checkout-jp"]);
    expect(members[1].meta.tags).toEqual(["journey", "region:eu"]);
    // every member shares ONE projected structure; ids/template stamped
    expect(members[0]._projection.templateId).toBe("checkout-$region");
    const shapes = members.map((m) =>
      JSON.stringify({ nodes: m._projection.nodes, gradeSummary: m._projection.gradeSummary }),
    );
    expect(new Set(shapes).size).toBe(1);
    // row data flows through setup state at run time
    const { ctx } = fakeBase();
    const res = await runWorkflow(members[1], ctx);
    expect(res.status).toBe("passed");
    expect(res.state).toEqual({ currency: "EUR", label: "eur" });
  });

  it("filter drops rows before building; $index interpolates", () => {
    const members = workflow.each(regions)(
      { id: "row-$index", filter: (row) => row.region !== "eu" },
      (wf) => wf.compute("c", (s) => s),
    );
    expect(members.map((m) => m.meta.id)).toEqual(["row-0", "row-1"]);
  });

  it("REJECTS a factory that shapes the graph from the row (one-structure contract)", () => {
    expect(() =>
      workflow.each(regions)({ id: "bad-$region" }, (wf, row) => {
        const c = wf.setup(async () => ({}));
        // graph shape depends on the row — N different structures
        return row.region === "us" ? c.compute("extra", (s) => s) : c;
      }),
    ).toThrow(/DIFFERENT structure/);
  });

  it("a REJECTED matrix leaves nothing in the registry — not even valid prior rows (codex R3)", () => {
    expect(() =>
      workflow.each(regions)({ id: "halfreg-$region" }, (wf, row) => {
        const c = wf.setup(async () => ({}));
        return row.region === "jp" ? c.compute("extra", (s) => s) : c; // row 2 diverges
      }),
    ).toThrow(/DIFFERENT structure/);
    expect(getRegistryForEach().some((r) => r.id.startsWith("halfreg-"))).toBe(false);
  });


  it("row-dependent LIFECYCLE presence is rejected (codex R15)", () => {
    expect(() =>
      workflow.each(regions)({ id: "lc-$region" }, (wf, row) => {
        const base = row.region === "eu" ? wf.setup(async () => ({})) : wf;
        return base.compute("c", (s) => s);
      }),
    ).toThrow(/DIFFERENT structure/);
  });

  it("row-dependent META (e.g. skip) is rejected like row-dependent structure (codex R14)", () => {
    expect(() =>
      workflow.each(regions)({ id: "ms-$region" }, (wf, row) => {
        const c = wf.meta(row.region === "eu" ? { description: "EU only" } : {});
        return c.compute("c", (s) => s);
      }),
    ).toThrow(/DIFFERENT structure/);
  });

  it("rejects an async factory and a missing template id", () => {
    expect(() =>
      workflow.each(regions)({ id: "x-$region" }, (async (wf: unknown) => wf) as never),
    ).toThrow(/must be synchronous/);
    expect(() => workflow.each(regions)({ id: "" }, (wf) => wf)).toThrow(/template id/);
  });

  it("parallel sets the group: registry rows carry groupId + parallel", () => {
    workflow.each(regions)(
      { id: "par-$region", parallel: true },
      (wf) => wf.compute("c", (s) => s),
    );
    const entries = getRegistryForEach().filter((r) => r.id.startsWith("par-"));
    expect(entries).toHaveLength(3);
    expect(entries.every((r) => r.groupId === "par-$region" && r.parallel === true)).toBe(true);
    expect(entries.every((r) => r.workflow?.templateId === "par-$region")).toBe(true);
  });



  it("object-table workflow.each does NOT gain grouping metadata (codex R11)", () => {
    const members = workflow.each({ alpha: { v: 1 }, beta: { v: 2 } })(
      { id: "ot-$_pick" },
      (wf, row) => wf.setup(async () => ({ v: row.v })),
    );
    expect(members.map((m) => m.meta.id)).toEqual(["ot-alpha", "ot-beta"]);
    for (const m of members) {
      expect(m.meta.groupId).toBeUndefined(); // deterministic — no group
    }
  });






  it("engine-owned grouping fields cannot be forged or overwritten (codex R21)", () => {
    // factory cannot overwrite engine grouping via .meta() (as-any included)
    const members = workflow.each([{ v: 1 }])(
      { id: "lk-$index", parallel: true },
      (wf, row) =>
        (wf.meta({ groupId: "forged", parallel: false } as never) as never as typeof wf).setup(
          async () => ({ v: row.v }),
        ),
    );
    expect(members[0].meta.groupId).toBe("lk-$index");
    expect(members[0]._projection.parallel).toBe(true);
    // hand-written workflow() cannot mint engine-owned fields either
    const solo = workflow({ id: "solo", groupId: "fake", parallel: true } as never)
      .setup(async () => ({}))
      .build();
    expect(solo.meta.groupId).toBeUndefined();
    expect(solo._projection.parallel).toBeUndefined();
  });


});

// --- pollAction: poll over an arbitrary async attempt (addendum §4) ----------

describe("runWorkflow — pollAction (addendum §4)", () => {
  it("polls an async probe until the L2 exit holds; probe noise quarantined; out folds the hit", async () => {
    const { ctx, rec } = fakeBase();
    let takes = 0;
    const wf = workflow("pa-inbox")
      .setup(async () => ({ seen: "" }))
      .pollAction(
        "wait for email",
        async (c) => {
          takes += 1;
          c.assert(takes >= 3, `probe-${takes}`); // probe noise — must be discarded
          return takes >= 3 ? { subject: "Welcome" } : { subject: "" };
        },
        {
          until: (w) => w.when((r: { subject: string }) => r.subject).eq("Welcome"),
          out: (s, r) => ({ ...s, seen: r.subject }),
          every: 1,
          maxAttempts: 10,
          perAttemptTimeout: 1000,
          project: { reads: ["inbox"], note: "wait for the welcome email" },
        },
      )
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(res.state).toEqual({ seen: "Welcome" });
    expect(takes).toBe(3);
    // probe-attempt assertion noise discarded; only the satisfying attempt flushed
    expect(rec.asserts).toEqual([{ passed: true, message: "probe-3" }]);
  });

  it("the attempt ctx.signal is the PER-ATTEMPT budget abort; exhaustion fails the node", async () => {
    const { ctx } = fakeBase();
    const aborted: boolean[] = [];
    const wf = workflow("pa-budget")
      .setup(async () => ({}))
      .pollAction(
        "hang",
        async (c) => {
          await new Promise<void>((r) => {
            c.signal.addEventListener("abort", () => {
              aborted.push(true);
              r();
            });
          });
          return null;
        },
        { untilRuntime: () => false, message: "m", every: 1, maxAttempts: 2, perAttemptTimeout: 15 },
      )
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(res.error).toBeInstanceOf(PollExhaustedError);
    expect(aborted.length).toBeGreaterThan(0); // the budget abort reached the probe
  });

  it("an over-budget attempt rejecting with a PLAIN error is still exhaustion — buffer discarded (codex S2.11 R1)", async () => {
    const { ctx, rec } = fakeBase();
    const wf = workflow("pa-plain-abort")
      .setup(async () => ({}))
      .pollAction(
        "hang",
        async (c) => {
          c.assert(false, "orphan noise"); // buffered — must NEVER flush
          await new Promise((_resolve, reject) => {
            c.signal.addEventListener("abort", () => reject(new Error("cancelled by handler")));
          });
          return null;
        },
        { untilRuntime: () => false, message: "m", every: 1, maxAttempts: 2, perAttemptTimeout: 15 },
      )
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(res.error).toBeInstanceOf(PollExhaustedError); // NOT "cancelled by handler"
    expect(rec.asserts).toEqual([]); // the orphan's buffer stayed quarantined
  });

  it("grade ladder (§6.7): action attempt caps at partial with an L2 exit; opaque exit → opaque", () => {
    const partial = workflow("pa-grade1")
      .setup(async () => ({}))
      .pollAction("p", async () => ({ ok: true }), {
        until: (w) => w.when((r: { ok: boolean }) => r.ok).eq(true),
        timeout: 1000,
      })
      .build();
    const opaque = workflow("pa-grade2")
      .setup(async () => ({}))
      .pollAction("p", async () => true, {
        untilRuntime: (_c, r) => r === true,
        message: "m",
        timeout: 1000,
      })
      .build();
    expect(projectWorkflow(partial).nodes[0].grade).toBe("partial");
    expect(projectWorkflow(opaque).nodes[0].grade).toBe("opaque");
    // projection: no call identity; the dataflow hints project instead
    const proj = projectWorkflow(
      workflow("pa-proj")
        .setup(async () => ({}))
        .pollAction("p", async () => null, {
          untilRuntime: (_c, r) => r !== null,
          message: "m",
          timeout: 1000,
          project: { reads: ["inbox"], note: "n" },
        })
        .build(),
    ).nodes[0];
    expect(proj.contractId).toBeUndefined();
    expect(proj.reads).toEqual(["inbox"]);
    expect(proj.note).toBe("n");
    expect(proj.timeoutMs).toBe(1000);
  });

  it("builder validation: attempt fn + exit predicate + bounds are required", () => {
    expect(() =>
      workflow("w").pollAction("p", undefined as never, { untilRuntime: () => true, message: "m", timeout: 100 }),
    ).toThrow(/requires an attempt function/);
    expect(() =>
      workflow("w").pollAction("p", async () => null, { timeout: 100 } as never),
    ).toThrow(/requires an exit predicate/);
    expect(() =>
      workflow("w").pollAction("p", async () => null, {
        untilRuntime: () => true,
        message: "m",
      } as never),
    ).toThrow(/needs a stop condition/);
  });
});

// --- switch / route: the branch family (addendum §9) -------------------------

describe("runWorkflow — switch (addendum §9 #4)", () => {
  it("value mode: === match runs ONLY the taken case; others + default skipped; decision event emitted", async () => {
    const { ctx, rec } = fakeBase();
    const wf = workflow("sw-value")
      .setup(async () => ({ plan: "pro", path: "none" }))
      .switch("by plan", {
        on: (s) => s.plan,
        cases: [
          { value: "free", then: (b) => b.compute("go-free", (s) => ({ ...s, path: "free" })) },
          { value: "pro", then: (b) => b.compute("go-pro", (s) => ({ ...s, path: "pro" })) },
        ],
        default: (b) => b.compute("go-default", (s) => ({ ...s, path: "default" })),
      })
      .compute("after", (s) => s) // trunk continues (converging)
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect((res.state as { path: string }).path).toBe("pro");
    expect(Object.fromEntries(res.nodes.map((n) => [n.id, n.status]))).toEqual({
      "by plan": "passed",
      "go-free": "skipped",
      "go-pro": "passed",
      "go-default": "skipped",
      after: "passed",
    });
    const decision = rec.events.find((e) => e.type === "workflow:branch_decision");
    expect(decision?.data).toMatchObject({
      nodeId: "by plan",
      mode: "value",
      takenIndex: 1,
      takenLabel: "pro",
    });
  });

  it("value mode with NO match and NO default = identity pass-through (§9 #4)", async () => {
    const { ctx, rec } = fakeBase();
    const wf = workflow("sw-identity")
      .setup(async () => ({ plan: "enterprise" }))
      .switch("by plan", {
        on: (s) => s.plan,
        cases: [{ value: "free", then: (b) => b.compute("c", (s) => s) }],
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(res.state).toEqual({ plan: "enterprise" }); // state unchanged
    expect(res.nodes.find((n) => n.id === "by plan")!.status).toBe("passed");
    const decision = rec.events.find((e) => e.type === "workflow:branch_decision");
    expect(decision?.data).toMatchObject({ takenIndex: "default" });
  });

  it("predicate mode: ordered first-match (overlapping predicates take the FIRST)", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("sw-pred")
      .setup(async () => ({ n: 10, hit: "none" }))
      .switch("by n", {
        cases: [
          {
            when: (w) => w.when((s: { n: number }) => s.n).gt(5),
            then: (b) => b.compute("big", (s) => ({ ...s, hit: "big" })),
          },
          {
            when: (w) => w.when((s: { n: number }) => s.n).gt(1),
            then: (b) => b.compute("medium", (s) => ({ ...s, hit: "medium" })), // overlaps; must not run
          },
        ],
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect((res.state as { hit: string }).hit).toBe("big");
    expect(res.nodes.find((n) => n.id === "medium")!.status).toBe("skipped");
  });

  it("a FORKED side chain throws at authoring time (codex S2.8 R3 P2)", () => {
    // Discarding a reshaping chain and returning a second same-state chain
    // compiles — the runtime tip guard catches the fork.
    expect(() =>
      workflow("w")
        .setup(async () => ({ a: 1, b: 2 }))
        .branch("g", {
          when: (w) => w.when((s) => s.a).eq(1),
          then: (b) => {
            (b as unknown as { compute: (id: string, f: (s: unknown) => unknown) => unknown }).compute(
              "drop",
              (s) => ({ a: (s as { a: number }).a }), // reshapes — would corrupt the trunk
            );
            return b.check("noop", async () => {});
          },
        }),
    ).toThrow(/forked its chain/);
    // …while a legitimate block body that continues from the latest handle passes:
    expect(() =>
      workflow("w2")
        .setup(async () => ({ a: 1 }))
        .branch("g", {
          when: (w) => w.when((s) => s.a).eq(1),
          then: (b) => {
            const c = b.check("step-1", async () => {});
            return c.check("step-2", async () => {});
          },
        }),
    ).not.toThrow();
  });

  it("rejects colliding case labels and non-finite numeric values (codex S2.8 R1)", () => {
    // value: 1 and value: "1" both stringify to "1" — child id prefixes and
    // takenLabel would collide; an explicit distinct label is required.
    expect(() =>
      workflow("w")
        .setup(async () => ({ k: 1 as number | string }))
        .switch("s", {
          on: (s) => s.k,
          cases: [
            { value: 1, then: (b) => b.compute("a", (s) => s) },
            { value: "1", then: (b) => b.compute("b", (s) => s) },
          ],
        }),
    ).toThrow(/duplicate case label "1"/);
    // …and an explicit label resolves it:
    expect(() =>
      workflow("w2")
        .setup(async () => ({ k: 1 as number | string }))
        .switch("s", {
          on: (s) => s.k,
          cases: [
            { value: 1, then: (b) => b.compute("a", (s) => s) },
            { value: "1", then: (b) => b.compute("b", (s) => s), label: "one-string" },
          ],
        }),
    ).not.toThrow();
    // "default" is reserved for the fallback side's id prefix (codex S2.8 R2).
    expect(() =>
      workflow("w4")
        .setup(async () => ({ k: "default" }))
        .switch("s", {
          on: (s) => s.k,
          cases: [{ value: "default", then: (b) => b.compute("c", (s) => s) }],
          default: (b) => b.compute("d", (s) => s),
        }),
    ).toThrow(/label "default" is reserved/);
    // NaN never matches under === and is not JSON-safe.
    expect(() =>
      workflow("w3")
        .setup(async () => ({}))
        .switch("s", { on: () => Number.NaN, cases: [{ value: Number.NaN, then: (b) => b.compute("c", (s) => s) }] }),
    ).toThrow(/finite number/);
  });

  it("build-time validation: duplicate value, non-scalar value, non-L2 predicate, empty cases", () => {
    expect(() =>
      workflow("w")
        .setup(async () => ({ k: "a" }))
        .switch("s", {
          on: (s) => s.k,
          cases: [
            { value: "a", then: ((b: unknown) => b) as never },
            { value: "a", then: ((b: unknown) => b) as never }, // unreachable duplicate
          ],
        }),
    ).toThrow(/duplicate case value/);
    expect(() =>
      workflow("w")
        .setup(async () => ({}))
        .switch("s", { on: () => "x", cases: [{ value: {} as never, then: ((b: unknown) => b) as never }] }),
    ).toThrow(/JSON-scalar/);
    expect(() =>
      workflow("w")
        .setup(async () => ({}))
        .switch("s", { cases: [{ when: (() => ({ kind: "opaque" })) as never, then: ((b: unknown) => b) as never }] }),
    ).toThrow(/switch/);
    expect(() =>
      workflow("w")
        .setup(async () => ({}))
        .switch("s", { cases: [] as never }),
    ).toThrow(/at least one case/);
  });

  it("projection: value mode is a full decision table; grade summary counts the family node + children", () => {
    const wf = workflow("sw-proj")
      .setup(async () => ({ k: "a" }))
      .switch("dispatch", {
        on: (s) => s.k,
        cases: [
          { value: "a", then: (b) => b.compute("ca", (s) => s) },
          { value: "b", then: (b) => b.compute("cb", (s) => s), label: "bee" },
        ],
        default: (b) => b.compute("cd", (s) => s),
      })
      .build();
    const proj = projectWorkflow(wf);
    const n = proj.nodes.find((p) => p.id === "dispatch")!;
    expect(n).toMatchObject({ kind: "branch", mode: "value", grade: "full" });
    expect(n.cases!.map((c) => [c.label, c.value])).toEqual([
      ["a", "a"],
      ["bee", "b"],
    ]);
    expect(n.default![0].id).toBe("cd");
    expect(proj.gradeSummary).toEqual({ full: 4, partial: 0, opaque: 0 }); // dispatch + ca + cb + cd
  });
});

describe("runWorkflow — route (addendum §9 #5)", () => {
  it("terminal: the taken case runs, the trunk ENDS (only teardown after); leaf state reaches teardown", async () => {
    const { ctx } = fakeBase();
    let teardownState: unknown;
    const wf = workflow("rt-terminal")
      .setup(async () => ({ kind: "a", trunk: true }))
      .route("fan out", {
        on: (s) => s.kind,
        cases: [
          {
            value: "a",
            then: (b) => b.compute("leaf-a", (s) => ({ ...s, leaf: "a" })),
          },
          { value: "b", then: (b) => b.compute("leaf-b", (s) => ({ ...s, leaf: "b" })) },
        ],
        default: (b) => b.check("no-match", async (c) => c.fail("unrouted")),
      })
      .teardown(async (_c, s) => {
        teardownState = s;
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(res.state).toEqual({ kind: "a", trunk: true, leaf: "a" }); // leaf state committed
    expect(teardownState).toEqual({ kind: "a", trunk: true, leaf: "a" });
    expect(Object.fromEntries(res.nodes.map((n) => [n.id, n.status]))).toEqual({
      "fan out": "passed",
      "leaf-a": "passed",
      "leaf-b": "skipped",
      "no-match": "skipped",
    });
  });

  it("default is REQUIRED and runs on no-match; missing default throws at build time", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("rt-default")
      .setup(async () => ({ kind: "zzz" }))
      .route("fan out", {
        on: (s) => s.kind,
        cases: [{ value: "a", then: (b) => b.compute("leaf-a", (s) => s) }],
        default: (b) => b.compute("fallback", (s) => ({ ...s, routed: "default" })),
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect((res.state as { routed?: string }).routed).toBe("default");

    expect(() =>
      workflow("w")
        .setup(async () => ({}))
        .route("r", {
          on: () => "x",
          cases: [{ value: "x", then: (b: unknown) => b }],
        } as never),
    ).toThrow(/requires a `default` case/);
  });

  it("nothing may follow .route() — terminal at the type AND runtime layer", () => {
    const b = workflow("rt-frozen").setup(async () => ({ k: "x" }));
    const terminal = b.route("r", {
      on: (s) => s.k,
      cases: [{ value: "x", then: (bb) => bb }],
      default: (bb) => bb,
    });
    expect(typeof terminal.teardown).toBe("function");
    expect(typeof terminal.build).toBe("function");
    // runtime guard for `as any` callers (the type layer already forbids this)
    expect(() => (b as unknown as { compute: (i: string, f: (s: unknown) => unknown) => unknown }).compute("late", (s) => s)).toThrow(
      /cannot follow route/,
    );
  });

  it("a route smuggled into mid-list ends the trunk: later nodes report skipped", async () => {
    const { ctx } = fakeBase();
    const wf = workflow("rt-smuggle")
      .setup(async () => ({ k: "x" }))
      .route("r", {
        on: (s) => s.k,
        cases: [{ value: "x", then: (b) => b.compute("leaf", (s) => s) }],
        default: (b) => b,
      })
      .build();
    // smuggle a node AFTER the terminal route (builder forbids it; `as any` can't)
    (wf.nodes as WorkflowNode[]).push({
      kind: "compute",
      meta: { id: "after", name: "after" },
      fn: (s: unknown) => s,
    } as WorkflowNode);
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(res.nodes.find((n) => n.id === "after")!.status).toBe("skipped"); // never executed
  });
});

// --- poll: build-time validation + projection (§6.7) -------------------------

describe("workflow.poll() — build-time validation + projection", () => {
  const ref = fakeRef<void, { status: string }>("job-api", "status", "wf-poll", "GET /job");

  it("requires an exit predicate (until XOR untilRuntime)", () => {
    expect(() =>
      workflow("w").poll("p", ref, { maxAttempts: 3, perAttemptTimeout: 50 } as never),
    ).toThrow(/requires an exit predicate/);
  });

  it("untilRuntime without a message throws at build time", () => {
    expect(() =>
      workflow("w").poll("p", ref, {
        untilRuntime: async () => true,
        maxAttempts: 3,
        perAttemptTimeout: 50,
      } as never),
    ).toThrow(/requires a non-empty `message`/);
  });

  it("rejects a non-L2 declarative `until` (assertL2Predicate)", () => {
    expect(() =>
      workflow("w").poll("p", ref, {
        until: (() => ({ kind: "opaque" })) as never,
        maxAttempts: 3,
        perAttemptTimeout: 50,
      }),
    ).toThrow(/poll/);
  });

  it("validates bounds at build time: a stop condition AND a finite attempt budget", () => {
    const until = (w: never) =>
      (w as { when: (f: (r: { status: string }) => string) => { eq: (v: string) => never } })
        .when((r) => r.status)
        .eq("done");
    // no stop condition at all
    expect(() => workflow("w").poll("p", ref, { until, perAttemptTimeout: 50 } as never)).toThrow(
      /needs a stop condition/,
    );
    // maxAttempts-only — unbounded single attempt
    expect(() => workflow("w").poll("p", ref, { until, maxAttempts: 3 } as never)).toThrow(
      /not bounded/,
    );
  });

  it("cannot be added after .teardown()", () => {
    expect(() =>
      workflow("w")
        .teardown(async () => {})
        .poll("p", ref, {
          until: (w) => w.when((r: { status: string }) => r.status).eq("done"),
          timeout: 1000,
        }),
    ).toThrow(/cannot be added after \.teardown\(\)/);
  });

  it("applies every/backoff defaults into the IR (every=1000, backoff=1)", () => {
    const wf = workflow("w")
      .poll("p", ref, {
        until: (w) => w.when((r: { status: string }) => r.status).eq("done"),
        timeout: 5000,
      })
      .build();
    expect(wf.nodes[0]).toMatchObject({ kind: "poll", every: 1000, backoff: 1 });
  });

  it("L2 poll projects full with the extracted until tree, call identity, and bounds", () => {
    const wf = workflow("w")
      .poll("wait", ref, {
        until: (w) => w.when((r: { status: string }) => r.status).eq("completed"),
        accept: [200, 404] as never,
        every: 250,
        backoff: 2,
        timeout: 30_000,
        perAttemptTimeout: 5_000,
        maxAttempts: 10,
      })
      .build();
    const proj = projectWorkflow(wf);
    expect(proj.nodes[0]).toMatchObject({
      kind: "poll",
      id: "wait",
      grade: "full",
      target: "GET /job",
      protocol: "wf-poll",
      contractId: "job-api",
      caseKey: "status",
      accept: [200, 404],
      until: { kind: "compare", op: "eq", path: ["status"], value: "completed" },
      every: 250,
      backoff: 2,
      timeoutMs: 30_000,
      perAttemptTimeoutMs: 5_000,
      maxAttempts: 10,
    });
    expect(proj.gradeSummary).toEqual({ full: 1, partial: 0, opaque: 0 }); // poll = ONE leaf grade
  });

  it("untilRuntime projects opaque L0 (may-do-async-IO) with its message", () => {
    const wf = workflow("w")
      .poll("wait", ref, {
        untilRuntime: (_c, res: { status: string }) => res.status === "completed",
        message: "job settles",
        maxAttempts: 5,
        perAttemptTimeout: 100,
      })
      .build();
    const proj = projectWorkflow(wf);
    expect(proj.nodes[0]).toMatchObject({
      kind: "poll",
      grade: "opaque",
      until: { kind: "opaque", strictness: "L0", mayDoAsyncIO: true },
      message: "job settles",
    });
    expect(proj.gradeSummary).toEqual({ full: 0, partial: 0, opaque: 1 });
  });
});

// --- poll: executor (§17 #3) --------------------------------------------------

describe("runWorkflow — poll (§17 #3)", () => {
  afterEach(() => {
    __unregisterProtocolForTesting("wf-poll");
  });

  /** Register a fake poll adapter whose responses are scripted per attempt. */
  const registerPollAdapter = (
    attemptFn: (args: {
      attempt: number;
      ctx: TestContext;
      resolvedInputs: unknown;
      accept?: unknown;
      signal?: AbortSignal;
    }) => Promise<unknown>,
  ): { calls: () => number } => {
    let attempt = 0;
    contract.register("wf-poll", {
      project: () => ({ cases: {} }),
      executeCaseInFlow: async (args: {
        ctx: TestContext;
        resolvedInputs: unknown;
        accept?: unknown;
        signal?: AbortSignal;
      }) => {
        attempt += 1;
        return attemptFn({ attempt, ...args });
      },
    } as never);
    return { calls: () => attempt };
  };

  const ref = fakeRef<void, { status: string; n: number }>(
    "job-api",
    "status",
    "wf-poll",
    "GET /job",
  );

  it("satisfies on a later attempt: probes discarded, satisfying attempt flushed, out committed (§17 #3)", async () => {
    const { ctx, rec } = fakeBase();
    registerPollAdapter(async ({ attempt, ctx: c }) => {
      // probe attempts emit pending-validation noise; the satisfying one passes.
      if (attempt < 3) {
        c.assert(false, `noise-${attempt}`); // quarantined → must be DISCARDED
        return { status: "pending", n: attempt };
      }
      c.assert(true, "final ok"); // satisfying attempt → flushed
      return { status: "completed", n: attempt };
    });
    const wf = workflow("poll-ok")
      .setup(async () => ({ seen: 0 }))
      .poll("wait", ref, {
        until: (w) => w.when((r: { status: string }) => r.status).eq("completed"),
        out: (s, r) => ({ ...s, seen: r.n }),
        every: 1,
        maxAttempts: 10,
        perAttemptTimeout: 1000,
      })
      .build();

    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(res.state).toEqual({ seen: 3 }); // out applied to the SATISFYING response
    expect(res.nodes).toEqual([{ id: "wait", status: "passed", grade: "full" }]);
    // probe noise discarded; only the satisfying attempt's assert landed.
    expect(rec.asserts).toEqual([{ passed: true, message: "final ok" }]);
    // attempt timeline: two probes then satisfied (§17 #9).
    const attempts = rec.events.filter((e) => e.type === POLL_ATTEMPT_EVENT).map((e) => e.data);
    expect(attempts.map((a) => a.outcome)).toEqual(["probe", "probe", "satisfied"]);
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
  });

  it("fails the node when the SATISFYING attempt's flushed evidence carries a failure; out NOT applied", async () => {
    const { ctx, rec } = fakeBase();
    registerPollAdapter(async ({ ctx: c }) => {
      c.assert(false, "schema drift"); // flushed with the satisfying attempt
      return { status: "completed", n: 1 };
    });
    const wf = workflow("poll-soft")
      .setup(async () => ({ seen: 0 }))
      .poll("wait", ref, {
        until: (w) => w.when((r: { status: string }) => r.status).eq("completed"),
        out: (s, r) => ({ ...s, seen: r.n }),
        every: 1,
        maxAttempts: 3,
        perAttemptTimeout: 1000,
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(res.error).toBeInstanceOf(WorkflowPhaseFailedError);
    expect(res.state).toEqual({ seen: 0 }); // commit-on-success: out NOT applied (§17 #13)
    expect(rec.asserts).toEqual([{ passed: false, message: "schema drift" }]);
  });

  it("exhausts on maxAttempts: node failed with PollExhaustedError, rest skipped, probe noise discarded", async () => {
    const { ctx, rec } = fakeBase();
    const adapter = registerPollAdapter(async ({ ctx: c }) => {
      c.assert(false, "still pending"); // every attempt is a probe → all discarded
      return { status: "pending", n: 0 };
    });
    const wf = workflow("poll-max")
      .setup(async () => ({ ok: true }))
      .poll("wait", ref, {
        until: (w) => w.when((r: { status: string }) => r.status).eq("completed"),
        every: 1,
        maxAttempts: 3,
        perAttemptTimeout: 1000,
      })
      .action("after", async (_c, s) => s)
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(res.error).toBeInstanceOf(PollExhaustedError);
    expect((res.error as Error).message).toMatch(/maxAttempts reached/);
    expect(adapter.calls()).toBe(3);
    expect(res.state).toEqual({ ok: true }); // prior state stands
    expect(Object.fromEntries(res.nodes.map((n) => [n.id, n.status]))).toEqual({
      wait: "failed",
      after: "skipped",
    });
    expect(rec.asserts).toEqual([]); // discarded probe noise never lands (§17 #3)
  });

  it("exhausts when the next wait would cross the total timeout (no pointless sleep)", async () => {
    const { ctx } = fakeBase();
    registerPollAdapter(async () => ({ status: "pending", n: 0 }));
    const wf = workflow("poll-deadline")
      .setup(async () => ({}))
      .poll("wait", ref, {
        until: (w) => w.when((r: { status: string }) => r.status).eq("completed"),
        every: 5_000, // next wait crosses the 100ms deadline after attempt 1
        timeout: 100,
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect((res.error as Error).message).toMatch(/next wait would exceed timeout/);
  });

  it("a hung adapter is bounded by the per-attempt budget; the orphan's late fail is discarded", async () => {
    const { ctx, rec } = fakeBase();
    registerPollAdapter(async ({ ctx: c }) => {
      await delay(60); // never finishes within the 15ms budget
      c.fail("late orphan failure"); // buffered on the orphan's ctx → never flushed
      return { status: "completed", n: 0 };
    });
    const wf = workflow("poll-hang")
      .setup(async () => ({}))
      .poll("wait", ref, {
        until: (w) => w.when((r: { status: string }) => r.status).eq("completed"),
        every: 1,
        maxAttempts: 2,
        perAttemptTimeout: 15,
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(res.error).toBeInstanceOf(PollExhaustedError);
    expect((res.error as Error).message).toMatch(/attempt budget/);
    await delay(80); // let the orphan settle — its fail must NOT land
    expect(rec.asserts).toEqual([]);
  });

  it("converts a signal-honoring adapter's AbortError into poll exhaustion (not a raw AbortError)", async () => {
    const { ctx } = fakeBase();
    registerPollAdapter(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    );
    const wf = workflow("poll-abort")
      .setup(async () => ({}))
      .poll("wait", ref, {
        until: (w) => w.when((r: { status: string }) => r.status).eq("completed"),
        every: 1,
        maxAttempts: 2,
        perAttemptTimeout: 15,
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(res.error).toBeInstanceOf(PollExhaustedError); // converted, with attempt count
    expect((res.error as Error).message).toMatch(/attempt budget/);
  });

  it("an in-budget deliberate ctx.fail() in the adapter flushes and fails the poll (§17 #3)", async () => {
    const { ctx, rec } = fakeBase();
    registerPollAdapter(async ({ ctx: c }) => {
      c.fail("resource gone");
    });
    const wf = workflow("poll-fail")
      .setup(async () => ({}))
      .poll("wait", ref, {
        until: (w) => w.when((r: { status: string }) => r.status).eq("completed"),
        every: 1,
        maxAttempts: 5,
        perAttemptTimeout: 1000,
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect((res.error as Error).message).toBe("resource gone");
    expect(rec.asserts).toEqual([{ passed: false, message: "resource gone" }]); // flushed
  });

  it("a predicate ctx.skip() (no prior failure) skips the whole workflow", async () => {
    const { ctx } = fakeBase();
    registerPollAdapter(async () => ({ status: "pending", n: 0 }));
    let teardownRan = false;
    const wf = workflow("poll-skip")
      .setup(async () => ({}))
      .poll("wait", ref, {
        untilRuntime: (c) => {
          c.skip("feature disabled");
          return true;
        },
        message: "m",
        every: 1,
        maxAttempts: 3,
        perAttemptTimeout: 1000,
      })
      .teardown(async () => {
        teardownRan = true;
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("skipped");
    expect(res.nodes).toEqual([{ id: "wait", status: "skipped", grade: "opaque" }]);
    expect(teardownRan).toBe(true);
  });

  it("a predicate soft-failure then skip surfaces a phase-failure cause, not the skip", async () => {
    const { ctx } = fakeBase();
    registerPollAdapter(async () => ({ status: "pending", n: 0 }));
    const wf = workflow("poll-fail-skip")
      .setup(async () => ({}))
      .poll("wait", ref, {
        untilRuntime: (c) => {
          c.assert(false, "soft");
          c.skip("then skip");
          return true;
        },
        message: "m",
        every: 1,
        maxAttempts: 3,
        perAttemptTimeout: 1000,
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(res.error).toBeInstanceOf(WorkflowPhaseFailedError); // NOT the skip
  });

  it("a non-boolean untilRuntime result fails the poll (no silent coercion)", async () => {
    const { ctx } = fakeBase();
    registerPollAdapter(async () => ({ status: "pending", n: 0 }));
    const wf = workflow("poll-nonbool")
      .setup(async () => ({}))
      .poll("wait", ref, {
        untilRuntime: (() => "false") as never, // truthy string would wrongly satisfy
        message: "m",
        every: 1,
        maxAttempts: 3,
        perAttemptTimeout: 1000,
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect((res.error as Error).message).toMatch(/untilRuntime must return a boolean/);
  });

  it("the until-predicate's traces are observability: always flushed, promote opaque→trace (§17 #3/#10)", async () => {
    const { ctx, rec } = fakeBase();
    registerPollAdapter(async ({ attempt }) => ({
      status: attempt >= 2 ? "completed" : "pending",
      n: attempt,
    }));
    const wf = workflow("poll-trace")
      .setup(async () => ({}))
      .poll("wait", ref, {
        untilRuntime: (c, r: { status: string }) => {
          c.trace(aTrace()); // structured evidence from a PROBE evaluation too
          return r.status === "completed";
        },
        message: "m",
        every: 1,
        maxAttempts: 5,
        perAttemptTimeout: 1000,
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(rec.traces).toHaveLength(2); // one per evaluation, probe included
    expect(res.nodes[0].grade).toBe("trace"); // opaque → trace promotion (§17 #10)
  });

  it("discarded probe evidence does NOT promote the grade (§17 #10)", async () => {
    const { ctx } = fakeBase();
    registerPollAdapter(async ({ ctx: c }) => {
      c.assert(false, "probe noise"); // quarantined + discarded every attempt
      return { status: "pending", n: 0 };
    });
    const wf = workflow("poll-no-promote")
      .setup(async () => ({}))
      .poll("wait", ref, {
        untilRuntime: () => false,
        message: "m",
        every: 1,
        maxAttempts: 2,
        perAttemptTimeout: 1000,
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed"); // exhausted
    expect(res.nodes[0].grade).toBe("opaque"); // discarded evidence never promotes
  });

  it("fails the poll when `out` returns a thenable (§17 #11)", async () => {
    const { ctx } = fakeBase();
    registerPollAdapter(async () => ({ status: "completed", n: 1 }));
    const wf = workflow("poll-out-thenable")
      .setup(async () => ({}))
      .poll("wait", ref, {
        until: (w) => w.when((r: { status: string }) => r.status).eq("completed"),
        out: (() => Promise.resolve({})) as never,
        every: 1,
        maxAttempts: 2,
        perAttemptTimeout: 1000,
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect((res.error as Error).message).toMatch(/`out` returned a thenable/);
  });

  it("fails the poll when `in` returns a thenable (shared call-attempt path)", async () => {
    const { ctx } = fakeBase();
    registerPollAdapter(async () => ({ status: "completed", n: 1 }));
    const wf = workflow("poll-in-thenable")
      .setup(async () => ({}))
      .poll("wait", ref, {
        in: (() => Promise.resolve({})) as never,
        untilRuntime: () => true,
        message: "m",
        every: 1,
        maxAttempts: 2,
        perAttemptTimeout: 1000,
      } as never)
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect((res.error as Error).message).toMatch(
      /workflow poll "wait": `in` returned a thenable/,
    );
  });

  it("passes accept + the per-attempt signal through to the adapter", async () => {
    const { ctx } = fakeBase();
    let sawAccept: unknown;
    let sawSignal: unknown;
    registerPollAdapter(async ({ accept, signal }) => {
      sawAccept = accept;
      sawSignal = signal;
      return { status: "completed", n: 1 };
    });
    const wf = workflow("poll-passthrough")
      .setup(async () => ({}))
      .poll("wait", ref, {
        until: (w) => w.when((r: { status: string }) => r.status).eq("completed"),
        accept: [200, 404] as never,
        every: 1,
        maxAttempts: 2,
        perAttemptTimeout: 1000,
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(sawAccept).toEqual([200, 404]);
    expect(sawSignal).toBeInstanceOf(AbortSignal);
  });

  it("an unbounded poll node smuggled past the builder fails fast at run time", async () => {
    const { ctx } = fakeBase();
    registerPollAdapter(async () => ({ status: "pending", n: 0 }));
    const wf = workflow("poll-unbounded")
      .setup(async () => ({}))
      .poll("wait", ref, {
        until: (w) => w.when((r: { status: string }) => r.status).eq("completed"),
        timeout: 1000,
      })
      .build();
    // strip the bounds after build (an `as any` / JS caller could hand this in).
    (wf.nodes[0] as { timeoutMs?: number }).timeoutMs = undefined;
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect((res.error as Error).message).toMatch(/needs a stop condition/);
  });
});

// --- per-node + lifecycle timeouts (§17 #4 wiring — S2.9) ----------------------

describe("workflow timeouts (§17 #4)", () => {
  it("builder: timeout only on call/action/check; finite > 0", () => {
    const fn = async (_c: unknown, s: unknown) => s;
    expect(() => workflow("w").compute({ id: "c", timeout: 50 }, (s) => s)).toThrow(
      /not supported on compute/,
    );
    expect(() =>
      workflow("w")
        .setup(async () => ({ ok: true }))
        .branch({ id: "b", timeout: 50 }, {
          when: (w) => w.when((s: { ok: boolean }) => s.ok).eq(true),
          then: (b) => b.check("c", async () => {}),
        }),
    ).toThrow(/not supported on branch/);
    expect(() => workflow("w").action({ id: "a", timeout: 0 }, fn as never)).toThrow(
      /finite number > 0/,
    );
    expect(() => workflow("w").action({ id: "a", timeout: 50 }, fn as never)).not.toThrow();
  });

  it("a hung action is aborted at its node timeout — TERMINAL even with retry configured", async () => {
    const { ctx } = fakeBase();
    let calls = 0;
    const wf = workflow("t-node")
      .setup(async () => ({}))
      .action(
        { id: "slow", timeout: 20 },
        async () => {
          calls += 1;
          await delay(200);
        },
        { retry: { attempts: 3, reason: "must not replay a timeout" } },
      )
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(res.error).toBeInstanceOf(NodeTimeoutError);
    expect(calls).toBe(1); // §17 #4: terminal — never retried
  });

  it("a timed-out setup fails the run with the timeout as the cause; teardown still runs", async () => {
    const { ctx } = fakeBase();
    let teardownCause: unknown;
    const wf = workflow("t-setup")
      .setup(async () => {
        await delay(200);
        return {};
      }, { timeout: 20 })
      .compute("never", (s) => s)
      .teardown(async (_c, _s, cause) => {
        teardownCause = cause;
      })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(res.error).toBeInstanceOf(NodeTimeoutError);
    expect(teardownCause).toBeInstanceOf(NodeTimeoutError);
    expect(res.nodes.find((n) => n.id === "never")!.status).toBe("skipped");
  });

  it("a timed-out teardown is logged and never masks the run's verdict (§17 #1)", async () => {
    const { ctx, rec } = fakeBase();
    const wf = workflow("t-teardown")
      .setup(async () => ({ ok: true }))
      .compute("c", (s) => s)
      .teardown(async () => {
        await delay(200);
      }, { timeout: 20 })
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed"); // teardown timeout doesn't fail a passed run
    expect(rec.logs.some((l) => l.includes("teardown failed"))).toBe(true);
  });

  it("lifecycle timeout validation: finite > 0", () => {
    expect(() => workflow("w").setup(async () => ({}), { timeout: -5 })).toThrow(
      /finite number > 0/,
    );
  });

  it("the per-node timeout is projectable (nodeTimeoutMs on call/action/check)", () => {
    const wf = workflow("t-proj")
      .setup(async () => ({}))
      .action({ id: "a", timeout: 1500 }, (async (_c: unknown, s: unknown) => s) as never)
      .check({ id: "k", timeout: 800 }, async () => {})
      .build();
    const proj = projectWorkflow(wf);
    expect(proj.nodes.find((n) => n.id === "a")!.nodeTimeoutMs).toBe(1500);
    expect(proj.nodes.find((n) => n.id === "k")!.nodeTimeoutMs).toBe(800);
  });
});

// --- retry: explicit-intent retry on call/action (§17 #7) ---------------------

describe("workflow retry (§17 #7)", () => {
  afterEach(() => {
    __unregisterProtocolForTesting("wf-retry");
  });

  it("validates retry meta at build time: attempts >= 2, finite delay, required reason", () => {
    const fn = async (_c: unknown, s: unknown) => s;
    expect(() =>
      workflow("w").action("a", fn as never, { retry: { attempts: 1, reason: "r" } }),
    ).toThrow(/attempts must be an integer >= 2/);
    expect(() =>
      workflow("w").action("a", fn as never, { retry: { attempts: 2.5, reason: "r" } }),
    ).toThrow(/attempts must be an integer >= 2/);
    expect(() =>
      workflow("w").action("a", fn as never, {
        retry: { attempts: 2, delay: Number.POSITIVE_INFINITY, reason: "r" },
      }),
    ).toThrow(/delay must be a finite number >= 0/);
    expect(() =>
      workflow("w").action("a", fn as never, { retry: { attempts: 2, reason: "" } }),
    ).toThrow(/retry\.reason is required/);
  });

  it("retries a failing action and commits the passing attempt; counters belong to the final attempt", async () => {
    const { ctx, rec } = fakeBase();
    let calls = 0;
    const wf = workflow("retry-action")
      .setup(async () => ({ base: 1 }))
      .action(
        "flaky",
        async (c, s) => {
          calls += 1;
          c.assert(calls >= 3, `attempt-${calls}`);
          if (calls < 3) throw new Error(`boom-${calls}`);
          return { ...s, calls };
        },
        { retry: { attempts: 3, reason: "eventually consistent backend" } },
      )
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(calls).toBe(3);
    expect(res.state).toEqual({ base: 1, calls: 3 }); // passing attempt's return committed
    // grade: the asserts are structured evidence → opaque promotes to trace (§17 #10)
    expect(res.nodes).toEqual([{ id: "flaky", status: "passed", grade: "trace" }]);
    // pass/fail counters belong to the FINAL attempt only (codex S2.4c R1 P2): a
    // retried-and-passed node leaves NO failed assertion on the host ctx — a host
    // summary computed from assertion events must agree with the node verdict.
    expect(rec.asserts).toEqual([{ passed: true, message: "attempt-3" }]);
    // …but the failed attempts stay VISIBLE: attempt-stamped brackets + retry logs.
    const starts = rec.events.filter(
      (e) => e.type === NODE_START_EVENT && e.data.nodeId === "flaky",
    );
    const ends = rec.events.filter(
      (e) => e.type === NODE_END_EVENT && e.data.nodeId === "flaky",
    );
    expect(starts.map((e) => [e.data.attempt, e.data.attempts])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(ends.map((e) => e.data.status)).toEqual(["failed", "failed", "passed"]);
    expect(rec.logs.filter((l) => l.includes('retrying workflow node "flaky"'))).toHaveLength(2);
  });

  it("flushes the terminal attempt's evidence INSIDE its bracket — before node_end (codex R2)", async () => {
    const { ctx, rec } = fakeBase();
    // Interleave asserts + events into one ordered log to check bracketing.
    const order: string[] = [];
    const baseAssert = ctx.assert.bind(ctx);
    const baseEvent = ctx.event.bind(ctx);
    (ctx as { assert: unknown }).assert = (...args: unknown[]) => {
      order.push("assertion");
      (baseAssert as (...a: unknown[]) => void)(...args);
    };
    (ctx as { event: unknown }).event = (ev: { type: string }) => {
      order.push(ev.type);
      baseEvent(ev as never);
    };
    let calls = 0;
    const wf = workflow("retry-bracket")
      .setup(async () => ({}))
      .action(
        "flaky",
        async (c) => {
          calls += 1;
          c.assert(calls >= 2, `attempt-${calls}`);
          if (calls < 2) throw new Error("boom");
        },
        { retry: { attempts: 2, reason: "replay-safe" } },
      )
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    // the flushed assertion must land BETWEEN the final attempt's start and end.
    const lastStart = order.lastIndexOf(NODE_START_EVENT);
    const lastEnd = order.lastIndexOf(NODE_END_EVENT);
    const assertIdx = order.indexOf("assertion"); // only the terminal attempt's assert lands
    expect(rec.asserts).toEqual([{ passed: true, message: "attempt-2" }]);
    expect(assertIdx).toBeGreaterThan(lastStart);
    expect(assertIdx).toBeLessThan(lastEnd);
  });

  it("a replayed fatal validation on the terminal attempt fails the workflow — never rejects (codex R3)", async () => {
    const { ctx, rec } = fakeBase();
    // Mirror the REAL host ctx contract: validate aborts (throws) on a failed
    // fatal validation — the replayed flush must not escape runWorkflow.
    (ctx as { validate: unknown }).validate = (
      _data: unknown,
      _schema: unknown,
      label?: string,
      options?: { severity?: string },
    ) => {
      rec.validations++;
      if (options?.severity === "fatal") {
        throw new Error(`fatal validation failed: ${label ?? "data"}`);
      }
      return undefined;
    };
    const failingSchema = { safeParse: () => ({ success: false }) };
    const wf = workflow("retry-fatal")
      .setup(async () => ({}))
      .action(
        "fatal",
        async (c) => {
          c.validate({}, failingSchema as never, "shape", { severity: "fatal" });
        },
        { retry: { attempts: 2, reason: "replay-safe" } },
      )
      .build();
    const res = await runWorkflow(wf, ctx); // must RESOLVE (failed), not reject
    expect(res.status).toBe("failed");
    expect(res.nodes[0].status).toBe("failed");
    expect(rec.validations).toBeGreaterThan(0); // the terminal flush reached the host
  });

  it("aggregates opaque→trace promotion across attempts: an earlier attempt's trace counts (codex R3)", async () => {
    const { ctx, rec } = fakeBase();
    let calls = 0;
    const wf = workflow("retry-grade")
      .setup(async () => ({}))
      .action(
        "flaky",
        async (c, s) => {
          calls += 1;
          if (calls === 1) {
            c.trace(aTrace()); // structured evidence, then the attempt fails
            throw new Error("boom");
          }
          return s; // final attempt passes with NO evidence
        },
        { retry: { attempts: 2, reason: "replay-safe" } },
      )
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(rec.traces).toHaveLength(1); // the first attempt's trace is on the host timeline
    expect(res.nodes[0].grade).toBe("trace"); // …so the node summary must say trace, not opaque
    // …and the TERMINAL node_end agrees — the timeline is what runner/Cloud
    // consume, so the promotion must survive into it (codex S2.5 R5).
    const ends = rec.events.filter(
      (e) => e.type === NODE_END_EVENT && e.data.nodeId === "flaky",
    );
    expect(ends.at(-1)?.data.grade).toBe("trace");
  });

  it("a DISCARDED attempt's assert-only evidence does not promote the grade (codex R4)", async () => {
    const { ctx, rec } = fakeBase();
    let calls = 0;
    const wf = workflow("retry-no-claim")
      .setup(async () => ({}))
      .action(
        "flaky",
        async (c, s) => {
          calls += 1;
          if (calls === 1) {
            c.assert(false, "buffered-and-dropped"); // never flushed (non-final failed attempt)
            throw new Error("boom");
          }
          return s; // final attempt passes with NO evidence at all
        },
        { retry: { attempts: 2, reason: "replay-safe" } },
      )
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(rec.asserts).toEqual([]); // nothing reached the host…
    expect(res.nodes[0].grade).toBe("opaque"); // …so the summary must not claim trace
    // …and no attempt bracket claims it either: the discarded attempt's node_end
    // must say opaque too, not just the final outcome (codex S2.5 R5).
    const ends = rec.events.filter(
      (e) => e.type === NODE_END_EVENT && e.data.nodeId === "flaky",
    );
    expect(ends.map((e) => e.data.grade)).toEqual(["opaque", "opaque"]);
  });

  it("an exhausted retry flushes the LAST attempt's failed evidence (the verdict-deciding one)", async () => {
    const { ctx, rec } = fakeBase();
    let calls = 0;
    const wf = workflow("retry-exhaust")
      .setup(async () => ({}))
      .action(
        "always-bad",
        async (c) => {
          calls += 1;
          c.assert(false, `bad-${calls}`); // soft failure each attempt
        },
        { retry: { attempts: 2, reason: "replay-safe" } },
      )
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(calls).toBe(2);
    // only the final attempt's failed assert lands on the host counters.
    expect(rec.asserts).toEqual([{ passed: false, message: "bad-2" }]);
  });

  it("retries a failing contract call; exhausted attempts fail the node with the last error", async () => {
    let calls = 0;
    contract.register("wf-retry", {
      project: () => ({ cases: {} }),
      executeCaseInFlow: async () => {
        calls += 1;
        throw new Error(`net-${calls}`);
      },
    } as never);
    const { ctx } = fakeBase();
    const ref = fakeRef<void>("c", "case", "wf-retry", "GET /x");
    const wf = workflow("retry-call")
      .setup(async () => ({}))
      .call("fetch", ref, { retry: { attempts: 3, delay: 1, reason: "GET is idempotent" } })
      .action("after", async (_c, s) => s)
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(calls).toBe(3); // all attempts consumed
    expect((res.error as Error).message).toBe("net-3"); // LAST attempt's error is the cause
    expect(Object.fromEntries(res.nodes.map((n) => [n.id, n.status]))).toEqual({
      fetch: "failed",
      after: "skipped",
    });
  });

  it("each retry attempt re-reads the same last-committed state (§17 #13)", async () => {
    const { ctx } = fakeBase();
    const seen: number[] = [];
    let calls = 0;
    const wf = workflow("retry-state")
      .setup(async () => ({ n: 10 }))
      .action(
        "bump",
        async (_c, s: { n: number }) => {
          calls += 1;
          seen.push(s.n);
          if (calls < 2) throw new Error("first fails AFTER returning nothing");
          return { n: s.n + 1 };
        },
        { retry: { attempts: 2, reason: "replay-safe" } },
      )
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("passed");
    expect(seen).toEqual([10, 10]); // attempt 2 saw the same committed state, not attempt 1's draft
    expect(res.state).toEqual({ n: 11 });
  });

  it("a timeout is TERMINAL — never retried even with retry configured (§17 #4)", async () => {
    const { ctx, rec } = fakeBase();
    let calls = 0;
    // There is no builder surface for the per-node timeout yet, so pin the rule at
    // the retry-loop boundary: a NodeTimeoutError-failed attempt must stop the loop.
    const wf = workflow("retry-timeout")
      .setup(async () => ({}))
      .action(
        "slow",
        async () => {
          calls += 1;
          throw new NodeTimeoutError("slow", 5);
        },
        { retry: { attempts: 3, reason: "should never replay a timeout" } },
      )
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(calls).toBe(1); // ONE attempt — timeout never retried
    expect(res.error).toBeInstanceOf(NodeTimeoutError);
    const ends = rec.events.filter(
      (e) => e.type === NODE_END_EVENT && e.data.nodeId === "slow",
    );
    expect(ends).toHaveLength(1);
  });

  it("a ctx.skip() is control flow — never retried; the workflow skips", async () => {
    const { ctx } = fakeBase();
    let calls = 0;
    const wf = workflow("retry-skip")
      .setup(async () => ({}))
      .action(
        "gate",
        async (c) => {
          calls += 1;
          c.skip("feature off");
        },
        { retry: { attempts: 3, reason: "irrelevant" } },
      )
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("skipped");
    expect(calls).toBe(1);
  });

  it("an invalid retry smuggled past the builder fails the node fast at run time", async () => {
    const { ctx } = fakeBase();
    let calls = 0;
    const wf = workflow("retry-smuggled")
      .setup(async () => ({}))
      .action("a", async (_c, s) => {
        calls += 1;
        return s;
      })
      .build();
    (wf.nodes[0] as { retry?: unknown }).retry = { attempts: Infinity, reason: "r" };
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(calls).toBe(0); // never looped
    expect((res.error as Error).message).toMatch(/attempts must be an integer >= 2/);
  });

  it("a check failure never replays a prior action (§17 #7) — fail-stop, no re-run", async () => {
    const { ctx } = fakeBase();
    let actionRuns = 0;
    const wf = workflow("no-replay")
      .setup(async () => ({}))
      .action("side-effect", async (_c, s) => {
        actionRuns += 1;
        return s;
      })
      .check("verify", async (c) => c.fail("not what we wanted"))
      .build();
    const res = await runWorkflow(wf, ctx);
    expect(res.status).toBe("failed");
    expect(actionRuns).toBe(1); // the action ran exactly once — the check's failure did not replay it
  });

  it("retry intent is projectable: projected call/action carry {attempts, delay, reason}", () => {
    const ref = fakeRef<void>("c", "case", "wf-retry", "GET /x");
    const wf = workflow("retry-proj")
      .call("fetch", ref, { retry: { attempts: 3, delay: 50, reason: "GET is idempotent" } })
      .action("act", async (_c, s) => s, {
        retry: { attempts: 2, reason: "token mint is replay-safe" },
      })
      .build();
    const proj = projectWorkflow(wf);
    expect(proj.nodes[0].retry).toEqual({ attempts: 3, delay: 50, reason: "GET is idempotent" });
    expect(proj.nodes[1].retry).toEqual({ attempts: 2, reason: "token mint is replay-safe" });
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
