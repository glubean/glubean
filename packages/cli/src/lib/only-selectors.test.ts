/**
 * Unit tests for the CLI `{id, rowIndex}` selector builders (B2 M3).
 * Covers flag mutual-exclusion / validation and last-run → rerun derivation.
 */
import { test, expect } from "vitest";
import { buildOnlySelectorsFromFlags, deriveRerunSelectors } from "./only-selectors.js";

// ---------------------------------------------------------------------------
// buildOnlySelectorsFromFlags — happy paths
// ---------------------------------------------------------------------------

test("buildOnlySelectorsFromFlags — no flags → empty selectors", () => {
  const r = buildOnlySelectorsFromFlags({});
  expect(r).toEqual({ ok: true, selectors: [] });
});

test("buildOnlySelectorsFromFlags — single --only-id → {id}", () => {
  const r = buildOnlySelectorsFromFlags({ onlyId: ["health"] });
  expect(r).toEqual({ ok: true, selectors: [{ id: "health" }] });
});

test("buildOnlySelectorsFromFlags — multiple --only-id → array of {id}", () => {
  const r = buildOnlySelectorsFromFlags({ onlyId: ["a", "b"] });
  expect(r).toEqual({ ok: true, selectors: [{ id: "a" }, { id: "b" }] });
});

test("buildOnlySelectorsFromFlags — one --only-id + --row → {id, rowIndex}", () => {
  const r = buildOnlySelectorsFromFlags({ onlyId: ["user-$index"], row: 2 });
  expect(r).toEqual({ ok: true, selectors: [{ id: "user-$index", rowIndex: 2 }] });
});

test("buildOnlySelectorsFromFlags — --row 0 is honored", () => {
  const r = buildOnlySelectorsFromFlags({ onlyId: ["u"], row: 0 });
  expect(r).toEqual({ ok: true, selectors: [{ id: "u", rowIndex: 0 }] });
});

test("buildOnlySelectorsFromFlags — --rerun-failed alone → ok, empty (sourced from file)", () => {
  const r = buildOnlySelectorsFromFlags({ rerunFailed: true });
  expect(r).toEqual({ ok: true, selectors: [] });
});

// ---------------------------------------------------------------------------
// buildOnlySelectorsFromFlags — validation errors
// ---------------------------------------------------------------------------

test("buildOnlySelectorsFromFlags — --row with zero --only-id → error", () => {
  const r = buildOnlySelectorsFromFlags({ row: 1 });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("--row requires");
});

test("buildOnlySelectorsFromFlags — --row with multiple --only-id → error", () => {
  const r = buildOnlySelectorsFromFlags({ onlyId: ["a", "b"], row: 1 });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("exactly one --only-id");
});

test("buildOnlySelectorsFromFlags — --rerun-failed + --only-id → error", () => {
  const r = buildOnlySelectorsFromFlags({ onlyId: ["a"], rerunFailed: true });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("--rerun-failed cannot be combined");
});

test("buildOnlySelectorsFromFlags — --rerun-failed + --row → error", () => {
  const r = buildOnlySelectorsFromFlags({ row: 0, rerunFailed: true });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("--rerun-failed cannot be combined");
});

// ---------------------------------------------------------------------------
// deriveRerunSelectors
// ---------------------------------------------------------------------------

test("deriveRerunSelectors — picks failed tests + their distinct files", () => {
  const { selectors, files } = deriveRerunSelectors({
    tests: [
      { testId: "a", filePath: "tests/a.test.ts", success: true },
      { testId: "user-0", rowIndex: 0, filePath: "tests/each.test.ts", success: false },
      { testId: "user-1", rowIndex: 1, filePath: "tests/each.test.ts", success: true },
      { testId: "b", filePath: "tests/b.test.ts", success: false },
    ],
  });
  expect(selectors).toEqual([{ id: "user-0", rowIndex: 0 }, { id: "b" }]);
  // Distinct failed files only — a.test.ts (all green) excluded; each.test.ts once.
  expect(files).toEqual(["tests/each.test.ts", "tests/b.test.ts"]);
});

test("deriveRerunSelectors — no failures → empty", () => {
  const { selectors, files } = deriveRerunSelectors({
    tests: [{ testId: "a", filePath: "tests/a.test.ts", success: true }],
  });
  expect(selectors).toEqual([]);
  expect(files).toEqual([]);
});

test("deriveRerunSelectors — tolerates a missing tests array", () => {
  const r = deriveRerunSelectors({ tests: undefined as never });
  expect(r).toEqual({ selectors: [], files: [], discoveryFailureFiles: [] });
});

// ---------------------------------------------------------------------------
// deriveRerunSelectors — GLU-155 discoveryFailures (files that failed to
// IMPORT last run, so they contributed zero entries to `tests`)
// ---------------------------------------------------------------------------

test("deriveRerunSelectors — folds discoveryFailures files into `files`, reported separately", () => {
  const { selectors, files, discoveryFailureFiles } = deriveRerunSelectors({
    tests: [{ testId: "a", filePath: "tests/a.test.ts", success: true }],
    discoveryFailures: [{ filePath: "contracts/broken.contract.ts" }],
  });
  // No discovered test ever failed, so no id-based selector — but the
  // import-failed file must still be retried.
  expect(selectors).toEqual([]);
  expect(files).toEqual(["contracts/broken.contract.ts"]);
  expect(discoveryFailureFiles).toEqual(["contracts/broken.contract.ts"]);
});

test("deriveRerunSelectors — discoveryFailures + failed tests coexist without duplicating a shared file", () => {
  const { selectors, files, discoveryFailureFiles } = deriveRerunSelectors({
    tests: [{ testId: "b", filePath: "tests/b.test.ts", success: false }],
    discoveryFailures: [
      { filePath: "tests/b.test.ts" }, // same file also recorded a discovery failure — no dupe
      { filePath: "contracts/broken.contract.ts" },
    ],
  });
  expect(selectors).toEqual([{ id: "b" }]);
  expect(files).toEqual(["tests/b.test.ts", "contracts/broken.contract.ts"]);
  // Already `seen` via the failed-test pass, so NOT double-counted here.
  expect(discoveryFailureFiles).toEqual(["contracts/broken.contract.ts"]);
});

test("deriveRerunSelectors — tolerates a missing discoveryFailures array", () => {
  const r = deriveRerunSelectors({
    tests: [{ testId: "a", filePath: "tests/a.test.ts", success: true }],
  });
  expect(r).toEqual({ selectors: [], files: [], discoveryFailureFiles: [] });
});
