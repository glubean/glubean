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
import type { SchemaLike } from "@glubean/sdk";

// Any HTTP client will do — configure() returns one bound to the prefixUrl.
// For running the flow you'd point this at a real API.
const { http } = configure({
  http: { prefixUrl: "https://example.invalid" },
});

const api = contract.http.with("demo", { client: http });

// v10 logical-input pattern: cases declare `needs` schema; function-valued
// body/params receive the logical input (not setup state). Flow's `.step()`
// `in` lens returns the logical input shape, not an adapter patch.
//
// Minimal SchemaLike helper for docs-only flows: pure type-level,
// no runtime parse. A real project would use zod or valibot.
function s<T>(): SchemaLike<T> {
  return {} as SchemaLike<T>;
}

export const createUser = api("create-user", {
  endpoint: "POST /users",
  description: "Register a new user",
  cases: {
    ok: {
      description: "Happy path — returns 201 with user id",
      needs: s<{ email: string }>(),
      // Explicit parameter annotation. Phase 2c Step B+C removed v9's `S`
      // (setup state) from ContractCase and threaded `Needs`, but TS can't
      // auto-infer Needs from the sibling `needs: SchemaLike<T>` field
      // (self-referential inference across sibling fields in an object
      // literal is beyond TS's capability without a factory wrapper).
      // Annotation is a small but persistent authoring cost; a future
      // `defineCase<T>({ needs, body })` factory could eliminate it.
      body: ({ email }: { email: string }) => ({
        role: "member",
        source: "test-project",
        email,
      }),
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
      needs: s<{ compoundKey: string }>(),
      params: ({ compoundKey }: { compoundKey: string }) => ({ compoundKey }),
      expect: { status: 200 },
    },
  },
});

/**
 * Flow:
 *   setup    → seed { email, category }
 *   step #1  → create-user.ok — `in` returns { email } (the case's logical input);
 *              body() builds the full request from it. `out` captures userId.
 *   compute  → combine category + userId into a compound key
 *              (lens can't do string concatenation — that's what compute is for)
 *   step #2  → fetch-user.ok — `in` returns { compoundKey }; params() resolves URL.
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
    in: (state) => ({ email: state.email }),
    out: (state, res: any) => ({ ...state, userId: res.body.id }),
  })
  .compute((state) => ({
    ...state,
    // Pure synchronous TS — not allowed in lenses, perfect for compute
    compoundKey: `${state.category}:${state.userId}`,
  }))
  .step(fetchUser.case("ok"), {
    in: (state) => ({ compoundKey: state.compoundKey }),
  });
