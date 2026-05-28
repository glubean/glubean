import { test } from "@glubean/sdk";
import { http } from "../../config/api.ts";

/**
 * Stable suite — hits the mock backend's deterministic /api/stable
 * endpoints. Always passes; the "everything's working" baseline.
 * Uses the shared client from config/api.ts (auto-traced).
 */

export const listUsers = test(
  { id: "stable-list-users", tags: ["stable", "public-demo"] },
  async ({ expect }) => {
    const res = await http.get("api/stable/users");
    expect(res).toHaveStatus(200);
    const body = await res.json<{ users: unknown[]; total: number }>();
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.total).toBe(3);
  },
);

export const getOneUser = test(
  { id: "stable-get-user", tags: ["stable", "public-demo"] },
  async ({ expect }) => {
    const res = await http.get("api/stable/users/u_001");
    expect(res).toHaveStatus(200);
    const body = await res.json<{ id: string; name: string; email: string }>();
    expect(body.id).toBe("u_001");
    expect(body.email).toContain("@");
  },
);
