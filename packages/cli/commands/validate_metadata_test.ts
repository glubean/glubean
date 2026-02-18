import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import type { BundleMetadata, FileMeta } from "@glubean/scanner";

/**
 * Tests for the validate-metadata command.
 */

async function createTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "glubean-validate-test-" });
}

async function cleanupDir(dir: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
}

async function sha256(content: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return `sha256-${encodeHex(new Uint8Array(hash))}`;
}

async function computeRootHash(
  files: Record<string, { hash: string }>,
): Promise<string> {
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  const payload = entries
    .map(([filePath, meta]) => `${filePath}:${meta.hash}`)
    .join("\n");
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return `sha256-${encodeHex(new Uint8Array(hash))}`;
}

async function runValidateCommand(
  dir: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = new Deno.Command("deno", {
    args: [
      "run",
      "-A",
      join(Deno.cwd(), "packages/cli/mod.ts"),
      "validate-metadata",
      "--dir",
      dir,
    ],
    cwd: Deno.cwd().replace(/\/packages\/cli$/, ""),
    stdout: "piped",
    stderr: "piped",
  });

  const result = await command.output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

Deno.test("validate-metadata passes with valid metadata", async () => {
  const dir = await createTempDir();
  try {
    const fileContent = "export const x = 1;";
    const filePath = "test.ts";
    await Deno.writeTextFile(join(dir, filePath), fileContent);

    const fileHash = await sha256(fileContent);
    const files: Record<string, FileMeta> = {
      [filePath]: { hash: fileHash, exports: [] },
    };

    const metadata: BundleMetadata = {
      schemaVersion: "1",
      specVersion: "2.0",
      generatedBy: "@glubean/cli@0.2.0",
      generatedAt: new Date().toISOString(),
      rootHash: await computeRootHash(files),
      files,
      testCount: 0,
      fileCount: 1,
      tags: [],
    };

    await Deno.writeTextFile(
      join(dir, "metadata.json"),
      JSON.stringify(metadata, null, 2),
    );

    const { code } = await runValidateCommand(dir);
    assertEquals(code, 0, "validate-metadata should pass with valid metadata");
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("validate-metadata fails when metadata.json is missing", async () => {
  const dir = await createTempDir();
  try {
    const { code } = await runValidateCommand(dir);
    assertEquals(
      code,
      1,
      "validate-metadata should fail when metadata.json is missing",
    );
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("validate-metadata fails with invalid schemaVersion", async () => {
  const dir = await createTempDir();
  try {
    const metadata = {
      schemaVersion: "99",
      specVersion: "2.0",
      generatedBy: "@glubean/cli@0.2.0",
      generatedAt: new Date().toISOString(),
      rootHash: "sha256-fake",
      files: {},
      testCount: 0,
      fileCount: 0,
      tags: [],
    };

    await Deno.writeTextFile(
      join(dir, "metadata.json"),
      JSON.stringify(metadata, null, 2),
    );

    const { code } = await runValidateCommand(dir);
    assertEquals(
      code,
      1,
      "validate-metadata should fail with invalid schemaVersion",
    );
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("validate-metadata fails when file hash mismatch", async () => {
  const dir = await createTempDir();
  try {
    const fileContent = "export const x = 1;";
    const filePath = "test.ts";
    await Deno.writeTextFile(join(dir, filePath), fileContent);

    const wrongHash = "sha256-wrong-hash-does-not-match";
    const files: Record<string, FileMeta> = {
      [filePath]: { hash: wrongHash, exports: [] },
    };

    const metadata: BundleMetadata = {
      schemaVersion: "1",
      specVersion: "2.0",
      generatedBy: "@glubean/cli@0.2.0",
      generatedAt: new Date().toISOString(),
      rootHash: await computeRootHash(files),
      files,
      testCount: 0,
      fileCount: 1,
      tags: [],
    };

    await Deno.writeTextFile(
      join(dir, "metadata.json"),
      JSON.stringify(metadata, null, 2),
    );

    const { code } = await runValidateCommand(dir);
    assertEquals(
      code,
      1,
      "validate-metadata should fail with file hash mismatch",
    );
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test(
  "validate-metadata fails when referenced file is missing",
  async () => {
    const dir = await createTempDir();
    try {
      const files: Record<string, FileMeta> = {
        "missing-file.ts": { hash: "sha256-fake", exports: [] },
      };

      const metadata: BundleMetadata = {
        schemaVersion: "1",
        specVersion: "2.0",
        generatedBy: "@glubean/cli@0.2.0",
        generatedAt: new Date().toISOString(),
        rootHash: await computeRootHash(files),
        files,
        testCount: 0,
        fileCount: 1,
        tags: [],
      };

      await Deno.writeTextFile(
        join(dir, "metadata.json"),
        JSON.stringify(metadata, null, 2),
      );

      const { code } = await runValidateCommand(dir);
      assertEquals(
        code,
        1,
        "validate-metadata should fail when file is missing",
      );
    } finally {
      await cleanupDir(dir);
    }
  },
);

Deno.test("validate-metadata fails when rootHash mismatch", async () => {
  const dir = await createTempDir();
  try {
    const fileContent = "export const x = 1;";
    const filePath = "test.ts";
    await Deno.writeTextFile(join(dir, filePath), fileContent);

    const fileHash = await sha256(fileContent);
    const files: Record<string, FileMeta> = {
      [filePath]: { hash: fileHash, exports: [] },
    };

    const metadata: BundleMetadata = {
      schemaVersion: "1",
      specVersion: "2.0",
      generatedBy: "@glubean/cli@0.2.0",
      generatedAt: new Date().toISOString(),
      rootHash: "sha256-wrong-root-hash",
      files,
      testCount: 0,
      fileCount: 1,
      tags: [],
    };

    await Deno.writeTextFile(
      join(dir, "metadata.json"),
      JSON.stringify(metadata, null, 2),
    );

    const { code } = await runValidateCommand(dir);
    assertEquals(
      code,
      1,
      "validate-metadata should fail with rootHash mismatch",
    );
  } finally {
    await cleanupDir(dir);
  }
});
