/**
 * Upload run results and artifacts to Glubean Cloud (target model, ADR 0007).
 *
 * Upload flow:
 * 1. POST a `RunIngest` envelope to
 *    `{apiUrl}/v1/projects/{projectId}/targets/{targetId}/runs` → the created
 *    run row (`{ id, ... }`). The run id + a deep link are recorded on the
 *    receipt.
 * 2. If artifact files exist, POST them as inline multipart parts to
 *    `…/runs/{id}/artifacts` (one part = one artifact, ≤512KB each). Files over
 *    the inline cap are skipped (presigned R2 upload is an M6 follow-up).
 */

import { readdir, stat, readFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { CLI_VERSION } from "../version.js";
import { detectCiContext } from "./ci.js";

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  yellow: "\x1b[33m",
};

const RESULTS_TIMEOUT_MS = 5_000;
const ARTIFACT_TIMEOUT_MS = 30_000;
/** Per-file inline artifact cap — mirrors platform-api `MAX_INLINE_ARTIFACT_BYTES`.
 *  Files larger than this are skipped (presigned R2 path is an M6 follow-up). */
const INLINE_THRESHOLD = 512 * 1024; // 512KB
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 1_000;

async function fetchWithRetry(
  url: string,
  init: RequestInit & { timeoutMs?: number },
  retries = MAX_RETRIES,
): Promise<Response> {
  const { timeoutMs, ...fetchInit } = init;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const resp = await fetch(url, { ...fetchInit, signal: controller.signal });
      if (timeout) clearTimeout(timeout);
      if (resp.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      return resp;
    } catch (err) {
      if (timeout) clearTimeout(timeout);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
  throw new Error("fetchWithRetry exhausted");
}

// ─────────────────────────────────────────────────────────────────────────────
// RunIngest contract (target model). Local mirror of the cloud types — the CLI
// doesn't depend on @glubean/core. Keep in sync with:
//   packages/core/src/run/service.ts        (RunIngest / RunIngestTest / RunIngestMetric)
//   apps/platform-api/src/run/schemas.ts     (runIngestSchema / SUMMARY_SCHEMA / KNOWN_VERSIONS)
// ─────────────────────────────────────────────────────────────────────────────

export type RunKind = "test" | "load";
export type RunStatus = "passed" | "failed" | "errored" | "running" | "cancelled";
export type FailureClass = "timeout" | "crash" | "user_error" | "infra_error";

/** A per-test row → server `test_result` (single-test history / flaky substrate). */
export interface RunIngestTest {
  testId: string;
  name: string;
  /** passed | failed | skipped — skipped is excluded from flaky denominators. */
  status: string;
  durationMs: number;
  tags?: string[];
  eventCount?: number;
}

/** A time-series metric point → server `run_metric` (latency/rps/percentile trends). */
export interface RunIngestMetric {
  name: string;
  value: number;
  unit?: string;
  tags?: Record<string, string>;
  ts?: string; // ISO; defaults server-side to the run's startedAt
  testId?: string;
}

/**
 * Run-level envelope the CALLER assembles from the runner result. The wire body
 * (RunIngest) is built from this + CI/env context inside `uploadToCloud`, so the
 * caller doesn't repeat CI detection / version / environment plumbing.
 */
export interface UploadRunInput {
  kind: RunKind;
  /** Payload schema version: "glubean.test.v1" | "glubean.load.v1". */
  schemaVersion: string;
  status: RunStatus;
  /** ISO. */
  startedAt: string;
  /** ISO. */
  completedAt?: string;
  durationMs: number;
  /** Small kind-specific aggregate for list views (validated per-kind server-side). */
  summary: Record<string, unknown>;
  /**
   * The full ExecutionResult / LoadArtifact — stored as a blob, not in the row.
   * MUST be a JSON object and ALREADY redacted (the server does a baseline pass,
   * D6, but the CLI redacts first as the canonical client-side scrub).
   */
  result: unknown;
  testResults?: RunIngestTest[];
  metrics?: RunIngestMetric[];
  failureClass?: FailureClass;
  failureMessage?: string;
  /**
   * Stable idempotency id for this run (P1). Generated ONCE per CLI invocation
   * and reused across the in-process upload retry, so a lost-response retry
   * REPLACES the run server-side instead of creating a duplicate. A fresh
   * `glubean run`/`load` is a new run (a new id).
   */
  clientRunId?: string;
}

/**
 * Legacy on-disk metadata payload shape, retained for the SEPARATE c/f contract
 * projection line (D7 / M6) — `redactMetadataForUpload` types against
 * `metadata` here. NOT part of the run-data ingest above: per D7 the run upload
 * carries run-data only and drops `contractsProjection`/`workflows`.
 */
export interface UploadResultPayload {
  target?: string;
  files?: string[];
  runAt: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    durationMs: number;
    stats?: unknown;
  };
  tests: Array<{
    testId: string;
    testName: string;
    success: boolean;
    durationMs: number;
    tags?: string[];
    events?: unknown[];
  }>;
  customMetadata?: Record<string, string>;
  metadata?: {
    schemaVersion: string;
    generatedBy: string;
    generatedAt: string;
    /**
     * Bundle-integrity hash over files + flat contracts + workflows. Declared
     * here because the upload path recomputes it after redacting `workflows`
     * (which participate in the hash) so the uploaded payload stays
     * self-consistent — see lib/redact-metadata.ts.
     */
    rootHash?: string;
    testCount: number;
    fileCount: number;
    tags: string[];
    files: Record<string, {
      hash: string;
      exports: Array<{
        type: string;
        id: string;
        name?: string;
        tags?: string[];
        exportName: string;
        skip?: boolean;
      }>;
    }>;
    /** Contract spec metadata (from .contract.ts files) — flat/legacy view. */
    contracts?: Array<{
      contractId: string;
      exportName: string;
      endpoint: string;
      protocol: string;
      cases: Array<{
        key: string;
        expectStatus?: number;
        deferred?: string;
      }>;
    }>;
    /**
     * Lossless FULL contract projection (schemas / needsSchema / runnability /
     * verifyRules) and workflow projection — the source of truth for the Cloud
     * contract/workflow metadata snapshot (c/f shape-identity, Phase 2). Kept
     * as opaque arrays here: the server treats them structurally, and the CLI
     * deep-redacts them before upload (see commands/run.ts) since they can
     * carry secrets in examples / default headers / extensions / literals.
     * Like `runPlan`, nested under `metadata` to clear the server DTO's
     * `forbidNonWhitelisted` top-level whitelist.
     */
    contractsProjection?: unknown[];
    workflows?: unknown[];
    /**
     * Phase 5 5a — run plan provenance. Cloud server projects this to
     * top-level RunEntity.{profile, suites} for index-backed queries.
     * Nested under `metadata` to clear the server DTO's
     * `forbidNonWhitelisted` top-level whitelist.
     */
    runPlan?: {
      profile?: string;
      suites?: string[];
    };
  };
}

