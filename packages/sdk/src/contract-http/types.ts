/**
 * HTTP-specific types for the built-in HTTP adapter.
 *
 * These types live inside the SDK's `contract-http/` subdirectory (HTTP is
 * built-in for zero-config UX) but they go through the same
 * `ContractProtocolAdapter` interface as any future plugin protocol. Core
 * never imports from this file.
 *
 * Source-of-truth for user-facing authoring types (HttpContractSpec,
 * ContractCase, ContractExpect, etc.).
 */

import type { HttpClient, SchemaLike, TestContext } from "../types.js";
import type {
  BaseCaseSpec,
  Extensions,
  ProtocolContract,
} from "../contract-types.js";

// =============================================================================
// Security schemes
// =============================================================================

/**
 * HTTP security scheme declaration for contract instances.
 * Maps to OpenAPI `securitySchemes`. Authoritative metadata, not docs-only.
 */
export type HttpSecurityScheme =
  | "bearer"
  | "basic"
  | { type: "apiKey"; name: string; in: "header" | "query" }
  | { type: "oauth2"; flows: Record<string, unknown> }
  | null;

// =============================================================================
// Instance defaults (contract.http.with)
// =============================================================================

export interface HttpContractDefaults {
  /** Default HTTP client for all contracts in this instance. */
  client?: HttpClient;
  /**
   * Default response schema for non-2xx cases whose `expect.schema` is not
   * specified. Intended for project-wide error envelopes.
   */
  errorEnvelope?: SchemaLike<unknown>;
  /** Security scheme (authoritative, maps to OpenAPI). */
  security?: HttpSecurityScheme;
  /** Tags inherited by all contracts in this instance. */
  tags?: string[];
  /** Default feature grouping key. */
  feature?: string;
  /** OpenAPI extensions (x-* keys). Inherited by all contracts. */
  extensions?: Extensions;
}

// =============================================================================
// Request / response examples
// =============================================================================

export interface ContractExample<T = unknown> {
  value: T;
  summary?: string;
  description?: string;
}

/**
 * Response headers normalized to lowercase keys. Multi-value headers (e.g.
 * `Set-Cookie`) use `string[]`.
 */
export type NormalizedHeaders = Record<string, string | string[]>;

/**
 * Path or query parameter value. String shorthand or object with metadata.
 */
export type ParamValue =
  | string
  | {
      value: string;
      schema?: SchemaLike<unknown>;
      description?: string;
      required?: boolean;
      deprecated?: boolean;
    };

// =============================================================================
// Expect (response expectations)
// =============================================================================

export interface ContractExpect<T = unknown> {
  /** Expected HTTP status code. */
  status: number;
  /** Zod/Valibot schema for response body. */
  schema?: SchemaLike<T>;
  /** Response content-type. Default: "application/json". */
  contentType?: string;
  /** Response headers schema (normalized to lowercase keys). */
  headers?: SchemaLike<NormalizedHeaders>;
  /** Single response example (OpenAPI docs only). */
  example?: T;
  /** Named response examples (OpenAPI docs). */
  examples?: Record<string, ContractExample<T>>;
}

// =============================================================================
// Case spec
// =============================================================================

/**
 * Static-body shape for HTTP case `body`. A top-level string and string leaves
 * in plain objects/arrays resolve `{{KEY}}` templates at execution time.
 * Non-string BodyInit values (FormData, URLSearchParams, Blob, BufferSource,
 * and ReadableStream) are opaque to template traversal, then follow the normal
 * content-type dispatch; set the matching non-JSON content type to send one as
 * a raw body. Excludes `unknown`, which would swallow the function branch and
 * lose `Needs` typing. A function-form body follows the same runtime rules for
 * its return value. Enumerable accessor properties are rejected; use data
 * properties, including from the function form. In a JavaScript/TypeScript
 * string, write `\\{{KEY}}` to send the literal text `{{KEY}}`.
 */
export type HttpStaticBody =
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null
  | BodyInit;

