import { describe, expect, it } from "vitest";
import type { LoadArtifact, LoadEvent } from "@glubean/sdk/load";
import { createLoadReducer, LoadReducerImpl } from "./reducer.js";
import { LoadHistogram } from "./histogram.js";
import {
  finalizeMerged,
  mergePartials,
  parseLoadReducerPartial,
  type LoadReducerPartialV1,
} from "./partial.js";

let seq = 0;
function ev(ts: number, extra: Record<string, unknown>, runnerId = "plan-1"): LoadEvent {
  return { ts, seq: seq++, runId: "run1", runnerId, ...extra } as unknown as LoadEvent;
}

const T0 = 1_000_000;

// ── deterministic rich stream (mix + continuation + failures + custom metrics) ──

interface RichStream {
  /** Every event once, ts-ordered — the single-reducer ground truth. */
  all: LoadEvent[];
  /** Worker A's shard: run-level events + its iterations + producer slot 0. */
  workerA: LoadEvent[];
  /** Worker B's shard: run-level events + its iterations + producer slot 1. */
  workerB: LoadEvent[];
  runEndMs: number;
}

/** A two-scenario mix run exercising steps, requests (mixed routeKey provenance),
 *  failed assertions, custom metrics (rate/counter/trend, tagged + untagged),
 *  producer release (granted / duplicate-rejected / parked) and failures. With
 *  `finishAll: false`, iterations it-4 (a live continuation) and it-5 (a parked
 *  release) stay IN FLIGHT at the end — the interrupted-run state a snapshot must
 *  carry. With `finishAll: true` the stream is clean (partition-equality tests need
 *  no censoring effects). */
function richStream(finishAll: boolean): RichStream {
  type Target = "run" | "A" | "B";
  const specs: { ts: number; target: Target; body: Record<string, unknown> }[] = [];
  const push = (target: Target, ts: number, body: Record<string, unknown>): void => {
    specs.push({ ts: T0 + ts, target, body });
  };

  push("run", 0, {
    type: "load:start",
    config: {
      concurrency: 4,
      durationMs: 10_000,
      rngSeed: "seed-1",
      scenarios: [
        { scenarioRefId: "a", scenarioId: "checkout", weight: 2 },
        { scenarioRefId: "b", scenarioId: "browse", weight: 1 },
      ],
    },
  });
  push("A", 10, { type: "producerSlot:start", producerSlotIndex: 0 });
  push("B", 20, { type: "producerSlot:start", producerSlotIndex: 1 });

  const co = { scenarioId: "checkout", scenarioRefId: "a" };
  const br = { scenarioId: "browse", scenarioRefId: "b" };

  // it-0 (A): success with a released continuation tail.
  const i0 = { ...co, producerSlotId: "p0", iterationId: "it-0" };
  push("A", 100, { type: "iteration:start", ...i0, feederKeys: { user: "u1" } });
  push("A", 110, { type: "step:start", ...i0, stepId: "0:login", stepName: "login", groupId: "auth", phase: "primary" });
  push("A", 150, {
    type: "request:observed", ...i0, stepId: "0:login", method: "POST", url: "https://x/login",
    routeKey: "POST /login", routeKeySource: "contract-metadata", routeKeyHeuristic: false,
    status: 200, ok: true, durationMs: 40, phase: "primary",
  });
  push("A", 155, { type: "metric:observed", ...i0, metricId: "ttfb", kind: "trend", value: 40, unit: "ms", phase: "primary" });
  push("A", 160, { type: "step:end", ...i0, stepId: "0:login", stepName: "login", ok: true, durationMs: 50, phase: "primary" });
  push("A", 400, { type: "producer:primaryCompleted", ...i0, primaryId: "pc-0", primaryDurationMs: 300, releaseRequested: true, phase: "primary" });
  push("A", 410, { type: "producer:released", ...i0, releaseId: "rel-0", primaryDurationMs: 300, continuationBacklog: 1, backpressureMs: 5, phase: "continuation" });
  push("A", 580, { type: "step:start", ...i0, stepId: "1:poll", stepName: "poll", phase: "continuation" });
  push("A", 600, {
    type: "request:observed", ...i0, stepId: "1:poll", method: "GET", url: "https://x/poll",
    routeKey: "GET /poll", routeKeySource: "normalized-url", routeKeyHeuristic: true,
    status: 200, ok: true, durationMs: 120, phase: "continuation",
  });
  push("A", 720, { type: "step:end", ...i0, stepId: "1:poll", stepName: "poll", ok: true, durationMs: 140, phase: "continuation" });
  push("A", 800, { type: "iteration:end", ...i0, ok: true, durationMs: 700, phase: "continuation" });

  // it-1 (B): HTTP 500 + failed assertion — SAME routeKey as it-0's login but
  // heuristic provenance (exercises the provenance fold on both paths).
  const i1 = { ...co, producerSlotId: "p1", iterationId: "it-1" };
  push("B", 200, { type: "iteration:start", ...i1 });
  push("B", 210, { type: "step:start", ...i1, stepId: "0:login", stepName: "login", phase: "primary" });
  push("B", 260, {
    type: "request:observed", ...i1, stepId: "0:login", method: "POST", url: "https://x/login",
    routeKey: "POST /login", routeKeySource: "normalized-url", routeKeyHeuristic: true,
    status: 500, ok: false, durationMs: 80, errorKind: "http", phase: "primary",
  });
  push("B", 265, { type: "metric:observed", ...i1, metricId: "ok_rate", kind: "rate", value: 0, tags: { class: "5xx" }, phase: "primary" });
  push("B", 270, { type: "assertion:observed", ...i1, stepId: "0:login", passed: false, message: "expected 200", actual: 500, expected: 200, phase: "primary" });
  push("B", 280, { type: "step:end", ...i1, stepId: "0:login", stepName: "login", ok: false, durationMs: 75, assertionFailures: 1, errorKind: "stepError", phase: "primary" });
  push("B", 350, { type: "iteration:end", ...i1, ok: false, durationMs: 150, errorKind: "http", phase: "primary" });

  // it-2 (A): browse success + rate/counter metrics.
  const i2 = { ...br, producerSlotId: "p0", iterationId: "it-2" };
  push("A", 300, { type: "iteration:start", ...i2 });
  push("A", 310, { type: "step:start", ...i2, stepId: "0:list", stepName: "list", phase: "primary" });
  push("A", 360, {
    type: "request:observed", ...i2, stepId: "0:list", method: "GET", url: "https://x/items",
    routeKey: "GET /items", routeKeySource: "normalized-url", routeKeyHeuristic: true,
    status: 200, ok: true, durationMs: 60, phase: "primary",
  });
  push("A", 365, { type: "metric:observed", ...i2, metricId: "ok_rate", kind: "rate", value: 1, tags: { class: "2xx" }, phase: "primary" });
  push("A", 370, { type: "metric:observed", ...i2, metricId: "bytes", kind: "counter", value: 512, phase: "primary" });
  push("A", 380, { type: "step:end", ...i2, stepId: "0:list", stepName: "list", ok: true, durationMs: 70, phase: "primary" });
  push("A", 420, { type: "iteration:end", ...i2, ok: true, durationMs: 120, phase: "primary" });

  // it-3 (B): a skipped leaf (step:end only, carries groupId).
  const i3 = { ...br, producerSlotId: "p1", iterationId: "it-3" };
  push("B", 500, { type: "iteration:start", ...i3 });
  push("B", 520, { type: "step:end", ...i3, stepId: "0:list", stepName: "list", ok: true, durationMs: 0, skipped: true, groupId: "g1", phase: "primary" });
  push("B", 560, { type: "iteration:end", ...i3, ok: true, durationMs: 60, phase: "primary" });

  // it-4 (A): released + a duplicate rejection; unfinished unless finishAll.
  const i4 = { ...co, producerSlotId: "p0", iterationId: "it-4" };
  push("A", 900, { type: "iteration:start", ...i4 });
  push("A", 1000, { type: "producer:primaryCompleted", ...i4, primaryId: "pc-4", primaryDurationMs: 100, releaseRequested: true, phase: "primary" });
  push("A", 1005, { type: "producer:released", ...i4, releaseId: "rel-4", primaryDurationMs: 100, continuationBacklog: 2, backpressureMs: 0, phase: "continuation" });
  push("A", 1010, { type: "producer:releaseRejected", ...i4, releaseId: "rel-4b", reason: "duplicateRelease", waitMs: 0, continuationBacklog: 2, phase: "continuation" });
  if (finishAll) push("A", 1900, { type: "iteration:end", ...i4, ok: true, durationMs: 1000, phase: "continuation" });

  // it-5 (B): boundary reached, release requested but never granted (parked).
  const i5 = { ...co, producerSlotId: "p1", iterationId: "it-5" };
  push("B", 950, { type: "iteration:start", ...i5 });
  push("B", 1100, { type: "producer:primaryCompleted", ...i5, primaryId: "pc-5", primaryDurationMs: 150, releaseRequested: true, phase: "primary" });
  if (finishAll) push("B", 1950, { type: "iteration:end", ...i5, ok: false, durationMs: 1000, errorKind: "timeout", phase: "continuation" });

  // it-6 (A): quick failure, no steps.
  const i6 = { ...br, producerSlotId: "p0", iterationId: "it-6" };
  push("A", 1200, { type: "iteration:start", ...i6 });
  push("A", 1300, { type: "iteration:end", ...i6, ok: false, durationMs: 100, errorKind: "timeout", phase: "primary" });

  // it-7 (B): checkout success + a tagged trend sample.
  const i7 = { ...co, producerSlotId: "p1", iterationId: "it-7" };
  push("B", 1250, { type: "iteration:start", ...i7 });
  push("B", 1260, { type: "step:start", ...i7, stepId: "2:checkout", stepName: "checkout", phase: "primary" });
  push("B", 1300, {
    type: "request:observed", ...i7, stepId: "2:checkout", method: "POST", url: "https://x/checkout",
    routeKey: "POST /checkout", routeKeySource: "contract-metadata", routeKeyHeuristic: false,
    status: 201, ok: true, durationMs: 90, phase: "primary",
  });
  push("B", 1305, { type: "metric:observed", ...i7, metricId: "ttfb", kind: "trend", value: 90, unit: "ms", tags: { class: "2xx" }, phase: "primary" });
  push("B", 1320, { type: "step:end", ...i7, stepId: "2:checkout", stepName: "checkout", ok: true, durationMs: 80, phase: "primary" });
  push("B", 1500, { type: "iteration:end", ...i7, ok: true, durationMs: 250, phase: "primary" });

  push("A", 1600, { type: "producerSlot:end", producerSlotIndex: 0, primaryIterations: 4 });
  push("B", 1700, { type: "producerSlot:end", producerSlotIndex: 1, primaryIterations: 4 });
  push("run", 2000, { type: "load:end", reason: "duration" });

  specs.sort((x, y) => x.ts - y.ts); // stable → equal-ts events keep push order
  const all: LoadEvent[] = [];
  const workerA: LoadEvent[] = [];
  const workerB: LoadEvent[] = [];
  for (const s of specs) {
    const e = ev(s.ts, s.body);
    all.push(e);
    if (s.target === "run" || s.target === "A") workerA.push(structuredClone(e));
    if (s.target === "run" || s.target === "B") workerB.push(structuredClone(e));
  }
  return { all, workerA, workerB, runEndMs: T0 + 2000 };
}

