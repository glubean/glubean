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
import { basename, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { DEFAULT_GLOBAL_RULES, redactValue } from "@glubean/redaction";
import type { GlobalRules } from "@glubean/redaction";
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
 *
 * Two CLI sources are intentionally NOT mirrored (codex GLU-77 R1):
 * - package.json `glubean.cloud` config — dead in the CLI too: the config
 *   consolidation (docs/06 P2) stopped reading the legacy package.json
 *   `glubean` shape, so `glubeanConfig.cloud` is always the built-in default
 *   (undefined) on the upload path.
 * - per-profile `upload.tokenEnv` — profiles are a `glubean run` concept; the
 *   MCP server has no profile context to resolve one from.
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

/**
 * Scrub bearer-token-shaped strings from server error text before it reaches
 * the MCP client — a misconfigured apiUrl / proxy can echo request headers
 * (including `Authorization: Bearer glb_…`) back in the error body.
 */
function scrubTokens(text: string): string {
  return text
    .replace(/glb_[A-Za-z0-9_-]{6,}/g, "glb_[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [redacted]");
}

function friendlyHttpError(status: number, body: string): string {
  const detail = scrubTokens(body.slice(0, 2000));
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

/** Default request timeout — an MCP tool must not hang on a stalled network
 *  call (mirrors the spirit of the CLI's RESULTS_TIMEOUT_MS, slightly wider
 *  since ingest bodies can be larger than a status GET). */
const CLOUD_FETCH_TIMEOUT_MS = 15_000;

export async function cloudFetchJson(
  url: string,
  init: RequestInit & { token: string; timeoutMs?: number },
): Promise<unknown> {
  const { token, timeoutMs, ...fetchInit } = init;
  const budget = timeoutMs ?? CLOUD_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  let res: Response;
  try {
    res = await fetch(url, {
      ...fetchInit,
      signal: controller.signal,
      headers: {
        ...(fetchInit.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(
        `Request to Glubean Cloud timed out after ${budget}ms — check the apiUrl and your network.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(friendlyHttpError(res.status, text));
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── Upload environment label (mirror of packages/cli/src/lib/upload.ts) ─────

/**
 * Derive the run's environment label from the env file name the way the CLI
 * does: `.env` → "default", `.env.staging` → "staging", `custom.env` →
 * "custom". Keep in sync with the CLI's `envLabelFromEnvFile`.
 */
export function envLabelFromEnvFile(envFile?: string): string {
  const fileName = basename(envFile || ".env");
  if (fileName === ".env") return "default";
  if (fileName.startsWith(".env.")) {
    return fileName.slice(".env.".length) || "default";
  }
  const ext = extname(fileName);
  const stem = ext ? basename(fileName, ext) : fileName;
  return stem || "default";
}

// ── Project redaction config (glubean.yaml `defaults.redaction`) ────────────

export interface UploadRedaction {
  globalRules: GlobalRules;
  replacementFormat: "simple" | "labeled" | "partial";
}

/**
 * Load the project's upload redaction rules — the built-in baseline
 * (DEFAULT_GLOBAL_RULES + built-in sensitive keys, applied inside
 * `redactValue`) plus any custom `sensitiveKeys` / `customPatterns` /
 * `replacementFormat` from glubean.yaml `defaults.redaction`. Mirror of the
 * CLI's `resolveRedactionConfig` merge semantics (additive on the baseline);
 * without this, projects relying on custom rules would leak matching values
 * through MCP uploads that the CLI would have scrubbed (codex GLU-77 R1).
 * A missing or malformed glubean.yaml falls back to the baseline.
 */
export async function loadUploadRedaction(projectRoot: string): Promise<UploadRedaction> {
  const rules: GlobalRules = structuredClone(DEFAULT_GLOBAL_RULES);
  let replacementFormat: UploadRedaction["replacementFormat"] = "partial";
  try {
    const parsed = parseYaml(
      await readFile(resolve(projectRoot, "glubean.yaml"), "utf-8"),
    ) as {
      defaults?: {
        redaction?: {
          sensitiveKeys?: unknown;
          customPatterns?: unknown;
          replacementFormat?: unknown;
        };
      };
    } | null;
    const input = parsed?.defaults?.redaction;
    if (input) {
      if (Array.isArray(input.sensitiveKeys)) {
        for (const key of input.sensitiveKeys) {
          if (typeof key === "string" && !rules.sensitiveKeys.includes(key)) {
            rules.sensitiveKeys.push(key);
          }
        }
      }
      if (Array.isArray(input.customPatterns)) {
        for (const pattern of input.customPatterns) {
          const p = pattern as { name?: unknown; regex?: unknown } | null;
          if (p && typeof p.name === "string" && typeof p.regex === "string") {
            rules.customPatterns.push({ name: p.name, regex: p.regex });
          }
        }
      }
      if (
        input.replacementFormat === "simple" ||
        input.replacementFormat === "labeled" ||
        input.replacementFormat === "partial"
      ) {
        replacementFormat = input.replacementFormat;
      }
    }
  } catch {
    // Missing/unreadable glubean.yaml → baseline rules.
  }
  return { globalRules: rules, replacementFormat };
}

// ── RunIngest envelope from a local MCP run snapshot ─────────────────────────
//
// Local mirror of the wire contract — keep in sync with:
//   packages/cli/src/lib/upload.ts                       (RunIngest assembly)
//   cloud apps/platform-api/src/run/schemas.ts            (runIngestSchema)

/** Structural view of the fields `buildRunIngestBody` needs from the MCP's
 *  `LocalRunSnapshot` (index.ts) — kept structural to avoid an import cycle. */
export interface SnapshotForUpload {
  /** When the run FINISHED (the snapshot is taken after the run completes). */
  createdAt: string;
  /** When the run STARTED (recorded before execution). Optional for older
   *  snapshot shapes; without it, durations fall back to summed test times. */
  startedAt?: string;
  /** Stable per-snapshot idempotency id — re-uploading the SAME snapshot
   *  REPLACES the Cloud run (`(targetId, clientRunId)` dedupe) instead of
   *  duplicating it. Generated once when the snapshot is taken. */
  clientRunId?: string;
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
 * - Traces are intentionally NOT uploaded. Since GLU-104, the local trace
 *   view (`redactMcpTrace` in index.ts) already masks known-sensitive
 *   headers/body via `@glubean/redaction` — but it's a best-effort scan
 *   (sensitive-key + pattern matching), not a guarantee, and it still
 *   carries the FULL non-sensitive request/response body for AI debugging.
 *   Keeping that off the wire entirely (local-only) is a stronger boundary
 *   than trusting the redaction pass to catch every project-specific secret
 *   shape before it reaches Cloud.
 * - The blob is deep-redacted client-side before upload (assertion
 *   actual/expected and log data can carry live secrets). The server does a
 *   baseline pass too, but the client scrubs first — same policy as the CLI.
 */
export function buildRunIngestBody(
  snapshot: SnapshotForUpload,
  opts?: { environment?: string; redaction?: UploadRedaction },
): Record<string, unknown> {
  const summedMs = snapshot.results.reduce((acc, r) => acc + r.durationMs, 0);
  const { total, passed, failed, skipped } = snapshot.summary;
  // `createdAt` is the run's END (the snapshot is taken after the run). When
  // the snapshot carries a real start time, duration is wall-clock; otherwise
  // (older shape) fall back to summed per-test durations from the start.
  const startedAt = snapshot.startedAt ?? snapshot.createdAt;
  const durationMs = snapshot.startedAt
    ? Math.max(0, Date.parse(snapshot.createdAt) - Date.parse(snapshot.startedAt))
    : summedMs;
  const completedAt = snapshot.startedAt
    ? snapshot.createdAt
    : new Date(Date.parse(startedAt) + summedMs).toISOString();

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

  const redaction = opts?.redaction ?? {
    globalRules: DEFAULT_GLOBAL_RULES,
    replacementFormat: "partial" as const,
  };
  const redactedResult = redactValue(resultBlob, {
    globalRules: redaction.globalRules,
    replacementFormat: redaction.replacementFormat,
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
    // Stable idempotency id (P1) — re-uploading the same snapshot replaces
    // the run server-side instead of duplicating it. The snapshot carries the
    // id (generated once at snapshot time); randomUUID is only the fallback
    // for older snapshot shapes.
    clientRunId: snapshot.clientRunId ?? randomUUID(),
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
