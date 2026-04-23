/**
 * OpenAPI generation for HTTP contracts.
 *
 * Two public functions:
 *   - `buildOpenApiPartForHttp(contract)` → partial OpenAPI document for a
 *     single HTTP contract. Used as HTTP adapter's `artifacts.openapi`
 *     producer.
 *   - `mergeOpenApiParts(parts, options)` → combine partial docs into a
 *     full OpenAPI document with info / tags / components / paths. Used as
 *     `openapiArtifact.merge`.
 *
 * Logic ported from `packages/mcp/src/index.ts` `contractsToOpenApi` (CAR-1
 * Phase 2 — the two-way split of the former 250-line monolith:
 * per-contract path+operation build stays with the HTTP adapter, final
 * assembly moves to the artifact kind). Behavior is byte-for-byte
 * preserved; `packages/mcp/src/openapi-integration.test.ts` guards the
 * contract.
 */

import type { ExtractedContractProjection } from "../contract-types.js";
import type { HttpContractMeta, HttpSafeSchemas } from "./types.js";

// =============================================================================
// OpenAPI document shape (loose — OpenAPI 3.1 is open-ended)
// =============================================================================

export type OpenApiDocument = Record<string, unknown>;

export interface OpenApiOptions {
  title?: string;
  version?: string;
  servers?: Array<{ url: string; description?: string }>;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Map HttpSecurityScheme to OpenAPI securitySchemes entry + scheme name.
 * Uses instanceName to disambiguate when multiple instances use different
 * apiKey/oauth2 configurations (bearer/basic are canonical and shared).
 */
function securityToOpenApi(
  security: unknown,
  instanceName?: string,
): { name: string; scheme: Record<string, unknown> } | null {
  if (!security) return null;
  if (security === "bearer")
    return { name: "bearerAuth", scheme: { type: "http", scheme: "bearer" } };
  if (security === "basic")
    return { name: "basicAuth", scheme: { type: "http", scheme: "basic" } };
  if (typeof security === "object" && security !== null) {
    const s = security as Record<string, unknown>;
    const suffix = instanceName ? `_${instanceName}` : "";
    if (s.type === "apiKey")
      return {
        name: `apiKeyAuth${suffix}`,
        scheme: { type: "apiKey", name: s.name, in: s.in },
      };
    if (s.type === "oauth2")
      return {
        name: `oauth2Auth${suffix}`,
        scheme: { type: "oauth2", flows: s.flows },
      };
  }
  return null;
}

/**
 * Shape-compatible subset of `ExtractedContractProjection<HttpSafeSchemas,
 * HttpContractMeta>` + scanner's `NormalizedContractMeta` + pre-v0.2
 * flattened fixtures that the per-contract OpenAPI builder accepts as
 * input. Fields are read via `readContractFields` which handles both
 * nested (`c.schemas.request.body`) and flat (`c.requestSchema`) shapes —
 * matches the legacy behavior of MCP's former `toLegacyHttpContract`.
 */
type OpenApiSourceContract = {
  id: string;
  protocol: string;
  target: string;
  description?: string;
  feature?: string;
  instanceName?: string;
  tags?: string[];
  deprecated?: string;
  extensions?: Record<string, unknown>;
  cases: Array<{
    key: string;
    description?: string;
    lifecycle?: string;
    severity?: string;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
};

interface ContractFields {
  security: unknown;
  requestBody: unknown;
  requestContentType: string | undefined;
  requestHeaders: unknown;
  requestExample: unknown;
  requestExamples:
    | Record<string, { value: unknown; summary?: string; description?: string }>
    | undefined;
}

interface CaseFields {
  status: number | undefined;
  responseBody: unknown;
  responseContentType: string | undefined;
  responseHeaders: unknown;
  examples:
    | Record<string, { value: unknown; summary?: string; description?: string }>
    | undefined;
  paramSchemas:
    | Record<
        string,
        {
          schema?: unknown;
          description?: string;
          required?: boolean;
          deprecated?: boolean;
        }
      >
    | undefined;
  querySchemas:
    | Record<
        string,
        {
          schema?: unknown;
          description?: string;
          required?: boolean;
          deprecated?: boolean;
        }
      >
    | undefined;
}

/**
 * Read HTTP fields from either nested (v0.2+) or flat (pre-v0.2 fixture)
 * shape. Mirrors MCP's former `toLegacyHttpContract` dual-read.
 */
function readContractFields(c: OpenApiSourceContract): ContractFields {
  const cAny = c as Record<string, unknown>;
  const schemas = cAny.schemas as
    | {
        request?: {
          body?: unknown;
          contentType?: string;
          headers?: unknown;
          example?: unknown;
          examples?: Record<
            string,
            { value: unknown; summary?: string; description?: string }
          >;
        };
        security?: unknown;
      }
    | undefined;
  return {
    security: schemas?.security ?? cAny.security,
    requestBody: schemas?.request?.body ?? cAny.requestSchema,
    requestContentType:
      (schemas?.request?.contentType as string | undefined) ??
      (cAny.requestContentType as string | undefined),
    requestHeaders: schemas?.request?.headers ?? cAny.requestHeaders,
    requestExample: schemas?.request?.example ?? cAny.requestExample,
    requestExamples: (schemas?.request?.examples ??
      cAny.requestExamples) as ContractFields["requestExamples"],
  };
}

function readCaseFields(cas: OpenApiSourceContract["cases"][number]): CaseFields {
  const csAny = cas as Record<string, unknown>;
  const cs_schemas = csAny.schemas as
    | {
        response?: {
          status?: number;
          body?: unknown;
          contentType?: string;
          headers?: unknown;
          example?: unknown;
          examples?: Record<
            string,
            { value: unknown; summary?: string; description?: string }
          >;
        };
        params?: Record<
          string,
          {
            schema?: unknown;
            description?: string;
            required?: boolean;
            deprecated?: boolean;
          }
        >;
        query?: Record<
          string,
          {
            schema?: unknown;
            description?: string;
            required?: boolean;
            deprecated?: boolean;
          }
        >;
      }
    | undefined;
  const response = cs_schemas?.response;
  const protocolExpect = csAny.protocolExpect as
    | { status?: number }
    | undefined;
  return {
    status: response?.status ?? protocolExpect?.status,
    responseBody: response?.body ?? csAny.responseSchema,
    responseContentType:
      (response?.contentType as string | undefined) ??
      (csAny.responseContentType as string | undefined),
    responseHeaders: response?.headers ?? csAny.responseHeaders,
    examples: (response?.examples ??
      csAny.examples) as CaseFields["examples"],
    paramSchemas: (cs_schemas?.params ??
      csAny.paramSchemas) as CaseFields["paramSchemas"],
    querySchemas: (cs_schemas?.query ??
      csAny.querySchemas) as CaseFields["querySchemas"],
  };
}

// =============================================================================
// Per-contract builder (HTTP adapter's artifacts.openapi producer)
// =============================================================================

/**
 * Build a partial OpenAPI document for a single HTTP contract.
 *
 * Returns an object containing only the fields this contract contributes:
 * a single `paths[apiPath][method]` entry, the `tags` it references (from
 * `feature`), and the `components.securitySchemes` entry it needs (if any).
 * Cross-contract fields (`openapi`, `info`, full `tags` array, full
 * `components`) are materialized by `mergeOpenApiParts`.
 *
 * Returns `null` for non-HTTP protocols or malformed targets; the render
 * pipeline drops null parts.
 */
export function buildOpenApiPartForHttp(
  projection: ExtractedContractProjection<HttpSafeSchemas, HttpContractMeta>,
): OpenApiDocument | null {
  const c = projection as unknown as OpenApiSourceContract;

  if (c.protocol !== "http") return null;

  const match = c.target.match(
    /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i,
  );
  if (!match) return null;
  const method = match[1].toLowerCase();
  let apiPath = match[2];

  // Convert :param to {param} for OpenAPI
  apiPath = apiPath.replace(/:(\w+)/g, "{$1}");

  // Dual-shape field reads (nested v0.2+ / flat pre-v0.2 fixtures)
  const fields = readContractFields(c);

  // Collect security scheme
  const secMapping = securityToOpenApi(fields.security, c.instanceName);

  // Build responses — merge cases per status code + content type.
  type ContentBucket = {
    schema?: unknown;
    examples: Record<
      string,
      { value: unknown; summary?: string; description?: string }
    >;
  };
  type StatusBucket = {
    description: string;
    contents: Record<string, ContentBucket>;
    headers: Record<string, { schema: unknown }>;
  };
  const responses: Record<string, StatusBucket> = {};

  for (const cas of c.cases) {
    const casFields = readCaseFields(cas);
    const statusCode = String(casFields.status ?? 200);
    const contentType = casFields.responseContentType ?? "application/json";

    if (!responses[statusCode]) {
      responses[statusCode] = {
        description: cas.description ?? "",
        contents: {},
        headers: {},
      };
    }
    const resp = responses[statusCode];

    if (!resp.contents[contentType]) {
      resp.contents[contentType] = { examples: {} };
    }
    const bucket = resp.contents[contentType];

    // First non-undefined schema per (status, contentType) wins.
    if (!bucket.schema && casFields.responseBody) {
      bucket.schema = casFields.responseBody;
    }

    // Examples merge. Prefix with case key to guarantee uniqueness.
    if (casFields.examples) {
      for (const [exName, ex] of Object.entries(casFields.examples)) {
        const fullName = exName === "default" ? cas.key : `${cas.key}_${exName}`;
        bucket.examples[fullName] = ex;
      }
    }

    // Response headers merge at status level (first wins per header name).
    if (casFields.responseHeaders) {
      const headersSchema = casFields.responseHeaders as {
        properties?: Record<string, unknown>;
      };
      if (headersSchema?.properties) {
        for (const [headerName, headerSchema] of Object.entries(
          headersSchema.properties,
        )) {
          if (!resp.headers[headerName]) {
            resp.headers[headerName] = { schema: headerSchema };
          }
        }
      }
    }
  }

  // Finalize response shape for OpenAPI
  const openApiResponses: Record<string, unknown> = {};
  for (const [status, resp] of Object.entries(responses)) {
    const out: Record<string, unknown> = { description: resp.description };
    const contentOut: Record<string, unknown> = {};
    for (const [ctype, bucket] of Object.entries(resp.contents)) {
      if (bucket.schema || Object.keys(bucket.examples).length > 0) {
        const entry: Record<string, unknown> = {};
        if (bucket.schema) entry.schema = bucket.schema;
        if (Object.keys(bucket.examples).length > 0)
          entry.examples = bucket.examples;
        contentOut[ctype] = entry;
      }
    }
    if (Object.keys(contentOut).length > 0) out.content = contentOut;
    if (Object.keys(resp.headers).length > 0) out.headers = resp.headers;
    openApiResponses[status] = out;
  }

  // Build operation
  const operation: Record<string, unknown> = {
    operationId: c.id,
    summary: c.description,
    responses: openApiResponses,
  };
  if (c.feature) operation.tags = [c.feature];

  // Contract-level deprecated flag
  if (c.deprecated) {
    operation.deprecated = true;
    operation["x-deprecated-reason"] = c.deprecated;
  }

  // Contract-level OpenAPI extensions (x-* keys)
  if (c.extensions) {
    for (const [extKey, extVal] of Object.entries(c.extensions)) {
      operation[extKey] = extVal;
    }
  }

  // Operation-level security from contract instance
  if (secMapping) {
    operation.security = [{ [secMapping.name]: [] }];
  } else if (fields.security === null) {
    operation.security = []; // explicitly public
  }

  // Merge per-param/per-query metadata across ALL cases at FIELD level.
  type ParamMetaMap = Record<
    string,
    {
      schema?: unknown;
      description?: string;
      required?: boolean;
      deprecated?: boolean;
    }
  >;
  const mergeFieldLevel = (
    target: ParamMetaMap,
    source: ParamMetaMap | undefined,
  ) => {
    if (!source) return;
    for (const [name, meta] of Object.entries(source)) {
      if (!target[name]) target[name] = {};
      const slot = target[name];
      if (slot.schema === undefined && meta.schema !== undefined)
        slot.schema = meta.schema;
      if (slot.description === undefined && meta.description !== undefined)
        slot.description = meta.description;
      if (slot.required === undefined && meta.required !== undefined)
        slot.required = meta.required;
      if (slot.deprecated === undefined && meta.deprecated !== undefined)
        slot.deprecated = meta.deprecated;
    }
  };
  const mergedParamMetas: ParamMetaMap = {};
  const mergedQueryMetas: ParamMetaMap = {};
  for (const cas of c.cases) {
    const casFields = readCaseFields(cas);
    mergeFieldLevel(mergedParamMetas, casFields.paramSchemas);
    mergeFieldLevel(mergedQueryMetas, casFields.querySchemas);
  }

  // Extract path parameters from URL and attach merged metadata
  const paramMatches = apiPath.matchAll(/\{(\w+)\}/g);
  const pathParams = [...paramMatches].map((m) => {
    const name = m[1];
    const meta = mergedParamMetas[name];
    return {
      name,
      in: "path",
      required: meta?.required ?? true,
      schema: meta?.schema ?? { type: "string" },
      ...(meta?.description ? { description: meta.description } : {}),
      ...(meta?.deprecated ? { deprecated: true } : {}),
    };
  });
  // Query parameters (only ones with metadata)
  const queryParams = Object.entries(mergedQueryMetas).map(([name, meta]) => ({
    name,
    in: "query",
    required: meta.required ?? false,
    schema: meta.schema ?? { type: "string" },
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.deprecated ? { deprecated: true } : {}),
  }));

  // Request header parameters from contract-level request.headers schema.
  const headerParams: Array<Record<string, unknown>> = [];
  const reqHeadersSchema = fields.requestHeaders as
    | { properties?: Record<string, unknown>; required?: unknown }
    | undefined;
  if (
    reqHeadersSchema &&
    typeof reqHeadersSchema === "object" &&
    reqHeadersSchema.properties
  ) {
    const requiredList: string[] = Array.isArray(reqHeadersSchema.required)
      ? (reqHeadersSchema.required as string[])
      : [];
    for (const [headerName, headerSchema] of Object.entries(
      reqHeadersSchema.properties,
    )) {
      headerParams.push({
        name: headerName,
        in: "header",
        required: requiredList.includes(headerName),
        schema: headerSchema,
      });
    }
  }

  const allParams = [...pathParams, ...queryParams, ...headerParams];
  if (allParams.length > 0) operation.parameters = allParams;

  // Request body (schema + examples)
  if (
    fields.requestBody ||
    fields.requestExample !== undefined ||
    fields.requestExamples
  ) {
    const reqContentType = fields.requestContentType ?? "application/json";
    const contentEntry: Record<string, unknown> = {};
    if (fields.requestBody) contentEntry.schema = fields.requestBody;

    const exMap: Record<
      string,
      { value: unknown; summary?: string; description?: string }
    > = {};
    if (fields.requestExample !== undefined) {
      exMap.default = { value: fields.requestExample };
    }
    if (fields.requestExamples) {
      for (const [k, v] of Object.entries(fields.requestExamples)) {
        exMap[k] = v;
      }
    }
    if (Object.keys(exMap).length > 0) contentEntry.examples = exMap;

    operation.requestBody = {
      content: { [reqContentType]: contentEntry },
    };
  }

  // Assemble the partial doc
  const partial: OpenApiDocument = {
    paths: {
      [apiPath]: {
        [method]: operation,
      },
    },
  };

  if (c.feature) {
    partial.tags = [{ name: c.feature }];
  }

  if (secMapping) {
    partial.components = {
      securitySchemes: { [secMapping.name]: secMapping.scheme },
    };
  }

  return partial;
}

// =============================================================================
// Merge: combine partial docs into a full OpenAPI document
// =============================================================================

/**
 * Combine per-contract partials into a full OpenAPI 3.1 document.
 *
 * - `paths`: deep-merge at 2 levels (same path, different methods combine)
 * - `components.securitySchemes`: union by name (first wins on collision;
 *   name uniqueness is handled at part construction via `instanceName` suffix)
 * - `tags`: dedupe by name across parts
 * - `info`: built from options.title / options.version (defaults match MCP)
 * - `servers`: from options, if present
 *
 * Null / non-contributing parts are filtered by the render pipeline before
 * reaching here.
 */
export function mergeOpenApiParts(
  parts: OpenApiDocument[],
  options?: OpenApiOptions,
): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  const tagsByName = new Map<string, { name: string; [k: string]: unknown }>();
  const securitySchemes: Record<string, Record<string, unknown>> = {};

