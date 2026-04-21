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

/**
 * Build a mixed-protocol fixture (HTTP + graphql in a single .contract.ts)
 * with a glubean.setup.ts that installs the graphql manifest. Returns nothing;
 * caller inspects `fixtureDir` directly.
 */
async function writeMixedProtocolFixture(): Promise<void> {
  await writeFile(
    join(fixtureDir, "glubean.setup.ts"),
    `
import { installPlugin } from "@glubean/sdk";
import graphqlPlugin from "@glubean/graphql";
await installPlugin(graphqlPlugin);
`,
  );

  const contractsDir = join(fixtureDir, "contracts");
  await mkdir(contractsDir, { recursive: true });
  await writeFile(
    join(contractsDir, "users.contract.ts"),
    `
import { contract } from "@glubean/sdk";

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
}

describe("PM-1 Phase 2 round 1 — glubean_openapi pipeline with mixed-protocol contracts", () => {
  test("mixed HTTP + graphql in one file still emits HTTP endpoints in OpenAPI", async () => {
    await writeMixedProtocolFixture();

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

  test("negative: without bootstrap, mixed-protocol file fails import and drops its HTTP endpoint", async () => {
    // The inverse of the positive case: prove that SKIPPING bootstrap is
    // what the missing-bootstrap regression would look like. This is the
    // guarantee we couldn't provide in earlier RFR rounds because
    // `contract.register` and `Expectation.extend` were irreversible.
    //
    // Phase 2 round-1 `__resetInstalledPluginsForTesting` now tears down
    // graphql's adapter + matchers, so `contract.graphql` is genuinely
    // undefined for this test body.
    //
    // Expected behavior:
    //   - The mixed file import throws at `contract.graphql.with(...)`
    //   - `extractContractsFromProject` surfaces the file in `result.errors`
    //   - Both HTTP and graphql contracts from that file are LOST
    //   - OpenAPI has no `/users/{id}` path
    //
    // If this test starts passing the ORIGINAL assertions (HTTP endpoint
    // still present) it means bootstrap stopped being necessary — likely
    // because someone made graphql self-register again. That would undo
    // the whole Phase 2 point and needs a review conversation.

    // beforeEach already called __resetInstalledPluginsForTesting(); at this
    // point graphql is fully un-registered.
    await writeMixedProtocolFixture();

    // Deliberately DO NOT call bootstrap(fixtureDir).
    const result = await extractContractsFromProject(fixtureDir);

    // File failed to import — error surfaces, contracts list is empty.
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].file).toContain("users.contract.ts");
    expect(result.contracts).toEqual([]);

    const spec = contractsToOpenApi(result.contracts, "No-Bootstrap API");
    const paths = spec.paths as Record<string, Record<string, unknown>>;
    // HTTP endpoint is gone — the import error took it down along with
    // the graphql contract in the same file.
    expect(paths).not.toHaveProperty("/users/{id}");
  });
});
