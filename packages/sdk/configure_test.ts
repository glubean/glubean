import {
  assertEquals,
  assertThrows,
} from "@std/assert";
import { configure } from "./configure.ts";
import type { HttpClient, HttpRequestOptions } from "./types.ts";

// =============================================================================
// Test helpers
// =============================================================================

/**
 * Set up a fake runtime on the global slot.
 * Returns a cleanup function to remove it.
 */
function setRuntime(
  vars: Record<string, string> = {},
  secrets: Record<string, string> = {},
  http?: HttpClient,
) {
  // deno-lint-ignore no-explicit-any
  (globalThis as any).__glubeanRuntime = {
    vars,
    secrets,
    http: http ?? createMockHttp(),
  };
  return () => {
    // deno-lint-ignore no-explicit-any
    delete (globalThis as any).__glubeanRuntime;
  };
}

/**
 * Remove the runtime slot (simulate scan-time / no harness).
 */
function clearRuntime() {
  // deno-lint-ignore no-explicit-any
  delete (globalThis as any).__glubeanRuntime;
}

/**
 * Create a minimal mock HttpClient that records extend() calls.
 */
function createMockHttp(
  extendCalls: { options: HttpRequestOptions }[] = [],
): HttpClient {
  // deno-lint-ignore no-explicit-any
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

Deno.test("configure() - returns vars, secrets, http", () => {
  const result = configure({});
  assertEquals(typeof result.vars, "object");
  assertEquals(typeof result.secrets, "object");
  assertEquals(typeof result.http, "function"); // callable
});

Deno.test("configure() - can be called without options", () => {
  const result = configure({});
  assertEquals(Object.keys(result.vars).length, 0);
  assertEquals(Object.keys(result.secrets).length, 0);
});

// =============================================================================
// Lazy vars
// =============================================================================

Deno.test("vars - lazy getter reads from runtime slot", () => {
  const cleanup = setRuntime({ base_url: "https://api.example.com" });
  try {
    const { vars } = configure({ vars: { baseUrl: "base_url" } });
    assertEquals(vars.baseUrl, "https://api.example.com");
  } finally {
    cleanup();
  }
});

Deno.test("vars - multiple properties", () => {
  const cleanup = setRuntime({
    base_url: "https://api.example.com",
    org_id: "org-123",
  });
  try {
    const { vars } = configure({
      vars: { baseUrl: "base_url", orgId: "org_id" },
    });
    assertEquals(vars.baseUrl, "https://api.example.com");
    assertEquals(vars.orgId, "org-123");
  } finally {
    cleanup();
  }
});

Deno.test("vars - throws on missing var", () => {
  const cleanup = setRuntime({ other_var: "value" });
  try {
    const { vars } = configure({ vars: { baseUrl: "base_url" } });
    assertThrows(
      () => vars.baseUrl,
      Error,
      "Missing required var: base_url",
    );
  } finally {
    cleanup();
  }
});

Deno.test("vars - throws on empty string var", () => {
  const cleanup = setRuntime({ base_url: "" });
  try {
    const { vars } = configure({ vars: { baseUrl: "base_url" } });
    assertThrows(
      () => vars.baseUrl,
      Error,
      "Missing required var: base_url",
    );
  } finally {
    cleanup();
  }
});

Deno.test("vars - throws when accessed without runtime (scan time)", () => {
  clearRuntime();
  const { vars } = configure({ vars: { baseUrl: "base_url" } });
  assertThrows(
    () => vars.baseUrl,
    Error,
    "configure() values can only be accessed during test execution",
  );
});

Deno.test("vars - properties are enumerable", () => {
  const cleanup = setRuntime({ base_url: "https://example.com" });
  try {
    const { vars } = configure({
      vars: { baseUrl: "base_url", orgId: "org_id" },
    });
    const keys = Object.keys(vars);
    assertEquals(keys.sort(), ["baseUrl", "orgId"]);
  } finally {
    cleanup();
  }
});

Deno.test("vars - re-reads from runtime on each access (not cached)", () => {
  const cleanup = setRuntime({ base_url: "https://v1.example.com" });
  try {
    const { vars } = configure({ vars: { baseUrl: "base_url" } });
    assertEquals(vars.baseUrl, "https://v1.example.com");

    // Simulate a new test execution with different vars
    // deno-lint-ignore no-explicit-any
    (globalThis as any).__glubeanRuntime.vars.base_url = "https://v2.example.com";
    assertEquals(vars.baseUrl, "https://v2.example.com");
  } finally {
    cleanup();
  }
});

// =============================================================================
// Lazy secrets
// =============================================================================

Deno.test("secrets - lazy getter reads from runtime slot", () => {
  const cleanup = setRuntime({}, { api_key: "sk-test-123" });
  try {
    const { secrets } = configure({ secrets: { apiKey: "api_key" } });
    assertEquals(secrets.apiKey, "sk-test-123");
  } finally {
    cleanup();
  }
});

Deno.test("secrets - throws on missing secret", () => {
  const cleanup = setRuntime({}, {});
  try {
    const { secrets } = configure({ secrets: { apiKey: "api_key" } });
    assertThrows(
      () => secrets.apiKey,
      Error,
      "Missing required secret: api_key",
    );
  } finally {
    cleanup();
  }
});

Deno.test("secrets - throws on empty string secret", () => {
  const cleanup = setRuntime({}, { api_key: "" });
  try {
    const { secrets } = configure({ secrets: { apiKey: "api_key" } });
    assertThrows(
      () => secrets.apiKey,
      Error,
      "Missing required secret: api_key",
    );
  } finally {
    cleanup();
  }
});

Deno.test("secrets - throws when accessed without runtime", () => {
  clearRuntime();
  const { secrets } = configure({ secrets: { apiKey: "api_key" } });
  assertThrows(
    () => secrets.apiKey,
    Error,
    "configure() values can only be accessed during test execution",
  );
});

// =============================================================================
// HTTP client - passthrough (no http config)
// =============================================================================

Deno.test("http - passthrough delegates to runtime http", () => {
  let getCalled = false;
  // deno-lint-ignore no-explicit-any
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
    assertEquals(getCalled, true);
  } finally {
    cleanup();
  }
});

