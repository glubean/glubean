/**
 * Core scanner logic for extracting test metadata from source files.
 *
 * This module uses runtime extraction - it imports test files and reads
 * metadata from the SDK's global registry instead of static analysis.
 */

import {
  SPEC_VERSION,
  SUPPORTED_SPEC_VERSIONS,
  isSpecVersionSupported,
} from "./spec.ts";
import type {
  ExportMeta,
  FileMeta,
  ScanResult,
  ScanOptions,
  ValidationResult,
} from "./types.ts";

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
export type MetadataExtractor = (filePath: string) => Promise<ExportMeta[]>;

const DEFAULT_SKIP_DIRS = ["node_modules", ".git", "dist", "build", ".deno"];
const DEFAULT_EXTENSIONS = [".ts"];

/**
 * SDK import patterns to identify Glubean test files.
 */
const SDK_IMPORT_PATTERNS = [
  // JSR import: import { test } from "jsr:@glubean/sdk"
  /import\s+.*from\s+["']jsr:@glubean\/sdk["']/,
  // Direct import: import { test } from "@glubean/sdk"
  /import\s+.*from\s+["']@glubean\/sdk["']/,
  // URL import (for development)
  /import\s+.*\{[^}]*test[^}]*\}/,
];

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
        `Unsupported spec version: ${specVersion}. Supported: ${SUPPORTED_SPEC_VERSIONS.join(
          ", ",
        )}`,
      );
    }
    this.fs = fs;
    this.hasher = hasher;
    this.specVersion = specVersion;
    this.extractor = extractor;
  }

  /**
   * Validate that a directory is a valid Glubean project.
   */
  async validate(dir: string): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    let detectedSpecVersion: string | undefined;

    // Check for deno.json
    const denoJsonPath = this.fs.join(dir, "deno.json");
    const hasDenoJson = await this.fs.exists(denoJsonPath);

    if (!hasDenoJson) {
      warnings.push(
        "No deno.json found - are you sure this is a Glubean project?",
      );
    } else {
      // Try to detect SDK version from deno.json
      try {
        const content = await this.fs.readText(denoJsonPath);
        const json = JSON.parse(content);

        // Check imports or dependencies for @glubean/sdk
        const imports = json.imports || {};
        const sdkImport =
          imports["@glubean/sdk"] || imports["jsr:@glubean/sdk"];

        if (sdkImport) {
          // Extract version from import like "jsr:@glubean/sdk@0.1.0"
          const versionMatch = sdkImport.match(/@(\d+\.\d+\.\d+)/);
          if (versionMatch) {
            // Map SDK version to spec version
            const majorVersion = parseInt(versionMatch[1].split(".")[0]);
            detectedSpecVersion = majorVersion >= 2 ? "2.0" : "1.0";
          }
        }
      } catch {
        warnings.push("Failed to parse deno.json");
      }
    }

    // Check for at least one *.test.ts file with SDK import
    let foundSdkImport = false;

    try {
      for await (const filePath of this.fs.walk(dir, {
        extensions: DEFAULT_EXTENSIONS,
        skipDirs: DEFAULT_SKIP_DIRS,
      })) {
        // Only consider *.test.ts files
        if (!filePath.endsWith(".test.ts")) continue;

        const content = await this.fs.readText(filePath);

        for (const pattern of SDK_IMPORT_PATTERNS) {
          if (pattern.test(content)) {
            foundSdkImport = true;
            break;
          }
        }

        if (foundSdkImport) break;
      }
    } catch (err) {
      errors.push(`Failed to scan directory: ${err}`);
    }

    if (!foundSdkImport) {
      errors.push(
        "No *.test.ts files found with @glubean/sdk import. " +
          'Ensure your test files are named *.test.ts and import from "@glubean/sdk" or "jsr:@glubean/sdk".',
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
    if (options.requireDenoJson) {
      const validation = await this.validate(dir);
      if (!validation.valid) {
        throw new Error(
          `Invalid Glubean project: ${validation.errors.join("; ")}`,
        );
      }
      warnings.push(...validation.warnings);
    } else {
      // Just check deno.json for warning
      const denoJsonPath = this.fs.join(dir, "deno.json");
      const hasDenoJson = await this.fs.exists(denoJsonPath);
      if (!hasDenoJson) {
        warnings.push("No deno.json found in root directory");
      }
    }

    if (!this.extractor) {
      throw new Error(
        "No metadata extractor configured. Use createScanner() for the default Deno extractor.",
      );
    }

    // Find all *.test.ts files with SDK import
    const testFiles: string[] = [];
    for await (const filePath of this.fs.walk(dir, { extensions, skipDirs })) {
      // Only consider *.test.ts files
      if (!filePath.endsWith(".test.ts")) continue;

      const content = await this.fs.readText(filePath);

      // Quick check for SDK import
      let hasSdkImport = false;
      for (const pattern of SDK_IMPORT_PATTERNS) {
        if (pattern.test(content)) {
          hasSdkImport = true;
          break;
        }
      }

      if (hasSdkImport) {
        testFiles.push(filePath);
      }
    }

    // Extract metadata from each file using runtime extraction
    for (const filePath of testFiles) {
      try {
        const exports = await this.extractor(filePath);

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
          'Ensure your test files are named *.test.ts, import from "@glubean/sdk", and export test().',
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
