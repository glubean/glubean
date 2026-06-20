/**
 * Local load orchestrator — the closed-model run loop (M3-f).
 *
 * Drives a `LoadPlan` to a finalized `LoadArtifact`: it stands up the shared
 * engine core + `LoadSink` + `LoadReducer`, then runs `concurrency` producer
 * slots that each execute scenario iterations back-to-back until a termination
 * bound (`iterations` count and/or `duration` wall-clock) is reached, optionally
 * staggered by `rampUp` and paced by `thinkTime`. Each iteration draws feeder
 * rows, resolves its `input`, gets a copy-on-write session, and runs through
 * `runLoadIteration` (which never rejects — one bad iteration can't fell a slot).
 *
 * Closed model: a slot holds exactly one in-flight iteration at a time (back to
 * back), so offered concurrency == `concurrency`. Producer release / continuation
 * (the open-ish model) is M6; traffic-mix selection is a later milestone — this
 * orchestrator handles a single scenario and rejects a mix config explicitly.
 */
import type {
  AnyLoadRunnerConfig,
  FeederBinding,
  FeederDrawContext,
  LoadArtifact,
  LoadArtifactConfig,
  LoadEndReason,
  LoadPlan,
  LoadResolvedConfig,
  LoadRunnerConfig,
  LoadScenario,
  LoadScenarioRef,
} from "@glubean/sdk/load";
import { parseDurationMs } from "@glubean/sdk/load";

import { createEngineCore } from "../engine-bridge.js";
import {
  compileLoadScenario,
  startLoadIteration,
  type LoadIterationHandle,
  type RunLoadIterationResult,
} from "./execute-iteration.js";
import { ContinuationPool } from "./continuation-pool.js";
import { createLoadReducer } from "./reducer.js";
import { LoadSink, type LoadIterationEnvelope } from "./sink.js";
import { evaluateThresholds } from "./threshold.js";

/** Options for one local load run. */
export interface RunLoadOptions {
  /** Resolved environment vars for the engine core (ctx.vars). */
  vars?: Record<string, string>;
  /** Resolved secrets for the engine core (ctx.secrets). */
  secrets?: Record<string, string>;
  /** Run id stamped on every event (defaults to the runner id). */
  runId?: string;
  /** Runner id stamped on every event (defaults to the plan id). */
  runnerId?: string;
  /** Base session each iteration copies (copy-on-write isolation). Default `{}`. */
  baseSession?: Record<string, unknown>;
  /** Clock for wall-clock timing + event ts (default `Date.now`). */
  now?: () => number;
}

/**
 * Ramp-up start offset (ms) for a slot. `rampUp` is the time to reach FULL
 * concurrency, so slots spread evenly across `[0, rampUp]` with the LAST slot
 * starting at the end of the window (slot 0 at 0, slot N-1 at `rampUp`). A single
 * slot (or no ramp) starts immediately.
 */
export function rampDelayMs(slotIndex: number, concurrency: number, rampUpMs: number): number {
  if (concurrency <= 1 || rampUpMs <= 0) return 0;
  return (slotIndex / (concurrency - 1)) * rampUpMs;
}

/** Deep-clone the base session for one iteration — copy-on-write isolation that
 *  also covers nested values, so a mutation in one iteration never leaks into
 *  another. (structuredClone is available on the Node runtime the runner targets.) */
function cloneSession(base: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(base);
}

/** Resolve a scenario reference (un-built builder → built scenario). */
function resolveScenario(ref: LoadScenarioRef): LoadScenario {
  const r = ref as { __glubean_type?: string; build?: () => LoadScenario };
  if (r.__glubean_type === "load-scenario-builder" && typeof r.build === "function") {
    return r.build();
  }
  return ref as LoadScenario;
}

