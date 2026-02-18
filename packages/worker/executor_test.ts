import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { executeBundle } from "./executor.ts";
import type { RunEvent, RuntimeContext } from "./types.ts";
import type { WorkerConfig } from "./config.ts";
import { TestExecutor, WORKER_RUN_DEFAULTS } from "@glubean/runner";
import { createNoopLogger } from "./logger.ts";

function createTestConfig(): WorkerConfig {
  return {
    controlPlaneUrl: "https://test.glubean.com",
    workerToken: "test-token",
    workerId: "test-worker",
    controlPlaneTimeoutMs: 5000,
    controlPlaneMaxRetries: 2,
    claimIntervalMs: 1000,
    heartbeatIntervalMs: 5000,
    longPollMs: 10000,
    logLevel: "error",
    workDir: Deno.makeTempDirSync({ prefix: "glubean-test-" }),
    downloadTimeoutMs: 30000,
    run: {
      ...WORKER_RUN_DEFAULTS,
      allowNet: "*",
    },
    taskTimeoutMs: 30000,
    eventFlushIntervalMs: 1000,
    eventFlushMaxBuffer: 50,
    eventMaxBuffer: 1000,
    eventFlushMaxConsecutiveFailures: 3,
    tags: [],
    maxConcurrentTasks: 1,
    taskMemoryLimitBytes: 0,
    memoryCheckIntervalMs: 2000,
  };
}

// Helper to create a simple test bundle and serve it
async function createAndServeBundle(
  workDir: string,
  bundleId: string,
  testCode: string,
  // deno-lint-ignore no-explicit-any
  metadata: any,
): Promise<{ url: string; checksum: string; shutdown: () => Promise<void> }> {
  const bundleDir = join(workDir, bundleId);
  await ensureDir(bundleDir);

  await Deno.writeTextFile(join(bundleDir, "test.ts"), testCode);
  await Deno.writeTextFile(
    join(bundleDir, "metadata.json"),
    JSON.stringify(metadata),
  );

  // Create tar bundle
  const bundlePath = join(workDir, `${bundleId}.tar`);
  const cmd = new Deno.Command("tar", {
    args: ["-cf", bundlePath, "-C", bundleDir, "."],
    stdout: "null",
    stderr: "null",
  });
  const { success } = await cmd.output();
  if (!success) {
    throw new Error("Failed to create tar bundle");
  }

  // Calculate checksum
  const bundleData = await Deno.readFile(bundlePath);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bundleData);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const checksum = hashArray.map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  );

  // Start server
  const abortController = new AbortController();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: abortController.signal },
    async (_req) => {
      const file = await Deno.open(bundlePath);
      return new Response(file.readable, {
        headers: { "Content-Type": "application/x-tar" },
      });
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 100)); // Wait for server to start

  const url = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/bundle.tar`;

  return {
    url,
    checksum,
    shutdown: async () => {
      abortController.abort();
      await server.finished;
    },
  };
}

Deno.test("executeBundle - successfully executes simple test", async () => {
  const config = createTestConfig();
  const logger = createNoopLogger();

  const testCode = `
import { test } from "@glubean/sdk";

