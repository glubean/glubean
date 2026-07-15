import { describe, expect, it } from "vitest";

import type { LoadArtifact, LoadThresholds } from "@glubean/sdk/load";

import { LoadHistogram } from "./histogram.js";
import { evaluateThresholds, parseThresholdExpression } from "./threshold.js";

/** A histogram folding the given values (default 1% relative error). */
function histOf(values: number[]): LoadHistogram {
  const h = new LoadHistogram();
  for (const v of values) h.record(v);
  return h;
}

describe("parseThresholdExpression (M4-a)", () => {
  it("parses operators", () => {
    expect(parseThresholdExpression("<1", "p50")).toEqual({ op: "<", value: 1 });
    expect(parseThresholdExpression("<=1", "p50")).toEqual({ op: "<=", value: 1 });
    expect(parseThresholdExpression(">1", "p50")).toEqual({ op: ">", value: 1 });
    expect(parseThresholdExpression(">=1", "p50")).toEqual({ op: ">=", value: 1 });
  });

  it("normalizes errorRate percentages to a fraction", () => {
    expect(parseThresholdExpression("<1%", "errorRate")).toEqual({ op: "<", value: 0.01 });
    expect(parseThresholdExpression("<0.05", "errorRate")).toEqual({ op: "<", value: 0.05 });
  });

  it("normalizes latency units to ms", () => {
    expect(parseThresholdExpression("<800ms", "p95")).toEqual({ op: "<", value: 800 });
    expect(parseThresholdExpression("<2s", "p95")).toEqual({ op: "<", value: 2000 });
    expect(parseThresholdExpression("<800", "p99")).toEqual({ op: "<", value: 800 }); // bare = ms
  });

  it("normalizes throughput", () => {
    expect(parseThresholdExpression(">100/s", "throughputPerSec")).toEqual({ op: ">", value: 100 });
    expect(parseThresholdExpression(">100", "throughputPerSec")).toEqual({ op: ">", value: 100 });
  });

  it("tolerates whitespace", () => {
    expect(parseThresholdExpression(" <  800 ms ", "p95")).toEqual({ op: "<", value: 800 });
  });

  it("rejects malformed expressions and mismatched units", () => {
    expect(() => parseThresholdExpression("800ms", "p95")).toThrow(/invalid threshold expression/);
    expect(() => parseThresholdExpression("<abc", "p95")).toThrow(/invalid threshold expression/);
    expect(() => parseThresholdExpression("<1ms", "errorRate")).toThrow(/not valid for metric/);
    expect(() => parseThresholdExpression("<1%", "p95")).toThrow(/not valid for metric/);
    expect(() => parseThresholdExpression("<1/s", "p95")).toThrow(/not valid for metric/);
  });
});

/** A minimal artifact stub carrying just the fields the evaluator reads. */
function artifactStub(over: {
  pass?: boolean;
  totalIterations?: number;
  errorRate?: number;
  throughputPerSec?: number;
  latency?: { p50: number; p90: number; p95: number; p99: number; max: number };
  endpoints?: LoadArtifact["endpoints"];
  steps?: LoadArtifact["steps"];
  primary?: LoadArtifact["summary"]["primary"];
  endToEnd?: LoadArtifact["summary"]["endToEnd"];
  continuation?: LoadArtifact["summary"]["continuation"];
  customMetrics?: LoadArtifact["summary"]["customMetrics"];
}): LoadArtifact {
  const pct = over.latency ?? { p50: 10, p90: 20, p95: 30, p99: 40, max: 50 };
  const totalIterations = over.totalIterations ?? 100;
  return {
    summary: {
      pass: over.pass ?? true,
      totalIterations,
      successfulIterations: totalIterations,
      failedIterations: 0,
      errorRate: over.errorRate ?? 0,
      throughputPerSec: over.throughputPerSec ?? 200,
      latency: pct,
      ...(over.primary !== undefined ? { primary: over.primary } : {}),
      ...(over.endToEnd !== undefined ? { endToEnd: over.endToEnd } : {}),
      ...(over.continuation !== undefined ? { continuation: over.continuation } : {}),
      ...(over.customMetrics !== undefined ? { customMetrics: over.customMetrics } : {}),
      thresholds: [],
    },
    endpoints: over.endpoints ?? [],
    steps: over.steps ?? [],
  } as unknown as LoadArtifact;
}

