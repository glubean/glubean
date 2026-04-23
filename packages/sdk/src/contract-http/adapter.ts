/**
 * HTTP adapter — built-in implementation of ContractProtocolAdapter for HTTP.
 *
 * Shipped inside @glubean/sdk (zero-config UX for the common case) but uses
 * the same adapter interface as future plugin protocols (gRPC / GraphQL /
 * Kafka). Registered at SDK load time from `../index.ts`.
 *
 * Responsibilities:
 *   - execute: run a case's request + expect + verify lifecycle
 *   - project: produce Runtime ContractProjection<HttpPayloadSchemas>
 *   - normalize: convert Runtime → ExtractedContractProjection<HttpSafeSchemas>
 *   - executeCaseInFlow: deep-merge lens resolvedInputs over case spec,
 *     run case with Rule 1 try/finally teardown
 *   - classifyFailure: map HTTP status → FailureKind
 *   - describePayload: summary for index views
 *   - toOpenApi / toMarkdown: delegate to ./openapi.ts / ./markdown.ts
 *
 * .case() fail-fast: rejects cases with function-valued input fields
 * (body/params/query/headers) because function fields reference case-local
 * setup state which is not available in flow mode.
 */

import type {
  ContractProtocolAdapter,
  ContractProjection,
  ExtractedContractProjection,
  FailureClassification,
  PayloadDescriptor,
  ProtocolContract,
} from "../contract-types.js";
import type {
  HttpClient,
  HttpResponsePromise,
  SchemaLike,
  TestContext,
} from "../types.js";
import type {
  ContractCase,
  ContractExpect,
  ContractExample,
  HttpContractMeta,
  HttpContractSpec,
  HttpFlowCaseOutput,
  HttpPayloadSchemas,
  HttpSafeSchemas,
  HttpSecurityScheme,
  NormalizedHeaders,
  ParamValue,
  RequestSpec,
} from "./types.js";
import { mergeSlot } from "./flow-helpers.js";
import { buildOpenApiPartForHttp } from "./openapi.js";
import { genericMarkdownPart } from "../contract-artifacts.js";

// =============================================================================
// Helpers — endpoint, params, request body, response headers
// =============================================================================

export function parseEndpoint(endpoint: string): { method: string; path: string } {
  const spaceIdx = endpoint.indexOf(" ");
  if (spaceIdx === -1) return { method: "GET", path: endpoint };
  return {
    method: endpoint.slice(0, spaceIdx).toUpperCase(),
    path: endpoint.slice(spaceIdx + 1),
  };
}

function extractParamValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "value" in v) {
    return String((v as { value: string }).value);
  }
  return String(v);
}

export function flattenParamValues(
  params: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!params) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    result[key] = extractParamValue(value);
  }
  return result;
}

function resolveParams(
  path: string,
  params: Record<string, string> | undefined,
): string {
  if (!params) return path;
  let resolved = path;
  for (const [key, value] of Object.entries(params)) {
    resolved = resolved.replace(`:${key}`, encodeURIComponent(value));
  }
  return resolved;
}

const STRUCTURED_REQUEST_FIELDS = [
  "body",
  "contentType",
  "headers",
  "example",
  "examples",
] as const;

interface NormalizedRequest {
  body?: SchemaLike<unknown>;
  contentType?: string;
  headers?: SchemaLike<Record<string, string>>;
  example?: unknown;
  examples?: Record<string, ContractExample<unknown>>;
}

export function normalizeRequest(
  req: RequestSpec | undefined,
): NormalizedRequest | undefined {
  if (!req || typeof req !== "object") return undefined;
  const hasStructuredField = STRUCTURED_REQUEST_FIELDS.some(
    (f) => f in (req as Record<string, unknown>),
  );
  if (hasStructuredField) return req as NormalizedRequest;
  return { body: req as SchemaLike<unknown> };
}

function buildRequestBodyOptions(
  body: unknown,
  contentType: string | undefined,
): Record<string, unknown> {
  if (body === undefined) return {};
  const ct = (contentType ?? "application/json").toLowerCase();

  if (ct.startsWith("application/json")) {
    return { json: body };
  }
  if (ct.startsWith("multipart/form-data")) {
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      return { body };
    }
    if (body && typeof body === "object") {
      const fd = new FormData();
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (v instanceof Blob || v instanceof File) fd.append(k, v);
        else fd.append(k, String(v));
      }
      return { body: fd };
    }
    return { body };
  }
  if (ct.startsWith("application/x-www-form-urlencoded")) {
    if (body instanceof URLSearchParams) return { body };
    if (body && typeof body === "object") {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        params.append(k, String(v));
      }
      return { body: params };
    }
    return { body };
  }
  return { body };
}