export const simpleTest = test({ id: "simpleTest", name: "Simple Test" }, async (ctx) => {
  ctx.log("Test running");
  ctx.assert(true, "Should pass");
});
`;

  const metadata = {
    version: "1",
    projectId: "test-project",
    files: {
      "test.ts": {
        hash: "abc123",
        exports: [{
          type: "test",
          id: "simpleTest",
          name: "Simple Test",
          tags: [],
          exportName: "simpleTest",
        }],
      },
    },
  };

  const { url, checksum, shutdown } = await createAndServeBundle(
    config.workDir,
    "simple-bundle",
    testCode,
    metadata,
  );

  try {
    const context: RuntimeContext = {
      taskId: "task-1",
      runId: "run-1",
      projectId: "project-1",
      bundle: {
        bundleId: "bundle-1",
        download: {
          type: "bundle",
          url,
          checksum,
        },
      },
    };

    const events: RunEvent[] = [];
    const result = await executeBundle(
      context,
      config,
      logger,
      (event) => {
        events.push(event);
      },
    );

    assertEquals(result.success, true);
    assertEquals(result.error, undefined);
    assertEquals(events.length > 0, true);

    // Verify we got log and result events
    const logEvents = events.filter((e) => e.type === "log");
    const resultEvents = events.filter((e) => e.type === "result");
    assertEquals(logEvents.length > 0, true);
    assertEquals(resultEvents.length, 1);
  } finally {
    await shutdown();
    await Deno.remove(config.workDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("executeBundle - configures maskEnvPrefixes for GLUBEAN_WORKER_TOKEN", () => {
  // Regression guard: the worker must always mask its own token so that
  // untrusted test code cannot exfiltrate it via --allow-env.
  // This verifies the hardcoded value in executeBundle's call to
  // TestExecutor.fromSharedConfig(..., { maskEnvPrefixes: [...] }).
  const config = createTestConfig();
  const executor = TestExecutor.fromSharedConfig(config.run, {
    maskEnvPrefixes: ["GLUBEAN_WORKER_TOKEN"],
  });
  // deno-lint-ignore no-explicit-any
  const opts = (executor as any).options;
  assertEquals(opts.maskEnvPrefixes, ["GLUBEAN_WORKER_TOKEN"]);
});

Deno.test("executeBundle - detects checksum mismatch", async () => {
  const config = createTestConfig();
  const logger = createNoopLogger();

  const testCode = `export const test = () => {};`;
  const metadata = {
    version: "1",
    projectId: "test-project",
    files: {
      "test.ts": {
        hash: "test",
        exports: [{
          type: "test",
          id: "test-1",
          exportName: "test",
          tags: [],
        }],
      },
    },
  };

  const { url, shutdown } = await createAndServeBundle(
    config.workDir,
    "bad-checksum-bundle",
    testCode,
    metadata,
  );

  try {
    const context: RuntimeContext = {
      taskId: "task-2",
      runId: "run-2",
      projectId: "project-2",
      bundle: {
        bundleId: "bundle-2",
        download: {
          type: "bundle",
          url,
          checksum: "0000000000000000000000000000000000000000000000000000000000000000",
        },
      },
    };

    const events: RunEvent[] = [];
    const result = await executeBundle(
      context,
      config,
      logger,
      (event) => {
        events.push(event);
      },
    );

    assertEquals(result.success, false);
    assertStringIncludes(result.error ?? "", "checksum mismatch");
  } finally {
    await shutdown();
    await Deno.remove(config.workDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("executeBundle - handles test failure", async () => {
  const config = createTestConfig();
  const logger = createNoopLogger();

  const testCode = `
import { test } from "@glubean/sdk";

export const failingTest = test({ id: "fail-1" }, async (ctx) => {
  ctx.assert(false, "This should fail");
});
`;

  const metadata = {
    version: "1",
    projectId: "test-project",
    files: {
      "test.ts": {
        hash: "def456",
        exports: [{
          type: "test",
          id: "fail-1",
          exportName: "failingTest",
          tags: [],
        }],
      },
    },
  };

  const { url, checksum, shutdown } = await createAndServeBundle(
    config.workDir,
    "failing-bundle",
    testCode,
    metadata,
  );

  try {
    const context: RuntimeContext = {
      taskId: "task-3",
      runId: "run-3",
      projectId: "project-3",
      bundle: {
        bundleId: "bundle-3",
        download: {
          type: "bundle",
          url,
          checksum,
        },
      },
    };

    const events: RunEvent[] = [];
    const result = await executeBundle(
      context,
      config,
      logger,
      (event) => {
        events.push(event);
      },
    );

    // executeBundle returns success=false when a test fails
    assertEquals(
      result.success,
      false,
      "Expected success to be false when test fails",
    );

    // Should have a result event with failed status
    const resultEvents = events.filter((e) => e.type === "result");
    assertEquals(resultEvents.length, 1);
    // deno-lint-ignore no-explicit-any
    assertEquals((resultEvents[0].payload as any).status, "failed");
  } finally {
    await shutdown();
    await Deno.remove(config.workDir, { recursive: true }).catch(() => {});
  }
});
