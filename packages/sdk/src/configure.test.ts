import { test, expect, describe } from "vitest";
import { configure, resolveTemplate } from "./configure.js";
import { session } from "./session.js";
import { defineClientFactory } from "./plugin.js";
import {
  getRuntime as carrierGetRuntime,
  setRuntime as carrierSetRuntime,
  type InternalRuntime,
} from "./runtime-carrier.js";
import type { GlubeanRuntime, HttpClient, HttpRequestOptions } from "./types.js";

// =============================================================================
// Test helpers
// =============================================================================

/**
 * Install a fake runtime into the active carrier.
 * Returns a cleanup function that clears the slot.
 */
function setRuntime(
  vars: Record<string, string> = {},
  secrets: Record<string, string> = {},
  http?: HttpClient,
  test?: { id: string; tags: string[] },
  session?: Record<string, unknown>,
) {
  const runtime: InternalRuntime = {
    vars,
    secrets,
    session: session ?? {},
    http: http ?? createMockHttp(),
    test,
  };
  carrierSetRuntime(runtime);
  return () => {
    carrierSetRuntime(undefined);
  };
}

/**
 * Remove the installed runtime (simulate scan-time / no harness).
 */
function clearRuntime() {
  carrierSetRuntime(undefined);
}

/**
 * Create a minimal mock HttpClient that records extend() calls.
 */
function createMockHttp(
  extendCalls: { options: HttpRequestOptions }[] = [],
): HttpClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mock: any = function () {
    return Promise.resolve(new Response("mock"));
  };
  mock.get = mock;
  mock.post = mock;
  mock.put = mock;
  mock.patch = mock;
  mock.delete = mock;
  mock.head = mock;
  mock.extend = (options: HttpRequestOptions): HttpClient => {
    extendCalls.push({ options });
    // Return another mock that also records extends
    return createMockHttp(extendCalls);
  };
  return mock as HttpClient;
}

// =============================================================================
// configure() - basic structure
// =============================================================================

test("configure() - returns vars, secrets, http", () => {
  const result = configure({});
  expect(typeof result.vars).toBe("object");
  expect(typeof result.secrets).toBe("object");
  expect(typeof result.http).toBe("function"); // callable
});

test("configure() - can be called without options", () => {
  const result = configure({});
  expect(Object.keys(result.vars).length).toBe(0);
  expect(Object.keys(result.secrets).length).toBe(0);
});

// =============================================================================
// Lazy vars
// =============================================================================

test("vars - {{key}} resolves from runtime vars", () => {
  const cleanup = setRuntime({ base_url: "https://api.example.com" });
  try {
    const { vars } = configure({ vars: { baseUrl: "{{base_url}}" } });
    expect(vars.baseUrl).toBe("https://api.example.com");
  } finally {
    cleanup();
  }
});

test("vars - literal value (no {{}}) returned as-is", () => {
  const cleanup = setRuntime({});
  try {
    const { vars } = configure({ vars: { baseUrl: "https://api.example.com" } });
    expect(vars.baseUrl).toBe("https://api.example.com");
  } finally {
    cleanup();
  }
});

test("vars - multiple properties with mixed literal and {{ref}}", () => {
  const cleanup = setRuntime({
    base_url: "https://api.example.com",
  });
  try {
    const { vars } = configure({
      vars: { baseUrl: "{{base_url}}", orgId: "org-123" },
    });
    expect(vars.baseUrl).toBe("https://api.example.com");
    expect(vars.orgId).toBe("org-123");
  } finally {
    cleanup();
  }
});

test("vars - throws on missing {{ref}}", () => {
  const cleanup = setRuntime({ other_var: "value" });
  try {
    const { vars } = configure({ vars: { baseUrl: "{{base_url}}" } });
    expect(
      () => vars.baseUrl,
    ).toThrow('Missing value for template placeholder "{{base_url}}"');
  } finally {
    cleanup();
  }
});

test("vars - throws when accessed without runtime (scan time)", () => {
  clearRuntime();
  const { vars } = configure({ vars: { baseUrl: "{{base_url}}" } });
  expect(
    () => vars.baseUrl,
  ).toThrow("configure() values can only be accessed during test execution");
});

test("vars - properties are enumerable", () => {
  const cleanup = setRuntime({ base_url: "https://example.com" });
  try {
    const { vars } = configure({
      vars: { baseUrl: "{{base_url}}", orgId: "org-456" },
    });
    const keys = Object.keys(vars);
    expect(keys.sort()).toEqual(["baseUrl", "orgId"]);
  } finally {
    cleanup();
  }
});

