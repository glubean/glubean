/**
 * GraphQL contract types.
 *
 * Placeholder for CG-11 (types design — selection-set + explicit schema).
 * Filled in next working step.
 *
 * Key design constraint: GraphQL SDL is a closed type system
 * (a type declares ALL its fields), but contract cases are open selection
 * (each case's query picks a subset). Contract resolves this by requiring
 * explicit type declarations at spec level while cases carry their
 * query + variables. See proposal §3.2 and §6.3.
 *
 * Expected exports:
 *   - GraphqlContractSpec<Vars, Res, Types>
 *   - GraphqlContractCase<Vars, Res, S>
 *   - GraphqlContractExpect<Res>
 *   - GraphqlContractDefaults
 *   - GraphqlPayloadSchemas / GraphqlSafeSchemas
 *   - GraphqlContractMeta / GraphqlContractSafeMeta
 *   - GraphqlCaseResult<Res>
 *   - GraphqlFlowCaseOutput<Res>
 *   - GraphqlContractRoot / GraphqlContractFactory
 */

// TODO(CG-11): design and implement types here.

export {};
