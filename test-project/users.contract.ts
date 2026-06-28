import { contract, configure } from "@glubean/sdk";

const api = configure({ prefixUrl: "https://api.test" });

// A scoped contract factory (contract.http.with → instance), per the SDK: the
// bare contract.http("id", spec) form is not supported at runtime.
const usersApi = contract.http.with("users-api", { client: api });

interface User {
  id: string;
  name: string;
  email: string;
}
interface UsersResponse {
  users: User[];
  total: number;
}

// Hand-rolled SchemaLike (no zod dep) that ALSO exposes `toJSONSchema()` — the
// scanner projects that into the case's response SHAPE, so reviewers see the
// documented contract (field names + types), not just the status. `safeParse` is
// minimal (this fixture is only projected, never run).
const usersResponseSchema = {
  safeParse: (data: unknown) => ({ success: true as const, data: data as UsersResponse }),
  toJSONSchema: () => ({
    type: "object",
    properties: {
      users: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            email: { type: "string" },
          },
          required: ["id", "name", "email"],
        },
      },
      total: { type: "integer" },
    },
    required: ["users", "total"],
  }),
};

/**
 * Contract projection fixture (C1). A contract is DECLARATIVE — the scanner
 * extracts its normalized shape statically (no dry-run). Each case's `description`
 * is the reviewable design statement; the response `schema` is the documented
 * SHAPE the contract guarantees (the most important part to review).
 */
export const usersContract = usersApi("users-shape", {
  endpoint: "GET /users",
  feature: "Users API",
  description: "The users endpoint keeps its documented user-list shape and status contract.",
  tags: ["api", "users"],
  cases: {
    ok: {
      description: "returns 200 with a non-empty users array and a total count",
      expect: { status: 200, schema: usersResponseSchema },
    },
    notFound: {
      description: "an unknown user id returns 404, not a 500",
      expect: { status: 404 },
    },
  },
});
