/**
 * D0-9 — partition-identity PROPERTY test (internal load-distributed-execution
 * proposal §12, D0 acceptance): ANY partition of an event stream along
 * worker/iteration boundaries, folded through independent per-worker reducers →
 * `exportPartial` → wire → `mergePartials` → `finalizeMerged`, must reproduce a
 * single reducer's direct `finalize` over the whole stream — per aggregation
 * class:
 *
 *  1. additive counts are EXACTLY equal (transactions / steps / endpoints /
 *     matrix counters, custom-metric count/sum/trueCount, continuation counters);
 *  2. histogram BUCKET STATE is exactly identical per scope (the float `sum`
 *     field alone gets a ULP-scale tolerance — see `expectHistEqual`);
 *  3. timeline count windows agree window-by-window (requests/errors/starts
 *     exact; observed completions exact, with censoring closures accounted
 *     separately), and `peakInFlightBounds` brackets the direct run's exact peak;
 *  4. samples satisfy the total-order selection invariant (slow top-k set and
 *     first-N failure traces equal the direct run's, deterministic because the
 *     generator makes the order keys unique);
 *  5. provenance differs EXACTLY as specified (processModel / execution /
 *     requestedConcurrency), while summary.pass / endReason / threshold verdicts
 *     are identical.
 *
 * Generator design (all deliberate — change with care):
 *  - PARTITION UNIT: run-level events (load:start / load:end) are broadcast to
 *    every shard (each worker of a real sharded run receives the run lifecycle);
 *    each producer slot is owned WHOLLY by one shard, and every iteration runs on
 *    one slot — so iteration and slot lifecycles never cross partitions (§12:
 *    "生命周期不跨分区" is guaranteed by construction, and self-checked below).
 *  - SHARED SNAPSHOT INSTANT: every worker exports with the coordinator's
 *    authoritative instant, `exportPartial(RUN_END)`, so slot-busy integration of
 *    OPEN slots and the merge's timeline censoring cutoffs agree across parts.
 *    RUN_END is deliberately NOT a multiple of the 250ms window width: the
 *    censoring closure of still-in-flight iterations lands in the LAST RENDERED
 *    window (floor(RUN_END/250) === ceil(RUN_END/250)−1), so the merged artifact
 *    keeps the exact same dense axis as the direct one.
 *  - UNIQUE ORDER KEYS: iteration:end timestamps and durations carry a distinct
 *    dyadic fraction (i+1)/64 per iteration, making `completedAtOffsetMs` and
 *    `durationMs` globally unique. The sample total orders tie-break on workerId,
 *    which the direct (single-reducer) run does not have — with unique primary
 *    keys the tie-break never fires and set equality is deterministic.
 *  - FLOAT VS INTEGER DOMAINS: request/step/iteration/backpressure durations are
 *    fractional doubles, so the histogram `sum` comparison genuinely exercises
 *    the float-associativity tolerance; custom METRIC VALUES are integers, so
 *    their sums stay in the exact-integer float domain and the §12 "custom
 *    metrics count/sum/trueCount exactly equal" clause is asserted with `toBe`.
 */
import { describe, expect, it } from "vitest";
import type {
  LoadArtifact,
  LoadEvent,
  LoadFailureTraceSample,
  LoadSlowTransactionSummary,
  LoadThresholds,
} from "@glubean/sdk/load";
import { canonicalTagKey, createLoadReducer, LoadReducerImpl } from "./reducer.js";
import { LoadHistogram, type LoadHistogramJSON } from "./histogram.js";
import type { LoadTimelineWindowJSON } from "./timeline.js";
import { compareFailure, compareSlow } from "./samples.js";
import { evaluateThresholds } from "./threshold.js";
import {
  finalizeMerged,
  mergePartials,
  parseLoadReducerPartial,
  type LoadPartialCustomMetricV1,
  type LoadPartialCustomSeriesV1,
  type LoadReducerPartialV1,
} from "./partial.js";

const T0 = 1_000_000;
const WINDOW_MS = 250; // the timeline's baseWindowMs (no coarsening at these stream sizes)
/** Authoritative run end (coordinator `globalEndAt`), past every generated event.
 *  20_999 is NOT a WINDOW_MS multiple — see the header note on the closure window. */
const RUN_END = T0 + 20_999;
const SEED_COUNT = 30;
const K_CHOICES = [2, 3, 5] as const;
/** Small caps so the bounded-sample truncation path is genuinely exercised
 *  (the self-check asserts both caps overflow in at least one seed). */
const CAPS = { maxFailureTraces: 4, maxSlowTransactionSummaries: 4 };

/** Gates evaluated on BOTH paths; verdicts must agree row-for-row (§12 item 5).
 *  errorRate "<0.2" sits near the generator's ~0.22 expected error rate so both
 *  pass AND fail verdicts occur across the seed set (self-checked). */
const THRESHOLDS: LoadThresholds = {
  transaction: { p95: "<100000ms", errorRate: "<0.2" },
  endpoints: { "GET /a": { p95: "<100000ms" } },
  steps: { "0:step0": { p95: "<100000ms" } },
  customMetric: {
    m_count: { sum: "<1000000" },
    m_trend: { p95: "<100000ms" },
    "m_rate:class=2xx": { rate: ">=0" },
  },
};

// ── seeded stream generation ──────────────────────────────────────────────

/** Same LCG family as partial.test.ts — deterministic per seed. Warmed up three
 *  steps before use: for small consecutive seeds the LCG's FIRST output clusters
 *  tightly (≈0.236..0.248 for seeds 1..30), which made the K draw below pick 2
 *  for every seed; after warm-up the coverage self-check sees all of {2,3,5}. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  next();
  next();
  next();
  return next;
}

let seq = 0;
function ev(ts: number, body: Record<string, unknown>): LoadEvent {
  return { ts, seq: seq++, runId: "run1", runnerId: "plan-1", ...body } as unknown as LoadEvent;
}

/** Route provenance is FIXED per key except the one deliberately mixed key, whose
 *  observations roll 50/50 between a contract and a heuristic provenance — the
 *  reducer's own fold rule (heuristic wins) and the merge's must agree. Two
 *  DIFFERENT heuristic sources for one key would be a genuine conflict the merge
 *  rejects (covered by dedicated tests), so the generator never produces that. */
