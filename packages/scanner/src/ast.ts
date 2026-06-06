/**
 * Shared AST helper for the scanner's AST extractors (`extractor-ast.ts`,
 * `contract-ast.ts`) and downstream consumers — the VSCode extension imports
 * this via `@glubean/scanner/ast`. Ported from the extension's own `ast.ts`,
 * which had already replaced `typescript` with acorn for size.
 *
 * Uses `acorn` + `acorn-typescript` (~600KB total bundled vs ~3MB for
 * `typescript`) — pure JS, no native binary.
 *
 * The acorn AST follows ESTree + TypeScript node extensions
 * (`TSAsExpression`, `TSTypeAssertion`, `TSSatisfiesExpression`,
 * `TSNonNullExpression`). Type-only constructs (interfaces, type
 * aliases, generic params) appear in the tree as `TSInterfaceDeclaration`
 * etc. — we ignore them since we only care about runtime expressions.
 *
 * Why a thin helper instead of just calling acorn directly: there are
 * many small transitions (line numbers, comment lookup, `as`/`!`/`<X>`
 * unwrapping) that show up in both consumers. Centralizing keeps the
 * behavior consistent and lets us swap parsers again later (e.g. if
 * acorn-typescript stops being maintained) by changing one file.
 */

import * as acorn from "acorn";
import { tsPlugin } from "acorn-typescript";

export interface SourceFile {
  /** Original raw text — needed to read template-string raw values etc. */
  text: string;
  /** Acorn root program node. */
  program: AcornProgram;
  /**
   * Comments collected during parse, sorted by `start`. We attach them to
   * the parser via the `onComment` callback rather than walking the tree
   * — acorn doesn't attach comments to nodes, so we look them up by
   * `node.start` when needed (e.g. `// @contract` marker detection).
   */
  comments: AcornComment[];
}

export interface AcornComment {
  /** `false` for line comments (single-line), `true` for block (slash-star) comments. */
  block: boolean;
  /** Text inside the delimiters, excluding the `//` or block comment markers. */
  text: string;
  start: number;
  end: number;
}

// `acorn-typescript` doesn't ship its own type defs for the extended
// nodes, and acorn's `Node` is intentionally loose. We type all node
// access through this `AnyNode` lens — `type` discriminator gives us
// what we need without a dependency on `@types/estree`.
export type AnyNode = acorn.Node & {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  [key: string]: unknown;
};

export type AcornProgram = AnyNode & { body: AnyNode[] };

const TsParser = acorn.Parser.extend(tsPlugin() as never);

// acorn-typescript ≤1.4.x does not support the `satisfies` operator (TS 4.9).
// Pre-normalize by replacing the operator keyword with `as` + padding so the
// char count stays identical — this preserves column positions for everything
// that follows. `satisfies T` and `as T` both produce a type-wrapper node that
// `unwrapExpression()` already handles.
//
// A naive global regex would corrupt string literals containing the word, e.g.
// `flow('id satisfies policy')` or `fromCsv('./satisfies.csv')`. This scanner
// instead walks the source character by character and only replaces `satisfies`
// when encountered outside of string literals and comments.
const _SATISFIES_SUB = "as       "; // "as" + 7 spaces = 9 chars, same as "satisfies"

// Identifier-continue per ECMAScript: ID_Continue + `$` + ZWNJ/ZWJ. Used as
// the boundary check around `satisfies` so the scanner doesn't treat valid
// non-ASCII identifier characters (e.g. `satisfiesπ`) as a word boundary.
const _IDENT_CONT = /[\p{ID_Continue}$‌‍]/u;

function normalizeSatisfies(src: string): string {
  if (!src.includes("satisfies")) return src;
  const out: string[] = [];
  _doScan(src, 0, false, out);
  return out.join("");
}

/**
 * Recursive scanner for `normalizeSatisfies`.
 *
 * `stopOnBrace`: when `true` the scanner is inside a `${...}` template
 * expression — it tracks `{` / `}` depth and returns as soon as the
 * matching `}` is consumed. The caller passes this flag when it recurses
 * for expression content so that nested objects and template literals
 * inside `${}` are handled correctly.
 *
 * Returns the index AFTER the last character consumed.
 *
 * Known limitation (inherited; not yet handled): regex LITERAL bodies are not
 * skipped, so a literal `satisfies` inside a `/.../ ` regex would be rewritten
 * in the NORMALIZED text. This is invisible to current/planned extraction —
 * `parseSource` preserves the raw `text`, and extractors read string-literal
 * args / object props / call structure, never regex `.pattern`/`.source`. If a
 * future extractor reads regex bodies, add a regex-literal skip branch here
 * (regex-vs-division by previous significant token). Tracked in docs/08 §8.
 */
