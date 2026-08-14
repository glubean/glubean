/**
 * Type-level tests for GraphQL contract case factories.
 *
 * These are compile-only checks. They prove `defineGraphqlCase<Needs>` locks
 * the logical input shape across `needs`, `variables`, and `headers`, and that
 * the curried `graphqlCase(schema)(case)` does the same with NOTHING defaulted:
 * `N` is inferred from the schema VALUE (first call) and `C` from the case
 * literal (second call), so the case keeps its literal type — which is what
 * `InferGraphqlResponse` / `InferGraphqlVariables` read.
 */

import { contract } from "@glubean/sdk";
import type { SchemaLike } from "@glubean/sdk";
import { defineGraphqlCase, graphqlCase } from "../index.js";
import type {
  GraphqlCaseBody,
  GraphqlContractCase,
  InferGraphqlResponse,
  InferGraphqlVariables,
} from "../index.js";
import type { GraphQLClient } from "../index.js";

function s<T>(): SchemaLike<T> {
  return {} as SchemaLike<T>;
}

{
  const _good = defineGraphqlCase<{ token: string; userId: string }>({
    description: "fetch user",
    needs: s<{ token: string; userId: string }>(),
    query: "query User($id: ID!) { user(id: $id) { id } }",
    variables: ({ userId }) => ({ id: userId }),
    headers: ({ token }) => ({ authorization: `Bearer ${token}` }),
    expect: { httpStatus: 200, errors: "absent" },
  });
  void _good;

  const _variablesDrift = defineGraphqlCase<{ userId: string }>({
    description: "drift variables input",
    needs: s<{ userId: string }>(),
    query: "query User($id: ID!) { user(id: $id) { id } }",
    // @ts-expect-error -- variables input must match `{ userId: string }`.
    variables: ({ wrong }: { wrong: string }) => ({ id: wrong }),
  });
  void _variablesDrift;

  const _headersDrift = defineGraphqlCase<{ token: string }>({
    description: "drift headers input",
    needs: s<{ token: string }>(),
    query: "query Me { me { id } }",
    // @ts-expect-error -- headers input must match `{ token: string }`.
    headers: ({ missing }: { missing: string }) => ({ authorization: missing }),
  });
  void _headersDrift;
}

// =============================================================================
// graphqlCase(schema)(case) — the curried factory.
// =============================================================================

declare const client: GraphQLClient;
const api = contract.graphql.with("api", { client });

