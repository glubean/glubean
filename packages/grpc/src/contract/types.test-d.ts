/**
 * Type-level tests for gRPC contract case factories.
 *
 * These are compile-only checks. They prove `defineGrpcCase<Needs>` locks the
 * logical input shape across `needs`, `request`, and `metadata`, and that the
 * curried `grpcCase(schema)(case)` does the same with NOTHING defaulted: `N` is
 * inferred from the schema VALUE (first call) and `C` from the case literal
 * (second call), so the case keeps its literal type — which is what
 * `InferGrpcResponse` / `InferGrpcRequest` read.
 */

import { contract } from "@glubean/sdk";
import type { SchemaLike } from "@glubean/sdk";
import { defineGrpcCase, grpcCase } from "../index.js";
import type {
  GrpcCaseBody,
  GrpcClient,
  GrpcContractCase,
  InferGrpcRequest,
  InferGrpcResponse,
} from "../index.js";

function s<T>(): SchemaLike<T> {
  return {} as SchemaLike<T>;
}

{
  const _good = defineGrpcCase<{ token: string; userId: string }>({
    description: "fetch user",
    needs: s<{ token: string; userId: string }>(),
    request: ({ userId }) => ({ userId }),
    metadata: ({ token }) => ({ authorization: `Bearer ${token}` }),
    expect: { statusCode: 0 },
  });
  void _good;

  const _requestDrift = defineGrpcCase<{ userId: string }>({
    description: "drift request input",
    needs: s<{ userId: string }>(),
    // @ts-expect-error -- request input must match `{ userId: string }`.
    request: ({ wrong }: { wrong: string }) => ({ wrong }),
  });
  void _requestDrift;

  const _metadataDrift = defineGrpcCase<{ token: string }>({
    description: "drift metadata input",
    needs: s<{ token: string }>(),
    // @ts-expect-error -- metadata input must match `{ token: string }`.
    metadata: ({ missing }: { missing: string }) => ({ authorization: missing }),
  });
  void _metadataDrift;
}

// =============================================================================
// grpcCase(schema)(case) — the curried factory.
// =============================================================================

declare const client: GrpcClient;
const api = contract.grpc.with("api", { client });

