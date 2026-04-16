/**
 * Core scanner logic for extracting test metadata from source files.
 *
 * This module uses runtime extraction - it imports test files and reads
 * metadata from the SDK's global registry instead of static analysis.
 */

import { isSpecVersionSupported, SPEC_VERSION, SUPPORTED_SPEC_VERSIONS } from "./spec.js";
import { extractAliasesFromSource, extractContractCases } from "./extractor-static.js";
import type { ContractStaticMeta } from "./extractor-static.js";
import { extractContractFromFile } from "./contract-extraction.js";
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
const CONTRACT_FILE_SUFFIXES = [".contract.ts", ".contract.js", ".contract.mjs"];

function isTestFile(filePath: string): boolean {
  return TEST_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

function isContractFile(filePath: string): boolean {
  return CONTRACT_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
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

    // Check for at least one test or contract file
    let foundTestFile = false;
    let foundContractFile = false;

    try {
      for await (
        const filePath of this.fs.walk(dir, {
          extensions: DEFAULT_EXTENSIONS,
          skipDirs: DEFAULT_SKIP_DIRS,
        })
      ) {
        if (isTestFile(filePath)) foundTestFile = true;
        else if (isContractFile(filePath)) foundContractFile = true;
        if (foundTestFile || foundContractFile) break;
      }
    } catch (err) {
      errors.push(`Failed to scan directory: ${err}`);
    }

    if (!foundTestFile && !foundContractFile) {
      errors.push(
        "No test or contract files found. " +
          "Ensure your files are named *.test.ts or *.contract.ts.",
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

    // Phase 2: collect test files and contract files
    const testFiles: string[] = [];
    const contractFiles: string[] = [];
    for await (const filePath of this.fs.walk(dir, { extensions, skipDirs })) {
      if (isTestFile(filePath)) testFiles.push(filePath);
      else if (isContractFile(filePath)) contractFiles.push(filePath);
    }

    // Phase 3: Extract test metadata from each test file
    for (const filePath of testFiles) {
      try {
        const exports = await this.extractor(filePath, aliases);

        if (exports.length > 0) {
          const relativePath = this.fs.relative(dir, filePath);
          const contentBytes = await this.fs.readBytes(filePath);
          const hash = await this.hasher.sha256(contentBytes);

          files[relativePath] = { hash, exports };

          for (const exp of exports) {
            testCount += 1;
            if (exp.tags) {
              exp.tags.forEach((tag) => allTags.add(tag));
            }
          }
        }
      } catch (err) {
        warnings.push(`Failed to extract metadata from ${filePath}: ${err}`);
      }
    }

    // Phase 4: Extract contract metadata from contract files
    // Uses shared runtime extraction (supports both old and .with() syntax).
    // Falls back to static regex if runtime import fails.
    const contracts: ContractStaticMeta[] = [];
    for (const filePath of contractFiles) {
      const absolutePath = this.fs.resolve ? this.fs.resolve(filePath) : filePath;
      const result = await extractContractFromFile(absolutePath);

      if (result.contracts.length > 0) {
        // Map NormalizedContractMeta → ContractStaticMeta for backward compatibility
        for (const ec of result.contracts) {
          contracts.push({
            contractId: ec.id,
            exportName: ec.exportName,
            endpoint: ec.target,
            protocol: ec.protocol,
            description: ec.description,
            feature: ec.feature,
            line: 0,
            cases: ec.cases.map((c) => ({
              key: c.key,
              description: c.description,
              expectStatus: (c.protocolExpect as any)?.status,
              deferred: c.deferredReason,
              deprecated: c.deprecatedReason,
              lifecycle: c.lifecycle,
              severity: c.severity,
              requires: c.requires,
              defaultRun: c.defaultRun,
              line: 0,
            })),
          });
        }
      } else if (result.errors.length > 0) {
        // Runtime failed — try static regex fallback only for HTTP-only files.
        // Static extractor only understands contract.http syntax.
        // If the file contains ANY non-HTTP protocol usage (grpc, graphql, register, etc.),
        // fail closed for the entire file — partial fallback would silently drop
        // protocol contracts while keeping HTTP ones.
        let fallbackFound = false;
        try {
          const content = await this.fs.readText(filePath);
          const hasHttp = /contract\.http\b/i.test(content);
          // Detect any contract.<protocol> that isn't contract.http or contract.flow
          // This catches grpc, graphql, ws, register, and any custom registered protocol
          const hasNonHttp = /contract\.(?!http\b|flow\b)\w+\s*[.(]/i.test(content);
          // Only fall back if file is HTTP-only (has HTTP, no non-HTTP)
          if (hasHttp && !hasNonHttp) {
            const extracted = extractContractCases(content);
            for (const meta of extracted) {
              contracts.push(meta);
              fallbackFound = true;
            }
          }
        } catch {
          // Static fallback also failed
        }
        // If fallback didn't produce results, surface the import error
        if (!fallbackFound) {
          for (const err of result.errors) {
            warnings.push(`Contract import failed: ${err.file} — ${err.error}`);
          }
        }
      }
    }

    if (Object.keys(files).length === 0 && contracts.length === 0) {
      warnings.push(
        "No Glubean test or contract files found. " +
          "Ensure your files are named *.test.ts or *.contract.ts.",
      );
    }

    return {
      specVersion,
      files,
      testCount,
      fileCount: Object.keys(files).length,
      tags: Array.from(allTags),
      warnings,
      contracts,
    };
  }
}
