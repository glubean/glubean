// Engine browser-safety + FUNCTIONAL smoke — runs @glubean/engine in a REAL browser
// to prove the shared core runs the FULL common test() surface there, not just node.
// Browser scope = test() + ctx + ctx.http (HTTP) ONLY — NO plugins (owner: the
// browser supports HTTP for sure; we don't support any plugins). Each representative
// test maps to an EXPECT status; the smoke is green iff every test matches + the HTTP
// traces fired. Results are published on window.__GLUBEAN_SMOKE for the Chrome driver.
import { test, workflow } from "@glubean/sdk";
import { RunnerCore } from "@glubean/engine";
import { createGlobalThisCarrier } from "@glubean/sdk/internal";

const BASE = globalThis.location?.origin ?? "";
const okSchema = { safeParse: (d) => ({ success: true, data: d }) };
const failSchema = { safeParse: () => ({ success: false, error: { issues: [{ message: "bad", path: ["x"] }] } }) };

// ── representative tests: every common test()/ctx/HTTP API (no plugins) ──────────

const simplePass = test({ id: "simple-pass", name: "simple pass" }, async (ctx) => {
  ctx.expect(1 + 1).toBe(2);
  ctx.assert(true, "ok");
});

// By design FAILS — proves the engine's soft-fail path renders in the browser too.
const simpleFail = test({ id: "simple-fail", name: "simple fail (by design)" }, async (ctx) => {
  ctx.assert(false, "intentional failure", { actual: 1, expected: 2 });
});

const httpGet = test({ id: "http-get", name: "http GET + json + trace" }, async (ctx) => {
  const r = await ctx.http.get(`${BASE}/api/echo?x=1`).json();
  ctx.expect(r.method).toBe("GET");
  ctx.expect(r.query.x).toBe("1");
});

const httpPost = test({ id: "http-post", name: "http POST json body" }, async (ctx) => {
  const r = await ctx.http.post(`${BASE}/api/echo`, { json: { hello: "world" } }).json();
  ctx.expect(r.method).toBe("POST");
  ctx.expect(r.body.hello).toBe("world");
});

// Uses a FAILING response schema so the .json() schema hook MUST add a failed
// assertion (→ status error). A passing schema adds nothing, so a dropped hook would
// pass silently; EXPECT=error here actually guards the HTTP response-schema path.
const httpSchema = test({ id: "http-schema", name: "http response schema hook fires (fail path)" }, async (ctx) => {
  await ctx.http.get(`${BASE}/api/echo?x=1`, { schema: { response: failSchema } }).json();
});

const steps = test({ id: "steps", name: "steps state carry" })
  .setup(async () => ({ n: 0 }))
  .step("inc", async (ctx, s) => ({ ...s, n: s.n + 1 }))
  .step("assert", async (ctx, s) => {
    ctx.assert(s.n === 1, "state carried across steps");
    return s;
  });

let _retryN = 0;
const stepRetry = test({ id: "step-retry", name: "step retry fail→pass" })
  .step("flaky", { retries: 2, retryDelay: 0 }, async (ctx) => {
    _retryN += 1;
    ctx.assert(_retryN >= 2, "ok on attempt 2");
  });

const branchCond = test({ id: "branch-cond", name: "branch condition then-taken" })
  .setup(async () => ({ role: "admin", route: "" }))
  .condition(
    { predicate: (ctx, s) => s.role === "admin", message: "is admin" },
    (b) => b.step("go-admin", async (ctx, s) => ({ ...s, route: "admin" })),
    (b) => b.step("go-home", async (ctx, s) => ({ ...s, route: "home" })),
  )
  .step("assert", async (ctx, s) => { ctx.assert(s.route === "admin", "routed admin"); return s; });

