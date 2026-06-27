import { test } from "@glubean/sdk";

// Fixture for `glubean dry-run` integration — exercises ctx.when / ctx.switch /
// a bare if so the projected shapes and projectionComplete flags are visible.

export const login = test(
  {
    id: "login-when",
    description: "Authenticate and assert per-outcome shape via ctx.when.",
  },
  async (ctx) => {
    const res = await ctx.http.post("https://api.test/login");
    await ctx.when(
      res.status === 200,
      () => {
        ctx.assert(true, "has token");
        ctx.expect(res).toBeDefined();
      },
      () => ctx.assert(true, "unauthorized"),
    );
  },
);

export const order = test(
  { id: "order-switch", description: "Branch per status with ctx.switch." },
  async (ctx) => {
    const res = await ctx.http.get("https://api.test/orders/1");
    const status = res.status;
    await ctx.switch(
      [
        { when: status === 200, then: () => ctx.assert(true, "ok") },
        { when: status === 404, then: () => ctx.assert(true, "missing") },
      ],
      () => ctx.fail("unexpected"),
    );
  },
);

export const legacy = test(
  {
    id: "legacy-bare-if",
    description: "Uses a bare if — projection should flag it partial.",
    deprecated: "Use login-when instead.",
  },
  async (ctx) => {
    const res = await ctx.http.get("https://api.test/legacy");
    if (res.status === 200) {
      ctx.assert(true, "ok");
    } else {
      ctx.assert(true, "not ok");
    }
  },
);
