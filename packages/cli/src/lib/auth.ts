/**
 * Shared credential resolution for Glubean Cloud auth.
 *
 * Priority order for token/projectId (and every OTHER field): CLI flag >
 * system env var > .env/.env.secrets file var > package.json glubean.cloud
 * config > ~/.glubean/credentials.json.
 *
 * apiUrl is the ONE exception (GLU-161, mirrors GLU-139's fix in
 * packages/mcp/src/cloud.ts): the VAR NAME ranks above the source, AND
 * GLUBEAN_API_URL is auto-derived rather than used as-is. The full chain is:
 *
 *   1. --api-url flag (internal escape hatch — hidden from --help, kept for
 *      self-hosted/non-standard setups; still parsed and functional)
 *   2. GLUBEAN_PLATFORM_API_URL (internal escape hatch env var, system env
 *      then .env file — never documented to users as the primary path)
 *   3. GLUBEAN_API_URL (system env, then .env file) — the ONE var users are
 *      expected to set. Its value is auto-derived to the Platform host (see
 *      `derivePlatformApiUrl` below), NOT used directly — using it directly
 *      is the original GLU-161 bug (it's the Dashboard/session host, a
 *      separate Cloud Run service with no `/v1/*` routes).
 *   4. package.json glubean.cloud.apiUrl — already documented/typed as the
 *      Platform URL directly, used as-is (no derivation).
 *   5. ~/.glubean/credentials.json `apiUrl` — same, already the Platform URL,
 *      used as-is.
 *   6. DEFAULT_API_URL (constants.ts) — itself the Platform host literal.
 *
 * Users only ever need to set GLUBEAN_API_URL (their Dashboard host, e.g.
 * `https://api.staging.glubean.com`); resolveApiUrl derives the Platform
 * ingest host from it automatically. --api-url / GLUBEAN_PLATFORM_API_URL
 * remain as internal, undocumented overrides for the rare case the
 * derivation can't apply (self-hosted / non-glubean.com deployments).
 */

import { dirname, join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { DEFAULT_API_URL, DEFAULT_AUTH_URL } from "./constants.js";

export interface Credentials {
  token: string;
  projectId?: string;
  /** Platform/upload API URL (`/v1/*` ingest). */
  apiUrl?: string;
  /** Auth-plane URL (server-hono) the token was minted against. */
  authUrl?: string;
}

export interface AuthOptions {
  token?: string;
  project?: string;
  /** The target (API/system under test) within the project to upload runs to. */
  target?: string;
  apiUrl?: string;
  /** Auth-plane URL (server-hono) for the `glubean login` device grant. */
  authUrl?: string;
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
 * Strip trailing slashes from a resolved `apiUrl` before appending a
 * `/v1/...` path segment. Every URL builder in this file — and the real
 * upload POST in `upload.ts` — string-concatenates `${apiUrl}/v1/...`. An
 * `--api-url` / `GLUBEAN_API_URL` value with a trailing slash (a common
 * copy-paste artifact, e.g. copied from a browser address bar) would
 * otherwise produce `https://host//v1/projects/...`. Hono's router matches
 * path segments exactly and does NOT collapse a leading empty segment from a
 * double slash, so that request 404s instead of matching `/v1/projects/:id`
 * (GLU-61 / GLU-109). Matches the normalization `upload.ts`'s `buildRunUrl`
 * and `sync.ts` already do — this makes every `/v1/*` URL builder in the
 * package consistent, so preflight and the real upload always agree.
 */
function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, "");
}

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
    const resp = await fetch(`${normalizeApiUrl(apiUrl)}/v1/projects/${projectId}/targets`, {
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
  return checkResource(`${normalizeApiUrl(apiUrl)}/v1/projects/${projectId}`, token);
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
  return checkResource(`${normalizeApiUrl(apiUrl)}/v1/projects/${projectId}/targets/${targetId}`, token);
}

/** Is `hostname` on the managed Glubean domain (`glubean.com` / `glubean.test`,
 *  the local-dev domain — see resolveAuthUrl's doc below)? Only hosts on this
 *  domain are eligible for `api.` → `platform.` derivation; a self-hosted /
 *  custom domain can't be safely guessed at (see `derivePlatformApiUrl`). URL
 *  normalizes `hostname` to lowercase, so this is already case-insensitive. */
function isGlubeanDomain(hostname: string): boolean {
  const labels = hostname.split(".");
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1];
  const domain = labels[labels.length - 2];
  return domain === "glubean" && (tld === "com" || tld === "test");
}

/**
 * Derive the Platform/ingest API URL from a `GLUBEAN_API_URL`-style host —
 * the REAL fix for GLU-161's 404: `api.<env>.glubean.com` (server-hono, the
 * Dashboard/session host users are expected to set) and
 * `platform.<env>.glubean.com` (the token-only `/v1/*` ingest API,
 * `glubean-platform-api-{env}` on Cloud Run) are TWO SEPARATE services with
 * no shared domain — reusing the Dashboard host directly for uploads 404s.
 * Verified live (2026-07): `platform.glubean.com` / `platform.<env>.glubean.com`
 * are real, working domain mappings.
 *
 * Returns the Platform base URL, or `null` when the value can't be safely
 * derived (the caller then falls back to an explicit override or fails loud):
 *  - Not a URL, or carries userinfo / a non-root path / a query / a fragment
 *    → `null`. The result is a BASE onto which callers concatenate `/v1/...`;
 *    a surviving path/query/`user:pass@` would build a malformed request URL
 *    (or leak credentials into diagnostics), so those shapes are rejected
 *    rather than silently mangled.
 *  - First label is exactly `api` on a glubean.com/.test host → swap it for
 *    `platform` (the derivation).
 *  - First label is already `platform` on a glubean.com/.test host → returned
 *    as-is (already the Platform host; no derivation needed).
 *  - Any OTHER host — a different `*.glubean.com` label (`www`, bare
 *    `glubean.com`, …) OR a non-glubean.com/.test host (self-hosted / custom
 *    domain) → `null`: there's no way to know it serves `/v1/*`. The caller
 *    must set an explicit override (`GLUBEAN_PLATFORM_API_URL` / `--api-url`)
 *    and gets a clear config error if it doesn't.
 */
function derivePlatformApiUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  // Must be an HTTP(S) origin. `new URL()` happily parses `ftp://`, `ws://`,
  // or a typo'd `htps://` — deriving those would silently swap the host and
  // hand callers an unreachable base (they'd then fail as "cannot reach
  // server" instead of getting the clear config hint). Reject up front.
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // Reject anything that isn't a bare origin — a Platform BASE must have no
  // userinfo / real path / query / fragment, else `${base}/v1/...` is
  // malformed. A pathname that is semantically root (`/`, `///`, or an input
  // like `/foo/..` that WHATWG normalizes down to `/`) is fine — a
  // copy-pasted trailing slash is the GLU-109/GLU-61 case (normalizeApiUrl
  // strips it); a pathname that still has a non-slash segment after
  // normalization is a real path and IS rejected.
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname && !/^\/+$/.test(url.pathname)) return null;
  if (!isGlubeanDomain(url.hostname)) return null;
  const labels = url.hostname.split(".");
  const first = labels[0];
  if (first === "platform") return normalizeApiUrl(url.toString());
  if (first !== "api") return null;
  labels[0] = "platform";
  url.hostname = labels.join(".");
  return normalizeApiUrl(url.toString());
}

/**
 * Shared remediation hint printed by every command (`run` / `ci run` / `load`
 * / `sync` / `login`) when `resolveApiUrl` returns `null` — i.e. GLUBEAN_API_URL
 * is set but can't be auto-derived to a Platform host and no explicit override
 * is present. Kept here (one string, five call sites) so the guidance can't
 * drift between commands. Callers wrap it in their own dim/reset styling.
 */
export const PLATFORM_API_URL_UNRESOLVED_HINT =
  "GLUBEAN_API_URL doesn't look like a standard Glubean host (expected something like https://api.<env>.glubean.com) — it can't be auto-derived to the Platform ingest host. Set GLUBEAN_PLATFORM_API_URL directly to your Platform ingest URL.";

/**
 * Resolve the platform/upload API URL. The RETURNED value is already
 * trailing-slash-normalized (see `normalizeApiUrl`) so every caller — the
 * preflight checks above, `upload.ts`'s real POST, `sync.ts`, `load.ts` —
 * builds its `/v1/...` request URL from the same clean base, whether or not
 * that caller remembers to normalize again itself.
 *
 * Returns `null` when GLUBEAN_API_URL is set but isn't a standard glubean.com
 * / glubean.test host (so it can't be auto-derived) AND no explicit override
 * (`--api-url` / `GLUBEAN_PLATFORM_API_URL`) is set — the caller must surface
 * a clear config error rather than silently guessing (that silent guess was
 * the ORIGINAL GLU-161 bug).
 *
 * GLU-161 (mirrors GLU-139's fix for the MCP server, `packages/mcp/src/cloud.ts`):
 * `GLUBEAN_PLATFORM_API_URL` is checked BEFORE `GLUBEAN_API_URL`, in BOTH
 * process env and .env-file vars, before either source falls through to
 * `cloudConfig`/the credentials file. `GLUBEAN_API_URL` — the ONE var users
 * are expected to set (their Dashboard host) — is then auto-derived to the
 * Platform host via `derivePlatformApiUrl` (the real fix: this file no longer
 * uses it directly as the Platform URL, which is what silently 404s).
 * `GLUBEAN_PLATFORM_API_URL` / `--api-url` remain as internal, undocumented
 * overrides for setups the derivation can't cover.
 */
export async function resolveApiUrl(
  options: AuthOptions,
  sources?: ProjectAuthSources,
): Promise<string | null> {
  if (options.apiUrl) return normalizeApiUrl(options.apiUrl);
  const fromEnv = (name: string): string | undefined =>
    process.env[name] || sources?.envFileVars?.[name] || undefined;
  const platform = fromEnv("GLUBEAN_PLATFORM_API_URL");
  if (platform) return normalizeApiUrl(platform);
  const legacy = fromEnv("GLUBEAN_API_URL");
  if (legacy) return derivePlatformApiUrl(legacy);
  if (sources?.cloudConfig?.apiUrl) return normalizeApiUrl(sources.cloudConfig.apiUrl);
  const creds = await readCredentials();
  return normalizeApiUrl(creds?.apiUrl ?? DEFAULT_API_URL);
}

/**
 * Resolve the AUTH-plane URL (server-hono: `glubean login` device grant) — a
 * SEPARATE service from the platform/upload API. Order: `--auth-url` >
 * `GLUBEAN_AUTH_URL` (env / .env) > saved credentials > `DEFAULT_AUTH_URL`.
 * Locally set `GLUBEAN_AUTH_URL=https://api.glubean.test`.
 */
export async function resolveAuthUrl(
  options: AuthOptions,
  sources?: ProjectAuthSources,
): Promise<string> {
  if (options.authUrl) return options.authUrl;
  const env = process.env.GLUBEAN_AUTH_URL;
  if (env) return env;
  const fileVar = sources?.envFileVars?.["GLUBEAN_AUTH_URL"];
  if (fileVar) return fileVar;
  const creds = await readCredentials();
  return creds?.authUrl ?? DEFAULT_AUTH_URL;
}
