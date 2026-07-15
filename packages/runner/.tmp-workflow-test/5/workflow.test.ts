
import { workflow, contract } from "@glubean/sdk";
contract.register("wf-e2e-poll", {
  project: () => ({ cases: {} }),
  executeCaseInFlow: async () => ({ status: "pending" }),
});
const ref = {
  __glubean_type: "contract-case-ref",
  contractId: "job", caseKey: "status", protocol: "wf-e2e-poll", target: "GET /job",
  contract: {},
};
export const wf = workflow("wf-poll")
  .setup(async () => ({}))
  .poll("wait", ref, {
    until: (w) => w.when((r) => r.status).eq("done"),
    every: 1, maxAttempts: 2, perAttemptTimeout: 1000,
  })
  .build();
