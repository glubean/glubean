/**
 * gRPC contract types.
 *
 * User-facing authoring types + adapter-level payload types for the
 * gRPC contract adapter (single-package model — see
 * `internal/40-discovery/proposals/contract-grpc-graphql-expansion.md` §5.1).
 *
 * Structure mirrors `packages/sdk/src/contract-http/types.ts` where
 * applicable, with gRPC-specific semantics:
 *   - Target is "Service/Method" (wire format); renderTarget → "Service.Method"
 *   - Status codes are gRPC 0-16 (not HTTP 4xx/5xx)
 *   - Metadata replaces HTTP headers (metadata carries both ingress + egress)
 *   - Deadlines replace HTTP timeouts (ms)
 *   - Phase 1 scope: unary RPCs only (no streaming)
 */

import type { SchemaLike, TestContext } from "@glubean/sdk";
import type {
  BaseCaseSpec,
  Extensions,
  ProtocolContract,
} from "@glubean/sdk";
import type { GrpcClient } from "../index.js";

// =============================================================================
// Instance defaults (contract.grpc.with)
// =============================================================================

/**
 * Defaults for a gRPC contract instance (contract.grpc.with("name", {...})).
 *
 * Note: connection-level settings (address, TLS, proto path) are owned by
 * the transport plugin (configure({grpc: grpc({proto, address, ...})})).
 * The contract-layer instance only captures content defaults that apply
 * across contracts authored under this instance.
 */
export interface GrpcContractDefaults {
  /** Default gRPC client for all contracts in this instance. */
  client?: GrpcClient;
  /** Tags inherited by all contracts in this instance. */
  tags?: string[];
  /** Default feature grouping key. */
  feature?: string;
  /** Default metadata for all contracts (merged per-case). */
  metadata?: Record<string, string>;
  /** Default deadline in ms for all contracts in this instance. */
  deadlineMs?: number;
  /** OpenAPI-style extensions (x-* keys). Inherited by all contracts. */
  extensions?: Extensions;
}

// =============================================================================
// Examples (OpenAPI-style docs)
// =============================================================================

export interface GrpcContractExample<T = unknown> {
  value: T;
  summary?: string;
  description?: string;
}

// =============================================================================
// Expect (response expectations)
// =============================================================================

/**
 * Response expectations for a gRPC case.
 *
 * `statusCode` is the gRPC canonical status (0 = OK, 3 = INVALID_ARGUMENT,
 * 5 = NOT_FOUND, 7 = PERMISSION_DENIED, 14 = UNAVAILABLE, 16 = UNAUTHENTICATED,
 * etc.). Phase 1 default: `0` (OK) when not specified.
 */
export interface GrpcContractExpect<T = unknown> {
  /** Expected gRPC status code (0 = OK). Default: 0 when omitted. */
  statusCode?: number;
  /** Zod/Valibot schema for response message (when statusCode === 0). */
  schema?: SchemaLike<T>;
  /** Partial expected message shape (object — `toMatchObject` semantics). */
  message?: Partial<T>;
  /** Schema for response metadata (trailing). */
  metadata?: SchemaLike<Record<string, string>>;
  /** Partial expected response metadata. */
  metadataMatch?: Record<string, string>;
  /** Single response example (for docs / projection). */
  example?: T;
  /** Named response examples. */
  examples?: Record<string, GrpcContractExample<T>>;
}

// =============================================================================
// Case spec
// =============================================================================

/**
 * One case on a gRPC contract (attachment-model v10).
 *
 * Function-valued `request` / `metadata` receive the case's **logical
 * input** — the value matching `needs: SchemaLike<Needs>`. In standalone
 * mode the input comes from a bootstrap overlay's `run()` output or
 * CLI `--input-json`; in flow mode from `step.bindings.in(state)`. There
 * is no per-case setup state in v10 (per attachment-model §4.1 — case is
 * pure semantics, not lifecycle).
 */
