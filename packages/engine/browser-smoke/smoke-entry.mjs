// Engine browser-safety smoke — runs @glubean/engine in a REAL browser to prove
// the shared core stays browser-bundleable AND functional as we migrate harness
// features into it. Add one representative test per migrated feature so each
// migration step gets a real-browser check (not just node-vitest).
//
// What it proves IN-BROWSER:
//   - @glubean/engine + the real SDK module-load with no node-only breakage
//     (the async_hooks shim satisfies the SDK's ALS carrier at import time)
//   - engine.resolve() turns SDK Test exports into runnable defs
//   - engine.run() runs simple + steps; assertions pass AND fail correctly
//   - real ky 2 inside the engine does a real fetch (GET + POST/json + trace)
//
// Results are published on window.__GLUBEAN_SMOKE for the Chrome driver to read.
import { test } from "@glubean/sdk";
import { RunnerCore } from "@glubean/engine";
import { createGlobalThisCarrier } from "@glubean/sdk/internal";

const BASE = globalThis.location?.origin ?? "";

// --- representative tests (Stage-1 surface; grow one per migrated feature) -----
const simplePass = test({ id: "simple-pass", name: "simple pass" }, async (ctx) => {
  ctx.expect(1 + 1).toBe(2);
  ctx.assert(true, "ok");
});

// By design FAILS — proves the engine's failure path renders in the browser too.
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

const steps = test({ id: "steps", name: "steps state carry" })
  .setup(async () => ({ n: 0 }))
  .step("inc", async (ctx, s) => ({ ...s, n: s.n + 1 }))
  .step("assert", async (ctx, s) => {
    ctx.assert(s.n === 1, "state carried across steps");
    return s;
  });

const namespace = { simplePass, simpleFail, httpGet, httpPost, steps };

// Expected status per id — the smoke is green iff every test matches its expectation.
const EXPECT = { "simple-pass": "ok", "simple-fail": "error", "http-get": "ok", "http-post": "ok", steps: "ok" };

async function main() {
  const events = [];
  const engine = new RunnerCore({
    // Real browser fetch — engine ky 2 drives it against the same-origin /api
    // echo endpoint (no CORS). This is the in-browser ky2→fetch path under test.
    fetch: (input, init) => fetch(input, init),
    env: { vars: () => ({}), secrets: () => ({}) },
    events: { emit: (e) => events.push(e) },
    scheduler: { now: () => performance.now() },
    carrier: createGlobalThisCarrier(),
  });

  const defs = engine.resolve(namespace);
  const results = [];
  for (const def of defs) {
    const res = await engine.run(def);
    results.push({ id: res.id, status: res.status, assertions: res.assertions, error: res.error });
  }

  const traceCount = events.filter((e) => e.type === "trace").length;
  const resolvedAll = Object.keys(EXPECT).every((id) => results.some((r) => r.id === id));
  // A result with no EXPECT entry is itself a mismatch — the smoke grows per
  // migrated feature, so an unmapped id (e.g. EXPECT left un-updated) must FAIL
  // loudly rather than be silently ignored.
  const mismatches = results
    .map((r) =>
      !(r.id in EXPECT)
        ? { id: r.id, got: r.status, want: "(no EXPECT entry — update EXPECT)" }
        : r.status !== EXPECT[r.id]
          ? { id: r.id, got: r.status, want: EXPECT[r.id] }
          : null,
    )
    .filter(Boolean);
  const ok = resolvedAll && mismatches.length === 0 && traceCount >= 2;

  return { ok, resolvedAll, mismatches, traceCount, results };
}

main()
  .then((r) => {
    globalThis.__GLUBEAN_SMOKE = { done: true, ...r };
  })
  .catch((e) => {
    globalThis.__GLUBEAN_SMOKE = { done: true, ok: false, error: String((e && e.stack) || e) };
  });
