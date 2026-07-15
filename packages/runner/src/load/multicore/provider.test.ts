import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import type { LoadPlan } from "@glubean/sdk/load";
import { runLoad } from "../orchestrator.js";
import { shardPlan } from "../shard.js";
import { mergePartials, finalizeMerged, type LoadReducerPartialV1 } from "../partial.js";
import { MultiCoreProvider, type ChannelCloseReason, type LoadWorkerChannel } from "./provider.js";
import type { ShardResultObservablesV1, WorkerMessage } from "./protocol.js";

// The multi-core provider FORKS the BUILT dist/load/multicore/worker-harness.js, so the sdk +
// runner must be built before this test (the CI build / pre-release `pnpm -r build` covers it).
// Fixtures live UNDER the runner package so the child's `@glubean/sdk/load` import resolves
// through the workspace — same approach as subprocess.test.ts.

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_ROOT = resolve(__dirname, "..", "..", "..");
const TMP_DIR = join(RUNNER_ROOT, ".tmp-mc");

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

// Providers created per-test; always closed in afterEach so a failing test cannot leak a
// child (the no-orphan guarantee also protects the test runner itself).
const liveProviders: MultiCoreProvider[] = [];
afterEach(async () => {
  await Promise.all(liveProviders.map((p) => p.close().catch(() => {})));
  liveProviders.length = 0;
});
function newProvider(): MultiCoreProvider {
  const p = new MultiCoreProvider({ cwd: RUNNER_ROOT, sigtermGraceMs: 1_000 });
  liveProviders.push(p);
  return p;
}

/** Write a fixture `.load.ts` and dynamic-import it to get the plan (the driver models a
 *  coordinator reading the plan's config to shard it). Both the driver and the workers read
 *  the SAME file, the single source of truth. */
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

/** What one worker produced across its lifetime. */
interface Collected {
  workerId: string;
  pid: number;
  messages: WorkerMessage[];
  finalSnapshot?: LoadReducerPartialV1;
  result?: ShardResultObservablesV1;
  done: boolean;
  closeReason?: ChannelCloseReason;
  stdout: string;
  /** Resolves when the worker reaches a terminal state — `done` OR channel close. */
  settled: Promise<void>;
}

/** Wire a collector onto a channel: capture every decoded frame, the final snapshot, the
 *  result, stdout, and settle on `done` or channel close (so a crash never hangs the driver). */
function collect(channel: LoadWorkerChannel): Collected {
  const c: Collected = {
    workerId: channel.workerId,
    pid: channel.pid,
    messages: [],
    done: false,
    stdout: "",
    settled: undefined as unknown as Promise<void>,
  };
  c.settled = new Promise<void>((resolveSettle) => {
    channel.onMessage((msg) => {
      c.messages.push(msg);
      if (msg.type === "snapshot" && msg.final) c.finalSnapshot = msg.partial;
      else if (msg.type === "result") c.result = msg.observables;
      else if (msg.type === "done") {
        c.done = true;
        resolveSettle();
      }
    });
    channel.onClose((reason) => {
      c.closeReason = reason;
      resolveSettle();
    });
  });
  // stdout is a SEPARATE stream the provider never parses as protocol — collect it to prove
  // user output cannot reach the control channel.
  const cc = channel as unknown as { stdout: NodeJS.ReadableStream | null };
  cc.stdout?.on("data", (d: Buffer) => {
    c.stdout += d.toString();
  });
  return c;
}

/** Drive a full sharded run: assign each worker its shard, release dispatch at a shared
 *  absolute `startAt`, and wait for every worker to settle. `onFirstSnapshot` (optional)
 *  fires once, so a test can inject an `abort` mid-run. */
async function driveRun(
  channels: LoadWorkerChannel[],
  opts: {
    file: string;
    planId: string;
    shards: { workerId: string; shard: unknown }[];
    vars: Record<string, string>;
    snapshotIntervalMs?: number;
    startLeadMs?: number;
    onFirstSnapshot?: (channels: LoadWorkerChannel[]) => void;
  },
): Promise<Collected[]> {
  const rngSeed = randomUUID();
  const startAt = Date.now() + (opts.startLeadMs ?? 200);
  const timelineOrigin = startAt;
  const collected = channels.map(collect);

  if (opts.onFirstSnapshot) {
    let fired = false;
    for (const channel of channels) {
      channel.onMessage((msg) => {
        if (!fired && msg.type === "snapshot") {
          fired = true;
          opts.onFirstSnapshot!(channels);
        }
      });
    }
  }

  // Assign each worker its shard (bind, no dispatch yet).
  for (const channel of channels) {
    const shard = opts.shards.find((s) => s.workerId === channel.workerId)!.shard;
    await channel.send({
      type: "assign",
      assignment: {
        file: opts.file,
        planId: opts.planId,
        shard: shard as never,
        rngSeed,
        vars: opts.vars,
        secrets: {},
        timelineOrigin,
        ...(opts.snapshotIntervalMs !== undefined ? { snapshotIntervalMs: opts.snapshotIntervalMs } : {}),
      },
    });
  }
  // Release dispatch at the shared absolute instant (the §5.1 time-based start barrier).
  for (const channel of channels) {
    await channel.send({ type: "start", startAt });
  }
  await Promise.all(collected.map((c) => c.settled));
  return collected;
}

