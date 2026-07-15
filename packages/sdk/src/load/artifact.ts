/**
 * `glubean.load.v2` — the versioned load report artifact.
 *
 * This is the stable boundary the CLI / Cloud read. `LoadEvent` (runtime fact
 * stream, M3) and external-engine native files are only inputs that produce a
 * `LoadArtifact`. M1 defines the types; the reducer that emits them lands later.
 *
 * Two business views + a matrix:
 *   - scenario / step (which transaction step is slow or failing under load)
 *   - endpoint (which endpoint's p95/p99/errorRate degrades)
 *   - matrix (which endpoint inside which step)
 *
 * VERSION HISTORY — `schemaVersion`:
 *   - `glubean.load.v1` — the original artifact. Readers treat a v1 artifact as
 *     "none of the v2 fields are present".
 *   - `glubean.load.v2` — the distributed-execution field set (proposal §11):
 *     `summary.executionStatus`, `summary.endReason`, threshold tri-state
 *     (`status`/`reason`/`quantileBounds`), `peakInFlightBounds` + contributor
 *     masks, sample `completedAtOffsetMs`, `config.rngSeed`,
 *     `runtime.execution`, `LoadErrorKind: "feederExhausted"`, `processModel:
 *     "sharded-multi-process"`. Every v2 addition is OPTIONAL and conservative
 *     (§11.1): a v1-era reader that ignores unknown fields can never turn a
 *     failing run green — per-gate `pass` semantics are unchanged, unevaluable
 *     gates still carry `pass: false`, and the one deliberate `summary.pass`
 *     semantics change TIGHTENS it (§7.4: aborted / never-terminated runs are
 *     now always `false` — red in every reader, never green).
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
  | "runnerCrash"
  /** FRAMEWORK-side data exhaustion, not a SUT error: a feeder ran out of rows
   *  under the `fail` exhaustion policy, so the iteration failed at setup without
   *  ever touching the system under test. Single-machine emits it when a
   *  `fail`-policy feeder draw returns `exhausted`; a D1 distributed run uses the
   *  same kind when a worker's feeder SEGMENT runs dry, so cross-worker failure
   *  attribution separates "we ran out of test data" from real SUT failures. */
  | "feederExhausted";

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

