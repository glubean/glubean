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

test("buildMetadata carries workflow projections + workflows affect the rootHash (S2.6)", async () => {
  const files: Record<string, FileMeta> = {
    "flows/signup.flow.ts": {
      hash: "sha256-aaa",
      exports: [{ type: "test", id: "signup-journey", exportName: "signup" }],
    },
  };
  const workflows = [
    {
      id: "signup-journey",
      exportName: "signup",
      nodes: [{ kind: "compute", id: "derive", grade: "partial" as const }], // S2.18
      gradeSummary: { full: 0, partial: 1, opaque: 0 },
    },
  ];
  const base: ScanResult = {
    specVersion: "1.0",
    files,
    testCount: 1,
    fileCount: 1,
    tags: [],
    warnings: [],
    contracts: [],
  };

  const without = await buildMetadata(base, { generatedBy: "test" });
  expect(without.workflows).toBeUndefined();

  const withWf = await buildMetadata({ ...base, workflows }, { generatedBy: "test" });
  expect(withWf.workflows).toEqual(workflows);
  // a workflow projection change must change the rootHash (mirrors contracts)…
  expect(withWf.rootHash).not.toBe(without.rootHash);
  // …and workflow-free projects keep their existing hashes (no part added).
  expect(without.rootHash).toBe(await computeRootHash(files, []));
});

test("buildMetadata forwards the full contract projection (upload path) + workflows", async () => {
  const scanResult: ScanResult = {
    specVersion: "1",
    files: {},
    testCount: 0,
    fileCount: 0,
    tags: [],
    warnings: [],
    // Down-converted flat view (legacy consumers) …
    contracts: [
      {
        contractId: "get-user",
        exportName: "getUser",
        line: 1,
        endpoint: "GET /users/:id",
        protocol: "http",
        cases: [{ key: "success", line: 2, expectStatus: 200 }],
      },
    ],
    // … and the lossless full projection retained alongside it.
    contractsProjection: [
      {
        id: "get-user",
        exportName: "getUser",
        protocol: "http",
        target: "GET /users/:id",
        cases: [
          {
            key: "success",
            lifecycle: "active",
            severity: "warning",
            // Rich fields that the flat ContractStaticMeta drops:
            schemas: { response: { status: 200, body: { type: "object" } } },
            runnability: { requireSession: true },
            verifyRules: ["status is 200"],
          },
        ],
      },
    ],
    workflows: [
      {
        id: "signup-flow",
        exportName: "signupFlow",
        gradeSummary: { full: 1, partial: 0, opaque: 0 },
        nodes: [
          {
            kind: "contract-call",
            id: "n1",
            grade: "full",
            contractId: "get-user",
            caseKey: "success",
            protocol: "http",
            target: "GET /users/:id",
          },
        ],
      },
    ],
  };

  const metadata = await buildMetadata(scanResult, {
    generatedBy: "test",
    generatedAt: "2026-06-08T00:00:00.000Z",
    includeProjection: true,
  });

  // Full projection retains schema/runnability/verifyRules the flat view loses.
  expect(metadata.contractsProjection).toHaveLength(1);
  expect(metadata.contractsProjection?.[0]?.cases[0]?.schemas).toEqual({
    response: { status: 200, body: { type: "object" } },
  });
  expect(metadata.contractsProjection?.[0]?.cases[0]?.runnability).toEqual({
    requireSession: true,
  });
  // Workflows are forwarded (Design Y: always present, drives rootHash).
  expect(metadata.workflows).toHaveLength(1);
  expect(metadata.workflows?.[0]?.id).toBe("signup-flow");
});

test("buildMetadata omits contractsProjection when the scan produced none", async () => {
  const scanResult: ScanResult = {
    specVersion: "1",
    files: {},
    testCount: 0,
    fileCount: 0,
    tags: [],
    warnings: [],
    contracts: [],
  };

  const metadata = await buildMetadata(scanResult, {
    generatedBy: "test",
    includeProjection: true,
  });

  expect(metadata.contractsProjection).toBeUndefined();
  expect(metadata.workflows).toBeUndefined();
});

test("buildMetadata omits contractsProjection by default (no on-disk secret leak), keeps workflows", async () => {
  // `glubean scan` writes metadata.json (often git-kept) via buildMetadata
  // WITHOUT includeProjection. The rich CONTRACT projection (secret-bearing,
  // net-new data) must NOT leak there. `workflows` is the only representation
  // of a workflow's shape and drives rootHash, so it stays (Design Y) — the
  // upload path redacts it before persisting the server snapshot.
  const scanResult: ScanResult = {
    specVersion: "1",
    files: {},
    testCount: 0,
    fileCount: 0,
    tags: [],
    warnings: [],
    contracts: [],
    contractsProjection: [
      {
        id: "POST /login",
        exportName: "login",
        protocol: "http",
        target: "POST /login",
        cases: [
          {
            key: "ok",
            lifecycle: "active",
            severity: "warning",
            schemas: { request: { headers: { authorization: "Bearer secret" } } },
          },
        ],
      },
    ],
    workflows: [
      {
        id: "wf",
        exportName: "wf",
        gradeSummary: { full: 0, partial: 0, opaque: 0 },
        nodes: [],
      },
    ],
  };

  const metadata = await buildMetadata(scanResult, { generatedBy: "test" });

  // Contract projection is gated out by default …
  expect(metadata.contractsProjection).toBeUndefined();
  // … but workflows remain (unconditional, rootHash-backing).
  expect(metadata.workflows).toHaveLength(1);
});

