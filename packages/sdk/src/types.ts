// =============================================================================
// Error Types
// =============================================================================

/**
 * Error thrown when a required variable or secret is missing or fails validation.
 *
 * @example
 * ```ts
 * try {
 *   const baseUrl = ctx.vars.require("BASE_URL");
 * } catch (err) {
 *   if (err instanceof GlubeanValidationError) {
 *     ctx.log(`Missing ${err.type}: ${err.key}`);
 *   }
 * }
 * ```
 */
export class GlubeanValidationError extends Error {
  constructor(
    /** The key that was being accessed (e.g., "API_KEY") */
    public readonly key: string,
    /** The error message */
    message: string,
    /** Whether this is a variable or secret */
    public readonly type: "var" | "secret",
  ) {
    super(`Invalid ${type} "${key}": ${message}`);
    this.name = "GlubeanValidationError";
  }
}

/**
 * Error thrown when a test is dynamically skipped.
 *
 * @example
 * ```ts
 * if (!ctx.vars.get("FEATURE_FLAG")) {
 *   ctx.skip("Feature not enabled");
 * }
 * ```
 */
export class GlubeanSkipError extends Error {
  constructor(
    /** Optional reason for skipping */
    public readonly reason?: string,
  ) {
    super(reason ? `Test skipped: ${reason}` : "Test skipped");
    this.name = "GlubeanSkipError";
  }
}

/**
 * Validator function for require() method.
 *
 * Return values:
 * - `true` or `undefined` or `null`: validation passed
 * - `false`: validation failed (generic error)
 * - `string`: validation failed with custom error message
 *
 * @example
 * // Simple boolean validation
 * (v) => v.length >= 16
 *
 * // With custom error message
 * (v) => v.length >= 16 ? true : `must be at least 16 characters, got ${v.length}`
 *
 * // Alternative style
 * (v) => {
 *   if (!v.startsWith("https://")) return "must start with https://";
 *   if (!v.includes(".")) return "must be a valid URL";
 * }
 */
export type ValidatorFn = (value: string) => boolean | string | void | null;

/**
 * Provides safe access to environment variables for a test run.
 * Use for non-sensitive configuration such as URLs, ports, regions, and feature flags.
 *
 * **For credentials (API keys, tokens, passwords), use {@link SecretsAccessor | ctx.secrets} instead.**
 * Secrets are loaded from `.secrets` files, automatically redacted in traces, and never
 * appear in logs or dashboards.
 *
 * Use `require` when a value must exist to avoid silent failures.
 *
 * @example
 * const baseUrl = ctx.vars.require("BASE_URL");
 * const port = ctx.vars.require("PORT", (v) => !isNaN(Number(v)));
 */
export interface VarsAccessor {
  /**
   * Returns the value if present, otherwise undefined.
   *
   * @example
   * const region = ctx.vars.get("REGION") ?? "us-east-1";
   */
  get(key: string): string | undefined;

  /**
   * Returns the value or throws a clear error if missing or invalid.
   * Optionally accepts a validator function for custom validation.
   *
   * @param key - The variable key to retrieve
   * @param validate - Optional validator function. Return false or error string if invalid.
   *
   * @example Basic usage
   * const baseUrl = ctx.vars.require("BASE_URL");
   *
   * @example With boolean validation
   * const port = ctx.vars.require("PORT", (v) => !isNaN(Number(v)));
   *
   * @example With custom error message
   * const endpoint = ctx.vars.require("CALLBACK_URL", (v) =>
   *   v.startsWith("https://") ? true : "must start with https://"
   * );
   */
  require(key: string, validate?: ValidatorFn): string;

  /**
   * Returns a copy of all vars for diagnostics or logging.
   * Vars contain only non-sensitive config, so this is safe to log.
   *
   * @example
   * ctx.log("Config", ctx.vars.all());
   */
  all(): Record<string, string>;
}

/**
 * Provides safe access to secrets (API keys, tokens, passwords) for a test run.
 *
 * Secrets are loaded from `.secrets` files, automatically redacted in traces
 * and logs, and never appear in dashboards. Use `require` when a secret must
 * exist to avoid silent failures.
 *
 * **For non-sensitive config (URLs, ports, flags), use {@link VarsAccessor | ctx.vars} instead.**
 *
 * @example
 * const apiKey = ctx.secrets.require("API_KEY");
 * const token = ctx.secrets.require("JWT", (v) => v.split(".").length === 3);
 */
export interface SecretsAccessor {
  /**
   * Returns the secret value if present, otherwise undefined.
   *
   * @example
   * const token = ctx.secrets.get("REFRESH_TOKEN");
   */
  get(key: string): string | undefined;

  /**
   * Returns the secret value or throws a clear error if missing or invalid.
   * Optionally accepts a validator function for custom validation.
   *
   * @param key - The secret key to retrieve
   * @param validate - Optional validator function. Return false or error string if invalid.
   *
   * @example Basic usage
   * const apiKey = ctx.secrets.require("API_KEY");
   *
   * @example With custom error message
   * const key = ctx.secrets.require("API_KEY", (v) =>
   *   v.startsWith("sk-") ? true : "must start with 'sk-'"
   * );
   */
  require(key: string, validate?: ValidatorFn): string;
}

/**
 * Key-value store shared across all tests in a run.
 * Values are set during session setup (`session.ts`) and readable by all test files.
 *
 * **Current guarantees (sequential mode):**
 * - Setup values are available to all test files
 * - Within-file writes via `set()` are immediate
 * - Cross-file writes propagate in sequential execution order
 * - `set()` emits an internal control event (not visible in timeline or uploaded data)
 *
 * **Not yet supported:**
 * - Parallel visibility guarantees (requires `dependsOn` scheduling)
 *
 * All values must be strings — use `JSON.stringify()`/`JSON.parse()` for objects.
 *
 * @example Reading session values in a test
 * ```ts
 * const token = ctx.session.require("token");
 * const userId = ctx.session.get("userId");
 * ```
 *
 * @example Writing session values (sequential propagation)
 * ```ts
 * ctx.session.set("orderId", createdOrder.id);
 * ```
 */
export interface SessionAccessor {
  /** Returns the value if present, otherwise undefined. */
  get<T = unknown>(key: string): T | undefined;

  /** Returns the value or throws if missing. */
  require<T = unknown>(key: string): T;

  /** Sets a session value. Must be JSON-serializable. Available to subsequent tests. */
  set(key: string, value: unknown): void;

  /** Returns all session key-value pairs. */
  entries(): Record<string, unknown>;
}

/**
 * The context passed to session setup/teardown functions.
 * Has access to vars, secrets, http, session, and logging — but no assertions.
 */
export interface SessionSetupContext {
  vars: VarsAccessor;
  secrets: SecretsAccessor;
  http: HttpClient;
  session: SessionAccessor;
  log(message: string, data?: unknown): void;

  /**
   * Whether the user explicitly opted into interactive mode (`--include-browser`).
   *
   * Use this to branch session setup logic:
   * - `true`: user is present, browser flows are allowed (real OAuth, etc.)
   * - `false` (default): headless mode, use dev-bypass or static tokens
   *
   * This is driven by the same `--include-browser` CLI flag that controls
   * `requires: "browser"` case skip behavior — one flag, one signal.
   */
  interactive: boolean;
}

/**
 * Definition for a session setup/teardown lifecycle.
 *
 * @example
 * ```ts
 * import { defineSession } from "@glubean/sdk";
 *
 * export default defineSession({
 *   async setup(ctx) {
 *     const { access_token } = await ctx.http
 *       .post("/auth/login", { json: { user: ctx.vars.require("USER"), pass: ctx.secrets.require("PASS") } })
 *       .json();
 *     ctx.session.set("token", access_token);
 *   },
 *   async teardown(ctx) {
 *     await ctx.http.post("/auth/logout", {
 *       headers: { Authorization: `Bearer ${ctx.session.get("token")}` },
 *     });
 *   },
 * });
 * ```
 */
export interface SessionDefinition {
  setup: (ctx: SessionSetupContext) => Promise<void>;
  teardown?: (ctx: SessionSetupContext) => Promise<void>;
}

/**
 * The context passed to every test function.
 * Provides access to environment variables, secrets, logging, assertions, API tracing,
 * and a pre-configured HTTP client.
 *
 * @example Typical test using ctx
 * ```ts
 * export const getUsers = test("get-users", async (ctx) => {
 *   const baseUrl = ctx.vars.require("BASE_URL");
 *   const apiKey = ctx.secrets.require("API_KEY");
 *
 *   const res = await ctx.http.get(`${baseUrl}/users`, {
 *     headers: { Authorization: `Bearer ${apiKey}` },
 *   });
 *   ctx.expect(res).toHaveStatus(200);
 *
 *   const body = await res.json();
 *   ctx.expect(body.users).toHaveLength(10);
 * });
 * ```
 *
 * @example Anti-pattern: don't use vars for credentials
 * ```ts
 * // ❌ BAD: credential in vars — visible in traces and dashboards
 * const apiKey = ctx.vars.require("API_KEY");
 *
 * // ✅ GOOD: credential in secrets — auto-redacted in traces
 * const apiKey = ctx.secrets.require("API_KEY");
 * ```
 */