Deno.test("http - passthrough throws without runtime", () => {
  clearRuntime();
  const { http } = configure({});
  assertThrows(
    () => http.get("https://example.com"),
    Error,
    "configure() values can only be accessed during test execution",
  );
});

// =============================================================================
// HTTP client - with http config
// =============================================================================

Deno.test("http - extends runtime http with prefixUrl from var", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    { base_url: "https://api.example.com" },
    {},
    mockHttp,
  );
  try {
    const { http } = configure({
      http: { prefixUrl: "base_url" },
    });
    // Trigger lazy resolution
    http.get("users");
    assertEquals(extendCalls.length, 1);
    assertEquals(extendCalls[0].options.prefixUrl, "https://api.example.com");
  } finally {
    cleanup();
  }
});

Deno.test("http - resolves {{key}} templates in headers from secrets", () => {
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
        prefixUrl: "base_url",
        headers: { Authorization: "Bearer {{api_key}}" },
      },
    });
    http.get("users");
    assertEquals(extendCalls.length, 1);
    const headers = extendCalls[0].options.headers as Record<string, string>;
    assertEquals(headers.Authorization, "Bearer sk-test-456");
  } finally {
    cleanup();
  }
});

Deno.test("http - resolves {{key}} templates from vars when not in secrets", () => {
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
    assertEquals(headers["X-Org-Id"], "org-789");
  } finally {
    cleanup();
  }
});

Deno.test("http - secrets take precedence over vars in templates", () => {
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
    assertEquals(headers.Authorization, "Bearer secret-token");
  } finally {
    cleanup();
  }
});

Deno.test("http - throws on missing template placeholder", () => {
  const mockHttp = createMockHttp();
  const cleanup = setRuntime({}, {}, mockHttp);
  try {
    const { http } = configure({
      http: {
        headers: { Authorization: "Bearer {{missing_key}}" },
      },
    });
    assertThrows(
      () => http.get("https://example.com"),
      Error,
      'Missing value for template placeholder "{{missing_key}}"',
    );
  } finally {
    cleanup();
  }
});

Deno.test("http - throws on missing prefixUrl var", () => {
  const mockHttp = createMockHttp();
  const cleanup = setRuntime({}, {}, mockHttp);
  try {
    const { http } = configure({
      http: { prefixUrl: "base_url" },
    });
    assertThrows(
      () => http.get("users"),
      Error,
      "Missing required var: base_url",
    );
  } finally {
    cleanup();
  }
});

Deno.test("http - passes through timeout option", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime({}, {}, mockHttp);
  try {
    const { http } = configure({
      http: { timeout: 5000 },
    });
    http.get("https://example.com");
    assertEquals(extendCalls[0].options.timeout, 5000);
  } finally {
    cleanup();
  }
});

Deno.test("http - passes through retry option", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime({}, {}, mockHttp);
  try {
    const { http } = configure({
      http: { retry: 3 },
    });
    http.get("https://example.com");
    assertEquals(extendCalls[0].options.retry, 3);
  } finally {
    cleanup();
  }
});

Deno.test("http - passes through throwHttpErrors option", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime({}, {}, mockHttp);
  try {
    const { http } = configure({
      http: { throwHttpErrors: false },
    });
    http.get("https://example.com");
    assertEquals(extendCalls[0].options.throwHttpErrors, false);
  } finally {
    cleanup();
  }
});

