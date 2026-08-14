/**
 * gRPC contract types.
 *
 * User-facing authoring types + adapter-level payload types for the
 * gRPC contract adapter (single-package model — see
 * `internal/40-discovery/proposals/contract-grpc-graphql-expansion.md` §5.1).
 *
 * Structure mirrors `packages/sdk/src/contract-http/types.ts` where
 * applicable, with gRPC-specific semantics:
 *   - Target is "Service/Method" (wire format); renderTarget → "Service.Method"
 *   - Status codes are gRPC 0-16 (not HTTP 4xx/5xx)
 *   - Metadata replaces HTTP headers (metadata carries both ingress + egress)
 *   - Deadlines replace HTTP timeouts (ms)
 *   - Phase 1 scope: unary RPCs only (no streaming)
 */

import type { SchemaLike, TestContext } from "@glubean/sdk";
import type {
  BaseCaseSpec,
  Extensions,
  ProtocolContract,
} from "@glubean/sdk";
import type { GrpcClient } from "../index.js";

// =============================================================================
// Instance defaults (contract.grpc.with)
// =============================================================================

/**
 * Defaults for a gRPC contract instance (contract.grpc.with("name", {...})).
 *
 * Note: connection-level settings (address, TLS, proto path) are owned by
 * the transport plugin (configure({grpc: grpc({proto, address, ...})})).
 * The contract-layer instance only captures content defaults that apply
 * across contracts authored under this instance.
 */
export interface GrpcContractDefaults {
  /** Default gRPC client for all contracts in this instance. */
  client?: GrpcClient;
  /** Tags inherited by all contracts in this instance. */
  tags?: string[];
  /** Default feature grouping key. */
  feature?: string;
  /** Default metadata for all contracts (merged per-case). */
  metadata?: Record<string, string>;
  /** Default deadline in ms for all contracts in this instance. */
  deadlineMs?: number;
  /** OpenAPI-style extensions (x-* keys). Inherited by all contracts. */
  extensions?: Extensions;
}

// =============================================================================
// Examples (OpenAPI-style docs)
// =============================================================================

export interface GrpcContractExample<T = unknown> {
  value: T;
  summary?: string;
  description?: string;
}

// =============================================================================
// Expect (response expectations)
// =============================================================================

/**
 * Response expectations for a gRPC case.
 *
 * `statusCode` is the gRPC canonical status (0 = OK, 3 = INVALID_ARGUMENT,
 * 5 = NOT_FOUND, 7 = PERMISSION_DENIED, 14 = UNAVAILABLE, 16 = UNAUTHENTICATED,
 * etc.). Phase 1 default: `0` (OK) when not specified.
 */
export interface GrpcContractExpect<T = unknown> {
  /** Expected gRPC status code (0 = OK). Default: 0 when omitted. */
  statusCode?: number;
  /** Zod/Valibot schema for response message (when statusCode === 0). */
  schema?: SchemaLike<T>;
  /** Partial expected message shape (object — `toMatchObject` semantics). */
  message?: Partial<T>;
  /** Schema for response metadata (trailing). */
  metadata?: SchemaLike<Record<string, string>>;
  /** Partial expected response metadata. */
  metadataMatch?: Record<string, string>;
  /** Single response example (for docs / projection). */
  example?: T;
  /** Named response examples. */
  examples?: Record<string, GrpcContractExample<T>>;
}

// =============================================================================
// Case spec
// =============================================================================

/**
 * One case on a gRPC contract (attachment-model v10).
 *
 * Function-valued `request` / `metadata` receive the case's **logical
 * input** — the value matching `needs: SchemaLike<Needs>`. In standalone
 * mode the input comes from a bootstrap overlay's `run()` output or
 * CLI `--input-json`; in flow mode from `step.bindings.in(state)`. There
 * is no per-case setup state in v10 (per attachment-model §4.1 — case is
 * pure semantics, not lifecycle).
 */
