/**
 * `LoadReducerPartialV1` — the versioned wire schema for a load reducer's COMPLETE
 * aggregate state (internal load-distributed-execution proposal §7.5), plus the
 * coordinator-side operations over it:
 *
 *  - `parseLoadReducerPartial` — single-frame validation (reject the FRAME on failure;
 *    the caller decides lost-worker semantics, §7.4);
 *  - `mergePartials` — fold N workers' partials into one merged partial (§7.2/§7.3
 *    field-by-field rules: sum / min / max / histogram merge / timeline mergeAll with
 *    censoring / sample total-order re-sort + truncate / union-dedup / weakest /
 *    assert-equal-else-reject / replace);
 *  - `finalizeMerged` — hydrate a reducer from a (merged) partial and produce the ONE
 *    `LoadArtifact`, with threshold gates evaluated on the D0-5 interval path from the
 *    hydrated state's histograms.
 *
 * The worker-side export lives on the reducer itself (`LoadReducerImpl.exportPartial`)
 * so it can read the private aggregate state; this module owns the schema and the
 * cross-worker algebra. D0 scope: serialization + merge + finalize only — the wire
 * protocol / transport framing (§7.1 snapshotSeq/chunking/sha256) is D1, and
 * `maxPartialBytes` enforcement is D0-10.
 *
 * TRUST MODEL (owner decision, 2026-07-14): payloads originate from same-version
 * cooperating workers (in-process/child-process in D1; version+manifest-verified agents
 * in D2). Validation guards against schema drift and transport corruption, NOT
 * adversarial forgery — exhaustive cross-field feasibility checks are deliberately out
 * of scope (owner decision, 2026-07-14). Do not add them in review: what is checked is
 * the version field, structure/types, non-negative safe-integer count domains, canonical
 * uniqueness of keyed rows, and the deep sub-payload validation the histogram / timeline
 * / slot-busy `fromJSON`s already provide (delegated, so their existing invariants —
 * e.g. the pinned window relativeError — come for free). Cross-field feasibility
 * inference (e.g. `iterCompleted ≤ iterStarted`, endpoint counts vs histogram counts)
 * is deliberately absent.
 */
import type {
  LoadArtifact,
  LoadAttributionQuality,
  LoadAttributionReport,
  LoadCrashSummary,
  LoadEndReason,
  LoadExecutionStatus,
  LoadFailureSummary,
  LoadFailureTraceSample,
  LoadMetricKind,
  LoadResolvedConfig,
  LoadRouteKeySource,
  LoadSlowTransactionSummary,
  LoadThresholds,
} from "@glubean/sdk/load";
import { LoadHistogram, type LoadHistogramJSON } from "./histogram.js";
import { LoadTimeline, type LoadTimelineJSON } from "./timeline.js";
import { SlotBusyWindows, type SlotBusyWindowsJSON } from "./slot-busy.js";
import { compareFailure, compareSlow } from "./samples.js";
import { canonicalTagKey, LoadReducerImpl } from "./reducer.js";
import { evaluateThresholds } from "./threshold.js";

type Phase = "primary" | "continuation";
/** Feeder-state guarantee levels (mirrors `runtime.feederGuarantee`, schema v2). */
type LoadFeederGuarantee = LoadArtifact["runtime"]["feederGuarantee"];

/** Same compound-key separator the reducer's aggregate maps use. */
const SEP = "\u0000";

/** The one relativeError every embedded histogram must carry — an OPERATIONAL invariant
 *  (not forgery defense): hydration merges revived histograms into freshly constructed
 *  default instances, and the coordinator merge folds same-key histograms together, so a
 *  differing relativeError would throw mid-operation. Probe-derived so it cannot drift
 *  from histogram.ts (same pattern as the timeline's pinned window relativeError). */
const PARTIAL_HISTOGRAM_RELATIVE_ERROR = new LoadHistogram().toJSON().relativeError;

/** `recentFailures` ring cap — mirrors the reducer's `pushFailure` bound. */
const MAX_RECENT_FAILURES = 100;

// ── schema ────────────────────────────────────────────────────────────────

/** One folded custom-metric series (the untagged total, or one tag combination). */
export interface LoadPartialCustomSeriesV1 {
  /** The tag combination (`{}` for the untagged total). */
  tags: Record<string, string>;
  count: number;
  /** rate: observations whose value was truthy. */
  trueCount: number;
  /** counter: summed increments (any sign — increments are not constrained positive). */
  sum: number;
  /** trend only: the folded sample distribution. Present iff the metric kind is trend. */
  hist?: LoadHistogramJSON;
  /** Whether this series' fold is exact. A worker's own retained series are always
   *  complete (the series cap only blocks NEW keys); a MERGED series is complete only
   *  under §7.3's conservative rule — any truncated worker that did not explicitly
   *  report this key forces `false`. `false` survives hydration into the reducer's
   *  aggregate state, and threshold evaluation then refuses to decide gates on the
   *  undercounting series (`"series-incomplete"` unevaluable). Artifact v1 rows carry
   *  no slot for it — it gates evaluability, not display. */
  complete: boolean;
  /** D1 (reserved): threshold-pinned series — compile-time pinned keys every worker
   *  must explicitly report, even with zero observations. Unset in D0. */
  pinned?: boolean;
}

/** A declared custom metric, folded per tag-series plus the untagged total. */
export interface LoadPartialCustomMetricV1 {
  metricId: string;
  kind: LoadMetricKind;
  unit?: string;
  /** Untagged total — EXACT by construction (every observation folds into it). */
  total: LoadPartialCustomSeriesV1;
  series: LoadPartialCustomSeriesV1[];
  /** True once the per-metric series cap was hit and overflow folded into the total. */
  seriesTruncated: boolean;
  /** D1 (reserved): distinct tag keys dropped by EVERY worker (invisible to the series
   *  union — only a metric-level count can expose them, §7.3). Unset in D0: the reducer
   *  does not track distinct dropped keys (that would need unbounded memory — exactly
   *  the high-cardinality case the cap defends against); D1's pinned-series protocol
   *  supplies it. */
  droppedSeriesCount?: number;
}

export interface LoadPartialScenarioV1 {
  scenarioId: string;
  scenarioRefId?: string;
  iterations: number;
  successful: number;
  failed: number;
  latency: LoadHistogramJSON;
}

export interface LoadPartialStepV1 {
  scenarioId: string;
  scenarioRefId?: string;
  stepId: string;
  stepName: string;
  groupId?: string;
  phase: Phase;
  invocationCount: number;
  skippedCount: number;
  assertionFailureCount: number;
  errorCount: number;
  requestCount: number;
  latency: LoadHistogramJSON;
}

export interface LoadPartialEndpointV1 {
  routeKey: string;
  phase?: Phase;
  routeKeySource: LoadRouteKeySource;
  routeKeyHeuristic: boolean;
  method?: string;
  requestCount: number;
  errorCount: number;
  statusCounts: Record<string, number>;
  latency: LoadHistogramJSON;
}

export interface LoadPartialMatrixCellV1 {
  scenarioId: string;
  scenarioRefId?: string;
  stepId?: string;
  phase?: Phase;
  routeKey: string;
  routeKeySource: LoadRouteKeySource;
  routeKeyHeuristic: boolean;
  requestCount: number;
  errorCount: number;
  latency: LoadHistogramJSON;
}

/** Retained (bounded) samples with their caps — the same shape `LoadArtifactSamples`
 *  uses, restated here so the wire schema is self-contained. */
export interface LoadPartialSamplesV1 {
  maxFailureTraces: number;
  maxSlowTransactionSummaries: number;
  failureTraces: LoadFailureTraceSample[];
  slowTransactions: LoadSlowTransactionSummary[];
}

/**
 * Versioned, JSON-serializable export of a load reducer's complete aggregate state
 * (§7.5). Everything `finalize()` / `snapshot()` read is present — see
 * `LoadReducerImpl.exportPartial` for the (documented) transient exclusions. Envelope:
 * `{v, observedAt, liveInFlight, workerId?, timelineOrigin?}` (§7.1's cumulative
 * snapshot body; the transport framing fields land with the D1 wire protocol).
 */
