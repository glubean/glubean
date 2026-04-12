/**
 * Integration tests for the scan command.
 */

import { test, expect } from "vitest";
import { join } from "node:path";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runCli } from "../test-helpers.js";
import type { BundleMetadata } from "@glubean/scanner";

async function createTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "glubean-scan-test-"));
}

const TEST_FILE_CONTENT = `import { test } from "@glubean/sdk";

export const myTest = test({
  id: "test-1",
  name: "My Test",
  tags: ["smoke"],
}, async (ctx) => {
  ctx.log("Hello");
});
`;

test("scan command generates metadata.json with valid structure", async () => {
  const dir = await createTempDir();
  try {
    await writeFile(join(dir, "api.test.ts"), TEST_FILE_CONTENT, "utf-8");

    // Create package.json with SDK dependency
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "test-project",
        type: "module",
        dependencies: { "@glubean/sdk": "workspace:*" },
      }),
      "utf-8",
    );

    const { code } = await runCli(["scan", "--dir", dir]);
    expect(code).toBe(0);

    // Verify metadata.json was created
    const metadataContent = await readFile(join(dir, "metadata.json"), "utf-8");
    const metadata: BundleMetadata = JSON.parse(metadataContent);

    expect(metadata.schemaVersion).toBe("1");
    expect(typeof metadata.rootHash).toBe("string");
    expect(metadata.rootHash.startsWith("sha256-")).toBe(true);
    expect(typeof metadata.generatedBy).toBe("string");
    expect(typeof metadata.generatedAt).toBe("string");
    expect(metadata.fileCount).toBe(1);
    expect(metadata.testCount).toBe(1);
    expect(metadata.tags).toEqual(["smoke"]);
    expect(Object.keys(metadata.files).length).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scan command exits with error when no test files found", async () => {
  const dir = await createTempDir();
  try {
    await writeFile(join(dir, "package.json"), "{}", "utf-8");

    const { code } = await runCli(["scan", "--dir", dir]);
    expect(code).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scan command succeeds on contract-only project (no test() exports)", async () => {
  const dir = await createTempDir();
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "contract-only",
        type: "module",
        dependencies: { "@glubean/sdk": "workspace:*" },
      }),
      "utf-8",
    );

    await writeFile(
      join(dir, "create.contract.ts"),
      `import { contract } from "@glubean/sdk";
export const createUser = contract.http("create-user", {
  endpoint: "POST /users",
  description: "新用户注册账号",
  feature: "用户注册",
  cases: {
    success: {
      description: "邮箱和密码注册成功",
      expect: { status: 201 },
    },
  },
});`,
      "utf-8",
    );

    const { code } = await runCli(["scan", "--dir", dir]);
    // Should NOT exit with 1 — contracts exist even though no test() exports
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scan command emits description lint warnings for technical descriptions", async () => {
  const dir = await createTempDir();
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "lint-test",
        type: "module",
        dependencies: { "@glubean/sdk": "workspace:*" },
      }),
      "utf-8",
    );

    await writeFile(
      join(dir, "api.contract.ts"),
      `import { contract } from "@glubean/sdk";
export const c = contract.http("my-api", {
  endpoint: "GET /health",
  description: "POST /users endpoint",
  cases: {
    ok: {
      description: "returns 200 on success",
      expect: { status: 200 },
    },
  },
});`,
      "utf-8",
    );

    const { code, stdout } = await runCli(["scan", "--dir", dir]);
    expect(code).toBe(0);
    // Contract-level description lint
    expect(stdout).toContain("my-api.(contract)");
    expect(stdout).toContain("HTTP method");
    // Case-level description lint
    expect(stdout).toContain("my-api.ok");
    expect(stdout).toContain("status code");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
