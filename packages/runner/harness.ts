/**
 * Harness script - runs INSIDE the Deno sandbox.
 * This is the bridge between the Runner and User Code.
 *
 * Usage:
 *   deno run --allow-net harness.ts --testUrl=<url> --testId=<id> --context=<json>
 */

import { parseArgs } from "@std/cli/parse-args";
import ky from "ky";
import type {
  ApiTrace,
  AssertionDetails,
  AssertionResultInput,
  HttpClient,
  HttpSchemaOptions,
  MetricOptions,
  PollUntilOptions,
  SchemaEntry,
  SchemaIssue,
  SchemaLike,
  Test,
  TestContext,
  ValidateOptions,
} from "@glubean/sdk";
import { Expectation } from "@glubean/sdk/expect";

// Global error handlers for async errors that escape try/catch
globalThis.addEventListener("error", (event) => {
  console.log(
    JSON.stringify({
      type: "status",
      status: "failed",
      error: event.error?.message || event.message || "Unknown error",
      stack: event.error?.stack,
    })
  );
  Deno.exit(1);
});

globalThis.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  console.log(
    JSON.stringify({
      type: "status",
      status: "failed",
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    })
  );
  Deno.exit(1);
});

// Parse CLI arguments
const args = parseArgs(Deno.args, {
  string: ["testUrl", "testId", "exportName"],
  boolean: ["emitFullTrace"],
});

/** When true, auto-trace includes request/response headers and bodies. */
const emitFullTrace = args.emitFullTrace ?? false;

const testUrl = args.testUrl;
const testId = args.testId;
/** Optional export name for fallback lookup (used by test.pick/test.each). */
const exportName = args.exportName;

if (!testUrl || !testId) {
  console.log(
    JSON.stringify({
      type: "error",
      message: "Missing required arguments: --testUrl and --testId",
    })
  );
  Deno.exit(1);
}

/**
 * Read context data from stdin.
 * Context is passed via stdin instead of CLI args to avoid length limits and security issues.
 *
 * @returns The context JSON string from stdin
 */
async function readContextFromStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  const reader = Deno.stdin.readable.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // Efficiently concatenate chunks
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(combined);
}

// Parse context data from stdin
const contextJson = await readContextFromStdin();
const contextData = contextJson ? JSON.parse(contextJson) : {};
const rawVars = (contextData.vars ?? {}) as Record<string, string>;
const rawSecrets = (contextData.secrets ?? {}) as Record<string, string>;
const retryCount = (contextData.retryCount ?? 0) as number;

// Memory monitoring state
let peakMemoryBytes = 0;
let memoryCheckInterval: number | undefined;

// Step-level assertion tracking.
// Reset before each step, incremented by ctx.assert on failure.
let stepFailedAssertions = 0;
let stepAssertionTotal = 0;

// Current step index (null when not inside a step).
// Used to tag log/assertion/trace/metric events with their containing step.
let currentStepIndex: number | null = null;

// Test-level assertion and step counters.
// Accumulated across the entire test execution for the summary event.
let totalAssertions = 0;
let totalFailedAssertions = 0;
let totalSteps = 0;
let passedSteps = 0;
let failedSteps = 0;
let skippedSteps = 0;

// Warning counters — tracked separately from assertions.
// Warnings never affect test pass/fail status.
let warningTotal = 0;
let warningTriggered = 0;

// Schema validation counters.
let schemaValidationTotal = 0;
let schemaValidationFailed = 0;
let schemaValidationWarnings = 0;

/**
 * Start monitoring memory usage.
 * Samples memory every 100ms and tracks peak usage.
 */
function startMemoryMonitoring(): void {
  if (typeof Deno !== "undefined" && Deno.memoryUsage) {
    // Get initial memory
    const initial = Deno.memoryUsage();
    peakMemoryBytes = initial.heapUsed;

    // Sample every 100ms
    memoryCheckInterval = setInterval(() => {
      try {
        const mem = Deno.memoryUsage();
        peakMemoryBytes = Math.max(peakMemoryBytes, mem.heapUsed);
      } catch {
        // Ignore errors during monitoring
      }
    }, 100);
  }
}

/**
 * Stop memory monitoring and return peak usage.
 */
function stopMemoryMonitoring(): number {
  if (memoryCheckInterval !== undefined) {
    clearInterval(memoryCheckInterval);
    memoryCheckInterval = undefined;
  }
  return peakMemoryBytes;
}

/**
 * Custom error class for test skip.
 * When thrown, the test will be marked as skipped instead of failed.
 */
