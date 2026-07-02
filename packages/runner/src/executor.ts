import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import type { Trace, GlubeanAction, GlubeanEvent, RunContext, EachRowMeta } from "@glubean/sdk";
import type { SharedRunConfig } from "./config.js";
import { generateSummary } from "./generate_summary.js";
import { buildRunContext } from "./run_context.js";
import { discoverSessionFile, createContextWithSession } from "./orchestrator.js";
import {
  resolveRunnerRoot,
  resolveTsxPath,
  prepareZeroProject,
  type RunnerWarning,
} from "./runner-resolve.js";

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_TIMEOUT_MS = 30000;

// ── Sibling-file suggestions for missing test file (Plan 4) ────────────────

/**
 * Quick Levenshtein distance (capped at 5 for early termination).
 */
function editDistance(a: string, b: string, cap = 5): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1).fill(0).map((_, i) => i);
  let curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cap) return cap + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

async function siblingSuggestions(missingPath: string): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const parentDir = dirname(missingPath);
    const wantedBase = missingPath.split("/").pop()!;
    const candidates = await readdir(parentDir);
    return candidates
      .filter((c) => c.endsWith(".test.ts") || c.endsWith(".test.js") || c.endsWith(".test.mts"))
      .map((c) => ({ name: c, full: resolve(parentDir, c) }))
      .map(({ name, full }) => ({ full, d: editDistance(wantedBase, name) }))
      .filter(({ d }) => d <= 5)
      .sort((a, b) => a.d - b.d)
      .slice(0, 5)
      .map(({ full }) => full);
  } catch {
    return [];
  }
}


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
    /** 0-based `.each` row index (post-filter); undefined for non-each tests. */
    rowIndex?: number;
    /**
     * Data-driven row provenance (B3 T3, `run-evidence-identity-model.md` §7/§14) —
     * `idTemplate`/reorder-stable `rowKey`/`$index` stability flag, mirrored from
     * the SDK's `Test.each`. Present only for `test.each`/`test.pick` rows; lets
     * the run-events channel self-describe row identity without a projection join.
     */
    each?: EachRowMeta;
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
    /**
     * Discriminator for executor-emitted diagnostic warnings. Set by the
     * executor itself (e.g. "runner_fallback", "runner_protocol_old") so
     * consumers can distinguish runner diagnostics from user-emitted
     * `ctx.warn(false, "...")` soft warnings, which omit this field.
     * Used by CLI's dedupe set and MCP's `warnings: []` collection.
     */
    code?: string;
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
    // Rich fields for load-phase failures (Plan 4 — pre-check missing file).
    missingPath?: string;
    suggestions?: string[];
  }
  | {
    type: "error";
    message: string;
    reason?: "http_timeout" | "test_timeout" | "network" | "oom" | "test_file_missing";
    stack?: string;
    missingPath?: string;
    suggestions?: string[];
  }
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
  | {
    type: "branch";
    index: number;
    name: string;
    /** Which case was taken (0-based), or "default" if no case matched. */
    takenIndex: number | "default";
    /** value-switch only: the scalar the subject matched. */
    takenValue?: string | number | boolean | null;
    /** Optional display label. */
    message?: string;
    /** Number of cases (excluding default). */
    total: number;
    /** Set when the branch decision itself failed (predicate threw). */
    error?: string;
  }
  | {
    type: "poll";
    index: number;
    name: string;
    /** Attempts made (>= 1). */
    attempts: number;
    /** Total wall-clock elapsed (ms) across the poll. */
    elapsedMs: number;
    /** True if the exit predicate was satisfied. */
    satisfied: boolean;
    /** True if a bound was exhausted before satisfaction. */
    exhausted: boolean;
    /** Set when the poll failed (exhausted / fn or until threw / non-boolean). */
    error?: string;
  }
  // vNext workflow per-node evidence (§17 #9/#10) — emitted by the harness
  // unwrapping the SDK's workflow:* ctx.event channel. Deliberately separate
  // from the flow branch/poll events above (workflow keeps its own identity).
  | { type: "node_start"; nodeId: string; kind: string; name: string; attempt?: number; attempts?: number }
  | { type: "node_end"; nodeId: string; kind: string; name: string; status: "passed" | "failed" | "skipped"; grade: "full" | "partial" | "trace" | "opaque"; durationMs: number; error?: string; attempt?: number; attempts?: number }
  | { type: "poll_attempt"; nodeId: string; attempt: number; outcome: "satisfied" | "probe" | "failed"; durationMs: number }
  | { type: "branch_decision"; nodeId: string; mode: "predicate" | "value"; takenIndex: number | "default"; takenLabel?: string }
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
  /** Whether user opted into interactive mode (--include-browser). Passed to SessionSetupContext.interactive. */
  interactive?: boolean;
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
  | { type: "branch"; ts: number; testId?: string; index: number; name: string; takenIndex: number | "default"; takenValue?: string | number | boolean | null; message?: string; total: number; error?: string }
  | { type: "poll"; ts: number; testId?: string; index: number; name: string; attempts: number; elapsedMs: number; satisfied: boolean; exhausted: boolean; error?: string }
  // vNext workflow per-node evidence (§17 #9/#10) — first-class, deliberately
  // NOT the flow branch/poll shells above (workflow keeps its own identity —
  // addendum §9 red line). One start/end bracket per node RUN: a retrying node
  // emits one bracket per attempt (attempt/attempts stamped), and the LAST
  // node_end per nodeId carries the verdict.
  | { type: "node_start"; ts: number; testId?: string; nodeId: string; kind: string; name: string; attempt?: number; attempts?: number }
  | { type: "node_end"; ts: number; testId?: string; nodeId: string; kind: string; name: string; status: "passed" | "failed" | "skipped"; grade: "full" | "partial" | "trace" | "opaque"; durationMs: number; error?: string; attempt?: number; attempts?: number }
  | { type: "poll_attempt"; ts: number; testId?: string; nodeId: string; attempt: number; outcome: "satisfied" | "probe" | "failed"; durationMs: number }
  | { type: "branch_decision"; ts: number; testId?: string; nodeId: string; mode: "predicate" | "value"; takenIndex: number | "default"; takenLabel?: string }
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
  /** 0-based `.each` row index (post-filter); undefined for non-each tests. */
  rowIndex?: number;
  /** Data-driven row provenance (B3 T3) — mirrors {@link ExecutionEvent}'s `each`
   *  on the "start" event; undefined for non-each tests. */
  each?: EachRowMeta;
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
  env?: Record<string, string | undefined>;
  emitFullTrace?: boolean;
  inferSchema?: boolean;
  truncateArrays?: boolean;
  inspectBrk?: number | boolean;
}

