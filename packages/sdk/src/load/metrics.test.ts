import { describe, expect, it } from "vitest";
import { counter, loadRunner, loadScenario, rate, trend, type LoadContext } from "./index.js";

// Definition-layer tests for A1: the custom-metric factories produce static
// descriptors and `loadRunner({ metrics })` carries them. The fold lives in the
// reducer (A2) and is not exercised here.
describe("custom metric factories", () => {
  it("rate() declares a boolean-ratio metric", () => {
    expect(rate()).toEqual({ kind: "rate" });
  });

  it("counter() declares a summed-counter metric", () => {
    expect(counter()).toEqual({ kind: "counter" });
  });

  it("trend() declares a distribution metric, with an optional unit", () => {
    expect(trend()).toEqual({ kind: "trend" });
    expect(trend({ unit: "ms" })).toEqual({ kind: "trend", unit: "ms" });
  });

  it("are carried onto the resolved load plan config", () => {
    const scenario = loadScenario("create-poll").step("poll", async (_c, s) => s);
    const plan = loadRunner("stress", {
      scenario,
      concurrency: 10,
      iterations: 100,
      metrics: { pollOk: rate(), e2eLatency: trend({ unit: "ms" }), retries: counter() },
      thresholds: {
        customMetric: {
          pollOk: { rate: ">99%" },
          "pollOk:class=extreme": { rate: ">90%" },
        },
      },
    });
    expect(plan.config.metrics?.pollOk.kind).toBe("rate");
    expect(plan.config.metrics?.e2eLatency).toEqual({ kind: "trend", unit: "ms" });
    expect(plan.config.thresholds?.customMetric?.["pollOk:class=extreme"]).toEqual({
      rate: ">90%",
    });
  });
});

describe("custom metric handle typing", () => {
  it("exposes a permissively-typed `ctx.metrics` usable in a normal scenario step", () => {
    // A scenario is authored without the runner's declarations in scope, so
    // `ctx.metrics.<anyId>` must type-check with either a boolean or a number — and
    // this must work in the SAME callback shape the builder/scenario API expects
    // (no per-key annotation, which can't be threaded to a built scenario closure).
    loadScenario<{ x: number }>("metrics-in-step").step("fold", async (ctx) => {
      ctx.metrics.pollOk.add(true, { class: "extreme" });
      ctx.metrics.retries.add(); // counter default
      ctx.metrics.e2e.add(120);
    });
    const useCtx = (ctx: LoadContext<{ x: number }>) => ctx.metrics.anything.add(true);
    expect(useCtx).toBeTypeOf("function");
  });
});
