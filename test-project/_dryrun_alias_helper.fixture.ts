import { test } from "@glubean/sdk";

// Helper that defines a uniquely-named test.extend alias (NOT matching the *Test
// convention, and used ONLY from another file). Proves dryRunFiles collects
// aliases project-wide, not just from the input files.
export const helperApi = test.extend({ token: (_ctx) => "t" });
