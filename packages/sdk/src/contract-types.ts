/**
 * Types for the contract() API.
 *
 * contract.http() is a declarative test factory for any HTTP API:
 * spec in, Test[] out. Users provide their own HTTP clients via
 * configure() — the contract layer has no opinion on auth strategy.
 */

import type { SchemaLike } from "./types.js";
import type { Test, TestContext, RegisteredTestMeta, HttpClient } from "./types.js";

// =============================================================================
// Security scheme types
// =============================================================================

/**
 * HTTP security scheme declaration for contract instances.
 * Maps to OpenAPI securitySchemes. Authoritative metadata, not docs-only.
 */
export type HttpSecurityScheme =
  | "bearer"
  | "basic"
  | { type: "apiKey"; name: string; in: "header" | "query" }
  | { type: "oauth2"; flows: Record<string, unknown> }
  | null;

// =============================================================================
// Protocol-agnostic base types
// =============================================================================

/**
 * Case lifecycle.
 *
 * - `"active"` — executable, will run normally
 * - `"deferred"` — not yet executable (missing credentials, infrastructure)
 * - `"deprecated"` — retained for history but no longer executed
 */
export type CaseLifecycle = "active" | "deferred" | "deprecated";

/**
 * Case severity. Affects Cloud alert routing and projection diff weight.
 *
 * - `"critical"` — failure triggers immediate alert
 * - `"warning"` — failure is recorded but may not alert (default)
 * - `"info"` — informational check, failure does not trigger alerts
 */
export type CaseSeverity = "critical" | "warning" | "info";

/**
 * Standardized failure classification kind. Protocol-agnostic.
 *
 * Open string type — adapters can extend with custom values.
 * Recommended values:
 * - `"auth"` — authentication failure (401-class)
 * - `"permission"` — authorization failure (403-class)
 * - `"not-found"` — resource does not exist
 * - `"schema"` — response shape mismatch
 * - `"timeout"` — request or execution timeout
 * - `"transport"` — network/connection error
 * - `"rate-limit"` — throttled
 * - `"business-rule"` — business logic assertion failure
 * - `"unknown"` — cannot classify
 */
export type FailureKind = string;

/**
 * Standardized failure classification.
 * Produced by protocol adapters or core. Consumed by repair loop, Cloud, runner summary.
 */
export interface FailureClassification {
  kind: FailureKind;
  source: "assertion" | "trace" | "plugin";
  retryable?: boolean;
  message?: string;
}

// =============================================================================
// HTTP contract defaults (for contract.http.with())
// =============================================================================

/**
 * Default values for a scoped HTTP contract instance.
 * Created via `contract.http.with("name", defaults)`.
 */
/**
 * OpenAPI-style extensions. Keys MUST start with "x-".
 * Non-x keys are rejected at the type level.
 * Used for tool-interop metadata (e.g. "x-glubean-internal-id").
 */
export type Extensions = Record<`x-${string}`, unknown>;

export interface HttpContractDefaults {
  /** Default HTTP client for all contracts in this instance */
  client?: HttpClient;
  /** Security scheme declaration (authoritative, maps to OpenAPI) */
  security?: HttpSecurityScheme;
  /** Tags inherited by all contracts in this instance */
  tags?: string[];
  /** Default feature grouping key */
  feature?: string;
  /** OpenAPI extensions (x-* keys). Inherited by all contracts in this instance. */
  extensions?: Extensions;
}

// =============================================================================
// HTTP contract factory (callable + .with())
// =============================================================================

/**
 * Root contract.http entrypoint — only .with() is available.
 * Direct contract.http("id", spec) is not supported.
 */
export interface HttpContractRoot {
  with(name: string, defaults: HttpContractDefaults): HttpContractFactory;
}

/**
 * Protocol-bound contract factory returned by `contract.http.with()`.
 * Callable: `factory("id", spec)` creates an HttpContract.
 * Chainable: `factory.with("name", defaults)` creates a nested instance.
 */