function feed(events: LoadEvent[], config: Parameters<typeof createLoadReducer>[0] = {}): LoadReducerImpl {
  const r = createLoadReducer(config);
  for (const e of events) r.apply(e);
  return r;
}

/** Export → JSON wire round-trip → validate → hydrate. */
function roundTrip(r: LoadReducerImpl): LoadReducerImpl {
  const wire = JSON.parse(JSON.stringify(r.exportPartial())) as unknown;
  return LoadReducerImpl.fromPartial(parseLoadReducerPartial(wire));
}

function wirePartial(r: LoadReducerImpl): LoadReducerPartialV1 {
  return parseLoadReducerPartial(JSON.parse(JSON.stringify(r.exportPartial())) as unknown);
}

// ── seeded random streams (property round-trip) ──────────────────────────

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomEvents(rng: () => number): LoadEvent[] {
  const specs: { ts: number; body: Record<string, unknown> }[] = [];
  const push = (ts: number, body: Record<string, unknown>): void => {
    specs.push({ ts: T0 + ts, body });
  };
  push(0, { type: "load:start", config: { concurrency: 1 + Math.floor(rng() * 8), durationMs: 30_000 } });
  const slotCount = Math.floor(rng() * 3);
  for (let sIdx = 0; sIdx < slotCount; sIdx++) {
    const start = Math.floor(rng() * 1000);
    push(start, { type: "producerSlot:start", producerSlotIndex: sIdx });
    if (rng() < 0.8) {
      push(start + 200 + Math.floor(rng() * 20_000), {
        type: "producerSlot:end", producerSlotIndex: sIdx, primaryIterations: Math.floor(rng() * 20),
      });
    } // else: slot left open at export (its occupancy truncates at observedAt)
  }
  const metricKinds: Record<string, "rate" | "trend" | "counter"> = {
    m_rate: "rate", m_trend: "trend", m_count: "counter",
  };
  const metricIds = Object.keys(metricKinds);
  const routes = [
    { routeKey: "GET /a", method: "GET", source: "normalized-url", heuristic: true },
    { routeKey: "POST /b", method: "POST", source: "contract-metadata", heuristic: false },
    { routeKey: "GET /c/:id", method: "GET", source: "explicit", heuristic: false },
  ];
  const iters = Math.floor(rng() * 25);
  for (let i = 0; i < iters; i++) {
    const scenarioId = rng() < 0.5 ? "checkout" : "browse";
    const scenarioRefId = rng() < 0.5 ? (scenarioId === "checkout" ? "a" : "b") : undefined;
    const base = {
      scenarioId,
      ...(scenarioRefId !== undefined ? { scenarioRefId } : {}),
      producerSlotId: `p${i % 3}`,
      iterationId: `it-${i}`,
    };
    let t = Math.floor(rng() * 15_000);
    push(t, { type: "iteration:start", ...base, ...(rng() < 0.3 ? { feederKeys: { user: `u${i}` } } : {}) });
    let phase: "primary" | "continuation" = "primary";
    const stepCount = Math.floor(rng() * 3);
    for (let sI = 0; sI < stepCount; sI++) {
      const stepId = `${sI}:step${sI}`;
      const stepName = `step${sI}`;
      t += 1 + Math.floor(rng() * 300);
      const skipped = rng() < 0.1;
      if (!skipped) {
        push(t, { type: "step:start", ...base, stepId, stepName, phase, ...(rng() < 0.3 ? { groupId: "g" } : {}) });
      }
      const reqCount = skipped ? 0 : Math.floor(rng() * 3);
      for (let rI = 0; rI < reqCount; rI++) {
        t += 1 + Math.floor(rng() * 200);
        const route = routes[Math.floor(rng() * routes.length)];
        const ok = rng() < 0.85;
        push(t, {
          type: "request:observed", ...base, stepId, method: route.method,
          url: `https://x${route.routeKey}`, routeKey: route.routeKey,
          routeKeySource: route.source, routeKeyHeuristic: route.heuristic,
          ...(ok ? { status: 200 } : rng() < 0.5 ? { status: 500 } : {}),
          ok, durationMs: Math.floor(rng() * 400), ...(ok ? {} : { errorKind: "http" }), phase,
        });
      }
      if (!skipped && rng() < 0.2) {
        t += 1;
        push(t, { type: "assertion:observed", ...base, stepId, passed: false, message: "boom", actual: { got: i }, expected: 42, phase });
      }
      if (rng() < 0.3) {
        t += 1;
        const mid = metricIds[Math.floor(rng() * metricIds.length)];
        push(t, {
          type: "metric:observed", ...base, metricId: mid, kind: metricKinds[mid],
          value: Math.floor(rng() * 100),
          ...(metricKinds[mid] === "trend" ? { unit: "ms" } : {}),
          ...(rng() < 0.5 ? { tags: { class: rng() < 0.5 ? "2xx" : "5xx" } } : {}),
          phase,
        });
      }
      t += 1 + Math.floor(rng() * 100);
      push(t, {
        type: "step:end", ...base, stepId, stepName, ok: rng() < 0.9,
        durationMs: Math.floor(rng() * 500), ...(skipped ? { skipped: true } : {}),
        assertionFailures: rng() < 0.2 ? 1 : 0, phase,
      });
    }
    if (rng() < 0.4) {
      t += 1 + Math.floor(rng() * 200);
      const releaseRequested = rng() < 0.6;
      push(t, { type: "producer:primaryCompleted", ...base, primaryId: `pc-${i}`, primaryDurationMs: Math.floor(rng() * 1000), releaseRequested, phase });
      phase = "continuation";
      if (releaseRequested) {
        const roll = rng();
        if (roll < 0.6) {
          t += 1;
          push(t, { type: "producer:released", ...base, releaseId: `rel-${i}`, primaryDurationMs: Math.floor(rng() * 1000), continuationBacklog: Math.floor(rng() * 5), backpressureMs: Math.floor(rng() * 50), phase });
          if (rng() < 0.2) {
            t += 1;
            push(t, { type: "producer:releaseRejected", ...base, releaseId: `rel-${i}b`, reason: "duplicateRelease", waitMs: 0, continuationBacklog: 1, phase });
          }
        } else if (roll < 0.8) {
          t += 1;
          push(t, { type: "producer:releaseRejected", ...base, releaseId: `rel-${i}`, reason: "continuationBacklogFull", waitMs: Math.floor(rng() * 100), continuationBacklog: 5, phase });
        } // else: parked release (pendingRelease > 0 at export)
      }
    }
    if (rng() < 0.85) {
      t += 1 + Math.floor(rng() * 500);
      const ok = rng() < 0.8;
      push(t, {
        type: "iteration:end", ...base, ok, durationMs: Math.floor(rng() * 2000),
        ...(ok ? {} : { errorKind: rng() < 0.5 ? "timeout" : "http" }), phase,
      });
    } // else: left in flight at export
  }
  if (rng() < 0.85) push(20_000, { type: "load:end", reason: "duration" });
  specs.sort((x, y) => x.ts - y.ts);
  return specs.map((s) => ev(s.ts, s.body));
}