class SkipError extends Error {
  constructor(public readonly reason?: string) {
    super(reason ? `Test skipped: ${reason}` : "Test skipped");
    this.name = "SkipError";
  }
}

/**
 * Sentinel error thrown by ctx.fail().
 * Immediately aborts test execution, emitting a failed assertion before throwing.
 */
class FailError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "FailError";
  }
}

/**
 * Helper to run validator and get error message.
 *
 * @param result Validator result (true/false/string/void/null)
 * @param key The variable or secret key being validated
 * @param type Whether this is a "var" or "secret"
 */
function runValidator(
  result: boolean | string | void | null,
  key: string,
  type: "var" | "secret"
): void {
  // true, undefined, null = valid
  if (result === true || result === undefined || result === null) {
    return;
  }
  // string = custom error message
  if (typeof result === "string") {
    throw new Error(`Invalid ${type} "${key}": ${result}`);
  }
  // false = generic error
  throw new Error(`Invalid ${type} "${key}": validation failed`);
}

// ---------------------------------------------------------------------------
// Schema validation helper
// ---------------------------------------------------------------------------

/**
 * Resolve a SchemaEntry to { schema, severity }.
 */
function resolveSchemaEntry<T>(entry: SchemaEntry<T>): {
  schema: SchemaLike<T>;
  severity: "error" | "warn" | "fatal";
} {
  if ("schema" in entry && entry.schema != null) {
    // deno-lint-ignore no-explicit-any
    const obj = entry as { schema: SchemaLike<T>; severity?: any };
    return { schema: obj.schema, severity: obj.severity ?? "error" };
  }
  return { schema: entry as SchemaLike<T>, severity: "error" };
}

/**
 * Core schema validation logic used by both ctx.validate and HTTP hooks.
 *
 * Runs safeParse (preferred) or parse (fallback), emits schema_validation event,
 * updates counters, and routes failures based on severity.
 *
 * Returns { success, data?, issues? }.
 */
function runSchemaValidation<T>(
  data: unknown,
  schema: SchemaLike<T>,
  label: string,
  severity: "error" | "warn" | "fatal"
): { success: true; data: T } | { success: false; issues: SchemaIssue[] } {
  schemaValidationTotal++;

  let success = false;
  let parsed: T | undefined;
  let issues: SchemaIssue[] = [];

  if (typeof schema.safeParse === "function") {
    const result = schema.safeParse(data);
    if (result.success) {
      success = true;
      parsed = result.data;
    } else {
      issues = (result.error?.issues ?? []).map((i) => ({
        message: i.message,
        ...(i.path && { path: i.path }),
      }));
    }
  } else if (typeof schema.parse === "function") {
    try {
      parsed = schema.parse(data);
      success = true;
    } catch (err: unknown) {
      // Try to extract structured issues from the error
      // deno-lint-ignore no-explicit-any
      const errAny = err as any;
      if (errAny?.issues && Array.isArray(errAny.issues)) {
        issues = errAny.issues.map(
          (i: { message?: string; path?: Array<string | number> }) => ({
            message: i.message ?? String(i),
            ...(i.path && { path: i.path }),
          })
        );
      } else {
        issues = [
          {
            message: err instanceof Error ? err.message : String(err),
          },
        ];
      }
    }
  } else {
    issues = [{ message: "Schema has neither safeParse nor parse method" }];
  }

  // Emit schema_validation event (always, regardless of success/severity)
  console.log(
    JSON.stringify({
      type: "schema_validation",
      label,
      success,
      severity,
      ...(issues.length > 0 && { issues }),
      ...(currentStepIndex !== null && { stepIndex: currentStepIndex }),
    })
  );

  if (!success) {
    const issuesSummary = issues
      .map((i) => {
        const path = i.path ? i.path.join(".") + ": " : "";
        return path + i.message;
      })
      .join("; ");
    const msg = `Schema validation failed: ${label} — ${issuesSummary}`;

    switch (severity) {
      case "error":
        schemaValidationFailed++;
        // Route through assertion pipeline so it counts as a failed assertion
        ctx.assert(false, msg);
        break;
      case "warn":
        schemaValidationWarnings++;
        ctx.warn(false, msg);
        break;
      case "fatal":
        schemaValidationFailed++;
        // Emit failed assertion, then throw to abort
        ctx.assert(false, msg);
        throw new FailError(msg);
    }

    return { success: false, issues };
  }

  return { success: true, data: parsed as T };
}

