import { describe, it, expect } from "vitest";

import { test, workflow } from "@glubean/sdk";
import { createAlsCarrier } from "@glubean/sdk/internal";

import { RunnerCore } from "../engine.js";
import type { ExecutionEvent, RunnerServices } from "../types.js";

// engine.resolve maps real SDK module exports → runnable TestDefs, and the engine
// runs those real SDK tests through the narrow ctx (Stage 1 ① node golden: simple
// / builder / each + assertion-fail + http trace).

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

describe("engine.resolve — runtime expansion of SDK module exports", () => {
  it("resolves simple, builder, and test.each exports (each row → its own def)", () => {
    const ns = {
      simple: test("simple-id", async () => {}),
      built: test("built-id").step("s", async () => {}),
      rows: test.each([{ name: "one" }, { name: "two" }])("$name", async () => {}),
    };
    const defs = new RunnerCore(services()).resolve(ns);
    expect(defs.map((d) => d.meta.id).sort()).toEqual(["built-id", "one", "simple-id", "two"]);
    expect(defs.find((d) => d.meta.id === "simple-id")?.type).toBe("simple");
    expect(defs.find((d) => d.meta.id === "built-id")?.type).toBe("steps");
  });

  it("runs a resolved real SDK test through the engine: assertions + http trace", async () => {
    const events: ExecutionEvent[] = [];
    const svc = services(async (input) => {
      const url = typeof input === "object" && "url" in input ? (input as Request).url : String(input);
      return new Response(JSON.stringify({ url }), { status: 200, headers: { "content-type": "application/json" } });
    });
    svc.events = { emit: (e) => events.push(e) };
    const ns = {
      t: test("golden", async (ctx) => {
        const r = (await ctx.http.get("https://api.test/ping").json()) as { url: string };
        ctx.expect(r.url).toBe("https://api.test/ping");
        ctx.assert(true, "ok guard");
      }),
    };
    const engine = new RunnerCore(svc);
    const [def] = engine.resolve(ns);
    const res = await engine.run(def!);
    expect(res.status).toBe("ok");
    expect(res.assertions).toEqual({ total: 2, passed: 2 });
    const traces = events.filter((e): e is Extract<ExecutionEvent, { type: "trace" }> => e.type === "trace");
    // Rich Trace shape (Phase 4f): HTTP fields under `data`.
    expect(traces.map((e) => ({ id: e.id, url: e.data.url, status: e.data.status }))).toEqual([
      { id: "golden", url: "https://api.test/ping", status: 200 },
    ]);
  });

  it("carries skip metadata and never executes a skipped test (codex B4 P2)", async () => {
    let ran = false;
    const ns = {
      skipped: test.skip("skip-me", async () => {
        ran = true;
      }),
    };
    const engine = new RunnerCore(services());
    const [def] = engine.resolve(ns);
    expect(def!.meta.skip).toBe(true);
    const res = await engine.run(def!);
    expect(res.status).toBe("skipped");
    expect(ran).toBe(false); // no execution, no side effects
  });

  it("does NOT resolve workflow builders or built workflow handles (Stage 2) (codex B4 P2)", () => {
    // A built workflow is an array tagged __glubean_type "workflow" holding a
    // wrapper Test (SDK builder.ts dual shape). Neither the unbuilt builder nor
    // the built handle should become a runnable def in the narrow engine.
    const builtWorkflowHandle = Object.assign([{ meta: { id: "wf-built" }, type: "simple", fn: async () => {} }], {
      __glubean_type: "workflow" as const,
    });
    const ns = {
      ok: test("ok", async () => {}),
      wfBuilder: workflow("wf-builder"), // unbuilt workflow-builder
      wfBuilt: builtWorkflowHandle, // already-built workflow handle
    };
    const defs = new RunnerCore(services()).resolve(ns);
    expect(defs.map((d) => d.meta.id)).toEqual(["ok"]);
  });

  it("does NOT resolve test.extend() tests with fixtures (Stage 2) (codex B4 P2)", () => {
    // SDK extended tests carry a non-empty `fixtures` map; the narrow engine has
    // no fixture resolution, so they must be excluded, not run without fixtures.
    const extended = { meta: { id: "ext" }, type: "simple", fn: async () => {}, fixtures: { token: async () => {} } };
    const defs = new RunnerCore(services()).resolve({ ok: test("ok", async () => {}), ext: extended });
    expect(defs.map((d) => d.meta.id)).toEqual(["ok"]);
  });

  it("each rows run with their row data; a wrong row fails in isolation", async () => {
    const ns = {
      rows: test.each([
        { name: "good", a: 1, b: 2, sum: 3 },
        { name: "bad", a: 1, b: 1, sum: 3 },
      ])("$name", async (ctx, row) => {
        ctx.expect(row.a + row.b).toBe(row.sum);
      }),
    };
    const engine = new RunnerCore(services());
    const results = await Promise.all(engine.resolve(ns).map((d) => engine.run(d)));
    expect(Object.fromEntries(results.map((r) => [r.id, r.status]))).toEqual({ good: "ok", bad: "error" });
  });
});
