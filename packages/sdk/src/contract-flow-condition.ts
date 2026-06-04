/**
 * Conditional branching — predicate foundation (Phase 1).
 *
 * The declarative (L2) predicate layer for `flow().condition` / `switchOn` /
 * `switchCond` (design: internal/40-discovery/proposals/contract-flow-condition.md).
 *
 * A predicate is built ONLY through `predicateScope(...)` (`when` / `all` / `any`
 * / `not`) — never hand-authored — so every node is:
 *   - **branded** (unforgeable: a module-private symbol users can't set), so a
 *     plain object literal is not assignable where a `BranchPredicate` is expected;
 *   - **path-extracted at construction** via the strict lens Proxy, so runtime
 *     evaluation reads a captured path (safe traversal, never re-invokes the lens);
 *   - **gated**: the lens must be a single member-access chain (no calls / ternary
 *     / operators / free-variable reads) — the projection guarantee depends on it;
 *   - **frozen** (deeply), so it can't be mutated after the purity checks ran.
 *
 * This file is the L2 declarative tier only. Runtime branch nodes, the builder
 * surface, and the opaque (L1/L0) tiers land in later phases.
 */

import { extractSelectorPath, LensPurityError } from "./contract-core.js";

/** JSON-safe scalar — the only thing a predicate may compare against. */
export type JsonScalar = string | number | boolean | null;

// Unforgeable brand: module-private symbol. Users cannot construct a value
// carrying it, so a `BranchPredicate` can only come from `when`/`all`/`any`/`not`.
declare const PREDICATE_BRAND: unique symbol;

/**
 * Declarative (L2) predicate AST. Deeply readonly; every node is frozen at
 * construction. `S` threads the state type so `condition` can reject a
 * predicate built for a different state. `lens` is kept only as a type anchor;
 * runtime evaluation uses `path` (safe traversal).
 */
export type BranchPredicate<S = unknown> = { readonly [PREDICATE_BRAND]: true } & (
  | {
      readonly kind: "compare";
      readonly op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
      readonly lens: (s: S) => unknown;
      readonly path: readonly string[];
      readonly value: JsonScalar;
    }
  | {
      readonly kind: "in";
      readonly lens: (s: S) => unknown;
      readonly path: readonly string[];
      readonly values: readonly JsonScalar[];
    }
  | {
      readonly kind: "presence";
      readonly op: "exists" | "absent" | "truthy" | "falsy";
      readonly lens: (s: S) => unknown;
      readonly path: readonly string[];
    }
  | {
      readonly kind: "matches";
      readonly lens: (s: S) => unknown;
      readonly path: readonly string[];
      readonly pattern: string;
      readonly flags?: string;
    }
  | { readonly kind: "and" | "or"; readonly clauses: readonly BranchPredicate<S>[] }
  | { readonly kind: "not"; readonly clause: BranchPredicate<S> }
);

/** Fluent operators on a selected value. */
export interface WhenClause<S, V> {
  eq(value: [Exclude<V, undefined>] extends [JsonScalar] ? Exclude<V, undefined> : never): BranchPredicate<S>;
  ne(value: [Exclude<V, undefined>] extends [JsonScalar] ? Exclude<V, undefined> : never): BranchPredicate<S>;
  in(values: ([Exclude<V, undefined>] extends [JsonScalar] ? Exclude<V, undefined> : never)[]): BranchPredicate<S>;
  exists(): BranchPredicate<S>;
  absent(): BranchPredicate<S>;
  truthy(): BranchPredicate<S>;
  falsy(): BranchPredicate<S>;
  gt(value: [Exclude<V, null | undefined>] extends [number] ? number : never): BranchPredicate<S>;
  gte(value: [Exclude<V, null | undefined>] extends [number] ? number : never): BranchPredicate<S>;
  lt(value: [Exclude<V, null | undefined>] extends [number] ? number : never): BranchPredicate<S>;
  lte(value: [Exclude<V, null | undefined>] extends [number] ? number : never): BranchPredicate<S>;
  matches(pattern: [Exclude<V, null | undefined>] extends [string] ? string | RegExp : never): BranchPredicate<S>;
}

