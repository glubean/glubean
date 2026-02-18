/**
 * Quick API exploration — your scratchpad for poking at endpoints.
 *
 * This file lives in explore/ — it's for interactive development, not CI.
 * Try things here, then move polished tests to tests/ when ready.
 *
 * Run: deno task explore
 */
import { test } from "@glubean/sdk";

// ---------------------------------------------------------------------------
// Quick endpoint check — edit the URL and run
// ---------------------------------------------------------------------------

export const quickCheck = test(
  { id: "quick-check", name: "Quick Endpoint Check", tags: ["explore"] },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");

    const res = await ctx.http.get(`${baseUrl}/products/1`);
    const data = await res.json();

    ctx.expect(res.status).toBe(200);
    ctx.log("Response", data);
  },
);

// ---------------------------------------------------------------------------
// Try a POST — uncomment and tweak
// ---------------------------------------------------------------------------

// export const tryPost = test(
//   { id: "try-post", name: "Try POST Request", tags: ["explore"] },
//   async (ctx) => {
//     const baseUrl = ctx.vars.require("BASE_URL");
//
//     const res = await ctx.http.post(`${baseUrl}/products/add`, {
//       json: { title: "Test Product", price: 9.99 },
//     });
//     const data = await res.json();
//
//     ctx.log("Created", data);
//   }
// );
