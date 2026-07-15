
import { workflow } from "@glubean/sdk";
export const wf = workflow("wf-skip")
  .setup(async () => ({}))
  .action("gate", async (c) => { c.skip("feature off"); })
  .build();
