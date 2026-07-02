import { describe, expect, it } from "vitest";
import type { LoadArtifact, LoadEvent, LoadThresholds } from "@glubean/sdk/load";
import { createLoadReducer } from "./reducer.js";
import { evaluateThresholds, validateLoadMetricsConfig } from "./threshold.js";

// ── reducer fold (A2) ──────────────────────────────────────────────────────

let seq = 0;
const T0 = 1_000_000;
function ev(ts: number, extra: Record<string, unknown>): LoadEvent {
  return { ts, seq: seq++, runId: "run1", runnerId: "stress", ...extra } as unknown as LoadEvent;
}

/** Minimal run wrapper so the reducer has a start/end around the metric events. */
function foldMetrics(events: Record<string, unknown>[]): LoadArtifact {
  const r = createLoadReducer();
  r.apply(ev(T0, { type: "load:start", config: { concurrency: 1 } }));
  let t = T0;
  for (const e of events) r.apply(ev((t += 1), e));
  r.apply(ev(t + 1, { type: "load:end", reason: "iterations" }));
  return r.finalize();
}

describe("custom metric fold (A2 reducer)", () => {
  it("folds a rate into the untagged total + per-tag series", () => {
    const art = foldMetrics([
      { type: "metric:observed", metricId: "pollOk", kind: "rate", value: 1, tags: { class: "fast" } },
      { type: "metric:observed", metricId: "pollOk", kind: "rate", value: 1, tags: { class: "fast" } },
      { type: "metric:observed", metricId: "pollOk", kind: "rate", value: 0, tags: { class: "extreme" } },
      { type: "metric:observed", metricId: "pollOk", kind: "rate", value: 1, tags: { class: "extreme" } },
    ]);
    const metric = art.summary.customMetrics?.find((m) => m.metricId === "pollOk");
    expect(metric?.kind).toBe("rate");

    const total = metric?.series.find((s) => Object.keys(s.tags).length === 0);
    expect(total).toMatchObject({ count: 4, trueCount: 3, rate: 0.75 });

    const extreme = metric?.series.find((s) => s.tags.class === "extreme");
    expect(extreme).toMatchObject({ count: 2, trueCount: 1, rate: 0.5 });
  });

  it("sums a counter (default +1 normalized upstream)", () => {
    const art = foldMetrics([
      { type: "metric:observed", metricId: "retries", kind: "counter", value: 1 },
      { type: "metric:observed", metricId: "retries", kind: "counter", value: 3 },
    ]);
    const total = art.summary.customMetrics
      ?.find((m) => m.metricId === "retries")
      ?.series.find((s) => Object.keys(s.tags).length === 0);
    expect(total).toMatchObject({ count: 2, sum: 4 });
  });

  it("builds a distribution + percentiles for a trend, with the unit", () => {
    const art = foldMetrics(
      [50, 100, 150, 200].map((v) => ({
        type: "metric:observed",
        metricId: "e2e",
        kind: "trend",
        value: v,
        unit: "ms",
      })),
    );
    const metric = art.summary.customMetrics?.find((m) => m.metricId === "e2e");
    expect(metric?.unit).toBe("ms");
    const total = metric?.series.find((s) => Object.keys(s.tags).length === 0);
    expect(total?.count).toBe(4);
    expect(total?.latency?.p50).toBeGreaterThan(0);
    expect((total?.distribution?.length ?? 0)).toBeGreaterThan(0);
  });

  it("caps tag-series at the maxSeries limit, folding overflow into the total + advisory", () => {
    // 60 distinct tag values for a rate → 50 series kept, overflow only in the total.
    const events = Array.from({ length: 60 }, (_, i) => ({
      type: "metric:observed",
      metricId: "perItem",
      kind: "rate",
      value: 1,
      tags: { itemId: `i${i}` },
    }));
    const art = foldMetrics(events);
    const metric = art.summary.customMetrics?.find((m) => m.metricId === "perItem");
    expect(metric?.seriesTruncated).toBe(true);
    // 1 untagged total + 50 capped tag-series.
    expect(metric?.series.length).toBe(51);
    const total = metric?.series.find((s) => Object.keys(s.tags).length === 0);
    expect(total?.count).toBe(60); // every observation still counted in the total
    expect(art.summary.advisories?.some((a) => a.includes("perItem"))).toBe(true);
  });

  it("omits customMetrics entirely when none were observed", () => {
    const art = foldMetrics([]);
    expect(art.summary.customMetrics).toBeUndefined();
  });
});