function normalizeResponseHeaders(headers: unknown): NormalizedHeaders {
  const result: NormalizedHeaders = {};
  if (!headers) return result;

  if (
    typeof (headers as Headers).forEach === "function" &&
    typeof (headers as Headers).get === "function"
  ) {
    (headers as Headers).forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (lowerKey === "set-cookie") {
        const existing = result[lowerKey];
        const newValue =
          typeof existing === "string"
            ? [existing, value]
            : [...(existing ?? []), value];
        result[lowerKey] = newValue;
      } else {
        result[lowerKey] = value;
      }
    });
    return result;
  }

  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (Array.isArray(value)) result[lowerKey] = value.map(String);
      else if (value != null) result[lowerKey] = String(value);
    }
  }
  return result;
}

// =============================================================================
// Schema → JSON Schema (normalize helper)
// =============================================================================

/**
 * Try to convert a SchemaLike (Zod v4, Valibot, etc.) to JSON Schema.
 * Uses the schema's own `toJSONSchema` method if present. Falls back to
 * passing through as-is if already plain or unrecognized.
 */
export function schemaToJsonSchema(schema: unknown): unknown | null {
  if (schema == null) return null;
  if (typeof schema !== "object") return schema;

  // Already plain JSON Schema-ish
  if ("type" in (schema as Record<string, unknown>) || "$ref" in (schema as Record<string, unknown>)) {
    return schema;
  }

  // Zod v4 instance method
  const toJSONSchema = (schema as { toJSONSchema?: () => unknown }).toJSONSchema;
  if (typeof toJSONSchema === "function") {
    try {
      return toJSONSchema.call(schema);
    } catch {
      return null;
    }
  }

  return null;
}

// =============================================================================
// Extract per-param metadata from case spec (for OpenAPI)
// =============================================================================

function extractParamMetaSchemas(
  params: Record<string, unknown> | ((state: unknown) => Record<string, string>) | undefined,
):
  | Record<string, { schema?: SchemaLike<unknown>; description?: string; required?: boolean; deprecated?: boolean }>
  | undefined {
  if (!params || typeof params === "function") return undefined;
  const result: Record<string, { schema?: SchemaLike<unknown>; description?: string; required?: boolean; deprecated?: boolean }> = {};
  let hasAny = false;
  for (const [key, val] of Object.entries(params)) {
    if (val && typeof val === "object" && !Array.isArray(val) && "value" in val) {
      const pv = val as {
        schema?: SchemaLike<unknown>;
        description?: string;
        required?: boolean;
        deprecated?: boolean;
      };
      if (
        pv.schema !== undefined ||
        pv.description !== undefined ||
        pv.required !== undefined ||
        pv.deprecated !== undefined
      ) {
        result[key] = {
          schema: pv.schema,
          description: pv.description,
          required: pv.required,
          deprecated: pv.deprecated,
        };
        hasAny = true;
      }
    }
  }
  return hasAny ? result : undefined;
}

// =============================================================================
// Case execution (standalone mode)
// =============================================================================

/**
 * Run a single case. Called by the dispatcher in contract-core.ts (via
 * adapter.execute). Full lifecycle: setup → request → assert → verify →
 * teardown (finally).
 */
