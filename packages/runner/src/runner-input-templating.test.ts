/**
 * Unit tests for `applyEnvTemplating` (attachment-model §8).
 */

import { describe, expect, test } from "vitest";
import { applyEnvTemplating } from "./runner-input-templating.js";

describe("applyEnvTemplating", () => {
  test("substitutes a single {{VAR}} in a string", () => {
    expect(applyEnvTemplating("{{NAME}}", { NAME: "alice" })).toBe("alice");
  });

  test("substitutes interpolated string with prefix/suffix", () => {
    expect(
      applyEnvTemplating("Bearer {{TOKEN}}-suffix", { TOKEN: "abc" }),
    ).toBe("Bearer abc-suffix");
  });

  test("substitutes multiple vars in one string", () => {
    expect(
      applyEnvTemplating("{{A}}-{{B}}", { A: "x", B: "y" }),
    ).toBe("x-y");
  });

  test("strips whitespace inside braces", () => {
    expect(applyEnvTemplating("{{ NAME }}", { NAME: "alice" })).toBe("alice");
  });

  test("recurses into nested objects and arrays", () => {
    const out = applyEnvTemplating(
      {
        token: "{{TOKEN}}",
        nested: { authorization: "Bearer {{TOKEN}}" },
        ids: ["u-{{ID1}}", "u-{{ID2}}"],
      },
      { TOKEN: "tk", ID1: "1", ID2: "2" },
    );
    expect(out).toEqual({
      token: "tk",
      nested: { authorization: "Bearer tk" },
      ids: ["u-1", "u-2"],
    });
  });

  test("passes through non-string scalars unchanged", () => {
    expect(applyEnvTemplating(42, {})).toBe(42);
    expect(applyEnvTemplating(true, {})).toBe(true);
    expect(applyEnvTemplating(null, {})).toBe(null);
  });

  test("passes through strings without braces verbatim", () => {
    expect(applyEnvTemplating("plain text", { ANY: "x" })).toBe("plain text");
  });

  test("throws on missing var", () => {
    expect(() =>
      applyEnvTemplating("{{MISSING}}", { ANYTHING_ELSE: "x" }),
    ).toThrow(/missing env var "MISSING"/);
  });

  test("throws on partial-missing in interpolation (preserves first-error semantics)", () => {
    expect(() =>
      applyEnvTemplating("{{A}}-{{B}}", { A: "x" }),
    ).toThrow(/missing env var "B"/);
  });

  test("does not mutate the input value", () => {
    const input = { token: "{{TOKEN}}", nested: { x: "{{X}}" } };
    const out = applyEnvTemplating(input, { TOKEN: "t", X: "x" });
    expect(out).not.toBe(input);
    expect(input).toEqual({ token: "{{TOKEN}}", nested: { x: "{{X}}" } });
  });
});
