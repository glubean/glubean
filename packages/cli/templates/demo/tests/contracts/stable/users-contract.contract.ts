import { contract, configure } from "@glubean/sdk";
import type { SchemaLike } from "@glubean/sdk";

/**
 * Stable contract — guards the shape of the mock backend's
 * /api/stable/users endpoint. Always green; if the backend ever
 * changes this shape (drops/renames `users` or `total`), the contract
 * fails and the dashboard shows a contract violation.
 *
 * Uses {{MOCK_BACKEND_URL}} (resolved from env at run time) as the
 * prefix so it points at the same backend as the api-stable suite.
 */

const { http: api } = configure({
  http: { prefixUrl: "{{MOCK_BACKEND_URL}}" },
});

// NOTE: this contract intentionally does NOT send the X-Demo-Caller-Key
// header. `configure()` resolves `{{...}}` via resolveTemplate, which
// THROWS on a missing or empty value — and the scaffold explicitly
// allows an empty DEMO_BACKEND_CALLER_KEY (backends without a caller
// key configured). Templating the header would break `npm test` for
// those users. The contract therefore hits the backend's anonymous
// rate tier (10 req/min) — fine for normal run volume (a single run
// makes ~3-5 stable-endpoint calls). If you run this contract at high
// frequency from one IP and hit 429s, set a caller key on the backend
// AND switch this client to a verified flow (e.g. a bootstrap that
// reads ctx.secrets), rather than templating a possibly-empty value.

const stableApi = contract.http.with("demo-stable", {
  client: api,
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
