import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractLoadPlans, extractLoadPlansFromFile, isLoadFile } from "./load-extraction.js";

const proj = (runnerId: string, extra: Record<string, unknown> = {}) => ({
  runnerId,
  runMode: "load",
  concurrency: 1,
  scenarios: [],
  thresholdScopes: [],
  ...extra,
});
const plan = (runnerId: string) => ({
  __glubean_type: "load-runner",
  id: runnerId,
  projection: proj(runnerId),
});

describe("isLoadFile", () => {
  it("matches .load.{ts,js,mjs} only", () => {
    expect(isLoadFile("x.load.ts")).toBe(true);
    expect(isLoadFile("x.load.js")).toBe(true);
    expect(isLoadFile("x.load.mjs")).toBe(true);
    expect(isLoadFile("x.test.ts")).toBe(false);
    expect(isLoadFile("x.ts")).toBe(false);
  });
});

describe("extractLoadPlans", () => {
  it("extracts a single plan export with its projection + exportName", () => {
    const plans = extractLoadPlans({ checkoutLoad: plan("checkout-300") });
    expect(plans).toEqual([{ ...proj("checkout-300"), exportName: "checkoutLoad" }]);
  });

  it("extracts plans from an array export (loadRunner.each)", () => {
    const plans = extractLoadPlans({ byPlan: [plan("free"), plan("pro")] });
    expect(plans.map((p) => p.runnerId)).toEqual(["free", "pro"]);
    expect(plans.every((p) => p.exportName === "byPlan")).toBe(true);
  });

  it("ignores non-plan exports and marker-less values", () => {
    const plans = extractLoadPlans({
      notAPlan: { foo: 1 },
      n: 42,
      s: "x",
      arr: [1, 2, { __glubean_type: "builder" }],
      good: plan("g"),
    });
    expect(plans.map((p) => p.runnerId)).toEqual(["g"]);
  });

  it("skips a marked plan whose projection is missing/invalid", () => {
    const plans = extractLoadPlans({ bad: { __glubean_type: "load-runner" } });
    expect(plans).toEqual([]);
  });
});

describe("extractLoadPlansFromFile", () => {
  it("imports a module and extracts its plans (single + array)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "load-ext-"));
    const file = join(dir, "checkout.load.mjs");
    writeFileSync(
      file,
      `
export const single = { __glubean_type: "load-runner", id: "co", projection: { runnerId: "co", runMode: "load", concurrency: 7, scenarios: [], thresholdScopes: [] } };
export const many = [
  { __glubean_type: "load-runner", id: "a", projection: { runnerId: "a", runMode: "load", concurrency: 1, scenarios: [], thresholdScopes: [] } },
];
export const ignored = 123;
`,
    );
    const result = await extractLoadPlansFromFile(file);
    expect(result.error).toBeUndefined();
    expect(result.plans.map((p) => p.runnerId).sort()).toEqual(["a", "co"]);
    expect(result.plans.find((p) => p.runnerId === "co")?.concurrency).toBe(7);
  });

  it("is fail-closed on a module that throws on import", async () => {
    const dir = mkdtempSync(join(tmpdir(), "load-ext-bad-"));
    const file = join(dir, "broken.load.mjs");
    writeFileSync(file, `throw new Error("boom at import");`);
    const result = await extractLoadPlansFromFile(file);
    expect(result.plans).toEqual([]);
    expect(result.error).toMatch(/boom at import/);
  });

  // NOTE: the ESM cache-bust (`?t=<mtime>` on changed files) is real-Node
  // behavior for long-lived hosts; it is not unit-tested here because vitest's
  // module runner caches dynamic import() by path and ignores the query, so a
  // re-import test would assert vitest's behavior, not production Node's. The
  // logic mirrors contract-extraction's proven cache-bust.
});