export interface TestContext {
  /** Environment variables accessor (e.g., BASE_URL) */
  vars: VarsAccessor;
  /** Secrets accessor (e.g., API_KEY) - injected securely */
  secrets: SecretsAccessor;
  /** Session state shared across all tests in a run. Set in session.ts setup, readable everywhere. */
  session: SessionAccessor;

  /**
   * Pre-configured HTTP client with auto-tracing, auto-metrics, and retry.
   * Powered by ky. Every request automatically records:
   * - API trace via `ctx.trace()` (method, URL, status, duration)
   * - Metric `http_duration_ms` via `ctx.metric()` (with method and path tags)
   *
   * Can be called directly or via method shortcuts.
   *
   * @example GET request
   * ```ts
   * const users = await ctx.http.get(`${baseUrl}/users`).json();
   * ```
   *
   * @example POST with JSON body
   * ```ts
   * const user = await ctx.http.post(`${baseUrl}/users`, {
   *   json: { name: "test" },
   * }).json();
   * ```
   *
   * @example With retry
   * ```ts
   * const data = await ctx.http.get(`${baseUrl}/flaky`, { retry: 3 }).json();
   * ```
   *
   * @example Callable shorthand (same as ky(url, options))
   * ```ts
   * const res = await ctx.http(`${baseUrl}/users`);
   * ```
   *
   * @example Create scoped client with shared config
   * ```ts
   * const api = ctx.http.extend({
   *   prefixUrl: baseUrl,
   *   headers: { Authorization: `Bearer ${token}` },
   * });
   * const users = await api.get("users").json();
   * ```
   */
  http: HttpClient;

  /**
   * Logging function - streams to runner stdout.
   * @example ctx.log("User created", { id: 123 })
   */
  log(message: string, data?: unknown): void;

  /**
   * Low-level assertion — records a pass/fail event in the test trace.
   *
   * **Always provide a descriptive `message`** that explains *what* is being
   * checked and *why* it matters. Generic messages like `"status check"` are
   * unhelpful in dashboards, CI logs, and MCP tool output. Good messages read
   * like a sentence: `"GET /users should return 200"`.
   *
   * Prefer `ctx.expect` for most assertions (fluent, auto-generates actual/expected).
   * Use `ctx.assert` when you need a simple boolean guard with a custom message.
   *
   * Overload 1: Simple boolean check
   *
   * @example Good — descriptive message
   * ```ts
   * ctx.assert(res.ok, "GET /users should return 2xx");
   * ctx.assert(body.items.length > 0, "Response should contain at least one item");
   * ctx.assert(res.status === 200, "Create user status", { actual: res.status, expected: 200 });
   * ```
   *
   * @example Bad — vague message (avoid)
   * ```ts
   * ctx.assert(res.ok); // no message at all
   * ctx.assert(res.ok, "check"); // too vague
   * ```
   */
  assert(
    condition: boolean,
    message?: string,
    details?: AssertionDetails,
  ): void;

  /**
   * Low-level assertion — records a pass/fail event in the test trace.
   *
   * Overload 2: Explicit result object (useful for complex logic).
   *
   * @example
   * ```ts
   * ctx.assert(
   *   { passed: res.status === 200, actual: res.status, expected: 200 },
   *   "POST /orders should return 200",
   * );
   * ```
   */
  assert(result: AssertionResultInput, message?: string): void;

  /**
   * Fluent assertion API — Jest/Vitest style.
   *
   * **Soft-by-default**: failed assertions are recorded but do NOT throw.
   * All assertions run and all failures are collected.
   *
   * Use `.orFail()` to guard assertions where subsequent code depends on the result.
   * Use `.not` to negate any assertion.
   *
   * **Assertion messages**: Every matcher accepts an optional `message` string as
   * its **last argument**. When provided, it is prepended to the auto-generated
   * message, making failures far more actionable in Trace Viewer, CI, and MCP output.
   *
   * **Always pass a message** that describes the request or business context —
   * e.g. `"GET /users status"`, `"created order id"`, `"auth token format"`.
   *
   * @example With descriptive messages (recommended)
   * ```ts
   * ctx.expect(res.status).toBe(200, "GET /users status");
   * // on failure → "GET /users status: expected 401 to be 200"
   *
   * ctx.expect(body.items).toHaveLength(3, "search result count");
   * ctx.expect(res).toHaveHeader("content-type", /json/, "response content type");
   * ```
   *
   * @example Guard — abort if this fails
   * ```ts
   * ctx.expect(res.status).toBe(200, "POST /orders").orFail();
   * const body = await res.json(); // safe — status was 200
   * ```
   *
   * @example Without message (still works, less readable in reports)
   * ```ts
   * ctx.expect(res.status).toBe(200);
   * ctx.expect(body.name).toBeType("string");
   * ```
   *
   * @example Negation
   * ```ts
   * ctx.expect(body.banned).not.toBe(true, "user should not be banned");
   * ```
   *
   * @example HTTP-specific
   * ```ts
   * ctx.expect(res).toHaveStatus(200, "GET /users");
   * ctx.expect(res).toHaveHeader("content-type", /json/, "content type");
   * ```
   */
  expect<V>(actual: V): import("./expect.js").Expectation<V>;

  /**
   * Soft check — records a warning but never affects test pass/fail.
   *
   * Use `ctx.warn` for "should" conditions that are not hard requirements.
   * Same mental model as `ctx.assert`: `condition=true` means OK, `condition=false` triggers a warning.
   *
   * - `assert` = **must** (failure = test fails)
   * - `warn` = **should** (failure = recorded but test still passes)
   *
   * @param condition `true` if OK, `false` triggers warning
   * @param message Human-readable description
   *
   * @example Performance budget
   * ```ts
   * ctx.warn(duration < 500, "Response should be under 500ms");
   * ```
   *
   * @example Best practice check
   * ```ts
   * ctx.warn(res.headers.has("cache-control"), "Should have cache headers");
   * ```
   *
   * @example HTTPS check
   * ```ts
   * ctx.warn(avatarUrl.startsWith("https"), "Avatar should use HTTPS");
   * ```
   */
  warn(condition: boolean, message: string): void;

  /**
   * Validate data against a schema (Zod, Valibot, or any `SchemaLike<T>`).
   *
   * The runner prefers `safeParse` (no-throw) and falls back to `parse` (try/catch).
   * Returns the parsed value on success, or `undefined` on failure.
   *
   * **Severity controls what happens on failure:**
   * - `"error"` (default) — counts as a failed assertion (test fails)
   * - `"warn"` — recorded as warning only (test still passes)
   * - `"fatal"` — immediately aborts test execution
   *
   * A `schema_validation` event is always emitted regardless of severity.
   *
   * @param data The data to validate
   * @param schema A schema implementing `safeParse` or `parse`
   * @param label Human-readable label (e.g., "response body", "query params")
   * @param options Severity and other options
   * @returns Parsed value on success, `undefined` on failure
   *
   * @example Default severity (error — counts as assertion failure)
   * ```ts
   * const user = ctx.validate(body, UserSchema, "response body");
   * ```
   *
   * @example Warning only — record but don't fail
   * ```ts
   * ctx.validate(body, StrictSchema, "strict contract", { severity: "warn" });
   * ```
   *
   * @example Fatal — abort test on invalid response
   * ```ts
   * const user = ctx.validate(body, UserSchema, "response body", { severity: "fatal" });
   * // Only reached if validation passed
   * ```
   */
  validate<T>(
    data: unknown,
    schema: SchemaLike<T>,
    label?: string,
    options?: ValidateOptions,
  ): T | undefined;

  /**
   * Report a protocol trace (HTTP, gRPC, WebSocket, etc.).
   * HTTP traces are auto-emitted by `ctx.http` — use this directly for
   * non-HTTP protocols or custom instrumentation.
   * @example ctx.trace({ protocol: "http", target: "GET /users", status: 200, durationMs: 100, ok: true })
   */
  trace(request: Trace): void;

  /**
   * Record a structured action to the test timeline.
   *
   * Actions are the primary unit of test observability. Every plugin interaction
   * — browser click, API call, MCP tool invocation, DB query — should be
   * recorded as an action.
   *
   * Actions appear in the Glubean dashboard timeline, are filterable by category,
   * searchable by target, and aggregatable for trend analysis.
   *
   * @example Browser click
   * ```ts
   * ctx.action({
   *   category: "browser:click",
   *   target: "#submit-btn",
   *   duration: 50,
   *   status: "ok",
   * });
   * ```
   *
   * @example MCP tool call
   * ```ts
   * ctx.action({
   *   category: "mcp:tool-call",
   *   target: "get_weather",
   *   duration: 300,
   *   status: "ok",
   *   detail: { args: { location: "Tokyo" } },
   * });
   * ```
   */
  action(a: GlubeanAction): void;

  /**
   * Emit a structured event with arbitrary payload.
   *
   * Use `ctx.event()` for structured data that doesn't fit the action model
   * (no target/duration/status) but is more than a log message. Events are
   * renderable by plugin-provided custom renderers in the dashboard.
   *
   * The distinction:
   * - `ctx.log()` — text for humans reading logs
   * - `ctx.event()` — structured data for machines/dashboard renderers
   * - `ctx.action()` — typed interaction record for timeline/waterfall/filter
   *
   * @example Screenshot captured
   * ```ts
   * ctx.event({
   *   type: "browser:screenshot",
   *   data: { path: "/screenshots/after-login.png", fullPage: true, sizeKb: 142 },
   * });
   * ```
   *
   * @example MCP server connected
   * ```ts
   * ctx.event({
   *   type: "mcp:connected",
   *   data: { server: "weather-api", transport: "stdio", tools: ["get_weather"] },
   * });
   * ```
   */
  event(ev: GlubeanEvent): void;