// ── Resolve harness path ────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  private _sessionSetupError?: { error?: string; stack?: string; reason?: string };
  private _sessionSetupPromise?: Promise<void>;
  // vars/secrets captured from the first `run()` call — reused by the
  // internally-triggered session setup/teardown so session.ts can
  // resolve `{{...}}` placeholders (e.g. base URLs, credentials). The
  // CLI bypasses this by calling RunOrchestrator.runSessionSetup
  // directly with envVars; in-process callers (VSCode extension, SDK
  // consumers) would otherwise hit session setup with empty env.
  private _sessionEnv: { vars: Record<string, string>; secrets: Record<string, string> } = {
    vars: {},
    secrets: {},
  };

  // ── Zero-project state (scratch mode) ─────────────────────────────────
  private _zeroProjectSetup = false;
  private _zeroProjectTsxArgs: string[] = [];
  private _zeroProjectEnv: Record<string, string> = {};
  /** Undoes any temp package.json created/patched by zero-project setup. */
  private _zeroProjectCleanup: () => void = () => {};

  // ── Resolved runner dist (Plan 1 — project-local or bundled) ──────────
  /** Directory containing harness.js, zero-project-register.mjs. */
  private _runnerDistDir!: string;
  /** Package root of the resolved runner — used for GLUBEAN_VENDORED_ROOT. */
  private _runnerPkgRoot!: string;
  /** "project" if resolved from cwd's node_modules, else "bundled". */
  private _runnerSource!: "project" | "bundled";
  /** Absolute path of the main entry that was resolved (telemetry). */
  private _runnerResolvedFrom?: string;
  /** Version field of the resolved runner package.json. */
  private _runnerVersion?: string;
  /**
   * Warnings collected at constructor time that must be surfaced before
   * any spawn. Yielded at the very start of every run() call (NOT cleared
   * — see Plan 1 §3.1 R4 reasoning: ProjectRunner runs session setup via
   * a `run()` call whose consumer doesn't render warnings, so first-call
   * clearing would lose them).
   *
   * Carries a `code` so CLI/MCP consumers can distinguish runner diagnostics
   * from `ctx.warn(false, ...)` user warnings (both share the same
   * { type: "warning", condition: false } shape on the wire).
   */
  private _pendingWarnings: RunnerWarning[] = [];

  constructor(options: ExecutorOptions = {}) {
    const bundledDistDir = __dirname;
    const bundledPkgRoot = resolve(__dirname, "..");
    const cwd = options.cwd ?? process.cwd();
    const resolved = resolveRunnerRoot(cwd, bundledDistDir, bundledPkgRoot);

    this._runnerDistDir = resolved.distDir;
    this._runnerPkgRoot = resolved.pkgRoot;
    this._runnerSource = resolved.source;
    this._runnerResolvedFrom = resolved.resolvedFrom;
    this._runnerVersion = resolved.version;
    this._pendingWarnings = resolved.pendingWarnings;

    this.harnessPath = resolve(this._runnerDistDir, "harness.js");
    this.options = options;
  }

  /** @internal — exposed for testing / telemetry. */
  get runnerSource(): "project" | "bundled" {
    return this._runnerSource;
  }
  /** @internal */
  get runnerResolvedFrom(): string | undefined {
    return this._runnerResolvedFrom;
  }
  /** @internal */
  get runnerVersion(): string | undefined {
    return this._runnerVersion;
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
          { vars: this._sessionEnv.vars, secrets: this._sessionEnv.secrets },
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
          ...createContextWithSession(
            { vars: this._sessionEnv.vars, secrets: this._sessionEnv.secrets },
            {},
          ),
          sessionMode: "setup",
        };

        for await (const event of this.run(sessionUrl, "__session__", ctx)) {
          if (event.type === "session:set") {
            this._sessionState[event.key] = event.value;
          } else if (event.type === "status" && event.status === "failed") {
            this._sessionSetupFailed = true;
            // Capture the underlying error so the outer "Session setup
            // failed. Test skipped." message can include the real cause.
            this._sessionSetupError = {
              error: event.error,
              stack: event.stack,
              reason: event.reason,
            };
          } else if (event.type === "error") {
            // Session file failed to even load (e.g. import error).
            // Only record the first error so we don't overwrite a more
            // specific status failure.
            if (!this._sessionSetupError) {
              this._sessionSetupError = {
                error: event.message,
                reason: event.reason,
              };
            }
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

    const zp = prepareZeroProject(cwd, this._runnerDistDir, this._runnerPkgRoot);
    this._zeroProjectTsxArgs = zp.tsxArgs;
    this._zeroProjectEnv = zp.env;
    this._zeroProjectCleanup = zp.cleanup;
  }

  /**
   * Internal: clean up zero-project temp files.
   */
  private _cleanupZeroProject(): void {
    this._zeroProjectCleanup();
  }

  async *run(
    testUrl: string,
    testId: string,
    context: ExecutionContext,
    options?: { timeout?: number; exportName?: string; testIds?: string[]; exportNames?: Record<string, string>; signal?: AbortSignal; concurrency?: number },
  ): AsyncGenerator<ExecutionEvent> {
    // ── Plan 1 R6: yield pending warnings FIRST (before pre-check / session
    //    / spawn). Do NOT clear after yielding: ProjectRunner may call run()
    //    multiple times (session setup + each file), and the first call's
    //    consumer may not render warnings. Consumers (CLI / MCP) dedupe by
    //    message at render time.
    //
    //    Each warning carries a `code` so consumers can distinguish runner
    //    diagnostics from `ctx.warn(false, ...)` user warnings (which omit
    //    `code` — see ExecutionEvent.warning schema).
    for (const w of this._pendingWarnings) {
      yield { type: "warning", condition: false, message: w.message, code: w.code };
    }

    // ── Plan 4: file pre-check. Emit start + status:failed (matches harness's
    //    "test not found" pattern) so ProjectRunner counts the failure and
    //    MCP attributes it to the requested test. Skip for the synthetic
    //    __session__ "test" — session files are discovered/validated upstream.
    if (testId !== "__session__") {
      const filePath = fileURLToPath(testUrl);
      let preCheckFailure: { message: string; suggestions?: string[] } | undefined;
      try {
        const { stat } = await import("node:fs/promises");
        const s = await stat(filePath);
        if (!s.isFile()) {
          preCheckFailure = { message: `Test path is not a file: ${filePath}` };
        }
      } catch {
        preCheckFailure = {
          message: `Test file not found: ${filePath}`,
          suggestions: await siblingSuggestions(filePath),
        };
      }

      if (preCheckFailure) {
        // Codex R7 P2-2: ProjectRunner batch mode calls run() with
        // testId="" + options.testIds=[a,b,c]. Empty testId means MCP
        // / counters lose attribution. Emit one (start, status:failed)
        // pair per requested testId so the failure attributes correctly.
        const idsToAttribute = options?.testIds && options.testIds.length > 0
          ? options.testIds
          : [testId || filePath];
        for (const id of idsToAttribute) {
          yield { type: "start", id, name: id, testId: id };
          yield {
            type: "status",
            status: "failed",
            id,
            testId: id,
            error: preCheckFailure.message,
            reason: "test_file_missing",
            missingPath: filePath,
            ...(preCheckFailure.suggestions && { suggestions: preCheckFailure.suggestions }),
          };
        }
        return;
      }
    }

    // Auto-session: run setup on first call (skip for __session__ calls to avoid recursion)
    if (this._sessionEnabled && testId !== "__session__") {
      // Capture env from the first real test run so session setup can
      // resolve `{{VAR}}` placeholders. Later calls don't overwrite —
      // session runs once per executor lifetime.
      if (!this._sessionSetupDone && !this._sessionSetupPromise) {
        this._sessionEnv = {
          vars: { ...(context.vars ?? {}) },
          secrets: { ...(context.secrets ?? {}) },
        };
      }
      const testDir = dirname(fileURLToPath(testUrl));
      await this._ensureSessionSetup(testDir);

      if (this._sessionSetupFailed) {
        const detail = this._sessionSetupError?.error;
        yield {
          type: "status",
          status: "failed",
          error: detail
            ? `Session setup failed — test skipped. Cause: ${detail}`
            : "Session setup failed. Test skipped.",
          ...(this._sessionSetupError?.stack && { stack: this._sessionSetupError.stack }),
          ...(this._sessionSetupError?.reason && { reason: this._sessionSetupError.reason }),
        };
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
    for (const [key, value] of Object.entries(this.options.env ?? {})) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
    // Plan 4 (E): always enable source maps so strip-types stack frames
    // translate back to original .ts source lines.
    nodeOptions.push("--enable-source-maps");

    // Plan 4 R3 P1: merge with caller-set NODE_OPTIONS (after options.env
    // overrides have already mutated env[]) instead of overwriting. Pre-empts
    // the regression where setting `options.env.NODE_OPTIONS = undefined`
    // or `--max-old-space-size=4096` would be discarded.
    const existingNodeOpts = env["NODE_OPTIONS"]?.trim();
    const mergedNodeOpts = [existingNodeOpts, ...nodeOptions]
      .filter(Boolean)
      .join(" ");
    if (mergedNodeOpts) {
      env["NODE_OPTIONS"] = mergedNodeOpts;
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
          eventQueue.push({ type: "error", message: `Test execution timed out after ${timeout}ms`, reason: "test_timeout" });
        } else if (signal === "SIGKILL" || code === 137) {
          const heapInfo = this.options.maxHeapSizeMb ? ` (limit: ${this.options.maxHeapSizeMb} MB)` : "";
          const detail = stderr.trim() ? `\n${stderr.trim()}` : "";
          eventQueue.push({
            type: "error",
            message: `Out of memory — process killed${heapInfo}.${detail}\nTo fix: process data in smaller batches.`,
            reason: "oom",
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
    let rowIndex: number | undefined;
    let each: EachRowMeta | undefined;
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
          // rowIndex (B2 M3): surface the `.each` row index on the assembled
          // result so programmatic consumers (not the CLI event stream) can
          // reconstruct a row-pinned selector. undefined for non-each tests.
          rowIndex = event.rowIndex;
          // each (B3 T3): surface the row-identity provenance the same way, so
          // programmatic consumers see it without a projection join.
          each = event.each;
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
        case "branch":
          timelineEvent = { type: "branch", ts, ...(includeTestId && { testId }), index: event.index, name: event.name, takenIndex: event.takenIndex, ...(event.takenValue !== undefined && { takenValue: event.takenValue }), ...(event.message !== undefined && { message: event.message }), total: event.total, ...(event.error !== undefined && { error: event.error }) };
          break;
        case "poll":
          timelineEvent = { type: "poll", ts, ...(includeTestId && { testId }), index: event.index, name: event.name, attempts: event.attempts, elapsedMs: event.elapsedMs, satisfied: event.satisfied, exhausted: event.exhausted, ...(event.error !== undefined && { error: event.error }) };
          break;
        case "node_start":
          timelineEvent = { type: "node_start", ts, ...(includeTestId && { testId }), nodeId: event.nodeId, kind: event.kind, name: event.name, ...(event.attempt !== undefined && { attempt: event.attempt }), ...(event.attempts !== undefined && { attempts: event.attempts }) };
          break;
        case "node_end":
          timelineEvent = { type: "node_end", ts, ...(includeTestId && { testId }), nodeId: event.nodeId, kind: event.kind, name: event.name, status: event.status, grade: event.grade, durationMs: event.durationMs, ...(event.error !== undefined && { error: event.error }), ...(event.attempt !== undefined && { attempt: event.attempt }), ...(event.attempts !== undefined && { attempts: event.attempts }) };
          break;
        case "poll_attempt":
          timelineEvent = { type: "poll_attempt", ts, ...(includeTestId && { testId }), nodeId: event.nodeId, attempt: event.attempt, outcome: event.outcome, durationMs: event.durationMs };
          break;
        case "branch_decision":
          timelineEvent = { type: "branch_decision", ts, ...(includeTestId && { testId }), nodeId: event.nodeId, mode: event.mode, takenIndex: event.takenIndex, ...(event.takenLabel !== undefined && { takenLabel: event.takenLabel }) };
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
      success, testId, testName, rowIndex, each, suiteId, suiteName, events, error, stack,
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
