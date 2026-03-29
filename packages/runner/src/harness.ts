/**
 * Harness script - runs INSIDE the Node.js subprocess (via tsx).
 * This is the bridge between the Runner and User Code.
 *
 * Usage:
 *   tsx harness.ts --testUrl=<url> --testId=<id>
 */

import { parseArgs } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { inferJsonSchema, truncateDeep } from "./schema_inference.js";

/* eslint-disable no-var */
declare global {
  var __glubeanRuntime: {
    vars: Record<string, string>;
    secrets: Record<string, string>;
    http: Record<string, unknown>;
    test: Record<string, unknown>;
    trace: (t: import("@glubean/sdk").Trace) => void;
    action: (a: import("@glubean/sdk").GlubeanAction) => void;
    event: (ev: import("@glubean/sdk").GlubeanEvent) => void;
    log: (message: string, data?: unknown) => void;
  };
}
/* eslint-enable no-var */
import ky, { type KyInstance, type Options as KyOptions, type NormalizedOptions } from "ky";
import type {
  Trace,
  AssertionDetails,
  AssertionResultInput,
  GlubeanAction,
  GlubeanEvent,
  HttpClient as _HttpClient,
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
process.on("uncaughtException", (error) => {
  console.log(
    JSON.stringify({
      type: "status",
      status: "failed",
      error: error?.message || "Unknown error",
      stack: error?.stack,
    }),
  );
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  console.log(
    JSON.stringify({
      type: "status",
      status: "failed",
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    }),
  );
  process.exit(1);
});

// Parse CLI arguments
const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    testUrl: { type: "string" },
    testId: { type: "string" },
    testIds: { type: "string" },
    exportName: { type: "string" },
    exportNames: { type: "string" },
    concurrency: { type: "string" },
    emitFullTrace: { type: "boolean", default: false },
    inferSchema: { type: "boolean", default: false },
    truncateArrays: { type: "boolean", default: false },
  },
  strict: false,
});

/** When true, auto-trace includes request/response headers and bodies. */
const emitFullTrace = args.emitFullTrace ?? false;
/** When true, infer JSON Schema from response bodies. */
const inferSchema = args.inferSchema ?? false;
/** When true, always truncate arrays in trace bodies (not just >1MB). */
const truncateArrays = args.truncateArrays ?? false;

const testUrl = args.testUrl as string | undefined;
const testId = args.testId as string | undefined;
/**
 * Comma-separated list of test IDs for file-level batch mode.
 * When set, all tests run sequentially in a single process, preserving
 * module-level state (e.g. shared `let` variables between tests).
 */
const testIds = args.testIds ? (args.testIds as string).split(",") : undefined;
/**
 * Max concurrency for parallel batch mode.
 * When > 1 and testIds is set, parallel-marked tests run concurrently via p-queue.
 * Default 1 (sequential).
 */
const batchConcurrency = Math.max(1, parseInt(args.concurrency as string, 10) || 1);
/** Optional export name for fallback lookup (used by test.pick/test.each). */
const exportName = args.exportName as string | undefined;
/** Optional testId→exportName mapping for batch mode fallback (test.pick). */
const exportNamesMap: Record<string, string> = {};
if (args.exportNames) {
  for (const pair of (args.exportNames as string).split(",")) {
    const sep = pair.indexOf(":");
    if (sep > 0) {
      exportNamesMap[pair.slice(0, sep)] = pair.slice(sep + 1);
    }
  }
}

if (!testUrl) {
  console.log(
    JSON.stringify({
      type: "error",
      message: "Missing required argument: --testUrl",
    }),
  );
  process.exit(1);
}

/**
 * Read context data from stdin.
 * Context is passed via stdin instead of CLI args to avoid length limits and security issues.
 *
 * @returns The context JSON string from stdin
 */
async function readContextFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// Parse context data from stdin
const contextJson = await readContextFromStdin();
const contextData = contextJson ? JSON.parse(contextJson) : {};
const rawVars = (contextData.vars ?? {}) as Record<string, string>;
const rawSecrets = (contextData.secrets ?? {}) as Record<string, string>;
// Execution-level retry metadata injected by executor/control plane.
// 0 => first execution attempt.
const retryCount = (contextData.retryCount ?? 0) as number;
const sessionData = (contextData.session ?? {}) as Record<string, unknown>;
const sessionMode = contextData.sessionMode as "setup" | "teardown" | undefined;

function normalizeTestTags(
  input: string | string[] | undefined,
): string[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.filter((tag): tag is string => typeof tag === "string");
  return [input];
}

function parseRuntimeTestMetadata(
  input: unknown,
): { id: string; tags: string[] } {
  const candidate = input && typeof input === "object" ? (input as { id?: unknown; tags?: unknown }) : undefined;
  const id = typeof candidate?.id === "string" ? candidate.id : (testId ?? "");
  const tags = Array.isArray(candidate?.tags)
    ? candidate.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  return { id, tags };
}

const runtimeTest = parseRuntimeTestMetadata(contextData.test);

