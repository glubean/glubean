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

// =============================================================================
// toBeGreaterThanOrEqual / toBeLessThanOrEqual
// =============================================================================

Deno.test("toBeGreaterThanOrEqual - pass (greater)", () => {
  const { expect, emissions } = createExpect(10);
  expect.toBeGreaterThanOrEqual(5);
  assertEquals(last(emissions).passed, true);
});

Deno.test("toBeGreaterThanOrEqual - pass (equal)", () => {
  const { expect, emissions } = createExpect(5);
  expect.toBeGreaterThanOrEqual(5);
  assertEquals(last(emissions).passed, true);
});

Deno.test("toBeGreaterThanOrEqual - fail", () => {
  const { expect, emissions } = createExpect(4);
  expect.toBeGreaterThanOrEqual(5);
  assertEquals(last(emissions).passed, false);
  assertEquals(last(emissions).actual, 4);
  assertEquals(last(emissions).expected, ">= 5");
});

Deno.test("toBeLessThanOrEqual - pass (less)", () => {
  const { expect, emissions } = createExpect(3);
  expect.toBeLessThanOrEqual(5);
  assertEquals(last(emissions).passed, true);
});

Deno.test("toBeLessThanOrEqual - pass (equal)", () => {
  const { expect, emissions } = createExpect(5);
  expect.toBeLessThanOrEqual(5);
  assertEquals(last(emissions).passed, true);
});