/**
 * v0 HTTP case factory — closes the v3 P2 known-open ("HTTP body Needs
 * drift"). Inside a contract spec literal, TypeScript can't correlate
 * `needs: SchemaLike<X>` and `body: (input: Y) => ...` from sibling
 * fields — author can write drift between them and TS won't flag it
 * (`body` runs with `input.email` undefined when `body` destructures
 * a key that isn't on Needs).
 *
 * `defineHttpCase<Needs, T>` captures `Needs` once via the explicit
 * generic; the case literal is then checked against
 * `ContractCase<T, Needs>` so all action fields (`body`, `pathParams`,
 * `query`, `headers`) are constrained to `(input: Needs) => ...`. Drift
 * between `needs` and any action field becomes a compile error.
 *
 * Use it for cases that declare `needs` AND have function-valued action
 * fields. Cases without `needs` (or with only static action fields)
 * don't need the factory; the runtime invariants are unaffected either
 * way (this is a typing improvement only).
 *
 * **Typed flow `res.body`**: a `.step`/`.poll` lens types `res.body` from a case's
 * `expect.schema` (core's `ApplyCaseOutput`/`ExtractCaseResponse`) when the case is
 * written as an INLINE literal in the spec (`api(id, { cases: { ok: { ...,
 * expect: { schema } } } })`) — the literal keeps the `schema` key visible, and
 * ONLY a real schema types it (a docs-only `expect.example` does not).
 * `defineHttpCase(...)` returns the nominal `ContractCase<T, Needs>` (which erases
 * schema presence for drift-locking), so a case routed through it leaves flow
 * `res.body` as `unknown` — that's the trade for its compile-time case-shape +
 * needs-drift checks. {@link httpCase} resolves the trade: because its curried
 * shape lets TS INFER every type parameter, the case keeps its literal type
 * (`expect.schema` presence included) AND the drift guard. Prefer it; reach for
 * inline cases only when you don't need the guard.
 *
 * @deprecated Use {@link httpCase} — same drift guard with zero explicit
 * generics, and it preserves typed flow `res.body`. Before:
 * `defineHttpCase<{ email: string }>({ needs: Schema, body: ({ email }) => ... })`;
 * after: `httpCase(Schema)({ body: ({ email }) => ... })`.
 *
 * @example
 * ```ts
 * import { defineHttpCase } from "@glubean/sdk";
 * import { z } from "zod";
 *
 * const successCase = defineHttpCase<{ email: string }>({
 *   description: "creates a user",
 *   needs: z.object({ email: z.string() }),
 *   // body, pathParams, query, headers params now type-checked against
 *   // { email: string } — author can NOT write `({wrongKey}) => ...`.
 *   body: ({ email }) => ({ email }),
 *   expect: { status: 201 },
 * });
 *
 * const api = contract.http.with("users", { client });
 * export const createUser = api("user.create", {
 *   endpoint: "POST /users",
 *   cases: { success: successCase },
 * });
 * ```
 *
 * @param c The case spec to validate. Returned verbatim.
 */
export function defineHttpCase<Needs = void, T = unknown>(
  c: ContractCase<T, Needs>,
): ContractCase<T, Needs> {
  return c;
}

/**
 * Case body for {@link httpCase} — `ContractCase` WITHOUT `needs`; the factory
 * owns that field.
 *
 * `needs` is pinned to `never` rather than merely omitted: TypeScript runs no
 * excess-property check against a type parameter's CONSTRAINT, so a bare
 * `Omit<...>` would silently absorb a stray `needs` key into the inferred case
 * type and leave two competing declarations of the same schema. The `never`
 * makes writing a schema there a compile error at the offending property. An
 * explicit `needs: undefined` still passes — `exactOptionalPropertyTypes` is
 * off in this repo and it declares nothing anyway.
 */
export type HttpCaseBody<N> = Omit<ContractCase<any, N>, "needs"> & {
  needs?: never;
};

