/**
 * @module bootstrap
 *
 * Project-level plugin bootstrap. Any SDK consumer that depends on plugin
 * registration state (matchers, protocol adapters) must call `bootstrap()`
 * at the start of its process — before scanning, running tests, handling
 * MCP requests, or emitting metadata.
 *
 * The bootstrap contract is the single point where "which plugins does this
 * project use" gets resolved. It locates a `glubean.setup.(ts|js|mjs)` file
 * via walk-up from the given start directory and dynamically imports it.
 * That file is expected to call `installPlugin(...)` at module top level.
 *
 * Idempotent by design — calling `bootstrap()` multiple times (across
 * entry points, across sub-scans within one process) is safe and cheap.
 *
 * **TypeScript setup files**: Loading a `.ts` setup file requires the
 * calling process to have a TypeScript module resolver active (tsx,
 * ts-node, etc.). All first-party Glubean entry points (runner, scanner,
 * CLI, MCP server, VSCode extension) run under tsx already, so this is
 * transparent. Third-party embeds that cannot load `.ts` should ship a
 * `glubean.setup.js` or `glubean.setup.mjs` instead.
 *
 * @see {@link installPlugin} in `./install-plugin.js`
 */

import { dirname, isAbsolute, parse, relative, resolve } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Setup file names checked in priority order during walk-up. A directory
 * containing any of these files is the project root for plugin purposes.
 * The first hit in each directory wins.
 */
const SETUP_FILE_NAMES = [
  "glubean.setup.ts",
  "glubean.setup.js",
  "glubean.setup.mjs",
] as const;

/**
 * Per-file load state, keyed by the absolute setup-file path.
 *
 * - `ok` — the setup file's import resolved. Subsequent `bootstrap()` calls
 *   that would hit the same file are fast-path no-ops.
 * - `failed` — the setup file's import threw. Subsequent `bootstrap()` calls
 *   that would hit the same file re-throw the remembered error, consistent
 *   with `installPlugin`'s "setup failure is process-unrecoverable" contract.
 *
 * @internal
 */
type LoadState =
  | { status: "ok" }
  | { status: "failed"; error: Error };

const loadState = new Map<string, LoadState>();

/**
 * Return true iff `descendant` is the same as or nested inside `ancestor`.
 * Both inputs must be absolute, normalized paths.
 * @internal
 */
function isAncestorOrSame(ancestor: string, descendant: string): boolean {
  const rel = relative(ancestor, descendant);
  // Empty string → equal. Relative path that is not ".." prefixed and not
  // absolute → descendant is inside ancestor. Anything else → outside.
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Walk up from `startDir` searching for a Glubean setup file. Returns the
 * absolute path of the first match found, or `undefined` if no setup file
 * exists anywhere between `startDir` and the filesystem root (or `stopDir`).
 *
 * Setup files checked per directory, in priority order:
 * `glubean.setup.ts` → `glubean.setup.js` → `glubean.setup.mjs`.
 *
 * @param startDir Directory to begin searching from (absolute or relative to cwd).
 * @param stopDir  Optional upper bound for the walk (defaults to filesystem root).
 */
export function discoverSetupFile(
  startDir: string,
  stopDir?: string,
): string | undefined {
  const startAbs = resolve(startDir);
  let root: string;
  if (stopDir !== undefined) {
    const stopAbs = resolve(stopDir);
    // Reject a stopDir that is not an ancestor of (or equal to) startDir.
    // Silently walking past a non-ancestor stopDir could pick up an unrelated
    // setup file above it — reviewer-flagged bug. Fail loud instead.
    if (!isAncestorOrSame(stopAbs, startAbs)) {
      throw new Error(
        `discoverSetupFile: stopDir "${stopAbs}" is not an ancestor of startDir "${startAbs}". ` +
          "stopDir must be equal to or above startDir in the directory tree.",
      );
    }
    root = stopAbs;
  } else {
    root = parse(startAbs).root;
  }

  let dir = startAbs;
  while (true) {
    for (const name of SETUP_FILE_NAMES) {
      const candidate = resolve(dir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Locate and import the project's `glubean.setup` file, triggering the
 * `installPlugin(...)` calls inside it.
 *
 * This function is the **bootstrap contract** for SDK consumers: every
 * entry point that observes plugin-registered state (scanner for
 * `.contract.ts` extraction, runner for test execution, MCP server for
 * metadata, VSCode for scan) **must** await `bootstrap()` before doing
 * its own work. Failing to do so causes a silent split where scan-time
 * sees an empty adapter registry while runtime sees the full one.
 *
 * **Behavior:**
 * - No setup file found → no-op (projects without plugins are fine, silent).
 * - Setup file found and not yet imported this process → import it and
 *   await the returned promise (the setup file may call `await installPlugin(...)`).
 * - Setup file found and already imported successfully → no-op (idempotent).
 * - Setup file found but `import()` throws → the error is recorded **and**
 *   re-thrown. Every subsequent `bootstrap()` call that resolves to the same
 *   file re-throws the remembered error rather than silently succeeding.
 *   This is consistent with `installPlugin`'s "setup failure is
 *   process-unrecoverable" contract: later scanner / runner / MCP callers
 *   MUST see the failure, not a false success.
 *
 * @param startDir Starting directory for the walk-up search. Typically the
 *                 project root or the process cwd. Caller decides — the SDK
 *                 does not assume `process.cwd()`.
 * @param stopDir  Optional upper bound for the walk (defaults to filesystem root).
 *
 * @example
 * ```ts
 * // runner startup
 * import { bootstrap } from "@glubean/sdk";
 * await bootstrap(projectRoot);
 * // ... now safe to import test files / .contract.ts files
 * ```
 */
export async function bootstrap(
  startDir: string,
  stopDir?: string,
): Promise<void> {
  const setupFile = discoverSetupFile(startDir, stopDir);
  if (!setupFile) return;

  const state = loadState.get(setupFile);
  if (state?.status === "ok") {
    // Fast path: already loaded successfully.
    return;
  }
  if (state?.status === "failed") {
    // Previous attempt threw. Re-throw the remembered error so downstream
    // callers (scanner / runner / MCP) don't silently proceed with a
    // half-initialized plugin registry.
    throw state.error;
  }

  const url = pathToFileURL(setupFile).href;
  try {
    await import(url);
    loadState.set(setupFile, { status: "ok" });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    loadState.set(setupFile, { status: "failed", error });
    throw error;
  }
}

/**
 * Test-only: clear the "already bootstrapped" cache so a subsequent
 * `bootstrap()` call will re-import the setup file. Does **not** reset any
 * plugin state on the globals — combine with
 * `__resetInstalledPluginsForTesting()` if you need a full reset.
 *
 * @internal
 */
export function __resetBootstrapForTesting(): void {
  loadState.clear();
}