test("vars - re-reads from runtime on each access (not cached)", () => {
  const cleanup = setRuntime({ base_url: "https://v1.example.com" });
  try {
    const { vars } = configure({ vars: { baseUrl: "{{base_url}}" } });
    expect(vars.baseUrl).toBe("https://v1.example.com");

    // Simulate a new test execution with different vars by mutating the
    // installed runtime in place — `vars.baseUrl` is a lazy accessor that
    // re-reads the current runtime's vars on each access.
    const runtime = carrierGetRuntime();
    if (runtime) runtime.vars.base_url = "https://v2.example.com";
    expect(vars.baseUrl).toBe("https://v2.example.com");
  } finally {
    cleanup();
  }
});

// =============================================================================
// Lazy secrets
// =============================================================================

test("secrets - {{key}} resolves from runtime secrets", () => {
  const cleanup = setRuntime({}, { api_key: "sk-test-123" });
  try {
    const { secrets } = configure({ secrets: { apiKey: "{{api_key}}" } });
    expect(secrets.apiKey).toBe("sk-test-123");
  } finally {
    cleanup();
  }
});

test("secrets - literal value returned as-is", () => {
  const cleanup = setRuntime({}, {});
  try {
    const { secrets } = configure({ secrets: { apiKey: "sk-hardcoded-456" } });
    expect(secrets.apiKey).toBe("sk-hardcoded-456");
  } finally {
    cleanup();
  }
});

test("secrets - throws on missing {{ref}}", () => {
  const cleanup = setRuntime({}, {});
  try {
    const { secrets } = configure({ secrets: { apiKey: "{{api_key}}" } });
    expect(
      () => secrets.apiKey,
    ).toThrow('Missing value for template placeholder "{{api_key}}"');
  } finally {
    cleanup();
  }
});

test("secrets - throws when accessed without runtime", () => {
  clearRuntime();
  const { secrets } = configure({ secrets: { apiKey: "{{api_key}}" } });
  expect(
    () => secrets.apiKey,
  ).toThrow("configure() values can only be accessed during test execution");
});

// =============================================================================
// HTTP client - passthrough (no http config)
// =============================================================================

test("http - passthrough delegates to runtime http", () => {
  let getCalled = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockHttp: any = function () {
    return Promise.resolve(new Response("direct"));
  };
  mockHttp.get = () => {
    getCalled = true;
    return Promise.resolve(new Response("get"));
  };
  mockHttp.post = mockHttp;
  mockHttp.put = mockHttp;
  mockHttp.patch = mockHttp;
  mockHttp.delete = mockHttp;
  mockHttp.head = mockHttp;
  mockHttp.extend = () => mockHttp;

  const cleanup = setRuntime({}, {}, mockHttp as HttpClient);
  try {
    const { http } = configure({});
    http.get("https://example.com");
    expect(getCalled).toBe(true);
  } finally {
    cleanup();
  }
});

test("http - passthrough throws without runtime", () => {
  clearRuntime();
  const { http } = configure({});
  expect(
    () => http.get("https://example.com"),
  ).toThrow("configure() values can only be accessed during test execution");
});

// =============================================================================
// HTTP client - with http config
// =============================================================================

test("http - extends runtime http with prefixUrl from var", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    { base_url: "https://api.example.com" },
    {},
    mockHttp,
  );
  try {
    const { http } = configure({
      http: { prefixUrl: "{{base_url}}" },
    });
    // Trigger lazy resolution
    http.get("users");
    expect(extendCalls.length).toBe(1);
    expect(extendCalls[0].options.prefixUrl).toBe("https://api.example.com");
  } finally {
    cleanup();
  }
});

test("http - resolves {{key}} templates in headers from secrets", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    { base_url: "https://api.example.com" },
    { api_key: "sk-test-456" },
    mockHttp,
  );
  try {
    const { http } = configure({
      http: {
        prefixUrl: "{{base_url}}",
        headers: { Authorization: "Bearer {{api_key}}" },
      },
    });
    http.get("users");
    expect(extendCalls.length).toBe(1);
    const headers = extendCalls[0].options.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test-456");
  } finally {
    cleanup();
  }
});

