/**
 * GLU-244 — `glubean load --profile <name>` CLI wiring (end-to-end via the
 * real CLI entry point, mirroring sync-load-env-file-default.test.ts's
 * style: drive fast, pre-execution error/guard paths so these tests don't
 * need a real runnable `.load.ts` plan or network access).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
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

  test("GLU-244 codex R1 P1: a typo'd plan target fails the WHOLE run even when a sibling plan's target resolves fine (no silent partial success)", async () => {
    // plan-a's target exists; plan-b's does not — this must NOT exit 0 having
    // silently only run plan-a.
    await writeFile(join(dir, "plan-a.load.ts"), "// placeholder — never imported\n");
    const { code, stdout, stderr } = await runCli(["load", "--profile", "perf"], { cwd: dir });
    const out = stripAnsi(stdout + stderr);
    expect(code).not.toBe(0);
    expect(out).toContain("No .load.ts files found for");
    expect(out).toContain("./plan-b.load.ts");
    // plan-a's target itself resolved to a file, so ONLY plan-b is named as empty.
    expect(out).not.toMatch(/found for.*plan-a\.load\.ts/s);
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

describe("glubean load --profile — upload wiring (GLU-244 codex R1 P2 fixes)", () => {
  test("profile.upload.enabled auto-triggers the upload preflight without --upload (mirrors `run`'s profile.upload.enabled auto-enable)", async () => {
    await writeFile(join(dir, "plan-a.load.ts"), "// placeholder — preflight fails before import\n");
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
    upload:
      enabled: true
      projectId: prj_x
      tokenEnv: TOKEN_X_UNSET_FOR_THIS_TEST
`;
    await writeFile(join(dir, "glubean.yaml"), yaml, "utf-8");

    // No --upload flag at all — profile.upload.enabled must still trigger
    // the preflight (and fail on the missing token), proving upload isn't
    // gated on the CLI flag alone.
    const { code, stdout, stderr } = await runCli(["load", "--profile", "perf"], {
      cwd: dir,
      env: { TOKEN_X_UNSET_FOR_THIS_TEST: "" },
    });
    const out = stripAnsi(stdout + stderr);
    expect(code).not.toBe(0);
    expect(out).toContain("Upload failed: no auth token found");
    expect(out).toContain("TOKEN_X_UNSET_FOR_THIS_TEST");
  }, 30_000);

  test("--project override drops the profile's targetId instead of pairing it with the wrong project (mirrors `run`)", async () => {
    const requests: string[] = [];
    const server: Server = createServer((req, res) => {
      requests.push(req.url ?? "");
      if (req.url === "/v1/projects/prj_other") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "prj_other", name: "Other" }));
        return;
      }
      if (req.url === "/v1/projects/prj_other/targets") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ id: "tgt_other_default", slug: "default" }]));
        return;
      }
      // Anything else — including the WRONG pre-fix explicit-target check
      // `/v1/projects/prj_other/targets/tgt_a` (pairing --project's override
      // with the PROFILE's own target id) — 404s.
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const addr = server.address();
    const apiUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : addr}`;

    try {
      await writeFile(join(dir, "plan-a.load.ts"), "// placeholder\n");
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
    upload:
      projectId: prj_perf
      targetId: tgt_a
`;
      await writeFile(join(dir, "glubean.yaml"), yaml, "utf-8");

      await runCli(
        [
          "load", "--profile", "perf", "--upload",
          "--project", "prj_other", "--token", "faketoken", "--api-url", apiUrl,
        ],
        { cwd: dir },
      );

      expect(requests).not.toContain("/v1/projects/prj_other/targets/tgt_a");
      expect(requests).toContain("/v1/projects/prj_other/targets");
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }, 30_000);
});