/** Normalize a pacing config's thinkTime to ms (number or {min,max}). */
function normalizeThinkTime(
  pacing: LoadRunnerConfig["pacing"],
): number | { min: number; max: number } | undefined {
  const tt = pacing?.thinkTime;
  if (tt === undefined) return undefined;
  if (typeof tt === "object") {
    const min = parseDurationMs(tt.min);
    const max = parseDurationMs(tt.max);
    if (max < min) {
      throw new Error(
        `pacing.thinkTime range is inverted: min (${min}ms) must be <= max (${max}ms)`,
      );
    }
    return { min, max };
  }
  return parseDurationMs(tt);
}

/** A single think-time delay (random within [min,max] for a range). */
function thinkDelay(thinkTimeMs: number | { min: number; max: number } | undefined): number {
  if (thinkTimeMs === undefined) return 0;
  if (typeof thinkTimeMs === "number") return thinkTimeMs;
  const { min, max } = thinkTimeMs;
  return min + Math.random() * Math.max(0, max - min);
}

function isMixConfig(config: AnyLoadRunnerConfig): boolean {
  return "scenarios" in config;
}

/**
 * Drain the in-flight continuations from released iterations before the run
 * finalizes. With a `drainTimeoutMs`, stop waiting once it elapses and return how
 * many were still unsettled (abandoned) — so a continuation that never settles
 * (e.g. an unbounded poll) can't hang an otherwise-bounded run. With no timeout,
 * wait for them all (continuations are expected to be self-bounded via poll
 * timeouts). The abandoned continuations keep running but are no longer awaited.
 */
