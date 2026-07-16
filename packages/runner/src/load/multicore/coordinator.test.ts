import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { LoadPlan } from "@glubean/sdk/load";
import { runLoad } from "../orchestrator.js";
import { MultiCoreProvider } from "./provider.js";
import { runLoadMultiCore } from "./coordinator.js";

// The coordinator SPAWNS the BUILT dist/load/multicore/worker-harness.js, so the sdk + runner
// must be built before this test (CI's `pnpm -r build` / a local `CI=1 pnpm -r build` covers
// it). Fixtures live UNDER the runner package so the child's `@glubean/sdk/load` import
// resolves through the workspace — same approach as provider.test.ts / subprocess.test.ts.

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_ROOT = resolve(__dirname, "..", "..", "..");
const TMP_DIR = join(RUNNER_ROOT, ".tmp-mc-coord");

let server: Server;
let base: string;

beforeAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : addr}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

// Providers injected per-test are closed by runLoadMultiCore; afterEach is a backstop so a
// failing assertion can never leak a child (the no-orphan guarantee protects the test runner).
const liveProviders: MultiCoreProvider[] = [];
afterEach(async () => {
  await Promise.all(liveProviders.map((p) => p.close().catch(() => {})));
  liveProviders.length = 0;
});
function newProvider(): MultiCoreProvider {
  const p = new MultiCoreProvider({ cwd: RUNNER_ROOT, sigtermGraceMs: 1_000, forwardOutput: false });
  liveProviders.push(p);
  return p;
}

/** Write a fixture `.load.ts` and import it to get the plan (the coordinator reads the plan to
 *  shard it; the workers re-import the same file — the single source of truth). */
async function writeFixture(name: string, src: string): Promise<{ file: string; plan: LoadPlan }> {
  const file = join(TMP_DIR, `${name}.load.ts`);
  await writeFile(file, src);
  const ns = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const plan = Object.values(ns).find(
    (v): v is LoadPlan => typeof v === "object" && v !== null && (v as { __glubean_type?: string }).__glubean_type === "load-runner",
  );
  if (!plan) throw new Error(`fixture ${name} exported no LoadPlan`);
  return { file, plan };
}

/** Assert every pid is gone (no orphan) — after the provider's close() resolves, every worker
 *  has exited, so `kill(pid, 0)` throws ESRCH. */
function assertAllReaped(pids: number[]): void {
  for (const pid of pids) {
    if (pid < 0) continue;
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      alive = (e as NodeJS.ErrnoException).code !== "ESRCH";
    }
    expect(alive, `pid ${pid} should be terminated (no orphan)`).toBe(false);
  }
}

const HTTP_FIXTURE = (id: string, opts: { concurrency: number; iterations: number }) => `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
const scenario = loadScenario("ping")
  .step("ping", async (ctx) => {
    const b = ctx.vars.require("BASE_URL");
    const res = await ctx.http.get(b + "/ping").json();
    ctx.expect(res.ok).toBe(true);
  })
  .build();
export const plan = loadRunner("${id}", { scenario, concurrency: ${opts.concurrency}, iterations: ${opts.iterations} });
`;

/** submit (POST, primary) → release the slot → poll (GET, continuation): engages the
 *  producer-release continuation subsystem so the merged continuation stats are exercised. */
const CONTINUATION_FIXTURE = (id: string) => `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
const scenario = loadScenario("async-job")
  .step("submit", async (ctx) => {
    const b = ctx.vars.require("BASE_URL");
    await ctx.http.post(b + "/orders", { json: {} }).json();
    await ctx.report.primaryComplete("submitted", { releaseProducerSlot: true });
  })
  .step("poll", async (ctx) => {
    const b = ctx.vars.require("BASE_URL");
    await ctx.http.get(b + "/items/1").json();
  })
  .build();
export const plan = loadRunner("${id}", { scenario, concurrency: 4, iterations: 8,
  continuation: { maxOutstanding: 8, maxConcurrent: 4, drainTimeout: "2s" } });
`;

