/**
 * Metric threshold evaluator.
 *
 * Collects metric data points during a run, then evaluates user-defined
 * thresholds against aggregated values (avg, min, max, percentiles, count).
 *
 * @module
 */

import type {
  MetricThresholdRules,
  ThresholdAggregation,
  ThresholdConfig,
  ThresholdExpression,
  ThresholdResult,
  ThresholdSummary,
} from "@glubean/sdk";

// ── Metric Collector ──────────────────────────────────────────────────────────

/**
 * Collects raw metric values during a run, grouped by metric name.
 * Call `add()` for each metric event, then `getValues()` to retrieve.
 */
export class MetricCollector {
  private data = new Map<string, number[]>();

  /** Record a single metric data point. */
  add(name: string, value: number): void {
    const arr = this.data.get(name);
    if (arr) {
      arr.push(value);
    } else {
      this.data.set(name, [value]);
    }
  }

  /** Get all recorded values for a metric (empty array if none). */
  getValues(name: string): number[] {
    return this.data.get(name) ?? [];
  }

  /** Get all metric names that have data. */
  getNames(): string[] {
    return [...this.data.keys()];
  }
}

// ── Aggregation ───────────────────────────────────────────────────────────────

/** Compute a percentile from a sorted array (nearest-rank method). */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/** Compute an aggregation over a set of values. */
export function aggregate(
  values: number[],
  agg: ThresholdAggregation,
): number {
  if (values.length === 0) return 0;

  switch (agg) {
    case "count":
      return values.length;
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "p50":
    case "p90":
    case "p95":
    case "p99": {
      const sorted = [...values].sort((a, b) => a - b);
      const p = parseInt(agg.slice(1), 10);
      return percentile(sorted, p);
    }
  }
}

// ── Expression Parsing ────────────────────────────────────────────────────────

interface ParsedExpression {
  operator: "<" | "<=";
  value: number;
}

/** Parse a threshold expression like "<200" or "<=500". */
export function parseExpression(expr: ThresholdExpression): ParsedExpression | null {
  const match = expr.match(/^(<=?)\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return {
    operator: match[1] as "<" | "<=",
    value: parseFloat(match[2]),
  };
}

/** Evaluate whether an actual value passes a threshold expression. */
function passes(actual: number, expr: ParsedExpression): boolean {
  return expr.operator === "<" ? actual < expr.value : actual <= expr.value;
}

// ── Threshold Evaluation ──────────────────────────────────────────────────────

/** Normalize shorthand string to full rules object. */
function normalizeRules(
  input: MetricThresholdRules | ThresholdExpression,
): MetricThresholdRules {
  if (typeof input === "string") {
    return { avg: input };
  }
  return input;
}

const VALID_AGGREGATIONS = new Set<ThresholdAggregation>([
  "avg",
  "min",
  "max",
  "p50",
  "p90",
  "p95",
  "p99",
  "count",
]);

/**
 * Evaluate all thresholds against collected metric data.
 *
 * @param config - User-defined threshold configuration
 * @param collector - MetricCollector with recorded data points
 * @returns Summary with individual results and overall pass/fail
 */
export function evaluateThresholds(
  config: ThresholdConfig,
  collector: MetricCollector,
): ThresholdSummary {
  const results: ThresholdResult[] = [];

  for (const [metricName, rawRules] of Object.entries(config)) {
    const rules = normalizeRules(rawRules);
    const values = collector.getValues(metricName);

    for (const [aggKey, expr] of Object.entries(rules)) {
      const agg = aggKey as ThresholdAggregation;
      if (!VALID_AGGREGATIONS.has(agg) || !expr) continue;

      const parsed = parseExpression(expr);
      if (!parsed) {
        // Invalid expression — treat as fail
        results.push({
          metric: metricName,
          aggregation: agg,
          threshold: expr,
          actual: NaN,
          pass: false,
        });
        continue;
      }

      if (values.length === 0) {
        // No data for this metric — skip (not a failure)
        results.push({
          metric: metricName,
          aggregation: agg,
          threshold: expr,
          actual: 0,
          pass: true,
        });
        continue;
      }

      const actual = aggregate(values, agg);
      results.push({
        metric: metricName,
        aggregation: agg,
        threshold: expr,
        actual: Math.round(actual * 100) / 100,
        pass: passes(actual, parsed),
      });
    }
  }

  return {
    results,
    pass: results.every((r) => r.pass),
  };
}
