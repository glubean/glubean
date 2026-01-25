/**
 * Static analysis parser for Glubean test files.
 *
 * Extracts test metadata (id, name, tags, location, steps) from TypeScript
 * source code using regex patterns. Adapted from @glubean/scanner's
 * extractor-static.ts, extended to support the `test()` API.
 *
 * Supports all Glubean test patterns:
 * - test({ id, name, tags }, fn)       — simple test with object meta
 * - test("id")...                       — builder-style test
 * - test.each(data)("pattern", fn)     — data-driven tests
 * - test.pick(examples)("id", fn)     — example selection (random/pick)
 */

/** Metadata for a discovered test */
export interface TestMeta {
  /** Test type */
  type: "test";
  /** Unique test ID */
  id: string;
  /** Human-readable name */
  name?: string;
  /** Tags for filtering */
  tags?: string[];
  /** JavaScript export name (e.g., "myTest") */
  exportName: string;
  /** Source location (1-based line number) */
  line: number;
  /** Builder steps (for multi-step tests) */
  steps?: string[];
}

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
 * Check if a file's content imports from @glubean/sdk.
 */
export function isGlubeanFile(content: string): boolean {
  return SDK_IMPORT_PATTERNS.some((p) => p.test(content));
}

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

/**
 * Get 1-based line number for a character position in content.
 */
function getLineNumber(content: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < content.length; i++) {
    if (content[i] === "\n") {
      line++;
    }
  }
  return line;
}

/**
 * Extract basic metadata (id, name, tags) from a metadata object string.
 * e.g. from `{ id: "foo", name: "Foo Test", tags: ["smoke"] }`
 */
