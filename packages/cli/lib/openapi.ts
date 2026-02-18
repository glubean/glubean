/**
 * OpenAPI parser, endpoint extractor, and semantic diff engine.
 *
 * Supports both JSON and YAML OpenAPI 3.x specs. Provides structured
 * diff output suitable for AI consumption and human-readable reports.
 */

import { parse as yamlParse } from "@std/yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal representation of a parsed OpenAPI spec. */
// deno-lint-ignore no-explicit-any
export type OpenApiSpec = Record<string, any>;

/** A single API endpoint extracted from the spec. */
export interface Endpoint {
  method: string; // uppercase: GET, POST, etc.
  path: string; // e.g. "/users/{id}"
  summary?: string;
  operationId?: string;
  tags?: string[];
  parameters?: ParameterInfo[];
  requestBody?: SchemaInfo;
  responses?: Record<string, ResponseInfo>;
  deprecated?: boolean;
}

export interface ParameterInfo {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  schema?: SchemaInfo;
}

export interface SchemaInfo {
  type?: string;
  format?: string;
  required?: string[];
  properties?: Record<string, SchemaInfo>;
  items?: SchemaInfo;
  enum?: string[];
  description?: string;
  nullable?: boolean;
  /** Raw reference path before resolution (informational) */
  $ref?: string;
}

export interface ResponseInfo {
  description?: string;
  schema?: SchemaInfo;
}

/** Result of comparing two sets of endpoints. */
export interface OpenApiDiff {
  added: Endpoint[];
  removed: Endpoint[];
  modified: EndpointChange[];
}

export interface EndpointChange {
  endpoint: Endpoint;
  changes: string[];
}

// ---------------------------------------------------------------------------
// Spec Loading
// ---------------------------------------------------------------------------

/** Auto-detect candidate OpenAPI file in a directory. */
const OPENAPI_CANDIDATES = [
  "openapi.json",
  "openapi.yaml",
  "openapi.yml",
  "swagger.json",
  "swagger.yaml",
  "swagger.yml",
];

/**
 * Try to find an OpenAPI spec file in the given directory.
 * Returns the file path if found, null otherwise.
 */
export async function findOpenApiSpec(dir: string): Promise<string | null> {
  for (const name of OPENAPI_CANDIDATES) {
    const path = `${dir}/${name}`;
    try {
      await Deno.stat(path);
      return path;
    } catch {
      // not found, try next
    }
  }
  return null;
}

/**
 * Load and parse an OpenAPI spec from disk.
 * Auto-detects JSON vs YAML by file extension.
 */
export async function loadOpenApiSpec(filePath: string): Promise<OpenApiSpec> {
  const content = await Deno.readTextFile(filePath);
  return parseOpenApiContent(content, filePath);
}

/**
 * Parse OpenAPI content from a string, using the file path to detect format.
 */
export function parseOpenApiContent(
  content: string,
  filePath: string,
): OpenApiSpec {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".json")) {
    return JSON.parse(content) as OpenApiSpec;
  }
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) {
    return yamlParse(content) as OpenApiSpec;
  }
  // Fallback: try JSON first, then YAML
  try {
    return JSON.parse(content) as OpenApiSpec;
  } catch {
    return yamlParse(content) as OpenApiSpec;
  }
}

// ---------------------------------------------------------------------------
// $ref Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a JSON pointer like "#/components/schemas/User" against the root spec.
 */
// deno-lint-ignore no-explicit-any
function resolvePointer(root: OpenApiSpec, pointer: string): any {
  if (!pointer.startsWith("#/")) return undefined;
  const parts = pointer.substring(2).split("/");
  // deno-lint-ignore no-explicit-any
  let current: any = root;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Deep-resolve all $ref references in an object, inlining them.
 * Tracks visited refs to avoid infinite recursion.
 */
export function resolveRefs(
  root: OpenApiSpec,
  // deno-lint-ignore no-explicit-any
  obj: any,
  visited = new Set<string>(),
  // deno-lint-ignore no-explicit-any
): any {
  if (obj == null || typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => resolveRefs(root, item, visited));
  }

  if (typeof obj.$ref === "string") {
    const ref = obj.$ref as string;
    if (visited.has(ref)) {
      return { $ref: ref, _circular: true };
    }
    visited.add(ref);
    const resolved = resolvePointer(root, ref);
    if (resolved != null) {
      return resolveRefs(root, resolved, visited);
    }
    return obj;
  }

  // deno-lint-ignore no-explicit-any
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = resolveRefs(root, value, visited);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Endpoint Extraction
// ---------------------------------------------------------------------------

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
];

/**
 * Convert a raw OpenAPI schema object into a simplified SchemaInfo.
 */
