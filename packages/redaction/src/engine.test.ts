import { test, expect } from "vitest";
import {
  createBuiltinPlugins,
  DEFAULT_CONFIG,
  genericPartialMask,
  type RedactableEvent,
  redactEvent,
  type RedactionConfig,
  RedactionEngine,
} from "./index.js";

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

test("sensitive-keys: exact match redacts value", () => {
  const engine = createEngine();
  const result = engine.redact({ password: "my-secret-pass" });
  expect(
    (result.value as Record<string, unknown>).password,
  ).toBe("my-***ass");
  expect(result.redacted).toBe(true);
});

test("sensitive-keys: substring match redacts value", () => {
  const engine = createEngine();
  const result = engine.redact({
    "x-authorization-token": "Bearer abc123",
  });
  expect(
    (result.value as Record<string, unknown>)["x-authorization-token"],
  ).toBe("Bea***123");
});

test("sensitive-keys: case insensitive", () => {
  const engine = createEngine();
  const result = engine.redact({ Authorization: "Bearer abc123" });
  expect(
    (result.value as Record<string, unknown>).Authorization,
  ).toBe("Bea***123");
});

test("sensitive-keys: non-sensitive key passes through", () => {
  const engine = createEngine();
  const result = engine.redact({ username: "john" });
  expect((result.value as Record<string, unknown>).username).toBe("john");
  expect(result.redacted).toBe(false);
});

test("sensitive-keys: additional keys from config", () => {
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
  expect(
    (result.value as Record<string, unknown>)["x-custom-secret"],
  ).toBe("va***e");
});

test("sensitive-keys: excluded keys are not redacted", () => {
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
  expect((result.value as Record<string, unknown>).auth).toBe("some-value");
});

// ═══════════════════════════════════════════════════════════════════════════
// Pattern plugins — simple format
// ═══════════════════════════════════════════════════════════════════════════

test("jwt: detects JWT token in string", () => {
  const engine = createEngine();
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123signature";
  const result = engine.redact(jwt);
  expect(result.value).toBe("eyJ***ure");
  expect(result.redacted).toBe(true);
});

test("jwt: detects JWT embedded in a string", () => {
  const engine = createEngine();
  const text = "Token is eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123sig here";
  const result = engine.redact(text);
  expect(result.value).toBe("Token is eyJ***sig here");
});

test("bearer: detects Bearer token", () => {
  const engine = createEngine();
  const result = engine.redact("Bearer eyJhbGciOiJIUzI1NiJ9.token.sig");
  expect(result.redacted).toBe(true);
  expect(result.value).not.toBe("Bearer eyJhbGciOiJIUzI1NiJ9.token.sig");
});

test("awsKeys: detects AWS access key", () => {
  const engine = createEngine();
  const result = engine.redact("Key is AKIAIOSFODNN7EXAMPLE");
  expect(result.value).toBe("Key is AKIA***LE");
});

test("githubTokens: detects GitHub PAT", () => {
  const engine = createEngine();
  const ghp = "ghp_" + "a".repeat(40);
  const result = engine.redact(`Token: ${ghp}`);
  expect(result.value).toBe("Token: ghp_***aaa");
});

test("email: detects email address", () => {
  const engine = createEngine();
  const result = engine.redact("Contact: user@example.com");
  expect(result.value).toBe("Contact: u***@***.com");
});

test("ipAddress: detects IPv4 address", () => {
  const engine = createEngine();
  const result = engine.redact("Server: 192.168.1.100");
  expect(result.value).toBe("Server: 192.168.*.*");
});

test("creditCard: detects card number", () => {
  const engine = createEngine();
  const result = engine.redact("Card: 4111-1111-1111-1111");
  expect(result.value).toBe("Card: ****-****-****-1111");
});

test("creditCard: detects card number without separators", () => {
  const engine = createEngine();
  const result = engine.redact("Card: 4111111111111111");
  expect(result.value).toBe("Card: ****-****-****-1111");
});

test("hexKeys: detects long hex string", () => {
  const engine = createEngine();
  const hex = "a".repeat(32);
  const result = engine.redact(`Key: ${hex}`);
  expect(result.value).toBe("Key: aaa***aaa");
});

