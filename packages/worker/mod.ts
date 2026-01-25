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
  loadConfig,
  loadConfigFromFile,
  ConfigError,
  ENV_VARS,
  type WorkerConfig,
  type ConfigFile,
} from "./config.ts";

// Logging
export {
  createLogger,
  createNoopLogger,
  type Logger,
  type LogLevel,
} from "./logger.ts";

// Client
export {
  ControlPlaneClient,
  ControlPlaneError,
  type ControlPlaneClientOptions,
} from "./client.ts";

// Worker loop
export {
  startWorkerLoop,
  runWorker,
  type WorkerLoopOptions,
  type RunWorkerOptions,
  type WorkerLifecycleOptions,
  type WorkerMode,
} from "./loop.ts";

// Executor
export { executeBundle, type ExecutorResult, type OnEvent } from "./executor.ts";

// Process monitoring
export {
  getProcessMemory,
  startProcessMonitor,
  formatBytes,
  type ProcessMonitorOptions,
  type ProcessMonitorHandle,
} from "./monitor.ts";

// Types
export type {
  Id,
  IsoDateTime,
  RunStatus,
  FailureClass,
  ArtifactType,
  ArtifactPointer,
  RunEvent,
  RunSummary,
  RuntimeContext,
  TaskLease,
  ClaimTaskRequest,
  ClaimTaskResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  GetRuntimeContextRequest,
  GetRuntimeContextResponse,
  SubmitEventsRequest,
  CompleteTaskRequest,
  FailTaskRequest,
} from "./types.ts";
