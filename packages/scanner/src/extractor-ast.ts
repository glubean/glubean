/**
 * AST-based test extractor — the @babel/parser replacement for the regex
 * `extractFromSource` in `extractor-static.ts`. Recognizes the same patterns and
 * produces the byte-identical `ExportMeta` shape (the 138 conformance tests run
 * unchanged against this module), but via a real parser so modern TS
 * (`satisfies`, generics, decorators, …) never trips it up.
 *
 * Scope: this owns `extractFromSource` + `createStaticExtractor`. The cheap
 * over-all-files guards (`isGlubeanFile`, `extractAliasesFromSource`) stay regex
 * in `extractor-static.ts` — they only match import/declaration patterns (no TS
 * expression parsing) and run on every candidate file, so parsing them would be
 * a needless perf cost. `extractPickExamples` / `extractContractCases` are
 * AST-migrated in later phases.
 */

import {
  parseSource,
  forEachExportedConst,
  unwrapExpression,
  stringFromExpression,
  objectFromExpression,
  objectProperty,
  stringProperty,
  findPropertyCall,
  walk,
  lineOf,
  type AnyNode,
} from "./ast.js";
import type { ExportMeta } from "./types.js";

const BASE_FNS = new Set(["test", "task"]);

/** Whether a factory identifier name is a recognized test/task function. */
function isTestFnName(name: string, customFns?: Set<string>): boolean {
  if (customFns) return customFns.has(name);
  // Convention fallback: test | task | *Test | *Task (capitalized suffix).
  return BASE_FNS.has(name) || /(?:Test|Task)$/.test(name);
}

interface MetaFields {
  id?: string;
  name?: string;
  tags?: string[];
  timeout?: number;
  requires?: "headless" | "browser" | "out-of-band";
  defaultRun?: "always" | "opt-in";
}

/** Parse `{ id, name, tags, timeout, requires, defaultRun }` from a TestMeta object literal. */
function parseMetaObject(obj: AnyNode): MetaFields {
  const out: MetaFields = {};
  const id = stringProperty(obj, "id");
  if (id !== undefined) out.id = id;
  const name = stringProperty(obj, "name");
  if (name !== undefined) out.name = name;

  const tagsProp = objectProperty(obj, "tags");
  if (tagsProp) {
    const value = unwrapExpression(tagsProp.value as AnyNode);
    if (value?.type === "ArrayExpression") {
      const elements = (value.elements as (AnyNode | null)[]) ?? [];
      const tags = elements
        .map((el) => (el ? stringFromExpression(el) : undefined))
        .filter((t): t is string => typeof t === "string");
      if (tags.length > 0) out.tags = tags;
    } else {
      const single = stringFromExpression(tagsProp.value as AnyNode);
      if (single !== undefined) out.tags = [single];
    }
  }

  const timeoutProp = objectProperty(obj, "timeout");
  if (timeoutProp) {
    const value = unwrapExpression(timeoutProp.value as AnyNode);
    if (value?.type === "NumericLiteral" && typeof value.value === "number") {
      out.timeout = value.value as number;
    }
  }

  const requires = stringProperty(obj, "requires");
  if (requires === "headless" || requires === "browser" || requires === "out-of-band") {
    out.requires = requires;
  }
  const defaultRun = stringProperty(obj, "defaultRun");
  if (defaultRun === "always" || defaultRun === "opt-in") out.defaultRun = defaultRun;

  return out;
}

/** Builder `.meta({...})` fields (name/tags/timeout/requires/defaultRun) from the chain. */
function builderMeta(init: AnyNode): MetaFields {
  const metaCall = findPropertyCall(init, "meta");
  if (!metaCall) return {};
  const args = (metaCall.arguments as AnyNode[] | undefined) ?? [];
  const obj = objectFromExpression(args[0]);
  return obj ? parseMetaObject(obj) : {};
}

/** Flat list of `.step("name", ...)` leaf names in source order (matches the regex baseline). */
function extractSteps(init: AnyNode): { name: string }[] {
  const found: { name: string; start: number }[] = [];
  walk(init, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = unwrapExpression(node.callee as AnyNode);
    if (!callee || callee.type !== "MemberExpression") return;
    const property = callee.property as AnyNode;
    if (property.type !== "Identifier" || property.name !== "step") return;
    const args = (node.arguments as AnyNode[] | undefined) ?? [];
    const name = stringFromExpression(args[0]);
    // Order by the NAME argument's position, not the call's: chained calls
    // (`a().step("x").step("y")`) all share the chain-root start, so the call's
    // own start can't order them.
    if (name !== undefined) found.push({ name, start: (args[0]?.start as number | null) ?? 0 });
  });
  found.sort((a, b) => a.start - b.start);
  return found.map(({ name }) => ({ name }));
}

/** Descend the builder-method chain (`.step`/`.meta`/…) to the head call. */
function chainHead(init: AnyNode): AnyNode | undefined {
  let node: AnyNode | undefined = unwrapExpression(init);
  while (node && node.type === "CallExpression") {
    const callee = unwrapExpression(node.callee as AnyNode);
    if (callee?.type === "MemberExpression") {
      node = unwrapExpression(callee.object as AnyNode);
    } else {
      break; // callee is an Identifier (simple) or a CallExpression (curried each/pick)
    }
  }
  return node;
}

