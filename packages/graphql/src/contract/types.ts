/**
 * GraphQL contract types.
 *
 * User-facing authoring types + adapter-level payload types for the
 * GraphQL contract adapter (single-package model — see
 * `internal/40-discovery/proposals/contract-grpc-graphql-expansion.md` §6.1).
 *
 * Structure mirrors `packages/grpc/src/contract/types.ts` where applicable,
 * with GraphQL-specific design:
 *
 *   - **Target model:** GraphQL typically has a single `/graphql` endpoint,
 *     so `endpoint` is spec-level (not per-case). `endpoint` is
 *     **projection-only** in Phase 1 — it travels on `meta.endpoint`
 *     for markdown / scanner / MCP display, but the adapter dispatches
 *     through the supplied `GraphQLClient` whose endpoint was fixed at
 *     construction time. Multi-endpoint is expressed by multiple
 *     clients, not by per-contract endpoint strings. Contract identity
 *     = `contractId + caseKey`, NOT operationName (proposal §3.2).
 *
 *   - **Selection-set-per-case coupling (proposal §3.2 b):** unlike
 *     HTTP/gRPC where response shape is determined by endpoint/method,
 *     GraphQL response shape is determined by the *query string* in each
 *     case. Each case therefore carries its own `query` + `variables` +
 *     `responseSchema` triple. A contract-level `responseSchema` may still
 *     apply if all cases share the same selection set (rare).
 *
 *   - **Explicit type declarations (proposal §7b.2):** `types` is a
 *     deferred projection hint for Phase 2 SDL generation. Phase 1 stores
 *     it as opaque metadata — adapter / scanner carry it forward so
 *     projection tooling can consume it later.
 *
 *   - **3-layer classifyFailure (proposal §3.2 c):**
 *       transport (HTTP status 4xx/5xx/network)
 *       → payload errors (GraphQL `errors` array, HTTP 200)
 *       → data shape mismatch (schema validation on `data`)
 *
 *   - **Phase 1 scope:** query + mutation only (subscriptions deferred
 *     to Phase 2 streaming work).
 */

import type { SchemaLike, TestContext } from "@glubean/sdk";
import type {
  BaseCaseSpec,
  Extensions,
  ProtocolContract,
} from "@glubean/sdk";
import type { GraphQLClient, GraphQLError } from "../index.js";

// =============================================================================
// Type declarations (Phase 2 projection hint — stored opaque in Phase 1)
// =============================================================================

/**
 * Field-map declaration for a GraphQL type. Kept minimal and stringly-typed
 * so the declaration surface can evolve without a breaking bump.
 *
 * Phase 1 stores this as opaque metadata. Phase 2 `.gql` projection will
 * consume it — see proposal §7b.2.
 *
 * @example
 * ```ts
 * types: {
 *   User: { id: "ID!", name: "String!", orders: "[Order!]!" },
 *   Order: { id: "ID!", total: "Float!" },
 * }
 * ```
 */
export type GraphqlTypeDef = Record<string, string>;

/**
 * Map of type-name → field declaration. Optional; when present, projection
 * tools can emit SDL alongside the per-case markdown.
 */
export type GraphqlTypeDefs = Record<string, GraphqlTypeDef>;

// =============================================================================
// Instance defaults (contract.graphql.with)
// =============================================================================

/**
 * Defaults for a GraphQL contract instance
 * (`contract.graphql.with("name", {...})`).
 *
 * The `client` binding is the primary reason to use `.with`: supplying a
 * pre-configured GraphQLClient lets the adapter call through it without
 * rebuilding per contract. The GraphQLClient is itself bound to an
 * endpoint at construction time (via `createGraphQLClient(http, { endpoint })`
 * or the `graphql({ endpoint })` plugin factory) — the contract layer
 * does not override that at runtime.
 */