const branchSwitch = test({ id: "branch-switch", name: "branch switchOn value match" })
  .setup(async () => ({ status: 404, handled: "" }))
  .switchOn((ctx, s) => s.status)(
    [
      { value: 200, then: (b) => b.step("use", async (ctx, s) => ({ ...s, handled: "use" })) },
      { value: 404, then: (b) => b.step("create", async (ctx, s) => ({ ...s, handled: "create" })) },
    ],
    (b) => b.step("fallback", async (ctx, s) => ({ ...s, handled: "fallback" })),
  )
  .step("assert", async (ctx, s) => { ctx.assert(s.handled === "create", "handled create"); return s; });

let _pollN = 0;
const poll = test({ id: "poll", name: "poll satisfied" })
  .poll("await-job", async () => { _pollN += 1; return { status: _pollN >= 3 ? "done" : "pending", n: _pollN }; }, {
    until: (ctx, res) => res.status === "done",
    every: 1,
    timeout: 5000,
    out: (s, res) => ({ ...s, n: res.n }),
  })
  .step("assert", async (ctx, s) => { ctx.assert(s.n === 3, "polled to 3"); return s; });

const validatePass = test({ id: "validate-pass", name: "validate pass" }, async (ctx) => {
  const out = ctx.validate({ a: 1 }, okSchema, "payload");
  ctx.assert(out && out.a === 1, "validated");
});

// By design FAILS (error severity → soft fail).
const validateFail = test({ id: "validate-fail", name: "validate fail (by design)" }, async (ctx) => {
  ctx.validate({}, failSchema, "payload");
});

const warn = test({ id: "warn", name: "warn" }, async (ctx) => {
  ctx.warn(false, "slow"); ctx.warn(true, "fine"); ctx.assert(true, "warned");
});

const evidence = test({ id: "evidence", name: "metric/action/event/trace" }, async (ctx) => {
  ctx.metric("latency_ms", 42, { unit: "ms", tags: { path: "/x" } });
  ctx.action({ category: "http:request", target: "GET /x", duration: 1, status: "ok" });
  ctx.event({ type: "smoke:evt", data: { n: 1 } });
  ctx.trace({ protocol: "grpc", target: "Svc/M", status: 0, durationMs: 1, ok: true });
  ctx.assert(true, "evidence emitted");
});

const skip = test({ id: "skip", name: "skip" }, async (ctx) => { ctx.skip("not applicable"); ctx.assert(true, "unreached"); });

// By design FAILS (ctx.fail throws → error).
const fail = test({ id: "fail", name: "fail (by design)" }, async (ctx) => { ctx.fail("boom"); });

const setTimeoutTest = test({ id: "set-timeout", name: "setTimeout control event" }, async (ctx) => {
  ctx.setTimeout(5000); ctx.assert(true, "timeout set");
});

const pollUntil = test({ id: "poll-until", name: "pollUntil" }, async (ctx) => {
  let n = 0;
  await ctx.pollUntil({ timeoutMs: 5000, intervalMs: 1 }, async () => { n += 1; return n >= 3; });
  ctx.assert(n === 3, "polled to 3");
});

const session = test({ id: "session", name: "session set/get/require/entries" }, async (ctx) => {
  ctx.session.set("k", "v");
  ctx.assert(ctx.session.get("k") === "v" && ctx.session.require("k") === "v" && ctx.session.entries().k === "v", "session roundtrip");
});

const vars = test({ id: "vars", name: "vars get/require/all" }, async (ctx) => {
  const all = ctx.vars.all();
  ctx.assert(ctx.vars.get("FOO") === "bar" && ctx.vars.require("FOO") === "bar" && all.FOO === "bar" && all.EMPTY === "", "vars surface");
});

const mem = test({ id: "mem", name: "getMemoryUsage browser-safe" }, async (ctx) => {
  const m = ctx.getMemoryUsage();
  // Browser has no process.memoryUsage → null; must NOT throw.
  ctx.assert(m === null || typeof m.heapUsed === "number", "memory usage null-or-shape");
});

