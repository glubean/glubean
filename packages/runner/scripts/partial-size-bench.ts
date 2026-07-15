/**
 * partial-size-bench — D0-10 (proposal §7.1 体量纪律 / §12): measure the REAL serialized
 * size of `LoadReducerPartialV1` (`LoadReducerImpl.exportPartial`) for realistic-scale
 * reducer states, to ground the `maxPartialBytes` default before D1 implements wire-level
 * enforcement.
 *
 * DEV-ONLY SCRIPT — never published (package.json `files` ships `dist/` only) and never
 * imported by src/. It drives the real reducer through a synthetic but realistic event
 * stream (a 10-minute, 50-slot, ~400 RPS worker with continuation phase, failures,
 * custom metrics and full sample caps), then serializes the export and reports raw and
 * gzip sizes across a scale matrix:
 *
 *   - timeline: 600 windows (full cap; 250 ms base coarsened to 1 s over the 600 s run)
 *     with realistic per-window latency histograms (lognormal per-route latencies);
 *   - endpoints: {10, 100, 500} routeKeys, each observed in BOTH phases (primary +
 *     continuation re-poll) → 2 rows per routeKey;
 *   - steps {5, 20} × scenarios {1, 5} (matrix cells follow the route/step assignment);
 *   - custom metrics: {0, 10} trend metrics × 50 tag-series (full series cap) + total;
 *   - samples: full caps (default 20 failure traces + 20 slow summaries);
 *   - slot-busy: 600 windows (50 slots busy for the whole run).
 *
 * Run (workspace deps must be built first — `CI=1 pnpm -r build`):
 *
 *   cd packages/runner && pnpm exec tsx scripts/partial-size-bench.ts
 *
 * Output: a markdown table (scale combo × raw/gzip bytes) plus a per-field size
 * breakdown of the largest combo, on stdout.
 */
import { gzipSync } from "node:zlib";
import { LoadReducerImpl } from "../src/load/reducer.js";
import { parseLoadReducerPartial } from "../src/load/partial.js";
import type { LoadEvent, LoadResolvedConfig } from "@glubean/sdk/load";

// ── deterministic randomness (reproducible sizes) ─────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── run model constants (one realistic heavy worker) ──────────────────────

const RUN_MS = 600_000; // 10-min run → timeline coarsens 250 ms → 1 s = exactly 600 windows
const CONCURRENCY = 50; // producer slots
const RAMP_MS = 10_000;
const TOTAL_REQUESTS = 240_000; // ≈ 400 RPS sustained
const REQUEST_ERROR_RATE = 0.005; // sporadic HTTP 500s
const FAIL_EVERY = 50; // 2% failed iterations → fills the 100-entry recentFailures ring
const METRIC_OBS_PER_SERIES = 60;
const T0 = 1_750_000_000_000; // epoch origin (also the injected timelineOrigin)

interface Combo {
  routes: number;
  steps: number;
  scenarios: number;
  metrics: number;
}

interface Row extends Combo {
  endpointRows: number;
  matrixRows: number;
  stepRows: number;
  timelineWindows: number;
  avgWindowBuckets: number;
  rawBytes: number;
  gzipBytes: number;
}