  for (const part of parts) {
    const partPaths = (part.paths ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    for (const [apiPath, methods] of Object.entries(partPaths)) {
      if (!paths[apiPath]) paths[apiPath] = {};
      for (const [method, operation] of Object.entries(methods)) {
        // Same path + method collision shouldn't happen (ids unique) but if it
        // does, first-wins matches MCP's Object.assign semantics.
        if (!paths[apiPath][method]) {
          paths[apiPath][method] = operation;
        }
      }
    }

    const partTags = (part.tags ?? []) as Array<{
      name: string;
      [k: string]: unknown;
    }>;
    for (const tag of partTags) {
      if (tag?.name && !tagsByName.has(tag.name)) tagsByName.set(tag.name, tag);
    }

    const partSchemes = ((part.components ?? {}) as {
      securitySchemes?: Record<string, Record<string, unknown>>;
    }).securitySchemes;
    if (partSchemes) {
      for (const [name, scheme] of Object.entries(partSchemes)) {
        if (!securitySchemes[name]) securitySchemes[name] = scheme;
      }
    }
  }

  const title = options?.title ?? "API Specification";
  const version = options?.version ?? "1.0.0";

  const doc: OpenApiDocument = {
    openapi: "3.1.0",
    info: { title, version },
  };

  if (options?.servers && options.servers.length > 0) {
    doc.servers = options.servers;
  }

  if (tagsByName.size > 0) {
    doc.tags = [...tagsByName.values()];
  }

  if (Object.keys(securitySchemes).length > 0) {
    doc.components = { securitySchemes };
  }

  doc.paths = paths;

  return doc;
}

/**
 * Empty OpenAPI 3.1 skeleton returned when no HTTP contract contributes a
 * part (e.g. a project with only gRPC / GraphQL contracts, or an empty
 * project). Used as `openapiArtifact.empty` so callers always receive a
 * valid `OpenApiDocument`.
 */
export const emptyOpenApiDocument: OpenApiDocument = {
  openapi: "3.1.0",
  info: { title: "", version: "0.0.0" },
  paths: {},
};
