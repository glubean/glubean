/**
 * only-selectors.ts — pure, unit-testable builders for the B2 M3 `{id, rowIndex}`
 * "only" selector protocol at the CLI surface.
 *
 * Two entry points:
 *  - `buildOnlySelectorsFromFlags` — the single validation gate for the
 *    `--only-id` / `--row` / `--rerun-failed` flag combination. Returns the
 *    selector set for the explicit (`--only-id`/`--row`) path, or a clear error.
 *  - `deriveRerunSelectors` — turns a prior `last-run.result.json` into the
 *    failed-subset selectors + the distinct files those failures live in.
 *
 * The protocol shape (`OnlySelector`) and matching/collection semantics
 * (`collectFailedSelectors`) are reused from `@glubean/runner` so the CLI, the
 * SDK runner, and the cloud harness all speak ONE protocol.
 */
import { collectFailedSelectors, type OnlySelector } from "@glubean/runner";

export interface OnlyFlags {
  onlyId?: string[];
  row?: number;
  rerunFailed?: boolean;
}

export type BuildSelectorsResult =
  | { ok: true; selectors: OnlySelector[] }
  | { ok: false; error: string };

/**
 * Validate the flag combination and build selectors for the explicit
 * `--only-id` / `--row` path.
 *
 * Validation:
 *  - `--rerun-failed` is mutually exclusive with `--only-id` / `--row`.
 *  - `--row` requires EXACTLY one `--only-id` (it pins a single `.each` row).
 *
 * Returns `{ selectors: [] }` for the conflict-free `--rerun-failed` case — the
 * caller sources the actual selectors from the last run via `deriveRerunSelectors`.
 */
export function buildOnlySelectorsFromFlags(opts: OnlyFlags): BuildSelectorsResult {
  const onlyId = opts.onlyId ?? [];
  const hasRow = opts.row !== undefined;
  const rerun = !!opts.rerunFailed;

  // --rerun-failed reuses the last run's failed set; it can't be combined with
  // an explicit --only-id / --row target.
  if (rerun && (onlyId.length > 0 || hasRow)) {
    return {
      ok: false,
      error:
        "--rerun-failed cannot be combined with --only-id or --row (it reuses the last run's failed set).",
    };
  }

  // --row pins a single .each row, so it needs exactly one --only-id to attach to.
  if (hasRow && onlyId.length !== 1) {
    return {
      ok: false,
      error:
        onlyId.length === 0
          ? "--row requires --only-id (the id whose .each row you want to isolate)."
          : `--row requires exactly one --only-id (got ${onlyId.length}). Drop --row to run multiple ids.`,
    };
  }

  // Conflict-free rerun mode: no flag-derived selectors — they come from the file.
  if (rerun) return { ok: true, selectors: [] };

  if (hasRow) {
    return { ok: true, selectors: [{ id: onlyId[0]!, rowIndex: opts.row! }] };
  }
  return { ok: true, selectors: onlyId.map((id) => ({ id })) };
}

/**
 * Derive the `--rerun-failed` selector set + the distinct files those failures
 * came from, off a prior run's `last-run.result.json` `tests` array.
 *
 * `selectors` reuses `collectFailedSelectors` (failed records with an id → bare
 * `{id}` or row-pinned `{id, rowIndex}`). `files` is the de-duplicated list of
 * `filePath`s of failed records (declaration order preserved) so the caller can
 * narrow discovery to only the files that actually contained a failure.
 */
export function deriveRerunSelectors(lastRun: {
  tests: Array<{ testId?: string; rowIndex?: number; filePath?: string; success: boolean }>;
}): { selectors: OnlySelector[]; files: string[] } {
  const tests = lastRun.tests ?? [];
  const selectors = collectFailedSelectors(
    tests.map((t) => ({ id: t.testId, rowIndex: t.rowIndex, success: t.success })),
  );
  const files: string[] = [];
  const seen = new Set<string>();
  for (const t of tests) {
    if (t.success === false && t.filePath && !seen.has(t.filePath)) {
      seen.add(t.filePath);
      files.push(t.filePath);
    }
  }
  return { selectors, files };
}
