/**
 * engine-parity — the runner-on-engine parity instrument (plan 0005).
 *
 * Runs the SAME test module through the harness SUBPROCESS twice — once on the
 * legacy run-loop (GLUBEAN_USE_ENGINE off) and once on the engine (flag on) — and
 * asserts the RAW ExecutionEvent stream is identical. Both legs use the real
 * subprocess + real harness load semantics; the engine leg never runs in-process
 * (no installCarrier pollution of the test process — codex P1). We diff the raw
 * stream via TestExecutor.run() (pre-TimelineEvent-mapping, so control events
 * like timeout_update / session:set are visible — codex P3).
 *
 * NOTE: TestExecutor spawns the BUILT dist/harness.js, so sdk + engine + runner
 * must be built before this test runs (pretest / CI build covers it).
 *
 * Phase 0: simple tests (log / assertion / status). Grows one case per migrated
 * feature.
 */
import { test, expect, afterAll, beforeAll } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { TestExecutor } from "./executor.js";
import type { ExecutionEvent } from "./executor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUNNER_ROOT = resolve(__dirname, "..");
const TMP_DIR = join(RUNNER_ROOT, ".tmp-engine-parity");
let tmpSeq = 0;

// A tiny deterministic local HTTP server for the ky-parity cases (httpbin.org is
// down + nondeterministic — see handoff). Both legs hit the SAME baseUrl so only
// the durations differ run-to-run (normalize() zeroes those).
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, items: [1, 2, 3] }));
      return;
    }
    if (url.pathname === "/teapot") {
      res.writeHead(418, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "teapot" }));
      return;
    }
    if (url.pathname === "/big") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], note: "x".repeat(100) }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await new Promise<void>((r) => server.close(() => r()));
});

async function makeTempFile(content: string, name = "test.ts"): Promise<string> {
  const dir = join(TMP_DIR, String(tmpSeq++));
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, content);
  return file;
}

type RunCtx = { vars?: Record<string, string>; secrets?: Record<string, string>; retryCount?: number };
/** ExecutorOptions exercised by the ky full-trace parity cases — passed to BOTH legs
 *  so the only difference is legacy vs engine, never the trace policy. */
type ExecOpts = { emitFullTrace?: boolean; inferSchema?: boolean; truncateArrays?: boolean };

/** Collect the raw ExecutionEvent stream from one harness subprocess run. */
async function rawEvents(
  file: string,
  testId: string,
  useEngine: boolean,
  ctx: RunCtx = {},
  exec: ExecOpts = {},
): Promise<ExecutionEvent[]> {
  // engine leg: flag on + allowlist EXACTLY this test id (plan 0005 per-test routing).
  // legacy leg: GLUBEAN_USE_ENGINE=0 forces legacy — REQUIRED post-cutover since the
  // engine is now the default; without the pin both legs would run the engine and the
  // diff would be vacuous.
  const executor = new TestExecutor({
    ...exec,
    env: useEngine
      ? { GLUBEAN_USE_ENGINE: "1", GLUBEAN_ENGINE_TESTIDS: testId }
      : { GLUBEAN_USE_ENGINE: "0" },
  });
  const events: ExecutionEvent[] = [];
  const runCtx = {
    vars: ctx.vars ?? {},
    secrets: ctx.secrets ?? {},
    ...(ctx.retryCount !== undefined ? { retryCount: ctx.retryCount } : {}),
  };
  for await (const e of executor.run(`file://${file}`, testId, runCtx)) {
    events.push(e);
  }
  return events;
}

/** Recursively zero any wall-clock duration field (duration / durationMs) — these
 *  appear top-level (step_end.durationMs) AND nested in trace/action `data`. */
function zeroDurationsDeep(v: unknown): void {
  if (Array.isArray(v)) {
    v.forEach(zeroDurationsDeep);
    return;
  }
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if ((k === "duration" || k === "durationMs" || k === "elapsedMs") && typeof val === "number") {
        (v as Record<string, unknown>)[k] = 0;
      } else {
        zeroDurationsDeep(val);
      }
    }
  }
}

/** Drop fields that legitimately differ run-to-run (memory, wall-clock durations). */
function normalize(events: ExecutionEvent[]): unknown[] {
  return events.map((e) => {
    // Deep clone first so zeroing nested duration fields never mutates the original.
    const c = JSON.parse(JSON.stringify(e)) as Record<string, unknown>;
    delete c.peakMemoryBytes;
    delete c.peakMemoryMB;
    delete c.peakMemory;
    delete c.stack; // throw-site specific (re-raised error has a different stack)
    delete c.ts; // session:set carries Date.now()
    zeroDurationsDeep(c); // top-level + nested (trace.data / action.data) durations
    // The HTTP auto-trace metric value IS the (nondeterministic) duration.
    if (c.type === "metric" && c.name === "http_duration_ms" && typeof c.value === "number") {
      c.value = 0;
    }
    // Full-trace headers carry a wall-clock `date` (the two legs run sequentially).
    if (c.type === "trace") {
      const data = c.data as { requestHeaders?: Record<string, unknown>; responseHeaders?: Record<string, unknown> } | undefined;
      delete data?.requestHeaders?.date;
      delete data?.responseHeaders?.date;
    }
    return c;
  });
}

