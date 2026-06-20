import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

import { feeder, loadRunner, loadScenario } from "@glubean/sdk/load";
import type { FeederBinding } from "@glubean/sdk/load";

import { rampDelayMs, runLoad } from "./orchestrator.js";

// M3-f end-to-end: the local closed-model orchestrator drives a loadRunner() plan
// to a finalized LoadArtifact against a REAL local mock server (network is never
// the bottleneck). Covers iterations/duration termination, concurrency, feeder
// allocation, copy-on-write session isolation, the per-iteration error boundary,
// the rampUp code path, and the mix / no-bound guards.

let server: Server;
let base: string;
/** Captures the `x-glubean-route` header value the SERVER received on the last request
 *  (to assert the engine strips this internal load metadata before the wire). */
let lastRouteHeader: string | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    lastRouteHeader = req.headers["x-glubean-route"] as string | undefined;
    const url = new URL(req.url ?? "/", "http://localhost");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && url.pathname === "/orders") {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ orderId: "o-1" }));
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/items/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: url.pathname.slice("/items/".length), name: "widget" }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : addr}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** browse→checkout scenario driven by `ctx.input.sku`. */
function browseCheckout() {
  return loadScenario<{ sku: string }>("browse-checkout")
    .step("browse", async (ctx) => {
      const item = (await ctx.http.get(`${base}/items/${ctx.input.sku}`).json()) as { name: string };
      ctx.expect(item.name).toBe("widget");
    })
    .step("checkout", async (ctx) => {
      const order = (await ctx.http.post(`${base}/orders`, { json: {} }).json()) as { orderId: string };
      ctx.expect(order.orderId).toBe("o-1");
    })
    .build();
}

describe("rampDelayMs", () => {
  it("spreads slots across [0, rampUp] with the last slot at the full window", () => {
    // concurrency reaches its full value at `rampUp`, not earlier.
    expect(rampDelayMs(0, 3, 60_000)).toBe(0);
    expect(rampDelayMs(1, 3, 60_000)).toBe(30_000);
    expect(rampDelayMs(2, 3, 60_000)).toBe(60_000); // last slot at the end of the window
    expect(rampDelayMs(1, 2, 60_000)).toBe(60_000); // concurrency 2 → full at 60s, not 30s
  });

  it("is zero for a single slot or no ramp", () => {
    expect(rampDelayMs(0, 1, 60_000)).toBe(0);
    expect(rampDelayMs(3, 4, 0)).toBe(0);
  });
});

