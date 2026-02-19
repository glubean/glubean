/**
 * Integration tests for ctx.http — auto-tracing HTTP client powered by ky.
 *
 * These tests verify that the harness correctly wires ky with auto-trace
 * and auto-metric hooks, and that ctx.http is functional inside sandbox.
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { TestExecutor } from "./executor.ts";
import type { TimelineEvent } from "./executor.ts";

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

/**
 * Start a tiny local HTTP server that responds to a few routes.
 * Returns the server, base URL, and an AbortController to shut it down.
 */
function startTestServer(): {
  server: Deno.HttpServer;
  baseUrl: string;
  controller: AbortController;
} {
  const controller = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: controller.signal, onListen: () => {} },
    (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/users" && req.method === "GET") {
        return new Response(JSON.stringify([{ id: 1, name: "Alice" }]), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/users" && req.method === "POST") {
        return new Response(JSON.stringify({ id: 2, name: "Bob" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/health") {
        return new Response("ok");
      }
      return new Response("Not found", { status: 404 });
    },
  );
  const addr = server.addr as Deno.NetAddr;
  const baseUrl = `http://localhost:${addr.port}`;
  return { server, baseUrl, controller };
}

/**
 * Create a temp test file that imports from @glubean/sdk and uses ctx.http.
 */
async function createHttpTestFile(testCode: string): Promise<string> {
  const tempDir = await Deno.makeTempDir();
  const testFile = `${tempDir}/http_test.ts`;
  await Deno.writeTextFile(
    testFile,
    `import { test } from "@glubean/sdk";\n\n${testCode}`,
  );
  return testFile;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("ctx.http.get - auto-traces GET request", async () => {
  const { baseUrl, controller } = startTestServer();
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

    assertEquals(
      result.success,
      true,
      `Test failed: ${JSON.stringify(result)}`,
    );

    // Verify auto-trace was emitted
    const traces = getTraces(result.events);
    assertEquals(traces.length, 1, "Expected exactly 1 trace event");
    assertEquals(traces[0].data.method, "GET");
    assertEquals(traces[0].data.status, 200);
    assertExists(traces[0].data.url);
    assertExists(traces[0].data.duration);

    // Verify auto-metric was emitted
    const metrics = getMetrics(result.events);
    const httpMetric = metrics.find((m) => m.name === "http_duration_ms");
    assertExists(httpMetric, "Expected http_duration_ms metric");
    assertEquals(httpMetric!.unit, "ms");
    assertExists(httpMetric!.tags?.method, "metric should have method tag");

    await Deno.remove(testFile, { recursive: true });
  } finally {
    controller.abort();
  }
});

Deno.test("ctx.http.post - auto-traces POST with JSON body", async () => {
  const { baseUrl, controller } = startTestServer();
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

    assertEquals(
      result.success,
      true,
      `Test failed: ${JSON.stringify(result)}`,
    );

    const traces = getTraces(result.events);
    assertEquals(traces.length, 1);
    assertEquals(traces[0].data.method, "POST");
    assertEquals(traces[0].data.status, 201);

    await Deno.remove(testFile, { recursive: true });
  } finally {
    controller.abort();
  }
});

Deno.test("ctx.http.get().json() - convenience JSON parsing", async () => {
  const { baseUrl, controller } = startTestServer();
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

    assertEquals(
      result.success,
      true,
      `Test failed: ${JSON.stringify(result)}`,
    );

    // Verify log contains the parsed data
    const logs = getLogs(result.events);
    const dataLog = logs.find((l) => l.message.includes("Got users"));
    assertExists(dataLog, "Should have log with parsed JSON");

    await Deno.remove(testFile, { recursive: true });
  } finally {
    controller.abort();
  }
});

Deno.test("ctx.http - callable shorthand works", async () => {
  const { baseUrl, controller } = startTestServer();
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

    assertEquals(
      result.success,
      true,
      `Test failed: ${JSON.stringify(result)}`,
    );

    const traces = getTraces(result.events);
    assertEquals(traces.length, 1);
    assertEquals(traces[0].data.method, "GET"); // default method
    assertEquals(traces[0].data.status, 200);

    await Deno.remove(testFile, { recursive: true });
  } finally {
    controller.abort();
  }
});

