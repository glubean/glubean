import { describe, expect, it } from "vitest";
import { isLoadBranchStep, isLoadPollStep, loadScenario } from "./index.js";

// Pure definition-layer tests: step fns are never executed, so there is no HTTP
// here. Execution-layer tests (orchestrator/sink/reducer) use an in-process mock
// server in later milestones.
describe("loadScenario builder", () => {
  it("builds a scenario with meta / setup / steps / teardown", () => {
    const scenario = loadScenario<{ sku: string }>("checkout")
      .meta({ description: "checkout transaction" })
      .setup(async (ctx) => ({ sku: ctx.input.sku }))
      .step("a", async (_ctx, state) => ({ ...state, token: "t" }))
      .step("b", async () => {
        // void return preserves the previous state
      })
      .teardown(async () => {})
      .build();

    expect(scenario.__glubean_type).toBe("load-scenario");
    expect(scenario.meta.id).toBe("checkout");
    expect(scenario.meta.description).toBe("checkout transaction");
    expect(scenario.steps.map((s) => s.meta.name)).toEqual(["a", "b"]);
    expect(scenario.setup).toBeDefined();
    expect(scenario.teardown).toBeDefined();
  });

  it("is a builder handle, not a registered runnable", () => {
    const b = loadScenario("x").step("s", async () => {});
    expect(b.__glubean_type).toBe("load-scenario-builder");
  });

  it("carries the step-level assertion policy in meta", () => {
    const scenario = loadScenario("x")
      .step("guarded", { assertions: { onFailure: "abortIteration" } }, async () => {})
      .build();
    expect(scenario.steps[0].meta.assertions?.onFailure).toBe("abortIteration");
  });

  it("tags grouped steps with the group id", () => {
    const scenario = loadScenario("x")
      .group("auth", (b) =>
        b.step("login", async () => ({ token: "t" })).step("verify", async (_c, s) => s),
      )
      .build();
    expect(scenario.steps.map((s) => s.meta.name)).toEqual(["login", "verify"]);
    expect(scenario.steps.every((s) => s.meta.group === "auth")).toBe(true);
  });

  it("desugars condition into a predicate branch step", () => {
    const scenario = loadScenario("x")
      .setup(async () => ({ n: 1 }))
      .condition(
        { predicate: (_c, s) => s.n > 0 },
        (b) => b.step("then", async (_c, s) => s),
        (b) => b.step("else", async (_c, s) => s),
      )
      .build();

    const step = scenario.steps[0];
    expect(isLoadBranchStep(step)).toBe(true);
    if (isLoadBranchStep(step)) {
      expect(step.branch.mode).toBe("predicate");
      expect(step.branch.cases[0].steps[0].meta.name).toBe("then");
      expect(step.branch.default[0].meta.name).toBe("else");
    }
  });

  it("desugars switchOn into a value branch step", () => {
    const scenario = loadScenario("x")
      .setup(async () => ({ kind: "a" as string }))
      .switchOn((_c, s) => s.kind)(
        [{ value: "a", then: (b) => b.step("handle-a", async (_c, s) => s) }],
        (b) => b.step("default", async (_c, s) => s),
      )
      .build();

    const step = scenario.steps[0];
    expect(isLoadBranchStep(step)).toBe(true);
    if (isLoadBranchStep(step)) expect(step.branch.mode).toBe("value");
  });

  it("desugars poll into a poll step", () => {
    const scenario = loadScenario("x")
      .poll("wait", async () => ({ done: true }), {
        until: (_c, res) => res.done,
        timeout: 5000,
        every: 100,
      })
      .build();
    expect(isLoadPollStep(scenario.steps[0])).toBe(true);
  });

  it("rejects a poll without any stop bound", () => {
    expect(() =>
      loadScenario("x").poll("wait", async () => ({ done: true }), {
        until: (_c, res) => res.done,
      } as never),
    ).toThrow();
  });

  it("branch/poll stub fn surfaces a version-skew error if the runner calls it directly", async () => {
    const scenario = loadScenario("x")
      .condition({ predicate: () => true }, (b) => b.step("t", async (_c, s) => s))
      .build();
    await expect(
      (scenario.steps[0].fn as (c: unknown, s: unknown) => Promise<unknown>)({}, undefined),
    ).rejects.toThrow(/requires a @glubean\/runner/);
  });
});
