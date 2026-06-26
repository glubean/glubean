import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

import { loadScenario } from "@glubean/sdk/load";

import { createEngineCore } from "../engine-bridge.js";
import { ContinuationPool } from "./continuation-pool.js";
import { createLoadReducer } from "./reducer.js";
import { compileLoadScenario, runLoadIteration, startLoadIteration } from "./execute-iteration.js";
import { LoadSink, type LoadIterationEnvelope } from "./sink.js";

// M3-d-ii end-to-end: ONE load iteration runs through the shared engine core
// against a REAL local HTTP server (mock — the network is never the bottleneck),
// its wire events flow through LoadSink → LoadReducer, and the finalized
// LoadArtifact carries the expected iteration / step / endpoint / matrix
// aggregates. Also covers the load failure-fidelity fixes: the `continue`
// assertion default keeps the transaction running, `skipRemainingSteps` halts,
// step timeouts classify as `timeout`, and `.group()` attribution survives.

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
        res.end(JSON.stringify({ orderId: "o-1", received: body ? JSON.parse(body) : null }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/slow") {
        // Respond after a delay so a short per-request timeout fires first.
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        }, 120);
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

/** A deterministic, monotonically-increasing clock so event ts advance by a fixed
 *  step (keeps throughput/elapsed math finite and stable across runs). */
function makeClock(stepMs = 5): () => number {
  let t = 1_000;
  return () => (t += stepMs);
}

/** A browse→checkout scenario: GET an item, then POST an order. */
function buildScenario() {
  return loadScenario<{ sku: string }>("browse-checkout")
    .step("browse", async (ctx) => {
      const item = (await ctx.http.get(`${base}/items/${ctx.input.sku}`).json()) as {
        id: string;
        name: string;
      };
      ctx.expect(item.name).toBe("widget");
      return { itemId: item.id };
    })
    .step("checkout", async (ctx, state) => {
      const order = (await ctx.http
        .post(`${base}/orders`, { json: { itemId: state.itemId } })
        .json()) as { orderId: string };
      ctx.expect(order.orderId).toBe("o-1");
    })
    .build();
}

function envelope(scenarioId: string, iterationId: string): LoadIterationEnvelope {
  return { scenarioId, producerSlotId: "p0", iterationId };
}

/** Wire up a fresh core + sink + reducer for one test. */
function rig(runId: string) {
  const reducer = createLoadReducer();
  const sink = new LoadSink(reducer, runId, "runner-1", makeClock());
  const core = createEngineCore(sink.handleWire, { vars: {}, secrets: {} });
  return { reducer, sink, core };
}

