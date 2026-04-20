/**
 * GraphQL contract surface for @glubean/graphql 0.2.0.
 *
 * This module makes `@glubean/graphql` a single-package owner of both:
 *   - Transport / client layer (existing `../index.ts`)
 *   - Contract adapter layer (this directory)
 *
 * Mirrors the same single-package design as `@glubean/grpc` 0.2.0.
 * See `internal/00-product/positioning-v3.md` §12.0 resolved and
 * `internal/40-discovery/proposals/contract-grpc-graphql-expansion.md` §6.1.
 *
 * Side-effect on import:
 *   1. `contract.register("graphql", graphqlAdapter)` — registers dispatcher
 *   2. Wrap dispatcher with `createGraphqlRoot` so
 *      `contract.graphql.with(name, defaults)` UX works
 *
 * Both steps land in CG-12 (factory + registration). This file is
 * currently a scaffold — CG-9 placeholder.
 */

// TODO(CG-12): register adapter + wrap factory here.

export {};
