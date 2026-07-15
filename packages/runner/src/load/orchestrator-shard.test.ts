/**
 * D1-2 — `runLoadShard()` direct tests (internal load-distributed-execution proposal
 * §5.1 / §6 / §9). The shard-aware execution kernel `runLoad` now wraps: a worker runs
 * only its assigned slice and streams cumulative `LoadReducerPartialV1` frames instead of
 * finalizing an artifact. Covered here:
 *
 *  1. RANGE partition (iterations-bounded): two shards from `shardPlan(plan, 2)` run
 *     disjoint contiguous global iteration ranges; their terminal partials, merged +
 *     finalized (the D0 coordinator path), reproduce a single-machine `runLoad`'s ADDITIVE
 *     quantities (a simplified D0-9 cross-check — the full property sweep is D1-5).
 *  2. onSnapshot emits PERIODIC frames (mid-run, no endReason) AND a TERMINAL frame
 *     (endReason set, last); the shard evaluates NO thresholds — only the coordinator's
 *     `finalizeMerged({ thresholds })` populates verdicts.
 *  3. STRIDE partition (duration-only): shards run disjoint even/odd global indexes, so
 *     `iteration.index` follows the shard's `offset + k·step` mapping exactly.
 *
 * A shared local mock server stands in for the SUT (network is never the bottleneck),
 * mirroring orchestrator.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

import { feeder, loadRunner, loadScenario } from "@glubean/sdk/load";
import type { LoadThresholds } from "@glubean/sdk/load";

import { runLoad, runLoadShard } from "./orchestrator.js";
import { shardPlan } from "./shard.js";
import { finalizeMerged, mergePartials, type LoadReducerPartialV1 } from "./partial.js";

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

/** browse→checkout scenario driven by `ctx.input.sku` (one GET + one POST per iteration). */
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

/** Collect the frames a shard emits via `onSnapshot`; the terminal one is always last. */
function frameSink() {
  const frames: LoadReducerPartialV1[] = [];
  return {
    frames,
    onSnapshot: (p: LoadReducerPartialV1): void => {
      frames.push(p);
    },
    terminal: (): LoadReducerPartialV1 => frames[frames.length - 1],
  };
}

