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

import { dirname, parse, resolve } from "node:path";
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
 * Absolute paths of setup files we've already imported this process.
 * Second bootstrap() with the same resolved file is a fast-path no-op.
 * @internal
 */
const loaded = new Set<string>();

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
  let dir = resolve(startDir);
  const root = stopDir ? resolve(stopDir) : parse(dir).root;
  while (true) {
    for (const name of SETUP_FILE_NAMES) {
      const candidate = resolve(dir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir || dir === root) break;
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
 * - Setup file found and already imported → no-op (idempotent).
 * - Setup file found but `import()` throws → the error is re-thrown as-is;
 *   the file path is recorded so a retry in the same process won't try again.
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
  if (loaded.has(setupFile)) return;
  // Record before the import so a throwing setup file doesn't get retried in
  // the same process (plugin-install failure is process-unrecoverable by
  // design — see install-plugin.ts JSDoc).
  loaded.add(setupFile);
  const url = pathToFileURL(setupFile).href;
  await import(url);
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
  loaded.clear();
}
