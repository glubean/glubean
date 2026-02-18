/**
 * Sync command - packages and uploads test files to the Glubean cloud registry.
 *
 * Flow:
 * 1. Scan for test files using @glubean/scanner
 * 2. Generate metadata.json
 * 3. Package as tar with all project files (test code + data/support files)
 * 4. Upload to server (which handles S3 storage)
 */

import { join, relative, resolve } from "@std/path";
import { Tar } from "@std/archive/tar";
import { Buffer } from "@std/io/buffer";
import { walk } from "@std/fs/walk";
import { type BundleMetadata, type FileMeta, scan } from "@glubean/scanner";
import { buildMetadata } from "../metadata.ts";
import { CLI_VERSION } from "../version.ts";
import { DEFAULT_API_URL } from "../lib/constants.ts";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

export interface SyncOptions {
  /** Project ID to sync to */
  project?: string;
  /** Bundle version (defaults to timestamp) */
  version?: string;
  /** Directory containing test files (defaults to current dir) */
  dir?: string;
  /** Dry run - generate metadata but don't upload */
  dryRun?: boolean;
  /** API server URL */
  apiUrl?: string;
  /** Auth token */
  token?: string;
}

/** Directories always excluded from bundles */
const DEFAULT_SKIP_DIRS = [
  "node_modules",
  ".git",
  ".glubean",
  "dist",
  "build",
  ".deno",
];

/**
 * Parse a .glubeanignore file into an array of regex skip patterns.
 * Supports gitignore-style patterns:
 *   - Lines starting with # are comments
 *   - Blank lines are ignored
 *   - Patterns are matched against relative paths
 *   - Leading / is stripped (anchors to project root)
 *   - Trailing / matches directories only (handled by matching path segments)
 *   - * matches anything except /
 *   - ** matches everything including /
 */
function parseIgnorePatterns(content: string): RegExp[] {
  const patterns: RegExp[] = [];

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    // Convert gitignore-style pattern to regex
    let pattern = line;

    // Strip leading slash (anchor to root, but we always match from root)
    if (pattern.startsWith("/")) {
      pattern = pattern.slice(1);
    }

    // Strip trailing slash (directory marker — our walk only yields files,
    // so "dirname/" effectively means "dirname/**")
    if (pattern.endsWith("/")) {
      pattern = pattern.slice(0, -1);
    }

    // Escape regex special chars (except * and ?)
    pattern = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");

    // Convert glob patterns to regex
    pattern = pattern
      .replace(/\*\*/g, "{{GLOBSTAR}}") // placeholder for **
      .replace(/\*/g, "[^/]*") // * → anything except /
      .replace(/\?/g, "[^/]") // ? → single char except /
      .replace(/\{\{GLOBSTAR\}\}/g, ".*"); // ** → anything including /

    // Match as a full path segment or the full relative path
    patterns.push(new RegExp(`(^|/)${pattern}(/|$)`));
  }

  return patterns;
}

/**
 * Collect all project files for bundling.
 *
 * Walks the entire project directory, skipping:
 * - Default irrelevant directories (node_modules, .git, dist, build, .deno)
 * - Patterns from .glubeanignore (if present)
 * - The generated bundle tar file itself
 *
 * @returns Array of relative file paths to include in the bundle
 */
async function collectBundleFiles(dir: string): Promise<string[]> {
  // Build skip patterns from default dirs
  const skipPatterns = DEFAULT_SKIP_DIRS.map(
    (d) => new RegExp(`(^|/)${d}(/|$)`),
  );

  // Load .glubeanignore if present
  const ignorePath = join(dir, ".glubeanignore");
  try {
    const content = await Deno.readTextFile(ignorePath);
    skipPatterns.push(...parseIgnorePatterns(content));
  } catch {
    // No .glubeanignore — use defaults only
  }

  const files: string[] = [];
  for await (const entry of walk(dir, { skip: skipPatterns })) {
    if (!entry.isFile) continue;
    const rel = relative(dir, entry.path);
    // Skip generated bundle tar files
    if (rel.startsWith(".glubean-bundle-")) continue;
    files.push(rel);
  }

  return files.sort();
}

/**
 * Create the bundle tar file containing metadata.json and all project files.
 *
 * @returns The number of project files added to the bundle (excluding metadata.json)
 */
