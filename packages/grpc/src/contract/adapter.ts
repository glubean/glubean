/**
 * Built-in gRPC contract adapter for @glubean/grpc 0.2.0.
 *
 * Shipped alongside the transport plugin in @glubean/grpc (single-package
 * model — "contract is a first-class citizen"). Registered via
 * `contract.register("grpc", grpcAdapter)` on import — see ./index.ts.
 *
 * Responsibilities (same interface as HTTP adapter):
 *   - execute: run a case's setup → request → expect → verify → teardown
 *   - executeCaseInFlow: deep-merge resolvedInputs, run case in flow mode
 *   - validateCaseForFlow: reject function-valued request/metadata fields
 *   - project: runtime ContractProjection<GrpcPayloadSchemas>
 *   - normalize: runtime → JSON-safe ExtractedContractProjection
 *   - classifyFailure: gRPC status 0-16 → FailureKind
 *   - renderTarget: "Service/Method" → "Service.Method" (display-only)
 *   - toMarkdown: case list
 *   - describePayload: high-level summary for index views
 *
 * Phase 1 scope: unary RPCs only. Streaming deferred to Phase 2.
 */

import type {
  CaseMeta,
  ContractProtocolAdapter,
  ContractProjection,
  ExtractedCaseMeta,
  ExtractedContractProjection,
  FailureClassification,
  PayloadDescriptor,
} from "@glubean/sdk";
import type { TestContext } from "@glubean/sdk";
import { genericMarkdownPart } from "@glubean/sdk";

import type {
  GrpcClient,
} from "../index.js";
import type {
  GrpcContractCase,
  GrpcContractMeta,
  GrpcContractSafeMeta,
  GrpcContractSpec,
  GrpcPayloadSchemas,
  GrpcSafeSchemas,
  GrpcCaseResult,
} from "./types.js";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Split "Service/Method" wire target into parsed parts.
 * Returns `undefined` for malformed targets rather than throwing, so
 * normalize + projection can tolerate hand-authored data in scanner output.
 */
export function parseTarget(
  target: string,
): { service: string; method: string } | undefined {
  const slashIdx = target.indexOf("/");
  if (slashIdx <= 0 || slashIdx === target.length - 1) return undefined;
  return {
    service: target.slice(0, slashIdx),
    method: target.slice(slashIdx + 1),
  };
}

