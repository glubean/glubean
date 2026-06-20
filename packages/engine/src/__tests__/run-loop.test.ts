import { describe, it, expect } from "vitest";

import { createAlsCarrier } from "@glubean/sdk/internal";

import { RunnerCore } from "../engine.js";
import type { RunnerServices, StepDef, TestDef } from "../types.js";

function services(fetchImpl?: RunnerServices["fetch"]): RunnerServices {
  return {
    fetch:
      fetchImpl ??
      (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
    env: { vars: () => ({}), secrets: () => ({}) },
    events: { emit: () => {} },
    scheduler: { now: () => 0 },
    carrier: createAlsCarrier(),
  };
}

// Narrow run-loop behavior (Stage 1 scope: simple + linear steps). The teardown
// case locks codex Decision-B P2 (teardown must run even on failure).
describe("engine run-loop — narrow behavior", () => {
  it("steps: setup → steps (state threads) → teardown, in order", async () => {
    const order: string[] = [];
    const def: TestDef = {
      meta: { id: "t" },
      type: "steps",
      setup: () => {
        order.push("setup");
        return { n: 1 };
      },
      steps: [
        {
          meta: { name: "s1" },
          fn: (_c, s) => {
            order.push("s1");
            return { n: (s as { n: number }).n + 1 };
          },
        },
        {
          meta: { name: "s2" },
          fn: (c, s) => {
            order.push("s2");
            (c.expect((s as { n: number }).n) as { toBe(v: number): void }).toBe(2);
          },
        },
      ],
      teardown: () => {
        order.push("teardown");
      },
    };
    const r = await new RunnerCore(services()).run(def);
    expect(order).toEqual(["setup", "s1", "s2", "teardown"]);
    expect(r.status).toBe("ok");
    expect(r.assertions).toEqual({ total: 1, passed: 1 });
  });

  it("teardown runs even when a step throws (codex Decision-B P2)", async () => {
    let toreDown = false;
    const def: TestDef = {
      meta: { id: "t" },
      type: "steps",
      steps: [
        {
          meta: { name: "boom" },
          fn: () => {
            throw new Error("boom");
          },
        },
      ],
      teardown: () => {
        toreDown = true;
      },
    };
    const r = await new RunnerCore(services()).run(def);
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/boom/);
    expect(toreDown).toBe(true);
  });

  it("teardown runs even when setup throws", async () => {
    let toreDown = false;
    const def: TestDef = {
      meta: { id: "t" },
      type: "steps",
      setup: () => {
        throw new Error("setup-failed");
      },
      steps: [{ meta: { name: "never" }, fn: () => undefined }],
      teardown: () => {
        toreDown = true;
      },
    };
    const r = await new RunnerCore(services()).run(def);
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/setup-failed/);
    expect(toreDown).toBe(true);
  });

  it("simple: a failed assertion makes the run error", async () => {
    const def: TestDef = {
      meta: { id: "t" },
      type: "simple",
      fn: (c) => {
        (c.expect(1) as { toBe(v: number): void }).toBe(2);
      },
    };
    const r = await new RunnerCore(services()).run(def);
    expect(r.status).toBe("error");
    expect(r.assertions).toEqual({ total: 1, passed: 0 });
  });

  it("stops subsequent steps after a soft assertion failure; teardown still runs (codex engine P2)", async () => {
    const ran: string[] = [];
    let toreDown = false;
    const def: TestDef = {
      meta: { id: "t" },
      type: "steps",
      steps: [
        {
          meta: { name: "s1" },
          fn: (c) => {
            ran.push("s1");
            (c.expect(1) as { toBe(v: number): void }).toBe(2); // soft failure, no throw
          },
        },
        { meta: { name: "s2" }, fn: () => void ran.push("s2") },
      ],
      teardown: () => {
        toreDown = true;
      },
    };
    const r = await new RunnerCore(services()).run(def);
    expect(r.status).toBe("error");
    expect(ran).toEqual(["s1"]); // s2 skipped after s1's soft failure
    expect(toreDown).toBe(true);
  });

  it("does not retry by default (node parity: retry 0) (codex engine P2)", async () => {
    let calls = 0;
    const svc = services(async () => {
      calls += 1;
      throw new TypeError("netfail");
    });
    const def: TestDef = {
      meta: { id: "t" },
      type: "simple",
      fn: async (c) => {
        await c.http.get("https://x.test/a");
      },
    };
    const r = await new RunnerCore(svc).run(def);
    expect(r.status).toBe("error");
    expect(calls).toBe(1); // ky did not retry the failed GET
  });

  it("extend(callback) maps prefixUrl in the function form too (codex engine P2)", async () => {
    let seenUrl = "";
    const svc = services(async (input) => {
      seenUrl = typeof input === "object" && "url" in input ? (input as Request).url : String(input);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const def: TestDef = {
      meta: { id: "t" },
      type: "simple",
      fn: async (c) => {
        const api = c.http.extend(() => ({ prefixUrl: "https://base.test/p" }));
        await api.get("x");
      },
    };
    const r = await new RunnerCore(svc).run(def);
    expect(r.status).toBe("ok");
    expect(seenUrl).toBe("https://base.test/p/x");
  });
});

// ScopeInput.signal: the engine hands the abort signal to ky (cancels in-flight HTTP)
// and checks it between steps + during its own waits (poll interval, retry backoff),
// so an aborted run stops promptly instead of running its residual poll/HTTP out. The
// load runner uses this to truly kill continuation tails the drain phase abandons.
describe("engine run-loop — abort (ScopeInput.signal)", () => {
  /** A fetch that never resolves on its own — it only ever rejects when the request's
   *  signal aborts (so a run that doesn't abort would hang). */
  const hangingFetch: RunnerServices["fetch"] = (input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const req = input instanceof Request ? input : new Request(input as string, init);
      const signal = req.signal;
      const fail = () => reject(new DOMException("The operation was aborted", "AbortError"));
      if (signal?.aborted) return fail();
      signal?.addEventListener("abort", fail, { once: true });
    });

  it("cancels an in-flight HTTP request when the signal aborts", async () => {
    const controller = new AbortController();
    const def: TestDef = {
      meta: { id: "t" },
      type: "simple",
      fn: async (ctx) => {
        await ctx.http.get("https://api.test/hang").json();
      },
    };
    const started = Date.now();
    const runP = new RunnerCore(services(hangingFetch)).run(def, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const r = await runP;
    // The aborted request rejected → propagated as a throw → error verdict. Crucially
    // the run RESOLVED (didn't hang on the never-resolving fetch).
    expect(r.status).toBe("error");
    expect(r.threw).toBe(true);
    expect(`${r.error ?? ""} ${r.errorName ?? ""}`).toMatch(/abort/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("composes a Request's own abort signal with the run signal (Request-level abort still works)", async () => {
    // codex r4 P2: ctx.http.get(new Request(url, { signal })) under a run-level signal must
    // keep the caller's Request-level abort working — inject must compose, not replace it.
    const runController = new AbortController();
    const userController = new AbortController();
    const def: TestDef = {
      meta: { id: "t" },
      type: "simple",
      fn: async (ctx) => {
        const req = new Request("https://api.test/hang", { signal: userController.signal });
        await ctx.http.get(req).json();
      },
    };
    const started = Date.now();
    const runP = new RunnerCore(services(hangingFetch)).run(def, { signal: runController.signal });
    // Abort via the USER's Request signal (NOT the run signal) — it must still cancel.
    setTimeout(() => userController.abort(), 20);
    const r = await runP;
    expect(r.status).toBe("error");
    expect(`${r.error ?? ""} ${r.errorName ?? ""}`).toMatch(/abort/i);
    expect(Date.now() - started).toBeLessThan(2000); // the user's Request signal aborted it
  });

  it("wakes a poll's inter-attempt wait and stops the tail at once", async () => {
    // Frozen clock (services.now() === 0) + no poll timeout → the poll never self-expires;
    // its 5s `every` wait can only be cut short by the abort, which proves the wait woke.
    const controller = new AbortController();
    let attempts = 0;
    const pollStep = {
      meta: { name: "wait-for-done" },
      fn: () => undefined,
      poll: {
        fn: () => {
          attempts += 1;
          return { done: false };
        },
        until: (_c: unknown, res: unknown) => (res as { done: boolean }).done, // never satisfied
        every: 5000,
      },
    } as unknown as StepDef;
    const def: TestDef = { meta: { id: "t" }, type: "steps", steps: [pollStep] };
    const started = Date.now();
    const runP = new RunnerCore(services()).run(def, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const r = await runP;
    const elapsed = Date.now() - started;
    expect(r.status).toBe("error"); // aborted poll → failed step
    expect(attempts).toBe(1); // one attempt ran, then it aborted during the 5s wait
    expect(elapsed).toBeLessThan(2000); // ≪ the 5000ms `every` — the wait was interrupted
  });

  it("does not run a retry once aborted during the backoff (the failed attempt stands)", async () => {
    // codex r1 P2: an abort that wakes the retry backoff must NOT let the next attempt
    // run — else post-abort user code executes and a passing retry overwrites the failure.
    const controller = new AbortController();
    let calls = 0;
    const retryStep = {
      meta: { name: "flaky", retries: 3, retryDelay: 5000 },
      fn: (ctx: { assert(c: unknown, m?: string): void }) => {
        calls += 1;
        // Attempt 1 fails; a retry (if it ran) would pass — but the abort during the 5s
        // backoff must stop it, so the step stays failed and `calls` never reaches 2.
        ctx.assert(calls > 1, "first attempt fails");
      },
    } as unknown as StepDef;
    const def: TestDef = { meta: { id: "t" }, type: "steps", steps: [retryStep] };
    const started = Date.now();
    const runP = new RunnerCore(services()).run(def, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const r = await runP;
    expect(calls).toBe(1); // the retry never ran
    expect(r.status).toBe("error"); // the failed attempt stands — not overwritten by a pass
    expect(Date.now() - started).toBeLessThan(2000); // ≪ the 5000ms retryDelay
  });

  it("reports error when aborted during a final step's non-cancellable async (no later step skipped)", async () => {
    // codex r2 P2: abort during the ONLY step's opaque async (uncancellable) — the step
    // runs to completion and no later step is skipped, yet the run must NOT report ok.
    const controller = new AbortController();
    const def: TestDef = {
      meta: { id: "t" },
      type: "steps",
      steps: [
        {
          meta: { name: "tail" },
          fn: async () => { await new Promise((r) => setTimeout(r, 50)); }, // opaque, uncancellable
        },
      ],
    };
    const runP = new RunnerCore(services()).run(def, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const r = await runP;
    expect(r.status).toBe("error"); // aborted mid-flight, even though the step completed
    expect(r.error ?? "").toMatch(/abort/i);
  });

  it("reports error when a simple test body is aborted mid non-cancellable async", async () => {
    const controller = new AbortController();
    const def: TestDef = {
      meta: { id: "t" },
      type: "simple",
      fn: async () => { await new Promise((r) => setTimeout(r, 50)); },
    };
    const runP = new RunnerCore(services()).run(def, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const r = await runP;
    expect(r.status).toBe("error");
    expect(r.error ?? "").toMatch(/abort/i);
  });

  it("reports error (not ok) when an abort skipped the rest after a step passed", async () => {
    // codex r2 P2: a steps run whose earlier steps PASSED but whose remaining steps were
    // skipped by the abort must NOT report ok — the run did not complete normally.
    const controller = new AbortController();
    const ran: string[] = [];
    const def: TestDef = {
      meta: { id: "t" },
      type: "steps",
      steps: [
        { meta: { name: "s1" }, fn: () => { ran.push("s1"); controller.abort(); } }, // passes, then aborts
        { meta: { name: "s2" }, fn: () => { ran.push("s2"); } },
      ],
    };
    const r = await new RunnerCore(services()).run(def, { signal: controller.signal });
    expect(ran).toEqual(["s1"]); // s2 was skipped by the abort
    expect(r.status).toBe("error"); // NOT "ok" despite s1 passing
    expect(r.error ?? "").toMatch(/abort/i);
  });

  it("a pre-aborted steps run skips setup, steps, and teardown — and reports error", async () => {
    // codex r3 P2: a signal already aborted before the run must run NOTHING (no setup
    // side effects) and must not report ok.
    const controller = new AbortController();
    controller.abort();
    const ran: string[] = [];
    const def: TestDef = {
      meta: { id: "t" },
      type: "steps",
      setup: () => { ran.push("setup"); },
      steps: [{ meta: { name: "s1" }, fn: () => { ran.push("s1"); } }],
      teardown: () => { ran.push("teardown"); },
    };
    const r = await new RunnerCore(services()).run(def, { signal: controller.signal });
    expect(ran).toEqual([]); // setup / steps / teardown all skipped
    expect(r.status).toBe("error");
    expect(r.error ?? "").toMatch(/abort/i);
  });

  it("a pre-aborted simple test does not run its body and reports error", async () => {
    // codex r3 P2: the simple-test path had no abort guard at all.
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    const def: TestDef = {
      meta: { id: "t" },
      type: "simple",
      fn: () => { ran = true; },
    };
    const r = await new RunnerCore(services()).run(def, { signal: controller.signal });
    expect(ran).toBe(false);
    expect(r.status).toBe("error");
    expect(r.error ?? "").toMatch(/abort/i);
  });

  it("skips remaining steps once aborted (no new step starts)", async () => {
    const controller = new AbortController();
    const ran: string[] = [];
    const def: TestDef = {
      meta: { id: "t" },
      type: "steps",
      steps: [
        {
          meta: { name: "s1" },
          fn: async (ctx) => {
            ran.push("s1");
            controller.abort(); // abort mid-run, between this step and the next
            await ctx.http.get("https://api.test/hang").json();
          },
        },
        { meta: { name: "s2" }, fn: () => { ran.push("s2"); } },
      ],
    };
    const r = await new RunnerCore(services(hangingFetch)).run(def, { signal: controller.signal });
    expect(r.status).toBe("error");
    expect(ran).toEqual(["s1"]); // s2 never started — the run was aborted
  });
});