async function assertParity(content: string, testId: string, ctx: RunCtx = {}, exec: ExecOpts = {}): Promise<void> {
  const file = await makeTempFile(content);
  const legacy = normalize(await rawEvents(file, testId, false, ctx, exec));
  const engine = normalize(await rawEvents(file, testId, true, ctx, exec));
  // Guard against a VACUOUS green: if the module failed to import (e.g. a malformed
  // fixture), both legs error identically before any test runs and toEqual passes
  // without comparing real output. A real run always emits a "start" event.
  expect(legacy.some((e) => (e as { type?: string }).type === "start")).toBe(true);
  expect(engine).toEqual(legacy);
}

// Each case spawns the harness subprocess TWICE (flag off/on), so give it generous
// headroom — the default 5s flakes when the machine is loaded (many subprocess-
// spawning test files in parallel).
const ptest = (name: string, fn: () => Promise<void>) => test(name, fn, 20_000);

const MODULE = `
import { test, configure, defineClientFactory } from "@glubean/sdk";
export const passingTest = test(
  { id: "passingTest", name: "Passing Test", tags: ["unit"] },
  async (ctx) => { ctx.log("Hello from test"); ctx.assert(true, "Should pass"); }
);
export const failingTest = test(
  { id: "failingTest", name: "Failing Test" },
  async (ctx) => { ctx.assert(false, "Should fail", { actual: "bad", expected: "good" }); }
);
export const throwingTest = test(
  { id: "throwingTest", name: "Throwing Test" },
  async (ctx) => { ctx.assert(true, "before throw"); throw new Error("boom"); }
);
export const envTest = test(
  { id: "envTest", name: "Env Test" },
  async (ctx) => { ctx.assert(ctx.vars.require("GLUBEAN_PARITY_ENV") === "from-system", "reads system env"); }
);
export const sessionTest = test(
  { id: "sessionTest", name: "Session Test" },
  async (ctx) => { ctx.session.set("sk", "sv"); ctx.assert(ctx.session.get("sk") === "sv", "session roundtrip"); }
);
export const sessionRequireTest = test(
  { id: "sessionRequireTest", name: "Session Require/Entries" },
  async (ctx) => { ctx.session.set("k", "v"); const all = ctx.session.entries(); ctx.assert(ctx.session.require("k") === "v" && all.k === "v", "require+entries"); }
);
export const sessionRequireMissingTest = test(
  { id: "sessionRequireMissingTest", name: "Session Require Missing" },
  async (ctx) => { ctx.session.require("nope"); ctx.assert(true, "unreached"); }
);
export const warnTest = test(
  { id: "warnTest", name: "Warn Test" },
  async (ctx) => { ctx.warn(false, "slow"); ctx.warn(true, "fine"); ctx.assert(true, "warned"); }
);
export const emptyVarTest = test(
  { id: "emptyVarTest", name: "Empty Var Test" },
  async (ctx) => { ctx.vars.require("GLUBEAN_EMPTY"); ctx.assert(true, "unreached"); }
);
export const varsAllTest = test(
  { id: "varsAllTest", name: "Vars All Test" },
  // E is an EMPTY var — legacy all() keeps it as ""; the engine must too (NOT drop it
  // to a fallback via the proxy — codex Phase-8 P2). actual:all byte-compares the map.
  async (ctx) => { const all = ctx.vars.all(); ctx.assert(all.A === "1" && all.E === "", "vars.all() copy (empty preserved)", { actual: all }); }
);
export const memUsageTest = test(
  { id: "memUsageTest", name: "Memory Usage Test" },
  async (ctx) => { const m = ctx.getMemoryUsage(); ctx.assert(m !== null && typeof m.heapUsed === "number", "memory shape"); }
);
export const namedErrorTest = test(
  { id: "namedErrorTest", name: "Named Error Test" },
  async () => { throw new TypeError("typed boom"); }
);
export const stepsTest = test("stepsTest")
  .setup(async () => ({ n: 0 }))
  .step("inc", async (ctx, s) => { ctx.log("incrementing"); return { ...s, n: s.n + 1 }; })
  .step("check", async (ctx, s) => { ctx.assert(s.n === 1, "n is 1"); return s; });
export const failingStepTest = test("failingStepTest")
  .step("bad", async (ctx) => { ctx.assert(false, "step fails", { actual: 1, expected: 2 }); });
export const multiStepFailTest = test("multiStepFailTest")
  .step("first", async (ctx) => { ctx.assert(false, "first fails"); })
  .step("second", async (ctx) => { ctx.assert(true, "skipped — never runs"); })
  .step("third", async (ctx) => { ctx.assert(true, "skipped too"); });
let _retryN = 0;
export const stepRetryTest = test("stepRetryTest")
  .step("flaky", { retries: 2, retryDelay: 0 }, async (ctx) => { _retryN++; ctx.assert(_retryN >= 2, "ok on attempt 2"); });
export const stepTimeoutTest = test("stepTimeoutTest")
  .step("slow", { timeout: 10 }, async () => { await new Promise((r) => setTimeout(r, 100)); });
export const condThenTest = test("condThenTest")
  .setup(async () => ({ role: "admin", route: "" }))
  .condition(
    { predicate: (ctx, s) => s.role === "admin", message: "is admin" },
    (b) => b.step("go-admin", async (ctx, s) => ({ ...s, route: "admin" })),
    (b) => b.step("go-home", async (ctx, s) => ({ ...s, route: "home" })),
  )
  .step("assert-route", async (ctx, s) => { ctx.assert(s.route === "admin", "route is admin"); return s; });
export const condElseTest = test("condElseTest")
  .setup(async () => ({ role: "guest", route: "" }))
  .condition(
    { predicate: (ctx, s) => s.role === "admin", message: "is admin" },
    (b) => b.step("go-admin", async (ctx, s) => ({ ...s, route: "admin" })),
    (b) => b.step("go-home", async (ctx, s) => ({ ...s, route: "home" })),
  )
  .step("assert-route", async (ctx, s) => { ctx.assert(s.route === "home", "route is home"); return s; });
export const switchOnTest = test("switchOnTest")
  .setup(async () => ({ status: 404, handled: "" }))
  .switchOn((ctx, s) => s.status)(
    [
      { value: 200, then: (b) => b.step("use", async (ctx, s) => ({ ...s, handled: "use" })) },
      { value: 404, then: (b) => b.step("create", async (ctx, s) => ({ ...s, handled: "create" })) },
    ],
    (b) => b.step("fallback", async (ctx, s) => ({ ...s, handled: "fallback" })),
  )
  .step("assert", async (ctx, s) => { ctx.assert(s.handled === "create", "handled=create"); return s; });
export const branchFailTest = test("branchFailTest")
  .setup(async () => ({}))
  .condition(
    { predicate: () => { throw new Error("predicate boom"); }, message: "decide" },
    (b) => b.step("yes", async (ctx, s) => s),
    (b) => b.step("no", async (ctx, s) => s),
  )
  .step("after", async (ctx, s) => { ctx.assert(true, "unreached"); return s; });
export const retryTest = test(
  { id: "retryTest", name: "Retry Test" },
  async (ctx) => { ctx.assert(ctx.retryCount === 2, "retry count", { actual: ctx.retryCount, expected: 2 }); }
);
export const validatorTest = test(
  { id: "validatorTest", name: "Validator Test" },
  async (ctx) => { ctx.vars.require("V", (v) => v === "good" || "must be good"); ctx.assert(true, "unreached"); }
);
export const skipReasonTest = test(
  { id: "skipReasonTest", name: "Skip Reason Test" },
  async (ctx) => { ctx.log("before skip"); ctx.skip("not ready"); ctx.assert(true, "unreached"); }
);
export const skipNoReasonTest = test(
  { id: "skipNoReasonTest", name: "Skip No Reason Test" },
  async (ctx) => { ctx.skip(); }
);
export const failTest = test(
  { id: "failTest", name: "Fail Test" },
  async (ctx) => { ctx.assert(true, "before fail"); ctx.fail("boom failure"); ctx.assert(true, "unreached"); }
);
export const stepSkipTest = test("stepSkipTest")
  .step("one", async (ctx) => { ctx.assert(true, "first ok"); })
  .step("skip-here", async (ctx) => { ctx.skip("skip from step"); })
  .step("never", async (ctx) => { ctx.assert(true, "unreached"); });
export const stepFailTest = test("stepFailTest")
  .step("boom", async (ctx) => { ctx.fail("fail in step"); })
  .step("never", async (ctx) => { ctx.assert(true, "unreached"); });
export const branchSkipTest = test("branchSkipTest")
  .setup(async () => ({}))
  .condition(
    { predicate: (ctx) => { ctx.skip("skip in predicate"); return true; }, message: "decide" },
    (b) => b.step("yes", async (ctx, s) => s),
    (b) => b.step("no", async (ctx, s) => s),
  )
  .step("after", async (ctx, s) => { ctx.assert(true, "unreached"); return s; });
export const stepSkipAfterFailTest = test("stepSkipAfterFailTest")
  .step("fail-then-skip", async (ctx) => { ctx.assert(false, "real failure", { actual: 1, expected: 2 }); ctx.skip("masked"); })
  .step("never", async (ctx) => { ctx.assert(true, "unreached"); });
const okSchema = { safeParse: (d) => ({ success: true, data: d }) };
const failSchema = { safeParse: () => ({ success: false, error: { issues: [{ message: "bad value", path: ["field"] }] } }) };
export const validatePassTest = test(
  { id: "validatePassTest", name: "Validate Pass" },
  async (ctx) => { const out = ctx.validate({ a: 1 }, okSchema, "payload"); ctx.assert(out && out.a === 1, "returns parsed data"); }
);
export const validateErrorTest = test(
  { id: "validateErrorTest", name: "Validate Error" },
  async (ctx) => { ctx.validate({ a: 1 }, failSchema, "payload"); }
);
export const validateWarnTest = test(
  { id: "validateWarnTest", name: "Validate Warn" },
  async (ctx) => { ctx.validate({}, failSchema, "soft", { severity: "warn" }); ctx.assert(true, "still passes"); }
);
export const validateFatalTest = test(
  { id: "validateFatalTest", name: "Validate Fatal" },
  async (ctx) => { ctx.validate({}, failSchema, "hard", { severity: "fatal" }); ctx.assert(true, "unreached"); }
);
const throwSchema = { parse: () => { const e = new Error("nope"); e.issues = [{ message: "p issue", path: ["x"] }]; throw e; } };
export const validateParseFallbackTest = test(
  { id: "validateParseFallbackTest", name: "Validate parse fallback" },
  async (ctx) => { ctx.validate({}, throwSchema, "parsed"); }
);
export const validateInStepTest = test("validateInStepTest")
  .step("vstep", async (ctx) => { ctx.validate({}, failSchema, "in-step"); });
export const metricTest = test(
  { id: "metricTest", name: "Metric Test" },
  async (ctx) => {
    ctx.metric("latency_ms", 42, { unit: "ms", tags: { endpoint: "/x", method: "GET" } });
    ctx.metric("bare_count", 7);
    ctx.assert(true, "metrics emitted");
  }
);
export const actionTest = test(
  { id: "actionTest", name: "Action Test" },
  async (ctx) => {
    ctx.action({ category: "browser:click", target: "#submit", duration: 12, status: "ok", detail: { x: 1 } });
    ctx.assert(true, "action emitted");
  }
);
export const eventTest = test(
  { id: "eventTest", name: "Event Test" },
  async (ctx) => {
    ctx.event({ type: "mcp:connected", data: { server: "weather", tools: ["get_weather"] } });
    ctx.assert(true, "event emitted");
  }
);
export const metricInStepTest = test("metricInStepTest")
  .step("emit", async (ctx) => {
    ctx.metric("step_metric", 3, { unit: "count" });
    ctx.action({ category: "db:query", target: "users", duration: 5, status: "ok" });
    ctx.event({ type: "db:slow", data: { ms: 9 } });
    ctx.assert(true, "in-step events");
  });
export const httpGetTraceTest = test(
  { id: "httpGetTraceTest", name: "HTTP GET trace" },
  async (ctx) => {
    const base = ctx.vars.require("BASE_URL");
    const res = await ctx.http.get(base + "/json");
    ctx.assert(res.status === 200, "status 200", { actual: res.status, expected: 200 });
  }
);
export const httpErrorTraceTest = test(
  { id: "httpErrorTraceTest", name: "HTTP error trace" },
  async (ctx) => {
    const base = ctx.vars.require("BASE_URL");
    const res = await ctx.http.get(base + "/teapot");
    ctx.assert(res.status === 418, "status 418", { actual: res.status, expected: 418 });
  }
);
export const explicitTraceTest = test(
  { id: "explicitTraceTest", name: "Explicit ctx.trace" },
  async (ctx) => {
    ctx.trace({ protocol: "grpc", target: "Greeter/SayHello", status: 0, durationMs: 5, ok: true, name: "SayHello" });
    ctx.assert(true, "traced");
  }
);
export const httpTraceInStepTest = test("httpTraceInStepTest")
  .step("call", async (ctx) => {
    const base = ctx.vars.require("BASE_URL");
    const res = await ctx.http.get(base + "/json");
    ctx.assert(res.status === 200, "200 in step");
  });
// codex 4c-e P2: a configure() plugin resolves trace/action/event from the CARRIER
// runtime (configure/plugin.ts), not ctx. The engine must forward them through
// scope.runtime or plugin evidence silently no-ops on the engine leg.
const evidencePlugin = defineClientFactory((rt) => ({
  fire: () => {
    rt.trace({ protocol: "grpc", target: "Svc/Method", status: 0, durationMs: 1, ok: true, name: "Method" });
    rt.action({ category: "mcp:call", target: "tool", duration: 2, status: "ok", detail: { tool: "x" } });
    rt.event({ type: "plugin:fired", data: { n: 1 } });
  },
}));
const evidenceCfg = configure({ plugins: { evidence: evidencePlugin } });
export const pluginRuntimeTest = test(
  { id: "pluginRuntimeTest", name: "Plugin runtime evidence" },
  async (ctx) => { evidenceCfg.evidence.fire(); ctx.assert(true, "plugin fired evidence"); }
);
export const httpPrefixLeadingSlashTest = test(
  { id: "httpPrefixLeadingSlashTest", name: "prefixUrl + leading slash" },
  async (ctx) => {
    const base = ctx.vars.require("BASE_URL");
    const res = await ctx.http.get("/json", { prefixUrl: base });
    ctx.assert(res.status === 200, "200 via prefix", { actual: res.status, expected: 200 });
  }
);
export const httpExtendPrefixTest = test(
  { id: "httpExtendPrefixTest", name: "extend prefixUrl" },
  async (ctx) => {
    const base = ctx.vars.require("BASE_URL");
    const api = ctx.http.extend({ prefixUrl: base });
    const res = await api.get("json");
    ctx.assert(res.status === 200, "200 via extend prefix");
  }
);
export const httpEmptySearchParamsTest = test(
  { id: "httpEmptySearchParamsTest", name: "empty searchParams removed" },
  async (ctx) => {
    const base = ctx.vars.require("BASE_URL");
    const res = await ctx.http.get(base + "/json", { searchParams: {} });
    ctx.assert(res.url.indexOf("?") === -1, "no bare ?", { actual: res.url });
  }
);
export const httpQuerySchemaFailTest = test(
  { id: "httpQuerySchemaFailTest", name: "query schema fail" },
  async (ctx) => {
    const base = ctx.vars.require("BASE_URL");
    await ctx.http.get(base + "/json", { searchParams: { a: "1" }, schema: { query: failSchema } });
    ctx.assert(true, "after query schema");
  }
);
export const httpRequestSchemaFailTest = test(
  { id: "httpRequestSchemaFailTest", name: "request body schema fail" },
  async (ctx) => {
    const base = ctx.vars.require("BASE_URL");
    await ctx.http.post(base + "/json", { json: { x: 1 }, schema: { request: failSchema } });
    ctx.assert(true, "after request schema");
  }
);
export const httpRequestHeaderSchemaFailTest = test(
  { id: "httpRequestHeaderSchemaFailTest", name: "request header schema fail" },
  async (ctx) => {
    const base = ctx.vars.require("BASE_URL");
    await ctx.http.get(base + "/json", { headers: { "x-tenant": "t1" }, schema: { requestHeaders: failSchema } });
    ctx.assert(true, "after request header schema");
  }
);
export const httpResponseSchemaPassTest = test(
  { id: "httpResponseSchemaPassTest", name: "response body schema pass" },
  async (ctx) => {
    const base = ctx.vars.require("BASE_URL");
    // CHAINED .json() on the ky ResponsePromise — the path response-schema validation
    // actually hooks (await-first → res.json() bypasses it on BOTH legs; codex 4f P2).
    const body = await ctx.http.get(base + "/json", { schema: { response: okSchema } }).json();
    ctx.assert(body.ok === true, "body ok");
  }
);
export const httpResponseSchemaFailTest = test(
  { id: "httpResponseSchemaFailTest", name: "response body schema fail" },
  async (ctx) => {
    const base = ctx.vars.require("BASE_URL");
    await ctx.http.get(base + "/json", { schema: { response: failSchema } }).json();
    ctx.assert(true, "after response schema");
  }
);
export const httpResponseHeaderSchemaFailTest = test(
  { id: "httpResponseHeaderSchemaFailTest", name: "response header schema fail" },
  async (ctx) => {
    const base = ctx.vars.require("BASE_URL");
    await ctx.http.get(base + "/json", { schema: { responseHeaders: failSchema } });
    ctx.assert(true, "after response header schema");
  }
);
export const httpFullTraceGetTest = test(
  { id: "httpFullTraceGetTest", name: "full-trace GET" },
  async (ctx) => {
    const base = ctx.vars.require("BASE_URL");
    const res = await ctx.http.get(base + "/json");
    ctx.assert(res.status === 200, "200");
  }
);
export const httpFullTracePostTest = test(
  { id: "httpFullTracePostTest", name: "full-trace POST captures request body" },
  async (ctx) => {
    const base = ctx.vars.require("BASE_URL");
    const res = await ctx.http.post(base + "/json", { json: { name: "bob", tags: ["a", "b"] } });
    ctx.assert(res.status === 200, "200");
  }
);
export const httpTruncateBodyTest = test(
  { id: "httpTruncateBodyTest", name: "full-trace + truncateArrays truncates response body" },
  async (ctx) => {
    const base = ctx.vars.require("BASE_URL");
    const res = await ctx.http.get(base + "/big");
    ctx.assert(res.status === 200, "200");
  }
);
export const assertTruncateTest = test(
  { id: "assertTruncateTest", name: "assertion actual/expected truncated on pass" },
  async (ctx) => {
    ctx.assert(true, "big arrays", { actual: [0, 1, 2, 3, 4, 5, 6], expected: [0, 1, 2, 3, 4, 5, 6] });
  }
);
let _pollN = 0;
export const pollSatisfiedTest = test("pollSatisfiedTest")
  .poll("await-job", async () => { _pollN += 1; return { status: _pollN >= 3 ? "done" : "pending", n: _pollN }; }, {
    until: (ctx, res) => res.status === "done",
    every: 1,
    timeout: 5000,
    out: (s, res) => ({ ...s, done: true, n: res.n }),
  })
  .step("assert", async (ctx, s) => { ctx.assert(s.done === true && s.n === 3, "polled to done at n=3"); });
export const pollExhaustedTest = test("pollExhaustedTest")
  .poll("never", async () => ({ status: "pending" }), {
    until: (ctx, res) => res.status === "done",
    every: 1,
    maxAttempts: 3,
    perAttemptTimeout: 1000,
  });
export const pollSkipTest = test("pollSkipTest")
  .poll("maybe", async (ctx) => { ctx.skip("not applicable"); return {}; }, {
    until: () => true,
    timeout: 5000,
  })
  .step("after", async (ctx) => { ctx.assert(true, "unreached"); });
export const pollBadUntilTest = test("pollBadUntilTest")
  .poll("bad", async () => ({}), {
    until: () => "done",
    timeout: 5000,
  });
export const pollFnErrorTest = test("pollFnErrorTest")
  .poll("boom", async () => { throw new Error("fn boom"); }, {
    until: () => true,
    timeout: 5000,
  });
export const setTimeoutTest = test(
  { id: "setTimeoutTest", name: "Set Timeout" },
  async (ctx) => { ctx.setTimeout(5000); ctx.assert(true, "set timeout"); }
);
export const pollUntilSuccessTest = test(
  { id: "pollUntilSuccessTest", name: "pollUntil success" },
  async (ctx) => { let n = 0; await ctx.pollUntil({ timeoutMs: 5000, intervalMs: 1 }, async () => { n += 1; return n >= 3; }); ctx.assert(n === 3, "polled to 3"); }
);
export const pollUntilRetryErrorsTest = test(
  { id: "pollUntilRetryErrorsTest", name: "pollUntil retries through errors" },
  async (ctx) => { let n = 0; await ctx.pollUntil({ timeoutMs: 5000, intervalMs: 1 }, async () => { n += 1; if (n < 3) throw new Error("not yet"); return true; }); ctx.assert(n === 3, "retried to 3"); }
);
export const pollUntilSilentTimeoutTest = test(
  { id: "pollUntilSilentTimeoutTest", name: "pollUntil silent timeout" },
  async (ctx) => { let fired = false; await ctx.pollUntil({ timeoutMs: 20, intervalMs: 5, onTimeout: () => { fired = true; } }, async () => false); ctx.assert(fired === true, "onTimeout fired"); }
);
export const pollUntilThrowTimeoutTest = test(
  { id: "pollUntilThrowTimeoutTest", name: "pollUntil throw timeout" },
  async (ctx) => { await ctx.pollUntil({ timeoutMs: 20, intervalMs: 5 }, async () => false); ctx.assert(true, "unreached"); }
);
`;

