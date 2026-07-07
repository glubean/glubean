/**
 * Invalid-login journey (GLU-238 / P1-8) — a wrong password is rejected: the
 * app stays on /login and the backend returns 401. Exercises the killer feature
 * (expect.calls) against a NON-2xx contract.http case. Part of the 3-journey
 * commit-gate set.
 */
import { dashboardUI } from "./login.browser.ts";
import { signInEmail } from "./auth.contract.ts";

export const invalidLoginJourney = dashboardUI("auth.login.invalid", {
  entry: "/login",
  cases: {
    wrongPassword: {
      description: "A wrong password keeps the user on /login; the sign-in call returns 401.",
      steps: [
        {
          id: "open-login",
          intent: "open /login",
          action: async (page) => {
            await page.goto("/login", { waitUntil: "domcontentloaded" });
          },
        },
        {
          id: "submit-wrong",
          intent: "fill a real email but a deliberately wrong password, then submit",
          action: async (page, _input, ctx) => {
            await page.fill('input[type="email"]', ctx.secrets.require("TEST_LOGIN_EMAIL"));
            await page.fill('input[type="password"]', "definitely-not-the-password-xyz");
            await page.click('button[type="submit"]');
            // Wait for the sign-in POST to resolve (401). Match method+URL so the
            // CORS preflight (OPTIONS → 204) doesn't satisfy the wait instead.
            await page.expectResponse(
              (r) => r.request().method() === "POST" && r.url().endsWith("/api/auth/sign-in/email"),
              { status: 401 },
              { timeout: 15_000 },
            );
          },
        },
      ],
      expect: [
        { id: "url-still-login", url: { pattern: "^https://app\\.staging\\.glubean\\.com/login" } },
        { id: "calls-signin-401", calls: signInEmail.case("invalidPassword") },
      ],
    },
  },
});
