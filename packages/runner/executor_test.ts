import { assertEquals, assertExists } from "@std/assert";
import { TestExecutor } from "./executor.ts";
import type { ExecutionEvent, TimelineEvent } from "./executor.ts";

// Helper to filter assertions from events
function getAssertions(events: TimelineEvent[]) {
  return events.filter(
    (e): e is Extract<TimelineEvent, { type: "assertion" }> =>
      e.type === "assertion"
  );
}

// Helper to filter traces from events
function getTraces(events: TimelineEvent[]) {
  return events.filter(
    (e): e is Extract<TimelineEvent, { type: "trace" }> => e.type === "trace"
  );
}

// Create a simple test file for testing
const TEST_FILE_CONTENT = `
import { test } from "@glubean/sdk";

export const passingTest = test(
  { id: "passing", name: "Passing Test", tags: ["unit"] },
  async (ctx) => {
    ctx.log("Hello from test");
    ctx.assert(true, "Should pass");
  }
);

export const failingTest = test(
  { id: "failing", name: "Failing Test" },
  async (ctx) => {
    ctx.assert(false, "Should fail", { actual: "bad", expected: "good" });
  }
);

export const tracingTest = test(
  { id: "tracing", name: "Tracing Test" },
  async (ctx) => {
    ctx.trace({ method: "GET", url: "https://example.com", status: 200, duration: 50 });
    ctx.assert(true, "Traced successfully");
  }
);

export const warningTest = test(
  { id: "warning", name: "Warning Test" },
  async (ctx) => {
    ctx.warn(true, "This should be fine");
    ctx.warn(false, "Performance is slow");
    ctx.warn(false, "Missing cache header");
    ctx.assert(true, "Test still passes");
  }
);

export const warningOnlyTest = test(
  { id: "warning-only", name: "Warning Only Test" },
  async (ctx) => {
    ctx.warn(false, "All warnings, no assertions");
    ctx.warn(false, "Another warning");
  }
);
`;

async function createTempTestFile(): Promise<string> {
  const tempDir = await Deno.makeTempDir();
  const testFile = `${tempDir}/test.ts`;
  await Deno.writeTextFile(testFile, TEST_FILE_CONTENT);
  return testFile;
}

Deno.test("TestExecutor - executes passing test", async () => {
  const testFile = await createTempTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(`file://${testFile}`, "passingTest", {
    vars: {},
    secrets: {},
  });

  assertEquals(result.success, true);
  assertEquals(result.testId, "passingTest");
  assertExists(result.testName);
  const assertions = getAssertions(result.events);
  assertEquals(assertions.length, 1);
  assertEquals(assertions[0].passed, true);

  // Cleanup
  await Deno.remove(testFile);
});

Deno.test("TestExecutor - executes failing test", async () => {
  const testFile = await createTempTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(`file://${testFile}`, "failingTest", {
    vars: {},
    secrets: {},
  });

  // Test completes but has failed assertion
  const assertions = getAssertions(result.events);
  assertEquals(assertions.length, 1);
  assertEquals(assertions[0].passed, false);
  assertEquals(assertions[0].message, "Should fail");
  assertEquals(assertions[0].actual, "bad");
  assertEquals(assertions[0].expected, "good");

  // Cleanup
  await Deno.remove(testFile);
});

Deno.test("TestExecutor - captures traces", async () => {
  const testFile = await createTempTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(`file://${testFile}`, "tracingTest", {
    vars: {},
    secrets: {},
  });

  const traces = getTraces(result.events);
  assertEquals(traces.length, 1);
  assertEquals(traces[0].data.method, "GET");
  assertEquals(traces[0].data.url, "https://example.com");
  assertEquals(traces[0].data.status, 200);
  assertEquals(traces[0].data.duration, 50);

  // Cleanup
  await Deno.remove(testFile);
});

Deno.test("TestExecutor - streaming run yields events", async () => {
  const testFile = await createTempTestFile();
  const executor = new TestExecutor();

  const events: ExecutionEvent[] = [];
  for await (const event of executor.run(`file://${testFile}`, "passingTest", {
    vars: {},
    secrets: {},
  })) {
    events.push(event);
  }

  // Should have: log (loading), start, log (hello), assertion, status
  const eventTypes = events.map((e) => e.type);
  assertEquals(eventTypes.includes("start"), true);
  assertEquals(eventTypes.includes("assertion"), true);
  assertEquals(eventTypes.includes("status"), true);

  // Cleanup
  await Deno.remove(testFile);
});

Deno.test("TestExecutor - handles missing test", async () => {
  const testFile = await createTempTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "nonExistentTest",
    { vars: {}, secrets: {} }
  );

  assertEquals(result.success, false);
  assertExists(result.error);
  assertEquals(result.error?.includes("not found"), true);

  // Cleanup
  await Deno.remove(testFile);
});

Deno.test("TestExecutor - passes vars to context", async () => {
  const tempDir = await Deno.makeTempDir();
  const testFile = `${tempDir}/vars_test.ts`;
  await Deno.writeTextFile(
    testFile,
    `
import { test } from "@glubean/sdk";

export const varsTest = test(
  { id: "vars" },
  async (ctx) => {
    ctx.assert(ctx.vars.require("BASE_URL") === "https://api.test.com", "BASE_URL matches");
    ctx.assert(ctx.vars.require("ENV") === "test", "ENV matches");
  }
);
`
  );

  const executor = new TestExecutor();
  const result = await executor.execute(`file://${testFile}`, "varsTest", {
    vars: { BASE_URL: "https://api.test.com", ENV: "test" },
    secrets: {},
  });

  assertEquals(result.success, true);
  const assertions = getAssertions(result.events);
  assertEquals(
    assertions.every((a) => a.passed),
    true
  );

  // Cleanup
  await Deno.remove(testFile);
});