const ROUTES = [
  { routeKey: "GET /a", method: "GET", source: "normalized-url", heuristic: true },
  { routeKey: "POST /b", method: "POST", source: "contract-metadata", heuristic: false },
  { routeKey: "GET /c/:id", method: "GET", source: "explicit", heuristic: false },
] as const;

const METRIC_KINDS: Record<string, "rate" | "trend" | "counter"> = {
  m_rate: "rate",
  m_trend: "trend",
  m_count: "counter",
};
const METRIC_IDS = Object.keys(METRIC_KINDS);

interface PartitionedStream {
  /** Every event once, ts-ordered — the single-reducer ground truth. */
  all: LoadEvent[];
  /** K shards: broadcast run-level events + each shard's own slots/iterations. */
  parts: LoadEvent[][];
  /** Events broadcast to every shard (for the partition-accounting self-check). */
  broadcastCount: number;
  meta: { openSlots: number; withMix: boolean; endReason?: string };
}

function partitionedStream(rng: () => number, k: number): PartitionedStream {
  type Part = number | "run";
  const specs: { ts: number; part: Part; body: Record<string, unknown> }[] = [];
  const push = (part: Part, ts: number, body: Record<string, unknown>): void => {
    specs.push({ ts: T0 + ts, part, body });
  };

  // load:start (broadcast). Mix variant: a weighted scenarios[] composition + rngSeed.
  const withMix = rng() < 0.5;
  push("run", 0, {
    type: "load:start",
    config: {
      concurrency: 1 + Math.floor(rng() * 8),
      durationMs: 30_000,
      ...(withMix
        ? {
            rngSeed: "seed-1",
            scenarios: [
              { scenarioRefId: "a", scenarioId: "checkout", weight: 2 },
              { scenarioRefId: "b", scenarioId: "browse", weight: 1 },
            ],
          }
        : {}),
    },
  });

  // Producer slots, each owned wholly by one shard; ~30% stay OPEN at export
  // (their occupancy truncates at the shared observedAt on both paths).
  const slotCount = 1 + Math.floor(rng() * 4);
  const slotOwner: number[] = [];
  let openSlots = 0;
  for (let s = 0; s < slotCount; s++) {
    const owner = Math.floor(rng() * k);
    slotOwner.push(owner);
    const start = Math.floor(rng() * 1000);
    push(owner, start, { type: "producerSlot:start", producerSlotIndex: s });
    if (rng() < 0.7) {
      push(owner, start + 500 + Math.floor(rng() * 18_000), {
        type: "producerSlot:end",
        producerSlotIndex: s,
        primaryIterations: Math.floor(rng() * 20),
      });
    } else {
      openSlots += 1;
    }
  }

  // Iterations: 6..29 (< 64, so the (i+1)/64 dyadic fractions below stay unique).
  const iters = 6 + Math.floor(rng() * 24);
  for (let i = 0; i < iters; i++) {
    const slot = Math.floor(rng() * slotCount);
    const part = slotOwner[slot];
    const isCheckout = rng() < 0.5;
    const scenarioId = isCheckout ? "checkout" : "browse";
    const scenarioRefId =
      withMix || rng() < 0.5 ? (isCheckout ? "a" : "b") : undefined;
    const base = {
      scenarioId,
      ...(scenarioRefId !== undefined ? { scenarioRefId } : {}),
      producerSlotId: `p${slot}`,
      iterationId: `it-${i}`,
    };
    // Feeder variants: none / single key / multi-key row attribution.
    const feederRoll = rng();
    const feederKeys =
      feederRoll < 1 / 3
        ? undefined
        : feederRoll < 2 / 3
          ? { user: `u${i}` }
          : { user: `u${i}`, region: i % 2 === 0 ? "eu" : "us" };
    let t = Math.floor(rng() * 14_000);
    push(part, t, {
      type: "iteration:start",
      ...base,
      ...(feederKeys !== undefined ? { feederKeys } : {}),
    });
    let phase: "primary" | "continuation" = "primary";

    const stepCount = Math.floor(rng() * 4);
    for (let sI = 0; sI < stepCount; sI++) {
      const stepId = `${sI}:step${sI}`;
      const stepName = `step${sI}`;
      t += 1 + Math.floor(rng() * 300);
      const skipped = rng() < 0.1;
      if (!skipped) {
        push(part, t, {
          type: "step:start",
          ...base,
          stepId,
          stepName,
          phase,
          ...(rng() < 0.3 ? { groupId: "g" } : {}),
        });
      }
      const reqCount = skipped ? 0 : Math.floor(rng() * 3);
      for (let rI = 0; rI < reqCount; rI++) {
        t += 1 + Math.floor(rng() * 200);
        const route =
          rng() < 0.25
            ? // The mixed-provenance key: contract vs heuristic per observation.
              rng() < 0.5
              ? { routeKey: "POST /login", method: "POST", source: "contract-metadata", heuristic: false }
              : { routeKey: "POST /login", method: "POST", source: "normalized-url", heuristic: true }
            : ROUTES[Math.floor(rng() * ROUTES.length)];
        const ok = rng() < 0.85;
        push(part, t, {
          type: "request:observed",
          ...base,
          stepId,
          method: route.method,
          url: `https://x${route.routeKey}`,
          routeKey: route.routeKey,
          routeKeySource: route.source,
          routeKeyHeuristic: route.heuristic,
          ...(ok ? { status: 200 } : rng() < 0.5 ? { status: 500 } : {}),
          ok,
          durationMs: rng() * 400, // fractional — exercises the float-sum tolerance
          ...(ok ? {} : { errorKind: "http" }),
          phase,
        });
      }
      if (!skipped && rng() < 0.2) {
        t += 1;
        push(part, t, {
          type: "assertion:observed",
          ...base,
          stepId,
          passed: false,
          message: "boom",
          actual: { got: i },
          expected: 42,
          phase,
        });
      }
      if (rng() < 0.3) {
        t += 1;
        const mid = METRIC_IDS[Math.floor(rng() * METRIC_IDS.length)];
        push(part, t, {
          type: "metric:observed",
          ...base,
          metricId: mid,
          kind: METRIC_KINDS[mid],
          // INTEGER values — keeps custom-metric sums exact (see header).
          value: METRIC_KINDS[mid] === "rate" ? (rng() < 0.7 ? 1 : 0) : Math.floor(rng() * 100),
          ...(METRIC_KINDS[mid] === "trend" ? { unit: "ms" } : {}),
          ...(rng() < 0.5 ? { tags: { class: rng() < 0.5 ? "2xx" : "5xx" } } : {}),
          phase,
        });
      }
      t += 1 + Math.floor(rng() * 100);
      push(part, t, {
        type: "step:end",
        ...base,
        stepId,
        stepName,
        ok: rng() < 0.9,
        durationMs: rng() * 500,
        ...(skipped ? { skipped: true } : {}),
        assertionFailures: rng() < 0.2 ? 1 : 0,
        phase,
      });
    }

    // Continuation block: boundary → released / rejected(backlog-full) / parked,
    // released paths sometimes do real continuation-phase work.
    if (rng() < 0.45) {
      t += 1 + Math.floor(rng() * 200);
      const releaseRequested = rng() < 0.7;
      push(part, t, {
        type: "producer:primaryCompleted",
        ...base,
        primaryId: `pc-${i}`,
        primaryDurationMs: rng() * 1000,
        releaseRequested,
        phase,
      });
      phase = "continuation";
      if (releaseRequested) {
        const roll = rng();
        if (roll < 0.6) {
          t += 1;
          push(part, t, {
            type: "producer:released",
            ...base,
            releaseId: `rel-${i}`,
            primaryDurationMs: rng() * 1000,
            continuationBacklog: Math.floor(rng() * 5),
            backpressureMs: rng() * 50,
            phase,
          });
          if (rng() < 0.25) {
            t += 1;
            push(part, t, {
              type: "producer:releaseRejected",
              ...base,
              releaseId: `rel-${i}b`,
              reason: "duplicateRelease",
              waitMs: 0,
              continuationBacklog: 1,
              phase,
            });
          }
          if (rng() < 0.5) {
            // Real continuation-phase work after the release.
            t += 1 + Math.floor(rng() * 200);
            push(part, t, { type: "step:start", ...base, stepId: "9:poll", stepName: "poll", phase });
            t += 1 + Math.floor(rng() * 200);
            push(part, t, {
              type: "request:observed",
              ...base,
              stepId: "9:poll",
              method: "GET",
              url: "https://x/poll",
              routeKey: "GET /poll",
              routeKeySource: "normalized-url",
              routeKeyHeuristic: true,
              status: 200,
              ok: true,
              durationMs: rng() * 400,
              phase,
            });
            t += 1 + Math.floor(rng() * 100);
            push(part, t, {
              type: "step:end",
              ...base,
              stepId: "9:poll",
              stepName: "poll",
              ok: true,
              durationMs: rng() * 500,
              phase,
            });
          }
        } else if (roll < 0.8) {
          t += 1;
          push(part, t, {
            type: "producer:releaseRejected",
            ...base,
            releaseId: `rel-${i}`,
            reason: "continuationBacklogFull",
            waitMs: Math.floor(rng() * 100),
            continuationBacklog: 5,
            phase,
          });
        } // else: parked release (pendingReleases > 0 at export)
      }
    }

    if (rng() < 0.85) {
      t += 1 + Math.floor(rng() * 500);
      const ok = rng() < 0.78;
      push(part, t + (i + 1) / 64, {
        // The (i+1)/64 dyadic fraction makes every completedAtOffsetMs and
        // durationMs globally unique — see the header's UNIQUE ORDER KEYS note.
        type: "iteration:end",
        ...base,
        ok,
        durationMs: Math.floor(rng() * 2000) + (i + 1) / 64,
        ...(ok ? {} : { errorKind: rng() < 0.5 ? "timeout" : "http" }),
        phase,
      });
    } // else: left IN FLIGHT at export — the censoring-closure path
  }

  // load:end (broadcast, 85%): §7.4 endReason variants including abort and crash.
  let endReason: string | undefined;
  if (rng() < 0.85) {
    const roll = rng();
    endReason = roll < 0.6 ? "duration" : roll < 0.8 ? "iterations" : roll < 0.92 ? "abort" : "crash";
    push("run", 20_000, {
      type: "load:end",
      reason: endReason,
      ...(endReason === "crash"
        ? { crash: { kind: "runnerCrash", message: "boom", atMs: 19_000 } }
        : {}),
    });
  }

  specs.sort((x, y) => x.ts - y.ts); // stable → equal-ts events keep push order
  const all: LoadEvent[] = [];
  const parts: LoadEvent[][] = Array.from({ length: k }, () => []);
  let broadcastCount = 0;
  for (const s of specs) {
    const e = ev(s.ts, s.body);
    all.push(e);
    if (s.part === "run") {
      broadcastCount += 1;
      for (const p of parts) p.push(structuredClone(e));
    } else {
      parts[s.part].push(structuredClone(e));
    }
  }
  return { all, parts, broadcastCount, meta: { openSlots, withMix, ...(endReason !== undefined ? { endReason } : {}) } };
}

