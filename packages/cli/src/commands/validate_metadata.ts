import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { BundleMetadata, FileMeta } from "@glubean/scanner";
import { computeRootHash, deriveMetadataStats, normalizeFileMap, normalizeFilePath } from "../metadata.js";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
};

export interface ValidateMetadataOptions {
  dir?: string;
  metadata?: string;
}

async function sha256(content: Uint8Array): Promise<string> {
  const hash = createHash("sha256").update(content).digest("hex");
  return `sha256-${hash}`;
}

function compareTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((tag, index) => tag === sortedB[index]);
}

export async function validateMetadataCommand(
  options: ValidateMetadataOptions = {},
): Promise<void> {
  const dir = options.dir ? resolve(options.dir) : process.cwd();
  const metadataPath = options.metadata ? resolve(options.metadata) : resolve(dir, "metadata.json");

  console.log(
    `\n${colors.bold}${colors.blue}🧭 Glubean Metadata Validation${colors.reset}\n`,
  );
  console.log(`${colors.dim}Directory: ${dir}${colors.reset}`);
  console.log(`${colors.dim}Metadata:  ${metadataPath}${colors.reset}\n`);

  let metadata: BundleMetadata;
  try {
    const raw = await readFile(metadataPath, "utf-8");
    metadata = JSON.parse(raw) as BundleMetadata;
  } catch (error) {
    console.error(`${colors.red}✗ Failed to read metadata.json${colors.reset}`);
    console.error(
      `${colors.dim}${error instanceof Error ? error.message : String(error)}${colors.reset}`,
    );
    process.exit(1);
    return;
  }

  if (!metadata || metadata.schemaVersion !== "1") {
    console.error(
      `${colors.red}✗ Unsupported metadata schemaVersion${colors.reset}`,
    );
    process.exit(1);
  }

  if (!metadata.files || typeof metadata.files !== "object") {
    console.error(
      `${colors.red}✗ Invalid metadata: files missing${colors.reset}`,
    );
    process.exit(1);
  }

  let normalizedFiles: Record<string, FileMeta>;
  try {
    normalizedFiles = normalizeFileMap(metadata.files);
  } catch (error) {
    console.error(`${colors.red}✗ Invalid metadata file paths${colors.reset}`);
    console.error(
      `${colors.dim}${error instanceof Error ? error.message : String(error)}${colors.reset}`,
    );
    process.exit(1);
  }

  for (const [rawPath, meta] of Object.entries(normalizedFiles!)) {
    const filePath = normalizeFilePath(rawPath);
    const absolutePath = resolve(dir, filePath);
    let content: Buffer;
    try {
      content = await readFile(absolutePath);
    } catch (error) {
      console.error(
        `${colors.red}✗ Missing file referenced in metadata: ${filePath}${colors.reset}`,
      );
      console.error(
        `${colors.dim}${error instanceof Error ? error.message : String(error)}${colors.reset}`,
      );
      process.exit(1);
      return;
    }

    const actualHash = await sha256(content);
    if (actualHash !== meta.hash) {
      console.error(
        `${colors.red}✗ File hash mismatch for ${filePath}${colors.reset}`,
      );
      console.error(
        `${colors.dim}Expected: ${meta.hash}\nActual:   ${actualHash}${colors.reset}`,
      );
      process.exit(1);
    }
  }

  // Recompute with the SAME inputs buildMetadata hashed: contracts and
  // workflow projections are part of the rootHash when present (a metadata
  // file carrying them would otherwise always report a false mismatch —
  // codex S2.6 R1 P2).
  const computedRootHash = await computeRootHash(
    normalizedFiles!,
    metadata.contracts,
    metadata.workflows,
  );
  if (computedRootHash !== metadata.rootHash) {
    console.error(`${colors.red}✗ Root hash mismatch${colors.reset}`);
    console.error(
      `${colors.dim}Expected: ${metadata.rootHash}\nActual:   ${computedRootHash}${colors.reset}`,
    );
    process.exit(1);
  }

  const derived = deriveMetadataStats(normalizedFiles!);
  if (metadata.fileCount !== derived.fileCount) {
    console.error(`${colors.red}✗ fileCount mismatch${colors.reset}`);
    console.error(
      `${colors.dim}Expected: ${metadata.fileCount}\nActual:   ${derived.fileCount}${colors.reset}`,
    );
    process.exit(1);
  }

  if (metadata.testCount !== derived.testCount) {
    console.error(`${colors.red}✗ testCount mismatch${colors.reset}`);
    console.error(
      `${colors.dim}Expected: ${metadata.testCount}\nActual:   ${derived.testCount}${colors.reset}`,
    );
    process.exit(1);
  }

  if (!compareTags(metadata.tags || [], derived.tags)) {
    console.error(`${colors.red}✗ tags mismatch${colors.reset}`);
    console.error(
      `${colors.dim}Expected: ${metadata.tags?.join(", ") || "(none)"}\nActual:   ${
        derived.tags.join(", ") || "(none)"
      }${colors.reset}`,
    );
    process.exit(1);
  }

  console.log(`${colors.green}✓ metadata.json is valid${colors.reset}`);
  console.log(
    `${colors.dim}  Files: ${derived.fileCount}, Tests: ${derived.testCount}${colors.reset}\n`,
  );
}
