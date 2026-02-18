/**
 * GraphQL plugin for Glubean tests.
 *
 * Provides a thin wrapper over `ctx.http` (or any `HttpClient`) that simplifies
 * GraphQL query/mutation execution with auto-tracing, operationName extraction,
 * and optional error-throwing behavior.
 *
 * ## Usage
 *
 * ### As a plugin via `configure()` (recommended)
 *
 * ```ts
 * import { test, configure } from "@glubean/sdk";
 * import { graphql } from "@glubean/graphql";
 *
 * const { gql } = configure({
 *   plugins: {
 *     gql: graphql({
 *       endpoint: "{{graphql_url}}",
 *       headers: { Authorization: "Bearer {{api_key}}" },
 *     }),
 *   },
 * });
 *
 * export const getUser = test("get-user", async (ctx) => {
 *   const { data, errors } = await gql.query<{ user: { name: string } }>(`
 *     query GetUser($id: ID!) {
 *       user(id: $id) { name }
 *     }
 *   `, { variables: { id: "1" } });
 *
 *   ctx.expect(errors).toBeUndefined();
 *   ctx.expect(data?.user.name).toBe("Alice");
 * });
 * ```
 *
 * ### Standalone (without `configure()`)
 *
 * ```ts
 * import { test } from "@glubean/sdk";
 * import { createGraphQLClient } from "@glubean/graphql";
 *
 * export const quick = test("quick-gql", async (ctx) => {
 *   const gql = createGraphQLClient(ctx.http, {
 *     endpoint: "https://api.example.com/graphql",
 *   });
 *   const { data } = await gql.query(`{ health }`);
 *   ctx.assert(data?.health === "ok", "Service healthy");
 * });
 * ```
 *
 * @module graphql
 */

import { definePlugin } from "@glubean/sdk/plugin";
import type { GlubeanRuntime, HttpClient } from "@glubean/sdk";

// =============================================================================
// Types
// =============================================================================

/**
 * A single GraphQL error as defined by the
 * [GraphQL spec](https://spec.graphql.org/October2021/#sec-Errors).
 *
 * @example
 * ```ts
 * // Typical error shape from a GraphQL server
 * {
 *   message: "User not found",
 *   locations: [{ line: 2, column: 3 }],
 *   path: ["user"],
 *   extensions: { code: "NOT_FOUND" }
 * }
 * ```
 */
export interface GraphQLError {
  /** Human-readable error description */
  message: string;
  /** Source locations in the query that caused this error */
  locations?: { line: number; column: number }[];
  /** Path to the field that produced the error */
  path?: (string | number)[];
  /** Server-defined extension data (e.g., error codes) */
  extensions?: Record<string, unknown>;
}

/**
 * Standard GraphQL response envelope.
 *
 * Per the spec, `data` is `null` when all requested fields errored,
 * and `errors` is absent when there are no errors.
 *
 * @template T Shape of the `data` field
 */
export interface GraphQLResponse<T = unknown> {
  /** The result of the query/mutation. `null` if all fields errored. */
  data: T | null;
  /** Array of errors, if any. Absent when no errors. */
  errors?: GraphQLError[];
  /** Optional server extensions (e.g., tracing, cost). */
  extensions?: Record<string, unknown>;
}

/**
 * Options for a single GraphQL request.
 */
export interface GraphQLRequestOptions {
  /** Variables to pass to the query/mutation */
  variables?: Record<string, unknown>;
  /**
   * Explicit operationName. If omitted, the client parses the first named
   * operation from the query string (e.g., `query GetUser` → `"GetUser"`).
   */
  operationName?: string;
  /** Additional headers for this request only */
  headers?: Record<string, string>;
}

/**
 * Options for creating a GraphQL client.
 */
export interface GraphQLClientOptions {
  /** The GraphQL endpoint URL (e.g., "https://api.example.com/graphql") */
  endpoint: string;
  /** Default headers sent with every request */
  headers?: Record<string, string>;
  /**
   * If `true`, the client throws a `GraphQLResponseError` when the response
   * contains `errors`, even though the HTTP status is 200.
   *
   * Default: `false` — errors are returned in the response object.
   *
   * @example
   * ```ts
   * const gql = createGraphQLClient(ctx.http, {
   *   endpoint: "https://api.example.com/graphql",
   *   throwOnGraphQLErrors: true,
   * });
   *
   * try {
   *   const { data } = await gql.query(`{ me { name } }`);
   * } catch (err) {
   *   if (err instanceof GraphQLResponseError) {
   *     console.log(err.errors); // GraphQLError[]
   *   }
   * }
   * ```
   */
  throwOnGraphQLErrors?: boolean;
}

