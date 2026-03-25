/**
 * Active environment state file.
 *
 * Reads/writes `.glubean/active-env` in the project root.
 * Used by both the CLI `run` command and the MCP server to resolve
 * which `.env.<name>` file to load when no explicit `--env-file` is given.
 */

import { resolve } from "node:path";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";

const ACTIVE_ENV_DIR = ".glubean";
const ACTIVE_ENV_FILE = "active-env";

function activeEnvPath(projectRoot: string): string {
  return resolve(projectRoot, ACTIVE_ENV_DIR, ACTIVE_ENV_FILE);
}

/**
 * Read the active environment name from `.glubean/active-env`.
 * Returns `undefined` if the file doesn't exist or is empty.
 */
export async function readActiveEnv(
  projectRoot: string,
): Promise<string | undefined> {
  try {
    const content = await readFile(activeEnvPath(projectRoot), "utf-8");
    const env = content.trim();
    return env || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write the active environment name to `.glubean/active-env`.
 */
export async function writeActiveEnv(
  projectRoot: string,
  envName: string,
): Promise<void> {
  const dir = resolve(projectRoot, ACTIVE_ENV_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(activeEnvPath(projectRoot), envName + "\n", "utf-8");
}

/**
 * Remove the active environment file (reset to default `.env`).
 */
export async function clearActiveEnv(projectRoot: string): Promise<void> {
  try {
    await unlink(activeEnvPath(projectRoot));
  } catch {
    // Already gone — that's fine
  }
}

/**
 * Resolve the env file name to use.
 *
 * Priority:
 * 1. Explicit `--env-file` flag (pass-through, not handled here)
 * 2. `.glubean/active-env` → `.env.<name>`
 * 3. Default `.env`
 */
export async function resolveEnvFileName(
  projectRoot: string,
): Promise<string> {
  const activeEnv = await readActiveEnv(projectRoot);
  if (activeEnv) {
    return `.env.${activeEnv}`;
  }
  return ".env";
}