/**
 * Curried HTTP case factory — {@link defineHttpCase}'s needs-drift guard with
 * zero explicit generics, and without its typed-response trade. Prefer this.
 *
 * **Why curried.** TypeScript can't correlate sibling fields of one object
 * literal, so `needs: SchemaLike<X>` never types the `body: (input) => ...`
 * written beside it — a factory has to capture `Needs` first. But TS also has
 * no PARTIAL type-argument inference: the moment an author writes
 * `defineHttpCase<Needs>(...)`, every remaining type parameter falls back to
 * its default and the case widens to the nominal `ContractCase<T, Needs>`.
 * Splitting the call in two leaves nothing to default — `N` is inferred from
 * the schema VALUE in the first call, `C` from the case literal in the second
 * (contextually typed by `HttpCaseBody<N>`, which is what still threads `N`
 * into the action fields).
 *
 * What that buys over `defineHttpCase`:
 * - **No explicit generics.** The schema is written once, as a value, and the
 *   whole case is checked against it.
 * - **Drift guard on all four action fields** — `body` / `pathParams` / `query`
 *   / `headers` (plus the deprecated `params` alias) take `(input: N) => ...`,
 *   so destructuring a key that isn't on `N` is a compile error instead of a
 *   silently `undefined` field in the outgoing request.
 * - **Typed flow `res.body`.** The case keeps its LITERAL type — including the
 *   presence of `expect.schema` — so core's `ExtractCaseResponse` /
 *   `ApplyCaseOutput` type a `.call`/`.poll` lens's `res.body` from that schema
 *   instead of degrading it to `unknown`.
 * - **One declaration site.** A `needs` SCHEMA inside the case literal is both a
 *   compile error (see {@link HttpCaseBody}) and a runtime `Error`. The one
 *   tolerated form is an explicit `needs: undefined`, which declares nothing:
 *   `exactOptionalPropertyTypes` is off here, so `needs?: never` admits it, and
 *   every runtime reader already treats undefined as "no needs" — rejecting it
 *   would make the type layer and the runtime promise different things.
 *
 * Runtime output is VALUE-IDENTICAL to the pre-migration shape — a case that
 * declared `needs` inline — because the factory only spreads the schema back
 * in. Migrating an existing case moves neither its projection nor its
 * `canonicalHash`.
 *
 * `verify(ctx, res)`'s `res` is not inferred from `expect.schema` — that would
 * need a second inference pass over the same literal. Annotate the parameter
 * when you want it typed; the schema still validates the response at runtime.
 *
 * @example
 * ```ts
 * import { contract, httpCase, workflow } from "@glubean/sdk";
 * import { z } from "zod";
 *
 * const createUser = httpCase(z.object({ email: z.string(), token: z.string() }))({
 *   description: "creates a user",
 *   // `input` is { email: string; token: string } — inferred, never annotated.
 *   body: ({ email }) => ({ email }),
 *   headers: ({ token }) => ({ authorization: `Bearer ${token}` }),
 *   expect: { status: 201, schema: z.object({ id: z.string() }) },
 * });
 *
 * const api = contract.http.with("users", { client });
 * export const users = api("user.create", {
 *   endpoint: "POST /users",
 *   cases: { createUser },
 * });
 *
 * // ...and the flow lens sees the schema: `res.body` is { id: string }.
 * workflow("signup").call("create", users.case("createUser"), {
 *   in: () => ({ email: "a@b.c", token: "t" }),
 *   out: (state, res) => ({ ...state, userId: res.body.id }),
 * });
 * ```
 *
 * @param needs The case's logical input schema — declared here, exactly once.
 *   Omit the argument entirely for a case with no logical input; that form
 *   returns the case unchanged and still rejects a literal `needs`.
 * @returns A function taking the case literal, returning it with `needs` attached.
 */