// Memory monitoring state (per-process — not isolated per-test)
let peakMemoryBytes = 0;
let memoryCheckInterval: number | undefined;

// ---------------------------------------------------------------------------
// Per-test execution context via AsyncLocalStorage
// ---------------------------------------------------------------------------

/**
 * Holds all mutable state scoped to a single test execution.
 * Accessed via `testContext.getStore()!` from anywhere in the async call chain
 * (ky hooks, globalFetch override, ctx.assert, etc.) without explicit passing.
 *
 * Analogous to Java's ThreadLocal but tracks Node.js async continuations.
 */
class TestRunContext {
  // Step-level assertion tracking
  stepFailedAssertions = 0;
  stepAssertionTotal = 0;
  currentStepIndex: number | null = null;

  // HTTP request counters
  httpRequestTotal = 0;
  httpErrorTotal = 0;

  // Runtime identity
  testMeta: { id: string; tags: string[] };

  constructor(
    readonly testId: string,
    meta: { id: string; tags: string[] },
  ) {
    this.testMeta = meta;
  }
}

const testContext = new AsyncLocalStorage<TestRunContext>();

/**
 * Get the current test's execution context.
 * Returns undefined when not inside a test (e.g., module load phase).
 */
function currentTestCtx(): TestRunContext | undefined {
  return testContext.getStore();
}

// Accessor helpers — read from ALS when inside a test, safe defaults otherwise.
// These replace direct reads of the old global variables.
function getStepIndex(): number | null {
  return currentTestCtx()?.currentStepIndex ?? null;
}
function getStepAssertionTotal(): number {
  return currentTestCtx()?.stepAssertionTotal ?? 0;
}
function getStepFailedAssertions(): number {
  return currentTestCtx()?.stepFailedAssertions ?? 0;
}
function incrAssertions(passed: boolean): void {
  const trc = currentTestCtx();
  if (trc) {
    trc.stepAssertionTotal++;
    if (!passed) trc.stepFailedAssertions++;
  }
}

/**
 * Emit a JSON event to stdout, auto-injecting `testId` when inside a test context.
 * Use this for all test-scoped event output to ensure concurrent events can be
 * attributed to the correct test.
 */
function emitEvent(event: Record<string, unknown>): void {
  const trc = currentTestCtx();
  if (trc) {
    console.log(JSON.stringify({ ...event, testId: trc.testId }));
  } else {
    console.log(JSON.stringify(event));
  }
}


/**
 * Start monitoring memory usage.
 * Samples memory every 100ms and tracks peak usage.
 */
