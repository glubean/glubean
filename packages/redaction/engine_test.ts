/**
 * Tests for @glubean/redaction engine, plugins, and adapter.
 *
 * Run: deno test packages/redaction/
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  RedactionEngine,
  createBuiltinPlugins,
  DEFAULT_CONFIG,
  redactEvent,
  genericPartialMask,
  type RedactionConfig,
  type RedactableEvent,
} from "./mod";

// ═══════════════════════════════════════════════════════════════════════════
// Helper: create engine with default config
// ═══════════════════════════════════════════════════════════════════════════

function createEngine(overrides?: Partial<RedactionConfig>): RedactionEngine {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  return new RedactionEngine({
    config,
    plugins: createBuiltinPlugins(config),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Sensitive key detection
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("sensitive-keys: exact match redacts value", () => {
  const engine = createEngine();
  const result = engine.redact({ password: "my-secret-pass" });
  assertEquals(
    (result.value as Record<string, unknown>).password,
    "[REDACTED]"
  );
  assertEquals(result.redacted, true);
});

Deno.test("sensitive-keys: substring match redacts value", () => {
  const engine = createEngine();
  // "x-authorization-token" contains "authorization"
  const result = engine.redact({
    "x-authorization-token": "Bearer abc123",
  });
  assertEquals(
    (result.value as Record<string, unknown>)["x-authorization-token"],
    "[REDACTED]"
  );
});

Deno.test("sensitive-keys: case insensitive", () => {
  const engine = createEngine();
  const result = engine.redact({ Authorization: "Bearer abc123" });
  assertEquals(
    (result.value as Record<string, unknown>).Authorization,
    "[REDACTED]"
  );
});

Deno.test("sensitive-keys: non-sensitive key passes through", () => {
  const engine = createEngine();
  const result = engine.redact({ username: "john" });
  assertEquals((result.value as Record<string, unknown>).username, "john");
  assertEquals(result.redacted, false);
});

Deno.test("sensitive-keys: additional keys from config", () => {
  const config: RedactionConfig = {
    ...DEFAULT_CONFIG,
    sensitiveKeys: {
      ...DEFAULT_CONFIG.sensitiveKeys,
      additional: ["x-custom-secret"],
    },
  };
  const engine = new RedactionEngine({
    config,
    plugins: createBuiltinPlugins(config),
  });
  const result = engine.redact({ "x-custom-secret": "value" });
  assertEquals(
    (result.value as Record<string, unknown>)["x-custom-secret"],
    "[REDACTED]"
  );
});

Deno.test("sensitive-keys: excluded keys are not redacted", () => {
  const config: RedactionConfig = {
    ...DEFAULT_CONFIG,
    sensitiveKeys: {
      useBuiltIn: true,
      additional: [],
      excluded: ["auth"],
    },
  };
  const engine = new RedactionEngine({
    config,
    plugins: createBuiltinPlugins(config),
  });
  const result = engine.redact({ auth: "some-value" });
  // "auth" is excluded, but "authorization" still in built-in list
  // "auth" itself is excluded → passes through
  assertEquals((result.value as Record<string, unknown>).auth, "some-value");
});

// ═══════════════════════════════════════════════════════════════════════════
// Pattern plugins — simple format
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("jwt: detects JWT token in string", () => {
  const engine = createEngine();
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123signature";
  const result = engine.redact(jwt);
  assertEquals(result.value, "[REDACTED]");
  assertEquals(result.redacted, true);
});

Deno.test("jwt: detects JWT embedded in a string", () => {
  const engine = createEngine();
  const text =
    "Token is eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123sig here";
  const result = engine.redact(text);
  assertEquals(result.value, "Token is [REDACTED] here");
});

Deno.test("bearer: detects Bearer token", () => {
  const engine = createEngine();
  const result = engine.redact("Bearer eyJhbGciOiJIUzI1NiJ9.token.sig");
  assertEquals(result.redacted, true);
  // Both bearer and jwt patterns may match
  assertNotEquals(result.value, "Bearer eyJhbGciOiJIUzI1NiJ9.token.sig");
});

Deno.test("awsKeys: detects AWS access key", () => {
  const engine = createEngine();
  const result = engine.redact("Key is AKIAIOSFODNN7EXAMPLE");
  assertEquals(result.value, "Key is [REDACTED]");
});

Deno.test("githubTokens: detects GitHub PAT", () => {
  const engine = createEngine();
  const ghp = "ghp_" + "a".repeat(40);
  const result = engine.redact(`Token: ${ghp}`);
  assertEquals(result.value, "Token: [REDACTED]");
});

Deno.test("email: detects email address", () => {
  const engine = createEngine();
  const result = engine.redact("Contact: user@example.com");
  assertEquals(result.value, "Contact: [REDACTED]");
});

Deno.test("ipAddress: detects IPv4 address", () => {
  const engine = createEngine();
  const result = engine.redact("Server: 192.168.1.100");
  assertEquals(result.value, "Server: [REDACTED]");
});

Deno.test("creditCard: detects card number", () => {
  const engine = createEngine();
  const result = engine.redact("Card: 4111-1111-1111-1111");
  assertEquals(result.value, "Card: [REDACTED]");
});

Deno.test("creditCard: detects card number without separators", () => {
  const engine = createEngine();
  const result = engine.redact("Card: 4111111111111111");
  assertEquals(result.value, "Card: [REDACTED]");
});

Deno.test("hexKeys: detects long hex string", () => {
  const engine = createEngine();
  const hex = "a".repeat(32);
  const result = engine.redact(`Key: ${hex}`);
  assertEquals(result.value, "Key: [REDACTED]");
});

Deno.test("hexKeys: ignores short hex string", () => {
  const engine = createEngine();
  const result = engine.redact("ID: abcdef0123456789"); // 16 chars, below 32
  assertEquals(result.value, "ID: abcdef0123456789");
});

// ═══════════════════════════════════════════════════════════════════════════
// Replacement formats
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("labeled format: includes plugin name", () => {
  const engine = createEngine({ replacementFormat: "labeled" });
  const result = engine.redact("Contact: user@example.com");
  assertEquals(result.value, "Contact: [REDACTED:email]");
});

Deno.test("labeled format: sensitive key shows [REDACTED]", () => {
  const engine = createEngine({ replacementFormat: "labeled" });
  const result = engine.redact({ password: "secret" });
  // Key-level redaction always uses [REDACTED] (no label for keys)
  assertEquals(
    (result.value as Record<string, unknown>).password,
    "[REDACTED]"
  );
});

Deno.test("partial format: email uses smart mask", () => {
  const engine = createEngine({ replacementFormat: "partial" });
  const result = engine.redact("user@example.com");
  assertEquals(result.value, "u***@***.com");
});

Deno.test("partial format: IP uses first two octets", () => {
  const engine = createEngine({ replacementFormat: "partial" });
  const result = engine.redact("192.168.1.100");
  assertEquals(result.value, "192.168.*.*");
});

Deno.test("partial format: credit card shows last 4", () => {
  const engine = createEngine({ replacementFormat: "partial" });
  const result = engine.redact("4111-1111-1111-1234");
  assertEquals(result.value, "****-****-****-1234");
});

Deno.test("partial format: JWT shows first 3 + last 3", () => {
  const engine = createEngine({ replacementFormat: "partial" });
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgh";
  const result = engine.redact(jwt);
  assertEquals(result.value, "eyJ***fgh");
});

Deno.test("partial format: AWS key shows first 4 + last 2", () => {
  const engine = createEngine({ replacementFormat: "partial" });
  const result = engine.redact("AKIAIOSFODNN7EXAMPLE");
  assertEquals(result.value, "AKIA***LE");
});

Deno.test("partial format: sensitive key value uses generic mask", () => {
  const engine = createEngine({ replacementFormat: "partial" });
  const result = engine.redact({ password: "mysecretpassword" });
  // genericPartialMask for "mysecretpassword" (16 chars) → "mys***ord"
  assertEquals((result.value as Record<string, unknown>).password, "mys***ord");
});

// ═══════════════════════════════════════════════════════════════════════════
// Recursive object/array walking
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("recursive: nested object", () => {
  const engine = createEngine();
  const result = engine.redact({
    user: {
      name: "John",
      settings: {
        password: "secret123",
      },
    },
  });
  // deno-lint-ignore no-explicit-any
  const value = result.value as any;
  assertEquals(value.user.name, "John");
  assertEquals(value.user.settings.password, "[REDACTED]");
});

Deno.test("recursive: array of objects", () => {
  const engine = createEngine();
  const result = engine.redact([
    { api_key: "key1" },
    { username: "john" },
    { token: "tok123" },
  ]);
  const value = result.value as Array<Record<string, unknown>>;
  assertEquals(value[0].api_key, "[REDACTED]");
  assertEquals(value[1].username, "john");
  assertEquals(value[2].token, "[REDACTED]");
});

Deno.test("recursive: array of strings with patterns", () => {
  const engine = createEngine();
  const result = engine.redact(["user@example.com", "hello", "192.168.1.1"]);
  const value = result.value as string[];
  assertEquals(value[0], "[REDACTED]");
  assertEquals(value[1], "hello");
  assertEquals(value[2], "[REDACTED]");
});

Deno.test("recursive: depth guard triggers at max depth", () => {
  const engine = new RedactionEngine({
    config: DEFAULT_CONFIG,
    plugins: createBuiltinPlugins(DEFAULT_CONFIG),
    maxDepth: 2,
  });
  // 3 levels deep: should hit depth guard
  const result = engine.redact({
    a: { b: { c: { password: "secret" } } },
  });
  const value = result.value as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  assertEquals(value.a.b.c, "[REDACTED: too deep]");
});

// ═══════════════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("edge: null value passes through", () => {
  const engine = createEngine();
  const result = engine.redact(null);
  assertEquals(result.value, null);
  assertEquals(result.redacted, false);
});

Deno.test("edge: undefined value passes through", () => {
  const engine = createEngine();
  const result = engine.redact(undefined);
  assertEquals(result.value, undefined);
  assertEquals(result.redacted, false);
});

Deno.test("edge: number passes through", () => {
  const engine = createEngine();
  const result = engine.redact(42);
  assertEquals(result.value, 42);
  assertEquals(result.redacted, false);
});

Deno.test("edge: boolean passes through", () => {
  const engine = createEngine();
  const result = engine.redact(true);
  assertEquals(result.value, true);
  assertEquals(result.redacted, false);
});

Deno.test("edge: empty object passes through", () => {
  const engine = createEngine();
  const result = engine.redact({});
  assertEquals(result.value, {});
  assertEquals(result.redacted, false);
});

Deno.test("edge: empty array passes through", () => {
  const engine = createEngine();
  const result = engine.redact([]);
  assertEquals(result.value, []);
  assertEquals(result.redacted, false);
});

Deno.test("edge: empty string passes through", () => {
  const engine = createEngine();
  const result = engine.redact("");
  assertEquals(result.value, "");
  assertEquals(result.redacted, false);
});

Deno.test("edge: non-matching string passes through", () => {
  const engine = createEngine();
  const result = engine.redact("just a normal message");
  assertEquals(result.value, "just a normal message");
  assertEquals(result.redacted, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// Scope gating
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("scope: disabled scope skips redaction", () => {
  const config: RedactionConfig = {
    ...DEFAULT_CONFIG,
    scopes: {
      ...DEFAULT_CONFIG.scopes,
      consoleOutput: false,
    },
  };
  const engine = new RedactionEngine({
    config,
    plugins: createBuiltinPlugins(config),
  });
  const result = engine.redact("user@example.com", "consoleOutput");
  // consoleOutput scope is disabled — passes through unchanged
  assertEquals(result.value, "user@example.com");
  assertEquals(result.redacted, false);
});

Deno.test("scope: enabled scope applies redaction", () => {
  const engine = createEngine();
  const result = engine.redact("user@example.com", "consoleOutput");
  assertEquals(result.value, "[REDACTED]");
  assertEquals(result.redacted, true);
});

Deno.test("scope: no scope specified always redacts", () => {
  const engine = createEngine();
  const result = engine.redact("user@example.com");
  assertEquals(result.value, "[REDACTED]");
});

// ═══════════════════════════════════════════════════════════════════════════
// Adapter: redactEvent
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("adapter: trace event redacts headers and bodies", () => {
  const engine = createEngine();
  const event: RedactableEvent = {
    type: "trace",
    data: {
      method: "POST",
      url: "https://api.example.com/users",
      status: 200,
      duration: 150,
      requestHeaders: {
        authorization: "Bearer secret-token-123",
        "content-type": "application/json",
      },
      requestBody: { password: "mysecret", username: "john" },
      responseHeaders: { "x-request-id": "abc123" },
      responseBody: { token: "new-access-token" },
    },
  };
  const redacted = redactEvent(engine, event);
  const data = (redacted as Record<string, unknown>).data as Record<
    string,
    unknown
  >;

  // Headers: authorization key is sensitive
  const reqHeaders = data.requestHeaders as Record<string, unknown>;
  assertEquals(reqHeaders.authorization, "[REDACTED]");
  assertEquals(reqHeaders["content-type"], "application/json");

  // Body: password key is sensitive
  const reqBody = data.requestBody as Record<string, unknown>;
  assertEquals(reqBody.password, "[REDACTED]");
  assertEquals(reqBody.username, "john");

  // Response body: token key is sensitive
  const resBody = data.responseBody as Record<string, unknown>;
  assertEquals(resBody.token, "[REDACTED]");
});

Deno.test("adapter: log event redacts message and data", () => {
  const engine = createEngine();
  const event: RedactableEvent = {
    type: "log",
    message: "User email: user@example.com",
    data: { password: "secret" },
  };
  const redacted = redactEvent(engine, event);
  assertEquals(redacted.message, "User email: [REDACTED]");
  assertEquals(
    (redacted.data as Record<string, unknown>).password,
    "[REDACTED]"
  );
});

Deno.test("adapter: assertion event redacts message, actual, expected", () => {
  const engine = createEngine();
  const event: RedactableEvent = {
    type: "assertion",
    passed: false,
    message: "Expected token to match",
    actual: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
    expected: "some-value",
  };
  const redacted = redactEvent(engine, event);
  assertEquals(redacted.passed, false);
  // JWT in actual should be redacted
  assertNotEquals(
    redacted.actual,
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature"
  );
});

Deno.test("adapter: error event redacts message", () => {
  const engine = createEngine();
  const event: RedactableEvent = {
    type: "error",
    message: "Failed with key AKIAIOSFODNN7EXAMPLE",
  };
  const redacted = redactEvent(engine, event);
  assertEquals(redacted.message, "Failed with key [REDACTED]");
});

Deno.test("adapter: status event redacts error and stack", () => {
  const engine = createEngine();
  const event: RedactableEvent = {
    type: "status",
    status: "failed",
    error: "Auth failed with token Bearer abc.def.ghi",
  };
  const redacted = redactEvent(engine, event);
  assertNotEquals(redacted.error, "Auth failed with token Bearer abc.def.ghi");
});

Deno.test("adapter: metric event passes through unchanged", () => {
  const engine = createEngine();
  const event: RedactableEvent = {
    type: "metric",
    name: "response_time",
    value: 150,
    unit: "ms",
  };
  const redacted = redactEvent(engine, event);
  assertEquals(redacted, event); // Same reference — not cloned
});

Deno.test("adapter: start event passes through unchanged", () => {
  const engine = createEngine();
  const event: RedactableEvent = {
    type: "start",
    id: "test-1",
    name: "My Test",
  };
  const redacted = redactEvent(engine, event);
  assertEquals(redacted, event);
});

Deno.test("adapter: does not mutate original event", () => {
  const engine = createEngine();
  const original: RedactableEvent = {
    type: "log",
    message: "Email: user@example.com",
  };
  const messageBefore = original.message;
  redactEvent(engine, original);
  assertEquals(original.message, messageBefore); // Original unchanged
});

// ═══════════════════════════════════════════════════════════════════════════
// Adapter: scope gating in trace events
// ═══════════════════════════════════════════════════════════════════════════

Deno.test(
  "adapter: disabled requestHeaders scope skips header redaction",
  () => {
    const config: RedactionConfig = {
      ...DEFAULT_CONFIG,
      scopes: {
        ...DEFAULT_CONFIG.scopes,
        requestHeaders: false,
      },
    };
    const engine = new RedactionEngine({
      config,
      plugins: createBuiltinPlugins(config),
    });
    const event: RedactableEvent = {
      type: "trace",
      data: {
        method: "GET",
        url: "https://api.example.com",
        status: 200,
        duration: 50,
        requestHeaders: { authorization: "Bearer secret" },
        responseBody: { token: "abc" },
      },
    };
    const redacted = redactEvent(engine, event);
    const data = (redacted as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    // requestHeaders scope disabled → passes through
    const reqHeaders = data.requestHeaders as Record<string, unknown>;
    assertEquals(reqHeaders.authorization, "Bearer secret");
    // responseBody scope still enabled → redacted
    const resBody = data.responseBody as Record<string, unknown>;
    assertEquals(resBody.token, "[REDACTED]");
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// genericPartialMask utility
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("genericPartialMask: short string (<=4)", () => {
  assertEquals(genericPartialMask("abc"), "****");
  assertEquals(genericPartialMask("abcd"), "****");
});

Deno.test("genericPartialMask: medium string (5-8)", () => {
  assertEquals(genericPartialMask("abcde"), "ab***e");
  assertEquals(genericPartialMask("abcdefgh"), "ab***h");
});

Deno.test("genericPartialMask: long string (>8)", () => {
  assertEquals(genericPartialMask("abcdefghi"), "abc***ghi");
  assertEquals(genericPartialMask("a]very-long-string"), "a]v***ing");
});

// ═══════════════════════════════════════════════════════════════════════════
// Custom patterns
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("custom pattern: detects user-defined regex", () => {
  const config: RedactionConfig = {
    ...DEFAULT_CONFIG,
    patterns: {
      ...DEFAULT_CONFIG.patterns,
      custom: [{ name: "internal-token", regex: "nbai_[a-zA-Z0-9]{16}" }],
    },
  };
  const engine = new RedactionEngine({
    config,
    plugins: createBuiltinPlugins(config),
  });
  const result = engine.redact("Key: nbai_abcdef0123456789");
  assertEquals(result.value, "Key: [REDACTED]");
});

Deno.test("custom pattern: invalid regex is skipped", () => {
  const config: RedactionConfig = {
    ...DEFAULT_CONFIG,
    patterns: {
      ...DEFAULT_CONFIG.patterns,
      custom: [{ name: "bad", regex: "[invalid" }],
    },
  };
  // Should not throw — invalid patterns are silently skipped
  const engine = new RedactionEngine({
    config,
    plugins: createBuiltinPlugins(config),
  });
  const result = engine.redact("hello world");
  assertEquals(result.value, "hello world");
});

// ═══════════════════════════════════════════════════════════════════════════
// Details tracking
// ═══════════════════════════════════════════════════════════════════════════

Deno.test("details: tracks redacted fields with path and plugin", () => {
  const engine = createEngine();
  const result = engine.redact({
    headers: { authorization: "Bearer abc" },
    body: "user@example.com",
  });
  assertEquals(result.redacted, true);
  // Should have at least 2 detail entries (key redaction + email pattern)
  const keyDetail = result.details.find(
    (d) => d.path === "headers.authorization"
  );
  assertEquals(keyDetail?.plugin, "sensitive-keys");

  const emailDetail = result.details.find((d) => d.path === "body");
  assertEquals(emailDetail?.plugin, "email");
});