// A built workflow is NODE-ONLY (plan 0005/0007 scope): the executor lives in
// @glubean/runner, never in the browser-safe engine. The wrapper carries the IR but
// has no self-executing fn (invocation inversion), so the engine MUST exclude the
// workflow handle at resolve — never run it (a leaked wrapper would throw "missing
// fn"). This asserts that exclusion in a REAL browser. (plan 0007)
const wfNodeOnly = workflow("wf-node-only").compute("c", (s) => s).build();

const namespace = {
  simplePass, simpleFail, httpGet, httpPost, httpSchema, steps, stepRetry,
  branchCond, branchSwitch, poll, validatePass, validateFail, warn, evidence,
  skip, fail, setTimeoutTest, pollUntil, session, vars, mem,
  // Node-only — the engine must resolve-exclude this, NOT run it (asserted below).
  wfNodeOnly,
};

// Expected status per id — the smoke is green iff every test matches its expectation.
const EXPECT = {
  "simple-pass": "ok", "simple-fail": "error", "http-get": "ok", "http-post": "ok",
  "http-schema": "error", steps: "ok", "step-retry": "ok", "branch-cond": "ok",
  "branch-switch": "ok", poll: "ok", "validate-pass": "ok", "validate-fail": "error",
  warn: "ok", evidence: "ok", skip: "skipped", fail: "error", "set-timeout": "ok",
  "poll-until": "ok", session: "ok", vars: "ok", mem: "ok",
};

async function main() {
  const events = [];
  const engine = new RunnerCore({
    // Real browser fetch — engine ky 2 drives it against the same-origin /api echo
    // endpoint (no CORS). This is the in-browser ky2→fetch path under test.
    fetch: (input, init) => fetch(input, init),
    // A fixed var set so the vars test exercises get/require/all (incl an empty var).
    env: { vars: () => ({ FOO: "bar", EMPTY: "" }), secrets: () => ({}), varsAll: () => ({ FOO: "bar", EMPTY: "" }) },
    events: { emit: (e) => events.push(e) },
    scheduler: { now: () => performance.now() },
    // Browser carrier: globalThis single-slot (sequential, which the smoke is).
    carrier: createGlobalThisCarrier(),
  });

  const defs = engine.resolve(namespace);
  // The node-only workflow handle must be excluded at resolve (never run in the
  // browser) — plan 0005/0007 scope. If a future change let the wrapper through, it
  // would surface as a runnable def here (and then throw "missing fn" at run).
  const workflowExcluded = !defs.some((d) => d.meta.id === "wf-node-only");
  const results = [];
  for (const def of defs) {
    const res = await engine.run(def);
    results.push({ id: res.id, status: res.status, assertions: res.assertions, error: res.error });
  }

  // Count ONLY the auto HTTP traces (protocol "http"): the 3 HTTP requests (GET / POST
  // / schema'd GET) must EACH emit one — the manual ctx.trace() in `evidence` is a
  // non-http protocol and must not pad this count (else a dropped auto-trace hides).
  const httpTraceCount = events.filter((e) => e.type === "trace" && e.data?.protocol === "http").length;
  const resolvedAll = Object.keys(EXPECT).every((id) => results.some((r) => r.id === id));
  // An unmapped result id (EXPECT left un-updated) is itself a mismatch — fail loudly.
  const mismatches = results
    .map((r) =>
      !(r.id in EXPECT)
        ? { id: r.id, got: r.status, want: "(no EXPECT entry — update EXPECT)" }
        : r.status !== EXPECT[r.id]
          ? { id: r.id, got: r.status, want: EXPECT[r.id] }
          : null,
    )
    .filter(Boolean);
  const ok = resolvedAll && mismatches.length === 0 && httpTraceCount >= 3 && workflowExcluded;

  return { ok, resolvedAll, mismatches, httpTraceCount, workflowExcluded, count: results.length, results };
}

main()
  .then((r) => {
    globalThis.__GLUBEAN_SMOKE = { done: true, ...r };
  })
  .catch((e) => {
    globalThis.__GLUBEAN_SMOKE = { done: true, ok: false, error: String((e && e.stack) || e) };
  });
