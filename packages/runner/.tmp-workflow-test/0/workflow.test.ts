
import { workflow } from "@glubean/sdk";
export const wf = workflow("wf-pass")
  .setup(async () => ({ n: 1 }))
  .compute("bump", (s) => ({ n: s.n + 1 }))
  .check("verify", async (c, s) => { c.assert(s.n === 2, "n bumped"); })
  .build();
