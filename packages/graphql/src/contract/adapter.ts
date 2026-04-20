/**
 * GraphQL contract adapter.
 *
 * Placeholder for CG-12 (adapter implementation). Filled in next working
 * step.
 *
 * Responsibility: implement
 * `ContractProtocolAdapter<GraphqlContractSpec, ...>` with:
 *   - execute: POST to endpoint with { query, variables }, parse envelope
 *     (data + errors), 3-layer classifyFailure (transport / payload errors
 *     / data shape), run verify/expect
 *   - project: ContractProjection with per-case queries + variables
 *   - normalize: JSON-safe projection
 *   - classifyFailure: 3-layer (transport HTTP status / payload errors
 *     array / data shape mismatch)
 *   - renderTarget: operationName + root field (display-only, NOT identity)
 *   - toMarkdown: case list with query snippets
 *   - executeCaseInFlow: flow-step execution with deep-merge variables
 *     + partial data semantics
 *   - validateCaseForFlow: reject function-valued fields in flow mode
 *
 * Depends on:
 *   - CG-10 transport envelope extension (GraphQLResult<T> with httpStatus,
 *     headers, rawBody) in ../index.ts
 *   - CG-11 types (../contract/types.ts)
 *
 * Reference: `packages/grpc/src/contract/adapter.ts` (already shipped) +
 * `packages/sdk/src/contract-http/adapter.ts`.
 */

// TODO(CG-12): adapter implementation.

export {};
