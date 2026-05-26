import { describe, it, expect } from "vitest";
import { __testing } from "./run.js";

const { matchesExcludeTags, matchesTags } = __testing;

/**
 * Phase 1 sub-task A — excludeTags runtime filter.
 *
 * Tests the pure selection helper. Integration through the full
 * `glubean run --exclude-tag=...` CLI path is covered by dogfood
 * end-to-end runs.
 */

function makeTest(tags?: string[]) {
  return {
    meta: { id: "t", name: "t", tags },
    file: "/fake/path.ts",
    test: null as any,
  } as any;
}

describe("matchesExcludeTags (Phase 1 sub-task A)", () => {
  it("returns false when excludeTags is empty (no-op)", () => {
    expect(matchesExcludeTags(makeTest(["any"]), [])).toBe(false);
  });

  it("returns false when test has no tags", () => {
    expect(matchesExcludeTags(makeTest(undefined), ["manual"])).toBe(false);
    expect(matchesExcludeTags(makeTest([]), ["manual"])).toBe(false);
  });

  it("returns true if ANY excludeTag matches a test tag (OR semantic)", () => {
    expect(
      matchesExcludeTags(makeTest(["smoke", "manual"]), ["manual", "destructive"]),
    ).toBe(true);
  });

  it("returns false when no excludeTag matches", () => {
    expect(
      matchesExcludeTags(makeTest(["smoke", "fast"]), ["manual", "destructive"]),
    ).toBe(false);
  });

  it("case-insensitive matching", () => {
    expect(matchesExcludeTags(makeTest(["Manual"]), ["MANUAL"])).toBe(true);
    expect(matchesExcludeTags(makeTest(["destructive"]), ["DESTRUCTIVE"])).toBe(
      true,
    );
  });

  it("excludeTags is always OR — independent of any tagMode the caller uses", () => {
    // Even if positive `tags` matching is in 'and' mode, exclude must still OR.
    // We don't pass tagMode to matchesExcludeTags by design — it has none.
    expect(
      matchesExcludeTags(makeTest(["manual"]), ["manual", "never-present"]),
    ).toBe(true);
  });
});

// Sanity that matchesTags wasn't broken by the parallel helper addition.
describe("matchesTags (regression sanity)", () => {
  it("OR mode (default) — any match", () => {
    expect(matchesTags(makeTest(["smoke"]), ["smoke", "extra"])).toBe(true);
    expect(matchesTags(makeTest(["x"]), ["smoke", "extra"])).toBe(false);
  });

  it("AND mode — all required", () => {
    expect(matchesTags(makeTest(["a", "b"]), ["a", "b"], "and")).toBe(true);
    expect(matchesTags(makeTest(["a"]), ["a", "b"], "and")).toBe(false);
  });
});
