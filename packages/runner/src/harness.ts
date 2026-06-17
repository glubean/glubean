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
import { USE_ENGINE, createEngineCore, runViaEngine, engineRoutesId } from "./engine-bridge.js";
import { bootstrap } from "./bootstrap.js";
import { loadProjectOverlays } from "@glubean/scanner";
import {
  setRuntime,
  setExplicitInput,
  setBootstrapInput,
  setForceStandalone,
  type InternalRuntime,
} from "@glubean/sdk/internal";
import ky, { type KyInstance, type Options as KyOptions } from "ky";
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
  StepDefinition,
  Test,
  TestBranchData,
  TestContext,
  ValidateOptions,
} from "@glubean/sdk";
import {
  __activeWorkflowNodeCtx, isTestBranchStep, isTestPollStep } from "@glubean/sdk";
import type { TestPollData } from "@glubean/sdk";
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
const isInteractive = (contextData.interactive ?? false) as boolean;

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
/** Events that STEER THE PARENT while the test is still running — the
 * executor re-arms the subprocess timeout on `timeout_update`, and
 * ProjectRunner forwards `session:set` to sibling files. Holding them in the
 * parallel buffer until the test finishes would defeat them (a long test
 * would be killed at the OLD deadline — codex S2.12 R24 P2), so they bypass
 * buffering. Out-of-order arrival is fine: both are keyed/merged by the
 * parent, not attributed to a contiguous test block. */
const CONTROL_EVENT_TYPES = new Set(["timeout_update", "session:set"]);

function emitEvent(event: Record<string, unknown>): void {
  const trc = currentTestCtx();
  const json = JSON.stringify(trc ? { ...event, testId: trc.testId } : event);
  if (CONTROL_EVENT_TYPES.has(event.type as string)) {
    console.log(json);
    return;
  }
  writeEventLine(json);
}

// ── Parallel-batch event buffering (codex S2.12 R22 P1) ─────────────────────
// Under batchConcurrency > 1, tests run concurrently and their stdout events
// would interleave — downstream collectors (CLI render, result JSON) keep
// per-test state that assumes each test's start..status block is CONTIGUOUS.
// Each parallel task runs inside this ALS with its own line buffer; the task
// flushes the whole buffer atomically (sync loop — no awaits) when it
// finishes. Sequential runs never enter the ALS: zero behavior change.
const parallelEventBuffer = new AsyncLocalStorage<string[]>();

function writeEventLine(json: string): void {
  const buf = parallelEventBuffer.getStore();
  if (buf) buf.push(json);
  else console.log(json);
}

/**
 * Write a wire event produced by the engine path (runner-on-engine, plan 0005).
 * Mirrors emitEvent's control-event bypass, but the event already carries its
 * testId (the engine path runs outside the testContext ALS, so testId is sourced
 * from the engine event's own id, not currentTestCtx()).
 */
function emitEngineWire(ev: Record<string, unknown>): void {
  // Mirror the legacy ctx.session.set: update the subprocess-local sessionData so
  // sibling tests in this process see it (batch mode), in addition to forwarding
  // the control event to the parent (codex P2).
  if (ev.type === "session:set") {
    sessionData[ev.key as string] = ev.value;
  }
  const json = JSON.stringify(ev);
  if (CONTROL_EVENT_TYPES.has(ev.type as string)) {
    console.log(json);
    return;
  }
  writeEventLine(json);
}

// ── vNext workflow per-node evidence → first-class timeline events ──────────
// The SDK's workflow executor emits node evidence as namespaced GlubeanEvents
// over ctx.event (workflow:node_start / node_end / poll_attempt — see
// sdk/src/workflow/execute.ts §17 #9). The harness unwraps the three known
// shapes into first-class timeline events so node id + grade reach
// generateSummary and the Cloud payload directly (§17 #9/#10 consumption).
// Anything else — other `workflow:*` names, malformed payloads — returns null
// and stays a generic pass-through `event` (a misshapen payload must not mint
// a misshapen first-class event).

const NODE_STATUSES = new Set(["passed", "failed", "skipped"]);
const NODE_GRADES = new Set(["full", "partial", "trace", "opaque"]);
const POLL_OUTCOMES = new Set(["satisfied", "probe", "failed"]);