Deno.test(
  "ctx.http.extend - creates scoped client with shared config",
  async () => {
    const { baseUrl, controller } = startTestServer();
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

      assertEquals(
        result.success,
        true,
        `Test failed: ${JSON.stringify(result)}`,
      );

      const traces = getTraces(result.events);
      assertEquals(traces.length, 1);
      assertEquals(traces[0].data.method, "GET");
      assertEquals(traces[0].data.status, 200);

      await Deno.remove(testFile, { recursive: true });
    } finally {
      controller.abort();
    }
  },
);

Deno.test("ctx.http - multiple requests produce multiple traces", async () => {
  const { baseUrl, controller } = startTestServer();
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

    assertEquals(
      result.success,
      true,
      `Test failed: ${JSON.stringify(result)}`,
    );

    const traces = getTraces(result.events);
    assertEquals(traces.length, 3, "Expected 3 trace events");
    assertEquals(traces[0].data.method, "GET");
    assertEquals(traces[0].data.status, 200);
    assertEquals(traces[1].data.method, "POST");
    assertEquals(traces[1].data.status, 201);
    assertEquals(traces[2].data.method, "GET");
    assertEquals(traces[2].data.status, 200);

    // Should also have 3 metrics
    const metrics = getMetrics(result.events).filter(
      (m) => m.name === "http_duration_ms",
    );
    assertEquals(metrics.length, 3, "Expected 3 http_duration_ms metrics");

    await Deno.remove(testFile, { recursive: true });
  } finally {
    controller.abort();
  }
});

// ---------------------------------------------------------------------------
// Normalization tests
// ---------------------------------------------------------------------------

