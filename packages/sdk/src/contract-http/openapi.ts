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
    given?: string;
    hasVerify?: boolean;
    verifyRules?: unknown[];
    lifecycle?: string;
    severity?: string;
    direction?: "inbound";
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

  // OpenAPI requires every `paths` key to start with "/" (contract
  // endpoints may omit it — the HTTP adapter accepts both forms at
  // runtime, GLU-119). Normalize here so projection always emits valid
  // OpenAPI; don't double-prefix paths that already have it.
  if (!apiPath.startsWith("/")) apiPath = `/${apiPath}`;

  // Convert :param to {param} for OpenAPI
  apiPath = apiPath.replace(/:(\w+)/g, "{$1}");

  // Inbound cases (direction: "inbound", inbound-contract-design §9.2) have
  // no response of ours to document — running them through the response
  // merge below would fabricate a dummy 200 (codex I2 R1 P2). They are
  // excluded from responses/params and surfaced via x-glubean-cases; full
  // inbound rendering (OpenAPI 3.1 `webhooks` / AsyncAPI) is slice I4.
  const outboundCases = c.cases.filter((cas) => cas.direction !== "inbound");
  // An inbound-only contract has NO callable operation — emitting a path
  // with empty/fabricated responses misdocuments it. Null parts are
  // filtered by the render pipeline; the contract stays visible in
  // markdown/metadata until I4 gives it a real artifact.
  if (outboundCases.length === 0) return null;

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

  for (const cas of outboundCases) {
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

  const glubeanCases = c.cases
    .map((cas) => {
      // Inbound cases always surface here (their direction + promise are the
      // projection content); outbound cases only when they carry a marker.
      const hasProjectionMarker =
        cas.direction === "inbound" ||
        cas.given !== undefined ||
        cas.hasVerify !== undefined ||
        cas.verifyRules !== undefined;
      if (!hasProjectionMarker) return null;
      const out: Record<string, unknown> = { key: cas.key };
      if (cas.direction) out.direction = cas.direction;
      if (cas.description) out.description = cas.description;
      if (cas.given) out.given = cas.given;
      if (cas.hasVerify !== undefined) out.hasVerify = cas.hasVerify;
      if (cas.verifyRules !== undefined) out.verifyRules = cas.verifyRules;
      if (cas.lifecycle) out.lifecycle = cas.lifecycle;
      if (cas.severity) out.severity = cas.severity;
      return out;
    })
    .filter((cas): cas is Record<string, unknown> => cas !== null);
  if (glubeanCases.length > 0) {
    operation["x-glubean-cases"] = glubeanCases;
  }

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
  for (const cas of outboundCases) {
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
 * OpenAPI 3.1 Path Item Object operation keys (the fixed HTTP-verb fields).
 * Collision detection/relocation only applies to these — a Path Item can
 * also carry non-operation fields (`parameters`, `summary`, `description`,
 * `servers`, `$ref`) that have no `operationId` and aren't a "surface"
 * collision when two parts both set one; those keep the pre-existing
 * first-wins merge untouched (codex R3 P2 — routing them through the
 * collision list produced bogus `x-glubean-surface-collisions` entries
 * with e.g. `method: "parameters"`).
 */
const OPENAPI_OPERATION_KEYS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

// =============================================================================
// Component schema hoisting (GLU-127)
// =============================================================================
//
// `buildOpenApiPartForHttp` (above) always writes request/response body
// schemas INLINE — it only ever sees one contract, so it has no basis for
// deciding what's reusable. Hoisting is a document-level concern: it needs
// the full merged `paths` map to know which schemas repeat. So it runs here,
// as the last step of `mergeOpenApiParts`, after `paths` /
// `x-glubean-surface-collisions` are assembled but before the document is
// returned.
//
// Scope is deliberately narrow — only request/response BODY schemas
// (`requestBody.content[ctype].schema`, `responses[status].content[ctype].schema`)
// are candidates. Parameter schemas (path/query/header) and response header
// schemas stay inline: they're small, rarely reused across operations, and
// leaving them alone keeps this pass from touching code paths GLU-116/119/120
// just finished stabilizing.

/** Convert a contract id (`"auth.sign-in.email"`) into a PascalCase stem
 * (`"AuthSignInEmail"`) for derived component names. Splits on any
 * non-alphanumeric separator (`.`, `-`, `_`, space, `:`, ...). */
function toPascalCase(id: string): string {
  return id
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join("");
}

/** Sanitize a user-supplied JSON Schema `title` into a component name that
 * matches OpenAPI's `^[a-zA-Z0-9._-]+$` component-key grammar. Returns null
 * if nothing usable survives (e.g. title was all punctuation). */
function sanitizeComponentName(title: string): string | null {
  const cleaned = title.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!cleaned) return null;
  // A leading digit/`.`/`-` is spec-legal but reads badly as a generated
  // type name in downstream codegen — prefix with `_` instead of rejecting.
  return /^[a-zA-Z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/**
 * True when a JSON Schema is "structured" enough to be worth a named
 * component — an object with at least one declared property, or an array.
 * Bare primitives (`{"type":"string"}`) and property-less object wildcards
 * (`{"type":"object"}`) stay inline: hoisting them would mint a component
 * name for something that carries no shape information, which is noise
 * rather than reuse value. Already-hoisted / hand-authored `$ref`s are
 * left untouched (idempotent — a second `mergeOpenApiParts` pass over an
 * already-componentized doc is a no-op here).
 */
function isHoistableSchema(schema: unknown): schema is Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const s = schema as Record<string, unknown>;
  if (typeof s.$ref === "string") return false;
  if (s.type === "array") return true;
  if (s.type === "object") {
    return (
      !!s.properties &&
      typeof s.properties === "object" &&
      !Array.isArray(s.properties) &&
      Object.keys(s.properties as object).length > 0
    );
  }
  return false;
}

/**
 * Deep-sort an object's keys (recursively) and drop the ROOT schema's own
 * `title` annotation so two structurally-identical schemas hash the same
 * regardless of property insertion order or an incidental title mismatch —
 * the basis for content-based dedup ("de-dupe identical JSON Schemas to
 * avoid duplicate components", GLU-127 design notes).
 *
 * `isRoot` gates the `title` drop to depth 0 ONLY. A schema's own metadata
 * `title` (`{ type: "object", title: "ErrorResponse", properties: {...} }`)
 * is display metadata we intentionally ignore for dedup — that's the whole
 * point of the explicit-name feature. But a `title` that's a genuine SCHEMA
 * PROPERTY (`{ type: "object", properties: { title: { type: "string" } } }`
 * — e.g. a blog post's `title` field) lives one level deeper, inside
 * `properties`, where `isRoot` is already false — so it's preserved. Codex
 * R1 P2 caught the recursive version of this: it stripped `title` at every
 * depth, so `{ properties: { name, title } }` and `{ properties: { name } }`
 * canonicalized identically and dedupe-merged into the wrong shape.
 */
function canonicalizeForDedup(value: unknown, isRoot = true): unknown {
  if (Array.isArray(value)) return value.map((v) => canonicalizeForDedup(v, false));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      if (isRoot && key === "title") continue;
      out[key] = canonicalizeForDedup((value as Record<string, unknown>)[key], false);
    }
    return out;
  }
  return value;
}

