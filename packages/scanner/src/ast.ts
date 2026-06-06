/**
 * Shared AST helper for the scanner's AST extractors (`extractor-ast.ts`,
 * `contract-ast.ts`) and downstream consumers — exposed as
 * `@glubean/scanner/ast` (the VSCode extension consolidates onto it).
 *
 * Parser: `@babel/parser` (actively maintained, pure JS, no native binary).
 * It parses modern TypeScript natively — `satisfies`, `const` type params,
 * decorators, `<Foo>bar` angle assertions (in `.ts`), import attributes,
 * `using` declarations — so NO source pre-normalization is needed. (We moved off
 * `acorn-typescript`, which was unmaintained since 2024 and could not parse
 * `satisfies`/`const T`, forcing a fragile rewrite hack.)
 *
 * The Babel AST: object literals use `ObjectProperty`, string/number literals
 * are `StringLiteral`/`NumericLiteral`, TS wrappers are `TSAsExpression`,
 * `TSSatisfiesExpression`, `TSNonNullExpression`, `TSTypeAssertion`,
 * `TSInstantiationExpression`. Type-only constructs are ignored — we only read
 * runtime expressions.
 *
 * A thin helper (not raw `parse` calls): the line-number/comment-lookup/
 * `as`-`!`-`satisfies` unwrapping transitions recur across consumers, so
 * centralizing keeps behavior consistent and lets us swap parsers by editing one
 * file.
 */

import { parse } from "@babel/parser";
import type { ParserPlugin } from "@babel/parser";

export interface SourceFile {
  /** Original raw text — needed to read template-string raw values, line slices. */
  text: string;
  /** Babel `Program` node. */
  program: AnyNode;
  /**
   * Comments collected during parse, in source order. Babel attaches them to
   * nodes too, but we look them up by offset (e.g. `// @contract` markers).
   */
  comments: CommentInfo[];
}

export interface CommentInfo {
  /** `false` for line comments (`//`), `true` for block comments (`/* *​/`). */
  block: boolean;
  /** Text inside the delimiters, excluding the `//` or `/* *​/` markers. */
  text: string;
  start: number;
  end: number;
}

// Babel nodes are typed loosely here; we discriminate on `type` and read fields
// through this lens without depending on `@babel/types`.
export type AnyNode = {
  type: string;
  start: number | null;
  end: number | null;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } } | null;
  [key: string]: unknown;
};

/** Parse TypeScript/JavaScript source into a {@link SourceFile}. */
export function parseSource(content: string, filePath = "input.ts"): SourceFile {
  const jsx = filePath.endsWith(".tsx") || filePath.endsWith(".jsx");
  const base: ParserPlugin[] = ["typescript", ["importAttributes", { deprecatedAssertSyntax: true }]];
  if (jsx) base.push("jsx");
  const options = (decorators: ParserPlugin[]) => ({
    sourceType: "module" as const,
    plugins: [...base, ...decorators],
    ranges: true,
    allowImportExportEverywhere: true,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    allowSuperOutsideMethod: true,
    allowUndeclaredExports: true,
  });

  // Babel's `decorators` (stage-3) and `decorators-legacy` are mutually
  // exclusive. Legacy is the only mode with PARAMETER decorators (the common
  // experimentalDecorators ecosystem — Angular/Nest); the modern mode (option
  // omitted) accepts BOTH `@dec export class` and `export @dec class` placements
  // but has no parameter decorators. Try legacy first (covers param decorators +
  // `@dec export` + `accessor`); on a parse failure (e.g. a file using the
  // post-export `export @dec` placement), retry with modern, which accepts both
  // placements. The only combo neither parses — `export @dec` together with a
  // parameter decorator — isn't valid under any single TS decorator config.
  let file;
  try {
    file = parse(content, options(["decorators-legacy", "decoratorAutoAccessors"]));
  } catch (legacyError) {
    try {
      file = parse(content, options(["decorators", "decoratorAutoAccessors"]));
    } catch {
      throw legacyError; // not a decorator-mode mismatch — surface the real error
    }
  }

  const comments: CommentInfo[] = (file.comments ?? []).map((c) => ({
    block: c.type === "CommentBlock",
    text: c.value,
    start: c.start ?? 0,
    end: c.end ?? 0,
  }));

  return { text: content, program: file.program as unknown as AnyNode, comments };
}