// ── partition-comparison normalization ────────────────────────────────────

/** Project an artifact onto its ADDITIVE/mergeable view for divide-and-merge
 *  comparison: rows sorted by identity, sample identities stripped of workerId,
 *  timeline windows reduced to their additive fields (peak in-flight becomes BOUNDS
 *  under a merge — exactness is single-source-only, §7.3), and the fields whose
 *  merge rule is not additive equality dropped (requestedConcurrency sums across
 *  worker shards; config follows the replace rule; processModel/execution are
 *  deliberately DIFFERENT provenance on the merged path — asserted separately). */
function additiveView(art: LoadArtifact) {
  const tagKey = (o: unknown): string => JSON.stringify(o);
  const { requestedConcurrency: _rc, processModel: _pm, execution: _ex, ...runtime } = art.runtime;
  return {
    startedAt: art.startedAt,
    durationMs: art.durationMs,
    runnerId: art.runnerId,
    runtime,
    summary: {
      ...art.summary,
      ...(art.summary.customMetrics !== undefined
        ? {
            customMetrics: [...art.summary.customMetrics]
              .sort((a, b) => a.metricId.localeCompare(b.metricId))
              .map((m) => ({
                ...m,
                series: [...m.series].sort((a, b) => tagKey(a.tags).localeCompare(tagKey(b.tags))),
              })),
          }
        : {}),
    },
    scenarios: [...art.scenarios]
      .sort((a, b) => `${a.scenarioId}|${a.scenarioRefId ?? ""}`.localeCompare(`${b.scenarioId}|${b.scenarioRefId ?? ""}`))
      .map((sc) => ({
        ...sc,
        steps: [...sc.steps].sort((a, b) => `${a.stepId}|${a.phase ?? ""}`.localeCompare(`${b.stepId}|${b.phase ?? ""}`)),
      })),
    steps: [...art.steps].sort((a, b) =>
      `${a.scenarioId}|${a.scenarioRefId ?? ""}|${a.stepId}|${a.phase ?? ""}`.localeCompare(
        `${b.scenarioId}|${b.scenarioRefId ?? ""}|${b.stepId}|${b.phase ?? ""}`,
      ),
    ),
    endpoints: [...art.endpoints].sort((a, b) =>
      `${a.routeKey}|${a.phase ?? ""}`.localeCompare(`${b.routeKey}|${b.phase ?? ""}`),
    ),
    matrix: [...art.matrix].sort((a, b) =>
      `${a.scenarioId}|${a.scenarioRefId ?? ""}|${a.stepId ?? ""}|${a.routeKey}|${a.phase ?? ""}`.localeCompare(
        `${b.scenarioId}|${b.scenarioRefId ?? ""}|${b.stepId ?? ""}|${b.routeKey}|${b.phase ?? ""}`,
      ),
    ),
    timeline: {
      windowMs: art.timeline?.windowMs,
      windows: art.timeline?.windows.map((w) => ({
        offsetMs: w.offsetMs,
        requests: w.requests,
        errors: w.errors,
        errorRate: w.errorRate,
        throughputPerSec: w.throughputPerSec,
        latency: w.latency,
        iterations: w.iterations,
      })),
    },
    samples: {
      failureTraces: art.samples.failureTraces.map((f) => ({ ...f, identity: { ...f.identity, workerId: undefined } })),
      slowTransactions: art.samples.slowTransactions.map((s) => ({ ...s, identity: { ...s.identity, workerId: undefined } })),
    },
  };
}

// ── tests ─────────────────────────────────────────────────────────────────

describe("round-trip identity (export → wire → hydrate → finalize)", () => {
  it("matches a direct finalize on the rich interrupted stream (no runEndMs)", () => {
    const { all } = richStream(false);
    const direct = feed(all, { timelineOrigin: T0, workerId: "w9" });
    const hydrated = roundTrip(direct);
    expect(hydrated.snapshot()).toEqual(direct.snapshot());
    expect(hydrated.finalize()).toEqual(direct.finalize());
  });

  it("matches a direct finalize with an authoritative runEndMs", () => {
    const { all, runEndMs } = richStream(false);
    const direct = feed(all, { timelineOrigin: T0 });
    const hydrated = roundTrip(direct);
    expect(hydrated.finalize(runEndMs)).toEqual(direct.finalize(runEndMs));
  });

  it("carries interrupted-run live counts (continuationInFlight / blockedOnBacklog)", () => {
    const { all, runEndMs } = richStream(false);
    const direct = feed(all, { timelineOrigin: T0 });
    const partial = direct.exportPartial();
    expect(partial.liveContinuations).toBe(1); // it-4 released, never ended
    expect(partial.pendingReleases).toBe(1); // it-5 parked on the backlog
    expect(partial.liveInFlight).toBe(2);
    const art = LoadReducerImpl.fromPartial(wirePartial(direct)).finalize(runEndMs);
    expect(art.runtime.continuationInFlight).toBe(1);
    expect(art.runtime.blockedOnBacklog).toBe(1);
  });

  it("round-trips an empty reducer (zero events)", () => {
    const direct = createLoadReducer();
    const hydrated = roundTrip(direct);
    expect(hydrated.finalize()).toEqual(createLoadReducer().finalize());
  });

  it("export does not mutate live state (repeat exports are identical)", () => {
    const { all } = richStream(false);
    const control = feed(all, { timelineOrigin: T0 });
    const probed = feed(all, { timelineOrigin: T0 });
    const first = probed.exportPartial();
    expect(probed.exportPartial()).toEqual(first);
    expect(probed.finalize()).toEqual(control.finalize());
  });

  it("property: arbitrary seeded event streams round-trip exactly", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const events = randomEvents(makeRng(seed));
      const config = {
        ...(seed % 2 === 0 ? { timelineOrigin: T0 } : {}),
        ...(seed % 3 === 0 ? { workerId: "w0" } : {}),
      };
      {
        const direct = feed(events, config);
        const hydrated = roundTrip(direct);
        expect(hydrated.snapshot(), `seed ${seed} snapshot`).toEqual(direct.snapshot());
        expect(hydrated.finalize(), `seed ${seed} finalize()`).toEqual(direct.finalize());
      }
      {
        // Fresh instances per finalize variant: finalize(runEndMs) may coarsen the
        // timeline, so each comparison gets its own untouched pair.
        const direct = feed(events, config);
        const hydrated = roundTrip(direct);
        expect(hydrated.finalize(T0 + 30_000), `seed ${seed} finalize(runEnd)`).toEqual(
          direct.finalize(T0 + 30_000),
        );
      }
    }
  });
});