async function drainContinuations(
  continuations: Set<Promise<unknown>>,
  drainTimeoutMs: number | undefined,
): Promise<number> {
  const inflight = [...continuations]; // snapshot the still-in-flight continuations
  if (inflight.length === 0) return 0;
  if (drainTimeoutMs === undefined) {
    await Promise.allSettled(inflight);
    return 0;
  }
  // Track settlement so we can count what the timeout abandons.
  let settled = 0;
  const tracked = inflight.map((p) => p.then(() => { settled += 1; }, () => { settled += 1; }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, drainTimeoutMs); });
  await Promise.race([Promise.allSettled(tracked), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return inflight.length - settled;
}

/**
 * Resolve the continuation (bounded-open) config to its ms-normalized artifact
 * form, applying the documented default backlog policy. Present only when the user
 * configured `continuation`; the producer-release scheduling that consumes it is
 * M6 (a bare `primaryComplete` without `releaseProducerSlot` ignores it).
 */
function resolveContinuationConfig(
  c: LoadRunnerConfig["continuation"],
): LoadArtifactConfig["continuation"] | undefined {
  if (c === undefined) return undefined;
  return {
    ...(c.maxOutstanding !== undefined ? { maxOutstanding: c.maxOutstanding } : {}),
    ...(c.maxConcurrent !== undefined ? { maxConcurrent: c.maxConcurrent } : {}),
    ...(c.minPollInterval !== undefined ? { minPollIntervalMs: parseDurationMs(c.minPollInterval) } : {}),
    ...(c.drainTimeout !== undefined ? { drainTimeoutMs: parseDurationMs(c.drainTimeout) } : {}),
    // When a configured backlog bound is hit the default is to back-pressure the
    // producer (`await primaryComplete` waits for capacity); `fail-iteration` is opt-in.
    onBacklogFull: c.onBacklogFull ?? "block-producer",
  };
}

/**
 * Run a load plan locally and return its finalized `LoadArtifact`. Single-scenario
 * closed model; throws on a traffic-mix config (a later milestone) or a plan with
 * neither `duration` nor `iterations` (it would run forever).
 */
export async function runLoad(plan: LoadPlan, opts: RunLoadOptions = {}): Promise<LoadArtifact> {
  const config = plan.config;
  if (isMixConfig(config)) {
    throw new Error(
      `loadRunner "${plan.id}": traffic-mix execution is not yet supported by the local orchestrator (single-scenario only)`,
    );
  }
  const single = config as LoadRunnerConfig;
  const projection = plan.projection;
  const { concurrency, durationMs, iterations, rampUpMs } = projection;

  if (durationMs === undefined && iterations === undefined) {
    throw new Error(
      `loadRunner "${plan.id}": set \`duration\` and/or \`iterations\` — a load run needs a termination bound`,
    );
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`loadRunner "${plan.id}": concurrency must be a positive integer (got ${concurrency})`);
  }
  if (iterations !== undefined && (!Number.isInteger(iterations) || iterations < 1)) {
    throw new Error(`loadRunner "${plan.id}": iterations must be a positive integer (got ${iterations})`);
  }
  if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs <= 0)) {
    throw new Error(`loadRunner "${plan.id}": duration must resolve to a positive number of ms (got ${durationMs})`);
  }

  const continuationCfg = resolveContinuationConfig(single.continuation);
  if (continuationCfg?.maxOutstanding !== undefined && (!Number.isInteger(continuationCfg.maxOutstanding) || continuationCfg.maxOutstanding < 1)) {
    throw new Error(`loadRunner "${plan.id}": continuation.maxOutstanding must be a positive integer (got ${continuationCfg.maxOutstanding})`);
  }
  if (continuationCfg?.maxConcurrent !== undefined && (!Number.isInteger(continuationCfg.maxConcurrent) || continuationCfg.maxConcurrent < 1)) {
    throw new Error(`loadRunner "${plan.id}": continuation.maxConcurrent must be a positive integer (got ${continuationCfg.maxConcurrent})`);
  }

  const now = opts.now ?? (() => Date.now());
  const runnerId = opts.runnerId ?? plan.id;
  const runId = opts.runId ?? runnerId;
  const baseSession = opts.baseSession ?? {};
  // Fail fast (once) with a clear message if the base session can't be deep-cloned,
  // rather than throwing mid-run on the first iteration's copy.
  try {
    cloneSession(baseSession);
  } catch (e) {
    throw new Error(
      `loadRunner "${plan.id}": baseSession must be structured-cloneable (no functions / class instances): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  const scenario = resolveScenario(single.scenario);
  const scenarioId = scenario.meta.id;
  const compiled = compileLoadScenario(scenario, {
    ...(single.assertions?.onFailure !== undefined ? { defaultOnFailure: single.assertions.onFailure } : {}),
  });
  const feeders = Object.entries(single.feeders ?? {}) as [string, FeederBinding][];
  const thinkTimeMs = normalizeThinkTime(single.pacing);

  const reducer = createLoadReducer();
  const sink = new LoadSink(reducer, runId, runnerId, now);
  const core = createEngineCore(sink.handleWire, {
    vars: opts.vars ?? {},
    secrets: opts.secrets ?? {},
  });

  // Run-level abort, handed to every iteration's engine run. Fired once at finalization
  // (see the `finally` below) to truly CANCEL any continuation tail still in flight —
  // its in-flight HTTP and engine poll/retry waits stop at once, instead of running to
  // completion in the background after the drain phase stopped awaiting them. (Opaque
  // user async — a bare `setTimeout` in a step — still can't be cancelled.)
  const runAbort = new AbortController();

  // Continuation backlog for producer release (M6). The pool bound is the tighter of
  // maxOutstanding / maxConcurrent (every in-flight continuation is concurrently
  // scheduled, so the two coincide); unset on both → unbounded. Default backlog
  // policy is block-producer (back-pressure). Continuations from released iterations
  // are drained before the run finalizes.
  const continuationBound =
    continuationCfg?.maxOutstanding !== undefined && continuationCfg?.maxConcurrent !== undefined
      ? Math.min(continuationCfg.maxOutstanding, continuationCfg.maxConcurrent)
      : continuationCfg?.maxOutstanding ?? continuationCfg?.maxConcurrent;
  const continuationPool = new ContinuationPool(
    continuationBound,
    continuationCfg?.onBacklogFull ?? "block-producer",
    continuationCfg?.drainTimeoutMs,
    now,
  );
  // In-flight continuations from released iterations. A Set with settle-time removal
  // keeps only the CURRENTLY in-flight ones, so a long / high-rate run doesn't retain
  // every released iteration's promise until the final drain.
  const continuations = new Set<Promise<RunLoadIterationResult>>();
  // Peak concurrent continuation tails — including deadline-released ones the pool
  // never admitted — so the reported backlog peak isn't understated.
  let peakContinuations = 0;
  const trackContinuation = (p: Promise<RunLoadIterationResult>): void => {
    continuations.add(p);
    if (continuations.size > peakContinuations) peakContinuations = continuations.size;
    void p.finally(() => continuations.delete(p));
  };

  const resolvedConfig: LoadResolvedConfig = {
    concurrency,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(iterations !== undefined ? { iterations } : {}),
    ...(rampUpMs !== undefined ? { rampUpMs } : {}),
    ...(thinkTimeMs !== undefined ? { pacing: { thinkTimeMs } } : {}),
    ...(continuationCfg !== undefined ? { continuation: continuationCfg } : {}),
  };

  const start = now();
  sink.emitLoadStart(resolvedConfig);

  // Run-end coordination. Ramp-up / think-time waits are CANCELLABLE real timers:
  // while a slot legitimately waits, its timer is ref'd (so a standalone Node run
  // can't exit before it resolves), but the moment the run ends — iterations cap
  // reached, or the duration deadline fires — every pending wait is cleared and
  // resolved at once, so a slot never overruns the bound (late ramped slots that
  // will claim nothing, or a think-time after the final iteration, wake instantly).
  let ended = false;
  const activeWaiters = new Map<ReturnType<typeof setTimeout>, () => void>();
  // The wall-clock (duration) deadline `closeImmediate()`s the pool: every parked
  // producer is cancelled at once (the run's hard bound is up) and any later park is
  // rejected immediately. The per-park `drainTimeout` bound is always-on in the pool
  // (armed from when each producer parks, even before the run ends — so an
  // all-producers-blocked backlog can't hang an iterations-bounded run), so the
  // iterations cap needs no pool action here: a parked release self-bounds by its
  // drainTimeout, or — with no drainTimeout — waits for capacity until either a
  // continuation frees a slot or a duration deadline (if any) closes the pool.
  const markEnded = (wallClockUp = false): void => {
    const firstEnd = !ended;
    if (firstEnd) {
      ended = true;
      for (const [timer, resolve] of activeWaiters) {
        clearTimeout(timer);
        resolve();
      }
      activeWaiters.clear();
    }
    if (wallClockUp) continuationPool.closeImmediate();
  };
  // A duration deadline timer wakes ramp/think waiters at the bound even if no slot
  // happens to claim (and thus re-check) right then.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (durationMs !== undefined) deadlineTimer = setTimeout(() => markEnded(true), durationMs);

  /** Wait `ms`, returning early the instant the run ends (never overruns the bound). */
  const pausedSleep = (ms: number): Promise<void> => {
    if (ms <= 0 || ended) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        activeWaiters.delete(timer);
        resolve();
      }, ms);
      activeWaiters.set(timer, resolve);
    });
  };

  // The shared, monotonically-claimed global iteration counter. A slot claims the
  // next index before running; -1 means the run is over. Single-threaded JS makes
  // the claim atomic.
  let claimed = 0;
  const durationExpired = (): boolean => durationMs !== undefined && now() - start >= durationMs;
  const claimIteration = (): number => {
    // The deadline timer can flip `ended` independently of the (possibly frozen /
    // injected) clock, so honour it directly — not just `durationExpired()`.
    if (ended) return -1;
    if (durationExpired()) {
      markEnded(true); // duration bound hit on a claim → wall-clock is up
      return -1;
    }
    if (iterations !== undefined && claimed >= iterations) {
      markEnded();
      return -1;
    }
    const index = claimed++;
    // Claiming the last iteration ends the run — wake any ramp/think waiters now.
    if (iterations !== undefined && claimed >= iterations) markEnded();
    return index;
  };

  /**
   * Start one iteration's PRIMARY phase. Returns its handle (the producer slot is
   * freed when `primaryDone` resolves), or `"skip"` (feeder opt-out, not counted) /
   * `"failed"` (a setup failure recorded as a started+failed iteration). The slot
   * loop awaits the handle's `primaryDone`; with producer release that resolves at
   * the boundary so the slot can start the next primary while the continuation runs.
   */
  const startOneIteration = (
    slotIndex: number,
    producerSlotId: string,
    slotIteration: number,
    globalIteration: number,
  ): LoadIterationHandle | "skip" | "failed" => {
    const iterationId = `it-${globalIteration}`;
    const producerSlot = { id: producerSlotId, index: slotIndex };
    const iteration = { id: iterationId, index: globalIteration };
    const envelope: LoadIterationEnvelope = { scenarioId, producerSlotId, iterationId };

    const drawCtx: FeederDrawContext = {
      producerSlot: slotIndex,
      producerCount: concurrency,
      slotIteration,
      globalIteration,
    };

    const failSetup = (): "failed" => {
      // A setup-time failure (feeder exhausted / input threw) still counts as a
      // started+failed iteration so the artifact reflects it.
      sink.beginIteration(envelope);
      sink.emitIterationStart(envelope, {});
      sink.emitIterationEnd(envelope, { ok: false, durationMs: 0, errorKind: "setupError" });
      sink.endIteration(iterationId);
      return "failed";
    };

    // Feeder allocation + input resolution are the iteration's SETUP. Any failure
    // here (a feeder exhausted under `fail`, a feeder `allocate()` that throws, or a
    // throwing `input` fn) becomes a recorded failed iteration — it must never
    // escape and reject the whole run.
    const feed: Record<string, unknown> = {};
    const feederKeys: Record<string, string> = {};
    let input: unknown;
    let skipped = false;
    try {
      for (const [name, binding] of feeders) {
        const draw = binding.allocate(drawCtx);
        if (draw.outcome === "value") {
          feed[name] = draw.value;
          if (draw.key !== undefined) feederKeys[name] = draw.key;
        } else if (draw.outcome === "skip" || draw.outcome === "wait") {
          // `skip`/`wait`: the iteration opts out (wait-and-retry isn't modelled in
          // the closed MVP — both just skip). Not a failure, not counted.
          skipped = true;
          break;
        } else {
          return failSetup(); // exhausted (fail policy)
        }
      }
      if (skipped) return "skip";
      input =
        typeof single.input === "function"
          ? (single.input as (args: unknown) => unknown)({
              row: plan.row,
              feed,
              producerSlot,
              iteration,
            })
          : (single.input ?? {});
    } catch {
      return failSetup();
    }

    return startLoadIteration({
      core,
      sink,
      scenario: compiled,
      envelope,
      input,
      producerSlot,
      iteration,
      session: cloneSession(baseSession), // copy-on-write: each iteration gets its own (deep)
      ...(Object.keys(feederKeys).length > 0 ? { feederKeys } : {}),
      now,
      continuation: { pool: continuationPool },
      signal: runAbort.signal,
    });
  };

  const runSlot = async (slotIndex: number): Promise<void> => {
    if (rampUpMs !== undefined) {
      await pausedSleep(rampDelayMs(slotIndex, concurrency, rampUpMs));
    }
    sink.emitProducerSlotStart(slotIndex);
    const producerSlotId = `p${slotIndex}`;
    let slotIteration = 0;
    let primaryIterations = 0;
    for (;;) {
      const globalIteration = claimIteration();
      if (globalIteration < 0) break;
      const started = startOneIteration(slotIndex, producerSlotId, slotIteration, globalIteration);
      slotIteration += 1;
      if (started !== "skip") {
        // A real (or failed-setup) primary iteration.
        if (started !== "failed") {
          // Hold the slot until the primary phase finishes: at the producer-release
          // boundary (then the continuation drains in the background) or, with no
          // release, at full completion (closed model).
          const { released } = await started.primaryDone;
          if (released) trackContinuation(started.completed);
        }
        primaryIterations += 1;
      }
      // Pace EVERY slot turn — including a feeder skip/wait — so an exhausted
      // skip/wait feeder doesn't spin the loop in a paced run.
      if (thinkTimeMs !== undefined) await pausedSleep(thinkDelay(thinkTimeMs));
    }
    sink.emitProducerSlotEnd(slotIndex, primaryIterations);
  };

  let abortedByDrainTimeout = 0;
  try {
    await Promise.all(Array.from({ length: concurrency }, (_, i) => runSlot(i)));
    abortedByDrainTimeout = await drainContinuations(continuations, continuationCfg?.drainTimeoutMs);
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    // All primaries are done and the drain phase has run; abort whatever continuation
    // tail is still in flight so its in-flight HTTP / engine poll waits stop NOW rather
    // than running on in the background. A tail that already settled (drain awaited it,
    // or there was no drainTimeout) makes this a no-op. The aborted tails settle on later
    // microtasks — after the synchronous `seal()` below — so their late events are still
    // dropped, leaving the artifact unchanged; only the wasted in-flight work is cut.
    runAbort.abort();
  }

  const endReason: LoadEndReason =
    iterations !== undefined && claimed >= iterations ? "iterations" : durationMs !== undefined ? "duration" : "iterations";
  sink.emitLoadEnd(endReason);
  // Seal the sink so a continuation the drain timeout abandoned can't emit into the
  // reducer after the artifact is built. The `runAbort.abort()` above already cancelled
  // its in-flight HTTP / engine poll waits, so a tail settles promptly; seal is the
  // backstop for the late events that abort can't pre-empt (e.g. a bare `setTimeout` in
  // user code, which no signal can cancel) and for the settle that lands post-seal.
  sink.seal();

  const artifact = reducer.finalize();
  // Continuations the drain timeout abandoned are still in flight at finalize —
  // surface them (the reducer can't know the orchestrator's drain decision).
  if (artifact.summary.continuation) {
    const c = artifact.summary.continuation;
    // The orchestrator saw the true peak of concurrent tails (incl. deadline-released
    // ones the pool never admitted, so the reducer's maxBacklog can't see them).
    c.maxBacklog = Math.max(c.maxBacklog, peakContinuations);
    c.maxConcurrent = Math.max(c.maxConcurrent, peakContinuations);
    if (abortedByDrainTimeout > 0) {
      c.abortedByDrainTimeout = abortedByDrainTimeout;
      c.backlog = abortedByDrainTimeout;
      c.active = abortedByDrainTimeout;
      artifact.runtime.continuationInFlight = abortedByDrainTimeout;
    }
  }
  // Advisory: some iteration ran a long TAIL poll but didn't request producer release,
  // so its slot stayed tied up for the whole tail (closed end-to-end scheduling), under-
  // pressuring the upstream. The sink decides this PER ITERATION (`unreleasedTailPollRan`):
  //  - a TAIL poll (a step-scoped request before it, none after) — excludes a poll in an
  //    untaken branch (never runs) and a readiness/token poll before the primary request;
  //  - in an iteration that did NOT ask for release — a bare `primaryComplete()` still
  //    gets advised, but a requested-but-rejected release does not (they already asked),
  //    and a row that releases doesn't mute the advisory for a sibling row that doesn't.
  if (sink.unreleasedTailPollRan) {
    (artifact.summary.advisories ??= []).push(
      "Most producer slot time is spent after the primary request; closed end-to-end scheduling may reduce upstream pressure. Call `await ctx.report.primaryComplete(..., { releaseProducerSlot: true })` after the primary load is issued if you want sustained ingress pressure.",
    );
  }

  // Evaluate configured thresholds against the finalized artifact and refine the
  // pass verdict (a crash-free run still fails if a threshold is breached).
  if (single.thresholds !== undefined) {
    const { thresholds, pass } = evaluateThresholds(artifact, single.thresholds);
    artifact.summary.thresholds = thresholds;
    artifact.summary.pass = pass;
  }
  return artifact;
}