/**
 * Iterate over every `export const` declaration at the top level. Calls `cb`
 * once per declarator (`export const a = 1, b = 2` → two calls).
 *
 * Contract: skips destructuring patterns (`export const { x } = ...` / `[a] =`)
 * — only plain identifier declarators are surfaced, so callers can assume
 * `declarator.id` is an `Identifier`.
 */
export function forEachExportedConst(
  source: SourceFile,
  cb: (statement: AnyNode, declaration: AnyNode) => void,
): void {
  const body = (source.program.body as AnyNode[] | undefined) ?? [];
  for (const statement of body) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = statement.declaration as AnyNode | null | undefined;
    if (!declaration) continue;
    if (declaration.type !== "VariableDeclaration") continue;
    if (declaration.kind !== "const") continue;
    const declarators = declaration.declarations as AnyNode[] | undefined;
    if (!declarators) continue;
    for (const declarator of declarators) {
      const id = declarator.id as AnyNode | undefined;
      if (id?.type !== "Identifier") continue;
      cb(statement, declarator);
    }
  }
}

/**
 * Returns `true` if a `// @<marker>` line comment leads the node — i.e. it is on
 * its own line and only whitespace/other comments sit between it and the node.
 * (A trailing comment on the previous statement, `const p = 1; // @x`, does NOT
 * count.)
 */
export function hasLeadingMarker(source: SourceFile, node: AnyNode, marker: string): boolean {
  const start = node.start;
  if (start == null) return false;
  const candidates = source.comments
    .filter((c) => c.end <= start)
    .sort((a, b) => a.start - b.start);
  if (candidates.length === 0) return false;

  const re = new RegExp(String.raw`^\s*@${marker}\s*$`);
  // Walk the contiguous leading-comment block from the node upward: each comment
  // counts while everything from it to the previous thing toward the node
  // (`cursor`) is whitespace. Other comments don't break the chain.
  let cursor = start;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const comment = candidates[i]!;
    if (!/^\s*$/.test(source.text.slice(comment.end, cursor))) break; // code between → block ended
    if (!comment.block && re.test(comment.text)) {
      // Must be a LEADING comment (its own line), not a trailing comment.
      const lineStart = source.text.lastIndexOf("\n", comment.start - 1) + 1;
      if (/^\s*$/.test(source.text.slice(lineStart, comment.start))) return true;
    }
    cursor = comment.start;
  }
  return false;
}

/**
 * Read a property name as a string. Handles identifier (`key`), string
 * (`"key"`), numeric (`0`), no-substitution template (`` `key` ``), computed
 * string/template (`["key"]`), and shorthand (`{ key }`) keys. Returns undefined
 * for computed expressions that aren't string-resolvable.
 */
export function propertyNameText(node: AnyNode): string | undefined {
  if (node.type === "ObjectProperty" || node.type === "ObjectMethod") {
    const key = node.key as AnyNode | undefined;
    if (!key) return undefined;
    return readKey(key, node.computed === true);
  }
  // Fallback: caller passed the key node directly.
  return readKey(node, false);
}

function readKey(key: AnyNode, computed: boolean): string | undefined {
  if (key.type === "Identifier" && !computed) return key.name as string;
  if (key.type === "StringLiteral") return key.value as string;
  if (key.type === "NumericLiteral") return String(key.value);
  if (key.type === "TemplateLiteral") {
    const expressions = key.expressions as AnyNode[] | undefined;
    const quasis = key.quasis as AnyNode[] | undefined;
    if (expressions && expressions.length === 0 && quasis && quasis.length === 1) {
      const cooked = (quasis[0]!.value as { cooked?: string }).cooked;
      if (typeof cooked === "string") return cooked;
    }
  }
  return undefined;
}

/**
 * Strip TypeScript and grouping wrappers (`expr as T`, `<T>expr`,
 * `expr satisfies T`, `expr!`, `expr<T>`, `(expr)`) so the caller sees the
 * underlying value. Returns undefined if the input is undefined.
 */
export function unwrapExpression(expr: AnyNode | undefined): AnyNode | undefined {
  let current = expr;
  while (current) {
    switch (current.type) {
      case "TSAsExpression":
      case "TSTypeAssertion":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
      case "TSInstantiationExpression":
      case "ParenthesizedExpression":
        current = current.expression as AnyNode;
        break;
      default:
        return current;
    }
  }
  return current;
}