export interface HttpContractFactory {
  <Cases extends Record<string, ContractCase<any, any>>>(
    id: string,
    spec: HttpContractSpec<Cases>,
  ): HttpContract;
  with(name: string, defaults: HttpContractDefaults): HttpContractFactory;
}

// =============================================================================
// Case execution boundary (dual-axis model)
// =============================================================================

/**
 * Physical capability required by a case or flow.
 *
 * - `"headless"` — fully automated, no human in loop (default)
 * - `"browser"` — needs a real browser (OAuth code flow, checkout, captcha)
 * - `"out-of-band"` — needs an out-of-band channel (email, SMS, push, webhook tunnel)
 */
export type CaseRequires = "headless" | "browser" | "out-of-band";

/**
 * Default run policy for a case or flow.
 *
 * - `"always"` — run whenever the runner satisfies `requires` (default)
 * - `"opt-in"` — skip unless explicitly requested (e.g. `--include-opt-in`)
 *
 * Use `"opt-in"` for cases that are expensive, have real side effects,
 * or are slow (Twilio SMS, Stripe charges, long stress tests).
 */
export type CaseDefaultRun = "always" | "opt-in";

// =============================================================================
// Case definition
// =============================================================================

/**
 * Normalized response headers shape.
 * HTTP allows multi-value headers (e.g. Set-Cookie), so values can be string or string[].
 * Keys are always lowercase (runtime normalization).
 */
export type NormalizedHeaders = Record<string, string | string[]>;

/**
 * A single example entry for OpenAPI docs.
 */
export interface ContractExample<T = unknown> {
  value: T;
  summary?: string;
  description?: string;
}

/**
 * Expected response for a contract case.
 *
 * @template T The parsed response type (inferred from schema)
 */
export interface ContractExpect<T = unknown> {
  /** Expected HTTP status code */
  status: number;
  /** Zod/Valibot schema to validate response body. Parsed value is passed to verify(). */
  schema?: SchemaLike<T>;

  /**
   * Expected response content-type. Default: "application/json".
   * Used by OpenAPI generation and (future) response body deserialization dispatch.
   */
  contentType?: string;

  /**
   * Schema to validate response headers. Headers are normalized to lowercase keys
   * before validation (HTTP spec: header names are case-insensitive).
   * Values are `string | string[]` to support multi-value headers (e.g. Set-Cookie).
   *
   * @example
   * headers: z.object({
   *   "content-type": z.string().regex(/^application\/json/),
   *   "x-request-id": z.string().uuid(),
   * })
   */
  headers?: SchemaLike<NormalizedHeaders>;

  /**
   * Single response example (shorthand). Equivalent to examples: { default: { value } }.
   * Not used at runtime — only for OpenAPI documentation.
   */
  example?: T;

  /**
   * Multiple named response examples. Mapped to OpenAPI responses[status].content.examples.
   * Not used at runtime — only for OpenAPI documentation.
   */
  examples?: Record<string, ContractExample<T>>;
}

/**
 * Path or query parameter value.
 * String shorthand: just the value. Object form: value + OpenAPI metadata.
 */
export type ParamValue =
  | string
  | {
      /** The actual value used for URL substitution / query string construction */
      value: string;
      /** OpenAPI parameter schema (not used at runtime, see Part 5 of proposal) */
      schema?: SchemaLike<unknown>;
      /** Parameter description for OpenAPI docs */
      description?: string;
      /** Whether the parameter is required (default: true for path, false for query) */
      required?: boolean;
      /** Whether the parameter is deprecated */
      deprecated?: boolean;
    };

/**
 * A single spec case within a contract.
 *
 * @template T The parsed response type (inferred from expect.schema)
 * @template S The setup return type
 */
