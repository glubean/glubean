/**
 * Unit tests for the `{id, rowIndex}` "only" selector protocol (B2 M3).
 * Verifies cloud-parity matching: string sel (id/name), object sel (id-only),
 * object sel (id + rowIndex three-state), normalize, and failed-set collection.
 */
import { test, expect } from "vitest";
import {
  collectFailedSelectors,
  matchOnly,
  normalizeSelectors,
  type OnlySelector,
} from "./selector.js";

// ---------------------------------------------------------------------------
// normalizeSelectors
// ---------------------------------------------------------------------------

test("normalizeSelectors — null/undefined → null (no filter)", () => {
  expect(normalizeSelectors(null)).toBeNull();
  expect(normalizeSelectors(undefined)).toBeNull();
});

test("normalizeSelectors — bare value → single-element array", () => {
  expect(normalizeSelectors("a")).toEqual(["a"]);
  expect(normalizeSelectors({ id: "a", rowIndex: 1 })).toEqual([{ id: "a", rowIndex: 1 }]);
});

test("normalizeSelectors — array passes through", () => {
  const arr: OnlySelector[] = ["a", { id: "b" }];
  expect(normalizeSelectors(arr)).toBe(arr);
});

// ---------------------------------------------------------------------------
// matchOnly — string selector (id OR name)
// ---------------------------------------------------------------------------

test("matchOnly — string selector matches by id", () => {
  expect(matchOnly(["health"], { id: "health" })).toBe(true);
});

test("matchOnly — string selector matches by name", () => {
  expect(matchOnly(["List Users"], { id: "list-users", name: "List Users" })).toBe(true);
});

test("matchOnly — string selector ignores rowIndex (matches any row)", () => {
  expect(matchOnly(["user-0"], { id: "user-0", rowIndex: 0 })).toBe(true);
  expect(matchOnly(["user-0"], { id: "user-0", rowIndex: 5 })).toBe(true);
});

test("matchOnly — string selector no match", () => {
  expect(matchOnly(["nope"], { id: "health", name: "Health" })).toBe(false);
});

// ---------------------------------------------------------------------------
// matchOnly — object selector, three rowIndex states
// ---------------------------------------------------------------------------

test("matchOnly — object {id} matches every row of that id", () => {
  expect(matchOnly([{ id: "user-0" }], { id: "user-0", rowIndex: 0 })).toBe(true);
  expect(matchOnly([{ id: "user-0" }], { id: "user-0", rowIndex: 9 })).toBe(true);
});

test("matchOnly — object {id, rowIndex} pins one row", () => {
  expect(matchOnly([{ id: "user-0", rowIndex: 0 }], { id: "user-0", rowIndex: 0 })).toBe(true);
  expect(matchOnly([{ id: "user-0", rowIndex: 0 }], { id: "user-0", rowIndex: 1 })).toBe(false);
});

test("matchOnly — object selector requires matching id", () => {
  expect(matchOnly([{ id: "user-0", rowIndex: 0 }], { id: "user-1", rowIndex: 0 })).toBe(false);
});

test("matchOnly — object {id, rowIndex} does NOT match a test with undefined rowIndex", () => {
  expect(matchOnly([{ id: "x", rowIndex: 0 }], { id: "x" })).toBe(false);
});

test("matchOnly — any selector in the set may match (some)", () => {
  const sels: OnlySelector[] = [{ id: "a" }, { id: "b", rowIndex: 2 }];
  expect(matchOnly(sels, { id: "b", rowIndex: 2 })).toBe(true);
  expect(matchOnly(sels, { id: "a", rowIndex: 99 })).toBe(true);
  expect(matchOnly(sels, { id: "c" })).toBe(false);
});

// ---------------------------------------------------------------------------
// collectFailedSelectors
// ---------------------------------------------------------------------------

test("collectFailedSelectors — keeps only failures with an id", () => {
  const sels = collectFailedSelectors([
    { id: "a", success: true },
    { id: "b", success: false },
    { id: undefined, success: false },
  ]);
  expect(sels).toEqual([{ id: "b" }]);
});

test("collectFailedSelectors — emits {id, rowIndex} when rowIndex present, else {id}", () => {
  const sels = collectFailedSelectors([
    { id: "user-0", rowIndex: 0, success: false },
    { id: "health", success: false },
  ]);
  expect(sels).toEqual([{ id: "user-0", rowIndex: 0 }, { id: "health" }]);
});

test("collectFailedSelectors — rowIndex 0 is preserved (not treated as absent)", () => {
  const sels = collectFailedSelectors([{ id: "r", rowIndex: 0, success: false }]);
  expect(sels).toEqual([{ id: "r", rowIndex: 0 }]);
});
