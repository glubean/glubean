import { test } from "@glubean/sdk";
import { mockGet } from "../../demo/lib/mock-backend-client.js";

/**
 * Flaky suite — hits the mock backend's /api/flaky/search endpoint,
 * which returns 503 ~30% of the time by design. This test asserts a
 * 200 (treating 503 as a failure), so over many runs the public
 * dashboard shows a ~70% pass rate + flaky classification.
 *
 * Intentionally NOT in the `local` profile — `npm test` stays green.
 * Only `npm run test:public-demo` includes it.
 */

export const flakySearch = test(
  { id: "flaky-search", tags: ["flaky", "public-demo"] },
  async (ctx) => {
    const res = await mockGet<{ results?: unknown[]; error?: string }>(
      ctx,
      "/api/flaky/search?q=glubean",
    );
    // The backend fails ~30% of the time with 503. We assert 200 so the
    // failures surface as real test failures the dashboard can classify
    // as flaky (stable test, intermittent fail).
    ctx.assert(
      res.status === 200,
      `GET /api/flaky/search returned ${res.status} (expected 200; ~30% of runs fail here by design)`,
    );
    if (res.status === 200) {
      ctx.assert(Array.isArray(res.body.results), "successful response has results array");
    }
  },
);