Deno.test("ctx.http.extend - leading slash in path is normalized", async () => {
  const { baseUrl, controller } = startTestServer();
  try {
    const testFile = await createHttpTestFile(`
export const httpSlash = test("httpSlash", async (ctx) => {
  // Users naturally write "/users" with leading slash
  // ky normally rejects this with prefixUrl — our wrapper strips it
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

    assertEquals(
      result.success,
      true,
      `Test failed: ${JSON.stringify(result)}`,
    );

    const traces = getTraces(result.events);
    assertEquals(traces.length, 1);
    assertEquals(traces[0].data.method, "GET");
    assertEquals(traces[0].data.status, 200);

    await Deno.remove(testFile, { recursive: true });
  } finally {
    controller.abort();
  }
});

Deno.test("ctx.http - empty searchParams does not add bare '?'", async () => {
  const { baseUrl, controller } = startTestServer();
  try {
    const testFile = await createHttpTestFile(`
export const httpEmptyParams = test("httpEmptyParams", async (ctx) => {
  // Pass empty searchParams — should not append '?' to URL
  const res = await ctx.http.get("${baseUrl}/health", {
    searchParams: {},
  });
  ctx.assert(res.status === 200, "should work with empty searchParams");

  // Also test with empty URLSearchParams
  const res2 = await ctx.http.get("${baseUrl}/health", {
    searchParams: new URLSearchParams(),
  });
  ctx.assert(res2.status === 200, "should work with empty URLSearchParams");

  // And empty string
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

    assertEquals(
      result.success,
      true,
      `Test failed: ${JSON.stringify(result)}`,
    );

    // Verify traces don't contain '?' at the end of URL
    const traces = getTraces(result.events);
    assertEquals(traces.length, 3, "Expected 3 trace events");
    for (const trace of traces) {
      assertEquals(
        trace.data.url.endsWith("?"),
        false,
        `URL should not end with '?': ${trace.data.url}`,
      );
    }

    await Deno.remove(testFile, { recursive: true });
  } finally {
    controller.abort();
  }
});

Deno.test("ctx.http - non-empty searchParams still work", async () => {
  const { baseUrl, controller } = startTestServer();
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

    assertEquals(
      result.success,
      true,
      `Test failed: ${JSON.stringify(result)}`,
    );

    const traces = getTraces(result.events);
    assertEquals(traces.length, 1);
    // URL should contain the query param
    assertEquals(
      traces[0].data.url.includes("foo=bar"),
      true,
      `URL should contain query param: ${traces[0].data.url}`,
    );

    await Deno.remove(testFile, { recursive: true });
  } finally {
    controller.abort();
  }
});

// ---------------------------------------------------------------------------
// Summary event tests
// ---------------------------------------------------------------------------

Deno.test("ctx.http - emits summary with request/error totals", async () => {
  const { baseUrl, controller } = startTestServer();
  try {
    // Use throwHttpErrors: false so ky doesn't throw on 404
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

    assertEquals(
      result.success,
      true,
      `Test failed: ${JSON.stringify(result)}`,
    );

    const summaries = getSummaries(result.events);
    assertEquals(summaries.length, 1, "Expected exactly 1 summary event");

    const summary = summaries[0].data;
    assertEquals(summary.httpRequestTotal, 3, "Expected 3 total requests");
    assertEquals(summary.httpErrorTotal, 1, "Expected 1 error (404)");
    assertEquals(
      summary.httpErrorRate,
      Math.round((1 / 3) * 10000) / 10000,
      "Expected error rate = 1/3 rounded to 4 decimals",
    );

    await Deno.remove(testFile, { recursive: true });
  } finally {
    controller.abort();
  }
});

Deno.test({
  name: "ctx.http - no summary when no HTTP calls",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
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

    assertEquals(
      result.success,
      true,
      `Test failed: ${JSON.stringify(result)}`,
    );

    const summaries = getSummaries(result.events);
    assertEquals(summaries.length, 1, "Summary is always emitted");
    assertEquals(
      summaries[0].data.httpRequestTotal,
      0,
      "httpRequestTotal should be 0 when no HTTP calls are made",
    );

    await Deno.remove(testFile, { recursive: true });
  },
});

Deno.test("ctx.http - summary with all successful requests", async () => {
  const { baseUrl, controller } = startTestServer();
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

    assertEquals(
      result.success,
      true,
      `Test failed: ${JSON.stringify(result)}`,
    );

    const summaries = getSummaries(result.events);
    assertEquals(summaries.length, 1, "Expected exactly 1 summary event");

    const summary = summaries[0].data;
    assertEquals(summary.httpRequestTotal, 2, "Expected 2 total requests");
    assertEquals(summary.httpErrorTotal, 0, "Expected 0 errors");
    assertEquals(summary.httpErrorRate, 0, "Expected 0 error rate");

    await Deno.remove(testFile, { recursive: true });
  } finally {
    controller.abort();
  }
});

Deno.test("ctx.http - shared-serverless policy blocks localhost destinations", async () => {
  const { baseUrl, controller } = startTestServer();
  const serverPort = Number(new URL(baseUrl).port);
  try {
    const testFile = await createHttpTestFile(`
export const localhostBlocked = test("localhostBlocked", async (ctx) => {
  await ctx.http.get("${baseUrl}/health");
});
`);
    const executor = new TestExecutor();
    const result = await executor.execute(
      `file://${testFile}`,
      "localhostBlocked",
      {
        vars: {},
        secrets: {},
        networkPolicy: {
          mode: "shared_serverless",
          maxRequests: 5,
          maxConcurrentRequests: 2,
          requestTimeoutMs: 1000,
          maxResponseBytes: 1024 * 1024,
          allowedPorts: [80, 443, 8080, 8443, serverPort],
        },
      },
    );

    assertEquals(result.success, false);
    assertStringIncludes(
      result.error ?? "",
      "Network policy blocked sensitive hostname localhost",
    );
    const warnings = getWarnings(result.events);
    assertEquals(
      warnings.some((w) => w.message.includes("network_guard:blocked_hostname")),
      true,
    );
    await Deno.remove(testFile, { recursive: true });
  } finally {
    controller.abort();
  }
});

