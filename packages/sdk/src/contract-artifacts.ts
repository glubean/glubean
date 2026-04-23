/**
 * @module contract-artifacts
 *
 * Contract artifact registry — declarative extension point for
 * "contracts → X" rendering (markdown / openapi / future proto / sdl /
 * asyncapi / ...).
 *
 * Replaces the v0.1 per-adapter `toMarkdown?` / `toOpenApi?` hooks which
 * (a) polluted the generic `ContractProtocolAdapter` interface with
 * protocol-specific artifacts (OpenAPI is HTTP-only), (b) had dead
 * declarations that nothing called, and (c) gave consumers no way to
 * enumerate "which artifact kinds does this project support".
 *
 * See `internal/40-discovery/proposals/contract-artifact-registry.md` (v6).
 *
 * ## Concepts
 *
 * **ArtifactKind**: first-class description of an output format (name +
 * merge strategy + empty skeleton + optional defaultRender). Per-contract
 * Part and final merged Final are independently typed (markdown renders
 * structured parts that the merge assembles into a document; openapi
 * renders per-contract partial documents that the merge stitches together).
 *
 * **ContractProtocolAdapter.artifacts**: each adapter declares which
 * kinds it produces. Mapping from kind name to per-contract renderer.
 *
 * **Consumers**: `renderArtifact(kind, contracts, options?, control?)`
 * dispatches across all registered adapters; fallback to kind.defaultRender
 * where the adapter doesn't implement the kind; ultimate fallback to
 * kind.empty when no contract contributes a part.
 *
 * ## Types
 *
 * `KnownArtifacts` / `KnownArtifactParts` / `KnownArtifactOptions` are
 * declared at the package root (`packages/sdk/src/index.ts`) so third-
 * party plugins can augment via `declare module "@glubean/sdk"`. This file
 * imports them as types from the root so declaration merging hits the
 * same node.
 */

import {
  getAdapter,
  listRegisteredProtocols,
} from "./contract-core.js";
import type {
  ExtractedContractProjection,
} from "./contract-types.js";
import {
  emptyOpenApiDocument,
  mergeOpenApiParts,
} from "./contract-http/openapi.js";
import type {
  OpenApiDocument,
  OpenApiOptions,
} from "./contract-http/openapi.js";

// =============================================================================
// ArtifactKind
// =============================================================================

/**
 * Declarative description of an artifact format.
 *
 * @template Final    Final merged value type (what consumers receive).
 * @template Part     Per-contract partial type (what producer / defaultRender
 *                    emit). Defaults to Final; distinct when per-contract
 *                    rendering is structured (e.g. markdown produces
 *                    `{ body, feature, caseCount }` parts and the merge
 *                    assembles a feature-grouped doc string).
 * @template Options  Per-render options type. Threaded through the entire
 *                    pipeline (producer / defaultRender / merge) so kinds
 *                    whose options affect per-contract rendering (e.g. proto
 *                    `package` per message) are as well-served as kinds whose
 *                    options only affect the final merge (e.g. openapi
 *                    `title`).
 */
export interface ArtifactKind<Final, Part = Final, Options = void> {
  /** Kind identifier (snake-case or kebab-case). Unique across the registry. */
  readonly name: string;

  /**
   * Combine per-contract parts into the final artifact. Called once per
   * render; receives the collected parts and the same options that were
   * passed to producers / defaultRender.
   */
  readonly merge: (parts: Part[], options?: Options) => Final;

  /**
   * Optional fallback: when an adapter has not declared a producer for this
   * kind, use this function to render a per-contract Part from the generic
   * `ExtractedContractProjection`. Omitted for kinds that only make sense
   * for specific protocols (e.g. openapi has no defaultRender — non-HTTP
   * contracts are skipped).
   */
  readonly defaultRender?: (
    projection: ExtractedContractProjection<unknown, unknown>,
    options?: Options,
  ) => Part;

  /**
   * Required: the value returned by `renderArtifact` when no contract
   * contributes a part. Must be a valid Final. Lets `renderArtifact` promise
   * `Final` (not `Final | undefined`) and forces kind authors to think
   * about the zero-contribution scenario explicitly.
   */
  readonly empty: Final;
}

// =============================================================================
// Kind registry
// =============================================================================

const _kinds = new Map<string, ArtifactKind<unknown, unknown, unknown>>();

/**
 * Register an artifact kind by name. Idempotent when re-registering the same
 * kind object; throws when a different object tries to take the same name
 * (protects against typo-level collisions across plugins).
 *
 * `defineArtifactKind` is the ergonomic entry; this is exported for advanced
 * scenarios where a kind is built separately from its registration.
 */
