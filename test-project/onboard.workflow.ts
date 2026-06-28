import { workflow } from "@glubean/sdk";
import { usersContract } from "./users.contract.ts";

/**
 * Workflow projection fixture (C1). A standalone `workflow()` (NOT contract.flow)
 * composes contract cases with call()/branch()/compute() + typed state. Declarative
 * — the scanner projects its node tree statically; the `description` + node names
 * are the reviewable design. The runtime-opaque branch projects as `opaque`, so the
 * workflow shows as a PARTIAL projection (reviewers see where shape can't be read).
 */
export const onboardFlow = workflow({
  id: "onboard-flow",
  description: "Fetch the user list, then decide whether onboarding must seed a first user.",
  tags: ["flow", "users"],
})
  .call("fetch-users", usersContract.case("ok"), {
    out: (_state, res) => ({ users: res.body }),
  })
  .branch("needs-seed", {
    whenRuntime: (_ctx, s) => !Array.isArray(s.users) || s.users.length === 0,
    message: "the user list is empty, so onboarding must seed a first user",
    then: (b) => b.compute("mark-seed", (s) => ({ ...s, seed: true })),
    else: (b) => b.compute("mark-ready", (s) => ({ ...s, seed: false })),
  })
  .build();
