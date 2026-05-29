/**
 * Config consolidation (docs/06 P2) — `glubean run` no-target / `--explore`
 * behavior. With the legacy package.json `glubean` flat-shape gone, a bare
 * `glubean run` defaults to the `local` profile and `--explore` maps to the
 * `explore` profile (deprecated). We assert via the fast profile-resolution
 * error path (a glubean.yaml that intentionally lacks those profiles), which
 * proves the defaulting without needing a runnable suite.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runCli } from "../test-helpers.js";

// glubean.yaml with neither `local` nor `explore` profile — so the
// auto-defaulted profile name surfaces in the "not found" error.
const YAML_NO_DEFAULT_PROFILES = `version: 1
suites:
  tests: { target: ./tests, kinds: [test] }
profiles:
  ci: { suites: [tests] }
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "glubean-p2-consolidation-"));
  await writeFile(join(dir, "glubean.yaml"), YAML_NO_DEFAULT_PROFILES, "utf-8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("run config consolidation (no-target / --explore)", () => {
  test("bare `glubean run` defaults to the `local` profile", async () => {
    const { code, stderr } = await runCli(["run"], { cwd: dir });
    expect(code).not.toBe(0);
    expect(stderr).toContain('Profile "local" not found');
  });

  test("`--explore` maps to the `explore` profile and warns it is deprecated", async () => {
    const { code, stderr } = await runCli(["run", "--explore"], { cwd: dir });
    expect(code).not.toBe(0);
    expect(stderr).toContain("--explore is deprecated");
    expect(stderr).toContain('Profile "explore" not found');
  });

  test("`--suite` with no target narrows the defaulted local profile (not 'requires --profile')", async () => {
    const { stderr } = await runCli(["run", "--suite", "tests"], { cwd: dir });
    // Proves the local-profile defaulting runs BEFORE the --suite guard:
    // we reach profile resolution (local not found) instead of bailing on
    // "--suite requires --profile".
    expect(stderr).not.toContain("--suite requires --profile");
    expect(stderr).toContain('Profile "local" not found');
  });

  test("explicit positional target still runs ad-hoc (no profile required)", async () => {
    // A non-existent target resolves to zero test files and exits non-zero,
    // but it must NOT trip profile resolution — proving target runs bypass
    // the local-profile default entirely.
    const { stderr } = await runCli(["run", "./does-not-exist"], { cwd: dir });
    expect(stderr).not.toContain('Profile "local" not found');
  });
});