function _doScan(src: string, start: number, stopOnBrace: boolean, out: string[]): number {
  let i = start;
  let braceDepth = 0; // only meaningful when stopOnBrace is true

  while (i < src.length) {
    const ch = src[i]!;

    // --- Template-expression brace tracking (stopOnBrace mode only) -------
    if (stopOnBrace) {
      if (ch === "{") {
        braceDepth++;
        out.push(ch);
        i++;
        continue;
      }
      if (ch === "}") {
        if (braceDepth === 0) {
          out.push(ch); // the closing `}` of the `${...}`
          return i + 1;
        }
        braceDepth--;
        out.push(ch);
        i++;
        continue;
      }
    }

    // --- Single- or double-quoted string: copy verbatim -------------------
    if (ch === '"' || ch === "'") {
      out.push(ch);
      i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === "\\") {
          out.push(src[i]!, src[i + 1] ?? "");
          i += 2;
        } else {
          out.push(src[i]!);
          i++;
        }
      }
      out.push(src[i] ?? ""); // closing quote (or EOF)
      i++;
      continue;
    }

    // --- Template literal: recurse into ${...} expressions ---------------
    if (ch === "`") {
      out.push(ch);
      i++;
      while (i < src.length) {
        const tc = src[i]!;
        if (tc === "`") {
          out.push(tc);
          i++;
          break; // end of template literal
        }
        if (tc === "\\" && i + 1 < src.length) {
          out.push(tc, src[i + 1]!);
          i += 2;
          continue;
        }
        if (tc === "$" && src[i + 1] === "{") {
          out.push("${");
          i += 2;
          // Recurse: scan the expression with stopOnBrace=true so `}` at
          // depth-0 terminates the expression and nested structures are
          // handled correctly (objects, nested templates, satisfies operators).
          i = _doScan(src, i, true, out);
          continue;
        }
        out.push(tc);
        i++;
      }
      continue;
    }

    // --- Line comment: copy verbatim to end of line -----------------------
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") {
        out.push(src[i]!);
        i++;
      }
      continue;
    }

    // --- Block comment: copy verbatim to `*/` -----------------------------
    if (ch === "/" && src[i + 1] === "*") {
      out.push(ch, src[i + 1]!);
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out.push(src[i]!);
        i++;
      }
      out.push(src[i] ?? "", src[i + 1] ?? ""); // "*/"
      i += 2;
      continue;
    }

    // --- `satisfies` operator: replace only in operator position ----------
    //
    // Operator position: between an expression and a type.
    // Non-operator uses to preserve:
    //   { satisfies: value }  — property key  → nextSignificant is ":"
    //   const satisfies = …   — identifier    → nextSignificant is "="
    //   satisfies(…)          — function call → nextSignificant is "("
    //   [satisfies, …]        — list element  → nextSignificant is "," / "]"
    //   obj.satisfies         — member access → preceded by "."
    // `\uXXXX` / `\u{...}` after `satisfies` extends the identifier — e.g.
    // `satisfiesπ` is a single identifier and must not be rewritten.
    const afterIsUnicodeEscape =
      src[i + 9] === "\\" && src[i + 10] === "u";
    if (
      src.slice(i, i + 9) === "satisfies" &&
      !_IDENT_CONT.test(src[i - 1] ?? " ") &&
      !_IDENT_CONT.test(src[i + 9] ?? " ") &&
      !afterIsUnicodeEscape
    ) {
      let j = i + 9;
      while (j < src.length && (src[j] === " " || src[j] === "\t")) j++;
      const next = src[j] ?? "";
      const isOperator =
        next !== ":" &&
        next !== "=" &&
        next !== "(" &&
        next !== "," &&
        next !== ";" &&
        next !== ")" &&
        next !== "]" &&
        next !== "}" &&
        src[i - 1] !== ".";
      if (isOperator) {
        out.push(_SATISFIES_SUB);
        i += 9;
        continue;
      }
    }

    out.push(ch);
    i++;
  }

  return i;
}

export function parseSource(content: string, filePath = "input.ts"): SourceFile {
  const comments: AcornComment[] = [];

  // acorn-typescript handles `.ts` AND `.tsx` source. For `.js` / `.mjs`
  // the TS plugin still parses cleanly (TS is a superset). The script
  // type only matters for JSX disambiguation, which we don't currently
  // surface anywhere — but reserve the option to switch parsers later.
  const isJsx = filePath.endsWith(".tsx") || filePath.endsWith(".jsx");
  void isJsx; // currently no JSX handling — acorn-typescript reads it fine

  const normalized = normalizeSatisfies(content);

  const program = TsParser.parse(normalized, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true,
    allowImportExportEverywhere: true,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    allowHashBang: true,
    onComment(block, text, start, end) {
      comments.push({ block, text, start, end });
    },
  } as acorn.Options) as unknown as AcornProgram;

  return { text: content, program, comments };
}

