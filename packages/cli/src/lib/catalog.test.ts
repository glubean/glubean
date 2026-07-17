import { describe, expect, it } from "vitest";

import {
  catalogHasBlockingIssues,
  filterProjectCatalog,
  serializeCatalog,
  type ProjectCatalog,
} from "./catalog.js";

function fixture(): ProjectCatalog {
  return {
    schemaVersion: "glubean.catalog/v1",
    generatedBy: "@glubean/cli@test",
    project: { name: "catalog-test", root: "." },
    summary: {
      files: 2,
      assets: 2,
      tests: 1,
      contracts: 1,
      contractCases: 1,
      workflows: 0,
      loadPlans: 0,
      openapiPaths: 0,
      environments: 2,
      syncReadyEnvironments: 1,
      uploadReadyEnvironments: 1,
      errors: 1,
      warnings: 0,
    },
    environments: [
      {
        name: "production",
        file: ".env.production",
        exists: true,
        active: true,
        tokenPresent: true,
        projectId: "proj_prod",
        url: "https://app.example/p/proj_prod/contracts",
        cloudCheck: "verified",
        sync: { status: "ready" },
        upload: { status: "ready", targetId: "tgt_prod" },
      },
      {
        name: "staging",
        file: ".env.staging",
        exists: true,
        active: false,
        tokenPresent: false,
        cloudCheck: "not-run",
        sync: { status: "blocked", reasons: ["Missing GLUBEAN_TOKEN."] },
        upload: { status: "blocked", reasons: ["Missing GLUBEAN_TOKEN."] },
      },
    ],
    files: [
      { path: "tests/users.test.ts", type: "test", status: "ready", assets: ["list-users"] },
      { path: "contracts/users.contract.ts", type: "contract", status: "ready", assets: ["users"] },
    ],
    assets: [
      { type: "test", id: "list-users", file: "tests/users.test.ts", tags: ["smoke"], syncable: true, uploadable: true },
      {
        type: "contract",
        id: "users",
        file: "contracts/users.contract.ts",
        syncable: true,
        uploadable: true,
        cases: [{ id: "users.list", key: "list" }],
      },
    ],
    diagnostics: [
      {
        severity: "error",
        code: "sync_not_ready",
        message: "Missing GLUBEAN_TOKEN.",
        environment: "staging",
        blocksSync: true,
      },
    ],
  };
}

describe("project catalog", () => {
  it("filters assets and environments while recomputing summary counts", () => {
    const filtered = filterProjectCatalog(fixture(), ["type:test", "tag:smoke", "env:prod*"]);
    expect(filtered.assets.map((asset) => asset.id)).toEqual(["list-users"]);
    expect(filtered.files.map((file) => file.path)).toEqual(["tests/users.test.ts"]);
    expect(filtered.environments.map((env) => env.name)).toEqual(["production"]);
    expect(filtered.diagnostics).toEqual([]);
    expect(filtered.summary).toMatchObject({ assets: 1, tests: 1, contracts: 0, environments: 1, errors: 0 });
  });

  it("serializes deterministic YAML with readiness URLs but no credential value field", () => {
    const output = serializeCatalog(fixture(), "yaml");
    expect(output).toContain("schemaVersion: glubean.catalog/v1");
    expect(output).toContain("https://app.example/p/proj_prod/contracts");
    expect(output).toContain("tokenPresent: true");
    expect(output).not.toMatch(/^\s*token:/m);
    expect(output).toBe(serializeCatalog(fixture(), "yaml"));
  });

  it("reports blocking sync or upload diagnostics", () => {
    expect(catalogHasBlockingIssues(fixture())).toBe(true);
    const healthy = fixture();
    healthy.diagnostics = [];
    expect(catalogHasBlockingIssues(healthy)).toBe(false);
  });

  it("rejects unknown filter fields instead of silently broadening output", () => {
    expect(() => filterProjectCatalog(fixture(), ["owner:me"])).toThrow(/Unknown discover filter field/);
  });
});