{
  // ---------------------------------------------------------------------
  // 1. Positive contextual typing: the action-field param IS the schema's
  // output type — inferred, never annotated.
  // ---------------------------------------------------------------------
  const typedInput = grpcCase(s<{ token: string; userId: string }>())({
    description: "fetch user",
    request: (input) => {
      // Proves `input` is `{token, userId}` and NOT implicitly `any` (which
      // would make the drift assertions below vacuous). `any` here is the real
      // hazard: `request?: Req | ((input) => Req)` collapses to `any` if the
      // body type's `Req` slot is `any`, silently dropping the guard.
      const userId: string = input.userId;
      return { userId };
    },
    metadata: ({ token }) => ({ authorization: `Bearer ${token}` }),
    expect: { statusCode: 0, schema: s<{ user: { id: string } }>() },
    verify: async (_ctx, res) => {
      // `res` is GrpcCaseResult<any> — see the factory's JSDoc for why it is
      // NOT narrowed here (gRPC's `Res` is contract-level).
      void res.message;
      const code: number = res.status.code;
      void code;
    },
  });
  void typedInput;

  // ---------------------------------------------------------------------
  // 2. Drift guard: a key that is not on the schema is a compile error on
  // every action field.
  // ---------------------------------------------------------------------
  const _driftRequest = grpcCase(s<{ userId: string }>())({
    description: "drift request",
    // @ts-expect-error -- `wrongKey` is not on Needs `{userId: string}`.
    request: ({ wrongKey }) => ({ wrongKey }),
  });
  void _driftRequest;

  const _driftMetadata = grpcCase(s<{ token: string }>())({
    description: "drift metadata",
    // @ts-expect-error -- `missing` is not on Needs `{token: string}`.
    metadata: ({ missing }) => ({ authorization: missing }),
  });
  void _driftMetadata;

  // ---------------------------------------------------------------------
  // 3. Typed response preserved: `expect.schema` survives into the case's
  // type, so `InferGrpcResponse` resolves it — the motivation for the
  // curried shape.
  // ---------------------------------------------------------------------
  type CurriedResponse = InferGrpcResponse<typeof typedInput>;
  const _responseIsTyped: CurriedResponse = { user: { id: "u1" } };
  // @ts-expect-error -- response is `{user: {id: string}}`, so a wrong shape fails.
  const _responseNotAny: CurriedResponse = { wrong: 1 };
  // `unknown` is only assignable TO `unknown` — false here proves it resolved.
  const _responseNotUnknown: [unknown] extends [CurriedResponse] ? true : false = false;
  void _responseIsTyped;
  void _responseNotAny;
  void _responseNotUnknown;

  // The request message resolves from the literal too. The second assertion
  // rules out BOTH `unknown` and `any` (`[unknown] extends [any]` is also true).
  type CurriedRequest = InferGrpcRequest<typeof typedInput>;
  const _requestTyped: CurriedRequest = { userId: "u1" };
  const _requestResolved: [unknown] extends [CurriedRequest] ? true : false = false;
  void _requestTyped;
  void _requestResolved;

  // Contrast — the same case through defineGrpcCase degrades to `unknown`,
  // because its nominal `GrpcContractCase<Req, Res, Needs>` return pins `Res`
  // to the parameter's DEFAULT unless the author also spells it out.
  const nominalCase = defineGrpcCase<{ userId: string }>({
    description: "fetch user",
    needs: s<{ userId: string }>(),
    request: ({ userId }) => ({ userId }),
    expect: { schema: s<{ user: { id: string } }>() },
  });
  const _nominalIsUnknown: [unknown] extends [InferGrpcResponse<typeof nominalCase>]
    ? true
    : false = true;
  void _nominalIsUnknown;

  // ---------------------------------------------------------------------
  // 3b. An INTERFACE-typed request message is accepted. `GrpcCaseBody`'s `Req`
  // slot is `object`, not `Record<string, unknown>` — protobuf codegen emits
  // interfaces, which carry no implicit index signature and would be rejected
  // by a record-shaped static branch.
  // ---------------------------------------------------------------------
  interface GetUserRequest {
    userId: string;
  }
  const ifaceCase = grpcCase(s<{ userId: string }>())({
    description: "interface-typed request message",
    request: ({ userId }): GetUserRequest => ({ userId }),
  });
  void ifaceCase;

  // An interface-typed VALUE is accepted in the static branch too, and so is a
  // plain object literal — the `never` guards below must not cost either.
  const ifaceValue = {} as GetUserRequest;
  const ifaceStatic = grpcCase()({
    description: "interface-typed static request",
    request: ifaceValue,
  });
  const literalStatic = grpcCase()({
    description: "object-literal static request",
    request: { userId: "u1" },
  });
  void ifaceStatic;
  void literalStatic;

  // ---------------------------------------------------------------------
  // 3c. The static branch must REJECT function values. A bare `object` static
  // slot accepts every function (TS treats functions as objects), which
  // re-admits three drift-bypassing forms — each corrupting the request at
  // runtime, because `resolveRequest` calls anything `typeof === "function"`
  // and deep-merges the result. See `GrpcRequestMessage`.
  // ---------------------------------------------------------------------

  // (i) A pre-declared builder whose ANNOTATED parameter drifts from the
  // schema. The function branch rejects it on parameter contravariance; a
  // permissive static branch would silently re-accept it and void the guard.
  const driftingBuilder = (i: { wrongKey: string }) => ({ userId: i.wrongKey });
  const _staticDrift = grpcCase(s<{ userId: string }>())({
    description: "pre-declared builder with a drifting annotated param",
    // @ts-expect-error -- neither branch may accept it: the function branch
    // rejects the param, the static branch rejects callables.
    request: driftingBuilder,
  });
  void _staticDrift;

  // (ii) An `async` builder. Its Promise is not a message: deepMerge iterates
  // `Object.entries(promise)` and sends `{}`.
  const _asyncBuilder = grpcCase(s<{ userId: string }>())({
    description: "async request builder",
    // @ts-expect-error -- a Promise is not a request message (`then?: never`).
    request: async ({ userId }) => ({ userId }),
  });
  void _asyncBuilder;

  // (iii) A builder returning a PRIMITIVE. deepMerge would spread a string
  // into `{0: "u", 1: "1", ...}`.
  const _primitiveBuilder = grpcCase(s<{ userId: string }>())({
    description: "request builder returning a primitive",
    // @ts-expect-error -- a string is not a request message.
    request: ({ userId }) => userId,
  });
  void _primitiveBuilder;

  // ...and the union still does NOT collapse: a correctly shaped builder keeps
  // full contextual typing (proved by the `string` annotation, which would fail
  // on an implicit `any`) while a drifting key is still an error.
  const _guardStillLive = grpcCase(s<{ userId: string; amount: number }>())({
    description: "union did not collapse",
    request: (input) => {
      const userId: string = input.userId;
      const amount: number = input.amount;
      return { userId, amount };
    },
  });
  void _guardStillLive;

  const _guardStillLiveNegative = grpcCase(s<{ userId: string }>())({
    description: "union did not collapse — negative",
    // @ts-expect-error -- `nope` is not on Needs `{userId: string}`.
    request: ({ nope }) => ({ nope }),
  });
  void _guardStillLiveNegative;

  // ---------------------------------------------------------------------
  // 4. Single declaration site: `needs` belongs to the factory call, never
  // to the case literal (runtime throws on it too).
  // ---------------------------------------------------------------------
  const _doubleDeclared = grpcCase(s<{ userId: string }>())({
    description: "declares needs twice",
    // @ts-expect-error -- `needs` is owned by the factory; GrpcCaseBody pins
    // the field to `never` so writing it here cannot compile.
    needs: s<{ userId: string }>(),
  });
  void _doubleDeclared;

  // ...but an explicit `needs: undefined` DECLARES NOTHING and compiles:
  // `exactOptionalPropertyTypes` is off, so `needs?: never` admits undefined.
  // The runtime tolerates it for exactly this reason (see grpc-case.test.ts) —
  // the two layers must promise the same thing.
  const _explicitUndefined = grpcCase(s<{ userId: string }>())({
    description: "explicit undefined declares nothing",
    needs: undefined,
    request: ({ userId }) => ({ userId }),
  });
  void _explicitUndefined;

  // ---------------------------------------------------------------------
  // 5. Zero-arg form for cases with no logical input.
  // ---------------------------------------------------------------------
  const noNeedsCase = grpcCase()({
    description: "no logical input",
    expect: { statusCode: 0 },
  });
  const _assignableAsCase: GrpcContractCase = noNeedsCase;
  void _assignableAsCase;

  // Still one declaration site in the zero-arg form.
  const _zeroArgDoubleDeclared = grpcCase()({
    description: "declares needs without a factory schema",
    // @ts-expect-error -- `needs` is owned by the factory in BOTH forms.
    needs: s<{ userId: string }>(),
  });
  void _zeroArgDoubleDeclared;

  // ---------------------------------------------------------------------
  // 6. The returned case is accepted by the real contract factory, and the
  // resulting `.case()` ref carries the per-case Needs.
  // ---------------------------------------------------------------------
  const users = api("user.fetch", {
    target: "UserService/GetUser",
    cases: { ok: typedInput, ping: noNeedsCase, iface: ifaceCase },
  });

  const okRef = users.case("ok");
  type OkInput = typeof okRef extends { __phantom_inputs?: infer I } ? I : never;
  const _okInput: OkInput = { token: "t", userId: "u" };
  // @ts-expect-error -- proves the ref input is Needs, not `any`.
  const _okInputNotAny: OkInput = { completelyWrongField: "x" };
  void _okInput;
  void _okInputNotAny;
}