describe("evaluateThresholds (M4-a)", () => {
  // NOTE (D0-T5 migration): the tests in this block call the evaluator WITHOUT a
  // quantile source, exercising the artifact-point-value FALLBACK path (the adapter /
  // imported-artifact case). Their point assertions are still exact there — the
  // interval semantics live in the "interval evaluation" block below. Where a row's
  // shape is pinned, `status: "evaluated"` is added (tri-state, schema v2).
  it("passes when transaction thresholds hold", () => {
    const art = artifactStub({ errorRate: 0.005, throughputPerSec: 250, latency: { p50: 10, p90: 20, p95: 700, p99: 900, max: 1000 } });
    const thresholds: LoadThresholds = {
      transaction: { errorRate: "<1%", p95: "<800ms", throughputPerSec: ">100/s" },
    };
    const { thresholds: evals, pass } = evaluateThresholds(art, thresholds);
    expect(pass).toBe(true);
    expect(evals).toHaveLength(3);
    expect(evals.every((e) => e.pass)).toBe(true);
    // Every evaluated row carries the explicit tri-state marker.
    expect(evals.every((e) => e.status === "evaluated")).toBe(true);
    expect(evals.find((e) => e.metric === "errorRate")).toMatchObject({
      scope: "transaction",
      expression: "<1%",
      actual: 0.005,
      pass: true,
      status: "evaluated",
    });
  });

  it("fails the run when any threshold is breached", () => {
    const art = artifactStub({ errorRate: 0.02 }); // 2% > 1%
    const { thresholds: evals, pass } = evaluateThresholds(art, {
      transaction: { errorRate: "<1%" },
    });
    expect(pass).toBe(false);
    expect(evals[0]).toMatchObject({ metric: "errorRate", actual: 0.02, pass: false });
  });

  it("keeps a crashed run failing even when thresholds hold", () => {
    const art = artifactStub({ pass: false, errorRate: 0 });
    const { pass } = evaluateThresholds(art, { transaction: { errorRate: "<1%" } });
    expect(pass).toBe(false); // crash dominates
  });

  it("evaluates per-endpoint thresholds by routeKey", () => {
    const art = artifactStub({
      endpoints: [
        {
          routeKey: "GET /items/:id",
          routeKeySource: "normalized-url",
          routeKeyHeuristic: true,
          requestCount: 100,
          errorCount: 0,
          errorRate: 0,
          statusCounts: { "200": 100 },
          latency: { p50: 5, p90: 10, p95: 15, p99: 20, max: 25 },
          throughputPerSec: 50,
        },
      ] as unknown as LoadArtifact["endpoints"],
    });
    const { thresholds: evals, pass } = evaluateThresholds(art, {
      endpoints: { "GET /items/:id": { p95: "<100ms" } },
    });
    expect(pass).toBe(true);
    expect(evals[0]).toMatchObject({ scope: "endpoint", target: "GET /items/:id", metric: "p95", actual: 15, pass: true });
  });

  const mkEp = (phase: "primary" | "continuation", p95: number, throughputPerSec: number) => ({
    routeKey: "GET /status",
    phase,
    routeKeySource: "normalized-url",
    routeKeyHeuristic: true,
    requestCount: 50,
    errorCount: 0,
    errorRate: 0,
    statusCounts: { "200": 50 },
    latency: { p50: p95 / 2, p90: p95 - 1, p95, p99: p95 + 5, max: p95 + 10 },
    throughputPerSec,
  });

  it("combines an endpoint's phase rows for latency in the NO-SOURCE fallback (max-of-rows)", () => {
    // MIGRATION NOTE (D0-T5): this used to be the ONLY latency-combination semantics.
    // It remains correct for this test because no quantile source is supplied — the
    // fallback (adapter artifacts) still refuses to let a fast primary row hide a slow
    // continuation row (combined p95 = max across phases, conservative). With a
    // histogram source the same shape is decided on the MERGED distribution instead —
    // see "histogram direct evaluation replaces max-of-rows" below, where a tiny slow
    // phase no longer causes this false breach.
    const art = artifactStub({
      endpoints: [mkEp("primary", 20, 25), mkEp("continuation", 900, 25)] as unknown as LoadArtifact["endpoints"],
    });
    const { thresholds: evals, pass } = evaluateThresholds(art, {
      endpoints: { "GET /status": { p95: "<800ms" } },
    });
    expect(evals).toHaveLength(1); // combined into one evaluation
    expect(evals[0]).toMatchObject({ scope: "endpoint", metric: "p95", actual: 900, pass: false, status: "evaluated" });
    expect(pass).toBe(false);
  });

  it("sums throughput across an endpoint's phase rows (additive metric)", () => {
    // 60/s primary + 60/s continuation = 120/s total → passes a `>100/s` floor that
    // neither phase meets alone.
    const art = artifactStub({
      endpoints: [mkEp("primary", 20, 60), mkEp("continuation", 20, 60)] as unknown as LoadArtifact["endpoints"],
    });
    const { thresholds: evals, pass } = evaluateThresholds(art, {
      endpoints: { "GET /status": { throughputPerSec: ">100/s" } },
    });
    expect(evals).toHaveLength(1);
    expect(evals[0]).toMatchObject({ metric: "throughputPerSec", actual: 120, pass: true });
    expect(pass).toBe(true);
  });

  it("evaluates a step errorRate threshold over invocations, not requests", () => {
    // A step that failed 50% of its invocations while issuing ZERO HTTP requests
    // must fail an errorRate threshold — a request-based denominator would read 0%.
    const step = {
      scenarioId: "s",
      stepId: "0:checkout",
      stepName: "checkout",
      phase: "primary",
      invocationCount: 2,
      skippedCount: 0,
      assertionFailureCount: 1,
      errorCount: 1,
      errorRate: 0.5,
      latency: { p50: 10, p90: 20, p95: 30, p99: 40, max: 50 },
      requestCount: 0,
    };
    const art = artifactStub({ steps: [step] as unknown as LoadArtifact["steps"] });
    const { thresholds: evals, pass } = evaluateThresholds(art, {
      steps: { "0:checkout": { errorRate: "<1%" } },
    });
    expect(evals[0]).toMatchObject({ scope: "step", metric: "errorRate", actual: 0.5, pass: false });
    expect(pass).toBe(false);
  });

  it("evaluates continuation backlog / backpressure thresholds numerically (M6)", () => {
    // backpressureMs is a percentile object (compare p95) and backlog uses the PEAK.
    const art = artifactStub({
      continuation: {
        backlog: 0,
        maxBacklog: 12,
        maxConcurrent: 12,
        active: 0,
        backpressureMs: { p50: 5, p90: 40, p95: 80, p99: 120, max: 150 },
        queueWaitMs: { p50: 5, p90: 40, p95: 80, p99: 120, max: 150 },
        releasedProducerSlots: 100,
        primaryBoundaryCoverage: 1,
        releaseCoverage: 1,
        duplicateReleaseSignals: 0,
        rejectedReleaseSignals: 0,
        abortedByDrainTimeout: 0,
      } as LoadArtifact["summary"]["continuation"],
    });
    const { thresholds: evals, pass } = evaluateThresholds(art, {
      continuation: { backlog: "<20", backpressureMs: "<100ms" }, // peak 12 < 20; p95 80 < 100
    });
    expect(pass).toBe(true);
    expect(evals.find((e) => e.metric === "backlog")).toMatchObject({ scope: "continuation", actual: 12, pass: true });
    expect(evals.find((e) => e.metric === "backpressureMs")).toMatchObject({ actual: 80, pass: true });
  });

  it("fails a continuation backpressure threshold when p95 exceeds it", () => {
    const art = artifactStub({
      continuation: {
        backlog: 0, maxBacklog: 5, maxConcurrent: 5, active: 0,
        backpressureMs: { p50: 100, p90: 300, p95: 450, p99: 600, max: 700 },
        releasedProducerSlots: 50, primaryBoundaryCoverage: 1, releaseCoverage: 1,
        duplicateReleaseSignals: 0, rejectedReleaseSignals: 0, abortedByDrainTimeout: 0,
      } as LoadArtifact["summary"]["continuation"],
    });
    const { pass } = evaluateThresholds(art, { continuation: { backpressureMs: "<200ms" } }); // p95 450 ≥ 200
    expect(pass).toBe(false);
  });

  it("skips thresholds whose scope data is absent or metric is N/A", () => {
    const art = artifactStub({}); // no phase split present → primary scope skipped
    const { thresholds: evals, pass } = evaluateThresholds(art, {
      primary: { p95: "<800ms" }, // summary.primary absent → skipped (not failed)
      endpoints: { "GET /missing": { p95: "<1ms" } }, // no such endpoint → skipped
    });
    expect(evals).toHaveLength(0);
    expect(pass).toBe(true); // nothing evaluable, crash-free → pass
  });

  it("evaluates primary / endToEnd scope thresholds when the phase split is present (M5)", () => {
    const art = artifactStub({
      primary: {
        started: 100, completed: 100, failedBeforeRelease: 0, throughputPerSec: 200,
        latency: { p50: 5, p90: 9, p95: 12, p99: 18, max: 25 },
      },
      endToEnd: {
        started: 100, completed: 100, successful: 100, failed: 0, inFlightAtEnd: 0,
        errorRate: 0, throughputPerSec: 80, latency: { p50: 40, p90: 70, p95: 120, p99: 180, max: 240 },
      },
    });
    const { thresholds: evals, pass } = evaluateThresholds(art, {
      primary: { p95: "<50ms" }, // 12 < 50 → pass
      endToEnd: { p95: "<100ms" }, // 120 < 100 → FAIL
    });
    expect(pass).toBe(false);
    expect(evals.find((e) => e.scope === "primary")).toMatchObject({ metric: "p95", actual: 12, pass: true });
    expect(evals.find((e) => e.scope === "endToEnd")).toMatchObject({ metric: "p95", actual: 120, pass: false });
  });
});

