/**
 * Phase 6 — harness execution of `test()` builder branches
 * (condition / switchOn / switchCond).
 *
 * Verifies: a runtime branch decision emits a `branch` event; the taken case's
 * sub-steps are FIRST-CLASS (step_start/step_end); non-taken cases (and the
 * default when a case matched) emit `skipped`; state commits incrementally
 * across branch sub-steps; a predicate that throws fails the test.
 */
import { test, expect, afterAll, beforeAll } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TestExecutor } from "./executor.js";
import type { TimelineEvent } from "./executor.js";
import { generateSummary } from "./generate_summary.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(resolve(__dirname, ".."), ".tmp-branch-test");
let seq = 0;

beforeAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});
afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

async function run(source: string, exportName: string) {
  const dir = join(TMP_DIR, String(seq++));
  await mkdir(dir, { recursive: true });
  const file = join(dir, "branch.test.ts");
  await writeFile(file, source);
  const executor = new TestExecutor();
  return executor.execute(`file://${file}`, exportName, { vars: {}, secrets: {} });
}

const branches = (evs: TimelineEvent[]) =>
  evs.filter((e): e is Extract<TimelineEvent, { type: "branch" }> => e.type === "branch");
const stepStarts = (evs: TimelineEvent[]) =>
  evs.filter((e): e is Extract<TimelineEvent, { type: "step_start" }> => e.type === "step_start");
const stepEnds = (evs: TimelineEvent[]) =>
  evs.filter((e): e is Extract<TimelineEvent, { type: "step_end" }> => e.type === "step_end");

test("condition: then-branch taken — branch event + first-class then step, else skipped", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("cond-then")
  .setup(async () => ({ role: "admin", route: "" }))
  .condition(
    { predicate: (ctx, s) => s.role === "admin", message: "is admin" },
    (b) => b.step("go-admin", async (ctx, s) => ({ ...s, route: "admin" })),
    (b) => b.step("go-home", async (ctx, s) => ({ ...s, route: "home" })),
  )
  .step("assert-route", async (ctx, s) => { ctx.assert(s.route === "admin", "route is admin"); return s; });
`;
  const r = await run(src, "cond-then");
  expect(r.success).toBe(true);

  const br = branches(r.events);
  expect(br).toHaveLength(1);
  expect(br[0].takenIndex).toBe(0);
  expect(br[0].message).toBe("is admin");

  // then sub-step ran as a first-class step
  const ran = stepEnds(r.events).filter((e) => e.status === "passed").map((e) => e.name);
  expect(ran).toContain("go-admin");
  expect(ran).toContain("assert-route");
  // else sub-step skipped
  const skipped = stepEnds(r.events).filter((e) => e.status === "skipped").map((e) => e.name);
  expect(skipped).toContain("go-home");
});

test("condition: else-branch taken when predicate false", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("cond-else")
  .setup(async () => ({ role: "guest", route: "" }))
  .condition(
    { predicate: (ctx, s) => s.role === "admin" },
    (b) => b.step("go-admin", async (ctx, s) => ({ ...s, route: "admin" })),
    (b) => b.step("go-home", async (ctx, s) => ({ ...s, route: "home" })),
  )
  .step("assert-route", async (ctx, s) => { ctx.assert(s.route === "home", "route is home"); return s; });
`;
  const r = await run(src, "cond-else");
  expect(r.success).toBe(true);
  expect(branches(r.events)[0].takenIndex).toBe("default");
  const skipped = stepEnds(r.events).filter((e) => e.status === "skipped").map((e) => e.name);
  expect(skipped).toContain("go-admin");
});