export function httpCase<N>(
  needs: SchemaLike<N>,
): <const C extends HttpCaseBody<N>>(
  c: C,
  // `Omit<C, "needs">` before the intersection, never a bare `C & {...}`: a case
  // written against the exported `HttpCaseBody<X>` annotation carries the
  // `needs?: never` guard INTO `C`, and intersecting that with the required
  // `needs: SchemaLike<N>` collapses the property (and with it `InferCaseInput`)
  // to `never`. Dropping the guarded key first keeps every other property's
  // literal type intact, so `expect.schema` still types flow `res.body`.
) => Omit<C, "needs"> & { needs: SchemaLike<N> };
export function httpCase(): <const C extends HttpCaseBody<void>>(c: C) => C;
export function httpCase(needs?: SchemaLike<unknown>) {
  // Keep JS consumers aligned with the type-level `needs?: never` — a literal
  // `needs` SCHEMA is a hard error in BOTH forms, so it always has exactly one
  // declaration site. The zero-arg form returns the case unchanged.
  //
  // The two overloads above are the checked authoring surface; this
  // implementation is untyped glue (a concrete param type is not compatible
  // with both of them).
  return (c: any) => {
    // Value check, NOT hasOwnProperty: `exactOptionalPropertyTypes` is off in
    // this repo, so `needs?: never` accepts an explicit `needs: undefined` and
    // the runtime must accept it too, or the two layers promise different
    // things. Tolerating it is safe because every runtime reader treats
    // undefined as "no needs declared": core's §5.1 branches are falsy checks
    // (`contract-core.ts` `if (!needsSchema)` / `if (needsSchema)`), the
    // projection records `hasNeeds: c.needs !== undefined`, and the inbound
    // field guard also compares `!== undefined`. In the schema form the spread
    // below overwrites the key anyway.
    if (c.needs !== undefined) {
      throw new Error(
        "httpCase: do not declare `needs` inside the case literal — the factory " +
          "owns that field. Declare it once as `httpCase(schema)({ ... })` and " +
          "remove `needs` from the case object.",
      );
    }
    return needs === undefined ? c : { ...c, needs };
  };
}

export interface ContractCase<T = unknown, Needs = void> extends BaseCaseSpec {
  /**
   * Per-case logical input schema. Redeclares the `BaseCaseSpec.needs` field
   * with the case-specific `Needs` parameter so author-provided schema and
   * function-valued action field parameter types stay locked together —
   * preventing drift between `needs: SchemaLike<X>` and `body: ({wrong}) => ...`.
   */
  needs?: SchemaLike<Needs>;

  /** Per-case HTTP client override. */
  client?: HttpClient;
  /** Why this case exists — required. */
  description: string;
  /** Expected response. */
  expect: ContractExpect<T>;

  /**
   * Request body (for POST/PUT/PATCH). Either a static value (HttpStaticBody)
   * or a function of the case's logical input (matching `needs`). v10
   * attachment model: no more setup state — input comes from overlay
   * bootstrap, explicit `--input-json`, or flow `.step() in` lens.
   *
   * The static branch deliberately uses concrete types (not `unknown`)
   * because `unknown` in a union swallows the function branch — `Needs`
   * typing on the function param would then be silently bypassed.
   */
  body?: HttpStaticBody | ((input: Needs) => unknown);

  /** Request content type override for this case. */
  contentType?: string;

  /**
   * URL **path** parameters — values substituted into the endpoint's `:key`
   * segments (e.g. `pathParams: { id: "u_1" }` resolves `GET /users/:id` to
   * `GET /users/u_1`). Values can be `ParamValue` objects for OpenAPI
   * metadata. Query-string parameters go in `query`, not here.
   */
  pathParams?: Record<string, ParamValue> | ((input: Needs) => Record<string, string>);

  /**
   * @deprecated Renamed to `pathParams` — this field only ever filled the
   * endpoint's `:key` PATH segments, never the query string, and the bare
   * name `params` hid that. Same type, same behavior; setting both on one
   * case is a construction-time error. Will be removed in a future major.
   */
  params?: Record<string, ParamValue> | ((input: Needs) => Record<string, string>);

  /** Query parameters. */
  query?: Record<string, ParamValue> | ((input: Needs) => Record<string, string>);

