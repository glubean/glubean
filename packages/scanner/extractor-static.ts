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
 *
 * **Limitations:**
 * - Template variables (`$id`, `$_pick`) in IDs are preserved as-is, not resolved.
 * - Dynamically computed IDs or tags are not detected.
 * - `test.each()` / `test.pick()` produce one ExportMeta with the template ID,
 *   not one per data row (row count is unknown statically).
 * - Deeply nested or multi-line object literals with complex expressions may
 *   not be fully parsed.
 */

import type { ExportMeta } from "./types.ts";

// ---------------------------------------------------------------------------
// SDK import detection
// ---------------------------------------------------------------------------

const SDK_IMPORT_PATTERNS = [
  // jsr:@glubean/sdk or jsr:@glubean/sdk@0.5.0 (with optional version)
  /import\s+.*from\s+["']jsr:@glubean\/sdk(?:@[^"']*)?["']/,
  // @glubean/sdk (bare specifier via import map)
  /import\s+.*from\s+["']@glubean\/sdk(?:\/[^"']*)?["']/,
];

/**
 * Check if a file's content imports from `@glubean/sdk`.
 *
 * Useful as a fast guard before running the more expensive `extractFromSource`.
 * Detects both JSR (`jsr:@glubean/sdk`) and bare specifier (`@glubean/sdk`)
 * import forms.
 *
 * @param content - TypeScript source code
 * @returns `true` if the source imports from `@glubean/sdk`
 *
 * @example
 * ```ts
 * const code = await Deno.readTextFile("tests/api.test.ts");
 * if (isGlubeanFile(code)) {
 *   const tests = extractFromSource(code);
 * }
 * ```
 */
export function isGlubeanFile(content: string): boolean {
  return SDK_IMPORT_PATTERNS.some((p) => p.test(content));
}

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

/**
 * Remove comments from source while preserving line positions.
 * Block comments are replaced with spaces (newlines kept); line comments are
 * replaced with spaces up to the newline. String literals are skipped so that
 * `//` or `/*` inside strings are not treated as comments.
 */
function stripComments(source: string): string {
  let result = "";
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source[i];

    // String literals — pass through unchanged
    if (ch === '"' || ch === "'") {
      const quote = ch;
      result += source[i++];
      while (i < len && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < len) result += source[i++];
        if (i < len) result += source[i++];
      }
      if (i < len) result += source[i++]; // closing quote
      continue;
    }

    // Template literal — simplified (no nested template tracking)
    if (ch === "`") {
      result += source[i++];
      while (i < len && source[i] !== "`") {
        if (source[i] === "\\" && i + 1 < len) result += source[i++];
        if (i < len) result += source[i++];
      }
      if (i < len) result += source[i++]; // closing backtick
      continue;
    }

    // Block comment — replace with spaces, keep newlines for line numbers
    if (ch === "/" && i + 1 < len && source[i + 1] === "*") {
      i += 2;
      result += "  ";
      while (i < len && !(source[i] === "*" && i + 1 < len && source[i + 1] === "/")) {
        result += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < len) {
        result += "  ";
        i += 2;
      }
      continue;
    }

    // Line comment — replace with spaces until newline
    if (ch === "/" && i + 1 < len && source[i + 1] === "/") {
      i += 2;
      while (i < len && source[i] !== "\n") {
        result += " ";
        i++;
      }
      continue;
    }

    result += source[i++];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Count newlines before `offset` to compute 1-based line number. */
