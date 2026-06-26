import { describe, expect, it } from "vitest";
import type { LoadArtifact, LoadEvent, LoadThresholds } from "@glubean/sdk/load";
import { createLoadReducer } from "./reducer.js";
import { evaluateThresholds } from "./threshold.js";

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

  it("skips a key that is N/A to the metric's kind (sum on a rate)", () => {
    const { thresholds: rows } = evaluateThresholds(pollOk, {
      customMetric: { pollOk: { sum: ">10" } },
    });
    expect(rows).toHaveLength(0);
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
});