Deno.test("TestExecutor - onEvent callback streams events", async () => {
  const testFile = await createTempTestFile();
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
    }
  );

  assertEquals(result.success, true);
  // Streamed events should match result.events
  assertEquals(streamedEvents.length, result.events.length);
  assertEquals(
    streamedEvents.map((e) => e.type),
    result.events.map((e) => e.type)
  );

  // Cleanup
  await Deno.remove(testFile);
});

Deno.test("TestExecutor - async onEvent callback is awaited", async () => {
  const testFile = await createTempTestFile();
  const executor = new TestExecutor();

  const order: string[] = [];
  const result = await executor.execute(
    `file://${testFile}`,
    "passingTest",
    { vars: {}, secrets: {} },
    {
      onEvent: async (event) => {
        // Simulate async operation
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(`callback:${event.type}`);
      },
    }
  );

  assertEquals(result.success, true);
  // All callbacks should have completed (in order)
  assertEquals(order.length, result.events.length);

  // Cleanup
  await Deno.remove(testFile);
});

Deno.test(
  "TestExecutor - executeMany includes testId in streamed events",
  async () => {
    const testFile = await createTempTestFile();
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
      }
    );

    assertEquals(batchResult.success, true);
    assertEquals(batchResult.results.length, 2);

    // All streamed events should have testId
    for (const event of streamedEvents) {
      assertExists(event.testId, `Event ${event.type} should have testId`);
      assertEquals(
        ["passingTest", "tracingTest"].includes(event.testId),
        true,
        `testId should be one of the executed tests`
      );
    }

    // Verify we have events from both tests
    const testIds = new Set(streamedEvents.map((e) => e.testId));
    assertEquals(testIds.size, 2, "Should have events from both tests");

    // Cleanup
    await Deno.remove(testFile);
  }
);

// ---------------------------------------------------------------------------
// ctx.fail tests
// ---------------------------------------------------------------------------

const FAIL_TEST_CONTENT = `
import { test } from "@glubean/sdk";

export const failTest = test("fail-test", async (ctx) => {
  ctx.log("before fail");
  ctx.fail("Something went wrong");
  ctx.log("after fail — should never reach here");
});

export const failInTryCatch = test("fail-try-catch", async (ctx) => {
  try {
    await Promise.resolve(); // simulate async work
    ctx.fail("Expected error but succeeded");
  } catch {
    // ctx.fail throws, so this catch will fire
    ctx.log("caught fail error");
  }
  ctx.assert(true, "continued after caught fail");
});
`;

async function createFailTestFile(): Promise<string> {
  const tempDir = await Deno.makeTempDir();
  const testFile = `${tempDir}/fail_test.ts`;
  await Deno.writeTextFile(testFile, FAIL_TEST_CONTENT);
  return testFile;
}

