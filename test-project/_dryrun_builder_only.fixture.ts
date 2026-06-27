import { test } from "@glubean/sdk";

// Builder-only export (no duck-typed simple test) — dry-run should return an
// EMPTY (not errored) projection for this file. Named *.fixture.ts so scans
// skip it; the dry-run spawn test passes it explicitly.
export const flow = test("builder-flow").step("s1", async (ctx) => {
  ctx.assert(true, "ok");
});
