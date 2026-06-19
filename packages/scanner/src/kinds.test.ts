import { describe, expect, it } from "vitest";

import {
  GLUBEAN_KINDS,
  SUITE_KINDS,
  classifyByStem,
  suffixesForKind,
} from "./kinds.js";

describe("kinds registry — load (M4-b)", () => {
  it("classifies .load.ts as the load kind", () => {
    expect(classifyByStem("checkout.load.ts")).toBe("load");
    expect(classifyByStem("path/to/checkout.load.ts")).toBe("load");
    // Not confused with neighbouring kinds.
    expect(classifyByStem("checkout.test.ts")).toBe("test");
    expect(classifyByStem("checkout.ts")).toBeUndefined();
  });

  it("is NOT a suite kind — runs via `glubean load`, not a glubean.yaml `kinds:` value", () => {
    expect(SUITE_KINDS).not.toContain("load");
  });

  it("derives .load.ts suffixes across extensions", () => {
    expect(suffixesForKind("load")).toEqual([".load.ts", ".load.js", ".load.mjs"]);
  });

  it("is NOT a runtime-extraction artifact (own discovery/exec path)", () => {
    const def = GLUBEAN_KINDS.find((k) => k.kind === "load");
    expect(def).toBeDefined();
    expect(def?.runtimeArtifact).toBe(false);
    // So it never enters the contract/workflow eager-import artifact suffix set.
    const artifactSuffixes = GLUBEAN_KINDS.filter((k) => k.runtimeArtifact).flatMap((k) =>
      suffixesForKind(k.kind),
    );
    expect(artifactSuffixes).not.toContain(".load.ts");
  });
});
