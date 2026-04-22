/**
 * @module project-runner
 *
 * `ProjectRunner` — single top-level API for "run the tests of a project".
 *
 * Wraps the orchestration primitives (`loadProjectEnv`, `bootstrap`,
 * `RunOrchestrator`, `TestExecutor`) into one coherent pipeline with a
 * well-typed event stream. Consumers (CLI, MCP, VSCode extension,
 * third-party embedders) all go through this facade rather than re-
 * assembling the primitives themselves.
 *
 * **Scope boundary:**
 * - Facade does: env load → bootstrap → per-file-batched TestExecutor
 *   loop with session setup/teardown, metric recording
 * - Facade does NOT: console presentation, trace-file writing, upload,
 *   result.json formatting, CI-specific flag guards, summary judgment.
 *   Consumers build their own summary by observing events.
 *
 * Batching is fixed at per-file batched (one tsx subprocess per file,
 * all of that file's testIds batched into `TestExecutor.run(fileUrl, "",
 * ctx, {testIds})`).
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bootstrap } from "./bootstrap.js";
import { TestExecutor } from "./executor.js";
import type { ExecutionEvent } from "./executor.js";
import {
  discoverSessionFile,
  RunOrchestrator,
} from "./orchestrator.js";
import { MetricCollector } from "./thresholds.js";
import type { SharedRunConfig } from "./config.js";
import { toSingleExecutionOptions } from "./config.js";
import type { TestMeta } from "@glubean/sdk";

// =============================================================================
// Public types
// =============================================================================

/** Descriptor for a test the facade is asked to run. */
export interface ProjectRunnerTest {
  filePath: string;
  exportName: string;
  meta: TestMeta;
}

/**
 * Event stream yielded by `ProjectRunner.run()`. Causally ordered:
 *   bootstrap:start → bootstrap:done | bootstrap:failed
 *   discovery:done
 *   session:discovered
 *   session:setup:start → session:setup:event* → session:setup:done | session:setup:failed
 *   (file:start → file:event* → file:complete)+
 *   session:teardown:start → session:teardown:event* → session:teardown:done
 *   run:complete | run:failed
 *
 * On non-recoverable failure (bootstrap failed, session setup failed), the
 * stream skips straight to `run:failed` after best-effort teardown.
 */
export type ProjectRunEvent =
  | { type: "bootstrap:start"; projectRoot: string }
  | { type: "bootstrap:done" }
  | { type: "bootstrap:failed"; error: Error }
  | { type: "discovery:done"; totalFiles: number; totalTests: number }
  | { type: "session:discovered"; sessionFile: string | undefined }
  | { type: "session:setup:start"; sessionFile: string }
  | { type: "session:setup:event"; event: ExecutionEvent }
  | { type: "session:setup:done"; stateKeys: string[] }
  | { type: "session:setup:failed"; error?: string; stack?: string }
  | { type: "session:teardown:start"; sessionFile: string }
  | { type: "session:teardown:event"; event: ExecutionEvent }
  | { type: "session:teardown:done" }
  | { type: "file:start"; filePath: string; testCount: number }
  | { type: "file:event"; filePath: string; event: ExecutionEvent }
  | { type: "file:complete"; filePath: string; duration: number }
  | { type: "run:complete"; failedCount: number; passedCount: number; skippedCount: number }
  | { type: "run:failed"; reason: "bootstrap-failed" | "session-setup-failed"; error?: string };

export interface ProjectRunnerOptions {
  /** Absolute project root directory. */
  rootDir: string;

  /** Resolved `SharedRunConfig` (facade does not load config). */
  sharedConfig: SharedRunConfig;

  /**
   * Pre-loaded project env. Caller is responsible for resolving
   * `--env-file` / `.glubean/active-env` priority chain and calling
   * `loadProjectEnv(rootDir, envFileName)`.
   *
   * Kept as caller responsibility because some callers (CLI upload
   * preflight, MCP auth probe) need access to vars/secrets before the
   * run starts.
   */
  vars: Record<string, string>;
  secrets: Record<string, string>;

  /**
   * Starting directory for session.ts walk-up. Defaults to `rootDir`.
   * Pass the test target directory when tests live outside the project
   * root (CLI `run packages/foo/tests` scenario).
   */
  sessionStartDir?: string;

