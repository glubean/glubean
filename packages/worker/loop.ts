/**
 * Main worker loop.
 *
 * Continuously claims tasks, executes them, and reports results.
 * Supports concurrent task execution with configurable limits.
 * Handles graceful shutdown on abort signal.
 */

import type { FailureClass, RunEvent, RunStatus, RunSummary, SystemInfo, TaskLease } from "./types.ts";
import { type ControlPlaneClient, ControlPlaneError } from "./client.ts";
import type { WorkerConfig } from "./config.ts";
import type { Logger } from "./logger.ts";
import { executeBundle } from "./executor.ts";

export interface WorkerLoopOptions {
  config: WorkerConfig;
  client: ControlPlaneClient;
  logger: Logger;
}

/**
 * Execution mode for the worker process.
 *
 * - `daemon`: run indefinitely until externally stopped (default CLI behavior)
 * - `job`: run until idle/max lifetime/max tasks, then exit cleanly (Cloud Run Jobs, batch)
 */
export type WorkerMode = "daemon" | "job";

/**
 * Provider-agnostic lifecycle controls.
 * Wrappers (Cloud Run Jobs / Cloud Run Service / etc) can map their platform signals
 * into these options without changing core worker logic.
 */
export interface WorkerLifecycleOptions {
  /**
   * Worker process mode.
   * Default: `daemon`.
   */
  mode?: WorkerMode;

  /**
   * In `job` mode, exit after the worker has been idle for this duration AND
   * there are no active tasks in flight.
   *
   * Default: 30s.
   */
  idleGraceMs?: number;

  /**
   * In `job` mode, stop claiming new tasks after this duration.
   * The worker will still wait for in-flight tasks to finish.
   *
   * Default: 20 minutes.
   */
  maxLifetimeMs?: number;

  /**
   * In `job` mode, stop claiming new tasks after processing this many tasks.
   * (Tasks are counted when they reach a terminal state: complete/fail.)
   *
   * Default: unlimited.
   */
  maxTasksPerWorker?: number;
}

/**
 * Options for running the worker as an awaitable process.
 *
 * @example
 * ```ts
 * const shutdown = new AbortController();
 * await runWorker({
 *   config,
 *   client,
 *   logger,
 *   lifecycle: { mode: "job", idleGraceMs: 30_000 },
 *   signal: shutdown.signal,
 * });
 * ```
 */
export interface RunWorkerOptions extends WorkerLoopOptions {
  lifecycle?: WorkerLifecycleOptions;
  signal?: AbortSignal;
}

/**
 * Heartbeat handle for managing lease renewal.
 */
interface HeartbeatHandle {
  stop(): void;
  signal: AbortSignal;
}

/**
 * Maximum consecutive heartbeat failures before aborting task.
 */
const MAX_HEARTBEAT_FAILURES = 3;

/**
 * How often to include system resource info in heartbeats.
 * E.g., 5 means every 5th heartbeat (with default 10s interval → every ~50s).
 */
const SYSTEM_INFO_EVERY_N_HEARTBEATS = 5;

/**
 * Collect current system resource information.
 * Returns null if the runtime doesn't support the required APIs.
 */
function collectSystemInfo(): SystemInfo | null {
  try {
    const loadAvg = Deno.loadavg();
    const memInfo = Deno.systemMemoryInfo();
    const uptime = Deno.osUptime();
    return {
      cpuLoadAvg: loadAvg as [number, number, number],
      memoryTotalBytes: memInfo.total,
      memoryUsedBytes: memInfo.total - memInfo.available,
      memoryAvailableBytes: memInfo.available,
      uptimeSeconds: uptime,
    };
  } catch {
    // Runtime doesn't support these APIs or permissions not granted
    return null;
  }
}

/**
 * Start a heartbeat loop to keep the lease alive.
 */
