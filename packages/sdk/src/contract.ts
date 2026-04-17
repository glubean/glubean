/**
 * contract.http() — declarative API contract testing.
 *
 * Spec in, Test[] out. Each case becomes a runnable Test.
 * The return value extends Array<Test> so runner/resolve handles it natively.
 */

import type {
  ContractCase,
  ContractProjection,
  ContractProtocolAdapter,
  ContractRegistryMeta,
  HttpContract,
  HttpContractDefaults,
  HttpContractFactory,
  HttpContractRoot,
  HttpContractSpec,
  HttpFlowStepSpec,
  HttpSecurityScheme,
  ProtocolContract,
} from "./contract-types.js";
import type { HttpClient, Test, TestContext, TestMeta } from "./types.js";
import { registerTest } from "./internal.js";

// =============================================================================
// HttpContractImpl — extends Array<Test> with contract-level methods
// =============================================================================

/**
 * Create an HttpContract — a Test[] with contract-level properties.
 * Uses Object.assign on a plain array to avoid class-extends-Array pitfalls.
 */
function createHttpContract(
  id: string,
  endpoint: string,
  tests: Test[],
  request?: import("./types.js").SchemaLike<unknown>,
  description?: string,
  feature?: string,
  caseSchemas?: HttpContract["_caseSchemas"],
  instanceName?: string,
  security?: HttpSecurityScheme,
  deprecated?: string,
  extensions?: import("./contract-types.js").Extensions,
  requestContentType?: string,
  requestHeaders?: import("./types.js").SchemaLike<Record<string, string>>,
  requestExample?: unknown,
  requestExamples?: Record<string, import("./contract-types.js").ContractExample<unknown>>,
): HttpContract {
  const arr = [...tests];

  const asSteps = () => {
    return <S>(b: import("./index.js").TestBuilder<S>) => {
      for (const t of arr) {
        if (t.fn) {
          b.step(t.meta.name ?? t.meta.id, async (ctx) => {
            await t.fn!(ctx);
          });
        }
      }
      return b;
    };
  };

  const asStep = (caseKey?: string) => {
    const target = caseKey
      ? arr.find((t) => t.meta.id.endsWith(`.${caseKey}`))
      : arr.find((t) => t.fn !== undefined && !t.meta.deferred && !t.meta.deprecated);
    if (!target) throw new Error(`Case "${caseKey ?? "default"}" not found in contract "${id}"`);

    return <S>(b: import("./index.js").TestBuilder<S>) => {
      b.step(target.meta.name ?? target.meta.id, async (ctx) => {
        await target.fn!(ctx);
      });
      return b;
    };
  };

  return Object.assign(arr, {
    id, endpoint, request, description, feature,
    instanceName, security, deprecated, extensions,
    requestContentType, requestHeaders, requestExample, requestExamples,
    _caseSchemas: caseSchemas,
    asSteps, asStep,
  }) as HttpContract;
}

// =============================================================================
// Parse endpoint string
// =============================================================================

function parseEndpoint(endpoint: string): { method: string; path: string } {
  const spaceIdx = endpoint.indexOf(" ");
  if (spaceIdx === -1) return { method: "GET", path: endpoint };
  return {
    method: endpoint.slice(0, spaceIdx).toUpperCase(),
    path: endpoint.slice(spaceIdx + 1),
  };
}

/**
 * Extract the string value from a ParamValue (string or { value } object).
 */
function extractParamValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "value" in v) {
    return String((v as { value: string }).value);
  }
  return String(v);
}

/**
 * Convert a params/query Record<string, ParamValue> to Record<string, string>
 * by extracting `.value` from ParamValue objects.
 */
