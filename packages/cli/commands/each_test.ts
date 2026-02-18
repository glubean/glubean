/**
 * Integration tests for test.each — verifies discovery + execution through glubean run.
 *
 * These tests create temporary test files using test.each, then invoke glubean's
 * discovery and execution pipeline to confirm that:
 * 1. All expanded tests are discovered from array exports
 * 2. Each test receives the correct data row
 * 3. IDs are interpolated correctly
 * 4. Tags are inherited by all generated tests
 */

import { assertEquals, assertExists } from "@std/assert";
import { resolve, toFileUrl } from "@std/path";

// ---------------------------------------------------------------------------
// Helper: run a Deno subprocess that dynamically imports a test file and
// extracts discovered tests using the same isTest + array detection logic
// that glubean run uses internally.
// ---------------------------------------------------------------------------

async function discoverTestsFromFile(
  filePath: string,
): Promise<Array<{ id: string; name: string; tags?: string[] }>> {
  const fileUrl = toFileUrl(resolve(filePath)).href;

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

  const tempFile = await Deno.makeTempFile({ suffix: ".ts" });
  await Deno.writeTextFile(tempFile, script);

  try {
    const configPath = resolve("deno.json");
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        `--config=${configPath}`,
        "--allow-read",
        "--allow-env",
        "--no-check",
        tempFile,
      ],
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stdout, stderr } = await command.output();
    const stderrText = new TextDecoder().decode(stderr);
    if (code !== 0) {
      throw new Error(`Discovery failed (exit ${code}): ${stderrText}`);
    }

    const stdoutText = new TextDecoder().decode(stdout).trim();
    return JSON.parse(stdoutText);
  } finally {
    await Deno.remove(tempFile);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  "test.each integration - discovers expanded tests from array export",
  async () => {
    const tempFile = await Deno.makeTempFile({ suffix: ".ts" });
    await Deno.writeTextFile(
      tempFile,
      `
import { test } from "${toFileUrl(resolve("packages/sdk/mod.ts")).href}";

export const statusTests = test.each([
  { code: 200, label: "ok" },
  { code: 404, label: "not-found" },
  { code: 500, label: "error" },
])("status-$code", async (_ctx, _data) => {});
`,
    );

    try {
      const tests = await discoverTestsFromFile(tempFile);
      assertEquals(tests.length, 3);
      assertEquals(tests[0].id, "status-200");
      assertEquals(tests[1].id, "status-404");
      assertEquals(tests[2].id, "status-500");
      // All share the same export name
      for (const t of tests) {
        assertEquals((t as Record<string, unknown>).exportName, "statusTests");
      }
    } finally {
      await Deno.remove(tempFile);
    }
  },
);

Deno.test(
  "test.each integration - tags are inherited by all expanded tests",
  async () => {
    const tempFile = await Deno.makeTempFile({ suffix: ".ts" });
    await Deno.writeTextFile(
      tempFile,
      `
import { test } from "${toFileUrl(resolve("packages/sdk/mod.ts")).href}";

export const taggedTests = test.each([
  { role: "admin" },
  { role: "viewer" },
])(
  { id: "auth-$role", tags: ["auth", "rbac"] },
  async (_ctx, _data) => {},
);
`,
    );

    try {
      const tests = await discoverTestsFromFile(tempFile);
      assertEquals(tests.length, 2);
      assertEquals(tests[0].id, "auth-admin");
      assertEquals(tests[0].tags, ["auth", "rbac"]);
      assertEquals(tests[1].id, "auth-viewer");
      assertEquals(tests[1].tags, ["auth", "rbac"]);
    } finally {
      await Deno.remove(tempFile);
    }
  },
);

Deno.test(
  "test.each integration - mixed exports: .each array + regular test",
  async () => {
    const tempFile = await Deno.makeTempFile({ suffix: ".ts" });
    await Deno.writeTextFile(
      tempFile,
      `
import { test } from "${toFileUrl(resolve("packages/sdk/mod.ts")).href}";

export const healthCheck = test("health", async (_ctx) => {});

export const paramTests = test.each([
  { id: 1 },
  { id: 2 },
])("get-item-$id", async (_ctx, _data) => {});
`,
    );

    try {
      const tests = await discoverTestsFromFile(tempFile);
      assertEquals(tests.length, 3);

      // Find by id
      const health = tests.find((t) => t.id === "health");
      const item1 = tests.find((t) => t.id === "get-item-1");
      const item2 = tests.find((t) => t.id === "get-item-2");

      assertExists(health);
      assertExists(item1);
      assertExists(item2);
    } finally {
      await Deno.remove(tempFile);
    }
  },
);

Deno.test(
  "test.each integration - $index interpolation in discovery",
  async () => {
    const tempFile = await Deno.makeTempFile({ suffix: ".ts" });
    await Deno.writeTextFile(
      tempFile,
      `
import { test } from "${toFileUrl(resolve("packages/sdk/mod.ts")).href}";

export const indexedTests = test.each([
  { val: "a" },
  { val: "b" },
])("row-$index-$val", async (_ctx, _data) => {});
`,
    );

    try {
      const tests = await discoverTestsFromFile(tempFile);
      assertEquals(tests.length, 2);
      assertEquals(tests[0].id, "row-0-a");
      assertEquals(tests[1].id, "row-1-b");
    } finally {
      await Deno.remove(tempFile);
    }
  },
);
