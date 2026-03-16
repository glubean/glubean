/**
 * Core scanner logic for extracting test metadata from source files.
 *
 * This module uses runtime extraction - it imports test files and reads
 * metadata from the SDK's global registry instead of static analysis.
 */

import { isSpecVersionSupported, SPEC_VERSION, SUPPORTED_SPEC_VERSIONS } from "./spec.js";
import { extractAliasesFromSource } from "./extractor-static.js";
import type { ExportMeta, FileMeta, ScanOptions, ScanResult, ValidationResult } from "./types.js";

/** File system interface for runtime abstraction */
export interface FileSystem {
  /** Check if a path exists */
  exists(path: string): Promise<boolean>;
  /** Read file as text */
  readText(path: string): Promise<string>;
  /** Read file as bytes (for hashing) */
  readBytes(path: string): Promise<Uint8Array>;
  /** Walk directory recursively, yielding file paths */
  walk(
    dir: string,
    options: { extensions: string[]; skipDirs: string[] },
  ): AsyncIterable<string>;
  /** Join path segments */
  join(...segments: string[]): string;
  /** Get relative path from base to target */
  relative(base: string, target: string): string;
  /** Resolve path to absolute */
  resolve?(path: string): string;
}

/** Hash function interface */
export interface Hasher {
  /** Calculate SHA-256 hash of content, returns "sha256-..." */
  sha256(content: Uint8Array): Promise<string>;
}

/** Metadata extractor interface (runtime-specific) */
export type MetadataExtractor = (filePath: string, customFns?: string[]) => Promise<ExportMeta[]>;

const DEFAULT_SKIP_DIRS = ["node_modules", ".git", "dist", "build"];
const DEFAULT_EXTENSIONS = [".ts", ".js", ".mjs"];

const TEST_FILE_SUFFIXES = [".test.ts", ".test.js", ".test.mjs"];

