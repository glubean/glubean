
import { workflow } from "@glubean/sdk";
let calls = 0;
export const wf = workflow("wf-retry")
  .setup(async () => ({}))
  .action("flaky", async (c) => {
    calls += 1;
    c.assert(calls >= 2, "attempt-" + calls);
    if (calls < 2) throw new Error("first attempt fails");
  }, { retry: { attempts: 2, reason: "eventually consistent" } })
  .build();
