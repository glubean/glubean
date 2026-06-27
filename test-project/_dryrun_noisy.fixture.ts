import { test } from "@glubean/sdk";

// Writes to stdout WITHOUT a trailing newline at import time, so the worker's
// sentinel record lands mid-line. dryRunFiles must still parse it. Named
// *.fixture.ts so scans skip it.
process.stdout.write("noise-without-trailing-newline");

export const noisy = test("noisy", async (ctx) => {
  ctx.assert(true, "ok");
});
