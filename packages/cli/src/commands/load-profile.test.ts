/**
 * GLU-244 — `glubean load --profile <name>` CLI wiring (end-to-end via the
 * real CLI entry point, mirroring sync-load-env-file-default.test.ts's
 * style: drive fast, pre-execution error/guard paths so these tests don't
 * need a real runnable `.load.ts` plan or network access).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "../test-helpers.js";

let dir: string;

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, "");
}

function minimalPackageJson(name: string): string {
  return JSON.stringify(
    { name, type: "module", version: "0.0.0", dependencies: { "@glubean/sdk": "workspace:*" } },
    null,
    2,
  );
}

const YAML_TWO_PLANS = `version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
load:
  plans:
    plan-a: { target: ./plan-a.load.ts }
    plan-b: { target: ./plan-b.load.ts }
profiles:
  local: { suites: [tests] }
  perf:
    load:
      plans: [plan-a, plan-b]
`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "glubean-load-profile-"));
  await writeFile(join(dir, "package.json"), minimalPackageJson("load-profile-cli"));
  await writeFile(join(dir, "glubean.yaml"), YAML_TWO_PLANS, "utf-8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("glubean load --profile — CLI flag guards", () => {
  test("--plan without --profile is rejected", async () => {
    const { code, stdout, stderr } = await runCli(["load", "--plan", "plan-a"], { cwd: dir });
    const out = stripAnsi(stdout + stderr);
    expect(code).not.toBe(0);
    expect(out).toContain("--plan requires --profile");
  }, 30_000);

  test("--profile <missing> surfaces the resolveLoadPlan 'not found' error", async () => {
    const { code, stdout, stderr } = await runCli(["load", "--profile", "nope"], { cwd: dir });
    const out = stripAnsi(stdout + stderr);
    expect(code).not.toBe(0);
    expect(out).toContain('Profile "nope" not found');
    expect(out).toContain("Available profiles: local, perf");
  }, 30_000);

  test("--profile <name> with no `load.plans` declared errors clearly", async () => {
    const { code, stdout, stderr } = await runCli(["load", "--profile", "local"], { cwd: dir });
    const out = stripAnsi(stdout + stderr);
    expect(code).not.toBe(0);
    expect(out).toContain('Profile "local" has no `load.plans` declared');
  }, 30_000);

  test("--plan <name> not declared in the profile's load.plans errors clearly", async () => {
    const { code, stdout, stderr } = await runCli(
      ["load", "--profile", "perf", "--plan", "bogus"],
      { cwd: dir },
    );
    const out = stripAnsi(stdout + stderr);
    expect(code).not.toBe(0);
    expect(out).toContain('--plan "bogus" is not declared in profile "perf"');
  }, 30_000);
});

describe("glubean load --profile — plan target resolution", () => {
  test("with no --plan, ALL of the profile's load.plans targets are searched", async () => {
    const { code, stdout, stderr } = await runCli(["load", "--profile", "perf"], { cwd: dir });
    const out = stripAnsi(stdout + stderr);
    expect(code).not.toBe(0);
    expect(out).toContain("No .load.ts files found");
    expect(out).toContain("./plan-a.load.ts");
    expect(out).toContain("./plan-b.load.ts");
  }, 30_000);

  test("--plan narrows the search to just the one named plan", async () => {
    const { code, stdout, stderr } = await runCli(
      ["load", "--profile", "perf", "--plan", "plan-b"],
      { cwd: dir },
    );
    const out = stripAnsi(stdout + stderr);
    expect(code).not.toBe(0);
    expect(out).toContain("No .load.ts files found");
    expect(out).toContain("./plan-b.load.ts");
    expect(out).not.toContain("./plan-a.load.ts");
  }, 30_000);
});

describe("glubean load --profile — envFile passthrough (equivalent to run's handling, GLU-244)", () => {
  test("profile.envFile bypasses the sensitive-active-env guard (explicit envFile, like an explicit --env-file)", async () => {
    await mkdir(join(dir, ".glubean"), { recursive: true });
    await writeFile(join(dir, ".glubean", "active-env"), "prod\n");
    await writeFile(join(dir, ".env.staging"), "ENV_MARKER=dotenv_staging\n");
    await writeFile(join(dir, "plan-a.load.ts"), "// placeholder — never imported\n");
    const yaml = `version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
load:
  plans:
    plan-a: { target: ./plan-a.load.ts }
profiles:
  local: { suites: [tests] }
  perf:
    envFile: .env.staging
    load:
      plans: [plan-a]
`;
    await writeFile(join(dir, "glubean.yaml"), yaml, "utf-8");

    const { stdout, stderr } = await runCli(["load", "--profile", "perf"], { cwd: dir });
    const out = stripAnsi(stdout + stderr);
    // Bypasses the guard because envFile is now EXPLICIT (from the profile) —
    // may still fail later (no runnable plan / no loadRunner export), but
    // must get PAST the sensitive-env check.
    expect(out).not.toContain("looks like a production environment");
  }, 30_000);

  test("a profile with no envFile falls through to the active-env guard (backward-compatible default)", async () => {
    await mkdir(join(dir, ".glubean"), { recursive: true });
    await writeFile(join(dir, ".glubean", "active-env"), "prod\n");
    await writeFile(join(dir, "plan-a.load.ts"), "// placeholder — never imported\n");
    const yaml = `version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
load:
  plans:
    plan-a: { target: ./plan-a.load.ts }
profiles:
  local: { suites: [tests] }
  perf:
    load:
      plans: [plan-a]
`;
    await writeFile(join(dir, "glubean.yaml"), yaml, "utf-8");

    const { code, stdout, stderr } = await runCli(["load", "--profile", "perf"], { cwd: dir });
    const out = stripAnsi(stdout + stderr);
    expect(code).not.toBe(0);
    expect(out).toContain("looks like a production environment");
  }, 30_000);
});