Deno.test("http - caches extended client (extend called once per runtime)", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    { base_url: "https://api.example.com" },
    {},
    mockHttp,
  );
  try {
    const { http } = configure({
      http: { prefixUrl: "base_url" },
    });
    // Multiple calls should only trigger one extend()
    http.get("users");
    http.post("users");
    http.get("orders");
    assertEquals(extendCalls.length, 1);
  } finally {
    cleanup();
  }
});

Deno.test("http - extend() on configured client delegates to resolved client", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    { base_url: "https://api.example.com" },
    {},
    mockHttp,
  );
  try {
    const { http } = configure({
      http: { prefixUrl: "base_url" },
    });
    // First extend creates the base configured client
    // Then .extend() on that creates a child
    const adminHttp = http.extend({
      headers: { "X-Admin": "true" },
    });
    assertEquals(typeof adminHttp, "function"); // is callable
    assertEquals(extendCalls.length, 2); // 1 from configure, 1 from .extend()
  } finally {
    cleanup();
  }
});

// =============================================================================
// HTTP client - all methods exist
// =============================================================================

Deno.test("http - all HTTP methods are proxied", () => {
  const cleanup = setRuntime({}, {});
  try {
    const { http } = configure({});
    const methods = ["get", "post", "put", "patch", "delete", "head"] as const;
    for (const method of methods) {
      assertEquals(typeof http[method], "function", `http.${method} should be a function`);
    }
    assertEquals(typeof http.extend, "function", "http.extend should be a function");
  } finally {
    cleanup();
  }
});

// =============================================================================
// Combined vars + secrets + http
// =============================================================================

Deno.test("full configure - vars, secrets, and http work together", () => {
  const extendCalls: { options: HttpRequestOptions }[] = [];
  const mockHttp = createMockHttp(extendCalls);
  const cleanup = setRuntime(
    { base_url: "https://api.example.com", org_id: "org-42" },
    { api_key: "sk-live-abc" },
    mockHttp,
  );
  try {
    const { vars, secrets, http } = configure({
      vars: { baseUrl: "base_url", orgId: "org_id" },
      secrets: { apiKey: "api_key" },
      http: {
        prefixUrl: "base_url",
        headers: {
          Authorization: "Bearer {{api_key}}",
          "X-Org-Id": "{{org_id}}",
        },
      },
    });

    // Vars
    assertEquals(vars.baseUrl, "https://api.example.com");
    assertEquals(vars.orgId, "org-42");

    // Secrets
    assertEquals(secrets.apiKey, "sk-live-abc");

    // HTTP
    http.get("users");
    assertEquals(extendCalls.length, 1);
    assertEquals(extendCalls[0].options.prefixUrl, "https://api.example.com");
    const headers = extendCalls[0].options.headers as Record<string, string>;
    assertEquals(headers.Authorization, "Bearer sk-live-abc");
    assertEquals(headers["X-Org-Id"], "org-42");
  } finally {
    cleanup();
  }
});

// =============================================================================
// Safe at module load time (scan-time safety)
// =============================================================================

Deno.test("configure() itself does not throw without runtime", () => {
  clearRuntime();
  // configure() should succeed — only accessing the returned values should throw
  const result = configure({
    vars: { baseUrl: "base_url" },
    secrets: { apiKey: "api_key" },
    http: { prefixUrl: "base_url" },
  });
  assertEquals(typeof result.vars, "object");
  assertEquals(typeof result.secrets, "object");
  assertEquals(typeof result.http, "function");
});

// =============================================================================
// Multiple configure() calls are independent
// =============================================================================

Deno.test("multiple configure calls are independent", () => {
  const cleanup = setRuntime(
    { base_url: "https://api.example.com", debug: "true" },
    { api_key: "sk-123" },
  );
  try {
    const config1 = configure({
      vars: { baseUrl: "base_url" },
    });
    const config2 = configure({
      vars: { debug: "debug" },
      secrets: { apiKey: "api_key" },
    });

    assertEquals(config1.vars.baseUrl, "https://api.example.com");
    assertEquals(config2.vars.debug, "true");
    assertEquals(config2.secrets.apiKey, "sk-123");

    // config1 doesn't have debug
    assertEquals(Object.keys(config1.vars), ["baseUrl"]);
    // config2 doesn't have baseUrl
    assertEquals(Object.keys(config2.vars), ["debug"]);
  } finally {
    cleanup();
  }
});

// =============================================================================
// Header template edge cases
// =============================================================================

Deno.test("http - header with multiple template placeholders", () => {
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
    assertEquals(headers.Authorization, "Basic admin:secret123");
  } finally {
    cleanup();
  }
});

Deno.test("http - header without template placeholders passed as-is", () => {
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
    assertEquals(headers["Content-Type"], "application/json");
  } finally {
    cleanup();
  }
});
