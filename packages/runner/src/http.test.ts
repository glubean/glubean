/**
 * Integration tests for ctx.http — auto-tracing HTTP client powered by ky.
 *
 * These tests verify that the harness correctly wires ky with auto-trace
 * and auto-metric hooks, and that ctx.http is functional inside sandbox.
 */

import { test, expect, afterAll, beforeAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TestExecutor } from "./executor.js";
import type { TimelineEvent } from "./executor.js";
import { generateSummary } from "./generate_summary.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUNNER_ROOT = resolve(__dirname, "..");
const TMP_DIR = join(RUNNER_ROOT, ".tmp-test-http");
let tmpSeq = 0;

beforeAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTraces(events: TimelineEvent[]) {
  return events.filter(
    (e): e is Extract<TimelineEvent, { type: "trace" }> => e.type === "trace",
  );
}

function getMetrics(events: TimelineEvent[]) {
  return events.filter(
    (e): e is Extract<TimelineEvent, { type: "metric" }> => e.type === "metric",
  );
}

function getLogs(events: TimelineEvent[]) {
  return events.filter(
    (e): e is Extract<TimelineEvent, { type: "log" }> => e.type === "log",
  );
}

function getSummaries(events: TimelineEvent[]) {
  return events.filter(
    (e): e is Extract<TimelineEvent, { type: "summary" }> => e.type === "summary",
  );
}

function getWarnings(events: TimelineEvent[]) {
  return events.filter(
    (e): e is Extract<TimelineEvent, { type: "warning" }> => e.type === "warning",
  );
}

async function makeTempFile(content: string, name = "test.ts"): Promise<string> {
  const dir = join(TMP_DIR, String(tmpSeq++));
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, content);
  return file;
}

async function createHttpTestFile(testCode: string): Promise<string> {
  return makeTempFile(
    `import { test } from "@glubean/sdk";\n\n${testCode}`,
    "http_test.ts",
  );
}

/**
 * Start a tiny local HTTP server for testing.
 * Returns the base URL and a close function.
 */
function startTestServer(): Promise<{ baseUrl: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`);
      if (url.pathname === "/users" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ id: 1, name: "Alice" }]));
        return;
      }
      if (url.pathname === "/users" && req.method === "POST") {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: 2, name: "Bob" }));
        return;
      }
      if (url.pathname === "/health") {
        res.writeHead(200);
        res.end("ok");
        return;
      }
      res.writeHead(404);
      res.end("Not found");
    });

    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://localhost:${port}`,
        close: () => server.close(),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("ctx.http.get - auto-traces GET request", async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const testFile = await createHttpTestFile(`
export const httpGet = test("httpGet", async (ctx) => {
  const res = await ctx.http.get("${baseUrl}/users");
  const data = await res.json();
  ctx.assert(Array.isArray(data), "response should be an array");
});
`);
    const executor = new TestExecutor();
    const result = await executor.execute(`file://${testFile}`, "httpGet", {
      vars: {},
      secrets: {},
    });

    expect(result.success).toBe(true);

    const traces = getTraces(result.events);
    expect(traces.length).toBe(1);
    expect(traces[0].data.method).toBe("GET");
    expect(traces[0].data.status).toBe(200);
    expect(traces[0].data.url).toBeDefined();
    expect(traces[0].data.duration).toBeDefined();

    const metrics = getMetrics(result.events);
    const httpMetric = metrics.find((m) => m.name === "http_duration_ms");
    expect(httpMetric).toBeDefined();
    expect(httpMetric!.unit).toBe("ms");
    expect(httpMetric!.tags?.method).toBeDefined();
  } finally {
    close();
  }
});

test("ctx.http.post - auto-traces POST with JSON body", async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const testFile = await createHttpTestFile(`
export const httpPost = test("httpPost", async (ctx) => {
  const res = await ctx.http.post("${baseUrl}/users", {
    json: { name: "Bob" },
  });
  ctx.assert(res.status === 201, "should return 201");
});
`);
    const executor = new TestExecutor();
    const result = await executor.execute(`file://${testFile}`, "httpPost", {
      vars: {},
      secrets: {},
    });

    expect(result.success).toBe(true);

    const traces = getTraces(result.events);
    expect(traces.length).toBe(1);
    expect(traces[0].data.method).toBe("POST");
    expect(traces[0].data.status).toBe(201);
  } finally {
    close();
  }
});