export interface GrpcContractCase<Req = unknown, Res = unknown, Needs = void>
  extends BaseCaseSpec {
  /**
   * Per-case logical input schema (redeclares `BaseCaseSpec.needs` with
   * the case's own `Needs` so action fields can type-narrow correctly).
   * Mirrors HTTP `ContractCase.needs` redeclaration (Phase 2c B+C).
   */
  needs?: SchemaLike<Needs>;

  /** Per-case gRPC client override. */
  client?: GrpcClient;

  /** Why this case exists — required. */
  description: string;

  /** Expected response. */
  expect?: GrpcContractExpect<Res>;

  /**
   * Request message. Object shorthand or a function of the case's
   * logical input (matching `needs`). Merged deep-style over contract
   * `defaultRequest`.
   */
  request?: Req | ((input: Needs) => Req);

  /**
   * Per-call metadata (merged with instance + contract defaults).
   * Function form receives the case's logical input.
   */
  metadata?: Record<string, string> | ((input: Needs) => Record<string, string>);

  /** Per-call deadline in ms (overrides instance / contract defaults). */
  deadlineMs?: number;

  /** Business-logic verify — runs after status + schema + message match. */
  verify?: (ctx: TestContext, res: GrpcCaseResult<Res>) => void | Promise<void>;
}

/**
 * Case factory for input-bearing gRPC cases.
 *
 * TypeScript cannot infer and correlate `needs` with function-valued sibling
 * fields inside a plain object literal. Capturing `Needs` at the case's own
 * const site makes `request` and `metadata` functions type-check against the
 * declared logical input.
 *
 * The default request type is a record rather than `unknown` so the static
 * branch does not swallow function values and bypass the `Needs` check.
 *
 * @deprecated Use {@link grpcCase} — same drift guard with zero explicit
 * generics, and it keeps the case's literal type (so `InferGrpcResponse` /
 * `InferGrpcRequest` resolve instead of degrading). Before:
 * `defineGrpcCase<{ userId: string }>({ needs: Schema, request: ({ userId }) => ({ userId }) })`;
 * after: `grpcCase(Schema)({ request: ({ userId }) => ({ userId }) })`.
 */
export function defineGrpcCase<
  Needs = void,
  Req = Record<string, unknown>,
  Res = unknown,
>(c: GrpcContractCase<Req, Res, Needs>): GrpcContractCase<Req, Res, Needs> {
  return c;
}

/**
 * A gRPC request MESSAGE value — any object that is neither callable nor
 * thenable. This is the static branch of {@link GrpcCaseBody}'s `request`
 * union, and (because `GrpcContractCase` uses one parameter for both) also the
 * return type its function branch must produce.
 *
 * **Why the `never` guards.** `request?: Req | ((input) => Req)` is a union, so
 * a plain `object` static branch ACCEPTS function values — TypeScript treats
 * every function as an `object` — and three real authoring mistakes slip
 * through it with zero errors, each producing a corrupt request at runtime
 * (`resolveRequest` calls anything `typeof === "function"` and hands the result
 * to `deepMerge`):
 *
 * 1. A pre-declared builder whose ANNOTATED parameter drifts from the schema.
 *    The function branch rejects it (parameter contravariance), the `object`
 *    branch silently re-accepts it, and the needs-drift guard is bypassed.
 * 2. An `async` builder. Its `Promise` is not a valid message; `deepMerge`
 *    iterates `Object.entries(promise)` and sends `{}` — an empty request.
 * 3. A builder returning a primitive. `deepMerge` spreads a string into
 *    `{0: "a", 1: "b", ...}`.
 *
 * `apply` / `call` / `bind` are present on every function type, so pinning them
 * to `never` excludes callables while a protobuf message (an interface with no
 * such fields) passes the optional-property check untouched. `then` excludes
 * the `Promise` from case 2 — and a thenable message is hazardous regardless.
 *
 * The cost: a message with a literal `apply` / `call` / `bind` / `then` FIELD
 * cannot go through {@link grpcCase}. That shape keeps using the deprecated
 * `defineGrpcCase<Needs, Req, Res>`, which takes `Req` explicitly.
 */
export type GrpcRequestMessage = object & {
  apply?: never;
  call?: never;
  bind?: never;
  then?: never;
};