export interface GraphqlContractDefaults {
  /** Default GraphQL client for all contracts in this instance. */
  client?: GraphQLClient;
  /**
   * Default endpoint **for projection / display only.**
   *
   * This value travels on the projection meta (`meta.endpoint`) so the
   * scanner, `glubean contracts` markdown, and MCP surfaces can show
   * which endpoint the contract points at. At runtime the adapter
   * dispatches through the supplied `client`, whose endpoint was fixed
   * at client-construction time. Changing `endpoint` here does **not**
   * redirect the live call — use a different client instead
   * (e.g. `api_v1 = graphql({endpoint: "/v1/graphql"})`,
   *  `api_v2 = graphql({endpoint: "/v2/graphql"})`).
   */
  endpoint?: string;
  /** Tags inherited by all contracts in this instance. */
  tags?: string[];
  /** Default feature grouping key. */
  feature?: string;
  /** Default headers merged into every case. */
  headers?: Record<string, string>;
  /** OpenAPI-style extensions (x-* keys). Inherited by all contracts. */
  extensions?: Extensions;
}

// =============================================================================
// Examples (OpenAPI-style docs)
// =============================================================================

export interface GraphqlContractExample<T = unknown> {
  value: T;
  summary?: string;
  description?: string;
}

// =============================================================================
// Expect (response expectations)
// =============================================================================

/**
 * Sentinel values for the `errors` expectation.
 *
 * - `"absent"` — `errors` must be undefined or empty (strict success).
 * - `"any"` — accept any errors (only useful with `data` partial match).
 * - `GraphQLError[]` — match each listed error by `message` / `extensions.code`
 *   (partial — unlisted errors still fail unless length check relaxed).
 */
export type GraphqlErrorsExpect =
  | "absent"
  | "any"
  | Array<Partial<GraphQLError>>;

/**
 * Response expectations for a GraphQL case.
 *
 * GraphQL success is nuanced: `errors` may be present alongside `data`
 * (partial success). The adapter's 3-layer `classifyFailure` handles the
 * interpretation. At expect-time:
 *
 * - `data` — partial shape to match against `response.data`.
 * - `errors` — sentinel or array (see `GraphqlErrorsExpect`).
 * - `schema` — per-case Zod/Valibot schema for `data` (selection-set
 *   coupling lives here — each case owns its response shape).
 * - `httpStatus` — transport-layer assertion (4xx/5xx for negative cases).
 */
export interface GraphqlContractExpect<T = unknown> {
  /** Expected HTTP status (from the underlying POST). Default: 200. */
  httpStatus?: number;
  /** Per-case response schema (selection-set-coupled). */
  schema?: SchemaLike<T>;
  /** Partial expected `data` shape (toMatchObject semantics). */
  data?: Partial<T>;
  /** Assertion on GraphQL `errors` array. Default: `"absent"`. */
  errors?: GraphqlErrorsExpect;
  /** Schema for response headers. */
  headers?: SchemaLike<Record<string, string | string[]>>;
  /** Partial expected response headers. */
  headersMatch?: Record<string, string>;
  /** Single response example (for docs / projection). */
  example?: T;
  /** Named response examples. */
  examples?: Record<string, GraphqlContractExample<T>>;
}

// =============================================================================
// Case spec
// =============================================================================

/**
 * One case on a GraphQL contract (attachment-model v10).
 *
 * Each case owns its own `query` string — the selection-set is
 * per-case (proposal §3.2 b). Function-valued `variables` / `headers`
 * receive the case's **logical input** (matching `needs: SchemaLike<Needs>`),
 * NOT setup state. v10 removes per-case lifecycle entirely; setup-style
 * work belongs to a `contract.bootstrap()` overlay (whose `ctx.cleanup(...)`
 * runs LIFO). Mirrors HTTP and gRPC migrations (Phase 2c B+C / Spike 4).
 */
export interface GraphqlContractCase<
  Vars = Record<string, unknown>,
  Res = unknown,
  Needs = void,
> extends BaseCaseSpec {
  /**
   * Per-case logical input schema. Redeclares `BaseCaseSpec.needs` with
   * the case's own `Needs` so action fields can type-narrow correctly.
   */
  needs?: SchemaLike<Needs>;

  /** Per-case client override. */
  client?: GraphQLClient;

  /** Why this case exists — required. */
  description: string;

  /**
   * Operation type. Defaults to `"query"` when omitted.
   * Phase 1: `query | mutation`. `subscription` is Phase 2 (streaming).
   */
  operation?: "query" | "mutation";

  /**
   * GraphQL document. Required per case (selection-set is per-case).
   *
   * Can be authored inline, via the `gql` tagged template, or loaded from
   * a `.gql` file via `fromGql()`.
   */
  query: string;

  /** Optional operationName override. If omitted, parsed from `query`. */
  operationName?: string;

  /** Expected response. */
  expect?: GraphqlContractExpect<Res>;

  /**
   * Variables. Object shorthand or a function of the case's logical
   * input (matching `needs`). Merged deep-style over
   * `defaults.variables` → `spec.defaultVariables`.
   */
  variables?: Vars | ((input: Needs) => Vars);

  /**
   * Per-call headers (merged with instance + contract defaults). Function
   * form receives the case's logical input.
   */
  headers?: Record<string, string> | ((input: Needs) => Record<string, string>);

  /** Business-logic verify — runs after transport + schema + data match. */
  verify?: (ctx: TestContext, res: GraphqlCaseResult<Res>) => void | Promise<void>;
}

