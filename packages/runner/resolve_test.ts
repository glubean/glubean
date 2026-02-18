/**
 * Contract tests for resolve.ts — verifies that resolveModuleTests() correctly
 * discovers all SDK export shapes.
 *
 * These tests import the all-shapes.test.ts fixture and assert the expected
 * set of ResolvedTest records. The same fixture can later be reused by scanner
 * and MCP tests for cross-package semantic consistency.
 */
import { assertEquals, assertExists } from "@std/assert";
import {
  findTestByExport,
  findTestById,
  resolveModuleTests,
} from "./resolve.ts";

// Import the fixture module that contains every test shape
const mod = await import("./testdata/all-shapes.test.ts") as Record<
  string,
  unknown
>;

// ---------------------------------------------------------------------------
// resolveModuleTests — enumeration
// ---------------------------------------------------------------------------

Deno.test("resolveModuleTests — discovers all expected test IDs", () => {
  const tests = resolveModuleTests(mod);
  const ids = tests.map((t) => t.id).sort();

  // test.pick selects one example at random, so the ID is non-deterministic
  const pickTest = tests.find((t) => t.exportName === "pick");
  assertExists(pickTest, "pick export should be discovered");
  const pickId = pickTest.id;

  // Build the expected set: all deterministic IDs + the actual pick ID
  const expected = [
    "default-test",
    "flow",
    "flow2",
    "health",
    "item-1",
    "item-2",
    "item2-1",
    "item2-2",
    "list-users",
    "only-builder-flow",
    "only-me",
    pickId,
    "skip-builder-flow",
    "skip-me",
  ].sort();

  assertEquals(ids, expected);
});

Deno.test("resolveModuleTests — simple test (id === exportName)", () => {
  const tests = resolveModuleTests(mod);
  const health = tests.find((t) => t.exportName === "health");
  assertExists(health);
  assertEquals(health.id, "health");
  assertEquals(health.type, "simple");
});

Deno.test("resolveModuleTests — simple test (id !== exportName)", () => {
  const tests = resolveModuleTests(mod);
  const lu = tests.find((t) => t.exportName === "listUsers");
  assertExists(lu);
  assertEquals(lu.id, "list-users");
  assertEquals(lu.name, "List Users");
  assertEquals(lu.type, "simple");
});

Deno.test("resolveModuleTests — un-built builder", () => {
  const tests = resolveModuleTests(mod);
  const flow = tests.find((t) => t.id === "flow");
  assertExists(flow);
  assertEquals(flow.exportName, "flow");
  assertEquals(flow.type, "steps");
});

Deno.test("resolveModuleTests — built builder", () => {
  const tests = resolveModuleTests(mod);
  const flow2 = tests.find((t) => t.id === "flow2");
  assertExists(flow2);
  assertEquals(flow2.exportName, "flow2");
  assertEquals(flow2.type, "steps");
});

Deno.test("resolveModuleTests — test.each simple mode", () => {
  const tests = resolveModuleTests(mod);
  const eachTests = tests.filter((t) => t.exportName === "items");
  assertEquals(eachTests.length, 2);

  const ids = eachTests.map((t) => t.id).sort();
  assertEquals(ids, ["item-1", "item-2"]);
});

Deno.test("resolveModuleTests — test.each builder mode (EachBuilder)", () => {
  const tests = resolveModuleTests(mod);
  const eachTests = tests.filter((t) => t.exportName === "items2");
  assertEquals(eachTests.length, 2);

  const ids = eachTests.map((t) => t.id).sort();
  assertEquals(ids, ["item2-1", "item2-2"]);

  // EachBuilder produces step-based tests
  for (const t of eachTests) {
    assertEquals(t.type, "steps");
  }
});

Deno.test("resolveModuleTests — test.pick", () => {
  const tests = resolveModuleTests(mod);
  const pickTests = tests.filter((t) => t.exportName === "pick");
  // test.pick selects one example at a time
  assertEquals(pickTests.length, 1);

  const pick = pickTests[0];
  // The ID should match one of the example keys
  const validIds = ["p-normal", "p-edge"];
  assertEquals(
    validIds.includes(pick.id),
    true,
    `pick ID "${pick.id}" should be one of ${validIds.join(", ")}`,
  );
});

Deno.test("resolveModuleTests — only flag", () => {
  const tests = resolveModuleTests(mod);
  const only = tests.find((t) => t.id === "only-me");
  assertExists(only);
  assertEquals(only.only, true);
  assertEquals(only.exportName, "onlyTest");
});

Deno.test("resolveModuleTests — skip flag", () => {
  const tests = resolveModuleTests(mod);
  const skip = tests.find((t) => t.id === "skip-me");
  assertExists(skip);
  assertEquals(skip.skip, true);
  assertEquals(skip.exportName, "skipTest");
});

Deno.test("resolveModuleTests — default export", () => {
  const tests = resolveModuleTests(mod);
  const def = tests.find((t) => t.id === "default-test");
  assertExists(def);
  assertEquals(def.exportName, "default");
  assertEquals(def.name, "Default Export");
  assertEquals(def.type, "simple");
});

Deno.test("resolveModuleTests — tags are extracted", () => {
  const tests = resolveModuleTests(mod);
  const flow = tests.find((t) => t.id === "flow");
  assertExists(flow);
  assertEquals(flow.tags, ["builder"]);
});

// ---------------------------------------------------------------------------
// findTestById — lookup by meta.id
// ---------------------------------------------------------------------------

Deno.test("findTestById — finds simple test by meta.id", () => {
  const t = findTestById(mod, "list-users");
  assertExists(t);
  assertEquals(t.meta.id, "list-users");
});

Deno.test("findTestById — finds test.each row by meta.id", () => {
  const t = findTestById(mod, "item-1");
  assertExists(t);
  assertEquals(t.meta.id, "item-1");
});

Deno.test("findTestById — finds builder test by meta.id", () => {
  const t = findTestById(mod, "flow");
  assertExists(t);
  assertEquals(t.meta.id, "flow");
  assertEquals(t.type, "steps");
});

Deno.test("findTestById — returns undefined for non-existent id", () => {
  const t = findTestById(mod, "does-not-exist");
  assertEquals(t, undefined);
});

// ---------------------------------------------------------------------------
// findTestByExport — lookup by export name
// ---------------------------------------------------------------------------

Deno.test("findTestByExport — finds test by export name", () => {
  const t = findTestByExport(mod, "listUsers");
  assertExists(t);
  assertEquals(t.meta.id, "list-users");
});

Deno.test("findTestByExport — finds test.each first item by export name", () => {
  const t = findTestByExport(mod, "items");
  assertExists(t);
  // Should return the first test in the array
  assertEquals(t.meta.id, "item-1");
});

Deno.test("findTestByExport — returns undefined for non-existent export", () => {
  const t = findTestByExport(mod, "doesNotExist");
  assertEquals(t, undefined);
});
