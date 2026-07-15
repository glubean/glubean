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
  LoadErrorKind,
  LoadMixConfig,
  LoadPlan,
  LoadResolvedConfig,
  LoadRunnerConfig,
  LoadScenario,
  LoadScenarioRef,
} from "@glubean/sdk/load";
import { parseDurationMs } from "@glubean/sdk/load";
import { randomUUID } from "node:crypto";

import { createEngineCore } from "../engine-bridge.js";
import {
  compileLoadScenario,
  startLoadIteration,
  type CompiledLoadScenario,
  type LoadIterationHandle,
  type RunLoadIterationResult,
} from "./execute-iteration.js";
import { ContinuationPool } from "./continuation-pool.js";
import { createLoadReducer, type LoadReducerImpl } from "./reducer.js";
import type { LoadReducerPartialV1 } from "./partial.js";
import type { LoadShard } from "./shard.js";
import { entryFeederSlotId, sharedFeederSlotId } from "./feeder-slot-id.js";
import { prng } from "./rng.js";
import { LoadSink, type LoadIterationEnvelope } from "./sink.js";
import { evaluateThresholds, validateLoadMetricsConfig } from "./threshold.js";

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
  /**
   * Root seed for the run's counter-keyed RNG streams: traffic-mix scenario
   * selection (`prng(seed, "mix", iterationIndex)`), `random`/`weightedRandom`
   * feeder draws (`prng(seed, feederSlotKey, iterationIndex)`), and pacing
   * think-time jitter (`prng(seed, "pacing", iterationIndex)`).
   * Every random decision is a pure function of the seed and the decision's
   * GLOBAL identity — same seed, same plan + data ⇒ the same decisions, in any
   * process and any scheduling order (§6.5). Defaults to a fresh random seed.
   * Recorded in `artifact.config.rngSeed` so any run can be replayed — but ONLY
   * when every random decision came from the seeded streams: a run where the
   * deprecated `random` override actually drove mix selection has the recording
   * suppressed (see `random`).
   */
  rngSeed?: string;
  /** RNG in [0,1) for weighted traffic-mix scenario selection. Unused for a
   *  single-scenario run (selection is trivial).
   *  @deprecated Prefer `rngSeed` — a seeded run is reproducible AND keyed by the
   *  global iteration index (call-order independent), while this override is
   *  consumed in slot-scheduling order. Retained as a test-injection override for
   *  scripting EXACT selection sequences; when set it overrides ONLY mix
   *  selection (feeder / pacing streams still come from `rngSeed`). A run where
   *  the override ACTUALLY participated in selection is not seed-replayable, so
   *  `artifact.config.rngSeed` is deliberately omitted there; a run that never
   *  consulted it (single scenario / single-entry mix) stays fully seeded and
   *  keeps its recorded seed. */
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
  /** Stable STRING form of the same draw-scope identity as `counterKey` — the keyed
   *  RNG stream key for this slot's random draws (§6.5), as a JSON-encoded component
   *  tuple: `["shared", name]` or `["entry", entryId, name]`. JSON array encoding
   *  keeps the components injectively separated (an entry id / feeder name may itself
   *  contain any delimiter — naive `entry:<id>:<name>` joining collides for
   *  `("a:b","c")` vs `("a","b:c")`, merging two slots' random streams). A single
   *  canonical string (not a tuple) so it survives process boundaries and D1 can
   *  reuse it directly as the `feederSegments` record key (the proposal's canonical
   *  FeederSlotId); scoped like `counterKey` so two slots reusing one binding object
   *  still draw independent random streams. */
  slotKey: string;
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

/** A single think-time delay (random within [min,max) for a range, drawn from `rng` —
 *  the orchestrator passes the keyed pacing stream so jitter is reproducible; the
 *  `Math.random` default keeps direct callers working unseeded). Exported for tests. */
