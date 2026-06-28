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
    // A compute is OPAQUE (its transform logic can't be statically shaped), so its
    // `description` is the ONLY thing a reviewer can read to understand the step —
    // never leave an opaque node as a bare two-word name.
    then: (b) =>
      b.compute(
        {
          id: "mark-seed",
          description: "Mark the run as needing a seed user (sets state.seed = true) so a later step provisions the first account.",
        },
        (s) => ({ ...s, seed: true }),
      ),
    else: (b) =>
      b.compute(
        {
          id: "mark-ready",
          description: "Mark the run as ready (sets state.seed = false) — users already exist, so onboarding skips seeding.",
        },
        (s) => ({ ...s, seed: false }),
      ),
  })
  .build();
