import { test } from "@glubean/sdk";
import { mockGet } from "../../demo/lib/mock-backend-client.js";

/**
 * Stable suite — hits the mock backend's deterministic /api/stable
 * endpoints. These should always pass; they're the "everything's
 * working" baseline in the public dashboard narrative.
 */

export const listUsers = test(
  { id: "stable-list-users", tags: ["stable", "public-demo"] },
  async (ctx) => {
    const res = await mockGet<{ users: unknown[]; total: number }>(
      ctx,
      "/api/stable/users",
    );
    ctx.assert(res.status === 200, "GET /api/stable/users returns 200");
    ctx.assert(Array.isArray(res.body.users), "response has users array");
    ctx.assert(res.body.total === 3, "response reports 3 users");
  },
);

export const getOneUser = test(
  { id: "stable-get-user", tags: ["stable", "public-demo"] },
  async (ctx) => {
    const res = await mockGet<{ id: string; name: string; email: string }>(
      ctx,
      "/api/stable/users/u_001",
    );
    ctx.assert(res.status === 200, "GET /api/stable/users/u_001 returns 200");
    ctx.assert(res.body.id === "u_001", "returns the requested user id");
    ctx.assert(
      typeof res.body.email === "string" && res.body.email.includes("@"),
      "user has an email",
    );
  },
);
