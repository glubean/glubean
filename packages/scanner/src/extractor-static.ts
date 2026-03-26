/**
 * Static analysis extractor for Glubean test files.
 *
 * Uses regex patterns to extract test metadata WITHOUT importing files.
 * This is useful for:
 * - Build systems that scan code without execution
 * - CI/CD pipelines
 * - IDE extensions (VSCode)
 *
 * Note: Static analysis may miss dynamically computed metadata.
 *
 * **Limitations:**
 * - Template variables (`$id`, `$_pick`) in IDs are preserved as-is, not resolved.
 * - Dynamically computed IDs or tags are not detected.
 * - `test.each()` / `test.pick()` produce one ExportMeta with the template ID,
 *   not one per data row (row count is unknown statically).
 * - Deeply nested or multi-line object literals with complex expressions may
 *   not be fully parsed.
 */

import { resolveDataPath } from "./data-path.js";
import type { ExportMeta } from "./types.js";

// ---------------------------------------------------------------------------
// SDK import detection
// ---------------------------------------------------------------------------

/** Base function names that are always recognized. */
const BASE_FNS = ["test", "task"];

/** Direct SDK module import patterns. */
const SDK_MODULE_PATTERNS = [
  // jsr:@glubean/sdk or jsr:@glubean/sdk@0.5.0 (with optional version)
  /import\s+.*from\s+["']jsr:@glubean\/sdk(?:@[^"']*)?["']/,
  // @glubean/sdk (bare specifier via import map or package.json)
  /import\s+.*from\s+["']@glubean\/sdk(?:\/[^"']*)?["']/,
];

/** Escape special regex chars in a string. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a regex alternation from function names: `"test|task|browserTest"`.
 * When no custom names are provided, falls back to a convention pattern
 * that matches `test`, `task`, `*Test`, and `*Task`.
 */
function buildFnAlternation(customFns?: string[]): string {
  if (customFns && customFns.length > 0) {
    const all = [...new Set([...BASE_FNS, ...customFns])];
    return all.map(escapeRegExp).join("|");
  }
  // Convention fallback: test | task | *Test | *Task
  return "\\w*(?:Test|Task)|test|task";
}

/**
 * Check if a file's content looks like a Glubean test/task file.
 *
 * Useful as a fast guard before running the more expensive `extractFromSource`.
 *
 * Detection layers (any match → true):
 * 1. Direct SDK module import (`jsr:@glubean/sdk`, `@glubean/sdk`)
 * 2. Named import of a known function name (auto-detected aliases or convention)
 *
 * @param content - TypeScript source code
 * @param customFns - Additional function names discovered via `extractAliasesFromSource`.
 *                    When provided, these are checked in imports alongside the base names.
 *                    When omitted, falls back to `*Test` / `*Task` convention matching.
 * @returns `true` if the source looks like a Glubean file
 */