// Construct TestContext with streaming output
// (http field is attached after ky instance creation below)
const ctx = {
  vars: {
    get: (key: string) => rawVars[key],
    require: (
      key: string,
      validate?: (value: string) => boolean | string | void | null
    ) => {
      const value = rawVars[key];
      if (value === undefined || value === null || value === "") {
        throw new Error(`Missing required var: ${key}`);
      }
      if (validate) {
        runValidator(validate(value), key, "var");
      }
      return value;
    },
    all: () => ({ ...rawVars }),
  },
  secrets: {
    get: (key: string) => rawSecrets[key],
    require: (
      key: string,
      validate?: (value: string) => boolean | string | void | null
    ) => {
      const value = rawSecrets[key];
      if (value === undefined || value === null || value === "") {
        throw new Error(`Missing required secret: ${key}`);
      }
      if (validate) {
        runValidator(validate(value), key, "secret");
      }
      return value;
    },
  },

  // Logging function
  log: (message: string, data?: unknown) => {
    console.log(
      JSON.stringify({
        type: "log",
        message,
        data,
        ...(currentStepIndex !== null && { stepIndex: currentStepIndex }),
      })
    );
  },

  // Assertion function with overloads
  // Overload 1: assert(condition: boolean, message?: string, details?: AssertionDetails)
  // Overload 2: assert(result: AssertionResultInput, message?: string)
  assert: (
    arg1: boolean | AssertionResultInput,
    arg2?: string | AssertionDetails,
    arg3?: AssertionDetails
  ) => {
    let passed: boolean;
    let message: string;
    let actual: unknown;
    let expected: unknown;

    if (typeof arg1 === "boolean") {
      // Overload 1: assert(condition, message?, details?)
      passed = arg1;
      message =
        (typeof arg2 === "string" ? arg2 : undefined) ||
        (passed ? "Assertion passed" : "Assertion failed");
      const details = typeof arg2 === "object" ? arg2 : arg3;
      if (details) {
        actual = details.actual;
        expected = details.expected;
      }
    } else {
      // Overload 2: assert(result, message?)
      passed = arg1.passed;
      actual = arg1.actual;
      expected = arg1.expected;
      message =
        (typeof arg2 === "string" ? arg2 : undefined) ||
        (passed ? "Assertion passed" : "Assertion failed");
    }

    // Track per-step and test-level assertion stats
    stepAssertionTotal++;
    totalAssertions++;
    if (!passed) {
      stepFailedAssertions++;
      totalFailedAssertions++;
    }

    console.log(
      JSON.stringify({
        type: "assertion",
        passed,
        message,
        actual,
        expected,
        ...(currentStepIndex !== null && { stepIndex: currentStepIndex }),
      })
    );
  },

  // Fluent assertion API (Jest-style, soft-by-default)
  expect: <V>(actual: V): Expectation<V> => {
    return new Expectation(actual, (result) => {
      // Route through the existing assertion pipeline
      ctx.assert(
        {
          passed: result.passed,
          actual: result.actual,
          expected: result.expected,
        },
        result.message
      );
    });
  },

  // Warning function — soft check, never affects test pass/fail.
  // condition=true means OK; condition=false triggers warning.
  warn: (condition: boolean, message: string) => {
    warningTotal++;
    if (!condition) {
      warningTriggered++;
    }
    console.log(
      JSON.stringify({
        type: "warning",
        condition,
        message,
        ...(currentStepIndex !== null && { stepIndex: currentStepIndex }),
      })
    );
  },

  // Schema validation function
  validate: <T>(
    data: unknown,
    schema: SchemaLike<T>,
    label?: string,
    options?: ValidateOptions
  ): T | undefined => {
    const result = runSchemaValidation(
      data,
      schema,
      label ?? "data",
      options?.severity ?? "error"
    );
    return result.success ? result.data : undefined;
  },

  // API tracing function
  trace: (request: ApiTrace) => {
    console.log(
      JSON.stringify({
        type: "trace",
        data: request,
        ...(currentStepIndex !== null && { stepIndex: currentStepIndex }),
      })
    );
  },

  // Metric reporting function
  metric: (name: string, value: number, options?: MetricOptions) => {
    console.log(
      JSON.stringify({
        type: "metric",
        name,
        value,
        unit: options?.unit,
        tags: options?.tags,
        ...(currentStepIndex !== null && { stepIndex: currentStepIndex }),
      })
    );
  },

  /**
   * Skip the current test with an optional reason.
   * Throws a SkipError that will be caught and handled by the harness.
   *
   * @param reason Optional reason for skipping
   */
  skip: (reason?: string): never => {
    throw new SkipError(reason);
  },

  /**
   * Immediately fail and abort the current test.
   * Emits a failed assertion event, then throws to stop execution.
   */
  fail: (message: string): never => {
    // Emit a failed assertion so the failure reason appears in events
    console.log(
      JSON.stringify({
        type: "assertion",
        passed: false,
        message,
      })
    );
    throw new FailError(message);
  },

  /**
   * Poll a function until it returns truthy or times out.
   */
  pollUntil: async (
    options: PollUntilOptions,
    fn: () => Promise<boolean | unknown>
  ): Promise<void> => {
    const { timeoutMs, intervalMs = 1000, onTimeout } = options;
    const deadline = Date.now() + timeoutMs;
    let lastError: Error | undefined;

    while (Date.now() < deadline) {
      try {
        const result = await fn();
        if (result) return; // truthy → done
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      // Wait before next attempt, but don't overshoot the deadline
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
    }

    // Timed out
    if (onTimeout) {
      onTimeout(lastError);
      return;
    }

    const suffix = lastError ? `: ${lastError.message}` : "";
    throw new Error(`pollUntil timed out after ${timeoutMs}ms${suffix}`);
  },

  /**
   * Set a custom timeout for the current test.
   * Note: This sends a timeout_update event to the runner.
   * The runner is responsible for enforcing the timeout.
   *
   * @param ms Timeout in milliseconds
   */
  setTimeout: (ms: number) => {
    console.log(
      JSON.stringify({
        type: "timeout_update",
        timeout: ms,
      })
    );
  },

  /**
   * Current retry count (0 for first attempt).
   */
  retryCount,

  /**
   * Get current memory usage.
   * Only available in Deno runtime (returns null in other environments).
   * Useful for debugging memory issues locally.
   *
   * @returns Memory usage stats or null if not available
   *
   * @example
   * const mem = ctx.getMemoryUsage();
   * if (mem) {
   *   ctx.log(`Heap used: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
   * }
   */
  getMemoryUsage: () => {
    if (typeof Deno !== "undefined" && Deno.memoryUsage) {
      return Deno.memoryUsage();
    }
    return null;
  },
} as TestContext;

// ---------------------------------------------------------------------------
// Auto-tracing HTTP client (ctx.http) — powered by ky
// ---------------------------------------------------------------------------
// Track request start time. We use a simple variable instead of a WeakMap
// because ky may clone/recreate the Request object between beforeRequest and
// afterResponse hooks, breaking reference equality in a WeakMap.
let lastRequestStartTime = 0;
let httpRequestTotal = 0;
let httpErrorTotal = 0;

// Captured in beforeRequest when emitFullTrace is on
// deno-lint-ignore no-explicit-any
let lastRequestBody: any = undefined;

/** Max serialized body size (bytes) to include in trace events. */
const TRACE_BODY_MAX_SIZE = 10_240; // 10KB

/**
 * Truncate a value's JSON representation if it exceeds the size limit.
 * Returns the original value if within limits, otherwise a truncated string.
 */
// deno-lint-ignore no-explicit-any
function truncateBody(body: any): any {
  try {
    const json = JSON.stringify(body);
    if (json.length <= TRACE_BODY_MAX_SIZE) return body;
    return json.slice(0, TRACE_BODY_MAX_SIZE) + "... (truncated)";
  } catch {
    return "(non-serializable)";
  }
}

let summaryEmitted = false;

/**
 * Emit summary event with HTTP, assertion, and step totals.
 * Called once before the final status event. Idempotent.
 */
function emitSummary() {
  if (summaryEmitted) return;
  summaryEmitted = true;
  console.log(
    JSON.stringify({
      type: "summary",
      data: {
        // HTTP stats (always present, 0 when no HTTP calls)
        httpRequestTotal,
        httpErrorTotal,
        httpErrorRate:
          httpRequestTotal > 0
            ? Math.round((httpErrorTotal / httpRequestTotal) * 10000) / 10000
            : 0,
        // Assertion stats
        assertionTotal: totalAssertions,
        assertionFailed: totalFailedAssertions,
        // Warning stats
        warningTotal,
        warningTriggered,
        // Schema validation stats
        schemaValidationTotal,
        schemaValidationFailed,
        schemaValidationWarnings,
        // Step stats (0 for simple tests without builder steps)
        stepTotal: totalSteps,
        stepPassed: passedSteps,
        stepFailed: failedSteps,
        stepSkipped: skippedSteps,
      },
    })
  );
}

const kyInstance = ky.create({
  hooks: {
    beforeRequest: [
      // deno-lint-ignore no-explicit-any
      (_request: Request, options: any) => {
        lastRequestStartTime = performance.now();
        if (emitFullTrace) {
          // Capture request body from ky options before the request is sent
          lastRequestBody = options.json ?? options.body ?? undefined;
        }
      },
    ],
    afterResponse: [
      // deno-lint-ignore no-explicit-any
      async (request: Request, _options: any, response: Response) => {
        const duration = Math.round(performance.now() - lastRequestStartTime);

        // Increment HTTP counters for summary
        httpRequestTotal++;
        if (response.status >= 400) {
          httpErrorTotal++;
        }

        // Build trace data — enriched when emitFullTrace is on
        // deno-lint-ignore no-explicit-any
        const traceData: Record<string, any> = {
          method: request.method,
          url: request.url,
          status: response.status,
          duration,
        };

        // Pick up operation name from GraphQL client (X-Glubean-Op header)
        const glubeanOp = request.headers.get("x-glubean-op");
        if (glubeanOp) {
          traceData.name = glubeanOp;
        }

        if (emitFullTrace) {
          traceData.requestHeaders = Object.fromEntries(
            request.headers.entries()
          );
          if (lastRequestBody !== undefined) {
            traceData.requestBody = truncateBody(lastRequestBody);
          }
          traceData.responseHeaders = Object.fromEntries(
            response.headers.entries()
          );

          // Clone the response to read the body without consuming the original stream
          try {
            const cloned = response.clone();
            const contentType = response.headers.get("content-type") || "";
            if (contentType.includes("json")) {
              traceData.responseBody = truncateBody(await cloned.json());
            } else if (
              contentType.includes("text") ||
              contentType.includes("xml")
            ) {
              const text = await cloned.text();
              traceData.responseBody = truncateBody(text);
            }
            // Binary content types are intentionally skipped
          } catch {
            // Ignore clone/parse errors — trace still emits without body
          }
          lastRequestBody = undefined;
        }

        ctx.trace(traceData);

        // Auto-metric for response time
        try {
          const pathname = new URL(request.url).pathname;
          ctx.metric("http_duration_ms", duration, {
            unit: "ms",
            tags: { method: request.method, path: pathname },
          });
        } catch {
          ctx.metric("http_duration_ms", duration, {
            unit: "ms",
            tags: { method: request.method },
          });
        }

        return response;
      },
    ],
  },
});

/**
 * Normalize URL input for ky compatibility:
 * - Strip leading '/' from path when it's not a full URL
 *   (ky requires relative paths without leading slash when using prefixUrl)
 */
function normalizeUrl(input: string | URL | Request): string | URL | Request {
  if (
    typeof input === "string" &&
    input.startsWith("/") &&
    !input.startsWith("//")
  ) {
    return input.slice(1);
  }
  return input;
}

/**
 * Normalize options to fix ky quirks:
 * - Remove empty searchParams to prevent ky from appending bare '?'
 */
// deno-lint-ignore no-explicit-any
function normalizeOptions(options?: any): any {
  if (!options) return options;
  const normalized = { ...options };
  // Remove empty searchParams so ky doesn't append a bare '?'
  if (normalized.searchParams != null) {
    if (normalized.searchParams instanceof URLSearchParams) {
      if (normalized.searchParams.toString() === "") {
        delete normalized.searchParams;
      }
    } else if (
      typeof normalized.searchParams === "object" &&
      Object.keys(normalized.searchParams).length === 0
    ) {
      delete normalized.searchParams;
    } else if (
      typeof normalized.searchParams === "string" &&
      normalized.searchParams === ""
    ) {
      delete normalized.searchParams;
    }
  }
  return normalized;
}

/**
 * Run pre-request schema validations (query params, request body).
 * Extracts schema option from the options object.
 */
// deno-lint-ignore no-explicit-any
function runPreRequestSchemaValidation(options?: any): void {
  const schemaOpts = options?.schema as HttpSchemaOptions | undefined;
  if (!schemaOpts) return;

  // Validate query/searchParams
  if (schemaOpts.query && options?.searchParams != null) {
    const { schema, severity } = resolveSchemaEntry(schemaOpts.query);
    runSchemaValidation(options.searchParams, schema, "query params", severity);
  }

  // Validate request body (json)
  if (schemaOpts.request && options?.json !== undefined) {
    const { schema, severity } = resolveSchemaEntry(schemaOpts.request);
    runSchemaValidation(options.json, schema, "request body", severity);
  }
}

/**
 * Wrap a ky response promise to run post-response schema validation.
 * Attaches to the .json() method so we validate the parsed body.
 */
function wrapResponseWithSchema(
  // deno-lint-ignore no-explicit-any
  responsePromise: any,
  schemaOpts?: HttpSchemaOptions
  // deno-lint-ignore no-explicit-any
): any {
  if (!schemaOpts?.response) return responsePromise;

  const { schema, severity } = resolveSchemaEntry(schemaOpts.response);

  // Wrap the .json() method to validate after parsing
  const originalJson = responsePromise.json.bind(responsePromise);
  responsePromise.json = async () => {
    const body = await originalJson();
    runSchemaValidation(body, schema, "response body", severity);
    return body;
  };

  return responsePromise;
}

/**
 * Wrap a ky instance so that:
 * 1. Leading '/' in URL paths is stripped (ky + prefixUrl compatibility)
 * 2. Empty searchParams are removed (no bare '?' in URL)
 * 3. extend() returns a wrapped instance (preserves normalization)
 * 4. Schema validation runs on request/response when `schema` option is provided
 */
// deno-lint-ignore no-explicit-any
function wrapKy(instance: any): any {
  const methods = ["get", "post", "put", "patch", "delete", "head"] as const;

  function callWithSchema(
    // deno-lint-ignore no-explicit-any
    kyFn: (...args: any[]) => any,
    // deno-lint-ignore no-explicit-any
    input: any,
    // deno-lint-ignore no-explicit-any
    options?: any
  ) {
    const normalized = normalizeOptions(options);
    // Run pre-request validations (query, request body)
    runPreRequestSchemaValidation(normalized);
    // Strip schema option before passing to ky (ky doesn't know about it)
    // deno-lint-ignore no-explicit-any
    let kyOptions: any;
    if (normalized?.schema) {
      const { schema: _schema, ...rest } = normalized;
      kyOptions = rest;
    } else {
      kyOptions = normalized;
    }
    const responsePromise = kyFn(normalizeUrl(input), kyOptions);
    return wrapResponseWithSchema(responsePromise, normalized?.schema);
  }

  // The callable + methods wrapper
  // deno-lint-ignore no-explicit-any
  const wrapped: Record<string, any> = function (input: any, options?: any) {
    return callWithSchema(instance, input, options);
  };

  for (const method of methods) {
    // deno-lint-ignore no-explicit-any
    wrapped[method] = (input: any, options?: any) =>
      callWithSchema(instance[method].bind(instance), input, options);
  }

  // deno-lint-ignore no-explicit-any
  wrapped.extend = (options?: any) =>
    wrapKy(instance.extend(normalizeOptions(options)));

  return wrapped;
}

// Attach wrapped http client to ctx
// deno-lint-ignore no-explicit-any
(ctx as any).http = wrapKy(kyInstance);

// Set global runtime slot for configure() API.
// configure() returns lazy getters that read from this slot at test execution time.
// This must be set BEFORE importing user code so the slot is available during execution.
// deno-lint-ignore no-explicit-any
(globalThis as any).__glubeanRuntime = {
  vars: rawVars,
  secrets: rawSecrets,
  // deno-lint-ignore no-explicit-any
  http: (ctx as any).http,
};

try {
  // Dynamic import - LOAD phase
  console.log(
    JSON.stringify({
      type: "log",
      message: `Loading test module: ${testUrl}`,
    })
  );

  const userModule = await import(testUrl);

  // Find the test using the builder API
  let testObj = findNewTest(userModule, testId);
  if (!testObj && exportName) {
    // Fallback: for non-deterministic tests (test.pick), the testId from
    // discovery may not match this run's random selection. Use the stable
    // exportName to locate the export and pick the first resolved test.
    testObj = findNewTestByExport(userModule, exportName);
  }
  if (testObj) {
    await executeNewTest(testObj);
  } else {
    throw new Error(
      `Test "${testId}" not found. Available exports: ${Object.keys(
        userModule
      ).join(", ")}`
    );
  }
} catch (error) {
  // Emit HTTP summary before final status
  emitSummary();

  // Check if this is a skip error
  if (error instanceof SkipError) {
    console.log(
      JSON.stringify({
        type: "status",
        status: "skipped",
        reason: error.reason,
      })
    );
    Deno.exit(0); // Exit cleanly for skipped tests
  }

  // Regular error - report as failure
  console.log(
    JSON.stringify({
      type: "status",
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
  );
  Deno.exit(1);
}


/**
 * Type guard to check if an object is a new Test (builder API).
 *
 * @param obj The object to check
 * @returns True if the object is a Test from the builder API
 */
function isNewTest(obj: unknown): obj is Test<unknown> {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "meta" in obj &&
    "type" in obj &&
    ((obj as Test<unknown>).type === "simple" ||
      (obj as Test<unknown>).type === "steps")
  );
}

/**
 * Check if an object is an un-built TestBuilder.
 * The builder has a `__glubean_type === "builder"` marker and a `build()` method.
 * Calling `.build()` returns a plain Test object the runner can execute.
 */
function isTestBuilder(
  obj: unknown
): obj is { __glubean_type: "builder"; build(): Test<unknown> } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as Record<string, unknown>).__glubean_type === "builder" &&
    typeof (obj as Record<string, unknown>).build === "function"
  );
}

