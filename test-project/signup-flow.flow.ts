/**
 * v0.2 flow example — composes HTTP contract cases with setup / step / compute.
 *
 * Demonstrates:
 *   - `flow.setup()`   — only I/O-capable callback (async, can read ctx / env)
 *   - `.step(ref, { in, out })` — typed lens bindings thread state through the flow
 *   - `.compute()`     — pure synchronous data transform (e.g. compound IDs)
 *
 * This file is illustrative: it loads without hitting the network, which
 * exercises the flow registration path (scanner discovers it, normalizeFlow
 * extracts field mappings). Running the flow end-to-end requires a live
 * HTTP server at the configured prefixUrl.
 */

import { configure, contract } from "@glubean/sdk";

// Any HTTP client will do — configure() returns one bound to the prefixUrl.
// For running the flow you'd point this at a real API.
const { http } = configure({
  http: { prefixUrl: "https://example.invalid" },
});

const api = contract.http.with("demo", { client: http });

export const createUser = api("create-user", {
  endpoint: "POST /users",
  description: "Register a new user",
  cases: {
    ok: {
      description: "Happy path — returns 201 with user id",
      // Static body — lens in the flow below patches `email` onto it.
      body: { role: "member", source: "test-project" },
      expect: { status: 201 },
    },
  },
});

export const fetchUser = api("fetch-user", {
  endpoint: "GET /users/:compoundKey",
  description: "Fetch a user by compound identifier",
  cases: {
    ok: {
      description: "Returns the user record",
      expect: { status: 200 },
    },
  },
});

/**
 * Flow:
 *   setup    → seed { email, category }
 *   step #1  → create-user.ok, lens injects email into body, captures userId from response
 *   compute  → combine category + userId into a compound key
 *              (lens can't do string concatenation — that's what compute is for)
 *   step #2  → fetch-user.ok, lens uses the compound key as a URL param
 *
 * Run `npx glubean contracts --format json` to see the extracted projection
 * including FieldMappings for the lenses and reads/writes for the compute step.
 */
export const signupFlow = contract
  .flow("signup-flow")
  .meta({
    description: "E2E signup + fetch round trip",
    tags: ["e2e", "example"],
    // This example is for scanner/docs extraction only. It targets
    // https://example.invalid which never answers. Marking it as skipped
    // so that broad discovery (`glubean run test-project/`) doesn't try
    // to hit the network. Remove `skip` + point `prefixUrl` at a real
    // server to actually run it.
    skip: "illustrative example — no live server configured",
  })
  .setup(async () => ({
    email: "alice@test-project.invalid",
    category: "members",
  }))
  .step(createUser.case("ok"), {
    in: (s) => ({ body: { email: s.email } }),
    out: (s, res: any) => ({ ...s, userId: res.body.id }),
  })
  .compute((s) => ({
    ...s,
    // Pure synchronous TS — not allowed in lenses, perfect for compute
    compoundKey: `${s.category}:${s.userId}`,
  }))
  .step(fetchUser.case("ok"), {
    in: (s) => ({ params: { compoundKey: s.compoundKey } }),
  });
