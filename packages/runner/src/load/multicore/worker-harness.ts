/**
 * Multi-core worker harness — the child-process entry a {@link MultiCoreProvider} spawns, one
 * per worker. It runs ONE shard of a load plan (`runLoadShard`) and speaks the versioned control
 * protocol over a DEDICATED inherited pipe on fd 3 (NDJSON — one JSON frame per line), NEVER
 * over stdout and NOT over Node IPC.
 *
 * ISOLATION (§4 / §6 decision 6 / §12): the provider spawns this harness with
 * `stdio: ['pipe','pipe','pipe','ignore','pipe']`, so the process has NO IPC channel at all —
 * `process.send === undefined`, `process.on("message")` never fires, `process.connected` is
 * false. The control channel is the inherited pipe on fd 4; the conventional "first extra fd" 3 is
 * a `/dev/null` placeholder (the provider's `'ignore'`) held open for the process lifetime, so an
 * accidental `writeSync(3, …)` from a stray dependency is silently swallowed and never reaches
 * anything live. (We deliberately do NOT close fd 3: a closed fd number is immediately RECYCLED by
 * the next `open()` — and bootstrap / user-file import open many files — so `writeSync(3)` would
 * then hit a random reused descriptor, which is both unreliable and dangerous. Holding it on
 * /dev/null keeps the number occupied and the write harmless.) User `console.log` / `stderr` flow
 * to fd 1/2, which the parent forwards as ordinary output.
 *
 * TRUST MODEL (owner decision 2026-07-15): control-frame isolation is against ACCIDENTAL
 * collision (a dependency that auto-writes to a known fd / auto-calls process.send), consistent
 * with the cooperative same-version single-tenant worker trust model applied throughout D0/D1. A
 * DELIBERATE forge — user code crafting an exact protocol frame and hunting for the control
 * descriptor (fd 4) — is out of scope: a user attacking their own single-tenant coordinator is not
 * a threat model. Full structural isolation (user code in a grandchild process with no control fd)
 * is a documented future hardening if untrusted multi-tenant execution is ever added. Accordingly
 * the inbound de-framer IGNORES any non-protocol line rather than crashing, so a stray write that
 * does reach the control fd cannot take the worker down. (This is the two-way, dedicated-fd analog
 * of subprocess.ts moving control off the shared stdout `WIRE_PREFIX`, which replaced an earlier
 * fork-IPC transport whose `process.send` surface was shared with user code and had to be defended
 * repeatedly.)
 *
 * Why a spawned `.js` entry that imports the `.ts` in-process (not the `tsx` CLI): the CLI
 * re-spawns an inner node and forwards only fd 0/1/2, which would DROP the inherited fd 3.
 * Instead the provider spawns THIS built `.js` with `--import tsx/esm`, so tsx's ESM loader
 * registers IN-PROCESS (no re-spawn) and transforms the user TypeScript while fd 3 stays intact.
 * This harness and the user file therefore co-resolve one `@glubean/sdk` (same runner-resolution
 * machinery as `subprocess.ts`), so `runLoadShard`'s engine carrier and the scenario's runtime
 * carrier are identical (no split-brain).
 *
 * Lifecycle (proposal §10.5, D1-3 subset): hello → assign (import + bind, no dispatch) →
 * start{startAt} → runLoadShard (streams snapshots) → final snapshot + result + done → exit. An
 * `abort` frame trips the shard's AbortSignal so it drains + finalizes cleanly (endReason
 * "abort"), then the same completion path runs. Losing the parent (fd-3 EOF/close) aborts and
 * exits promptly — the orphan backstop from the child side.
 */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { Socket } from "node:net";
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

/** The inherited control fd (must match the provider's `CONTROL_FD`). fd 0/1/2 are the user's
 *  stdio; fd 3 is a held-open null-device placeholder the provider passes (so an accidental
 *  writeSync(3) is harmlessly swallowed); fd 4 is the dedicated duplex control pipe. */
const CONTROL_FD = 4;

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: { "worker-id": { type: "string" } },
  strict: false,
});
// The coordinator MINTS the workerId at spawn and passes it here; the harness echoes it in
// `hello` and stamps it on every frame. The parent verifies `hello.workerId` against the id it
// minted (proposal §5: "不信 payload 身份" — identity is coordinator-assigned, not self-claimed).
// Defaults keep a bare/manual launch from crashing.
const workerId = (args["worker-id"] as string | undefined) ?? "w0";