function getLineNumber(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

/**
 * Find the index of the matching closing bracket starting from `startIndex`
 * (which must point to the opening bracket). Respects string boundaries.
 * Returns -1 if no match is found.
 */
function findMatching(source: string, startIndex: number, open: string, close: string): number {
  let depth = 0;
  let inString = false;
  let stringChar = "";

  for (let i = startIndex; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (ch === "\\" && i + 1 < source.length) {
        i++; // skip escaped char
        continue;
      }
      if (ch === stringChar) inString = false;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

/** Shorthand: find closing `)` for an opening `(`. */
function findCloseParen(source: string, openIndex: number): number {
  return findMatching(source, openIndex, "(", ")");
}

/** Shorthand: find closing `}` for an opening `{`. */
function findCloseBrace(source: string, openIndex: number): number {
  return findMatching(source, openIndex, "{", "}");
}

// ---------------------------------------------------------------------------
// Metadata extraction from object literals
// ---------------------------------------------------------------------------

/**
 * Parse `id`, `name`, and `tags` from a TestMeta-like object literal string.
 * Handles both `tags: ["a", "b"]` and `tags: "a"` forms, with single or double quotes.
 */
function parseMetaObject(source: string): { id?: string; name?: string; tags?: string[] } {
  const result: { id?: string; name?: string; tags?: string[] } = {};

  const idMatch = source.match(/id:\s*(['"])([^'"]+)\1/);
  if (idMatch) result.id = idMatch[2];

  const nameMatch = source.match(/name:\s*(['"])([^'"]+)\1/);
  if (nameMatch) result.name = nameMatch[2];

  // Tags as array: tags: ["smoke", "auth"] or tags: ['smoke', 'auth']
  const tagsArrayMatch = source.match(/tags:\s*\[([^\]]*)\]/);
  if (tagsArrayMatch) {
    result.tags = [...tagsArrayMatch[1].matchAll(/(['"])([^'"]+)\1/g)].map((m) => m[2]);
  } else {
    // Tags as single string: tags: "smoke" or tags: 'smoke'
    const tagsStringMatch = source.match(/tags:\s*(['"])([^'"]+)\1/);
    if (tagsStringMatch) result.tags = [tagsStringMatch[2]];
  }

  return result;
}

/**
 * Extract `name` and `tags` from a `.meta({...})` builder call within `scope`.
 */
function extractBuilderMeta(scope: string): { name?: string; tags?: string[] } {
  const match = scope.match(/\.meta\(\s*\{/);
  if (!match || match.index === undefined) return {};
  const braceStart = scope.indexOf("{", match.index);
  const braceEnd = findCloseBrace(scope, braceStart);
  if (braceEnd === -1) return {};
  const obj = scope.substring(braceStart, braceEnd + 1);
  const parsed = parseMetaObject(obj);
  return { name: parsed.name, tags: parsed.tags };
}

/**
 * Extract step names from `.step("name", ...)` or `.step('name', ...)` chains within `scope`.
 */
function extractSteps(scope: string): { name: string }[] {
  const steps: { name: string }[] = [];
  const stepPattern = /\.step\(\s*(['"])([^'"]+)\1/g;
  let m;
  while ((m = stepPattern.exec(scope)) !== null) {
    steps.push({ name: m[2] });
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Declaration parser
// ---------------------------------------------------------------------------

/**
 * Parse a single test declaration from the text that follows `test` in
 * `export const NAME = test<scope>`. Returns null if the pattern is not
 * recognized.
 */
function parseTestDeclaration(
  scope: string,
  exportName: string,
  line: number,
): ExportMeta | null {
  let rest = scope;
  let variant: "each" | "pick" | undefined;

  // Check for .each() or .pick() — may appear on same line or next line
  const dataMatch = rest.match(/^\s*\.\s*(each|pick)\s*\(/);
  if (dataMatch) {
    variant = dataMatch[1] as "each" | "pick";
    const openIndex = rest.indexOf("(", dataMatch.index!);
    const closeIndex = findCloseParen(rest, openIndex);
    if (closeIndex === -1) return null;
    rest = rest.substring(closeIndex + 1);
  }

  // Expect opening paren of the test call: test( or test.each(...)( or <generic>test<T>(
  const callMatch = rest.match(/^\s*(?:<[^>]*>)?\s*\(/);
  if (!callMatch) return null;
  const callOpenIndex = rest.indexOf("(", callMatch.index!);

  const afterOpen = rest.substring(callOpenIndex + 1).trimStart();

  let id: string | undefined;
  let name: string | undefined;
  let tags: string[] | undefined;

  if (afterOpen.startsWith('"') || afterOpen.startsWith("'")) {
    // String ID
    const quote = afterOpen[0];
    const endQuote = afterOpen.indexOf(quote, 1);
    if (endQuote === -1) return null;
    id = afterOpen.substring(1, endQuote);
  } else if (afterOpen.startsWith("{")) {
    // TestMeta object
    const braceEnd = findCloseBrace(afterOpen, 0);
    if (braceEnd === -1) return null;
    const objStr = afterOpen.substring(0, braceEnd + 1);
    const parsed = parseMetaObject(objStr);
    id = parsed.id;
    name = parsed.name;
    tags = parsed.tags;
  }

  if (!id) return null;

  // Extract builder .meta({...}) from the full scope
  const builderMeta = extractBuilderMeta(scope);
  if (!name && builderMeta.name) name = builderMeta.name;
  if (!tags && builderMeta.tags) tags = builderMeta.tags;

  // Extract .step("name", ...) chains from the full scope
  const steps = extractSteps(scope);

  const result: ExportMeta = {
    type: "test",
    id,
    exportName,
    location: { line, col: 1 },
  };

  if (name) result.name = name;
  if (tags && tags.length > 0) result.tags = tags;
  if (variant) result.variant = variant;
  if (steps.length > 0) result.steps = steps;

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract test metadata from TypeScript source using static analysis (regex).
 *
 * Recognizes the following patterns:
 * - `export const x = test("id", fn)` — simple test with string ID
 * - `export const x = test({ id, name, tags }, fn)` — simple test with meta
 * - `export const x = test("id").step(...)` — builder with steps
 * - `export const x = test.each(data)("id-$key", fn)` — data-driven
 * - `export const x = test.pick(examples)("id-$_pick", fn)` — example selection
 *
 * This is a pure function — no file system or runtime access needed.
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
export function extractFromSource(content: string): ExportMeta[] {
  const results: ExportMeta[] = [];
  const stripped = stripComments(content);

  // Collect all `export const NAME = test` positions
  const exportPattern = /export\s+const\s+(\w+)\s*=\s*test/g;
  const matches: { exportName: string; offset: number; afterTest: number }[] = [];

  let m;
  while ((m = exportPattern.exec(stripped)) !== null) {
    matches.push({
      exportName: m[1],
      offset: m.index,
      afterTest: m.index + m[0].length,
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const { exportName, offset, afterTest } = matches[i];
    // Scope from right after "test" to the start of the next export (or EOF)
    const endOffset = i + 1 < matches.length ? matches[i + 1].offset : stripped.length;
    const scope = stripped.substring(afterTest, endOffset);
    const line = getLineNumber(stripped, offset);

    const meta = parseTestDeclaration(scope, exportName, line);
    if (meta) results.push(meta);
  }

  return results;
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
