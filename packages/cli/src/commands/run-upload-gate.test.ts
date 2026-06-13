/**
 * `--upload` gate for branch/poll WORKFLOWS (legacy flow tests deleted with
 * contract.flow — Nv1-D3). Cloud cannot render branch/poll nodes yet; the CLI
 * refuses the upload and names the offending workflows. Tests the detection
 * logic plus the real scan → workflow-projection path that feeds it.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, afterEach, expect, test } from "vitest";
import { __testing, classifyGlubeanFile } from "./run.js";

const { flowStepsHaveBranchOrPoll, workflowNodesHaveBranchOrPoll } = __testing;

test("classifyGlubeanFile maps .workflow.ts and legacy .flow.ts to the flow kind", () => {
  // `.workflow.ts` is the canonical vNext extension; `.flow.ts` is the legacy
  // alias. Both ride the "flow" runnable kind during the migration window.
  expect(classifyGlubeanFile("checkout.workflow.ts")).toBe("flow");
  expect(classifyGlubeanFile("checkout.flow.ts")).toBe("flow");
  expect(classifyGlubeanFile("users.contract.ts")).toBe("contract");
  expect(classifyGlubeanFile("smoke.test.ts")).toBe("test");
  expect(classifyGlubeanFile("glubean.bootstrap.ts")).toBe("bootstrap");
  expect(classifyGlubeanFile("README.md")).toBeUndefined();
});

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

test("workflowNodesHaveBranchOrPoll detects branch/poll nodes (incl. nested sides)", () => {
  expect(workflowNodesHaveBranchOrPoll(undefined)).toBe(false);
  expect(
    workflowNodesHaveBranchOrPoll([{ kind: "contract-call" }, { kind: "compute" }]),
  ).toBe(false);
  expect(workflowNodesHaveBranchOrPoll([{ kind: "poll" }])).toBe(true);
  // a branch nested inside a branch side is detected
  expect(
    workflowNodesHaveBranchOrPoll([
      { kind: "branch", cases: [{ nodes: [{ kind: "compute" }] }], default: [{ kind: "branch" }] },
    ]),
  ).toBe(true);
  // …and inside a group's children
  expect(
    workflowNodesHaveBranchOrPoll([{ kind: "group", nodes: [{ kind: "poll" }] }]),
  ).toBe(true);
});

test("a real workflow with a poll node extracts to nodes the gate detects (per-file, as the gate does)", async () => {
  const file = join(dir, "wf.flow.ts");
  await writeFile(
    file,
    `
import { workflow, contract } from "@glubean/sdk";
contract.register("gate-poll", {
  project: () => ({ cases: {} }),
  executeCaseInFlow: async () => ({ status: "pending" }),
});
const ref = {
  __glubean_type: "contract-case-ref",
  contractId: "job", caseKey: "status", protocol: "gate-poll", target: "GET /job",
  contract: {},
};
export const waiting = workflow("wf-gate-poll")
  .setup(async () => ({}))
  .poll("wait", ref, { until: (w) => w.when((r) => r.status).eq("done"), timeout: 1000 })
  .build();

export const plain = workflow("wf-gate-plain")
  .setup(async () => ({}))
  .compute("c", (s) => s)
  .build();
`,
  );
  const { extractContractFromFile } = await import("@glubean/scanner");
  const extracted = await extractContractFromFile(file);
  const gated = (extracted.workflows ?? []).filter((wf) =>
    workflowNodesHaveBranchOrPoll(wf.nodes),
  );
  expect(gated.map((wf) => wf.id)).toEqual(["wf-gate-poll"]); // plain workflow NOT gated
});

test("extractContractsFromProject finds workflows in a canonical .workflow.ts file", async () => {
  // The project-level finder (glubean contracts / MCP / OpenAPI) must pick up
  // `.workflow.ts` files, not just `.flow.ts` (codex 0.6 P2).
  await writeFile(
    join(dir, "checkout.workflow.ts"),
    `
import { workflow } from "@glubean/sdk";
export const journey = workflow("checkout-journey")
  .setup(async () => ({}))
  .compute("derive", (s) => s)
  .build();
`,
  );
  const { extractContractsFromProject } = await import("@glubean/scanner");
  const { workflows } = await extractContractsFromProject(dir);
  expect(workflows.map((wf) => wf.id)).toContain("checkout-journey");
});
