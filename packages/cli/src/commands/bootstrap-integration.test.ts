/**
 * Integration test for PM-1 D2 hard constraint:
 * "scan-only without run" must surface plugin-registered protocol contracts.
 *
 * The bootstrap contract says: every entry point that reads plugin state must
 * call `bootstrap(projectRoot)` before its own work. Scanner dynamically
 * imports `.contract.ts` files, and those files may use `contract.graphql(...)`
 * / `contract.grpc(...)` which fail-closed at `getAdapter(protocol)` if the
 * adapter isn't registered.
 *
 * This test proves the happy path end-to-end:
 *   1. Write a fixture project with `glubean.setup.ts` installing graphqlPlugin
 *   2. Write a `.contract.ts` using `contract.graphql.with(...)`
 *   3. Run the same sequence the CLI `contracts` command runs:
 *      `bootstrap(dir)` → `extractContractsFromProject(dir)`
 *   4. Assert the graphql contract is visible in the result
 *
 * Failure of this test means a regression in D2 — scan-only would silently
 * drop non-HTTP contracts.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootstrap } from "@glubean/runner";
import { extractContractsFromProject } from "@glubean/scanner";
import { __resetInstalledPluginsForTesting } from "@glubean/sdk/internal";

// Fixture root lives INSIDE the CLI package tree so the test projects inherit
// the workspace's node_modules resolution (pnpm hoists @glubean/* here via
// the workspace). Tmpdir outside the package would fail to resolve
// @glubean/sdk / @glubean/graphql from the fixture's glubean.setup.ts.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "..", ".tmp-bootstrap-integration");
let fixtureSeq = 0;
let fixtureDir: string;

beforeEach(async () => {
  fixtureSeq += 1;
  fixtureDir = join(FIXTURE_ROOT, String(fixtureSeq));
  await mkdir(fixtureDir, { recursive: true });
  // Reset plugin-install tracking maps so each test sees a clean slate.
  // Prototype-level registrations persist across tests (irreversible) — matcher
  // names used here are already registered and idempotent against re-install.
  __resetInstalledPluginsForTesting();
});

afterEach(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

describe("PM-1 D2 — scan-only path discovers graphql protocol contracts", () => {
  test("bootstrap + extractContractsFromProject surfaces graphql contracts", async () => {
    // glubean.setup.ts — tells bootstrap to install the graphql manifest.
    await writeFile(
      join(fixtureDir, "glubean.setup.ts"),
      `
import { installPlugin } from "@glubean/sdk";
import graphqlPlugin from "@glubean/graphql";
await installPlugin(graphqlPlugin);
`,
    );

    // A contract file using contract.graphql (not contract.http). If bootstrap
    // doesn't run, dynamic import fails at contract.graphql access time.
    const contractsDir = join(fixtureDir, "contracts");
    await mkdir(contractsDir, { recursive: true });
    await writeFile(
      join(contractsDir, "users.contract.ts"),
      `
import { contract } from "@glubean/sdk";

const gql = contract.graphql.with("userApi", {
  endpoint: "https://api.example.com/graphql",
});

export const getUser = gql("get-user", {
  cases: {
    ok: {
      description: "Fetch a user by id",
      query: \`query GetUser($id: ID!) { user(id: $id) { id name } }\`,
      variables: { id: "1" },
      expect: { data: { user: { id: "1", name: "Alice" } } },
    },
  },
});
`,
    );

    // Run the CLI contracts command's underlying sequence.
    await bootstrap(fixtureDir);
    const result = await extractContractsFromProject(fixtureDir);

    // No import errors.
    expect(result.errors).toEqual([]);

    // graphql contract visible in results.
    expect(result.contracts.length).toBe(1);
    const contract = result.contracts[0];
    expect(contract.protocol).toBe("graphql");
    // Cases extracted.
    expect(contract.cases.length).toBe(1);
    expect(contract.cases[0].key).toBe("ok");
  });

});

// NOTES on what this test deliberately does NOT cover:
//
// 1. "Without bootstrap, dispatcher missing" — un-testable in-process.
//    `contract.register()` and `Expectation.extend()` mutate the contract
//    registry / Expectation.prototype irreversibly. Once any test in the
//    suite installs the graphql manifest, `contract.graphql` stays
//    registered for the rest of the process. The negative case would
//    need a fresh subprocess — overkill for this layer.
//
// 2. Bootstrap idempotency — covered by `packages/runner/src/bootstrap.test.ts`
//    (see "subsequent bootstrap() re-throws the remembered setup error" and
//    the counter-file idempotency test). This file tests the cross-package
//    integration point, not bootstrap's own semantics.
//
// The happy-path test above, plus the explicit `result.errors` check, is the
// strongest D2 guarantee achievable at this layer.