function workflowEventToTimeline(ev: GlubeanEvent): Record<string, unknown> | null {
  if (
    ev.type !== "workflow:node_start" &&
    ev.type !== "workflow:node_end" &&
    ev.type !== "workflow:poll_attempt" &&
    ev.type !== "workflow:branch_decision"
  ) {
    return null;
  }
  const d = ev.data as Record<string, unknown> | undefined;
  if (!d || typeof d.nodeId !== "string") return null;
  const attemptFields = {
    ...(typeof d.attempt === "number" ? { attempt: d.attempt } : {}),
    ...(typeof d.attempts === "number" ? { attempts: d.attempts } : {}),
  };
  if (ev.type === "workflow:node_start") {
    return {
      type: "node_start",
      nodeId: d.nodeId,
      kind: typeof d.kind === "string" ? d.kind : "unknown",
      name: typeof d.name === "string" ? d.name : d.nodeId,
      ...attemptFields,
    };
  }
  if (ev.type === "workflow:node_end") {
    if (typeof d.status !== "string" || !NODE_STATUSES.has(d.status)) return null;
    if (typeof d.grade !== "string" || !NODE_GRADES.has(d.grade)) return null;
    return {
      type: "node_end",
      nodeId: d.nodeId,
      kind: typeof d.kind === "string" ? d.kind : "unknown",
      name: typeof d.name === "string" ? d.name : d.nodeId,
      status: d.status,
      grade: d.grade,
      durationMs: typeof d.durationMs === "number" ? d.durationMs : 0,
      ...(typeof d.error === "string" ? { error: d.error } : {}),
      ...attemptFields,
    };
  }
  if (ev.type === "workflow:poll_attempt") {
    if (
      typeof d.attempt !== "number" ||
      typeof d.outcome !== "string" ||
      !POLL_OUTCOMES.has(d.outcome)
    ) {
      return null;
    }
    return {
      type: "poll_attempt",
      nodeId: d.nodeId,
      attempt: d.attempt,
      outcome: d.outcome,
      durationMs: typeof d.durationMs === "number" ? d.durationMs : 0,
    };
  }
  // workflow:branch_decision (addendum §9 — branch/switch/route taken case)
  if (
    (d.mode !== "predicate" && d.mode !== "value") ||
    (typeof d.takenIndex !== "number" && d.takenIndex !== "default")
  ) {
    return null;
  }
  return {
    type: "branch_decision",
    nodeId: d.nodeId,
    mode: d.mode,
    takenIndex: d.takenIndex,
    ...(typeof d.takenLabel === "string" ? { takenLabel: d.takenLabel } : {}),
  };
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
 * Classify an error into a structured reason for the `reason` field
 * on status/error events. Returns undefined for unclassified errors.
 */
function classifyErrorReason(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name === "TimeoutError") return "http_timeout";
  if (error.name === "TypeError" && error.message.includes("fetch failed")) return "network";
  return undefined;
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
    // Also emit as a typed action for timeline/filtering
    const protocol = request.protocol ?? "http";
    const actionTarget = request.target ?? (request.method && request.url
      ? `${request.method} ${(() => { try { return new URL(request.url).pathname; } catch { return request.url; } })()}`
      : "unknown");
    const actionDuration = request.durationMs ?? request.duration ?? 0;
    const actionOk = request.ok ?? (typeof request.status === "number" && request.status < 400);
    ctx.action({
      category: `${protocol}:request`,
      target: actionTarget,
      duration: actionDuration,
      status: actionOk ? "ok" : "error",
      detail: { status: request.status },
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

  // Structured event emission. The vNext workflow executor's per-node
  // evidence (§17 #9) rides this channel as namespaced GlubeanEvents — the
  // harness UNWRAPS the three known types into first-class timeline events
  // (node id + grade reach generateSummary / the Cloud payload directly,
  // not as a double-wrapped custom blob). Any other type — including other
  // `workflow:*` names — stays a generic pass-through event.
  event: (ev: GlubeanEvent) => {
    const firstClass = workflowEventToTimeline(ev);
    if (firstClass) {
      emitEvent(firstClass);
      return;
    }
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
    // Also bump the step-failed-assertion counter (like ctx.assert) so the
    // failure is recorded even if the FailError is caught — e.g. inside a branch
    // predicate that swallows it; the step/branch must still fail.
    incrAssertions(false);
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
// Per-request state stored in a WeakMap keyed by ky 2's per-request
// `options.context` object. ky 2 guarantees `context` is always the SAME object
// across beforeRequest → afterResponse AND it survives a hook returning a
// replacement Request (auth helpers do `rebuildRequest`), whereas the Request
// object and the NormalizedOptions identity do not (codex ky2 P2). This also
// avoids the read-await-write race global variables had with in-flight requests.
interface RequestTraceState {
  startTime: number;
  body?: unknown;
}
const requestTraceMap = new WeakMap<object, RequestTraceState>();

// Capture the outgoing request body for full-trace mode. ky 2 no longer exposes
// `options.json`, so read it off a clone of the Request (parsed if JSON).
async function captureRequestBody(request: Request): Promise<unknown> {
  try {
    const text = await request.clone().text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return undefined;
  }
}

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
  // Default to NO retry. Glubean is a verification tool: a test must
  // report the response the server actually returned, not one that ky
  // silently retried into existence. ky's built-in default retries 5xx
  // (and 408/413/429) up to 2× on idempotent methods — that masks
  // flaky/degrading endpoints, which is exactly what users run Glubean
  // to catch. Authors who genuinely want resilience can opt back in
  // per-request via `http.get(url, { retry: 2 })`.
  retry: 0,
  hooks: {
    beforeRequest: [
      async ({ request, options }) => {
        requestTraceMap.set(options.context, {
          startTime: performance.now(),
          body: emitFullTrace ? await captureRequestBody(request) : undefined,
        });
      },
    ],
    afterResponse: [
      async ({ request, options, response }) => {
        // `request` here is the final (possibly hook-replaced) request — correct
        // for the trace target; the trace state is keyed by the stable context.
        const trace = requestTraceMap.get(options.context);
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

        // Attribute to the active workflow node's scope when one is executing
        // (the SDK's ctx.http rebind, §17 #10/#12): inline HTTP inside a
        // workflow node promotes its grade and obeys the late-evidence
        // quarantine. Outside a workflow node this is the closure ctx as ever.
        const sink = __activeWorkflowNodeCtx() ?? ctx;
        sink.trace(traceData as unknown as Trace);

        // Auto-metric for response time
        try {
          const pathname = new URL(request.url).pathname;
          sink.metric("http_duration_ms", duration, {
            unit: "ms",
            tags: { method: request.method, path: pathname },
          });
        } catch {
          sink.metric("http_duration_ms", duration, {
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
 * - Map glubean's public `prefixUrl` to ky 2's renamed `prefix` option
 * - Remove empty searchParams to prevent ky from appending bare '?'
 */

type KyOptionsWithSchema = KyOptions & { schema?: HttpSchemaOptions; prefixUrl?: string };

function normalizeOptions(options?: KyOptionsWithSchema): KyOptionsWithSchema | undefined {
  if (!options) return options;
  const normalized = { ...options };
  // ky 2 renamed `prefixUrl` → `prefix` (with the same join semantics we rely on
  // for "users" / "/users"). Glubean keeps `prefixUrl` as its public option and
  // translates here at the ky boundary (codex ky2 P2-5; not `baseUrl`).
  if (normalized.prefixUrl !== undefined) {
    (normalized as Record<string, unknown>).prefix = normalized.prefixUrl;
    delete normalized.prefixUrl;
  }
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
 * Normalize a HeadersInit value (Headers instance, plain object, or array of
 * tuples) into a plain Record<string, string> suitable for schema validation.
 */
function normalizeHeadersForValidation(
  headers: unknown,
): Record<string, string> {
  if (headers == null) return {};
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(
      headers.filter((p): p is [string, string] => Array.isArray(p) && p.length === 2),
    );
  }
  if (typeof headers === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (v != null) out[k] = String(v);
    }
    return out;
  }
  return {};
}

/**
 * Run pre-request schema validations (query params, request body, request headers).
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

  // Validate request headers (per-call only; client-level defaults not included)
  if (schemaOpts.requestHeaders && options?.headers != null) {
    const { schema, severity } = resolveSchemaEntry(schemaOpts.requestHeaders);
    const headers = normalizeHeadersForValidation(options.headers);
    runSchemaValidation(headers, schema, "request headers", severity);
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
    // Run pre-request validations (query, request body, request headers)
    runPreRequestSchemaValidation(normalized);
    // Strip schema option before passing to ky (ky doesn't know about it)
    let kyOptions: KyOptions | undefined;
    if (normalized?.schema) {
      const { schema: _schema, ...rest } = normalized;
      kyOptions = rest;
    } else {
      kyOptions = normalized;
    }
    // Inject afterResponse hook for response headers validation (fires once per final response)
    const responseHeadersSchema = normalized?.schema?.responseHeaders;
    if (responseHeadersSchema) {
      const { schema, severity } = resolveSchemaEntry(responseHeadersSchema);
      type AfterResponseHook = NonNullable<NonNullable<KyOptions["hooks"]>["afterResponse"]>[number];
      const headersHook: AfterResponseHook = ({ response }) => {
        const headersObj = normalizeHeadersForValidation(response.headers);
        runSchemaValidation(headersObj, schema, "response headers", severity);
      };
      kyOptions = {
        ...kyOptions,
        hooks: {
          ...kyOptions?.hooks,
          afterResponse: [
            ...(kyOptions?.hooks?.afterResponse ?? []),
            headersHook,
          ],
        },
      };
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


// runner-on-engine (plan 0005): when GLUBEAN_USE_ENGINE=1 the engine drives the
// run-loop (executeNewTest delegates to RunnerCore). Construct it BEFORE
// setRuntime so RunnerCore's ALS carrier is the one the SDK runtime fallback gets
// set on — module-load configure() and the engine's runWithRuntime() then share a
// single carrier (plan 0005 §接缝设计 / codex P1-5). Default OFF → no behavior change.
const engineCore = USE_ENGINE
  ? createEngineCore(emitEngineWire, {
      // Pass the SAME fallback Proxies the legacy ctx/runtime use (.env →
      // process.env), so engine-mode ctx.vars/secrets keep the system-env fallback
      // (codex P2 / plan 0005 §E). The engine layers per-run input over these
      // without destroying the Proxy.
      vars: withEnvFallback(rawVars),
      secrets: withEnvFallback(rawSecrets),
    })
  : undefined;

setRuntime({
  vars: withEnvFallback(rawVars),
  secrets: withEnvFallback(rawSecrets),
  session: sessionData,
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
} as unknown as InternalRuntime);

try {
  // Bootstrap project plugins before loading user code. Without this, any
  // test module that uses plugin-registered primitives (custom matchers,
  // `contract.graphql(...)`, `contract.grpc(...)`, ...) would either fail
  // on first access or silently fall through to the default behavior — see
  // plugin-manifest-proposal.md D2.
  await bootstrap(process.cwd());

  // Eagerly load `.bootstrap.{ts,js,mjs}` files (attachment-model §7.4).
  // Parent process also calls this for its own scanning purposes, but the
  // SDK bootstrap registry is process-local — every harness subprocess
  // has its own empty Map until it imports the overlay modules itself.
  // Without this, a filtered run like `glubean run project.contract.ts`
  // would reach the child's dispatcher with no overlays registered and
  // silently fall through to the raw execution path, defeating both the
  // overlay intent and `runnability.requireAttachment` guards.
  const overlayLoad = await loadProjectOverlays(process.cwd());
  for (const err of overlayLoad.errors) {
    console.log(
      JSON.stringify({
        type: "log",
        message: `Bootstrap overlay failed to load: ${err.file} — ${err.error}`,
      }),
    );
  }

  // Spike 3 — runner input channels (attachment-model §8). The CLI / MCP
  // serializes runner-supplied case input + bootstrap params into env
  // vars before spawning this subprocess. Each map is JSON `{ testId:
  // value }`. Force-standalone is a JSON-encoded `string[]` of testIds.
  // We populate the SDK runner-input channel here so the dispatcher's
  // §5.1 algorithm sees them when test.fn runs.
  const explicitMapRaw = process.env["GLUBEAN_RUNNER_EXPLICIT_INPUT_MAP"];
  if (explicitMapRaw) {
    try {
      const parsed = JSON.parse(explicitMapRaw) as Record<string, unknown>;
      for (const [testId, value] of Object.entries(parsed)) {
        setExplicitInput(testId, value);
      }
    } catch (err) {
      console.log(
        JSON.stringify({
          type: "log",
          message:
            `Invalid GLUBEAN_RUNNER_EXPLICIT_INPUT_MAP JSON: ` +
            (err instanceof Error ? err.message : String(err)),
        }),
      );
    }
  }
  const bootstrapMapRaw = process.env["GLUBEAN_RUNNER_BOOTSTRAP_INPUT_MAP"];
  if (bootstrapMapRaw) {
    try {
      const parsed = JSON.parse(bootstrapMapRaw) as Record<string, unknown>;
      for (const [testId, value] of Object.entries(parsed)) {
        setBootstrapInput(testId, value);
      }
    } catch (err) {
      console.log(
        JSON.stringify({
          type: "log",
          message:
            `Invalid GLUBEAN_RUNNER_BOOTSTRAP_INPUT_MAP JSON: ` +
            (err instanceof Error ? err.message : String(err)),
        }),
      );
    }
  }
  const forceStandaloneRaw = process.env["GLUBEAN_RUNNER_FORCE_STANDALONE_IDS"];
  if (forceStandaloneRaw) {
    try {
      const parsed = JSON.parse(forceStandaloneRaw) as unknown;
      if (Array.isArray(parsed)) {
        for (const testId of parsed) {
          if (typeof testId === "string") setForceStandalone(testId);
        }
      }
    } catch (err) {
      console.log(
        JSON.stringify({
          type: "log",
          message:
            `Invalid GLUBEAN_RUNNER_FORCE_STANDALONE_IDS JSON: ` +
            (err instanceof Error ? err.message : String(err)),
        }),
      );
    }
  }

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
      interactive: isInteractive,
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

  // ── Mode validation ──
  // At least one of testId, testIds, or exportName must be provided.
  // exportName alone triggers the export-scoped enumeration mode below
  // (canonical path for data-driven tests where per-row ids are runtime data).
  if (!testId && !testIds && !exportName) {
    console.log(
      JSON.stringify({
        type: "error",
        message:
          "Missing required arguments: --testId, --testIds, or --exportName",
      }),
    );
    process.exit(1);
  }

  // ── Export-scoped enumeration mode ──
  // When --exportName is set without --testId/--testIds, enumerate every
  // test belonging to that export and run all of them. This is the canonical
  // path for `test.each` / `test.pick` data-driven exports: per-row ids
  // (e.g. `demo-alpha`, `demo-beta` substituted from a `demo-$key` template)
  // only exist after the EachBuilder/PickBuilder is built — that runtime
  // fact lives here in the harness, not in any caller's static parser.
  //
  // Why a dedicated mode and not "passing template ids through --testIds":
  // template ids (`demo-$key`) never match any concrete `Test.meta.id`, so
  // `findTestById` returns undefined and the existing `exportNamesMap`
  // fallback short-circuits to `findTestByExport` which only returns the
  // FIRST test in the export — silent first-row-only bug that affected
  // every CLI/MCP run of a data-driven cookbook test (B1).
  if (exportName && !testId && !testIds) {
    const allTests = resolveModuleTests(userModule);
    const scoped = allTests.filter((t) => t.exportName === exportName);
    if (scoped.length === 0) {
      throw new Error(
        `No tests found in export "${exportName}". Available exports: ${
          Object.keys(userModule).join(", ")
        }`,
      );
    }
    let hasFailure = false;
    for (const resolved of scoped) {
      resetTestCounters();
      const obj = findTestById(userModule, resolved.id);
      if (!obj) {
        // Should never happen if `resolveModuleTests` returned this id,
        // but be defensive — emit a failure event rather than skipping silently.
        console.log(JSON.stringify({
          type: "status",
          status: "failed",
          id: resolved.id,
          testId: resolved.id,
          error: `Test "${resolved.id}" enumerated by resolveModuleTests but not findable by id`,
        }));
        hasFailure = true;
        continue;
      }
      try {
        await executeNewTest(obj);
      } catch (error) {
        if (error instanceof SkipError) {
          console.log(JSON.stringify({
            type: "status",
            status: "skipped",
            id: resolved.id,
            testId: resolved.id,
            reason: (error as SkipError).reason,
          }));
        } else {
          hasFailure = true;
          const reason = classifyErrorReason(error);
          console.log(JSON.stringify({
            type: "status",
            status: "failed",
            id: resolved.id,
            testId: resolved.id,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            ...(reason && { reason }),
          }));
        }
      }
    }
    process.exit(hasFailure ? 1 : 0);
  }

  if (testIds) {
    // ── File-level batch mode ──
    // Runs multiple tests in a single process, preserving module-level state.
    // When batchConcurrency > 1, tests run concurrently via p-queue
    // (opt-in via test.each({ parallel: true }) + --concurrency flag).
    //
    // Mixed input shape: each id in `testIds` is either
    //   (a) a CONCRETE id like `"my-test"` — found via `findTestById`.
    //   (b) a DATA-DRIVEN TEMPLATE like `"dj-csv-$label"` (matches /\$\w+/) —
    //       expanded into per-row substituted ids via `resolveModuleTests`
    //       filtered by `exportNamesMap[id]` (the export this template
    //       belongs to). Each substituted row runs as its own work item
    //       with its own substituted testId in events.
    //
    // Why expansion lives here: per-row ids are runtime data — only the
    // harness's environment can produce them correctly. CLI/MCP/VSCode
    // pre-rebuild stuffed templates into `--testIds=` and relied on the
    // legacy `findTestByExport` fallback that returned only the FIRST row
    // (silent first-row-only bug B1). The expansion below is the canonical
    // fix: keep the single-subprocess-per-file invariant (module state +
    // source order preserved) while running ALL rows.
    //
    // Caching `resolveModuleTests` once per harness run avoids repeated
    // re-resolution if multiple template ids appear in the same file.
    let hasFailure = false;
    let resolvedModuleTestsCache: ReturnType<typeof resolveModuleTests> | undefined;
    const isTemplateId = (id: string): boolean => /\$\w+/.test(id);

    const runOneTest = async (id: string): Promise<void> => {
      resetTestCounters();
      let testObj = findTestById(userModule, id);
      if (!testObj && exportNamesMap[id]) {
        testObj = findTestByExport(userModule, exportNamesMap[id]);
      }
      if (!testObj) {
        writeEventLine(JSON.stringify({ type: "start", id, name: id, testId: id }));
        writeEventLine(JSON.stringify({ type: "status", status: "failed", id, testId: id, error: `Test "${id}" not found in module` }));
        hasFailure = true;
        return;
      }
      try {
        await executeNewTest(testObj);
      } catch (error) {
        if (error instanceof SkipError) {
          writeEventLine(JSON.stringify({ type: "status", status: "skipped", id, testId: id, reason: error.reason }));
        } else {
          hasFailure = true;
          const reason = classifyErrorReason(error);
          writeEventLine(JSON.stringify({
            type: "status", status: "failed", id, testId: id,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            ...(reason && { reason }),
          }));
        }
      }
    };

    /**
     * Expand each `testIds` entry into one or more concrete ids to run,
     * preserving source order. A template id with a known exportName
     * expands into N substituted ids (one per row); a concrete id passes
     * through as itself. Unknown templates pass through too — they'll
     * fail loudly via the not-found path in `runOneTest`.
     */
    const expandedIds: string[] = [];
    for (const id of testIds) {
      if (isTemplateId(id) && exportNamesMap[id]) {
        if (!resolvedModuleTestsCache) {
          resolvedModuleTestsCache = resolveModuleTests(userModule);
        }
        const targetExport = exportNamesMap[id];
        const scoped = resolvedModuleTestsCache.filter(
          (t) => t.exportName === targetExport,
        );
        if (scoped.length === 0) {
          // Template id whose export has no resolvable tests — emit a
          // failure event for the template id itself so the run doesn't
          // silently complete. (Without this, an empty `test.each([])`
          // export would look like a passing zero-test run.)
          console.log(JSON.stringify({
            type: "status",
            status: "failed",
            id,
            testId: id,
            error: `No tests found in export "${targetExport}" (template id "${id}" expanded to zero rows)`,
          }));
          hasFailure = true;
          continue;
        }
        for (const r of scoped) expandedIds.push(r.id);
      } else {
        expandedIds.push(id);
      }
    }

    if (batchConcurrency > 1) {
      const { default: PQueue } = await import("p-queue");
      const queue = new PQueue({ concurrency: batchConcurrency });
      for (const id of expandedIds) {
        void queue.add(() => {
          const buf: string[] = [];
          return parallelEventBuffer.run(buf, async () => {
            try {
              await runOneTest(id);
            } finally {
              // Atomic flush: the loop is synchronous, so this test's whole
              // event block lands contiguously on stdout.
              for (const line of buf) console.log(line);
            }
          });
        });
      }
      await queue.onIdle();
    } else {
      for (const id of expandedIds) {
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
          const reason = classifyErrorReason(error);
          console.log(JSON.stringify({ type: "status", status: "failed", id: resolved.id, testId: resolved.id, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined, ...(reason && { reason }) }));
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
  const reason = classifyErrorReason(error);
  console.log(
    JSON.stringify({
      type: "status",
      status: "failed",
      ...(tid && { testId: tid }),
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      ...(reason && { reason }),
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
/**
 * Structural gate for the engine path (plan 0005): Phase 0 routes ONLY simple
 * tests. Steps stay on legacy until the engine emits step_start/step_end + per-step
 * index/retry/timeout (Phase 1); branch/poll (Phase 2/3); test.extend() fixtures
 * and workflow later. Routing a steps test now would lose its step timeline and
 * skew summaries (codex P2). ctx-surface gaps (validate/metric/…) are managed by
 * only exercising migrated features under the flag.
 */
function engineSupports(test: Test<unknown>): boolean {
  if (test.fixtures && Object.keys(test.fixtures).length > 0) return false;
  if (test.type === "simple") return true;
  if (test.type === "steps") {
    // Phase 1a: linear steps only. branch/poll steps (Phase 2/3) and per-step
    // retry/timeout (Phase 1b) stay on legacy until the engine emits their events.
    for (const step of test.steps ?? []) {
      if (isTestBranchStep(step) || isTestPollStep(step)) return false;
      const m = (step as { meta?: { retries?: unknown; timeout?: unknown } }).meta;
      if (m && (m.retries !== undefined || m.timeout !== undefined)) return false;
    }
    return true;
  }
  return false;
}

async function executeNewTest(test: Test<unknown>): Promise<void> {
  // runner-on-engine (plan 0005): route to the engine only when (a) the engine is
  // active, (b) this test id is on the per-test allowlist (GLUBEAN_ENGINE_TESTIDS;
  // "*" = all at cutover) — so the flag never sends arbitrary production tests
  // through an incomplete ctx (codex), and (c) the test's shape is supported. The
  // engine owns its scope/carrier/per-event-id and runs OUTSIDE the legacy
  // testContext ALS (testId comes from each event's own id). Anything else → legacy.
  if (engineCore && engineRoutesId(test.meta.id) && engineSupports(test)) {
    // Wrap with the same memory monitoring as the legacy path so the final status
    // carries peakMemoryBytes/peakMemoryMB (codex P2).
    startMemoryMonitoring();
    const result = await runViaEngine(engineCore, test, { session: sessionData, retryCount });
    const peakBytes = stopMemoryMonitoring();
    // Status emission mirrors the legacy split: a throw re-raises so the dispatcher
    // reports "failed" + exit 1 (the engine swallows throws into a result); success
    // and skip emit their status here (plan 0005 / codex P2). A soft assertion
    // failure is NOT a throw → it "completed" (pass/fail is derived from the
    // assertion events downstream, as in the legacy path).
    if (result.threw) {
      const err = new Error(result.error ?? "test threw");
      // Re-raise with the user's original name + stack so classifyErrorReason() and
      // diagnostics match the legacy path (codex P2).
      if (result.errorName) err.name = result.errorName;
      if (result.errorStack) err.stack = result.errorStack;
      throw err;
    }
    if (result.stepsFailed) {
      // Node parity (harness.ts "One or more steps failed"): a steps test with any
      // failed step throws after teardown so the dispatcher reports failed + exit 1
      // — unlike a simple test's soft assertion failure, which "completes" (codex P2).
      throw new Error("One or more steps failed");
    }
    if (result.status === "skipped") {
      // Legacy skip status (dispatcher) carries no peak memory.
      emitEngineWire({ type: "status", status: "skipped", id: test.meta.id, testId: test.meta.id });
    } else {
      emitEngineWire({
        type: "status",
        status: "completed",
        id: test.meta.id,
        testId: test.meta.id,
        peakMemoryBytes: peakBytes,
        peakMemoryMB: (peakBytes / 1024 / 1024).toFixed(2),
      });
    }
    return;
  }

  const testTags = normalizeTestTags(test.meta.tags);
  const testMeta = { id: test.meta.id, tags: testTags };
  const trc = new TestRunContext(test.meta.id, testMeta);

  // Run the test body inside an AsyncLocalStorage context so all
  // downstream code (ctx.assert, ky hooks, globalFetch) can access
  // the per-test state via currentTestCtx().
  await testContext.run(trc, async () => {

  // Runtime metadata is served via the `test` getter on the carrier runtime,
  // which reads from TestRunContext ALS (see setRuntime() call above).
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
        // First branch-decision failure message (predicate/lens threw or failed
        // an assertion). A branch decision has no `step_end`, so result
        // renderers that surface step/status errors would otherwise lose it;
        // we promote it into the final status error below.
        let branchDecisionError: string | undefined;
        // Set when a step calls ctx.skip(): skips the remaining steps and
        // marks the whole test as skipped (not failed) after teardown runs.
        let skipRequest: SkipError | undefined;
        try {
          if (test.setup) {
            emitEvent({
              type: "log",
              message: "Running setup...",
            });
            state = await test.setup(effectiveCtx);
          }
          if (test.steps) {
            // Monotonic step index across the (possibly branching) execution.
            // For a branchless test this counts 0,1,2,… == array position, so
            // non-branch behavior is identical to before. Counts ONLY leaf steps
            // (step_start/step_end), NOT branch decisions — so these indices line
            // up 1:1 with the leaves-only registry metadata, and consumers can
            // join runtime step events to discovered steps by index.
            let stepSeq = 0;
            // Separate ordinal for branch decision events (kept out of the leaf
            // step-index space so it can't desync leaf indices from metadata).
            let branchSeq = 0;

            // "step N of TOTAL" denominator: every LEAF step in the whole tree
            // (branch decisions are not steps). A leaf emits exactly once on any
            // path, so `stepSeq` indices are 0..leafTotal-1 and `index < total`
            // always holds. Branchless → test.steps.length (unchanged).
            const leafTotal = (list: StepDefinition<unknown>[]): number => {
              let n = 0;
              for (const s of list) {
                if (isTestBranchStep(s)) {
                  for (const c of s.branch.cases) n += leafTotal(c.steps);
                  n += leafTotal(s.branch.default);
                } else {
                  n += 1;
                }
              }
              return n;
            };
            const stepTotal = leafTotal(test.steps);

            // Emit a skipped step_end for every leaf step in a list, recursing
            // into branch sub-steps. Used by the skip-cascade and for the
            // non-taken cases/default of a branch.
            const emitSkippedTree = (list: StepDefinition<unknown>[]): void => {
              for (const s of list) {
                if (isTestBranchStep(s)) {
                  for (const c of s.branch.cases) emitSkippedTree(c.steps);
                  emitSkippedTree(s.branch.default);
                } else {
                  emitEvent({
                    type: "step_end",
                    index: stepSeq++,
                    name: s.meta.name,
                    status: "skipped",
                    durationMs: 0,
                    assertions: 0,
                    failedAssertions: 0,
                  });
                }
              }
            };

            // Recursive step-list runner. Branch sub-steps run through the same
            // path (first-class steps, incremental state commit), mirroring the
            // flow-side `runSteps` so teardown always sees the last committed state.
            const runStepList = async (
              list: StepDefinition<unknown>[],
            ): Promise<void> => {
            for (const step of list) {
              // If a previous step failed (or a step called ctx.skip()),
              // skip the remaining steps (and all their branch descendants).
              if (stepFailed || skipRequest) {
                emitSkippedTree([step]);
                continue;
              }

              // Branch step (condition / switchOn / switchCond): evaluate the
              // decision, run the taken case's sub-steps, skip the rest.
              if (isTestBranchStep(step)) {
                await runBranchStep(step);
                continue;
              }

              // Poll step (test().poll): bounded retry of the attempt fn until
              // the exit predicate holds (or a bound exhausts → the step fails).
              if (isTestPollStep(step)) {
                await runPollStep(step);
                continue;
              }

              const i = stepSeq++;

              // Reset per-step assertion counters and set step scope
              { const trc = currentTestCtx()!; trc.stepFailedAssertions = 0; trc.stepAssertionTotal = 0; trc.currentStepIndex = i; }
              const stepStart = performance.now();

              emitEvent({
                type: "step_start",
                index: i,
                name: step.meta.name,
                total: stepTotal,
              });

              let stepError: string | undefined;
              let stepReturnState: unknown = undefined;
              const retries = step.meta.retries;
              const configuredRetries = typeof retries === "number" && Number.isFinite(retries)
                ? Math.max(0, Math.floor(retries))
                : 0;
              const retryDelayMs = typeof step.meta.retryDelay === "number" && Number.isFinite(step.meta.retryDelay)
                ? Math.max(0, step.meta.retryDelay)
                : (configuredRetries > 0 ? 1000 : 0);
              const backoffMultiplier = typeof step.meta.backoff === "number" && Number.isFinite(step.meta.backoff)
                ? Math.max(1, step.meta.backoff)
                : 1;
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
                  if (err instanceof SkipError) {
                    // ctx.skip() inside a step skips the WHOLE test. It is
                    // not a step failure and must not be retried.
                    skipRequest = err;
                  } else {
                    stepError = err instanceof Error ? err.message : String(err);
                    timeoutFailure = err instanceof StepTimeoutError;
                  }
                } finally {
                  if (stepTimeoutId !== undefined) {
                    clearTimeout(stepTimeoutId);
                  }
                }

                lastFailedAssertions = getStepFailedAssertions();
                lastAssertions = getStepAssertionTotal();

                // Skip is terminal — stop attempting, never retry a skip.
                if (skipRequest) {
                  break;
                }

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
                  const delay = Math.min(retryDelayMs * backoffMultiplier ** (attempt - 1), 30_000);
                  const reason = stepError ? stepError : `${getStepFailedAssertions()} failed assertion(s)`;
                  emitEvent({
                    type: "log",
                    stepIndex: i,
                    message: `Retrying step "${step.meta.name}" (${
                      attempt + 1
                    }/${maxAttempts}) after failure: ${reason}${delay > 0 ? ` (waiting ${delay}ms)` : ""}`,
                  });
                  if (delay > 0) {
                    await new Promise<void>((r) => setTimeout(r, delay));
                  }
                }
              }

              // ctx.skip() called in this step. If the step already recorded a
              // failed assertion BEFORE skipping, the failure wins — a skip must
              // not mask a real failure (consistent with simple-mode tests,
              // where generateSummary fails on a failed assertion regardless of
              // a later skip). Otherwise emit a skipped step_end and stop running
              // steps; the test is reported as skipped after teardown via the
              // throw below the loop.
              if (skipRequest && lastFailedAssertions === 0) {
                emitEvent({
                  type: "step_end",
                  index: i,
                  name: step.meta.name,
                  status: "skipped",
                  durationMs: Math.round(performance.now() - stepStart),
                  assertions: lastAssertions,
                  failedAssertions: 0,
                  attempts: attemptsUsed,
                  retriesUsed: Math.max(0, attemptsUsed - 1),
                });
                currentTestCtx()!.currentStepIndex = null;
                continue;
              }
              // Prior failure overrides the skip — fall through and report this
              // step (and the test) as failed.
              skipRequest = undefined;

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
            };

            // Execute a poll step (test().poll): a first-class leaf step whose
            // body is a bounded retry of `fn` until `until` holds (or a bound
            // exhausts → the step fails). Each attempt is RACED against its
            // budget (best-effort: arbitrary user `fn`/`until` can't be force-
            // cancelled, but the step never waits past the budget). Emits a
            // `poll` timeline event (attempts/elapsed/satisfied/exhausted) plus
            // the normal step_start/step_end. fn/until run against the live ctx
            // (test-side, like ctx.pollUntil — assertions count).
            const runPollStep = async (
              step: StepDefinition<unknown> & { poll: TestPollData<unknown> },
            ): Promise<void> => {
              const poll = step.poll;
              const i = stepSeq++;
              {
                const trc = currentTestCtx()!;
                trc.stepFailedAssertions = 0;
                trc.stepAssertionTotal = 0;
                trc.currentStepIndex = i;
              }
              const stepStart = performance.now();
              emitEvent({ type: "step_start", index: i, name: step.meta.name, total: stepTotal });

              // Local budget sentinel so a budget timeout is distinguishable from
              // a genuine fn/until error or a SkipError.
              class PollBudgetTimeout extends Error {}
              const raceBudget = <T>(p: Promise<T>, budgetMs: number): Promise<T> => {
                if (!Number.isFinite(budgetMs)) return p;
                return new Promise<T>((resolve, reject) => {
                  const t = setTimeout(() => reject(new PollBudgetTimeout()), Math.max(0, budgetMs));
                  p.then(
                    (v) => { clearTimeout(t); resolve(v); },
                    (e) => { clearTimeout(t); reject(e); },
                  );
                });
              };

              const everyMs = poll.every ?? 1000;
              const backoff = poll.backoff ?? 1;
              const perAttempt = poll.perAttemptTimeout ?? Infinity;
              const start = performance.now();
              const deadline = poll.timeout !== undefined ? start + poll.timeout : Infinity;
              let attempt = 0;
              let delay = everyMs;
              let satisfied = false;
              let exhausted = false;
              let pollError: string | undefined;
              let lastRes: unknown;
              // A poll-phase throw (fn / until / out-mapper) must surface a
              // non-empty message: pollError is tested for truthiness below to
              // decide failure AND whether to emit an `error`, so an empty
              // message (`throw new Error("")` / `throw ""`) would otherwise be
              // silently treated as a pass.
              const pollErrMsg = (e: unknown): string => {
                const m = e instanceof Error ? e.message : String(e);
                return m || `poll "${step.meta.name}" threw an empty error`;
              };

              for (;;) {
                attempt += 1;
                const remainingTotal = deadline - performance.now();
                if (remainingTotal <= 0) { exhausted = true; break; }
                const attemptBudget = Math.min(perAttempt, remainingTotal);
                const attemptStart = performance.now();

                // Attempt fn (best-effort raced).
                try {
                  lastRes = await raceBudget(Promise.resolve(poll.fn(effectiveCtx, state)), attemptBudget);
                } catch (err) {
                  if (err instanceof SkipError) { skipRequest = err; break; }
                  if (err instanceof PollBudgetTimeout) { exhausted = true; break; }
                  pollError = pollErrMsg(err);
                  break;
                }
                if (performance.now() > deadline || performance.now() - attemptStart > perAttempt) {
                  exhausted = true;
                  break;
                }

                // Exit predicate (raced to the remaining attempt budget).
                let done: boolean;
                try {
                  const predBudget = Math.min(deadline - performance.now(), perAttempt - (performance.now() - attemptStart));
                  const out = await raceBudget(
                    Promise.resolve(poll.until(effectiveCtx, lastRes, state)),
                    Math.max(0, predBudget),
                  );
                  if (typeof out !== "boolean") {
                    pollError = `poll "${step.meta.name}": until must return a boolean; got ${out === null ? "null" : typeof out}`;
                    break;
                  }
                  done = out;
                } catch (err) {
                  if (err instanceof SkipError) { skipRequest = err; break; }
                  if (err instanceof PollBudgetTimeout) { exhausted = true; break; }
                  pollError = pollErrMsg(err);
                  break;
                }

                if (done) {
                  satisfied = true;
                  if (poll.out) {
                    // A throwing out-mapper must fail the poll through the normal
                    // path (poll event + step_end + ctx reset below), not escape
                    // and leave a dangling started step — like fn/until errors.
                    try {
                      const next = poll.out(state, lastRes);
                      if (next !== undefined) state = next;
                    } catch (err) {
                      pollError = pollErrMsg(err);
                    }
                  }
                  break;
                }

                // Not satisfied → check bounds, then wait.
                if (poll.maxAttempts && attempt >= poll.maxAttempts) { exhausted = true; break; }
                if (Number.isFinite(deadline) && performance.now() + delay >= deadline) { exhausted = true; break; }
                await new Promise<void>((r) => setTimeout(r, delay));
                delay = Math.min(delay * backoff, 30_000);
              }

              const durationMs = Math.round(performance.now() - stepStart);
              const failedAssertions = getStepFailedAssertions();
              const assertions = getStepAssertionTotal();

              // ctx.skip() in fn/until skips the whole test (unless a failure was
              // already recorded — failure wins, mirroring the normal step path).
              if (skipRequest && failedAssertions === 0 && !pollError && !exhausted) {
                emitEvent({
                  type: "step_end",
                  index: i,
                  name: step.meta.name,
                  status: "skipped",
                  durationMs,
                  assertions,
                  failedAssertions: 0,
                  attempts: attempt,
                });
                currentTestCtx()!.currentStepIndex = null;
                return;
              }
              skipRequest = undefined;

              if (exhausted && !pollError) {
                pollError = `poll "${step.meta.name}" exhausted: condition not met after ${attempt} attempt(s)`;
              }
              const failed = !!pollError || failedAssertions > 0 || !satisfied;

              emitEvent({
                type: "poll",
                index: i,
                name: step.meta.name,
                attempts: attempt,
                elapsedMs: Math.round(performance.now() - start),
                satisfied,
                exhausted,
                ...(pollError && { error: pollError }),
              });

              emitEvent({
                type: "step_end",
                index: i,
                name: step.meta.name,
                status: failed ? "failed" : "passed",
                durationMs,
                assertions,
                failedAssertions,
                attempts: attempt,
                ...(pollError && { error: pollError }),
              });
              currentTestCtx()!.currentStepIndex = null;
              if (failed) stepFailed = true;
            };

            // Execute a branch step: evaluate the decision (value-switch subject
            // once, or first-match predicate), emit a `branch` decision event,
            // run the taken case's sub-steps as first-class steps, and emit
            // skipped for every non-taken case + (if a case matched) the default.
            const runBranchStep = async (
              step: StepDefinition<unknown> & { branch: TestBranchData<unknown> },
            ): Promise<void> => {
              const branch = step.branch;
              const ctxNow = currentTestCtx();
              if (ctxNow) {
                ctxNow.currentStepIndex = null;
                // Reset the assertion counters so we can detect ctx.assert /
                // ctx.validate failures made DURING the decision (predicates get
                // the full ctx) and fail the branch instead of silently deciding.
                ctxNow.stepFailedAssertions = 0;
                ctxNow.stepAssertionTotal = 0;
              }
              let takenIndex: number | "default" = "default";
              let takenValue: string | number | boolean | null | undefined;

              try {
                if (branch.mode === "value") {
                  // Subject lens evaluated EXACTLY ONCE (test lenses may be impure).
                  // `await` so an async lens resolves to its scalar before
                  // matching (and a rejection is caught below as a decision
                  // failure) — a bare Promise would never === a case value.
                  const subject = branch.subject
                    ? await branch.subject(effectiveCtx, state)
                    : undefined;
                  for (let ci = 0; ci < branch.cases.length; ci++) {
                    if (subject === branch.cases[ci].value) {
                      takenIndex = ci;
                      takenValue = branch.cases[ci].value;
                      break;
                    }
                  }
                } else {
                  for (let ci = 0; ci < branch.cases.length; ci++) {
                    const pred = branch.cases[ci].predicate;
                    if (!pred) continue;
                    const result = await pred(effectiveCtx, state);
                    // Predicate contract is boolean. A JS / `as any` caller could
                    // return a truthy non-boolean ("false", an object); fail fast
                    // instead of coercing (mirrors the flow-side guarantee).
                    if (typeof result !== "boolean") {
                      throw new Error(
                        `condition / switchCond predicate must return a boolean; ` +
                          `got ${result === null ? "null" : typeof result}`,
                      );
                    }
                    if (result) {
                      takenIndex = ci;
                      break;
                    }
                  }
                }
              } catch (err) {
                // ctx.skip() inside a predicate/lens skips the WHOLE test (like
                // inside a step) — UNLESS a failed assertion was already recorded
                // during the decision, in which case the failure wins over the
                // skip (mirrors the step loop's d675fc9 semantics: a skip must
                // not mask a real failure).
                if (err instanceof SkipError && getStepFailedAssertions() === 0) {
                  skipRequest = err;
                  emitEvent({
                    type: "branch",
                    index: branchSeq++,
                    name: step.meta.name,
                    takenIndex: "default",
                    ...(branch.message ? { message: branch.message } : {}),
                    total: branch.cases.length,
                  });
                  for (const c of branch.cases) emitSkippedTree(c.steps);
                  emitSkippedTree(branch.default);
                  return;
                }
                // Branch decision failure (§7.4): the test fails; do not silently
                // take a branch. Emit a failed branch event + skip all sub-steps.
                // A skip that reaches here was preceded by a failed assertion.
                const failedDuring = getStepFailedAssertions();
                const errMessage =
                  err instanceof SkipError
                    ? `${failedDuring} failed assertion(s) before ctx.skip() in branch decision`
                    : err instanceof Error
                      ? err.message
                      : String(err);
                emitEvent({
                  type: "branch",
                  index: branchSeq++,
                  name: step.meta.name,
                  takenIndex: "default",
                  ...(branch.message ? { message: branch.message } : {}),
                  total: branch.cases.length,
                  error: errMessage,
                });
                stepFailed = true;
                if (branchDecisionError === undefined) {
                  branchDecisionError = `branch "${step.meta.name}": ${errMessage}`;
                }
                for (const c of branch.cases) emitSkippedTree(c.steps);
                emitSkippedTree(branch.default);
                return;
              }

              // A ctx.assert(false) / ctx.validate(...) failure recorded while
              // evaluating the decision fails the branch (the assertion event is
              // outside any step, so step-authoritative success would miss it).
              const decisionFailedAssertions = getStepFailedAssertions();
              if (decisionFailedAssertions > 0) {
                const assertErr = `${decisionFailedAssertions} failed assertion(s) during branch decision`;
                emitEvent({
                  type: "branch",
                  index: branchSeq++,
                  name: step.meta.name,
                  takenIndex: "default",
                  ...(branch.message ? { message: branch.message } : {}),
                  total: branch.cases.length,
                  error: assertErr,
                });
                stepFailed = true;
                if (branchDecisionError === undefined) {
                  branchDecisionError = `branch "${step.meta.name}": ${assertErr}`;
                }
                for (const c of branch.cases) emitSkippedTree(c.steps);
                emitSkippedTree(branch.default);
                return;
              }

              emitEvent({
                type: "branch",
                index: branchSeq++,
                name: step.meta.name,
                takenIndex,
                ...(takenValue !== undefined ? { takenValue } : {}),
                ...(branch.message ? { message: branch.message } : {}),
                total: branch.cases.length,
              });

              // Emit/run leaves in REGISTRY (source) order — cases 0..N then
              // default — running the taken one as first-class steps and
              // skipping the rest IN PLACE. This keeps the monotonic leaf
              // `stepSeq` aligned with `flattenStepsForRegistry` order, so
              // consumers join runtime events to discovered steps by index even
              // when a later case (or the default) is taken.
              for (let ci = 0; ci < branch.cases.length; ci++) {
                if (ci === takenIndex) {
                  await runStepList(branch.cases[ci].steps);
                } else {
                  emitSkippedTree(branch.cases[ci].steps);
                }
              }
              if (takenIndex === "default") {
                await runStepList(branch.default);
              } else {
                emitSkippedTree(branch.default);
              }
            };

            await runStepList(test.steps);
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

        // A step called ctx.skip() → propagate so the test is reported as
        // skipped (teardown has already run in the finally above).
        if (skipRequest) {
          throw skipRequest;
        }

        // If any step failed (assertion or throw), mark overall test as failed
        if (stepFailed) {
          throw new Error(branchDecisionError ?? "One or more steps failed");
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