describe("runLoad — local closed-model orchestrator (M3-f)", () => {
  it("runs an iterations-bounded plan to a complete LoadArtifact", async () => {
    const plan = loadRunner("checkout-load", {
      scenario: browseCheckout(),
      concurrency: 2,
      iterations: 6,
      input: ({ iteration }) => ({ sku: String(iteration.index) }),
    });

    const art = await runLoad(plan);

    // Termination + config provenance.
    expect(art.schemaVersion).toBe("glubean.load.v1");
    expect(art.runMode).toBe("load");
    expect(art.config).toMatchObject({ concurrency: 2, iterations: 6 });
    expect(art.runtime).toMatchObject({
      engine: "local",
      processModel: "single-process-async-producer-slot",
      executionModel: "closed-back-to-back",
      requestedConcurrency: 2,
    });
    expect(art.summary.pass).toBe(true);

    // Exactly 6 iterations, all successful.
    expect(art.summary.totalIterations).toBe(6);
    expect(art.summary.successfulIterations).toBe(6);
    expect(art.summary.failedIterations).toBe(0);

    // Scenario + steps + endpoints (ids collapsed to :id by M3-e).
    expect(art.scenarios).toHaveLength(1);
    expect(art.scenarios[0]).toMatchObject({ scenarioId: "browse-checkout", iterations: 6 });
    const steps = Object.fromEntries(art.steps.map((s) => [s.stepName, s.invocationCount]));
    expect(steps).toEqual({ browse: 6, checkout: 6 });
    const endpoints = Object.fromEntries(art.endpoints.map((e) => [e.routeKey, e.requestCount]));
    expect(endpoints).toEqual({ "GET /items/:id": 6, "POST /orders": 6 });
  });

  it("runs a duration-bounded plan (terminates on wall-clock)", async () => {
    const plan = loadRunner("tick", {
      scenario: loadScenario("tick").step("noop", async () => {}).build(),
      concurrency: 1,
      duration: 30, // ms
    });

    const art = await runLoad(plan);
    expect(art.config.durationMs).toBe(30);
    expect(art.summary.pass).toBe(true);
    expect(art.summary.totalIterations).toBeGreaterThanOrEqual(1);
    expect(art.summary.failedIterations).toBe(0);
  });

  it("allocates a distinct feeder row per iteration into function-form input", async () => {
    const seen: string[] = [];
    const scenario = loadScenario<{ sku: string }>("feeder-flow")
      .step("browse", async (ctx) => {
        seen.push(ctx.input.sku);
        await ctx.http.get(`${base}/items/${ctx.input.sku}`).json();
      })
      .build();

    const users = feeder.fromArray(
      [{ userId: "u0" }, { userId: "u1" }, { userId: "u2" }],
      { key: "userId" },
    );
    const plan = loadRunner("feeder-load", {
      scenario,
      concurrency: 1, // deterministic order
      iterations: 3,
      feeders: { user: users.uniquePerIteration() },
      input: ({ feed }) => ({ sku: (feed.user as { userId: string }).userId }),
    });

    const art = await runLoad(plan);
    expect(art.summary.successfulIterations).toBe(3);
    expect(seen).toEqual(["u0", "u1", "u2"]); // each iteration drew a distinct row
  });

  it("gives each iteration a copy-on-write session (base copied in, no leakage)", async () => {
    const scenario = loadScenario("cow")
      .step("check", async (ctx) => {
        // Base session value is present...
        ctx.expect(ctx.session.get("tenant")).toBe("acme");
        // ...and no mutation leaked from a prior iteration.
        ctx.expect(ctx.session.get("mutated")).toBeUndefined();
        ctx.session.set("mutated", true);
      })
      .build();

    const plan = loadRunner("cow-load", {
      scenario,
      concurrency: 1,
      iterations: 3,
    });

    const art = await runLoad(plan, { baseSession: { tenant: "acme" } });
    // All 3 pass ⇒ every iteration saw the base value AND a fresh (un-mutated) session.
    expect(art.summary.successfulIterations).toBe(3);
    expect(art.summary.failedIterations).toBe(0);
  });

  it("error boundary: failing iterations are counted, the run still completes", async () => {
    // sku = iteration index; assert it is odd → even iterations fail softly.
    const scenario = loadScenario<{ sku: string }>("flaky")
      .step("browse", async (ctx) => {
        await ctx.http.get(`${base}/items/${ctx.input.sku}`).json();
        ctx.expect(Number(ctx.input.sku) % 2).toBe(1);
      })
      .build();

    const plan = loadRunner("flaky-load", {
      scenario,
      concurrency: 1,
      iterations: 4, // sku 0,1,2,3 → 0 and 2 fail
      input: ({ iteration }) => ({ sku: String(iteration.index) }),
    });

    const art = await runLoad(plan);
    expect(art.summary.totalIterations).toBe(4);
    expect(art.summary.successfulIterations).toBe(2);
    expect(art.summary.failedIterations).toBe(2);
    // GET still ran for every iteration (the failing assertion is after the request).
    expect(art.endpoints.find((e) => e.method === "GET")?.requestCount).toBe(4);
  });

  it("runs the rampUp code path (staggered slot starts)", async () => {
    const plan = loadRunner("ramped", {
      scenario: browseCheckout(),
      concurrency: 2,
      iterations: 4,
      rampUp: "100ms",
      input: ({ iteration }) => ({ sku: String(iteration.index) }),
    });

    const art = await runLoad(plan);
    expect(art.summary.totalIterations).toBe(4);
    expect(art.config.rampUpMs).toBe(100);
  });

  it("deeply isolates nested base-session values per iteration", async () => {
    const scenario = loadScenario("nested-cow")
      .step("check", async (ctx) => {
        const cart = ctx.session.get("cart") as { items: string[] };
        ctx.expect(cart.items).toHaveLength(0); // fresh per iteration (deep clone)
        cart.items.push("widget"); // mutate this iteration's copy only
      })
      .build();

    const plan = loadRunner("nested-cow-load", {
      scenario,
      concurrency: 1,
      iterations: 3,
    });

    const art = await runLoad(plan, { baseSession: { cart: { items: [] } } });
    // If the nested `cart` were shared, iterations 2+ would see items.length 1 → fail.
    expect(art.summary.successfulIterations).toBe(3);
  });

  it("does not block on ramp-up / think-time once the bound is met", async () => {
    // A single iteration with a huge ramp-up + think-time: slots 1..3 ramp in but
    // claim nothing, and there's no think-time after the last iteration. Cancellable
    // timers must wake instantly at run-end — otherwise this would hang for minutes.
    const plan = loadRunner("burst", {
      scenario: loadScenario("burst").step("noop", async () => {}).build(),
      concurrency: 4,
      iterations: 1,
      rampUp: "10m",
      pacing: { thinkTime: "60s" },
    });

    const art = await runLoad(plan);
    expect(art.summary.totalIterations).toBe(1);
    expect(art.summary.successfulIterations).toBe(1);
  });

  it("reports a paced run as `closed-paced`", async () => {
    const plan = loadRunner("paced", {
      scenario: loadScenario("paced").step("noop", async () => {}).build(),
      concurrency: 1,
      iterations: 1, // think-time after the only iteration is skipped (run already ended)
      pacing: { thinkTime: "5s" },
    });

    const art = await runLoad(plan);
    expect(art.runtime.executionModel).toBe("closed-paced");
    expect(art.config.pacing?.thinkTimeMs).toBe(5000);
  });

  it("terminates a duration run even under a frozen clock (deadline timer)", async () => {
    const plan = loadRunner("frozen", {
      scenario: browseCheckout(), // real HTTP yields to the event loop each iteration
      concurrency: 1,
      duration: 15, // ms — the real deadline timer must stop the run
      input: ({ iteration }) => ({ sku: String(iteration.index) }),
    });

    // A frozen clock never advances, so `durationExpired()` stays false; only the
    // deadline timer's `markEnded()` (+ the `ended` check) can stop the loop. The
    // HTTP awaits yield to the event loop so the macrotask timer can fire.
    const art = await runLoad(plan, { now: () => 1000 });
    expect(art.summary.totalIterations).toBeGreaterThanOrEqual(1);
    expect(art.summary.pass).toBe(true);
  });

  it("evaluates thresholds and refines summary.pass (M4-a)", async () => {
    const plan = loadRunner("thresholded", {
      scenario: browseCheckout(),
      concurrency: 1,
      iterations: 4,
      input: ({ iteration }) => ({ sku: String(iteration.index) }),
      thresholds: {
        transaction: { errorRate: "<1%" }, // all succeed → 0% < 1% → pass
        endpoints: { "GET /items/:id": { p95: "<60s" } }, // generous → pass
      },
    });

    const art = await runLoad(plan);
    expect(art.summary.pass).toBe(true);
    expect(art.summary.thresholds.length).toBeGreaterThanOrEqual(2);
    expect(art.summary.thresholds.every((t) => t.pass)).toBe(true);
    expect(art.summary.thresholds.find((t) => t.scope === "transaction")).toMatchObject({
      metric: "errorRate",
      pass: true,
    });
  });

  it("fails summary.pass when a threshold is breached (M4-a)", async () => {
    const plan = loadRunner("breached", {
      scenario: browseCheckout(),
      concurrency: 1,
      iterations: 2,
      input: ({ iteration }) => ({ sku: String(iteration.index) }),
      // Impossible latency bound → breached.
      thresholds: { transaction: { p95: "<0ms" } },
    });

    const art = await runLoad(plan);
    expect(art.summary.pass).toBe(false);
    expect(art.summary.thresholds.find((t) => t.metric === "p95")?.pass).toBe(false);
  });

  it("runs a single-entry traffic-mix config (mix is supported)", async () => {
    const plan = loadRunner("mix", {
      concurrency: 1,
      iterations: 1,
      scenarios: [
        { id: "a", scenario: loadScenario("a").step("s", async () => {}).build(), weight: 1 },
      ],
    });
    const art = await runLoad(plan);
    expect(art.summary.totalIterations).toBe(1);
    expect(art.scenarios).toMatchObject([{ scenarioId: "a", scenarioRefId: "a", iterations: 1 }]);
  });

  it("rejects a plan with no termination bound", async () => {
    const plan = loadRunner("unbounded", {
      scenario: loadScenario("u").step("s", async () => {}).build(),
      concurrency: 1,
    });
    await expect(runLoad(plan)).rejects.toThrow(/termination bound/);
  });

  it("rejects an inverted think-time range", async () => {
    const plan = loadRunner("bad-pacing", {
      scenario: loadScenario("u").step("s", async () => {}).build(),
      concurrency: 1,
      iterations: 1,
      pacing: { thinkTime: { min: "10s", max: "1s" } },
    });
    await expect(runLoad(plan)).rejects.toThrow(/range is inverted/);
  });

  it("rejects a non-integer iteration count", async () => {
    const plan = loadRunner("bad-iters", {
      scenario: loadScenario("u").step("s", async () => {}).build(),
      concurrency: 1,
      iterations: Number.NaN,
    });
    await expect(runLoad(plan)).rejects.toThrow(/iterations must be a positive integer/);
  });

  it("contains a throwing feeder as a failed iteration (run still completes)", async () => {
    const exploding: FeederBinding = {
      __glubean_type: "load-feeder",
      strategy: "random",
      exhausted: "recycle",
      size: 1,
      allocate: () => {
        throw new Error("feeder boom");
      },
    };
    const plan = loadRunner("bad-feeder", {
      scenario: loadScenario("u").step("s", async () => {}).build(),
      concurrency: 1,
      iterations: 2,
      feeders: { bad: exploding },
      input: ({ feed }) => feed.bad,
    });

    const art = await runLoad(plan);
    // Both iterations recorded as setup failures; the run did NOT reject.
    expect(art.summary.totalIterations).toBe(2);
    expect(art.summary.failedIterations).toBe(2);
    expect(art.summary.successfulIterations).toBe(0);
  });
});

describe("runLoad — continuation config resolution (M6-a)", () => {
  const noop = () => loadScenario("noop").step("noop", async () => {}).build();

  it("records the continuation config ms-normalized with the default backlog policy", async () => {
    const plan = loadRunner("cont-cfg", {
      scenario: noop(),
      concurrency: 1,
      iterations: 1,
      continuation: { maxOutstanding: 5, maxConcurrent: 2, minPollInterval: "250ms", drainTimeout: "2s" },
    });
    const art = await runLoad(plan);
    expect(art.config.continuation).toEqual({
      maxOutstanding: 5,
      maxConcurrent: 2,
      minPollIntervalMs: 250,
      drainTimeoutMs: 2000,
      onBacklogFull: "block-producer", // defaulted
    });
  });

  it("omits continuation from the artifact config when unconfigured", async () => {
    const plan = loadRunner("no-cont", { scenario: noop(), concurrency: 1, iterations: 1 });
    const art = await runLoad(plan);
    expect(art.config.continuation).toBeUndefined();
  });

  it("rejects a non-positive continuation.maxOutstanding", async () => {
    const plan = loadRunner("bad-cont", {
      scenario: noop(),
      concurrency: 1,
      iterations: 1,
      continuation: { maxOutstanding: 0 },
    });
    await expect(runLoad(plan)).rejects.toThrow(/continuation\.maxOutstanding must be a positive integer/);
  });
});