/**
 * Check if an object is an un-built EachBuilder (from test.each() builder mode).
 * The builder has a `__glubean_type === "each-builder"` marker and a `build()` method.
 * Calling `.build()` returns a Test[] array the runner can execute.
 */
function isEachBuilder(
  obj: unknown
): obj is { __glubean_type: "each-builder"; build(): Test<unknown>[] } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as Record<string, unknown>).__glubean_type === "each-builder" &&
    typeof (obj as Record<string, unknown>).build === "function"
  );
}

/**
 * If the value is a TestBuilder, auto-build it into a Test.
 * If the value is an EachBuilder, auto-build it into a Test[].
 * Otherwise return as-is.
 */
function autoResolve(value: unknown): unknown {
  if (isTestBuilder(value)) return value.build();
  if (isEachBuilder(value)) return value.build();
  return value;
}

/**
 * Search a resolved value (single Test or Test[]) for a matching test ID.
 * @internal
 */
function findInResolved(
  resolved: unknown,
  testId: string
): Test<unknown> | undefined {
  // Single test
  if (isNewTest(resolved) && resolved.meta?.id === testId) {
    return resolved as Test<unknown>;
  }
  // Array of tests (from test.each simple mode or EachBuilder.build())
  if (Array.isArray(resolved)) {
    for (const item of resolved) {
      if (isNewTest(item) && item.meta?.id === testId) {
        return item as Test<unknown>;
      }
    }
  }
  return undefined;
}