// =============================================================================
// Case result (shape passed to verify and to flow `out` lens)
// =============================================================================

/**
 * Result of running a single case. This is also the `CaseOutput` shape that
 * flow `step.out(state, res)` lens receives.
 *
 * Mirrors `GraphQLResult<T>` from the transport layer (CG-10) plus the
 * parsed `operationName` for display/routing. Kept as a distinct type so
 * adapter-layer additions (e.g. assertion diagnostics) can grow
 * independently of the transport envelope.
 */
export interface GraphqlCaseResult<Res = unknown> {
  /** Decoded `data` field (null if all fields errored or transport failed). */
  data: Res | null;
  /** GraphQL `errors` array (undefined when absent). */
  errors?: GraphQLError[];
  /** GraphQL `extensions` (server-side tracing/cost/etc). */
  extensions?: Record<string, unknown>;
  /** HTTP status from the underlying POST. */
  httpStatus: number;
  /** Response headers (lowercased keys). */
  headers: Record<string, string | string[]>;
  /** Raw response body string (null on network error). */
  rawBody: string | null;
  /** Resolved operation name (from case.operationName or parsed from query). */
  operationName: string;
  /** Duration in ms. */
  duration: number;
}

// =============================================================================
// Contract spec
// =============================================================================

/**
 * User-facing GraphQL contract specification.
 *
 * Contract identity = contract id (string) + case key. `operationName` is
 * a display/routing hint, NOT an identity (proposal §5.3 — same rule as
 * gRPC `Service/Method`).
 */
export interface GraphqlContractSpec<
  Vars extends Record<string, unknown> = Record<string, unknown>,
  Res = unknown,
  Cases extends Record<string, GraphqlContractCase<Vars, Res, any>> = Record<
    string,
    GraphqlContractCase<Vars, Res>
  >,
