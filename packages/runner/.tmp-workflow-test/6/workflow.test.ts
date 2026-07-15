
import { workflow } from "@glubean/sdk";
export const wf = workflow("wf-family")
  .setup(async () => ({ plan: "pro", path: "none" }))
  .switch("by plan", {
    on: (s) => s.plan,
    cases: [
      { value: "free", then: (b) => b.compute("go-free", (s) => ({ ...s, path: "free" })) },
      { value: "pro", then: (b) => b.compute("go-pro", (s) => ({ ...s, path: "pro" })) },
    ],
  })
  .route("fan out", {
    on: (s) => s.path,
    cases: [
      { value: "pro", then: (b) => b.check("pro-leaf", async (c, s) => { c.assert(s.path === "pro", "routed pro"); }) },
    ],
    default: (b) => b.check("unrouted", async (c) => c.fail("unrouted")),
  })
  .build();
