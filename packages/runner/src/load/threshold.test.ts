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

  it("skips thresholds whose scope data is absent or metric is N/A", () => {
    const art = artifactStub({});
    const { thresholds: evals, pass } = evaluateThresholds(art, {
      primary: { p95: "<800ms" }, // phase split not populated (M5) → skipped
      endpoints: { "GET /missing": { p95: "<1ms" } }, // no such endpoint → skipped
    });
    expect(evals).toHaveLength(0);
    expect(pass).toBe(true); // nothing evaluable, crash-free → pass
  });
});