async function executeCase<T, S>(
  ctx: TestContext,
  caseSpec: ContractCase<T, S>,
  spec: HttpContractSpec,
): Promise<void> {
  const { method, path } = parseEndpoint(spec.endpoint);

  // Setup
  const state = caseSpec.setup
    ? await caseSpec.setup(ctx)
    : (undefined as S);

  try {
    const client: HttpClient = (caseSpec.client ?? spec.client) as HttpClient;
    if (!client) {
      throw new Error(
        `No HTTP client provided for case. Set "client" on the case or contract spec.`,
      );
    }

    // Resolve params/query/body/headers
    const rawParams = typeof caseSpec.params === "function"
      ? caseSpec.params(state)
      : caseSpec.params;
    const params = flattenParamValues(rawParams as Record<string, unknown> | undefined);
    const resolvedPath = resolveParams(path, params);

    const requestOptions: Record<string, unknown> = {};
    const body = typeof caseSpec.body === "function"
      ? (caseSpec.body as (s: S) => unknown)(state)
      : caseSpec.body;

    const normalizedReq = normalizeRequest(spec.request);
    const effectiveContentType =
      caseSpec.contentType ?? normalizedReq?.contentType ?? "application/json";

    if (body !== undefined) {
      Object.assign(requestOptions, buildRequestBodyOptions(body, effectiveContentType));
    }

    const headers = typeof caseSpec.headers === "function"
      ? (caseSpec.headers as (s: S) => Record<string, string>)(state)
      : caseSpec.headers;
    if (headers) requestOptions.headers = headers;

    if (caseSpec.query) {
      const rawQuery = typeof caseSpec.query === "function"
        ? caseSpec.query(state)
        : caseSpec.query;
      requestOptions.searchParams = flattenParamValues(
        rawQuery as Record<string, unknown> | undefined,
      );
    }

    requestOptions.throwHttpErrors = false;

    const methodLower = method.toLowerCase() as keyof HttpClient;
    let res;
    try {
      res = await (client[methodLower] as (p: string, o: unknown) => HttpResponsePromise)(
        resolvedPath,
        requestOptions,
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "TimeoutError") {
        const timeoutMs = (client as { _configuredTimeout?: number })._configuredTimeout ?? 10000;
        throw new Error(`${err.message} (timeout: ${timeoutMs}ms)`);
      }
      throw err;
    }

    // Assertions
    ctx.expect(res).toHaveStatus(caseSpec.expect.status);

    if (caseSpec.expect.headers) {
      const normalizedHeaders = normalizeResponseHeaders(res.headers);
      ctx.validate(normalizedHeaders, caseSpec.expect.headers, `response headers`);
    }

    let parsed: T;
    if (caseSpec.expect.schema) {
      const jsonBody = await res.json();
      const validated = ctx.validate(
        jsonBody,
        caseSpec.expect.schema,
        `response body`,
      );
      parsed = (validated !== undefined ? validated : jsonBody) as T;
    } else if (caseSpec.verify) {
      parsed = (await res.json()) as T;
    } else {
      parsed = undefined as T;
    }

    if (caseSpec.verify) {
      await caseSpec.verify(ctx, parsed);
    }
  } finally {
    if (caseSpec.teardown) {
      await caseSpec.teardown(ctx, state);
    }
  }
}

// =============================================================================
// project(): HttpContractSpec → ContractProjection<HttpPayloadSchemas>
// =============================================================================

function projectHttp(
  spec: HttpContractSpec,
): ContractProjection<HttpPayloadSchemas, HttpContractMeta> {
  const { method, path } = parseEndpoint(spec.endpoint);
  const normalizedReq = normalizeRequest(spec.request);

  // Read factory-provided metadata from the internal `_factory` channel
  // populated by `mergeHttpDefaults`. Absent when `contract.http(...)` is
  // called without `.with(...)` (which is forbidden and throws earlier).
  const factory = (spec as unknown as {
    _factory?: { instanceName: string; security?: unknown };
  })._factory;

  return {
    protocol: "http",
    target: spec.endpoint,
    description: spec.description,
    feature: spec.feature,
    instanceName: factory?.instanceName,
    tags: spec.tags,
    extensions: spec.extensions,
    deprecated: spec.deprecated,
    meta: { method, path },
    schemas: {
      request: normalizedReq
        ? {
            body: normalizedReq.body,
            contentType: normalizedReq.contentType,
            headers: normalizedReq.headers,
            example: normalizedReq.example,
            examples: normalizedReq.examples,
          }
        : undefined,
      ...(factory?.security !== undefined
        ? { security: factory.security as HttpPayloadSchemas["security"] }
        : {}),
    },
    cases: Object.entries(spec.cases).map(([key, c]) => {
      const effectiveDeprecated = c.deprecated ?? spec.deprecated;
      const lifecycle = effectiveDeprecated
        ? "deprecated"
        : c.deferred
          ? "deferred"
          : "active";
      const paramSchemas = extractParamMetaSchemas(
        c.params as Record<string, unknown> | ((state: unknown) => Record<string, string>) | undefined,
      );
      const querySchemas = extractParamMetaSchemas(
        c.query as Record<string, unknown> | ((state: unknown) => Record<string, string>) | undefined,
      );

      return {
        key,
        description: c.description,
        lifecycle,
        severity: c.severity ?? "warning",
        deferredReason: c.deferred,
        deprecatedReason: effectiveDeprecated,
        requires: c.requires,
        defaultRun: c.defaultRun,
        tags: c.tags,
        extensions: c.extensions,
        schemas: {
          request: undefined,
          response: {
            status: c.expect.status,
            body: c.expect.schema,
            contentType: c.expect.contentType,
            headers: c.expect.headers,
            example: c.expect.example,
            examples: c.expect.examples as
              | Record<string, ContractExample<unknown>>
              | undefined,
          },
          params: paramSchemas,
          query: querySchemas,
        },
      };
    }),
  };
}