// ── threshold evaluation (A2) ───────────────────────────────────────────────

function artifactWithCustomMetrics(customMetrics: LoadArtifact["summary"]["customMetrics"]): LoadArtifact {
  return {
    summary: {
      pass: true,
      totalIterations: 100,
      successfulIterations: 100,
      failedIterations: 0,
      errorRate: 0,
      throughputPerSec: 200,
      latency: { p50: 10, p90: 20, p95: 30, p99: 40, max: 50 },
      thresholds: [],
      customMetrics,
    },
    endpoints: [],
    steps: [],
  } as unknown as LoadArtifact;
}

describe("customMetric thresholds (A2)", () => {
  const pollOk = artifactWithCustomMetrics([
    {
      metricId: "pollOk",
      kind: "rate",
      series: [
        { tags: {}, count: 100, trueCount: 98, rate: 0.98 },
        { tags: { class: "extreme" }, count: 20, trueCount: 17, rate: 0.85 },
      ],
    },
  ]);

  it("gates the untagged total and a per-series target", () => {
    const thresholds: LoadThresholds = {
      customMetric: {
        pollOk: { rate: ">99%" }, // total 0.98 → fail
        "pollOk:class=extreme": { rate: ">90%" }, // 0.85 → fail
      },
    };
    const { thresholds: rows, pass } = evaluateThresholds(pollOk, thresholds);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.scope === "customMetric")).toBe(true);
    expect(rows.find((r) => r.target === "pollOk")?.pass).toBe(false);
    expect(rows.find((r) => r.target === "pollOk:class=extreme")?.pass).toBe(false);
    expect(pass).toBe(false);
  });

  it("passes when the gate holds", () => {
    const { pass } = evaluateThresholds(pollOk, { customMetric: { pollOk: { rate: ">90%" } } });
    expect(pass).toBe(true);
  });

  it("skips a metric/series that was never observed (not a failure)", () => {
    const { thresholds: rows, pass } = evaluateThresholds(pollOk, {
      customMetric: {
        missing: { rate: ">99%" },
        "pollOk:class=ghost": { rate: ">99%" },
      },
    });
    expect(rows).toHaveLength(0);
    expect(pass).toBe(true);
  });

  it("skips a key that is N/A to the metric's kind (sum on a rate) — with an advisory", () => {
    const { thresholds: rows, advisories } = evaluateThresholds(pollOk, {
      customMetric: { pollOk: { sum: ">10" } },
    });
    expect(rows).toHaveLength(0);
    expect(advisories.some((a) => a.includes('"pollOk".sum') && a.includes('"rate"'))).toBe(true);
  });

  it("surfaces a typo'd gate key on the evaluator-only path (adapter artifact)", () => {
    const { thresholds: rows, advisories } = evaluateThresholds(pollOk, {
      customMetric: { pollOk: { p85: "<800ms" } as Record<string, string> },
    });
    expect(rows).toHaveLength(0);
    expect(advisories.some((a) => a.includes('"pollOk".p85') && a.includes("unknown gate key"))).toBe(true);
  });

  it("gates a metric whose ID itself contains a colon (exact id wins over tag-split)", () => {
    const art = artifactWithCustomMetrics([
      { metricId: "http:ok", kind: "rate", series: [{ tags: {}, count: 100, trueCount: 90, rate: 0.9 }] },
    ]);
    const { thresholds: rows, pass } = evaluateThresholds(art, {
      customMetric: { "http:ok": { rate: ">99%" } }, // 0.9 → fail (not silently skipped)
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: "customMetric", target: "http:ok", metric: "rate", pass: false });
    expect(pass).toBe(false);
  });

  it("skips a malformed per-series target instead of matching the total", () => {
    // `pollOk:class` (no `=`) and `pollOk:` must NOT collapse onto the untagged total.
    const { thresholds: rows, pass } = evaluateThresholds(pollOk, {
      customMetric: {
        "pollOk:class": { rate: ">99%" },
        "pollOk:": { rate: ">99%" },
      },
    });
    expect(rows).toHaveLength(0);
    expect(pass).toBe(true);
  });

  it("surfaces every skipped gate as an advisory (metric absent / series absent)", () => {
    const { thresholds: rows, pass, advisories } = evaluateThresholds(pollOk, {
      customMetric: {
        missing: { rate: ">99%" },
        "pollOk:class=ghost": { rate: ">99%" },
      },
    });
    expect(rows).toHaveLength(0);
    expect(pass).toBe(true); // skip-on-absent policy holds…
    // …but neither skip is silent.
    expect(advisories.some((a) => a.includes('"missing"') && a.includes("never recorded"))).toBe(true);
    expect(advisories.some((a) => a.includes('"pollOk:class=ghost"'))).toBe(true);
    // An evaluated gate produces no advisory.
    expect(evaluateThresholds(pollOk, { customMetric: { pollOk: { rate: ">90%" } } }).advisories).toEqual([]);
  });

  it("calls out maxSeries truncation when a per-series gate finds no folded series", () => {
    const truncated = artifactWithCustomMetrics([
      {
        metricId: "perItem",
        kind: "rate",
        seriesTruncated: true,
        series: [{ tags: {}, count: 60, trueCount: 60, rate: 1 }],
      },
    ]);
    const { advisories } = evaluateThresholds(truncated, {
      customMetric: { "perItem:itemId=i59": { rate: ">99%" } },
    });
    expect(advisories.some((a) => a.includes("maxSeries"))).toBe(true);
  });

  it("gates a non-ms trend in its own unit: bare numbers ok, ms/s suffix rejected", () => {
    const bytes = artifactWithCustomMetrics([
      {
        metricId: "payload",
        kind: "trend",
        unit: "bytes",
        series: [{ tags: {}, count: 10, latency: { p50: 512, p90: 900, p95: 1200, p99: 4000, max: 5000 } }],
      },
    ]);
    // Bare number = the metric's own unit (bytes), no ms scaling.
    const { thresholds: rows } = evaluateThresholds(bytes, {
      customMetric: { payload: { p95: "<4096" } },
    });
    expect(rows[0]).toMatchObject({ metric: "p95", actual: 1200, pass: true });
    // An `s` suffix would ×1000 a byte count — rejected, not silently scaled.
    expect(() => evaluateThresholds(bytes, { customMetric: { payload: { p95: "<2s" } } })).toThrow(/unit/);
    expect(() => evaluateThresholds(bytes, { customMetric: { payload: { p95: "<800ms" } } })).toThrow(/unit/);
    // A declared-"ms" trend keeps the duration sugar.
    const ms = artifactWithCustomMetrics([
      {
        metricId: "e2e",
        kind: "trend",
        unit: "ms",
        series: [{ tags: {}, count: 10, latency: { p50: 100, p90: 400, p95: 1500, p99: 1900, max: 2000 } }],
      },
    ]);
    const evald = evaluateThresholds(ms, { customMetric: { e2e: { p95: "<2s" } } });
    expect(evald.thresholds[0]).toMatchObject({ actual: 1500, pass: true });
  });
});