export interface ContractCase<T = unknown, S = void> {
  /**
   * HTTP client to use for this case.
   * Each client can have different auth, base URL, headers, etc.
   * Created via configure() — contract doesn't care about the auth strategy.
   *
   * If omitted, uses the contract-level `client`.
   */
  client?: HttpClient;

  /** Why this case exists — business logic, boundary condition, or intent. Required. */
  description: string;

  /** Expected response */
  expect: ContractExpect<T>;

  /**
   * Request body (for POST/PUT/PATCH) — static value or function deriving from setup state.
   * For non-JSON content types, provide `FormData`, `URLSearchParams`, `Blob`, or string.
   * JSON is the default (plain object).
   */
  body?: unknown | FormData | URLSearchParams | Blob | ((state: S) => unknown);

  /**
   * Request content type override for this case.
   * If not set, inherits from contract.request.contentType, defaults to "application/json".
   * Supported: "application/json", "multipart/form-data", "application/x-www-form-urlencoded",
   * "text/plain", "application/octet-stream".
   */
  contentType?: string;

  /**
   * URL params — static object or function deriving from setup state.
   * Values can be plain strings or ParamValue objects with OpenAPI metadata.
   */
  params?: Record<string, ParamValue> | ((state: S) => Record<string, string>);

  /**
   * Query parameters — static object or function deriving from setup state.
   * Values can be plain strings or ParamValue objects with OpenAPI metadata.
   */
  query?: Record<string, ParamValue> | ((state: S) => Record<string, string>);

  /** Request headers (merged with client headers) — static object or function deriving from setup state */
  headers?: Record<string, string> | ((state: S) => Record<string, string>);

  /**
   * Setup function — runs before the request. Return value is available
   * to params/query (if function) and teardown.
   */
  setup?: (ctx: TestContext) => Promise<S>;

  /**
   * Teardown function — runs after verify, even if verify fails.
   */
  teardown?: (ctx: TestContext, state: S) => Promise<void>;

  /**
   * Business logic verification — runs after status and schema validation.
   * `res` is the schema-parsed response (typed) if schema was provided,
   * otherwise the raw parsed JSON (unknown).
   *
   * Use this for assertions that can't be expressed declaratively:
   * field relationships, computed checks, side-effect verification.
   */
  verify?: (ctx: TestContext, res: T) => Promise<void>;

  /**
   * Mark this case as not yet executable. Reason is shown in skip message
   * and coverage reports. Remove this field to activate the case.
   */
  deferred?: string;

  /** Additional tags for this case (merged with contract-level tags) */
  tags?: string[];

  /**
   * Physical capability this case requires to execute.
   *
   * Default: `"headless"` — fully automated, no human in loop.
   *
   * When set to `"browser"` or `"out-of-band"`, the runner will skip this case
   * unless the corresponding `--include-browser` / `--include-out-of-band` flag
   * is passed. Skipped cases are reported explicitly with reason.
   *
   * Note: setting `requires` to a non-headless value automatically implies
   * `defaultRun: "opt-in"`.
   */
  requires?: CaseRequires;

  /**
   * Default run policy — should this case run automatically, or only when
   * explicitly requested?
   *
   * Default: `"always"` — run whenever the runner satisfies `requires`.
   *
   * Set to `"opt-in"` for cases that are expensive (real Twilio SMS),
   * have real side effects (Stripe charges), or are slow (stress tests).
   * Opt-in cases require `--include-opt-in` to run, even locally.
   *
   * Note: when `requires !== "headless"`, `defaultRun` is automatically
   * set to `"opt-in"` if not explicitly provided.
   */
  defaultRun?: CaseDefaultRun;

  /**
   * Case severity. Affects Cloud alert routing.
   * Default: `"warning"`.
   */
  severity?: CaseSeverity;

  /**
   * Mark this case as deprecated. Value is the deprecation reason.
   * Deprecated cases are skipped at runtime but appear in projection output.
   *
   * `deprecated` takes precedence over `deferred`: if both are set,
   * lifecycle normalizes to `"deprecated"`.
   */
  deprecated?: string;