describe("runLoad — producer release scheduling (M6-b)", () => {
  /** submit (POST, primary) → release the slot → poll (GET, continuation). */
  const asyncJob = () =>
    loadScenario("async-job")
      .step("submit", async (ctx) => {
        await ctx.http.post(`${base}/orders`, { json: {} }).json();
        await ctx.report.primaryComplete("submitted", { releaseProducerSlot: true });
      })
      .step("poll", async (ctx) => {
        await ctx.http.get(`${base}/items/1`).json();
      })
      .build();

  it("releases the slot per primary and drains every continuation to completion", async () => {
    const plan = loadRunner("async-job", { scenario: asyncJob(), concurrency: 1, iterations: 4 });
    const art = await runLoad(plan);
    // All 4 primary iterations started, released, and their continuations drained.
    expect(art.summary.totalIterations).toBe(4);
    expect(art.summary.successfulIterations).toBe(4);
    expect(art.summary.failedIterations).toBe(0);
    expect(art.summary.primary?.completed).toBe(4); // 4 measured boundaries
    // The POST is primary, the post-release GET is continuation.
    const epPhase = Object.fromEntries(art.endpoints.map((e) => [`${e.routeKey}@${e.phase}`, e]));
    expect(epPhase["POST /orders@primary"]?.requestCount).toBe(4);
    expect(epPhase["GET /items/:id@continuation"]?.requestCount).toBe(4);
    // The artifact reflects producer release (not a closed model).
    expect(art.runtime.slotModel).toBe("producer-released");
    expect(art.summary.continuation).toMatchObject({
      releasedProducerSlots: 4,
      primaryBoundaryCoverage: 1, // every iteration hit a boundary
      releaseCoverage: 1, // every boundary released
      rejectedReleaseSignals: 0,
      duplicateReleaseSignals: 0,
      abortedByDrainTimeout: 0,
      backlog: 0, // drained
    });
  });

  it("does not deadlock under a tight continuation backlog (block-producer back-pressure)", async () => {
    const plan = loadRunner("async-job", {
      scenario: asyncJob(),
      concurrency: 2,
      iterations: 6,
      continuation: { maxOutstanding: 1 }, // forces back-pressure, must still drain
    });
    const art = await runLoad(plan);
    expect(art.summary.totalIterations).toBe(6);
    expect(art.summary.successfulIterations).toBe(6);
    // Reaching the iterations cap must NOT cancel parked releases: the last primary
    // waits for backlog capacity normally, so there are no deadline rejections.
    expect(art.summary.continuation?.rejectedReleaseSignals).toBe(0);
    expect(art.summary.continuation?.releasedProducerSlots).toBe(6);
  });

  it("bounds the backlog by maxConcurrent even with no maxOutstanding set", async () => {
    // maxConcurrent alone must still bound the pool (it coincides with backlog here),
    // not leave release unbounded.
    const plan = loadRunner("async-job", {
      scenario: asyncJob(),
      concurrency: 2,
      iterations: 6,
      continuation: { maxConcurrent: 1 },
    });
    const art = await runLoad(plan);
    expect(art.summary.totalIterations).toBe(6);
    expect(art.summary.successfulIterations).toBe(6);
    expect(art.summary.continuation?.maxConcurrent).toBe(1);
  });

  it("aborts continuations that outlast the drain timeout instead of hanging", async () => {
    const plan = loadRunner("slow-job", {
      scenario: loadScenario("slow-job")
        .step("submit", async (ctx) => {
          await ctx.http.post(`${base}/orders`, { json: {} }).json();
          await ctx.report.primaryComplete("submitted", { releaseProducerSlot: true });
        })
        .step("poll", async () => {
          // Outlasts the 20ms drain timeout → the run must finalize without it.
          await new Promise((r) => setTimeout(r, 200));
        })
        .build(),
      concurrency: 1,
      iterations: 1,
      continuation: { drainTimeout: "20ms" },
    });
    const art = await runLoad(plan);
    expect(art.summary.primary?.completed).toBe(1); // primary still measured
    const c = art.summary.continuation!;
    expect(c.abortedByDrainTimeout).toBe(1);
    expect(art.runtime.continuationInFlight).toBe(1); // still in flight at finalize
    // Peak stays ≥ the live backlog (else backlog thresholds could read a too-low peak).
    expect(c.maxBacklog).toBeGreaterThanOrEqual(c.backlog);
    expect(c.maxConcurrent).toBeGreaterThanOrEqual(c.active);
  });

  it("does not overrun the run deadline when a slot is parked on a full backlog", async () => {
    // duration-bounded, backlog=1, long continuations: the 2nd release parks on the
    // full backlog; the deadline must cancel that park (runDeadlineReached) so the
    // run finalizes near its bound instead of waiting out the 500ms continuations.
    // (If the deadline weren't honored, this test would hit the vitest timeout.)
    const plan = loadRunner("slow-job", {
      scenario: loadScenario("slow-job")
        .step("submit", async (ctx) => {
          await ctx.http.post(`${base}/orders`, { json: {} }).json();
          await ctx.report.primaryComplete("submitted", { releaseProducerSlot: true });
        })
        .step("poll", async () => {
          await new Promise((r) => setTimeout(r, 500));
        })
        .build(),
      concurrency: 1,
      duration: "40ms",
      continuation: { maxOutstanding: 1, drainTimeout: "20ms" },
    });
    const started = Date.now();
    const art = await runLoad(plan);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(400); // bounded ≪ the 500ms continuation
    // A release was deadline-rejected, and the in-flight continuations were aborted.
    expect(art.summary.continuation?.rejectedReleaseSignals).toBeGreaterThanOrEqual(1);
    expect(art.summary.continuation?.abortedByDrainTimeout).toBeGreaterThanOrEqual(1);
  });

  it("does not hang an iterations-bounded run when a release parks behind a hung continuation", async () => {
    // No duration timer here — so a release parked on a full backlog (held by a
    // long continuation) must still be bounded by drainTimeout, or the run hangs.
    const plan = loadRunner("hung", {
      scenario: loadScenario("hung")
        .step("submit", async (ctx) => {
          await ctx.http.post(`${base}/orders`, { json: {} }).json();
          await ctx.report.primaryComplete("submitted", { releaseProducerSlot: true });
        })
        .step("poll", async () => {
          await new Promise((r) => setTimeout(r, 1000));
        })
        .build(),
      concurrency: 1,
      iterations: 2,
      continuation: { maxOutstanding: 1, drainTimeout: "25ms" },
    });
    const startedAt = Date.now();
    const art = await runLoad(plan);
    expect(Date.now() - startedAt).toBeLessThan(800); // bounded ≪ the 1000ms continuation
    expect(art.summary.primary?.completed).toBeGreaterThanOrEqual(1);
    expect(art.summary.continuation?.abortedByDrainTimeout).toBeGreaterThanOrEqual(1);
    // The drain-timeout (not a run deadline) cut the release off mid-run, so the breach
    // surfaces as a rejected release. (Its tail outlasts the drain window and is
    // abandoned, so it's counted as in-flight/aborted rather than a recorded failure;
    // a tail that DOES settle is recorded as failed — see execute-iteration.test.ts.)
    expect(art.summary.continuation?.rejectedReleaseSignals).toBeGreaterThanOrEqual(1);
  });

  it("a duration deadline cancels a release parked after the iterations cap (both bounds, no drainTimeout)", async () => {
    // With BOTH iterations and duration set and NO drainTimeout, the iterations cap
    // ends the run first; a later release parks on the full backlog. The duration
    // deadline must still cancel that parked admit — otherwise the run hangs forever
    // (the slot never unblocks). The continuations are self-bounded (~80ms), so the
    // drain finishes naturally; the point is the run COMPLETES at all.
    const plan = loadRunner("both-bounds", {
      scenario: loadScenario("both-bounds")
        .step("submit", async (ctx) => {
          await ctx.http.post(`${base}/orders`, { json: {} }).json();
          await ctx.report.primaryComplete("submitted", { releaseProducerSlot: true });
        })
        .step("poll", async () => {
          await new Promise((r) => setTimeout(r, 80));
        })
        .build(),
      concurrency: 1,
      iterations: 2,
      duration: "25ms",
      continuation: { maxOutstanding: 1 }, // NO drainTimeout
    });
    const startedAt = Date.now();
    const art = await runLoad(plan);
    expect(Date.now() - startedAt).toBeLessThan(2000); // completes (no infinite hang)
    expect(art.summary.continuation?.rejectedReleaseSignals).toBeGreaterThanOrEqual(1);
  });
});