> {
  /**
   * Endpoint URL **for projection / display only.**
   *
   * Travels on the projection `meta.endpoint`. The adapter does NOT use
   * this to redirect the runtime call — the call is dispatched through
   * the supplied `client`, whose endpoint was fixed at construction time
   * (see `GraphqlContractDefaults.endpoint` for the full rationale). To
   * target a different endpoint at runtime, construct a separate client.
   */
  endpoint?: string;

  /** Default GraphQL client for all cases. */
  client?: GraphQLClient;

  description?: string;
  feature?: string;

  /**
   * Explicit type declarations (proposal §7b.2). Stored opaque in Phase 1;
   * consumed by Phase 2 `.gql` projection. Safe to omit — nothing else
   * depends on it at runtime.
   */
  types?: GraphqlTypeDefs;

  /**
   * Default operation type for cases that don't set their own.
   * Default when both spec and case omit: `"query"`.
   */
  defaultOperation?: "query" | "mutation";

  /**
   * Contract-level variables schema. Per-case schemas (on `expect.schema`)
   * cover response shape; variables often share structure so this sits at
   * the contract level.
   */
  variablesSchema?: SchemaLike<Vars>;

  /**
   * Contract-level response schema — used when all cases share the same
   * selection set. Per-case `expect.schema` overrides.
   */
  responseSchema?: SchemaLike<Res>;

  /** Contract-level default variables (merged under each case's variables). */
  defaultVariables?: Partial<Vars>;

  /** Contract-level default headers (merged under each case's headers). */
  defaultHeaders?: Record<string, string>;

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
 * Runtime (live) payload shape for the GraphQL adapter. Contains SchemaLike
 * references. Converted to `GraphqlSafeSchemas` by adapter.normalize.
 *
 * Per the selection-set coupling (proposal §3.2 b), the most important
 * field here is `response` — it's the per-case response schema. `variables`
 * and `request` (= the query document string) accompany it so the triple
 * travels together through projection.
 */
export interface GraphqlPayloadSchemas {
  /** Query document string (the "request" for GraphQL). */
  query?: string;
  /** Operation type (query / mutation). */
  operation?: "query" | "mutation";
  /** Resolved operationName (display/routing hint). */
  operationName?: string;
  /** Variables schema. */
  variables?: SchemaLike<unknown>;
  /** Per-case response schema (selection-set-coupled). */
  response?: SchemaLike<unknown>;
  /** Response headers schema. */
  headers?: SchemaLike<Record<string, string | string[]>>;
  /** Variables examples (for docs / projection). */
  variablesExample?: unknown;
  variablesExamples?: Record<string, GraphqlContractExample<unknown>>;
}

/**
 * JSON-safe payload shape. Produced by adapter.normalize.
 * SchemaLike references are converted to JSON Schema fragments.
 */
export interface GraphqlSafeSchemas {
  query?: string;
  operation?: "query" | "mutation";
  operationName?: string;
  variables?: Record<string, unknown>;
  response?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  variablesExample?: unknown;
  variablesExamples?: Record<string, GraphqlContractExample<unknown>>;
}

// =============================================================================
// Contract meta
// =============================================================================

/**
 * Runtime contract-level meta. Carried on the projection so scanner / MCP /
 * Cloud can surface structural info without needing the live spec.
 *
 * Note: explicit `types` map (when present) is JSON-safe by construction
 * (stringly-typed field declarations), so it travels unchanged from
 * runtime to safe meta.
 */
export interface GraphqlContractMeta {
  /** Endpoint URL (normalized; may be undefined if transport-owned). */
  endpoint?: string;
  /** Default operation type for the contract. */
  defaultOperation?: "query" | "mutation";
  /** Contract-level default headers (for projection display). */
  defaultHeaders?: Record<string, string>;
  /** Explicit type declarations (Phase 2 projection hint). */
  types?: GraphqlTypeDefs;
  /** Contract instance name (contract.graphql.with("name")). */
  instanceName?: string;
}

/**
 * JSON-safe meta. Same shape as runtime meta (no live references).
 */
export type GraphqlContractSafeMeta = GraphqlContractMeta;

// =============================================================================
// Flow output shape
// =============================================================================

/**
 * What `executeCaseInFlow` returns, and what flow `step.out(state, res)`
 * receives in its `res` parameter. Mirrors `GraphqlCaseResult` — kept as a
 * distinct export to make the flow-output contract explicit (parallel to
 * gRPC's `GrpcFlowCaseOutput` convention).
 */
export type GraphqlFlowCaseOutput<Res = unknown> = GraphqlCaseResult<Res>;

// =============================================================================
// Contract instance / root types
// =============================================================================

/**
 * Signature of `contract.graphql.with("name", defaults)`. Returns a contract
 * factory that creates contracts under this instance's defaults.
 *
 * Actual implementation in `./factory.ts` (CG-12).
 */
export type GraphqlContractRoot = {
  with: (
    instanceName: string,
    defaults?: GraphqlContractDefaults,
  ) => GraphqlContractFactory;
};

export type GraphqlContractFactory = <
  Vars extends Record<string, unknown>,
  Res,
  Cases extends Record<string, GraphqlContractCase<Vars, Res, any>>,
>(
  id: string,
  spec: GraphqlContractSpec<Vars, Res, Cases>,
) => ProtocolContract<
  GraphqlContractSpec<Vars, Res, Cases>,
  GraphqlPayloadSchemas,
  GraphqlContractMeta,
  Cases
>;

declare module "@glubean/sdk" {
  interface ContractProtocolRoots {
    graphql: GraphqlContractRoot;
  }
}

// =============================================================================
// Type inference helpers
// =============================================================================

/**
 * Infer variables type from a GraphqlContractCase.
 */
export type InferGraphqlVariables<C> = C extends GraphqlContractCase<infer V, any, any> ? V : never;

/**
 * Infer response type from a GraphqlContractCase.
 */
export type InferGraphqlResponse<C> = C extends GraphqlContractCase<any, infer R, any> ? R : never;
