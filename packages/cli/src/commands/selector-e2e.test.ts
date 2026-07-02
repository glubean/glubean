/**
 * End-to-end coverage for the B2 M3 `{id, rowIndex}` selector CLI (real runs).
 *
 * Spawns the actual CLI (via tsx) against a real `.each` fixture and asserts the
 * SUBSET that ran by reading `.glubean/last-run.result.json`. No fabricated data
 * — the fixture is a genuine 3-row `.each` test with one failing row.
 *
 * Fixtures live under `packages/cli/.tmp-selector-e2e/` (inside the package tree
 * so pnpm workspace resolution reaches @glubean/sdk + @glubean/runner).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { runCli } from "../test-helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "..", ".tmp-selector-e2e");
let seq = 0;

// A real 3-row `.each` test. Row id encodes a value distinct from its position
// (10/20/30) so a rowIndex-pinned selector is genuinely tested (not aliased to
// the id suffix). The middle row (user-20, rowIndex 1) FAILS.
const EACH_FIXTURE = `
import { test } from "@glubean/sdk";

export const users = test.each([
  { id: 10, ok: true },
  { id: 20, ok: false },
  { id: 30, ok: true },
])("user-$id", async (ctx, row) => {
  ctx.assert(row.ok, "row must be ok");
});
`;

function pkgJson(name: string): string {
  return JSON.stringify(
    {
      name,
      type: "module",
      version: "0.0.0",
      dependencies: { "@glubean/sdk": "workspace:*", "@glubean/runner": "workspace:*" },
    },
    null,
    2,
  );
}

async function prepare(name: string): Promise<string> {
  seq += 1;
  const dir = join(FIXTURE_ROOT, `${name}-${seq}`);
  await mkdir(join(dir, "tests"), { recursive: true });
  await writeFile(join(dir, "package.json"), pkgJson(`selector-e2e-${seq}`), "utf-8");
  await writeFile(join(dir, "tests", "each.test.ts"), EACH_FIXTURE, "utf-8");
  return dir;
}

interface LastRun {
  tests: Array<{
    testId: string;
    rowIndex?: number;
    filePath?: string;
    success: boolean;
    /** B3 T3 (`run-evidence-identity-model.md` §7/§14) — row-identity
     *  provenance, persisted so the run blob self-describes row identity
     *  without a projection join. */
    each?: { idTemplate: string; index: number; rowKey: string; stable: boolean };
  }>;
}

async function readLastRun(dir: string): Promise<LastRun> {
  return JSON.parse(await readFile(join(dir, ".glubean", "last-run.result.json"), "utf-8"));
}

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

test("--only-id selects a single .each row by concrete id", async () => {
  const dir = await prepare("only-id");
  const { stdout, stderr } = await runCli(
    ["run", "tests/", "--no-session", "--only-id", "user-30"],
    { cwd: dir },
  );
  const out = stdout + stderr;
  const last = await readLastRun(dir);
  const ids = last.tests.map((t) => t.testId).sort();

  expect(ids).toEqual(["user-30"]);
  expect(last.tests[0]?.rowIndex).toBe(2);
  expect(last.tests[0]?.success).toBe(true);
  // The other rows must not have run.
  expect(out).not.toContain("user-10");
  expect(out).not.toContain("user-20");
}, 60_000);

test("--row pins the exact rowIndex (mismatch runs nothing)", async () => {
  const dir = await prepare("row");

  // Correct rowIndex for user-10 is 0 → it runs.
  await runCli(["run", "tests/", "--no-session", "--only-id", "user-10", "--row", "0"], {
    cwd: dir,
  });
  const hit = await readLastRun(dir);
  expect(hit.tests.map((t) => t.testId)).toEqual(["user-10"]);
  expect(hit.tests[0]?.rowIndex).toBe(0);

  // Wrong rowIndex for user-10 (1) → matches nothing; the run collects zero tests.
  await runCli(["run", "tests/", "--no-session", "--only-id", "user-10", "--row", "1"], {
    cwd: dir,
  });
  const miss = await readLastRun(dir);
  expect(miss.tests).toEqual([]);
}, 60_000);

