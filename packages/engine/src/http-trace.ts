/**
 * Full-trace capture helpers for the HTTP auto-trace (Phase 4f-3) — JSON Schema
 * inference + body truncation + request-body capture. Ports the node harness's
 * schema_inference.ts + truncateBody/captureRequestBody (harness.ts:940-994) into
 * the engine. All BROWSER-SAFE: no node:* imports (Request.clone()/.text() are
 * web-standard), so the build-gate stays green.
 */

const MAX_DEPTH = 10;

/**
 * Infer a JSON Schema from a runtime value (node parity: schema_inference.ts).
 * Objects → {type:"object", properties} (no `required`); arrays → {type:"array",
 * items:<first item schema>, _itemCount}; primitives → {type}; depth-limited.
 */
export function inferJsonSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (depth >= MAX_DEPTH) return {};
  if (value === null) return { type: "null" };
  if (value === undefined) return {};

  switch (typeof value) {
    case "string":
      return { type: "string" };
    case "number":
      return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
    case "boolean":
      return { type: "boolean" };
  }

  if (Array.isArray(value)) {
    const schema: Record<string, unknown> = { type: "array", _itemCount: value.length };
    schema.items = value.length > 0 ? inferJsonSchema(value[0], depth + 1) : {};
    return schema;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const properties: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) properties[key] = inferJsonSchema(obj[key], depth + 1);
    return { type: "object", properties };
  }

  return {};
}

export interface TruncateOptions {
  /** Max array items to keep. Default: 3. */
  maxItems?: number;
  /** Max string length before truncating. Default: 80. */
  maxStringLength?: number;
}

/**
 * Recursively truncate arrays (> maxItems) + long strings (> maxStringLength) for
 * token efficiency (node parity: schema_inference.ts truncateDeep).
 */
export function truncateDeep(value: unknown, options: TruncateOptions = {}, depth = 0): unknown {
  const { maxItems = 3, maxStringLength = 80 } = options;
  if (depth >= MAX_DEPTH) return value;
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return value.length > maxStringLength ? `${value.slice(0, maxStringLength)}...[${value.length}]` : value;
  }
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.length > maxItems
      ? [
          ...value.slice(0, maxItems).map((item) => truncateDeep(item, options, depth + 1)),
          `(${value.length - maxItems} more items truncated)`,
        ]
      : value.map((item) => truncateDeep(item, options, depth + 1));
  }

  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) result[key] = truncateDeep(val, options, depth + 1);
  return result;
}

/** Max serialized body size (chars) to include in trace events (node parity). */
export const TRACE_BODY_MAX_SIZE = 1_048_576; // 1MB

/**
 * Truncate a response body if its JSON representation exceeds the size limit,
 * preserving structure (node parity: harness.ts truncateBody).
 */
export function truncateBody(body: unknown): unknown {
  try {
    const json = JSON.stringify(body);
    if (json.length <= TRACE_BODY_MAX_SIZE) return body;

    if (typeof body === "object" && body !== null) {
      if (Array.isArray(body)) {
        const preview = body.slice(0, 3);
        return [...preview, `(${body.length - 3} more items truncated)`];
      }
      const pruned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (Array.isArray(value) && value.length > 3) {
          pruned[key] = [...value.slice(0, 3), `(${value.length - 3} more items truncated)`];
        } else {
          pruned[key] = value;
        }
      }
      const rechecked = JSON.stringify(pruned);
      if (rechecked.length <= TRACE_BODY_MAX_SIZE * 1.5) return pruned;
    }

    return { _truncated: true, _sizeBytes: json.length };
  } catch {
    return "(non-serializable)";
  }
}

/**
 * Capture the outgoing request body for full-trace mode (node parity:
 * harness.ts captureRequestBody). ky 2 no longer exposes options.json, so read it
 * off a clone of the Request (parsed if JSON). Browser-safe (clone/text are web std).
 */
export async function captureRequestBody(request: Request): Promise<unknown> {
  try {
    const text = await request.clone().text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch {
    return undefined;
  }
}