  /** Tests to run, pre-discovered by the caller. */
  tests: ProjectRunnerTest[];

  /** Disable session discovery + lifecycle. Default: false. */
  noSession?: boolean;

  /** Interactive flag forwarded to session setup. */
  interactive?: boolean;

  /** Chrome inspect-brk port. */
  inspectBrk?: number | boolean;

  /** Abort signal to cancel in-flight run. */
  signal?: AbortSignal;

  /**
   * Optional metric collector. Facade records "metric" events into it; if
   * omitted, facade creates its own internal one and discards it at end.
   * Pass one if you want to inspect metrics after the run (e.g. for
   * threshold evaluation at CLI level).
   */
  metricCollector?: MetricCollector;

  /**
   * Optional pre-constructed `TestExecutor`. When provided, the facade uses
   * this instance instead of building its own via
   * `TestExecutor.fromSharedConfig(...)`. Intended for tests that want to
   * observe executor behavior (e.g. spy on `finalize()`), but also usable
   * by callers who want to pre-configure the executor with extra options
   * not surfaced in `ProjectRunnerOptions`.
   *
   * The facade still owns `executor.finalize()` — it is always drained in
   * the generator's `finally` block regardless of how the executor was
   * constructed.
   */
  executor?: TestExecutor;
}

// =============================================================================
// ProjectRunner
// =============================================================================

export class ProjectRunner {
  private readonly options: ProjectRunnerOptions;

  constructor(options: ProjectRunnerOptions) {
    this.options = options;
  }