describe("interval evaluation of latency quantile gates (D0-T5)", () => {
  // 100 identical 800ms samples: every quantile hits the log-bucket containing 800,
  // whose interval is [~793.7 (the bucket's lower edge), 800 (upper, clamped to the
  // exact max)]. The sanity assertions pin that window so the fixed thresholds below
  // provably sit inside/outside it.
  const hist = histOf(Array(100).fill(800));
  const b = hist.percentileBounds().p95;

  it("sanity: the p95 interval of 100×800ms is (793, 794) .. 800", () => {
    expect(b.upper).toBe(800); // clamped to the observed max
    expect(b.lower).toBeGreaterThan(793);
    expect(b.lower).toBeLessThan(794);
  });

  const evalP95 = (expr: string) => {
    const art = artifactStub({});
    const { thresholds: evals, pass } = evaluateThresholds(
      art,
      { transaction: { p95: expr } },
      { transaction: hist },
    );
    return { row: evals[0], pass };
  };

  // Four-operator × (clear pass / clear fail / borderline) matrix. Interval
  // [L≈793.7, U=800]; `<`/`<=` are decided at U, `>`/`>=` at L; L-verdict ≠
  // U-verdict → the threshold cuts through the interval → borderline.
  const matrix: Array<[string, "pass" | "fail" | "borderline"]> = [
    // <  : pass iff U < T; fail iff L ≥ T
    ["<801ms", "pass"], // U=800 < 801
    ["<793ms", "fail"], // L≈793.7 ≥ 793
    ["<800ms", "borderline"], // L < 800 but U = 800 not < 800
    // <= : pass iff U ≤ T; fail iff L > T
    ["<=800ms", "pass"], // U=800 ≤ 800 (contrast with "<800ms" above)
    ["<=793ms", "fail"], // L≈793.7 > 793
    ["<=795ms", "borderline"], // L ≤ 795 < U
    // >  : pass iff L > T; fail iff U ≤ T
    [">793ms", "pass"], // L≈793.7 > 793
    [">800ms", "fail"], // U=800 not > 800
    [">795ms", "borderline"], // L ≤ 795 but U > 795
    // >= : pass iff L ≥ T; fail iff U < T
    [">=793ms", "pass"], // L≈793.7 ≥ 793
    [">=801ms", "fail"], // U=800 < 801
    [">=794ms", "borderline"], // L < 794 ≤ U
  ];
  for (const [expr, want] of matrix) {
    it(`decides "${expr}" as ${want}`, () => {
      const { row, pass } = evalP95(expr);
      if (want === "borderline") {
        expect(row).toMatchObject({
          status: "unevaluable",
          reason: "borderline-quantile",
          pass: false, // the iron rule: unevaluable is NEVER green
        });
        expect(pass).toBe(false);
      } else {
        expect(row).toMatchObject({ status: "evaluated", pass: want === "pass" });
        expect(pass).toBe(want === "pass");
      }
      // Every histogram-decided row records the interval it was decided on.
      expect(row.quantileBounds).toEqual({ lower: b.lower, upper: b.upper });
      // `actual` is the canonical point estimate (interval upper), matching summary.latency.
      expect(row.actual).toBe(b.upper);
    });
  }
});

