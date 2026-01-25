/**
 * Tests for the Expectation<T> fluent assertion class.
 *
 * Every test uses a mock emitter to capture assertion emissions,
 * then verifies passed/failed, actual/expected, and message.
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  type AssertionEmission,
  deepEqual,
  Expectation,
  ExpectFailError,
  inspect,
} from "./expect.ts";

// ---------------------------------------------------------------------------
// Test helper — captures emissions from an Expectation
// ---------------------------------------------------------------------------

function createExpect<T>(actual: T): {
  expect: Expectation<T>;
  emissions: AssertionEmission[];
} {
  const emissions: AssertionEmission[] = [];
  const expect = new Expectation(actual, (e) => emissions.push(e));
  return { expect, emissions };
}

function last(emissions: AssertionEmission[]): AssertionEmission {
  return emissions[emissions.length - 1];
}

// =============================================================================
// inspect() helper
// =============================================================================

Deno.test("inspect - primitives", () => {
  assertEquals(inspect(null), "null");
  assertEquals(inspect(undefined), "undefined");
  assertEquals(inspect(42), "42");
  assertEquals(inspect(true), "true");
  assertEquals(inspect("hello"), '"hello"');
});

Deno.test("inspect - truncates long strings", () => {
  const long = "a".repeat(200);
  const result = inspect(long, 64);
  // JSON.stringify wraps in quotes, so "aaa..." is > 200 chars.
  // inspect truncates to maxLen with trailing ..."
  assertEquals(result.length <= 64, true);
  assertEquals(result.endsWith('..."'), true);
});

Deno.test("inspect - objects and arrays", () => {
  assertEquals(inspect({ a: 1 }), '{"a":1}');
  assertEquals(inspect([1, 2, 3]), "[1,2,3]");
});

Deno.test("inspect - RegExp and Date", () => {
  assertEquals(inspect(/abc/gi), "/abc/gi");
  const d = new Date("2024-01-01T00:00:00Z");
  assertEquals(inspect(d), "2024-01-01T00:00:00.000Z");
});

// =============================================================================
// deepEqual() helper
// =============================================================================

Deno.test("deepEqual - primitives", () => {
  assertEquals(deepEqual(1, 1), true);
  assertEquals(deepEqual(1, 2), false);
  assertEquals(deepEqual("a", "a"), true);
  assertEquals(deepEqual(null, null), true);
  assertEquals(deepEqual(undefined, undefined), true);
  assertEquals(deepEqual(null, undefined), false);
  assertEquals(deepEqual(NaN, NaN), true);
  assertEquals(deepEqual(0, -0), false); // Object.is semantics
});

Deno.test("deepEqual - arrays", () => {
  assertEquals(deepEqual([1, 2, 3], [1, 2, 3]), true);
  assertEquals(deepEqual([1, 2], [1, 2, 3]), false);
  assertEquals(deepEqual([{ a: 1 }], [{ a: 1 }]), true);
});

Deno.test("deepEqual - objects", () => {
  assertEquals(deepEqual({ a: 1, b: 2 }, { a: 1, b: 2 }), true);
  assertEquals(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assertEquals(deepEqual({ a: { b: 1 } }, { a: { b: 1 } }), true);
});

Deno.test("deepEqual - Date", () => {
  const d1 = new Date("2024-01-01");
  const d2 = new Date("2024-01-01");
  const d3 = new Date("2024-06-15");
  assertEquals(deepEqual(d1, d2), true);
  assertEquals(deepEqual(d1, d3), false);
});

Deno.test("deepEqual - RegExp", () => {
  assertEquals(deepEqual(/abc/g, /abc/g), true);
  assertEquals(deepEqual(/abc/g, /abc/i), false);
});

Deno.test("deepEqual - Map and Set", () => {
  assertEquals(deepEqual(new Map([["a", 1]]), new Map([["a", 1]])), true);
  assertEquals(deepEqual(new Map([["a", 1]]), new Map([["a", 2]])), false);
  assertEquals(deepEqual(new Set([1, 2]), new Set([1, 2])), true);
  assertEquals(deepEqual(new Set([1, 2]), new Set([1, 3])), false);
});

// =============================================================================
// toBe — strict equality
// =============================================================================

Deno.test("toBe - pass", () => {
  const { expect, emissions } = createExpect(200);
  expect.toBe(200);
  assertEquals(last(emissions).passed, true);
  assertEquals(last(emissions).actual, 200);
  assertEquals(last(emissions).expected, 200);
});

Deno.test("toBe - fail", () => {
  const { expect, emissions } = createExpect(404);
  expect.toBe(200);
  assertEquals(last(emissions).passed, false);
  assertEquals(last(emissions).actual, 404);
  assertEquals(last(emissions).expected, 200);
});

Deno.test("toBe - NaN", () => {
  const { expect, emissions } = createExpect(NaN);
  expect.toBe(NaN);
  assertEquals(last(emissions).passed, true);
});

// =============================================================================
// toEqual — deep equality
// =============================================================================

Deno.test("toEqual - pass with nested objects", () => {
  const { expect, emissions } = createExpect({ a: { b: [1, 2] } });
  expect.toEqual({ a: { b: [1, 2] } });
  assertEquals(last(emissions).passed, true);
});

Deno.test("toEqual - fail", () => {
  const { expect, emissions } = createExpect({ a: 1 });
  expect.toEqual({ a: 2 });
  assertEquals(last(emissions).passed, false);
});

// =============================================================================
// toBeType
// =============================================================================

Deno.test("toBeType - pass", () => {
  const { expect, emissions } = createExpect("hello");
  expect.toBeType("string");
  assertEquals(last(emissions).passed, true);
});

Deno.test("toBeType - fail", () => {
  const { expect, emissions } = createExpect(42);
  expect.toBeType("string");
  assertEquals(last(emissions).passed, false);
  assertEquals(last(emissions).actual, "number");
});

// =============================================================================
// Truthiness
// =============================================================================

Deno.test("toBeTruthy - pass", () => {
  const { expect, emissions } = createExpect(1);
  expect.toBeTruthy();
  assertEquals(last(emissions).passed, true);
});

Deno.test("toBeTruthy - fail", () => {
  const { expect, emissions } = createExpect(0);
  expect.toBeTruthy();
  assertEquals(last(emissions).passed, false);
});

Deno.test("toBeFalsy - pass", () => {
  const { expect, emissions } = createExpect("");
  expect.toBeFalsy();
  assertEquals(last(emissions).passed, true);
});

Deno.test("toBeFalsy - fail", () => {
  const { expect, emissions } = createExpect("non-empty");
  expect.toBeFalsy();
  assertEquals(last(emissions).passed, false);
});

Deno.test("toBeNull - pass", () => {
  const { expect, emissions } = createExpect(null);
  expect.toBeNull();
  assertEquals(last(emissions).passed, true);
});

Deno.test("toBeNull - fail", () => {
  const { expect, emissions } = createExpect(undefined);
  expect.toBeNull();
  assertEquals(last(emissions).passed, false);
});

Deno.test("toBeUndefined - pass", () => {
  const { expect, emissions } = createExpect(undefined);
  expect.toBeUndefined();
  assertEquals(last(emissions).passed, true);
});

Deno.test("toBeUndefined - fail", () => {
  const { expect, emissions } = createExpect(null);
  expect.toBeUndefined();
  assertEquals(last(emissions).passed, false);
});

Deno.test("toBeDefined - pass", () => {
  const { expect, emissions } = createExpect("value");
  expect.toBeDefined();
  assertEquals(last(emissions).passed, true);
});

Deno.test("toBeDefined - fail", () => {
  const { expect, emissions } = createExpect(undefined);
  expect.toBeDefined();
  assertEquals(last(emissions).passed, false);
});

// =============================================================================
// Numeric comparisons
// =============================================================================

Deno.test("toBeGreaterThan - pass", () => {
  const { expect, emissions } = createExpect(10);
  expect.toBeGreaterThan(5);
  assertEquals(last(emissions).passed, true);
});

Deno.test("toBeGreaterThan - fail (equal)", () => {
  const { expect, emissions } = createExpect(5);
  expect.toBeGreaterThan(5);
  assertEquals(last(emissions).passed, false);
});

Deno.test("toBeLessThan - pass", () => {
  const { expect, emissions } = createExpect(3);
  expect.toBeLessThan(5);
  assertEquals(last(emissions).passed, true);
});

Deno.test("toBeLessThan - fail", () => {
  const { expect, emissions } = createExpect(5);
  expect.toBeLessThan(5);
  assertEquals(last(emissions).passed, false);
});

Deno.test("toBeWithin - pass", () => {
  const { expect, emissions } = createExpect(50);
  expect.toBeWithin(0, 100);
  assertEquals(last(emissions).passed, true);
});

Deno.test("toBeWithin - pass (boundary)", () => {
  const { expect, emissions } = createExpect(0);
  expect.toBeWithin(0, 100);
  assertEquals(last(emissions).passed, true);
});

Deno.test("toBeWithin - fail", () => {
  const { expect, emissions } = createExpect(101);
  expect.toBeWithin(0, 100);
  assertEquals(last(emissions).passed, false);
});

// =============================================================================
// Collection / string
// =============================================================================

Deno.test("toHaveLength - pass (array)", () => {
  const { expect, emissions } = createExpect([1, 2, 3]);
  expect.toHaveLength(3);
  assertEquals(last(emissions).passed, true);
});

Deno.test("toHaveLength - pass (string)", () => {
  const { expect, emissions } = createExpect("abc");
  expect.toHaveLength(3);
  assertEquals(last(emissions).passed, true);
});

Deno.test("toHaveLength - fail", () => {
  const { expect, emissions } = createExpect([1]);
  expect.toHaveLength(3);
  assertEquals(last(emissions).passed, false);
  assertEquals(last(emissions).actual, 1);
  assertEquals(last(emissions).expected, 3);
});

Deno.test("toContain - pass (array primitive)", () => {
  const { expect, emissions } = createExpect(["admin", "user"]);
  expect.toContain("admin");
  assertEquals(last(emissions).passed, true);
});

Deno.test("toContain - pass (array object via deep equal)", () => {
  const { expect, emissions } = createExpect([{ id: 1 }, { id: 2 }]);
  expect.toContain({ id: 1 });
  assertEquals(last(emissions).passed, true);
});

Deno.test("toContain - pass (string)", () => {
  const { expect, emissions } = createExpect("hello world");
  expect.toContain("world");
  assertEquals(last(emissions).passed, true);
});

Deno.test("toContain - fail", () => {
  const { expect, emissions } = createExpect(["admin"]);
  expect.toContain("superadmin");
  assertEquals(last(emissions).passed, false);
});

Deno.test("toMatch - pass (regex)", () => {
  const { expect, emissions } = createExpect("user@example.com");
  expect.toMatch(/@example\.com$/);
  assertEquals(last(emissions).passed, true);
});

Deno.test("toMatch - pass (string)", () => {
  const { expect, emissions } = createExpect("hello world");
  expect.toMatch("world");
  assertEquals(last(emissions).passed, true);
});

Deno.test("toMatch - fail", () => {
  const { expect, emissions } = createExpect("hello");
  expect.toMatch(/world/);
  assertEquals(last(emissions).passed, false);
});

Deno.test("toMatchObject - pass", () => {
  const { expect, emissions } = createExpect({
    success: true,
    data: { id: 1, name: "Alice" },
    meta: { page: 1 },
  });
  expect.toMatchObject({ success: true, data: { id: 1 } });
  assertEquals(last(emissions).passed, true);
});

Deno.test("toMatchObject - fail", () => {
  const { expect, emissions } = createExpect({ success: false });
  expect.toMatchObject({ success: true });
  assertEquals(last(emissions).passed, false);
});

Deno.test("toHaveProperty - pass (simple key)", () => {
  const { expect, emissions } = createExpect({ id: 42, name: "Alice" });
  expect.toHaveProperty("id");
  assertEquals(last(emissions).passed, true);
});

Deno.test("toHaveProperty - pass (dot path)", () => {
  const { expect, emissions } = createExpect({
    meta: { created: "2024-01-01" },
  });
  expect.toHaveProperty("meta.created");
  assertEquals(last(emissions).passed, true);
});

Deno.test("toHaveProperty - pass (with value)", () => {
  const { expect, emissions } = createExpect({
    meta: { created: "2024-01-01" },
  });
  expect.toHaveProperty("meta.created", "2024-01-01");
  assertEquals(last(emissions).passed, true);
});

Deno.test("toHaveProperty - fail (missing)", () => {
  const { expect, emissions } = createExpect({ name: "Alice" });
  expect.toHaveProperty("email");
  assertEquals(last(emissions).passed, false);
});

Deno.test("toHaveProperty - fail (value mismatch)", () => {
  const { expect, emissions } = createExpect({ id: 42 });
  expect.toHaveProperty("id", 99);
  assertEquals(last(emissions).passed, false);
});

// =============================================================================
// toSatisfy
// =============================================================================

Deno.test("toSatisfy - pass", () => {
  const { expect, emissions } = createExpect({ items: [1, 2, 3] });
  expect.toSatisfy((v) => v.items.length > 0, "should have items");
  assertEquals(last(emissions).passed, true);
});

Deno.test("toSatisfy - fail", () => {
  const { expect, emissions } = createExpect({ items: [] });
  expect.toSatisfy((v) => v.items.length > 0, "should have items");
  assertEquals(last(emissions).passed, false);
});

Deno.test("toSatisfy - predicate throws counts as fail", () => {
  const { expect, emissions } = createExpect(null);
  // deno-lint-ignore no-explicit-any
  expect.toSatisfy((v: any) => v.foo.bar > 0);
  assertEquals(last(emissions).passed, false);
});

// =============================================================================
// HTTP-specific: toHaveStatus, toHaveHeader
// =============================================================================

Deno.test("toHaveStatus - pass", () => {
  const { expect, emissions } = createExpect({ status: 200, ok: true });
  expect.toHaveStatus(200);
  assertEquals(last(emissions).passed, true);
});

Deno.test("toHaveStatus - fail", () => {
  const { expect, emissions } = createExpect({ status: 404 });
  expect.toHaveStatus(200);
  assertEquals(last(emissions).passed, false);
  assertEquals(last(emissions).actual, 404);
  assertEquals(last(emissions).expected, 200);
});

Deno.test("toHaveHeader - pass (existence, Headers object)", () => {
  const headers = new Headers({ "content-type": "application/json" });
  const { expect, emissions } = createExpect({ headers });
  expect.toHaveHeader("content-type");
  assertEquals(last(emissions).passed, true);
});

Deno.test("toHaveHeader - pass (value match, regex)", () => {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
  });
  const { expect, emissions } = createExpect({ headers });
  expect.toHaveHeader("content-type", /json/);
  assertEquals(last(emissions).passed, true);
});

Deno.test("toHaveHeader - pass (exact string match)", () => {
  const headers = new Headers({ "x-request-id": "abc123" });
  const { expect, emissions } = createExpect({ headers });
  expect.toHaveHeader("x-request-id", "abc123");
  assertEquals(last(emissions).passed, true);
});

Deno.test("toHaveHeader - pass (plain object headers)", () => {
  const { expect, emissions } = createExpect({
    headers: { "x-custom": "value" },
  });
  expect.toHaveHeader("x-custom", "value");
  assertEquals(last(emissions).passed, true);
});

Deno.test("toHaveHeader - fail (missing)", () => {
  const headers = new Headers();
  const { expect, emissions } = createExpect({ headers });
  expect.toHaveHeader("x-missing");
  assertEquals(last(emissions).passed, false);
});

Deno.test("toHaveHeader - fail (value mismatch)", () => {
  const headers = new Headers({ "content-type": "text/html" });
  const { expect, emissions } = createExpect({ headers });
  expect.toHaveHeader("content-type", /json/);
  assertEquals(last(emissions).passed, false);
});

// =============================================================================
// .not — negation
// =============================================================================

Deno.test(".not.toBe - pass (negated)", () => {
  const { expect, emissions } = createExpect(404);
  expect.not.toBe(200);
  assertEquals(last(emissions).passed, true);
});

Deno.test(".not.toBe - fail (negated — values match)", () => {
  const { expect, emissions } = createExpect(200);
  expect.not.toBe(200);
  assertEquals(last(emissions).passed, false);
});

Deno.test(".not.toContain - pass", () => {
  const { expect, emissions } = createExpect(["admin", "user"]);
  expect.not.toContain("superadmin");
  assertEquals(last(emissions).passed, true);
});

Deno.test(".not.toContain - fail", () => {
  const { expect, emissions } = createExpect(["admin", "user"]);
  expect.not.toContain("admin");
  assertEquals(last(emissions).passed, false);
});

Deno.test(".not.toBeTruthy - pass", () => {
  const { expect, emissions } = createExpect(0);
  expect.not.toBeTruthy();
  assertEquals(last(emissions).passed, true);
});

Deno.test(".not.toBeNull - pass", () => {
  const { expect, emissions } = createExpect("value");
  expect.not.toBeNull();
  assertEquals(last(emissions).passed, true);
});

Deno.test(".not.toHaveProperty - pass", () => {
  const { expect, emissions } = createExpect({ name: "Alice" });
  expect.not.toHaveProperty("email");
  assertEquals(last(emissions).passed, true);
});

// =============================================================================
// .orFail() — hard guard
// =============================================================================

Deno.test("orFail - does nothing when assertion passed", () => {
  const { expect, emissions } = createExpect(200);
  expect.toBe(200).orFail();
  assertEquals(last(emissions).passed, true);
  // No throw
});

Deno.test("orFail - throws ExpectFailError when assertion failed", () => {
  const { expect } = createExpect(404);
  assertThrows(() => {
    expect.toBe(200).orFail();
  }, ExpectFailError);
});

Deno.test("orFail - error message includes assertion message", () => {
  const { expect } = createExpect(404);
  try {
    expect.toBe(200).orFail();
  } catch (e) {
    assertEquals(e instanceof ExpectFailError, true);
    assertEquals((e as ExpectFailError).message.includes("404"), true);
    assertEquals((e as ExpectFailError).message.includes("200"), true);
  }
});

// =============================================================================
// Soft-by-default behavior
// =============================================================================

Deno.test("soft-by-default - multiple failures do not throw", () => {
  // All of these fail, but execution continues (no throw)
  const allEmissions: AssertionEmission[] = [];
  const emitter = (e: AssertionEmission) => allEmissions.push(e);

  new Expectation(404, emitter).toBe(200);
  new Expectation(42, emitter).toBeType("string");
  new Expectation([] as string[], emitter).toContain("admin");
  new Expectation("invalid", emitter).toMatch(/@/);

  // All 4 emissions recorded, all failed
  assertEquals(allEmissions.length, 4);
  for (const e of allEmissions) {
    assertEquals(e.passed, false);
  }
  // No exception was thrown — soft-by-default
});

Deno.test("chaining — multiple assertions on same expect", () => {
  const emissions: AssertionEmission[] = [];
  const e = new Expectation(200, (r) => emissions.push(r));
  // Each call to a terminal method emits; returns this for orFail chaining
  e.toBe(200);
  assertEquals(emissions.length, 1);
  assertEquals(last(emissions).passed, true);
});

// =============================================================================
// Edge cases
// =============================================================================

Deno.test("toContain - non-array non-string actual", () => {
  const { expect, emissions } = createExpect(42);
  // deno-lint-ignore no-explicit-any
  (expect as Expectation<any>).toContain("x");
  assertEquals(last(emissions).passed, false);
});

Deno.test("toMatchObject - null actual", () => {
  const { expect, emissions } = createExpect(null);
  // deno-lint-ignore no-explicit-any
  (expect as Expectation<any>).toMatchObject({ a: 1 });
  assertEquals(last(emissions).passed, false);
});

Deno.test("toHaveStatus - null actual", () => {
  const { expect, emissions } = createExpect(null);
  // deno-lint-ignore no-explicit-any
  (expect as Expectation<any>).toHaveStatus(200);
  assertEquals(last(emissions).passed, false);
});

Deno.test("toHaveHeader - null actual", () => {
  const { expect, emissions } = createExpect(null);
  // deno-lint-ignore no-explicit-any
  (expect as Expectation<any>).toHaveHeader("content-type");
  assertEquals(last(emissions).passed, false);
});

Deno.test("toHaveProperty - deeply nested path", () => {
  const { expect, emissions } = createExpect({
    a: { b: { c: { d: 42 } } },
  });
  expect.toHaveProperty("a.b.c.d", 42);
  assertEquals(last(emissions).passed, true);
});

Deno.test("toHaveProperty - path through null", () => {
  const { expect, emissions } = createExpect({ a: null });
  // deno-lint-ignore no-explicit-any
  (expect as Expectation<any>).toHaveProperty("a.b");
  assertEquals(last(emissions).passed, false);
});
