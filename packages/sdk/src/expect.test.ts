/**
 * Tests for the Expectation<T> fluent assertion class.
 *
 * Every test uses a mock emitter to capture assertion emissions,
 * then verifies passed/failed, actual/expected, and message.
 */

import { test, expect as vitestExpect } from "vitest";
import { type AssertionEmission, deepEqual, Expectation, ExpectFailError, inspect } from "./expect.js";

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

test("inspect - primitives", () => {
  vitestExpect(inspect(null)).toBe("null");
  vitestExpect(inspect(undefined)).toBe("undefined");
  vitestExpect(inspect(42)).toBe("42");
  vitestExpect(inspect(true)).toBe("true");
  vitestExpect(inspect("hello")).toBe('"hello"');
});

test("inspect - truncates long strings", () => {
  const long = "a".repeat(200);
  const result = inspect(long, 64);
  // JSON.stringify wraps in quotes, so "aaa..." is > 200 chars.
  // inspect truncates to maxLen with trailing ..."
  vitestExpect(result.length <= 64).toBe(true);
  vitestExpect(result.endsWith('..."')).toBe(true);
});

test("inspect - objects and arrays", () => {
  vitestExpect(inspect({ a: 1 })).toBe('{"a":1}');
  vitestExpect(inspect([1, 2, 3])).toBe("[1,2,3]");
});

test("inspect - RegExp and Date", () => {
  vitestExpect(inspect(/abc/gi)).toBe("/abc/gi");
  const d = new Date("2024-01-01T00:00:00Z");
  vitestExpect(inspect(d)).toBe("2024-01-01T00:00:00.000Z");
});

// =============================================================================
// deepEqual() helper
// =============================================================================

test("deepEqual - primitives", () => {
  vitestExpect(deepEqual(1, 1)).toBe(true);
  vitestExpect(deepEqual(1, 2)).toBe(false);
  vitestExpect(deepEqual("a", "a")).toBe(true);
  vitestExpect(deepEqual(null, null)).toBe(true);
  vitestExpect(deepEqual(undefined, undefined)).toBe(true);
  vitestExpect(deepEqual(null, undefined)).toBe(false);
  vitestExpect(deepEqual(NaN, NaN)).toBe(true);
  vitestExpect(deepEqual(0, -0)).toBe(false); // Object.is semantics
});

test("deepEqual - arrays", () => {
  vitestExpect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
  vitestExpect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  vitestExpect(deepEqual([{ a: 1 }], [{ a: 1 }])).toBe(true);
});