describe("runLoad — long-poll advisory (M6-d)", () => {
  /** submit → poll-for-done, optionally marking / releasing the primary boundary. */
  const submitThenPoll = (boundary: "none" | "bare" | "release") =>
    loadScenario("async-job")
      .step("submit", async (ctx) => {
        await ctx.http.post(`${base}/orders`, { json: {} }).json();
        if (boundary === "bare") await ctx.report.primaryComplete("submitted");
        if (boundary === "release") await ctx.report.primaryComplete("submitted", { releaseProducerSlot: true });
      })
      .poll("await-done", async () => ({ done: true }), {
        until: (_c: unknown, r: { done: boolean }) => r.done,
        every: 1,
        maxAttempts: 1,
        timeout: 2000,
      })
      .build();

  it("advises when a long poll runs and the slot is never released (no primaryComplete)", async () => {
    const plan = loadRunner("async-job", { scenario: submitThenPoll("none"), concurrency: 1, iterations: 1 });
    const art = await runLoad(plan);
    expect(art.runtime.slotModel).toBe("end-to-end");
    expect(art.summary.advisories?.some((a) => a.includes("primaryComplete"))).toBe(true);
  });

  it("advises when release is called only AFTER the tail poll (misordered, slot held)", async () => {
    // submit → poll → primaryComplete(release): the release comes too late, the slot was
    // held for the whole poll. The advisory must fire (release belongs before the tail).
    const plan = loadRunner("late-release", {
      scenario: loadScenario("late-release")
        .step("submit", async (ctx) => {
          await ctx.http.post(`${base}/orders`, { json: {} }).json();
        })
        .poll("await-done", async () => ({ done: true }), {
          until: (_c: unknown, r: { done: boolean }) => r.done,
          every: 1,
          maxAttempts: 1,
          timeout: 2000,
        })
        .step("release-late", async (ctx) => {
          await ctx.report.primaryComplete("submitted", { releaseProducerSlot: true });
        })
        .build(),
      concurrency: 1,
      iterations: 1,
      continuation: { maxOutstanding: 4 },
    });
    const art = await runLoad(plan);
    expect(art.summary.advisories?.some((a) => a.includes("primaryComplete"))).toBe(true);
  });

  it("advises for a misordered late release even when the continuation is drain-abandoned", async () => {
    // submit → poll1 (held) → release → slow poll2 that outlasts drainTimeout (abandoned at
    // finalize, so its endIteration never runs). The advisory must still fire — poll1 held
    // the slot, and the check runs at release time, before the abandonment.
    const plan = loadRunner("late-release-abandoned", {
      scenario: loadScenario("late-release-abandoned")
        .step("submit", async (ctx) => {
          await ctx.http.post(`${base}/orders`, { json: {} }).json();
        })
        .poll("await-1", async () => ({ done: true }), {
          until: (_c: unknown, r: { done: boolean }) => r.done,
          every: 1,
          maxAttempts: 1,
          timeout: 2000,
        })
        .step("release", async (ctx) => {
          await ctx.report.primaryComplete("s", { releaseProducerSlot: true });
        })
        .poll(
          "await-2-slow",
          async () => {
            await new Promise((r) => setTimeout(r, 500)); // outlasts the 20ms drain timeout
            return { done: false };
          },
          { until: (_c: unknown, r: { done: boolean }) => r.done, every: 1, maxAttempts: 2, timeout: 1000 },
        )
        .build(),
      concurrency: 1,
      iterations: 1,
      continuation: { maxOutstanding: 4, drainTimeout: "20ms" },
    });
    const art = await runLoad(plan);
    expect(art.summary.advisories?.some((a) => a.includes("primaryComplete"))).toBe(true);
  });

  it("still advises for a bare primaryComplete that marks the phase but holds the slot", async () => {
    // P2: a bare primaryComplete records the boundary but does NOT release the slot,
    // so the tail still ties it up — the advisory must persist.
    const plan = loadRunner("async-job", { scenario: submitThenPoll("bare"), concurrency: 1, iterations: 1 });
    const art = await runLoad(plan);
    expect(art.runtime.slotModel).toBe("end-to-end-measured"); // boundary recorded, slot NOT released
    expect(art.summary.advisories?.some((a) => a.includes("primaryComplete"))).toBe(true);
  });

  it("advises for a bare primaryComplete tail poll even when a continuation request follows", async () => {
    // submit → bare primaryComplete (marks the phase but holds the slot) → poll → another
    // request. The post-boundary request is continuation; the slot was held through the
    // poll → advise (the bare primaryComplete should have been a releasing one).
    const plan = loadRunner("bare-pc-tail", {
      scenario: loadScenario("bare-pc-tail")
        .step("submit", async (ctx) => {
          await ctx.http.post(`${base}/orders`, { json: {} }).json();
          await ctx.report.primaryComplete("submitted"); // BARE — no releaseProducerSlot
        })
        .poll("await-done", async () => ({ done: true }), {
          until: (_c: unknown, r: { done: boolean }) => r.done,
          every: 1,
          maxAttempts: 1,
          timeout: 2000,
        })
        .step("fetch-result", async (ctx) => {
          await ctx.http.get(`${base}/items/1`).json(); // continuation request after the poll
        })
        .build(),
      concurrency: 1,
      iterations: 1,
    });
    const art = await runLoad(plan);
    expect(art.summary.advisories?.some((a) => a.includes("primaryComplete"))).toBe(true);
  });

  it("omits the advisory once the producer slot is released", async () => {
    const plan = loadRunner("async-job", { scenario: submitThenPoll("release"), concurrency: 1, iterations: 1 });
    const art = await runLoad(plan);
    expect(art.runtime.slotModel).toBe("producer-released");
    expect(art.summary.advisories).toBeUndefined();
  });

  it("advises for an unreleased tail-poll path even when a sibling iteration released", async () => {
    // iteration 0 releases; iteration 1 runs submit→poll with NO release. The run-wide
    // continuation summary exists (iter0 released), but the advisory must still fire for
    // the closed path (iter1) — gating is per-iteration, not artifact-wide.
    const plan = loadRunner("mixed", {
      input: ({ iteration }) => ({ release: iteration.index === 0 }),
      scenario: loadScenario<{ release: boolean }>("mixed")
        .step("submit", async (ctx) => {
          await ctx.http.post(`${base}/orders`, { json: {} }).json();
          if (ctx.input.release) await ctx.report.primaryComplete("s", { releaseProducerSlot: true });
        })
        .poll("await-done", async () => ({ done: true }), {
          until: (_c: unknown, r: { done: boolean }) => r.done,
          every: 1,
          maxAttempts: 1,
          timeout: 2000,
        })
        .build(),
      concurrency: 1,
      iterations: 2,
      continuation: { maxOutstanding: 4 },
    });
    const art = await runLoad(plan);
    expect(art.summary.continuation).toBeDefined(); // iter0 released → summary exists run-wide
    expect(art.summary.advisories?.some((a) => a.includes("primaryComplete"))).toBe(true); // iter1 still advised
  });

  it("omits the advisory when release was requested but rejected (already tried)", async () => {
    // concurrency 2 / maxOutstanding 1 / a slow continuation poll: one iteration's
    // release parks behind the other's held slot and is rejected (drain bound). The
    // user DID request release, so "call releaseProducerSlot" would be misleading — the
    // advisory must not fire even though no `producer:released` may have succeeded.
    const plan = loadRunner("async-job", {
      scenario: loadScenario("async-job")
        .step("submit", async (ctx) => {
          await ctx.http.post(`${base}/orders`, { json: {} }).json();
          await ctx.report.primaryComplete("submitted", { releaseProducerSlot: true });
        })
        .poll("await-done", async () => ({ done: false }), {
          until: (_c: unknown, r: { done: boolean }) => r.done, // never satisfied → polls to timeout
          every: 5,
          timeout: 500,
        })
        .build(),
      concurrency: 2,
      duration: "40ms",
      continuation: { maxOutstanding: 1, drainTimeout: "15ms" },
    });
    const art = await runLoad(plan);
    expect(art.summary.continuation).toBeDefined(); // release WAS requested (some rejected)
    expect(art.summary.continuation?.rejectedReleaseSignals).toBeGreaterThanOrEqual(1);
    expect(art.summary.advisories).toBeUndefined();
  });

  it("omits the advisory for a scenario with no poll step", async () => {
    const plan = loadRunner("browse-checkout", {
      scenario: browseCheckout(),
      concurrency: 1,
      iterations: 1,
      input: { sku: "1" },
    });
    const art = await runLoad(plan);
    expect(art.summary.advisories).toBeUndefined();
  });

  it("omits the advisory when the poll is a readiness wait BEFORE the primary request", async () => {
    // The poll (step 0, a token/readiness wait that even makes its own request) runs
    // BEFORE the load-producing request (step 1). It's not a post-primary tail, so the
    // advisory must not fire — releasing after the later request wouldn't help.
    const plan = loadRunner("readiness-first", {
      scenario: loadScenario("readiness-first")
        .poll(
          "await-ready",
          async (ctx) => {
            const r = (await ctx.http.get(`${base}/items/1`).json()) as { name: string };
            return { ready: r.name === "widget" };
          },
          { until: (_c: unknown, r: { ready: boolean }) => r.ready, every: 1, maxAttempts: 1, timeout: 2000 },
        )
        .step("submit", async (ctx) => {
          await ctx.http.post(`${base}/orders`, { json: {} }).json();
        })
        .build(),
      concurrency: 1,
      iterations: 1,
    });
    const art = await runLoad(plan);
    expect(art.summary.advisories).toBeUndefined();
  });

  it("omits the advisory when an earlier failure means the poll never runs (P3)", async () => {
    // The poll is statically present but a hard throw in the first step aborts the
    // iteration before it — so no poll executes and the advisory must not fire.
    const plan = loadRunner("never-polls", {
      scenario: loadScenario("never-polls")
        .step("boom", async () => {
          throw new Error("fails before the poll");
        })
        .poll("await-done", async () => ({ done: true }), {
          until: (_c: unknown, r: { done: boolean }) => r.done,
          every: 1,
          maxAttempts: 1,
          timeout: 2000,
        })
        .build(),
      concurrency: 1,
      iterations: 1,
    });
    const art = await runLoad(plan);
    expect(art.summary.failedIterations).toBe(1); // the throw failed the iteration
    expect(art.summary.advisories).toBeUndefined(); // poll never executed → no advisory
  });

  it("omits the advisory when a setup request precedes a readiness poll before the load", async () => {
    // setup/auth request (step 0) → readiness poll (step 1) → submit (step 2). A request
    // (the real load) FOLLOWS the poll, so it's not a post-primary tail — no advisory,
    // even though the setup request preceded it.
    const plan = loadRunner("setup-readiness", {
      scenario: loadScenario("setup-readiness")
        .step("auth", async (ctx) => {
          await ctx.http.get(`${base}/items/1`).json();
        })
        .poll(
          "await-ready",
          async (ctx) => {
            const r = (await ctx.http.get(`${base}/items/1`).json()) as { name: string };
            return { ready: r.name === "widget" };
          },
          { until: (_c: unknown, r: { ready: boolean }) => r.ready, every: 1, maxAttempts: 1, timeout: 2000 },
        )
        .step("submit", async (ctx) => {
          await ctx.http.post(`${base}/orders`, { json: {} }).json();
        })
        .build(),
      concurrency: 1,
      iterations: 1,
    });
    const art = await runLoad(plan);
    expect(art.summary.advisories).toBeUndefined();
  });
});