test("switchOn: subject matches a case; default + non-taken cases skipped", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("switch-on")
  .setup(async () => ({ status: 404, handled: "" }))
  .switchOn((ctx, s) => s.status)(
    [
      { value: 200, then: (b) => b.step("use", async (ctx, s) => ({ ...s, handled: "use" })) },
      { value: 404, then: (b) => b.step("create", async (ctx, s) => ({ ...s, handled: "create" })) },
    ],
    (b) => b.step("fallback", async (ctx, s) => ({ ...s, handled: "fallback" })),
  )
  .step("assert", async (ctx, s) => { ctx.assert(s.handled === "create", "handled=create"); return s; });
`;
  const r = await run(src, "switch-on");
  expect(r.success).toBe(true);
  const br = branches(r.events);
  expect(br[0].takenIndex).toBe(1);
  expect(br[0].takenValue).toBe(404);
  const ran = stepEnds(r.events).filter((e) => e.status === "passed").map((e) => e.name);
  expect(ran).toContain("create");
  const skipped = stepEnds(r.events).filter((e) => e.status === "skipped").map((e) => e.name);
  expect(skipped).toEqual(expect.arrayContaining(["use", "fallback"]));
});

test("switchOn: an async subject lens is awaited before matching", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("switch-on-async")
  .setup(async () => ({ id: "u1", handled: "" }))
  .switchOn(async (ctx, s) => { await Promise.resolve(); return s.id === "u1" ? 404 : 200; })(
    [
      { value: 200, then: (b) => b.step("use", async (ctx, s) => ({ ...s, handled: "use" })) },
      { value: 404, then: (b) => b.step("create", async (ctx, s) => ({ ...s, handled: "create" })) },
    ],
    (b) => b.step("fallback", async (ctx, s) => ({ ...s, handled: "fallback" })),
  )
  .step("assert", async (ctx, s) => { ctx.assert(s.handled === "create", "handled=create"); return s; });
`;
  const r = await run(src, "switch-on-async");
  expect(r.success).toBe(true);
  const br = branches(r.events);
  expect(br[0].takenIndex).toBe(1);
  expect(br[0].takenValue).toBe(404);
});

test("switchCond: first-match wins", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("switch-cond")
  .setup(async () => ({ amount: 500, tier: "" }))
  .switchCond(
    [
      { when: (ctx, s) => s.amount > 1000, then: (b) => b.step("high", async (ctx, s) => ({ ...s, tier: "high" })) },
      { when: (ctx, s) => s.amount > 100, then: (b) => b.step("mid", async (ctx, s) => ({ ...s, tier: "mid" })) },
    ],
    (b) => b.step("low", async (ctx, s) => ({ ...s, tier: "low" })),
  )
  .step("assert", async (ctx, s) => { ctx.assert(s.tier === "mid", "tier=mid"); return s; });
`;
  const r = await run(src, "switch-cond");
  expect(r.success).toBe(true);
  expect(branches(r.events)[0].takenIndex).toBe(1);
});

test("branch sub-step state commits incrementally (visible to later steps + nested branch)", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("nested")
  .setup(async () => ({ loggedIn: true, tier: "gold", perk: "" }))
  .condition(
    { predicate: (ctx, s) => s.loggedIn },
    (b) => b
      .step("set-tier", async (ctx, s) => ({ ...s, tier: "gold" }))
      .switchOn((ctx, s) => s.tier)(
        [{ value: "gold", then: (b2) => b2.step("grant", async (ctx, s) => ({ ...s, perk: "lounge" })) }],
        (b2) => b2.step("none", async (ctx, s) => ({ ...s, perk: "none" })),
      ),
  )
  .step("assert", async (ctx, s) => { ctx.assert(s.perk === "lounge", "perk=lounge"); return s; });
`;
  const r = await run(src, "nested");
  expect(r.success).toBe(true);
  const ran = stepEnds(r.events).filter((e) => e.status === "passed").map((e) => e.name);
  expect(ran).toEqual(expect.arrayContaining(["set-tier", "grant", "assert"]));
});