test("http - resolves {{key}} templates from vars when not in secrets", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    { org_id: "org-789" },
    {},
    mockHttp,
  );
  try {
    const { http } = configure({
      http: {
        headers: { "X-Org-Id": "{{org_id}}" },
      },
    });
    http.get("https://example.com");
    const headers = extendCalls[0].options.headers as Record<string, string>;
    expect(headers["X-Org-Id"]).toBe("org-789");
  } finally {
    cleanup();
  }
});

test("http - secrets take precedence over vars in templates", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    { token: "var-token" },
    { token: "secret-token" },
    mockHttp,
  );
  try {
    const { http } = configure({
      http: {
        headers: { Authorization: "Bearer {{token}}" },
      },
    });
    http.get("https://example.com");
    const headers = extendCalls[0].options.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-token");
  } finally {
    cleanup();
  }
});

// =============================================================================
// Session-based template resolution
// =============================================================================

test("http - resolves {{key}} from session values", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    {},
    {},
    mockHttp,
    undefined,
    { AUTH_TOKEN: "session-jwt-123" },
  );
  try {
    const { http } = configure({
      http: {
        headers: { Authorization: "Bearer {{AUTH_TOKEN}}" },
      },
    });
    http.get("https://example.com");
    const headers = extendCalls[0].options.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer session-jwt-123");
  } finally {
    cleanup();
  }
});

test("http - session takes precedence over secrets and vars", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    { token: "var-token" },
    { token: "secret-token" },
    mockHttp,
    undefined,
    { token: "session-token" },
  );
  try {
    const { http } = configure({
      http: {
        headers: { Authorization: "Bearer {{token}}" },
      },
    });
    http.get("https://example.com");
    const headers = extendCalls[0].options.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer session-token");
  } finally {
    cleanup();
  }
});

test("http - session falls through to secrets when key not in session", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    {},
    { token: "secret-token" },
    mockHttp,
    undefined,
    { OTHER_KEY: "other-value" },
  );
  try {
    const { http } = configure({
      http: {
        headers: { Authorization: "Bearer {{token}}" },
      },
    });
    http.get("https://example.com");
    const headers = extendCalls[0].options.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-token");
  } finally {
    cleanup();
  }
});

test("http - non-string session values are skipped in template resolution", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    {},
    { token: "secret-token" },
    mockHttp,
    undefined,
    { token: 12345 },  // number, not string — should be skipped
  );
  try {
    const { http } = configure({
      http: {
        headers: { Authorization: "Bearer {{token}}" },
      },
    });
    http.get("https://example.com");
    const headers = extendCalls[0].options.headers as Record<string, string>;
    // Non-string session value skipped, falls through to secret
    expect(headers.Authorization).toBe("Bearer secret-token");
  } finally {
    cleanup();
  }
});

test("http - session resolves in prefixUrl template", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    {},
    {},
    mockHttp,
    undefined,
    { BASE_URL: "https://api.example.com" },
  );
  try {
    const { http } = configure({
      http: { prefixUrl: "{{BASE_URL}}" },
    });
    http.get("users");
    expect(extendCalls[0].options.prefixUrl).toBe("https://api.example.com");
  } finally {
    cleanup();
  }
});

test("http - session resolves in searchParams template", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    {},
    {},
    mockHttp,
    undefined,
    { API_KEY: "session-key-456" },
  );
  try {
    const { http } = configure({
      http: { searchParams: { apiKey: "{{API_KEY}}" } },
    });
    http.get("https://example.com");
    const params = extendCalls[0].options.searchParams as Record<string, string>;
    expect(params.apiKey).toBe("session-key-456");
  } finally {
    cleanup();
  }
});

test("http - empty session does not break existing resolution", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    { base_url: "https://api.test.com" },
    { api_key: "sk-test-789" },
    mockHttp,
    undefined,
    {},  // empty session
  );
  try {
    const { http } = configure({
      http: {
        prefixUrl: "{{base_url}}",
        headers: { Authorization: "Bearer {{api_key}}" },
      },
    });
    http.get("users");
    expect(extendCalls[0].options.prefixUrl).toBe("https://api.test.com");
    const headers = extendCalls[0].options.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test-789");
  } finally {
    cleanup();
  }
});

test("http - throws on missing template placeholder", () => {
  const mockHttp = createMockHttp();
  const cleanup = setRuntime({}, {}, mockHttp);
  try {
    const { http } = configure({
      http: {
        headers: { Authorization: "Bearer {{missing_key}}" },
      },
    });
    expect(
      () => http.get("https://example.com"),
    ).toThrow('Missing value for template placeholder "{{missing_key}}"');
  } finally {
    cleanup();
  }
});