export function thinkDelay(
  thinkTimeMs: number | { min: number; max: number } | undefined,
  rng: () => number = Math.random,
): number {
  if (thinkTimeMs === undefined) return 0;
  if (typeof thinkTimeMs === "number") return thinkTimeMs;
  const { min, max } = thinkTimeMs;
  return min + rng() * Math.max(0, max - min);
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

/** Default periodic snapshot cadence for a distributed shard (proposal §7.1: 15s). A
 *  worker exports a cumulative `LoadReducerPartialV1` this often so a coordinator can
 *  render live progress; injectable (`snapshotIntervalMs`) so tests need not wait 15s. */
const DEFAULT_SNAPSHOT_INTERVAL_MS = 15_000;

/** The unreleased-tail-poll advisory — an iteration ran a long TAIL poll without asking
 *  for producer release, so its slot stayed tied up. It is sink/orchestrator-level (not
 *  reducer-derivable), so a shard STAMPS it onto its exported partial's `advisories`
 *  (the slot `exportPartial` reserves for exactly this) AND `runLoad` pushes it onto the
 *  single-machine artifact. One literal, two consumers. */
const UNRELEASED_TAIL_POLL_ADVISORY =
  "Most producer slot time is spent after the primary request; closed end-to-end scheduling may reduce upstream pressure. Call `await ctx.report.primaryComplete(..., { releaseProducerSlot: true })` after the primary load is issued if you want sustained ingress pressure.";

/**
 * Options for running ONE shard of a load plan in-process (proposal §5.1
 * `RunLoadShardOptions`). A shard runs only the slice of the run its {@link LoadShard}
 * describes — a global sub-range of producer slots, a range/stride of the global
 * iteration index set, and a contiguous row segment of each segmented feeder — while
 * ramp timing, feeder slot-striping and every seeded RNG decision stay keyed by GLOBAL
 * identity so the union of shards is byte-equivalent to a single-node run. The shard
 * evaluates NO thresholds and finalizes NO artifact (coordinator work, §6.1); it folds
 * its events into a reducer and emits cumulative `LoadReducerPartialV1` frames.
 */
export interface RunLoadShardOptions {
  /** This worker's static slice of the run (from `shardPlan`). */
  shard: LoadShard;
  /** Root seed for the run's counter-keyed RNG streams (§6.5) — the SAME seed on every
   *  shard so mix selection / random feeder draws / pacing jitter are worker-count
   *  independent. `runLoad` defaults it to a fresh UUID; a coordinator generates it once
   *  and hands the identical value to every shard. */
  rngSeed: string;
  /** Shared run-axis origin (epoch ms) every emitted offset is computed against
   *  (D0 reducer support). A coordinator passes its authoritative `t0`; absent, the
   *  worker's first event anchors the axis (single-process semantics). */
  timelineOrigin?: number;
  /** Absolute epoch-ms instant this worker should begin dispatching (a coordinator's
   *  synchronized start). Omitted single-machine → start immediately. */
  startAt?: number;
  /** Absolute epoch-ms instant dispatch stops (the run `duration` as a wall-clock
   *  deadline, §6). Omitted → the plan's `duration` is used as a relative window
   *  (single-machine parity); absent from both → an iterations-only run. */
  dispatchDeadline?: number;
  /** Cumulative-partial sink: called PERIODICALLY (every `snapshotIntervalMs`) and ONCE at
   *  run end (the terminal frame the coordinator merges). MAY be async — D1-3 delivers frames
   *  over IPC / the network: the shard AWAITS the terminal frame's delivery before resolving
   *  (so a worker never exits before the coordinator has the final frame), while periodic
   *  frames are best-effort (an in-flight guard prevents overlap; delivery failures are
   *  swallowed and the coordinator re-polls). Omitted → no frames are exported (the `runLoad`
   *  single-machine path, which finalizes from the reducer). */
  onSnapshot?: (partial: LoadReducerPartialV1) => void | Promise<void>;
  /** Periodic snapshot cadence (ms); default {@link DEFAULT_SNAPSHOT_INTERVAL_MS}. */
  snapshotIntervalMs?: number;
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
  /** @deprecated mix-selection override — see {@link RunLoadOptions.random}. Carried so
   *  `runLoad` can pass it through; a distributed run never sets it. */
  random?: () => number;
  /** Cooperative early-termination signal (proposal §5.1 / §10.5). When it fires the shard
   *  STOPS opening new iterations, closes the continuation pool so parked producers wake at
   *  once, drains in-flight continuations under the configured `drainTimeout`, and finalizes
   *  with `endReason: "abort"` — the SAME clean wind-down as a natural end, just triggered
   *  externally (a D1 coordinator's `abort` control frame, or the worker harness reacting to a
   *  lost channel). Absent → no external termination hook (single-machine `runLoad` parity —
   *  byte-identical behaviour). Already-aborted at call time ends dispatch before the first
   *  slot opens (the `startAt` gate below is skipped so an aborted shard does not sleep to a
   *  future start). */
  abort?: AbortSignal;
}

/**
 * What a shard hands back beyond the streamed partials — the orchestrator-observed
 * facts a coordinator (or the `runLoad` shell) needs to finalize that the cumulative
 * reducer state does not itself carry. The live `reducer` is returned so the in-process
 * single-machine shell can finalize LOSSLESSLY (byte-identical to the pre-refactor
 * `runLoad`) instead of round-tripping through export/hydrate.
 */
export interface RunLoadShardResult {
  /** The live reducer (finalize + `latencyQuantiles` substrate). Runner-internal. */
  reducer: LoadReducerImpl;
  /** The reason this shard's dispatch ended (§7.4), recorded at the termination event. */
  endReason: LoadEndReason;
  /** The `now()` captured at finalization — the run-end denominator the shell/coordinator
   *  passes to `reducer.finalize`, and the terminal partial's `observedAt`. */
  finalizeNow: number;
  /** The deprecated `random` override actually drove a mix selection → the run is not
   *  seed-replayable (the shell drops the recorded `rngSeed`). */
  mixOverrideUsed: boolean;
  /** Peak concurrent continuation tails this worker saw (incl. deadline-released ones the
   *  pool never admitted) — the reducer's `maxBacklog` can't see those. */
  peakContinuations: number;
  /** Continuations the drain timeout abandoned (still in flight at finalize). */
  abortedByDrainTimeout: number;
  /** Some iteration ran an unreleased tail poll (the advisory condition). */
  unreleasedTailPollRan: boolean;
  /** Largest overshoot (ms) of a slot's absolute ramp target `startAt + rampDelay` — a
   *  worker that woke late (§5.1). 0 single-machine (no `startAt`) and when no slot ran late. */
  maxStartLatenessMs: number;
}

/**
 * Run ONE shard of a load plan in-process — the shard-aware EXECUTION KERNEL that
 * `runLoad` (single shard) and the D1 coordinator (N shards) both drive. Handles BOTH a
 * single-scenario run and a traffic mix (`scenarios[]`): each is lowered to weighted
 * `Workload`s, every iteration picks one (weighted-random keyed by the GLOBAL iteration
 * index, the sole one otherwise). Throws on a plan with neither `duration` nor
 * `iterations`. Closed model; continuation / pacing are run-level.
 *
 * Shard-awareness (proposal §6/§9): producer slots run at GLOBAL indices
 * `[slotIndexBase, slotIndexBase + slotCount)` so `rampDelayMs` and slot-striped feeders
 * span the whole run; iterations are claimed from the shard's `iterationIndexes` (a
 * contiguous range, or a stride for a duration-only run) as GLOBAL indices; segmented
 * feeders (`uniquePerIteration` / `roundRobin`) draw from their per-shard row segment via
 * a draw-index offset; every seeded RNG key uses the global iteration index. The shard
 * neither evaluates thresholds nor finalizes an artifact — it exports cumulative
 * `LoadReducerPartialV1` frames (periodic + terminal) and returns the live reducer plus
 * the orchestrator-observed extras a coordinator needs ({@link RunLoadShardResult}).
 */
export async function runLoadShard(
  plan: LoadPlan,
  opts: RunLoadShardOptions,
): Promise<RunLoadShardResult> {
  const config = plan.config;
  const projection = plan.projection;
  const { shard, startAt, dispatchDeadline, onSnapshot } = opts;
  const { durationMs, iterations, rampUpMs } = projection;
  // GLOBAL concurrency (Σ every shard's slotCount) — drives the ramp curve and the
  // feeder `producerCount`, so both span the whole run, not just this worker's slots.
  // Equal to `projection.concurrency`; validated below with the same message/value.
  const concurrency = shard.globalConcurrency;

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
  // Report sample caps bound retained samples — a non-integer / negative / Infinity cap
  // would break the bounded-sampling guarantee. 0 is allowed (disables that sample type).
  const failureTraceCap = config.report?.failureTraces;
  if (failureTraceCap !== undefined && (!Number.isInteger(failureTraceCap) || failureTraceCap < 0)) {
    throw new Error(`loadRunner "${plan.id}": report.failureTraces must be a non-negative integer (got ${failureTraceCap})`);
  }
  const slowSummaryCap = config.report?.slowTransactionSummaries;
  if (slowSummaryCap !== undefined && (!Number.isInteger(slowSummaryCap) || slowSummaryCap < 0)) {
    throw new Error(`loadRunner "${plan.id}": report.slowTransactionSummaries must be a non-negative integer (got ${slowSummaryCap})`);
  }
  // Custom metrics: declarations + `thresholds.customMetric` targets fail fast HERE —
  // untyped JS config bypasses the compile-time types, and an out-of-union kind or a
  // typo'd gate target would otherwise surface as a schema-invalid artifact / a
  // silently-skipped gate at the END of the run.
  const metricConfigErrors = validateLoadMetricsConfig(config.metrics, config.thresholds?.customMetric);
  if (metricConfigErrors.length > 0) {
    throw new Error(`loadRunner "${plan.id}": ${metricConfigErrors.join("; ")}`);
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
        feeders.push({
          name,
          binding,
          counterKey: sharedCounterKey(name),
          slotKey: sharedFeederSlotId(name),
        });
      }
    }
    // The entry's own feeders (entry wins a name clash): each gets a UNIQUE marker key, so
    // two entries reusing the same binding object still draw independent per-entry sequences.
    // The RNG slotKey carries the same per-entry identity as a canonical JSON tuple.
    for (const [name, binding] of Object.entries(entry)) {
      feeders.push({
        name,
        binding,
        counterKey: {},
        slotKey: entryFeederSlotId(scenarioRefId ?? "", name),
      });
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

  // Root seed of the run's counter-keyed RNG streams (§6.5). Every random decision
  // below — mix selection, random feeder draws, pacing jitter — is a pure function of
  // this seed and the decision's global identity, so a seeded run is reproducible and
  // (under distributed execution) independent of worker count. The caller supplies it
  // (`runLoad` defaults to a fresh UUID; a coordinator hands every shard the SAME seed);
  // it is recorded in `artifact.config.rngSeed` for replay unless the deprecated `random`
  // override ACTUALLY drives mix selection (then the shell drops the recorded seed).
  const rngSeed = opts.rngSeed;

  // Weighted scenario selection for a mix, keyed by the GLOBAL iteration index —
  // `prng(seed, "mix", index)` — so the pick for iteration N is the same whichever
  // slot (or worker) claims it. The deprecated `opts.random` override wins when set
  // (test injection of exact sequences; consumed in slot-scheduling order). A single
  // scenario draws nothing (selection is trivial), keeping such runs byte-identical.
  // The override's use is TRACKED: only a run where it ACTUALLY drove a selection is
  // non-seed-replayable (finalization then drops `rngSeed` from the artifact) — a
  // single-workload run never consults it, so its seed replay promise stays intact.
  let mixOverrideUsed = false;
  const overrideRandom = opts.random;
  const mixRandom: (iterationIndex: number) => number =
    overrideRandom !== undefined
      ? () => {
          mixOverrideUsed = true;
          return overrideRandom();
        }
      : (i) => prng(rngSeed, "mix", i);
  const totalWeight = workloads.reduce((sum, w) => sum + w.weight, 0);
  const selectWorkload = (iterationIndex: number): Workload => {
    if (workloads.length === 1) return workloads[0];
    let r = mixRandom(iterationIndex) * totalWeight;
    for (const w of workloads) {
      r -= w.weight;
      if (r < 0) return w;
    }
    return workloads[workloads.length - 1]; // float-rounding safety net
  };

  const thinkTimeMs = normalizeThinkTime(config.pacing);

  // A distributed shard (one that streams frames to a coordinator via `onSnapshot`)
  // stamps its `timelineOrigin` (the shared run axis, D0) and `workerId` (sample
  // provenance for the cross-worker merge) into the reducer. The single-machine `runLoad`
  // path passes neither — so its reducer anchors offsets to `firstTs` and leaves sample
  // identities workerId-free, exactly the pre-D1 single-node artifact. (`workerId` is
  // gated on `onSnapshot`, not on `shard.workerId`, precisely so runLoad's positional
  // `w0` never leaks false provenance onto a single-node run's samples.)
  const reducer = createLoadReducer({
    maxFailureTraces: config.report?.failureTraces,
    maxSlowTransactionSummaries: config.report?.slowTransactionSummaries,
    ...(opts.timelineOrigin !== undefined ? { timelineOrigin: opts.timelineOrigin } : {}),
    ...(onSnapshot !== undefined ? { workerId: shard.workerId } : {}),
  });
  const sink = new LoadSink(reducer, runId, runnerId, now);
  const core = createEngineCore(sink.handleWire, {
    vars: opts.vars ?? {},
    secrets: opts.secrets ?? {},
    abortMode: config.abort ?? "precise",
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
  // The POOL bound is this SHARD's continuation slice (§6.4 splits maxOutstanding /
  // maxConcurrent per worker so their backlogs sum to the global bound); the time/policy
  // fields pass through unchanged. For the single shard `runLoad` builds, `shard.continuation`
  // IS the whole `config.continuation`, so this is byte-identical to the global bound.
  // (The resolved config recorded on `load:start` above stays GLOBAL — every shard reports
  // the run's continuation config so the coordinator's replace-with-first merge sees it.)
  const shardContinuationCfg = resolveContinuationConfig(shard.continuation);
  const continuationBound =
    shardContinuationCfg?.maxOutstanding !== undefined && shardContinuationCfg?.maxConcurrent !== undefined
      ? Math.min(shardContinuationCfg.maxOutstanding, shardContinuationCfg.maxConcurrent)
      : shardContinuationCfg?.maxOutstanding ?? shardContinuationCfg?.maxConcurrent;
  const continuationPool = new ContinuationPool(
    continuationBound,
    shardContinuationCfg?.onBacklogFull ?? "block-producer",
    shardContinuationCfg?.drainTimeoutMs,
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
    // The seed is recorded (even when auto-generated) so the run's random decisions
    // can be replayed. If the deprecated `random` override ends up ACTUALLY driving
    // mix selection, finalization deletes it from the artifact — see below. (The wire
    // `load:start` event still carries it as a runtime fact: whether the override is
    // consulted isn't known yet at emit time, and feeder/pacing streams use it anyway.)
    rngSeed,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(iterations !== undefined ? { iterations } : {}),
    ...(rampUpMs !== undefined ? { rampUpMs } : {}),
    ...(thinkTimeMs !== undefined ? { pacing: { thinkTimeMs } } : {}),
    ...(continuationCfg !== undefined ? { continuation: continuationCfg } : {}),
    ...(mixScenarios !== undefined ? { scenarios: mixScenarios } : {}),
  };

  // startAt gate (a coordinator's synchronized dispatch instant): hold until the shared
  // start before opening any slot, so every worker's producer slots begin together on the
  // run axis. Omitted single-machine → no wait (byte-identical to the pre-D1 path).
  // Skip the pre-start sleep if the shard was aborted before it even started — an aborted
  // shard must not block to a future `startAt` just to immediately end. And if an abort fires
  // DURING the wait (a coordinator can pick a `startAt` seconds/minutes out), wake at once so
  // the shard winds down promptly instead of blocking to the barrier — the already-aborted
  // handling at the in-run abort listener below then stamps `endReason: "abort"` and dispatches
  // nothing. (This gate precedes the main abort listener, so it carries its own wake.)
  if (startAt !== undefined && opts.abort?.aborted !== true) {
    const wait = startAt - now();
    if (wait > 0) {
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        const onAbortWake = (): void => {
          clearTimeout(timer);
          resolve();
        };
        timer = setTimeout(() => {
          opts.abort?.removeEventListener("abort", onAbortWake);
          resolve();
        }, wait);
        opts.abort?.addEventListener("abort", onAbortWake, { once: true });
      });
    }
  }
  const start = now();
  sink.emitLoadStart(resolvedConfig);

  // Feeder-state guarantee THIS shard's exported frames report (§9): a sharded run must not
  // claim the single-node guarantee. Derived from the shard's feeder strategy set — a
  // segmented feeder (`uniquePerIteration` / `roundRobin`, the only strategies `shardPlan`
  // assigns a row segment) is best-effort under sharding → "degraded"; slot-indexed /
  // seeded-random strategies shard exactly → "distributed"; no feeders → "single-node"
  // (vacuous — nothing to distribute). Multiple strategies take the WEAKEST, which is exactly
  // `hasSegmentedFeeder ? degraded : distributed`. Stamped ONLY on exported frames (the
  // distributed path); the single-machine artifact keeps finalize's "single-node".
  const hasFeeders = workloads.some((w) => w.feeders.length > 0);
  const hasSegmentedFeeder = Object.keys(shard.feederSegments).length > 0;
  const shardFeederGuarantee: LoadArtifact["runtime"]["feederGuarantee"] = !hasFeeders
    ? "single-node"
    : hasSegmentedFeeder
      ? "degraded"
      : "distributed";

  // Stamp shard-level facts onto an exported frame that `exportPartial` cannot know:
  //  - `requestedConcurrency` ← this shard's slotCount (the ADDITIVE field the coordinator
  //    merge SUMS: Σ slotCount === the run's global concurrency, so it must carry the
  //    PER-SHARD value, never the global one the reducer folded from `load:start`);
  //  - `feederGuarantee` ← the sharded value above (else a sharded artifact would report the
  //    single-node guarantee `exportPartial` hard-codes);
  //  - the sink/orchestrator-level unreleased-tail-poll advisory (not reducer-derivable).
  const stampShardFrame = (frame: LoadReducerPartialV1): LoadReducerPartialV1 => {
    frame.requestedConcurrency = shard.slotCount;
    frame.feederGuarantee = shardFeederGuarantee;
    if (sink.unreleasedTailPollRan) frame.advisories.push(UNRELEASED_TAIL_POLL_ADVISORY);
    return frame;
  };

  // Periodic cumulative snapshots (proposal §7.1): a distributed worker exports its
  // reducer state every `snapshotIntervalMs` (default 15s) so a coordinator can render
  // live progress. Armed ONLY when a sink is provided — the single-machine `runLoad`
  // omits `onSnapshot`, so no timer is created and there is zero added work there.
  // `exportPartial` never mutates live state, so a mid-run snapshot is safe between the
  // loop's await points; `unref` keeps the timer from holding a standalone process open.
  //
  // `onSnapshot` MAY be async (D1-3 IPC / network delivery). Periodic frames are
  // BEST-EFFORT: an in-flight guard skips a tick while the previous frame is still being
  // delivered (no overlap, no back-pressure buildup), and a delivery failure is swallowed
  // (the coordinator re-polls; the terminal frame below carries the authoritative final
  // state and IS awaited). `periodicInFlight` is tracked so the terminal frame can let a
  // pending periodic settle before it, staying genuinely last.
  let snapshotTimer: ReturnType<typeof setInterval> | undefined;
  let periodicInFlight: Promise<void> | undefined;
  if (onSnapshot !== undefined) {
    const deliver = onSnapshot;
    const intervalMs = opts.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
    snapshotTimer = setInterval(() => {
      if (periodicInFlight !== undefined) return; // previous frame still delivering — skip this tick
      // The async wrapper turns a synchronous throw in `deliver` into a rejection too, so the
      // `.catch` swallows both (a periodic delivery failure must never crash the run loop).
      periodicInFlight = (async () => deliver(stampShardFrame(reducer.exportPartial(now()))))()
        .catch(() => {})
        .finally(() => {
          periodicInFlight = undefined;
        });
    }, intervalMs);
    snapshotTimer.unref?.();
  }

  // Run-end coordination. Ramp-up / think-time waits are CANCELLABLE real timers:
  // while a slot legitimately waits, its timer is ref'd (so a standalone Node run
  // can't exit before it resolves), but the moment the run ends — iterations cap
  // reached, or the duration deadline fires — every pending wait is cleared and
  // resolved at once, so a slot never overruns the bound (late ramped slots that
  // will claim nothing, or a think-time after the final iteration, wake instantly).
  let ended = false;
  // An external `abort` (opts.abort) requested this shard's termination. Recorded so
  // markEnded stamps `endReason: "abort"` (proposal §7.4 / §5.1) rather than reconstructing
  // "duration"/"iterations": an abort is what actually ended the run.
  let abortRequested = false;
  // The ACTUAL end trigger, recorded AT the termination event (§7.4: endReason is
  // never reconstructed post-hoc). Set by markEnded below; read once at load:end.
  let recordedEndReason: LoadEndReason | undefined;
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
    // Record the trigger (§7.4 priority: duration > iterations). A quota end
    // records "iterations" once; the wall-clock deadline firing at ANY point while
    // the run is still winding down — including MID-DRAIN, since the timer is only
    // cleared after the drain completes — records "duration", overriding an
    // earlier quota end: in a dual-bound run whose deadline cut the drain short,
    // the duration bound genuinely shaped the run's ending, so reconstructing
    // "iterations" from `claimed >= iterations` after the fact would misreport it.
    // Priority: an external abort wins (it is the true cause); else duration > iterations.
    if (abortRequested) recordedEndReason = "abort";
    else if (wallClockUp) recordedEndReason = "duration";
    else if (recordedEndReason === undefined) recordedEndReason = "iterations";
    // Both a wall-clock deadline and an abort close the pool immediately so parked
    // producers wake at once (an abort must not wait on a continuation slot to wind down).
    if (wallClockUp || abortRequested) continuationPool.closeImmediate();
  };

  // External abort hook (proposal §5.1 / §10.5): flip `abortRequested`, then `markEnded`
  // stops new iterations, wakes ramp/think waiters, and closes the pool — the drain + seal
  // that follow wind the shard down cleanly and finalize with `endReason: "abort"`. Only the
  // in-run window is covered here; an abort BEFORE dispatch is handled by the `startAt` gate
  // guard above (aborted shard skips the sleep, then claims nothing). `{ once: true }`
  // auto-detaches on fire; the `finally` detaches a never-fired listener.
  const onExternalAbort = (): void => {
    abortRequested = true;
    markEnded();
  };
  if (opts.abort !== undefined) {
    if (opts.abort.aborted) onExternalAbort();
    else opts.abort.addEventListener("abort", onExternalAbort, { once: true });
  }
  // A duration deadline timer wakes ramp/think waiters at the bound even if no slot
  // happens to claim (and thus re-check) right then. A coordinator's absolute
  // `dispatchDeadline` takes precedence; else the plan's relative `duration` window
  // (byte-identical to the pre-D1 `setTimeout(…, durationMs)` when no deadline is given).
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (dispatchDeadline !== undefined) {
    deadlineTimer = setTimeout(() => markEnded(true), Math.max(0, dispatchDeadline - now()));
  } else if (durationMs !== undefined) {
    deadlineTimer = setTimeout(() => markEnded(true), durationMs);
  }

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

  // Iteration claiming from THIS shard's slice of the GLOBAL index set. A slot claims the
  // next LOCAL sequence number before running; the shard maps it to a GLOBAL iteration
  // index — `start + k` for a contiguous range (iterations-bounded), `offset + k·step`
  // for a stride (duration-only, unbounded, disjoint across workers, §6.3). -1 means this
  // shard's dispatch is over. Single-threaded JS makes the claim atomic. For the single
  // shard `runLoad` builds — range `{0, iterations}` or stride `{offset:0, step:1}` — this
  // reduces to the pre-D1 global counter over `[0, iterations)` exactly.
  const iterIdx = shard.iterationIndexes;
  const rangeBounded = iterIdx.kind === "range";
  const shardQuota = rangeBounded ? iterIdx.end - iterIdx.start : Infinity;
  const toGlobalIndex = rangeBounded
    ? (k: number): number => iterIdx.start + k
    : (k: number): number => iterIdx.offset + k * iterIdx.step;
  let claimed = 0; // LOCAL sequence within this shard's slice
  const durationExpired = (): boolean =>
    dispatchDeadline !== undefined
      ? now() >= dispatchDeadline
      : durationMs !== undefined && now() - start >= durationMs;
  const claimIteration = (): number => {
    // The deadline timer can flip `ended` independently of the (possibly frozen /
    // injected) clock, so honour it directly — not just `durationExpired()`.
    if (ended) return -1;
    if (durationExpired()) {
      markEnded(true); // duration bound hit on a claim → wall-clock is up
      return -1;
    }
    if (rangeBounded && claimed >= shardQuota) {
      markEnded(); // this shard exhausted its iteration quota → "iterations"
      return -1;
    }
    const index = toGlobalIndex(claimed);
    claimed += 1;
    // Claiming the shard's last quota iteration ends its dispatch — wake ramp/think waiters.
    if (rangeBounded && claimed >= shardQuota) markEnded();
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
    globalSlotIndex: number,
    producerSlotId: string,
    globalIteration: number,
    slotIteration: number,
    workload: Workload,
    feederSlotDraws: Map<object, number>,
  ): LoadIterationHandle | "skip" | "failed" => {
    const iterationId = `it-${globalIteration}`;
    const producerSlot = { id: producerSlotId, index: globalSlotIndex };
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
    // `rng` is this draw's keyed random stream — `prng(seed, feederSlotKey, iterationIndex)`
    // (§6.5): keyed by GLOBAL identity, not draw order, so a random/weightedRandom draw for
    // iteration N is the same whichever slot (or worker) runs it.
    const drawCtxFor = (counterKey: object, slotKey: string): FeederDrawContext => {
      const g = feederGlobalDraws.get(counterKey) ?? 0;
      feederGlobalDraws.set(counterKey, g + 1);
      const s = feederSlotDraws.get(counterKey) ?? 0;
      feederSlotDraws.set(counterKey, s + 1);
      // `drawIndex` is THIS shard's WINDOW-LOCAL per-feeder draw count. A segmented feeder
      // (`uniquePerIteration` / `roundRobin`) carries its assigned row segment as `rowWindow`,
      // so the feeder bounds the draw to `[offset, offset+length)` as a HARD boundary (§9): a
      // shard can never index into another shard's rows (fixing the over-draw that let two
      // shards return the same row), and `recycle` wraps WITHIN the segment. Non-segmented
      // strategies carry no segment — `uniquePerVu` shards by the GLOBAL slot index,
      // `partitionByVu` by (globalSlot, globalConcurrency), `random`/`weightedRandom` by the
      // global seeded stream. For the single shard `runLoad` builds, `feederSegments` is empty
      // → no window → `drawIndex === g` keeps its pre-D1 run-global meaning.
      const segment = shard.feederSegments[slotKey];
      return {
        producerSlot: globalSlotIndex,
        producerCount: concurrency,
        slotIteration,
        globalIteration,
        drawIndex: g,
        slotDrawIndex: s,
        ...(segment !== undefined ? { rowWindow: { offset: segment.offset, length: segment.length } } : {}),
        rng: (...keys: Array<string | number>) => prng(rngSeed, slotKey, globalIteration, ...keys),
      };
    };

    const failSetup = (errorKind: LoadErrorKind = "setupError"): "failed" => {
      // A setup-time failure (feeder exhausted / input threw) still counts as a
      // started+failed iteration so the artifact reflects it. A `fail`-policy
      // feeder exhaustion is attributed `feederExhausted` (schema v2): the
      // FRAMEWORK ran out of data — not a SUT error, and not the same signal as
      // a throwing feeder/input fn (those stay `setupError`).
      sink.beginIteration(envelope);
      sink.emitIterationStart(envelope, {});
      sink.emitIterationEnd(envelope, { ok: false, durationMs: 0, errorKind });
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
      for (const { name, binding, counterKey, slotKey } of workload.feeders) {
        const draw = binding.allocate(drawCtxFor(counterKey, slotKey));
        if (draw.outcome === "value") {
          feed[name] = draw.value;
          if (draw.key !== undefined) feederKeys[name] = draw.key;
        } else if (draw.outcome === "skip" || draw.outcome === "wait") {
          // `skip`/`wait`: the iteration opts out (wait-and-retry isn't modelled in
          // the closed MVP — both just skip). Not a failure, not counted.
          skipped = true;
          break;
        } else {
          return failSetup("feederExhausted"); // exhausted (fail policy) — framework data ran out
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
      ...(config.metrics !== undefined ? { metrics: config.metrics } : {}),
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

  // Largest overshoot of a slot's absolute ramp target (a worker that woke after
  // `startAt + rampDelay`); 0 single-machine and whenever no slot ran late.
  let maxStartLatenessMs = 0;

  const runSlot = async (globalSlotIndex: number): Promise<void> => {
    // Ramp timing is a GLOBAL-slot function (§6.1): a shard's slots ramp at their global
    // positions, so the whole run's ramp curve is worker-count independent. A plan with no
    // `rampUp` is a ZERO-delay ramp — every slot's delay is 0 — which still matters under a
    // distributed `startAt` (a startAt-only plan is common), so it is NOT skipped there.
    const rampDelay = rampUpMs !== undefined ? rampDelayMs(globalSlotIndex, concurrency, rampUpMs) : 0;
    if (startAt !== undefined) {
      // Distributed: align each slot to the ABSOLUTE instant `startAt + rampDelay` (§5.1;
      // rampDelay is 0 when the plan has no rampUp), so a worker that woke late does not shift
      // its whole ramp curve forward (which would eat the dispatch window before the deadline)
      // AND its lateness is always accounted. A slot already past its target opens at once; the
      // overshoot is recorded as start lateness.
      const wait = startAt + rampDelay - now();
      if (wait > 0) await pausedSleep(wait);
      else if (-wait > maxStartLatenessMs) maxStartLatenessMs = -wait;
    } else if (rampUpMs !== undefined) {
      // Single-machine ramp: relative to the run start (unchanged — byte-identical; a plan
      // with no rampUp and no startAt opens every slot immediately, exactly as before).
      await pausedSleep(rampDelay);
    }
    sink.emitProducerSlotStart(globalSlotIndex);
    const producerSlotId = `p${globalSlotIndex}`;
    // Per-slot iteration index (the `slotIteration` public contract field), and per-slot
    // per-feeder draw counts (what partitionByVu actually indexes by, via `slotDrawIndex`).
    let slotIteration = 0;
    const feederSlotDraws = new Map<object, number>();
    let primaryIterations = 0;
    for (;;) {
      const globalIteration = claimIteration();
      if (globalIteration < 0) break;
      // Pick this iteration's workload (weighted-random for a mix keyed by the global
      // iteration index, the sole one for a single scenario); the feeders it draws
      // advance their own per-binding counters (see drawCtxFor).
      const workload = selectWorkload(globalIteration);
      const started = startOneIteration(globalSlotIndex, producerSlotId, globalIteration, slotIteration, workload, feederSlotDraws);
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
      // skip/wait feeder doesn't spin the loop in a paced run. Range jitter draws
      // from the keyed pacing stream, `prng(seed, "pacing", iterationIndex)`: the
      // key is the just-run ITERATION's global identity, NOT (slot, slot-turn) —
      // the iteration→slot binding is completion-timing driven and non-deterministic,
      // so a slot-keyed stream would change with concurrency / scheduling and break
      // seeded replay (and shift duration-bounded results). thinkTime semantics are
      // "the pause after that iteration's turn", so the iteration IS the decision's
      // identity. (Deliberate deviation from the §6.5 proposal text's
      // `(globalSlotIndex, slotIteration)` key, which is scheduling-dependent —
      // the proposal is being fixed to match.)
      if (thinkTimeMs !== undefined) {
        await pausedSleep(thinkDelay(thinkTimeMs, () => prng(rngSeed, "pacing", globalIteration)));
      }
    }
    sink.emitProducerSlotEnd(globalSlotIndex, primaryIterations);
  };

  let abortedByDrainTimeout = 0;
  try {
    // Launch THIS shard's producer slots at their GLOBAL indices
    // [slotIndexBase, slotIndexBase + slotCount). For the single shard `runLoad` builds
    // that is `[0, concurrency)` — exactly the pre-D1 launch.
    await Promise.all(
      Array.from({ length: shard.slotCount }, (_, j) => runSlot(shard.slotIndexBase + j)),
    );
    abortedByDrainTimeout = await drainContinuations(continuations, shardContinuationCfg?.drainTimeoutMs);
  } finally {
    // Detach the external-abort listener (no-op if it already fired via `{ once: true }` or
    // was never attached) so a resolved shard leaves nothing bound to the caller's signal.
    if (opts.abort !== undefined) opts.abort.removeEventListener("abort", onExternalAbort);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (snapshotTimer !== undefined) clearInterval(snapshotTimer);
    // All primaries are done and the drain phase has run; abort whatever continuation
    // tail is still in flight so its in-flight HTTP / engine poll waits stop NOW rather
    // than running on in the background. A tail that already settled (drain awaited it,
    // or there was no drainTimeout) makes this a no-op. The aborted tails settle on later
    // microtasks — after the synchronous `seal()` below — so their late events are still
    // dropped, leaving the artifact unchanged; only the wasted in-flight work is cut.
    runAbort.abort();
  }

  // The reason recorded AT the actual termination event (markEnded), not a post-hoc
  // reconstruction — `claimed >= iterations` alone can't tell a pure quota end from a
  // dual-bound run whose duration deadline fired mid-drain (§7.4: duration wins then).
  // The fallback is defensive only: every path that ends the run goes through
  // markEnded, so a finished run always has a recorded reason.
  // The reason recorded AT this shard's termination event (markEnded), not a post-hoc
  // reconstruction. The fallback is defensive: every path that ends dispatch goes through
  // markEnded. A duration/deadline-bounded shard defaults to "duration"; else "iterations".
  const endReason: LoadEndReason =
    recordedEndReason ?? (durationMs !== undefined || dispatchDeadline !== undefined ? "duration" : "iterations");
  sink.emitLoadEnd(endReason);
  // Seal the sink so a continuation the drain timeout abandoned can't emit into the
  // reducer after the frame is exported. The `runAbort.abort()` above already cancelled
  // its in-flight HTTP / engine poll waits, so a tail settles promptly; seal is the
  // backstop for the late events that abort can't pre-empt (e.g. a bare `setTimeout` in
  // user code, which no signal can cancel) and for the settle that lands post-seal.
  sink.seal();

  // Finalization instant (this worker's own): the `load:end` just emitted was stamped
  // `now()` too, so this differs from the reducer's `lastTs` fallback only by the sub-ms
  // emit→finalize gap. Captured ONCE and used both as the terminal snapshot's `observedAt`
  // AND (by the caller) as `reducer.finalize`'s run-end denominator, so the streamed frame
  // and the finalized artifact describe the same instant. A coordinator supplies its own
  // authoritative `globalEndAt` to `finalize`/`finalizeMerged` instead.
  const finalizeNow = now();

  // Terminal cumulative snapshot — the "final" frame a coordinator merges (proposal §7.5;
  // the FINAL flag itself is a coordinator-side concept — the worker just exports its
  // complete state at the run-end instant). Emitted only when a sink is wired: `runLoad`
  // omits `onSnapshot` and finalizes from the returned reducer, paying no export cost. The
  // sink/orchestrator-level unreleased-tail-poll advisory (not reducer-derivable) is
  // stamped onto the frame's reserved `advisories` slot.
  if (onSnapshot !== undefined) {
    // Let any in-flight periodic frame settle first, so the terminal frame is genuinely the
    // LAST one delivered; then AWAIT the terminal's delivery so the shard does not resolve
    // (and a D1-3 worker does not exit) before the coordinator has the final frame. Unlike a
    // periodic frame, a terminal delivery failure is NOT swallowed — it propagates so the
    // caller sees that the final state never reached the coordinator.
    if (periodicInFlight !== undefined) await periodicInFlight;
    await onSnapshot(stampShardFrame(reducer.exportPartial(finalizeNow)));
  }

  // A shard evaluates NO thresholds and finalizes NO artifact (coordinator work, §6.1); it
  // hands back the live reducer plus the orchestrator-observed extras the cumulative state
  // does not itself carry, so the caller can finalize.
  return {
    reducer,
    endReason,
    finalizeNow,
    mixOverrideUsed,
    peakContinuations,
    abortedByDrainTimeout,
    unreleasedTailPollRan: sink.unreleasedTailPollRan,
    maxStartLatenessMs,
  };
}

/**
 * Run a load plan locally and return its finalized `LoadArtifact` — the single-machine
 * SHELL around {@link runLoadShard}. It runs the whole plan as ONE shard (every producer
 * slot, the full iteration index set, the un-segmented feeder space — exact single-node
 * semantics), then finalizes the shard's reducer and evaluates thresholds (the
 * coordinator-side work `runLoadShard` deliberately omits). Handles BOTH a single-scenario
 * run and a traffic mix (`scenarios[]`); throws on a plan with neither `duration` nor
 * `iterations`. Byte-identical to the pre-D1 monolithic `runLoad`: the kernel/shell split
 * is a lossless refactor — the shell finalizes from the LIVE reducer the kernel returns,
 * never through an export round-trip.
 */
export async function runLoad(plan: LoadPlan, opts: RunLoadOptions = {}): Promise<LoadArtifact> {
  const config = plan.config;
  const { concurrency, iterations } = plan.projection;
  // The degenerate single shard: one worker owns every slot `[0, concurrency)`, the full
  // iteration set (a `[0, iterations)` range, or an all-indexes `{offset:0, step:1}`
  // stride for a duration-only run), the whole continuation config, and an EMPTY feeder-
  // segment map (offset 0 → every draw indexes the full row space). Built inline (not via
  // `shardPlan`) so `runLoadShard`'s own validation surfaces the `loadRunner`-prefixed
  // error messages this function has always thrown, in the same order.
  const shard: LoadShard = {
    workerId: "w0",
    slotIndexBase: 0,
    slotCount: concurrency,
    globalConcurrency: concurrency,
    iterationIndexes:
      iterations !== undefined
        ? { kind: "range", start: 0, end: iterations }
        : { kind: "stride", offset: 0, step: 1 },
    feederSegments: {},
    ...(config.continuation !== undefined ? { continuation: config.continuation } : {}),
  };
  const result = await runLoadShard(plan, {
    shard,
    // Default the run seed here (a distributed coordinator generates it once for all
    // shards). No timelineOrigin / workerId / onSnapshot → the reducer anchors to firstTs
    // and leaves samples workerId-free, and no partial frames are exported: the single-node
    // artifact is produced from the live reducer below, exactly as before D1.
    rngSeed: opts.rngSeed ?? randomUUID(),
    ...(opts.vars !== undefined ? { vars: opts.vars } : {}),
    ...(opts.secrets !== undefined ? { secrets: opts.secrets } : {}),
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    ...(opts.runnerId !== undefined ? { runnerId: opts.runnerId } : {}),
    ...(opts.baseSession !== undefined ? { baseSession: opts.baseSession } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.random !== undefined ? { random: opts.random } : {}),
  });

  const { reducer } = result;
  // Authoritative run-end boundary: the kernel's finalization instant (see the kernel's
  // `finalizeNow` — its `load:end` was stamped the same `now()`).
  const artifact = reducer.finalize(result.finalizeNow);
  // The deprecated mix-selection override ACTUALLY drove at least one selection → this run
  // is not replayable from the seed, so drop the recorded seed rather than promise a false
  // replay. A run that never consulted it stays fully seeded and keeps its seed.
  if (result.mixOverrideUsed) delete artifact.config.rngSeed;
  // Continuations the drain timeout abandoned are still in flight at finalize — surface
  // them (the reducer can't know the orchestrator's drain decision), along with the true
  // peak of concurrent tails (incl. deadline-released ones the pool never admitted, so the
  // reducer's maxBacklog can't see them).
  if (artifact.summary.continuation) {
    const c = artifact.summary.continuation;
    c.maxBacklog = Math.max(c.maxBacklog, result.peakContinuations);
    c.maxConcurrent = Math.max(c.maxConcurrent, result.peakContinuations);
    if (result.abortedByDrainTimeout > 0) {
      c.abortedByDrainTimeout = result.abortedByDrainTimeout;
      c.backlog = result.abortedByDrainTimeout;
      c.active = result.abortedByDrainTimeout;
      artifact.runtime.continuationInFlight = result.abortedByDrainTimeout;
    }
  }
  // Advisory: some iteration ran a long TAIL poll but didn't request producer release, so
  // its slot stayed tied up for the whole tail (closed end-to-end scheduling), under-
  // pressuring the upstream. (See the sink's `unreleasedTailPollRan` for the per-iteration
  // decision rule.)
  if (result.unreleasedTailPollRan) {
    (artifact.summary.advisories ??= []).push(UNRELEASED_TAIL_POLL_ADVISORY);
  }

  // Evaluate configured thresholds against the finalized artifact and refine the pass
  // verdict (a crash-free run still fails if a threshold is breached OR unevaluable).
  // Thresholds are run-level — for a mix they apply to the aggregate, not per scenario.
  // The reducer's per-scope histograms feed interval evaluation of latency quantile
  // gates (D0-T5): merged all-phase distributions, borderline intervals → unevaluable.
  if (config.thresholds !== undefined) {
    const { thresholds, pass, advisories } = evaluateThresholds(artifact, config.thresholds, reducer.latencyQuantiles());
    artifact.summary.thresholds = thresholds;
    artifact.summary.pass = pass;
    // Configured-but-unevaluable gates (e.g. a custom metric that never recorded a
    // sample) surface as advisories, so a skipped gate can't leave CI green unnoticed.
    if (advisories.length > 0) (artifact.summary.advisories ??= []).push(...advisories);
  }
  return artifact;
}
