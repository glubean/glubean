/**
 * gRPC contract surface for @glubean/grpc.
 *
 * This module used to register `contract.grpc` + gRPC matchers as side effects
 * at import time. In the plugin-manifest era that responsibility moved to the
 * default export of `@glubean/grpc/src/index.ts`, which projects install
 * explicitly via `installPlugin(...)` / `bootstrap()`.
 *
 * This file is now **side-effect-free** — it only re-exports the adapter,
 * factory, types, and matcher collection so the manifest in `../index.ts`
 * can reference them.
 */

export { grpcAdapter } from "./adapter.js";
export { createGrpcFactory, createGrpcRoot } from "./factory.js";
export { grpcMatchers } from "./matchers.js";
export { defineGrpcCase } from "./types.js";
export type {
  GrpcContractCase,
  GrpcContractDefaults,
  GrpcContractExample,
  GrpcContractExpect,
  GrpcContractFactory,
  GrpcContractMeta,
  GrpcContractRoot,
  GrpcContractSafeMeta,
  GrpcContractSpec,
  GrpcCaseResult,
  GrpcFlowCaseOutput,
  GrpcPayloadSchemas,
  GrpcSafeSchemas,
  InferGrpcRequest,
  InferGrpcResponse,
} from "./types.js";