function extractBasicMeta(metaStr: string): {
  id?: string;
  name?: string;
  tags?: string[];
} {
  const idMatch = metaStr.match(/id\s*:\s*["']([^"']+)["']/);
  const nameMatch = metaStr.match(/name\s*:\s*["']([^"']+)["']/);
  const tagsMatch = metaStr.match(/tags\s*:\s*\[([^\]]*)\]/);

  let tags: string[] | undefined;
  if (tagsMatch) {
    tags = tagsMatch[1]
      .split(",")
      .map((t) => t.trim().replace(/["']/g, ""))
      .filter((t) => t.length > 0);
  }

  return {
    id: idMatch ? idMatch[1] : undefined,
    name: nameMatch ? nameMatch[1] : undefined,
    tags,
  };
}

/**
 * Extract step names from a builder chain.
 * Looks for .step("name", ...) calls after the test() call.
 */
function extractSteps(content: string, startPos: number): string[] {
  const steps: string[] = [];
  // Search the next ~3000 characters for .step() calls
  const searchContent = content.slice(startPos, startPos + 3000);
  const stepPattern = /\.step\s*\(\s*["']([^"']+)["']/g;
  let match;
  while ((match = stepPattern.exec(searchContent)) !== null) {
    steps.push(match[1]);
  }
  return steps;
}

/**
 * Extract .meta({ name, tags }) from a builder chain.
 */
function extractBuilderMeta(
  content: string,
  startPos: number
): { name?: string; tags?: string[] } {
  const searchContent = content.slice(startPos, startPos + 500);
  const metaMatch = searchContent.match(/\.meta\s*\(\s*\{([^}]+)\}/);
  if (metaMatch) {
    const meta = extractBasicMeta(metaMatch[1]);
    return { name: meta.name, tags: meta.tags };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------

/**
 * Extract all test metadata from a Glubean test file's source content.
 *
 * This is a pure function — no file system or runtime needed.
 *
 * @param content - TypeScript source code
 * @returns Array of discovered test metadata, or empty array if not a Glubean file
 */
export function extractTests(content: string): TestMeta[] {
  // Guard: only parse files that import from @glubean/sdk
  if (!isGlubeanFile(content)) {
    return [];
  }

  const tests: TestMeta[] = [];
  const processedIds = new Set<string>();

  // ── test() with object metadata ─────────────────────────────────────────
  // Matches: export const name = test({ id: "...", ... }, async (ctx) => ...)
  // Also matches: export const name = test(\n  { id: "...", ... },\n  async (ctx) => ...)
  const testObjPattern =
    /export\s+const\s+(\w+)\s*=\s*test\s*\(\s*\{([\s\S]*?)\}\s*,/g;

  let match: RegExpExecArray | null;
  while ((match = testObjPattern.exec(content)) !== null) {
    const exportName = match[1];
    const metaStr = match[2];
    const meta = extractBasicMeta(metaStr);
    const id = meta.id || exportName;

    if (!processedIds.has(id)) {
      processedIds.add(id);
      tests.push({
        type: "test",
        id,
        name: meta.name || id,
        tags: meta.tags,
        exportName,
        line: getLineNumber(content, match.index),
      });
    }
  }

  // ── test() with string ID (builder pattern) ────────────────────────────
  // Matches: export const name = test("some-id")
  // Followed by optional .meta(...).step(...)
  const testStrPattern =
    /export\s+const\s+(\w+)\s*=\s*test\s*\(\s*["']([^"']+)["']\s*\)/g;

  while ((match = testStrPattern.exec(content)) !== null) {
    const exportName = match[1];
    const id = match[2];

    if (!processedIds.has(id)) {
      processedIds.add(id);
      const builderMeta = extractBuilderMeta(content, match.index);
      const steps = extractSteps(content, match.index);
      tests.push({
        type: "test",
        id,
        name: builderMeta.name || id,
        tags: builderMeta.tags,
        exportName,
        line: getLineNumber(content, match.index),
        steps: steps.length > 0 ? steps : undefined,
      });
    }
  }

  // ── test.each() ─────────────────────────────────────────────────────────
  // Matches: export const name = test.each(...)("pattern-$id", fn)
  // We can't resolve the actual generated IDs statically, but we can show
  // the pattern as a single group node.
  const testEachPattern =
    /export\s+const\s+(\w+)\s*=\s*test\.each\s*\([^)]*\)\s*\(\s*["']([^"']+)["']/g;

  while ((match = testEachPattern.exec(content)) !== null) {
    const exportName = match[1];
    const pattern = match[2];
    const id = `each:${pattern}`;

    if (!processedIds.has(id)) {
      processedIds.add(id);
      tests.push({
        type: "test",
        id,
        name: `${pattern} (data-driven)`,
        exportName,
        line: getLineNumber(content, match.index),
      });
    }
  }

  // ── test.pick() ──────────────────────────────────────────────────────────
  // Matches: export const name = test.pick(...)("pattern-$_pick", fn)
  // Similar to test.each but uses pick() for example selection.
  const testPickPattern =
    /export\s+const\s+(\w+)\s*=\s*test\.pick\s*\([^)]*\)\s*\(\s*["']([^"']+)["']/g;

  while ((match = testPickPattern.exec(content)) !== null) {
    const exportName = match[1];
    const pattern = match[2];
    const id = `pick:${pattern}`;

    if (!processedIds.has(id)) {
      processedIds.add(id);
      tests.push({
        type: "test",
        id,
        name: `${pattern} (pick)`,
        exportName,
        line: getLineNumber(content, match.index),
      });
    }
  }

  return tests;
}

// ---------------------------------------------------------------------------
// test.pick example extraction (for CodeLens)
// ---------------------------------------------------------------------------

/** Metadata for a discovered test.pick() call, used by CodeLens. */
export interface PickMeta {
  /** The test ID template (e.g. "create-user-$_pick") */
  testId: string;
  /** Source location (1-based line number) */
  line: number;
  /** Export name of the variable */
  exportName: string;
  /**
   * Statically resolved example keys, or null if keys could not be determined.
   * null means CodeLens should show a format hint instead of run buttons.
   */
  keys: string[] | null;
  /**
   * How the data was sourced — helps CodeLens resolve keys at render time.
   * - "inline": keys extracted directly from object literal in source
   * - "json-import": keys come from an imported JSON file (path provided)
   */
  dataSource?: { type: "inline" } | { type: "json-import"; path: string };
}

/**
 * Extract test.pick() metadata from a Glubean test file for CodeLens rendering.
 *
 * Handles two data source patterns:
 * 1. Inline object literal: `test.pick({ "key1": ..., "key2": ... })`
 * 2. JSON import variable: `import X from "./data.json"` then `test.pick(X)`
 *
 * For other patterns (dynamic vars, fromYaml, etc.), returns keys: null
 * so CodeLens can show a format hint.
 *
 * @param content - TypeScript source code
 * @returns Array of PickMeta, or empty if no test.pick calls found
 */
export function extractPickExamples(content: string): PickMeta[] {
  if (!isGlubeanFile(content)) {
    return [];
  }

  const results: PickMeta[] = [];

  // Build a map of JSON imports: variable name → file path
  // Matches: import X from "./path.json" with { type: "json" }
  // Also matches: import X from "./path.json" assert { type: "json" }
  // Also matches: import X from "./path.json" (bare, Deno supports it)
  const jsonImports = new Map<string, string>();
  const importPattern =
    /import\s+(\w+)\s+from\s+["']([^"']+\.json)["']/g;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = importPattern.exec(content)) !== null) {
    jsonImports.set(importMatch[1], importMatch[2]);
  }

  // ── Pattern 1: Inline object literal ────────────────────────────────────
  // Matches: test.pick({ "key1": ..., "key2": ... })("id-$_pick", ...)
  // We look for test.pick(\s*{ and try to extract top-level string keys.
  const inlinePickPattern =
    /export\s+const\s+(\w+)\s*=\s*test\.pick\s*\(\s*\{([\s\S]*?)\}\s*\)\s*\(\s*["']([^"']+)["']/g;

  let match: RegExpExecArray | null;
  while ((match = inlinePickPattern.exec(content)) !== null) {
    const exportName = match[1];
    const objectBody = match[2];
    const testId = match[3];
    const line = getLineNumber(content, match.index);

    // Extract only top-level keys from the object body.
    // We track brace depth to skip nested object keys like { q: ..., body: { name: ... } }.
    // Only keys at depth 0 (the outer test.pick object) are example names.
    const keys: string[] = [];
    let depth = 0;
    // Scan character by character, extracting keys only at depth 0
    for (let i = 0; i < objectBody.length; i++) {
      const ch = objectBody[i];
      if (ch === "{" || ch === "[") {
        depth++;
      } else if (ch === "}" || ch === "]") {
        depth--;
      } else if (depth === 0) {
        // Try to match a key at this position: "key": or 'key': or key:
        const remaining = objectBody.slice(i);
        const keyMatch = remaining.match(
          /^(?:["']([^"']+)["']|([a-zA-Z_]\w*))\s*:/
        );
        if (keyMatch) {
          keys.push(keyMatch[1] || keyMatch[2]);
          // Skip past this key match to avoid re-matching
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

  // ── Pattern 2: Variable reference (JSON import or other) ────────────────
  // Matches: test.pick(variableName)("id-$_pick", ...)
  // Must NOT match the inline pattern (which has { after test.pick( )
  const varPickPattern =
    /export\s+const\s+(\w+)\s*=\s*test\.pick\s*\(\s*(\w+)\s*\)\s*\(\s*["']([^"']+)["']/g;

  while ((match = varPickPattern.exec(content)) !== null) {
    const exportName = match[1];
    const varName = match[2];
    const testId = match[3];
    const line = getLineNumber(content, match.index);

    // Check if the variable is a JSON import
    const jsonPath = jsonImports.get(varName);
    if (jsonPath) {
      // Keys will be resolved at CodeLens render time by reading the file
      results.push({
        testId,
        line,
        exportName,
        keys: null, // resolved lazily by CodeLens provider via fs
        dataSource: { type: "json-import", path: jsonPath },
      });
    } else {
      // Unknown variable — cannot resolve statically
      results.push({
        testId,
        line,
        exportName,
        keys: null,
        dataSource: undefined,
      });
    }
  }

  return results;
}