export interface UploadOptions {
  apiUrl: string;
  token: string;
  projectId: string;
  /** The target (API/system under test) runs belong to — resolved upstream
   *  (explicit `upload.targetId` / `GLUBEAN_TARGET_ID`, else the project's
   *  default target). Required: the ingest path is `…/targets/{targetId}/runs`. */
  targetId: string;
  envFile?: string;
  rootDir: string;
  /** Skip the `.glubean/artifacts` + `.glubean/screenshots` scan/upload. Load
   *  runs set this — those dirs hold TEST artifacts (the LoadArtifact is already
   *  the `result` blob), so attaching them would misattribute stale files. */
  skipArtifacts?: boolean;
}

export interface UploadReceipt {
  schemaVersion: "glubean.upload-receipt.v1";
  uploadedAt: string;
  apiUrl: string;
  projectId: string;
  targetId: string;
  runId?: string;
  url?: string;
  resultUpload: {
    status: "uploaded" | "failed";
    runId?: string;
    url?: string;
    statusCode?: number;
    error?: string;
  };
  artifactUpload: {
    status: "skipped" | "uploaded" | "failed";
    attempted: boolean;
    count: number;
    /** Files skipped because they exceed the inline cap (presigned = M6). */
    skipped?: number;
    sizeBytes?: number;
    statusCode?: number;
    error?: string;
  };
}