/**
 * Find a test created with the builder API in a user module.
 * Searches default export, direct export by testId, and all exports.
 * Automatically builds any TestBuilder or EachBuilder exports it encounters.
 *
 * @param userModule The imported user test module
 * @param testId The test ID to find
 * @returns The Test object if found, undefined otherwise
 */
function findNewTest(
  userModule: Record<string, unknown>,
  testId: string
): Test<unknown> | undefined {
  // Check default export
  const defaultResolved = autoResolve(userModule.default);
  const fromDefault = findInResolved(defaultResolved, testId);
  if (fromDefault) return fromDefault;

  // Check direct export by testId
  const directResolved = autoResolve(userModule[testId]);
  const fromDirect = findInResolved(directResolved, testId);
  if (fromDirect) return fromDirect;

  for (const value of Object.values(userModule)) {
    const resolved = autoResolve(value);
    const found = findInResolved(resolved, testId);
    if (found) return found;

    // Also support plain Test[] arrays (test.each simple mode exports)
    if (Array.isArray(value)) {
      for (const item of value) {
        const resolvedItem = autoResolve(item);
        const foundItem = findInResolved(resolvedItem, testId);
        if (foundItem) return foundItem;
      }
    }
  }

  return undefined;
}

/**
 * Find a test by export name instead of test ID.
 *
 * Used as a fallback for non-deterministic tests like test.pick(), where the
 * test ID from discovery may differ from the current run's random selection.
 * The export name (e.g. "searchProducts") is stable across runs.
 *
 * @param userModule The imported user test module
 * @param name The export name to look up
 * @returns The first Test object found in that export, or undefined
 */
