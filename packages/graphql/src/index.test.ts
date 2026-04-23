/**
 * Tests for the @glubean/graphql plugin package.
 *
 * Includes behavioral baseline tests migrated from the SDK core (Phase 0)
 * plus new tests for the graphql() plugin factory.
 */

import { test, expect } from "vitest";
import {
  createGraphQLClient,
  gql,
  graphql,
  type GraphQLResponse,
  GraphQLResponseError,
  parseOperationName,
} from "./index.js";
import type { HttpClient, HttpRequestOptions, HttpResponsePromise } from "@glubean/sdk";
import type { GlubeanRuntime } from "@glubean/sdk";

// =============================================================================
// Test helpers
// =============================================================================

interface CapturedPost {
  url: string | URL | Request;
  options: HttpRequestOptions;
}

/**
 * Create a mock HttpClient that captures post() calls and returns
 * a configurable GraphQL response.
 */
function createMockGqlHttp(
  responseData: GraphQLResponse = { data: null },
  captures: CapturedPost[] = [],
): HttpClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mock: any = function () {
    return Promise.resolve(new Response("mock"));
  };

  const jsonPromise = (response: GraphQLResponse): HttpResponsePromise => {
    const p = Promise.resolve(new Response(JSON.stringify(response)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).json = () => Promise.resolve(response);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).text = () => Promise.resolve(JSON.stringify(response));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).blob = () => Promise.resolve(new Blob([JSON.stringify(response)]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).arrayBuffer = () =>
      Promise.resolve(
        new TextEncoder().encode(JSON.stringify(response)).buffer,
      );
    return p as HttpResponsePromise;
  };

  mock.post = (url: string | URL | Request, options?: HttpRequestOptions) => {
    captures.push({ url, options: options ?? {} });
    return jsonPromise(responseData);
  };
  mock.get = mock;
  mock.put = mock;
  mock.patch = mock;
  mock.delete = mock;
  mock.head = mock;
  mock.extend = () => mock;

  return mock as HttpClient;
}

/**
 * Create a minimal GlubeanRuntime mock for plugin factory tests.
 */
function createMockRuntime(
  vars: Record<string, string> = {},
  secrets: Record<string, string> = {},
  http?: HttpClient,
): GlubeanRuntime {
  const allValues = { ...vars, ...secrets };
  return {
    vars,
    secrets,
    http: http ?? createMockGqlHttp({ data: { test: true } }),
    requireVar(key: string): string {
      const val = vars[key];
      if (val === undefined) throw new Error(`Missing var: ${key}`);
      return val;
    },
    requireSecret(key: string): string {
      const val = secrets[key];
      if (val === undefined) throw new Error(`Missing secret: ${key}`);
      return val;
    },
    resolveTemplate(template: string): string {
      return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        const val = allValues[key];
        if (val === undefined) return `{{${key}}}`;
        return val;
      });
    },
    action() {},
    event() {},
    log() {},
    trace() {},
  };
}

// =============================================================================
// parseOperationName()
// =============================================================================

test("parseOperationName - named query", () => {
  expect(parseOperationName("query GetUser { user { id } }")).toBe("GetUser");
});

test("parseOperationName - named mutation", () => {
  expect(
    parseOperationName(
      "mutation CreateUser($input: CreateUserInput!) { createUser(input: $input) { id } }",
    ),
  ).toBe("CreateUser");
});

test("parseOperationName - named subscription", () => {
  expect(
    parseOperationName("subscription OnMessage { messages { text } }"),
  ).toBe("OnMessage");
});

test("parseOperationName - query with arguments", () => {
  expect(
    parseOperationName("query GetUser($id: ID!) { user(id: $id) { name } }"),
  ).toBe("GetUser");
});

test("parseOperationName - anonymous query returns undefined", () => {
  expect(parseOperationName("{ users { id } }")).toBeUndefined();
});

test("parseOperationName - anonymous mutation returns undefined", () => {
  expect(parseOperationName("mutation { deleteAll }")).toBeUndefined();
});

test("parseOperationName - multiline query", () => {
  expect(
    parseOperationName(`
      query ListUsers($limit: Int) {
        users(limit: $limit) { id name }
      }
    `),
  ).toBe("ListUsers");
});

test("parseOperationName - underscore-prefixed name", () => {
  expect(
    parseOperationName("query _InternalQuery { data }"),
  ).toBe("_InternalQuery");
});

// =============================================================================
// gql tagged template
// =============================================================================

test("gql - simple string", () => {
  const query = gql`
    query GetUser {
      user {
        id
      }
    }
  `;
  expect(query).toBe("query GetUser { user { id } }");
});

