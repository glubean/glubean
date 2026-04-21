/**
 * Integration test for the `glubean_openapi` MCP tool path.
 *
 * Closes the Phase 2 round-1 test gap: the handler at
 * `src/index.ts:1923` was missing a `bootstrap()` call. Reviewer flagged
 * that a project mixing HTTP + graphql in a single `.contract.ts` file
 * would silently drop HTTP endpoints when OpenAPI was generated without
 * bootstrap, because the graphql usage in the file would throw at import
 * time and take the whole file's exports down with it.
 *
 * This test exercises the **full MCP openapi pipeline** with a
 * mixed-protocol fixture:
 *
 *     bootstrap(dir)
 *        → extractContractsFromProject(dir)
 *        → contractsToOpenApi(contracts)
 *
 * and asserts:
 *   - graphql file import does NOT error (bootstrap made adapter available)
 *   - HTTP endpoints from the mixed file land in the OpenAPI paths map
 *   - OpenAPI spec is well-formed (has `openapi`, `info`, `paths`)
 *
 * The negative case ("without bootstrap, HTTP endpoints are dropped") is
 * not testable in-process — `contract.register` and `Expectation.extend`
 * are irreversible. Once any prior test installs graphql, the dispatcher
 * stays on the contract namespace for the remainder of the process. The
 * positive path + `result.errors` empty check is the strongest guarantee
 * achievable here; the real negative would need a fresh subprocess.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { bootstrap } from "@glubean/runner";
import { extractContractsFromProject } from "@glubean/scanner";
import { __resetInstalledPluginsForTesting } from "@glubean/sdk/internal";
import { contractsToOpenApi } from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", ".tmp-openapi-integration");
let fixtureSeq = 0;
let fixtureDir: string;

beforeEach(async () => {
  fixtureSeq += 1;
  fixtureDir = join(FIXTURE_ROOT, String(fixtureSeq));
  await mkdir(fixtureDir, { recursive: true });
  __resetInstalledPluginsForTesting();
});

afterEach(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
});

describe("PM-1 Phase 2 round 1 — glubean_openapi pipeline with mixed-protocol contracts", () => {
  test("mixed HTTP + graphql in one file still emits HTTP endpoints in OpenAPI", async () => {
    // glubean.setup.ts — installs the graphql plugin so its adapter exists on
    // the contract namespace by the time the .contract.ts file is imported.
    await writeFile(
      join(fixtureDir, "glubean.setup.ts"),
      `
import { installPlugin } from "@glubean/sdk";
import graphqlPlugin from "@glubean/graphql";
await installPlugin(graphqlPlugin);
`,
    );

    // Mixed-protocol contract file. Without bootstrap, the graphql call
    // throws at import time (contract.graphql is undefined) which would
    // tear down the entire module, losing the HTTP contract as collateral
    // damage. This is exactly the scenario Phase 2 round-1 P1 fixed.
    const contractsDir = join(fixtureDir, "contracts");
    await mkdir(contractsDir, { recursive: true });
    await writeFile(
      join(contractsDir, "users.contract.ts"),
      `
import { contract } from "@glubean/sdk";

// HTTP contract — should always land in OpenAPI paths.
const httpApi = contract.http.with("userHttp", {
  baseUrl: "https://api.example.com",
});

export const getUserHttp = httpApi("get-user-http", {
  endpoint: "GET /users/:id",
  feature: "users",
  cases: {
    ok: {
      description: "Fetch user by id over HTTP",
      params: { id: "1" },
      expect: { status: 200 },
    },
  },
});

// GraphQL contract in the SAME file — if bootstrap is missing, this line
// throws at import time and takes the file's HTTP exports down with it.
const gqlApi = contract.graphql.with("userGql", {
  endpoint: "https://api.example.com/graphql",
});

export const getUserGql = gqlApi("get-user-gql", {
  cases: {
    ok: {
      description: "Fetch user by id over GraphQL",
      query: \`query GetUser($id: ID!) { user(id: $id) { id name } }\`,
      variables: { id: "1" },
      expect: { data: { user: { id: "1", name: "Alice" } } },
    },
  },
});
`,
    );

    // Full pipeline: exactly what glubean_openapi handler runs now.
    await bootstrap(fixtureDir);
    const result = await extractContractsFromProject(fixtureDir);

    // Bootstrap effect #1: no import error for the mixed file.
    expect(result.errors).toEqual([]);
    // Both contracts extracted — graphql AND http.
    expect(result.contracts.length).toBe(2);
    const protocols = new Set(result.contracts.map((c) => c.protocol));
    expect(protocols).toEqual(new Set(["http", "graphql"]));

    // Bootstrap effect #2: OpenAPI spec has the HTTP endpoint. If graphql
    // import had torn down the file, HTTP would be missing here too.
    const spec = contractsToOpenApi(result.contracts, "Mixed-Protocol API");
    expect(spec).toMatchObject({
      openapi: expect.any(String),
      info: expect.objectContaining({ title: "Mixed-Protocol API" }),
      paths: expect.any(Object),
    });

    const paths = spec.paths as Record<string, Record<string, unknown>>;
    // OpenAPI converts `:id` to `{id}`.
    expect(paths).toHaveProperty("/users/{id}");
    expect(paths["/users/{id}"]).toHaveProperty("get");
  });
});
