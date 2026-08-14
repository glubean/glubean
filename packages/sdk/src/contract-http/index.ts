/**
 * Built-in HTTP adapter for the Glubean contract system.
 *
 * Shipped with @glubean/sdk — zero-config for the common HTTP case.
 * Registered as an adapter (via `contract.register("http", httpAdapter)`)
 * in `../index.ts` at SDK load time.
 *
 * Other protocols use the single-package model — each protocol package
 * (`@glubean/grpc`, `@glubean/graphql`, ...) owns both its transport/test
 * plugin layer and its contract adapter. Side-effect registration on
 * `import "@glubean/grpc"` wires `contract.register("grpc", grpcAdapter)`.
 */

export { httpAdapter } from "./adapter.js";
export { createLocalInbox } from "./inbound.js";
export type { InboundDelivery, LocalInbox, ReceiverHandle } from "./inbound.js";
export { inboundCase, isInboundCase } from "./types.js";
export {
  getSignatureVerifier,
  registerSignatureVerifier,
  STRIPE_V1_DEFAULT_TOLERANCE_MS,
} from "./inbound-verify.js";
export type {
  SignatureVerifier,
  SignatureVerifyInput,
  SignatureVerifyResult,
} from "./inbound-verify.js";
export { createHttpFactory, createHttpRoot } from "./factory.js";
export { defineHttpCase, httpCase } from "./types.js";

export type {
  // User-facing authoring types
  HttpCaseBody,
  HttpContractSpec,
  HttpContractDefaults,
  HttpSecurityScheme,
  HttpContractRoot,
  HttpContractFactory,
  ContractCase,
  ContractExpect,
  ContractExample,
  NormalizedHeaders,
  ParamValue,
  RequestSpec,
  // Adapter-level payload types
  HttpPayloadSchemas,
  HttpSafeSchemas,
  HttpContractMeta,
  HttpParamSchema,
  HttpParamMeta,
  HttpFlowCaseOutput,
  InferHttpInputs,
  InferHttpOutput,
} from "./types.js";