/** Scoped predicate builder; `S` flows from `condition`'s generic into each lens. */
export interface PredicateScope<S> {
  when<V>(lens: (s: S) => [V] extends [PromiseLike<unknown>] ? never : V): WhenClause<S, V>;
  all(...clauses: BranchPredicate<S>[]): BranchPredicate<S>;
  any(...clauses: BranchPredicate<S>[]): BranchPredicate<S>;
  not(clause: BranchPredicate<S>): BranchPredicate<S>;
}

// --- P0 single-selector source gate -----------------------------------------

/**
 * Reject any lens that is not a single member-access chain off its one
 * parameter (optional chaining allowed): `s => s.a.b`, `s => s.a?.b`.
 *
 * The strict lens Proxy already throws on method calls / `new` / arithmetic
 * (via coercion), but it CANNOT see a pure ternary (`s.flag ? s.a : s.b` —
 * `ToBoolean` on the proxy object never traps) or a free-variable / `Date.now()`
 * read that bypasses the state entirely. This source check closes both: the
 * projected path is then guaranteed to match what runs. (Full AST analysis is
 * a future P1 enrichment; this string check is the P0 gate.)
 */
export function assertSelectorSource(fn: (...args: any[]) => unknown): void {
  const src = fn.toString().trim();
  const arrowAt = src.indexOf("=>");
  if (arrowAt < 0) {
    throw new LensPurityError("lens", "predicate lens must be an arrow function");
  }
  const paramSrc = src.slice(0, arrowAt).trim();
  const pm = paramSrc.match(/^\(?\s*([A-Za-z_$][\w$]*)\s*\)?$/);
  if (!pm) {
    throw new LensPurityError(
      "lens",
      `predicate lens must be a single-parameter arrow (no async, no destructuring); got "${paramSrc} =>"`,
    );
  }
  const param = pm[1];
  let body = src.slice(arrowAt + 2).trim();
  if (body.startsWith("{")) {
    const bm = body.match(/^\{\s*return\s+([\s\S]+?);?\s*\}$/);
    if (!bm) {
      throw new LensPurityError(
        "lens",
        "predicate lens with a block body must be a single `return <member chain>`",
      );
    }
    body = bm[1].trim();
  }
  // strip balanced wrapping parens
  while (body.startsWith("(") && body.endsWith(")")) body = body.slice(1, -1).trim();
  const escaped = param.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const chain = new RegExp(`^${escaped}(?:\\??\\.[A-Za-z_$][\\w$]*)+$`);
  if (!chain.test(body)) {
    throw new LensPurityError(
      "lens",
      `predicate lens must be a single member-access chain off "${param}" ` +
        `(no calls, operators, ternaries, indexing, or other identifiers); got: ${body}`,
    );
  }
}

// --- operand validation ------------------------------------------------------

function assertFiniteScalar(value: unknown, op: string): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new LensPurityError(
      `predicate.${op}`,
      `operand must be a finite number; NaN/Infinity are not JSON-safe and never match`,
    );
  }
}

// --- predicate construction (the only way to make a BranchPredicate) ---------

function brandFreeze<S>(node: object): BranchPredicate<S> {
  return Object.freeze(node) as BranchPredicate<S>;
}

function selectorPath(lens: (s: any) => unknown): readonly string[] {
  assertSelectorSource(lens); // P0 source gate (ternary / free-var / calls)
  return Object.freeze(extractSelectorPath(lens)); // strict-Proxy path + Proxy purity
}

/**
 * Build a `PredicateScope<S>`. The runtime is untyped (`any`); the public typing
 * comes from the `PredicateScope<S>` / `WhenClause<S, V>` interfaces it is cast to.
 */