export interface LoadReducerPartialV1 {
  v: 1;
  /** Epoch ms SNAPSHOT INSTANT — the snapshot's observation cutoff (timeline censoring
   *  anchors here; open producer-slot occupancy integrates up to it). Same clock domain
   *  as `LoadEvent.ts`. Supplied by the exporter's caller (`exportPartial(observedAtMs)`
   *  — a D1 periodic exporter passes its `now()`); the `lastTs` fallback is only exact
   *  when there is no trailing event-free gap. Always ≥ `lastTs` (validated). */
  observedAt: number;
  /** Live in-flight iteration count at the snapshot instant (started − completed). */
  liveInFlight: number;
  /** Shard identity (absent on single-process runs; a merged partial keeps it only if
   *  every part agreed — i.e. never across real workers). */
  workerId?: string;
  /** The shared run axis origin (epoch ms) every offset in this payload is computed
   *  against; absent → offsets anchor to `firstTs` (single-process semantics). */
  timelineOrigin?: number;
  /** Number of worker frames folded into this partial. ABSENT on a worker's own
   *  export (a raw single-worker frame); STAMPED by `mergePartials` (Σ of each
   *  part's workerCount, absent = 1) — presence marks a coordinator-merged
   *  aggregate. `finalizeMerged` reports it as `runtime.execution.workerCount` and
   *  refuses to finalize a multi-worker frame without an explicit provider (the
   *  artifact must not claim in-process provenance for a sharded run, schema v2). */
  workerCount?: number;
  /** Feeder-state guarantee of the run segment this frame describes (mirrors
   *  `runtime.feederGuarantee`, schema v2). A worker's own export stamps
   *  `"single-node"` (the current single-machine semantics; the D1 shard runner
   *  stamps its real guarantee). Merge: WEAKEST wins — `single-node` (strongest) →
   *  `distributed` → `degraded` (weakest). Optional for same-version additive
   *  compatibility: absent reads as `"single-node"`. */
  feederGuarantee?: LoadFeederGuarantee;

  runnerId: string;
  /** Resolved config as seen on `load:start` (opaque passthrough — the coordinator owns
   *  the authoritative global config; merge rule is REPLACE-with-first). */
  config?: LoadResolvedConfig;
  requestedConcurrency: number;
  endReason?: LoadEndReason;
  crash?: LoadCrashSummary;
  firstTs?: number;
  lastTs: number;

  iterStarted: number;
  iterCompleted: number;
  iterSucceeded: number;
  iterFailed: number;
  iterLatency: LoadHistogramJSON;

  primaryBoundaries: number;
  failedBeforePrimary: number;
  endedWithoutBoundary: number;
  primaryLatency: LoadHistogramJSON;

  releasedProducerSlots: number;
  rejectedReleaseSignals: number;
  duplicateReleaseSignals: number;
  maxContinuationBacklog: number;
  continuationBackpressure: LoadHistogramJSON;
  /** Released iterations still in their continuation phase at the snapshot (COUNT — the
   *  ids are per-worker transients; the count drives interrupted-run reporting). */
  liveContinuations: number;
  /** Producers parked on a full backlog at the snapshot (count, same rationale). */
  pendingReleases: number;

  scenarios: LoadPartialScenarioV1[];
  steps: LoadPartialStepV1[];
  endpoints: LoadPartialEndpointV1[];
  matrix: LoadPartialMatrixCellV1[];
  customMetrics: LoadPartialCustomMetricV1[];
  /** Live-progress failure ring (most recent ≤ 100, ascending `atMs`). */
  recentFailures: LoadFailureSummary[];

  timeline: LoadTimelineJSON;
  /** Per-window producer-slot busy-ms — the §6.2 pressure-conformance NUMERATOR (open
   *  slot spans integrated up to `observedAt` at export). D0 produces the data only;
   *  the conformance verdict is the D1 coordinator's. */
  slotBusy: SlotBusyWindowsJSON;
  samples: LoadPartialSamplesV1;

  /** EXTRA advisories from outside the reducer (sink/orchestrator-level, stamped by the
   *  D1 shard runner). Reducer-derivable advisories are NOT duplicated here — they are
   *  re-derived from the hydrated state at finalize. Merge: union, de-duplicated. */
  advisories: string[];
  /** Attribution quality as derivable at export time. Merge: per-facet WEAKEST;
   *  `finalizeMerged` overlays it over the hydrated finalize's own derivation. */
  attribution: LoadAttributionReport;
}

// ── validation ────────────────────────────────────────────────────────────

function fail(field: string, want: string, got: unknown): never {
  throw new Error(`LoadReducerPartial: ${field} must be ${want}, got ${JSON.stringify(got)}`);
}

function asDict(v: unknown, field: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(field, "an object", v);
  return v as Record<string, unknown>;
}

function asArray(v: unknown, field: string): unknown[] {
  if (!Array.isArray(v)) fail(field, "an array", v);
  return v;
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string") fail(field, "a string", v);
  return v;
}

function optString(v: unknown, field: string): void {
  if (v !== undefined) asString(v, field);
}

function asBool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") fail(field, "a boolean", v);
  return v;
}

function nonNegSafeInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    fail(field, "a non-negative safe integer", v);
  }
  return v;
}

function finiteNonNeg(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    fail(field, "a non-negative finite number", v);
  }
  return v;
}

function finiteNum(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(field, "a finite number", v);
  return v;
}

const PHASES: readonly Phase[] = ["primary", "continuation"];
function asPhase(v: unknown, field: string): Phase {
  if (v !== "primary" && v !== "continuation") fail(field, `one of ${JSON.stringify(PHASES)}`, v);
  return v;
}

const ROUTE_KEY_SOURCES: readonly LoadRouteKeySource[] = [
  "explicit",
  "catalog",
  "contract-metadata",
  "normalized-url",
];
function asRouteKeySource(v: unknown, field: string): LoadRouteKeySource {
  if (!ROUTE_KEY_SOURCES.includes(v as LoadRouteKeySource)) {
    fail(field, `one of ${JSON.stringify(ROUTE_KEY_SOURCES)}`, v);
  }
  return v as LoadRouteKeySource;
}

const METRIC_KINDS: readonly LoadMetricKind[] = ["rate", "trend", "counter"];
const END_REASONS: readonly LoadEndReason[] = ["duration", "iterations", "abort", "crash"];
/** Ordered strongest → weakest; the merge takes the weakest (highest index). */
const FEEDER_GUARANTEES: readonly LoadFeederGuarantee[] = ["single-node", "distributed", "degraded"];
const CRASH_KINDS = ["uncaughtException", "unhandledRejection", "runnerCrash", "adapterCrash"];
const ATTRIBUTION_QUALITIES: readonly LoadAttributionQuality[] = [
  "canonical",
  "tagged",
  "heuristic",
  "aggregate-only",
  "unsupported",
];
const ATTRIBUTION_FACETS = ["scenario", "step", "endpoint", "phase", "iteration", "failureTrace"] as const;

function validateTags(v: unknown, field: string): Record<string, string> {
  const d = asDict(v, field);
  for (const [k, val] of Object.entries(d)) {
    if (typeof val !== "string") fail(`${field}[${JSON.stringify(k)}]`, "a string", val);
  }
  return d as Record<string, string>;
}

/** Delegate to LoadHistogram.fromJSON (its deep validation comes for free), then pin the
 *  relativeError — the operational invariant hydration/merge folds rely on. */
function validateHistogram(v: unknown, field: string): void {
  try {
    LoadHistogram.fromJSON(v);
  } catch (e) {
    throw new Error(`LoadReducerPartial: ${field}: ${(e as Error).message}`);
  }
  const rel = (v as Record<string, unknown>).relativeError;
  if (rel !== PARTIAL_HISTOGRAM_RELATIVE_ERROR) {
    throw new Error(
      `LoadReducerPartial: ${field} relativeError ${JSON.stringify(rel)} is not the partial protocol's pinned ${PARTIAL_HISTOGRAM_RELATIVE_ERROR}`,
    );
  }
}

function validateSeries(v: unknown, kind: LoadMetricKind, field: string): void {
  const s = asDict(v, field);
  validateTags(s.tags, `${field}.tags`);
  nonNegSafeInt(s.count, `${field}.count`);
  nonNegSafeInt(s.trueCount, `${field}.trueCount`);
  finiteNum(s.sum, `${field}.sum`);
  asBool(s.complete, `${field}.complete`);
  if (s.pinned !== undefined) asBool(s.pinned, `${field}.pinned`);
  if (kind === "trend") {
    if (s.hist === undefined) fail(`${field}.hist`, "present for a trend metric", s.hist);
    validateHistogram(s.hist, `${field}.hist`);
  } else if (s.hist !== undefined) {
    fail(`${field}.hist`, `absent for a ${kind} metric`, s.hist);
  }
}

