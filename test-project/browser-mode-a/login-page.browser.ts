/**
 * Page-load journey (GLU-238 / P1-8) — exercises the entry-only (steps: [])
 * contract: the adapter just opens `entry` and judges url/dom/console, no
 * actions. Part of the 3-journey commit-gate set.
 */
import { dashboardUI } from "./login.browser.ts";

export const loginPageJourney = dashboardUI("auth.login.page", {
  entry: "/login",
  cases: {
    loads: {
      description: "The login page loads with the email + password form and no product console errors.",
      steps: [], // entry-only page-load — no actions
      expect: [
        { id: "url-login", url: { pattern: "^https://app\\.staging\\.glubean\\.com/login" } },
        { id: "dom-email", dom: { visible: { selector: 'input[type="email"]' } } },
        { id: "dom-password", dom: { visible: { selector: 'input[type="password"]' } } },
        { id: "console-clean", console: { errors: 0, allow: ["favicon", "/targets"] } },
      ],
    },
  },
});