/**
 * Registry that hoists schemas into `components.schemas`, returning the
 * `$ref` that replaces each inline occurrence. Content-addressed: a second
 * schema that's structurally identical to one already registered (same
 * canonicalized JSON) reuses the existing component instead of minting a
 * duplicate — this is what turns the shared `ErrorResponse` envelope in two
 * different contracts' error cases into ONE component with two `$ref`s.
 *
 * Two-phase by design (codex R2 P2): naming can't be decided the moment a
 * schema is first seen, because an EARLIER occurrence of a shared shape
 * might carry no explicit title while a LATER occurrence does (or vice
 * versa) — deciding eagerly would make the winning name depend on
 * traversal order. So `collect()` only records occurrences (grouped by
 * content key) during the walk; `finalize()` — called once, after every
 * operation has been walked — picks ONE name per group and back-fills
 * every `$ref` in that group with it.
 *
 * Naming precedence (GLU-127 design notes):
 *   1. Explicit — the schema's own JSON Schema `title` (from a user's
 *      `zod.meta({ title: "ErrorResponse" })` or equivalent), sanitized.
 *      Honored no matter which occurrence in the group carries it.
 *   2. Derived — PascalCase(contractId) + "Request"/"Response", with an
 *      optional status-code suffix (`altName`) to disambiguate a contract
 *      with more than one distinct response body shape.
 *   3. Numeric fallback (`_2`, `_3`, ...) — only reached if two DIFFERENT
 *      groups want the exact same name (rare: e.g. two contracts whose ids
 *      collide after PascalCasing, or two explicit titles collide).
 * Naming is a pure function of contract id + kind + status — not of
 * iteration order — so names are stable across runs (the whole point is a
 * diffable projection); the numeric fallback is the only path where
 * processing order can matter, and callers walk paths/statuses in sorted
 * order (and `finalize()` walks groups in first-seen order) specifically to
 * keep even that deterministic.
 */