  /**
   * Request headers merged with client headers. String data-property values
   * resolve `{{KEY}}` templates at execution time. Enumerable accessors are
   * rejected; a function form must return a data-property record. Write
   * `\\{{KEY}}` in source to send the literal text `{{KEY}}`.
   */
  headers?: Record<string, string> | ((input: Needs) => Record<string, string>);

  /** Business-logic verify — runs after status and schema validation. */
  verify?: (ctx: TestContext, res: T) => Promise<void>;
}

// =============================================================================
// Inbound case spec (inbound-contract-design §9.2)
// =============================================================================

/**
 * Declarative signature expectation for an inbound case. `scheme` is a
 * REGISTERED verifier name (see `registerSignatureVerifier`); `secretRef`
 * is a NAME into ctx.secrets — never a value. Projection / OpenAPI / Cloud
 * only ever see these names (design blind spot 9).
 */
export interface InboundSignatureSpec {
  /** Registered verifier name. Built-ins: "stripe-v1", "hmac-sha256". */
  scheme: "stripe-v1" | "hmac-sha256" | (string & {});
  /** Request header carrying the signature (lowercased for lookup). */
  header: string;
  /** Secrets NAME — resolved via ctx.secrets at match time, never projected as a value. */
  secretRef: string;
  /** Replay window for timestamped schemes (stripe-v1 default 5 min). */
  toleranceMs?: number;
}

/** Static header expectation for an inbound case (JSON-safe by construction). */
export type InboundHeaderMatcher = { present: true } | { eq: string };

/**
 * What the counterparty PROMISES to deliver. Validation order is the §9.4
 * taxonomy: signature first (over exact bytes), then parse, then type/
 * correlation discrimination, then `bodySchema`.
 */
export interface InboundExpect<T = unknown> {
  /** Validated AFTER authentication, on the parsed JSON body. */
  bodySchema: SchemaLike<T>;
  /** Static header expectations (checked on authenticated deliveries). */
  headers?: Record<string, InboundHeaderMatcher>;
  signature?: InboundSignatureSpec;
  /**
   * Latency promise in ms — documentation + the inbound poll's default
   * timeout. Measured evidence is `receivedAt` vs poll-node start
   * (design blind spot 4).
   */
  within?: number;
}

/**
 * An inbound contract case: the counterparty calls US. Declares the PROMISE
 * ("X will POST shape S, signed with K, within T") — the receiver transport
 * is supplied at the workflow side (`.poll(ref, { via })`, slice I3).
 *
 * NOT runnable (design §9.5): there is nothing to execute without a live
 * counterparty — no Test is registered, CLI runnable discovery skips it,
 * and `.call()`/flow `.step()` reject its ref. It appears in projection /
 * metadata with `direction: "inbound"`.
 *
 * `needs`/`runnability`/`requires`/`defaultRun`/`verifyRules` are omitted:
 * all are vocabulary of outbound execution (logical input / runnable
 * inventory / verify() companions) and have no meaning for a case that is
 * awaited, not run.
 */
export interface InboundContractCase<T = unknown>
  extends Omit<
    BaseCaseSpec,
    "needs" | "runnability" | "requires" | "defaultRun" | "verifyRules"
  > {
  direction: "inbound";
  /** Why this case exists — required (same rule as outbound cases). */
  description: string;
  expect: InboundExpect<T>;
}

/**
 * Brand a case spec as inbound — the authoring helper for the `cases` map:
 *
 * ```ts
 * export const stripeWebhooks = api("stripe.webhooks", {
 *   endpoint: "POST /webhooks/stripe",   // where the counterparty posts
 *   cases: {
 *     paymentIntentCreated: inboundCase({
 *       description: "Stripe posts payment_intent.created, signed",
 *       expect: {
 *         bodySchema: PaymentIntentCreatedEvent,
 *         signature: { scheme: "stripe-v1", header: "stripe-signature", secretRef: "WEBHOOK_SECRET" },
 *         within: 60_000,
 *       },
 *     }),
 *   },
 * });
 * ```
 *
 * Writing `direction: "inbound"` inline in the literal is equivalent.
 */
