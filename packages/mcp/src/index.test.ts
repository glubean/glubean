import { test, expect } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import {
  buildLastRunSummary,
  contractsToOpenApi,
  diagnoseProjectConfig,
  discoverTestsFromFile,
  filterLocalDebugEvents,
  redactMcpTrace,
  resolveEnvPath,
  runLocalTestsFromFile,
  SensitiveActiveEnvError,
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
    startedAt: "2026-02-19T00:00:00.000Z",
    clientRunId: "test-client-run-id",
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
    startedAt: "2026-02-19T00:00:00.000Z",
    clientRunId: "test-client-run-id",
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

test("runLocalTestsFromFile counts ctx.skip() as skipped, not failed", async () => {
  const dir = await makeSessionTempDir();
  await mkdir(join(dir, "tests"), { recursive: true });

  await writeFile(
    join(dir, "tests", "skip.test.ts"),
    `import { test } from "@glubean/sdk";
export const skipMe = test("skip-me")
  .step("decide", async (ctx) => { ctx.skip("not applicable"); });`,
  );

  const result = await runLocalTestsFromFile({
    filePath: join(dir, "tests", "skip.test.ts"),
    includeLogs: true,
  });

  expect(result.error).toBeUndefined();
  expect(result.summary.total).toBe(1);
  expect(result.summary.passed).toBe(0);
  expect(result.summary.failed).toBe(0);
  expect(result.summary.skipped).toBe(1);

  const r = result.results[0];
  expect(r.skipped).toBe(true);
  // A skipped test is not a failure.
  expect(r.success).toBe(true);
}, 15_000);

test("runLocalTestsFromFile: ctx.skip() does not mask a prior failed assertion", async () => {
  const dir = await makeSessionTempDir();
  await mkdir(join(dir, "tests"), { recursive: true });

  await writeFile(
    join(dir, "tests", "skip-after-fail.test.ts"),
    `import { test } from "@glubean/sdk";
export const skipAfterFail = test("skip-after-fail", async (ctx) => {
  ctx.assert(false, "real failure before skip");
  ctx.skip("must not hide the failure");
});`,
  );

  const result = await runLocalTestsFromFile({
    filePath: join(dir, "tests", "skip-after-fail.test.ts"),
    includeLogs: true,
  });

  // The failed assertion is authoritative — this is a failure, not a skip.
  expect(result.summary.failed).toBe(1);
  expect(result.summary.skipped).toBe(0);
  expect(result.summary.passed).toBe(0);

  const r = result.results[0];
  expect(r.success).toBe(false);
  expect(r.skipped).toBeUndefined();
}, 15_000);

// GLU-104: default trace config used to ALLOW-LIST `authorization`/`set-cookie`
// verbatim into the MCP tool return body (an LLM agent's context), and never
// touched request/response body at all. This drives a real HTTP round-trip
// through a local echo server (deterministic, no external network) that
// reflects a live-looking secret in the RESPONSE HEADER (set-cookie), the
// RESPONSE BODY (echoing the request's bearer token back), and accepts a
// secret-bearing REQUEST BODY — the same three surfaces the vulnerability
// report named — then asserts the trace returned by `runLocalTestsFromFile`
// contains no plaintext copy of any of them, while non-sensitive header/body
// content remains visible (the fix must not become a blanket wipe).
test("runLocalTestsFromFile redacts auth header/cookie/secrets from trace headers and body", async () => {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const authHeader = req.headers["authorization"] ?? "";
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "sid=super-secret-session-value; Path=/; HttpOnly",
        "x-request-id": "trace-me-12345",
      });
      res.end(
        JSON.stringify({
          ok: true,
          echoedToken: authHeader,
          user: { note: "hello world", email: "user@example.com" },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  try {
    const dir = await makeSessionTempDir();
    await mkdir(join(dir, "tests"), { recursive: true });

    // No custom mcp.trace config — exercise the DEFAULT.
    await writeFile(join(dir, "package.json"), "{}");

    await writeFile(
      join(dir, "tests", "http.test.ts"),
      `import { test } from "@glubean/sdk";
export const httpTest = test("http-test", async (ctx) => {
  const res = await ctx.http.post("${baseUrl}/login", {
    headers: {
      Authorization: "Bearer LIVE-SECRET-TOKEN-abc123xyz",
      "X-Request-Id": "trace-me-12345",
    },
    json: { username: "alice", password: "super-secret-body-value" },
  });
  ctx.expect(res.status).toBe(200);
});`,
    );

    const result = await runLocalTestsFromFile({
      filePath: join(dir, "tests", "http.test.ts"),
      includeTraces: true,
    });

    expect(result.summary.total).toBe(1);
    expect(result.summary.passed).toBe(1);

    const traces = result.results.flatMap((r) => r.traces);
    expect(traces.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(traces);

    // ── No plaintext secrets anywhere in the trace payload ──────────────
    expect(serialized).not.toContain("LIVE-SECRET-TOKEN-abc123xyz");
    expect(serialized).not.toContain("super-secret-session-value");
    expect(serialized).not.toContain("super-secret-body-value");

    const trace = traces[0] as Record<string, unknown>;

    // ── Sensitive header keys are still visible; only the VALUE is masked ──
    const reqHeaders = trace.requestHeaders as Record<string, string> | undefined;
    expect(reqHeaders).toBeDefined();
    expect(reqHeaders!["Authorization"] ?? reqHeaders!["authorization"]).toBeDefined();
    expect(reqHeaders!["Authorization"] ?? reqHeaders!["authorization"]).not.toBe(
      "Bearer LIVE-SECRET-TOKEN-abc123xyz",
    );

    const respHeaders = trace.responseHeaders as Record<string, string> | undefined;
    expect(respHeaders).toBeDefined();
    const setCookie = respHeaders!["set-cookie"];
    expect(setCookie).toBeDefined();
    expect(setCookie).not.toContain("super-secret-session-value");

    // ── Non-sensitive header stays fully visible (no blanket wipe) ──────
    expect(respHeaders!["x-request-id"]).toBe("trace-me-12345");

    // ── Request body: sensitive key masked, non-sensitive key preserved ──
    const reqBody = trace.requestBody as Record<string, unknown> | undefined;
    expect(reqBody).toBeDefined();
    expect(reqBody!.username).toBe("alice");
    expect(reqBody!.password).not.toBe("super-secret-body-value");

    // ── Response body: pattern-matched secret masked, non-sensitive text kept ──
    const respBody = trace.responseBody as Record<string, unknown> | undefined;
    expect(respBody).toBeDefined();
    expect(respBody!.ok).toBe(true);
    expect((respBody!.user as Record<string, unknown>).note).toBe("hello world");
    expect(respBody!.echoedToken).not.toBe("Bearer LIVE-SECRET-TOKEN-abc123xyz");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}, 15_000);

// GLU-129 regression: dogfood on glubean-dogfood reproduced that
// `glubean_run_local_file`/`glubean_get_local_events` returned secrets in
// PLAINTEXT via `assertion.actual`/`assertion.expected` and `log.data` even
// though GLU-104 had already wired trace header/body redaction. An
// email/password sign-in contract's assertion on the response body copies
// the raw login email into the assertion's `actual`/`expected`, and a
// `ctx.log(...)` of the response echoes the session token again — neither
// went through ANY redaction before this fix (only the `trace` event type
// did). This test drives the same shape end-to-end (real local HTTP server,
// real assertion, real log — a JWT-shaped token for key+pattern coverage,
// the login email for global pattern coverage, matching the dogfood repro's
// "assertion actual/expected values containing the login email") and
// asserts the secret is masked everywhere it now surfaces: the
// `runLocalTestsFromFile` result AND the `toLocalDebugEvents` projection
// that backs `glubean_get_local_events`.
test("runLocalTestsFromFile redacts secrets from assertion.actual/expected and log.data (GLU-129)", async () => {
  const LOGIN_EMAIL = "victim@example.com";
  const SESSION_JWT =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ2aWN0aW0ifQ.dummy-signature-part-not-real";
  // codex R1 P1: an opaque credential that matches NO global value pattern
  // (not JWT/bearer/AWS/GitHub/email/etc shaped) — only reachable via
  // KEY-based masking (`log.data` scope's `sensitiveKeys`), which the first
  // fix pass omitted. Proves the scope-level fix, not just the pattern one.
  const OPAQUE_SESSION_ID = "opaque-session-id-no-known-pattern";
  // codex R3 P1: short enough that the SDK's auto-generated assertion
  // `message` (`inspect()`, packages/sdk/src/expect.ts, caps embedded JSON
  // at 64 chars) embeds it as INTACT, parseable JSON — proving the
  // message-scrubbing fix, not just actual/expected redaction. (The bigger
  // `body` object above gets truncated mid-JSON by `inspect()`'s cap before
  // it ever reaches the message, so it can't exercise this path.)
  const COMPACT_OPAQUE_SECRET = "opaque-secret-nopattern";
  // codex R4 P1: `inspect()` TRUNCATES a long object mid-string
  // (`json.slice(0, 61) + "..."`) rather than omitting it. Crafted so the
  // `token` key/value pair completes well inside that 61-char window (it's
  // the FIRST field) while a large `filler` field pushes the WHOLE object
  // past 64 chars — the embedded fragment is syntactically-INVALID JSON (no
  // closing brace), which is exactly the case a bracket-balanced
  // `JSON.parse()` attempt fails on and falls back to copying verbatim.
  const TRUNCATION_SECRET = "TRUNCATED-SECRET-DO-NOT-LEAK";
  const server = createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "session=SUPER-SECRET-SESSION-COOKIE; Path=/; HttpOnly",
    });
    res.end(
      JSON.stringify({
        ok: true,
        token: SESSION_JWT,
        email: LOGIN_EMAIL,
        sessionId: OPAQUE_SESSION_ID,
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  try {
    const dir = await makeSessionTempDir();
    await mkdir(join(dir, "tests"), { recursive: true });
    await writeFile(join(dir, "package.json"), "{}");

    await writeFile(
      join(dir, "tests", "auth.test.ts"),
      `import { test } from "@glubean/sdk";
export const loginTest = test("login-test", async (ctx) => {
  const res = await ctx.http.post("${baseUrl}/login", {
    json: { email: "${LOGIN_EMAIL}", password: "hunter2" },
  });
  const body = await res.json<{ ok: boolean; token: string; email: string; sessionId: string }>();
  // Mirrors the dogfood repro: the assertion's actual/expected duplicate the
  // raw login email from the response body, and a log echoes the session
  // token/opaque session id again.
  ctx.expect(body.email).toBe("${LOGIN_EMAIL}");
  // codex R2 P1: an OBJECT-shaped assertion — actual/expected carry the
  // opaque, non-pattern-matching credential under a recognized key, not
  // just a scalar email.
  ctx.expect(body).toEqual({
    ok: true,
    token: "${SESSION_JWT}",
    email: "${LOGIN_EMAIL}",
    sessionId: "${OPAQUE_SESSION_ID}",
  });
  ctx.log("login response", body);
  // codex R2 P2: log data as a JSON-encoded STRING (e.g. \`ctx.log("raw", await res.text())\`)
  // — the credential sits under a recognized key but the whole payload is a
  // string, not an object.
  ctx.log("login response raw text", JSON.stringify(body));
  // codex R3 P1: a COMPACT object-shaped assertion whose auto-generated
  // \`message\` embeds the credential as intact JSON (small enough to survive
  // inspect()'s 64-char cap unmangled).
  ctx.expect({ token: "${COMPACT_OPAQUE_SECRET}" }).toEqual({ token: "${COMPACT_OPAQUE_SECRET}" });
  // codex R4 P1: a LONG object-shaped assertion whose auto-generated
  // \`message\` gets TRUNCATED mid-object by inspect()'s 64-char cap — the
  // credential pair itself stays intact (it's the first field), but the
  // surrounding JSON is left syntactically invalid (no closing brace).
  ctx.expect({ token: "${TRUNCATION_SECRET}", filler: "y".repeat(20) }).toEqual({
    token: "${TRUNCATION_SECRET}",
    filler: "y".repeat(20),
  });
});`,
    );

    const result = await runLocalTestsFromFile({
      filePath: join(dir, "tests", "auth.test.ts"),
      includeLogs: true,
      includeTraces: true,
    });

    expect(result.summary.total).toBe(1);
    expect(result.summary.passed).toBe(1);

    const allAssertions = result.results.flatMap((r) => r.assertions);
    const allLogs = result.results.flatMap((r) => r.logs);
    expect(allAssertions.length).toBeGreaterThan(0);
    expect(allLogs.length).toBeGreaterThan(0);

    const assertionSerialized = JSON.stringify(allAssertions);
    const logSerialized = JSON.stringify(allLogs);

    // ── No plaintext secret in either channel ────────────────────────────
    expect(assertionSerialized).not.toContain(LOGIN_EMAIL);
    expect(assertionSerialized).not.toContain(SESSION_JWT);
    // codex R2 P1: the opaque, non-pattern-matching credential inside an
    // OBJECT-shaped `actual`/`expected` (the `ctx.expect(body).toEqual(...)`
    // assertion below) is ONLY caught by key-based masking on the
    // `assertion.actual`/`assertion.expected` scopes.
    expect(assertionSerialized).not.toContain(OPAQUE_SESSION_ID);
    // codex R3 P1: the SAME opaque credential embedded in the SDK's
    // auto-generated `message` (not just `actual`/`expected`).
    expect(assertionSerialized).not.toContain(COMPACT_OPAQUE_SECRET);
    // codex R4 P1: the credential pair survives intact even when inspect()
    // TRUNCATES the surrounding object (invalid JSON — no closing brace).
    expect(assertionSerialized).not.toContain(TRUNCATION_SECRET);
    expect(logSerialized).not.toContain(SESSION_JWT);
    expect(logSerialized).not.toContain(LOGIN_EMAIL);
    // codex R1 P1: the opaque, non-pattern-matching credential is ONLY
    // caught by key-based masking (`log.data` scope's `sensitiveKeys`) —
    // this is the assertion that would have failed before that fix.
    expect(logSerialized).not.toContain(OPAQUE_SESSION_ID);

    const passedAssertions = allAssertions.filter((a) => a.passed === true);
    expect(passedAssertions.length).toBeGreaterThanOrEqual(4);

    // ── Structure/pass-state survives (not a blanket wipe): the assertion
    //    that compared the login email still shows as passed, and both its
    //    `actual` (from the response) and `expected` (the literal email
    //    written in the test source) are masked, not merely one side.
    const emailAssertion = passedAssertions[0];
    expect(emailAssertion.actual).not.toBe(LOGIN_EMAIL);
    expect(emailAssertion.expected).not.toBe(LOGIN_EMAIL);

    // ── codex R2 P1: the object-shaped `ctx.expect(body).toEqual(...)`
    //    assertion masks the credential-shaped KEYS inside actual/expected,
    //    while the non-sensitive `ok` field survives untouched.
    const bodyAssertion = passedAssertions[1];
    const bodyActual = bodyAssertion.actual as Record<string, unknown>;
    const bodyExpected = bodyAssertion.expected as Record<string, unknown>;
    expect(bodyActual.ok).toBe(true);
    expect(bodyActual.token).not.toBe(SESSION_JWT);
    expect(bodyActual.email).not.toBe(LOGIN_EMAIL);
    expect(bodyActual.sessionId).not.toBe(OPAQUE_SESSION_ID);
    expect(bodyExpected.token).not.toBe(SESSION_JWT);
    expect(bodyExpected.sessionId).not.toBe(OPAQUE_SESSION_ID);

    // ── codex R3 P1: the COMPACT assertion's auto-generated `message` embeds
    //    the actual/expected as intact JSON (small enough to survive
    //    inspect()'s cap) — must be scrubbed there too, not just in
    //    actual/expected. The `token` KEY itself isn't secret and still
    //    appears in the message; only the VALUE is masked.
    const compactAssertion = passedAssertions[2];
    expect(compactAssertion.message).not.toContain(COMPACT_OPAQUE_SECRET);
    expect(compactAssertion.message).toContain("token");
    expect((compactAssertion.actual as Record<string, unknown>).token).not.toBe(
      COMPACT_OPAQUE_SECRET,
    );

    // ── codex R4 P1: the TRUNCATED assertion's message contains an early,
    //    syntactically-INVALID JSON fragment (inspect() cut it off with
    //    "..." before the closing brace) — the credential pair inside that
    //    fragment must still be masked, not just skipped because the
    //    overall substring fails JSON.parse. `toEqual` renders the SAME
    //    truncated fragment TWICE (`expected {actual} to equal {expected}`)
    //    — `.not.toContain` below covers both occurrences.
    const truncatedAssertion = passedAssertions[3];
    expect(truncatedAssertion.message).not.toContain(TRUNCATION_SECRET);
    expect(truncatedAssertion.message).toContain("token");
    // Sanity: the fixture actually exercised the truncation path (otherwise
    // this assertion would be vacuous).
    expect(truncatedAssertion.message).toContain("...");
    // A greedy (vs. lazy) value-matching regex, when the FIRST truncated
    // fragment's value has no real closing quote, can run past it and
    // erroneously consume the SECOND fragment's opening quote as if it were
    // this one's closing quote — corrupting the splice with a doubled `""`.
    // Regression for exactly that bug (caught during this fix's own
    // self-review, not by codex).
    expect(truncatedAssertion.message).not.toContain('""');
    expect((truncatedAssertion.actual as Record<string, unknown>).token).not.toBe(
      TRUNCATION_SECRET,
    );

    // ── Log data: key-based masking (token/sessionId) survives structure —
    //    `ok` stays visible, only the credential-shaped fields are replaced.
    const loginLog = allLogs.find((l) => l.message === "login response");
    expect(loginLog).toBeDefined();
    const loginLogData = loginLog!.data as Record<string, unknown>;
    expect(loginLogData.ok).toBe(true);
    expect(loginLogData.token).not.toBe(SESSION_JWT);
    expect(loginLogData.email).not.toBe(LOGIN_EMAIL);
    expect(loginLogData.sessionId).not.toBe(OPAQUE_SESSION_ID);

    // ── codex R2 P2: log data as a JSON-ENCODED STRING is also key-redacted
    //    (parsed, masked, re-serialized) — not just pattern-scanned.
    const rawTextLog = allLogs.find((l) => l.message === "login response raw text");
    expect(rawTextLog).toBeDefined();
    expect(typeof rawTextLog!.data).toBe("string");
    const rawTextData = rawTextLog!.data as string;
    expect(rawTextData).not.toContain(SESSION_JWT);
    expect(rawTextData).not.toContain(LOGIN_EMAIL);
    expect(rawTextData).not.toContain(OPAQUE_SESSION_ID);
    expect(rawTextData).toContain('"ok":true'); // non-sensitive field survives

    // codex R1 P2: the redacted log entry must keep the EXACT
    // `LocalRunResult.logs[]` shape (`{ message, data }`) — no extra `type`
    // key leaking in from the internal `redactEvent` clone.
    expect(Object.keys(loginLog!).sort()).toEqual(["data", "message"]);

    // ── glubean_get_local_events (toLocalDebugEvents) inherits the same
    //    redacted data — it's built directly from `result.results`, so a
    //    fix only at that accumulation point closes BOTH MCP tool surfaces.
    const snapshot: LocalRunSnapshot = {
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      clientRunId: "test-run",
      fileUrl: result.fileUrl,
      projectRoot: result.projectRoot,
      summary: result.summary,
      results: result.results,
      includeLogs: true,
      includeTraces: true,
    };
    const events = toLocalDebugEvents(snapshot);
    const eventsSerialized = JSON.stringify(events);
    expect(eventsSerialized).not.toContain(SESSION_JWT);
    expect(eventsSerialized).not.toContain(LOGIN_EMAIL);
    expect(eventsSerialized).not.toContain(OPAQUE_SESSION_ID);
    expect(eventsSerialized).not.toContain(COMPACT_OPAQUE_SECRET);
    expect(eventsSerialized).not.toContain(TRUNCATION_SECRET);
    expect(events.some((e) => e.type === "assertion")).toBe(true);
    expect(events.some((e) => e.type === "log")).toBe(true);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}, 15_000);

test("redactMcpTrace masks sensitive header/body values while preserving non-sensitive fields (default config)", () => {
  const trace = {
    method: "POST",
    url: "https://api.example.com/login?token=live-query-secret",
    status: 200,
    requestHeaders: {
      Authorization: "Bearer LIVE-SECRET-TOKEN-abc123xyz",
      "Content-Type": "application/json",
      "X-Request-Id": "trace-me-12345",
    },
    requestBody: { username: "alice", password: "super-secret-body-value" },
    responseHeaders: {
      "content-type": "application/json",
      "set-cookie": "sid=super-secret-session-value; Path=/; HttpOnly",
      "x-request-id": "trace-me-12345",
    },
    responseBody: {
      ok: true,
      token: "sk_live_abcdefghijklmnop",
      user: { note: "hello world" },
    },
  };

  const redacted = redactMcpTrace(trace, {}) as Record<string, unknown>;
  const serialized = JSON.stringify(redacted);

  expect(serialized).not.toContain("LIVE-SECRET-TOKEN-abc123xyz");
  expect(serialized).not.toContain("super-secret-session-value");
  expect(serialized).not.toContain("super-secret-body-value");
  expect(serialized).not.toContain("sk_live_abcdefghijklmnop");
  expect(serialized).not.toContain("live-query-secret");

  // Non-sensitive fields survive untouched.
  expect((redacted.requestHeaders as Record<string, string>)["Content-Type"]).toBe(
    "application/json",
  );
  expect((redacted.requestHeaders as Record<string, string>)["X-Request-Id"]).toBe(
    "trace-me-12345",
  );
  expect((redacted.requestBody as Record<string, unknown>).username).toBe("alice");
  expect((redacted.responseBody as Record<string, unknown>).ok).toBe(true);
  expect(
    ((redacted.responseBody as Record<string, unknown>).user as Record<string, unknown>).note,
  ).toBe("hello world");

  // The Authorization/set-cookie KEYS are still present (masked, not dropped).
  expect((redacted.requestHeaders as Record<string, string>).Authorization).toBeDefined();
  expect((redacted.responseHeaders as Record<string, string>)["set-cookie"]).toBeDefined();
});

test("redactMcpTrace masks a value even when a user's keepRequestHeaders config re-adds it", () => {
  const trace = {
    requestHeaders: { Authorization: "Bearer LIVE-SECRET-TOKEN-abc123xyz" },
  };

  // A project explicitly opting Authorization back into visibility must not
  // be able to bypass value-level masking — breadth (this config) and depth
  // (redactMcpTrace) are independent layers.
  const redacted = redactMcpTrace(trace, {
    keepRequestHeaders: ["authorization"],
  }) as Record<string, unknown>;

  const headers = redacted.requestHeaders as Record<string, string>;
  expect(headers.Authorization).toBeDefined();
  expect(headers.Authorization).not.toBe("Bearer LIVE-SECRET-TOKEN-abc123xyz");
});

test("redactMcpTrace drops non-allow-listed headers when a project sets an explicit keepRequestHeaders", () => {
  const trace = {
    requestHeaders: { Authorization: "Bearer x", "X-Debug-Only": "internal-value" },
  };

  const redacted = redactMcpTrace(trace, {
    keepRequestHeaders: ["authorization"],
  }) as Record<string, unknown>;

  const headers = redacted.requestHeaders as Record<string, string> | undefined;
  expect(headers).toBeDefined();
  expect(headers!["X-Debug-Only"]).toBeUndefined();
});

test("redactMcpTrace passes through non-object traces unchanged", () => {
  expect(redactMcpTrace(undefined, {})).toBeUndefined();
  expect(redactMcpTrace(null, {})).toBeNull();
  expect(redactMcpTrace("not-an-object", {})).toBe("not-an-object");
});

// ── GLU-104 codex R1 follow-ups (P1a/P1b/P1c/P2a/P2b) ──────────────────────

test("redactMcpTrace masks opaquely-named cookie/set-cookie values (codex R1 P1a)", () => {
  const trace = {
    requestHeaders: { Cookie: "auth=OPAQUE-AUTH-VALUE-xyz; theme=dark" },
    responseHeaders: {
      "set-cookie": "app=OPAQUE-SESSION-987; Path=/; HttpOnly",
    },
  };
  const redacted = redactMcpTrace(trace, {}) as Record<string, unknown>;
  const s = JSON.stringify(redacted);
  // Neither cookie's NAME is a known sensitive key ("auth"/"app"), yet the
  // VALUES must be masked — the pre-fix name-list approach leaked these.
  expect(s).not.toContain("OPAQUE-AUTH-VALUE-xyz");
  expect(s).not.toContain("OPAQUE-SESSION-987");
  expect(s).not.toContain("dark");
  // Names + Set-Cookie attributes preserved.
  const reqCookie = (redacted.requestHeaders as Record<string, string>).Cookie;
  expect(reqCookie).toContain("auth=");
  expect(reqCookie).toContain("theme=");
  const setCookie = (redacted.responseHeaders as Record<string, string>)["set-cookie"];
  expect(setCookie).toContain("app=");
  expect(setCookie).toContain("Path=/");
  expect(setCookie).toContain("HttpOnly");
});

test("redactMcpTrace masks secrets in a form-urlencoded string body (codex R1 P1b)", () => {
  const trace = {
    requestBody: "username=alice&password=HUNTER2-SECRET&client_secret=CS-PLAINTEXT",
  };
  const redacted = redactMcpTrace(trace, {}) as Record<string, unknown>;
  const body = redacted.requestBody as string;
  expect(body).not.toContain("HUNTER2-SECRET");
  expect(body).not.toContain("CS-PLAINTEXT");
  // Non-sensitive param preserved.
  expect(body).toContain("username=alice");
});

test("redactMcpTrace masks gRPC call metadata auth (codex R1 P1c)", () => {
  // gRPC traces carry auth under data.metadata.{request,response}Metadata —
  // covered by the new BUILTIN http.metadata scope, so MCP (which compiles
  // BUILTIN_SCOPES only) redacts it without importing @glubean/grpc.
  const trace = {
    protocol: "grpc",
    target: "PaymentService/Charge",
    metadata: {
      service: "PaymentService",
      method: "Charge",
      requestMetadata: {
        authorization: "Bearer GRPC-LIVE-TOKEN-xyz",
        "x-api-key": "GRPC-APIKEY-999",
      },
      responseMetadata: { "set-cookie": "grpcsess=GRPC-OPAQUE-SESSION" },
    },
  };
  const redacted = redactMcpTrace(trace, {}) as Record<string, unknown>;
  const s = JSON.stringify(redacted);
  expect(s).not.toContain("GRPC-LIVE-TOKEN-xyz");
  expect(s).not.toContain("GRPC-APIKEY-999");
  expect(s).not.toContain("GRPC-OPAQUE-SESSION");
  // Non-secret metadata siblings preserved.
  const meta = redacted.metadata as Record<string, unknown>;
  expect(meta.service).toBe("PaymentService");
  expect(meta.method).toBe("Charge");
});

test("redactMcpTrace does NOT over-mask sid-substring field names (codex R1 P2a)", () => {
  // `sid` substring used to mask president/residence/consideration — removed.
  const trace = {
    responseBody: {
      president: "Lincoln",
      residence: "White House",
      consideration: "none",
    },
  };
  const redacted = redactMcpTrace(trace, {}) as Record<string, unknown>;
  const body = redacted.responseBody as Record<string, unknown>;
  expect(body.president).toBe("Lincoln");
  expect(body.residence).toBe("White House");
  expect(body.consideration).toBe("none");
});

test("redactMcpTrace keeps deeply-nested non-secret bodies intact (codex R1 P2b)", () => {
  // With the engine default depth (10) a legitimately-deep body was replaced
  // by a `[REDACTED: too deep]` sentinel; redactMcpTrace passes maxDepth 64.
  let deep: Record<string, unknown> = { leaf: "DEEP-LEAF-VALUE" };
  for (let i = 0; i < 15; i++) deep = { [`level${i}`]: deep };
  const redacted = redactMcpTrace({ responseBody: deep }, {}) as Record<string, unknown>;
  const s = JSON.stringify(redacted);
  expect(s).not.toContain("too deep");
  expect(s).toContain("DEEP-LEAF-VALUE");
});

test("redactMcpTrace masks malformed cookie/set-cookie with no '=' (codex R2 P2)", () => {
  const trace = {
    requestHeaders: { Cookie: "OPAQUE-BARE-COOKIE-TOKEN" },
    responseHeaders: { "set-cookie": "OPAQUE-BARE-SETCOOKIE-TOKEN" },
  };
  const s = JSON.stringify(redactMcpTrace(trace, {}));
  expect(s).not.toContain("OPAQUE-BARE-COOKIE-TOKEN");
  expect(s).not.toContain("OPAQUE-BARE-SETCOOKIE-TOKEN");
});

test("redactMcpTrace masks query secrets in a relative requestedUrl (codex R3 P2)", () => {
  const trace = {
    url: "https://api.example.com/login?token=ABS-URL-SECRET",
    requestedUrl: "/login?token=REL-URL-SECRET&page=2",
  };
  const redacted = redactMcpTrace(trace, {}) as Record<string, unknown>;
  const s = JSON.stringify(redacted);
  expect(s).not.toContain("ABS-URL-SECRET");
  expect(s).not.toContain("REL-URL-SECRET");
  // Non-secret param + relative form preserved.
  expect(redacted.requestedUrl as string).toContain("page=2");
  expect((redacted.requestedUrl as string).startsWith("/login?")).toBe(true);
});

test("redactMcpTrace masks query secrets in target/name and URL fragment (codex R5)", () => {
  const trace = {
    protocol: "http",
    method: "GET",
    // browser network traces embed the query in target/name via shortPath()
    target: "GET /callback?token=TARGET-SECRET",
    name: "[browser] GET /callback?token=NAME-SECRET",
    // OAuth implicit-grant token in the URL fragment
    url: "https://app.example.com/callback#access_token=FRAGMENT-SECRET&expires_in=3600",
  };
  const redacted = redactMcpTrace(trace, {}) as Record<string, unknown>;
  const s = JSON.stringify(redacted);
  expect(s).not.toContain("TARGET-SECRET");
  expect(s).not.toContain("NAME-SECRET");
  expect(s).not.toContain("FRAGMENT-SECRET");
  // Non-secret structure preserved.
  expect((redacted.target as string).startsWith("GET /callback?")).toBe(true);
  expect(s).toContain("expires_in=3600");
});

test("redactMcpTrace masks credential key aliases but preserves author-like fields (codex R6 P1)", () => {
  const trace = {
    responseBody: {
      credentials: "OPAQUE-CREDENTIAL-VALUE",
      ssh_key: "OPAQUE-SSH-KEY",
      bearer: "OPAQUE-BEARER-VALUE",
      authToken: "OPAQUE-AUTH-TOKEN",
      // must NOT be masked (bare `auth` deliberately excluded):
      author: { name: "Jane Doe", email: "jane@example.com" },
      authority: "root-ca",
    },
  };
  const redacted = redactMcpTrace(trace, {}) as Record<string, unknown>;
  const s = JSON.stringify(redacted);
  expect(s).not.toContain("OPAQUE-CREDENTIAL-VALUE");
  expect(s).not.toContain("OPAQUE-SSH-KEY");
  expect(s).not.toContain("OPAQUE-BEARER-VALUE");
  expect(s).not.toContain("OPAQUE-AUTH-TOKEN");
  // author/authority preserved (no `auth` substring over-mask).
  const body = redacted.responseBody as Record<string, unknown>;
  expect((body.author as Record<string, unknown>).name).toBe("Jane Doe");
  expect(body.authority).toBe("root-ca");
});

test("redactMcpTrace masks an object-shaped set-cookie element by position (codex R6 P1)", () => {
  const trace = {
    responseHeaders: {
      "set-cookie": [
        "sid=STRING-SECRET; Path=/",
        // object cookie shape — secret under non-sensitive key `value`
        { name: "sid", value: "OBJECT-SESSION-SECRET-12345", domain: "x.com", httpOnly: true },
      ],
    },
  };
  const s = JSON.stringify(redactMcpTrace(trace, {}));
  expect(s).not.toContain("STRING-SECRET");
  expect(s).not.toContain("OBJECT-SESSION-SECRET-12345");
});

test("redactMcpTrace masks credential-valued gRPC metadata fields (codex R4 P2)", () => {
  const trace = {
    protocol: "grpc",
    metadata: {
      service: "AuthService",
      requestMetadata: {
        password: "META-PLAIN-PASSWORD",
        private_key: "META-PLAIN-PRIVATE-KEY",
        sessionid: "META-PLAIN-SESSIONID",
      },
    },
  };
  const s = JSON.stringify(redactMcpTrace(trace, {}));
  expect(s).not.toContain("META-PLAIN-PASSWORD");
  expect(s).not.toContain("META-PLAIN-PRIVATE-KEY");
  expect(s).not.toContain("META-PLAIN-SESSIONID");
  expect(s).toContain("AuthService");
});

test("redactMcpTrace masks a JSON body mislabelled as a text string (codex R2 P2)", () => {
  // The runner keeps a text/plain response body as a raw string; if it is
  // actually JSON, key rules must still apply.
  const trace = {
    responseBody: '{"access_token":"MISLABELLED-JSON-SECRET","status":"ok"}',
  };
  const redacted = redactMcpTrace(trace, {}) as Record<string, unknown>;
  const body = redacted.responseBody as string;
  expect(body).not.toContain("MISLABELLED-JSON-SECRET");
  expect(body).toContain("ok");
});

// ── Contract discovery tests ──────────────────────────────────────────────

const CONTRACT_SOURCE = `
import { contract, configure } from "@glubean/sdk";

const { http: api } = configure({ http: { prefixUrl: "https://example.com" } });
const projectApi = contract.http.with("projects", { client: api });

// @contract
export const createProject = projectApi("create-project", {
  endpoint: "POST /projects",
  cases: {
    success: {
      description: "Valid input returns 201.",
      body: { name: "Test" },
      expect: { status: 201 },
    },
    noAuth: {
      description: "Unauthenticated returns 401.",
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
  // Write fixture inside test-project so @glubean/sdk resolves for runtime import
  const testProjectDir = join(dirname(fileURLToPath(import.meta.url)), "../../../test-project");
  const dir = join(testProjectDir, ".tmp-contract-test-" + Date.now());
  await mkdir(dir, { recursive: true });
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

// GLU-130 repro: contract.http.with(...) instance-level defaults declare
// tags, the contract adds its own tags, and a case requires a browser (so a
// synthetic requires:browser tag is added too). Discovery must expose the
// SAME resolved tags CLI discovery/run and Cloud upload show — not [].
const TAGGED_CONTRACT_SOURCE = `
import { contract, configure } from "@glubean/sdk";

const { http: api } = configure({ http: { prefixUrl: "https://example.com" } });
const dashboardApi = contract.http.with("dashboard", {
  client: api,
  tags: ["dogfood", "staging", "dashboard-api"],
});

// @contract
export const signInEmail = dashboardApi("auth.sign-in.email", {
  endpoint: "POST /api/auth/sign-in/email",
  tags: ["auth"],
  cases: {
    validStagingCredentials: {
      description: "Signs in with valid credentials.",
      expect: { status: 200 },
    },
    caseSpecific: {
      description: "Adds its own tag on top of the contract's.",
      tags: ["case-only"],
      expect: { status: 200 },
    },
    browserOnly: {
      description: "Needs real OAuth.",
      requires: "browser",
      expect: { status: 200 },
    },
  },
});
`;

test("discoverTestsFromFile resolves tags inherited from contract.http.with(...) defaults (GLU-130)", async () => {
  const testProjectDir = join(dirname(fileURLToPath(import.meta.url)), "../../../test-project");
  const dir = join(testProjectDir, ".tmp-contract-tags-test-" + Date.now());
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "auth.contract.ts");
  await writeFile(filePath, TAGGED_CONTRACT_SOURCE);

  try {
    const { tests } = await discoverTestsFromFile(filePath);

    // Instance defaults (.with tags) + contract-level tags — resolved, not [].
    const plain = tests.find((t) => t.id === "auth.sign-in.email.validStagingCredentials")!;
    expect(plain.tags).toEqual(["dogfood", "staging", "dashboard-api", "auth"]);

    // Plus the case's own tag, same merge order the CLI/SDK use.
    const caseSpecific = tests.find((t) => t.id === "auth.sign-in.email.caseSpecific")!;
    expect(caseSpecific.tags).toEqual(["dogfood", "staging", "dashboard-api", "auth", "case-only"]);

    // Plus the synthetic requires:/default-run: tags (mirrors CLI's
    // discoverTests — a non-headless case with no explicit defaultRun also
    // defaults to opt-in).
    const browserOnly = tests.find((t) => t.id === "auth.sign-in.email.browserOnly")!;
    expect(browserOnly.tags).toEqual([
      "dogfood",
      "staging",
      "dashboard-api",
      "auth",
      "requires:browser",
      "default-run:opt-in",
    ]);
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

test("discoverTestsFromFile keeps one data-driven template sentinel with grouping metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-data-driven-"));
  const filePath = join(dir, "cases.test.ts");
  await writeFile(filePath, `
import { test } from "@glubean/sdk";

export const cases = test.each([
  { id: "alpha" },
  { id: "beta" },
  { id: "gamma" },
], { parallel: true })(
  { id: "case-$id", name: "case $id", tags: ["data"] },
  async (_ctx, _row) => {},
);
`);

  try {
    const { tests } = await discoverTestsFromFile(filePath);
    expect(tests).toHaveLength(1);
    expect(tests[0]).toMatchObject({
      exportName: "cases",
      id: "case-$id",
      name: "case $id",
      tags: ["data"],
      groupId: "case-$id",
    });
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

const filterInstance = contract.http.with("filter", { client: api });

// @contract
export const filterCheck = filterInstance("filter-check", {
  endpoint: "GET /",
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

// ==================== Static Fallback Protocol Gate Tests ====================

test("discoverTestsFromFile: mixed HTTP + custom protocol file fails closed on import failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-mixed-proto-"));
  // File imports a nonexistent module to force runtime import failure.
  // Contains both contract.http and contract.kafka — fallback should NOT trigger.
  const filePath = join(dir, "mixed.contract.ts");
  await writeFile(filePath, `
import { contract } from "@nonexistent/sdk";
const api = contract.http.with("user", { client });
export const getUser = api("get-user", {
  endpoint: "GET /users/:id",
  cases: {
    success: { description: "found", expect: { status: 200 } },
  },
});
export const events = contract.kafka("user-events", {
  topic: "user.created",
  cases: { published: { description: "event emitted" } },
});
`);

  try {
    const result = await discoverTestsFromFile(filePath);
    // Fail closed: no tests extracted, error surfaced
    expect(result.tests).toHaveLength(0);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discoverTestsFromFile: pure custom protocol file fails closed on import failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-pure-proto-"));
  const filePath = join(dir, "greeter.contract.ts");
  await writeFile(filePath, `
import { contract } from "@nonexistent/sdk";
export const greeter = contract.grpc("greeter", {
  target: "Greeter/SayHello",
  cases: { success: { description: "hello" } },
});
`);

  try {
    const result = await discoverTestsFromFile(filePath);
    // Fail closed: no tests extracted, error surfaced
    expect(result.tests).toHaveLength(0);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// GLU-130 (static-fallback side): a pure-HTTP contract file whose runtime
// import fails (nonexistent module) still goes through extractContractCases.
// That static/regex extractor doesn't capture custom `tags` at all, but it
// DOES capture `requires`/`defaultRun` — discovery must still emit the same
// synthetic requires:/default-run: tags CLI's static fallback does, instead
// of the old hardcoded `tags: []`.
test("discoverTestsFromFile: static fallback emits synthetic requires/defaultRun tags (GLU-130)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-static-tags-"));
  const filePath = join(dir, "static.contract.ts");
  await writeFile(filePath, `
import { contract } from "@nonexistent/sdk";
export const getUser = contract.http("get-user", {
  endpoint: "GET /users/:id",
  cases: {
    plain: { description: "found", expect: { status: 200 } },
    browserOnly: { description: "needs OAuth", requires: "browser", expect: { status: 200 } },
    optIn: { description: "costly", defaultRun: "opt-in", expect: { status: 200 } },
  },
});
`);

  try {
    const result = await discoverTestsFromFile(filePath);
    // Runtime import failed (nonexistent module) but the file is pure HTTP —
    // static fallback should have extracted cases, not failed closed.
    expect(result.tests.length).toBe(3);

    const plain = result.tests.find((t) => t.id === "get-user.plain")!;
    expect(plain.tags).toBeUndefined();

    const browserOnly = result.tests.find((t) => t.id === "get-user.browserOnly")!;
    expect(browserOnly.tags).toEqual(["requires:browser", "default-run:opt-in"]);

    const optIn = result.tests.find((t) => t.id === "get-user.optIn")!;
    expect(optIn.tags).toEqual(["default-run:opt-in"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// =============================================================================
// OpenAPI generation regression tests (Phase 1+2 patch)
// =============================================================================

test("contractsToOpenApi: multiple cases with same status merge examples + headers (P1 regression)", () => {
  const contract = {
    id: "list-users",
    exportName: "listUsers",
    protocol: "http",
    target: "GET /users",
    description: "List users",
    feature: "users",
    instanceName: undefined,
    security: undefined,
    schemaMount: "response.body",
    requestSchema: null,
    cases: [
      {
        key: "defaultPage",
        description: "default",
        lifecycle: "active",
        severity: "warning",
        schemaMount: "response.body",
        protocolExpect: { status: 200 },
        responseSchema: { type: "object", properties: { items: { type: "array" } } },
        responseContentType: "application/json",
        examples: { default: { value: { items: [] } } },
        responseHeaders: { type: "object", properties: { "x-total-count": { type: "string" } } },
      },
      {
        key: "withLimit",
        description: "limited",
        lifecycle: "active",
        severity: "warning",
        schemaMount: "response.body",
        protocolExpect: { status: 200 },
        responseSchema: null,
        examples: { default: { value: { items: [{}] } } },
        responseHeaders: { type: "object", properties: { "x-rate-limit": { type: "string" } } },
      },
    ],
  };

  const spec = contractsToOpenApi([contract as any]);
  const op = (spec as any).paths["/users"].get;
  expect(op).toBeDefined();

  const r200 = op.responses["200"];
  expect(r200.content["application/json"].schema).toBeDefined();

  const examples = r200.content["application/json"].examples;
  expect(examples.defaultPage).toEqual({ value: { items: [] } });
  expect(examples.withLimit).toEqual({ value: { items: [{}] } });

  expect(r200.headers["x-total-count"]).toBeDefined();
  expect(r200.headers["x-rate-limit"]).toBeDefined();
});

test("contractsToOpenApi: emits x-glubean-cases for given and verify markers", () => {
  const contract = {
    id: "checkout",
    exportName: "checkout",
    protocol: "http",
    target: "POST /checkout",
    description: "Checkout",
    feature: "orders",
    cases: [
      {
        key: "happy",
        description: "order completes",
        lifecycle: "active",
        severity: "critical",
        given: "cart has inventory",
        hasVerify: true,
        verifyRules: [
          { id: "audit", description: "audit row is written" },
        ],
        protocolExpect: { status: 201 },
      },
    ],
  };

  const spec = contractsToOpenApi([contract as any]);
  const op = (spec as any).paths["/checkout"].post;

  expect(op["x-glubean-cases"]).toEqual([
    {
      key: "happy",
      description: "order completes",
      given: "cart has inventory",
      hasVerify: true,
      verifyRules: [
        { id: "audit", description: "audit row is written" },
      ],
      lifecycle: "active",
      severity: "critical",
    },
  ]);
});

test("contractsToOpenApi: param schemas merged across all cases (P2 regression)", () => {
  const contract = {
    id: "get-user",
    exportName: "getUser",
    protocol: "http",
    target: "GET /users/:id",
    description: "Get user",
    feature: "users",
    instanceName: undefined,
    security: undefined,
    schemaMount: "response.body",
    requestSchema: null,
    cases: [
      {
        key: "found",
        description: "found",
        lifecycle: "active",
        severity: "warning",
        schemaMount: "response.body",
        protocolExpect: { status: 200 },
        responseSchema: null,
      },
      {
        key: "notFound",
        description: "not found",
        lifecycle: "active",
        severity: "warning",
        schemaMount: "response.body",
        protocolExpect: { status: 404 },
        responseSchema: null,
        paramSchemas: {
          id: { schema: { type: "string", format: "uuid" }, description: "User ID" },
        },
        querySchemas: {
          include: { description: "Related fields", required: false },
        },
      },
    ],
  };

  const spec = contractsToOpenApi([contract as any]);
  const op = (spec as any).paths["/users/{id}"].get;
  expect(op.parameters).toBeDefined();

  const byName = Object.fromEntries(op.parameters.map((p: any) => [p.name, p]));
  expect(byName.id.schema).toEqual({ type: "string", format: "uuid" });
  expect(byName.id.description).toBe("User ID");
  expect(byName.include).toBeDefined();
  expect(byName.include.description).toBe("Related fields");
});

test("contractsToOpenApi: same status + different content types get separate content entries (P1 regression)", () => {
  const contract = {
    id: "list-users",
    exportName: "listUsers",
    protocol: "http",
    target: "GET /users",
    description: "list",
    feature: "users",
    schemaMount: "response.body",
    requestSchema: null,
    cases: [
      {
        key: "json",
        description: "json output",
        lifecycle: "active",
        severity: "warning",
        schemaMount: "response.body",
        protocolExpect: { status: 200 },
        responseSchema: { type: "object" },
        responseContentType: "application/json",
        examples: { default: { value: { items: [] } } },
      },
      {
        key: "csv",
        description: "csv output",
        lifecycle: "active",
        severity: "warning",
        schemaMount: "response.body",
        protocolExpect: { status: 200 },
        responseSchema: { type: "string" },
        responseContentType: "text/csv",
        examples: { default: { value: "id,name\n1,Alice" } },
      },
    ],
  };

  const spec = contractsToOpenApi([contract as any]);
  const r200 = (spec as any).paths["/users"].get.responses["200"];

  // Both content types present under the same status
  expect(r200.content["application/json"]).toBeDefined();
  expect(r200.content["text/csv"]).toBeDefined();

  // Each content type preserves its own schema and example
  expect(r200.content["application/json"].schema).toEqual({ type: "object" });
  expect(r200.content["text/csv"].schema).toEqual({ type: "string" });
  expect(r200.content["application/json"].examples.json).toBeDefined();
  expect(r200.content["text/csv"].examples.csv).toBeDefined();
});

test("contractsToOpenApi: param metadata fields merge independently across cases (P2 regression)", () => {
  const contract = {
    id: "get-user",
    exportName: "getUser",
    protocol: "http",
    target: "GET /users/:id",
    description: "Get user",
    feature: "users",
    schemaMount: "response.body",
    requestSchema: null,
    cases: [
      {
        key: "withDescription",
        description: "first",
        lifecycle: "active",
        severity: "warning",
        schemaMount: "response.body",
        protocolExpect: { status: 200 },
        responseSchema: null,
        // Only description for id
        paramSchemas: { id: { description: "User identifier" } },
      },
      {
        key: "withSchema",
        description: "second",
        lifecycle: "active",
        severity: "warning",
        schemaMount: "response.body",
        protocolExpect: { status: 404 },
        responseSchema: null,
        // Only schema + deprecated for id
        paramSchemas: { id: { schema: { type: "string", format: "uuid" }, deprecated: true } },
      },
    ],
  };

  const spec = contractsToOpenApi([contract as any]);
  const op = (spec as any).paths["/users/{id}"].get;
  const byName = Object.fromEntries(op.parameters.map((p: any) => [p.name, p]));

  // All three fields collected from the two different cases
  expect(byName.id.description).toBe("User identifier");
  expect(byName.id.schema).toEqual({ type: "string", format: "uuid" });
  expect(byName.id.deprecated).toBe(true);
});

test("contractsToOpenApi: request.headers emits OpenAPI header parameters (P2 regression)", () => {
  const contract = {
    id: "create",
    exportName: "create",
    protocol: "http",
    target: "POST /things",
    description: "Create",
    feature: "things",
    schemaMount: "response.body",
    requestSchema: { type: "object" },
    requestHeaders: {
      type: "object",
      required: ["x-api-key"],
      properties: {
        "x-api-key": { type: "string" },
        "x-request-id": { type: "string", format: "uuid" },
      },
    },
    cases: [
      {
        key: "ok",
        description: "ok",
        lifecycle: "active",
        severity: "warning",
        schemaMount: "response.body",
        protocolExpect: { status: 201 },
        responseSchema: null,
      },
    ],
  };

  const spec = contractsToOpenApi([contract as any]);
  const op = (spec as any).paths["/things"].post;
  expect(op.parameters).toBeDefined();

  const byName = Object.fromEntries(op.parameters.map((p: any) => [`${p.in}:${p.name}`, p]));
  expect(byName["header:x-api-key"]).toBeDefined();
  expect(byName["header:x-api-key"].required).toBe(true);
  expect(byName["header:x-api-key"].schema).toEqual({ type: "string" });

  expect(byName["header:x-request-id"]).toBeDefined();
  expect(byName["header:x-request-id"].required).toBe(false);
  expect(byName["header:x-request-id"].schema).toEqual({ type: "string", format: "uuid" });
});

test("contractsToOpenApi: request body emits schema + example(s) (P1 regression)", () => {
  const contract = {
    id: "create-user",
    exportName: "createUser",
    protocol: "http",
    target: "POST /users",
    description: "Create user",
    feature: "users",
    instanceName: undefined,
    security: undefined,
    schemaMount: "response.body",
    requestSchema: { type: "object", properties: { name: { type: "string" } } },
    requestContentType: "application/json",
    requestExample: { name: "Alice" },
    requestExamples: {
      admin: { value: { name: "Admin" }, summary: "Admin user" },
    },
    cases: [
      {
        key: "success",
        description: "ok",
        lifecycle: "active",
        severity: "warning",
        schemaMount: "response.body",
        protocolExpect: { status: 201 },
        responseSchema: null,
      },
    ],
  };

  const spec = contractsToOpenApi([contract as any]);
  const op = (spec as any).paths["/users"].post;
  expect(op.requestBody).toBeDefined();
  const content = op.requestBody.content["application/json"];
  expect(content.schema).toBeDefined();
  expect(content.examples.default).toEqual({ value: { name: "Alice" } });
  expect(content.examples.admin?.value).toEqual({ name: "Admin" });
  expect(content.examples.admin?.summary).toBe("Admin user");
});




// ─────────────────────────────────────────────────────────────────────────────
// GLU-88 — MCP env-path resolution mirrors the CLI's active-env guard.
// resolveEnvPath is the single funnel every MCP env consumer goes through
// (diagnose_config, run_local_file, open_upload_run). These lock the same
// "refuse a prod-like active-env, but honor explicit envFile + ordinary
// active-env" contract the CLI has, so the intentionally-duplicated guard
// can't silently drift.
// ─────────────────────────────────────────────────────────────────────────────

test("resolveEnvPath: no active-env resolves to .env (even with .env.prod on disk)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-env-guard-"));
  try {
    await writeFile(join(dir, ".env"), "X=1\n");
    await writeFile(join(dir, ".env.prod"), "X=2\n");
    expect(await resolveEnvPath(dir)).toBe(resolve(dir, ".env"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveEnvPath: ordinary active-env (staging) resolves .env.staging (backward compat)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-env-guard-"));
  try {
    await mkdir(join(dir, ".glubean"), { recursive: true });
    await writeFile(join(dir, ".glubean", "active-env"), "staging\n");
    expect(await resolveEnvPath(dir)).toBe(resolve(dir, ".env.staging"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveEnvPath: active-env=prod throws SensitiveActiveEnvError instead of resolving .env.prod", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-env-guard-"));
  try {
    await mkdir(join(dir, ".glubean"), { recursive: true });
    await writeFile(join(dir, ".glubean", "active-env"), "  PROD \n");
    await expect(resolveEnvPath(dir)).rejects.toBeInstanceOf(SensitiveActiveEnvError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveEnvPath: explicit envFile bypasses the guard even when active-env=prod", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-env-guard-"));
  try {
    await mkdir(join(dir, ".glubean"), { recursive: true });
    await writeFile(join(dir, ".glubean", "active-env"), "prod\n");
    // Explicit envFile is resolved as-is, never consulting active-env.
    expect(await resolveEnvPath(dir, resolve(dir, ".env.prod"))).toBe(resolve(dir, ".env.prod"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
