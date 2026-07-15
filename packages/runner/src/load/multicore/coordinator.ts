/**
 * Multi-core load coordinator (proposal §4 收尾流程 / §7 partial 收集·merge). The parent
 * side of a sharded run: `runLoadMultiCore` takes a `LoadPlan` the caller already imported
 * (the load-harness, which co-resolves the project's `@glubean/sdk`), splits it with
 * `shardPlan`, pulls N workers up with a {@link MultiCoreProvider}, drives the shared
 * time-based start barrier, fans in each worker's terminal reducer snapshot + scalar
 * observables, and folds them into ONE finalized `LoadArtifact` with `mergePartials` +
 * `finalizeMerged` (the D0 merge layer — NOT re-implemented here).
 *
 * This is the CENTRAL half of "聚合在边缘、合并在中心" (§1): each worker runs the existing
 * orchestrator loop over its shard and exports cumulative `LoadReducerPartialV1` frames; the
 * coordinator never sees raw events, only the terminal frames it merges.
 *
 * Lifecycle / no-orphan (§10.5): the provider is acquired inside a `try` whose `finally`
 * ALWAYS `close()`s it — the run's normal end, any error, and an abort (SIGINT) all reap
 * every worker (SIGTERM → SIGKILL → bounded deadline), so `runLoadMultiCore` can never leave
 * an orphan. An abort broadcasts an `abort` control frame first so each worker drains +
 * finalizes cleanly (endReason "abort") and still delivers its terminal frame.
 *
 * Scope (D1-4): the COMPLETE (all workers delivered a final snapshot) normal path plus the
 * BASIC `partial` / `failed` data-completeness judgment (§7.4). Full chaos handling —
 * per-state timeouts, clock-handshake segments, wedged-worker watchdog, invalid-snapshot
 * censoring nuance, the §6.2 conformance verdict — is D1-5. Windows is unsupported (the
 * provider fails loudly; callers pre-check and steer users to in-process).
 */
import { randomUUID } from "node:crypto";
import type {
  LoadArtifact,
  LoadCoordTime,
  LoadEndReason,
  LoadExecutionCoverage,
  LoadExecutionStatus,
  LoadExecutionWorker,
  LoadPlan,
  LoadShardIterationIndexes,
  LoadWorkerTerminationCause,
} from "@glubean/sdk/load";
import { shardPlan, type LoadShard } from "../shard.js";
import { finalizeMerged, mergePartials, type LoadReducerPartialV1 } from "../partial.js";
import { MultiCoreProvider, type LoadWorkerChannel, type LoadWorkerProvider, type ChannelCloseReason } from "./provider.js";
import { MULTICORE_PROTOCOL_VERSION, type ShardResultObservablesV1 } from "./protocol.js";

/** The provider surface the coordinator drives: `acquire` workers (proposal §5) PLUS the
 *  bounded no-orphan `close()` it calls on every exit path. {@link MultiCoreProvider}
 *  implements it; a test may inject a stub. */
export interface CoordinatorProvider extends LoadWorkerProvider {
  close(): Promise<void>;
}

/** How far in the future the shared absolute `startAt` instant is placed, giving spawn +
 *  every `assign` + every `start` time to land on all workers before it (§5.1 barrier). A
 *  late `start` does not desync the run — a worker holds until this instant regardless —
 *  but a comfortable lead avoids workers recording `startLatenessMs` on a loaded machine. */
const DEFAULT_START_LEAD_MS = 300;

/** Options for {@link runLoadMultiCore}. The `plan` argument carries the shape (projection /
 *  config / thresholds); these are the runtime knobs a coordinator supplies at dispatch. */