Deno.test("ctx.http - shared-serverless policy enforces request count limit", async () => {
  const testFile = await createHttpTestFile(`
export const requestLimit = test("requestLimit", async (ctx) => {
  try {
    await ctx.http.get("http://8.8.8.8", { throwHttpErrors: false });
  } catch {
    // Ignore first request failure so we can hit request-count limit on second call.
  }
  await ctx.http.get("http://8.8.8.8", { throwHttpErrors: false });
});
`);
  const executor = new TestExecutor();
  const result = await executor.execute(
    `file://${testFile}`,
    "requestLimit",
    {
      vars: {},
      secrets: {},
      networkPolicy: {
        mode: "shared_serverless",
        maxRequests: 1,
        maxConcurrentRequests: 2,
        requestTimeoutMs: 100,
        maxResponseBytes: 1024 * 1024,
        allowedPorts: [80, 443, 8080, 8443],
      },
    },
  );

  assertEquals(result.success, false);
  assertStringIncludes(
    result.error ?? "",
    "Network policy exceeded max outbound requests",
  );
  const warnings = getWarnings(result.events);
  assertEquals(
    warnings.some((w) => w.message.includes("network_guard:request_limit_exceeded")),
    true,
  );
  await Deno.remove(testFile, { recursive: true });
});

Deno.test(
  "ctx.http - shared-serverless policy enforces concurrency for Promise.all",
  async () => {
    const testFile = await createHttpTestFile(`
export const concurrencyLimit = test("concurrencyLimit", async (ctx) => {
  await Promise.all([
    ctx.http.get("http://8.8.8.8", { throwHttpErrors: false }),
    ctx.http.get("http://1.1.1.1", { throwHttpErrors: false }),
  ]);
});
`);
    const executor = new TestExecutor();
    const result = await executor.execute(
      `file://${testFile}`,
      "concurrencyLimit",
      {
        vars: {},
        secrets: {},
        networkPolicy: {
          mode: "shared_serverless",
          maxRequests: 10,
          maxConcurrentRequests: 1,
          requestTimeoutMs: 2_000,
          maxResponseBytes: 1024 * 1024,
          allowedPorts: [80, 443, 8080, 8443],
        },
      },
    );

    assertEquals(result.success, false);
    assertStringIncludes(
      result.error ?? "",
      "Network policy exceeded max concurrent outbound requests",
    );
    const warnings = getWarnings(result.events);
    assertEquals(
      warnings.some((w) => w.message.includes("network_guard:concurrency_limit_exceeded")),
      true,
    );
    await Deno.remove(testFile, { recursive: true });
  },
);

Deno.test(
  "ctx.http - shared-serverless policy blocks unsupported protocol",
  async () => {
    const testFile = await createHttpTestFile(`
export const protocolBlocked = test("protocolBlocked", async (ctx) => {
  await ctx.http.get("ftp://example.com/resource");
});
`);
    const executor = new TestExecutor();
    const result = await executor.execute(
      `file://${testFile}`,
      "protocolBlocked",
      {
        vars: {},
        secrets: {},
        networkPolicy: {
          mode: "shared_serverless",
          maxRequests: 5,
          maxConcurrentRequests: 2,
          requestTimeoutMs: 1_000,
          maxResponseBytes: 1024 * 1024,
          allowedPorts: [80, 443, 8080, 8443],
        },
      },
    );

    assertEquals(result.success, false);
    assertStringIncludes(
      result.error ?? "",
      "Network policy blocked protocol",
    );
    await Deno.remove(testFile, { recursive: true });
  },
);

Deno.test(
  "ctx.http - shared-serverless policy blocks disallowed port",
  async () => {
    const testFile = await createHttpTestFile(`
export const portBlocked = test("portBlocked", async (ctx) => {
  await ctx.http.get("http://8.8.8.8:22", { throwHttpErrors: false });
});
`);
    const executor = new TestExecutor();
    const result = await executor.execute(
      `file://${testFile}`,
      "portBlocked",
      {
        vars: {},
        secrets: {},
        networkPolicy: {
          mode: "shared_serverless",
          maxRequests: 5,
          maxConcurrentRequests: 2,
          requestTimeoutMs: 1_000,
          maxResponseBytes: 1024 * 1024,
          allowedPorts: [80, 443, 8080, 8443],
        },
      },
    );

    assertEquals(result.success, false);
    assertStringIncludes(
      result.error ?? "",
      "Network policy blocked destination port 22",
    );
    await Deno.remove(testFile, { recursive: true });
  },
);