async function createBundleTar(
  dir: string,
  metadata: BundleMetadata,
  outputPath: string,
): Promise<number> {
  const tar = new Tar();

  // Add metadata.json
  const metadataContent = new TextEncoder().encode(
    JSON.stringify(metadata, null, 2),
  );
  await tar.append("metadata.json", {
    reader: new Buffer(metadataContent),
    contentSize: metadataContent.byteLength,
  });

  // Collect and add all project files
  const bundleFiles = await collectBundleFiles(dir);
  for (const filePath of bundleFiles) {
    const srcPath = join(dir, filePath);
    const content = await Deno.readFile(srcPath);
    await tar.append(filePath, {
      reader: new Buffer(content),
      contentSize: content.byteLength,
    });
  }

  // Collect all data from tar reader
  const reader = tar.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const buffer = new Uint8Array(16384); // 16KB chunks
    const result = await reader.read(buffer);
    if (result === null) break;
    chunks.push(buffer.slice(0, result));
  }

  // Concatenate all chunks
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
  const tarData = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    tarData.set(chunk, offset);
    offset += chunk.byteLength;
  }

  await Deno.writeFile(outputPath, tarData);
  return bundleFiles.length;
}

/** Response from sync/init API */
interface InitSyncResponse {
  bundleId: string;
  uploadUrl: string;
  uploadKey: string;
  expiresAt: string;
}

/** Response from sync/complete API */
interface CompleteSyncResponse {
  bundleId: string;
  shortId: string;
  version: string;
  testCount: number;
  fileCount: number;
}

/**
 * Step 1: Initialize sync - get presigned URL
 */
async function initSync(
  projectId: string,
  version: string,
  apiUrl: string,
  token?: string,
  name?: string,
): Promise<InitSyncResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(
    `${apiUrl}/projects/${projectId}/bundles/sync/init`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ version, name }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Init sync failed: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Step 2: Upload tar file to S3 using presigned URL
 */
async function uploadToS3(tarPath: string, uploadUrl: string): Promise<void> {
  const tarContent = await Deno.readFile(tarPath);

  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/x-tar",
    },
    body: tarContent,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`S3 upload failed: ${response.status} - ${error}`);
  }
}

/**
 * Step 3: Complete sync - save metadata
 */