function parseTestDeclaration(
  decl: AnyNode,
  statement: AnyNode,
  customFns?: Set<string>,
): ExportMeta | undefined {
  const exportName = (decl.id as AnyNode | undefined)?.name as string | undefined;
  if (!exportName) return undefined;
  const init = decl.init as AnyNode | undefined;
  if (!init) return undefined;

  const head = chainHead(init);
  if (!head || head.type !== "CallExpression") return undefined;

  let variant: "each" | "pick" | undefined;
  let factoryName: string | undefined;
  let metaArg: AnyNode | undefined;
  let eachArgs: AnyNode[] | undefined;

  const headCallee = unwrapExpression(head.callee as AnyNode);
  if (!headCallee) return undefined;
  if (headCallee.type === "Identifier") {
    // Simple / builder: `test("id", ...)` / `test("id").step(...)`.
    factoryName = headCallee.name as string;
    metaArg = (head.arguments as AnyNode[] | undefined)?.[0];
  } else if (headCallee.type === "CallExpression") {
    // Curried: `test.each(data)(...)` / `test.pick(examples)(...)`.
    const factoryCallee = unwrapExpression(headCallee.callee as AnyNode);
    if (!factoryCallee || factoryCallee.type !== "MemberExpression") return undefined;
    const object = factoryCallee.object as AnyNode;
    const property = factoryCallee.property as AnyNode;
    if (object.type !== "Identifier" || property.type !== "Identifier") return undefined;
    if (property.name !== "each" && property.name !== "pick") return undefined;
    factoryName = object.name as string;
    variant = property.name as "each" | "pick";
    eachArgs = (headCallee.arguments as AnyNode[] | undefined) ?? [];
    metaArg = (head.arguments as AnyNode[] | undefined)?.[0];
  } else {
    return undefined;
  }

  if (!factoryName || !isTestFnName(factoryName, customFns)) return undefined;

  // Resolve id + inline meta from the first argument (string id or TestMeta obj).
  let fields: MetaFields = {};
  const metaObj = objectFromExpression(metaArg);
  if (metaObj) {
    fields = parseMetaObject(metaObj);
  } else {
    const id = stringFromExpression(metaArg);
    if (id !== undefined) fields.id = id;
  }
  // Builder `.meta({...})` fills any gaps (positional/inline wins).
  const bMeta = builderMeta(init);
  if (fields.name === undefined && bMeta.name !== undefined) fields.name = bMeta.name;
  if (fields.tags === undefined && bMeta.tags !== undefined) fields.tags = bMeta.tags;
  if (fields.timeout === undefined && bMeta.timeout !== undefined) fields.timeout = bMeta.timeout;
  if (fields.requires === undefined && bMeta.requires !== undefined) fields.requires = bMeta.requires;
  if (fields.defaultRun === undefined && bMeta.defaultRun !== undefined) fields.defaultRun = bMeta.defaultRun;

  if (fields.id === undefined) return undefined;

  // `.each(data, { parallel: true })`.
  let parallel = false;
  if (variant === "each" && eachArgs && eachArgs.length > 1) {
    const optsObj = objectFromExpression(eachArgs[1]);
    const parallelProp = optsObj ? objectProperty(optsObj, "parallel") : undefined;
    const value = parallelProp ? unwrapExpression(parallelProp.value as AnyNode) : undefined;
    if (value?.type === "BooleanLiteral" && value.value === true) parallel = true;
  }

  const steps = extractSteps(init);

  const result: ExportMeta = {
    type: "test",
    id: fields.id,
    exportName,
    location: { line: lineOf(statement), col: 1 },
  };
  if (fields.name !== undefined) result.name = fields.name;
  if (fields.tags && fields.tags.length > 0) result.tags = fields.tags;
  if (fields.timeout !== undefined) result.timeout = fields.timeout;
  if (fields.requires !== undefined) result.requires = fields.requires;
  if (fields.defaultRun !== undefined) result.defaultRun = fields.defaultRun;
  if (variant) result.variant = variant;
  if (steps.length > 0) result.steps = steps;
  if (parallel) result.parallel = true;

  return result;
}

/**
 * Extract test metadata from TypeScript source via @babel/parser AST.
 * Drop-in replacement for the regex `extractFromSource` — same `ExportMeta[]`.
 * On a parse error (unparseable / unsupported syntax) returns `[]` — never throws
 * — so a malformed file is skipped, not fatal (mirrors the regex version, which
 * never threw).
 */
export function extractFromSource(content: string, customFns?: string[]): ExportMeta[] {
  let source;
  try {
    source = parseSource(content);
  } catch {
    return [];
  }
  const fns = customFns && customFns.length > 0 ? new Set([...BASE_FNS, ...customFns]) : undefined;
  const results: ExportMeta[] = [];
  forEachExportedConst(source, (statement, declaration) => {
    const meta = parseTestDeclaration(declaration, statement, fns);
    if (meta) results.push(meta);
  });
  return results;
}

/**
 * Create a static metadata extractor that reads files via `readFile`. Merges
 * construction-time `customFns` with call-time `runtimeFns` (alias discovery).
 */
export function createStaticExtractor(
  readFile: (path: string) => Promise<string>,
  customFns?: string[],
): (filePath: string, runtimeFns?: string[]) => Promise<ExportMeta[]> {
  return async (filePath: string, runtimeFns?: string[]): Promise<ExportMeta[]> => {
    const content = await readFile(filePath);
    const merged =
      customFns || runtimeFns
        ? [...new Set([...(customFns ?? []), ...(runtimeFns ?? [])])]
        : undefined;
    return extractFromSource(content, merged);
  };
}