function flattenParamValues(
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

/**
 * Field names on the structured RequestSpec form. If any of these exist on `req`,
 * we treat it as structured; otherwise we treat it as a bare SchemaLike body shorthand.
 * This is the authoritative disambiguator — do NOT rely on probing SchemaLike methods
 * (safeParse/parse), because SchemaLike allows either one to be present.
 */
const STRUCTURED_REQUEST_FIELDS = ["body", "contentType", "headers", "example", "examples"] as const;

/**
 * Normalize RequestSpec to a structured form { body, contentType, headers, example, examples }.
 * Accepts either bare SchemaLike (treated as JSON body) or already-structured object.
 *
 * Disambiguation rule: structured form is recognized by presence of any known
 * structured field. Otherwise the input is a SchemaLike (either safeParse-only
 * or parse-only — both are valid).
 */
function normalizeRequest(
  req: import("./contract-types.js").RequestSpec | undefined,
): {
  body?: import("./types.js").SchemaLike<unknown>;
  contentType?: string;
  headers?: import("./types.js").SchemaLike<Record<string, string>>;
  example?: unknown;
  examples?: Record<string, import("./contract-types.js").ContractExample<unknown>>;
} | undefined {
  if (!req || typeof req !== "object") return undefined;
  // Structured form: has any of the known structured fields
  const hasStructuredField = STRUCTURED_REQUEST_FIELDS.some(
    (f) => f in (req as Record<string, unknown>),
  );
  if (hasStructuredField) {
    return req as any;
  }
  // Otherwise treat as SchemaLike (safeParse-only or parse-only)
  return { body: req as import("./types.js").SchemaLike<unknown> };
}

/**
 * Build request options based on content type. Supports:
 * - application/json (default) — body → requestOptions.json
 * - multipart/form-data — body (FormData | object) → requestOptions.body
 * - application/x-www-form-urlencoded — body (URLSearchParams | object) → requestOptions.body
 * - text/plain, application/octet-stream — body → requestOptions.body (string/binary)
 */
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
    // If body is already FormData, pass through. Otherwise, convert object to FormData.
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      return { body };
    }
    if (body && typeof body === "object") {
      const fd = new FormData();
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (v instanceof Blob || v instanceof File) {
          fd.append(k, v);
        } else {
          fd.append(k, String(v));
        }
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
  // text/plain, application/octet-stream, other — raw pass-through
  // Set Content-Type header if not already present (handled via headers in caller)
  return { body };
}

/**
 * Normalize response headers to lowercase keys + preserve multi-value shape.
 * HTTP spec: header names are case-insensitive. Some headers (Set-Cookie) can have multiple values.
 */
function normalizeResponseHeaders(headers: unknown): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  if (!headers) return result;

  // Handle Headers object (fetch / ky response headers)
  if (typeof (headers as Headers).forEach === "function" && typeof (headers as Headers).get === "function") {
    // Use .forEach which handles multi-value headers by concatenation
    (headers as Headers).forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      // Set-Cookie is the common multi-value case; split comma for best-effort
      if (lowerKey === "set-cookie") {
        const existing = result[lowerKey];
        const newValue = typeof existing === "string" ? [existing, value] : [...(existing ?? []), value];
        result[lowerKey] = newValue;
      } else {
        result[lowerKey] = value;
      }
    });
    return result;
  }

  // Handle plain object
  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (Array.isArray(value)) {
        result[lowerKey] = value.map(String);
      } else if (value != null) {
        result[lowerKey] = String(value);
      }
    }
  }
  return result;
}

// =============================================================================
// Build a Test from a single case
// =============================================================================