function startHeartbeat(
  task: TaskLease,
  client: ControlPlaneClient,
  intervalMs: number,
  logger: Logger,
): HeartbeatHandle {
  const controller = new AbortController();
  let stopped = false;
  let consecutiveFailures = 0;
  let heartbeatCount = 0;

  const loop = async () => {
    while (!stopped) {
      await sleep(intervalMs);
      if (stopped) break;

      try {
        heartbeatCount++;
        // Include system info every Nth heartbeat
        const systemInfo = heartbeatCount % SYSTEM_INFO_EVERY_N_HEARTBEATS === 0
          ? collectSystemInfo() ?? undefined
          : undefined;

        const response = await client.heartbeat({
          taskId: task.taskId,
          leaseToken: task.leaseToken,
          systemInfo,
        });

        // Reset failure counter on success
        consecutiveFailures = 0;

        if (response.shouldCancel) {
          logger.info("Heartbeat indicated cancellation");
          controller.abort();
          break;
        }
      } catch (err) {
        consecutiveFailures++;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("Heartbeat failed", {
          error: message,
          consecutiveFailures,
          maxFailures: MAX_HEARTBEAT_FAILURES,
        });

        // Abort on lease expiry
        if (err instanceof ControlPlaneError && err.code === "LEASE_EXPIRED") {
          logger.error("Lease expired, aborting task");
          controller.abort();
          break;
        }

        // Abort after too many consecutive failures
        if (consecutiveFailures >= MAX_HEARTBEAT_FAILURES) {
          logger.error(
            `Heartbeat failed ${consecutiveFailures} times consecutively, aborting task to prevent wasted resources`,
          );
          controller.abort();
          break;
        }
      }
    }
  };

  // Start heartbeat loop (don't await)
  loop().catch(() => {});

  return {
    stop: () => {
      stopped = true;
    },
    signal: controller.signal,
  };
}

/**
 * Simple semaphore for limiting concurrent tasks.
 */
class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter();
    } else {
      this.permits++;
    }
  }

  get available(): number {
    return this.permits;
  }
}

/**
 * Start the main worker loop.
 * Returns a shutdown function that can be called to stop the loop gracefully.
 *
 * @example
 * const shutdown = await startWorkerLoop({ config, client, logger });
 * Deno.addSignalListener("SIGTERM", shutdown);
 */
export function startWorkerLoop(
  options: WorkerLoopOptions,
): Promise<() => void> {
  const runtime = createWorkerRuntime({
    ...options,
    lifecycle: { mode: "daemon" },
  });
  runtime.finished.catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    options.logger.error("Worker loop crashed", { error: message });
  });
  return Promise.resolve(runtime.shutdown);
}

/**
 * Run the worker loop and resolve when it has stopped.
 * This is the recommended entrypoint for platform wrappers (Cloud Run Jobs, etc).
 */
export async function runWorker(options: RunWorkerOptions): Promise<void> {
  const runtime = createWorkerRuntime(options);
  if (options.signal) {
    // Stop loop and heartbeats when the wrapper requests shutdown.
    options.signal.addEventListener("abort", runtime.shutdown, { once: true });
  }
  await runtime.finished;
}

