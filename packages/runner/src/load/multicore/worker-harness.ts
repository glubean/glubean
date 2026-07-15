/**
 * Multi-core worker harness — the child-process entry a {@link MultiCoreProvider} forks,
 * one per worker. It runs ONE shard of a load plan (`runLoadShard`) and speaks the versioned
 * control protocol over the fork's DEDICATED IPC channel (`process.send` / `process.on
 * ("message")`), NEVER over stdout. The user `.load.ts` it imports shares this process, so
 * its `console.log` / `stderr` flow to the child's stdout/stderr (the parent forwards them
 * as ordinary output) — user code has no handle on the IPC channel and thus cannot read or
 * forge a control frame (the §6/§12 isolation requirement).
 *
 * Why a forked `.js` entry that imports the `.ts` in-process (not `tsx <file>` spawned):
 * the `tsx` CLI re-spawns an inner node and forwards only fd 0/1/2, which would DROP the
 * IPC channel (the same reason `subprocess.ts` multiplexes on stdout). Instead the provider
 * forks THIS built `.js` with `--import tsx/esm` in `execArgv`, so tsx's ESM loader
 * registers IN-PROCESS (no re-spawn) and transforms the user TypeScript while the inherited
 * IPC channel stays intact. This harness and the user file therefore co-resolve one
 * `@glubean/sdk` (same runner-resolution machinery as `subprocess.ts`), so `runLoadShard`'s
 * engine carrier and the scenario's runtime carrier are identical (no split-brain).
 *
 * Lifecycle (proposal §10.5, D1-3 subset): hello → assign (import + bind, no dispatch) →
 * start{startAt} → runLoadShard (streams snapshots) → final snapshot + result + done →
 * exit. An `abort` frame trips the shard's AbortSignal so it drains + finalizes cleanly
 * (endReason "abort"), then the same completion path runs. Losing the parent (IPC
 * `disconnect`) aborts and exits promptly — the orphan backstop from the child side.
 */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type { LoadPlan } from "@glubean/sdk/load";
import { bootstrap } from "../../bootstrap.js";
import { runLoadShard } from "../orchestrator.js";
import { collectLoadPlans, withProcessEnvFallback } from "../subprocess.js";
import type { LoadReducerPartialV1 } from "../partial.js";
import {
  MULTICORE_PROTOCOL_VERSION,
  decodeCoordinatorMessage,
  encodeWorkerMessage,
  type CoordinatorMessage,
  type ShardAssignmentV1,
  type WorkerMessage,
} from "./protocol.js";

// ── Channel guard + isolation (§6 decision 6 / §12) ──────────────────────────

// The harness is USELESS without the IPC control channel — it exists to speak the protocol.
// A missing `process.send` means it was not forked with an `ipc` stdio slot; fail loudly.
if (typeof process.send !== "function") {
  process.stderr.write("multicore worker-harness: no IPC channel (must be spawned via child_process.fork with an 'ipc' stdio)\n");
  process.exit(1);
}

// Capture the control channel's SEND handle, then REPLACE `process.send` with a harmless
// no-op FACADE BEFORE any user code (the `.load.ts` and its libraries, imported in
// `handleAssign`) runs. The harness keeps its private `sendRaw`; user code's `process.send`
// now returns `false` ("not delivered") and injects nothing onto the coordinator's channel.
//
// Why a callable `() => false` and NOT `undefined`: the legitimate, common
// `if (process.connected) process.send(...)` pattern (fork-aware libraries) must not THROW.
// With `undefined`, taking that branch calls `undefined(...)` and crashes the whole shard.
// A no-op facade lets the branch run harmlessly — no throw, no injection, and `false` tells a
// well-behaved caller its send did not go through.
//
// Why `process.connected` is deliberately LEFT `true`: it is the SAME property Node's internal
// IPC `send` checks, so forcing it to `false` breaks the harness's OWN `sendRaw`
// (`ERR_IPC_CHANNEL_CLOSED`) — verified empirically. Likewise `process.channel` stays in place:
// nulling it tears down INBOUND delivery (Node gates `emit("message")` on `process.channel`),
// so the harness would stop receiving `start`/`abort`/`heartbeat`. Inbound frames reach only
// the harness's own `"message"` handler (attached below, before any user code).
//
// TRUST MODEL: isolation here is against ACCIDENTAL collision (a user file or library that
// itself calls `process.send`), consistent with the cooperative same-version worker trust
// model (D0). A determined adversary digging for the raw IPC fd (or reading `process.channel`
// directly to snoop inbound frames — which still cannot REPLY, since `process.send` no longer
// delivers) is out of scope: a user attacking their own coordinator is not a threat. This is
// the `process.send` analog of moving control off the shared stdout `WIRE_PREFIX`
// (subprocess.ts).
const sendRaw = process.send.bind(process);
process.send = () => false;

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: { "worker-id": { type: "string" } },
  strict: false,
});
// The coordinator MINTS the workerId at fork and passes it here; the harness echoes it in
// `hello` and stamps it on every frame. The parent verifies `hello.workerId` against the id
// it minted (proposal §5: "不信 payload 身份" — identity is coordinator-assigned, not
// self-claimed). Defaults keep a bare/manual launch from crashing.
const workerId = (args["worker-id"] as string | undefined) ?? "w0";

