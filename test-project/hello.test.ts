import { test } from "@glubean/sdk";

export const hello = test("hello-world", async (ctx) => {
  ctx.log("Hello from Node.js!");
  ctx.assert(true, "basic assertion works");
  ctx.expect(1 + 1).toBe(2);
  ctx.expect("hello").toContain("ell");
});