test("--rerun-failed re-runs only the previously failed row", async () => {
  const dir = await prepare("rerun");

  // Full run: 3 rows, user-20 fails.
  const full = await runCli(["run", "tests/", "--no-session"], { cwd: dir });
  expect(full.code).toBe(1);
  const afterFull = await readLastRun(dir);
  expect(afterFull.tests.map((t) => t.testId).sort()).toEqual([
    "user-10",
    "user-20",
    "user-30",
  ]);
  const failed = afterFull.tests.find((t) => t.testId === "user-20");
  expect(failed?.success).toBe(false);
  expect(failed?.rowIndex).toBe(1);
  expect(failed?.filePath).toBe("tests/each.test.ts");

  // Rerun: only the failed row runs (and fails again).
  const rerun = await runCli(["run", "tests/", "--no-session", "--rerun-failed"], { cwd: dir });
  expect(rerun.code).toBe(1);
  const afterRerun = await readLastRun(dir);
  expect(afterRerun.tests.map((t) => t.testId)).toEqual(["user-20"]);
  expect(afterRerun.tests[0]?.success).toBe(false);
}, 90_000);

test("--rerun-failed with no prior failures says nothing to rerun (exit 0)", async () => {
  const dir = await prepare("rerun-clean");

  // First, narrow to a passing row so the last run has zero failures.
  await runCli(["run", "tests/", "--no-session", "--only-id", "user-10"], { cwd: dir });

  const { code, stdout, stderr } = await runCli(
    ["run", "tests/", "--no-session", "--rerun-failed"],
    { cwd: dir },
  );
  expect(code).toBe(0);
  expect(stdout + stderr).toContain("nothing to rerun");
}, 90_000);

test("--rerun-failed works across a different cwd (rootDir-stable filePath)", async () => {
  const dir = await prepare("rerun-cwd");
  const subdir = join(dir, "tests");

  // Run 1 from the PROJECT ROOT — persists tests[].filePath relative to rootDir.
  const full = await runCli(["run", "tests/", "--no-session"], { cwd: dir });
  expect(full.code).toBe(1);

  // Run 2 from a DIFFERENT cwd (the tests/ subdir). rootDir still resolves to
  // the project root, so the failed-file narrowing must still hit each.test.ts.
  // (Pre-fix this filtered everything out and reran nothing.)
  const rerun = await runCli(["run", ".", "--no-session", "--rerun-failed"], { cwd: subdir });
  expect(rerun.code).toBe(1);
  const afterRerun = await readLastRun(dir);
  expect(afterRerun.tests.map((t) => t.testId)).toEqual(["user-20"]);
  expect(afterRerun.tests[0]?.success).toBe(false);
}, 90_000);

// ---------------------------------------------------------------------------
// B3 T3 (`run-evidence-identity-model.md` §7/§14) — the run-events channel
// (harness/engine "start" event → executor → CLI) carries `.each` row-identity
// provenance all the way into the persisted run blob (`last-run.result.json`
// today; the SAME `tests[].each` shape is what `uploadToCloud` embeds in the
// uploaded `result` blob — see `packages/cli/src/lib/upload.ts`). This closes
// the gap the T1.5 cloud-side comment flagged: row identity travels WITH the
// run, not only via a separate projection-channel join.
// ---------------------------------------------------------------------------

test("a real `glubean run` persists `.each` row-identity provenance in last-run.result.json", async () => {
  const dir = await prepare("each-provenance");
  const { code } = await runCli(["run", "tests/", "--no-session"], { cwd: dir });
  expect(code).toBe(1); // user-20 fails by fixture design

  const last = await readLastRun(dir);
  const byId = new Map(last.tests.map((t) => [t.testId, t.each]));

  expect(byId.get("user-10")).toEqual({ idTemplate: "user-$id", index: 0, rowKey: "user-10", stable: true });
  expect(byId.get("user-20")).toEqual({ idTemplate: "user-$id", index: 1, rowKey: "user-20", stable: true });
  expect(byId.get("user-30")).toEqual({ idTemplate: "user-$id", index: 2, rowKey: "user-30", stable: true });
}, 60_000);
