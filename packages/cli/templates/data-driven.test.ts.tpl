/**
 * Data-driven API tests — generate many tests from external data files.
 *
 * Three patterns are shown:
 *
 * 1. JSON import (native) — simplest, no SDK helper needed
 * 2. CSV loader — use fromCsv() for spreadsheet-style data
 * 3. YAML loader — use fromYaml() for human-friendly data
 *
 * Each row in the data file becomes an independent test case.
 * Use filter and tagFields for runtime control.
 *
 * Run: glubean run data-driven.test.ts
 */
import { fromCsv, fromYaml, test } from "@glubean/sdk";

// Import JSON data natively (recommended for JSON files)
import users from "../data/users.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Pattern 1: JSON import → test.each
// ---------------------------------------------------------------------------

/**
 * One test per user in users.json.
 * tagFields auto-generates "role:admin", "role:user" etc. for filtering.
 *
 * Run only admin tests:  glubean run data-driven.test.ts --tag role:admin
 */
export const userTests = test.each(users)(
  {
    id: "get-user-$id",
    name: "GET /users/$id → $expected",
    tags: "smoke",
    tagFields: "role",
  },
  async (ctx, { id, expected }) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const res = await ctx.http.get(`${baseUrl}/users/${id}`);

    // Fluent assertion — guard status before parsing body
    ctx.expect(res.status).toBe(expected).orFail();

    if (expected === 200) {
      const data = await res.json();

      // Soft assertions — all run even if one fails
      ctx.expect(data.id).toBe(id);
      ctx.expect(data).toHaveProperty("firstName");
      ctx.expect(data).toHaveProperty("email");

      ctx.log(`User: ${data.firstName} ${data.lastName} (${data.email})`);
    }
  },
);

// ---------------------------------------------------------------------------
// Pattern 2: CSV loader → test.each
// ---------------------------------------------------------------------------

/**
 * One test per row in endpoints.csv.
 * CSV values are always strings — cast as needed.
 */
export const endpointTests = test.each(
  await fromCsv("./data/endpoints.csv"),
)(
  {
    id: "endpoint-$method-$path",
    name: "$method $path → $expected",
    tags: ["smoke", "endpoints"],
  },
  async (ctx, { method, path, expected }) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const res = await ctx.http.get(`${baseUrl}${path}`);

    ctx.assert(
      res.status === Number(expected),
      `${method} ${path} should return ${expected}`,
      { actual: res.status, expected: Number(expected) },
    );
  },
);

// ---------------------------------------------------------------------------
// Pattern 3: YAML loader → test.each (builder mode)
// ---------------------------------------------------------------------------

/**
 * Multi-step test per scenario in scenarios.yaml.
 * Builder mode gives you setup/steps/teardown with full metadata.
 */
export const scenarioTests = test.each(
  await fromYaml("./data/scenarios.yaml"),
)(
  {
    id: "scenario-$id",
    name: "$description",
    tags: "scenario",
    filter: (row) => !!row.path && !!row.expected,
  },
)
  .step("send request", async (ctx, _state, row) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const res = await ctx.http.get(`${baseUrl}${row.path}`);

    ctx.assert(
      res.status === row.expected,
      `${row.method} ${row.path} should return ${row.expected}`,
      { actual: res.status, expected: row.expected },
    );

    return { status: res.status };
  })
  // deno-lint-ignore require-await
  .step("log result", async (ctx, state, row) => {
    ctx.log(`${row.method} ${row.path} → ${state.status}`);
  });