function buildCaseTest<T, S>(
  contractId: string,
  caseKey: string,
  endpoint: string,
  c: ContractCase<T, S>,
  spec: HttpContractSpec,
  instanceName?: string,
  security?: HttpSecurityScheme,
): Test {
  const { method, path } = parseEndpoint(endpoint);
  const contractTags = spec.tags ? (Array.isArray(spec.tags) ? spec.tags : [spec.tags]) : [];
  const caseTags = c.tags ?? [];
  const allTags = [...contractTags, ...caseTags];

  const testId = `${contractId}.${caseKey}`;
  const testName = `${contractId} — ${caseKey}`;

  // Contract-level deprecated propagates to cases (case value wins if both set)
  const effectiveDeprecated = c.deprecated ?? spec.deprecated;

  // Auto-imply: non-headless requires → defaultRun: "opt-in"
  const requires = c.requires ?? "headless";
  const defaultRun = c.defaultRun ?? (requires !== "headless" ? "opt-in" : "always");

  // Auto-tag: requires:browser, requires:out-of-band, default-run:opt-in
  const runtimeTags: string[] = [];
  if (requires !== "headless") runtimeTags.push(`requires:${requires}`);
  if (defaultRun === "opt-in") runtimeTags.push("default-run:opt-in");
  const finalTags = [...allTags, ...runtimeTags];

  const meta: TestMeta = {
    id: testId,
    name: testName,
    description: c.description,
    tags: finalTags.length > 0 ? finalTags : undefined,
    deferred: c.deferred,
    deprecated: effectiveDeprecated,
    requires,
    defaultRun,
  };

  const fn = async (ctx: import("./types.js").TestContext) => {
    // 1. Deprecated → skip (takes precedence over deferred)
    if (effectiveDeprecated) {
      ctx.skip(`deprecated: ${effectiveDeprecated}`);
    }
    // 2. Deferred → skip
    if (c.deferred) {
      ctx.skip(c.deferred);
    }

    // 2. Setup
    const state = c.setup ? await c.setup(ctx) : (undefined as S);

    try {
      // 3. Resolve client
      const client: HttpClient = (c.client ?? spec.client) as HttpClient;
      if (!client) {
        throw new Error(
          `No HTTP client provided for case "${caseKey}". ` +
          `Set "client" on the case or on the contract spec.`,
        );
      }

      // 4. Resolve params and path (flatten ParamValue objects to strings)
      const rawParams =
        typeof c.params === "function" ? c.params(state) : c.params;
      const params = flattenParamValues(rawParams as Record<string, unknown> | undefined);
      const resolvedPath = resolveParams(path, params);

      // 5. Build request options
      const requestOptions: Record<string, unknown> = {};
      const body = typeof c.body === "function" ? (c.body as Function)(state) : c.body;

      // Resolve content type: case override > contract default > application/json
      const normalizedRequest = normalizeRequest(spec.request);
      const effectiveContentType = c.contentType ?? normalizedRequest?.contentType ?? "application/json";

      // Dispatch body serialization based on content type
      if (body !== undefined) {
        Object.assign(requestOptions, buildRequestBodyOptions(body, effectiveContentType));
      }
      const headers = typeof c.headers === "function" ? (c.headers as Function)(state) : c.headers;
      if (headers) requestOptions.headers = headers;
      if (c.query) {
        const rawQuery = typeof c.query === "function" ? c.query(state) : c.query;
        requestOptions.searchParams = flattenParamValues(rawQuery as Record<string, unknown> | undefined);
      }
      requestOptions.throwHttpErrors = false;

      // 6. Send request
      const methodLower = method.toLowerCase() as keyof HttpClient;
      let res;
      try {
        res = await (client[methodLower] as Function)(
          resolvedPath,
          requestOptions,
        );
      } catch (err: unknown) {
        // Enhance timeout errors with configured timeout value
        if (err instanceof Error && err.name === "TimeoutError") {
          const timeoutMs = (client as any)._configuredTimeout ?? 10000;
          throw new Error(
            `${err.message} (timeout: ${timeoutMs}ms)`,
          );
        }
        throw err;
      }

      // 7. Assert status
      ctx.expect(res).toHaveStatus(c.expect.status);

      // 7b. Validate response headers (if schema provided)
      if (c.expect.headers) {
        const normalizedHeaders = normalizeResponseHeaders(res.headers);
        ctx.validate(normalizedHeaders, c.expect.headers, `${testId} response headers`);
      }

      // 8. Parse response + validate schema
      let parsed: T;
      if (c.expect.schema) {
        const body = await res.json();
        const validated = ctx.validate(body, c.expect.schema, `${testId} response`);
        parsed = (validated !== undefined ? validated : body) as T;
      } else if (c.verify) {
        // No schema but verify needs the body — parse as raw JSON
        parsed = (await res.json()) as T;
      } else {
        parsed = undefined as T;
      }

      // 9. Verify callback
      if (c.verify) {
        await c.verify(ctx, parsed);
      }
    } finally {
      // 10. Teardown (always)
      if (c.teardown) {
        await c.teardown(ctx, state);
      }
    }
  };

  // Lifecycle normalization: deprecated > deferred > active
  const lifecycle: import("./contract-types.js").CaseLifecycle =
    c.deprecated ? "deprecated" :
    c.deferred ? "deferred" :
    "active";
  const severity: import("./contract-types.js").CaseSeverity = c.severity ?? "warning";

  // Register to global registry with protocol-agnostic contract metadata
  const registryMeta: ContractRegistryMeta = {
    target: endpoint,
    protocol: "http",
    caseKey,
    lifecycle,
    severity,
    hasSchema: !!c.expect.schema,
    instanceName,
    protocolMeta: {
      ...(security != null ? { security } : {}),
      expect: { status: c.expect.status },
    },
  };

  registerTest({
    id: testId,
    name: testName,
    type: "simple",
    tags: finalTags.length > 0 ? finalTags : undefined,
    groupId: contractId,
    requires,
    defaultRun,
    contract: registryMeta,
  });

  return { meta, type: "simple", fn };
}

