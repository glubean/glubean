import { test } from "@glubean/sdk";

/**
 * Synthetic canary — 100% in-process, no backend. A coin flip on
 * Math.random() means this passes ~50% of runs. Its only job is to
 * prove the run → reduce → dashboard pipeline is alive end-to-end,
 * independent of any external service. If the mock backend is down,
 * this canary still produces flaky data.
 *
 * Intentionally only in the `public-demo` profile — never `npm test`.
 */

export const syntheticFlaky = test(
  { id: "canary-synthetic-50pct", tags: ["canary", "public-demo"] },
  async (ctx) => {
    const roll = Math.random();
    ctx.log(`synthetic canary roll = ${roll.toFixed(3)} (passes if < 0.5)`);
    ctx.assert(
      roll < 0.5,
      "synthetic 50/50 canary — non-deterministic by design (proves the pipeline is live)",
    );
  },
);