test("a predicate that throws fails the test (branch decision failure)", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("pred-throws")
  .setup(async () => ({ x: 1 }))
  .condition(
    { predicate: () => { throw new Error("boom"); }, message: "bad gate" },
    (b) => b.step("then", async (ctx, s) => s),
  )
  .step("after", async (ctx, s) => s);
`;
  const r = await run(src, "pred-throws");
  expect(r.success).toBe(false);
  const br = branches(r.events);
  expect(br).toHaveLength(1);
  expect(br[0].error).toMatch(/boom/);
  // The decision error must also surface in the top-level result error, not be
  // hidden behind a generic "One or more steps failed".
  expect(r.error).toMatch(/boom/);
  // then sub-step + the subsequent step are skipped (cascade)
  const skipped = stepEnds(r.events).filter((e) => e.status === "skipped").map((e) => e.name);
  expect(skipped).toContain("then");
});

test("a failing step inside a taken branch fails the test + cascades skip", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("branch-fail")
  .setup(async () => ({ go: true }))
  .condition(
    { predicate: (ctx, s) => s.go },
    (b) => b
      .step("boom", async (ctx) => { ctx.assert(false, "intentional"); })
      .step("after-boom", async (ctx, s) => s),
  )
  .step("tail", async (ctx, s) => s);
`;
  const r = await run(src, "branch-fail");
  expect(r.success).toBe(false);
  const ends = stepEnds(r.events);
  expect(ends.find((e) => e.name === "boom")?.status).toBe("failed");
  // steps after the failure (in-branch + after the branch) are skipped
  const skipped = ends.filter((e) => e.status === "skipped").map((e) => e.name);
  expect(skipped).toEqual(expect.arrayContaining(["after-boom", "tail"]));
});

test("branch decision error → summary recomputed from events is NOT successful", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("pred-throws-summary")
  .setup(async () => ({ x: 1 }))
  .condition(
    { predicate: () => { throw new Error("boom"); } },
    (b) => b.step("then", async (ctx, s) => s),
  );
`;
  const r = await run(src, "pred-throws-summary");
  expect(r.success).toBe(false);
  // A consumer that recomputes the summary purely from result.events must agree.
  expect(generateSummary(r.events as any).success).toBe(false);
});

test("branching test keeps step index < total (no 'step 5/3')", async () => {
  // A one-step branch first, then top-level steps: index must never exceed total.
  const src = `
import { test } from "@glubean/sdk";
export const t = test("index-bound")
  .setup(async () => ({ n: 1 }))
  .condition(
    { predicate: (ctx, s) => s.n === 1 },
    (b) => b.step("in-branch", async (ctx, s) => s),
    (b) => b.step("in-branch-else", async (ctx, s) => s),
  )
  .step("top-1", async (ctx, s) => s)
  .step("top-2", async (ctx, s) => s);
`;
  const r = await run(src, "index-bound");
  expect(r.success).toBe(true);
  const starts = stepStarts(r.events);
  for (const s of starts) expect(s.index).toBeLessThan(s.total);
  // Every LEAF emits exactly one index (taken → step_start+step_end with the
  // same index; skipped → step_end only). The union of all leaf indices is
  // {0..total-1} — contiguous, no gaps from branch decisions, none exceeding
  // total — so runtime step indices line up with leaves-only registry metadata.
  const total = starts[0].total;
  const allIdx = new Set<number>([
    ...starts.map((e) => e.index),
    ...stepEnds(r.events).map((e) => e.index),
  ]);
  expect([...allIdx].sort((a, b) => a - b)).toEqual([...Array(total).keys()]);
});

test("ctx.skip() inside a predicate skips the test (not a failure)", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("pred-skip")
  .setup(async () => ({ env: "prod" }))
  .condition(
    { predicate: (ctx, s) => { if (s.env === "prod") ctx.skip("not in prod"); return true; } },
    (b) => b.step("then", async (ctx, s) => s),
  )
  .step("after", async (ctx, s) => s);
`;
  const r = await run(src, "pred-skip");
  // Skip is not a failure.
  expect(r.success).toBe(true);
  // The branch event has no error; sub-steps + subsequent steps are skipped.
  const br = branches(r.events);
  expect(br[0].error).toBeUndefined();
  const skipped = stepEnds(r.events).filter((e) => e.status === "skipped").map((e) => e.name);
  expect(skipped).toEqual(expect.arrayContaining(["then", "after"]));
});

