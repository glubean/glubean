import { test } from "@glubean/sdk";

// Fixture: a test body that hard-exits the process. Under dry-run this aborts
// the worker; the spawn helper must report the unreached file as an abnormal
// exit instead of silently dropping it. Named *.fixture.ts so scans skip it.
export const boom = test("exit-boom", async () => {
  process.exit(1);
});