/**
 * Resolve an expression that should be a string literal (or a no-substitution
 * template literal) to its plain string value. Returns undefined for any other
 * shape — including template literals with substitutions.
 */
export function stringFromExpression(expr: AnyNode | undefined): string | undefined {
  const unwrapped = unwrapExpression(expr);
  if (!unwrapped) return undefined;
  if (unwrapped.type === "StringLiteral" && typeof unwrapped.value === "string") {
    return unwrapped.value as string;
  }
  if (unwrapped.type === "TemplateLiteral") {
    const expressions = unwrapped.expressions as AnyNode[] | undefined;
    const quasis = unwrapped.quasis as AnyNode[] | undefined;
    if (expressions && expressions.length === 0 && quasis && quasis.length === 1) {
      const cooked = (quasis[0]!.value as { cooked?: string }).cooked;
      if (typeof cooked === "string") return cooked;
    }
  }
  return undefined;
}

/** Resolve an expression that should be an object literal (stripping type wrappers). */
export function objectFromExpression(expr: AnyNode | undefined): AnyNode | undefined {
  const unwrapped = unwrapExpression(expr);
  return unwrapped?.type === "ObjectExpression" ? unwrapped : undefined;
}

/**
 * Find an object-literal property assignment by key name. Returns the
 * `ObjectProperty` node or undefined. Skips spread/method members.
 */
export function objectProperty(object: AnyNode, name: string): AnyNode | undefined {
  if (object.type !== "ObjectExpression") return undefined;
  const properties = object.properties as AnyNode[] | undefined;
  if (!properties) return undefined;
  for (const property of properties) {
    if (property.type === "ObjectProperty" && propertyNameText(property) === name) {
      return property;
    }
  }
  return undefined;
}

/** Read an object literal's named property as a string (objectProperty + stringFromExpression). */
export function stringProperty(object: AnyNode, name: string): string | undefined {
  const property = objectProperty(object, name);
  if (!property) return undefined;
  return stringFromExpression(property.value as AnyNode);
}

/**
 * Walk the method-chain spine looking for the first `.<name>(...)` call (e.g.
 * `.flow("id")`, `.meta(...)`, `.step(...)`). Never descends into arguments or
 * callback bodies — only follows the chain via `callee.object`.
 */
export function findPropertyCall(root: AnyNode, name: string): AnyNode | undefined {
  let current: AnyNode | undefined = unwrapExpression(root);
  while (current && current.type === "CallExpression") {
    const callee = unwrapExpression(current.callee as AnyNode);
    if (!callee) break;
    if (callee.type === "MemberExpression") {
      const property = callee.property as AnyNode;
      if (property.type === "Identifier" && property.name === name) return current;
      current = unwrapExpression(callee.object as AnyNode);
    } else {
      current = callee;
    }
  }
  return undefined;
}

// Babel attaches non-AST bookkeeping to nodes; skip it so `walk` only descends
// into real child nodes.
const _SKIP_KEYS = new Set([
  "type", "start", "end", "loc", "range", "extra",
  "leadingComments", "trailingComments", "innerComments", "comments", "tokens", "errors",
]);

/**
 * Depth-first walker. Returning `false` from the callback prunes descent into the
 * current node's children (but doesn't abort the whole walk).
 */
export function walk(root: AnyNode, cb: (node: AnyNode) => boolean | undefined | void): void {
  const stack: AnyNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (cb(node) === false) continue;
    for (const key of Object.keys(node)) {
      if (_SKIP_KEYS.has(key)) continue;
      const value = node[key];
      if (!value) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === "object" && typeof (item as AnyNode).type === "string") {
            stack.push(item as AnyNode);
          }
        }
      } else if (typeof value === "object" && typeof (value as AnyNode).type === "string") {
        stack.push(value as AnyNode);
      }
    }
  }
}

/** 1-based line of a node's start position. */
export function lineOf(node: AnyNode): number {
  return node.loc?.start.line ?? 1;
}

/** `true` if the node is a top-level `export` declaration wrapper. */
export function hasExportModifier(node: AnyNode): boolean {
  return node.type === "ExportNamedDeclaration";
}