// =============================================================================
// contract.http()
// =============================================================================

function contractHttp<
  Cases extends Record<string, ContractCase<any, any>>,
>(
  id: string,
  spec: HttpContractSpec<Cases>,
  instanceName?: string,
  security?: HttpSecurityScheme,
): HttpContract {
  const tests: Test[] = [];
  const caseSchemas: NonNullable<import("./contract-types.js").HttpContract["_caseSchemas"]> = {};

  for (const [caseKey, caseSpec] of Object.entries(spec.cases)) {
    tests.push(buildCaseTest(id, caseKey, spec.endpoint, caseSpec, spec, instanceName, security));
    // Resolve effective requires/defaultRun (same logic as buildCaseTest)
    const effectiveRequires = caseSpec.requires ?? "headless";
    const effectiveDefaultRun = caseSpec.defaultRun ?? (effectiveRequires !== "headless" ? "opt-in" : "always");
    // Effective deprecated: case wins, fall back to contract-level
    const effectiveDeprecated = caseSpec.deprecated ?? spec.deprecated;
    // Lifecycle normalization: deprecated > deferred > active
    const lifecycle: import("./contract-types.js").CaseLifecycle =
      effectiveDeprecated ? "deprecated" :
      caseSpec.deferred ? "deferred" :
      "active";

    // Extract per-param schemas (only from object-shaped ParamValues, not string shorthand)
    const paramSchemas = extractParamMetaSchemas(caseSpec.params);
    const querySchemas = extractParamMetaSchemas(caseSpec.query);

    // Merge case-level extensions over contract-level (spec.extensions is already defaults+contract merged)
    const caseExtensions = mergeExtensions(spec.extensions, caseSpec.extensions);

    caseSchemas[caseKey] = {
      expectStatus: caseSpec.expect.status,
      responseSchema: caseSpec.expect.schema,
      responseHeaders: caseSpec.expect.headers,
      responseContentType: caseSpec.expect.contentType,
      example: caseSpec.expect.example,
      examples: caseSpec.expect.examples as Record<string, import("./contract-types.js").ContractExample<unknown>> | undefined,
      paramSchemas,
      querySchemas,
      description: caseSpec.description,
      deferred: caseSpec.deferred,
      deprecated: effectiveDeprecated,
      severity: caseSpec.severity,
      lifecycle,
      requires: effectiveRequires,
      defaultRun: effectiveDefaultRun,
      extensions: caseExtensions,
    };
  }

  // Normalize request (SchemaLike or RequestSpec object → structured fields)
  const normalizedReq = normalizeRequest(spec.request);

  return createHttpContract(
    id, spec.endpoint, tests, normalizedReq?.body, spec.description, spec.feature,
    caseSchemas, instanceName, security, spec.deprecated, spec.extensions,
    normalizedReq?.contentType,
    normalizedReq?.headers,
    normalizedReq?.example,
    normalizedReq?.examples,
  );
}

/**
 * Extract per-param schema metadata from a params/query object.
 * Only collects entries where the ParamValue is an object (has `.value` + optional schema/description).
 * String shorthand values produce no metadata.
 */
