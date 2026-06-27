/**
 * Spawn-side of dry-run projection: launch the dry-run worker under tsx so it
 * can import the user's TypeScript test modules, collect the projected shapes.
 *
 * Mirrors the TestExecutor spawn (tsx CLI + zero-project `--import` hook) but
 * without the streaming event protocol — dry-run is a one-shot: feed file
 * paths, read one JSON blob back.
 */

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareZeroProject, resolveRunnerRoot, resolveTsxPath } from "./runner-resolve.js";
import { DRY_RUN_SENTINEL } from "./dry-run-worker.js";
import type { TestShape } from "./dry-run.js";

export interface DryRunFilesResult {
  shapes: Array<TestShape & { file: string }>;
  errors: Array<{ file: string; message: string }>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Run a node subprocess to completion, returning its stdout. */
function runNode(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolveOut, reject) => {
    const child = spawn("node", args, { cwd, env, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", () => resolveOut(stdout));
  });
}

/**
 * Project the shapes of every simple test exported from `files` by executing
 * each body against a synthetic context in a tsx subprocess.
 *
 * @param files Absolute paths to test files.
 * @param opts.cwd Working dir used to resolve the runner + zero-project mode
 *   (defaults to `process.cwd()`).
 */
export async function dryRunFiles(
  files: string[],
  opts: { cwd?: string } = {},
): Promise<DryRunFilesResult> {
  if (files.length === 0) return { shapes: [], errors: [] };

  const cwd = opts.cwd ?? process.cwd();
  const bundledDistDir = __dirname;
  const bundledPkgRoot = resolve(__dirname, "..");
  const resolved = resolveRunnerRoot(cwd, bundledDistDir, bundledPkgRoot);
  const workerPath = resolve(resolved.distDir, "dry-run-worker.js");

  const zp = prepareZeroProject(cwd, resolved.distDir, resolved.pkgRoot);
  try {
    const args = [resolveTsxPath(), ...zp.tsxArgs, workerPath, ...files];
    const stdout = await runNode(args, cwd, { ...process.env, ...zp.env });

    const line = stdout
      .split("\n")
      .reverse()
      .find((l) => l.startsWith(DRY_RUN_SENTINEL));
    if (!line) {
      return {
        shapes: [],
        errors: [{ file: "", message: "dry-run worker produced no output" }],
      };
    }
    return JSON.parse(line.slice(DRY_RUN_SENTINEL.length)) as DryRunFilesResult;
  } finally {
    zp.cleanup();
  }
}
