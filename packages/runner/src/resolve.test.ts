/**
 * Contract tests for resolve.ts — verifies that resolveModuleTests() correctly
 * discovers all SDK export shapes.
 *
 * These tests import the all-shapes.test.ts fixture and assert the expected
 * set of ResolvedTest records.
 */
import { test, expect } from "vitest";
import { findTestByExport, findTestById, resolveModuleTests } from "./resolve.js";

// Import the fixture module that contains every test shape
const mod = await import("../testdata/all-shapes.test.js") as Record<
  string,
  unknown
>;

// ---------------------------------------------------------------------------
// resolveModuleTests — enumeration
// ---------------------------------------------------------------------------

test("resolveModuleTests — discovers all expected test IDs", () => {
  const tests = resolveModuleTests(mod);
  const ids = tests.map((t) => t.id).sort();

  // test.pick selects one example at random, so the ID is non-deterministic
  const pickTest = tests.find((t) => t.exportName === "pick");
  expect(pickTest).toBeDefined();
  const pickId = pickTest!.id;

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
    "signup-flow",
    "skip-builder-flow",
    "skip-me",
  ].sort();

  expect(ids).toEqual(expected);
});

test("resolveModuleTests — un-built FlowBuilder is auto-resolved via .build()", () => {
  const tests = resolveModuleTests(mod);
  const signup = tests.find((t) => t.exportName === "signupFlow");
  expect(signup).toBeDefined();
  expect(signup!.id).toBe("signup-flow");
  // FlowContract build() returns a [Test] array — the single orchestrator
  // Test has type "simple" and runFlow is invoked inside its fn.
  expect(signup!.type).toBe("simple");
});

test("resolveModuleTests — simple test (id === exportName)", () => {
  const tests = resolveModuleTests(mod);
  const health = tests.find((t) => t.exportName === "health");
  expect(health).toBeDefined();
  expect(health!.id).toBe("health");
  expect(health!.type).toBe("simple");
});

test("resolveModuleTests — simple test (id !== exportName)", () => {
  const tests = resolveModuleTests(mod);
  const lu = tests.find((t) => t.exportName === "listUsers");
  expect(lu).toBeDefined();
  expect(lu!.id).toBe("list-users");
  expect(lu!.name).toBe("List Users");
  expect(lu!.type).toBe("simple");
});

test("resolveModuleTests — un-built builder", () => {
  const tests = resolveModuleTests(mod);
  const flow = tests.find((t) => t.id === "flow");
  expect(flow).toBeDefined();
  expect(flow!.exportName).toBe("flow");
  expect(flow!.type).toBe("steps");
});

test("resolveModuleTests — built builder", () => {
  const tests = resolveModuleTests(mod);
  const flow2 = tests.find((t) => t.id === "flow2");
  expect(flow2).toBeDefined();
  expect(flow2!.exportName).toBe("flow2");
  expect(flow2!.type).toBe("steps");
});

test("resolveModuleTests — test.each simple mode", () => {
  const tests = resolveModuleTests(mod);
  const eachTests = tests.filter((t) => t.exportName === "items");
  expect(eachTests.length).toBe(2);

  const ids = eachTests.map((t) => t.id).sort();
  expect(ids).toEqual(["item-1", "item-2"]);
});

test("resolveModuleTests — test.each builder mode (EachBuilder)", () => {
  const tests = resolveModuleTests(mod);
  const eachTests = tests.filter((t) => t.exportName === "items2");
  expect(eachTests.length).toBe(2);

  const ids = eachTests.map((t) => t.id).sort();
  expect(ids).toEqual(["item2-1", "item2-2"]);

  for (const t of eachTests) {
    expect(t.type).toBe("steps");
  }
});

test("resolveModuleTests — test.pick", () => {
  const tests = resolveModuleTests(mod);
  const pickTests = tests.filter((t) => t.exportName === "pick");
  expect(pickTests.length).toBe(1);

  const pick = pickTests[0];
  const validIds = ["p-normal", "p-edge"];
  expect(validIds.includes(pick.id)).toBe(true);
});

test("resolveModuleTests — only flag", () => {
  const tests = resolveModuleTests(mod);
  const only = tests.find((t) => t.id === "only-me");
  expect(only).toBeDefined();
  expect(only!.only).toBe(true);
  expect(only!.exportName).toBe("onlyTest");
});

test("resolveModuleTests — skip flag", () => {
  const tests = resolveModuleTests(mod);
  const skip = tests.find((t) => t.id === "skip-me");
  expect(skip).toBeDefined();
  expect(skip!.skip).toBe(true);
  expect(skip!.exportName).toBe("skipTest");
});

test("resolveModuleTests — default export", () => {
  const tests = resolveModuleTests(mod);
  const def = tests.find((t) => t.id === "default-test");
  expect(def).toBeDefined();
  expect(def!.exportName).toBe("default");
  expect(def!.name).toBe("Default Export");
  expect(def!.type).toBe("simple");
});

test("resolveModuleTests — tags are extracted", () => {
  const tests = resolveModuleTests(mod);
  const flow = tests.find((t) => t.id === "flow");
  expect(flow).toBeDefined();
  expect(flow!.tags).toEqual(["builder"]);
});

// ---------------------------------------------------------------------------
// findTestById — lookup by meta.id
// ---------------------------------------------------------------------------

test("findTestById — finds simple test by meta.id", () => {
  const t = findTestById(mod, "list-users");
  expect(t).toBeDefined();
  expect(t!.meta.id).toBe("list-users");
});

test("findTestById — finds test.each row by meta.id", () => {
  const t = findTestById(mod, "item-1");
  expect(t).toBeDefined();
  expect(t!.meta.id).toBe("item-1");
});

test("findTestById — finds builder test by meta.id", () => {
  const t = findTestById(mod, "flow");
  expect(t).toBeDefined();
  expect(t!.meta.id).toBe("flow");
  expect(t!.type).toBe("steps");
});

test("findTestById — returns undefined for non-existent id", () => {
  const t = findTestById(mod, "does-not-exist");
  expect(t).toBeUndefined();
});

// ---------------------------------------------------------------------------
// findTestByExport — lookup by export name
// ---------------------------------------------------------------------------

test("findTestByExport — finds test by export name", () => {
  const t = findTestByExport(mod, "listUsers");
  expect(t).toBeDefined();
  expect(t!.meta.id).toBe("list-users");
});

test("findTestByExport — finds test.each first item by export name", () => {
  const t = findTestByExport(mod, "items");
  expect(t).toBeDefined();
  expect(t!.meta.id).toBe("item-1");
});

test("findTestByExport — returns undefined for non-existent export", () => {
  const t = findTestByExport(mod, "doesNotExist");
  expect(t).toBeUndefined();
});
