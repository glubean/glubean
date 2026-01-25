/**
 * Static analysis extractor for Glubean test files.
 *
 * Uses regex patterns to extract test metadata WITHOUT importing files.
 * This is useful for:
 * - Node.js environments (where Deno runtime extraction isn't available)
 * - Build systems that scan code without execution
 * - CI/CD pipelines
 *
 * Note: Static analysis may miss dynamically computed metadata.
 * Runtime extraction (via extractWithDeno) is preferred when possible.
 */

import type { ExportMeta } from "./types.ts";

/**
 * Extract test metadata from TypeScript source using static analysis (regex).
 *
 * This is a pure function that takes source content and returns extracted metadata.
 * No file system or runtime access needed.
 *
 * @param content - TypeScript source code
 * @returns Array of extracted export metadata
 *
 * @example
 * ```ts
 * const content = await fs.readFile("tests/api.test.ts", "utf-8");
 * const exports = extractFromSource(content);
 * console.log(`Found ${exports.length} test exports`);
 * ```
 */
export function extractFromSource(_content: string): ExportMeta[] {
  // Static extraction for the legacy testCase/testSuite API has been removed.
  // The modern test() API uses runtime extraction via extractWithDeno.
  const exports: ExportMeta[] = [];
  return exports;
}

/**
 * Create a static metadata extractor that uses file system to read content.
 *
 * This is a factory function that creates a MetadataExtractor compatible with
 * the Scanner class.
 *
 * @param readFile - Function to read file content as string
 * @returns MetadataExtractor function
 *
 * @example
 * ```ts
 * import * as fs from "node:fs/promises";
 *
 * const extractor = createStaticExtractor(
 *   (path) => fs.readFile(path, "utf-8")
 * );
 *
 * const scanner = new Scanner(nodeFs, nodeHasher, "2.0", extractor);
 * ```
 */
export function createStaticExtractor(
  readFile: (path: string) => Promise<string>,
): (filePath: string) => Promise<ExportMeta[]> {
  return async (filePath: string): Promise<ExportMeta[]> => {
    const content = await readFile(filePath);
    return extractFromSource(content);
  };
}
