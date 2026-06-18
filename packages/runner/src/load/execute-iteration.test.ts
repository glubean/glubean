import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

import { loadScenario } from "@glubean/sdk/load";

import { createEngineCore } from "../engine-bridge.js";
import { createLoadReducer } from "./reducer.js";
import { compileLoadScenario, runLoadIteration } from "./execute-iteration.js";
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
});