/** Send a worker frame over IPC, resolving once the channel has accepted it (so
 *  `runLoadShard` can AWAIT terminal-frame delivery before the shard resolves). */
function send(msg: WorkerMessage): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sendRaw(encodeWorkerMessage(msg), (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

// ── Worker state machine ─────────────────────────────────────────────────────

/** The shard's cooperative-abort controller (tripped by an `abort` frame or a lost parent);
 *  handed to `runLoadShard` as `opts.abort`, which drains + finalizes with endReason "abort". */
const abortController = new AbortController();
let running = false;
let finished = false;
/** The assignment, once bound. */
let bound: { plan: LoadPlan; assignment: ShardAssignmentV1 } | undefined;
/** A `start` that arrived before `assign` finished (import is async) — replayed once bound. */
let pendingStart: Extract<CoordinatorMessage, { type: "start" }> | undefined;
/** Whether an `abort` arrived before the run began — honoured the moment dispatch would start. */
let abortedBeforeStart = false;

/** Exit cleanly, guarding against a double-exit from overlapping paths. */
function finishClean(): never {
  finished = true;
  process.exit(0);
}

/** Report a crash (uncaught) on stderr and exit nonzero WITHOUT a `done` — the parent's
 *  supervisor detects the missing terminal + the exit and surfaces it (parity with the
 *  single-file harness). Sent best-effort as an `error` frame too, if the channel is up. */
function crash(message: string): never {
  try {
    sendRaw(encodeWorkerMessage({ type: "error", workerId, message }));
  } catch {
    // channel already gone — stderr is the backstop
  }
  process.stderr.write(message + "\n");
  process.exit(1);
}

process.on("uncaughtException", (error) => {
  crash(`multicore worker ${workerId} crashed: ${error?.stack ?? error?.message ?? String(error)}`);
});
process.on("unhandledRejection", (reason: unknown) => {
  crash(`multicore worker ${workerId} crashed: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

// Orphan backstop (child side): if the parent's end of the IPC closes (coordinator exited
// or called close()), no one is left to receive frames — abort any in-flight run and exit
// promptly so this process never lingers as an orphan (complements the parent supervisor's
// SIGTERM→SIGKILL from the other direction). §10.5 "channel 丢失 → 终止".
process.on("disconnect", () => {
  if (finished) return;
  abortController.abort();
  // Give an in-flight drain a brief microtask window, then exit unconditionally.
  if (running) setTimeout(() => process.exit(0), 0).unref?.();
  else process.exit(0);
});

/** Bind the assignment: import the user file (tsx transforms it in-process) and select the
 *  plan. A handled failure (bad file / missing plan / bad import) emits `error` + `done` and
 *  exits 0 — like a per-plan failure in the single-file harness, never a crash. */
async function handleAssign(assignment: ShardAssignmentV1): Promise<void> {
  // Register project plugins (matchers / protocol adapters) before importing the load file,
  // which may use them — same as the test/contract/load paths.
  await bootstrap(process.cwd());

  let ns: Record<string, unknown>;
  try {
    ns = (await import(pathToFileURL(assignment.file).href)) as Record<string, unknown>;
  } catch (e) {
    await send({
      type: "error",
      workerId,
      message: `failed to import load file ${assignment.file}: ${e instanceof Error ? e.message : String(e)} (ensure @glubean/sdk is resolvable from the file)`,
    });
    await send({ type: "done", workerId });
    finishClean();
  }

  const plan = collectLoadPlans(ns).find((p) => p.id === assignment.planId);
  if (plan === undefined) {
    await send({
      type: "error",
      workerId,
      message: `load plan "${assignment.planId}" not found in ${assignment.file}`,
    });
    await send({ type: "done", workerId });
    finishClean();
  }

  bound = { plan, assignment };
  // A `start` (or `abort`) that raced ahead of assign now applies.
  if (pendingStart !== undefined) {
    const s = pendingStart;
    pendingStart = undefined;
    void beginRun(s.startAt, s.dispatchDeadline);
  }
}

/** Run the shard: `runLoadShard`, streaming snapshots over IPC, then final snapshot +
 *  result + done. The completion path is shared by a natural end AND an abort (the abort
 *  just makes `runLoadShard` wind down early with endReason "abort"). */
async function beginRun(startAt: number, dispatchDeadline: number | undefined): Promise<void> {
  if (bound === undefined || running || finished) return;
  running = true;
  const { plan, assignment } = bound;
  const envVars = withProcessEnvFallback(assignment.vars);
  const envSecrets = withProcessEnvFallback(assignment.secrets);

  // The LAST frame `runLoadShard` hands to `onSnapshot` is its terminal (final) export —
  // already `stampShardFrame`-stamped with this shard's `requestedConcurrency` /
  // `feederGuarantee` / advisories. We can't tell periodic from terminal at call time (the
  // callback is unmarked), so we stream every frame as live progress (`final:false`) and,
  // after the shard resolves, re-send the captured last (stamped) frame as the authoritative
  // `final:true` — the one a coordinator merges. (One redundant terminal frame; the merge
  // consumes only `final:true`.)
  let lastFrame: LoadReducerPartialV1 | undefined;
  const onSnapshot = (partial: LoadReducerPartialV1): Promise<void> => {
    lastFrame = partial;
    return send({ type: "snapshot", workerId, final: false, partial });
  };

  try {
    const result = await runLoadShard(plan, {
      shard: assignment.shard,
      rngSeed: assignment.rngSeed,
      timelineOrigin: assignment.timelineOrigin,
      vars: envVars,
      secrets: envSecrets,
      startAt,
      onSnapshot,
      abort: abortController.signal,
      ...(assignment.baseSession !== undefined ? { baseSession: assignment.baseSession } : {}),
      ...(dispatchDeadline !== undefined ? { dispatchDeadline } : {}),
      ...(assignment.snapshotIntervalMs !== undefined ? { snapshotIntervalMs: assignment.snapshotIntervalMs } : {}),
    });

    // Authoritative terminal frame (the stamped state the shard exported at finalize) — the
    // coordinator merges this. `lastFrame` is defined because `runLoadShard` always emits a
    // terminal frame through `onSnapshot` when one is provided.
    if (lastFrame !== undefined) {
      await send({ type: "snapshot", workerId, final: true, partial: lastFrame });
    }
    // The scalar orchestration observables the reducer state does not carry (the D1-2
    // return-value bypass, now on the wire) — a coordinator finalizes from these + the frame.
    await send({
      type: "result",
      workerId,
      observables: {
        endReason: result.endReason,
        finalizeNow: result.finalizeNow,
        mixOverrideUsed: result.mixOverrideUsed,
        peakContinuations: result.peakContinuations,
        abortedByDrainTimeout: result.abortedByDrainTimeout,
        unreleasedTailPollRan: result.unreleasedTailPollRan,
        maxStartLatenessMs: result.maxStartLatenessMs,
      },
    });
    await send({ type: "done", workerId });
    finishClean();
  } catch (e) {
    // A per-shard runtime failure (invalid plan / bad bounds that `runLoadShard` throws for)
    // is a HANDLED error, not a crash: report it + the terminal sentinel, then exit clean.
    await send({
      type: "error",
      workerId,
      message: `load shard "${plan.id}" failed: ${e instanceof Error ? e.message : String(e)}`,
      ...(e instanceof Error && e.stack ? { stack: e.stack } : {}),
    });
    await send({ type: "done", workerId });
    finishClean();
  }
}

// ── Control-frame handling ───────────────────────────────────────────────────

process.on("message", (raw: unknown) => {
  let msg: CoordinatorMessage;
  try {
    msg = decodeCoordinatorMessage(raw);
  } catch (e) {
    // A malformed / version-skewed frame from the coordinator is a protocol fault — crash
    // loudly rather than silently ignore (a same-version cooperative peer never sends one).
    crash(`multicore worker ${workerId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  switch (msg.type) {
    case "assign":
      // Bind once. A second assign is a coordinator bug — ignore (already bound).
      if (bound === undefined) void handleAssign(msg.assignment);
      break;
    case "start":
      if (bound !== undefined) void beginRun(msg.startAt, msg.dispatchDeadline);
      else pendingStart = msg; // arrived before import finished — replayed on bind
      break;
    case "abort":
      // Trip the shard's signal so it drains + finalizes cleanly (endReason "abort"). If the
      // run hasn't started yet, remember it so dispatch is skipped the instant it would begin.
      abortController.abort();
      if (!running) abortedBeforeStart = true;
      break;
    case "heartbeat":
      // Coordinator-liveness keep-alive + channel probe (§10.5 lease). The child-side
      // lease-kill-on-silence is D2; here it is a no-op beyond proving the channel is live.
      break;
  }
});

// Announce readiness. The coordinator checks `protocolVersion` here and rejects an
// incompatible worker BEFORE it ever sends `assign` (§4 "不兼容在 assign 前失败").
await send({ type: "hello", protocolVersion: MULTICORE_PROTOCOL_VERSION, workerId, pid: process.pid });

// If an abort somehow beat the run entirely (abort before start, nothing bound to run),
// there is nothing to wind down — but keep the process alive for the parent's supervised
// termination rather than exiting unilaterally (the parent owns the process group).
void abortedBeforeStart;
