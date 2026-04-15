import { test, expect } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  buildLastRunSummary,
  diagnoseProjectConfig,
  discoverTestsFromFile,
  filterLocalDebugEvents,
  runLocalTestsFromFile,
  type LocalRunSnapshot,
  MCP_TOOL_NAMES,
  toLocalDebugEvents,
} from "./index.js";
import { MCP_PACKAGE_VERSION, DEFAULT_GENERATED_BY } from "./version.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test("mcp runtime version constants align with package version", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version: string };
  expect(MCP_PACKAGE_VERSION).toBe(pkg.version);
  expect(DEFAULT_GENERATED_BY).toBe(`@glubean/mcp@${pkg.version}`);
});

test("mcp tool name registry includes all tools", () => {
  const names = Object.values(MCP_TOOL_NAMES);
  expect(names).toContain("glubean_get_last_run_summary");
  expect(names).toContain("glubean_get_local_events");
  expect(names).toContain("glubean_diagnose_config");
  expect(names).toContain("glubean_project_contracts");
  expect(new Set(names).size).toBe(names.length);
});

test("toLocalDebugEvents flattens local run results", () => {
  const snapshot: LocalRunSnapshot = {
    createdAt: "2026-02-19T00:00:00.000Z",
    fileUrl: "file:///tmp/sample.test.ts",
    projectRoot: "/tmp/project",
    summary: { total: 1, passed: 1, failed: 0 },
    includeLogs: true,
    includeTraces: true,
    results: [{
      exportName: "sample",
      id: "sample-test",
      name: "Sample Test",
      success: true,
      durationMs: 25,
      assertions: [{ passed: true, message: "ok" }],
      logs: [{ message: "hello" }],
      traces: [{ method: "GET", url: "https://example.com", status: 200 }],
    }],
  };

  const events = toLocalDebugEvents(snapshot);
  expect(events).toHaveLength(4);
  expect(events[0].type).toBe("result");
  expect(events[1].type).toBe("assertion");
  expect(events[2].type).toBe("log");
  expect(events[3].type).toBe("trace");
  expect(events[3].data).toEqual({
    method: "GET",
    url: "https://example.com",
    status: 200,
  });
});

test("filterLocalDebugEvents applies type/testId/limit", () => {
  const events = [
    { type: "log" as const, testId: "a", exportName: "x", message: "1" },
    { type: "log" as const, testId: "b", exportName: "x", message: "2" },
    { type: "assertion" as const, testId: "a", exportName: "x", message: "3" },
  ];

  const filteredByType = filterLocalDebugEvents([...events], { type: "log" });
  expect(filteredByType).toHaveLength(2);

  const filteredByTest = filterLocalDebugEvents([...events], { testId: "a" });
  expect(filteredByTest).toHaveLength(2);

  const limited = filterLocalDebugEvents([...events], { limit: 1 });
  expect(limited).toHaveLength(1);
});

test("buildLastRunSummary computes event counters", () => {
  const snapshot: LocalRunSnapshot = {
    createdAt: "2026-02-19T00:00:00.000Z",
    fileUrl: "file:///tmp/sample.test.ts",
    projectRoot: "/tmp/project",
    summary: { total: 2, passed: 1, failed: 1 },
    includeLogs: true,
    includeTraces: false,
    results: [
      {
        exportName: "a",
        id: "a",
        success: true,
        durationMs: 10,
        assertions: [{ passed: true, message: "ok" }],
        logs: [{ message: "l1" }],
        traces: [],
      },
      {
        exportName: "b",
        id: "b",
        success: false,
        durationMs: 20,
        assertions: [{ passed: false, message: "bad" }],
        logs: [],
        traces: [],
        error: { message: "boom" },
      },
    ],
  };

  const summary = buildLastRunSummary(snapshot);
  expect(summary.summary).toEqual({ total: 2, passed: 1, failed: 1 });
  expect(summary.eventCounts).toEqual({
    result: 2,
    assertion: 2,
    log: 1,
    trace: 0,
  });
});

