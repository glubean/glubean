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
  /** Offset from run start, in ms. */
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
  finalize(): LoadArtifact;
}
