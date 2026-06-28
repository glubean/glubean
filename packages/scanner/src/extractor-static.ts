/**
 * Static guards + shared static-metadata types for Glubean scanning.
 *
 * The test/contract/pick EXTRACTORS that used to live here are gone — they are
 * now AST-based (@babel/parser) in `extractor-ast.ts`. What remains are the two
 * cheap regex GUARDS that run over every candidate file in phase 1 (no TS
 * expression parsing, so a parser would only add cost):
 *   - `isGlubeanFile` — does this file import the SDK / a test-like function?
 *   - `extractAliasesFromSource` — `const x = test.extend(...)` alias names.
 * Plus the result types consumed across packages (`ExportMeta` lives in
 * `types.ts`; `PickMeta` / `Contract*StaticMeta` live here).
 */

// ---------------------------------------------------------------------------
// SDK import detection
// ---------------------------------------------------------------------------

/** Base function names that are always recognized (`workflow` = vNext graph
 * authoring, discovered as a runnable test — keep in sync with the AST
 * extractor's BASE_FNS). */
const BASE_FNS = ["test", "task", "workflow"];

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
 * that matches `test`, `task`, `workflow`, `*Test`, and `*Task`.
 */
function buildFnAlternation(customFns?: string[]): string {
  if (customFns && customFns.length > 0) {
    const all = [...new Set([...BASE_FNS, ...customFns])];
    return all.map(escapeRegExp).join("|");
  }
  // Convention fallback: test | task | workflow | *Test | *Task
  return "\\w*(?:Test|Task)|test|task|workflow";
}

/**
 * Check if a file's content looks like a Glubean test/task file.
 *
 * A fast, parse-free guard run before the (AST) extractors.
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

/**
 * Does the source DIRECTLY import the Glubean SDK module
 * (`@glubean/sdk` / `jsr:@glubean/sdk`)? Layer 1 of `isGlubeanFile` ONLY — it
 * does NOT match a bare `import { test } from "vitest"`.
 */
export function importsGlubeanSdk(content: string): boolean {
  return SDK_MODULE_PATTERNS.some((p) => p.test(content));
}

/**
 * Is this source a GENUINE Glubean test file — used to decide whether a
 * zero-export `*.test.ts` is a Glubean file whose projection a full-snapshot
 * sync would drop (flag it) vs. an unrelated test in a mixed repo (ignore it)?
 *
 * True when EITHER:
 *  1. it directly imports `@glubean/sdk`, OR
 *  2. it imports one of `glubeanAliases` — `test.extend()` wrapper names whose
 *     PROVENANCE the caller has already verified (collected only from files that
 *     themselves import the SDK). A Playwright/Vitest `base.extend` wrapper of the
 *     same name is therefore NOT in `glubeanAliases` and won't match.
 *
 * Unlike `isGlubeanFile`, it never falls back to the base `test`/`task`/`workflow`
 * convention (which collides with foreign runners) and is provenance-gated, so it
 * neither false-positives on foreign files nor depends on whether the file parses.
 */
export function isGlubeanTestSource(content: string, glubeanAliases: string[]): boolean {
  if (importsGlubeanSdk(content)) return true;
  // Defensive: never let a base name slip in as a "custom" wrapper alias.
  const custom = glubeanAliases.filter((a) => !BASE_FNS.includes(a));
  if (custom.length === 0) return false;
  const alt = custom.map(escapeRegExp).join("|");
  return new RegExp(`import\\s+.*\\{[^}]*\\b(${alt})\\b[^}]*\\}`).test(content);
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
  // Deliberately UNTYPED-FORM ONLY: type annotations and explicit type
  // arguments are not matched — a regex cannot bound either to one statement
  // without an expression parser (four codex rounds of counterexamples
  // during the S2.15 removal), and extend's return type infers, so the
  // unannotated form is the only one with real usage.
  const pattern = /(?:export\s+)?const\s+(\w+)\s*=\s*\w+\.extend\s*\(/g;
  const aliases: string[] = [];
  let m;
  while ((m = pattern.exec(stripped)) !== null) {
    aliases.push(m[1]);
  }
  return aliases;
}

// ---------------------------------------------------------------------------
// test.pick() example metadata (for CodeLens and other consumers)
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

// ---------------------------------------------------------------------------
// contract.http() metadata (for CodeLens and projection)
// ---------------------------------------------------------------------------

/** Metadata for a discovered contract case. */
export type ContractVerifyRule =
  | string
  | {
      id?: string;
      description: string;
      severity?: string;
      extensions?: Record<string, unknown>;
    };

export interface ContractCaseStaticMeta {
  /** Case key (e.g. "success", "notFound") */
  key: string;
  /** Source location (1-based line number) of the case key */
  line: number;
  /** Human-readable description (required field on ContractCase) */
  description?: string;
  /** Expected status code, or undefined if not statically extractable */
  expectStatus?: number;
  /** Deferred reason, or undefined if executable */
  deferred?: string;
  /** Deprecated reason */
  deprecated?: string;
  /** Case lifecycle: "active" | "deferred" | "deprecated" */
  lifecycle?: string;
  /** Case severity: "critical" | "warning" | "info" */
  severity?: string;
  /** Physical capability required: "headless" | "browser" | "out-of-band" */
  requires?: string;
  /** Default run policy: "always" | "opt-in" */
  defaultRun?: string;
  /** True if case declares a response headers schema */
  hasHeaderSchema?: boolean;
  /** True if case declares an example or examples */
  hasExample?: boolean;
  /** World-state precondition projected from BaseCaseSpec.given */
  given?: string;
  /** True when adapter-specific verify() code exists */
  hasVerify?: boolean;
  /** Projectable companion rules for opaque verify() callbacks */
  verifyRules?: ContractVerifyRule[];
  /**
   * "inbound" when the case is statically recognizable as an inbound case
   * (an `inboundCase({...})` call or a literal `direction: "inbound"` —
   * inbound-contract-design §9.2). Inbound cases are never runnable; the
   * static-fallback discovery paths must skip them. A case routed through
   * an alias/reference can evade static recognition — authoring convention
   * (same stance as OPTION D): write inbound cases inline.
   */
  direction?: "inbound";
}

/** Metadata for a discovered contract.http() call. */
export interface ContractStaticMeta {
  /** Contract ID (e.g. "create-user") */
  contractId: string;
  /** Export variable name (e.g. "createUser") */
  exportName: string;
  /** Source location (1-based line number) of the export */
  line: number;
  /** Endpoint (e.g. "POST /users") */
  endpoint: string;
  /** Protocol */
  protocol: string;
  /** Human-readable description of the contract (e.g. "新用户注册账号") */
  description?: string;
  /** Feature grouping key for projection (e.g. "用户注册") */
  feature?: string;
  /** Contract-level deprecation reason (propagates to all cases) */
  deprecated?: string;
  /** Cases */
  cases: ContractCaseStaticMeta[];
}