test("http - throws on missing prefixUrl var", () => {
  const mockHttp = createMockHttp();
  const cleanup = setRuntime({}, {}, mockHttp);
  try {
    const { http } = configure({
      http: { prefixUrl: "{{base_url}}" },
    });
    expect(
      () => http.get("users"),
    ).toThrow('Missing value for template placeholder "{{base_url}}"');
  } finally {
    cleanup();
  }
});

test("http - passes through timeout option", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime({}, {}, mockHttp);
  try {
    const { http } = configure({
      http: { timeout: 5000 },
    });
    http.get("https://example.com");
    expect(extendCalls[0].options.timeout).toBe(5000);
  } finally {
    cleanup();
  }
});

test("http - passes through retry option", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime({}, {}, mockHttp);
  try {
    const { http } = configure({
      http: { retry: 3 },
    });
    http.get("https://example.com");
    expect(extendCalls[0].options.retry).toBe(3);
  } finally {
    cleanup();
  }
});

test("http - passes through throwHttpErrors option", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime({}, {}, mockHttp);
  try {
    const { http } = configure({
      http: { throwHttpErrors: false },
    });
    http.get("https://example.com");
    expect(extendCalls[0].options.throwHttpErrors).toBe(false);
  } finally {
    cleanup();
  }
});

test("http - passes through redirect option", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime({}, {}, mockHttp);
  try {
    const { http } = configure({
      http: { redirect: "manual" },
    });
    http.get("https://example.com");
    expect((extendCalls[0].options as any).redirect).toBe("manual");
  } finally {
    cleanup();
  }
});

test("http - caches extended client (extend called once per runtime)", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    { base_url: "https://api.example.com" },
    {},
    mockHttp,
  );
  try {
    const { http } = configure({
      http: { prefixUrl: "{{base_url}}" },
    });
    // Multiple calls should only trigger one extend()
    http.get("users");
    http.post("users");
    http.get("orders");
    expect(extendCalls.length).toBe(1);
  } finally {
    cleanup();
  }
});

test("http - extend() on configured client delegates to resolved client", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    { base_url: "https://api.example.com" },
    {},
    mockHttp,
  );
  try {
    const { http } = configure({
      http: { prefixUrl: "{{base_url}}" },
    });
    // First extend creates the base configured client
    // Then .extend() on that creates a child
    const adminHttp = http.extend({
      headers: { "X-Admin": "true" },
    });
    expect(typeof adminHttp).toBe("function"); // is callable
    expect(extendCalls.length).toBe(2); // 1 from configure, 1 from .extend()
  } finally {
    cleanup();
  }
});

// =============================================================================
// HTTP client - all methods exist
// =============================================================================

test("http - all HTTP methods are proxied", () => {
  const cleanup = setRuntime({}, {});
  try {
    const { http } = configure({});
    const methods = ["get", "post", "put", "patch", "delete", "head"] as const;
    for (const method of methods) {
      expect(typeof http[method]).toBe("function");
    }
    expect(typeof http.extend).toBe("function");
  } finally {
    cleanup();
  }
});

// =============================================================================
// Combined vars + secrets + http
// =============================================================================

test("full configure - vars, secrets, and http work together", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    { base_url: "https://api.example.com", org_id: "org-42" },
    { api_key: "sk-live-abc" },
    mockHttp,
  );
  try {
    const { vars, secrets, http } = configure({
      vars: { baseUrl: "{{base_url}}", orgId: "{{org_id}}" },
      secrets: { apiKey: "{{api_key}}" },
      http: {
        prefixUrl: "{{base_url}}",
        headers: {
          Authorization: "Bearer {{api_key}}",
          "X-Org-Id": "{{org_id}}",
        },
      },
    });

    // Vars
    expect(vars.baseUrl).toBe("https://api.example.com");
    expect(vars.orgId).toBe("org-42");

    // Secrets
    expect(secrets.apiKey).toBe("sk-live-abc");

    // HTTP
    http.get("users");
    expect(extendCalls.length).toBe(1);
    expect(extendCalls[0].options.prefixUrl).toBe("https://api.example.com");
    const headers = extendCalls[0].options.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-live-abc");
    expect(headers["X-Org-Id"]).toBe("org-42");
  } finally {
    cleanup();
  }
});

