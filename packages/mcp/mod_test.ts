import { assertEquals } from "@std/assert";
import denoJson from "./deno.json" with { type: "json" };
import {
  buildLastRunSummary,
  diagnoseProjectConfig,
  filterLocalDebugEvents,
  MCP_TOOL_NAMES,
  toLocalDebugEvents,
  type LocalRunSnapshot,
} from "./mod.ts";
import { DEFAULT_GENERATED_BY, MCP_PACKAGE_VERSION } from "./version.ts";

Deno.test("mcp runtime version constants align with package version", () => {
  assertEquals(MCP_PACKAGE_VERSION, denoJson.version);
  assertEquals(DEFAULT_GENERATED_BY, `@glubean/mcp@${denoJson.version}`);
});

Deno.test("mcp tool name registry includes new debugging tools", () => {
  const names = Object.values(MCP_TOOL_NAMES);
  assertEquals(names.includes("glubean_get_last_run_summary"), true);
  assertEquals(names.includes("glubean_get_local_events"), true);
  assertEquals(names.includes("glubean_diagnose_config"), true);
  assertEquals(new Set(names).size, names.length);
});

Deno.test("toLocalDebugEvents flattens local run results", () => {
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
  assertEquals(events.length, 4);
  assertEquals(events[0].type, "result");
  assertEquals(events[1].type, "assertion");
  assertEquals(events[2].type, "log");
  assertEquals(events[3].type, "trace");
});

Deno.test("filterLocalDebugEvents applies type/testId/limit", () => {
  const events = [
    { type: "log", testId: "a", exportName: "x", message: "1" },
    { type: "log", testId: "b", exportName: "x", message: "2" },
    { type: "assertion", testId: "a", exportName: "x", message: "3" },
  ] as const;

  const filteredByType = filterLocalDebugEvents([...events], { type: "log" });
  assertEquals(filteredByType.length, 2);

  const filteredByTest = filterLocalDebugEvents([...events], { testId: "a" });
  assertEquals(filteredByTest.length, 2);

  const limited = filterLocalDebugEvents([...events], { limit: 1 });
  assertEquals(limited.length, 1);
});

Deno.test("buildLastRunSummary computes event counters", () => {
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
  assertEquals(summary.summary, { total: 2, passed: 1, failed: 1 });
  assertEquals(summary.eventCounts, {
    result: 2,
    assertion: 2,
    log: 1,
    trace: 0,
  });
});

Deno.test("diagnoseProjectConfig reports missing and present essentials", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mcp-diagnose-" });
  try {
    await Deno.writeTextFile(`${dir}/deno.json`, "{}");
    await Deno.writeTextFile(`${dir}/.env`, "BASE_URL=https://api.example.com\n");
    await Deno.writeTextFile(`${dir}/.env.secrets`, "TOKEN=secret\n");
    await Deno.mkdir(`${dir}/tests`, { recursive: true });

    const diagnostics = await diagnoseProjectConfig({ dir });
    assertEquals(diagnostics.projectRoot, dir);
    assertEquals(diagnostics.denoJson.exists, true);
    assertEquals(diagnostics.envFile.exists, true);
    assertEquals(diagnostics.envFile.hasBaseUrl, true);
    assertEquals(diagnostics.secretsFile.exists, true);
    assertEquals(diagnostics.testsDir.exists, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