/**
 * Result of evaluating one threshold expression against a scope/metric.
 *
 * Tri-state (schema v2, distributed-execution proposal §11): `status` distinguishes a
 * gate that was EVALUATED (`pass` is a real verdict) from one that was UNEVALUABLE —
 * the data cannot support a verdict (a quantile interval straddling the threshold, a
 * target scope with zero observations). Artifacts written before this field existed
 * carry no `status`; readers MUST treat a missing `status` as `"evaluated"`.
 *
 * CONSERVATIVE-DEGRADATION IRON RULE (§11.1): an `unevaluable` gate MUST carry
 * `pass: false` — never omit or default the field. The deployed cloud UI makes a
 * two-state assumption (app-next run-detail/load-body.tsx:123: `t.pass === false` →
 * breached); an unevaluable gate without `pass: false` would render GREEN there — a
 * false pass on a gate nobody evaluated. Until the UI learns the tri-state it shows
 * unevaluable as breached (red): conservative in the right direction.
 */
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
  /** Point estimate of the measured value. For a histogram-backed quantile gate this is
   *  the canonical upper-bound point estimate (the same number `summary.latency` reports);
   *  the decision itself may have used `quantileBounds`, not this point. */
  actual: number;
  /** The gate verdict. `false` for a breached gate AND for every `unevaluable` gate
   *  (see the iron rule in the interface doc — old consumers must never show green). */
  pass: boolean;
  /** `"evaluated"` — `pass` is a real verdict; `"unevaluable"` — the gate could not be
   *  decided (`pass` is forced `false`; `reason` says why). OPTIONAL because
   *  `glubean.load.v1` (pre-tri-state) artifacts carry no such field: a missing
   *  `status` MUST be read as `"evaluated"` (the only semantics those rows ever
   *  had). Every evaluation THIS version writes sets it explicitly. */
  status?: "evaluated" | "unevaluable";
  /** Why the gate was unevaluable — REQUIRED when `status === "unevaluable"`. Current
   *  values: `"borderline-quantile"` (the quantile interval straddles the threshold at the
   *  histogram's resolution) and `"no-observations"` (the target scope observed nothing —
   *  its zero-filled fields are NOT measurements). Typed as an open string so D1 can add
   *  `"feeder-gap"` / `"under-driven"` / `"partial-input"` without a breaking change. */
  reason?: string;
  /** The quantile interval a histogram-backed latency gate was decided on: the true
   *  (nearest-rank) quantile lies in `[lower, upper]` (ms). Present whenever the gate was
   *  evaluated from percentile bounds (including the borderline-unevaluable case). */
  quantileBounds?: { lower: number; upper: number };
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
   *  before this field existed (`glubean.load.v1`) — readers fall back to the
   *  `peakInFlight` scalar (= this interval's upper; §11.1 conservative-superset
   *  strategy: optional field + compat scalar). */
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
  /** Root seed of the run's counter-keyed RNG streams — traffic-mix scenario
   *  selection, `random`/`weightedRandom` feeder draws, and pacing think-time
   *  jitter. Recorded whether user-supplied or auto-generated, FOR REPRODUCTION:
   *  re-running the same plan + data with `rngSeed` set to this value replays
   *  the same random decisions. Only present when EVERY random decision came from
   *  the seeded streams — omitted when the deprecated `random` mix-selection
   *  override actually drove a selection (such a run is not seed-replayable), on
   *  artifacts produced before keyed RNG streams existed, and on external-adapter
   *  artifacts. */
  rngSeed?: string;
  pacing?: { thinkTimeMs?: number | { min: number; max: number } };
  continuation?: {
    maxOutstanding?: number;
    maxConcurrent?: number;
    minPollIntervalMs?: number;
    drainTimeoutMs?: number;
    onBacklogFull?: "block-producer" | "fail-iteration";
  };
}

/** Why a load run (or one worker of it) ended. Global full-order priority when
 *  reasons compete (§7.4): `crash > abort > duration > iterations`. */
export type LoadEndReason = "duration" | "iterations" | "abort" | "crash";

/** An instant on the COORDINATOR's monotonic clock (ms), domain-tagged so a bare
 *  number can never be mistaken for an epoch/worker-local time (proposal §5.1/§8).
 *  All cross-worker instants in `LoadExecutionReport` use this domain — workers'
 *  local clocks are mapped onto it via the clock handshake. */
export interface LoadCoordTime {
  domain: "coordMono";
  ms: number;
}

/** Iteration-index ownership of one worker's shard — the same union the D1
 *  coordinator's assign message uses (proposal §5.1):
 *  - `range` — iterations-bounded run: this worker owns `[start, end)`; the union
 *    of all workers' ranges is exactly `[0, N)`.
 *  - `stride` — duration-only run: this worker owns `offset, offset+step, …`
 *    (single-machine wrapping is the explicit `{ offset: 0, step: 1 }`, not an
 *    undefined range). Only disjointness and the `it-${index}` shape are promised. */
export type LoadShardIterationIndexes =
  | { kind: "range"; start: number; end: number }
  | { kind: "stride"; offset: number; step: number };

/** Why one worker's participation ended — finer-grained than its `endReason`
 *  (§7.4/§10): `normal` (ran to its own end), `abort` (coordinator-broadcast
 *  abort), `no-progress` (wedged past its known deadline), `lease-expired`
 *  (agent lease ran out), `channel-lost` (control channel dropped),
 *  `coordinator-lost` (worker outlived a silent coordinator past the lease TTL),
 *  `crash` (worker process died), `invalid-snapshot` (a protocol/schema-invalid
 *  snapshot frame → the worker is judged lost; its last VALID snapshot still
 *  counts, censored — §7.4). */
