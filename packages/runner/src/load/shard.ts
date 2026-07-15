/**
 * `shardPlan()` — PURE split of a `LoadPlan` into N per-worker shards (internal
 * load-distributed-execution proposal §5.1 / §6 / §9, milestone D1).
 *
 * D0 delivered the merge primitives (reducer partials, timeline/slot-busy merge);
 * D1 splits the EXECUTION side into N shards that each run the existing orchestrator
 * loop over a disjoint slice of the run. This file is ONLY the static, deterministic
 * partition: it spawns no process, touches no runtime, does no IO / clock / randomness.
 * Given the same `(plan, workerCount)` it always returns byte-identical shards — that
 * determinism is what lets a coordinator hand every worker its slice up front and lets
 * a run's identity (§6.3) / feeder allocation (§9) stay worker-count independent.
 *
 * What is split, and how:
 *  - concurrency  → producer slots, even split, remainder front-loaded from worker 0
 *    (§6.1). Each shard carries its global `slotIndexBase` + `globalConcurrency` so
 *    ramp timing (`rampDelayMs`, a GLOBAL-slot function) and slot-indexed feeders
 *    (`uniquePerVu` / `partitionByVu`) work run-globally without any per-shard data.
 *  - iterations   → for an iterations-bounded run, the fixed global index set
 *    `[0, iterations)` is cut into CONTIGUOUS ranges whose lengths are proportional to
 *    each shard's slot count (largest remainder); a duration-only run has no finite
 *    index set, so each worker takes a STRIDE `k, k+N, k+2N, …` (§6.2 / §6.3).
 *  - continuation → `maxOutstanding` / `maxConcurrent` are split by a CONSERVING
 *    largest-remainder (Σ shards === global bound exactly), with §5.2 clamping
 *    guaranteeing every shard ≥ 1; `drainTimeout` / `minPollInterval` are time
 *    semantics and pass through unchanged (§6.4).
 *  - feeders      → strategies that index by a run-global DRAW counter
 *    (`uniquePerIteration` / `roundRobin`) get a contiguous ROW SEGMENT per shard
 *    (§9); slot-indexed and seeded-random strategies need no segment (see
 *    {@link SEGMENTED_STRATEGIES}).
 *
 * What is NOT split (run-level, identical for every worker): `rampUp` (global-slot
 * semantics), `pacing.thinkTime` (passed through), `duration` (becomes each worker's
 * `dispatchDeadline` at D1 runtime — carried here, not split), and `thresholds`
 * (evaluated ONLY at the coordinator, §6.1 — never shipped to a worker). These are
 * surfaced on {@link ShardPlanResult.runLevel} so the split output is self-contained.
 *
 * The single-worker case (`N === 1`, whether requested or clamped) is the degenerate
 * identity: one shard with the full slot range, the full iteration set
 * (`[0, iterations)` / stride `{offset:0, step:1}`), the untouched continuation
 * bounds, and a full `[0, size)` segment for every feeder — i.e. exactly single-node
 * semantics.
 */
import type {
  AnyLoadRunnerConfig,
  FeederBinding,
  FeederStrategy,
  LoadContinuationConfig,
  LoadMixConfig,
  LoadPacingConfig,
  LoadPlan,
  LoadRunnerConfig,
} from "@glubean/sdk/load";
import { entryFeederSlotId, sharedFeederSlotId } from "./feeder-slot-id.js";

/** A contiguous, half-open range `[start, end)` of GLOBAL iteration indexes — the
 *  iterations-bounded partition. Lengths sum to `iterations` and the ranges tile
 *  `[0, iterations)` with no gap or overlap (§6.3). */
export interface IterationRange {
  kind: "range";
  start: number;
  /** Exclusive. `start === end` is a legal empty range (a shard with zero quota). */
  end: number;
}

/** A stride partition of the (unbounded) global iteration sequence — the duration-only
 *  case: worker `k` runs indexes `offset, offset+step, offset+2·step, …`. With `step`
 *  equal to the worker count the N strides are disjoint and their union is every index
 *  (§6.3). Single-worker degenerate form is `{offset:0, step:1}` (all indexes). */
