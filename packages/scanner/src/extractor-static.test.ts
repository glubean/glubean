import { test, expect } from "vitest";
import { extractAliasesFromSource, extractFromSource, extractPickExamples, isGlubeanFile } from "./extractor-static.js";

// =============================================================================
// Empty / no-export cases
// =============================================================================

test("extractFromSource returns empty array for empty content", () => {
  expect(extractFromSource("")).toEqual([]);
});

test("extractFromSource returns empty array when no test exports exist", () => {
  const content = `
import { something } from "some-lib";

export const helper = () => "not a test";
const internal = test("hidden", async () => {});
`;
  expect(extractFromSource(content)).toEqual([]);
});

// =============================================================================
// Simple test — string ID
// =============================================================================

test("extracts simple test with string ID", () => {
  const content = `
import { test } from "@glubean/sdk";

export const healthCheck = test("health-check", async (ctx) => {
  const res = await ctx.http.get(ctx.vars.require("BASE_URL"));
  ctx.assert(res.ok, "Should be healthy");
});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].type).toBe("test");
  expect(result[0].id).toBe("health-check");
  expect(result[0].exportName).toBe("healthCheck");
  expect(result[0].name).toBeUndefined();
  expect(result[0].tags).toBeUndefined();
  expect(result[0].steps).toBeUndefined();
});

// =============================================================================
// Simple test — TestMeta object
// =============================================================================

test("extracts simple test with TestMeta object (id, name, tags array)", () => {
  const content = `
import { test } from "@glubean/sdk";

export const listProducts = test(
  { id: "list-products", name: "List Products", tags: ["smoke", "api"] },
  async (ctx) => {
    ctx.log("hello");
  }
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("list-products");
  expect(result[0].name).toBe("List Products");
  expect(result[0].tags).toEqual(["smoke", "api"]);
  expect(result[0].exportName).toBe("listProducts");
});

test("extracts simple test with TestMeta object (tags as single string)", () => {
  const content = `
export const myTest = test(
  { id: "my-test", tags: "smoke" },
  async (ctx) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("my-test");
  expect(result[0].tags).toEqual(["smoke"]);
});

test("extracts simple test timeout from TestMeta object", () => {
  const content = `
export const withTimeout = test(
  { id: "timeout-meta", timeout: 1200 },
  async (ctx) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("timeout-meta");
  expect(result[0].timeout).toBe(1200);
});

// =============================================================================
// Builder pattern — string ID + .meta() + .step()
// =============================================================================

test("extracts builder test with string ID and step chain", () => {
  const content = `
import { test } from "@glubean/sdk";

export const authFlow = test("auth-flow")
  .meta({ name: "Authentication Flow", tags: ["auth"] })
  .step("login", async (ctx) => {
    return { token: "abc" };
  })
  .step("get profile", async (ctx, state) => {
    ctx.log(state.token);
  });
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("auth-flow");
  expect(result[0].name).toBe("Authentication Flow");
  expect(result[0].tags).toEqual(["auth"]);
  expect(result[0].steps).toEqual([{ name: "login" }, { name: "get profile" }]);
});

test("extracts builder timeout from .meta()", () => {
  const content = `
export const timedFlow = test("timed-flow")
  .meta({ timeout: 900, tags: ["auth"] })
  .step("login", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("timed-flow");
  expect(result[0].timeout).toBe(900);
});

test("extracts builder test without .meta() — steps only", () => {
  const content = `
export const flow = test("my-flow")
  .step("step one", async (ctx) => {})
  .step("step two", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("my-flow");
  expect(result[0].name).toBeUndefined();
  expect(result[0].tags).toBeUndefined();
  expect(result[0].steps).toEqual([{ name: "step one" }, { name: "step two" }]);
});

// =============================================================================
// test.each() — data-driven
// =============================================================================

test("extracts test.each() with string ID template", () => {
  const content = `
import { test } from "@glubean/sdk";
import users from "./data/users.json" with { type: "json" };

export const userTests = test.each(users)(
  "get-user-$id",
  async (ctx, { id, expected }) => {
    ctx.assert(true, "ok");
  }
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("get-user-$id");
  expect(result[0].exportName).toBe("userTests");
});

test("extracts test.each() with TestMeta object", () => {
  const content = `
export const endpoints = test.each(data)(
  {
    id: "endpoint-$method-$path",
    name: "$method $path",
    tags: ["smoke", "endpoints"],
  },
  async (ctx, row) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("endpoint-$method-$path");
  expect(result[0].name).toBe("$method $path");
  expect(result[0].tags).toEqual(["smoke", "endpoints"]);
});

test("extracts test.each() builder mode with steps", () => {
  const content = `
export const scenarioTests = test
  .each(await fromYaml("./data/scenarios.yaml"))({
    id: "scenario-$id",
    name: "$description",
    tags: "scenario",
  })
  .step("send request", async (ctx, _state, row) => {
    return { status: 200 };
  })
  .step("log result", async (ctx, state, row) => {
    ctx.log("done");
  });
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("scenario-$id");
  expect(result[0].name).toBe("$description");
  expect(result[0].tags).toEqual(["scenario"]);
  expect(result[0].steps).toEqual([{ name: "send request" }, { name: "log result" }]);
});

test("extracts test.each() with parallel option", () => {
  const content = `
import { test, fromCsv } from "@glubean/sdk";

export const statusTests = test.each(await fromCsv("./data.csv"), { parallel: true })(
  "status-$id",
  async (ctx, row) => {
    ctx.assert(true, "ok");
  }
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("status-$id");
  expect(result[0].parallel).toBe(true);
});

test("test.each() without parallel option has no parallel field", () => {
  const content = `
export const tests = test.each(data)(
  "case-$id",
  async (ctx, row) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].parallel).toBeUndefined();
});

// =============================================================================
// test.pick() — example selection
// =============================================================================

test("extracts test.pick() with string ID template", () => {
  const content = `
export const searchProducts = test.pick({
  "by-name": { q: "phone" },
  "by-category": { q: "laptops" },
})(
  "search-products-$_pick",
  async (ctx, data) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("search-products-$_pick");
  expect(result[0].exportName).toBe("searchProducts");
});

test("extracts test.pick() with TestMeta object", () => {
  const content = `
export const createUser = test.pick(examples)({
  id: "create-user-$_pick",
  tags: ["smoke"],
}, async (ctx, data) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("create-user-$_pick");
  expect(result[0].tags).toEqual(["smoke"]);
});

// =============================================================================
// Multiple exports in one file
// =============================================================================

test("extracts multiple exports from a single file", () => {
  const content = `
import { test } from "@glubean/sdk";

export const first = test("first-test", async (ctx) => {});

export const second = test(
  { id: "second-test", name: "Second", tags: ["smoke"] },
  async (ctx) => {}
);

export const third = test("third-test")
  .step("only step", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(3);
  expect(result[0].id).toBe("first-test");
  expect(result[0].exportName).toBe("first");
  expect(result[1].id).toBe("second-test");
  expect(result[1].name).toBe("Second");
  expect(result[2].id).toBe("third-test");
  expect(result[2].steps).toEqual([{ name: "only step" }]);
});

// =============================================================================
// Comment handling
// =============================================================================

test("ignores test() calls inside block comments", () => {
  const content = `
/*
export const commented = test("should-not-appear", async (ctx) => {});
*/

export const real = test("real-test", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("real-test");
});

test("ignores test() calls inside line comments", () => {
  const content = `
// export const commented = test("should-not-appear", async (ctx) => {});

export const real = test("real-test", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("real-test");
});

// =============================================================================
// Location tracking
// =============================================================================

test("reports correct line numbers", () => {
  const content = `import { test } from "@glubean/sdk";

export const a = test("alpha", async () => {});

export const b = test("beta", async () => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(2);
  expect(result[0].location?.line).toBe(3);
  expect(result[1].location?.line).toBe(5);
});

// =============================================================================
// Edge cases
// =============================================================================

test("handles single-quoted string IDs", () => {
  const content = `export const t = test('single-quoted', async () => {});`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("single-quoted");
});

test("handles single-quoted TestMeta object (id, tags)", () => {
  const content = `export const t = test({ id: 'x', tags: ['a'] }, async ()=>{});`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("x");
  expect(result[0].tags).toEqual(["a"]);
});

test("handles single-quoted TestMeta with name and multiple tags", () => {
  const content = `
export const t = test(
  { id: 'my-test', name: 'My Test', tags: ['smoke', 'api'] },
  async (ctx) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("my-test");
  expect(result[0].name).toBe("My Test");
  expect(result[0].tags).toEqual(["smoke", "api"]);
});

test("handles single-quoted tags in builder .meta()", () => {
  const content = `
export const flow = test('my-flow')
  .meta({ name: 'My Flow', tags: ['auth'] })
  .step('login', async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("my-flow");
  expect(result[0].name).toBe("My Flow");
  expect(result[0].tags).toEqual(["auth"]);
  expect(result[0].steps).toEqual([{ name: "login" }]);
});

test("non-exported test() calls are not extracted", () => {
  const content = `
const internal = test("internal-only", async (ctx) => {});
`;
  expect(extractFromSource(content)).toEqual([]);
});

test("test.pick with imported JSON examples", () => {
  const content = `
import examples from "../data/examples.json" with { type: "json" };

export const createUser = test.pick(examples)(
  "create-user-$_pick",
  async (ctx, { body }) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("create-user-$_pick");
});

test("test.each with nested function calls in data arg", () => {
  const content = `
export const csvTests = test.each(await fromCsv("./data/endpoints.csv"))(
  {
    id: "csv-$method-$path",
    tags: ["csv"],
  },
  async (ctx, row) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("csv-$method-$path");
  expect(result[0].tags).toEqual(["csv"]);
});

// =============================================================================
// isGlubeanFile
// =============================================================================

test("isGlubeanFile detects JSR import with version", () => {
  const content = `import { test } from "jsr:@glubean/sdk@0.10.0";`;
  expect(isGlubeanFile(content)).toBe(true);
});

test("isGlubeanFile detects JSR import without version", () => {
  const content = `import { test } from "jsr:@glubean/sdk";`;
  expect(isGlubeanFile(content)).toBe(true);
});

test("isGlubeanFile detects bare specifier import", () => {
  const content = `import { test } from "@glubean/sdk";`;
  expect(isGlubeanFile(content)).toBe(true);
});

test("isGlubeanFile detects subpath import", () => {
  const content = `import { getRegistry } from "@glubean/sdk/internal";`;
  expect(isGlubeanFile(content)).toBe(true);
});

test("isGlubeanFile returns false for unrelated code", () => {
  expect(isGlubeanFile(`import { something } from "other-lib";`)).toBe(false);
  expect(isGlubeanFile(`const x = 1;`)).toBe(false);
  expect(isGlubeanFile("")).toBe(false);
});

test("isGlubeanFile returns false for non-convention imports from other packages", () => {
  expect(
    isGlubeanFile(`import { something } from "@glubean/runner";`),
  ).toBe(false);
  expect(
    isGlubeanFile(`import { utils } from "jsr:@other/sdk";`),
  ).toBe(false);
});

test("isGlubeanFile detects convention-based *Test/*Task imports from any module", () => {
  expect(
    isGlubeanFile(`import { browserTest } from "./configure.ts";`),
  ).toBe(true);
  expect(
    isGlubeanFile(`import { deployTask } from "../tasks.ts";`),
  ).toBe(true);
  expect(
    isGlubeanFile(`import { test } from "./fixtures.ts";`),
  ).toBe(true);
  expect(
    isGlubeanFile(`import { task } from "@glubean/runner";`),
  ).toBe(true);
});

test("isGlubeanFile rejects identifiers that only contain test/task substring", () => {
  expect(
    isGlubeanFile(`import { latestResult } from "./utils.ts";`),
  ).toBe(false);
  expect(
    isGlubeanFile(`import { multitask } from "./parallel.ts";`),
  ).toBe(false);
});

// =============================================================================
// variant field
// =============================================================================

test("variant is undefined for simple tests", () => {
  const content = `
export const simple = test("simple-test", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].variant).toBeUndefined();
});

test("variant is undefined for builder tests", () => {
  const content = `
export const flow = test("my-flow")
  .step("login", async (ctx) => {})
  .step("verify", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].variant).toBeUndefined();
});

test("variant is 'each' for test.each()", () => {
  const content = `
export const userTests = test.each(users)(
  "get-user-$id",
  async (ctx, { id }) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].variant).toBe("each");
});

test("variant is 'pick' for test.pick()", () => {
  const content = `
export const searchTests = test.pick({
  "by-name": { q: "phone" },
})("search-$_pick", async (ctx, data) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].variant).toBe("pick");
});

test("variant is 'each' for test.each() builder mode", () => {
  const content = `
export const scenarios = test.each(data)({
  id: "scenario-$id",
  tags: ["scenario"],
})
  .step("request", async (ctx) => {})
  .step("verify", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].variant).toBe("each");
  expect(result[0].steps).toEqual([{ name: "request" }, { name: "verify" }]);
});

test("mixed file: variant set correctly per test", () => {
  const content = `
import { test } from "@glubean/sdk";

export const health = test("health", async (ctx) => {});

export const items = test.each(data)("item-$id", async (ctx, row) => {});

export const search = test.pick(examples)("search-$_pick", async (ctx, d) => {});

export const flow = test("crud-flow").step("create", async () => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(4);
  expect(result[0].id).toBe("health");
  expect(result[0].variant).toBeUndefined();
  expect(result[1].id).toBe("item-$id");
  expect(result[1].variant).toBe("each");
  expect(result[2].id).toBe("search-$_pick");
  expect(result[2].variant).toBe("pick");
  expect(result[3].id).toBe("crud-flow");
  expect(result[3].variant).toBeUndefined();
});

// =============================================================================
// Extended function names (*Test, *Task, task)
// =============================================================================

test("extracts test from custom *Test function (test.extend)", () => {
  const content = `
import { browserTest } from "./configure.ts";

export const homepageLoads = browserTest(
  { id: "landing-homepage-loads", tags: ["smoke"] },
  async ({ page }) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("landing-homepage-loads");
  expect(result[0].tags).toEqual(["smoke"]);
  expect(result[0].exportName).toBe("homepageLoads");
});

test("extracts test from 'task' base function", () => {
  const content = `
export const deploy = task("deploy-staging", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("deploy-staging");
  expect(result[0].exportName).toBe("deploy");
});

test("extracts test from custom *Task function", () => {
  const content = `
export const deployProd = deployTask(
  { id: "deploy-prod", tags: ["deploy"] },
  async (ctx) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("deploy-prod");
  expect(result[0].tags).toEqual(["deploy"]);
  expect(result[0].exportName).toBe("deployProd");
});

test("extracts *Test builder with steps", () => {
  const content = `
export const loginFlow = browserTest("browser-login")
  .meta({ tags: ["e2e"] })
  .step("navigate", async (ctx) => {})
  .step("fill form", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("browser-login");
  expect(result[0].tags).toEqual(["e2e"]);
  expect(result[0].steps).toEqual([{ name: "navigate" }, { name: "fill form" }]);
});

test("extracts *Test.each() data-driven pattern", () => {
  const content = `
export const pageTests = browserTest.each(pages)(
  "page-$slug",
  async ({ page }, { slug }) => {}
);
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("page-$slug");
  expect(result[0].variant).toBe("each");
});

test("extracts *Test.pick() example selection pattern", () => {
  const content = `
export const searchTests = screenshotTest.pick({
  "desktop": { viewport: "1920x1080" },
  "mobile": { viewport: "390x844" },
})("screenshot-$_pick", async ({ page }, data) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(1);
  expect(result[0].id).toBe("screenshot-$_pick");
  expect(result[0].variant).toBe("pick");
});

test("does NOT match identifiers that merely contain 'test' or 'task'", () => {
  const content = `
export const latestResult = getLatest("id", async () => {});
export const multitask = parallel("id", async () => {});
export const testResult = something("id", async () => {});
export const attest = verify("id", async () => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(0);
});

test("mixed file with test, task, *Test, and *Task functions", () => {
  const content = `
export const health = test("health", async (ctx) => {});
export const deploy = task("deploy", async (ctx) => {});
export const login = browserTest("browser-login", async ({ page }) => {});
export const cleanup = cleanupTask("cleanup-db", async (ctx) => {});
`;
  const result = extractFromSource(content);
  expect(result.length).toBe(4);
  expect(result[0].id).toBe("health");
  expect(result[0].exportName).toBe("health");
  expect(result[1].id).toBe("deploy");
  expect(result[1].exportName).toBe("deploy");
  expect(result[2].id).toBe("browser-login");
  expect(result[2].exportName).toBe("login");
  expect(result[3].id).toBe("cleanup-db");
  expect(result[3].exportName).toBe("cleanup");
});

// =============================================================================
// extractAliasesFromSource
// =============================================================================

test("extractAliasesFromSource finds test.extend aliases", () => {
  const content = `
import { test } from "@glubean/sdk";
export const browserTest = test.extend({ page: pageFixture });
export const screenshotTest = test.extend({ page: screenshotFixture });
`;
  const aliases = extractAliasesFromSource(content);
  expect(aliases).toEqual(["browserTest", "screenshotTest"]);
});

test("extractAliasesFromSource finds chained extend aliases", () => {
  const content = `
const withAuth = test.extend({ auth: authFixture });
const withBoth = withAuth.extend({ db: dbFixture });
`;
  const aliases = extractAliasesFromSource(content);
  expect(aliases).toEqual(["withAuth", "withBoth"]);
});

test("extractAliasesFromSource finds non-convention names", () => {
  const content = `
export const scenario = test.extend({ browser: browserFixture });
const check = scenario.extend({ validator: validatorFixture });
`;
  const aliases = extractAliasesFromSource(content);
  expect(aliases).toEqual(["scenario", "check"]);
});

test("extractAliasesFromSource returns empty for files without extend", () => {
  const content = `
import { test } from "@glubean/sdk";
export const health = test("health", async (ctx) => {});
`;
  expect(extractAliasesFromSource(content)).toEqual([]);
});

test("extractAliasesFromSource ignores extend in comments", () => {
  const content = `
// const commented = test.extend({ page: fixture });
export const real = test.extend({ page: fixture });
`;
  const aliases = extractAliasesFromSource(content);
  expect(aliases).toEqual(["real"]);
});

// =============================================================================
// extractFromSource with explicit customFns
// =============================================================================

test("extractFromSource with customFns matches non-convention names", () => {
  const content = `
export const login = scenario("login-flow", async (ctx) => {});
export const checkout = workflow({ id: "checkout", tags: ["e2e"] }, async (ctx) => {});
`;
  // Without customFns: convention fallback doesn't match "scenario" or "workflow"
  expect(extractFromSource(content).length).toBe(0);

  // With customFns: explicit match
  const result = extractFromSource(content, ["scenario", "workflow"]);
  expect(result.length).toBe(2);
  expect(result[0].id).toBe("login-flow");
  expect(result[1].id).toBe("checkout");
});

test("extractFromSource with customFns always includes base test/task", () => {
  const content = `
export const health = test("health", async (ctx) => {});
export const login = scenario("login", async (ctx) => {});
`;
  const result = extractFromSource(content, ["scenario"]);
  expect(result.length).toBe(2);
  expect(result[0].id).toBe("health");
  expect(result[1].id).toBe("login");
});

// =============================================================================
// isGlubeanFile with explicit customFns
// =============================================================================

test("isGlubeanFile with customFns detects non-convention imports", () => {
  // "scenario" doesn't match *Test/*Task convention
  expect(
    isGlubeanFile(`import { scenario } from "./configure.ts";`),
  ).toBe(false);
  // But with customFns, it's recognized
  expect(
    isGlubeanFile(`import { scenario } from "./configure.ts";`, ["scenario"]),
  ).toBe(true);
});

// =============================================================================
// extractPickExamples
// =============================================================================

test("extractPickExamples detects inline object literal", () => {
  const content = `
export const search = test.pick({
  "by-name": { q: "phone" },
  "by-category": { q: "laptop" },
})(
  "search-$_pick",
  async (ctx, data) => {},
);`;
  const picks = extractPickExamples(content);
  expect(picks.length).toBe(1);
  expect(picks[0].testId).toBe("search-$_pick");
  expect(picks[0].keys).toEqual(["by-name", "by-category"]);
  expect(picks[0].dataSource).toEqual({ type: "inline" });
});

test("extractPickExamples detects fromDir.merge with variable", () => {
  const content = `
const examples = await fromDir.merge("./data/add-product/");

export const addProduct = test.pick(examples)(
  "add-product-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content);
  expect(picks.length).toBe(1);
  expect(picks[0].testId).toBe("add-product-$_pick");
  expect(picks[0].exportName).toBe("addProduct");
  expect(picks[0].dataSource).toEqual({
    type: "dir-merge",
    path: "./data/add-product/",
  });
  expect(picks[0].keys).toBeNull();
});

test("extractPickExamples detects JSON import", () => {
  const content = `
import examples from "../data/create-user.json" with { type: "json" };

export const createUser = test.pick(examples)(
  "create-user-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content);
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "json-import",
    path: "../data/create-user.json",
  });
});

test("extractPickExamples returns undefined dataSource for unknown variable", () => {
  const content = `
const dir = vars.require("DATA_DIR");
const examples = await fromDir.merge(dir);

export const dynTest = test.pick(examples)(
  "dyn-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content);
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toBeUndefined();
  expect(picks[0].keys).toBeNull();
});

// =============================================================================
// extractPickExamples — filePath resolution
// =============================================================================

test("extractPickExamples resolves ./data/ relative to filePath", () => {
  const content = `
const examples = await fromDir.merge("./data/products/");

export const prodTest = test.pick(examples)(
  "prod-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content, {
    filePath: "/project/tests/api/products.test.ts",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "dir-merge",
    path: "/project/tests/api/data/products/",
  });
});

test("extractPickExamples resolves bare data/ relative to projectRoot", () => {
  const content = `
const examples = await fromDir.merge("data/products/");

export const prodTest = test.pick(examples)(
  "prod-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content, {
    projectRoot: "/project",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "dir-merge",
    path: "/project/data/products/",
  });
});

test("extractPickExamples keeps ./data/ raw when only projectRoot is provided", () => {
  const content = `
const examples = await fromDir.merge("./data/products/");

export const prodTest = test.pick(examples)(
  "prod-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content, {
    projectRoot: "/project",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "dir-merge",
    path: "./data/products/",
  });
});

test("extractPickExamples resolves ../data/ relative to filePath", () => {
  const content = `
const cases = await fromDir.merge("../data/directions/");

export const directions = test.pick(cases)(
  { id: "directions-$_pick", name: "Directions: $_pick", tags: ["geo"] },
  async (ctx, { origin }) => {},
);`;
  const picks = extractPickExamples(content, {
    filePath: "/project/tests/geo/directions.test.ts",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "dir-merge",
    path: "/project/tests/data/directions/",
  });
});

test("extractPickExamples falls back to raw path when no filePath", () => {
  const content = `
const cases = await fromDir.merge("../data/directions/");

export const directions = test.pick(cases)(
  "directions-$_pick",
  async (ctx, { origin }) => {},
);`;
  // No filePath — should keep raw path
  const picks = extractPickExamples(content);
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "dir-merge",
    path: "../data/directions/",
  });
});

test("extractPickExamples keeps bare data/ raw when only filePath is provided", () => {
  const content = `
const examples = await fromDir.merge("data/products/");

export const prodTest = test.pick(examples)(
  "prod-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content, {
    filePath: "/project/tests/api/products.test.ts",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "dir-merge",
    path: "data/products/",
  });
});

test("extractPickExamples resolves JSON import path relative to filePath", () => {
  const content = `
import examples from "../data/create-user.json" with { type: "json" };

export const createUser = test.pick(examples)(
  "create-user-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content, {
    filePath: "/project/tests/users/create.test.ts",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "json-import",
    path: "/project/tests/data/create-user.json",
  });
});

test("extractPickExamples keeps absolute paths unchanged", () => {
  const content = `
const examples = await fromDir.merge("/absolute/data/products/");

export const prodTest = test.pick(examples)(
  "prod-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content, {
    filePath: "/project/tests/api/products.test.ts",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "dir-merge",
    path: "/absolute/data/products/",
  });
});

test("extractPickExamples detects fromDir (not .merge/.concat)", () => {
  const content = `
const rows = await fromDir("./cases/");

export const caseTest = test.pick(rows)(
  "case-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content, {
    filePath: "/project/tests/api/cases.test.ts",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "dir",
    path: "/project/tests/api/cases/",
  });
});

test("extractPickExamples detects fromDir.concat", () => {
  const content = `
const batches = await fromDir.concat("./batches/");

export const batchTest = test.pick(batches)(
  "batch-$_pick",
  async (ctx, body) => {},
);`;
  const picks = extractPickExamples(content, {
    filePath: "/project/tests/api/batch.test.ts",
  });
  expect(picks.length).toBe(1);
  expect(picks[0].dataSource).toEqual({
    type: "dir-concat",
    path: "/project/tests/api/batches/",
  });
});