/** Convert a SchemaLike to a JSON Schema fragment if possible (best-effort). */
export function schemaToJsonSchema(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object") return null;
  // Zod v4 / Valibot pattern: `toJSONSchema` instance method.
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

/** Resolve the effective gRPC client with case > spec > instance fallback. */
function resolveClient(
  caseSpec: GrpcContractCase,
  spec: GrpcContractSpec,
): GrpcClient {
  const client = caseSpec.client ?? spec.client;
  if (!client) {
    throw new Error(
      `No gRPC client provided for case. Set "client" on the case or contract spec (e.g. via contract.grpc.with("name", { client: grpcPlugin })).`,
    );
  }
  return client;
}

/**
 * Merge metadata: instance defaults < contract defaults < case.
 * v10 — function form receives the case's logical input (matching `needs`),
 * NOT setup state.
 */
function resolveMetadata(
  spec: GrpcContractSpec,
  caseSpec: GrpcContractCase,
  resolvedInput: unknown,
): Record<string, string> | undefined {
  const caseMd =
    typeof caseSpec.metadata === "function"
      ? (caseSpec.metadata as (i: unknown) => Record<string, string>)(resolvedInput)
      : caseSpec.metadata;
  const specMd = spec.defaultMetadata;
  if (!caseMd && !specMd) return undefined;
  return { ...(specMd ?? {}), ...(caseMd ?? {}) };
}

/**
 * Resolve request with deep-merge: contract.defaultRequest < case.request.
 * v10 — function form receives the case's logical input (matching `needs`).
 */
function resolveRequest(
  spec: GrpcContractSpec,
  caseSpec: GrpcContractCase,
  resolvedInput: unknown,
): unknown {
  const caseReq =
    typeof caseSpec.request === "function"
      ? (caseSpec.request as (i: unknown) => unknown)(resolvedInput)
      : caseSpec.request;
  const merged = deepMerge(
    spec.defaultRequest as Record<string, unknown> | undefined,
    caseReq as Record<string, unknown> | undefined,
  );
  return merged;
}

/** Resolve deadline: case > spec > undefined. */
function resolveDeadline(
  spec: GrpcContractSpec,
  caseSpec: GrpcContractCase,
): number | undefined {
  return caseSpec.deadlineMs ?? spec.deadlineMs;
}

// =============================================================================
// executeCase — standard (non-flow) case execution
// =============================================================================

/**
 * Execute one gRPC contract case (attachment-model v10).
 *
 * `resolvedInput` is the case's already-validated logical input
 * (matches `needs` schema). Function-valued `request` / `metadata`
 * receive it as their argument. When the case has no `needs` and no
 * overlay/explicit-input is supplied, `resolvedInput` is undefined —
 * function-valued fields then receive undefined (author error per
 * §5.3 load-time guard "Adapter request builder is a function but
 * case has no `needs`"; runtime tolerates it).
 *
 * No per-case setup/teardown in v10 — the contract case is pure
 * semantics; setup-style work belongs to a `contract.bootstrap()`
 * overlay (whose `ctx.cleanup(...)` runs LIFO around this fn).
 */
async function executeStandaloneCaseGrpc(
  ctx: TestContext,
  caseSpec: GrpcContractCase,
  spec: GrpcContractSpec,
  resolvedInput: unknown,
): Promise<void> {
  const parsedTarget = parseTarget(spec.target);
  if (!parsedTarget) {
    throw new Error(
      `gRPC contract: invalid target "${spec.target}". Expected "ServiceName/MethodName".`,
    );
  }

  const client = resolveClient(caseSpec, spec);
  const request = resolveRequest(spec, caseSpec, resolvedInput);
  const metadata = resolveMetadata(spec, caseSpec, resolvedInput);
  const deadlineMs = resolveDeadline(spec, caseSpec);

  const callResult = await client.call(
    parsedTarget.method,
    request as Record<string, unknown>,
    {
      ...(metadata ? { metadata } : {}),
      ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    },
  );

  const result: GrpcCaseResult<unknown> = {
    message: callResult.message,
    status: callResult.status,
    responseMetadata: callResult.responseMetadata,
    duration: callResult.duration,
  };

  // Assertions
  const expect = caseSpec.expect ?? {};
  const expectedStatus = expect.statusCode ?? 0;

  if (result.status.code !== expectedStatus) {
    ctx.assert(
      false,
      `Expected gRPC status code ${expectedStatus} but got ${result.status.code} (${result.status.details})`,
      { actual: result.status.code, expected: expectedStatus },
    );
  }

  if (expectedStatus === 0) {
    if (expect.schema) {
      ctx.validate(result.message, expect.schema, `response message`);
    }
    if (expect.message) {
      ctx.expect(result.message).toMatchObject(expect.message as Record<string, unknown>);
    }
  }

  if (expect.metadataMatch) {
    ctx.expect(result.responseMetadata).toMatchObject(expect.metadataMatch);
  }
  if (expect.metadata) {
    ctx.validate(result.responseMetadata, expect.metadata, `response metadata`);
  }

  if (caseSpec.verify) {
    await caseSpec.verify(ctx, result);
  }
}

// =============================================================================
// project — runtime ContractProjection
// =============================================================================

function projectGrpc(
  spec: GrpcContractSpec,
): ContractProjection<GrpcPayloadSchemas, GrpcContractMeta> {
  const parsed = parseTarget(spec.target);
  const meta: GrpcContractMeta = {
    target: spec.target,
    service: parsed?.service ?? "",
    method: parsed?.method ?? "",
    defaultMetadata: spec.defaultMetadata,
    deadlineMs: spec.deadlineMs,
  };

  const cases: CaseMeta<GrpcPayloadSchemas, GrpcContractMeta>[] = Object.entries(
    spec.cases,
  ).map(([key, c]) => {
    const casted = c as GrpcContractCase;
    const lifecycle = casted.deprecated
      ? "deprecated"
      : casted.deferred
        ? "deferred"
        : "active";
    const schemas: GrpcPayloadSchemas = {
      request: spec.requestSchema,
      response: casted.expect?.schema,
      metadata: casted.expect?.metadata,
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
      // v10 attachment-model — thread `given` / `runnability` semantic +
      // inventory fields through projection. `hasNeeds` is the
      // authoritative rawBypass trigger downstream; `needsSchema` is
      // the live SchemaLike that normalize() converts to JSON-safe.
      given: casted.given,
      runnability: casted.runnability,
      hasNeeds: casted.needs !== undefined,
      needsSchema: casted.needs as unknown,
    };
  });

  // Read factory-provided metadata from the internal `_factory` channel
  // populated by `mergeGrpcDefaults`.
  const factory = (spec as unknown as {
    _factory?: { instanceName: string };
  })._factory;

  return {
    protocol: "grpc",
    target: spec.target,
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

function normalizeGrpc(
  projection: ContractProjection<GrpcPayloadSchemas, GrpcContractMeta> & { id: string },
): ExtractedContractProjection<GrpcSafeSchemas, GrpcContractSafeMeta> {
  const safeCases: ExtractedCaseMeta<GrpcSafeSchemas, GrpcContractSafeMeta>[] =
    projection.cases.map((c) => {
      const s = c.schemas ?? {};
      const safe: GrpcSafeSchemas = {
        request: schemaToJsonSchema(s.request) ?? undefined,
        response: schemaToJsonSchema(s.response) ?? undefined,
        metadata: schemaToJsonSchema(s.metadata) ?? undefined,
      };
      // v10 — convert needsSchema to JSON-safe (may be null when the
      // SchemaLike is opaque safeParse-only; `hasNeeds` decoupled
      // remains true regardless).
      const safeNeeds = schemaToJsonSchema(c.needsSchema) ?? undefined;
      return {
        ...c,
        schemas: safe,
        given: c.given,
        runnability: c.runnability,
        hasNeeds: c.hasNeeds,
        needsSchema: safeNeeds,
      };
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

/**
 * Flow-mode case execution. Called by core's FlowBuilder.step() dispatch.
 *
 * Core has already:
 *   1. Computed `resolvedInputs` via `step.bindings.in(state)` (may be partial)
 *   2. Prepared current flow state
 *   3. Passed the live ProtocolContract (access merged scoped-factory state
 *      via `contract._spec`)
 *
 * Adapter responsibilities:
 *   1. Merge resolvedInputs (shape: { request?, metadata?, deadlineMs? })
 *      over case static spec
 *   2. Run case setup / call / expect / verify (Rule 1: case teardown runs in
 *      step-local finally — contract-flow §7.3)
 *   3. Return GrpcFlowCaseOutput (= GrpcCaseResult<Res>) for `step.out` lens
 */
async function executeCaseInFlowGrpc(input: {
  ctx: TestContext;
  contract: { _spec: unknown };
  caseKey: string;
  resolvedInputs: unknown;
}): Promise<GrpcCaseResult<unknown>> {
  const { ctx, contract: c, caseKey, resolvedInputs } = input;
  const spec = c._spec as GrpcContractSpec;
  const caseSpec = spec.cases[caseKey];
  if (!caseSpec) {
    throw new Error(`gRPC contract: unknown case key "${caseKey}".`);
  }

  const parsed = parseTarget(spec.target);
  if (!parsed) {
    throw new Error(
      `gRPC contract: invalid target "${spec.target}". Expected "ServiceName/MethodName".`,
    );
  }

  // v10 — `resolvedInputs` is the LOGICAL case input (matches `needs`),
  // NOT an adapter patch. Function-valued `request` / `metadata` receive
  // it; static values pass through. No setup / teardown — gone in v10
  // (case has no lifecycle per attachment-model §4.1; flow orchestrator
  // owns lifecycle, bootstrap overlay does pre-state, not case).

  const client = resolveClient(caseSpec as GrpcContractCase, spec);
  const request = resolveRequest(spec, caseSpec as GrpcContractCase, resolvedInputs);
  const metadata = resolveMetadata(spec, caseSpec as GrpcContractCase, resolvedInputs);
  const deadlineMs = resolveDeadline(spec, caseSpec as GrpcContractCase);

  const callResult = await client.call(parsed.method, request as Record<string, unknown>, {
    ...(metadata ? { metadata } : {}),
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
  });

  const result: GrpcCaseResult<unknown> = {
    message: callResult.message,
    status: callResult.status,
    responseMetadata: callResult.responseMetadata,
    duration: callResult.duration,
  };

  // Assertions (same as standalone path).
  const expect = caseSpec.expect ?? {};
  const expectedStatus = expect.statusCode ?? 0;
  if (result.status.code !== expectedStatus) {
    ctx.assert(
      false,
      `Expected gRPC status code ${expectedStatus} but got ${result.status.code} (${result.status.details})`,
      { actual: result.status.code, expected: expectedStatus },
    );
  }

  if (expectedStatus === 0) {
    if (expect.schema) {
      ctx.validate(result.message, expect.schema, `response message`);
    }
    if (expect.message) {
      ctx.expect(result.message).toMatchObject(expect.message as Record<string, unknown>);
    }
  }

  if (expect.metadataMatch) {
    ctx.expect(result.responseMetadata).toMatchObject(expect.metadataMatch);
  }
  if (expect.metadata) {
    ctx.validate(result.responseMetadata, expect.metadata, `response metadata`);
  }

  if (caseSpec.verify) {
    await caseSpec.verify(ctx, result as GrpcCaseResult<unknown>);
  }

  return result;
}

// =============================================================================
// classifyFailure — gRPC status 0-16 → FailureKind
// =============================================================================

/**
 * Classify failures based on gRPC status codes and thrown errors.
 *
 * Status code reference:
 *   0 = OK
 *   1 = CANCELLED, 4 = DEADLINE_EXCEEDED, 14 = UNAVAILABLE — transient
 *   3 = INVALID_ARGUMENT, 9 = FAILED_PRECONDITION, 11 = OUT_OF_RANGE — client
 *   5 = NOT_FOUND, 6 = ALREADY_EXISTS, 10 = ABORTED — semantic
 *   7 = PERMISSION_DENIED, 16 = UNAUTHENTICATED — auth
 *   12 = UNIMPLEMENTED, 13 = INTERNAL, 15 = DATA_LOSS, 2 = UNKNOWN, 8 = RESOURCE_EXHAUSTED — server
 */
function classifyGrpcFailure(input: {
  error?: unknown;
  events: Array<{ type: string; data: Record<string, unknown> }>;
}): FailureClassification | undefined {
  // Look for explicit gRPC status events emitted during execution
  const statusEvent = input.events.find((e) => e.type === "grpc_status");
  const code =
    typeof statusEvent?.data?.code === "number"
      ? (statusEvent.data.code as number)
      : undefined;

  if (code === undefined) {
    // Fall back to error shape (e.g. transport timeout)
    if (input.error instanceof Error) {
      const name = input.error.name;
      if (name === "TimeoutError" || name === "DeadlineExceededError") {
        return { kind: "transient", source: "trace", retryable: true, message: "deadline exceeded" };
      }
      return { kind: "server", source: "trace", message: input.error.message };
    }
    return undefined;
  }

  return statusToClassification(code);
}

function statusToClassification(code: number): FailureClassification | undefined {
  switch (code) {
    case 0:
      return undefined; // OK
    case 1: // CANCELLED
    case 4: // DEADLINE_EXCEEDED
    case 14: // UNAVAILABLE
    case 8: // RESOURCE_EXHAUSTED — backpressure / quota; retryable with backoff
      return { kind: "transient", source: "trace", retryable: true, message: `gRPC ${code}` };
    case 3: // INVALID_ARGUMENT
    case 9: // FAILED_PRECONDITION
    case 11: // OUT_OF_RANGE
      return { kind: "client", source: "trace", message: `gRPC ${code}` };
    case 5: // NOT_FOUND
    case 6: // ALREADY_EXISTS
    case 10: // ABORTED — typically optimistic-concurrency; leave as semantic
              // but note product-specific interpretations may want transient
      return { kind: "semantic", source: "trace", message: `gRPC ${code}` };
    case 7: // PERMISSION_DENIED
    case 16: // UNAUTHENTICATED
      return { kind: "auth", source: "trace", message: `gRPC ${code}` };
    case 2: // UNKNOWN
    case 12: // UNIMPLEMENTED
    case 13: // INTERNAL
    case 15: // DATA_LOSS
    default:
      return { kind: "server", source: "trace", message: `gRPC ${code}` };
  }
}

// =============================================================================
// renderTarget — "Service/Method" → "Service.Method" for display
// =============================================================================

function renderGrpcTarget(target: string): string {
  const parsed = parseTarget(target);
  if (!parsed) return target;
  return `${parsed.service}.${parsed.method}`;
}

// =============================================================================
// describePayload — high-level summary for index views
// =============================================================================

function describeGrpcPayload(schemas: GrpcSafeSchemas): PayloadDescriptor | undefined {
  const hasRequest = schemas.request !== undefined;
  const hasResponse = schemas.response !== undefined;
  return {
    hasRequest,
    hasResponse,
    protocol: "grpc",
  };
}

// =============================================================================
// Exported adapter
// =============================================================================

export const grpcAdapter: ContractProtocolAdapter<
  GrpcContractSpec,
  GrpcPayloadSchemas,
  GrpcContractMeta,
  GrpcSafeSchemas,
  GrpcContractSafeMeta
> = {
  // v0 path: no overlay + no needs (no resolvedInput) → run case raw.
  // Per attachment-model §5.1 step 5; the dispatcher only reaches this
  // path when no overlay is registered AND `needs` is absent.
  async execute(ctx, caseSpec, contractSpec) {
    await executeStandaloneCaseGrpc(
      ctx,
      caseSpec as GrpcContractCase,
      contractSpec as GrpcContractSpec,
      undefined,
    );
  },
  // v10 attachment-model entry point. Dispatcher routes here when:
  //   - explicit input was supplied (§5.1 step 1), OR
  //   - bootstrap overlay produced `resolvedInput` (§5.1 step 3),
  //     after the overlay's run() and needs-validation passes.
  async executeCase({ ctx, contract, caseKey, resolvedInput }) {
    const spec = (contract as { _spec: unknown })._spec as GrpcContractSpec;
    const caseSpec = spec.cases[caseKey];
    if (!caseSpec) {
      throw new Error(`gRPC contract: unknown case key "${caseKey}".`);
    }
    await executeStandaloneCaseGrpc(
      ctx,
      caseSpec as GrpcContractCase,
      spec,
      resolvedInput,
    );
  },
  project: projectGrpc,
  normalize: normalizeGrpc,
  executeCaseInFlow: executeCaseInFlowGrpc as ContractProtocolAdapter<
    GrpcContractSpec
  >["executeCaseInFlow"],
  // v10: no validateCaseForFlow — function-valued `request` / `metadata`
  // are legal in flow mode (they receive the logical input from `step.in`
  // lens). `needs`-vs-function-fields consistency is enforced by the type
  // system + §5.3 load-time guard, not at flow registration.
  classifyFailure: classifyGrpcFailure,
  renderTarget: renderGrpcTarget,
  // Markdown uses the SDK's generic structured renderer — gRPC has no
  // protocol-specific augmentations to contribute.
  artifacts: {
    markdown: (projection) => genericMarkdownPart(projection),
  },
  describePayload: describeGrpcPayload,
};