describe("runLoadIteration — single iteration through the engine core", () => {
  it("runs one iteration end-to-end and aggregates into the LoadArtifact", async () => {
    const { reducer, sink, core } = rig("run-1");
    const scenario = compileLoadScenario(buildScenario());

    const out = await runLoadIteration({
      core,
      sink,
      scenario,
      envelope: envelope("browse-checkout", "it-1"),
      input: { sku: "42" },
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });

    expect(out.ok).toBe(true);
    expect(out.result?.status).toBe("ok");

    const art = reducer.finalize();
    expect(art.schemaVersion).toBe("glubean.load.v1");
    expect(art.runMode).toBe("load");

    // Iteration / scenario aggregates.
    expect(art.summary.totalIterations).toBe(1);
    expect(art.summary.successfulIterations).toBe(1);
    expect(art.summary.failedIterations).toBe(0);
    expect(art.scenarios).toHaveLength(1);
    expect(art.scenarios[0]).toMatchObject({
      scenarioId: "browse-checkout",
      iterations: 1,
      successfulIterations: 1,
      failedIterations: 0,
    });

    // Step aggregates — both steps ran exactly once, no errors.
    const steps = Object.fromEntries(art.steps.map((s) => [s.stepName, s]));
    expect(Object.keys(steps).sort()).toEqual(["browse", "checkout"]);
    expect(steps.browse).toMatchObject({ invocationCount: 1, errorCount: 0, requestCount: 1 });
    expect(steps.checkout).toMatchObject({ invocationCount: 1, errorCount: 0, requestCount: 1 });

    // Endpoint aggregates — one GET, one POST; routeKey is heuristic-normalized
    // (the `/items/42` id collapsed to `:id`, M3-e).
    const endpoints = Object.fromEntries(art.endpoints.map((e) => [e.routeKey, e]));
    expect(endpoints["GET /items/:id"]).toMatchObject({ requestCount: 1, errorCount: 0, method: "GET" });
    expect(endpoints["POST /orders"]).toMatchObject({ requestCount: 1, errorCount: 0, method: "POST" });
    for (const e of art.endpoints) {
      expect(e.routeKeyHeuristic).toBe(true);
      expect(e.routeKeySource).toBe("normalized-url");
    }

    // Matrix links each step to the endpoint it hit.
    const matrix = art.matrix.map((m) => `${m.stepName}→${m.routeKey}`).sort();
    expect(matrix).toEqual(["browse→GET /items/:id", "checkout→POST /orders"]);
  });

  it("aggregates two iterations and counts a failed one", async () => {
    const { reducer, sink, core } = rig("run-2");

    const ok = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(buildScenario()),
      envelope: envelope("browse-checkout", "it-1"),
      input: { sku: "1" },
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });
    expect(ok.ok).toBe(true);

    // Second iteration fails an assertion (expects the wrong item name).
    const failing = loadScenario<{ sku: string }>("browse-checkout")
      .step("browse", async (ctx) => {
        const item = (await ctx.http.get(`${base}/items/${ctx.input.sku}`).json()) as { name: string };
        ctx.expect(item.name).toBe("WRONG");
      })
      .build();
    const bad = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(failing),
      envelope: envelope("browse-checkout", "it-2"),
      input: { sku: "2" },
      producerSlot: { id: "p0", index: 1 },
      iteration: { id: "it-2", index: 1 },
    });
    expect(bad.ok).toBe(false);
    expect(bad.errorKind).toBe("assertion");

    const art = reducer.finalize();
    expect(art.summary.totalIterations).toBe(2);
    expect(art.summary.successfulIterations).toBe(1);
    expect(art.summary.failedIterations).toBe(1);
    // GET /items/1 and /items/2 collapse to ONE normalized endpoint (`:id`), not two.
    const getEndpoints = art.endpoints.filter((e) => e.method === "GET");
    expect(getEndpoints).toHaveLength(1);
    expect(getEndpoints[0]).toMatchObject({ routeKey: "GET /items/:id", requestCount: 2 });
  });

  it("default `continue` policy: a soft assertion failure does NOT skip the rest", async () => {
    const { reducer, sink, core } = rig("run-continue");
    // Step 1 fails its assertion but (default `continue`) step 2 must still run +
    // issue its request; the iteration is still counted failed.
    const scenario = loadScenario<{ sku: string }>("continue-flow")
      .step("browse", async (ctx) => {
        const item = (await ctx.http.get(`${base}/items/${ctx.input.sku}`).json()) as { name: string };
        ctx.expect(item.name).toBe("WRONG"); // soft failure
      })
      .step("checkout", async (ctx) => {
        await ctx.http.post(`${base}/orders`, { json: {} }).json();
      })
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("continue-flow", "it-1"),
      input: { sku: "5" },
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });
    expect(out.ok).toBe(false);
    expect(out.errorKind).toBe("assertion");

    const art = reducer.finalize();
    expect(art.summary.failedIterations).toBe(1);
    // BOTH endpoints were hit — checkout ran despite browse's assertion failure.
    const routeKeys = art.endpoints.map((e) => e.routeKey).sort();
    expect(routeKeys).toEqual(["GET /items/:id", "POST /orders"]);
    const steps = Object.fromEntries(art.steps.map((s) => [s.stepName, s.invocationCount]));
    expect(steps).toEqual({ browse: 1, checkout: 1 });
  });

  it("`skipRemainingSteps` policy: a soft assertion failure halts the rest", async () => {
    const { reducer, sink, core } = rig("run-skip");
    const scenario = loadScenario<{ sku: string }>("skip-flow")
      .step("browse", { assertions: { onFailure: "skipRemainingSteps" } }, async (ctx) => {
        const item = (await ctx.http.get(`${base}/items/${ctx.input.sku}`).json()) as { name: string };
        ctx.expect(item.name).toBe("WRONG"); // soft failure → skip the rest
      })
      .step("checkout", async (ctx) => {
        await ctx.http.post(`${base}/orders`, { json: {} }).json();
      })
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("skip-flow", "it-1"),
      input: { sku: "7" },
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });
    expect(out.ok).toBe(false);

    const art = reducer.finalize();
    // Only the GET was issued; checkout's POST was skipped.
    const routeKeys = art.endpoints.map((e) => e.routeKey).sort();
    expect(routeKeys).toEqual(["GET /items/:id"]);
    // The skipped step counts as skipped — NOT as its own error.
    const checkout = art.steps.find((s) => s.stepName === "checkout");
    expect(checkout).toMatchObject({ skippedCount: 1, errorCount: 0, errorRate: 0 });
  });

  it("preserves `.group()` attribution on step aggregates", async () => {
    const { reducer, sink, core } = rig("run-group");
    const scenario = loadScenario("grouped")
      .group("checkout-flow", (b) =>
        b
          .step("browse", async (ctx) => {
            await ctx.http.get(`${base}/items/1`).json();
          })
          .step("order", async (ctx) => {
            await ctx.http.post(`${base}/orders`, { json: {} }).json();
          }),
      )
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("grouped", "it-1"),
      input: {},
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });
    expect(out.ok).toBe(true);

    const art = reducer.finalize();
    const groups = Object.fromEntries(art.steps.map((s) => [s.stepName, s.groupId]));
    expect(groups).toEqual({ browse: "checkout-flow", order: "checkout-flow" });
  });

  it("propagates a `.group()` label into a branch leaf", async () => {
    const { reducer, sink, core } = rig("run-group-branch");
    const scenario = loadScenario<{ vip: boolean }>("grouped-branch")
      .group("vip-flow", (b) =>
        b.condition(
          { predicate: (ctx) => ctx.input.vip },
          (tb) =>
            tb.step("vip-step", async (ctx) => {
              await ctx.http.get(`${base}/items/1`).json();
            }),
          (eb) => eb,
        ),
      )
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("grouped-branch", "it-1"),
      input: { vip: true },
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });
    expect(out.ok).toBe(true);

    const art = reducer.finalize();
    const leaf = art.steps.find((s) => s.stepName === "vip-step");
    expect(leaf?.groupId).toBe("vip-flow");
  });

  it("classifies a step-level request timeout as `timeout`", async () => {
    const { sink, core } = rig("run-req-timeout");
    const scenario = loadScenario("slow-request")
      .step("fetch-slow", async (ctx) => {
        // Per-request timeout (10ms) fires before the 120ms server response →
        // ky throws TimeoutError inside the step (caught → stepErrorName).
        await ctx.http.get(`${base}/slow`, { timeout: 10 }).json();
      })
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("slow-request", "it-1"),
      input: {},
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });
    expect(out.ok).toBe(false);
    expect(out.errorKind).toBe("timeout");
  });

  it("classifies a step timeout as `timeout`", async () => {
    const { sink, core } = rig("run-timeout");
    const scenario = loadScenario("slow")
      .step("wait", { timeout: 10 }, async () => {
        // Exceeds the step's 10ms budget → StepTimeoutError (no HTTP needed).
        await new Promise((r) => setTimeout(r, 80));
      })
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("slow", "it-1"),
      input: {},
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });
    expect(out.ok).toBe(false);
    expect(out.errorKind).toBe("timeout");
  });

  it("classifies a signal-aborted iteration as `aborted`", async () => {
    // codex r6 P2: when the run-level signal cancels an in-flight request, the iteration
    // must classify as "aborted" (a cancellation), not a generic stepError/setupError.
    const { sink, core } = rig("run-aborted");
    const controller = new AbortController();
    const scenario = loadScenario("aborted-job")
      .step("fetch-slow", async (ctx) => {
        // /slow responds at 120ms; the abort fires first → ky throws AbortError in-step.
        await ctx.http.get(`${base}/slow`).json();
      })
      .build();

    const out = runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("aborted-job", "it-1"),
      input: {},
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    const result = await out;
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("aborted");
  });

  it("does NOT classify a scenario's OWN AbortError as `aborted` (run signal not aborted)", async () => {
    // codex r7 P2: a scenario that aborts its own request is a real user failure, not an
    // orchestrator cancellation — gating on the run signal keeps it a stepError.
    const { sink, core } = rig("run-self-abort");
    const scenario = loadScenario("self-abort")
      .step("self-cancel", async (ctx) => {
        const ac = new AbortController();
        ac.abort(); // the scenario cancels its OWN request, not the orchestrator
        await ctx.http.get(`${base}/items/1`, { signal: ac.signal }).json();
      })
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("self-abort", "it-1"),
      input: {},
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
      // NO run signal — the orchestrator did not abort this iteration.
    });
    expect(out.ok).toBe(false);
    expect(out.errorKind).toBe("stepError"); // a real user failure, NOT "aborted"
  });

  it("honors `continue` policy for a poll soft-assertion failure", async () => {
    const { reducer, sink, core } = rig("run-poll-continue");
    const scenario = loadScenario("poll-continue")
      .poll(
        "check",
        async (ctx) => {
          const item = (await ctx.http.get(`${base}/items/1`).json()) as { name: string };
          ctx.expect(item.name).toBe("WRONG"); // soft fail, but the poll still satisfies
          return item.name;
        },
        { until: (_ctx, res) => res === "widget", maxAttempts: 1, timeout: 2000 },
      )
      .step("after", async (ctx) => {
        await ctx.http.post(`${base}/orders`, { json: {} }).json();
      })
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("poll-continue", "it-1"),
      input: {},
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });
    expect(out.ok).toBe(false); // the soft assertion still fails the iteration

    const art = reducer.finalize();
    // "after" still ran despite the poll's soft assertion failure (continue policy).
    const routeKeys = art.endpoints.map((e) => e.routeKey).sort();
    expect(routeKeys).toContain("POST /orders");
  });

  it("classifies a scenario setup failure as `setupError`", async () => {
    const { sink, core } = rig("run-setup-fail");
    const scenario = loadScenario("setup-fail")
      .setup(async (): Promise<void> => {
        throw new Error("setup boom");
      })
      .step("never", async (ctx) => {
        await ctx.http.get(`${base}/items/1`).json();
      })
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("setup-fail", "it-1"),
      input: {},
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });
    expect(out.ok).toBe(false);
    expect(out.errorKind).toBe("setupError");
  });

  it("treats a `ctx.skip()` iteration as skipped, not a failure", async () => {
    const { reducer, sink, core } = rig("run-skip-iter");
    const scenario = loadScenario("skip-iter")
      .step("maybe", async (ctx) => {
        ctx.skip("no data");
      })
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("skip-iter", "it-1"),
      input: {},
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });
    expect(out.skipped).toBe(true);
    expect(out.ok).toBe(true);
    expect(out.errorKind).toBeUndefined();
    expect(reducer.finalize().summary.failedIterations).toBe(0);
  });

  it("preserves group attribution on a SKIPPED leaf", async () => {
    const { reducer, sink, core } = rig("run-group-skip");
    const scenario = loadScenario<{ sku: string }>("group-skip")
      .group("flow", (b) =>
        b
          .step("first", { assertions: { onFailure: "skipRemainingSteps" } }, async (ctx) => {
            const item = (await ctx.http.get(`${base}/items/${ctx.input.sku}`).json()) as { name: string };
            ctx.expect(item.name).toBe("WRONG"); // soft fail → skip the rest
          })
          .step("second", async (ctx) => {
            await ctx.http.post(`${base}/orders`, { json: {} }).json();
          }),
      )
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("group-skip", "it-1"),
      input: { sku: "1" },
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });
    expect(out.ok).toBe(false);

    const art = reducer.finalize();
    const second = art.steps.find((s) => s.stepName === "second");
    expect(second).toMatchObject({ skippedCount: 1, groupId: "flow" });
  });

  it("a later `ctx.skip()` does not mask a prior soft assertion failure", async () => {
    const { sink, core } = rig("run-skip-mask");
    const scenario = loadScenario<{ sku: string }>("skip-mask")
      .step("a", async (ctx) => {
        const item = (await ctx.http.get(`${base}/items/${ctx.input.sku}`).json()) as { name: string };
        ctx.expect(item.name).toBe("WRONG"); // soft fail (continue policy)
      })
      .step("b", async (ctx) => {
        ctx.skip("no data"); // a later skip must NOT hide step a's failure
      })
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("skip-mask", "it-1"),
      input: { sku: "1" },
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });
    expect(out.skipped).toBeUndefined(); // the failure wins over the skip
    expect(out.ok).toBe(false);
    expect(out.errorKind).toBe("assertion");
  });

  it("classifies a branch-decision throw as `stepError`, not `assertion`", async () => {
    const { sink, core } = rig("run-branch-throw");
    const scenario = loadScenario("branch-throw")
      .condition(
        {
          predicate: () => {
            throw new Error("predicate boom");
          },
        },
        (tb) => tb.step("then", async () => {}),
        (eb) => eb,
      )
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("branch-throw", "it-1"),
      input: {},
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });
    expect(out.ok).toBe(false);
    expect(out.errorKind).toBe("stepError");
  });

  it("does not merge two leaf steps that share a display name", async () => {
    const { reducer, sink, core } = rig("run-dup-name");
    const scenario = loadScenario("dup-name")
      .step("call", async (ctx) => {
        await ctx.http.get(`${base}/items/1`).json();
      })
      .step("call", async (ctx) => {
        await ctx.http.post(`${base}/orders`, { json: {} }).json();
      })
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("dup-name", "it-1"),
      input: {},
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });
    expect(out.ok).toBe(true);

    const art = reducer.finalize();
    const calls = art.steps.filter((s) => s.stepName === "call");
    // Same display name, distinct leaf indices → two separate aggregates, not merged.
    expect(calls).toHaveLength(2);
    expect(calls.map((s) => s.requestCount).sort()).toEqual([1, 1]);
    expect(new Set(calls.map((s) => s.stepId)).size).toBe(2);
  });

  it("emits report:checkpoint through the sink without affecting the run", async () => {
    const { reducer, sink, core } = rig("run-3");

    let checkpointSeen = false;
    const scenario = loadScenario<{ run: number }>("with-checkpoint")
      .step("browse", async (ctx) => {
        await ctx.http.get(`${base}/items/${ctx.input.run}`).json();
        ctx.report.checkpoint("after-browse", { sku: ctx.input.run });
        checkpointSeen = true;
      })
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("with-checkpoint", "it-1"),
      input: { run: 9 },
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });

    expect(checkpointSeen).toBe(true);
    expect(out.ok).toBe(true);
    expect(reducer.finalize().summary.successfulIterations).toBe(1);
  });

  it("no-ops `ctx.metrics` when the runner declared none (no throw, no fold)", async () => {
    const { reducer, sink, core } = rig("run-metrics");

    let added = false;
    const scenario = loadScenario<{ run: number }>("with-metrics")
      .step("browse", async (ctx) => {
        await ctx.http.get(`${base}/items/${ctx.input.run}`).json();
        // No declarations passed below → the surface is a safe no-op.
        ctx.metrics.pollOk.add(true, { class: "fast" });
        ctx.metrics.retries.add();
        added = true;
      })
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("with-metrics", "it-1"),
      input: { run: 9 },
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });

    expect(added).toBe(true);
    expect(out.ok).toBe(true);
    expect(reducer.finalize().summary.customMetrics).toBeUndefined();
  });

  it("folds declared `ctx.metrics` end-to-end (handle → sink → reducer)", async () => {
    const { reducer, sink, core } = rig("run-metrics2");

    const scenario = loadScenario<{ run: number }>("declared-metrics")
      .step("poll", async (ctx) => {
        await ctx.http.get(`${base}/items/${ctx.input.run}`).json();
        ctx.metrics.pollOk.add(true, { class: "fast" });
        ctx.metrics.retries.add(); // counter default +1
      })
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("declared-metrics", "it-1"),
      input: { run: 9 },
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
      metrics: { pollOk: { kind: "rate" }, retries: { kind: "counter" } },
    });

    expect(out.ok).toBe(true);
    const cm = reducer.finalize().summary.customMetrics ?? [];
    const pollOk = cm.find((m) => m.metricId === "pollOk");
    expect(pollOk?.series.find((s) => s.tags.class === "fast")).toMatchObject({ count: 1, trueCount: 1, rate: 1 });
    const retries = cm.find((m) => m.metricId === "retries");
    expect(retries?.series.find((s) => Object.keys(s.tags).length === 0)).toMatchObject({ count: 1, sum: 1 });
  });

  it("drops non-finite metric samples (NaN/Infinity), folding only the valid one", async () => {
    const { reducer, sink, core } = rig("run-metrics3");

    const scenario = loadScenario<{ run: number }>("nan-metrics")
      .step("poll", async (ctx) => {
        await ctx.http.get(`${base}/items/${ctx.input.run}`).json();
        ctx.metrics.e2e.add(Number("not-a-number")); // NaN → dropped
        ctx.metrics.e2e.add(Infinity); // dropped
        ctx.metrics.e2e.add(120); // the only valid sample
      })
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("nan-metrics", "it-1"),
      input: { run: 9 },
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
      metrics: { e2e: { kind: "trend", unit: "ms" } },
    });

    expect(out.ok).toBe(true);
    const total = reducer
      .finalize()
      .summary.customMetrics?.find((m) => m.metricId === "e2e")
      ?.series.find((s) => Object.keys(s.tags).length === 0);
    expect(total?.count).toBe(1); // two malformed samples dropped, one folded
  });

  it("no-ops an inherited property name (constructor/toString) without throwing", async () => {
    const { reducer, sink, core } = rig("run-metrics4");

    const scenario = loadScenario<{ run: number }>("inherited-name")
      .step("poll", async (ctx) => {
        await ctx.http.get(`${base}/items/${ctx.input.run}`).json();
        // Undeclared ids that collide with Object.prototype must stay no-ops.
        const m = ctx.metrics as Record<string, { add(v?: unknown): void }>;
        m.constructor.add(true);
        m.toString.add(1);
        ctx.metrics.real.add(true);
      })
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("inherited-name", "it-1"),
      input: { run: 9 },
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
      metrics: { real: { kind: "rate" } },
    });

    expect(out.ok).toBe(true);
    const ids = (reducer.finalize().summary.customMetrics ?? []).map((m) => m.metricId);
    expect(ids).toEqual(["real"]); // only the declared metric folded; no throw above
  });
});