// =============================================================================
// Safe at module load time (scan-time safety)
// =============================================================================

test("configure() itself does not throw without runtime", () => {
  clearRuntime();
  // configure() should succeed — only accessing the returned values should throw
  const result = configure({
    vars: { baseUrl: "{{base_url}}" },
    secrets: { apiKey: "{{api_key}}" },
    http: { prefixUrl: "{{base_url}}" },
  });
  expect(typeof result.vars).toBe("object");
  expect(typeof result.secrets).toBe("object");
  expect(typeof result.http).toBe("function");
});

// =============================================================================
// Multiple configure() calls are independent
// =============================================================================

test("multiple configure calls are independent", () => {
  const cleanup = setRuntime(
    { base_url: "https://api.example.com", debug: "true" },
    { api_key: "sk-123" },
  );
  try {
    const config1 = configure({
      vars: { baseUrl: "{{base_url}}" },
    });
    const config2 = configure({
      vars: { debug: "{{debug}}" },
      secrets: { apiKey: "{{api_key}}" },
    });

    expect(config1.vars.baseUrl).toBe("https://api.example.com");
    expect(config2.vars.debug).toBe("true");
    expect(config2.secrets.apiKey).toBe("sk-123");

    // config1 doesn't have debug
    expect(Object.keys(config1.vars)).toEqual(["baseUrl"]);
    // config2 doesn't have baseUrl
    expect(Object.keys(config2.vars)).toEqual(["debug"]);
  } finally {
    cleanup();
  }
});

// =============================================================================
// Header template edge cases
// =============================================================================

test("http - header with multiple template placeholders", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    { user: "admin" },
    { pass: "secret123" },
    mockHttp,
  );
  try {
    const { http } = configure({
      http: {
        headers: { Authorization: "Basic {{user}}:{{pass}}" },
      },
    });
    http.get("https://example.com");
    const headers = extendCalls[0].options.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Basic admin:secret123");
  } finally {
    cleanup();
  }
});

test("http - header without template placeholders passed as-is", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime({}, {}, mockHttp);
  try {
    const { http } = configure({
      http: {
        headers: { "Content-Type": "application/json" },
      },
    });
    http.get("https://example.com");
    const headers = extendCalls[0].options.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  } finally {
    cleanup();
  }
});

test("http - searchParams with {{KEY}} template resolution", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    {},
    { API_KEY: "secret-key-123" },
    mockHttp,
  );
  try {
    const { http } = configure({
      http: {
        searchParams: { key: "{{API_KEY}}", format: "json" },
      },
    });
    http.get("https://example.com");
    const params = extendCalls[0].options.searchParams as Record<string, string>;
    expect(params.key).toBe("secret-key-123");
    expect(params.format).toBe("json");
  } finally {
    cleanup();
  }
});

test("http - resolves hyphenated {{X-API-KEY}} template placeholders", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    {},
    { "X-API-KEY": "key-abc-123", "AWS-REGION": "us-east-1" },
    mockHttp,
  );
  try {
    const { http } = configure({
      http: {
        headers: {
          "X-Api-Key": "{{X-API-KEY}}",
          "X-Region": "{{AWS-REGION}}",
        },
      },
    });
    http.get("https://example.com");
    const headers = extendCalls[0].options.headers as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("key-abc-123");
    expect(headers["X-Region"]).toBe("us-east-1");
  } finally {
    cleanup();
  }
});

// =============================================================================
// HTTP hooks passthrough
// =============================================================================

test("http - hooks are passed to extend() options", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime({}, {}, mockHttp);
  try {
    const beforeRequest = (_request: Request, _options: HttpRequestOptions) => {};
    const afterResponse = (_request: Request, _options: HttpRequestOptions, _response: Response) => {};

    const { http } = configure({
      http: {
        hooks: {
          beforeRequest: [beforeRequest],
          afterResponse: [afterResponse],
        },
      },
    });
    http.get("https://example.com");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hooks = (extendCalls[0].options as any).hooks;
    expect(hooks.beforeRequest.length).toBe(1);
    expect(hooks.afterResponse.length).toBe(1);
    expect(hooks.beforeRequest[0]).toBe(beforeRequest);
    expect(hooks.afterResponse[0]).toBe(afterResponse);
  } finally {
    cleanup();
  }
});

