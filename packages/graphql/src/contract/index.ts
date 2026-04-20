/**
 * GraphQL contract surface for @glubean/graphql 0.2.0.
 *
 * This module makes `@glubean/graphql` a single-package owner of both:
 *   - Transport / client layer (existing `../index.ts`, unchanged)
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
 * After this module loads, users can:
 *
 *   import "@glubean/graphql"; // side-effect: registers graphql contract adapter
 *   import { contract } from "@glubean/sdk";
 *
 *   const api = contract.graphql.with("api", { client });
 *   export const getUser = api("get-user", {
 *     cases: {
 *       ok: {
 *         description: "success",
 *         query: `query GetUser($id: ID!) { user(id: $id) { name } }`,
 *         variables: { id: "1" },
 *         expect: { data: { user: { name: "Alice" } } },
 *       },
 *     },
 *   });
 */

import { contract } from "@glubean/sdk";
import { graphqlAdapter } from "./adapter.js";
import { createGraphqlRoot } from "./factory.js";
import type { GraphqlContractRoot } from "./types.js";

// Step 1: register the adapter. After this, `contract.graphql` exists as the
// generic dispatcher attached by `contract.register()`.
contract.register("graphql", graphqlAdapter);

// Step 2: wrap dispatcher with the scoped-defaults factory so
// `contract.graphql.with(name, defaults)` UX works.
{
  const dispatcher = (contract as any).graphql as Parameters<typeof createGraphqlRoot>[0];
  (contract as unknown as { graphql: GraphqlContractRoot }).graphql = createGraphqlRoot(dispatcher);
}

// Re-exports for type consumers who import from the package directly.
export { graphqlAdapter } from "./adapter.js";
export { createGraphqlFactory, createGraphqlRoot } from "./factory.js";
export type {
  GraphqlContractCase,
  GraphqlContractDefaults,
  GraphqlContractExample,
  GraphqlContractExpect,
  GraphqlContractFactory,
  GraphqlContractMeta,
  GraphqlContractRoot,
  GraphqlContractSafeMeta,
  GraphqlContractSpec,
  GraphqlCaseResult,
  GraphqlErrorsExpect,
  GraphqlFlowCaseOutput,
  GraphqlPayloadSchemas,
  GraphqlSafeSchemas,
  GraphqlTypeDef,
  GraphqlTypeDefs,
  InferGraphqlVariables,
  InferGraphqlResponse,
} from "./types.js";
