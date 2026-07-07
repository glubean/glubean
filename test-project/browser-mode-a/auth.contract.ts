/**
 * Staging email/password sign-in — contract.http case, referenced by the
 * browser journey's `expect.calls` (GLU-233 / P1-3). This contract is only
 * REFERENCED (the browser app makes the real call); the matcher reads its
 * endpoint + case status + schema. It is not executed here.
 */
import { configure, contract } from "@glubean/sdk";

const { http } = configure({
  vars: { apiUrl: "{{GLUBEAN_API_URL}}" },
  http: { prefixUrl: "{{GLUBEAN_API_URL}}", throwHttpErrors: false },
});

const api = contract.http.with("staging-auth", { client: http, security: null });

// Reference-only: these cases exist so the browser journeys' `expect.calls` can
// point at them (the matcher reads endpoint + status). They are NOT executed
// directly (no request body), so mark them opt-in so a `glubean run <dir>`
// doesn't try to run them as standalone HTTP tests.
export const signInEmail = api("auth.sign-in.email", {
  endpoint: "POST /api/auth/sign-in/email",
  description: "Email/password sign-in endpoint used by the staging webapp.",
  cases: {
    validStagingCredentials: {
      description: "Valid staging credentials return a session.",
      // No response schema here (test-project has no zod dep) — the calls
      // matcher still matches on method + path + status; schema → not-applicable.
      defaultRun: "opt-in",
      expect: { status: 200 },
    },
    invalidPassword: {
      description: "A wrong password is rejected (401), no session is created.",
      defaultRun: "opt-in",
      expect: { status: 401 },
    },
  },
});
