import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { LoadPlan } from "@glubean/sdk/load";
import { runLoad } from "../orchestrator.js";
import { MultiCoreProvider } from "./provider.js";
import { runLoadMultiCore } from "./coordinator.js";

// Chaos / failure-path coverage for the multi-core coordinator (proposal §7.4 executionStatus +
// coverage, §9 feeder degraded, §10.5 no-progress liveness + abort). Every scenario is REAL-spawn
// and DETERMINISTIC — a worker signals its state through an explicit sentinel (a file it writes, a
// synchronous wedge, an assign-time crash), never a wall-clock guess — and every path asserts NO
// ORPHAN (assertAllReaped) so a failing chaos case can never leak a child into the test runner.
//
// Like coordinator.test.ts, the coordinator SPAWNS the BUILT dist worker-harness.js, so the sdk +
// runner must be built first (CI's `pnpm -r build` / a local `CI=1 pnpm -r build`). Fixtures live
// UNDER the runner package so the child's `@glubean/sdk/load` import resolves through the workspace.

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_ROOT = resolve(__dirname, "..", "..", "..");
const TMP_DIR = join(RUNNER_ROOT, ".tmp-mc-chaos");

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

// Every injected provider is closed by runLoadMultiCore; afterEach is a backstop so a failing
// assertion can never leak a child (protecting the test runner via the no-orphan guarantee).
const liveProviders: MultiCoreProvider[] = [];
afterEach(async () => {
  await Promise.all(liveProviders.map((p) => p.close().catch(() => {})));
  liveProviders.length = 0;
});
function newProvider(): MultiCoreProvider {
  // A short SIGTERM grace keeps the SIGKILL backstop prompt for a wedged (event-loop-blocked)
  // worker that cannot process fd-EOF/SIGTERM cooperatively.
  const p = new MultiCoreProvider({ cwd: RUNNER_ROOT, sigtermGraceMs: 1_000, forwardOutput: false });
  liveProviders.push(p);
  return p;
}

async function writeFixture(name: string, src: string): Promise<{ file: string; plan: LoadPlan }> {
  const file = join(TMP_DIR, `${name}.load.ts`);
  await writeFile(file, src);
  const ns = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const plan = Object.values(ns).find(
    (v): v is LoadPlan =>
      typeof v === "object" && v !== null && (v as { __glubean_type?: string }).__glubean_type === "load-runner",
  );
  if (!plan) throw new Error(`fixture ${name} exported no LoadPlan`);
  return { file, plan };
}

/** Assert every pid is gone (no orphan): after `provider.close()` resolves each worker has exited,
 *  so `kill(pid, 0)` throws ESRCH. */
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

// ── chaos / failure paths ─────────────────────────────────────────────────────