  /**
   * Report a numeric metric for performance tracking and trending.
   *
   * Metrics are stored separately from logs/traces with longer retention (90 days)
   * and are optimized for time-series queries and dashboards.
   *
   * Security note: metric names and tags are observable metadata and are not
   * intended to carry secrets or PII. Never include tokens, API keys, emails,
   * phone numbers, or user identifiers in `name` / `options.tags`.
   *
   * @param name Metric name (e.g., "api_duration_ms", "response_size_bytes")
   * @param value Numeric value
   * @param options Optional unit and tags
   *
   * @example Basic usage
   * ```ts
   * ctx.metric("api_duration_ms", Date.now() - start);
   * ```
   *
   * @example With unit
   * ```ts
   * ctx.metric("response_size", body.length, { unit: "bytes" });
   * ```
   *
   * @example Server-side duration from response
   * ```ts
   * const data = await res.json();
   * ctx.metric("server_processing_ms", data.processing_time, { unit: "ms" });
   * ctx.metric("route_count", data.result.summary.routes, { unit: "count" });
   * ```
   *
   * @example With tags for slicing in dashboards
   * ```ts
   * ctx.metric("latency_ms", duration, {
   *   unit: "ms",
   *   tags: { endpoint: "/api/v2/optimize", method: "POST" },
   * });
   * ```
   *
   * @example Anti-pattern (do not do this)
   * ```ts
   * // Bad: secret data embedded in metric dimensions
   * ctx.metric("token_check", 1, { tags: { token: ctx.secrets.require("API_KEY") } });
   * ```
   */
  metric(name: string, value: number, options?: MetricOptions): void;

  /**
   * Dynamically skip the current test.
   * Throws a GlubeanSkipError that is caught by the runner.
   *
   * @param reason Optional reason for skipping
   *
   * @example Skip based on feature flag
   * ```ts
   * if (!ctx.vars.get("FEATURE_ENABLED")) {
   *   ctx.skip("Feature not enabled in this environment");
   * }
   * ```
   *
   * @example Skip if API key is missing
   * ```ts
   * const apiKey = ctx.secrets.get("API_KEY");
   * if (!apiKey) {
   *   ctx.skip("API_KEY not configured");
   * }
   * ```
   */
  skip(reason?: string): never;

  /**
   * Immediately fail and abort the current test.
   * Unlike `ctx.assert(false, msg)` which records a failure but continues,
   * `ctx.fail()` throws and stops execution immediately.
   *
   * Use this when execution reaches a point that should be unreachable,
   * or when a request unexpectedly succeeds and the test should abort.
   *
   * @param message Reason for the failure
   *
   * @example Fail if a request that should error succeeds
   * ```ts
   * const res = await ctx.http.delete(`${ctx.vars.require("BASE_URL")}/protected`, {
   *   throwHttpErrors: false,
   * });
   * if (res.ok) {
   *   ctx.fail("Expected 403 but request succeeded");
   * }
   * ctx.expect(res.status).toBe(403);
   * ```
   *
   * @example Guard against unreachable code
   * ```ts
   * if (status === "deleted") {
   *   ctx.fail("Resource should not be deleted at this point");
   * }
   * ```
   */
  fail(message: string): never;

  /**
   * Poll a function repeatedly until it returns a truthy value or times out.
   * Useful for eventually-consistent systems where state takes time to converge.
   *
   * **Behavior:**
   * - Calls `fn()` every `intervalMs` (default 1000ms)
   * - If `fn()` returns truthy → resolves immediately
   * - If `fn()` returns falsy → waits and retries
   * - If `fn()` throws → captures error, waits and retries
   * - If `timeoutMs` exceeded and no `onTimeout` → throws Error (test fails)
   * - If `timeoutMs` exceeded and `onTimeout` present → calls `onTimeout`, returns without throwing
   *
   * @param options Polling configuration
   * @param fn Async function to poll. Return truthy to stop.
   *
   * @example Wait for resource to be ready (timeout = test failure)
   * ```ts
   * await ctx.pollUntil({ timeoutMs: 30_000 }, async () => {
   *   const res = await ctx.http.get(`${baseUrl}/status`);
   *   return res.ok;
   * });
   * ```
   *
   * @example Silent timeout — log but don't fail
   * ```ts
   * await ctx.pollUntil(
   *   {
   *     timeoutMs: 5_000,
   *     intervalMs: 500,
   *     onTimeout: (err) => {
   *       ctx.log(`Webhook not received: ${err?.message ?? "timeout"}`);
   *     },
   *   },
   *   async () => {
   *     const hooks = await ctx.http.get(`${baseUrl}/webhooks`).json();
   *     return hooks.length > 0;
   *   }
   * );
   * ```
   */
  pollUntil(
    options: PollUntilOptions,
    fn: () => Promise<boolean | unknown>,
  ): Promise<void>;

  /**
   * Dynamically set the timeout for the current test.
   * Must be called before any async operations.
   *
   * Semantics: this updates the remaining runtime budget from the moment
   * `setTimeout()` is called (relative deadline), not from test start time.
   *
   * @param ms Timeout in milliseconds
   *
   * @example Increase timeout for slow endpoint
   * ```ts
   * ctx.setTimeout(60000); // 60 seconds
   * const res = await ctx.http.get(ctx.vars.require("SLOW_API_URL"));
   * ```
   *
   * @example Set timeout based on environment
   * ```ts
   * const isProd = ctx.vars.get("ENV") === "production";
   * ctx.setTimeout(isProd ? 30000 : 10000);
   * ```
   */
  setTimeout(ms: number): void;

  /**
   * Current execution retry count (0 for first attempt, 1+ for re-runs).
   *
   * Retry orchestration is owned by the runner/control plane, not by SDK user
   * code. `ctx.retryCount` is injected into context at execution start and is
   * read-only inside the test.
   *
   * Important distinction:
   * - `ctx.retryCount` tracks whole-test re-runs.
   * - Step retries from `StepMeta.retries` happen within one execution and do
   *   not increment `ctx.retryCount`.
   *
   * Useful for logging, backoff, or idempotency behavior on re-runs.
   *
   * @example Log retry attempts
   * ```ts
   * if (ctx.retryCount > 0) {
   *   ctx.log(`Retry attempt ${ctx.retryCount}`);
   * }
   * ```
   *
   * @example Different behavior on retry
   * ```ts
   * const timeout = ctx.retryCount === 0 ? 5000 : 10000;
   * const res = await ctx.http.get(url, { timeout });
   * ```
   */
  readonly retryCount: number;

  /**
   * Get current memory usage statistics.
   * Returns null if not available in the current runtime.
   * Useful for debugging memory issues and profiling tests locally.
   *
   * @returns Memory usage stats or null if not available
   *
   * @example Log current memory usage
   * ```ts
   * const mem = ctx.getMemoryUsage();
   * if (mem) {
   *   ctx.log(`Heap used: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
   *   ctx.log(`Heap total: ${(mem.heapTotal / 1024 / 1024).toFixed(2)} MB`);
   * }
   * ```
   *
   * @example Track memory delta
   * ```ts
   * const before = ctx.getMemoryUsage();
   * // ... perform memory-intensive operation
   * const after = ctx.getMemoryUsage();
   * if (before && after) {
   *   const delta = (after.heapUsed - before.heapUsed) / 1024 / 1024;
   *   ctx.log(`Memory delta: ${delta.toFixed(2)} MB`);
   * }
   * ```
   */
  getMemoryUsage(): {
    /** Heap memory currently used (bytes) */
    heapUsed: number;
    /** Total heap memory allocated (bytes) */
    heapTotal: number;
    /** Memory used by C++ objects bound to JS (bytes) */
    external: number;
    /** Resident set size - total memory allocated for the process (bytes) */
    rss: number;
  } | null;
}

// =============================================================================
// Configure API Types
// =============================================================================

/**
 * Options for the `configure()` function.
 *
 * Declares file-level dependencies on vars, secrets, and HTTP client
 * configuration. All declared vars and secrets are **required** — if missing
 * at runtime, the test fails immediately with a clear error.
 *
 * For optional vars, use `ctx.vars.get()` directly inside the test function
 * instead of declaring them in `configure()`.
 *
 * @example
 * ```ts
 * const { vars, secrets, http } = configure({
 *   vars: { baseUrl: "BASE_URL", orgId: "ORG_ID" },
 *   secrets: { apiKey: "API_KEY" },
 *   http: {
 *     prefixUrl: "BASE_URL",
 *     headers: { Authorization: "Bearer {{API_KEY}}" },
 *   },
 * });
 * ```
 */