Deno.test("ctx.fail - immediately aborts test with failure", async () => {
  const testFile = await createFailTestFile();
  const executor = new TestExecutor();
  const result = await executor.execute(`file://${testFile}`, "failTest", {
    vars: {},
    secrets: {},
  });

  // Test should fail
  assertEquals(result.success, false, "Test with ctx.fail should fail");

  // Should have a failed assertion event with the fail message
  const assertions = getAssertions(result.events);
  const failAssertion = assertions.find(
    (a) => a.message === "Something went wrong" && a.passed === false
  );
  assertExists(failAssertion, "Should have a failed assertion from ctx.fail");

  // Should have "before fail" log but NOT "after fail" log
  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log"
  );
  const logMessages = logs.map((l) => l.message);
  assertEquals(
    logMessages.some((m) => m.includes("before fail")),
    true,
    "Should have log before fail"
  );
  assertEquals(
    logMessages.some((m) => m.includes("after fail")),
    false,
    "Should NOT have log after fail — execution should have stopped"
  );

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("ctx.fail - can be caught in try/catch (user choice)", async () => {
  const testFile = await createFailTestFile();
  const executor = new TestExecutor();
  const result = await executor.execute(
    `file://${testFile}`,
    "failInTryCatch",
    { vars: {}, secrets: {} }
  );

  // Test should pass because the fail was caught by user's try/catch
  assertEquals(
    result.success,
    true,
    `Test should pass when ctx.fail is caught. Events: ${JSON.stringify(
      result.events
    )}`
  );

  // Should have the assertion from after the catch
  const assertions = getAssertions(result.events);
  const passedAssertion = assertions.find(
    (a) => a.message === "continued after caught fail" && a.passed === true
  );
  assertExists(
    passedAssertion,
    "Should have passed assertion after caught fail"
  );

  await Deno.remove(testFile, { recursive: true });
});

// ---------------------------------------------------------------------------
// ctx.pollUntil tests
// ---------------------------------------------------------------------------

const POLL_TEST_CONTENT = `
import { test } from "@glubean/sdk";

let callCount = 0;

export const pollSuccess = test("poll-success", async (ctx) => {
  callCount = 0;
  await ctx.pollUntil({ timeoutMs: 5000, intervalMs: 100 }, async () => {
    callCount++;
    return callCount >= 3; // succeeds on 3rd call
  });
  ctx.assert(callCount >= 3, "Should have polled at least 3 times");
  ctx.log("poll succeeded");
});

export const pollTimeout = test("poll-timeout", async (ctx) => {
  await ctx.pollUntil({ timeoutMs: 300, intervalMs: 100 }, async () => {
    return false; // never succeeds
  });
  ctx.log("should not reach here");
});

export const pollSilentTimeout = test("poll-silent-timeout", async (ctx) => {
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

export const pollErrorRetry = test("poll-error-retry", async (ctx) => {
  let attempts = 0;
  await ctx.pollUntil({ timeoutMs: 5000, intervalMs: 100 }, async () => {
    attempts++;
    if (attempts < 3) throw new Error("not ready yet");
    return true; // succeeds on 3rd attempt
  });
  ctx.assert(attempts >= 3, "Should have retried through errors");
  ctx.log("recovered from errors");
});

export const pollTimeoutWithError = test("poll-timeout-with-error", async (ctx) => {
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

async function createPollTestFile(): Promise<string> {
  const tempDir = await Deno.makeTempDir();
  const testFile = `${tempDir}/poll_test.ts`;
  await Deno.writeTextFile(testFile, POLL_TEST_CONTENT);
  return testFile;
}

Deno.test("ctx.pollUntil - succeeds after multiple polls", async () => {
  const testFile = await createPollTestFile();
  const executor = new TestExecutor();
  const result = await executor.execute(`file://${testFile}`, "pollSuccess", {
    vars: {},
    secrets: {},
  });

  assertEquals(
    result.success,
    true,
    `Should pass: ${JSON.stringify(result.events)}`
  );

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log"
  );
  assertEquals(
    logs.some((l) => l.message.includes("poll succeeded")),
    true
  );

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("ctx.pollUntil - throws on timeout (default)", async () => {
  const testFile = await createPollTestFile();
  const executor = new TestExecutor();
  const result = await executor.execute(`file://${testFile}`, "pollTimeout", {
    vars: {},
    secrets: {},
  });

  assertEquals(result.success, false, "Should fail on timeout");

  // "should not reach here" log should NOT exist
  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log"
  );
  assertEquals(
    logs.some((l) => l.message.includes("should not reach here")),
    false,
    "Should not continue after timeout throw"
  );

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("ctx.pollUntil - silent timeout with onTimeout", async () => {
  const testFile = await createPollTestFile();
  const executor = new TestExecutor();
  const result = await executor.execute(
    `file://${testFile}`,
    "pollSilentTimeout",
    { vars: {}, secrets: {} }
  );

  assertEquals(
    result.success,
    true,
    `Should pass: ${JSON.stringify(result.events)}`
  );

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log"
  );
  assertEquals(
    logs.some((l) => l.message.includes("continued after silent timeout")),
    true,
    "Should continue after silent timeout"
  );

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("ctx.pollUntil - retries through errors", async () => {
  const testFile = await createPollTestFile();
  const executor = new TestExecutor();
  const result = await executor.execute(
    `file://${testFile}`,
    "pollErrorRetry",
    { vars: {}, secrets: {} }
  );

  assertEquals(
    result.success,
    true,
    `Should pass: ${JSON.stringify(result.events)}`
  );

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log"
  );
  assertEquals(
    logs.some((l) => l.message.includes("recovered from errors")),
    true
  );

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("ctx.pollUntil - onTimeout receives last error", async () => {
  const testFile = await createPollTestFile();
  const executor = new TestExecutor();
  const result = await executor.execute(
    `file://${testFile}`,
    "pollTimeoutWithError",
    { vars: {}, secrets: {} }
  );

  assertEquals(
    result.success,
    true,
    `Should pass: ${JSON.stringify(result.events)}`
  );

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log"
  );
  assertEquals(
    logs.some((l) => l.message.includes("got last error in onTimeout")),
    true
  );

  await Deno.remove(testFile, { recursive: true });
});

// =============================================================================
// Auto-build (no .build()) tests
// =============================================================================

const AUTO_BUILD_TEST_CONTENT = `
import { test } from "@glubean/sdk";

// No .build() — runner should auto-detect the builder and build it
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

// Explicit .build() — backward compatible
export const explicitTest = test("explicit-build-test")
  .step("check", async (ctx) => {
    ctx.log("explicit build works");
    ctx.assert(true, "always passes");
  })
  .build();

// Step that fails via assert (no throw)
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

// Step that fails via throw
export const stepThrowFail = test("step-throw-fail")
  .step("boom", async () => {
    throw new Error("step exploded");
  })
  .step("after boom", async (ctx) => {
    ctx.log("should not run");
  });

// All steps pass
export const stepsAllPass = test("steps-all-pass")
  .step("step A", async (ctx) => {
    ctx.assert(true, "A passes");
  })
  .step("step B", async (ctx) => {
    ctx.assert(true, "B passes");
  });
`;

async function createAutoBuildTestFile(): Promise<string> {
  const tempDir = await Deno.makeTempDir();
  const testFile = `${tempDir}/auto_build_test.ts`;
  await Deno.writeTextFile(testFile, AUTO_BUILD_TEST_CONTENT);
  return testFile;
}

Deno.test("builder without .build() is auto-resolved by runner", async () => {
  const testFile = await createAutoBuildTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "auto-build-test",
    { vars: {}, secrets: {} }
  );

  assertEquals(
    result.success,
    true,
    `Should pass: ${JSON.stringify(result.events)}`
  );
  assertEquals(result.testId, "auto-build-test");

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log"
  );
  assertEquals(
    logs.some((l) => l.message.includes("step one executed")),
    true,
    "step one should have run"
  );
  assertEquals(
    logs.some((l) => l.message.includes("step two got 42")),
    true,
    "step two should have received state from step one"
  );

  const assertions = getAssertions(result.events);
  assertEquals(assertions.length, 1);
  assertEquals(assertions[0].passed, true);

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("builder with .build() still works as before", async () => {
  const testFile = await createAutoBuildTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "explicit-build-test",
    { vars: {}, secrets: {} }
  );

  assertEquals(
    result.success,
    true,
    `Should pass: ${JSON.stringify(result.events)}`
  );
  assertEquals(result.testId, "explicit-build-test");

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log"
  );
  assertEquals(
    logs.some((l) => l.message.includes("explicit build works")),
    true
  );

  await Deno.remove(testFile, { recursive: true });
});

