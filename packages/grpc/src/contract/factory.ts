/**
 * contract.grpc factory — scoped-defaults pattern.
 *
 * Root `contract.grpc` exposes only `.with(name, defaults)`. Calling
 * `contract.grpc("id", spec)` directly is forbidden — client injection via
 * scoped instances is the canonical authoring pattern (same as HTTP).
 *
 * The factory wraps the generic dispatcher attached to `contract.grpc` by
 * `contract.register("grpc", grpcAdapter)`. Calls flow through:
 *   user code
 *     → scoped factory(id, spec)
 *     → merge instance defaults into spec
 *     → dispatcher(id, mergedSpec)   [generic register() output]
 *     → adapter.project + per-case registerTest + Test[] with _projection/_spec
 */

import type { Extensions, ProtocolContract } from "@glubean/sdk";
import type {
  GrpcContractCase,
  GrpcContractDefaults,
  GrpcContractFactory,
  GrpcContractMeta,
  GrpcContractRoot,
  GrpcContractSpec,
  GrpcPayloadSchemas,
} from "./types.js";

type InternalDefaults = GrpcContractDefaults & { _name?: string };

type GrpcDispatch = <
  Req,
  Res,
  Cases extends Record<string, GrpcContractCase<Req, Res, any>>,
>(
  id: string,
  spec: GrpcContractSpec<Req, Res, Cases>,
) => ProtocolContract<
  GrpcContractSpec<Req, Res, Cases>,
  GrpcPayloadSchemas,
  GrpcContractMeta,
  Cases
>;

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

function mergeGrpcDefaults(
  defaults: InternalDefaults | undefined,
  spec: GrpcContractSpec,
): GrpcContractSpec {
  if (!defaults) return spec;
  const mergedTags = [...(defaults.tags ?? []), ...(spec.tags ?? [])];
  const mergedExtensions = mergeExtensions(defaults.extensions, spec.extensions);
  const mergedMetadata = {
    ...(defaults.metadata ?? {}),
    ...(spec.defaultMetadata ?? {}),
  };
  // Embed the factory's instanceName into the spec via a private `_factory`
  // channel. `projectGrpc` reads this at projection time so the produced
  // `_projection` (and `_extracted`) already carries it — no post-dispatch
  // mutation needed.
  const baseMerged = {
    ...spec,
    client: spec.client ?? defaults.client,
    feature: spec.feature ?? defaults.feature,
    tags: mergedTags.length > 0 ? mergedTags : undefined,
    extensions: mergedExtensions,
    defaultMetadata:
      Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
    deadlineMs: spec.deadlineMs ?? defaults.deadlineMs,
  };
  if (defaults._name) {
    (baseMerged as unknown as { _factory: { instanceName: string } })._factory = {
      instanceName: defaults._name,
    };
  }
  return baseMerged;
}

/**
 * Build a scoped gRPC factory. `dispatch` is `contract.grpc` attached by the
 * core's register() call — we wrap it to inject instance defaults.
 */
export function createGrpcFactory(
  dispatch: GrpcDispatch,
  defaults?: InternalDefaults,
): GrpcContractFactory {
  const factory = <
    Req,
    Res,
    Cases extends Record<string, GrpcContractCase<Req, Res, any>>,
  >(
    id: string,
    spec: GrpcContractSpec<Req, Res, Cases>,
  ): ProtocolContract<
    GrpcContractSpec<Req, Res, Cases>,
    GrpcPayloadSchemas,
    GrpcContractMeta,
    Cases
  > => {
    if (!defaults?._name) {
      throw new Error(
        `contract.grpc("${id}", spec) is not supported. ` +
          `Use contract.grpc.with("name", { client }) first to create a scoped instance, ` +
          `then call instance("${id}", spec).`,
      );
    }
    const merged = mergeGrpcDefaults(defaults, spec as GrpcContractSpec);
    return dispatch(id, merged as GrpcContractSpec<Req, Res, Cases>);
  };

  (factory as any).with = (
    name: string,
    more: GrpcContractDefaults = {},
  ): GrpcContractFactory => {
    const mergedTags = [...(defaults?.tags ?? []), ...(more.tags ?? [])];
    const mergedExtensions = mergeExtensions(defaults?.extensions, more.extensions);
    const mergedMetadata = {
      ...(defaults?.metadata ?? {}),
      ...(more.metadata ?? {}),
    };
    return createGrpcFactory(dispatch, {
      ...defaults,
      ...more,
      tags: mergedTags.length > 0 ? mergedTags : undefined,
      extensions: mergedExtensions,
      metadata:
        Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
      _name: name,
    });
  };

  return factory as GrpcContractFactory;
}

/**
 * Root factory — `.with()` only, direct call throws.
 */
export function createGrpcRoot(dispatch: GrpcDispatch): GrpcContractRoot {
  return createGrpcFactory(dispatch) as unknown as GrpcContractRoot;
}