export type LoadWorkerTerminationCause =
  | "normal"
  | "abort"
  | "no-progress"
  | "lease-expired"
  | "channel-lost"
  | "coordinator-lost"
  | "crash"
  | "invalid-snapshot";

/** A worker's crash record in the execution block. Deliberately NOT
 *  `LoadCrashSummary`: that shape's `atMs` is a bare number (its single-machine
 *  run-offset semantics are a pre-v2 contract readers rely on), which is
 *  ambiguous across workers — run offset? worker-local? epoch? Here the instant
 *  is domain-tagged coordinator time, like every cross-worker instant in this
 *  block. D1 fills it. */
export interface LoadExecutionWorkerCrash {
  /** What killed the worker (same classification as `LoadCrashSummary.kind`). */
  cause: LoadCrashSummary["kind"];
  message: string;
  /** When it crashed, on the coordinator clock. Absent when the instant could
   *  not be mapped (e.g. the worker died before its clock handshake). */
  at?: LoadCoordTime;
}

/** One calibrated segment of a worker's clock mapping onto the coordinator clock
 *  (§8): during `[from, to)` the worker's monotonic clock maps with `offsetMs`
 *  (± `uncertaintyMs`). Slope is fixed at 1; re-syncs open a new segment. */
export interface LoadExecutionClockSegment {
  from: LoadCoordTime;
  /** Open-ended (still current at run end) when absent. */
  to?: LoadCoordTime;
  offsetMs: number;
  uncertaintyMs: number;
}

/** How much of the PLANNED run the merged result actually covers (§7.4) — the
 *  quantitative backing for `summary.executionStatus`. */
export interface LoadExecutionCoverage {
  /** Workers that delivered a final-state snapshot. */
  workersFinal: number;
  workersExpected: number;
  /** Producer-slot busy seconds actually observed across workers. */
  slotSecondsAchieved: number;
  /** Planned slot-seconds; absent when the plan has no fixed duration bound. */
  slotSecondsExpected?: number;
  /** Iterations-bounded runs only. */
  iterationsCompleted?: number;
  iterationsExpected?: number;
  /** Window-level conformance summary (§6.2): the worst window's conformance and
   *  how many windows fell below the gate threshold. */
  conformance?: { min: number; belowThresholdWindows: number };
  /** Latest coordinator-clock instant up to which EVERY merge contributor was
   *  observed — data past it is censored for at least one lost worker. */
  observedUntil?: LoadCoordTime;
}

/** Per-feeder delivery accounting across the run (§6.5): rows attempted/served,
 *  framework-side failures (exhausted segments under `fail`), skipped draws, and
 *  rows left unused. `perWorker` breaks the same counters down by worker. */
export interface LoadExecutionFeederSummary {
  /** Canonical feeder-slot id (the same identity the keyed RNG streams use). */
  feederSlotId: string;
  attempted: number;
  served: number;
  /** Draws that failed on the FRAMEWORK side (segment exhausted under `fail`) —
   *  these surface as `feederExhausted` iterations, not SUT errors. */
  frameworkFailed: number;
  skipped: number;
  unusedRows: number;
  perWorker?: Array<{
    workerId: string;
    attempted: number;
    served: number;
    frameworkFailed: number;
    skipped: number;
    /** Rows of THIS worker's feeder segment left unused (same semantics as the
     *  top-level `unusedRows`) — separates shard skew (one segment exhausted
     *  while another sat on spare rows) from run-wide waste. D1 fills it. */
    unusedRows?: number;
  }>;
}

/** One worker's participation record (D1 emits one per worker; a single-machine
 *  run omits the array — its one implicit worker is the process itself). */
