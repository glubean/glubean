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
  LoadEndReason,
  LoadPlan,
  LoadResolvedConfig,
  LoadRunnerConfig,
  LoadScenario,
  LoadScenarioRef,
} from "@glubean/sdk/load";
import { parseDurationMs } from "@glubean/sdk/load";

import { createEngineCore } from "../engine-bridge.js";
import { compileLoadScenario, runLoadIteration } from "./execute-iteration.js";
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

  const resolvedConfig: LoadResolvedConfig = {
    concurrency,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(iterations !== undefined ? { iterations } : {}),
    ...(rampUpMs !== undefined ? { rampUpMs } : {}),
    ...(thinkTimeMs !== undefined ? { pacing: { thinkTimeMs } } : {}),
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
  const markEnded = (): void => {
    if (ended) return;
    ended = true;
    for (const [timer, resolve] of activeWaiters) {
      clearTimeout(timer);
      resolve();
    }
    activeWaiters.clear();
  };
  // A duration deadline timer wakes ramp/think waiters at the bound even if no slot
  // happens to claim (and thus re-check) right then.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (durationMs !== undefined) deadlineTimer = setTimeout(markEnded, durationMs);

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
      markEnded();
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

  /** Run one iteration; returns true if it actually ran (false = feeder skip). */
  const runOneIteration = async (
    slotIndex: number,
    producerSlotId: string,
    slotIteration: number,
    globalIteration: number,
  ): Promise<boolean> => {
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

    const failSetup = (): true => {
      // A setup-time failure (feeder exhausted / input threw) still counts as a
      // started+failed iteration so the artifact reflects it.
      sink.beginIteration(envelope);
      sink.emitIterationStart(envelope, {});
      sink.emitIterationEnd(envelope, { ok: false, durationMs: 0, errorKind: "setupError" });
      sink.endIteration(iterationId);
      return true;
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
      if (skipped) return false;
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

    await runLoadIteration({
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
    });
    return true;
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
      const ran = await runOneIteration(slotIndex, producerSlotId, slotIteration, globalIteration);
      if (ran) primaryIterations += 1;
      slotIteration += 1;
      if (thinkTimeMs !== undefined) await pausedSleep(thinkDelay(thinkTimeMs));
    }
    sink.emitProducerSlotEnd(slotIndex, primaryIterations);
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, (_, i) => runSlot(i)));
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }

  const endReason: LoadEndReason =
    iterations !== undefined && claimed >= iterations ? "iterations" : durationMs !== undefined ? "duration" : "iterations";
  sink.emitLoadEnd(endReason);

  const artifact = reducer.finalize();
  // Evaluate configured thresholds against the finalized artifact and refine the
  // pass verdict (a crash-free run still fails if a threshold is breached).
  if (single.thresholds !== undefined) {
    const { thresholds, pass } = evaluateThresholds(artifact, single.thresholds);
    artifact.summary.thresholds = thresholds;
    artifact.summary.pass = pass;
  }
  return artifact;
}
