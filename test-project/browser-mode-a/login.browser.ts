/**
 * Mode A runnable login journey (GLU-233 / P1-3) — the end-to-end proof that
 * `glubean run` replays a contract.browser journey with @glubean/browser,
 * freezes evidence, and judges expect (url / dom / calls / console)
 * authoritatively against staging.
 *
 * Run:
 *   node packages/glubean/bin/glubean.js run \
 *     test-project/browser-mode-a/login.browser.ts \
 *     --env-file <a .env with BASE_URL/GLUBEAN_API_URL + a .env.secrets with
 *                 TEST_LOGIN_EMAIL/TEST_LOGIN_PASSWORD>
 */
import { configure, contract } from "@glubean/sdk";
import { browser } from "@glubean/browser";
import { signInEmail } from "./auth.contract.ts";

const { chrome } = configure({
  plugins: {
    chrome: browser({ launch: true, baseUrl: "BASE_URL", screenshot: "on-failure" }),
  },
});

export const dashboardUI = contract.browser.with("dashboardUI", {
  client: chrome,
  baseUrl: "https://app.staging.glubean.com",
  feature: "auth",
  tags: ["dogfood", "staging", "browser"],
});

export const loginJourney = dashboardUI("auth.login.journey", {
  entry: "/login",
  agentNotes: [
    "Watch for layout misalignment between the login page and the dashboard.",
    "Watch for double-submit on the sign-in button.",
  ],
  cases: {
    happyPath: {
      description: "Valid credentials sign in and land on the dashboard, triggering the backend sign-in.",
      steps: [
        {
          id: "open-login",
          intent: "Open /login and wait for the email + password inputs.",
          action: async (page) => {
            await page.goto("/login", { waitUntil: "domcontentloaded" });
          },
        },
        {
          id: "fill-credentials",
          intent: "Fill email + password; do not click any third-party OAuth button.",
          action: async (page, _input, ctx) => {
            await page.fill('input[type="email"]', ctx.secrets.require("TEST_LOGIN_EMAIL"));
            await page.fill('input[type="password"]', ctx.secrets.require("TEST_LOGIN_PASSWORD"));
          },
        },
        {
          id: "submit",
          intent: "Submit the form and wait for navigation away from /login.",
          action: async (page) => {
            await page.click('button[type="submit"]');
            await page.waitForURL(/^https:\/\/app\.staging\.glubean\.com\/(?!login$)/, {
              timeout: 20_000,
            });
          },
        },
      ],
      expect: [
        { id: "url-dashboard", url: { notPath: "/login", pattern: "^https://app\\.staging\\.glubean\\.com/" } },
        { id: "dom-welcome", dom: { visible: { text: "Welcome back" } } },
        { id: "calls-signin", calls: signInEmail.case("validStagingCredentials") },
        { id: "console-clean", console: { errors: 0, allow: ["favicon", "/targets"] } },
      ],
    },
  },
});