describe("histogram direct evaluation replaces max-of-rows (D0-T5)", () => {
  const mkRow = (phase: "primary" | "continuation", p95: number, requestCount: number) => ({
    routeKey: "GET /status",
    phase,
    routeKeySource: "normalized-url",
    routeKeyHeuristic: true,
    requestCount,
    errorCount: 0,
    errorRate: 0,
    statusCounts: { "200": requestCount },
    latency: { p50: p95 / 2, p90: p95 - 1, p95, p99: p95 + 5, max: p95 + 10 },
    throughputPerSec: requestCount / 60,
  });

  it("a tiny slow phase no longer false-fails the scope quantile (the D0-T5 fix)", () => {
    // 990 fast primary requests (10ms) + 10 slow continuation requests (900ms): the
    // TRUE merged p95 sits in the 10ms bucket (rank 950 of 1000 ≤ 990 fast samples).
    // Old max-of-rows synthesis read the continuation ROW's own p95 (900ms) and
    // failed a "<800ms" gate — a false breach from 1% of the traffic.
    const art = artifactStub({
      endpoints: [mkRow("primary", 10, 990), mkRow("continuation", 900, 10)] as unknown as LoadArtifact["endpoints"],
    });
    const merged = histOf([...Array<number>(990).fill(10), ...Array<number>(10).fill(900)]);
    const gates: LoadThresholds = { endpoints: { "GET /status": { p95: "<800ms" } } };

    // New histogram path: clear pass on the merged distribution.
    const withHist = evaluateThresholds(art, gates, { endpoint: (rk) => (rk === "GET /status" ? merged : undefined) });
    expect(withHist.thresholds[0]).toMatchObject({ scope: "endpoint", metric: "p95", pass: true, status: "evaluated" });
    expect(withHist.thresholds[0].actual).toBeLessThan(20); // merged p95 ≈ 10ms, not 900
    expect(withHist.pass).toBe(true);

    // Same artifact WITHOUT a source: the conservative fallback still max-of-rows
    // fails — documents exactly the false breach the histogram path removes.
    const without = evaluateThresholds(art, gates);
    expect(without.thresholds[0]).toMatchObject({ actual: 900, pass: false, status: "evaluated" });
    expect(without.pass).toBe(false);
  });

  it("keeps errorRate weighting and throughput summing from the phase rows (unchanged)", () => {
    // The histogram source must NOT change the count-ratio metrics: errorRate stays
    // request-weighted across rows, throughput stays additive.
    const rows = [
      { ...mkRow("primary", 10, 900), errorCount: 0, errorRate: 0, throughputPerSec: 60 },
      { ...mkRow("continuation", 900, 100), errorCount: 50, errorRate: 0.5, throughputPerSec: 60 },
    ];
    const art = artifactStub({ endpoints: rows as unknown as LoadArtifact["endpoints"] });
    const merged = histOf([...Array<number>(900).fill(10), ...Array<number>(100).fill(900)]);
    const { thresholds: evals } = evaluateThresholds(
      art,
      { endpoints: { "GET /status": { errorRate: "<1%", throughputPerSec: ">100/s" } } },
      { endpoint: () => merged },
    );
    expect(evals.find((e) => e.metric === "errorRate")).toMatchObject({
      actual: 0.05, // (0·900 + 0.5·100) / 1000 — weighted, not max/avg of rates
      pass: false,
      status: "evaluated",
    });
    expect(evals.find((e) => e.metric === "throughputPerSec")).toMatchObject({
      actual: 120, // 60 + 60 — additive
      pass: true,
      status: "evaluated",
    });
  });
});