  /**
   * OpenAPI extensions (x-* keys). Merged over contract-level extensions
   * (precedence: defaults < contract < case).
   */
  extensions?: Extensions;
}

// =============================================================================
// Contract spec
// =============================================================================

/**
 * Structured request specification.
 * Can be provided as a bare SchemaLike (shorthand for JSON body) or as an
 * object with full metadata (contentType, headers, examples).
 */
export type RequestSpec =
  | SchemaLike<unknown>
  | {
      body?: SchemaLike<unknown>;
      /** Request content type. Default: "application/json". */
      contentType?: string;
      /** Request headers schema (OpenAPI docs only, not runtime validated on request). */
      headers?: SchemaLike<Record<string, string>>;
      /** Single example value */
      example?: unknown;
      /** Named examples */
      examples?: Record<string, ContractExample<unknown>>;
    };

/**
 * Spec for contract.http() — defines an HTTP endpoint and its cases.
 *
 * @template Cases Record of case key → ContractCase
 */
export interface HttpContractSpec<
  Cases extends Record<string, ContractCase<any, any>> = Record<string, ContractCase>,
> {
  /** HTTP method + path, e.g. "POST /users" or "GET /runs/:runId" */
  endpoint: string;

  /** Human-readable description (optional, for projection/docs) */
  description?: string;

  /**
   * Feature grouping key for projection output.
   * Contracts with the same `feature` value are grouped into one section.
   * If omitted, the contract is grouped by endpoint.
   *
   * Use business language, not technical terms:
   *   Good: "用户注册", "User Registration"
   *   Bad:  "POST /users endpoint"
   */
  feature?: string;

  /**
   * Default HTTP client for all cases.
   * Individual cases can override with their own `client`.
   */
  client?: HttpClient;

  /**
   * Request specification — endpoint-level, for scanner/OpenAPI (not used at runtime).
   * Can be a bare SchemaLike (shorthand for JSON body) or a structured RequestSpec object.
   */
  request?: RequestSpec;

  /** Tags inherited by all cases */
  tags?: string[];

  /**
   * Mark the entire endpoint as deprecated. Value is the deprecation reason.
   * Propagates to all cases: every case lifecycle becomes "deprecated" unless
   * the case explicitly sets its own `deprecated` reason.
   * Maps to OpenAPI operation `deprecated: true` + `x-deprecated-reason`.
   */
  deprecated?: string;

  /**
   * OpenAPI extensions (x-* keys). Merged over instance-level defaults.extensions.
   * Precedence: defaults < contract < case.
   */
  extensions?: Extensions;

  /** Named spec cases */
  cases: Cases;
}

// =============================================================================
// HttpContract — the return value of contract.http()
// =============================================================================

/**
 * Return value of contract.http().
 *
 * Extends Array<Test> so runner/resolve can iterate it directly.
 * Adds contract-level properties and interop methods.
 */
export interface HttpContract extends Array<Test> {
  /** Contract ID */
  readonly id: string;

  /** Endpoint (e.g. "POST /users") */
  readonly endpoint: string;

  /** Contract-level description */
  readonly description?: string;

  /** Feature grouping key */
  readonly feature?: string;

  /** Instance name from contract.http.with("name", ...) */
  readonly instanceName?: string;

  /** Security scheme declaration */
  readonly security?: HttpSecurityScheme;

  /** Endpoint-level request schema, normalized to body SchemaLike */
  readonly request?: SchemaLike<unknown>;

  /** Endpoint-level request content type (default: "application/json") */
  readonly requestContentType?: string;

  /** Contract-level deprecation reason (propagates to all cases) */
  readonly deprecated?: string;

  /**
   * Contract-level merged extensions (defaults < contract).
   * Case-level merged extensions live on _caseSchemas[key].extensions.
   */
  readonly extensions?: Extensions;