describe("runLoadMultiCore — end-to-end coordinator", () => {
  it("merges 2 workers into an artifact whose additive counts equal single-machine runLoad", async () => {
    const { file, plan } = await writeFixture("coord-e2e", HTTP_FIXTURE("mc-coord-e2e", { concurrency: 4, iterations: 12 }));
    const vars = { BASE_URL: base };

    const baseline = await runLoad(plan, { vars });

    const provider = newProvider();
    const artifact = await runLoadMultiCore(plan, {
      file,
      workerCount: 2,
      cwd: RUNNER_ROOT,
      vars,
      snapshotIntervalMs: 25,
      provider,
    });

    // Additive-count equivalence: the iterations-bounded index set [0,12) is identical to the
    // single-machine run, so merged totals match exactly (proposal D0/D1 acceptance).
    expect(artifact.summary.totalIterations).toBe(12);
    expect(artifact.summary.totalIterations).toBe(baseline.summary.totalIterations);
    expect(artifact.summary.successfulIterations).toBe(baseline.summary.successfulIterations);
    expect(artifact.summary.failedIterations).toBe(baseline.summary.failedIterations);
    // Endpoint request counts match the single-machine run (per routeKey@phase).
    const epCount = (art: typeof artifact) =>
      Object.fromEntries(art.endpoints.map((e) => [`${e.routeKey}@${e.phase}`, e.requestCount]));
    expect(epCount(artifact)).toEqual(epCount(baseline));

    // Sharded provenance + execution block (§11).
    expect(artifact.runtime.processModel).toBe("sharded-multi-process");
    expect(artifact.runtime.execution?.provider).toBe("multi-core");
    expect(artifact.runtime.execution?.workerCount).toBe(2);
    expect(artifact.summary.executionStatus).toBe("complete");
    expect(artifact.runtime.execution?.protocolVersion).toBe("2");
    // Coverage: both workers delivered a final snapshot; iterations fully covered.
    const cov = artifact.runtime.execution?.coverage;
    expect(cov?.workersFinal).toBe(2);
    expect(cov?.workersExpected).toBe(2);
    expect(cov?.iterationsCompleted).toBe(12);
    expect(cov?.iterationsExpected).toBe(12);
    expect(cov?.slotSecondsAchieved).toBeGreaterThan(0);
    // Per-worker records: 2 shards tiling [0,12) with 2 slots each, both ended by iterations.
    const workers = artifact.runtime.execution?.workers ?? [];
    expect(workers).toHaveLength(2);
    expect(workers.map((w) => w.id).sort()).toEqual(["w0", "w1"]);
    for (const w of workers) {
      expect(w.endReason).toBe("iterations");
      expect(w.terminationCause).toBe("normal");
      expect(w.shard.slotCount).toBe(2);
    }
    // The two shards' iteration ranges tile [0,12) with no gap/overlap.
    const ranges = workers
      .map((w) => w.shard.iterationIndexes)
      .filter((r): r is { kind: "range"; start: number; end: number } => r.kind === "range")
      .sort((a, b) => a.start - b.start);
    expect(ranges).toEqual([
      { kind: "range", start: 0, end: 6 },
      { kind: "range", start: 6, end: 12 },
    ]);

    // rngSeed recorded (a distributed run never uses the deprecated mix override, so it is
    // kept, seed-replayable) and mirrored into the self-contained execution block.
    expect(artifact.config.rngSeed).toBeDefined();
    expect(artifact.runtime.execution?.rngSeed).toBe(artifact.config.rngSeed);

    // No orphans: after runLoadMultiCore returns it has closed the provider; every pid reaped.
    assertAllReaped(provider.workers.map((w) => w.pid));
  }, 30_000);

  it("runs across 4 workers (additive counts still equal single-machine)", async () => {
    const { file, plan } = await writeFixture("coord-4w", HTTP_FIXTURE("mc-coord-4w", { concurrency: 4, iterations: 20 }));
    const vars = { BASE_URL: base };
    const baseline = await runLoad(plan, { vars });

    const provider = newProvider();
    const artifact = await runLoadMultiCore(plan, {
      file,
      workerCount: 4,
      cwd: RUNNER_ROOT,
      vars,
      snapshotIntervalMs: 25,
      provider,
    });

    expect(artifact.runtime.execution?.workerCount).toBe(4);
    expect(artifact.summary.totalIterations).toBe(20);
    expect(artifact.summary.successfulIterations).toBe(baseline.summary.successfulIterations);
    expect(artifact.summary.failedIterations).toBe(baseline.summary.failedIterations);
    expect(artifact.summary.executionStatus).toBe("complete");
    expect(artifact.runtime.execution?.coverage?.workersFinal).toBe(4);
    assertAllReaped(provider.workers.map((w) => w.pid));
  }, 30_000);

  it("clamps the worker count to the plan's capacity and records the reason", async () => {
    // concurrency 2 caps the workers at 2 even though 4 were requested (§5.2).
    const { file, plan } = await writeFixture("coord-clamp", HTTP_FIXTURE("mc-coord-clamp", { concurrency: 2, iterations: 6 }));
    const vars = { BASE_URL: base };
    const baseline = await runLoad(plan, { vars });

    const provider = newProvider();
    const artifact = await runLoadMultiCore(plan, {
      file,
      workerCount: 4,
      cwd: RUNNER_ROOT,
      vars,
      snapshotIntervalMs: 25,
      provider,
    });

    expect(artifact.runtime.execution?.workerCount).toBe(2); // clamped 4 → 2
    expect(artifact.summary.totalIterations).toBe(baseline.summary.totalIterations);
    const notes = artifact.runtime.execution?.notes ?? [];
    expect(notes.some((n) => /clamped 4 → 2/.test(n) && /concurrency=2/.test(n))).toBe(true);
    assertAllReaped(provider.workers.map((w) => w.pid));
  }, 30_000);

  it("merges the continuation subsystem stats across workers", async () => {
    const { file, plan } = await writeFixture("coord-cont", CONTINUATION_FIXTURE("mc-coord-cont"));
    const vars = { BASE_URL: base };
    const baseline = await runLoad(plan, { vars });

    const provider = newProvider();
    const artifact = await runLoadMultiCore(plan, {
      file,
      workerCount: 2,
      cwd: RUNNER_ROOT,
      vars,
      snapshotIntervalMs: 25,
      provider,
    });

    expect(artifact.runtime.slotModel).toBe("producer-released");
    const c = artifact.summary.continuation;
    expect(c).toBeDefined();
    // Every iteration released its producer slot; summed across workers === the single-machine
    // total (8 iterations, 8 releases, all drained).
    expect(c?.releasedProducerSlots).toBe(baseline.summary.continuation?.releasedProducerSlots);
    expect(c?.releasedProducerSlots).toBe(8);
    expect(artifact.summary.totalIterations).toBe(8);
    expect(artifact.summary.successfulIterations).toBe(8);
    assertAllReaped(provider.workers.map((w) => w.pid));
  }, 30_000);

  it("throws on a run with no usable result and STILL reaps every worker (no orphan on error)", async () => {
    // Every worker hard-exits on its first step before emitting any snapshot → no usable
    // merged result (§7.4 failed). runLoadMultiCore rejects, and its `finally` still closes
    // the provider — the error path leaves no orphan.
    const CRASH = `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
const scenario = loadScenario("crash")
  .step("die", async () => { process.exit(137); })
  .build();
export const plan = loadRunner("mc-crash", { scenario, concurrency: 2, iterations: 4 });
`;
    const { file, plan } = await writeFixture("coord-crash", CRASH);
    const provider = newProvider();
    await expect(
      runLoadMultiCore(plan, { file, workerCount: 2, cwd: RUNNER_ROOT, vars: { BASE_URL: base }, provider }),
    ).rejects.toThrow(/no usable worker result/);
    assertAllReaped(provider.workers.map((w) => w.pid));
  }, 30_000);

  it("broadcasts abort on the signal → workers drain + finalize (endReason abort), no orphan", async () => {
    // A duration-bounded run kept dispatching; the coordinator broadcasts `abort` on the
    // signal, so every worker winds down cleanly (endReason "abort") and still delivers its
    // terminal frame — the run finalizes as a complete abort, and the provider is reaped.
    const DURATION = `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
const scenario = loadScenario("ping")
  .step("ping", async (ctx) => {
    const b = ctx.vars.require("BASE_URL");
    await ctx.http.get(b + "/ping").json();
  })
  .build();
export const plan = loadRunner("mc-abort", { scenario, concurrency: 2, duration: "10s" });
`;
    const { file, plan } = await writeFixture("coord-abort", DURATION);
    const provider = newProvider();
    const ac = new AbortController();
    // Fire the abort comfortably after the shared start (startLead 300ms) so the run is
    // genuinely dispatching when it arrives.
    const timer = setTimeout(() => ac.abort(), 800);
    const artifact = await runLoadMultiCore(plan, {
      file,
      workerCount: 2,
      cwd: RUNNER_ROOT,
      vars: { BASE_URL: base },
      snapshotIntervalMs: 25,
      abort: ac.signal,
      provider,
    });
    clearTimeout(timer);

    expect(artifact.summary.endReason).toBe("abort");
    expect(artifact.runtime.execution?.provider).toBe("multi-core");
    // The workers still delivered terminal frames (a clean abort drain), so data is complete.
    expect(artifact.runtime.execution?.workers?.every((w) => w.endReason === "abort")).toBe(true);
    assertAllReaped(provider.workers.map((w) => w.pid));
  }, 30_000);

  it("aligns dispatch across workers even when the user file imports SLOWLY (two-phase ready barrier)", async () => {
    // A slow user-file import (top-level await) must NOT eat the dispatch window: the coordinator
    // waits for every worker's `ready` ack and only THEN commits a shared startAt in their
    // future, so no worker starts late. With the old fixed-lead approach startAt would already be
    // ~700ms in the past when a worker finally bound → large startLateness.
    const SLOW_IMPORT = `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
await new Promise((r) => setTimeout(r, 800)); // simulate a slow user-file import / bootstrap
const scenario = loadScenario("ping")
  .step("ping", async (ctx) => { await ctx.http.get(ctx.vars.require("BASE_URL") + "/ping").json(); })
  .build();
export const plan = loadRunner("mc-slow-import", { scenario, concurrency: 4, iterations: 12 });
`;
    const { file, plan } = await writeFixture("coord-slow-import", SLOW_IMPORT);
    const provider = newProvider();
    const artifact = await runLoadMultiCore(plan, {
      file,
      workerCount: 2,
      cwd: RUNNER_ROOT,
      vars: { BASE_URL: base },
      snapshotIntervalMs: 25,
      provider,
    });

    expect(artifact.summary.totalIterations).toBe(12);
    expect(artifact.summary.executionStatus).toBe("complete");
    // Every worker started close to the committed startAt — the ~800ms import did NOT become
    // start lateness (it would have, ~650ms+, under a fixed pre-ready lead).
    const maxLateness = Math.max(...(artifact.runtime.execution?.workers ?? []).map((w) => w.startLatenessMs ?? 0));
    expect(maxLateness).toBeLessThan(500);
    assertAllReaped(provider.workers.map((w) => w.pid));
  }, 30_000);

  it("reports each worker's REAL continuation backpressureHits (from its partial, not hardcoded 0)", async () => {
    // A tight backlog (maxOutstanding 1) forces producers to park on release → back-pressure.
    // The per-worker record must carry that observed count, read from the worker's partial.
    const BACKPRESSURE = `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
const scenario = loadScenario("async-job")
  .step("submit", async (ctx) => {
    await ctx.http.post(ctx.vars.require("BASE_URL") + "/orders", { json: {} }).json();
    await ctx.report.primaryComplete("submitted", { releaseProducerSlot: true });
  })
  .step("poll", async (ctx) => { await ctx.http.get(ctx.vars.require("BASE_URL") + "/items/1").json(); })
  .build();
export const plan = loadRunner("mc-backpressure", { scenario, concurrency: 2, iterations: 6,
  continuation: { maxOutstanding: 1 } });
`;
    const { file, plan } = await writeFixture("coord-backpressure", BACKPRESSURE);
    const provider = newProvider();
    const artifact = await runLoadMultiCore(plan, {
      file,
      workerCount: 2, // clamps to 1 (maxOutstanding=1) — the sole worker forces backpressure
      cwd: RUNNER_ROOT,
      vars: { BASE_URL: base },
      snapshotIntervalMs: 25,
      provider,
    });

    expect(artifact.summary.totalIterations).toBe(6);
    const workers = artifact.runtime.execution?.workers ?? [];
    const hits = workers.map((w) => w.continuation?.backpressureHits ?? 0);
    expect(workers.every((w) => w.continuation !== undefined)).toBe(true);
    expect(Math.max(...hits)).toBeGreaterThan(0); // real observed back-pressure, not hardcoded 0
    assertAllReaped(provider.workers.map((w) => w.pid));
  }, 30_000);

  it("survives a worker that dies DURING bind → PARTIAL run with the survivor's data, no whole-run crash", async () => {
    // w1 hard-exits during import (before it can `ready`), modelling a bootstrap crash / SIGKILL
    // in the bind window. The coordinator must broadcast `start` only to survivors — sending to
    // w1's already-closed channel would reject and sink the WHOLE run instead of the partial the
    // ready gate permits. w0 keeps running its shard; the run is judged partial.
    const KILL_ON_BIND = `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
const wi = process.argv.indexOf("--worker-id");
if (wi >= 0 && process.argv[wi + 1] === "w1") process.exit(137); // crash during bind — never readies
const scenario = loadScenario("ping")
  .step("ping", async (ctx) => { await ctx.http.get(ctx.vars.require("BASE_URL") + "/ping").json(); })
  .build();
export const plan = loadRunner("mc-kill-bind", { scenario, concurrency: 4, iterations: 12 });
`;
    const { file, plan } = await writeFixture("coord-kill-bind", KILL_ON_BIND);
    const provider = newProvider();
    const artifact = await runLoadMultiCore(plan, {
      file,
      workerCount: 2,
      cwd: RUNNER_ROOT,
      vars: { BASE_URL: base },
      snapshotIntervalMs: 25,
      provider,
    });

    // Did NOT crash — produced a partial artifact carrying the surviving worker's contribution.
    expect(artifact.summary.executionStatus).toBe("partial");
    expect(artifact.runtime.execution?.provider).toBe("multi-core");
    // w0 owns iterations [0,6); w1 (dead) contributed nothing → 6 of the 12 ran.
    expect(artifact.summary.totalIterations).toBe(6);
    expect(artifact.summary.successfulIterations).toBe(6);
    const cov = artifact.runtime.execution?.coverage;
    expect(cov?.workersFinal).toBe(1);
    expect(cov?.workersExpected).toBe(2);
    assertAllReaped(provider.workers.map((w) => w.pid));
  }, 30_000);

  it("rejects a version-skewed (v1) worker at the hello handshake — fast, not after the ready deadline (protocol v2)", async () => {
    // A stale v1 worker never sends the now-REQUIRED `ready` frame. Bumping the protocol to v2
    // makes its v1 `hello` an immediate incompatibility rejection at acquire — BEFORE the
    // coordinator ever sends `assign` or waits for `ready` — so a skewed worker can't strand the
    // coordinator on the ready deadline. The test seam stamps the worker's envelope as v1.
    process.env.GLUBEAN_MC_TEST_PROTOCOL_V = "1";
    try {
      const { file, plan } = await writeFixture("coord-v1skew", HTTP_FIXTURE("mc-v1skew", { concurrency: 2, iterations: 4 }));
      const provider = newProvider();
      const started = Date.now();
      await expect(
        runLoadMultiCore(plan, {
          file,
          workerCount: 2,
          cwd: RUNNER_ROOT,
          vars: { BASE_URL: base },
          // Long deadlines: if the fix regressed, the run would wait these out instead of failing fast.
          joinDeadlineMs: 20_000,
          readyDeadlineMs: 20_000,
          provider,
        }),
      ).rejects.toThrow(/protocol|incompatible/i);
      expect(Date.now() - started).toBeLessThan(10_000); // rejected at hello, not a 20s deadline
      assertAllReaped(provider.workers.map((w) => w.pid));
    } finally {
      delete process.env.GLUBEAN_MC_TEST_PROTOCOL_V;
    }
  }, 40_000);
});
