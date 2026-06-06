/**
 * Poll Phase 3 — harness execution of `test().poll` (bounded poll-until).
 *
 * Verifies: a poll step is a first-class leaf (step_start/step_end) + emits a
 * `poll` timeline event (attempts/elapsed/satisfied/exhausted); retries until
 * the exit predicate holds and commits `out`; exhaustion (maxAttempts/timeout)
 * fails the step + the test; ctx.skip inside the attempt skips the test;
 * fn/until run against the live ctx (assertions count).
 */
import { test, expect, afterAll, beforeAll } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TestExecutor } from "./executor.js";
import type { TimelineEvent } from "./executor.js";
import { generateSummary } from "./generate_summary.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(resolve(__dirname, ".."), ".tmp-poll-test");
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
  const file = join(dir, "poll.test.ts");
  await writeFile(file, source);
  const executor = new TestExecutor();
  return executor.execute(`file://${file}`, exportName, { vars: {}, secrets: {} });
}

const polls = (evs: TimelineEvent[]) =>
  evs.filter((e): e is Extract<TimelineEvent, { type: "poll" }> => e.type === "poll");
const stepEnds = (evs: TimelineEvent[]) =>
  evs.filter((e): e is Extract<TimelineEvent, { type: "step_end" }> => e.type === "step_end");

test("poll retries until satisfied, commits out, emits a poll event + passing step", async () => {
  const src = `
import { test } from "@glubean/sdk";
let n = 0;
export const t = test("poll-ok")
  .setup(async () => ({ done: false, n: 0 }))
  .poll("await-job", async () => { n += 1; return { status: n >= 3 ? "done" : "pending", n }; }, {
    until: (ctx, res) => res.status === "done",
    every: 1,
    timeout: 5000,
    out: (s, res) => ({ ...s, done: true, n: res.n }),
  })
  .step("assert", async (ctx, s) => { ctx.assert(s.done === true && s.n === 3, "polled to done at n=3: " + s.n); });
`;
  const r = await run(src, "poll-ok");
  expect(r.success).toBe(true);
  const p = polls(r.events);
  expect(p).toHaveLength(1);
  expect(p[0].satisfied).toBe(true);
  expect(p[0].exhausted).toBe(false);
  expect(p[0].attempts).toBe(3);
  // first-class step: a passing step_end for the poll + the assert
  const ends = stepEnds(r.events).filter((e) => e.status === "passed").map((e) => e.name);
  expect(ends).toEqual(expect.arrayContaining(["await-job", "assert"]));
});

test("poll exhausts (maxAttempts) → poll event has error + step fails the test", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("poll-exhaust")
  .setup(async () => ({}))
  .poll("never", async () => ({ status: "pending" }), {
    until: (ctx, res) => res.status === "done",
    every: 1,
    maxAttempts: 3,
    perAttemptTimeout: 1000,
  });
`;
  const r = await run(src, "poll-exhaust");
  expect(r.success).toBe(false);
  const p = polls(r.events);
  expect(p).toHaveLength(1);
  expect(p[0].exhausted).toBe(true);
  expect(p[0].satisfied).toBe(false);
  expect(p[0].error).toBeDefined();
  // generateSummary agrees: a poll with error is a hard failure.
  const summary = generateSummary(r.events as any);
  expect(summary.success).toBe(false);
});

test("first attempt already satisfied → 1 attempt, no waiting", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("poll-immediate")
  .setup(async () => ({}))
  .poll("check", async () => ({ ready: true }), {
    until: (ctx, res) => res.ready === true,
    timeout: 5000,
  });
`;
  const r = await run(src, "poll-immediate");
  expect(r.success).toBe(true);
  expect(polls(r.events)[0].attempts).toBe(1);
});

test("ctx.skip() inside the attempt skips the test", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("poll-skip")
  .setup(async () => ({}))
  .poll("maybe", async (ctx) => { ctx.skip("not applicable"); return {}; }, {
    until: () => true,
    timeout: 5000,
  });
`;
  const r = await run(src, "poll-skip");
  expect(r.success).toBe(true); // skip is not a failure
  // The poll step's step_end is "skipped"; skip short-circuits before the poll event.
  expect(stepEnds(r.events).find((e) => e.name === "maybe")?.status).toBe("skipped");
  expect(polls(r.events)).toHaveLength(0);
});

test("a non-boolean until result fails the poll (fail-fast)", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("poll-nonbool")
  .setup(async () => ({}))
  .poll("bad", async () => ({}), {
    until: () => "done",
    timeout: 5000,
  });
`;
  const r = await run(src, "poll-nonbool");
  expect(r.success).toBe(false);
  expect(polls(r.events)[0].error).toMatch(/boolean/);
});

test("a throwing out-mapper fails the poll via the normal path (no dangling step)", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("poll-out-throw")
  .setup(async () => ({ v: 0 }))
  .poll("commit", async () => ({ ready: true }), {
    until: (ctx, res) => res.ready === true,
    timeout: 5000,
    out: () => { throw new Error("out-mapper boom"); },
  });
`;
  const r = await run(src, "poll-out-throw");
  expect(r.success).toBe(false);
  const p = polls(r.events);
  expect(p).toHaveLength(1);
  // The exit predicate WAS satisfied — the failure is the out-mapper, not exhaustion.
  expect(p[0].satisfied).toBe(true);
  expect(p[0].exhausted).toBe(false);
  expect(p[0].error).toMatch(/out-mapper boom/);
  // The throw fails the step through the normal path: a matching failed step_end,
  // carrying the error. (Without the fix it escaped, leaving a dangling step.)
  const end = stepEnds(r.events).find((e) => e.name === "commit");
  expect(end?.status).toBe("failed");
  expect(end?.error).toMatch(/out-mapper boom/);
  // No dangling step: every started step has a matching step_end.
  const started = r.events
    .filter((e): e is Extract<TimelineEvent, { type: "step_start" }> => e.type === "step_start")
    .map((e) => e.name);
  const ended = stepEnds(r.events).map((e) => e.name);
  expect(ended).toEqual(expect.arrayContaining(started));
});

test("an out-mapper that throws an empty error still fails the poll", async () => {
  const src = `
import { test } from "@glubean/sdk";
export const t = test("poll-out-empty")
  .setup(async () => ({}))
  .poll("commit", async () => ({ ready: true }), {
    until: (ctx, res) => res.ready === true,
    timeout: 5000,
    out: () => { throw new Error(""); },
  });
`;
  const r = await run(src, "poll-out-empty");
  expect(r.success).toBe(false);
  const p = polls(r.events);
  expect(p).toHaveLength(1);
  expect(p[0].satisfied).toBe(true);
  // An empty thrown message must NOT be falsy-coerced into a pass — the poll
  // event + step_end must carry a non-empty error.
  expect(p[0].error).toBeTruthy();
  const end = stepEnds(r.events).find((e) => e.name === "commit");
  expect(end?.status).toBe("failed");
  expect(end?.error).toBeTruthy();
});
