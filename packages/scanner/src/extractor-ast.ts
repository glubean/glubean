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
  propertyNameText,
  findPropertyCall,
  walk,
  lineOf,
  type AnyNode,
  type SourceFile,
} from "./ast.js";
import type { ExportMeta } from "./types.js";
import type { ContractCaseStaticMeta, ContractStaticMeta, FlowStaticMeta, PickMeta } from "./extractor-static.js";
import { resolveDataPath } from "./data-path.js";

// `workflow` is the vNext graph authoring factory (@glubean/sdk workflow());
// its build() wraps the graph in a simple Test, so a `workflow("id")...` export
// is a runnable test for discovery purposes (S2.5).
const BASE_FNS = new Set(["test", "task", "workflow"]);

/** Whether a factory identifier name is a recognized test/task function. */
function isTestFnName(name: string, customFns?: Set<string>): boolean {
  if (customFns) return customFns.has(name);
  // Convention fallback: test | task | workflow | *Test | *Task (capitalized suffix).
  return BASE_FNS.has(name) || /(?:Test|Task)$/.test(name);
}

interface MetaFields {
  id?: string;
  name?: string;
  tags?: string[];
  timeout?: number;
  requires?: "headless" | "browser" | "out-of-band";
  defaultRun?: "always" | "opt-in";
  /** A STRING `skip: "reason"` (WorkflowMeta.skip) — maps to deferred. */
  deferred?: string;
}