// =============================================================================
// Step event tests — duration, pass/fail/skip, assertion counting
// =============================================================================

function getStepStarts(events: TimelineEvent[]) {
  return events.filter(
    (e): e is Extract<TimelineEvent, { type: "step_start" }> =>
      e.type === "step_start"
  );
}

function getStepEnds(events: TimelineEvent[]) {
  return events.filter(
    (e): e is Extract<TimelineEvent, { type: "step_end" }> =>
      e.type === "step_end"
  );
}

Deno.test("step events - all passing steps emit correct events", async () => {
  const testFile = await createAutoBuildTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "steps-all-pass",
    { vars: {}, secrets: {} }
  );

  assertEquals(
    result.success,
    true,
    `Should pass: ${JSON.stringify(result.events)}`
  );

  const starts = getStepStarts(result.events);
  const ends = getStepEnds(result.events);

  assertEquals(starts.length, 2, "Should have 2 step_start events");
  assertEquals(ends.length, 2, "Should have 2 step_end events");

  // step_start events
  assertEquals(starts[0].name, "step A");
  assertEquals(starts[0].index, 0);
  assertEquals(starts[0].total, 2);
  assertEquals(starts[1].name, "step B");
  assertEquals(starts[1].index, 1);

  // step_end events
  assertEquals(ends[0].status, "passed");
  assertEquals(ends[0].name, "step A");
  assertEquals(typeof ends[0].durationMs, "number");
  assertEquals(ends[0].assertions, 1);
  assertEquals(ends[0].failedAssertions, 0);

  assertEquals(ends[1].status, "passed");
  assertEquals(ends[1].name, "step B");

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("step events - failed assertion stops subsequent steps", async () => {
  const testFile = await createAutoBuildTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "step-assert-fail",
    { vars: {}, secrets: {} }
  );

  assertEquals(result.success, false, "Test with failed step should fail");

  const ends = getStepEnds(result.events);
  assertEquals(
    ends.length,
    3,
    "Should have 3 step_end events (pass, fail, skip)"
  );

  // Step 0: passed
  assertEquals(ends[0].name, "passing step");
  assertEquals(ends[0].status, "passed");
  assertEquals(ends[0].assertions, 1);
  assertEquals(ends[0].failedAssertions, 0);

  // Step 1: failed (2 failed assertions, no throw)
  assertEquals(ends[1].name, "failing step");
  assertEquals(ends[1].status, "failed");
  assertEquals(ends[1].assertions, 2);
  assertEquals(ends[1].failedAssertions, 2);
  assertEquals(ends[1].error, undefined);

  // Step 2: skipped
  assertEquals(ends[2].name, "should be skipped");
  assertEquals(ends[2].status, "skipped");
  assertEquals(ends[2].durationMs, 0);

  // The skipped step's log should NOT appear
  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log"
  );
  assertEquals(
    logs.some((l) => l.message.includes("this should never run")),
    false,
    "Skipped step should not execute"
  );

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("step events - thrown error stops subsequent steps", async () => {
  const testFile = await createAutoBuildTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "step-throw-fail",
    { vars: {}, secrets: {} }
  );

  assertEquals(result.success, false, "Test with thrown step should fail");

  const ends = getStepEnds(result.events);
  assertEquals(ends.length, 2, "Should have 2 step_end events (fail + skip)");

  // Step 0: failed with error
  assertEquals(ends[0].name, "boom");
  assertEquals(ends[0].status, "failed");
  assertEquals(ends[0].error, "step exploded");

  // Step 1: skipped
  assertEquals(ends[1].name, "after boom");
  assertEquals(ends[1].status, "skipped");

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("step events - duration is measured", async () => {
  const testFile = await createAutoBuildTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "steps-all-pass",
    { vars: {}, secrets: {} }
  );

  const ends = getStepEnds(result.events);
  for (const e of ends) {
    assertEquals(
      typeof e.durationMs,
      "number",
      "durationMs should be a number"
    );
    assertEquals(e.durationMs >= 0, true, "durationMs should be non-negative");
  }

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("step events - step_start and step_end have timestamps", async () => {
  const testFile = await createAutoBuildTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "steps-all-pass",
    { vars: {}, secrets: {} }
  );

  const starts = getStepStarts(result.events);
  const ends = getStepEnds(result.events);

  for (const s of starts) {
    assertEquals(typeof s.ts, "number", "step_start should have ts");
  }
  for (const e of ends) {
    assertEquals(typeof e.ts, "number", "step_end should have ts");
  }

  // step_end.ts should be >= step_start.ts for same index
  assertEquals(ends[0].ts >= starts[0].ts, true);
  assertEquals(ends[1].ts >= starts[1].ts, true);

  await Deno.remove(testFile, { recursive: true });
});

// =============================================================================
// stepIndex on events within steps
// =============================================================================

Deno.test("stepIndex - assertions within steps have stepIndex", async () => {
  const testFile = await createAutoBuildTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "steps-all-pass",
    { vars: {}, secrets: {} }
  );

  assertEquals(result.success, true);

  const assertions = getAssertions(result.events);
  assertEquals(assertions.length, 2);
  assertEquals(
    assertions[0].stepIndex,
    0,
    "First assertion should have stepIndex 0"
  );
  assertEquals(
    assertions[1].stepIndex,
    1,
    "Second assertion should have stepIndex 1"
  );

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("stepIndex - logs within steps have stepIndex", async () => {
  const testFile = await createAutoBuildTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "auto-build-test",
    { vars: {}, secrets: {} }
  );

  assertEquals(result.success, true);

  const logs = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log"
  );

  // "step one executed" and "step two got 42" should have stepIndex
  const stepOnLog = logs.find((l) => l.message.includes("step one executed"));
  const stepTwoLog = logs.find((l) => l.message.includes("step two got 42"));
  assertExists(stepOnLog);
  assertExists(stepTwoLog);
  assertEquals(stepOnLog.stepIndex, 0, "Step one log should have stepIndex 0");
  assertEquals(stepTwoLog.stepIndex, 1, "Step two log should have stepIndex 1");

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("stepIndex - events outside steps have no stepIndex", async () => {
  const testFile = await createTempTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(`file://${testFile}`, "passingTest", {
    vars: {},
    secrets: {},
  });

  // Simple test (no steps) — assertions should NOT have stepIndex
  const assertions = getAssertions(result.events);
  assertEquals(assertions.length, 1);
  assertEquals(
    assertions[0].stepIndex,
    undefined,
    "Non-step assertion should have no stepIndex"
  );

  await Deno.remove(testFile);
});

// =============================================================================
// assertionCount / failedAssertionCount on ExecutionResult
// =============================================================================

Deno.test(
  "ExecutionResult - assertionCount and failedAssertionCount",
  async () => {
    const testFile = await createTempTestFile();
    const executor = new TestExecutor();

    // Passing test: 1 assertion, 0 failed
    const passing = await executor.execute(
      `file://${testFile}`,
      "passingTest",
      {
        vars: {},
        secrets: {},
      }
    );
    assertEquals(passing.assertionCount, 1);
    assertEquals(passing.failedAssertionCount, 0);

    // Failing test: 1 assertion, 1 failed
    const failing = await executor.execute(
      `file://${testFile}`,
      "failingTest",
      {
        vars: {},
        secrets: {},
      }
    );
    assertEquals(failing.assertionCount, 1);
    assertEquals(failing.failedAssertionCount, 1);

    await Deno.remove(testFile);
  }
);

Deno.test("ExecutionResult - assertionCount with multi-step test", async () => {
  const testFile = await createAutoBuildTestFile();
  const executor = new TestExecutor();

  // step-assert-fail: step 0 has 1 pass, step 1 has 2 fails, step 2 skipped
  const result = await executor.execute(
    `file://${testFile}`,
    "step-assert-fail",
    { vars: {}, secrets: {} }
  );
  assertEquals(
    result.assertionCount,
    3,
    "Should count all assertions across steps"
  );
  assertEquals(
    result.failedAssertionCount,
    2,
    "Should count all failures across steps"
  );

  await Deno.remove(testFile, { recursive: true });
});

// =============================================================================
// summary event enrichment
// =============================================================================

Deno.test("summary event - includes assertion and step counts", async () => {
  const testFile = await createAutoBuildTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "steps-all-pass",
    { vars: {}, secrets: {} }
  );

  const summaries = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "summary" }> =>
      e.type === "summary"
  );
  assertEquals(summaries.length, 1, "Should have exactly one summary event");

  const summary = summaries[0];
  assertEquals(summary.data.assertionTotal, 2);
  assertEquals(summary.data.assertionFailed, 0);
  assertEquals(summary.data.stepTotal, 2);
  assertEquals(summary.data.stepPassed, 2);
  assertEquals(summary.data.stepFailed, 0);
  assertEquals(summary.data.stepSkipped, 0);

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("summary event - step failure counts", async () => {
  const testFile = await createAutoBuildTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "step-assert-fail",
    { vars: {}, secrets: {} }
  );

  const summaries = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "summary" }> =>
      e.type === "summary"
  );
  assertEquals(summaries.length, 1);

  const summary = summaries[0];
  assertEquals(summary.data.stepTotal, 3);
  assertEquals(summary.data.stepPassed, 1);
  assertEquals(summary.data.stepFailed, 1);
  assertEquals(summary.data.stepSkipped, 1);
  assertEquals(summary.data.assertionTotal, 3);
  assertEquals(summary.data.assertionFailed, 2);

  await Deno.remove(testFile, { recursive: true });
});

