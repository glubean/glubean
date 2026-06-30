/**
 * selector.ts — the `{id, rowIndex}` "only" selector protocol (B2 M3).
 *
 * SHARED PROTOCOL WITH CLOUD. The shape and matching semantics here mirror the
 * cloud-vendored harness EXACTLY so the cloud runner and this SDK runner speak
 * ONE protocol name (`OnlySelector`) and ONE shape. Keep the three primitives
 * (`normalizeSelectors` / `matchOnly` / `collectFailedSelectors`) byte-equivalent
 * to cloud's `glubean-runner.ts` + `failed-set.ts`; any divergence forks the
 * protocol and breaks cross-runtime parity.
 *
 * - A bare string selector matches by test `id` OR `name`.
 * - An object selector `{ id, rowIndex? }` matches by `id` and — when `rowIndex`
 *   is present — additionally pins the `.each` row (post-filter 0-based index).
 *   Omitting `rowIndex` matches every row of an expanded `.each` id.
 *
 * The runner consumes selectors as a RUNTIME filter (per-row ids are runtime
 * data); the env channel `GLUBEAN_RUNNER_ONLY_SELECTORS` carries a JSON
 * `OnlySelector[]` into the harness subprocess.
 */

/** One "only" selector: a bare id/name string, or an id (optionally row-pinned). */
export type OnlySelector = string | { id: string; rowIndex?: number };

/**
 * Normalize an `only` input into a selector array (or `null` = "no filter").
 *
 * `null`/`undefined` → `null` (run everything); an array passes through; a bare
 * value is wrapped in a single-element array. Mirrors cloud's
 * `onlyArr = only == null ? null : Array.isArray(only) ? only : [only]`.
 */
export function normalizeSelectors(
  only: OnlySelector | OnlySelector[] | null | undefined,
): OnlySelector[] | null {
  if (only == null) return null;
  return Array.isArray(only) ? only : [only];
}

/**
 * Does any selector match this test? Ports cloud's `matchOnly`:
 * - object selector: `sel.id === t.id && (sel.rowIndex === undefined || sel.rowIndex === t.rowIndex)`
 * - string selector: `sel === t.id || sel === t.name`
 */
export function matchOnly(
  selectors: OnlySelector[],
  t: { id: string; name?: string; rowIndex?: number },
): boolean {
  return selectors.some((sel) => {
    if (sel != null && typeof sel === "object") {
      return sel.id === t.id && (sel.rowIndex === undefined || sel.rowIndex === t.rowIndex);
    }
    return sel === t.id || sel === t.name;
  });
}

/**
 * Derive the "rerun the failures" selector set from a prior run's test records.
 * Ports cloud's `collectFailed`: keep failed records that carry an id, and emit
 * a row-pinned `{ id, rowIndex }` when a rowIndex is present, else a bare `{ id }`.
 */
export function collectFailedSelectors(
  tests: Array<{ id?: string; rowIndex?: number; success: boolean }>,
): OnlySelector[] {
  return tests
    .filter((t) => t.success === false && t.id != null)
    .map((t) => (t.rowIndex === undefined ? { id: t.id! } : { id: t.id!, rowIndex: t.rowIndex }));
}
