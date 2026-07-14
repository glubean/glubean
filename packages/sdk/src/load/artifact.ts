/**
 * `glubean.load.v1` — the versioned load report artifact.
 *
 * This is the stable boundary the CLI / Cloud read. `LoadEvent` (runtime fact
 * stream, M3) and external-engine native files are only inputs that produce a
 * `LoadArtifact`. M1 defines the types; the reducer that emits them lands later.
 *
 * Two business views + a matrix:
 *   - scenario / step (which transaction step is slow or failing under load)
 *   - endpoint (which endpoint's p95/p99/errorRate degrades)
 *   - matrix (which endpoint inside which step)
 */
import type { LoadMetricKind } from "./metrics.js";

/** Latency / duration percentiles (ms). */
export interface Percentiles {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

/** One bucket of a latency distribution: observations in (previous bucket's `leMs`, `leMs`].
 *  The buckets use a FIXED ladder so two runs' distributions line up for comparison; the
 *  final bucket's `leMs` is the observed max (the tail catch-all past the last boundary). */
export interface LoadLatencyBucket {
  leMs: number;
  count: number;
}

/** How trustworthy a reported dimension is (Glubean-native vs adapter heuristic). */
export type LoadAttributionQuality =
  | "canonical" // Glubean generated/instrumented; all canonical dimensions present
  | "tagged" // external script supplies expected tags / sample_variables
  | "heuristic" // derived from URL, label, group, or sampler name
  | "aggregate-only" // only summary rows / dashboard stats, no per-sample records
  | "unsupported";

/** Per-dimension attribution quality for an artifact. */
export interface LoadAttributionReport {
  scenario: LoadAttributionQuality;
  step: LoadAttributionQuality;
  endpoint: LoadAttributionQuality;
  phase: LoadAttributionQuality;
  iteration: LoadAttributionQuality;
  failureTrace: LoadAttributionQuality;
  notes?: string[];
}

/** Where an artifact came from. */
export interface LoadArtifactSource {
  kind: "glubean-local" | "external-adapter" | "imported-result";
  engine: "local" | "k6" | "jmeter" | "custom";
  adapter?: { name: string; version?: string };
  nativeRunId?: string;
}

/** Pointer back to a native engine output for cross-tool debugging. */
export interface LoadExternalArtifactRef {
  kind: "k6-json" | "k6-summary" | "jmeter-jtl" | "jmeter-dashboard" | "adapter-log" | "custom";
  path?: string;
  url?: string;
  sha256?: string;
  description?: string;
}

/** Run-fatal crash summary (process-level, lost reliable iteration attribution). */
export interface LoadCrashSummary {
  kind: "uncaughtException" | "unhandledRejection" | "runnerCrash" | "adapterCrash";
  message: string;
  stack?: string;
  atMs: number;
}

/** Classification of an iteration / step / request failure. */
export type LoadErrorKind =
  | "assertion"
  | "http"
  | "timeout"
  | "setupError"
  | "stepError"
  | "teardownError"
  | "continuationBacklogFull"
  | "aborted"
  | "runnerCrash";

/** Continuation (bounded-open) subsystem summary (present when producer release is used). */
export interface LoadContinuationSummary {
  backlog: number;
  maxBacklog: number;
  maxConcurrent: number;
  active: number;
  oldestAgeMs?: number;
  queueWaitMs?: Percentiles;
  backpressureMs?: Percentiles;
  releasedProducerSlots: number;
  primaryBoundaryCoverage: number;
  releaseCoverage: number;
  duplicateReleaseSignals: number;
  rejectedReleaseSignals: number;
  abortedByDrainTimeout: number;
}

/** A primary-phase aggregate (producer side). */
export interface LoadPrimaryPhaseSummary {
  started: number;
  completed: number;
  failedBeforeRelease: number;
  throughputPerSec: number;
  latency: Percentiles;
}

/** An end-to-end aggregate (full logical iteration). */
export interface LoadEndToEndSummary {
  started: number;
  completed: number;
  successful: number;
  failed: number;
  inFlightAtEnd: number;
  errorRate: number;
  throughputPerSec: number;
  latency: Percentiles;
}

/** Result of evaluating one threshold expression against a scope/metric. */
export interface ThresholdEvaluation {
  scope:
    | "transaction"
    | "primary"
    | "endToEnd"
    | "continuation"
    | "endpoint"
    | "step"
    | "customMetric";
  /** Scope target: routeKey (endpoint), stepId (step), or for a custom metric
   *  `metricId` / `metricId:tagKey=tagVal` (a per-series gate). */
  target?: string;
  metric:
    | "errorRate"
    | "p50"
    | "p90"
    | "p95"
    | "p99"
    | "throughputPerSec"
    | "backlog"
    | "backpressureMs"
    // custom-metric metrics: `rate`/`sum`/`count`; p50..p99 are reused for a `trend`.
    | "rate"
    | "sum"
    | "count";
  expression: string;
  actual: number;
  pass: boolean;
  source?: "glubean" | "engine" | "adapter";
  nativeExpression?: string;
  attributionQuality?: LoadAttributionQuality;
}

/** Identity attached to a failure / slow-transaction sample. The feeder `key` is the data-row
 *  attribution (which row produced this sample); `strategy` is optional metadata that may not
 *  be known at the layer that emits the sample (e.g. a streaming load reducer sees only the
 *  per-iteration keys, not each feeder's allocation strategy). */
export interface LoadSampleIdentity {
  scenarioId: string;
  scenarioRefId?: string;
  producerSlotId: string;
  iterationId: string;
  /** Id of the worker that ran this iteration. Absent on single-process runs (where
   *  `iterationId` alone is unique); a distributed worker stamps its id so samples stay
   *  unique across workers AND so the deterministic sample orders — slow top-k
   *  `(durationMs desc, workerId asc, iterationId asc)`, failure-trace ties
   *  `(workerId, iterationId)` — are total across a merged run. Absent sorts before any
   *  present id. */
  workerId?: string;
  feeders?: Record<string, { key?: string; strategy?: string }>;
}

/** A bounded observation kept for a failed iteration. */
export type LoadFailureObservation =
  | {
      type: "request";
      tsOffsetMs: number;
      stepId?: string;
      stepName?: string;
      phase?: "primary" | "continuation";
      method: string;
      routeKey: string;
      status?: number;
      ok: boolean;
      durationMs: number;
      errorKind?: LoadErrorKind;
    }
  | {
      type: "assertion";
      tsOffsetMs: number;
      stepId?: string;
      stepName?: string;
      phase?: "primary" | "continuation";
      passed: false;
      message?: string;
      actualPreview?: unknown;
      expectedPreview?: unknown;
    }
  | {
      type: "log";
      tsOffsetMs: number;
      level: "debug" | "info" | "warn" | "error";
      message: string;
    };

/** A bounded trace kept only for a failed iteration. */
export interface LoadFailureTraceSample {
  identity: LoadSampleIdentity;
  /** Offset of this iteration's completion (its `iteration:end`) from the run's time origin,
   *  in ms. Single-process the origin is the run start (first event); a distributed worker
   *  computes against the coordinator-issued shared `timelineOrigin`, so offsets are
   *  comparable across workers. The primary retention/merge key for the "first N failures":
   *  local retention keeps the smallest N under `(completedAtOffsetMs asc, workerId asc,
   *  iterationId asc)`, and a coordinator re-sorts the union of worker samples by the same
   *  order to keep the first N. Absent on artifacts produced before this field existed
   *  (such samples rank last). */
  completedAtOffsetMs?: number;
  durationMs: number;
  errorKind?: LoadErrorKind;
  failedStepId?: string;
  failedStepName?: string;
  observations: LoadFailureObservation[];
  truncated: boolean;
  droppedObservationCount: number;
}

/** A slow-but-successful transaction summary (no request trace). */
export interface LoadSlowTransactionSummary {
  identity: LoadSampleIdentity;
  /** Offset of this iteration's completion (its `iteration:end`) from the run's time origin,
   *  in ms (single-process: run start; distributed: the coordinator-issued shared
   *  `timelineOrigin`, comparable across workers). Diagnostic timestamp only — slow top-k
   *  retention/merge order is `(durationMs desc, workerId asc, iterationId asc)`, never
   *  wall-clock. Absent on artifacts produced before this field existed. */
  completedAtOffsetMs?: number;
  durationMs: number;
  slowStepId?: string;
  slowStepName?: string;
  topEndpoints: Array<{
    routeKey: string;
    phase?: "primary" | "continuation";
    durationMs: number;
    status?: number;
  }>;
  truncated: false;
}

/** Per-step aggregate (builder view). */
export interface LoadStepSummary {
  scenarioId: string;
  /** Traffic-mix entry id, when this step's scenario was referenced via a mix entry.
   *  Disambiguates the SAME `loadScenario` referenced under two entry ids (otherwise two
   *  rows would share scenarioId/stepId). Absent for a single-scenario run. */
  scenarioRefId?: string;
  stepId: string;
  stepName: string;
  groupId?: string;
  phase?: "primary" | "continuation";
  invocationCount: number;
  skippedCount: number;
  assertionFailureCount: number;
  errorCount: number;
  errorRate: number;
  latency: Percentiles;
  requestCount: number;
}

/** Per-endpoint aggregate (routeKey view). */
export interface LoadEndpointSummary {
  routeKey: string;
  phase?: "primary" | "continuation";
  routeKeySource: "explicit" | "catalog" | "contract-metadata" | "normalized-url";
  routeKeyHeuristic: boolean;
  method?: string;
  pathPattern?: string;
  operationId?: string;
  requestCount: number;
  errorCount: number;
  errorRate: number;
  statusCounts: Record<string, number>;
  latency: Percentiles;
  /** Request-latency distribution (fixed-ladder buckets) for a per-endpoint histogram. */
  latencyDistribution?: LoadLatencyBucket[];
  throughputPerSec: number;
}

/** Scenario-step × endpoint cell (which endpoint inside which step). */
export interface LoadScenarioEndpointMatrix {
  scenarioId: string;
  scenarioRefId?: string;
  stepId?: string;
  stepName?: string;
  phase?: "primary" | "continuation";
  routeKey: string;
  routeKeySource: "explicit" | "catalog" | "contract-metadata" | "normalized-url";
  routeKeyHeuristic: boolean;
  requestCount: number;
  errorRate: number;
  latency: Percentiles;
}

/** One fixed-width time window of the run — the unit of the over-time timeline. */
export interface LoadTimelineWindow {
  /** Window start, ms from the run start (`startedAt`). Width is `LoadTimeline.windowMs`. */
  offsetMs: number;
  /** Requests observed in this window. */
  requests: number;
  /** Requests with a non-2xx / failed response in this window. */
  errors: number;
  errorRate: number;
  /** Request throughput (requests / windowSec) — RPS over time. */
  throughputPerSec: number;
  /** Request latency percentiles within this window. */
  latency: Percentiles;
  /** Iterations COMPLETED (iteration:end) in this window — iteration throughput over time.
   *  Includes any `endedUnknown` completions synthesized at an observation cutoff (a lost
   *  source's in-flight iterations are closed there so they cannot ghost-carry forward). */
  iterations: number;
  /** Peak concurrent in-flight iterations during this window — concurrency over time.
   *  Compatibility SCALAR for pre-bounds consumers: always equal to
   *  `peakInFlightBounds.upper` (conservative — the true peak is never above it). For a
   *  single-source timeline it is exact: max(the peak sampled within the window, the count
   *  carried in from earlier windows), so a long iteration spanning quiet windows keeps the
   *  curve up AND a short iteration that starts and ends within one window still shows its
   *  concurrency (rather than netting to zero). */
  peakInFlight: number;
  /** Peak concurrent in-flight iterations as an interval. Single-source: `lower === upper`
   *  (the exact peak, `peakInFlight`'s historical value). Merged across sources (workers):
   *  per-source peaks can occur at different instants, so only bounds survive —
   *  `lower` = max over sources (∨ the combined carried-in count), `upper` = their sum.
   *  These are OBSERVED-CONTRIBUTOR bounds: when `contributorsPartial` is true a source
   *  did not observe this window at all (lost earlier) and its in-flight contribution is
   *  unbounded — the interval then covers the observed sources only, NOT the true global
   *  concurrency. Always written by the current emitter; absent on artifacts produced
   *  before this field existed — readers fall back to the `peakInFlight` scalar (= this
   *  interval's upper). The schemaVersion bump for the v2 field set lands in D0-8, not
   *  here (§11.1 conservative-superset strategy: optional fields + compat scalar first,
   *  one version bump at the end). */
  peakInFlightBounds?: { lower: number; upper: number };
  /** Iterations counted into `iterations` whose real completion was never observed: a lost
   *  source's still-in-flight starts are closed at its observation-cutoff window so the
   *  carried-in-flight baseline drops to zero instead of ghosting forever. Present only
   *  when > 0 (only censored merges produce it). */
  endedUnknown?: number;
  /** True when at least one merge contributor did not observe this window (its observation
   *  was cut off earlier). `peakInFlightBounds` then covers the observed contributors only
   *  — consumers must not read it as a global concurrency bound. Omitted when every
   *  contributor observed the window. */
  contributorsPartial?: boolean;
}

/**
 * Over-time series: fixed-width windows from run start, so a consumer can draw the
 * classic load curves (RPS / error-rate / latency / concurrency vs time). Windows are
 * dense (an idle window is present with zero counts) so the x-axis has no gaps. The width
 * (`windowMs`) starts fine and is coarsened (doubled) as needed so the series stays bounded
 * for an arbitrarily long run. Present for the local engine; an external adapter may omit it.
 */
export interface LoadTimeline {
  windowMs: number;
  windows: LoadTimelineWindow[];
}

/** Per-scenario aggregate. */
export interface LoadScenarioSummary {
  scenarioId: string;
  scenarioRefId?: string;
  iterations: number;
  successfulIterations: number;
  failedIterations: number;
  errorRate: number;
  latency: Percentiles;
  primary?: LoadPrimaryPhaseSummary;
  endToEnd?: Omit<LoadEndToEndSummary, "started">;
  steps: LoadStepSummary[];
}

/** Resolved (ms-normalized) config recorded in the artifact. */
export interface LoadArtifactConfig {
  concurrency: number;
  durationMs?: number;
  iterations?: number;
  rampUpMs?: number;
  /** Traffic-mix composition (present only for a `scenarios[]` run): each configured entry
   *  with its weight. Records WHAT was configured so a low-weight entry that drew zero
   *  iterations still shows up (as a 0-iteration scenario), not as if it were never set. */
  scenarios?: { scenarioRefId: string; scenarioId: string; weight: number }[];
  pacing?: { thinkTimeMs?: number | { min: number; max: number } };
  continuation?: {
    maxOutstanding?: number;
    maxConcurrent?: number;
    minPollIntervalMs?: number;
    drainTimeoutMs?: number;
    onBacklogFull?: "block-producer" | "fail-iteration";
  };
}

/** Runtime / engine provenance + saturation signals. */
export interface LoadArtifactRuntime {
  engine: "local" | "k6" | "jmeter" | "custom";
  engineVersion?: string;
  adapterName?: string;
  adapterVersion?: string;
  processModel: "single-process-async-producer-slot" | "external-engine" | "distributed-adapter";
  executionModel: "closed-back-to-back" | "closed-paced";
  slotModel: "end-to-end" | "end-to-end-measured" | "producer-released";
  requestedConcurrency: number;
  primaryInFlight: number;
  continuationInFlight: number;
  blockedOnBacklog: number;
  eventLoopDelayMs?: Percentiles;
  feederGuarantee: "single-node" | "distributed" | "degraded";
  sampleGranularity: "event" | "sample" | "aggregate";
  attribution: LoadAttributionReport;
  percentileSource: "glubean-reducer" | "engine-summary" | "adapter-computed" | "mixed";
  crash?: LoadCrashSummary;
}

/** One folded series of a custom metric: the aggregate for a single observed
 *  tag combination (`{}` is the untagged total). Only the fields relevant to the
 *  metric's `kind` are present. */
export interface LoadCustomMetricSeries {
  /** The tag combination this series aggregates (`{}` for the untagged total). */
  tags: Record<string, string>;
  /** Observations folded into this series. */
  count: number;
  // rate:
  /** `rate` only: observations whose value was `true`. */
  trueCount?: number;
  /** `rate` only: `trueCount / count`. */
  rate?: number;
  // counter:
  /** `counter` only: summed increments. */
  sum?: number;
  // trend:
  /** `trend` only: distribution percentiles of the folded samples. The field reuses
   *  the artifact-wide `latency` shape; for a trend declared with a non-duration
   *  `unit`, the values are in THAT unit, not ms. */
  latency?: Percentiles;
  /** `trend` only: fixed-ladder histogram (reuses the latency bucket type). */
  distribution?: LoadLatencyBucket[];
}

/** A declared custom metric, folded per tag-series (+ the untagged total). */
export interface LoadCustomMetric {
  metricId: string;
  kind: LoadMetricKind;
  /** Display unit for a `trend` (e.g. `"ms"`). */
  unit?: string;
  /** One series per observed tag combination, plus the untagged total. */
  series: LoadCustomMetricSeries[];
  /** True when `maxSeries` was hit and overflow was folded into the total. */
  seriesTruncated?: boolean;
}

/** Top-level summary (compatibility end-to-end fields + phase splits + thresholds). */
export interface LoadArtifactSummary {
  pass: boolean;
  /** Compatibility alias for endToEnd.completed. */
  totalIterations: number;
  successfulIterations: number;
  failedIterations: number;
  errorRate: number;
  throughputPerSec: number;
  latency: Percentiles;
  /** Transaction (iteration) latency distribution (fixed-ladder buckets) for the overall
   *  latency histogram — comparable bucket-for-bucket across runs. */
  latencyDistribution?: LoadLatencyBucket[];
  primary?: LoadPrimaryPhaseSummary;
  endToEnd?: LoadEndToEndSummary;
  continuation?: LoadContinuationSummary;
  thresholds: ThresholdEvaluation[];
  /** Declared custom metrics, each folded per tag-series. Present only when the
   *  runner declares `metrics` and at least one was observed. */
  customMetrics?: LoadCustomMetric[];
  /** Non-fatal advisories about the run's shape (e.g. a long poll with no
   *  `primaryComplete`, so closed scheduling may under-pressure the upstream).
   *  Present only when there's something to surface. */
  advisories?: string[];
}

/** Bounded failure / slow-transaction samples with their caps. */
export interface LoadArtifactSamples {
  maxFailureTraces: number;
  maxSlowTransactionSummaries: number;
  failureTraces: LoadFailureTraceSample[];
  slowTransactions: LoadSlowTransactionSummary[];
}

/** The complete versioned load report artifact. */
export interface LoadArtifact {
  schemaVersion: "glubean.load.v1";
  runnerId: string;
  runMode: "load";
  startedAt: string;
  durationMs: number;
  source: LoadArtifactSource;
  config: LoadArtifactConfig;
  runtime: LoadArtifactRuntime;
  summary: LoadArtifactSummary;
  scenarios: LoadScenarioSummary[];
  steps: LoadStepSummary[];
  endpoints: LoadEndpointSummary[];
  matrix: LoadScenarioEndpointMatrix[];
  /** Over-time series (RPS / error-rate / latency / concurrency vs time). Present for the
   *  local engine; an external adapter that only has summary stats may omit it. */
  timeline?: LoadTimeline;
  samples: LoadArtifactSamples;
  externalArtifacts?: LoadExternalArtifactRef[];
}
