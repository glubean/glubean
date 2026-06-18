/**
 * Load-plan discovery — duck-types a `.load.ts` module's exports for
 * `loadRunner()` plans and reads their attached plain-data projection.
 *
 * Scanner stays duck-typing-only (no `@glubean/sdk` dependency): the SDK marks
 * each plan with `__glubean_type: "load-runner"` and attaches a plain
 * `projection`, so discovery just enumerates exports and reads it — handling
 * both single plans and arrays produced by `loadRunner.each()`.
 */
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildSuffixes } from "./kinds.js";

// `load` is intentionally NOT yet a registered suite kind (advertising it before
// the CLI run path is wired would make `kinds: [load]` validate but find nothing);
// the stem is derived directly here. M2-c adds it to the registry + wires the run path.
const LOAD_FILE_SUFFIXES = buildSuffixes(["load"]);

/** Whether a path is a load file (`.load.ts` / `.load.js` / `.load.mjs`). */
export function isLoadFile(filePath: string): boolean {
  return LOAD_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

/** One scenario reference inside a discovered load plan. */
export interface LoadScenarioRefMeta {
  scenarioRefId?: string;
  scenarioId: string;
  weight?: number;
  steps: string[];
}

/** Plain-data projection of a load plan (mirrors sdk `LoadProjection`). */
export interface LoadPlanProjection {
  runnerId: string;
  runMode: "load";
  concurrency: number;
  durationMs?: number;
  iterations?: number;
  rampUpMs?: number;
  scenarios: LoadScenarioRefMeta[];
  thresholdScopes: string[];
}

/** A discovered load plan plus which export produced it. */
export interface LoadPlanMeta extends LoadPlanProjection {
  exportName: string;
}

const LOAD_RUNNER_MARKER = "load-runner";

function readPlanProjection(value: unknown): LoadPlanProjection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { __glubean_type?: unknown; projection?: unknown };
  if (candidate.__glubean_type !== LOAD_RUNNER_MARKER) return undefined;
  const projection = candidate.projection;
  if (!projection || typeof projection !== "object") return undefined;
  return projection as LoadPlanProjection;
}

/**
 * Extract load plans from an imported module namespace by duck-typing exports.
 * Handles single plans and arrays (from `loadRunner.each()`).
 */
export function extractLoadPlans(namespace: Record<string, unknown>): LoadPlanMeta[] {
  const plans: LoadPlanMeta[] = [];
  for (const [exportName, value] of Object.entries(namespace)) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      const projection = readPlanProjection(candidate);
      if (projection) plans.push({ ...projection, exportName });
    }
  }
  return plans;
}

/** Result of importing + extracting a `.load.ts` file (fail-closed). */
export interface LoadExtractionResult {
  plans: LoadPlanMeta[];
  /** Present iff the runtime import threw; `plans` is empty in that case. */
  error?: string;
}

// Per-path record of the last import: its mtime and the exact URL used, so a
// long-running host (MCP server, editor integration) sees edits to a load file
// on re-import without ever regressing to a stale clean-URL cache entry.
const _lastImport = new Map<string, { mtime: number; url: string }>();

/**
 * Runtime-import a `.load.ts` file and extract its load plans. Fail-closed: an
 * import/throw is captured as `error` with no plans — this never throws, so a
 * single broken load file can't abort discovery of the rest.
 */
export async function extractLoadPlansFromFile(
  absolutePath: string,
): Promise<LoadExtractionResult> {
  try {
    let mtimeKey = 0;
    try {
      mtimeKey = statSync(absolutePath).mtimeMs;
    } catch {
      // stat failure: proceed without cache-bust.
    }
    const baseUrl = pathToFileURL(absolutePath).href;
    const prev = _lastImport.get(absolutePath);
    let importUrl: string;
    if (prev && prev.mtime === mtimeKey) {
      // Unchanged since last import: reuse the EXACT URL we used last time
      // (clean or already cache-busted), so we never fall back to the stale
      // clean-URL entry after a prior edit refreshed via `?t=`.
      importUrl = prev.url;
    } else {
      // First import: clean URL (keeps ESM-aware tools on their default path).
      // Changed since last import: a fresh `?t=<mtime>` URL forces re-import.
      importUrl = prev ? `${baseUrl}?t=${mtimeKey}` : baseUrl;
      _lastImport.set(absolutePath, { mtime: mtimeKey, url: importUrl });
    }
    const namespace = (await import(importUrl)) as Record<string, unknown>;
    return { plans: extractLoadPlans(namespace) };
  } catch (err) {
    return { plans: [], error: err instanceof Error ? err.message : String(err) };
  }
}
