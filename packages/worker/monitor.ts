/**
 * Process resource monitoring.
 *
 * Monitors memory usage of child processes and kills them if they exceed limits.
 * Uses /proc filesystem on Linux, ps command on macOS.
 */

import type { Logger } from "./logger.ts";

/**
 * Get memory usage of a process in bytes.
 * Returns null if process doesn't exist or can't be read.
 */
export async function getProcessMemory(pid: number): Promise<number | null> {
  try {
    if (Deno.build.os === "linux") {
      // Linux: read from /proc/<pid>/status
      const status = await Deno.readTextFile(`/proc/${pid}/status`);
      const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
      if (match) {
        return parseInt(match[1]) * 1024; // Convert KB to bytes
      }
    }

    // macOS/Linux fallback: use ps command
    const cmd = new Deno.Command("ps", {
      args: ["-o", "rss=", "-p", String(pid)],
      stdout: "piped",
      stderr: "null",
    });
    const { stdout, success } = await cmd.output();
    if (!success) return null;

    const rss = parseInt(new TextDecoder().decode(stdout).trim());
    if (isNaN(rss)) return null;
    return rss * 1024; // ps returns KB
  } catch {
    return null; // Process may have exited
  }
}

/**
 * Options for process monitor.
 */
export interface ProcessMonitorOptions {
  /** Process ID to monitor. */
  pid: number;
  /** Memory limit in bytes (0 = no limit). */
  memoryLimitBytes: number;
  /** Check interval in milliseconds. */
  checkIntervalMs: number;
  /** Logger for warnings/errors. */
  logger: Logger;
  /** Callback when process is killed due to limit. */
  onKilled?: (reason: "memory") => void;
}

/**
 * Monitor handle for stopping the monitor.
 */
export interface ProcessMonitorHandle {
  /** Stop monitoring. */
  stop(): void;
  /** Abort signal triggered when process is killed. */
  signal: AbortSignal;
}

/**
 * Start monitoring a process for resource limits.
 *
 * @example
 * const monitor = startProcessMonitor({
 *   pid: process.pid,
 *   memoryLimitBytes: 100 * 1024 * 1024, // 100MB
 *   checkIntervalMs: 2000,
 *   logger,
 *   onKilled: (reason) => console.log(`Killed: ${reason}`),
 * });
 *
 * // Later...
 * monitor.stop();
 */
export function startProcessMonitor(
  options: ProcessMonitorOptions,
): ProcessMonitorHandle {
  const { pid, memoryLimitBytes, checkIntervalMs, logger, onKilled } = options;
  const controller = new AbortController();
  let stopped = false;
  let intervalId: number | undefined;

  // Skip monitoring if no limit set
  if (memoryLimitBytes <= 0) {
    return {
      stop: () => {},
      signal: controller.signal,
    };
  }

  const check = async () => {
    if (stopped) return;

    const memory = await getProcessMemory(pid);
    if (memory === null) {
      // Process exited, stop monitoring
      stopped = true;
      if (intervalId !== undefined) clearInterval(intervalId);
      return;
    }

    if (memory > memoryLimitBytes) {
      logger.warn("Process exceeded memory limit, killing", {
        pid,
        memoryBytes: memory,
        limitBytes: memoryLimitBytes,
      });

      // Kill the process
      try {
        Deno.kill(pid, "SIGKILL");
      } catch {
        // Process may have already exited
      }

      stopped = true;
      if (intervalId !== undefined) clearInterval(intervalId);
      controller.abort();
      onKilled?.("memory");
    }
  };

  // Start monitoring
  intervalId = setInterval(check, checkIntervalMs);

  // Do an immediate check
  check().catch(() => {});

  return {
    stop: () => {
      stopped = true;
      if (intervalId !== undefined) clearInterval(intervalId);
    },
    signal: controller.signal,
  };
}

/**
 * Format bytes as human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}
