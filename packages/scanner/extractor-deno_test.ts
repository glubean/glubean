/**
 * Contract tests for extractWithDeno against the shared all-shapes fixture.
 *
 * These tests verify that extractWithDeno discovers all SDK export shapes
 * with correct metadata, proving it is a superset of CLI's discoverTests().
 */

import { assertEquals, assertExists } from "@std/assert";
import { extractWithDeno } from "./extractor-deno.ts";
import { resolve } from "@std/path";

const fixturePath = resolve(
  import.meta.dirname!,
  "../runner/testdata/all-shapes.test.ts",
);

let results: Awaited<ReturnType<typeof extractWithDeno>>;

// Run extraction once — all tests share the result.
async function getResults() {
  if (!results) {
    results = await extractWithDeno(fixturePath);
  }
  return results;
}

function findById(id: string) {
  return results.find((r) => r.id === id);
}

// -- Setup: extract once before assertions ------------------------------------

Deno.test({
  name: "extractWithDeno — setup: extract all-shapes fixture",
  async fn() {
    await getResults();
    // Sanity: should find at least 10 tests (10 shapes, some with multiple rows)
    assertEquals(results.length >= 10, true, `expected >=10, got ${results.length}`);
  },
});

// -- Individual shape tests ---------------------------------------------------

Deno.test("extractWithDeno — simple test (id === exportName)", async () => {
  await getResults();
  const t = findById("health");
  assertExists(t, "should discover 'health'");
  assertEquals(t.exportName, "health");
  assertEquals(t.type, "test");
});

Deno.test("extractWithDeno — simple test (id !== exportName)", async () => {
  await getResults();
  const t = findById("list-users");
  assertExists(t, "should discover 'list-users'");
  assertEquals(t.exportName, "listUsers");
  assertEquals(t.name, "List Users");
});

Deno.test("extractWithDeno — builder un-built", async () => {
  await getResults();
  const t = findById("flow");
  assertExists(t, "should discover un-built builder 'flow'");
  assertEquals(t.exportName, "flow");
});

Deno.test("extractWithDeno — builder with .build()", async () => {
  await getResults();
  const t = findById("flow2");
  assertExists(t, "should discover built builder 'flow2'");
  assertEquals(t.exportName, "flow2");
});

Deno.test("extractWithDeno — test.each simple mode expands rows", async () => {
  await getResults();
  const item1 = findById("item-1");
  const item2 = findById("item-2");
  assertExists(item1, "should discover 'item-1'");
  assertExists(item2, "should discover 'item-2'");
  assertEquals(item1.exportName, "items");
  assertEquals(item2.exportName, "items");
  assertEquals(item1.groupId, undefined, "each tests should not have groupId");
});

Deno.test("extractWithDeno — test.each builder mode expands rows", async () => {
  await getResults();
  const item1 = findById("item2-1");
  const item2 = findById("item2-2");
  assertExists(item1, "should discover 'item2-1'");
  assertExists(item2, "should discover 'item2-2'");
  assertEquals(item1.exportName, "items2");
  assertEquals(item2.exportName, "items2");
});

Deno.test("extractWithDeno — test.pick", async () => {
  await getResults();
  // test.pick selects one example at runtime; at discovery time we get
  // whichever example was selected (random or env-controlled).
  const picks = results.filter((r) => r.id.startsWith("p-"));
  assertEquals(picks.length >= 1, true, "should discover at least one test.pick test");
  assertEquals(picks[0].exportName, "pick");
  assertEquals(picks[0].groupId, "p-$_pick", "pick tests should have groupId = template ID");
});

Deno.test("extractWithDeno — only flag propagated", async () => {
  await getResults();
  const t = findById("only-me");
  assertExists(t, "should discover 'only-me'");
  assertEquals(t.only, true);
});

Deno.test("extractWithDeno — skip flag propagated", async () => {
  await getResults();
  const t = findById("skip-me");
  assertExists(t, "should discover 'skip-me'");
  assertEquals(t.skip, true);
});

Deno.test("extractWithDeno — default export", async () => {
  await getResults();
  const t = findById("default-test");
  assertExists(t, "should discover default export 'default-test'");
  assertEquals(t.exportName, "default");
  assertEquals(t.name, "Default Export");
});

Deno.test("extractWithDeno — builder un-built with only flag", async () => {
  await getResults();
  const t = findById("only-builder-flow");
  assertExists(t, "should discover un-built builder 'only-builder-flow'");
  assertEquals(t.exportName, "onlyBuilder");
  assertEquals(t.only, true);
});

Deno.test("extractWithDeno — builder un-built with skip flag", async () => {
  await getResults();
  const t = findById("skip-builder-flow");
  assertExists(t, "should discover un-built builder 'skip-builder-flow'");
  assertEquals(t.exportName, "skipBuilder");
  assertEquals(t.skip, true);
});

Deno.test("extractWithDeno — all expected IDs present", async () => {
  await getResults();
  const ids = new Set(results.map((r) => r.id));

  const expected = [
    "health",
    "list-users",
    "flow",
    "flow2",
    "item-1",
    "item-2",
    "item2-1",
    "item2-2",
    "only-me",
    "skip-me",
    "default-test",
    "only-builder-flow",
    "skip-builder-flow",
  ];

  for (const id of expected) {
    assertEquals(ids.has(id), true, `missing expected ID: ${id}`);
  }
});

Deno.test("extractWithDeno — tests without only/skip omit those fields", async () => {
  await getResults();
  const t = findById("health");
  assertExists(t);
  // skip and only should be undefined (not false) for tests that don't set them
  assertEquals(t.skip, undefined);
  assertEquals(t.only, undefined);
});

Deno.test("extractWithDeno — timeout propagated from test metadata", async () => {
  const tempDir = await Deno.makeTempDir({ dir: import.meta.dirname });
  const testFile = `${tempDir}/timeout_meta.test.ts`;

  await Deno.writeTextFile(
    testFile,
    `
import { test } from "@glubean/sdk";

export const simpleTimeout = test(
  { id: "simple-timeout", timeout: 1500 },
  async (ctx) => {},
);

export const builderTimeout = test("builder-timeout")
  .meta({ timeout: 700 })
  .step("one", async (ctx) => {});
`,
  );

  try {
    const extracted = await extractWithDeno(testFile);
    const simple = extracted.find((t) => t.id === "simple-timeout");
    const builder = extracted.find((t) => t.id === "builder-timeout");

    assertExists(simple);
    assertExists(builder);
    assertEquals(simple.timeout, 1500);
    assertEquals(builder.timeout, 700);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