/** Assert every pid is gone (no orphan). After `provider.close()` resolves, all children
 *  have exited — `kill(pid, 0)` then throws ESRCH. */
function assertAllReaped(pids: number[]): void {
  for (const pid of pids) {
    if (pid < 0) continue;
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      alive = (e as NodeJS.ErrnoException).code !== "ESRCH" ? true : false;
    }
    expect(alive, `pid ${pid} should be terminated (no orphan)`).toBe(false);
  }
}

const HTTP_FIXTURE = (id: string) => `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
const scenario = loadScenario("ping")
  .step("ping", async (ctx) => {
    const b = ctx.vars.require("BASE_URL");
    const res = await ctx.http.get(b + "/ping").json();
    ctx.expect(res.ok).toBe(true);
  })
  .build();
export const plan = loadRunner("${id}", { scenario, concurrency: 4, iterations: 12 });
`;

describe("MultiCoreProvider end-to-end", () => {
  it("forks 2 workers, runs 2 shards, and the merged run equals a single-machine runLoad", async () => {
    const { file, plan } = await writeFixture("e2e", HTTP_FIXTURE("mc-e2e"));
    const vars = { BASE_URL: base };

    // Single-machine baseline.
    const baseline = await runLoad(plan, { vars });

    // Sharded run across 2 workers.
    const { shards } = shardPlan(plan, 2);
    expect(shards).toHaveLength(2);
    const provider = newProvider();
    const channels = await provider.acquire(2, { abort: new AbortController().signal });
    expect(channels).toHaveLength(2);
    for (const ch of channels) expect(ch.hello.protocolVersion).toBe(1);

    const pids = channels.map((c) => c.pid);
    const collected = await driveRun(channels, {
      file,
      planId: plan.id,
      shards: shards.map((s) => ({ workerId: s.workerId, shard: s })),
      vars,
      snapshotIntervalMs: 25,
    });

    // Every worker finished cleanly with a final frame + result.
    for (const c of collected) {
      expect(c.done, `${c.workerId} should send done`).toBe(true);
      expect(c.finalSnapshot, `${c.workerId} should send a final snapshot`).toBeDefined();
      expect(c.result, `${c.workerId} should send a result`).toBeDefined();
      expect(c.result!.endReason).toBe("iterations");
    }

    // Merge the terminal frames + finalize as the coordinator would (D1-4 preview).
    const finals = collected.map((c) => c.finalSnapshot!);
    const merged = mergePartials(finals);
    const runEndMs = Math.max(...collected.map((c) => c.result!.finalizeNow));
    const artifact = finalizeMerged(merged, {
      provider: "multi-core",
      runEndMs,
      timelineOrigin: finals[0].timelineOrigin,
    });

    // Additive-count equivalence: the iterations-bounded index set [0,12) is identical to the
    // single-machine run, so the merged totals match exactly (proposal D0/D1 acceptance).
    expect(artifact.summary.totalIterations).toBe(baseline.summary.totalIterations);
    expect(artifact.summary.totalIterations).toBe(12);
    expect(artifact.summary.successfulIterations).toBe(baseline.summary.successfulIterations);
    expect(artifact.summary.failedIterations).toBe(baseline.summary.failedIterations);
    // Sharded provenance stamped by finalizeMerged.
    expect(artifact.runtime.execution?.provider).toBe("multi-core");
    expect(artifact.runtime.execution?.workerCount).toBe(2);
    expect(artifact.runtime.processModel).toBe("sharded-multi-process");

    // No orphans: after close(), every worker pid is reaped.
    await provider.close();
    assertAllReaped(pids);
  });

  it("isolates the control channel: a worker flooding stdout with fake control frames cannot forge one", async () => {
    // The scenario floods stdout with well-formed-looking control JSON (`abort`, `assign`).
    const FLOOD = `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
const scenario = loadScenario("noisy")
  .step("spam", async (ctx) => {
    for (let i = 0; i < 40; i++) {
      console.log(JSON.stringify({ v: 1, type: "abort", reason: "INJECTED-VIA-STDOUT" }));
      process.stdout.write(JSON.stringify({ v: 1, type: "assign", assignment: {} }) + "\\n");
    }
    ctx.expect(1).toBe(1);
  })
  .build();
export const plan = loadRunner("mc-flood", { scenario, concurrency: 1, iterations: 3 });
`;
    const { file, plan } = await writeFixture("flood", FLOOD);
    const { shards } = shardPlan(plan, 1);
    const provider = newProvider();
    const channels = await provider.acquire(1, { abort: new AbortController().signal });
    const collected = await driveRun(channels, {
      file,
      planId: plan.id,
      shards: shards.map((s) => ({ workerId: s.workerId, shard: s })),
      vars: {},
      snapshotIntervalMs: 25,
    });

    const c = collected[0];
    expect(c.done).toBe(true);
    // The flood reached the child's stdout (a SEPARATE stream)…
    expect(c.stdout).toContain("INJECTED-VIA-STDOUT");
    // The real hello was consumed at acquire; the channel captured it there (over IPC, not
    // stdout) — proof the identity handshake itself rode the isolated channel.
    expect(channels[0].hello.protocolVersion).toBe(1);
    // …but NONE of the decoded control frames is a forged coordinator→worker type. The worker
    // only ever sends worker→coordinator frames; a stdout-injected `abort`/`assign` can never
    // appear here because control frames are read exclusively from the IPC channel.
    expect(c.messages.some((m) => (m.type as string) === "abort")).toBe(false);
    expect(c.messages.some((m) => (m.type as string) === "assign")).toBe(false);
    // Every received frame is a legitimate worker→coordinator type.
    for (const m of c.messages) {
      expect(["hello", "progress", "snapshot", "result", "done", "error"]).toContain(m.type);
    }

    await provider.close();
    assertAllReaped(channels.map((ch) => ch.pid));
  });

  it("propagates abort: workers wind down cleanly (endReason abort) and leave no orphan", async () => {
    // A duration-bounded run long enough to be aborted mid-flight.
    const DURATION = `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
const scenario = loadScenario("slow")
  .step("hit", async (ctx) => {
    const b = ctx.vars.require("BASE_URL");
    await ctx.http.get(b + "/ping").json();
  })
  .build();
export const plan = loadRunner("mc-abort", { scenario, concurrency: 2, duration: "10s", pacing: { thinkTime: "20ms" } });
`;
    const { file, plan } = await writeFixture("abort", DURATION);
    const { shards } = shardPlan(plan, 2);
    const provider = newProvider();
    const channels = await provider.acquire(2, { abort: new AbortController().signal });
    const pids = channels.map((c) => c.pid);

    const collected = await driveRun(channels, {
      file,
      planId: plan.id,
      shards: shards.map((s) => ({ workerId: s.workerId, shard: s })),
      vars: { BASE_URL: base },
      snapshotIntervalMs: 25,
      // Abort as soon as the first live snapshot proves the run is underway.
      onFirstSnapshot: (chs) => {
        for (const ch of chs) void ch.send({ type: "abort", reason: "test abort" });
      },
    });

    for (const c of collected) {
      expect(c.done, `${c.workerId} should finish after abort`).toBe(true);
      expect(c.result?.endReason, `${c.workerId} should end with reason abort`).toBe("abort");
    }

    await provider.close();
    assertAllReaped(pids);
  });

  it("survives a worker crash: the parent gets error / channel-close and does not hang", async () => {
    // A scenario that schedules a throw OUTSIDE the step's async chain → an uncaughtException
    // in the worker → the harness `crash()` path (nonzero exit, no clean `done`).
    const CRASH = `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
const scenario = loadScenario("boom")
  .step("explode", async (ctx) => {
    setTimeout(() => { throw new Error("simulated worker crash"); }, 5);
    await new Promise((r) => setTimeout(r, 60));
  })
  .build();
export const plan = loadRunner("mc-crash", { scenario, concurrency: 2, duration: "5s" });
`;
    const { file, plan } = await writeFixture("crash", CRASH);
    const { shards } = shardPlan(plan, 2);
    const provider = newProvider();
    const channels = await provider.acquire(2, { abort: new AbortController().signal });
    const pids = channels.map((c) => c.pid);

    // Must resolve (not hang): each worker settles on error/close even without a clean done.
    const collected = await driveRun(channels, {
      file,
      planId: plan.id,
      shards: shards.map((s) => ({ workerId: s.workerId, shard: s })),
      vars: { BASE_URL: base },
      snapshotIntervalMs: 25,
      startLeadMs: 100,
    });

    for (const c of collected) {
      // A crash means NO clean done — the worker either emitted a best-effort error frame or
      // just dropped the channel (exit). Either way the driver settled (no hang).
      const crashed = !c.done || c.messages.some((m) => m.type === "error") || c.closeReason !== undefined;
      expect(crashed, `${c.workerId} should surface a crash, not hang`).toBe(true);
    }

    await provider.close();
    assertAllReaped(pids);
  });

  it("rejects acquire cleanly when aborted, leaving no orphan", async () => {
    const provider = newProvider();
    const ac = new AbortController();
    ac.abort();
    await expect(provider.acquire(2, { abort: ac.signal })).rejects.toThrow(/aborted/);
    // acquire's failure path terminated anything it forked.
    for (const ch of provider.workers) assertAllReaped([ch.pid]);
  });
});