ptest("engine parity: passing simple test (start + log + assertion + status)", async () => {
  await assertParity(MODULE, "passingTest");
});

ptest("engine parity: failing simple test (soft assertion → status still completed)", async () => {
  await assertParity(MODULE, "failingTest");
});

ptest("engine parity: throwing test (re-raised → dispatcher reports failed)", async () => {
  await assertParity(MODULE, "throwingTest");
});

ptest("engine parity: system env fallback (ctx.vars.require → process.env)", async () => {
  // Both subprocesses inherit this; the engine path must keep the .env→process.env
  // fallback (codex P2 / plan 0005 §E) or ctx.vars.require would throw on the engine leg.
  process.env.GLUBEAN_PARITY_ENV = "from-system";
  try {
    await assertParity(MODULE, "envTest");
  } finally {
    delete process.env.GLUBEAN_PARITY_ENV;
  }
});

ptest("engine parity: session.set (first-class session:set control event)", async () => {
  await assertParity(MODULE, "sessionTest");
});

ptest("engine parity: session.require + session.entries", async () => {
  await assertParity(MODULE, "sessionRequireTest");
});

ptest("engine parity: session.require throws on a missing key (test fails)", async () => {
  await assertParity(MODULE, "sessionRequireMissingTest");
});

ptest("engine parity: warn (first-class warning events)", async () => {
  await assertParity(MODULE, "warnTest");
});