export interface RunLoadMultiCoreOptions {
  /** Absolute path to the user `.load.ts` file — every worker imports it (the plan LOCATOR,
   *  not the plan object, so the worker builds the plan with the PROJECT's sdk). */
  file: string;
  /** REQUESTED worker count. `shardPlan` clamps it to the plan's capacity (§5.2:
   *  concurrency / iterations / continuation bounds); the effective count is reported in the
   *  artifact's execution block (with the clamp reason in `notes`). */
  workerCount: number;
  /** Project root — drives the provider's runner resolution and is the workers' cwd. */
  cwd: string;
  /** Resolved environment vars for the engine core (ctx.vars). */
  vars?: Record<string, string>;
  /** Resolved secrets for the engine core (ctx.secrets). */
  secrets?: Record<string, string>;
  /** Base session each iteration copies. The coordinator is the ONE place a base session is
   *  seeded (§4); it must be JSON-safe to cross the wire (a non-serializable value fails the
   *  worker's decode). D1-4 passes through what the caller supplies (a plan-level seed hook
   *  is future work). */
  baseSession?: Record<string, unknown>;
  /** Root seed for the run's counter-keyed RNG streams (§6.5) — generated ONCE and handed
   *  identically to every shard. Default: a fresh UUID. */
  rngSeed?: string;
  /** Periodic snapshot cadence (ms) each worker uses; omitted → the kernel default (15s).
   *  Injectable so a test need not wait 15s for a frame. */
  snapshotIntervalMs?: number;
  /** Lead (ms) before the shared `startAt` instant. Default {@link DEFAULT_START_LEAD_MS}. */
  startLeadMs?: number;
  /** Deadline for every worker to `hello` after spawn (§5, multi-core default 60s). */
  joinDeadlineMs?: number;
  /** Grace after SIGTERM before SIGKILL per worker (provider default 3s). */
  sigtermGraceMs?: number;
  /** Echo each worker's stdout/stderr to the coordinator's stdout/stderr. Default true
   *  (parity with the single-machine subprocess). */
  forwardOutput?: boolean;
  /** Node executable used to spawn workers (default `process.execPath`). */
  nodeExecPath?: string;
  /** Cooperative abort (a CLI SIGINT). When it fires the coordinator broadcasts an `abort`
   *  control frame so every worker winds down cleanly (endReason "abort") and still delivers
   *  its terminal frame, then closes the provider. */
  abort?: AbortSignal;
  /** Coordinator clock (default `Date.now`) — the authoritative run axis (§7.2/§8). */
  now?: () => number;
  /** Inject a provider (tests). Default: a fresh {@link MultiCoreProvider} bound to `cwd`.
   *  Whichever is used, `runLoadMultiCore` `close()`s it on every exit (no-orphan). */
  provider?: CoordinatorProvider;
}

/** What one worker produced across the run — the fan-in the coordinator merges + reports. */
interface WorkerCollection {
  shard: LoadShard;
  channel: LoadWorkerChannel;
  /** The most recent snapshot of ANY kind (a lost worker's last valid frame, §7.4). */
  latestSnapshot?: LoadReducerPartialV1;
  /** The authoritative terminal frame (`final: true`) — present iff the worker finished. */
  finalSnapshot?: LoadReducerPartialV1;
  /** The scalar orchestration observables (present iff the worker delivered `result`). */
  observables?: ShardResultObservablesV1;
  done: boolean;
  /** A per-worker `error` frame message, if any (a handled shard failure). */
  errorMessage?: string;
  closeReason?: ChannelCloseReason;
  /** Resolves when the worker reaches a terminal state (`done` OR channel close). */
  settled: Promise<void>;
}

/** A domain-tagged coordinator instant from an epoch-ms value (the D1 coordinator axis IS
 *  wall-clock epoch ms — the clock-handshake mapping onto a separate monotonic domain is
 *  D2/§8; every cross-worker instant in the execution block shares this one axis). */
function coordTime(ms: number): LoadCoordTime {
  return { domain: "coordMono", ms };
}

/**
 * Run a `LoadPlan` across N local worker processes and return the ONE merged, finalized
 * `LoadArtifact` — the multi-core coordinator entry (proposal §4/§7). Additive quantities
 * (iterations / successes / failures / endpoint counts / histogram buckets) equal a
 * single-machine `runLoad` of the same plan for an iterations-bounded run (the `[0, N)`
 * index set is identical), and the artifact carries `multi-core` provenance.
 *
 * @throws before spawning if the plan cannot shard (`shardPlan`'s validation), and — after a
 *   post-start run that yielded NO usable worker snapshot — a "no usable result" error
 *   (§7.4 `failed`; the full failed-artifact path is D1-5). The provider is always closed.
 */