describe("runLoad — exact routeKey via X-Glubean-Route (M8)", () => {
  it("uses the context route template for an exact, non-heuristic endpoint key (never on the wire)", async () => {
    lastRouteHeader = "UNSET";
    const plan = loadRunner("exact-route", {
      scenario: loadScenario("exact-route")
        .step("get-item", async (ctx) => {
          // The route template rides on ky's non-wire `context`, never a header.
          await ctx.http.get(`${base}/items/42`, { context: { glubeanRoute: "GET /items/:id" } }).json();
        })
        .build(),
      concurrency: 1,
      iterations: 1,
    });
    const art = await runLoad(plan);
    const ep = art.endpoints.find((e) => e.routeKey === "GET /items/:id");
    expect(ep).toBeDefined();
    expect(ep!.routeKeySource).toBe("contract-metadata"); // exact, from the route context
    expect(ep!.routeKeyHeuristic).toBe(false);
    // The template never became a request header, so the SUT never saw it.
    expect(lastRouteHeader).toBeUndefined();
  });

  it("stays heuristic for a plain request with no route header", async () => {
    const plan = loadRunner("heuristic-route", {
      scenario: loadScenario("heuristic-route")
        .step("get-item", async (ctx) => {
          await ctx.http.get(`${base}/items/42`).json();
        })
        .build(),
      concurrency: 1,
      iterations: 1,
    });
    const art = await runLoad(plan);
    const ep = art.endpoints.find((e) => e.method === "GET");
    expect(ep).toBeDefined();
    expect(ep!.routeKey).toBe("GET /items/:id"); // normalized heuristically
    expect(ep!.routeKeySource).toBe("normalized-url");
    expect(ep!.routeKeyHeuristic).toBe(true);
  });
});

// Timeline: the artifact carries an over-time series (RPS / error-rate / latency /
// concurrency by window) so a consumer can draw the load curves.
describe("runLoad — timeline (over-time series)", () => {
  it("emits a dense time-series whose totals match the run", async () => {
    const plan = loadRunner("tl", { scenario: browseCheckout(), concurrency: 2, iterations: 6 });
    const art = await runLoad(plan);
    const tl = art.timeline;
    expect(tl).toBeDefined();
    expect(tl!.windowMs).toBeGreaterThan(0);
    expect(tl!.windows.length).toBeGreaterThanOrEqual(1);
    // Iterations summed across the windows == total iterations (count, timing-independent).
    expect(tl!.windows.reduce((s, w) => s + w.iterations, 0)).toBe(art.summary.totalIterations);
    // Requests summed across the windows == total requests (sum across endpoints).
    const totalReq = art.endpoints.reduce((s, e) => s + e.requestCount, 0);
    expect(tl!.windows.reduce((s, w) => s + w.requests, 0)).toBe(totalReq);
    // Dense: window offsets are contiguous multiples of windowMs (no x-axis gaps).
    tl!.windows.forEach((w, i) => expect(w.offsetMs).toBe(i * tl!.windowMs));
  });
});

