/**
 * Built-in GraphQL contract adapter for @glubean/graphql 0.2.0.
 *
 * Shipped alongside the transport plugin in @glubean/graphql (single-package
 * model — "contract is a first-class citizen"). Registered via
 * `contract.register("graphql", graphqlAdapter)` on import — see ./index.ts.
 *
 * Responsibilities (same interface as HTTP / gRPC adapters):
 *   - execute: setup → call → expect → verify → teardown
 *   - executeCaseInFlow: deep-merge resolvedInputs, run case in flow mode
 *   - validateCaseForFlow: reject function-valued variables / headers
 *   - project: runtime ContractProjection<GraphqlPayloadSchemas>
 *   - normalize: runtime → JSON-safe ExtractedContractProjection
 *   - classifyFailure: 3-layer (transport / payload errors / data shape)
 *   - renderTarget: operationName (parsed from query if needed)
 *   - toMarkdown: case list with operation + query snippet
 *   - describePayload: high-level summary for index views
 *
 * Phase 1 scope: query + mutation only. Subscription deferred to Phase 2.
 */

import type {
  CaseMeta,
  ContractProtocolAdapter,
  ContractProjection,
  ExtractedCaseMeta,
  ExtractedContractProjection,
  FailureClassification,
  PayloadDescriptor,
  TestContext,
} from "@glubean/sdk";

import type { GraphQLClient, GraphQLError, GraphQLResult } from "../index.js";
import { parseOperationName } from "../index.js";
import type {
  GraphqlCaseResult,
  GraphqlContractCase,
  GraphqlContractMeta,
  GraphqlContractSafeMeta,
  GraphqlContractSpec,
  GraphqlErrorsExpect,
  GraphqlPayloadSchemas,
  GraphqlSafeSchemas,
} from "./types.js";

// =============================================================================
// Helpers
// =============================================================================