export function inboundCase<T = unknown>(
  spec: Omit<InboundContractCase<T>, "direction">,
): InboundContractCase<T> {
  return { ...spec, direction: "inbound" };
}

/** Runtime discriminator for inbound case specs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- guard target
// must be InboundContractCase<any> so union narrowing also excludes
// InboundContractCase<any> members (an <unknown> target fails to subsume them).
export function isInboundCase(c: unknown): c is InboundContractCase<any> {
  return (
    !!c &&
    typeof c === "object" &&
    (c as { direction?: unknown }).direction === "inbound"
  );
}

/** Any case authorable in an HTTP contract's `cases` map. */
export type HttpCase<T = unknown, Needs = void> =
  | ContractCase<T, Needs>
  | InboundContractCase<T>;

// =============================================================================
// Request spec (contract-level)
// =============================================================================

/**
 * Structured request specification. Can be a bare SchemaLike (JSON body
 * shorthand) or a full object with content type / headers / examples.
 */
export type RequestSpec =
  | SchemaLike<unknown>
  | {
      body?: SchemaLike<unknown>;
      contentType?: string;
      headers?: SchemaLike<Record<string, string>>;
      example?: unknown;
      examples?: Record<string, ContractExample<unknown>>;
    };

// =============================================================================
// Contract spec (HTTP)
// =============================================================================

export interface HttpContractSpec<
  Cases extends Record<string, HttpCase<any, any>> = Record<string, HttpCase>,
> {
  /** HTTP method + path, e.g. "POST /users" or "GET /runs/:runId". */
  endpoint: string;

  description?: string;
  feature?: string;

  /** Default HTTP client for all cases. */
  client?: HttpClient;

  /**
   * Endpoint-level request schema (OpenAPI docs + no-runtime validation).
   * Bare SchemaLike = JSON body shorthand; object = full structured spec.
   */
  request?: RequestSpec;

  tags?: string[];
  deprecated?: string;
  extensions?: Extensions;

  /** Named spec cases. */
  cases: Cases;
}

// =============================================================================
// HTTP payload schemas (for ContractProtocolAdapter generics)
// =============================================================================

/**
 * Runtime (live) payload shape for the HTTP adapter. Contains SchemaLike
 * (Zod etc.) references. Converted to HttpSafeSchemas by adapter.normalize.
 */
export interface HttpPayloadSchemas {
  request?: {
    body?: SchemaLike<unknown>;
    contentType?: string;
    headers?: SchemaLike<Record<string, string>>;
    example?: unknown;
    examples?: Record<string, ContractExample<unknown>>;
  };
  response?: {
    status?: number;
    body?: SchemaLike<unknown>;
    contentType?: string;
    headers?: SchemaLike<NormalizedHeaders>;
    example?: unknown;
    examples?: Record<string, ContractExample<unknown>>;
  };
  params?: Record<string, HttpParamSchema>;
  query?: Record<string, HttpParamSchema>;
  security?: HttpSecurityScheme;

  /**
   * Present only on cases with `direction: "inbound"` — the counterparty's
   * promise. `signature.secretRef` is a secrets NAME, safe by construction.
   */
  inbound?: {
    body?: SchemaLike<unknown>;
    headers?: Record<string, InboundHeaderMatcher>;
    signature?: InboundSignatureSpec;
    within?: number;
  };

  /**
   * Type-only markers read by core's `InferAcceptKey` / `InferRawOutcome` /
   * `ApplyCaseOutput` hooks so a flow step's `accept` is typed as `number`
   * (status), `out`'s `res` becomes the raw `HttpFlowCaseOutput` under `accept`,
   * and the primary `out`/`until` `res` is `HttpFlowCaseOutput` with `body` typed
   * from the case's `expect.schema`. NEVER set at runtime — they exist purely so
   * core stays protocol-agnostic while HTTP supplies the concrete types.
   */
  readonly __acceptKey?: number;
  readonly __rawOutcome?: HttpFlowCaseOutput;
  readonly __caseOutputShape?: HttpFlowCaseOutput;
}

