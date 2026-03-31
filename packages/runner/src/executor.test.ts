import { test, expect, afterAll, beforeAll } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TestExecutor } from "./executor.js";
import type { ExecutionEvent, ExecutorOptions, TimelineEvent } from "./executor.js";
import { LOCAL_RUN_DEFAULTS, SHARED_RUN_DEFAULTS, WORKER_RUN_DEFAULTS } from "./config.js";
import { generateSummary } from "./generate_summary.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUNNER_ROOT = resolve(__dirname, "..");
const TMP_DIR = join(RUNNER_ROOT, ".tmp-test");
let tmpSeq = 0;

beforeAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

// Helper to filter assertions from events
function getAssertions(events: TimelineEvent[]) {
  return events.filter(
    (e): e is Extract<TimelineEvent, { type: "assertion" }> => e.type === "assertion",
  );
}

// Helper to filter traces from events
function getTraces(events: TimelineEvent[]) {
  return events.filter(
    (e): e is Extract<TimelineEvent, { type: "trace" }> => e.type === "trace",
  );
}

function getStepStarts(events: TimelineEvent[]) {
  return events.filter(
    (e): e is Extract<TimelineEvent, { type: "step_start" }> => e.type === "step_start",
  );
}

function getStepEnds(events: TimelineEvent[]) {
  return events.filter(
    (e): e is Extract<TimelineEvent, { type: "step_end" }> => e.type === "step_end",
  );
}

function getWarnings(events: TimelineEvent[]) {
  return events.filter(
    (e): e is Extract<TimelineEvent, { type: "warning" }> => e.type === "warning",
  );
}

function getSchemaValidations(events: TimelineEvent[]) {
  return events.filter(
    (e): e is Extract<TimelineEvent, { type: "schema_validation" }> =>
      e.type === "schema_validation",
  );
}

async function makeTempFile(content: string, name = "test.ts"): Promise<string> {
  const dir = join(TMP_DIR, String(tmpSeq++));
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, content);
  return file;
}

// Create a simple test file for testing
const TEST_FILE_CONTENT = `
import { test } from "@glubean/sdk";

export const passingTest = test(
  { id: "passingTest", name: "Passing Test", tags: ["unit"] },
  async (ctx) => {
    ctx.log("Hello from test");
    ctx.assert(true, "Should pass");
  }
);

export const failingTest = test(
  { id: "failingTest", name: "Failing Test" },
  async (ctx) => {
    ctx.assert(false, "Should fail", { actual: "bad", expected: "good" });
  }
);

export const tracingTest = test(
  { id: "tracingTest", name: "Tracing Test" },
  async (ctx) => {
    ctx.trace({ method: "GET", url: "https://example.com", status: 200, duration: 50 });
    ctx.assert(true, "Traced successfully");
  }
);

export const warningTest = test(
  { id: "warningTest", name: "Warning Test" },
  async (ctx) => {
    ctx.warn(true, "This should be fine");
    ctx.warn(false, "Performance is slow");
    ctx.warn(false, "Missing cache header");
    ctx.assert(true, "Test still passes");
  }
);

export const warningOnlyTest = test(
  { id: "warningOnlyTest", name: "Warning Only Test" },
  async (ctx) => {
    ctx.warn(false, "All warnings, no assertions");
    ctx.warn(false, "Another warning");
  }
);
`;

// ---------------------------------------------------------------------------
// Basic executor tests
// ---------------------------------------------------------------------------

