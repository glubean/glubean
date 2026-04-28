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
 * Static-body shape for HTTP case `body` field. Excludes `unknown` (which
 * would swallow the function branch in a union and lose `Needs` typing for
 * function-valued bodies). Function-form `body: (input: Needs) => ...` only
 * matches when the static-form types reject the value.
 */
export type HttpStaticBody =
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null
  | FormData
  | URLSearchParams
  | Blob;

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
 * `ContractCase<T, Needs>` so all action fields (`body`, `params`,
 * `query`, `headers`) are constrained to `(input: Needs) => ...`. Drift
 * between `needs` and any action field becomes a compile error.
 *
 * Use it for cases that declare `needs` AND have function-valued action
 * fields. Cases without `needs` (or with only static action fields)
 * don't need the factory; the runtime invariants are unaffected either
 * way (this is a typing improvement only).
 *
 * @example
 * ```ts
 * import { defineHttpCase } from "@glubean/sdk";
 * import { z } from "zod";
 *
 * const successCase = defineHttpCase<{ email: string }>({
 *   description: "creates a user",
 *   needs: z.object({ email: z.string() }),
 *   // body, params, query, headers params now type-checked against
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

  /** URL params. Values can be `ParamValue` objects for OpenAPI metadata. */
  params?: Record<string, ParamValue> | ((input: Needs) => Record<string, string>);

  /** Query parameters. */
  query?: Record<string, ParamValue> | ((input: Needs) => Record<string, string>);

  /** Request headers merged with client headers. */
  headers?: Record<string, string> | ((input: Needs) => Record<string, string>);

  /** Business-logic verify — runs after status and schema validation. */
  verify?: (ctx: TestContext, res: T) => Promise<void>;
}

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
  Cases extends Record<string, ContractCase<any, any>> = Record<string, ContractCase>,
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

// =============================================================================
// Factory types
// =============================================================================

/**
 * Callable + chainable HTTP contract factory. Returned by
 * `contract.http.with("name", defaults)`.
 */
export interface HttpContractFactory {
  <Cases extends Record<string, ContractCase<any, any>>>(
    id: string,
    spec: HttpContractSpec<Cases>,
  ): import("../contract-types.js").ProtocolContract<
    HttpContractSpec<Cases>,
    HttpPayloadSchemas,
    HttpContractMeta,
    Cases
  >;
  with(name: string, defaults: HttpContractDefaults): HttpContractFactory;
}

/**
 * Root `contract.http` — only .with() is callable; direct call requires
 * .with() first (enforces scoped-instance pattern for client injection).
 */
export interface HttpContractRoot {
  with(name: string, defaults: HttpContractDefaults): HttpContractFactory;
}
