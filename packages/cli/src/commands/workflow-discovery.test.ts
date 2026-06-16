/**
 * Discovery + classification for vNext workflows: `.workflow.ts` is the
 * canonical extension (`.flow.ts` is the legacy alias), and the project-level
 * finder must pick up `.workflow.ts` artifacts WITHOUT importing a
 * `.workflow.test.ts` file (the never-import-test-files invariant).
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, afterEach, expect, test } from "vitest";
import { classifyGlubeanFile } from "./run.js";

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
const FIXTURE_ROOT = join(HERE, "..", "..", ".tmp-workflow-discovery");
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

test("extractContractsFromProject finds .workflow.ts artifacts but never imports .workflow.test.ts", async () => {
  // The project-level finder (glubean contracts / MCP / OpenAPI) must pick up
  // canonical `.workflow.ts` artifacts (codex 0.6 P2) — but match by SUFFIX,
  // not the `.workflow.` substring, or it would import a normal test file like
  // `decoy.workflow.test.ts` (violating the never-import-test-files invariant).
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
  // A test file whose name contains ".workflow." — if the finder imported it
  // (substring match) the top-level throw would surface as an extraction error.
  await writeFile(
    join(dir, "decoy.workflow.test.ts"),
    `throw new Error("test files must never be runtime-imported by the finder");\n`,
  );
  const { extractContractsFromProject } = await import("@glubean/scanner");
  const { workflows, errors } = await extractContractsFromProject(dir);
  expect(workflows.map((wf) => wf.id)).toContain("checkout-journey");
  // The decoy was NOT imported — no error from its top-level throw.
  expect(errors).toEqual([]);
});