export async function runLoadMultiCore(
  plan: LoadPlan,
  opts: RunLoadMultiCoreOptions,
): Promise<LoadArtifact> {
  const now = opts.now ?? Date.now;
  // §5.2 split + clamp — pure, no process yet. Throws for an unshardable plan (no
  // termination bound / bad bounds) BEFORE any worker is spawned.
  const { shards, workerCount, runLevel, clampedFrom, clampReason } = shardPlan(plan, opts.workerCount);

  const rngSeed = opts.rngSeed ?? randomUUID();
  const provider =
    opts.provider ??
    new MultiCoreProvider({
      cwd: opts.cwd,
      ...(opts.forwardOutput !== undefined ? { forwardOutput: opts.forwardOutput } : {}),
      ...(opts.sigtermGraceMs !== undefined ? { sigtermGraceMs: opts.sigtermGraceMs } : {}),
      ...(opts.nodeExecPath !== undefined ? { nodeExecPath: opts.nodeExecPath } : {}),
    });

  // Every path out of the acquire — normal, error, abort — MUST close the provider (§10.5
  // no-orphan). abort listener is removed in the same `finally`.
  const abort = opts.abort;
  let onAbort: (() => void) | undefined;
  try {
    const channels = await provider.acquire(workerCount, {
      abort: abort ?? new AbortController().signal,
      ...(opts.joinDeadlineMs !== undefined ? { joinDeadlineMs: opts.joinDeadlineMs } : {}),
    });

    // Bind each shard to the channel the provider minted the SAME positional id for
    // (`w${i}` on both sides, §5 "不信 payload 身份").
    const byId = new Map(channels.map((c) => [c.workerId, c]));
    const collections: WorkerCollection[] = shards.map((shard) => {
      const channel = byId.get(shard.workerId);
      if (channel === undefined) {
        throw new Error(`runLoadMultiCore: no channel for shard ${shard.workerId} (provider/shard id mismatch)`);
      }
      return collectWorker(shard, channel);
    });

    // A single authoritative run axis: `timelineOrigin` is the coordinator's t0 (every
    // worker offset is computed against it, so their frames merge); `startAt` is a shared
    // FUTURE instant every worker holds until before dispatching (§5.1 barrier). Using
    // `timelineOrigin === startAt` puts offset 0 at the synchronized start.
    const startAt = now() + (opts.startLeadMs ?? DEFAULT_START_LEAD_MS);
    const timelineOrigin = startAt;
    // A duration bound becomes an ABSOLUTE dispatch deadline (§6/§8.2); an iterations-only
    // run has none (workers stop when their quota is exhausted).
    const dispatchDeadline = runLevel.durationMs !== undefined ? startAt + runLevel.durationMs : undefined;

    // Broadcast an abort frame on SIGINT so workers drain + finalize cleanly (they still
    // deliver a terminal frame, so the merge below still runs). Best-effort — a dead channel
    // just rejects the send.
    if (abort !== undefined) {
      onAbort = () => {
        for (const c of collections) void c.channel.send({ type: "abort", reason: "coordinator abort (SIGINT)" }).catch(() => {});
      };
      if (abort.aborted) onAbort();
      else abort.addEventListener("abort", onAbort, { once: true });
    }

    // Assign every worker its shard (bind, no dispatch) …
    for (const c of collections) {
      await c.channel.send({
        type: "assign",
        assignment: {
          file: opts.file,
          planId: plan.id,
          shard: c.shard,
          rngSeed,
          vars: opts.vars ?? {},
          secrets: opts.secrets ?? {},
          timelineOrigin,
          ...(opts.baseSession !== undefined ? { baseSession: opts.baseSession } : {}),
          ...(opts.snapshotIntervalMs !== undefined ? { snapshotIntervalMs: opts.snapshotIntervalMs } : {}),
        },
      });
    }
    // … then release dispatch at the shared instant (§5.1 time-based start barrier).
    for (const c of collections) {
      await c.channel.send({
        type: "start",
        startAt,
        ...(dispatchDeadline !== undefined ? { dispatchDeadline } : {}),
      });
    }

    // Wait for every worker to reach a terminal state (done or channel close).
    await Promise.all(collections.map((c) => c.settled));

    return assembleArtifact(plan, {
      collections,
      workerCount,
      runLevel,
      rngSeed,
      timelineOrigin,
      now,
      ...(clampedFrom !== undefined ? { clampedFrom } : {}),
      ...(clampReason !== undefined ? { clampReason } : {}),
    });
  } finally {
    if (abort !== undefined && onAbort !== undefined) abort.removeEventListener("abort", onAbort);
    await provider.close();
  }
}