/** Convert a SchemaLike to a JSON Schema fragment if possible (best-effort). */
export function schemaToJsonSchema(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object") return null;
  const maybe = (schema as { toJSONSchema?: () => unknown }).toJSONSchema;
  if (typeof maybe === "function") {
    try {
      const out = maybe.call(schema);
      if (out && typeof out === "object") return out as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

/** Deep-merge two plain objects (right wins). Handles nested objects; skips arrays. */
function deepMerge<T extends Record<string, unknown>>(
  base: T | undefined,
  override: Partial<T> | undefined,
): T {
  if (!base && !override) return {} as T;
  if (!base) return { ...override } as T;
  if (!override) return { ...base };
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const baseVal = base[k as keyof T];
    if (
      v != null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      baseVal != null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal)
    ) {
      out[k] = deepMerge(baseVal as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/** Resolve the effective GraphQL client with case > spec fallback. */
function resolveClient(
  caseSpec: GraphqlContractCase,
  spec: GraphqlContractSpec,
): GraphQLClient {
  const client = caseSpec.client ?? spec.client;
  if (!client) {
    throw new Error(
      `No GraphQL client provided for case. Set "client" on the case or contract spec (e.g. via contract.graphql.with("name", { client: gqlPlugin })).`,
    );
  }
  return client;
}

/** Merge headers: contract defaults < case. */
function resolveHeaders(
  spec: GraphqlContractSpec,
  caseSpec: GraphqlContractCase,
  state: unknown,
): Record<string, string> | undefined {
  const caseHeaders =
    typeof caseSpec.headers === "function"
      ? (caseSpec.headers as (s: unknown) => Record<string, string>)(state)
      : caseSpec.headers;
  const specHeaders = spec.defaultHeaders;
  if (!caseHeaders && !specHeaders) return undefined;
  return { ...(specHeaders ?? {}), ...(caseHeaders ?? {}) };
}

/** Resolve variables with deep-merge: spec.defaultVariables < case.variables. */
function resolveVariables(
  spec: GraphqlContractSpec,
  caseSpec: GraphqlContractCase,
  state: unknown,
): Record<string, unknown> {
  const caseVars =
    typeof caseSpec.variables === "function"
      ? (caseSpec.variables as (s: unknown) => Record<string, unknown>)(state)
      : caseSpec.variables;
  return deepMerge(
    spec.defaultVariables as Record<string, unknown> | undefined,
    caseVars as Record<string, unknown> | undefined,
  );
}

/** Resolve effective operation type: case > spec default > "query". */
function resolveOperation(
  spec: GraphqlContractSpec,
  caseSpec: GraphqlContractCase,
): "query" | "mutation" {
  return caseSpec.operation ?? spec.defaultOperation ?? "query";
}

/** Resolve display operationName: case.operationName > parsed from query > "anonymous". */
function resolveOperationName(caseSpec: GraphqlContractCase): string {
  return (
    caseSpec.operationName ?? parseOperationName(caseSpec.query) ?? "anonymous"
  );
}

/**
 * Call the GraphQL client for a case. Returns the full GraphQLResult envelope
 * plus the resolved operation + operationName + duration.
 */
async function callGraphql(
  client: GraphQLClient,
  caseSpec: GraphqlContractCase,
  spec: GraphqlContractSpec,
  variables: Record<string, unknown>,
  headers: Record<string, string> | undefined,
): Promise<GraphqlCaseResult<unknown>> {
  const operation = resolveOperation(spec, caseSpec);
  const operationName = resolveOperationName(caseSpec);

  const start = Date.now();
  const callFn = operation === "mutation" ? client.mutate : client.query;
  const res: GraphQLResult<unknown> = await callFn.call(client, caseSpec.query, {
    variables,
    ...(headers ? { headers } : {}),
    operationName:
      operationName !== "anonymous" ? operationName : undefined,
  });
  const duration = Date.now() - start;

  return {
    data: res.data,
    errors: res.errors,
    extensions: res.extensions,
    httpStatus: res.httpStatus,
    headers: res.headers,
    rawBody: res.rawBody,
    operationName,
    duration,
  };
}

/**
 * 3-layer assertion: transport → payload errors → data shape.
 * Uses `ctx.assert` / `ctx.expect` / `ctx.validate` for structured failures.
 */
function assertResult(
  ctx: TestContext,
  result: GraphqlCaseResult<unknown>,
  caseSpec: GraphqlContractCase,
): void {
  const expect = caseSpec.expect ?? {};
  const expectedStatus = expect.httpStatus ?? 200;

  // Layer 1: transport (HTTP status)
  if (result.httpStatus !== expectedStatus) {
    ctx.assert(
      false,
      `Expected HTTP status ${expectedStatus} but got ${result.httpStatus}`,
      { actual: result.httpStatus, expected: expectedStatus },
    );
  }

  // Layer 2: payload errors (GraphQL `errors` array)
  assertErrors(ctx, result.errors, expect.errors ?? "absent");

  // Layer 3: data shape (only when transport succeeded and errors absent OR
  // `data` partial expect is declared — schema always runs if provided)
  if (expect.schema) {
    ctx.validate(result.data, expect.schema, `response data`);
  }
  if (expect.data) {
    if (result.data == null) {
      ctx.assert(
        false,
        `Expected data shape to match but response.data was null`,
        { actual: null, expected: expect.data },
      );
    } else {
      ctx.expect(result.data).toMatchObject(expect.data as Record<string, unknown>);
    }
  }

  // Response headers assertions
  if (expect.headersMatch) {
    ctx.expect(result.headers).toMatchObject(expect.headersMatch);
  }
  if (expect.headers) {
    ctx.validate(result.headers, expect.headers, `response headers`);
  }
}

/**
 * Assert the `errors` layer against a sentinel or partial array.
 */
function assertErrors(
  ctx: TestContext,
  actual: GraphQLError[] | undefined,
  expected: GraphqlErrorsExpect,
): void {
  const errs = actual ?? [];

  if (expected === "absent") {
    if (errs.length > 0) {
      ctx.assert(
        false,
        `Expected no GraphQL errors but got ${errs.length}: ${errs.map((e) => e.message).join("; ")}`,
        { actual: errs, expected: [] },
      );
    }
    return;
  }

  if (expected === "any") {
    return; // accept whatever shows up
  }

  // Array of partial GraphQLError — match by position (each entry partial-matches)
  if (errs.length < expected.length) {
    ctx.assert(
      false,
      `Expected ${expected.length} GraphQL errors but got ${errs.length}`,
      { actual: errs, expected },
    );
    return;
  }
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i];
    const got = errs[i];
    // Partial match on top-level keys (message, extensions.code, etc.)
    for (const [k, v] of Object.entries(want)) {
      if (k === "extensions" && v && typeof v === "object") {
        ctx.expect((got.extensions ?? {}) as Record<string, unknown>).toMatchObject(
          v as Record<string, unknown>,
        );
      } else {
        ctx.expect((got as unknown as Record<string, unknown>)[k]).toEqual(v);
      }
    }
  }
}

// =============================================================================
// executeCase — standard (non-flow) case execution
// =============================================================================

async function executeCase(
  ctx: TestContext,
  caseSpec: GraphqlContractCase,
  spec: GraphqlContractSpec,
): Promise<void> {
  if (!caseSpec.query || typeof caseSpec.query !== "string") {
    throw new Error(
      `GraphQL contract case: "query" is required and must be a string.`,
    );
  }

  const state: unknown = caseSpec.setup
    ? await caseSpec.setup(ctx)
    : undefined;

  try {
    const client = resolveClient(caseSpec, spec);
    const variables = resolveVariables(spec, caseSpec, state);
    const headers = resolveHeaders(spec, caseSpec, state);

    const result = await callGraphql(client, caseSpec, spec, variables, headers);

    assertResult(ctx, result, caseSpec);

    if (caseSpec.verify) {
      await caseSpec.verify(ctx, result);
    }
  } finally {
    if (caseSpec.teardown) {
      await caseSpec.teardown(ctx, state as never);
    }
  }
}

// =============================================================================
// project — runtime ContractProjection
// =============================================================================

function projectGraphql(
  spec: GraphqlContractSpec,
): ContractProjection<GraphqlPayloadSchemas, GraphqlContractMeta> {
  const meta: GraphqlContractMeta = {
    endpoint: spec.endpoint,
    defaultOperation: spec.defaultOperation,
    defaultHeaders: spec.defaultHeaders,
    types: spec.types,
  };

  const cases: CaseMeta<GraphqlPayloadSchemas, GraphqlContractMeta>[] = Object.entries(
    spec.cases,
  ).map(([key, c]) => {
    const casted = c as GraphqlContractCase;
    const lifecycle = casted.deprecated
      ? "deprecated"
      : casted.deferred
        ? "deferred"
        : "active";
    const operation = resolveOperation(spec, casted);
    const operationName = resolveOperationName(casted);
    const schemas: GraphqlPayloadSchemas = {
      query: casted.query,
      operation,
      operationName,
      variables: spec.variablesSchema,
      response: casted.expect?.schema ?? spec.responseSchema,
      headers: casted.expect?.headers,
    };
    return {
      key,
      description: casted.description,
      lifecycle,
      severity: casted.severity ?? "warning",
      deferredReason: casted.deferred,
      deprecatedReason: casted.deprecated,
      schemas,
      tags: casted.tags,
      extensions: casted.extensions,
      requires: casted.requires,
      defaultRun: casted.defaultRun,
    };
  });

  // Read factory-provided metadata from the internal `_factory` channel
  // populated by `mergeGraphqlDefaults`.
  const factory = (spec as unknown as {
    _factory?: { instanceName: string };
  })._factory;

  return {
    protocol: "graphql",
    target: spec.endpoint ?? "",
    description: spec.description,
    feature: spec.feature,
    instanceName: factory?.instanceName,
    tags: spec.tags,
    extensions: spec.extensions,
    deprecated: spec.deprecated,
    cases,
    schemas: {},
    meta,
  };
}

// =============================================================================
// normalize — runtime → JSON-safe Extracted
// =============================================================================

function normalizeGraphql(
  projection: ContractProjection<GraphqlPayloadSchemas, GraphqlContractMeta> & {
    id: string;
  },
): ExtractedContractProjection<GraphqlSafeSchemas, GraphqlContractSafeMeta> {
  const safeCases: ExtractedCaseMeta<GraphqlSafeSchemas, GraphqlContractSafeMeta>[] =
    projection.cases.map((c) => {
      const s = c.schemas ?? {};
      const safe: GraphqlSafeSchemas = {
        query: s.query,
        operation: s.operation,
        operationName: s.operationName,
        variables: schemaToJsonSchema(s.variables) ?? undefined,
        response: schemaToJsonSchema(s.response) ?? undefined,
        headers: schemaToJsonSchema(s.headers) ?? undefined,
        variablesExample: s.variablesExample,
        variablesExamples: s.variablesExamples,
      };
      return { ...c, schemas: safe };
    });

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
    cases: safeCases,
    schemas: {},
    meta: projection.meta,
  };
}

// =============================================================================
// executeCaseInFlow — flow-mode execution
// =============================================================================

async function executeCaseInFlowGraphql(input: {
  ctx: TestContext;
  contract: { _spec: unknown };
  caseKey: string;
  resolvedInputs: unknown;
}): Promise<GraphqlCaseResult<unknown>> {
  const { ctx, contract: c, caseKey, resolvedInputs } = input;
  const spec = c._spec as GraphqlContractSpec;
  const caseSpec = spec.cases[caseKey];
  if (!caseSpec) {
    throw new Error(`GraphQL contract: unknown case key "${caseKey}".`);
  }

  if (!caseSpec.query || typeof caseSpec.query !== "string") {
    throw new Error(
      `GraphQL contract case "${caseKey}": "query" is required and must be a string.`,
    );
  }

  const state: void = caseSpec.setup
    ? (await caseSpec.setup(ctx)) as void
    : undefined;

  try {
    const client = resolveClient(caseSpec as GraphqlContractCase, spec);

    const staticVars =
      typeof caseSpec.variables === "function"
        ? undefined
        : (caseSpec.variables as Record<string, unknown> | undefined);
    const staticHeaders =
      typeof caseSpec.headers === "function"
        ? undefined
        : (caseSpec.headers as Record<string, string> | undefined);

    const lensInput = (resolvedInputs ?? {}) as {
      variables?: Record<string, unknown>;
      headers?: Record<string, string>;
    };

    // Deep-merge lens variables over case static + spec default
    const mergedVariables = deepMerge(
      deepMerge(
        spec.defaultVariables as Record<string, unknown> | undefined,
        staticVars,
      ),
      lensInput.variables,
    );

    const mergedHeaders = {
      ...(spec.defaultHeaders ?? {}),
      ...(staticHeaders ?? {}),
      ...(lensInput.headers ?? {}),
    };

    const result = await callGraphql(
      client,
      caseSpec,
      spec,
      mergedVariables,
      Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
    );

    assertResult(ctx, result, caseSpec);

    if (caseSpec.verify) {
      await caseSpec.verify(ctx, result);
    }

    return result;
  } finally {
    if (caseSpec.teardown) {
      await caseSpec.teardown(ctx, state as never);
    }
  }
}

// =============================================================================
// validateCaseForFlow — reject function-valued fields in flow mode
// =============================================================================

export function validateGraphqlCaseForFlow(
  spec: GraphqlContractSpec,
  caseKey: string,
  contractId: string,
): void {
  const caseSpec = spec.cases[caseKey];
  if (!caseSpec) {
    throw new Error(
      `contract.graphql(${JSON.stringify(contractId)}).case(${JSON.stringify(caseKey)}): case not found.`,
    );
  }

  const functionFields: string[] = [];
  if (typeof caseSpec.variables === "function") functionFields.push("variables");
  if (typeof caseSpec.headers === "function") functionFields.push("headers");

  if (functionFields.length > 0) {
    throw new Error(
      `contract.graphql(${JSON.stringify(contractId)}).case(${JSON.stringify(caseKey)}): ` +
        `cannot use function-valued ${functionFields.join(" / ")} in a flow step — ` +
        `these fields depend on case-local setup state which isn't available in flow mode. ` +
        `Move the value into flow state and use step.in lens instead.`,
    );
  }
}

// =============================================================================
// classifyFailure — 3-layer (transport / payload / data shape)
// =============================================================================

/**
 * Classify failures based on:
 *   1. Transport: HTTP status from the underlying POST
 *   2. Payload: GraphQL `errors` array with optional `extensions.code`
 *   3. Error shape (network / timeout) when no response was parsed
 *
 * Emitted events inspected: `graphql_response` (if adapter/transport emits
 * it), else falls back to generic error shape.
 */
function classifyGraphqlFailure(input: {
  error?: unknown;
  events: Array<{ type: string; data: Record<string, unknown> }>;
}): FailureClassification | undefined {
  const gqlEvent = input.events.find((e) => e.type === "graphql_response");
  if (gqlEvent) {
    const httpStatus =
      typeof gqlEvent.data?.httpStatus === "number"
        ? (gqlEvent.data.httpStatus as number)
        : undefined;
    const errors = Array.isArray(gqlEvent.data?.errors)
      ? (gqlEvent.data.errors as GraphQLError[])
      : undefined;

    const transport = statusToClassification(httpStatus);
    if (transport) return transport;
    const payload = payloadErrorsToClassification(errors);
    if (payload) return payload;
    return undefined;
  }

  // Fall back to HTTP event emitted by the underlying transport
  const httpEvent = input.events.find((e) => e.type === "http_response");
  if (httpEvent) {
    const status =
      typeof httpEvent.data?.status === "number"
        ? (httpEvent.data.status as number)
        : undefined;
    const transport = statusToClassification(status);
    if (transport) return transport;
  }

  // Error shape fallback
  if (input.error instanceof Error) {
    const name = input.error.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return { kind: "transient", source: "trace", retryable: true, message: input.error.message };
    }
    if (name === "GraphQLResponseError") {
      return { kind: "semantic", source: "trace", message: input.error.message };
    }
    return { kind: "server", source: "trace", message: input.error.message };
  }
  return undefined;
}

function statusToClassification(
  status: number | undefined,
): FailureClassification | undefined {
  if (status === undefined) return undefined;
  if (status >= 200 && status < 300) return undefined;
  if (status === 401 || status === 403) {
    return { kind: "auth", source: "trace", message: `HTTP ${status}` };
  }
  if (status === 408 || status === 429) {
    return { kind: "transient", source: "trace", retryable: true, message: `HTTP ${status}` };
  }
  if (status >= 400 && status < 500) {
    return { kind: "client", source: "trace", message: `HTTP ${status}` };
  }
  if (status === 502 || status === 503 || status === 504) {
    return { kind: "transient", source: "trace", retryable: true, message: `HTTP ${status}` };
  }
  if (status >= 500) {
    return { kind: "server", source: "trace", message: `HTTP ${status}` };
  }
  return undefined;
}

/**
 * Interpret GraphQL `errors[].extensions.code` when present.
 *
 * Common codes: UNAUTHENTICATED, FORBIDDEN, BAD_USER_INPUT, NOT_FOUND,
 * INTERNAL_SERVER_ERROR. Unknown or missing codes → semantic.
 */
function payloadErrorsToClassification(
  errors: GraphQLError[] | undefined,
): FailureClassification | undefined {
  if (!errors || errors.length === 0) return undefined;
  const first = errors[0];
  const code = first.extensions?.code;
  const codeStr = typeof code === "string" ? code.toUpperCase() : "";

  if (codeStr === "UNAUTHENTICATED" || codeStr === "FORBIDDEN") {
    return { kind: "auth", source: "trace", message: first.message };
  }
  if (codeStr === "BAD_USER_INPUT" || codeStr === "GRAPHQL_VALIDATION_FAILED" || codeStr === "GRAPHQL_PARSE_FAILED") {
    return { kind: "client", source: "trace", message: first.message };
  }
  if (codeStr === "INTERNAL_SERVER_ERROR") {
    return { kind: "server", source: "trace", message: first.message };
  }
  return { kind: "semantic", source: "trace", message: first.message };
}

// =============================================================================
// renderTarget — display operationName (or endpoint if none)
// =============================================================================

function renderGraphqlTarget(target: string): string {
  // `target` here is `spec.endpoint` per projectGraphql. Display as-is;
  // per-case operationName is surfaced in toMarkdown, not here.
  return target || "(graphql)";
}

// =============================================================================
// toMarkdown — case list with operation + short query snippet
// =============================================================================

function summarizeQuery(query: string, limit = 80): string {
  const flat = query.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function toMarkdownGraphql(
  projection: ExtractedContractProjection<GraphqlSafeSchemas, GraphqlContractSafeMeta>,
): string {
  const lines: string[] = [];
  const endpoint = projection.target || "(no endpoint)";
  lines.push(`### ${projection.id} — GraphQL \`${endpoint}\``);
  if (projection.description) lines.push(`\n${projection.description}`);
  if (projection.deprecated) lines.push(`\n**Deprecated:** ${projection.deprecated}`);

  if (projection.cases.length === 0) {
    lines.push("\n_(no cases)_");
    return lines.join("\n");
  }

  lines.push("\n**Cases:**\n");
  for (const c of projection.cases) {
    const marker =
      c.lifecycle === "deprecated"
        ? " ⚠ deprecated"
        : c.lifecycle === "deferred"
          ? " ⏸ deferred"
          : "";
    const op = c.schemas?.operation ?? "query";
    const opName = c.schemas?.operationName ?? "anonymous";
    lines.push(`- \`${c.key}\`${marker} — ${op} \`${opName}\` — ${c.description ?? ""}`);
    if (c.schemas?.query) {
      lines.push(`  - \`${summarizeQuery(c.schemas.query)}\``);
    }
    if (c.deprecatedReason) lines.push(`  - deprecated: ${c.deprecatedReason}`);
    if (c.deferredReason) lines.push(`  - deferred: ${c.deferredReason}`);
  }

  return lines.join("\n");
}

// =============================================================================
// describePayload — high-level summary for index views
// =============================================================================

function describeGraphqlPayload(
  schemas: GraphqlSafeSchemas,
): PayloadDescriptor | undefined {
  const hasRequest = schemas.query !== undefined || schemas.variables !== undefined;
  const hasResponse = schemas.response !== undefined;
  return {
    hasRequest,
    hasResponse,
    protocol: "graphql",
  };
}

// =============================================================================
// Exported adapter
// =============================================================================

export const graphqlAdapter: ContractProtocolAdapter<
  GraphqlContractSpec,
  GraphqlPayloadSchemas,
  GraphqlContractMeta,
  GraphqlSafeSchemas,
  GraphqlContractSafeMeta
> = {
  async execute(ctx, caseSpec, contractSpec) {
    await executeCase(
      ctx,
      caseSpec as GraphqlContractCase,
      contractSpec as GraphqlContractSpec,
    );
  },
  project: projectGraphql,
  normalize: normalizeGraphql,
  executeCaseInFlow: executeCaseInFlowGraphql as ContractProtocolAdapter<
    GraphqlContractSpec
  >["executeCaseInFlow"],
  validateCaseForFlow: validateGraphqlCaseForFlow,
  classifyFailure: classifyGraphqlFailure,
  renderTarget: renderGraphqlTarget,
  toMarkdown: toMarkdownGraphql,
  describePayload: describeGraphqlPayload,
};