{
  // ---------------------------------------------------------------------
  // 1. Positive contextual typing: the action-field param IS the schema's
  // output type — inferred, never annotated.
  // ---------------------------------------------------------------------
  const typedInput = graphqlCase(s<{ token: string; userId: string }>())({
    description: "fetch user",
    query: "query User($id: ID!) { user(id: $id) { id } }",
    variables: (input) => {
      // Proves `input` is `{token, userId}` and NOT implicitly `any` (which
      // would make the drift assertions below vacuous). `any` here is the real
      // hazard: `variables?: Vars | ((input) => Vars)` collapses to `any` if
      // the body type's `Vars` slot is `any`, silently dropping the guard.
      const userId: string = input.userId;
      return { id: userId };
    },
    headers: ({ token }) => ({ authorization: `Bearer ${token}` }),
    expect: {
      httpStatus: 200,
      errors: "absent",
      schema: s<{ user: { id: string } }>(),
    },
    verify: async (_ctx, res) => {
      // `res` is GraphqlCaseResult<any> — see the factory's JSDoc for why it is
      // NOT narrowed here (GraphQL's `Res` is contract-level).
      void res.data;
      const status: number = res.httpStatus;
      void status;
    },
  });
  void typedInput;

  // ---------------------------------------------------------------------
  // 2. Drift guard: a key that is not on the schema is a compile error on
  // every action field.
  // ---------------------------------------------------------------------
  const _driftVariables = graphqlCase(s<{ userId: string }>())({
    description: "drift variables",
    query: "q",
    // @ts-expect-error -- `wrongKey` is not on Needs `{userId: string}`.
    variables: ({ wrongKey }) => ({ id: wrongKey }),
  });
  void _driftVariables;

  const _driftHeaders = graphqlCase(s<{ token: string }>())({
    description: "drift headers",
    query: "q",
    // @ts-expect-error -- `missing` is not on Needs `{token: string}`.
    headers: ({ missing }) => ({ authorization: missing }),
  });
  void _driftHeaders;

  // ---------------------------------------------------------------------
  // 3. Typed response preserved: `expect.schema` survives into the case's
  // type, so `InferGraphqlResponse` resolves it — the motivation for the
  // curried shape.
  // ---------------------------------------------------------------------
  type CurriedResponse = InferGraphqlResponse<typeof typedInput>;
  const _responseIsTyped: CurriedResponse = { user: { id: "u1" } };
  // @ts-expect-error -- response is `{user: {id: string}}`, so a wrong shape fails.
  const _responseNotAny: CurriedResponse = { wrong: 1 };
  // `unknown` is only assignable TO `unknown` — false here proves it resolved.
  const _responseNotUnknown: [unknown] extends [CurriedResponse] ? true : false = false;
  void _responseIsTyped;
  void _responseNotAny;
  void _responseNotUnknown;

  // Variables resolve from the literal too. The second assertion rules out
  // BOTH `unknown` and `any` (`[unknown] extends [any]` is also true).
  type CurriedVariables = InferGraphqlVariables<typeof typedInput>;
  const _variablesTyped: CurriedVariables = { id: "u1" };
  const _variablesResolved: [unknown] extends [CurriedVariables] ? true : false = false;
  void _variablesTyped;
  void _variablesResolved;

  // Contrast — the same case through defineGraphqlCase degrades to `unknown`,
  // because its nominal `GraphqlContractCase<Vars, Res, Needs>` return pins
  // `Res` to the parameter's DEFAULT unless the author also spells it out.
  const nominalCase = defineGraphqlCase<{ userId: string }>({
    description: "fetch user",
    needs: s<{ userId: string }>(),
    query: "q",
    variables: ({ userId }) => ({ id: userId }),
    expect: { schema: s<{ user: { id: string } }>() },
  });
  const _nominalIsUnknown: [unknown] extends [
    InferGraphqlResponse<typeof nominalCase>,
  ]
    ? true
    : false = true;
  void _nominalIsUnknown;

  // ---------------------------------------------------------------------
  // 3b. The static branch must REJECT function values. `variables?: Vars |
  // ((input) => Vars)` is a union, so a permissive static slot (a bare
  // `object`, say) would accept every function — TS treats functions as
  // objects — and silently re-admit three drift-bypassing forms, each
  // corrupting the operation at runtime. `Vars` is `Record<string, unknown>`,
  // which has no such leak; these pin that (gRPC needs an explicit guard for
  // the same three forms because its `Req` slot must also admit protobuf
  // INTERFACES, which a record rejects — see `GrpcRequestMessage`).
  // ---------------------------------------------------------------------

  // (i) A pre-declared builder whose ANNOTATED parameter drifts from the schema.
  const driftingBuilder = (i: { wrongKey: string }) => ({ id: i.wrongKey });
  const _staticDrift = graphqlCase(s<{ userId: string }>())({
    description: "pre-declared builder with a drifting annotated param",
    query: "q",
    // @ts-expect-error -- neither branch may accept it.
    variables: driftingBuilder,
  });
  void _staticDrift;

  // (ii) An `async` builder — its Promise is not a variables object.
  const _asyncBuilder = graphqlCase(s<{ userId: string }>())({
    description: "async variables builder",
    query: "q",
    // @ts-expect-error -- a Promise is not a variables record.
    variables: async ({ userId }) => ({ id: userId }),
  });
  void _asyncBuilder;

  // (iii) A builder returning a PRIMITIVE.
  const _primitiveBuilder = graphqlCase(s<{ userId: string }>())({
    description: "variables builder returning a primitive",
    query: "q",
    // @ts-expect-error -- a string is not a variables record.
    variables: ({ userId }) => userId,
  });
  void _primitiveBuilder;

  // ---------------------------------------------------------------------
  // 4. Single declaration site: `needs` belongs to the factory call, never
  // to the case literal (runtime throws on it too).
  // ---------------------------------------------------------------------
  const _doubleDeclared = graphqlCase(s<{ userId: string }>())({
    description: "declares needs twice",
    query: "q",
    // @ts-expect-error -- `needs` is owned by the factory; GraphqlCaseBody pins
    // the field to `never` so writing it here cannot compile.
    needs: s<{ userId: string }>(),
  });
  void _doubleDeclared;

  // ...but an explicit `needs: undefined` DECLARES NOTHING and compiles:
  // `exactOptionalPropertyTypes` is off, so `needs?: never` admits undefined.
  // The runtime tolerates it for exactly this reason (see graphql-case.test.ts)
  // — the two layers must promise the same thing.
  const _explicitUndefined = graphqlCase(s<{ userId: string }>())({
    description: "explicit undefined declares nothing",
    query: "q",
    needs: undefined,
    variables: ({ userId }) => ({ id: userId }),
  });
  void _explicitUndefined;

  // ---------------------------------------------------------------------
  // 5. Zero-arg form for cases with no logical input.
  // ---------------------------------------------------------------------
  const noNeedsCase = graphqlCase()({
    description: "no logical input",
    query: "query Health { health }",
  });
  const _assignableAsCase: GraphqlContractCase = noNeedsCase;
  void _assignableAsCase;

  // Still one declaration site in the zero-arg form.
  const _zeroArgDoubleDeclared = graphqlCase()({
    description: "declares needs without a factory schema",
    query: "q",
    // @ts-expect-error -- `needs` is owned by the factory in BOTH forms.
    needs: s<{ userId: string }>(),
  });
  void _zeroArgDoubleDeclared;

  // ---------------------------------------------------------------------
  // 6. The returned case is accepted by the real contract factory, and the
  // resulting `.case()` ref carries the per-case Needs.
  // ---------------------------------------------------------------------
  const users = api("user.fetch", {
    cases: { ok: typedInput, health: noNeedsCase },
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
// Regression: a case body written against the EXPORTED `GraphqlCaseBody<N>`
// annotation must survive the factory.
//
// `GraphqlCaseBody` carries the `needs?: never` single-declaration guard, so a
// bare `C & { needs: SchemaLike<N> }` return type intersects `never` with a
// required property and collapses `needs` — taking core's `InferCaseInput` (and
// with it the whole `.case()` I/O chain) down to `never`. The return type drops
// the guarded key first (`Omit<C, "needs"> & ...`), which is what these assert.
// =============================================================================

{
  type Needs = { email: string };

  const preAnnotated: GraphqlCaseBody<Needs> = {
    description: "pre-annotated case body",
    query: "mutation Signup($email: String!) { signup(email: $email) { id } }",
    variables: ({ email }) => ({ email }),
  };

  const built = graphqlCase(s<Needs>())(preAnnotated);

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
  const preContract = api("user.signup", { cases: { ok: built } });
  const preRef = preContract.case("ok");
  type PreRefInput = typeof preRef extends { __phantom_inputs?: infer I } ? I : never;
  const _inputIsExactlyNeeds: [PreRefInput] extends [Needs]
    ? [Needs] extends [PreRefInput]
      ? true
      : false
    : false = true;
  void _inputIsExactlyNeeds;

  // NOTE the deliberate non-assertion: annotating the body as
  // `GraphqlCaseBody<Needs>` WIDENS the literal, so `expect.schema` presence is
  // erased and `InferGraphqlResponse` degrades on this path. That is the cost of
  // pre-annotating, not a regression — the inline-literal path keeps it.
}