test("http - hooks combined with other options", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    { base_url: "https://api.example.com" },
    { api_key: "sk-123" },
    mockHttp,
  );
  try {
    const hook = (_request: Request, _options: HttpRequestOptions) => {};
    const { http } = configure({
      http: {
        prefixUrl: "{{base_url}}",
        headers: { Authorization: "Bearer {{api_key}}" },
        hooks: { beforeRequest: [hook] },
      },
    });
    http.get("users");

    expect(extendCalls[0].options.prefixUrl).toBe("https://api.example.com");
    const headers = extendCalls[0].options.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-123");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hooks = (extendCalls[0].options as any).hooks;
    expect(hooks.beforeRequest[0]).toBe(hook);
  } finally {
    cleanup();
  }
});

// =============================================================================
// buildLazyPlugins
// =============================================================================

test("plugins - create() called lazily on first property access", () => {
  let createCalled = false;
  const cleanup = setRuntime({ key: "value" }, {});
  try {
    const result = configure({
      plugins: {
        myPlugin: defineClientFactory((_runtime) => {
          createCalled = true;
          return { greeting: "hello" };
        }),
      },
    });

    expect(createCalled).toBe(false);

    // Access the plugin — triggers lazy creation
    expect(result.myPlugin.greeting).toBe("hello");
    expect(createCalled).toBe(true);
  } finally {
    cleanup();
  }
});

test("plugins - result is cached (second access does not call create again)", () => {
  let createCount = 0;
  const cleanup = setRuntime({}, {});
  try {
    const result = configure({
      plugins: {
        counter: defineClientFactory((_runtime) => {
          createCount++;
          return { count: createCount };
        }),
      },
    });

    expect(result.counter.count).toBe(1);
    expect(result.counter.count).toBe(1);
    expect(createCount).toBe(1);
  } finally {
    cleanup();
  }
});

test("plugins - multiple plugins resolve independently", () => {
  let aCreated = false;
  let bCreated = false;
  const cleanup = setRuntime({}, {});
  try {
    const result = configure({
      plugins: {
        a: defineClientFactory((_runtime) => {
          aCreated = true;
          return { name: "pluginA" };
        }),
        b: defineClientFactory((_runtime) => {
          bCreated = true;
          return { name: "pluginB" };
        }),
      },
    });

    // Access only plugin a
    expect(result.a.name).toBe("pluginA");
    expect(aCreated).toBe(true);
    expect(bCreated).toBe(false);

    // Now access plugin b
    expect(result.b.name).toBe("pluginB");
    expect(bCreated).toBe(true);
  } finally {
    cleanup();
  }
});

test("plugins - factory receives augmented GlubeanRuntime with requireVar", () => {
  let capturedRuntime: GlubeanRuntime | undefined;
  const cleanup = setRuntime({ base_url: "https://api.example.com" }, {});
  try {
    const result = configure({
      plugins: {
        test: defineClientFactory((runtime) => {
          capturedRuntime = runtime;
          return { url: runtime.requireVar("base_url") };
        }),
      },
    });

    expect(result.test.url).toBe("https://api.example.com");
    expect(capturedRuntime!.requireVar("base_url")).toBe("https://api.example.com");
  } finally {
    cleanup();
  }
});

test("plugins - factory receives augmented GlubeanRuntime with requireSecret", () => {
  let capturedRuntime: GlubeanRuntime | undefined;
  const cleanup = setRuntime({}, { api_key: "sk-secret" });
  try {
    const result = configure({
      plugins: {
        test: defineClientFactory((runtime) => {
          capturedRuntime = runtime;
          return { key: runtime.requireSecret("api_key") };
        }),
      },
    });

    expect(result.test.key).toBe("sk-secret");
    expect(capturedRuntime!.requireSecret("api_key")).toBe("sk-secret");
  } finally {
    cleanup();
  }
});

test("plugins - factory receives augmented GlubeanRuntime with resolveTemplate", () => {
  const cleanup = setRuntime(
    { base_url: "https://api.example.com" },
    { api_key: "sk-secret" },
  );
  try {
    const result = configure({
      plugins: {
        test: defineClientFactory((runtime) => {
          return {
            header: runtime.resolveTemplate("Bearer {{api_key}}"),
            mixed: runtime.resolveTemplate("{{base_url}}/api?key={{api_key}}"),
          };
        }),
      },
    });

    expect(result.test.header).toBe("Bearer sk-secret");
    expect(result.test.mixed).toBe("https://api.example.com/api?key=sk-secret");
  } finally {
    cleanup();
  }
});

