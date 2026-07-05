/**
 * auth.browser.ts — GLU-211 scaffold fixture: the first representative
 * `contract.browser` journey, in its P0-narrow shape (Mode B agent-QA only).
 *
 * Status: `contract.browser` adapter (Mode A) is NOT implemented yet — see
 * `internal/40-discovery/proposals/contract-browser-two-tier.md`. This file
 * is pure data (no `@glubean/sdk` import, no `action` functions); it exists
 * so an agent can read it as a structured QA script:
 *
 *   - `steps[].intent` — the execution instructions, in order.
 *   - `expect[]`       — the fixed questionnaire the agent must answer for
 *                        every id, every round (see docs/agent-qa-report-v1.md).
 *   - `agentNotes`     — extra attention items; findings from these go into
 *                        `extraFindings`, never into an `expect` verdict.
 *
 * P0 narrow scope (owner review 5): `entry + agentNotes + steps[].intent +
 * expect.{url,dom,calls,console}`. No `action` — Mode B's value does not
 * depend on it, and writing `action` now would drag the discussion back to
 * "browser Playwright DSL" before the Mode B hypothesis is settled.
 *
 * Wording history: this fixture was tightened after a 4-round sonnet-5
 * experiment (internal/acceptance-evidence/modeb-agent-qa-2026-07-03/) found
 * every instability source lived in *spec wording*, not agent capability —
 * see docs/mode-b-agent-qa-experiment.md §"Known wording traps fixed here"
 * for the list this fixture now encodes.
 */
export const loginJourney = {
  id: "auth.login.journey",
  entry: "/login", // relative to BASE_URL (read from .env)
  feature: "auth",
  description: "A user signs in with email + password on the login page and lands on the dashboard.",
  agentNotes: [
    "Watch for layout misalignment / overlapping elements between the login page and the dashboard.",
    "Watch for whether the submit button can be double-clicked into a duplicate submission.",
    "Watch for console errors tied to product code; third-party/resource-load noise goes in extraFindings with kind=console-noise, not into the console-clean verdict.",
  ],
  cases: {
    happyPath: {
      description:
        "Valid credentials sign the user in, land on the dashboard, and trigger the backend sign-in call.",
      needs: {
        email: "{{secret:TEST_LOGIN_EMAIL}}",
        password: "{{secret:TEST_LOGIN_PASSWORD}}",
      },
      steps: [
        {
          id: "open-login",
          intent: "Open {{BASE_URL}}/login and wait until the login form (email + password inputs) is visible.",
        },
        {
          id: "fill-credentials",
          intent:
            "Fill the login form with email {{secret:TEST_LOGIN_EMAIL}} and password {{secret:TEST_LOGIN_PASSWORD}}. Do not click any third-party OAuth button.",
        },
        {
          id: "submit",
          intent: "Submit the login form and wait for navigation away from /login to complete.",
        },
      ],
      /**
       * Fixed questionnaire. Evaluation order matters and is fixed here
       * (round-3/round-4 finding: judging url before dom removes the
       * "static login-page text looks like the post-login heading" false
       * positive that bit 2 of 4 rounds in the 2026-07-03 experiment):
       *   1. url-dashboard   (confirms the journey actually left /login)
       *   2. dom-welcome     (only meaningful once url-dashboard is pass)
       *   3. calls-signin
       *   4. console-clean
       */
      expect: [
        {
          id: "url-dashboard",
          kind: "url",
          assert:
            "Final URL matches the pattern https://app.staging.glubean.com/** and does NOT contain /login. " +
            "(Tightened from the vaguer 2026-07-03 wording 'no longer /login' — an explicit pattern removes " +
            "ambiguity if a redirect policy or account type ever lands somewhere other than the bare root.)",
        },
        {
          id: "dom-welcome",
          kind: "dom",
          assert:
            "The page's main-content heading (role=heading, level=1) is visible and its text contains both " +
            "'Welcome back' AND the signed-in user's email or display name. " +
            "This MUST be checked on the post-submit terminal page (only reachable once url-dashboard is pass) " +
            "— the login page itself has an unrelated static 'Welcome back' string that is NOT this heading, and " +
            "a lazy check that doesn't bind to the landmark + username can false-pass without ever submitting the form.",
        },
        {
          id: "calls-signin",
          kind: "calls",
          assert:
            "During the journey, a POST to https://api.staging.glubean.com/api/auth/sign-in/email was made and " +
            "returned status 200 (at least once). Evidence must be a method+url+status summary — never the raw " +
            "request or response body (it may contain the password / session token).",
          ref: "auth.sign-in.email#validStagingCredentials",
        },
        {
          id: "console-clean",
          kind: "console",
          assert:
            "During the journey window (entry navigation through evidence-freeze), console shows zero error-level " +
            "messages from the product's own domains (app.staging.glubean.com / api.staging.glubean.com). " +
            "Errors from any other origin (third-party scripts, resource loads such as favicon.ico) are NOT a fail " +
            "— log them as an extraFinding with kind=console-noise instead. (This product-domain-vs-noise boundary " +
            "was the largest free-discretion point found in the 2026-07-03 experiment; it is now a fixed rule, not " +
            "agent judgment.)",
        },
      ],
    },
  },
} as const;

export type LoginJourney = typeof loginJourney;
