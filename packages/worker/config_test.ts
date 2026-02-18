import { assertEquals, assertThrows } from "@std/assert";
import { ConfigError, ENV_VARS, loadConfig } from "./config.ts";

// Helper to run test with isolated environment
function withEnv(
  vars: Record<string, string>,
  fn: () => void,
): void {
  const original: Record<string, string | undefined> = {};

  // Save and clear all GLUBEAN_ vars
  for (const key of Object.values(ENV_VARS)) {
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
    assertEquals(config.executionConcurrency, 1);
  });
});

Deno.test("loadConfig respects custom values", () => {
  withEnv({
    [ENV_VARS.CONTROL_PLANE_URL]: "https://custom.api.com",
    [ENV_VARS.WORKER_TOKEN]: "gwt_custom",
    [ENV_VARS.WORKER_ID]: "my-worker-1",
    [ENV_VARS.LOG_LEVEL]: "debug",
    [ENV_VARS.EXECUTION_CONCURRENCY]: "4",
    [ENV_VARS.EXECUTION_TIMEOUT_MS]: "60000",
    [ENV_VARS.STOP_ON_FAILURE]: "true",
  }, () => {
    const config = loadConfig();

    assertEquals(config.controlPlaneUrl, "https://custom.api.com");
    assertEquals(config.workerToken, "gwt_custom");
    assertEquals(config.workerId, "my-worker-1");
    assertEquals(config.logLevel, "debug");
    assertEquals(config.executionConcurrency, 4);
    assertEquals(config.executionTimeoutMs, 60000);
    assertEquals(config.stopOnFailure, true);
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