export interface ConfigureOptions {
  /**
   * Map of friendly property names to var keys.
   * Each key becomes a property on the returned `vars` object.
   * All declared vars are **required** — missing values throw at runtime.
   *
   * @example
   * ```ts
   * const { vars } = configure({
   *   vars: { baseUrl: "BASE_URL", orgId: "ORG_ID" },
   * });
   * vars.baseUrl; // string (required, never undefined)
   * ```
   */
  vars?: Record<string, string>;

  /**
   * Map of friendly property names to secret keys.
   * Each key becomes a property on the returned `secrets` object.
   * All declared secrets are **required** — missing values throw at runtime.
   *
   * @example
   * ```ts
   * const { secrets } = configure({
   *   secrets: { apiKey: "API_KEY" },
   * });
   * secrets.apiKey; // string (required, never undefined)
   * ```
   */
  secrets?: Record<string, string>;

  /**
   * Pre-configure an HTTP client with shared defaults.
   *
   * - `prefixUrl`: A var key (string) whose runtime value becomes the base URL.
   * - `headers`: Header values can use `{{key}}` syntax to interpolate secrets.
   * - `timeout`, `retry`, `throwHttpErrors`: Passed through to ky.
   *
   * The returned `http` client inherits all `ctx.http` features
   * (auto-tracing, auto-metrics, schema validation) and supports `.extend()`.
   *
   * @example
   * ```ts
   * const { http } = configure({
   *   http: {
   *     prefixUrl: "base_url",
   *     headers: { Authorization: "Bearer {{api_key}}" },
   *   },
   * });
   * // In tests:
   * const res = await http.get("users").json();
   * ```
   */
  http?: ConfigureHttpOptions;

  /**
   * Plugin factories keyed by name.
   * Each plugin is lazily instantiated on first property access during test execution.
   * Use `definePlugin()` to create plugin factories.
   *
   * @example
   * ```ts
   * import { graphql } from "@glubean/graphql";
   *
   * const { http, graphql: gql } = configure({
   *   http: { prefixUrl: "base_url" },
   *   plugins: {
   *     graphql: graphql({
   *       endpoint: "graphql_url",
   *       headers: { Authorization: "Bearer {{api_key}}" },
   *     }),
   *   },
   * });
   * ```
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins?: Record<string, PluginFactory<any>>;

}

/**
 * HTTP configuration for `configure()`.
 *
 * `prefixUrl` is a **var key** (resolved at runtime), not a literal URL.
 * Header values can contain `{{key}}` placeholders that are resolved from
 * the combined vars + secrets at runtime.
 */
export interface ConfigureHttpOptions {
  /**
   * Var key whose runtime value is used as the base URL (ky `prefixUrl`).
   * This is a var key name, not the URL itself.
   *
   * @example "BASE_URL" → resolved to ctx.vars.require("BASE_URL")
   */
  prefixUrl?: string;

  /**
   * Default headers. Values may contain `{{key}}` placeholders that are
   * resolved from vars and secrets at runtime.
   *
   * @example
   * ```ts
   * headers: {
   *   Authorization: "Bearer {{API_KEY}}",
   *   "X-Org-Id": "{{ORG_ID}}",
   * }
   * ```
   */
  headers?: Record<string, string>;

  /**
   * Default query parameters appended to every request.
   * Values may contain `{{key}}` placeholders resolved from vars and secrets.
   *
   * @example API key via query param
   * ```ts
   * searchParams: { key: "{{API_KEY}}" }
   * ```
   */
  searchParams?: Record<string, string>;

  /** Default request timeout in milliseconds. */
  timeout?: number | false;

  /**
   * Default retry configuration.
   * Number for simple retry count, or object for fine-grained control.
   *
   * @example Simple retry count
   * ```ts
   * retry: 3
   * ```
   *
   * @example Fine-grained control
   * ```ts
   * retry: {
   *   limit: 3,
   *   statusCodes: [429, 503],
   *   maxRetryAfter: 5000,
   * }
   * ```
   */
  retry?: number | HttpRetryOptions;

  /** Whether to throw on non-2xx responses (default: true). */
  throwHttpErrors?: boolean;

  /**
   * How to handle HTTP redirects.
   * - `"follow"` (default): automatically follow redirects
   * - `"manual"`: return the 3xx response as-is (useful for testing redirect endpoints)
   * - `"error"`: throw on redirect
   */
  redirect?: "follow" | "manual" | "error";

  /**
   * Hooks for intercepting HTTP request/response lifecycle.
   * Passed through to the underlying ky client.
   *
   * @example OAuth token injection
   * ```ts
   * import { oauth2 } from "@glubean/auth";
   *
   * const { http } = configure({
   *   http: oauth2.clientCredentials({
   *     prefixUrl: "base_url",
   *     tokenUrl: "token_url",
   *     clientId: "client_id",
   *     clientSecret: "client_secret",
   *   }),
   * });
   * ```
   */
  hooks?: HttpHooks;
}

/**
 * Return type of `configure()`.
 *
 * All properties are lazy — values are resolved from the runtime context
 * when first accessed during test execution, not at module load time.
 *
 * @template V Shape of the vars object (inferred from `ConfigureOptions.vars`)
 * @template S Shape of the secrets object (inferred from `ConfigureOptions.secrets`)
 *
 * @example
 * ```ts
 * const { vars, secrets, http } = configure({
 *   vars: { baseUrl: "BASE_URL" },
 *   secrets: { apiKey: "API_KEY" },
 *   http: { prefixUrl: "BASE_URL", headers: { Authorization: "Bearer {{API_KEY}}" } },
 * });
 *
 * export const myTest = test("my-test", async (ctx) => {
 *   ctx.log(`Using ${vars.baseUrl}`);
 *   const res = await http.get("users").json();
 *   ctx.expect(res.length).toBeGreaterThan(0);
 * });
 * ```
 */
export interface ConfigureResult<
  V extends Record<string, string> = Record<string, string>,
  S extends Record<string, string> = Record<string, string>,
> {
  /**
   * Lazy vars accessor. Each property reads from the runtime vars
   * using `require()` semantics — throws if missing.
   */
  vars: Readonly<V>;

  /**
   * Lazy secrets accessor. Each property reads from the runtime secrets
   * using `require()` semantics — throws if missing.
   */
  secrets: Readonly<S>;

  /**
   * Pre-configured HTTP client. Lazily constructed from `ctx.http.extend()`
   * on first use during test execution. Inherits auto-tracing and auto-metrics.
   *
   * Supports further `.extend()` for per-test customization.
   */
  http: HttpClient;
}

// =============================================================================
// Plugin Types
// =============================================================================

/**
 * A plugin factory that creates a lazy instance of type T.
 * Used with `configure({ plugins: { key: factory } })`.
 * Plugin authors should use `definePlugin()` instead of implementing directly.
 *
 * @example
 * ```ts
 * import { definePlugin } from "@glubean/sdk";
 *
 * export const myPlugin = (opts: MyOptions) =>
 *   definePlugin((runtime) => new MyClient(runtime, opts));
 * ```
 */
export interface PluginFactory<T> {
  /** Phantom field for TypeScript inference. Not used at runtime. */
  readonly __type: T;
  /** Called lazily on first access during test execution. */
  create(runtime: GlubeanRuntime): T;
}

/**
 * Metadata about the currently running test.
 *
 * This is exposed to plugins so they can make deterministic decisions
 * based on test identity and tags.
 *
 * @example
 * ```ts
 * definePlugin((runtime) => ({
 *   currentTest: runtime.test?.id ?? "unknown",
 *   tags: runtime.test?.tags ?? [],
 * }));
 * ```
 */
export interface GlubeanRuntimeTestMetadata {
  /** Test ID currently being executed. */
  id: string;
  /** Normalized test tags (always an array). */
  tags: string[];
}

/**
 * Runtime context available to plugin factories.
 * Exposes the same capabilities the harness provides to configure().
 *
 * Stability: fields may be added (minor), but existing field semantics
 * must not change without a major version bump. This is the contract
 * between the SDK and all plugins.
 *
 * @example
 * ```ts
 * definePlugin((runtime) => {
 *   const baseUrl = runtime.requireVar("base_url");
 *   const token = runtime.requireSecret("api_key");
 *   const header = runtime.resolveTemplate("Bearer {{api_key}}");
 *   return new MyClient(baseUrl, header);
 * });
 * ```
 */
export interface GlubeanRuntime {
  /** Resolved vars with env fallback */
  vars: Record<string, string>;
  /** Resolved secrets with env fallback */
  secrets: Record<string, string>;
  /** Pre-configured HTTP client with auto-tracing */
  http: HttpClient;
  /** Metadata of the currently executing test, if available. */
  test?: GlubeanRuntimeTestMetadata;
  /** Require a var (throws if missing) */
  requireVar(key: string): string;
  /** Require a secret (throws if missing) */
  requireSecret(key: string): string;
  /** Resolve {{key}} template placeholders from vars and secrets */
  resolveTemplate(template: string): string;

  /**
   * Record a typed interaction to the test timeline.
   * Available to plugins during initialization and test execution.
   */
  action(a: GlubeanAction): void;

  /**
   * Emit a protocol trace (HTTP, gRPC, WebSocket, etc.).
   * Appears in the test timeline alongside HTTP auto-traces.
   */
  trace(t: Trace): void;

  /**
   * Emit a structured event. For data that doesn't fit the action model
   * but needs to be surfaced in the dashboard with a custom renderer.
   */
  event(ev: GlubeanEvent): void;

