/**
 * Glubean Cloud client for the MCP open* tools — `/v1/*` ingest contract
 * (GLU-77).
 *
 * The legacy Open Platform (`POST /open/v1/runs` — server-side bundle
 * execution) was retired with the old stack. The new platform API exposes an
 * INGEST model instead: tests execute locally, and the results are POSTed to
 * `POST {apiUrl}/v1/projects/{projectId}/targets/{targetId}/runs` with a
 * Bearer token — the same contract `glubean run --upload` uses.
 *
 * Credential resolution mirrors the CLI (packages/cli/src/lib/auth.ts) —
 * keep the precedence in sync:
 *   1. explicit tool argument
 *   2. process env (GLUBEAN_TOKEN / GLUBEAN_PROJECT_ID / GLUBEAN_TARGET_ID /
 *      GLUBEAN_API_URL)
 *   3. project `.env` + `.env.secrets` vars
 *   4. `~/.glubean/credentials.json` (written by `glubean login`)
 *
 * NOT a direct import of `@glubean/cli`: that package exposes only its bin
 * entry (`exports: { ".": dist/main.js }` — importing it executes the CLI
 * program), so the small resolution/upload surface is mirrored here.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_GLOBAL_RULES, redactValue } from "@glubean/redaction";
import { MCP_PACKAGE_VERSION } from "./version.js";

/** Mirror of packages/cli/src/lib/constants.ts `DEFAULT_API_URL` (the
 *  platform/ingest API, `/v1/*`). */
export const DEFAULT_API_URL = "https://api.glubean.com";

// ── Credential resolution (mirror of packages/cli/src/lib/auth.ts) ──────────

export interface CloudAuthArgs {
  apiUrl?: string;
  token?: string;
  projectId?: string;
  targetId?: string;
}

export interface CloudAuthSources {
  /** Merged vars from `.env` + `.env.secrets` (secrets win on collision). */
  envFileVars?: Record<string, string>;
}

export interface ResolvedCloudAuth {
  apiUrl: string;
  token?: string;
  projectId?: string;
  targetId?: string;
}

interface CredentialsFile {
  token?: string;
  projectId?: string;
  apiUrl?: string;
}

async function readCredentialsFile(): Promise<CredentialsFile | null> {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  try {
    const text = await readFile(join(home, ".glubean", "credentials.json"), "utf-8");
    return JSON.parse(text) as CredentialsFile;
  } catch {
    return null;
  }
}

/**
 * Resolve Cloud credentials with the CLI's precedence: explicit argument >
 * process env > .env/.env.secrets vars > ~/.glubean/credentials.json.
 * (`||` not `??` — an empty-string env var is treated as absent, matching
 * the CLI's resolveToken.)
 */
export async function resolveCloudAuth(
  args: CloudAuthArgs,
  sources?: CloudAuthSources,
): Promise<ResolvedCloudAuth> {
  const envFileVars = sources?.envFileVars ?? {};
  const fromEnv = (name: string): string | undefined =>
    process.env[name] || envFileVars[name] || undefined;

  // Only hit the credentials file when something is still unresolved.
  let credsCache: CredentialsFile | null | undefined;
  const creds = async (): Promise<CredentialsFile | null> => {
    if (credsCache === undefined) credsCache = await readCredentialsFile();
    return credsCache;
  };

  const token =
    args.token || fromEnv("GLUBEAN_TOKEN") || (await creds())?.token || undefined;
  const projectId =
    args.projectId ||
    fromEnv("GLUBEAN_PROJECT_ID") ||
    (await creds())?.projectId ||
    undefined;
  // The credentials file has no target — the target is per-project config.
  const targetId = args.targetId || fromEnv("GLUBEAN_TARGET_ID") || undefined;
  const apiUrl = (
    args.apiUrl ||
    fromEnv("GLUBEAN_API_URL") ||
    (await creds())?.apiUrl ||
    DEFAULT_API_URL
  ).replace(/\/+$/, "");

  return { apiUrl, token, projectId, targetId };
}

