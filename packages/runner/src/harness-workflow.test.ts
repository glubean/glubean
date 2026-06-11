/**
 * S2.5 discovery + S2.7 first-class node events — end-to-end execution of
 * vNext `workflow()` through the runner (proposal §17 #9/#10, plan fork c).
 *
 * Verifies the full chain: `workflow(...).build()` (or an exported, un-built
 * builder) → runner resolution → simple-Test execution → per-node evidence as
 * FIRST-CLASS timeline events (`node_start` / `node_end` / `poll_attempt`
 * carrying node id + grade + status directly — the harness unwraps the SDK's
 * namespaced ctx.event channel) → a generateSummary whose node counts/grades
 * and success agree with the WORKFLOW VERDICT (passed / failed / skipped),
 * including the retry case where a failed attempt must not fail a passed run
 * (§17 #7: last node_end per nodeId wins).
 */
import { test, expect, afterAll, beforeAll } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TestExecutor } from "./executor.js";
import type { TimelineEvent } from "./executor.js";
import { generateSummary } from "./generate_summary.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(resolve(__dirname, ".."), ".tmp-workflow-test");
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
  const file = join(dir, "workflow.test.ts");
  await writeFile(file, source);
  const executor = new TestExecutor();
  return executor.execute(`file://${file}`, exportName, { vars: {}, secrets: {} });
}

/** Workflow node evidence is FIRST-CLASS on the timeline (S2.7). */
function nodeEnds(evs: TimelineEvent[]): Array<Extract<TimelineEvent, { type: "node_end" }>> {
  return evs.filter((e): e is Extract<TimelineEvent, { type: "node_end" }> => e.type === "node_end");
}
function nodeStarts(evs: TimelineEvent[]): Array<Extract<TimelineEvent, { type: "node_start" }>> {
  return evs.filter(
    (e): e is Extract<TimelineEvent, { type: "node_start" }> => e.type === "node_start",
  );
}
function pollAttempts(
  evs: TimelineEvent[],
): Array<Extract<TimelineEvent, { type: "poll_attempt" }>> {
  return evs.filter(
    (e): e is Extract<TimelineEvent, { type: "poll_attempt" }> => e.type === "poll_attempt",
  );
}

test("a passing workflow executes as a simple test with per-node evidence on the timeline", async () => {
  const src = `
import { workflow } from "@glubean/sdk";
export const wf = workflow("wf-pass")
  .setup(async () => ({ n: 1 }))
  .compute("bump", (s) => ({ n: s.n + 1 }))
  .check("verify", async (c, s) => { c.assert(s.n === 2, "n bumped"); })
  .build();
`;
  const r = await run(src, "wf-pass");
  expect(r.success).toBe(true);

  const ends = nodeEnds(r.events);
  expect(ends.map((e) => [e.nodeId, e.status, e.grade])).toEqual([
    ["bump", "passed", "full"],
    ["verify", "passed", "trace"], // opaque check promoted by its assertion (§17 #10)
  ]);
  // node_start brackets precede their node_end
  expect(nodeStarts(r.events).map((e) => e.nodeId)).toEqual(["bump", "verify"]);
  // the check's assertion reached the host timeline
  expect(r.events.some((e) => e.type === "assertion" && e.passed)).toBe(true);
  // …and generateSummary consumes the node verdicts + grades directly (§17 #9/#10)
  const summary = generateSummary(r.events);
  expect(summary).toMatchObject({
    nodeTotal: 2,
    nodePassed: 2,
    nodeFailed: 0,
    nodeSkipped: 0,
    nodeGrades: { full: 1, partial: 0, trace: 1, opaque: 0 },
    success: true,
  });
});

test("an exported, un-built workflow builder is auto-resolved and executed", async () => {
  const src = `
import { workflow } from "@glubean/sdk";
export const wf = workflow("wf-unbuilt")
  .setup(async () => ({ ok: true }))
  .check("verify", async (c, s) => { c.assert(s.ok, "ok"); });
`;
  const r = await run(src, "wf-unbuilt");
  expect(r.success).toBe(true);
  expect(nodeEnds(r.events).map((e) => e.status)).toEqual(["passed"]);
});