export interface IterationStride {
  kind: "stride";
  offset: number;
  step: number;
}

export type ShardIterationIndexes = IterationRange | IterationStride;

/** A contiguous, half-open row segment `[offset, offset + length)` of a feeder's rows,
 *  assigned to one shard. Across shards the segments of a feeder tile `[0, size)` with
 *  no overlap (uniqueness preserved); `length === 0` is a legal empty segment (that
 *  shard's draws from this feeder exhaust immediately). */
export interface FeederSegment {
  offset: number;
  length: number;
}

/**
 * One worker's static slice of the run — the `shard` sub-object of the proposal's
 * `RunLoadShardOptions` (§5.1). Runtime-only fields of that options bag (`rngSeed`,
 * `baseSession`, `timelineOrigin`, `startAt`, `dispatchDeadline`, `epochAnchor`,
 * `abort`, `onProgress`, `onSnapshot`) are supplied by the D1 coordinator at dispatch
 * time, not here — `shardPlan` only computes what is a pure function of the plan.
 */
export interface LoadShard {
  /** Positional shard identity `w${index}` (index in `[0, workerCount)`). The REAL
   *  runtime `workerId` is auth-bound to a session (§5, "不信 payload 身份"); this is
   *  the shard slot the coordinator binds an authenticated worker to. */
  workerId: string;
  /** Global index of this shard's FIRST producer slot (0-based). The shard owns global
   *  slots `[slotIndexBase, slotIndexBase + slotCount)`. */
  slotIndexBase: number;
  /** Number of producer slots this shard runs. */
  slotCount: number;
  /** The GLOBAL concurrency (Σ over all shards of `slotCount`), identical on every
   *  shard. Fed to `rampDelayMs(globalSlotIndex, globalConcurrency, rampUpMs)` and to
   *  `FeederDrawContext.producerCount` so ramp curve and slot-striped feeders span the
   *  whole run, not just this worker. */
  globalConcurrency: number;
  /** Which global iteration indexes this shard runs (range for iterations-bounded,
   *  stride for duration-only). */
  iterationIndexes: ShardIterationIndexes;
  /** Per-feeder row segments, keyed by canonical FeederSlotId (the same JSON-tuple
   *  string the orchestrator builds for `WorkloadFeeder.slotKey`). Present ONLY for
   *  `uniquePerIteration` / `roundRobin` feeders (see {@link SEGMENTED_STRATEGIES});
   *  slot-indexed and seeded-random feeders carry no entry (they shard by global slot
   *  index or a global seeded stream). Empty when the run declares no segmented feeder. */
  feederSegments: Record<string, FeederSegment>;
  /** This shard's conserved slice of the continuation config — present iff the plan
   *  configured `continuation`. `maxOutstanding` / `maxConcurrent` are split so the
   *  shards sum EXACTLY to the global bound (each ≥ 1 by §5.2 clamping); the time /
   *  policy fields (`drainTimeout`, `minPollInterval`, `onBacklogFull`) are copied
   *  through unchanged. */
  continuation?: LoadContinuationConfig;
}

/** Run-level config that every shard inherits UNCHANGED — surfaced so the pure split
 *  is self-contained. None of these is split across shards. */
export interface ShardRunLevel {
  /** Global concurrency (= every shard's `globalConcurrency`, = Σ slotCount). */
  concurrency: number;
  /** Global ramp-up window (ms); a worker computes each slot's delay with its GLOBAL
   *  slot index via `rampDelayMs`. Absent when the plan has no `rampUp`. */
  rampUpMs?: number;
  /** Global duration bound (ms) — becomes each worker's `dispatchDeadline` at D1
   *  runtime (not split; identical for all shards). Absent for an iterations-only run. */
  durationMs?: number;
  /** Global iteration bound — the size of the `[0, iterations)` set the ranges tile.
   *  Absent for a duration-only run. */
  iterations?: number;
  /** Pacing (`thinkTime`) — passed through unchanged (think-time jitter is keyed by
   *  the global iteration index at runtime, §6.5, so it needs no per-shard split). */
  pacing?: LoadPacingConfig;
  // NOTE: `thresholds` are deliberately NOT here — they are evaluated only at the
  // coordinator against the MERGED artifact (§6.1) and never shipped to a worker.
}