function startMemoryMonitoring(): void {
  const initial = process.memoryUsage();
  peakMemoryBytes = initial.heapUsed;

  memoryCheckInterval = setInterval(() => {
    try {
      const mem = process.memoryUsage();
      peakMemoryBytes = Math.max(peakMemoryBytes, mem.heapUsed);
    } catch {
      // Ignore errors during monitoring
    }
  }, 100) as unknown as number;
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
 * Sentinel error used for step-level timeout failures.
 * Timeouts are treated as terminal for the step and do not retry.
 */
class StepTimeoutError extends Error {
  constructor(stepName: string, timeoutMs: number) {
    super(`Step "${stepName}" timed out after ${timeoutMs}ms`);
    this.name = "StepTimeoutError";
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
  type: "var" | "secret",
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
    
    const obj = entry as { schema: SchemaLike<T>; severity?: "error" | "warn" | "fatal" };
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
  severity: "error" | "warn" | "fatal",
): { success: true; data: T } | { success: false; issues: SchemaIssue[] } {
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
      
      const errObj = err as { issues?: ReadonlyArray<{ message?: string; path?: ReadonlyArray<PropertyKey> }> };
      if (errObj?.issues && Array.isArray(errObj.issues)) {
        issues = errObj.issues.map(
          (i: { message?: string; path?: ReadonlyArray<PropertyKey> }) => ({
            message: i.message ?? String(i),
            ...(i.path && { path: i.path }),
          }),
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
  emitEvent({
    type: "schema_validation",
    label,
    success,
    severity,
    ...(issues.length > 0 && { issues }),
    ...(getStepIndex() !== null && { stepIndex: getStepIndex() }),
  });

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
        // Route through assertion pipeline so it counts as a failed assertion
        ctx.assert(false, msg);
        break;
      case "warn":
        ctx.warn(false, msg);
        break;
      case "fatal":
        // Emit failed assertion, then throw to abort
        ctx.assert(false, msg);
        throw new FailError(msg);
    }

    return { success: false, issues };
  }

  return { success: true, data: parsed as T };
}

// Helper: resolve a value from explicit context, falling back to system env.
// Priority: .env/.env.secrets (rawVars/rawSecrets) > system environment variable
function resolveValue(
  explicit: Record<string, string>,
  key: string,
): string | undefined {
  const value = explicit[key];
  if (value !== undefined && value !== null && value !== "") return value;
  // Fallback to system environment (e.g., CI-injected vars)
  return process.env[key] ?? undefined;
}

// Construct TestContext with streaming output
// (http field is attached after ky instance creation below)
const ctx = {
  vars: {
    get: (key: string) => resolveValue(rawVars, key),
    require: (
      key: string,
      validate?: (value: string) => boolean | string | void | null,
    ) => {
      const value = resolveValue(rawVars, key);
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
    get: (key: string) => resolveValue(rawSecrets, key),
    require: (
      key: string,
      validate?: (value: string) => boolean | string | void | null,
    ) => {
      const value = resolveValue(rawSecrets, key);
      if (value === undefined || value === null || value === "") {
        throw new Error(`Missing required secret: ${key}`);
      }
      if (validate) {
        runValidator(validate(value), key, "secret");
      }
      return value;
    },
  },
  session: {
    get: (key: string) => sessionData[key],
    require: (key: string) => {
      const value = sessionData[key];
      if (value === undefined) {
        throw new Error(
          `Session key '${key}' is required but not set. Check your session.ts setup.`,
        );
      }
      return value;
    },
    set: (key: string, value: unknown) => {
      sessionData[key] = value;
      emitEvent({ type: "session:set", key, value, ts: Date.now() });
    },
    entries: () => ({ ...sessionData }),
  },

  // Logging function
  log: (message: string, data?: unknown) => {
    emitEvent({
      type: "log",
      message,
      data,
      ...(getStepIndex() !== null && { stepIndex: getStepIndex() }),
    });
  },

  // Assertion function with overloads
  // Overload 1: assert(condition: boolean, message?: string, details?: AssertionDetails)
  // Overload 2: assert(result: AssertionResultInput, message?: string)
  assert: (
    arg1: boolean | AssertionResultInput,
    arg2?: string | AssertionDetails,
    arg3?: AssertionDetails,
  ) => {
    let passed: boolean;
    let message: string;
    let actual: unknown;
    let expected: unknown;

    if (typeof arg1 === "boolean") {
      // Overload 1: assert(condition, message?, details?)
      passed = arg1;
      message = (typeof arg2 === "string" ? arg2 : undefined) ||
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
      message = (typeof arg2 === "string" ? arg2 : undefined) ||
        (passed ? "Assertion passed" : "Assertion failed");
    }

    // Track per-step assertion stats (used for step retry logic + step_end event)
    incrAssertions(passed);

    emitEvent({
      type: "assertion",
      passed,
      message,
      // Truncate actual/expected on pass to save tokens; keep full on fail for debugging
      actual: passed && truncateArrays ? truncateDeep(actual) : actual,
      expected: passed && truncateArrays ? truncateDeep(expected) : expected,
      ...(getStepIndex() !== null && { stepIndex: getStepIndex() }),
    });
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
        result.message,
      );
    });
  },

  // Warning function — soft check, never affects test pass/fail.
  // condition=true means OK; condition=false triggers warning.
  warn: (condition: boolean, message: string) => {
    emitEvent({
      type: "warning",
      condition,
      message,
      ...(getStepIndex() !== null && { stepIndex: getStepIndex() }),
    });
  },

  // Schema validation function
  validate: <T>(
    data: unknown,
    schema: SchemaLike<T>,
    label?: string,
    options?: ValidateOptions,
  ): T | undefined => {
    const result = runSchemaValidation(
      data,
      schema,
      label ?? "data",
      options?.severity ?? "error",
    );
    return result.success ? result.data : undefined;
  },

  // Protocol tracing function (HTTP, gRPC, WebSocket, etc.)
  trace: (request: Trace) => {
    emitEvent({
      type: "trace",
      data: request,
      ...(getStepIndex() !== null && { stepIndex: getStepIndex() }),
    });
  },

  // Action recording function
  action: (a: GlubeanAction) => {
    emitEvent({
      type: "action",
      data: a,
      ...(getStepIndex() !== null && { stepIndex: getStepIndex() }),
    });
  },

  // Structured event emission
  event: (ev: GlubeanEvent) => {
    emitEvent({
      type: "event",
      data: ev,
      ...(getStepIndex() !== null && { stepIndex: getStepIndex() }),
    });
  },

  // Metric reporting function
  metric: (name: string, value: number, options?: MetricOptions) => {
    emitEvent({
      type: "metric",
      name,
      value,
      unit: options?.unit,
      tags: options?.tags,
      ...(getStepIndex() !== null && { stepIndex: getStepIndex() }),
    });
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
    emitEvent({
      type: "assertion",
      passed: false,
      message,
    });
    throw new FailError(message);
  },

  /**
   * Poll a function until it returns truthy or times out.
   */
  pollUntil: async (
    options: PollUntilOptions,
    fn: () => Promise<boolean | unknown>,
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
    emitEvent({ type: "timeout_update", timeout: ms });
  },

  /**
   * Current execution retry count (0 for first attempt).
   * This reflects whole-test re-runs, not per-step retries.
   */
  retryCount,

  /**
   * Get current memory usage via `process.memoryUsage()`.
   * Useful for debugging memory issues locally.
   *
   * @returns Memory usage stats
   *
   * @example
   * const mem = ctx.getMemoryUsage();
   * ctx.log(`Heap used: ${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`);
   */
  getMemoryUsage: () => {
    return process.memoryUsage();
  },
} as unknown as TestContext;