/** Parse `{ id, name, tags, timeout, requires, defaultRun }` from a TestMeta object literal. */
function parseMetaObject(obj: AnyNode): MetaFields {
  const out: MetaFields = {};
  const id = stringProperty(obj, "id");
  if (id !== undefined) out.id = id;
  const name = stringProperty(obj, "name");
  if (name !== undefined) out.name = name;
  // WorkflowMeta.skip is a string reason (TestMeta.skip is boolean — a string
  // here only ever comes from a workflow). Carried as `deferred` so the
  // upload gate can exclude skipped workflows (codex S2.6 R13 P2).
  const skipReason = stringProperty(obj, "skip");
  if (skipReason !== undefined) out.deferred = skipReason;

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

/** `parallel: true` from a meta OBJECT — read only for data-driven (.each/
 * .pick) declarations; a plain test() meta must not gain a parallel group
 * (codex S2.12 R5 P2). */
function parseMetaParallel(obj: AnyNode): boolean {
  const parallelProp = objectProperty(obj, "parallel");
  if (!parallelProp) return false;
  const value = unwrapExpression(parallelProp.value as AnyNode);
  return value?.type === "BooleanLiteral" && value.value === true;
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
    if (!callee || callee.type !== "MemberExpression" || callee.computed === true) return;
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

/** Like `walk`, but does NOT descend into nested function scopes (arrow /
 * function expressions / declarations). The factory's graph calls live at its
 * top level — branch sides etc. are flagged by the outer `.branch(` on the
 * chain — while runtime callbacks may declare shadowing locals (`const wf =
 * ...` inside an action) that must not leak into the scan (codex S2.12 R4). */
function walkSameScope(
  node: AnyNode,
  cb: (n: AnyNode) => void,
  onNestedFn?: (fn: AnyNode) => void,
): void {
  cb(node);
  for (const key of Object.keys(node)) {
    const value = (node as Record<string, unknown>)[key];
    const visit = (v: unknown): void => {
      if (!v || typeof v !== "object") return;
      const child = v as AnyNode;
      if (typeof child.type !== "string") return;
      if (
        child.type === "ArrowFunctionExpression" ||
        child.type === "FunctionExpression" ||
        child.type === "FunctionDeclaration"
      ) {
        onNestedFn?.(child); // nested scope — the caller decides what to do
        return;
      }
      walkSameScope(child, cb, onNestedFn);
    };
    if (Array.isArray(value)) value.forEach(visit);
    else visit(value);
  }
}

/** The branch-family + poll method names the Cloud-render gate flags. */
const BRANCH_FAMILY_METHODS = new Set(["branch", "poll", "pollAction", "switch", "route"]);

/** Chain methods that DELEGATE part of the graph to a callback argument —
 * the callback is scanned like an each-factory; references fail closed.
 * S2.14 adds "group"; S2.13 starts with "use" (phase4 §4's shared rule). */
const DELEGATING_CHAIN_METHODS = new Set(["use"]);

/** Descend a receiver/initializer expression to its root identifier —
 * through call chains AND member access (`h.b.branch(...)` roots at `h`:
 * a container holding a live builder is itself suspect — codex S2.13 R7). */
function chainRootOf(expr: AnyNode | undefined): AnyNode | undefined {
  let root: AnyNode | undefined = expr ? unwrapExpression(expr) : undefined;
  for (;;) {
    if (!root) return root;
    if (root.type === "CallExpression") {
      const innerCallee = unwrapExpression(root.callee as AnyNode);
      if (innerCallee?.type === "MemberExpression") {
        root = unwrapExpression(innerCallee.object as AnyNode);
        continue;
      }
      return root;
    }
    if (root.type === "MemberExpression" && root.computed !== true) {
      root = unwrapExpression(root.object as AnyNode);
      continue;
    }
    return root;
  }
}

/** Does the expression subtree REFERENCE any live builder name? Same-scope
 * only (nested functions are handled by the scanner's own recursion), and
 * non-computed member/property KEY identifiers are skipped — `client.b` is a
 * property name, not a reference (codex S2.13 R7). */
function containsLiveIdentifier(expr: AnyNode | undefined, live: ReadonlySet<string>): boolean {
  if (!expr || typeof expr !== "object") return false;
  let found = false;
  const visit = (node: AnyNode): void => {
    if (found || !node || typeof node.type !== "string") return;
    if (
      node.type === "ArrowFunctionExpression" ||
      node.type === "FunctionExpression" ||
      node.type === "FunctionDeclaration"
    ) {
      return; // nested scope — the scanner recurses there separately
    }
    if (node.type === "Identifier") {
      if (live.has(node.name as string)) found = true;
      return;
    }
    for (const key of Object.keys(node)) {
      // skip NAME positions: a non-computed member's property and a
      // non-computed object-property key are labels, not references.
      if (
        (node.type === "MemberExpression" && node.computed !== true && key === "property") ||
        ((node.type === "ObjectProperty" || node.type === "Property") &&
          (node as { computed?: boolean }).computed !== true &&
          key === "key")
      ) {
        continue;
      }
      const value = (node as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const v of value) {
          if (v && typeof (v as AnyNode).type === "string") visit(v as AnyNode);
        }
      } else if (value && typeof (value as AnyNode).type === "string") {
        visit(value as AnyNode);
      }
      if (found) return;
    }
  };
  visit(unwrapExpression(expr) ?? expr);
  return found;
}

/**
 * The ONE shared rule (phase4 §4): any construct handing graph authorship to
 * a callback — each/pick factories, `.use(` fragments, (S2.14) `.group(`
 * bodies — is scanned with the binding-aware live/everLive dataflow
 * (codex S2.12 R2/R4/R10/R12/R13/R14/R15/R18) when INLINE.
 *
 * Returns `true` (branch-family call rooted at the builder found), `false`
 * (inline and clean), or `undefined` (not an inspectable inline function —
 * the caller fails CLOSED).
 */
function scanCallbackForBranchFamily(fn: AnyNode | undefined): boolean | undefined {
  if (
    !fn ||
    (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression")
  ) {
    return undefined;
  }
  const params = fn.params as AnyNode[] | undefined;
  const builderParam = params?.[0]?.type === "Identifier" ? (params[0].name as string) : undefined;
  if (!builderParam) return undefined; // destructured/absent — cannot root the dataflow
  // A default-parameter INITIALIZER can author the delegated chain before the
  // body (`(b, r = b.branch(...)) => r`) — the body-only scan would miss it
  // (codex S2.13 R5 P2). Only initializers can EXECUTE code, so fail closed
  // exactly on AssignmentPattern (incl. nested inside destructuring); a plain
  // destructured row param (`(wf, { region }) => ...`) is pure binding and
  // stays scannable (codex S2.13 R6 P2).
  for (const param of (params ?? []).slice(1)) {
    let hasInitializer = false;
    walk(param, (n) => {
      if (n.type === "AssignmentPattern") hasInitializer = true;
    });
    if (hasInitializer) return undefined;
  }
  let found = false;
  // Per-scope dataflow: every scope folds its own bindings into the inherited
  // builder-name set in SOURCE ORDER, detects calls against the live set, then
  // recurses into nested functions with the everLive snapshot (closures
  // capture bindings — see the S2.12 R14/R15 commit messages for the cases).
  const scanScope = (scopeBody: AnyNode, inherited: ReadonlySet<string>): void => {
    const live = new Set(inherited);
    const everLive = new Set(inherited);
    const bind = (
      nameNode: AnyNode | undefined,
      valueExpr: AnyNode | undefined,
      isDeclaration: boolean,
    ): void => {
      if (nameNode?.type !== "Identifier") return;
      const name = nameNode.name as string;
      // A value that CONTAINS a live builder reference (chain root, or a
      // wrapper like `{ b }` — codex S2.13 R7) makes the binding suspect:
      // alias it (fail-closed direction).
      if (containsLiveIdentifier(valueExpr, live)) {
        live.add(name);
        everLive.add(name);
      } else if (valueExpr !== undefined) {
        live.delete(name);
        if (isDeclaration) everLive.delete(name);
      }
    };
    const deferredFns: AnyNode[] = [];
    walkSameScope(
      scopeBody,
      (n) => {
        if (n.type === "VariableDeclarator") {
          bind(n.id as AnyNode, n.init as AnyNode | undefined, true);
          return;
        }
        if (n.type === "AssignmentExpression" && n.operator === "=") {
          bind(unwrapExpression(n.left as AnyNode), n.right as AnyNode, false);
          return;
        }
        if (found || n.type !== "CallExpression") return;
        const callee = unwrapExpression(n.callee as AnyNode);
        const calleeProp =
          callee?.type === "MemberExpression" && callee.computed !== true
            ? (callee.property as AnyNode)
            : undefined;
        const methodName = calleeProp?.type === "Identifier" ? (calleeProp.name as string) : undefined;
        // Nested delegation (`b.use(innerFragment)`): recurse into inline
        // callbacks; references fail closed — BEFORE the generic
        // argument-delegation check so an inline-and-clean fragment doesn't
        // false-positive on its own builder argument.
        if (
          methodName !== undefined &&
          DELEGATING_CHAIN_METHODS.has(methodName) &&
          (() => {
            const root = chainRootOf(callee!.object as AnyNode);
            return root?.type === "Identifier" && live.has(root.name as string);
          })()
        ) {
          const arg = (n.arguments as AnyNode[] | undefined)?.[0];
          const verdict = scanCallbackForBranchFamily(arg ? unwrapExpression(arg) : undefined);
          if (verdict !== false) found = true;
          return;
        }
        // DELEGATION fails closed (codex S2.12 R18 P2): passing a live
        // builder to any call — bare (`makeFlow(wf)`) or WRAPPED
        // (`makeFlow({ wf })`, codex S2.13 R7) — hands the graph to code
        // this scan cannot see. Nested-function arguments are exempt (the
        // scanner recurses into them itself).
        for (const arg of (n.arguments as AnyNode[] | undefined) ?? []) {
          if (containsLiveIdentifier(arg, live)) {
            found = true;
            return;
          }
        }
        if (methodName === undefined || !BRANCH_FAMILY_METHODS.has(methodName)) return;
        const root = chainRootOf(callee!.object as AnyNode);
        if (root?.type === "Identifier" && live.has(root.name as string)) {
          found = true;
        }
      },
      (fnNode) => deferredFns.push(fnNode),
    );
    for (const fnNode of deferredFns) {
      const childInherited = new Set(everLive);
      for (const param of (fnNode.params as AnyNode[] | undefined) ?? []) {
        if (param.type === "Identifier") childInherited.delete(param.name as string);
      }
      scanScope(fnNode.body as AnyNode, childInherited);
    }
  };
  scanScope(fn.body as AnyNode, new Set([builderParam]));
  return found;
}

/** Does the builder chain ITSELF (callee descent, never arguments) contain a
 * branch-family call? */
function chainHasBranchFamilyCall(init: AnyNode): boolean {
  let node: AnyNode | undefined = unwrapExpression(init);
  while (node && node.type === "CallExpression") {
    const callee = unwrapExpression(node.callee as AnyNode);
    if (!callee) return false;
    if (callee.type === "MemberExpression" && callee.computed !== true) {
      const property = callee.property as AnyNode;
      if (property.type === "Identifier") {
        const name = property.name as string;
        if (BRANCH_FAMILY_METHODS.has(name)) return true;
        if (DELEGATING_CHAIN_METHODS.has(name)) {
          // `.use(fragment)` on the chain: scan an inline fragment; a
          // reference fails closed (phase4 §1.4 / §4 — the R18 rule).
          const arg = ((node as AnyNode).arguments as AnyNode[] | undefined)?.[0];
          const verdict = scanCallbackForBranchFamily(arg ? unwrapExpression(arg) : undefined);
          if (verdict !== false) return true;
        }
      }
      node = unwrapExpression(callee.object as AnyNode);
    } else {
      return false;
    }
  }
  return false;
}

/**
 * Local names bound to the SDK's `workflow` factory via named-import aliases
 * (`import { workflow as journeyTest } ...`). The literal `workflow` is always
 * included. Without this, an alias that happens to satisfy the `*Test`/`*Task`
 * convention (or customFns) would be classified as a plain test and bypass the
 * workflow marker + the --upload branch/poll gate (codex S2.6 R12 P2).
 */
function collectWorkflowAliases(source: SourceFile): Set<string> {
  const aliases = new Set<string>(["workflow"]);
  const body = (source.program.body as AnyNode[] | undefined) ?? [];
  for (const stmt of body) {
    if (stmt.type !== "ImportDeclaration") continue;
    const specifiers = (stmt.specifiers as AnyNode[] | undefined) ?? [];
    for (const spec of specifiers) {
      if (spec.type !== "ImportSpecifier") continue;
      const imported = spec.imported as AnyNode | undefined;
      const importedName =
        imported?.type === "Identifier"
          ? (imported.name as string)
          : (imported?.value as string | undefined); // string import names
      const local = spec.local as AnyNode | undefined;
      if (importedName === "workflow" && local?.type === "Identifier") {
        aliases.add(local.name as string);
      }
    }
  }
  return aliases;
}

function parseTestDeclaration(
  decl: AnyNode,
  statement: AnyNode,
  customFns?: Set<string>,
  workflowAliases?: Set<string>,
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
    if (!factoryCallee || factoryCallee.type !== "MemberExpression" || factoryCallee.computed === true) {
      return undefined;
    }
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

  // A workflow import alias is always accepted (even when it matches no
  // test-name convention) and always classified as a workflow — the marker
  // must not depend on what the alias happens to look like (codex S2.6 R12).
  const isWorkflowFactory = workflowAliases?.has(factoryName) ?? factoryName === "workflow";
  if (!factoryName || (!isTestFnName(factoryName, customFns) && !isWorkflowFactory)) {
    return undefined;
  }

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
  if (fields.deferred === undefined && bMeta.deferred !== undefined) fields.deferred = bMeta.deferred;

  if (fields.id === undefined) return undefined;

  // `.each(data, { parallel: true })`.
  // meta-object `parallel` counts only for data-driven declarations
  // (workflow.each puts it there); legacy each-args form parsed below.
  const metaObjForParallel =
    (variant === "each" || variant === "pick") && metaArg ? objectFromExpression(metaArg) : undefined;
  let parallel = metaObjForParallel ? parseMetaParallel(metaObjForParallel) : false;
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

  // vNext workflow exports get a static marker so downstream consumers can
  // classify them as graph orchestrators ("flow"-kind runnables) without
  // importing the file, plus an AST-level branch/poll flag so the --upload
  // gate fails closed for .test.ts workflows the runtime extractor can never
  // safely inspect (codex S2.6 R10 P2).
  if (isWorkflowFactory) {
    result.workflow = true;
    // WorkflowMeta.skip (string reason) — surfaced so the upload gate can
    // exclude skipped workflows like deferred flows (codex S2.6 R13 P2).
    // Only emitted for workflows: TestMeta.skip is boolean, so a string skip
    // never legitimately appears on a plain test.
    if (fields.deferred !== undefined) result.deferred = fields.deferred;
    // Inspect ONLY the builder chain's own method names — descending callee
    // objects like chainHead does, never the call ARGUMENTS — so a user
    // callback body calling e.g. `client.poll()` cannot false-positive a
    // linear workflow into the upload refusal (codex S2.6 R11 P2). A branch's
    // then/else sub-chains live in arguments, but the outer `.branch(` on the
    // chain has already flagged it by then.
    let hasBranchOrPoll = chainHasBranchFamilyCall(init);
    // workflow.each/pick: the graph lives in the FACTORY callback, not the
    // outer chain — scan the factory body for branch-family calls ROOTED at
    // its builder parameter (`wf.branch(...)`, incl. chained receivers), so a
    // matrix of branch/poll graphs can't slip past the upload gate while an
    // unrelated `client.poll()` still doesn't false-positive
    // (codex S2.12 R1 P1).
    if (!hasBranchOrPoll && (variant === "each" || variant === "pick")) {
      const factoryArg = (head.arguments as AnyNode[] | undefined)?.[1];
      // The graph lives in the factory callback. Inline bodies get the
      // binding-aware scan; references fail CLOSED (codex S2.12 R9/R18 —
      // test files are never runtime re-extracted).
      const verdict = scanCallbackForBranchFamily(
        factoryArg ? unwrapExpression(factoryArg) : undefined,
      );
      if (verdict !== false) hasBranchOrPoll = true;
    }
    if (hasBranchOrPoll) result.workflowHasBranchOrPoll = true;
  }

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
  const workflowAliases = collectWorkflowAliases(source);
  const results: ExportMeta[] = [];
  forEachExportedConst(source, (statement, declaration) => {
    const meta = parseTestDeclaration(declaration, statement, fns, workflowAliases);
    if (meta) results.push(meta);
  });
  return results;
}

/**
 * Find the contract call in a chain.
 *
 * - **narrow** (default): only the literal `contract.<protocol>("id", { … })`
 *   direct form — the regex-faithful behavior the CLI/scanner depend on. The
 *   scanner deliberately "fails closed" on scoped/custom forms (warns + requires
 *   runtime import) rather than emit incomplete static metadata for upload (see
 *   the graphql README "Phase 1 limitations" + GraphQL RFR).
 * - **broad** (opt-in, for VSCode discovery): DUCK-TYPE any
 *   `<factory>("id", { …cases… })` — `contract.http.with(defaults)(...)` scoped
 *   instances, custom `stableApi(...)` factories, etc. (cookbook/demo use these
 *   heavily). `protocol` is best-effort (derived from a `contract.<X>` segment;
 *   "" when unknown).
 */
function findContractCall(init: AnyNode, broad: boolean): { protocol: string; call: AnyNode } | undefined {
  let node: AnyNode | undefined = unwrapExpression(init);
  while (node && node.type === "CallExpression") {
    const callee = unwrapExpression(node.callee as AnyNode);
    if (!callee) break;

    if (broad) {
      // Duck-type: (string id, object literal carrying `cases`).
      const args = node.arguments as AnyNode[] | undefined;
      const id = stringFromExpression(args?.[0]);
      const spec = objectFromExpression(args?.[1]);
      if (id !== undefined && spec && objectProperty(spec, "cases")) {
        return { protocol: deriveProtocol(callee), call: node };
      }
    } else if (callee.type === "MemberExpression" && callee.computed !== true) {
      // Narrow: literal `contract.<protocol>(...)`.
      const object = callee.object as AnyNode;
      const property = callee.property as AnyNode;
      if (object.type === "Identifier" && object.name === "contract" && property.type === "Identifier") {
        return { protocol: property.name as string, call: node };
      }
    }

    // Descend the chain toward the head.
    if (callee.type === "MemberExpression") {
      node = unwrapExpression(callee.object as AnyNode);
    } else if (callee.type === "CallExpression") {
      node = callee;
    } else {
      break;
    }
  }
  return undefined;
}

/** Best-effort protocol from a `contract.<X>` segment in a callee chain; "" if none. */
function deriveProtocol(callee: AnyNode): string {
  let c: AnyNode | undefined = unwrapExpression(callee);
  while (c) {
    if (c.type === "MemberExpression" && c.computed !== true) {
      const object = c.object as AnyNode;
      const property = c.property as AnyNode;
      if (object.type === "Identifier" && object.name === "contract" && property.type === "Identifier") {
        return property.name as string; // contract.<X>
      }
      c = unwrapExpression(object); // e.g. contract.http.with → descend to contract.http
    } else if (c.type === "CallExpression") {
      c = unwrapExpression(c.callee as AnyNode); // .with(defaults) → its callee
    } else {
      break;
    }
  }
  return "";
}

const _REQUIRES = new Set(["headless", "browser", "out-of-band"]);
const _DEFAULT_RUN = new Set(["always", "opt-in"]);

/** Parse the `cases: { key: { ... } }` object into ContractCaseStaticMeta[]. */
function readCases(casesObj: AnyNode): ContractCaseStaticMeta[] {
  const out: ContractCaseStaticMeta[] = [];
  const properties = (casesObj.properties as AnyNode[] | undefined) ?? [];
  for (const property of properties) {
    if (property.type !== "ObjectProperty") continue;
    const key = propertyNameText(property);
    if (key === undefined) continue;
    const body = objectFromExpression(property.value as AnyNode);
    if (!body) {
      // Reference / shorthand case value (`cases: { ok }` or `ok: sharedCase`):
      // the case body isn't an inline object, so per-case fields can't be read,
      // but the KEY is still a real case — preserve it (VSCode discovery needs it).
      out.push({ key, line: lineOf((property.key as AnyNode) ?? (property.value as AnyNode)) });
      continue;
    }

    const meta: ContractCaseStaticMeta = { key, line: lineOf(property.value as AnyNode) };

    const description = stringProperty(body, "description");
    if (description !== undefined) meta.description = description;

    // Status lives under `expect: { status: N }` (BaseCaseSpec); fall back to a
    // top-level `status` if present.
    const expectObj = objectFromExpression(objectProperty(body, "expect")?.value as AnyNode | undefined);
    const statusProp =
      (expectObj && objectProperty(expectObj, "status")) ?? objectProperty(body, "status");
    const statusVal = statusProp ? unwrapExpression(statusProp.value as AnyNode) : undefined;
    if (statusVal?.type === "NumericLiteral" && typeof statusVal.value === "number") {
      meta.expectStatus = statusVal.value as number;
    }

    const deferred = stringProperty(body, "deferred");
    if (deferred !== undefined) meta.deferred = deferred;

    const deprecated = stringProperty(body, "deprecated");
    if (deprecated !== undefined) meta.deprecated = deprecated;

    const requires = stringProperty(body, "requires");
    if (requires !== undefined && _REQUIRES.has(requires)) meta.requires = requires;

    const defaultRun = stringProperty(body, "defaultRun");
    if (defaultRun !== undefined && _DEFAULT_RUN.has(defaultRun)) meta.defaultRun = defaultRun;

    const given = stringProperty(body, "given");
    if (given !== undefined) meta.given = given;

    out.push(meta);
  }
  return out;
}

/**
 * Extract `<factory>("id", { endpoint, description, feature, cases })` contract
 * exports → `ContractStaticMeta[]` (contract id/exportName/line/endpoint/protocol/
 * description/feature + per-case key/line/description/expectStatus/deferred/
 * deprecated/requires/defaultRun/given). Returns [] on parse error.
 *
 * @param opts.broad - When true, duck-type ANY factory (scoped `.with()` /
 *   custom `*Api`) for discovery (VSCode). Default false: only the literal
 *   `contract.<protocol>(...)` form, so the CLI/scanner upload path keeps its
 *   deliberate "fail closed on scoped/custom forms" discipline.
 */
export function extractContractCases(
  content: string,
  opts?: { broad?: boolean },
): ContractStaticMeta[] {
  const broad = opts?.broad === true;
  let source;
  try {
    source = parseSource(content);
  } catch {
    return [];
  }
  const results: ContractStaticMeta[] = [];
  forEachExportedConst(source, (statement, declaration) => {
    const exportName = (declaration.id as AnyNode | undefined)?.name as string | undefined;
    const init = declaration.init as AnyNode | undefined;
    if (!exportName || !init) return;

    const found = findContractCall(init, broad);
    if (!found) return;
    const args = (found.call.arguments as AnyNode[] | undefined) ?? [];
    const contractId = stringFromExpression(args[0]);
    const spec = objectFromExpression(args[1]);
    if (contractId === undefined || !spec) return;

    const casesObj = objectFromExpression(objectProperty(spec, "cases")?.value as AnyNode | undefined);

    const meta: ContractStaticMeta = {
      contractId,
      exportName,
      line: lineOf(statement),
      endpoint: stringProperty(spec, "endpoint") ?? "",
      protocol: found.protocol,
      cases: casesObj ? readCases(casesObj) : [],
    };
    const description = stringProperty(spec, "description");
    if (description !== undefined) meta.description = description;
    const feature = stringProperty(spec, "feature");
    if (feature !== undefined) meta.feature = feature;

    results.push(meta);
  });
  return results;
}

/**
 * Structural (marker-free) flow extraction: every `export const X = <fn>.flow("id")…`
 * → `FlowStaticMeta`. Replaces vscode's `// @flow`-gated extractMarkedFlows — AST
 * recognizes the `.flow("id")` call shape directly, so no magic comment is needed
 * (aligns vscode discovery with the CLI, which never required markers). Returns []
 * on parse error.
 */
export function extractFlows(content: string): FlowStaticMeta[] {
  let source;
  try {
    source = parseSource(content);
  } catch {
    return [];
  }
  const results: FlowStaticMeta[] = [];
  forEachExportedConst(source, (statement, declaration) => {
    const exportName = (declaration.id as AnyNode | undefined)?.name as string | undefined;
    const init = declaration.init as AnyNode | undefined;
    if (!exportName || !init) return;

    const flowCall = findFlowCall(init);
    if (!flowCall) return;
    // `flow(idOrMeta: string | FlowMeta)` — string id or `{ id, ... }`. Runtime
    // honors the object's `id`; its `skip` is IGNORED at runtime (skip is only
    // applied from a chained `.meta({ skip })`), so we read skip only from there.
    const flowArg = (flowCall.arguments as AnyNode[] | undefined)?.[0];
    const flowMetaObj = objectFromExpression(flowArg);
    const flowId = stringFromExpression(flowArg) ?? (flowMetaObj && stringProperty(flowMetaObj, "id"));
    if (!flowId) return;

    const metaCall = findPropertyCall(init, "meta");
    const metaObj = metaCall
      ? objectFromExpression((metaCall.arguments as AnyNode[] | undefined)?.[0])
      : undefined;
    const skip = metaObj ? stringProperty(metaObj, "skip") : undefined;

    const meta: FlowStaticMeta = { exportName, line: lineOf(statement), flowId };
    if (skip !== undefined) meta.skip = skip;
    results.push(meta);
  });
  return results;
}

/**
 * Find the Glubean flow call in a chain: `contract.flow(...)` — a `.flow` member
 * on the `contract` namespace. Does NOT match an arbitrary `.flow(...)` on some
 * other object (`otherLib.flow(...)`) nor a bare `flow(...)`, which the runtime
 * would not recognize as a flow.
 *
 * Like `findContractCall` / the former regex, this keys off the literal name
 * `contract` and does not resolve `import { contract as x }` aliases — a known,
 * consistent limitation across the contract + flow static extractors (real code
 * uses `contract.flow(...)`).
 */
function findFlowCall(init: AnyNode): AnyNode | undefined {
  let node: AnyNode | undefined = unwrapExpression(init);
  while (node && node.type === "CallExpression") {
    const callee = unwrapExpression(node.callee as AnyNode);
    if (!callee) break;
    if (callee.type === "MemberExpression" && callee.computed !== true) {
      const object = callee.object as AnyNode;
      const property = callee.property as AnyNode;
      if (
        property.type === "Identifier" && property.name === "flow" &&
        object.type === "Identifier" && object.name === "contract"
      ) {
        return node; // contract.flow("id")
      }
      node = unwrapExpression(object);
    } else if (callee.type === "CallExpression") {
      node = callee;
    } else {
      break;
    }
  }
  return undefined;
}

// --- test.pick() example extraction (CodeLens) ----------------------------

type PickLoaderType =
  | "json-import" | "dir-merge" | "dir" | "dir-concat" | "yaml-map" | "json-loader" | "json-map";

/** Classify a data-loader call (`fromDir(...)`, `fromYaml.map(...)`, …) → {type, raw path}. */
function classifyLoader(call: AnyNode): { type: PickLoaderType; path: string } | undefined {
  const callee = unwrapExpression(call.callee as AnyNode);
  if (!callee) return undefined;
  const path = stringFromExpression((call.arguments as AnyNode[] | undefined)?.[0]);
  if (path === undefined) return undefined;
  if (callee.type === "Identifier") {
    if (callee.name === "fromDir") return { type: "dir", path };
    if (callee.name === "fromJson") return { type: "json-loader", path };
  } else if (callee.type === "MemberExpression" && callee.computed !== true) {
    const object = callee.object as AnyNode;
    const property = callee.property as AnyNode;
    if (object.type === "Identifier" && property.type === "Identifier") {
      if (object.name === "fromDir" && property.name === "merge") return { type: "dir-merge", path };
      if (object.name === "fromDir" && property.name === "concat") return { type: "dir-concat", path };
      if (object.name === "fromYaml" && property.name === "map") return { type: "yaml-map", path };
      if (object.name === "fromJson" && property.name === "map") return { type: "json-map", path };
    }
  }
  return undefined;
}

/** Map a variable name → its data source: default `.json` imports + `await from*(...)` loaders. */
function buildDataSources(source: { program: AnyNode }): Map<string, { type: PickLoaderType; path: string }> {
  const map = new Map<string, { type: PickLoaderType; path: string }>();
  // TOP-LEVEL bindings only (in source order, last-wins): a top-level
  // `test.pick(examples)` references the module-level `examples`, not a
  // same-named binding shadowed inside a nested function/block.
  const body = (source.program.body as AnyNode[] | undefined) ?? [];
  for (const statement of body) {
    if (statement.type === "ImportDeclaration") {
      const importPath = (statement.source as AnyNode | undefined)?.value;
      if (typeof importPath === "string" && importPath.endsWith(".json")) {
        for (const sp of (statement.specifiers as AnyNode[] | undefined) ?? []) {
          if (sp.type === "ImportDefaultSpecifier" && (sp.local as AnyNode)?.type === "Identifier") {
            map.set((sp.local as AnyNode).name as string, { type: "json-import", path: importPath });
          }
        }
      }
      continue;
    }
    // `const x = …` or `export const x = …`
    const varDecl =
      statement.type === "VariableDeclaration"
        ? statement
        : statement.type === "ExportNamedDeclaration" &&
            (statement.declaration as AnyNode | undefined)?.type === "VariableDeclaration"
          ? (statement.declaration as AnyNode)
          : undefined;
    if (!varDecl) continue;
    for (const declarator of (varDecl.declarations as AnyNode[] | undefined) ?? []) {
      const id = declarator.id as AnyNode | undefined;
      if (id?.type !== "Identifier") continue;
      // Strip TS wrappers (`as`/`satisfies`/`!`) around the whole initializer
      // (`await from*(...) as T`) before reading the await/call.
      let call = unwrapExpression(declarator.init as AnyNode | undefined);
      if (call?.type === "AwaitExpression") call = unwrapExpression(call.argument as AnyNode);
      if (call?.type !== "CallExpression") continue;
      const loader = classifyLoader(call);
      if (loader) map.set(id.name as string, loader);
    }
  }
  return map;
}

/**
 * AST replacement for the regex `extractPickExamples` — discovers
 * `<fn>.pick(data)("id-template", ...)` exports for CodeLens. Inline object data
 * → keys + `{type:"inline"}`; a variable referencing a `.json` import or a
 * `from*` loader → keys:null + the resolved dataSource path; an unknown simple
 * variable → keys:null + no dataSource. Non-object / non-identifier data args are
 * not recorded (mirrors the regex). Returns [] on parse error.
 */
export function extractPickExamples(
  content: string,
  options?: { customFns?: string[]; filePath?: string; projectRoot?: string },
): PickMeta[] {
  let source;
  try {
    source = parseSource(content, options?.filePath);
  } catch {
    return [];
  }
  const fns =
    options?.customFns && options.customFns.length > 0
      ? new Set([...BASE_FNS, ...options.customFns])
      : undefined;
  const dataSources = buildDataSources(source);
  const results: PickMeta[] = [];

  forEachExportedConst(source, (statement, declaration) => {
    const exportName = (declaration.id as AnyNode | undefined)?.name as string | undefined;
    const init = declaration.init as AnyNode | undefined;
    if (!exportName || !init) return;

    // `<fn>.pick(data)(idTemplate, ...)` — a curried call whose factory is `<fn>.pick`.
    const head = chainHead(init);
    if (!head || head.type !== "CallExpression") return;
    const headCallee = unwrapExpression(head.callee as AnyNode);
    if (headCallee?.type !== "CallExpression") return;
    const factoryCallee = unwrapExpression(headCallee.callee as AnyNode);
    if (!factoryCallee || factoryCallee.type !== "MemberExpression" || factoryCallee.computed === true) {
      return;
    }
    const object = factoryCallee.object as AnyNode;
    const property = factoryCallee.property as AnyNode;
    if (object.type !== "Identifier" || property.type !== "Identifier" || property.name !== "pick") return;
    if (!isTestFnName(object.name as string, fns)) return;

    // Test ID from the curried call's first arg (string or `{ id }`).
    const idArg = (head.arguments as AnyNode[] | undefined)?.[0];
    let testId = stringFromExpression(idArg);
    if (testId === undefined) {
      const idObj = objectFromExpression(idArg);
      if (idObj) testId = stringProperty(idObj, "id");
    }
    if (testId === undefined) return;

    const line = lineOf(statement);
    const pickArg = (headCallee.arguments as AnyNode[] | undefined)?.[0];

    const inlineObj = objectFromExpression(pickArg);
    if (inlineObj) {
      const keys = ((inlineObj.properties as AnyNode[] | undefined) ?? [])
        .filter((p) => p.type === "ObjectProperty")
        .map((p) => propertyNameText(p))
        .filter((k): k is string => typeof k === "string");
      results.push({
        testId,
        line,
        exportName,
        keys: keys.length > 0 ? keys : null,
        dataSource: keys.length > 0 ? { type: "inline" } : undefined,
      });
      return;
    }

    const pickVar = unwrapExpression(pickArg);
    if (pickVar?.type === "Identifier") {
      const loader = dataSources.get(pickVar.name as string);
      results.push({
        testId,
        line,
        exportName,
        keys: null,
        dataSource: loader
          ? ({
              type: loader.type,
              path: resolveDataPath(loader.path, {
                filePath: options?.filePath,
                projectRoot: options?.projectRoot,
              }).resolvedPath,
            } as PickMeta["dataSource"])
          : undefined,
      });
    }
    // Any other data-arg shape (member access, call, …) is not recorded.
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
