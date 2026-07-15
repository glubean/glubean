
import { workflow } from "@glubean/sdk";
export const wf = workflow("wf-unbuilt")
  .setup(async () => ({ ok: true }))
  .check("verify", async (c, s) => { c.assert(s.ok, "ok"); });