export interface GrpcContractCase<Req = unknown, Res = unknown, Needs = void>
  extends BaseCaseSpec {
  /**
   * Per-case logical input schema (redeclares `BaseCaseSpec.needs` with
   * the case's own `Needs` so action fields can type-narrow correctly).
   * Mirrors HTTP `ContractCase.needs` redeclaration (Phase 2c B+C).
   */
  needs?: SchemaLike<Needs>;

  /** Per-case gRPC client override. */
  client?: GrpcClient;

  /** Why this case exists — required. */
  description: string;

  /** Expected response. */
  expect?: GrpcContractExpect<Res>;

  /**
   * Request message. Object shorthand or a function of the case's
   * logical input (matching `needs`). Merged deep-style over contract
   * `defaultRequest`.
   */
  request?: Req | ((input: Needs) => Req);

  /**
   * Per-call metadata (merged with instance + contract defaults).
   * Function form receives the case's logical input.
   */
  metadata?: Record<string, string> | ((input: Needs) => Record<string, string>);

  /** Per-call deadline in ms (overrides instance / contract defaults). */
  deadlineMs?: number;

  /** Business-logic verify — runs after status + schema + message match. */
  verify?: (ctx: TestContext, res: GrpcCaseResult<Res>) => void | Promise<void>;
}

/**
 * Case factory for input-bearing gRPC cases.
 *
 * TypeScript cannot infer and correlate `needs` with function-valued sibling
 * fields inside a plain object literal. Capturing `Needs` at the case's own
 * const site makes `request` and `metadata` functions type-check against the
 * declared logical input.
 *
 * The default request type is a record rather than `unknown` so the static
 * branch does not swallow function values and bypass the `Needs` check.
 */
export function defineGrpcCase<
  Needs = void,
  Req = Record<string, unknown>,
  Res = unknown,
>(c: GrpcContractCase<Req, Res, Needs>): GrpcContractCase<Req, Res, Needs> {
  return c;
}

// =============================================================================
// Case result (shape passed to verify and to flow `out` lens)
// =============================================================================

/**
 * Result of running a single case. This is also the `CaseOutput` shape that
 * flow `step.out(state, res)` lens receives.
 *
 * Mirrors `@glubean/grpc`'s `GrpcCallResult<T>` but nested under a contract-
 * layer shape so adapter-layer additions (e.g. assertion diagnostics) can
 * grow independently.
 */
export interface GrpcCaseResult<Res = unknown> {
  /** Decoded response message. */
  message: Res;
  /** gRPC status. `code` is 0 for OK. */
  status: {
    code: number;
    details: string;
  };
  /** Response (trailing) metadata. */
  responseMetadata: Record<string, string>;
  /** Duration in ms. */
  duration: number;
}

// =============================================================================
// Contract spec
// =============================================================================

/**
 * User-facing gRPC contract specification.
 *
 * `target` is the wire-format "Service/Method" string (e.g. "PaymentService/
 * Complete"). `renderTarget` will display as "PaymentService.Complete" in
 * UI but wire format stays as source of truth.
 *
 * Contract identity = contract id (string) + case key. Target is a display
 * hint, NOT an identity — proposal §5.3.
 */
export interface GrpcContractSpec<
  Req = unknown,
  Res = unknown,
  Cases extends Record<string, GrpcContractCase<Req, Res, any>> = Record<string, GrpcContractCase<Req, Res>>,
> {
  /** Wire-format target: "ServiceName/MethodName". */
  target: string;

  /** Default gRPC client for all cases. */
  client?: GrpcClient;

  description?: string;
  feature?: string;

  /** Contract-level request schema (OpenAPI-style docs + possible runtime validation). */
  requestSchema?: SchemaLike<Req>;

  /** Contract-level default request (merged under each case's request). */
  defaultRequest?: Partial<Req>;

  /** Contract-level default metadata (merged under each case's metadata). */
  defaultMetadata?: Record<string, string>;

  /** Contract-level default deadline (ms). */
  deadlineMs?: number;

  tags?: string[];
  deprecated?: string;
  extensions?: Extensions;

  /** Named spec cases. */
  cases: Cases;
}

// =============================================================================
// Adapter payload schemas (for ContractProtocolAdapter generics)
// =============================================================================