// ── per-seed case construction ────────────────────────────────────────────

function feed(events: LoadEvent[], config: Parameters<typeof createLoadReducer>[0]): LoadReducerImpl {
  const r = createLoadReducer(config);
  for (const e of events) r.apply(e);
  return r;
}

/** JSON wire round-trip + frame validation — what a real worker→coordinator hop does.
 *  (Doubles round-trip JSON losslessly, so this adds realism, not noise.) */
function wire(p: LoadReducerPartialV1): LoadReducerPartialV1 {
  return parseLoadReducerPartial(JSON.parse(JSON.stringify(p)) as unknown);
}

/** Mirror of the single-process orchestrator's threshold application (and of
 *  finalizeMerged's): evaluate on the interval path from the reducer's own
 *  histograms, overwrite summary.thresholds/pass, append advisories. */
function applyThresholds(art: LoadArtifact, reducer: LoadReducerImpl): LoadArtifact {
  const { thresholds, pass, advisories } = evaluateThresholds(art, THRESHOLDS, reducer.latencyQuantiles());
  art.summary.thresholds = thresholds;
  art.summary.pass = pass;
  if (advisories.length > 0) {
    art.summary.advisories = [...(art.summary.advisories ?? []), ...advisories];
  }
  return art;
}

interface Case {
  seed: number;
  k: number;
  stream: PartitionedStream;
  directPartial: LoadReducerPartialV1;
  merged: LoadReducerPartialV1;
  directArt: LoadArtifact;
  mergedArt: LoadArtifact;
}

