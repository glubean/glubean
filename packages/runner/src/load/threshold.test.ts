import { describe, expect, it } from "vitest";

import type { LoadArtifact, LoadThresholds } from "@glubean/sdk/load";

import { evaluateThresholds, parseThresholdExpression } from "./threshold.js";

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
  errorRate?: number;
  throughputPerSec?: number;
  latency?: { p50: number; p90: number; p95: number; p99: number; max: number };
  endpoints?: LoadArtifact["endpoints"];
  steps?: LoadArtifact["steps"];
  primary?: LoadArtifact["summary"]["primary"];
  endToEnd?: LoadArtifact["summary"]["endToEnd"];
  continuation?: LoadArtifact["summary"]["continuation"];
}): LoadArtifact {
  const pct = over.latency ?? { p50: 10, p90: 20, p95: 30, p99: 40, max: 50 };
  return {
    summary: {
      pass: over.pass ?? true,
      totalIterations: 100,
      successfulIterations: 100,
      failedIterations: 0,
      errorRate: over.errorRate ?? 0,
      throughputPerSec: over.throughputPerSec ?? 200,
      latency: pct,
      ...(over.primary !== undefined ? { primary: over.primary } : {}),
      ...(over.endToEnd !== undefined ? { endToEnd: over.endToEnd } : {}),
      ...(over.continuation !== undefined ? { continuation: over.continuation } : {}),
      thresholds: [],
    },
    endpoints: over.endpoints ?? [],
    steps: over.steps ?? [],
  } as unknown as LoadArtifact;
}

describe("evaluateThresholds (M4-a)", () => {
  it("passes when transaction thresholds hold", () => {
    const art = artifactStub({ errorRate: 0.005, throughputPerSec: 250, latency: { p50: 10, p90: 20, p95: 700, p99: 900, max: 1000 } });
    const thresholds: LoadThresholds = {
      transaction: { errorRate: "<1%", p95: "<800ms", throughputPerSec: ">100/s" },
    };
    const { thresholds: evals, pass } = evaluateThresholds(art, thresholds);
    expect(pass).toBe(true);
    expect(evals).toHaveLength(3);
    expect(evals.every((e) => e.pass)).toBe(true);
    expect(evals.find((e) => e.metric === "errorRate")).toMatchObject({
      scope: "transaction",
      expression: "<1%",
      actual: 0.005,
      pass: true,
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

  it("combines an endpoint's phase rows for latency (slow continuation fails)", () => {
    // A fast primary row must not let a slow continuation row pass: combined p95 is
    // the max across phases.
    const art = artifactStub({
      endpoints: [mkEp("primary", 20, 25), mkEp("continuation", 900, 25)] as unknown as LoadArtifact["endpoints"],
    });
    const { thresholds: evals, pass } = evaluateThresholds(art, {
      endpoints: { "GET /status": { p95: "<800ms" } },
    });
    expect(evals).toHaveLength(1); // combined into one evaluation
    expect(evals[0]).toMatchObject({ scope: "endpoint", metric: "p95", actual: 900, pass: false });
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