describe("zero observations → unevaluable (D0-T5)", () => {
  it("a 0-iteration run cannot pass transaction quantile/errorRate gates as 0", () => {
    // An empty run reports ZERO_PCT latency and 0/0→0 errorRate — evaluating those
    // as measurements would false-green the `<` gates below (the pre-D0-T5 behavior).
    const art = artifactStub({
      totalIterations: 0,
      errorRate: 0,
      throughputPerSec: 0,
      latency: { p50: 0, p90: 0, p95: 0, p99: 0, max: 0 },
    });
    const { thresholds: evals, pass } = evaluateThresholds(art, {
      transaction: { errorRate: "<1%", p95: "<800ms", throughputPerSec: ">100/s" },
    });
    expect(evals.find((e) => e.metric === "p95")).toMatchObject({
      status: "unevaluable",
      reason: "no-observations",
      pass: false,
    });
    expect(evals.find((e) => e.metric === "errorRate")).toMatchObject({
      status: "unevaluable",
      reason: "no-observations",
      pass: false,
    });
    // Throughput 0 over the run duration IS a measurement (the system did nothing):
    // the `>100/s` floor fails on it as a real verdict, not as unevaluable.
    expect(evals.find((e) => e.metric === "throughputPerSec")).toMatchObject({
      status: "evaluated",
      actual: 0,
      pass: false,
    });
    expect(pass).toBe(false);
  });

  it("an all-skipped step (0 executed invocations) is unevaluable, not 0% errors", () => {
    const step = {
      scenarioId: "s",
      stepId: "0:checkout",
      stepName: "checkout",
      phase: "primary",
      invocationCount: 2,
      skippedCount: 2, // every invocation skipped → 0 executed → 0/0 errorRate, ZERO_PCT latency
      assertionFailureCount: 0,
      errorCount: 0,
      errorRate: 0,
      latency: { p50: 0, p90: 0, p95: 0, p99: 0, max: 0 },
      requestCount: 0,
    };
    const art = artifactStub({ steps: [step] as unknown as LoadArtifact["steps"] });
    const { thresholds: evals, pass } = evaluateThresholds(art, {
      steps: { "0:checkout": { errorRate: "<1%", p95: "<800ms" } },
    });
    expect(evals).toHaveLength(2);
    for (const e of evals) {
      expect(e).toMatchObject({ status: "unevaluable", reason: "no-observations", pass: false });
    }
    expect(pass).toBe(false);
  });

  it("a present-but-empty custom-metric series is unevaluable for rate/quantiles, evaluated for count/sum", () => {
    // Count-0 series shapes a D1 pinned-key placeholder / adapter artifact would carry:
    // rate 0/0→0 and trend ZERO_PCT are NOT measurements; count/sum 0 ARE (additive facts).
    const art = artifactStub({
      customMetrics: [
        { metricId: "pollOk", kind: "rate", series: [{ tags: {}, count: 0, trueCount: 0, rate: 0 }] },
        { metricId: "settleMs", kind: "trend", unit: "ms", series: [{ tags: {}, count: 0, latency: { p50: 0, p90: 0, p95: 0, p99: 0, max: 0 } }] },
        { metricId: "retries", kind: "counter", series: [{ tags: {}, count: 0, sum: 0 }] },
      ] as unknown as LoadArtifact["summary"]["customMetrics"],
    });
    const { thresholds: evals, pass } = evaluateThresholds(art, {
      customMetric: {
        pollOk: { rate: ">99%" },
        settleMs: { p95: "<100ms" },
        retries: { sum: "<100", count: ">10" },
      },
    });
    expect(evals.find((e) => e.target === "pollOk")).toMatchObject({
      status: "unevaluable",
      reason: "no-observations",
      pass: false, // 0/0 must not decide a ">99%" floor either way
    });
    expect(evals.find((e) => e.target === "settleMs")).toMatchObject({
      status: "unevaluable",
      reason: "no-observations",
      pass: false, // ZERO_PCT would have false-passed "<100ms"
    });
    // Additive facts on an empty series stay real verdicts:
    expect(evals.find((e) => e.target === "retries" && e.metric === "sum")).toMatchObject({
      status: "evaluated",
      actual: 0,
      pass: true, // sum 0 really is < 100
    });
    expect(evals.find((e) => e.target === "retries" && e.metric === "count")).toMatchObject({
      status: "evaluated",
      actual: 0,
      pass: false, // count 0 really is not > 10
    });
    expect(pass).toBe(false);
  });

  it("reads a v2 artifact row's own `complete: false` when no quantile source is supplied", () => {
    // Reading a SERIALIZED / imported v2 artifact (no reducer behind it, so no
    // ThresholdQuantileSource): a merged run stamped `complete: false` on the row
    // (§7.3 — a series-cap-truncated worker folded this key into its total invisibly),
    // and the retained count/sum UNDERCOUNT. Without the artifact-row fallback the gate
    // false-passed (codex integration R). The tagged v0 row is complete → evaluates.
    const art = artifactStub({
      customMetrics: [
        {
          metricId: "bytes",
          kind: "counter",
          series: [
            { tags: {}, count: 10, sum: 5000 }, // untagged total (always exact)
            { tags: { k: "v60" }, count: 3, sum: 40, complete: false }, // undercounts
            { tags: { k: "v0" }, count: 4, sum: 80 }, // complete (field absent)
          ],
        },
      ] as unknown as LoadArtifact["summary"]["customMetrics"],
    });
    // No quantiles argument at all — the serialized-artifact read path.
    const { thresholds: evals, pass } = evaluateThresholds(art, {
      customMetric: {
        "bytes:k=v60": { sum: "<1000" }, // would false-pass on the undercounting 40
        "bytes:k=v0": { sum: "<1000" }, // complete → real verdict
      },
    });
    expect(evals.find((e) => e.target === "bytes:k=v60")).toMatchObject({
      status: "unevaluable",
      reason: "series-incomplete",
      pass: false,
    });
    expect(evals.find((e) => e.target === "bytes:k=v0")).toMatchObject({
      status: "evaluated",
      pass: true,
    });
    expect(pass).toBe(false);
  });

  it("downgrades every gate to partial-input when opts.partialInput is set (§7.4)", () => {
    // A distributed merged run whose executionStatus is not "complete": every gate is
    // decided on incomplete/placeholder data, so none carries a trustworthy verdict.
    const art = artifactStub({ errorRate: 0, latency: { p50: 5, p90: 8, p95: 10, p99: 12, max: 15 } });
    const gates = { transaction: { errorRate: "<1%", p95: "<800ms" } };
    // Baseline: without partialInput both gates evaluate and pass.
    const baseline = evaluateThresholds(art, gates);
    expect(baseline.thresholds.every((e) => e.status === "evaluated" && e.pass)).toBe(true);
    expect(baseline.pass).toBe(true);
    // With partialInput: every gate unevaluable/partial-input/pass:false, run fails.
    const { thresholds: evals, pass } = evaluateThresholds(art, gates, undefined, { partialInput: true });
    expect(evals).toHaveLength(2);
    expect(evals.every((e) => e.status === "unevaluable" && e.reason === "partial-input" && !e.pass)).toBe(true);
    // Context is preserved (expression / actual), only the verdict is neutralized.
    expect(evals.find((e) => e.metric === "p95")?.expression).toBe("<800ms");
    expect(pass).toBe(false);
  });

  it("partial-input leaves a more-specific unevaluable reason intact", () => {
    // A row already unevaluable (no-observations) keeps its sharper diagnosis rather
    // than being rewritten to the blanket partial-input reason — it already carries
    // pass:false, so the run still fails.
    const art = artifactStub({
      totalIterations: 0,
      customMetrics: [
        { metricId: "pollOk", kind: "rate", series: [{ tags: {}, count: 0, trueCount: 0, rate: 0 }] },
      ] as unknown as LoadArtifact["summary"]["customMetrics"],
    });
    const { thresholds: evals, pass } = evaluateThresholds(
      art,
      { transaction: { errorRate: "<1%" }, customMetric: { pollOk: { rate: ">99%" } } },
      undefined,
      { partialInput: true },
    );
    // transaction errorRate: zero-observation → no-observations (kept); the count gate
    // for transaction has none here. pollOk: no-observations (kept).
    expect(evals.find((e) => e.scope === "transaction")).toMatchObject({ reason: "no-observations" });
    expect(evals.find((e) => e.target === "pollOk")).toMatchObject({ reason: "no-observations" });
    // A plain evaluated-would-be gate on a non-empty scope IS downgraded to partial-input.
    expect(pass).toBe(false);
  });

  it("keeps the absent-scope SKIP policy (no rows at all ≠ an empty present scope)", () => {
    // Unchanged policy (module doc): a scope whose data isn't present at all —
    // no phase split, no matching endpoint row — is skipped, not failed. D1's
    // coverage reasons (feeder-gap / under-driven) take over from there.
    const art = artifactStub({});
    const { thresholds: evals, pass } = evaluateThresholds(
      art,
      { primary: { p95: "<800ms" }, endpoints: { "GET /missing": { p95: "<1ms" } } },
      { endpoint: () => undefined },
    );
    expect(evals).toHaveLength(0);
    expect(pass).toBe(true);
  });
});

