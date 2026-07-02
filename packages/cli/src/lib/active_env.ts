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

/**
 * GLU-88: env names that must NEVER be picked up silently through the
 * `.glubean/active-env` fallback. `.glubean/active-env` is a persistent,
 * un-TTL'd, un-warned sticky file — a `glubean env use prod` run once (e.g.
 * to debug something) stays in effect for every future `glubean run` /
 * `sync` / `load` in that directory until someone remembers to `glubean env
 * reset`. For an ordinary named env (staging, dev, ci) that stickiness is
 * the whole point of the feature. For a *production* env it's a footgun:
 * a later, unrelated `--upload` silently ships data to prod with no
 * confirmation and (today) no way to delete it server-side. Matched
 * case-insensitively against the trimmed active-env name; deliberately an
 * exact-match denylist (not a substring/regex sweep) to avoid false
 * positives on names like "preprod-mirror".
 */
const SENSITIVE_ENV_NAMES = new Set(["prod", "production"]);

function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_NAMES.has(name.trim().toLowerCase());
}

/**
 * Thrown by `resolveEnvFileName` when the active env resolves to a
 * sensitive (prod-like) name. Callers MUST catch this and surface an
 * actionable error — never fall through to silently loading the file
 * anyway. Explicit `--env-file .env.prod` bypasses `resolveEnvFileName`
 * entirely (call sites branch on `userSpecifiedEnvFile` first), so this
 * only blocks the *implicit* path.
 */
export class SensitiveActiveEnvError extends Error {
  constructor(public readonly envName: string) {
    super(
      `Active environment is "${envName}" (set via \`glubean env use ${envName}\`, ` +
        `recorded in .glubean/active-env), which looks like a production ` +
        `environment. Refusing to load it implicitly — GLU-88 hardens exactly ` +
        `this case (a stale active-env silently routing an unrelated run to prod). ` +
        `Pass \`--env-file .env.${envName}\` to use it explicitly, or run ` +
        `\`glubean env reset\` to clear the active environment and fall back to .env.`,
    );
    this.name = "SensitiveActiveEnvError";
  }
}

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
 * 2. `.glubean/active-env` → `.env.<name>` — UNLESS `<name>` is a sensitive
 *    (prod-like) name, in which case this throws `SensitiveActiveEnvError`
 *    instead of silently returning it (GLU-88). Every caller must handle
 *    that error explicitly.
 * 3. Default `.env`
 */
export async function resolveEnvFileName(
  projectRoot: string,
): Promise<string> {
  const activeEnv = await readActiveEnv(projectRoot);
  if (activeEnv) {
    if (isSensitiveEnvName(activeEnv)) {
      throw new SensitiveActiveEnvError(activeEnv);
    }
    return `.env.${activeEnv}`;
  }
  return ".env";
}