/** Result of {@link shardPlan}: the shards plus the effective worker count, the
 *  run-level passthrough config, and — when the requested worker count was reduced by
 *  §5.2 clamping — why. */
export interface ShardPlanResult {
  /** The per-worker shards, `shards.length === workerCount`. */
  shards: LoadShard[];
  /** The EFFECTIVE worker count after §5.2 clamping (`= shards.length`). Never 0. */
  workerCount: number;
  /** Run-level config every shard inherits unchanged. */
  runLevel: ShardRunLevel;
  /** The originally REQUESTED worker count — present only when it was clamped down
   *  (`workerCount < clampedFrom`). Absent when the request was honoured. */
  clampedFrom?: number;
  /** Human-readable clamp cause — the binding constraint(s) that pinned the effective
   *  worker count, e.g. `"iterations=3"` or `"concurrency=4, continuation.maxConcurrent=4"`.
   *  Present iff `clampedFrom` is. */
  clampReason?: string;
}

/**
 * Feeder strategies that need an explicit per-shard ROW SEGMENT (§9): they draw by a
 * run-global monotonic DRAW counter, which cannot be made worker-count independent
 * except by partitioning the row space into disjoint contiguous segments.
 *
 * The other strategies carry NO `feederSegments` entry, each by its own §9 rule:
 *  - `uniquePerVu` / `partitionByVu`: index by the GLOBAL slot index — the shard's
 *    `slotIndexBase` + `globalConcurrency` already make each global slot pick its own
 *    row / stripe, so an extra row segment would double-partition and is wrong;
 *  - `random` / `weightedRandom`: draw from the seeded stream keyed by the GLOBAL
 *    iteration index (§6.5), identical on every worker — no row ownership to split.
 */
const SEGMENTED_STRATEGIES: ReadonlySet<FeederStrategy> = new Set<FeederStrategy>([
  "uniquePerIteration",
  "roundRobin",
]);

/** One distinct feeder slot of the run: its canonical FeederSlotId and its binding. */
interface FeederSlot {
  slotKey: string;
  binding: FeederBinding;
}

/**
 * Largest-remainder apportionment: distribute `total` INTEGER units across buckets in
 * proportion to `weights`. Returns integers that sum EXACTLY to `total` (conservation),
 * each bucket getting `floor(ideal)` plus possibly one more; the leftover units go to
 * the largest fractional remainders, ties broken by LOWER bucket index (so the split is
 * deterministic and, with equal weights, front-loads the remainder onto worker 0 —
 * matching the concurrency rule in §6.1). `total === 0` yields all zeros.
 *
 * Conservation is exact regardless of float rounding in the ideals: the number of
 * "+1" bumps is computed as `total − Σfloor` (integer arithmetic), so the result always
 * re-sums to `total`. By construction that leftover is in `[0, buckets)`.
 */
function largestRemainder(total: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const sumW = weights.reduce((a, b) => a + b, 0);
  // Degenerate (all weights zero) — cannot happen for our callers (slot counts sum to
  // concurrency ≥ 1, quotas sum to iterations ≥ 1), but guarded so the fn is total:
  // fall back to an even, front-loaded split of `total`.
  if (sumW <= 0) {
    const base = Math.floor(total / n);
    const rem = total - base * n;
    return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
  }
  const ideals = weights.map((w) => (total * w) / sumW);
  const result = ideals.map((x) => Math.floor(x));
  let leftover = total - result.reduce((a, b) => a + b, 0);
  // Bump the buckets with the largest fractional part first; tie → lower index.
  const order = ideals
    .map((x, i) => ({ frac: x - Math.floor(x), i }))
    .sort((a, b) => (b.frac !== a.frac ? b.frac - a.frac : a.i - b.i));
  for (let j = 0; leftover > 0 && j < order.length; j++, leftover--) {
    result[order[j].i] += 1;
  }
  return result;
}