describe("unevaluable invariants (D0-T5)", () => {
  it("every unevaluable row carries pass:false + a reason, and fails the run", () => {
    // One evaluation producing BOTH unevaluable reasons at once: a borderline
    // transaction quantile and a no-observations step gate.
    const hist = histOf(Array(100).fill(800));
    const step = {
      scenarioId: "s", stepId: "st", stepName: "st", phase: "primary",
      invocationCount: 0, skippedCount: 0, assertionFailureCount: 0, errorCount: 0,
      errorRate: 0, latency: { p50: 0, p90: 0, p95: 0, p99: 0, max: 0 }, requestCount: 0,
    };
    const art = artifactStub({ steps: [step] as unknown as LoadArtifact["steps"] });
    const { thresholds: evals, pass } = evaluateThresholds(
      art,
      { transaction: { p95: "<800ms" }, steps: { st: { p95: "<10ms" } } },
      { transaction: hist },
    );
    const unevaluable = evals.filter((e) => e.status === "unevaluable");
    expect(unevaluable.map((e) => e.reason).sort()).toEqual(["borderline-quantile", "no-observations"]);
    for (const e of unevaluable) {
      expect(e.pass).toBe(false); // §11.1 iron rule: old `t.pass === false` consumers show breached, never green
      expect(typeof e.reason).toBe("string");
    }
    expect(pass).toBe(false);
  });
});

