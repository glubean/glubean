import { spawn } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import type { ApiTrace, GlubeanAction, GlubeanEvent } from "@glubean/sdk";
import { resolveAllowNetFlag } from "./config.js";
import type { SharedRunConfig } from "./config.js";

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_TIMEOUT_MS = 30000;

// ── Event Types ─────────────────────────────────────────────────────────────

export type ExecutionEvent =
  | {
    type: "start";
    id: string;
    name: string;
    tags?: string[];
    suiteId?: string;
    suiteName?: string;
    retryCount?: number;
  }
  | { type: "log"; message: string; data?: unknown; stepIndex?: number }
  | {
    type: "assertion";
    passed: boolean;
    message: string;
    actual?: unknown;
    expected?: unknown;
    stepIndex?: number;
  }
  | { type: "trace"; data: ApiTrace; stepIndex?: number }
  | { type: "action"; data: GlubeanAction; stepIndex?: number }
  | { type: "event"; data: GlubeanEvent; stepIndex?: number }
  | {
    type: "warning";
    condition: boolean;
    message: string;
    stepIndex?: number;
  }
  | {
    type: "schema_validation";
    label: string;
    success: boolean;
    severity: "error" | "warn" | "fatal";
    issues?: Array<{ message: string; path?: Array<string | number> }>;
    stepIndex?: number;
  }
  | {
    type: "metric";
    name: string;
    value: number;
    unit?: string;
    tags?: Record<string, string>;
    stepIndex?: number;
  }
  | {
    type: "status";
    status: "completed" | "failed" | "skipped";
    id?: string;
    error?: string;
    stack?: string;
    reason?: string;
    peakMemoryBytes?: number;
    peakMemoryMB?: string;
  }
  | { type: "error"; message: string }
  | {
    type: "step_start";
    index: number;
    name: string;
    total: number;
  }
  | {
    type: "step_end";
    index: number;
    name: string;
    status: "passed" | "failed" | "skipped";
    durationMs: number;
    assertions: number;
    failedAssertions: number;
    error?: string;
    returnState?: unknown;
    attempts?: number;
    retriesUsed?: number;
  }
  | { type: "timeout_update"; timeout: number }
  | {
    type: "summary";
    data: {
      httpRequestTotal: number;
      httpErrorTotal: number;
      httpErrorRate: number;
      assertionTotal: number;
      assertionFailed: number;
      warningTotal: number;
      warningTriggered: number;
      schemaValidationTotal: number;
      schemaValidationFailed: number;
      schemaValidationWarnings: number;
      stepTotal: number;
      stepPassed: number;
      stepFailed: number;
      stepSkipped: number;
    };
  };

// ── Execution Context ───────────────────────────────────────────────────────

export interface ExecutionNetworkPolicy {
  mode: "shared_serverless";
  maxRequests: number;
  maxConcurrentRequests: number;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  allowedPorts: number[];
}

export interface ExecutionContext {
  vars: Record<string, string>;
  secrets: Record<string, string>;
  test?: {
    id?: string;
    tags?: string[];
  };
  retryCount?: number;
  networkPolicy?: ExecutionNetworkPolicy;
}

// ── Timeline Events ─────────────────────────────────────────────────────────

export type TimelineEvent =
  | { type: "log"; ts: number; testId?: string; stepIndex?: number; message: string; data?: unknown }
  | { type: "assertion"; ts: number; testId?: string; stepIndex?: number; passed: boolean; message: string; actual?: unknown; expected?: unknown }
  | { type: "warning"; ts: number; testId?: string; stepIndex?: number; condition: boolean; message: string }
  | { type: "schema_validation"; ts: number; testId?: string; stepIndex?: number; label: string; success: boolean; severity: "error" | "warn" | "fatal"; issues?: Array<{ message: string; path?: Array<string | number> }> }
  | { type: "trace"; ts: number; testId?: string; stepIndex?: number; data: ApiTrace }
  | { type: "action"; ts: number; testId?: string; stepIndex?: number; data: GlubeanAction }
  | { type: "event"; ts: number; testId?: string; stepIndex?: number; data: GlubeanEvent }
  | { type: "metric"; ts: number; testId?: string; stepIndex?: number; name: string; value: number; unit?: string; tags?: Record<string, string> }
  | { type: "step_start"; ts: number; testId?: string; index: number; name: string; total: number }
  | { type: "step_end"; ts: number; testId?: string; index: number; name: string; status: "passed" | "failed" | "skipped"; durationMs: number; assertions: number; failedAssertions: number; error?: string; returnState?: unknown; attempts?: number; retriesUsed?: number }
  | { type: "summary"; ts: number; testId?: string; data: { httpRequestTotal: number; httpErrorTotal: number; httpErrorRate: number; assertionTotal: number; assertionFailed: number; warningTotal: number; warningTriggered: number; schemaValidationTotal: number; schemaValidationFailed: number; schemaValidationWarnings: number; stepTotal: number; stepPassed: number; stepFailed: number; stepSkipped: number } };