class ComponentSchemaRegistry {
  // Object.create(null) (codex R2 P3): a plain `{}` lets a sanitized title
  // of `__proto__` (or `constructor`, ...) silently mutate the object's
  // prototype instead of creating an enumerable entry — the operation would
  // still get a `$ref` to a component that `components.schemas` never
  // actually contains. A null-prototype map has no inherited accessors to
  // hijack, so every sanitized name — however hostile — lands as a normal
  // own property.
  private readonly schemas: Record<string, unknown> = Object.create(null);
  private readonly nameToContentKey = new Map<string, string>();
  private readonly groups = new Map<
    string,
    {
      representative: Record<string, unknown>;
      explicitName: string | null;
      preferredName: string;
      altName?: string;
      entries: Array<{ schema?: unknown }>;
    }
  >();

  /** Phase 1 — record one occurrence of `schema` at `entry.schema`. Does
   * NOT assign a component name or mutate `entry` yet. */
  collect(
    entry: { schema?: unknown },
    schema: Record<string, unknown>,
    preferredName: string,
    altName?: string,
  ): void {
    const contentKey = JSON.stringify(canonicalizeForDedup(schema));
    const explicitTitle =
      typeof schema.title === "string" && schema.title.trim().length > 0
        ? sanitizeComponentName(schema.title.trim())
        : null;

    const existing = this.groups.get(contentKey);
    if (!existing) {
      this.groups.set(contentKey, {
        representative: schema,
        explicitName: explicitTitle,
        preferredName,
        altName,
        entries: [entry],
      });
      return;
    }
    // Promote an explicit title supplied by a LATER occurrence — the first
    // occurrence in traversal order doesn't get to permanently decide the
    // name just because it happened to lack a `.meta({ title })`.
    if (explicitTitle && !existing.explicitName) {
      existing.explicitName = explicitTitle;
      existing.representative = schema; // keep the titled schema as the stored component
    }
    existing.entries.push(entry);
  }

  /** Phase 2 — assign one final name per content-key group (first-seen
   * group order, so the numeric-suffix fallback stays deterministic) and
   * write the resulting `$ref` into every entry collected for that group. */
  finalize(): void {
    for (const [contentKey, group] of this.groups) {
      let candidate = group.explicitName ?? group.preferredName;
      // Preferred name already taken by a DIFFERENT group — try the
      // caller-supplied disambiguator (e.g. status-suffixed name) before
      // falling back to numeric suffixes.
      if (
        this.nameToContentKey.has(candidate) &&
        this.nameToContentKey.get(candidate) !== contentKey &&
        group.altName
      ) {
        candidate = group.altName;
      }
      const stem = candidate;
      let n = 2;
      while (
        this.nameToContentKey.has(candidate) &&
        this.nameToContentKey.get(candidate) !== contentKey
      ) {
        candidate = `${stem}_${n}`;
        n += 1;
      }

      this.nameToContentKey.set(candidate, contentKey);
      this.schemas[candidate] = group.representative;
      const ref = { $ref: `#/components/schemas/${candidate}` };
      for (const entry of group.entries) entry.schema = ref;
    }
  }

