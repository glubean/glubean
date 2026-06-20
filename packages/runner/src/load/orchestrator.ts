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
 * (the open-ish model) is M6. A traffic mix (`scenarios[]`) is supported: the plan
 * is lowered to weighted `Workload`s and every iteration picks one by weight, so
 * concurrency / pacing / continuation / thresholds stay run-level while per-scenario
 * results are attributed via each entry's id.
 */
import type {
  AnyLoadRunnerConfig,
  FeederBinding,
  FeederDrawContext,
  LoadArtifact,
  LoadArtifactConfig,
  LoadEndReason,
  LoadMixConfig,
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
  type CompiledLoadScenario,
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
  /** RNG in [0,1) for weighted traffic-mix scenario selection (default `Math.random`).
   *  Injectable so a mix run can be made deterministic in tests. Unused for a
   *  single-scenario run (selection is trivial). */
  random?: () => number;
}

/**
 * One feeder slot of a workload, plus the `counterKey` its draw count is tracked under.
 * The key is the slot's logical identity (NOT the binding object — a binding may be reused
 * across slots), defining the DRAW SCOPE:
 *  - a SHARED feeder (a mix's top-level): one key per NAME, reused across the entries that
 *    don't override it, so its draws advance run-globally;
 *  - an ENTRY feeder (a mix entry's own): a UNIQUE marker per (entry, name), so two entries
 *    that reuse the same binding object still get independent per-entry sequences.
 * Two slots that reuse one binding object thus stay independent (codex); for a single
 * scenario each feeder is its own shared name, so its draw count tracks the iteration index.
 */
interface WorkloadFeeder {
  name: string;
  binding: FeederBinding;
  counterKey: object;
}

/**
 * One workload the orchestrator can schedule: a compiled scenario plus its resolved
 * feeders / input. A single-scenario run has exactly one (weight is irrelevant); a
 * traffic mix has one per `scenarios[]` entry, each weighted and carrying its own
 * `scenarioRefId` (the entry id) for per-scenario report attribution.
 *
 * `feeders` is the entry's effective set (a mix's top-level feeders merged with the
 * entry's own, the entry winning a name clash), each carrying its draw-scope `counterKey`.
 * A shared feeder advances run-globally while a per-entry feeder advances only when that
 * entry runs. For a single scenario every feeder is shared and drawn every iteration, so
 * its draw count tracks the iteration index (pre-mix parity).
 */