const cases = new Map<number, Case>();
function caseFor(seed: number): Case {
  const cached = cases.get(seed);
  if (cached !== undefined) return cached;
  try {
    const rng = makeRng(seed);
    const k = K_CHOICES[Math.floor(rng() * K_CHOICES.length)];
    const stream = partitionedStream(rng, k);
    const direct = feed(stream.all, { ...CAPS, timelineOrigin: T0 });
    const workers = stream.parts.map((events, i) =>
      feed(events, { ...CAPS, timelineOrigin: T0, workerId: `w${i}` }),
    );
    // Export BEFORE finalize: finalize(runEndMs) may coarsen the live timeline.
    const directPartial = wire(direct.exportPartial(RUN_END));
    const merged = mergePartials(workers.map((w) => wire(w.exportPartial(RUN_END))));
    const mergedArt = finalizeMerged(merged, {
      runEndMs: RUN_END,
      provider: "multi-core",
      thresholds: THRESHOLDS,
    });
    const directArt = applyThresholds(direct.finalize(RUN_END), direct);
    const c: Case = { seed, k, stream, directPartial, merged, directArt, mergedArt };
    cases.set(seed, c);
    return c;
  } catch (e) {
    throw new Error(`seed ${seed}: case construction failed: ${(e as Error).message}`, { cause: e });
  }
}

function forEachSeed(assertCase: (c: Case, tag: string) => void): void {
  for (let seed = 1; seed <= SEED_COUNT; seed++) {
    const c = caseFor(seed);
    assertCase(c, `seed ${seed} (K=${c.k})`);
  }
}

// ── comparison helpers ────────────────────────────────────────────────────

/**
 * Histogram identity across the two fold orders. Everything except `sum` —
 * bucket indices/counts, zeroCount, count, min, max — is exact-integer sums and
 * min/max folds: commutative AND associative, hence order-independent, so the
 * two paths must agree BIT-FOR-BIT and are compared with strict equality.
 *
 * `sum` is the one float accumulation. Both sides add the same multiset of
 * non-negative doubles in different association orders (direct: record order
 * into one accumulator; merged: per-worker subtotals, then subtotal folds).
 * The standard forward-error bound for summing n non-negative doubles in ANY
 * order is |computed − true| ≤ (n−1)·ε·Σxᵢ (first order, Higham §4.2 — Σ|xᵢ| =
 * Σxᵢ = true sum because durations are clamped ≥ 0), so the two computed sums
 * differ by at most ~2(n−1)·ε relative. The 4·(count+1)·ε tolerance covers that
 * with headroom for the second-order terms.
 */
function expectHistEqual(actual: LoadHistogramJSON, expected: LoadHistogramJSON, label: string): void {
  const { sum: aSum, ...aRest } = actual;
  const { sum: eSum, ...eRest } = expected;
  expect(aRest, `${label}: bucket state must be exactly identical`).toEqual(eRest);
  if (aSum === eSum) return; // exact (covers empty, integer-valued and identical-order sums)
  if (typeof aSum !== "number" || typeof eSum !== "number") {
    // The "Infinity" saturation sentinel is unreachable for these finite streams.
    throw new Error(`${label}: unexpected sum sentinel (${String(aSum)} vs ${String(eSum)})`);
  }
  const scale = Math.max(Math.abs(aSum), Math.abs(eSum));
  const tolerance = 4 * (actual.count + 1) * Number.EPSILON * scale;
  expect(
    Math.abs(aSum - eSum),
    `${label}: sum drift ${aSum} vs ${eSum} exceeds the float-associativity bound`,
  ).toBeLessThanOrEqual(tolerance);
}

const scenarioKey = (s: { scenarioId: string; scenarioRefId?: string }): string =>
  `${s.scenarioId}|${s.scenarioRefId ?? ""}`;
const stepKey = (s: { scenarioId: string; scenarioRefId?: string; stepId: string; phase: string }): string =>
  `${scenarioKey(s)}|${s.stepId}|${s.phase}`;
const endpointKey = (e: { routeKey: string; phase?: string }): string => `${e.routeKey}|${e.phase ?? ""}`;
const matrixKey = (m: { scenarioId: string; scenarioRefId?: string; stepId?: string; routeKey: string; phase?: string }): string =>
  `${scenarioKey(m)}|${m.stepId ?? ""}|${m.routeKey}|${m.phase ?? ""}`;