// =============================================================================
// normalize(): Runtime → Safe (Zod → JSON Schema)
// =============================================================================

function normalizeHttp(
  projection: ContractProjection<HttpPayloadSchemas, HttpContractMeta> & { id: string },
): ExtractedContractProjection<HttpSafeSchemas, HttpContractMeta> {
  const safeContractSchemas: HttpSafeSchemas | undefined = projection.schemas
    ? {
        request: projection.schemas.request
          ? {
              body: schemaToJsonSchema(projection.schemas.request.body) ?? undefined,
              contentType: projection.schemas.request.contentType,
              headers: schemaToJsonSchema(projection.schemas.request.headers) ?? undefined,
              example: projection.schemas.request.example,
              examples: projection.schemas.request.examples,
            }
          : undefined,
        // Contract-level security (set by the scoped factory via
        // `contract.http.with("name", { security })`). Must survive
        // normalize so downstream tools (toOpenApi, Cloud views) see it.
        security: projection.schemas.security,
      }
    : undefined;

  return {
    id: projection.id,
    protocol: projection.protocol,
    target: projection.target,
    description: projection.description,
    feature: projection.feature,
    instanceName: projection.instanceName,
    tags: projection.tags,
    extensions: projection.extensions,
    deprecated: projection.deprecated,
    schemas: safeContractSchemas,
    meta: projection.meta,
    cases: projection.cases.map((c) => ({
      key: c.key,
      description: c.description,
      lifecycle: c.lifecycle,
      severity: c.severity,
      deferredReason: c.deferredReason,
      deprecatedReason: c.deprecatedReason,
      requires: c.requires,
      defaultRun: c.defaultRun,
      tags: c.tags,
      extensions: c.extensions,
      meta: c.meta,
      schemas: c.schemas
        ? {
            response: c.schemas.response
              ? {
                  status: c.schemas.response.status,
                  body: schemaToJsonSchema(c.schemas.response.body) ?? undefined,
                  contentType: c.schemas.response.contentType,
                  headers: schemaToJsonSchema(c.schemas.response.headers) ?? undefined,
                  example: c.schemas.response.example,
                  examples: c.schemas.response.examples,
                }
              : undefined,
            params: c.schemas.params
              ? normalizeParamMetaRecord(c.schemas.params)
              : undefined,
            query: c.schemas.query
              ? normalizeParamMetaRecord(c.schemas.query)
              : undefined,
            security: c.schemas.security,
          }
        : undefined,
    })),
  };
}

function normalizeParamMetaRecord(
  raw: Record<
    string,
    { schema?: SchemaLike<unknown>; description?: string; required?: boolean; deprecated?: boolean }
  >,
): HttpSafeSchemas["params"] {
  const out: NonNullable<HttpSafeSchemas["params"]> = {};
  for (const [key, meta] of Object.entries(raw)) {
    out[key] = {
      schema: schemaToJsonSchema(meta.schema) ?? undefined,
      description: meta.description,
      required: meta.required,
      deprecated: meta.deprecated,
    };
  }
  return out;
}

// =============================================================================
// executeCaseInFlow(): deep-merge lens inputs + Rule 1 teardown
// =============================================================================