  /**
   * Emit a log message. Convenience alias available to plugins
   * without requiring the full TestContext.
   */
  log(message: string, data?: unknown): void;
}

/**
 * Maps plugin factories to their resolved types.
 * Used internally by `configure()` to infer the return type.
 */
export type ResolvePlugins<P> = {
  [K in keyof P]: P[K] extends PluginFactory<infer T> ? T : never;
};

/**
 * Keys reserved by `ConfigureResult` that plugin names must not shadow.
 * Using one of these as a plugin key causes a compile-time error.
 */
export type ReservedConfigureKeys = "vars" | "secrets" | "http";

// =============================================================================
// HTTP Client Types (powered by ky)
// =============================================================================

/**
 * Response object returned when awaiting HTTP client methods.
 * Extends native `Response` with a typed `.json<T>()` method so you can
 * assert on status first, then parse with a type parameter:
 *
 * ```ts
 * const res = await ctx.http.post(url, { json: body });
 * ctx.expect(res).toHaveStatus(200);
 * const data = await res.json<{ id: string }>();
 * ```
 */
export interface HttpResponse extends Response {
  /** Parse response body as JSON with optional type parameter */
  json<T = unknown>(): Promise<T>;
}

/**
 * Promise returned by HTTP client methods.
 * Extends native `Promise<HttpResponse>` with convenience body-parsing methods.
 *
 * @example Chain directly
 * ```ts
 * const users = await ctx.http.get(`${baseUrl}/users`).json<User[]>();
 * ```
 *
 * @example Await first, then parse (for asserting status before body)
 * ```ts
 * const res = await ctx.http.get(`${baseUrl}/users`);
 * ctx.expect(res).toHaveStatus(200);
 * const users = await res.json<User[]>();
 * ```
 */
export interface HttpResponsePromise extends Promise<HttpResponse> {
  /** Parse response body as JSON */
  json<T = unknown>(): Promise<T>;
  /** Parse response body as text */
  text(): Promise<string>;
  /** Parse response body as Blob */
  blob(): Promise<Blob>;
  /** Parse response body as ArrayBuffer */
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Retry configuration for HTTP requests.
 *
 * @example
 * ```ts
 * const res = await ctx.http.get(url, {
 *   retry: { limit: 3, statusCodes: [429, 503] },
 * });
 * ```
 */
export interface HttpRetryOptions {
  /** Number of retry attempts (default: 2) */
  limit?: number;
  /** HTTP methods to retry (default: GET, PUT, HEAD, DELETE, OPTIONS, TRACE) */
  methods?: string[];
  /** HTTP status codes that trigger a retry (default: 408, 413, 429, 500, 502, 503, 504) */
  statusCodes?: number[];
  /** Maximum delay (ms) to wait based on Retry-After header */
  maxRetryAfter?: number;
}

/**
 * Options for HTTP requests.
 *
 * **`ctx.http` is a thin wrapper around [ky](https://github.com/sindresorhus/ky).**
 * All ky options are supported. See https://github.com/sindresorhus/ky#options
 * for the complete reference.
 *
 * **There is no `form` shortcut** — ky (and therefore `ctx.http`) does not have one.
 * Use `body: new URLSearchParams(...)` for `application/x-www-form-urlencoded` data.
 *
 * @example POST with JSON (most common)
 * ```ts
 * const res = await ctx.http.post(url, { json: { name: "test" } });
 * ```
 *
 * @example POST with form-urlencoded data
 * ```ts
 * const res = await ctx.http.post(url, {
 *   body: new URLSearchParams({
 *     grant_type: "client_credentials",
 *     client_id: ctx.secrets.require("CLIENT_ID"),
 *     client_secret: ctx.secrets.require("CLIENT_SECRET"),
 *   }),
 * });
 * ```
 *
 * @example POST with multipart form data
 * ```ts
 * const form = new FormData();
 * form.append("file", new Blob(["content"]), "test.txt");
 * const res = await ctx.http.post(url, { body: form });
 * ```
 *
 * @example With search params and timeout
 * ```ts
 * ctx.http.get(url, {
 *   searchParams: { page: 1, limit: 10 },
 *   timeout: 5000,
 * });
 * ```
 */
export interface HttpRequestOptions {
  /** JSON body (automatically serialized and sets Content-Type) */
  json?: unknown;
  /** URL search parameters */
  searchParams?:
    | Record<string, string | number | boolean>
    | URLSearchParams
    | string;
  /** Request headers */
  headers?: Record<string, string> | Headers;
  /** Request timeout in milliseconds (default: 10000). Set `false` to disable. */
  timeout?: number | false;
  /** Retry configuration. Number for simple retry count, or object for fine-grained control. */
  retry?: number | HttpRetryOptions;
  /** Base URL prefix (prepended to the request URL) */
  prefixUrl?: string | URL;
  /** Whether to throw on non-2xx responses (default: true) */
  throwHttpErrors?: boolean;
  /** HTTP method override */
  method?: string;
  /**
   * Request body for non-JSON payloads.
   *
   * - `new URLSearchParams(...)` for `application/x-www-form-urlencoded`
   * - `new FormData()` for `multipart/form-data`
   * - `string` or `Blob` for raw payloads
   *
   * Do **not** use `json` and `body` together — `json` takes precedence.
   */
  body?: BodyInit;
  /** AbortSignal for request cancellation */
  signal?: AbortSignal;
  /** Hooks for request/response interception */
  hooks?: HttpHooks;
  /**
   * Schema validation for request and response.
   *
   * Schemas are validated automatically:
   * - `query` and `request` — validated before the request is sent
   * - `response` — validated after the response is received
   *
   * Each entry can be a bare schema (severity defaults to `"error"`)
   * or `{ schema, severity }` for explicit control.
   *
   * @example
   * ```ts
   * const res = await ctx.http.post(url, {
   *   json: payload,
   *   schema: {
   *     request: RequestBodySchema,
   *     response: ResponseSchema,
   *     query: { schema: QuerySchema, severity: "warn" },
   *   },
   * });
   * ```
   */
  schema?: HttpSchemaOptions;
}

/**
 * Hooks for intercepting HTTP request/response lifecycle.
 *
 * @example Log all requests
 * ```ts
 * const api = ctx.http.extend({
 *   hooks: {
 *     beforeRequest: [(request) => {
 *       ctx.log(`→ ${request.method} ${request.url}`);
 *     }],
 *   },
 * });
 * ```
 */
export interface HttpHooks {
  /** Called before each request. Can modify or replace the request. */
  beforeRequest?: Array<
    (
      request: Request,
      options: HttpRequestOptions,
    ) => Request | Response | void | Promise<Request | Response | void>
  >;
  /** Called after each response. Can modify or replace the response. */
  afterResponse?: Array<
    (
      request: Request,
      options: HttpRequestOptions,
      response: Response,
    ) => Response | void | Promise<Response | void>
  >;
  /** Called before each retry attempt. */
  beforeRetry?: Array<
    (details: {
      request: Request;
      options: HttpRequestOptions;
      error: Error;
      retryCount: number;
    }) => void | Promise<void>
  >;
}

/**
 * HTTP client interface powered by ky.
 *
 * Pre-configured with auto-tracing and auto-metrics.
 * Every request automatically records:
 * - API trace: method, URL, status, duration (via `ctx.trace()`)
 * - Metric: `http_duration_ms` with method and path tags (via `ctx.metric()`)
 *
 * Supports ky features: retry, timeout, hooks, JSON shortcuts, and `.extend()`.
 *
 * @example
 * ```ts
 * // Method shortcuts
 * const users = await ctx.http.get(`${baseUrl}/users`).json();
 * const created = await ctx.http.post(`${baseUrl}/users`, { json: { name: "test" } }).json();
 *
 * // Callable shorthand
 * const res = await ctx.http(`${baseUrl}/users`);
 *
 * // Create scoped client
 * const api = ctx.http.extend({ prefixUrl: baseUrl });
 * const user = await api.get("users/1").json();
 * ```
 */
export interface HttpClient {
  /** Make a request (generic). Same as ky(url, options). */
  (
    url: string | URL | Request,
    options?: HttpRequestOptions,
  ): HttpResponsePromise;

  /** HTTP GET request */
  get(
    url: string | URL | Request,
    options?: HttpRequestOptions,
  ): HttpResponsePromise;

  /** HTTP POST request */
  post(
    url: string | URL | Request,
    options?: HttpRequestOptions,
  ): HttpResponsePromise;

  /** HTTP PUT request */
  put(
    url: string | URL | Request,
    options?: HttpRequestOptions,
  ): HttpResponsePromise;

  /** HTTP PATCH request */
  patch(
    url: string | URL | Request,
    options?: HttpRequestOptions,
  ): HttpResponsePromise;

  /** HTTP DELETE request */
  delete(
    url: string | URL | Request,
    options?: HttpRequestOptions,
  ): HttpResponsePromise;

  /** HTTP HEAD request */
  head(
    url: string | URL | Request,
    options?: HttpRequestOptions,
  ): HttpResponsePromise;