describe("runLoadMultiCore — chaos / failure paths", () => {
  it("SIGKILLs a worker mid-run → PARTIAL with the survivor's data censored at the victim's last snapshot, no orphan/hang", async () => {
    // A duration-bounded run keeps every worker dispatching. The victim (w1) writes a sentinel the
    // instant it is safely mid-run (4 iterations in, snapshots already streaming) so the test can
    // SIGKILL it DETERMINISTICALLY — not on a timer. w0 keeps running to the duration bound and
    // delivers a final frame; the killed w1 contributes only its last observed snapshot (censored),
    // so the run is judged partial, the survivor's counts are intact, and no worker leaks.
    const KILL_MIDRUN = `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
import { writeFileSync } from "node:fs";
const wi = process.argv.indexOf("--worker-id");
const myId = wi >= 0 ? process.argv[wi + 1] : "w?";
let n = 0;
const scenario = loadScenario("kill-midrun")
  .step("ping", async (ctx) => {
    await ctx.http.get(ctx.vars.require("BASE_URL") + "/ping").json();
    n++;
    // The victim signals it is safely mid-run (snapshots flowing) so the test can kill it without
    // a timing gamble.
    if (myId === "w1" && n === 4) { try { writeFileSync(ctx.vars.require("KILL_SENTINEL"), "go"); } catch {} }
    await new Promise((r) => setTimeout(r, 25));
  })
  .build();
export const plan = loadRunner("mc-kill-midrun", { scenario, concurrency: 4, duration: "1s" });
`;
    const { file, plan } = await writeFixture("chaos-kill-midrun", KILL_MIDRUN);
    const provider = newProvider();
    const sentinel = join(TMP_DIR, `kill-sentinel-${Date.now()}`);
    const vars = { BASE_URL: base, KILL_SENTINEL: sentinel };

    let killed = false;
    const killWatch = setInterval(() => {
      if (killed || !existsSync(sentinel)) return;
      const victim = provider.workers.find((w) => w.workerId === "w1");
      if (victim && victim.pid > 0) {
        killed = true;
        try {
          process.kill(victim.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }, 10);
    killWatch.unref?.();

    const artifact = await runLoadMultiCore(plan, {
      file,
      workerCount: 2,
      cwd: RUNNER_ROOT,
      vars,
      snapshotIntervalMs: 20,
      provider,
    });
    clearInterval(killWatch);

    expect(killed).toBe(true); // the victim was genuinely killed mid-run (sentinel fired)
    // The run neither crashed nor hung — it produced a partial artifact from the survivor.
    expect(artifact.summary.executionStatus).toBe("partial");
    expect(artifact.runtime.execution?.provider).toBe("multi-core");
    expect(artifact.summary.totalIterations).toBeGreaterThan(0);
    expect(artifact.summary.successfulIterations).toBe(artifact.summary.totalIterations); // every ping ok

    // Coverage records the gap: one of two workers delivered a final snapshot.
    const cov = artifact.runtime.execution?.coverage;
    expect(cov?.workersFinal).toBe(1);
    expect(cov?.workersExpected).toBe(2);
    // observedUntil censors the global coverage at the earliest per-worker cutoff — the victim's
    // last snapshot — so the merged timeline never shows the dead worker running past it (no
    // phantom concurrency).
    expect(cov?.observedUntil).toBeDefined();

    const workers = artifact.runtime.execution?.workers ?? [];
    const survivor = workers.find((w) => w.id === "w0");
    const victim = workers.find((w) => w.id === "w1");
    // Survivor ran its shard to the duration bound and finished normally.
    expect(survivor?.endReason).toBe("duration");
    expect(survivor?.terminationCause).toBe("normal");
    // Victim: killed from outside (channel dropped, no `done`) → channel-lost, its observation
    // censored at its last snapshot.
    expect(victim?.terminationCause).toBe("channel-lost");
    expect(victim?.observationCutoff).toBeDefined();
    expect(cov?.observedUntil?.ms).toBe(victim?.observationCutoff?.ms);

    const notes = artifact.runtime.execution?.notes ?? [];
    expect(notes.some((s) => /partial: 1 worker\(s\) lost/.test(s))).toBe(true);

    assertAllReaped(provider.workers.map((w) => w.pid));
  }, 30_000);

  it("no-progress watchdog kills a WEDGED worker (event loop blocked) → PARTIAL, survivor runs on, no orphan", async () => {
    // w1 blocks its event loop forever on its first iteration — no periodic snapshot can fire and
    // it can never `done`, so a naive coordinator would hang on the settle wait. The no-progress
    // watchdog must detect the silence past `noProgressMs`, kill w1 (SIGTERM→SIGKILL), and let w0's
    // completed shard finalize as partial. Deterministic: the wedge is an explicit synchronous
    // infinite loop, and the watchdog window is injected small so the test need not wait 60s.
    const WEDGE = `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
const wi = process.argv.indexOf("--worker-id");
const myId = wi >= 0 ? process.argv[wi + 1] : "w?";
const scenario = loadScenario("wedge")
  .step("ping", async (ctx) => {
    await ctx.http.get(ctx.vars.require("BASE_URL") + "/ping").json();
    // The victim wedges its event loop — no more frames flow, tripping the coordinator watchdog.
    if (myId === "w1") { while (true) { /* wedge: synchronous infinite loop */ } }
    await new Promise((r) => setTimeout(r, 15));
  })
  .build();
export const plan = loadRunner("mc-wedge", { scenario, concurrency: 4, iterations: 16 });
`;
    const { file, plan } = await writeFixture("chaos-wedge", WEDGE);
    const provider = newProvider();
    const artifact = await runLoadMultiCore(plan, {
      file,
      workerCount: 2,
      cwd: RUNNER_ROOT,
      vars: { BASE_URL: base },
      snapshotIntervalMs: 25,
      noProgressMs: 1_500, // detect the wedge quickly (default is 60s)
      provider,
    });

    expect(artifact.summary.executionStatus).toBe("partial");
    expect(artifact.runtime.execution?.provider).toBe("multi-core");
    // w0 owns iterations [0,8); w1 wedged before completing any → 8 of 16 ran.
    expect(artifact.summary.totalIterations).toBe(8);
    expect(artifact.summary.successfulIterations).toBe(8);

    const cov = artifact.runtime.execution?.coverage;
    expect(cov?.workersFinal).toBe(1);
    expect(cov?.workersExpected).toBe(2);

    const workers = artifact.runtime.execution?.workers ?? [];
    const survivor = workers.find((w) => w.id === "w0");
    const wedged = workers.find((w) => w.id === "w1");
    expect(survivor?.endReason).toBe("iterations");
    expect(survivor?.terminationCause).toBe("normal");
    // The watchdog's verdict is reported explicitly as the no-progress termination cause.
    expect(wedged?.terminationCause).toBe("no-progress");

    const notes = artifact.runtime.execution?.notes ?? [];
    expect(notes.some((s) => /no-progress: 1 worker\(s\) killed/.test(s))).toBe(true);

    assertAllReaped(provider.workers.map((w) => w.pid));
  }, 30_000);

  it("stamps feederGuarantee=degraded end-to-end for a segmented feeder whose shard segments exhaust (§9)", async () => {
    // A `uniquePerIteration` feeder with FEWER rows than iterations. `shardPlan` splits the rows
    // into per-worker segments (best-effort under sharding → the run's feeder guarantee DROPS to
    // "degraded"), and each too-small segment exhausts under the default `fail` policy → the excess
    // iterations become framework `feederExhausted` failures (not SUT errors). The MERGED artifact
    // must carry the degraded guarantee, while a single-machine run of the SAME plan stays
    // "single-node" (the whole-row space is local) — the §9 distinction, verified end-to-end.
    const FEEDER_DEGRADED = `
import { loadScenario, loadRunner, feeder } from "@glubean/sdk/load";
const rows = feeder.fromArray(
  Array.from({ length: 8 }, (_, i) => ({ id: "r" + i })),
  { key: "id" },
);
const scenario = loadScenario("feeder-seg")
  .step("use", async (ctx) => {
    await ctx.http.get(ctx.vars.require("BASE_URL") + "/items/" + ctx.input.id).json();
  })
  .build();
export const plan = loadRunner("mc-feeder-degraded", {
  scenario,
  concurrency: 2,
  iterations: 16,                                // 16 iterations, 8 rows → segments exhaust
  feeders: { row: rows.uniquePerIteration() },   // default exhausted policy: "fail" → feederExhausted
  input: ({ feed }) => ({ id: feed.row.id }),
});
`;
    const { file, plan } = await writeFixture("chaos-feeder-degraded", FEEDER_DEGRADED);
    const vars = { BASE_URL: base };
    const seed = "feeder-degraded-seed";

    // Single-machine baseline: same plan + seed → same additive outcome, but the guarantee is the
    // local "single-node".
    const baseline = await runLoad(plan, { vars, rngSeed: seed });
    expect(baseline.runtime.feederGuarantee).toBe("single-node");
    expect(baseline.summary.failedIterations).toBeGreaterThan(0); // exhaustion actually happened

    const provider = newProvider();
    const artifact = await runLoadMultiCore(plan, {
      file,
      workerCount: 2,
      cwd: RUNNER_ROOT,
      vars,
      rngSeed: seed,
      snapshotIntervalMs: 25,
      provider,
    });

    // The distributed run degrades the feeder guarantee (segment skew is possible under sharding).
    expect(artifact.runtime.feederGuarantee).toBe("degraded");
    // Additive parity holds despite the degrade: the index set [0,16) is identical, so served vs
    // exhausted totals match the single-machine run exactly.
    expect(artifact.summary.totalIterations).toBe(16);
    expect(artifact.summary.successfulIterations).toBe(baseline.summary.successfulIterations);
    expect(artifact.summary.failedIterations).toBe(baseline.summary.failedIterations);
    expect(artifact.summary.failedIterations).toBeGreaterThan(0);

    assertAllReaped(provider.workers.map((w) => w.pid));
  }, 30_000);

  it("broadcasts abort on the signal across 3 workers → every worker drains cleanly (endReason+cause abort), complete, no orphan", async () => {
    // A coordinator-side abort (a CLI SIGINT) is broadcast to EVERY worker; each drains and
    // finalizes cleanly (endReason "abort"), still delivering its terminal frame, so the run is a
    // COMPLETE abort (data intact) — not a partial. Every worker's per-record cause is "abort", and
    // the whole process group is reaped.
    const DURATION = `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
const scenario = loadScenario("ping")
  .step("ping", async (ctx) => { await ctx.http.get(ctx.vars.require("BASE_URL") + "/ping").json(); })
  .build();
export const plan = loadRunner("mc-chaos-abort", { scenario, concurrency: 3, duration: "10s" });
`;
    const { file, plan } = await writeFixture("chaos-abort", DURATION);
    const provider = newProvider();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 700); // fire comfortably after the shared start
    const artifact = await runLoadMultiCore(plan, {
      file,
      workerCount: 3,
      cwd: RUNNER_ROOT,
      vars: { BASE_URL: base },
      snapshotIntervalMs: 25,
      abort: ac.signal,
      provider,
    });
    clearTimeout(timer);

    expect(artifact.summary.endReason).toBe("abort");
    expect(artifact.summary.executionStatus).toBe("complete"); // clean drain → data complete
    const workers = artifact.runtime.execution?.workers ?? [];
    expect(workers).toHaveLength(3);
    expect(workers.every((w) => w.endReason === "abort")).toBe(true);
    expect(workers.every((w) => w.terminationCause === "abort")).toBe(true);
    expect(artifact.runtime.execution?.coverage?.workersFinal).toBe(3);

    assertAllReaped(provider.workers.map((w) => w.pid));
  }, 30_000);
});

// ── single-machine parity ─────────────────────────────────────────────────────

describe("runLoadMultiCore — single-machine parity (equivalence + distributed metadata)", () => {
  it("a mix + continuation + custom metrics + thresholds run matches single-machine runLoad on verdict, advisories, metrics, continuation (with the same seed)", async () => {
    // The strongest equivalence claim: a REALISTIC plan (traffic mix, producer-release
    // continuation, three custom metrics, transaction + custom-metric thresholds) run multi-core
    // must be, to the user, "single-machine + correct distributed metadata". With the SAME rngSeed
    // the mix selection (`prng(seed,"mix",globalIndex)`) is identical per iteration, so the two
    // runs are bit-equivalent on every additive/derived fact — only provenance (processModel /
    // execution block) legitimately differs.
    const PARITY = `
import { loadScenario, loadRunner, loadMixEntry, rate, counter, trend } from "@glubean/sdk/load";

const fast = loadScenario("fast")
  .step("get", async (ctx) => {
    await ctx.http.get(ctx.vars.require("BASE_URL") + "/ping").json();
    ctx.metrics.okRate.add(true);
    ctx.metrics.hits.add();
    ctx.metrics.lat.add(42);
  })
  .build();

const job = loadScenario("job")
  .step("submit", async (ctx) => {
    await ctx.http.post(ctx.vars.require("BASE_URL") + "/orders", { json: {} }).json();
    await ctx.report.primaryComplete("submitted", { releaseProducerSlot: true });
    ctx.metrics.okRate.add(true);
    ctx.metrics.hits.add();
  })
  .step("poll", async (ctx) => {
    await ctx.http.get(ctx.vars.require("BASE_URL") + "/items/1").json();
    ctx.metrics.lat.add(7);
  })
  .build();

export const plan = loadRunner("mc-parity", {
  scenarios: [
    loadMixEntry({ id: "fast", scenario: fast, weight: 60 }),
    loadMixEntry({ id: "job", scenario: job, weight: 40 }),
  ],
  concurrency: 4,
  iterations: 24,
  continuation: { maxOutstanding: 8, maxConcurrent: 4, drainTimeout: "2s" },
  metrics: { okRate: rate(), hits: counter(), lat: trend({ unit: "ms" }) },
  thresholds: {
    transaction: { errorRate: "<100%" },
    customMetric: { okRate: { rate: ">0%" } },
  },
});
`;
    const { file, plan } = await writeFixture("parity-mix", PARITY);
    const vars = { BASE_URL: base };
    const seed = "parity-fixed-seed";

    const baseline = await runLoad(plan, { vars, rngSeed: seed });

    const provider = newProvider();
    const artifact = await runLoadMultiCore(plan, {
      file,
      workerCount: 2,
      cwd: RUNNER_ROOT,
      vars,
      rngSeed: seed,
      snapshotIntervalMs: 25,
      provider,
    });

    // ── additive equivalence ──
    expect(artifact.summary.totalIterations).toBe(24);
    expect(artifact.summary.totalIterations).toBe(baseline.summary.totalIterations);
    expect(artifact.summary.successfulIterations).toBe(baseline.summary.successfulIterations);
    expect(artifact.summary.failedIterations).toBe(baseline.summary.failedIterations);
    expect(artifact.summary.executionStatus).toBe("complete");

    // Endpoint request counts per routeKey@phase match exactly.
    const epCount = (art: typeof artifact) =>
      Object.fromEntries(art.endpoints.map((e) => [`${e.routeKey}@${e.phase}`, e.requestCount]));
    expect(epCount(artifact)).toEqual(epCount(baseline));

    // ── threshold VERDICT parity ──
    const normThresholds = (art: typeof artifact) =>
      art.summary.thresholds
        .map((t) => ({
          scope: t.scope,
          target: t.target ?? null,
          metric: t.metric,
          expression: t.expression,
          pass: t.pass,
          status: t.status ?? "evaluated",
          actual: t.actual,
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(artifact.summary.thresholds.length).toBeGreaterThan(0);
    expect(normThresholds(artifact)).toEqual(normThresholds(baseline));
    expect(artifact.summary.pass).toBe(baseline.summary.pass);

    // ── custom-metric parity (untagged totals, `complete` flag aside — it's a merge-only field) ──
    const normMetrics = (art: typeof artifact) =>
      (art.summary.customMetrics ?? [])
        .map((m) => {
          const total = { ...m.series.find((s) => Object.keys(s.tags).length === 0) };
          delete (total as { complete?: boolean }).complete;
          return { metricId: m.metricId, kind: m.kind, unit: m.unit ?? null, total };
        })
        .sort((a, b) => a.metricId.localeCompare(b.metricId));
    expect(artifact.summary.customMetrics?.length).toBe(3);
    expect(normMetrics(artifact)).toEqual(normMetrics(baseline));

    // ── continuation summary parity ──
    expect(artifact.summary.continuation?.releasedProducerSlots).toBe(
      baseline.summary.continuation?.releasedProducerSlots,
    );
    expect(artifact.summary.continuation?.releasedProducerSlots).toBeGreaterThan(0);
    expect(artifact.summary.continuation?.abortedByDrainTimeout).toBe(
      baseline.summary.continuation?.abortedByDrainTimeout,
    );
    expect(artifact.summary.continuation?.rejectedReleaseSignals).toBe(
      baseline.summary.continuation?.rejectedReleaseSignals,
    );

    // ── advisories parity ──
    expect((artifact.summary.advisories ?? []).slice().sort()).toEqual(
      (baseline.summary.advisories ?? []).slice().sort(),
    );

    // ── provenance: multi-core is CORRECTLY distinct, not silently masquerading as single ──
    expect(artifact.runtime.processModel).toBe("sharded-multi-process");
    expect(artifact.runtime.processModel).not.toBe(baseline.runtime.processModel);
    expect(artifact.runtime.execution?.provider).toBe("multi-core");
    expect(baseline.runtime.execution?.provider).toBe("in-process");
    expect(artifact.runtime.execution?.workerCount).toBe(2);

    assertAllReaped(provider.workers.map((w) => w.pid));
  }, 40_000);
});