// Latency distribution: the artifact carries fixed-ladder latency histograms (overall +
// per-endpoint) so a consumer can draw distribution / CDF charts comparable across runs.
describe("runLoad — latency distribution", () => {
  it("emits fixed-ladder latency histograms whose counts sum to the totals", async () => {
    const plan = loadRunner("dist", { scenario: browseCheckout(), concurrency: 2, iterations: 8 });
    const art = await runLoad(plan);
    // The overall transaction distribution covers every completed iteration.
    const sd = art.summary.latencyDistribution;
    expect(sd).toBeDefined();
    expect(sd!.reduce((s, b) => s + b.count, 0)).toBe(art.summary.totalIterations);
    // Each endpoint's distribution covers exactly that endpoint's requests.
    for (const e of art.endpoints) {
      expect(e.latencyDistribution).toBeDefined();
      expect(e.latencyDistribution!.reduce((s, b) => s + b.count, 0)).toBe(e.requestCount);
    }
  });
})

// Samples: the artifact keeps bounded failure-trace + slow-transaction samples (the
// "show me one" view) so a consumer can drill into the tail.
describe("runLoad — failure / slow samples", () => {
  it("captures failure traces with the failed step + observations", async () => {
    const scenario = loadScenario<{ sku: string }>("flaky")
      .step("check", async (ctx) => {
        const item = (await ctx.http.get(`${base}/items/${ctx.input.sku}`).json()) as { name: string };
        ctx.expect(item.name).toBe("NOPE"); // always fails → the iteration fails
      })
      .build();
    const plan = loadRunner("samples-fail", { scenario, concurrency: 1, iterations: 3, input: () => ({ sku: "1" }) });
    const art = await runLoad(plan);
    expect(art.summary.failedIterations).toBe(3);
    expect(art.samples.maxFailureTraces).toBeGreaterThan(0);
    expect(art.samples.failureTraces.length).toBeGreaterThan(0);
    const f = art.samples.failureTraces[0];
    expect(f.failedStepName).toBe("check");
    expect(f.observations.length).toBeGreaterThan(0); // the GET /items request + the failed assertion
    // The failed assertion's diagnostic operands survive the sink → reducer → collector path.
    const assertionObs = f.observations.find((o) => o.type === "assertion");
    expect(assertionObs).toBeDefined();
    expect((assertionObs as { expectedPreview?: unknown }).expectedPreview).toBe("NOPE");
  });

  it("captures slow-transaction samples for a successful run", async () => {
    const plan = loadRunner("samples-slow", { scenario: browseCheckout(), concurrency: 1, iterations: 4 });
    const art = await runLoad(plan);
    expect(art.samples.slowTransactions.length).toBeGreaterThan(0);
    expect(art.samples.slowTransactions.length).toBeLessThanOrEqual(art.summary.totalIterations);
    const t = art.samples.slowTransactions[0];
    expect(t.topEndpoints.length).toBeGreaterThan(0); // GET /items + POST /orders
    expect(t.slowStepName).toBeDefined();
  });

  it("honors a 0 report cap — disables that sample type", async () => {
    const plan = loadRunner("samples-off", { scenario: browseCheckout(), concurrency: 1, iterations: 3, report: { slowTransactionSummaries: 0 } });
    const art = await runLoad(plan);
    expect(art.samples.maxSlowTransactionSummaries).toBe(0);
    expect(art.samples.slowTransactions).toHaveLength(0);
  });

  it("rejects an invalid report sample cap", async () => {
    const plan = loadRunner("bad-cap", { scenario: browseCheckout(), concurrency: 1, iterations: 1, report: { failureTraces: 1.5 } });
    await expect(runLoad(plan)).rejects.toThrow(/report\.failureTraces must be a non-negative integer/);
  });
})