export interface LoadExecutionWorker {
  id: string;
  /** Remote provider only. */
  host?: string;
  /** The shard this worker owned (assign₁, §5.1). */
  shard: {
    /** First global producer-slot index of this worker's contiguous slot block. */
    slotIndexBase: number;
    slotCount: number;
    iterationIndexes: LoadShardIterationIndexes;
    /** Iteration quota for an iterations-bounded shard. */
    iterations?: number;
  };
  /** Clock mapping onto the coordinator clock (§8). Remote workers REQUIRED;
   *  multi-core may omit (IPC handshake uncertainty is negligible). */
  clock?: {
    segments: LoadExecutionClockSegment[];
    /** Assumed max drift (ppm) used in the uncertainty budget. */
    driftBoundPpm: number;
    /** Measured drift, when the run was long enough to estimate one. */
    driftPpmMeasured?: number;
  };
  /** How late past its absolute `startAt + rampDelay` instant this worker's first
   *  slot actually started (§5.1). */
  startLatenessMs?: number;
  /** Set when this worker began load BEFORE a failed global commit was resolved —
   *  the run records `partialStart` (§10). */
  crossedStartAt?: LoadCoordTime;
  /** This worker's continuation slice (conserved split of the run's quota, §5.1). */
  continuation?: { quota: number; backpressureHits: number };
  endReason: LoadEndReason;
  /** REQUIRED for any non-normal ending; may be omitted for a clean `normal` end. */
  terminationCause?: LoadWorkerTerminationCause;
  /** Present when this worker crashed (see `LoadExecutionWorkerCrash` — its
   *  instant is coordinator-clock, unlike the top-level `runtime.crash`). */
  crash?: LoadExecutionWorkerCrash;
  /** Where this worker's observed contribution was censored (lost workers, §7.3):
   *  its data counts only up to here. */
  observationCutoff?: LoadCoordTime;
  /** Sequence number of the last VALID snapshot frame merged from this worker. */
  lastSnapshotSeq?: number;
}

/**
 * Execution-layer provenance for the run (proposal §11 — schema v2).
 *
 * WHO ran the plan and HOW COMPLETELY, as opposed to `config` (what was asked)
 * and `summary` (what was measured). A single-machine run writes the minimal
 * `{ provider: "in-process", workerCount: 1 }`; the D1 coordinator fills the
 * full block (coverage / workers / feeders are CONDITIONALLY REQUIRED there —
 * optional at the type level only because single-machine and v1 artifacts omit
 * them). Absent entirely on artifacts produced before schema v2.
 */
export interface LoadExecutionReport {
  /** `in-process` — single-machine `runLoad` (this process ran every slot);
   *  `multi-core` / `remote` — D1 sharded providers. */
  provider: "in-process" | "multi-core" | "remote";
  /** Number of workers that participated (1 for in-process). */
  workerCount: number;
  /** Root RNG seed, REDUNDANT COPY: `config.rngSeed` is the authoritative record
   *  (and the replay input); D1 repeats it here so the execution block is
   *  self-contained for shard-level debugging. Single-machine omits it. */
  rngSeed?: string;
  /** Control-channel protocol version negotiated at enroll (§4). D1 only. */
  protocolVersion?: string;
  /** Digest of the workload manifest every worker verified before arming (§4).
   *  Remote REQUIRED; multi-core may omit in D1 (§12). */
  manifestDigest?: string;
  /** Digest of the resolved plan (post-resolution canonical form). Remote
   *  REQUIRED; multi-core may omit in D1 (§12). */
  resolvedPlanDigest?: string;
  /** REQUIRED for D1 multi-worker runs; the data behind `executionStatus`. */
  coverage?: LoadExecutionCoverage;
  /** True when some workers began load before a failed commit round resolved
   *  (§10) — their head segment ran without full-quorum confirmation. */
  partialStart?: boolean;
  /** Human-readable execution notes (degradations, retries, clock re-syncs). */
  notes?: string[];
  /** Per-feeder delivery accounting. D1 emits it whenever feeders are used. */
  feeders?: LoadExecutionFeederSummary[];
  /** Per-worker participation records. REQUIRED for D1 multi-worker runs. */
  workers?: LoadExecutionWorker[];
}