/** Human-actionable message for a missing credential piece. */
export const MISSING_AUTH_MESSAGES = {
  token:
    "No Glubean Cloud token configured. Pass `token`, set GLUBEAN_TOKEN " +
    "(process env or .env.secrets in the project root), or run `glubean login` " +
    "(writes ~/.glubean/credentials.json).",
  projectId:
    "No Glubean Cloud project configured. Pass `projectId`, set " +
    "GLUBEAN_PROJECT_ID (process env or .env in the project root), or run " +
    "`glubean login`.",
  targetId:
    "Could not resolve the target for this project. Pass `targetId` or set " +
    "GLUBEAN_TARGET_ID — the project has no unambiguous default target, or " +
    "the token lacks the targets:read scope needed to list targets.",
} as const;

/** A DEFAULT project's id is `proj_default_<orgId>`; its auto-provisioned
 *  default target is `tgt_default_<orgId>` (mirror of the CLI's
 *  resolveDefaultTargetId — migration-stable id scheme). */
const DEFAULT_PROJECT_PREFIX = "proj_default_";

/**
 * Resolve the project's DEFAULT target id when none is configured. Fast path
 * (no network): a default project's default target id is deterministic.
 * Fallback: list the project's targets and pick the `"default"` slug, or the
 * single target when there is exactly one. Null → the caller asks the user
 * for an explicit target.
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
    const resp = await fetch(
      `${apiUrl}/v1/projects/${encodeURIComponent(projectId)}/targets`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) return null;
    const targets = (await resp.json()) as Array<{ id?: unknown; slug?: unknown }>;
    if (!Array.isArray(targets)) return null;
    const ids = targets.filter(
      (t): t is { id: string; slug?: unknown } => typeof t?.id === "string",
    );
    const def = ids.find((t) => t.slug === "default");
    if (def) return def.id;
    return ids.length === 1 ? ids[0]!.id : null;
  } catch {
    return null;
  }
}

// ── /v1 endpoint URLs ────────────────────────────────────────────────────────

function runsBase(apiUrl: string, projectId: string, targetId: string): string {
  return (
    `${apiUrl.replace(/\/+$/, "")}/v1/projects/${encodeURIComponent(projectId)}` +
    `/targets/${encodeURIComponent(targetId)}/runs`
  );
}

export function runIngestUrl(apiUrl: string, projectId: string, targetId: string): string {
  return runsBase(apiUrl, projectId, targetId);
}

export function runUrl(
  apiUrl: string,
  projectId: string,
  targetId: string,
  runId: string,
): string {
  return `${runsBase(apiUrl, projectId, targetId)}/${encodeURIComponent(runId)}`;
}

export function runTestResultsUrl(
  apiUrl: string,
  projectId: string,
  targetId: string,
  runId: string,
): string {
  return `${runUrl(apiUrl, projectId, targetId, runId)}/test-results`;
}

export function runTestEventsUrl(
  apiUrl: string,
  projectId: string,
  targetId: string,
  runId: string,
  testId: string,
): string {
  return `${runUrl(apiUrl, projectId, targetId, runId)}/tests/${encodeURIComponent(testId)}/events`;
}

// ── Fetch with human-actionable error mapping ────────────────────────────────

function friendlyHttpError(status: number, body: string): string {
  const detail = body.slice(0, 2000);
  switch (status) {
    case 401:
      return (
        `Unauthorized (401): the Cloud rejected the token. Check GLUBEAN_TOKEN ` +
        `(is it expired or for a different environment?) or run \`glubean login\`. ${detail}`
      );
    case 403:
      return (
        `Forbidden (403): the token lacks the required scope (runs:read / ` +
        `runs:write) or its user lost project membership. ${detail}`
      );
    case 404:
      return (
        `Not found (404): check projectId / targetId / runId — or the apiUrl ` +
        `points at the wrong service (the ingest API is the platform API, ` +
        `default ${DEFAULT_API_URL}). ${detail}`
      );
    case 413:
      return `Payload too large (413): the run body exceeds the ingest cap. ${detail}`;
    case 429:
      return `Ingest quota exceeded (429): too many runs in the current window. ${detail}`;
    default:
      return `HTTP ${status}: ${detail}`;
  }
}

export async function cloudFetchJson(
  url: string,
  init: RequestInit & { token: string },
): Promise<unknown> {
  const { token, ...fetchInit } = init;
  const res = await fetch(url, {
    ...fetchInit,
    headers: {
      ...(fetchInit.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(friendlyHttpError(res.status, text));
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── RunIngest envelope from a local MCP run snapshot ─────────────────────────
//
// Local mirror of the wire contract — keep in sync with:
//   packages/cli/src/lib/upload.ts                       (RunIngest assembly)
//   cloud apps/platform-api/src/run/schemas.ts            (runIngestSchema)

/** Structural view of the fields `buildRunIngestBody` needs from the MCP's
 *  `LocalRunSnapshot` (index.ts) — kept structural to avoid an import cycle. */
