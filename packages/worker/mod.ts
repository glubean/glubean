/**
 * @module @glubean/worker
 *
 * Self-hosted Glubean worker for test execution.
 *
 * This module provides the core worker functionality that can be:
 * - Run as a CLI tool via `cli.ts`
 * - Embedded in custom applications
 * - Used by Glubean Cloud infrastructure
 *
 * @example Run as CLI
 * ```bash
 * deno run -A jsr:@glubean/worker/cli --config ./worker.json
 * ```
 *
 * @example Embed in application
 * ```ts
 * import { startWorkerLoop, loadConfig, createLogger, ControlPlaneClient } from "@glubean/worker";
 *
 * const config = loadConfig();
 * const logger = createLogger(config);
 * const client = new ControlPlaneClient({
 *   baseUrl: config.controlPlaneUrl,
 *   workerToken: config.workerToken,
 *   timeoutMs: config.controlPlaneTimeoutMs,
 *   maxRetries: config.controlPlaneMaxRetries,
 * });
 *
 * const shutdown = await startWorkerLoop({ config, client, logger });
 *
 * Deno.addSignalListener("SIGTERM", shutdown);
 * ```
 */

// Configuration
export {
  ConfigError,
  type ConfigFile,
  ENV_VARS,
  loadConfig,
  loadConfigFromFile,
  type NetworkPolicyMode,
  type WorkerConfig,
  type WorkerNetworkPolicy,
} from "./config.ts";

// Logging
export { createLogger, createNoopLogger, type Logger, type LogLevel } from "./logger.ts";

// Client
export { ControlPlaneClient, type ControlPlaneClientOptions, ControlPlaneError } from "./client.ts";

// Worker loop
export {
  runWorker,
  type RunWorkerOptions,
  startWorkerLoop,
  type WorkerLifecycleOptions,
  type WorkerLoopOptions,
  type WorkerMode,
} from "./loop.ts";

// Executor
export { executeBundle, type ExecutorResult, type OnEvent } from "./executor.ts";

// Process monitoring
export {
  formatBytes,
  getProcessMemory,
  type ProcessMonitorHandle,
  type ProcessMonitorOptions,
  startProcessMonitor,
} from "./monitor.ts";

// Types
export type {
  ArtifactPointer,
  ArtifactType,
  ClaimTaskRequest,
  ClaimTaskResponse,
  CompleteTaskRequest,
  FailTaskRequest,
  FailureClass,
  GetRuntimeContextRequest,
  GetRuntimeContextResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  Id,
  IsoDateTime,
  RunEvent,
  RunStatus,
  RunSummary,
  RuntimeContext,
  SubmitEventsRequest,
  TaskLease,
} from "./types.ts";