async function executeCaseInFlowHttp(input: {
  ctx: TestContext;
  contract: ProtocolContract<HttpContractSpec, HttpPayloadSchemas, HttpContractMeta>;
  caseKey: string;
  resolvedInputs: unknown;
}): Promise<HttpFlowCaseOutput> {
  const { ctx, contract, caseKey, resolvedInputs } = input;
  const spec = contract._spec;
  const caseSpec = spec.cases[caseKey];
  if (!caseSpec) {
    throw new Error(`case "${caseKey}" not in contract "${contract._projection.id}"`);
  }

  // Note: function-valued fields are rejected at .case() time (§5.1.1).
  // In flow mode we assume all input slots are static (possibly undefined).

  // Compute effective body/params/query/headers via deep-merge
  const patch = (resolvedInputs ?? {}) as {
    body?: unknown;
    params?: Record<string, unknown>;
    query?: Record<string, unknown>;
    headers?: Record<string, string>;
  };

  const effectiveBody = mergeSlot(caseSpec.body, patch.body);
  const effectiveParams = mergeSlot(caseSpec.params, patch.params);
  const effectiveQuery = mergeSlot(caseSpec.query, patch.query);
  const effectiveHeaders = mergeSlot(caseSpec.headers, patch.headers);

  // Rule 1: case setup throw → teardown does NOT run. Track whether setup
  // SUCCEEDED via a separate flag, not via state-is-undefined — a setup may
  // legitimately return `undefined` and we still owe it a teardown call.
  let setupRan = false;
  let caseState: unknown = undefined;
  if (caseSpec.setup) {
    caseState = await caseSpec.setup(ctx);
    setupRan = true;
  }

  try {
    const { method, path } = parseEndpoint(spec.endpoint);
    const client: HttpClient = (caseSpec.client ?? spec.client) as HttpClient;
    if (!client) {
      throw new Error(
        `No HTTP client provided for case "${caseKey}" in contract "${contract._projection.id}". ` +
          `Set "client" on the case or contract spec.`,
      );
    }

    const resolvedPath = resolveParams(
      path,
      flattenParamValues(effectiveParams as Record<string, unknown> | undefined),
    );

    const normalizedReq = normalizeRequest(spec.request);
    const effectiveContentType =
      caseSpec.contentType ?? normalizedReq?.contentType ?? "application/json";

    const requestOptions: Record<string, unknown> = { throwHttpErrors: false };
    if (effectiveBody !== undefined) {
      Object.assign(
        requestOptions,
        buildRequestBodyOptions(effectiveBody, effectiveContentType),
      );
    }
    if (effectiveHeaders) requestOptions.headers = effectiveHeaders;
    if (effectiveQuery) {
      requestOptions.searchParams = flattenParamValues(
        effectiveQuery as Record<string, unknown>,
      );
    }

    const methodLower = method.toLowerCase() as keyof HttpClient;
    let res;
    try {
      res = await (client[methodLower] as (p: string, o: unknown) => HttpResponsePromise)(
        resolvedPath,
        requestOptions,
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "TimeoutError") {
        const timeoutMs =
          (client as { _configuredTimeout?: number })._configuredTimeout ?? 10000;
        throw new Error(`${err.message} (timeout: ${timeoutMs}ms)`);
      }
      throw err;
    }

    ctx.expect(res).toHaveStatus(caseSpec.expect.status);

    const responseHeaders = normalizeResponseHeaders(res.headers);
    if (caseSpec.expect.headers) {
      ctx.validate(responseHeaders, caseSpec.expect.headers, `response headers`);
    }

    let body: unknown;
    if (caseSpec.expect.schema) {
      const jsonBody = await res.json();
      const validated = ctx.validate(
        jsonBody,
        caseSpec.expect.schema,
        `response body`,
      );
      body = validated !== undefined ? validated : jsonBody;
    } else if (caseSpec.verify) {
      body = await res.json();
    } else {
      // Try to pull body anyway for downstream lens
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
    }

    if (caseSpec.verify) {
      await caseSpec.verify(ctx, body);
    }

    return { status: res.status, headers: responseHeaders, body };
  } finally {
    // Rule 1: case.teardown runs in finally whenever setup succeeded,
    // regardless of downstream outcome AND regardless of the state value
    // returned by setup (undefined is a valid return). Teardown errors are
    // logged but MUST NOT mask the primary exception.
    if (caseSpec.teardown && setupRan) {
      try {
        await caseSpec.teardown(ctx, caseState as any);
      } catch (tdErr) {
        ctx.log?.(`case.teardown("${caseKey}") failed: ${String(tdErr)}`);
      }
    }
  }
}

// =============================================================================
// classifyFailure(): HTTP status → FailureKind
// =============================================================================

