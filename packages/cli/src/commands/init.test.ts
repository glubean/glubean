/**
 * Integration tests for the init command (3-step wizard).
 * Only non-interactive tests — interactive tests require TTY piping.
 */

import { test, expect, vi } from "vitest";

// Init tests spawn the CLI which runs `npm install` — allow generous timeout
vi.setConfig({ testTimeout: 60_000 });
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

    // Check that basic files were created
    expect(await fileExists(join(dir, "package.json"))).toBe(true);
    expect(await fileExists(join(dir, ".env"))).toBe(true);
    expect(await fileExists(join(dir, ".env.secrets"))).toBe(true);
    expect(await fileExists(join(dir, ".gitignore"))).toBe(true);
    expect(await fileExists(join(dir, "README.md"))).toBe(true);
    expect(await fileExists(join(dir, "context/openapi.sample.json"))).toBe(true);
    expect(await fileExists(join(dir, "tests/demo.test.ts"))).toBe(true);
    expect(await fileExists(join(dir, "tests/data-driven.test.ts"))).toBe(true);
    expect(await fileExists(join(dir, "tests/pick.test.ts"))).toBe(true);
    expect(await fileExists(join(dir, "data/create-user.json"))).toBe(true);
    expect(await fileExists(join(dir, "data/search-examples.json"))).toBe(true);
    expect(await fileExists(join(dir, "GLUBEAN.md"))).toBe(true);
    expect(await fileExists(join(dir, "local/README.md"))).toBe(true);

    // Explore files
    expect(await fileExists(join(dir, "explore/api.test.ts"))).toBe(true);
    expect(await fileExists(join(dir, "explore/search.test.ts"))).toBe(true);
    expect(await fileExists(join(dir, "explore/auth.test.ts"))).toBe(true);

    // Verify package.json content
    const pkgJson = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
    expect(pkgJson.dependencies?.["@glubean/sdk"]).toBeDefined();
    expect(typeof pkgJson.scripts?.scan).toBe("string");
    expect(typeof pkgJson.scripts?.["validate-metadata"]).toBe("string");

    // Verify .env contains default base URL
    const envContent = await readFile(join(dir, ".env"), "utf-8");
    expect(envContent).toContain("https://dummyjson.com");

    // Verify sample test uses builder API and ctx.http
    const testContent = await readFile(join(dir, "tests/demo.test.ts"), "utf-8");
    expect(testContent).toContain("ctx.http");
    expect(testContent).toContain(".step(");
    expect(testContent).not.toContain(".build()");
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
    expect(testsContent).toContain("glubean run --ci");
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

test("init --minimal creates minimal files", async () => {
  const dir = await createTempDir();
  try {
    const { code } = await runCli(
      ["init", "--minimal", "--no-interactive"],
      { cwd: dir },
    );
    expect(code).toBe(0);

    expect(await fileExists(join(dir, "package.json"))).toBe(true);
    expect(await fileExists(join(dir, ".env"))).toBe(true);
    expect(await fileExists(join(dir, ".env.secrets"))).toBe(true);
    expect(await fileExists(join(dir, ".gitignore"))).toBe(true);
    expect(await fileExists(join(dir, "README.md"))).toBe(true);
    expect(await fileExists(join(dir, "explore/api.test.ts"))).toBe(true);
    expect(await fileExists(join(dir, "explore/search.test.ts"))).toBe(true);
    expect(await fileExists(join(dir, "explore/auth.test.ts"))).toBe(true);
    expect(await fileExists(join(dir, "data/search-examples.json"))).toBe(true);
    expect(await fileExists(join(dir, "tests/demo.test.ts"))).toBe(true);
    expect(await fileExists(join(dir, "GLUBEAN.md"))).toBe(true);
    expect(await fileExists(join(dir, "local/README.md"))).toBe(true);
    expect(await fileExists(join(dir, ".env.staging"))).toBe(true);
    expect(await fileExists(join(dir, ".env.staging.secrets"))).toBe(true);

    // Verify package.json has explore and test scripts
    const pkgJson = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
    expect(typeof pkgJson.scripts?.explore).toBe("string");
    expect(pkgJson.scripts?.test).toBe("glubean run");
    expect(pkgJson.scripts?.["test:staging"]).toBe("glubean run --env-file .env.staging");
    expect(pkgJson.scripts?.["test:ci"]).toBe("glubean run --ci --result-json");
    expect(pkgJson.glubean?.run?.testDir).toBe("./tests");

    // Verify .env has DummyJSON
    const envContent = await readFile(join(dir, ".env"), "utf-8");
    expect(envContent).toContain("dummyjson.com");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