test("a predicate throwing an empty-message error still fails the recomputed summary", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("pred-empty-err")
  .setup(async () => ({ x: 1 }))
  .condition(
    { predicate: () => { throw new Error(""); } },
    (b) => b.step("then", async (ctx, s) => s),
  );
`;
  const r = await run(src, "pred-empty-err");
  expect(r.success).toBe(false);
  // Empty-string error must still be treated as a failure in event-only recompute.
  expect(generateSummary(r.events as any).success).toBe(false);
});

test("a failed ctx.assert inside a predicate fails the test (no false positive)", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("assert-in-pred")
  .setup(async () => ({ x: 1 }))
  .condition(
    { predicate: (ctx, s) => { ctx.assert(false, "bad in predicate"); return true; } },
    (b) => b.step("then", async (ctx, s) => { ctx.assert(true, "then ok"); return s; }),
  );
`;
  const r = await run(src, "assert-in-pred");
  // Even though the predicate returned true and the then-step passes, the
  // failed assertion during the decision must fail the test.
  expect(r.success).toBe(false);
  expect(generateSummary(r.events as any).success).toBe(false);
  expect(branches(r.events)[0].error).toMatch(/assertion/);
  // The assertion-failure decision error must surface in the top-level error.
  expect(r.error).toMatch(/assertion/);
});

test("a failed assertion before ctx.skip() in a predicate → failure wins (not skipped)", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("assert-then-skip")
  .setup(async () => ({ x: 1 }))
  .condition(
    { predicate: (ctx, s) => { ctx.assert(false, "real failure"); ctx.skip("then skip"); return true; } },
    (b) => b.step("then", async (ctx, s) => s),
  );
`;
  const r = await run(src, "assert-then-skip");
  // The prior failed assertion must NOT be masked by the later skip.
  expect(r.success).toBe(false);
  expect(generateSummary(r.events as any).success).toBe(false);
});

test("a ctx.fail() caught inside a predicate still fails the test", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("caught-fail")
  .setup(async () => ({ x: 1 }))
  .condition(
    { predicate: (ctx, s) => { try { ctx.fail("real failure"); } catch {} return true; } },
    (b) => b.step("then", async (ctx, s) => { ctx.assert(true, "then ok"); return s; }),
  );
`;
  const r = await run(src, "caught-fail");
  // ctx.fail records a failed assertion even when its throw is swallowed, so
  // the branch decision must fail despite the predicate returning true.
  expect(r.success).toBe(false);
  expect(generateSummary(r.events as any).success).toBe(false);
});

test("non-boolean predicate result fails the test (no coercion)", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("pred-nonbool")
  .setup(async () => ({ x: 1 }))
  .condition(
    { predicate: () => "false" } as any,
    (b) => b.step("then", async (ctx, s) => s),
  );
`;
  const r = await run(src, "pred-nonbool");
  expect(r.success).toBe(false);
  expect(branches(r.events)[0].error).toMatch(/boolean/);
});

test("leaf indices follow registry source order even when a later case is taken", async () => {
  // case 0 (use) is skipped, case 1 (create) is taken. Source order is
  // [use(0), create(1), fallback(2)]; runtime must assign create index 1, not 0.
  const src = `
import { test } from "@glubean/sdk";
export const t = test("source-order")
  .setup(async () => ({ status: 404 }))
  .switchOn((ctx, s) => s.status)(
    [
      { value: 200, then: (b) => b.step("use", async (ctx, s) => s) },
      { value: 404, then: (b) => b.step("create", async (ctx, s) => s) },
    ],
    (b) => b.step("fallback", async (ctx, s) => s),
  );
`;
  const r = await run(src, "source-order");
  expect(r.success).toBe(true);
  // "create" ran (step_start) at index 1 (its source position), not 0.
  const createStart = stepStarts(r.events).find((e) => e.name === "create");
  expect(createStart?.index).toBe(1);
  // "use" (case 0) skipped at index 0, "fallback" (default) skipped at index 2.
  const ends = stepEnds(r.events);
  expect(ends.find((e) => e.name === "use")?.index).toBe(0);
  expect(ends.find((e) => e.name === "create")?.index).toBe(1);
  expect(ends.find((e) => e.name === "fallback")?.index).toBe(2);
});

// Make sure step_start count equals first-class steps that actually ran.
test("only taken sub-steps emit step_start", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("starts")
  .setup(async () => ({ n: 1 }))
  .condition(
    { predicate: (ctx, s) => s.n === 1 },
    (b) => b.step("a", async (ctx, s) => s),
    (b) => b.step("b", async (ctx, s) => s),
  );
`;
  const r = await run(src, "starts");
  expect(r.success).toBe(true);
  const started = stepStarts(r.events).map((e) => e.name);
  expect(started).toContain("a");
  expect(started).not.toContain("b"); // non-taken never starts
});