ptest("engine parity: vars.require throws for an EMPTY value (empty = unset)", async () => {
  // The codex edge: an empty explicit value with no system fallback must throw on
  // require in BOTH paths (not return undefined on the engine path).
  await assertParity(MODULE, "emptyVarTest", { vars: { GLUBEAN_EMPTY: "" } });
});

ptest("engine parity: ctx.vars.all() returns a raw copy incl empty vars (codex Phase-8 P1+P2)", async () => {
  await assertParity(MODULE, "varsAllTest", { vars: { A: "1", E: "" } });
});

ptest("engine parity: ctx.getMemoryUsage() returns a node memory snapshot (shape)", async () => {
  await assertParity(MODULE, "memUsageTest");
});

ptest("engine parity: named error preserves failure classification (reason)", async () => {
  // A TypeError must re-raise with its name so classifyErrorReason() tags the same
  // reason on both paths (codex P2) — else the failed status' `reason` would differ.
  await assertParity(MODULE, "namedErrorTest");
});

ptest("engine parity: retryCount surfaced on ctx + start event", async () => {
  // The host's test-level retry attempt must reach ctx.retryCount + the start event
  // on the engine path too (codex P2).
  await assertParity(MODULE, "retryTest", { retryCount: 2 });
});

ptest("engine parity: require() validator callback runs (codex P2)", async () => {
  // A failing validator must throw on BOTH paths (engine ignoring it would let an
  // invalid value pass).
  await assertParity(MODULE, "validatorTest", { vars: { V: "bad" } });
});