export function isGlubeanFile(content: string, customFns?: string[]): boolean {
  // Layer 1: Direct SDK module import
  if (SDK_MODULE_PATTERNS.some((p) => p.test(content))) return true;

  // Layer 2: Named import of a known function name
  const alt = buildFnAlternation(customFns);
  const importPattern = new RegExp(
    `import\\s+.*\\{[^}]*\\b(${alt})\\b[^}]*\\}`,
  );
  return importPattern.test(content);
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
 * Parse `id`, `name`, `tags`, and `timeout` from a TestMeta-like object literal string.
 * Handles both `tags: ["a", "b"]` and `tags: "a"` forms, with single or double quotes.
 */
function parseMetaObject(
  source: string,
): { id?: string; name?: string; tags?: string[]; timeout?: number } {
  const result: { id?: string; name?: string; tags?: string[]; timeout?: number } = {};

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

  const timeoutMatch = source.match(/timeout:\s*(\d+)/);
  if (timeoutMatch) result.timeout = Number(timeoutMatch[1]);

  return result;
}

/**
 * Extract `name` and `tags` from a `.meta({...})` builder call within `scope`.
 */
function extractBuilderMeta(
  scope: string,
): { name?: string; tags?: string[]; timeout?: number } {
  const match = scope.match(/\.meta\(\s*\{/);
  if (!match || match.index === undefined) return {};
  const braceStart = scope.indexOf("{", match.index);
  const braceEnd = findCloseBrace(scope, braceStart);
  if (braceEnd === -1) return {};
  const obj = scope.substring(braceStart, braceEnd + 1);
  return parseMetaObject(obj);
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
  let parallel = false;
  const dataMatch = rest.match(/^\s*\.\s*(each|pick)\s*\(/);
  if (dataMatch) {
    variant = dataMatch[1] as "each" | "pick";
    const openIndex = rest.indexOf("(", dataMatch.index!);
    const closeIndex = findCloseParen(rest, openIndex);
    if (closeIndex === -1) return null;
    // Check for { parallel: true } in .each() args
    if (variant === "each") {
      const eachArgs = rest.substring(openIndex + 1, closeIndex);
      if (/parallel\s*:\s*true/.test(eachArgs)) {
        parallel = true;
      }
    }
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
  let timeout: number | undefined;

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
    timeout = parsed.timeout;
  }

  if (!id) return null;

  // Extract builder .meta({...}) from the full scope
  const builderMeta = extractBuilderMeta(scope);
  if (!name && builderMeta.name) name = builderMeta.name;
  if (!tags && builderMeta.tags) tags = builderMeta.tags;
  if (timeout === undefined && builderMeta.timeout !== undefined) {
    timeout = builderMeta.timeout;
  }

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
  if (timeout !== undefined) result.timeout = timeout;
  if (variant) result.variant = variant;
  if (steps.length > 0) result.steps = steps;
  if (parallel) result.parallel = true;

  return result;
}

// ---------------------------------------------------------------------------
// Alias discovery (auto-detect test.extend / task.extend)
// ---------------------------------------------------------------------------

/**
 * Extract custom function names created by `.extend()` calls.
 *
 * Scans source for patterns like:
 * - `const browserTest = test.extend({...})`
 * - `export const screenshotTest = browserTest.extend({...})`
 *
 * Returns the variable names (e.g. `["browserTest", "screenshotTest"]`).
 * These can then be passed to `extractFromSource()` and `isGlubeanFile()`
 * so they recognize `export const x = browserTest(...)` in other files.
 *
 * @param content - TypeScript source code
 * @returns Array of discovered alias names
 */
export function extractAliasesFromSource(content: string): string[] {
  const stripped = stripComments(content);
  // Match: [export] const NAME = SOMETHING.extend(
  const pattern = /(?:export\s+)?const\s+(\w+)\s*=\s*\w+\.extend\s*\(/g;
  const aliases: string[] = [];
  let m;
  while ((m = pattern.exec(stripped)) !== null) {
    aliases.push(m[1]);
  }
  return aliases;
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
 * @param customFns - Additional function names discovered via `extractAliasesFromSource`.
 *                    When provided, these names are matched alongside `test` and `task`.
 *                    When omitted, falls back to `*Test` / `*Task` convention matching.
 * @returns Array of extracted export metadata
 */
export function extractFromSource(content: string, customFns?: string[]): ExportMeta[] {
  const results: ExportMeta[] = [];
  const stripped = stripComments(content);

  // Build the function-name alternation — either explicit aliases or convention fallback
  const alt = buildFnAlternation(customFns);
  const exportPattern = new RegExp(
    `export\\s+const\\s+(\\w+)\\s*=\\s*(${alt})\\b`,
    "g",
  );

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
    // Scope from right after the function name to the start of the next export (or EOF)
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
 * Aliases can be supplied at two levels:
 * - `customFns` (construction-time): baked-in aliases known upfront.
 * - `runtimeFns` (call-time): aliases discovered during a Scanner two-phase
 *   scan. These are merged with `customFns` so the extractor benefits from
 *   aliases discovered after construction.
 *
 * @param readFile - Function to read file content as string
 * @param customFns - Additional function names (from alias discovery)
 * @returns MetadataExtractor function
 */
export function createStaticExtractor(
  readFile: (path: string) => Promise<string>,
  customFns?: string[],
): (filePath: string, runtimeFns?: string[]) => Promise<ExportMeta[]> {
  return async (filePath: string, runtimeFns?: string[]): Promise<ExportMeta[]> => {
    const content = await readFile(filePath);
    // Merge construction-time and call-time aliases
    const merged = customFns || runtimeFns ? [...new Set([...(customFns ?? []), ...(runtimeFns ?? [])])] : undefined;
    return extractFromSource(content, merged);
  };
}

// ---------------------------------------------------------------------------
// test.pick() example extraction (for CodeLens and other consumers)
// ---------------------------------------------------------------------------

/** Metadata for a discovered test.pick() call. */
export interface PickMeta {
  /** The test ID template (e.g. "create-user-$_pick") */
  testId: string;
  /** Source location (1-based line number) */
  line: number;
  /** Export name of the variable */
  exportName: string;
  /**
   * Statically resolved example keys, or null if keys could not be determined.
   * null means the consumer should show a format hint instead of run buttons.
   */
  keys: string[] | null;
  /**
   * How the data was sourced — helps consumers resolve keys at render time.
   * - "inline": keys extracted directly from object literal in source
   * - "json-import": keys come from an imported JSON file (path provided)
   * - "dir-merge": keys come from all JSON files in a directory, merged
   * - "dir": keys come from files in a directory (one file = one row)
   * - "dir-concat": keys come from arrays concatenated from files in a directory
   */
  dataSource?:
    | { type: "inline" }
    | { type: "json-import"; path: string }
    | { type: "dir-merge"; path: string }
    | { type: "dir"; path: string }
    | { type: "dir-concat"; path: string }
    | { type: "yaml-map"; path: string }
    | { type: "json-loader"; path: string }
    | { type: "json-map"; path: string };
}

/**
 * Extract test.pick() metadata from TypeScript source for CodeLens rendering.
 *
 * Handles data source patterns:
 * 1. Inline object literal: `test.pick({ "key1": ..., "key2": ... })`
 * 2. JSON import variable: `import X from "./data.json"` then `test.pick(X)`
 * 3. fromDir.merge variable: `const X = await fromDir.merge("./dir/")` then `test.pick(X)`
 * 4. fromDir variable: `const X = await fromDir("./dir/")` then `test.pick(X)`
 * 5. fromDir.concat variable: `const X = await fromDir.concat("./dir/")` then `test.pick(X)`
 * 6. fromYaml.map variable: `const X = await fromYaml.map("./file.yaml")` then `test.pick(X)`
 * 7. fromJson variable: `const X = await fromJson("./file.json")` then `test.each(X)`
 * 8. fromJson.map variable: `const X = await fromJson.map("./file.json")` then `test.pick(X)`
 *
 * For other patterns (dynamic vars, etc.), returns keys: null.
 *
 * @param content - TypeScript source code
 * @param options - Optional settings
 * @param options.customFns - Additional function names discovered via alias scanning.
 * @param options.filePath - Source file path. When provided, file-relative
 *                           paths are resolved against this file's directory.
 * @param options.projectRoot - Project root. When provided, bare paths are
 *                              resolved against the project root instead of
 *                              the source file directory.
 * @returns Array of PickMeta, or empty if no test.pick calls found
 */
export function extractPickExamples(
  content: string,
  options?: { customFns?: string[]; filePath?: string; projectRoot?: string },
): PickMeta[] {
  const customFns = options?.customFns;
  const filePath = options?.filePath;
  const projectRoot = options?.projectRoot;
  const results: PickMeta[] = [];

  // Build function-name alternation for pick patterns
  const fnAlt = customFns && customFns.length > 0
    ? [...new Set(["test", "task", ...customFns])].map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
    : "\\w*(?:Test|Task)|test|task";

  // Build a map of JSON imports: variable name → file path
  const jsonImports = new Map<string, string>();
  const importPattern = /import\s+(\w+)\s+from\s+["']([^"']+\.json)["']/g;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = importPattern.exec(content)) !== null) {
    jsonImports.set(importMatch[1], importMatch[2]);
  }

  // Build a map of fromDir.merge assignments: variable name → directory path
  const dirMergeSources = new Map<string, string>();
  const dirMergePattern =
    /(?:const|let)\s+(\w+)\s*=\s*await\s+fromDir\.merge\s*(?:<[^>]*>)?\s*\(\s*["']([^"']+)["']/g;
  let dirMergeMatch: RegExpExecArray | null;
  while ((dirMergeMatch = dirMergePattern.exec(content)) !== null) {
    dirMergeSources.set(dirMergeMatch[1], dirMergeMatch[2]);
  }

  // Build a map of fromDir assignments: variable name → directory path
  const dirSources = new Map<string, string>();
  const dirPattern =
    /(?:const|let)\s+(\w+)\s*=\s*await\s+fromDir\s*(?:<[^>]*>)?\s*\(\s*["']([^"']+)["']/g;
  let dirMatch: RegExpExecArray | null;
  while ((dirMatch = dirPattern.exec(content)) !== null) {
    // Exclude fromDir.merge and fromDir.concat which are already matched
    const fullMatch = dirMatch[0];
    if (!fullMatch.includes("fromDir.merge") && !fullMatch.includes("fromDir.concat")) {
      dirSources.set(dirMatch[1], dirMatch[2]);
    }
  }

  // Build a map of fromDir.concat assignments: variable name → directory path
  const dirConcatSources = new Map<string, string>();
  const dirConcatPattern =
    /(?:const|let)\s+(\w+)\s*=\s*await\s+fromDir\.concat\s*(?:<[^>]*>)?\s*\(\s*["']([^"']+)["']/g;
  let dirConcatMatch: RegExpExecArray | null;
  while ((dirConcatMatch = dirConcatPattern.exec(content)) !== null) {
    dirConcatSources.set(dirConcatMatch[1], dirConcatMatch[2]);
  }

  // Build a map of fromYaml.map assignments: variable name → file path
  const yamlMapSources = new Map<string, string>();
  const yamlMapPattern =
    /(?:const|let)\s+(\w+)\s*=\s*await\s+fromYaml\.map\s*(?:<[^>]*>)?\s*\(\s*["']([^"']+)["']/g;
  let yamlMapMatch: RegExpExecArray | null;
  while ((yamlMapMatch = yamlMapPattern.exec(content)) !== null) {
    yamlMapSources.set(yamlMapMatch[1], yamlMapMatch[2]);
  }

  // Build a map of fromJson assignments: variable name → file path
  const jsonLoaderSources = new Map<string, string>();
  const jsonLoaderPattern =
    /(?:const|let)\s+(\w+)\s*=\s*await\s+fromJson\s*(?:<[^>]*>)?\s*\(\s*["']([^"']+)["']/g;
  let jsonLoaderMatch: RegExpExecArray | null;
  while ((jsonLoaderMatch = jsonLoaderPattern.exec(content)) !== null) {
    // Exclude fromJson.map which is matched separately
    if (!jsonLoaderMatch[0].includes("fromJson.map")) {
      jsonLoaderSources.set(jsonLoaderMatch[1], jsonLoaderMatch[2]);
    }
  }

  // Build a map of fromJson.map assignments: variable name → file path
  const jsonMapSources = new Map<string, string>();
  const jsonMapPattern =
    /(?:const|let)\s+(\w+)\s*=\s*await\s+fromJson\.map\s*(?:<[^>]*>)?\s*\(\s*["']([^"']+)["']/g;
  let jsonMapMatch: RegExpExecArray | null;
  while ((jsonMapMatch = jsonMapPattern.exec(content)) !== null) {
    jsonMapSources.set(jsonMapMatch[1], jsonMapMatch[2]);
  }

  // ── Pattern 1: Inline object literal ────────────────────────────────────
  const inlinePickPattern = new RegExp(
    `export\\s+const\\s+(\\w+)\\s*=\\s*(?:${fnAlt})\\s*\\.pick\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)\\s*\\(\\s*(?:["']([^"']+)["']|\\{\\s*id:\\s*["']([^"']+)["'])`,
    "g",
  );

  let match: RegExpExecArray | null;
  while ((match = inlinePickPattern.exec(content)) !== null) {
    const exportName = match[1];
    const objectBody = match[2];
    const testId = match[3] ?? match[4];
    const line = getLineNumber(content, match.index);

    const keys: string[] = [];
    let depth = 0;
    for (let i = 0; i < objectBody.length; i++) {
      const ch = objectBody[i];
      if (ch === "{" || ch === "[") {
        depth++;
      } else if (ch === "}" || ch === "]") {
        depth--;
      } else if (depth === 0) {
        const remaining = objectBody.slice(i);
        const keyMatch = remaining.match(
          /^(?:["']([^"']+)["']|([a-zA-Z_]\w*))\s*:/,
        );
        if (keyMatch) {
          keys.push(keyMatch[1] || keyMatch[2]);
          i += keyMatch[0].length - 1;
        }
      }
    }

    results.push({
      testId,
      line,
      exportName,
      keys: keys.length > 0 ? keys : null,
      dataSource: keys.length > 0 ? { type: "inline" } : undefined,
    });
  }

  // ── Pattern 2: Variable reference ────────────────────────────────────────
  const varPickPattern = new RegExp(
    `export\\s+const\\s+(\\w+)\\s*=\\s*(?:${fnAlt})\\s*\\.pick\\s*\\(\\s*(\\w+)\\s*\\)\\s*\\(\\s*(?:["']([^"']+)["']|\\{\\s*id:\\s*["']([^"']+)["'])`,
    "g",
  );

  while ((match = varPickPattern.exec(content)) !== null) {
    const exportName = match[1];
    const varName = match[2];
    const testId = match[3] ?? match[4];
    const line = getLineNumber(content, match.index);

    // Check JSON import
    const jsonPath = jsonImports.get(varName);
    if (jsonPath) {
      results.push({
        testId,
        line,
        exportName,
        keys: null,
        dataSource: {
          type: "json-import",
          path: resolveDataPath(jsonPath, {
            filePath,
            projectRoot,
          }).resolvedPath,
        },
      });
      continue;
    }

    // Check fromDir.merge
    const dirMergePath = dirMergeSources.get(varName);
    if (dirMergePath) {
      results.push({
        testId,
        line,
        exportName,
        keys: null,
        dataSource: {
          type: "dir-merge",
          path: resolveDataPath(dirMergePath, {
            filePath,
            projectRoot,
          }).resolvedPath,
        },
      });
      continue;
    }

    // Check fromDir
    const dirPathVal = dirSources.get(varName);
    if (dirPathVal) {
      results.push({
        testId,
        line,
        exportName,
        keys: null,
        dataSource: {
          type: "dir",
          path: resolveDataPath(dirPathVal, {
            filePath,
            projectRoot,
          }).resolvedPath,
        },
      });
      continue;
    }

    // Check fromDir.concat
    const dirConcatPath = dirConcatSources.get(varName);
    if (dirConcatPath) {
      results.push({
        testId,
        line,
        exportName,
        keys: null,
        dataSource: {
          type: "dir-concat",
          path: resolveDataPath(dirConcatPath, {
            filePath,
            projectRoot,
          }).resolvedPath,
        },
      });
      continue;
    }

    // Check fromYaml.map
    const yamlMapPath = yamlMapSources.get(varName);
    if (yamlMapPath) {
      results.push({
        testId,
        line,
        exportName,
        keys: null,
        dataSource: {
          type: "yaml-map",
          path: resolveDataPath(yamlMapPath, {
            filePath,
            projectRoot,
          }).resolvedPath,
        },
      });
      continue;
    }

    // Check fromJson
    const jsonLoaderPath = jsonLoaderSources.get(varName);
    if (jsonLoaderPath) {
      results.push({
        testId,
        line,
        exportName,
        keys: null,
        dataSource: {
          type: "json-loader",
          path: resolveDataPath(jsonLoaderPath, {
            filePath,
            projectRoot,
          }).resolvedPath,
        },
      });
      continue;
    }

    // Check fromJson.map
    const jsonMapPath = jsonMapSources.get(varName);
    if (jsonMapPath) {
      results.push({
        testId,
        line,
        exportName,
        keys: null,
        dataSource: {
          type: "json-map",
          path: resolveDataPath(jsonMapPath, {
            filePath,
            projectRoot,
          }).resolvedPath,
        },
      });
      continue;
    }

    // Unknown variable
    results.push({
      testId,
      line,
      exportName,
      keys: null,
      dataSource: undefined,
    });
  }

  return results;
}
