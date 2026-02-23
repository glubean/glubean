import { test } from "@glubean/sdk";

export const failingTest = test(
  "always-fails",
  (ctx) => {
    ctx.assert(false, "this should fail");
  },
);