ptest("engine parity: linear steps (step_start/step_end + per-step stepIndex)", async () => {
  await assertParity(MODULE, "stepsTest");
});

ptest("engine parity: failing step → 'One or more steps failed' (failed + exit 1)", async () => {
  await assertParity(MODULE, "failingStepTest");
});

ptest("engine parity: failed step skips remaining steps (skipped step_end tree)", async () => {
  await assertParity(MODULE, "multiStepFailTest");
});

ptest("engine parity: step retry (fail→pass; attempts/retriesUsed + Retrying log)", async () => {
  await assertParity(MODULE, "stepRetryTest");
});

ptest("engine parity: step timeout (StepTimeoutError, terminal — no retry)", async () => {
  await assertParity(MODULE, "stepTimeoutTest");
});

ptest("engine parity: branch condition — then-case taken (else skipped)", async () => {
  await assertParity(MODULE, "condThenTest");
});

ptest("engine parity: branch condition — else/default taken (then skipped)", async () => {
  await assertParity(MODULE, "condElseTest");
});

ptest("engine parity: branch switchOn — value case matched (others + default skipped)", async () => {
  await assertParity(MODULE, "switchOnTest");
});

ptest("engine parity: branch decision failure (predicate throws → branch error)", async () => {
  await assertParity(MODULE, "branchFailTest");
});