/**
 * Iterate over every `export const` declaration at the top level. Calls
 * `cb` once per declarator (`export const a = 1, b = 2` → two calls).
 *
 * Skips destructuring patterns (`export const { x } = ...`) — we only
 * surface plain identifiers, matching the previous TS-API behavior.
 */
export function forEachExportedConst(
  source: SourceFile,
  cb: (statement: AnyNode, declaration: AnyNode) => void,
): void {
  for (const statement of source.program.body) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = (statement as AnyNode).declaration as AnyNode | null | undefined;
    if (!declaration) continue;
    if (declaration.type !== "VariableDeclaration") continue;
    if ((declaration as AnyNode).kind !== "const") continue;
    const declarators = (declaration as AnyNode).declarations as AnyNode[] | undefined;
    if (!declarators) continue;
    for (const declarator of declarators) {
      cb(statement, declarator);
    }
  }
}

/**
 * Returns `true` if a `// @<marker>` line comment immediately precedes
 * the node. "Immediately" = the only non-whitespace tokens between the
 * comment and the node are other comments — matches the historical
 * behavior from the TS-based detector.
 */
export function hasLeadingMarker(source: SourceFile, node: AnyNode, marker: string): boolean {
  const start = node.start;
  // Walk comments backwards to find any immediately preceding `// @marker`.
  // We only scan comments that end at-or-before the node start.
  const candidates = source.comments.filter((c) => c.end <= start);
  if (candidates.length === 0) return false;

  // Walk back from the node and verify everything between the comment
  // and `start` is whitespace. If we hit non-whitespace, the comment is
  // attached to a different node.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const comment = candidates[i]!;
    const between = source.text.slice(comment.end, start);
    if (!/^\s*$/.test(between)) break; // earlier comments definitely won't match either

    if (!comment.block) {
      const re = new RegExp(String.raw`^\s*@${marker}\s*$`);
      if (re.test(comment.text)) return true;
    }
  }
  return false;
}

/**
 * Read a property name as a string. Handles:
 *   - plain identifier:        `key: ...`        → `"key"`
 *   - string literal:          `"key": ...`      → `"key"`
 *   - numeric literal:         `0: ...`          → `"0"`
 *   - template literal (no subst): `` `key`: ...`` → `"key"`
 *   - computed string literal: `["key"]: ...`    → `"key"`
 *   - shorthand:               `{ key }`         → `"key"` (key === Identifier name)
 *
 * Computed expressions that aren't string-resolvable return undefined.
 */
export function propertyNameText(node: AnyNode): string | undefined {
  // For property *patterns* (Property nodes), the key is on `.key`. The
  // shorthand/spread distinction lives on `.shorthand` / `.type`.
  if (node.type === "Property") {
    const key = node.key as AnyNode | undefined;
    const computed = node.computed as boolean | undefined;
    if (!key) return undefined;
    return readKey(key, computed === true);
  }
  // Fallback: caller passed the key node directly.
  return readKey(node, false);
}

function readKey(key: AnyNode, computed: boolean): string | undefined {
  if (key.type === "Identifier" && !computed) return key.name as string;
  if (key.type === "Literal") {
    const value = (key as AnyNode).value;
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
  }
  if (key.type === "TemplateLiteral") {
    const expressions = (key as AnyNode).expressions as AnyNode[] | undefined;
    const quasis = (key as AnyNode).quasis as AnyNode[] | undefined;
    if (expressions && expressions.length === 0 && quasis && quasis.length === 1) {
      const cooked = (quasis[0]!.value as { cooked?: string }).cooked;
      if (typeof cooked === "string") return cooked;
    }
  }
  return undefined;
}

/**
 * Strip TypeScript and grouping wrappers from an expression so the caller
 * sees the underlying value. Handles:
 *   - `(expr)` — ParenthesizedExpression (acorn doesn't emit these by
 *     default; if a future config does, we'd handle it here)
 *   - `expr as T`, `<T>expr`, `expr satisfies T`, `expr!`
 *
 * Returns `undefined` if the input is `undefined`.
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
        current = current.expression as AnyNode;
        break;
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
 * template literal) to its plain string value. Returns `undefined` for any
 * other expression shape — including template literals with substitutions.
 */