  /**
   * Per-case metadata for runtime extraction (OpenAPI generation, projection).
   * Maps case key → full case metadata including schema and gating fields.
   */
  readonly _caseSchemas?: Record<string, {
    expectStatus?: number;
    responseSchema?: SchemaLike<unknown>;
    /** Response headers schema (OpenAPI + runtime validation) */
    responseHeaders?: SchemaLike<NormalizedHeaders>;
    /** Response content-type (default: application/json) */
    responseContentType?: string;
    /** Single example (OpenAPI docs) */
    example?: unknown;
    /** Named examples (OpenAPI docs) */
    examples?: Record<string, ContractExample<unknown>>;
    /** Per-path-param metadata (schema, description, required, deprecated) */
    paramSchemas?: Record<string, {
      schema?: SchemaLike<unknown>;
      description?: string;
      required?: boolean;
      deprecated?: boolean;
    }>;
    /** Per-query-param metadata */
    querySchemas?: Record<string, {
      schema?: SchemaLike<unknown>;
      description?: string;
      required?: boolean;
      deprecated?: boolean;
    }>;
    description?: string;
    deferred?: string;
    deprecated?: string;
    severity?: CaseSeverity;
    lifecycle: CaseLifecycle;
    requires?: CaseRequires;
    defaultRun?: CaseDefaultRun;
    /** Fully merged extensions (defaults < contract < case) */
    extensions?: Extensions;
  }>;

  /**
   * Inject all cases as steps into a test builder.
   * Usage: test("e2e").use(myContract.asSteps()).step(...).build()
   */
  asSteps(): <S>(b: import("./index.js").TestBuilder<S>) => import("./index.js").TestBuilder<S>;

  /**
   * Inject a single case as a step into a test builder.
   * Defaults to the first non-deferred case if caseKey is omitted.
   */
  asStep(caseKey?: string): <S>(b: import("./index.js").TestBuilder<S>) => import("./index.js").TestBuilder<S>;
}

// =============================================================================
// Flow contract
// =============================================================================

/**
 * Spec for a single HTTP step in a contract.flow() chain.
 *
 * Flow steps are verification, not spec: each step has one fixed expected
 * outcome (expect), not multiple possible responses.
 *
 * @template T Response type (inferred from expect.schema)
 * @template S Incoming state type from previous step
 */
export interface HttpFlowStepSpec<T = unknown, S = unknown> {
  /** HTTP method + path, e.g. "POST /users" or "GET /runs/:runId" */
  endpoint: string;

  /** Optional description of this step's purpose. */
  description?: string;

  /** HTTP client for this step. Falls back to flow-level default client. */
  client?: HttpClient;

  /** Fixed expected outcome for this step */
  expect: ContractExpect<T>;

  /** URL params — static or derived from previous step's state */
  params?: Record<string, string> | ((state: S) => Record<string, string>);

  /** Query parameters */
  query?: Record<string, string> | ((state: S) => Record<string, string>);

  /** Request headers — static object or derived from previous step's state */
  headers?: Record<string, string> | ((state: S) => Record<string, string>);

  /** Request body — static or derived from state */
  body?: unknown | ((state: S) => unknown);

  /**
   * Business logic verification — runs after status and schema validation.
   * Receives schema-parsed value or raw JSON.
   */
  verify?: (ctx: TestContext, res: T) => Promise<void>;

  /**
   * Extract state from response for the next step.
   * Receives the response and current state. Output replaces state.
   * If omitted, state passes through unchanged.
   */
  returns?: (res: T, state: S) => unknown;
}

// =============================================================================
// Plugin protocol adapter
// =============================================================================

/**
 * Protocol adapter v2 for contract.register().
 * Plugins implement this to add contract.grpc(), contract.ws(), etc.
 *
 * Breaking change from v1: `metadata()` replaced by `project()`.
 * No v1 compat — no third-party plugins exist yet.
 */
