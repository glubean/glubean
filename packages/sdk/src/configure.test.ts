import { test, expect } from "vitest";
import { configure } from "./configure.js";
import { definePlugin } from "./plugin.js";
import type { GlubeanRuntime, HttpClient, HttpRequestOptions } from "./types.js";

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
  test?: { id: string; tags: string[] },
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__glubeanRuntime = {
    vars,
    secrets,
    http: http ?? createMockHttp(),
    test,
  };
  return () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__glubeanRuntime;
  };
}

/**
 * Remove the runtime slot (simulate scan-time / no harness).
 */
function clearRuntime() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).__glubeanRuntime;
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

test("vars - lazy getter reads from runtime slot", () => {
  const cleanup = setRuntime({ base_url: "https://api.example.com" });
  try {
    const { vars } = configure({ vars: { baseUrl: "base_url" } });
    expect(vars.baseUrl).toBe("https://api.example.com");
  } finally {
    cleanup();
  }
});

test("vars - multiple properties", () => {
  const cleanup = setRuntime({
    base_url: "https://api.example.com",
    org_id: "org-123",
  });
  try {
    const { vars } = configure({
      vars: { baseUrl: "base_url", orgId: "org_id" },
    });
    expect(vars.baseUrl).toBe("https://api.example.com");
    expect(vars.orgId).toBe("org-123");
  } finally {
    cleanup();
  }
});

test("vars - throws on missing var", () => {
  const cleanup = setRuntime({ other_var: "value" });
  try {
    const { vars } = configure({ vars: { baseUrl: "base_url" } });
    expect(
      () => vars.baseUrl,
    ).toThrow("Missing required var: base_url");
  } finally {
    cleanup();
  }
});

test("vars - throws on empty string var", () => {
  const cleanup = setRuntime({ base_url: "" });
  try {
    const { vars } = configure({ vars: { baseUrl: "base_url" } });
    expect(
      () => vars.baseUrl,
    ).toThrow("Missing required var: base_url");
  } finally {
    cleanup();
  }
});

test("vars - throws when accessed without runtime (scan time)", () => {
  clearRuntime();
  const { vars } = configure({ vars: { baseUrl: "base_url" } });
  expect(
    () => vars.baseUrl,
  ).toThrow("configure() values can only be accessed during test execution");
});

