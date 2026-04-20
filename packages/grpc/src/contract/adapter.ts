/**
 * gRPC contract adapter.
 *
 * Placeholder for CG-3 (adapter implementation). Filled in next working step.
 *
 * Responsibility: implement
 * `ContractProtocolAdapter<GrpcContractSpec, ...>` with:
 *   - execute: wrap `@glubean/grpc` unary client call + run expect/verify
 *   - project: generate ContractProjection
 *   - normalize: JSON-safe projection
 *   - classifyFailure: gRPC status 0-16 → FailureKind
 *   - renderTarget: "Service/Method" → "Service.Method" (display only)
 *   - toMarkdown: case list
 *   - executeCaseInFlow: flow-step execution with deep-merge + Rule 1 teardown
 *
 * Reference: `packages/sdk/src/contract-http/adapter.ts`.
 */

// TODO(CG-3): adapter implementation.

export {};
