/**
 * S2.6 — vNext workflow projections flow end-to-end into scan metadata.
 *
 * Pins the full chain with the REAL SDK: a `.flow.ts` fixture exporting a
 * `workflow(...)` (one built, one left un-built) → scanner runtime extraction
 * (`BuiltWorkflow._projection` read dep-free) → `ScanResult.workflows` →
 * `buildMetadata` → `BundleMetadata.workflows` (what `glubean run --upload`
 * ships inside the payload's `metadata` bucket). Before this slice the graded
 * projection never left the SDK registry — Cloud/agents saw a plain test
 * with no nodes/grades (codex S2.5 R6 P2).
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { scan } from "@glubean/scanner";
import { buildMetadata } from "../metadata.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "..", ".tmp-workflow-metadata");

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

test("workflow projections reach metadata.workflows via scan (built + un-built export)", async () => {
  const dir = join(FIXTURE_ROOT, "1");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "journeys.flow.ts"),
    `
import { workflow } from "@glubean/sdk";

export const signup = workflow({ id: "signup-journey", name: "Signup", tags: ["journey"] })
  .setup(async () => ({ n: 1 }))
  .compute("derive", (s) => ({ n: s.n + 1 }))
  .action("seed", async (_c, s) => s, { project: { writes: ["token"], note: "mint token" } })
  .branch("route", {
    when: (w) => w.when((s: { n: number }) => s.n).eq(2),
    then: (b) => b.check("verify", async () => {}),
  })
  .build();

// un-built builder export — the scanner must auto-build it.
export const probe = workflow("probe-journey")
  .setup(async () => ({}))
  .check("alive", async () => {}, { project: { asserts: "service responds" } });
`,
  );

  const scanResult = await scan(dir);
  const workflows = scanResult.workflows ?? [];
  expect(workflows.map((w) => [w.id, w.exportName])).toEqual([
    ["signup-journey", "signup"],
    ["probe-journey", "probe"],
  ]);

  const signup = workflows[0];
  expect(signup).toMatchObject({ name: "Signup", tags: ["journey"] });
  // graded nodes survive verbatim (the SDK's pre-computed projection).
  expect(signup.nodes.map((n) => [n.id, n.kind, n.grade])).toEqual([
    ["derive", "compute", "full"],
    ["seed", "action", "partial"],
    ["route", "branch", "full"],
  ]);
  const route = signup.nodes[2];
  expect(route.when).toMatchObject({ kind: "compare", op: "eq", path: ["n"], value: 2 });
  expect(route.then?.[0]).toMatchObject({ id: "verify", kind: "check", grade: "opaque" });
  expect(signup.gradeSummary).toEqual({ full: 2, partial: 1, opaque: 1 });

  // …and buildMetadata ships them on the bundle (the upload payload's
  // `metadata` bucket is this object verbatim).
  const metadata = await buildMetadata(scanResult, { generatedBy: "test" });
  expect(metadata.workflows).toEqual(workflows);
});
