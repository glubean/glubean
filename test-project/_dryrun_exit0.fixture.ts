import { test } from "@glubean/sdk";

// Fixture: a test body that cleanly exits the process (code 0). Under dry-run
// this still aborts the worker; the spawn helper must report the unreached file
// as not-projected even on a clean exit. Named *.fixture.ts so scans skip it.
export const boom0 = test("exit-boom-0", async () => {
  process.exit(0);
});