// ---------------------------------------------------------------------------
// Auto-tracing HTTP client (ctx.http) — powered by ky
// ---------------------------------------------------------------------------
// Per-request state stored in a WeakMap keyed by the ky NormalizedOptions
// object (which IS the same reference in beforeRequest and afterResponse).
// This avoids the read-await-write race that global variables had when
// multiple requests were in flight (e.g. Promise.all).
interface RequestTraceState {
  startTime: number;
  body?: unknown;
}
const requestTraceMap = new WeakMap<NormalizedOptions, RequestTraceState>();

/** Max serialized body size (chars) to include in trace events. */
const TRACE_BODY_MAX_SIZE = 1_048_576; // 1MB

/**
 * Truncate a response body if its JSON representation exceeds the size limit.
 * Preserves structure: arrays are sliced and a count annotation is appended
 * so the trace file stays valid JSON and diffable.
 */

function truncateBody(body: unknown): unknown {
  try {
    const json = JSON.stringify(body);
    if (json.length <= TRACE_BODY_MAX_SIZE) return body;

    if (typeof body === "object" && body !== null) {
      // For arrays, keep first few items + count
      if (Array.isArray(body)) {
        const preview = body.slice(0, 3);
        return [...preview, `(${body.length - 3} more items truncated)`];
      }
      // For objects with large array values, truncate those arrays
      const pruned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (Array.isArray(value) && value.length > 3) {
          pruned[key] = [
            ...value.slice(0, 3),
            `(${value.length - 3} more items truncated)`,
          ];
        } else {
          pruned[key] = value;
        }
      }
      const rechecked = JSON.stringify(pruned);
      if (rechecked.length <= TRACE_BODY_MAX_SIZE * 1.5) return pruned;
    }

    return { _truncated: true, _sizeBytes: json.length };
  } catch {
    return "(non-serializable)";
  }
}

/**
 * Reset per-test counters for file-level batch mode.
 * Called before each test when running multiple tests in a single process.
 */
/**
 * Reset per-process state between tests in batch mode.
 * Per-test state is now handled by TestRunContext via AsyncLocalStorage —
 * each test gets a fresh instance, so no reset is needed for those.
 */
function resetTestCounters() {
  peakMemoryBytes = 0;
}