/**
 * Runtime (live) payload shape for the gRPC adapter. Contains SchemaLike
 * references. Converted to GrpcSafeSchemas by adapter.normalize.
 */
export interface GrpcPayloadSchemas {
  request?: SchemaLike<unknown>;
  response?: SchemaLike<unknown>;
  metadata?: SchemaLike<Record<string, string>>;
  /** Request examples (for docs / projection). */
  requestExample?: unknown;
  requestExamples?: Record<string, GrpcContractExample<unknown>>;
}

/**
 * JSON-safe payload shape. Produced by adapter.normalize.
 * SchemaLike references are converted to JSON Schema fragments.
 */
export interface GrpcSafeSchemas {
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  requestExample?: unknown;
  requestExamples?: Record<string, GrpcContractExample<unknown>>;
}

// =============================================================================
// Contract meta
// =============================================================================

/**
 * Runtime contract-level meta. Carried on the projection so scanner / MCP /
 * Cloud can surface structural info without needing the live spec.
 *
 * Note: `.proto` file path is intentionally NOT stored here (execution log
 * OQ-2 decision 2026-04-20). The proto path is a runtime transport concern
 * owned by `configure({grpc: grpc({proto: ...})})`, not by the contract.
 * Contract is protocol-idea-level, transport config is deployment-level.
 */
export interface GrpcContractMeta {
  /** Raw target "Service/Method". */
  target: string;
  /** Parsed service name ("PaymentService"). */
  service: string;
  /** Parsed method name ("Complete"). */
  method: string;
  /** Contract-level default metadata (for projection display). */
  defaultMetadata?: Record<string, string>;
  /** Contract-level deadline (for projection display). */
  deadlineMs?: number;
  /** Contract instance name (contract.grpc.with("name")). */
  instanceName?: string;
}

/**
 * JSON-safe meta. Same as runtime meta (no live references).
 */
export type GrpcContractSafeMeta = GrpcContractMeta;

// =============================================================================
// Flow output shape
// =============================================================================

/**
 * What `executeCaseInFlow` returns, and what flow `step.out(state, res)`
 * receives in its `res` parameter. Mirrors `GrpcCaseResult` — kept as a
 * distinct export to make the flow-output contract explicit (parallel to
 * HTTP's `HttpFlowCaseOutput` convention).
 */
export type GrpcFlowCaseOutput<Res = unknown> = GrpcCaseResult<Res>;

// =============================================================================
// Contract instance / root types
// =============================================================================

/**
 * Signature of `contract.grpc.with("name", defaults)`. Returns a contract
 * factory that creates contracts under this instance's defaults.
 *
 * Actual implementation in `./factory.ts` (CG-4).
 */
export type GrpcContractRoot = {
  with: (
    instanceName: string,
    defaults?: GrpcContractDefaults,
  ) => GrpcContractFactory;
};

export type GrpcContractFactory = <
  Req,
  Res,
  Cases extends Record<string, GrpcContractCase<Req, Res, any>>,
>(
  id: string,
  spec: GrpcContractSpec<Req, Res, Cases>,
) => ProtocolContract<
  GrpcContractSpec<Req, Res, Cases>,
  GrpcPayloadSchemas,
  GrpcContractMeta,
  Cases
>;

declare module "@glubean/sdk" {
  interface ContractProtocolRoots {
    grpc: GrpcContractRoot;
  }
}

// =============================================================================
// Type inference helpers (CG-2 skeleton; expanded in CG-3 as adapter lands)
// =============================================================================

/**
 * Infer request type from a GrpcContractCase. Placeholder for future
 * ergonomic inference helpers parallel to HTTP's InferHttpInputs.
 *
 * Third generic slot is now `Needs` (was v9's `S` setup-state). Using
 * `any` in the don't-care slot per Spike 0 Finding 2 (contravariant
 * positions need `any`, not `unknown`, to keep inference stable).
 */
export type InferGrpcRequest<C> = C extends GrpcContractCase<infer Req, any, any> ? Req : never;

/**
 * Infer response type from a GrpcContractCase.
 */
export type InferGrpcResponse<C> = C extends GrpcContractCase<any, infer Res, any> ? Res : never;