/**
 * Enumerate the run's DISTINCT feeder slots with their bindings, mirroring EXACTLY the
 * orchestrator's `makeWorkload` lowering (see `orchestrator.ts` `WorkloadFeeder.slotKey`)
 * so the canonical FeederSlotId keys match what the run loop actually uses:
 *  - single scenario: every `config.feeders` name is a SHARED slot `["shared", name]`;
 *  - traffic mix: a top-level `config.feeders` name is a shared slot `["shared", name]`
 *    IFF at least one entry does not override it (the orchestrator only draws the shared
 *    binding on non-overriding entries' turns); each entry's own feeder is a per-entry
 *    slot `["entry", entryId, name]` (distinct even when two entries reuse one binding).
 *
 * `Object.entries` + `hasOwnProperty` are own-enumerable only, so a feeder named
 * `toString` survives (parity with the orchestrator's Object.prototype-safe checks).
 * The canonical FeederSlotId strings come from the SHARED {@link sharedFeederSlotId} /
 * {@link entryFeederSlotId} helpers the orchestrator's `makeWorkload` also uses, so the
 * segment keys here can never drift from the `slotKey` the run loop draws against (§9).
 */
function enumerateFeederSlots(config: AnyLoadRunnerConfig): FeederSlot[] {
  const slots: FeederSlot[] = [];
  const seen = new Set<string>();
  const push = (slotKey: string, binding: FeederBinding): void => {
    // A shared name is ONE slot even if many entries draw it; first binding wins (they
    // are the same top-level binding object anyway).
    if (seen.has(slotKey)) return;
    seen.add(slotKey);
    slots.push({ slotKey, binding });
  };

  if ("scenarios" in config) {
    const mix = config as LoadMixConfig;
    const shared = mix.feeders ?? {};
    const entries = Array.isArray(mix.scenarios) ? mix.scenarios : [];
    for (const [name, binding] of Object.entries(shared)) {
      const drawnAsShared = entries.some(
        (e) => !Object.prototype.hasOwnProperty.call(e.feeders ?? {}, name),
      );
      if (drawnAsShared) push(sharedFeederSlotId(name), binding as FeederBinding);
    }
    for (const entry of entries) {
      const entryId = typeof entry.id === "string" ? entry.id : "";
      for (const [name, binding] of Object.entries(entry.feeders ?? {})) {
        push(entryFeederSlotId(entryId, name), binding as FeederBinding);
      }
    }
  } else {
    const single = config as LoadRunnerConfig;
    for (const [name, binding] of Object.entries(single.feeders ?? {})) {
      push(sharedFeederSlotId(name), binding as FeederBinding);
    }
  }
  return slots;
}

/** Validate a continuation numeric bound the way the orchestrator does — a positive
 *  integer — so a bad bound fails HERE (with the field name) rather than producing a
 *  nonsense split. */
function validateContinuationBound(
  planId: string,
  field: "maxOutstanding" | "maxConcurrent",
  value: number | undefined,
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `shardPlan "${planId}": continuation.${field} must be a positive integer (got ${value})`,
    );
  }
}

/**
 * Split a `LoadPlan` into N per-worker shards (see the file header for the full model).
 * Pure: same `(plan, workerCount)` ⇒ identical result, with no side effects.
 *
 * @param plan        the `loadRunner()` plan to shard (read via its static projection +
 *                    config; never executed).
 * @param workerCount the REQUESTED worker count (a positive integer). The effective
 *                    count is clamped to `min(workerCount, concurrency, iterations,
 *                    continuation.maxOutstanding, continuation.maxConcurrent)` (§5.2);
 *                    when clamped, `result.clampedFrom` / `clampReason` explain why.
 * @throws if `workerCount` is not a positive integer, if the plan's concurrency /
 *         iterations / continuation bounds are invalid, or if the plan sets neither
 *         `duration` nor `iterations` (no termination bound → the stride/range choice
 *         is undefined; same rule the orchestrator enforces).
 */
