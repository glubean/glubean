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

// The expression-parsing extractors are AST-based (@babel/parser):
// extractFromSource + createStaticExtractor + extractContractCases +
// extractPickExamples. isGlubeanFile + extractAliasesFromSource stay regex (cheap
// guards run over all files; simple import/decl patterns, no TS-expression parsing).
export {
  createStaticExtractor,
  extractFromSource,
  extractContractCases,
  extractPickExamples,
  extractFlows,
} from "./extractor-ast.js";
export { extractAliasesFromSource, isGlubeanFile } from "./extractor-static.js";

export type { ExportMeta } from "./types.js";
export type {
  ContractCaseStaticMeta,
  ContractStaticMeta,
  FlowStaticMeta,
  PickMeta,
} from "./extractor-static.js";
