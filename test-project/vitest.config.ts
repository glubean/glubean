import { defineConfig } from "vitest/config";

// This directory mixes two unrelated "test" conventions: SDK-authored
// fixtures (hello.test.ts, users.test.ts, projection-demo.test.ts — despite
// the filename, these use @glubean/sdk's own `test()` and only run through
// `glubean run`, never vitest) and genuine vitest suites (this GLU-211
// scaffold's agent-qa-report.test.ts). A broad `*.test.ts` glob makes vitest
// choke on the former ("No test suite found"), so this config is scoped to
// name the vitest suites explicitly rather than guess by extension.
export default defineConfig({
  test: {
    include: ["agent-qa-report.test.ts"],
  },
});
