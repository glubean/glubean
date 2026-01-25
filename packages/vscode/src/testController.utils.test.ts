/**
 * Tests for testController utility functions.
 *
 * Run with: npx tsx --test src/testController.utils.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildArgs,
  formatJson,
  formatHeaders,
  formatTraceEvent,
  buildEventsSummary,
  tracePairToCurl,
  type GlubeanEvent,
} from "./testController.utils";

// ---------------------------------------------------------------------------
// buildArgs
// ---------------------------------------------------------------------------

describe("buildArgs", () => {
  it("returns base args for file path only", () => {
    const args = buildArgs("/path/to/test.ts");
    assert.deepEqual(args, [
      "run",
      "/path/to/test.ts",
      "--verbose",
      "--pretty",
      "--result-json",
      "--emit-full-trace",
    ]);
  });

  it("includes --filter when filterId is provided", () => {
    const args = buildArgs("/path/to/test.ts", "list-products");
    assert.ok(args.includes("--filter"));
    assert.equal(args[args.indexOf("--filter") + 1], "list-products");
  });

  it("includes --pick when pickKey is provided", () => {
    const args = buildArgs("/path/to/test.ts", "search-", "by-name");
    assert.ok(args.includes("--pick"));
    assert.equal(args[args.indexOf("--pick") + 1], "by-name");
  });

  it("includes --env-file when envFile is provided", () => {
    const args = buildArgs("/path/to/test.ts", undefined, undefined, ".env.staging");
    assert.ok(args.includes("--env-file"));
    assert.equal(args[args.indexOf("--env-file") + 1], ".env.staging");
  });

  it("includes all options when everything is provided", () => {
    const args = buildArgs("/test.ts", "my-test", "example-1", ".env.prod");
    assert.deepEqual(args, [
      "run",
      "/test.ts",
      "--verbose",
      "--pretty",
      "--result-json",
      "--emit-full-trace",
      "--filter",
      "my-test",
      "--pick",
      "example-1",
      "--env-file",
      ".env.prod",
    ]);
  });

  it("omits optional flags when values are undefined", () => {
    const args = buildArgs("/test.ts", undefined, undefined, undefined);
    assert.ok(!args.includes("--filter"));
    assert.ok(!args.includes("--pick"));
    assert.ok(!args.includes("--env-file"));
  });

  it("omits --filter for empty string", () => {
    const args = buildArgs("/test.ts", "");
    assert.ok(!args.includes("--filter"));
  });
});

// ---------------------------------------------------------------------------
// formatJson
// ---------------------------------------------------------------------------

describe("formatJson", () => {
  it("formats an object with pretty-print", () => {
    const result = formatJson({ a: 1, b: "two" });
    assert.equal(result, JSON.stringify({ a: 1, b: "two" }, null, 2));
  });

  it("formats a string value", () => {
    const result = formatJson("hello");
    assert.equal(result, '"hello"');
  });

  it("formats a number", () => {
    assert.equal(formatJson(42), "42");
  });

  it("returns empty string for undefined", () => {
    assert.equal(formatJson(undefined), "");
  });

  it("returns empty string for null", () => {
    assert.equal(formatJson(null), "");
  });

  it("truncates when exceeding maxLen", () => {
    const longObj = { data: "x".repeat(3000) };
    const result = formatJson(longObj, 50);
    assert.ok(result.length < JSON.stringify(longObj, null, 2).length);
    assert.ok(result.endsWith("... (truncated)"));
  });

  it("does not truncate when within maxLen", () => {
    const result = formatJson({ a: 1 }, 10000);
    assert.ok(!result.includes("truncated"));
  });

  it("handles non-serializable values gracefully", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = formatJson(circular);
    // Falls back to String(value)
    assert.ok(result.includes("[object Object]"));
  });
});

// ---------------------------------------------------------------------------
// formatHeaders
// ---------------------------------------------------------------------------

describe("formatHeaders", () => {
  it("returns empty string for undefined", () => {
    assert.equal(formatHeaders(undefined), "");
  });

  it("returns empty string for empty object", () => {
    assert.equal(formatHeaders({}), "");
  });

  it("formats a single header", () => {
    const result = formatHeaders({ "Content-Type": "application/json" });
    assert.equal(result, "  Content-Type: application/json");
  });

  it("formats multiple headers", () => {
    const result = formatHeaders({
      "Content-Type": "application/json",
      Authorization: "Bearer token123",
    });
    const lines = result.split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[0], "  Content-Type: application/json");
    assert.equal(lines[1], "  Authorization: Bearer token123");
  });
});

// ---------------------------------------------------------------------------
// formatTraceEvent
// ---------------------------------------------------------------------------

describe("formatTraceEvent", () => {
  it("formats minimal trace data", () => {
    const result = formatTraceEvent({
      method: "GET",
      url: "https://api.example.com/users",
      status: 200,
      duration: 150,
    });
    assert.ok(result.startsWith("── HTTP GET https://api.example.com/users → 200 (150ms)"));
  });

  it("includes name when present", () => {
    const result = formatTraceEvent({
      method: "POST",
      url: "https://api.example.com/users",
      status: 201,
      duration: 300,
      name: "Create User",
    });
    assert.ok(result.includes("(Create User)"));
  });

  it("uses fallback for missing method", () => {
    const result = formatTraceEvent({ url: "/test", status: 200, duration: 10 });
    assert.ok(result.includes("??? /test"));
  });

  it("includes request headers", () => {
    const result = formatTraceEvent({
      method: "GET",
      url: "/test",
      status: 200,
      duration: 10,
      requestHeaders: { Authorization: "Bearer xxx" },
    });
    assert.ok(result.includes("Request Headers:"));
    assert.ok(result.includes("Authorization: Bearer xxx"));
  });

  it("includes request body", () => {
    const result = formatTraceEvent({
      method: "POST",
      url: "/test",
      status: 201,
      duration: 10,
      requestBody: { name: "test" },
    });
    assert.ok(result.includes("Request Body:"));
    assert.ok(result.includes('"name": "test"'));
  });

  it("includes response headers and body", () => {
    const result = formatTraceEvent({
      method: "GET",
      url: "/test",
      status: 200,
      duration: 10,
      responseHeaders: { "Content-Type": "application/json" },
      responseBody: { id: 1 },
    });
    assert.ok(result.includes("Response Headers:"));
    assert.ok(result.includes("Content-Type: application/json"));
    assert.ok(result.includes("Response Body:"));
    assert.ok(result.includes('"id": 1'));
  });

  it("omits sections when data is missing", () => {
    const result = formatTraceEvent({
      method: "GET",
      url: "/test",
      status: 200,
      duration: 10,
    });
    assert.ok(!result.includes("Request Headers:"));
    assert.ok(!result.includes("Request Body:"));
    assert.ok(!result.includes("Response Headers:"));
    assert.ok(!result.includes("Response Body:"));
  });
});

// ---------------------------------------------------------------------------
// buildEventsSummary
// ---------------------------------------------------------------------------

describe("buildEventsSummary", () => {
  it("formats log events", () => {
    const events: GlubeanEvent[] = [
      { type: "log", message: "hello world" },
    ];
    assert.equal(buildEventsSummary(events), "[LOG] hello world");
  });

  it("formats log events with data", () => {
    const events: GlubeanEvent[] = [
      { type: "log", message: "user", data: { id: 1 } },
    ];
    const result = buildEventsSummary(events);
    assert.ok(result.startsWith("[LOG] user "));
    assert.ok(result.includes('"id": 1'));
  });

  it("formats passing assertion", () => {
    const events: GlubeanEvent[] = [
      { type: "assertion", passed: true, message: "status is 200" },
    ];
    assert.equal(buildEventsSummary(events), "[ASSERT ✓] status is 200");
  });

  it("formats failing assertion with expected/actual", () => {
    const events: GlubeanEvent[] = [
      {
        type: "assertion",
        passed: false,
        message: "status check",
        expected: 200,
        actual: 404,
      },
    ];
    const result = buildEventsSummary(events);
    assert.ok(result.includes("[ASSERT ✗] status check"));
    assert.ok(result.includes("Expected: 200"));
    assert.ok(result.includes("Actual:   404"));
  });

  it("formats warning events", () => {
    const events: GlubeanEvent[] = [
      { type: "warning", message: "slow response" },
    ];
    assert.equal(buildEventsSummary(events), "[WARN] slow response");
  });

  it("formats trace events", () => {
    const events: GlubeanEvent[] = [
      {
        type: "trace",
        data: { method: "GET", url: "/api", status: 200, duration: 50 },
      },
    ];
    const result = buildEventsSummary(events);
    assert.ok(result.includes("── HTTP GET /api → 200 (50ms)"));
  });

  it("formats schema validation pass", () => {
    const events: GlubeanEvent[] = [
      {
        type: "schema_validation",
        success: true,
        label: "response body",
      } as unknown as GlubeanEvent,
    ];
    const result = buildEventsSummary(events);
    assert.ok(result.includes("[SCHEMA ✓] response body"));
  });

  it("formats schema validation failure with issues", () => {
    const events: GlubeanEvent[] = [
      {
        type: "schema_validation",
        success: false,
        label: "request body",
        issues: [
          { message: "Required", path: ["name"] },
          { message: "Invalid type" },
        ],
      } as unknown as GlubeanEvent,
    ];
    const result = buildEventsSummary(events);
    assert.ok(result.includes("[SCHEMA ✗] request body"));
    assert.ok(result.includes("  - Required @ name"));
    assert.ok(result.includes("  - Invalid type"));
  });

  it("formats metric events", () => {
    const events: GlubeanEvent[] = [
      {
        type: "metric",
        name: "latency_ms",
        value: 150,
        unit: "ms",
      } as unknown as GlubeanEvent,
    ];
    const result = buildEventsSummary(events);
    assert.ok(result.includes("[METRIC] latency_ms: 150 ms"));
  });

  it("formats metric events without unit", () => {
    const events: GlubeanEvent[] = [
      {
        type: "metric",
        name: "count",
        value: 42,
      } as unknown as GlubeanEvent,
    ];
    const result = buildEventsSummary(events);
    assert.ok(result.includes("[METRIC] count: 42"));
    assert.ok(!result.includes("undefined"));
  });

  it("formats step start/end events", () => {
    const events: GlubeanEvent[] = [
      { type: "step_start", index: 0, total: 3, name: "login" },
      { type: "step_end", index: 0, status: "passed", durationMs: 120 } as unknown as GlubeanEvent,
    ];
    const result = buildEventsSummary(events);
    assert.ok(result.includes("━━ Step 1/3: login ━━"));
    assert.ok(result.includes("━━ Step done: passed (120ms)"));
  });

  it("formats step_end with returnState", () => {
    const events: GlubeanEvent[] = [
      {
        type: "step_end",
        index: 0,
        status: "passed",
        durationMs: 50,
        returnState: { token: "abc" },
      } as unknown as GlubeanEvent,
    ];
    const result = buildEventsSummary(events);
    assert.ok(result.includes("→ return:"));
    assert.ok(result.includes('"token": "abc"'));
  });

  it("formats error events", () => {
    const events: GlubeanEvent[] = [
      { type: "error", message: "Connection refused" },
    ];
    assert.equal(buildEventsSummary(events), "[ERROR] Connection refused");
  });

  it("formats status events with error", () => {
    const events: GlubeanEvent[] = [
      { type: "status", status: "failed", error: "Timeout exceeded" },
    ];
    const result = buildEventsSummary(events);
    assert.ok(result.includes("[STATUS] failed: Timeout exceeded"));
  });

  it("skips status events without error", () => {
    const events: GlubeanEvent[] = [
      { type: "status", status: "passed" },
    ];
    assert.equal(buildEventsSummary(events), "");
  });

  it("handles unknown event types gracefully", () => {
    const events: GlubeanEvent[] = [
      { type: "unknown_future_event" },
    ];
    assert.equal(buildEventsSummary(events), "");
  });

  it("handles mixed event sequence", () => {
    const events: GlubeanEvent[] = [
      { type: "log", message: "starting test" },
      { type: "trace", data: { method: "GET", url: "/api", status: 200, duration: 30 } },
      { type: "assertion", passed: true, message: "status ok" },
      { type: "warning", message: "slow" },
    ];
    const result = buildEventsSummary(events);
    const lines = result.split("\n");
    assert.ok(lines[0].startsWith("[LOG]"));
    assert.ok(result.includes("── HTTP GET"));
    assert.ok(result.includes("[ASSERT ✓]"));
    assert.ok(result.includes("[WARN]"));
  });

  it("returns empty string for empty events array", () => {
    assert.equal(buildEventsSummary([]), "");
  });
});

// ---------------------------------------------------------------------------
// tracePairToCurl
// ---------------------------------------------------------------------------

describe("tracePairToCurl", () => {
  it("generates GET request without -X flag", () => {
    const result = tracePairToCurl({
      request: { method: "GET", url: "https://api.example.com/users" },
    });
    assert.ok(result.startsWith("curl"));
    assert.ok(!result.includes("-X"));
    assert.ok(result.includes("'https://api.example.com/users'"));
  });

  it("generates POST request with -X flag", () => {
    const result = tracePairToCurl({
      request: { method: "POST", url: "https://api.example.com/users" },
    });
    assert.ok(result.includes("-X POST"));
  });

  it("includes headers", () => {
    const result = tracePairToCurl({
      request: {
        method: "GET",
        url: "https://api.example.com/users",
        headers: {
          Authorization: "Bearer token",
          "Content-Type": "application/json",
        },
      },
    });
    assert.ok(result.includes("-H 'Authorization: Bearer token'"));
    assert.ok(result.includes("-H 'Content-Type: application/json'"));
  });

  it("includes string body with -d flag", () => {
    const result = tracePairToCurl({
      request: {
        method: "POST",
        url: "https://api.example.com/users",
        body: "raw body text",
      },
    });
    assert.ok(result.includes("-d 'raw body text'"));
  });

  it("includes JSON body with -d flag", () => {
    const result = tracePairToCurl({
      request: {
        method: "POST",
        url: "https://api.example.com/users",
        body: { name: "test" },
      },
    });
    assert.ok(result.includes(`-d '{"name":"test"}'`));
  });

  it("generates full cURL with all fields", () => {
    const result = tracePairToCurl({
      request: {
        method: "PUT",
        url: "https://api.example.com/users/1",
        headers: { Authorization: "Bearer abc" },
        body: { name: "updated" },
      },
    });
    assert.ok(result.includes("curl"));
    assert.ok(result.includes("-X PUT"));
    assert.ok(result.includes("'https://api.example.com/users/1'"));
    assert.ok(result.includes("-H 'Authorization: Bearer abc'"));
    assert.ok(result.includes(`-d '{"name":"updated"}'`));
  });

  it("uppercases method", () => {
    const result = tracePairToCurl({
      request: { method: "delete", url: "https://api.example.com/users/1" },
    });
    assert.ok(result.includes("-X DELETE"));
  });

  it("uses line continuations for readability", () => {
    const result = tracePairToCurl({
      request: {
        method: "POST",
        url: "https://api.example.com/users",
        headers: { "Content-Type": "application/json" },
      },
    });
    assert.ok(result.includes(" \\\n  "));
  });
});
