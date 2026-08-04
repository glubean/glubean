const REDACTED_VALUE = "[REDACTED]";

export const REQUEST_SENSITIVE_VALUES = Symbol.for(
  "@glubean/sdk/request-sensitive-values",
);

/** Read exact sensitive replacement values from ky's non-wire request context. */
export function getRequestSensitiveValues(context: unknown): string[] {
  if (!context || typeof context !== "object") return [];
  const values = (context as { [REQUEST_SENSITIVE_VALUES]?: unknown })
    [REQUEST_SENSITIVE_VALUES];
  if (!Array.isArray(values)) return [];
  const rawValues = values.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const variants = new Set<string>();
  for (const value of rawValues) {
    variants.add(value);
    variants.add(encodeURIComponent(value));
    const formEncoded = new URLSearchParams([["value", value]])
      .toString()
      .slice("value=".length);
    variants.add(formEncoded);
  }
  // Longest-first is load-bearing for overlapping values: masking "abc"
  // before "abcdef" would leave the suffix "def" visible.
  return [...variants].sort((a, b) => b.length - a.length);
}

/**
 * Deep-clone JSON-shaped trace data and replace exact session/secret fragments
 * before any trace event leaves the runner or engine process.
 */
export function maskRequestSensitiveValues(
  value: unknown,
  sensitiveValues: readonly string[],
  seen: WeakMap<object, unknown> = new WeakMap<object, unknown>(),
): unknown {
  if (sensitiveValues.length === 0) return value;
  if (typeof value === "string") {
    let masked = value;
    for (const sensitiveValue of sensitiveValues) {
      if (sensitiveValue) masked = masked.split(sensitiveValue).join(REDACTED_VALUE);
    }
    return masked;
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const masked: unknown[] = [];
    seen.set(value, masked);
    for (const entry of value) {
      masked.push(maskRequestSensitiveValues(entry, sensitiveValues, seen));
    }
    return masked;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const masked = Object.create(prototype) as Record<string, unknown>;
  seen.set(value, masked);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    masked[key] = maskRequestSensitiveValues(entry, sensitiveValues, seen);
  }
  return masked;
}
