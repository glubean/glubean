import { helperApi } from "./_dryrun_alias_helper.fixture.js";

// Uses an alias IMPORTED from a helper not passed to dryRunFiles. Has a bare
// `if`, so its projection must be flagged partial — only possible if the alias
// was collected project-wide.
export const usesAlias = helperApi("uses-alias", async (ctx) => {
  const res = await ctx.http.get("/x");
  if (res.status === 200) ctx.assert(true, "ok");
  else ctx.assert(true, "no");
});
