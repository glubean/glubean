/**
 * Integration tests for test.each — verifies discovery through dynamic import.
 *
 * These tests create temporary test files using test.each, then invoke
 * a discovery script via tsx to confirm:
 * 1. All expanded tests are discovered from array exports
 * 2. Each test has the correct interpolated ID
 * 3. Tags are inherited by all generated tests
 */

import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// GLU-79: each test here spawns a real tsx subprocess (via execFile) and
// flaked at vitest's old 5000ms default under contended load (0.8.4 release
// CI: 4x5s timeouts). Now covered by the package-wide testTimeout: 30_000 in
// vitest.config.ts — don't re-tighten below that.

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tsxBin = resolve(
  dirname(require.resolve("tsx/package.json")),
  "dist/cli.mjs",
);

// Resolve the SDK entry point for imports in test files
const sdkEntry = pathToFileURL(
  resolve(__dirname, "../../../sdk/src/index.ts"),
).href;

async function discoverTestsFromFile(
  filePath: string,
): Promise<Array<{ id: string; name: string; tags?: string[]; exportName?: string }>> {
  const fileUrl = pathToFileURL(resolve(filePath)).href;

  // Use .mts extension so tsx treats it as ESM (top-level await works)
  const script = `
const testModule = await import(${JSON.stringify(fileUrl)});

function isTest(value) {
  return value && typeof value === "object" && value.meta && value.meta.id;
}

const tests = [];

for (const [name, value] of Object.entries(testModule)) {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isTest(item)) {
        tests.push({
          exportName: name,
          id: item.meta.id,
          name: item.meta.name,
          tags: item.meta.tags,
        });
      }
    }
  } else if (isTest(value)) {
    tests.push({
      exportName: name,
      id: value.meta.id,
      name: value.meta.name,
      tags: value.meta.tags,
    });
  }
}

console.log(JSON.stringify(tests));
`;

  const tempFile = join(tmpdir(), `glubean-discover-${Date.now()}.mts`);
  await writeFile(tempFile, script, "utf-8");

  try {
    return await new Promise((res, rej) => {
      execFile(
        "node",
        [tsxBin, tempFile],
        // GLU-79: hung-process kill-net only — must sit ABOVE the package's
        // 30s vitest testTimeout so slow-under-load spawns surface as vitest
        // timeouts, not opaque execFile SIGTERMs.
        { encoding: "utf-8", timeout: 60_000 },
        (error, stdout, stderr) => {
          if (error) {
            rej(new Error(`Discovery failed: ${stderr}`));
            return;
          }
          try {
            res(JSON.parse(stdout.trim()));
          } catch (e) {
            rej(new Error(`Failed to parse discovery output: ${stdout}`));
          }
        },
      );
    });
  } finally {
    await rm(tempFile, { force: true });
  }
}

test("test.each integration - discovers expanded tests from array export", async () => {
  const tempFile = join(
    await mkdtemp(join(tmpdir(), "glubean-each-")),
    "test.ts",
  );
  await writeFile(
    tempFile,
    `
import { test } from "${sdkEntry}";

export const statusTests = test.each([
  { code: 200, label: "ok" },
  { code: 404, label: "not-found" },
  { code: 500, label: "error" },
])("status-$code", async (_ctx, _data) => {});
`,
    "utf-8",
  );

  try {
    const tests = await discoverTestsFromFile(tempFile);
    expect(tests.length).toBe(3);
    expect(tests[0].id).toBe("status-200");
    expect(tests[1].id).toBe("status-404");
    expect(tests[2].id).toBe("status-500");
    for (const t of tests) {
      expect(t.exportName).toBe("statusTests");
    }
  } finally {
    await rm(dirname(tempFile), { recursive: true, force: true });
  }
});

test("test.each integration - tags are inherited by all expanded tests", async () => {
  const tempFile = join(
    await mkdtemp(join(tmpdir(), "glubean-each-")),
    "test.ts",
  );
  await writeFile(
    tempFile,
    `
import { test } from "${sdkEntry}";

export const taggedTests = test.each([
  { role: "admin" },
  { role: "viewer" },
])(
  { id: "auth-$role", tags: ["auth", "rbac"] },
  async (_ctx, _data) => {},
);
`,
    "utf-8",
  );

  try {
    const tests = await discoverTestsFromFile(tempFile);
    expect(tests.length).toBe(2);
    expect(tests[0].id).toBe("auth-admin");
    expect(tests[0].tags).toEqual(["auth", "rbac"]);
    expect(tests[1].id).toBe("auth-viewer");
    expect(tests[1].tags).toEqual(["auth", "rbac"]);
  } finally {
    await rm(dirname(tempFile), { recursive: true, force: true });
  }
});

test("test.each integration - mixed exports: .each array + regular test", async () => {
  const tempFile = join(
    await mkdtemp(join(tmpdir(), "glubean-each-")),
    "test.ts",
  );
  await writeFile(
    tempFile,
    `
import { test } from "${sdkEntry}";

export const healthCheck = test("health", async (_ctx) => {});

export const paramTests = test.each([
  { id: 1 },
  { id: 2 },
])("get-item-$id", async (_ctx, _data) => {});
`,
    "utf-8",
  );

  try {
    const tests = await discoverTestsFromFile(tempFile);
    expect(tests.length).toBe(3);

    const health = tests.find((t) => t.id === "health");
    const item1 = tests.find((t) => t.id === "get-item-1");
    const item2 = tests.find((t) => t.id === "get-item-2");

    expect(health).toBeDefined();
    expect(item1).toBeDefined();
    expect(item2).toBeDefined();
  } finally {
    await rm(dirname(tempFile), { recursive: true, force: true });
  }
});

test("test.each integration - $index interpolation in discovery", async () => {
  const tempFile = join(
    await mkdtemp(join(tmpdir(), "glubean-each-")),
    "test.ts",
  );
  await writeFile(
    tempFile,
    `
import { test } from "${sdkEntry}";

export const indexedTests = test.each([
  { val: "a" },
  { val: "b" },
])("row-$index-$val", async (_ctx, _data) => {});
`,
    "utf-8",
  );

  try {
    const tests = await discoverTestsFromFile(tempFile);
    expect(tests.length).toBe(2);
    expect(tests[0].id).toBe("row-0-a");
    expect(tests[1].id).toBe("row-1-b");
  } finally {
    await rm(dirname(tempFile), { recursive: true, force: true });
  }
});