  /**
   * Create a new HTTP client instance with merged defaults.
   * The new instance inherits auto-tracing and auto-metrics.
   *
   * @example Scoped client with base URL and auth
   * ```ts
   * const api = ctx.http.extend({
   *   prefixUrl: ctx.vars.require("BASE_URL"),
   *   headers: { Authorization: `Bearer ${ctx.secrets.require("API_TOKEN")}` },
   * });
   * const users = await api.get("users").json();
   * const user = await api.get("users/1").json();
   * ```
   */
  extend(options: HttpRequestOptions): HttpClient;
}

// =============================================================================
// Schema Validation Types
// =============================================================================

/**
 * Protocol interface for any schema library (Zod, Valibot, ArkType, etc.).
 *
 * A schema is `SchemaLike<T>` if it implements **at least** `.safeParse()`.
 * If only `.parse()` is available it is also accepted (the runner wraps it in try/catch).
 *
 * @example Zod
 * ```ts
 * import { z } from "zod";
 * const UserSchema = z.object({ id: z.number(), name: z.string() });
 * // z.ZodType satisfies SchemaLike<T> out of the box
 * ```
 *
 * @example Custom schema
 * ```ts
 * const MySchema: SchemaLike<User> = {
 *   safeParse(data) {
 *     if (isValid(data)) return { success: true, data };
 *     return { success: false, error: { issues: [{ message: "invalid" }] } };
 *   },
 * };
 * ```
 */
export interface SchemaLike<T> {
  /** Preferred — returns a result object without throwing. */
  safeParse?: (data: unknown) =>
    | { success: true; data: T; [key: string]: unknown }
    | {
        success: false;
        error: {
          issues: ReadonlyArray<{
            message: string;
            path?: ReadonlyArray<PropertyKey>;
          }>;
        };
        [key: string]: unknown;
      };
  /** Fallback — throws on failure, returns parsed value on success. */
  parse?: (data: unknown) => T;
}

/**
 * A single issue reported by schema validation.
 */
export interface SchemaIssue {
  /** Human-readable error message */
  message: string;
  /** Property path (e.g., ["user", "email"]) */
  path?: ReadonlyArray<PropertyKey>;
}

/**
 * Options for `ctx.validate()`.
 */
export interface ValidateOptions {
  /**
   * How a validation failure is treated:
   * - `"error"` (default) — counts as a failed assertion (test fails)
   * - `"warn"` — recorded as warning only (test still passes)
   * - `"fatal"` — immediately aborts test execution
   */
  severity?: "error" | "warn" | "fatal";
}

/**
 * Schema validation entry for an HTTP request.
 * Can be a bare schema (severity defaults to `"error"`) or an object with explicit severity.
 */
export type SchemaEntry<T> =
  | SchemaLike<T>
  | { schema: SchemaLike<T>; severity?: "error" | "warn" | "fatal" };

/**
 * Schema configuration for automatic HTTP request/response validation.
 *
 * Headers (request and response) are validated as a normalized
 * `Record<string, string>` — `Headers` instances and `string[][]` forms are
 * flattened before validation so schemas can be written against a plain object.
 *
 * @example
 * ```ts
 * ctx.http.post(url, {
 *   json: payload,
 *   headers: { "X-Tenant-Id": "t1" },
 *   schema: {
 *     request: RequestBodySchema,
 *     response: ResponseSchema,
 *     query: QueryParamsSchema,
 *     requestHeaders: z.object({ "X-Tenant-Id": z.string() }),
 *     responseHeaders: z.object({ "content-type": z.string() }),
 *   },
 * });
 * ```
 */
export interface HttpSchemaOptions {
  /** Validate the request body (json option) before sending */
  request?: SchemaEntry<unknown>;
  /** Validate the response body after receiving */
  response?: SchemaEntry<unknown>;
  /** Validate the query/searchParams before sending */
  query?: SchemaEntry<unknown>;
  /**
   * Validate the per-call request headers before sending.
   *
   * Only the headers passed on this call are checked — client-level defaults
   * (e.g. `configure({ http: { headers } })`) are not included.
   */
  requestHeaders?: SchemaEntry<Record<string, string>>;
  /** Validate the response headers after receiving (fires on final attempt). */
  responseHeaders?: SchemaEntry<Record<string, string>>;
}

// =============================================================================
// Assertion Types
// =============================================================================

/**
 * Details for assertion (actual/expected values).
 *
 * @example
 * ```ts
 * ctx.assert(res.status === 200, "Expected 200", {
 *   actual: res.status,
 *   expected: 200,
 * });
 * ```
 */
export interface AssertionDetails {
  actual?: unknown;
  expected?: unknown;
}

/**
 * Input for explicit assertion result object.
 *
 * @example
 * ```ts
 * ctx.assertResult({
 *   passed: res.status === 200,
 *   actual: res.status,
 *   expected: 200,
 * });
 * ```
 */
export interface AssertionResultInput {
  passed: boolean;
  actual?: unknown;
  expected?: unknown;
}

/**
 * Options for metric reporting.
 *
 * @example
 * ```ts
 * ctx.metric("api_latency", duration, {
 *   unit: "ms",
 *   tags: { endpoint: "/users", method: "GET" },
 * });
 * ```
 */
export interface MetricOptions {
  /** Display unit (e.g., "ms", "bytes", "count", "%") */
  unit?: string;
  /** Key-value tags for grouping/filtering in dashboards */
  tags?: Record<string, string>;
}

// ── Metric Thresholds ─────────────────────────────────────────────────────────

/**
 * Aggregation function for threshold evaluation.
 *
 * - `avg`, `min`, `max`: basic statistics
 * - `p50`, `p90`, `p95`, `p99`: percentiles
 * - `count`: total number of data points
 */
export type ThresholdAggregation =
  | "avg"
  | "min"
  | "max"
  | "p50"
  | "p90"
  | "p95"
  | "p99"
  | "count";

/**
 * A single threshold rule: `"<200"` or `"<=500"`.
 *
 * The string format is: `operator + number`, where operator is `<` or `<=`.
 */
export type ThresholdExpression = string;

/**
 * Per-metric threshold rules keyed by aggregation function.
 *
 * @example
 * ```ts
 * { p95: "<200", avg: "<100", max: "<2000" }
 * ```
 */
export type MetricThresholdRules = Partial<
  Record<ThresholdAggregation, ThresholdExpression>
>;

/**
 * Threshold configuration: metric name → rules (or shorthand string for avg).
 *
 * @example
 * ```ts
 * {
 *   thresholds: {
 *     "http_duration_ms": { p95: "<200", avg: "<100" },
 *     "error_rate": "<0.01",  // shorthand for { avg: "<0.01" }
 *   }
 * }
 * ```
 */
export type ThresholdConfig = Record<
  string,
  MetricThresholdRules | ThresholdExpression
>;

/**
 * Result of evaluating a single threshold rule.
 */
export interface ThresholdResult {
  /** Metric key (e.g., "http_duration_ms") */
  metric: string;
  /** Aggregation function used (e.g., "p95") */
  aggregation: ThresholdAggregation;
  /** The threshold expression (e.g., "<200") */
  threshold: ThresholdExpression;
  /** The actual computed value */
  actual: number;
  /** Whether the threshold was met */
  pass: boolean;
}

/**
 * Summary of all threshold evaluations for a run.
 */
export interface ThresholdSummary {
  /** All individual threshold results */
  results: ThresholdResult[];
  /** True if all thresholds passed */
  pass: boolean;
}

/**
 * Options for `ctx.pollUntil()`.
 */
export interface PollUntilOptions {
  /** Maximum time to wait before giving up (milliseconds). */
  timeoutMs: number;
  /** Interval between poll attempts (milliseconds). Default: 1000. */
  intervalMs?: number;
  /**
   * Called when polling times out instead of throwing an error.
   * If present, `pollUntil` resolves silently on timeout.
   * If absent, `pollUntil` throws on timeout (test fails).
   *
   * @param lastError The last error thrown by the polling function, if any.
   */
  onTimeout?: (lastError?: Error) => void;
}

/**
 * Unified trace data for protocol call reporting.
 *
 * Supports HTTP, gRPC, WebSocket, and any custom protocol.
 * HTTP auto-tracing populates both new and deprecated fields for
 * backward compatibility.
 *
 * @example HTTP trace (auto-emitted by ctx.http)
 * ```ts
 * { protocol: "http", target: "GET /users", status: 200, durationMs: 150, ok: true }
 * ```
 *
 * @example gRPC trace (emitted by @glubean/grpc plugin)
 * ```ts
 * { protocol: "grpc", target: "GreeterService/SayHello", status: 0, durationMs: 9, ok: true,
 *   metadata: { service: "GreeterService", method: "SayHello", peer: "127.0.0.1:50051" } }
 * ```
 *
 * @example Manual trace for a custom protocol
 * ```ts
 * ctx.trace({
 *   protocol: "custom",
 *   target: "my-service/DoThing",
 *   status: 0,
 *   durationMs: 42,
 *   ok: true,
 * });
 * ```
 */
export interface Trace {
  /** Protocol discriminator. Consumers use this to select renderers. */
  protocol: "http" | "grpc" | "ws" | (string & {});
  /** Human-readable target identifier.
   *  HTTP: "GET /users", gRPC: "GreeterService/SayHello", WS: "wss://chat.example.com" */
  target: string;
  /** Status — HTTP status code, gRPC status code, or custom string/number */
  status: number | string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether the call succeeded */
  ok: boolean;
  /** Optional human-readable name (e.g., "Create User", "Get Orders") */
  name?: string;
  /** Optional detailed description */
  description?: string;