/** Wire a fan-in collector onto one worker's channel: capture its latest + final snapshot,
 *  its result observables, an error, and settle on `done` OR channel close (a crash can
 *  never hang the coordinator). */
function collectWorker(shard: LoadShard, channel: LoadWorkerChannel): WorkerCollection {
  const c: WorkerCollection = {
    shard,
    channel,
    done: false,
    settled: undefined as unknown as Promise<void>,
  };
  c.settled = new Promise<void>((resolveSettle) => {
    channel.onMessage((msg) => {
      switch (msg.type) {
        case "snapshot":
          // Atomic replace with the newest cumulative frame; the `final:true` frame is the
          // authoritative terminal one a coordinator merges (§7.1).
          c.latestSnapshot = msg.partial;
          if (msg.final) c.finalSnapshot = msg.partial;
          break;
        case "result":
          c.observables = msg.observables;
          break;
        case "error":
          c.errorMessage = msg.message;
          break;
        case "done":
          c.done = true;
          resolveSettle();
          break;
      }
    });
    channel.onClose((reason) => {
      c.closeReason = reason;
      resolveSettle();
    });
  });
  return c;
}

/** Everything `assembleArtifact` needs beyond the plan + collections. */
interface AssembleContext {
  collections: WorkerCollection[];
  workerCount: number;
  runLevel: ReturnType<typeof shardPlan>["runLevel"];
  rngSeed: string;
  timelineOrigin: number;
  now: () => number;
  clampedFrom?: number;
  clampReason?: string;
}

/**
 * Merge the workers' terminal frames and finalize the single artifact (§7.4/§7.5), then
 * layer on the scalar-observable consumption the reducer state cannot carry and the D1
 * execution block (§11). The COMPLETE normal path and the BASIC partial/failed judgment.
 */
function assembleArtifact(plan: LoadPlan, ctx: AssembleContext): LoadArtifact {
  const { collections, workerCount, runLevel, rngSeed, timelineOrigin, now } = ctx;

  // Each worker's usable contribution: its final frame if it delivered one, else its last
  // valid snapshot (a lost worker still counts, censored — §7.4). Workers with no frame at
  // all contribute nothing.
  const contributors = collections
    .map((c) => ({ c, part: c.finalSnapshot ?? c.latestSnapshot }))
    .filter((x): x is { c: WorkerCollection; part: LoadReducerPartialV1 } => x.part !== undefined);
  const finalContributors = collections.filter((c) => c.finalSnapshot !== undefined);

  // §7.4 data completeness (BASIC judgment; full chaos classification is D1-5):
  //  - complete: EVERY worker delivered a terminal frame;
  //  - partial:  ≥1 worker contributed but not all delivered a terminal frame;
  //  - failed:   post-start, NO usable snapshot at all → no trustworthy merged result.
  let executionStatus: LoadExecutionStatus;
  if (finalContributors.length === workerCount) executionStatus = "complete";
  else if (contributors.length > 0) executionStatus = "partial";
  else {
    // No usable data. The full "produce a placeholder failed artifact" path is D1-5; here we
    // surface a loud error (the CLI records it as a per-file failure, no false artifact).
    const detail = collections
      .map((c) => `${c.shard.workerId}: ${c.errorMessage ?? (c.closeReason ? c.closeReason.kind : "no data")}`)
      .join("; ");
    throw new Error(`runLoadMultiCore: no usable worker result (execution failed) — ${detail}`);
  }

  // Coordinator-authoritative run-end (§7.2 throughput denominator): the last worker's
  // finalize instant (covers every event, on the shared axis). No result frame anywhere
  // (all lost mid-run) → the coordinator's own clock closes the interval.
  const finalizeNows = contributors.map((x) => x.c.observables?.finalizeNow).filter((n): n is number => typeof n === "number");
  const runEndMs = finalizeNows.length > 0 ? Math.max(...finalizeNows) : now();

  // Censor each contributor's observation window: a clean finisher is extended to the
  // authoritative globalEndAt (so its trailing event-free tail is not marked
  // contributorsPartial); a lost worker keeps its own frame coverage (undefined → the
  // frame's observedAt). runEndMs ≥ every clean finisher's observedAt by construction.
  const parts = contributors.map((x) => x.part);
  const observationCutoffsMs = contributors.map((x) => (x.c.finalSnapshot !== undefined ? runEndMs : undefined));
  const merged = mergePartials(parts, { observationCutoffsMs });

  const artifact = finalizeMerged(merged, {
    runEndMs,
    timelineOrigin,
    provider: "multi-core",
    executionStatus,
    ...(plan.config.thresholds !== undefined ? { thresholds: plan.config.thresholds } : {}),
  });

  consumeObservables(artifact, contributors.map((x) => x.c));
  fillExecutionBlock(artifact, plan, ctx, { contributors, finalContributors, runEndMs, rngSeed, runLevel, merged });

  return artifact;
}