test("hexKeys: ignores short hex string", () => {
  const engine = createEngine();
  const result = engine.redact("ID: abcdef0123456789");
  expect(result.value).toBe("ID: abcdef0123456789");
});

// ═══════════════════════════════════════════════════════════════════════════
// Replacement formats
// ═══════════════════════════════════════════════════════════════════════════

test("labeled format: includes plugin name", () => {
  const engine = createEngine({ replacementFormat: "labeled" });
  const result = engine.redact("Contact: user@example.com");
  expect(result.value).toBe("Contact: [REDACTED:email]");
});

test("labeled format: sensitive key shows [REDACTED]", () => {
  const engine = createEngine({ replacementFormat: "labeled" });
  const result = engine.redact({ password: "secret" });
  expect(
    (result.value as Record<string, unknown>).password,
  ).toBe("[REDACTED]");
});

test("partial format: email uses smart mask", () => {
  const engine = createEngine({ replacementFormat: "partial" });
  const result = engine.redact("user@example.com");
  expect(result.value).toBe("u***@***.com");
});

test("partial format: IP uses first two octets", () => {
  const engine = createEngine({ replacementFormat: "partial" });
  const result = engine.redact("192.168.1.100");
  expect(result.value).toBe("192.168.*.*");
});

test("partial format: credit card shows last 4", () => {
  const engine = createEngine({ replacementFormat: "partial" });
  const result = engine.redact("4111-1111-1111-1234");
  expect(result.value).toBe("****-****-****-1234");
});

test("partial format: JWT shows first 3 + last 3", () => {
  const engine = createEngine({ replacementFormat: "partial" });
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgh";
  const result = engine.redact(jwt);
  expect(result.value).toBe("eyJ***fgh");
});

test("partial format: AWS key shows first 4 + last 2", () => {
  const engine = createEngine({ replacementFormat: "partial" });
  const result = engine.redact("AKIAIOSFODNN7EXAMPLE");
  expect(result.value).toBe("AKIA***LE");
});

test("partial format: sensitive key value uses generic mask", () => {
  const engine = createEngine({ replacementFormat: "partial" });
  const result = engine.redact({ password: "mysecretpassword" });
  expect((result.value as Record<string, unknown>).password).toBe("mys***ord");
});

// ═══════════════════════════════════════════════════════════════════════════
// Recursive object/array walking
// ═══════════════════════════════════════════════════════════════════════════

test("recursive: nested object", () => {
  const engine = createEngine();
  const result = engine.redact({
    user: {
      name: "John",
      settings: {
        password: "secret123",
      },
    },
  });
  const value = result.value as any;
  expect(value.user.name).toBe("John");
  expect(value.user.settings.password).toBe("sec***123");
});

test("recursive: array of objects", () => {
  const engine = createEngine();
  const result = engine.redact([
    { api_key: "key1" },
    { username: "john" },
    { token: "tok123" },
  ]);
  const value = result.value as Array<Record<string, unknown>>;
  expect(value[0].api_key).toBe("****");
  expect(value[1].username).toBe("john");
  expect(value[2].token).toBe("to***3");
});

test("recursive: array of strings with patterns", () => {
  const engine = createEngine();
  const result = engine.redact(["user@example.com", "hello", "192.168.1.1"]);
  const value = result.value as string[];
  expect(value[0]).toBe("u***@***.com");
  expect(value[1]).toBe("hello");
  expect(value[2]).toBe("192.168.*.*");
});

test("recursive: depth guard triggers at max depth", () => {
  const engine = new RedactionEngine({
    config: DEFAULT_CONFIG,
    plugins: createBuiltinPlugins(DEFAULT_CONFIG),
    maxDepth: 2,
  });
  const result = engine.redact({
    a: { b: { c: { password: "secret" } } },
  });
  const value = result.value as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  expect(value.a.b.c).toBe("[REDACTED: too deep]");
});

// ═══════════════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════════════

test("edge: null value passes through", () => {
  const engine = createEngine();
  const result = engine.redact(null);
  expect(result.value).toBeNull();
  expect(result.redacted).toBe(false);
});