export function predicateScope<S>(): PredicateScope<S> {
  const when = (lens: (s: any) => unknown): any => {
    const path = selectorPath(lens);
    const compare = (op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte", value: JsonScalar) => {
      assertFiniteScalar(value, op);
      return brandFreeze({ kind: "compare", op, lens, path, value });
    };
    return {
      eq: (value: JsonScalar) => compare("eq", value),
      ne: (value: JsonScalar) => compare("ne", value),
      gt: (value: number) => compare("gt", value),
      gte: (value: number) => compare("gte", value),
      lt: (value: number) => compare("lt", value),
      lte: (value: number) => compare("lte", value),
      in: (values: JsonScalar[]) => {
        values.forEach((v) => assertFiniteScalar(v, "in"));
        return brandFreeze({ kind: "in", lens, path, values: Object.freeze([...values]) });
      },
      exists: () => brandFreeze({ kind: "presence", op: "exists", lens, path }),
      absent: () => brandFreeze({ kind: "presence", op: "absent", lens, path }),
      truthy: () => brandFreeze({ kind: "presence", op: "truthy", lens, path }),
      falsy: () => brandFreeze({ kind: "presence", op: "falsy", lens, path }),
      matches: (pattern: string | RegExp) => {
        const re = typeof pattern === "string" ? new RegExp(pattern) : pattern;
        return brandFreeze({
          kind: "matches",
          lens,
          path,
          pattern: re.source,
          ...(re.flags ? { flags: re.flags } : {}),
        });
      },
    };
  };
  const combine = (kind: "and" | "or", clauses: BranchPredicate<any>[]) => {
    if (clauses.length === 0) {
      throw new LensPurityError(`predicate.${kind}`, `${kind}() needs at least one clause`);
    }
    return brandFreeze({ kind, clauses: Object.freeze([...clauses]) });
  };
  return {
    when: when as any,
    all: (...clauses: BranchPredicate<any>[]) => combine("and", clauses),
    any: (...clauses: BranchPredicate<any>[]) => combine("or", clauses),
    not: (clause: BranchPredicate<any>) => brandFreeze({ kind: "not", clause }),
  } as PredicateScope<S>;
}

// --- runtime evaluation ------------------------------------------------------

/** Safe path traversal: returns `undefined` if any intermediate is null/undefined. */
function resolvePath(state: unknown, path: readonly string[]): unknown {
  let cur: any = state;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** Evaluate a declarative predicate against a concrete state. Pure, no I/O. */
export function evalPredicate<S>(pred: BranchPredicate<S>, state: S): boolean {
  switch (pred.kind) {
    case "compare": {
      const actual = resolvePath(state, pred.path);
      switch (pred.op) {
        case "eq":
          return actual === pred.value;
        case "ne":
          return actual !== pred.value;
        case "gt":
          return typeof actual === "number" && actual > (pred.value as number);
        case "gte":
          return typeof actual === "number" && actual >= (pred.value as number);
        case "lt":
          return typeof actual === "number" && actual < (pred.value as number);
        case "lte":
          return typeof actual === "number" && actual <= (pred.value as number);
      }
      return false;
    }
    case "in": {
      const actual = resolvePath(state, pred.path);
      return pred.values.some((v) => v === actual);
    }
    case "presence": {
      const actual = resolvePath(state, pred.path);
      switch (pred.op) {
        case "exists":
          return actual !== undefined;
        case "absent":
          return actual === undefined;
        case "truthy":
          return !!actual;
        case "falsy":
          return !actual;
      }
      return false;
    }
    case "matches": {
      const actual = resolvePath(state, pred.path);
      return typeof actual === "string" && new RegExp(pred.pattern, pred.flags).test(actual);
    }
    case "and":
      return pred.clauses.every((c) => evalPredicate(c, state));
    case "or":
      return pred.clauses.some((c) => evalPredicate(c, state));
    case "not":
      return !evalPredicate(pred.clause, state);
  }
}