/**
 * Fold the scalar orchestration observables (`ShardResultObservablesV1`) the cumulative
 * reducer state does not carry into the finalized artifact — the multi-worker analog of the
 * single-machine `runLoad` shell's post-finalize consumption (`orchestrator.ts`), so a
 * sharded artifact reports these facts identically:
 *  - `mixOverrideUsed` (ANY worker) → the deprecated `random` mix override drove a
 *    selection, so the run is NOT seed-replayable → drop the recorded `rngSeed`;
 *  - `peakContinuations` → combined by MAX across workers (a peak gauge; the same
 *    `Math.max` the single machine applies to `maxBacklog` / `maxConcurrent`);
 *  - `abortedByDrainTimeout` → combined by SUM (a count of tails abandoned per worker);
 *  - `unreleasedTailPollRan` → the advisory already rides in each worker's terminal frame
 *    (`stampShardFrame`) and is unioned by the merge, so it is present; re-add defensively
 *    (finalizeMerged de-dups) in case a frame lacked it.
 */
function consumeObservables(artifact: LoadArtifact, workers: WorkerCollection[]): void {
  const obs = workers.map((w) => w.observables).filter((o): o is ShardResultObservablesV1 => o !== undefined);

  if (obs.some((o) => o.mixOverrideUsed)) delete artifact.config.rngSeed;

  const combinedPeak = obs.reduce((m, o) => Math.max(m, o.peakContinuations), 0);
  const combinedAborted = obs.reduce((s, o) => s + o.abortedByDrainTimeout, 0);
  const c = artifact.summary.continuation;
  if (c) {
    c.maxBacklog = Math.max(c.maxBacklog, combinedPeak);
    c.maxConcurrent = Math.max(c.maxConcurrent, combinedPeak);
    if (combinedAborted > 0) {
      c.abortedByDrainTimeout = combinedAborted;
      c.backlog = combinedAborted;
      c.active = combinedAborted;
      artifact.runtime.continuationInFlight = combinedAborted;
    }
  }

  if (obs.some((o) => o.unreleasedTailPollRan)) {
    const advisories = (artifact.summary.advisories ??= []);
    if (!advisories.some((a) => a.includes("tail poll"))) {
      advisories.push(UNRELEASED_TAIL_POLL_ADVISORY);
    }
  }
}

/** Kept in sync with the orchestrator's advisory text (a shard's terminal frame already
 *  carries it; this is the belt-and-suspenders fallback above). */
const UNRELEASED_TAIL_POLL_ADVISORY =
  "An iteration ran a long tail poll without requesting producer release — its slot stayed occupied for the whole tail (closed end-to-end scheduling), under-pressuring the upstream.";

/** Map a worker's `endReason` (and whether it finished) to the finer per-worker
 *  `terminationCause` (§7.4/§11). A basic mapping — the full watchdog-driven causes
 *  (no-progress / lease-expired / coordinator-lost) are D1-5. */
function terminationCauseOf(worker: WorkerCollection): LoadWorkerTerminationCause {
  if (worker.finalSnapshot === undefined) {
    // Lost before a terminal frame — distinguish a channel drop from a handled error/crash.
    if (worker.closeReason !== undefined && !worker.done) return "channel-lost";
    return "crash";
  }
  return worker.observables?.endReason === "abort" ? "abort" : "normal";
}

/** Fill the schema-v2 execution block (§11): provider/rngSeed/protocolVersion, coverage,
 *  per-worker records, and clamp notes. `finalizeMerged` already stamped
 *  `{ provider, workerCount }`; this extends it. */