describe("runLoadIteration — primaryComplete boundary (M5)", () => {
  it("records the boundary, flips events after it to continuation, and dedupes repeats", async () => {
    const { reducer, sink, core } = rig("run-m5");

    // submit (POST, primary) → primaryComplete → poll (GET, continuation). A second
    // primaryComplete in the same iteration is a duplicate (one boundary only).
    const receipts: Array<{ measuredPrimaryComplete: boolean; releasedProducerSlot: boolean; duplicate: boolean; backpressureMs: number }> = [];
    const scenario = loadScenario("submit-poll")
      .step("submit", async (ctx) => {
        await ctx.http.post(`${base}/orders`, { json: {} }).json();
        receipts.push(await ctx.report.primaryComplete("submitted"));
        receipts.push(await ctx.report.primaryComplete("again"));
      })
      .step("poll", async (ctx) => {
        await ctx.http.get(`${base}/items/1`).json();
      })
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("submit-poll", "it-1"),
      input: {},
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });

    expect(out.ok).toBe(true);
    // First call measures the boundary; the second is a duplicate (no release in M5).
    expect(receipts[0]).toMatchObject({ measuredPrimaryComplete: true, duplicate: false, releasedProducerSlot: false });
    expect(receipts[1]).toMatchObject({ measuredPrimaryComplete: false, duplicate: true });

    const art = reducer.finalize();

    // The POST happened before the boundary (primary); the GET after it, in the
    // poll step, is continuation (the flip is immediate at the boundary).
    const byKeyPhase = Object.fromEntries(art.endpoints.map((e) => [`${e.routeKey}@${e.phase}`, e]));
    expect(byKeyPhase["POST /orders@primary"]?.requestCount).toBe(1);
    expect(byKeyPhase["GET /items/:id@continuation"]?.requestCount).toBe(1);

    // Each step stays in ONE phase: `submit` (boundary at its tail) wholly primary,
    // `poll` wholly continuation — step:end is stamped with the step's start phase.
    const stepByName = Object.fromEntries(art.steps.map((s) => [`${s.stepName}@${s.phase}`, s]));
    expect(stepByName["submit@primary"]).toMatchObject({ invocationCount: 1, requestCount: 1 });
    expect(stepByName["poll@continuation"]).toMatchObject({ invocationCount: 1, requestCount: 1 });

    // Phase split surfaced: primary (up to the boundary) vs end-to-end (full
    // iteration). The deterministic clock advances per event, so primary latency
    // (submit only) is strictly less than the end-to-end latency.
    expect(art.summary.primary).toBeDefined();
    expect(art.summary.endToEnd).toBeDefined();
    expect(art.summary.primary!.completed).toBe(1);
    expect(art.summary.primary!.failedBeforeRelease).toBe(0);
    expect(art.summary.endToEnd!.completed).toBe(1);
    expect(art.summary.primary!.latency.p95).toBeGreaterThan(0);
    expect(art.summary.primary!.latency.p95).toBeLessThan(art.summary.endToEnd!.latency.p95);
  });

  it("counts an iteration that fails before its boundary as failedBeforeRelease", async () => {
    const { reducer, sink, core } = rig("run-m5b");

    // it-1 reaches the boundary; it-2 fails BEFORE calling primaryComplete.
    const scenario = compileLoadScenario(
      loadScenario<{ fail: boolean }>("submit")
        .step("submit", async (ctx) => {
          await ctx.http.get(`${base}/items/1`).json();
          if (ctx.input.fail) ctx.fail("boom before primaryComplete");
          await ctx.report.primaryComplete("submitted");
        })
        .build(),
    );

    const ok = await runLoadIteration({
      core, sink, scenario,
      envelope: envelope("submit", "it-1"),
      input: { fail: false },
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });
    const bad = await runLoadIteration({
      core, sink, scenario,
      envelope: envelope("submit", "it-2"),
      input: { fail: true },
      producerSlot: { id: "p0", index: 1 },
      iteration: { id: "it-2", index: 1 },
    });

    expect(ok.ok).toBe(true);
    expect(bad.ok).toBe(false);

    const art = reducer.finalize();
    // One boundary reached → phase split present; the failed-before-boundary
    // iteration is counted, not folded into primary completion.
    expect(art.summary.primary!.completed).toBe(1);
    expect(art.summary.primary!.failedBeforeRelease).toBe(1);
    expect(art.summary.endToEnd!.completed).toBe(2);
    expect(art.summary.endToEnd!.failed).toBe(1);
  });

  it("keeps a step that spans the boundary in a single phase (no phantom rows)", async () => {
    const { reducer, sink, core } = rig("run-m5c");

    // primaryComplete is called in the MIDDLE of one step that then issues another
    // request. Phase is step-granular, so the step + both its requests stay in the
    // step's start phase — no split step / endpoint / matrix rows.
    const scenario = loadScenario("submit-and-poll-in-one-step")
      .step("both", async (ctx) => {
        await ctx.http.post(`${base}/orders`, { json: {} }).json();
        await ctx.report.primaryComplete("submitted");
        await ctx.http.get(`${base}/items/1`).json();
      })
      .build();

    const out = await runLoadIteration({
      core,
      sink,
      scenario: compileLoadScenario(scenario),
      envelope: envelope("submit-and-poll-in-one-step", "it-1"),
      input: {},
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    });

    expect(out.ok).toBe(true);
    const art = reducer.finalize();

    // The straddling step appears exactly once (its start phase = primary) with BOTH
    // requests counted — not a phantom continuation row with requestCount only.
    const both = art.steps.filter((s) => s.stepName === "both");
    expect(both).toHaveLength(1);
    expect(both[0]).toMatchObject({ phase: "primary", invocationCount: 1, requestCount: 2 });
    // Endpoints still split by the request's LIVE phase: the POST (pre-boundary) is
    // primary, the GET (post-boundary) is continuation — matching the API contract
    // that primaryComplete switches the iteration into continuation.
    const epPhase = Object.fromEntries(art.endpoints.map((e) => [`${e.routeKey}@${e.phase}`, e]));
    expect(epPhase["POST /orders@primary"]?.requestCount).toBe(1);
    expect(epPhase["GET /items/:id@continuation"]?.requestCount).toBe(1);
    // Every matrix row resolves its step name (no orphan continuation-phase cell).
    expect(art.matrix.every((m) => m.stepName === "both")).toBe(true);
    // The iteration-level boundary is still measured (phase split present).
    expect(art.summary.primary?.completed).toBe(1);
  });

  it("splits a stepId into per-phase rows when it starts in different phases across iterations", async () => {
    const { reducer, sink, core } = rig("run-m5d");

    // `work` runs AFTER a gate step that conditionally fires the boundary: iter "a"
    // crosses it first (work starts continuation), iter "b" doesn't (work primary).
    const scenario = compileLoadScenario(
      loadScenario<{ early: boolean }>("conditional")
        .step("gate", async (ctx) => {
          if (ctx.input.early) await ctx.report.primaryComplete("early");
        })
        .step("work", async (ctx) => {
          await ctx.http.get(`${base}/items/1`).json();
        })
        .build(),
    );

    await runLoadIteration({
      core, sink, scenario,
      envelope: envelope("conditional", "a"),
      input: { early: true },
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "a", index: 0 },
    });
    await runLoadIteration({
      core, sink, scenario,
      envelope: envelope("conditional", "b"),
      input: { early: false },
      producerSlot: { id: "p0", index: 1 },
      iteration: { id: "b", index: 1 },
    });

    const art = reducer.finalize();
    const work = art.steps.filter((s) => s.stepName === "work");
    // Two rows — one per start phase — not merged into one first-seen-phase row.
    expect(work.map((s) => s.phase).sort()).toEqual(["continuation", "primary"]);
    for (const w of work) {
      expect(w.invocationCount).toBe(1); // each row counts only its own invocation
      expect(w.requestCount).toBe(1);
    }

    // The primary summary stays internally consistent across the conditional
    // boundary: the no-boundary success (iter "b") still counts as a primary
    // completion, so started = completed + failedBeforeRelease (+ 0 in-flight).
    const p = art.summary.primary!;
    expect(p.started).toBe(2);
    expect(p.completed).toBe(2); // 1 boundary (iter a) + 1 no-boundary success (iter b)
    expect(p.failedBeforeRelease).toBe(0);
    expect(p.started).toBe(p.completed + p.failedBeforeRelease);
  });
});

