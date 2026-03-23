import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildRunContext } from "./run_context.js";

describe("buildRunContext", () => {
  it("returns stable runtime fields for result context", () => {
    const ctx = buildRunContext();
    const runnerPkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf-8"),
    ) as { version: string };

    expect(ctx.timestamp).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(ctx.timestamp))).toBe(false);
    expect(ctx.nodeVersion).toBe(process.version);
    expect(ctx.runnerVersion).toBe(runnerPkg.version);
    expect(ctx.platform).toBe(process.platform);
    expect(ctx.arch).toBe(process.arch);
    expect(ctx.sdkVersion).toEqual(expect.any(String));
    expect(ctx.sdkVersion.length).toBeGreaterThan(0);
  });
});
