import { test, expect } from "vitest";
import { aggregate, evaluateThresholds, MetricCollector, parseExpression } from "./thresholds.js";

// ── parseExpression ──────────────────────────────────────────────────────────

test("parseExpression - parses '<200'", () => {
  expect(parseExpression("<200")).toEqual({ operator: "<", value: 200 });
});

test("parseExpression - parses '<=500'", () => {
  expect(parseExpression("<=500")).toEqual({ operator: "<=", value: 500 });
});

test("parseExpression - parses '<0.01'", () => {
  expect(parseExpression("<0.01")).toEqual({ operator: "<", value: 0.01 });
});

test("parseExpression - returns null for invalid", () => {
  expect(parseExpression(">200")).toBe(null);
  expect(parseExpression("abc")).toBe(null);
  expect(parseExpression("")).toBe(null);
});

// ── aggregate ────────────────────────────────────────────────────────────────

test("aggregate - avg", () => {
  expect(aggregate([10, 20, 30], "avg")).toBe(20);
});

test("aggregate - min/max", () => {
  expect(aggregate([10, 20, 30], "min")).toBe(10);
  expect(aggregate([10, 20, 30], "max")).toBe(30);
});

test("aggregate - count", () => {
  expect(aggregate([10, 20, 30], "count")).toBe(3);
});

test("aggregate - p95 with 100 values", () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1);
  expect(aggregate(values, "p95")).toBe(95);
});

test("aggregate - p50", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  expect(aggregate(values, "p50")).toBe(5);
});

test("aggregate - empty array returns 0", () => {
  expect(aggregate([], "avg")).toBe(0);
  expect(aggregate([], "p95")).toBe(0);
});

// ── MetricCollector ──────────────────────────────────────────────────────────

test("MetricCollector - collects and retrieves values", () => {
  const c = new MetricCollector();
  c.add("latency", 100);
  c.add("latency", 200);
  c.add("errors", 1);
  expect(c.getValues("latency")).toEqual([100, 200]);
  expect(c.getValues("errors")).toEqual([1]);
  expect(c.getValues("unknown")).toEqual([]);
  expect(c.getNames().sort()).toEqual(["errors", "latency"]);
});

// ── evaluateThresholds ───────────────────────────────────────────────────────

test("evaluateThresholds - all pass", () => {
  const c = new MetricCollector();
  for (const v of [50, 100, 150]) c.add("http_duration_ms", v);

  const result = evaluateThresholds(
    { http_duration_ms: { avg: "<200", max: "<500" } },
    c,
  );

  expect(result.pass).toBe(true);
  expect(result.results.length).toBe(2);
  expect(result.results[0].pass).toBe(true);
  expect(result.results[1].pass).toBe(true);
});

test("evaluateThresholds - threshold violated", () => {
  const c = new MetricCollector();
  for (const v of [100, 200, 300, 400, 500]) c.add("latency", v);

  const result = evaluateThresholds(
    { latency: { avg: "<200" } },
    c,
  );

  expect(result.pass).toBe(false);
  expect(result.results[0].pass).toBe(false);
  expect(result.results[0].actual).toBe(300);
});

test("evaluateThresholds - shorthand string expands to avg", () => {
  const c = new MetricCollector();
  c.add("error_rate", 0.005);

  const result = evaluateThresholds(
    { error_rate: "<0.01" },
    c,
  );

  expect(result.pass).toBe(true);
  expect(result.results[0].aggregation).toBe("avg");
});

test("evaluateThresholds - no data for metric is a pass", () => {
  const c = new MetricCollector();

  const result = evaluateThresholds(
    { missing_metric: { avg: "<100" } },
    c,
  );

  expect(result.pass).toBe(true);
  expect(result.results[0].pass).toBe(true);
});

test("evaluateThresholds - invalid expression is a fail", () => {
  const c = new MetricCollector();
  c.add("latency", 100);

  const result = evaluateThresholds(
    { latency: { avg: ">200" } },
    c,
  );

  expect(result.pass).toBe(false);
  expect(result.results[0].pass).toBe(false);
});

test("evaluateThresholds - <= operator", () => {
  const c = new MetricCollector();
  c.add("latency", 200);

  const pass = evaluateThresholds({ latency: { max: "<=200" } }, c);
  expect(pass.pass).toBe(true);

  const fail = evaluateThresholds({ latency: { max: "<200" } }, c);
  expect(fail.pass).toBe(false);
});

test("evaluateThresholds - multiple metrics", () => {
  const c = new MetricCollector();
  c.add("latency", 100);
  c.add("latency", 200);
  c.add("errors", 3);

  const result = evaluateThresholds(
    {
      latency: { avg: "<200", max: "<300" },
      errors: { max: "<5" },
    },
    c,
  );

  expect(result.pass).toBe(true);
  expect(result.results.length).toBe(3);
});
