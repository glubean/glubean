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
import { TestExecutor } from "./executor.js";
import type { ExecutionEvent } from "./executor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RUNNER_ROOT = resolve(__dirname, "..");
const TMP_DIR = join(RUNNER_ROOT, ".tmp-engine-parity");
let tmpSeq = 0;

beforeAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});
afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

async function makeTempFile(content: string, name = "test.ts"): Promise<string> {
  const dir = join(TMP_DIR, String(tmpSeq++));
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, content);
  return file;
}

type RunCtx = { vars?: Record<string, string>; secrets?: Record<string, string>; retryCount?: number };

/** Collect the raw ExecutionEvent stream from one harness subprocess run. */
async function rawEvents(
  file: string,
  testId: string,
  useEngine: boolean,
  ctx: RunCtx = {},
): Promise<ExecutionEvent[]> {
  // engine leg: flag on + allowlist this exact test id (plan 0005 per-test routing).
  const executor = new TestExecutor(
    useEngine ? { env: { GLUBEAN_USE_ENGINE: "1", GLUBEAN_ENGINE_TESTIDS: testId } } : {},
  );
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

/** Drop fields that legitimately differ run-to-run (memory, wall-clock durations). */
function normalize(events: ExecutionEvent[]): unknown[] {
  return events.map((e) => {
    const c = { ...(e as Record<string, unknown>) };
    delete c.peakMemoryBytes;
    delete c.peakMemoryMB;
    delete c.peakMemory;
    if (typeof c.durationMs === "number") c.durationMs = 0;
    if (typeof c.duration === "number") c.duration = 0;
    delete c.stack; // throw-site specific (re-raised error has a different stack)
    delete c.ts; // session:set carries Date.now()
    return c;
  });
}

async function assertParity(content: string, testId: string, ctx: RunCtx = {}): Promise<void> {
  const file = await makeTempFile(content);
  const legacy = normalize(await rawEvents(file, testId, false, ctx));
  const engine = normalize(await rawEvents(file, testId, true, ctx));
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
import { test } from "@glubean/sdk";
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
export const warnTest = test(
  { id: "warnTest", name: "Warn Test" },
  async (ctx) => { ctx.warn(false, "slow"); ctx.warn(true, "fine"); ctx.assert(true, "warned"); }
);
export const emptyVarTest = test(
  { id: "emptyVarTest", name: "Empty Var Test" },
  async (ctx) => { ctx.vars.require("GLUBEAN_EMPTY"); ctx.assert(true, "unreached"); }
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

ptest("engine parity: warn (first-class warning events)", async () => {
  await assertParity(MODULE, "warnTest");
});

ptest("engine parity: vars.require throws for an EMPTY value (empty = unset)", async () => {
  // The codex edge: an empty explicit value with no system fallback must throw on
  // require in BOTH paths (not return undefined on the engine path).
  await assertParity(MODULE, "emptyVarTest", { vars: { GLUBEAN_EMPTY: "" } });
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
