/**
 * GraphQL contract surface for @glubean/graphql.
 *
 * This module previously registered `contract.graphql` + GraphQL matchers as
 * side effects at import time. In the plugin-manifest era that responsibility
 * moved to the default export of `@glubean/graphql/src/index.ts`, which
 * projects install explicitly via `installPlugin(...)` / `bootstrap()`.
 *
 * This file is now **side-effect-free** — it only re-exports the adapter,
 * factory, types, and the matcher collection so the manifest in
 * `../index.ts` can reference them.
 *
 * If you need the legacy "import this and matchers appear" behavior for a
 * one-off script, call `registerGraphqlMatchers()` directly. The standard
 * path for tests is the manifest.
 */

export { graphqlAdapter } from "./adapter.js";
export { createGraphqlFactory, createGraphqlRoot } from "./factory.js";
export { graphqlMatchers, registerGraphqlMatchers } from "./matchers.js";
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