function sortedByKey<T>(rows: T[], keyOf: (r: T) => string): T[] {
  return [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
}

/** Compare keyed aggregate rows COUNTER-wise (histograms stripped — those are
 *  category-2 assertions), whole arrays at once for a readable diff. */
function expectRowCountersEqual<T extends { latency: LoadHistogramJSON }>(
  merged: T[],
  direct: T[],
  keyOf: (r: T) => string,
  label: string,
): void {
  const strip = (r: T): Omit<T, "latency"> => {
    const { latency: _latency, ...rest } = r;
    return rest;
  };
  expect(sortedByKey(merged, keyOf).map(strip), label).toEqual(sortedByKey(direct, keyOf).map(strip));
}

function expectRowHistsEqual<T extends { latency: LoadHistogramJSON }>(
  merged: T[],
  direct: T[],
  keyOf: (r: T) => string,
  label: string,
): void {
  const m = sortedByKey(merged, keyOf);
  const d = sortedByKey(direct, keyOf);
  expect(m.map(keyOf), `${label}: key set`).toEqual(d.map(keyOf));
  m.forEach((row, i) => expectHistEqual(row.latency, d[i].latency, `${label} [${keyOf(row)}]`));
}

const seriesCounters = (s: LoadPartialCustomSeriesV1): Omit<LoadPartialCustomSeriesV1, "hist"> => {
  const { hist: _hist, ...rest } = s;
  return rest;
};
const sortedSeries = (m: LoadPartialCustomMetricV1): LoadPartialCustomSeriesV1[] =>
  [...m.series].sort((a, b) => (canonicalTagKey(a.tags) < canonicalTagKey(b.tags) ? -1 : 1));
const sortedMetrics = (p: LoadReducerPartialV1): LoadPartialCustomMetricV1[] =>
  [...p.customMetrics].sort((a, b) => (a.metricId < b.metricId ? -1 : 1));

function stripWorkerId<T extends LoadFailureTraceSample | LoadSlowTransactionSummary>(s: T): T {
  const { workerId: _workerId, ...identity } = s.identity;
  return { ...s, identity } as T;
}

const EMPTY_WINDOW_HIST = new LoadHistogram().toJSON();
const winField = (
  w: LoadTimelineWindowJSON | undefined,
  f: "requests" | "errors" | "starts" | "iterations" | "endedUnknown",
): number => w?.[f] ?? 0;

// ── tests ─────────────────────────────────────────────────────────────────

describe("partition identity (proposal §12 D0 acceptance, D0-9)", () => {
  it("generator self-check: partitions are lifecycle-clean, order keys unique, coverage is real", () => {
    const coverage = {
      inFlightAtEnd: false,
      openSlot: false,
      released: false,
      parkedRelease: false,
      backlogFullRelease: false,
      duplicateRelease: false,
      failedIterations: false,
      taggedMetricSeries: false,
      untaggedMetricTotal: false,
      feederNone: false,
      feederSingleKey: false,
      feederMultiKey: false,
      failureCapOverflow: false,
      slowCapOverflow: false,
      mixConfig: false,
      plainConfig: false,
      noLoadEnd: false,
      abortEnd: false,
      crashEnd: false,
      gatePassed: false,
      gateFailed: false,
      kSeen: new Set<number>(),
    };
    forEachSeed((c, tag) => {
      const { stream, k } = c;
      // Every iteration's lifecycle lives in EXACTLY one partition.
      const owner = new Map<string, number>();
      stream.parts.forEach((events, pIdx) => {
        for (const e of events) {
          const iterationId = (e as unknown as { iterationId?: string }).iterationId;
          if (iterationId === undefined) continue;
          const prev = owner.get(iterationId);
          expect(
            prev === undefined || prev === pIdx,
            `${tag}: iteration ${iterationId} crosses partitions (${prev} vs ${pIdx})`,
          ).toBe(true);
          owner.set(iterationId, pIdx);
        }
      });
      // Partition accounting: shards = the whole stream + (k−1) extra copies of
      // each broadcast run-level event, nothing dropped, nothing duplicated.
      const shardTotal = stream.parts.reduce((n, p) => n + p.length, 0);
      expect(shardTotal, `${tag}: partition accounting`).toBe(
        stream.all.length + (k - 1) * stream.broadcastCount,
      );
      // Order keys are globally unique (the sample total orders rely on it).
      const endTs: number[] = [];
      const endDurations: number[] = [];
      for (const e of stream.all) {
        const body = e as unknown as { type: string; ts: number; durationMs?: number };
        if (body.type === "iteration:end") {
          endTs.push(e.ts);
          endDurations.push(body.durationMs as number);
        }
      }
      expect(new Set(endTs).size, `${tag}: iteration end ts uniqueness`).toBe(endTs.length);
      expect(new Set(endDurations).size, `${tag}: iteration durationMs uniqueness`).toBe(endDurations.length);
      // Every event precedes the authoritative run end and the closure window
      // stays inside the rendered axis (see the RUN_END constant note).
      expect(Math.max(...stream.all.map((e) => e.ts)), `${tag}: events precede RUN_END`).toBeLessThan(RUN_END);
      // Coverage flags (asserted once, below).
      const dp = c.directPartial;
      if (dp.liveInFlight > 0) coverage.inFlightAtEnd = true;
      if (stream.meta.openSlots > 0) coverage.openSlot = true;
      if (dp.releasedProducerSlots > 0) coverage.released = true;
      if (dp.pendingReleases > 0) coverage.parkedRelease = true;
      if (dp.rejectedReleaseSignals > 0) coverage.backlogFullRelease = true; // mutually exclusive counters
      if (dp.duplicateReleaseSignals > 0) coverage.duplicateRelease = true;
      if (dp.iterFailed > 0) coverage.failedIterations = true;
      if (dp.customMetrics.some((x) => x.series.length > 0)) coverage.taggedMetricSeries = true;
      if (dp.customMetrics.some((x) => x.total.count > 0)) coverage.untaggedMetricTotal = true;
      for (const e of stream.all) {
        const body = e as unknown as { type: string; feederKeys?: Record<string, string> };
        if (body.type !== "iteration:start") continue;
        const keys = body.feederKeys === undefined ? 0 : Object.keys(body.feederKeys).length;
        if (keys === 0) coverage.feederNone = true;
        else if (keys === 1) coverage.feederSingleKey = true;
        else coverage.feederMultiKey = true;
      }
      if (dp.iterFailed > CAPS.maxFailureTraces && dp.samples.failureTraces.length === CAPS.maxFailureTraces) {
        coverage.failureCapOverflow = true;
      }
      if (
        dp.iterSucceeded > CAPS.maxSlowTransactionSummaries &&
        dp.samples.slowTransactions.length === CAPS.maxSlowTransactionSummaries
      ) {
        coverage.slowCapOverflow = true;
      }
      if (stream.meta.withMix) coverage.mixConfig = true;
      else coverage.plainConfig = true;
      if (stream.meta.endReason === undefined) coverage.noLoadEnd = true;
      if (stream.meta.endReason === "abort") coverage.abortEnd = true;
      if (stream.meta.endReason === "crash") coverage.crashEnd = true;
      for (const t of c.directArt.summary.thresholds) {
        if (t.status === "evaluated" && t.pass) coverage.gatePassed = true;
        if (t.status === "evaluated" && !t.pass) coverage.gateFailed = true;
      }
      coverage.kSeen.add(c.k);
    });
    // The property only means something if the seed set actually exercises every
    // variant the acceptance calls out — deterministic seeds, so this is stable.
    const { kSeen, ...flags } = coverage;
    for (const [flag, seen] of Object.entries(flags)) {
      expect(seen, `coverage: no seed exercised '${flag}'`).toBe(true);
    }
    expect([...kSeen].sort((a, b) => a - b), "coverage: partition counts").toEqual([...K_CHOICES]);
  });

  it("1. additive counts are exactly equal (transactions/steps/endpoints/matrix, custom metrics, continuation)", () => {
    forEachSeed(({ directPartial: d, merged: m }, tag) => {
      // Pure count sums — exact integers, no tolerance.
      const additive = [
        "liveInFlight",
        "iterStarted",
        "iterCompleted",
        "iterSucceeded",
        "iterFailed",
        "primaryBoundaries",
        "failedBeforePrimary",
        "endedWithoutBoundary",
        "releasedProducerSlots",
        "rejectedReleaseSignals",
        "duplicateReleaseSignals",
        "liveContinuations",
        "pendingReleases",
      ] as const;
      for (const f of additive) expect(m[f], `${tag}: ${f}`).toBe(d[f]);
      // Max/min folds and envelope agreement — exact because iteration/slot
      // lifecycles are partition-local and run-level events are broadcast.
      expect(m.maxContinuationBacklog, `${tag}: maxContinuationBacklog`).toBe(d.maxContinuationBacklog);
      expect(m.firstTs, `${tag}: firstTs`).toBe(d.firstTs);
      expect(m.lastTs, `${tag}: lastTs`).toBe(d.lastTs);
      expect(m.observedAt, `${tag}: observedAt`).toBe(d.observedAt);
      expect(m.runnerId, `${tag}: runnerId`).toBe(d.runnerId);
      expect(m.endReason, `${tag}: endReason`).toBe(d.endReason);
      expect(m.crash, `${tag}: crash summary`).toEqual(d.crash);

      // Keyed aggregate rows: identical key sets, identical counters and
      // metadata (stepName/groupId/method + routeKey provenance folds).
      expectRowCountersEqual(m.scenarios, d.scenarios, scenarioKey, `${tag}: scenarios`);
      expectRowCountersEqual(m.steps, d.steps, stepKey, `${tag}: steps`);
      expectRowCountersEqual(m.endpoints, d.endpoints, endpointKey, `${tag}: endpoints`);
      expectRowCountersEqual(m.matrix, d.matrix, matrixKey, `${tag}: matrix`);

      // Custom metrics: count/trueCount/sum are EXACT (integer-valued metric
      // observations by construction — integer float sums are associative below
      // 2^53), for the untagged total and every tag series; completeness flags
      // stay exact (no truncation in these streams — §7.3's lossy zone has its
      // own dedicated tests and deliberately does not satisfy identity).
      const mMetrics = sortedMetrics(m);
      const dMetrics = sortedMetrics(d);
      expect(
        mMetrics.map((x) => ({ ...x, total: seriesCounters(x.total), series: sortedSeries(x).map(seriesCounters) })),
        `${tag}: custom metrics`,
      ).toEqual(
        dMetrics.map((x) => ({ ...x, total: seriesCounters(x.total), series: sortedSeries(x).map(seriesCounters) })),
      );

      // Continuation/failure live-progress ring: unique atMs keys → both sides
      // hold the identical ascending sequence.
      expect(m.recentFailures, `${tag}: recentFailures`).toEqual(d.recentFailures);

      // Slot-busy occupancy integrals (the §6.2 conformance numerator): additive
      // per-window sums; slot events carry integer ts and the OPEN slots on both
      // paths truncate at the SAME shared observedAt, so the sums are exact.
      expect(m.slotBusy, `${tag}: slotBusy windows`).toEqual(d.slotBusy);
    });
  });

  it("2. histogram bucket state is identical per scope (float sum within the associativity bound)", () => {
    forEachSeed(({ directPartial: d, merged: m }, tag) => {
      expectHistEqual(m.iterLatency, d.iterLatency, `${tag}: iterLatency`);
      expectHistEqual(m.primaryLatency, d.primaryLatency, `${tag}: primaryLatency`);
      expectHistEqual(m.continuationBackpressure, d.continuationBackpressure, `${tag}: continuationBackpressure`);
      expectRowHistsEqual(m.scenarios, d.scenarios, scenarioKey, `${tag}: scenario latency`);
      expectRowHistsEqual(m.steps, d.steps, stepKey, `${tag}: step latency`);
      expectRowHistsEqual(m.endpoints, d.endpoints, endpointKey, `${tag}: endpoint latency`);
      expectRowHistsEqual(m.matrix, d.matrix, matrixKey, `${tag}: matrix latency`);
      // Trend custom metrics carry a histogram per series (and the total).
      const mMetrics = sortedMetrics(m);
      const dMetrics = sortedMetrics(d);
      expect(mMetrics.map((x) => x.metricId), `${tag}: metric id set`).toEqual(dMetrics.map((x) => x.metricId));
      mMetrics.forEach((mm, i) => {
        const dm = dMetrics[i];
        if (mm.kind !== "trend") return;
        expectHistEqual(mm.total.hist!, dm.total.hist!, `${tag}: metric ${mm.metricId} total hist`);
        const mSeries = sortedSeries(mm);
        const dSeries = sortedSeries(dm);
        expect(
          mSeries.map((s) => canonicalTagKey(s.tags)),
          `${tag}: metric ${mm.metricId} series key set`,
        ).toEqual(dSeries.map((s) => canonicalTagKey(s.tags)));
        mSeries.forEach((s, j) =>
          expectHistEqual(s.hist!, dSeries[j].hist!, `${tag}: metric ${mm.metricId} series ${canonicalTagKey(s.tags)}`),
        );
      });
      // Per-window timeline latency histograms (the closure-only window on the
      // merged side has an empty histogram; absent windows read as empty).
      const mWins = new Map(m.timeline.windows);
      const dWins = new Map(d.timeline.windows);
      for (const idx of new Set([...mWins.keys(), ...dWins.keys()])) {
        expectHistEqual(
          mWins.get(idx)?.latency ?? EMPTY_WINDOW_HIST,
          dWins.get(idx)?.latency ?? EMPTY_WINDOW_HIST,
          `${tag}: timeline window ${idx} latency`,
        );
      }
    });
  });

  it("3. timeline count windows agree; peakInFlightBounds bracket the direct run's exact peak", () => {
    forEachSeed(({ directPartial: d, merged: m, directArt, mergedArt, k }, tag) => {
      // No coarsening at these stream sizes — both sides sit on the same grid.
      expect(m.timeline.windowMs, `${tag}: merged windowMs`).toBe(WINDOW_MS);
      expect(d.timeline.windowMs, `${tag}: direct windowMs`).toBe(WINDOW_MS);

      // Wire level: requests/errors/starts exact per window. `iterations` folds
      // the merge's censoring closures in (documented semantics) — the OBSERVED
      // completions (iterations − endedUnknown) must be exact per window, the
      // closures must sum to exactly the direct run's in-flight count, and they
      // may only sit in the shared observation-cutoff window.
      const mWins = new Map(m.timeline.windows);
      const dWins = new Map(d.timeline.windows);
      const cutoffWindow = Math.floor((RUN_END - T0) / WINDOW_MS);
      let closures = 0;
      for (const idx of [...new Set([...mWins.keys(), ...dWins.keys()])].sort((a, b) => a - b)) {
        const mw = mWins.get(idx);
        const dw = dWins.get(idx);
        expect(winField(mw, "requests"), `${tag}: window ${idx} requests`).toBe(winField(dw, "requests"));
        expect(winField(mw, "errors"), `${tag}: window ${idx} errors`).toBe(winField(dw, "errors"));
        expect(winField(mw, "starts"), `${tag}: window ${idx} starts`).toBe(winField(dw, "starts"));
        expect(winField(dw, "endedUnknown"), `${tag}: window ${idx} direct endedUnknown`).toBe(0);
        expect(
          winField(mw, "iterations") - winField(mw, "endedUnknown"),
          `${tag}: window ${idx} observed completions`,
        ).toBe(winField(dw, "iterations"));
        if (winField(mw, "endedUnknown") > 0) {
          expect(idx, `${tag}: closure outside the cutoff window`).toBe(cutoffWindow);
          closures += winField(mw, "endedUnknown");
        }
      }
      expect(closures, `${tag}: censoring closures = direct in-flight`).toBe(d.liveInFlight);
      // Merge provenance on the wire: every part was censored at the SHARED
      // snapshot instant; the direct export is uncensored.
      expect(m.timeline.fullContributors, `${tag}: merged fullContributors`).toBe(0);
      expect(m.timeline.contributorCutoffsMs, `${tag}: merged contributor cutoffs`).toEqual(
        new Array(k).fill(RUN_END - T0),
      );
      expect(d.timeline.fullContributors, `${tag}: direct fullContributors`).toBe(1);
      expect(d.timeline.contributorCutoffsMs, `${tag}: direct contributor cutoffs`).toEqual([]);

      // Artifact level: identical dense axis to the authoritative boundary; the
      // direct (single-source) peak is EXACT (lower === upper === peakInFlight)
      // and the merged interval must bracket it; the merged compat scalar is its
      // own upper bound; every window is fully observed (all cutoffs sit at the
      // shared RUN_END instant, so no contributorsPartial anywhere).
      const dT = directArt.timeline!;
      const mT = mergedArt.timeline!;
      expect(mT.windowMs, `${tag}: artifact windowMs`).toBe(dT.windowMs);
      expect(mT.windows.length, `${tag}: artifact axis length`).toBe(dT.windows.length);
      expect(mT.windows.length, `${tag}: dense axis to RUN_END`).toBe(Math.ceil((RUN_END - T0) / WINDOW_MS));
      mT.windows.forEach((mw, i) => {
        const dw = dT.windows[i];
        expect(mw.offsetMs, `${tag}: artifact window ${i} offset`).toBe(dw.offsetMs);
        expect(mw.requests, `${tag}: artifact window ${i} requests`).toBe(dw.requests);
        expect(mw.errors, `${tag}: artifact window ${i} errors`).toBe(dw.errors);
        expect(
          mw.iterations - (mw.endedUnknown ?? 0),
          `${tag}: artifact window ${i} observed completions`,
        ).toBe(dw.iterations);
        const dBounds = dw.peakInFlightBounds!;
        expect(dBounds.lower, `${tag}: window ${i} direct peak is exact`).toBe(dBounds.upper);
        expect(dw.peakInFlight, `${tag}: window ${i} direct compat scalar`).toBe(dBounds.upper);
        const mBounds = mw.peakInFlightBounds!;
        expect(mBounds.lower, `${tag}: window ${i} merged lower ≤ truth`).toBeLessThanOrEqual(dw.peakInFlight);
        expect(mBounds.upper, `${tag}: window ${i} merged upper ≥ truth`).toBeGreaterThanOrEqual(dw.peakInFlight);
        expect(mw.peakInFlight, `${tag}: window ${i} merged compat scalar`).toBe(mBounds.upper);
        expect(mw.contributorsPartial, `${tag}: window ${i} merged coverage`).toBeUndefined();
        expect(dw.contributorsPartial, `${tag}: window ${i} direct coverage`).toBeUndefined();
      });
    });
  });

  it("4. samples satisfy the total-order selection invariant (slow top-k and first-N failures = direct)", () => {
    forEachSeed(({ directPartial: d, merged: m }, tag) => {
      expect(m.samples.maxFailureTraces, `${tag}: failure cap`).toBe(d.samples.maxFailureTraces);
      expect(m.samples.maxSlowTransactionSummaries, `${tag}: slow cap`).toBe(d.samples.maxSlowTransactionSummaries);
      // The merged samples carry worker provenance the direct run cannot have;
      // with the workerId stripped, the retained SETS AND ORDER are identical —
      // deterministic because the generator makes completedAtOffsetMs (failures,
      // asc) and durationMs (slow, desc) globally unique, so the workerId
      // tie-break never decides membership.
      for (const s of [...m.samples.failureTraces, ...m.samples.slowTransactions]) {
        expect(s.identity.workerId, `${tag}: merged sample worker provenance`).toMatch(/^w\d+$/);
      }
      expect(m.samples.failureTraces.map(stripWorkerId), `${tag}: failure traces`).toEqual(
        d.samples.failureTraces,
      );
      expect(m.samples.slowTransactions.map(stripWorkerId), `${tag}: slow transactions`).toEqual(
        d.samples.slowTransactions,
      );
      // Both sides emit in the shared total orders (the invariant the D1
      // coordinator merge relies on).
      for (const samples of [m.samples, d.samples]) {
        for (let i = 1; i < samples.failureTraces.length; i++) {
          expect(
            compareFailure(samples.failureTraces[i - 1], samples.failureTraces[i]),
            `${tag}: failure traces sorted by (completedAtOffsetMs, workerId, iterationId)`,
          ).toBeLessThan(0);
        }
        for (let i = 1; i < samples.slowTransactions.length; i++) {
          expect(
            compareSlow(samples.slowTransactions[i - 1], samples.slowTransactions[i]),
            `${tag}: slow transactions sorted by (durationMs desc, workerId, iterationId)`,
          ).toBeLessThan(0);
        }
      }
    });
  });

  it("5. provenance differs as specified; summary.pass / endReason / threshold verdicts agree", () => {
    forEachSeed(({ directPartial: d, merged: m, directArt, mergedArt, k }, tag) => {
      // The EXPECTED differences — asserted on both sides' own values, not
      // waved through: a merged frame must never claim in-process provenance,
      // and per-shard requested concurrency sums across the K broadcast copies.
      expect(directArt.runtime.processModel, `${tag}: direct processModel`).toBe(
        "single-process-async-producer-slot",
      );
      expect(directArt.runtime.execution, `${tag}: direct execution`).toEqual({
        provider: "in-process",
        workerCount: 1,
      });
      expect(mergedArt.runtime.processModel, `${tag}: merged processModel`).toBe("sharded-multi-process");
      expect(mergedArt.runtime.execution, `${tag}: merged execution`).toEqual({
        provider: "multi-core",
        workerCount: k,
      });
      expect(d.workerCount, `${tag}: raw frame carries no workerCount stamp`).toBeUndefined();
      expect(m.workerCount, `${tag}: merged frame workerCount`).toBe(k);
      expect(m.requestedConcurrency, `${tag}: requestedConcurrency sums per shard`).toBe(
        k * d.requestedConcurrency,
      );
      expect(mergedArt.runtime.requestedConcurrency, `${tag}: artifact requestedConcurrency`).toBe(
        k * directArt.runtime.requestedConcurrency,
      );
      expect(mergedArt.runtime.feederGuarantee, `${tag}: merged feederGuarantee`).toBe("single-node");
      expect(directArt.runtime.feederGuarantee, `${tag}: direct feederGuarantee`).toBe("single-node");

      // Everything a verdict consumer reads must be IDENTICAL.
      expect(mergedArt.config, `${tag}: config (replace-with-first)`).toEqual(directArt.config);
      expect(mergedArt.startedAt, `${tag}: startedAt`).toBe(directArt.startedAt);
      expect(mergedArt.durationMs, `${tag}: durationMs`).toBe(directArt.durationMs);
      expect(mergedArt.summary.pass, `${tag}: summary.pass`).toBe(directArt.summary.pass);
      expect(mergedArt.summary.endReason, `${tag}: summary.endReason`).toBe(directArt.summary.endReason);
      expect(mergedArt.summary.executionStatus, `${tag}: merged executionStatus`).toBe("complete");
      expect(directArt.summary.executionStatus, `${tag}: direct executionStatus`).toBe("complete");
      expect(mergedArt.runtime.crash, `${tag}: crash summary`).toEqual(directArt.runtime.crash);
      // Identical bucket state + identical authoritative denominator ⇒ the
      // whole threshold evaluation (actuals, quantile bounds, statuses,
      // verdicts) is bit-for-bit the same.
      expect(mergedArt.summary.thresholds, `${tag}: threshold rows`).toEqual(directArt.summary.thresholds);
      expect(mergedArt.summary.advisories, `${tag}: advisories`).toEqual(directArt.summary.advisories);
      // Headline summary numbers: same integer counts over the same runEndMs
      // denominator, and percentiles off identical buckets — exact equality.
      expect(mergedArt.summary.totalIterations, `${tag}: totalIterations`).toBe(directArt.summary.totalIterations);
      expect(mergedArt.summary.successfulIterations, `${tag}: successfulIterations`).toBe(
        directArt.summary.successfulIterations,
      );
      expect(mergedArt.summary.failedIterations, `${tag}: failedIterations`).toBe(directArt.summary.failedIterations);
      expect(mergedArt.summary.errorRate, `${tag}: errorRate`).toBe(directArt.summary.errorRate);
      expect(mergedArt.summary.throughputPerSec, `${tag}: throughputPerSec`).toBe(
        directArt.summary.throughputPerSec,
      );
      expect(mergedArt.summary.latency, `${tag}: summary latency percentiles`).toEqual(directArt.summary.latency);
    });
  });
});