export function registerArtifactKind<Final, Part, Options>(
  kind: ArtifactKind<Final, Part, Options>,
): void {
  const existing = _kinds.get(kind.name);
  if (existing) {
    if (existing !== kind) {
      throw new Error(
        `Artifact kind "${kind.name}" already registered with a different instance. ` +
          `Ensure each kind is defined exactly once per process.`,
      );
    }
    return;
  }
  _kinds.set(kind.name, kind as ArtifactKind<unknown, unknown, unknown>);
}

/**
 * Look up a registered kind by name. Used by `renderArtifactByName` and any
 * other string-driven consumer (CLI --format, MCP tool inputs, etc.).
 */
export function getArtifactKind(
  name: string,
): ArtifactKind<unknown, unknown, unknown> | undefined {
  return _kinds.get(name);
}

/** List all registered kind names (insertion order). */
export function listArtifactKinds(): string[] {
  return [..._kinds.keys()];
}

/**
 * Define and register an artifact kind in one call. Preferred entry point
 * for kind authors (SDK built-ins + first-party plugins).
 */
export function defineArtifactKind<Final, Part = Final, Options = void>(
  spec: ArtifactKind<Final, Part, Options>,
): ArtifactKind<Final, Part, Options> {
  registerArtifactKind(spec);
  return spec;
}

/**
 * Test-only: clear the kind registry. Not exposed publicly; imported by
 * `contract-artifacts.test.ts` via relative path.
 *
 * @internal
 */
export function __resetArtifactKindsForTesting(): void {
  _kinds.clear();
}

// =============================================================================
// Render pipeline
// =============================================================================

/**
 * Control knobs for a single render invocation (orthogonal to kind-specific
 * options). Kept separate from `options` so adding new flags here doesn't
 * require each kind author to know about them.
 */
export interface RenderArtifactControl {
  /**
   * Skip each adapter's `artifacts[kind]` producer even when defined; force
   * all contracts through `kind.defaultRender`. For kinds without a
   * defaultRender, contracts are skipped entirely.
   *
   * Used by CLI `--generic` for reproducible output across installed
   * plugin versions, and by tests that assert default-render behavior.
   */
  preferDefaultRender?: boolean;
}

/**
 * Summary of a render invocation — per-contract classification of how each
 * contract contributed (or was skipped) + a `usedEmptyFallback` boolean.
 */
export interface ArtifactContribution {
  contractId: string;
  protocol: string;
  /** Whether the part came from the adapter's producer or kind.defaultRender. */
  source: "explicit-producer" | "default-render";
}

export interface ArtifactSkip {
  contractId: string;
  protocol: string;
  reason: "no-producer-no-default-render" | "prefer-default-render-no-default";
}

export interface ArtifactRenderSummary<Final> {
  /** Same value `renderArtifact` would have returned. */
  value: Final;
  /** Contracts that produced a part. */
  contributions: ArtifactContribution[];
  /** Contracts that did not produce a part (with reason). */
  skipped: ArtifactSkip[];
  /**
   * True iff `value === kind.empty` was returned because zero parts were
   * collected. False when `kind.merge(parts, options)` was called. Callers
   * should use this instead of comparing `value === kind.empty`
   * themselves — merge typically returns a fresh object for object-typed
   * Final, so identity / structural equality are not reliable.
   */
  usedEmptyFallback: boolean;
}

/**
 * Core render pipeline implementation — produces both a value and a
 * detailed summary. `renderArtifact` is a thin wrapper returning just the
 * value; `renderArtifactWithSummary` returns the full summary.
 *
 * Generic type `Final` / `Part` / `Options` instead of referring to the
 * kind's generics directly so runtime-typed callers (renderArtifactByName)
 * can pass `unknown`.
 */
function runRender<Final, Part, Options>(
  kind: ArtifactKind<Final, Part, Options>,
  contracts: ReadonlyArray<ExtractedContractProjection<unknown, unknown>>,
  options: Options | undefined,
  control: RenderArtifactControl | undefined,
): ArtifactRenderSummary<Final> {
  const parts: Part[] = [];
  const contributions: ArtifactContribution[] = [];
  const skipped: ArtifactSkip[] = [];

  for (const c of contracts) {
    const adapter = getAdapter(c.protocol);
    const explicitProducer =
      !control?.preferDefaultRender
        ? (adapter?.artifacts as
            | Record<
                string,
                (
                  p: ExtractedContractProjection<unknown, unknown>,
                  options?: Options,
                ) => Part
              >
            | undefined)?.[kind.name]
        : undefined;

    if (explicitProducer) {
      parts.push(explicitProducer(c, options));
      contributions.push({
        contractId: c.id,
        protocol: c.protocol,
        source: "explicit-producer",
      });
      continue;
    }

    if (kind.defaultRender) {
      parts.push(kind.defaultRender(c, options));
      contributions.push({
        contractId: c.id,
        protocol: c.protocol,
        source: "default-render",
      });
      continue;
    }

    skipped.push({
      contractId: c.id,
      protocol: c.protocol,
      reason: control?.preferDefaultRender
        ? "prefer-default-render-no-default"
        : "no-producer-no-default-render",
    });
  }

  if (parts.length === 0) {
    return {
      value: kind.empty,
      contributions,
      skipped,
      usedEmptyFallback: true,
    };
  }

  return {
    value: kind.merge(parts, options),
    contributions,
    skipped,
    usedEmptyFallback: false,
  };
}

