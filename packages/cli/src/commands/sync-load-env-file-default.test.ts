/**
 * GLU-88 — `glubean sync` / `glubean load` env-file default-selection
 * regression.
 *
 * `sync` and `load` resolve their env file the same way `run` does
 * (`resolveEnvFileName` from `../lib/active_env.js`), and `sync` uploads a
 * full project-definition snapshot to Cloud — same class of "silently ships
 * to the wrong (prod) project" risk as `run --upload`. This locks down that
 * both call sites surface `SensitiveActiveEnvError` (GLU-88) instead of
 * silently resolving `.env.prod`, without needing real test/load files or
 * network access — the guard fires before either command does any
 * projection/upload work.
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "glubean-sync-load-env-default-"));
  await writeFile(join(dir, "package.json"), minimalPackageJson("sync-load-env-default"));
  await mkdir(join(dir, ".glubean"), { recursive: true });
  await writeFile(join(dir, ".glubean", "active-env"), "prod\n");
  await writeFile(join(dir, ".env.prod"), "ENV_MARKER=dotenv_prod\n");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("glubean sync — refuses a 'prod' active-env instead of silently uploading against it", () => {
  test("no --env-file, active-env=prod: sync fails fast with the sensitive-env message, before any projection/upload", async () => {
    const { code, stdout, stderr } = await runCli(["sync"], { cwd: dir });
    const out = stripAnsi(stdout + stderr);
    expect(code).not.toBe(0);
    expect(out).toContain("looks like a production environment");
    expect(out).not.toContain("Loaded");
  }, 30_000);
});

describe("glubean load — refuses a 'prod' active-env instead of silently running against it", () => {
  test("no --env-file, active-env=prod, a .load.ts file present: fails with the sensitive-env message before importing/running the plan", async () => {
    // resolveLoadFiles only needs a *.load.ts filename to match — the file
    // isn't imported/executed until after env resolution, so an empty
    // placeholder is enough to drive the flow past the "no files" exit and
    // into the resolveEnvFileName() guard this test targets.
    await writeFile(join(dir, "smoke.load.ts"), "// placeholder — never imported, env guard fires first\n");

    const { code, stdout, stderr } = await runCli(["load"], { cwd: dir });
    const out = stripAnsi(stdout + stderr);
    expect(code).not.toBe(0);
    expect(out).toContain("looks like a production environment");
    expect(out).not.toContain("Loaded");
  }, 30_000);
});