/**
 * Error thrown when a GraphQL response contains errors and
 * `throwOnGraphQLErrors` is enabled.
 */
export class GraphQLResponseError extends Error {
  /** The GraphQL errors from the response */
  readonly errors: GraphQLError[];
  /** The original response (may contain partial `data`) */
  readonly response: GraphQLResponse;

  constructor(errors: GraphQLError[], response: GraphQLResponse) {
    const summary = errors.map((e) => e.message).join("; ");
    super(`GraphQL errors: ${summary}`);
    this.name = "GraphQLResponseError";
    this.errors = errors;
    this.response = response;
  }
}

/**
 * A GraphQL client bound to a specific endpoint.
 *
 * All requests are auto-traced via the underlying `HttpClient`.
 * The operation name is injected into traces via the `X-Glubean-Op` header,
 * so the dashboard can distinguish between different GraphQL operations
 * instead of showing a generic `POST /graphql`.
 */
export interface GraphQLClient {
  /**
   * Execute a GraphQL query.
   *
   * @template T Shape of the `data` field
   * @param query The GraphQL query string
   * @param options Variables, operationName, and extra headers
   * @returns The parsed GraphQL response
   *
   * @example
   * ```ts
   * const { data, errors } = await gql.query<{ users: User[] }>(`
   *   query ListUsers($limit: Int) {
   *     users(limit: $limit) { id name }
   *   }
   * `, { variables: { limit: 10 } });
   * ```
   */
  query<T = unknown>(
    query: string,
    options?: GraphQLRequestOptions,
  ): Promise<GraphQLResponse<T>>;

  /**
   * Execute a GraphQL mutation.
   *
   * Functionally identical to `query()` — the distinction is purely semantic
   * to improve readability in test code.
   *
   * @template T Shape of the `data` field
   * @param mutation The GraphQL mutation string
   * @param options Variables, operationName, and extra headers
   * @returns The parsed GraphQL response
   *
   * @example
   * ```ts
   * const { data } = await gql.mutate<{ createUser: { id: string } }>(`
   *   mutation CreateUser($input: CreateUserInput!) {
   *     createUser(input: $input) { id }
   *   }
   * `, { variables: { input: { name: "Alice" } } });
   * ```
   */
  mutate<T = unknown>(
    mutation: string,
    options?: GraphQLRequestOptions,
  ): Promise<GraphQLResponse<T>>;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Extract the first named operation from a GraphQL query string.
 *
 * Matches patterns like:
 * - `query GetUser` -> "GetUser"
 * - `mutation CreateUser` -> "CreateUser"
 * - `subscription OnMessage` -> "OnMessage"
 * - `query GetUser($id: ID!)` -> "GetUser"
 *
 * Returns `undefined` for anonymous operations (e.g., `{ users { id } }`).
 *
 * @internal
 */
export function parseOperationName(query: string): string | undefined {
  const match = query.match(/(?:query|mutation|subscription)\s+([A-Za-z_]\w*)/);
  return match?.[1];
}

// =============================================================================
// Tagged template
// =============================================================================

/**
 * Tagged template literal for GraphQL queries.
 *
 * This is an identity function — it returns the query string as-is.
 * Its purpose is purely for IDE integration: the VSCode GraphQL extension
 * recognizes the `gql` tag and enables syntax highlighting (and autocomplete
 * when a `.graphqlrc` schema is configured).
 *
 * For full IDE support (autocomplete, validation), prefer `.gql` files
 * loaded via `fromGql()`. Use `gql` for quick inline queries where a
 * separate file would be overkill.
 *
 * @example
 * ```ts
 * import { gql } from "@glubean/graphql";
 *
 * const GET_USER = gql`
 *   query GetUser($id: ID!) {
 *     user(id: $id) { name email }
 *   }
 * `;
 *
 * const { data } = await client.query(GET_USER, { variables: { id: "1" } });
 * ```
 */
export function gql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  let result = strings[0];
  for (let i = 0; i < values.length; i++) {
    result += String(values[i]) + strings[i + 1];
  }
  return result;
}

// =============================================================================
// Client implementation
// =============================================================================