test("ctx.http.get().json() - convenience JSON parsing", async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const testFile = await createHttpTestFile(`
export const httpJson = test("httpJson", async (ctx) => {
  const users = await ctx.http.get("${baseUrl}/users").json();
  ctx.log("Got users", users);
  ctx.assert(Array.isArray(users), "should be array");
});
`);
    const executor = new TestExecutor();
    const result = await executor.execute(`file://${testFile}`, "httpJson", {
      vars: {},
      secrets: {},
    });

    expect(result.success).toBe(true);

    const logs = getLogs(result.events);
    const dataLog = logs.find((l) => l.message.includes("Got users"));
    expect(dataLog).toBeDefined();
  } finally {
    close();
  }
});

test("ctx.http - callable shorthand works", async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const testFile = await createHttpTestFile(`
export const httpCallable = test("httpCallable", async (ctx) => {
  const res = await ctx.http("${baseUrl}/health");
  const text = await res.text();
  ctx.assert(text === "ok", "health check should return ok");
});
`);
    const executor = new TestExecutor();
    const result = await executor.execute(
      `file://${testFile}`,
      "httpCallable",
      { vars: {}, secrets: {} },
    );

    expect(result.success).toBe(true);

    const traces = getTraces(result.events);
    expect(traces.length).toBe(1);
    expect(traces[0].data.method).toBe("GET");
    expect(traces[0].data.status).toBe(200);
  } finally {
    close();
  }
});

test("ctx.http.extend - creates scoped client with shared config", async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const testFile = await createHttpTestFile(`
export const httpExtend = test("httpExtend", async (ctx) => {
  const api = ctx.http.extend({ prefixUrl: "${baseUrl}" });
  const res = await api.get("users");
  ctx.assert(res.status === 200, "should get users with prefixUrl");
});
`);
    const executor = new TestExecutor();
    const result = await executor.execute(
      `file://${testFile}`,
      "httpExtend",
      { vars: {}, secrets: {} },
    );

    expect(result.success).toBe(true);

    const traces = getTraces(result.events);
    expect(traces.length).toBe(1);
    expect(traces[0].data.method).toBe("GET");
    expect(traces[0].data.status).toBe(200);
  } finally {
    close();
  }
});

test("ctx.http - multiple requests produce multiple traces", async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const testFile = await createHttpTestFile(`
export const httpMulti = test("httpMulti", async (ctx) => {
  await ctx.http.get("${baseUrl}/users");
  await ctx.http.post("${baseUrl}/users", { json: { name: "New" } });
  await ctx.http.get("${baseUrl}/health");
});
`);
    const executor = new TestExecutor();
    const result = await executor.execute(`file://${testFile}`, "httpMulti", {
      vars: {},
      secrets: {},
    });

    expect(result.success).toBe(true);

    const traces = getTraces(result.events);
    expect(traces.length).toBe(3);
    expect(traces[0].data.method).toBe("GET");
    expect(traces[0].data.status).toBe(200);
    expect(traces[1].data.method).toBe("POST");
    expect(traces[1].data.status).toBe(201);
    expect(traces[2].data.method).toBe("GET");
    expect(traces[2].data.status).toBe(200);

    const metrics = getMetrics(result.events).filter(
      (m) => m.name === "http_duration_ms",
    );
    expect(metrics.length).toBe(3);
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// Normalization tests
// ---------------------------------------------------------------------------

test("ctx.http.extend - leading slash in path is normalized", async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const testFile = await createHttpTestFile(`
export const httpSlash = test("httpSlash", async (ctx) => {
  const api = ctx.http.extend({ prefixUrl: "${baseUrl}" });
  const res = await api.get("/users");
  ctx.assert(res.status === 200, "should work with leading slash");
});
`);
    const executor = new TestExecutor();
    const result = await executor.execute(`file://${testFile}`, "httpSlash", {
      vars: {},
      secrets: {},
    });

    expect(result.success).toBe(true);

    const traces = getTraces(result.events);
    expect(traces.length).toBe(1);
    expect(traces[0].data.method).toBe("GET");
    expect(traces[0].data.status).toBe(200);
  } finally {
    close();
  }
});