/**
 * Render an artifact of the given kind from a list of contracts. Threads
 * `options` through the producer / defaultRender / merge pipeline. When no
 * contract contributes a part, returns `kind.empty` (guaranteed valid
 * `Final`).
 *
 * Strong-typed entry point: kind argument is a concrete `ArtifactKind<...>`
 * object, so `options` type and return type are inferred at compile time.
 */
export function renderArtifact<Final, Part, Options>(
  kind: ArtifactKind<Final, Part, Options>,
  contracts: ReadonlyArray<ExtractedContractProjection<unknown, unknown>>,
  options?: Options,
  control?: RenderArtifactControl,
): Final {
  return runRender(kind, contracts, options, control).value;
}

/**
 * Render an artifact and return the full summary (value + contributions +
 * skipped + usedEmptyFallback). Use this when you need to distinguish
 * "zero contribution" from "merged to kind.empty-shaped value" — the
 * `usedEmptyFallback` field is the authoritative signal (do not compare
 * `value === kind.empty` yourself for object-typed Final).
 */
export function renderArtifactWithSummary<Final, Part, Options>(
  kind: ArtifactKind<Final, Part, Options>,
  contracts: ReadonlyArray<ExtractedContractProjection<unknown, unknown>>,
  options?: Options,
  control?: RenderArtifactControl,
): ArtifactRenderSummary<Final> {
  return runRender(kind, contracts, options, control);
}

/**
 * Look up a kind by name and render. Used by string-driven consumers
 * (CLI --format <name>, MCP tools, agent introspection). Throws when the
 * name is not registered — the error message includes the list of
 * registered kinds so callers can surface it without extra lookups.
 *
 * Returns `unknown` since we don't know the Final type statically;
 * callers that need a typed return should use `renderArtifact` directly
 * with the kind object they import.
 */
export function renderArtifactByName(
  kindName: string,
  contracts: ReadonlyArray<ExtractedContractProjection<unknown, unknown>>,
  options?: unknown,
  control?: RenderArtifactControl,
): unknown {
  const kind = getArtifactKind(kindName);
  if (!kind) {
    const known = listArtifactKinds();
    const hint = known.length > 0 ? known.join(", ") : "(none)";
    throw new Error(
      `Unknown artifact kind "${kindName}". Registered kinds: ${hint}`,
    );
  }
  return renderArtifact(
    kind,
    contracts,
    options,
    control,
  );
}

// =============================================================================
// Introspection
// =============================================================================

/**
 * List the protocols whose adapter **explicitly declares a producer** for
 * the given kind. Does NOT include protocols that would fall back to
 * `kind.defaultRender`. Use `listArtifactCapability` for the three-way split.
 */
export function listArtifactProducers(kindName: string): string[] {
  return listRegisteredProtocols().filter((p) => {
    const adapter = getAdapter(p);
    return (
      adapter !== undefined &&
      (adapter.artifacts as Record<string, unknown> | undefined)?.[kindName] !==
        undefined
    );
  });
}

/**
 * Static capability view — **based on installed adapters**, not on any
 * particular project's contracts. Partitions protocols into:
 *
 *   - `explicit`    : adapter declares a producer for this kind
 *   - `fallback`    : adapter has no producer but kind.defaultRender exists
 *   - `unsupported` : adapter has no producer and kind has no defaultRender
 *
 * To answer "does **this project** produce the artifact?", use
 * `renderArtifactWithSummary` and inspect `contributions` + `usedEmptyFallback`.
 * The capability view cannot know how many contracts of each protocol exist
 * in the caller's project.
 */
export function listArtifactCapability(kindName: string): {
  explicit: string[];
  fallback: string[];
  unsupported: string[];
} {
  const kind = getArtifactKind(kindName);
  const allProtocols = listRegisteredProtocols();
  const explicit = listArtifactProducers(kindName);
  const explicitSet = new Set(explicit);
  const rest = allProtocols.filter((p) => !explicitSet.has(p));
  if (kind?.defaultRender) {
    return { explicit, fallback: rest, unsupported: [] };
  }
  return { explicit, fallback: [], unsupported: rest };
}