interface ArtifactUploadOutcome {
  ok: boolean;
  statusCode?: number;
  error?: string;
}

function createUploadReceipt(options: UploadOptions): UploadReceipt {
  return {
    schemaVersion: "glubean.upload-receipt.v1",
    uploadedAt: new Date().toISOString(),
    apiUrl: options.apiUrl,
    projectId: options.projectId,
    targetId: options.targetId,
    resultUpload: { status: "failed" },
    artifactUpload: { status: "skipped", attempted: false, count: 0 },
  };
}

/**
 * Canonical location of an uploaded run — its platform API resource URL
 * (`…/v1/projects/{projectId}/targets/{targetId}/runs/{runId}`). The dashboard
 * run-detail page doesn't exist yet (M2), and app-next has no URL-addressable
 * project context (TargetPage resolves the target under the SESSION's active
 * project, not the URL), so a guessed `app.<host>` link can't reliably resolve
 * cross-project. The API resource URL is real, addressable (with the token),
 * and carries full project+target+run context — the honest "where is my run".
 */
function buildRunUrl(
  apiUrl: string,
  projectId: string,
  targetId: string,
  runId: string,
): string {
  const base = apiUrl.replace(/\/+$/, "");
  return `${base}/v1/projects/${projectId}/targets/${targetId}/runs/${runId}`;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function envLabelFromEnvFile(envFile?: string): string {
  const fileName = basename(envFile || ".env");

  if (fileName === ".env") return "default";
  if (fileName.startsWith(".env.")) {
    return fileName.slice(".env.".length) || "default";
  }

  const ext = extname(fileName);
  const stem = ext ? basename(fileName, ext) : fileName;
  return stem || "default";
}

function resolveUploadEnvironment(envFile?: string): string {
  const explicit = process.env.GLUBEAN_ENV?.trim();
  return explicit || envLabelFromEnvFile(envFile);
}

function extToMime(ext: string): string {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".html": "text/html",
    ".json": "application/json",
    ".jsonl": "application/x-ndjson",
    ".har": "application/json",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".log": "text/plain",
    ".xml": "application/xml",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}

/** Recursively walk a directory and collect file paths */
async function walkDir(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile()) {
        files.push(full);
      } else if (entry.isDirectory()) {
        files.push(...await walkDir(full));
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return files;
}

/**
 * Upload a run (test or load) + optionally its artifacts to Glubean Cloud under
 * a target (ADR 0007). The caller assembles the run-level `UploadRunInput` from
 * the runner result; this builds the `RunIngest` wire body from it + CI/env
 * context and POSTs to the target-scoped ingest endpoint.
 *
 * All operations are best-effort — failures print a warning but never throw.
 */
export async function uploadToCloud(
  input: UploadRunInput,
  options: UploadOptions,
): Promise<UploadReceipt> {
  const { apiUrl, token, projectId, targetId, rootDir } = options;
  const receipt = createUploadReceipt(options);

  const ci = detectCiContext();

  // ── Step 1: Ingest the run (RunIngest envelope) ──
  // Per D7 the run upload carries run-data ONLY — no contract/workflow
  // projection (that's the separate c/f line). `result` is the full
  // ExecutionResult / LoadArtifact blob (already redacted by the caller).
  const body: Record<string, unknown> = {
    kind: input.kind,
    schemaVersion: input.schemaVersion,
    status: input.status,
    startedAt: input.startedAt,
    ...(input.completedAt ? { completedAt: input.completedAt } : {}),
    durationMs: input.durationMs,
    summary: input.summary,
    // The server schema requires `result` to be a JSON object (z.record).
    result: input.result ?? {},
    ...(input.testResults && input.testResults.length ? { testResults: input.testResults } : {}),
    ...(input.metrics && input.metrics.length ? { metrics: input.metrics } : {}),
    ...(input.failureClass ? { failureClass: input.failureClass } : {}),
    ...(input.failureMessage ? { failureMessage: input.failureMessage } : {}),
    ...(input.clientRunId ? { clientRunId: input.clientRunId } : {}),
    // CI / provenance dimensions (filterable on the dashboard).
    trigger: ci.source,
    ...(ci.gitRef ? { gitRef: ci.gitRef } : {}),
    ...(ci.commitSha ? { commitSha: ci.commitSha } : {}),
    ...(ci.runUrl ? { ciRunUrl: ci.runUrl } : {}),
    runnerVersion: CLI_VERSION,
    environment: resolveUploadEnvironment(options.envFile),
  };

  const runsEndpoint = `${apiUrl}/v1/projects/${projectId}/targets/${targetId}/runs`;

  let runId: string;
  let runUrl: string;
  try {
    const resp = await fetchWithRetry(runsEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      timeoutMs: RESULTS_TIMEOUT_MS,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.log(
        `${colors.yellow}Upload failed (${resp.status}): ${errText}${colors.reset}`,
      );
      receipt.resultUpload = {
        status: "failed",
        statusCode: resp.status,
        error: errText,
      };
      return receipt;
    }

    // The ingest endpoint returns the created run row (`{ id, ... }`); it does
    // not return a URL, so build the dashboard deep link from the API host.
    const result = await resp.json() as { id?: unknown };
    runId = typeof result.id === "string" ? result.id : "";
    if (!runId) {
      const error = "Cloud upload response was missing the run id.";
      console.log(`${colors.yellow}Upload failed: ${error}${colors.reset}`);
      receipt.resultUpload = {
        status: "failed",
        statusCode: resp.status,
        error,
      };
      return receipt;
    }
    runUrl = buildRunUrl(apiUrl, projectId, targetId, runId);
    receipt.runId = runId;
    receipt.url = runUrl;
    receipt.resultUpload = {
      status: "uploaded",
      runId,
      url: runUrl,
      statusCode: resp.status,
    };
    console.log(
      `${colors.green}Run uploaded${colors.reset} ${colors.dim}(${runId}) → ${runUrl}${colors.reset}`,
    );
  } catch (err) {
    let error: string;
    if (err instanceof DOMException && err.name === "AbortError") {
      error = "Upload timed out";
      console.log(`${colors.yellow}Upload timed out${colors.reset}`);
    } else {
      error = toErrorMessage(err);
      console.log(
        `${colors.yellow}Upload failed: ${error}${colors.reset}`,
      );
    }
    receipt.resultUpload = { status: "failed", error };
    return receipt;
  }

  // ── Step 2: Upload artifacts (if any) ──
  // The target-scoped endpoint takes inline multipart parts — one part = one
  // artifact, ≤512KB each (the server derives artifactType/mimeType per file).
  // Files over the inline cap are skipped here (presigned R2 = M6 follow-up) so
  // the batch never trips the server's 413.

  // Load runs skip this entirely — `.glubean/artifacts`/`screenshots` are TEST
  // artifacts (the LoadArtifact is the `result` blob), so scanning them would
  // attach stale files from a prior test run to each load run.
  if (options.skipArtifacts) return receipt;

  const artifactRoot = join(rootDir, ".glubean");
  const artifactDirs = [
    join(artifactRoot, "artifacts"),
    join(artifactRoot, "screenshots"),
  ];

  const candidates: { path: string; relativeName: string }[] = [];
  for (const dir of artifactDirs) {
    const dirFiles = await walkDir(dir);
    for (const filePath of dirFiles) {
      candidates.push({
        path: filePath,
        relativeName: relative(artifactRoot, filePath),
      });
    }
  }

  if (candidates.length === 0) return receipt;

  try {
    const form = new FormData();
    let uploadedCount = 0;
    let skippedCount = 0;
    let totalSize = 0;
    for (const file of candidates) {
      const s = await stat(file.path);
      if (s.size > INLINE_THRESHOLD) {
        skippedCount += 1;
        console.log(
          `${colors.yellow}Skipping artifact ${file.relativeName} (${(s.size / 1024).toFixed(0)} KB > 512 KB inline cap)${colors.reset}`,
        );
        continue;
      }
      const bytes = await readFile(file.path);
      const mime = extToMime(extname(file.relativeName));
      // Pass the Buffer (a Uint8Array view) directly — NOT `bytes.buffer`: small
      // files from `readFile` can share a pooled ArrayBuffer at a non-zero
      // byteOffset, so the raw `.buffer` would send neighbouring memory.
      form.append(
        "files",
        new Blob([bytes], { type: mime }),
        file.relativeName,
      );
      uploadedCount += 1;
      totalSize += s.size;
    }

    if (uploadedCount === 0) {
      // Everything was over the inline cap — record the skip, nothing posted.
      receipt.artifactUpload = {
        status: "skipped",
        attempted: false,
        count: 0,
        skipped: skippedCount,
      };
      return receipt;
    }

    const outcome = await uploadArtifacts(apiUrl, token, projectId, targetId, runId, form);

    receipt.artifactUpload = {
      status: outcome.ok ? "uploaded" : "failed",
      attempted: true,
      count: uploadedCount,
      ...(skippedCount > 0 ? { skipped: skippedCount } : {}),
      sizeBytes: totalSize,
      ...(outcome.statusCode !== undefined ? { statusCode: outcome.statusCode } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    };
    if (!outcome.ok) return receipt;

    const sizeStr = totalSize > 1024 * 1024
      ? `${(totalSize / 1024 / 1024).toFixed(1)} MB`
      : `${(totalSize / 1024).toFixed(1)} KB`;
    const skipNote = skippedCount > 0 ? `, ${skippedCount} skipped` : "";
    console.log(
      `${colors.green}Artifacts uploaded${colors.reset} ${colors.dim}(${uploadedCount} files, ${sizeStr}${skipNote})${colors.reset}`,
    );
    return receipt;
  } catch (err) {
    let error: string;
    if (err instanceof DOMException && err.name === "AbortError") {
      error = "Artifact upload timed out";
      console.log(
        `${colors.yellow}Artifact upload timed out${colors.reset}`,
      );
    } else {
      error = toErrorMessage(err);
      console.log(
        `${colors.yellow}Artifact upload failed: ${error}${colors.reset}`,
      );
    }
    receipt.artifactUpload = {
      status: "failed",
      attempted: true,
      count: candidates.length,
      error,
    };
    return receipt;
  }
}

/** POST the prepared multipart form of artifact parts to the run's inline
 *  artifact endpoint. Each part becomes one artifact server-side. */
async function uploadArtifacts(
  apiUrl: string,
  token: string,
  projectId: string,
  targetId: string,
  runId: string,
  form: FormData,
): Promise<ArtifactUploadOutcome> {
  const resp = await fetchWithRetry(
    `${apiUrl}/v1/projects/${projectId}/targets/${targetId}/runs/${runId}/artifacts`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      timeoutMs: ARTIFACT_TIMEOUT_MS,
    },
  );

  if (!resp.ok) {
    const errText = await resp.text();
    console.log(
      `${colors.yellow}Artifact upload failed (${resp.status}): ${errText}${colors.reset}`,
    );
    return { ok: false, statusCode: resp.status, error: errText };
  }

  return { ok: true, statusCode: resp.status };
}
