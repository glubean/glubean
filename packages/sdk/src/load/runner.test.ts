import { describe, expect, it } from "vitest";
import { loadMixEntry, loadRunner, loadScenario } from "./index.js";

// Definition-layer tests: no execution, no HTTP. Just verifies that loadRunner()
// resolves config into a LoadPlan and that .each() expands correctly.
describe("loadRunner", () => {
  const scenario = loadScenario<{ sku: string }>("checkout")
    .setup(async (ctx) => ({ sku: ctx.input.sku }))
    .step("buy", async (_c, s) => s);

  it("builds a single-scenario load plan", () => {
    const plan = loadRunner("checkout-300", {
      scenario,
      concurrency: 300,
      duration: "60s",
      rampUp: "10s",
      input: ({ producerSlot, iteration }) => ({ sku: `${producerSlot.id}-${iteration.id}` }),
      thresholds: { transaction: { errorRate: "<1%", p95: "<2000ms" } },
    });
    expect(plan.__glubean_type).toBe("load-runner");
    expect(plan.id).toBe("checkout-300");
    expect(plan.config.concurrency).toBe(300);
    expect("scenario" in plan.config).toBe(true);
  });

  it("accepts a static object input", () => {
    const plan = loadRunner("static", {
      scenario,
      concurrency: 10,
      iterations: 100,
      input: { sku: "FIXED" },
    });
    expect(plan.config.concurrency).toBe(10);
  });

  it("builds a traffic-mix plan with per-entry input", () => {
    const plan = loadRunner("mixed", {
      scenarios: [
        { id: "browse", scenario, weight: 70, input: () => ({ sku: "x" }) },
        { id: "checkout", scenario, weight: 30, input: () => ({ sku: "y" }) },
      ],
      concurrency: 100,
      duration: 60_000,
    });
    expect(plan.__glubean_type).toBe("load-runner");
    expect("scenarios" in plan.config).toBe(true);
  });

  it("each() expands into one plan per row with interpolated ids", () => {
    const plans = loadRunner.each([
      { plan: "free", p95: 1200 },
      { plan: "pro", p95: 800 },
    ])("checkout-$plan-load", (row) => ({
      scenario,
      concurrency: 300,
      duration: "60s",
      input: () => ({ sku: row.plan }),
      thresholds: { transaction: { p95: `<${row.p95}ms` } },
    }));
    expect(plans).toHaveLength(2);
    expect(plans.map((p) => p.id)).toEqual(["checkout-free-load", "checkout-pro-load"]);
    expect(plans[0].__glubean_type).toBe("load-runner");
  });

  it("each() preserves the producing row on the plan (for input({ row }))", () => {
    const plans = loadRunner.each([{ plan: "free" }, { plan: "pro" }])(
      "$plan",
      () => ({ scenario, concurrency: 1, iterations: 1, input: () => ({ sku: "x" }) }),
    );
    expect(plans[0].row).toEqual({ plan: "free" });
    expect(plans[1].row).toEqual({ plan: "pro" });
  });

  it("supports a heterogeneous typed traffic mix via loadMixEntry", () => {
    const refund = loadScenario<{ orderId: string }>("refund")
      .setup(async (ctx) => ({ orderId: ctx.input.orderId }))
      .step("refund", async (_c, s) => s);

    // Each entry binds its own scenario↔input Input via loadMixEntry().
    const plan = loadRunner("mixed-typed", {
      scenarios: [
        loadMixEntry({ id: "checkout", scenario, weight: 70, input: () => ({ sku: "s" }) }),
        loadMixEntry({ id: "refund", scenario: refund, weight: 30, input: () => ({ orderId: "o" }) }),
      ],
      concurrency: 50,
      duration: "30s",
    });
    expect("scenarios" in plan.config).toBe(true);
  });

  it("each() factory exposes typed, row-aware input args (not implicit any)", () => {
    const plans = loadRunner.each([{ plan: "free" }])("$plan", () => ({
      scenario,
      concurrency: 1,
      iterations: 1,
      // `args` is typed LoadInputArgs — destructuring must not be implicit any.
      input: (args) => ({ sku: `${args.producerSlot.id}-${args.iteration.id}` }),
    }));
    expect(plans[0].id).toBe("free");
  });

  it("each() interpolates overlapping field names without corruption", () => {
    const plans = loadRunner.each([{ plan: "free", planId: "p-123" }])(
      "$plan-$planId",
      () => ({ scenario, concurrency: 1, iterations: 1, input: () => ({ sku: "x" }) }),
    );
    expect(plans[0].id).toBe("free-p-123");
  });

  it("each() leaves an unknown placeholder intact (no prefix corruption)", () => {
    const plans = loadRunner.each([{ plan: "free" }])(
      "checkout-$planId", // row has no `planId` — must NOT become "checkout-freeId"
      () => ({ scenario, concurrency: 1, iterations: 1, input: () => ({ sku: "x" }) }),
    );
    expect(plans[0].id).toBe("checkout-$planId");
  });

  it("each() input args expose the typed producing row", () => {
    const plans = loadRunner.each([{ plan: "free" }, { plan: "pro" }])("$plan", () => ({
      scenario,
      concurrency: 1,
      iterations: 1,
      // `row` is typed `{ plan: string }` and present — `row.plan` must compile.
      input: ({ row }) => ({ sku: row.plan }),
    }));
    expect(plans).toHaveLength(2);
  });

  it("each() can expand into traffic-mix plans", () => {
    const plans = loadRunner.each([{ region: "us" }, { region: "eu" }])("mix-$region", () => ({
      scenarios: [
        loadMixEntry({ id: "checkout", scenario, weight: 100, input: () => ({ sku: "s" }) }),
      ],
      concurrency: 50,
      duration: "30s",
    }));
    expect(plans.map((p) => p.id)).toEqual(["mix-us", "mix-eu"]);
    expect("scenarios" in plans[0].config).toBe(true);
  });

  it("each() accepts interface-typed rows (not just index-signature objects)", () => {
    interface PlanRow {
      plan: string;
    }
    const rows: PlanRow[] = [{ plan: "free" }, { plan: "pro" }];
    const plans = loadRunner.each(rows)("$plan", (row) => ({
      scenario,
      concurrency: 1,
      iterations: 1,
      input: () => ({ sku: row.plan }),
    }));
    expect(plans.map((p) => p.id)).toEqual(["free", "pro"]);
  });
});