async function completeSync(
  projectId: string,
  bundleId: string,
  timestamp: number,
  files: Record<string, FileMeta>,
  apiUrl: string,
  token?: string,
): Promise<CompleteSyncResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(
    `${apiUrl}/projects/${projectId}/bundles/sync/complete`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ bundleId, timestamp, files }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Complete sync failed: ${response.status} - ${error}`);
  }

  return response.json();
}

export async function syncCommand(options: SyncOptions = {}): Promise<void> {
  console.log(
    `\n${colors.bold}${colors.blue}☁️  Glubean Sync${colors.reset}\n`,
  );

  // Validate options
  if (!options.project) {
    console.log(`${colors.red}✗ Error: --project is required${colors.reset}`);
    console.log(
      `${colors.dim}  Usage: glubean sync --project <project-id>${colors.reset}\n`,
    );
    Deno.exit(1);
  }

  const dir = options.dir ? resolve(options.dir) : Deno.cwd();
  const version = options.version ||
    new Date().toISOString().replace(/[:.]/g, "-");
  const apiUrl = (
    options.apiUrl ||
    Deno.env.get("GLUBEAN_API_URL") ||
    DEFAULT_API_URL
  ).replace(/\/$/, "");

  console.log(`${colors.dim}Project:   ${colors.reset}${options.project}`);
  console.log(`${colors.dim}Version:   ${colors.reset}${version}`);
  console.log(`${colors.dim}Directory: ${colors.reset}${dir}`);
  console.log();

  // Step 1: Scan test files
  console.log(`${colors.cyan}→ Scanning test files...${colors.reset}`);
  const scanResult = await scan(dir);
  if (scanResult.fileCount === 0) {
    console.log(`${colors.yellow}⚠️  No test files found.${colors.reset}`);
    console.log(
      `${colors.dim}   Make sure your test files import from @glubean/sdk and export test().${colors.reset}\n`,
    );
    return;
  }

  const metadata = await buildMetadata(scanResult, {
    generatedBy: `@glubean/cli@${CLI_VERSION}`,
    projectId: options.project,
    version,
  });
  const files = metadata.files;
  const testCount = metadata.testCount;
  const fileCount = metadata.fileCount;

  console.log(
    `${colors.green}✓ Found ${testCount} test(s) in ${fileCount} file(s)${colors.reset}`,
  );

  // List files and exports
  for (const [path, meta] of Object.entries(files)) {
    console.log(`${colors.dim}  • ${path}${colors.reset}`);
    for (const exp of meta.exports) {
      const tagStr = exp.tags ? ` [${exp.tags.join(", ")}]` : "";
      console.log(`${colors.dim}    - ${exp.id}${tagStr}${colors.reset}`);
    }
  }
  console.log();

  // Step 2: Generate metadata
  console.log(`${colors.cyan}→ Generating metadata.json...${colors.reset}`);
  console.log(`${colors.green}✓ Metadata generated${colors.reset}\n`);
  const syncTimestamp = Date.now();

  // Step 3: Create tar bundle (includes all project files, not just test files)
  const tarPath = join(Deno.cwd(), `.glubean-bundle-${version}.tar`);
  console.log(`${colors.cyan}→ Bundling project files...${colors.reset}`);
  const bundledFileCount = await createBundleTar(dir, metadata, tarPath);

  const tarStat = await Deno.stat(tarPath);
  const sizeKB = (tarStat.size / 1024).toFixed(2);
  const dataFileCount = bundledFileCount - fileCount;
  const breakdown = dataFileCount > 0 ? ` (${fileCount} test + ${dataFileCount} data/support)` : "";
  console.log(
    `${colors.green}✓ Bundle created: ${bundledFileCount} files${breakdown}, ${sizeKB} KB${colors.reset}\n`,
  );

  // Step 4: Upload (or dry run)
  if (options.dryRun) {
    console.log(`${colors.yellow}🔍 Dry run - skipping upload${colors.reset}`);
    console.log(`${colors.dim}   Bundle saved to: ${tarPath}${colors.reset}`);
    console.log(`${colors.dim}   Metadata:${colors.reset}`);
    console.log(JSON.stringify(metadata, null, 2));
    console.log(
      `\n${colors.green}${colors.bold}✓ Sync complete (dry run)!${colors.reset}\n`,
    );
    return;
  }

  try {
    // Step 4a: Initialize sync - get presigned URL
    console.log(`${colors.cyan}→ Initializing sync...${colors.reset}`);
    const initResult = await initSync(
      options.project,
      version,
      apiUrl,
      options.token,
    );
    console.log(
      `${colors.green}✓ Bundle ID: ${initResult.bundleId}${colors.reset}`,
    );

    // Step 4b: Upload to S3
    console.log(`${colors.cyan}→ Uploading to cloud storage...${colors.reset}`);
    await uploadToS3(tarPath, initResult.uploadUrl);
    console.log(`${colors.green}✓ Upload complete${colors.reset}`);

    // Step 4c: Complete sync - save metadata
    console.log(`${colors.cyan}→ Finalizing sync...${colors.reset}`);
    const completeResult = await completeSync(
      options.project,
      initResult.bundleId,
      syncTimestamp,
      metadata.files,
      apiUrl,
      options.token,
    );
    console.log(`${colors.green}✓ Sync finalized${colors.reset}`);

    console.log();
    console.log(`${colors.bold}Bundle Summary:${colors.reset}`);
    console.log(
      `${colors.dim}   ID:      ${colors.reset}${completeResult.bundleId}`,
    );
    console.log(
      `${colors.dim}   Version: ${colors.reset}${completeResult.version}`,
    );
    console.log(
      `${colors.dim}   Tests:   ${colors.reset}${completeResult.testCount}`,
    );
    console.log(
      `${colors.dim}   Files:   ${colors.reset}${completeResult.fileCount}`,
    );

    // Cleanup tar file
    await Deno.remove(tarPath);
  } catch (error) {
    console.log(
      `${colors.red}✗ Sync failed: ${error instanceof Error ? error.message : error}${colors.reset}`,
    );
    console.log(
      `${colors.dim}   Bundle saved locally: ${tarPath}${colors.reset}`,
    );
    Deno.exit(1);
  }

  console.log(
    `\n${colors.green}${colors.bold}✓ Sync complete!${colors.reset}\n`,
  );
}
