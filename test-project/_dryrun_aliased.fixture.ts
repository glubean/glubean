import { test } from "@glubean/sdk";

// Aliased test.extend — `api` does NOT match the *Test naming convention, so the
// scanner only recognizes `api(...)` as a test when extend aliases are passed.
// The body has a bare `if`, so its projection must be flagged partial — which
// only happens if the worker forwards aliases to extractFromSource. Named
// *.fixture.ts so scans skip it; the spawn test passes it explicitly.
const api = test.extend({ token: (_ctx) => "t" });

export const aliased = api("aliased-bare", async (ctx) => {
  const res = await ctx.http.get("/x");
  if (res.status === 200) ctx.assert(true, "ok");
  else ctx.assert(true, "no");
});
