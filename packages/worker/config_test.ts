import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ConfigError, ENV_VARS, loadConfig, loadConfigFromFile } from "./config.ts";

// Helper to run test with isolated environment
function withEnv(
  vars: Record<string, string>,
  fn: () => void,
): void {
  const original: Record<string, string | undefined> = {};
  const keys = new Set([...Object.values(ENV_VARS), ...Object.keys(vars)]);

  // Save and clear configured vars
  for (const key of keys) {
    original[key] = Deno.env.get(key);
    Deno.env.delete(key);
  }

  // Set test vars
  for (const [key, value] of Object.entries(vars)) {
    Deno.env.set(key, value);
  }

  try {
    fn();
  } finally {
    // Restore original vars
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

async function withEnvAsync(
  vars: Record<string, string>,
  fn: () => Promise<void>,
): Promise<void> {
  const original: Record<string, string | undefined> = {};
  const keys = new Set([...Object.values(ENV_VARS), ...Object.keys(vars)]);
  for (const key of keys) {
    original[key] = Deno.env.get(key);
    Deno.env.delete(key);
  }
  for (const [key, value] of Object.entries(vars)) {
    Deno.env.set(key, value);
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

Deno.test("loadConfig throws on missing required vars", () => {
  withEnv({}, () => {
    assertThrows(
      () => loadConfig(),
      ConfigError,
      "Missing required environment variable: GLUBEAN_CONTROL_PLANE_URL",
    );
  });
});

Deno.test("loadConfig throws on missing worker token", () => {
  withEnv({
    [ENV_VARS.CONTROL_PLANE_URL]: "https://api.glubean.com",
  }, () => {
    assertThrows(
      () => loadConfig(),
      ConfigError,
      "Missing required environment variable: GLUBEAN_WORKER_TOKEN",
    );
  });
});

Deno.test("loadConfig loads minimal config", () => {
  withEnv({
    [ENV_VARS.CONTROL_PLANE_URL]: "https://api.glubean.com",
    [ENV_VARS.WORKER_TOKEN]: "gwt_test_token",
  }, () => {
    const config = loadConfig();

    assertEquals(config.controlPlaneUrl, "https://api.glubean.com");
    assertEquals(config.workerToken, "gwt_test_token");
    assertEquals(config.logLevel, "info");
    assertEquals(config.run.concurrency, 1);
    assertEquals(config.run.failFast, false);
    assertEquals(config.run.allowNet, "*");
    assertEquals(config.taskTimeoutMs, 300_000);
    assertEquals(config.networkPolicy.mode, "trusted");
    assertEquals(config.networkPolicy.allowedPorts, [80, 443, 8080, 8443]);
  });
});

Deno.test("loadConfig respects custom values (canonical env var names)", () => {
  withEnv({
    [ENV_VARS.CONTROL_PLANE_URL]: "https://custom.api.com",
    [ENV_VARS.WORKER_TOKEN]: "gwt_custom",
    [ENV_VARS.WORKER_ID]: "my-worker-1",
    [ENV_VARS.LOG_LEVEL]: "debug",
    [ENV_VARS.EXECUTION_CONCURRENCY]: "4",
    [ENV_VARS.TASK_TIMEOUT_MS]: "60000",
    [ENV_VARS.FAIL_FAST]: "true",
  }, () => {
    const config = loadConfig();

    assertEquals(config.controlPlaneUrl, "https://custom.api.com");
    assertEquals(config.workerToken, "gwt_custom");
    assertEquals(config.workerId, "my-worker-1");
    assertEquals(config.logLevel, "debug");
    assertEquals(config.run.concurrency, 4);
    assertEquals(config.taskTimeoutMs, 60000);
    assertEquals(config.run.failFast, true);
  });
});

Deno.test("loadConfig: ALLOW_NET='' means no network, not '*'", () => {
  withEnv({
    [ENV_VARS.CONTROL_PLANE_URL]: "https://api.glubean.com",
    [ENV_VARS.WORKER_TOKEN]: "gwt_test",
    [ENV_VARS.ALLOW_NET]: "",
  }, () => {
    const config = loadConfig();
    assertEquals(config.run.allowNet, "");
  });
});

Deno.test("loadConfig throws on invalid log level", () => {
  withEnv({
    [ENV_VARS.CONTROL_PLANE_URL]: "https://api.glubean.com",
    [ENV_VARS.WORKER_TOKEN]: "gwt_test",
    [ENV_VARS.LOG_LEVEL]: "invalid",
  }, () => {
    assertThrows(
      () => loadConfig(),
      ConfigError,
      "Invalid log level",
    );
  });
});

Deno.test("loadConfig throws on invalid integer", () => {
  withEnv({
    [ENV_VARS.CONTROL_PLANE_URL]: "https://api.glubean.com",
    [ENV_VARS.WORKER_TOKEN]: "gwt_test",
    [ENV_VARS.EXECUTION_CONCURRENCY]: "not-a-number",
  }, () => {
    assertThrows(
      () => loadConfig(),
      ConfigError,
      "Invalid integer",
    );
  });
});

Deno.test("loadConfig generates worker ID if not provided", () => {
  withEnv({
    [ENV_VARS.CONTROL_PLANE_URL]: "https://api.glubean.com",
    [ENV_VARS.WORKER_TOKEN]: "gwt_test",
  }, () => {
    const config = loadConfig();

    assertEquals(config.workerId.startsWith("worker-"), true);
    assertEquals(config.workerId.length, 15); // "worker-" + 8 chars
  });
});

Deno.test("loadConfig parses tags from comma-separated string", () => {
  withEnv({
    [ENV_VARS.CONTROL_PLANE_URL]: "https://api.glubean.com",
    [ENV_VARS.WORKER_TOKEN]: "gwt_test",
    [ENV_VARS.WORKER_TAGS]: "tier:pro, team:acme, region:us-east",
  }, () => {
    const config = loadConfig();

    assertEquals(config.tags, ["tier:pro", "team:acme", "region:us-east"]);
  });
});

Deno.test("loadConfig returns empty tags array when not set", () => {
  withEnv({
    [ENV_VARS.CONTROL_PLANE_URL]: "https://api.glubean.com",
    [ENV_VARS.WORKER_TOKEN]: "gwt_test",
  }, () => {
    const config = loadConfig();

    assertEquals(config.tags, []);
  });
});

Deno.test("loadConfig filters empty tags", () => {
  withEnv({
    [ENV_VARS.CONTROL_PLANE_URL]: "https://api.glubean.com",
    [ENV_VARS.WORKER_TOKEN]: "gwt_test",
    [ENV_VARS.WORKER_TAGS]: "tier:pro,,, team:acme, ",
  }, () => {
    const config = loadConfig();

    assertEquals(config.tags, ["tier:pro", "team:acme"]);
  });
});

Deno.test("loadConfig throws when legacy timeout env var is set", () => {
  withEnv({
    [ENV_VARS.CONTROL_PLANE_URL]: "https://api.glubean.com",
    [ENV_VARS.WORKER_TOKEN]: "gwt_test",
    GLUBEAN_EXECUTION_TIMEOUT_MS: "60000",
  }, () => {
    assertThrows(
      () => loadConfig(),
      ConfigError,
      "Legacy environment variable GLUBEAN_EXECUTION_TIMEOUT_MS is no longer supported",
    );
  });
});

Deno.test("loadConfig throws when legacy fail-fast env var is set", () => {
  withEnv({
    [ENV_VARS.CONTROL_PLANE_URL]: "https://api.glubean.com",
    [ENV_VARS.WORKER_TOKEN]: "gwt_test",
    GLUBEAN_STOP_ON_FAILURE: "true",
  }, () => {
    assertThrows(
      () => loadConfig(),
      ConfigError,
      "Legacy environment variable GLUBEAN_STOP_ON_FAILURE is no longer supported",
    );
  });
});

Deno.test("loadConfigFromFile loads required config from file only", async () => {
  await withEnvAsync({}, async () => {
    const tempDir = await Deno.makeTempDir();
    const filePath = `${tempDir}/worker.json`;
    try {
      await Deno.writeTextFile(
        filePath,
        JSON.stringify({
          controlPlaneUrl: "https://file.api.com",
          workerToken: "gwt_file_token",
          failFast: true,
          taskTimeoutMs: 120_000,
          executionConcurrency: 3,
          tags: ["tier:file", "region:us"],
        }),
      );
      const config = await loadConfigFromFile(filePath);
      assertEquals(config.controlPlaneUrl, "https://file.api.com");
      assertEquals(config.workerToken, "gwt_file_token");
      assertEquals(config.run.failFast, true);
      assertEquals(config.taskTimeoutMs, 120_000);
      assertEquals(config.run.concurrency, 3);
      assertEquals(config.tags, ["tier:file", "region:us"]);
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  });
});

Deno.test("loadConfigFromFile keeps env precedence over file config", async () => {
  await withEnvAsync({
    [ENV_VARS.CONTROL_PLANE_URL]: "https://env.api.com",
    [ENV_VARS.WORKER_TOKEN]: "gwt_env_token",
    [ENV_VARS.FAIL_FAST]: "false",
    [ENV_VARS.TASK_TIMEOUT_MS]: "45000",
    [ENV_VARS.EXECUTION_CONCURRENCY]: "2",
    [ENV_VARS.NETWORK_POLICY_MODE]: "shared_serverless",
    [ENV_VARS.EGRESS_MAX_REQUESTS]: "88",
  }, async () => {
    const tempDir = await Deno.makeTempDir();
    const filePath = `${tempDir}/worker.json`;
    try {
      await Deno.writeTextFile(
        filePath,
        JSON.stringify({
          controlPlaneUrl: "https://file.api.com",
          workerToken: "gwt_file_token",
          failFast: true,
          taskTimeoutMs: 120_000,
          executionConcurrency: 5,
          networkPolicyMode: "trusted",
          egressMaxRequests: 12,
        }),
      );
      const config = await loadConfigFromFile(filePath);
      assertEquals(config.controlPlaneUrl, "https://env.api.com");
      assertEquals(config.workerToken, "gwt_env_token");
      assertEquals(config.run.failFast, false);
      assertEquals(config.taskTimeoutMs, 45_000);
      assertEquals(config.run.concurrency, 2);
      assertEquals(config.networkPolicy.mode, "shared_serverless");
      assertEquals(config.networkPolicy.maxRequests, 88);
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  });
});

Deno.test("loadConfigFromFile does not mutate process env", async () => {
  await withEnvAsync({}, async () => {
    const tempDir = await Deno.makeTempDir();
    const filePath = `${tempDir}/worker.json`;
    try {
      await Deno.writeTextFile(
        filePath,
        JSON.stringify({
          controlPlaneUrl: "https://file.api.com",
          workerToken: "gwt_file_token",
          taskTimeoutMs: 111_000,
          failFast: true,
        }),
      );
      await loadConfigFromFile(filePath);
      assertEquals(Deno.env.get(ENV_VARS.CONTROL_PLANE_URL), undefined);
      assertEquals(Deno.env.get(ENV_VARS.WORKER_TOKEN), undefined);
      assertEquals(Deno.env.get(ENV_VARS.TASK_TIMEOUT_MS), undefined);
      assertEquals(Deno.env.get(ENV_VARS.FAIL_FAST), undefined);
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  });
});

Deno.test("loadConfigFromFile ignores non-string tag values safely", async () => {
  await withEnvAsync({}, async () => {
    const tempDir = await Deno.makeTempDir();
    const filePath = `${tempDir}/worker.json`;
    try {
      await Deno.writeTextFile(
        filePath,
        JSON.stringify({
          controlPlaneUrl: "https://file.api.com",
          workerToken: "gwt_file_token",
          tags: ["tier:pro", 123, null, " team:acme "],
        }),
      );
      const config = await loadConfigFromFile(filePath);
      assertEquals(config.tags, ["tier:pro", "team:acme"]);
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  });
});

Deno.test("loadConfigFromFile throws when required values are missing in env and file", async () => {
  await withEnvAsync({}, async () => {
    const tempDir = await Deno.makeTempDir();
    const filePath = `${tempDir}/worker.json`;
    try {
      await Deno.writeTextFile(
        filePath,
        JSON.stringify({
          workerToken: "gwt_file_token",
        }),
      );
      await assertRejects(
        () => loadConfigFromFile(filePath),
        ConfigError,
        "Missing required environment variable: GLUBEAN_CONTROL_PLANE_URL",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  });
});

Deno.test("loadConfig throws on invalid network policy mode", () => {
  withEnv({
    [ENV_VARS.CONTROL_PLANE_URL]: "https://api.glubean.com",
    [ENV_VARS.WORKER_TOKEN]: "gwt_test",
    [ENV_VARS.NETWORK_POLICY_MODE]: "invalid_mode",
  }, () => {
    assertThrows(
      () => loadConfig(),
      ConfigError,
      "Invalid network policy mode",
    );
  });
});

Deno.test("loadConfigFromFile throws on legacy executionTimeoutMs key", async () => {
  await withEnvAsync({
    [ENV_VARS.CONTROL_PLANE_URL]: "https://api.glubean.com",
    [ENV_VARS.WORKER_TOKEN]: "gwt_test",
  }, async () => {
    const tempDir = await Deno.makeTempDir();
    const filePath = `${tempDir}/worker.json`;
    try {
      await Deno.writeTextFile(
        filePath,
        JSON.stringify({
          executionTimeoutMs: 60_000,
        }),
      );
      await assertRejects(
        () => loadConfigFromFile(filePath),
        ConfigError,
        'Legacy config key "executionTimeoutMs" is no longer supported',
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  });
});

Deno.test("loadConfigFromFile throws on legacy stopOnFailure key", async () => {
  await withEnvAsync({
    [ENV_VARS.CONTROL_PLANE_URL]: "https://api.glubean.com",
    [ENV_VARS.WORKER_TOKEN]: "gwt_test",
  }, async () => {
    const tempDir = await Deno.makeTempDir();
    const filePath = `${tempDir}/worker.json`;
    try {
      await Deno.writeTextFile(
        filePath,
        JSON.stringify({
          stopOnFailure: true,
        }),
      );
      await assertRejects(
        () => loadConfigFromFile(filePath),
        ConfigError,
        'Legacy config key "stopOnFailure" is no longer supported',
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  });
});