export interface ContractProtocolAdapter<Spec = unknown> {
  /** Generate a Test function for a single case */
  execute: (ctx: TestContext, caseSpec: unknown, endpointSpec: Spec) => Promise<void>;

  /**
   * Project spec into normalized contract metadata.
   * Scanner / CLI / MCP / Cloud consume this.
   *
   * **Invariant:** `project().cases[].key` must 1:1 match `spec.cases` keys.
   * `contract.register()` validates this at registration time:
   * - projected key not in spec.cases → hard error
   * - spec.cases key not in projection → hard error
   * - duplicate key → hard error
   */
  project: (spec: Spec) => ContractProjection;

  /**
   * Optional: determine where schema validation mounts.
   * HTTP → "response.body", gRPC → "response.message", GraphQL → "response.data"
   */
  schemaMount?: (caseSpec: unknown, spec: Spec) => string | undefined;

  /**
   * Optional: classify failure from events/error.
   * Consumed by repair loop and Cloud — they don't need to understand protocol details.
   */
  classifyFailure?: (input: {
    error?: unknown;
    events: Array<{ type: string; data: Record<string, unknown> }>;
  }) => FailureClassification | undefined;
}

/**
 * Return type of `ContractProtocolAdapter.project()`.
 * Aligns with NormalizedContractMeta in scanner.
 */
export interface ContractProjection {
  protocol: string;
  target: string;
  description?: string;
  feature?: string;
  instanceName?: string;
  security?: unknown;
  schemaMount?: string;
  requestSchema?: unknown | null;
  cases: Array<{
    key: string;
    description?: string;
    lifecycle: CaseLifecycle;
    severity: CaseSeverity;
    deferredReason?: string;
    deprecatedReason?: string;
    requires?: CaseRequires;
    defaultRun?: CaseDefaultRun;
    schemaMount?: string;
    protocolExpect?: Record<string, unknown>;
    responseSchema?: unknown | null;
    protocolMeta?: Record<string, unknown>;
  }>;
  protocolMeta?: Record<string, unknown>;
}

/**
 * Return value of `contract[protocol]()` — extends Test[] with projection carrier.
 * Mirrors HttpContract: extends Array<Test> + metadata for scanner extraction.
 *
 * `_projection` extends ContractProjection with `id` — injected by `contract.register()`
 * since the adapter's `project()` doesn't know the user-supplied contract id.
 */
export interface ProtocolContract extends Array<Test> {
  /** Adapter project() output + injected id. Scanner duck-types this field for extraction. */
  readonly _projection: ContractProjection & { id: string };
}

// =============================================================================
// Registry metadata extension
// =============================================================================

/** Contract-specific metadata attached to RegisteredTestMeta. Protocol-agnostic. */
export interface ContractRegistryMeta {
  /** Protocol-agnostic target. HTTP: "POST /users", gRPC: "Greeter/SayHello" */
  target: string;
  /** Protocol identifier */
  protocol: string;
  /** Case key within the contract */
  caseKey: string;
  /** Case lifecycle */
  lifecycle: CaseLifecycle;
  /** Case severity */
  severity: CaseSeverity;
  /** Whether response schema is defined */
  hasSchema: boolean;
  /** Instance name from contract.http.with("name", ...) */
  instanceName?: string;
  /**
   * Protocol-specific metadata. Core does not read this field's contents.
   * HTTP: { security: "bearer", expect: { status: 200 } }
   * gRPC: { expect: { code: 0 } }
   */
  protocolMeta?: Record<string, unknown>;
}

/**
 * @deprecated Use `RegisteredTestMeta` directly — it now has an optional `contract` field.
 * Kept as an alias for backward compatibility.
 */
export type ContractCaseMeta = RegisteredTestMeta & { contract: ContractRegistryMeta };
