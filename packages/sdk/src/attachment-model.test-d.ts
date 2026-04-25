/**
 * Type-level tests for the attachment model on the real SDK path.
 *
 * Uses `contract.http.with(...)` factory (the real public API) to prove:
 *   - `.case("key")` preserves per-case Needs from `needs: SchemaLike<T>`
 *   - `contract.bootstrap(ref, { run })` rejects wrong run return types
 *   - No-needs cases produce void ref; void-returning bootstrap OK
 *
 * Complements Spike 0 standalone proof by verifying the production type
 * chain (register → dispatcher → ProtocolContract → .case → bootstrap)
 * actually wires up `NoInfer<Needs>` correctly.
 *
 * No runtime assertions. Only type correctness. Runs via `tsc --noEmit`.
 *
 * @see contract-attachment-model.md v1.3
 * @see __spikes__/attachment-model-types.ts for the isolated proof
 */

/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-unused-expressions */

import { contract } from "./index.js";
import type { SchemaLike } from "./types.js";

// Fabricate a SchemaLike<T> for type-only tests (no runtime parse).
function s<T>(): SchemaLike<T> {
  return {} as SchemaLike<T>;
}

// InferCaseInput correctness probes (Phase 2d Step 2 diagnostics kept as
// regression guards):
//
//   - Case without `needs` field → void (InferCaseInput returns void)
//   - Unknown case type → void (gRPC/GraphQL defaulting to unknown)
//
// Both must hold for the conditional-tuple step() signature to correctly
// allow `.step(ref)` without bindings on cases that don't declare `needs`.
import type { InferCaseInput } from "./contract-types.js";
const _probeUnknownIsVoid: InferCaseInput<unknown> extends void ? true : false = true;
const _probeNoNeedsIsVoid: InferCaseInput<{ description: string }> extends void ? true : false = true;
void _probeUnknownIsVoid;
void _probeNoNeedsIsVoid;

// Minimal mock http client — typed enough for the factory `.with(...)` call.
const mockClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get: (async (_url: string, _opts?: unknown) => ({ status: 200, body: {} })) as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  post: (async (_url: string, _opts?: unknown) => ({ status: 200, body: {} })) as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  put: (async (_url: string, _opts?: unknown) => ({ status: 200, body: {} })) as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete: (async (_url: string, _opts?: unknown) => ({ status: 200, body: {} })) as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  patch: (async (_url: string, _opts?: unknown) => ({ status: 200, body: {} })) as any,
};

const api = contract.http.with("type-d-tests", { client: mockClient as any });

// =============================================================================
// Test 1: contract.bootstrap rejects wrong run return shape
// =============================================================================

{
  const getUser = api("user.get", {
    endpoint: "GET /users/:userId",
    cases: {
      success: {
        description: "fetch user",
        needs: s<{ token: string; userId: string }>(),
        expect: { status: 200 },
      },
    },
  });

  const ref = getUser.case("success");

  // Introspect the ref's phantom input — must be { token, userId }, NOT `any`
  type RefInput = typeof ref extends { __phantom_inputs?: infer I } ? I : never;
  const _assertHasToken: RefInput = { token: "t", userId: "u" };
  // @ts-expect-error — RefInput must not accept arbitrary keys (proves not `any`)
  const _assertNotAny: RefInput = { completelyWrongField: "x" };

  // CORRECT: run returns exact Needs shape
  const goodOverlay = contract.bootstrap(ref, async (_ctx) => ({
    token: "t",
    userId: "u",
  }));

  // WRONG: run return `{ token }` missing `userId`
  // @ts-expect-error — run return does not satisfy Needs `{ token, userId }`
  const badMissingField = contract.bootstrap(ref, async (_ctx) => ({
    token: "t",
  }));

  void goodOverlay;
  void badMissingField;
}

// =============================================================================
// Test 2: structured bootstrap form preserves Params inference
// =============================================================================

{
  const getUser = api("user.get2", {
    endpoint: "GET /users/:userId",
    cases: {
      success: {
        description: "fetch user",
        needs: s<{ token: string; userId: string }>(),
        expect: { status: 200 },
      },
    },
  });

  const ref = getUser.case("success");

  // CORRECT: structured form with params; run sees typed params
  const goodStructured = contract.bootstrap(ref, {
    params: s<{ userIdOverride: string }>(),
    run: async (_ctx, params) => ({
      token: "t",
      userId: params.userIdOverride,
    }),
  });

  void goodStructured;
}

