/**
 * Streaming LoadReducer implementation.
 *
 * Folds the `LoadEvent` fact stream into bounded aggregates (no full-sample
 * arrays): transactions (iterations), steps, endpoints, and the scenario-step ×
 * endpoint matrix, each with a bounded `LoadHistogram` for latency. `snapshot()`
 * and `finalize()` both read this same state, so live progress and the final
 * artifact never diverge.
 *
 * Scope (M3): closed end-to-end model. `phase` is carried but defaults to
 * "primary"; producer-release / continuation aggregates, failure-trace samples,
 * and threshold evaluation are wired in later milestones (M4/M5/M6).
 *
 * Convention: `LoadEvent.ts` is epoch milliseconds (the orchestrator stamps
 * `Date.now()`), so `startedAt` (ISO) and `durationMs` come from event ts.
 */
import type {
  LoadArtifact,
  LoadArtifactConfig,
  LoadAttributionQuality,
  LoadContinuationSummary,
  LoadCrashSummary,
  LoadCustomMetric,
  LoadCustomMetricSeries,
  LoadEndReason,
  LoadEndpointSummary,
  LoadEndToEndSummary,
  LoadEvent,
  LoadFailureSummary,
  LoadMetricKind,
  LoadPrimaryPhaseSummary,
  LoadProgressSnapshot,
  LoadReducer,
  LoadResolvedConfig,
  LoadRouteKeySource,
  LoadScenarioEndpointMatrix,
  LoadScenarioSummary,
  LoadStepSummary,
  Percentiles,
} from "@glubean/sdk/load";
import { LoadHistogram } from "./histogram.js";
import type { ThresholdQuantileSource } from "./threshold.js";
import { LoadTimeline } from "./timeline.js";
import { LoadSampleCollector } from "./samples.js";
import { SlotBusyWindows } from "./slot-busy.js";
// Type-only (erased at runtime): the partial schema lives in partial.ts, which itself
// value-imports this module for hydration — a runtime cycle would be a hazard, a type
// cycle is not.
import type {
  LoadPartialCustomMetricV1,
  LoadPartialCustomSeriesV1,
  LoadReducerPartialV1,
} from "./partial.js";