interface Workload {
  scenarioId: string;
  scenarioRefId?: string;
  compiled: CompiledLoadScenario;
  feeders: WorkloadFeeder[];
  input?: unknown;
  weight: number;
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
 * Run a load plan locally and return its finalized `LoadArtifact`. Handles BOTH a
 * single-scenario run and a traffic mix (`scenarios[]`): each is lowered to a list of
 * weighted `Workload`s, and every iteration picks one (weighted-random for a mix, the
 * sole workload otherwise). Throws on a plan with neither `duration` nor `iterations`
 * (it would run forever). Closed model; continuation / pacing / thresholds are
 * run-level (shared across a mix), per-scenario results attributed via each entry id.
 */
export async function runLoad(plan: LoadPlan, opts: RunLoadOptions = {}): Promise<LoadArtifact> {
  const config = plan.config;
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

  const continuationCfg = resolveContinuationConfig(config.continuation);
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

  // Lower the plan to weighted workloads (one for a single scenario, one per mix entry).
  // The runner-level `assertions.onFailure` default is shared; each entry's scenario /
  // step meta can still override it during compilation.
  const compileOpts = config.assertions?.onFailure !== undefined ? { defaultOnFailure: config.assertions.onFailure } : {};
  // One stable counter key per SHARED feeder NAME, reused across the entries that draw it, so
  // its draws advance run-globally. Keyed by name (not the binding) so two shared names that
  // happen to reuse the same binding object stay independent slots (and single-scenario feeders
  // each get their own per-name sequence regardless of binding reuse).
  const sharedCounterKeys = new Map<string, object>();
  const sharedCounterKey = (name: string): object => {
    let key = sharedCounterKeys.get(name);
    if (key === undefined) { key = {}; sharedCounterKeys.set(name, key); }
    return key;
  };
  const makeWorkload = (
    ref: LoadScenarioRef,
    weight: number,
    scenarioRefId: string | undefined,
    sharedFeeders: Record<string, FeederBinding> | undefined,
    entryFeeders: Record<string, FeederBinding> | undefined,
    input: unknown,
  ): Workload => {
    const scenario = resolveScenario(ref);
    const entry = entryFeeders ?? {};
    const feeders: WorkloadFeeder[] = [];
    // Shared (top-level) feeders the entry does NOT override: keyed per NAME, shared across
    // the non-overriding entries → one run-global draw sequence. `Object.entries` +
    // `hasOwnProperty` are own-prop only, so a feeder named `toString` survives (a
    // `name in entry` check would drop it via Object.prototype).
    for (const [name, binding] of Object.entries(sharedFeeders ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(entry, name)) {
        feeders.push({ name, binding, counterKey: sharedCounterKey(name) });
      }
    }
    // The entry's own feeders (entry wins a name clash): each gets a UNIQUE marker key, so
    // two entries reusing the same binding object still draw independent per-entry sequences.
    for (const [name, binding] of Object.entries(entry)) {
      feeders.push({ name, binding, counterKey: {} });
    }
    return {
      scenarioId: scenario.meta.id,
      ...(scenarioRefId !== undefined ? { scenarioRefId } : {}),
      compiled: compileLoadScenario(scenario, compileOpts),
      feeders,
      input,
      weight,
    };
  };

  let workloads: Workload[];
  if (isMixConfig(config)) {
    const mix = config as LoadMixConfig;
    if (!Array.isArray(mix.scenarios) || mix.scenarios.length === 0) {
      throw new Error(`loadRunner "${plan.id}": a traffic mix needs at least one entry in \`scenarios\``);
    }
    const seenIds = new Set<string>();
    workloads = mix.scenarios.map((entry) => {
      if (typeof entry.id !== "string" || entry.id === "") {
        throw new Error(`loadRunner "${plan.id}": every traffic-mix entry needs a non-empty \`id\``);
      }
      if (seenIds.has(entry.id)) {
        throw new Error(
          `loadRunner "${plan.id}": duplicate traffic-mix entry id "${entry.id}" — ids attribute per-scenario results, so they must be unique`,
        );
      }
      seenIds.add(entry.id);
      if (!Number.isFinite(entry.weight) || entry.weight <= 0) {
        throw new Error(
          `loadRunner "${plan.id}": traffic-mix entry "${entry.id}" weight must be a positive number (got ${entry.weight})`,
        );
      }
      // Top-level feeders are shared (run-global draws); the entry's own are per-entry.
      return makeWorkload(entry.scenario, entry.weight, entry.id, mix.feeders, entry.feeders, entry.input);
    });
  } else {
    // Single scenario: all feeders are "shared" (run-global) so the indexing is exactly
    // the pre-mix behavior; there are no per-entry feeders.
    const single = config as LoadRunnerConfig;
    workloads = [makeWorkload(single.scenario, 1, undefined, single.feeders, undefined, single.input)];
  }

  // Weighted scenario selection for a mix; the sole workload for a single scenario (no
  // RNG draw, so a single-scenario run is byte-identical to before).
  const random = opts.random ?? Math.random;
  const totalWeight = workloads.reduce((sum, w) => sum + w.weight, 0);
  const selectWorkload = (): Workload => {
    if (workloads.length === 1) return workloads[0];
    let r = random() * totalWeight;
    for (const w of workloads) {
      r -= w.weight;
      if (r < 0) return w;
    }
    return workloads[workloads.length - 1]; // float-rounding safety net
  };

  const thinkTimeMs = normalizeThinkTime(config.pacing);

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

  // Record the traffic-mix composition so the reducer can seed a 0-iteration aggregate for
  // every configured entry (a low-weight entry that's never selected still shows up).
  const mixScenarios = isMixConfig(config)
    ? workloads.map((w) => ({ scenarioRefId: w.scenarioRefId as string, scenarioId: w.scenarioId, weight: w.weight }))
    : undefined;

  const resolvedConfig: LoadResolvedConfig = {
    concurrency,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(iterations !== undefined ? { iterations } : {}),
    ...(rampUpMs !== undefined ? { rampUpMs } : {}),
    ...(thinkTimeMs !== undefined ? { pacing: { thinkTimeMs } } : {}),
    ...(continuationCfg !== undefined ? { continuation: continuationCfg } : {}),
    ...(mixScenarios !== undefined ? { scenarios: mixScenarios } : {}),
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
    globalIteration: number,
    slotIteration: number,
    workload: Workload,
    feederSlotDraws: Map<object, number>,
  ): LoadIterationHandle | "skip" | "failed" => {
    const iterationId = `it-${globalIteration}`;
    const producerSlot = { id: producerSlotId, index: slotIndex };
    const iteration = { id: iterationId, index: globalIteration };
    const envelope: LoadIterationEnvelope = {
      scenarioId: workload.scenarioId,
      ...(workload.scenarioRefId !== undefined ? { scenarioRefId: workload.scenarioRefId } : {}),
      producerSlotId,
      iterationId,
    };

    // `globalIteration`/`slotIteration` keep their public contract — the REAL run-global and
    // per-slot iteration indices (so a custom feeder reading them is unaffected by mix
    // scheduling). The built-in feeders index by `drawIndex`/`slotDrawIndex` instead: ITS OWN
    // per-binding draw count, so a binding shared across entries advances run-wide while a
    // per-entry (or partially-overridden) binding advances only when its entry runs — correct
    // even when only some entries override a shared name (codex). For a single scenario a
    // feeder is drawn every iteration, so its draw count equals the iteration index.
    const drawCtxFor = (counterKey: object): FeederDrawContext => {
      const g = feederGlobalDraws.get(counterKey) ?? 0;
      feederGlobalDraws.set(counterKey, g + 1);
      const s = feederSlotDraws.get(counterKey) ?? 0;
      feederSlotDraws.set(counterKey, s + 1);
      return { producerSlot: slotIndex, producerCount: concurrency, slotIteration, globalIteration, drawIndex: g, slotDrawIndex: s };
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
      for (const { name, binding, counterKey } of workload.feeders) {
        const draw = binding.allocate(drawCtxFor(counterKey));
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
        typeof workload.input === "function"
          ? (workload.input as (args: unknown) => unknown)({
              row: plan.row,
              feed,
              producerSlot,
              iteration,
            })
          : (workload.input ?? {});
    } catch {
      return failSetup();
    }

    return startLoadIteration({
      core,
      sink,
      scenario: workload.compiled,
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

  // Run-global per-feeder draw count, keyed by each feeder slot's `counterKey` (a shared
  // feeder's binding object, or an entry feeder's unique marker — see WorkloadFeeder).
  // Shared across slots, so a shared feeder advances run-wide while a per-entry slot advances
  // only on its entry's turns. Feeds `drawIndex` (built-in uniquePerIteration / roundRobin).
  const feederGlobalDraws = new Map<object, number>();

  const runSlot = async (slotIndex: number): Promise<void> => {
    if (rampUpMs !== undefined) {
      await pausedSleep(rampDelayMs(slotIndex, concurrency, rampUpMs));
    }
    sink.emitProducerSlotStart(slotIndex);
    const producerSlotId = `p${slotIndex}`;
    // Per-slot iteration index (the `slotIteration` public contract field), and per-slot
    // per-feeder draw counts (what partitionByVu actually indexes by, via `slotDrawIndex`).
    let slotIteration = 0;
    const feederSlotDraws = new Map<object, number>();
    let primaryIterations = 0;
    for (;;) {
      const globalIteration = claimIteration();
      if (globalIteration < 0) break;
      // Pick this iteration's workload (weighted-random for a mix, the sole one for a single
      // scenario); the feeders it draws advance their own per-binding counters (see drawCtxFor).
      const workload = selectWorkload();
      const started = startOneIteration(slotIndex, producerSlotId, globalIteration, slotIteration, workload, feederSlotDraws);
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

  // Evaluate configured thresholds against the finalized artifact and refine the pass
  // verdict (a crash-free run still fails if a threshold is breached). Thresholds are
  // run-level — for a mix they apply to the aggregate, not per scenario.
  if (config.thresholds !== undefined) {
    const { thresholds, pass } = evaluateThresholds(artifact, config.thresholds);
    artifact.summary.thresholds = thresholds;
    artifact.summary.pass = pass;
  }
  return artifact;
}
