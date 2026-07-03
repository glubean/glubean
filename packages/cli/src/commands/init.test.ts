/**
 * Integration tests for the init command (3-step wizard).
 * Only non-interactive tests — interactive tests require TTY piping.
 */

import { test, expect, vi } from "vitest";

// Init tests spawn the CLI which runs `npm install` — allow generous timeout.
// GLU-79: 60s → 90s; contended load (full-monorepo `pnpm -r test`) pushed init
// runs past the old budget. Must stay BELOW runCli's 120s execFile kill-net
// (test-helpers.ts) so a slow run surfaces as a vitest timeout, not SIGTERM 143.
vi.setConfig({ testTimeout: 90_000 });
import { join } from "node:path";
import { mkdtemp, writeFile, readFile, rm, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runCli } from "../test-helpers.js";

async function createTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "glubean-init-test-"));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Non-interactive tests (--no-interactive)
// ---------------------------------------------------------------------------

test("init --no-interactive creates basic project files", async () => {
  const dir = await createTempDir();
  try {
    const { code } = await runCli(["init", "--no-interactive"], { cwd: dir });
    expect(code).toBe(0);

    // Check that the 8 minimal files were created
    expect(await fileExists(join(dir, "package.json"))).toBe(true);
    expect(await fileExists(join(dir, "glubean.yaml"))).toBe(true);
    expect(await fileExists(join(dir, ".env"))).toBe(true);
    expect(await fileExists(join(dir, ".env.secrets"))).toBe(true);
    expect(await fileExists(join(dir, ".gitignore"))).toBe(true);
    expect(await fileExists(join(dir, "GLUBEAN.md"))).toBe(true);
    expect(await fileExists(join(dir, "tests/api.test.ts"))).toBe(true);
    expect(await fileExists(join(dir, "contracts/users.contract.ts"))).toBe(true);

    // Old heavy scaffold files must NOT be created
    expect(await fileExists(join(dir, "glubean.setup.ts"))).toBe(false);
    expect(await fileExists(join(dir, "README.md"))).toBe(false);
    expect(await fileExists(join(dir, "context/openapi.sample.json"))).toBe(false);
    expect(await fileExists(join(dir, "explore/api.test.ts"))).toBe(false);

    // Verify package.json content
    const pkgJson = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
    expect(pkgJson.dependencies?.["@glubean/sdk"]).toBeDefined();
    // Runner must be in dependencies (not devDependencies) so pnpm installs
    // it under all environments including --prod, and the VSCode extension
    // can probe node_modules/@glubean/runner for the project-local runner.
    expect(pkgJson.dependencies?.["@glubean/runner"]).toBeDefined();
    expect(pkgJson.devDependencies?.["@glubean/runner"]).toBeUndefined();
    expect(typeof pkgJson.scripts?.test).toBe("string");
    expect(typeof pkgJson.scripts?.["test:ci"]).toBe("string");

    // GLU-110 / GitHub #9 regression: `npm test` must resolve the local
    // `glubean` binary, not fall back to whatever stale `glubean` happens
    // to be on the machine's global PATH. The CLI must be a direct dep
    // (so node_modules/.bin/glubean exists after install)...
    expect(pkgJson.dependencies?.["@glubean/cli"]).toBeDefined();
    expect(pkgJson.devDependencies?.["@glubean/cli"]).toBeUndefined();
    // ...and installDependencies() must have actually materialized the
    // local binary: this is the real assertion that `npm test`'s bare
    // `glubean` command resolves to node_modules/.bin, not the global one.
    expect(await fileExists(join(dir, "node_modules/.bin/glubean"))).toBe(true);

    // Verify .env contains default base URL
    const envContent = await readFile(join(dir, ".env"), "utf-8");
    expect(envContent).toContain("https://dummyjson.com");

    // Verify example test uses configure() + {{BASE_URL}} pattern
    const testContent = await readFile(join(dir, "tests/api.test.ts"), "utf-8");
    expect(testContent).toContain("configure(");
    expect(testContent).toContain("{{BASE_URL}}");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init --no-interactive --base-url uses custom URL", async () => {
  const dir = await createTempDir();
  try {
    const { code } = await runCli(
      ["init", "--no-interactive", "--base-url", "https://api.example.com"],
      { cwd: dir },
    );
    expect(code).toBe(0);

    const envContent = await readFile(join(dir, ".env"), "utf-8");
    expect(envContent).toContain("https://api.example.com");
    expect(await fileExists(join(dir, "package.json"))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init --no-interactive --base-url accepts localhost URL", async () => {
  const dir = await createTempDir();
  try {
    const { code } = await runCli(
      ["init", "--no-interactive", "--base-url", "http://localhost:3000"],
      { cwd: dir },
    );
    expect(code).toBe(0);

    const envContent = await readFile(join(dir, ".env"), "utf-8");
    expect(envContent).toContain("BASE_URL=http://localhost:3000");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init --no-interactive --base-url rejects malformed URL", async () => {
  const dir = await createTempDir();
  try {
    const { code, stderr } = await runCli(
      ["init", "--no-interactive", "--base-url", "not-a-url"],
      { cwd: dir },
    );
    expect(code).toBe(1);
    expect(await fileExists(join(dir, "package.json"))).toBe(false);
    expect(stderr).toContain("Invalid base URL from --base-url");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init --no-interactive --base-url rejects unsupported protocol", async () => {
  const dir = await createTempDir();
  try {
    const { code, stderr } = await runCli(
      ["init", "--no-interactive", "--base-url", "ftp://example.com"],
      { cwd: dir },
    );
    expect(code).toBe(1);
    expect(await fileExists(join(dir, "package.json"))).toBe(false);
    expect(stderr).toContain("Only http:// and https:// are supported");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init --no-interactive skips existing files", async () => {
  const dir = await createTempDir();
  try {
    await writeFile(join(dir, "package.json"), '{"existing": true}', "utf-8");

    const { code, stdout } = await runCli(["init", "--no-interactive"], { cwd: dir });
    expect(code).toBe(0);

    // Verify the existing file was not overwritten
    const content = await readFile(join(dir, "package.json"), "utf-8");
    expect(content).toBe('{"existing": true}');
    expect(stdout).toContain("skip");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init --no-interactive --overwrite replaces existing files", async () => {
  const dir = await createTempDir();
  try {
    await writeFile(join(dir, "package.json"), '{"existing": true}', "utf-8");

    const { code, stdout } = await runCli(
      ["init", "--overwrite", "--no-interactive"],
      { cwd: dir },
    );
    expect(code).toBe(0);

    const content = await readFile(join(dir, "package.json"), "utf-8");
    expect(content).toContain('"dependencies"');
    expect(stdout).toContain("overwrite");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init --no-interactive --github-actions creates workflow files", async () => {
  const dir = await createTempDir();
  try {
    const { code } = await runCli(
      ["init", "--github-actions", "--no-interactive"],
      { cwd: dir },
    );
    expect(code).toBe(0);

    const metadataPath = join(dir, ".github/workflows/glubean-metadata.yml");
    expect(await fileExists(metadataPath)).toBe(true);

    const metadataContent = await readFile(metadataPath, "utf-8");
    expect(metadataContent).toContain("Glubean Metadata");
    expect(metadataContent).toContain("glubean scan");

    const testsPath = join(dir, ".github/workflows/glubean-tests.yml");
    expect(await fileExists(testsPath)).toBe(true);

    const testsContent = await readFile(testsPath, "utf-8");
    expect(testsContent).toContain("Glubean Tests");
    expect(testsContent).toContain("glubean ci run");
    expect(testsContent).toContain("upload-artifact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init --overwrite-actions overwrites both workflow files", async () => {
  const dir = await createTempDir();
  try {
    // First init to create the files
    await runCli(["init", "--github-actions", "--no-interactive"], { cwd: dir });

    // Tamper with both workflow files
    const metadataPath = join(dir, ".github/workflows/glubean-metadata.yml");
    const testsPath = join(dir, ".github/workflows/glubean-tests.yml");
    await writeFile(metadataPath, "custom-metadata", "utf-8");
    await writeFile(testsPath, "custom-tests", "utf-8");

    // Re-init with --overwrite-actions
    const { code } = await runCli(
      ["init", "--github-actions", "--overwrite-actions", "--no-interactive"],
      { cwd: dir },
    );
    expect(code).toBe(0);

    const metadataContent = await readFile(metadataPath, "utf-8");
    expect(metadataContent).toContain("Glubean Metadata");

    const testsContent = await readFile(testsPath, "utf-8");
    expect(testsContent).toContain("Glubean Tests");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init --no-interactive --hooks creates git hooks when .git exists", async () => {
  const dir = await createTempDir();
  try {
    await mkdir(join(dir, ".git/hooks"), { recursive: true });

    const { code } = await runCli(
      ["init", "--hooks", "--no-interactive"],
      { cwd: dir },
    );
    expect(code).toBe(0);

    expect(await fileExists(join(dir, ".git/hooks/pre-commit"))).toBe(true);
    expect(await fileExists(join(dir, ".git/hooks/pre-push"))).toBe(true);

    const preCommit = await readFile(join(dir, ".git/hooks/pre-commit"), "utf-8");
    expect(preCommit).toContain("glubean scan");

    const prePush = await readFile(join(dir, ".git/hooks/pre-push"), "utf-8");
    expect(prePush).toContain("validate-metadata");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init --no-interactive --hooks fails when no .git directory", async () => {
  const dir = await createTempDir();
  try {
    const { code, stderr } = await runCli(
      ["init", "--hooks", "--no-interactive"],
      { cwd: dir },
    );
    expect(code).toBe(1);
    expect(await fileExists(join(dir, "package.json"))).toBe(false);
    expect(stderr).toContain("git init");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init --no-interactive --hooks --github-actions creates both", async () => {
  const dir = await createTempDir();
  try {
    await mkdir(join(dir, ".git/hooks"), { recursive: true });

    const { code } = await runCli(
      ["init", "--hooks", "--github-actions", "--no-interactive"],
      { cwd: dir },
    );
    expect(code).toBe(0);

    expect(await fileExists(join(dir, ".git/hooks/pre-commit"))).toBe(true);
    expect(await fileExists(join(dir, ".git/hooks/pre-push"))).toBe(true);
    expect(await fileExists(join(dir, ".github/workflows/glubean-metadata.yml"))).toBe(true);
    expect(await fileExists(join(dir, ".github/workflows/glubean-tests.yml"))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init --contract-first creates contract-first project", async () => {
  const dir = await createTempDir();
  try {
    const { code } = await runCli(
      ["init", "--contract-first", "--no-interactive"],
      { cwd: dir },
    );
    expect(code).toBe(0);

    expect(await fileExists(join(dir, "package.json"))).toBe(true);
    expect(await fileExists(join(dir, ".env"))).toBe(true);
    expect(await fileExists(join(dir, ".env.secrets"))).toBe(true);
    expect(await fileExists(join(dir, ".gitignore"))).toBe(true);
    expect(await fileExists(join(dir, "glubean.setup.ts"))).toBe(true);
    expect(await fileExists(join(dir, "contracts/README.md"))).toBe(true);
    expect(await fileExists(join(dir, "contracts/health.contract.ts"))).toBe(true);
    expect(await fileExists(join(dir, "types/README.md"))).toBe(true);
    expect(await fileExists(join(dir, "schemas/README.md"))).toBe(true);
    // Phase 4: canonical glubean.yaml replaces ci-config/*.yaml.
    expect(await fileExists(join(dir, "glubean.yaml"))).toBe(true);
    expect(await fileExists(join(dir, "ci-config/default.yaml"))).toBe(false);
    expect(await fileExists(join(dir, "ci-config/ci.yaml"))).toBe(false);
    // Starter test so multi-suite CI has a file to discover in tests/.
    expect(await fileExists(join(dir, "tests/sample.test.ts"))).toBe(true);
    expect(await fileExists(join(dir, "GLUBEAN.md"))).toBe(true);

    // Verify glubean.yaml declares both contracts + tests suites
    const yamlContent = await readFile(join(dir, "glubean.yaml"), "utf-8");
    expect(yamlContent).toContain("contracts:");
    expect(yamlContent).toContain("tests:");
    expect(yamlContent).toMatch(/suites:\s*\[contracts,\s*tests\]/);

    // Verify package.json scripts use new profile-driven invocations
    const pkgJson = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
    expect(pkgJson.scripts?.["contract:run"]).toBe("glubean run contracts/");
    expect(pkgJson.scripts?.test).toBe("glubean run --profile local");
    expect(pkgJson.scripts?.["test:ci"]).toBe("glubean ci run");
    expect(pkgJson.dependencies?.zod).toBeDefined();
    expect(pkgJson.dependencies?.["@glubean/runner"]).toBeDefined();
    expect(pkgJson.devDependencies?.["@glubean/runner"]).toBeUndefined();
    // GLU-110 / GitHub #9 regression — see the basic-template test above
    // for the full rationale.
    expect(pkgJson.dependencies?.["@glubean/cli"]).toBeDefined();
    expect(pkgJson.devDependencies?.["@glubean/cli"]).toBeUndefined();
    expect(await fileExists(join(dir, "node_modules/.bin/glubean"))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init --template demo scaffolds package.json with CLI as a direct dep (GLU-110)", async () => {
  const dir = await createTempDir();
  try {
    const { code } = await runCli(
      ["init", "--template", "demo", "--no-interactive"],
      { cwd: dir },
    );
    expect(code).toBe(0);
    expect(await fileExists(join(dir, "package.json"))).toBe(true);

    // GLU-110 / GitHub #9: the demo template's `npm test` is also a bare
    // `glubean run --profile local` — it needs the same local-bin guarantee
    // as the standard + contract-first templates. The demo scaffold does
    // NOT run `npm install` (initDemo() never calls installDependencies()),
    // so this only checks the generated package.json, not node_modules.
    const pkgJson = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
    expect(pkgJson.dependencies?.["@glubean/sdk"]).toBeDefined();
    expect(pkgJson.dependencies?.["@glubean/runner"]).toBeDefined();
    expect(pkgJson.dependencies?.["@glubean/cli"]).toBeDefined();
    expect(pkgJson.devDependencies?.["@glubean/cli"]).toBeUndefined();
    expect(pkgJson.scripts?.test).toBe("glubean run --profile local");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