test("ctx.http - empty searchParams does not add bare '?'", async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const testFile = await createHttpTestFile(`
export const httpEmptyParams = test("httpEmptyParams", async (ctx) => {
  const res = await ctx.http.get("${baseUrl}/health", {
    searchParams: {},
  });
  ctx.assert(res.status === 200, "should work with empty searchParams");

  const res2 = await ctx.http.get("${baseUrl}/health", {
    searchParams: new URLSearchParams(),
  });
  ctx.assert(res2.status === 200, "should work with empty URLSearchParams");

  const res3 = await ctx.http.get("${baseUrl}/health", {
    searchParams: "",
  });
  ctx.assert(res3.status === 200, "should work with empty string searchParams");
});
`);
    const executor = new TestExecutor();
    const result = await executor.execute(
      `file://${testFile}`,
      "httpEmptyParams",
      { vars: {}, secrets: {} },
    );

    expect(result.success).toBe(true);

    const traces = getTraces(result.events);
    expect(traces.length).toBe(3);
    for (const trace of traces) {
      expect(trace.data.url.endsWith("?")).toBe(false);
    }
  } finally {
    close();
  }
});

test("ctx.http - non-empty searchParams still work", async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const testFile = await createHttpTestFile(`
export const httpWithParams = test("httpWithParams", async (ctx) => {
  const res = await ctx.http.get("${baseUrl}/health", {
    searchParams: { foo: "bar" },
  });
  ctx.assert(res.status === 200, "should work with searchParams");
});
`);
    const executor = new TestExecutor();
    const result = await executor.execute(
      `file://${testFile}`,
      "httpWithParams",
      { vars: {}, secrets: {} },
    );

    expect(result.success).toBe(true);

    const traces = getTraces(result.events);
    expect(traces.length).toBe(1);
    expect(traces[0].data.url.includes("foo=bar")).toBe(true);
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// Summary event tests
// ---------------------------------------------------------------------------

test("ctx.http - emits summary with request/error totals", async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const testFile = await createHttpTestFile(`
export const httpSummary = test("httpSummary", async (ctx) => {
  await ctx.http.get("${baseUrl}/users");
  await ctx.http.get("${baseUrl}/health");
  await ctx.http.get("${baseUrl}/nonexistent", { throwHttpErrors: false });
});
`);
    const executor = new TestExecutor();
    const result = await executor.execute(`file://${testFile}`, "httpSummary", {
      vars: {},
      secrets: {},
    });

    expect(result.success).toBe(true);

    const summary = generateSummary(result.events);
    expect(summary.httpRequestTotal).toBe(3);
    expect(summary.httpErrorTotal).toBe(1);
    expect(summary.httpErrorRate).toBe(
      Math.round((1 / 3) * 10000) / 10000,
    );
  } finally {
    close();
  }
});

test("ctx.http - no summary when no HTTP calls", async () => {
  const testFile = await createHttpTestFile(`
export const noHttp = test("noHttp", async (ctx) => {
  ctx.log("No HTTP calls in this test");
});
`);
  const executor = new TestExecutor();
  const result = await executor.execute(`file://${testFile}`, "noHttp", {
    vars: {},
    secrets: {},
  });

  expect(result.success).toBe(true);

  const summary = generateSummary(result.events);
  expect(summary.httpRequestTotal).toBe(0);
});

test("ctx.http - summary with all successful requests", async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const testFile = await createHttpTestFile(`
export const httpAllOk = test("httpAllOk", async (ctx) => {
  await ctx.http.get("${baseUrl}/users");
  await ctx.http.get("${baseUrl}/health");
});
`);
    const executor = new TestExecutor();
    const result = await executor.execute(`file://${testFile}`, "httpAllOk", {
      vars: {},
      secrets: {},
    });

    expect(result.success).toBe(true);

    const summary = generateSummary(result.events);
    expect(summary.httpRequestTotal).toBe(2);
    expect(summary.httpErrorTotal).toBe(0);
    expect(summary.httpErrorRate).toBe(0);
  } finally {
    close();
  }
});

// Network policy tests removed — shared_serverless policy was legacy cloud executor code (DX-43).
