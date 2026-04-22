/**
 * @module env
 *
 * Canonical project-env loader for all Glubean entry points (CLI `run`,
 * MCP tool handlers, VSCode extension, any future consumer).
 *
 * Historical background: CLI and MCP used to each have their own env loader
 * (CLI via `loadEnvFile` without expansion, MCP via a handwritten
 * `parseEnvContent`). Both dropped `${NAME}` expansion from the production
 * path despite `expandVars` being implemented in CLI's shared lib — a silent
 * regression from the original design. This module is the single place all
 * entry points load env files from now on, with full expansion semantics.
 *
 * This lives in `@glubean/runner` because it's tool-level runtime
 * infrastructure (same category as `bootstrap()`), not design-time SDK API.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";

/**
 * Load a single `.env`-style file and return its parsed key-value pairs.
 *
 * - File missing (ENOENT) → returns `{}` silently (consumers decide whether
 *   missing is an error)
 * - File unreadable (other IO error) → returns `{}` with a warning to stderr
 * - Content is parsed with the standard `dotenv` package (no expansion)
 *
 * This is the low-level primitive. Most callers want
 * {@link loadProjectEnv} instead.
 */
export async function loadEnvFile(
  envPath: string,
): Promise<Record<string, string>> {
  try {
    const content = await readFile(envPath, "utf-8");
    return parseDotenv(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    console.warn(`Warning: Could not read env file ${envPath}: ${(error as Error).message}`);
    return {};
  }
}

/**
 * Expand `${NAME}` references in env values.
 *
 * Lookup order per reference:
 *   1. Already-resolved values from this same expansion pass (supports
 *      forward references — keys defined earlier in insertion order).
 *   2. `process.env[NAME]` (host environment variables).
 *   3. Empty string fallback.
 *
 * Iteration is insertion order. This means:
 * - Within a single file, a later key can reference earlier keys.
 * - When called on a merged `{ ...vars, ...secrets }` object, secrets-only
 *   keys can reference any key from `vars` (because vars keys are inserted
 *   first). Vars keys referencing secrets-only keys **will not resolve**
 *   in a single pass — they'd need a multi-pass resolver.
 *
 * The multi-pass limitation is accepted — callers who need full
 * topological expansion should use the SDK's `{{NAME}}` template at
 * runtime via `resolveTemplate`, which resolves lazily in test execution
 * context and can pull from vars / secrets / session dynamically.
 */
export function expandVars(
  vars: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    result[key] = value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
      return result[name] ?? process.env[name] ?? "";
    });
  }
  return result;
}

/**
 * Result of loading a project's env + secrets, with `${NAME}` references
 * fully expanded.
 *
 * `vars` and `secrets` are kept as separate objects (never merged) so
 * downstream layers can apply redaction / masking to secrets without
 * affecting vars.
 *
 * On key collision between `.env` and `.env.secrets`, the secret wins and
 * the key appears **only** in `secrets`, not in `vars` (no duplication).
 */
export interface ProjectEnv {
  vars: Record<string, string>;
  secrets: Record<string, string>;
}

/**
 * Load a project's `.env` + `.env.secrets` with full `${NAME}` expansion.
 *
 * This is the canonical entry point for loading project env in any Glubean
 * tool. CLI, MCP, and future consumers should all go through this function.
 *
 * ### Behavior
 *
 * 1. Reads `<rootDir>/<envFileName>` (default `.env`) and
 *    `<rootDir>/<envFileName>.secrets` (`.env.secrets` by default). Missing
 *    files are silently treated as empty.
 * 2. Merges them temporarily (secrets override vars on key collision) and
 *    runs {@link expandVars} over the merged set so `${NAME}` references
 *    can cross between vars and secrets in either direction (subject to
 *    insertion-order single-pass limitation — see `expandVars` docs).
 * 3. Splits the expanded merged map back into `vars` and `secrets`,
 *    preserving the invariant: a key on collision appears only in
 *    `secrets`, never duplicated into `vars`.
 *
 * ### Naming convention
 *
 *   `.env` → `.env.secrets`
 *   `.env.staging` → `.env.staging.secrets`
 *   `.env.ci` → `.env.ci.secrets`
 *
 * The secrets path is always `<envFileName>.secrets` in the same directory.
 *
 * @example
 * ```ts
 * import { loadProjectEnv } from "@glubean/runner";
 *
 * const { vars, secrets } = await loadProjectEnv(projectRoot);
 * const { vars: stagingVars, secrets: stagingSecrets } =
 *   await loadProjectEnv(projectRoot, ".env.staging");
 * ```
 */
export async function loadProjectEnv(
  rootDir: string,
  envFileName = ".env",
): Promise<ProjectEnv> {
  const envPath = resolve(rootDir, envFileName);
  const secretsPath = resolve(rootDir, `${envFileName}.secrets`);

  const rawVars = await loadEnvFile(envPath);
  const rawSecrets = await loadEnvFile(secretsPath);

  // Merge for expansion so `${NAME}` can cross-reference both files.
  // `{ ...rawVars, ...rawSecrets }` keeps insertion order — vars keys first,
  // then secrets-only keys — so secrets can reference vars in a single pass.
  const merged = { ...rawVars, ...rawSecrets };
  const expanded = expandVars(merged);

  // Split back. Keys that exist in both files → secret wins, appears only
  // in `secrets` (not duplicated into `vars`).
  const vars: Record<string, string> = {};
  for (const key of Object.keys(rawVars)) {
    if (!(key in rawSecrets)) {
      vars[key] = expanded[key];
    }
  }
  const secrets: Record<string, string> = {};
  for (const key of Object.keys(rawSecrets)) {
    secrets[key] = expanded[key];
  }

  return { vars, secrets };
}