describe("slot-busy accumulation (§6.2 conformance numerator)", () => {
  it("integrates closed slot spans into timeline-width windows (hand-computed)", () => {
    const r = createLoadReducer({ timelineOrigin: T0 });
    r.apply(ev(T0, { type: "producerSlot:start", producerSlotIndex: 0 }));
    r.apply(ev(T0 + 250, { type: "producerSlot:start", producerSlotIndex: 1 }));
    r.apply(ev(T0 + 600, { type: "producerSlot:end", producerSlotIndex: 1, primaryIterations: 3 }));
    r.apply(ev(T0 + 1000, { type: "producerSlot:end", producerSlotIndex: 0, primaryIterations: 5 }));
    // slot0 [0,1000) + slot1 [250,600) over 250ms windows:
    //   w0: 250 · w1: 250+250 · w2: 250+100 · w3: 250
    expect(r.exportPartial().slotBusy.windows).toEqual([[0, 250], [1, 500], [2, 350], [3, 250]]);
  });

  it("truncates an OPEN slot's occupancy at observedAt without mutating live state", () => {
    const r = createLoadReducer({ timelineOrigin: T0 });
    r.apply(ev(T0 + 100, { type: "producerSlot:start", producerSlotIndex: 0 }));
    // Advance lastTs (observedAt) to T0+1000 without closing the slot.
    r.apply(ev(T0 + 1000, { type: "iteration:start", scenarioId: "s", producerSlotId: "p0", iterationId: "it-0" }));
    const first = r.exportPartial();
    // open span [100, 1000): w0 150 · w1 250 · w2 250 · w3 250
    expect(first.slotBusy.windows).toEqual([[0, 150], [1, 250], [2, 250], [3, 250]]);
    expect(r.exportPartial()).toEqual(first); // repeatable — the live accumulator was not advanced
    // Closing the slot later still integrates the full span exactly once.
    r.apply(ev(T0 + 1100, { type: "producerSlot:end", producerSlotIndex: 0, primaryIterations: 1 }));
    expect(r.exportPartial().slotBusy.windows).toEqual([[0, 150], [1, 250], [2, 250], [3, 250], [4, 100]]);
  });

  it("integrates open-slot occupancy up to an explicit observedAtMs past the last event", () => {
    const r = createLoadReducer({ timelineOrigin: T0 });
    r.apply(ev(T0 + 100, { type: "producerSlot:start", producerSlotIndex: 0 }));
    r.apply(ev(T0 + 1000, { type: "iteration:start", scenarioId: "s", producerSlotId: "p0", iterationId: "it-0" }));
    // Snapshot taken 4s into an event-free gap (think time / backlog wait): the open
    // slot stayed busy the whole gap and the snapshot really observed it.
    const p = r.exportPartial(T0 + 5000);
    expect(p.observedAt).toBe(T0 + 5000);
    expect(p.slotBusy.windows).toHaveLength(20); // [100, 5000) covers windows 0..19
    expect(p.slotBusy.windows.reduce((n, [, busy]) => n + busy, 0)).toBe(4900);
    // The no-argument lastTs fallback still truncates at the last event — the
    // documented "terminal export only" limitation.
    const fallback = r.exportPartial();
    expect(fallback.observedAt).toBe(T0 + 1000);
    expect(fallback.slotBusy.windows.reduce((n, [, busy]) => n + busy, 0)).toBe(900);
  });

  it("floors an observedAtMs earlier than the last applied event at lastTs", () => {
    const r = createLoadReducer({ timelineOrigin: T0 });
    r.apply(ev(T0 + 100, { type: "producerSlot:start", producerSlotIndex: 0 }));
    r.apply(ev(T0 + 1000, { type: "iteration:start", scenarioId: "s", producerSlotId: "p0", iterationId: "it-0" }));
    expect(r.exportPartial(T0 + 500)).toEqual(r.exportPartial());
  });

  it("hydration preserves the frame's observedAt as the re-export default (frame-consistent)", () => {
    const r = createLoadReducer({ timelineOrigin: T0 });
    r.apply(ev(T0 + 100, { type: "producerSlot:start", producerSlotIndex: 0 }));
    r.apply(ev(T0 + 1000, { type: "iteration:start", scenarioId: "s", producerSlotId: "p0", iterationId: "it-0" }));
    // Snapshot in an event-free open-slot gap: busy windows integrate to T0+2000.
    const source = parseLoadReducerPartial(JSON.parse(JSON.stringify(r.exportPartial(T0 + 2000))) as unknown);
    const reExported = LoadReducerImpl.fromPartial(source).exportPartial();
    // Without preservation this regressed to lastTs (T0+1000) while the busy windows
    // still covered [.., 2000) — an internally inconsistent frame whose downstream
    // censoring would drop known coverage.
    expect(reExported.observedAt).toBe(T0 + 2000);
    expect(reExported.slotBusy).toEqual(source.slotBusy);
    expect(reExported).toEqual(source); // full re-export idempotence
    // An explicit re-export instant is still floored at the frame's claimed coverage.
    expect(LoadReducerImpl.fromPartial(source).exportPartial(T0 + 1500).observedAt).toBe(T0 + 2000);
  });

  it("pre-ramp time never counts: occupancy starts at producerSlot:start", () => {
    const r = createLoadReducer({ timelineOrigin: T0 });
    // Ramped slot: the orchestrator emits start only after the ramp delay (offset 500).
    r.apply(ev(T0 + 500, { type: "producerSlot:start", producerSlotIndex: 0 }));
    r.apply(ev(T0 + 750, { type: "producerSlot:end", producerSlotIndex: 0, primaryIterations: 1 }));
    expect(r.exportPartial().slotBusy.windows).toEqual([[2, 250]]);
  });

  it("merges as plain per-window sums across workers", () => {
    const a = createLoadReducer({ timelineOrigin: T0, workerId: "w0" });
    a.apply(ev(T0, { type: "producerSlot:start", producerSlotIndex: 0 }));
    a.apply(ev(T0 + 500, { type: "producerSlot:end", producerSlotIndex: 0, primaryIterations: 1 }));
    const b = createLoadReducer({ timelineOrigin: T0, workerId: "w1" });
    b.apply(ev(T0 + 250, { type: "producerSlot:start", producerSlotIndex: 0 }));
    b.apply(ev(T0 + 750, { type: "producerSlot:end", producerSlotIndex: 0, primaryIterations: 1 }));
    const merged = mergePartials([wirePartial(a), wirePartial(b)]);
    expect(merged.slotBusy.windows).toEqual([[0, 250], [1, 500], [2, 250]]);
  });
});

