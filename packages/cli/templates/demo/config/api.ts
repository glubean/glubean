import { configure } from "@glubean/sdk";

/**
 * Single shared HTTP client for the demo's mock backend.
 *
 * Per the Glubean project-structure convention: call `configure()`
 * ONCE here and import `http` into every test + contract — don't
 * repeat configure() per file. `prefixUrl` resolves {{MOCK_BACKEND_URL}}
 * from .env at run time; the client auto-traces + auto-redacts every
 * request.
 *
 * Optional caller key: if your deployed glubean-demo-backend enforces
 * the caller-key rate tier (verified 60/min vs anonymous 10/min), set
 * DEMO_BACKEND_CALLER_KEY in .env.secrets and uncomment the `headers`
 * line below. Left off by default so a fresh scaffold runs zero-config
 * — a `{{...}}` header throws if the secret is empty/unset, and the
 * anonymous tier is plenty for occasional local runs.
 */
export const { http } = configure({
  http: {
    prefixUrl: "{{MOCK_BACKEND_URL}}",
    // headers: { "x-demo-caller-key": "{{DEMO_BACKEND_CALLER_KEY}}" },
  },
});
