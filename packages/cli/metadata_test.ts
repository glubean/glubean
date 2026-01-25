import { assertEquals, assertRejects } from "@std/assert";
import type { FileMeta } from "@glubean/scanner";
import {
  computeRootHash,
  deriveMetadataStats,
  normalizeFileMap,
} from "./metadata.ts";

Deno.test("computeRootHash is order independent", async () => {
  const fileA: FileMeta = { hash: "sha256-a", exports: [] };
  const fileB: FileMeta = { hash: "sha256-b", exports: [] };

  const hashA = await computeRootHash({
    "b.ts": fileB,
    "a.ts": fileA,
  });
  const hashB = await computeRootHash({
    "a.ts": fileA,
    "b.ts": fileB,
  });

  assertEquals(hashA, hashB);
});

Deno.test("deriveMetadataStats counts tests and tags", () => {
  const files: Record<string, FileMeta> = {
    "api.test.ts": {
      hash: "sha256-a",
      exports: [
        {
          type: "test",
          id: "login",
          exportName: "login",
          tags: ["smoke"],
        },
        {
          type: "test",
          id: "auth-reset",
          exportName: "authReset",
          tags: ["auth", "smoke"],
        },
      ],
    },
  };

  const stats = deriveMetadataStats(files);
  assertEquals(stats.fileCount, 1);
  assertEquals(stats.testCount, 2);
  assertEquals(stats.tags, ["auth", "smoke"]);
});

Deno.test("normalizeFileMap rejects duplicate normalized paths", async () => {
  const files: Record<string, FileMeta> = {
    "tests\\a.ts": { hash: "sha256-a", exports: [] },
    "tests/a.ts": { hash: "sha256-b", exports: [] },
  };

  await assertRejects(
    async () => {
      normalizeFileMap(files);
    },
    Error,
    "Duplicate file path after normalization"
  );
});