ptest("engine parity: ctx.skip(reason) in simple test → skipped status carries reason", async () => {
  await assertParity(MODULE, "skipReasonTest");
});

ptest("engine parity: ctx.skip() with no reason → skipped status (no reason field)", async () => {
  await assertParity(MODULE, "skipNoReasonTest");
});

ptest("engine parity: ctx.fail(msg) → failed assertion + re-raised (failed + exit 1)", async () => {
  await assertParity(MODULE, "failTest");
});

ptest("engine parity: ctx.skip() in a step → skipped step_end + remaining skipped + skipped", async () => {
  await assertParity(MODULE, "stepSkipTest");
});

ptest("engine parity: ctx.fail() in a step → step fails ('One or more steps failed')", async () => {
  await assertParity(MODULE, "stepFailTest");
});

ptest("engine parity: ctx.skip() in a branch predicate → whole test skipped", async () => {
  await assertParity(MODULE, "branchSkipTest");
});

ptest("engine parity: failed assertion before ctx.skip() in a step → failure wins", async () => {
  await assertParity(MODULE, "stepSkipAfterFailTest");
});

ptest("engine parity: ctx.validate success → schema_validation(ok) + returns data", async () => {
  await assertParity(MODULE, "validatePassTest");
});

ptest("engine parity: ctx.validate error → schema_validation + failed assertion (soft)", async () => {
  await assertParity(MODULE, "validateErrorTest");
});

