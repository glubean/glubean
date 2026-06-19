/**
 * Structured threshold parsing + evaluation (M4-a).
 *
 * A `loadRunner({ thresholds })` config carries human expressions per scope/metric
 * (`errorRate: "<1%"`, `p95: "<800ms"`, `throughputPerSec: ">100/s"`). This module
 * parses those expressions, evaluates them against a finalized `LoadArtifact`, and
 * produces the `ThresholdEvaluation[]` + a refined pass verdict (a crash-free run
 * only passes if every configured-and-evaluable threshold holds).
 *
 * Evaluation runs OUTSIDE the reducer (which never sees the plan's thresholds) as a
 * post-finalize step in the orchestrator. Scopes whose data isn't present yet
 * (primary / endToEnd / continuation phase splits — M5/M6) and metrics N/A to a
 * scope (e.g. throughput on a step) are skipped rather than failed.
 */
import type {
  LoadArtifact,
  LoadThresholdScope,
  LoadThresholds,
  ThresholdEvaluation,
} from "@glubean/sdk/load";

type Op = "<" | "<=" | ">" | ">=";

/** Metrics a threshold can target (the keys of `LoadThresholdScope`). */
const THRESHOLD_METRICS = [
  "errorRate",
  "p50",
  "p90",
  "p95",
  "p99",
  "throughputPerSec",
  "backlog",
  "backpressureMs",
] as const;
type ThresholdMetric = (typeof THRESHOLD_METRICS)[number];

/** A parsed threshold: comparison operator + the value in the metric's base unit. */
export interface ParsedThreshold {
  op: Op;
  /** Value in the metric's base unit: errorRate=fraction, latency/backpressure=ms,
   *  throughput=/s, backlog=count. */
  value: number;
}

const EXPR_RE = /^(<=|>=|<|>)\s*(-?[0-9.]+)\s*(%|ms|s|\/s)?$/;

/**
 * Parse one threshold expression for a given metric, normalizing its value to the
 * metric's base unit (`%`→fraction, `s`→ms, etc.). Throws on a malformed
 * expression or a unit that doesn't fit the metric.
 */
export function parseThresholdExpression(expr: string, metric: ThresholdMetric): ParsedThreshold {
  const m = EXPR_RE.exec(expr.trim());
  if (!m) {
    throw new Error(
      `invalid threshold expression ${JSON.stringify(expr)} — expected e.g. "<1%", "<800ms", ">100/s"`,
    );
  }
  const op = m[1] as Op;
  const num = Number(m[2]);
  const unit = m[3] as "%" | "ms" | "s" | "/s" | undefined;
  if (!Number.isFinite(num)) throw new Error(`invalid threshold number in ${JSON.stringify(expr)}`);

  const badUnit = (): never => {
    throw new Error(`threshold unit "${unit}" is not valid for metric "${metric}" (in ${JSON.stringify(expr)})`);
  };

  let value: number;
  switch (metric) {
    case "errorRate":
      // A bare number is already a fraction (0..1); "%" scales a percentage down.
      value = unit === "%" ? num / 100 : unit === undefined ? num : badUnit();
      break;
    case "p50":
    case "p90":
    case "p95":
    case "p99":
    case "backpressureMs":
      value = unit === "s" ? num * 1000 : unit === "ms" || unit === undefined ? num : badUnit();
      break;
    case "throughputPerSec":
      value = unit === "/s" || unit === undefined ? num : badUnit();
      break;
    case "backlog":
      value = unit === undefined ? num : badUnit();
      break;
  }
  return { op, value };
}

function compare(actual: number, op: Op, value: number): boolean {
  switch (op) {
    case "<":
      return actual < value;
    case "<=":
      return actual <= value;
    case ">":
      return actual > value;
    case ">=":
      return actual >= value;
  }
}

/** A metric-source shape: any object that may carry the comparable fields. */
interface ScopeData {
  errorRate?: number;
  latency?: { p50: number; p90: number; p95: number; p99: number };
  throughputPerSec?: number;
  backlog?: number;
  backpressureMs?: number;
}

/** Pull the actual value for `metric` from a scope's data, or undefined if N/A. */
function actualFor(metric: ThresholdMetric, data: ScopeData): number | undefined {
  switch (metric) {
    case "errorRate":
      return data.errorRate;
    case "p50":
      return data.latency?.p50;
    case "p90":
      return data.latency?.p90;
    case "p95":
      return data.latency?.p95;
    case "p99":
      return data.latency?.p99;
    case "throughputPerSec":
      return data.throughputPerSec;
    case "backlog":
      return data.backlog;
    case "backpressureMs":
      return data.backpressureMs;
  }
}

/**
 * Evaluate every configured threshold against the artifact, returning the
 * `ThresholdEvaluation[]` and the refined run pass (crash-free AND every evaluable
 * threshold holds). Thresholds whose scope data is absent or whose metric is N/A
 * to the scope are skipped (not failed).
 */
export function evaluateThresholds(
  artifact: LoadArtifact,
  thresholds: LoadThresholds,
): { thresholds: ThresholdEvaluation[]; pass: boolean } {
  const out: ThresholdEvaluation[] = [];

  const evalScope = (
    scope: ThresholdEvaluation["scope"],
    target: string | undefined,
    data: ScopeData | undefined,
    cfg: LoadThresholdScope | undefined,
  ): void => {
    if (!data || !cfg) return;
    for (const metric of THRESHOLD_METRICS) {
      const expr = cfg[metric];
      if (expr === undefined) continue;
      const actual = actualFor(metric, data);
      if (actual === undefined) continue; // metric not applicable to this scope
      const { op, value } = parseThresholdExpression(expr, metric);
      out.push({
        scope,
        ...(target !== undefined ? { target } : {}),
        metric,
        expression: expr,
        actual,
        pass: compare(actual, op, value),
        source: "glubean",
      });
    }
  };

  const s = artifact.summary;
  evalScope(
    "transaction",
    undefined,
    { errorRate: s.errorRate, latency: s.latency, throughputPerSec: s.throughputPerSec },
    thresholds.transaction,
  );
  evalScope("primary", undefined, s.primary as ScopeData | undefined, thresholds.primary);
  evalScope("endToEnd", undefined, s.endToEnd as ScopeData | undefined, thresholds.endToEnd);
  evalScope("continuation", undefined, s.continuation as ScopeData | undefined, thresholds.continuation);

  if (thresholds.endpoints) {
    for (const [routeKey, cfg] of Object.entries(thresholds.endpoints)) {
      const ep = artifact.endpoints.find((e) => e.routeKey === routeKey);
      evalScope("endpoint", routeKey, ep, cfg);
    }
  }
  if (thresholds.steps) {
    for (const [stepId, cfg] of Object.entries(thresholds.steps)) {
      const st = artifact.steps.find((x) => x.stepId === stepId);
      evalScope("step", stepId, st, cfg);
    }
  }

  // A crash already fails the run; otherwise every evaluable threshold must hold.
  const pass = s.pass && out.every((e) => e.pass);
  return { thresholds: out, pass };
}
