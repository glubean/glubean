import { describe, it, expect } from "vitest";

import { createAlsCarrier } from "@glubean/sdk/internal";

import { RunnerCore } from "../engine.js";
import type { RunnerServices, TestDef } from "../types.js";

function services(fetchImpl?: RunnerServices["fetch"]): RunnerServices {
  return {
    fetch:
      fetchImpl ??
      (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
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

  it("stops subsequent steps after a soft assertion failure; teardown still runs (codex engine P2)", async () => {
    const ran: string[] = [];
    let toreDown = false;
    const def: TestDef = {
      meta: { id: "t" },
      type: "steps",
      steps: [
        {
          meta: { name: "s1" },
          fn: (c) => {
            ran.push("s1");
            (c.expect(1) as { toBe(v: number): void }).toBe(2); // soft failure, no throw
          },
        },
        { meta: { name: "s2" }, fn: () => void ran.push("s2") },
      ],
      teardown: () => {
        toreDown = true;
      },
    };
    const r = await new RunnerCore(services()).run(def);
    expect(r.status).toBe("error");
    expect(ran).toEqual(["s1"]); // s2 skipped after s1's soft failure
    expect(toreDown).toBe(true);
  });

  it("does not retry by default (node parity: retry 0) (codex engine P2)", async () => {
    let calls = 0;
    const svc = services(async () => {
      calls += 1;
      throw new TypeError("netfail");
    });
    const def: TestDef = {
      meta: { id: "t" },
      type: "simple",
      fn: async (c) => {
        await c.http.get("https://x.test/a");
      },
    };
    const r = await new RunnerCore(svc).run(def);
    expect(r.status).toBe("error");
    expect(calls).toBe(1); // ky did not retry the failed GET
  });

  it("extend(callback) maps prefixUrl in the function form too (codex engine P2)", async () => {
    let seenUrl = "";
    const svc = services(async (input) => {
      seenUrl = typeof input === "object" && "url" in input ? (input as Request).url : String(input);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const def: TestDef = {
      meta: { id: "t" },
      type: "simple",
      fn: async (c) => {
        const api = c.http.extend(() => ({ prefixUrl: "https://base.test/p" }));
        await api.get("x");
      },
    };
    const r = await new RunnerCore(svc).run(def);
    expect(r.status).toBe("ok");
    expect(seenUrl).toBe("https://base.test/p/x");
  });
});