ptest("engine parity: ctx.validate warn → schema_validation + warning (test passes)", async () => {
  await assertParity(MODULE, "validateWarnTest");
});

ptest("engine parity: ctx.validate fatal → failed assertion + abort (failed + exit 1)", async () => {
  await assertParity(MODULE, "validateFatalTest");
});

ptest("engine parity: ctx.validate parse() fallback path (throws → issues extracted)", async () => {
  await assertParity(MODULE, "validateParseFallbackTest");
});

ptest("engine parity: ctx.validate in a step → schema_validation carries stepIndex; step fails", async () => {
  await assertParity(MODULE, "validateInStepTest");
});

ptest("engine parity: ctx.metric (with unit+tags, and bare) → metric events", async () => {
  await assertParity(MODULE, "metricTest");
});

ptest("engine parity: ctx.action → action event (data passthrough)", async () => {
  await assertParity(MODULE, "actionTest");
});

ptest("engine parity: ctx.event → generic event (non-workflow passthrough)", async () => {
  await assertParity(MODULE, "eventTest");
});

ptest("engine parity: ctx.metric/action/event inside a step carry stepIndex", async () => {
  await assertParity(MODULE, "metricInStepTest");
});

ptest("engine parity: HTTP GET auto-trace (rich Trace + derived action + http_duration_ms)", async () => {
  await assertParity(MODULE, "httpGetTraceTest", { vars: { BASE_URL: baseUrl } });
});

ptest("engine parity: HTTP error auto-trace (4xx → ok:false + action status error)", async () => {
  await assertParity(MODULE, "httpErrorTraceTest", { vars: { BASE_URL: baseUrl } });
});

ptest("engine parity: explicit ctx.trace (non-http protocol) → trace + derived action", async () => {
  await assertParity(MODULE, "explicitTraceTest");
});

