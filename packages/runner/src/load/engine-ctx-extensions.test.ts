import { describe, expect, it } from "vitest";
import { createEngineCore } from "../engine-bridge.js";

// Verifies the generic engine ctxExtensions hook (the load runner's mechanism
// for surfacing input / report / producerSlot / iteration on ctx). Pure
// in-process — no HTTP.
describe("engine ctxExtensions (load support)", () => {
  it("surfaces host ctx extensions (e.g. ctx.input) on the per-run ctx", async () => {
    const core = createEngineCore(() => {}, { vars: {}, secrets: {} });
    let seenInput: unknown;
    let seenSlot: unknown;
    const def = {
      meta: { id: "t" },
      type: "steps" as const,
      steps: [
        {
          meta: { name: "s" },
          fn: async (ctx: Record<string, unknown>) => {
            seenInput = ctx.input;
            seenSlot = ctx.producerSlot;
          },
        },
      ],
    };
    const res = await core.run(def as never, {
      ctxExtensions: { input: { sku: "X" }, producerSlot: { id: "p0", index: 0 } },
    });
    expect(res.status).toBe("ok");
    expect(seenInput).toEqual({ sku: "X" });
    expect(seenSlot).toEqual({ id: "p0", index: 0 });
  });

  it("never overrides a built-in ctx member", async () => {
    const core = createEngineCore(() => {}, { vars: {}, secrets: {} });
    let httpType = "";
    const def = {
      meta: { id: "t2" },
      type: "steps" as const,
      steps: [
        {
          meta: { name: "s" },
          fn: async (ctx: Record<string, unknown>) => {
            httpType = typeof ctx.http;
          },
        },
      ],
    };
    // Attempt to clobber the built-in `http` — must be ignored.
    await core.run(def as never, { ctxExtensions: { http: 123 } });
    expect(httpType).toBe("function"); // ky proxy preserved, not the number 123
  });

  it("is a no-op when ctxExtensions is absent", async () => {
    const core = createEngineCore(() => {}, { vars: {}, secrets: {} });
    let seen: unknown = "unset";
    const def = {
      meta: { id: "t3" },
      type: "steps" as const,
      steps: [
        {
          meta: { name: "s" },
          fn: async (ctx: Record<string, unknown>) => {
            seen = ctx.input;
          },
        },
      ],
    };
    const res = await core.run(def as never, {});
    expect(res.status).toBe("ok");
    expect(seen).toBeUndefined();
  });
});