// ── reducer fold defenses (codex R1) ────────────────────────────────────────

describe("custom metric fold defenses", () => {
  it("drops non-finite event values at the fold point (adapter path)", () => {
    const art = foldMetrics([
      { type: "metric:observed", metricId: "pollOk", kind: "rate", value: Number.NaN },
      { type: "metric:observed", metricId: "pollOk", kind: "rate", value: Number.POSITIVE_INFINITY },
      { type: "metric:observed", metricId: "pollOk", kind: "rate", value: 1 },
      { type: "metric:observed", metricId: "retries", kind: "counter", value: Number.NaN },
    ]);
    const total = art.summary.customMetrics
      ?.find((m) => m.metricId === "pollOk")
      ?.series.find((s) => Object.keys(s.tags).length === 0);
    expect(total).toMatchObject({ count: 1, trueCount: 1, rate: 1 }); // NaN/Infinity never counted as true
    // A metric whose ONLY samples were invalid is absent, not a zero-shaped row.
    expect(art.summary.customMetrics?.some((m) => m.metricId === "retries")).toBe(false);
  });

  it("drops an out-of-union kind instead of folding a schema-invalid row", () => {
    const art = foldMetrics([
      { type: "metric:observed", metricId: "weird", kind: "gauge", value: 5 },
    ]);
    expect(art.summary.customMetrics).toBeUndefined();
  });

  it("keeps tag combinations distinct when a value embeds the separator/`=`", () => {
    // Old joined-key form: {a:"1", b:"2"} and {a:"1\u0000b=2"} collided into one series.
    const art = foldMetrics([
      { type: "metric:observed", metricId: "m", kind: "counter", value: 1, tags: { a: "1", b: "2" } },
      { type: "metric:observed", metricId: "m", kind: "counter", value: 10, tags: { a: "1\u0000b=2" } },
    ]);
    const metric = art.summary.customMetrics?.find((m) => m.metricId === "m");
    expect(metric?.series).toHaveLength(3); // total + 2 DISTINCT tag series
    expect(metric?.series.find((s) => s.tags.b === "2")?.sum).toBe(1);
    expect(metric?.series.find((s) => s.tags.a === "1\u0000b=2")?.sum).toBe(10);
  });
});

