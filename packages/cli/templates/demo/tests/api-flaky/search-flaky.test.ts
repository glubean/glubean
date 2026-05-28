import { test } from "@glubean/sdk";
import { http } from "../../config/api.ts";

/**
 * Flaky suite — hits the mock backend's /api/flaky/search endpoint,
 * which returns 503 ~30% of the time by design. Asserting 200 makes
 * the failures surface as real flaky data the dashboard classifies
 * (stable test, intermittent fail).
 *
 * Non-2xx doesn't throw (throwHttpErrors defaults false) and the
 * runner defaults retry to 0, so each raw 503 fails the test — no
 * try/catch, no custom client. (If your runner predates the retry:0
 * default, add `retry: 0` to the get() options here.)
 *
 * NOT in the `local` profile — `npm test` stays green. Only
 * `npm run test:full` includes it.
 */

export const flakySearch = test(
  { id: "flaky-search", tags: ["flaky", "public-demo"] },
  async ({ expect }) => {
    const res = await http.get("api/flaky/search", {
      searchParams: { q: "glubean" },
    });
    // ~30% of runs return 503 by design; this assertion fails on those.
    expect(res).toHaveStatus(200);
  },
);
