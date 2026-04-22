/**
 * contract.graphql factory — scoped-defaults pattern.
 *
 * Root `contract.graphql` exposes only `.with(name, defaults)`. Calling
 * `contract.graphql("id", spec)` directly is forbidden — client injection
 * via scoped instances is the canonical authoring pattern (same as HTTP
 * and gRPC).
 *
 * The factory wraps the generic dispatcher attached to `contract.graphql`
 * by `contract.register("graphql", graphqlAdapter)`. Calls flow through:
 *   user code
 *     → scoped factory(id, spec)
 *     → merge instance defaults into spec
 *     → dispatcher(id, mergedSpec)   [generic register() output]
 *     → adapter.project + per-case registerTest + Test[] with
 *       _projection/_spec
 */

import type { Extensions, ProtocolContract } from "@glubean/sdk";
import type {
  GraphqlContractCase,
  GraphqlContractDefaults,
  GraphqlContractFactory,
  GraphqlContractMeta,
  GraphqlContractRoot,
  GraphqlContractSpec,
  GraphqlPayloadSchemas,
} from "./types.js";

type InternalDefaults = GraphqlContractDefaults & { _name?: string };

type GraphqlDispatch = <
  Vars extends Record<string, unknown>,
  Res,
  Cases extends Record<string, GraphqlContractCase<Vars, Res, any>>,
>(
  id: string,
  spec: GraphqlContractSpec<Vars, Res, Cases>,
) => ProtocolContract<GraphqlContractSpec, GraphqlPayloadSchemas, GraphqlContractMeta>;

function mergeExtensions(
  base: Extensions | undefined,
  override: Extensions | undefined,
): Extensions | undefined {
  if (!base && !override) return undefined;
  const merged: Record<string, unknown> = {
    ...(base ?? {}),
    ...(override ?? {}),
  };
  return Object.keys(merged).length > 0 ? (merged as Extensions) : undefined;
}

function mergeGraphqlDefaults(
  defaults: InternalDefaults | undefined,
  spec: GraphqlContractSpec,
): GraphqlContractSpec {
  if (!defaults) return spec;
  const mergedTags = [...(defaults.tags ?? []), ...(spec.tags ?? [])];
  const mergedExtensions = mergeExtensions(defaults.extensions, spec.extensions);
  const mergedHeaders = {
    ...(defaults.headers ?? {}),
    ...(spec.defaultHeaders ?? {}),
  };
  // Embed the factory's instanceName into the spec via a private `_factory`
  // channel. `projectGraphql` reads this at projection time so the produced
  // `_projection` (and `_extracted`) already carries it — no post-dispatch
  // mutation needed.
  const baseMerged = {
    ...spec,
    client: spec.client ?? defaults.client,
    endpoint: spec.endpoint ?? defaults.endpoint,
    feature: spec.feature ?? defaults.feature,
    tags: mergedTags.length > 0 ? mergedTags : undefined,
    extensions: mergedExtensions,
    defaultHeaders:
      Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
  };
  if (defaults._name) {
    (baseMerged as unknown as { _factory: { instanceName: string } })._factory = {
      instanceName: defaults._name,
    };
  }
  return baseMerged;
}

/**
 * Build a scoped GraphQL factory. `dispatch` is `contract.graphql` attached
 * by the core's register() call — we wrap it to inject instance defaults.
 */
export function createGraphqlFactory(
  dispatch: GraphqlDispatch,
  defaults?: InternalDefaults,
): GraphqlContractFactory {
  const factory = <
    Vars extends Record<string, unknown>,
    Res,
    Cases extends Record<string, GraphqlContractCase<Vars, Res, any>>,
  >(
    id: string,
    spec: GraphqlContractSpec<Vars, Res, Cases>,
  ): ProtocolContract<GraphqlContractSpec, GraphqlPayloadSchemas, GraphqlContractMeta> => {
    if (!defaults?._name) {
      throw new Error(
        `contract.graphql("${id}", spec) is not supported. ` +
          `Use contract.graphql.with("name", { client }) first to create a scoped instance, ` +
          `then call instance("${id}", spec).`,
      );
    }
    const merged = mergeGraphqlDefaults(defaults, spec as GraphqlContractSpec);
    return dispatch(id, merged as GraphqlContractSpec<Vars, Res, Cases>);
  };

  (factory as any).with = (
    name: string,
    more: GraphqlContractDefaults = {},
  ): GraphqlContractFactory => {
    const mergedTags = [...(defaults?.tags ?? []), ...(more.tags ?? [])];
    const mergedExtensions = mergeExtensions(defaults?.extensions, more.extensions);
    const mergedHeaders = {
      ...(defaults?.headers ?? {}),
      ...(more.headers ?? {}),
    };
    return createGraphqlFactory(dispatch, {
      ...defaults,
      ...more,
      tags: mergedTags.length > 0 ? mergedTags : undefined,
      extensions: mergedExtensions,
      headers:
        Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
      _name: name,
    });
  };

  return factory as GraphqlContractFactory;
}

/**
 * Root factory — `.with()` only, direct call throws.
 */
export function createGraphqlRoot(dispatch: GraphqlDispatch): GraphqlContractRoot {
  return createGraphqlFactory(dispatch) as unknown as GraphqlContractRoot;
}