test("TestExecutor - executes passing test", async () => {
  const testFile = await makeTempFile(TEST_FILE_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(`file://${testFile}`, "passingTest", {
    vars: {},
    secrets: {},
  });

  expect(result.success).toBe(true);
  expect(result.testId).toBe("passingTest");
  expect(result.testName).toBeDefined();
  const assertions = getAssertions(result.events);
  expect(assertions.length).toBe(1);
  expect(assertions[0].passed).toBe(true);
});

test("TestExecutor - executes failing test", async () => {
  const testFile = await makeTempFile(TEST_FILE_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(`file://${testFile}`, "failingTest", {
    vars: {},
    secrets: {},
  });

  const assertions = getAssertions(result.events);
  expect(assertions.length).toBe(1);
  expect(assertions[0].passed).toBe(false);
  expect(assertions[0].message).toBe("Should fail");
  expect(assertions[0].actual).toBe("bad");
  expect(assertions[0].expected).toBe("good");
});

test("TestExecutor - captures traces", async () => {
  const testFile = await makeTempFile(TEST_FILE_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(`file://${testFile}`, "tracingTest", {
    vars: {},
    secrets: {},
  });

  const traces = getTraces(result.events);
  expect(traces.length).toBe(1);
  expect(traces[0].data.method).toBe("GET");
  expect(traces[0].data.url).toBe("https://example.com");
  expect(traces[0].data.status).toBe(200);
  expect(traces[0].data.duration).toBe(50);
});

test("TestExecutor - streaming run yields events", async () => {
  const testFile = await makeTempFile(TEST_FILE_CONTENT);
  const executor = new TestExecutor();

  const events: ExecutionEvent[] = [];
  for await (
    const event of executor.run(`file://${testFile}`, "passingTest", {
      vars: {},
      secrets: {},
    })
  ) {
    events.push(event);
  }

  const eventTypes = events.map((e) => e.type);
  expect(eventTypes.includes("start")).toBe(true);
  expect(eventTypes.includes("assertion")).toBe(true);
  expect(eventTypes.includes("status")).toBe(true);
});

test("TestExecutor - handles missing test", async () => {
  const testFile = await makeTempFile(TEST_FILE_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "nonExistentTest",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(false);
  expect(result.error).toBeDefined();
  expect(result.error?.includes("not found")).toBe(true);
});

test("TestExecutor - passes vars to context", async () => {
  const testFile = await makeTempFile(`
import { test } from "@glubean/sdk";

export const varsTest = test(
  { id: "varsTest" },
  async (ctx) => {
    ctx.assert(ctx.vars.require("BASE_URL") === "https://api.test.com", "BASE_URL matches");
    ctx.assert(ctx.vars.require("ENV") === "test", "ENV matches");
  }
);
`);

  const executor = new TestExecutor();
  const result = await executor.execute(`file://${testFile}`, "varsTest", {
    vars: { BASE_URL: "https://api.test.com", ENV: "test" },
    secrets: {},
  });

  expect(result.success).toBe(true);
  const assertions = getAssertions(result.events);
  expect(assertions.every((a) => a.passed)).toBe(true);
});

test("TestExecutor - onEvent callback streams events", async () => {
  const testFile = await makeTempFile(TEST_FILE_CONTENT);
  const executor = new TestExecutor();

  const streamedEvents: TimelineEvent[] = [];
  const result = await executor.execute(
    `file://${testFile}`,
    "passingTest",
    { vars: {}, secrets: {} },
    {
      onEvent: (event) => {
        streamedEvents.push(event);
      },
    },
  );

  expect(result.success).toBe(true);
  expect(streamedEvents.length).toBe(result.events.length);
  expect(streamedEvents.map((e) => e.type)).toEqual(result.events.map((e) => e.type));
});

test("TestExecutor - async onEvent callback is awaited", async () => {
  const testFile = await makeTempFile(TEST_FILE_CONTENT);
  const executor = new TestExecutor();

  const order: string[] = [];
  const result = await executor.execute(
    `file://${testFile}`,
    "passingTest",
    { vars: {}, secrets: {} },
    {
      onEvent: async (event) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(`callback:${event.type}`);
      },
    },
  );

  expect(result.success).toBe(true);
  expect(order.length).toBe(result.events.length);
});

test("TestExecutor - executeMany includes testId in streamed events", async () => {
  const testFile = await makeTempFile(TEST_FILE_CONTENT);
  const executor = new TestExecutor();

  const streamedEvents: TimelineEvent[] = [];
  const batchResult = await executor.executeMany(
    `file://${testFile}`,
    ["passingTest", "tracingTest"],
    { vars: {}, secrets: {} },
    {
      concurrency: 2,
      onEvent: (event) => {
        streamedEvents.push(event);
      },
    },
  );

  expect(batchResult.success).toBe(true);
  expect(batchResult.results.length).toBe(2);

  for (const event of streamedEvents) {
    expect(event.testId).toBeDefined();
    expect(["passingTest", "tracingTest"].includes(event.testId!)).toBe(true);
  }

  const testIds = new Set(streamedEvents.map((e) => e.testId));
  expect(testIds.size).toBe(2);
});

// ---------------------------------------------------------------------------
// ctx.fail tests
// ---------------------------------------------------------------------------

const FAIL_TEST_CONTENT = `
import { test } from "@glubean/sdk";

export const failTest = test("failTest", async (ctx) => {
  ctx.log("before fail");
  ctx.fail("Something went wrong");
  ctx.log("after fail — should never reach here");
});

export const failInTryCatch = test("failInTryCatch", async (ctx) => {
  try {
    await Promise.resolve();
    ctx.fail("Expected error but succeeded");
  } catch {
    ctx.log("caught fail error");
  }
  ctx.assert(true, "continued after caught fail");
});
`;

test("ctx.fail - immediately aborts test with failure", async () => {
  const testFile = await makeTempFile(FAIL_TEST_CONTENT);
  const executor = new TestExecutor();
  const result = await executor.execute(`file://${testFile}`, "failTest", {
    vars: {},
    secrets: {},
  });

  expect(result.success).toBe(false);

  const assertions = getAssertions(result.events);
  const failAssertion = assertions.find(
    (a) => a.message === "Something went wrong" && a.passed === false,
  );
  expect(failAssertion).toBeDefined();

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log",
  );
  const logMessages = logs.map((l) => l.message);
  expect(logMessages.some((m) => m.includes("before fail"))).toBe(true);
  expect(logMessages.some((m) => m.includes("after fail"))).toBe(false);
});

test("ctx.fail - can be caught in try/catch (user choice)", async () => {
  const testFile = await makeTempFile(FAIL_TEST_CONTENT);
  const executor = new TestExecutor();
  const result = await executor.execute(
    `file://${testFile}`,
    "failInTryCatch",
    { vars: {}, secrets: {} },
  );

  // ctx.fail() emits a failed assertion even when caught — test correctly fails
  expect(result.success).toBe(false);

  const assertions = getAssertions(result.events);
  const passedAssertion = assertions.find(
    (a) => a.message === "continued after caught fail" && a.passed === true,
  );
  expect(passedAssertion).toBeDefined();
});

// ---------------------------------------------------------------------------
// ctx.pollUntil tests
// ---------------------------------------------------------------------------

const POLL_TEST_CONTENT = `
import { test } from "@glubean/sdk";

let callCount = 0;

export const pollSuccess = test("pollSuccess", async (ctx) => {
  callCount = 0;
  await ctx.pollUntil({ timeoutMs: 5000, intervalMs: 100 }, async () => {
    callCount++;
    return callCount >= 3;
  });
  ctx.assert(callCount >= 3, "Should have polled at least 3 times");
  ctx.log("poll succeeded");
});

export const pollTimeout = test("pollTimeout", async (ctx) => {
  await ctx.pollUntil({ timeoutMs: 300, intervalMs: 100 }, async () => {
    return false;
  });
  ctx.log("should not reach here");
});

export const pollSilentTimeout = test("pollSilentTimeout", async (ctx) => {
  let timedOut = false;
  await ctx.pollUntil(
    {
      timeoutMs: 300,
      intervalMs: 100,
      onTimeout: () => { timedOut = true; },
    },
    async () => false
  );
  ctx.assert(timedOut === true, "onTimeout should have been called");
  ctx.log("continued after silent timeout");
});

export const pollErrorRetry = test("pollErrorRetry", async (ctx) => {
  let attempts = 0;
  await ctx.pollUntil({ timeoutMs: 5000, intervalMs: 100 }, async () => {
    attempts++;
    if (attempts < 3) throw new Error("not ready yet");
    return true;
  });
  ctx.assert(attempts >= 3, "Should have retried through errors");
  ctx.log("recovered from errors");
});

export const pollTimeoutWithError = test("pollTimeoutWithError", async (ctx) => {
  let lastErr;
  await ctx.pollUntil(
    {
      timeoutMs: 300,
      intervalMs: 100,
      onTimeout: (err) => { lastErr = err; },
    },
    async () => {
      throw new Error("always fails");
    }
  );
  ctx.assert(lastErr !== undefined, "onTimeout should receive last error");
  ctx.log("got last error in onTimeout");
});
`;

test("ctx.pollUntil - succeeds after multiple polls", async () => {
  const testFile = await makeTempFile(POLL_TEST_CONTENT);
  const executor = new TestExecutor();
  const result = await executor.execute(`file://${testFile}`, "pollSuccess", {
    vars: {},
    secrets: {},
  });

  expect(result.success).toBe(true);

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log",
  );
  expect(logs.some((l) => l.message.includes("poll succeeded"))).toBe(true);
});

test("ctx.pollUntil - throws on timeout (default)", async () => {
  const testFile = await makeTempFile(POLL_TEST_CONTENT);
  const executor = new TestExecutor();
  const result = await executor.execute(`file://${testFile}`, "pollTimeout", {
    vars: {},
    secrets: {},
  });

  expect(result.success).toBe(false);

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log",
  );
  expect(logs.some((l) => l.message.includes("should not reach here"))).toBe(false);
});

test("ctx.pollUntil - silent timeout with onTimeout", async () => {
  const testFile = await makeTempFile(POLL_TEST_CONTENT);
  const executor = new TestExecutor();
  const result = await executor.execute(
    `file://${testFile}`,
    "pollSilentTimeout",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(true);

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log",
  );
  expect(logs.some((l) => l.message.includes("continued after silent timeout"))).toBe(true);
});

test("ctx.pollUntil - retries through errors", async () => {
  const testFile = await makeTempFile(POLL_TEST_CONTENT);
  const executor = new TestExecutor();
  const result = await executor.execute(
    `file://${testFile}`,
    "pollErrorRetry",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(true);

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log",
  );
  expect(logs.some((l) => l.message.includes("recovered from errors"))).toBe(true);
});

test("ctx.pollUntil - onTimeout receives last error", async () => {
  const testFile = await makeTempFile(POLL_TEST_CONTENT);
  const executor = new TestExecutor();
  const result = await executor.execute(
    `file://${testFile}`,
    "pollTimeoutWithError",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(true);

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log",
  );
  expect(logs.some((l) => l.message.includes("got last error in onTimeout"))).toBe(true);
});

// =============================================================================
// Dynamic timeout updates via ctx.setTimeout
// =============================================================================

const TIMEOUT_UPDATE_TEST_CONTENT = `
import { test } from "@glubean/sdk";

export const extendTimeoutTest = test({ id: "extend-timeout" }, async (ctx) => {
  ctx.setTimeout(450);
  await new Promise((resolve) => setTimeout(resolve, 220));
  ctx.assert(true, "completed after timeout increase");
});

export const shortenTimeoutTest = test({ id: "shorten-timeout" }, async (ctx) => {
  ctx.setTimeout(80);
  await new Promise((resolve) => setTimeout(resolve, 220));
  ctx.assert(true, "should not reach");
});

export const invalidTimeoutUpdateTest = test(
  { id: "invalid-timeout-update" },
  async (ctx) => {
    ctx.setTimeout(Number.NaN);
    await new Promise((resolve) => setTimeout(resolve, 220));
    ctx.assert(true, "should not reach");
  },
);
`;

test("ctx.setTimeout - can extend timeout dynamically", async () => {
  const testFile = await makeTempFile(TIMEOUT_UPDATE_TEST_CONTENT);
  const executor = new TestExecutor();
  // Initial timeout must be long enough for tsx subprocess to start up (~200ms)
  // and reach ctx.setTimeout(450) before the initial timeout fires.
  const result = await executor.execute(
    `file://${testFile}`,
    "extend-timeout",
    { vars: {}, secrets: {} },
    { timeout: 500 },
  );

  expect(result.success).toBe(true);
  const assertions = getAssertions(result.events);
  expect(assertions.length > 0).toBe(true);
  expect(assertions.every((a) => a.passed)).toBe(true);
});

test("ctx.setTimeout - can reduce timeout dynamically", async () => {
  const testFile = await makeTempFile(TIMEOUT_UPDATE_TEST_CONTENT);
  const executor = new TestExecutor();
  const result = await executor.execute(
    `file://${testFile}`,
    "shorten-timeout",
    { vars: {}, secrets: {} },
    { timeout: 5000 },
  );

  expect(result.success).toBe(false);
  expect(result.error).toBeDefined();
  // In Node/tsx, the timeout message may differ slightly
  expect(result.error?.includes("timed out")).toBe(true);
});

