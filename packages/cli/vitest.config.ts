import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // GLU-79: the CLI suite is dominated by integration tests that spawn the
    // real CLI as a tsx subprocess (runCli in test-helpers.ts, each.test.ts's
    // discovery worker). Under contended load — full-monorepo `pnpm -r test`,
    // several packages' vitest workers competing for CPU — subprocess startup
    // alone can blow vitest's 5000ms default and flake tests that are merely
    // slow, not hung (0.8.4 release CI saw 4x5s timeouts here). 30s is a
    // lenient ceiling: it never slows a passing run and only widens the
    // budget for timeout-type flakes. Per-file overrides (init.test.ts: 90s)
    // take precedence.
    testTimeout: 30_000,
  },
});
