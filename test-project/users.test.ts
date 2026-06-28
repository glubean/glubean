import { test } from "@glubean/sdk";

/**
 * Test that exercises the SAME endpoint the users contract documents (GET /users),
 * so the endpoint-centric Specs view groups this test, the contract, and the
 * onboard workflow under one entry — and a reviewer sees /users is fully covered
 * (contracted + tested + used in a flow). Endpoints with only a test (e.g. /login)
 * show up as coverage gaps.
 */
export const usersList = test(
  {
    id: "users-list",
    description: "The user-list endpoint returns the documented shape and a numeric total.",
    tags: ["api", "users"],
  },
  async (ctx) => {
    const res = await ctx.http.get("https://api.test/users").track("GET /users");
    ctx.expect(res.status).toBe(200, "responds 200 with the user list");
    const body = await res.json();
    ctx.assert(Array.isArray(body.users), "the body has a `users` array, never null");
    ctx.assert(typeof body.total === "number", "the body reports a numeric total count");

    // A concrete id in the URL collapses onto the canonical endpoint via .track —
    // so /users/42 doesn't fragment the coverage index away from the contract.
    const one = await ctx.http.get(`https://api.test/users/${body.users?.[0]?.id ?? 42}`).track("GET /users/:id");
    ctx.assert(one.status === 200, "fetching a known user returns 200 with its record");
  },
);