function classifyHttpFailure(input: {
  error?: unknown;
  events: Array<{ type: string; data: Record<string, unknown> }>;
}): FailureClassification | undefined {
  // Scan recent HTTP trace events for the response status
  for (let i = input.events.length - 1; i >= 0; i--) {
    const ev = input.events[i];
    if (ev.type === "http:response" || ev.type === "http:trace") {
      const status = (ev.data as { status?: number }).status;
      if (typeof status === "number") {
        return statusToClassification(status);
      }
    }
  }

  // Fallback: inspect error
  if (input.error instanceof Error) {
    if (input.error.name === "TimeoutError") {
      return { kind: "timeout", source: "trace", retryable: true };
    }
    if (/ECONNREFUSED|ENOTFOUND|fetch failed/.test(input.error.message)) {
      return { kind: "transport", source: "trace", retryable: true };
    }
  }
  return undefined;
}

function statusToClassification(status: number): FailureClassification {
  if (status === 401) return { kind: "auth", source: "trace" };
  if (status === 403) return { kind: "permission", source: "trace" };
  if (status === 404) return { kind: "not-found", source: "trace" };
  if (status === 429) return { kind: "rate-limit", source: "trace", retryable: true };
  if (status >= 500) return { kind: "transport", source: "trace", retryable: true };
  return { kind: "business-rule", source: "trace" };
}

// =============================================================================
// describePayload(): payload overview from HttpSafeSchemas
// =============================================================================

function describeHttpPayload(
  schemas: HttpSafeSchemas | undefined,
): PayloadDescriptor | undefined {
  if (!schemas) return undefined;
  return {
    hasRequest: !!schemas.request?.body,
    hasResponse: !!schemas.response?.body,
    responseStatus: schemas.response?.status,
    responseContentType: schemas.response?.contentType,
    requestContentType: schemas.request?.contentType,
  };
}

// =============================================================================
// The HTTP adapter
// =============================================================================

export const httpAdapter: ContractProtocolAdapter<
  HttpContractSpec,
  HttpPayloadSchemas,
  HttpContractMeta,
  HttpSafeSchemas,
  HttpContractMeta
> = {
  async execute(ctx, caseSpec, spec) {
    await executeCase(ctx, caseSpec as ContractCase<unknown, unknown>, spec);
  },

  project(spec) {
    return projectHttp(spec);
  },

  normalize(projection) {
    return normalizeHttp(projection);
  },

  executeCaseInFlow(input) {
    return executeCaseInFlowHttp(input as Parameters<typeof executeCaseInFlowHttp>[0]);
  },

  classifyFailure(input) {
    return classifyHttpFailure(input);
  },

  describePayload(schemas) {
    return describeHttpPayload(schemas);
  },

  artifacts: {
    openapi: (projection) => {
      const part = buildOpenApiPartForHttp(projection);
      // `null` parts are filtered by the render pipeline; we never emit
      // one for HTTP contracts since protocol="http" always matches here,
      // but defend against malformed targets which buildOpenApiPart returns
      // null for.
      return part ?? {};
    },
    // Markdown uses the kind's generic structured renderer — HTTP has no
    // protocol-specific augmentations to contribute.
    markdown: (projection) => genericMarkdownPart(projection),
  },

  renderTarget(target) {
    return target; // HTTP "POST /users" is already human-readable
  },

  validateCaseForFlow(spec, caseKey, contractId) {
    const caseSpec = spec.cases[caseKey];
    if (!caseSpec) {
      throw new Error(`Case "${caseKey}" not in contract "${contractId}"`);
    }
    validateHttpCaseForFlow(contractId, caseKey, caseSpec as ContractCase<unknown, unknown>);
  },
};

// =============================================================================
// .case(key) fail-fast for function-valued input fields
// =============================================================================

/**
 * Validate that an HTTP case can be referenced from a flow. Called from
 * ProtocolContract.case() — throws if the case has function-valued inputs.
 * See contract-flow v9 §5.1.1.
 */
export function validateHttpCaseForFlow(
  contractId: string,
  caseKey: string,
  caseSpec: ContractCase<unknown, unknown>,
): void {
  const functionFields: string[] = [];
  if (typeof caseSpec.body === "function") functionFields.push("body");
  if (typeof caseSpec.params === "function") functionFields.push("params");
  if (typeof caseSpec.query === "function") functionFields.push("query");
  if (typeof caseSpec.headers === "function") functionFields.push("headers");
  if (functionFields.length > 0) {
    throw new Error(
      `Contract "${contractId}" case "${caseKey}" has function-valued field(s): ` +
        `${functionFields.join(", ")}. Function fields reference case-local setup state, ` +
        `which is not available in flow mode. ` +
        `Fix: split into a new case with static values, or convert the field to a static value.`,
    );
  }
}
