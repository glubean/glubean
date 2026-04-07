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

  /** Why this case exists — business logic, boundary condition, or intent. Required. */
  description: string;

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

  /** Request headers */
  headers?: Record<string, string>;

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
 * @deprecated Use `RegisteredTestMeta` directly — it now has an optional `contract` field.
 * Kept as an alias for backward compatibility.
 */
export type ContractCaseMeta = RegisteredTestMeta & { contract: ContractRegistryMeta };
