/**
 * Structured threshold parsing + evaluation (M4-a; interval evaluation D0-T5).
 *
 * A `loadRunner({ thresholds })` config carries human expressions per scope/metric
 * (`errorRate: "<1%"`, `p95: "<800ms"`, `throughputPerSec: ">100/s"`). This module
 * parses those expressions, evaluates them against a finalized `LoadArtifact`, and
 * produces the `ThresholdEvaluation[]` + a refined pass verdict (a crash-free run
 * only passes if every configured threshold EVALUATES and holds).
 *
 * Evaluation runs OUTSIDE the reducer (which never sees the plan's thresholds) as a
 * post-finalize step in the orchestrator. Scopes whose data isn't present yet
 * (primary / endToEnd / continuation phase splits — M5/M6) and metrics N/A to a
 * scope (e.g. throughput on a step) are skipped rather than failed.
 *
 * Latency quantile gates (p50/p90/p95/p99) are TRI-STATE (proposal §7.3/§11): with a
 * {@link ThresholdQuantileSource} they are decided on the scope's all-phase merged
 * histogram's `percentileBounds()` interval — `<`/`<=` need the UPPER bound under the
 * threshold to pass, `>`/`>=` need the LOWER bound over it (conservative in both
 * directions); an interval that straddles the threshold is `unevaluable`
 * (`"borderline-quantile"`) with `pass: false`, never a coin-flip verdict. A gate whose
 * target scope observed NOTHING is `unevaluable` (`"no-observations"`) — an empty
 * scope's zero-filled summary fields are not measurements and must not false-green a
 * `<` gate. Custom-metric TREND quantile gates share the same interval path (via the
 * source's `custom` lookup); errorRate/throughput/rate/counter gates stay
 * point-evaluated (exact count arithmetic, no interval), except that a zero-observation
 * denominator is also `"no-observations"`.
 */
import type {
  LoadArtifact,
  LoadCustomMetric,
  LoadCustomMetricSeries,
  LoadCustomMetricThresholdScope,
  LoadThresholdScope,
  LoadThresholds,
  ThresholdEvaluation,
} from "@glubean/sdk/load";
import type { LoadHistogram } from "./histogram.js";

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

/**
 * A row that can be combined across phase splits. `errorRate` is the row's OWN
 * (correctly-scoped) rate — request-based for endpoints, invocation-based for
 * steps — and `errorWeight` is its denominator (requests / executed invocations),
 * so combining preserves each scope's error-rate definition.
 */
interface CombinableRow {
  errorRate: number;
  errorWeight: number;
  throughputPerSec?: number;
  latency: { p50: number; p90: number; p95: number; p99: number };
}

/**
 * Combine an endpoint's / step's per-phase rows (M5 splits a route or step hit in
 * both phases into two rows) into ONE scope for thresholding:
 *  - throughput is ADDITIVE → summed (60/s primary + 60/s continuation = 120/s);
 *  - errorRate is weighted by each row's denominator (Σ rate·weight / Σ weight), so
 *    it stays request-based for endpoints and invocation-based for steps;
 *  - percentiles can't be merged from summaries, so each is the MAX across rows —
 *    a FALLBACK used only when no {@link ThresholdQuantileSource} is supplied (an
 *    adapter-produced artifact with no reducer histograms). It is safe for the usual
 *    `<` upper-bound threshold (max under X ⟹ the merged distribution is under X)
 *    but over-conservative: a tiny slow phase (say 1% of traffic) drags the combined
 *    quantile to ITS OWN quantile and produces a false breach. The primary path
 *    (D0-T5) therefore evaluates latency quantiles on the scope's all-phase MERGED
 *    histogram instead, and only errorRate/throughput still come from this synthesis.
 * A single row (the no-split common case) combines to its own values unchanged.
 */