ptest("engine parity: HTTP auto-trace inside a step carries stepIndex", async () => {
  await assertParity(MODULE, "httpTraceInStepTest", { vars: { BASE_URL: baseUrl } });
});

ptest("engine parity: configure() plugin trace/action/event via runtime carrier (codex 4c-e P2)", async () => {
  await assertParity(MODULE, "pluginRuntimeTest");
});

ptest("engine parity: ky prefixUrl + leading-slash path normalization", async () => {
  await assertParity(MODULE, "httpPrefixLeadingSlashTest", { vars: { BASE_URL: baseUrl } });
});

ptest("engine parity: ky .extend({prefixUrl}) preserves normalization", async () => {
  await assertParity(MODULE, "httpExtendPrefixTest", { vars: { BASE_URL: baseUrl } });
});

ptest("engine parity: ky empty searchParams removed (no bare '?')", async () => {
  await assertParity(MODULE, "httpEmptySearchParamsTest", { vars: { BASE_URL: baseUrl } });
});

ptest("engine parity: ky schema.query fail → schema_validation + failed assertion", async () => {
  await assertParity(MODULE, "httpQuerySchemaFailTest", { vars: { BASE_URL: baseUrl } });
});

ptest("engine parity: ky schema.request fail → schema_validation + failed assertion", async () => {
  await assertParity(MODULE, "httpRequestSchemaFailTest", { vars: { BASE_URL: baseUrl } });
});

ptest("engine parity: ky schema.requestHeaders fail → schema_validation + failed assertion", async () => {
  await assertParity(MODULE, "httpRequestHeaderSchemaFailTest", { vars: { BASE_URL: baseUrl } });
});

ptest("engine parity: ky schema.response pass via .json() monkey-patch", async () => {
  await assertParity(MODULE, "httpResponseSchemaPassTest", { vars: { BASE_URL: baseUrl } });
});

ptest("engine parity: ky schema.response fail via .json() monkey-patch", async () => {
  await assertParity(MODULE, "httpResponseSchemaFailTest", { vars: { BASE_URL: baseUrl } });
});

ptest("engine parity: ky schema.responseHeaders fail → schema_validation (afterResponse hook)", async () => {
  await assertParity(MODULE, "httpResponseHeaderSchemaFailTest", { vars: { BASE_URL: baseUrl } });
});

ptest("engine parity: emitFullTrace GET (request/response headers + response body)", async () => {
  await assertParity(MODULE, "httpFullTraceGetTest", { vars: { BASE_URL: baseUrl } }, { emitFullTrace: true });
});

ptest("engine parity: emitFullTrace POST captures request body", async () => {
  await assertParity(MODULE, "httpFullTracePostTest", { vars: { BASE_URL: baseUrl } }, { emitFullTrace: true });
});

ptest("engine parity: emitFullTrace + inferSchema → responseSchema on trace", async () => {
  await assertParity(MODULE, "httpFullTraceGetTest", { vars: { BASE_URL: baseUrl } }, { emitFullTrace: true, inferSchema: true });
});

ptest("engine parity: emitFullTrace + truncateArrays truncates the response body", async () => {
  await assertParity(MODULE, "httpTruncateBodyTest", { vars: { BASE_URL: baseUrl } }, { emitFullTrace: true, truncateArrays: true });
});

ptest("engine parity: truncateArrays truncates a passing assertion's actual/expected", async () => {
  await assertParity(MODULE, "assertTruncateTest", {}, { truncateArrays: true });
});

ptest("engine parity: poll satisfied after N attempts (poll event + out threads state)", async () => {
  await assertParity(MODULE, "pollSatisfiedTest");
});

ptest("engine parity: poll exhausted (maxAttempts → failed + exhausted)", async () => {
  await assertParity(MODULE, "pollExhaustedTest");
});

ptest("engine parity: poll ctx.skip() in fn → skipped step + whole test skipped", async () => {
  await assertParity(MODULE, "pollSkipTest");
});

ptest("engine parity: poll until returns non-boolean → poll error", async () => {
  await assertParity(MODULE, "pollBadUntilTest");
});

ptest("engine parity: poll fn throws → poll error", async () => {
  await assertParity(MODULE, "pollFnErrorTest");
});

ptest("engine parity: ctx.setTimeout → timeout_update control event", async () => {
  await assertParity(MODULE, "setTimeoutTest");
});

ptest("engine parity: ctx.pollUntil succeeds after multiple polls", async () => {
  await assertParity(MODULE, "pollUntilSuccessTest");
});

ptest("engine parity: ctx.pollUntil retries through errors", async () => {
  await assertParity(MODULE, "pollUntilRetryErrorsTest");
});

ptest("engine parity: ctx.pollUntil silent timeout (onTimeout, no throw)", async () => {
  await assertParity(MODULE, "pollUntilSilentTimeoutTest");
});

ptest("engine parity: ctx.pollUntil timeout throws (test fails)", async () => {
  await assertParity(MODULE, "pollUntilThrowTimeoutTest");
});
