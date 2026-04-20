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
