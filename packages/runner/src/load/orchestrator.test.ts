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

beforeAll(async () => {
  server = createServer((req, res) => {
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

  it("rejects a traffic-mix config (single-scenario only for now)", async () => {
    const plan = loadRunner("mix", {
      concurrency: 1,
      iterations: 1,
      scenarios: [
        { id: "a", scenario: loadScenario("a").step("s", async () => {}).build(), weight: 1 },
      ],
    });
    await expect(runLoad(plan)).rejects.toThrow(/traffic-mix/);
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