// =============================================================================
// Built-in kinds
// =============================================================================

/**
 * OpenAPI 3.1 artifact kind. Per-contract partials are produced by HTTP
 * adapter's `artifacts.openapi` (see `contract-http/openapi.ts`); merge
 * combines them into a full spec. No `defaultRender` — non-HTTP protocols
 * don't map to OpenAPI and are skipped.
 *
 * Ported from MCP's former `contractsToOpenApi` — CAR-1 Phase 2.
 */
export const openapiArtifact = defineArtifactKind<
  OpenApiDocument,
  OpenApiDocument,
  OpenApiOptions
>({
  name: "openapi",
  merge: (parts, options) => mergeOpenApiParts(parts, options),
  empty: emptyOpenApiDocument,
});

// ---------------------------------------------------------------------------
// Markdown artifact kind (CAR-1 Phase 3)
// ---------------------------------------------------------------------------

/**
 * Per-contract markdown rendering. Structured Part vs string Final lets
 * `markdownArtifact.merge` group by feature, compute doc-level summary,
 * and emit ordered sections — things a flat `parts.join("---")` cannot do.
 *
 * Adapters populate `body` (and can enrich with protocol-specific detail);
 * the other fields are read directly off the projection and passed through
 * for merge-time grouping.
 */
export interface MarkdownPart {
  /** Rendered per-contract markdown section body (without doc-level header). */
  body: string;
  contractId: string;
  protocol: string;
  /** Feature grouping key (falls back to "Uncategorized" at merge time). */
  feature?: string;
  /** Case count for doc-level summary. */
  caseCount: number;
}

/**
 * Kind-level fallback: protocol-agnostic per-contract markdown rendering.
 * Used when an adapter does not declare `artifacts.markdown`. Reads only
 * non-protocol-specific fields off the projection so it works for any
 * registered protocol.
 */
export function genericMarkdownPart(
  projection: ExtractedContractProjection<unknown, unknown>,
): MarkdownPart {
  const lines: string[] = [];
  const target = projection.target ?? projection.id;
  lines.push(`### ${projection.id} — ${target}`);
  if (projection.description) lines.push(`\n${projection.description}`);
  if (projection.deprecated) {
    lines.push(`\n**Deprecated:** ${projection.deprecated}`);
  }
  if (projection.cases.length === 0) {
    lines.push("\n_(no cases)_");
  } else {
    lines.push("\n**Cases:**\n");
    for (const c of projection.cases) {
      const marker =
        c.lifecycle === "deprecated"
          ? " ⚠ deprecated"
          : c.lifecycle === "deferred"
            ? " ⏸ deferred"
            : "";
      lines.push(`- \`${c.key}\`${marker} — ${c.description ?? ""}`);
      if (c.deprecatedReason) lines.push(`  - deprecated: ${c.deprecatedReason}`);
      if (c.deferredReason) lines.push(`  - deferred: ${c.deferredReason}`);
    }
  }
  return {
    body: lines.join("\n"),
    contractId: projection.id,
    protocol: projection.protocol,
    feature: projection.feature,
    caseCount: projection.cases.length,
  };
}

/**
 * Feature-grouped doc-level assembly. Groups parts by `feature` (falling
 * back to "Uncategorized"), emits a doc summary header + per-group
 * sections. This is what replaces CLI `formatMdOutline` — Phase 4 will
 * wire CLI through this path (zero-regression target).
 */
export function assembleMarkdownDocument(parts: MarkdownPart[]): string {
  if (parts.length === 0) return "";

  const groups = new Map<string, MarkdownPart[]>();
  for (const part of parts) {
    const key = part.feature ?? "Uncategorized";
    const list = groups.get(key) ?? [];
    list.push(part);
    groups.set(key, list);
  }

  const totalCases = parts.reduce((n, p) => n + p.caseCount, 0);
  const featureCount = groups.size;

  const lines: string[] = [];
  lines.push(
    `# Contracts (${parts.length} contract${parts.length === 1 ? "" : "s"}, ` +
      `${featureCount} feature${featureCount === 1 ? "" : "s"}, ` +
      `${totalCases} case${totalCases === 1 ? "" : "s"})`,
  );
  lines.push("");

  for (const [feature, featureParts] of groups.entries()) {
    lines.push(`## ${feature}`);
    lines.push("");
    for (const part of featureParts) {
      lines.push(part.body);
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

export const markdownArtifact = defineArtifactKind<string, MarkdownPart>({
  name: "markdown",
  defaultRender: (projection) => genericMarkdownPart(projection),
  merge: (parts) => assembleMarkdownDocument(parts),
  empty: "",
});