test("diagnoseProjectConfig reports missing and present essentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-diagnose-"));
  try {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, ".env"), "BASE_URL=https://api.example.com\n");
    await writeFile(join(dir, ".env.secrets"), "TOKEN=secret\n");
    await mkdir(join(dir, "tests"), { recursive: true });

    const diagnostics = await diagnoseProjectConfig({ dir });
    expect(diagnostics.projectRoot).toBe(dir);
    expect(diagnostics.packageJson.exists).toBe(true);
    expect(diagnostics.envFile.exists).toBe(true);
    expect(diagnostics.envFile.hasBaseUrl).toBe(true);
    expect(diagnostics.secretsFile.exists).toBe(true);
    expect(diagnostics.testsDir.exists).toBe(true);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("diagnoseProjectConfig emits recommendations for missing files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-diagnose-missing-"));
  try {
    await writeFile(join(dir, "package.json"), "{}");

    const diagnostics = await diagnoseProjectConfig({ dir });
    expect(diagnostics.packageJson.exists).toBe(true);
    expect(diagnostics.envFile.exists).toBe(false);
    expect(diagnostics.testsDir.exists).toBe(false);
    expect(diagnostics.exploreDir.exists).toBe(false);
    expect(diagnostics.recommendations.length).toBeGreaterThan(0);
    expect(diagnostics.recommendations).toContain('Missing ".env" file (expected BASE_URL).');
    expect(diagnostics.recommendations).toContain('Create "tests/" or "explore/" to add runnable test files.');
  } finally {
    await rm(dir, { recursive: true });
  }
});

// ── Session lifecycle integration tests ─────────────────────────────────
// These tests create temp dirs under @glubean/runner so @glubean/sdk resolves.

const RUNNER_ROOT = resolve(__dirname, "../../runner");
const SESSION_TMP_DIR = join(RUNNER_ROOT, ".tmp-mcp-session-test");
let sessionSeq = 0;

async function makeSessionTempDir(): Promise<string> {
  const dir = join(SESSION_TMP_DIR, String(sessionSeq++));
  await mkdir(dir, { recursive: true });
  return dir;
}

import { afterAll, beforeAll } from "vitest";

