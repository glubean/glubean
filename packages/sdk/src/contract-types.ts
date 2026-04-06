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
// Case definition
// =============================================================================

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
}

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

  /** Expected response */
  expect: ContractExpect<T>;

  /** Request body (for POST/PUT/PATCH) */
  body?: unknown;

  /** URL params — static object or function deriving from setup state */
  params?: Record<string, string> | ((state: S) => Record<string, string>);

  /** Query parameters */
  query?: Record<string, string> | ((state: S) => Record<string, string>);

  /** Request headers (merged with client headers) */
  headers?: Record<string, string>;

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
}

// =============================================================================
// Contract spec
// =============================================================================

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
   * Default HTTP client for all cases.
   * Individual cases can override with their own `client`.
   */
  client?: HttpClient;

  /** Request body schema — endpoint-level, for scanner/OpenAPI (not for execution) */
  request?: SchemaLike<unknown>;

  /** Tags inherited by all cases */
  tags?: string[];

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

  /** Endpoint-level request schema (if provided) */
  readonly request?: SchemaLike<unknown>;

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
// Plugin protocol adapter
// =============================================================================

/**
 * Protocol adapter for contract.register().
 * Plugins implement this to add contract.grpc(), contract.ws(), etc.
 */
export interface ContractProtocolAdapter<Spec = unknown> {
  /** Generate a Test function for a single case */
  execute: (ctx: TestContext, caseSpec: unknown, endpointSpec: Spec) => Promise<void>;

  /** Extract registry-time metadata from the spec */
  metadata: (spec: Spec) => {
    protocol: string;
    endpoint?: string;
    [key: string]: unknown;
  };
}

// =============================================================================
// Registry metadata extension
// =============================================================================

/** Contract-specific metadata attached to RegisteredTestMeta. */
export interface ContractRegistryMeta {
  /** Endpoint (e.g. "POST /users") */
  endpoint: string;
  /** Protocol */
  protocol: string;
  /** Case key within the contract */
  caseKey: string;
  /** Expected status code */
  expectStatus: number;
  /** Whether response schema is defined */
  hasSchema: boolean;
  /** Deferred reason, or undefined if executable */
  deferred?: string;
}

/**
 * RegisteredTestMeta with contract extension.
 * This is what contract.http() registers to the global registry.
 */
export interface ContractCaseMeta extends RegisteredTestMeta {
  contract: ContractRegistryMeta;
}