  // ── HTTP backward-compat fields (populated when protocol === "http") ──

  /** @deprecated Use `target` and `metadata` instead. HTTP method. */
  method?: string;
  /** @deprecated Use `target` and `metadata` instead. Request URL. */
  url?: string;
  /** @deprecated Use `durationMs` instead. Duration in milliseconds. */
  duration?: number;

  // ── Request/response detail (any protocol) ────────────────────────────

  /** Optional request headers */
  requestHeaders?: Record<string, string>;
  /** Optional request body */
  requestBody?: unknown;
  /** Optional response headers */
  responseHeaders?: Record<string, string>;
  /** Optional response body */
  responseBody?: unknown;
  /** JSON Schema inferred from responseBody (when inferSchema is enabled) */
  responseSchema?: Record<string, unknown>;

  /** Protocol-specific data that doesn't fit common fields.
   *  gRPC: { service, method, peer, requestMetadata, responseMetadata }
   *  WS:   { closeCode, messageCount, direction } */
  metadata?: Record<string, unknown>;
}

/** @deprecated Use `Trace` instead. Kept for backward compatibility. */
export type ApiTrace = Trace;

/**
 * A typed interaction record emitted by plugins.
 *
 * All fields except `detail` are required, ensuring consistent timeline
 * rendering, filtering, and analytics across all plugin domains.
 *
 * @example Browser interaction
 * ```ts
 * ctx.action({
 *   category: "browser:click",
 *   target: "#submit-btn",
 *   duration: 620,
 *   status: "ok",
 *   detail: { autoWaitMs: 580 },
 * });
 * ```
 *
 * @example Protocol trace action (auto-emitted by ctx.trace())
 * ```ts
 * ctx.action({
 *   category: "http:request",
 *   target: "POST /api/auth/login",
 *   duration: 350,
 *   status: "ok",
 *   detail: { status: 201 },
 * });
 * ```
 */
export interface GlubeanAction {
  /**
   * Namespaced action category for routing, filtering, and rendering.
   *
   * Convention: `"domain:verb"` where `domain` identifies the plugin
   * (`http`, `browser`, `mcp`, `db`) and `verb` identifies the operation
   * (`request`, `click`, `assert`, `query`).
   */
  category: string;

  /**
   * The target of the action — what was acted upon.
   * Must be machine-readable for aggregation and search.
   *
   * Examples: `"#submit-btn"`, `"POST /api/users"`, `"get_weather"`.
   */
  target: string;

  /** How long the action took, in milliseconds. */
  duration: number;

  /**
   * Outcome of the action.
   * - `"ok"` — completed successfully
   * - `"error"` — failed (e.g., element not found, assertion mismatch)
   * - `"timeout"` — timed out (e.g., actionability check exceeded limit)
   */
  status: "ok" | "error" | "timeout";

  /**
   * Domain-specific payload. Optional.
   * Values must be JSON-serializable.
   */
  detail?: Record<string, unknown>;
}

/**
 * A generic structured event emitted by plugins.
 *
 * Unlike `GlubeanAction` (which has required fields for timeline rendering),
 * `GlubeanEvent` is a loosely-typed container for any structured data that
 * plugins want to surface in the dashboard.
 *
 * Dashboard plugins can register custom renderers keyed on `type` to
 * control how events are displayed. Without a custom renderer, events appear
 * as collapsible JSON in the detail panel.
 *
 * @example Screenshot captured
 * ```ts
 * ctx.event({
 *   type: "browser:screenshot",
 *   data: { path: "/screenshots/login.png", fullPage: true, sizeKb: 142 },
 * });
 * ```
 *
 * @example MCP server connected
 * ```ts
 * ctx.event({
 *   type: "mcp:connected",
 *   data: { server: "weather-api", transport: "stdio", tools: ["get_weather"] },
 * });
 * ```
 */
export interface GlubeanEvent {
  /**
   * Namespaced event type. Convention: `"domain:noun"` or `"domain:description"`.
   * Examples: `"browser:screenshot"`, `"mcp:connected"`, `"db:slow-query-warning"`.
   */
  type: string;

  /** Structured payload. Must be JSON-serializable. */
  data: Record<string, unknown>;
}

/**
 * Result of a single assertion within a test.
 */
export interface AssertionResult {
  /** Whether the assertion passed */
  passed: boolean;
  /** Human-readable description of the assertion */
  message: string;
  /** The actual value received (optional) */
  actual?: unknown;
  /** The expected value (optional) */
  expected?: unknown;
}

// =============================================================================
// New Builder API Types
// =============================================================================

/**
 * Metadata for a test (unified for all test types).
 */
export interface TestMeta {
  /** Unique identifier for the test */
  id: string;
  /** Human-readable name (defaults to id) */
  name?: string;
  /** Detailed description */
  description?: string;
  /**
   * Tags for filtering (e.g., ["smoke", "auth"]).
   * Accepts a single string or an array.
   *
   * @example
   * tags: "smoke"
   * tags: ["smoke", "auth"]
   */
  tags?: string | string[];
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /**
   * If true, run only focused tests in this file/run context.
   * If both `only` and `skip` are true, `skip` takes precedence.
   */
  only?: boolean;
  /** If true, skip this test (takes precedence over `only`) */
  skip?: boolean;

  /**
   * Physical capability required by this test.
   * Set automatically by `contract.http()` and `contract.flow()`.
   *
   * - `"headless"` (default) — fully automated
   * - `"browser"` — needs real browser (OAuth, captcha, checkout)
   * - `"out-of-band"` — needs out-of-band channel (email, SMS, webhook tunnel)
   */
  requires?: "headless" | "browser" | "out-of-band";

  /**
   * Default run policy for this test.
   * Set automatically by `contract.http()` and `contract.flow()`.
   *
   * - `"always"` (default) — run whenever runner satisfies `requires`
   * - `"opt-in"` — skip unless explicitly requested (`--include-opt-in`)
   */
  defaultRun?: "always" | "opt-in";

  /**
   * Filter rows before generating tests (data-driven only).
   * Return `true` to include the row, `false` to exclude.
   * Applied before test registration — excluded rows never become tests.
   *
   * @example Exclude invalid data
   * ```ts
   * filter: (row) => !!row.endpoint && !!row.expected
   * ```
   *
   * @example Only include specific country
   * ```ts
   * filter: (row) => row.country === "JP"
   * ```
   */
  filter?: (row: Record<string, unknown>, index: number) => boolean;

  /**
   * Auto-tag tests with values from data row fields.
   * Each field generates a tag in `"field:value"` format.
   * Accepts a single field name or an array.
   *
   * Combined with static `tags` — both are included in the final tag list.
   * Use `glubean run --tag country:JP` to filter at runtime.
   *
   * @example Single field
   * ```ts
   * tagFields: "country"
   * // Row { country: "JP" } → tags include "country:JP"
   * ```
   *
   * @example Multiple fields
   * ```ts
   * tagFields: ["country", "region"]
   * // Row { country: "JP", region: "APAC" } → tags include "country:JP", "region:APAC"
   * ```
   */
  tagFields?: string | string[];

  /**
   * If true, workflow-level metrics (total duration + per-step durations)
   * are exported to the Prometheus metrics endpoint. Endpoint latency
   * metrics are always collected regardless of this flag.
   *
   * Use this for tests where workflow performance matters and you want
   * to track it in Grafana. Defaults to false to avoid cardinality explosion.
   */
  enableMetrics?: boolean;

  /**
   * Allow data rows to run in parallel (data-driven only).
   * Actual concurrency level is controlled by `--concurrency` CLI flag.
   *
   * When true, rows execute concurrently via an async work queue.
   * Safe for IO-bound tests. Avoid if rows share mutable state.
   *
   * Ignored for non-data-driven tests.
   *
   * @default false
   *
   * @example
   * ```ts
   * test.each(users)(
   *   { id: "user-$id", tags: "smoke", parallel: true },
   *   async (ctx, row) => { ... },
   * );
   * ```
   */
  parallel?: boolean;

  /**
   * Mark this test as not yet executable (contract API).
   * When set, the runner skips this test with the deferred reason.
   * Scanner and coverage tools still track it as a declared case.
   */
  deferred?: string;

