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
  // optional type annotation between name and `=` (no `=>` arrows supported
  // there — an annotation containing one would stop the match early)
  const pattern = /(?:export\s+)?const\s+(\w+)\s*(?::[^=;\n]*?)?=\s*\w+\.extend\s*(?:<.*?>)?\s*\(/g;
  const aliases: string[] = [];
  let m;
  while ((m = pattern.exec(stripped)) !== null) {
    aliases.push(m[1]);
  }
  return aliases;
}

/**
 * WORKFLOW-rooted extend aliases (codex S2.15 R5 P2): `const wf =
 * workflow.extend({...})` (and chains re-extending such a binding) define
 * factories that other files import — the consuming file's extractor needs
 * these names to CLASSIFY the export as a workflow (branch/poll gate
 * included), not merely accept it as runnable. Regex-level like the test
 * alias pass; the workflow root is the literal `workflow` import name or a
 * `workflow as X` alias.
 */
export function extractWorkflowExtendAliasesFromSource(
  content: string,
  /** Extra root factory names valid in THIS file (pre-resolved local names of
   * IMPORTED extended factories — lets a fixtures file re-extend another
   * fixtures file's export, codex S2.15 R9 P2). */
  extraRoots?: readonly string[],
): string[] {
  const stripped = stripComments(content);
  const roots = new Set<string>(["workflow", ...(extraRoots ?? [])]);
  const importPattern = /import\s*\{([^}]*)\}\s*from/g;
  let im;
  while ((im = importPattern.exec(stripped)) !== null) {
    for (const spec of im[1].split(",")) {
      const am = spec.match(/^\s*workflow\s+as\s+(\w+)\s*$/);
      if (am) roots.add(am[1]);
    }
  }
  const names = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    const pattern = /(?:export\s+)?const\s+(\w+)\s*(?::[^=;\n]*?)?=\s*(\w+)\s*\.extend\s*(?:<.*?>)?\s*\(/g;
    let m;
    while ((m = pattern.exec(stripped)) !== null) {
      const [, name, base] = m;
      if ((roots.has(base) || names.has(base)) && !names.has(name)) {
        names.add(name);
        grew = true;
      }
    }
  }
  return [...names];
}

/**
 * Build the PROJECT-LEVEL extended-workflow factory registry (exported name →
 * defining files) over a set of files, to a FIXED POINT: a fixtures file may
 * re-extend a factory imported from another fixtures file (any depth), so
 * each iteration re-resolves every file's imported factory names against the
 * registry-so-far and feeds them as extra roots (codex S2.15 R9 P2). Shared
 * by Scanner.collectAliases and the CLI discovery prepass. Pure — callers
 * supply contents.
 */
export function buildWorkflowFnRegistry(
  files: ReadonlyArray<{ path: string; content: string }>,
): Map<string, string[]> {
  const registry = new Map<string, string[]>();
  const add = (name: string, file: string): boolean => {
    const existing = registry.get(name) ?? [];
    if (existing.includes(file)) return false;
    existing.push(file);
    registry.set(name, existing);
    return true;
  };
  // SUPPORTED module-graph shapes end here (option-D boundary): direct
  // imports, renames, cross-file extend chains, js/mjs/cjs specifiers,
  // annotated exports, root-level files, and the barrel re-exports below.
  // Dynamic shapes (tsconfig path aliases, package self-references,
  // computed re-exports) are answered by the authoring conventions in
  // CLAUDE.md, not more resolution code.
  let grew = true;
  while (grew) {
    grew = false;
    for (const { path, content } of files) {
      const seeds = resolveExternalWorkflowFns(content, path, registry);
      for (const name of extractWorkflowExtendAliasesFromSource(content, seeds)) {
        if (add(name, path)) grew = true;
      }
      // Barrel re-exports (codex S2.15 R14 P2): `export { wf } from "./base"`
      // (with optional rename) and `export * from "./base"` make the BARREL
      // a defining file for those names too, so consumers importing the
      // barrel resolve.
      const stripped = stripComments(content);
      const named = /export\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g;
      let nm;
      while ((nm = named.exec(stripped)) !== null) {
        const [, specs, source] = nm;
        for (const spec of specs.split(",")) {
          const sm = spec.match(/^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/);
          if (!sm) continue;
          const fromName = sm[1];
          const toName = sm[2] ?? sm[1];
          if (sourceDefines(path, source, fromName, registry) && add(toName, path)) grew = true;
        }
      }
      const star = /export\s*\*\s*from\s*["'](\.[^"']+)["']/g;
      let sm2;
      while ((sm2 = star.exec(stripped)) !== null) {
        const source = sm2[1];
        for (const name of [...registry.keys()]) {
          if (sourceDefines(path, source, name, registry) && add(name, path)) grew = true;
        }
      }
    }
  }
  return registry;
}

