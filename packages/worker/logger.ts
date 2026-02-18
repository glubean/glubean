/**
 * Structured logging for Glubean Worker.
 *
 * Uses JSON-formatted logs suitable for cloud environments.
 * Never logs secrets - caller must ensure sensitive data is excluded.
 */

import type { WorkerConfig } from "./config.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Logger interface for worker components.
 */
export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Redact sensitive fields from log data.
 */
const REDACT_FIELDS = new Set([
  "secrets",
  "password",
  "token",
  "leaseToken",
  "workerToken",
  "authorization",
  "apiKey",
  "secret",
]);

function redact(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    if (
      REDACT_FIELDS.has(lowerKey) ||
      lowerKey.includes("secret") ||
      lowerKey.includes("token") ||
      lowerKey.includes("apikey") ||
      lowerKey.includes("password")
    ) {
      result[key] = "[REDACTED]";
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redact(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Create a logger instance with JSON output.
 */
class JsonLogger implements Logger {
  private readonly minLevel: number;
  private readonly bindings: Record<string, unknown>;

  constructor(level: LogLevel, bindings: Record<string, unknown> = {}) {
    this.minLevel = LOG_LEVELS[level];
    this.bindings = bindings;
  }

  private log(
    level: LogLevel,
    msg: string,
    data?: Record<string, unknown>,
  ): void {
    if (LOG_LEVELS[level] < this.minLevel) return;

    const entry = {
      level,
      time: new Date().toISOString(),
      msg,
      ...this.bindings,
      ...(data ? redact(data) : {}),
    };

    const output = JSON.stringify(entry);

    if (level === "error") {
      console.error(output);
    } else if (level === "warn") {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log("debug", msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.log("info", msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.log("warn", msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.log("error", msg, data);
  }

  child(bindings: Record<string, unknown>): Logger {
    return new JsonLogger(
      Object.keys(LOG_LEVELS).find(
        (k) => LOG_LEVELS[k as LogLevel] === this.minLevel,
      ) as LogLevel,
      { ...this.bindings, ...bindings },
    );
  }
}

/**
 * Create a logger instance for a worker.
 *
 * @example
 * const logger = createLogger(config);
 * logger.info("Worker started", { workerId: config.workerId });
 *
 * const taskLogger = logger.child({ taskId: "task-123" });
 * taskLogger.info("Processing task");
 */
export function createLogger(config: WorkerConfig): Logger {
  return new JsonLogger(config.logLevel, {
    workerId: config.workerId,
    service: "glubean-worker",
  });
}

/**
 * Create a no-op logger for testing.
 */
export function createNoopLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => createNoopLogger(),
  };
}
