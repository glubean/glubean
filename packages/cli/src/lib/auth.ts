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
  /** The target (API/system under test) within the project to upload runs to. */
  target?: string;
  apiUrl?: string;
}

/**
 * Additional auth sources from the project context.
 */
export interface ProjectAuthSources {
  /** Merged vars from .env + .env.secrets */
  envFileVars?: Record<string, string>;
  /** Cloud section from package.json glubean config */
  cloudConfig?: { apiUrl?: string; projectId?: string; targetId?: string; token?: string };
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

/**
 * Resolve the upload TARGET (the API/system under test the runs belong to).
 * Same precedence as the project: --target > GLUBEAN_TARGET_ID > .env > yaml.
 * Null means "unset" — the server falls back to the project's default target.
 */
export async function resolveTargetId(
  options: AuthOptions,
  sources?: ProjectAuthSources,
): Promise<string | null> {
  if (options.target) return options.target;
  const env = process.env.GLUBEAN_TARGET_ID;
  if (env) return env;
  const fileVar = sources?.envFileVars?.["GLUBEAN_TARGET_ID"];
  if (fileVar) return fileVar;
  if (sources?.cloudConfig?.targetId) return sources.cloudConfig.targetId;
  return null;
}

/** A DEFAULT project's id is `proj_default_<orgId>`; its auto-provisioned
 *  default target is `tgt_default_<orgId>` — a migration-stable id scheme
 *  (`projectStore.ensureDefault`, cloud migrations 0010/0012). */
const DEFAULT_PROJECT_PREFIX = "proj_default_";

/**
 * Resolve the project's DEFAULT target id when no explicit target is configured.
 * The ingest path is `…/targets/{targetId}/runs`, so the CLI must carry a
 * concrete id (there is no null-target ingest, plan D1).
 *
 * Fast path (no network, no scope): a **default project**'s default target id is
 * deterministic (`proj_default_<org>` ⇒ `tgt_default_<org>`), so least-privilege
 * upload tokens (`projects:read` + `runs:write`, no `targets:read`) still work.
 *
 * Fallback: for a non-default project, list its targets and pick the `"default"`
 * slug. This GET needs `targets:read`; a scoped token without it (or any
 * network / parse failure) yields null, and the caller tells the user to set
 * the target explicitly.
 */
export async function resolveDefaultTargetId(
  apiUrl: string,
  projectId: string,
  token: string,
): Promise<string | null> {
  if (projectId.startsWith(DEFAULT_PROJECT_PREFIX)) {
    return `tgt_default_${projectId.slice(DEFAULT_PROJECT_PREFIX.length)}`;
  }
  try {
    const resp = await fetch(`${apiUrl}/v1/projects/${projectId}/targets`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    const targets = (await resp.json()) as Array<{ id?: unknown; slug?: unknown }>;
    if (!Array.isArray(targets)) return null;
    const isId = (t: { id?: unknown; slug?: unknown }): t is { id: string; slug?: unknown } =>
      typeof t.id === "string";
    const ids = targets.filter(isId);
    const def = ids.find((t) => t.slug === "default");
    if (def) return def.id;
    // No "default" slug: only auto-pick when the project has exactly ONE target.
    // With several, the choice is ambiguous — return null so the caller asks for
    // an explicit target rather than silently attaching history to the wrong one.
    return ids.length === 1 ? ids[0].id : null;
  } catch {
    return null;
  }
}

/** Outcome of a pre-upload auth/project check (`checkUploadAuth`). */
export interface UploadAuthResult {
  /** Safe to proceed with the run: the project verified (200) OR the token is a
   *  least-privilege ingest token (403 — can POST runs but not read the project). */
  proceed: boolean;
  /** HTTP status (0 = the server was unreachable). */
  status: number;
  /** Project name, when verified (200). */
  projectName?: string;
  /** Proceeding WITHOUT verification — 403, insufficient read scope. */
  unverified?: boolean;
}

/**
 * Shared pre-upload GET of a platform resource (`projects:read` / `targets:read`)
 * on the SAME API runs upload to, so a bad token / mistyped id / wrong API URL is
 * caught BEFORE running tests or generating load traffic.
 *
 * 200 with a `{ id }` body → verified (proceed). A 2xx WITHOUT an `{ id }` (e.g.
 * `--api-url` points at a proxy returning HTML) → NOT proceed. 403
 * `insufficient_scope` → a least-privilege ingest token (runs:write, no read
 * scope) which can still POST runs — proceed unverified. Every other failure —
 * 401 (invalid/expired/wrong-kind token), a NON-scope 403 (e.g. `no_membership`:
 * can't write runs either), 404 (missing resource / wrong API URL), 5xx, or an
 * unreachable server (status 0) — does NOT proceed; the caller fails fast.
 */
async function checkResource(url: string, token: string): Promise<UploadAuthResult> {
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (resp.ok) {
      const body = (await resp.json().catch(() => null)) as { id?: unknown; name?: unknown } | null;
      if (!body || typeof body.id !== "string") {
        return { proceed: false, status: resp.status };
      }
      return {
        proceed: true,
        status: resp.status,
        projectName: typeof body.name === "string" ? body.name : undefined,
      };
    }
    if (resp.status === 403) {
      const b = (await resp.json().catch(() => ({}))) as { error?: unknown };
      if (b.error === "insufficient_scope") return { proceed: true, status: 403, unverified: true };
      return { proceed: false, status: 403 };
    }
    return { proceed: false, status: resp.status };
  } catch {
    return { proceed: false, status: 0 };
  }
}

/** Validate the configured project before an upload (see `checkResource`). */
export function checkUploadAuth(
  apiUrl: string,
  projectId: string,
  token: string,
): Promise<UploadAuthResult> {
  return checkResource(`${apiUrl}/v1/projects/${projectId}`, token);
}

/**
 * Validate that an EXPLICIT target id belongs to the project, BEFORE running, so
 * a mistyped `--upload-target` / `GLUBEAN_TARGET_ID` fails fast instead of after
 * the whole suite (then a 404 on the POST). The DEFAULT-target fallback skips
 * this — it's already deterministic (default project) or slug-validated (listed).
 */
export function checkTargetInProject(
  apiUrl: string,
  projectId: string,
  targetId: string,
  token: string,
): Promise<UploadAuthResult> {
  return checkResource(`${apiUrl}/v1/projects/${projectId}/targets/${targetId}`, token);
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