function buildPartial(c: Combo): { row: Row; fieldBytes: Map<string, number> } {
  const rand = mulberry32(0xd0_10 ^ (c.routes * 7919 + c.steps * 131 + c.scenarios * 17 + c.metrics));
  const randn = (): number => {
    let u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  const lognormal = (median: number, sigma: number): number =>
    Math.min(30_000, Math.max(1, median * Math.exp(sigma * randn())));

  const reducer = new LoadReducerImpl({ workerId: "w3", timelineOrigin: T0 });
  let seq = 0;
  type BenchEvent = LoadEvent extends infer E
    ? E extends LoadEvent
      ? Omit<E, "seq" | "runId" | "runnerId">
      : never
    : never; // distributive Omit — a plain Omit over the union collapses to envelope keys
  const emit = (e: BenchEvent): void => {
    reducer.apply({ runId: "bench-run", runnerId: "load-bench", seq: seq++, ...e } as LoadEvent);
  };
  // Every in-run offset stays < RUN_MS so the timeline never coarsens past 600×1 s.
  const clamp = (t: number): number => Math.min(t, T0 + RUN_MS - 1);

  const methodOf = (r: number): string => ["GET", "POST", "PUT", "DELETE"][r % 4];
  const routeKeyOf = (r: number): string =>
    `${methodOf(r)} /api/v1/resource-${String(r).padStart(3, "0")}/{id}`;
  const medianOf = (r: number): number => 20 + ((r * 37) % 280); // 20–300 ms per route

  const config: LoadResolvedConfig = {
    concurrency: CONCURRENCY,
    durationMs: RUN_MS,
    rampUpMs: RAMP_MS,
    rngSeed: "bench-seed-0001",
    pacing: { thinkTimeMs: { min: 5, max: 25 } },
    continuation: {
      maxOutstanding: 100,
      maxConcurrent: 25,
      minPollIntervalMs: 250,
      drainTimeoutMs: 30_000,
      onBacklogFull: "block-producer",
    },
    ...(c.scenarios > 1
      ? {
          scenarios: Array.from({ length: c.scenarios }, (_, s) => ({
            scenarioRefId: `mix-${s}`,
            scenarioId: `scn-flow-${s}`,
            weight: s + 1,
          })),
        }
      : {}),
  };
  emit({ type: "load:start", ts: T0, config });
  for (let j = 0; j < CONCURRENCY; j++) {
    emit({
      type: "producerSlot:start",
      ts: T0 + Math.round((j * RAMP_MS) / CONCURRENCY),
      producerSlotIndex: j,
    });
  }

  // Route ↔ (scenario, step) assignment: pair p = scenario·steps + step owns the routes
  // { r : r ≡ p (mod pairs) } (or route p mod R when pairs > routes), rotated per
  // iteration — each route is observed under exactly one (scenario, step), in both
  // phases (primary execution + continuation re-poll of the same step).
  const pairs = c.scenarios * c.steps;
  const routesOfPair = (p: number): number[] => {
    if (c.routes < pairs) return [p % c.routes];
    const list: number[] = [];
    for (let r = p; r < c.routes; r += pairs) list.push(r);
    return list;
  };

  const iters = Math.round(TOTAL_REQUESTS / (2 * c.steps));
  const groups = Math.ceil(iters / CONCURRENCY);
  const spacing = RUN_MS / groups;
  // Per-(pair, phase) rotation counters, advanced on each actual request — decoupled
  // from the iteration index so the failure cadence (which skips a failed iteration's
  // remaining steps + continuation pass) cannot systematically starve a pool slot.
  const rot = new Array<number>(pairs * 2).fill(0);

  for (let i = 0; i < iters; i++) {
    const sc = i % c.scenarios;
    const scenarioId = `scn-flow-${sc}`;
    const scenarioRefId = c.scenarios > 1 ? `mix-${sc}` : undefined;
    const iterationId = `it-${i}`;
    const producerSlotId = `slot-${i % CONCURRENCY}`;
    const idFields = {
      scenarioId,
      ...(scenarioRefId !== undefined ? { scenarioRefId } : {}),
      iterationId,
      producerSlotId,
    };
    const g = Math.floor(i / CONCURRENCY);
    const startTs = clamp(T0 + Math.round(g * spacing + rand() * spacing * 0.5));
    emit({ type: "iteration:start", ts: startTs, ...idFields });

    const failing = i % FAIL_EVERY === 7;
    const failStep = i % c.steps;
    let t = startTs;
    let failed = false;

    const runStep = (k: number, phase: "primary" | "continuation"): void => {
      const p = sc * c.steps + k;
      const pool = routesOfPair(p);
      const rotIdx = p * 2 + (phase === "primary" ? 0 : 1);
      const r = pool[rot[rotIdx]++ % pool.length];
      const stepId = `step-${k}`;
      const stepName = `${phase === "primary" ? "call" : "poll"} resource-${String(r).padStart(3, "0")}`;
      emit({ type: "step:start", ts: clamp(t), stepId, stepName, phase, groupId: `grp-${k % 4}`, ...idFields });
      const median = phase === "primary" ? medianOf(r) : medianOf(r) * 0.5;
      const d = Math.round(lognormal(median, 0.5) * 10) / 10;
      const reqError = rand() < REQUEST_ERROR_RATE;
      emit({
        type: "request:observed",
        ts: clamp(t + d),
        method: methodOf(r),
        url: `https://api.example.com/api/v1/resource-${String(r).padStart(3, "0")}/8214`,
        routeKey: routeKeyOf(r),
        routeKeySource: "catalog",
        routeKeyHeuristic: false,
        status: reqError ? 500 : r % 5 === 0 ? 201 : 200,
        ok: !reqError,
        durationMs: d,
        ...(reqError ? { errorKind: "http" as const } : {}),
        phase,
        stepId,
        ...idFields,
      });
      const assertFail = failing && phase === "primary" && k === failStep;
      if (assertFail) {
        emit({
          type: "assertion:observed",
          ts: clamp(t + d + 1),
          passed: false,
          message: `expected order state "confirmed", got "pending" after ${k + 1} steps`,
          actual: { state: "pending", attempts: 3, lastStatus: 202 },
          expected: { state: "confirmed" },
          phase,
          stepId,
          ...idFields,
        });
        failed = true;
      }
      emit({
        type: "step:end",
        ts: clamp(t + d + 2),
        stepId,
        stepName,
        ok: !assertFail,
        durationMs: d + 2,
        ...(assertFail ? { assertionFailures: 1, errorKind: "assertion" as const } : {}),
        phase,
        ...idFields,
      });
      t += d + 2 + (5 + rand() * 20); // think time
    };

    // Primary pass over every step (fail-fast on the failing step).
    for (let k = 0; k < c.steps; k++) {
      runStep(k, "primary");
      if (failed) break;
    }
    if (failed) {
      emit({
        type: "iteration:end",
        ts: clamp(t),
        ok: false,
        durationMs: Math.round(clamp(t) - startTs),
        errorKind: "assertion",
        ...idFields,
      });
      continue;
    }
    // Boundary + release, then a continuation re-poll of the same steps/routes.
    const primaryDurationMs = Math.round(clamp(t) - startTs);
    emit({
      type: "producer:primaryCompleted",
      ts: clamp(t),
      primaryId: iterationId,
      primaryDurationMs,
      releaseRequested: true,
      ...idFields,
    });
    const backpressureMs = Math.round(lognormal(2, 0.8) * 10) / 10;
    emit({
      type: "producer:released",
      ts: clamp(t + backpressureMs),
      releaseId: iterationId,
      primaryDurationMs,
      continuationBacklog: i % 8,
      backpressureMs,
      ...idFields,
    });
    t += backpressureMs;
    for (let k = 0; k < c.steps; k++) runStep(k, "continuation");
    emit({
      type: "iteration:end",
      ts: clamp(t),
      ok: true,
      durationMs: Math.round(clamp(t) - startTs),
      ...idFields,
    });
  }

  // Custom metrics: `metrics` trend metrics × 50 tag-series (full series cap) + total.
  const regions = Array.from({ length: 10 }, (_, i) => `eu-west-${i}`);
  const plans = ["free", "starter", "team", "business", "enterprise"];
  for (let m = 0; m < c.metrics; m++) {
    for (let si = 0; si < 50; si++) {
      const tags = { region: regions[si % 10], plan: plans[Math.floor(si / 10)] };
      for (let o = 0; o < METRIC_OBS_PER_SERIES; o++) {
        emit({
          type: "metric:observed",
          ts: clamp(T0 + Math.round(((o + 0.5) * RUN_MS) / METRIC_OBS_PER_SERIES + rand() * 500)),
          metricId: `custom_latency_${String(m).padStart(2, "0")}`,
          kind: "trend",
          unit: "ms",
          value: Math.round(lognormal(50, 0.7) * 10) / 10,
          tags,
        });
      }
    }
  }

  for (let j = 0; j < CONCURRENCY; j++) {
    emit({
      type: "producerSlot:end",
      ts: T0 + RUN_MS,
      producerSlotIndex: j,
      primaryIterations: Math.floor(iters / CONCURRENCY),
    });
  }
  emit({ type: "load:end", ts: T0 + RUN_MS, reason: "duration" });

  const partial = reducer.exportPartial(T0 + RUN_MS);
  const json = JSON.stringify(partial);
  const rawBytes = Buffer.byteLength(json);
  const gzipBytes = gzipSync(Buffer.from(json)).length; // zlib default level (6) ≈ wire compression

  // ── sanity: the frame is a valid partial and hit every intended cap ──
  const parsed = parseLoadReducerPartial(JSON.parse(json));
  const assert = (cond: boolean, what: string): void => {
    if (!cond) throw new Error(`combo ${JSON.stringify(c)}: ${what}`);
  };
  assert(parsed.timeline.windows.length >= 595, `timeline windows ${parsed.timeline.windows.length} < 595`);
  assert(parsed.timeline.windows.length <= 600, `timeline windows ${parsed.timeline.windows.length} > 600`);
  assert((parsed.timeline as { windowMs: number }).windowMs === 1000, "timeline windowMs !== 1000");
  assert(parsed.slotBusy.windows.length === 600, `slotBusy windows ${parsed.slotBusy.windows.length} !== 600`);
  assert(parsed.endpoints.length === 2 * c.routes, `endpoint rows ${parsed.endpoints.length} !== ${2 * c.routes}`);
  assert(
    parsed.matrix.length === 2 * Math.max(c.routes, pairs),
    `matrix rows ${parsed.matrix.length} !== ${2 * Math.max(c.routes, pairs)}`,
  );
  assert(parsed.samples.failureTraces.length === 20, `failureTraces ${parsed.samples.failureTraces.length} !== 20`);
  assert(
    parsed.samples.slowTransactions.length === 20,
    `slowTransactions ${parsed.samples.slowTransactions.length} !== 20`,
  );
  assert(parsed.customMetrics.length === c.metrics, `customMetrics ${parsed.customMetrics.length} !== ${c.metrics}`);
  for (const m of parsed.customMetrics) {
    assert(m.series.length === 50, `metric ${m.metricId} series ${m.series.length} !== 50`);
  }
  assert(parsed.recentFailures.length === 100, `recentFailures ${parsed.recentFailures.length} !== 100`);

  const avgWindowBuckets =
    parsed.timeline.windows.reduce((n, [, w]) => n + w.latency.buckets.length, 0) /
    parsed.timeline.windows.length;

  const fieldBytes = new Map<string, number>();
  for (const [k, v] of Object.entries(partial)) {
    fieldBytes.set(k, Buffer.byteLength(JSON.stringify(v)));
  }

  return {
    row: {
      ...c,
      endpointRows: parsed.endpoints.length,
      matrixRows: parsed.matrix.length,
      stepRows: parsed.steps.length,
      timelineWindows: parsed.timeline.windows.length,
      avgWindowBuckets: Math.round(avgWindowBuckets),
      rawBytes,
      gzipBytes,
    },
    fieldBytes,
  };
}

// ── driver ────────────────────────────────────────────────────────────────

const pretty = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(2)} MiB` : `${(n / 1024).toFixed(0)} KiB`;

const startedAt = Date.now();
const rows: Row[] = [];
let largest: { combo: Combo; fieldBytes: Map<string, number>; rawBytes: number } | undefined;

for (const routes of [10, 100, 500]) {
  for (const steps of [5, 20]) {
    for (const scenarios of [1, 5]) {
      for (const metrics of [0, 10]) {
        const combo = { routes, steps, scenarios, metrics };
        const { row, fieldBytes } = buildPartial(combo);
        rows.push(row);
        if (largest === undefined || row.rawBytes > largest.rawBytes) {
          largest = { combo, fieldBytes, rawBytes: row.rawBytes };
        }
        process.stderr.write(
          `done routes=${routes} steps=${steps} scenarios=${scenarios} metrics=${metrics}: ${pretty(row.rawBytes)} raw / ${pretty(row.gzipBytes)} gz\n`,
        );
      }
    }
  }
}

console.log(
  `\nLoadReducerPartialV1 export sizes — 600 s run, ${CONCURRENCY} slots, ~${Math.round(TOTAL_REQUESTS / (RUN_MS / 1000))} RPS, 2% failed iterations, full sample caps (20+20), timeline+slot-busy at the 600-window cap, custom metrics at the 50-series cap (node ${process.version})\n`,
);
console.log(
  "| routes | steps | scenarios | metrics | endpoint rows | matrix rows | step rows | tl windows | ~buckets/window | raw bytes | raw | gzip bytes | gzip |",
);
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  console.log(
    `| ${r.routes} | ${r.steps} | ${r.scenarios} | ${r.metrics} | ${r.endpointRows} | ${r.matrixRows} | ${r.stepRows} | ${r.timelineWindows} | ${r.avgWindowBuckets} | ${r.rawBytes.toLocaleString("en-US")} | ${pretty(r.rawBytes)} | ${r.gzipBytes.toLocaleString("en-US")} | ${pretty(r.gzipBytes)} |`,
  );
}

if (largest !== undefined) {
  const { combo, fieldBytes, rawBytes } = largest;
  console.log(
    `\nPer-field breakdown of the largest combo (routes=${combo.routes}, steps=${combo.steps}, scenarios=${combo.scenarios}, metrics=${combo.metrics} — ${pretty(rawBytes)} raw):\n`,
  );
  console.log("| field | bytes | share |");
  console.log("|---|---|---|");
  const sorted = [...fieldBytes.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, v] of sorted) {
    if (v < 1024) continue; // skip scalar envelope noise
    console.log(`| ${k} | ${v.toLocaleString("en-US")} | ${((v / rawBytes) * 100).toFixed(1)}% |`);
  }
}

console.log(`\nbench wall time: ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
