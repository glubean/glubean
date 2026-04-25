/**
 * @module run-case
 *
 * Public programmatic wrapper for the runner-input-channel surface
 * (attachment-model §8). Mirrors CLI `--input-json` / `--bootstrap-json` /
 * `--force-standalone` and MCP `glubean_run_local_file`'s `inputJson` /
 * `bootstrapInput` / `forceStandalone` parameters.
 *
 * Use cases:
 *   - Embedders / scripts that want to drive a single contract case with
 *     a specific input shape without going through the CLI.
 *   - Cookbook examples illustrating attachment-model §5.1 / §8 flows.
 *
 * Implementation strategy: serialize the per-test inputs into the same
 * env vars the harness reads (`GLUBEAN_RUNNER_*`), then construct a
 * `ProjectRunner` with a single test descriptor. Env vars are restored
 * to their prior values in `finally`, so concurrent callers in the
 * same process don't leak state.
 */

import { resolve } from "node:path";
import { ProjectRunner } from "./project-runner.js";
import type {
  ProjectRunEvent,
  ProjectRunnerTest,
} from "./project-runner.js";
import type { SharedRunConfig } from "./config.js";
import { applyEnvTemplating } from "./runner-input-templating.js";

/** Result of running a single case via {@link runCase}. */
export interface RunCaseResult {
  /** Did the case pass? */
  success: boolean;
  /** Test id that ran. */
  testId: string;
  /** Project root resolved from the file path's ancestry. */
  projectRoot: string;
  /** All events emitted by `ProjectRunner` for this run, in order. */
  events: ProjectRunEvent[];
  /**
   * If the run did not reach a per-test success/fail status (e.g.
   * bootstrap or session setup failed), this carries the reason.
   */
  orchestrationError?: string;
}

/** Options for {@link runCase}. */
export interface RunCaseOptions {
  /** Absolute (preferred) path to the test/contract file. */
  filePath: string;
  /** Specific testId to dispatch (e.g. `"orders.create.success"`). */
  testId: string;
  /** Display name for the test. Optional; falls back to `testId`. */
  testName?: string;
  /** Export name on the file. When omitted, `ProjectRunner` resolves it. */
  exportName?: string;
  /** Project root override. When omitted, `filePath`'s directory is used. */
  rootDir?: string;
  /** Shared run config (timeouts, schema inference, etc.). */
  sharedConfig: SharedRunConfig;
  /** Skip session setup/teardown. */
  noSession?: boolean;

  /**
   * Spike 3 attachment-model §8 — explicit case input. Validated
   * against the case's `needs` schema; runs raw (overlay skipped).
   */
  input?: unknown;

  /**
   * Spike 3 attachment-model §8 — bootstrap params. Validated against
   * the overlay's `params` schema and passed to `run(ctx, params)`.
   */
  bootstrapInput?: unknown;

  /**
   * §6.3 debug escape valve for `runnability.requireAttachment` on
   * no-needs cases. Emits a runtime warning when triggered.
   */
  forceStandalone?: boolean;

  /**
   * Optional env map for `{{VAR}}` substitution inside `input` /
   * `bootstrapInput` (§8). Defaults to `process.env`. Embedders that
   * load project `.env` files can pass a merged map here so secrets
   * don't have to be re-injected into the process.
   */
  templatingEnv?: Record<string, string | undefined>;
}

/**
 * Run a single contract case programmatically with optional explicit
 * input or bootstrap params. Mirrors the runtime resolution algorithm
 * (§5.1) used by the CLI and MCP surfaces.
 *
 * @example Run a needs-case with explicit input (overlay skipped)
 * ```ts
 * import { runCase } from "@glubean/runner";
 *
 * const result = await runCase({
 *   filePath: "/abs/path/to/users.contract.ts",
 *   testId: "users.get.ok",
 *   sharedConfig: { ...default... },
 *   input: { token: "tk-1", userId: "u-42" },
 * });
 * console.log(result.success);
 * ```
 *
 * @example Run with bootstrap params
 * ```ts
 * const result = await runCase({
 *   filePath: "/abs/.../orders.contract.ts",
 *   testId: "orders.list.seeded",
 *   sharedConfig: { ...default... },
 *   bootstrapInput: { projectId: "p_42" },
 * });
 * ```
 */