beforeAll(async () => {
  await rm(SESSION_TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(SESSION_TMP_DIR, { recursive: true });
  // Create a package.json so findProjectRoot stops here
  await writeFile(join(SESSION_TMP_DIR, "package.json"), "{}");
  await writeFile(join(SESSION_TMP_DIR, ".env"), "BASE_URL=https://example.com\n");
  await writeFile(join(SESSION_TMP_DIR, ".env.secrets"), "");
});

afterAll(async () => {
  await rm(SESSION_TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

test("runLocalTestsFromFile discovers session.ts and injects session state", async () => {
  const dir = await makeSessionTempDir();
  await mkdir(join(dir, "tests"), { recursive: true });

  // session.ts sets a token
  await writeFile(
    join(dir, "tests", "session.ts"),
    `import { defineSession } from "@glubean/sdk";
export default defineSession({
  async setup(ctx) {
    ctx.session.set("token", "session-abc-123");
    ctx.log("session setup");
  },
  async teardown(ctx) {
    ctx.log("session teardown");
  },
});`,
  );

  // Test reads session token
  await writeFile(
    join(dir, "tests", "check.test.ts"),
    `import { test } from "@glubean/sdk";
export const sessionCheck = test("session-check", (ctx) => {
  const token = ctx.session.get("token");
  ctx.assert(token === "session-abc-123", "session token set");
});`,
  );

  const result = await runLocalTestsFromFile({
    filePath: join(dir, "tests", "check.test.ts"),
    includeLogs: true,
  });

  expect(result.error).toBeUndefined();
  expect(result.summary.total).toBe(1);
  expect(result.summary.passed).toBe(1);
  expect(result.summary.failed).toBe(0);
  expect(result.results[0].success).toBe(true);
}, 15_000);

test("runLocalTestsFromFile works without session.ts", async () => {
  const dir = await makeSessionTempDir();
  await mkdir(join(dir, "tests"), { recursive: true });

  await writeFile(
    join(dir, "tests", "simple.test.ts"),
    `import { test } from "@glubean/sdk";
export const simple = test("simple-test", (ctx) => {
  ctx.assert(true, "always passes");
});`,
  );

  const result = await runLocalTestsFromFile({
    filePath: join(dir, "tests", "simple.test.ts"),
    includeLogs: true,
  });

  expect(result.error).toBeUndefined();
  expect(result.summary.total).toBe(1);
  expect(result.summary.passed).toBe(1);
}, 15_000);

test("runLocalTestsFromFile strips trace headers, keeping only content-type/set-cookie/location/authorization", async () => {
  const dir = await makeSessionTempDir();
  await mkdir(join(dir, "tests"), { recursive: true });

  // Write a package.json with NO custom mcp config — use defaults
  await writeFile(join(dir, "package.json"), "{}");

  await writeFile(
    join(dir, "tests", "http.test.ts"),
    `import { test } from "@glubean/sdk";
export const httpTest = test("http-test", async (ctx) => {
  const res = await ctx.http.get("https://dummyjson.com/products/1");
  ctx.expect(res.status).toBe(200);
});`,
  );

  const result = await runLocalTestsFromFile({
    filePath: join(dir, "tests", "http.test.ts"),
    includeTraces: true,
  });

  expect(result.summary.total).toBe(1);
  expect(result.summary.passed).toBe(1);

  // Should have at least one trace
  const traces = result.results.flatMap((r) => r.traces);
  expect(traces.length).toBeGreaterThan(0);

  for (const trace of traces) {
    const t = trace as Record<string, unknown>;
    // Response headers should only contain kept headers (if any)
    if (t.responseHeaders) {
      const respHeaders = Object.keys(t.responseHeaders as Record<string, string>);
      const allowed = ["content-type", "set-cookie", "location"];
      for (const h of respHeaders) {
        expect(allowed).toContain(h.toLowerCase());
      }
    }
    // Request headers should only contain kept headers (if any)
    if (t.requestHeaders) {
      const reqHeaders = Object.keys(t.requestHeaders as Record<string, string>);
      const allowed = ["content-type", "authorization"];
      for (const h of reqHeaders) {
        expect(allowed).toContain(h.toLowerCase());
      }
    }
  }
}, 15_000);

// ── Contract discovery tests ──────────────────────────────────────────────

// TODO: migrate to .with() syntax when scanner moves to runtime extraction (Step 7)
const CONTRACT_SOURCE = `
import { contract } from "@glubean/sdk";
import { api, publicHttp } from "../config/client.js";

export const createProject = contract.http("create-project", {
  endpoint: "POST /projects",
  client: api,
  cases: {
    success: {
      description: "Valid input returns 201.",
      body: { name: "Test" },
      expect: { status: 201 },
    },
    noAuth: {
      description: "Unauthenticated returns 401.",
      client: publicHttp,
      expect: { status: 401 },
    },
    deferredCase: {
      description: "Not implemented yet.",
      deferred: "backend not ready",
      expect: { status: 200 },
    },
    browserOnly: {
      description: "Needs real OAuth.",
      requires: "browser",
      expect: { status: 200 },
    },
    oobOnly: {
      description: "Needs SMS.",
      requires: "out-of-band",
      expect: { status: 200 },
    },
    expensiveCase: {
      description: "Costly operation.",
      defaultRun: "opt-in",
      expect: { status: 200 },
    },
  },
});
`;

test("discoverTestsFromFile discovers contract cases from .contract.ts files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-contract-"));
  const filePath = join(dir, "create.contract.ts");
  await writeFile(filePath, CONTRACT_SOURCE);

  try {
    const { tests } = await discoverTestsFromFile(filePath);

    expect(tests).toHaveLength(6);

    const ids = tests.map((t) => t.id);
    expect(ids).toContain("create-project.success");
    expect(ids).toContain("create-project.noAuth");
    expect(ids).toContain("create-project.deferredCase");
    expect(ids).toContain("create-project.browserOnly");
    expect(ids).toContain("create-project.oobOnly");
    expect(ids).toContain("create-project.expensiveCase");

    // All cases share the same exportName
    for (const t of tests) {
      expect(t.exportName).toBe("createProject");
    }

    // Deferred case is marked as skip
    const deferred = tests.find((t) => t.id === "create-project.deferredCase")!;
    expect(deferred.skip).toBe(true);
    expect(deferred.deferred).toBe("backend not ready");

    // requires/defaultRun are carried through
    const browser = tests.find((t) => t.id === "create-project.browserOnly")!;
    expect(browser.requires).toBe("browser");

    const oob = tests.find((t) => t.id === "create-project.oobOnly")!;
    expect(oob.requires).toBe("out-of-band");

    const optIn = tests.find((t) => t.id === "create-project.expensiveCase")!;
    expect(optIn.defaultRun).toBe("opt-in");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverTestsFromFile returns empty for contract file with no cases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-contract-empty-"));
  const filePath = join(dir, "empty.contract.ts");
  await writeFile(filePath, `// no contract calls\nexport {};\n`);

  try {
    const { tests } = await discoverTestsFromFile(filePath);
    expect(tests).toHaveLength(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverTestsFromFile still works for regular test files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-regular-"));
  const filePath = join(dir, "smoke.test.ts");
  await writeFile(filePath, `
import { test } from "@glubean/sdk";
export const smoke = test("smoke-check", (ctx) => {
  ctx.assert(true, "ok");
});
`);

  try {
    const { tests } = await discoverTestsFromFile(filePath);
    expect(tests).toHaveLength(1);
    expect(tests[0].id).toBe("smoke-check");
    expect(tests[0].exportName).toBe("smoke");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runLocalTestsFromFile filters deferred/browser/out-of-band/opt-in contract cases", async () => {
  const dir = await makeSessionTempDir();
  await mkdir(join(dir, "tests"), { recursive: true });

  // Contract with 5 cases: 1 runnable + 4 that must be filtered
  await writeFile(
    join(dir, "tests", "filter.contract.ts"),
    `import { contract, configure } from "@glubean/sdk";

const { http: api } = configure({ http: { prefixUrl: "https://example.com" } });

// TODO: migrate to .with() syntax when scanner moves to runtime extraction (Step 7)
export const filterCheck = contract.http("filter-check", {
  endpoint: "GET /",
  client: api,
  cases: {
    runMe: {
      description: "headless always-run case — only this should execute.",
      expect: { status: 200 },
    },
    deferredCase: {
      description: "deferred — must be skipped.",
      deferred: "not ready",
      expect: { status: 200 },
    },
    browserCase: {
      description: "requires browser — must be skipped.",
      requires: "browser",
      expect: { status: 200 },
    },
    oobCase: {
      description: "requires out-of-band — must be skipped.",
      requires: "out-of-band",
      expect: { status: 200 },
    },
    optInCase: {
      description: "opt-in — must be skipped.",
      defaultRun: "opt-in",
      expect: { status: 200 },
    },
  },
});`,
  );

  const result = await runLocalTestsFromFile({
    filePath: join(dir, "tests", "filter.contract.ts"),
    includeLogs: false,
  });

  // Only the single runnable case should be executed.
  // We do NOT care whether the one case passes or fails — what matters
  // is that the filter dropped deferred/browser/oob/opt-in before execution.
  expect(result.error).toBeUndefined();
  expect(result.summary.total).toBe(1);
  expect(result.results).toHaveLength(1);
  expect(result.results[0].id).toBe("filter-check.runMe");

  // None of the filtered case IDs should appear in results
  const ids = result.results.map((r) => r.id);
  expect(ids).not.toContain("filter-check.deferredCase");
  expect(ids).not.toContain("filter-check.browserCase");
  expect(ids).not.toContain("filter-check.oobCase");
  expect(ids).not.toContain("filter-check.optInCase");
}, 30_000);
