/**
 * Deep-merge helpers for HTTP adapter's executeCaseInFlow.
 *
 * Contract-flow v9 §5.1 semantics:
 *   - Lens-provided slot + case-spec slot → deep-merge at object level
 *   - Arrays replace whole (no element-wise alignment)
 *   - undefined in patch preserves the baseline
 *   - Explicit field deletion unsupported in v0.2
 */

export function mergeSlot(baseline: unknown, patch: unknown): unknown {
  if (patch === undefined) return baseline;
  if (baseline === undefined) return patch;
  return deepMergeForFlow(baseline, patch);
}

export function deepMergeForFlow(baseline: unknown, patch: unknown): unknown {
  if (!isPlainObject(baseline) || !isPlainObject(patch)) return patch;

  const out: Record<string, unknown> = { ...(baseline as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue; // preserve baseline on undefined
    out[k] = deepMergeForFlow(out[k], v);
  }
  return out;
}

function isPlainObject(v: unknown): boolean {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}
