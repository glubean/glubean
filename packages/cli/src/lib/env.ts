/**
 * Shared .env file loading for the Glubean CLI.
 */

import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { parse as parseDotenv } from "dotenv";

/**
 * Load a single .env file and return its key-value pairs.
 * Returns an empty object if the file doesn't exist or can't be read.
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
 * Load `.env` + `.env.secrets` from a project root directory.
 *
 * The secrets file path follows the env file name:
 *   `.env` → `.env.secrets`
 *   `.env.staging` → `.env.staging.secrets`
 *
 * Secrets overlay env vars (later values win).
 */
export async function loadProjectEnv(
  rootDir: string,
  envFileName = ".env",
): Promise<Record<string, string>> {
  const envPath = resolve(rootDir, envFileName);
  const secretsPath = resolve(rootDir, `${envFileName}.secrets`);

  const envVars = await loadEnvFile(envPath);
  const secrets = await loadEnvFile(secretsPath);
  const merged = { ...envVars, ...secrets };

  return expandVars(merged);
}

/**
 * Expand `${NAME}` references in env values.
 *
 * Lookup order:
 * 1. Already-resolved values from the same pass (supports forward references
 *    only if the referenced key appears earlier in the file).
 * 2. `process.env`
 * 3. Empty string if not found.
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