const SEP = "\u0000";
const ZERO_PCT: Percentiles = { p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
// Fixed latency ladder (ms) for the distribution histograms. Fixed (not data-derived) so two
// runs' distributions line up bucket-for-bucket; a final overflow bucket carries the tail.
const LATENCY_LADDER = [10, 25, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 2000, 5000];

// Per-metric cap on distinct tag-series. Beyond it, new tag combinations are folded into
// the untagged total only (the metric is flagged `seriesTruncated` + an advisory) — a guard
// against a high-cardinality tag (e.g. itemId) exploding the artifact. `class` (3 values) is
// fine; this protects the artifact, not the author's intent.
const DEFAULT_MAX_SERIES = 50;

type Phase = "primary" | "continuation";

/** One folded series of a custom metric (the untagged total, or one tag combination). */
interface CustomSeriesAgg {
  tags: Record<string, string>;
  count: number;
  /** rate: observations whose value was truthy. */
  trueCount: number;
  /** counter: summed increments. */
  sum: number;
  /** trend: distribution of folded samples. */
  hist?: LoadHistogram;
  /** `false` when this series' fold is known INCOMPLETE — set only by hydration from a
   *  merged partial where §7.3's conservative rule fired (a truncated worker folded this
   *  key's observations into its total invisibly). Absent = complete (the live fold is
   *  always exact for retained keys). Threshold evaluation reads it through
   *  `latencyQuantiles().customSeriesComplete` — an incomplete series' retained values
   *  undercount, so its gates must be unevaluable, never a false pass. */
  complete?: boolean;
}

/** A declared custom metric, folded per tag-series plus the untagged total. */
interface CustomMetricAgg {
  metricId: string;
  kind: LoadMetricKind;
  unit?: string;
  /** Untagged total — every observation, regardless of tags. */
  total: CustomSeriesAgg;
  /** One per observed tag combination, keyed by canonical tag string. */
  series: Map<string, CustomSeriesAgg>;
  /** True once `DEFAULT_MAX_SERIES` was hit and overflow folded into the total. */
  truncated: boolean;
}

/** Stable key for a tag combination: keys sorted so `{a,b}` and `{b,a}` collapse.
 *  JSON-encoded (not joined) so a tag key/value containing a separator or `=`
 *  can't collide two distinct combinations into one series. Exported so the
 *  partial merge (`partial.ts`) unions series under the exact same canonical key
 *  the fold and hydration use. */
export function canonicalTagKey(tags: Record<string, string>): string {
  return JSON.stringify(Object.keys(tags).sort().map((k) => [k, tags[k]]));
}

function newCustomSeries(tags: Record<string, string>, kind: LoadMetricKind): CustomSeriesAgg {
  return {
    tags,
    count: 0,
    trueCount: 0,
    sum: 0,
    ...(kind === "trend" ? { hist: new LoadHistogram() } : {}),
  };
}

/** Fold one observed value into a series by the metric's kind. */
function recordCustomSample(s: CustomSeriesAgg, kind: LoadMetricKind, value: number): void {
  s.count += 1;
  if (kind === "rate") {
    if (value !== 0) s.trueCount += 1;
  } else if (kind === "counter") {
    s.sum += value;
  } else {
    s.hist?.record(value);
  }
}

/** Project a folded series into its artifact shape (only the kind's fields). An
 *  INCOMPLETE series (hydrated merged state, §7.3's conservative rule) carries
 *  `complete: false` onto the v2 artifact row (codex R3) — threshold-less consumers
 *  must be able to see WHICH row undercounts, not just the metric-level
 *  `seriesTruncated`; a complete row omits the field (absent = complete). */
function customSeriesSummary(s: CustomSeriesAgg, kind: LoadMetricKind): LoadCustomMetricSeries {
  const out: LoadCustomMetricSeries = {
    tags: s.tags,
    count: s.count,
    ...(s.complete === false ? { complete: false } : {}),
  };
  if (kind === "rate") {
    out.trueCount = s.trueCount;
    out.rate = s.count > 0 ? s.trueCount / s.count : 0;
  } else if (kind === "counter") {
    out.sum = s.sum;
  } else if (s.hist) {
    out.latency = s.count > 0 ? s.hist.percentiles() : ZERO_PCT;
    if (s.count > 0) out.distribution = s.hist.distribution(LATENCY_LADDER);
  }
  return out;
}

interface ScenarioAgg {
  scenarioId: string;
  scenarioRefId?: string;
  iterations: number;
  successful: number;
  failed: number;
  latency: LoadHistogram;
}

interface StepAgg {
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
  latency: LoadHistogram;
}

interface EndpointAgg {
  routeKey: string;
  phase?: Phase;
  routeKeySource: LoadRouteKeySource;
  routeKeyHeuristic: boolean;
  method?: string;
  requestCount: number;
  errorCount: number;
  statusCounts: Record<string, number>;
  latency: LoadHistogram;
}

interface MatrixAgg {
  scenarioId: string;
  scenarioRefId?: string;
  stepId?: string;
  // stepName is resolved at summary time from the step agg (request:observed
  // carries only stepId; step:end supplies the display name).
  phase?: Phase;
  routeKey: string;
  routeKeySource: LoadRouteKeySource;
  routeKeyHeuristic: boolean;
  requestCount: number;
  errorCount: number;
  latency: LoadHistogram;
}

function rate(failed: number, total: number): number {
  return total > 0 ? failed / total : 0;
}

export class LoadReducerImpl implements LoadReducer {
  private runnerId = "";
  private config?: LoadResolvedConfig;
  private requestedConcurrency = 0;
  private endReason?: LoadEndReason;
  private crash?: LoadCrashSummary;
  private firstTs?: number;
  private lastTs = 0;

  // transactions (iterations)
  private iterStarted = 0;
  private iterCompleted = 0;
  private iterSucceeded = 0;
  private iterFailed = 0;
  private readonly iterLatency = new LoadHistogram();

  // primary-phase boundary (M5): present only when a scenario calls
  // `ctx.report.primaryComplete()`. `primaryLatency` aggregates `primaryDurationMs`
  // (iteration start → boundary); `iterHadPrimary` tracks in-flight iterations that
  // reached the boundary so a later failure is classified before/after it.
  private primaryBoundaries = 0;
  private failedBeforePrimary = 0;
  private endedWithoutBoundary = 0;
  private readonly primaryLatency = new LoadHistogram();
  private readonly iterHadPrimary = new Set<string>();

  // continuation / producer-release (M6): present once any release is attempted.
  private releasedProducerSlots = 0;
  private rejectedReleaseSignals = 0;
  private duplicateReleaseSignals = 0;
  private maxContinuationBacklog = 0;
  private readonly continuationBackpressure = new LoadHistogram();
  // Released iterations still in their continuation phase (released, not yet ended):
  // the LIVE in-flight count for snapshot() and an interrupted finalize().
  private readonly liveContinuations = new Set<string>();
  // Iterations that reached their boundary requesting release but aren't yet granted
  // / rejected — i.e. parked on a full backlog. They've left the primary phase but
  // aren't continuations yet, so they're the LIVE `blockedOnBacklog` count.
  private readonly pendingRelease = new Set<string>();
  // Per in-flight iteration: each step's START phase (recorded at step:start), so a
  // step's step:end + requests aggregate under the phase it started in even after a
  // mid-step boundary flips the live phase. Cleared at iteration:end (bounded).
  private readonly iterStepPhase = new Map<string, Map<string, Phase>>();

  private readonly scenarios = new Map<string, ScenarioAgg>();
  private readonly steps = new Map<string, StepAgg>();
  private readonly endpoints = new Map<string, EndpointAgg>();
  private readonly matrix = new Map<string, MatrixAgg>();
  // Declared custom metrics (rate/trend/counter), folded from `metric:observed`.
  private readonly customMetrics = new Map<string, CustomMetricAgg>();
  private readonly recentFailures: LoadFailureSummary[] = [];
  // Over-time series (RPS / error-rate / latency / concurrency vs time), bucketed by the
  // event ts offset from the run start. Reassignable (not readonly) ONLY for the
  // hydration path (`fromPartial` revives a serialized timeline wholesale — merging into
  // a fresh instance would miscount the fresh timeline as a contributor).
  private timeline = new LoadTimeline();
  // Bounded failure-trace / slow-transaction samples (the "show me one" view).
  private readonly samples: LoadSampleCollector;

  // Producer-slot occupancy integral per timeline-width window — the pressure-conformance
  // NUMERATOR (proposal §6.2; see slot-busy.ts for the measurement contract). Fed by
  // producerSlot:start/end spans; `openSlots` maps a live slot's index to its start
  // offset (ms on the run axis) until its end event arrives. Reassignable ONLY for the
  // hydration path (`fromPartial` revives the serialized accumulator wholesale).
  private slotBusy = new SlotBusyWindows();
  private readonly openSlots = new Map<number, number>();

  // Injected time origin for every time quantity this reducer emits (see `originMs`).
  // Absent → fall back to the first event's ts, the single-process run start.
  private readonly timelineOrigin?: number;
  // Shard identity for a distributed run (stamped into sample identities via the
  // collector AND exported on the partial envelope); unset on single-process runs.
  private readonly workerId?: string;
  // Snapshot instant claimed by the partial this reducer was HYDRATED from (codex R2
  // P2-1). A re-export must never claim narrower observation coverage than its source
  // frame: without this, export(T)→hydrate→no-arg re-export would fall back to the
  // earlier lastTs while the slot-busy windows already integrate to T — an internally
  // inconsistent frame whose downstream censoring drops known coverage. Serves as the
  // no-arg default AND the floor of `exportPartial`'s observedAt. Unset on live
  // (non-hydrated) reducers.
  private hydratedObservedAt?: number;

  /** @param config `report` sample caps (0 disables a sample type entirely), plus two optional
   *  distributed-run knobs (single-process runs leave both unset):
   *  - `workerId` — this shard's identity, stamped into sample identities (the shard runner
   *    wires its `shard.workerId`). NOT the event `runnerId`, which is the plan's identity
   *    and identical on every worker.
   *  - `timelineOrigin` — epoch ms every emitted time quantity is computed against (see
   *    `originMs` for the single-axis principle). CLOCK-DOMAIN INVARIANT: it MUST be
   *    expressed in the same clock domain as the `LoadEvent.ts` values this reducer
   *    consumes. In-process / multi-core workers share the host clock — pass the
   *    coordinator's epoch t0 as-is. A REMOTE agent must FIRST convert the coordinator's
   *    origin into this worker's local epoch via the clock mapping estimated at handshake
   *    (proposal §8), THEN construct the reducer — the conversion is the agent's job and
   *    happens before this constructor runs. The reducer is deliberately clock-agnostic:
   *    it has no information to detect skew and must not pretend to, so normalization
   *    lives in the layer that owns the mapping; cross-worker offset comparability is
   *    exactly as good as that mapping's uncertainty budget (point-estimated, §7.3) —
   *    the reducer neither amplifies nor masks it. */
  constructor(
    config: { maxFailureTraces?: number; maxSlowTransactionSummaries?: number; workerId?: string; timelineOrigin?: number } = {},
  ) {
    this.samples = new LoadSampleCollector(config);
    if (config.timelineOrigin !== undefined) this.timelineOrigin = config.timelineOrigin;
    if (config.workerId !== undefined) this.workerId = config.workerId;
  }

  apply(event: LoadEvent): void {
    if (this.firstTs === undefined) this.firstTs = event.ts;
    if (event.ts > this.lastTs) this.lastTs = event.ts;
    if (event.runnerId) this.runnerId = event.runnerId;

    switch (event.type) {
      case "load:start":
        this.config = event.config;
        this.requestedConcurrency = event.config.concurrency;
        // Seed an aggregate for every configured traffic-mix entry, so a low-weight entry
        // that never gets selected still appears in the artifact (configured, 0 iterations)
        // rather than absent. A single-scenario run has no `scenarios` and seeds on its
        // first iteration:start, as before.
        for (const s of event.config.scenarios ?? []) {
          this.scenarioAgg(s.scenarioId, s.scenarioRefId);
        }
        break;
      case "load:end":
        this.endReason = event.reason;
        if (event.crash) this.crash = event.crash;
        break;
      case "iteration:start":
        this.iterStarted += 1;
        // Concurrency-over-time: sample the live in-flight (post-increment local peak); the
        // window also carries the count forward at finalize.
        this.timeline.recordIterationStart(this.offsetOf(event.ts), this.iterStarted - this.iterCompleted);
        if (event.iterationId) {
          this.samples.beginIteration(event.iterationId, {
            scenarioId: event.scenarioId ?? "",
            ...(event.scenarioRefId !== undefined ? { scenarioRefId: event.scenarioRefId } : {}),
            producerSlotId: event.producerSlotId ?? "",
            ...(event.feederKeys !== undefined ? { feederKeys: event.feederKeys } : {}),
          });
        }
        // Seed the scenario aggregate (no completed-count change) so a run that
        // aborts/crashes before this scenario's first iteration:end still keeps
        // scenario-level attribution in the finalized artifact.
        this.scenarioAgg(event.scenarioId, event.scenarioRefId);
        break;
      case "iteration:end": {
        this.iterCompleted += 1;
        if (event.ok) this.iterSucceeded += 1;
        else this.iterFailed += 1;
        this.iterLatency.record(event.durationMs);
        this.timeline.recordIterationEnd(this.offsetOf(event.ts)); // iteration throughput over time
        // Boundary accounting (M5): did this iteration reach its primary boundary?
        // A failure WITHOUT a boundary failed before primary completion.
        const hadBoundary = event.iterationId ? this.iterHadPrimary.delete(event.iterationId) : false;
        if (!hadBoundary) {
          this.endedWithoutBoundary += 1;
          // A no-boundary iteration has no continuation phase — its whole run IS its
          // primary phase. On success it COMPLETED primary (record its full duration
          // as primary latency); on failure it failed before any boundary.
          if (!event.ok) this.failedBeforePrimary += 1;
          else this.primaryLatency.record(event.durationMs);
        }
        if (event.iterationId) {
          this.samples.endIteration(event.iterationId, {
            ok: event.ok,
            durationMs: event.durationMs,
            // iteration:end offset from run start — the sample-merge ordering key (same
            // clock basis as observation tsOffsetMs).
            completedAtOffsetMs: this.offsetOf(event.ts),
            ...(event.errorKind !== undefined ? { errorKind: event.errorKind } : {}),
          });
          this.iterStepPhase.delete(event.iterationId); // bounded cleanup
          this.liveContinuations.delete(event.iterationId); // continuation finished
          this.pendingRelease.delete(event.iterationId); // a fail-iteration tail ended
        }
        const sc = this.scenarioAgg(event.scenarioId, event.scenarioRefId);
        if (sc) {
          sc.iterations += 1;
          if (event.ok) sc.successful += 1;
          else sc.failed += 1;
          sc.latency.record(event.durationMs);
        }
        if (!event.ok) {
          this.pushFailure({
            scenarioId: event.scenarioId,
            scenarioRefId: event.scenarioRefId,
            iterationId: event.iterationId ?? "",
            errorKind: event.errorKind,
            atMs: this.offsetOf(event.ts), // same origin as every other offset (was a hand-rolled, unclamped fork)
          });
        }
        break;
      }
      case "step:start": {
        const stepId = event.stepId ?? event.stepName;
        // step:start carries the step's START phase — record it so this step's later
        // events (step:end, requests) all resolve to it, even after a mid-step flip.
        const phase = this.phaseOf(event);
        this.rememberStepPhase(event.iterationId, stepId, phase);
        const step = this.getStep(event.scenarioId, event.scenarioRefId, stepId, phase, event.stepName);
        // groupId is only on step:start — capture it now (step:end omits it).
        if (event.groupId !== undefined) step.groupId = event.groupId;
        break;
      }
      case "step:end": {
        const stepId = event.stepId ?? event.stepName;
        const step = this.getStep(
          event.scenarioId,
          event.scenarioRefId,
          stepId,
          this.stepStartPhase(event.iterationId, stepId, this.phaseOf(event)),
          event.stepName,
        );
        step.stepName = event.stepName; // correct any placeholder set by an earlier request:observed
        // A skipped leaf emits no step:start, so capture its group here too.
        if (event.groupId !== undefined && step.groupId === undefined) step.groupId = event.groupId;
        step.invocationCount += 1;
        if (event.skipped) {
          // A skipped step (fail-fast / skipRemainingSteps) is neither a latency
          // sample nor a failure of its own — only an explicit skip.
          step.skippedCount += 1;
        } else {
          step.latency.record(event.durationMs);
          if (!event.ok) step.errorCount += 1;
        }
        step.assertionFailureCount += event.assertionFailures ?? 0;
        if (event.iterationId) {
          this.samples.recordStep(event.iterationId, {
            stepId,
            stepName: event.stepName,
            durationMs: event.durationMs,
            ok: event.ok,
            skipped: event.skipped ?? false,
          });
        }
        break;
      }
      case "request:observed": {
        // RPS / error-rate / latency over time, with a live-in-flight sample (a request-busy
        // window — e.g. a poll — still shows concurrency).
        this.timeline.recordRequest(this.offsetOf(event.ts), event.durationMs, event.ok, this.iterStarted - this.iterCompleted);
        if (event.iterationId) {
          this.samples.recordRequest(event.iterationId, {
            tsOffsetMs: this.offsetOf(event.ts),
            ...(event.stepId !== undefined ? { stepId: event.stepId } : {}),
            phase: this.phaseOf(event),
            method: event.method,
            routeKey: event.routeKey,
            ...(event.status !== undefined ? { status: event.status } : {}),
            ok: event.ok,
            durationMs: event.durationMs,
            ...(event.errorKind !== undefined ? { errorKind: event.errorKind } : {}),
          });
        }
        const ep = this.endpointAgg(event);
        ep.requestCount += 1;
        if (!event.ok) ep.errorCount += 1;
        ep.latency.record(event.durationMs);
        const statusKey = event.status === undefined ? "error" : String(event.status);
        ep.statusCounts[statusKey] = (ep.statusCounts[statusKey] ?? 0) + 1;

        const cell = this.matrixAgg(event);
        cell.requestCount += 1;
        if (!event.ok) cell.errorCount += 1;
        cell.latency.record(event.durationMs);

        // Attribute the request to its STEP's requestCount under the step's START
        // phase (not the request's live phase), so a post-boundary same-step request
        // lands in the step's single row — endpoint/matrix above already used the
        // live phase. (request:observed often arrives before step:end, so the step
        // agg is created lazily here under the same start phase as step:start.)
        if (event.stepId) {
          const step = this.getStep(
            event.scenarioId,
            event.scenarioRefId,
            event.stepId,
            this.stepStartPhase(event.iterationId, event.stepId, this.phaseOf(event)),
            event.stepId,
          );
          step.requestCount += 1;
        }
        break;
      }
      case "assertion:observed": {
        // Only failed assertions matter to a failure trace (they don't feed an aggregate —
        // step:end already carries the per-step failed-assertion count).
        if (!event.passed && event.iterationId) {
          this.samples.recordAssertionFailure(event.iterationId, {
            tsOffsetMs: this.offsetOf(event.ts),
            ...(event.stepId !== undefined ? { stepId: event.stepId } : {}),
            phase: this.phaseOf(event),
            ...(event.message !== undefined ? { message: event.message } : {}),
            // Presence (not value) checks so a deliberately-`undefined` operand survives.
            ...("actual" in event ? { actual: event.actual, hasActual: true } : {}),
            ...("expected" in event ? { expected: event.expected, hasExpected: true } : {}),
          });
        }
        break;
      }
      case "producer:primaryCompleted": {
        // The first primaryComplete boundary of an iteration (M5): record the
        // primary-phase duration and mark the iteration as having reached it.
        this.primaryBoundaries += 1;
        this.primaryLatency.record(event.primaryDurationMs);
        if (event.iterationId) {
          this.iterHadPrimary.add(event.iterationId);
          // A release request leaves the primary phase but isn't a continuation until
          // granted — until then it's parked on the backlog (blockedOnBacklog).
          if (event.releaseRequested) this.pendingRelease.add(event.iterationId);
        }
        break;
      }
      case "producer:released": {
        // A producer slot was freed at the boundary (M6): track release count, the
        // back-pressure wait, the peak backlog, and the now-live continuation (its
        // iteration is in continuation phase until its iteration:end).
        this.releasedProducerSlots += 1;
        this.continuationBackpressure.record(event.backpressureMs);
        if (event.continuationBacklog > this.maxContinuationBacklog) {
          this.maxContinuationBacklog = event.continuationBacklog;
        }
        if (event.iterationId) {
          this.pendingRelease.delete(event.iterationId); // granted → now a continuation
          this.liveContinuations.add(event.iterationId);
        }
        break;
      }
      case "producer:releaseRejected": {
        // A release that wasn't granted: a duplicate signal, or rejected (backlog full
        // under fail-iteration, a parked release whose drain bound expired, or one
        // cancelled by the run deadline).
        if (event.reason === "duplicateRelease") {
          this.duplicateReleaseSignals += 1;
        } else {
          this.rejectedReleaseSignals += 1;
          // A deadline-rejected release still STALLED the producer (it parked on the
          // full backlog until the deadline) — count that wait as back-pressure, and
          // it's no longer parked. (A duplicate's original release already cleared.)
          if (event.waitMs > 0) this.continuationBackpressure.record(event.waitMs);
          if (event.iterationId) this.pendingRelease.delete(event.iterationId);
        }
        break;
      }
      case "metric:observed":
        this.foldCustomMetric(event);
        break;
      case "producerSlot:start":
        // Slot-occupancy integration starts here (§6.2 conformance numerator). The
        // orchestrator emits this AFTER the slot's ramp delay, so pre-ramp time never
        // counts. A duplicate start for a live index (never produced by the
        // orchestrator) keeps the FIRST span open rather than resetting it.
        if (!this.openSlots.has(event.producerSlotIndex)) {
          this.openSlots.set(event.producerSlotIndex, this.offsetOf(event.ts));
        }
        break;
      case "producerSlot:end": {
        // Close the slot's occupancy span [start, end) into the per-window integral.
        // Think time and backlog-parked waits sit INSIDE the span (design occupancy);
        // under the closed producer-slot model the span is exact, not an approximation.
        const startOffset = this.openSlots.get(event.producerSlotIndex);
        if (startOffset !== undefined) {
          this.openSlots.delete(event.producerSlotIndex);
          this.slotBusy.addSpan(startOffset, this.offsetOf(event.ts));
        }
        break;
      }
      // assertion:observed / log:sampled / checkpoints are handled by the sink
      // (failure traces) or don't affect these aggregates.
      default:
        break;
    }
  }

  /** The run's time origin (epoch ms): the injected `timelineOrigin`, else the first event's
   *  ts (single-process: the run start). SINGLE-AXIS principle: once an origin is supplied,
   *  EVERY time quantity this reducer emits — window/sample offsets, `startedAt`,
   *  `durationMs`, `elapsedMs` (and thus throughput denominators) — is relative to it. That
   *  is exactly what distributed semantics want: a worker's local artifact describes its
   *  activity ON THE SHARED RUN AXIS (a late-starting worker's own firstTs would report
   *  deceptively small offsets and corrupt the coordinator's first-N ordering — and mixing
   *  axes inside one artifact would make it uninterpretable). Its duration therefore
   *  includes the pre-start idle gap — correct semantics, not a bug. This origin only fixes
   *  the START of the axis; the run's authoritative END boundary (the coordinator's
   *  `globalEndAt`, proposal §7.2) is supplied — when known — via `finalize(runEndMs)`;
   *  absent, the last observed event's ts closes the axis (single-process status quo). */
  private get originMs(): number | undefined {
    return this.timelineOrigin ?? this.firstTs;
  }

  /** Ms from `originMs` — the axis every offset shares (timeline windows, sample
   *  `completedAtOffsetMs` / `tsOffsetMs`, failure `atMs`). Clamped ≥ 0. */
  private offsetOf(ts: number): number {
    const origin = this.originMs;
    return origin !== undefined ? Math.max(0, ts - origin) : 0;
  }

  snapshot(now?: number): LoadProgressSnapshot {
    const at = now ?? this.lastTs;
    // Same axis as every other time quantity (see `originMs`): with an injected origin this
    // is elapsed on the shared RUN axis, not since this worker's first event — which also
    // keeps the throughput denominator below on that axis.
    const origin = this.originMs;
    const elapsedMs = origin !== undefined ? Math.max(0, at - origin) : 0;
    const elapsedSec = elapsedMs / 1000;
    return {
      elapsedMs,
      requestedConcurrency: this.requestedConcurrency,
      primaryInFlight: this.primaryInFlightCount(),
      continuationInFlight: this.liveContinuations.size,
      blockedOnBacklog: this.pendingRelease.size,
      primaryStarted: this.iterStarted,
      // With a phase split, "primary completed" = boundaries + no-boundary successes;
      // in the pure closed model (no primaryComplete) it coincides with completed
      // iterations.
      primaryCompleted: this.primaryBoundaries > 0 ? this.primaryCompletedCount() : this.iterCompleted,
      endToEndCompleted: this.iterCompleted,
      failedIterations: this.iterFailed,
      throughputPerSec: elapsedSec > 0 ? this.iterCompleted / elapsedSec : 0,
      transactionLatency: this.iterCompleted > 0 ? this.iterLatency.percentiles() : ZERO_PCT,
      topSlowEndpoints: this.topSlowEndpoints(3, elapsedSec),
      recentFailures: this.recentFailures.slice(-5),
    };
  }

  /** Finalize the artifact.
   *
   *  `runEndMs` — OPTIONAL authoritative run-end instant (epoch ms, SAME clock domain as
   *  `LoadEvent.ts` / `timelineOrigin`; the constructor's CLOCK-DOMAIN INVARIANT applies to
   *  it verbatim): the coordinator's `globalEndAt` (proposal §7.2 — dispatchDeadline + drain
   *  completion, quota completion, or the abort instant). When supplied,
   *  `durationMs = max(0, runEndMs − originMs)` and every throughput denominator (summary /
   *  phase / endpoint) follows it; the timeline zero-fill-extends to the same boundary
   *  through its existing `finalize(runEndMs)` offset parameter. When absent, the end falls
   *  back to the last observed event's ts — the single-process status quo, zero change.
   *
   *  WHY an explicit boundary: a worker's event EXTREMES are not the run INTERVAL. In a
   *  distributed run a lost worker (or an early quota finish) simply stops emitting — no
   *  event lands at the deadline, so a `lastTs` denominator closes the window early and the
   *  shard's throughput reads HIGHER than reality. The coordinator knows the real interval;
   *  supplying it makes the denominator authoritative.
   *
   *  A `runEndMs` EARLIER than the last observed event is taken AT VALUE (no clamp to
   *  `lastTs`): under the D0 trust model the coordinator is the single authority on the run
   *  interval — an event past `globalEndAt` is clock jitter or a straggler the coordinator
   *  already cut — and clamping would silently reintroduce the per-worker event-extremum
   *  denominator, making merged workers' denominators mutually inconsistent. Post-boundary
   *  windows / samples are still emitted (the timeline never truncates observed data), so
   *  `durationMs` may then sit below the largest offset. `max(0, …)` only floors the
   *  pathological runEnd-before-origin case at an empty interval. */
  finalize(runEndMs?: number): LoadArtifact {
    // The artifact's time metadata sits on the SAME axis as its offsets (see `originMs`):
    // startedAt IS the axis origin and durationMs spans origin → run end, where the run end
    // is the supplied authoritative boundary (coordinator `globalEndAt`) or, absent one, the
    // last observed event — under the fallback a window at offset X is always inside
    // [0, durationMs]; an authoritative boundary may cut before a straggler (jsdoc above).
    // With an injected origin a late-starting worker's duration includes its pre-start gap
    // (shared-run-axis semantics).
    const startedAtMs = this.originMs ?? 0;
    // No origin (no injected timelineOrigin AND no events) → no axis; `runEndMs` is a point
    // ON the axis, so the interval stays empty — matching the prior behavior exactly:
    // `lastTs` is 0 precisely when `originMs` is undefined (both are set by the first
    // event), so the old `lastTs − 0` was 0 too.
    const durationMs =
      this.originMs === undefined ? 0 : Math.max(0, (runEndMs ?? this.lastTs) - this.originMs);
    const elapsedSec = durationMs / 1000;
    const endpoints = this.endpointSummaries(elapsedSec);
    const anyHeuristicEndpoint = endpoints.some((e) => e.routeKeyHeuristic);

    const customMetrics = this.customMetricSummaries();
    const truncated = customMetrics.filter((m) => m.seriesTruncated).map((m) => m.metricId);
    const advisories =
      truncated.length > 0
        ? [
            `Custom metric(s) ${truncated.join(", ")} exceeded the ${DEFAULT_MAX_SERIES}-series ` +
              `cap; excess tag-series were folded into the untagged total. Lower the tag cardinality.`,
          ]
        : [];

    // Timeline: `durationMs` (already the authoritative interval when `runEndMs` was
    // supplied) drives the zero-fill extension — same boundary, same axis. One gap
    // `finalize` leaves: it early-returns EMPTY when it never recorded a window, so an
    // idle / lost shard (authoritative `runEndMs` supplied, zero events) would break the
    // shared axis's dense-series promise over [0, durationMs]. The reducer gates WHEN
    // synthesis applies (only under an explicit authoritative boundary — the lastTs
    // fallback keeps the empty-series status quo); the timeline owns HOW
    // (`synthesizeZero`: its own width/coarsening AND its contributor census, so a
    // censored merged-but-idle timeline still marks post-cutoff windows
    // contributorsPartial — codex R3).
    const rawTimeline = this.timeline.finalize(durationMs);
    const timeline =
      runEndMs !== undefined && durationMs > 0 && rawTimeline.windows.length === 0
        ? this.timeline.synthesizeZero(durationMs)
        : rawTimeline;

    return {
      // Release-order constraint: cloud platform-api KNOWN_VERSIONS must whitelist
      // glubean.load.v2 (deployed) BEFORE this ships in an OSS release — the run
      // ingest rejects unknown versions with 400 unsupported_schema_version, so
      // `glubean load --upload` would fail loudly until then. See the internal
      // distributed-execution proposal §11.1. Cloud-side change tracked by
      // orchestrator.
      schemaVersion: "glubean.load.v2",
      runnerId: this.runnerId,
      runMode: "load",
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs,
      source: { kind: "glubean-local", engine: "local" },
      config: this.config ?? ({ concurrency: this.requestedConcurrency } as LoadArtifactConfig),
      runtime: {
        engine: "local",
        processModel: "single-process-async-producer-slot",
        // A configured think-time makes this a paced closed run, not back-to-back.
        executionModel: this.config?.pacing?.thinkTimeMs !== undefined ? "closed-paced" : "closed-back-to-back",
        // Producer release ("producer-released") wins; else a primaryComplete
        // boundary is a MEASURED closed run (phase split); else plain closed.
        slotModel: this.releasedProducerSlots > 0
          ? "producer-released"
          : this.primaryBoundaries > 0
            ? "end-to-end-measured"
            : "end-to-end",
        requestedConcurrency: this.requestedConcurrency,
        // Same reducer state as snapshot(): an interrupted run (abort/crash with
        // started-but-not-ended iterations) shows its in-flight count, not 0.
        primaryInFlight: this.primaryInFlightCount(),
        // Released iterations still in their continuation phase at finalize (an
        // interrupted run; a clean run drains to 0). The orchestrator may raise this
        // for drain-timeout aborts whose tails it abandoned.
        continuationInFlight: this.liveContinuations.size,
        // Producers still parked on a full backlog at finalize (an interrupted run;
        // a clean run has none).
        blockedOnBacklog: this.pendingRelease.size,
        feederGuarantee: "single-node",
        sampleGranularity: "event",
        attribution: this.attribution(anyHeuristicEndpoint),
        percentileSource: "glubean-reducer",
        ...(this.crash ? { crash: this.crash } : {}),
        // Minimal execution-layer provenance (schema v2, §11): this process ran
        // every slot. The D1 coordinator fills the full block (coverage/workers).
        execution: { provider: "in-process", workerCount: 1 },
      },
      summary: {
        // §7.4 pass NECESSARY conditions (base verdict; the orchestrator then ANDs
        // in "every gate evaluated and passing" via evaluateThresholds): endReason
        // ∈ {duration, iterations} AND no crash. Abort → false; finalized without
        // a load:end (endReason undefined — the run never terminated cleanly) →
        // false. DELIBERATE v2 semantics change from the pre-v2 "didn't crash"
        // rule: an aborted single-machine run could previously pass — now it never
        // does (conservative direction: red, never green). Orthogonal to
        // executionStatus below (data completeness, not a verdict).
        pass:
          (this.endReason === "duration" || this.endReason === "iterations") &&
          this.crash === undefined,
        // Why the run ended (§7.4 priority: crash > abort > duration > iterations).
        // Omitted when no load:end was observed — "the run never terminated
        // cleanly" — which the pass rule above already forces to false.
        ...(this.endReason !== undefined ? { endReason: this.endReason } : {}),
        // Data completeness (§7.4), NOT a verdict: single-machine, the reducer
        // being finalized IS the run's one final state — always "complete", even
        // for abort/crash (those live in pass/endReason/crash). "partial"/"failed"
        // are D1 coordinator judgments.
        executionStatus: "complete",
        totalIterations: this.iterCompleted,
        successfulIterations: this.iterSucceeded,
        failedIterations: this.iterFailed,
        errorRate: rate(this.iterFailed, this.iterCompleted),
        throughputPerSec: elapsedSec > 0 ? this.iterCompleted / elapsedSec : 0,
        latency: this.iterCompleted > 0 ? this.iterLatency.percentiles() : ZERO_PCT,
        ...(this.iterCompleted > 0 ? { latencyDistribution: this.iterLatency.distribution(LATENCY_LADDER) } : {}),
        // Phase split (M5): present only once an iteration reached a primaryComplete
        // boundary. The top-level compat fields above stay end-to-end; `primary` /
        // `endToEnd` expose the split (primary = up to the boundary).
        ...(this.primaryBoundaries > 0
          ? { primary: this.primaryPhaseSummary(elapsedSec), endToEnd: this.endToEndPhaseSummary(elapsedSec) }
          : {}),
        // Continuation (M6): present once producer release is attempted.
        ...(this.releaseUsed() ? { continuation: this.continuationSummary() } : {}),
        thresholds: [],
        ...(customMetrics.length > 0 ? { customMetrics } : {}),
        ...(advisories.length > 0 ? { advisories } : {}),
      },
      scenarios: this.scenarioSummaries(),
      steps: this.stepSummaries(),
      endpoints,
      matrix: this.matrixSummaries(),
      timeline,
      samples: this.samples.finalize(),
    };
  }

  /**
   * Per-scope latency histograms for threshold interval evaluation (D0-T5).
   * `transaction`/`primary`/`endToEnd` are the reducer's own histograms (read-only
   * consumers — the evaluator never mutates them); the `endpoint`/`step` lookups
   * return the target's ALL-PHASE MERGED histogram (primary + continuation rows
   * folded into one distribution; steps also merge across scenarios, matching the
   * evaluator's stepId-only row filter). Merging goes through `clone()` first so an
   * evaluation-time merge can never pollute the live aggregates. `primary`/`endToEnd`
   * follow the phase-split presence rule of `summary.primary`/`summary.endToEnd`.
   * `custom` returns a TREND series' own histogram — the untagged total for `tags: {}`,
   * else the series located by the same `canonicalTagKey` the fold uses — and
   * undefined for rate/counter series (no histogram; those gates are exact counts).
   * `customSeriesComplete` exposes a series' fold completeness (hydrated merged state
   * may carry `complete: false`, §7.3) so the evaluator can refuse to decide gates on
   * undercounting values.
   */
  latencyQuantiles(): ThresholdQuantileSource {
    const mergedOver = (hists: LoadHistogram[]): LoadHistogram | undefined => {
      if (hists.length === 0) return undefined;
      if (hists.length === 1) return hists[0]; // read-only consumer → no merge, no clone needed
      const merged = hists[0].clone();
      for (let i = 1; i < hists.length; i++) merged.merge(hists[i]);
      return merged;
    };
    return {
      transaction: this.iterLatency,
      ...(this.primaryBoundaries > 0 ? { primary: this.primaryLatency, endToEnd: this.iterLatency } : {}),
      endpoint: (routeKey) =>
        mergedOver([...this.endpoints.values()].filter((e) => e.routeKey === routeKey).map((e) => e.latency)),
      step: (stepId) =>
        mergedOver([...this.steps.values()].filter((x) => x.stepId === stepId).map((x) => x.latency)),
      custom: (metricId, tags) => {
        const m = this.customMetrics.get(metricId);
        if (!m) return undefined;
        const series = Object.keys(tags).length === 0 ? m.total : m.series.get(canonicalTagKey(tags));
        return series?.hist; // only trend series carry a histogram
      },
      // Completeness of the target series' fold (codex R1): a hydrated merged state can
      // carry `complete: false` (§7.3's conservative rule — a truncated worker folded
      // this key invisibly into its total), and the retained values then UNDERCOUNT.
      // The evaluator turns such targets unevaluable ("series-incomplete") instead of
      // deciding gates on partial numbers. undefined = unknown metric/series; live
      // (non-hydrated) folds are always complete for retained keys.
      customSeriesComplete: (metricId, tags) => {
        const m = this.customMetrics.get(metricId);
        if (!m) return undefined;
        const series = Object.keys(tags).length === 0 ? m.total : m.series.get(canonicalTagKey(tags));
        return series === undefined ? undefined : series.complete !== false;
      },
    };
  }

  // ── partial export / hydration (proposal §7.5) ─────────────────────────

  /**
   * Export this reducer's COMPLETE aggregate state as a versioned, JSON-serializable
   * `LoadReducerPartialV1` (proposal §7.5): everything `finalize()` / `snapshot()` read
   * is present, so `exportPartial → JSON round-trip → fromPartial → finalize` is
   * IDENTICAL to a direct `finalize` (the D0 base invariant under D0-9's partition
   * identity). Repeat-safe: nothing here mutates live state (deep copies / fresh wire
   * objects throughout), so periodic snapshot exports (D1 §7.1) can call it freely.
   *
   * DELIBERATELY EXCLUDED transients (in-flight detail a cumulative snapshot does not
   * carry — each with why the exclusion is sound):
   *  - `iterHadPrimary` — per-in-flight boundary markers, only consulted at that
   *    iteration's own future `iteration:end`; completed work is already in the counts.
   *  - `iterStepPhase` — per-in-flight step start-phase attribution for FUTURE events.
   *  - `openSlots` — open producer-slot spans are not exported as open state; their
   *    occupancy up to `observedAt` is INTEGRATED into the exported slot-busy copy.
   *  - the sample collector's per-iteration in-flight buffers — bounded live scratch; a
   *    failure/slow sample only materializes at `iteration:end`.
   *  - sink-side state (step-name maps, live phase flips, poll spans) — upstream of the
   *    fact stream, not reducer state; its artifact effects (e.g. the long-poll
   *    advisory) travel via the partial's `advisories` slot, stamped by the shard
   *    runner (D1), not by the reducer.
   * Consequently a HYDRATED reducer is a finalize/merge substrate (plus threshold
   * quantile source), NOT an event consumer — applying further events to it is
   * unsupported (the transients above are gone).
   *
   * Envelope: `observedAt` = the snapshot instant `observedAtMs` (epoch ms, same clock
   * domain as `LoadEvent.ts` — the snapshot's observation cutoff for timeline
   * censoring); `liveInFlight` = started − completed at that instant.
   *
   * `observedAtMs` — the WALL-CLOCK instant this snapshot is taken (a D1 periodic
   * exporter passes its `now()`). It matters whenever the reducer sits in an
   * event-free gap (think time, backlog waits): the snapshot really observed that
   * idle span, so open producer-slot occupancy integrates up to it and the timeline
   * censoring cutoff sits at it (codex R1 P2 — with the `lastTs` fallback an open
   * slot's busy time silently truncated at the last event, and a merge treated the
   * observed idle gap as unobserved). DEFAULT: a HYDRATED reducer defaults to the
   * snapshot instant its source partial claimed (`hydratedObservedAt` — a re-export
   * must not shrink the frame's coverage, codex R2 P2-1); a live reducer defaults to
   * `lastTs` (the last applied event), which is only exact when the caller exports
   * immediately after the last event with no gap — acceptable for terminal exports
   * right after `load:end`, NOT for periodic mid-run snapshots. An instant EARLIER
   * than the coverage floor — `lastTs`, and for a hydrated instance also its source
   * frame's observedAt — is floored there (observation coverage cannot be narrower
   * than what was already folded / already claimed).
   */
  exportPartial(observedAtMs?: number): LoadReducerPartialV1 {
    // Coverage floor: events already folded (lastTs) and, for a hydrated instance,
    // the snapshot instant its source frame already claimed.
    const floor = Math.max(this.lastTs, this.hydratedObservedAt ?? 0);
    const observedAt = Math.max(floor, observedAtMs ?? floor);
    // Slot busy: closed spans + every OPEN slot's occupancy truncated at the snapshot
    // instant, folded into a CLONE so the live accumulator is untouched.
    const slotBusy = this.slotBusy.clone();
    const observedAtOffset = this.offsetOf(observedAt);
    for (const startOffset of this.openSlots.values()) {
      slotBusy.addSpan(startOffset, observedAtOffset);
    }
    const anyHeuristicEndpoint = [...this.endpoints.values()].some((e) => e.routeKeyHeuristic);
    const seriesJSON = (s: CustomSeriesAgg): LoadPartialCustomSeriesV1 => ({
      tags: { ...s.tags },
      count: s.count,
      trueCount: s.trueCount,
      sum: s.sum,
      ...(s.hist !== undefined ? { hist: s.hist.toJSON() } : {}),
      // A worker's own LIVE fold is always complete for retained keys: the series cap
      // only blocks NEW keys (overflow folds into the total). `complete: false` is
      // computed by `mergePartials` (§7.3's conservative rule) and survives a
      // hydrate → re-export round trip via the agg's carried flag.
      complete: s.complete !== false,
    });
    return {
      v: 1,
      observedAt,
      liveInFlight: Math.max(0, this.iterStarted - this.iterCompleted),
      ...(this.workerId !== undefined ? { workerId: this.workerId } : {}),
      ...(this.timelineOrigin !== undefined ? { timelineOrigin: this.timelineOrigin } : {}),
      // Feeder-state guarantee of THIS worker's segment — the single-machine reducer
      // semantics finalize() also reports; the D1 shard runner stamps its real value
      // post-export when it differs. `workerCount` is deliberately NOT stamped here:
      // its presence marks a coordinator-merged aggregate (mergePartials stamps it),
      // and coordinator-merge metadata does not survive a worker-side re-export.
      feederGuarantee: "single-node",
      runnerId: this.runnerId,
      ...(this.config !== undefined ? { config: structuredClone(this.config) } : {}),
      requestedConcurrency: this.requestedConcurrency,
      ...(this.endReason !== undefined ? { endReason: this.endReason } : {}),
      ...(this.crash !== undefined ? { crash: structuredClone(this.crash) } : {}),
      ...(this.firstTs !== undefined ? { firstTs: this.firstTs } : {}),
      lastTs: this.lastTs,
      iterStarted: this.iterStarted,
      iterCompleted: this.iterCompleted,
      iterSucceeded: this.iterSucceeded,
      iterFailed: this.iterFailed,
      iterLatency: this.iterLatency.toJSON(),
      primaryBoundaries: this.primaryBoundaries,
      failedBeforePrimary: this.failedBeforePrimary,
      endedWithoutBoundary: this.endedWithoutBoundary,
      primaryLatency: this.primaryLatency.toJSON(),
      releasedProducerSlots: this.releasedProducerSlots,
      rejectedReleaseSignals: this.rejectedReleaseSignals,
      duplicateReleaseSignals: this.duplicateReleaseSignals,
      maxContinuationBacklog: this.maxContinuationBacklog,
      continuationBackpressure: this.continuationBackpressure.toJSON(),
      // Live in-flight COUNTS (not the id sets — ids are per-worker transients, but the
      // counts drive finalize's interrupted-run reporting, so they must survive).
      liveContinuations: this.liveContinuations.size,
      pendingReleases: this.pendingRelease.size,
      scenarios: [...this.scenarios.values()].map((s) => ({
        scenarioId: s.scenarioId,
        ...(s.scenarioRefId !== undefined ? { scenarioRefId: s.scenarioRefId } : {}),
        iterations: s.iterations,
        successful: s.successful,
        failed: s.failed,
        latency: s.latency.toJSON(),
      })),
      steps: [...this.steps.values()].map((s) => ({
        scenarioId: s.scenarioId,
        ...(s.scenarioRefId !== undefined ? { scenarioRefId: s.scenarioRefId } : {}),
        stepId: s.stepId,
        stepName: s.stepName,
        ...(s.groupId !== undefined ? { groupId: s.groupId } : {}),
        phase: s.phase,
        invocationCount: s.invocationCount,
        skippedCount: s.skippedCount,
        assertionFailureCount: s.assertionFailureCount,
        errorCount: s.errorCount,
        requestCount: s.requestCount,
        latency: s.latency.toJSON(),
      })),
      endpoints: [...this.endpoints.values()].map((e) => ({
        routeKey: e.routeKey,
        ...(e.phase !== undefined ? { phase: e.phase } : {}),
        routeKeySource: e.routeKeySource,
        routeKeyHeuristic: e.routeKeyHeuristic,
        ...(e.method !== undefined ? { method: e.method } : {}),
        requestCount: e.requestCount,
        errorCount: e.errorCount,
        statusCounts: { ...e.statusCounts },
        latency: e.latency.toJSON(),
      })),
      matrix: [...this.matrix.values()].map((m) => ({
        scenarioId: m.scenarioId,
        ...(m.scenarioRefId !== undefined ? { scenarioRefId: m.scenarioRefId } : {}),
        ...(m.stepId !== undefined ? { stepId: m.stepId } : {}),
        ...(m.phase !== undefined ? { phase: m.phase } : {}),
        routeKey: m.routeKey,
        routeKeySource: m.routeKeySource,
        routeKeyHeuristic: m.routeKeyHeuristic,
        requestCount: m.requestCount,
        errorCount: m.errorCount,
        latency: m.latency.toJSON(),
      })),
      customMetrics: [...this.customMetrics.values()].map(
        (m): LoadPartialCustomMetricV1 => ({
          metricId: m.metricId,
          kind: m.kind,
          ...(m.unit !== undefined ? { unit: m.unit } : {}),
          total: seriesJSON(m.total),
          series: [...m.series.values()].map(seriesJSON),
          seriesTruncated: m.truncated,
        }),
      ),
      recentFailures: structuredClone(this.recentFailures),
      timeline: this.timeline.toJSON(),
      slotBusy: slotBusy.toJSON(),
      samples: structuredClone(this.samples.finalize()),
      // Reducer-derivable advisories (custom-metric truncation) are RE-DERIVED from the
      // hydrated state at finalize, so they are deliberately not duplicated here; this
      // slot carries EXTRA advisories from outside the reducer (the D1 shard runner
      // stamps sink/orchestrator-level ones, e.g. the long-poll advisory).
      advisories: [],
      attribution: this.attribution(anyHeuristicEndpoint),
    };
  }

  /**
   * Hydrate a reducer from a VALIDATED `LoadReducerPartialV1` (see
   * `parseLoadReducerPartial` in partial.ts — this method assumes the shape holds and
   * delegates the deep sub-payload checks to each `fromJSON`). The result is a
   * finalize/merge substrate: `finalize(runEndMs)` and `latencyQuantiles()` behave
   * exactly as on the original reducer (the round-trip identity), and a no-arg
   * `exportPartial()` re-export reproduces the source frame (its observedAt is
   * preserved as the coverage floor, never regressing to the earlier lastTs), but
   * applying further events is unsupported — the transients `exportPartial` excludes
   * are gone.
   *
   * `opts.timelineOrigin` supplies the shared axis when the partial's envelope lacks it
   * (its offsets then anchored to `firstTs`, which must agree — enforced by the caller,
   * `finalizeMerged`); when the partial carries an origin it wins by default.
   */
  static fromPartial(
    p: LoadReducerPartialV1,
    opts: { timelineOrigin?: number } = {},
  ): LoadReducerImpl {
    const origin = p.timelineOrigin ?? opts.timelineOrigin;
    const r = new LoadReducerImpl({
      maxFailureTraces: p.samples.maxFailureTraces,
      maxSlowTransactionSummaries: p.samples.maxSlowTransactionSummaries,
      ...(p.workerId !== undefined ? { workerId: p.workerId } : {}),
      ...(origin !== undefined ? { timelineOrigin: origin } : {}),
    });
    r.runnerId = p.runnerId;
    if (p.config !== undefined) r.config = structuredClone(p.config);
    r.requestedConcurrency = p.requestedConcurrency;
    if (p.endReason !== undefined) r.endReason = p.endReason;
    if (p.crash !== undefined) r.crash = structuredClone(p.crash);
    if (p.firstTs !== undefined) r.firstTs = p.firstTs;
    r.lastTs = p.lastTs;
    // Preserve the source frame's snapshot instant (codex R2 P2-1): it is this
    // instance's coverage floor and its no-arg re-export default, so hydrate →
    // re-export keeps observedAt consistent with the already-integrated slot-busy
    // windows / censoring anchors instead of regressing to the earlier lastTs.
    r.hydratedObservedAt = p.observedAt;
    r.iterStarted = p.iterStarted;
    r.iterCompleted = p.iterCompleted;
    r.iterSucceeded = p.iterSucceeded;
    r.iterFailed = p.iterFailed;
    // Histograms revive by merging into the fresh (empty) defaults — an exact copy, and
    // safe because the partial validation pins every embedded histogram to the default
    // relativeError (the same operational invariant the timeline enforces per window).
    r.iterLatency.merge(LoadHistogram.fromJSON(p.iterLatency));
    r.primaryBoundaries = p.primaryBoundaries;
    r.failedBeforePrimary = p.failedBeforePrimary;
    r.endedWithoutBoundary = p.endedWithoutBoundary;
    r.primaryLatency.merge(LoadHistogram.fromJSON(p.primaryLatency));
    r.releasedProducerSlots = p.releasedProducerSlots;
    r.rejectedReleaseSignals = p.rejectedReleaseSignals;
    r.duplicateReleaseSignals = p.duplicateReleaseSignals;
    r.maxContinuationBacklog = p.maxContinuationBacklog;
    r.continuationBackpressure.merge(LoadHistogram.fromJSON(p.continuationBackpressure));
    // The id SETS are per-worker transients; only their SIZES affect finalize/snapshot.
    // Synthetic members restore the sizes (the \u0000 prefix cannot collide with real
    // iteration ids, which the orchestrator mints as `it-N`).
    for (let i = 0; i < p.liveContinuations; i++) r.liveContinuations.add(`\u0000hydrated:continuation:${i}`);
    for (let i = 0; i < p.pendingReleases; i++) r.pendingRelease.add(`\u0000hydrated:pending-release:${i}`);
    for (const s of p.scenarios) {
      r.scenarios.set(r.scenarioKey(s.scenarioId, s.scenarioRefId), {
        scenarioId: s.scenarioId,
        ...(s.scenarioRefId !== undefined ? { scenarioRefId: s.scenarioRefId } : {}),
        iterations: s.iterations,
        successful: s.successful,
        failed: s.failed,
        latency: LoadHistogram.fromJSON(s.latency),
      });
    }
    for (const s of p.steps) {
      r.steps.set(r.stepKey(s.scenarioId, s.scenarioRefId, s.stepId, s.phase), {
        scenarioId: s.scenarioId,
        ...(s.scenarioRefId !== undefined ? { scenarioRefId: s.scenarioRefId } : {}),
        stepId: s.stepId,
        stepName: s.stepName,
        ...(s.groupId !== undefined ? { groupId: s.groupId } : {}),
        phase: s.phase,
        invocationCount: s.invocationCount,
        skippedCount: s.skippedCount,
        assertionFailureCount: s.assertionFailureCount,
        errorCount: s.errorCount,
        requestCount: s.requestCount,
        latency: LoadHistogram.fromJSON(s.latency),
      });
    }
    for (const e of p.endpoints) {
      r.endpoints.set(`${e.routeKey}${SEP}${e.phase ?? ""}`, {
        routeKey: e.routeKey,
        ...(e.phase !== undefined ? { phase: e.phase } : {}),
        routeKeySource: e.routeKeySource,
        routeKeyHeuristic: e.routeKeyHeuristic,
        ...(e.method !== undefined ? { method: e.method } : {}),
        requestCount: e.requestCount,
        errorCount: e.errorCount,
        statusCounts: { ...e.statusCounts },
        latency: LoadHistogram.fromJSON(e.latency),
      });
    }
    for (const m of p.matrix) {
      r.matrix.set(
        `${m.scenarioId}${SEP}${m.scenarioRefId ?? ""}${SEP}${m.stepId ?? ""}${SEP}${m.routeKey}${SEP}${m.phase ?? ""}`,
        {
          scenarioId: m.scenarioId,
          ...(m.scenarioRefId !== undefined ? { scenarioRefId: m.scenarioRefId } : {}),
          ...(m.stepId !== undefined ? { stepId: m.stepId } : {}),
          ...(m.phase !== undefined ? { phase: m.phase } : {}),
          routeKey: m.routeKey,
          routeKeySource: m.routeKeySource,
          routeKeyHeuristic: m.routeKeyHeuristic,
          requestCount: m.requestCount,
          errorCount: m.errorCount,
          latency: LoadHistogram.fromJSON(m.latency),
        },
      );
    }
    const reviveSeries = (s: LoadPartialCustomSeriesV1): CustomSeriesAgg => ({
      tags: { ...s.tags },
      count: s.count,
      trueCount: s.trueCount,
      sum: s.sum,
      // hist presence follows the metric kind (validated: present iff trend).
      ...(s.hist !== undefined ? { hist: LoadHistogram.fromJSON(s.hist) } : {}),
      // Completeness survives hydration (codex R1 P1): a merged partial's
      // `complete: false` must reach threshold evaluation (via
      // `latencyQuantiles().customSeriesComplete`) — the retained values undercount,
      // so deciding a gate on them would false-pass. Absent when complete (the
      // live-fold default). It has no artifact-v1 row slot, but it is NOT display
      // data — it gates evaluability.
      ...(s.complete === false ? { complete: false } : {}),
    });
    for (const m of p.customMetrics) {
      r.customMetrics.set(m.metricId, {
        metricId: m.metricId,
        kind: m.kind,
        ...(m.unit !== undefined ? { unit: m.unit } : {}),
        total: reviveSeries(m.total),
        series: new Map(m.series.map((s) => [canonicalTagKey(s.tags), reviveSeries(s)])),
        truncated: m.seriesTruncated,
      });
    }
    r.recentFailures.push(...structuredClone(p.recentFailures));
    r.samples.restoreRetained(
      structuredClone({
        failureTraces: p.samples.failureTraces,
        slowTransactions: p.samples.slowTransactions,
      }),
    );
    r.timeline = LoadTimeline.fromJSON(p.timeline);
    r.slotBusy = SlotBusyWindows.fromJSON(p.slotBusy);
    return r;
  }

  // ── aggregate accessors ────────────────────────────────────────────────

  private phaseOf(event: LoadEvent): Phase {
    return event.phase ?? "primary";
  }

  /** Record the phase a step started in for this iteration (from step:start). */
  private rememberStepPhase(iterationId: string | undefined, stepId: string, phase: Phase): void {
    if (!iterationId) return;
    let m = this.iterStepPhase.get(iterationId);
    if (!m) {
      m = new Map();
      this.iterStepPhase.set(iterationId, m);
    }
    m.set(stepId, phase);
  }

  /** The phase a step started in this iteration (falls back to `live` for a SKIPPED
   *  leaf, which emits no step:start, or an untracked iteration). */
  private stepStartPhase(iterationId: string | undefined, stepId: string, live: Phase): Phase {
    if (!iterationId) return live;
    return this.iterStepPhase.get(iterationId)?.get(stepId) ?? live;
  }

  private scenarioKey(scenarioId: string, scenarioRefId?: string): string {
    return `${scenarioId}${SEP}${scenarioRefId ?? ""}`;
  }

  // ── custom metrics (rate / trend / counter) ────────────────────────────

  /** Fold one `metric:observed` into the untagged total and (if tagged) its
   *  tag-series, enforcing the per-metric series cap. */
  private foldCustomMetric(e: Extract<LoadEvent, { type: "metric:observed" }>): void {
    // Defense at the FOLD point, not just the handle: `metric:observed` can come from
    // an external-engine adapter (M9), where a NaN/Infinity value would count as a
    // true rate / poison a counter sum, and an out-of-union kind would fork the fold
    // into a schema-invalid artifact row. (`ctx.metrics` handles already filter both.)
    if (!Number.isFinite(e.value)) return;
    if (e.kind !== "rate" && e.kind !== "counter" && e.kind !== "trend") return;
    let m = this.customMetrics.get(e.metricId);
    if (!m) {
      m = {
        metricId: e.metricId,
        kind: e.kind,
        ...(e.unit !== undefined ? { unit: e.unit } : {}),
        total: newCustomSeries({}, e.kind),
        series: new Map(),
        truncated: false,
      };
      this.customMetrics.set(e.metricId, m);
    }
    // The untagged total folds EVERY observation (so a `metricId` threshold gates the
    // whole metric and series-cap overflow is never lost). Use the metric's recorded
    // kind, not the event's, so a mismatched event can't fork the fold.
    recordCustomSample(m.total, m.kind, e.value);

    const tags = e.tags;
    if (tags && Object.keys(tags).length > 0) {
      const key = canonicalTagKey(tags);
      let s = m.series.get(key);
      if (!s) {
        if (m.series.size >= DEFAULT_MAX_SERIES) {
          // Cap hit: the observation already counted in the total; don't grow the map.
          m.truncated = true;
          return;
        }
        s = newCustomSeries({ ...tags }, m.kind);
        m.series.set(key, s);
      }
      recordCustomSample(s, m.kind, e.value);
    }
  }

  /** Build the `customMetrics` artifact rows (total series first, then each tag-series). */
  private customMetricSummaries(): LoadCustomMetric[] {
    const out: LoadCustomMetric[] = [];
    for (const m of this.customMetrics.values()) {
      const series: LoadCustomMetricSeries[] = [
        customSeriesSummary(m.total, m.kind),
        ...[...m.series.values()].map((s) => customSeriesSummary(s, m.kind)),
      ];
      out.push({
        metricId: m.metricId,
        kind: m.kind,
        ...(m.unit !== undefined ? { unit: m.unit } : {}),
        series,
        ...(m.truncated ? { seriesTruncated: true } : {}),
      });
    }
    return out;
  }

  private scenarioAgg(scenarioId?: string, scenarioRefId?: string): ScenarioAgg | undefined {
    if (!scenarioId) return undefined;
    const key = this.scenarioKey(scenarioId, scenarioRefId);
    let agg = this.scenarios.get(key);
    if (!agg) {
      agg = {
        scenarioId,
        ...(scenarioRefId !== undefined ? { scenarioRefId } : {}),
        iterations: 0,
        successful: 0,
        failed: 0,
        latency: new LoadHistogram(),
      };
      this.scenarios.set(key, agg);
    }
    return agg;
  }

  // Steps are keyed by (stepId, the phase the invocation STARTED in). A step that
  // spans the boundary stays ONE row — every event of that invocation resolves to
  // its captured start phase (`iterStepPhase`), so a post-boundary same-step request
  // can't fork a phantom row — while the SAME stepId starting in different phases
  // across iterations (a conditional boundary) correctly splits into two rows.
  // Endpoints / matrix still split by the request's LIVE phase, so post-boundary
  // requests show as continuation.
  private stepKey(
    scenarioId: string | undefined,
    scenarioRefId: string | undefined,
    stepId: string,
    phase: Phase,
  ): string {
    return `${scenarioId ?? ""}${SEP}${scenarioRefId ?? ""}${SEP}${stepId}${SEP}${phase}`;
  }

  private getStep(
    scenarioId: string | undefined,
    scenarioRefId: string | undefined,
    stepId: string,
    phase: Phase,
    stepName: string,
  ): StepAgg {
    const key = this.stepKey(scenarioId, scenarioRefId, stepId, phase);
    let agg = this.steps.get(key);
    if (!agg) {
      agg = {
        scenarioId: scenarioId ?? "",
        ...(scenarioRefId !== undefined ? { scenarioRefId } : {}),
        stepId,
        stepName,
        phase, // the phase of the step's FIRST event (its start)
        invocationCount: 0,
        skippedCount: 0,
        assertionFailureCount: 0,
        errorCount: 0,
        requestCount: 0,
        latency: new LoadHistogram(),
      };
      this.steps.set(key, agg);
    }
    return agg;
  }

  private endpointAgg(event: Extract<LoadEvent, { type: "request:observed" }>): EndpointAgg {
    const phase = this.phaseOf(event); // normalize omitted phase to "primary" (matches steps)
    const key = `${event.routeKey}${SEP}${phase}`;
    let agg = this.endpoints.get(key);
    if (!agg) {
      agg = {
        routeKey: event.routeKey,
        phase,
        routeKeySource: event.routeKeySource,
        routeKeyHeuristic: event.routeKeyHeuristic,
        method: event.method,
        requestCount: 0,
        errorCount: 0,
        statusCounts: {},
        latency: new LoadHistogram(),
      };
      this.endpoints.set(key, agg);
    }
    // If any request for this routeKey is heuristic, the aggregate is heuristic.
    if (event.routeKeyHeuristic && !agg.routeKeyHeuristic) {
      agg.routeKeyHeuristic = true;
      agg.routeKeySource = event.routeKeySource;
    }
    return agg;
  }

  private matrixAgg(event: Extract<LoadEvent, { type: "request:observed" }>): MatrixAgg {
    const phase = this.phaseOf(event); // normalize omitted phase to "primary" (matches steps)
    const key = `${event.scenarioId ?? ""}${SEP}${event.scenarioRefId ?? ""}${SEP}${event.stepId ?? ""}${SEP}${event.routeKey}${SEP}${phase}`;
    let agg = this.matrix.get(key);
    if (!agg) {
      agg = {
        scenarioId: event.scenarioId ?? "",
        ...(event.scenarioRefId !== undefined ? { scenarioRefId: event.scenarioRefId } : {}),
        ...(event.stepId !== undefined ? { stepId: event.stepId } : {}),
        phase,
        routeKey: event.routeKey,
        routeKeySource: event.routeKeySource,
        routeKeyHeuristic: event.routeKeyHeuristic,
        requestCount: 0,
        errorCount: 0,
        latency: new LoadHistogram(),
      };
      this.matrix.set(key, agg);
    }
    if (event.routeKeyHeuristic && !agg.routeKeyHeuristic) {
      agg.routeKeyHeuristic = true;
      agg.routeKeySource = event.routeKeySource;
    }
    return agg;
  }

  private pushFailure(f: LoadFailureSummary): void {
    this.recentFailures.push(f);
    if (this.recentFailures.length > 100) this.recentFailures.shift();
  }

  // ── summary builders ───────────────────────────────────────────────────

  /** Iterations still in their primary phase: started, not yet at a boundary, and
   *  not ended before reaching one. Without any boundary this is the ordinary
   *  end-to-end in-flight count (started − completed). */
  private primaryInFlightCount(): number {
    return Math.max(0, this.iterStarted - this.primaryBoundaries - this.endedWithoutBoundary);
  }

  /** Iterations that COMPLETED their primary phase: those that hit the boundary,
   *  plus no-boundary successes (whose primary phase is the whole iteration). Keeps
   *  `started = completed + failedBeforeRelease + inFlightAtEnd` consistent. */
  private primaryCompletedCount(): number {
    return this.primaryBoundaries + (this.endedWithoutBoundary - this.failedBeforePrimary);
  }

  /** Primary-phase aggregate (producer side) — present only with a boundary. */
  private primaryPhaseSummary(elapsedSec: number): LoadPrimaryPhaseSummary {
    const completed = this.primaryCompletedCount();
    return {
      started: this.iterStarted,
      completed,
      failedBeforeRelease: this.failedBeforePrimary,
      throughputPerSec: elapsedSec > 0 ? completed / elapsedSec : 0,
      latency: this.primaryLatency.count > 0 ? this.primaryLatency.percentiles() : ZERO_PCT,
    };
  }

  /** End-to-end aggregate (full logical iteration) — the structured form of the
   *  top-level compat fields, surfaced alongside `primary` when the split exists. */
  private endToEndPhaseSummary(elapsedSec: number): LoadEndToEndSummary {
    return {
      started: this.iterStarted,
      completed: this.iterCompleted,
      successful: this.iterSucceeded,
      failed: this.iterFailed,
      inFlightAtEnd: Math.max(0, this.iterStarted - this.iterCompleted),
      errorRate: rate(this.iterFailed, this.iterCompleted),
      throughputPerSec: elapsedSec > 0 ? this.iterCompleted / elapsedSec : 0,
      latency: this.iterCompleted > 0 ? this.iterLatency.percentiles() : ZERO_PCT,
    };
  }

  /** Whether producer release was attempted at all (release granted, rejected, a
   *  duplicate, or still parked on the backlog at finalize) — gates the continuation
   *  summary's presence so an interrupted run with a parked release still reports it. */
  private releaseUsed(): boolean {
    return (
      this.releasedProducerSlots > 0 ||
      this.rejectedReleaseSignals > 0 ||
      this.duplicateReleaseSignals > 0 ||
      this.pendingRelease.size > 0
    );
  }

  /** Continuation (bounded-open) subsystem summary (M6). A finalized run has drained
   *  its continuations, so live counts (backlog / active / blockedOnBacklog) are 0;
   *  the cumulative release / back-pressure / coverage figures are what matter. */
  private continuationSummary(): LoadContinuationSummary {
    const hasBackpressure = this.continuationBackpressure.count > 0;
    const waits = hasBackpressure ? this.continuationBackpressure.percentiles() : undefined;
    const live = this.liveContinuations.size; // in-flight at finalize (0 for a clean run)
    return {
      backlog: live,
      maxBacklog: this.maxContinuationBacklog,
      // Every in-flight continuation is concurrently scheduled in this single-process
      // model, so peak concurrency coincides with peak backlog.
      maxConcurrent: this.maxContinuationBacklog,
      active: live,
      ...(waits ? { queueWaitMs: waits, backpressureMs: waits } : {}),
      releasedProducerSlots: this.releasedProducerSlots,
      // Coverage: how many iterations reached a boundary, and of those how many
      // actually released — a low value flags branch/error paths that skipped it.
      primaryBoundaryCoverage: this.iterStarted > 0 ? this.primaryBoundaries / this.iterStarted : 0,
      releaseCoverage: this.primaryBoundaries > 0 ? this.releasedProducerSlots / this.primaryBoundaries : 0,
      duplicateReleaseSignals: this.duplicateReleaseSignals,
      rejectedReleaseSignals: this.rejectedReleaseSignals,
      abortedByDrainTimeout: 0, // drain-timeout abort lands in M6-d
    };
  }

  private attribution(anyHeuristicEndpoint: boolean): LoadArtifact["runtime"]["attribution"] {
    const canonical: LoadAttributionQuality = "canonical";
    return {
      scenario: canonical,
      step: canonical,
      endpoint: anyHeuristicEndpoint ? "heuristic" : canonical,
      phase: canonical,
      iteration: canonical,
      failureTrace: canonical,
    };
  }

  private stepSummary(agg: StepAgg): LoadStepSummary {
    return {
      scenarioId: agg.scenarioId,
      // Carry the mix entry id so two entries referencing the SAME scenario aren't
      // indistinguishable in the flat `artifact.steps` (matches the scenario summaries
      // + matrix, which already carry it). Omitted for a single scenario.
      ...(agg.scenarioRefId !== undefined ? { scenarioRefId: agg.scenarioRefId } : {}),
      stepId: agg.stepId,
      stepName: agg.stepName,
      ...(agg.groupId !== undefined ? { groupId: agg.groupId } : {}),
      phase: agg.phase,
      invocationCount: agg.invocationCount,
      skippedCount: agg.skippedCount,
      assertionFailureCount: agg.assertionFailureCount,
      errorCount: agg.errorCount,
      // Error rate is over EXECUTED invocations — skipped steps aren't failures.
      errorRate: rate(agg.errorCount, agg.invocationCount - agg.skippedCount),
      latency: agg.latency.count > 0 ? agg.latency.percentiles() : ZERO_PCT,
      requestCount: agg.requestCount,
    };
  }

  private stepSummaries(): LoadStepSummary[] {
    return [...this.steps.values()].map((s) => this.stepSummary(s));
  }

  private scenarioSummaries(): LoadScenarioSummary[] {
    const stepsByScenario = new Map<string, LoadStepSummary[]>();
    for (const s of this.steps.values()) {
      const k = this.scenarioKey(s.scenarioId, s.scenarioRefId);
      const list = stepsByScenario.get(k) ?? [];
      list.push(this.stepSummary(s));
      stepsByScenario.set(k, list);
    }
    return [...this.scenarios.values()].map((sc) => ({
      scenarioId: sc.scenarioId,
      ...(sc.scenarioRefId !== undefined ? { scenarioRefId: sc.scenarioRefId } : {}),
      iterations: sc.iterations,
      successfulIterations: sc.successful,
      failedIterations: sc.failed,
      errorRate: rate(sc.failed, sc.iterations),
      latency: sc.latency.count > 0 ? sc.latency.percentiles() : ZERO_PCT,
      steps: stepsByScenario.get(this.scenarioKey(sc.scenarioId, sc.scenarioRefId)) ?? [],
    }));
  }

  private endpointSummaries(elapsedSec: number): LoadEndpointSummary[] {
    return [...this.endpoints.values()].map((e) => ({
      routeKey: e.routeKey,
      ...(e.phase !== undefined ? { phase: e.phase } : {}),
      routeKeySource: e.routeKeySource,
      routeKeyHeuristic: e.routeKeyHeuristic,
      ...(e.method !== undefined ? { method: e.method } : {}),
      requestCount: e.requestCount,
      errorCount: e.errorCount,
      errorRate: rate(e.errorCount, e.requestCount),
      statusCounts: e.statusCounts,
      latency: e.latency.count > 0 ? e.latency.percentiles() : ZERO_PCT,
      ...(e.latency.count > 0 ? { latencyDistribution: e.latency.distribution(LATENCY_LADDER) } : {}),
      throughputPerSec: elapsedSec > 0 ? e.requestCount / elapsedSec : 0,
    }));
  }

  private matrixSummaries(): LoadScenarioEndpointMatrix[] {
    // Resolve a matrix cell's stepName by stepId regardless of phase: the cell's
    // phase is the request's LIVE phase, but the step agg is keyed by its start
    // phase, so a post-boundary request's cell would otherwise miss its step row.
    const stepNameById = new Map<string, string>();
    for (const s of this.steps.values()) {
      stepNameById.set(`${this.scenarioKey(s.scenarioId, s.scenarioRefId)}${SEP}${s.stepId}`, s.stepName);
    }
    return [...this.matrix.values()].map((m) => {
      const stepName =
        m.stepId !== undefined
          ? stepNameById.get(`${this.scenarioKey(m.scenarioId, m.scenarioRefId)}${SEP}${m.stepId}`)
          : undefined;
      return {
        scenarioId: m.scenarioId,
        ...(m.scenarioRefId !== undefined ? { scenarioRefId: m.scenarioRefId } : {}),
        ...(m.stepId !== undefined ? { stepId: m.stepId } : {}),
        ...(stepName !== undefined ? { stepName } : {}),
        ...(m.phase !== undefined ? { phase: m.phase } : {}),
        routeKey: m.routeKey,
        routeKeySource: m.routeKeySource,
        routeKeyHeuristic: m.routeKeyHeuristic,
        requestCount: m.requestCount,
        errorRate: rate(m.errorCount, m.requestCount),
        latency: m.latency.count > 0 ? m.latency.percentiles() : ZERO_PCT,
      };
    });
  }

  private topSlowEndpoints(n: number, elapsedSec: number): LoadEndpointSummary[] {
    return this.endpointSummaries(elapsedSec)
      .sort((a, b) => b.latency.p95 - a.latency.p95)
      .slice(0, n);
  }
}

/** Create a fresh streaming load reducer. The cap fields bound the failure-trace /
 *  slow-transaction samples (from the plan's `report` config; 0 disables a type). The other
 *  two knobs exist for a DISTRIBUTED run's per-worker reducer; single-process callers omit
 *  both:
 *  - `workerId` — the shard identity, stamped into sample identities so the coordinator's
 *    merge keys `(workerId, iterationId)` are unique and totally ordered across workers.
 *  - `timelineOrigin` — epoch ms that EVERY emitted time quantity (timeline-window / sample
 *    offsets, `startedAt`, `durationMs`, `elapsedMs`) is computed against — one axis, never
 *    a mix. The coordinator hands all workers ONE shared origin so their artifacts are
 *    globally comparable; when absent (single-process), the origin is the first event's
 *    ts, as before. MUST be in the SAME clock domain as the events' `ts` this reducer
 *    consumes: in-process / multi-core share the host clock (pass the epoch t0 as-is);
 *    a remote agent converts the coordinator's origin to the worker's local epoch via the
 *    handshake clock mapping BEFORE constructing the reducer. The reducer itself is
 *    deliberately clock-agnostic (see the constructor's invariant note).
 *
 *  Distributed finalize: `finalize(runEndMs)` — on the SDK `LoadReducer` contract itself —
 *  accepts the coordinator's authoritative run-end instant (`globalEndAt`, proposal §7.2)
 *  as the duration / throughput denominator; absent, the last observed event closes the
 *  interval (single-process status quo). */
export function createLoadReducer(config?: {
  maxFailureTraces?: number;
  maxSlowTransactionSummaries?: number;
  workerId?: string;
  timelineOrigin?: number;
}): LoadReducerImpl {
  // Returns the concrete impl (still `implements LoadReducer`): the orchestrator needs
  // `latencyQuantiles()` — the threshold evaluator's histogram source — which is a
  // runner-internal surface, not part of the SDK reducer contract.
  return new LoadReducerImpl(config);
}
