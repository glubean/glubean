/**
 * GLU-155 — a contract/test file that throws during import must fail the
 * `glubean run` process, not exit 0.
 *
 * Real dogfood bug: a `.contract.ts` file accessed a `configure()` value at
 * module load time (only legal during test execution), so importing it
 * threw. The CLI printed "Contract import failed: ..." but `discoverTests`
 * swallowed the failure by returning `[]` — indistinguishable from a file
 * that legitimately exports zero tests. The run then finished, summarized
 * only the files that DID import, and exited 0: CI/dogfood read green while
 * an entire contract file silently never ran.
 *
 * These are subprocess-level tests (via `runCli`) because the failure and
 * its effect on the exit code / summary line span discovery (`discoverTests`
 * in run.ts) AND the aggregation/exit-code logic in `runCommand`, which
 * calls `process.exit` directly and can't be exercised as a plain function
 * call. Fixtures live under `packages/cli/.tmp-*` so pnpm workspace
 * resolution reaches `@glubean/sdk` via hoisted node_modules (same
 * constraint as run-discovery.test.ts / run-snapshots.test.ts).
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { runCli } from "../test-helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "..", ".tmp-run-import-failure-exit");
let fixtureSeq = 0;

async function prepareFixture(
  name: string,
  files: Record<string, string>,
): Promise<string> {
  fixtureSeq += 1;
  const dir = join(FIXTURE_ROOT, `${name}-${fixtureSeq}`);
  await mkdir(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf-8");
  }
  return dir;
}

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

function workspacePackageJson(name: string): string {
  return JSON.stringify(
    { name, type: "module", version: "0.0.0", dependencies: { "@glubean/sdk": "workspace:*" } },
    null,
    2,
  );
}

// Contract module that throws during import — mirrors the dogfood repro
// (module-load-time access of a value only readable during test execution).
const BROKEN_CONTRACT = `
import { configure, contract } from "@glubean/sdk";

const { vars } = configure({ vars: { base: "{{base_url}}" } });
const leaked = vars.base; // throws at import time — not inside a test/case

const api = contract.http.with("brokenApi", { endpoint: leaked });

export const ping = api("broken.ping", {
  endpoint: "GET /ping",
  cases: { ok: { description: "ok", expect: { status: 200 } } },
});
`;

const GOOD_TEST = `
import { test } from "@glubean/sdk";

export const trivial = test("trivial-pass", async () => {});
`;

test("glubean run: a file that throws on import fails the run (non-zero exit) and is named in the summary, while sibling files still execute", async () => {
  const dir = await prepareFixture("mixed", {
    "package.json": workspacePackageJson("glu155-mixed"),
    "contracts/broken.contract.ts": BROKEN_CONTRACT,
    "contracts/good.test.ts": GOOD_TEST,
  });

  const { code, stdout, stderr } = await runCli(["run", "contracts/"], { cwd: dir });
  const out = stdout + stderr;

  // The sibling good file was NOT skipped/fail-fasted — it still discovered
  // and ran its test to completion.
  expect(out).toContain("trivial-pass");
  expect(out).toContain("PASSED");

  // The broken file's import error is still surfaced with its diagnostic...
  expect(out).toContain("Contract import failed");
  expect(out).toContain("configure() values can only be accessed during test execution");

  // ...AND now shows up as an explicit discovery failure in the summary...
  expect(out).toContain("Discovery:");
  expect(out).toMatch(/1 file\(s\) failed to import/);
  expect(out).toContain("broken.contract.ts");

  // ...AND the process must NOT exit 0 despite the discovered test passing.
  expect(code).not.toBe(0);
}, 30_000);

test("glubean run: an all-good multi-file run is unaffected — exits 0, no Discovery line", async () => {
  const dir = await prepareFixture("all-good", {
    "package.json": workspacePackageJson("glu155-all-good"),
    "contracts/one.test.ts": `
import { test } from "@glubean/sdk";
export const first = test("first-pass", async () => {});
`,
    "contracts/two.test.ts": `
import { test } from "@glubean/sdk";
export const second = test("second-pass", async () => {});
`,
  });

  const { code, stdout, stderr } = await runCli(["run", "contracts/"], { cwd: dir });
  const out = stdout + stderr;

  expect(out).toContain("first-pass");
  expect(out).toContain("second-pass");
  expect(out).not.toContain("Discovery:");
  expect(out).not.toContain("Contract import failed");
  expect(code).toBe(0);
}, 30_000);

test("glubean run: a single broken file (not multi-file) still fails closed with non-zero exit (no regression)", async () => {
  const dir = await prepareFixture("single-broken", {
    "package.json": workspacePackageJson("glu155-single-broken"),
    "contracts/broken.contract.ts": BROKEN_CONTRACT,
  });

  const { code, stdout, stderr } = await runCli(
    ["run", "contracts/broken.contract.ts"],
    { cwd: dir },
  );
  const out = stdout + stderr;

  expect(out).toContain("Contract import failed");
  expect(code).not.toBe(0);
}, 30_000);

// A contract case with a fake synchronous client — never touches the
// network, always resolves 200 for GET. HttpClient is a ky-like per-method
// interface (client.get/post/...), not a generic client.request().
const FIXED_CONTRACT = `
import { contract } from "@glubean/sdk";

const fakeClient = { get: async () => ({ status: 200 }) };

const api = contract.http.with("brokenApi", {
  endpoint: "https://api.example.com",
  client: fakeClient,
});

export const ping = api("broken.ping", {
  endpoint: "GET /ping",
  cases: { ok: { description: "ok", expect: { status: 200 } } },
});
`;

test("glubean run --rerun-failed: retries a file that failed to import last run once it's fixed (GLU-155 P2 — codex R1)", async () => {
  const dir = await prepareFixture("rerun-discovery-failure", {
    "package.json": workspacePackageJson("glu155-rerun"),
    "contracts/broken.contract.ts": BROKEN_CONTRACT,
    "contracts/good.test.ts": GOOD_TEST,
  });

  // First run: broken.contract.ts fails to import, good.test.ts passes.
  const first = await runCli(["run", "contracts/"], { cwd: dir });
  expect(first.code).not.toBe(0);
  expect(first.stdout + first.stderr).toContain("Discovery:");

  // `.glubean/last-run.result.json` must record the import failure (not just
  // console output) so a later process/consumer can see this run wasn't
  // clean, and so --rerun-failed below has something to act on.
  const lastRun = JSON.parse(
    await readFile(join(dir, ".glubean", "last-run.result.json"), "utf-8"),
  );
  expect(lastRun.discoveryFailures).toHaveLength(1);
  expect(lastRun.discoveryFailures[0].filePath).toBe("contracts/broken.contract.ts");
  expect(lastRun.discoveryFailures[0].error).toContain(
    "configure() values can only be accessed during test execution",
  );

  // Fix the file, then --rerun-failed. It must retry the whole file (its
  // test ids were unknown last run) and NOT depend on good.test.ts, which
  // never failed and shouldn't be re-targeted.
  await writeFile(join(dir, "contracts/broken.contract.ts"), FIXED_CONTRACT, "utf-8");
  const second = await runCli(["run", "contracts/", "--rerun-failed"], { cwd: dir });
  const secondOut = second.stdout + second.stderr;

  expect(secondOut).toContain("file(s) that failed to import");
  expect(secondOut).not.toContain("good.test.ts");
  expect(secondOut).not.toContain("trivial-pass");
  expect(secondOut).toContain("broken.ping");
  expect(secondOut).toContain("PASSED");
  expect(secondOut).not.toContain("Discovery:");
  expect(second.code).toBe(0);
}, 30_000);

// Contract that throws at import time with an embedded secret-shaped value
// (default redaction's "bearer" global pattern) — reproduces codex R2 P1:
// an import-time exception's message can carry a real secret through to
// disk/Cloud if it isn't redacted like `context`/`customMetadata` already are.
const BROKEN_CONTRACT_WITH_SECRET = `
throw new Error("boom while importing: Bearer sk-should-be-redacted-1234567890");
`;
const LEAKED_TOKEN = "sk-should-be-redacted-1234567890";

test("glubean run: a secret embedded in an import-time error message is redacted before it's persisted (GLU-155 codex R2 P1)", async () => {
  const dir = await prepareFixture("secret-leak", {
    "package.json": workspacePackageJson("glu155-secret-leak"),
    "contracts/broken.contract.ts": BROKEN_CONTRACT_WITH_SECRET,
    "contracts/good.test.ts": GOOD_TEST,
  });

  const { code, stdout, stderr } = await runCli(["run", "contracts/"], { cwd: dir });
  expect(code).not.toBe(0);

  // The raw secret is fine in the CONSOLE diagnostic (local terminal only,
  // never persisted/uploaded) — same posture as any other local stack trace.
  expect(stdout + stderr).toContain(LEAKED_TOKEN);

  // But it must NOT reach the persisted result — same protection `context`/
  // `customMetadata` already get via `redactNonEvent`.
  const lastRun = JSON.parse(
    await readFile(join(dir, ".glubean", "last-run.result.json"), "utf-8"),
  );
  const persisted = JSON.stringify(lastRun);
  expect(persisted).not.toContain(LEAKED_TOKEN);
  expect(lastRun.discoveryFailures[0].error).not.toContain(LEAKED_TOKEN);
}, 30_000);

test("glubean run: every targeted file failing to import still persists last-run.result.json (GLU-155 codex R2 P2)", async () => {
  const dir = await prepareFixture("all-broken", {
    "package.json": workspacePackageJson("glu155-all-broken"),
    // Two files, BOTH failing to import — needs isMultiFile (testFiles.length
    // > 1) so the loop aggregates instead of exiting on the first throw (a
    // single targeted file already fails fast pre-GLU-155 — not this path).
    "contracts/broken.contract.ts": BROKEN_CONTRACT,
    "contracts/broken-2.contract.ts": BROKEN_CONTRACT.replace("brokenApi", "brokenApi2"),
  });

  // Every targeted file fails to import, so allFileTests.length === 0 and
  // the CLI takes the early-exit path (not the mixed-file path above).
  const first = await runCli(["run", "contracts/"], { cwd: dir });
  expect(first.code).not.toBe(0);

  const lastRunPath = join(dir, ".glubean", "last-run.result.json");
  const lastRun = JSON.parse(await readFile(lastRunPath, "utf-8"));
  expect(lastRun.discoveryFailures).toHaveLength(2);
  const failedPaths = lastRun.discoveryFailures.map((d: { filePath: string }) => d.filePath).sort();
  expect(failedPaths).toEqual(["contracts/broken-2.contract.ts", "contracts/broken.contract.ts"]);

  // Now --rerun-failed must be able to retry them (nothing to derive from
  // `tests` — it was always empty — but `discoveryFailures` carries them).
  await writeFile(join(dir, "contracts/broken.contract.ts"), FIXED_CONTRACT, "utf-8");
  await writeFile(
    join(dir, "contracts/broken-2.contract.ts"),
    FIXED_CONTRACT.replace("brokenApi", "brokenApi2").replace("broken.ping", "broken2.ping"),
    "utf-8",
  );
  const second = await runCli(["run", "contracts/", "--rerun-failed"], { cwd: dir });
  const secondOut = second.stdout + second.stderr;
  expect(secondOut).toContain("broken.ping");
  expect(secondOut).toContain("broken2.ping");
  expect(secondOut).toContain("PASSED");
  expect(second.code).toBe(0);
}, 30_000);

// A contract case that fails (404 where 200 expected) until "fixed" by
// swapping the client's response.
function contractWithStatus(status: number): string {
  return `
import { contract } from "@glubean/sdk";

const api = contract.http.with("statusApi", {
  endpoint: "https://api.example.com",
  client: { get: async () => ({ status: ${status} }) },
});

export const ping = api("status.ping", {
  endpoint: "GET /ping",
  cases: { ok: { description: "ok", expect: { status: 200 } } },
});
`;
}

test("glubean run --rerun-failed: a MIXED rerun (real failed test + import failure) drops id narrowing so BOTH files run in full (GLU-155 codex R3 P2)", async () => {
  // Regression guard for the discarded fix: an earlier version of this patch
  // pushed the discovery-failure file's freshly-discovered ids into the same
  // global `onlySelectors` list used for the real failed-test selector. That
  // works for a plain test() id, but silently drops every row of a
  // test.each/test.pick export (discovery only ever sees its TEMPLATE
  // sentinel id, and the harness's matchOnly does exact-id matching against
  // the RUNTIME-expanded concrete row ids — never equal). The fix instead
  // drops id-based narrowing ENTIRELY whenever any carry-over file's ids are
  // unknown. This test doesn't need an each/pick fixture to prove that: it
  // just confirms a real failed-test file (with a KNOWN id) and a
  // discovery-failure file (with an UNKNOWN id) both actually execute their
  // fixed test on --rerun-failed — proof `onlySelectors` isn't narrowing
  // either of them out.
  const dir = await prepareFixture("rerun-mixed", {
    "package.json": workspacePackageJson("glu155-rerun-mixed"),
    "contracts/failing.contract.ts": contractWithStatus(404), // real test failure
    "contracts/broken.contract.ts": BROKEN_CONTRACT, // import failure
  });

  const first = await runCli(["run", "contracts/"], { cwd: dir });
  expect(first.code).not.toBe(0);
  const firstOut = first.stdout + first.stderr;
  expect(firstOut).toContain("FAILED");
  expect(firstOut).toContain("Discovery:");

  const lastRun = JSON.parse(
    await readFile(join(dir, ".glubean", "last-run.result.json"), "utf-8"),
  );
  expect(lastRun.tests.some((t: { success: boolean }) => t.success === false)).toBe(true);
  expect(lastRun.discoveryFailures).toHaveLength(1);

  // Fix both.
  await writeFile(join(dir, "contracts/failing.contract.ts"), contractWithStatus(200), "utf-8");
  await writeFile(join(dir, "contracts/broken.contract.ts"), FIXED_CONTRACT, "utf-8");

  const second = await runCli(["run", "contracts/", "--rerun-failed"], { cwd: dir });
  const secondOut = second.stdout + second.stderr;
  // Both the previously-failed test AND the previously-unimportable file's
  // test must show up as executed and PASSED — neither silently dropped.
  expect(secondOut).toContain("status.ping");
  expect(secondOut).toContain("broken.ping");
  expect(secondOut).not.toContain("FAILED");
  expect(secondOut).not.toContain("Discovery:");
  const passedCount = (secondOut.match(/PASSED/g) ?? []).length;
  expect(passedCount).toBe(2);
  expect(second.code).toBe(0);
}, 30_000);

// Two tests in ONE file — one fails, one passes — plus a sibling contract
// with a passing case that shares no failure. Lets us prove id narrowing is
// preserved: only the failed test should re-run.
const MULTI_TEST_ONE_FAILS = `
import { test } from "@glubean/sdk";

export const passing = test("multi.passing", async () => {});
export const failing = test("multi.failing", async (ctx) => {
  ctx.assert(false, "intentionally failing");
});
`;
const MULTI_TEST_BOTH_PASS = `
import { test } from "@glubean/sdk";

export const passing = test("multi.passing", async () => {});
export const failing = test("multi.failing", async () => {});
`;

test("glubean run --rerun-failed: a PARTIAL target that excludes the import-failed file keeps precise id narrowing (GLU-155 codex R4 P2)", async () => {
  // The old run has BOTH a real failed test (in multi.test.ts) and an
  // import-failed file (broken.contract.ts). This time we --rerun-failed with
  // a target that includes ONLY multi.test.ts. The stale import failure from
  // the last run must NOT drop id narrowing for this partial target — only
  // `multi.failing` should re-run, NOT the sibling `multi.passing`.
  const dir = await prepareFixture("rerun-partial", {
    "package.json": workspacePackageJson("glu155-rerun-partial"),
    "contracts/multi.test.ts": MULTI_TEST_ONE_FAILS,
    "contracts/broken.contract.ts": BROKEN_CONTRACT,
  });

  const first = await runCli(["run", "contracts/"], { cwd: dir });
  expect(first.code).not.toBe(0);
  const lastRun = JSON.parse(
    await readFile(join(dir, ".glubean", "last-run.result.json"), "utf-8"),
  );
  expect(lastRun.discoveryFailures).toHaveLength(1);
  expect(lastRun.tests.some((t: { testId: string; success: boolean }) =>
    t.testId === "multi.failing" && t.success === false)).toBe(true);

  // Fix the failing test. Leave broken.contract.ts broken — it's NOT in the
  // partial target below, so it must not influence this rerun at all.
  await writeFile(join(dir, "contracts/multi.test.ts"), MULTI_TEST_BOTH_PASS, "utf-8");

  // Partial target: only the test file, NOT the whole directory.
  const second = await runCli(
    ["run", "contracts/multi.test.ts", "--rerun-failed"],
    { cwd: dir },
  );
  const secondOut = second.stdout + second.stderr;
  // Narrowing preserved: only the previously-failed test re-runs.
  expect(secondOut).toContain("multi.failing");
  expect(secondOut).not.toContain("multi.passing");
  const passedCount = (secondOut.match(/PASSED/g) ?? []).length;
  expect(passedCount).toBe(1);
  expect(second.code).toBe(0);
}, 30_000);
