import { test } from "@glubean/sdk";

// Watchdog fixture: a pure-compute infinite loop the dry-run request budget
// cannot catch (it makes no synthetic HTTP calls). Named *.fixture.ts so scans
// skip it; the dry-run spawn test passes it to dryRunFiles() explicitly.
export const hang = test("hang-forever", async () => {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // spin — only ever exercised by the dry-run watchdog test
  }
});