test("edge: undefined value passes through", () => {
  const engine = createEngine();
  const result = engine.redact(undefined);
  expect(result.value).toBeUndefined();
  expect(result.redacted).toBe(false);
});

test("edge: number passes through", () => {
  const engine = createEngine();
  const result = engine.redact(42);
  expect(result.value).toBe(42);
  expect(result.redacted).toBe(false);
});

test("edge: boolean passes through", () => {
  const engine = createEngine();
  const result = engine.redact(true);
  expect(result.value).toBe(true);
  expect(result.redacted).toBe(false);
});

test("edge: empty object passes through", () => {
  const engine = createEngine();
  const result = engine.redact({});
  expect(result.value).toEqual({});
  expect(result.redacted).toBe(false);
});

test("edge: empty array passes through", () => {
  const engine = createEngine();
  const result = engine.redact([]);
  expect(result.value).toEqual([]);
  expect(result.redacted).toBe(false);
});

test("edge: empty string passes through", () => {
  const engine = createEngine();
  const result = engine.redact("");
  expect(result.value).toBe("");
  expect(result.redacted).toBe(false);
});

test("edge: non-matching string passes through", () => {
  const engine = createEngine();
  const result = engine.redact("just a normal message");
  expect(result.value).toBe("just a normal message");
  expect(result.redacted).toBe(false);
});

// ═══════════════════════════════════════════════════════════════════════════
// Scope gating
// ═══════════════════════════════════════════════════════════════════════════

test("scope: disabled scope skips redaction", () => {
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
  expect(result.value).toBe("user@example.com");
  expect(result.redacted).toBe(false);
});

test("scope: enabled scope applies redaction", () => {
  const engine = createEngine();
  const result = engine.redact("user@example.com", "consoleOutput");
  expect(result.value).toBe("u***@***.com");
  expect(result.redacted).toBe(true);
});

test("scope: no scope specified always redacts", () => {
  const engine = createEngine();
  const result = engine.redact("user@example.com");
  expect(result.value).toBe("u***@***.com");
});

// ═══════════════════════════════════════════════════════════════════════════
// Adapter: redactEvent
// ═══════════════════════════════════════════════════════════════════════════

test("adapter: trace event redacts headers and bodies", () => {
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
  const data = (redacted as Record<string, unknown>).data as Record<string, unknown>;

  const reqHeaders = data.requestHeaders as Record<string, unknown>;
  expect(reqHeaders.authorization).toBe("Bea***123");
  expect(reqHeaders["content-type"]).toBe("application/json");

  const reqBody = data.requestBody as Record<string, unknown>;
  expect(reqBody.password).toBe("my***t");
  expect(reqBody.username).toBe("john");

  const resBody = data.responseBody as Record<string, unknown>;
  expect(resBody.token).toBe("new***ken");
});

test("adapter: log event redacts message and data", () => {
  const engine = createEngine();
  const event: RedactableEvent = {
    type: "log",
    message: "User email: user@example.com",
    data: { password: "secret" },
  };
  const redacted = redactEvent(engine, event);
  expect(redacted.message).toBe("User email: u***@***.com");
  expect(
    (redacted.data as Record<string, unknown>).password,
  ).toBe("se***t");
});

test("adapter: assertion event redacts message, actual, expected", () => {
  const engine = createEngine();
  const event: RedactableEvent = {
    type: "assertion",
    passed: false,
    message: "Expected token to match",
    actual: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
    expected: "some-value",
  };
  const redacted = redactEvent(engine, event);
  expect(redacted.passed).toBe(false);
  expect(redacted.actual).not.toBe(
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
  );
});

test("adapter: error event redacts message", () => {
  const engine = createEngine();
  const event: RedactableEvent = {
    type: "error",
    message: "Failed with key AKIAIOSFODNN7EXAMPLE",
  };
  const redacted = redactEvent(engine, event);
  expect(redacted.message).toBe("Failed with key AKIA***LE");
});

