/**
 * Pure static analysis entry point for Glubean test files.
 *
 * This module re-exports the pure regex-based extractor and SDK import
 * detection utilities. It has **no runtime dependencies** — no file system
 * access — making it safe to consume from constrained environments
 * such as the VSCode extension.
 *
 * @example
 * ```ts
 * import { extractFromSource, isGlubeanFile } from "@glubean/scanner/static";
 *
 * const code = await fs.readFile("tests/api.test.ts", "utf-8");
 * if (isGlubeanFile(code)) {
 *   const tests = extractFromSource(code);
 *   console.log(`Found ${tests.length} tests`);
 * }
 * ```
 *
 * @module static
 */

export {
  createStaticExtractor,
  extractAliasesFromSource,
  extractContractCases,
  extractFromSource,
  extractPickExamples,
  isGlubeanFile,
} from "./extractor-static.js";

export type { ExportMeta } from "./types.js";
export type { ContractCaseStaticMeta, ContractStaticMeta, PickMeta } from "./extractor-static.js";