describe("runLoadShard — shard-aware execution kernel (D1-2)", () => {
  it("2-shard RANGE partition merges to the same additive quantities as a single-machine run", async () => {
    // Every claimed iteration records the GLOBAL index its `input` closure sees, so the
    // range→global mapping is checked directly (shared array reset between phases).
    const captured: number[] = [];
    const makePlan = () =>
      loadRunner("shard-range", {
        scenario: browseCheckout(),
        concurrency: 4,
        iterations: 10,
        input: ({ iteration }) => {
          captured.push(iteration.index);
          return { sku: String(iteration.index) };
        },
      });

    // Single-machine ground truth.
    captured.length = 0;
    const directArt = await runLoad(makePlan());
    captured.length = 0;

    const plan = makePlan();
    const { shards, workerCount } = shardPlan(plan, 2);
    expect(workerCount).toBe(2);
    // 10 iterations, slotCounts [2,2] → quotas [5,5] → ranges [0,5) and [5,10).
    expect(shards[0].iterationIndexes).toEqual({ kind: "range", start: 0, end: 5 });
    expect(shards[1].iterationIndexes).toEqual({ kind: "range", start: 5, end: 10 });

    const rngSeed = "seed-shard";
    const timelineOrigin = Date.now(); // shared run axis (any epoch <= every event)

    const sink0 = frameSink();
    await runLoadShard(plan, { shard: shards[0], rngSeed, timelineOrigin, onSnapshot: sink0.onSnapshot });
    const shard0Indexes = [...captured];
    captured.length = 0;

    const sink1 = frameSink();
    await runLoadShard(plan, { shard: shards[1], rngSeed, timelineOrigin, onSnapshot: sink1.onSnapshot });
    const shard1Indexes = [...captured];
    captured.length = 0;

    const runEndMs = Date.now();

    // iteration.index by RANGE: each shard ran EXACTLY its contiguous global slice.
    expect([...shard0Indexes].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect([...shard1Indexes].sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9]);
    // A raw worker frame carries no coordinator-merge stamp; each ran its quota, and its
    // requestedConcurrency is this shard's PER-SHARD slotCount (2), not the global 4.
    expect(sink0.terminal().workerCount).toBeUndefined();
    expect(sink0.terminal().iterCompleted).toBe(5);
    expect(sink1.terminal().iterCompleted).toBe(5);
    expect(sink0.terminal().requestedConcurrency).toBe(2);
    expect(sink1.terminal().requestedConcurrency).toBe(2);
    // No feeders → the shard's frames report the (vacuous) single-node guarantee.
    expect(sink0.terminal().feederGuarantee).toBe("single-node");

    // Coordinator path: merge the two terminal frames, finalize the ONE artifact.
    const merged = mergePartials([sink0.terminal(), sink1.terminal()]);
    expect(merged.workerCount).toBe(2);
    // requestedConcurrency SUMS back to the global physical concurrency (2 + 2 === 4).
    expect(merged.requestedConcurrency).toBe(4);
    const mergedArt = finalizeMerged(merged, { runEndMs, provider: "multi-core" });
    expect(mergedArt.runtime.requestedConcurrency).toBe(4);
    expect(mergedArt.runtime.feederGuarantee).toBe("single-node");

    // Additive identity vs the single-machine run (clock-independent quantities only).
    expect(mergedArt.summary.totalIterations).toBe(10);
    expect(mergedArt.summary.totalIterations).toBe(directArt.summary.totalIterations);
    expect(mergedArt.summary.successfulIterations).toBe(directArt.summary.successfulIterations);
    expect(mergedArt.summary.failedIterations).toBe(directArt.summary.failedIterations);
    const epMerged = Object.fromEntries(mergedArt.endpoints.map((e) => [e.routeKey, e.requestCount]));
    const epDirect = Object.fromEntries(directArt.endpoints.map((e) => [e.routeKey, e.requestCount]));
    expect(epMerged).toEqual(epDirect);
    expect(epMerged).toEqual({ "GET /items/:id": 10, "POST /orders": 10 });
    const stepMerged = Object.fromEntries(mergedArt.steps.map((s) => [s.stepName, s.invocationCount]));
    const stepDirect = Object.fromEntries(directArt.steps.map((s) => [s.stepName, s.invocationCount]));
    expect(stepMerged).toEqual(stepDirect);
    const scMerged = Object.fromEntries(mergedArt.scenarios.map((s) => [s.scenarioId, s.iterations]));
    const scDirect = Object.fromEntries(directArt.scenarios.map((s) => [s.scenarioId, s.iterations]));
    expect(scMerged).toEqual(scDirect);

    // Sharded provenance — never claims the single-process in-process identity.
    expect(mergedArt.runtime.processModel).toBe("sharded-multi-process");
    expect(mergedArt.runtime.execution).toEqual({ provider: "multi-core", workerCount: 2 });
  });

  it("emits periodic + terminal snapshots and evaluates NO thresholds (that is coordinator work)", async () => {
    const thresholds: LoadThresholds = { transaction: { p95: "<100000ms", errorRate: "<0.5" } };
    const plan = loadRunner("shard-frames", {
      scenario: browseCheckout(),
      concurrency: 1,
      iterations: 10,
      input: ({ iteration }) => ({ sku: String(iteration.index) }),
      pacing: { thinkTime: 15 }, // real per-iteration wall-clock so the interval fires
      thresholds,
    });
    const { shards } = shardPlan(plan, 1);
    const timelineOrigin = Date.now();
    const sink = frameSink();
    // A tiny interval against a ~150ms run guarantees several periodic frames.
    await runLoadShard(plan, {
      shard: shards[0],
      rngSeed: "seed-frames",
      timelineOrigin,
      snapshotIntervalMs: 5,
      onSnapshot: sink.onSnapshot,
    });
    const runEndMs = Date.now();

    // Periodic frames land mid-run (no endReason yet); the terminal frame is emitted after
    // load:end (endReason set) and is always last (the interval is cleared before it).
    expect(sink.frames.length).toBeGreaterThanOrEqual(2);
    const terminal = sink.terminal();
    expect(terminal.endReason).toBe("iterations");
    const periodic = sink.frames.slice(0, -1);
    expect(periodic.length).toBeGreaterThanOrEqual(1);
    expect(periodic.every((f) => f.endReason === undefined)).toBe(true);
    // Frames are cumulative — the terminal is a superset of every periodic one.
    expect(terminal.iterCompleted).toBe(10);
    expect(periodic[0].iterCompleted).toBeLessThanOrEqual(terminal.iterCompleted);

    // The shard produced NO verdicts: finalizing WITHOUT the thresholds opt yields none,
    // and only the coordinator's `finalizeMerged({ thresholds })` populates them.
    const artNoGates = finalizeMerged(terminal, { runEndMs });
    expect(artNoGates.summary.thresholds).toEqual([]);
    const artWithGates = finalizeMerged(terminal, { runEndMs, thresholds });
    expect(artWithGates.summary.thresholds.length).toBeGreaterThan(0);
    expect(artWithGates.summary.thresholds.every((t) => t.status === "evaluated")).toBe(true);
  });

  it("2-shard STRIDE partition (duration-only): shards run disjoint even/odd global indexes", async () => {
    const captured: number[] = [];
    const plan = loadRunner("shard-stride", {
      scenario: loadScenario("noop").step("noop", async () => {}).build(),
      concurrency: 2,
      duration: 40, // ms — no iteration bound → stride partition
      input: ({ iteration }) => {
        captured.push(iteration.index);
        return {};
      },
      pacing: { thinkTime: 5 }, // bound the per-shard iteration count so it stays small
    });
    const { shards } = shardPlan(plan, 2);
    expect(shards[0].iterationIndexes).toEqual({ kind: "stride", offset: 0, step: 2 });
    expect(shards[1].iterationIndexes).toEqual({ kind: "stride", offset: 1, step: 2 });

    const timelineOrigin = Date.now();
    const sink0 = frameSink();
    captured.length = 0;
    await runLoadShard(plan, { shard: shards[0], rngSeed: "s", timelineOrigin, onSnapshot: sink0.onSnapshot });
    const shard0Indexes = [...captured];
    captured.length = 0;
    const sink1 = frameSink();
    await runLoadShard(plan, { shard: shards[1], rngSeed: "s", timelineOrigin, onSnapshot: sink1.onSnapshot });
    const shard1Indexes = [...captured];
    captured.length = 0;

    // Each shard ran some iterations, and iteration.index is EXACTLY its `offset + k·step`
    // stride — disjoint even (shard 0) / odd (shard 1) global indexes.
    expect(shard0Indexes.length).toBeGreaterThan(0);
    expect(shard1Indexes.length).toBeGreaterThan(0);
    shard0Indexes.forEach((idx, k) => expect(idx).toBe(k * 2)); // 0, 2, 4, …
    shard1Indexes.forEach((idx, k) => expect(idx).toBe(1 + k * 2)); // 1, 3, 5, …
    // A duration-only shard ends on the dispatch deadline.
    expect(sink0.terminal().endReason).toBe("duration");
    expect(sink1.terminal().endReason).toBe("duration");
  });

  it("segmented feeder is a HARD row boundary — no cross-shard over-draw (codex R1 P1)", async () => {
    // 2 rows, 4 iterations, 2 shards: each shard owns 1 row (segments [0,1) and [1,1)). A
    // shard must NOT reach past its segment into the other's row — else two shards return the
    // same row and the run over-reports successes (3 instead of the single-machine 2).
    const rows = [{ id: "r0" }, { id: "r1" }];
    const makePlan = () =>
      loadRunner("shard-feeder", {
        scenario: loadScenario("noop").step("noop", async () => {}).build(),
        concurrency: 2,
        iterations: 4,
        // uniquePerIteration defaults to `fail` → a past-segment draw is a feederExhausted.
        feeders: { u: feeder.fromArray(rows, { key: "id" }).uniquePerIteration() },
      });

    // Single-machine ground truth: 2 rows over 4 iterations → 2 success + 2 feederExhausted.
    const directArt = await runLoad(makePlan());
    expect(directArt.summary.successfulIterations).toBe(2);
    expect(directArt.summary.failedIterations).toBe(2);

    const plan = makePlan();
    const { shards } = shardPlan(plan, 2);
    expect(shards[0].feederSegments['["shared","u"]']).toEqual({ offset: 0, length: 1 });
    expect(shards[1].feederSegments['["shared","u"]']).toEqual({ offset: 1, length: 1 });

    const timelineOrigin = Date.now();
    const s0 = frameSink();
    const s1 = frameSink();
    await runLoadShard(plan, { shard: shards[0], rngSeed: "s", timelineOrigin, onSnapshot: s0.onSnapshot });
    await runLoadShard(plan, { shard: shards[1], rngSeed: "s", timelineOrigin, onSnapshot: s1.onSnapshot });
    const runEndMs = Date.now();

    const merged = mergePartials([s0.terminal(), s1.terminal()]);
    const mergedArt = finalizeMerged(merged, { runEndMs, provider: "multi-core" });

    // Merged successes == single-machine (2), NOT 3 — the segment bounded the draw.
    expect(mergedArt.summary.successfulIterations).toBe(2);
    expect(mergedArt.summary.successfulIterations).toBe(directArt.summary.successfulIterations);
    expect(mergedArt.summary.failedIterations).toBe(2);
    // A segmented (row-split) strategy is best-effort under sharding → DEGRADED, never
    // single-node — even though the merged artifact is sharded-multi-process.
    expect(merged.feederGuarantee).toBe("degraded");
    expect(mergedArt.runtime.feederGuarantee).toBe("degraded");
  });

  it("a slot-indexed feeder shards exactly — frame reports the DISTRIBUTED guarantee", async () => {
    // uniquePerVu shards by the GLOBAL slot index (not a row segment), so a shard carries no
    // feederSegments entry and reports "distributed" (a real sharded guarantee, not degraded).
    const plan = loadRunner("shard-vu", {
      scenario: loadScenario("noop").step("noop", async () => {}).build(),
      concurrency: 2,
      iterations: 4,
      feeders: { u: feeder.fromArray([{ id: "a" }, { id: "b" }], { key: "id" }).uniquePerVu() },
    });
    const { shards } = shardPlan(plan, 2);
    expect(shards[0].feederSegments).toEqual({}); // slot-indexed → no row segment
    const sink = frameSink();
    await runLoadShard(plan, { shard: shards[0], rngSeed: "s", timelineOrigin: Date.now(), onSnapshot: sink.onSnapshot });
    expect(sink.terminal().feederGuarantee).toBe("distributed");
  });

  it("ramp aligns to the ABSOLUTE startAt + rampDelay — a late worker records start lateness (codex R1 P2)", async () => {
    // A worker whose clock is already past `startAt + rampDelay` must open its slots at once
    // (not sleep the full rampDelay from its late wake), and record the overshoot — otherwise
    // its whole ramp curve shifts forward and eats the dispatch window.
    const plan = loadRunner("ramp", {
      scenario: loadScenario("noop").step("noop", async () => {}).build(),
      concurrency: 2,
      iterations: 2,
      rampUp: 1000, // ms → slot 0 target +0, slot 1 target +1000
    });
    const { shards } = shardPlan(plan, 1); // one worker, global slots 0 and 1
    const startAt = 50_000;
    const result = await runLoadShard(plan, {
      shard: shards[0],
      rngSeed: "s",
      startAt,
      now: () => 100_000, // frozen, well past startAt + every rampDelay → every slot is late
      onSnapshot: () => {},
    });
    // slot targets 50_000 and 51_000; now 100_000 → overshoots 50_000 and 49_000 → max 50_000.
    expect(result.maxStartLatenessMs).toBe(50_000);
    expect(result.endReason).toBe("iterations");
  });

  it("records start lateness even with NO rampUp (startAt-only distributed plan) (follow-up P2)", async () => {
    // A startAt-only plan (no rampUp) is a common distributed shape: the ramp is zero-delay,
    // but a late worker must STILL record its lateness (the old `if (rampUp)` guard skipped it).
    const plan = loadRunner("late-no-ramp", {
      scenario: loadScenario("noop").step("noop", async () => {}).build(),
      concurrency: 1,
      iterations: 1,
      // no rampUp
    });
    const { shards } = shardPlan(plan, 1);
    const result = await runLoadShard(plan, {
      shard: shards[0],
      rngSeed: "s",
      startAt: 50_000,
      now: () => 80_000, // 30s past startAt, zero ramp delay → 30s late
      onSnapshot: () => {},
    });
    expect(result.maxStartLatenessMs).toBe(30_000);
  });

  it("AWAITS the terminal snapshot's async delivery before resolving (follow-up P1)", async () => {
    // D1-3 delivers frames over IPC/network (async). The shard must not resolve (a worker must
    // not exit) until the TERMINAL frame's delivery completes, or the final state is lost.
    const plan = loadRunner("async-snap", {
      scenario: loadScenario("noop").step("noop", async () => {}).build(),
      concurrency: 1,
      iterations: 2,
    });
    const { shards } = shardPlan(plan, 1);
    let terminalDelivered = false;
    const frames: LoadReducerPartialV1[] = [];
    await runLoadShard(plan, {
      shard: shards[0],
      rngSeed: "s",
      timelineOrigin: Date.now(),
      onSnapshot: async (p) => {
        frames.push(p);
        if (p.endReason !== undefined) {
          // Terminal frame: simulate a slow async (IPC) delivery. If runLoadShard did NOT await
          // it, `terminalDelivered` would still be false right after the run resolved.
          await new Promise<void>((r) => setTimeout(r, 30));
          terminalDelivered = true;
        }
      },
    });
    expect(terminalDelivered).toBe(true);
    expect(frames[frames.length - 1].endReason).toBe("iterations");
  });

  it("external abort winds the shard down cleanly with endReason 'abort' (D1-3 hook)", async () => {
    // A D1 coordinator's `abort` frame (or the worker harness reacting to a lost channel) trips
    // this signal: the shard stops opening iterations, drains, and finalizes with endReason
    // "abort" — the SAME clean path as a natural end, just triggered externally.
    const plan = loadRunner("shard-abort", {
      scenario: loadScenario("noop").step("noop", async () => { await new Promise((r) => setTimeout(r, 10)); }).build(),
      concurrency: 2,
      duration: "10s",
    });
    const { shards } = shardPlan(plan, 1);
    const ac = new AbortController();
    const frames: LoadReducerPartialV1[] = [];
    const startedAt = Date.now();
    const result = await runLoadShard(plan, {
      shard: shards[0],
      rngSeed: "s",
      timelineOrigin: Date.now(),
      snapshotIntervalMs: 15,
      abort: ac.signal,
      // Abort on the first PERIODIC frame — proof the run was underway when it was cut short.
      onSnapshot: (p) => {
        frames.push(p);
        if (p.endReason === undefined) ac.abort();
      },
    });
    expect(result.endReason).toBe("abort");
    expect(frames[frames.length - 1].endReason).toBe("abort");
    // Aborted well before the 10s duration bound (it did not run to the deadline).
    expect(Date.now() - startedAt).toBeLessThan(9_000);
  });

  it("an already-aborted shard skips the startAt wait and ends immediately (abort before dispatch)", async () => {
    const plan = loadRunner("shard-abort-prestart", {
      scenario: loadScenario("noop").step("noop", async () => {}).build(),
      concurrency: 1,
      iterations: 5,
    });
    const { shards } = shardPlan(plan, 1);
    const ac = new AbortController();
    ac.abort();
    const startedAt = Date.now();
    const result = await runLoadShard(plan, {
      shard: shards[0],
      rngSeed: "s",
      timelineOrigin: Date.now(),
      startAt: Date.now() + 60_000, // 60s in the future — an aborted shard must NOT wait on it
      abort: ac.signal,
    });
    expect(result.endReason).toBe("abort");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
