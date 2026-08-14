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
  // CURRENTLY COMPILES — this is the gap, and runtime does NOT catch it.
  // validateNeedsOutput parses input against `needs` and returns the
  // validated `{ email }`; body then runs with `({ nope })` destructured
  // from `{ email }` → `nope === undefined` → silently produces
  // `{ nope: undefined }` request body. No exception, no validation
  // failure. KNOWN OPEN P2 until `defineHttpCase` or equivalent typing
  // mechanism lands; see block comment above for full rationale.
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

// =============================================================================
// Test 4: defineHttpCase<Needs> closes the v3 P2 known-open (HTTP body
// Needs drift). Inside a contract spec literal, `needs` and `body`
// param types can drift silently. The factory binds Needs once per
// case so all action fields are checked against it.
// =============================================================================

import { defineHttpCase } from "./index.js";

{
  // ✅ Correct: needs + body param types align — compiles.
  const _good = defineHttpCase<{ email: string }>({
    description: "creates user",
    needs: s<{ email: string }>(),
    body: ({ email }) => ({ email }),
    expect: { status: 201 },
  });
  void _good;

  // ✅ All action fields type-check against Needs.
  const _good2 = defineHttpCase<{ token: string; userId: string }>({
    description: "fetch user",
    needs: s<{ token: string; userId: string }>(),
    headers: ({ token }) => ({ authorization: `Bearer ${token}` }),
    pathParams: ({ userId }) => ({ userId }),
    expect: { status: 200 },
  });
  void _good2;

  // ✅ Deprecated alias `params` keeps the same Needs type-lock until removal.
  const _goodAlias = defineHttpCase<{ userId: string }>({
    description: "fetch user via deprecated alias",
    needs: s<{ userId: string }>(),
    params: ({ userId }) => ({ userId }),
    expect: { status: 200 },
  });
  void _goodAlias;

  // ❌ Drift: body destructures key not on Needs — must NOT compile.
  // This is the v3 P2 case that escaped TS without the factory.
  const _drift = defineHttpCase<{ email: string }>({
    description: "drift between needs and body annotation",
    needs: s<{ email: string }>(),
    // @ts-expect-error — body param type must be `{email: string}`,
    // not `{nope: string}`. Drift caught at compile time.
    body: ({ nope }: { nope: string }) => ({ nope }),
    expect: { status: 200 },
  });
  void _drift;

  // ❌ Drift: headers destructures key not on Needs — must NOT compile.
  const _drift2 = defineHttpCase<{ token: string }>({
    description: "headers drift",
    needs: s<{ token: string }>(),
    // @ts-expect-error — headers param type must be `{token: string}`.
    headers: ({ wrongKey }: { wrongKey: string }) => ({ x: wrongKey }),
    expect: { status: 200 },
  });
  void _drift2;
}

// =============================================================================
// Test 5: httpCase(schema)(case) — the curried factory. Same drift guard as
// defineHttpCase, but with NOTHING defaulted: `N` is inferred from the schema
// VALUE (first call) and `C` from the case literal (second call). So the case
// keeps its literal type — `expect.schema` presence included — and flow
// `res.body` stays typed, which defineHttpCase's nominal return erases.
// =============================================================================

import { httpCase } from "./index.js";
import type { ContractCase } from "./index.js";
import type { ExtractCaseResponse } from "./contract-types.js";

