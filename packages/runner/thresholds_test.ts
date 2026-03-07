import { assertEquals } from "@std/assert";
import { aggregate, evaluateThresholds, MetricCollector, parseExpression } from "./thresholds.ts";

// ── parseExpression ──────────────────────────────────────────────────────────

Deno.test("parseExpression - parses '<200'", () => {
  const result = parseExpression("<200");
  assertEquals(result, { operator: "<", value: 200 });
});

Deno.test("parseExpression - parses '<=500'", () => {
  const result = parseExpression("<=500");
  assertEquals(result, { operator: "<=", value: 500 });
});

Deno.test("parseExpression - parses '<0.01'", () => {
  const result = parseExpression("<0.01");
  assertEquals(result, { operator: "<", value: 0.01 });
});

Deno.test("parseExpression - returns null for invalid", () => {
  assertEquals(parseExpression(">200"), null);
  assertEquals(parseExpression("abc"), null);
  assertEquals(parseExpression(""), null);
});

// ── aggregate ────────────────────────────────────────────────────────────────

Deno.test("aggregate - avg", () => {
  assertEquals(aggregate([10, 20, 30], "avg"), 20);
});

Deno.test("aggregate - min/max", () => {
  assertEquals(aggregate([10, 20, 30], "min"), 10);
  assertEquals(aggregate([10, 20, 30], "max"), 30);
});

Deno.test("aggregate - count", () => {
  assertEquals(aggregate([10, 20, 30], "count"), 3);
});

Deno.test("aggregate - p95 with 100 values", () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1);
  const result = aggregate(values, "p95");
  assertEquals(result, 95);
});

Deno.test("aggregate - p50", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const result = aggregate(values, "p50");
  assertEquals(result, 5);
});

Deno.test("aggregate - empty array returns 0", () => {
  assertEquals(aggregate([], "avg"), 0);
  assertEquals(aggregate([], "p95"), 0);
});

// ── MetricCollector ──────────────────────────────────────────────────────────

Deno.test("MetricCollector - collects and retrieves values", () => {
  const c = new MetricCollector();
  c.add("latency", 100);
  c.add("latency", 200);
  c.add("errors", 1);
  assertEquals(c.getValues("latency"), [100, 200]);
  assertEquals(c.getValues("errors"), [1]);
  assertEquals(c.getValues("unknown"), []);
  assertEquals(c.getNames().sort(), ["errors", "latency"]);
});

// ── evaluateThresholds ───────────────────────────────────────────────────────

Deno.test("evaluateThresholds - all pass", () => {
  const c = new MetricCollector();
  for (const v of [50, 100, 150]) c.add("http_duration_ms", v);

  const result = evaluateThresholds(
    { http_duration_ms: { avg: "<200", max: "<500" } },
    c,
  );

  assertEquals(result.pass, true);
  assertEquals(result.results.length, 2);
  assertEquals(result.results[0].pass, true);
  assertEquals(result.results[1].pass, true);
});

Deno.test("evaluateThresholds - threshold violated", () => {
  const c = new MetricCollector();
  for (const v of [100, 200, 300, 400, 500]) c.add("latency", v);

  const result = evaluateThresholds(
    { latency: { avg: "<200" } },
    c,
  );

  assertEquals(result.pass, false);
  assertEquals(result.results[0].pass, false);
  assertEquals(result.results[0].actual, 300);
});

Deno.test("evaluateThresholds - shorthand string expands to avg", () => {
  const c = new MetricCollector();
  c.add("error_rate", 0.005);

  const result = evaluateThresholds(
    { error_rate: "<0.01" },
    c,
  );

  assertEquals(result.pass, true);
  assertEquals(result.results[0].aggregation, "avg");
});

Deno.test("evaluateThresholds - no data for metric is a pass", () => {
  const c = new MetricCollector();

  const result = evaluateThresholds(
    { missing_metric: { avg: "<100" } },
    c,
  );

  assertEquals(result.pass, true);
  assertEquals(result.results[0].pass, true);
});

Deno.test("evaluateThresholds - invalid expression is a fail", () => {
  const c = new MetricCollector();
  c.add("latency", 100);

  const result = evaluateThresholds(
    { latency: { avg: ">200" } },
    c,
  );

  assertEquals(result.pass, false);
  assertEquals(result.results[0].pass, false);
});

Deno.test("evaluateThresholds - <= operator", () => {
  const c = new MetricCollector();
  c.add("latency", 200);

  const pass = evaluateThresholds({ latency: { max: "<=200" } }, c);
  assertEquals(pass.pass, true);

  const fail = evaluateThresholds({ latency: { max: "<200" } }, c);
  assertEquals(fail.pass, false);
});

Deno.test("evaluateThresholds - multiple metrics", () => {
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

  assertEquals(result.pass, true);
  assertEquals(result.results.length, 3);
});