function extractParamMetaSchemas(
  params: Record<string, unknown> | ((state: unknown) => Record<string, string>) | undefined,
): Record<string, { schema?: import("./types.js").SchemaLike<unknown>; description?: string; required?: boolean; deprecated?: boolean }> | undefined {
  if (!params || typeof params === "function") return undefined;
  const result: Record<string, { schema?: import("./types.js").SchemaLike<unknown>; description?: string; required?: boolean; deprecated?: boolean }> = {};
  let hasAny = false;
  for (const [key, val] of Object.entries(params)) {
    if (val && typeof val === "object" && !Array.isArray(val) && "value" in val) {
      const pv = val as { schema?: import("./types.js").SchemaLike<unknown>; description?: string; required?: boolean; deprecated?: boolean };
      if (pv.schema !== undefined || pv.description !== undefined || pv.required !== undefined || pv.deprecated !== undefined) {
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
// FlowBuilder — declarative stateful endpoint chain (verification)
// =============================================================================

interface FlowStepMeta {
  name: string;
  endpoint: string;
  expectStatus: number;
}

class FlowBuilder<S = unknown> {
  private _id: string;
  private _defaultClient?: HttpClient;
  private _tags?: string[];
  private _requires?: import("./contract-types.js").CaseRequires;
  private _defaultRun?: import("./contract-types.js").CaseDefaultRun;
  private _steps: Array<{
    meta: FlowStepMeta;
    fn: (ctx: TestContext, state: any) => Promise<any>;
  }> = [];
  private _setupFn?: (ctx: TestContext) => Promise<any>;
  private _teardownFn?: (ctx: TestContext, state: any) => Promise<void>;

  constructor(id: string, options?: {
    client?: HttpClient;
    tags?: string[];
    /** Physical capability this flow requires. Default: "headless". */
    requires?: import("./contract-types.js").CaseRequires;
    /** Default run policy. Default: "always". Non-headless implies "opt-in". */
    defaultRun?: import("./contract-types.js").CaseDefaultRun;
  }) {
    this._id = id;
    this._defaultClient = options?.client;
    this._tags = options?.tags;
    this._requires = options?.requires;
    this._defaultRun = options?.defaultRun;
  }

  setup<NewS>(fn: (ctx: TestContext) => Promise<NewS>): FlowBuilder<NewS> {
    this._setupFn = fn;
    return this as unknown as FlowBuilder<NewS>;
  }

  teardown(fn: (ctx: TestContext, state: S) => Promise<void>): FlowBuilder<S> {
    this._teardownFn = fn;
    return this;
  }

  http<T, NewS>(
    name: string,
    spec: import("./contract-types.js").HttpFlowStepSpec<T, S> & { returns: (res: T, state: S) => NewS },
  ): FlowBuilder<NewS>;
  http<T>(
    name: string,
    spec: import("./contract-types.js").HttpFlowStepSpec<T, S> & { returns?: undefined },
  ): FlowBuilder<S>;
  http(
    name: string,
    spec: import("./contract-types.js").HttpFlowStepSpec<any, any>,
  ): FlowBuilder<any> {
    const { method, path } = parseEndpoint(spec.endpoint);
    const expectedStatus = spec.expect.status;

    const stepFn = async (ctx: TestContext, state: any): Promise<any> => {
      // Resolve client
      const client: HttpClient = (spec.client ?? this._defaultClient) as HttpClient;
      if (!client) {
        throw new Error(`No HTTP client for flow step "${name}". Set client on the step or flow.`);
      }

      // Resolve params/query/body from state
      const params = typeof spec.params === "function" ? spec.params(state) : spec.params;
      const resolvedPath = resolveParams(path, params);
      const query = typeof spec.query === "function" ? spec.query(state) : spec.query;
      const body = typeof spec.body === "function" ? (spec.body as Function)(state) : spec.body;

      // Build request options
      const opts: Record<string, unknown> = { throwHttpErrors: false };
      if (body !== undefined) opts.json = body;
      const headers = typeof spec.headers === "function" ? spec.headers(state) : spec.headers;
      if (headers) opts.headers = headers;
      if (query) opts.searchParams = query;

      // Send request
      const methodLower = method.toLowerCase() as keyof HttpClient;
      let res;
      try {
        res = await (client[methodLower] as Function)(resolvedPath, opts);
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "TimeoutError") {
          const timeoutMs = (client as any)._configuredTimeout ?? 10000;
          throw new Error(`${err.message} (timeout: ${timeoutMs}ms)`);
        }
        throw err;
      }

      // Assert status
      ctx.expect(res).toHaveStatus(expectedStatus);

      // Validate schema + parse response
      let parsed: any;
      if (spec.expect.schema) {
        const jsonBody = await res.json();
        const validated = ctx.validate(jsonBody, spec.expect.schema, `${this._id}/${name} response`);
        parsed = validated !== undefined ? validated : jsonBody;
      } else if (spec.verify || spec.returns) {
        parsed = await res.json();
      }

      // Verify callback
      if (spec.verify) {
        await spec.verify(ctx, parsed);
      }

      // State evolution
      if (spec.returns) {
        return spec.returns(parsed, state);
      }
      return state;
    };

    this._steps.push({
      meta: { name, endpoint: spec.endpoint, expectStatus: expectedStatus },
      fn: stepFn,
    });

    return this as FlowBuilder<any>;
  }

  build(): Test & {
    readonly flowId: string;
    readonly flowSteps: FlowStepMeta[];
    asSteps(): <B>(b: import("./index.js").TestBuilder<B>) => import("./index.js").TestBuilder<B>;
  } {
    // Auto-imply: non-headless requires → defaultRun: "opt-in"
    const requires = this._requires ?? "headless";
    const defaultRun = this._defaultRun ?? (requires !== "headless" ? "opt-in" : "always");

    // Auto-tag
    const baseTags = this._tags ?? [];
    const runtimeTags: string[] = [];
    if (requires !== "headless") runtimeTags.push(`requires:${requires}`);
    if (defaultRun === "opt-in") runtimeTags.push("default-run:opt-in");
    const finalTags = [...baseTags, ...runtimeTags];

    const test: Test = {
      meta: {
        id: this._id,
        name: this._id,
        tags: finalTags.length > 0 ? finalTags : undefined,
        requires,
        defaultRun,
      },
      type: "steps",
      setup: this._setupFn as any,
      teardown: this._teardownFn as any,
      steps: this._steps.map((s) => ({
        meta: { name: s.meta.name },
        fn: s.fn,
      })),
    };

    const flowStepsMeta = this._steps.map((s) => s.meta);

    // Register to global registry with flow metadata
    registerTest({
      id: this._id,
      name: this._id,
      type: "steps",
      tags: finalTags.length > 0 ? finalTags : undefined,
      requires,
      defaultRun,
      steps: this._steps.map((s) => ({ name: s.meta.name })),
      hasSetup: !!this._setupFn,
      hasTeardown: !!this._teardownFn,
      flow: {
        steps: flowStepsMeta,
      },
    });

    const asSteps = () => {
      const steps = test.steps!;
      const setupFn = this._setupFn;
      const teardownFn = this._teardownFn;
      return <B>(b: import("./index.js").TestBuilder<B>) => {
        // Note: setup and teardown are injected as regular steps.
        // This means teardown does NOT have finally semantics —
        // if an earlier step fails, teardown won't run.
        // For guaranteed cleanup, use standalone flow or add
        // .teardown() on the outer test builder.
        if (setupFn) {
          b.step(`${this._id} [setup]`, async (ctx) => {
            return setupFn(ctx);
          });
        }
        // Inject flow steps
        for (const s of steps) {
          b.step(s.meta.name, async (ctx, state) => {
            return s.fn(ctx, state);
          });
        }
        // Inject teardown as last step if flow has one
        if (teardownFn) {
          b.step(`${this._id} [teardown]`, async (ctx, state) => {
            await teardownFn(ctx, state);
            return state;
          });
        }
        return b;
      };
    };

    return Object.assign(test, { flowId: this._id, flowSteps: flowStepsMeta, asSteps }) as any;
  }
}

function contractFlow(id: string, options?: { client?: HttpClient; tags?: string[] }): FlowBuilder {
  return new FlowBuilder(id, options);
}

// =============================================================================
// contract namespace + register()
// =============================================================================

const _adapters = new Map<string, ContractProtocolAdapter<any>>();

// =============================================================================
// HTTP contract factory — contract.http.with("name", defaults)
// =============================================================================

/**
 * Merge instance defaults with per-contract spec.
 * Tags are additive (concat), other fields: spec overrides defaults.
 */
function mergeHttpDefaults(
  defaults: (HttpContractDefaults & { _name?: string }) | undefined,
  spec: HttpContractSpec,
): HttpContractSpec {
  if (!defaults) return spec;
  const mergedTags = [
    ...(defaults.tags ?? []),
    ...(spec.tags ?? []),
  ];
  // Merge extensions: defaults < contract (contract key overrides defaults key)
  const mergedExtensions = mergeExtensions(defaults.extensions, spec.extensions);
  return {
    ...spec,
    client: spec.client ?? defaults.client,
    feature: spec.feature ?? defaults.feature,
    tags: mergedTags.length > 0 ? mergedTags : undefined,
    extensions: mergedExtensions,
  };
}

/**
 * Merge two Extensions records. Right wins on key conflict.
 * Returns undefined if result would be empty.
 */
function mergeExtensions(
  base: import("./contract-types.js").Extensions | undefined,
  override: import("./contract-types.js").Extensions | undefined,
): import("./contract-types.js").Extensions | undefined {
  if (!base && !override) return undefined;
  const merged: Record<string, unknown> = { ...(base ?? {}), ...(override ?? {}) };
  return Object.keys(merged).length > 0
    ? (merged as import("./contract-types.js").Extensions)
    : undefined;
}

/**
 * Create an HTTP contract factory with `.with()` support.
 * The factory is callable (same signature as contractHttp) and chainable.
 */
/**
 * Create an HTTP contract factory. If `defaults` is provided (via .with()),
 * the factory is callable. If not, only .with() is available — direct
 * contract.http("id", spec) is not supported.
 */
function createHttpFactory(
  defaults?: HttpContractDefaults & { _name?: string },
): HttpContractFactory {
  const factory = <Cases extends Record<string, ContractCase<any, any>>>(
    id: string,
    spec: HttpContractSpec<Cases>,
  ): HttpContract => {
    if (!defaults?._name) {
      throw new Error(
        `contract.http("${id}", spec) is not supported. ` +
        `Use contract.http.with("name", { client }) first to create a scoped instance, ` +
        `then call instance("${id}", spec).`,
      );
    }
    const merged = mergeHttpDefaults(defaults, spec as HttpContractSpec);
    return contractHttp(id, merged as HttpContractSpec<Cases>, defaults._name, defaults.security);
  };

  factory.with = (name: string, more: HttpContractDefaults): HttpContractFactory => {
    const mergedTags = [...(defaults?.tags ?? []), ...(more.tags ?? [])];
    const mergedExtensions = mergeExtensions(defaults?.extensions, more.extensions);
    return createHttpFactory({
      ...defaults,
      ...more,
      tags: mergedTags.length > 0 ? mergedTags : undefined,
      extensions: mergedExtensions,
      _name: name,
    });
  };

  return factory;
}

/**
 * The contract namespace.
 *
 * - `contract.http.with("name", defaults)` — create scoped HTTP factory
 * - `contract.flow(id, options)` — declarative flow builder
 * - `contract.register(protocol, adapter)` — plugin extension point
 * - `contract[protocol](id, spec)` — available after register()
 */
export const contract: {
  http: HttpContractRoot;
  flow: typeof contractFlow;
  register: <Spec>(protocol: string, adapter: ContractProtocolAdapter<Spec>) => void;
  [protocol: string]: unknown;
} = {
  http: createHttpFactory() as unknown as HttpContractRoot,
  flow: contractFlow,

  register<Spec>(protocol: string, adapter: ContractProtocolAdapter<Spec>) {
    if (protocol === "http" || protocol === "flow" || protocol === "register") {
      throw new Error(`Cannot register reserved protocol "${protocol}"`);
    }
    _adapters.set(protocol, adapter);

    // Dynamically attach contract[protocol]()
    (contract as any)[protocol] = (
      id: string,
      spec: Spec & { cases?: Record<string, { description?: string; deferred?: string; deprecated?: string; severity?: import("./contract-types.js").CaseSeverity; requires?: import("./contract-types.js").CaseRequires; defaultRun?: import("./contract-types.js").CaseDefaultRun; tags?: string[] }>; tags?: string[] },
    ): ProtocolContract => {
      // Get projection from adapter v2
      const projection: ContractProjection = adapter.project(spec);

      // Validate: no duplicate keys in projected cases
      const projKeyList = projection.cases.map(c => c.key);
      const projKeySet = new Set(projKeyList);
      if (projKeySet.size !== projKeyList.length) {
        const dupes = projKeyList.filter((k, i) => projKeyList.indexOf(k) !== i);
        throw new Error(
          `contract.register("${protocol}"): project() returned duplicate case key(s): ${[...new Set(dupes)].join(", ")}. ` +
          `Each projected case key must be unique.`,
        );
      }

      // Validate 1:1 key invariant between projection and spec.cases
      const specKeys = new Set(Object.keys(spec.cases ?? {}));
      for (const key of projKeySet) {
        if (!specKeys.has(key)) {
          throw new Error(
            `contract.register("${protocol}"): project() returned case "${key}" not present in spec.cases. ` +
            `Projected cases must 1:1 match spec.cases keys.`,
          );
        }
      }
      for (const key of specKeys) {
        if (!projKeySet.has(key)) {
          throw new Error(
            `contract.register("${protocol}"): spec.cases has "${key}" but project() did not return it. ` +
            `Projected cases must 1:1 match spec.cases keys.`,
          );
        }
      }

      const cases = spec.cases ?? {};
      const contractTags = spec.tags ? (Array.isArray(spec.tags) ? spec.tags : [spec.tags]) : [];

      // Build a lookup from projection cases by key
      const projCaseMap = new Map(projection.cases.map(c => [c.key, c]));

      const tests: Test[] = Object.entries(cases).map(([caseKey, caseSpec]) => {
        const testId = `${id}.${caseKey}`;
        const testName = `${id} — ${caseKey}`;
        const caseTags = caseSpec.tags ?? [];
        const allTags = [...contractTags, ...caseTags];
        const projCase = projCaseMap.get(caseKey)!;

        // Derive runtime requires/defaultRun from projection (authoritative)
        // with case spec as fallback, mirroring HTTP path logic
        const requires = projCase.requires ?? caseSpec.requires ?? "headless";
        const defaultRun = projCase.defaultRun ?? caseSpec.defaultRun ?? (requires !== "headless" ? "opt-in" : "always");

        // Runtime tags from requires/defaultRun
        const runtimeTags: string[] = [];
        if (requires !== "headless") runtimeTags.push(`requires:${requires}`);
        if (defaultRun === "opt-in") runtimeTags.push("default-run:opt-in");
        const finalTags = [...allTags, ...runtimeTags];

        // Derive skip from projected lifecycle (authoritative), not just caseSpec fields
        const skipDeprecated = projCase.lifecycle === "deprecated"
          ? `deprecated: ${projCase.deprecatedReason ?? caseSpec.deprecated ?? "deprecated"}`
          : caseSpec.deprecated ? `deprecated: ${caseSpec.deprecated}` : undefined;
        const skipDeferred = projCase.lifecycle === "deferred"
          ? (projCase.deferredReason ?? caseSpec.deferred ?? "deferred")
          : caseSpec.deferred;

        const testDef: Test = {
          meta: {
            id: testId,
            name: testName,
            description: projCase.description,
            tags: finalTags.length > 0 ? finalTags : undefined,
            deferred: skipDeferred,
            deprecated: skipDeprecated ? (projCase.deprecatedReason ?? caseSpec.deprecated ?? "deprecated") : undefined,
            requires,
            defaultRun,
          },
          type: "simple",
          fn: async (ctx) => {
            if (skipDeprecated) ctx.skip(skipDeprecated);
            if (skipDeferred) ctx.skip(skipDeferred);
            await adapter.execute(ctx, caseSpec, spec);
          },
        };

        registerTest({
          id: testId,
          name: testName,
          type: "simple",
          tags: finalTags.length > 0 ? finalTags : undefined,
          groupId: id,
          requires,
          defaultRun,
          contract: {
            target: projection.target,
            protocol: projection.protocol,
            caseKey,
            lifecycle: projCase.lifecycle,
            severity: projCase.severity,
            hasSchema: projCase.responseSchema != null,
            instanceName: projection.instanceName,
            protocolMeta: {
              ...(projection.protocolMeta ?? {}),
              ...(projCase.protocolExpect ? { expect: projCase.protocolExpect } : {}),
              ...(projCase.protocolMeta ?? {}),
            },
          },
        });

        return testDef;
      });

      // Inject contract id into projection (adapter doesn't know the user-supplied id)
      const enrichedProjection = { ...projection, id };

      // Return ProtocolContract — Test[] with _projection carrier
      return Object.assign(tests, { _projection: enrichedProjection }) as ProtocolContract;
    };
  },
};