function findNewTestByExport(
  userModule: Record<string, unknown>,
  name: string
): Test<unknown> | undefined {
  const value = userModule[name];
  if (value === undefined) return undefined;

  const resolved = autoResolve(value);

  // Single test
  if (isNewTest(resolved)) {
    return resolved as Test<unknown>;
  }
  // Array of tests (from test.each / test.pick) — return the first one
  if (Array.isArray(resolved)) {
    for (const item of resolved) {
      if (isNewTest(item)) {
        return item as Test<unknown>;
      }
    }
  }
  return undefined;
}

/**
 * Execute a test created with the builder API.
 * Handles both simple tests and multi-step tests with setup/teardown.
 *
 * @param test The Test object to execute
 */
async function executeNewTest(test: Test<unknown>): Promise<void> {
  console.log(
    JSON.stringify({
      type: "start",
      id: test.meta.id,
      name: test.meta.name || test.meta.id,
      tags: test.meta.tags,
      ...(retryCount > 0 && { retryCount }),
    })
  );

  // Start memory monitoring
  startMemoryMonitoring();

  try {
    if (test.type === "simple") {
      if (!test.fn) {
        throw new Error(`Invalid test "${test.meta.id}": missing fn`);
      }
      await test.fn(ctx);
    } else {
      let state: unknown = undefined;
      let stepFailed = false;
      try {
        if (test.setup) {
          console.log(
            JSON.stringify({
              type: "log",
              message: "Running setup...",
            })
          );
          state = await test.setup(ctx);
        }
        if (test.steps) {
          totalSteps = test.steps.length;
          for (let i = 0; i < test.steps.length; i++) {
            const step = test.steps[i];

            // If a previous step failed, skip remaining steps
            if (stepFailed) {
              skippedSteps++;
              console.log(
                JSON.stringify({
                  type: "step_end",
                  index: i,
                  name: step.meta.name,
                  status: "skipped",
                  durationMs: 0,
                  assertions: 0,
                  failedAssertions: 0,
                })
              );
              continue;
            }

            // Reset per-step assertion counters and set step scope
            stepFailedAssertions = 0;
            stepAssertionTotal = 0;
            currentStepIndex = i;
            const stepStart = performance.now();

            console.log(
              JSON.stringify({
                type: "step_start",
                index: i,
                name: step.meta.name,
                total: test.steps.length,
              })
            );

            let stepError: string | undefined;
            let stepReturnState: unknown = undefined;
            try {
              const result = await step.fn(ctx, state);
              if (result !== undefined) {
                state = result;
                stepReturnState = result;
              }
            } catch (err) {
              stepError = err instanceof Error ? err.message : String(err);
            }

            const durationMs = Math.round(performance.now() - stepStart);
            const failed = !!stepError || stepFailedAssertions > 0;

            // Serialize return state with size guard (max 4 KB)
            let returnStatePayload: unknown = undefined;
            if (stepReturnState !== undefined) {
              try {
                const serialized = JSON.stringify(stepReturnState);
                if (serialized.length <= 4096) {
                  returnStatePayload = stepReturnState;
                } else {
                  returnStatePayload = `[truncated: ${serialized.length} bytes]`;
                }
              } catch {
                returnStatePayload = "[non-serializable]";
              }
            }

            console.log(
              JSON.stringify({
                type: "step_end",
                index: i,
                name: step.meta.name,
                status: failed ? "failed" : "passed",
                durationMs,
                assertions: stepAssertionTotal,
                failedAssertions: stepFailedAssertions,
                ...(stepError && { error: stepError }),
                ...(returnStatePayload !== undefined && {
                  returnState: returnStatePayload,
                }),
              })
            );

            currentStepIndex = null;

            if (failed) {
              failedSteps++;
              stepFailed = true;
              // Don't throw here — let the loop continue to emit skip events
            } else {
              passedSteps++;
            }
          }
        }
      } finally {
        if (test.teardown) {
          try {
            console.log(
              JSON.stringify({
                type: "log",
                message: "Running teardown...",
              })
            );
            await test.teardown(ctx, state);
          } catch (teardownError) {
            console.log(
              JSON.stringify({
                type: "log",
                message: `Teardown error: ${
                  teardownError instanceof Error
                    ? teardownError.message
                    : String(teardownError)
                }`,
              })
            );
          }
        }
      }

      // If any step failed (assertion or throw), mark overall test as failed
      if (stepFailed) {
        // Emit summary before throwing so that step/assertion counts are reported
        emitSummary();
        throw new Error("One or more steps failed");
      }
    }

    // Stop monitoring and get peak memory
    const peakBytes = stopMemoryMonitoring();

    // Emit summary before final status
    emitSummary();

    console.log(
      JSON.stringify({
        type: "status",
        status: "completed",
        id: test.meta.id,
        peakMemoryBytes: peakBytes,
        peakMemoryMB: (peakBytes / 1024 / 1024).toFixed(2),
      })
    );
  } catch (error) {
    stopMemoryMonitoring();
    throw error;
  }
}

