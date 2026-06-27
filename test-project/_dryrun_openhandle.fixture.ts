import { test } from "@glubean/sdk";

// Leaves an open handle (interval) at import time. Without an explicit
// process.exit after projection, the worker would stay alive until the parent
// watchdog kills it. Named *.fixture.ts so scans skip it.
setInterval(() => {}, 100_000);

export const held = test("open-handle", async (ctx) => {
  ctx.assert(true, "ok");
});
