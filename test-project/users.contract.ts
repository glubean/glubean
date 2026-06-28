import { contract, configure } from "@glubean/sdk";

const api = configure({ prefixUrl: "https://api.test" });

// A scoped contract factory (contract.http.with → instance), per the SDK: the
// bare contract.http("id", spec) form is not supported at runtime.
const usersApi = contract.http.with("users-api", { client: api });

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
}
interface UsersResponse {
  users: User[];
  total: number;
}

// One user's JSON Schema with RICH CONSTRAINTS — formats, bounds, an enum, and a
// per-field description on every property. This is the point of contract review:
// the reviewer sees the documented guarantee (a uuid id, an email-formatted address
// capped at RFC length, a name that's never empty, a CLOSED role enum), not just
// "string". The OpenAPI view renders every one of these as a constraint pill.
const userSchema = {
  type: "object",
  description: "A registered user.",
  properties: {
    id: {
      type: "string",
      format: "uuid",
      description: "Server-assigned stable identifier (never reused).",
    },
    name: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      description: "Display name; trimmed, never empty.",
    },
    email: {
      type: "string",
      format: "email",
      maxLength: 254,
      description: "Unique login email (RFC 5321 length cap).",
    },
    role: {
      type: "string",
      enum: ["admin", "member", "viewer"],
      description: "Access level governing permissions.",
    },
    createdAt: {
      type: "string",
      format: "date-time",
      description: "ISO 8601 timestamp the account was created.",
    },
  },
  required: ["id", "name", "email", "role", "createdAt"],
  additionalProperties: false,
};

// Hand-rolled SchemaLike (no zod dep) that ALSO exposes `toJSONSchema()` — the
// scanner projects that into the case's response SHAPE and the OpenAPI doc, so
// reviewers see the documented contract WITH its constraints. `safeParse` is
// minimal (this fixture is only projected, never run).
const usersResponseSchema = {
  safeParse: (data: unknown) => ({ success: true as const, data: data as UsersResponse }),
  toJSONSchema: () => ({
    type: "object",
    properties: {
      users: {
        type: "array",
        description: "The current page of users; an empty array (never null) when none exist.",
        maxItems: 1000,
        items: userSchema,
      },
      total: {
        type: "integer",
        minimum: 0,
        description: "Total users across all pages (>= the returned page size).",
      },
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
      // Query parameters are part of the request contract too — each carries its own
      // constraint + description, so the OpenAPI view documents the full call shape.
      query: {
        page: {
          value: "1",
          schema: { toJSONSchema: () => ({ type: "integer", minimum: 1 }) },
          description: "1-indexed page number.",
          required: false,
        },
        limit: {
          value: "20",
          schema: { toJSONSchema: () => ({ type: "integer", minimum: 1, maximum: 100 }) },
          description: "Page size; capped at 100.",
          required: false,
        },
      },
      expect: {
        status: 200,
        schema: usersResponseSchema,
        // Response headers are documented shape as well — the reviewer sees the
        // pagination + rate-limit contract, not just the body.
        headers: {
          safeParse: (data: unknown) => ({ success: true as const, data }),
          toJSONSchema: () => ({
            type: "object",
            properties: {
              "x-total-count": {
                type: "integer",
                minimum: 0,
                description: "Total users across all pages (matches the body `total`).",
              },
              "x-ratelimit-remaining": {
                type: "integer",
                minimum: 0,
                description: "Requests remaining in the current rate-limit window.",
              },
            },
          }),
        },
      },
    },
    notFound: {
      description: "an unknown user id returns 404, not a 500",
      expect: { status: 404 },
    },
  },
});
