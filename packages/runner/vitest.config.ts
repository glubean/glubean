import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // GLU-79: most tests in this package spawn real tsx subprocesses
    // (TestExecutor / harness / dry-run workers). Under contended load —
    // full-monorepo `pnpm -r test`, several packages' vitest workers
    // competing for CPU — subprocess startup alone can blow vitest's 5000ms
    // default and flake tests that are merely slow, not hung (bit the 0.8.4
    // release CI: 824/825). 30s is a lenient ceiling: it never slows a
    // passing run and only widens the budget for timeout-type flakes.
    // Explicit per-test timeouts (e.g. the 60s rowIndex batch test) still
    // take precedence — just don't add new ones below 30s.
    testTimeout: 30_000,
  },
});