function createWorkerRuntime(options: RunWorkerOptions): {
  shutdown: () => void;
  finished: Promise<void>;
} {
  const { config, client, logger } = options;
  const lifecycle: Required<WorkerLifecycleOptions> = {
    mode: options.lifecycle?.mode ?? "daemon",
    idleGraceMs: options.lifecycle?.idleGraceMs ?? 30_000,
    maxLifetimeMs: options.lifecycle?.maxLifetimeMs ?? 20 * 60_000,
    maxTasksPerWorker: options.lifecycle?.maxTasksPerWorker ??
      Number.POSITIVE_INFINITY,
  };

  let running = true;
  const startedAtMs = Date.now();
  let lastTaskSeenAtMs = startedAtMs;
  let tasksFinished = 0;

  const activeTasks = new Set<Promise<void>>();
  const activeHeartbeats = new Map<string, HeartbeatHandle>();
  const semaphore = new Semaphore(config.maxConcurrentTasks);

  const shutdown = () => {
    logger.info("Shutdown requested", { activeTasks: activeTasks.size });
    running = false;
    // Stop all heartbeats
    for (const hb of activeHeartbeats.values()) {
      hb.stop();
    }
  };

  // Main loop
  const finished = (async () => {
    logger.info("Worker loop started", {
      controlPlaneUrl: config.controlPlaneUrl,
      longPollMs: config.longPollMs,
      tags: config.tags.length > 0 ? config.tags : undefined,
      maxConcurrentTasks: config.maxConcurrentTasks,
      taskMemoryLimitMb: config.taskMemoryLimitBytes > 0 ? config.taskMemoryLimitBytes / 1024 / 1024 : "unlimited",
    });

    while (running) {
      try {
        // In job mode, stop claiming new tasks after max lifetime.
        if (
          lifecycle.mode === "job" &&
          Date.now() - startedAtMs >= lifecycle.maxLifetimeMs
        ) {
          logger.info("Max lifetime reached; stopping worker", {
            maxLifetimeMs: lifecycle.maxLifetimeMs,
            tasksFinished,
            activeTasks: activeTasks.size,
          });
          running = false;
          break;
        }

        // In job mode, stop claiming new tasks after max task count.
        if (
          lifecycle.mode === "job" &&
          tasksFinished >= lifecycle.maxTasksPerWorker
        ) {
          logger.info("Max tasks reached; stopping worker", {
            maxTasksPerWorker: lifecycle.maxTasksPerWorker,
            tasksFinished,
            activeTasks: activeTasks.size,
          });
          running = false;
          break;
        }

        // Wait for a slot to be available
        await semaphore.acquire();

        if (!running) {
          semaphore.release();
          break;
        }

        // Try to claim a task
        const { task } = await client.claim({
          workerId: config.workerId,
          tags: config.tags.length > 0 ? config.tags : undefined,
          longPollMs: config.longPollMs,
        });

        if (!task) {
          // No task available, release slot and wait
          semaphore.release();
          logger.debug("No task available", {
            activeSlots: config.maxConcurrentTasks - semaphore.available,
          });

          // In job mode, exit once we have been idle long enough and no tasks are in flight.
          if (lifecycle.mode === "job" && activeTasks.size === 0) {
            const idleMs = Date.now() - lastTaskSeenAtMs;
            if (idleMs >= lifecycle.idleGraceMs) {
              logger.info("Idle grace reached; stopping worker", {
                idleGraceMs: lifecycle.idleGraceMs,
                idleMs,
              });
              running = false;
              break;
            }
          }

          if (!config.longPollMs) {
            await sleep(config.claimIntervalMs);
          }
          continue;
        }

        lastTaskSeenAtMs = Date.now();

        const taskLogger = logger.child({
          taskId: task.taskId,
          leaseId: task.leaseId,
          attempt: task.attempt,
        });

        taskLogger.info("Task claimed", {
          activeSlots: config.maxConcurrentTasks - semaphore.available,
        });

        // Start heartbeat
        const heartbeat = startHeartbeat(
          task,
          client,
          config.heartbeatIntervalMs,
          taskLogger,
        );
        activeHeartbeats.set(task.taskId, heartbeat);

        // Execute task asynchronously (don't await)
        const taskPromise = executeTask(
          task,
          taskLogger,
          heartbeat.signal,
        ).finally(() => {
          // Cleanup
          heartbeat.stop();
          activeHeartbeats.delete(task.taskId);
          activeTasks.delete(taskPromise);
          semaphore.release();
          tasksFinished += 1;
        });

        activeTasks.add(taskPromise);
      } catch (err) {
        semaphore.release();
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error("Unexpected error in worker loop", {
          error: errorMessage,
        });

        // Back off before retrying
        if (running) {
          await sleep(config.claimIntervalMs);
        }
      }
    }

    // Wait for all active tasks to complete (graceful shutdown)
    if (activeTasks.size > 0) {
      logger.info("Waiting for active tasks to complete", {
        count: activeTasks.size,
      });
      await Promise.all(activeTasks);
    }

    logger.info("Worker loop stopped");
  })();

  async function executeTask(
    task: TaskLease,
    taskLogger: Logger,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const localAbort = new AbortController();
    const onExternalAbort = () => localAbort.abort();
    abortSignal.addEventListener("abort", onExternalAbort);

    try {
      // Log attempt info
      taskLogger.info("Starting task execution", {
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
        isRetry: task.attempt > 1,
      });

      // Get runtime context
      taskLogger.debug("Fetching runtime context");
      const { context } = await client.getContext({
        taskId: task.taskId,
        leaseToken: task.leaseToken,
      });

      // Set up event buffering and streaming
      const bufferedEvents: RunEvent[] = [];
      let streamedEventCount = 0;
      let flushing = false;
      let consecutiveFlushFailures = 0;

      const FLUSH_EVERY_MS = config.eventFlushIntervalMs;
      const FLUSH_MAX_BUFFER = config.eventFlushMaxBuffer;
      const MAX_BUFFER = config.eventMaxBuffer;
      const MAX_CONSEC_FAIL = config.eventFlushMaxConsecutiveFailures;

      class EventFlushError extends Error {
        override name = "EventFlushError";
      }

      const flush = async () => {
        if (flushing) return;
        if (bufferedEvents.length === 0) return;
        flushing = true;
        const batch = bufferedEvents.splice(0, bufferedEvents.length);
        try {
          // Retry flush with bounded backoff
          let attempt = 0;
          while (true) {
            try {
              await client.submitEvents({
                taskId: task.taskId,
                leaseToken: task.leaseToken,
                events: batch,
              });
              consecutiveFlushFailures = 0;
              break;
            } catch (err) {
              attempt++;
              consecutiveFlushFailures++;
              const errorMessage = err instanceof Error ? err.message : String(err);
              taskLogger.warn("Failed to submit event batch", {
                error: errorMessage,
                count: batch.length,
                consecutiveFlushFailures,
              });

              if (consecutiveFlushFailures >= MAX_CONSEC_FAIL) {
                localAbort.abort();
                throw new EventFlushError(
                  `Failed to submit events after ${consecutiveFlushFailures} attempts`,
                );
              }

              // Exponential backoff
              const backoffMs = Math.min(
                1000 * Math.pow(2, attempt - 1),
                10000,
              );
              await sleep(backoffMs);
              if (localAbort.signal.aborted) {
                throw new EventFlushError(
                  "Execution aborted while retrying event flush",
                );
              }
            }
          }
          streamedEventCount += batch.length;
        } catch (err) {
          // Put back the batch
          bufferedEvents.unshift(...batch);
          throw err;
        } finally {
          flushing = false;
        }
      };

      // Start periodic flush
      const flushTimer = setInterval(() => {
        void flush();
      }, FLUSH_EVERY_MS);

      // Execute tests
      taskLogger.info("Starting execution");
      const result = await executeBundle(
        context,
        config,
        taskLogger,
        async (event) => {
          // Implement backpressure: wait if buffer is too full
          while (
            bufferedEvents.length >= MAX_BUFFER &&
            !localAbort.signal.aborted
          ) {
            taskLogger.warn("Event buffer full, applying backpressure", {
              bufferSize: bufferedEvents.length,
              maxBuffer: MAX_BUFFER,
            });

            // Trigger immediate flush
            await flush().catch((err) => {
              taskLogger.error("Flush failed during backpressure", {
                error: err instanceof Error ? err.message : String(err),
              });
            });

            // If buffer still full after flush, wait a bit
            if (bufferedEvents.length >= MAX_BUFFER * 0.9) {
              await sleep(100);
            } else {
              break;
            }

            // Give up after 10 attempts (10 seconds total)
            if (bufferedEvents.length >= MAX_BUFFER) {
              taskLogger.error("Event buffer overflow despite backpressure", {
                bufferSize: bufferedEvents.length,
                maxBuffer: MAX_BUFFER,
              });
              localAbort.abort();
              throw new EventFlushError(
                `Event buffer overflow: ${bufferedEvents.length} events, max ${MAX_BUFFER}`,
              );
            }
          }

          bufferedEvents.push(event);

          // Trigger flush when buffer reaches threshold
          if (bufferedEvents.length >= FLUSH_MAX_BUFFER) {
            void flush();
          }
        },
        localAbort.signal,
      );

      clearInterval(flushTimer);

      // Flush remaining events
      await flush();

      // Abort or timeout: treat as infra failure
      if (result.aborted || result.timedOut) {
        const failureClass: FailureClass = result.timedOut ? "timeout" : "infra_error";
        const message = result.error ??
          (result.timedOut ? "Execution timed out" : "Execution aborted");

        taskLogger.error("Task execution aborted", { failureClass, message });

        try {
          await client.fail({
            taskId: task.taskId,
            leaseToken: task.leaseToken,
            failureClass,
            message,
          });
        } catch (failErr) {
          taskLogger.warn("Failed to report task failure", {
            error: failErr instanceof Error ? failErr.message : String(failErr),
          });
        }
        return;
      }

      // Build and submit summary
      const durationMs = Date.now() - startTime;
      const status: RunStatus = result.success ? "passed" : "failed";

      const summary: RunSummary = {
        runId: context.runId,
        taskId: task.taskId,
        status,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs,
        counts: {
          events: streamedEventCount,
        },
      };

      taskLogger.info("Task completed", { status, durationMs });
      await client.complete({
        taskId: task.taskId,
        leaseToken: task.leaseToken,
        summary,
        idempotencyKey: `${task.taskId}-${task.attempt}`,
      });
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      taskLogger.error("Task failed", { error: errorMessage, durationMs });

      // Determine failure class
      const failureClass = classifyError(err);

      // Log if this might exhaust retries
      if (task.attempt >= task.maxAttempts) {
        taskLogger.warn(
          "Task will be marked as exhausted (max retries reached)",
          {
            attempt: task.attempt,
            maxAttempts: task.maxAttempts,
          },
        );
      } else {
        taskLogger.info("Task may be retried", {
          attempt: task.attempt,
          maxAttempts: task.maxAttempts,
          remainingAttempts: task.maxAttempts - task.attempt,
        });
      }

      try {
        await client.fail({
          taskId: task.taskId,
          leaseToken: task.leaseToken,
          failureClass,
          message: errorMessage,
          idempotencyKey: `${task.taskId}-${task.attempt}-fail`,
        });
      } catch (failErr) {
        taskLogger.warn("Failed to report task failure", {
          error: failErr instanceof Error ? failErr.message : String(failErr),
        });
      }
    } finally {
      abortSignal.removeEventListener("abort", onExternalAbort);
    }
  }

  return { shutdown, finished };
}

/**
 * Classify an error to determine retry behavior.
 */
function classifyError(err: unknown): FailureClass {
  if (err instanceof Error && err.name === "EventFlushError") {
    return "infra_error";
  }
  if (err instanceof ControlPlaneError) {
    if (err.code === "TIMEOUT") return "timeout";
    if (err.code === "LEASE_EXPIRED") return "infra_error";
    if (err.statusCode && err.statusCode >= 500) return "infra_error";
    return "user_error";
  }

  // Network errors are infra
  if (err instanceof Error && err.message.includes("ECONNREFUSED")) {
    return "infra_error";
  }

  // Default to crash for unknown errors
  return "crash";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
