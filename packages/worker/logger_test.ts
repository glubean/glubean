import { assertEquals, assertStringIncludes } from "@std/assert";
import { createLogger, createNoopLogger } from "./logger.ts";
import type { WorkerConfig } from "./config.ts";
import { WORKER_RUN_DEFAULTS } from "@glubean/runner";

function createTestConfig(
  logLevel: "debug" | "info" | "warn" | "error",
): WorkerConfig {
  return {
    controlPlaneUrl: "https://api.glubean.com",
    workerToken: "gwt_test",
    workerId: "test-worker",
    controlPlaneTimeoutMs: 30000,
    controlPlaneMaxRetries: 3,
    claimIntervalMs: 5000,
    heartbeatIntervalMs: 10000,
    longPollMs: 30000,
    logLevel,
    workDir: "/tmp/test",
    downloadTimeoutMs: 60000,
    run: {
      ...WORKER_RUN_DEFAULTS,
      allowNet: "*",
    },
    taskTimeoutMs: 300000,
    eventFlushIntervalMs: 1000,
    eventFlushMaxBuffer: 50,
    eventMaxBuffer: 10000,
    eventFlushMaxConsecutiveFailures: 5,
    tags: [],
    maxConcurrentTasks: 1,
    taskMemoryLimitBytes: 0,
    memoryCheckIntervalMs: 2000,
  };
}

// Capture console output
function captureOutput(fn: () => void): string[] {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = (msg: string) => logs.push(msg);
  console.warn = (msg: string) => logs.push(msg);
  console.error = (msg: string) => logs.push(msg);

  try {
    fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }

  return logs;
}

Deno.test("logger outputs JSON format", () => {
  const config = createTestConfig("info");
  const logger = createLogger(config);

  const logs = captureOutput(() => {
    logger.info("Test message");
  });

  assertEquals(logs.length, 1);
  const entry = JSON.parse(logs[0]);
  assertEquals(entry.level, "info");
  assertEquals(entry.msg, "Test message");
  assertEquals(entry.workerId, "test-worker");
  assertEquals(entry.service, "glubean-worker");
});

Deno.test("logger includes additional data", () => {
  const config = createTestConfig("info");
  const logger = createLogger(config);

  const logs = captureOutput(() => {
    logger.info("User action", { userId: "user-123", action: "login" });
  });

  const entry = JSON.parse(logs[0]);
  assertEquals(entry.userId, "user-123");
  assertEquals(entry.action, "login");
});

Deno.test("logger respects log level", () => {
  const config = createTestConfig("warn");
  const logger = createLogger(config);

  const logs = captureOutput(() => {
    logger.debug("Debug message");
    logger.info("Info message");
    logger.warn("Warn message");
    logger.error("Error message");
  });

  // Only warn and error should be logged
  assertEquals(logs.length, 2);
  assertStringIncludes(logs[0], "Warn message");
  assertStringIncludes(logs[1], "Error message");
});

Deno.test("logger child inherits bindings", () => {
  const config = createTestConfig("info");
  const logger = createLogger(config);
  const childLogger = logger.child({ taskId: "task-123" });

  const logs = captureOutput(() => {
    childLogger.info("Processing");
  });

  const entry = JSON.parse(logs[0]);
  assertEquals(entry.workerId, "test-worker");
  assertEquals(entry.taskId, "task-123");
});

Deno.test("logger redacts sensitive fields", () => {
  const config = createTestConfig("info");
  const logger = createLogger(config);

  const logs = captureOutput(() => {
    logger.info("Auth data", {
      username: "john",
      password: "secret123",
      token: "bearer_xxx",
      apiKey: "key_abc",
      leaseToken: "lease_xyz",
    });
  });

  const entry = JSON.parse(logs[0]);
  assertEquals(entry.username, "john");
  assertEquals(entry.password, "[REDACTED]");
  assertEquals(entry.token, "[REDACTED]");
  assertEquals(entry.apiKey, "[REDACTED]");
  assertEquals(entry.leaseToken, "[REDACTED]");
});

Deno.test("logger redacts nested sensitive fields", () => {
  const config = createTestConfig("info");
  const logger = createLogger(config);

  const logs = captureOutput(() => {
    logger.info("Nested data", {
      user: {
        name: "john",
        secrets: { apiKey: "abc123" },
      },
    });
  });

  const entry = JSON.parse(logs[0]);
  assertEquals(entry.user.name, "john");
  assertEquals(entry.user.secrets, "[REDACTED]");
});

Deno.test("noopLogger does nothing", () => {
  const logger = createNoopLogger();

  const logs = captureOutput(() => {
    logger.debug("Debug");
    logger.info("Info");
    logger.warn("Warn");
    logger.error("Error");
  });

  assertEquals(logs.length, 0);
});

Deno.test("noopLogger child also does nothing", () => {
  const logger = createNoopLogger();
  const child = logger.child({ taskId: "123" });

  const logs = captureOutput(() => {
    child.info("Message");
  });

  assertEquals(logs.length, 0);
});