// Traffic mix: a `scenarios[]` plan runs multiple weighted scenarios in one run; each
// iteration picks one by weight (deterministic here via an injected RNG) and results are
// attributed per scenario via each entry's id (scenarioRefId).
describe("runLoad — traffic mix (weighted multi-scenario)", () => {
  /** Deterministic RNG cycling a fixed sequence — makes weighted selection reproducible. */
  function seqRandom(values: number[]): () => number {
    let i = 0;
    return () => values[i++ % values.length];
  }

  const browse = () =>
    loadScenario<{ sku: string }>("browse")
      .step("get-item", async (ctx) => {
        const item = (await ctx.http.get(`${base}/items/${ctx.input.sku}`).json()) as { name: string };
        ctx.expect(item.name).toBe("widget");
      })
      .build();
  const order = () =>
    loadScenario("order")
      .step("place", async (ctx) => {
        const o = (await ctx.http.post(`${base}/orders`, { json: {} }).json()) as { orderId: string };
        ctx.expect(o.orderId).toBe("o-1");
      })
      .build();

  it("splits iterations across scenarios by weight and attributes per-scenario results", async () => {
    const plan = loadRunner("mixed", {
      scenarios: [
        { id: "browse", scenario: browse(), weight: 75, input: () => ({ sku: "42" }) },
        { id: "order", scenario: order(), weight: 25 },
      ],
      concurrency: 1,
      iterations: 4,
    });
    // total weight 100 → r = random()*100; [0,75) browse, [75,100) order → 3 browse + 1 order.
    const art = await runLoad(plan, { random: seqRandom([0.1, 0.2, 0.5, 0.9]) });

    expect(art.summary.totalIterations).toBe(4);
    expect(art.summary.successfulIterations).toBe(4);
    const byRef = Object.fromEntries(art.scenarios.map((s) => [s.scenarioRefId, s]));
    expect(byRef.browse).toMatchObject({ scenarioId: "browse", iterations: 3, successfulIterations: 3 });
    expect(byRef.order).toMatchObject({ scenarioId: "order", iterations: 1, successfulIterations: 1 });
    // Per-entry input reached the right scenario: browse got sku=42 (→ GET /items/42, ×3),
    // order ran its POST once.
    expect(art.endpoints.find((e) => e.routeKey === "GET /items/:id")?.requestCount).toBe(3);
    expect(art.endpoints.find((e) => e.routeKey === "POST /orders")?.requestCount).toBe(1);
  });

  it("attributes the SAME scenario referenced by two entries under distinct ids", async () => {
    const plan = loadRunner("same-twice", {
      scenarios: [
        { id: "fast", scenario: browse(), weight: 50, input: () => ({ sku: "1" }) },
        { id: "slow", scenario: browse(), weight: 50, input: () => ({ sku: "2" }) },
      ],
      concurrency: 1,
      iterations: 2,
    });
    const art = await runLoad(plan, { random: seqRandom([0.1, 0.9]) }); // one each
    expect(art.scenarios).toHaveLength(2);
    expect(art.scenarios.map((s) => s.scenarioRefId).sort()).toEqual(["fast", "slow"]);
    expect(art.scenarios.every((s) => s.scenarioId === "browse")).toBe(true);
    expect(art.scenarios.find((s) => s.scenarioRefId === "fast")?.iterations).toBe(1);
    expect(art.scenarios.find((s) => s.scenarioRefId === "slow")?.iterations).toBe(1);
    // The flat top-level step rows carry the entry id too, so the two same-scenario entries
    // aren't indistinguishable (codex mix P2) — same scenarioId/stepName, distinct refs.
    expect(art.steps.map((s) => s.scenarioRefId).sort()).toEqual(["fast", "slow"]);
    expect(art.steps.every((s) => s.scenarioId === "browse" && s.stepName === "get-item")).toBe(true);
  });

  it("drives each mix entry's feeder by its OWN draw count, not the run-global index", async () => {
    // codex mix P2: an entry-local uniquePerIteration must index by how many times THIS
    // entry ran — else a later-selected entry over-indexes its rows and exhausts.
    const aRows = feeder.fromArray([{ v: "a0" }, { v: "a1" }], { key: "v" });
    const bRows = feeder.fromArray([{ v: "b0" }, { v: "b1" }], { key: "v" });
    const seen: string[] = [];
    const useRow = (id: string) => loadScenario<{ v: string }>(id).step("use", async () => {}).build();
    const plan = loadRunner("mix-feeders", {
      concurrency: 1,
      iterations: 4,
      scenarios: [
        {
          id: "a",
          scenario: useRow("a"),
          weight: 50,
          feeders: { row: aRows.uniquePerIteration() },
          input: ({ feed }) => { seen.push((feed.row as { v: string }).v); return feed.row; },
        },
        {
          id: "b",
          scenario: useRow("b"),
          weight: 50,
          feeders: { row: bRows.uniquePerIteration() },
          input: ({ feed }) => { seen.push((feed.row as { v: string }).v); return feed.row; },
        },
      ],
    });
    // Select A,B,A,B (0.1 → a, 0.9 → b at 50/50) — each entry draws its own row 0 then 1.
    const art = await runLoad(plan, { random: seqRandom([0.1, 0.9, 0.1, 0.9]) });
    expect(art.summary.totalIterations).toBe(4);
    expect(art.summary.failedIterations).toBe(0); // no feeder exhaustion (the bug exhausted at idx 3)
    expect(seen.sort()).toEqual(["a0", "a1", "b0", "b1"]); // each entry drew its own rows in order
  });

  it("draws a SHARED top-level feeder by run-global index (distinct rows across the mix)", async () => {
    // codex mix P2: a shared uniquePerIteration must consume distinct rows run-wide — A then
    // B must NOT both draw row 0 (that's the per-entry behavior, wrong for a shared feeder).
    const shared = feeder.fromArray([{ v: "s0" }, { v: "s1" }, { v: "s2" }, { v: "s3" }], { key: "v" });
    const seen: string[] = [];
    const useShared = (id: string) => loadScenario<{ v: string }>(id).step("use", async () => {}).build();
    const plan = loadRunner("mix-shared", {
      concurrency: 1,
      iterations: 4,
      feeders: { row: shared.uniquePerIteration() }, // shared across every entry
      scenarios: [
        { id: "a", scenario: useShared("a"), weight: 50, input: ({ feed }) => { seen.push((feed.row as { v: string }).v); return feed.row; } },
        { id: "b", scenario: useShared("b"), weight: 50, input: ({ feed }) => { seen.push((feed.row as { v: string }).v); return feed.row; } },
      ],
    });
    const art = await runLoad(plan, { random: seqRandom([0.1, 0.9, 0.1, 0.9]) }); // A,B,A,B
    expect(art.summary.totalIterations).toBe(4);
    expect(art.summary.failedIterations).toBe(0);
    expect(seen.sort()).toEqual(["s0", "s1", "s2", "s3"]); // distinct rows, consumed run-globally
  });

  it("keeps an OVERRIDDEN shared feeder's draws contiguous (only some entries override it)", async () => {
    // codex mix P2: a shared feeder that only SOME entries override is drawn on the non-
    // overriding turns; it must index by its OWN draw count, not the run-global iteration
    // (which skips indices and exhausts). A,B,A,B with only B overriding `row`.
    const sharedRow = feeder.fromArray([{ v: "s0" }, { v: "s1" }], { key: "v" }); // 2 rows, fail on overrun
    const bRow = feeder.fromArray([{ v: "b0" }, { v: "b1" }], { key: "v" });
    const seen: string[] = [];
    const use = (id: string) => loadScenario<{ v: string }>(id).step("noop", async () => {}).build();
    const cap = ({ feed }: { feed: Record<string, unknown> }) => { seen.push((feed.row as { v: string }).v); return feed.row; };
    const plan = loadRunner("mix-partial-override", {
      concurrency: 1,
      iterations: 4,
      feeders: { row: sharedRow.uniquePerIteration() }, // shared across entries
      scenarios: [
        { id: "a", scenario: use("a"), weight: 50, input: cap }, // uses the shared `row`
        { id: "b", scenario: use("b"), weight: 50, feeders: { row: bRow.uniquePerIteration() }, input: cap }, // overrides `row`
      ],
    });
    const art = await runLoad(plan, { random: seqRandom([0.1, 0.9, 0.1, 0.9]) }); // A,B,A,B
    expect(art.summary.totalIterations).toBe(4);
    expect(art.summary.failedIterations).toBe(0); // shared feeder NOT exhausted (the bug hit row[2])
    expect(seen.sort()).toEqual(["b0", "b1", "s0", "s1"]); // shared rows contiguous, B's own rows distinct
  });

  it("scopes entry-local feeder draws per entry even when entries reuse the same binding object", async () => {
    // codex mix P2: a binding object reused under two entries' `feeders` is two LOGICAL slots
    // (each entry-local) — each must draw its OWN sequence, not share one (which exhausts).
    const rows = feeder.fromArray([{ v: "r0" }, { v: "r1" }], { key: "v" }).uniquePerIteration();
    const seen: string[] = [];
    const use = (id: string) => loadScenario<{ v: string }>(id).step("noop", async () => {}).build();
    const cap = ({ feed }: { feed: Record<string, unknown> }) => { seen.push((feed.row as { v: string }).v); return feed.row; };
    const plan = loadRunner("mix-reused-binding", {
      concurrency: 1,
      iterations: 4,
      scenarios: [
        { id: "a", scenario: use("a"), weight: 50, feeders: { row: rows }, input: cap }, // SAME binding object…
        { id: "b", scenario: use("b"), weight: 50, feeders: { row: rows }, input: cap }, // …reused under B
      ],
    });
    const art = await runLoad(plan, { random: seqRandom([0.1, 0.9, 0.1, 0.9]) }); // A,B,A,B
    expect(art.summary.totalIterations).toBe(4);
    expect(art.summary.failedIterations).toBe(0); // neither entry exhausts (each drew only twice)
    expect(seen.sort()).toEqual(["r0", "r0", "r1", "r1"]); // each entry drew its own row0 then row1
  });

  it("keeps two feeder names that reuse one binding independent (per-name draw sequence)", async () => {
    // codex mix P2: two top-level names assigned the SAME binding object are separate slots —
    // each must see its own draw index (the iteration index), not a shared counter that
    // advances between the two allocations within one iteration (a single-scenario regression).
    const rows = feeder.fromArray([{ v: "x0" }, { v: "x1" }], { key: "v" }).uniquePerIteration();
    const seenA: string[] = [];
    const seenB: string[] = [];
    const plan = loadRunner("dual-name", {
      concurrency: 1,
      iterations: 2,
      scenario: loadScenario("s").step("noop", async () => {}).build(),
      feeders: { a: rows, b: rows }, // SAME binding object under two names
      input: ({ feed }) => {
        seenA.push((feed.a as { v: string }).v);
        seenB.push((feed.b as { v: string }).v);
        return {};
      },
    });
    const art = await runLoad(plan);
    expect(art.summary.totalIterations).toBe(2);
    expect(art.summary.failedIterations).toBe(0); // neither name exhausts early
    expect(seenA).toEqual(["x0", "x1"]); // each name drew row0 then row1 by the iteration index…
    expect(seenB).toEqual(["x0", "x1"]); // …not interleaved across the two names
  });

  it("does not drop a feeder whose name shadows an Object.prototype property", async () => {
    // codex mix P2: `name in {}` is true for "toString"/"constructor", so the shared/entry
    // override filter must use an own-property check — else such feeders silently vanish
    // (this also affects single-scenario runs, which have no entry feeders).
    const rows = feeder.fromArray([{ v: "x" }], { key: "v" });
    let seenToString: unknown;
    const plan = loadRunner("proto-feeder", {
      concurrency: 1,
      iterations: 1,
      scenario: loadScenario("s").step("noop", async () => {}).build(),
      feeders: { toString: rows.uniquePerIteration() },
      input: ({ feed }) => { seenToString = (feed as Record<string, unknown>).toString; return {}; },
    });
    const art = await runLoad(plan);
    expect(art.summary.totalIterations).toBe(1);
    expect(art.summary.failedIterations).toBe(0);
    expect(seenToString).toEqual({ v: "x" }); // the feeder was drawn, not filtered out
  });

  it("keeps a configured mix entry that draws zero iterations in the artifact", async () => {
    // codex mix P2: a never-selected entry must still appear (configured, 0 iterations), and
    // the config records the mix composition + weights.
    const plan = loadRunner("mix-zero", {
      concurrency: 1,
      iterations: 2,
      scenarios: [
        { id: "hot", scenario: browse(), weight: 99, input: () => ({ sku: "42" }) },
        { id: "cold", scenario: order(), weight: 1 },
      ],
    });
    // total weight 100 → both draws < 99 pick "hot"; "cold" is never selected.
    const art = await runLoad(plan, { random: seqRandom([0.1, 0.2]) });
    expect(art.summary.totalIterations).toBe(2);
    const byRef = Object.fromEntries(art.scenarios.map((s) => [s.scenarioRefId, s]));
    expect(byRef.hot?.iterations).toBe(2);
    expect(byRef.cold).toBeDefined(); // present despite zero selections…
    expect(byRef.cold?.iterations).toBe(0); // …as a configured 0-iteration scenario
    expect(art.config.scenarios).toEqual([
      { scenarioRefId: "hot", scenarioId: "browse", weight: 99 },
      { scenarioRefId: "cold", scenarioId: "order", weight: 1 },
    ]);
  });

  it("exposes the REAL global iteration index to a custom feeder (not the per-binding draw count)", async () => {
    // codex mix P2: FeederDrawContext.globalIteration keeps its documented meaning (run-global
    // iteration index) under mix scheduling — only the built-in feeders use the draw index.
    const seenGlobal: number[] = [];
    const customBinding = {
      allocate: (ctx: { globalIteration: number }) => {
        seenGlobal.push(ctx.globalIteration);
        return { outcome: "value" as const, value: { n: ctx.globalIteration } };
      },
    } as unknown as FeederBinding;
    const use = (id: string) => loadScenario(id).step("noop", async () => {}).build();
    const plan = loadRunner("mix-ctx", {
      concurrency: 1,
      iterations: 4,
      scenarios: [
        { id: "a", scenario: use("a"), weight: 50, feeders: { x: customBinding }, input: () => ({}) },
        { id: "b", scenario: use("b"), weight: 50, input: () => ({}) },
      ],
    });
    await runLoad(plan, { random: seqRandom([0.1, 0.9, 0.1, 0.9]) }); // A,B,A,B
    expect(seenGlobal).toEqual([0, 2]); // A ran at global iterations 0 and 2 (real indices, not 0,1)
  });

  it("rejects a duplicate traffic-mix entry id", async () => {
    const plan = loadRunner("dup", {
      scenarios: [
        { id: "x", scenario: browse(), weight: 1, input: () => ({ sku: "1" }) },
        { id: "x", scenario: order(), weight: 1 },
      ],
      concurrency: 1,
      iterations: 1,
    });
    await expect(runLoad(plan)).rejects.toThrow(/duplicate traffic-mix entry id "x"/);
  });

  it("rejects a non-positive mix weight", async () => {
    const plan = loadRunner("badweight", {
      scenarios: [
        { id: "a", scenario: browse(), weight: 0, input: () => ({ sku: "1" }) },
        { id: "b", scenario: order(), weight: 1 },
      ],
      concurrency: 1,
      iterations: 1,
    });
    await expect(runLoad(plan)).rejects.toThrow(/weight must be a positive number/);
  });

  it("rejects an empty traffic mix", async () => {
    const plan = loadRunner("empty-mix", { scenarios: [], concurrency: 1, iterations: 1 });
    await expect(runLoad(plan)).rejects.toThrow(/traffic mix needs at least one entry/);
  });
});