describe("startLoadIteration — producer release (M6)", () => {
  it("frees the producer slot at the boundary while the continuation runs on", async () => {
    const { sink, core } = rig("run-m6-rel");
    const pool = new ContinuationPool(undefined, "block-producer", undefined, () => 0);

    let receipt: { measuredPrimaryComplete: boolean; releasedProducerSlot: boolean; duplicate: boolean; backpressureMs: number } | undefined;
    let continuationDone = false;
    const scenario = compileLoadScenario(
      loadScenario("async-job")
        .step("submit", async (ctx) => {
          await ctx.http.post(`${base}/orders`, { json: {} }).json();
          receipt = await ctx.report.primaryComplete("submitted", { releaseProducerSlot: true });
        })
        .step("poll", async (ctx) => {
          await ctx.http.get(`${base}/slow`).json(); // delayed endpoint (~120ms)
          continuationDone = true;
        })
        .build(),
    );

    const handle = startLoadIteration({
      core, sink, scenario,
      envelope: envelope("async-job", "it-1"),
      input: {},
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
      continuation: { pool },
    });

    const { released } = await handle.primaryDone;
    // The slot is free at the boundary — BEFORE the continuation (slow poll) finished.
    expect(released).toBe(true);
    expect(continuationDone).toBe(false);
    expect(pool.outstanding).toBe(1); // one continuation in flight

    const out = await handle.completed;
    expect(out.ok).toBe(true);
    expect(continuationDone).toBe(true);
    expect(pool.outstanding).toBe(0); // freed once the continuation settled
    // The receipt is assigned when the scenario's `await primaryComplete` resolves
    // (just after the slot was freed), so assert it once the iteration has settled.
    expect(receipt).toMatchObject({ measuredPrimaryComplete: true, releasedProducerSlot: true, backpressureMs: 0 });
  });

  it("fail-iteration: a full backlog fails the iteration without releasing the slot", async () => {
    const { sink, core } = rig("run-m6-fail");
    const pool = new ContinuationPool(1, "fail-iteration", undefined, () => 0);
    // Pre-fill the single backlog slot so the iteration's release is rejected.
    await pool.admit();

    const scenario = compileLoadScenario(
      loadScenario("submit")
        .step("submit", async (ctx) => {
          await ctx.http.post(`${base}/orders`, { json: {} }).json();
          await ctx.report.primaryComplete("submitted", { releaseProducerSlot: true });
        })
        .build(),
    );

    const handle = startLoadIteration({
      core, sink, scenario,
      envelope: envelope("submit", "it-1"),
      input: {},
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
      continuation: { pool },
    });

    const { released } = await handle.primaryDone;
    const out = await handle.completed;
    // Release rejected → primaryComplete threw → the iteration failed, slot not released.
    expect(released).toBe(false);
    expect(out.ok).toBe(false);
    expect(out.errorKind).toBe("continuationBacklogFull"); // classified, not a generic stepError
    expect(pool.outstanding).toBe(1); // still just the pre-filled slot; nothing leaked
  });

  it("fail-iteration survives step retries (a retried duplicate primaryComplete can't pass it)", async () => {
    const { sink, core } = rig("run-m6-fail-retry");
    const pool = new ContinuationPool(1, "fail-iteration", undefined, () => 0);
    await pool.admit(); // pre-fill → the release is rejected

    // The step has retries: the first attempt throws (backlog full); the retry's
    // primaryComplete is a duplicate that RETURNS success — the iteration must still
    // fail, not pass on the retry.
    const scenario = compileLoadScenario(
      loadScenario("submit")
        .step("submit", { retries: 2 }, async (ctx) => {
          await ctx.report.primaryComplete("submitted", { releaseProducerSlot: true });
        })
        .build(),
    );
    const handle = startLoadIteration({
      core, sink, scenario,
      envelope: envelope("submit", "it-1"),
      input: {},
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
      continuation: { pool },
    });
    await handle.primaryDone;
    const out = await handle.completed;
    expect(out.ok).toBe(false); // failed despite the retry's duplicate-success
    expect(out.errorKind).toBe("continuationBacklogFull");
  });

  it("returns a back-pressured slot when its iteration times out (no backlog leak)", async () => {
    const { sink, core } = rig("run-m6-timeout");
    const pool = new ContinuationPool(1, "block-producer", undefined, () => 0);
    await pool.admit(); // fill the single slot so the iteration's release back-pressures
    expect(pool.outstanding).toBe(1);

    const scenario = compileLoadScenario(
      loadScenario("slow-release")
        .step("submit", { timeout: 10 }, async (ctx) => {
          // The release parks on the full backlog; the 10ms step budget fires first.
          await ctx.report.primaryComplete("submitted", { releaseProducerSlot: true });
        })
        .build(),
    );

    const handle = startLoadIteration({
      core, sink, scenario,
      envelope: envelope("slow-release", "it-1"),
      input: {},
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
      continuation: { pool },
    });

    const { released } = await handle.primaryDone;
    const out = await handle.completed;
    expect(released).toBe(false); // the slot was never released (timed out while parked)
    expect(out.ok).toBe(false);
    expect(out.errorKind).toBe("timeout");

    // Free the pre-filled slot — it transfers to the stale parked admit, which must
    // hand it straight back (iterationSettled guard) rather than leak it.
    pool.release();
    await new Promise((r) => setTimeout(r, 0)); // let the stale admit resolve + give back
    expect(pool.outstanding).toBe(0); // no leak

    // The backlog is usable again (no deadlock).
    expect(await pool.admit()).toBe(0);
  });

  it("ignores a deadline-cancelled admit that arrives after its iteration timed out", async () => {
    const { reducer, sink, core } = rig("run-m6-cancel-after-timeout");
    const pool = new ContinuationPool(1, "block-producer", undefined, () => 0);
    await pool.admit(); // fill → the iteration's release parks

    const scenario = compileLoadScenario(
      loadScenario("slow-release")
        .step("submit", { timeout: 10 }, async (ctx) => {
          await ctx.report.primaryComplete("submitted", { releaseProducerSlot: true });
        })
        .build(),
    );
    const handle = startLoadIteration({
      core, sink, scenario,
      envelope: envelope("slow-release", "it-1"),
      input: {},
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
      continuation: { pool },
    });
    await handle.primaryDone;
    await handle.completed; // the iteration timed out + settled, its admit still parked

    pool.closeImmediate(); // deadline fires AFTER settlement → the stale admit is cancelled
    await new Promise((r) => setTimeout(r, 0)); // let the cancelled admit resolve

    // No producer:releaseRejected was emitted for the already-ended iteration, so no
    // release activity is recorded at all (the continuation summary stays absent).
    expect(reducer.finalize().summary.continuation).toBeUndefined();
  });

  it("fails the iteration when a parked release's drain bound expires mid-run", async () => {
    const { reducer, sink, core } = rig("run-m6-drain-timeout");
    // drainTimeout = 15ms; pre-fill the only slot with a continuation that never frees
    // it, so the iteration's release parks and its own drain bound (not a run deadline)
    // cuts it off.
    const pool = new ContinuationPool(1, "block-producer", 15, () => Date.now());
    await pool.admit(); // a "hung" continuation holds the single slot

    const scenario = compileLoadScenario(
      loadScenario("slow-release")
        .step("submit", async (ctx) => {
          await ctx.report.primaryComplete("submitted", { releaseProducerSlot: true });
        })
        .build(),
    );
    const handle = startLoadIteration({
      core, sink, scenario,
      envelope: envelope("slow-release", "it-1"),
      input: {},
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
      continuation: { pool },
    });

    const { released } = await handle.primaryDone;
    expect(released).toBe(true); // freed for drain (acquired NO pool slot)
    const out = await handle.completed;
    // The backlog never freed within the drain bound → the iteration fails (it couldn't
    // honor the configured bound), rather than silently running over capacity.
    expect(out.ok).toBe(false);
    expect(out.errorKind).toBe("continuationBacklogFull");
    // Recorded as a rejection (the run-deadline path would NOT fail the iteration).
    expect(reducer.finalize().summary.continuation?.rejectedReleaseSignals).toBe(1);
  });

  it("treats releaseProducerSlot as a no-op phase split with no continuation coordinator", async () => {
    const { reducer, sink, core } = rig("run-m5-noop-release");
    const scenario = compileLoadScenario(
      loadScenario("phase-split")
        .step("submit", async (ctx) => {
          await ctx.report.primaryComplete("submitted", { releaseProducerSlot: true });
        })
        .build(),
    );
    // No `continuation` arg → no release coordinator (the M5-only path): the release
    // request is a documented no-op.
    const out = await startLoadIteration({
      core, sink, scenario,
      envelope: envelope("phase-split", "it-1"),
      input: {},
      producerSlot: { id: "p0", index: 0 },
      iteration: { id: "it-1", index: 0 },
    }).completed;
    expect(out.ok).toBe(true);
    // No coordinator → no parked release: a live snapshot shows nothing blocked on the
    // backlog and the artifact carries no continuation summary.
    expect(reducer.snapshot().blockedOnBacklog).toBe(0);
    expect(reducer.finalize().summary.continuation).toBeUndefined();
  });
});