// ── Dedicated control channel on fd 4 (fd 3 = /dev/null placeholder) ──────────

// Open the inherited fd-4 pipe as a duplex socket. The harness is USELESS without it; a missing
// fd 4 means it was not spawned by MultiCoreProvider (or fd 4 was not wired) — fail loudly.
let control: Socket;
try {
  control = new Socket({ fd: CONTROL_FD, readable: true, writable: true });
} catch (e) {
  process.stderr.write(
    `multicore worker-harness: no control fd ${CONTROL_FD} (must be spawned by MultiCoreProvider): ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(1);
}
control.setEncoding("utf8");

// TEST-ONLY seam: override the protocol ENVELOPE version this worker stamps, so a test can
// exercise the coordinator's version-incompatibility fast-fail (a version-skewed worker's hello).
// Unset in production ⇒ no-op; the real version is always `MULTICORE_PROTOCOL_VERSION`.
const TEST_ENVELOPE_V =
  process.env.GLUBEAN_MC_TEST_PROTOCOL_V !== undefined ? Number(process.env.GLUBEAN_MC_TEST_PROTOCOL_V) : undefined;

/** Send a worker frame as one NDJSON line on fd 4, resolving once the frame is handed to the
 *  kernel (so `runLoadShard` can AWAIT terminal-frame delivery before the shard resolves). */
function send(msg: WorkerMessage): Promise<void> {
  const wire = encodeWorkerMessage(msg);
  if (TEST_ENVELOPE_V !== undefined) (wire as { v: number }).v = TEST_ENVELOPE_V;
  return new Promise<void>((resolve, reject) => {
    control.write(JSON.stringify(wire) + "\n", (err) => (err ? reject(err) : resolve()));
  });
}

// ── Worker state machine ─────────────────────────────────────────────────────

/** The shard's cooperative-abort controller (tripped by an `abort` frame or a lost parent);
 *  handed to `runLoadShard` as `opts.abort`, which drains + finalizes with endReason "abort". */
const abortController = new AbortController();
let running = false;
let finished = false;
let parentLost = false;
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
 *  supervisor detects the missing terminal + the exit (fd-3 close) and surfaces it. Best-effort
 *  `error` frame first, if the pipe is still writable. */
function crash(message: string): never {
  try {
    control.write(JSON.stringify(encodeWorkerMessage({ type: "error", workerId, message })) + "\n");
  } catch {
    // pipe already gone — stderr + the fd-3 close are the backstop
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

/** Orphan backstop (child side): if the parent's end of fd 3 closes (coordinator exited or
 *  called close()), no one is left to receive frames — abort any in-flight run and exit promptly
 *  so this process never lingers as an orphan (complements the parent supervisor's SIGTERM→
 *  SIGKILL from the other direction). §10.5 "channel 丢失 → 终止". */
function onParentLost(): void {
  if (finished || parentLost) return;
  parentLost = true;
  abortController.abort();
  // Give an in-flight drain a brief microtask window, then exit unconditionally.
  if (running) setTimeout(() => process.exit(0), 0).unref?.();
  else process.exit(0);
}
control.on("close", onParentLost);
control.on("end", onParentLost);
control.on("error", (e: Error) => {
  // A control-pipe error (parent gone / EBADF) is a lost parent — wind down and exit.
  process.stderr.write(`multicore worker ${workerId}: control channel error: ${e.message}\n`);
  onParentLost();
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
  // Acknowledge the bind so the coordinator's two-phase barrier can pick a shared `startAt`
  // in every worker's future (§10.5 armed→commit). Sent AFTER the (possibly slow) user-file
  // import completes — the whole point of the barrier is that the coordinator waits for this.
  await send({ type: "ready", workerId });
  // A `start` (or `abort`) that raced ahead of assign now applies.
  if (pendingStart !== undefined) {
    const s = pendingStart;
    pendingStart = undefined;
    void beginRun(s.startAt, s.dispatchDeadline, s.timelineOrigin);
  }
}

/** Run the shard: `runLoadShard`, streaming snapshots over fd 3, then final snapshot + result +
 *  done. The completion path is shared by a natural end AND an abort (the abort just makes
 *  `runLoadShard` wind down early with endReason "abort"). */
async function beginRun(
  startAt: number,
  dispatchDeadline: number | undefined,
  timelineOriginOverride: number | undefined,
): Promise<void> {
  if (bound === undefined || running || finished) return;
  running = true;
  const { plan, assignment } = bound;
  const envVars = withProcessEnvFallback(assignment.vars);
  const envSecrets = withProcessEnvFallback(assignment.secrets);
  // The `start` frame COMMITS the shared run axis (it is picked after every worker readied,
  // so it equals `startAt`); fall back to the provisional origin from `assign` for a driver
  // that set the committed value there and omitted it from `start`.
  const timelineOrigin = timelineOriginOverride ?? assignment.timelineOrigin;

  // The LAST frame `runLoadShard` hands to `onSnapshot` is its terminal (final) export —
  // already `stampShardFrame`-stamped with this shard's `requestedConcurrency` /
  // `feederGuarantee` / advisories. We can't tell periodic from terminal at call time (the
  // callback is unmarked), so we stream every frame as live progress (`final:false`) and, after
  // the shard resolves, re-send the captured last (stamped) frame as the authoritative
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
      timelineOrigin,
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
    // A per-shard runtime failure (invalid plan / bad bounds that `runLoadShard` throws for) is
    // a HANDLED error, not a crash: report it + the terminal sentinel, then exit clean.
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

// ── Control-frame handling (NDJSON on fd 3) ──────────────────────────────────

let rxBuf = "";
control.on("data", (chunk: string) => {
  rxBuf += chunk;
  let nl: number;
  while ((nl = rxBuf.indexOf("\n")) >= 0) {
    const line = rxBuf.slice(0, nl);
    rxBuf = rxBuf.slice(nl + 1);
    if (line.length > 0) handleControlLine(line);
  }
});

function handleControlLine(line: string): void {
  let msg: CoordinatorMessage;
  try {
    msg = decodeCoordinatorMessage(JSON.parse(line) as unknown);
  } catch (e) {
    // TOLERATE garbage (trust-model hardening): a non-JSON / non-protocol line — e.g. a stray
    // dependency write that somehow reached the control fd — is DROPPED, never crashes the
    // worker. A same-version cooperative coordinator only ever sends valid frames, so a dropped
    // line is an anomaly worth a one-line stderr note (not the control channel; won't confuse a
    // reader). (This is subprocess.ts's WIRE discipline: unrecognized lines are ignored.)
    process.stderr.write(`multicore worker ${workerId}: ignoring unparseable control line: ${e instanceof Error ? e.message : String(e)}\n`);
    return;
  }
  switch (msg.type) {
    case "assign":
      // Bind once. A second assign is a coordinator bug — ignore (already bound).
      if (bound === undefined) void handleAssign(msg.assignment);
      break;
    case "start":
      if (bound !== undefined) void beginRun(msg.startAt, msg.dispatchDeadline, msg.timelineOrigin);
      else pendingStart = msg; // arrived before import finished — replayed on bind
      break;
    case "abort":
      // Trip the shard's signal so it drains + finalizes cleanly (endReason "abort"). If the run
      // hasn't started yet, remember it so dispatch is skipped the instant it would begin.
      abortController.abort();
      if (!running) abortedBeforeStart = true;
      break;
    case "heartbeat":
      // Coordinator-liveness keep-alive + channel probe (§10.5 lease). The child-side
      // lease-kill-on-silence is D2; here it is a no-op beyond proving the channel is live.
      break;
  }
}

// Announce readiness. The coordinator checks `protocolVersion` here and rejects an incompatible
// worker BEFORE it ever sends `assign` (§4 "不兼容在 assign 前失败").
await send({ type: "hello", protocolVersion: MULTICORE_PROTOCOL_VERSION, workerId, pid: process.pid });

// If an abort somehow beat the run entirely (abort before start, nothing bound to run), there is
// nothing to wind down — but keep the process alive for the parent's supervised termination
// rather than exiting unilaterally (the parent owns the process group).
void abortedBeforeStart;
