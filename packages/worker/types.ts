/**
 * Glubean Worker Types
 *
 * Cross-boundary contracts for ControlPlane <-> Worker communication.
 * These types represent the stable payloads exchanged between systems.
 */

/** Common identifier type. */
export type Id = string;

/** ISO timestamp string. */
export type IsoDateTime = string;

/** Status for runs/tasks. */
export type RunStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "cancelled"
  | "exhausted"; // Max retries exceeded, permanently failed

/**
 * Failure classification for retry behavior.
 * These are reported by the Worker when it can still communicate.
 *
 * - timeout: Test execution exceeded time limit
 * - crash: Unexpected process crash (OOM, segfault, etc.)
 * - user_error: User code threw an error (assertions, exceptions)
 * - infra_error: Infrastructure issue (network, storage, etc.)
 *
 * Note: "lease_timeout" is NOT a FailureClass - it's detected by the Server
 * when the Worker fails to heartbeat (may be crash, network partition, or hang).
 */
export type FailureClass = "timeout" | "crash" | "user_error" | "infra_error";

/**
 * Artifact types in the system.
 */
export type ArtifactType =
  | "bundle"
  | "trace"
  | "log"
  | "report"
  | "screenshot"
  | "video"
  | "coverage"
  | "other";

/**
 * A pointer to a stored blob (artifact, bundle, etc.).
 * Uses short-lived signed URLs for portability.
 */
export interface ArtifactPointer {
  type: ArtifactType;
  url: string;
  contentType?: string;
  sizeBytes?: number;
  checksum?: string;
  expiresAt?: IsoDateTime;
}

/**
 * Append-only event emitted during execution.
 *
 * Event types:
 * - log: User log message
 * - assert: Assertion result (pass/fail)
 * - trace: API trace (request/response)
 * - result: Test result
 * - system: System event (lease_expired, etc.) - emitted by ControlPlane
 */
export interface RunEvent {
  runId: Id;
  taskId: Id;
  seq: number;
  ts: IsoDateTime;
  type:
    | "log"
    | "assert"
    | "trace"
    | "metric"
    | "summary"
    | "result"
    | "system"
    | "step_start"
    | "step_end";
  redacted?: boolean;
  payload: unknown;
}

/**
 * System event payloads emitted by ControlPlane (not Worker).
 * These events are generated when the server detects issues.
 */
export type SystemEventPayload =
  | {
    /** Lease timeout - worker failed to heartbeat within expected time. */
    event: "lease_timeout";
    /** Last known worker ID that held the lease. */
    workerId?: Id;
    /** The expired lease ID. */
    leaseId: Id;
    /** When the lease expired. */
    expiredAt: IsoDateTime;
    /** Which attempt this was. */
    attempt: number;
    /** Whether this will trigger a retry (attempt < maxAttempts). */
    willRetry: boolean;
  }
  | {
    /** Task exhausted all retry attempts. */
    event: "task_exhausted";
    reason: "max_retries_exceeded" | "non_retryable_error";
    totalAttempts: number;
    /** History of failure reasons across all attempts. */
    failureHistory: Array<{
      attempt: number;
      failureClass: FailureClass | "lease_timeout";
      message?: string;
    }>;
  }
  | {
    /** Task was cancelled before completion. */
    event: "task_cancelled";
    reason: "user_cancelled" | "run_cancelled" | "project_deleted";
    cancelledBy?: Id;
  };

/** Final summary for a run or task. */
export interface RunSummary {
  runId: Id;
  taskId?: Id;
  status: RunStatus;
  startedAt?: IsoDateTime;
  completedAt?: IsoDateTime;
  durationMs?: number;
  counts?: Record<string, number>;
  artifacts?: ArtifactPointer[];
}

/**
 * Runtime context required to execute a task.
 */
