/**
 * Shared credential resolution for Glubean Cloud auth.
 *
 * Priority order:
 *   1. CLI flag (--token / --project / --api-url)
 *   2. System environment variable (GLUBEAN_TOKEN / GLUBEAN_PROJECT_ID / GLUBEAN_API_URL)
 *   3. .env + .env.secrets file vars (project-level)
 *   4. package.json glubean.cloud config (projectId, apiUrl, token)
 *   5. ~/.glubean/credentials.json (global fallback)
 */

import { dirname, join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { DEFAULT_API_URL } from "./constants.js";

export interface Credentials {
  token: string;
  projectId?: string;
  apiUrl?: string;
}

export interface AuthOptions {
  token?: string;
  project?: string;
  apiUrl?: string;
}

/**
 * Additional auth sources from the project context.
 */
export interface ProjectAuthSources {
  /** Merged vars from .env + .env.secrets */
  envFileVars?: Record<string, string>;
  /** Cloud section from package.json glubean config */
  cloudConfig?: { apiUrl?: string; projectId?: string; token?: string };
}

function getCredentialsPath(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  return join(home, ".glubean", "credentials.json");
}

export async function readCredentials(): Promise<Credentials | null> {
  const path = getCredentialsPath();
  if (!path) return null;
  try {
    const text = await readFile(path, "utf-8");
    return JSON.parse(text) as Credentials;
  } catch {
    return null;
  }
}

export async function writeCredentials(creds: Credentials): Promise<string> {
  const path = getCredentialsPath();
  if (!path) throw new Error("Cannot determine home directory");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(creds, null, 2) + "\n", "utf-8");
  return path;
}

export async function resolveToken(
  options: AuthOptions,
  sources?: ProjectAuthSources,
  tokenEnv?: string,
): Promise<string | null> {
  if (options.token) return options.token;
  // A profile that declares `upload.tokenEnv` authenticates EXCLUSIVELY
  // from that env var (after an explicit --token). No silent fallback to
  // GLUBEAN_TOKEN — otherwise a misconfigured profile could upload to its
  // project with the *default* token. Unresolved → null → loud preflight.
  // `||` (not `??`) so an empty process var is treated as absent and the
  // real value from .env.secrets still wins, matching the GLUBEAN_TOKEN path.
  if (tokenEnv) {
    return process.env[tokenEnv] || sources?.envFileVars?.[tokenEnv] || null;
  }
  const env = process.env.GLUBEAN_TOKEN;
  if (env) return env;
  const fileVar = sources?.envFileVars?.["GLUBEAN_TOKEN"];
  if (fileVar) return fileVar;
  if (sources?.cloudConfig?.token) return sources.cloudConfig.token;
  const creds = await readCredentials();
  return creds?.token ?? null;
}

export async function resolveProjectId(
  options: AuthOptions,
  sources?: ProjectAuthSources,
): Promise<string | null> {
  if (options.project) return options.project;
  const env = process.env.GLUBEAN_PROJECT_ID;
  if (env) return env;
  const fileVar = sources?.envFileVars?.["GLUBEAN_PROJECT_ID"];
  if (fileVar) return fileVar;
  if (sources?.cloudConfig?.projectId) return sources.cloudConfig.projectId;
  const creds = await readCredentials();
  return creds?.projectId ?? null;
}

export async function resolveApiUrl(
  options: AuthOptions,
  sources?: ProjectAuthSources,
): Promise<string> {
  if (options.apiUrl) return options.apiUrl;
  const env = process.env.GLUBEAN_API_URL;
  if (env) return env;
  const fileVar = sources?.envFileVars?.["GLUBEAN_API_URL"];
  if (fileVar) return fileVar;
  if (sources?.cloudConfig?.apiUrl) return sources.cloudConfig.apiUrl;
  const creds = await readCredentials();
  return creds?.apiUrl ?? DEFAULT_API_URL;
}
