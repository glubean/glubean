/**
 * Quick API exploration — GET and POST examples ready to run.
 *
 * Edit the URLs, change the payload, hit play. Every request is
 * auto-traced so you can inspect headers, timing, and response
 * bodies in the trace viewer.
 *
 * Run: deno task explore
 */
import { test } from "@glubean/sdk";

export const getProduct = test(
  { id: "get-product", name: "GET Product", tags: ["explore"] },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");

    const res = await ctx.http.get(`${baseUrl}/products/1`);
    const data = await res.json();

    ctx.expect(res.status).toBe(200);
    ctx.expect(data.title).toBeDefined();

    ctx.log("Product", data);
  },
);

export const createProduct = test(
  { id: "create-product", name: "POST Create Product", tags: ["explore"] },
  async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");

    const res = await ctx.http.post(`${baseUrl}/products/add`, {
      json: { title: "Test Product", price: 9.99, category: "test" },
    });
    const data = await res.json();

    ctx.expect(res.status).toBe(200);
    ctx.expect(data.id).toBeDefined();

    ctx.log("Created", data);
  },
);
