/**
 * gRPC contract surface for @glubean/grpc 0.2.0.
 *
 * This module makes `@glubean/grpc` a single-package owner of both:
 *   - Transport / test-plugin layer (existing `../index.ts`, unchanged)
 *   - Contract adapter layer (this directory)
 *
 * Design rationale: "contract is a first-class citizen, not an afterthought
 * to the transport plugin." See
 * `internal/00-product/positioning-v3.md` §12.0 resolved
 * and `internal/40-discovery/proposals/contract-grpc-graphql-expansion.md` §5.1.
 *
 * Side-effect on import:
 *   1. Register grpcAdapter so `contract.register("grpc", grpcAdapter)` wires
 *      the dispatcher (contract.grpc becomes the generic dispatcher).
 *   2. Wrap dispatcher with createGrpcRoot so `contract.grpc.with(name, ...)`
 *      is available (parallel to HTTP's bootstrap in packages/sdk/src/index.ts
 *      lines 1618-1624).
 *
 * After this module loads, users can:
 *
 *   import "@glubean/grpc"; // side-effect: registers grpc contract adapter
 *   import { contract } from "@glubean/sdk";
 *
 *   const paymentContracts = contract.grpc.with("payment", { client });
 *   export const completePayment = paymentContracts("complete-payment", {
 *     target: "PaymentService/Complete",
 *     cases: { ok: { description: "...", expect: { statusCode: 0 } } },
 *   });
 */

import { contract } from "@glubean/sdk";
import { grpcAdapter } from "./adapter.js";
import { createGrpcRoot } from "./factory.js";
import { registerGrpcMatchers } from "./matchers.js";
import type { GrpcContractRoot } from "./types.js";

// Step 1: register the adapter. After this, `contract.grpc` exists as the
// generic dispatcher attached by `contract.register()`.
contract.register("grpc", grpcAdapter);

// Step 2: wrap dispatcher with the scoped-defaults factory so
// `contract.grpc.with(name, defaults)` UX works.
{
  const dispatcher = (contract as any).grpc as Parameters<typeof createGrpcRoot>[0];
  (contract as unknown as { grpc: GrpcContractRoot }).grpc = createGrpcRoot(dispatcher);
}

// Step 3: register gRPC custom matchers so
// `ctx.expect(res).toHaveGrpcStatus(0)` works out of the box.
registerGrpcMatchers();

// Re-exports for type consumers who import from the package directly.
export { grpcAdapter } from "./adapter.js";
export { createGrpcFactory, createGrpcRoot } from "./factory.js";
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