export function stringFromExpression(expr: AnyNode | undefined): string | undefined {
  const unwrapped = unwrapExpression(expr);
  if (!unwrapped) return undefined;
  if (unwrapped.type === "Literal" && typeof (unwrapped as AnyNode).value === "string") {
    return (unwrapped as AnyNode).value as string;
  }
  if (unwrapped.type === "TemplateLiteral") {
    const expressions = (unwrapped as AnyNode).expressions as AnyNode[] | undefined;
    const quasis = (unwrapped as AnyNode).quasis as AnyNode[] | undefined;
    if (expressions && expressions.length === 0 && quasis && quasis.length === 1) {
      const cooked = (quasis[0]!.value as { cooked?: string }).cooked;
      if (typeof cooked === "string") return cooked;
    }
  }
  return undefined;
}

/**
 * Resolve an expression that should be an object literal. Strips type
 * wrappers first.
 */
export function objectFromExpression(expr: AnyNode | undefined): AnyNode | undefined {
  const unwrapped = unwrapExpression(expr);
  return unwrapped?.type === "ObjectExpression" ? unwrapped : undefined;
}

/**
 * Find a property assignment in an object literal by key name. Returns
 * the `Property` node or `undefined`. Skips `SpreadElement` siblings —
 * we don't follow spread sources.
 */
export function objectProperty(object: AnyNode, name: string): AnyNode | undefined {
  if (object.type !== "ObjectExpression") return undefined;
  const properties = object.properties as AnyNode[] | undefined;
  if (!properties) return undefined;
  for (const property of properties) {
    if (property.type === "Property") {
      const propertyName = propertyNameText(property);
      if (propertyName === name) return property;
    }
  }
  return undefined;
}

/**
 * Read an object literal's named property as a string. Convenience wrapper
 * over `objectProperty` + `stringFromExpression`.
 */
export function stringProperty(object: AnyNode, name: string): string | undefined {
  const property = objectProperty(object, name);
  if (!property) return undefined;
  return stringFromExpression(property.value as AnyNode);
}

/**
 * Walk the expression looking for the first call whose callee is a
 * `<member>.<name>(...)` access. Used to locate `.flow("id")`,
 * `.bootstrap(...)`, `.meta(...)` calls anywhere in a chain.
 *
 * Doesn't recurse into already-found calls' children — keeps the search
 * cheap on large initializers.
 */
export function findPropertyCall(root: AnyNode, name: string): AnyNode | undefined {
  // Walk only the method-chain spine — never into arguments or callback bodies.
  // For `contract.flow('id').meta({}).step('name', async () => { helper.flow('x') })`:
  //   .step(...)  → callee = MemberExpression { object: .meta(...), property: step }
  //   .meta(...)  → callee = MemberExpression { object: .flow(...), property: meta }
  //   .flow(...)  → callee = MemberExpression { object: contract,   property: flow }
  //
  // Rule: if callee is a MemberExpression, check the property name; descend into
  // callee.object to continue the chain. If callee is a plain CallExpression
  // (curried form, e.g. `fn()()`), follow callee directly. Never descend into
  // the `arguments` array — that's where callback bodies live.
  let current: AnyNode | undefined = unwrapExpression(root);
  while (current && current.type === "CallExpression") {
    const callee = unwrapExpression((current as AnyNode).callee as AnyNode);
    if (!callee) break;
    if (callee.type === "MemberExpression") {
      const property = (callee as AnyNode).property as AnyNode;
      if (property.type === "Identifier" && (property as AnyNode).name === name) {
        return current;
      }
      current = unwrapExpression((callee as AnyNode).object as AnyNode);
    } else {
      current = callee;
    }
  }
  return undefined;
}

/**
 * Cheap depth-first walker. Returning `false` from the callback stops
 * descent into the current node's children but doesn't abort the walk
 * — return early via outer state if you want a hard stop.
 */
export function walk(root: AnyNode, cb: (node: AnyNode) => boolean | undefined | void): void {
  const stack: AnyNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const descend = cb(node);
    if (descend === false) continue;
    for (const key of Object.keys(node)) {
      // Skip well-known non-AST keys to avoid surprises (loc, range, comments).
      if (key === "loc" || key === "range" || key === "start" || key === "end" || key === "type") continue;
      const value = (node as AnyNode)[key];
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

/**
 * `true` if a top-level `export` statement carries a given declaration.
 * Used by callers that work with the export keyword on a `VariableStatement`.
 */
export function hasExportModifier(node: AnyNode): boolean {
  // In acorn AST, an `export const x = …` is `ExportNamedDeclaration`
  // wrapping a `VariableDeclaration`. There is no separate "modifier"
  // — the wrapper IS the export. Callers that wanted a TS-style modifier
  // check should use `forEachExportedConst` or check `node.type` against
  // `ExportNamedDeclaration`.
  return node.type === "ExportNamedDeclaration";
}
