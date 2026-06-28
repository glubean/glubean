import { test } from "@glubean/sdk";

// Fixture for `glubean dry-run` / `glubean sync`. Exercises ctx.when / ctx.switch
// / ctx.while / a bare if so the projected shapes + projectionComplete flags are
// visible — AND models the review surface: the test DESCRIPTION (headline intent)
// plus each assertion MESSAGE state the design a reviewer reads WITHOUT running
// anything. `ctx.expect(...).matcher(expected, "message")` is preferred over a
// bare `assert` because the matcher itself carries semantic shape (see GLUBEAN.md).

export const login = test(
  {
    id: "login-when",
    description:
      "Authenticate; verify the session contract on success and the rejection contract on failure.",
    tags: ["auth", "smoke"],
  },
  async (ctx) => {
    const res = await ctx.http.post("https://api.test/login");
    await ctx.when(
      res.status === 200,
      () => {
        ctx.expect(res.status).toBe(200, "the success response is 200 OK");
        ctx.assert(true, "a valid session token is returned in the body");
      },
      () => ctx.assert(true, "invalid credentials are rejected with 401 and no token"),
      "credentials are valid",
    );
  },
);

export const pages = test(
  {
    id: "paginate-while",
    description: "Walk every page and check the collection contract holds across the whole set.",
    tags: ["pagination"],
  },
  async (ctx) => {
    let more = true;
    await ctx.while(
      () => more,
      async () => {
        const res = await ctx.http.get("https://api.test/items");
        const body = await res.json();
        ctx.expect(Array.isArray(body.items)).toBe(true, "every page returns an `items` array, never null");
        more = body.hasMore;
      },
      "there are more pages",
    );
  },
);

export const order = test(
  {
    id: "order-switch",
    description:
      "Branch on order status so each documented outcome is verified and the undocumented one fails loudly.",
    tags: ["orders"],
  },
  async (ctx) => {
    const res = await ctx.http.get("https://api.test/orders/1");
    const status = res.status;
    await ctx.switch(
      [
        {
          when: () => status === 200,
          then: () => ctx.expect(res.status).toBe(200, "an existing order returns 200 with its full details"),
        },
        {
          when: () => status === 404,
          then: () => ctx.expect(res.status).toBe(404, "a missing order returns 404, not a 500"),
        },
      ],
      () => ctx.fail("any other status is an unhandled contract violation"),
    );
  },
);

export const legacy = test(
  {
    id: "legacy-bare-if",
    description: "Legacy endpoint kept for back-compat — uses a bare if, so the projection is flagged partial.",
    deprecated: "Use login-when instead.",
    tags: ["legacy"],
  },
  async (ctx) => {
    const res = await ctx.http.get("https://api.test/legacy");
    if (res.status === 200) {
      ctx.assert(true, "known ids still resolve on the legacy path");
    } else {
      ctx.assert(true, "unknown ids degrade gracefully instead of erroring");
    }
  },
);

// Data-driven export — `test.each` yields an array of simple Tests, each with its
// own bound row data; dry-run projects every generated row.
export const byRegion = test.each([
  { region: "us", base: "https://us.api.test" },
  { region: "eu", base: "https://eu.api.test" },
])(
  {
    id: "region-$region",
    description: "Each region's health endpoint is reachable and reports healthy.",
    tags: ["health", "multi-region"],
    // Per-row tag (region:us / region:eu) — resolved at runtime, must survive sync.
    tagFields: "region",
  },
  async (ctx, row) => {
    const res = await ctx.http.get(`${row.base}/health`);
    ctx.expect(res.status).toBe(200, "the region's health endpoint responds 200 OK");
  },
);
