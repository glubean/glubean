import { test, expect, afterAll, beforeAll } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { createServer, type Server } from "node:http";
import { TestExecutor } from "./executor.js";
import type { ExecutionEvent } from "./executor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUNNER_ROOT = resolve(__dirname, "..");
const TMP_DIR = join(RUNNER_ROOT, ".tmp-session-test");
let tmpSeq = 0;

// Local deterministic echo server — replaces httpbin.org, which is chronically
// down / nondeterministic and was failing the {{KEY}}/prefixUrl template tests
// below (blocking releases via the publish.yml test gate). /headers echoes the
// request headers; /get echoes the resolved URL — enough for the template-
// resolution assertions to observe what actually reached the wire.
let echoServer: Server;
let echoBaseUrl = "";

beforeAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });

  echoServer = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/headers") {
      // mirror httpbin.org/headers: { headers: { ...request headers } }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ headers: req.headers }));
      return;
    }
    if (pathname === "/get") {
      // mirror httpbin.org/get: { url: <full resolved url> }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: echoBaseUrl + (req.url ?? "") }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((r) => echoServer.listen(0, "127.0.0.1", () => r()));
  const addr = echoServer.address();
  echoBaseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await new Promise<void>((r) => echoServer.close(() => r()));
});

async function makeTempDir(): Promise<string> {
  const dir = join(TMP_DIR, String(tmpSeq++));
  await mkdir(dir, { recursive: true });
  return dir;
}

function createExecutor(): TestExecutor {
  return TestExecutor.fromSharedConfig(
    {
      failFast: false,
      timeoutMs: 10_000,
      emitFullTrace: false,
    },
    { cwd: RUNNER_ROOT },
  );
}

async function collectEvents(
  executor: TestExecutor,
  fileUrl: string,
  testId: string,
  context: Record<string, unknown>,
): Promise<ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];
  for await (const event of executor.run(fileUrl, testId, context as any)) {
    events.push(event);
  }
  return events;
}

// ── Session setup execution ──────────────────────────────────────────────────

test("session setup: calls setup() and emits session:set events", async () => {
  const dir = await makeTempDir();
  const sessionFile = join(dir, "session.ts");
  await writeFile(
    sessionFile,
    `
import { defineSession } from "@glubean/sdk";

export default defineSession({
  async setup(ctx) {
    ctx.session.set("token", "abc123");
    ctx.session.set("userId", "42");
    ctx.log("session setup done");
  },
});
`,
  );

  const executor = createExecutor();
  const events = await collectEvents(
    executor,
    pathToFileURL(sessionFile).href,
    "__session__",
    { vars: {}, secrets: {}, session: {}, sessionMode: "setup" },
  );

  // Should have session:set events
  const sessionSets = events.filter((e) => e.type === "session:set");
  expect(sessionSets).toHaveLength(2);
  expect(sessionSets[0]).toMatchObject({ key: "token", value: "abc123" });
  expect(sessionSets[1]).toMatchObject({ key: "userId", value: "42" });

  // Should have completed status
  const statuses = events.filter((e) => e.type === "status");
  expect(statuses).toContainEqual(
    expect.objectContaining({ status: "completed" }),
  );
}, 15_000);

test("session setup: fails with clear error when default export missing", async () => {
  const dir = await makeTempDir();
  const sessionFile = join(dir, "session.ts");
  await writeFile(sessionFile, `export const foo = 42;`);

  const executor = createExecutor();
  const events = await collectEvents(
    executor,
    pathToFileURL(sessionFile).href,
    "__session__",
    { vars: {}, secrets: {}, session: {}, sessionMode: "setup" },
  );

  const statuses = events.filter((e) => e.type === "status");
  expect(statuses).toContainEqual(
    expect.objectContaining({
      status: "failed",
      error: expect.stringContaining("SessionDefinition"),
    }),
  );
}, 15_000);

test("session setup: setup error emits failed status", async () => {
  const dir = await makeTempDir();
  const sessionFile = join(dir, "session.ts");
  await writeFile(
    sessionFile,
    `
import { defineSession } from "@glubean/sdk";

export default defineSession({
  async setup() {
    throw new Error("auth server down");
  },
});
`,
  );

  const executor = createExecutor();
  const events = await collectEvents(
    executor,
    pathToFileURL(sessionFile).href,
    "__session__",
    { vars: {}, secrets: {}, session: {}, sessionMode: "setup" },
  );

  const statuses = events.filter((e) => e.type === "status");
  expect(statuses).toContainEqual(
    expect.objectContaining({
      status: "failed",
      error: "auth server down",
    }),
  );
}, 15_000);