  /**
   * Mark this test as deprecated (contract API).
   * When set, the runner skips this test with the deprecation reason.
   * Deprecated takes precedence over deferred for lifecycle normalization.
   */
  deprecated?: string;
}

/**
 * Metadata for a step within a test.
 */
export interface StepMeta {
  /** Step name (used for display and reporting) */
  name: string;
  /** Optional timeout override for this step */
  timeout?: number;
  /** Number of retries for this step (default: 0) */
  retries?: number;
  /**
   * Delay before each retry in ms (default: 1000).
   * This is the base delay for the first retry.
   * Combined with `backoff` to control subsequent delays.
   *
   * @example Fixed 2-second delay
   * ```ts
   * .step("sync", { retries: 3, retryDelay: 2000 }, fn)
   * // delays: 2s, 2s, 2s
   * ```
   */
  retryDelay?: number;
  /**
   * Multiplier applied to retryDelay after each retry (default: 1 = fixed delay).
   * Set to 2 for classic doubling backoff.
   *
   * Formula: `delay = retryDelay * backoff^attempt`
   * Capped at 30 seconds.
   *
   * @example Doubling: 2s, 4s, 8s
   * ```ts
   * .step("flaky", { retries: 3, retryDelay: 2000, backoff: 2 }, fn)
   * ```
   *
   * @example Gentle: 1s, 1.5s, 2.25s
   * ```ts
   * .step("poll", { retries: 3, retryDelay: 1000, backoff: 1.5 }, fn)
   * ```
   */
  backoff?: number;
  /**
   * Logical group this step belongs to (set by `.group()`).
   * Used for visual grouping in reports and dashboards.
   */
  group?: string;
}

/**
 * The function signature for a simple test (no state).
 */
export type SimpleTestFunction = (ctx: TestContext) => Promise<void>;

/**
 * The function signature for a data-driven test (test.each).
 * Receives TestContext and the data row from the table.
 *
 * @template T The data row type
 *
 * @example
 * ```ts
 * const fn: EachTestFunction<{ id: number; expected: number }> =
 *   async (ctx, { id, expected }) => {
 *     const res = await ctx.http.get(`${ctx.vars.require("BASE_URL")}/users/${id}`, {
 *       throwHttpErrors: false,
 *     });
 *     ctx.expect(res.status).toBe(expected);
 *   };
 * ```
 */
export type EachTestFunction<T> = (ctx: TestContext, data: T) => Promise<void>;

/**
 * The function signature for a step with state.
 * @template S The state type passed between steps
 */
export type StepFunction<S = unknown> = (
  ctx: TestContext,
  state: S,
) => Promise<S | void>;

/**
 * Setup function that runs before all steps.
 * Returns state that will be passed to steps and teardown.
 * @template S The state type to return
 */
export type SetupFunction<S = unknown> = (ctx: TestContext) => Promise<S>;

/**
 * Teardown function that runs after all steps.
 *
 * **Important**: Teardown always runs, even if:
 * - Setup fails
 * - Any step fails
 * - The test times out
 *
 * Use teardown to clean up resources (close connections, delete test data, etc.).
 * Handle errors gracefully as teardown failures won't prevent other cleanup.
 *
 * @template S The state type received from setup
 *
 * @example
 * ```ts
 * const teardown: TeardownFunction<{ userId: string }> = async (ctx, state) => {
 *   // Always runs for cleanup
 *   try {
 *     await deleteUser(state.userId);
 *   } catch (err) {
 *     ctx.log("Cleanup warning:", err.message);
 *     // Don't throw - allow other cleanup to continue
 *   }
 * };
 * ```
 */
export type TeardownFunction<S = unknown> = (
  ctx: TestContext,
  state: S,
) => Promise<void>;

/**
 * Internal step definition (stored in builder).
 */
export interface StepDefinition<S = unknown> {
  meta: StepMeta;
  fn: StepFunction<S>;
}

/**
 * A complete test definition (output of builder).
 * @template S The state type for multi-step tests
 */
export interface Test<S = unknown> {
  /** Test metadata */
  meta: TestMeta;
  /** Test type: 'simple' for single-function tests, 'steps' for multi-step */
  type: "simple" | "steps";
  /** The test function (for simple tests) */
  fn?: SimpleTestFunction;
  /** Setup function (for step-based tests) */
  setup?: SetupFunction<S>;
  /** Teardown function (for step-based tests) */
  teardown?: TeardownFunction<S>;
  /** Steps (for step-based tests) */
  steps?: StepDefinition<S>[];
  /**
   * Fixture definitions provided by `test.extend()`.
   * The runner resolves these and merges results into `TestContext`
   * before invoking the test function / steps.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fixtures?: Record<string, ExtensionFn<any>>;
}

// =============================================================================
// Extension Types (test.extend)
// =============================================================================

/**
 * Factory function for a context extension (fixture).
 *
 * Two forms:
 * - **Simple factory**: `(ctx) => instance` — called once per test, return value
 *   is merged into ctx.
 * - **Lifecycle factory**: `(ctx, use) => { setup; await use(instance); teardown; }`
 *   — wraps the test execution; cleanup runs after the `use` callback resolves.
 *
 * @template T The type of the fixture instance
 *
 * @example Simple factory
 * ```ts
 * const authFixture: ExtensionFn<AuthClient> = (ctx) =>
 *   createAuth(ctx.vars.require("AUTH_URL"));
 * ```
 *
 * @example Lifecycle factory
 * ```ts
 * const dbFixture: ExtensionFn<DbClient> = async (ctx, use) => {
 *   const db = await connect(ctx.vars.require("DB_URL"));
 *   await use(db);
 *   await db.disconnect();
 * };
 * ```
 */
export type ExtensionFn<T> =
  | ((ctx: TestContext) => T | Promise<T>)
  | ((ctx: TestContext, use: (instance: T) => Promise<void>) => Promise<void>);

/**
 * Resolve the instance type from a single extension factory function.
 *
 * Checks the lifecycle form first (2-param with `use` callback) because it
 * is more specific, then falls back to the simple factory forms.
 */
export type ResolveExtension<F> = F extends (
  ctx: TestContext,
  use: (instance: infer T) => Promise<void>,
) => Promise<void> ? T
  : F extends (ctx: TestContext) => Promise<infer T> ? T
  : F extends (ctx: TestContext) => infer T ? T
  : never;

/**
 * Map of extension factory functions to their resolved instance types.
 *
 * @example
 * ```ts
 * type R = ResolveExtensions<{
 *   auth: (ctx: TestContext) => AuthClient;
 *   db: (ctx: TestContext, use: (i: DbClient) => Promise<void>) => Promise<void>;
 * }>;
 * // R = { auth: AuthClient; db: DbClient }
 * ```
 */
export type ResolveExtensions<E> = {
  [K in keyof E]: ResolveExtension<E[K]>;
};

/**
 * Metadata registered to the global registry (for scanning).
 */
export interface RegisteredTestMeta {
  /** Test ID */
  id: string;
  /** Test name */
  name: string;
  /** Test type */
  type: "simple" | "steps";
  /** Tags */
  tags?: string[];
  /** Description */
  description?: string;
  /** Step metadata (for step-based tests) */
  steps?: { name: string; group?: string }[];
  /** Has setup hook */
  hasSetup?: boolean;
  /** Has teardown hook */
  hasTeardown?: boolean;
  /** Source file (set by scanner) */
  file?: string;
  /** Export name in the module */
  exportName?: string;
  /**
   * Trace grouping ID — the unresolved template ID for pick tests.
   * When set, the CLI uses this as the trace directory name so all
   * pick variants land in one directory for easy diffing.
   */
  groupId?: string;
  /**
   * Whether this test can run in parallel with other tests in the same group.
   * Only meaningful when `groupId` is set.
   * Actual concurrency level is controlled externally (e.g. `--concurrency` CLI flag).
   */
  parallel?: boolean;

  /** Physical capability required by this test. */
  requires?: "headless" | "browser" | "out-of-band";

  /** Default run policy for this test. */
  defaultRun?: "always" | "opt-in";

  /**
   * Contract metadata (set by `contract[protocol](id, spec)` via any
   * registered adapter). Present only for tests generated by the contract API.
   * Shape mirrors ContractRegistryMeta (contract-types.ts).
   */
  contract?: {
    target: string;
    protocol: string;
    caseKey: string;
    lifecycle: import("./contract-types.js").CaseLifecycle;
    severity: import("./contract-types.js").CaseSeverity;
    instanceName?: string;
    /** Adapter.describePayload() output — protocol-agnostic payload overview. */
    payloadSummary?: import("./contract-types.js").PayloadDescriptor;
    /** Plugin-defined free-form meta; core does not inspect. */
    meta?: unknown;
  };

  /**
   * Flow metadata (set by contract.flow()). Mutually exclusive with `contract`.
   * Shape mirrors FlowRegistryMeta (contract-types.ts).
   */
  flow?: {
    id: string;
    description?: string;
    tags?: string[];
    steps: Array<{
      kind: "contract-call" | "compute";
      name?: string;
      contractId?: string;
      caseKey?: string;
      protocol?: string;
      target?: string;
      inputs?: import("./contract-types.js").FieldMapping[];
      outputs?: import("./contract-types.js").FieldMapping[];
      reads?: string[];
      writes?: string[];
    }>;
    setupDynamic?: true;
  };
}

// =============================================================================
// Execution Context
// =============================================================================

/**
 * Runtime context captured when a test run is executed.
 * Included in result.json so a single file can answer:
 * "what ran, how, and why it failed."
 */
export interface RunContext {
  /** ISO 8601 timestamp of the run */
  timestamp: string;
  /** Node.js version (process.version) */
  nodeVersion: string;
  /** @glubean/sdk version */
  sdkVersion: string;
  /** @glubean/runner version */
  runnerVersion: string;
  /** Operating system (process.platform) */
  platform: string;
  /** CPU architecture (process.arch) */
  arch: string;
  /** How the run was triggered: CLI command string, "vscode-play", "vscode-debug", "mcp" */
  command?: string;
  /** Working directory */
  cwd?: string;
  /** Which .env file was used */
  envFile?: string;
}
