import { describe, expect, it } from "vitest";
import { loadRunner, loadScenario, parseDurationMs, projectLoadPlan } from "./index.js";

describe("parseDurationMs", () => {
  it("parses numbers and unit strings", () => {
    expect(parseDurationMs(500)).toBe(500);
    expect(parseDurationMs("500ms")).toBe(500);
    expect(parseDurationMs("60s")).toBe(60_000);
    expect(parseDurationMs("2m")).toBe(120_000);
    expect(parseDurationMs("1h")).toBe(3_600_000);
    expect(parseDurationMs("1.5s")).toBe(1_500);
  });

  it("rejects invalid durations", () => {
    expect(() => parseDurationMs("soon")).toThrow();
    expect(() => parseDurationMs("10x")).toThrow();
    expect(() => parseDurationMs(-1)).toThrow();
  });
});

describe("projectLoadPlan", () => {
  const checkout = loadScenario<{ sku: string }>("checkout")
    .setup(async (ctx) => ({ sku: ctx.input.sku }))
    .step("buy", async (_c, s) => s);

  it("projects a single-scenario plan with normalized durations", () => {
    const plan = loadRunner("checkout-300", {
      scenario: checkout,
      concurrency: 300,
      duration: "60s",
      rampUp: "10s",
      thresholds: {
        transaction: { p95: "<2s" },
        endpoints: { "POST /checkout": { p95: "<800ms" } },
      },
    });
    const proj = projectLoadPlan(plan);
    expect(proj.runnerId).toBe("checkout-300");
    expect(proj.runMode).toBe("load");
    expect(proj.concurrency).toBe(300);
    expect(proj.durationMs).toBe(60_000);
    expect(proj.rampUpMs).toBe(10_000);
    expect(proj.scenarios).toEqual([{ scenarioId: "checkout", steps: ["buy"] }]);
    expect(proj.thresholdScopes.sort()).toEqual(["endpoints", "transaction"]);
  });

  it("projects a traffic-mix plan with refs and weights", () => {
    const refund = loadScenario<{ orderId: string }>("refund").step("refund", async (_c, s) => s);
    const plan = loadRunner("mixed", {
      scenarios: [
        { id: "co", scenario: checkout, weight: 70, input: () => ({ sku: "s" }) },
        { id: "rf", scenario: refund, weight: 30, input: () => ({ orderId: "o" }) },
      ],
      concurrency: 100,
      iterations: 1000,
    });
    const proj = projectLoadPlan(plan);
    expect(proj.concurrency).toBe(100);
    expect(proj.iterations).toBe(1000);
    expect(proj.durationMs).toBeUndefined();
    expect(proj.scenarios).toEqual([
      { scenarioRefId: "co", scenarioId: "checkout", weight: 70, steps: ["buy"] },
      { scenarioRefId: "rf", scenarioId: "refund", weight: 30, steps: ["refund"] },
    ]);
  });
});