export interface RuntimeContext {
  taskId: Id;
  runId: Id;
  projectId: Id;
  bundle: {
    bundleId: Id;
    download: ArtifactPointer;
  };
  selection?: {
    tags?: string[];
    ids?: string[];
    /**
     * How to match tags:
     * - "any" (default): test matches if it has ANY of the specified tags (OR)
     * - "all": test matches only if it has ALL of the specified tags (AND)
     */
    tagMode?: "any" | "all";
  };
  vars?: Record<string, string>;
  /**
   * Plaintext secrets for cloud-managed workers only.
   * Private/self-hosted runners MUST NOT receive secrets over the network.
   */
  secrets?: Record<string, string>;
  /**
   * Path to secrets file on the worker's local filesystem.
   * Secrets are NEVER transmitted over the network - workers load them locally.
   *
   * Priority order for loading:
   * 1. This secretsPath value (if specified)
   * 2. GLUBEAN_SECRETS_PATH environment variable
   * 3. .env.secrets in bundle directory
   * 4. Worker's defaultSecretsPath config
   * 5. Empty (no secrets loaded)
   */
  secretsPath?: string;
  limits?: {
    timeoutMs?: number;
    memoryMb?: number;
    requestedConcurrency?: number;
    maxConcurrency?: number;
  };
}

/**
 * Task lease from the queue.
 */
export interface TaskLease {
  taskId: Id;
  /**
   * Unique identifier for this lease/execution attempt.
   * Generated fresh on each claim. Used for idempotency:
   * - Server rejects complete/fail if leaseId doesn't match current lease
   * - Prevents stale workers from corrupting task state after lease expires
   */
  leaseId: Id;
  /** Secret token to authorize lease operations. */
  leaseToken: string;
  /** When this lease expires if not renewed via heartbeat. */
  leaseExpiresAt: IsoDateTime;
  /**
   * Execution attempt number (1 = first attempt).
   * Increments each time the task is re-claimed after failure/timeout.
   */
  attempt: number;
  /**
   * Maximum allowed attempts before task is marked as "exhausted".
   * Configured at Job or Project level, with system default (typically 3).
   * When attempt >= maxAttempts and task fails, Server marks it as "exhausted"
   * and stops returning it in claim responses.
   */
  maxAttempts: number;
}

// ============================================================================
// HTTP DTOs for ControlPlane <-> Worker communication
// ============================================================================

/** Request to claim a task from the queue. */
export interface ClaimTaskRequest {
  workerId: Id;
  tags?: string[];
  longPollMs?: number;
}

/** Response from claim endpoint. */
export interface ClaimTaskResponse {
  task: TaskLease | null;
}

/**
 * System resource information reported by the worker.
 *
 * Sent alongside heartbeats so the control plane can display worker
 * health metrics (CPU, memory, uptime) in the dashboard.
 *
 * @example
 * const info = collectSystemInfo();
 * // { cpuLoadAvg: [1.2, 0.8, 0.6], memoryTotalBytes: 17179869184, ... }
 */
export interface SystemInfo {
  /** OS load averages [1min, 5min, 15min]. */
  cpuLoadAvg: [number, number, number];
  /** Total system memory in bytes. */
  memoryTotalBytes: number;
  /** Used memory in bytes (total − available). */
  memoryUsedBytes: number;
  /** Available memory in bytes. */
  memoryAvailableBytes: number;
  /** System uptime in seconds. */
  uptimeSeconds: number;
}

/** Request to extend a task lease. */
export interface HeartbeatRequest {
  taskId: Id;
  leaseToken: string;
  /** Optional system resource snapshot. Included every Nth heartbeat. */
  systemInfo?: SystemInfo;
}

/** Response from heartbeat endpoint. */
export interface HeartbeatResponse {
  leaseExpiresAt: IsoDateTime;
  shouldCancel?: boolean;
}

/** Request to fetch runtime context. */
export interface GetRuntimeContextRequest {
  taskId: Id;
  leaseToken: string;
}

/** Response containing runtime context. */
export interface GetRuntimeContextResponse {
  context: RuntimeContext;
}

/** Request to submit run events. */
export interface SubmitEventsRequest {
  taskId: Id;
  leaseToken: string;
  events: RunEvent[];
}

/** Request to mark task as completed. */
export interface CompleteTaskRequest {
  taskId: Id;
  leaseToken: string;
  summary: RunSummary;
  idempotencyKey?: string;
}

/** Request to mark task as failed. */
export interface FailTaskRequest {
  taskId: Id;
  leaseToken: string;
  failureClass: FailureClass;
  message?: string;
  /** Optional idempotency key for safe retries. */
  idempotencyKey?: string;
}