// ── Session teardown execution ───────────────────────────────────────────────

test("session teardown: calls teardown() with accumulated state", async () => {
  const dir = await makeTempDir();
  const sessionFile = join(dir, "session.ts");
  await writeFile(
    sessionFile,
    `
import { defineSession } from "@glubean/sdk";

export default defineSession({
  async setup(ctx) {
    ctx.session.set("token", "will-be-overridden");
  },
  async teardown(ctx) {
    ctx.log("teardown-token:" + ctx.session.get("token"));
  },
});
`,
  );

  const executor = createExecutor();
  const events = await collectEvents(
    executor,
    pathToFileURL(sessionFile).href,
    "__session__",
    {
      vars: {},
      secrets: {},
      session: { token: "final-value" },
      sessionMode: "teardown",
    },
  );

  const logs = events.filter(
    (e) => e.type === "log" && e.message.includes("teardown-token:"),
  );
  expect(logs).toHaveLength(1);
  expect((logs[0] as any).message).toBe("teardown-token:final-value");

  const statuses = events.filter((e) => e.type === "status");
  expect(statuses).toContainEqual(
    expect.objectContaining({ status: "completed" }),
  );
}, 15_000);

// ── Session + test integration ───────────────────────────────────────────────

test("test receives session state via context injection", async () => {
  const dir = await makeTempDir();
  const testFile = join(dir, "api.test.ts");
  await writeFile(
    testFile,
    `
import { test } from "@glubean/sdk";

export const checkSession = test("check-session", async (ctx) => {
  const token = ctx.session.require("token");
  ctx.assert(token === "abc123", "token should match");
  ctx.log("got-token:" + token);
});
`,
  );

  const executor = createExecutor();
  const events = await collectEvents(
    executor,
    pathToFileURL(testFile).href,
    "check-session",
    { vars: {}, secrets: {}, session: { token: "abc123" } },
  );

  const assertions = events.filter((e) => e.type === "assertion");
  expect(assertions).toContainEqual(
    expect.objectContaining({ passed: true, message: "token should match" }),
  );

  const statuses = events.filter((e) => e.type === "status");
  expect(statuses).toContainEqual(
    expect.objectContaining({ status: "completed" }),
  );
}, 15_000);

// ── session:set NOT in execute() results ─────────────────────────────────────

test("session:set events are filtered from execute() timeline", async () => {
  const dir = await makeTempDir();
  const testFile = join(dir, "writer.test.ts");
  await writeFile(
    testFile,
    `
import { test } from "@glubean/sdk";

export const writeSession = test("write-session", async (ctx) => {
  ctx.session.set("newKey", "newValue");
  ctx.assert(true, "ok");
});
`,
  );

  const executor = createExecutor();
  const result = await executor.execute(
    pathToFileURL(testFile).href,
    "write-session",
    { vars: {}, secrets: {}, session: {} },
  );

  // execute() returns ExecutionResult with events: TimelineEvent[]
  // session:set should NOT appear in timeline events
  const sessionEvents = result.events.filter(
    (e) => (e as any).type === "session:set",
  );
  expect(sessionEvents).toHaveLength(0);

  // But the test should still pass
  expect(result.success).toBe(true);
}, 15_000);

// ── ctx.interactive in session setup ────────────────────────────────────────

test("session setup receives interactive=false by default", async () => {
  const dir = await makeTempDir();
  const sessionFile = join(dir, "session.ts");
  await writeFile(
    sessionFile,
    `
import { defineSession } from "@glubean/sdk";

export default defineSession({
  async setup(ctx) {
    ctx.session.set("wasInteractive", String(ctx.interactive));
  },
});
`,
  );

  const executor = createExecutor();
  const events = await collectEvents(
    executor,
    pathToFileURL(sessionFile).href,
    "__session__",
    { vars: {}, secrets: {}, session: {}, sessionMode: "setup" },
  );

  const sessionSets = events.filter((e) => e.type === "session:set");
  expect(sessionSets).toContainEqual(
    expect.objectContaining({ key: "wasInteractive", value: "false" }),
  );
}, 15_000);

test("session setup receives interactive=true when passed in context", async () => {
  const dir = await makeTempDir();
  const sessionFile = join(dir, "session.ts");
  await writeFile(
    sessionFile,
    `
import { defineSession } from "@glubean/sdk";

export default defineSession({
  async setup(ctx) {
    ctx.session.set("wasInteractive", String(ctx.interactive));
  },
});
`,
  );

  const executor = createExecutor();
  const events = await collectEvents(
    executor,
    pathToFileURL(sessionFile).href,
    "__session__",
    { vars: {}, secrets: {}, session: {}, sessionMode: "setup", interactive: true },
  );

  const sessionSets = events.filter((e) => e.type === "session:set");
  expect(sessionSets).toContainEqual(
    expect.objectContaining({ key: "wasInteractive", value: "true" }),
  );
}, 15_000);

