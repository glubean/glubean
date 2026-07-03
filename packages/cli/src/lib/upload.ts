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

import { readdir, stat, lstat, readFile, realpath, unlink } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
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
  /** This run's exact screenshot file paths (absolute), extracted from the
   *  `browser:screenshot` event stream. When provided, the `.glubean/screenshots`
   *  portion uploads ONLY these files instead of walking the whole dir — the dir
   *  accumulates screenshots across runs, so a plain walk misattributes stale
   *  files from previous runs to this run (ART1). Each path is realpath-checked
   *  to be inside `.glubean/screenshots`; escapees are dropped. When omitted, the
   *  screenshots dir is walked as before (backward compatible). Does NOT affect
   *  the `.glubean/artifacts` scan, which always walks. */
  screenshotPaths?: string[];
}

/** A file the server confirmed receiving, with the stat identity it had when
 *  its bytes were read into the upload form. Cleanup (ART1-B) re-checks this
 *  identity immediately before unlinking so it never deletes a file that was
 *  recreated at the same path after the upload (different content the server
 *  never saw). */
export interface UploadedArtifactFile {
  /** Absolute (realpath'd for whitelist screenshots) path of the posted file. */
  path: string;
  size: number;
  mtimeMs: number;
  ino: number;
  dev: number;
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
    /** The files that actually entered the multipart form (absolute path +
     *  stat identity captured at upload time), set only when the server
     *  confirmed the batch (`status: "uploaded"`). Excludes over-cap skips.
     *  Mixed set: `.glubean/artifacts` walk entries AND whitelist screenshots
     *  — a caller cleaning up local screenshots must intersect with its own
     *  run's screenshot list (ART1-B), never delete this list wholesale. The
     *  identity lets cleanup verify the on-disk file is still the exact file
     *  the server received (a concurrent run may have recreated the path). */
    uploadedFiles?: UploadedArtifactFile[];
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
 * Strip trailing slashes from `apiUrl` before appending a `/v1/...` path —
 * an `--api-url` / `GLUBEAN_API_URL` with a trailing slash would otherwise
 * double-slash the request (`https://host//v1/...`), which Hono's exact
 * segment router 404s instead of matching `/v1/projects/...` (GLU-61 /
 * GLU-109). `resolveApiUrl` (auth.ts) already normalizes its return value,
 * so this is normally a no-op — kept here so every `/v1/...` builder in this
 * file stays self-consistent even if called with a raw, un-normalized URL.
 */
function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, "");
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
  const base = normalizeApiUrl(apiUrl);
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
 * Resolve this run's screenshot whitelist against the on-disk screenshots dir.
 *
 * The whitelist replaces walkDir's natural containment, so every path is
 * realpath'd and confirmed to live under the (realpath'd) screenshots root —
 * an escapee (e.g. an event-stream `path` of `../../.env`) is dropped, never
 * read. Returns the safe candidates plus counts of what was skipped:
 *  - `outOfBounds`: whitelist entries that don't resolve or escape the root.
 *  - `outOfList`: files physically present in the dir but NOT in this run's
 *    list (stale prior-run files, or a `saveArtifact` that emitted no `path`).
 */
async function collectRunScreenshots(
  screenshotsRoot: string,
  whitelist: string[],
): Promise<{
  candidates: { path: string; relativeName: string }[];
  outOfBounds: number;
  outOfList: number;
}> {
  let realRoot: string | undefined;
  try {
    realRoot = await realpath(screenshotsRoot);
  } catch {
    realRoot = undefined; // dir doesn't exist
  }

  const included = new Set<string>();
  const candidates: { path: string; relativeName: string }[] = [];
  let outOfBounds = 0;

  if (realRoot === undefined) {
    // The run listed screenshots but the dir is gone — nothing safe to upload.
    return { candidates, outOfBounds: whitelist.length, outOfList: 0 };
  }

  for (const p of whitelist) {
    let real: string;
    try {
      real = await realpath(p);
    } catch {
      outOfBounds += 1; // missing / unreadable
      continue;
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      outOfBounds += 1; // escapes the screenshots root — refuse it
      continue;
    }
    // Regular files only — matches the walkDir path this replaces. A dir/FIFO
    // slipping in would throw at readFile and fail the whole artifact batch.
    try {
      if (!(await stat(real)).isFile()) {
        outOfBounds += 1;
        continue;
      }
    } catch {
      outOfBounds += 1; // vanished between realpath and stat
      continue;
    }
    if (included.has(real)) continue; // dedupe repeats in the list
    included.add(real);
    candidates.push({
      path: real,
      relativeName: join("screenshots", relative(realRoot, real)),
    });
  }

  // Count files on disk that this run's list didn't cover (surfaced as a
  // warning by the caller so an upstream regression can't silently drop them).
  let outOfList = 0;
  for (const filePath of await walkDir(screenshotsRoot)) {
    let real: string;
    try {
      real = await realpath(filePath);
    } catch {
      continue;
    }
    if (!included.has(real)) outOfList += 1;
  }

  return { candidates, outOfBounds, outOfList };
}