test("adapter: status event redacts error and stack", () => {
  const engine = createEngine();
  const event: RedactableEvent = {
    type: "status",
    status: "failed",
    error: "Auth failed with token Bearer abc.def.ghi",
  };
  const redacted = redactEvent(engine, event);
  expect(redacted.error).not.toBe("Auth failed with token Bearer abc.def.ghi");
});

test("adapter: metric event passes through unchanged", () => {
  const engine = createEngine();
  const event: RedactableEvent = {
    type: "metric",
    name: "response_time",
    value: 150,
    unit: "ms",
  };
  const redacted = redactEvent(engine, event);
  expect(redacted).toBe(event);
});

test("adapter: summary event passes through unchanged", () => {
  const engine = createEngine();
  const event: RedactableEvent = {
    type: "summary",
    data: {
      httpRequestTotal: 3,
      assertionFailed: 0,
    },
  };
  const redacted = redactEvent(engine, event);
  expect(redacted).toBe(event);
});

test("adapter: start event passes through unchanged", () => {
  const engine = createEngine();
  const event: RedactableEvent = {
    type: "start",
    id: "test-1",
    name: "My Test",
  };
  const redacted = redactEvent(engine, event);
  expect(redacted).toBe(event);
});

test("adapter: does not mutate original event", () => {
  const engine = createEngine();
  const original: RedactableEvent = {
    type: "log",
    message: "Email: user@example.com",
  };
  const messageBefore = original.message;
  redactEvent(engine, original);
  expect(original.message).toBe(messageBefore);
});

// ═══════════════════════════════════════════════════════════════════════════
// Adapter: scope gating in trace events
// ═══════════════════════════════════════════════════════════════════════════

test("adapter: disabled requestHeaders scope skips header redaction", () => {
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
  const data = (redacted as Record<string, unknown>).data as Record<string, unknown>;
  const reqHeaders = data.requestHeaders as Record<string, unknown>;
  expect(reqHeaders.authorization).toBe("Bearer secret");
  const resBody = data.responseBody as Record<string, unknown>;
  expect(resBody.token).toBe("****");
});

// ═══════════════════════════════════════════════════════════════════════════
// genericPartialMask utility
// ═══════════════════════════════════════════════════════════════════════════

test("genericPartialMask: short string (<=4)", () => {
  expect(genericPartialMask("abc")).toBe("****");
  expect(genericPartialMask("abcd")).toBe("****");
});

test("genericPartialMask: medium string (5-8)", () => {
  expect(genericPartialMask("abcde")).toBe("ab***e");
  expect(genericPartialMask("abcdefgh")).toBe("ab***h");
});

test("genericPartialMask: long string (>8)", () => {
  expect(genericPartialMask("abcdefghi")).toBe("abc***ghi");
  expect(genericPartialMask("a]very-long-string")).toBe("a]v***ing");
});

// ═══════════════════════════════════════════════════════════════════════════
// Custom patterns
// ═══════════════════════════════════════════════════════════════════════════

test("custom pattern: detects user-defined regex", () => {
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
  expect(result.value).toBe("Key: nba***789");
});

test("custom pattern: invalid regex is skipped", () => {
  const config: RedactionConfig = {
    ...DEFAULT_CONFIG,
    patterns: {
      ...DEFAULT_CONFIG.patterns,
      custom: [{ name: "bad", regex: "[invalid" }],
    },
  };
  const engine = new RedactionEngine({
    config,
    plugins: createBuiltinPlugins(config),
  });
  const result = engine.redact("hello world");
  expect(result.value).toBe("hello world");
});

// ═══════════════════════════════════════════════════════════════════════════
// Details tracking
// ═══════════════════════════════════════════════════════════════════════════

test("details: tracks redacted fields with path and plugin", () => {
  const engine = createEngine();
  const result = engine.redact({
    headers: { authorization: "Bearer abc" },
    body: "user@example.com",
  });
  expect(result.redacted).toBe(true);
  const keyDetail = result.details.find(
    (d) => d.path === "headers.authorization",
  );
  expect(keyDetail?.plugin).toBe("sensitive-keys");

  const emailDetail = result.details.find((d) => d.path === "body");
  expect(emailDetail?.plugin).toBe("email");
});