/**
 * Case body for {@link grpcCase} — `GrpcContractCase` WITHOUT `needs`; the
 * factory owns that field.
 *
 * `needs` is pinned to `never` rather than merely omitted: TypeScript runs no
 * excess-property check against a type parameter's CONSTRAINT, so a bare
 * `Omit<...>` would silently absorb a stray `needs` key into the inferred case
 * type and leave two competing declarations of the same schema. The `never`
 * makes writing a schema there a compile error at the offending property. An
 * explicit `needs: undefined` still passes — `exactOptionalPropertyTypes` is
 * off in this repo and it declares nothing anyway.
 *
 * The `Req` slot is {@link GrpcRequestMessage}, NOT `any`: `request?: Req |
 * ((input: Needs) => Req)` is a union whose static branch would SWALLOW the
 * function branch if it were `any` (`any | F` collapses to `any`), and the
 * drift guard would silently evaporate — the parameter of `request: ({ userId
 * }) => ...` would go implicitly `any`. It is not a bare `object` either: that
 * accepts function VALUES and re-admits three drift-bypassing forms through the
 * static branch (see {@link GrpcRequestMessage}). Unlike `defineGrpcCase`'s
 * `Record<string, unknown>` default it still accepts an INTERFACE-typed message
 * (protobuf codegen emits interfaces, which have no implicit index signature
 * and are therefore not assignable to `Record<string, unknown>`).
 *
 * The `Res` slot IS `any` (same as HTTP's `HttpCaseBody`): it only reaches
 * `expect` and `verify`, never a union with a function, so it cannot swallow
 * anything.
 */
export type GrpcCaseBody<N> = Omit<
  GrpcContractCase<GrpcRequestMessage, any, N>,
  "needs"
> & {
  needs?: never;
};

/**
 * Curried gRPC case factory — {@link defineGrpcCase}'s needs-drift guard with
 * zero explicit generics, and without its type-erasing trade. Prefer this.
 *
 * **Why curried.** TypeScript can't correlate sibling fields of one object
 * literal, so `needs: SchemaLike<X>` never types the `request: (input) => ...`
 * written beside it — a factory has to capture `Needs` first. But TS also has
 * no PARTIAL type-argument inference: the moment an author writes
 * `defineGrpcCase<Needs>(...)`, every remaining type parameter falls back to its
 * default and the case widens to the nominal `GrpcContractCase<Req, Res, Needs>`.
 * Splitting the call in two leaves nothing to default — `N` is inferred from the
 * schema VALUE in the first call, `C` from the case literal in the second
 * (contextually typed by `GrpcCaseBody<N>`, which is what still threads `N` into
 * the action fields).
 *
 * What that buys over `defineGrpcCase`:
 * - **No explicit generics.** The schema is written once, as a value, and the
 *   whole case is checked against it.
 * - **Drift guard on both action fields** — `request` / `metadata` take
 *   `(input: N) => ...`, so destructuring a key that isn't on `N` is a compile
 *   error instead of a silently `undefined` field in the outgoing message.
 * - **The case keeps its LITERAL type**, so `InferGrpcResponse` /
 *   `InferGrpcRequest` resolve the real `expect.schema` / `request` types; the
 *   nominal return of `defineGrpcCase` erases both to their defaults unless the
 *   author also spells out `Req` and `Res` by hand.
 * - **One declaration site.** A `needs` SCHEMA inside the case literal is both a
 *   compile error (see {@link GrpcCaseBody}) and a runtime `Error`. The one
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
 * `verify(ctx, res)`'s `res` is `GrpcCaseResult<any>`, not inferred from
 * `expect.schema` — that would need a second inference pass over the same
 * literal. Do NOT annotate the parameter with a concrete result type: gRPC's
 * `Res` is CONTRACT-level (`GrpcContractSpec<Req, Res, Cases>`) and infers
 * `unknown`, so a narrowed `verify` parameter makes the case unassignable to the
 * contract's `cases` (a pre-existing constraint — `defineGrpcCase<Needs, Req,
 * Res>` with an explicit `Res` hits the same wall). Narrow `res.message` inside
 * the body instead; the schema still validates the response at runtime.
 *
 * @example
 * ```ts
 * import { contract } from "@glubean/sdk";
 * import { grpcCase } from "@glubean/grpc";
 * import { z } from "zod";
 *
 * const fetchUser = grpcCase(z.object({ userId: z.string(), token: z.string() }))({
 *   description: "fetches a user by id",
 *   // `input` is { userId: string; token: string } — inferred, never annotated.
 *   request: ({ userId }) => ({ userId }),
 *   metadata: ({ token }) => ({ authorization: `Bearer ${token}` }),
 *   expect: { statusCode: 0, schema: z.object({ user: z.object({ id: z.string() }) }) },
 * });
 *
 * const api = contract.grpc.with("users", { client });
 * export const users = api("user.fetch", {
 *   target: "UserService/GetUser",
 *   cases: { fetchUser },
 * });
 * ```
 *
 * @param needs The case's logical input schema — declared here, exactly once.
 *   Omit the argument entirely for a case with no logical input; that form
 *   returns the case unchanged and still rejects a literal `needs`.
 * @returns A function taking the case literal, returning it with `needs` attached.
 */