test("plugins - safe to destructure without runtime", () => {
  clearRuntime();
  const result = configure({
    plugins: {
      test: defineClientFactory((_runtime) => ({ value: 42 })),
    },
  });

  // Destructuring should not throw — the value is a lazy Proxy
  const { test: plugin } = result;
  expect(typeof plugin).toBe("object");

  // Actually *using* the plugin should throw without runtime
  expect(
    () => plugin.value,
  ).toThrow("configure() values can only be accessed during test execution");
});

// =============================================================================
// configure({ plugins }) integration
// =============================================================================

test("configure({ plugins }) - returns plugin instances alongside vars/secrets/http", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    { base_url: "https://api.example.com" },
    { api_key: "sk-123" },
    mockHttp,
  );
  try {
    const result = configure({
      vars: { baseUrl: "{{base_url}}" },
      secrets: { apiKey: "{{api_key}}" },
      http: { prefixUrl: "{{base_url}}" },
      plugins: {
        myClient: defineClientFactory((runtime) => ({
          endpoint: runtime.requireVar("base_url"),
          token: runtime.requireSecret("api_key"),
        })),
      },
    });

    // Core configure() values still work
    expect(result.vars.baseUrl).toBe("https://api.example.com");
    expect(result.secrets.apiKey).toBe("sk-123");

    // Plugin is available
    expect(result.myClient.endpoint).toBe("https://api.example.com");
    expect(result.myClient.token).toBe("sk-123");

    // HTTP still works
    result.http.get("users");
    expect(extendCalls.length).toBe(1);
  } finally {
    cleanup();
  }
});

test("configure({ plugins }) - TypeScript generic inference (verified by assignment)", () => {
  const cleanup = setRuntime({}, {});
  try {
    const result = configure({
      plugins: {
        alpha: defineClientFactory((_r) => ({ x: 1, y: "hello" })),
        beta: defineClientFactory((_r) => ({ items: ["a", "b", "c"] })),
      },
    });

    // TypeScript infers these types correctly.
    // If inference is wrong, these assignments would be compile errors.
    const x: number = result.alpha.x;
    const y: string = result.alpha.y;
    const items: string[] = result.beta.items;
    expect(x).toBe(1);
    expect(y).toBe("hello");
    expect(items).toEqual(["a", "b", "c"]);
  } finally {
    cleanup();
  }
});

test("configure() without plugins - works as before", () => {
  const cleanup = setRuntime({ base_url: "https://api.example.com" }, {});
  try {
    const result = configure({
      vars: { baseUrl: "{{base_url}}" },
    });
    expect(result.vars.baseUrl).toBe("https://api.example.com");
  } finally {
    cleanup();
  }
});

// =============================================================================
// Plugin reserved key guard
// =============================================================================

test("plugins - throws on reserved key 'vars'", () => {
  expect(
    () =>
      configure({
        // @ts-expect-error: "vars" is a reserved key — rejected at type level
        plugins: { vars: defineClientFactory((_r) => ({ x: 1 })) },
      }),
  ).toThrow('Plugin name "vars" conflicts with a reserved configure() field');
});

test("plugins - throws on reserved key 'secrets'", () => {
  expect(
    () =>
      configure({
        // @ts-expect-error: "secrets" is a reserved key — rejected at type level
        plugins: { secrets: defineClientFactory((_r) => ({ x: 1 })) },
      }),
  ).toThrow('Plugin name "secrets" conflicts with a reserved configure() field');
});

test("plugins - throws on reserved key 'http'", () => {
  expect(
    () =>
      configure({
        // @ts-expect-error: "http" is a reserved key — rejected at type level
        plugins: { http: defineClientFactory((_r) => ({ x: 1 })) },
      }),
  ).toThrow('Plugin name "http" conflicts with a reserved configure() field');
});

// =============================================================================
// resolveTemplate() — direct unit tests (session priority)
// =============================================================================

