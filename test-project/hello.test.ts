import { test } from "@glubean/sdk";

export const hello = test(
  {
    id: "hello-world",
    description: "Smoke check that the suite boots and the runner executes a test body.",
    tags: ["smoke"],
  },
  async (ctx) => {
    ctx.log("Hello from Node.js!");
    ctx.assert(true, "the harness boots and runs a test body");
    ctx.expect(1 + 1).toBe(2, "synchronous assertions evaluate");
    ctx.expect("hello").toContain("ell", "string matchers are available");
  },
);