export type EventHandler = (event: TimelineEvent) => void | Promise<void>;

// ── Options & Results ───────────────────────────────────────────────────────

export interface SingleExecutionOptions {
  onEvent?: EventHandler;
  includeTestId?: boolean;
  timeout?: number;
}

export interface ExecutionResult {
  success: boolean;
  testId: string;
  testName?: string;
  suiteId?: string;
  suiteName?: string;
  events: TimelineEvent[];
  error?: string;
  stack?: string;
  duration: number;
  retryCount?: number;
  assertionCount: number;
  failedAssertionCount: number;
  peakMemoryBytes?: number;
  peakMemoryMB?: string;
}

export interface ExecutionOptions {
  concurrency?: number;
  stopOnFailure?: boolean;
  failAfter?: number;
  onEvent?: EventHandler;
}

export interface ExecutionBatchResult {
  results: ExecutionResult[];
  success: boolean;
  failedCount: number;
  skippedCount: number;
  duration: number;
}

export interface ExecutorOptions {
  maxHeapSizeMb?: number;
  v8Flags?: string[];
  cwd?: string;
  emitFullTrace?: boolean;
  inspectBrk?: number | boolean;
}

// ── Resolve harness path ────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let _tsxPath: string | undefined;

function resolveTsxPath(): string {
  if (_tsxPath) return _tsxPath;
  const req = createRequire(import.meta.url);
  _tsxPath = resolve(dirname(req.resolve("tsx/package.json")), "dist/cli.mjs");
  return _tsxPath;
}

// ── TestExecutor ────────────────────────────────────────────────────────────

export class TestExecutor {
  private harnessPath: string;
  private options: ExecutorOptions;

  constructor(options: ExecutorOptions = {}) {
    this.harnessPath = resolve(__dirname, "harness.ts");
    this.options = options;
  }

  static fromSharedConfig(
    shared: SharedRunConfig,
    overrides?: Partial<ExecutorOptions>,
  ): TestExecutor {
    return new TestExecutor({
      emitFullTrace: shared.emitFullTrace,
      ...overrides,
    });
  }

