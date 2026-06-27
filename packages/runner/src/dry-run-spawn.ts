/**
 * Spawn-side of dry-run projection: launch the dry-run worker under tsx so it
 * can import the user's TypeScript test modules, collect the projected shapes.
 *
 * Mirrors the TestExecutor spawn (tsx CLI + zero-project `--import` hook). The
 * worker streams one sentinel line per file; a watchdog kills it if a body
 * hangs (the request budget only bounds synthetic-HTTP loops — a pure-compute
 * or non-HTTP data loop would otherwise block forever). Files that never report
 * before the watchdog fires are returned as timeout errors, so partial results
 * survive and `glubean dry-run` never hangs.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareZeroProject, resolveRunnerRoot, resolveTsxPath } from "./runner-resolve.js";
import { DRY_RUN_SENTINEL, type DryRunFileResult } from "./dry-run-worker.js";
import type { TestShape } from "./dry-run.js";

export interface DryRunFilesResult {
  shapes: Array<TestShape & { file: string }>;
  errors: Array<{ file: string; message: string }>;
}

/** Default watchdog: max wall-clock for the whole worker run across all files. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** Grace period between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface NodeRun {
  stdout: string;
  timedOut: boolean;
}

/** Run a node subprocess, killing it if it exceeds `timeoutMs`. */
function runNode(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<NodeRun> {
  return new Promise((resolveOut, reject) => {
    const child = spawn("node", args, { cwd, env, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    let timedOut = false;

    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const hard = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
      hard.unref?.();
    }, timeoutMs);
    watchdog.unref?.();

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(watchdog);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(watchdog);
      resolveOut({ stdout, timedOut });
    });
  });
}

/**
 * Project the shapes of every simple test exported from `files` by executing
 * each body against a synthetic context in a tsx subprocess.
 *
 * @param files Absolute paths to test files.
 * @param opts.cwd Working dir used to resolve the runner + zero-project mode
 *   (defaults to `process.cwd()`).
 * @param opts.timeoutMs Watchdog budget for the whole run (default 60s).
 */
export async function dryRunFiles(
  files: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<DryRunFilesResult> {
  if (files.length === 0) return { shapes: [], errors: [] };

  const cwd = opts.cwd ?? process.cwd();
  const envTimeout = Number(process.env.GLUBEAN_DRYRUN_TIMEOUT_MS);
  const timeoutMs =
    opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
  const bundledDistDir = __dirname;
  const bundledPkgRoot = resolve(__dirname, "..");
  const resolved = resolveRunnerRoot(cwd, bundledDistDir, bundledPkgRoot);
  let distDir = resolved.distDir;
  let pkgRoot = resolved.pkgRoot;
  let workerPath = resolve(distDir, "dry-run-worker.js");
  if (!existsSync(workerPath)) {
    // The resolved project runner predates dry-run support (has harness.js but
    // no dry-run-worker.js). Fall back to the bundled worker so dry-run still
    // works — mirrors the load-harness fallback. Upgrading the project's
    // @glubean/runner restores shared module identity.
    distDir = bundledDistDir;
    pkgRoot = bundledPkgRoot;
    workerPath = resolve(bundledDistDir, "dry-run-worker.js");
  }

  const zp = prepareZeroProject(cwd, distDir, pkgRoot);
  try {
    const args = [resolveTsxPath(), ...zp.tsxArgs, workerPath, ...files];
    const { stdout, timedOut } = await runNode(args, cwd, { ...process.env, ...zp.env }, timeoutMs);

    const shapes: DryRunFilesResult["shapes"] = [];
    const errors: DryRunFilesResult["errors"] = [];
    const reported = new Set<string>();
    let sawRecord = false;

    for (const raw of stdout.split("\n")) {
      if (!raw.startsWith(DRY_RUN_SENTINEL)) continue;
      let rec: DryRunFileResult;
      try {
        rec = JSON.parse(raw.slice(DRY_RUN_SENTINEL.length)) as DryRunFileResult;
      } catch {
        continue; // ignore a truncated line (e.g. killed mid-write)
      }
      sawRecord = true;
      if (rec.file) reported.add(rec.file);
      if (rec.shapes?.length) shapes.push(...rec.shapes);
      if (rec.error) errors.push({ file: rec.file, message: rec.error });
    }

    if (timedOut) {
      // Any file that never reported is the (or a) culprit of the hang.
      for (const f of files) {
        if (!reported.has(f)) {
          errors.push({
            file: f,
            message: `projection timed out after ${timeoutMs}ms (possible infinite loop or unintercepted async wait)`,
          });
        }
      }
      if (errors.length === 0) {
        errors.push({ file: "", message: `dry-run timed out after ${timeoutMs}ms` });
      }
    } else if (!sawRecord) {
      // No sentinel line at all → the worker truly produced nothing (e.g. it
      // crashed before its first emit). A file with only builder tests reports
      // an empty-shapes record, which is a valid (non-error) result.
      errors.push({ file: "", message: "dry-run worker produced no output" });
    }

    return { shapes, errors };
  } finally {
    zp.cleanup();
  }
}
