import { test, expect } from "vitest";
import type { FileMeta, ScanResult } from "@glubean/scanner";
import {
  buildMetadata,
  computeRootHash,
  deriveMetadataStats,
  normalizeFileMap,
} from "./metadata.js";

test("computeRootHash is order independent", async () => {
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

  expect(hashA).toBe(hashB);
});

test("deriveMetadataStats counts tests and tags", () => {
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
  expect(stats.fileCount).toBe(1);
  expect(stats.testCount).toBe(2);
  expect(stats.tags).toEqual(["auth", "smoke"]);
});

test("normalizeFileMap rejects duplicate normalized paths", () => {
  const files: Record<string, FileMeta> = {
    "tests\\a.ts": { hash: "sha256-a", exports: [] },
    "tests/a.ts": { hash: "sha256-b", exports: [] },
  };

  expect(() => normalizeFileMap(files)).toThrow(
    "Duplicate file path after normalization",
  );
});

test("buildMetadata preserves contract given preconditions for upload payloads", async () => {
  const scanResult: ScanResult = {
    specVersion: "1",
    files: {},
    testCount: 0,
    fileCount: 0,
    tags: [],
    warnings: [],
    flows: [],
    contracts: [
      {
        contractId: "invite-member",
        exportName: "inviteMember",
        line: 1,
        endpoint: "POST /teams/:teamId/invites",
        protocol: "http",
        cases: [
          {
            key: "duplicate",
            line: 10,
            description: "Duplicate member email is rejected.",
            expectStatus: 409,
            given: "the email already belongs to a team member",
          },
        ],
      },
    ],
  };

  const metadata = await buildMetadata(scanResult, {
    generatedBy: "test",
    generatedAt: "2026-04-28T00:00:00.000Z",
  });

  expect(metadata.contracts?.[0]?.cases[0]?.given).toBe(
    "the email already belongs to a team member",
  );
});