Deno.test(
  "ctx.http - shared-serverless policy blocks IPv6 loopback literal",
  async () => {
    const testFile = await createHttpTestFile(`
export const ipv6Blocked = test("ipv6Blocked", async (ctx) => {
  await ctx.http.get("http://[::1]/health", { throwHttpErrors: false });
});
`);
    const executor = new TestExecutor();
    const result = await executor.execute(
      `file://${testFile}`,
      "ipv6Blocked",
      {
        vars: {},
        secrets: {},
        networkPolicy: {
          mode: "shared_serverless",
          maxRequests: 5,
          maxConcurrentRequests: 2,
          requestTimeoutMs: 1_000,
          maxResponseBytes: 1024 * 1024,
          allowedPorts: [80, 443, 8080, 8443],
        },
      },
    );

    assertEquals(result.success, false);
    assertStringIncludes(result.error ?? "", "Network policy blocked destination IP");
    const warnings = getWarnings(result.events);
    assertEquals(
      warnings.some((w) => w.message.includes("network_guard:loopback_ip")),
      true,
    );
    await Deno.remove(testFile, { recursive: true });
  },
);

Deno.test(
  "ctx.http - shared-serverless policy fails closed on DNS resolution errors",
  async () => {
    const testFile = await createHttpTestFile(`
export const dnsFailClosed = test("dnsFailClosed", async (ctx) => {
  await ctx.http.get("http://does-not-exist.invalid/health", { throwHttpErrors: false });
});
`);
    const executor = new TestExecutor();
    const result = await executor.execute(
      `file://${testFile}`,
      "dnsFailClosed",
      {
        vars: {},
        secrets: {},
        networkPolicy: {
          mode: "shared_serverless",
          maxRequests: 5,
          maxConcurrentRequests: 2,
          requestTimeoutMs: 1_000,
          maxResponseBytes: 1024 * 1024,
          allowedPorts: [80, 443, 8080, 8443],
        },
      },
    );

    assertEquals(result.success, false);
    assertStringIncludes(
      result.error ?? "",
      "Network policy could not resolve host does-not-exist.invalid",
    );
    await Deno.remove(testFile, { recursive: true });
  },
);

Deno.test(
  "ctx.http - shared-serverless policy blocks DNS rebinding-style resolution to loopback",
  async () => {
    const testFile = await createHttpTestFile(`
export const dnsRebindingBlocked = test("dnsRebindingBlocked", async (ctx) => {
  const originalResolveDns = Deno.resolveDns.bind(Deno);
  Object.defineProperty(Deno, "resolveDns", {
    configurable: true,
    value: async (...args: Parameters<typeof Deno.resolveDns>) => {
      const [hostname, recordType] = args;
      if (hostname === "rebinding-safe.test") {
        if (recordType === "A") return ["127.0.0.1"];
        if (recordType === "AAAA") return [];
      }
      return await originalResolveDns(...args);
    },
  });

  try {
    await ctx.http.get("http://rebinding-safe.test/health", { throwHttpErrors: false });
  } finally {
    Object.defineProperty(Deno, "resolveDns", {
      configurable: true,
      value: originalResolveDns,
    });
  }
});
`);
    const executor = new TestExecutor();
    const result = await executor.execute(
      `file://${testFile}`,
      "dnsRebindingBlocked",
      {
        vars: {},
        secrets: {},
        networkPolicy: {
          mode: "shared_serverless",
          maxRequests: 5,
          maxConcurrentRequests: 2,
          requestTimeoutMs: 1_000,
          maxResponseBytes: 1024 * 1024,
          allowedPorts: [80, 443, 8080, 8443],
        },
      },
    );

    assertEquals(result.success, false);
    assertStringIncludes(
      result.error ?? "",
      "Network policy blocked resolved destination 127.0.0.1 for host rebinding-safe.test",
    );
    const warnings = getWarnings(result.events);
    assertEquals(
      warnings.some((w) => w.message.includes("network_guard:loopback_ip")),
      true,
    );
    await Deno.remove(testFile, { recursive: true });
  },
);
