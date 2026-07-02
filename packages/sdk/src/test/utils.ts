/**
 * @module test-utils
 *
 * Internal helpers shared by `test-builder`, `each-builder`, and `test-extend`.
 *
 * - `interpolateTemplate` — replaces `$key` / `$index` placeholders in ID templates
 * - `resolveBaseMeta` — normalises string | TestMeta to TestMeta
 * - `normalizeEachTable` — accepts array or plain-object map, injects `_pick` for maps
 * - `selectPickExamples` — picks examples from a named map (respects `GLUBEAN_PICK` env)
 * - `globToRegExp` — converts `*` glob patterns to RegExp (used by selectPickExamples)
 */
import type { EachRowMeta, TestMeta } from "../types.js";

/**
 * Single-pass `$placeholder` tokenizer shared by `interpolateTemplate` and
 * `interpolateRowKey` so the interpolated id and the row key NEVER disagree on
 * how a data field is substituted (the `rowKey === id` contract for stable
 * templates depends on this).
 *
 * Semantics (matching the documented template contract, but collision-safe):
 * - The reserved positional `$index` placeholder wins at every `$` position
 *   (it shadows any data field, including one literally named `index` or a
 *   longer field like `indexed`). `index === undefined` leaves it literal
 *   (the row-key mode).
 * - Data keys match LONGEST-FIRST, so a key that is a prefix of another
 *   (`$id` vs `$id2`) or of a later placeholder can never corrupt it.
 * - Substituted values are emitted verbatim in one pass — a value containing
 *   `$something` is never re-scanned (no value injection).
 * - A `$` matching nothing stays literal.
 */
function interpolatePlaceholders(
  template: string,
  data: Record<string, unknown>,
  index: number | undefined,
): string {
  // Longest-first so a key that prefixes another key never wins the match.
  const keys = Object.keys(data)
    .filter((k) => k.length > 0 && k !== "index")
    .sort((a, b) => b.length - a.length);
  let out = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i]!;
    if (ch !== "$") {
      out += ch;
      i++;
      continue;
    }
    const rest = template.slice(i + 1);
    // Reserved positional placeholder — always wins (documented shadowing).
    if (rest.startsWith("index")) {
      out += index === undefined ? "$index" : String(index);
      i += "$index".length;
      continue;
    }
    const key = keys.find((k) => rest.startsWith(k));
    if (key !== undefined) {
      out += String(data[key]);
      i += 1 + key.length;
    } else {
      out += "$";
      i++;
    }
  }
  return out;
}

/**
 * Interpolate `$key` placeholders in a template string with data values.
 * Supports `$index` for the row index and `$key` for any key in the data object.
 *
 * @internal
 */
export function interpolateTemplate(
  template: string,
  data: Record<string, unknown>,
  index: number,
): string {
  return interpolatePlaceholders(template, data, index);
}

/**
 * True when an id/name template references the positional `$index` placeholder.
 * `$index` makes the interpolated id reorder-unstable; this is the SDK's
 * authoritative check (it owns interpolation, where `$index` is substituted
 * before — and so shadows — a data field literally named `index`).
 *
 * @internal
 */
export function templateUsesIndex(template: string): boolean {
  return template.includes("$index");
}

/**
 * Build the reorder-stable per-row key: `interpolateTemplate` with the data
 * fields ONLY, leaving the positional `$index` placeholder literal so an
 * `$index`-based template stays detectable downstream. Same tokenizer as
 * `interpolateTemplate` (a data field named `index` is shadowed by the
 * reserved `$index` placeholder), minus the index substitution — so for a
 * template that never references `$index`, `rowKey === id` exactly.
 *
 * @internal
 */
export function interpolateRowKey(
  template: string,
  data: Record<string, unknown>,
): string {
  return interpolatePlaceholders(template, data, undefined);
}

/**
 * Build the data-driven row provenance (`EachRowMeta`) for one generated
 * per-row test — `idTemplate` + a reorder-stable `rowKey` + the `$index`
 * stability flag — so Cloud derive can resolve a stable cross-run identity
 * instead of only the final interpolated id. Shared by `test.each`,
 * `test.pick`, and `EachBuilder`. `index` MUST be the same row index passed to
 * `interpolateTemplate` for this row (i.e. the index into the filtered table).
 *
 * @internal
 */
export function buildEachRowMeta(
  idTemplate: string,
  data: Record<string, unknown>,
  index: number,
): EachRowMeta {
  return {
    idTemplate,
    index,
    rowKey: interpolateRowKey(idTemplate, data),
    stable: !templateUsesIndex(idTemplate),
  };
}

/**
 * Resolve baseMeta from string or TestMeta input.
 * @internal
 */
export function resolveBaseMeta(idOrMeta: string | TestMeta): TestMeta {
  return typeof idOrMeta === "string" ? { id: idOrMeta, name: idOrMeta } : { name: idOrMeta.id, ...idOrMeta };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Normalize table input for test.each: accepts array or plain object (map).
 *
 * - Array: returned as-is
 * - Plain object: converted to array with `_pick` key injected per entry
 *
 * @internal
 */
export function normalizeEachTable<T extends Record<string, unknown>>(
  table: readonly T[] | Record<string, T>,
): (T & { _pick?: string })[] {
  if (Array.isArray(table)) return table as (T & { _pick?: string })[];
  if (!isPlainObject(table)) {
    throw new Error("test.each() expects an array or a plain object (map).");
  }
  return Object.entries(table).map(([key, val]) => ({ ...val, _pick: key }));
}

/**
 * Resolve a GLUBEAN_PICK override against a set of example keys — the single
 * matching semantic shared by `selectPickExamples` and `workflow.pick`'s
 * filter pre-check: `all`/`*` selects everything, `*`-globs match by pattern,
 * anything else matches literally. Returns the matched keys (possibly empty).
 */
export function matchPickKeys(pickedEnv: string, keys: readonly string[]): string[] {
  const trimmed = pickedEnv.trim();
  if (trimmed === "all" || trimmed === "*") return [...keys];
  const pickedKeys = trimmed
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  const hasGlob = pickedKeys.some((k) => k.includes("*"));
  if (hasGlob) {
    const patterns = pickedKeys.map((p) => globToRegExp(p));
    return keys.filter((k) => patterns.some((re) => re.test(k)));
  }
  return pickedKeys.filter((k) => keys.includes(k));
}

/**
 * Convert a simple glob pattern (with `*` wildcards) to a RegExp.
 * Only `*` is supported (matches any sequence of characters).
 * @internal
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = "^" + escaped.replace(/\*/g, ".*") + "$";
  return new RegExp(regexStr);
}

export function selectPickExamples<T extends Record<string, unknown>>(
  examples: Record<string, T>,
  count: number,
): (T & { _pick: string })[] {
  const keys = Object.keys(examples);
  if (keys.length === 0) {
    throw new Error("test.pick requires at least one example");
  }

  let pickedEnv: string | undefined;
  try {
    pickedEnv = typeof process !== "undefined" ? process.env["GLUBEAN_PICK"] : undefined;
  } catch {
    pickedEnv = undefined;
  }

  if (pickedEnv) {
    const validKeys = matchPickKeys(pickedEnv, keys);
    if (validKeys.length > 0) {
      return validKeys.map((k) => ({ ...examples[k], _pick: k }));
    }
  }

  const shuffled = [...keys].sort(() => Math.random() - 0.5);
  const picked = shuffled.slice(0, Math.min(count, keys.length));
  return picked.map((k) => ({ ...examples[k], _pick: k }));
}
