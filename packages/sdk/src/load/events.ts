/**
 * `LoadEvent` — the load runtime's internal fact stream.
 *
 * Deliberately NOT the ordinary `TestEvent` union: a test event is
 * evidence/timeline-shaped (explain why one test failed), while a load event is
 * observation/reduction-shaped (drive bounded real-time aggregation; success
 * paths leave only aggregates, failures leave bounded traces). They may share
 * the envelope / redaction / attribution helpers, but not the union type.
 *
 * The implementation (LoadReducer, sink, orchestrator) lives in @glubean/runner;
 * this is the type contract those modules and external-engine adapters share.
 */
import type { LoadArtifactConfig, LoadCrashSummary, LoadErrorKind } from "./artifact.js";

/** Resolved (ms-normalized) config emitted on `load:start`. */
export type LoadResolvedConfig = LoadArtifactConfig;

/** Common attribution carried by every load event. */
export interface LoadEventEnvelope {
  ts: number;
  seq: number;
  runId: string;
  runnerId: string;
  scenarioId?: string;
  /** Traffic-mix entry id; distinguishes a scenario reused across mix entries. */
  scenarioRefId?: string;
  producerSlotId?: string;
  iterationId?: string;
  stepId?: string;
  /**
   * Whether this event belongs to primary load generation or a continuation
   * side effect. Switched by the runtime at the first `primaryComplete`, not a
   * user tag; `releaseProducerSlot` affects scheduling, not phase.
   */
  phase?: "primary" | "continuation";
}

/** Why a load run ended. */
export type LoadEndReason = "duration" | "iterations" | "abort" | "crash";

/** routeKey provenance for an observed request. */
export type LoadRouteKeySource = "explicit" | "catalog" | "contract-metadata" | "normalized-url";

/**
 * The load runtime fact stream. Success requests/assertions feed the reducer
 * only; failures keep bounded traces. Scheduling semantics live on
 * `producer:released` / `producer:releaseRejected` only.
 */
export type LoadEvent =
  | (LoadEventEnvelope & { type: "load:start"; config: LoadResolvedConfig })
  | (LoadEventEnvelope & { type: "load:end"; reason: LoadEndReason; crash?: LoadCrashSummary })
  | (LoadEventEnvelope & { type: "producerSlot:start"; producerSlotIndex: number })
  | (LoadEventEnvelope & {
      type: "producerSlot:end";
      producerSlotIndex: number;
      primaryIterations: number;
    })
  | (LoadEventEnvelope & {
      type: "iteration:start";
      inputKey?: string;
      feederKeys?: Record<string, string>;
    })
  | (LoadEventEnvelope & {
      type: "iteration:end";
      ok: boolean;
      durationMs: number;
      errorKind?: LoadErrorKind;
    })
  | (LoadEventEnvelope & { type: "step:start"; stepName: string; groupId?: string })
  | (LoadEventEnvelope & {
      type: "step:end";
      stepName: string;
      ok: boolean;
      durationMs: number;
      skipped?: boolean;
      assertionFailures?: number;
      errorKind?: LoadErrorKind;
    })
  | (LoadEventEnvelope & {
      type: "report:checkpoint";
      checkpointId: string;
      data?: Record<string, unknown>;
    })
  | (LoadEventEnvelope & {
      type: "producer:primaryCompleted";
      primaryId: string;
      primaryDurationMs: number;
      releaseRequested: boolean;
    })
  | (LoadEventEnvelope & {
      type: "producer:released";
      releaseId: string;
      primaryDurationMs: number;
      continuationBacklog: number;
      continuationBackpressure?: boolean;
      backpressureMs: number;
    })
  | (LoadEventEnvelope & {
      type: "producer:releaseRejected";
      releaseId: string;
      reason: "continuationBacklogFull" | "duplicateRelease" | "runDeadlineReached";
      waitMs: number;
      continuationBacklog: number;
    })
  | (LoadEventEnvelope & {
      type: "request:observed";
      method: string;
      url: string;
      routeKey: string;
      routeKeySource: LoadRouteKeySource;
      routeKeyHeuristic: boolean;
      status?: number;
      ok: boolean;
      durationMs: number;
      bytesIn?: number;
      bytesOut?: number;
      errorKind?: LoadErrorKind;
    })
  | (LoadEventEnvelope & {
      type: "assertion:observed";
      passed: boolean;
      message?: string;
      actual?: unknown;
      expected?: unknown;
    })
  | (LoadEventEnvelope & {
      type: "log:sampled";
      level: "debug" | "info" | "warn" | "error";
      message: string;
    });

/** Narrow a LoadEvent to a specific `type`. */
export type LoadEventOf<T extends LoadEvent["type"]> = Extract<LoadEvent, { type: T }>;
