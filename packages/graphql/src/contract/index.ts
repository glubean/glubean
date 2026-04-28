/**
 * GraphQL contract surface for @glubean/graphql.
 *
 * This module is **side-effect-free** — it only re-exports the adapter,
 * factory, types, and the matcher collection so the manifest in
 * `../index.ts` can reference them.
 *
 * Projects install the manifest via `installPlugin(graphqlPlugin)` (typically
 * driven by `bootstrap()` loading `glubean.setup.ts`). There is no more
 * "import the package and matchers auto-appear" path.
 */

export { graphqlAdapter } from "./adapter.js";
export { createGraphqlFactory, createGraphqlRoot } from "./factory.js";
export { graphqlMatchers } from "./matchers.js";
export { defineGraphqlCase } from "./types.js";
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
