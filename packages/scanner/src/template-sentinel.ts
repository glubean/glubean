/**
 * Template-id sentinel helpers — match runtime row ids back to the static
 * template id emitted by `extractFromSource` for `test.each` / `test.pick`.
 *
 * ## Background
 *
 * Static parsing produces ONE `ExportMeta` per data-driven export, with an
 * id that contains `$placeholder` markers — e.g. `test.each(rows)({ id:
 * "case-$id" })` is extracted as id `"case-$id"`. At runtime, the harness
 * substitutes the placeholders against each row, emitting concrete ids
 * like `"case-101"`, `"case-202"`. Downstream consumers (CLI run output,
 * MCP discover/run, etc.) need to map the concrete event ids back to the
 * static meta — that's what these helpers do.
 *
 * ## Placeholder syntax
 *
 * - Marker is `$<word>` — a `$` followed by a JS identifier-start character
 *   followed by zero or more identifier characters (letters, digits, `_`).
 * - Each placeholder matches `.*` (greedy) at runtime — there is no
 *   typed/numeric variant. Multi-placeholder ids (`case-$a-$b`) match
 *   greedily left-to-right; ambiguous splits are not resolved.
 * - Matching is **case-insensitive** (the runner's harness id substitution
 *   may lowercase row keys).
 *
 * ## Variant prefix
 *
 * VSCode prefixes ids with `each:` / `pick:` for routing. These helpers
 * strip the prefix before matching so a `each:case-$id` template still
 * matches a runtime `case-101`.
 *
 * ## Limitations
 *
 * - Two static templates whose runtime ids could collide (e.g.
 *   `case-$x` and `case-$y` in the same file) get first-match-wins
 *   semantics from `findTemplateMatch` — there's no warning.
 * - The shape `case-$a-$b` matching `case-x-y-z` has multiple valid
 *   splits; this helper returns *some* match without disambiguating.
 *   Document your runtime ids to avoid placeholder ambiguity.
 */

const TEMPLATE_RE = /\$[A-Za-z_]\w*/g;
const VARIANT_PREFIX_RE = /^(?:each|pick):/;

/**
 * Strip the VSCode variant prefix (`each:` / `pick:`) from an id, leaving
 * the bare template / concrete id. Returns the input unchanged if no
 * prefix is present.
 */
export function stripVariantPrefix(id: string): string {
  return id.replace(VARIANT_PREFIX_RE, "");
}

/**
 * Returns `true` if the id contains at least one `$placeholder` marker
 * (after stripping any variant prefix). Use this to detect "this is a
 * template, not a concrete id" — concrete runtime ids never contain `$`.
 */
export function hasTemplatePlaceholders(id: string): boolean {
  TEMPLATE_RE.lastIndex = 0;
  return TEMPLATE_RE.test(stripVariantPrefix(id));
}

/**
 * Build a regex that matches concrete runtime ids against a template id.
 * Internal — exposed via `matchesTemplateId` and `findTemplateMatch`. If
 * the input has no placeholders, returns `undefined` (caller should do an
 * exact-string compare instead).
 *
 * Each `$word` placeholder becomes `.*` (greedy). The regex is anchored
 * (`^...$`) and case-insensitive (`/i`).
 */
function templateIdToRegExp(id: string): RegExp | undefined {
  const normalized = stripVariantPrefix(id);
  TEMPLATE_RE.lastIndex = 0;
  if (!TEMPLATE_RE.test(normalized)) return undefined;

  TEMPLATE_RE.lastIndex = 0;
  let lastIndex = 0;
  let pattern = "^";
  let match: RegExpExecArray | null;
  while ((match = TEMPLATE_RE.exec(normalized)) !== null) {
    pattern += escapeRegExp(normalized.slice(lastIndex, match.index));
    pattern += ".*";
    lastIndex = match.index + match[0].length;
  }
  pattern += escapeRegExp(normalized.slice(lastIndex));
  pattern += "$";
  return new RegExp(pattern, "i");
}

/**
 * Returns `true` if `concreteId` is a substituted instance of `templateId`.
 *
 * Both inputs are normalised (variant prefix stripped, lowercased before
 * exact compare). For `test.each([{id: "alpha"}])({ id: "case-$id" })`
 * the runtime emits `"case-alpha"` — `matchesTemplateId("case-$id",
 * "case-alpha")` returns `true`.
 *
 * Exact-id ties pass through unchanged: `matchesTemplateId("health",
 * "health")` is `true` even though `"health"` has no placeholders.
 */
export function matchesTemplateId(templateId: string, concreteId: string): boolean {
  const normalizedTemplate = stripVariantPrefix(templateId).toLowerCase();
  const normalizedConcrete = stripVariantPrefix(concreteId).toLowerCase();
  if (normalizedTemplate === normalizedConcrete) return true;
  return templateIdToRegExp(templateId)?.test(stripVariantPrefix(concreteId)) ?? false;
}

/**
 * Permissive filter match — used by CLI / MCP `--filter <id>` so the user
 * can target a row by its concrete id while only the template appears in
 * static meta. Acceptance order:
 *   1. Empty filter → match (caller wants everything).
 *   2. Filter substring of the template (template `case-$id` matches filter
 *      `case`).
 *   3. Filter is a substituted instance (template `case-$id`, filter
 *      `case-101`).
 *   4. Filter starts with the template's literal prefix (template
 *      `case-$id`, filter `case-101-extra`).
 *
 * Slightly more permissive than `matchesTemplateId` — designed for human
 * `--filter` input, not strict harness event matching.
 */
export function matchesTemplateFilter(templateId: string, filter: string): boolean {
  const normalizedFilter = stripVariantPrefix(filter).toLowerCase().trim();
  if (!normalizedFilter) return true;

  const normalizedTemplate = stripVariantPrefix(templateId).toLowerCase();
  if (normalizedTemplate.includes(normalizedFilter)) return true;
  if (matchesTemplateId(templateId, normalizedFilter)) return true;

  const prefix = normalizedTemplate.split(TEMPLATE_RE)[0] ?? "";
  return prefix.length > 0 && normalizedFilter.startsWith(prefix);
}

/**
 * Find the static meta entry whose id matches `concreteId`. Prefers exact
 * matches over template matches — so if both `case-$id` and `case-101`
 * exist statically (rare but possible), the concrete row event for
 * `case-101` resolves to the concrete entry, not the template.
 *
 * If multiple template entries could match (e.g. two overlapping
 * placeholders), returns the first one in array order — no warning. Avoid
 * collisions by namespacing template ids per file.
 */
export function findTemplateMatch<T extends { id: string }>(
  items: readonly T[],
  concreteId: string,
): T | undefined {
  const normalizedConcrete = stripVariantPrefix(concreteId).toLowerCase();
  const exact = items.find(
    (item) => stripVariantPrefix(item.id).toLowerCase() === normalizedConcrete,
  );
  return exact ?? items.find((item) => matchesTemplateId(item.id, concreteId));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