// =============================================================================
// ctx.warn — warning events
// =============================================================================

function getWarnings(events: TimelineEvent[]) {
  return events.filter(
    (e): e is Extract<TimelineEvent, { type: "warning" }> =>
      e.type === "warning"
  );
}

Deno.test(
  "ctx.warn - emits warning events without failing the test",
  async () => {
    const testFile = await createTempTestFile();
    const executor = new TestExecutor();

    const result = await executor.execute(`file://${testFile}`, "warningTest", {
      vars: {},
      secrets: {},
    });

    // Test should still pass despite warnings
    assertEquals(result.success, true);

    const warnings = getWarnings(result.events);
    assertEquals(warnings.length, 3);

    // First warning: condition=true (OK)
    assertEquals(warnings[0].condition, true);
    assertEquals(warnings[0].message, "This should be fine");

    // Second warning: condition=false (triggered)
    assertEquals(warnings[1].condition, false);
    assertEquals(warnings[1].message, "Performance is slow");

    // Third warning: condition=false (triggered)
    assertEquals(warnings[2].condition, false);
    assertEquals(warnings[2].message, "Missing cache header");

    // Assertions should still be present and passing
    const assertions = getAssertions(result.events);
    assertEquals(assertions.length, 1);
    assertEquals(assertions[0].passed, true);

    await Deno.remove(testFile);
  }
);

