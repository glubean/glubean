import { test } from "@glubean/sdk";

// Fixture: a test that bypasses ctx.http and calls the global fetch() directly.
// Under dry-run the worker patches globalThis.fetch, so this must NOT hit the
// network and the call should still be captured. Named *.fixture.ts so scans
// skip it; the dry-run spawn test passes it explicitly.
export const raw = test("raw-fetch", async (ctx) => {
  const res = await fetch("https://api.test/raw");
  await res.json();
  ctx.assert(true, "fetched");
});
