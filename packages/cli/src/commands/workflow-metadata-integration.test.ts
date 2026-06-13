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
import { discoverTests } from "./run.js";

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
    ["derive", "compute", "partial"], // S2.18: compute = traced dataflow, logic undeclarable
    ["seed", "action", "partial"],
    ["route", "branch", "full"],
  ]);
  const route = signup.nodes[2];
  // branch lowers to the family IR (addendum §9): then = cases[0]
  expect(route.mode).toBe("predicate");
  expect(route.cases?.[0].when).toMatchObject({ kind: "compare", op: "eq", path: ["n"], value: 2 });
  expect(route.cases?.[0].nodes[0]).toMatchObject({ id: "verify", kind: "check", grade: "opaque" });
  expect(signup.gradeSummary).toEqual({ full: 1, partial: 2, opaque: 1 });

  // …and buildMetadata ships them on the bundle (the upload payload's
  // `metadata` bucket is this object verbatim).
  const metadata = await buildMetadata(scanResult, { generatedBy: "test" });
  expect(metadata.workflows).toEqual(workflows);

  // What scan advertises, run must execute: discoverTests emits one runnable
  // per workflow (riding the "flow" kind during migration — codex S2.6 R2 P2).
  const discovered = await discoverTests(join(dir, "journeys.flow.ts"));
  const wfEntries = discovered.filter((d) =>
    ["signup-journey", "probe-journey"].includes(d.meta.id),
  );
  expect(wfEntries.map((d) => [d.meta.id, d.exportName, d.meta.kind])).toEqual([
    ["signup-journey", "signup", "flow"],
    ["probe-journey", "probe", "flow"],
  ]);
  expect(wfEntries[0].meta).toMatchObject({ name: "Signup", tags: ["journey"] });
});

test("a .test.ts workflow is discovered as a 'flow'-kind runnable with the static branch/poll flag", async () => {
  const dir = join(FIXTURE_ROOT, "3");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "journeys.test.ts");
  await writeFile(
    file,
    `
import { workflow, test } from "@glubean/sdk";

export const branched = workflow("wf-branched")
  .setup(async () => ({ ok: true }))
  .branch("route", {
    when: (w) => w.when((s) => s.ok).eq(true),
    then: (b) => b.compute("c", (s) => s),
  })
  .build();

export const linear = workflow("wf-linear").compute("c", (s) => s).build();

export const plain = test("plain-test", async (ctx) => { ctx.log("x"); });

export const parked = workflow({ id: "wf-parked", skip: "not ready" })
  .setup(async () => ({ ok: true }))
  .branch("route", {
    when: (w) => w.when((s) => s.ok).eq(true),
    then: (b) => b.compute("c", (s) => s),
  })
  .build();
`,
  );
  const discovered = await discoverTests(file);
  const byId = Object.fromEntries(
    discovered.map((d) => [
      d.meta.id,
      [d.meta.kind, d.meta.workflowHasBranchOrPoll ?? false, d.meta.deferred],
    ]),
  );
  // workflows ride the "flow" kind even in .test.ts (suite kinds:[flow] keeps
  // them); the branch flag is STATIC — the upload gate reads it without ever
  // importing the test file (codex S2.6 R10 P2). A skipped workflow carries
  // its reason as `deferred` so the gate excludes it (codex R13).
  expect(byId).toEqual({
    "wf-branched": ["flow", true, undefined],
    "wf-linear": ["flow", false, undefined],
    "plain-test": ["test", false, undefined],
    "wf-parked": ["flow", true, "not ready"],
  });
});

test("workflow.each over an OBJECT table with $_pick in the id stays concrete (not a pick group)", async () => {
  const dir = join(FIXTURE_ROOT, "5");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "keyed.flow.ts");
  await writeFile(
    file,
    `
import { workflow } from "@glubean/sdk";
export const keyed = workflow.each({
  alpha: { currency: "USD" },
  beta: { currency: "EUR" },
})(
  { id: "keyed-$_pick" }, // map key in the id — but each is DETERMINISTIC
  (wf, row) => wf.setup(async () => ({ c: row.currency })).compute("derive", (s) => s),
);
`,
  );
  const discovered = await discoverTests(file);
  const ids = discovered.filter((d) => d.meta.id.startsWith("keyed")).map((d) => d.meta.id).sort();
  expect(ids).toEqual(["keyed-alpha", "keyed-beta"]); // concrete rows, no template collapse
});

test("lifecycle notes reach scan metadata (S2.16, phase4 §6)", async () => {
  const dir = join(FIXTURE_ROOT, "6");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "hooks.flow.ts"),
    `
import { workflow } from "@glubean/sdk";
export const wf = workflow("lh-meta")
  .setup(async () => ({}), { note: "boots the receiver glue" })
  .compute("c", (s) => s)
  .teardown(async () => {}, { note: "tears the tunnel down", timeout: 5000 })
  .build();
`,
  );
  const scanResult = await scan(dir);
  const wf = (scanResult.workflows ?? []).find((w) => w.id === "lh-meta");
  expect(wf?.setup).toEqual({ note: "boots the receiver glue" });
  expect(wf?.teardown).toEqual({ note: "tears the tunnel down", timeoutMs: 5000 });
});

test("a workflow-ONLY project scans as non-empty (no false warning) and still builds metadata", async () => {
  const dir = join(FIXTURE_ROOT, "2");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "only.flow.ts"),
    `
import { workflow } from "@glubean/sdk";
export const wf = workflow("only-wf").compute("c", (s) => s).build();
`,
  );

  const scanResult = await scan(dir);
  // the static test extractor doesn't read .flow.ts, so files stays empty —
  // exactly the shape the scan command's presence gate must accept
  // (codex S2.6 R3 P2) and the scanner must not warn about (R1 P3).
  expect(scanResult.fileCount).toBe(0);
  expect(scanResult.workflows?.map((w) => w.id)).toEqual(["only-wf"]);
  expect(scanResult.warnings.some((w) => w.includes("No Glubean"))).toBe(false);

  const metadata = await buildMetadata(scanResult, { generatedBy: "test" });
  expect(metadata.workflows?.map((w) => w.id)).toEqual(["only-wf"]);
});
