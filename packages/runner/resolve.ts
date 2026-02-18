/**
 * Shared test resolution utilities.
 *
 * Extracted from harness.ts so that both the runner sandbox and external
 * consumers (e.g. MCP server) can resolve module exports into Test objects
 * using the same logic.
 *
 * @module
 */

import type { Test } from "@glubean/sdk";

// ---------------------------------------------------------------------------
// ResolvedTest — lightweight metadata returned by resolveModuleTests()
// ---------------------------------------------------------------------------

/**
 * Lightweight metadata about a discovered test.
 *
 * Returned by {@link resolveModuleTests} after resolving all export shapes
 * (plain `Test`, `Test[]`, `TestBuilder`, `EachBuilder`).
 *
 * Consumers should use `id` for routing (passing to the runner) and
 * `exportName` for display / fallback lookup.
 */
export interface ResolvedTest {
  exportName: string;
  id: string;
  name?: string;
  tags?: string[];
  type: "simple" | "steps";
  only?: boolean;
  skip?: boolean;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Type guard — check if a value is a resolved `Test` object.
 *
 * A Test has `meta` (with at least `id`) and `type` ("simple" | "steps").
 */
export function isTest(obj: unknown): obj is Test<unknown> {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "meta" in obj &&
    "type" in obj &&
    ((obj as Test<unknown>).type === "simple" ||
      (obj as Test<unknown>).type === "steps")
  );
}

/**
 * Type guard — check if a value is an un-built `TestBuilder`.
 *
 * The builder carries `__glubean_type === "builder"` and a `build()` method
 * that returns a single `Test`.
 */
export function isTestBuilder(
  obj: unknown,
): obj is { __glubean_type: "builder"; build(): Test<unknown> } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as Record<string, unknown>).__glubean_type === "builder" &&
    typeof (obj as Record<string, unknown>).build === "function"
  );
}

/**
 * Type guard — check if a value is an un-built `EachBuilder`
 * (from `test.each()` builder mode).
 *
 * The builder carries `__glubean_type === "each-builder"` and a `build()`
 * method that returns a `Test[]`.
 */
export function isEachBuilder(
  obj: unknown,
): obj is { __glubean_type: "each-builder"; build(): Test<unknown>[] } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as Record<string, unknown>).__glubean_type === "each-builder" &&
    typeof (obj as Record<string, unknown>).build === "function"
  );
}

// ---------------------------------------------------------------------------
// Auto-resolve helpers
// ---------------------------------------------------------------------------

/**
 * If the value is a `TestBuilder`, call `.build()` to get a `Test`.
 * If the value is an `EachBuilder`, call `.build()` to get a `Test[]`.
 * Otherwise return as-is.
 */
export function autoResolve(value: unknown): unknown {
  if (isTestBuilder(value)) return value.build();
  if (isEachBuilder(value)) return value.build();
  return value;
}

/**
 * Search a resolved value (single `Test` or `Test[]`) for a matching test ID.
 * @internal
 */
function findInResolved(
  resolved: unknown,
  testId: string,
): Test<unknown> | undefined {
  if (isTest(resolved) && resolved.meta?.id === testId) {
    return resolved as Test<unknown>;
  }
  if (Array.isArray(resolved)) {
    for (const item of resolved) {
      if (isTest(item) && item.meta?.id === testId) {
        return item as Test<unknown>;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Module-level resolution
// ---------------------------------------------------------------------------

/**
 * Enumerate all tests from an imported module.
 *
 * Handles every export shape produced by the SDK:
 * - Plain `Test` object (`test("id", fn)` or built builder)
 * - `Test[]` array (`test.each(data)("id-$key", fn)`)
 * - Un-built `TestBuilder` (`test("id").step(...)`)
 * - Un-built `EachBuilder` (`test.each(data)("id-$key").step(...)`)
 *
 * @param module The imported user module (`await import(url)`)
 * @returns Array of {@link ResolvedTest} metadata for every discovered test
 */
export function resolveModuleTests(
  module: Record<string, unknown>,
): ResolvedTest[] {
  const tests: ResolvedTest[] = [];

  for (const [exportName, value] of Object.entries(module)) {
    collectTests(exportName, value, tests);
  }

  return tests;
}

/**
 * Resolve a single export value and push any discovered tests into `out`.
 * @internal
 */
function collectTests(
  exportName: string,
  value: unknown,
  out: ResolvedTest[],
): void {
  const resolved = autoResolve(value);

  if (isTest(resolved)) {
    out.push(toResolvedTest(exportName, resolved));
    return;
  }

  if (Array.isArray(resolved)) {
    for (const item of resolved) {
      const resolvedItem = autoResolve(item);
      if (isTest(resolvedItem)) {
        out.push(toResolvedTest(exportName, resolvedItem));
      }
    }
  }
}

/**
 * Map a `Test` object to a lightweight `ResolvedTest` record.
 * @internal
 */
function toResolvedTest(exportName: string, test: Test<unknown>): ResolvedTest {
  const meta = test.meta;
  return {
    exportName,
    id: meta.id,
    name: meta.name,
    tags: Array.isArray(meta.tags)
      ? meta.tags
      : typeof meta.tags === "string"
      ? [meta.tags]
      : undefined,
    type: test.type,
    only: meta.only ?? undefined,
    skip: meta.skip ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Single-test lookup (used by runner harness during execution)
// ---------------------------------------------------------------------------

/**
 * Find a test by its `meta.id` in an imported module.
 *
 * Searches: default export, direct export keyed by testId, then all exports.
 * Automatically builds any `TestBuilder` or `EachBuilder` it encounters.
 *
 * @param userModule The imported user test module
 * @param testId The test ID (`meta.id`) to find
 * @returns The `Test` object if found, `undefined` otherwise
 */
export function findTestById(
  userModule: Record<string, unknown>,
  testId: string,
): Test<unknown> | undefined {
  // Check default export
  const defaultResolved = autoResolve(userModule.default);
  const fromDefault = findInResolved(defaultResolved, testId);
  if (fromDefault) return fromDefault;

  // Check direct export by testId
  const directResolved = autoResolve(userModule[testId]);
  const fromDirect = findInResolved(directResolved, testId);
  if (fromDirect) return fromDirect;

  for (const value of Object.values(userModule)) {
    const resolved = autoResolve(value);
    const found = findInResolved(resolved, testId);
    if (found) return found;

    // Also support plain Test[] arrays (test.each simple mode exports)
    if (Array.isArray(value)) {
      for (const item of value) {
        const resolvedItem = autoResolve(item);
        const foundItem = findInResolved(resolvedItem, testId);
        if (foundItem) return foundItem;
      }
    }
  }

  return undefined;
}

/**
 * Find a test by its export name instead of test ID.
 *
 * Used as a fallback for non-deterministic tests like `test.pick()`, where
 * the test ID from discovery may differ from the current run's random
 * selection. The export name (e.g. `"searchProducts"`) is stable across runs.
 *
 * @param userModule The imported user test module
 * @param name The export name to look up
 * @returns The first `Test` object found in that export, or `undefined`
 */
export function findTestByExport(
  userModule: Record<string, unknown>,
  name: string,
): Test<unknown> | undefined {
  const value = userModule[name];
  if (value === undefined) return undefined;

  const resolved = autoResolve(value);

  if (isTest(resolved)) {
    return resolved as Test<unknown>;
  }
  if (Array.isArray(resolved)) {
    for (const item of resolved) {
      if (isTest(item)) {
        return item as Test<unknown>;
      }
    }
  }
  return undefined;
}
