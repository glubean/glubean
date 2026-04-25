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

import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { ProjectRunner } from "./project-runner.js";
import type {
  ProjectRunEvent,
  ProjectRunnerTest,
} from "./project-runner.js";
import type { SharedRunConfig } from "./config.js";
import { applyEnvTemplating } from "./runner-input-templating.js";
import { loadProjectEnv } from "./env.js";

/**
 * Walk up from `filePath` to find the project root — the nearest
 * ancestor containing `package.json`. Falls back to `filePath`'s
 * directory when no `package.json` is found (matches CLI/MCP behavior
 * for ad-hoc test files outside any project).
 *
 * Mirrors the contract used by `bootstrap()` / `loadProjectOverlays()`
 * / `loadProjectEnv()` — they all key off the project root, so
 * `runCase` must locate the same place when the caller doesn't pass
 * `rootDir` explicitly.
 */
function findProjectRoot(filePath: string): string {
  let dir = dirname(filePath);
  // Bound the walk at filesystem root.
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return dirname(filePath);
}

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
   * `bootstrapInput` (§8). When omitted, the templating env is built
   * from `{ ...vars, ...secrets, ...process.env }` matching CLI / MCP
   * precedence (process.env wins, secrets win over vars).
   */
  templatingEnv?: Record<string, string | undefined>;

  /**
   * Project env-file basename to load (e.g. `".env"` or
   * `".env.staging"`). Loads `<rootDir>/<envFile>` and
   * `<rootDir>/<envFile>.secrets`. Both files are silently treated as
   * empty when absent. Defaults to `".env"` to match CLI / MCP.
   *
   * Set to `null` to skip env-file loading entirely (useful for
   * fixture-driven tests / scripts that don't want any project env).
   */
  envFile?: string | null;

  /**
   * Project vars to inject into `ProjectRunner` (and therefore into
   * `ctx.vars` for the running case). When provided, MERGED ON TOP OF
   * the env loaded from `envFile` (caller-supplied vars win over file
   * vars). Use this to override or extend env values without touching
   * the on-disk `.env`.
   */
  vars?: Record<string, string>;

  /**
   * Project secrets to inject into `ProjectRunner` (and therefore into
   * `ctx.secrets`). Same merge semantics as `vars` — caller-supplied
   * wins over `envFile` values.
   */
  secrets?: Record<string, string>;
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
  // §5.1 invariant: explicit input always wins; overlay never invoked.
  // The two channels are mutually exclusive — surface boundary enforces
  // it so the dispatcher never silently drops the bootstrap-params side.
  if (opts.input !== undefined && opts.bootstrapInput !== undefined) {
    throw new Error(
      `runCase: \`input\` and \`bootstrapInput\` are mutually exclusive. ` +
        `Per attachment-model §5.1: explicit input bypasses the overlay, ` +
        `so bootstrap params would be ignored. Pick one channel per call.`,
    );
  }

  const filePath = resolve(opts.filePath);
  // §7.4 / glubean.setup.ts location: project root must be the directory
  // containing `package.json` and (typically) `glubean.setup.ts` — NOT
  // just the directory of the contract file. A file under `tests/` or
  // `contracts/` would otherwise miss the project's plugin bootstrap and
  // env loading. Caller can pass an explicit `rootDir` to override; if
  // omitted, walk up from the file looking for `package.json`.
  const rootDir = opts.rootDir ?? findProjectRoot(filePath);

  // Load project env (matches CLI / MCP behavior). `envFile: null`
  // skips the load; otherwise default basename is `.env`. Caller-supplied
  // `vars` / `secrets` merge on top (caller wins over file).
  let loadedVars: Record<string, string> = {};
  let loadedSecrets: Record<string, string> = {};
  if (opts.envFile !== null) {
    const envFileName = opts.envFile ?? ".env";
    try {
      const loaded = await loadProjectEnv(rootDir, envFileName);
      loadedVars = loaded.vars;
      loadedSecrets = loaded.secrets;
    } catch {
      // Match CLI behavior: missing env files are silently ignored.
      // A real load failure (parse error) bubbles up here unchanged so
      // the caller sees it instead of running with stale empty env.
      // loadProjectEnv itself doesn't throw on missing files.
    }
  }
  const effectiveVars = { ...loadedVars, ...(opts.vars ?? {}) };
  const effectiveSecrets = { ...loadedSecrets, ...(opts.secrets ?? {}) };

  // Capture & set env vars BEFORE constructing ProjectRunner — the
  // executor inherits parent env when spawning the harness subprocess.
  const savedExplicit = process.env["GLUBEAN_RUNNER_EXPLICIT_INPUT_MAP"];
  const savedBootstrap = process.env["GLUBEAN_RUNNER_BOOTSTRAP_INPUT_MAP"];
  const savedForce = process.env["GLUBEAN_RUNNER_FORCE_STANDALONE_IDS"];

  // §8 templating env — caller override, else built from
  // `{ ...vars, ...secrets, ...process.env }` matching CLI / MCP
  // precedence (process.env wins, secrets win over vars). Substitution
  // happens before env-var serialization, so the harness sees ready-to-
  // validate JSON.
  const templatingEnv: Record<string, string | undefined> =
    opts.templatingEnv ?? {
      ...effectiveVars,
      ...effectiveSecrets,
      ...process.env,
    };

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
    vars: effectiveVars,
    secrets: effectiveSecrets,
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