/**
 * JSON-safe payload shape produced by adapter.normalize. All SchemaLike
 * objects converted to JSON Schema plain objects. Safe to JSON.stringify.
 */
export interface HttpSafeSchemas {
  request?: {
    body?: unknown;
    contentType?: string;
    headers?: unknown;
    example?: unknown;
    examples?: Record<
      string,
      { value: unknown; summary?: string; description?: string }
    >;
  };
  response?: {
    status?: number;
    body?: unknown;
    contentType?: string;
    headers?: unknown;
    example?: unknown;
    examples?: Record<
      string,
      { value: unknown; summary?: string; description?: string }
    >;
  };
  params?: Record<string, HttpParamMeta>;
  query?: Record<string, HttpParamMeta>;
  security?: HttpSecurityScheme;

  /** Inbound promise (JSON-safe): `body` is JSON Schema; the rest is verbatim. */
  inbound?: {
    body?: unknown;
    headers?: Record<string, InboundHeaderMatcher>;
    signature?: InboundSignatureSpec;
    within?: number;
  };
}

export interface HttpParamSchema {
  schema?: SchemaLike<unknown>;
  description?: string;
  required?: boolean;
  deprecated?: boolean;
}

export interface HttpParamMeta {
  schema?: unknown;
  description?: string;
  required?: boolean;
  deprecated?: boolean;
}

// =============================================================================
// Contract-level HTTP meta
// =============================================================================

export interface HttpContractMeta {
  /** Parsed from endpoint string. */
  method?: string;
  path?: string;
}

// =============================================================================
// Type-level infer helpers for ContractCaseRef
// =============================================================================

/**
 * Extract the "case inputs" shape from an HTTP PayloadSchemas.
 * Used by ProtocolContract<Spec, HttpPayloadSchemas>.case(k) so that
 * FlowBuilder.step lens functions get correct typing.
 */
export type InferHttpInputs<_P = HttpPayloadSchemas> = {
  body?: unknown;
  pathParams?: Record<string, string>;
  /** @deprecated Renamed to `pathParams` (same shape). */
  params?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
};

/**
 * Extract the "case output" shape — what the HTTP adapter returns from
 * executeCaseInFlow. Consumed by flow lens `out(state, response)`.
 */
export type InferHttpOutput<_P = HttpPayloadSchemas> = {
  status: number;
  headers: NormalizedHeaders;
  body: unknown;
};

// =============================================================================
// Flow step output from HTTP adapter.executeCaseInFlow
// =============================================================================

export interface HttpFlowCaseOutput {
  status: number;
  headers: NormalizedHeaders;
  body: unknown;
}

/**
 * Extract a case's primary response body type from its `expect.schema`
 * (`SchemaLike<T>`). Falls back to `unknown` when the case declares no schema.
 * Used to type the flow lens `res.body` per-case (so `.step`/`.poll` lenses get
 * `res.body: T` instead of `unknown` — no cast needed).
 */
// =============================================================================
// Factory types
// =============================================================================

/**
 * Callable + chainable HTTP contract factory. Returned by
 * `contract.http.with("name", defaults)`.
 */
export interface HttpContractFactory {
  // `const Cases` preserves each case's literal type — esp. an inline case's
  // `expect.schema` — through the `api(id, {cases})` call. Without it the cases
  // object widens to `ContractCase<any,any>` and core's `ApplyCaseOutput` (which
  // reads `Cases[K].expect.schema`) falls back to `unknown` for flow `res.body`.
  <const Cases extends Record<string, HttpCase<any, any>>>(
    id: string,
    spec: HttpContractSpec<Cases>,
  ): ProtocolContract<HttpContractSpec<Cases>, HttpPayloadSchemas, HttpContractMeta, Cases>;
  with(name: string, defaults: HttpContractDefaults): HttpContractFactory;
}

/**
 * Root `contract.http` — only .with() is callable; direct call requires
 * .with() first (enforces scoped-instance pattern for client injection).
 */
export interface HttpContractRoot {
  with(name: string, defaults: HttpContractDefaults): HttpContractFactory;
}