describe("mergePartials (§7.2/§7.3 field rules)", () => {
  it("two-worker partition merge+finalize matches the single reducer's additive view", () => {
    const { all, workerA, workerB, runEndMs } = richStream(true);
    const direct = feed(all, { timelineOrigin: T0 });
    const a = feed(workerA, { timelineOrigin: T0, workerId: "w0" });
    const b = feed(workerB, { timelineOrigin: T0, workerId: "w1" });
    const merged = mergePartials([wirePartial(a), wirePartial(b)]);
    const mergedArt = finalizeMerged(merged, { runEndMs, provider: "multi-core" });
    const directArt = direct.finalize(runEndMs);
    expect(additiveView(mergedArt)).toEqual(additiveView(directArt));
    // The deliberately non-additive fields follow their own rules:
    expect(mergedArt.runtime.requestedConcurrency).toBe(8); // 4 + 4 (per-shard sums)
    expect(mergedArt.config.concurrency).toBe(4); // replace-with-first
    expect(mergedArt.runtime.processModel).toBe("sharded-multi-process"); // provenance
    expect(directArt.runtime.processModel).toBe("single-process-async-producer-slot");
  });

  it("folds routeKey provenance like the reducer (heuristic side wins the flag+source)", () => {
    const a = createLoadReducer({ timelineOrigin: T0, workerId: "w0" });
    a.apply(ev(T0, {
      type: "request:observed", scenarioId: "s", method: "GET", url: "https://x/y", routeKey: "GET /y",
      routeKeySource: "contract-metadata", routeKeyHeuristic: false, status: 200, ok: true, durationMs: 10,
    }));
    const b = createLoadReducer({ timelineOrigin: T0, workerId: "w1" });
    b.apply(ev(T0 + 5, {
      type: "request:observed", scenarioId: "s", method: "GET", url: "https://x/y", routeKey: "GET /y",
      routeKeySource: "normalized-url", routeKeyHeuristic: true, status: 200, ok: true, durationMs: 20,
    }));
    const merged = mergePartials([wirePartial(a), wirePartial(b)]);
    const endpoint = merged.endpoints.find((e) => e.routeKey === "GET /y");
    expect(endpoint?.routeKeyHeuristic).toBe(true);
    expect(endpoint?.routeKeySource).toBe("normalized-url");
    expect(endpoint?.requestCount).toBe(2);
    const art = finalizeMerged(merged, { runEndMs: T0 + 100, provider: "multi-core" });
    expect(art.runtime.attribution.endpoint).toBe("heuristic");
  });

  it("rejects a genuine routeKeySource conflict (same heuristic flag, different sources)", () => {
    const mk = (source: string, workerId: string) => {
      const r = createLoadReducer({ timelineOrigin: T0, workerId });
      r.apply(ev(T0, {
        type: "request:observed", scenarioId: "s", method: "GET", url: "https://x/y", routeKey: "GET /y",
        routeKeySource: source, routeKeyHeuristic: false, status: 200, ok: true, durationMs: 10,
      }));
      return wirePartial(r);
    };
    expect(() => mergePartials([mk("explicit", "w0"), mk("contract-metadata", "w1")])).toThrow(
      /routeKeySource conflict/,
    );
  });

  it("applies the §7.3 conservative per-series completeness rule under truncation", () => {
    const a = createLoadReducer({ timelineOrigin: T0, workerId: "w0" });
    // 55 distinct tag values → the 50-series cap trips; v0..v49 retained, truncated.
    for (let i = 0; i < 55; i++) {
      a.apply(ev(T0 + i, { type: "metric:observed", scenarioId: "s", metricId: "m", kind: "counter", value: 1, tags: { k: `v${i}` } }));
    }
    const b = createLoadReducer({ timelineOrigin: T0, workerId: "w1" });
    b.apply(ev(T0, { type: "metric:observed", scenarioId: "s", metricId: "m", kind: "counter", value: 2, tags: { k: "v0" } }));
    b.apply(ev(T0 + 1, { type: "metric:observed", scenarioId: "s", metricId: "m", kind: "counter", value: 3, tags: { k: "v60" } }));
    b.apply(ev(T0 + 2, { type: "metric:observed", scenarioId: "s", metricId: "only_b", kind: "rate", value: 1 }));
    const merged = mergePartials([wirePartial(a), wirePartial(b)]);
    const m = merged.customMetrics.find((x) => x.metricId === "m");
    expect(m?.seriesTruncated).toBe(true);
    expect(m?.total.count).toBe(57); // A's 55 + B's 2 observations — the untagged total stays exact
    expect(m?.total.complete).toBe(true);
    const byTag = new Map(m!.series.map((s) => [s.tags.k, s]));
    expect(byTag.get("v0")?.complete).toBe(true); // truncated worker A explicitly reported it
    expect(byTag.get("v0")?.sum).toBe(3); // 1 (A) + 2 (B)
    expect(byTag.get("v60")?.complete).toBe(false); // A truncated AND silent on this key
    expect(byTag.get("v1")?.complete).toBe(true);
    // A metric only one (untruncated) worker observed stays complete.
    expect(merged.customMetrics.find((x) => x.metricId === "only_b")?.total.complete).toBe(true);
  });

  it("rejects custom-metric kind and unit conflicts (assert-equal-else-reject)", () => {
    const mk = (body: Record<string, unknown>, workerId: string) => {
      const r = createLoadReducer({ timelineOrigin: T0, workerId });
      r.apply(ev(T0, { type: "metric:observed", scenarioId: "s", metricId: "m", ...body }));
      return wirePartial(r);
    };
    expect(() =>
      mergePartials([mk({ kind: "rate", value: 1 }, "w0"), mk({ kind: "trend", value: 5, unit: "ms" }, "w1")]),
    ).toThrow(/kind conflict/);
    expect(() =>
      mergePartials([mk({ kind: "trend", value: 5, unit: "ms" }, "w0"), mk({ kind: "trend", value: 5, unit: "s" }, "w1")]),
    ).toThrow(/unit conflict/);
  });

  it("takes endReason by §7.4 priority and carries the crash summary", () => {
    const a = createLoadReducer({ timelineOrigin: T0, workerId: "w0" });
    a.apply(ev(T0 + 100, { type: "load:end", reason: "duration" }));
    const b = createLoadReducer({ timelineOrigin: T0, workerId: "w1" });
    b.apply(ev(T0 + 50, {
      type: "load:end", reason: "crash",
      crash: { kind: "runnerCrash", message: "boom", atMs: 50 },
    }));
    const merged = mergePartials([wirePartial(a), wirePartial(b)]);
    expect(merged.endReason).toBe("crash");
    expect(merged.crash?.message).toBe("boom");
    const art = finalizeMerged(merged, { runEndMs: T0 + 100, provider: "multi-core" });
    expect(art.summary.pass).toBe(false);
    expect(art.runtime.crash?.message).toBe("boom");
  });

  it("re-sorts merged samples under the shared total orders and re-caps them", () => {
    const mk = (workerId: string, iters: Array<{ id: string; at: number; ok: boolean; durationMs: number }>) => {
      const r = createLoadReducer({
        timelineOrigin: T0, workerId, maxFailureTraces: 2, maxSlowTransactionSummaries: 2,
      });
      for (const x of iters) {
        r.apply(ev(T0 + x.at - 10, { type: "iteration:start", scenarioId: "s", producerSlotId: "p0", iterationId: x.id }));
        r.apply(ev(T0 + x.at, {
          type: "iteration:end", scenarioId: "s", producerSlotId: "p0", iterationId: x.id,
          ok: x.ok, durationMs: x.durationMs, ...(x.ok ? {} : { errorKind: "http" }),
        }));
      }
      return wirePartial(r);
    };
    const a = mk("w0", [
      { id: "it-0", at: 100, ok: false, durationMs: 90 },
      { id: "it-1", at: 300, ok: false, durationMs: 290 },
      { id: "it-2", at: 500, ok: true, durationMs: 100 },
      { id: "it-3", at: 700, ok: true, durationMs: 50 },
    ]);
    const b = mk("w1", [
      { id: "it-0", at: 200, ok: false, durationMs: 190 },
      { id: "it-1", at: 400, ok: true, durationMs: 80 },
    ]);
    const merged = mergePartials([a, b]);
    // Failure traces: first N by completedAtOffsetMs asc → offsets 100 (w0), 200 (w1).
    expect(merged.samples.failureTraces.map((f) => f.completedAtOffsetMs)).toEqual([100, 200]);
    expect(merged.samples.failureTraces.map((f) => f.identity.workerId)).toEqual(["w0", "w1"]);
    // Slow top-k: durationMs desc → 100 (w0 it-2), 80 (w1 it-1).
    expect(merged.samples.slowTransactions.map((s) => s.durationMs)).toEqual([100, 80]);
  });

  it("rejects sample-cap mismatches across parts", () => {
    const a = createLoadReducer({ timelineOrigin: T0, workerId: "w0", maxFailureTraces: 5 });
    const b = createLoadReducer({ timelineOrigin: T0, workerId: "w1" });
    expect(() => mergePartials([wirePartial(a), wirePartial(b)])).toThrow(/sample cap mismatch/);
  });

  it("requires a shared explicit timelineOrigin for multi-part merges", () => {
    const a = createLoadReducer({ workerId: "w0" });
    const b = createLoadReducer({ timelineOrigin: T0, workerId: "w1" });
    expect(() => mergePartials([wirePartial(a), wirePartial(b)])).toThrow(/no timelineOrigin/);
    const c = createLoadReducer({ timelineOrigin: T0 + 1, workerId: "w2" });
    expect(() => mergePartials([wirePartial(b), wirePartial(c)])).toThrow(/timelineOrigin mismatch/);
  });

  it("rejects a runnerId conflict (two different plans cannot merge)", () => {
    const a = createLoadReducer({ timelineOrigin: T0, workerId: "w0" });
    a.apply(ev(T0, { type: "load:end", reason: "duration" }, "plan-1"));
    const b = createLoadReducer({ timelineOrigin: T0, workerId: "w1" });
    b.apply(ev(T0, { type: "load:end", reason: "duration" }, "plan-2"));
    expect(() => mergePartials([wirePartial(a), wirePartial(b)])).toThrow(/runnerId conflict/);
  });

  it("unions advisories (deduped) and takes per-facet weakest attribution", () => {
    const a = wirePartial(createLoadReducer({ timelineOrigin: T0, workerId: "w0" }));
    a.advisories.push("shared advisory", "a-only advisory");
    a.attribution.endpoint = "aggregate-only";
    const b = wirePartial(createLoadReducer({ timelineOrigin: T0, workerId: "w1" }));
    b.advisories.push("shared advisory");
    const merged = mergePartials([a, b]);
    expect(merged.advisories).toEqual(["shared advisory", "a-only advisory"]);
    expect(merged.attribution.endpoint).toBe("aggregate-only");
    const art = finalizeMerged(merged, { runEndMs: T0 + 100, provider: "multi-core" });
    expect(art.summary.advisories).toEqual(["shared advisory", "a-only advisory"]);
    expect(art.runtime.attribution.endpoint).toBe("aggregate-only");
  });

  it("is atomic: a rejected merge leaves every input part untouched", () => {
    const mkMetric = (kind: string, workerId: string) => {
      const r = createLoadReducer({ timelineOrigin: T0, workerId });
      r.apply(ev(T0, { type: "iteration:start", scenarioId: "s", producerSlotId: "p0", iterationId: "it-0" }));
      r.apply(ev(T0 + 5, { type: "metric:observed", scenarioId: "s", iterationId: "it-0", metricId: "m", kind, value: 1, ...(kind === "trend" ? { unit: "ms" } : {}) }));
      r.apply(ev(T0 + 10, { type: "iteration:end", scenarioId: "s", producerSlotId: "p0", iterationId: "it-0", ok: true, durationMs: 10 }));
      return wirePartial(r);
    };
    const parts = [mkMetric("counter", "w0"), mkMetric("counter", "w1"), mkMetric("rate", "w2")];
    const before = structuredClone(parts);
    expect(() => mergePartials(parts)).toThrow(/kind conflict/);
    expect(parts).toEqual(before);
  });

  it("censors each part's timeline at its observedAt (lost-worker in-flight closure)", () => {
    const r = createLoadReducer({ timelineOrigin: T0, workerId: "w0" });
    r.apply(ev(T0 + 100, { type: "iteration:start", scenarioId: "s", producerSlotId: "p0", iterationId: "it-0" }));
    r.apply(ev(T0 + 500, { type: "iteration:start", scenarioId: "s", producerSlotId: "p0", iterationId: "it-1" }));
    r.apply(ev(T0 + 600, { type: "iteration:end", scenarioId: "s", producerSlotId: "p0", iterationId: "it-1", ok: true, durationMs: 100 }));
    const partial = wirePartial(r); // it-0 still in flight; observedAt = T0+600
    expect(partial.timeline.windows.every(([, w]) => w.endedUnknown === 0)).toBe(true);
    const merged = mergePartials([partial]);
    // The lost worker's in-flight start is closed as endedUnknown in the cutoff window.
    const closed = merged.timeline.windows.filter(([, w]) => w.endedUnknown > 0);
    expect(closed.length).toBe(1);
    expect(closed[0][1].endedUnknown).toBe(1);
    // Windows past the cutoff report partial contributor coverage once the axis extends.
    const art = finalizeMerged(merged, { runEndMs: T0 + 2000 });
    expect(art.timeline?.windows.some((w) => w.contributorsPartial === true)).toBe(true);
  });

  it("rejects a cutoff override earlier than the frame's observedAt (atomically)", () => {
    const r = createLoadReducer({ timelineOrigin: T0, workerId: "w0" });
    r.apply(ev(T0 + 100, { type: "iteration:start", scenarioId: "s", producerSlotId: "p0", iterationId: "it-0" }));
    r.apply(ev(T0 + 600, { type: "iteration:end", scenarioId: "s", producerSlotId: "p0", iterationId: "it-0", ok: true, durationMs: 500 }));
    // Snapshot taken in an event-free trailing gap: coverage extends to T0+3000 even
    // though the last event sits at T0+600 — exactly the case where an invalid
    // earlier cutoff would slip past the timeline's own window-resolution guard.
    const part = parseLoadReducerPartial(JSON.parse(JSON.stringify(r.exportPartial(T0 + 3000))) as unknown);
    const before = structuredClone(part);
    expect(() => mergePartials([part], { observationCutoffsMs: [T0 + 2000] })).toThrow(
      /predates the part's observation coverage/,
    );
    expect(part).toEqual(before); // rejected merges leave inputs untouched
    // At / after the frame's coverage floor is fine.
    expect(() => mergePartials([part], { observationCutoffsMs: [T0 + 3000] })).not.toThrow();
    expect(() => mergePartials([part], { observationCutoffsMs: [T0 + 5000] })).not.toThrow();
  });

  it("preserves the contributor census when an all-idle censored merge synthesizes its timeline", () => {
    // Both workers lost during ramp: ZERO timeline events, early observation cutoffs.
    // The merged timeline is empty, so finalize takes the zero-synthesis path — which
    // must still mark post-cutoff windows contributorsPartial (codex R3: the census
    // was silently dropped and the synthesized axis read "fully observed").
    const a = createLoadReducer({ timelineOrigin: T0, workerId: "w0" });
    const b = createLoadReducer({ timelineOrigin: T0, workerId: "w1" });
    const pa = parseLoadReducerPartial(JSON.parse(JSON.stringify(a.exportPartial(T0 + 500))) as unknown);
    const pb = parseLoadReducerPartial(JSON.parse(JSON.stringify(b.exportPartial(T0 + 800))) as unknown);
    const merged = mergePartials([pa, pb]);
    const art = finalizeMerged(merged, { runEndMs: T0 + 2000, provider: "multi-core" });
    const windows = art.timeline!.windows;
    expect(windows).toHaveLength(8); // dense zero axis over [0, 2000) at 250ms
    expect(
      windows.every(
        (w) =>
          w.requests === 0 &&
          w.iterations === 0 &&
          w.peakInFlight === 0 &&
          w.peakInFlightBounds?.lower === 0 &&
          w.peakInFlightBounds?.upper === 0,
      ),
    ).toBe(true);
    // Cutoff windows: w0 at offset 500 → idx 2, w1 at 800 → idx 3. Windows both
    // contributors observed (0..2) are full; from idx 3 on, coverage is partial.
    expect(windows.slice(0, 3).every((w) => w.contributorsPartial !== true)).toBe(true);
    expect(windows.slice(3).every((w) => w.contributorsPartial === true)).toBe(true);
  });

  it("caller-supplied cutoffs override observedAt (clean-finish workers censor later)", () => {
    const r = createLoadReducer({ timelineOrigin: T0, workerId: "w0" });
    r.apply(ev(T0 + 100, { type: "iteration:start", scenarioId: "s", producerSlotId: "p0", iterationId: "it-0" }));
    r.apply(ev(T0 + 600, { type: "iteration:end", scenarioId: "s", producerSlotId: "p0", iterationId: "it-0", ok: true, durationMs: 500 }));
    const merged = mergePartials([wirePartial(r)], { observationCutoffsMs: [T0 + 2000] });
    const art = finalizeMerged(merged, { runEndMs: T0 + 2000 });
    // Cutoff at the authoritative run end → every in-range window is fully observed.
    expect(art.timeline?.windows.every((w) => w.contributorsPartial !== true)).toBe(true);
  });
});