  /**
   * Run the full pipeline as an async event stream.
   *
   * @example
   * ```ts
   * const runner = new ProjectRunner({...});
   * for await (const event of runner.run()) {
   *   switch (event.type) { ... }
   * }
   * ```
   */
  async *run(): AsyncGenerator<ProjectRunEvent> {
    const {
      rootDir,
      sharedConfig,
      vars: envVars,
      secrets,
      tests,
      noSession = false,
      interactive = false,
      signal,
    } = this.options;

    const sessionStartDir = this.options.sessionStartDir ?? rootDir;
    const metricCollector = this.options.metricCollector ?? new MetricCollector();

    // ── 1. Bootstrap ─────────────────────────────────────────────────
    yield { type: "bootstrap:start", projectRoot: rootDir };
    try {
      await bootstrap(rootDir);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      yield { type: "bootstrap:failed", error };
      yield { type: "run:failed", reason: "bootstrap-failed", error: error.message };
      return;
    }
    yield { type: "bootstrap:done" };

    // ── 3. Group tests by file (per-file batching) ───────────────────
    const fileGroups = new Map<string, ProjectRunnerTest[]>();
    for (const t of tests) {
      const group = fileGroups.get(t.filePath) || [];
      group.push(t);
      fileGroups.set(t.filePath, group);
    }
    yield { type: "discovery:done", totalFiles: fileGroups.size, totalTests: tests.length };

    // ── 4. Build executor (shared across all files) ──────────────────
    const executor = this.options.executor ?? TestExecutor.fromSharedConfig(
      sharedConfig,
      {
        cwd: rootDir,
        ...(this.options.inspectBrk !== undefined && { inspectBrk: this.options.inspectBrk }),
      },
    );
    const orchestrator = new RunOrchestrator(executor);
    const sessionState: Record<string, unknown> = {};
    let sessionSetupSucceeded = false;

    // Wrap all post-executor-construction work in try/finally so the
    // executor's own cleanup path (zero-project scratch teardown, any
    // future finalizers) always runs — even on early return from
    // session-setup failure or signal abort. This also covers the case
    // where the generator is abandoned by its caller (iterator .return()
    // triggers the finally block).
    try {
      // ── 5. Session setup ───────────────────────────────────────────
      const sessionFile = noSession ? undefined : discoverSessionFile(sessionStartDir, rootDir);
      yield { type: "session:discovered", sessionFile };

      if (sessionFile) {
        yield { type: "session:setup:start", sessionFile };
        let setupFailed = false;
        let failureInfo: { error?: string; stack?: string } | undefined;

        for await (const event of orchestrator.runSessionSetup(
          sessionFile,
          { vars: envVars, secrets, interactive },
          toSingleExecutionOptions(sharedConfig),
        )) {
          if (event.type === "session:set") {
            sessionState[event.key] = event.value;
          } else if (event.type === "status" && event.status === "failed") {
            setupFailed = true;
            failureInfo = { error: event.error, stack: event.stack };
          }
          yield { type: "session:setup:event", event };
        }

        if (setupFailed) {
          yield { type: "session:setup:failed", ...(failureInfo ?? {}) };

          // Best-effort teardown before bailing.
          yield { type: "session:teardown:start", sessionFile };
          for await (const event of orchestrator.runSessionTeardown(
            sessionFile,
            { vars: envVars, secrets },
            sessionState,
            toSingleExecutionOptions(sharedConfig),
          )) {
            yield { type: "session:teardown:event", event };
          }
          yield { type: "session:teardown:done" };

          yield {
            type: "run:failed",
            reason: "session-setup-failed",
            ...(failureInfo?.error !== undefined && { error: failureInfo.error }),
          };
          return;
        }

        sessionSetupSucceeded = true;
        yield { type: "session:setup:done", stateKeys: Object.keys(sessionState) };
      }

      // ── 6. File loop (per-file batched) ────────────────────────────
      let passedCount = 0;
      let failedCount = 0;
      let skippedCount = 0;
      const failureLimit = sharedConfig.failAfter ??
        (sharedConfig.failFast ? 1 : undefined);

      for (const [filePath, fileTests] of fileGroups) {
        if (signal?.aborted) break;
        if (failureLimit !== undefined && failedCount >= failureLimit) break;

        const testFileUrl = pathToFileURL(resolve(filePath)).href;
        const testIds = fileTests.map((t) => t.meta.id);
        const exportNames: Record<string, string> = {};
        for (const t of fileTests) exportNames[t.meta.id] = t.exportName;

        yield { type: "file:start", filePath, testCount: fileTests.length };
        const fileStart = Date.now();

        for await (const event of executor.run(
          testFileUrl,
          "",
          {
            vars: envVars,
            secrets,
            ...(Object.keys(sessionState).length > 0 && { session: sessionState }),
          },
          {
            ...toSingleExecutionOptions(sharedConfig),
            testIds,
            exportNames,
            ...(fileTests.some((t) => t.meta.parallel) && sharedConfig.concurrency > 1
              ? { concurrency: sharedConfig.concurrency }
              : {}),
          },
        )) {
          if (event.type === "session:set") {
            sessionState[event.key] = event.value;
          }
          if (event.type === "metric") {
            metricCollector.add(event.name, event.value);
          }
          if (event.type === "status") {
            if (event.status === "completed") passedCount += 1;
            else if (event.status === "skipped") skippedCount += 1;
            else failedCount += 1;
          }
          yield { type: "file:event", filePath, event };
        }

        yield { type: "file:complete", filePath, duration: Date.now() - fileStart };
      }

      // ── 7. Session teardown ────────────────────────────────────────
      if (sessionFile && sessionSetupSucceeded) {
        yield { type: "session:teardown:start", sessionFile };
        for await (const event of orchestrator.runSessionTeardown(
          sessionFile,
          { vars: envVars, secrets },
          sessionState,
          toSingleExecutionOptions(sharedConfig),
        )) {
          yield { type: "session:teardown:event", event };
        }
        yield { type: "session:teardown:done" };
      }

      // ── 8. Done ────────────────────────────────────────────────────
      yield { type: "run:complete", passedCount, failedCount, skippedCount };
    } finally {
      // Drain executor.finalize() — zero-project scratch cleanup and any
      // future executor-level finalizers. Safe to call even after session
      // teardown already ran (executor.finalize() guards on _sessionSetupDone,
      // which stays false when sessions are driven by RunOrchestrator rather
      // than executor auto-session). Discard yielded events; this is pure
      // cleanup, not part of the user-visible run.
      try {
        for await (const _ of executor.finalize()) {
          // intentionally drain
        }
      } catch {
        // Finalize errors are non-fatal — surface silently to avoid masking
        // the primary run outcome. Could be upgraded to a warning event
        // later if needed.
      }
    }
  }
}

