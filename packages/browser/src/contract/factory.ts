/**
 * contract.browser factory — scoped-defaults pattern.
 *
 * Root `contract.browser` exposes only `.with(name, defaults)`. Calling
 * `contract.browser("id", spec)` directly is forbidden — client injection via
 * scoped instances is the canonical authoring pattern (same as HTTP / GraphQL
 * / gRPC).
 *
 * The factory wraps the generic dispatcher attached to `contract.browser` by
 * `contract.register("browser", browserAdapter)`. Calls flow through:
 *   user code
 *     → scoped factory(id, spec)
 *     → merge instance defaults into spec
 *     → dispatcher(id, mergedSpec)   [generic register() output]
 *     → adapter.project + per-case registerTest + Test[] with _projection/_spec
 */

import type { Extensions, ProtocolContract } from "@glubean/sdk";
import type {
  BrowserContractCase,
  BrowserContractDefaults,
  BrowserContractFactory,
  BrowserContractMeta,
  BrowserContractRoot,
  BrowserContractSpec,
  BrowserSafeSchemas,
} from "./types.js";

type InternalDefaults = BrowserContractDefaults & { _name?: string };

type BrowserDispatch = <
  Input,
  Cases extends Record<string, BrowserContractCase<Input>>,
>(
  id: string,
  spec: BrowserContractSpec<Input, Cases>,
) => ProtocolContract<
  BrowserContractSpec<Input, Cases>,
  BrowserSafeSchemas,
  BrowserContractMeta,
  Cases
>;

function mergeExtensions(
  base: Extensions | undefined,
  override: Extensions | undefined,
): Extensions | undefined {
  if (!base && !override) return undefined;
  const merged: Record<string, unknown> = { ...(base ?? {}), ...(override ?? {}) };
  return Object.keys(merged).length > 0 ? (merged as Extensions) : undefined;
}

function mergeNotes(
  base: string[] | undefined,
  override: string[] | undefined,
): string[] | undefined {
  const all = [...(base ?? []), ...(override ?? [])];
  return all.length > 0 ? all : undefined;
}

function mergeBrowserDefaults(
  defaults: InternalDefaults | undefined,
  spec: BrowserContractSpec,
): BrowserContractSpec {
  if (!defaults) return spec;
  const mergedTags = [...(defaults.tags ?? []), ...(spec.tags ?? [])];
  const baseMerged: BrowserContractSpec = {
    ...spec,
    client: spec.client ?? defaults.client,
    entry: spec.entry ?? defaults.entry,
    baseUrl: spec.baseUrl ?? defaults.baseUrl,
    feature: spec.feature ?? defaults.feature,
    agentNotes: mergeNotes(defaults.agentNotes, spec.agentNotes),
    tags: mergedTags.length > 0 ? mergedTags : undefined,
    extensions: mergeExtensions(defaults.extensions, spec.extensions),
  };
  // Embed the factory's instanceName via a private `_factory` channel;
  // `projectBrowser` reads it at projection time (no post-dispatch mutation).
  if (defaults._name) {
    (baseMerged as unknown as { _factory: { instanceName: string } })._factory = {
      instanceName: defaults._name,
    };
  }
  return baseMerged;
}

/**
 * Build a scoped browser factory. `dispatch` is `contract.browser` attached by
 * the core's register() call — we wrap it to inject instance defaults.
 */
export function createBrowserFactory(
  dispatch: BrowserDispatch,
  defaults?: InternalDefaults,
): BrowserContractFactory {
  const factory = <
    Input,
    Cases extends Record<string, BrowserContractCase<Input>>,
  >(
    id: string,
    spec: BrowserContractSpec<Input, Cases>,
  ): ProtocolContract<
    BrowserContractSpec<Input, Cases>,
    BrowserSafeSchemas,
    BrowserContractMeta,
    Cases
  > => {
    if (!defaults?._name) {
      throw new Error(
        `contract.browser("${id}", spec) is not supported. ` +
          `Use contract.browser.with("name", { client }) first to create a scoped instance, ` +
          `then call instance("${id}", spec).`,
      );
    }
    const merged = mergeBrowserDefaults(defaults, spec as unknown as BrowserContractSpec);
    return dispatch(id, merged as unknown as BrowserContractSpec<Input, Cases>);
  };

  (factory as unknown as { with: BrowserContractRoot["with"] }).with = (
    name: string,
    more: BrowserContractDefaults = {},
  ): BrowserContractFactory => {
    const mergedTags = [...(defaults?.tags ?? []), ...(more.tags ?? [])];
    return createBrowserFactory(dispatch, {
      ...defaults,
      ...more,
      tags: mergedTags.length > 0 ? mergedTags : undefined,
      agentNotes: mergeNotes(defaults?.agentNotes, more.agentNotes),
      extensions: mergeExtensions(defaults?.extensions, more.extensions),
      _name: name,
    });
  };

  return factory as BrowserContractFactory;
}

/**
 * Root factory — `.with()` only, direct call throws.
 */
export function createBrowserRoot(dispatch: BrowserDispatch): BrowserContractRoot {
  return createBrowserFactory(dispatch) as unknown as BrowserContractRoot;
}