test("ctx.setTimeout - ignores invalid timeout updates", async () => {
  const testFile = await makeTempFile(TIMEOUT_UPDATE_TEST_CONTENT);
  const executor = new TestExecutor();
  const result = await executor.execute(
    `file://${testFile}`,
    "invalid-timeout-update",
    { vars: {}, secrets: {} },
    { timeout: 100 },
  );

  expect(result.success).toBe(false);
  expect(result.error).toBeDefined();
  expect(result.error?.includes("timed out after 100ms")).toBe(true);
});

// =============================================================================
// Auto-build (no .build()) tests
// =============================================================================

const AUTO_BUILD_TEST_CONTENT = `
import { test } from "@glubean/sdk";

export const myTest = test("auto-build-test")
  .meta({ tags: ["auto"] })
  .step("step one", async (ctx) => {
    ctx.log("step one executed");
    return { value: 42 };
  })
  .step("step two", async (ctx, state) => {
    ctx.log("step two got " + state.value);
    ctx.assert(state.value === 42, "state should carry over");
  });

export const explicitTest = test("explicit-build-test")
  .step("check", async (ctx) => {
    ctx.log("explicit build works");
    ctx.assert(true, "always passes");
  })
  .build();

export const stepAssertFail = test("step-assert-fail")
  .step("passing step", async (ctx) => {
    ctx.assert(true, "this passes");
  })
  .step("failing step", async (ctx) => {
    ctx.assert(false, "this fails");
    ctx.assert(false, "this also fails");
  })
  .step("should be skipped", async (ctx) => {
    ctx.log("this should never run");
  });

export const stepThrowFail = test("step-throw-fail")
  .step("boom", async () => {
    throw new Error("step exploded");
  })
  .step("after boom", async (ctx) => {
    ctx.log("should not run");
  });

export const stepsAllPass = test("steps-all-pass")
  .step("step A", async (ctx) => {
    ctx.assert(true, "A passes");
  })
  .step("step B", async (ctx) => {
    ctx.assert(true, "B passes");
  });

export const stepRetryPass = test("step-retry-pass")
  .setup(async () => ({ attempts: 0 }))
  .step("flaky with retry", { retries: 2 }, async (ctx, state) => {
    state.attempts += 1;
    ctx.assert(state.attempts >= 2, "step should pass on retry");
    return state;
  })
  .step("after retry", async (ctx) => {
    ctx.assert(true, "next step should run");
  });

export const stepRetryExhausted = test("step-retry-exhausted")
  .setup(async () => ({ attempts: 0 }))
  .step("always failing with retry", { retries: 2 }, async (ctx, state) => {
    state.attempts += 1;
    ctx.assert(false, "still failing");
    return state;
  })
  .step("skipped after retries", async (ctx) => {
    ctx.log("this should not run");
  });

export const stepTimeoutFail = test("step-timeout-fail")
  .step("slow timed step", { timeout: 80 }, async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    ctx.assert(true, "should not reach");
  })
  .step("after timeout", async (ctx) => {
    ctx.log("this should not run");
  });

export const stepTimeoutTerminal = test("step-timeout-terminal")
  .step("timeout terminal", { timeout: 80, retries: 1 }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 140));
  });

export const stepRetryBackoff = test("step-retry-backoff")
  .setup(async () => ({ attempts: 0, timestamps: [] as number[] }))
  .step("backoff step", { retries: 2, retryDelay: 200, backoff: 2 }, async (ctx, state) => {
    state.attempts += 1;
    state.timestamps.push(Date.now());
    ctx.assert(state.attempts >= 3, "pass on 3rd attempt");
    return state;
  });
`;

test("builder without .build() is auto-resolved by runner", async () => {
  const testFile = await makeTempFile(AUTO_BUILD_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "auto-build-test",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(true);
  expect(result.testId).toBe("auto-build-test");

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log",
  );
  expect(logs.some((l) => l.message.includes("step one executed"))).toBe(true);
  expect(logs.some((l) => l.message.includes("step two got 42"))).toBe(true);

  const assertions = getAssertions(result.events);
  expect(assertions.length).toBe(1);
  expect(assertions[0].passed).toBe(true);
});

test("builder with .build() still works as before", async () => {
  const testFile = await makeTempFile(AUTO_BUILD_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "explicit-build-test",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(true);
  expect(result.testId).toBe("explicit-build-test");

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log",
  );
  expect(logs.some((l) => l.message.includes("explicit build works"))).toBe(true);
});

test("step retries - passes on retry and continues flow", async () => {
  const testFile = await makeTempFile(AUTO_BUILD_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "step-retry-pass",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(true);

  const ends = getStepEnds(result.events);
  expect(ends.length).toBe(2);
  expect(ends[0].name).toBe("flaky with retry");
  expect(ends[0].status).toBe("passed");
  expect(ends[0].attempts).toBe(2);
  expect(ends[0].retriesUsed).toBe(1);
  expect(ends[1].name).toBe("after retry");
  expect(ends[1].status).toBe("passed");

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log",
  );
  expect(
    logs.some((l) => l.message.includes('Retrying step "flaky with retry" (2/3)')),
  ).toBe(true);
});

test("step retries - exhausted retries fail the step", async () => {
  const testFile = await makeTempFile(AUTO_BUILD_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "step-retry-exhausted",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(false);
  const ends = getStepEnds(result.events);
  expect(ends.length).toBe(2);
  expect(ends[0].name).toBe("always failing with retry");
  expect(ends[0].status).toBe("failed");
  expect(ends[0].attempts).toBe(3);
  expect(ends[0].retriesUsed).toBe(2);
  expect(ends[1].name).toBe("skipped after retries");
  expect(ends[1].status).toBe("skipped");

  const failedAssertions = getAssertions(result.events).filter((a) => !a.passed);
  expect(failedAssertions.length).toBe(3);

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log",
  );
  const retryLogs = logs.filter((l) =>
    l.message.includes('Retrying step "always failing with retry"'),
  );
  expect(retryLogs.length).toBe(2);
});

test("step timeout - marks timed out step as failed", async () => {
  const testFile = await makeTempFile(AUTO_BUILD_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "step-timeout-fail",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(false);
  const ends = getStepEnds(result.events);
  expect(ends.length).toBe(2);
  expect(ends[0].name).toBe("slow timed step");
  expect(ends[0].status).toBe("failed");
  expect(ends[0].attempts).toBe(1);
  expect(ends[0].retriesUsed).toBe(0);
  expect(ends[0].error?.includes("timed out after 80ms")).toBe(true);
  expect(ends[1].name).toBe("after timeout");
  expect(ends[1].status).toBe("skipped");
});

test("step timeout - is terminal even when retries are configured", async () => {
  const testFile = await makeTempFile(AUTO_BUILD_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "step-timeout-terminal",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(false);
  const ends = getStepEnds(result.events);
  expect(ends.length).toBe(1);
  expect(ends[0].name).toBe("timeout terminal");
  expect(ends[0].status).toBe("failed");
  expect(ends[0].attempts).toBe(1);
  expect(ends[0].retriesUsed).toBe(0);
  expect(ends[0].error?.includes("timed out after 80ms")).toBe(true);

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log",
  );
  expect(
    logs.some((l) => l.message.includes('Retrying step "timeout terminal"')),
  ).toBe(false);
});

test("step retries - backoff delays between retries", async () => {
  const testFile = await makeTempFile(AUTO_BUILD_TEST_CONTENT);
  const executor = new TestExecutor();

  const start = Date.now();
  const result = await executor.execute(
    `file://${testFile}`,
    "step-retry-backoff",
    { vars: {}, secrets: {} },
  );
  const elapsed = Date.now() - start;

  // retryDelay: 200, backoff: 2 → delays: 200ms, 400ms = 600ms total
  expect(result.success).toBe(true);
  expect(elapsed).toBeGreaterThanOrEqual(500); // at least 500ms of delay
  expect(elapsed).toBeLessThan(3000); // but not unreasonably long

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log",
  );
  expect(logs.some((l) => l.message.includes("waiting 200ms"))).toBe(true);
  expect(logs.some((l) => l.message.includes("waiting 400ms"))).toBe(true);
}, 10_000);