export interface SnapshotForUpload {
  createdAt: string;
  fileUrl: string;
  projectRoot: string;
  summary: { total: number; passed: number; failed: number; skipped: number };
  results: Array<{
    exportName: string;
    id: string;
    name?: string;
    success: boolean;
    skipped?: boolean;
    durationMs: number;
    assertions: Array<{
      passed: boolean;
      message: string;
      actual?: unknown;
      expected?: unknown;
    }>;
    logs: Array<{ message: string; data?: unknown }>;
    error?: { message: string; stack?: string };
  }>;
  filter?: string;
}

/**
 * Build the `RunIngest` wire body (kind=test, schemaVersion=glubean.test.v1)
 * from a local run snapshot.
 *
 * - The `result` blob is shaped like the CLI's payload (`tests[].events`) so
 *   Cloud's per-test events drill-down (`extractTestEvents`) can read it.
 * - Traces are intentionally NOT uploaded: the MCP's local trace view keeps
 *   the `authorization` header for AI debugging (DEFAULT_MCP_TRACE_CONFIG) —
 *   that must never leave the machine.
 * - The blob is deep-redacted client-side before upload (assertion
 *   actual/expected and log data can carry live secrets). The server does a
 *   baseline pass too, but the client scrubs first — same policy as the CLI.
 */
export function buildRunIngestBody(
  snapshot: SnapshotForUpload,
  opts?: { environment?: string },
): Record<string, unknown> {
  const durationMs = snapshot.results.reduce((acc, r) => acc + r.durationMs, 0);
  const { total, passed, failed, skipped } = snapshot.summary;
  const startedAt = snapshot.createdAt;
  const completedAt = new Date(Date.parse(startedAt) + durationMs).toISOString();

  const tests = snapshot.results.map((r) => ({
    testId: r.id,
    testName: r.name ?? r.id,
    success: r.success,
    durationMs: r.durationMs,
    events: [
      ...r.assertions.map((a) => ({
        type: "assertion",
        passed: a.passed,
        message: a.message,
        ...(a.actual !== undefined ? { actual: a.actual } : {}),
        ...(a.expected !== undefined ? { expected: a.expected } : {}),
      })),
      ...r.logs.map((l) => ({
        type: "log",
        message: l.message,
        ...(l.data !== undefined ? { data: l.data } : {}),
      })),
      ...(r.error ? [{ type: "error", message: r.error.message }] : []),
      {
        type: "status",
        status: r.skipped ? "skipped" : r.success ? "completed" : "failed",
      },
    ],
  }));

  const resultBlob = {
    runAt: startedAt,
    summary: { total, passed, failed, skipped, durationMs },
    context: {
      source: "@glubean/mcp",
      mcpVersion: MCP_PACKAGE_VERSION,
      fileUrl: snapshot.fileUrl,
      ...(snapshot.filter ? { filter: snapshot.filter } : {}),
    },
    tests,
  };

  const redactedResult = redactValue(resultBlob, {
    globalRules: DEFAULT_GLOBAL_RULES,
    replacementFormat: "partial",
    maxDepth: 64,
  }) as Record<string, unknown>;

  // Per-test rows → server `test_result` (single-test history / flaky
  // substrate). Clean skip → "skipped" (excluded from flaky denominators).
  const testResults = snapshot.results.map((r) => ({
    testId: r.id,
    name: r.name ?? r.id,
    status: r.skipped ? "skipped" : r.success ? "passed" : "failed",
    durationMs: r.durationMs,
  }));

  return {
    kind: "test",
    schemaVersion: "glubean.test.v1",
    // Stable idempotency id (P1) — a retry of the SAME body replaces the run
    // server-side instead of duplicating it.
    clientRunId: randomUUID(),
    status: failed > 0 ? "failed" : "passed",
    startedAt,
    completedAt,
    durationMs,
    summary: { total, passed, failed, skipped, durationMs },
    result: redactedResult,
    ...(testResults.length > 0 ? { testResults } : {}),
    trigger: "mcp",
    runnerVersion: MCP_PACKAGE_VERSION,
    ...(opts?.environment ? { environment: opts.environment } : {}),
  };
}