export function shardPlan(plan: LoadPlan, workerCount: number): ShardPlanResult {
  const planId = plan.id;
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error(
      `shardPlan "${planId}": workerCount must be a positive integer (got ${workerCount})`,
    );
  }

  const { concurrency, durationMs, iterations, rampUpMs } = plan.projection;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`shardPlan "${planId}": concurrency must be a positive integer (got ${concurrency})`);
  }
  if (durationMs === undefined && iterations === undefined) {
    throw new Error(
      `shardPlan "${planId}": set \`duration\` and/or \`iterations\` — a load run needs a termination bound to shard`,
    );
  }
  if (iterations !== undefined && (!Number.isInteger(iterations) || iterations < 1)) {
    throw new Error(`shardPlan "${planId}": iterations must be a positive integer (got ${iterations})`);
  }
  // Mirror `runLoad`'s duration guard, INDEPENDENT of iterations: a present-but-non-positive
  // duration (`duration: 0` / `"0s"`, or a non-finite parse) has no valid dispatch window, so
  // the plan is rejected up front rather than sharded into workers that would each receive a
  // zero deadline. This holds even for a dual-bound run — the orchestrator validates duration
  // regardless of iterations, so a `0` duration paired with a valid `iterations` is still bad.
  if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs <= 0)) {
    throw new Error(
      `shardPlan "${planId}": duration must resolve to a positive number of ms (got ${durationMs})`,
    );
  }

  const continuation = plan.config.continuation;
  validateContinuationBound(planId, "maxOutstanding", continuation?.maxOutstanding);
  validateContinuationBound(planId, "maxConcurrent", continuation?.maxConcurrent);

  // ---- §5.2 worker-count clamp -------------------------------------------------------
  // N = min(requested, concurrency, iterations?, continuation.maxOutstanding?,
  //         continuation.maxConcurrent?). Every bound is a positive integer, so N ≥ 1;
  // that floor is what guarantees the continuation split produces no zero quota (§6.4).
  const bounds: Array<{ name: string; value: number }> = [
    { name: `concurrency=${concurrency}`, value: concurrency },
  ];
  if (iterations !== undefined) bounds.push({ name: `iterations=${iterations}`, value: iterations });
  if (continuation?.maxOutstanding !== undefined) {
    bounds.push({ name: `continuation.maxOutstanding=${continuation.maxOutstanding}`, value: continuation.maxOutstanding });
  }
  if (continuation?.maxConcurrent !== undefined) {
    bounds.push({ name: `continuation.maxConcurrent=${continuation.maxConcurrent}`, value: continuation.maxConcurrent });
  }
  const capacity = Math.min(...bounds.map((b) => b.value));
  const N = Math.min(workerCount, capacity);
  const clamped = N < workerCount;
  // When clamped, the binding cause is whichever bound(s) equal the effective N.
  const clampReason = clamped
    ? bounds.filter((b) => b.value === N).map((b) => b.name).join(", ")
    : undefined;

  // ---- concurrency split (§6.1): even, remainder front-loaded from worker 0 ----------
  const base = Math.floor(concurrency / N);
  const rem = concurrency % N;
  const slotCounts = Array.from({ length: N }, (_, k) => base + (k < rem ? 1 : 0));
  const slotIndexBases: number[] = [];
  {
    let acc = 0;
    for (let k = 0; k < N; k++) {
      slotIndexBases.push(acc);
      acc += slotCounts[k];
    }
  }

  // ---- iteration split (§6.2 / §6.3) -------------------------------------------------
  const iterationsBounded = iterations !== undefined;
  // For an iterations-bounded run this is each shard's iteration QUOTA (also the row-
  // segment weight, §9). Undefined for a duration-only (stride) run.
  let iterationQuotas: number[] | undefined;
  const iterationIndexesByWorker: ShardIterationIndexes[] = [];
  if (iterationsBounded) {
    // Quota ∝ slot count (largest remainder), then laid out as contiguous ranges that
    // tile [0, iterations). A zero quota (possible only for a tiny-iterations run) is a
    // legal empty range [x, x); coverage/conservation hold regardless.
    iterationQuotas = largestRemainder(iterations as number, slotCounts);
    let start = 0;
    for (let k = 0; k < N; k++) {
      const end = start + iterationQuotas[k];
      iterationIndexesByWorker.push({ kind: "range", start, end });
      start = end;
    }
  } else {
    // Duration-only: no finite index set — worker k strides k, k+N, k+2N, … (disjoint,
    // union = every index). Single worker degenerates to {offset:0, step:1} = all.
    for (let k = 0; k < N; k++) {
      iterationIndexesByWorker.push({ kind: "stride", offset: k, step: N });
    }
  }

  // ---- continuation split (§6.4): conserving largest remainder, each shard ≥ 1 -------
  let continuationByWorker: Array<LoadContinuationConfig | undefined>;
  if (continuation === undefined) {
    continuationByWorker = Array.from({ length: N }, () => undefined);
  } else {
    const outstanding =
      continuation.maxOutstanding !== undefined
        ? largestRemainder(continuation.maxOutstanding, slotCounts)
        : undefined;
    const concurrent =
      continuation.maxConcurrent !== undefined
        ? largestRemainder(continuation.maxConcurrent, slotCounts)
        : undefined;
    // §5.2 guarantees N ≤ each configured bound, so the conserving split assigns every
    // shard ≥ 1 — assert it (a violation is a real invariant bug, not a valid outcome).
    for (let k = 0; k < N; k++) {
      if (outstanding !== undefined && outstanding[k] < 1) {
        throw new Error(
          `shardPlan "${planId}": continuation.maxOutstanding split produced a zero quota for worker ${k} — §5.2 clamp invariant violated`,
        );
      }
      if (concurrent !== undefined && concurrent[k] < 1) {
        throw new Error(
          `shardPlan "${planId}": continuation.maxConcurrent split produced a zero quota for worker ${k} — §5.2 clamp invariant violated`,
        );
      }
    }
    continuationByWorker = Array.from({ length: N }, (_, k) => ({
      ...(outstanding !== undefined ? { maxOutstanding: outstanding[k] } : {}),
      ...(concurrent !== undefined ? { maxConcurrent: concurrent[k] } : {}),
      // Time / policy semantics are NOT split — copied through unchanged.
      ...(continuation.minPollInterval !== undefined ? { minPollInterval: continuation.minPollInterval } : {}),
      ...(continuation.drainTimeout !== undefined ? { drainTimeout: continuation.drainTimeout } : {}),
      ...(continuation.onBacklogFull !== undefined ? { onBacklogFull: continuation.onBacklogFull } : {}),
    }));
  }

  // ---- feeder row segments (§9) ------------------------------------------------------
  // Rows are split proportional to each shard's iteration weight: the iteration QUOTA
  // for a bounded run (a worker running x% of iterations owns ~x% of the rows), or the
  // slot count for a duration-only run (steady-state iteration-rate proportion).
  const feederSegmentsByWorker: Array<Record<string, FeederSegment>> = Array.from(
    { length: N },
    () => ({}),
  );
  const segmentWeights = iterationsBounded ? (iterationQuotas as number[]) : slotCounts;
  for (const { slotKey, binding } of enumerateFeederSlots(plan.config)) {
    if (!SEGMENTED_STRATEGIES.has(binding.strategy)) continue;
    const size = Number.isInteger(binding.size) && binding.size >= 0 ? binding.size : 0;
    const lengths = largestRemainder(size, segmentWeights);
    let offset = 0;
    for (let k = 0; k < N; k++) {
      feederSegmentsByWorker[k][slotKey] = { offset, length: lengths[k] };
      offset += lengths[k];
    }
  }

  // ---- assemble shards ---------------------------------------------------------------
  const shards: LoadShard[] = Array.from({ length: N }, (_, k) => ({
    workerId: `w${k}`,
    slotIndexBase: slotIndexBases[k],
    slotCount: slotCounts[k],
    globalConcurrency: concurrency,
    iterationIndexes: iterationIndexesByWorker[k],
    feederSegments: feederSegmentsByWorker[k],
    ...(continuationByWorker[k] !== undefined ? { continuation: continuationByWorker[k] } : {}),
  }));

  const runLevel: ShardRunLevel = {
    concurrency,
    ...(rampUpMs !== undefined ? { rampUpMs } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(iterations !== undefined ? { iterations } : {}),
    ...(plan.config.pacing !== undefined ? { pacing: plan.config.pacing } : {}),
  };

  return {
    shards,
    workerCount: N,
    runLevel,
    ...(clamped ? { clampedFrom: workerCount, clampReason } : {}),
  };
}
