/**
 * Multi-step auth flow — login, use token, get profile.
 *
 * This demonstrates the builder API: each step passes state to the next.
 * The trace viewer shows all three requests as a connected flow, not
 * isolated calls. That's the difference between Glubean and a REST client.
 *
 * Run: deno task explore
 */
import { test } from "@glubean/sdk";

export const authFlow = test("auth-flow")
  .meta({ name: "Auth Flow", tags: ["explore", "auth"] })
  .step("login", async (ctx) => {
    const baseUrl = ctx.vars.require("BASE_URL");
    const username = ctx.secrets.require("USERNAME");
    const password = ctx.secrets.require("PASSWORD");

    const data = await ctx.http
      .post(`${baseUrl}/auth/login`, {
        json: { username, password, expiresInMins: 1 },
      })
      .json<{ accessToken: string; refreshToken: string; username: string }>();

    ctx.expect(data.accessToken).toBeDefined().orFail();
    ctx.expect(data.username).toBe(username);

    ctx.log(`Logged in as ${data.username}`);

    return { token: data.accessToken };
  })
  .step("get profile", async (ctx, state) => {
    const baseUrl = ctx.vars.require("BASE_URL");

    const data = await ctx.http
      .get(`${baseUrl}/auth/me`, {
        headers: { Authorization: `Bearer ${state.token}` },
      })
      .json<{ email: string; firstName: string; lastName: string }>();

    ctx.expect(data.email).toBeDefined();
    ctx.expect(data.firstName).toBeDefined();

    ctx.log(`Profile: ${data.firstName} ${data.lastName} (${data.email})`);
  });