function combineRows(rows: CombinableRow[]): ScopeData {
  let errorWeighted = 0;
  let errorWeight = 0;
  let throughput = 0;
  let hasThroughput = false;
  const latency = { p50: 0, p90: 0, p95: 0, p99: 0 };
  for (const r of rows) {
    errorWeighted += r.errorRate * r.errorWeight;
    errorWeight += r.errorWeight;
    if (r.throughputPerSec !== undefined) {
      throughput += r.throughputPerSec;
      hasThroughput = true;
    }
    latency.p50 = Math.max(latency.p50, r.latency.p50);
    latency.p90 = Math.max(latency.p90, r.latency.p90);
    latency.p95 = Math.max(latency.p95, r.latency.p95);
    latency.p99 = Math.max(latency.p99, r.latency.p99);
  }
  return {
    errorRate: errorWeight > 0 ? errorWeighted / errorWeight : 0,
    ...(hasThroughput ? { throughputPerSec: throughput } : {}),
    latency,
  };
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

/** Metrics a custom-metric threshold can target (keys of `LoadCustomMetricThresholdScope`). */
const CUSTOM_METRIC_KEYS = ["rate", "sum", "count", "p50", "p90", "p95", "p99"] as const;
type CustomMetricKey = (typeof CUSTOM_METRIC_KEYS)[number];

/** Parse a custom-metric expression by reusing the base parser under a unit-compatible
 *  proxy metric: `rate` is a fraction (`%` ok, like errorRate), `sum`/`count` are unitless
 *  counts (like backlog), `p50..p99` are durations (ms, like latency percentiles) — but
 *  ONLY when the trend's declared unit is `"ms"` (or unset). A trend in any other unit
 *  ("bytes", "items") is gated in ITS OWN unit: bare numbers only — an `ms`/`s` suffix
 *  would silently scale a non-duration value and is rejected instead. */
function parseCustomExpression(expr: string, key: CustomMetricKey, unit?: string): ParsedThreshold {
  if (key === "rate") return parseThresholdExpression(expr, "errorRate");
  if (key === "sum" || key === "count") return parseThresholdExpression(expr, "backlog");
  if (unit !== undefined && unit !== "ms") {
    const m = EXPR_RE.exec(expr.trim());
    if (!m) {
      throw new Error(
        `invalid threshold expression ${JSON.stringify(expr)} — expected e.g. "<1%", "<800ms", ">100/s"`,
      );
    }
    if (m[3] !== undefined) {
      throw new Error(
        `threshold unit "${m[3]}" is not valid for a trend declared with unit "${unit}" (in ${JSON.stringify(expr)}) — use a bare number in the metric's own unit`,
      );
    }
    const num = Number(m[2]);
    if (!Number.isFinite(num)) throw new Error(`invalid threshold number in ${JSON.stringify(expr)}`);
    return { op: m[1] as Op, value: num };
  }
  return parseThresholdExpression(expr, key);
}

/** Match a custom-metric threshold target against a set of metric ids, disambiguating a
 *  `:` in the metric ID from the `metricId:tag=val` selector: an EXACT id match wins
 *  (so `"http:ok"` resolves to the metric named `http:ok`), else the longest id that is
 *  a `${id}:` prefix of the target (the tag-selector form). Undefined → no such metric. */
function matchMetricId(ids: Iterable<string>, targetKey: string): { id: string; suffix?: string } | undefined {
  let best: string | undefined;
  for (const id of ids) {
    if (id === targetKey) return { id }; // exact id → untagged total
    if (targetKey.startsWith(`${id}:`) && (best === undefined || id.length > best.length)) {
      best = id;
    }
  }
  return best !== undefined ? { id: best, suffix: targetKey.slice(best.length + 1) } : undefined;
}

/** Resolve a custom-metric threshold target to its folded artifact metric (see
 *  `matchMetricId` for the `metricId` vs `metricId:tag=val` disambiguation). */
function resolveCustomTarget(
  metrics: readonly LoadCustomMetric[] | undefined,
  targetKey: string,
): { metric: LoadCustomMetric; suffix?: string } | undefined {
  if (!metrics) return undefined;
  const m = matchMetricId(metrics.map((x) => x.metricId), targetKey);
  if (!m) return undefined;
  const metric = metrics.find((x) => x.metricId === m.id);
  return metric ? { metric, ...(m.suffix !== undefined ? { suffix: m.suffix } : {}) } : undefined;
}

/** The declared custom-metric kinds (mirrors `LoadMetricKind` for runtime checks). */
const METRIC_KINDS = ["rate", "trend", "counter"] as const;

/** Gate keys applicable to each kind (`count` is folded for every kind). A key
 *  outside its kind's set would evaluate to `undefined` and skip silently. */
const KIND_GATE_KEYS: Record<(typeof METRIC_KINDS)[number], readonly CustomMetricKey[]> = {
  rate: ["rate", "count"],
  counter: ["sum", "count"],
  trend: ["count", "p50", "p90", "p95", "p99"],
};

/**
 * Fail-fast validation for `loadRunner({ metrics, thresholds.customMetric })`, run
 * BEFORE any iteration (untyped JS config bypasses the compile-time types):
 *  - every declaration's `kind` must be in the union — an out-of-union kind would
 *    emit schema-invalid custom-metric artifact rows instead of failing config;
 *  - every `thresholds.customMetric` gate must target a DECLARED metric with a
 *    well-formed tag selector — a typo'd target would otherwise never match a
 *    folded series, silently skip, and leave CI green;
 *  - every gate key must be applicable to the target's declared kind (`sum` on a
 *    `rate`, or a typo'd key, would otherwise evaluate nothing and skip silently).
 * Returns error strings (empty = valid); the caller owns the throw + prefix.
 */
export function validateLoadMetricsConfig(
  metrics: Record<string, { kind: string; unit?: unknown } | undefined> | undefined,
  customMetricThresholds: Record<string, object | undefined> | undefined,
): string[] {
  const errors: string[] = [];
  for (const [id, d] of Object.entries(metrics ?? {})) {
    if (id === "") errors.push("metrics: a metric id must be a non-empty string");
    if (d === null || typeof d !== "object" || !(METRIC_KINDS as readonly string[]).includes(d.kind)) {
      errors.push(
        `metrics${id ? `.${id}` : ""}: kind must be one of ${METRIC_KINDS.join(" / ")} — declare via rate() / trend() / counter()`,
      );
    } else if (d.unit !== undefined && typeof d.unit !== "string") {
      errors.push(`metrics.${id}: unit must be a string`);
    }
  }
  for (const [targetKey, cfg] of Object.entries(customMetricThresholds ?? {})) {
    const m = matchMetricId(Object.keys(metrics ?? {}), targetKey);
    if (!m) {
      errors.push(
        `thresholds.customMetric["${targetKey}"]: gates a metric that is not declared in \`metrics\``,
      );
      continue;
    }
    if (m.suffix !== undefined && parseTagSuffix(m.suffix) === undefined) {
      errors.push(
        `thresholds.customMetric["${targetKey}"]: malformed tag selector "${m.suffix}" — expected \`${m.id}:tagKey=tagVal\``,
      );
    }
    // Gate keys must fit the declared kind (skip when the declaration itself is
    // invalid — that already errored above).
    const kind = metrics?.[m.id]?.kind as (typeof METRIC_KINDS)[number] | undefined;
    const validKeys = kind !== undefined ? KIND_GATE_KEYS[kind] : undefined;
    if (validKeys === undefined) continue;
    for (const key of Object.keys(cfg ?? {})) {
      if (!(validKeys as readonly string[]).includes(key)) {
        errors.push(
          `thresholds.customMetric["${targetKey}"].${key}: not applicable to a "${kind}" metric — valid keys: ${validKeys.join(" / ")}`,
        );
      }
    }
  }
  return errors;
}

/** Parse a tag suffix (`"a=1,b=2"`) into a tag record, or `undefined` if it is malformed
 *  (empty, or any pair lacking `=`) — so `pollOk:` / `pollOk:class` don't silently collapse
 *  onto the untagged total. */
function parseTagSuffix(suffix: string): Record<string, string> | undefined {
  const tags: Record<string, string> = {};
  for (const pair of suffix.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return undefined; // no `=`, or an empty key
    tags[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return Object.keys(tags).length > 0 ? tags : undefined;
}

function tagsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => a[k] === b[k]);
}

/** Find the series a custom-metric threshold targets: the untagged total (no suffix)
 *  or the series whose tags exactly match the suffix. */
function findCustomSeries(metric: LoadCustomMetric, suffix?: string): LoadCustomMetricSeries | undefined {
  if (suffix === undefined) return metric.series.find((s) => Object.keys(s.tags).length === 0);
  const want = parseTagSuffix(suffix);
  if (want === undefined) return undefined; // malformed suffix → no match (skipped)
  return metric.series.find((s) => tagsEqual(s.tags, want));
}

/** Pull the actual value for a custom-metric key from a folded series (undefined = N/A
 *  to this metric's kind, e.g. `rate` on a counter → skipped, not failed). */
function customActualFor(key: CustomMetricKey, series: LoadCustomMetricSeries): number | undefined {
  switch (key) {
    case "rate":
      return series.rate;
    case "sum":
      return series.sum;
    case "count":
      return series.count;
    case "p50":
      return series.latency?.p50;
    case "p90":
      return series.latency?.p90;
    case "p95":
      return series.latency?.p95;
    case "p99":
      return series.latency?.p99;
  }
}

/**
 * Latency-quantile source for interval evaluation (D0-T5): the reducer's per-scope
 * `LoadHistogram`s, with endpoint/step lookups returning the ALL-PHASE MERGED
 * histogram for the target (primary + continuation rows folded into one
 * distribution — exactly what a scope-level quantile gate is about). Supplied by
 * the orchestrator from the live reducer; when absent (an adapter-produced /
 * imported artifact with no reducer behind it), latency quantile gates fall back
 * to the artifact's per-row point values + `combineRows` max synthesis, as before.
 *
 * Trust model (owner 2026-07-14): these histograms come from our own same-version
 * reducer, not from untrusted input — no defensive re-validation here.
 */
export interface ThresholdQuantileSource {
  transaction?: LoadHistogram;
  primary?: LoadHistogram;
  endToEnd?: LoadHistogram;
  /** All-phase merged latency histogram for a routeKey (undefined → no such endpoint). */
  endpoint?: (routeKey: string) => LoadHistogram | undefined;
  /** All-phase merged latency histogram for a stepId (undefined → no such step). */
  step?: (stepId: string) => LoadHistogram | undefined;
  /** A custom-metric TREND series' histogram: the untagged total (`tags: {}`) or the
   *  series matching the tag combination (located by the reducer's own canonical tag
   *  key). undefined → no histogram (a rate/counter series, or an unknown
   *  metric/series). Trend quantile gates need this for the same reason the latency
   *  scopes do: the folded point value IS the interval upper, so a `>` gate compared
   *  at the point can false-pass while the true quantile sits anywhere in the interval. */
  custom?: (metricId: string, tags: Record<string, string>) => LoadHistogram | undefined;
}

/** The quantile metrics decided on histogram intervals; narrows a metric/gate key to a
 *  `PercentileBounds` key. Takes a plain string so both the scope metrics
 *  (`ThresholdMetric`) and the custom-metric gate keys (`CustomMetricKey`) share it. */
function quantileKeyOf(metric: string): "p50" | "p90" | "p95" | "p99" | undefined {
  return metric === "p50" || metric === "p90" || metric === "p95" || metric === "p99" ? metric : undefined;
}

/**
 * Decide a quantile gate on its `[lower, upper]` interval. Both endpoints agreeing
 * decides the gate at its conservative endpoint for free (`<`/`<=` at upper, `>`/`>=`
 * at lower — for monotone ops the endpoint verdicts can only disagree in the
 * straddling direction); a disagreement means the threshold cuts through the interval
 * → unevaluable, pass FORCED false (old two-state consumers must show it breached,
 * never green). Shared by the latency scopes and custom trend gates.
 */
function quantileVerdict(
  b: { lower: number; upper: number },
  op: Op,
  value: number,
): Pick<ThresholdEvaluation, "pass" | "status" | "reason" | "quantileBounds"> {
  const passLower = compare(b.lower, op, value);
  const passUpper = compare(b.upper, op, value);
  const quantileBounds = { lower: b.lower, upper: b.upper };
  return passLower === passUpper
    ? { pass: passUpper, status: "evaluated", quantileBounds }
    : { pass: false, status: "unevaluable", reason: "borderline-quantile", quantileBounds };
}

/**
 * Evaluate every configured threshold against the artifact, returning the
 * `ThresholdEvaluation[]` and the refined run pass (crash-free AND every configured
 * threshold evaluates and holds — an `unevaluable` gate carries `pass: false`, so it
 * fails the run; see the conservative-degradation rule on `ThresholdEvaluation`).
 * Thresholds whose scope data is absent or whose metric is N/A to the scope are
 * skipped (not failed). `quantiles` (optional) supplies the reducer's per-scope
 * histograms for interval evaluation of latency quantile gates — see
 * {@link ThresholdQuantileSource} for the with/without semantics.
 */
export function evaluateThresholds(
  artifact: LoadArtifact,
  thresholds: LoadThresholds,
  quantiles?: ThresholdQuantileSource,
): { thresholds: ThresholdEvaluation[]; pass: boolean; advisories: string[] } {
  const out: ThresholdEvaluation[] = [];
  const advisories: string[] = [];

  const evalScope = (
    scope: ThresholdEvaluation["scope"],
    target: string | undefined,
    data: ScopeData | undefined,
    cfg: LoadThresholdScope | undefined,
    // Interval-evaluation inputs: the scope's merged latency histogram (bounds path)
    // and its observation count (zero-observation guard). `observations` undefined =
    // unknown (continuation counters) → no guard, evaluate as before.
    quantile?: { hist?: LoadHistogram; observations?: number },
  ): void => {
    if (!data || !cfg) return;
    const hist = quantile?.hist;
    // Compute the interval set once per scope, not per metric.
    const bounds = hist !== undefined && hist.count > 0 ? hist.percentileBounds() : undefined;
    for (const metric of THRESHOLD_METRICS) {
      const expr = cfg[metric];
      if (expr === undefined) continue;
      const actual = actualFor(metric, data);
      if (actual === undefined) continue; // metric not applicable to this scope
      const { op, value } = parseThresholdExpression(expr, metric);
      const base = {
        scope,
        ...(target !== undefined ? { target } : {}),
        metric,
        expression: expr,
        source: "glubean" as const,
      };
      const qk = quantileKeyOf(metric);
      // Zero observations: an empty scope reports zero-filled fields (ZERO_PCT
      // latency, 0/0 errorRate) that are NOT measurements — evaluating them would
      // false-green a `<` gate. Quantiles and errorRate are unevaluable; throughput
      // stays evaluated (0 completions over the run duration really IS 0/s — a
      // `>100/s` floor correctly fails on it).
      if ((qk !== undefined || metric === "errorRate") && quantile?.observations === 0) {
        out.push({ ...base, actual, pass: false, status: "unevaluable", reason: "no-observations" });
        continue;
      }
      if (qk !== undefined && bounds !== undefined) {
        // Interval decision (see `quantileVerdict`). `actual` = the histogram's
        // canonical point estimate (interval upper — the same number
        // `percentiles()`/`summary.latency` report), NOT the per-phase rows'
        // max-of-rows synthesis, so the recorded point matches the decision data.
        const b = bounds[qk];
        out.push({ ...base, actual: b.upper, ...quantileVerdict(b, op, value) });
        continue;
      }
      out.push({ ...base, actual, pass: compare(actual, op, value), status: "evaluated" });
    }
  };

  const s = artifact.summary;
  evalScope(
    "transaction",
    undefined,
    { errorRate: s.errorRate, latency: s.latency, throughputPerSec: s.throughputPerSec },
    thresholds.transaction,
    { hist: quantiles?.transaction, observations: s.totalIterations },
  );
  evalScope("primary", undefined, s.primary as ScopeData | undefined, thresholds.primary, {
    hist: quantiles?.primary,
    observations: s.primary?.completed,
  });
  evalScope("endToEnd", undefined, s.endToEnd as ScopeData | undefined, thresholds.endToEnd, {
    hist: quantiles?.endToEnd,
    observations: s.endToEnd?.completed,
  });
  // The continuation summary needs numeric projection: `backpressureMs` is a
  // percentile distribution (compare against p95), and the threshold-relevant
  // backlog is the PEAK (`maxBacklog`), not the drained-to-0 live count. Its gates
  // are counters/point values (backlog, backpressureMs is outside the p50..p99
  // interval family) — no quantile source.
  const continuationData: ScopeData | undefined = s.continuation
    ? { backlog: s.continuation.maxBacklog, backpressureMs: s.continuation.backpressureMs?.p95 ?? 0 }
    : undefined;
  evalScope("continuation", undefined, continuationData, thresholds.continuation);

  // Endpoints / steps can split into per-phase rows (M5: a route or step hit in
  // both the primary and continuation phase appears twice). errorRate/throughput
  // combine across the matching rows (weighted / summed — exact count arithmetic);
  // latency quantiles are decided on the scope's all-phase MERGED histogram when a
  // source is supplied (the per-row max fallback would inflate a tiny slow phase
  // into a false breach). No matching row → skipped, not failed (the documented
  // absent-scope policy; D1's coverage reasons take over from there).
  if (thresholds.endpoints) {
    for (const [routeKey, cfg] of Object.entries(thresholds.endpoints)) {
      const eps = artifact.endpoints.filter((e) => e.routeKey === routeKey);
      // Endpoint error rate is over REQUESTS.
      const rows = eps.map((e) => ({
        errorRate: e.errorRate,
        errorWeight: e.requestCount,
        throughputPerSec: e.throughputPerSec,
        latency: e.latency,
      }));
      evalScope("endpoint", routeKey, rows.length > 0 ? combineRows(rows) : undefined, cfg, {
        hist: quantiles?.endpoint?.(routeKey),
        observations: eps.reduce((n, e) => n + e.requestCount, 0),
      });
    }
  }
  if (thresholds.steps) {
    for (const [stepId, cfg] of Object.entries(thresholds.steps)) {
      const sts = artifact.steps.filter((x) => x.stepId === stepId);
      // Step error rate is over EXECUTED invocations (skipped ones aren't failures);
      // steps have no throughput metric.
      const rows = sts.map((s) => ({
        errorRate: s.errorRate,
        errorWeight: Math.max(0, s.invocationCount - s.skippedCount),
        latency: s.latency,
      }));
      evalScope("step", stepId, rows.length > 0 ? combineRows(rows) : undefined, cfg, {
        hist: quantiles?.step?.(stepId),
        observations: sts.reduce((n, x) => n + Math.max(0, x.invocationCount - x.skippedCount), 0),
      });
    }
  }

  // Custom metrics (rate / trend / counter). A target is `metricId` (the untagged
  // total) or `metricId:tagKey=tagVal` (a per-series gate). A metric/series not present
  // (never observed) or a key N/A to the metric's kind (`rate` on a counter) is skipped.
  if (thresholds.customMetric) {
    for (const [targetKey, cfg] of Object.entries(thresholds.customMetric)) {
      const resolved = resolveCustomTarget(s.customMetrics, targetKey);
      const series = resolved ? findCustomSeries(resolved.metric, resolved.suffix) : undefined;
      if (!series) {
        // Skip-on-absent is the module policy (a gate can't fail on missing data),
        // but a CONFIGURED gate that measured nothing must not stay silent: it
        // surfaces as an advisory so a metric that never records / a tag series
        // dropped by `maxSeries` truncation can't leave CI green unnoticed.
        advisories.push(
          resolved
            ? resolved.metric.seriesTruncated && resolved.suffix !== undefined
              ? `customMetric threshold "${targetKey}" was skipped: the targeted tag series was not folded — metric "${resolved.metric.metricId}" hit its maxSeries cap and overflow folded into the untagged total`
              : `customMetric threshold "${targetKey}" was skipped: no samples were folded for the targeted series`
            : `customMetric threshold "${targetKey}" was skipped: metric was declared but never recorded a sample`,
        );
        continue;
      }
      // Iterate the CONFIGURED keys (not just the known set), so a typo'd key on the
      // evaluator-only path (an adapter/imported artifact that bypassed our config
      // validation) surfaces as an advisory instead of skipping silently.
      for (const key of Object.keys(cfg)) {
        if (!(CUSTOM_METRIC_KEYS as readonly string[]).includes(key)) {
          advisories.push(
            `customMetric threshold "${targetKey}".${key} was skipped: unknown gate key — valid keys: ${CUSTOM_METRIC_KEYS.join(" / ")}`,
          );
          continue;
        }
        const known = key as CustomMetricKey;
        const expr = cfg[known];
        if (expr === undefined) continue;
        const actual = customActualFor(known, series);
        if (actual === undefined) {
          // N/A to this metric's kind (`sum` on a rate). Startup validation rejects
          // this for our own config; an adapter-produced artifact still surfaces it.
          advisories.push(
            `customMetric threshold "${targetKey}".${key} was skipped: not applicable to a "${resolved?.metric.kind}" metric`,
          );
          continue;
        }
        const { op, value } = parseCustomExpression(expr, known, resolved?.metric.unit);
        // A present-but-EMPTY series (count 0 — e.g. a D1 pinned-key placeholder, or
        // an adapter artifact) folds `rate` as 0/0→0 and trend quantiles as ZERO_PCT:
        // zero observations ≠ the value 0 (proposal §7.3) — evaluating them would
        // false-green a `<` gate. `count`/`sum` stay evaluated: 0 observations really
        // IS count 0 / sum 0 (additive facts a `>` floor should fail on).
        if (series.count === 0 && known !== "count" && known !== "sum") {
          out.push({
            scope: "customMetric",
            target: targetKey,
            metric: known,
            expression: expr,
            actual,
            pass: false,
            status: "unevaluable",
            reason: "no-observations",
            source: "glubean",
          });
          continue;
        }
        // Trend quantile keys go through the SAME interval decision as the latency
        // scopes when the series' histogram is available (codex R1): the folded
        // point value is the interval upper, exact enough for `<` but a `>` gate
        // compared at the point false-passes whenever the interval straddles the
        // threshold. rate/counter keys stay point-evaluated (exact count ratios).
        // The lookup goes by the series' OWN tags (`{}` = the untagged total), so
        // both the total and a tagged `metricId:tag=val` target resolve.
        const qk = quantileKeyOf(known);
        const hist =
          qk !== undefined && resolved !== undefined
            ? quantiles?.custom?.(resolved.metric.metricId, series.tags)
            : undefined;
        if (qk !== undefined && hist !== undefined && hist.count > 0) {
          const b = hist.percentileBounds()[qk];
          out.push({
            scope: "customMetric",
            target: targetKey,
            metric: known,
            expression: expr,
            actual: b.upper, // the canonical point estimate, matching the folded series row
            ...quantileVerdict(b, op, value),
            source: "glubean",
          });
          continue;
        }
        out.push({
          scope: "customMetric",
          target: targetKey,
          metric: known,
          expression: expr,
          actual,
          pass: compare(actual, op, value),
          status: "evaluated",
          source: "glubean",
        });
      }
    }
  }

  // A crash already fails the run; otherwise every configured threshold must EVALUATE
  // and hold — unevaluable rows carry pass:false (the iron rule), so they fail the run
  // here with no extra branch (§7.4: pass requires all gates evaluated AND passing).
  const pass = s.pass && out.every((e) => e.pass);
  return { thresholds: out, pass, advisories };
}