function fillExecutionBlock(
  artifact: LoadArtifact,
  plan: LoadPlan,
  ctx: AssembleContext,
  data: {
    contributors: Array<{ c: WorkerCollection; part: LoadReducerPartialV1 }>;
    finalContributors: WorkerCollection[];
    runEndMs: number;
    rngSeed: string;
    runLevel: AssembleContext["runLevel"];
    merged: LoadReducerPartialV1;
  },
): void {
  const execution = artifact.runtime.execution;
  if (execution === undefined) return; // finalizeMerged always sets it for a provider run
  const { runLevel } = data;

  // Redundant self-contained copy of the seed (dropped when the mix override made the run
  // non-replayable — `config.rngSeed` was deleted in `consumeObservables`).
  if (artifact.config.rngSeed !== undefined) execution.rngSeed = data.rngSeed;
  execution.protocolVersion = String(MULTICORE_PROTOCOL_VERSION);

  // ── coverage (§7.4 backing for executionStatus) ──
  // slot-busy-seconds actually observed across workers (Σ of the merged slot-busy windows'
  // busy-ms; slot-busy lives in the partial, not the artifact — read the merged frame).
  const slotSecondsAchieved = data.merged.slotBusy.windows.reduce((s, [, busyMs]) => s + busyMs, 0) / 1000;
  const coverage: LoadExecutionCoverage = {
    workersFinal: data.finalContributors.length,
    workersExpected: ctx.workerCount,
    slotSecondsAchieved,
  };
  if (runLevel.iterations !== undefined) {
    coverage.iterationsCompleted = artifact.summary.totalIterations;
    coverage.iterationsExpected = runLevel.iterations;
  }
  // For a partial run, the latest instant EVERY contributor was observed to = the earliest
  // per-worker cutoff (a lost worker censors the global coverage there).
  if (artifact.summary.executionStatus !== "complete") {
    const cutoffs = data.contributors.map((x) =>
      x.c.finalSnapshot !== undefined ? data.runEndMs : x.part.observedAt,
    );
    if (cutoffs.length > 0) coverage.observedUntil = coordTime(Math.min(...cutoffs));
  }
  execution.coverage = coverage;

  // ── per-worker records ──
  execution.workers = ctx.collections.map((c) => {
    const shard = c.shard;
    const iterationIndexes = shard.iterationIndexes as LoadShardIterationIndexes;
    const endReason: LoadEndReason = c.observables?.endReason ?? "crash";
    const rec: LoadExecutionWorker = {
      id: shard.workerId,
      shard: {
        slotIndexBase: shard.slotIndexBase,
        slotCount: shard.slotCount,
        iterationIndexes,
        ...(iterationIndexes.kind === "range"
          ? { iterations: iterationIndexes.end - iterationIndexes.start }
          : {}),
      },
      endReason,
      terminationCause: terminationCauseOf(c),
    };
    if (c.observables !== undefined) rec.startLatenessMs = c.observables.maxStartLatenessMs;
    if (shard.continuation !== undefined) {
      const quota = shard.continuation.maxConcurrent ?? shard.continuation.maxOutstanding ?? 0;
      rec.continuation = { quota, backpressureHits: 0 };
    }
    // A lost worker (no terminal frame): record where its observation was censored + its
    // handled crash message, if any.
    if (c.finalSnapshot === undefined) {
      const cutoff = c.latestSnapshot?.observedAt;
      if (cutoff !== undefined) rec.observationCutoff = coordTime(cutoff);
      if (c.errorMessage !== undefined) rec.crash = { cause: "runnerCrash", message: c.errorMessage };
    }
    return rec;
  });

  // ── notes: clamp + partial diagnostics ──
  const notes: string[] = [];
  if (ctx.clampedFrom !== undefined) {
    notes.push(`worker count clamped ${ctx.clampedFrom} → ${ctx.workerCount} (${ctx.clampReason ?? "plan capacity"})`);
  }
  if (artifact.summary.executionStatus === "partial") {
    const lost = ctx.collections.filter((c) => c.finalSnapshot === undefined).map((c) => c.shard.workerId);
    notes.push(`partial: ${lost.length} worker(s) lost before a final snapshot (${lost.join(", ")}); their contribution is censored`);
  }
  // slotSecondsExpected + the §6.2 conformance verdict are deferred to D1-5 (the ideal
  // schedule integral must subtract the ramp curve; noted so it is not silently missing).
  if (notes.length > 0) execution.notes = [...(execution.notes ?? []), ...notes];
}