  async *run(
    testUrl: string,
    testId: string,
    context: ExecutionContext,
    options?: { timeout?: number; exportName?: string; testIds?: string[]; exportNames?: Record<string, string> },
  ): AsyncGenerator<ExecutionEvent> {
    const args: string[] = [this.harnessPath];

    // V8 flags via NODE_OPTIONS
    const nodeOptions: string[] = [];
    if (this.options.maxHeapSizeMb) {
      nodeOptions.push(`--max-old-space-size=${this.options.maxHeapSizeMb}`);
    }
    if (this.options.v8Flags) {
      nodeOptions.push(...this.options.v8Flags);
    }

    // Inspect
    const inspectBrk = this.options.inspectBrk || (() => {
      const envVal = process.env["GLUBEAN_INSPECT_BRK"];
      if (!envVal) return false;
      const port = parseInt(envVal, 10);
      return isNaN(port) ? true : port;
    })();

    if (inspectBrk) {
      if (typeof inspectBrk === "number") {
        nodeOptions.push(`--inspect-brk=127.0.0.1:${inspectBrk}`);
      } else {
        nodeOptions.push("--inspect-brk");
      }
    }

    // Harness args
    args.push(`--testUrl=${testUrl}`);
    if (options?.testIds) {
      args.push(`--testIds=${options.testIds.join(",")}`);
    } else {
      args.push(`--testId=${testId}`);
    }
    if (options?.exportName) {
      args.push(`--exportName=${options.exportName}`);
    }
    if (options?.exportNames && Object.keys(options.exportNames).length > 0) {
      const pairs = Object.entries(options.exportNames)
        .map(([id, name]) => `${id}:${name}`)
        .join(",");
      args.push(`--exportNames=${pairs}`);
    }
    if (this.options.emitFullTrace) {
      args.push("--emitFullTrace");
    }

    // Build env
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (nodeOptions.length > 0) {
      env["NODE_OPTIONS"] = nodeOptions.join(" ");
    }

    // Spawn tsx subprocess via node
    const child = spawn("node", [resolveTsxPath(), ...args], {
      cwd: this.options.cwd,
      env,
      stdio: ["pipe", "pipe", inspectBrk ? "inherit" : "pipe"],
    });

    // Write context to stdin
    const normalizedContext: ExecutionContext = {
      ...context,
      test: {
        id: context.test?.id ?? testId,
        tags: context.test?.tags ?? [],
      },
    };
    child.stdin!.write(JSON.stringify(normalizedContext));
    child.stdin!.end();

    // Setup timeout
    const timeout = inspectBrk ? 0 : options?.timeout ?? DEFAULT_TIMEOUT_MS;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    const armTimeout = (ms: number) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (ms <= 0) return;
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, ms);
    };

    if (timeout > 0) armTimeout(timeout);

    // Read stdout line by line
    let stdoutBuffer = "";
    const stderrChunks: Buffer[] = [];

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    }

    // Use an async iterator pattern to yield events
    const eventQueue: ExecutionEvent[] = [];
    let resolveWait: (() => void) | undefined;
    let done = false;

    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        const event = this.parseExecutionLine(line);
        if (event) {
          // Handle timeout_update
          if (event.type === "timeout_update" && !inspectBrk && Number.isFinite(event.timeout) && event.timeout > 0) {
            armTimeout(Math.floor(event.timeout));
          }
          eventQueue.push(event);
          resolveWait?.();
        }
      }
    });

    child.on("close", (code, signal) => {
      // Process remaining buffer
      if (stdoutBuffer.trim()) {
        const event = this.parseExecutionLine(stdoutBuffer);
        if (event) eventQueue.push(event);
      }

      if (timeoutHandle) clearTimeout(timeoutHandle);

      const stderr = Buffer.concat(stderrChunks).toString();

      if (code !== 0) {
        if (timedOut) {
          eventQueue.push({ type: "error", message: `Test execution timed out after ${timeout}ms` });
        } else if (signal === "SIGKILL" || code === 137) {
          const heapInfo = this.options.maxHeapSizeMb ? ` (limit: ${this.options.maxHeapSizeMb} MB)` : "";
          const detail = stderr.trim() ? `\n${stderr.trim()}` : "";
          eventQueue.push({
            type: "error",
            message: `Out of memory — process killed${heapInfo}.${detail}\nTo fix: process data in smaller batches.`,
          });
        } else if (stderr.trim()) {
          eventQueue.push({ type: "error", message: stderr.trim() });
        } else {
          eventQueue.push({
            type: "error",
            message: `Process exited with code ${code}${signal ? ` (signal: ${signal})` : ""}`,
          });
        }
      }

      done = true;
      resolveWait?.();
    });

    // Yield events as they arrive
    while (true) {
      while (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      }
      if (done) break;
      await new Promise<void>((r) => { resolveWait = r; });
    }
  }

  private parseExecutionLine(line: string): ExecutionEvent | undefined {
    if (!line.trim()) return undefined;
    try {
      return JSON.parse(line) as ExecutionEvent;
    } catch {
      return { type: "log", message: line };
    }
  }

  async execute(
    testUrl: string,
    testId: string,
    context: ExecutionContext,
    options?: SingleExecutionOptions,
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const events: TimelineEvent[] = [];
    const onEvent = options?.onEvent;
    const includeTestId = options?.includeTestId ?? false;
    let success = false;
    let testName: string | undefined;
    let suiteId: string | undefined;
    let suiteName: string | undefined;
    let error: string | undefined;
    let stack: string | undefined;
    let peakMemoryBytes: number | undefined;
    let peakMemoryMB: string | undefined;
    let retryCount: number | undefined;
    let assertionCount = 0;
    let failedAssertionCount = 0;

    for await (const event of this.run(testUrl, testId, context, { timeout: options?.timeout })) {
      const ts = Date.now() - startTime;
      let timelineEvent: TimelineEvent | undefined;

      switch (event.type) {
        case "start":
          testName = event.name;
          suiteId = event.suiteId;
          suiteName = event.suiteName;
          retryCount = event.retryCount;
          break;
        case "log":
          timelineEvent = { type: "log", ts, ...(includeTestId && { testId }), ...(event.stepIndex !== undefined && { stepIndex: event.stepIndex }), message: event.message, data: event.data };
          break;
        case "assertion":
          assertionCount++;
          if (!event.passed) failedAssertionCount++;
          timelineEvent = { type: "assertion", ts, ...(includeTestId && { testId }), ...(event.stepIndex !== undefined && { stepIndex: event.stepIndex }), passed: event.passed, message: event.message, actual: event.actual, expected: event.expected };
          break;
        case "warning":
          timelineEvent = { type: "warning", ts, ...(includeTestId && { testId }), ...(event.stepIndex !== undefined && { stepIndex: event.stepIndex }), condition: event.condition, message: event.message };
          break;
        case "schema_validation":
          timelineEvent = { type: "schema_validation", ts, ...(includeTestId && { testId }), ...(event.stepIndex !== undefined && { stepIndex: event.stepIndex }), label: event.label, success: event.success, severity: event.severity, ...(event.issues && { issues: event.issues }) };
          break;
        case "trace":
          timelineEvent = { type: "trace", ts, ...(includeTestId && { testId }), ...(event.stepIndex !== undefined && { stepIndex: event.stepIndex }), data: event.data };
          break;
        case "action":
          timelineEvent = { type: "action", ts, ...(includeTestId && { testId }), ...(event.stepIndex !== undefined && { stepIndex: event.stepIndex }), data: event.data };
          break;
        case "event":
          timelineEvent = { type: "event", ts, ...(includeTestId && { testId }), ...(event.stepIndex !== undefined && { stepIndex: event.stepIndex }), data: event.data };
          break;
        case "metric":
          timelineEvent = { type: "metric", ts, ...(includeTestId && { testId }), ...(event.stepIndex !== undefined && { stepIndex: event.stepIndex }), name: event.name, value: event.value, unit: event.unit, tags: event.tags };
          break;
        case "summary":
          timelineEvent = { type: "summary", ts, ...(includeTestId && { testId }), data: event.data };
          break;
        case "status":
          success = event.status === "completed" || event.status === "skipped";
          if (event.error) error = event.error;
          if (event.stack) stack = event.stack;
          if (event.peakMemoryBytes !== undefined) peakMemoryBytes = event.peakMemoryBytes;
          if (event.peakMemoryMB !== undefined) peakMemoryMB = event.peakMemoryMB;
          break;
        case "error":
          success = false;
          if (!error) error = event.message;
          break;
        case "step_start":
          timelineEvent = { type: "step_start", ts, ...(includeTestId && { testId }), index: event.index, name: event.name, total: event.total };
          break;
        case "step_end":
          timelineEvent = { type: "step_end", ts, ...(includeTestId && { testId }), index: event.index, name: event.name, status: event.status, durationMs: event.durationMs, assertions: event.assertions, failedAssertions: event.failedAssertions, error: event.error, attempts: event.attempts, retriesUsed: event.retriesUsed, ...(event.returnState !== undefined && { returnState: event.returnState }) };
          break;
        case "timeout_update":
          break;
      }

      if (timelineEvent) {
        events.push(timelineEvent);
        if (onEvent) await onEvent(timelineEvent);
      }
    }

    return {
      success, testId, testName, suiteId, suiteName, events, error, stack,
      duration: Date.now() - startTime, retryCount, assertionCount, failedAssertionCount,
      peakMemoryBytes, peakMemoryMB,
    };
  }

  async executeMany(
    testUrl: string,
    testIds: string[],
    context: ExecutionContext,
    options: ExecutionOptions = {},
  ): Promise<ExecutionBatchResult> {
    const startTime = Date.now();
    const concurrency = Math.max(DEFAULT_CONCURRENCY, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, testIds.length || DEFAULT_CONCURRENCY));
    const results: ExecutionResult[] = new Array(testIds.length);
    const onEvent = options.onEvent;
    let failedCount = 0;
    let nextIndex = 0;
    let stop = false;

    const runNext = async (): Promise<void> => {
      while (!stop) {
        const index = nextIndex++;
        if (index >= testIds.length) return;
        const testId = testIds[index];
        const result = await this.execute(testUrl, testId, context, { onEvent, includeTestId: !!onEvent });
        results[index] = result;
        if (!result.success) {
          failedCount += 1;
          const failureLimit = options.failAfter ?? (options.stopOnFailure ? 1 : undefined);
          if (failureLimit !== undefined && failedCount >= failureLimit) {
            stop = true;
            return;
          }
        }
      }
    };

    const workers = Array.from({ length: concurrency }, () => runNext());
    await Promise.all(workers);

    const completedResults = results.filter(Boolean);
    const skippedCount = testIds.length - completedResults.length;

    return { results: completedResults, success: failedCount === 0, failedCount, skippedCount, duration: Date.now() - startTime };
  }
}
