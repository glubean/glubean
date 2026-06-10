/**
 * S2.5 discovery — end-to-end execution of vNext `workflow()` through the
 * runner (proposal §17 #9, plan fork c).
 *
 * Verifies the full chain: `workflow(...).build()` (or an exported, un-built
 * builder) → runner resolution → simple-Test execution → per-node evidence on
 * the ExecutionResult timeline (`workflow:node_start` / `workflow:node_end` /
 * `workflow:poll_attempt` generic events carrying node id + grade + status) →
 * a summary whose success agrees with the WORKFLOW VERDICT (passed / failed /
 * skipped), including the retry case where a failed attempt must not fail a
 * passed run (§17 #7).
 */
import { test, expect, afterAll, beforeAll } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TestExecutor } from "./executor.js";
import type { TimelineEvent } from "./executor.js";

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

/** Workflow node evidence rides the generic `event` channel: unwrap it. */
function nodeEvents(
  evs: TimelineEvent[],
  type: string,
): Array<Record<string, unknown>> {
  return evs
    .filter((e): e is Extract<TimelineEvent, { type: "event" }> => e.type === "event")
    .map((e) => e.data as { type?: string; data?: Record<string, unknown> })
    .filter((d) => d?.type === type)
    .map((d) => d.data ?? {});
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

  const ends = nodeEvents(r.events, "workflow:node_end");
  expect(ends.map((e) => [e.nodeId, e.status, e.grade])).toEqual([
    ["bump", "passed", "full"],
    ["verify", "passed", "trace"], // opaque check promoted by its assertion (§17 #10)
  ]);
  // node_start brackets precede their node_end
  const starts = nodeEvents(r.events, "workflow:node_start");
  expect(starts.map((e) => e.nodeId)).toEqual(["bump", "verify"]);
  // the check's assertion reached the host timeline
  expect(r.events.some((e) => e.type === "assertion" && e.passed)).toBe(true);
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
  expect(nodeEvents(r.events, "workflow:node_end").map((e) => e.status)).toEqual(["passed"]);
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
  const ends = nodeEvents(r.events, "workflow:node_end");
  expect(ends.map((e) => [e.nodeId, e.status])).toEqual([
    ["boom", "failed"],
    ["never", "skipped"],
  ]);
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
  expect(nodeEvents(r.events, "workflow:node_end").map((e) => [e.nodeId, e.status])).toEqual([
    ["gate", "skipped"],
  ]);
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
  const ends = nodeEvents(r.events, "workflow:node_end");
  expect(ends.map((e) => [e.attempt, e.status])).toEqual([
    [1, "failed"],
    [2, "passed"],
  ]);
  // only the terminal attempt's assertion landed on the host timeline
  const asserts = r.events.filter((e) => e.type === "assertion");
  expect(asserts).toHaveLength(1);
  expect(asserts[0]).toMatchObject({ passed: true });
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
  const attempts = nodeEvents(r.events, "workflow:poll_attempt");
  expect(attempts.map((a) => [a.attempt, a.outcome])).toEqual([
    [1, "probe"],
    [2, "probe"],
  ]);
  expect(nodeEvents(r.events, "workflow:node_end").map((e) => e.status)).toEqual(["failed"]);
});