test("gql - with interpolation", () => {
  const field = "name";
  const query = gql`query { user { ${field} } }`;
  expect(query).toBe("query { user { name } }");
});

test("gql - multiline preserves whitespace", () => {
  const query = gql`
    query GetUser($id: ID!) {
      user(id: $id) {
        name
        email
      }
    }
  `;
  expect(query.includes("query GetUser")).toBe(true);
  expect(query.includes("user(id: $id)")).toBe(true);
});

test("gql - with multiple interpolations", () => {
  const type = "User";
  const field = "name";
  const query = gql`query { ${type.toLowerCase()} { ${field} } }`;
  expect(query).toBe("query { user { name } }");
});

// =============================================================================
// GraphQLResponseError
// =============================================================================

test("GraphQLResponseError - constructor sets errors and response", () => {
  const errors = [{ message: "Not found" }, { message: "Unauthorized" }];
  const response: GraphQLResponse = { data: null, errors };
  const err = new GraphQLResponseError(errors, response);

  expect(err.errors).toEqual(errors);
  expect(err.response).toEqual(response);
  expect(err.name).toBe("GraphQLResponseError");
  expect(err.message).toBe("GraphQL errors: Not found; Unauthorized");
  expect(err instanceof Error).toBe(true);
});

test("GraphQLResponseError - single error message", () => {
  const errors = [{ message: "Bad request" }];
  const response: GraphQLResponse = { data: null, errors };
  const err = new GraphQLResponseError(errors, response);

  expect(err.message).toBe("GraphQL errors: Bad request");
});

// =============================================================================
// createGraphQLClient - query
// =============================================================================

test("createGraphQLClient - query sends POST with correct body", async () => {
  const captures: CapturedPost[] = [];
  const mockHttp = createMockGqlHttp(
    { data: { user: { name: "Alice" } } },
    captures,
  );

  const client = createGraphQLClient(mockHttp, {
    endpoint: "https://api.example.com/graphql",
  });

  const result = await client.query<{ user: { name: string } }>(
    "query GetUser($id: ID!) { user(id: $id) { name } }",
    { variables: { id: "1" } },
  );

  expect(captures.length).toBe(1);
  expect(captures[0].url).toBe("https://api.example.com/graphql");

  const body = captures[0].options.json as Record<string, unknown>;
  expect(body.query).toBe(
    "query GetUser($id: ID!) { user(id: $id) { name } }",
  );
  expect(body.variables).toEqual({ id: "1" });
  expect(body.operationName).toBe("GetUser");

  expect(result.data?.user.name).toBe("Alice");
});

test("createGraphQLClient - sets X-Glubean-Op header with operation name", async () => {
  const captures: CapturedPost[] = [];
  const mockHttp = createMockGqlHttp({ data: null }, captures);

  const client = createGraphQLClient(mockHttp, {
    endpoint: "https://api.example.com/graphql",
  });

  await client.query("query ListUsers { users { id } }");

  const headers = captures[0].options.headers as Record<string, string>;
  expect(headers["X-Glubean-Op"]).toBe("ListUsers");
});

test("createGraphQLClient - anonymous query uses 'anonymous' in header", async () => {
  const captures: CapturedPost[] = [];
  const mockHttp = createMockGqlHttp({ data: { health: "ok" } }, captures);

  const client = createGraphQLClient(mockHttp, {
    endpoint: "https://api.example.com/graphql",
  });

  await client.query("{ health }");

  const headers = captures[0].options.headers as Record<string, string>;
  expect(headers["X-Glubean-Op"]).toBe("anonymous");

  const body = captures[0].options.json as Record<string, unknown>;
  expect(body.operationName).toBeUndefined();
});

test("createGraphQLClient - explicit operationName overrides parsed name", async () => {
  const captures: CapturedPost[] = [];
  const mockHttp = createMockGqlHttp({ data: null }, captures);

  const client = createGraphQLClient(mockHttp, {
    endpoint: "https://api.example.com/graphql",
  });

  await client.query("query GetUser { user { id } }", {
    operationName: "OverrideName",
  });

  const headers = captures[0].options.headers as Record<string, string>;
  expect(headers["X-Glubean-Op"]).toBe("OverrideName");

  const body = captures[0].options.json as Record<string, unknown>;
  expect(body.operationName).toBe("OverrideName");
});