// ── Session → {{KEY}} template resolution (integration) ────────────────────

test("session values resolve in configure() {{KEY}} templates", { timeout: 15_000, retry: 3 }, async () => {
  const dir = await makeTempDir();

  // session.ts sets AUTH_TOKEN
  await writeFile(
    join(dir, "session.ts"),
    `
import { defineSession } from "@glubean/sdk";

export default defineSession({
  async setup(ctx) {
    ctx.session.set("AUTH_TOKEN", "session-jwt-xyz");
  },
});
`,
  );

  // test file uses {{AUTH_TOKEN}} in configure headers
  const testFile = join(dir, "api.test.ts");
  await writeFile(
    testFile,
    `
import { test, configure } from "@glubean/sdk";

const { http } = configure({
  http: {
    prefixUrl: "${echoBaseUrl}",
    headers: { Authorization: "Bearer {{AUTH_TOKEN}}" },
  },
});

export const checkHeader = test("check-header", async (ctx) => {
  // local echo server /headers returns { headers: <request headers> }
  const res = await http.get("headers").json();
  const authHeader = res.headers?.Authorization || res.headers?.authorization;
  ctx.assert(authHeader === "Bearer session-jwt-xyz", "session token resolved in header");
  ctx.log("resolved-header:" + authHeader);
});
`,
  );

  const executor = TestExecutor.fromSharedConfig(
    { failFast: false, emitFullTrace: false },
    { cwd: RUNNER_ROOT },
  ).withSession(dir);

  const events: ExecutionEvent[] = [];
  for await (const event of executor.run(
    pathToFileURL(testFile).href,
    "check-header",
    { vars: {}, secrets: {} },
  )) {
    events.push(event);
  }

  // Session should have been set up
  expect(executor.sessionState).toEqual({ AUTH_TOKEN: "session-jwt-xyz" });

  // Test should pass — meaning {{AUTH_TOKEN}} resolved from session
  const statuses = events.filter((e) => e.type === "status");
  expect(statuses).toContainEqual(
    expect.objectContaining({ status: "completed" }),
  );

  const assertions = events.filter((e) => e.type === "assertion");
  expect(assertions).toContainEqual(
    expect.objectContaining({ passed: true, message: "session token resolved in header" }),
  );
}, 15_000);

test("session values resolve in configure() prefixUrl template", { timeout: 15_000, retry: 3 }, async () => {
  const dir = await makeTempDir();

  const testFile = join(dir, "prefix.test.ts");
  await writeFile(
    testFile,
    `
import { test, configure } from "@glubean/sdk";

const { http } = configure({
  http: { prefixUrl: "{{DYNAMIC_BASE}}" },
});

export const checkPrefix = test("check-prefix", async (ctx) => {
  // If prefixUrl resolved correctly, this reaches the local echo server's /get
  const res = await http.get("get").json();
  ctx.assert(res.url === "${echoBaseUrl}/get", "prefixUrl resolved from session");
});
`,
  );

  const executor = createExecutor();
  const events = await collectEvents(
    executor,
    pathToFileURL(testFile).href,
    "check-prefix",
    { vars: {}, secrets: {}, session: { DYNAMIC_BASE: echoBaseUrl } },
  );

  const statuses = events.filter((e) => e.type === "status");
  expect(statuses).toContainEqual(
    expect.objectContaining({ status: "completed" }),
  );

  const assertions = events.filter((e) => e.type === "assertion");
  expect(assertions).toContainEqual(
    expect.objectContaining({ passed: true }),
  );
}, 15_000);

test("global session accessor works in subprocess", async () => {
  const dir = await makeTempDir();

  const testFile = join(dir, "global.test.ts");
  await writeFile(
    testFile,
    `
import { test, session } from "@glubean/sdk";

export const checkGlobal = test("check-global", async (ctx) => {
  const token = session.get("MY_TOKEN");
  ctx.assert(token === "from-session", "global session.get works");

  const required = session.require("MY_TOKEN");
  ctx.assert(required === "from-session", "global session.require works");

  ctx.assert(session.has("MY_TOKEN"), "global session.has works");
  ctx.assert(!session.has("MISSING"), "global session.has returns false for missing");
});
`,
  );

  const executor = createExecutor();
  const events = await collectEvents(
    executor,
    pathToFileURL(testFile).href,
    "check-global",
    { vars: {}, secrets: {}, session: { MY_TOKEN: "from-session" } },
  );

  const assertions = events.filter((e) => e.type === "assertion");
  expect(assertions).toHaveLength(4);
  expect(assertions.every((a) => (a as any).passed)).toBe(true);
}, 15_000);