export function grpcCase<N>(
  needs: SchemaLike<N>,
): <const C extends GrpcCaseBody<N>>(
  c: C,
  // `Omit<C, "needs">` before the intersection, never a bare `C & {...}`: a case
  // written against the exported `GrpcCaseBody<X>` annotation carries the
  // `needs?: never` guard INTO `C`, and intersecting that with the required
  // `needs: SchemaLike<N>` collapses the property (and with it core's
  // `InferCaseInput`, and with THAT the whole `.case()` I/O chain) to `never`.
  // Dropping the guarded key first keeps every other property's literal type
  // intact.
) => Omit<C, "needs"> & { needs: SchemaLike<N> };
export function grpcCase(): <const C extends GrpcCaseBody<void>>(c: C) => C;
export function grpcCase(needs?: SchemaLike<unknown>) {
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
    // undefined as "no needs declared" (core's §5.1 branches are falsy checks;
    // the projection records `hasNeeds: c.needs !== undefined`). In the schema
    // form the spread below overwrites the key anyway.
    if (c.needs !== undefined) {
      throw new Error(
        "grpcCase: do not declare `needs` inside the case literal — the factory " +
          "owns that field. Declare it once as `grpcCase(schema)({ ... })` and " +
          "remove `needs` from the case object.",
      );
    }
    return needs === undefined ? c : { ...c, needs };
  };
}

// =============================================================================
// Case result (shape passed to verify and to flow `out` lens)
// =============================================================================

/**
 * Result of running a single case. This is also the `CaseOutput` shape that
 * flow `step.out(state, res)` lens receives.
 *
 * Mirrors `@glubean/grpc`'s `GrpcCallResult<T>` but nested under a contract-
 * layer shape so adapter-layer additions (e.g. assertion diagnostics) can
 * grow independently.
 */
export interface GrpcCaseResult<Res = unknown> {
  /** Decoded response message. */
  message: Res;
  /** gRPC status. `code` is 0 for OK. */
  status: {
    code: number;
    details: string;
  };
  /** Response (trailing) metadata. */
  responseMetadata: Record<string, string>;
  /** Duration in ms. */
  duration: number;
}

// =============================================================================
// Contract spec
// =============================================================================

/**
 * User-facing gRPC contract specification.
 *
 * `target` is the wire-format "Service/Method" string (e.g. "PaymentService/
 * Complete"). `renderTarget` will display as "PaymentService.Complete" in
 * UI but wire format stays as source of truth.
 *
 * Contract identity = contract id (string) + case key. Target is a display
 * hint, NOT an identity — proposal §5.3.
 */
export interface GrpcContractSpec<
  Req = unknown,
  Res = unknown,
  Cases extends Record<string, GrpcContractCase<Req, Res, any>> = Record<string, GrpcContractCase<Req, Res>>,
> {
  /** Wire-format target: "ServiceName/MethodName". */
  target: string;

  /** Default gRPC client for all cases. */
  client?: GrpcClient;

  description?: string;
  feature?: string;

  /** Contract-level request schema (OpenAPI-style docs + possible runtime validation). */
  requestSchema?: SchemaLike<Req>;

  /** Contract-level default request (merged under each case's request). */
  defaultRequest?: Partial<Req>;

  /** Contract-level default metadata (merged under each case's metadata). */
  defaultMetadata?: Record<string, string>;

  /** Contract-level default deadline (ms). */
  deadlineMs?: number;

  tags?: string[];
  deprecated?: string;
  extensions?: Extensions;

  /** Named spec cases. */
  cases: Cases;
}