test("a failed node fails the run; later nodes are reported skipped", async () => {
  const src = `
import { workflow } from "@glubean/sdk";
export const wf = workflow("wf-fail")
  .setup(async () => ({}))
  .action("boom", async () => { throw new Error("kaput"); })
  .compute("never", (s) => s)
  .build();
`;
  const r = await run(src, "wf-fail");
  expect(r.success).toBe(false);
  expect(r.error).toContain("kaput");
  const ends = nodeEnds(r.events);
  expect(ends.map((e) => [e.nodeId, e.status])).toEqual([
    ["boom", "failed"],
    ["never", "skipped"],
  ]);
  expect(ends[0].error).toContain("kaput"); // the node error rides the first-class event
  const summary = generateSummary(r.events);
  expect(summary).toMatchObject({ nodeTotal: 2, nodeFailed: 1, nodeSkipped: 1, success: false });
});

test("a workflow ctx.skip() skips the whole test (not a failure)", async () => {
  const src = `
import { workflow } from "@glubean/sdk";
export const wf = workflow("wf-skip")
  .setup(async () => ({}))
  .action("gate", async (c) => { c.skip("feature off"); })
  .build();
`;
  const r = await run(src, "wf-skip");
  expect(r.success).toBe(true); // a skip is not a failure
  expect(r.error).toBeUndefined();
  // the skipping node settles `skipped` on the timeline (the run-level skipped
  // status is consumed by the sandbox protocol layer, not the events array).
  expect(nodeEnds(r.events).map((e) => [e.nodeId, e.status])).toEqual([["gate", "skipped"]]);
});

test("a retried-then-passing node yields a PASSING run — failed attempts don't poison counters (§17 #7)", async () => {
  const src = `
import { workflow } from "@glubean/sdk";
let calls = 0;
export const wf = workflow("wf-retry")
  .setup(async () => ({}))
  .action("flaky", async (c) => {
    calls += 1;
    c.assert(calls >= 2, "attempt-" + calls);
    if (calls < 2) throw new Error("first attempt fails");
  }, { retry: { attempts: 2, reason: "eventually consistent" } })
  .build();
`;
  const r = await run(src, "wf-retry");
  expect(r.success).toBe(true); // the dropped attempt's failed assert must not fail the run
  // both attempts visible as attempt-stamped brackets
  const ends = nodeEnds(r.events);
  expect(ends.map((e) => [e.attempt, e.status])).toEqual([
    [1, "failed"],
    [2, "passed"],
  ]);
  // only the terminal attempt's assertion landed on the host timeline
  const asserts = r.events.filter((e) => e.type === "assertion");
  expect(asserts).toHaveLength(1);
  expect(asserts[0]).toMatchObject({ passed: true });
  // summary: the LAST node_end per nodeId wins — one node, PASSED, despite the
  // attempt-1 failed bracket on the timeline (§17 #7).
  const summary = generateSummary(r.events);
  expect(summary).toMatchObject({ nodeTotal: 1, nodePassed: 1, nodeFailed: 0, success: true });
});

test("a poll node emits its attempt timeline and exhaustion fails the run", async () => {
  const src = `
import { workflow, contract } from "@glubean/sdk";
contract.register("wf-e2e-poll", {
  project: () => ({ cases: {} }),
  executeCaseInFlow: async () => ({ status: "pending" }),
});
const ref = {
  __glubean_type: "contract-case-ref",
  contractId: "job", caseKey: "status", protocol: "wf-e2e-poll", target: "GET /job",
  contract: {},
};
export const wf = workflow("wf-poll")
  .setup(async () => ({}))
  .poll("wait", ref, {
    until: (w) => w.when((r) => r.status).eq("done"),
    every: 1, maxAttempts: 2, perAttemptTimeout: 1000,
  })
  .build();
`;
  const r = await run(src, "wf-poll");
  expect(r.success).toBe(false);
  expect(r.error).toContain("exhausted");
  const attempts = pollAttempts(r.events);
  expect(attempts.map((a) => [a.nodeId, a.attempt, a.outcome])).toEqual([
    ["wait", 1, "probe"],
    ["wait", 2, "probe"],
  ]);
  expect(nodeEnds(r.events).map((e) => e.status)).toEqual(["failed"]);
});