test("vars - properties are enumerable", () => {
  const cleanup = setRuntime({ base_url: "https://example.com" });
  try {
    const { vars } = configure({
      vars: { baseUrl: "base_url", orgId: "org_id" },
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
    const { vars } = configure({ vars: { baseUrl: "base_url" } });
    expect(vars.baseUrl).toBe("https://v1.example.com");

    // Simulate a new test execution with different vars
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__glubeanRuntime.vars.base_url = "https://v2.example.com";
    expect(vars.baseUrl).toBe("https://v2.example.com");
  } finally {
    cleanup();
  }
});

// =============================================================================
// Lazy secrets
// =============================================================================

test("secrets - lazy getter reads from runtime slot", () => {
  const cleanup = setRuntime({}, { api_key: "sk-test-123" });
  try {
    const { secrets } = configure({ secrets: { apiKey: "api_key" } });
    expect(secrets.apiKey).toBe("sk-test-123");
  } finally {
    cleanup();
  }
});

test("secrets - throws on missing secret", () => {
  const cleanup = setRuntime({}, {});
  try {
    const { secrets } = configure({ secrets: { apiKey: "api_key" } });
    expect(
      () => secrets.apiKey,
    ).toThrow("Missing required secret: api_key");
  } finally {
    cleanup();
  }
});

test("secrets - throws on empty string secret", () => {
  const cleanup = setRuntime({}, { api_key: "" });
  try {
    const { secrets } = configure({ secrets: { apiKey: "api_key" } });
    expect(
      () => secrets.apiKey,
    ).toThrow("Missing required secret: api_key");
  } finally {
    cleanup();
  }
});

test("secrets - throws when accessed without runtime", () => {
  clearRuntime();
  const { secrets } = configure({ secrets: { apiKey: "api_key" } });
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
      http: { prefixUrl: "base_url" },
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
        prefixUrl: "base_url",
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
      http: { prefixUrl: "base_url" },
    });
    expect(
      () => http.get("users"),
    ).toThrow("Missing required var: base_url");
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
      http: { prefixUrl: "base_url" },
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
      http: { prefixUrl: "base_url" },
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
    vars: { baseUrl: "base_url" },
    secrets: { apiKey: "api_key" },
    http: { prefixUrl: "base_url" },
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
      vars: { baseUrl: "base_url" },
    });
    const config2 = configure({
      vars: { debug: "debug" },
      secrets: { apiKey: "api_key" },
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
        prefixUrl: "base_url",
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
        myPlugin: definePlugin((_runtime) => {
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
        counter: definePlugin((_runtime) => {
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
        a: definePlugin((_runtime) => {
          aCreated = true;
          return { name: "pluginA" };
        }),
        b: definePlugin((_runtime) => {
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
        test: definePlugin((runtime) => {
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
        test: definePlugin((runtime) => {
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
        test: definePlugin((runtime) => {
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
      test: definePlugin((_runtime) => ({ value: 42 })),
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
      vars: { baseUrl: "base_url" },
      secrets: { apiKey: "api_key" },
      http: { prefixUrl: "base_url" },
      plugins: {
        myClient: definePlugin((runtime) => ({
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
        alpha: definePlugin((_r) => ({ x: 1, y: "hello" })),
        beta: definePlugin((_r) => ({ items: ["a", "b", "c"] })),
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
      vars: { baseUrl: "base_url" },
    });
    expect(result.vars.baseUrl).toBe("https://api.example.com");
  } finally {
    cleanup();
  }
});

// =============================================================================
// Plugin and HTTP activation
// =============================================================================

test("plugins - supports { factory, activation } entry wrapper", () => {
  const cleanup = setRuntime({}, {}, undefined, { id: "t1", tags: [] });
  try {
    const result = configure({
      plugins: {
        wrapped: {
          factory: definePlugin((_runtime) => ({ ok: true })),
          activation: {
            tags: { enable: ["smoke"] },
          },
        },
      },
    });

    expect(
      () => result.wrapped.ok,
    ).toThrow("activation.tags.enable");
  } finally {
    cleanup();
  }
});

test("plugins - tags.enable activates plugin when tag matches", () => {
  const cleanup = setRuntime({}, {}, undefined, { id: "t1", tags: ["smoke"] });
  try {
    const result = configure({
      plugins: {
        gated: {
          factory: definePlugin((_runtime) => ({ ok: true })),
          activation: { tags: { enable: ["smoke"] } },
        },
      },
    });
    expect(result.gated.ok).toBe(true);
  } finally {
    cleanup();
  }
});

test("plugins - tags.disable takes precedence over tags.enable", () => {
  const cleanup = setRuntime({}, {}, undefined, {
    id: "t1",
    tags: ["smoke", "no-auth"],
  });
  try {
    const result = configure({
      plugins: {
        gated: {
          factory: definePlugin((_runtime) => ({ ok: true })),
          activation: {
            tags: {
              enable: ["smoke"],
              disable: ["no-auth"],
            },
          },
        },
      },
    });
    expect(
      () => result.gated.ok,
    ).toThrow("matches activation.tags.disable");
  } finally {
    cleanup();
  }
});

test("plugins - requests.exclude blocks plugin runtime.http calls", () => {
  const cleanup = setRuntime({}, {}, createMockHttp(), { id: "t1", tags: [] });
  try {
    const result = configure({
      plugins: {
        secureApi: {
          factory: definePlugin((runtime) => ({
            login: () => runtime.http.get("https://api.example.com/auth/login"),
          })),
          activation: {
            requests: {
              exclude: [{ method: "GET", path: "/auth/login" }],
            },
          },
        },
      },
    });

    expect(
      () => result.secureApi.login(),
    ).toThrow("inactive for request GET https://api.example.com/auth/login");
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
        plugins: { vars: definePlugin((_r) => ({ x: 1 })) },
      }),
  ).toThrow('Plugin name "vars" conflicts with a reserved configure() field');
});

test("plugins - throws on reserved key 'secrets'", () => {
  expect(
    () =>
      configure({
        // @ts-expect-error: "secrets" is a reserved key — rejected at type level
        plugins: { secrets: definePlugin((_r) => ({ x: 1 })) },
      }),
  ).toThrow('Plugin name "secrets" conflicts with a reserved configure() field');
});

test("plugins - throws on reserved key 'http'", () => {
  expect(
    () =>
      configure({
        // @ts-expect-error: "http" is a reserved key — rejected at type level
        plugins: { http: definePlugin((_r) => ({ x: 1 })) },
      }),
  ).toThrow('Plugin name "http" conflicts with a reserved configure() field');
});
