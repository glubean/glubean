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
 * Side-effect registration wires `contract.register("grpc", grpcAdapter)`
 * on import. See CG-4.
 */

// Placeholder re-exports. Filled in CG-2/3/4.

export {};