describe("finalizeMerged", () => {
  it("evaluates thresholds on the interval path from the hydrated quantile source", () => {
    const { workerA, workerB, runEndMs } = richStream(true);
    const a = feed(workerA, { timelineOrigin: T0, workerId: "w0" });
    const b = feed(workerB, { timelineOrigin: T0, workerId: "w1" });
    const merged = mergePartials([wirePartial(a), wirePartial(b)]);
    const art = finalizeMerged(merged, {
      runEndMs,
      provider: "multi-core",
      thresholds: {
        transaction: { p95: "<100000ms" },
        endpoints: { "POST /login": { p95: "<100000ms", errorRate: "<0.9" } },
      },
    });
    expect(art.summary.thresholds).toHaveLength(3);
    for (const t of art.summary.thresholds) {
      expect(t.pass).toBe(true);
      expect(t.status).toBe("evaluated");
    }
    const p95Gate = art.summary.thresholds.find((t) => t.scope === "transaction");
    expect(p95Gate?.quantileBounds).toBeDefined();
  });

  it("turns gates on an INCOMPLETE merged series unevaluable (series-incomplete)", () => {
    // Worker A hit the 50-series cap (55 distinct keys) and never retained k=v60 —
    // its v60 observation folded into the untagged total invisibly. Worker B retained
    // v60. The union series undercounts (§7.3), so a tagged gate on it must be
    // unevaluable — before the completeness plumbing it evaluated the retained value
    // and false-passed the ceiling.
    const a = createLoadReducer({ timelineOrigin: T0, workerId: "w0" });
    for (let i = 0; i < 55; i++) {
      a.apply(ev(T0 + i, { type: "metric:observed", scenarioId: "s", metricId: "m", kind: "counter", value: 1, tags: { k: `v${i}` } }));
    }
    a.apply(ev(T0 + 60, { type: "metric:observed", scenarioId: "s", metricId: "m", kind: "counter", value: 7, tags: { k: "v60" } }));
    const b = createLoadReducer({ timelineOrigin: T0, workerId: "w1" });
    b.apply(ev(T0, { type: "metric:observed", scenarioId: "s", metricId: "m", kind: "counter", value: 2, tags: { k: "v60" } }));
    b.apply(ev(T0 + 1, { type: "metric:observed", scenarioId: "s", metricId: "m", kind: "counter", value: 3, tags: { k: "v0" } }));
    const merged = mergePartials([wirePartial(a), wirePartial(b)]);
    const art = finalizeMerged(merged, {
      runEndMs: T0 + 1000,
      provider: "multi-core",
      thresholds: { customMetric: { "m:k=v60": { sum: "<1000" }, "m:k=v0": { sum: "<1000" } } },
    });
    const v60 = art.summary.thresholds.find((t) => t.target === "m:k=v60");
    expect(v60?.status).toBe("unevaluable");
    expect(v60?.reason).toBe("series-incomplete");
    expect(v60?.pass).toBe(false);
    // The retained value alone (B's 2, missing A's invisible 7) would have passed the
    // ceiling — exactly the false pass the completeness plumbing prevents.
    expect(v60?.actual).toBe(2);
    // A COMPLETE series of the same truncated metric still evaluates normally.
    const v0 = art.summary.thresholds.find((t) => t.target === "m:k=v0");
    expect(v0?.status).toBe("evaluated");
    expect(v0?.pass).toBe(true);
    expect(art.summary.pass).toBe(false); // an unevaluable gate fails the run
    // The v2 artifact ROW carries the incompleteness too (codex R3): a consumer with
    // no threshold on the series must still see which row undercounts — the metric-
    // level seriesTruncated alone cannot locate it. Complete rows omit the field.
    const metricRow = art.summary.customMetrics!.find((x) => x.metricId === "m")!;
    expect(metricRow.seriesTruncated).toBe(true);
    expect(metricRow.series.find((s) => s.tags.k === "v60")?.complete).toBe(false);
    expect(metricRow.series.find((s) => s.tags.k === "v0")?.complete).toBeUndefined();
    expect(metricRow.series.find((s) => Object.keys(s.tags).length === 0)?.complete).toBeUndefined();
    // Completeness survives a hydrate → re-export round trip.
    const reExported = LoadReducerImpl.fromPartial(merged).exportPartial();
    const series = reExported.customMetrics.find((m) => m.metricId === "m")!.series;
    expect(series.find((s) => s.tags.k === "v60")?.complete).toBe(false);
    expect(series.find((s) => s.tags.k === "v0")?.complete).toBe(true);
  });

  it("stamps sharded execution provenance on the merged path (schema v2)", () => {
    const { workerA, workerB, runEndMs } = richStream(true);
    const a = feed(workerA, { timelineOrigin: T0, workerId: "w0" });
    const b = feed(workerB, { timelineOrigin: T0, workerId: "w1" });
    const merged = mergePartials([wirePartial(a), wirePartial(b)]);
    expect(merged.workerCount).toBe(2);
    expect(merged.feederGuarantee).toBe("single-node");
    const art = finalizeMerged(merged, { runEndMs, provider: "multi-core" });
    expect(art.runtime.processModel).toBe("sharded-multi-process");
    expect(art.runtime.execution).toEqual({ provider: "multi-core", workerCount: 2 });
    expect(art.runtime.feederGuarantee).toBe("single-node");
    expect(art.summary.executionStatus).toBe("complete"); // the default judgment
    // A multi-worker frame without explicit provider provenance is rejected — the
    // artifact must not report a sharded run as in-process.
    expect(() => finalizeMerged(merged, { runEndMs })).toThrow(/supply opts\.provider/);
  });

  it("keeps the single-reducer path unchanged (raw frame, no provider)", () => {
    const { all, runEndMs } = richStream(true);
    const direct = feed(all, { timelineOrigin: T0 });
    const raw = wirePartial(direct); // a worker's own export — no workerCount stamp
    expect(raw.workerCount).toBeUndefined();
    expect(raw.feederGuarantee).toBe("single-node");
    const art = finalizeMerged(raw, { runEndMs });
    expect(art.runtime.processModel).toBe("single-process-async-producer-slot");
    expect(art.runtime.execution).toEqual({ provider: "in-process", workerCount: 1 });
    expect(art.runtime.feederGuarantee).toBe("single-node");
    expect(art).toEqual(direct.finalize(runEndMs)); // byte-for-byte the direct path
  });

  it("takes the weakest feederGuarantee across parts into the merged artifact", () => {
    const a = wirePartial(createLoadReducer({ timelineOrigin: T0, workerId: "w0" }));
    const b = wirePartial(createLoadReducer({ timelineOrigin: T0, workerId: "w1" }));
    b.feederGuarantee = "degraded";
    const merged = mergePartials([a, b]);
    expect(merged.feederGuarantee).toBe("degraded");
    const art = finalizeMerged(merged, { runEndMs: T0 + 100, provider: "remote" });
    expect(art.runtime.feederGuarantee).toBe("degraded");
    expect(art.runtime.execution).toEqual({ provider: "remote", workerCount: 2 });
  });

  it("opts.executionStatus overrides the default and a non-complete status fails the run (§7.4)", () => {
    const { workerA, workerB, runEndMs } = richStream(true);
    const a = feed(workerA, { timelineOrigin: T0, workerId: "w0" });
    const b = feed(workerB, { timelineOrigin: T0, workerId: "w1" });
    const merged = mergePartials([wirePartial(a), wirePartial(b)]);
    // Baseline: complete + endReason "duration" + no crash → pass true.
    expect(finalizeMerged(merged, { runEndMs, provider: "multi-core" }).summary.pass).toBe(true);
    const art = finalizeMerged(merged, { runEndMs, provider: "multi-core", executionStatus: "partial" });
    expect(art.summary.executionStatus).toBe("partial");
    expect(art.summary.pass).toBe(false); // §7.4: pass REQUIRES complete
    expect(art.summary.endReason).toBe("duration"); // the completeness downgrade is orthogonal
  });

  it("a non-complete executionStatus downgrades every gate to partial-input (no self-contradiction)", () => {
    // codex integration R: a partial/failed execution forced summary.pass false but the
    // individual gates still evaluated the incomplete/placeholder data as passing — an
    // artifact that overall FAILS while every gate shows GREEN. Now every gate is
    // unevaluable/partial-input/pass:false, consistent with the overall verdict.
    const { workerA, workerB, runEndMs } = richStream(true);
    const a = feed(workerA, { timelineOrigin: T0, workerId: "w0" });
    const b = feed(workerB, { timelineOrigin: T0, workerId: "w1" });
    const merged = mergePartials([wirePartial(a), wirePartial(b)]);
    const gates = {
      transaction: { p95: "<100000ms" }, // would comfortably PASS on the data
      endpoints: { "POST /login": { errorRate: "<0.9" } },
    };
    // Baseline (complete): the gates evaluate and pass.
    const clean = finalizeMerged(merged, { runEndMs, provider: "multi-core", thresholds: gates });
    expect(clean.summary.thresholds.every((t) => t.status === "evaluated" && t.pass)).toBe(true);
    expect(clean.summary.pass).toBe(true);
    // partial executionStatus: same passing gates, now all unevaluable/partial-input.
    const art = finalizeMerged(merged, {
      runEndMs,
      provider: "multi-core",
      executionStatus: "partial",
      thresholds: gates,
    });
    expect(art.summary.thresholds.length).toBeGreaterThan(0);
    for (const t of art.summary.thresholds) {
      expect(t.status).toBe("unevaluable");
      expect(t.reason).toBe("partial-input");
      expect(t.pass).toBe(false);
    }
    expect(art.summary.pass).toBe(false);
    expect(art.summary.executionStatus).toBe("partial");
  });

  it("rejects a timelineOrigin that conflicts with the partial's axis", () => {
    const withOrigin = wirePartial(feed(richStream(false).all, { timelineOrigin: T0 }));
    expect(() => finalizeMerged(withOrigin, { timelineOrigin: T0 + 1 })).toThrow(/conflicts with the partial's/);
    const anchoredToFirstTs = wirePartial(feed(richStream(false).all));
    expect(() => finalizeMerged(anchoredToFirstTs, { timelineOrigin: T0 + 1 })).toThrow(/anchored to firstTs/);
    // Matching values are fine on both paths.
    expect(() => finalizeMerged(withOrigin, { timelineOrigin: T0 })).not.toThrow();
    expect(() => finalizeMerged(anchoredToFirstTs, { timelineOrigin: T0 })).not.toThrow();
  });
});

describe("parseLoadReducerPartial (frame validation)", () => {
  function valid(): LoadReducerPartialV1 {
    return JSON.parse(JSON.stringify(feed(richStream(false).all, { timelineOrigin: T0, workerId: "w0" }).exportPartial()));
  }

  it("accepts its own exporter's output", () => {
    expect(() => parseLoadReducerPartial(valid())).not.toThrow();
  });

  it("rejects an unknown version as such", () => {
    const p = valid() as unknown as Record<string, unknown>;
    p.v = 2;
    expect(() => parseLoadReducerPartial(p)).toThrow(/unsupported payload version 2/);
  });

  it("rejects non-object / structurally broken payloads", () => {
    expect(() => parseLoadReducerPartial(null)).toThrow(/must be an object/);
    expect(() => parseLoadReducerPartial([])).toThrow(/must be an object/);
    const p = valid() as unknown as Record<string, unknown>;
    delete p.scenarios;
    expect(() => parseLoadReducerPartial(p)).toThrow(/scenarios must be an array/);
  });

  it("rejects negative / unsafe counts", () => {
    const p = valid();
    (p as unknown as Record<string, unknown>).iterStarted = -1;
    expect(() => parseLoadReducerPartial(p)).toThrow(/iterStarted must be a non-negative safe integer/);
    const q = valid();
    (q as unknown as Record<string, unknown>).liveContinuations = 1.5;
    expect(() => parseLoadReducerPartial(q)).toThrow(/liveContinuations/);
  });

  it("delegates deep histogram validation and names the offending field", () => {
    const p = valid();
    p.iterLatency.count += 1; // breaks the histogram's own count identity
    expect(() => parseLoadReducerPartial(p)).toThrow(/iterLatency: LoadHistogram.fromJSON/);
  });

  it("pins embedded histograms to the default relativeError", () => {
    const p = valid();
    const alien = new LoadHistogram(0.05);
    alien.record(10);
    p.iterLatency = JSON.parse(JSON.stringify(alien.toJSON()));
    expect(() => parseLoadReducerPartial(p)).toThrow(/pinned/);
  });

  it("delegates timeline / slot-busy validation and names the field", () => {
    const p = valid();
    (p.timeline as unknown as Record<string, unknown>).windowMs = 300; // not base·2ⁿ
    expect(() => parseLoadReducerPartial(p)).toThrow(/timeline: LoadTimeline.fromJSON/);
    const q = valid();
    (q.slotBusy as unknown as Record<string, unknown>).windows = [[0, -5]];
    expect(() => parseLoadReducerPartial(q)).toThrow(/slotBusy: SlotBusyWindows.fromJSON/);
  });

  it("rejects duplicate keyed rows (canonical uniqueness)", () => {
    const p = valid();
    p.scenarios.push(JSON.parse(JSON.stringify(p.scenarios[0])));
    expect(() => parseLoadReducerPartial(p)).toThrow(/unique per \(scenarioId, scenarioRefId\)/);
    const q = valid();
    q.endpoints.push(JSON.parse(JSON.stringify(q.endpoints[0])));
    expect(() => parseLoadReducerPartial(q)).toThrow(/unique per \(routeKey, phase\)/);
  });

  it("rejects an untagged (empty-tags) entry inside `series` — its only home is `total`", () => {
    const p = valid();
    const rate = p.customMetrics.find((m) => m.kind === "rate")!;
    rate.series.push({ tags: {}, count: 1, trueCount: 1, sum: 0, complete: true });
    expect(() => parseLoadReducerPartial(p)).toThrow(
      /the untagged total lives in `total`, never in `series`/,
    );
  });

  it("enforces the trend↔hist presence rule on custom metric series", () => {
    const p = valid();
    const trend = p.customMetrics.find((m) => m.kind === "trend");
    delete trend!.total.hist;
    expect(() => parseLoadReducerPartial(p)).toThrow(/present for a trend metric/);
    const q = valid();
    const rate = q.customMetrics.find((m) => m.kind === "rate");
    rate!.total.hist = new LoadHistogram().toJSON();
    expect(() => parseLoadReducerPartial(q)).toThrow(/absent for a rate metric/);
  });

  it("rejects an observation cutoff inconsistency (observedAt before lastTs)", () => {
    const p = valid();
    (p as unknown as Record<string, unknown>).observedAt = p.lastTs - 1;
    expect(() => parseLoadReducerPartial(p)).toThrow(/observedAt must be at or after lastTs/);
  });

  it("rejects an oversized recentFailures ring and over-cap samples", () => {
    const p = valid();
    const template = p.recentFailures[0] ?? { iterationId: "it-x", atMs: 1 };
    p.recentFailures = Array.from({ length: 101 }, (_, i) => ({ ...template, iterationId: `it-${i}` }));
    expect(() => parseLoadReducerPartial(p)).toThrow(/recentFailures must be at most 100/);
    const q = valid();
    (q.samples as unknown as Record<string, unknown>).maxFailureTraces = 0;
    expect(() => parseLoadReducerPartial(q)).toThrow(/at most maxFailureTraces/);
  });
});