// =============================================================================
// Regression: a case body written against the EXPORTED `GrpcCaseBody<N>`
// annotation must survive the factory.
//
// `GrpcCaseBody` carries the `needs?: never` single-declaration guard, so a
// bare `C & { needs: SchemaLike<N> }` return type intersects `never` with a
// required property and collapses `needs` — taking core's `InferCaseInput` (and
// with it the whole `.case()` I/O chain) down to `never`. The return type drops
// the guarded key first (`Omit<C, "needs"> & ...`), which is what these assert.
// =============================================================================

{
  type Needs = { email: string };

  const preAnnotated: GrpcCaseBody<Needs> = {
    description: "pre-annotated case body",
    request: ({ email }) => ({ email }),
  };

  const built = grpcCase(s<Needs>())(preAnnotated);

  // `needs` must be the schema, NOT `never`.
  const _needsUsable: SchemaLike<Needs> = built.needs;
  const _needsNotNever: [(typeof built)["needs"]] extends [never] ? true : false = false;
  // Other fields stay reachable (a collapsed intersection makes the whole
  // object unusable, not just its `needs`).
  const _descReachable: string = built.description;
  void _needsUsable;
  void _needsNotNever;
  void _descReachable;

  // The whole `.case()` I/O chain still works off the built case, and the ref's
  // input is EXACTLY Needs — asserted both ways, since a one-way `extends` also
  // holds for `never`.
  const preContract = api("user.signup", {
    target: "UserService/Signup",
    cases: { ok: built },
  });
  const preRef = preContract.case("ok");
  type PreRefInput = typeof preRef extends { __phantom_inputs?: infer I } ? I : never;
  const _inputIsExactlyNeeds: [PreRefInput] extends [Needs]
    ? [Needs] extends [PreRefInput]
      ? true
      : false
    : false = true;
  void _inputIsExactlyNeeds;

  // NOTE the deliberate non-assertion: annotating the body as
  // `GrpcCaseBody<Needs>` WIDENS the literal, so `expect.schema` presence is
  // erased and `InferGrpcResponse` degrades on this path. That is the cost of
  // pre-annotating, not a regression — the inline-literal path keeps it.
}
