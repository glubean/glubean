import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { BundleMetadata } from "@glubean/scanner";

/**
 * Tests for the scan command.
 * These are integration tests that create temp directories and verify output.
 */

async function createTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "glubean-scan-test-" });
}

async function cleanupDir(dir: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
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

Deno.test(
  "scan command generates metadata.json with valid structure",
  async () => {
    const dir = await createTempDir();
    try {
      // Create a test file
      await Deno.writeTextFile(join(dir, "api.test.ts"), TEST_FILE_CONTENT);

      // Create deno.json with SDK import
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({
          imports: {
            "@glubean/sdk": "jsr:@glubean/sdk@^0.2.0",
          },
        })
      );

      // Run the scan using subprocess (avoids Deno.exit issues)
      const command = new Deno.Command("deno", {
        args: [
          "run",
          "-A",
          join(Deno.cwd(), "packages/cli/mod.ts"),
          "scan",
          "--dir",
          dir,
        ],
        cwd: Deno.cwd().replace(/\/packages\/cli$/, ""),
        stdout: "piped",
        stderr: "piped",
      });

      const { code, stdout, stderr } = await command.output();
      const stdoutText = new TextDecoder().decode(stdout);
      const stderrText = new TextDecoder().decode(stderr);

      if (code !== 0) {
        console.log("stdout:", stdoutText);
        console.log("stderr:", stderrText);
      }

      assertEquals(code, 0, "scan command should succeed");

      // Verify metadata.json was created
      const metadataPath = join(dir, "metadata.json");
      const metadataContent = await Deno.readTextFile(metadataPath);
      const metadata: BundleMetadata = JSON.parse(metadataContent);

      assertEquals(metadata.schemaVersion, "1");
      assertEquals(typeof metadata.rootHash, "string");
      assertEquals(metadata.rootHash.startsWith("sha256-"), true);
      assertEquals(typeof metadata.generatedBy, "string");
      assertEquals(typeof metadata.generatedAt, "string");
      assertEquals(metadata.fileCount, 1);
      assertEquals(metadata.testCount, 1);
      assertEquals(metadata.tags, ["smoke"]);
      assertEquals(Object.keys(metadata.files).length, 1);
    } finally {
      await cleanupDir(dir);
    }
  }
);

Deno.test(
  "scan command exits with error when no test files found",
  async () => {
    const dir = await createTempDir();
    try {
      // Create empty deno.json (no test files)
      await Deno.writeTextFile(join(dir, "deno.json"), "{}");

      const command = new Deno.Command("deno", {
        args: [
          "run",
          "-A",
          join(Deno.cwd(), "packages/cli/mod.ts"),
          "scan",
          "--dir",
          dir,
        ],
        cwd: Deno.cwd().replace(/\/packages\/cli$/, ""),
        stdout: "piped",
        stderr: "piped",
      });

      const { code } = await command.output();

      assertEquals(
        code,
        1,
        "scan command should fail when no test files found"
      );
    } finally {
      await cleanupDir(dir);
    }
  }
);