  /** `components.schemas` value, or undefined if nothing was hoisted.
   * Only meaningful after `finalize()`. */
  get componentSchemas(): Record<string, unknown> | undefined {
    return Object.keys(this.schemas).length > 0 ? this.schemas : undefined;
  }
}

/**
 * Walk one operation's request/response bodies and register any hoistable
 * schema with `registry` (phase 1 — see `ComponentSchemaRegistry`).
 * Content-type and status keys are visited in sorted order so group
 * creation order — and therefore any numeric-suffix disambiguation in
 * `finalize()` — doesn't depend on upstream extraction order.
 */
function hoistOperationSchemas(
  registry: ComponentSchemaRegistry,
  contractId: string,
  operation: Record<string, unknown>,
): void {
  const pascalId = toPascalCase(contractId) || "Contract";

  const requestBody = operation.requestBody as
    | { content?: Record<string, { schema?: unknown }> }
    | undefined;
  if (requestBody?.content) {
    for (const ctype of Object.keys(requestBody.content).sort()) {
      const entry = requestBody.content[ctype];
      if (isHoistableSchema(entry.schema)) {
        registry.collect(entry, entry.schema, `${pascalId}Request`);
      }
    }
  }

  const responses = operation.responses as
    | Record<string, { content?: Record<string, { schema?: unknown }> }>
    | undefined;
  if (responses) {
    for (const status of Object.keys(responses).sort()) {
      const content = responses[status].content;
      if (!content) continue;
      for (const ctype of Object.keys(content).sort()) {
        const entry = content[ctype];
        if (isHoistableSchema(entry.schema)) {
          registry.collect(
            entry,
            entry.schema,
            `${pascalId}Response`,
            `${pascalId}Response${status}`,
          );
        }
      }
    }
  }
}

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
 * **Same-path multi-surface collisions (GLU-116)**: Glubean contracts can
 * represent distinct surfaces/clients (different base URL, different auth)
 * that happen to share the same HTTP method + path — e.g. a dashboard BFF
 * and a public platform API both exposing `GET /health`. A plain OpenAPI
 * `paths` object can only hold one operation per method+path key, so a
 * second contract at the same key would silently overwrite (or, with
 * first-wins, silently drop) the first.
 *
 * The collision signal is simply "is `paths[path][method]` already taken?"
 * — NOT operationId equality, and NOT structural equality of the built
 * operation. Both were tried and both are unsound: contract ids are not
 * enforced globally unique across scoped instances (two different
 * `contract.http.with(...)` surfaces can each register a contract literally
 * called `"health"` — codex R4), AND two genuinely different surfaces can
 * legitimately render byte-identical operations (`instanceName` never
 * appears in the built operation — codex R5), so neither id nor content
 * equality can tell "the same contract re-encountered" apart from "a
 * different contract that happens to look the same." A merge function's
 * job is to never lose data; every operation after the first at a given
 * method+path is preserved, unconditionally — a caller that somehow feeds
 * the exact same part twice gets one harmless duplicate collision entry,
 * which is a strictly smaller problem than a silently dropped operation.
 *
 * The first operation keeps the canonical `paths[path][method]` slot
 * (order-stable); every operation after it is appended to the top-level
 * `x-glubean-surface-collisions` array instead of being dropped or forced
 * into an invalid `paths` key — a `paths` key MUST be a real URL path (no
 * `#`/query-string disambiguator hacks), or spec-conformant tooling may
 * silently ignore it, recreating the exact bug this fixes one layer down.
 * Each collision entry carries the original `path`/`method` plus the full
 * operation object, so nothing about the losing operation is lost — it's
 * just addressed out-of-band instead of forced into the canonical map. This
 * is a pragmatic disambiguation, not a spec-perfect multi-server
 * representation (that would need per-operation `servers`, which isn't
 * available at projection time since base URLs are unresolved `{{VAR}}`
 * templates).
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
  const surfaceCollisions: Array<Record<string, unknown>> = [];

  for (const part of parts) {
    const partPaths = (part.paths ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    for (const [apiPath, methods] of Object.entries(partPaths)) {
      if (!paths[apiPath]) paths[apiPath] = {};
      for (const [method, operation] of Object.entries(methods)) {
        // Non-operation Path Item fields (parameters/summary/servers/...)
        // have no operationId and are never a "surface" — plain first-wins,
        // untouched by collision detection (codex R3 P2 — routing them
        // through the collision list produced bogus entries with e.g.
        // `method: "parameters"`).
        if (!OPENAPI_OPERATION_KEYS.has(method)) {
          if (!paths[apiPath][method]) paths[apiPath][method] = operation;
          continue;
        }

        if (!paths[apiPath][method]) {
          paths[apiPath][method] = operation;
          continue;
        }

        // The canonical slot is taken — every subsequent operation at this
        // method+path is preserved via the collision list, unconditionally
        // (see rationale above: neither id nor content equality is a safe
        // "same occurrence" signal, so there is no no-op branch here).
        surfaceCollisions.push({ path: apiPath, method, operation });
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

  // GLU-127: hoist reusable request/response body schemas into
  // `components.schemas`, replacing each inline occurrence with a `$ref`.
  // Runs last (needs the fully-merged `paths` + collision list to see
  // cross-operation duplicates). `paths`/`surfaceCollisions` at this point
  // still hold the ORIGINAL operation objects straight out of `parts` (the
  // merge loop above assigns them by reference, never clones) — hoisting
  // mutates the operations it walks (schema fields become `$ref`s), so it
  // runs against a deep clone instead of the merge's own `paths`/
  // `surfaceCollisions`. Without this, a caller that merges the same
  // `parts` array twice (e.g. re-rendering, or a test asserting the input
  // is untouched) would find its ORIGINAL parts silently rewritten by the
  // first call, and the second call would see already-`$ref`'d schemas
  // with no `components.schemas` to back them — dangling refs (codex R1
  // P2). Both the canonical `paths` slots and the collision list's full
  // operation copies are walked, so a de-prioritized surface operation
  // still gets its schemas componentized/deduped against the rest of the
  // document. Sorted traversal (path, then method) keeps naming
  // deterministic across runs independent of upstream extraction/iteration
  // order.
  const hoistedPaths = structuredClone(paths);
  const hoistedCollisions = structuredClone(surfaceCollisions);
  const schemaRegistry = new ComponentSchemaRegistry();
  for (const apiPath of Object.keys(hoistedPaths).sort()) {
    const methods = hoistedPaths[apiPath];
    for (const method of Object.keys(methods).sort()) {
      if (!OPENAPI_OPERATION_KEYS.has(method)) continue;
      const operation = methods[method] as Record<string, unknown>;
      const contractId =
        typeof operation.operationId === "string" ? operation.operationId : `${method}_${apiPath}`;
      hoistOperationSchemas(schemaRegistry, contractId, operation);
    }
  }
  for (const collision of hoistedCollisions) {
    const operation = collision.operation as Record<string, unknown> | undefined;
    if (!operation) continue;
    const contractId =
      typeof operation.operationId === "string"
        ? operation.operationId
        : `${collision.method}_${collision.path}`;
    hoistOperationSchemas(schemaRegistry, contractId, operation);
  }
  // Phase 2 — every occurrence is collected now; pick one name per shared
  // shape (explicit title wins regardless of which occurrence carried it)
  // and write the `$ref`s.
  schemaRegistry.finalize();

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

  const componentSchemas = schemaRegistry.componentSchemas;
  if (componentSchemas || Object.keys(securitySchemes).length > 0) {
    doc.components = {
      ...(componentSchemas ? { schemas: componentSchemas } : {}),
      ...(Object.keys(securitySchemes).length > 0 ? { securitySchemes } : {}),
    };
  }

  doc.paths = hoistedPaths;

  if (hoistedCollisions.length > 0) {
    doc["x-glubean-surface-collisions"] = hoistedCollisions;
  }

  return doc;
}