Deno.test("ctx.warn - warning-only test still passes", async () => {
  const testFile = await createTempTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "warningOnlyTest",
    { vars: {}, secrets: {} }
  );

  // Test should pass even with only triggered warnings
  assertEquals(result.success, true);

  const warnings = getWarnings(result.events);
  assertEquals(warnings.length, 2);
  assertEquals(warnings[0].condition, false);
  assertEquals(warnings[1].condition, false);

  // No assertions in this test
  const assertions = getAssertions(result.events);
  assertEquals(assertions.length, 0);

  await Deno.remove(testFile);
});

Deno.test("ctx.warn - summary includes warning counters", async () => {
  const testFile = await createTempTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(`file://${testFile}`, "warningTest", {
    vars: {},
    secrets: {},
  });

  const summaries = result.events.filter(
    (e): e is Extract<TimelineEvent, { type: "summary" }> =>
      e.type === "summary"
  );
  assertEquals(summaries.length, 1);

  const summary = summaries[0];
  assertEquals(summary.data.warningTotal, 3);
  assertEquals(summary.data.warningTriggered, 2);

  await Deno.remove(testFile);
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

// severity: "error" (default) — valid data
export const validatePassTest = test(
  { id: "validate-pass", name: "Validate Pass" },
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

// severity: "error" — invalid data (test should fail)
export const validateErrorTest = test(
  { id: "validate-error", name: "Validate Error" },
  async (ctx) => {
    const user = ctx.validate(
      { id: "not-a-number", name: 42, email: "bad" },
      UserSchema,
      "user object",
    );
    ctx.assert(user === undefined, "Should return undefined on failure");
  },
);

// severity: "warn" — invalid data but test still passes
export const validateWarnTest = test(
  { id: "validate-warn", name: "Validate Warn" },
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

// severity: "fatal" — invalid data aborts test
export const validateFatalTest = test(
  { id: "validate-fatal", name: "Validate Fatal" },
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

// parse fallback (schema without safeParse)
export const validateParseFallbackTest = test(
  { id: "validate-parse-fallback", name: "Validate Parse Fallback" },
  async (ctx) => {
    // A minimal schema that only has .parse()
    const parseOnlySchema = {
      parse(data) {
        if (typeof data === "string") return data.toUpperCase();
        throw new Error("expected a string");
      },
    };
    const result = ctx.validate("hello", parseOnlySchema, "string data");
    ctx.assert(result === "HELLO", "Should return parsed (uppercased) value");

    // Failing parse
    const bad = ctx.validate(42, parseOnlySchema, "should-fail");
    ctx.assert(bad === undefined, "Should return undefined on parse failure");
  },
);
`;

async function createValidateTestFile(): Promise<string> {
  const tempDir = await Deno.makeTempDir();
  const testFile = `${tempDir}/validate_test.ts`;
  await Deno.writeTextFile(testFile, VALIDATE_TEST_CONTENT);
  return testFile;
}

function getSchemaValidations(events: TimelineEvent[]) {
  return events.filter(
    (e): e is Extract<TimelineEvent, { type: "schema_validation" }> =>
      e.type === "schema_validation"
  );
}

Deno.test(
  "ctx.validate - passes with valid data (severity: error)",
  async () => {
    const testFile = await createValidateTestFile();
    const executor = new TestExecutor();

    const result = await executor.execute(
      `file://${testFile}`,
      "validatePassTest",
      { vars: {}, secrets: {} }
    );

    assertEquals(result.success, true);

    const validations = getSchemaValidations(result.events);
    assertEquals(validations.length, 1);
    assertEquals(validations[0].success, true);
    assertEquals(validations[0].label, "user object");
    assertEquals(validations[0].severity, "error");

    await Deno.remove(testFile, { recursive: true });
  }
);

Deno.test(
  "ctx.validate - fails with invalid data (severity: error)",
  async () => {
    const testFile = await createValidateTestFile();
    const executor = new TestExecutor();

    const result = await executor.execute(
      `file://${testFile}`,
      "validateErrorTest",
      { vars: {}, secrets: {} }
    );

    // Test completes (soft assertions don't throw) but has failed assertions
    // success=true means the test fn ran to completion without throwing
    assertEquals(result.success, true);

    const validations = getSchemaValidations(result.events);
    assertEquals(validations.length, 1);
    assertEquals(validations[0].success, false);
    assertEquals(validations[0].severity, "error");
    assertExists(validations[0].issues);

    // Should have a failed assertion routed through ctx.assert
    const assertions = getAssertions(result.events);
    const failedAssertion = assertions.find((a) => !a.passed);
    assertExists(
      failedAssertion,
      "Should have a failed assertion from schema validation"
    );
    assertEquals(result.failedAssertionCount > 0, true);

    await Deno.remove(testFile, { recursive: true });
  }
);

Deno.test("ctx.validate - warn severity does not fail the test", async () => {
  const testFile = await createValidateTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "validateWarnTest",
    { vars: {}, secrets: {} }
  );

  // Test should pass even though schema validation failed (severity: warn)
  assertEquals(result.success, true);

  const validations = getSchemaValidations(result.events);
  assertEquals(validations.length, 1);
  assertEquals(validations[0].success, false);
  assertEquals(validations[0].severity, "warn");

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("ctx.validate - fatal severity aborts test", async () => {
  const testFile = await createValidateTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "validateFatalTest",
    { vars: {}, secrets: {} }
  );

  // Test should fail (fatal aborts)
  assertEquals(result.success, false);

  const validations = getSchemaValidations(result.events);
  assertEquals(validations.length, 1);
  assertEquals(validations[0].success, false);
  assertEquals(validations[0].severity, "fatal");

  // "after fatal" log should not appear
  const logs = result.events.filter(
    (e) =>
      e.type === "log" && "message" in e && e.message.includes("after fatal")
  );
  assertEquals(logs.length, 0, "Code after fatal should not execute");

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("ctx.validate - parse fallback (no safeParse)", async () => {
  const testFile = await createValidateTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "validateParseFallbackTest",
    { vars: {}, secrets: {} }
  );

  // Test completes (soft assertions don't throw) but has failed assertion from parse error
  assertEquals(result.success, true);
  assertEquals(result.failedAssertionCount > 0, true);

  const validations = getSchemaValidations(result.events);
  assertEquals(validations.length, 2);
  assertEquals(validations[0].success, true);
  assertEquals(validations[1].success, false);

  await Deno.remove(testFile, { recursive: true });
});

Deno.test(
  "ctx.validate - summary includes schema validation counters",
  async () => {
    const testFile = await createValidateTestFile();
    const executor = new TestExecutor();

    const result = await executor.execute(
      `file://${testFile}`,
      "validateWarnTest",
      { vars: {}, secrets: {} }
    );

    const summaries = result.events.filter(
      (e): e is Extract<TimelineEvent, { type: "summary" }> =>
        e.type === "summary"
    );
    assertEquals(summaries.length, 1);

    const summary = summaries[0];
    assertEquals(summary.data.schemaValidationTotal, 1);
    assertEquals(
      summary.data.schemaValidationFailed,
      0,
      "warn does not count as failed"
    );
    assertEquals(summary.data.schemaValidationWarnings, 1);

    await Deno.remove(testFile, { recursive: true });
  }
);

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

// Response schema validation (via .json())
export const httpResponseSchemaTest = test(
  { id: "http-response-schema", name: "HTTP Response Schema" },
  async (ctx) => {
    // Use httpbin-like endpoint that returns JSON
    const res = await ctx.http.get("https://httpbin.org/get", {
      schema: {
        response: ResponseSchema,
      },
    });
    // httpbin /get response won't match our schema, so this should fail
    try {
      await res.json();
    } catch {
      // ky might throw, that's ok
    }
    ctx.assert(true, "continued");
  },
);

// Query schema validation — valid params
export const httpQuerySchemaPassTest = test(
  { id: "http-query-schema-pass", name: "HTTP Query Schema Pass" },
  async (ctx) => {
    // We just need the validation to run; the actual request might fail
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

// Query schema validation — invalid params
export const httpQuerySchemaFailTest = test(
  { id: "http-query-schema-fail", name: "HTTP Query Schema Fail" },
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

// Request body schema validation
export const httpRequestSchemaTest = test(
  { id: "http-request-schema", name: "HTTP Request Schema" },
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

// Request body schema — invalid
export const httpRequestSchemaFailTest = test(
  { id: "http-request-schema-fail", name: "HTTP Request Schema Fail" },
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

// Schema with explicit severity
export const httpSchemaWithSeverityTest = test(
  { id: "http-schema-severity", name: "HTTP Schema With Severity" },
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

async function createHttpSchemaTestFile(): Promise<string> {
  const tempDir = await Deno.makeTempDir();
  const testFile = `${tempDir}/http_schema_test.ts`;
  await Deno.writeTextFile(testFile, HTTP_SCHEMA_TEST_CONTENT);
  return testFile;
}

Deno.test(
  "HTTP schema - query validation passes with valid params",
  async () => {
    const testFile = await createHttpSchemaTestFile();
    const executor = new TestExecutor();

    const result = await executor.execute(
      `file://${testFile}`,
      "httpQuerySchemaPassTest",
      { vars: {}, secrets: {} }
    );

    const validations = getSchemaValidations(result.events);
    // Should have at least 1 schema_validation event for query params
    assertEquals(
      validations.length >= 1,
      true,
      `Expected at least 1 validation, got ${validations.length}`
    );
    const queryValidation = validations.find((v) => v.label === "query params");
    assertExists(queryValidation, "Should have query params validation");
    assertEquals(queryValidation.success, true);

    await Deno.remove(testFile, { recursive: true });
  }
);

Deno.test(
  "HTTP schema - query validation fails with invalid params",
  async () => {
    const testFile = await createHttpSchemaTestFile();
    const executor = new TestExecutor();

    const result = await executor.execute(
      `file://${testFile}`,
      "httpQuerySchemaFailTest",
      { vars: {}, secrets: {} }
    );

    // Test completes (soft) but has failed assertions from schema validation
    assertEquals(result.success, true);
    assertEquals(result.failedAssertionCount > 0, true);

    const validations = getSchemaValidations(result.events);
    const queryValidation = validations.find((v) => v.label === "query params");
    assertExists(queryValidation);
    assertEquals(queryValidation.success, false);

    await Deno.remove(testFile, { recursive: true });
  }
);

Deno.test("HTTP schema - request body validation passes", async () => {
  const testFile = await createHttpSchemaTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "httpRequestSchemaTest",
    { vars: {}, secrets: {} }
  );

  const validations = getSchemaValidations(result.events);
  const bodyValidation = validations.find((v) => v.label === "request body");
  assertExists(bodyValidation, "Should have request body validation");
  assertEquals(bodyValidation.success, true);

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("HTTP schema - request body validation fails", async () => {
  const testFile = await createHttpSchemaTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "httpRequestSchemaFailTest",
    { vars: {}, secrets: {} }
  );

  // Test completes (soft) but has failed assertions
  assertEquals(result.success, true);
  assertEquals(result.failedAssertionCount > 0, true);

  const validations = getSchemaValidations(result.events);
  const bodyValidation = validations.find((v) => v.label === "request body");
  assertExists(bodyValidation);
  assertEquals(bodyValidation.success, false);

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("HTTP schema - severity: warn does not fail test", async () => {
  const testFile = await createHttpSchemaTestFile();
  const executor = new TestExecutor();

  const result = await executor.execute(
    `file://${testFile}`,
    "httpSchemaWithSeverityTest",
    { vars: {}, secrets: {} }
  );

  // Test should pass because severity is "warn"
  assertEquals(result.success, true);

  const validations = getSchemaValidations(result.events);
  const queryValidation = validations.find((v) => v.label === "query params");
  assertExists(queryValidation);
  assertEquals(queryValidation.success, false);
  assertEquals(queryValidation.severity, "warn");

  await Deno.remove(testFile, { recursive: true });
});

// =============================================================================
// Fail-fast / failAfter (Phase 5)
// =============================================================================

const FAILFAST_TEST_CONTENT = `
import { test } from "@glubean/sdk";

export const test1 = test(
  { id: "test-1", name: "Test 1 — passes" },
  async (ctx) => {
    ctx.assert(true, "test1 passes");
  },
);

export const test2 = test(
  { id: "test-2", name: "Test 2 — fails" },
  async (ctx) => {
    ctx.fail("test2 intentional failure");
  },
);

export const test3 = test(
  { id: "test-3", name: "Test 3 — passes" },
  async (ctx) => {
    ctx.assert(true, "test3 passes");
  },
);

export const test4 = test(
  { id: "test-4", name: "Test 4 — fails" },
  async (ctx) => {
    ctx.fail("test4 intentional failure");
  },
);

export const test5 = test(
  { id: "test-5", name: "Test 5 — passes" },
  async (ctx) => {
    ctx.assert(true, "test5 passes");
  },
);
`;

async function createFailFastTestFile(): Promise<string> {
  const tempDir = await Deno.makeTempDir();
  const testFile = `${tempDir}/failfast_test.ts`;
  await Deno.writeTextFile(testFile, FAILFAST_TEST_CONTENT);
  return testFile;
}

Deno.test("executeMany - stopOnFailure stops after first failure", async () => {
  const testFile = await createFailFastTestFile();
  const executor = new TestExecutor();

  const batch = await executor.executeMany(
    `file://${testFile}`,
    ["test1", "test2", "test3", "test4", "test5"],
    { vars: {}, secrets: {} },
    { stopOnFailure: true }
  );

  assertEquals(batch.success, false);
  assertEquals(batch.failedCount, 1);
  // test1 passes, test2 fails → stop. test3/test4/test5 skipped.
  assertEquals(batch.results.length, 2);
  assertEquals(batch.skippedCount, 3);
  assertEquals(batch.results[0].success, true);
  assertEquals(batch.results[1].success, false);

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("executeMany - failAfter:2 stops after 2 failures", async () => {
  const testFile = await createFailFastTestFile();
  const executor = new TestExecutor();

  const batch = await executor.executeMany(
    `file://${testFile}`,
    ["test1", "test2", "test3", "test4", "test5"],
    { vars: {}, secrets: {} },
    { failAfter: 2 }
  );

  assertEquals(batch.success, false);
  assertEquals(batch.failedCount, 2);
  // test1 passes, test2 fails (1), test3 passes, test4 fails (2) → stop. test5 skipped.
  assertEquals(batch.results.length, 4);
  assertEquals(batch.skippedCount, 1);

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("executeMany - no failAfter runs all tests", async () => {
  const testFile = await createFailFastTestFile();
  const executor = new TestExecutor();

  const batch = await executor.executeMany(
    `file://${testFile}`,
    ["test1", "test2", "test3", "test4", "test5"],
    { vars: {}, secrets: {} }
  );

  assertEquals(batch.success, false);
  assertEquals(batch.failedCount, 2);
  // All 5 tests run
  assertEquals(batch.results.length, 5);
  assertEquals(batch.skippedCount, 0);

  await Deno.remove(testFile, { recursive: true });
});

Deno.test("executeMany - failAfter:1 is same as stopOnFailure", async () => {
  const testFile = await createFailFastTestFile();
  const executor = new TestExecutor();

  const batch = await executor.executeMany(
    `file://${testFile}`,
    ["test1", "test2", "test3", "test4", "test5"],
    { vars: {}, secrets: {} },
    { failAfter: 1 }
  );

  assertEquals(batch.success, false);
  assertEquals(batch.failedCount, 1);
  assertEquals(batch.results.length, 2);
  assertEquals(batch.skippedCount, 3);

  await Deno.remove(testFile, { recursive: true });
});
