import { spawn } from "node:child_process";
import { existsSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, join } from "node:path";
import { createRequire } from "node:module";
import type { Trace, GlubeanAction, GlubeanEvent, RunContext } from "@glubean/sdk";
import type { SharedRunConfig } from "./config.js";
import { generateSummary } from "./generate_summary.js";
import { buildRunContext } from "./run_context.js";
import { discoverSessionFile, createContextWithSession } from "./orchestrator.js";

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_TIMEOUT_MS = 30000;

// ── Event Types ─────────────────────────────────────────────────────────────

/**
 * Events emitted by the harness subprocess during test execution.
 * All test-scoped events carry an optional `testId` field for attribution
 * (always present when emitted inside a test context via emitEvent()).
 */
export type ExecutionEvent = { testId?: string } & (
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
  | { type: "trace"; data: Trace; stepIndex?: number }
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
  | { type: "session:set"; key: string; value: unknown; ts: number }
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
  }
);

// ── Execution Context ───────────────────────────────────────────────────────

export interface ExecutionContext {
  vars: Record<string, string>;
  secrets: Record<string, string>;
  session?: Record<string, unknown>;
  /** When set, harness runs session.ts setup/teardown instead of tests. */
  sessionMode?: "setup" | "teardown";
  test?: {
    id?: string;
    tags?: string[];
  };
  retryCount?: number;
}

// ── Timeline Events ─────────────────────────────────────────────────────────

export type TimelineEvent =
  | { type: "log"; ts: number; testId?: string; stepIndex?: number; message: string; data?: unknown }
  | { type: "assertion"; ts: number; testId?: string; stepIndex?: number; passed: boolean; message: string; actual?: unknown; expected?: unknown }
  | { type: "warning"; ts: number; testId?: string; stepIndex?: number; condition: boolean; message: string }
  | { type: "schema_validation"; ts: number; testId?: string; stepIndex?: number; label: string; success: boolean; severity: "error" | "warn" | "fatal"; issues?: Array<{ message: string; path?: Array<string | number> }> }
  | { type: "trace"; ts: number; testId?: string; stepIndex?: number; data: Trace }
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
  signal?: AbortSignal;
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
  context?: RunContext;
}

export interface ExecutionOptions {
  concurrency?: number;
  stopOnFailure?: boolean;
  failAfter?: number;
  onEvent?: EventHandler;
  signal?: AbortSignal;
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
  inferSchema?: boolean;
  truncateArrays?: boolean;
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

  // ── Session state (opt-in via .withSession()) ─────────────────────────
  private _sessionEnabled = false;
  private _sessionRootDir?: string;
  private _sessionFile?: string;
  private _sessionState: Record<string, unknown> = {};
  private _sessionSetupDone = false;
  private _sessionSetupFailed = false;
  private _sessionSetupPromise?: Promise<void>;

  // ── Zero-project state (scratch mode) ─────────────────────────────────
  private _zeroProjectSetup = false;
  private _zeroProjectTsxArgs: string[] = [];
  private _zeroProjectEnv: Record<string, string> = {};
  private _tempPackageJson: "created" | "patched" | false = false;
  private _originalPackageJson?: string;

  constructor(options: ExecutorOptions = {}) {
    // Use .js (compiled) — works with tsx and matches npm-published dist/
    this.harnessPath = resolve(__dirname, "harness.js");
    this.options = options;
  }

  static fromSharedConfig(
    shared: SharedRunConfig,
    overrides?: Partial<ExecutorOptions>,
  ): TestExecutor {
    return new TestExecutor({
      emitFullTrace: shared.emitFullTrace,
      inferSchema: shared.inferSchema,
      truncateArrays: shared.truncateArrays,
      ...overrides,
    });
  }

  /**
   * Enable auto-session discovery and lifecycle.
   *
   * When enabled, the first `run()` call discovers the nearest `session.ts`
   * (walking up from the test file's directory to `rootDir`), runs setup,
   * and injects session state into all subsequent `run()` calls.
   *
   * Call `finalize()` when all tests are done to run teardown.
   *
   * @param rootDir  Stop directory for session discovery (defaults to `cwd`).
   */
  withSession(rootDir?: string): this {
    this._sessionEnabled = true;
    this._sessionRootDir = rootDir ?? this.options.cwd;
    return this;
  }