describe("resolveTemplate", () => {
  test("session value takes highest priority", () => {
    const result = resolveTemplate(
      "Bearer {{token}}",
      { token: "var-val" },
      { token: "secret-val" },
      { token: "session-val" },
    );
    expect(result).toBe("Bearer session-val");
  });

  test("falls through to secrets when session has no match", () => {
    const result = resolveTemplate(
      "Bearer {{token}}",
      { token: "var-val" },
      { token: "secret-val" },
      { other: "session-val" },
    );
    expect(result).toBe("Bearer secret-val");
  });

  test("falls through to vars when session and secrets have no match", () => {
    const result = resolveTemplate(
      "{{base_url}}/api",
      { base_url: "https://api.test.com" },
      {},
      {},
    );
    expect(result).toBe("https://api.test.com/api");
  });

  test("works without session parameter (backward compat)", () => {
    const result = resolveTemplate(
      "Bearer {{token}}",
      {},
      { token: "secret-val" },
    );
    expect(result).toBe("Bearer secret-val");
  });

  test("non-string session values are skipped", () => {
    const result = resolveTemplate(
      "Bearer {{token}}",
      {},
      { token: "secret-val" },
      { token: 42 },
    );
    expect(result).toBe("Bearer secret-val");
  });

  test("null session value falls through", () => {
    const result = resolveTemplate(
      "Bearer {{token}}",
      {},
      { token: "secret-val" },
      { token: null },
    );
    expect(result).toBe("Bearer secret-val");
  });

  test("multiple placeholders with mixed sources", () => {
    const result = resolveTemplate(
      "{{base}}/api?key={{key}}&session={{sid}}",
      { base: "https://api.com" },
      { key: "sk-123" },
      { sid: "sess-456" },
    );
    expect(result).toBe("https://api.com/api?key=sk-123&session=sess-456");
  });

  test("throws on missing placeholder even with session", () => {
    expect(() =>
      resolveTemplate(
        "Bearer {{missing}}",
        {},
        {},
        { other: "value" },
      ),
    ).toThrow('Missing value for template placeholder "{{missing}}"');
  });
});

// =============================================================================
// Global session accessor
// =============================================================================

describe("session (global accessor)", () => {
  test("get returns session value when runtime is set", () => {
    const cleanup = setRuntime({}, {}, undefined, undefined, { token: "abc" });
    try {
      expect(session.get("token")).toBe("abc");
    } finally {
      cleanup();
    }
  });

  test("get returns undefined for missing key", () => {
    const cleanup = setRuntime({}, {}, undefined, undefined, { other: "val" });
    try {
      expect(session.get("token")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("require returns session value", () => {
    const cleanup = setRuntime({}, {}, undefined, undefined, { token: "abc" });
    try {
      expect(session.require("token")).toBe("abc");
    } finally {
      cleanup();
    }
  });

  test("require throws on missing key", () => {
    const cleanup = setRuntime({}, {}, undefined, undefined, {});
    try {
      expect(() => session.require("missing")).toThrow('Missing required session key: "missing"');
    } finally {
      cleanup();
    }
  });

  test("has returns true/false", () => {
    const cleanup = setRuntime({}, {}, undefined, undefined, { a: 1 });
    try {
      expect(session.has("a")).toBe(true);
      expect(session.has("b")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("entries returns snapshot", () => {
    const cleanup = setRuntime({}, {}, undefined, undefined, { x: "1", y: "2" });
    try {
      expect(session.entries()).toEqual({ x: "1", y: "2" });
    } finally {
      cleanup();
    }
  });

  test("set writes value readable by get", () => {
    const cleanup = setRuntime({}, {}, undefined, undefined, {});
    try {
      session.set("dynamic", "new-value");
      expect(session.get("dynamic")).toBe("new-value");
    } finally {
      cleanup();
    }
  });

  test("set overwrites existing value", () => {
    const cleanup = setRuntime({}, {}, undefined, undefined, { token: "old" });
    try {
      expect(session.get("token")).toBe("old");
      session.set("token", "new");
      expect(session.get("token")).toBe("new");
    } finally {
      cleanup();
    }
  });

  test("set value is readable by {{KEY}} template resolution", () => {
    const extendCalls: { options: HttpRequestOptions }[] = [];
    const mockHttp = createMockHttp(extendCalls);
    const cleanup = setRuntime({}, {}, mockHttp, undefined, {});
    try {
      session.set("AUTH_TOKEN", "dynamic-jwt");
      const { http } = configure({
        http: { headers: { Authorization: "Bearer {{AUTH_TOKEN}}" } },
      });
      http.get("https://example.com");
      const headers = extendCalls[0].options.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer dynamic-jwt");
    } finally {
      cleanup();
    }
  });

  test("throws when accessed outside runtime", () => {
    clearRuntime();
    expect(() => session.get("token")).toThrow("session can only be accessed during test execution");
  });
});