/**
 * Create a GraphQL client bound to a specific endpoint.
 *
 * The client wraps the provided `HttpClient` (typically `ctx.http`), so all
 * requests inherit auto-tracing, auto-metrics, and retry behavior.
 *
 * The operation name is injected via the `X-Glubean-Op` request header.
 * The runner's harness reads this header to set `trace.name`, making
 * individual GraphQL operations distinguishable in the dashboard.
 *
 * @param http The base HTTP client (e.g., `ctx.http`)
 * @param options Endpoint URL, default headers, error handling
 * @returns A bound `GraphQLClient` instance
 *
 * @example Basic usage
 * ```ts
 * import { createGraphQLClient } from "@glubean/graphql";
 *
 * export const myTest = test("gql-test", async (ctx) => {
 *   const gql = createGraphQLClient(ctx.http, {
 *     endpoint: ctx.vars.require("GQL_URL"),
 *     headers: { Authorization: `Bearer ${ctx.secrets.require("TOKEN")}` },
 *   });
 *
 *   const { data } = await gql.query<{ user: { name: string } }>(`
 *     query GetUser($id: ID!) { user(id: $id) { name } }
 *   `, { variables: { id: "1" } });
 *
 *   ctx.expect(data?.user.name).toBe("Alice");
 * });
 * ```
 *
 * @example With throwOnGraphQLErrors
 * ```ts
 * const gql = createGraphQLClient(ctx.http, {
 *   endpoint: ctx.vars.require("GQL_URL"),
 *   throwOnGraphQLErrors: true,
 * });
 *
 * // This will throw GraphQLResponseError if the response contains errors
 * const { data } = await gql.query(`{ me { name } }`);
 * ```
 */
export function createGraphQLClient(
  http: HttpClient,
  options: GraphQLClientOptions,
): GraphQLClient {
  const { endpoint, headers: defaultHeaders, throwOnGraphQLErrors } = options;

  async function execute<T>(
    query: string,
    requestOptions?: GraphQLRequestOptions,
  ): Promise<GraphQLResponse<T>> {
    const opName = requestOptions?.operationName ?? parseOperationName(query) ?? "anonymous";

    const mergedHeaders: Record<string, string> = {
      ...defaultHeaders,
      ...requestOptions?.headers,
      "X-Glubean-Op": opName,
    };

    const body: Record<string, unknown> = { query };
    if (requestOptions?.variables) {
      body.variables = requestOptions.variables;
    }
    if (opName !== "anonymous") {
      body.operationName = opName;
    }

    const response = await http
      .post(endpoint, {
        json: body,
        headers: mergedHeaders,
        throwHttpErrors: false,
      })
      .json<GraphQLResponse<T>>();

    if (throwOnGraphQLErrors && response.errors && response.errors.length > 0) {
      throw new GraphQLResponseError(response.errors, response);
    }

    return response;
  }

  return {
    query: <T>(query: string, options?: GraphQLRequestOptions) => execute<T>(query, options),
    mutate: <T>(mutation: string, options?: GraphQLRequestOptions) => execute<T>(mutation, options),
  };
}

// =============================================================================
// Plugin factory
// =============================================================================

/**
 * Create a GraphQL plugin for use with `configure({ plugins })`.
 *
 * Resolves `{{template}}` placeholders in `endpoint` and `headers` using
 * the Glubean runtime (vars and secrets). The returned `GraphQLClient` is
 * lazily created on first access.
 *
 * @param options GraphQL client options (endpoint may use `{{var_name}}` templates)
 * @returns A `PluginFactory` that produces a `GraphQLClient`
 *
 * @example
 * ```ts
 * import { test, configure } from "@glubean/sdk";
 * import { graphql } from "@glubean/graphql";
 *
 * const { gql } = configure({
 *   plugins: {
 *     gql: graphql({
 *       endpoint: "{{graphql_url}}",
 *       headers: { Authorization: "Bearer {{api_key}}" },
 *       throwOnGraphQLErrors: true,
 *     }),
 *   },
 * });
 *
 * export const getUser = test("get-user", async (ctx) => {
 *   const { data } = await gql.query<{ user: { name: string } }>(
 *     `query GetUser($id: ID!) { user(id: $id) { name } }`,
 *     { variables: { id: "1" } },
 *   );
 *   ctx.expect(data?.user.name).toBe("Alice");
 * });
 * ```
 */
export function graphql(
  options: GraphQLClientOptions,
): import("@glubean/sdk").PluginFactory<GraphQLClient> {
  return definePlugin((runtime: GlubeanRuntime) => {
    const resolved: GraphQLClientOptions = {
      ...options,
      endpoint: runtime.resolveTemplate(options.endpoint),
    };
    if (options.headers) {
      resolved.headers = {};
      for (const [k, v] of Object.entries(options.headers)) {
        resolved.headers[k] = runtime.resolveTemplate(v);
      }
    }
    return createGraphQLClient(runtime.http, resolved);
  });
}

// Re-export data loader for convenience (spec: `import { fromGql } from "@glubean/graphql"`)
export { fromGql } from "./data.ts";
