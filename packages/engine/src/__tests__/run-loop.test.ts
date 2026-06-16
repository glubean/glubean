import { describe, it, expect } from "vitest";

import { createAlsCarrier } from "@glubean/sdk/internal";

import { RunnerCore } from "../engine.js";
import type { RunnerServices, TestDef } from "../types.js";

function services(): RunnerServices {
  return {
    fetch: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    env: { vars: () => ({}), secrets: () => ({}) },
    events: { emit: () => {} },
    scheduler: { now: () => 0 },
    carrier: createAlsCarrier(),
  };
}

// Narrow run-loop behavior (Stage 1 scope: simple + linear steps). The teardown
// case locks codex Decision-B P2 (teardown must run even on failure).
describe("engine run-loop — narrow behavior", () => {
  it("steps: setup → steps (state threads) → teardown, in order", async () => {
    const order: string[] = [];
    const def: TestDef = {
      meta: { id: "t" },
      type: "steps",
      setup: () => {
        order.push("setup");
        return { n: 1 };
      },
      steps: [
        {
          meta: { name: "s1" },
          fn: (_c, s) => {
            order.push("s1");
            return { n: (s as { n: number }).n + 1 };
          },
        },
        {
          meta: { name: "s2" },
          fn: (c, s) => {
            order.push("s2");
            (c.expect((s as { n: number }).n) as { toBe(v: number): void }).toBe(2);
          },
        },
      ],
      teardown: () => {
        order.push("teardown");
      },
    };
    const r = await new RunnerCore(services()).run(def);
    expect(order).toEqual(["setup", "s1", "s2", "teardown"]);
    expect(r.status).toBe("ok");
    expect(r.assertions).toEqual({ total: 1, passed: 1 });
  });

  it("teardown runs even when a step throws (codex Decision-B P2)", async () => {
    let toreDown = false;
    const def: TestDef = {
      meta: { id: "t" },
      type: "steps",
      steps: [
        {
          meta: { name: "boom" },
          fn: () => {
            throw new Error("boom");
          },
        },
      ],
      teardown: () => {
        toreDown = true;
      },
    };
    const r = await new RunnerCore(services()).run(def);
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/boom/);
    expect(toreDown).toBe(true);
  });

  it("teardown runs even when setup throws", async () => {
    let toreDown = false;
    const def: TestDef = {
      meta: { id: "t" },
      type: "steps",
      setup: () => {
        throw new Error("setup-failed");
      },
      steps: [{ meta: { name: "never" }, fn: () => undefined }],
      teardown: () => {
        toreDown = true;
      },
    };
    const r = await new RunnerCore(services()).run(def);
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/setup-failed/);
    expect(toreDown).toBe(true);
  });

  it("simple: a failed assertion makes the run error", async () => {
    const def: TestDef = {
      meta: { id: "t" },
      type: "simple",
      fn: (c) => {
        (c.expect(1) as { toBe(v: number): void }).toBe(2);
      },
    };
    const r = await new RunnerCore(services()).run(def);
    expect(r.status).toBe("error");
    expect(r.assertions).toEqual({ total: 1, passed: 0 });
  });
});