test("createGraphQLClient - default headers from options", async () => {
  const captures: CapturedPost[] = [];
  const mockHttp = createMockGqlHttp({ data: null }, captures);

  const client = createGraphQLClient(mockHttp, {
    endpoint: "https://api.example.com/graphql",
    headers: {
      Authorization: "Bearer token-123",
      "X-Custom": "value",
    },
  });

  await client.query("{ health }");

  const headers = captures[0].options.headers as Record<string, string>;
  expect(headers["Authorization"]).toBe("Bearer token-123");
  expect(headers["X-Custom"]).toBe("value");
});

test("createGraphQLClient - per-request headers override defaults", async () => {
  const captures: CapturedPost[] = [];
  const mockHttp = createMockGqlHttp({ data: null }, captures);

  const client = createGraphQLClient(mockHttp, {
    endpoint: "https://api.example.com/graphql",
    headers: {
      Authorization: "Bearer default-token",
      "X-Shared": "shared",
    },
  });

  await client.query("{ health }", {
    headers: { Authorization: "Bearer override-token" },
  });

  const headers = captures[0].options.headers as Record<string, string>;
  expect(headers["Authorization"]).toBe("Bearer override-token");
  expect(headers["X-Shared"]).toBe("shared");
});

test("createGraphQLClient - sets throwHttpErrors to false", async () => {
  const captures: CapturedPost[] = [];
  const mockHttp = createMockGqlHttp({ data: null }, captures);

  const client = createGraphQLClient(mockHttp, {
    endpoint: "https://api.example.com/graphql",
  });

  await client.query("{ health }");

  expect(captures[0].options.throwHttpErrors).toBe(false);
});

test("createGraphQLClient - query without variables omits variables from body", async () => {
  const captures: CapturedPost[] = [];
  const mockHttp = createMockGqlHttp({ data: null }, captures);

  const client = createGraphQLClient(mockHttp, {
    endpoint: "https://api.example.com/graphql",
  });

  await client.query("{ health }");

  const body = captures[0].options.json as Record<string, unknown>;
  expect(body.variables).toBeUndefined();
});

// =============================================================================
// createGraphQLClient - mutate
// =============================================================================

test("createGraphQLClient - mutate sends POST identically to query", async () => {
  const captures: CapturedPost[] = [];
  const mockHttp = createMockGqlHttp(
    { data: { createUser: { id: "42" } } },
    captures,
  );

  const client = createGraphQLClient(mockHttp, {
    endpoint: "https://api.example.com/graphql",
  });

  const result = await client.mutate<{ createUser: { id: string } }>(
    "mutation CreateUser($input: CreateUserInput!) { createUser(input: $input) { id } }",
    { variables: { input: { name: "Alice" } } },
  );

  expect(captures.length).toBe(1);
  expect(captures[0].url).toBe("https://api.example.com/graphql");

  const body = captures[0].options.json as Record<string, unknown>;
  expect(body.query).toBe(
    "mutation CreateUser($input: CreateUserInput!) { createUser(input: $input) { id } }",
  );
  expect(body.variables).toEqual({ input: { name: "Alice" } });
  expect(body.operationName).toBe("CreateUser");

  const headers = captures[0].options.headers as Record<string, string>;
  expect(headers["X-Glubean-Op"]).toBe("CreateUser");

  expect(result.data?.createUser.id).toBe("42");
});

// =============================================================================
// createGraphQLClient - throwOnGraphQLErrors
// =============================================================================

test("createGraphQLClient - throwOnGraphQLErrors: false returns errors in response", async () => {
  const gqlResponse: GraphQLResponse = {
    data: null,
    errors: [{ message: "Not found" }],
  };
  const mockHttp = createMockGqlHttp(gqlResponse);

  const client = createGraphQLClient(mockHttp, {
    endpoint: "https://api.example.com/graphql",
    throwOnGraphQLErrors: false,
  });

  const result = await client.query("{ user { id } }");
  expect(result.data).toBeNull();
  expect(result.errors?.length).toBe(1);
  expect(result.errors?.[0].message).toBe("Not found");
});

test("createGraphQLClient - default (no throwOnGraphQLErrors) returns errors", async () => {
  const gqlResponse: GraphQLResponse = {
    data: null,
    errors: [{ message: "Error" }],
  };
  const mockHttp = createMockGqlHttp(gqlResponse);

  const client = createGraphQLClient(mockHttp, {
    endpoint: "https://api.example.com/graphql",
  });

  const result = await client.query("{ user { id } }");
  expect(result.errors?.length).toBe(1);
});