/**
 * ART1-B — delete this run's screenshots locally once the Cloud confirmed it
 * received them. Deletes ONLY the intersection of:
 *   - `screenshotPaths`: this run's screenshot list (from the event stream), and
 *   - `uploadedFiles`: what `uploadToCloud` actually posted in a server-confirmed
 *     batch (`receipt.artifactUpload.uploadedFiles`).
 * plus the same realpath containment guard as the upload whitelist: a path is
 * only unlinked when it resolves strictly inside `.glubean/screenshots`. On top
 * of path membership, the file's stat identity (dev/ino/size/mtimeMs) must still
 * match what was uploaded — a concurrent run that recreated the same path put
 * bytes there the server never received, and those must survive. (The check is
 * re-done immediately before each unlink; POSIX offers no unlink-by-fd, so a
 * recreation landing in the sub-ms window between lstat and unlink is the one
 * residual race — codex r2 P3, accepted.) So a partial
 * upload (over-cap skip) keeps its file, a failed batch keeps everything, and
 * nothing outside the screenshots dir (e.g. `.glubean/artifacts`, or an escapee
 * event path) is ever touched. Idempotent: already-missing files are skipped
 * silently. Returns how many files were removed.
 */
export async function removeUploadedScreenshots(
  rootDir: string,
  screenshotPaths: string[],
  uploadedFiles: UploadedArtifactFile[],
): Promise<{ removed: number }> {
  let realRoot: string;
  try {
    realRoot = await realpath(join(rootDir, ".glubean", "screenshots"));
  } catch {
    return { removed: 0 }; // dir gone — nothing local to clean
  }

  // uploadedFiles screenshot entries are keyed by realpath (the whitelist
  // resolver emits realpaths), so realpath'd screenshotPaths compare directly.
  const uploaded = new Map(uploadedFiles.map((f) => [f.path, f]));
  const seen = new Set<string>();
  let removed = 0;

  for (const p of screenshotPaths) {
    let real: string;
    try {
      real = await realpath(p);
    } catch {
      continue; // already gone (idempotent) or never existed
    }
    if (seen.has(real)) continue; // dedupe repeats in the list
    seen.add(real);
    // Containment guard (strictly inside the root — never the root itself):
    // an event path that resolved elsewhere must not be deleted even if a
    // same-string entry was uploaded via the `.glubean/artifacts` walk.
    if (!real.startsWith(realRoot + sep)) continue;
    const identity = uploaded.get(real);
    if (!identity) continue; // not confirmed uploaded — keep it
    // Identity check immediately before unlink: the on-disk file must still be
    // the exact file whose bytes the server received. lstat (not stat) so a
    // symlink swapped in at this path can't borrow its target's identity.
    try {
      const s = await lstat(real);
      if (
        !s.isFile() ||
        s.dev !== identity.dev ||
        s.ino !== identity.ino ||
        s.size !== identity.size ||
        s.mtimeMs !== identity.mtimeMs
      ) {
        continue; // recreated/replaced since upload — the server never saw it
      }
      await unlink(real);
      removed += 1;
    } catch {
      // Vanished concurrently or not deletable — keeping a local file is
      // always safe; never fail the run over cleanup.
    }
  }

  return { removed };
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

  const runsEndpoint = `${normalizeApiUrl(apiUrl)}/v1/projects/${projectId}/targets/${targetId}/runs`;

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
  const screenshotsRoot = join(artifactRoot, "screenshots");

  const candidates: { path: string; relativeName: string }[] = [];

  // `.glubean/artifacts` — always walked (out of ART1 scope: it holds
  // per-run-named artifact files, not the shared screenshot pool).
  for (const filePath of await walkDir(join(artifactRoot, "artifacts"))) {
    candidates.push({
      path: filePath,
      relativeName: relative(artifactRoot, filePath),
    });
  }

  // `.glubean/screenshots` — the dir accumulates screenshots across runs, so
  // walking it uploads stale files from previous runs as this run's evidence
  // (ART1). When the caller passes this run's exact screenshot list, use it as
  // a whitelist (realpath-contained to the screenshots root) instead.
  if (options.screenshotPaths) {
    const { candidates: shots, outOfBounds, outOfList } =
      await collectRunScreenshots(screenshotsRoot, options.screenshotPaths);
    candidates.push(...shots);
    if (outOfBounds > 0 || outOfList > 0) {
      const parts: string[] = [];
      if (outOfList > 0) {
        parts.push(`${outOfList} on disk not in this run's screenshot list`);
      }
      if (outOfBounds > 0) {
        parts.push(`${outOfBounds} out of bounds / unresolved`);
      }
      // Surfaced (not silent) so a future `saveArtifact` that omits `path`
      // can't quietly drop this run's screenshots from the upload.
      console.log(
        `${colors.yellow}Skipped ${parts.join(", ")} screenshot file(s) — only this run's screenshots are uploaded.${colors.reset}`,
      );
    }
  } else {
    for (const filePath of await walkDir(screenshotsRoot)) {
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
    // Files that actually enter the form — NOT the over-cap skips — with their
    // upload-time stat identity. Reported on the receipt (uploadedFiles) only
    // once the server confirms the batch, so local cleanup (ART1-B) can never
    // delete a file the Cloud never received.
    const postedFiles: UploadedArtifactFile[] = [];
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
      postedFiles.push({
        path: file.path,
        size: s.size,
        mtimeMs: s.mtimeMs,
        ino: s.ino,
        dev: s.dev,
      });
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
      // Only a server-confirmed batch exposes what was posted — a failed POST
      // must never feed the local cleanup path.
      ...(outcome.ok ? { uploadedFiles: postedFiles } : {}),
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
    `${normalizeApiUrl(apiUrl)}/v1/projects/${projectId}/targets/${targetId}/runs/${runId}/artifacts`,
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
