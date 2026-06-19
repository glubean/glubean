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
  LoadCrashSummary,
  LoadEndReason,
  LoadEndpointSummary,
  LoadEndToEndSummary,
  LoadEvent,
  LoadFailureSummary,
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

const SEP = "\u0000";
const ZERO_PCT: Percentiles = { p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };

type Phase = "primary" | "continuation";

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
  // Per in-flight iteration: each step's START phase (recorded at step:start), so a
  // step's step:end + requests aggregate under the phase it started in even after a
  // mid-step boundary flips the live phase. Cleared at iteration:end (bounded).
  private readonly iterStepPhase = new Map<string, Map<string, Phase>>();

  private readonly scenarios = new Map<string, ScenarioAgg>();
  private readonly steps = new Map<string, StepAgg>();
  private readonly endpoints = new Map<string, EndpointAgg>();
  private readonly matrix = new Map<string, MatrixAgg>();
  private readonly recentFailures: LoadFailureSummary[] = [];

  apply(event: LoadEvent): void {
    if (this.firstTs === undefined) this.firstTs = event.ts;
    if (event.ts > this.lastTs) this.lastTs = event.ts;
    if (event.runnerId) this.runnerId = event.runnerId;

    switch (event.type) {
      case "load:start":
        this.config = event.config;
        this.requestedConcurrency = event.config.concurrency;
        break;
      case "load:end":
        this.endReason = event.reason;
        if (event.crash) this.crash = event.crash;
        break;
      case "iteration:start":
        this.iterStarted += 1;
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
        if (event.iterationId) this.iterStepPhase.delete(event.iterationId); // bounded cleanup
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
            atMs: this.firstTs !== undefined ? event.ts - this.firstTs : 0,
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
        break;
      }
      case "request:observed": {
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
      case "producer:primaryCompleted": {
        // The first primaryComplete boundary of an iteration (M5): record the
        // primary-phase duration and mark the iteration as having reached it.
        this.primaryBoundaries += 1;
        this.primaryLatency.record(event.primaryDurationMs);
        if (event.iterationId) this.iterHadPrimary.add(event.iterationId);
        break;
      }
      // assertion:observed / log:sampled / producer:released|releaseRejected /
      // checkpoints are handled by the sink (failure traces) or by later milestones
      // (producer release / backpressure); they don't affect these aggregates.
      default:
        break;
    }
  }

  snapshot(now?: number): LoadProgressSnapshot {
    const at = now ?? this.lastTs;
    const elapsedMs = this.firstTs !== undefined ? Math.max(0, at - this.firstTs) : 0;
    const elapsedSec = elapsedMs / 1000;
    return {
      elapsedMs,
      requestedConcurrency: this.requestedConcurrency,
      primaryInFlight: this.primaryInFlightCount(),
      continuationInFlight: 0,
      blockedOnBacklog: 0,
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

  finalize(): LoadArtifact {
    const startedAtMs = this.firstTs ?? 0;
    const durationMs = Math.max(0, this.lastTs - startedAtMs);
    const elapsedSec = durationMs / 1000;
    const endpoints = this.endpointSummaries(elapsedSec);
    const anyHeuristicEndpoint = endpoints.some((e) => e.routeKeyHeuristic);

    return {
      schemaVersion: "glubean.load.v1",
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
        // A primaryComplete boundary makes this a MEASURED closed run (phase split);
        // producer release ("producer-released") is M6.
        slotModel: this.primaryBoundaries > 0 ? "end-to-end-measured" : "end-to-end",
        requestedConcurrency: this.requestedConcurrency,
        // Same reducer state as snapshot(): an interrupted run (abort/crash with
        // started-but-not-ended iterations) shows its in-flight count, not 0.
        primaryInFlight: this.primaryInFlightCount(),
        continuationInFlight: 0, // producer-release continuation lands in M6
        blockedOnBacklog: 0, // backpressure lands in M6
        feederGuarantee: "single-node",
        sampleGranularity: "event",
        attribution: this.attribution(anyHeuristicEndpoint),
        percentileSource: "glubean-reducer",
        ...(this.crash ? { crash: this.crash } : {}),
      },
      summary: {
        // M4 evaluates thresholds and refines pass; here pass = "didn't crash".
        pass: this.endReason !== "crash" && this.crash === undefined,
        totalIterations: this.iterCompleted,
        successfulIterations: this.iterSucceeded,
        failedIterations: this.iterFailed,
        errorRate: rate(this.iterFailed, this.iterCompleted),
        throughputPerSec: elapsedSec > 0 ? this.iterCompleted / elapsedSec : 0,
        latency: this.iterCompleted > 0 ? this.iterLatency.percentiles() : ZERO_PCT,
        // Phase split (M5): present only once an iteration reached a primaryComplete
        // boundary. The top-level compat fields above stay end-to-end; `primary` /
        // `endToEnd` expose the split (primary = up to the boundary).
        ...(this.primaryBoundaries > 0
          ? { primary: this.primaryPhaseSummary(elapsedSec), endToEnd: this.endToEndPhaseSummary(elapsedSec) }
          : {}),
        thresholds: [],
      },
      scenarios: this.scenarioSummaries(),
      steps: this.stepSummaries(),
      endpoints,
      matrix: this.matrixSummaries(),
      samples: {
        // Failure-trace / slow-transaction sampling is wired with the sink (M3-e/M4).
        maxFailureTraces: 0,
        maxSlowTransactionSummaries: 0,
        failureTraces: [],
        slowTransactions: [],
      },
    };
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

/** Create a fresh streaming load reducer. */
export function createLoadReducer(): LoadReducer {
  return new LoadReducerImpl();
}