test("createGraphQLClient - throwOnGraphQLErrors: true throws GraphQLResponseError", async () => {
  const gqlResponse: GraphQLResponse = {
    data: null,
    errors: [{ message: "Not found" }, { message: "Forbidden" }],
  };
  const mockHttp = createMockGqlHttp(gqlResponse);

  const client = createGraphQLClient(mockHttp, {
    endpoint: "https://api.example.com/graphql",
    throwOnGraphQLErrors: true,
  });

  await expect(
    () => client.query("{ user { id } }"),
  ).rejects.toThrow(GraphQLResponseError);

  await expect(
    () => client.query("{ user { id } }"),
  ).rejects.toThrow("Not found; Forbidden");
});

test("createGraphQLClient - throwOnGraphQLErrors: true does not throw on success", async () => {
  const gqlResponse: GraphQLResponse = {
    data: { user: { id: "1" } },
  };
  const mockHttp = createMockGqlHttp(gqlResponse);

  const client = createGraphQLClient(mockHttp, {
    endpoint: "https://api.example.com/graphql",
    throwOnGraphQLErrors: true,
  });

  const result = await client.query("{ user { id } }");
  expect(result.data).toEqual({ user: { id: "1" } });
  expect(result.errors).toBeUndefined();
});

test("createGraphQLClient - throwOnGraphQLErrors: true with empty errors array does not throw", async () => {
  const gqlResponse: GraphQLResponse = {
    data: { user: { id: "1" } },
    errors: [],
  };
  const mockHttp = createMockGqlHttp(gqlResponse);

  const client = createGraphQLClient(mockHttp, {
    endpoint: "https://api.example.com/graphql",
    throwOnGraphQLErrors: true,
  });

  const result = await client.query("{ user { id } }");
  expect(result.data).toEqual({ user: { id: "1" } });
});

// =============================================================================
// createGraphQLClient - response with extensions
// =============================================================================

test("createGraphQLClient - response extensions are preserved", async () => {
  const gqlResponse: GraphQLResponse = {
    data: { user: { id: "1" } },
    extensions: { cost: 5, rateLimit: { remaining: 99 } },
  };
  const mockHttp = createMockGqlHttp(gqlResponse);

  const client = createGraphQLClient(mockHttp, {
    endpoint: "https://api.example.com/graphql",
  });

  const result = await client.query("{ user { id } }");
  expect(result.extensions?.cost).toBe(5);
});

// =============================================================================
// graphql() plugin factory
// =============================================================================

test("graphql() - returns a PluginFactory with create method", () => {
  const factory = graphql({ endpoint: "https://api.example.com/graphql" });
  expect(typeof factory.create).toBe("function");
});

test("graphql() - create() produces a GraphQLClient", () => {
  const factory = graphql({ endpoint: "https://api.example.com/graphql" });
  const runtime = createMockRuntime();
  const client = factory.create(runtime);

  expect(typeof client.query).toBe("function");
  expect(typeof client.mutate).toBe("function");
});

test("graphql() - resolves endpoint templates", async () => {
  const captures: CapturedPost[] = [];
  const mockHttp = createMockGqlHttp({ data: { ok: true } }, captures);
  const runtime = createMockRuntime(
    { graphql_url: "https://resolved.example.com/graphql" },
    {},
    mockHttp,
  );

  const factory = graphql({ endpoint: "{{graphql_url}}" });
  const client = factory.create(runtime);

  await client.query("{ health }");
  expect(captures[0].url).toBe("https://resolved.example.com/graphql");
});

test("graphql() - resolves header templates from secrets", async () => {
  const captures: CapturedPost[] = [];
  const mockHttp = createMockGqlHttp({ data: null }, captures);
  const runtime = createMockRuntime(
    { graphql_url: "https://api.example.com/graphql" },
    { api_key: "secret-token-123" },
    mockHttp,
  );

  const factory = graphql({
    endpoint: "{{graphql_url}}",
    headers: { Authorization: "Bearer {{api_key}}" },
  });
  const client = factory.create(runtime);

  await client.query("{ health }");
  const headers = captures[0].options.headers as Record<string, string>;
  expect(headers["Authorization"]).toBe("Bearer secret-token-123");
});

test("graphql() - preserves throwOnGraphQLErrors option", async () => {
  const mockHttp = createMockGqlHttp({
    data: null,
    errors: [{ message: "Fail" }],
  });
  const runtime = createMockRuntime(
    { graphql_url: "https://api.example.com/graphql" },
    {},
    mockHttp,
  );

  const factory = graphql({
    endpoint: "{{graphql_url}}",
    throwOnGraphQLErrors: true,
  });
  const client = factory.create(runtime);

  await expect(
    () => client.query("{ health }"),
  ).rejects.toThrow(GraphQLResponseError);

  await expect(
    () => client.query("{ health }"),
  ).rejects.toThrow("Fail");
});
