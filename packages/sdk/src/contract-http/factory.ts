/**
 * contract.http factory — scoped-defaults pattern.
 *
 * Root `contract.http` exposes only `.with(name, defaults)`. Calling
 * `contract.http("id", spec)` directly is forbidden because client injection
 * via scoped instances is the canonical authoring pattern.
 *
 * The factory wraps the generic dispatcher attached to `contract.http` by
 * `contract.register("http", httpAdapter)`. Calls flow through:
 *   user code
 *     → scoped factory(id, spec)
 *     → merge instance defaults into spec
 *     → dispatcher(id, mergedSpec)   [generic register() output]
 *     → adapter.project + per-case registerTest + Test[] with _projection/_spec
 */

import type { Extensions } from "../contract-types.js";
import type { ProtocolContract } from "../contract-types.js";
import type {
  ContractCase,
  HttpContractDefaults,
  HttpContractFactory,
  HttpContractRoot,
  HttpContractMeta,
  HttpContractSpec,
  HttpPayloadSchemas,
  HttpSecurityScheme,
} from "./types.js";

type InternalDefaults = HttpContractDefaults & { _name?: string };

type HttpDispatch = <Cases extends Record<string, ContractCase<any, any>>>(
  id: string,
  spec: HttpContractSpec<Cases>,
) => ProtocolContract<HttpContractSpec, HttpPayloadSchemas, HttpContractMeta>;

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

function mergeHttpDefaults(
  defaults: InternalDefaults | undefined,
  spec: HttpContractSpec,
): HttpContractSpec {
  if (!defaults) return spec;
  const mergedTags = [...(defaults.tags ?? []), ...(spec.tags ?? [])];
  const mergedExtensions = mergeExtensions(defaults.extensions, spec.extensions);
  return {
    ...spec,
    client: spec.client ?? defaults.client,
    feature: spec.feature ?? defaults.feature,
    tags: mergedTags.length > 0 ? mergedTags : undefined,
    extensions: mergedExtensions,
  };
}

/**
 * Build a scoped HTTP factory. `dispatch` is `contract.http` attached by
 * the core's register() call — we wrap it to inject instance defaults.
 */
export function createHttpFactory(
  dispatch: HttpDispatch,
  defaults?: InternalDefaults,
): HttpContractFactory {
  const factory = <Cases extends Record<string, ContractCase<any, any>>>(
    id: string,
    spec: HttpContractSpec<Cases>,
  ): ProtocolContract<HttpContractSpec, HttpPayloadSchemas, HttpContractMeta> => {
    if (!defaults?._name) {
      throw new Error(
        `contract.http("${id}", spec) is not supported. ` +
          `Use contract.http.with("name", { client }) first to create a scoped instance, ` +
          `then call instance("${id}", spec).`,
      );
    }
    const merged = mergeHttpDefaults(defaults, spec as HttpContractSpec);
    const result = dispatch(id, merged as HttpContractSpec<Cases>);
    // Attach instanceName + security after dispatch so they appear in projection
    applyInstanceMetadata(result, defaults._name, defaults.security);
    return result;
  };

  factory.with = (name: string, more: HttpContractDefaults): HttpContractFactory => {
    const mergedTags = [...(defaults?.tags ?? []), ...(more.tags ?? [])];
    const mergedExtensions = mergeExtensions(defaults?.extensions, more.extensions);
    return createHttpFactory(dispatch, {
      ...defaults,
      ...more,
      tags: mergedTags.length > 0 ? mergedTags : undefined,
      extensions: mergedExtensions,
      _name: name,
    });
  };

  return factory as HttpContractFactory;
}

/**
 * Root factory — `.with()` only, direct call throws.
 */
export function createHttpRoot(dispatch: HttpDispatch): HttpContractRoot {
  return createHttpFactory(dispatch) as unknown as HttpContractRoot;
}

function applyInstanceMetadata(
  contract: ProtocolContract<HttpContractSpec, HttpPayloadSchemas, HttpContractMeta>,
  instanceName: string,
  security: HttpSecurityScheme | undefined,
): void {
  // Mutate _projection to attach instanceName / security (not otherwise
  // available to adapter.project since it doesn't know the factory defaults)
  const proj = contract._projection as
    & typeof contract._projection
    & { instanceName?: string; schemas?: HttpPayloadSchemas };
  proj.instanceName = instanceName;
  if (security != null && proj.schemas) {
    proj.schemas.security = security;
  }
}