// =============================================================================
// Test 3-pre: HTTP body field — KNOWN OPEN GAP (RFR v3.2 P2 acknowledged)
//
// `Needs` does NOT thread to body's fn parameter when authoring case
// literals. v3.1 partial fixes:
//   - body's static branch narrowed to `HttpStaticBody` (no `unknown`)
//   - HttpContractCase redeclares `needs?: SchemaLike<Needs>`
// Both real but insufficient: TS still doesn't infer `Needs` from the
// sibling `needs: SchemaLike<X>` field in a case literal (cross-field
// generic inference requires a factory wrapper).
//
// **Runtime is NOT a substitute defense for this case.** Earlier RFR
// drafts said "validateNeedsOutput catches it" — that was wrong. The
// failure mode in detail:
//   1. Author writes drift: `needs: s<{email}>()` + `body: ({nope}: {nope}) => ({nope})`
//   2. Caller passes valid input matching `needs`: `{ email: "x" }`
//   3. `validateNeedsOutput` parses, returns `{ email: "x" }` (validated)
//   4. `body({ email: "x" })` runs; `{ nope }` destructure → `nope = undefined`
//   5. Outgoing HTTP body: `{ nope: undefined }` — silently wrong request,
//      no exception, no validation failure, possibly accepted by server.
//
// This is a real gap. To close, either:
//   - Ship a `defineHttpCase<T>(case)` factory that captures `Needs` via
//     `<const T>` generic from the case literal, OR
//   - Wait for / construct a recursive-self-referential mapped type that
//     extracts each case's Needs from its `needs` field.
// Marked open P2 in v3.2 RFR; deferred to a follow-up commit/RFR cycle.
// =============================================================================

{
  // Authoring with matching annotation — compiles (correct usage).
  const _good = api("body-typed.good", {
    endpoint: "POST /x",
    cases: {
      ok: {
        description: "good body shape",
        needs: s<{ email: string }>(),
        body: ({ email }: { email: string }) => ({ email }),
        expect: { status: 200 },
      },
    },
  });
  void _good;

  // Drift case: annotation says `{ nope }` but `needs` says `{ email }`.
  // CURRENTLY COMPILES — this is the gap. Runtime `validateNeedsOutput`
  // catches the mismatch when the case actually executes (overlay/flow/
  // explicit input all gate on the `needs` schema before reaching `body`).
  const _drift = api("body-typed.drift", {
    endpoint: "POST /x",
    cases: {
      ok: {
        description: "drift between needs and body annotation",
        needs: s<{ email: string }>(),
        body: ({ nope }: { nope: string }) => ({ nope }),
        expect: { status: 200 },
      },
    },
  });
  void _drift;
}

// =============================================================================
// Test 3-bis: FlowBuilder.step enforces `in` presence matches case needs
//
// v10 invariant: a flow step's `in` binding MUST be present iff the case
// declares `needs`. Spike 0 Finding 3 (N8). Historically caught by conditional
// tuple type on step(); the two-overload form doesn't catch it because
// TS falls to overload 2 and `() => X` is bivariant-assignable to `() => void`.
// =============================================================================

{
  const needsCase = api("user.step.needs", {
    endpoint: "GET /x",
    cases: {
      ok: {
        description: "needs",
        needs: s<{ token: string }>(),
        expect: { status: 200 },
      },
    },
  });

  const noNeedsCase = api("user.step.void", {
    endpoint: "GET /y",
    cases: {
      ok: {
        description: "no needs",
        expect: { status: 200 },
      },
    },
  });

  const needsRef = needsCase.case("ok");
  const voidRef = noNeedsCase.case("ok");

  // ✅ needsRef with `in` (typed) — should compile
  contract.flow("ok-1").step(needsRef, {
    in: () => ({ token: "t" }),
  });

  // ✅ voidRef without bindings — should compile
  contract.flow("ok-2").step(voidRef);

  // ✅ voidRef with only `out` — should compile
  contract.flow("ok-3").step(voidRef, {
    out: (_s, res: any) => ({ status: res?.status }),
  });

  // ❌ needsRef without bindings — should NOT compile
  // @ts-expect-error — case declares `needs`; bindings.in is required
  contract.flow("bad-1").step(needsRef);

  // ❌ voidRef with `in` — should NOT compile
  contract.flow("bad-2").step(voidRef, {
    // @ts-expect-error — case has no `needs`; `in` is not accepted on void-input case
    in: () => ({ anything: 1 }),
  });
}

// =============================================================================
// Test 3: no-needs case accepts void-returning bootstrap
// =============================================================================

{
  const health = api("health.read", {
    endpoint: "GET /health",
    cases: {
      ok: {
        description: "service healthy",
        expect: { status: 200 },
      },
    },
  });

  const ref = health.case("ok");

  // Ref input phantom should be `void` (no needs declared)
  type RefInput = typeof ref extends { __phantom_inputs?: infer I } ? I : never;
  const _voidOk: RefInput = undefined as void;

  // Void return OK for no-needs case
  const noNeedsOverlay = contract.bootstrap(ref, async (_ctx) => {
    /* pure side-effect prep */
  });

  void noNeedsOverlay;
}
