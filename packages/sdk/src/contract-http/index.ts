/**
 * Built-in HTTP adapter for the Glubean contract system.
 *
 * Shipped with @glubean/sdk — zero-config for the common HTTP case.
 * Registered as an adapter (via `contract.register("http", httpAdapter)`)
 * in `../index.ts` at SDK load time.
 *
 * Future plugin protocols (gRPC / GraphQL / Kafka / ...) will ship as
 * separate npm packages (`@glubean/contract-grpc` etc.) that do
 * `contract.register("grpc", grpcAdapter)` on import.
 */

export { httpAdapter } from "./adapter.js";
export { createHttpFactory, createHttpRoot } from "./factory.js";

export type {
  // User-facing authoring types
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