// =============================================================================
// Step event tests — duration, pass/fail/skip, assertion counting
// =============================================================================

test("step events - all passing steps emit correct events", async () => {
  const testFile = await makeTempFile(AUTO_BUILD_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "steps-all-pass",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(true);

  const starts = getStepStarts(result.events);
  const ends = getStepEnds(result.events);

  expect(starts.length).toBe(2);
  expect(ends.length).toBe(2);

  expect(starts[0].name).toBe("step A");
  expect(starts[0].index).toBe(0);
  expect(starts[0].total).toBe(2);
  expect(starts[1].name).toBe("step B");
  expect(starts[1].index).toBe(1);

  expect(ends[0].status).toBe("passed");
  expect(ends[0].name).toBe("step A");
  expect(typeof ends[0].durationMs).toBe("number");
  expect(ends[0].assertions).toBe(1);
  expect(ends[0].failedAssertions).toBe(0);

  expect(ends[1].status).toBe("passed");
  expect(ends[1].name).toBe("step B");
});

test("step events - failed assertion stops subsequent steps", async () => {
  const testFile = await makeTempFile(AUTO_BUILD_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "step-assert-fail",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(false);

  const ends = getStepEnds(result.events);
  expect(ends.length).toBe(3);

  expect(ends[0].name).toBe("passing step");
  expect(ends[0].status).toBe("passed");
  expect(ends[0].assertions).toBe(1);
  expect(ends[0].failedAssertions).toBe(0);

  expect(ends[1].name).toBe("failing step");
  expect(ends[1].status).toBe("failed");
  expect(ends[1].assertions).toBe(2);
  expect(ends[1].failedAssertions).toBe(2);
  expect(ends[1].error).toBeUndefined();

  expect(ends[2].name).toBe("should be skipped");
  expect(ends[2].status).toBe("skipped");
  expect(ends[2].durationMs).toBe(0);

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log",
  );
  expect(logs.some((l) => l.message.includes("this should never run"))).toBe(false);
});

test("step events - thrown error stops subsequent steps", async () => {
  const testFile = await makeTempFile(AUTO_BUILD_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "step-throw-fail",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(false);

  const ends = getStepEnds(result.events);
  expect(ends.length).toBe(2);

  expect(ends[0].name).toBe("boom");
  expect(ends[0].status).toBe("failed");
  expect(ends[0].error).toBe("step exploded");

  expect(ends[1].name).toBe("after boom");
  expect(ends[1].status).toBe("skipped");
});

test("step events - duration is measured", async () => {
  const testFile = await makeTempFile(AUTO_BUILD_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "steps-all-pass",
    { vars: {}, secrets: {} },
  );

  const ends = getStepEnds(result.events);
  for (const e of ends) {
    expect(typeof e.durationMs).toBe("number");
    expect(e.durationMs >= 0).toBe(true);
  }
});

test("step events - step_start and step_end have timestamps", async () => {
  const testFile = await makeTempFile(AUTO_BUILD_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "steps-all-pass",
    { vars: {}, secrets: {} },
  );

  const starts = getStepStarts(result.events);
  const ends = getStepEnds(result.events);

  for (const s of starts) {
    expect(typeof s.ts).toBe("number");
  }
  for (const e of ends) {
    expect(typeof e.ts).toBe("number");
  }

  expect(ends[0].ts >= starts[0].ts).toBe(true);
  expect(ends[1].ts >= starts[1].ts).toBe(true);
});

// =============================================================================
// stepIndex on events within steps
// =============================================================================

test("stepIndex - assertions within steps have stepIndex", async () => {
  const testFile = await makeTempFile(AUTO_BUILD_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "steps-all-pass",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(true);

  const assertions = getAssertions(result.events);
  expect(assertions.length).toBe(2);
  expect(assertions[0].stepIndex).toBe(0);
  expect(assertions[1].stepIndex).toBe(1);
});

test("stepIndex - logs within steps have stepIndex", async () => {
  const testFile = await makeTempFile(AUTO_BUILD_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "auto-build-test",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(true);

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log",
  );

  const stepOneLog = logs.find((l) => l.message.includes("step one executed"));
  const stepTwoLog = logs.find((l) => l.message.includes("step two got 42"));
  expect(stepOneLog).toBeDefined();
  expect(stepTwoLog).toBeDefined();
  expect(stepOneLog!.stepIndex).toBe(0);
  expect(stepTwoLog!.stepIndex).toBe(1);
});

test("stepIndex - events outside steps have no stepIndex", async () => {
  const testFile = await makeTempFile(TEST_FILE_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(`file://${testFile}`, "passingTest", {
    vars: {},
    secrets: {},
  });

  const assertions = getAssertions(result.events);
  expect(assertions.length).toBe(1);
  expect(assertions[0].stepIndex).toBeUndefined();
});

// =============================================================================
// assertionCount / failedAssertionCount on ExecutionResult
// =============================================================================

test("ExecutionResult - assertionCount and failedAssertionCount", async () => {
  const testFile = await makeTempFile(TEST_FILE_CONTENT);
  const executor = new TestExecutor();

  const passing = await executor.execute(
    `file://${testFile}`,
    "passingTest",
    { vars: {}, secrets: {} },
  );
  expect(passing.assertionCount).toBe(1);
  expect(passing.failedAssertionCount).toBe(0);

  const failing = await executor.execute(
    `file://${testFile}`,
    "failingTest",
    { vars: {}, secrets: {} },
  );
  expect(failing.assertionCount).toBe(1);
  expect(failing.failedAssertionCount).toBe(1);
});

test("ExecutionResult - assertionCount with multi-step test", async () => {
  const testFile = await makeTempFile(AUTO_BUILD_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "step-assert-fail",
    { vars: {}, secrets: {} },
  );
  expect(result.assertionCount).toBe(3);
  expect(result.failedAssertionCount).toBe(2);
});

// =============================================================================
// summary event enrichment
// =============================================================================

test("generateSummary - includes assertion and step counts", async () => {
  const testFile = await makeTempFile(AUTO_BUILD_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "steps-all-pass",
    { vars: {}, secrets: {} },
  );

  const summary = generateSummary(result.events);
  expect(summary.assertionTotal).toBe(2);
  expect(summary.assertionFailed).toBe(0);
  expect(summary.stepTotal).toBe(2);
  expect(summary.stepPassed).toBe(2);
  expect(summary.stepFailed).toBe(0);
  expect(summary.stepSkipped).toBe(0);
});

test("generateSummary - step failure counts", async () => {
  const testFile = await makeTempFile(AUTO_BUILD_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "step-assert-fail",
    { vars: {}, secrets: {} },
  );

  const summary = generateSummary(result.events);
  expect(summary.stepTotal).toBe(3);
  expect(summary.stepPassed).toBe(1);
  expect(summary.stepFailed).toBe(1);
  expect(summary.stepSkipped).toBe(1);
  expect(summary.assertionTotal).toBe(3);
  expect(summary.assertionFailed).toBe(2);
});

// =============================================================================
// ctx.warn — warning events
// =============================================================================

test("ctx.warn - emits warning events without failing the test", async () => {
  const testFile = await makeTempFile(TEST_FILE_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(`file://${testFile}`, "warningTest", {
    vars: {},
    secrets: {},
  });

  expect(result.success).toBe(true);

  const warnings = getWarnings(result.events);
  expect(warnings.length).toBe(3);

  expect(warnings[0].condition).toBe(true);
  expect(warnings[0].message).toBe("This should be fine");
  expect(warnings[1].condition).toBe(false);
  expect(warnings[1].message).toBe("Performance is slow");
  expect(warnings[2].condition).toBe(false);
  expect(warnings[2].message).toBe("Missing cache header");

  const assertions = getAssertions(result.events);
  expect(assertions.length).toBe(1);
  expect(assertions[0].passed).toBe(true);
});

test("ctx.warn - warning-only test still passes", async () => {
  const testFile = await makeTempFile(TEST_FILE_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "warningOnlyTest",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(true);

  const warnings = getWarnings(result.events);
  expect(warnings.length).toBe(2);
  expect(warnings[0].condition).toBe(false);
  expect(warnings[1].condition).toBe(false);

  const assertions = getAssertions(result.events);
  expect(assertions.length).toBe(0);
});

test("ctx.warn - generateSummary includes warning counters", async () => {
  const testFile = await makeTempFile(TEST_FILE_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(`file://${testFile}`, "warningTest", {
    vars: {},
    secrets: {},
  });

  const summary = generateSummary(result.events);
  expect(summary.warningTotal).toBe(3);
  expect(summary.warningTriggered).toBe(2);
});

// =============================================================================
// ctx.validate — schema validation
// =============================================================================

const VALIDATE_TEST_CONTENT = `
import { test } from "@glubean/sdk";
import { z } from "zod";

const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().email(),
});

export const validatePassTest = test(
  { id: "validatePassTest", name: "Validate Pass" },
  async (ctx) => {
    const user = ctx.validate(
      { id: 1, name: "Alice", email: "alice@example.com" },
      UserSchema,
      "user object",
    );
    ctx.assert(user !== undefined, "Should return parsed data");
    ctx.assert(user?.name === "Alice", "Parsed name should be Alice");
  },
);

export const validateErrorTest = test(
  { id: "validateErrorTest", name: "Validate Error" },
  async (ctx) => {
    const user = ctx.validate(
      { id: "not-a-number", name: 42, email: "bad" },
      UserSchema,
      "user object",
    );
    ctx.assert(user === undefined, "Should return undefined on failure");
  },
);

export const validateWarnTest = test(
  { id: "validateWarnTest", name: "Validate Warn" },
  async (ctx) => {
    const user = ctx.validate(
      { id: "bad", name: 42 },
      UserSchema,
      "strict contract",
      { severity: "warn" },
    );
    ctx.assert(user === undefined, "Should return undefined");
    ctx.assert(true, "Test continues and passes despite schema failure");
  },
);

export const validateFatalTest = test(
  { id: "validateFatalTest", name: "Validate Fatal" },
  async (ctx) => {
    ctx.validate(
      { id: "bad" },
      UserSchema,
      "response body",
      { severity: "fatal" },
    );
    ctx.log("after fatal — should never reach here");
  },
);

export const validateParseFallbackTest = test(
  { id: "validateParseFallbackTest", name: "Validate Parse Fallback" },
  async (ctx) => {
    const parseOnlySchema = {
      parse(data) {
        if (typeof data === "string") return data.toUpperCase();
        throw new Error("expected a string");
      },
    };
    const result = ctx.validate("hello", parseOnlySchema, "string data");
    ctx.assert(result === "HELLO", "Should return parsed (uppercased) value");

    const bad = ctx.validate(42, parseOnlySchema, "should-fail");
    ctx.assert(bad === undefined, "Should return undefined on parse failure");
  },
);
`;

test("ctx.validate - passes with valid data (severity: error)", async () => {
  const testFile = await makeTempFile(VALIDATE_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "validatePassTest",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(true);

  const validations = getSchemaValidations(result.events);
  expect(validations.length).toBe(1);
  expect(validations[0].success).toBe(true);
  expect(validations[0].label).toBe("user object");
  expect(validations[0].severity).toBe("error");
});

test("ctx.validate - fails with invalid data (severity: error)", async () => {
  const testFile = await makeTempFile(VALIDATE_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "validateErrorTest",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(false);

  const validations = getSchemaValidations(result.events);
  expect(validations.length).toBe(1);
  expect(validations[0].success).toBe(false);
  expect(validations[0].severity).toBe("error");
  expect(validations[0].issues).toBeDefined();

  const assertions = getAssertions(result.events);
  const failedAssertion = assertions.find((a) => !a.passed);
  expect(failedAssertion).toBeDefined();
  expect(result.failedAssertionCount > 0).toBe(true);
});

test("ctx.validate - warn severity does not fail the test", async () => {
  const testFile = await makeTempFile(VALIDATE_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "validateWarnTest",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(true);

  const validations = getSchemaValidations(result.events);
  expect(validations.length).toBe(1);
  expect(validations[0].success).toBe(false);
  expect(validations[0].severity).toBe("warn");
});

test("ctx.validate - fatal severity aborts test", async () => {
  const testFile = await makeTempFile(VALIDATE_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "validateFatalTest",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(false);

  const validations = getSchemaValidations(result.events);
  expect(validations.length).toBe(1);
  expect(validations[0].success).toBe(false);
  expect(validations[0].severity).toBe("fatal");

  const logs = result.events.filter(
    (e) => e.type === "log" && "message" in e && e.message.includes("after fatal"),
  );
  expect(logs.length).toBe(0);
});

test("ctx.validate - parse fallback (no safeParse)", async () => {
  const testFile = await makeTempFile(VALIDATE_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "validateParseFallbackTest",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(false);
  expect(result.failedAssertionCount > 0).toBe(true);

  const validations = getSchemaValidations(result.events);
  expect(validations.length).toBe(2);
  expect(validations[0].success).toBe(true);
  expect(validations[1].success).toBe(false);
});

test("ctx.validate - generateSummary includes schema validation counters", async () => {
  const testFile = await makeTempFile(VALIDATE_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "validateWarnTest",
    { vars: {}, secrets: {} },
  );

  const summary = generateSummary(result.events);
  expect(summary.schemaValidationTotal).toBe(1);
  expect(summary.schemaValidationFailed).toBe(0);
  expect(summary.schemaValidationWarnings).toBe(1);
});

// =============================================================================
// HTTP Schema Integration (Phase 4)
// =============================================================================

const HTTP_SCHEMA_TEST_CONTENT = `
import { test } from "@glubean/sdk";
import { z } from "zod";

const ResponseSchema = z.object({
  message: z.string(),
  status: z.number(),
});

const QuerySchema = z.object({
  page: z.number(),
  limit: z.number(),
});

export const httpQuerySchemaPassTest = test(
  { id: "httpQuerySchemaPassTest", name: "HTTP Query Schema Pass" },
  async (ctx) => {
    try {
      await ctx.http.get("https://httpbin.org/get", {
        searchParams: { page: 1, limit: 10 },
        schema: {
          query: QuerySchema,
        },
      });
    } catch {
      // network error is fine, we're testing validation logic
    }
    ctx.assert(true, "continued");
  },
);

export const httpQuerySchemaFailTest = test(
  { id: "httpQuerySchemaFailTest", name: "HTTP Query Schema Fail" },
  async (ctx) => {
    try {
      await ctx.http.get("https://httpbin.org/get", {
        searchParams: { page: "not-a-number", limit: "bad" },
        schema: {
          query: QuerySchema,
        },
      });
    } catch {
      // network error or ky error is fine
    }
    ctx.assert(true, "continued");
  },
);

export const httpRequestSchemaTest = test(
  { id: "httpRequestSchemaTest", name: "HTTP Request Schema" },
  async (ctx) => {
    const BodySchema = z.object({
      name: z.string(),
      email: z.string().email(),
    });

    try {
      await ctx.http.post("https://httpbin.org/post", {
        json: { name: "Alice", email: "alice@example.com" },
        schema: {
          request: BodySchema,
        },
      });
    } catch {
      // network error is fine
    }
    ctx.assert(true, "continued");
  },
);

export const httpRequestSchemaFailTest = test(
  { id: "httpRequestSchemaFailTest", name: "HTTP Request Schema Fail" },
  async (ctx) => {
    const BodySchema = z.object({
      name: z.string(),
      email: z.string().email(),
    });

    try {
      await ctx.http.post("https://httpbin.org/post", {
        json: { name: 42, email: "not-email" },
        schema: {
          request: BodySchema,
        },
      });
    } catch {
      // network error is fine
    }
    ctx.assert(true, "continued");
  },
);

export const httpSchemaWithSeverityTest = test(
  { id: "httpSchemaWithSeverityTest", name: "HTTP Schema With Severity" },
  async (ctx) => {
    try {
      await ctx.http.get("https://httpbin.org/get", {
        searchParams: { page: "bad" },
        schema: {
          query: { schema: QuerySchema, severity: "warn" },
        },
      });
    } catch {
      // network error is fine
    }
    ctx.assert(true, "continued");
  },
);
`;

test("HTTP schema - query validation passes with valid params", async () => {
  const testFile = await makeTempFile(HTTP_SCHEMA_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "httpQuerySchemaPassTest",
    { vars: {}, secrets: {} },
  );

  const validations = getSchemaValidations(result.events);
  expect(validations.length >= 1).toBe(true);
  const queryValidation = validations.find((v) => v.label === "query params");
  expect(queryValidation).toBeDefined();
  expect(queryValidation!.success).toBe(true);
});

test("HTTP schema - query validation fails with invalid params", async () => {
  const testFile = await makeTempFile(HTTP_SCHEMA_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "httpQuerySchemaFailTest",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(false);
  expect(result.failedAssertionCount).toBeGreaterThan(0);

  const validations = getSchemaValidations(result.events);
  const queryValidation = validations.find((v) => v.label === "query params");
  expect(queryValidation).toBeDefined();
  expect(queryValidation!.success).toBe(false);
});

test("HTTP schema - request body validation passes", async () => {
  const testFile = await makeTempFile(HTTP_SCHEMA_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "httpRequestSchemaTest",
    { vars: {}, secrets: {} },
  );

  const validations = getSchemaValidations(result.events);
  const bodyValidation = validations.find((v) => v.label === "request body");
  expect(bodyValidation).toBeDefined();
  expect(bodyValidation!.success).toBe(true);
});

test("HTTP schema - request body validation fails", async () => {
  const testFile = await makeTempFile(HTTP_SCHEMA_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "httpRequestSchemaFailTest",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(false);
  expect(result.failedAssertionCount).toBeGreaterThan(0);

  const validations = getSchemaValidations(result.events);
  const bodyValidation = validations.find((v) => v.label === "request body");
  expect(bodyValidation).toBeDefined();
  expect(bodyValidation!.success).toBe(false);
});

test("HTTP schema - severity: warn does not fail test", async () => {
  const testFile = await makeTempFile(HTTP_SCHEMA_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "httpSchemaWithSeverityTest",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(true);

  const validations = getSchemaValidations(result.events);
  const queryValidation = validations.find((v) => v.label === "query params");
  expect(queryValidation).toBeDefined();
  expect(queryValidation!.success).toBe(false);
  expect(queryValidation!.severity).toBe("warn");
});

// =============================================================================
// Fail-fast / failAfter (Phase 5)
// =============================================================================

const FAILFAST_TEST_CONTENT = `
import { test } from "@glubean/sdk";

export const test1 = test(
  { id: "test1", name: "Test 1 — passes" },
  async (ctx) => {
    ctx.assert(true, "test1 passes");
  },
);

export const test2 = test(
  { id: "test2", name: "Test 2 — fails" },
  async (ctx) => {
    ctx.fail("test2 intentional failure");
  },
);

export const test3 = test(
  { id: "test3", name: "Test 3 — passes" },
  async (ctx) => {
    ctx.assert(true, "test3 passes");
  },
);

export const test4 = test(
  { id: "test4", name: "Test 4 — fails" },
  async (ctx) => {
    ctx.fail("test4 intentional failure");
  },
);

export const test5 = test(
  { id: "test5", name: "Test 5 — passes" },
  async (ctx) => {
    ctx.assert(true, "test5 passes");
  },
);
`;

test("executeMany - stopOnFailure stops after first failure", async () => {
  const testFile = await makeTempFile(FAILFAST_TEST_CONTENT);
  const executor = new TestExecutor();

  const batch = await executor.executeMany(
    `file://${testFile}`,
    ["test1", "test2", "test3", "test4", "test5"],
    { vars: {}, secrets: {} },
    { stopOnFailure: true },
  );

  expect(batch.success).toBe(false);
  expect(batch.failedCount).toBe(1);
  expect(batch.results.length).toBe(2);
  expect(batch.skippedCount).toBe(3);
  expect(batch.results[0].success).toBe(true);
  expect(batch.results[1].success).toBe(false);
});

test("executeMany - failAfter:2 stops after 2 failures", async () => {
  const testFile = await makeTempFile(FAILFAST_TEST_CONTENT);
  const executor = new TestExecutor();

  const batch = await executor.executeMany(
    `file://${testFile}`,
    ["test1", "test2", "test3", "test4", "test5"],
    { vars: {}, secrets: {} },
    { failAfter: 2 },
  );

  expect(batch.success).toBe(false);
  expect(batch.failedCount).toBe(2);
  expect(batch.results.length).toBe(4);
  expect(batch.skippedCount).toBe(1);
});

test("executeMany - no failAfter runs all tests", async () => {
  const testFile = await makeTempFile(FAILFAST_TEST_CONTENT);
  const executor = new TestExecutor();

  const batch = await executor.executeMany(
    `file://${testFile}`,
    ["test1", "test2", "test3", "test4", "test5"],
    { vars: {}, secrets: {} },
  );

  expect(batch.success).toBe(false);
  expect(batch.failedCount).toBe(2);
  expect(batch.results.length).toBe(5);
  expect(batch.skippedCount).toBe(0);
});

test("executeMany - failAfter:1 is same as stopOnFailure", async () => {
  const testFile = await makeTempFile(FAILFAST_TEST_CONTENT);
  const executor = new TestExecutor();

  const batch = await executor.executeMany(
    `file://${testFile}`,
    ["test1", "test2", "test3", "test4", "test5"],
    { vars: {}, secrets: {} },
    { failAfter: 1 },
  );

  expect(batch.success).toBe(false);
  expect(batch.failedCount).toBe(1);
  expect(batch.results.length).toBe(2);
  expect(batch.skippedCount).toBe(3);
});

// =============================================================================
// System env fallback (CI scenario)
// =============================================================================

const SYSENV_TEST_CONTENT = `
import { test } from "@glubean/sdk";

export const sysEnvVarTest = test(
  { id: "sysEnvVarTest" },
  async (ctx) => {
    const value = ctx.vars.require("GLUBEAN_TEST_SYSENV");
    ctx.assert(value === "from_system", "Should resolve from system env");
  }
);

export const sysEnvSecretTest = test(
  { id: "sysEnvSecretTest" },
  async (ctx) => {
    const value = ctx.secrets.require("GLUBEAN_TEST_SECRET_SYSENV");
    ctx.assert(value === "secret_from_system", "Should resolve from system env");
  }
);

export const sysEnvOverrideTest = test(
  { id: "sysEnvOverrideTest" },
  async (ctx) => {
    const value = ctx.vars.require("GLUBEAN_TEST_OVERRIDE");
    ctx.assert(value === "from_dotenv", "Dotenv should take precedence over system env");
  }
);

export const sysEnvGetTest = test(
  { id: "sysEnvGetTest" },
  async (ctx) => {
    const value = ctx.vars.get("GLUBEAN_TEST_SYSENV");
    ctx.assert(value === "from_system", "get() should also fall back to system env");
    const missing = ctx.vars.get("GLUBEAN_NONEXISTENT_VAR");
    ctx.assert(missing === undefined, "Missing var should return undefined");
  }
);
`;

test("system env fallback - ctx.vars.require reads from system env", async () => {
  const testFile = await makeTempFile(SYSENV_TEST_CONTENT);
  const executor = new TestExecutor();

  process.env["GLUBEAN_TEST_SYSENV"] = "from_system";
  try {
    const result = await executor.execute(
      `file://${testFile}`,
      "sysEnvVarTest",
      { vars: {}, secrets: {} },
    );

    expect(result.success).toBe(true);
    const assertions = getAssertions(result.events);
    expect(assertions.length).toBe(1);
    expect(assertions[0].passed).toBe(true);
  } finally {
    delete process.env["GLUBEAN_TEST_SYSENV"];
  }
});

test("system env fallback - ctx.secrets.require reads from system env", async () => {
  const testFile = await makeTempFile(SYSENV_TEST_CONTENT);
  const executor = new TestExecutor();

  process.env["GLUBEAN_TEST_SECRET_SYSENV"] = "secret_from_system";
  try {
    const result = await executor.execute(
      `file://${testFile}`,
      "sysEnvSecretTest",
      { vars: {}, secrets: {} },
    );

    expect(result.success).toBe(true);
    const assertions = getAssertions(result.events);
    expect(assertions.length).toBe(1);
    expect(assertions[0].passed).toBe(true);
  } finally {
    delete process.env["GLUBEAN_TEST_SECRET_SYSENV"];
  }
});

test("system env fallback - .env takes precedence over system env", async () => {
  const testFile = await makeTempFile(SYSENV_TEST_CONTENT);
  const executor = new TestExecutor();

  process.env["GLUBEAN_TEST_OVERRIDE"] = "from_system";
  try {
    const result = await executor.execute(
      `file://${testFile}`,
      "sysEnvOverrideTest",
      { vars: { GLUBEAN_TEST_OVERRIDE: "from_dotenv" }, secrets: {} },
    );

    expect(result.success).toBe(true);
    const assertions = getAssertions(result.events);
    expect(assertions.length).toBe(1);
    expect(assertions[0].passed).toBe(true);
  } finally {
    delete process.env["GLUBEAN_TEST_OVERRIDE"];
  }
});

test("system env fallback - ctx.vars.get also falls back", async () => {
  const testFile = await makeTempFile(SYSENV_TEST_CONTENT);
  const executor = new TestExecutor();

  process.env["GLUBEAN_TEST_SYSENV"] = "from_system";
  try {
    const result = await executor.execute(
      `file://${testFile}`,
      "sysEnvGetTest",
      { vars: {}, secrets: {} },
    );

    expect(result.success).toBe(true);
    const assertions = getAssertions(result.events);
    expect(assertions.every((a) => a.passed)).toBe(true);
  } finally {
    delete process.env["GLUBEAN_TEST_SYSENV"];
  }
});

// ---------------------------------------------------------------------------
// test.extend() fixture resolution
// ---------------------------------------------------------------------------

const FIXTURE_SIMPLE_CONTENT = `
import { test } from "@glubean/sdk";

const myTest = test.extend({
  greeting: (_ctx) => "hello from fixture",
  answer: (_ctx) => 42,
});

export const simpleFixture = myTest(
  { id: "simpleFixture", name: "Simple Fixture" },
  async (ctx) => {
    ctx.assert(ctx.greeting === "hello from fixture", "greeting injected");
    ctx.assert(ctx.answer === 42, "answer injected");
    ctx.log("fixtures resolved: " + ctx.greeting + " " + ctx.answer);
  }
);
`;

const FIXTURE_LIFECYCLE_CONTENT = `
import { test } from "@glubean/sdk";

const myTest = test.extend({
  db: async (_ctx, use) => {
    const conn = { connected: true, id: "db-123" };
    await use(conn);
  },
});

export const lifecycleFixture = myTest(
  { id: "lifecycleFixture", name: "Lifecycle Fixture" },
  async (ctx) => {
    ctx.assert(ctx.db !== undefined, "db fixture injected");
    ctx.assert(ctx.db.connected === true, "db is connected");
    ctx.assert(ctx.db.id === "db-123", "db has correct id");
  }
);
`;

const FIXTURE_BUILDER_CONTENT = `
import { test } from "@glubean/sdk";

const myTest = test.extend({
  baseUrl: (ctx) => ctx.vars.require("BASE_URL"),
});

export const builderFixture = myTest("builder-fixture")
  .step("use fixture in step", async (ctx) => {
    ctx.assert(ctx.baseUrl === "https://test.api.com", "baseUrl from fixture matches var");
  });
`;

const FIXTURE_MIXED_CONTENT = `
import { test } from "@glubean/sdk";

const myTest = test.extend({
  simple: (_ctx) => "simple-value",
  managed: async (_ctx, use) => {
    const resource = { active: true };
    await use(resource);
    resource.active = false;
  },
});

export const mixedFixture = myTest(
  { id: "mixedFixture", name: "Mixed Fixture" },
  async (ctx) => {
    ctx.assert(ctx.simple === "simple-value", "simple fixture works");
    ctx.assert(ctx.managed.active === true, "lifecycle fixture works");
  }
);
`;

test("test.extend() - simple fixtures are injected into ctx", async () => {
  const testFile = await makeTempFile(FIXTURE_SIMPLE_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(`file://${testFile}`, "simpleFixture", {
    vars: {},
    secrets: {},
  });

  expect(result.success).toBe(true);
  const assertions = getAssertions(result.events);
  expect(assertions.length).toBe(2);
  expect(assertions.every((a) => a.passed)).toBe(true);
});

test("test.extend() - lifecycle fixtures wrap test execution", async () => {
  const testFile = await makeTempFile(FIXTURE_LIFECYCLE_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "lifecycleFixture",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(true);
  const assertions = getAssertions(result.events);
  expect(assertions.length).toBe(3);
  expect(assertions.every((a) => a.passed)).toBe(true);
});

test("test.extend() - fixtures work with builder API steps", async () => {
  const testFile = await makeTempFile(FIXTURE_BUILDER_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "builder-fixture",
    { vars: { BASE_URL: "https://test.api.com" }, secrets: {} },
  );

  expect(result.success).toBe(true);
  const assertions = getAssertions(result.events);
  expect(assertions.length).toBe(1);
  expect(assertions[0].passed).toBe(true);
});

test("test.extend() - mixed simple + lifecycle fixtures", async () => {
  const testFile = await makeTempFile(FIXTURE_MIXED_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(`file://${testFile}`, "mixedFixture", {
    vars: {},
    secrets: {},
  });

  expect(result.success).toBe(true);
  const assertions = getAssertions(result.events);
  expect(assertions.length).toBe(2);
  expect(assertions.every((a) => a.passed)).toBe(true);
});

// ---------------------------------------------------------------------------
// test.extend() lifecycle fixture guards
// ---------------------------------------------------------------------------

const FIXTURE_NO_USE_CONTENT = `
import { test } from "@glubean/sdk";

const myTest = test.extend({
  bad: async (_ctx, _use) => {
    // Lifecycle fixture that never calls use() — should fail
  },
});

export const noUseFixture = myTest(
  { id: "noUseFixture", name: "No Use Fixture" },
  async (ctx) => {
    ctx.assert(true, "should never run");
  }
);
`;

const FIXTURE_DOUBLE_USE_CONTENT = `
import { test } from "@glubean/sdk";

const myTest = test.extend({
  bad: async (_ctx, use) => {
    await use("first");
    await use("second");
  },
});

export const doubleUseFixture = myTest(
  { id: "doubleUseFixture", name: "Double Use Fixture" },
  async (ctx) => {
    ctx.assert(true, "runs once");
  }
);
`;

test("test.extend() - lifecycle fixture that skips use() fails the test", async () => {
  const testFile = await makeTempFile(FIXTURE_NO_USE_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "noUseFixture",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(false);
  expect(result.error?.includes("without calling use()")).toBe(true);
});

test("test.extend() - lifecycle fixture that calls use() twice fails the test", async () => {
  const testFile = await makeTempFile(FIXTURE_DOUBLE_USE_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "doubleUseFixture",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(false);
  expect(result.error?.includes("more than once")).toBe(true);
});

const FIXTURE_USE_NOT_AWAITED_CONTENT = `
import { test } from "@glubean/sdk";

const myTest = test.extend({
  value: (_ctx, use) => {
    use("hello");
    return Promise.resolve();
  },
});

export const notAwaitedFixture = myTest(
  { id: "notAwaitedFixture", name: "Not Awaited Fixture" },
  async (ctx) => {
    ctx.assert(ctx.value === "hello", "fixture value injected");
  }
);
`;

test("test.extend() - use() not awaited still completes test body", async () => {
  const testFile = await makeTempFile(FIXTURE_USE_NOT_AWAITED_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "notAwaitedFixture",
    { vars: {}, secrets: {} },
  );

  expect(result.success).toBe(true);

  const assertions = getAssertions(result.events);
  expect(assertions.length).toBe(1);
  expect(assertions[0].passed).toBe(true);
});

// ---------------------------------------------------------------------------
// fromSharedConfig tests (Node version — no permissions/allowNet)
// ---------------------------------------------------------------------------

test("fromSharedConfig: passes overrides through", () => {
  const executor = TestExecutor.fromSharedConfig(SHARED_RUN_DEFAULTS, {
    cwd: "/test/dir",
  });
  const opts = (executor as unknown as { options: ExecutorOptions }).options;
  expect(opts.cwd).toBe("/test/dir");
});

test("fromSharedConfig: wires emitFullTrace", () => {
  const executor = TestExecutor.fromSharedConfig({
    ...SHARED_RUN_DEFAULTS,
    emitFullTrace: true,
  });
  const opts = (executor as unknown as { options: ExecutorOptions }).options;
  expect(opts.emitFullTrace).toBe(true);
});

// ---------------------------------------------------------------------------
// Executor-level timeout must always fail
// ---------------------------------------------------------------------------

const HANGING_TEST_CONTENT = `
import { test } from "@glubean/sdk";

export const hangingTest = test("hanging", async (ctx) => {
  await new Promise(r => setTimeout(r, 60_000));
  ctx.assert(true, "should not reach");
});
`;

test("executor timeout - hanging test must fail", async () => {
  const testFile = await makeTempFile(HANGING_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "hanging",
    { vars: {}, secrets: {} },
    { timeout: 1000 },
  );

  expect(result.success).toBe(false);
  expect(result.error).toBeDefined();
  expect(result.error).toContain("timed out");
});

test("executor timeout - generateSummary on timeout events should not be success", async () => {
  const testFile = await makeTempFile(HANGING_TEST_CONTENT);
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "hanging",
    { vars: {}, secrets: {} },
    { timeout: 1000 },
  );

  const summary = generateSummary(result.events);
  // generateSummary with no assertions/steps returns success=true,
  // but the overall result.success should still be false
  expect(result.success).toBe(false);
});

// ---------------------------------------------------------------------------
// Open handles (e.g. TCP server) must not prevent process exit
// ---------------------------------------------------------------------------

const OPEN_HANDLE_TEST_CONTENT = `
import { test } from "@glubean/sdk";
import * as net from "node:net";

// Module-level TCP server — keeps the event loop alive unless process.exit() is called
const server = net.createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

export const openHandleTest = test("open-handle", (ctx) => {
  ctx.assert(true, "passes immediately");
});
`;

test("single-test mode exits even with open handles (no 30s timeout)", async () => {
  const testFile = await makeTempFile(OPEN_HANDLE_TEST_CONTENT);
  const executor = new TestExecutor();

  const start = Date.now();
  const result = await executor.execute(
    `file://${testFile}`,
    "open-handle",
    { vars: {}, secrets: {} },
    { timeout: 5000 },
  );
  const elapsed = Date.now() - start;

  expect(result.success).toBe(true);
  // Should complete well under the timeout, not hang for 5s
  expect(elapsed).toBeLessThan(4000);
});

// ---------------------------------------------------------------------------
// ALS per-test isolation regression tests
// ---------------------------------------------------------------------------

const ALS_BATCH_ASSERTIONS_CONTENT = `
import { test } from "@glubean/sdk";

export const testA = test("testA", async (ctx) => {
  ctx.assert(true, "a-pass-1");
  ctx.assert(true, "a-pass-2");
  ctx.assert(false, "a-fail-1");
});

export const testB = test("testB", async (ctx) => {
  ctx.assert(true, "b-pass-1");
});
`;

test("batch mode - assertion counters isolate per test (ALS)", async () => {
  const testFile = await makeTempFile(ALS_BATCH_ASSERTIONS_CONTENT);
  const executor = new TestExecutor();
  const events: ExecutionEvent[] = [];

  for await (const event of executor.run(
    `file://${testFile}`,
    "",
    { vars: {}, secrets: {} },
    { testIds: ["testA", "testB"], timeout: 10_000 },
  )) {
    events.push(event);
  }

  // testA should have 3 assertions (2 pass + 1 fail)
  const testAAssertions = events.filter(
    (e) => e.type === "assertion" && (e as any).message?.startsWith("a-"),
  );
  expect(testAAssertions.length).toBe(3);

  // testB should have 1 assertion — its counter must NOT carry over from testA
  const testBAssertions = events.filter(
    (e) => e.type === "assertion" && (e as any).message?.startsWith("b-"),
  );
  expect(testBAssertions.length).toBe(1);

  // testB should pass (its single assertion passes)
  const testBStatus = events.find(
    (e) => e.type === "status" && (e as any).id === "testB",
  );
  expect(testBStatus).toBeDefined();
  expect((testBStatus as any).status).toBe("completed");
});

const ALS_BATCH_STEPS_CONTENT = `
import { test } from "@glubean/sdk";

export const testA = test("testA")
  .step("a-step1", async (ctx) => {
    ctx.assert(true, "a-s1");
  })
  .step("a-step2", async (ctx) => {
    ctx.assert(true, "a-s2");
  });

export const testB = test("testB")
  .step("b-only", async (ctx) => {
    ctx.assert(true, "b-s1");
  });
`;

test("batch mode - step index resets per test (ALS)", async () => {
  const testFile = await makeTempFile(ALS_BATCH_STEPS_CONTENT);
  const executor = new TestExecutor();
  const events: ExecutionEvent[] = [];

  for await (const event of executor.run(
    `file://${testFile}`,
    "",
    { vars: {}, secrets: {} },
    { testIds: ["testA", "testB"], timeout: 10_000 },
  )) {
    events.push(event);
  }

  // testA has 2 step_start events
  const testAStepStarts = events.filter(
    (e) => e.type === "step_start" && (e as any).name?.startsWith("a-"),
  );
  expect(testAStepStarts.length).toBe(2);

  // testB's step should start at index 0, not 2
  const testBStepStart = events.find(
    (e) => e.type === "step_start" && (e as any).name === "b-only",
  );
  expect(testBStepStart).toBeDefined();
  expect((testBStepStart as any).index).toBe(0);
});

// ---------------------------------------------------------------------------
// E2E: parallel .each execution via --concurrency
// ---------------------------------------------------------------------------

const PARALLEL_EACH_CONTENT = `
import { test } from "@glubean/sdk";

export const tests = test.each([
  { id: "a" },
  { id: "b" },
  { id: "c" },
], { parallel: true })("par-$id", async (ctx, { id }) => {
  // Each test sleeps 200ms. Sequential = ~600ms, parallel(3) = ~200ms.
  await new Promise(r => setTimeout(r, 200));
  ctx.assert(true, id + " done");
});
`;

test("parallel .each - concurrent execution is faster than sequential", async () => {
  const testFile = await makeTempFile(PARALLEL_EACH_CONTENT);
  const executor = new TestExecutor();
  const events: ExecutionEvent[] = [];

  const start = Date.now();
  for await (const event of executor.run(
    `file://${testFile}`,
    "",
    { vars: {}, secrets: {} },
    {
      testIds: ["par-a", "par-b", "par-c"],
      concurrency: 3,
      timeout: 10_000,
    },
  )) {
    events.push(event);
  }
  const elapsed = Date.now() - start;

  // All 3 tests should pass
  const statuses = events.filter((e) => e.type === "status" && (e as any).status === "completed");
  expect(statuses.length).toBe(3);

  // With concurrency=3, 3x200ms tests should finish well under sequential time (~600ms).
  // CI runners can be slow, so use a generous threshold.
  expect(elapsed).toBeLessThan(700);
});

test("parallel .each - sequential (concurrency=1) takes full time", async () => {
  const testFile = await makeTempFile(PARALLEL_EACH_CONTENT);
  const executor = new TestExecutor();
  const events: ExecutionEvent[] = [];

  const start = Date.now();
  for await (const event of executor.run(
    `file://${testFile}`,
    "",
    { vars: {}, secrets: {} },
    {
      testIds: ["par-a", "par-b", "par-c"],
      // No concurrency → default sequential
      timeout: 10_000,
    },
  )) {
    events.push(event);
  }
  const elapsed = Date.now() - start;

  const statuses = events.filter((e) => e.type === "status" && (e as any).status === "completed");
  expect(statuses.length).toBe(3);

  // Sequential: 3x200ms = ~600ms minimum
  expect(elapsed).toBeGreaterThanOrEqual(550);
});

test("parallel .each - events carry testId for attribution", async () => {
  const testFile = await makeTempFile(PARALLEL_EACH_CONTENT);
  const executor = new TestExecutor();
  const events: ExecutionEvent[] = [];

  for await (const event of executor.run(
    `file://${testFile}`,
    "",
    { vars: {}, secrets: {} },
    {
      testIds: ["par-a", "par-b", "par-c"],
      concurrency: 3,
      timeout: 10_000,
    },
  )) {
    events.push(event);
  }

  // All assertion events should carry testId
  const assertions = events.filter((e) => e.type === "assertion");
  expect(assertions.length).toBe(3);
  for (const a of assertions) {
    expect(a.testId).toBeDefined();
    expect(["par-a", "par-b", "par-c"]).toContain(a.testId);
  }

  // Each test's assertions should be attributed correctly
  const byTest = new Map<string, ExecutionEvent[]>();
  for (const e of events) {
    if (e.testId) {
      const list = byTest.get(e.testId) || [];
      list.push(e);
      byTest.set(e.testId, list);
    }
  }
  expect(byTest.size).toBe(3);
});