function validateSampleIdentity(v: unknown, field: string): void {
  const d = asDict(v, field);
  asString(d.scenarioId, `${field}.scenarioId`);
  optString(d.scenarioRefId, `${field}.scenarioRefId`);
  asString(d.producerSlotId, `${field}.producerSlotId`);
  asString(d.iterationId, `${field}.iterationId`);
  optString(d.workerId, `${field}.workerId`);
}

/**
 * Validate an unknown payload as a `LoadReducerPartialV1`; returns the SAME object,
 * typed (no copy). Throws with the offending field on any malformed or unknown-version
 * frame — the caller rejects the FRAME and decides lost semantics (§7.4/§7.5); never
 * coerces silently. Depth per the module trust model: version, structure/types,
 * non-negative safe-integer counts, canonical row uniqueness, and the deep sub-payload
 * checks delegated to the histogram / timeline / slot-busy `fromJSON`s. `config` and
 * `crash` are shallow-checked passthroughs (the coordinator owns the authoritative
 * config; a crash summary is display data). Sample OBSERVATION entries are structural
 * passthroughs (their previews are bounded arbitrary JSON by construction).
 */
export function parseLoadReducerPartial(json: unknown): LoadReducerPartialV1 {
  const p = asDict(json, "payload");
  // Version first: an unknown version must fail as such, not as random shape drift.
  if (p.v !== 1) {
    throw new Error(
      `LoadReducerPartial: unsupported payload version ${JSON.stringify(p.v)} (expected 1)`,
    );
  }
  const observedAt = finiteNonNeg(p.observedAt, "observedAt");
  nonNegSafeInt(p.liveInFlight, "liveInFlight");
  optString(p.workerId, "workerId");
  if (p.timelineOrigin !== undefined) finiteNum(p.timelineOrigin, "timelineOrigin");
  if (p.workerCount !== undefined) {
    if (typeof p.workerCount !== "number" || !Number.isSafeInteger(p.workerCount) || p.workerCount < 1) {
      fail("workerCount", "a positive safe integer", p.workerCount);
    }
  }
  if (p.feederGuarantee !== undefined && !FEEDER_GUARANTEES.includes(p.feederGuarantee as LoadFeederGuarantee)) {
    fail("feederGuarantee", `one of ${JSON.stringify(FEEDER_GUARANTEES)}`, p.feederGuarantee);
  }
  asString(p.runnerId, "runnerId");
  if (p.config !== undefined) {
    const c = asDict(p.config, "config");
    finiteNum(c.concurrency, "config.concurrency");
  }
  nonNegSafeInt(p.requestedConcurrency, "requestedConcurrency");
  if (p.endReason !== undefined && !END_REASONS.includes(p.endReason as LoadEndReason)) {
    fail("endReason", `one of ${JSON.stringify(END_REASONS)}`, p.endReason);
  }
  if (p.crash !== undefined) {
    const c = asDict(p.crash, "crash");
    if (!CRASH_KINDS.includes(c.kind as string)) fail("crash.kind", `one of ${JSON.stringify(CRASH_KINDS)}`, c.kind);
    asString(c.message, "crash.message");
    finiteNum(c.atMs, "crash.atMs");
  }
  const lastTs = finiteNonNeg(p.lastTs, "lastTs");
  if (p.firstTs !== undefined) {
    const firstTs = finiteNonNeg(p.firstTs, "firstTs");
    if (firstTs > lastTs) fail("firstTs", `at or before lastTs ${lastTs}`, firstTs);
  }
  if (observedAt < lastTs) {
    // observedAt is the snapshot's observation cutoff — it can sit AT the last event
    // (this exporter) or after it (a D1 serialization instant), never before.
    fail("observedAt", `at or after lastTs ${lastTs}`, observedAt);
  }

  nonNegSafeInt(p.iterStarted, "iterStarted");
  nonNegSafeInt(p.iterCompleted, "iterCompleted");
  nonNegSafeInt(p.iterSucceeded, "iterSucceeded");
  nonNegSafeInt(p.iterFailed, "iterFailed");
  validateHistogram(p.iterLatency, "iterLatency");
  nonNegSafeInt(p.primaryBoundaries, "primaryBoundaries");
  nonNegSafeInt(p.failedBeforePrimary, "failedBeforePrimary");
  nonNegSafeInt(p.endedWithoutBoundary, "endedWithoutBoundary");
  validateHistogram(p.primaryLatency, "primaryLatency");
  nonNegSafeInt(p.releasedProducerSlots, "releasedProducerSlots");
  nonNegSafeInt(p.rejectedReleaseSignals, "rejectedReleaseSignals");
  nonNegSafeInt(p.duplicateReleaseSignals, "duplicateReleaseSignals");
  nonNegSafeInt(p.maxContinuationBacklog, "maxContinuationBacklog");
  validateHistogram(p.continuationBackpressure, "continuationBackpressure");
  nonNegSafeInt(p.liveContinuations, "liveContinuations");
  nonNegSafeInt(p.pendingReleases, "pendingReleases");

  const scenarioKeys = new Set<string>();
  for (const [i, raw] of asArray(p.scenarios, "scenarios").entries()) {
    const f = `scenarios[${i}]`;
    const s = asDict(raw, f);
    asString(s.scenarioId, `${f}.scenarioId`);
    optString(s.scenarioRefId, `${f}.scenarioRefId`);
    nonNegSafeInt(s.iterations, `${f}.iterations`);
    nonNegSafeInt(s.successful, `${f}.successful`);
    nonNegSafeInt(s.failed, `${f}.failed`);
    validateHistogram(s.latency, `${f}.latency`);
    const key = `${s.scenarioId}${SEP}${s.scenarioRefId ?? ""}`;
    if (scenarioKeys.has(key)) fail(f, "unique per (scenarioId, scenarioRefId)", s.scenarioId);
    scenarioKeys.add(key);
  }
  const stepKeys = new Set<string>();
  for (const [i, raw] of asArray(p.steps, "steps").entries()) {
    const f = `steps[${i}]`;
    const s = asDict(raw, f);
    asString(s.scenarioId, `${f}.scenarioId`);
    optString(s.scenarioRefId, `${f}.scenarioRefId`);
    asString(s.stepId, `${f}.stepId`);
    asString(s.stepName, `${f}.stepName`);
    optString(s.groupId, `${f}.groupId`);
    asPhase(s.phase, `${f}.phase`);
    nonNegSafeInt(s.invocationCount, `${f}.invocationCount`);
    nonNegSafeInt(s.skippedCount, `${f}.skippedCount`);
    nonNegSafeInt(s.assertionFailureCount, `${f}.assertionFailureCount`);
    nonNegSafeInt(s.errorCount, `${f}.errorCount`);
    nonNegSafeInt(s.requestCount, `${f}.requestCount`);
    validateHistogram(s.latency, `${f}.latency`);
    const key = `${s.scenarioId}${SEP}${s.scenarioRefId ?? ""}${SEP}${s.stepId}${SEP}${s.phase}`;
    if (stepKeys.has(key)) fail(f, "unique per (scenario, stepId, phase)", s.stepId);
    stepKeys.add(key);
  }
  const endpointKeys = new Set<string>();
  for (const [i, raw] of asArray(p.endpoints, "endpoints").entries()) {
    const f = `endpoints[${i}]`;
    const e = asDict(raw, f);
    asString(e.routeKey, `${f}.routeKey`);
    if (e.phase !== undefined) asPhase(e.phase, `${f}.phase`);
    asRouteKeySource(e.routeKeySource, `${f}.routeKeySource`);
    asBool(e.routeKeyHeuristic, `${f}.routeKeyHeuristic`);
    optString(e.method, `${f}.method`);
    nonNegSafeInt(e.requestCount, `${f}.requestCount`);
    nonNegSafeInt(e.errorCount, `${f}.errorCount`);
    const sc = asDict(e.statusCounts, `${f}.statusCounts`);
    for (const [k, v] of Object.entries(sc)) nonNegSafeInt(v, `${f}.statusCounts[${JSON.stringify(k)}]`);
    validateHistogram(e.latency, `${f}.latency`);
    const key = `${e.routeKey}${SEP}${(e.phase as string | undefined) ?? ""}`;
    if (endpointKeys.has(key)) fail(f, "unique per (routeKey, phase)", e.routeKey);
    endpointKeys.add(key);
  }
  const matrixKeys = new Set<string>();
  for (const [i, raw] of asArray(p.matrix, "matrix").entries()) {
    const f = `matrix[${i}]`;
    const m = asDict(raw, f);
    asString(m.scenarioId, `${f}.scenarioId`);
    optString(m.scenarioRefId, `${f}.scenarioRefId`);
    optString(m.stepId, `${f}.stepId`);
    if (m.phase !== undefined) asPhase(m.phase, `${f}.phase`);
    asString(m.routeKey, `${f}.routeKey`);
    asRouteKeySource(m.routeKeySource, `${f}.routeKeySource`);
    asBool(m.routeKeyHeuristic, `${f}.routeKeyHeuristic`);
    nonNegSafeInt(m.requestCount, `${f}.requestCount`);
    nonNegSafeInt(m.errorCount, `${f}.errorCount`);
    validateHistogram(m.latency, `${f}.latency`);
    const key = `${m.scenarioId}${SEP}${m.scenarioRefId ?? ""}${SEP}${m.stepId ?? ""}${SEP}${m.routeKey}${SEP}${(m.phase as string | undefined) ?? ""}`;
    if (matrixKeys.has(key)) fail(f, "unique per (scenario, stepId, routeKey, phase)", m.routeKey);
    matrixKeys.add(key);
  }
  const metricIds = new Set<string>();
  for (const [i, raw] of asArray(p.customMetrics, "customMetrics").entries()) {
    const f = `customMetrics[${i}]`;
    const m = asDict(raw, f);
    const metricId = asString(m.metricId, `${f}.metricId`);
    if (!METRIC_KINDS.includes(m.kind as LoadMetricKind)) {
      fail(`${f}.kind`, `one of ${JSON.stringify(METRIC_KINDS)}`, m.kind);
    }
    const kind = m.kind as LoadMetricKind;
    optString(m.unit, `${f}.unit`);
    validateSeries(m.total, kind, `${f}.total`);
    const totalTags = (m.total as Record<string, unknown>).tags as Record<string, string>;
    if (Object.keys(totalTags).length !== 0) {
      fail(`${f}.total.tags`, "empty (the untagged total)", totalTags);
    }
    asBool(m.seriesTruncated, `${f}.seriesTruncated`);
    if (m.droppedSeriesCount !== undefined) nonNegSafeInt(m.droppedSeriesCount, `${f}.droppedSeriesCount`);
    const seriesKeys = new Set<string>();
    for (const [j, sRaw] of asArray(m.series, `${f}.series`).entries()) {
      validateSeries(sRaw, kind, `${f}.series[${j}]`);
      const tags = (sRaw as Record<string, unknown>).tags as Record<string, string>;
      // An untagged entry inside `series` would collide with `total` after hydration
      // (two untagged aggregates behind different lookup paths — the tag-keyed map vs
      // the total slot). The untagged total's ONLY home is `total`; the canonical
      // encoder never emits `{}` here (codex R3).
      if (Object.keys(tags).length === 0) {
        fail(
          `${f}.series[${j}].tags`,
          "a non-empty tag combination (the untagged total lives in `total`, never in `series`)",
          tags,
        );
      }
      const key = canonicalTagKey(tags);
      if (seriesKeys.has(key)) fail(`${f}.series[${j}]`, "unique per tag combination", key);
      seriesKeys.add(key);
    }
    if (metricIds.has(metricId)) fail(`${f}.metricId`, "unique", metricId);
    metricIds.add(metricId);
  }

  const recentFailures = asArray(p.recentFailures, "recentFailures");
  if (recentFailures.length > MAX_RECENT_FAILURES) {
    fail("recentFailures", `at most ${MAX_RECENT_FAILURES} entries (the reducer's ring bound)`, recentFailures.length);
  }
  for (const [i, raw] of recentFailures.entries()) {
    const f = `recentFailures[${i}]`;
    const r = asDict(raw, f);
    asString(r.iterationId, `${f}.iterationId`);
    finiteNonNeg(r.atMs, `${f}.atMs`);
    optString(r.scenarioId, `${f}.scenarioId`);
    optString(r.scenarioRefId, `${f}.scenarioRefId`);
    optString(r.errorKind, `${f}.errorKind`);
    optString(r.failedStepName, `${f}.failedStepName`);
    optString(r.message, `${f}.message`);
  }

  try {
    LoadTimeline.fromJSON(p.timeline);
  } catch (e) {
    throw new Error(`LoadReducerPartial: timeline: ${(e as Error).message}`);
  }
  try {
    SlotBusyWindows.fromJSON(p.slotBusy);
  } catch (e) {
    throw new Error(`LoadReducerPartial: slotBusy: ${(e as Error).message}`);
  }

  const samples = asDict(p.samples, "samples");
  const maxFailureTraces = nonNegSafeInt(samples.maxFailureTraces, "samples.maxFailureTraces");
  const maxSlow = nonNegSafeInt(samples.maxSlowTransactionSummaries, "samples.maxSlowTransactionSummaries");
  const failureTraces = asArray(samples.failureTraces, "samples.failureTraces");
  if (failureTraces.length > maxFailureTraces) {
    fail("samples.failureTraces", `at most maxFailureTraces (${maxFailureTraces}) entries`, failureTraces.length);
  }
  for (const [i, raw] of failureTraces.entries()) {
    const f = `samples.failureTraces[${i}]`;
    const t = asDict(raw, f);
    validateSampleIdentity(t.identity, `${f}.identity`);
    if (t.completedAtOffsetMs !== undefined) finiteNonNeg(t.completedAtOffsetMs, `${f}.completedAtOffsetMs`);
    finiteNonNeg(t.durationMs, `${f}.durationMs`);
    for (const [j, o] of asArray(t.observations, `${f}.observations`).entries()) {
      asDict(o, `${f}.observations[${j}]`); // bounded preview payloads — structural passthrough
    }
    asBool(t.truncated, `${f}.truncated`);
    nonNegSafeInt(t.droppedObservationCount, `${f}.droppedObservationCount`);
  }
  const slowTransactions = asArray(samples.slowTransactions, "samples.slowTransactions");
  if (slowTransactions.length > maxSlow) {
    fail("samples.slowTransactions", `at most maxSlowTransactionSummaries (${maxSlow}) entries`, slowTransactions.length);
  }
  for (const [i, raw] of slowTransactions.entries()) {
    const f = `samples.slowTransactions[${i}]`;
    const t = asDict(raw, f);
    validateSampleIdentity(t.identity, `${f}.identity`);
    if (t.completedAtOffsetMs !== undefined) finiteNonNeg(t.completedAtOffsetMs, `${f}.completedAtOffsetMs`);
    finiteNonNeg(t.durationMs, `${f}.durationMs`);
    for (const [j, raw2] of asArray(t.topEndpoints, `${f}.topEndpoints`).entries()) {
      const ep = asDict(raw2, `${f}.topEndpoints[${j}]`);
      asString(ep.routeKey, `${f}.topEndpoints[${j}].routeKey`);
      finiteNonNeg(ep.durationMs, `${f}.topEndpoints[${j}].durationMs`);
    }
    if (t.truncated !== false) fail(`${f}.truncated`, "false (slow summaries are never truncated)", t.truncated);
  }

  for (const [i, a] of asArray(p.advisories, "advisories").entries()) {
    asString(a, `advisories[${i}]`);
  }
  const attribution = asDict(p.attribution, "attribution");
  for (const facet of ATTRIBUTION_FACETS) {
    if (!ATTRIBUTION_QUALITIES.includes(attribution[facet] as LoadAttributionQuality)) {
      fail(`attribution.${facet}`, `one of ${JSON.stringify(ATTRIBUTION_QUALITIES)}`, attribution[facet]);
    }
  }
  if (attribution.notes !== undefined) {
    for (const [i, n] of asArray(attribution.notes, "attribution.notes").entries()) {
      asString(n, `attribution.notes[${i}]`);
    }
  }

  return p as unknown as LoadReducerPartialV1;
}

