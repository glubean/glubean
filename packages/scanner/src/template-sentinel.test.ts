import { test, expect } from "vitest";
import {
  findTemplateMatch,
  findTemplateMatches,
  hasTemplatePlaceholders,
  matchesTemplateFilter,
  matchesTemplateId,
  stripVariantPrefix,
} from "./template-sentinel.js";

test("template sentinel helpers strip VSCode variant prefixes", () => {
  expect(stripVariantPrefix("each:case-$id")).toBe("case-$id");
  expect(stripVariantPrefix("pick:search-$_pick")).toBe("search-$_pick");
  expect(stripVariantPrefix("health")).toBe("health");
});

test("template sentinel helpers detect unresolved placeholders", () => {
  expect(hasTemplatePlaceholders("case-$id")).toBe(true);
  expect(hasTemplatePlaceholders("pick:case-$_pick")).toBe(true);
  expect(hasTemplatePlaceholders("case-101")).toBe(false);
});

test("matchesTemplateId matches concrete runtime ids", () => {
  expect(matchesTemplateId("case-$id", "case-101")).toBe(true);
  expect(matchesTemplateId("case-$index-$label", "case-0-alpha")).toBe(true);
  expect(matchesTemplateId("pick:search-$_pick-$q", "search-normal-phone")).toBe(true);
  expect(matchesTemplateId("case-$id", "other-101")).toBe(false);
});

test("matchesTemplateFilter accepts concrete row filters by template shape", () => {
  expect(matchesTemplateFilter("case-$id", "case-101")).toBe(true);
  expect(matchesTemplateFilter("case-$id", "case-")).toBe(true);
  expect(matchesTemplateFilter("case-$id", "101")).toBe(false);
});

test("findTemplateMatch prefers exact ids then template-shaped ids", () => {
  const items = [{ id: "case-$id" }, { id: "case-101" }, { id: "health" }];
  expect(findTemplateMatch(items, "health")?.id).toBe("health");
  expect(findTemplateMatch(items, "case-101")?.id).toBe("case-101");
  expect(findTemplateMatch(items, "case-202")?.id).toBe("case-$id");
  expect(findTemplateMatch(items, "missing")).toBeUndefined();
});

test("findTemplateMatches keeps EVERY match, not just the first (GLU-67)", () => {
  // Same exact id in two entries (e.g. `health` defined in two files) — both kept.
  const dupExact = [
    { id: "health", file: "a" },
    { id: "other", file: "b" },
    { id: "health", file: "c" },
  ];
  expect(findTemplateMatches(dupExact, "health").map((m) => m.file)).toEqual(["a", "c"]);

  // Two overlapping templates that a concrete id both satisfy — both kept
  // (findTemplateMatch would silently drop the second).
  const overlap = [
    { id: "case-$x", file: "t1" },
    { id: "case-$y", file: "t2" },
    { id: "misc-$z", file: "t3" },
  ];
  expect(findTemplateMatches(overlap, "case-101").map((m) => m.file)).toEqual(["t1", "t2"]);

  // Exact-over-template preference is preserved AND pluralized: an exact match
  // suppresses template entries, and all exact matches come back.
  const mixed = [
    { id: "case-$id", file: "tmpl" },
    { id: "case-101", file: "exactA" },
    { id: "case-101", file: "exactB" },
  ];
  expect(findTemplateMatches(mixed, "case-101").map((m) => m.file)).toEqual(["exactA", "exactB"]);

  // No match → empty array.
  expect(findTemplateMatches(overlap, "nope-1")).toEqual([]);
});
