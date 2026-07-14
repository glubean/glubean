/**
 * Live progress + reducer contract for the load runtime.
 *
 * Progress is NOT a second raw event stream: CLI / Cloud read `reducer.snapshot()`
 * on a fixed interval, and the final `LoadArtifact` comes from the same reducer
 * state — so live progress and the report never diverge.
 */
import type { LoadArtifact, LoadEndpointSummary, LoadErrorKind, Percentiles } from "./artifact.js";
import type { LoadEvent } from "./events.js";

/** A brief failure summary surfaced in live progress (not the full trace sample). */
export interface LoadFailureSummary {
  scenarioId?: string;
  scenarioRefId?: string;
  iterationId: string;
  errorKind?: LoadErrorKind;
  failedStepName?: string;
  message?: string;
  /** Offset from the run's time origin, in ms (single-process: run start; distributed: the
   *  coordinator-issued shared `timelineOrigin`, comparable across workers). */
  atMs: number;
}

/** A point-in-time progress snapshot, derived from reducer state. */
export interface LoadProgressSnapshot {
  elapsedMs: number;
  requestedConcurrency: number;
  primaryInFlight: number;
  continuationInFlight: number;
  blockedOnBacklog: number;
  primaryStarted: number;
  primaryCompleted: number;
  endToEndCompleted: number;
  inFlightAtEnd?: number;
  failedIterations: number;
  /** End-to-end compatibility view (ambiguous once producer release is on). */
  throughputPerSec: number;
  /** End-to-end compatibility view. */
  transactionLatency: Percentiles;
  primaryThroughputPerSec?: number;
  endToEndThroughputPerSec?: number;
  continuationBacklog?: number;
  oldestContinuationAgeMs?: number;
  slotOccupancyByPhase?: Record<"primary" | "continuation" | "blockedOnBacklog", number>;
  topSlowEndpoints: LoadEndpointSummary[];
  recentFailures: LoadFailureSummary[];
}

/**
 * Streaming reducer: fold the `LoadEvent` fact stream into bounded counters /
 * histograms / reservoirs, expose live `snapshot()`, and `finalize()` to the
 * versioned `LoadArtifact`. The implementation (bounded, no full-sample arrays)
 * lives in @glubean/runner.
 */
export interface LoadReducer {
  apply(event: LoadEvent): void;
  snapshot(now?: number): LoadProgressSnapshot;
  /** Finalize to the versioned artifact. `runEndMs` — optional AUTHORITATIVE run-end
   *  instant (epoch ms, SAME clock domain as `LoadEvent.ts` / the reducer's injected
   *  `timelineOrigin`): in a distributed run, the coordinator's `globalEndAt` (dispatch
   *  deadline + drain completion, quota completion, or the abort instant). Supplied, it
   *  becomes `durationMs` and every throughput denominator — a worker's own event extremes
   *  close the window early when a lost worker / early quota finish stops emitting, which
   *  inflates throughput. Absent, the end falls back to the last observed event's ts
   *  (single-process semantics, unchanged). A value earlier than the last event is taken
   *  at value — the coordinator is authoritative, no clamp. See the runner's
   *  `LoadReducerImpl.finalize` jsdoc for the full contract. */
  finalize(runEndMs?: number): LoadArtifact;
}