// deno-lint-ignore no-explicit-any
function toSchemaInfo(raw: any): SchemaInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const info: SchemaInfo = {};
  if (raw.type) info.type = raw.type;
  if (raw.format) info.format = raw.format;
  if (raw.enum) info.enum = raw.enum;
  if (raw.description) info.description = raw.description;
  if (raw.nullable) info.nullable = raw.nullable;
  if (raw.required) info.required = raw.required;
  if (raw.$ref) info.$ref = raw.$ref;
  if (raw.items) info.items = toSchemaInfo(raw.items);
  if (raw.properties) {
    info.properties = {};
    for (const [key, val] of Object.entries(raw.properties)) {
      const s = toSchemaInfo(val);
      if (s) info.properties[key] = s;
    }
  }
  return info;
}

/**
 * Extract all endpoints from an OpenAPI spec.
 */
export function extractEndpoints(spec: OpenApiSpec): Endpoint[] {
  const endpoints: Endpoint[] = [];
  const paths = spec.paths;
  if (!paths || typeof paths !== "object") return endpoints;

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;

    for (const method of HTTP_METHODS) {
      // deno-lint-ignore no-explicit-any
      const operation = (pathItem as Record<string, any>)[method];
      if (!operation) continue;

      // Resolve refs within the operation
      const resolved = resolveRefs(spec, operation);

      const endpoint: Endpoint = {
        method: method.toUpperCase(),
        path,
        summary: resolved.summary,
        operationId: resolved.operationId,
        tags: resolved.tags,
        deprecated: resolved.deprecated,
      };

      // Parameters (merge path-level and operation-level)
      // deno-lint-ignore no-explicit-any
      const pathParams = (pathItem as Record<string, any>).parameters || [];
      const opParams = resolved.parameters || [];
      const allParams = [...resolveRefs(spec, pathParams), ...opParams];
      if (allParams.length > 0) {
        endpoint.parameters = allParams.map(
          // deno-lint-ignore no-explicit-any
          (p: any) => ({
            name: p.name,
            in: p.in,
            required: p.required,
            schema: toSchemaInfo(p.schema),
          }),
        );
      }

      // Request body
      if (resolved.requestBody) {
        const content = resolved.requestBody.content;
        const jsonSchema = content?.["application/json"]?.schema;
        if (jsonSchema) {
          endpoint.requestBody = toSchemaInfo(jsonSchema);
        }
      }

      // Responses
      if (resolved.responses) {
        endpoint.responses = {};
        for (const [status, resp] of Object.entries(resolved.responses)) {
          // deno-lint-ignore no-explicit-any
          const respObj = resp as Record<string, any>;
          const respInfo: ResponseInfo = {
            description: respObj.description,
          };
          const respContent = respObj.content?.["application/json"]?.schema;
          if (respContent) {
            respInfo.schema = toSchemaInfo(respContent);
          }
          endpoint.responses[status] = respInfo;
        }
      }

      endpoints.push(endpoint);
    }
  }

  return endpoints;
}

// ---------------------------------------------------------------------------
// Semantic Diff
// ---------------------------------------------------------------------------

/** Create a unique key for an endpoint. */
function endpointKey(ep: Endpoint): string {
  return `${ep.method} ${ep.path}`;
}

/**
 * Compare two sets of schema properties and return human-readable change descriptions.
 */
function diffSchemaProperties(
  baseProp: Record<string, SchemaInfo> | undefined,
  headProp: Record<string, SchemaInfo> | undefined,
  prefix: string,
): string[] {
  const changes: string[] = [];
  const baseKeys = new Set(Object.keys(baseProp || {}));
  const headKeys = new Set(Object.keys(headProp || {}));

  for (const key of headKeys) {
    if (!baseKeys.has(key)) {
      const schema = headProp![key];
      const typePart = schema.type || "unknown";
      const enumPart = schema.enum ? ` (${schema.enum.join(" | ")})` : "";
      changes.push(`+ ${prefix}.${key} (${typePart}${enumPart})`);
    }
  }

  for (const key of baseKeys) {
    if (!headKeys.has(key)) {
      changes.push(`- ${prefix}.${key}`);
    }
  }

  // Check type changes for common keys
  for (const key of baseKeys) {
    if (!headKeys.has(key)) continue;
    const baseSchema = baseProp![key];
    const headSchema = headProp![key];
    if (baseSchema.type !== headSchema.type) {
      changes.push(
        `~ ${prefix}.${key}: ${baseSchema.type || "unknown"} → ${headSchema.type || "unknown"}`,
      );
    }
  }

  return changes;
}

/**
 * Compare two sets of required fields and return change descriptions.
 */
function diffRequired(
  baseReq: string[] | undefined,
  headReq: string[] | undefined,
  prefix: string,
): string[] {
  const changes: string[] = [];
  const baseSet = new Set(baseReq || []);
  const headSet = new Set(headReq || []);

  for (const field of headSet) {
    if (!baseSet.has(field)) {
      changes.push(`~ ${prefix}.${field}: optional → required`);
    }
  }
  for (const field of baseSet) {
    if (!headSet.has(field)) {
      changes.push(`~ ${prefix}.${field}: required → optional`);
    }
  }
  return changes;
}

/**
 * Compare two endpoints and return a list of change descriptions.
 */
