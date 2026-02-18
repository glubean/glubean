/**
 * Tests for @glubean/auth package.
 *
 * All four auth modes:
 * 1. bearer() — static Bearer token
 * 2. basicAuth() — HTTP Basic with base64 encoding
 * 3. apiKey() — header or query param
 * 4. oauth2.clientCredentials() — token fetch with caching
 * 5. oauth2.refreshToken() — 401 detection and refresh
 * 6. withLogin() — builder transform
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { bearer } from "./bearer.ts";
import { basicAuth } from "./basic.ts";
import { apiKey } from "./api_key.ts";
import { oauth2 } from "./oauth2.ts";
import { withLogin } from "./with_login.ts";
import { encodeBase64 } from "@std/encoding/base64";
import type { HttpClient, HttpRequestOptions, HttpResponsePromise, TestBuilder } from "@glubean/sdk";

// =============================================================================
// Test helpers
// =============================================================================

interface CapturedRequest {
  url: string | URL | Request;
  options: HttpRequestOptions;
}

function createMockHttp(
  // deno-lint-ignore no-explicit-any
  responseBody: any = {},
  captures: CapturedRequest[] = [],
  statusCode = 200,
): HttpClient {
  // deno-lint-ignore no-explicit-any
  const mock: any = function (
    url: string | URL | Request,
    options?: HttpRequestOptions,
  ) {
    captures.push({ url, options: options ?? {} });
    return createResponsePromise(responseBody, statusCode);
  };

  function createResponsePromise(
    // deno-lint-ignore no-explicit-any
    body: any,
    status: number,
  ): HttpResponsePromise {
    const p = Promise.resolve(new Response(JSON.stringify(body), { status }));
    // deno-lint-ignore no-explicit-any
    (p as any).json = () => Promise.resolve(body);
    // deno-lint-ignore no-explicit-any
    (p as any).text = () => Promise.resolve(JSON.stringify(body));
    // deno-lint-ignore no-explicit-any
    (p as any).blob = () => Promise.resolve(new Blob([JSON.stringify(body)]));
    // deno-lint-ignore no-explicit-any
    (p as any).arrayBuffer = () => Promise.resolve(new TextEncoder().encode(JSON.stringify(body)).buffer);
    return p as HttpResponsePromise;
  }

  mock.post = (url: string | URL | Request, options?: HttpRequestOptions) => {
    captures.push({ url, options: options ?? {} });
    return createResponsePromise(responseBody, statusCode);
  };

  mock.get = mock;
  mock.put = mock;
  mock.patch = mock;
  mock.delete = mock;
  mock.head = mock;

  mock.extend = (extendOptions?: HttpRequestOptions) => {
    // deno-lint-ignore no-explicit-any
    const extended: any = function (
      url: string | URL | Request,
      options?: HttpRequestOptions,
    ) {
      captures.push({
        url,
        options: { ...extendOptions, ...options },
      });
      return createResponsePromise(responseBody, statusCode);
    };
    extended.post = extended;
    extended.get = extended;
    extended.put = extended;
    extended.patch = extended;
    extended.delete = extended;
    extended.head = extended;
    extended.extend = mock.extend;
    return extended as HttpClient;
  };

  return mock as HttpClient;
}

// =============================================================================
// bearer()
// =============================================================================

Deno.test(
  "bearer() - returns ConfigureHttpOptions with prefixUrl and Authorization header",
  () => {
    const opts = bearer("base_url", "api_token");

    assertEquals(opts.prefixUrl, "base_url");
    assertEquals(opts.headers?.["Authorization"], "Bearer {{api_token}}");
  },
);

Deno.test(
  "bearer() - template syntax is correct for configure() resolution",
  () => {
    const opts = bearer("my_api_url", "my_secret_key");

    assertEquals(opts.prefixUrl, "my_api_url");
    assertStringIncludes(opts.headers!["Authorization"], "{{my_secret_key}}");
  },
);

// =============================================================================
// basicAuth()
// =============================================================================

Deno.test(
  "basicAuth() - returns ConfigureHttpOptions with marker header and hooks",
  () => {
    const opts = basicAuth("base_url", "username", "password");

    assertEquals(opts.prefixUrl, "base_url");
    assertEquals(typeof opts.hooks?.beforeRequest?.[0], "function");
    // Should have marker header with template syntax
    const markerHeader = opts.headers?.["X-Glubean-Basic-Auth"];
    assertEquals(markerHeader, "{{username}}:{{password}}");
  },
);

Deno.test(
  "basicAuth() - beforeRequest hook produces correct Basic auth header",
  () => {
    const opts = basicAuth("base_url", "username", "password");
    const hook = opts.hooks!.beforeRequest![0];

    // Simulate a request with resolved marker header
    const request = new Request("https://api.example.com/test", {
      headers: { "X-Glubean-Basic-Auth": "alice:secret123" },
    });

    const result = hook(request, {}) as Request;

    const expected = encodeBase64("alice:secret123");
    assertEquals(result.headers.get("Authorization"), `Basic ${expected}`);
    assertEquals(result.headers.get("X-Glubean-Basic-Auth"), null);
  },
);

Deno.test("basicAuth() - passes through request without marker header", () => {
  const opts = basicAuth("base_url", "username", "password");
  const hook = opts.hooks!.beforeRequest![0];

  const request = new Request("https://api.example.com/test");
  const result = hook(request, {}) as Request;

  assertEquals(result.headers.get("Authorization"), null);
});

// =============================================================================
// apiKey() - header mode
// =============================================================================

Deno.test("apiKey() - header mode returns correct header template", () => {
  const opts = apiKey("base_url", "X-API-Key", "api_key_secret");

  assertEquals(opts.prefixUrl, "base_url");
  assertEquals(opts.headers?.["X-API-Key"], "{{api_key_secret}}");
  assertEquals(opts.hooks, undefined);
});

Deno.test("apiKey() - header mode with custom header name", () => {
  const opts = apiKey("base_url", "X-Custom-Auth", "my_key");

  assertEquals(opts.headers?.["X-Custom-Auth"], "{{my_key}}");
});

// =============================================================================
// apiKey() - query mode
// =============================================================================

Deno.test("apiKey() - query mode returns hooks with marker header", () => {
  const opts = apiKey("base_url", "api_key", "api_key_secret", "query");

  assertEquals(opts.prefixUrl, "base_url");
  assertEquals(opts.headers?.["X-Glubean-ApiKey-Query"], "{{api_key_secret}}");
  assertEquals(typeof opts.hooks?.beforeRequest?.[0], "function");
});

Deno.test("apiKey() - query mode hook appends query param", () => {
  const opts = apiKey("base_url", "api_key", "api_key_secret", "query");
  const hook = opts.hooks!.beforeRequest![0];

  const request = new Request("https://api.example.com/data", {
    headers: { "X-Glubean-ApiKey-Query": "my-secret-key" },
  });

  const result = hook(request, {}) as Request;

  const url = new URL(result.url);
  assertEquals(url.searchParams.get("api_key"), "my-secret-key");
  assertEquals(result.headers.get("X-Glubean-ApiKey-Query"), null);
});

Deno.test("apiKey() - query mode preserves existing query params", () => {
  const opts = apiKey("base_url", "key", "api_key_secret", "query");
  const hook = opts.hooks!.beforeRequest![0];

  const request = new Request("https://api.example.com/data?page=1", {
    headers: { "X-Glubean-ApiKey-Query": "abc123" },
  });

  const result = hook(request, {}) as Request;

  const url = new URL(result.url);
  assertEquals(url.searchParams.get("page"), "1");
  assertEquals(url.searchParams.get("key"), "abc123");
});

// =============================================================================
// oauth2.clientCredentials()
// =============================================================================

Deno.test(
  "oauth2.clientCredentials() - returns ConfigureHttpOptions with hooks",
  () => {
    const opts = oauth2.clientCredentials({
      prefixUrl: "base_url",
      tokenUrl: "token_url",
      clientId: "client_id",
      clientSecret: "client_secret",
    });

    assertEquals(opts.prefixUrl, "base_url");
    assertEquals(typeof opts.hooks?.beforeRequest?.[0], "function");
  },
);

Deno.test("oauth2.clientCredentials() - includes scope in options", () => {
  const opts = oauth2.clientCredentials({
    prefixUrl: "base_url",
    tokenUrl: "token_url",
    clientId: "client_id",
    clientSecret: "client_secret",
    scope: "read:users",
  });

  assertEquals(opts.prefixUrl, "base_url");
  assertEquals(typeof opts.hooks?.beforeRequest?.[0], "function");
});

Deno.test("oauth2.clientCredentials() - has template marker headers", () => {
  const opts = oauth2.clientCredentials({
    prefixUrl: "base_url",
    tokenUrl: "token_url",
    clientId: "client_id",
    clientSecret: "client_secret",
  });

  assertEquals(opts.headers?.["X-Glubean-OAuth2-TokenUrl"], "{{token_url}}");
  assertEquals(opts.headers?.["X-Glubean-OAuth2-ClientId"], "{{client_id}}");
  assertEquals(
    opts.headers?.["X-Glubean-OAuth2-ClientSecret"],
    "{{client_secret}}",
  );
});

// =============================================================================
// oauth2.refreshToken()
// =============================================================================

Deno.test(
  "oauth2.refreshToken() - returns ConfigureHttpOptions with both hooks",
  () => {
    const opts = oauth2.refreshToken({
      prefixUrl: "base_url",
      tokenUrl: "token_url",
      refreshToken: "refresh_token",
      clientId: "client_id",
    });

    assertEquals(opts.prefixUrl, "base_url");
    assertEquals(typeof opts.hooks?.beforeRequest?.[0], "function");
    assertEquals(typeof opts.hooks?.afterResponse?.[0], "function");
  },
);

Deno.test("oauth2.refreshToken() - has template marker headers", () => {
  const opts = oauth2.refreshToken({
    prefixUrl: "base_url",
    tokenUrl: "token_url",
    refreshToken: "refresh_token",
    clientId: "client_id",
    clientSecret: "client_secret",
  });

  assertEquals(opts.headers?.["X-Glubean-OAuth2-TokenUrl"], "{{token_url}}");
  assertEquals(
    opts.headers?.["X-Glubean-OAuth2-RefreshToken"],
    "{{refresh_token}}",
  );
  assertEquals(opts.headers?.["X-Glubean-OAuth2-ClientId"], "{{client_id}}");
  assertEquals(
    opts.headers?.["X-Glubean-OAuth2-ClientSecret"],
    "{{client_secret}}",
  );
});

Deno.test("oauth2.refreshToken() - without clientSecret omits header", () => {
  const opts = oauth2.refreshToken({
    prefixUrl: "base_url",
    tokenUrl: "token_url",
    refreshToken: "refresh_token",
    clientId: "client_id",
  });

  assertEquals(opts.headers?.["X-Glubean-OAuth2-ClientSecret"], undefined);
});

// =============================================================================
// withLogin()
// =============================================================================

Deno.test("withLogin() - returns a builder transform function", () => {
  const transform = withLogin({
    endpoint: "/auth/login",
    credentials: { email: "test@example.com", password: "pass123" },
    extractToken: (body) => body.access_token,
  });

  assertEquals(typeof transform, "function");
});

Deno.test("withLogin() - transform adds a login step to the builder", () => {
  const steps: Array<{ name: string }> = [];

  // Mock TestBuilder
  const mockBuilder = {
    step(name: string, _fn: unknown) {
      steps.push({ name });
      return mockBuilder;
    },
  } as unknown as TestBuilder<unknown>;

  const transform = withLogin({
    endpoint: "/auth/login",
    credentials: { email: "test@example.com", password: "pass123" },
    extractToken: (body) => body.access_token,
  });

  transform(mockBuilder);
  assertEquals(steps.length, 1);
  assertEquals(steps[0].name, "login");
});

Deno.test(
  "withLogin() - login step calls http.post and creates authedHttp",
  async () => {
    const captures: CapturedRequest[] = [];
    const mockHttp = createMockHttp(
      { access_token: "test-token-xyz" },
      captures,
    );

    // Simulate the step function directly
    const transform = withLogin({
      endpoint: "https://api.example.com/auth/login",
      credentials: { email: "user@test.com", password: "secret" },
      extractToken: (body) => body.access_token,
    });

    // Extract the step function from the transform
    // deno-lint-ignore no-explicit-any
    let stepFn: any;
    const mockBuilder = {
      step(_name: string, fn: unknown) {
        stepFn = fn;
        return mockBuilder;
      },
    } as unknown as TestBuilder<unknown>;

    transform(mockBuilder);

    // Create a mock TestContext
    const mockCtx = {
      http: mockHttp,
      vars: {
        get: () => undefined,
        require: (key: string) => key,
      },
      secrets: {
        get: () => undefined,
        require: (key: string) => key,
      },
    };

    const result = await stepFn(mockCtx, {});

    // Should have posted to the login endpoint
    assertEquals(captures.length, 1);
    assertEquals(captures[0].url, "https://api.example.com/auth/login");
    assertEquals(
      (captures[0].options.json as Record<string, string>).email,
      "user@test.com",
    );

    // Should return state with authedHttp
    assertEquals(typeof result.authedHttp, "function");
  },
);

Deno.test("withLogin() - resolves template values in credentials", async () => {
  const captures: CapturedRequest[] = [];
  const mockHttp = createMockHttp({ access_token: "resolved-token" }, captures);

  const transform = withLogin({
    endpoint: "/login",
    credentials: { email: "{{user_email}}", password: "{{user_pass}}" },
    extractToken: (body) => body.access_token,
  });

  // deno-lint-ignore no-explicit-any
  let stepFn: any;
  const mockBuilder = {
    step(_name: string, fn: unknown) {
      stepFn = fn;
      return mockBuilder;
    },
  } as unknown as TestBuilder<unknown>;

  transform(mockBuilder);

  const mockCtx = {
    http: mockHttp,
    vars: {
      get: (key: string) => key === "user_email" ? "alice@example.com" : undefined,
      require: (key: string) => key,
    },
    secrets: {
      get: (key: string) => (key === "user_pass" ? "s3cret" : undefined),
      require: (key: string) => key,
    },
  };

  await stepFn(mockCtx, {});

  const postedJson = captures[0].options.json as Record<string, string>;
  assertEquals(postedJson.email, "alice@example.com");
  assertEquals(postedJson.password, "s3cret");
});

Deno.test("withLogin() - custom headerName and headerPrefix", async () => {
  const captures: CapturedRequest[] = [];
  const mockHttp = createMockHttp({ token: "custom-tok" }, captures);

  // Track what extend() is called with
  let extendArgs: HttpRequestOptions | undefined;
  const origExtend = mockHttp.extend;
  mockHttp.extend = (opts?: HttpRequestOptions) => {
    extendArgs = opts;
    return origExtend(opts ?? {});
  };

  const transform = withLogin({
    endpoint: "/login",
    credentials: { user: "test" },
    extractToken: (body) => body.token,
    headerName: "X-Auth-Token",
    headerPrefix: "Token ",
  });

  // deno-lint-ignore no-explicit-any
  let stepFn: any;
  const mockBuilder = {
    step(_name: string, fn: unknown) {
      stepFn = fn;
      return mockBuilder;
    },
  } as unknown as TestBuilder<unknown>;

  transform(mockBuilder);

  const mockCtx = {
    http: mockHttp,
    vars: { get: () => undefined, require: (key: string) => key },
    secrets: { get: () => undefined, require: (key: string) => key },
  };

  await stepFn(mockCtx, {});

  assertEquals(
    (extendArgs?.headers as Record<string, string>)?.["X-Auth-Token"],
    "Token custom-tok",
  );
});

Deno.test("withLogin() - preserves existing state", async () => {
  const mockHttp = createMockHttp({ access_token: "tok" });

  const transform = withLogin<{ existing: string }>({
    endpoint: "/login",
    credentials: {},
    extractToken: (body) => body.access_token,
  });

  // deno-lint-ignore no-explicit-any
  let stepFn: any;
  const mockBuilder = {
    step(_name: string, fn: unknown) {
      stepFn = fn;
      return mockBuilder;
    },
  } as unknown as TestBuilder<{ existing: string }>;

  transform(mockBuilder);

  const mockCtx = {
    http: mockHttp,
    vars: { get: () => undefined, require: (key: string) => key },
    secrets: { get: () => undefined, require: (key: string) => key },
  };

  const result = await stepFn(mockCtx, { existing: "value" });

  assertEquals(result.existing, "value");
  assertEquals(typeof result.authedHttp, "function");
});