function isTestFile(filePath: string): boolean {
  return TEST_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

/**
 * Scanner class for extracting test metadata from a directory.
 *
 * Uses runtime extraction: imports test files and reads from SDK registry.
 */
export class Scanner {
  private readonly specVersion: string;
  private readonly fs: FileSystem;
  private readonly hasher: Hasher;
  private readonly extractor?: MetadataExtractor;

  constructor(
    fs: FileSystem,
    hasher: Hasher,
    specVersion: string = SPEC_VERSION,
    extractor?: MetadataExtractor,
  ) {
    if (!isSpecVersionSupported(specVersion)) {
      throw new Error(
        `Unsupported spec version: ${specVersion}. Supported: ${
          SUPPORTED_SPEC_VERSIONS.join(
            ", ",
          )
        }`,
      );
    }
    this.fs = fs;
    this.hasher = hasher;
    this.specVersion = specVersion;
    this.extractor = extractor;
  }

  /**
   * Collect custom function names from `.extend()` calls across all .ts files.
   * Returns an array of alias names (e.g. ["browserTest", "screenshotTest"]).
   */
  private async collectAliases(
    dir: string,
    skipDirs: string[] = DEFAULT_SKIP_DIRS,
    extensions: string[] = DEFAULT_EXTENSIONS,
  ): Promise<string[] | undefined> {
    const aliases = new Set<string>();
    try {
      for await (const filePath of this.fs.walk(dir, { extensions, skipDirs })) {
        const content = await this.fs.readText(filePath);
        for (const alias of extractAliasesFromSource(content)) {
          aliases.add(alias);
        }
      }
    } catch {
      // Non-fatal — continue without aliases
    }
    return aliases.size > 0 ? [...aliases] : undefined;
  }

  /**
   * Validate that a directory is a valid Glubean project.
   */
  async validate(dir: string): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    let detectedSpecVersion: string | undefined;

    // Check for package.json
    const packageJsonPath = this.fs.join(dir, "package.json");
    const hasPackageJson = await this.fs.exists(packageJsonPath);

    if (!hasPackageJson) {
      warnings.push(
        "No package.json found - are you sure this is a Glubean project?",
      );
    } else {
      // Try to detect SDK version from package.json
      try {
        const content = await this.fs.readText(packageJsonPath);
        const json = JSON.parse(content);

        // Check dependencies for @glubean/sdk
        const deps = { ...json.dependencies, ...json.devDependencies };
        const sdkDep = deps["@glubean/sdk"];

        if (sdkDep) {
          // Extract version from dep like "^0.12.0" or "workspace:*"
          const versionMatch = sdkDep.match(/(\d+)\.\d+\.\d+/);
          if (versionMatch) {
            const majorVersion = parseInt(versionMatch[1]);
            detectedSpecVersion = majorVersion >= 2 ? "2.0" : "1.0";
          }
        }
      } catch {
        warnings.push("Failed to parse package.json");
      }
    }

    // Check for at least one *.test.ts file
    let foundTestFile = false;

    try {
      for await (
        const filePath of this.fs.walk(dir, {
          extensions: DEFAULT_EXTENSIONS,
          skipDirs: DEFAULT_SKIP_DIRS,
        })
      ) {
        if (isTestFile(filePath)) {
          foundTestFile = true;
          break;
        }
      }
    } catch (err) {
      errors.push(`Failed to scan directory: ${err}`);
    }

    if (!foundTestFile) {
      errors.push(
        "No test files found. " +
          "Ensure your test files are named *.test.ts, *.test.js, or *.test.mjs.",
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      detectedSpecVersion: detectedSpecVersion || this.specVersion,
    };
  }

  /**
   * Scan a directory for Glubean test files using runtime extraction.
   *
   * This imports each test file in a subprocess and reads metadata from
   * the SDK's global registry, ensuring accurate extraction without
   * regex-based parsing.
   */
  async scan(dir: string, options: ScanOptions = {}): Promise<ScanResult> {
    const specVersion = options.specVersion || this.specVersion;
    const skipDirs = options.skipDirs || DEFAULT_SKIP_DIRS;
    const extensions = options.extensions || DEFAULT_EXTENSIONS;

    const files: Record<string, FileMeta> = {};
    let testCount = 0;
    const allTags = new Set<string>();
    const warnings: string[] = [];

    // Optionally validate first
    if (options.requirePackageJson) {
      const validation = await this.validate(dir);
      if (!validation.valid) {
        throw new Error(
          `Invalid Glubean project: ${validation.errors.join("; ")}`,
        );
      }
      warnings.push(...validation.warnings);
    } else {
      // Just check package.json for warning
      const packageJsonPath = this.fs.join(dir, "package.json");
      const hasPackageJson = await this.fs.exists(packageJsonPath);
      if (!hasPackageJson) {
        warnings.push("No package.json found in root directory");
      }
    }

    if (!this.extractor) {
      throw new Error(
        "No metadata extractor configured. Use createScanner() for the default extractor.",
      );
    }

    // Phase 1: collect .extend() aliases from all .ts files
    const aliases = await this.collectAliases(dir, skipDirs, extensions);

    // Phase 2: collect all *.test.ts files
    const testFiles: string[] = [];
    for await (const filePath of this.fs.walk(dir, { extensions, skipDirs })) {
      if (!isTestFile(filePath)) continue;
      testFiles.push(filePath);
    }

    // Extract metadata from each file using runtime extraction
    for (const filePath of testFiles) {
      try {
        const exports = await this.extractor(filePath, aliases);

        if (exports.length > 0) {
          const relativePath = this.fs.relative(dir, filePath);
          const contentBytes = await this.fs.readBytes(filePath);
          const hash = await this.hasher.sha256(contentBytes);

          files[relativePath] = { hash, exports };

          // Count tests and collect tags
          for (const exp of exports) {
            testCount += 1;

            // Collect tags
            if (exp.tags) {
              exp.tags.forEach((tag) => allTags.add(tag));
            }
          }
        }
      } catch (err) {
        warnings.push(`Failed to extract metadata from ${filePath}: ${err}`);
      }
    }

    if (Object.keys(files).length === 0) {
      warnings.push(
        "No Glubean test files found. " +
          "Ensure your test files are named *.test.ts, *.test.js, or *.test.mjs and export test().",
      );
    }

    return {
      specVersion,
      files,
      testCount,
      fileCount: Object.keys(files).length,
      tags: Array.from(allTags),
      warnings,
    };
  }
}