  /** True if session setup has completed (successfully or not). */
  get sessionReady(): boolean {
    return this._sessionSetupDone;
  }

  /** Accumulated session state from setup. */
  get sessionState(): Readonly<Record<string, unknown>> {
    return this._sessionState;
  }

  /**
   * Run session teardown if a session was set up.
   * Safe to call multiple times — only runs once.
   * Yields session lifecycle events (log, status).
   */
  async *finalize(): AsyncGenerator<ExecutionEvent> {
    // Session teardown
    if (this._sessionFile && this._sessionSetupDone) {
      const sessionUrl = pathToFileURL(this._sessionFile).href;
      const ctx: ExecutionContext = {
        ...createContextWithSession(
          { vars: {}, secrets: {} },
          this._sessionState,
        ),
        sessionMode: "teardown",
      };

      try {
        for await (const event of this.run(sessionUrl, "__session__", ctx)) {
          yield event;
        }
      } catch (err) {
        yield {
          type: "log",
          message: `Session teardown error: ${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        this._sessionFile = undefined;
      }
    }

    // Zero-project cleanup
    this._cleanupZeroProject();
  }

  /**
   * Internal: ensure session setup has run exactly once.
   * Concurrent callers share the same setup promise.
   */
  private async _ensureSessionSetup(testDir: string): Promise<void> {
    if (this._sessionSetupDone) return;

    if (!this._sessionSetupPromise) {
      this._sessionSetupPromise = (async () => {
        const rootDir = this._sessionRootDir ?? this.options.cwd;
        const sessionFile = discoverSessionFile(testDir, rootDir);
        if (!sessionFile) {
          this._sessionSetupDone = true;
          return;
        }

        this._sessionFile = sessionFile;
        const sessionUrl = pathToFileURL(sessionFile).href;
        const ctx: ExecutionContext = {
          ...createContextWithSession({ vars: {}, secrets: {} }, {}),
          sessionMode: "setup",
        };

        for await (const event of this.run(sessionUrl, "__session__", ctx)) {
          if (event.type === "session:set") {
            this._sessionState[event.key] = event.value;
          } else if (event.type === "status" && event.status === "failed") {
            this._sessionSetupFailed = true;
          }
        }

        this._sessionSetupDone = true;
      })();
    }

    await this._sessionSetupPromise;
  }

  /**
   * Internal: set up zero-project mode once per executor instance.
   * Creates temp package.json and resolver args if no @glubean/sdk in node_modules.
   */
  private async _ensureZeroProject(cwd: string): Promise<void> {
    if (this._zeroProjectSetup) return;
    this._zeroProjectSetup = true;

    if (existsSync(join(cwd, "node_modules", "@glubean", "sdk"))) return;

    const registerPath = resolve(__dirname, "zero-project-register.mjs");
    this._zeroProjectTsxArgs.push("--import", registerPath);

    const sdkUrl = import.meta.resolve("@glubean/sdk");
    const sdkEntry = fileURLToPath(sdkUrl);
    this._zeroProjectEnv["GLUBEAN_VENDORED_ROOT"] = resolve(dirname(sdkEntry), "../../..");

    const pkgPath = join(cwd, "package.json");
    if (!existsSync(pkgPath)) {
      try {
        writeFileSync(pkgPath, '{"type":"module"}\n');
        this._tempPackageJson = "created";
      } catch {
        // Non-critical
      }
    } else {
      try {
        const original = readFileSync(pkgPath, "utf-8");
        const pkg = JSON.parse(original);
        if (pkg.type !== "module") {
          this._originalPackageJson = original;
          pkg.type = "module";
          writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
          this._tempPackageJson = "patched";
        }
      } catch {
        // Non-critical
      }
    }
  }

  /**
   * Internal: clean up zero-project temp files.
   */
  private _cleanupZeroProject(): void {
    if (!this._tempPackageJson) return;
    const cwd = this.options.cwd || process.cwd();
    const pkgPath = join(cwd, "package.json");
    try {
      if (this._tempPackageJson === "created") {
        unlinkSync(pkgPath);
      } else if (this._tempPackageJson === "patched" && this._originalPackageJson) {
        writeFileSync(pkgPath, this._originalPackageJson);
      }
    } catch {
      // Non-critical
    }
    this._tempPackageJson = false;
  }

  async *run(
    testUrl: string,
    testId: string,
    context: ExecutionContext,
    options?: { timeout?: number; exportName?: string; testIds?: string[]; exportNames?: Record<string, string>; signal?: AbortSignal; concurrency?: number },
  ): AsyncGenerator<ExecutionEvent> {
    // Auto-session: run setup on first call (skip for __session__ calls to avoid recursion)
    if (this._sessionEnabled && testId !== "__session__") {
      const testDir = dirname(fileURLToPath(testUrl));
      await this._ensureSessionSetup(testDir);

      if (this._sessionSetupFailed) {
        yield { type: "status", status: "failed", error: "Session setup failed. Test skipped." };
        return;
      }

      // Inject session state into context if setup produced values
      if (Object.keys(this._sessionState).length > 0 && !context.session) {
        context = createContextWithSession(context, this._sessionState);
      }
    }
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
    if (this.options.inferSchema) {
      args.push("--inferSchema");
    }
    if (this.options.truncateArrays) {
      args.push("--truncateArrays");
    }
    if (options?.concurrency && options.concurrency > 1) {
      args.push(`--concurrency=${options.concurrency}`);
    }

    // Build env
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (nodeOptions.length > 0) {
      env["NODE_OPTIONS"] = nodeOptions.join(" ");
    }

    // ── Zero-project mode (scratch) ────────────────────────────────────────
    const cwd = this.options.cwd || process.cwd();
    await this._ensureZeroProject(cwd);

    // Merge zero-project env vars
    for (const [k, v] of Object.entries(this._zeroProjectEnv)) {
      env[k] = v;
    }

    // Spawn tsx subprocess via node
    const child = spawn("node", [resolveTsxPath(), ...this._zeroProjectTsxArgs, ...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", (inspectBrk || env["GLUBEAN_DEBUG"]) ? "inherit" : "pipe"],
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

    // AbortSignal support
    const abortSignal = options?.signal;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        child.kill("SIGTERM");
        aborted = true;
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // Use an async iterator pattern to yield events
    const eventQueue: ExecutionEvent[] = [];
    let resolveWait: (() => void) | undefined;
    let done = false;

    // Handle spawn failure (e.g. node not installed)
    child.on("error", (err) => {
      const errno = (err as NodeJS.ErrnoException).code;
      if (errno === "ENOENT") {
        eventQueue.push({
          type: "error",
          message: "NODE_NOT_FOUND: Node.js is not installed. Glubean requires Node.js 20+ to run tests.\nDownload from https://nodejs.org",
        });
      } else {
        eventQueue.push({
          type: "error",
          message: `Failed to start test process: ${err.message}`,
        });
      }
      done = true;
      resolveWait?.();
    });

    // Read stdout line by line
    let stdoutBuffer = "";
    const stderrChunks: Buffer[] = [];

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    }

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
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);

      const stderr = Buffer.concat(stderrChunks).toString();

      if (code !== 0) {
        if (aborted) {
          eventQueue.push({ type: "error", message: "Test execution was cancelled" });
        } else if (timedOut) {
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

    for await (const event of this.run(testUrl, testId, context, { timeout: options?.timeout, signal: options?.signal })) {
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

        case "session:set":
          // Internal-only: accumulated by orchestrator, never in timeline
          break;
      }

      if (timelineEvent) {
        events.push(timelineEvent);
        if (onEvent) await onEvent(timelineEvent);
      }
    }

    // Override success based on timeline events (catches soft assertion failures
    // that the harness status event may miss).  Never flip a failure back to success —
    // status/error events from the harness are authoritative for hard failures.
    const summary = generateSummary(events);
    if (!summary.success) success = false;

    return {
      success, testId, testName, suiteId, suiteName, events, error, stack,
      duration: Date.now() - startTime, retryCount, assertionCount, failedAssertionCount,
      peakMemoryBytes, peakMemoryMB,
      context: buildRunContext(),
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
        if (options.signal?.aborted) { stop = true; return; }
        const index = nextIndex++;
        if (index >= testIds.length) return;
        const testId = testIds[index];
        const result = await this.execute(testUrl, testId, context, { onEvent, includeTestId: !!onEvent, signal: options.signal });
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

// Re-export for consumers
export { generateSummary } from "./generate_summary.js";
export type { Summary } from "./generate_summary.js";