test("deepEqual - objects", () => {
  vitestExpect(deepEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true);
  vitestExpect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  vitestExpect(deepEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
});

test("deepEqual - Date", () => {
  const d1 = new Date("2024-01-01");
  const d2 = new Date("2024-01-01");
  const d3 = new Date("2024-06-15");
  vitestExpect(deepEqual(d1, d2)).toBe(true);
  vitestExpect(deepEqual(d1, d3)).toBe(false);
});

test("deepEqual - RegExp", () => {
  vitestExpect(deepEqual(/abc/g, /abc/g)).toBe(true);
  vitestExpect(deepEqual(/abc/g, /abc/i)).toBe(false);
});

test("deepEqual - Map and Set", () => {
  vitestExpect(deepEqual(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(true);
  vitestExpect(deepEqual(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
  vitestExpect(deepEqual(new Set([1, 2]), new Set([1, 2]))).toBe(true);
  vitestExpect(deepEqual(new Set([1, 2]), new Set([1, 3]))).toBe(false);
});

test("deepEqual - circular references do not cause stack overflow", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a: any = { x: 1 };
  a.self = a;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = { x: 1 };
  b.self = b;
  vitestExpect(deepEqual(a, b)).toBe(true);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = { x: 2 };
  c.self = c;
  vitestExpect(deepEqual(a, c)).toBe(false);

  // Mutual circular references
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d: any = { val: "d" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e: any = { val: "d" };
  d.ref = e;
  e.ref = d;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const f: any = { val: "d" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = { val: "d" };
  f.ref = g;
  g.ref = f;
  vitestExpect(deepEqual(d, f)).toBe(true);
});

// =============================================================================
// toBe — strict equality
// =============================================================================

test("toBe - pass", () => {
  const { expect, emissions } = createExpect(200);
  expect.toBe(200);
  vitestExpect(last(emissions).passed).toBe(true);
  vitestExpect(last(emissions).actual).toBe(200);
  vitestExpect(last(emissions).expected).toBe(200);
});

test("toBe - fail", () => {
  const { expect, emissions } = createExpect(404);
  expect.toBe(200);
  vitestExpect(last(emissions).passed).toBe(false);
  vitestExpect(last(emissions).actual).toBe(404);
  vitestExpect(last(emissions).expected).toBe(200);
});

test("toBe - NaN", () => {
  const { expect, emissions } = createExpect(NaN);
  expect.toBe(NaN);
  vitestExpect(last(emissions).passed).toBe(true);
});

// =============================================================================
// toEqual — deep equality
// =============================================================================

test("toEqual - pass with nested objects", () => {
  const { expect, emissions } = createExpect({ a: { b: [1, 2] } });
  expect.toEqual({ a: { b: [1, 2] } });
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toEqual - fail", () => {
  const { expect, emissions } = createExpect({ a: 1 });
  expect.toEqual({ a: 2 });
  vitestExpect(last(emissions).passed).toBe(false);
});

// =============================================================================
// toBeType
// =============================================================================

test("toBeType - pass", () => {
  const { expect, emissions } = createExpect("hello");
  expect.toBeType("string");
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toBeType - fail", () => {
  const { expect, emissions } = createExpect(42);
  expect.toBeType("string");
  vitestExpect(last(emissions).passed).toBe(false);
  vitestExpect(last(emissions).actual).toBe("number");
});

// =============================================================================
// Truthiness
// =============================================================================

test("toBeTruthy - pass", () => {
  const { expect, emissions } = createExpect(1);
  expect.toBeTruthy();
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toBeTruthy - fail", () => {
  const { expect, emissions } = createExpect(0);
  expect.toBeTruthy();
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toBeFalsy - pass", () => {
  const { expect, emissions } = createExpect("");
  expect.toBeFalsy();
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toBeFalsy - fail", () => {
  const { expect, emissions } = createExpect("non-empty");
  expect.toBeFalsy();
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toBeNull - pass", () => {
  const { expect, emissions } = createExpect(null);
  expect.toBeNull();
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toBeNull - fail", () => {
  const { expect, emissions } = createExpect(undefined);
  expect.toBeNull();
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toBeUndefined - pass", () => {
  const { expect, emissions } = createExpect(undefined);
  expect.toBeUndefined();
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toBeUndefined - fail", () => {
  const { expect, emissions } = createExpect(null);
  expect.toBeUndefined();
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toBeDefined - pass", () => {
  const { expect, emissions } = createExpect("value");
  expect.toBeDefined();
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toBeDefined - fail", () => {
  const { expect, emissions } = createExpect(undefined);
  expect.toBeDefined();
  vitestExpect(last(emissions).passed).toBe(false);
});

// =============================================================================
// Numeric comparisons
// =============================================================================

test("toBeGreaterThan - pass", () => {
  const { expect, emissions } = createExpect(10);
  expect.toBeGreaterThan(5);
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toBeGreaterThan - fail (equal)", () => {
  const { expect, emissions } = createExpect(5);
  expect.toBeGreaterThan(5);
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toBeLessThan - pass", () => {
  const { expect, emissions } = createExpect(3);
  expect.toBeLessThan(5);
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toBeLessThan - fail", () => {
  const { expect, emissions } = createExpect(5);
  expect.toBeLessThan(5);
  vitestExpect(last(emissions).passed).toBe(false);
});

// =============================================================================
// toBeGreaterThanOrEqual / toBeLessThanOrEqual
// =============================================================================

test("toBeGreaterThanOrEqual - pass (greater)", () => {
  const { expect, emissions } = createExpect(10);
  expect.toBeGreaterThanOrEqual(5);
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toBeGreaterThanOrEqual - pass (equal)", () => {
  const { expect, emissions } = createExpect(5);
  expect.toBeGreaterThanOrEqual(5);
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toBeGreaterThanOrEqual - fail", () => {
  const { expect, emissions } = createExpect(4);
  expect.toBeGreaterThanOrEqual(5);
  vitestExpect(last(emissions).passed).toBe(false);
  vitestExpect(last(emissions).actual).toBe(4);
  vitestExpect(last(emissions).expected).toBe(">= 5");
});

test("toBeLessThanOrEqual - pass (less)", () => {
  const { expect, emissions } = createExpect(3);
  expect.toBeLessThanOrEqual(5);
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toBeLessThanOrEqual - pass (equal)", () => {
  const { expect, emissions } = createExpect(5);
  expect.toBeLessThanOrEqual(5);
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toBeLessThanOrEqual - fail", () => {
  const { expect, emissions } = createExpect(6);
  expect.toBeLessThanOrEqual(5);
  vitestExpect(last(emissions).passed).toBe(false);
  vitestExpect(last(emissions).actual).toBe(6);
  vitestExpect(last(emissions).expected).toBe("<= 5");
});

test("toBeWithin - pass", () => {
  const { expect, emissions } = createExpect(50);
  expect.toBeWithin(0, 100);
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toBeWithin - pass (boundary)", () => {
  const { expect, emissions } = createExpect(0);
  expect.toBeWithin(0, 100);
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toBeWithin - fail", () => {
  const { expect, emissions } = createExpect(101);
  expect.toBeWithin(0, 100);
  vitestExpect(last(emissions).passed).toBe(false);
});

// =============================================================================
// Collection / string
// =============================================================================

test("toHaveLength - pass (array)", () => {
  const { expect, emissions } = createExpect([1, 2, 3]);
  expect.toHaveLength(3);
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toHaveLength - pass (string)", () => {
  const { expect, emissions } = createExpect("abc");
  expect.toHaveLength(3);
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toHaveLength - fail", () => {
  const { expect, emissions } = createExpect([1]);
  expect.toHaveLength(3);
  vitestExpect(last(emissions).passed).toBe(false);
  vitestExpect(last(emissions).actual).toBe(1);
  vitestExpect(last(emissions).expected).toBe(3);
});

test("toContain - pass (array primitive)", () => {
  const { expect, emissions } = createExpect(["admin", "user"]);
  expect.toContain("admin");
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toContain - pass (array object via deep equal)", () => {
  const { expect, emissions } = createExpect([{ id: 1 }, { id: 2 }]);
  expect.toContain({ id: 1 });
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toContain - pass (string)", () => {
  const { expect, emissions } = createExpect("hello world");
  expect.toContain("world");
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toContain - fail", () => {
  const { expect, emissions } = createExpect(["admin"]);
  expect.toContain("superadmin");
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toMatch - pass (regex)", () => {
  const { expect, emissions } = createExpect("user@example.com");
  expect.toMatch(/@example\.com$/);
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toMatch - pass (string)", () => {
  const { expect, emissions } = createExpect("hello world");
  expect.toMatch("world");
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toMatch - fail", () => {
  const { expect, emissions } = createExpect("hello");
  expect.toMatch(/world/);
  vitestExpect(last(emissions).passed).toBe(false);
});

// =============================================================================
// toStartWith / toEndWith
// =============================================================================

test("toStartWith - pass", () => {
  const { expect, emissions } = createExpect("usr_abc123");
  expect.toStartWith("usr_");
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toStartWith - fail", () => {
  const { expect, emissions } = createExpect("org_abc123");
  expect.toStartWith("usr_");
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toStartWith - fail (non-string actual)", () => {
  const { expect, emissions } = createExpect(42);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (expect as Expectation<any>).toStartWith("4");
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toEndWith - pass", () => {
  const { expect, emissions } = createExpect("report.json");
  expect.toEndWith(".json");
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toEndWith - fail", () => {
  const { expect, emissions } = createExpect("report.csv");
  expect.toEndWith(".json");
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toEndWith - fail (non-string actual)", () => {
  const { expect, emissions } = createExpect(123);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (expect as Expectation<any>).toEndWith("3");
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toMatchObject - pass", () => {
  const { expect, emissions } = createExpect({
    success: true,
    data: { id: 1, name: "Alice" },
    meta: { page: 1 },
  });
  expect.toMatchObject({ success: true, data: { id: 1 } });
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toMatchObject - fail", () => {
  const { expect, emissions } = createExpect({ success: false });
  expect.toMatchObject({ success: true });
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toHaveProperty - pass (simple key)", () => {
  const { expect, emissions } = createExpect({ id: 42, name: "Alice" });
  expect.toHaveProperty("id");
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toHaveProperty - pass (dot path)", () => {
  const { expect, emissions } = createExpect({
    meta: { created: "2024-01-01" },
  });
  expect.toHaveProperty("meta.created");
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toHaveProperty - pass (with value)", () => {
  const { expect, emissions } = createExpect({
    meta: { created: "2024-01-01" },
  });
  expect.toHaveProperty("meta.created", "2024-01-01");
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toHaveProperty - fail (missing)", () => {
  const { expect, emissions } = createExpect({ name: "Alice" });
  expect.toHaveProperty("email");
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toHaveProperty - fail (value mismatch)", () => {
  const { expect, emissions } = createExpect({ id: 42 });
  expect.toHaveProperty("id", 99);
  vitestExpect(last(emissions).passed).toBe(false);
});

// =============================================================================
// toHaveProperties
// =============================================================================

test("toHaveProperties - pass (all present)", () => {
  const { expect, emissions } = createExpect({
    id: 1,
    name: "Alice",
    email: "a@b.com",
    createdAt: "2024-01-01",
  });
  expect.toHaveProperties(["id", "name", "email", "createdAt"]);
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toHaveProperties - fail (some missing)", () => {
  const { expect, emissions } = createExpect({ id: 1, name: "Alice" });
  expect.toHaveProperties(["id", "name", "email", "role"]);
  vitestExpect(last(emissions).passed).toBe(false);
  // Reports missing keys
  vitestExpect(last(emissions).actual).toEqual(["email", "role"]);
});

test("toHaveProperties - pass (dot paths)", () => {
  const { expect, emissions } = createExpect({
    meta: { created: "2024", updated: "2025" },
    id: 1,
  });
  expect.toHaveProperties(["id", "meta.created", "meta.updated"]);
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toHaveProperties - fail (nested missing)", () => {
  const { expect, emissions } = createExpect({ meta: { created: "2024" } });
  expect.toHaveProperties(["meta.created", "meta.deleted"]);
  vitestExpect(last(emissions).passed).toBe(false);
  vitestExpect(last(emissions).actual).toEqual(["meta.deleted"]);
});

test("toHaveProperties - empty keys array always passes", () => {
  const { expect, emissions } = createExpect({});
  expect.toHaveProperties([]);
  vitestExpect(last(emissions).passed).toBe(true);
});

// =============================================================================
// toSatisfy
// =============================================================================

test("toSatisfy - pass", () => {
  const { expect, emissions } = createExpect({ items: [1, 2, 3] });
  expect.toSatisfy((v) => v.items.length > 0, "should have items");
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toSatisfy - fail", () => {
  const { expect, emissions } = createExpect({ items: [] });
  expect.toSatisfy((v) => v.items.length > 0, "should have items");
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toSatisfy - predicate throws counts as fail", () => {
  const { expect, emissions } = createExpect(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect.toSatisfy((v: any) => v.foo.bar > 0);
  vitestExpect(last(emissions).passed).toBe(false);
});

// =============================================================================
// HTTP-specific: toHaveStatus, toHaveHeader
// =============================================================================

test("toHaveStatus - pass", () => {
  const { expect, emissions } = createExpect({ status: 200, ok: true });
  expect.toHaveStatus(200);
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toHaveStatus - fail", () => {
  const { expect, emissions } = createExpect({ status: 404 });
  expect.toHaveStatus(200);
  vitestExpect(last(emissions).passed).toBe(false);
  vitestExpect(last(emissions).actual).toBe(404);
  vitestExpect(last(emissions).expected).toBe(200);
});

test("toHaveHeader - pass (existence, Headers object)", () => {
  const headers = new Headers({ "content-type": "application/json" });
  const { expect, emissions } = createExpect({ headers });
  expect.toHaveHeader("content-type");
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toHaveHeader - pass (value match, regex)", () => {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
  });
  const { expect, emissions } = createExpect({ headers });
  expect.toHaveHeader("content-type", /json/);
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toHaveHeader - pass (exact string match)", () => {
  const headers = new Headers({ "x-request-id": "abc123" });
  const { expect, emissions } = createExpect({ headers });
  expect.toHaveHeader("x-request-id", "abc123");
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toHaveHeader - pass (plain object headers)", () => {
  const { expect, emissions } = createExpect({
    headers: { "x-custom": "value" },
  });
  expect.toHaveHeader("x-custom", "value");
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toHaveHeader - fail (missing)", () => {
  const headers = new Headers();
  const { expect, emissions } = createExpect({ headers });
  expect.toHaveHeader("x-missing");
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toHaveHeader - fail (value mismatch)", () => {
  const headers = new Headers({ "content-type": "text/html" });
  const { expect, emissions } = createExpect({ headers });
  expect.toHaveHeader("content-type", /json/);
  vitestExpect(last(emissions).passed).toBe(false);
});

// =============================================================================
// toHaveJsonBody
// =============================================================================

test("toHaveJsonBody - pass (partial match)", async () => {
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
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toHaveJsonBody - pass (nested partial match)", async () => {
  const mockResponse = {
    json: () =>
      Promise.resolve({
        success: true,
        data: { id: 1, name: "Alice", extra: "stuff" },
      }),
  };
  const { expect, emissions } = createExpect(mockResponse);
  await expect.toHaveJsonBody({ success: true, data: { id: 1 } });
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toHaveJsonBody - fail (value mismatch)", async () => {
  const mockResponse = {
    json: () => Promise.resolve({ success: false }),
  };
  const { expect, emissions } = createExpect(mockResponse);
  await expect.toHaveJsonBody({ success: true });
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toHaveJsonBody - fail (missing key)", async () => {
  const mockResponse = {
    json: () => Promise.resolve({ id: 1 }),
  };
  const { expect, emissions } = createExpect(mockResponse);
  await expect.toHaveJsonBody({ name: "Alice" });
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toHaveJsonBody - fail (not a Response)", async () => {
  const { expect, emissions } = createExpect("not a response");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (expect as Expectation<any>).toHaveJsonBody({ id: 1 });
  vitestExpect(last(emissions).passed).toBe(false);
  vitestExpect(last(emissions).message.includes("not a Response")).toBe(true);
});

test("toHaveJsonBody - fail (invalid JSON)", async () => {
  const mockResponse = {
    json: () => Promise.reject(new Error("invalid json")),
  };
  const { expect, emissions } = createExpect(mockResponse);
  await expect.toHaveJsonBody({ id: 1 });
  vitestExpect(last(emissions).passed).toBe(false);
  vitestExpect(last(emissions).message.includes("failed to parse JSON")).toBe(true);
});

test("toHaveJsonBody - fail (null body)", async () => {
  const mockResponse = {
    json: () => Promise.resolve(null),
  };
  const { expect, emissions } = createExpect(mockResponse);
  await expect.toHaveJsonBody({ id: 1 });
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toHaveJsonBody - works with orFail", async () => {
  const mockResponse = {
    json: () => Promise.resolve({ ok: true }),
  };
  const { expect, emissions } = createExpect(mockResponse);
  (await expect.toHaveJsonBody({ ok: true })).orFail();
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toHaveJsonBody - orFail throws on failure", async () => {
  const mockResponse = {
    json: () => Promise.resolve({ ok: false }),
  };
  const { expect } = createExpect(mockResponse);
  let threw = false;
  try {
    (await expect.toHaveJsonBody({ ok: true })).orFail();
  } catch (e) {
    threw = true;
    vitestExpect(e instanceof ExpectFailError).toBe(true);
  }
  vitestExpect(threw).toBe(true);
});

// =============================================================================
// .not — negation
// =============================================================================

test(".not.toBe - pass (negated)", () => {
  const { expect, emissions } = createExpect(404);
  expect.not.toBe(200);
  vitestExpect(last(emissions).passed).toBe(true);
});

test(".not.toBe - fail (negated — values match)", () => {
  const { expect, emissions } = createExpect(200);
  expect.not.toBe(200);
  vitestExpect(last(emissions).passed).toBe(false);
});

test(".not.toContain - pass", () => {
  const { expect, emissions } = createExpect(["admin", "user"]);
  expect.not.toContain("superadmin");
  vitestExpect(last(emissions).passed).toBe(true);
});

test(".not.toContain - fail", () => {
  const { expect, emissions } = createExpect(["admin", "user"]);
  expect.not.toContain("admin");
  vitestExpect(last(emissions).passed).toBe(false);
});

test(".not.toBeTruthy - pass", () => {
  const { expect, emissions } = createExpect(0);
  expect.not.toBeTruthy();
  vitestExpect(last(emissions).passed).toBe(true);
});

test(".not.toBeNull - pass", () => {
  const { expect, emissions } = createExpect("value");
  expect.not.toBeNull();
  vitestExpect(last(emissions).passed).toBe(true);
});

test(".not.toHaveProperty - pass", () => {
  const { expect, emissions } = createExpect({ name: "Alice" });
  expect.not.toHaveProperty("email");
  vitestExpect(last(emissions).passed).toBe(true);
});

test(".not.toStartWith - pass", () => {
  const { expect, emissions } = createExpect("org_123");
  expect.not.toStartWith("usr_");
  vitestExpect(last(emissions).passed).toBe(true);
});

test(".not.toEndWith - pass", () => {
  const { expect, emissions } = createExpect("report.csv");
  expect.not.toEndWith(".json");
  vitestExpect(last(emissions).passed).toBe(true);
});

test(".not.toBeGreaterThanOrEqual - pass", () => {
  const { expect, emissions } = createExpect(3);
  expect.not.toBeGreaterThanOrEqual(5);
  vitestExpect(last(emissions).passed).toBe(true);
});

test(".not.toBeLessThanOrEqual - pass", () => {
  const { expect, emissions } = createExpect(10);
  expect.not.toBeLessThanOrEqual(5);
  vitestExpect(last(emissions).passed).toBe(true);
});

// =============================================================================
// .orFail() — hard guard
// =============================================================================

test("orFail - does nothing when assertion passed", () => {
  const { expect, emissions } = createExpect(200);
  expect.toBe(200).orFail();
  vitestExpect(last(emissions).passed).toBe(true);
  // No throw
});

test("orFail - throws ExpectFailError when assertion failed", () => {
  const { expect } = createExpect(404);
  vitestExpect(() => {
    expect.toBe(200).orFail();
  }).toThrow();
});

test("orFail - error message includes assertion message", () => {
  const { expect } = createExpect(404);
  try {
    expect.toBe(200).orFail();
  } catch (e) {
    vitestExpect(e instanceof ExpectFailError).toBe(true);
    vitestExpect((e as ExpectFailError).message.includes("404")).toBe(true);
    vitestExpect((e as ExpectFailError).message.includes("200")).toBe(true);
  }
});

// =============================================================================
// Soft-by-default behavior
// =============================================================================

test("soft-by-default - multiple failures do not throw", () => {
  // All of these fail, but execution continues (no throw)
  const allEmissions: AssertionEmission[] = [];
  const emitter = (e: AssertionEmission) => allEmissions.push(e);

  new Expectation(404, emitter).toBe(200);
  new Expectation(42, emitter).toBeType("string");
  new Expectation([] as string[], emitter).toContain("admin");
  new Expectation("invalid", emitter).toMatch(/@/);

  // All 4 emissions recorded, all failed
  vitestExpect(allEmissions.length).toBe(4);
  for (const e of allEmissions) {
    vitestExpect(e.passed).toBe(false);
  }
  // No exception was thrown — soft-by-default
});

test("chaining — multiple assertions on same expect", () => {
  const emissions: AssertionEmission[] = [];
  const e = new Expectation(200, (r) => emissions.push(r));
  // Each call to a terminal method emits; returns this for orFail chaining
  e.toBe(200);
  vitestExpect(emissions.length).toBe(1);
  vitestExpect(last(emissions).passed).toBe(true);
});

// =============================================================================
// Edge cases
// =============================================================================

test("toContain - non-array non-string actual", () => {
  const { expect, emissions } = createExpect(42);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (expect as Expectation<any>).toContain("x");
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toMatchObject - null actual", () => {
  const { expect, emissions } = createExpect(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (expect as Expectation<any>).toMatchObject({ a: 1 });
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toHaveStatus - null actual", () => {
  const { expect, emissions } = createExpect(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (expect as Expectation<any>).toHaveStatus(200);
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toHaveHeader - null actual", () => {
  const { expect, emissions } = createExpect(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (expect as Expectation<any>).toHaveHeader("content-type");
  vitestExpect(last(emissions).passed).toBe(false);
});

test("toHaveProperty - deeply nested path", () => {
  const { expect, emissions } = createExpect({
    a: { b: { c: { d: 42 } } },
  });
  expect.toHaveProperty("a.b.c.d", 42);
  vitestExpect(last(emissions).passed).toBe(true);
});

test("toHaveProperty - path through null", () => {
  const { expect, emissions } = createExpect({ a: null });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (expect as Expectation<any>).toHaveProperty("a.b");
  vitestExpect(last(emissions).passed).toBe(false);
});

// =============================================================================
// Expectation.extend() — custom matchers
// =============================================================================

// Declaration merging: augment CustomMatchers so custom matchers are fully typed.
// In user test files, this same pattern provides IDE auto-complete and type safety.
declare module "./expect.js" {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (Expectation.prototype as any)[name];
}

test("Expectation.extend() adds a custom matcher", () => {
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
    vitestExpect(last(emissions).passed).toBe(true);
    vitestExpect(last(emissions).message.includes("to be even")).toBe(true);

    const { expect: expect2, emissions: emissions2 } = createExpect(3);
    expect2.toBeEven();
    vitestExpect(last(emissions2).passed).toBe(false);
  } finally {
    removeCustomMatcher("toBeEven");
  }
});

test("Expectation.extend() custom matcher works with .not negation", () => {
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
    vitestExpect(last(emissions).passed).toBe(false);

    // .not.toBePositive() on a negative number → should pass
    const { expect: expect2, emissions: emissions2 } = createExpect(-1);
    expect2.not.toBePositive();
    vitestExpect(last(emissions2).passed).toBe(true);
  } finally {
    removeCustomMatcher("toBePositive");
  }
});

test("Expectation.extend() custom matcher works with .orFail()", () => {
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
    vitestExpect(() => {
      expect2.toBePositive().orFail();
    }).toThrow();
  } finally {
    removeCustomMatcher("toBePositive");
  }
});

test("Expectation.extend() throws if matcher name conflicts with existing method", () => {
  vitestExpect(() => {
    Expectation.extend({
      toBe: () => ({ passed: true, message: "override" }),
    });
  }).toThrow();
});

test("Expectation.extend() matcher receives correct actual value", () => {
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

    vitestExpect(receivedActual).toEqual({ foo: "bar" });
    vitestExpect(receivedArgs!).toEqual(["arg1", 42]);
  } finally {
    removeCustomMatcher("toBeCustom");
  }
});

test("Expectation.extend() multiple matchers at once", () => {
  try {
    Expectation.extend({
      toBeOdd: (actual) => ({
        passed: typeof actual === "number" && actual % 2 !== 0,
        message: "to be odd",
        actual,
      }),
      toBeInRange: (actual, min, max) => ({
        passed: typeof actual === "number" &&
          actual >= (min as number) &&
          actual <= (max as number),
        message: `to be in range [${min}, ${max}]`,
        actual,
        expected: `[${min}, ${max}]`,
      }),
    });

    const { expect, emissions } = createExpect(7);
    expect.toBeOdd();
    vitestExpect(last(emissions).passed).toBe(true);

    const { expect: expect2, emissions: emissions2 } = createExpect(5);
    expect2.toBeInRange(1, 10);
    vitestExpect(last(emissions2).passed).toBe(true);

    const { expect: expect3, emissions: emissions3 } = createExpect(15);
    expect3.toBeInRange(1, 10);
    vitestExpect(last(emissions3).passed).toBe(false);
  } finally {
    removeCustomMatcher("toBeOdd");
    removeCustomMatcher("toBeInRange");
  }
});