export async function runCase(opts: RunCaseOptions): Promise<RunCaseResult> {
  const filePath = resolve(opts.filePath);
  const rootDir = opts.rootDir ?? filePath.replace(/\/[^/]+$/, "");

  // Capture & set env vars BEFORE constructing ProjectRunner — the
  // executor inherits parent env when spawning the harness subprocess.
  const savedExplicit = process.env["GLUBEAN_RUNNER_EXPLICIT_INPUT_MAP"];
  const savedBootstrap = process.env["GLUBEAN_RUNNER_BOOTSTRAP_INPUT_MAP"];
  const savedForce = process.env["GLUBEAN_RUNNER_FORCE_STANDALONE_IDS"];

  // §8 templating env — caller-provided or process.env. Substitution
  // happens before serialization (and therefore before schema validation
  // in the harness).
  const templatingEnv: Record<string, string | undefined> =
    opts.templatingEnv ?? process.env;

  if (opts.input !== undefined) {
    const templated = applyEnvTemplating(opts.input, templatingEnv);
    process.env["GLUBEAN_RUNNER_EXPLICIT_INPUT_MAP"] = JSON.stringify({
      [opts.testId]: templated,
    });
  }
  if (opts.bootstrapInput !== undefined) {
    const templated = applyEnvTemplating(opts.bootstrapInput, templatingEnv);
    process.env["GLUBEAN_RUNNER_BOOTSTRAP_INPUT_MAP"] = JSON.stringify({
      [opts.testId]: templated,
    });
  }
  if (opts.forceStandalone === true) {
    process.env["GLUBEAN_RUNNER_FORCE_STANDALONE_IDS"] = JSON.stringify([
      opts.testId,
    ]);
  }

  const restoreEnv = () => {
    if (savedExplicit === undefined) {
      delete process.env["GLUBEAN_RUNNER_EXPLICIT_INPUT_MAP"];
    } else {
      process.env["GLUBEAN_RUNNER_EXPLICIT_INPUT_MAP"] = savedExplicit;
    }
    if (savedBootstrap === undefined) {
      delete process.env["GLUBEAN_RUNNER_BOOTSTRAP_INPUT_MAP"];
    } else {
      process.env["GLUBEAN_RUNNER_BOOTSTRAP_INPUT_MAP"] = savedBootstrap;
    }
    if (savedForce === undefined) {
      delete process.env["GLUBEAN_RUNNER_FORCE_STANDALONE_IDS"];
    } else {
      process.env["GLUBEAN_RUNNER_FORCE_STANDALONE_IDS"] = savedForce;
    }
  };

  const test: ProjectRunnerTest = {
    filePath,
    exportName: opts.exportName ?? "",
    meta: {
      id: opts.testId,
      name: opts.testName ?? opts.testId,
    } as ProjectRunnerTest["meta"],
  };

  const runner = new ProjectRunner({
    rootDir,
    sharedConfig: opts.sharedConfig,
    vars: {},
    secrets: {},
    tests: [test],
    noSession: opts.noSession ?? true,
  });

  const events: ProjectRunEvent[] = [];
  let success = false;
  let orchestrationError: string | undefined;

  try {
    for await (const evt of runner.run()) {
      events.push(evt);
      if (evt.type === "bootstrap:failed") {
        orchestrationError = `Bootstrap failed: ${evt.error.message}`;
      } else if (evt.type === "session:setup:failed") {
        orchestrationError = `Session setup failed${evt.error ? `: ${evt.error}` : ""}`;
      } else if (evt.type === "run:failed") {
        if (!orchestrationError) {
          orchestrationError = `Run failed (${evt.reason})${evt.error ? `: ${evt.error}` : ""}`;
        }
      } else if (evt.type === "file:event") {
        // ExecutionEvent's `status` event encodes the final per-test
        // outcome: "completed" = pass, "failed" = fail, "skipped" = neither.
        if (evt.event.type === "status" && evt.event.id === opts.testId) {
          success = evt.event.status === "completed";
        }
      }
    }
  } finally {
    restoreEnv();
  }

  return {
    success,
    testId: opts.testId,
    projectRoot: rootDir,
    events,
    ...(orchestrationError !== undefined ? { orchestrationError } : {}),
  };
}