// ── merge (§7.2 / §7.3) ───────────────────────────────────────────────────

/** Pre-mutation safe-integer guard for count sums — same refusal the histogram /
 *  timeline merges apply (the bound is physically unreachable for a real run). */
function guardedSum(what: string, a: number, b: number): number {
  if (a + b > Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `mergePartials: combined ${what} ${a} + ${b} exceeds MAX_SAFE_INTEGER (physically unreachable for a real run — see LoadHistogram's count domain contract)`,
    );
  }
  return a + b;
}

/** Global endReason priority (§7.4): crash > abort > duration > iterations. */
const END_REASON_PRIORITY: Record<LoadEndReason, number> = {
  crash: 3,
  abort: 2,
  duration: 1,
  iterations: 0,
};

const ATTRIBUTION_WEAKNESS: Record<LoadAttributionQuality, number> = {
  canonical: 0,
  tagged: 1,
  heuristic: 2,
  "aggregate-only": 3,
  unsupported: 4,
};

function weakest(a: LoadAttributionQuality, b: LoadAttributionQuality): LoadAttributionQuality {
  return ATTRIBUTION_WEAKNESS[a] >= ATTRIBUTION_WEAKNESS[b] ? a : b;
}

/** Per-facet weakest of two attribution reports; notes union-deduped. */
function weakestReport(a: LoadAttributionReport, b: LoadAttributionReport): LoadAttributionReport {
  const notes = [...(a.notes ?? [])];
  for (const n of b.notes ?? []) if (!notes.includes(n)) notes.push(n);
  return {
    scenario: weakest(a.scenario, b.scenario),
    step: weakest(a.step, b.step),
    endpoint: weakest(a.endpoint, b.endpoint),
    phase: weakest(a.phase, b.phase),
    iteration: weakest(a.iteration, b.iteration),
    failureTrace: weakest(a.failureTrace, b.failureTrace),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/** Fold the (routeKeyHeuristic, routeKeySource) pair of two rows sharing one key —
 *  the reducer's own rule (any heuristic observation makes the aggregate heuristic and
 *  adopts the heuristic source), so divide-and-merge matches a single reducer over the
 *  union stream. A conflict the fold cannot explain — same heuristic flag, different
 *  sources — is a genuine cross-worker disagreement: assert-equal-else-reject (§7.5). */
function foldRouteKeyProvenance(
  key: string,
  a: { routeKeySource: LoadRouteKeySource; routeKeyHeuristic: boolean },
  b: { routeKeySource: LoadRouteKeySource; routeKeyHeuristic: boolean },
): { routeKeySource: LoadRouteKeySource; routeKeyHeuristic: boolean } {
  if (a.routeKeyHeuristic === b.routeKeyHeuristic) {
    if (a.routeKeySource !== b.routeKeySource) {
      throw new Error(
        `mergePartials: routeKeySource conflict for ${JSON.stringify(key)}: ${a.routeKeySource} vs ${b.routeKeySource} (assert-equal-else-reject)`,
      );
    }
    return { routeKeySource: a.routeKeySource, routeKeyHeuristic: a.routeKeyHeuristic };
  }
  const heuristicSide = a.routeKeyHeuristic ? a : b;
  return { routeKeySource: heuristicSide.routeKeySource, routeKeyHeuristic: true };
}

/**
 * Fold N workers' partials into ONE merged partial — the coordinator's report-time
 * aggregation (§7.5: fold the last valid snapshot of every worker ONCE; this is a
 * one-shot fold over per-worker exports, not an incremental accumulator).
 *
 * Every part is validated first (`parseLoadReducerPartial`); a bad frame throws with
 * its index and the merge REJECTS WHOLE — inputs are never mutated (the output is
 * built fresh throughout), so a failed merge leaves no half-merged state and the
 * caller can drop the offending worker's frame (lost semantics, §7.4) and re-merge.
 *
 * Field rules (§7.2/§7.3): counts sum (safe-integer guarded); min(firstTs) /
 * max(lastTs, observedAt, maxContinuationBacklog); histograms merge; timeline
 * `mergeAll` with per-part censoring at `opts.observationCutoffsMs[i] ?? observedAt`
 * (epoch ms — pass the coordinator's `globalEndAt` for a worker KNOWN to have finished
 * cleanly to avoid conservative `contributorsPartial` marks; an instant EARLIER than
 * the frame's observedAt is a caller contradiction and is REJECTED — a frame's own
 * coverage is its floor); slot-busy windows sum (no
 * censoring — a lost worker's occupancy simply stops, which under-counts the
 * conformance numerator: the conservative direction); samples re-sort under the shared
 * total orders and truncate to the (assert-equal) caps; custom metrics per §7.3 (same
 * key sums; kind/unit assert-equal-else-reject; metric-level `seriesTruncated` ORs;
 * per-series `complete` is conservative — any truncated worker that did not explicitly
 * report the key forces false); routeKey provenance folds by the reducer's own rule
 * with genuine conflicts rejected; advisories union-dedup; attribution per-facet
 * weakest; endReason by §7.4 priority; `config` REPLACE-with-first (the D1 coordinator
 * owns the authoritative global config); requestedConcurrency sums (the physical total
 * across workers); `workerCount` is STAMPED on the output (Σ of each part's, absent =
 * 1 — marks the frame as a coordinator-merged aggregate for `finalizeMerged`'s
 * provenance rules); `feederGuarantee` takes the weakest across parts (absent reads
 * as `"single-node"`).
 *
 * Multi-part merges REQUIRE a shared explicit `timelineOrigin` on every part (same
 * check the timeline itself cannot do — offsets carry no epoch); a single part passes
 * through unchanged rules with its own axis.
 */
export function mergePartials(
  parts: ReadonlyArray<LoadReducerPartialV1>,
  opts: { observationCutoffsMs?: ReadonlyArray<number | undefined> } = {},
): LoadReducerPartialV1 {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error("mergePartials: needs at least one part");
  }
  if (opts.observationCutoffsMs !== undefined && opts.observationCutoffsMs.length !== parts.length) {
    throw new Error(
      `mergePartials: observationCutoffsMs length ${opts.observationCutoffsMs.length} does not match parts length ${parts.length}`,
    );
  }
  const ps = parts.map((part, i) => {
    try {
      return parseLoadReducerPartial(part);
    } catch (e) {
      throw new Error(`mergePartials: part ${i}: ${(e as Error).message}`);
    }
  });

  // Cutoff overrides can only EXTEND a frame's observation claim (a clean-finish
  // worker censored at the coordinator's globalEndAt), never narrow it: `observedAt`
  // is the frame's coverage FLOOR — the snapshot was taken at that instant and holds
  // everything observed up to it, so an earlier cutoff is a caller contradiction, not
  // data (same misuse philosophy as LoadTimeline's cutoff-vs-coverage guard). Checked
  // here, before any fold work — an event-free trailing gap (think time / backlog
  // waits) would otherwise let an invalid cutoff slip past the timeline's own
  // window-resolution guard, prematurely closing in-flight iterations and marking
  // observed windows contributorsPartial (codex R2 P2-2).
  if (opts.observationCutoffsMs !== undefined) {
    for (const [i, cutoff] of opts.observationCutoffsMs.entries()) {
      if (cutoff === undefined) continue;
      if (!Number.isFinite(cutoff)) {
        throw new Error(`mergePartials: observationCutoffsMs[${i}] must be finite, got ${cutoff}`);
      }
      if (cutoff < ps[i].observedAt) {
        throw new Error(
          `mergePartials: observationCutoffsMs[${i}] ${cutoff} predates the part's observation coverage (observedAt ${ps[i].observedAt}) — the cutoff must be at or after the frame's snapshot instant (it can extend the claim, never narrow it)`,
        );
      }
    }
  }

  // Cross-part envelope agreement.
  if (ps.length > 1) {
    for (const [i, p] of ps.entries()) {
      if (p.timelineOrigin === undefined) {
        throw new Error(
          `mergePartials: part ${i} has no timelineOrigin — merging multiple parts requires the shared explicit run axis (proposal §7.3)`,
        );
      }
      if (p.timelineOrigin !== ps[0].timelineOrigin) {
        throw new Error(
          `mergePartials: timelineOrigin mismatch (part 0: ${ps[0].timelineOrigin}, part ${i}: ${p.timelineOrigin}) — all parts must share one run axis`,
        );
      }
    }
  }
  let runnerId = "";
  for (const [i, p] of ps.entries()) {
    if (p.runnerId === "") continue;
    if (runnerId === "") runnerId = p.runnerId;
    else if (p.runnerId !== runnerId) {
      throw new Error(
        `mergePartials: runnerId conflict (${JSON.stringify(runnerId)} vs part ${i}'s ${JSON.stringify(p.runnerId)}) — parts of one run share the plan identity`,
      );
    }
  }
  for (const [i, p] of ps.entries()) {
    if (
      p.samples.maxFailureTraces !== ps[0].samples.maxFailureTraces ||
      p.samples.maxSlowTransactionSummaries !== ps[0].samples.maxSlowTransactionSummaries
    ) {
      throw new Error(
        `mergePartials: sample cap mismatch at part ${i} — same-version workers of one run share the report caps (assert-equal-else-reject)`,
      );
    }
  }

  const sum = (what: string, get: (p: LoadReducerPartialV1) => number): number =>
    ps.reduce((acc, p) => guardedSum(what, acc, get(p)), 0);
  const mergeHists = (get: (p: LoadReducerPartialV1) => LoadHistogramJSON): LoadHistogramJSON => {
    const h = LoadHistogram.fromJSON(get(ps[0]));
    for (const p of ps.slice(1)) h.merge(LoadHistogram.fromJSON(get(p)));
    return h.toJSON();
  };

  // endReason by global priority; the crash summary rides with the first part that has
  // one (a crash endReason always outranks, so a crash part's summary is never dropped
  // in favor of a crash-less reason).
  let endReason: LoadEndReason | undefined;
  for (const p of ps) {
    if (p.endReason === undefined) continue;
    if (endReason === undefined || END_REASON_PRIORITY[p.endReason] > END_REASON_PRIORITY[endReason]) {
      endReason = p.endReason;
    }
  }
  const crash = ps.find((p) => p.crash !== undefined)?.crash;
  const config = ps.find((p) => p.config !== undefined)?.config;
  const firstTsList = ps.filter((p) => p.firstTs !== undefined).map((p) => p.firstTs as number);
  const firstTs = firstTsList.length > 0 ? Math.min(...firstTsList) : undefined;
  const observedAt = Math.max(...ps.map((p) => p.observedAt));
  const lastTs = Math.max(...ps.map((p) => p.lastTs));
  const workerIds = new Set(ps.map((p) => p.workerId));
  const workerId = workerIds.size === 1 ? ps[0].workerId : undefined;
  // Coordinator-merge provenance (codex R2 P2-3, schema v2): how many worker frames
  // this aggregate folds (a part may itself be merged — its own count carries), and
  // the WEAKEST feeder guarantee across parts (absent reads as "single-node").
  const workerCount = ps.reduce((n, p) => guardedSum("workerCount", n, p.workerCount ?? 1), 0);
  const feederGuarantee = ps
    .map((p) => p.feederGuarantee ?? "single-node")
    .reduce((a, b) => (FEEDER_GUARANTEES.indexOf(a) >= FEEDER_GUARANTEES.indexOf(b) ? a : b));

  // ── keyed aggregate folds (fresh working maps; inputs untouched) ──
  interface WorkScenario extends Omit<LoadPartialScenarioV1, "latency"> { latency: LoadHistogram }
  const scenarios = new Map<string, WorkScenario>();
  for (const p of ps) {
    for (const s of p.scenarios) {
      const key = `${s.scenarioId}${SEP}${s.scenarioRefId ?? ""}`;
      const cur = scenarios.get(key);
      if (cur === undefined) {
        scenarios.set(key, { ...s, latency: LoadHistogram.fromJSON(s.latency) });
      } else {
        cur.iterations = guardedSum("scenario iterations", cur.iterations, s.iterations);
        cur.successful = guardedSum("scenario successful", cur.successful, s.successful);
        cur.failed = guardedSum("scenario failed", cur.failed, s.failed);
        cur.latency.merge(LoadHistogram.fromJSON(s.latency));
      }
    }
  }
  interface WorkStep extends Omit<LoadPartialStepV1, "latency"> { latency: LoadHistogram }
  const steps = new Map<string, WorkStep>();
  for (const p of ps) {
    for (const s of p.steps) {
      const key = `${s.scenarioId}${SEP}${s.scenarioRefId ?? ""}${SEP}${s.stepId}${SEP}${s.phase}`;
      const cur = steps.get(key);
      if (cur === undefined) {
        steps.set(key, { ...s, latency: LoadHistogram.fromJSON(s.latency) });
      } else {
        cur.invocationCount = guardedSum("step invocationCount", cur.invocationCount, s.invocationCount);
        cur.skippedCount = guardedSum("step skippedCount", cur.skippedCount, s.skippedCount);
        cur.assertionFailureCount = guardedSum("step assertionFailureCount", cur.assertionFailureCount, s.assertionFailureCount);
        cur.errorCount = guardedSum("step errorCount", cur.errorCount, s.errorCount);
        cur.requestCount = guardedSum("step requestCount", cur.requestCount, s.requestCount);
        cur.latency.merge(LoadHistogram.fromJSON(s.latency));
        // Display metadata: prefer a RESOLVED step name (a worker that only saw
        // request:observed carries the stepId placeholder; step:end supplies the name).
        if (cur.stepName === cur.stepId && s.stepName !== s.stepId) cur.stepName = s.stepName;
        if (cur.groupId === undefined && s.groupId !== undefined) cur.groupId = s.groupId;
      }
    }
  }
  interface WorkEndpoint extends Omit<LoadPartialEndpointV1, "latency"> { latency: LoadHistogram }
  const endpoints = new Map<string, WorkEndpoint>();
  for (const p of ps) {
    for (const e of p.endpoints) {
      const key = `${e.routeKey}${SEP}${e.phase ?? ""}`;
      const cur = endpoints.get(key);
      if (cur === undefined) {
        endpoints.set(key, { ...e, statusCounts: { ...e.statusCounts }, latency: LoadHistogram.fromJSON(e.latency) });
      } else {
        const prov = foldRouteKeyProvenance(e.routeKey, cur, e);
        cur.requestCount = guardedSum("endpoint requestCount", cur.requestCount, e.requestCount);
        cur.errorCount = guardedSum("endpoint errorCount", cur.errorCount, e.errorCount);
        for (const [status, n] of Object.entries(e.statusCounts)) {
          cur.statusCounts[status] = guardedSum(`endpoint statusCounts[${status}]`, cur.statusCounts[status] ?? 0, n);
        }
        cur.latency.merge(LoadHistogram.fromJSON(e.latency));
        cur.routeKeySource = prov.routeKeySource;
        cur.routeKeyHeuristic = prov.routeKeyHeuristic;
        if (cur.method === undefined && e.method !== undefined) cur.method = e.method;
      }
    }
  }
  interface WorkMatrix extends Omit<LoadPartialMatrixCellV1, "latency"> { latency: LoadHistogram }
  const matrix = new Map<string, WorkMatrix>();
  for (const p of ps) {
    for (const m of p.matrix) {
      const key = `${m.scenarioId}${SEP}${m.scenarioRefId ?? ""}${SEP}${m.stepId ?? ""}${SEP}${m.routeKey}${SEP}${m.phase ?? ""}`;
      const cur = matrix.get(key);
      if (cur === undefined) {
        matrix.set(key, { ...m, latency: LoadHistogram.fromJSON(m.latency) });
      } else {
        const prov = foldRouteKeyProvenance(m.routeKey, cur, m);
        cur.requestCount = guardedSum("matrix requestCount", cur.requestCount, m.requestCount);
        cur.errorCount = guardedSum("matrix errorCount", cur.errorCount, m.errorCount);
        cur.latency.merge(LoadHistogram.fromJSON(m.latency));
        cur.routeKeySource = prov.routeKeySource;
        cur.routeKeyHeuristic = prov.routeKeyHeuristic;
      }
    }
  }

  // ── custom metrics (§7.3 — the one declared lossy zone) ──
  interface WorkSeries extends Omit<LoadPartialCustomSeriesV1, "hist"> { hist?: LoadHistogram }
  interface WorkMetric {
    metricId: string;
    kind: LoadMetricKind;
    unit?: string;
    total: WorkSeries;
    series: Map<string, WorkSeries>;
    seriesTruncated: boolean;
    droppedSeriesCount?: number;
  }
  const reviveSeries = (s: LoadPartialCustomSeriesV1): WorkSeries => {
    const { hist, ...rest } = s;
    return {
      ...rest,
      tags: { ...s.tags },
      ...(hist !== undefined ? { hist: LoadHistogram.fromJSON(hist) } : {}),
    };
  };
  const foldSeries = (what: string, cur: WorkSeries, s: LoadPartialCustomSeriesV1): void => {
    cur.count = guardedSum(`${what} count`, cur.count, s.count);
    cur.trueCount = guardedSum(`${what} trueCount`, cur.trueCount, s.trueCount);
    cur.sum += s.sum; // float total — additive, no integer domain
    if (cur.hist !== undefined && s.hist !== undefined) cur.hist.merge(LoadHistogram.fromJSON(s.hist));
    cur.complete = cur.complete && s.complete;
    if (s.pinned !== undefined) cur.pinned = (cur.pinned ?? false) || s.pinned;
  };
  const customMetrics = new Map<string, WorkMetric>();
  for (const p of ps) {
    for (const m of p.customMetrics) {
      const cur = customMetrics.get(m.metricId);
      if (cur === undefined) {
        customMetrics.set(m.metricId, {
          metricId: m.metricId,
          kind: m.kind,
          ...(m.unit !== undefined ? { unit: m.unit } : {}),
          total: reviveSeries(m.total),
          series: new Map(m.series.map((s) => [canonicalTagKey(s.tags), reviveSeries(s)])),
          seriesTruncated: m.seriesTruncated,
          ...(m.droppedSeriesCount !== undefined ? { droppedSeriesCount: m.droppedSeriesCount } : {}),
        });
        continue;
      }
      // kind / unit are declaration facts — a disagreement is schema drift between
      // workers, not mergeable data (assert-equal-else-reject, §7.5).
      if (cur.kind !== m.kind) {
        throw new Error(
          `mergePartials: custom metric ${JSON.stringify(m.metricId)} kind conflict: ${cur.kind} vs ${m.kind} (assert-equal-else-reject)`,
        );
      }
      if (cur.unit !== m.unit) {
        throw new Error(
          `mergePartials: custom metric ${JSON.stringify(m.metricId)} unit conflict: ${JSON.stringify(cur.unit)} vs ${JSON.stringify(m.unit)} (assert-equal-else-reject)`,
        );
      }
      foldSeries(`metric ${m.metricId} total`, cur.total, m.total);
      for (const s of m.series) {
        const key = canonicalTagKey(s.tags);
        const curSeries = cur.series.get(key);
        if (curSeries === undefined) cur.series.set(key, reviveSeries(s));
        else foldSeries(`metric ${m.metricId} series`, curSeries, s);
      }
      cur.seriesTruncated = cur.seriesTruncated || m.seriesTruncated;
      if (m.droppedSeriesCount !== undefined) {
        cur.droppedSeriesCount = guardedSum(
          `metric ${m.metricId} droppedSeriesCount`,
          cur.droppedSeriesCount ?? 0,
          m.droppedSeriesCount,
        );
      }
    }
  }
  // Per-series completeness, conservative (§7.3): a TRUNCATED worker may have folded
  // this key's observations into its total invisibly, so unless it explicitly reported
  // the key, the union series is incomplete. A worker without the metric at all saw
  // zero observations of it — exact, not lossy.
  for (const m of customMetrics.values()) {
    for (const [key, series] of m.series) {
      for (const p of ps) {
        const pm = p.customMetrics.find((x) => x.metricId === m.metricId);
        if (pm === undefined || !pm.seriesTruncated) continue;
        if (!pm.series.some((s) => canonicalTagKey(s.tags) === key)) {
          series.complete = false;
          break;
        }
      }
    }
  }

  // ── recentFailures: ascending atMs, keep the most recent ring-capful ──
  const recentFailures = ps
    .flatMap((p) => p.recentFailures)
    .map((f) => structuredClone(f))
    .sort(
      (a, b) =>
        a.atMs - b.atMs ||
        (a.scenarioId ?? "").localeCompare(b.scenarioId ?? "") ||
        a.iterationId.localeCompare(b.iterationId),
    )
    .slice(-MAX_RECENT_FAILURES);

  // ── timeline: one-shot mergeAll with per-part censoring (§7.3) ──
  const timelineParts = ps.map((p, i) => {
    const origin = p.timelineOrigin ?? p.firstTs;
    // Overrides were validated up front (finite, ≥ the part's observedAt).
    const cutoffEpoch = opts.observationCutoffsMs?.[i] ?? p.observedAt;
    return {
      timeline: LoadTimeline.fromJSON(p.timeline),
      // Offset on the part's axis; a part with no origin at all (no injected origin AND
      // zero events) has an empty timeline — cutoff 0 censors nothing.
      observationCutoffMs: Math.max(0, origin !== undefined ? cutoffEpoch - origin : 0),
    };
  });
  const timeline = LoadTimeline.mergeAll(timelineParts).toJSON();

  // ── slot busy: plain per-window sums (occupancy integrals are additive) ──
  const slotBusy = SlotBusyWindows.fromJSON(ps[0].slotBusy);
  for (const p of ps.slice(1)) slotBusy.merge(SlotBusyWindows.fromJSON(p.slotBusy));

  // ── samples: union → shared total orders → cap (§7.2) ──
  const failureTraces = ps
    .flatMap((p) => p.samples.failureTraces)
    .map((s) => structuredClone(s))
    .sort(compareFailure)
    .slice(0, ps[0].samples.maxFailureTraces);
  const slowTransactions = ps
    .flatMap((p) => p.samples.slowTransactions)
    .map((s) => structuredClone(s))
    .sort(compareSlow)
    .slice(0, ps[0].samples.maxSlowTransactionSummaries);

  const advisories: string[] = [];
  for (const p of ps) for (const a of p.advisories) if (!advisories.includes(a)) advisories.push(a);
  // Seeded reduce so the callback runs for EVERY part (including the first): the result
  // is always a fresh object, never an alias into an input partial.
  const attribution = ps
    .map((p) => p.attribution)
    .reduce(weakestReport, ps[0].attribution);

  const serializeSeries = (s: WorkSeries): LoadPartialCustomSeriesV1 => {
    const { hist, ...rest } = s;
    return { ...rest, ...(hist !== undefined ? { hist: hist.toJSON() } : {}) };
  };
  const merged: LoadReducerPartialV1 = {
    v: 1,
    observedAt,
    liveInFlight: sum("liveInFlight", (p) => p.liveInFlight),
    ...(workerId !== undefined ? { workerId } : {}),
    ...(ps[0].timelineOrigin !== undefined ? { timelineOrigin: ps[0].timelineOrigin } : {}),
    workerCount,
    feederGuarantee,
    runnerId,
    ...(config !== undefined ? { config: structuredClone(config) } : {}),
    requestedConcurrency: sum("requestedConcurrency", (p) => p.requestedConcurrency),
    ...(endReason !== undefined ? { endReason } : {}),
    ...(crash !== undefined ? { crash: structuredClone(crash) } : {}),
    ...(firstTs !== undefined ? { firstTs } : {}),
    lastTs,
    iterStarted: sum("iterStarted", (p) => p.iterStarted),
    iterCompleted: sum("iterCompleted", (p) => p.iterCompleted),
    iterSucceeded: sum("iterSucceeded", (p) => p.iterSucceeded),
    iterFailed: sum("iterFailed", (p) => p.iterFailed),
    iterLatency: mergeHists((p) => p.iterLatency),
    primaryBoundaries: sum("primaryBoundaries", (p) => p.primaryBoundaries),
    failedBeforePrimary: sum("failedBeforePrimary", (p) => p.failedBeforePrimary),
    endedWithoutBoundary: sum("endedWithoutBoundary", (p) => p.endedWithoutBoundary),
    primaryLatency: mergeHists((p) => p.primaryLatency),
    releasedProducerSlots: sum("releasedProducerSlots", (p) => p.releasedProducerSlots),
    rejectedReleaseSignals: sum("rejectedReleaseSignals", (p) => p.rejectedReleaseSignals),
    duplicateReleaseSignals: sum("duplicateReleaseSignals", (p) => p.duplicateReleaseSignals),
    maxContinuationBacklog: Math.max(...ps.map((p) => p.maxContinuationBacklog)),
    continuationBackpressure: mergeHists((p) => p.continuationBackpressure),
    liveContinuations: sum("liveContinuations", (p) => p.liveContinuations),
    pendingReleases: sum("pendingReleases", (p) => p.pendingReleases),
    scenarios: [...scenarios.values()].map((s) => ({ ...s, latency: s.latency.toJSON() })),
    steps: [...steps.values()].map((s) => ({ ...s, latency: s.latency.toJSON() })),
    endpoints: [...endpoints.values()].map((e) => ({ ...e, latency: e.latency.toJSON() })),
    matrix: [...matrix.values()].map((m) => ({ ...m, latency: m.latency.toJSON() })),
    customMetrics: [...customMetrics.values()].map((m) => ({
      metricId: m.metricId,
      kind: m.kind,
      ...(m.unit !== undefined ? { unit: m.unit } : {}),
      total: serializeSeries(m.total),
      series: [...m.series.values()].map(serializeSeries),
      seriesTruncated: m.seriesTruncated,
      ...(m.droppedSeriesCount !== undefined ? { droppedSeriesCount: m.droppedSeriesCount } : {}),
    })),
    recentFailures,
    timeline,
    slotBusy: slotBusy.toJSON(),
    samples: {
      maxFailureTraces: ps[0].samples.maxFailureTraces,
      maxSlowTransactionSummaries: ps[0].samples.maxSlowTransactionSummaries,
      failureTraces,
      slowTransactions,
    },
    advisories,
    attribution,
  };
  // Self-check: the merged output must itself be a valid frame (cheap relative to the
  // merge; catches fold bugs at the boundary instead of downstream).
  return parseLoadReducerPartial(merged);
}

// ── finalize ──────────────────────────────────────────────────────────────

/**
 * Produce the single run `LoadArtifact` from a (merged) partial by HYDRATING a reducer
 * (`LoadReducerImpl.fromPartial`) and running the existing `finalize(runEndMs)` — one
 * finalize implementation, not a second one. `opts.runEndMs` is the coordinator's
 * authoritative `globalEndAt` (epoch ms, §7.2 throughput-denominator rule; absent →
 * the last observed event closes the interval, single-process semantics).
 *
 * `opts.timelineOrigin` may SUPPLY the shared axis when the partial's envelope lacks
 * one — but only for a partial whose offsets are compatible: if the partial anchored
 * to `firstTs` (it has events but no origin), a different explicit origin would shift
 * every offset's meaning → rejected. When both are present they must agree.
 *
 * `opts.thresholds` evaluates gates on the D0-5 interval path with the hydrated
 * state's histograms as the quantile source (`latencyQuantiles()`), refining
 * `summary.pass` exactly like the single-process orchestrator does. D0 deliberately
 * does NOT wire the §6.2 conformance VERDICT here (the numerator data rides in the
 * partial; the judgment and its `"under-driven"` gate downgrade are D1 coordinator
 * work).
 *
 * SHARDED PROVENANCE (schema v2, codex R2 P2-3): `opts.provider` declares the D1
 * sharded provider that produced the frames — when given, the artifact reports
 * `runtime.processModel: "sharded-multi-process"` and `runtime.execution =
 * { provider, workerCount }` (workerCount from the merged frame's stamp; the rest of
 * the execution block — coverage / workers / digests — is D1 coordinator data). It is
 * REQUIRED whenever the frame folds more than one worker: a multi-worker artifact
 * must never claim the single-process `"in-process"` provenance. A raw single-worker
 * frame without `opts.provider` keeps the unchanged single-reducer path (in-process,
 * workerCount 1). `runtime.feederGuarantee` follows the frame's merged (weakest)
 * value when carried.
 *
 * `opts.executionStatus` is the §7.4 data-completeness verdict the D1 coordinator
 * determined (default: the finalize-emitted `"complete"`). A non-complete status
 * forces `summary.pass` false — §7.4's necessary conditions require `complete` —
 * BEFORE threshold evaluation ANDs in the gate verdicts.
 *
 * The partial's own `advisories` (worker-side extras) are appended (de-duplicated),
 * and its `attribution` overlays the hydrated finalize's derivation per-facet-weakest
 * (a remote worker may know its attribution is weaker than the merged aggregates
 * suggest).
 */
export function finalizeMerged(
  merged: LoadReducerPartialV1,
  opts: {
    runEndMs?: number;
    timelineOrigin?: number;
    thresholds?: LoadThresholds;
    /** D1 sharded provider provenance; REQUIRED for a multi-worker frame. */
    provider?: "multi-core" | "remote";
    /** §7.4 data-completeness judgment (D1 coordinator); default "complete". */
    executionStatus?: LoadExecutionStatus;
  } = {},
): LoadArtifact {
  const p = parseLoadReducerPartial(merged);
  // Fail fast, before any hydration work: a frame folding multiple workers MUST carry
  // explicit provider provenance (codex R2 P2-3) — reporting a sharded run as
  // "in-process"/"single-process-async-producer-slot" would be false provenance.
  const workerCount = p.workerCount ?? 1;
  if (opts.provider === undefined && workerCount > 1) {
    throw new Error(
      `finalizeMerged: the partial folds ${workerCount} workers — supply opts.provider ("multi-core" | "remote") so the artifact does not report in-process provenance for a sharded run`,
    );
  }
  if (opts.timelineOrigin !== undefined) {
    if (p.timelineOrigin !== undefined && p.timelineOrigin !== opts.timelineOrigin) {
      throw new Error(
        `finalizeMerged: timelineOrigin ${opts.timelineOrigin} conflicts with the partial's ${p.timelineOrigin}`,
      );
    }
    if (p.timelineOrigin === undefined && p.firstTs !== undefined && p.firstTs !== opts.timelineOrigin) {
      throw new Error(
        `finalizeMerged: the partial's offsets are anchored to firstTs ${p.firstTs} (no explicit origin); supplying a different timelineOrigin ${opts.timelineOrigin} would shift their meaning`,
      );
    }
  }
  const reducer = LoadReducerImpl.fromPartial(p, {
    ...(opts.timelineOrigin !== undefined ? { timelineOrigin: opts.timelineOrigin } : {}),
  });
  const artifact = reducer.finalize(opts.runEndMs);
  // Sharded execution provenance (schema v2): overrides the hydrated finalize's
  // single-process defaults. The rest of the execution block (coverage / workers /
  // clock segments / digests) is D1 coordinator data, filled by the caller.
  if (opts.provider !== undefined) {
    artifact.runtime.processModel = "sharded-multi-process";
    artifact.runtime.execution = { provider: opts.provider, workerCount };
  }
  // Feeder guarantee: the frame's merged (weakest-across-parts) value wins over the
  // finalize-emitted single-machine constant. Identity for a raw worker export
  // (which stamps "single-node", matching finalize).
  if (p.feederGuarantee !== undefined) artifact.runtime.feederGuarantee = p.feederGuarantee;
  // §7.4 data completeness: the D1 coordinator's judgment. finalize emits "complete"
  // (the single-state default); a non-complete status also forces the pass verdict
  // false — §7.4's necessary conditions require `complete` — BEFORE the threshold
  // evaluation below ANDs in the gate verdicts (it reads summary.pass as its base).
  const partialInput = opts.executionStatus !== undefined && opts.executionStatus !== "complete";
  if (opts.executionStatus !== undefined) {
    artifact.summary.executionStatus = opts.executionStatus;
    if (partialInput) artifact.summary.pass = false;
  }
  artifact.runtime.attribution = weakestReport(artifact.runtime.attribution, p.attribution);
  if (p.advisories.length > 0) {
    const advisories = [...(artifact.summary.advisories ?? [])];
    for (const a of p.advisories) if (!advisories.includes(a)) advisories.push(a);
    artifact.summary.advisories = advisories;
  }
  if (opts.thresholds !== undefined) {
    // A partial/failed execution downgrades EVERY gate to unevaluable/partial-input
    // (§7.4/§11): the whole artifact is built from incomplete data, so no gate carries
    // a trustworthy verdict — an overall-failed artifact must not show individual gates
    // as evaluated/passing (self-contradiction, codex integration R).
    const { thresholds, pass, advisories } = evaluateThresholds(
      artifact,
      opts.thresholds,
      reducer.latencyQuantiles(),
      { partialInput },
    );
    artifact.summary.thresholds = thresholds;
    artifact.summary.pass = pass;
    if (advisories.length > 0) {
      artifact.summary.advisories = [...(artifact.summary.advisories ?? []), ...advisories];
    }
  }
  return artifact;
}
