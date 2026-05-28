import { contract } from "@glubean/sdk";
import type { SchemaLike } from "@glubean/sdk";
import { http } from "../../../config/api.ts";

/**
 * Stable contract — guards the shape of the mock backend's
 * /api/stable/users endpoint. Always green; if the backend ever
 * changes this shape (drops/renames `users` or `total`), the contract
 * fails and the dashboard shows a contract violation.
 *
 * Reuses the shared client from config/api.ts — same backend as the
 * api-stable suite, configured once.
 */

const stableApi = contract.http.with("demo-stable", {
  client: http,
  security: null,
});

interface UsersResponse {
  users: Array<{ id: string; name: string; email: string }>;
  total: number;
}

// Hand-rolled SchemaLike so the demo project needs no zod dependency.
// Validates the documented shape, not just the status — a 200 that
// dropped `users`/`total` must still fail this contract.
const usersResponseSchema: SchemaLike<UsersResponse> = {
  safeParse(data: unknown) {
    const d = data as Partial<UsersResponse> | null;
    const issues: Array<{ message: string }> = [];
    if (!d || typeof d !== "object") {
      issues.push({ message: "response is not an object" });
    } else {
      if (!Array.isArray(d.users)) {
        issues.push({ message: "`users` is missing or not an array" });
      } else if (
        !d.users.every(
          (u) =>
            u &&
            typeof u.id === "string" &&
            typeof u.name === "string" &&
            typeof u.email === "string",
        )
      ) {
        issues.push({ message: "each user must have string id/name/email" });
      }
      if (typeof d.total !== "number") {
        issues.push({ message: "`total` is missing or not a number" });
      }
    }
    return issues.length === 0
      ? { success: true, data: data as UsersResponse }
      : { success: false, error: { issues } };
  },
};

// @contract
export const usersContract = stableApi("stable-users-shape", {
  endpoint: "GET /api/stable/users",
  feature: "Demo / Stable API",
  description: "The stable users endpoint keeps its documented shape",
  tags: ["stable", "public-demo"],
  cases: {
    ok: {
      description: "returns 200 with a users array and total count",
      expect: { status: 200, schema: usersResponseSchema },
    },
  },
});