// =============================================================================
// Adapter payload schemas (for ContractProtocolAdapter generics)
// =============================================================================

/**
 * Runtime (live) payload shape for the gRPC adapter. Contains SchemaLike
 * references. Converted to GrpcSafeSchemas by adapter.normalize.
 */
export interface GrpcPayloadSchemas {
  request?: SchemaLike<unknown>;
  response?: SchemaLike<unknown>;
  metadata?: SchemaLike<Record<string, string>>;
  /** Request examples (for docs / projection). */
  requestExample?: unknown;
  requestExamples?: Record<string, GrpcContractExample<unknown>>;
}

/**
 * JSON-safe payload shape. Produced by adapter.normalize.
 * SchemaLike references are converted to JSON Schema fragments.
 */
export interface GrpcSafeSchemas {
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  requestExample?: unknown;
  requestExamples?: Record<string, GrpcContractExample<unknown>>;
}

// =============================================================================
// Contract meta
// =============================================================================

/**
 * Runtime contract-level meta. Carried on the projection so scanner / MCP /
 * Cloud can surface structural info without needing the live spec.
 *
 * Note: `.proto` file path is intentionally NOT stored here (execution log
 * OQ-2 decision 2026-04-20). The proto path is a runtime transport concern
 * owned by `configure({grpc: grpc({proto: ...})})`, not by the contract.
 * Contract is protocol-idea-level, transport config is deployment-level.
 */
export interface GrpcContractMeta {
  /** Raw target "Service/Method". */
  target: string;
  /** Parsed service name ("PaymentService"). */
  service: string;
  /** Parsed method name ("Complete"). */
  method: string;
  /** Contract-level default metadata (for projection display). */
  defaultMetadata?: Record<string, string>;
  /** Contract-level deadline (for projection display). */
  deadlineMs?: number;
  /** Contract instance name (contract.grpc.with("name")). */
  instanceName?: string;
}

/**
 * JSON-safe meta. Same as runtime meta (no live references).
 */
export type GrpcContractSafeMeta = GrpcContractMeta;

// =============================================================================
// Flow output shape
// =============================================================================

/**
 * What `executeCaseInFlow` returns, and what flow `step.out(state, res)`
 * receives in its `res` parameter. Mirrors `GrpcCaseResult` — kept as a
 * distinct export to make the flow-output contract explicit (parallel to
 * HTTP's `HttpFlowCaseOutput` convention).
 */
export type GrpcFlowCaseOutput<Res = unknown> = GrpcCaseResult<Res>;

// =============================================================================
// Contract instance / root types
// =============================================================================

/**
 * Signature of `contract.grpc.with("name", defaults)`. Returns a contract
 * factory that creates contracts under this instance's defaults.
 *
 * Actual implementation in `./factory.ts` (CG-4).
 */
export type GrpcContractRoot = {
  with: (
    instanceName: string,
    defaults?: GrpcContractDefaults,
  ) => GrpcContractFactory;
};

export type GrpcContractFactory = <
  Req,
  Res,
  Cases extends Record<string, GrpcContractCase<Req, Res, any>>,
>(
  id: string,
  spec: GrpcContractSpec<Req, Res, Cases>,
) => ProtocolContract<
  GrpcContractSpec<Req, Res, Cases>,
  GrpcPayloadSchemas,
  GrpcContractMeta,
  Cases
>;

declare module "@glubean/sdk" {
  interface ContractProtocolRoots {
    grpc: GrpcContractRoot;
  }
}

// =============================================================================
// Type inference helpers (CG-2 skeleton; expanded in CG-3 as adapter lands)
// =============================================================================

/**
 * Infer request type from a GrpcContractCase. Placeholder for future
 * ergonomic inference helpers parallel to HTTP's InferHttpInputs.
 *
 * Third generic slot is now `Needs` (was v9's `S` setup-state). Using
 * `any` in the don't-care slot per Spike 0 Finding 2 (contravariant
 * positions need `any`, not `unknown`, to keep inference stable).
 */
export type InferGrpcRequest<C> = C extends GrpcContractCase<infer Req, any, any> ? Req : never;

/**
 * Infer response type from a GrpcContractCase.
 */
export type InferGrpcResponse<C> = C extends GrpcContractCase<any, infer Res, any> ? Res : never;
