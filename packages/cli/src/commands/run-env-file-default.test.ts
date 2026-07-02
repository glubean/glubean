/**
 * GLU-88 — `glubean run` end-to-end env-file default-selection regression.
 *
 * Root cause (see packages/cli/src/lib/active_env.test.ts for the unit-level
 * detail): `.glubean/active-env` is a persistent, un-TTL'd sticky file. A
 * `glubean env use prod` run once in a directory silently redirects every
 * later `glubean run` (no `--env-file`) in that same directory to
 * `.env.prod` — which is exactly what happened during GLU-70 verification
 * and shipped a passed run to the real production project.
 *
 * These tests drive the ACTUAL `glubean run` CLI subprocess (not just the
 * unit-level resolver) end to end, matching the task's acceptance
 * criteria: no `--env-file` + a directory with both `.env` and `.env.prod`
 * defaults to `.env`; an ordinary (non-prod) active-env is still honored
 * silently (backward compat — `glubean env use staging` must keep working);
 * a `prod`-named active-env is refused with a clear error instead of a
 * silent upload; and explicit `--env-file` continues to work even when it
 * points straight at `.env.prod` (never blocks an intentional, explicit
 * choice — only the implicit/silent path).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "../test-helpers.js";

// Fixtures must live INSIDE the cli package tree so pnpm workspace
// resolution reaches @glubean/sdk / @glubean/runner (mirrors
// run-snapshots.test.ts's rationale).
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "..", ".tmp-run-env-file-default");

let dir: string;
let seq = 0;

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, "");
}

function workspacePackageJson(name: string): string {
  return JSON.stringify(
    {
      name,
      type: "module",
      version: "0.0.0",
      dependencies: {
        "@glubean/sdk": "workspace:*",
        "@glubean/runner": "workspace:*",
      },
    },
    null,
    2,
  );
}

const PASSING_TEST_FILE = `
import { test } from "@glubean/sdk";

export const sanity = test("sanity", async (ctx) => {
  ctx.assert(1 + 1 === 2, "arithmetic works");
});
`;

beforeEach(async () => {
  seq += 1;
  dir = join(FIXTURE_ROOT, `case-${seq}`);
  await mkdir(join(dir, "tests"), { recursive: true });
  await writeFile(join(dir, "package.json"), workspacePackageJson(`env-default-${seq}`));
  await writeFile(join(dir, "tests", "hello.test.ts"), PASSING_TEST_FILE);
  // Distinct content per file so assertions can tell which one loaded.
  await writeFile(join(dir, ".env"), "ENV_MARKER=dotenv_default\n");
  await writeFile(join(dir, ".env.prod"), "ENV_MARKER=dotenv_prod\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

describe("glubean run — env-file default selection (GLU-88)", () => {
  test("no --env-file, no active-env, both .env and .env.prod present: loads .env, never .env.prod", async () => {
    const { code, stdout, stderr } = await runCli(["run", "tests/", "--no-session"], { cwd: dir });
    const out = stripAnsi(stdout + stderr);
    expect(code).toBe(0);
    expect(out).toContain("Loaded 1 vars from .env");
    expect(out).not.toContain(".env.prod");
  }, 30_000);

  test("active-env set to an ordinary name (staging) is still honored silently — backward compat for `glubean env use`", async () => {
    await mkdir(join(dir, ".glubean"), { recursive: true });
    await writeFile(join(dir, ".glubean", "active-env"), "staging\n");
    await writeFile(join(dir, ".env.staging"), "ENV_MARKER=dotenv_staging\n");

    const { code, stdout, stderr } = await runCli(["run", "tests/", "--no-session"], { cwd: dir });
    const out = stripAnsi(stdout + stderr);
    expect(code).toBe(0);
    expect(out).toContain("Loaded 1 vars from .env.staging");
  }, 30_000);

  test("active-env set to 'prod', no --env-file: refuses to run instead of silently loading .env.prod", async () => {
    await mkdir(join(dir, ".glubean"), { recursive: true });
    await writeFile(join(dir, ".glubean", "active-env"), "prod\n");

    const { code, stdout, stderr } = await runCli(["run", "tests/", "--no-session"], { cwd: dir });
    const out = stripAnsi(stdout + stderr);
    expect(code).not.toBe(0);
    expect(out).toContain("looks like a production environment");
    expect(out).toMatch(/--env-file \.env\.prod|glubean env reset/);
    // Must never have proceeded to actually load/run against .env.prod.
    expect(out).not.toContain("Loaded 1 vars from .env.prod");
  }, 30_000);

  test("explicit --env-file .env.prod still works even when active-env is 'prod' (explicit intent is never blocked)", async () => {
    await mkdir(join(dir, ".glubean"), { recursive: true });
    await writeFile(join(dir, ".glubean", "active-env"), "prod\n");

    const { code, stdout, stderr } = await runCli(
      ["run", "tests/", "--no-session", "--env-file", ".env.prod"],
      { cwd: dir },
    );
    const out = stripAnsi(stdout + stderr);
    expect(code).toBe(0);
    expect(out).toContain("Loaded 1 vars from .env.prod");
  }, 30_000);

  test("explicit --env-file .env still works when active-env is 'prod' (explicit default bypasses the sensitive-env guard)", async () => {
    await mkdir(join(dir, ".glubean"), { recursive: true });
    await writeFile(join(dir, ".glubean", "active-env"), "prod\n");

    const { code, stdout, stderr } = await runCli(
      ["run", "tests/", "--no-session", "--env-file", ".env"],
      { cwd: dir },
    );
    const out = stripAnsi(stdout + stderr);
    expect(code).toBe(0);
    expect(out).toContain("Loaded 1 vars from .env");
    expect(out).not.toContain(".env.prod");
  }, 30_000);
});
