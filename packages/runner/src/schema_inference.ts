/**
 * JSON Schema inference + deep truncation utilities.
 *
 * Used by the harness to generate AI-friendly trace data:
 * - inferJsonSchema: derive a JSON Schema from a sample value
 * - truncateDeep: recursively truncate arrays and long strings for token efficiency
 */

const MAX_DEPTH = 10;

// ── Schema Inference ────────────────────────────────────────────────────────

/**
 * Infer a JSON Schema from a runtime value.
 *
 * - Objects → `{ type: "object", properties, required }`
 * - Arrays → `{ type: "array", items: <schema of first item>, _itemCount }`
 * - Primitives → `{ type: "string" | "number" | "boolean" | "null" }`
 * - Depth-limited to prevent pathological inputs.
 */
export function inferJsonSchema(
  value: unknown,
  depth = 0,
): Record<string, unknown> {
  if (depth >= MAX_DEPTH) {
    return {};
  }

  if (value === null) {
    return { type: "null" };
  }

  if (value === undefined) {
    return {};
  }

  switch (typeof value) {
    case "string":
      return { type: "string" };
    case "number":
      return Number.isInteger(value)
        ? { type: "integer" }
        : { type: "number" };
    case "boolean":
      return { type: "boolean" };
  }

  if (Array.isArray(value)) {
    const schema: Record<string, unknown> = {
      type: "array",
      _itemCount: value.length,
    };
    if (value.length > 0) {
      schema.items = inferJsonSchema(value[0], depth + 1);
    } else {
      schema.items = {};
    }
    return schema;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const key of keys) {
      properties[key] = inferJsonSchema(obj[key], depth + 1);
      if (obj[key] !== null && obj[key] !== undefined) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  return {};
}

// ── Deep Truncation ─────────────────────────────────────────────────────────

export interface TruncateOptions {
  /** Max array items to keep. Default: 3. */
  maxItems?: number;
  /** Max string length before truncating. Default: 80. */
  maxStringLength?: number;
}

/**
 * Recursively walk an object tree and truncate:
 * - Arrays longer than maxItems → keep first N + annotation
 * - Strings longer than maxStringLength → keep first N chars + annotation
 *
 * Designed for AI token efficiency (map tile data, base64 blobs, etc.)
 */
export function truncateDeep(
  value: unknown,
  options: TruncateOptions = {},
  depth = 0,
): unknown {
  const { maxItems = 3, maxStringLength = 80 } = options;

  if (depth >= MAX_DEPTH) return value;

  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (value.length > maxStringLength) {
      return `${value.slice(0, maxStringLength)}...[${value.length}]`;
    }
    return value;
  }

  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    const truncated = value.length > maxItems
      ? [
          ...value.slice(0, maxItems).map((item) =>
            truncateDeep(item, options, depth + 1),
          ),
          `(${value.length - maxItems} more items truncated)`,
        ]
      : value.map((item) => truncateDeep(item, options, depth + 1));
    return truncated;
  }

  // Object: recurse into values
  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    result[key] = truncateDeep(val, options, depth + 1);
  }
  return result;
}

/** @deprecated Use truncateDeep instead */
export const truncateArraysDeep = truncateDeep;