// ── withSession() + finalize() ──────────────────────────────────────────────

test("withSession auto-discovers session.ts, runs setup, injects state", async () => {
  const dir = await makeTempDir();

  // session.ts that sets a token
  await writeFile(
    join(dir, "session.ts"),
    `
import { defineSession } from "@glubean/sdk";
export default defineSession({
  async setup(ctx) {
    ctx.session.set("token", "auto-session-abc");
    ctx.log("session setup done");
  },
  async teardown(ctx) {
    ctx.log("session teardown done");
  },
});
`,
  );

  // test that reads the session token
  const testFile = join(dir, "check.test.ts");
  await writeFile(
    testFile,
    `
import { test } from "@glubean/sdk";
export const check = test("check-session", (ctx) => {
  const token = ctx.session.get("token");
  ctx.assert(token === "auto-session-abc", "session token injected");
});
`,
  );

  const executor = TestExecutor.fromSharedConfig(
    { failFast: false, emitFullTrace: false },
    { cwd: RUNNER_ROOT },
  ).withSession(dir);

  const events: ExecutionEvent[] = [];
  for await (const event of executor.run(
    pathToFileURL(testFile).href,
    "check-session",
    { vars: {}, secrets: {} },
  )) {
    events.push(event);
  }

  expect(executor.sessionReady).toBe(true);
  expect(executor.sessionState).toEqual({ token: "auto-session-abc" });

  const statuses = events.filter((e) => e.type === "status");
  expect(statuses).toContainEqual(
    expect.objectContaining({ status: "completed" }),
  );

  // finalize runs teardown
  const teardownEvents: ExecutionEvent[] = [];
  for await (const event of executor.finalize()) {
    teardownEvents.push(event);
  }
  const teardownLogs = teardownEvents.filter(
    (e) => e.type === "log" && e.message.includes("teardown"),
  );
  expect(teardownLogs.length).toBeGreaterThan(0);
}, 15_000);

test("withSession works when no session.ts exists", async () => {
  const dir = await makeTempDir();

  const testFile = join(dir, "simple.test.ts");
  await writeFile(
    testFile,
    `
import { test } from "@glubean/sdk";
export const simple = test("simple", (ctx) => {
  ctx.assert(true, "always passes");
});
`,
  );

  const executor = TestExecutor.fromSharedConfig(
    { failFast: false, emitFullTrace: false },
    { cwd: RUNNER_ROOT },
  ).withSession(dir);

  const events: ExecutionEvent[] = [];
  for await (const event of executor.run(
    pathToFileURL(testFile).href,
    "simple",
    { vars: {}, secrets: {} },
  )) {
    events.push(event);
  }

  expect(executor.sessionReady).toBe(true);
  expect(Object.keys(executor.sessionState)).toHaveLength(0);

  const statuses = events.filter((e) => e.type === "status");
  expect(statuses).toContainEqual(
    expect.objectContaining({ status: "completed" }),
  );

  // finalize is a no-op — no session file found
  const teardownEvents: ExecutionEvent[] = [];
  for await (const event of executor.finalize()) {
    teardownEvents.push(event);
  }
  expect(teardownEvents).toHaveLength(0);
}, 15_000);

test("finalize is safe to call multiple times", async () => {
  const dir = await makeTempDir();

  await writeFile(
    join(dir, "session.ts"),
    `
import { defineSession } from "@glubean/sdk";
export default defineSession({
  async setup(ctx) { ctx.session.set("k", "v"); },
  async teardown(ctx) { ctx.log("teardown"); },
});
`,
  );

  const testFile = join(dir, "t.test.ts");
  await writeFile(
    testFile,
    `
import { test } from "@glubean/sdk";
export const t = test("t", (ctx) => { ctx.assert(true, "ok"); });
`,
  );

  const executor = TestExecutor.fromSharedConfig(
    { failFast: false, emitFullTrace: false },
    { cwd: RUNNER_ROOT },
  ).withSession(dir);

  for await (const _event of executor.run(
    pathToFileURL(testFile).href,
    "t",
    { vars: {}, secrets: {} },
  )) {}

  // First finalize runs teardown
  let count = 0;
  for await (const _event of executor.finalize()) { count++; }
  expect(count).toBeGreaterThan(0);

  // Second finalize is a no-op
  let count2 = 0;
  for await (const _event of executor.finalize()) { count2++; }
  expect(count2).toBe(0);
}, 15_000);