function diffSingleEndpoint(base: Endpoint, head: Endpoint): string[] {
  const changes: string[] = [];

  // Summary change
  if (base.summary !== head.summary && head.summary) {
    changes.push(`~ summary: "${head.summary}"`);
  }

  // Deprecated change
  if (!base.deprecated && head.deprecated) {
    changes.push(`~ deprecated: true`);
  } else if (base.deprecated && !head.deprecated) {
    changes.push(`~ deprecated: false`);
  }

  // Request body changes
  if (base.requestBody || head.requestBody) {
    changes.push(
      ...diffSchemaProperties(
        base.requestBody?.properties,
        head.requestBody?.properties,
        "request.body",
      ),
    );
    changes.push(
      ...diffRequired(
        base.requestBody?.required,
        head.requestBody?.required,
        "request.body",
      ),
    );
  }

  // Parameter changes
  const baseParams = new Map(
    (base.parameters || []).map((p) => [`${p.in}:${p.name}`, p]),
  );
  const headParams = new Map(
    (head.parameters || []).map((p) => [`${p.in}:${p.name}`, p]),
  );

  for (const [key, param] of headParams) {
    if (!baseParams.has(key)) {
      const req = param.required ? "required" : "optional";
      changes.push(`+ parameter ${param.in}:${param.name} (${req})`);
    }
  }
  for (const [key, param] of baseParams) {
    if (!headParams.has(key)) {
      changes.push(`- parameter ${param.in}:${param.name}`);
    }
  }

  // Response changes (check each status code)
  const baseResp = base.responses || {};
  const headResp = head.responses || {};
  const allStatuses = new Set([
    ...Object.keys(baseResp),
    ...Object.keys(headResp),
  ]);

  for (const status of allStatuses) {
    if (!baseResp[status] && headResp[status]) {
      changes.push(`+ response ${status}`);
    } else if (baseResp[status] && !headResp[status]) {
      changes.push(`- response ${status}`);
    } else if (baseResp[status] && headResp[status]) {
      changes.push(
        ...diffSchemaProperties(
          baseResp[status].schema?.properties,
          headResp[status].schema?.properties,
          `response.${status}`,
        ),
      );
      changes.push(
        ...diffRequired(
          baseResp[status].schema?.required,
          headResp[status].schema?.required,
          `response.${status}`,
        ),
      );
    }
  }

  return changes;
}

/**
 * Compute a semantic diff between two sets of endpoints.
 */
export function diffEndpoints(base: Endpoint[], head: Endpoint[]): OpenApiDiff {
  const baseMap = new Map(base.map((ep) => [endpointKey(ep), ep]));
  const headMap = new Map(head.map((ep) => [endpointKey(ep), ep]));

  const added: Endpoint[] = [];
  const removed: Endpoint[] = [];
  const modified: EndpointChange[] = [];

  // Find added and modified
  for (const [key, ep] of headMap) {
    const baseEp = baseMap.get(key);
    if (!baseEp) {
      added.push(ep);
    } else {
      const changes = diffSingleEndpoint(baseEp, ep);
      if (changes.length > 0) {
        modified.push({ endpoint: ep, changes });
      }
    }
  }

  // Find removed
  for (const [key, ep] of baseMap) {
    if (!headMap.has(key)) {
      removed.push(ep);
    }
  }

  return { added, removed, modified };
}

// ---------------------------------------------------------------------------
// Formatting Helpers
// ---------------------------------------------------------------------------

/** Format an endpoint's request body summary (one line). */
export function formatRequestBody(ep: Endpoint): string | null {
  if (!ep.requestBody?.properties) return null;
  const parts: string[] = [];
  for (const [key, schema] of Object.entries(ep.requestBody.properties)) {
    const required = ep.requestBody.required?.includes(key);
    const typePart = schema.type || "unknown";
    const enumPart = schema.enum ? ` (${schema.enum.join(" | ")})` : "";
    parts.push(`${key}${required ? "" : "?"}: ${typePart}${enumPart}`);
  }
  return `{ ${parts.join(", ")} }`;
}

/** Format an endpoint's query/path parameters summary (one line). */
export function formatParameters(ep: Endpoint): string | null {
  const queryParams = (ep.parameters || []).filter((p) => p.in === "query");
  if (queryParams.length === 0) return null;
  const parts = queryParams.map((p) => `${p.name}${p.required ? "" : "?"}`);
  return parts.join(", ");
}

/** Format a response summary for an endpoint. */
export function formatResponses(ep: Endpoint): string | null {
  if (!ep.responses) return null;
  const parts: string[] = [];
  for (const [status, resp] of Object.entries(ep.responses)) {
    if (resp.schema?.type === "object" && resp.schema.properties) {
      const keys = Object.keys(resp.schema.properties).slice(0, 4);
      const more = Object.keys(resp.schema.properties).length > 4 ? ", ..." : "";
      parts.push(`${status} → { ${keys.join(", ")}${more} }`);
    } else if (resp.description) {
      parts.push(`${status}: ${resp.description}`);
    } else {
      parts.push(status);
    }
  }
  return parts.join(", ");
}
