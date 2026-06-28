import { contract, configure } from "@glubean/sdk";

const api = configure({ prefixUrl: "https://api.test" });

// A scoped contract factory (contract.http.with → instance), per the SDK: the
// bare contract.http("id", spec) form is not supported at runtime.
const usersApi = contract.http.with("users-api", { client: api });

/**
 * Contract projection fixture (C1). A contract is DECLARATIVE — the scanner
 * extracts its normalized shape statically (no dry-run). Each case's `description`
 * is the reviewable design statement (like an assertion message for tests).
 */
export const usersContract = usersApi("users-shape", {
  endpoint: "GET /api/users",
  feature: "Users API",
  description: "The users endpoint keeps its documented user-list shape and status contract.",
  tags: ["api", "users"],
  cases: {
    ok: {
      description: "returns 200 with a non-empty users array and a total count",
      expect: { status: 200 },
    },
    notFound: {
      description: "an unknown user id returns 404, not a 500",
      expect: { status: 404 },
    },
  },
});
