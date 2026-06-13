import { createHash } from "node:crypto";
import type { BundleMetadata, FileMeta, ScanResult } from "@glubean/scanner";

export const METADATA_SCHEMA_VERSION = "1";

export function normalizeFilePath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function normalizeFileMap(
  files: Record<string, FileMeta>,
): Record<string, FileMeta> {
  const normalized: Record<string, FileMeta> = {};
  for (const [path, meta] of Object.entries(files)) {
    const normalizedPath = normalizeFilePath(path);
    if (normalized[normalizedPath]) {
      throw new Error(`Duplicate file path after normalization: ${path}`);
    }
    normalized[normalizedPath] = meta;
  }
  return normalized;
}

export function deriveMetadataStats(files: Record<string, FileMeta>): {
  testCount: number;
  fileCount: number;
  tags: string[];
} {
  let testCount = 0;
  const allTags = new Set<string>();

  for (const fileMeta of Object.values(files)) {
    for (const exp of fileMeta.exports) {
      if (exp.tags) {
        exp.tags.forEach((tag) => allTags.add(tag));
      }
      testCount += 1;
    }
  }

  return {
    testCount,
    fileCount: Object.keys(files).length,
    tags: Array.from(allTags).sort(),
  };
}

export async function computeRootHash(
  files: Record<string, FileMeta>,
  contracts?: unknown[],
  workflows?: unknown[],
): Promise<string> {
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  const parts: string[] = entries.map(([path, meta]) => `${path}:${meta.hash}`);

  // Include contract metadata in hash so contract changes affect rootHash
  if (contracts && contracts.length > 0) {
    const contractHash = createHash("sha256")
      .update(JSON.stringify(contracts))
      .digest("hex");
    parts.push(`__contracts__:sha256-${contractHash}`);
  }

  // Same for workflow projections (S2.6) — a grade/shape change must change
  // the rootHash. Only added when present, so workflow-free projects keep
  // their existing hashes.
  if (workflows && workflows.length > 0) {
    const workflowHash = createHash("sha256")
      .update(JSON.stringify(workflows))
      .digest("hex");
    parts.push(`__workflows__:sha256-${workflowHash}`);
  }


  const hash = createHash("sha256").update(parts.join("\n")).digest("hex");
  return `sha256-${hash}`;
}

export async function buildMetadata(
  scanResult: ScanResult,
  options: {
    generatedBy: string;
    generatedAt?: string;
    projectId?: string;
    version?: string;
    /**
     * Emit the LOSSLESS full CONTRACT projection (`contractsProjection`).
     * Default false.
     *
     * Off by default because the rich projection can carry secrets (examples,
     * default headers, `extensions`/`meta`) and `buildMetadata` also backs
     * `glubean scan`, which writes metadata.json to disk (commonly kept in
     * git). Only the Cloud upload path opts in — and it deep-redacts the
     * projection before it leaves the machine (see commands/run.ts).
     *
     * NOTE (Design Y): `workflows` is emitted UNCONDITIONALLY (below) — it is
     * the only representation of a workflow's shape and already drives
     * `rootHash`, so `validate_metadata` recomputes it from the on-disk file.
     * Gating it out would break that self-check. The upload path still redacts
     * `workflows` before persisting the server snapshot — the actual P1 gate.
     */
    includeProjection?: boolean;
  },
): Promise<BundleMetadata> {
  const normalizedFiles = normalizeFileMap(scanResult.files);
  const stats = deriveMetadataStats(normalizedFiles);
  const contracts = scanResult.contracts;
  const workflows = scanResult.workflows;
  const rootHash = await computeRootHash(normalizedFiles, contracts, workflows);

  const contractsProjection = options.includeProjection
    ? scanResult.contractsProjection
    : undefined;

  return {
    schemaVersion: METADATA_SCHEMA_VERSION,
    specVersion: scanResult.specVersion,
    generatedBy: options.generatedBy,
    generatedAt: options.generatedAt || new Date().toISOString(),
    rootHash,
    files: normalizedFiles,
    testCount: stats.testCount,
    fileCount: stats.fileCount,
    tags: stats.tags,
    warnings: scanResult.warnings,
    projectId: options.projectId,
    version: options.version,
    contracts: contracts && contracts.length > 0 ? contracts : undefined,
    // Lossless full projection of contracts — the source of truth for the
    // Cloud contract metadata snapshot. Upload-only (includeProjection) and
    // MUST be redacted before upload (see commands/run.ts): the projection can
    // carry secrets in examples / default headers / extensions.
    contractsProjection:
      contractsProjection && contractsProjection.length > 0
        ? contractsProjection
        : undefined,
    // DELIBERATELY UNFILTERED (codex S2.6 R14): metadata is the project's
    // authoritative DECLARATION inventory — like `files` and `contracts`, it
    // always reflects the whole scan, never the run's selection. The server's
    // upsert treats this map as authoritative (filtering to selected runnables
    // would make Cloud mark everything unselected as removed — see the
    // degraded-scan note in run.ts). The --upload branch/poll gate protects a
    // DIFFERENT layer: RUN data, where Cloud would render a misleading
    // partial view. A projection in metadata is not a run view; Cloud ignores
    // these fields until the rendering line lands, and when it does it needs
    // the complete inventory, branch/poll included.
    workflows: workflows && workflows.length > 0 ? workflows : undefined,
  };
}
