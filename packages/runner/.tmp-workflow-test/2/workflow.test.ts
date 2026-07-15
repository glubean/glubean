
import { workflow } from "@glubean/sdk";
export const wf = workflow("wf-fail")
  .setup(async () => ({}))
  .action("boom", async () => { throw new Error("kaput"); })
  .compute("never", (s) => s)
  .build();