// ── config validation (fail fast, codex R1) ─────────────────────────────────

describe("validateLoadMetricsConfig", () => {
  it("accepts a well-formed declaration + matching gates", () => {
    expect(
      validateLoadMetricsConfig(
        { pollOk: { kind: "rate" }, e2e: { kind: "trend", unit: "ms" }, "http:ok": { kind: "rate" } },
        { pollOk: {}, "pollOk:class=extreme": {}, "http:ok": {} },
      ),
    ).toEqual([]);
    expect(validateLoadMetricsConfig(undefined, undefined)).toEqual([]);
  });

  it("rejects an out-of-union kind and a non-string unit (untyped JS config)", () => {
    const errs = validateLoadMetricsConfig(
      {
        gaugeish: { kind: "gauge" },
        e2e: { kind: "trend", unit: 42 },
      },
      undefined,
    );
    expect(errs.some((e) => e.includes("gaugeish") && e.includes("rate / trend / counter"))).toBe(true);
    expect(errs.some((e) => e.includes("e2e") && e.includes("unit"))).toBe(true);
  });

  it("rejects a gate on an undeclared metric and a malformed tag selector", () => {
    const errs = validateLoadMetricsConfig(
      { pollOk: { kind: "rate" } },
      { missing: {}, "pollOk:class": {}, "pollOk:": {} },
    );
    expect(errs.some((e) => e.includes('"missing"') && e.includes("not declared"))).toBe(true);
    expect(errs.some((e) => e.includes('"pollOk:class"') && e.includes("malformed"))).toBe(true);
    expect(errs.some((e) => e.includes('"pollOk:"') && e.includes("malformed"))).toBe(true);
  });

  it("rejects gates when no metrics are declared at all", () => {
    const errs = validateLoadMetricsConfig(undefined, { pollOk: {} });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("not declared");
  });

  it("rejects gate keys that are N/A to the declared kind (and typo'd keys)", () => {
    const errs = validateLoadMetricsConfig(
      { pollOk: { kind: "rate" }, retries: { kind: "counter" }, e2e: { kind: "trend" } },
      {
        pollOk: { sum: ">10" }, // sum on a rate
        retries: { p95: "<800ms" }, // percentile on a counter
        e2e: { p85: "<800ms" }, // typo'd key
        "pollOk:class=extreme": { rate: ">90%" }, // valid per-series gate — no error
      },
    );
    expect(errs.some((e) => e.includes('"pollOk"].sum') && e.includes('"rate"'))).toBe(true);
    expect(errs.some((e) => e.includes('"retries"].p95') && e.includes('"counter"'))).toBe(true);
    expect(errs.some((e) => e.includes('"e2e"].p85'))).toBe(true);
    expect(errs).toHaveLength(3);
  });

  it("accepts every kind-compatible key", () => {
    expect(
      validateLoadMetricsConfig(
        { pollOk: { kind: "rate" }, retries: { kind: "counter" }, e2e: { kind: "trend", unit: "ms" } },
        {
          pollOk: { rate: ">99%", count: ">10" },
          retries: { sum: "<100", count: "<50" },
          e2e: { count: ">0", p50: "<100", p90: "<400", p95: "<800ms", p99: "<2s" },
        },
      ),
    ).toEqual([]);
  });
});