/** Runtime / engine provenance + saturation signals. */
export interface LoadArtifactRuntime {
  engine: "local" | "k6" | "jmeter" | "custom";
  engineVersion?: string;
  adapterName?: string;
  adapterVersion?: string;
  /** `sharded-multi-process` — a D1 coordinator-merged run (multi-core or remote
   *  workers); the other values are the single-process / adapter models. */
  processModel:
    | "single-process-async-producer-slot"
    | "external-engine"
    | "distributed-adapter"
    | "sharded-multi-process";
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
  /** Execution-layer provenance (schema v2, §11): who ran the plan and how
   *  completely. Single-machine writes the minimal in-process block; the D1
   *  coordinator fills coverage / workers / feeders. Absent on v1 artifacts. */
  execution?: LoadExecutionReport;
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

/**
 * Data-completeness of the run's merged result — PURE data integrity, not a
 * verdict (§7.4). Orthogonal to `pass` (the verdict) and `endReason` (why the
 * run stopped):
 *   - `"complete"` — every worker delivered its final-state snapshot (including
 *     an abort whose workers still drained and delivered normally). A crashed
 *     or aborted single-machine run is still `"complete"` — its one reducer IS
 *     the final state; the failure lives in `pass` / `endReason` / `crash`.
 *   - `"partial"` — ≥1 worker contributed usable data but never delivered a
 *     final state (lost / censored / judged lost on an invalid snapshot — the
 *     rejected FRAME is dropped, not the run; a worker with no valid snapshot
 *     at all counts as a zero-contribution loss). Partial data produces
 *     informational numbers only, never a pass.
 *   - `"failed"` — post-start, no usable merged result at all. (Pre-start
 *     failures — join timeout / manifest mismatch / commit-ACK failure — never
 *     produce a `LoadArtifact`; the CLI reports the error directly.)
 * `pass` REQUIRES `complete` (plus endReason ∈ {duration, iterations}, no
 * worker crash, and every gate evaluated and passing).
 */
export type LoadExecutionStatus = "complete" | "partial" | "failed";

/** Top-level summary (compatibility end-to-end fields + phase splits + thresholds). */
export interface LoadArtifactSummary {
  /** The run verdict. §7.4 NECESSARY conditions: `endReason` ∈ {`"duration"`,
   *  `"iterations"`} AND no crash AND every configured gate evaluated and
   *  passing (an `unevaluable` gate carries `pass: false`, so it fails this).
   *  An aborted run — and a run that never terminated cleanly (no `endReason`)
   *  — is therefore ALWAYS `false`. */
  pass: boolean;
  /** Why the run ended (schema v2, §7.4). Global full-order priority when
   *  reasons compete: `crash > abort > duration > iterations` (concurrent
   *  instants are ordered by the coordinator's monotonic clock, so a
   *  disconnect-vs-deadline race doesn't depend on scheduling). The v2 emitter
   *  always writes it when the run terminated; ABSENT means the run never
   *  terminated cleanly (finalized without a `load:end` — e.g. a snapshot-merge
   *  artifact from a lost worker) or the artifact predates v2. Per-worker
   *  endReason/terminationCause live in `runtime.execution.workers`. */
  endReason?: LoadEndReason;
  /** Data-completeness of this artifact (§7.4 — see `LoadExecutionStatus`).
   *  Single-machine `runLoad` always writes `"complete"`; `"partial"`/`"failed"`
   *  are judged and written by the D1 coordinator. Absent on v1 artifacts —
   *  readers treat a missing value as `"complete"` (the only semantics a
   *  single-machine artifact ever had). CONSERVATIVE (§11.1): when the status is
   *  not `"complete"`, `pass` is ALWAYS false (§7.4's pass precondition), so a
   *  pre-v2 reader that ignores this field still shows the run red. */
  executionStatus?: LoadExecutionStatus;
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
  /** `"glubean.load.v2"` is what current emitters write. `"glubean.load.v1"`
   *  stays in the union for READERS: a v1 artifact (produced before the v2
   *  field set) is a valid `LoadArtifact` with none of the v2 optional fields
   *  present — see the version history in this file's header. Readers accept
   *  both; they must not reject v1. */
  schemaVersion: "glubean.load.v1" | "glubean.load.v2";
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