// True mid-run abort: when the drain phase abandons a continuation tail, the run aborts
// it so its in-flight HTTP is actually CANCELLED — not left to run to completion in the
// background. Proven server-side: the continuation request the drain timeout abandons is
// observed as a client-cancelled connection, not a completed response.
describe("runLoad — abort cancels an abandoned continuation's in-flight HTTP", () => {
  let hangServer: Server;
  let hangBase: string;
  let cancelled = 0; // continuation requests the server saw the client cancel mid-flight
  let completed = 0; // continuation requests that ran to a full response (NOT cancelled)

  beforeAll(async () => {
    hangServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.method === "POST" && url.pathname === "/submit") {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "j1" })); // primary — respond at once
          return;
        }
        if (req.method === "GET" && url.pathname === "/result") {
          // Continuation — hold the RESPONSE open well past the drain timeout. Decide
          // cancel-vs-complete on the RESPONSE close (not the request's, which can close
          // as soon as a bodyless GET is fully received — codex r5 P3): `writableFinished`
          // is true only if we actually flushed the response, so a close before that means
          // the client (the run's abort) tore the connection down.
          const timer = setTimeout(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ done: true }));
          }, 3000);
          res.on("close", () => {
            clearTimeout(timer);
            if (res.writableFinished) completed += 1; // response fully sent → ran to completion
            else cancelled += 1; // socket closed before the response finished → client aborted
          });
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => hangServer.listen(0, "127.0.0.1", r));
    const addr = hangServer.address();
    hangBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : addr}`;
  });

  afterAll(() => new Promise<void>((r) => hangServer.close(() => r())));

  it("kills the continuation's in-flight request the drain timeout abandons", async () => {
    const plan = loadRunner("abortable-job", {
      scenario: loadScenario("abortable-job")
        .step("submit", async (ctx) => {
          await ctx.http.post(`${hangBase}/submit`, { json: {} }).json();
          await ctx.report.primaryComplete("submitted", { releaseProducerSlot: true });
        })
        .step("await-result", async (ctx) => {
          // A real poll-for-result request that outlasts the 20ms drain timeout — abort
          // must cancel it in flight, not let it run the full 3s server hold.
          await ctx.http.get(`${hangBase}/result`).json();
        })
        .build(),
      concurrency: 1,
      iterations: 1,
      continuation: { drainTimeout: "20ms" },
    });

    const art = await runLoad(plan);
    // The drain phase abandoned the continuation (it outlasted the 20ms bound).
    expect(art.summary.continuation?.abortedByDrainTimeout).toBe(1);

    // The abort settles the tail on later microtasks (post-seal); give the cancel a tick
    // to reach the server, then assert the request was cancelled — not run to completion.
    await new Promise((r) => setTimeout(r, 150));
    expect(cancelled).toBe(1);
    expect(completed).toBe(0);
  });
});
