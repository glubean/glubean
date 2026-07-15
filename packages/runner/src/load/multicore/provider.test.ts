import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import type { LoadPlan } from "@glubean/sdk/load";
import { runLoad } from "../orchestrator.js";
import { shardPlan } from "../shard.js";
import { mergePartials, finalizeMerged, type LoadReducerPartialV1 } from "../partial.js";
import { Fd3WorkerChannel, MultiCoreProvider, type ChannelCloseReason, type LoadWorkerChannel } from "./provider.js";
import { encodeWorkerMessage, type ShardResultObservablesV1, type WorkerMessage } from "./protocol.js";

// The multi-core provider SPAWNS the BUILT dist/load/multicore/worker-harness.js, so the sdk +
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
function newProvider(extra: Partial<ConstructorParameters<typeof MultiCoreProvider>[0]> = {}): MultiCoreProvider {
  // forwardOutput:false keeps the test runner's stdout quiet — the streams are still DRAINED
  // (the provider always attaches a data listener), which is exactly what the anti-hang fix needs.
  const p = new MultiCoreProvider({ cwd: RUNNER_ROOT, sigtermGraceMs: 1_000, forwardOutput: false, ...extra });
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
  // Generous start lead: a shared absolute instant far enough out that spawn + assign + start all
  // land on every worker before it (headroom for a slow/loaded CI; the run itself is unaffected).
  const startAt = Date.now() + (opts.startLeadMs ?? 300);
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
  it("spawns 2 workers, runs 2 shards, and the merged run equals a single-machine runLoad", async () => {
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

  it("isolates the control channel structurally: no IPC surface, and the accidental fd-3 path is neutralized", async () => {
    // The control channel lives on a dedicated fd 4, not Node IPC, so the child has no IPC surface
    // at all; and the conventional fd 3 is a /dev/null placeholder, so an accidental writeSync(3)
    // is harmlessly swallowed (never reaching control). User code probes every path —
    // process.send/channel/message, an fd-3 write, a stdout flood — none reaches the control channel.
    const FLOOD = `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
import { writeSync } from "node:fs";
let sawMessageEvent = false;
process.on("message", () => { sawMessageEvent = true; }); // must NEVER fire — there is no IPC
const scenario = loadScenario("noisy")
  .step("spam", async (ctx) => {
    // (1) stdout flood — a separate stream from the fd-4 control channel.
    for (let i = 0; i < 40; i++) {
      console.log(JSON.stringify({ v: 1, type: "abort", reason: "INJECTED-VIA-STDOUT" }));
      process.stdout.write(JSON.stringify({ v: 1, type: "done", workerId: "w-FORGED-STDOUT" }) + "\\n");
    }
    // (2) the process IPC surface is simply GONE — the guarded pattern skips (connected falsy),
    // and process.send is not even a function.
    let guardedTried = false;
    if (process.connected && typeof process.send === "function") {
      guardedTried = true; process.send({ v: 1, type: "done", workerId: "w-FORGED-SEND" });
    }
    // (3) an accidental write to the conventional fd 3 — a /dev/null placeholder, so it is
    // swallowed (write succeeds, goes nowhere) and never reaches the control channel on fd 4.
    let fd3Err = "swallowed";
    try { writeSync(3, JSON.stringify({ v: 1, type: "done", workerId: "w-FORGED-FD3" }) + "\\n"); }
    catch (e) { fd3Err = e.code || String(e); }
    console.log("PROBE send=" + typeof process.send + " connected=" + !!process.connected +
      " channel=" + typeof process.channel + " msgEvent=" + sawMessageEvent + " guardedTried=" + guardedTried +
      " fd3Err=" + fd3Err);
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
    // …and user code confirmed: no IPC surface, and the fd-3 write was swallowed by /dev/null
    // (write succeeded, went nowhere — never reaching control).
    expect(c.stdout).toContain(
      "PROBE send=undefined connected=false channel=undefined msgEvent=false guardedTried=false fd3Err=swallowed",
    );
    // The real hello was consumed at acquire — over the isolated fd 4, not stdout.
    expect(channels[0].hello.protocolVersion).toBe(1);
    // NO forged control frame (stdout-injected, process.send, or fd-3) ever reached the parent:
    // the only frames are legitimate worker→coordinator types with the coordinator-minted workerId.
    expect(c.messages.some((m) => (m.type as string) === "abort")).toBe(false);
    expect(c.messages.some((m) => String((m as { workerId?: string }).workerId ?? "").startsWith("w-FORGED"))).toBe(false);
    for (const m of c.messages) {
      expect(["hello", "progress", "snapshot", "result", "done", "error"]).toContain(m.type);
    }

    await provider.close();
    assertAllReaped(channels.map((ch) => ch.pid));
  });

  it("tolerates a garbage line on the control channel: the worker de-framer ignores it, run completes", async () => {
    // Defense-in-depth (trust model): if a non-protocol line ever reaches the control fd, the
    // worker's NDJSON de-framer must DROP it, not crash. Inject raw garbage onto a worker's
    // control pipe (white-box) BEFORE assign; the worker ignores it and the run finishes cleanly.
    const { file, plan } = await writeFixture("garbage", HTTP_FIXTURE("mc-garbage"));
    const { shards } = shardPlan(plan, 1);
    const provider = newProvider();
    const channels = await provider.acquire(1, { abort: new AbortController().signal });
    // Reach the private control stream and write raw, non-JSON bytes + a JSON-but-not-protocol
    // line. Both must be dropped by the worker's de-framer.
    const control = (channels[0] as unknown as { control: NodeJS.WritableStream }).control;
    control.write("this is not json at all\n");
    control.write(JSON.stringify({ hello: "wrong shape", nope: true }) + "\n");
    const collected = await driveRun(channels, {
      file,
      planId: plan.id,
      shards: shards.map((s) => ({ workerId: s.workerId, shard: s })),
      vars: { BASE_URL: base },
      snapshotIntervalMs: 25,
    });
    const c = collected[0];
    expect(c.done, "worker should ignore garbage and finish").toBe(true);
    expect(c.result?.endReason).toBe("iterations");

    await provider.close();
    assertAllReaped(channels.map((ch) => ch.pid));
  });

  it("does not hang when a worker floods stdout past the OS pipe buffer (streams are drained)", async () => {
    // ~1.5MB of stdout across the run — far beyond the ~64KB OS pipe buffer. If the provider did
    // not continuously drain the child's stdout, the worker would BLOCK on a write before it
    // could send `done`, hanging the run. The provider drains, so the run finishes cleanly.
    const HEAVY = `
import { loadScenario, loadRunner } from "@glubean/sdk/load";
const CHUNK = "x".repeat(4096);
const scenario = loadScenario("verbose")
  .step("shout", async (ctx) => {
    for (let i = 0; i < 100; i++) console.log(CHUNK);
    ctx.expect(1).toBe(1);
  })
  .build();
export const plan = loadRunner("mc-heavy-stdout", { scenario, concurrency: 2, iterations: 4 });
`;
    const { file, plan } = await writeFixture("heavy-stdout", HEAVY);
    const { shards } = shardPlan(plan, 2);
    const provider = newProvider(); // forwardOutput:false → drain-and-discard, no test spam
    const channels = await provider.acquire(2, { abort: new AbortController().signal });
    const pids = channels.map((c) => c.pid);
    const collected = await driveRun(channels, {
      file,
      planId: plan.id,
      shards: shards.map((s) => ({ workerId: s.workerId, shard: s })),
      vars: {},
      snapshotIntervalMs: 25,
    });
    for (const c of collected) {
      expect(c.done, `${c.workerId} should finish despite heavy stdout`).toBe(true);
      expect(c.result).toBeDefined();
    }
    await provider.close();
    assertAllReaped(pids);
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
    // acquire's failure path terminated anything it spawned.
    for (const ch of provider.workers) assertAllReaped([ch.pid]);
  });

  it("rejects acquire on a spawn failure and close() does not hang (error settles the channel)", async () => {
    // A non-existent node binary makes `spawn` emit ONLY an `error` event, never `exit` — the
    // regression: a channel whose `exited` resolves solely on `exit` would leave acquire's
    // failure path (`await close()`) waiting forever. With the fix, `error` settles `exited`.
    const provider = newProvider({ nodeExecPath: "/nonexistent/node-binary-xyz" });
    const acquired = provider.acquire(2, { abort: new AbortController().signal });
    // Guard: if the fix regressed, this whole promise would hang — bound it so the test fails
    // loudly (times out at the assertion) instead of hanging the suite.
    const outcome = await Promise.race([
      acquired.then(() => "resolved").catch((e) => `rejected:${(e as Error).message}`),
      new Promise<string>((r) => setTimeout(() => r("HUNG"), 8_000)),
    ]);
    expect(outcome).not.toBe("HUNG");
    expect(outcome).toMatch(/^rejected:/);
    // And close() (already invoked by acquire's catch) completes — bound it too.
    const closed = await Promise.race([
      provider.close().then(() => "closed"),
      new Promise<string>((r) => setTimeout(() => r("HUNG"), 8_000)),
    ]);
    expect(closed).toBe("closed");
  });

  it("fails acquire FAST on a version-incompatible worker hello, not after the join deadline (§4)", async () => {
    // A version-skewed worker stamps a different protocol ENVELOPE version on its hello. The
    // regression: the tolerant de-framer would DROP that undecodable frame, the explicit version
    // check would never fire, and acquire would idle until the 60s join deadline. With the fix, a
    // recognizable-but-wrong-version envelope is surfaced → acquire rejects immediately.
    process.env.GLUBEAN_MC_TEST_PROTOCOL_V = "999"; // test-only harness seam: stamp envelope v=999
    try {
      const provider = newProvider();
      const start = Date.now();
      const err = await provider
        .acquire(1, { abort: new AbortController().signal, joinDeadlineMs: 15_000 })
        .then(
          () => {
            throw new Error("acquire should have rejected on a version-incompatible hello");
          },
          (e: Error) => e,
        );
      // A version-incompatibility reject (mentions the protocol), NOT a join-deadline timeout.
      expect(err.message).toMatch(/protocol|incompatible/i);
      expect(err.message).not.toMatch(/did not hello/);
      // FAST: well under the 15s join deadline (proves it did not wait it out).
      expect(Date.now() - start).toBeLessThan(8_000);
    } finally {
      delete process.env.GLUBEAN_MC_TEST_PROTOCOL_V;
    }
  });

  it("fails EXPLICITLY on Windows (unsupported) rather than crashing in a confusing way", async () => {
    // Multi-core relies on POSIX extra-fd inheritance (fd 4) that Node child_process does not
    // provide on Windows; acquire must reject with a clear message, not an opaque openSync/spawn crash.
    const orig = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const provider = newProvider();
      await expect(provider.acquire(1, { abort: new AbortController().signal })).rejects.toThrow(/not supported on Windows/i);
    } finally {
      if (orig) Object.defineProperty(process, "platform", orig);
    }
  });
});

/** A minimal ChildProcess stub for unit-testing Fd3WorkerChannel supervision without a real
 *  spawn: an EventEmitter with a controllable `pid`, a fake fd-4 control stream, and the
 *  members the channel touches. */
class FakeChild extends EventEmitter {
  connected = true;
  killed = false;
  lastSignal: NodeJS.Signals | number | undefined;
  readonly stdout = null;
  readonly stderr = null;
  /** The fd-4 control pipe stub (a PassThrough duplex). */
  readonly control = new PassThrough();
  readonly stdio: Array<PassThrough | null>;
  constructor(public pid: number | undefined) {
    super();
    // fd 3 is a closed placeholder; the control pipe sits at fd 4 (matches the provider layout).
    this.stdio = [null, null, null, null, this.control];
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.lastSignal = signal;
    return true;
  }
  disconnect(): void {
    this.connected = false;
  }
}

describe("Fd3WorkerChannel supervision — error vs exit vs unreapable (P2)", () => {
  const resolved = <T>(p: Promise<T>): Promise<T | "PENDING"> =>
    Promise.race([p, new Promise<"PENDING">((r) => setTimeout(() => r("PENDING"), 50))]);

  it("settles on a PRE-SPAWN error (no pid) so close()/acquire never hang", async () => {
    const failed = new FakeChild(undefined); // spawn failed → no pid, never emits 'exit'
    const ch = new Fd3WorkerChannel("w0", failed as unknown as ChildProcess, 100, false);
    let closeReason: ChannelCloseReason | undefined;
    ch.onClose((r) => (closeReason = r));
    failed.emit("error", new Error("EMFILE"));
    expect(ch.hasExited).toBe(true); // synthesized close — no 'exit' is ever coming
    expect(closeReason).toEqual({ kind: "error", error: expect.any(Error) });
    expect(await resolved(ch.exited)).not.toBe("PENDING"); // exited resolved
  });

  it("does NOT settle on a LIVE child's error (has pid) — waits for the real exit", async () => {
    const live = new FakeChild(4242); // spawned OK → has a pid, still running
    const ch = new Fd3WorkerChannel("w1", live as unknown as ChildProcess, 100, false);
    let closeFired = false;
    ch.onClose(() => (closeFired = true));

    // A post-spawn error (e.g. EPERM from kill()) must NOT be mistaken for an exit.
    live.emit("error", new Error("EPERM"));
    expect(ch.hasExited).toBe(false); // process is still alive — supervision continues
    expect(closeFired).toBe(false);
    expect(await resolved(ch.exited)).toBe("PENDING"); // exited still unresolved

    // close() escalates to SIGTERM (and would SIGKILL after grace); the REAL exit settles it.
    ch.close();
    expect(live.killed).toBe(true);
    live.emit("exit", 0, "SIGTERM");
    expect(ch.hasExited).toBe(true);
    expect(await resolved(ch.exited)).not.toBe("PENDING");
  });

  it("close() stays BOUNDED when the process cannot be reaped (never exits) — could-not-reap", async () => {
    // A live child whose kill() is a no-op and which never emits 'exit' (uninterruptible sleep /
    // EPERM). Without the hard deadline, close() would await `exited` forever.
    const stuck = new FakeChild(9999);
    const ch = new Fd3WorkerChannel("w2", stuck as unknown as ChildProcess, 50, false); // grace 50 → hard deadline 100ms
    let closeReason: ChannelCloseReason | undefined;
    ch.onClose((r) => (closeReason = r));
    ch.close();
    expect(stuck.killed).toBe(true); // SIGTERM was attempted
    // No real 'exit' ever comes; the hard deadline (2×grace) must settle so close() can't hang.
    const outcome = await Promise.race([
      ch.exited.then(() => "settled"),
      new Promise<string>((r) => setTimeout(() => r("HUNG"), 3_000)),
    ]);
    expect(outcome).toBe("settled");
    expect(ch.hasExited).toBe(true);
    expect(closeReason).toEqual({ kind: "could-not-reap" });
  });

  it("de-framer TOLERATES garbage lines — drops them, never escalates, keeps decoding valid frames", async () => {
    const live = new FakeChild(4242);
    const ch = new Fd3WorkerChannel("w3", live as unknown as ChildProcess, 100, false);
    const errors: Error[] = [];
    const got: WorkerMessage[] = [];
    ch.onError((e) => errors.push(e));
    ch.onMessage((m) => got.push(m));

    // Push garbage onto the inbound control stream: non-JSON, JSON-but-wrong-shape, and an empty
    // line. None may throw or escalate to onError. (A newline terminates each — a genuinely
    // partial frame just buffers until its newline, which the split-frame delivery exercises.)
    live.control.write("not json at all\n");
    live.control.write(JSON.stringify({ totally: "wrong" }) + "\n");
    live.control.write("\n");
    // A VALID frame after the garbage must still decode and be delivered (the de-framer recovered).
    live.control.write(JSON.stringify(encodeWorkerMessage({ type: "hello", protocolVersion: 1, workerId: "w3", pid: 1 })) + "\n");
    await new Promise((r) => setImmediate(r)); // let stream 'data' flush

    expect(errors).toEqual([]); // garbage was dropped, not escalated
    expect(got).toHaveLength(1); // the valid hello got through
    expect(got[0].type).toBe("hello");
  });

  it("de-framer ESCALATES an incompatible-version envelope (fast-fail) but still DROPS pure garbage", async () => {
    const live = new FakeChild(4242);
    const ch = new Fd3WorkerChannel("w4", live as unknown as ChildProcess, 100, false);
    const errors: Error[] = [];
    ch.onError((e) => errors.push(e));

    // Pure garbage: non-JSON, and JSON without a `v` envelope → DROP (no escalation).
    live.control.write("not json\n");
    live.control.write(JSON.stringify({ random: 1, type: "log" }) + "\n"); // has `type` but no `v` → drop
    await new Promise((r) => setImmediate(r));
    expect(errors).toEqual([]);

    // A recognizable envelope carrying a WRONG version (`v` ≠ ours) → ESCALATE so acquire fails fast.
    live.control.write(JSON.stringify({ v: 999, type: "hello", protocolVersion: 999, workerId: "w4", pid: 1 }) + "\n");
    await new Promise((r) => setImmediate(r));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/incompatible protocol version 999/i);
  });
});