Deno.test("toBeLessThanOrEqual - fail", () => {
  const { expect, emissions } = createExpect(6);
  expect.toBeLessThanOrEqual(5);
  assertEquals(last(emissions).passed, false);
  assertEquals(last(emissions).actual, 6);
  assertEquals(last(emissions).expected, "<= 5");
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

// =============================================================================
// toStartWith / toEndWith
// =============================================================================

Deno.test("toStartWith - pass", () => {
  const { expect, emissions } = createExpect("usr_abc123");
  expect.toStartWith("usr_");
  assertEquals(last(emissions).passed, true);
});

Deno.test("toStartWith - fail", () => {
  const { expect, emissions } = createExpect("org_abc123");
  expect.toStartWith("usr_");
  assertEquals(last(emissions).passed, false);
});

Deno.test("toStartWith - fail (non-string actual)", () => {
  const { expect, emissions } = createExpect(42);
  // deno-lint-ignore no-explicit-any
  (expect as Expectation<any>).toStartWith("4");
  assertEquals(last(emissions).passed, false);
});

Deno.test("toEndWith - pass", () => {
  const { expect, emissions } = createExpect("report.json");
  expect.toEndWith(".json");
  assertEquals(last(emissions).passed, true);
});

Deno.test("toEndWith - fail", () => {
  const { expect, emissions } = createExpect("report.csv");
  expect.toEndWith(".json");
  assertEquals(last(emissions).passed, false);
});

Deno.test("toEndWith - fail (non-string actual)", () => {
  const { expect, emissions } = createExpect(123);
  // deno-lint-ignore no-explicit-any
  (expect as Expectation<any>).toEndWith("3");
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
// toHaveProperties
// =============================================================================

Deno.test("toHaveProperties - pass (all present)", () => {
  const { expect, emissions } = createExpect({
    id: 1,
    name: "Alice",
    email: "a@b.com",
    createdAt: "2024-01-01",
  });
  expect.toHaveProperties(["id", "name", "email", "createdAt"]);
  assertEquals(last(emissions).passed, true);
});

Deno.test("toHaveProperties - fail (some missing)", () => {
  const { expect, emissions } = createExpect({ id: 1, name: "Alice" });
  expect.toHaveProperties(["id", "name", "email", "role"]);
  assertEquals(last(emissions).passed, false);
  // Reports missing keys
  assertEquals(last(emissions).actual, ["email", "role"]);
});

Deno.test("toHaveProperties - pass (dot paths)", () => {
  const { expect, emissions } = createExpect({
    meta: { created: "2024", updated: "2025" },
    id: 1,
  });
  expect.toHaveProperties(["id", "meta.created", "meta.updated"]);
  assertEquals(last(emissions).passed, true);
});

Deno.test("toHaveProperties - fail (nested missing)", () => {
  const { expect, emissions } = createExpect({ meta: { created: "2024" } });
  expect.toHaveProperties(["meta.created", "meta.deleted"]);
  assertEquals(last(emissions).passed, false);
  assertEquals(last(emissions).actual, ["meta.deleted"]);
});

Deno.test("toHaveProperties - empty keys array always passes", () => {
  const { expect, emissions } = createExpect({});
  expect.toHaveProperties([]);
  assertEquals(last(emissions).passed, true);
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
// toHaveJsonBody
// =============================================================================

Deno.test("toHaveJsonBody - pass (partial match)", async () => {
  const mockResponse = {
    json: () =>
      Promise.resolve({
        id: 1,
        name: "Alice",
        createdAt: "2024-01-01",
        meta: { role: "admin" },
      }),
  };
  const { expect, emissions } = createExpect(mockResponse);
  await expect.toHaveJsonBody({ id: 1, name: "Alice" });
  assertEquals(last(emissions).passed, true);
});

Deno.test("toHaveJsonBody - pass (nested partial match)", async () => {
  const mockResponse = {
    json: () =>
      Promise.resolve({
        success: true,
        data: { id: 1, name: "Alice", extra: "stuff" },
      }),
  };
  const { expect, emissions } = createExpect(mockResponse);
  await expect.toHaveJsonBody({ success: true, data: { id: 1 } });
  assertEquals(last(emissions).passed, true);
});

Deno.test("toHaveJsonBody - fail (value mismatch)", async () => {
  const mockResponse = {
    json: () => Promise.resolve({ success: false }),
  };
  const { expect, emissions } = createExpect(mockResponse);
  await expect.toHaveJsonBody({ success: true });
  assertEquals(last(emissions).passed, false);
});

Deno.test("toHaveJsonBody - fail (missing key)", async () => {
  const mockResponse = {
    json: () => Promise.resolve({ id: 1 }),
  };
  const { expect, emissions } = createExpect(mockResponse);
  await expect.toHaveJsonBody({ name: "Alice" });
  assertEquals(last(emissions).passed, false);
});

Deno.test("toHaveJsonBody - fail (not a Response)", async () => {
  const { expect, emissions } = createExpect("not a response");
  // deno-lint-ignore no-explicit-any
  await (expect as Expectation<any>).toHaveJsonBody({ id: 1 });
  assertEquals(last(emissions).passed, false);
  assertEquals(last(emissions).message.includes("not a Response"), true);
});

Deno.test("toHaveJsonBody - fail (invalid JSON)", async () => {
  const mockResponse = {
    json: () => Promise.reject(new Error("invalid json")),
  };
  const { expect, emissions } = createExpect(mockResponse);
  await expect.toHaveJsonBody({ id: 1 });
  assertEquals(last(emissions).passed, false);
  assertEquals(last(emissions).message.includes("failed to parse JSON"), true);
});

Deno.test("toHaveJsonBody - fail (null body)", async () => {
  const mockResponse = {
    json: () => Promise.resolve(null),
  };
  const { expect, emissions } = createExpect(mockResponse);
  await expect.toHaveJsonBody({ id: 1 });
  assertEquals(last(emissions).passed, false);
});

Deno.test("toHaveJsonBody - works with orFail", async () => {
  const mockResponse = {
    json: () => Promise.resolve({ ok: true }),
  };
  const { expect, emissions } = createExpect(mockResponse);
  (await expect.toHaveJsonBody({ ok: true })).orFail();
  assertEquals(last(emissions).passed, true);
});

Deno.test("toHaveJsonBody - orFail throws on failure", async () => {
  const mockResponse = {
    json: () => Promise.resolve({ ok: false }),
  };
  const { expect } = createExpect(mockResponse);
  let threw = false;
  try {
    (await expect.toHaveJsonBody({ ok: true })).orFail();
  } catch (e) {
    threw = true;
    assertEquals(e instanceof ExpectFailError, true);
  }
  assertEquals(threw, true);
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

Deno.test(".not.toStartWith - pass", () => {
  const { expect, emissions } = createExpect("org_123");
  expect.not.toStartWith("usr_");
  assertEquals(last(emissions).passed, true);
});

Deno.test(".not.toEndWith - pass", () => {
  const { expect, emissions } = createExpect("report.csv");
  expect.not.toEndWith(".json");
  assertEquals(last(emissions).passed, true);
});

Deno.test(".not.toBeGreaterThanOrEqual - pass", () => {
  const { expect, emissions } = createExpect(3);
  expect.not.toBeGreaterThanOrEqual(5);
  assertEquals(last(emissions).passed, true);
});

Deno.test(".not.toBeLessThanOrEqual - pass", () => {
  const { expect, emissions } = createExpect(10);
  expect.not.toBeLessThanOrEqual(5);
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

// =============================================================================
// Expectation.extend() — custom matchers
// =============================================================================

// Declaration merging: augment CustomMatchers so custom matchers are fully typed.
// In user test files, this same pattern provides IDE auto-complete and type safety.
declare module "./expect.ts" {
  interface CustomMatchers<T> {
    toBeEven(): Expectation<T>;
    toBePositive(): Expectation<T>;
    toBeCustom(...args: unknown[]): Expectation<T>;
    toBeOdd(): Expectation<T>;
    toBeInRange(min: number, max: number): Expectation<T>;
  }
}

// Clean up after each extend test to avoid pollution between tests.
// Since extend patches the prototype, we need to remove added methods.
function removeCustomMatcher(name: string): void {
  // deno-lint-ignore no-explicit-any
  delete (Expectation.prototype as any)[name];
}

Deno.test("Expectation.extend() adds a custom matcher", () => {
  try {
    Expectation.extend({
      toBeEven: (actual) => ({
        passed: typeof actual === "number" && actual % 2 === 0,
        message: "to be even",
        actual,
      }),
    });

    const { expect, emissions } = createExpect(4);
    expect.toBeEven();
    assertEquals(last(emissions).passed, true);
    assertEquals(last(emissions).message.includes("to be even"), true);

    const { expect: expect2, emissions: emissions2 } = createExpect(3);
    expect2.toBeEven();
    assertEquals(last(emissions2).passed, false);
  } finally {
    removeCustomMatcher("toBeEven");
  }
});

Deno.test(
  "Expectation.extend() custom matcher works with .not negation",
  () => {
    try {
      Expectation.extend({
        toBePositive: (actual) => ({
          passed: typeof actual === "number" && actual > 0,
          message: "to be positive",
          actual,
        }),
      });

      // .not.toBePositive() on a positive number → should fail
      const { expect, emissions } = createExpect(5);
      expect.not.toBePositive();
      assertEquals(last(emissions).passed, false);

      // .not.toBePositive() on a negative number → should pass
      const { expect: expect2, emissions: emissions2 } = createExpect(-1);
      expect2.not.toBePositive();
      assertEquals(last(emissions2).passed, true);
    } finally {
      removeCustomMatcher("toBePositive");
    }
  },
);

Deno.test("Expectation.extend() custom matcher works with .orFail()", () => {
  try {
    Expectation.extend({
      toBePositive: (actual) => ({
        passed: typeof actual === "number" && actual > 0,
        message: "to be positive",
        actual,
      }),
    });

    // .orFail() on passing assertion → no throw
    const { expect } = createExpect(5);
    expect.toBePositive().orFail();

    // .orFail() on failing assertion → throws ExpectFailError
    const { expect: expect2 } = createExpect(-1);
    assertThrows(() => {
      expect2.toBePositive().orFail();
    }, ExpectFailError);
  } finally {
    removeCustomMatcher("toBePositive");
  }
});

Deno.test(
  "Expectation.extend() throws if matcher name conflicts with existing method",
  () => {
    assertThrows(
      () => {
        Expectation.extend({
          toBe: () => ({ passed: true, message: "override" }),
        });
      },
      Error,
      'Matcher "toBe" already exists',
    );
  },
);

Deno.test("Expectation.extend() matcher receives correct actual value", () => {
  try {
    let receivedActual: unknown;
    let receivedArgs: unknown[];

    Expectation.extend({
      toBeCustom: (actual, ...args) => {
        receivedActual = actual;
        receivedArgs = args;
        return { passed: true, message: "custom check" };
      },
    });

    const { expect } = createExpect({ foo: "bar" });
    expect.toBeCustom("arg1", 42);

    assertEquals(receivedActual, { foo: "bar" });
    assertEquals(receivedArgs!, ["arg1", 42]);
  } finally {
    removeCustomMatcher("toBeCustom");
  }
});

Deno.test("Expectation.extend() multiple matchers at once", () => {
  try {
    Expectation.extend({
      toBeOdd: (actual) => ({
        passed: typeof actual === "number" && actual % 2 !== 0,
        message: "to be odd",
        actual,
      }),
      toBeInRange: (actual, min, max) => ({
        passed:
          typeof actual === "number" &&
          actual >= (min as number) &&
          actual <= (max as number),
        message: `to be in range [${min}, ${max}]`,
        actual,
        expected: `[${min}, ${max}]`,
      }),
    });

    const { expect, emissions } = createExpect(7);
    expect.toBeOdd();
    assertEquals(last(emissions).passed, true);

    const { expect: expect2, emissions: emissions2 } = createExpect(5);
    expect2.toBeInRange(1, 10);
    assertEquals(last(emissions2).passed, true);

    const { expect: expect3, emissions: emissions3 } = createExpect(15);
    expect3.toBeInRange(1, 10);
    assertEquals(last(emissions3).passed, false);
  } finally {
    removeCustomMatcher("toBeOdd");
    removeCustomMatcher("toBeInRange");
  }
});
