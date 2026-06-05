/**
 * Phase 7 — `--upload` gate for branch (condition/switch) flows.
 *
 * Glubean Cloud cannot render `kind:"branch"` flows yet; uploading one would
 * silently drop its branches (Cloud run view ≠ local). The CLI refuses the
 * upload and names the offending flows. This tests the gate's detection logic
 * (`flowStepsHaveBranchOrPoll`) plus the real scan → NormalizedFlowMeta path that
 * feeds it. (contract-flow-condition.md §12 / Spike 6.)
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, afterEach, expect, test } from "vitest";
import { __testing } from "./run.js";

const { flowStepsHaveBranchOrPoll } = __testing;

// Fixtures must live inside the package so the scanner's dynamic import can
// resolve `@glubean/sdk`.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "..", ".tmp-upload-gate");
let seq = 0;
let dir = "";

beforeEach(async () => {
  seq += 1;
  dir = join(FIXTURE_ROOT, String(seq));
  await mkdir(dir, { recursive: true });
});
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

test("flowStepsHaveBranchOrPoll detects a branch step (incl. nested) and ignores plain steps", () => {
  expect(flowStepsHaveBranchOrPoll(undefined)).toBe(false);
  expect(
    flowStepsHaveBranchOrPoll([
      { kind: "contract-call" },
      { kind: "compute" },
    ]),
  ).toBe(false);
  expect(flowStepsHaveBranchOrPoll([{ kind: "branch" }])).toBe(true);
  // A top-level poll is detected.
  expect(flowStepsHaveBranchOrPoll([{ kind: "poll" }])).toBe(true);
  // A branch nested inside another branch's case/default is also detected.
  expect(
    flowStepsHaveBranchOrPoll([
      {
        kind: "branch",
        cases: [{ steps: [{ kind: "compute" }, { kind: "branch" }] }],
        default: [],
      },
    ]),
  ).toBe(true);
  // A poll nested inside a branch body is detected (fragment poll).
  expect(
    flowStepsHaveBranchOrPoll([
      {
        kind: "branch",
        cases: [{ steps: [{ kind: "compute" }, { kind: "poll" }] }],
        default: [],
      },
    ]),
  ).toBe(true);
});

test("a real condition flow extracts to a branch step the gate detects (per-file, as the gate does)", async () => {
  // Mirror the --upload gate exactly: extractContractFromFile per selected file,
  // then flowStepsHaveBranchOrPoll on the flow attachment's steps.
  const { extractContractFromFile } = await import("@glubean/scanner");
  const file = join(dir, "route.flow.ts");
  await writeFile(
    file,
    `
import { contract } from "@glubean/sdk";
export const route = contract
  .flow("route-by-status")
  .setup(async () => ({ status: 404 }))
  .condition(
    { predicate: (w) => w.when((s) => s.status).eq(404) },
    (b) => b.compute((s) => ({ ...s, route: "create" })),
    (b) => b.compute((s) => ({ ...s, route: "use" })),
  )
  .build();
`,
  );

  const result = await extractContractFromFile(file);
  const flowAtts = (result.attachments ?? []).filter((a: { kind: string }) => a.kind === "flow");
  expect(flowAtts.length).toBe(1);
  expect(flowStepsHaveBranchOrPoll((flowAtts[0] as { flow: { steps: unknown[] } }).flow.steps)).toBe(true);
});

test("a plain (branchless) flow is NOT gated", async () => {
  const { extractContractFromFile } = await import("@glubean/scanner");
  const file = join(dir, "plain.flow.ts");
  await writeFile(
    file,
    `
import { contract } from "@glubean/sdk";
export const plain = contract
  .flow("plain-flow")
  .setup(async () => ({ n: 1 }))
  .compute((s) => ({ ...s, n: s.n + 1 }))
  .build();
`,
  );

  const result = await extractContractFromFile(file);
  const flowAtts = (result.attachments ?? []).filter((a: { kind: string }) => a.kind === "flow");
  expect(flowAtts.length).toBe(1);
  expect(flowStepsHaveBranchOrPoll((flowAtts[0] as { flow: { steps: unknown[] } }).flow.steps)).toBe(false);
});

test("a switchOn flow extracts to a branch step the gate detects", async () => {
  const { extractContractFromFile } = await import("@glubean/scanner");
  const file = join(dir, "switch.flow.ts");
  await writeFile(
    file,
    `
import { contract } from "@glubean/sdk";
export const sw = contract
  .flow("switch-flow")
  .setup(async () => ({ status: 200 }))
  .switchOn((s) => s.status)(
    [{ value: 200, then: (b) => b.compute((s) => ({ ...s, ok: true })) }],
    (b) => b.compute((s) => ({ ...s, ok: false })),
  )
  .build();
`,
  );

  const result = await extractContractFromFile(file);
  const flowAtts = (result.attachments ?? []).filter((a: { kind: string }) => a.kind === "flow");
  expect(flowAtts.length).toBe(1);
  expect(flowStepsHaveBranchOrPoll((flowAtts[0] as { flow: { steps: unknown[] } }).flow.steps)).toBe(true);
});

test("a real poll flow extracts to a poll step the gate detects", async () => {
  const { extractContractFromFile } = await import("@glubean/scanner");
  const file = join(dir, "poll.flow.ts");
  await writeFile(
    file,
    `
import { contract } from "@glubean/sdk";
const api = contract.http.with("api", { client: {} as any, security: null });
const job = api("job", { endpoint: "GET /jobs", cases: { status: { expect: { status: 200 } } } });
export const pollFlow = contract
  .flow("poll-flow")
  .setup(async () => ({}))
  .poll(job.case("status"), {
    accept: [200, 202],
    until: (w) => w.when((r) => r.status).eq(200),
    timeout: 30000,
  })
  .build();
`,
  );

  const result = await extractContractFromFile(file);
  const flowAtts = (result.attachments ?? []).filter((a: { kind: string }) => a.kind === "flow");
  expect(flowAtts.length).toBe(1);
  expect(flowStepsHaveBranchOrPoll((flowAtts[0] as { flow: { steps: unknown[] } }).flow.steps)).toBe(true);
});