const kyInstance = ky.create({
  throwHttpErrors: false,
  hooks: {
    beforeRequest: [
      
      (_request: Request, options: NormalizedOptions) => {
        requestTraceMap.set(options, {
          startTime: performance.now(),
          body: emitFullTrace
            ? ((options as unknown as Record<string, unknown>).json ?? options.body ?? undefined)
            : undefined,
        });
      },
    ],
    afterResponse: [
      
      async (request: Request, _options: NormalizedOptions, response: Response) => {
        const trace = requestTraceMap.get(_options);
        const duration = Math.round(performance.now() - (trace?.startTime ?? performance.now()));

        // Increment HTTP counters for summary
        { const t = currentTestCtx(); if (t) { t.httpRequestTotal++; if (response.status >= 400) t.httpErrorTotal++; } }

        // Build trace data — new unified fields + deprecated HTTP fields for backward compat
        let pathname: string;
        try { pathname = new URL(request.url).pathname; } catch { pathname = request.url; }

        const traceData: Record<string, unknown> = {
          // New unified fields
          protocol: "http",
          target: `${request.method} ${pathname}`,
          durationMs: duration,
          ok: response.status < 400,
          // Deprecated HTTP fields (backward compat)
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
            request.headers.entries(),
          );
          if (trace?.body !== undefined) {
            traceData.requestBody = truncateBody(trace.body);
          }
          traceData.responseHeaders = Object.fromEntries(
            response.headers.entries(),
          );

          // Clone the response to read the body without consuming the original stream
          try {
            const cloned = response.clone();
            const contentType = response.headers.get("content-type") || "";
            let parsedBody: unknown;

            if (contentType.includes("json")) {
              parsedBody = await cloned.json();
            } else if (
              contentType.includes("text") ||
              contentType.includes("xml")
            ) {
              parsedBody = await cloned.text();
            }

            if (parsedBody !== undefined) {
              // Schema inference runs on the FULL body before any truncation
              if (inferSchema && typeof parsedBody === "object" && parsedBody !== null) {
                traceData.responseSchema = inferJsonSchema(parsedBody);
              }

              // Truncate body: aggressive (truncateArrays) or default (>1MB only)
              if (truncateArrays) {
                traceData.responseBody = truncateDeep(parsedBody);
              } else {
                traceData.responseBody = truncateBody(parsedBody);
              }
            }
            // Binary content types are intentionally skipped
          } catch {
            // Ignore clone/parse errors — trace still emits without body
          }
          // Per-request state is on the options object; no global cleanup needed.
        }

        ctx.trace(traceData as unknown as Trace);

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

type KyOptionsWithSchema = KyOptions & { schema?: HttpSchemaOptions };

function normalizeOptions(options?: KyOptionsWithSchema): KyOptionsWithSchema | undefined {
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

function runPreRequestSchemaValidation(options?: KyOptionsWithSchema): void {
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
  
  responsePromise: ReturnType<KyInstance["get"]>,
  schemaOpts?: HttpSchemaOptions,

): ReturnType<KyInstance["get"]> {
  if (!schemaOpts?.response) return responsePromise;

  const { schema, severity } = resolveSchemaEntry(schemaOpts.response);

  // Wrap the .json() method to validate after parsing (monkey-patch requires cast)
  const originalJson = responsePromise.json.bind(responsePromise);
  (responsePromise as { json: typeof originalJson }).json = async <J = unknown>() => {
    const body = await originalJson();
    runSchemaValidation(body, schema, "response body", severity);
    return body as J;
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

type KyFn = (input: string | URL | Request, options?: KyOptions) => ReturnType<KyInstance["get"]>;

const glubeanDebug = !!process.env["GLUBEAN_DEBUG"];

function wrapKy(instance: KyInstance, label = "base"): Record<string, unknown> {
  const methods = ["get", "post", "put", "patch", "delete", "head"] as const;

  function callWithSchema(
    kyFn: KyFn,
    input: string | URL | Request,
    options?: KyOptionsWithSchema,
  ) {
    const normalized = normalizeOptions(options);
    // Run pre-request validations (query, request body)
    runPreRequestSchemaValidation(normalized);
    // Strip schema option before passing to ky (ky doesn't know about it)
    let kyOptions: KyOptions | undefined;
    if (normalized?.schema) {
      const { schema: _schema, ...rest } = normalized;
      kyOptions = rest;
    } else {
      kyOptions = normalized;
    }
    if (glubeanDebug) {
      process.stderr.write(`[glubean:debug] ky.call [${label}] url=${String(input)} per-call-options=${JSON.stringify(kyOptions ?? null)}\n`);
    }
    const responsePromise = kyFn(normalizeUrl(input), kyOptions);
    return wrapResponseWithSchema(responsePromise, normalized?.schema);
  }

  // The callable + methods wrapper
  const baseFn = (input: string | URL | Request, options?: KyOptionsWithSchema) => {
    return callWithSchema(instance as unknown as KyFn, input, options);
  };
  const wrapped = baseFn as unknown as Record<string, unknown>;

  for (const method of methods) {
    wrapped[method] = (input: string | URL | Request, options?: KyOptionsWithSchema) =>
      callWithSchema(instance[method].bind(instance) as KyFn, input, options);
  }

  wrapped.extend = (options?: KyOptionsWithSchema) => {
    const normalized = normalizeOptions(options) as KyOptions;
    if (glubeanDebug) {
      process.stderr.write(`[glubean:debug] wrapKy.extend [${label}] options=${JSON.stringify(normalized ?? null)}\n`);
    }
    return wrapKy(instance.extend(normalized), `${label}>extend`);
  };

  return wrapped;
}

// Attach wrapped http client to ctx

const wrappedHttp = wrapKy(kyInstance);
(ctx as unknown as { http: Record<string, unknown> }).http = wrappedHttp;

// Set global runtime slot for configure() API.
// configure() returns lazy getters that read from this slot at test execution time.
// This must be set BEFORE importing user code so the slot is available during execution.
//
// Wrap vars and secrets with a Proxy so that configure()'s requireVar/requireSecret
// also fall back to system env (same behavior as ctx.vars/ctx.secrets above).
function withEnvFallback(
  explicit: Record<string, string>,
): Record<string, string> {
  return new Proxy(explicit, {
    get(target, prop: string) {
      const value = target[prop];
      if (value !== undefined && value !== null && value !== "") return value;
      return process.env[prop] || undefined;
    },
    has(target, prop: string) {
      return prop in target || process.env[prop] !== undefined;
    },
  });
}


globalThis.__glubeanRuntime = {
  vars: withEnvFallback(rawVars),
  secrets: withEnvFallback(rawSecrets),
  http: wrappedHttp,
  // Getter: returns per-test metadata from ALS when inside a test,
  // falls back to the initial runtimeTest (module load phase).
  get test() {
    return currentTestCtx()?.testMeta ?? runtimeTest;
  },
  set test(value) {
    const trc = currentTestCtx();
    if (trc) trc.testMeta = value;
  },
  trace: ctx.trace,
  action: ctx.action,
  event: ctx.event,
  log: ctx.log,
};

try {
  // Dynamic import - LOAD phase
  console.log(
    JSON.stringify({
      type: "log",
      message: `Loading test module: ${testUrl}`,
    }),
  );

  const userModule = await import(testUrl!);

  // ── Session mode: run setup() or teardown() instead of tests ──
  if (sessionMode) {
    const def = userModule.default;
    if (!def || typeof def.setup !== "function") {
      console.log(
        JSON.stringify({
          type: "status",
          status: "failed",
          error: `Session file must export a default SessionDefinition with a setup() function. Got: ${typeof def}`,
        }),
      );
      process.exit(1);
    }

    const sessionCtx = {
      vars: ctx.vars,
      secrets: ctx.secrets,
      http: ctx.http,
      session: ctx.session,
      log: ctx.log,
    };

    // Session setup/teardown needs an ALS context so network policy
    // counters (in globalFetch override) work correctly.
    const sessionTrc = new TestRunContext("__session__", { id: "__session__", tags: [] });
    await testContext.run(sessionTrc, async () => {
      try {
        if (sessionMode === "setup") {
          await def.setup(sessionCtx);
        } else if (sessionMode === "teardown" && typeof def.teardown === "function") {
          await def.teardown(sessionCtx);
        }
        emitEvent({ type: "status", status: "completed" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        emitEvent({
          type: "status",
          status: "failed",
          error: message,
          ...(stack && { stack }),
        });
      }
    });
    process.exit(0);
  }

  // ── Normal test mode: testId or testIds required ──
  if (!testId && !testIds) {
    console.log(
      JSON.stringify({
        type: "error",
        message: "Missing required arguments: --testId or --testIds",
      }),
    );
    process.exit(1);
  }

  if (testIds) {
    // ── File-level batch mode ──
    // Runs multiple tests in a single process, preserving module-level state.
    // When batchConcurrency > 1, tests run concurrently via p-queue
    // (opt-in via test.each({ parallel: true }) + --concurrency flag).
    let hasFailure = false;

    const runOneTest = async (id: string): Promise<void> => {
      resetTestCounters();
      let testObj = findTestById(userModule, id);
      if (!testObj && exportNamesMap[id]) {
        testObj = findTestByExport(userModule, exportNamesMap[id]);
      }
      if (!testObj) {
        console.log(JSON.stringify({ type: "start", id, name: id, testId: id }));
        console.log(JSON.stringify({ type: "status", status: "failed", id, testId: id, error: `Test "${id}" not found in module` }));
        hasFailure = true;
        return;
      }
      try {
        await executeNewTest(testObj);
      } catch (error) {
        if (error instanceof SkipError) {
          console.log(JSON.stringify({ type: "status", status: "skipped", id, testId: id, reason: error.reason }));
        } else {
          hasFailure = true;
          console.log(JSON.stringify({
            type: "status", status: "failed", id, testId: id,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          }));
        }
      }
    };

    if (batchConcurrency > 1) {
      const { default: PQueue } = await import("p-queue");
      const queue = new PQueue({ concurrency: batchConcurrency });
      for (const id of testIds) {
        void queue.add(() => runOneTest(id));
      }
      await queue.onIdle();
    } else {
      for (const id of testIds) {
        await runOneTest(id);
      }
    }

    process.exit(hasFailure ? 1 : 0);
  }

  // ── Wildcard mode: run all tests in file ──
  if (testId === "*") {
    const allTests = resolveModuleTests(userModule);
    if (allTests.length === 0) {
      throw new Error("No tests found in module");
    }
    let hasFailure = false;
    for (const resolved of allTests) {
      resetTestCounters();
      const obj = findTestById(userModule, resolved.id);
      if (!obj) continue;
      try {
        await executeNewTest(obj);
      } catch (error) {

        if (error instanceof SkipError) {
          console.log(JSON.stringify({ type: "status", status: "skipped", id: resolved.id, testId: resolved.id, reason: (error as SkipError).reason }));
        } else {
          hasFailure = true;
          console.log(JSON.stringify({ type: "status", status: "failed", id: resolved.id, testId: resolved.id, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }));
        }
      }
    }
    process.exit(hasFailure ? 1 : 0);
  }

  // ── Single test mode (default) ──
  let testObj = findTestById(userModule, testId!);
  if (!testObj && exportName) {
    // Fallback: for non-deterministic tests (test.pick), the testId from
    // discovery may not match this run's random selection. Use the stable
    // exportName to locate the export and pick the first resolved test.
    testObj = findTestByExport(userModule, exportName);
  }
  if (testObj) {
    await executeNewTest(testObj);
    process.exit(0);
  } else {
    throw new Error(
      `Test "${testId}" not found. Available exports: ${
        Object.keys(
          userModule,
        ).join(", ")
      }`,
    );
  }
} catch (error) {
  // Include testId when known (single test mode)
  const tid = testId && testId !== "*" ? testId : undefined;

  // Check if this is a skip error
  if (error instanceof SkipError) {
    console.log(
      JSON.stringify({
        type: "status",
        status: "skipped",
        ...(tid && { testId: tid }),
        reason: error.reason,
      }),
    );
    process.exit(0); // Exit cleanly for skipped tests
  }

  // Regular error - report as failure
  console.log(
    JSON.stringify({
      type: "status",
      status: "failed",
      ...(tid && { testId: tid }),
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
  );
  process.exit(1);
}

// Resolution utilities shared with MCP and other consumers.
// Extracted to resolve.ts for reuse outside the sandbox.
import { findTestByExport, findTestById, resolveModuleTests } from "./resolve.js";

/**
 * Resolve test.extend() fixtures and run the test body with an augmented context.
 *
 * Simple fixtures (1-param) are resolved first; their return values are merged
 * into the context via prototype-linked copy. Lifecycle fixtures (2-param with
 * `use` callback) wrap the test execution so cleanup runs after the test completes.
 *
 * Fixture type is determined by `fn.length`:
 * - 1 → simple factory: `(ctx) => instance`
 * - 2 → lifecycle factory: `(ctx, use) => { setup; await use(instance); cleanup }`
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FixtureFactory = (ctx: TestContext, use?: (value: any) => Promise<void>) => any;

async function withFixtures(
  
  fixtures: Record<string, FixtureFactory>,
  baseCtx: TestContext,
  runTest: (ctx: TestContext) => Promise<void>,
): Promise<void> {
  // Prototype-linked copy: core ctx fields (vars, secrets, http, ...) remain accessible
  const augmented = Object.create(baseCtx) as TestContext;

  const simple: [string, FixtureFactory][] = [];
  const lifecycle: [string, FixtureFactory][] = [];

  for (const [key, fn] of Object.entries(fixtures)) {
    if (fn.length >= 2) {
      lifecycle.push([key, fn]);
    } else {
      simple.push([key, fn]);
    }
  }

  // Resolve simple fixtures first
  for (const [key, fn] of simple) {
    (augmented as unknown as Record<string, unknown>)[key] = await fn(augmented);
  }

  // No lifecycle fixtures — run the test directly
  if (lifecycle.length === 0) {
    await runTest(augmented);
    return;
  }

  // Build a nested chain for lifecycle fixtures.
  // Each lifecycle wraps the next; the innermost call is the actual test.
  let innerFn: () => Promise<void> = () => runTest(augmented);

  for (let i = lifecycle.length - 1; i >= 0; i--) {
    const [key, factory] = lifecycle[i];
    const next = innerFn;
    innerFn = () => {
      let called = false;
      // Capture the promise created inside use() so we can ensure the test
      // body completes even if the fixture forgets to `await use(...)`.
      let usePromise: Promise<void> | null = null;

      return factory(augmented, (instance: unknown): Promise<void> => {
        if (called) {
          throw new Error(
            `Lifecycle fixture "${key}" called use() more than once. ` +
              `Each fixture must call use() exactly once.`,
          );
        }
        called = true;
        (augmented as unknown as Record<string, unknown>)[key] = instance;
        usePromise = next();
        return usePromise;
      }).then(async () => {
        if (!called) {
          throw new Error(
            `Lifecycle fixture "${key}" completed without calling use(). ` +
              `Lifecycle fixtures must call use(instance) exactly once ` +
              `to run the test body.`,
          );
        }
        // If fixture didn't await use(), wait for the test body to finish
        // before proceeding. When properly awaited this is a no-op.
        if (usePromise) {
          await usePromise;
        }
      });
    };
  }

  await innerFn();
}

/**
 * Execute a test created with the builder API.
 * Handles both simple tests and multi-step tests with setup/teardown.
 * When the test carries `fixtures` (from `test.extend()`), they are resolved
 * and injected into the context before the test body runs.
 *
 * @param test The Test object to execute
 */
async function executeNewTest(test: Test<unknown>): Promise<void> {
  const testTags = normalizeTestTags(test.meta.tags);
  const testMeta = { id: test.meta.id, tags: testTags };
  const trc = new TestRunContext(test.meta.id, testMeta);

  // Run the test body inside an AsyncLocalStorage context so all
  // downstream code (ctx.assert, ky hooks, globalFetch) can access
  // the per-test state via currentTestCtx().
  await testContext.run(trc, async () => {

  // Runtime metadata is now served via ALS getter on __glubeanRuntime.test
  emitEvent({
    type: "start",
    id: test.meta.id,
    name: test.meta.name || test.meta.id,
    tags: testTags,
    ...(retryCount > 0 && { retryCount }),
  });

  // Start memory monitoring
  startMemoryMonitoring();

  try {
    // Core test body — receives the effective ctx (base or fixture-augmented)
    const runTestBody = async (effectiveCtx: TestContext) => {
      if (test.type === "simple") {
        if (!test.fn) {
          throw new Error(`Invalid test "${test.meta.id}": missing fn`);
        }
        await test.fn(effectiveCtx);
      } else {
        let state: unknown = undefined;
        let stepFailed = false;
        try {
          if (test.setup) {
            emitEvent({
              type: "log",
              message: "Running setup...",
            });
            state = await test.setup(effectiveCtx);
          }
          if (test.steps) {
            for (let i = 0; i < test.steps.length; i++) {
              const step = test.steps[i];

              // If a previous step failed, skip remaining steps
              if (stepFailed) {
                emitEvent({
                  type: "step_end",
                  index: i,
                  name: step.meta.name,
                  status: "skipped",
                  durationMs: 0,
                  assertions: 0,
                  failedAssertions: 0,
                });
                continue;
              }

              // Reset per-step assertion counters and set step scope
              { const trc = currentTestCtx()!; trc.stepFailedAssertions = 0; trc.stepAssertionTotal = 0; trc.currentStepIndex = i; }
              const stepStart = performance.now();

              emitEvent({
                type: "step_start",
                index: i,
                name: step.meta.name,
                total: test.steps.length,
              });

              let stepError: string | undefined;
              let stepReturnState: unknown = undefined;
              const retries = step.meta.retries;
              const configuredRetries = typeof retries === "number" && Number.isFinite(retries)
                ? Math.max(0, Math.floor(retries))
                : 0;
              const stepTimeout = step.meta.timeout;
              const configuredStepTimeout = typeof stepTimeout === "number" && Number.isFinite(stepTimeout)
                ? Math.floor(stepTimeout)
                : 0;
              const stepTimeoutMs = configuredStepTimeout > 0 ? configuredStepTimeout : undefined;
              const maxAttempts = configuredRetries + 1;
              let attemptsUsed = 0;
              let lastFailedAssertions = 0;
              let lastAssertions = 0;
              let timeoutFailure = false;

              for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                attemptsUsed = attempt;
                stepError = undefined;
                stepReturnState = undefined;
                { const trc = currentTestCtx()!; trc.stepFailedAssertions = 0; trc.stepAssertionTotal = 0; }
                timeoutFailure = false;
                let stepTimeoutId: ReturnType<typeof setTimeout> | undefined;

                try {
                  const stepResult = step.fn(effectiveCtx, state);
                  // Note: timed-out step bodies cannot be force-cancelled in JS.
                  // We treat timeout as terminal (no further retries) to avoid
                  // overlapping attempts mutating shared step context.
                  const result = stepTimeoutMs === undefined ? await stepResult : await Promise.race([
                    stepResult,
                    new Promise<never>((_, reject) => {
                      stepTimeoutId = setTimeout(() => {
                        reject(
                          new StepTimeoutError(step.meta.name, stepTimeoutMs),
                        );
                      }, stepTimeoutMs);
                    }),
                  ]);
                  if (result !== undefined) {
                    state = result;
                    stepReturnState = result;
                  }
                } catch (err) {
                  stepError = err instanceof Error ? err.message : String(err);
                  timeoutFailure = err instanceof StepTimeoutError;
                } finally {
                  if (stepTimeoutId !== undefined) {
                    clearTimeout(stepTimeoutId);
                  }
                }

                lastFailedAssertions = getStepFailedAssertions();
                lastAssertions = getStepAssertionTotal();

                const attemptFailed = !!stepError || getStepFailedAssertions() > 0;
                if (!attemptFailed) {
                  break;
                }

                // Timeouts are terminal to avoid overlapping attempts from
                // dangling async operations in the timed-out step body.
                if (timeoutFailure) {
                  break;
                }

                if (attempt < maxAttempts) {
                  const reason = stepError ? stepError : `${getStepFailedAssertions()} failed assertion(s)`;
                  emitEvent({
                    type: "log",
                    stepIndex: i,
                    message: `Retrying step "${step.meta.name}" (${
                      attempt + 1
                    }/${maxAttempts}) after failure: ${reason}`,
                  });
                }
              }

              const durationMs = Math.round(performance.now() - stepStart);
              const failed = !!stepError || lastFailedAssertions > 0;

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

              emitEvent({
                type: "step_end",
                index: i,
                name: step.meta.name,
                status: failed ? "failed" : "passed",
                durationMs,
                assertions: lastAssertions,
                failedAssertions: lastFailedAssertions,
                attempts: attemptsUsed,
                retriesUsed: Math.max(0, attemptsUsed - 1),
                ...(stepError && { error: stepError }),
                ...(returnStatePayload !== undefined && {
                  returnState: returnStatePayload,
                }),
              });

              currentTestCtx()!.currentStepIndex = null;

              if (failed) {
                stepFailed = true;
                // Don't throw here — let the loop continue to emit skip events
              }
            }
          }
        } finally {
          if (test.teardown) {
            try {
              emitEvent({
                type: "log",
                message: "Running teardown...",
              });
              await test.teardown(effectiveCtx, state);
            } catch (teardownError) {
              emitEvent({
                type: "log",
                message: `Teardown error: ${
                  teardownError instanceof Error ? teardownError.message : String(teardownError)
                }`,
              });
            }
          }
        }

        // If any step failed (assertion or throw), mark overall test as failed
        if (stepFailed) {
          throw new Error("One or more steps failed");
        }
      }
    };

    // Resolve test.extend() fixtures (if any) and run the test body
    if (test.fixtures && Object.keys(test.fixtures).length > 0) {
      await withFixtures(test.fixtures as Record<string, FixtureFactory>, ctx, runTestBody);
    } else {
      await runTestBody(ctx);
    }

    // Stop monitoring and get peak memory
    const peakBytes = stopMemoryMonitoring();

    emitEvent({
      type: "status",
      status: "completed",
      id: test.meta.id,
      peakMemoryBytes: peakBytes,
      peakMemoryMB: (peakBytes / 1024 / 1024).toFixed(2),
    });
  } catch (error) {
    stopMemoryMonitoring();
    throw error;
  }

  }); // end testContext.run()
}
