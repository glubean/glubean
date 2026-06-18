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
  LoadEvent,
  LoadFailureSummary,
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
        const step = this.getStep(
          event.scenarioId,
          event.scenarioRefId,
          stepId,
          this.phaseOf(event),
          event.stepName,
        );
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
          this.phaseOf(event),
          event.stepName,
        );
        step.stepName = event.stepName; // correct any placeholder set by an earlier request:observed
        step.invocationCount += 1;
        if (event.skipped) step.skippedCount += 1;
        else step.latency.record(event.durationMs);
        if (!event.ok) step.errorCount += 1;
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

        // attribute the request to its step's requestCount (lazily create the
        // step agg: request:observed often arrives before step:end).
        if (event.stepId) {
          const step = this.getStep(
            event.scenarioId,
            event.scenarioRefId,
            event.stepId,
            this.phaseOf(event),
            event.stepId,
          );
          step.requestCount += 1;
        }
        break;
      }
      // assertion:observed / log:sampled / producer:* / checkpoints are handled
      // by the sink (failure traces) or by later milestones (phase split,
      // producer release); they do not affect the M3 closed-model aggregates.
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
      primaryInFlight: Math.max(0, this.iterStarted - this.iterCompleted),
      continuationInFlight: 0,
      blockedOnBacklog: 0,
      primaryStarted: this.iterStarted,
      primaryCompleted: this.iterCompleted,
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
        executionModel: "closed-back-to-back",
        slotModel: "end-to-end",
        requestedConcurrency: this.requestedConcurrency,
        // Same reducer state as snapshot(): an interrupted run (abort/crash with
        // started-but-not-ended iterations) shows its in-flight count, not 0.
        primaryInFlight: Math.max(0, this.iterStarted - this.iterCompleted),
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
        phase,
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
      errorRate: rate(agg.errorCount, agg.invocationCount),
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
    return [...this.matrix.values()].map((m) => {
      const stepName =
        m.stepId !== undefined
          ? this.steps.get(this.stepKey(m.scenarioId, m.scenarioRefId, m.stepId, m.phase ?? "primary"))
              ?.stepName
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