{
  // ---------------------------------------------------------------------
  // 5.1 Positive contextual typing: the action-field param IS the schema's
  // output type — inferred, never annotated.
  // ---------------------------------------------------------------------
  const _typedInput = httpCase(s<{ email: string; token: string }>())({
    description: "creates user",
    body: (input) => {
      // Proves `input` is `{email, token}` and NOT implicitly `any` (which
      // would make the 5.2 drift assertions vacuous).
      const email: string = input.email;
      return { email };
    },
    headers: ({ token }) => ({ authorization: `Bearer ${token}` }),
    pathParams: ({ email }) => ({ email }),
    query: ({ token }) => ({ token }),
    // `verify`'s `res` is not inferred from expect.schema — annotate to type it.
    verify: async (_ctx, res: { name: string }) => {
      void res.name;
    },
    expect: { status: 201, schema: s<{ name: string }>() },
  });
  void _typedInput;

  // ---------------------------------------------------------------------
  // 5.2 Drift guard: a key that is not on the schema is a compile error on
  // every action field (body / pathParams shown).
  // ---------------------------------------------------------------------
  const _driftBody = httpCase(s<{ email: string }>())({
    description: "body drift",
    // @ts-expect-error — `wrongKey` is not on Needs `{email: string}`.
    body: ({ wrongKey }) => ({ wrongKey }),
    expect: { status: 200 },
  });
  void _driftBody;

  const _driftPathParams = httpCase(s<{ userId: string }>())({
    description: "pathParams drift",
    // @ts-expect-error — `wrongKey` is not on Needs `{userId: string}`.
    pathParams: ({ wrongKey }) => ({ wrongKey }),
    expect: { status: 200 },
  });
  void _driftPathParams;

  // ---------------------------------------------------------------------
  // 5.3 Typed response preserved: `expect.schema` survives into the case's
  // type, so core's ExtractCaseResponse resolves the body — the motivation
  // for the curried shape.
  // ---------------------------------------------------------------------
  const schemaCase = httpCase(s<{ email: string }>())({
    description: "returns a named thing",
    body: ({ email }) => ({ email }),
    expect: { status: 200, schema: s<{ name: string }>() },
  });

  type CurriedResponse = ExtractCaseResponse<typeof schemaCase>;
  const _responseIsTyped: CurriedResponse = { name: "n" };
  // @ts-expect-error — response is `{name: string}`, so a wrong shape fails.
  const _responseNotAny: CurriedResponse = { wrong: 1 };
  // `unknown` is only assignable TO `unknown` — false here proves it resolved.
  const _responseNotUnknown: [unknown] extends [CurriedResponse] ? true : false = false;
  void _responseIsTyped;
  void _responseNotAny;
  void _responseNotUnknown;

  // Contrast — the same case through defineHttpCase degrades to `unknown`,
  // because its nominal `ContractCase<T, Needs>` return has `expect.schema?:`
  // OPTIONAL while ExtractCaseResponse matches `schema` as REQUIRED.
  const nominalCase = defineHttpCase<{ email: string }, { name: string }>({
    description: "returns a named thing",
    needs: s<{ email: string }>(),
    body: ({ email }) => ({ email }),
    expect: { status: 200, schema: s<{ name: string }>() },
  });
  const _nominalIsUnknown: [unknown] extends [
    ExtractCaseResponse<typeof nominalCase>,
  ]
    ? true
    : false = true;
  void _nominalIsUnknown;

  // ---------------------------------------------------------------------
  // 5.4 Single declaration site: `needs` belongs to the factory call, never
  // to the case literal (runtime throws on it too).
  // ---------------------------------------------------------------------
  const _doubleDeclared = httpCase(s<{ email: string }>())({
    description: "declares needs twice",
    // @ts-expect-error — `needs` is owned by the factory; HttpCaseBody pins
    // the field to `never` so writing it here cannot compile.
    needs: s<{ email: string }>(),
    expect: { status: 200 },
  });
  void _doubleDeclared;

  // ---------------------------------------------------------------------
  // 5.5 Zero-arg form for cases with no logical input.
  // ---------------------------------------------------------------------
  const noNeedsCase = httpCase()({
    description: "no content",
    expect: { status: 204 },
  });
  const _assignableAsCase: ContractCase = noNeedsCase;
  void _assignableAsCase;

  // Still one declaration site in the zero-arg form.
  const _zeroArgDoubleDeclared = httpCase()({
    description: "declares needs without a factory schema",
    // @ts-expect-error — `needs` is owned by the factory in BOTH forms.
    needs: s<{ email: string }>(),
    expect: { status: 204 },
  });
  void _zeroArgDoubleDeclared;

  // ---------------------------------------------------------------------
  // 5.6 The returned case is accepted by the real contract factory, and the
  // resulting `.case()` ref carries the schema-typed body.
  // ---------------------------------------------------------------------
  const users = api("user.create", {
    endpoint: "POST /users",
    cases: { ok: schemaCase, noContent: noNeedsCase },
  });

  const okRef = users.case("ok");

  // Needs threads through to the ref's phantom input.
  type OkInput = typeof okRef extends { __phantom_inputs?: infer I } ? I : never;
  const _okInput: OkInput = { email: "a@b.c" };
  // @ts-expect-error — proves the ref input is Needs, not `any`.
  const _okInputNotAny: OkInput = { completelyWrongField: "x" };
  void _okInput;
  void _okInputNotAny;

  // Flow lens output: `res.body` is typed from the case's `expect.schema`.
  type OkOutput = typeof okRef extends { __phantom_output?: infer O } ? O : never;
  const _okBodyName: string = ({} as OkOutput).body.name;
  void _okBodyName;
}
