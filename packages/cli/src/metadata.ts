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
  },
): Promise<BundleMetadata> {
  const normalizedFiles = normalizeFileMap(scanResult.files);
  const stats = deriveMetadataStats(normalizedFiles);
  const contracts = scanResult.contracts;
  const rootHash = await computeRootHash(normalizedFiles, contracts);

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
  };
}