/** Does `source` (a relative specifier in the file at `fromPath`) resolve to
 * a file the registry lists as a definer of `name`? */
function sourceDefines(
  fromPath: string,
  source: string,
  name: string,
  registry: ReadonlyMap<string, readonly string[]>,
): boolean {
  return (
    resolveExternalWorkflowFns(
      `import { ${name} } from "${source}";`,
      fromPath,
      registry,
    ).length > 0
  );
}

/**
 * Resolve which PROJECT-LEVEL extended workflow factories apply to ONE file
 * (codex S2.15 R7 P2 — a registry keyed by symbol name alone misclassifies
 * unrelated same-name imports and misses renames): walks the file's import
 * statements, and for each specifier whose imported name exists in the
 * registry AND whose source resolves to the registry's DEFINING file, yields
 * the LOCAL binding name. Pure string/path logic — no fs access.
 */
export function resolveExternalWorkflowFns(
  content: string,
  filePath: string,
  /** exported name → DEFINING FILE(s) — multiple fixtures modules may export
   * the same name (codex S2.15 R8 P2), so each name maps to every definer. */
  registry: ReadonlyMap<string, readonly string[]>,
): string[] {
  if (registry.size === 0) return [];
  const stripped = stripComments(content);
  const out: string[] = [];
  const importPattern = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  const normPath = filePath.replace(/\\/g, "/");
  // a root-level file has no separator — its dir is "" (codex S2.15 R13 P2:
  // the old replace left the FILENAME as dir and broke ./sibling imports)
  const dir = normPath.includes("/") ? normPath.replace(/\/[^/]*$/, "") : "";
  const normalize = (p: string): string => {
    const parts: string[] = [];
    for (const seg of p.replace(/\\/g, "/").split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    return (p.startsWith("/") ? "/" : "") + parts.join("/");
  };
  let m;
  while ((m = importPattern.exec(stripped)) !== null) {
    const [, specs, source] = m;
    if (!source.startsWith(".")) continue; // package imports never match project files
    const resolvedBase = normalize(dir ? `${dir}/${source}` : source).replace(
      /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/,
      "",
    );
    for (const spec of specs.split(",")) {
      const sm = spec.match(/^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/);
      if (!sm) continue;
      const importedName = sm[1];
      const localName = sm[2] ?? sm[1];
      const definingFiles = registry.get(importedName);
      if (!definingFiles) continue;
      for (const definingFile of definingFiles) {
        const definingBase = definingFile
          .replace(/\\/g, "/")
          .replace(/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/, "");
        if (definingBase === resolvedBase || definingBase === `${resolvedBase}/index`) {
          out.push(localName);
          break;
        }
      }
    }
  }
  return out;
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

/** Metadata for a discovered `<fn>.flow("id")` export (structural — no marker). */
export interface FlowStaticMeta {
  /** Export variable name (e.g. "signupFlow") */
  exportName: string;
  /** Source location (1-based line number) of the export */
  line: number;
  /** Flow ID — the literal string arg to `.flow(...)` */
  flowId: string;
  /** Skip-at-declaration reason from `.meta({ skip })`, if present */
  skip?: string;
}