describe("custom trend quantile gates use interval evaluation (codex R1)", () => {
  // Same 800ms-bucket shape as the latency-scope matrix above: interval ≈ [793.7, 800].
  const hist = histOf(Array(100).fill(800));
  const b = hist.percentileBounds().p95;
  const pct800 = { p50: 800, p90: 800, p95: 800, p99: 800, max: 800 };
  const art = artifactStub({
    customMetrics: [
      {
        metricId: "settleMs",
        kind: "trend",
        unit: "ms",
        series: [
          { tags: {}, count: 100, latency: pct800 },
          { tags: { class: "fast" }, count: 100, latency: pct800 },
        ],
      },
    ] as unknown as LoadArtifact["summary"]["customMetrics"],
  });
  const source = {
    custom: (id: string, _tags: Record<string, string>) => (id === "settleMs" ? hist : undefined),
  };

  it("a `>` gate inside the interval is borderline-unevaluable, not a point false-pass", () => {
    // The codex R1 scenario: the point path compares actual=800 (the interval UPPER)
    // against >794 and passes, but the true p95 lies anywhere in [793.7, 800] — the
    // threshold cuts through the interval, so no verdict is supportable.
    const gates = { customMetric: { settleMs: { p95: ">794ms" } } };
    const { thresholds: evals, pass } = evaluateThresholds(art, gates, source);
    expect(evals[0]).toMatchObject({
      scope: "customMetric",
      target: "settleMs",
      metric: "p95",
      status: "unevaluable",
      reason: "borderline-quantile",
      pass: false,
    });
    expect(evals[0].quantileBounds).toEqual({ lower: b.lower, upper: b.upper });
    expect(pass).toBe(false);
    // Without a source the point fallback still passes (it has no interval to see) —
    // documents exactly the false pass the histogram path removes.
    const fallback = evaluateThresholds(art, gates);
    expect(fallback.thresholds[0]).toMatchObject({ status: "evaluated", pass: true, actual: 800 });
  });

  it("a tagged series target is decided on ITS OWN histogram, not the total's", () => {
    const tagged = histOf(Array(50).fill(100)); // tagged distribution ≈ 100ms
    const src = {
      custom: (id: string, tags: Record<string, string>) =>
        id === "settleMs" ? (tags.class === "fast" ? tagged : hist) : undefined,
    };
    const { thresholds: evals, pass } = evaluateThresholds(
      art,
      { customMetric: { "settleMs:class=fast": { p95: "<200ms" } } },
      src,
    );
    // The total histogram (800ms bucket) would clean-FAIL "<200ms"; the tagged one
    // (≈100ms) clean-passes — proves the tag routing reached the right series.
    expect(evals[0]).toMatchObject({
      target: "settleMs:class=fast",
      metric: "p95",
      status: "evaluated",
      pass: true,
    });
    expect(evals[0].actual).toBeLessThan(200);
    expect(pass).toBe(true);
  });

  it("`<` direction control: a threshold above the interval upper is a clean pass", () => {
    const { thresholds: evals, pass } = evaluateThresholds(
      art,
      { customMetric: { settleMs: { p95: "<801ms" } } },
      source,
    );
    expect(evals[0]).toMatchObject({ status: "evaluated", pass: true });
    expect(evals[0].quantileBounds).toEqual({ lower: b.lower, upper: b.upper });
    expect(pass).toBe(true);
  });
});
